-- ============================================================================
-- SwingProAI — EQ-DESIGNATION-S1 User-Equipment Club-Designation Foundation
-- (Canonical Source Artifact)
-- ============================================================================
--
-- WHAT THIS IS
-- ------------
-- Adds a controlled, nullable club designation to public.user_equipment so a
-- golfer's individual saved clubs stay distinguishable when several of them
-- come from one canonical model family. A golfer owning a 4-iron and a 7-iron
-- from the same set currently produces two user_equipment rows that differ in
-- nothing but their id.
--
-- WHY DESIGNATION LIVES ON user_equipment
-- ---------------------------------------
-- Designation is a property of the golfer's physical club, not of canonical
-- catalog identity. public.equipment_models deliberately remains at its
-- existing model-family x club_type granularity: one row for "PING G440 MAX
-- Fairway", never separate canonical rows for 3W and 5W. Placing designation
-- here keeps catalog identity stable and duplication-free, and matches the
-- recorded rollout contract that loft, shaft flex, shaft weight, club number
-- and retail SKU remain per-golfer customization on user_equipment.
--
-- WHY DECLARATIVE CHECK CONSTRAINTS, NOT THE EXISTING TRIGGER
-- -----------------------------------------------------------
-- public.user_equipment already carries the trigger
-- user_equipment_validate_catalog_reference, which fires
--   before insert or update of manufacturer_id, equipment_model_id, club_type
-- That trigger is column-scoped, so a designation-only UPDATE would never
-- fire it. A table CHECK constraint is re-evaluated on every INSERT and on
-- every UPDATE that produces a new row version, regardless of which columns
-- the statement names, so it protects both a designation-only UPDATE and a
-- club_type change that would invalidate an already-stored designation.
-- The existing trigger and its function are neither replaced nor modified.
--
-- WHY text + CHECK RATHER THAN AN ENUM
-- ------------------------------------
-- This vocabulary is expected to grow (further wood and hybrid numbers, set
-- conventions outside the US market). A CHECK constraint is alterable inside
-- one ordinary transactional migration; enum labels can never be removed or
-- reordered. text + CHECK is also the established local idiom — every
-- controlled vocabulary on public.equipment_putter_model_specs (head_shape,
-- neck_type, toe_hang_class, face_construction, handedness) is expressed
-- exactly this way.
--
-- BACKWARD COMPATIBILITY
-- ----------------------
-- The column is nullable with no default and no generated value. Every
-- existing row therefore holds NULL, which both constraints permit, so the
-- constraint validation scan cannot fail and no historical row is read,
-- rewritten, matched, normalized or backfilled. NULL means "not stated or not
-- applicable" — never "unknown designation" — and stays permanently valid for
-- every club type, including Driver and Putter, which have no non-null
-- designation in V1.
--
-- SCOPE BOUNDARY
-- --------------
-- This migration adds one column and two CHECK constraints. It creates no
-- trigger, no function, no index and no uniqueness constraint; changes no RLS
-- policy, grant or revoke; touches no catalog table; performs no UPDATE,
-- DELETE or backfill; and populates nothing. Golfers may legitimately own
-- duplicate model/designation combinations that differ only in fitting spec,
-- so no uniqueness is imposed on user_equipment.
--
-- This file is the canonical source artifact for that schema change and
-- asserts no application history of its own.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail loud if the target does not match the schema this
-- migration was authored against, or if any planned object already exists.
-- Read-only: this block mutates nothing.
-- ============================================================================
do $$
begin
  if to_regclass('public.user_equipment') is null then
    raise exception 'EQDS1-PRE-1: public.user_equipment does not exist.';
  end if;

  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) then
    raise exception 'EQDS1-PRE-2: public.club_type_enum does not exist.';
  end if;

  if (
    select array_agg(e.enumlabel::text order by e.enumsortorder)
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) is distinct from array['Driver','Wood','Hybrid','Iron','Wedge','Putter'] then
    raise exception 'EQDS1-PRE-3: public.club_type_enum values have changed from the expected six values.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_type' and is_nullable = 'NO'
  ) then
    raise exception 'EQDS1-PRE-4: public.user_equipment.club_type is missing or is no longer NOT NULL.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_designation'
  ) then
    raise exception 'EQDS1-PRE-5: public.user_equipment.club_designation already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment'
      and con.conname = 'user_equipment_club_designation_vocabulary'
  ) then
    raise exception 'EQDS1-PRE-6: constraint user_equipment_club_designation_vocabulary already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment'
      and con.conname = 'user_equipment_club_designation_club_type_compat'
  ) then
    raise exception 'EQDS1-PRE-7: constraint user_equipment_club_designation_club_type_compat already exists.';
  end if;

  raise notice 'EQDS1-PRE-OK: reconciled schema matched, no conflicting objects found — proceeding.';
end $$;

-- ============================================================================
-- 1. The column. Nullable, no default, no generated value, no backfill.
-- ============================================================================

alter table public.user_equipment
  add column club_designation text;

-- ============================================================================
-- 2. Global controlled vocabulary — 28 distinct V1 tokens, or NULL.
--
--    PW appears once and is intentionally shared: real sets ship a pitching
--    wedge as either the last iron or the first wedge, and normalizing one
--    into the other would silently rewrite the golfer's own intent. AW and GW
--    are likewise both permitted; they are the same club under two
--    manufacturer names.
--
--    Driver, Putter, Unknown, Other and Custom are deliberately absent.
--    Driver and Putter carry no non-null designation in V1, and a sentinel
--    string for "unknown" would defeat the purpose of NULL.
-- ============================================================================

alter table public.user_equipment
  add constraint user_equipment_club_designation_vocabulary check (
    club_designation is null
    or club_designation in (
      '2W','3W','4W','5W','7W','9W','11W',
      '1H','2H','3H','4H','5H','6H','7H',
      '1I','2I','3I','4I','5I','6I','7I','8I','9I',
      'PW','AW','GW','SW','LW'
    )
  );

-- ============================================================================
-- 3. Club-type compatibility. Driver and Putter appear in no branch, so any
--    non-null designation on those rows fails without needing a rule of its
--    own. Re-evaluated on every INSERT and on every UPDATE producing a new row
--    version, so a designation-only UPDATE and a club_type change are both
--    covered without involving the column-scoped catalog-reference trigger.
-- ============================================================================

alter table public.user_equipment
  add constraint user_equipment_club_designation_club_type_compat check (
    club_designation is null
    or (club_type = 'Wood'::public.club_type_enum
        and club_designation in ('2W','3W','4W','5W','7W','9W','11W'))
    or (club_type = 'Hybrid'::public.club_type_enum
        and club_designation in ('1H','2H','3H','4H','5H','6H','7H'))
    or (club_type = 'Iron'::public.club_type_enum
        and club_designation in ('1I','2I','3I','4I','5I','6I','7I','8I','9I','PW'))
    or (club_type = 'Wedge'::public.club_type_enum
        and club_designation in ('PW','AW','GW','SW','LW'))
  );

-- ============================================================================
-- POSTFLIGHT — verify through the PostgreSQL catalogs that exactly the
-- intended objects now exist, with the intended nullability and no default.
-- No sample INSERT or UPDATE is performed.
-- ============================================================================
do $$
declare
  v_data_type text;
  v_is_nullable text;
  v_default text;
begin
  select c.data_type, c.is_nullable, c.column_default
    into v_data_type, v_is_nullable, v_default
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'user_equipment'
      and c.column_name = 'club_designation';

  if v_data_type is null then
    raise exception 'EQDS1-POST-1: public.user_equipment.club_designation was not created.';
  end if;

  if v_data_type is distinct from 'text' then
    raise exception 'EQDS1-POST-2: public.user_equipment.club_designation has data_type %, expected text.', v_data_type;
  end if;

  if v_is_nullable is distinct from 'YES' then
    raise exception 'EQDS1-POST-3: public.user_equipment.club_designation is not nullable.';
  end if;

  if v_default is not null then
    raise exception 'EQDS1-POST-4: public.user_equipment.club_designation carries an unexpected default (%).', v_default;
  end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment'
      and con.conname = 'user_equipment_club_designation_vocabulary'
      and con.contype = 'c'
  ) then
    raise exception 'EQDS1-POST-5: user_equipment_club_designation_vocabulary is missing or is not a check constraint.';
  end if;

  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment'
      and con.conname = 'user_equipment_club_designation_club_type_compat'
      and con.contype = 'c'
  ) then
    raise exception 'EQDS1-POST-6: user_equipment_club_designation_club_type_compat is missing or is not a check constraint.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'club_type' and is_nullable = 'NO'
  ) then
    raise exception 'EQDS1-POST-7: public.user_equipment.club_type is no longer NOT NULL.';
  end if;

  raise notice 'EQDS1-POST-OK: club_designation and both check constraints verified.';
end $$;

commit;
