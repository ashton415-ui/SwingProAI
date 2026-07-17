-- Phase 2B2B1: durable analysis-job persistence for swing video processing.
--
-- This table is server-only. No client (anon/authenticated) access is granted.
-- Transactional claim/lease RPC functions are deferred to Phase 2B2B2.

create table public.swing_analysis_jobs (
  id uuid primary key default gen_random_uuid(),

  swing_id uuid not null
    references public.swings(id)
    on delete cascade,

  user_id text not null,

  state text not null
    default 'enqueue_pending',

  task_name text null,

  storage_path text not null,

  equipment_context jsonb null,

  slope double precision null,

  enqueue_attempts integer not null default 0,
  execution_attempts integer not null default 0,

  lease_token uuid null,
  lease_expires_at timestamptz null,

  error_code text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  enqueued_at timestamptz null,
  started_at timestamptz null,
  finished_at timestamptz null,

  constraint swing_analysis_jobs_state_check
    check (state in (
      'enqueue_pending',
      'queued',
      'running',
      'succeeded',
      'failed',
      'superseded'
    )),

  constraint swing_analysis_jobs_enqueue_attempts_check
    check (enqueue_attempts >= 0),

  constraint swing_analysis_jobs_execution_attempts_check
    check (execution_attempts >= 0),

  constraint swing_analysis_jobs_storage_path_prefix_check
    check (starts_with(storage_path, user_id || '/')),

  constraint swing_analysis_jobs_storage_path_length_check
    check (char_length(storage_path) between 3 and 512),

  constraint swing_analysis_jobs_storage_path_has_object_check
    check (
      char_length(storage_path) > char_length(user_id) + 1
      and right(storage_path, 1) <> '/'
    ),

  constraint swing_analysis_jobs_equipment_context_is_object_check
    check (equipment_context is null or jsonb_typeof(equipment_context) = 'object')
);

-- Only one enqueue_pending/queued/running job may exist per swing at a time,
-- so retries and re-enqueues cannot race and produce duplicate active work.
create unique index swing_analysis_jobs_one_active_per_swing_idx
  on public.swing_analysis_jobs (swing_id)
  where state in ('enqueue_pending', 'queued', 'running');

-- Cloud Tasks task names must be globally unique per queue; this prevents
-- two job rows from ever claiming the same task_name.
create unique index swing_analysis_jobs_task_name_unique_idx
  on public.swing_analysis_jobs (task_name)
  where task_name is not null;

-- Supports scanning for jobs whose lease has expired and need reconciliation.
create index swing_analysis_jobs_state_lease_expires_at_idx
  on public.swing_analysis_jobs (state, lease_expires_at);

-- Supports fetching a swing's job history in reverse-chronological order.
create index swing_analysis_jobs_swing_id_created_at_idx
  on public.swing_analysis_jobs (swing_id, created_at desc);

comment on table public.swing_analysis_jobs is
  'Durable record of each swing analysis attempt (enqueue through completion). '
  'Cloud Tasks delivery is at least once, so this table -- not the queue -- is '
  'the source of truth for whether/how a job has progressed. Server-only: '
  'access only via service_role clients (worker, API routes using the service key). '
  'No client (anon/authenticated) access is granted.';

comment on column public.swing_analysis_jobs.user_id is
  'Owning user for this job. Future server-side job creation must derive this '
  'value from public.swings (the swing row''s own user_id), never trust a '
  'user_id supplied by a client request or a Cloud Tasks payload.';

comment on column public.swing_analysis_jobs.task_name is
  'Cloud Tasks task name for this attempt. Task payloads must contain only the '
  'job id and swing id -- never the storage_path or other job data -- so the '
  'worker always re-reads current state from this table before acting.';

comment on column public.swing_analysis_jobs.storage_path is
  'Durable Supabase Storage object path for the source video. Must remain a '
  'stable path, not a signed/expiring URL, since retries and delayed Cloud '
  'Tasks delivery may read it long after enqueue time.';

comment on column public.swing_analysis_jobs.lease_token is
  'Opaque token issued when a worker claims this job. Used together with '
  'lease_expires_at to prevent two workers from concurrently executing the '
  'same attempt when Cloud Tasks redelivers a task.';

alter table public.swing_analysis_jobs enable row level security;

-- Deliberately no RLS policies: this table is server-only and is accessed
-- exclusively through service_role, which bypasses RLS. No policy is created
-- for anon or authenticated.

revoke all on public.swing_analysis_jobs from public;
revoke all on public.swing_analysis_jobs from anon;
revoke all on public.swing_analysis_jobs from authenticated;

grant select, insert, update, delete on public.swing_analysis_jobs to service_role;
-- No sequence grant is required: id uses gen_random_uuid(), not a serial/identity
-- column, so no owned sequence object exists for this table.
