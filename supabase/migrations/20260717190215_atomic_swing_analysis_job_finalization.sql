-- Phase 2B2B3B3A: atomic swing/job execution and finalization primitives.
--
-- The durable job claim (Phase 2B2B2) and the swing row's own status
-- (pending/PROCESSING/COMPLETE/ERROR) have so far been independent writes.
-- This migration ties them into a single atomic contract: claiming a job now
-- also drives the swing into PROCESSING in the same transaction, and the new
-- completion/failure transitions require the swing to already be in the
-- matching state before finalizing the job.
--
-- All three functions here are SECURITY INVOKER (never DEFINER) so they run
-- with the calling role's own privileges -- only service_role has
-- SELECT/UPDATE on swings and swing_analysis_jobs, so only service_role can
-- ever change either row through these functions. search_path is locked to
-- empty and every relation and ordinary function call is schema-qualified
-- (via pg_catalog for built-ins) so these functions cannot be tricked by a
-- hostile search_path.
--
-- Lock order is always the swing row first, then the job row -- matching
-- create_or_get_swing_analysis_job's existing lock order -- so this
-- migration cannot introduce a lock-order deadlock against that function.
--
-- Every terminal UPDATE against swing_analysis_jobs repeats its full
-- eligibility predicate (job id, swing id, derived user_id, and state/lease
-- guards) in the WHERE clause, not only in the earlier SELECT ... FOR UPDATE
-- -- defense in depth so the write itself can never silently apply to the
-- wrong row even if the preceding lock's predicate were ever weakened.
--
-- Cloud Tasks delivery is at-least-once, so callers must always treat a
-- zero-row result as a normal lost-claim/stale-state outcome, not an error.

-- --------------------------------------------------------------------------
-- claim_swing_analysis_job (replaced: now also drives the swing to
-- PROCESSING atomically with the job claim)
-- --------------------------------------------------------------------------

create or replace function public.claim_swing_analysis_job(
  p_job_id uuid,
  p_swing_id uuid,
  p_lease_seconds integer
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease_token uuid := pg_catalog.gen_random_uuid();
  v_swing public.swings%rowtype;
  v_job public.swing_analysis_jobs%rowtype;
  v_swing_status text;
  v_rows integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  -- Lock the swing row first, matching create_or_get_swing_analysis_job's
  -- existing lock order.
  select *
  into v_swing
  from public.swings
  where id = p_swing_id
  for update;

  if not found then
    return;
  end if;

  v_swing_status := pg_catalog.lower(pg_catalog.btrim(coalesce(v_swing.status, '')));
  if v_swing_status not in ('pending', 'error', 'processing') then
    return;
  end if;

  -- Lock the matching, currently-claimable job row. Ownership is derived
  -- from the already-locked swing row, never trusted from any input.
  select *
  into v_job
  from public.swing_analysis_jobs
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and (
      state = 'enqueue_pending'
      or state = 'queued'
      or (state = 'running' and (lease_expires_at is null or lease_expires_at < v_now))
    )
  for update;

  if not found then
    return;
  end if;

  update public.swings
  set status = 'PROCESSING'
  where id = p_swing_id
    and user_id = v_job.user_id;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'swing transition failed' using errcode = '40001';
  end if;

  -- The write itself repeats the full claim predicate (both ids, derived
  -- user_id, and the exact eligibility check just used to lock the row)
  -- rather than trusting the earlier SELECT ... FOR UPDATE alone.
  update public.swing_analysis_jobs
  set
    state = 'running',
    lease_token = v_lease_token,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
    execution_attempts = execution_attempts + 1,
    started_at = coalesce(started_at, v_now),
    enqueued_at = coalesce(enqueued_at, v_now),
    updated_at = v_now,
    error_code = null
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and (
      state = 'enqueue_pending'
      or state = 'queued'
      or (state = 'running' and (lease_expires_at is null or lease_expires_at < v_now))
    );

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'job transition failed' using errcode = '40001';
  end if;

  return query
    select * from public.swing_analysis_jobs
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'running';
end;
$$;

comment on function public.claim_swing_analysis_job(uuid, uuid, integer) is
  'Server-only (service_role). Atomically claims an eligible job (enqueue_pending, '
  'queued, or running with an expired/absent lease) for a swing whose own status is '
  'still pending/error/processing, matched by both job id and swing id with '
  'ownership derived from the locked swings row, issues a fresh lease_token, and '
  'drives the swing to canonical PROCESSING in the same transaction. The claiming '
  'UPDATE repeats the full eligibility predicate rather than relying solely on the '
  'earlier row lock. Cloud Tasks delivery is at-least-once, so a zero-row result is '
  'a normal lost-claim outcome, not an error.';

revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from public;
revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from anon;
revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from authenticated;
grant execute on function public.claim_swing_analysis_job(uuid, uuid, integer) to service_role;

-- --------------------------------------------------------------------------
-- complete_swing_analysis_job
-- --------------------------------------------------------------------------

create function public.complete_swing_analysis_job(
  p_job_id uuid,
  p_swing_id uuid,
  p_lease_token uuid,
  p_telemetry_data jsonb
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_swing public.swings%rowtype;
  v_job public.swing_analysis_jobs%rowtype;
  v_rows integer;
begin
  if p_telemetry_data is null or pg_catalog.jsonb_typeof(p_telemetry_data) <> 'object' then
    raise exception 'invalid telemetry data' using errcode = '22023';
  end if;

  -- Lock the swing row first, matching the lock order used throughout this
  -- job's lifecycle.
  select *
  into v_swing
  from public.swings
  where id = p_swing_id
  for update;

  if not found then
    return;
  end if;

  if v_swing.status <> 'PROCESSING' then
    return;
  end if;

  -- Lock the matching, lease-owned running job row. Ownership is derived
  -- from the already-locked swing row, never trusted from any input.
  select *
  into v_job
  from public.swing_analysis_jobs
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and state = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    return;
  end if;

  -- The write itself repeats the derived ownership guard and re-asserts the
  -- swing is still PROCESSING, rather than trusting the earlier lock alone.
  update public.swings
  set status = 'COMPLETE', telemetry_data = p_telemetry_data
  where id = p_swing_id
    and user_id = v_job.user_id
    and status = 'PROCESSING';

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'swing transition failed' using errcode = '40001';
  end if;

  -- The write itself repeats the full guard (both ids, derived user_id,
  -- running state, and the exact lease token) rather than trusting the
  -- earlier SELECT ... FOR UPDATE alone.
  update public.swing_analysis_jobs
  set
    state = 'succeeded',
    finished_at = v_now,
    updated_at = v_now,
    lease_token = null,
    lease_expires_at = null,
    error_code = null
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and state = 'running'
    and lease_token = p_lease_token;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'job transition failed' using errcode = '40001';
  end if;

  return query
    select * from public.swing_analysis_jobs
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'succeeded';
end;
$$;

comment on function public.complete_swing_analysis_job(uuid, uuid, uuid, jsonb) is
  'Server-only (service_role). Atomic terminal success transition: requires the '
  'swing to still be canonical PROCESSING and the job to still be running with '
  'the exact lease_token that claimed it, matched by job id, swing id, and '
  'ownership derived from the locked swings row. Writes the swing to canonical '
  'COMPLETE with the supplied telemetry_data and the job to succeeded, clearing '
  'the lease, in the same transaction -- both writes repeat the full guard '
  'predicate rather than relying solely on the earlier row locks. A stale token, '
  'lost lease, or swing not in PROCESSING returns zero rows and changes nothing.';

revoke execute on function public.complete_swing_analysis_job(uuid, uuid, uuid, jsonb) from public;
revoke execute on function public.complete_swing_analysis_job(uuid, uuid, uuid, jsonb) from anon;
revoke execute on function public.complete_swing_analysis_job(uuid, uuid, uuid, jsonb) from authenticated;
grant execute on function public.complete_swing_analysis_job(uuid, uuid, uuid, jsonb) to service_role;

-- --------------------------------------------------------------------------
-- fail_swing_analysis_job (replaced: now also drives the swing to ERROR
-- atomically with the job failure, without overwriting a COMPLETE swing)
-- --------------------------------------------------------------------------

create or replace function public.fail_swing_analysis_job(
  p_job_id uuid,
  p_swing_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_swing public.swings%rowtype;
  v_job public.swing_analysis_jobs%rowtype;
  v_rows integer;
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid error code' using errcode = '22023';
  end if;

  -- Lock the swing row first, matching the lock order used throughout this
  -- job's lifecycle.
  select *
  into v_swing
  from public.swings
  where id = p_swing_id
  for update;

  if not found then
    return;
  end if;

  if v_swing.status <> 'PROCESSING' and v_swing.status <> 'ERROR' then
    return;
  end if;

  -- Lock the matching, lease-owned running job row. Ownership is derived
  -- from the already-locked swing row, never trusted from any input.
  select *
  into v_job
  from public.swing_analysis_jobs
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and state = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    return;
  end if;

  if v_swing.status = 'PROCESSING' then
    -- The write itself repeats the derived ownership guard and re-asserts
    -- PROCESSING, rather than trusting the earlier lock alone. A swing that
    -- is already ERROR is left untouched here -- never overwritten and
    -- never re-derived from COMPLETE.
    update public.swings
    set status = 'ERROR'
    where id = p_swing_id
      and user_id = v_job.user_id
      and status = 'PROCESSING';

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'swing transition failed' using errcode = '40001';
    end if;
  end if;

  -- The write itself repeats the full guard (both ids, derived user_id,
  -- running state, and the exact lease token) rather than trusting the
  -- earlier SELECT ... FOR UPDATE alone.
  update public.swing_analysis_jobs
  set
    state = 'failed',
    error_code = p_error_code,
    finished_at = v_now,
    updated_at = v_now,
    lease_token = null,
    lease_expires_at = null
  where id = p_job_id
    and swing_id = p_swing_id
    and user_id = v_swing.user_id
    and state = 'running'
    and lease_token = p_lease_token;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'job transition failed' using errcode = '40001';
  end if;

  return query
    select * from public.swing_analysis_jobs
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'failed';
end;
$$;

comment on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) is
  'Server-only (service_role). Atomic terminal failure transition: requires the '
  'job to still be running with the exact lease_token that claimed it and the '
  'swing to be canonical PROCESSING or already ERROR, matched by job id, swing '
  'id, and ownership derived from the locked swings row. Drives a PROCESSING '
  'swing to canonical ERROR (an already-ERROR swing is left as-is and its '
  'telemetry_data is never cleared) and the job to failed with a sanitized '
  'machine error_code, clearing the lease, in the same transaction -- both writes '
  'repeat the full guard predicate rather than relying solely on the earlier row '
  'locks. A COMPLETE swing, stale token, or lost lease returns zero rows and '
  'changes nothing.';

revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from public;
revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from anon;
revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) to service_role;
