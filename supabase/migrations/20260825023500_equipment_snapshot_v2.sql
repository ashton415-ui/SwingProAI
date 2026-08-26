-- ============================================================================
-- SwingProAI — EQ-DESIGNATION D2 Equipment Snapshot V2 (Canonical Source
-- Artifact)
-- ============================================================================
--
-- WHAT THIS IS
-- ------------
-- Replaces public.apply_swing_analysis_equipment_snapshot() so that NEW
-- non-null equipment snapshots are written at schema_version 2 and carry the
-- saved club's nullable club_designation.
--
-- WHY THE DATABASE IS THE ONLY PLACE THIS CAN CHANGE
-- --------------------------------------------------
-- The equipment snapshot has exactly one producer, and it is this trigger
-- function. No application code writes public.swing_analysis.equipment_snapshot
-- at all; the before-insert trigger builds the whole object server-side and
-- unconditionally overwrites any client-supplied value. A TypeScript-only V2
-- would therefore never be emitted by anything. Changing the emitter is the
-- change.
--
-- WHY HISTORICAL SNAPSHOTS ARE UNTOUCHED
-- --------------------------------------
-- This migration performs no UPDATE, DELETE, INSERT or backfill. Rows written
-- before it keep schema_version 1 forever, and
-- guard_swing_analysis_equipment_immutability() already forbids changing
-- club_id, analysis_family or equipment_snapshot after insert. V1 and V2 stay
-- distinguishable by their own schema_version value, which V1 has always
-- carried explicitly — no absence-means-V1 heuristic is needed anywhere.
--
-- WHY DESIGNATION IS COPIED, NEVER DERIVED
-- ----------------------------------------
-- club_designation is copied straight from the saved public.user_equipment row
-- with to_jsonb(). There is no coalesce, no CASE, and no inference from
-- club_type, loft, brand, model, or any free text. A club whose designation is
-- unknown records JSON null, and the key is always present. Inventing a
-- designation would corrupt the evidentiary value of the snapshot, which exists
-- precisely to record what was true at analysis time.
--
-- D1 PHYSICAL PREREQUISITE
-- ------------------------
-- The replacement function dereferences v_equipment.club_designation, so the
-- D1 migration (20260824053500_equipment_user_club_designation.sql) must
-- already be applied in this environment. The preflight below refuses to run
-- otherwise, and validates the SEMANTICS of both D1 CHECK constraints from the
-- PostgreSQL catalogs rather than merely confirming their names exist. It never
-- repairs a missing or drifted prerequisite — it aborts.
--
-- SCOPE BOUNDARY
-- --------------
-- One CREATE OR REPLACE of an existing function. No ALTER TABLE, no new column,
-- no DROP FUNCTION, no trigger created/dropped/altered, no GRANT or REVOKE, no
-- RLS change, no catalog-data change, no data mutation of any kind. The existing
-- trigger keeps pointing at the same function identity, so its privilege state
-- is preserved by replacement.
--
-- This file is the canonical source artifact for that change and asserts no
-- application history of its own.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail loud unless the environment matches the reconciled contract
-- this migration was authored against. Read-only: mutates nothing.
-- ============================================================================
do $$
declare
  v_body text;
begin
  -- A. Base tables.
  if to_regclass('public.user_equipment') is null then
    raise exception 'EQDS2-PRE-1: public.user_equipment does not exist.';
  end if;
  if to_regclass('public.swing_analysis') is null then
    raise exception 'EQDS2-PRE-2: public.swing_analysis does not exist.';
  end if;

  -- B. club_type enum contract still holds (D1 compatibility depends on it).
  if (
    select array_agg(e.enumlabel::text order by e.enumsortorder)
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) is distinct from array['Driver','Wood','Hybrid','Iron','Wedge','Putter'] then
    raise exception 'EQDS2-PRE-3: public.club_type_enum values have changed from the expected six values.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_type' and is_nullable = 'NO'
  ) then
    raise exception 'EQDS2-PRE-4: public.user_equipment.club_type is missing or is no longer NOT NULL.';
  end if;

  -- C/D. D1 physical column, exactly text / nullable / no default.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_designation'
  ) then
    raise exception 'EQDS2-PRE-5: public.user_equipment.club_designation does not exist — apply the D1 migration (20260824053500_equipment_user_club_designation.sql) in this environment first.';
  end if;

  -- A stored/generated or identity column would substitute a computed value for
  -- the golfer's recorded designation, so both are rejected outright. A domain
  -- over text is rejected too: information_schema still reports data_type
  -- 'text' for one, yet it is a distinct type that carries its own constraints
  -- and its own collation.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_designation'
      and data_type = 'text' and is_nullable = 'YES' and column_default is null
      and is_generated = 'NEVER'
      and domain_name is null and domain_schema is null
  ) then
    raise exception 'EQDS2-PRE-6: public.user_equipment.club_designation must be a plain text column — nullable, default-free, never generated, and not a domain.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_designation'
      and identity_generation is not null
  ) then
    raise exception 'EQDS2-PRE-29: public.user_equipment.club_designation must not be an identity column.';
  end if;

  -- E. D1 constraint IDENTITY only. Semantic authority is the whole-expression
  --    comparison against a PostgreSQL-parsed canonical reference, performed
  --    after this block. connoinherit is checked because a structurally
  --    identical NO INHERIT constraint is not the D1 contract.
  if not exists (
    select 1 from pg_constraint con
    where con.conrelid = 'public.user_equipment'::regclass
      and con.conname = 'user_equipment_club_designation_vocabulary'
      and con.contype = 'c' and con.convalidated and not con.connoinherit
  ) then
    raise exception 'EQDS2-PRE-7: user_equipment_club_designation_vocabulary is missing, is not a validated non-inheriting check constraint on public.user_equipment, or was not created by D1.';
  end if;

  if not exists (
    select 1 from pg_constraint con
    where con.conrelid = 'public.user_equipment'::regclass
      and con.conname = 'user_equipment_club_designation_club_type_compat'
      and con.contype = 'c' and con.convalidated and not con.connoinherit
  ) then
    raise exception 'EQDS2-PRE-10: user_equipment_club_designation_club_type_compat is missing, is not a validated non-inheriting check constraint on public.user_equipment, or was not created by D1.';
  end if;

  -- G. The existing snapshot function must be present and must still be the
  --    expected V1 implementation. Refusing to overwrite an unexpected body
  --    prevents this migration from silently clobbering drift or a prior V2.
  if to_regprocedure('public.apply_swing_analysis_equipment_snapshot()') is null then
    raise exception 'EQDS2-PRE-16: public.apply_swing_analysis_equipment_snapshot() does not exist.';
  end if;

  select pg_get_functiondef(p.oid) into v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot';

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot'
      and p.prosecdef = false
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'EQDS2-PRE-17: the existing snapshot function is no longer SECURITY INVOKER with an empty search_path.';
  end if;

  if position('''schema_version'', 1' in v_body) = 0 then
    raise exception 'EQDS2-PRE-18: the existing snapshot function does not emit schema_version 1 — refusing to overwrite an unexpected implementation.';
  end if;
  if position('club_designation' in v_body) > 0 then
    raise exception 'EQDS2-PRE-19: the existing snapshot function already references club_designation — refusing to overwrite a possibly newer implementation.';
  end if;
  if position('user_id is distinct from new.user_id' in v_body) = 0 then
    raise exception 'EQDS2-PRE-20: the existing snapshot function no longer enforces analysis/equipment ownership.';
  end if;
  if position('''putting''' in v_body) = 0 or position('''full_swing''' in v_body) = 0 then
    raise exception 'EQDS2-PRE-21: the existing snapshot function no longer derives analysis_family.';
  end if;

  -- H. Snapshot trigger still bound to that function.
  if not exists (
    select 1 from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis'
      and tg.tgname = 'swing_analysis_apply_equipment_snapshot'
      and p.proname = 'apply_swing_analysis_equipment_snapshot'
      and not tg.tgisinternal
  ) then
    raise exception 'EQDS2-PRE-22: trigger swing_analysis_apply_equipment_snapshot is missing or no longer executes the expected function.';
  end if;

  -- I. Immutability function and trigger still present and untouched by D2.
  if to_regprocedure('public.guard_swing_analysis_equipment_immutability()') is null then
    raise exception 'EQDS2-PRE-23: public.guard_swing_analysis_equipment_immutability() does not exist.';
  end if;
  if not exists (
    select 1 from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis'
      and tg.tgname = 'swing_analysis_guard_equipment_immutability'
      and p.proname = 'guard_swing_analysis_equipment_immutability'
      and not tg.tgisinternal
  ) then
    raise exception 'EQDS2-PRE-24: trigger swing_analysis_guard_equipment_immutability is missing or no longer executes the expected function.';
  end if;

  -- J. Snapshot column and equipment-context consistency constraint.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis'
      and column_name = 'equipment_snapshot'
      and data_type = 'jsonb' and is_nullable = 'YES'
  ) then
    raise exception 'EQDS2-PRE-25: public.swing_analysis.equipment_snapshot must exist as a nullable jsonb column.';
  end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis'
      and con.conname = 'swing_analysis_equipment_context_consistency'
      and con.contype = 'c'
  ) then
    raise exception 'EQDS2-PRE-26: swing_analysis_equipment_context_consistency is missing or is not a check constraint.';
  end if;

  raise notice 'EQDS2-PRE-OK: identity and column contracts verified — proceeding to canonical constraint comparison.';
end $$;

-- ============================================================================
-- CANONICAL REFERENCE RELATION.
--
-- Rather than parse the live constraints ourselves, let PostgreSQL parse the
-- canonical D1 expressions and compare the two deparsed trees in full. Partial
-- inspection — token extraction, branch slicing, or a finite value probe — can
-- always miss an appended disjunct such as `or club_designation = 'ZZZZZZ'`.
-- Whole-expression equality cannot: any extra predicate, wrapped operand,
-- reordered branch, or altered literal produces a different tree and a
-- different rendering.
--
-- The two CHECK expressions below are transcribed verbatim from D1
-- (20260824053500_equipment_user_club_designation.sql) and must stay in lockstep
-- with it; the D2 static test enforces that parity from source.
--
-- This is the single, narrow exception to D2's no-CREATE-TABLE boundary: one
-- transaction-local relation, never populated, dropped at commit and discarded
-- by rollback. No IF NOT EXISTS — a pre-existing object of this name must fail
-- loudly rather than be silently reused.
-- ============================================================================

create temp table eqds2_reference_designation_contract (
  club_designation text,
  club_type public.club_type_enum,

  constraint eqds2_reference_vocabulary check (
    club_designation is null
    or club_designation in (
      '2W','3W','4W','5W','7W','9W','11W',
      '1H','2H','3H','4H','5H','6H','7H',
      '1I','2I','3I','4I','5I','6I','7I','8I','9I',
      'PW','AW','GW','SW','LW'
    )
  ),

  constraint eqds2_reference_club_type_compat check (
    club_designation is null
    or (club_type = 'Wood'::public.club_type_enum
        and club_designation in ('2W','3W','4W','5W','7W','9W','11W'))
    or (club_type = 'Hybrid'::public.club_type_enum
        and club_designation in ('1H','2H','3H','4H','5H','6H','7H'))
    or (club_type = 'Iron'::public.club_type_enum
        and club_designation in ('1I','2I','3I','4I','5I','6I','7I','8I','9I','PW'))
    or (club_type = 'Wedge'::public.club_type_enum
        and club_designation in ('PW','AW','GW','SW','LW'))
  )
) on commit drop;

-- ============================================================================
-- PHYSICAL COLUMN CONTEXT — the deparsed text alone is not sufficient.
--
-- pg_get_expr renders column NAMES, never the collation a column carries. A
-- Var takes its collation from pg_attribute.attcollation, and that collation is
-- what resolves the comparison's inputcollid; an implicitly derived collation
-- is never printed. Two constraints living on relations whose club_designation
-- columns use different collations therefore deparse to identical text while
-- accepting different value sets — a case-insensitive collation on the live
-- column would admit '4i' and 'pw', which are outside the locked vocabulary and
-- would then be copied verbatim into immutable snapshots.
--
-- So the physical context is pinned separately, against the freshly created
-- canonical reference column rather than against a hardcoded collation name:
-- the reference column is plain `text` in this same database, so whatever
-- collation it carries is by definition the canonical context for ordinary D1
-- text here. Deterministic-versus-nondeterministic is deliberately not
-- classified; exact OID equality is the contract.
--
-- Both sides are also pinned to pg_catalog.text outright, which rejects a
-- domain over text, citext, varchar, char, or any other substitute that an
-- information_schema view might render as superficially compatible.
-- ============================================================================
do $$
declare
  v_actual_typid oid;
  v_actual_collation oid;
  v_reference_typid oid;
  v_reference_collation oid;
begin
  select
    (select att.atttypid from pg_attribute att
      where att.attrelid = 'public.user_equipment'::regclass
        and att.attname = 'club_designation'
        and att.attnum > 0 and not att.attisdropped),
    (select att.attcollation from pg_attribute att
      where att.attrelid = 'public.user_equipment'::regclass
        and att.attname = 'club_designation'
        and att.attnum > 0 and not att.attisdropped),
    (select att.atttypid from pg_attribute att
      where att.attrelid = 'pg_temp.eqds2_reference_designation_contract'::regclass
        and att.attname = 'club_designation'
        and att.attnum > 0 and not att.attisdropped),
    (select att.attcollation from pg_attribute att
      where att.attrelid = 'pg_temp.eqds2_reference_designation_contract'::regclass
        and att.attname = 'club_designation'
        and att.attnum > 0 and not att.attisdropped)
    into v_actual_typid, v_actual_collation, v_reference_typid, v_reference_collation;

  -- Fail closed rather than comparing NULLs.
  if v_actual_typid is null or v_actual_collation is null then
    raise exception 'EQDS2-PRE-33: could not resolve the physical attribute for public.user_equipment.club_designation.';
  end if;
  if v_reference_typid is null or v_reference_collation is null then
    raise exception 'EQDS2-PRE-34: could not resolve the physical attribute for the canonical reference column club_designation.';
  end if;

  if v_actual_typid is distinct from 'pg_catalog.text'::regtype
     or v_reference_typid is distinct from 'pg_catalog.text'::regtype
     or v_actual_typid is distinct from v_reference_typid then
    raise exception 'EQDS2-PRE-31: public.user_equipment.club_designation must be exactly pg_catalog.text — a domain, citext, varchar, char, or other substitute type is not the D1 contract. actual=% reference=%', v_actual_typid::regtype, v_reference_typid::regtype;
  end if;

  if v_actual_collation is distinct from v_reference_collation then
    raise exception 'EQDS2-PRE-32: public.user_equipment.club_designation uses a different collation than plain text in this database, so its CHECK constraints could accept values outside the locked vocabulary while deparsing identically. actual=% reference=%', v_actual_collation, v_reference_collation;
  end if;

  raise notice 'EQDS2-PRE-OK-PHYSICAL: club_designation physical type and collation context match the canonical reference.';
end $$;

-- ============================================================================
-- WHOLE-EXPRESSION COMPARISON — the sole semantic authority.
--
-- All four renderings are fetched in one statement so they share a single
-- search_path and snapshot; enum-cast qualification therefore cannot differ
-- between the actual and reference sides. pretty-printing is explicitly off so
-- the output is the deterministic, fully parenthesised form. Nothing derived
-- from the catalog is ever executed — the expressions are compared as data.
--
-- A semantically equivalent but structurally different constraint (reordered
-- branches, reordered IN values, reversed operands) compares unequal and aborts.
-- That is deliberate: tolerating structural variation is how a broader
-- constraint would slip through.
-- ============================================================================
do $$
declare
  v_actual_vocabulary text;
  v_reference_vocabulary text;
  v_actual_compat text;
  v_reference_compat text;
begin
  select
    (select pg_get_expr(con.conbin, con.conrelid, false)
       from pg_constraint con
      where con.conrelid = 'public.user_equipment'::regclass
        and con.conname = 'user_equipment_club_designation_vocabulary'),
    (select pg_get_expr(con.conbin, con.conrelid, false)
       from pg_constraint con
      where con.conrelid = 'pg_temp.eqds2_reference_designation_contract'::regclass
        and con.conname = 'eqds2_reference_vocabulary'),
    (select pg_get_expr(con.conbin, con.conrelid, false)
       from pg_constraint con
      where con.conrelid = 'public.user_equipment'::regclass
        and con.conname = 'user_equipment_club_designation_club_type_compat'),
    (select pg_get_expr(con.conbin, con.conrelid, false)
       from pg_constraint con
      where con.conrelid = 'pg_temp.eqds2_reference_designation_contract'::regclass
        and con.conname = 'eqds2_reference_club_type_compat')
    into v_actual_vocabulary, v_reference_vocabulary, v_actual_compat, v_reference_compat;

  if v_reference_vocabulary is null or v_reference_compat is null then
    raise exception 'EQDS2-PRE-30: the canonical reference constraints were not created as expected on eqds2_reference_designation_contract.';
  end if;

  if v_actual_vocabulary is distinct from v_reference_vocabulary then
    raise exception 'EQDS2-PRE-27: user_equipment_club_designation_vocabulary does not match the canonical D1 expression. actual=% reference=%', v_actual_vocabulary, v_reference_vocabulary;
  end if;

  if v_actual_compat is distinct from v_reference_compat then
    raise exception 'EQDS2-PRE-28: user_equipment_club_designation_club_type_compat does not match the canonical D1 expression. actual=% reference=%', v_actual_compat, v_reference_compat;
  end if;

  raise notice 'EQDS2-PRE-OK-2: both D1 designation constraints match the canonical expressions exactly — proceeding to snapshot V2.';
end $$;

-- ============================================================================
-- Replace the existing snapshot producer in place. Same function identity, so
-- the existing trigger binding and privilege state carry over untouched. The
-- only semantic changes to the emitted object are schema_version 1 -> 2 and the
-- added club_designation key.
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
    where user_equipment.id = new.club_id;

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
-- POSTFLIGHT — verify through the PostgreSQL catalogs that the replacement took
-- effect with its security posture, trigger binding, and V2 contract intact.
-- No sample INSERT or UPDATE is performed.
-- ============================================================================
do $$
declare
  v_body text;
begin
  select pg_get_functiondef(p.oid) into v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot';

  if v_body is null then
    raise exception 'EQDS2-POST-1: public.apply_swing_analysis_equipment_snapshot() is missing after replacement.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_swing_analysis_equipment_snapshot'
      and p.prosecdef = false
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'EQDS2-POST-2: the replaced snapshot function is not SECURITY INVOKER with an empty search_path.';
  end if;

  if position('''schema_version'', 2' in v_body) = 0 then
    raise exception 'EQDS2-POST-3: the replaced snapshot function does not emit schema_version 2.';
  end if;
  if position('''schema_version'', 1' in v_body) > 0 then
    raise exception 'EQDS2-POST-4: the replaced snapshot function still emits schema_version 1.';
  end if;

  if position('''club_designation'', to_jsonb(v_equipment.club_designation)' in v_body) = 0 then
    raise exception 'EQDS2-POST-5: the replaced snapshot function does not copy club_designation directly from the saved club.';
  end if;

  if position('user_id is distinct from new.user_id' in v_body) = 0 then
    raise exception 'EQDS2-POST-6: the replaced snapshot function no longer enforces analysis/equipment ownership.';
  end if;
  if position('''putting''' in v_body) = 0 or position('''full_swing''' in v_body) = 0 then
    raise exception 'EQDS2-POST-7: the replaced snapshot function no longer derives analysis_family.';
  end if;

  if not exists (
    select 1 from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis'
      and tg.tgname = 'swing_analysis_apply_equipment_snapshot'
      and p.proname = 'apply_swing_analysis_equipment_snapshot'
      and not tg.tgisinternal
  ) then
    raise exception 'EQDS2-POST-8: trigger swing_analysis_apply_equipment_snapshot no longer executes the replaced function.';
  end if;

  if not exists (
    select 1 from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis'
      and tg.tgname = 'swing_analysis_guard_equipment_immutability'
      and p.proname = 'guard_swing_analysis_equipment_immutability'
      and not tg.tgisinternal
  ) then
    raise exception 'EQDS2-POST-9: trigger swing_analysis_guard_equipment_immutability was disturbed by this migration.';
  end if;

  raise notice 'EQDS2-POST-OK: snapshot V2 producer verified, trigger bindings and immutability guard intact.';
end $$;

commit;
