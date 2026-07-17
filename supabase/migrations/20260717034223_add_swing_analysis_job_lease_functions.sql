-- Phase 2B2B2: atomic, server-only lease operations for swing_analysis_jobs.
--
-- All four functions here are SECURITY INVOKER (never DEFINER) so they run
-- with the calling role's own privileges -- only service_role has UPDATE on
-- this table, so only service_role can ever change job state through these
-- functions. search_path is locked to empty and every relation is schema-
-- qualified so these functions cannot be tricked by a hostile search_path.
--
-- Every function performs exactly one UPDATE ... WHERE ... RETURNING guarded
-- by both job id and swing id (plus lease_token for the transitions that
-- require an active lease), using a single captured timestamp for the whole
-- invocation. Cloud Tasks delivery is at-least-once, so callers must always
-- treat a zero-row result as a normal lost-claim/stale-token outcome, not an
-- error.

-- error_code is worker-authored (never client input), but this constraint
-- keeps it restricted to a small machine-readable charset regardless of
-- caller, matching the validation enforced in fail_swing_analysis_job below.
alter table public.swing_analysis_jobs
  add constraint swing_analysis_jobs_error_code_format_check
  check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$');

-- --------------------------------------------------------------------------
-- claim_swing_analysis_job
-- --------------------------------------------------------------------------

create function public.claim_swing_analysis_job(
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
  v_now timestamptz := clock_timestamp();
  v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  return query
    update public.swing_analysis_jobs
    set
      state = 'running',
      lease_token = v_lease_token,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      execution_attempts = execution_attempts + 1,
      started_at = coalesce(started_at, v_now),
      enqueued_at = coalesce(enqueued_at, v_now),
      updated_at = v_now,
      error_code = null
    where id = p_job_id
      and swing_id = p_swing_id
      and (
        state = 'enqueue_pending'
        or state = 'queued'
        or (state = 'running' and (lease_expires_at is null or lease_expires_at < v_now))
      )
    returning *;
end;
$$;

comment on function public.claim_swing_analysis_job(uuid, uuid, integer) is
  'Server-only (service_role). Atomically claims an eligible job (enqueue_pending, '
  'queued, or running with an expired/absent lease), matched by both job id and '
  'swing id, and issues a fresh lease_token. Cloud Tasks delivery is at-least-once, '
  'so a zero-row result is a normal lost-claim outcome, not an error.';

revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from public;
revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from anon;
revoke execute on function public.claim_swing_analysis_job(uuid, uuid, integer) from authenticated;
grant execute on function public.claim_swing_analysis_job(uuid, uuid, integer) to service_role;

-- --------------------------------------------------------------------------
-- renew_swing_analysis_job_lease
-- --------------------------------------------------------------------------

create function public.renew_swing_analysis_job_lease(
  p_job_id uuid,
  p_swing_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  return query
    update public.swing_analysis_jobs
    set
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'running'
      and lease_token = p_lease_token
      and lease_expires_at is not null
      and lease_expires_at >= v_now
    returning *;
end;
$$;

comment on function public.renew_swing_analysis_job_lease(uuid, uuid, uuid, integer) is
  'Server-only (service_role). Extends an active, unexpired lease held by the exact '
  'lease_token presented, matched by job id, swing id, and running state. Never '
  'increments execution_attempts. A wrong/expired token or job in another state '
  'returns zero rows rather than an error.';

revoke execute on function public.renew_swing_analysis_job_lease(uuid, uuid, uuid, integer) from public;
revoke execute on function public.renew_swing_analysis_job_lease(uuid, uuid, uuid, integer) from anon;
revoke execute on function public.renew_swing_analysis_job_lease(uuid, uuid, uuid, integer) from authenticated;
grant execute on function public.renew_swing_analysis_job_lease(uuid, uuid, uuid, integer) to service_role;

-- --------------------------------------------------------------------------
-- succeed_swing_analysis_job
-- --------------------------------------------------------------------------

create function public.succeed_swing_analysis_job(
  p_job_id uuid,
  p_swing_id uuid,
  p_lease_token uuid
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
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
      and state = 'running'
      and lease_token = p_lease_token
    returning *;
end;
$$;

comment on function public.succeed_swing_analysis_job(uuid, uuid, uuid) is
  'Server-only (service_role). Terminal success transition, guarded by job id, '
  'swing id, running state, and the exact lease_token that claimed the job. A '
  'stale or wrong token updates zero rows rather than overwriting a result that '
  'another attempt already finalized.';

revoke execute on function public.succeed_swing_analysis_job(uuid, uuid, uuid) from public;
revoke execute on function public.succeed_swing_analysis_job(uuid, uuid, uuid) from anon;
revoke execute on function public.succeed_swing_analysis_job(uuid, uuid, uuid) from authenticated;
grant execute on function public.succeed_swing_analysis_job(uuid, uuid, uuid) to service_role;

-- --------------------------------------------------------------------------
-- fail_swing_analysis_job
-- --------------------------------------------------------------------------

create function public.fail_swing_analysis_job(
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
  v_now timestamptz := clock_timestamp();
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'invalid error code' using errcode = '22023';
  end if;

  return query
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
      and state = 'running'
      and lease_token = p_lease_token
    returning *;
end;
$$;

comment on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) is
  'Server-only (service_role). Terminal failure transition, guarded by job id, '
  'swing id, running state, and the exact lease_token that claimed the job, with '
  'a sanitized machine error_code. A stale or wrong token updates zero rows '
  'rather than overwriting a result that another attempt already finalized.';

revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from public;
revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from anon;
revoke execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.fail_swing_analysis_job(uuid, uuid, uuid, text) to service_role;
