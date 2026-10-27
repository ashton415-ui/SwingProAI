-- ============================================================================
-- ENT-1D (3 of 4) — analysis execution claim guard (R1b, option C)
-- ============================================================================
--
-- Why
-- ---
-- Application versions older than ENT-1D claim, fail and complete analyses with
-- writes that know nothing of the execution lease ("status-only" writes); the
-- old putting path filters on neither status nor claim. While such code can
-- still run (a deploy overlap, a mistaken rollback), it can overwrite a live
-- ENT-1D claim and let a second model call start (ENT-1D R1b). This guard makes
-- the claim contract a database rule, so those writes are refused instead.
--
-- The contract (BEFORE INSERT OR UPDATE on public.swing_analysis)
-- ---------------------------------------------------------------
-- A trigger sees OLD and NEW, never the caller's WHERE clause, so holder
-- identity cannot be inferred from the statement. The holder proves it in the
-- row: every write it makes to its claimed row sets processing_claim_proof to
-- its claim id (20261026120050). The guard checks the proof against the row's
-- current claim and always discards it.
--
--   insert           a row is born unclaimed and not processing
--   pending|failed   -> processing: only as a CLAIM — a new claim id, a start,
--                    a heartbeat and no dispatch (status-only claims refused)
--   claimed processing row, same claim:
--                    only with proof = current claim (dispatch, heartbeat,
--                    outcome-unknown, release, completion); the row stays
--                    processing or becomes failed or complete; completion
--                    needs a recorded dispatch; a recorded dispatch is never
--                    changed or cleared; a row whose outcome was marked
--                    unknown is not written at all
--   claimed processing row, claim cleared:
--                    only the holder's undispatched release (proof, no
--                    dispatch, leaves processing)
--   claimed processing row, claim replaced:
--                    only a takeover of an UNDISPATCHED claim, to a new
--                    undispatched claim that stays processing
--   lease-less processing row (claimed by pre-lease code):
--                    may only leave processing, with no lease
--   -> complete      only from processing
--   complete         unchanged (a completed result is never rewritten)
--   other rows       the lease may only be kept or cleared entirely
--
-- One carve-out: an update made BY A CASCADE (pg_trigger_depth() > 1: it runs
-- from the foreign-key trigger) whose only change is club_id and/or
-- telemetry_id becoming null is admitted, so an ON DELETE SET NULL cascade from
-- a parent row is never refused. The same change written directly is not.
--
-- What this does NOT establish
-- ----------------------------
-- * Lease expiry. The application decides that a takeover is due (its clock,
--   15-minute lease); the guard only refuses taking over a dispatched claim.
-- * Fencing of new application code in general. The application's WHERE
--   clauses remain the fence; the proof additionally makes a stale holder's
--   writes fail, because its claim is no longer the row's.
-- * Anything about code already running, or about provider spend. A database
--   rule refuses writes; it cannot stop a request that claimed a row before
--   this guard existed from calling the provider, and it cannot stop code that
--   ignores a refused write: the current main-line full-swing route logs a
--   failed processing write and calls the provider anyway. Its state changes
--   are refused; its provider call is not. Old instances, including directly
--   addressable old deployment URLs, must be retired before activation.
--
-- Operator recovery
-- -----------------
-- An explicit setting bound to the operator's own transaction lets a reviewed
-- change through (docs/ENT1D_ROLLOUT_NOTES.md):
--
--   begin;
--   select set_config('swingproai.execution_guard',
--                     'operator_override:' || txid_current(), true);
--   ... the reviewed statement ...
--   commit;
--
-- It is honoured only when the value names the current transaction (a
-- session-level or role-level setting applies only to a transaction whose id
-- it happens to name; the procedure always sets it in that transaction)
-- and only for the database owner roles postgres and supabase_admin (an
-- allow-list: API roles, and any role created later, are refused). Every use
-- is written to the server log.
--
-- Prerequisites (checked; the migration fails closed)
-- ---------------------------------------------------
--   PRE-1  the execution lease (20261026120000)
--   PRE-2  the proof column, its CHECK, and the consuming guard (20261026120050)
--   PRE-3  the result privileges (20261026120100), which require the ENT-1D
--          application to be deployed first. The guard additionally requires
--          that application, because only it writes the proof; no catalog
--          check can see which build is deployed, so that order is a
--          deployment rule (docs/ENT1D_ROLLOUT_NOTES.md).
--
-- Rollback (security-preserving)
-- ------------------------------
-- After this migration, application builds that do not write the proof — every
-- pre-ENT-1D build and earlier ENT-1D candidates — are NOT valid rollback
-- targets: their writes are refused. Roll back only to a build that writes the
-- proof. Deactivating the guard (restoring the consuming body of
-- 20261026120050) is a reviewed migration of its own, and reopens R1b only if
-- old code can run again.
--
-- This migration contains no transaction control; the runner owns the
-- transaction.

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

do $preflight$
declare
  v_fn oid;
  v_src text;
  v_count bigint;
begin
  if (select count(*) from pg_catalog.pg_attribute
       where attrelid = 'public.swing_analysis'::regclass and not attisdropped
         and attname in ('processing_claim_id', 'processing_started_at', 'processing_heartbeat_at', 'provider_dispatched_at')) <> 4
     or not exists (select 1 from pg_catalog.pg_constraint
                     where conrelid = 'public.swing_analysis'::regclass
                       and conname = 'swing_analysis_processing_claim_shape' and convalidated) then
    raise exception 'ENT1D-GUARD-PRE-1: the execution lease (20261026120000) is not applied.';
  end if;

  v_fn := pg_catalog.to_regprocedure('public.ent1d_swing_analysis_execution_guard()');
  if v_fn is null
     or not exists (select 1 from pg_catalog.pg_attribute
                     where attrelid = 'public.swing_analysis'::regclass and attname = 'processing_claim_proof'
                       and atttypid = 'uuid'::regtype and not attisdropped)
     or not exists (select 1 from pg_catalog.pg_constraint
                     where conrelid = 'public.swing_analysis'::regclass
                       and conname = 'swing_analysis_claim_proof_transient' and convalidated)
     or not exists (select 1 from pg_catalog.pg_trigger
                     where tgrelid = 'public.swing_analysis'::regclass and tgname = 'swing_analysis_execution_guard'
                       and tgfoid = v_fn and tgenabled = 'O') then
    raise exception 'ENT1D-GUARD-PRE-2: the claim proof column and its consuming guard (20261026120050) are not applied.';
  end if;
  select prosrc into v_src from pg_catalog.pg_proc where oid = v_fn;
  if pg_catalog.strpos(v_src, 'ENT1D-EXECUTION-GUARD-MODE: consume') = 0 then
    raise exception 'ENT1D-GUARD-PRE-2: the guard function is not the expected consuming version.';
  end if;

  if pg_catalog.has_column_privilege('authenticated', 'public.swing_analysis', 'metrics', 'SELECT') then
    raise exception 'ENT1D-GUARD-PRE-3: the result privileges (20261026120100) are not applied.';
  end if;

  -- Diagnostics: rows this guard will treat specially. Reported, not changed.
  select count(*) into v_count from public.swing_analysis where status = 'processing' and processing_claim_id is null;
  raise notice 'ENT1D-GUARD-DIAG: % processing row(s) without a lease (may only leave processing; operator review).', v_count;
  select count(*) into v_count from public.swing_analysis
   where status = 'processing' and provider_dispatched_at is not null and processing_heartbeat_at = '1970-01-01 00:00:00+00';
  raise notice 'ENT1D-GUARD-DIAG: % processing row(s) with an unknown provider outcome (operator only).', v_count;
  select count(*) into v_count from public.swing_analysis
   where status = 'failed' and processing_claim_id is not null and provider_dispatched_at is null;
  raise notice 'ENT1D-GUARD-DIAG: % failed row(s) still carrying an undispatched lease (R1b artefacts; claimable).', v_count;
end;
$preflight$;

create or replace function public.ent1d_swing_analysis_execution_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
-- ENT1D-EXECUTION-GUARD-MODE: enforce
declare
  v_proof uuid := new.processing_claim_proof;
  v_unknown constant timestamptz := '1970-01-01 00:00:00+00';
  v_new_lease_empty boolean;
begin
  -- The proof is a per-write token: consumed here, never stored.
  new.processing_claim_proof := null;

  -- Operator override: owner roles only, and only for the transaction that set it.
  if current_user in ('postgres', 'supabase_admin')
     and pg_catalog.current_setting('swingproai.execution_guard', true)
         = 'operator_override:' || pg_catalog.txid_current()::text then
    raise log 'ENT1D-GUARD: operator override by % on swing_analysis % (%)',
      current_user, new.id, tg_op;
    return new;
  end if;

  v_new_lease_empty := new.processing_claim_id is null and new.processing_started_at is null
                       and new.processing_heartbeat_at is null and new.provider_dispatched_at is null;

  if tg_op = 'INSERT' then
    if new.status = 'processing' or not v_new_lease_empty then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-1: an analysis is created unclaimed and not processing.';
    end if;
    return new;
  end if;

  -- ON DELETE SET NULL cascades from parent rows are always admitted: the write
  -- comes from the foreign-key trigger (depth > 1) and its only change is
  -- club_id and/or telemetry_id going from a value to null. A direct write of
  -- the same change is not admitted here, and neither is a write that changes
  -- nothing (an old status-only write must still meet the rules below).
  if pg_catalog.pg_trigger_depth() > 1
     and (pg_catalog.to_jsonb(new) - 'processing_claim_proof' - 'club_id' - 'telemetry_id')
       = (pg_catalog.to_jsonb(old) - 'processing_claim_proof' - 'club_id' - 'telemetry_id')
     and ((pg_catalog.to_jsonb(old) -> 'club_id') <> 'null'::jsonb and (pg_catalog.to_jsonb(new) -> 'club_id') = 'null'::jsonb
          or (pg_catalog.to_jsonb(old) -> 'telemetry_id') <> 'null'::jsonb and (pg_catalog.to_jsonb(new) -> 'telemetry_id') = 'null'::jsonb)
     and (pg_catalog.to_jsonb(new) -> 'club_id' = 'null'::jsonb
          or pg_catalog.to_jsonb(new) -> 'club_id' is not distinct from pg_catalog.to_jsonb(old) -> 'club_id')
     and (pg_catalog.to_jsonb(new) -> 'telemetry_id' = 'null'::jsonb
          or pg_catalog.to_jsonb(new) -> 'telemetry_id' is not distinct from pg_catalog.to_jsonb(old) -> 'telemetry_id') then
    return new;
  end if;

  if old.status = 'complete'
     and (pg_catalog.to_jsonb(new) - 'processing_claim_proof') is distinct from (pg_catalog.to_jsonb(old) - 'processing_claim_proof') then
    raise exception using errcode = '23514',
      message = 'ENT1D-CLAIM-2: a completed analysis is never rewritten.';
  end if;
  if new.status = 'complete' and old.status is distinct from 'complete' and old.status is distinct from 'processing' then
    raise exception using errcode = '23514',
      message = 'ENT1D-CLAIM-3: an analysis is completed only from processing.';
  end if;

  if old.status = 'processing' then
    if old.processing_claim_id is null then
      -- Claimed by code that recorded no lease: it may only leave processing.
      if new.status = 'processing' or not v_new_lease_empty then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-4: a processing row without a lease may only leave processing, unclaimed.';
      end if;
      return new;
    end if;

    if new.processing_claim_id is null then
      -- The holder's undispatched release, lease cleared.
      if v_proof is distinct from old.processing_claim_id then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-5: only the current claim holder may write a claimed analysis.';
      end if;
      if old.provider_dispatched_at is not null then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-6: a dispatched claim is never cleared.';
      end if;
      if new.status = 'processing' then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-7: a cleared claim must leave processing.';
      end if;
      return new;
    end if;

    if new.processing_claim_id is distinct from old.processing_claim_id then
      -- A takeover: only of an undispatched claim, to a new undispatched claim.
      if old.provider_dispatched_at is not null then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-8: a dispatched claim is never taken over.';
      end if;
      if new.status is distinct from 'processing' or new.provider_dispatched_at is not null
         or new.processing_started_at is null or new.processing_heartbeat_at is null then
        raise exception using errcode = '23514',
          message = 'ENT1D-CLAIM-9: a takeover is a new, undispatched claim.';
      end if;
      return new;
    end if;

    -- Same claim: the holder's own writes, proved.
    if v_proof is distinct from old.processing_claim_id then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-5: only the current claim holder may write a claimed analysis.';
    end if;
    if old.provider_dispatched_at is not null and old.processing_heartbeat_at = v_unknown then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-10: an analysis whose provider outcome is unknown is changed only by an operator.';
    end if;
    if new.status not in ('processing', 'failed', 'complete') then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-13: a claimed analysis stays processing or becomes failed or complete.';
    end if;
    if new.status = 'complete' and old.provider_dispatched_at is null then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-14: a claimed analysis is completed only after its dispatch was recorded.';
    end if;
    if old.provider_dispatched_at is not null and new.provider_dispatched_at is distinct from old.provider_dispatched_at then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-6: a dispatched claim is never cleared.';
    end if;
    return new;
  end if;

  if new.status = 'processing' then
    if old.status not in ('pending', 'failed')
       or new.processing_claim_id is null
       or new.processing_claim_id is not distinct from old.processing_claim_id
       or new.processing_started_at is null or new.processing_heartbeat_at is null
       or new.provider_dispatched_at is not null then
      raise exception using errcode = '23514',
        message = 'ENT1D-CLAIM-11: an analysis enters processing only by a claim with a new claim id and an undispatched lease.';
    end if;
    return new;
  end if;

  if not v_new_lease_empty
     and (new.processing_claim_id is distinct from old.processing_claim_id
          or new.processing_started_at is distinct from old.processing_started_at
          or new.processing_heartbeat_at is distinct from old.processing_heartbeat_at
          or new.provider_dispatched_at is distinct from old.provider_dispatched_at) then
    raise exception using errcode = '23514',
      message = 'ENT1D-CLAIM-12: outside processing, a lease is only kept or cleared entirely.';
  end if;
  return new;
end;
$fn$;

revoke all on function public.ent1d_swing_analysis_execution_guard() from public, anon, authenticated, service_role;

do $postflight$
declare
  v_fn oid := pg_catalog.to_regprocedure('public.ent1d_swing_analysis_execution_guard()');
begin
  if v_fn is null or pg_catalog.strpos((select prosrc from pg_catalog.pg_proc where oid = v_fn), 'ENT1D-EXECUTION-GUARD-MODE: enforce') = 0 then
    raise exception 'ENT1D-GUARD-POST-1: the guard function is not the enforcing version.';
  end if;
  if exists (select 1 from pg_catalog.pg_proc where oid = v_fn and (prosecdef or proconfig is distinct from array['search_path=""'])) then
    raise exception 'ENT1D-GUARD-POST-2: the guard function must be SECURITY INVOKER with an empty search_path.';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.swing_analysis'::regclass and tgname = 'swing_analysis_execution_guard'
                    and tgfoid = v_fn and tgenabled = 'O'
                    and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 4) = 4 and (tgtype & 16) = 16) then
    raise exception 'ENT1D-GUARD-POST-3: swing_analysis_execution_guard is not an enabled BEFORE INSERT OR UPDATE row trigger.';
  end if;
  if pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'ENT1D-GUARD-POST-4: an API role can execute the guard function.';
  end if;
end;
$postflight$;
