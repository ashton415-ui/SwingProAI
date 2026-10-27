-- ============================================================================
-- ENT-1D (1b of 4) — analysis execution claim proof column (inert)
-- ============================================================================
--
-- Why
-- ---
-- The execution guard (20261027120000) must tell a write by the current claim
-- holder from any other write to the same row. A trigger sees only OLD and
-- NEW; it cannot see whether the caller's WHERE clause named the claim. So the
-- holder states its claim IN THE ROW it writes: processing_claim_proof. The
-- guard compares it with the row's current claim and then discards it. It is
-- a per-write token, never stored: a BEFORE trigger nulls it on every insert
-- and update, and a CHECK proves it is null at rest.
--
-- This migration only adds the column and that consuming trigger. It enforces
-- nothing, so applying it changes no behaviour of any application version.
-- It must be applied BEFORE the ENT-1D application that writes the column is
-- deployed (PostgREST refuses a write to a column that does not exist), and
-- after 20261026120000 (the lease). See docs/ENT1D_ROLLOUT_NOTES.md.
--
-- Function
-- --------
-- public.ent1d_swing_analysis_execution_guard() is SECURITY INVOKER with a
-- fixed empty search_path. Trigger functions are not called directly, so
-- EXECUTE is revoked from every API role. 20261027120000 replaces its body
-- (CREATE OR REPLACE) to enforce the claim contract; the trigger stays.
--
-- Rollback (only before 20261027120000, and only after the application no
-- longer writes processing_claim_proof):
--
--   drop trigger swing_analysis_execution_guard on public.swing_analysis;
--   drop function public.ent1d_swing_analysis_execution_guard();
--   alter table public.swing_analysis
--     drop constraint swing_analysis_claim_proof_transient,
--     drop column processing_claim_proof;
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
begin
  if (select count(*) from pg_catalog.pg_attribute
       where attrelid = 'public.swing_analysis'::regclass and not attisdropped
         and attname in ('processing_claim_id', 'processing_started_at', 'processing_heartbeat_at', 'provider_dispatched_at')) <> 4
     or not exists (select 1 from pg_catalog.pg_constraint
                     where conrelid = 'public.swing_analysis'::regclass
                       and conname = 'swing_analysis_processing_claim_shape' and convalidated) then
    raise exception 'ENT1D-PROOF-PRE-1: the execution lease (20261026120000) is not applied.';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute
              where attrelid = 'public.swing_analysis'::regclass and attname = 'processing_claim_proof' and not attisdropped) then
    raise exception 'ENT1D-PROOF-PRE-2: public.swing_analysis.processing_claim_proof already exists.';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ent1d_swing_analysis_execution_guard')
     or exists (select 1 from pg_catalog.pg_trigger
                 where tgrelid = 'public.swing_analysis'::regclass and tgname = 'swing_analysis_execution_guard') then
    raise exception 'ENT1D-PROOF-PRE-3: the execution guard function or trigger already exists.';
  end if;
end;
$preflight$;

alter table public.swing_analysis add column processing_claim_proof uuid;

create function public.ent1d_swing_analysis_execution_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
-- ENT1D-EXECUTION-GUARD-MODE: consume
begin
  new.processing_claim_proof := null;
  return new;
end;
$fn$;

revoke all on function public.ent1d_swing_analysis_execution_guard() from public, anon, authenticated, service_role;

create trigger swing_analysis_execution_guard
  before insert or update on public.swing_analysis
  for each row execute function public.ent1d_swing_analysis_execution_guard();

alter table public.swing_analysis
  add constraint swing_analysis_claim_proof_transient check (processing_claim_proof is null);

do $postflight$
declare
  v_fn oid := 'public.ent1d_swing_analysis_execution_guard()'::regprocedure;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = 'public.swing_analysis'::regclass and attname = 'processing_claim_proof'
                    and atttypid = 'uuid'::regtype and not attnotnull and not attisdropped) then
    raise exception 'ENT1D-PROOF-POST-1: processing_claim_proof is not a nullable uuid column.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.swing_analysis'::regclass and conname = 'swing_analysis_claim_proof_transient'
                    and contype = 'c' and convalidated) then
    raise exception 'ENT1D-PROOF-POST-2: swing_analysis_claim_proof_transient is missing or not validated.';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.swing_analysis'::regclass and tgname = 'swing_analysis_execution_guard'
                    and tgfoid = v_fn and tgenabled = 'O'
                    and (tgtype & 1) = 1      -- row
                    and (tgtype & 2) = 2      -- before
                    and (tgtype & 4) = 4      -- insert
                    and (tgtype & 16) = 16) then  -- update
    raise exception 'ENT1D-PROOF-POST-3: swing_analysis_execution_guard is not an enabled BEFORE INSERT OR UPDATE row trigger.';
  end if;
  if exists (select 1 from pg_catalog.pg_proc where oid = v_fn and (prosecdef or proconfig is distinct from array['search_path=""'])) then
    raise exception 'ENT1D-PROOF-POST-4: the guard function must be SECURITY INVOKER with an empty search_path.';
  end if;
  if pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'ENT1D-PROOF-POST-5: an API role can execute the guard function.';
  end if;
end;
$postflight$;

notify pgrst, 'reload schema';
