-- ============================================================================
-- ENT-1D (1 of 2) — analysis execution lease
-- ============================================================================
--
-- Why
-- ---
-- POST /api/analyze-swing claims an analysis with one conditional UPDATE so
-- that only one request may call the model. A request that dies after its
-- claim (function timeout, crash, deploy) used to leave the row in
-- 'processing' forever, and nothing could tell a live claim from a dead one.
-- These columns give every claim an identity and a lease, so writes can be
-- fenced to the current holder and an abandoned claim can be recovered without
-- starting a second model call for work that may already have reached it.
--
-- What this migration does
-- ------------------------
-- Adds four nullable columns to public.swing_analysis:
--
--   processing_claim_id      uuid         the current (or last) holder's claim
--   processing_started_at    timestamptz  when that claim was taken
--   processing_heartbeat_at  timestamptz  the holder's last sign of life
--   provider_dispatched_at   timestamptz  when the holder handed the work to
--                                         the model; null = never dispatched
--
-- adds a CHECK keeping the claim fields coherent, and backfills every row that
-- is already 'processing' (see "Existing processing rows").
--
-- The application writes these columns only through the server-only
-- service_role client (lib/analysis-execution-claim.ts). Browser roles are not
-- given them: the companion migration 20261026120100 grants authenticated a
-- column list that excludes them.
--
-- Recovery policy
-- ---------------
-- An expired claim (heartbeat older than the 15-minute lease) is taken over
-- automatically ONLY when provider_dispatched_at is null — no model call can
-- have been made for it. A dispatched claim whose lease expired is "stalled":
-- the provider outcome is unknown, so it is never re-run automatically. So is
-- a 'processing' row with no claim at all: it was taken by code that recorded
-- no lease (for example in the window between this migration and the ENT-1D
-- application deploy).
--
-- Operator runbook (service role, non-routine):
--
--   1. Find stalled analyses:
--        select id, user_id, analysis_family, processing_started_at,
--               processing_heartbeat_at, provider_dispatched_at
--          from public.swing_analysis
--         where status = 'processing'
--           and (processing_claim_id is null
--                or (provider_dispatched_at is not null
--                    and processing_heartbeat_at < now() - interval '15 minutes'));
--   2. Before releasing one, check the provider's request logs and billing for
--      that analysis: a release accepts a possible second provider call.
--   3. Confirm no pre-ENT-1D application deployment is still serving (at
--      least 300 s since the last promotion): a release while old code serves
--      recreates the mixed-version hazard described in docs/ENT1D_ROLLOUT_NOTES.md.
--   4. Release exactly the row inspected, restating every value read in step 1,
--      and require exactly one returned row (zero: inspect again):
--        update public.swing_analysis
--           set status = 'failed'
--         where id = '<analysis id>'
--           and status = 'processing'
--           and processing_claim_id is not distinct from <observed value | NULL>
--           and provider_dispatched_at is not distinct from <observed value | NULL>
--           and processing_heartbeat_at is not distinct from <observed value | NULL>
--           and (processing_claim_id is null
--                or (provider_dispatched_at is not null
--                    and processing_heartbeat_at < now() - interval '15 minutes'))
--        returning id;
--      (An observed null is the bare keyword NULL, never the string 'null'.)
--      Once the execution claim guard (20261027120000) is active, run the
--      release as the database owner inside a transaction that first does
--        select set_config('swingproai.execution_guard',
--                          'operator_override:' || txid_current(), true);
--      the guard refuses an unproved write to a claimed row otherwise.
--      The golfer's next request on that analysis claims it from 'failed' as a
--      fresh attempt. Golfers are told the analysis was interrupted and to
--      record the swing again, so a released row may simply stay 'failed'.
--      Never clear provider_dispatched_at on a row whose outcome is unknown.
--      The full procedure, including the post-deploy check for failed rows that
--      still carry an undispatched lease, is in docs/ENT1D_ROLLOUT_NOTES.md.
--
-- Existing processing rows
-- ------------------------
-- A row already 'processing' when this runs was claimed by code that recorded
-- no lease and no dispatch, so whether its model call happened is unknown.
-- It is backfilled as claimed AND dispatched at migration time: it answers
-- "in progress" for one lease, then "stalled", and is released only by the
-- operator action above. No such row is ever re-run automatically.
--
-- What this migration does NOT do
-- -------------------------------
-- It changes no privilege, policy, trigger, function, existing column or
-- constraint, and writes no other row. It is additive: the application now in
-- production neither reads nor writes these columns, so it may be applied
-- before the ENT-1D application is deployed (and must be: that application
-- writes them). It contains no transaction control; the runner owns the
-- transaction.
--
-- Rollback
-- --------
-- Only after the application has been rolled back to a build that does not
-- write these columns, and only while 20261026120100 is NOT applied (after it,
-- the application may roll back only to an ENT-1C/ENT-1D-compatible build that
-- includes the R1 correction; see docs/ENT1D_ROLLOUT_NOTES.md):
--
--   alter table public.swing_analysis
--     drop constraint swing_analysis_processing_claim_shape,
--     drop column provider_dispatched_at,
--     drop column processing_heartbeat_at,
--     drop column processing_started_at,
--     drop column processing_claim_id;
--
-- This loses lease metadata only. No privilege is involved.

-- ── Lock timeout ─────────────────────────────────────────────────────────────
-- Each lock request below waits at most 3 s. A timeout aborts the runner's
-- transaction with SQLSTATE 55P03, nothing in this file is applied, and the
-- file is safe to retry. SET LOCAL ends with that transaction and never
-- changes the session or role defaults. Outside a transaction SET LOCAL does
-- nothing, so the check below refuses to continue unless the limit is active.

set local lock_timeout = '3s';

do $lock_timeout$
begin
  if pg_catalog.current_setting('lock_timeout') <> '3s' then
    raise exception 'ENT1D-LOCK-TIMEOUT: lock_timeout is %, expected 3s; apply this file inside one transaction.',
      pg_catalog.current_setting('lock_timeout');
  end if;
end;
$lock_timeout$;

-- ── Preflight ───────────────────────────────────────────────────────────────

do $preflight$
begin
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis' and c.relkind = 'r'
  ) then
    raise exception 'ENT1D-LEASE-PRE-1: public.swing_analysis is missing.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.swing_analysis'::regclass
       and a.attname in ('processing_claim_id', 'processing_started_at', 'processing_heartbeat_at', 'provider_dispatched_at')
       and not a.attisdropped
  ) then
    raise exception 'ENT1D-LEASE-PRE-2: an execution-lease column already exists on public.swing_analysis.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.swing_analysis'::regclass
       and a.attname = 'status'
       and a.atttypid = 'text'::regtype
       and a.attnotnull
       and not a.attisdropped
  ) then
    raise exception 'ENT1D-LEASE-PRE-3: public.swing_analysis.status is not the expected not-null text column.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.swing_analysis'::regclass
       and conname = 'swing_analysis_processing_claim_shape'
  ) then
    raise exception 'ENT1D-LEASE-PRE-4: swing_analysis_processing_claim_shape already exists.';
  end if;
end;
$preflight$;

-- ── Columns ─────────────────────────────────────────────────────────────────

alter table public.swing_analysis
  add column processing_claim_id uuid,
  add column processing_started_at timestamptz,
  add column processing_heartbeat_at timestamptz,
  add column provider_dispatched_at timestamptz;

-- ── Existing processing rows: outcome unknown, never re-run automatically ───

update public.swing_analysis
   set processing_claim_id = pg_catalog.gen_random_uuid(),
       processing_started_at = pg_catalog.now(),
       processing_heartbeat_at = pg_catalog.now(),
       provider_dispatched_at = pg_catalog.now()
 where status = 'processing';

-- ── Coherence ───────────────────────────────────────────────────────────────
-- Either the row has never been claimed (all four null), or it carries a claim
-- with its start and heartbeat; dispatch is recorded or not.

alter table public.swing_analysis
  add constraint swing_analysis_processing_claim_shape check (
    (processing_claim_id is null
       and processing_started_at is null
       and processing_heartbeat_at is null
       and provider_dispatched_at is null)
    or
    (processing_claim_id is not null
       and processing_started_at is not null
       and processing_heartbeat_at is not null)
  );

-- ── Postflight ──────────────────────────────────────────────────────────────

do $postflight$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.swing_analysis'::regclass
     and not a.attisdropped
     and not a.attnotnull
     and ((a.attname = 'processing_claim_id' and a.atttypid = 'uuid'::regtype)
       or (a.attname = 'processing_started_at' and a.atttypid = 'timestamptz'::regtype)
       or (a.attname = 'processing_heartbeat_at' and a.atttypid = 'timestamptz'::regtype)
       or (a.attname = 'provider_dispatched_at' and a.atttypid = 'timestamptz'::regtype));
  if v_count <> 4 then
    raise exception 'ENT1D-LEASE-POST-1: expected four nullable execution-lease columns, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.swing_analysis'::regclass
       and conname = 'swing_analysis_processing_claim_shape'
       and contype = 'c'
       and convalidated
  ) then
    raise exception 'ENT1D-LEASE-POST-2: swing_analysis_processing_claim_shape is missing or not validated.';
  end if;

  if exists (
    select 1 from public.swing_analysis
     where status = 'processing'
       and (processing_claim_id is null or provider_dispatched_at is null)
  ) then
    raise exception 'ENT1D-LEASE-POST-3: a processing row was left without a claim and a dispatch mark.';
  end if;
end;
$postflight$;
