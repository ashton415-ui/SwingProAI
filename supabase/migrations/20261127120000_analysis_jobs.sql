-- ============================================================================
-- AG-WEB-READY-10-P2 (M1) — durable full-swing analysis admission and jobs
-- ============================================================================
--
-- Design: AG-WEB-READY-10-P1 ADR v3.4 (sha256 9701796823d064723cb63c6dd4af2169a7def3538494a5cd46d5d473bd7812db)
-- with the five corrections of the P2 work order. Additive. No existing row,
-- column, policy or function is changed; one trigger is added to
-- public.swing_analysis and is inert until a job exists.
--
-- What this adds
-- --------------
--   roles      analysis_jobs_owner  NOLOGIN, owns every object below except
--                                    reconcile_analysis_job; outside the
--                                    ENT-1D guard's override allow-list
--              analysis_worker      NOLOGIN; may execute only the worker
--                                    functions
--   tables     analysis_jobs              one row per accepted attempt
--              analysis_admission_control exactly one row (switches, mode, limits)
--              analysis_spend_ledger      one row per job; no foreign keys, so
--                                         it survives job and account deletion
--   functions  admit_analysis_job (service_role), read_analysis_job_state(s)
--              (authenticated), the worker functions (analysis_worker),
--              reconcile_analysis_job (postgres only, SECURITY INVOKER)
--   triggers   swing_analysis_job_claim_guard (BEFORE UPDATE on swing_analysis)
--              analysis_jobs_ledger_on_delete (BEFORE DELETE on analysis_jobs)
--
-- Default state: full swing stays synchronous ('sync'), admissions and dispatch
-- are off, provider_mode is 'none', and queued admission of a legacy failed row
-- (no job ever) is disabled. No build changes behaviour until an operator
-- changes the control row.
--
-- P2 corrections implemented here
-- -------------------------------
--   C1 typed dispatch result: mark_job_dispatched returns a reason
--      (dispatched | policy_hold | ineligible | fenced) together with the job,
--      claim and generation it is about.
--   C2 slot retention: a dispatched attempt keeps its dispatch slot until a known
--      terminal outcome or an explicit reconciliation. The slot is read from the
--      surviving ledger (state dispatched or held), never from the lease age.
--      An expired, undispatched claim is recoverable.
--   C3 spend survives deletion: the dispatch mark records dispatched_at and the
--      reserved units on the ledger in the same transaction; rolling limits are
--      enforced from the ledger. Deleting a job or an account cannot free spent
--      or held capacity (the delete trigger turns dispatched into held). A held
--      row whose job is gone is settled only by the worker's late terminal
--      report (fenced by the claim recorded on the ledger) or by reconcile.
--   C4 one precedence rule (section "Admission decision" below), mirrored by
--      lib/analysis-attempt-precedence.ts and asserted by the tests.
--
-- Limits (synthetic units in tests; numbers are owner decisions)
-- ------------------------------------------------------------------
--   usage for admission = outstanding reservations (state reserved, any age)
--                       + units dispatched within the last 24 h (dispatched,
--                         held or charged)
--   usage for dispatch  = units dispatched within the last 24 h
--   A null limit is unlimited and is accepted only while provider_mode <> 'real'.
--
-- Rollback: set admissions_enabled and dispatch_enabled false (jobs and claims
-- are kept). Dropping the trigger or tables is a separate reviewed migration,
-- only after the tables are empty or archived. Never run operator sessions with
-- session_replication_role = replica (it would skip the delete trigger).
--
-- This migration contains no transaction control; the runner owns the
-- transaction.

set local lock_timeout = '3s';
set local createrole_self_grant = '';

do $lock_timeout$
begin
  if pg_catalog.current_setting('lock_timeout') <> '3s' then
    raise exception 'AJ-LOCK-TIMEOUT: lock_timeout is %, expected 3s; apply this file inside one transaction.',
      pg_catalog.current_setting('lock_timeout');
  end if;
end;
$lock_timeout$;

-- ── Preflight ───────────────────────────────────────────────────────────────
do $preflight$
declare
  v_fn oid := pg_catalog.to_regprocedure('public.ent1d_swing_analysis_execution_guard()');
begin
  if v_fn is null or pg_catalog.strpos((select prosrc from pg_catalog.pg_proc where oid = v_fn), 'ENT1D-EXECUTION-GUARD-MODE: enforce') = 0
     or not exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.swing_analysis'::regclass
                     and tgname = 'swing_analysis_execution_guard' and tgfoid = v_fn and tgenabled = 'O') then
    raise exception 'AJ-PRE-1: the ENT-1D execution claim guard (20261027120000) is not enforcing.';
  end if;
  if pg_catalog.to_regprocedure('public.ent1d_is_canonical_swing_video_key(text, uuid)') is null then
    raise exception 'AJ-PRE-2: the ENT-1D canonical video key function (20261027120100) is missing.';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname in ('analysis_jobs_owner', 'analysis_worker'))
     or pg_catalog.to_regclass('public.analysis_jobs') is not null
     or pg_catalog.to_regclass('public.analysis_admission_control') is not null
     or pg_catalog.to_regclass('public.analysis_spend_ledger') is not null then
    raise exception 'AJ-PRE-3: analysis job roles or tables already exist.';
  end if;
  if current_user <> 'postgres' then
    raise exception 'AJ-PRE-4: apply as postgres (current_user is %).', current_user;
  end if;
  if (select count(*) from pg_catalog.pg_attribute where attrelid = 'public.swing_analysis'::regclass and not attisdropped
        and attname in ('processing_claim_id','processing_started_at','processing_heartbeat_at','provider_dispatched_at',
                        'processing_claim_proof','score','feedback','spine_angle','hip_rotation','shoulder_rotation',
                        'tempo_ratio','metrics','swing_highlights','mechanical_deficiencies','swing_video_id','user_id',
                        'status','analysis_family')) <> 18 then
    raise exception 'AJ-PRE-5: public.swing_analysis does not have the expected columns.';
  end if;
end;
$preflight$;

-- ── Roles ───────────────────────────────────────────────────────────────────
-- BYPASSRLS can be granted only by a role that holds it. Where postgres does
-- not, the policy branch (below) gives the owner explicit RLS policies instead.
do $roles$
begin
  if (select rolbypassrls from pg_catalog.pg_roles where rolname = current_user) then
    create role analysis_jobs_owner nologin nosuperuser nocreaterole nocreatedb noinherit noreplication bypassrls;
  else
    create role analysis_jobs_owner nologin nosuperuser nocreaterole nocreatedb noinherit noreplication nobypassrls;
  end if;
  create role analysis_worker nologin nosuperuser nocreaterole nocreatedb noinherit noreplication nobypassrls;
end;
$roles$;

-- ── Tables ──────────────────────────────────────────────────────────────────

-- Typed, key-limited client estimates. Each angle key is a number in
-- [-360, 360]; tempoRatio is a string N:1 / N.N:1 (route.ts clientAngle /
-- clientTempoRatio; lib/analysis-metrics-validation.ts).
create function public.analysis_metrics_values_ok(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(pg_catalog.bool_and(case
           when e.key = 'tempoRatio' then pg_catalog.jsonb_typeof(e.value) = 'string'
                                       and (e.value #>> '{}') ~ '^\d{1,2}(\.\d{1,2})?:1$'
           else pg_catalog.jsonb_typeof(e.value) = 'number'
                and (e.value #>> '{}')::numeric between -360 and 360
         end), true)
    from pg_catalog.jsonb_each(p) e
$fn$;

create table public.analysis_jobs (
  id                     uuid primary key default pg_catalog.gen_random_uuid(),
  analysis_id            uuid not null references public.swing_analysis(id) on delete cascade,
  user_id                uuid not null references public.users(id) on delete cascade,
  video_id               uuid not null references public.swing_videos(id) on delete cascade,
  family                 text not null check (family in ('full_swing')),
  generation             integer not null check (generation >= 1),
  retry_of_job_id        uuid null references public.analysis_jobs(id),
  state                  text not null default 'queued' check (state in (
                           'queued','claimed','dispatched','outcome_unknown',
                           'succeeded','failed_definite','reconciled','cancelled_ineligible','superseded')),
  outcome_unknown_source text null check (outcome_unknown_source in ('worker','classifier')),
  outcome_unknown_at     timestamptz null,
  worker_claim_id        uuid null,
  worker_id              text null check (worker_id is null or pg_catalog.char_length(worker_id) between 1 and 64),
  available_at           timestamptz not null default pg_catalog.now(),
  requeue_count          integer not null default 0 check (requeue_count >= 0),
  client_metrics         jsonb null,
  reserved_units         integer not null check (reserved_units >= 0),
  failure_kind           text null check (failure_kind in ('video_unusable','provider_rejected','response_unusable','save_failed',
                           'ineligible','superseded_binding','superseded_state','requeue_exhausted','reconciled')),
  created_at             timestamptz not null default pg_catalog.now(),
  claimed_at             timestamptz null,
  dispatched_at          timestamptz null,
  finished_at            timestamptz null,
  unique (analysis_id, generation),
  constraint analysis_jobs_retry_shape check ((generation = 1 and retry_of_job_id is null) or (generation > 1 and retry_of_job_id is not null)),
  constraint analysis_jobs_claim_shape check ((state not in ('claimed','dispatched','outcome_unknown') or worker_claim_id is not null)
                                              and (state <> 'queued' or worker_claim_id is null)),
  constraint analysis_jobs_unknown_shape check ((state = 'outcome_unknown') = (outcome_unknown_source is not null)
                                                and (outcome_unknown_source is null) = (outcome_unknown_at is null)),
  constraint analysis_jobs_terminal_shape check ((state in ('succeeded','failed_definite','reconciled','cancelled_ineligible','superseded'))
                                                 = (finished_at is not null)),
  constraint analysis_jobs_metrics_shape check (case
    when client_metrics is null then true
    when pg_catalog.jsonb_typeof(client_metrics) <> 'object' then false
    when (client_metrics - array['spineAngle','hipRotation','shoulderRotation','tempoRatio','setupSpineAngle','impactSpineAngle']::text[]) <> '{}'::jsonb then false
    when pg_catalog.octet_length(client_metrics::text) > 512 then false
    else public.analysis_metrics_values_ok(client_metrics) end)
);
create unique index analysis_jobs_one_open_per_analysis on public.analysis_jobs (analysis_id)
  where state in ('queued','claimed','dispatched','outcome_unknown');
create unique index analysis_jobs_one_retry_per_attempt on public.analysis_jobs (retry_of_job_id) where retry_of_job_id is not null;
create index analysis_jobs_queue on public.analysis_jobs (available_at, created_at) where state = 'queued';
create index analysis_jobs_claimed on public.analysis_jobs (claimed_at) where state = 'claimed';
create index analysis_jobs_dispatched on public.analysis_jobs (dispatched_at) where state = 'dispatched';
create index analysis_jobs_user_open on public.analysis_jobs (user_id) where state in ('queued','claimed','dispatched','outcome_unknown');
create index analysis_jobs_video on public.analysis_jobs (video_id);
create index analysis_jobs_user on public.analysis_jobs (user_id);

create table public.analysis_admission_control (
  id                        boolean primary key default true check (id),
  execution_mode_full_swing text not null default 'sync' check (execution_mode_full_swing in ('sync','queue')),
  execution_mode_putting    text not null default 'sync' check (execution_mode_putting = 'sync'),
  admissions_enabled        boolean not null default false,
  dispatch_enabled          boolean not null default false,
  provider_mode             text not null default 'none' check (provider_mode in ('none','synthetic','real')),
  legacy_failed_admission   boolean not null default false,
  max_open_jobs_per_user    integer not null default 3 check (max_open_jobs_per_user >= 1),
  max_concurrent_dispatch   integer not null default 1 check (max_concurrent_dispatch >= 1),
  max_requeues              integer not null default 5 check (max_requeues >= 0),
  units_full_swing          integer not null default 1 check (units_full_swing >= 1),
  per_user_daily_units      integer null check (per_user_daily_units >= 0),
  global_daily_units        integer null check (global_daily_units >= 0),
  updated_at                timestamptz not null default pg_catalog.now(),
  constraint analysis_admission_real_needs_limits check (provider_mode <> 'real' or (per_user_daily_units is not null and global_daily_units is not null))
);

create table public.analysis_spend_ledger (
  id              uuid primary key default pg_catalog.gen_random_uuid(),
  job_id          uuid not null unique,
  analysis_id     uuid not null,
  user_id         uuid not null,
  units           integer not null check (units >= 0),
  state           text not null check (state in ('reserved','dispatched','held','charged','released')),
  reason          text not null default 'admitted' check (pg_catalog.char_length(reason) between 1 and 64),
  reserved_at     timestamptz not null default pg_catalog.now(),
  dispatched_at   timestamptz null,
  worker_claim_id uuid null,
  settled_at      timestamptz null,
  constraint analysis_spend_ledger_dispatch_shape check (
    (state = 'reserved' and dispatched_at is null and worker_claim_id is null and settled_at is null)
    or (state in ('dispatched','held') and dispatched_at is not null and worker_claim_id is not null and settled_at is null)
    or (state = 'charged' and dispatched_at is not null and worker_claim_id is not null and settled_at is not null)
    or (state = 'released' and settled_at is not null and (dispatched_at is null) = (worker_claim_id is null)))
);
create index analysis_spend_ledger_slots on public.analysis_spend_ledger (state) where state in ('dispatched','held');
create index analysis_spend_ledger_reserved on public.analysis_spend_ledger (user_id) where state = 'reserved';
create index analysis_spend_ledger_window on public.analysis_spend_ledger (dispatched_at) where state in ('dispatched','held','charged');
create index analysis_spend_ledger_user_window on public.analysis_spend_ledger (user_id, dispatched_at) where state in ('dispatched','held','charged');

alter table public.analysis_jobs enable row level security;
alter table public.analysis_admission_control enable row level security;
alter table public.analysis_spend_ledger enable row level security;

-- The operator path (postgres), with or without BYPASSRLS.
create policy analysis_jobs_operator on public.analysis_jobs for all to postgres using (true) with check (true);
create policy analysis_admission_control_operator on public.analysis_admission_control for all to postgres using (true) with check (true);
create policy analysis_spend_ledger_operator on public.analysis_spend_ledger for all to postgres using (true) with check (true);

-- ── Internal helpers (no EXECUTE for anyone but the owner) ─────────────────

-- The second layer against the ENT-1D operator override (ADR §4.2). A function
-- SET clause cannot pin this placeholder for a non-superuser migration role on
-- PostgreSQL 17 ("permission denied to set parameter"), so every callable
-- definer function refuses to run while any override marker is set in the
-- session. The primary control is unchanged: inside these functions
-- current_user is analysis_jobs_owner, which the guard never honours.
create function public.analysis_jobs_refuse_override()
returns void
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if coalesce(pg_catalog.current_setting('swingproai.execution_guard', true), '') <> '' then
    raise exception 'AJ-OVERRIDE-1: analysis job functions do not run while an execution-guard override marker is set'
      using errcode = 'P0001';
  end if;
end;
$fn$;

-- The golfer-facing attempt (never the claim, the worker or an internal kind).
create function public.analysis_jobs_attempt_json(j public.analysis_jobs)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select case when j.id is null then null else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id', j.id,
    'generation', j.generation,
    'state', case j.state
               when 'queued' then 'queued'
               when 'claimed' then 'processing'
               when 'dispatched' then 'processing'
               when 'outcome_unknown' then 'interrupted'
               when 'succeeded' then 'complete'
               else 'failed' end,
    'acceptedAt', j.created_at,
    'dispatchedAt', j.dispatched_at,
    'finishedAt', j.finished_at,
    'failureKind', case
                     when j.state in ('failed_definite','reconciled','cancelled_ineligible','superseded')
                       then case when j.failure_kind = 'video_unusable' then 'video_unusable' else 'not_finished' end
                     else null end)) end
$fn$;

-- A1 (attempt identity). An admission reply names the attempt the request's
-- own intent was accepted as (p_bound: generation 1 for the initial press, the
-- one successor of the attempt a Retry names), so a delayed repeat is never
-- handed a later attempt's identity. The attempt the status describes, when it
-- is a different one, is reported separately as `current`. Without a bound
-- attempt the reply names p_current, as before.
create function public.analysis_jobs_reply(p_disposition text, p_bound public.analysis_jobs, p_current public.analysis_jobs)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select case
    when p_bound.id is not null and p_current.id is not null and p_current.id <> p_bound.id then
      pg_catalog.jsonb_build_object('disposition', p_disposition,
                                    'attempt', public.analysis_jobs_attempt_json(p_bound),
                                    'current', public.analysis_jobs_attempt_json(p_current))
    else
      pg_catalog.jsonb_build_object('disposition', p_disposition,
                                    'attempt', public.analysis_jobs_attempt_json(case when p_bound.id is not null then p_bound else p_current end))
  end
$fn$;

-- Precedence for every status surface: complete > open job > terminal job > no job.
create function public.analysis_jobs_view(p_analysis uuid, p_user uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  a record;
  v_open public.analysis_jobs;
  v_last public.analysis_jobs;
  c public.analysis_admission_control;
  v_exec text;
  v_startable text;
  v_attempt public.analysis_jobs;
  v_lease constant interval := interval '900 seconds';
begin
  select s.id, s.status, s.analysis_family, s.processing_claim_id, s.processing_heartbeat_at, s.provider_dispatched_at
    into a from public.swing_analysis s where s.id = p_analysis and s.user_id = p_user;
  if not found then
    return null;
  end if;
  select * into v_open from public.analysis_jobs j
   where j.analysis_id = p_analysis and j.user_id = p_user and j.state in ('queued','claimed','dispatched','outcome_unknown');
  select * into v_last from public.analysis_jobs j where j.analysis_id = p_analysis and j.user_id = p_user order by j.generation desc limit 1;
  select * into c from public.analysis_admission_control where id;
  v_attempt := case when v_open.id is not null then v_open else v_last end;
  -- A1: what a press would do for work that can start. The full-swing pause applies only to full swing (a null family
  -- is a pre-family full-swing row); putting stays synchronous and is unaffected by the full-swing switches.
  v_startable := case when coalesce(a.analysis_family, 'full_swing') = 'full_swing'
                           and (c.id is null or (c.execution_mode_full_swing = 'queue' and not c.admissions_enabled)) then 'paused'
                      else 'idle' end;
  if a.status = 'complete' then
    v_exec := 'complete';
  elsif v_open.id is not null then
    v_exec := case v_open.state when 'queued' then 'queued' when 'outcome_unknown' then 'interrupted' else 'processing' end;
  elsif v_last.id is not null and a.status in ('failed','pending') then
    v_exec := 'failed';
  elsif v_last.id is null and a.status = 'pending' then
    v_exec := v_startable;
  elsif v_last.id is null and a.status = 'failed' then
    v_exec := 'failed';
  elsif a.status = 'processing' then
    -- A1: the same cases, in the same order, as admission step 7 (admit_analysis_job), so a read and a press agree:
    -- a live claim (dispatched or not) is processing; an expired claim that never dispatched, on an analysis that
    -- never had a job, is taken over by the next press (admission creates generation 1; the synchronous path takes the
    -- claim over), so it reads as startable; anything else (lease-less, dispatched and expired, or marked unknown) is
    -- interrupted.
    v_exec := case
                when a.processing_claim_id is null then 'interrupted'
                when a.processing_heartbeat_at > pg_catalog.now() - v_lease then 'processing'
                when a.provider_dispatched_at is null and v_last.id is null then v_startable
                else 'interrupted' end;
  else
    v_exec := 'interrupted';
  end if;
  return pg_catalog.jsonb_build_object(
    'analysisId', p_analysis,
    'execution', v_exec,
    'attempt', public.analysis_jobs_attempt_json(v_attempt));
end;
$fn$;

-- The caller of a read function: the verified JWT subject PostgREST set for
-- this request (request.jwt.claims, the only source), or nothing. A null,
-- empty, malformed or non-UUID subject fails closed.
create function public.analysis_jobs_caller()
returns uuid
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_sub text;
begin
  begin
    v_sub := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
  exception when others then
    return null;
  end;
  if v_sub is null or v_sub !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  return v_sub::uuid;
end;
$fn$;

-- Ledger usage (C3). Outstanding reservations of any age, and units dispatched
-- within the rolling 24 h window whatever has happened to the job or account since.
create function public.analysis_jobs_usage(p_user uuid, p_include_reserved boolean)
returns table (user_units bigint, global_units bigint)
language sql
stable
set search_path = ''
as $fn$
  select
    coalesce(pg_catalog.sum(l.units) filter (where l.user_id = p_user), 0)::bigint,
    coalesce(pg_catalog.sum(l.units), 0)::bigint
  from public.analysis_spend_ledger l
  where (p_include_reserved and l.state = 'reserved')
     or (l.state in ('dispatched','held','charged') and l.dispatched_at > pg_catalog.now() - interval '24 hours')
$fn$;

-- Live dispatch slots (C2): claimed jobs with a live undispatched lease, plus
-- every ledger row whose dispatch is unresolved (dispatched or held), whether or
-- not its job or account still exists.
create function public.analysis_jobs_live_slots()
returns bigint
language sql
stable
set search_path = ''
as $fn$
  select
    (select pg_catalog.count(*) from public.analysis_jobs j join public.swing_analysis s on s.id = j.analysis_id
      where j.state = 'claimed' and s.status = 'processing' and s.processing_claim_id = j.worker_claim_id
        and s.provider_dispatched_at is null and s.processing_heartbeat_at > pg_catalog.now() - interval '900 seconds')
  + (select pg_catalog.count(*) from public.analysis_spend_ledger l where l.state in ('dispatched','held'))
$fn$;

-- The bounded result (correction to ADR §5): exactly the nine stored keys.
-- Bounds are never stricter than lib/full-swing-analysis-contract.ts; the
-- "parity:" constants are compared with the TypeScript constants by a test.
create function public.analysis_result_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_max_findings constant integer := 4;             -- parity: MAX_FINDINGS
  v_max_summary constant integer := 4000;           -- parity: MAX_EXECUTIVE_SUMMARY_CHARS
  v_max_metrics_bytes constant integer := 65536;    -- parity: MAX_STORED_METRICS_BYTES
  v_max_result_bytes constant integer := 262144;    -- parity: MAX_STORED_RESULT_BYTES
  v_max_tempo constant numeric := 99.99;            -- parity: MAX_STORED_TEMPO_RATIO
  v_keys constant text[] := array['score','feedback','spine_angle','hip_rotation','shoulder_rotation','tempo_ratio',
                                  'metrics','swing_highlights','mechanical_deficiencies'];
  v_metric_keys constant text[] := array['scoring_breakdown','evidence_limits','evidence_coverage','metric_evidence','fault_tags',
                                         'drills','posture','swing_plane','impact','practice_focus','pro_cue','rubric_assessment'];
  e jsonb;
  k text;
begin
  if p is null or pg_catalog.jsonb_typeof(p) <> 'object' or pg_catalog.octet_length(p::text) > v_max_result_bytes then
    return false;
  end if;
  if (select pg_catalog.array_agg(x order by x) from pg_catalog.jsonb_object_keys(p) x)
     is distinct from (select pg_catalog.array_agg(x order by x) from pg_catalog.unnest(v_keys) x) then
    return false;
  end if;
  if not (pg_catalog.jsonb_typeof(p->'score') = 'null'
          or (pg_catalog.jsonb_typeof(p->'score') = 'number' and (p->>'score')::numeric between 0 and 100)) then
    return false;
  end if;
  foreach k in array array['spine_angle','hip_rotation','shoulder_rotation'] loop
    if not (pg_catalog.jsonb_typeof(p->k) = 'null'
            or (pg_catalog.jsonb_typeof(p->k) = 'number' and (p->>k)::numeric between -360 and 360)) then
      return false;
    end if;
  end loop;
  if not (pg_catalog.jsonb_typeof(p->'tempo_ratio') = 'null'
          or (pg_catalog.jsonb_typeof(p->'tempo_ratio') = 'number' and (p->>'tempo_ratio')::numeric between 0 and v_max_tempo)) then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p->'feedback') <> 'string'
     or pg_catalog.char_length(p->>'feedback') not between 1 and v_max_summary then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p->'metrics') <> 'object'
     or pg_catalog.octet_length((p->'metrics')::text) > v_max_metrics_bytes
     or ((p->'metrics') - v_metric_keys) <> '{}'::jsonb then
    return false;
  end if;
  -- each metrics section has the stored type (text lengths: only the summary bound, as in the TypeScript contract)
  for k in select x from pg_catalog.jsonb_object_keys(p->'metrics') x loop
    e := p->'metrics'->k;
    if pg_catalog.jsonb_typeof(e) = 'null' then
      continue;
    end if;
    if k in ('scoring_breakdown','evidence_limits','practice_focus','pro_cue') then
      if pg_catalog.jsonb_typeof(e) <> 'string' then
        return false;
      end if;
    elsif k = 'fault_tags' then
      if pg_catalog.jsonb_typeof(e) <> 'array' or pg_catalog.jsonb_array_length(e) > v_max_findings
         or exists (select 1 from pg_catalog.jsonb_array_elements(e) t where pg_catalog.jsonb_typeof(t) <> 'string') then
        return false;
      end if;
    elsif k = 'drills' then
      if pg_catalog.jsonb_typeof(e) <> 'array' or pg_catalog.jsonb_array_length(e) > v_max_findings
         or exists (select 1 from pg_catalog.jsonb_array_elements(e) t where pg_catalog.jsonb_typeof(t) <> 'object'
                      or exists (select 1 from pg_catalog.jsonb_each(t) f where pg_catalog.jsonb_typeof(f.value) not in ('string','null'))) then
        return false;
      end if;
    elsif k in ('posture','swing_plane','impact') then
      if pg_catalog.jsonb_typeof(e) <> 'object' or (e - array['rating','observation','correction']) <> '{}'::jsonb
         or exists (select 1 from pg_catalog.jsonb_each(e) f where pg_catalog.jsonb_typeof(f.value) <> 'string') then
        return false;
      end if;
    elsif k in ('evidence_coverage','metric_evidence','rubric_assessment') then
      if pg_catalog.jsonb_typeof(e) <> 'object' then
        return false;
      end if;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p->'swing_highlights') <> 'array'
     or pg_catalog.jsonb_array_length(p->'swing_highlights') > v_max_findings then
    return false;
  end if;
  for e in select x from pg_catalog.jsonb_array_elements(p->'swing_highlights') x loop
    if pg_catalog.jsonb_typeof(e) <> 'object'
       or (select pg_catalog.array_agg(x order by x) from pg_catalog.jsonb_object_keys(e) x)
          is distinct from array['checkpoint','mechanical_benefit','positive_movement']
       or pg_catalog.jsonb_typeof(e->'checkpoint') <> 'null'
       or pg_catalog.jsonb_typeof(e->'positive_movement') <> 'string'
       or pg_catalog.jsonb_typeof(e->'mechanical_benefit') <> 'string' then
      return false;
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p->'mechanical_deficiencies') <> 'array'
     or pg_catalog.jsonb_array_length(p->'mechanical_deficiencies') > v_max_findings then
    return false;
  end if;
  for e in select x from pg_catalog.jsonb_array_elements(p->'mechanical_deficiencies') x loop
    if pg_catalog.jsonb_typeof(e) <> 'object'
       or (select pg_catalog.array_agg(x order by x) from pg_catalog.jsonb_object_keys(e) x)
          is distinct from array['checkpoint','corrective_drill_detail','corrective_drill_title','fault_description','joint_coordinate','severity']
       or pg_catalog.jsonb_typeof(e->'checkpoint') <> 'null'
       or pg_catalog.jsonb_typeof(e->'joint_coordinate') <> 'null'
       or pg_catalog.jsonb_typeof(e->'severity') <> 'null'
       or pg_catalog.jsonb_typeof(e->'fault_description') <> 'string'
       or pg_catalog.jsonb_typeof(e->'corrective_drill_detail') <> 'string'
       or pg_catalog.jsonb_typeof(e->'corrective_drill_title') <> 'string' then
      return false;
    end if;
  end loop;
  return true;
end;
$fn$;

-- ── Admission (service_role) ────────────────────────────────────────────────
--
-- Admission decision, in precedence order (one rule for the API, the UI and
-- the tests; lib/analysis-attempt-precedence.ts):
--   0. missing control row: admission_paused; unknown owner or analysis: not_found
--   1. analysis complete: complete (a completed report stays readable even if
--      its video later becomes unusable)
--   2. (the video binding is checked only when a job would be created: below)
--   3. family: putting -> family_not_queued; unknown -> unsupported
--   4. p_retry_of must name a job of this analysis (or be the legacy sentinel
--      on a failed analysis that never had a job, while legacy admission is
--      enabled), else not_found
--   5. never had a job: mode sync -> sync_mode; undeclared -> client_update_required.
--      Has a job and undeclared -> client_update_required
--   6. an open job: queued/claimed/dispatched -> replayed; outcome_unknown -> stalled
--   7. processing with no open job: a live claim (heartbeat within the lease,
--      dispatched or not) -> in_progress; an expired undispatched claim and no
--      job ever -> create g1 (the worker takes the orphan over); dispatched and
--      expired, unknown or lease-less -> stalled
--   8. pending with no job ever -> create g1
--   9. last job terminal and analysis failed or pending: retry_of = that job ->
--      create generation n+1; no retry_of -> failed_observed; any other -> superseded
--  10. failed with no job ever: the legacy sentinel -> create g1; otherwise
--      failed_observed (no attempt)
--  11. anything else: not_startable
--   Creating a job then needs the owner's uploaded video with a canonical key
--   (else video_not_ready), admissions_enabled (else admission_paused) and the
--   per-user open-job, per-user and global unit limits (else limit_reached). So
--   sync_mode reaches today's synchronous path unchanged (its own video handling).
--
--   A1 attempt identity: every reply's `attempt` is the attempt the request's own
--   intent was accepted as, when it exists: the initial press (no p_retry_of, or
--   the legacy sentinel once the analysis has a job) is generation 1; a Retry
--   naming attempt X is X's one successor. A delayed repeat therefore names its
--   own attempt, never a later one; the attempt the disposition describes, when
--   different, is `current` (analysis_jobs_reply). A repeat never creates a job:
--   only the initial press with no job ever, or a Retry naming the latest,
--   terminal attempt (which has no successor yet), can.
create function public.admit_analysis_job(p_user uuid, p_analysis uuid, p_declared boolean,
                                          p_retry_of text default null, p_client_metrics jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  c public.analysis_admission_control;
  a record;
  v record;
  v_has_job boolean;
  v_open public.analysis_jobs;
  v_last public.analysis_jobs;
  v_bound public.analysis_jobs;
  v_retry uuid := null;
  v_legacy boolean := false;
  v_create boolean := false;
  v_gen integer;
  v_new public.analysis_jobs;
  v_metrics jsonb := null;
  v_open_count bigint;
  v_user_units bigint;
  v_global_units bigint;
  v_lease constant interval := interval '900 seconds';
begin
  perform public.analysis_jobs_refuse_override();
  -- 0. Control row first (lock order: control, golfer, job, analysis).
  select * into c from public.analysis_admission_control where id for update;
  if not found then
    return pg_catalog.jsonb_build_object('disposition', 'admission_paused', 'reason', 'control_missing');
  end if;
  if p_user is null or p_analysis is null then
    return pg_catalog.jsonb_build_object('disposition', 'not_found');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('analysis_jobs:user:' || p_user::text, 0));
  if not exists (select 1 from public.users u where u.id = p_user) then
    return pg_catalog.jsonb_build_object('disposition', 'not_found');
  end if;
  select s.id, s.status, s.swing_video_id, s.analysis_family, s.processing_claim_id, s.processing_heartbeat_at,
         s.provider_dispatched_at
    into a from public.swing_analysis s where s.id = p_analysis and s.user_id = p_user for update;
  if not found then
    return pg_catalog.jsonb_build_object('disposition', 'not_found');
  end if;
  select * into v_open from public.analysis_jobs j
   where j.analysis_id = p_analysis and j.state in ('queued','claimed','dispatched','outcome_unknown');
  select * into v_last from public.analysis_jobs j where j.analysis_id = p_analysis order by j.generation desc limit 1;
  v_has_job := v_last.id is not null;
  -- A1: the attempt this request's intent was accepted as, if it was (see the header)
  if p_retry_of is null or p_retry_of = 'legacy' then
    select * into v_bound from public.analysis_jobs j where j.analysis_id = p_analysis and j.generation = 1;
  elsif p_retry_of ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select * into v_bound from public.analysis_jobs j where j.analysis_id = p_analysis and j.retry_of_job_id = p_retry_of::uuid;
  end if;

  -- 1. complete
  if a.status = 'complete' then
    return public.analysis_jobs_reply('complete', v_bound, v_last);
  end if;
  -- 3. family
  if a.analysis_family = 'putting' then
    return pg_catalog.jsonb_build_object('disposition', 'family_not_queued');
  elsif a.analysis_family is not null and a.analysis_family <> 'full_swing' then
    return pg_catalog.jsonb_build_object('disposition', 'unsupported');
  end if;
  -- 4. retry_of
  if p_retry_of is not null then
    if p_retry_of = 'legacy' then
      if a.status = 'failed' and not v_has_job and c.legacy_failed_admission then
        v_legacy := true;
      elsif v_has_job then
        null;   -- A1: a repeat of an accepted legacy press is the initial intent (bound to generation 1); it creates nothing
      else
        return pg_catalog.jsonb_build_object('disposition', 'not_found');
      end if;
    elsif p_retry_of ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and exists (select 1 from public.analysis_jobs j where j.id = p_retry_of::uuid and j.analysis_id = p_analysis) then
      v_retry := p_retry_of::uuid;
    else
      return pg_catalog.jsonb_build_object('disposition', 'not_found');
    end if;
  end if;
  -- 5. mode and declaration
  if not v_has_job then
    if c.execution_mode_full_swing = 'sync' then
      return pg_catalog.jsonb_build_object('disposition', 'sync_mode');
    elsif not coalesce(p_declared, false) then
      return pg_catalog.jsonb_build_object('disposition', 'client_update_required');
    end if;
  elsif not coalesce(p_declared, false) then
    return public.analysis_jobs_reply('client_update_required', v_bound, case when v_open.id is not null then v_open else v_last end);
  end if;
  -- 6. open job
  if v_open.id is not null then
    return public.analysis_jobs_reply(case when v_open.state = 'outcome_unknown' then 'stalled' else 'replayed' end, v_bound, v_open);
  end if;
  -- 7..11
  if a.status = 'processing' then
    -- A1: a live claim is in progress whether or not it has dispatched (the status read shows it processing too)
    if a.processing_claim_id is not null and a.processing_heartbeat_at > pg_catalog.now() - v_lease then
      return pg_catalog.jsonb_build_object('disposition', 'in_progress');
    elsif a.processing_claim_id is not null and a.provider_dispatched_at is null and not v_has_job then
      v_create := true;    -- expired, undispatched synchronous claim: the worker takes it over
    else
      return public.analysis_jobs_reply('stalled', v_bound, v_last);
    end if;
  elsif a.status = 'pending' and not v_has_job then
    v_create := true;
  elsif v_has_job and a.status in ('failed','pending') then
    if v_retry is not null and v_retry = v_last.id then
      v_create := true;
    elsif v_retry is null then
      return public.analysis_jobs_reply('failed_observed', v_bound, v_last);
    else
      return public.analysis_jobs_reply('superseded', v_bound, v_last);
    end if;
  elsif not v_has_job and a.status = 'failed' then
    if v_legacy then
      v_create := true;
    else
      return pg_catalog.jsonb_build_object('disposition', 'failed_observed');
    end if;
  else
    return pg_catalog.jsonb_build_object('disposition', 'not_startable');
  end if;

  -- Creating a job: the owner's uploaded, canonical video first.
  select vd.id, vd.status, vd.storage_path into v from public.swing_videos vd
   where vd.id = a.swing_video_id and vd.user_id = p_user;
  if not found or v.status is distinct from 'uploaded'
     or not public.ent1d_is_canonical_swing_video_key(v.storage_path, p_user) then
    return pg_catalog.jsonb_build_object('disposition', 'video_not_ready');
  end if;
  if not c.admissions_enabled then
    return pg_catalog.jsonb_build_object('disposition', 'admission_paused', 'reason', 'admissions_off',
                                         'attempt', public.analysis_jobs_attempt_json(v_last));
  end if;
  select pg_catalog.count(*) into v_open_count from public.analysis_jobs j
   where j.user_id = p_user and j.state in ('queued','claimed','dispatched','outcome_unknown');
  if v_open_count >= c.max_open_jobs_per_user then
    return pg_catalog.jsonb_build_object('disposition', 'limit_reached', 'reason', 'open_jobs');
  end if;
  if c.provider_mode = 'real' and (c.per_user_daily_units is null or c.global_daily_units is null) then
    return pg_catalog.jsonb_build_object('disposition', 'admission_paused', 'reason', 'limits_unset');
  end if;
  select u.user_units, u.global_units into v_user_units, v_global_units from public.analysis_jobs_usage(p_user, true) u;
  if (c.per_user_daily_units is not null and v_user_units + c.units_full_swing > c.per_user_daily_units)
     or (c.global_daily_units is not null and v_global_units + c.units_full_swing > c.global_daily_units) then
    return pg_catalog.jsonb_build_object('disposition', 'limit_reached', 'reason', 'units');
  end if;
  -- Client estimates: only the six keys with well-formed values are kept.
  if p_client_metrics is not null and pg_catalog.jsonb_typeof(p_client_metrics) = 'object' then
    select pg_catalog.jsonb_object_agg(e.key, e.value) into v_metrics
      from pg_catalog.jsonb_each(p_client_metrics) e
     where e.key in ('spineAngle','hipRotation','shoulderRotation','tempoRatio','setupSpineAngle','impactSpineAngle')
       and public.analysis_metrics_values_ok(pg_catalog.jsonb_build_object(e.key, e.value));
  end if;
  v_gen := coalesce(v_last.generation, 0) + 1;
  insert into public.analysis_jobs (analysis_id, user_id, video_id, family, generation, retry_of_job_id, client_metrics, reserved_units)
  values (p_analysis, p_user, a.swing_video_id, 'full_swing', v_gen, case when v_gen > 1 then v_last.id end, v_metrics, c.units_full_swing)
  returning * into v_new;
  insert into public.analysis_spend_ledger (job_id, analysis_id, user_id, units, state, reason)
  values (v_new.id, p_analysis, p_user, c.units_full_swing, 'reserved', case when v_legacy then 'admitted_legacy' else 'admitted' end);
  return pg_catalog.jsonb_build_object('disposition', 'created', 'attempt', public.analysis_jobs_attempt_json(v_new));
end;
$fn$;

-- ── Reads (authenticated; owner from the request's JWT subject) ─────────────
create function public.read_analysis_job_state(p_analysis uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := public.analysis_jobs_caller();
begin
  perform public.analysis_jobs_refuse_override();
  if v_user is null or p_analysis is null then
    return null;
  end if;
  return public.analysis_jobs_view(p_analysis, v_user);
end;
$fn$;

create function public.read_analysis_job_states(p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := public.analysis_jobs_caller();
  v_out jsonb;
begin
  perform public.analysis_jobs_refuse_override();
  if v_user is null or p_ids is null or pg_catalog.cardinality(p_ids) > 50 then
    return '[]'::jsonb;
  end if;
  select coalesce(pg_catalog.jsonb_agg(x.v), '[]'::jsonb) into v_out
    from (select public.analysis_jobs_view(i, v_user) as v from (select distinct pg_catalog.unnest(p_ids) as i) d) x
   where x.v is not null;
  return v_out;
end;
$fn$;

-- ── Worker (analysis_worker) ────────────────────────────────────────────────

create function public.acquire_analysis_job(p_worker text, p_adapter text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  c public.analysis_admission_control;
  j public.analysis_jobs;
  a record;
  v_video record;
  v_claim uuid;
  v_lease constant interval := interval '900 seconds';
  v_kind text;
  v_takeover boolean;
  v_ids uuid[];
  v_id uuid;
begin
  perform public.analysis_jobs_refuse_override();
  select * into c from public.analysis_admission_control where id for update;
  if not found or not c.dispatch_enabled or c.provider_mode = 'none' or p_adapter is distinct from c.provider_mode
     or p_worker is null or pg_catalog.char_length(p_worker) not between 1 and 64 then
    return null;
  end if;
  if public.analysis_jobs_live_slots() >= c.max_concurrent_dispatch then
    return null;
  end if;
  -- Candidates, locked and skipped-if-locked: expired undispatched claims first
  -- (takeover; this bounds a dead worker's delay), then due queued jobs.
  v_ids := array(select jj.id from public.analysis_jobs jj join public.swing_analysis s on s.id = jj.analysis_id
                  where jj.state = 'claimed' and s.status = 'processing' and s.processing_claim_id = jj.worker_claim_id
                    and s.provider_dispatched_at is null and s.processing_heartbeat_at <= pg_catalog.now() - v_lease
                  order by jj.claimed_at limit 5 for no key update of jj skip locked);
  v_ids := v_ids || array(select jj.id from public.analysis_jobs jj
                           where jj.state = 'queued' and jj.available_at <= pg_catalog.now()
                           order by jj.available_at, jj.created_at limit 10 for no key update skip locked);
  foreach v_id in array v_ids loop
    select * into j from public.analysis_jobs where id = v_id;
    select s.id, s.user_id, s.swing_video_id, s.status, s.processing_claim_id, s.processing_heartbeat_at, s.provider_dispatched_at
      into a from public.swing_analysis s where s.id = j.analysis_id for update skip locked;
    if not found then
      continue;  -- locked by someone else: skipped, never superseded
    end if;
    v_kind := null;
    v_takeover := false;
    if exists (select 1 from public.analysis_jobs x where x.analysis_id = j.analysis_id and x.generation > j.generation) then
      v_kind := 'superseded_state';
    elsif a.user_id is distinct from j.user_id or a.swing_video_id is distinct from j.video_id then
      v_kind := 'superseded_binding';
    elsif a.status in ('pending','failed') and j.state = 'queued' then
      null;
    elsif a.status = 'processing' and a.processing_claim_id is not null and a.provider_dispatched_at is null
          and a.processing_heartbeat_at <= pg_catalog.now() - v_lease
          and (j.state = 'queued' or a.processing_claim_id = j.worker_claim_id) then
      v_takeover := true;
    elsif a.status = 'processing' and a.processing_claim_id is not null and a.provider_dispatched_at is null then
      continue;  -- a live undispatched claim: not now
    else
      v_kind := 'superseded_state';  -- complete, dispatched elsewhere, lease-less or unknown
    end if;
    if v_kind is null then
      -- the path handed to the worker is the owner's uploaded, canonical object, re-checked now
      select vd.storage_path, vd.status into v_video from public.swing_videos vd where vd.id = j.video_id and vd.user_id = j.user_id;
      if not found or v_video.status is distinct from 'uploaded'
         or not public.ent1d_is_canonical_swing_video_key(v_video.storage_path, j.user_id) then
        v_kind := 'video_unusable';  -- the golfer is asked to upload again (a Retry would answer video_not_ready)
      end if;
    end if;
    if v_kind is not null then
      update public.analysis_jobs set state = 'superseded', failure_kind = v_kind, worker_claim_id = null,
             finished_at = pg_catalog.now()
       where id = j.id;
      update public.analysis_spend_ledger set state = 'released', reason = v_kind, settled_at = pg_catalog.now()
       where job_id = j.id and state = 'reserved';
      continue;
    end if;
    v_claim := pg_catalog.gen_random_uuid();
    update public.analysis_jobs set state = 'claimed', worker_claim_id = v_claim, worker_id = p_worker, claimed_at = pg_catalog.now()
     where id = j.id;
    update public.swing_analysis
       set status = 'processing', processing_claim_id = v_claim, processing_started_at = pg_catalog.now(),
           processing_heartbeat_at = pg_catalog.now(), provider_dispatched_at = null
     where id = j.analysis_id;
    return pg_catalog.jsonb_build_object(
      'jobId', j.id, 'analysisId', j.analysis_id, 'userId', j.user_id, 'videoId', j.video_id,
      'generation', j.generation, 'claimId', v_claim, 'recovered', v_takeover,
      'storagePath', v_video.storage_path, 'clientMetrics', j.client_metrics);
  end loop;
  return null;
end;
$fn$;

-- C1: the typed dispatch permission. Only 'dispatched', for this job, claim and
-- generation, allows one provider request.
create function public.mark_job_dispatched(p_job uuid, p_claim uuid, p_adapter text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'  -- below admission's 5 s: an admission queued behind a waiting mark never times out
as $fn$
declare
  c public.analysis_admission_control;
  j public.analysis_jobs;
  a record;
  u record;
  v_user_units bigint;
  v_global_units bigint;
  v_rows integer;
  v_tiers constant text[] := array['par','birdie','eagle','coach_starter','coach_pro','none'];  -- parity: KNOWN_TIERS
  v_statuses constant text[] := array['active','trialing','past_due','canceled','none'];      -- parity: KNOWN_STATUSES
  r jsonb;
begin
  perform public.analysis_jobs_refuse_override();
  r := pg_catalog.jsonb_build_object('jobId', p_job, 'claimId', p_claim);
  select * into c from public.analysis_admission_control where id for update;
  if not found or not c.dispatch_enabled or c.provider_mode = 'none' or p_adapter is distinct from c.provider_mode then
    return r || pg_catalog.jsonb_build_object('reason', 'policy_hold');
  end if;
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found or j.state <> 'claimed' or j.worker_claim_id is distinct from p_claim then
    return r || pg_catalog.jsonb_build_object('reason', 'fenced');
  end if;
  r := r || pg_catalog.jsonb_build_object('generation', j.generation);
  select s.user_id, s.swing_video_id, s.status, s.processing_claim_id, s.provider_dispatched_at, s.processing_heartbeat_at
    into a from public.swing_analysis s where s.id = j.analysis_id for update;
  if not found or a.status <> 'processing' or a.processing_claim_id is distinct from p_claim or a.provider_dispatched_at is not null then
    return r || pg_catalog.jsonb_build_object('reason', 'fenced');
  end if;
  -- an expired claim no longer holds a slot (acquire may have handed it on): it never dispatches
  if a.processing_heartbeat_at <= pg_catalog.now() - interval '900 seconds' then
    return r || pg_catalog.jsonb_build_object('reason', 'fenced');
  end if;
  -- the cap, recounted under the control lock: this live claim plus every unresolved dispatch
  if public.analysis_jobs_live_slots() > c.max_concurrent_dispatch then
    return r || pg_catalog.jsonb_build_object('reason', 'policy_hold');
  end if;
  select x.subscription_tier, x.subscription_status into u from public.users x where x.id = j.user_id;
  if not found or a.user_id is distinct from j.user_id or a.swing_video_id is distinct from j.video_id
     or not (u.subscription_tier = any (v_tiers)) or not (u.subscription_status = any (v_statuses)) then
    return r || pg_catalog.jsonb_build_object('reason', 'ineligible');
  end if;
  if c.provider_mode = 'real' and (c.per_user_daily_units is null or c.global_daily_units is null) then
    return r || pg_catalog.jsonb_build_object('reason', 'policy_hold');
  end if;
  if c.per_user_daily_units is not null or c.global_daily_units is not null then
    select x.user_units, x.global_units into v_user_units, v_global_units from public.analysis_jobs_usage(j.user_id, false) x;
    if (c.per_user_daily_units is not null and v_user_units + j.reserved_units > c.per_user_daily_units)
       or (c.global_daily_units is not null and v_global_units + j.reserved_units > c.global_daily_units) then
      return r || pg_catalog.jsonb_build_object('reason', 'policy_hold');
    end if;
  end if;
  update public.swing_analysis
     set provider_dispatched_at = pg_catalog.now(), processing_heartbeat_at = pg_catalog.now(), processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim and provider_dispatched_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return r || pg_catalog.jsonb_build_object('reason', 'fenced');
  end if;
  update public.analysis_jobs set state = 'dispatched', dispatched_at = pg_catalog.now() where id = j.id;
  update public.analysis_spend_ledger
     set state = 'dispatched', dispatched_at = pg_catalog.now(), worker_claim_id = p_claim, units = j.reserved_units, reason = 'dispatched'
   where job_id = j.id and state = 'reserved';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'AJ-LEDGER-1: job % has no reserved ledger row at dispatch', j.id using errcode = 'P0001';
  end if;
  return r || pg_catalog.jsonb_build_object('reason', 'dispatched');
end;
$fn$;

create function public.heartbeat_analysis_job(p_job uuid, p_claim uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
begin
  perform public.analysis_jobs_refuse_override();
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found or j.worker_claim_id is distinct from p_claim
     or not (j.state in ('claimed','dispatched') or (j.state = 'outcome_unknown' and j.outcome_unknown_source = 'classifier')) then
    return false;
  end if;
  update public.swing_analysis
     set processing_heartbeat_at = pg_catalog.now(), processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim
     and processing_heartbeat_at <> '1970-01-01 00:00:00+00'
     and (provider_dispatched_at is null) = (j.state = 'claimed')
     -- an expired undispatched claim is recoverable by acquire, never revived by its old holder
     and (j.state <> 'claimed' or processing_heartbeat_at > pg_catalog.now() - interval '900 seconds');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return false;
  end if;
  if j.state = 'outcome_unknown' then
    update public.analysis_jobs set state = 'dispatched', outcome_unknown_source = null, outcome_unknown_at = null where id = j.id;
    update public.analysis_spend_ledger set state = 'dispatched', reason = 'revived' where job_id = j.id and state = 'held';
  end if;
  return true;
end;
$fn$;

create function public.requeue_undispatched_job(p_job uuid, p_claim uuid, p_policy boolean)
returns text
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  c public.analysis_admission_control;
  j public.analysis_jobs;
  v_rows integer;
  v_exhausted boolean;
begin
  perform public.analysis_jobs_refuse_override();
  select * into c from public.analysis_admission_control where id for share;
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found or j.state <> 'claimed' or j.worker_claim_id is distinct from p_claim then
    return 'fenced';
  end if;
  v_exhausted := not coalesce(p_policy, false) and j.requeue_count + 1 > coalesce(c.max_requeues, 5);
  update public.swing_analysis
     set status = case when v_exhausted then 'failed' else 'pending' end,
         processing_claim_id = null, processing_started_at = null, processing_heartbeat_at = null, provider_dispatched_at = null,
         processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim and provider_dispatched_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return 'fenced';
  end if;
  if v_exhausted then
    update public.analysis_jobs set state = 'failed_definite', failure_kind = 'requeue_exhausted', worker_claim_id = null,
           finished_at = pg_catalog.now()
     where id = j.id;
    update public.analysis_spend_ledger set state = 'released', reason = 'requeue_exhausted', settled_at = pg_catalog.now()
     where job_id = j.id and state = 'reserved';
    return 'exhausted';
  end if;
  update public.analysis_jobs
     set state = 'queued', worker_claim_id = null, worker_id = null,
         requeue_count = j.requeue_count + case when coalesce(p_policy, false) then 0 else 1 end,
         available_at = pg_catalog.now() + case when coalesce(p_policy, false) then interval '30 seconds'
                          else least(interval '900 seconds', interval '30 seconds' * pg_catalog.power(2, j.requeue_count)) end
   where id = j.id;
  return 'requeued';
end;
$fn$;

-- A terminal report from a worker whose job no longer exists (its account or
-- analysis was deleted after dispatch, C2/C3): the held ledger row is settled
-- once, fenced by the claim recorded on it at dispatch.
create function public.analysis_jobs_settle_orphan(p_job uuid, p_claim uuid, p_state text, p_reason text)
returns boolean
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_rows integer;
begin
  update public.analysis_spend_ledger set state = p_state, reason = p_reason, settled_at = pg_catalog.now()
   where job_id = p_job and worker_claim_id = p_claim and state in ('dispatched','held')
     and not exists (select 1 from public.analysis_jobs j where j.id = p_job);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$fn$;

create function public.complete_analysis_job(p_job uuid, p_claim uuid, p_result jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
begin
  perform public.analysis_jobs_refuse_override();
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found then
    if public.analysis_jobs_settle_orphan(p_job, p_claim, 'charged', 'job_deleted_completed') then
      return 'job_gone_settled';
    end if;
    return 'fenced';
  end if;
  -- a retried completion whose first call committed (its answer was lost): the same claim's job already succeeded
  if j.state = 'succeeded' and j.worker_claim_id = p_claim then
    return 'completed';
  end if;
  if j.worker_claim_id is distinct from p_claim
     or not (j.state = 'dispatched' or (j.state = 'outcome_unknown' and j.outcome_unknown_source = 'classifier')) then
    return 'fenced';
  end if;
  if not public.analysis_result_ok(p_result) then
    return 'result_refused';
  end if;
  update public.swing_analysis
     set status = 'complete',
         score = (p_result->>'score')::numeric,
         feedback = p_result->>'feedback',
         spine_angle = (p_result->>'spine_angle')::numeric,
         hip_rotation = (p_result->>'hip_rotation')::numeric,
         shoulder_rotation = (p_result->>'shoulder_rotation')::numeric,
         tempo_ratio = (p_result->>'tempo_ratio')::numeric,
         metrics = p_result->'metrics',
         swing_highlights = p_result->'swing_highlights',
         mechanical_deficiencies = p_result->'mechanical_deficiencies',
         processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim
     and provider_dispatched_at is not null and processing_heartbeat_at <> '1970-01-01 00:00:00+00';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return 'fenced';
  end if;
  update public.analysis_jobs set state = 'succeeded', outcome_unknown_source = null, outcome_unknown_at = null,
         finished_at = pg_catalog.now()
   where id = j.id;
  update public.analysis_spend_ledger set state = 'charged', reason = 'completed', settled_at = pg_catalog.now()
   where job_id = j.id and state in ('dispatched','held');
  return 'completed';
end;
$fn$;

create function public.fail_analysis_job(p_job uuid, p_claim uuid, p_kind text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
  v_dispatched boolean;
begin
  perform public.analysis_jobs_refuse_override();
  if p_kind is null or p_kind not in ('video_unusable','provider_rejected','response_unusable','save_failed') then
    return 'bad_kind';
  end if;
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found then
    if public.analysis_jobs_settle_orphan(p_job, p_claim, case when p_kind = 'provider_rejected' then 'released' else 'charged' end,
                                          'job_deleted_' || p_kind) then
      return 'job_gone_settled';
    end if;
    return 'fenced';
  end if;
  if j.worker_claim_id is distinct from p_claim
     or not (j.state in ('claimed','dispatched') or (j.state = 'outcome_unknown' and j.outcome_unknown_source = 'classifier')) then
    return 'fenced';
  end if;
  v_dispatched := j.state <> 'claimed';
  if v_dispatched then
    update public.swing_analysis set status = 'failed', processing_claim_proof = p_claim
     where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim
       and provider_dispatched_at is not null and processing_heartbeat_at <> '1970-01-01 00:00:00+00';
  else
    update public.swing_analysis
       set status = 'failed', processing_claim_id = null, processing_started_at = null, processing_heartbeat_at = null,
           provider_dispatched_at = null, processing_claim_proof = p_claim
     where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim and provider_dispatched_at is null;
  end if;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return 'fenced';
  end if;
  update public.analysis_jobs set state = 'failed_definite', failure_kind = p_kind, outcome_unknown_source = null,
         outcome_unknown_at = null, finished_at = pg_catalog.now()
   where id = j.id;
  if v_dispatched then
    update public.analysis_spend_ledger
       set state = case when p_kind = 'provider_rejected' then 'released' else 'charged' end, reason = p_kind, settled_at = pg_catalog.now()
     where job_id = j.id and state in ('dispatched','held');
  else
    update public.analysis_spend_ledger set state = 'released', reason = p_kind, settled_at = pg_catalog.now()
     where job_id = j.id and state = 'reserved';
  end if;
  return 'failed';
end;
$fn$;

create function public.mark_job_outcome_unknown(p_job uuid, p_claim uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
begin
  perform public.analysis_jobs_refuse_override();
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found then
    if exists (select 1 from public.analysis_spend_ledger l where l.job_id = p_job and l.worker_claim_id = p_claim and l.state = 'held') then
      return 'job_gone_held';
    end if;
    return 'fenced';
  end if;
  if j.worker_claim_id is distinct from p_claim
     or not (j.state = 'dispatched' or (j.state = 'outcome_unknown' and j.outcome_unknown_source = 'classifier')) then
    return 'fenced';
  end if;
  update public.swing_analysis set processing_heartbeat_at = '1970-01-01 00:00:00+00', processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim
     and provider_dispatched_at is not null and processing_heartbeat_at <> '1970-01-01 00:00:00+00';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return 'fenced';
  end if;
  update public.analysis_jobs set state = 'outcome_unknown', outcome_unknown_source = 'worker', outcome_unknown_at = pg_catalog.now()
   where id = j.id;
  update public.analysis_spend_ledger set state = 'held', reason = 'outcome_unknown' where job_id = j.id and state in ('dispatched','held');
  return 'held';
end;
$fn$;

create function public.cancel_ineligible_job(p_job uuid, p_claim uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
begin
  perform public.analysis_jobs_refuse_override();
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found or j.state <> 'claimed' or j.worker_claim_id is distinct from p_claim then
    return false;
  end if;
  update public.swing_analysis
     set status = 'failed', processing_claim_id = null, processing_started_at = null, processing_heartbeat_at = null,
         provider_dispatched_at = null, processing_claim_proof = p_claim
   where id = j.analysis_id and status = 'processing' and processing_claim_id = p_claim and provider_dispatched_at is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return false;
  end if;
  update public.analysis_jobs set state = 'cancelled_ineligible', failure_kind = 'ineligible', worker_claim_id = null,
         finished_at = pg_catalog.now()
   where id = j.id;
  update public.analysis_spend_ledger set state = 'released', reason = 'ineligible', settled_at = pg_catalog.now()
   where job_id = j.id and state = 'reserved';
  return true;
end;
$fn$;

-- Job state only; the analysis is untouched. The slot stays held (C2).
create function public.classify_stalled_jobs()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
  v_count integer := 0;
  j record;
begin
  perform public.analysis_jobs_refuse_override();
  for j in
    select jj.id from public.analysis_jobs jj join public.swing_analysis s on s.id = jj.analysis_id
     where jj.state = 'dispatched' and s.processing_claim_id = jj.worker_claim_id
       and s.processing_heartbeat_at <= pg_catalog.now() - interval '900 seconds'
     for no key update of jj skip locked
  loop
    update public.analysis_jobs set state = 'outcome_unknown', outcome_unknown_source = 'classifier', outcome_unknown_at = pg_catalog.now()
     where id = j.id;
    update public.analysis_spend_ledger set state = 'held', reason = 'lease_expired' where job_id = j.id and state = 'dispatched';
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$fn$;

-- ── Operator (postgres only; SECURITY INVOKER) ──────────────────────────────
-- Run inside the ENT-1D operator transaction (the override must already be set
-- for this transaction). For an outcome_unknown job: releases the analysis to
-- failed (a dispatched lease is kept as the record), marks the job reconciled
-- and settles the ledger. For a held ledger row whose job is gone: settles it.
create function public.reconcile_analysis_job(p_job uuid, p_outcome text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $fn$
declare
  j public.analysis_jobs;
  v_rows integer;
begin
  if p_outcome is null or p_outcome not in ('charged','released') then
    raise exception 'AJ-RECONCILE-1: outcome must be charged or released' using errcode = 'P0001';
  end if;
  if pg_catalog.current_setting('swingproai.execution_guard', true) is distinct from 'operator_override:' || pg_catalog.txid_current()::text then
    raise exception 'AJ-RECONCILE-2: set the ENT-1D operator override for this transaction first' using errcode = 'P0001';
  end if;
  select * into j from public.analysis_jobs where id = p_job for no key update;
  if not found then
    update public.analysis_spend_ledger set state = p_outcome, reason = 'reconciled_orphan', settled_at = pg_catalog.now()
     where job_id = p_job and state = 'held';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'AJ-RECONCILE-3: no held ledger row for job %', p_job using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('jobId', p_job, 'ledger', p_outcome, 'job', 'gone');
  end if;
  if j.state <> 'outcome_unknown' then
    raise exception 'AJ-RECONCILE-4: job % is %, not outcome_unknown', p_job, j.state using errcode = 'P0001';
  end if;
  update public.swing_analysis set status = 'failed'
   where id = j.analysis_id and status = 'processing' and processing_claim_id = j.worker_claim_id and provider_dispatched_at is not null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'AJ-RECONCILE-5: analysis % is not the stalled holder of job %', j.analysis_id, p_job using errcode = 'P0001';
  end if;
  update public.analysis_jobs set state = 'reconciled', failure_kind = 'reconciled', outcome_unknown_source = null,
         outcome_unknown_at = null, finished_at = pg_catalog.now()
   where id = j.id;
  update public.analysis_spend_ledger set state = p_outcome, reason = 'reconciled', settled_at = pg_catalog.now()
   where job_id = j.id and state in ('held','dispatched');
  return pg_catalog.jsonb_build_object('jobId', p_job, 'ledger', p_outcome, 'job', 'reconciled');
end;
$fn$;

-- ── Triggers ────────────────────────────────────────────────────────────────

-- The job-claim guard (inert until a job exists): a claim, or a claim
-- replacement, on an analysis that has ANY job is refused unless a job of that
-- analysis is 'claimed' with exactly that claim id. Data-bound: no session
-- setting can satisfy it. VOLATILE, so a claim that waited on admission's row
-- lock sees the job admission committed.
create function public.analysis_jobs_claim_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if (old.status is distinct from 'processing' and new.status = 'processing')
     or (new.processing_claim_id is not null and new.processing_claim_id is distinct from old.processing_claim_id) then
    if exists (select 1 from public.analysis_jobs j where j.analysis_id = new.id)
       and not exists (select 1 from public.analysis_jobs j
                        where j.analysis_id = new.id and j.state = 'claimed' and j.worker_claim_id = new.processing_claim_id) then
      raise exception 'JOB-CLAIM-1: analysis % is queued; only its worker may claim it', new.id using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$fn$;

create trigger swing_analysis_job_claim_guard
  before update on public.swing_analysis
  for each row execute function public.analysis_jobs_claim_guard();

-- C3: deleting a job never frees spent or held capacity. A reserved row is
-- released; a dispatched row becomes held (its slot stays occupied); held,
-- charged and released rows are never rewritten. A direct delete of the last
-- job of a live analysis is refused; cascades from account or analysis
-- deletion are allowed. An earlier generation named by a later one is kept by
-- the retry_of_job_id foreign key (job lineage is retained; per-attempt
-- retention is an owner decision).
create function public.analysis_jobs_ledger_on_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if pg_catalog.pg_trigger_depth() = 1
     and exists (select 1 from public.swing_analysis s where s.id = old.analysis_id)
     and not exists (select 1 from public.analysis_jobs j where j.analysis_id = old.analysis_id and j.generation > old.generation) then
    raise exception 'JOB-RETAIN-1: the last job of a live analysis is never deleted' using errcode = 'P0001';
  end if;
  update public.analysis_spend_ledger
     set state = case state when 'reserved' then 'released' else 'held' end,
         reason = 'job_deleted',
         settled_at = case state when 'reserved' then pg_catalog.now() else null end
   where job_id = old.id and state in ('reserved','dispatched');
  return old;
end;
$fn$;

create trigger analysis_jobs_ledger_on_delete
  before delete on public.analysis_jobs
  for each row execute function public.analysis_jobs_ledger_on_delete();

-- ── Ownership, grants, revokes ──────────────────────────────────────────────
grant create on schema public to analysis_jobs_owner;
grant analysis_jobs_owner to postgres with set true, inherit false;

alter table public.analysis_jobs owner to analysis_jobs_owner;
alter table public.analysis_admission_control owner to analysis_jobs_owner;
alter table public.analysis_spend_ledger owner to analysis_jobs_owner;
alter function public.analysis_metrics_values_ok(jsonb) owner to analysis_jobs_owner;
alter function public.analysis_jobs_refuse_override() owner to analysis_jobs_owner;
alter function public.analysis_jobs_attempt_json(public.analysis_jobs) owner to analysis_jobs_owner;
alter function public.analysis_jobs_reply(text, public.analysis_jobs, public.analysis_jobs) owner to analysis_jobs_owner;
alter function public.analysis_jobs_view(uuid, uuid) owner to analysis_jobs_owner;
alter function public.analysis_jobs_caller() owner to analysis_jobs_owner;
alter function public.analysis_jobs_usage(uuid, boolean) owner to analysis_jobs_owner;
alter function public.analysis_jobs_live_slots() owner to analysis_jobs_owner;
alter function public.analysis_result_ok(jsonb) owner to analysis_jobs_owner;
alter function public.analysis_jobs_settle_orphan(uuid, uuid, text, text) owner to analysis_jobs_owner;
alter function public.admit_analysis_job(uuid, uuid, boolean, text, jsonb) owner to analysis_jobs_owner;
alter function public.read_analysis_job_state(uuid) owner to analysis_jobs_owner;
alter function public.read_analysis_job_states(uuid[]) owner to analysis_jobs_owner;
alter function public.acquire_analysis_job(text, text) owner to analysis_jobs_owner;
alter function public.mark_job_dispatched(uuid, uuid, text) owner to analysis_jobs_owner;
alter function public.heartbeat_analysis_job(uuid, uuid) owner to analysis_jobs_owner;
alter function public.requeue_undispatched_job(uuid, uuid, boolean) owner to analysis_jobs_owner;
alter function public.complete_analysis_job(uuid, uuid, jsonb) owner to analysis_jobs_owner;
alter function public.fail_analysis_job(uuid, uuid, text) owner to analysis_jobs_owner;
alter function public.mark_job_outcome_unknown(uuid, uuid) owner to analysis_jobs_owner;
alter function public.cancel_ineligible_job(uuid, uuid) owner to analysis_jobs_owner;
alter function public.classify_stalled_jobs() owner to analysis_jobs_owner;
alter function public.analysis_jobs_claim_guard() owner to analysis_jobs_owner;
alter function public.analysis_jobs_ledger_on_delete() owner to analysis_jobs_owner;

-- As the new owner: remove default and PUBLIC grants, then grant exactly.
set local role analysis_jobs_owner;
revoke all on table public.analysis_jobs, public.analysis_admission_control, public.analysis_spend_ledger
  from public, anon, authenticated, service_role;
revoke all on function
  public.analysis_metrics_values_ok(jsonb), public.analysis_jobs_refuse_override(), public.analysis_jobs_attempt_json(public.analysis_jobs),
  public.analysis_jobs_reply(text, public.analysis_jobs, public.analysis_jobs), public.analysis_jobs_view(uuid, uuid), public.analysis_jobs_caller(), public.analysis_jobs_usage(uuid, boolean),
  public.analysis_jobs_live_slots(), public.analysis_result_ok(jsonb), public.analysis_jobs_settle_orphan(uuid, uuid, text, text),
  public.admit_analysis_job(uuid, uuid, boolean, text, jsonb), public.read_analysis_job_state(uuid),
  public.read_analysis_job_states(uuid[]), public.acquire_analysis_job(text, text), public.mark_job_dispatched(uuid, uuid, text),
  public.heartbeat_analysis_job(uuid, uuid), public.requeue_undispatched_job(uuid, uuid, boolean),
  public.complete_analysis_job(uuid, uuid, jsonb), public.fail_analysis_job(uuid, uuid, text),
  public.mark_job_outcome_unknown(uuid, uuid), public.cancel_ineligible_job(uuid, uuid), public.classify_stalled_jobs(),
  public.analysis_jobs_claim_guard(), public.analysis_jobs_ledger_on_delete()
  from public, anon, authenticated, service_role, postgres;
grant select, update on table public.analysis_jobs, public.analysis_admission_control, public.analysis_spend_ledger to postgres;
grant insert, delete on table public.analysis_admission_control to postgres;
grant delete on table public.analysis_jobs to postgres;
grant execute on function public.analysis_metrics_values_ok(jsonb) to postgres;
grant execute on function public.admit_analysis_job(uuid, uuid, boolean, text, jsonb) to service_role;
grant execute on function public.read_analysis_job_state(uuid), public.read_analysis_job_states(uuid[]) to authenticated;
grant execute on function
  public.acquire_analysis_job(text, text), public.mark_job_dispatched(uuid, uuid, text), public.heartbeat_analysis_job(uuid, uuid),
  public.requeue_undispatched_job(uuid, uuid, boolean), public.complete_analysis_job(uuid, uuid, jsonb),
  public.fail_analysis_job(uuid, uuid, text), public.mark_job_outcome_unknown(uuid, uuid), public.cancel_ineligible_job(uuid, uuid),
  public.classify_stalled_jobs()
  to analysis_worker;
reset role;

revoke all on function public.reconcile_analysis_job(uuid, text) from public, anon, authenticated, service_role, analysis_worker;
grant execute on function public.reconcile_analysis_job(uuid, text) to postgres;

-- The owner's minimal access to existing tables (as their owner, postgres).
grant select on table public.swing_analysis to analysis_jobs_owner;
grant update (status, processing_claim_id, processing_started_at, processing_heartbeat_at, provider_dispatched_at,
              processing_claim_proof, score, feedback, spine_angle, hip_rotation, shoulder_rotation, tempo_ratio,
              metrics, swing_highlights, mechanical_deficiencies)
  on table public.swing_analysis to analysis_jobs_owner;
grant select (id, subscription_tier, subscription_status) on table public.users to analysis_jobs_owner;
grant select (id, user_id, status, storage_path) on table public.swing_videos to analysis_jobs_owner;
grant execute on function public.ent1d_is_canonical_swing_video_key(text, uuid) to analysis_jobs_owner;

-- Policy branch: where the owner could not be given BYPASSRLS.
do $policy_branch$
begin
  if not (select rolbypassrls from pg_catalog.pg_roles where rolname = 'analysis_jobs_owner') then
    execute 'create policy analysis_jobs_owner_read on public.swing_analysis for select to analysis_jobs_owner using (true)';
    execute 'create policy analysis_jobs_owner_write on public.swing_analysis for update to analysis_jobs_owner using (true) with check (true)';
    execute 'create policy analysis_jobs_owner_read on public.users for select to analysis_jobs_owner using (true)';
    execute 'create policy analysis_jobs_owner_read on public.swing_videos for select to analysis_jobs_owner using (true)';
  end if;
end;
$policy_branch$;

revoke analysis_jobs_owner from postgres;
revoke create on schema public from analysis_jobs_owner;

insert into public.analysis_admission_control (id) values (true);

-- ── Postflight (fails closed) ───────────────────────────────────────────────
do $postflight$
declare
  v_owner oid := (select oid from pg_catalog.pg_roles where rolname = 'analysis_jobs_owner');
  v_worker oid := (select oid from pg_catalog.pg_roles where rolname = 'analysis_worker');
  v_pg_super boolean := (select rolsuper from pg_catalog.pg_roles where rolname = 'postgres');
  v_bypass boolean := (select rolbypassrls from pg_catalog.pg_roles where rolname = 'analysis_jobs_owner');
  v_definer text[] := array[
    'admit_analysis_job(uuid,uuid,boolean,text,jsonb)', 'read_analysis_job_state(uuid)', 'read_analysis_job_states(uuid[])',
    'acquire_analysis_job(text,text)', 'mark_job_dispatched(uuid,uuid,text)', 'heartbeat_analysis_job(uuid,uuid)',
    'requeue_undispatched_job(uuid,uuid,boolean)', 'complete_analysis_job(uuid,uuid,jsonb)', 'fail_analysis_job(uuid,uuid,text)',
    'mark_job_outcome_unknown(uuid,uuid)', 'cancel_ineligible_job(uuid,uuid)', 'classify_stalled_jobs()',
    'analysis_jobs_claim_guard()', 'analysis_jobs_ledger_on_delete()'];
  v_worker_fns text[] := array[
    'acquire_analysis_job(text,text)', 'mark_job_dispatched(uuid,uuid,text)', 'heartbeat_analysis_job(uuid,uuid)',
    'requeue_undispatched_job(uuid,uuid,boolean)', 'complete_analysis_job(uuid,uuid,jsonb)', 'fail_analysis_job(uuid,uuid,text)',
    'mark_job_outcome_unknown(uuid,uuid)', 'cancel_ineligible_job(uuid,uuid)', 'classify_stalled_jobs()'];
  v_all_fns text[];
  f text;
  r text;
  t text;
  v_count bigint;
begin
  v_all_fns := v_definer || array['analysis_metrics_values_ok(jsonb)', 'analysis_jobs_refuse_override()', 'analysis_jobs_attempt_json(public.analysis_jobs)',
    'analysis_jobs_reply(text,public.analysis_jobs,public.analysis_jobs)', 'analysis_jobs_view(uuid,uuid)', 'analysis_jobs_caller()', 'analysis_jobs_usage(uuid,boolean)', 'analysis_jobs_live_slots()',
    'analysis_result_ok(jsonb)', 'analysis_jobs_settle_orphan(uuid,uuid,text,text)'];
  -- roles
  if v_owner is null or v_worker is null
     or exists (select 1 from pg_catalog.pg_roles where oid in (v_owner, v_worker) and (rolcanlogin or rolsuper or rolcreaterole or rolcreatedb or rolreplication))
     or (select rolbypassrls from pg_catalog.pg_roles where oid = v_worker) then
    raise exception 'AJ-POST-1: the owner and worker roles must be NOLOGIN, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION (worker NOBYPASSRLS).';
  end if;
  -- memberships: of the owner, only postgres's implicit ADMIN (or none when postgres is a superuser); of the worker, the same
  for t in select unnest(array['analysis_jobs_owner','analysis_worker']) loop
    select pg_catalog.count(*) into v_count from pg_catalog.pg_auth_members m
     where m.roleid = (select oid from pg_catalog.pg_roles where rolname = t);
    if v_pg_super then
      if v_count <> 0 then raise exception 'AJ-POST-2: % has members.', t; end if;
    elsif v_count <> 1 or not exists (select 1 from pg_catalog.pg_auth_members m
                                       where m.roleid = (select oid from pg_catalog.pg_roles where rolname = t)
                                         and m.member = (select oid from pg_catalog.pg_roles where rolname = 'postgres')
                                         and m.admin_option and not m.inherit_option and not m.set_option) then
      raise exception 'AJ-POST-2: % must have exactly postgres''s implicit ADMIN, INHERIT FALSE, SET FALSE membership.', t;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_auth_members m where m.member in (v_owner, v_worker)) then
    raise exception 'AJ-POST-3: the owner or worker role is a member of another role.';
  end if;
  -- ownership and settings
  foreach f in array v_definer loop
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.' || f)
                    and p.prosecdef and p.proowner = v_owner
                    and p.proconfig = case when f in ('read_analysis_job_state(uuid)', 'read_analysis_job_states(uuid[])',
                                                      'analysis_jobs_claim_guard()', 'analysis_jobs_ledger_on_delete()')
                                           then array['search_path=""']
                                           when f = 'mark_job_dispatched(uuid,uuid,text)' then array['search_path=""', 'lock_timeout=2s']
                                           else array['search_path=""', 'lock_timeout=5s'] end
                    and (f in ('analysis_jobs_claim_guard()', 'analysis_jobs_ledger_on_delete()')
                         or pg_catalog.strpos(p.prosrc, 'perform public.analysis_jobs_refuse_override();') > 0)) then
      raise exception 'AJ-POST-4: % must be SECURITY DEFINER, owned by analysis_jobs_owner, with exactly its pinned settings and the override refusal.', f;
    end if;
  end loop;
  foreach f in array v_all_fns loop
    if (select proowner from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.' || f)) is distinct from v_owner then
      raise exception 'AJ-POST-5: % is not owned by analysis_jobs_owner.', f;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.reconcile_analysis_job(uuid,text)')
              and (p.prosecdef or p.proowner <> (select oid from pg_catalog.pg_roles where rolname = 'postgres')
                   or p.proconfig is distinct from array['search_path=""']))
     or pg_catalog.to_regprocedure('public.reconcile_analysis_job(uuid,text)') is null then
    raise exception 'AJ-POST-6: reconcile_analysis_job must be owned by postgres, SECURITY INVOKER, with exactly search_path pinned.';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_class where relname in ('analysis_jobs','analysis_admission_control','analysis_spend_ledger')
        and relnamespace = 'public'::regnamespace and relowner = v_owner and relrowsecurity) <> 3 then
    raise exception 'AJ-POST-7: the three tables must be owned by analysis_jobs_owner with RLS enabled.';
  end if;
  -- function privileges
  foreach f in array v_all_fns loop
    foreach r in array array['anon','authenticated','service_role','analysis_worker'] loop
      if pg_catalog.has_function_privilege(r, 'public.' || f, 'EXECUTE')
         and not (r = 'service_role' and f = 'admit_analysis_job(uuid,uuid,boolean,text,jsonb)')
         and not (r = 'authenticated' and f in ('read_analysis_job_state(uuid)', 'read_analysis_job_states(uuid[])'))
         and not (r = 'analysis_worker' and f = any (v_worker_fns)) then
        raise exception 'AJ-POST-8: % can execute %.', r, f;
      end if;
    end loop;
  end loop;
  foreach f in array v_worker_fns loop
    if not pg_catalog.has_function_privilege('analysis_worker', 'public.' || f, 'EXECUTE') then
      raise exception 'AJ-POST-9: analysis_worker cannot execute %.', f;
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('service_role', 'public.admit_analysis_job(uuid,uuid,boolean,text,jsonb)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.read_analysis_job_state(uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.read_analysis_job_states(uuid[])', 'EXECUTE') then
    raise exception 'AJ-POST-10: the API grants are missing.';
  end if;
  foreach r in array array['anon','authenticated','service_role','analysis_worker','analysis_jobs_owner'] loop
    if pg_catalog.has_function_privilege(r, 'public.reconcile_analysis_job(uuid,text)', 'EXECUTE') then
      raise exception 'AJ-POST-11: % can execute reconcile_analysis_job.', r;
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('postgres', 'public.reconcile_analysis_job(uuid,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('postgres', 'public.analysis_metrics_values_ok(jsonb)', 'EXECUTE') then
    raise exception 'AJ-POST-12: postgres must execute reconcile_analysis_job and analysis_metrics_values_ok.';
  end if;
  -- table privileges
  foreach t in array array['analysis_jobs','analysis_admission_control','analysis_spend_ledger'] loop
    foreach r in array array['anon','authenticated','service_role','analysis_worker'] loop
      if pg_catalog.has_table_privilege(r, 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'AJ-POST-13: % holds a privilege on %.', r, t;
      end if;
    end loop;
    if not pg_catalog.has_table_privilege('postgres', 'public.' || t, 'SELECT') or not pg_catalog.has_table_privilege('postgres', 'public.' || t, 'UPDATE') then
      raise exception 'AJ-POST-14: postgres lacks SELECT, UPDATE on %.', t;
    end if;
  end loop;
  if not pg_catalog.has_table_privilege('postgres', 'public.analysis_admission_control', 'INSERT')
     or not pg_catalog.has_table_privilege('postgres', 'public.analysis_admission_control', 'DELETE')
     or not pg_catalog.has_table_privilege('postgres', 'public.analysis_jobs', 'DELETE') then
    raise exception 'AJ-POST-15: the operator INSERT/DELETE grants are missing.';
  end if;
  -- the owner's access to existing tables: exactly the column lists
  if pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.users', 'SELECT')
     or pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.users', 'email', 'SELECT')
     or not pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.users', 'subscription_tier', 'SELECT')
     or pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.users', 'UPDATE,INSERT,DELETE')
     or pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.swing_videos', 'SELECT')
     or not pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_videos', 'storage_path', 'SELECT')
     or pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_videos', 'original_filename', 'SELECT')
     or pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.swing_videos', 'UPDATE,INSERT,DELETE')
     or not pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.swing_analysis', 'SELECT')
     or pg_catalog.has_table_privilege('analysis_jobs_owner', 'public.swing_analysis', 'INSERT,DELETE,TRUNCATE')
     or pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_analysis', 'user_id', 'UPDATE')
     or pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_analysis', 'swing_video_id', 'UPDATE')
     or pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_analysis', 'putting_score', 'UPDATE')
     or not pg_catalog.has_column_privilege('analysis_jobs_owner', 'public.swing_analysis', 'processing_claim_proof', 'UPDATE') then
    raise exception 'AJ-POST-16: analysis_jobs_owner does not hold exactly its column lists.';
  end if;
  if pg_catalog.has_schema_privilege('analysis_jobs_owner', 'public', 'CREATE') then
    raise exception 'AJ-POST-17: analysis_jobs_owner kept CREATE on schema public.';
  end if;
  -- policies
  if exists (select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class k on k.oid = p.polrelid
              where k.relname in ('analysis_jobs','analysis_admission_control','analysis_spend_ledger') and k.relnamespace = 'public'::regnamespace
                and p.polroles <> array[(select oid from pg_catalog.pg_roles where rolname = 'postgres')]) then
    raise exception 'AJ-POST-18: a policy on the new tables names a role other than postgres.';
  end if;
  if not v_bypass and (select pg_catalog.count(*) from pg_catalog.pg_policy where polname like 'analysis_jobs_owner_%'
                         and polroles = array[v_owner]) <> 4 then
    raise exception 'AJ-POST-19: the policy branch policies are missing.';
  end if;
  if v_bypass and exists (select 1 from pg_catalog.pg_policy where v_owner = any (polroles)) then
    raise exception 'AJ-POST-19: owner policies exist although the owner has BYPASSRLS.';
  end if;
  -- triggers
  if not exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.swing_analysis'::regclass and tgname = 'swing_analysis_job_claim_guard'
                  and tgfoid = 'public.analysis_jobs_claim_guard()'::regprocedure and tgenabled = 'O')
     or not exists (select 1 from pg_catalog.pg_trigger where tgrelid = 'public.analysis_jobs'::regclass and tgname = 'analysis_jobs_ledger_on_delete'
                     and tgfoid = 'public.analysis_jobs_ledger_on_delete()'::regprocedure and tgenabled = 'O') then
    raise exception 'AJ-POST-20: a job trigger is missing, disabled or rebound.';
  end if;
  if (select pg_catalog.count(*) from public.analysis_admission_control) <> 1
     or exists (select 1 from public.analysis_admission_control where execution_mode_full_swing <> 'sync' or admissions_enabled
                 or dispatch_enabled or provider_mode <> 'none' or legacy_failed_admission) then
    raise exception 'AJ-POST-21: the control row is not the default (sync, switches off, provider none).';
  end if;
  -- S1: exact ACLs. Every non-owner grantee/privilege of every M1 object, and every grant the owner holds on the
  -- existing tables, must be exactly the designed set (PUBLIC is grantee 0); a grant option is never designed.
  declare
    v_expect jsonb := pg_catalog.jsonb_build_object(
      'admit_analysis_job(uuid,uuid,boolean,text,jsonb)', '["service_role:EXECUTE"]'::jsonb,
      'read_analysis_job_state(uuid)', '["authenticated:EXECUTE"]'::jsonb,
      'read_analysis_job_states(uuid[])', '["authenticated:EXECUTE"]'::jsonb,
      'analysis_metrics_values_ok(jsonb)', '["postgres:EXECUTE"]'::jsonb,
      'reconcile_analysis_job(uuid,text)', '[]'::jsonb);
    v_got text[];
    v_want text[];
    v_rel text;
  begin
    foreach f in array v_worker_fns loop
      v_expect := v_expect || pg_catalog.jsonb_build_object(f, '["analysis_worker:EXECUTE"]'::jsonb);
    end loop;
    foreach f in array v_all_fns || array['reconcile_analysis_job(uuid,text)'] loop
      if (select proacl from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure('public.' || f)) is null then
        raise exception 'AJ-POST-22: % has the default ACL (PUBLIC EXECUTE).', f;
      end if;
      select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_got from (
        select (case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || case when a.is_grantable then ':WITH GRANT OPTION' else '' end as x
          from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
         where p.oid = pg_catalog.to_regprocedure('public.' || f) and a.grantee <> p.proowner) q;
      select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_want
        from pg_catalog.jsonb_array_elements_text(coalesce(v_expect -> f, '[]'::jsonb)) x;
      if v_got is distinct from v_want then
        raise exception 'AJ-POST-22: % grants % (expected %).', f, v_got, v_want;
      end if;
    end loop;
    foreach t in array array['analysis_jobs','analysis_admission_control','analysis_spend_ledger'] loop
      select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_got from (
        select (case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || case when a.is_grantable then ':WITH GRANT OPTION' else '' end as x
          from pg_catalog.pg_class k, pg_catalog.aclexplode(k.relacl) a
         where k.oid = ('public.' || t)::regclass and a.grantee <> k.relowner) q;
      v_want := case t when 'analysis_jobs' then array['postgres:DELETE','postgres:SELECT','postgres:UPDATE']
                       when 'analysis_admission_control' then array['postgres:DELETE','postgres:INSERT','postgres:SELECT','postgres:UPDATE']
                       else array['postgres:SELECT','postgres:UPDATE'] end;
      if v_got is distinct from v_want then
        raise exception 'AJ-POST-23: public.% grants % (expected %).', t, v_got, v_want;
      end if;
      if exists (select 1 from pg_catalog.pg_attribute where attrelid = ('public.' || t)::regclass and attacl is not null) then
        raise exception 'AJ-POST-23: public.% carries column privileges.', t;
      end if;
    end loop;
    foreach v_rel in array array['swing_analysis','users','swing_videos'] loop
      select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_got from (
        select a.privilege_type || case when a.is_grantable then ':WITH GRANT OPTION' else '' end as x from pg_catalog.pg_class k, pg_catalog.aclexplode(k.relacl) a
         where k.oid = ('public.' || v_rel)::regclass and a.grantee = v_owner
        union all
        select c.attname || ':' || a.privilege_type || case when a.is_grantable then ':WITH GRANT OPTION' else '' end from pg_catalog.pg_attribute c, pg_catalog.aclexplode(c.attacl) a
         where c.attrelid = ('public.' || v_rel)::regclass and a.grantee = v_owner) q;
      v_want := case v_rel
        when 'swing_analysis' then array['SELECT'] || array(select x || ':UPDATE' from pg_catalog.unnest(array[
          'status','processing_claim_id','processing_started_at','processing_heartbeat_at','provider_dispatched_at',
          'processing_claim_proof','score','feedback','spine_angle','hip_rotation','shoulder_rotation','tempo_ratio',
          'metrics','swing_highlights','mechanical_deficiencies']) x)
        when 'users' then array['id:SELECT','subscription_status:SELECT','subscription_tier:SELECT']
        else array['id:SELECT','status:SELECT','storage_path:SELECT','user_id:SELECT'] end;
      select pg_catalog.array_agg(x order by x collate "C") into v_want from pg_catalog.unnest(v_want) x;
      if v_got is distinct from v_want then
        raise exception 'AJ-POST-24: analysis_jobs_owner holds % on public.% (expected %).', v_got, v_rel, v_want;
      end if;
    end loop;
    if pg_catalog.has_schema_privilege('analysis_jobs_owner', 'auth', 'USAGE') then
      raise exception 'AJ-POST-25: analysis_jobs_owner can use schema auth (the read path needs no auth grant).';
    end if;
    if exists (select 1 from pg_catalog.pg_class k, pg_catalog.aclexplode(k.relacl) a where a.grantee = v_worker)
       or exists (select 1 from pg_catalog.pg_attribute c, pg_catalog.aclexplode(c.attacl) a where a.grantee = v_worker)
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                   where a.grantee = v_worker and not (p.oid = any (array(select pg_catalog.to_regprocedure('public.' || w) from pg_catalog.unnest(v_worker_fns) w)))) then
      raise exception 'AJ-POST-26: analysis_worker holds a grant outside its nine worker functions.';
    end if;
  end;
  raise notice 'AJ-POST: passed (owner BYPASSRLS %, postgres superuser %).', v_bypass, v_pg_super;
end;
$postflight$;

notify pgrst, 'reload schema';
