-- Phase 2B2B3A: durable job creation and Cloud Tasks enqueue orchestration
-- for swing_analysis_jobs.
--
-- All four functions here are SECURITY INVOKER (never DEFINER) so they run
-- with the calling role's own privileges -- only service_role has
-- SELECT/INSERT/UPDATE on this table, so only service_role can ever create
-- or transition a job through these functions. search_path is locked to
-- empty and every relation is schema-qualified so these functions cannot be
-- tricked by a hostile search_path.
--
-- create_or_get_swing_analysis_job never trusts a client- or task-payload-
-- supplied user id for the job's own user_id column: p_expected_user_id is
-- used only as an ownership guard against the locked public.swings row, and
-- the stored user_id is always the swing row's own user_id.
--
-- Cloud Tasks delivery is at-least-once, so callers must always treat a
-- zero-row result from the transition functions as a normal
-- lost-race/stale-state outcome, not an error.

-- --------------------------------------------------------------------------
-- create_or_get_swing_analysis_job
-- --------------------------------------------------------------------------

create function public.create_or_get_swing_analysis_job(
  p_swing_id uuid,
  p_expected_user_id text,
  p_storage_path text,
  p_equipment_context jsonb,
  p_slope double precision
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_swing public.swings%rowtype;
  v_existing_job_id uuid;
  v_status text;
  v_remainder text;
  v_new_job_id uuid;
begin
  if p_expected_user_id is null or length(p_expected_user_id) = 0 then
    raise exception 'invalid expected user id' using errcode = '22023';
  end if;

  if p_storage_path is null or length(p_storage_path) = 0 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;
  if char_length(p_storage_path) > 512 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;
  if left(p_storage_path, 1) = '/' then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;
  if position(chr(92) in p_storage_path) > 0 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;
  -- No explicit null-byte check: Postgres text values can never contain a
  -- NUL byte (chr(0) itself raises "null character not permitted"), so the
  -- wire protocol already rejects such a parameter before this function
  -- runs -- there is nothing left here to reject at runtime.
  if position('//' in p_storage_path) > 0 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;
  if p_storage_path like '%/./%'
    or p_storage_path like '%/../%'
    or p_storage_path like './%'
    or p_storage_path like '../%'
    or p_storage_path like '%/.'
    or p_storage_path like '%/..'
  then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;

  if p_equipment_context is not null and jsonb_typeof(p_equipment_context) <> 'object' then
    raise exception 'invalid equipment context' using errcode = '22023';
  end if;

  if p_slope is not null
    and (
      p_slope = 'NaN'::double precision
      or p_slope = 'Infinity'::double precision
      or p_slope = '-Infinity'::double precision
    )
  then
    raise exception 'invalid slope' using errcode = '22023';
  end if;

  -- Lock the matched swing row so concurrent create calls for the same
  -- swing serialize on this row lock, not on the unique index below.
  select *
  into v_swing
  from public.swings
  where id = p_swing_id
    and user_id = p_expected_user_id
  for update;

  if not found then
    return;
  end if;

  if left(p_storage_path, length(v_swing.user_id) + 1) <> v_swing.user_id || '/' then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;

  v_remainder := substring(p_storage_path from length(v_swing.user_id) + 2);
  if v_remainder is null or length(v_remainder) = 0 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;

  -- An active job already covers this swing: return it unchanged rather
  -- than starting a second concurrent attempt.
  select id
  into v_existing_job_id
  from public.swing_analysis_jobs
  where swing_id = p_swing_id
    and state in ('enqueue_pending', 'queued', 'running')
  limit 1;

  if found then
    return query
      select * from public.swing_analysis_jobs where id = v_existing_job_id;
    return;
  end if;

  v_status := lower(trim(coalesce(v_swing.status, '')));
  if v_status <> 'pending' and v_status <> 'error' then
    return;
  end if;

  begin
    insert into public.swing_analysis_jobs (
      swing_id,
      user_id,
      state,
      storage_path,
      equipment_context,
      slope
    )
    values (
      p_swing_id,
      v_swing.user_id,
      'enqueue_pending',
      p_storage_path,
      p_equipment_context,
      p_slope
    )
    returning id into v_new_job_id;
  exception
    when unique_violation then
      -- Defense in depth against swing_analysis_jobs_one_active_per_swing_idx:
      -- re-read and return the active job instead of surfacing the raw
      -- constraint error.
      select id
      into v_new_job_id
      from public.swing_analysis_jobs
      where swing_id = p_swing_id
        and state in ('enqueue_pending', 'queued', 'running')
      limit 1;

      if v_new_job_id is null then
        raise exception 'job creation failed' using errcode = '40001';
      end if;
  end;

  return query
    select * from public.swing_analysis_jobs where id = v_new_job_id;
end;
$$;

comment on function public.create_or_get_swing_analysis_job(uuid, text, text, jsonb, double precision) is
  'Server-only (service_role). Atomically creates a new enqueue_pending job for '
  'an owned, claimable swing, or returns an existing active job unchanged. '
  'p_expected_user_id is an ownership guard only -- the stored job.user_id is '
  'always derived from the locked public.swings row, never from this parameter '
  'or any client/task-payload input.';

revoke execute on function public.create_or_get_swing_analysis_job(uuid, text, text, jsonb, double precision) from public;
revoke execute on function public.create_or_get_swing_analysis_job(uuid, text, text, jsonb, double precision) from anon;
revoke execute on function public.create_or_get_swing_analysis_job(uuid, text, text, jsonb, double precision) from authenticated;
grant execute on function public.create_or_get_swing_analysis_job(uuid, text, text, jsonb, double precision) to service_role;

-- --------------------------------------------------------------------------
-- begin_swing_analysis_job_enqueue
-- --------------------------------------------------------------------------

create function public.begin_swing_analysis_job_enqueue(
  p_job_id uuid,
  p_swing_id uuid,
  p_task_name text
)
returns setof public.swing_analysis_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_task_name is null or length(p_task_name) = 0 then
    raise exception 'invalid task name' using errcode = '22023';
  end if;
  if char_length(p_task_name) > 1024 then
    raise exception 'invalid task name' using errcode = '22023';
  end if;
  if p_task_name ~ '[\x00-\x1f\x7f]' then
    raise exception 'invalid task name' using errcode = '22023';
  end if;

  return query
    update public.swing_analysis_jobs
    set
      task_name = p_task_name,
      enqueue_attempts = enqueue_attempts + 1,
      updated_at = v_now,
      error_code = null
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'enqueue_pending'
      and (task_name is null or task_name = p_task_name)
    returning *;
end;
$$;

comment on function public.begin_swing_analysis_job_enqueue(uuid, uuid, text) is
  'Server-only (service_role). Records the start of a Cloud Tasks enqueue '
  'attempt: sets/confirms task_name and increments enqueue_attempts exactly '
  'once. Matched by job id, swing id, and state=enqueue_pending. Zero rows is '
  'a normal outcome for a stale request, not an error.';

revoke execute on function public.begin_swing_analysis_job_enqueue(uuid, uuid, text) from public;
revoke execute on function public.begin_swing_analysis_job_enqueue(uuid, uuid, text) from anon;
revoke execute on function public.begin_swing_analysis_job_enqueue(uuid, uuid, text) from authenticated;
grant execute on function public.begin_swing_analysis_job_enqueue(uuid, uuid, text) to service_role;

-- --------------------------------------------------------------------------
-- mark_swing_analysis_job_queued
-- --------------------------------------------------------------------------

create function public.mark_swing_analysis_job_queued(
  p_job_id uuid,
  p_swing_id uuid,
  p_task_name text
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
      state = 'queued',
      enqueued_at = coalesce(enqueued_at, v_now),
      updated_at = v_now,
      error_code = null
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'enqueue_pending'
      and task_name = p_task_name
    returning *;
end;
$$;

comment on function public.mark_swing_analysis_job_queued(uuid, uuid, text) is
  'Server-only (service_role). Terminal enqueue-success transition: marks the '
  'job queued only when Cloud Tasks has confirmed task creation or reported '
  'ALREADY_EXISTS for the exact task_name. Matched by job id, swing id, '
  'state=enqueue_pending, and exact task_name. Never changes enqueue_attempts.';

revoke execute on function public.mark_swing_analysis_job_queued(uuid, uuid, text) from public;
revoke execute on function public.mark_swing_analysis_job_queued(uuid, uuid, text) from anon;
revoke execute on function public.mark_swing_analysis_job_queued(uuid, uuid, text) from authenticated;
grant execute on function public.mark_swing_analysis_job_queued(uuid, uuid, text) to service_role;

-- --------------------------------------------------------------------------
-- record_swing_analysis_job_enqueue_failure
-- --------------------------------------------------------------------------

create function public.record_swing_analysis_job_enqueue_failure(
  p_job_id uuid,
  p_swing_id uuid,
  p_task_name text,
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
      error_code = p_error_code,
      updated_at = v_now
    where id = p_job_id
      and swing_id = p_swing_id
      and state = 'enqueue_pending'
      and task_name = p_task_name
    returning *;
end;
$$;

comment on function public.record_swing_analysis_job_enqueue_failure(uuid, uuid, text, text) is
  'Server-only (service_role). Records a failed Cloud Tasks enqueue attempt '
  'with a sanitized machine error_code, leaving the job in enqueue_pending so '
  'it can be retried. Matched by job id, swing id, state=enqueue_pending, and '
  'exact task_name. Never increments enqueue_attempts (begin_swing_analysis_job_enqueue '
  'already did) and never clears task_name.';

revoke execute on function public.record_swing_analysis_job_enqueue_failure(uuid, uuid, text, text) from public;
revoke execute on function public.record_swing_analysis_job_enqueue_failure(uuid, uuid, text, text) from anon;
revoke execute on function public.record_swing_analysis_job_enqueue_failure(uuid, uuid, text, text) from authenticated;
grant execute on function public.record_swing_analysis_job_enqueue_failure(uuid, uuid, text, text) to service_role;

-- --------------------------------------------------------------------------
-- task_name format constraint
-- --------------------------------------------------------------------------

alter table public.swing_analysis_jobs
  add constraint swing_analysis_jobs_task_name_format_check
  check (
    task_name is null
    or (
      char_length(task_name) between 1 and 1024
      and task_name !~ '[\x00-\x1f\x7f]'
    )
  );
