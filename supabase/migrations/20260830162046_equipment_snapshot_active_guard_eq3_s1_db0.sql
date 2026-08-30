-- ============================================================================
-- SwingProAI — EQ3-S1 DB0 Active-Equipment Snapshot Guard (Canonical Source
-- Artifact)
-- ============================================================================
--
-- WHAT THIS IS
-- ------------
-- Replaces public.apply_swing_analysis_equipment_snapshot() so the INSERT-time
-- equipment authority accepts only an ACTIVE (non-archived) saved club, and
-- holds a shared row lock on it for the inserting transaction. Two semantic
-- changes, both inside the single equipment lookup:
--
--   A.  and user_equipment.is_archived = false
--   B.  for share
--
-- Nothing else about the producer changes.
--
-- WHY THE DATABASE IS THE ONLY PLACE THIS CAN BE FIXED
-- ----------------------------------------------------
-- EQ3-DB1 added user_equipment.is_archived and every application consumer
-- filters on it, but the snapshot producer was authored three days earlier and
-- has never referenced the column. Existence and ownership are validated at
-- INSERT; lifecycle state is not. An app-only selector cannot make the archive
-- race fail closed: the selector query and the swing_analysis INSERT are
-- separate statements in separate transactions, so an archive committing
-- between them is invisible to the INSERT. Re-querying just before the INSERT
-- narrows the window without closing it, because the re-query and the INSERT
-- take independent READ COMMITTED snapshots.
--
-- WHY THE PREDICATE MUST LIVE INSIDE THE LOCKING SELECT
-- -----------------------------------------------------
-- In READ COMMITTED, when a locking SELECT waits on a concurrently updated row
-- and the updater commits, the select follows the update chain to the newest
-- version and RE-EVALUATES its WHERE clause against it. A row archived while we
-- waited stops matching and is not returned. That re-evaluation is the whole
-- mechanism, and it applies only to the locking select's own predicate — an
-- unpredicated lock followed by a separate IF on v_equipment.is_archived would
-- test the pre-wait tuple and re-open the race.
--
-- WHY FOR SHARE, AND NOT A WEAKER OR STRONGER MODE
-- ------------------------------------------------
-- Removing a club from the bag is an ordinary non-key UPDATE of is_archived,
-- which takes FOR NO KEY UPDATE on the row.
--
--   FOR KEY SHARE      does NOT conflict with FOR NO KEY UPDATE, so an archive
--                      would proceed unblocked and the race would stay open.
--                      This is also why the existing club_id foreign key does
--                      not help: FK enforcement takes exactly FOR KEY SHARE.
--   FOR SHARE          DOES conflict with FOR NO KEY UPDATE, and does NOT
--                      conflict with another FOR SHARE.
--   FOR UPDATE and
--   FOR NO KEY UPDATE  also conflict with the archive, but conflict with
--                      themselves as well, needlessly serialising two
--                      simultaneous analyses of the same club. Neither
--                      statement modifies user_equipment, so claiming an
--                      exclusive lock would misdescribe the intent too.
--
-- FOR SHARE is therefore the weakest mode that blocks the archive and the
-- strongest that leaves concurrent analyses independent.
--
-- NOWAIT and SKIP LOCKED are deliberately absent. NOWAIT would turn a brief,
-- correct wait into a spurious analysis failure; SKIP LOCKED would silently
-- skip the row and reject a legitimate analysis whose competing archive later
-- rolled back. No statement timeout is introduced.
--
-- LOCK DURATION
-- -------------
-- The lock is held only for the short swing_analysis INSERT transaction. The
-- long Gemini call happens afterwards, in /api/analyze-swing, keyed by
-- analysisId; equipment context is already captured and frozen by then.
--
-- WHY THE ERROR MESSAGE IS UNCHANGED
-- ----------------------------------
-- An archived row now falls into the existing generic EQ1S1R inaccessible
-- record branch, alongside missing and RLS-invisible rows. A distinct archived
-- error would let a caller probe another golfer's equipment lifecycle by id, so
-- archive state is deliberately not disclosed.
--
-- WHY RLS IS NOT THE PLACE FOR THIS
-- ---------------------------------
-- The owner policy answers who owns a row, not whether it is active. Folding
-- is_archived into it would hide archived rows from their own owner and break
-- My Bag restore and any archived-history view. Archive authority belongs to
-- the snapshot producer, the one place deciding whether a club may be captured
-- into an immutable analysis context.
--
-- SCOPE BOUNDARY
-- --------------
-- One CREATE OR REPLACE of an existing function. No DROP FUNCTION, no trigger
-- created/dropped/altered, no ALTER TABLE, no new column, no GRANT or REVOKE,
-- no RLS or policy change, no new helper object, no index, no constraint, and
-- no data mutation of any kind. The existing trigger keeps pointing at the same
-- function identity, so ownership and privilege state are preserved by
-- replacement rather than restated.
--
-- HISTORICAL MIGRATIONS ARE NOT EDITED
-- ------------------------------------
-- 20260825023500_equipment_snapshot_v2.sql stays byte-identical. This is a new,
-- later migration; retrofitting the guard into D2 would rewrite history already
-- applied to staging and production.
--
-- This file is the canonical source artifact for that change and asserts no
-- application history of its own.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — prove, through the PostgreSQL catalogs rather than through
-- pretty-printed SQL, that this migration is running against exactly the
-- contract it was written for. Every check aborts the transaction. Nothing here
-- repairs drift; a surprise is a stop, not a fixup.
--
-- PRE-18 and PRE-19 additionally prove the correction has NOT already been
-- applied, so a second application fails loudly instead of silently
-- re-replacing the function.
-- ============================================================================

do $$
declare
  v_fn oid;
  v_guard_fn oid;
  v_src text;
  v_norm text;
  v_ue_id_attnum smallint;
  v_sa_club_attnum smallint;
  v_count integer;
  v_rls boolean;
  v_force boolean;
begin
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'user_equipment' and c.relkind = 'r'
  ) then
    raise exception 'EQ3S1DB0-PRE-1: public.user_equipment is missing or is not an ordinary table.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis' and c.relkind = 'r'
  ) then
    raise exception 'EQ3S1DB0-PRE-2: public.swing_analysis is missing or is not an ordinary table.';
  end if;

  -- The DB1 column this correction depends on, proven physically rather than by
  -- name. A generated or identity column would not behave as a plain archive
  -- flag, so both are rejected explicitly.
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.user_equipment'::regclass
       and a.attname = 'is_archived'
       and a.attnum > 0
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.bool'::regtype
       and a.attnotnull
       and a.attgenerated = ''
       and a.attidentity = ''
       and pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'
  ) then
    raise exception 'EQ3S1DB0-PRE-3: public.user_equipment.is_archived is not exactly boolean NOT NULL DEFAULT false as a plain stored column.';
  end if;

  select a.attnum into v_ue_id_attnum
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.user_equipment'::regclass
     and a.attname = 'id' and a.attnum > 0 and not a.attisdropped;

  if v_ue_id_attnum is null then
    raise exception 'EQ3S1DB0-PRE-4: public.user_equipment.id is missing.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.user_equipment'::regclass
       and c.contype = 'p'
       and c.conkey = array[v_ue_id_attnum]::smallint[]
  ) then
    raise exception 'EQ3S1DB0-PRE-5: public.user_equipment.id is not the exact single-column primary key.';
  end if;

  -- club_id must stay nullable uuid: a null club is a supported analysis, not
  -- an error.
  select a.attnum into v_sa_club_attnum
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.swing_analysis'::regclass
     and a.attname = 'club_id' and a.attnum > 0 and not a.attisdropped
     and a.atttypid = 'pg_catalog.uuid'::regtype
     and not a.attnotnull;

  if v_sa_club_attnum is null then
    raise exception 'EQ3S1DB0-PRE-6: public.swing_analysis.club_id is missing or is not a nullable uuid.';
  end if;

  -- The foreign key proven from attribute numbers and confdeltype rather than
  -- from a deparsed constraint string.
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.swing_analysis'::regclass
       and c.confrelid = 'public.user_equipment'::regclass
       and c.contype = 'f'
       and c.conkey = array[v_sa_club_attnum]::smallint[]
       and c.confkey = array[v_ue_id_attnum]::smallint[]
       and c.confdeltype = 'n'
  ) then
    raise exception 'EQ3S1DB0-PRE-7: the exact swing_analysis.club_id -> user_equipment.id ON DELETE SET NULL foreign key is missing.';
  end if;

  -- The function this migration replaces, by identity and by security posture.
  -- prosecdef is used rather than pg_get_functiondef text, because SECURITY
  -- INVOKER is the default and deparsing omits the words entirely.
  v_fn := to_regprocedure('public.apply_swing_analysis_equipment_snapshot()');
  if v_fn is null then
    raise exception 'EQ3S1DB0-PRE-8: public.apply_swing_analysis_equipment_snapshot() does not exist.';
  end if;

  select count(*) into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot';
  if v_count <> 1 then
    raise exception 'EQ3S1DB0-PRE-9: expected exactly one public.apply_swing_analysis_equipment_snapshot overload, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = v_fn
       and p.pronargs = 0
       and p.prorettype = 'pg_catalog.trigger'::regtype
       and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
  ) then
    raise exception 'EQ3S1DB0-PRE-10: the snapshot producer is not a zero-argument PL/pgSQL trigger function.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = 'postgres'::regrole
  ) then
    raise exception 'EQ3S1DB0-PRE-11: the snapshot producer is not owned by postgres.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef = false
  ) then
    raise exception 'EQ3S1DB0-PRE-12: the snapshot producer is not SECURITY INVOKER (pg_proc.prosecdef is not false).';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = v_fn
       and p.proconfig = array['search_path=""']::text[]
       and p.provolatile = 'v'
       and p.proparallel = 'u'
  ) then
    raise exception 'EQ3S1DB0-PRE-13: the snapshot producer does not carry exactly an empty search_path, volatile volatility and parallel-unsafe safety.';
  end if;

  -- The trigger binding, proven from tgtype bits and tgfoid.
  select count(*) into v_count
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.swing_analysis'::regclass
     and t.tgname = 'swing_analysis_apply_equipment_snapshot'
     and not t.tgisinternal;
  if v_count <> 1 then
    raise exception 'EQ3S1DB0-PRE-14: expected exactly one swing_analysis_apply_equipment_snapshot trigger, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.swing_analysis'::regclass
       and t.tgname = 'swing_analysis_apply_equipment_snapshot'
       and t.tgfoid = v_fn
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) <> 0
       and (t.tgtype & 2) <> 0
       and (t.tgtype & 4) <> 0
  ) then
    raise exception 'EQ3S1DB0-PRE-15: the snapshot trigger is not an enabled BEFORE INSERT FOR EACH ROW trigger bound to the expected function.';
  end if;

  -- The installed body is still the D2/V2 producer. Replacing something else
  -- would silently discard whatever it actually was.
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn;
  v_norm := lower(regexp_replace(v_src, '\s+', ' ', 'g'));

  if position('''schema_version'', 2' in v_norm) = 0
     or position('''club_designation'', to_jsonb(v_equipment.club_designation)' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-PRE-16: the installed snapshot producer is not the V2 emitter (schema_version 2 with a directly copied club_designation).';
  end if;

  if position('v_equipment.user_id is distinct from new.user_id' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-PRE-17: the installed snapshot producer no longer carries its explicit ownership check.';
  end if;

  if position('is_archived' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-PRE-18: the snapshot producer already references is_archived; this correction appears to have been applied already.';
  end if;

  if position('for share' in v_norm) <> 0
     or position('for key share' in v_norm) <> 0
     or position('for no key update' in v_norm) <> 0
     or position('for update' in v_norm) <> 0
     or position('nowait' in v_norm) <> 0
     or position('skip locked' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-PRE-19: the snapshot producer already carries a row-locking clause; this correction appears to have been applied already.';
  end if;

  -- The update-time immutability guard is a separate object this migration must
  -- leave completely alone.
  v_guard_fn := to_regprocedure('public.guard_swing_analysis_equipment_immutability()');
  if v_guard_fn is null then
    raise exception 'EQ3S1DB0-PRE-20: public.guard_swing_analysis_equipment_immutability() does not exist.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.swing_analysis'::regclass
       and t.tgname = 'swing_analysis_guard_equipment_immutability'
       and t.tgfoid = v_guard_fn
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) <> 0
       and (t.tgtype & 2) <> 0
       and (t.tgtype & 16) <> 0
  ) then
    raise exception 'EQ3S1DB0-PRE-21: the equipment immutability guard is not an enabled BEFORE UPDATE FOR EACH ROW trigger bound to the expected function.';
  end if;

  -- The function EXECUTE surface. Neither anon nor authenticated may call the
  -- producer directly; it is reached only as a trigger.
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'EQ3S1DB0-PRE-22: service_role has lost EXECUTE on the snapshot producer.';
  end if;

  if has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'EQ3S1DB0-PRE-23: anon or authenticated unexpectedly holds direct EXECUTE on the snapshot producer.';
  end if;

  -- SELECT ... FOR SHARE requires UPDATE privilege on the locked table in
  -- addition to SELECT. The producer is SECURITY INVOKER, so it runs as the
  -- calling role. Losing UPDATE here would break every authenticated analysis
  -- that names a club, with no obvious connection to a future privilege-hygiene
  -- change; that is why it is guarded rather than assumed. This migration
  -- checks, and never grants.
  if not has_table_privilege('authenticated', 'public.user_equipment', 'SELECT')
     or not has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE') then
    raise exception 'EQ3S1DB0-PRE-24: authenticated lacks SELECT and UPDATE on public.user_equipment, which SELECT ... FOR SHARE requires.';
  end if;

  if not has_table_privilege('service_role', 'public.user_equipment', 'SELECT')
     or not has_table_privilege('service_role', 'public.user_equipment', 'UPDATE') then
    raise exception 'EQ3S1DB0-PRE-25: service_role lacks SELECT and UPDATE on public.user_equipment, which SELECT ... FOR SHARE requires.';
  end if;

  -- The EQ3-DB3 contract. Removal from the bag stays an archive UPDATE, never a
  -- DELETE, and service_role keeps the DELETE that account-deletion cascade
  -- behaviour depends on.
  if has_table_privilege('anon', 'public.user_equipment', 'DELETE')
     or has_table_privilege('authenticated', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3S1DB0-PRE-26: anon or authenticated unexpectedly holds DELETE on public.user_equipment, contradicting EQ3-DB3.';
  end if;

  if not has_table_privilege('service_role', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3S1DB0-PRE-27: service_role has lost DELETE on public.user_equipment.';
  end if;

  -- RLS state and the exact ownership policy. pg_get_expr is called with
  -- pretty = false: the pretty printer drops the outer parentheses, and a
  -- pretty = true comparison fails closed against a policy that has not changed
  -- at all.
  select c.relrowsecurity, c.relforcerowsecurity into v_rls, v_force
    from pg_catalog.pg_class c
   where c.oid = 'public.user_equipment'::regclass;

  if v_rls is not true or v_force is not false then
    raise exception 'EQ3S1DB0-PRE-28: public.user_equipment row-level security is not exactly enabled-and-not-forced.';
  end if;

  select count(*) into v_count
    from pg_catalog.pg_policy p
   where p.polrelid = 'public.user_equipment'::regclass;
  if v_count <> 1 then
    raise exception 'EQ3S1DB0-PRE-29: expected exactly one policy on public.user_equipment, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy p
     where p.polrelid = 'public.user_equipment'::regclass
       and p.polname = 'Users manage own equipment'
       and p.polcmd = '*'
       and p.polpermissive
       and pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'
       and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'
  ) then
    raise exception 'EQ3S1DB0-PRE-30: the ownership policy on public.user_equipment is not exactly the expected permissive FOR ALL (auth.uid() = user_id) contract.';
  end if;

  if not has_table_privilege('authenticated', 'public.swing_analysis', 'INSERT') then
    raise exception 'EQ3S1DB0-PRE-31: authenticated has lost INSERT on public.swing_analysis.';
  end if;

  raise notice 'EQ3S1DB0-PRE-OK: schema, function identity, trigger binding, privileges and RLS all match the expected contract, and the guard is not already present.';
end $$;

-- ============================================================================
-- Replace the existing snapshot producer in place. Same function identity, so
-- the trigger binding, ownership and privilege state carry over untouched. The
-- statement below is the checked-in D2 replacement with exactly two additions
-- inside its equipment lookup: the active-row predicate and the shared lock.
-- ============================================================================

create or replace function public.apply_swing_analysis_equipment_snapshot()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_equipment public.user_equipment%rowtype;
  v_manufacturer public.equipment_manufacturers%rowtype;
  v_model public.equipment_models%rowtype;
  v_has_manufacturer boolean := false;
  v_has_model boolean := false;
begin
  if new.club_id is null then
    new.analysis_family := null;
    new.equipment_snapshot := null;
    return new;
  end if;

  select * into v_equipment
    from public.user_equipment
    where user_equipment.id = new.club_id
      and user_equipment.is_archived = false
    for share;

  if not found then
    raise exception 'EQ1S1R: the selected club_id does not reference an accessible equipment record.';
  end if;

  if v_equipment.user_id is distinct from new.user_id then
    raise exception 'EQ1S1R: the selected club is not owned by this analysis user.';
  end if;

  if v_equipment.club_type = 'Putter' then
    new.analysis_family := 'putting';
  else
    new.analysis_family := 'full_swing';
  end if;

  if v_equipment.manufacturer_id is not null then
    select * into v_manufacturer
      from public.equipment_manufacturers
      where equipment_manufacturers.id = v_equipment.manufacturer_id;
    v_has_manufacturer := found;
  end if;

  if v_equipment.equipment_model_id is not null then
    select * into v_model
      from public.equipment_models
      where equipment_models.id = v_equipment.equipment_model_id;
    v_has_model := found;
  end if;

  -- club_designation is copied by value and is never inferred. When the saved
  -- club has no designation the key is still emitted, as JSON null.
  new.equipment_snapshot := jsonb_build_object(
    'schema_version', 2,
    'captured_at', to_jsonb(now()),
    'equipment_id', to_jsonb(v_equipment.id),
    'club_type', to_jsonb(v_equipment.club_type::text),
    'club_designation', to_jsonb(v_equipment.club_designation),
    'manufacturer', case when v_has_manufacturer then
      jsonb_build_object('id', v_manufacturer.id, 'canonical_name', v_manufacturer.canonical_name, 'slug', v_manufacturer.slug)
      else null end,
    'model', case when v_has_model then
      jsonb_build_object('id', v_model.id, 'canonical_name', v_model.canonical_name, 'slug', v_model.slug, 'model_year', v_model.model_year)
      else null end,
    'entered_brand', to_jsonb(v_equipment.brand),
    'entered_model', to_jsonb(v_equipment.model),
    'custom_club', to_jsonb(v_equipment.custom_club),
    'custom_brand', to_jsonb(v_equipment.custom_brand),
    'custom_model', to_jsonb(v_equipment.custom_model),
    'shaft_flex', to_jsonb(v_equipment.shaft_flex),
    'shaft_weight_grams', to_jsonb(v_equipment.shaft_weight),
    'loft_deg', to_jsonb(v_equipment.loft_deg)
  );

  return new;
end;
$function$;

-- ============================================================================
-- POSTFLIGHT — prove the replacement produced exactly the intended object: the
-- same identity, owner, security posture, search_path and trigger binding it
-- had before, plus precisely the two new lookup elements and no other locking
-- strength. Catalog semantics are preferred over deparsed formatting
-- throughout, and the whole transaction is still open, so any failure here
-- rolls the replacement back.
-- ============================================================================

do $$
declare
  v_fn oid;
  v_guard_fn oid;
  v_src text;
  v_norm text;
  v_key text;
  v_ue_id_attnum smallint;
  v_sa_club_attnum smallint;
  v_count integer;
  v_rls boolean;
  v_force boolean;
begin
  v_fn := to_regprocedure('public.apply_swing_analysis_equipment_snapshot()');
  if v_fn is null then
    raise exception 'EQ3S1DB0-POST-1: public.apply_swing_analysis_equipment_snapshot() no longer exists.';
  end if;

  select count(*) into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot';
  if v_count <> 1 then
    raise exception 'EQ3S1DB0-POST-2: expected exactly one snapshot producer overload after replacement, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = v_fn
       and p.pronargs = 0
       and p.prorettype = 'pg_catalog.trigger'::regtype
       and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
  ) then
    raise exception 'EQ3S1DB0-POST-3: the replaced producer is not a zero-argument PL/pgSQL trigger function.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = 'postgres'::regrole
  ) then
    raise exception 'EQ3S1DB0-POST-4: the replaced producer is no longer owned by postgres.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef = false
  ) then
    raise exception 'EQ3S1DB0-POST-5: the replaced producer is no longer SECURITY INVOKER (pg_proc.prosecdef is not false).';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = v_fn
       and p.proconfig = array['search_path=""']::text[]
       and p.provolatile = 'v'
       and p.proparallel = 'u'
  ) then
    raise exception 'EQ3S1DB0-POST-6: the replaced producer no longer carries exactly an empty search_path, volatile volatility and parallel-unsafe safety.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.swing_analysis'::regclass
       and t.tgname = 'swing_analysis_apply_equipment_snapshot'
       and t.tgfoid = v_fn
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) <> 0
       and (t.tgtype & 2) <> 0
       and (t.tgtype & 4) <> 0
  ) then
    raise exception 'EQ3S1DB0-POST-7: the snapshot trigger is no longer an enabled BEFORE INSERT FOR EACH ROW trigger bound to the replaced function.';
  end if;

  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'EQ3S1DB0-POST-8: service_role no longer holds EXECUTE on the replaced producer.';
  end if;

  if has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'EQ3S1DB0-POST-9: anon or authenticated now holds direct EXECUTE on the replaced producer.';
  end if;

  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn;
  v_norm := lower(regexp_replace(v_src, '\s+', ' ', 'g'));

  -- Adjacency matters as much as presence: the predicate has to be part of the
  -- locking select, because only the locking select's own WHERE clause is
  -- re-evaluated after waiting on a concurrent updater.
  if position(
       'where user_equipment.id = new.club_id and user_equipment.is_archived = false for share;'
       in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-10: the equipment lookup is not exactly the active-row predicate followed by FOR SHARE in the same locking select.';
  end if;

  if position('for key share' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-11: FOR KEY SHARE is present; it does not conflict with the archive UPDATE and would leave the race open.';
  end if;

  if position('for no key update' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-12: FOR NO KEY UPDATE is present; it is stronger than required and serialises concurrent analyses.';
  end if;

  if position('for update' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-13: FOR UPDATE is present; it is stronger than required and serialises concurrent analyses.';
  end if;

  if position('nowait' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-14: NOWAIT is present; brief contention must wait rather than fail the analysis.';
  end if;

  if position('skip locked' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-15: SKIP LOCKED is present; it would silently reject a legitimate analysis.';
  end if;

  -- The V2 emitter is unchanged in every respect other than the lookup.
  if position('''schema_version'', 2' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-16: the replaced producer no longer emits schema_version 2.';
  end if;

  foreach v_key in array array[
    'schema_version', 'captured_at', 'equipment_id', 'club_type', 'club_designation',
    'manufacturer', 'model', 'entered_brand', 'entered_model', 'custom_club',
    'custom_brand', 'custom_model', 'shaft_flex', 'shaft_weight_grams', 'loft_deg'
  ] loop
    if position('''' || v_key || '''' in v_norm) = 0 then
      raise exception 'EQ3S1DB0-POST-17: the V2 snapshot key % is missing from the replaced producer.', v_key;
    end if;
  end loop;

  if position('''club_designation'', to_jsonb(v_equipment.club_designation)' in v_norm) = 0
     or position('coalesce' in v_norm) <> 0 then
    raise exception 'EQ3S1DB0-POST-18: club_designation is no longer a direct copy, or inference was introduced.';
  end if;

  if position('if new.club_id is null then' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-19: the null club_id path was lost.';
  end if;

  if position('v_equipment.user_id is distinct from new.user_id' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-20: the explicit ownership check was lost.';
  end if;

  if position('v_equipment.club_type = ''putter''' in v_norm) = 0
     or position('''putting''' in v_norm) = 0
     or position('''full_swing''' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-21: the Putter-to-putting / otherwise-full_swing analysis-family mapping was lost.';
  end if;

  if position('does not reference an accessible equipment record' in v_norm) = 0 then
    raise exception 'EQ3S1DB0-POST-22: the generic inaccessible-record exception was lost; archive state must not be disclosed through a distinct error.';
  end if;

  -- Nothing outside the function may have moved. These repeat the preflight
  -- shape deliberately: the point is to prove this migration changed only the
  -- function body, not merely that the environment was correct beforehand.
  select a.attnum into v_ue_id_attnum
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.user_equipment'::regclass
     and a.attname = 'id' and a.attnum > 0 and not a.attisdropped;

  select a.attnum into v_sa_club_attnum
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.swing_analysis'::regclass
     and a.attname = 'club_id' and a.attnum > 0 and not a.attisdropped
     and a.atttypid = 'pg_catalog.uuid'::regtype
     and not a.attnotnull;

  if v_ue_id_attnum is null or v_sa_club_attnum is null then
    raise exception 'EQ3S1DB0-POST-23: user_equipment.id or the nullable uuid swing_analysis.club_id is no longer present as expected.';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.user_equipment'::regclass
       and a.attname = 'is_archived'
       and a.attnum > 0
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.bool'::regtype
       and a.attnotnull
       and a.attgenerated = ''
       and a.attidentity = ''
       and pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'
  ) then
    raise exception 'EQ3S1DB0-POST-24: public.user_equipment.is_archived is no longer exactly boolean NOT NULL DEFAULT false as a plain stored column.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conrelid = 'public.swing_analysis'::regclass
       and c.confrelid = 'public.user_equipment'::regclass
       and c.contype = 'f'
       and c.conkey = array[v_sa_club_attnum]::smallint[]
       and c.confkey = array[v_ue_id_attnum]::smallint[]
       and c.confdeltype = 'n'
  ) then
    raise exception 'EQ3S1DB0-POST-25: the swing_analysis.club_id -> user_equipment.id ON DELETE SET NULL foreign key changed.';
  end if;

  select c.relrowsecurity, c.relforcerowsecurity into v_rls, v_force
    from pg_catalog.pg_class c
   where c.oid = 'public.user_equipment'::regclass;

  if v_rls is not true or v_force is not false then
    raise exception 'EQ3S1DB0-POST-26: public.user_equipment row-level security is no longer exactly enabled-and-not-forced.';
  end if;

  select count(*) into v_count
    from pg_catalog.pg_policy p
   where p.polrelid = 'public.user_equipment'::regclass;
  if v_count <> 1 then
    raise exception 'EQ3S1DB0-POST-27: the policy count on public.user_equipment changed; expected exactly 1, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy p
     where p.polrelid = 'public.user_equipment'::regclass
       and p.polname = 'Users manage own equipment'
       and p.polcmd = '*'
       and p.polpermissive
       and pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'
       and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'
  ) then
    raise exception 'EQ3S1DB0-POST-28: the ownership policy on public.user_equipment changed. Archive state is enforced by the snapshot producer, never by the policy.';
  end if;

  if has_table_privilege('anon', 'public.user_equipment', 'DELETE')
     or has_table_privilege('authenticated', 'public.user_equipment', 'DELETE')
     or not has_table_privilege('service_role', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3S1DB0-POST-29: the EQ3-DB3 equipment DELETE privilege contract changed.';
  end if;

  if not has_table_privilege('authenticated', 'public.user_equipment', 'SELECT')
     or not has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE')
     or not has_table_privilege('service_role', 'public.user_equipment', 'SELECT')
     or not has_table_privilege('service_role', 'public.user_equipment', 'UPDATE') then
    raise exception 'EQ3S1DB0-POST-30: the SELECT + UPDATE privileges that SELECT ... FOR SHARE requires are no longer held by authenticated and service_role.';
  end if;

  if not has_table_privilege('authenticated', 'public.swing_analysis', 'INSERT') then
    raise exception 'EQ3S1DB0-POST-31: authenticated no longer holds INSERT on public.swing_analysis.';
  end if;

  v_guard_fn := to_regprocedure('public.guard_swing_analysis_equipment_immutability()');
  if v_guard_fn is null then
    raise exception 'EQ3S1DB0-POST-32: public.guard_swing_analysis_equipment_immutability() no longer exists.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.swing_analysis'::regclass
       and t.tgname = 'swing_analysis_guard_equipment_immutability'
       and t.tgfoid = v_guard_fn
       and t.tgenabled <> 'D'
       and (t.tgtype & 1) <> 0
       and (t.tgtype & 2) <> 0
       and (t.tgtype & 16) <> 0
  ) then
    raise exception 'EQ3S1DB0-POST-33: the equipment immutability guard trigger changed; DB0 must leave it untouched.';
  end if;

  raise notice 'EQ3S1DB0-POST-OK: the snapshot producer now requires an active equipment row and holds it FOR SHARE, with identity, owner, security posture, trigger binding, privileges, RLS and the immutability guard all unchanged.';
end $$;

commit;
