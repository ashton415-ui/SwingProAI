-- ============================================================================
-- drills_drill_family_foundation — authoritative mechanical family on the
-- canonical drill catalog
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Exactly one schema change: public.drills gains drill_family, a required
-- text column constrained to 'full_swing' or 'putting', and every drill that
-- already exists is classified from a frozen, hand-verified list of the five
-- known legacy full-swing drills.
--
-- Nothing else. No drill row is created. No putting drill is seeded. No UUID
-- appears anywhere in this file. Row-level security, table privileges,
-- policies, routines, foreign keys, user_drills, automated_prescriptions and
-- swing_analysis are all left exactly as they are.
--
-- WHY A COLUMN AND NOT A CONVENTION
-- ---------------------------------
-- target_metric records which biomechanical fault a drill addresses. It is
-- unconstrained text with no CHECK, no enum and no foreign key, so nothing in
-- the database can stop a putting drill from being stored under a full-swing
-- metric, or the reverse. Family and fault are orthogonal, and only one of
-- them can be the family. Colocating the family with canonical identity means
-- a drill cannot exist without a family, which is what lets a consumer be
-- written to fail closed.
--
-- WHY NOT NULLABLE, AND WHY NO DEFAULT
-- ------------------------------------
-- No drill has an unknown family and no drill belongs to both, so NULL would
-- carry no meaning while reintroducing three-valued logic into every family
-- predicate. A default is worse: a future putting drill inserted without an
-- explicit family would silently become a full-swing drill — well formed,
-- constraint satisfying, and wrong. Omission must fail loudly instead.
--
-- SCOPE BOUNDARY
-- --------------
-- Classification only. The five name/target_metric pairs below are one-time
-- evidence about rows that already exist; they are not a seed list and this
-- migration inserts nothing. After it commits, drill_family is the sole
-- authority on family and no consumer may infer one from a name or a metric.
-- ============================================================================

begin;

-- Strictest lock, taken before anything is read. public.drills is writable by
-- admins, so without this an insert could commit between the legacy-row
-- validation below and the classification that follows it. Held until commit.
lock table public.drills in access exclusive mode;

-- ============================================================================
-- PREFLIGHT — fail closed unless the catalog is exactly the shape this
-- migration was written against. System catalogs plus the drill catalog's own
-- name/target_metric pairs; no other application table is read.
-- ============================================================================
do $$
declare
  v_unexpected text;
  v_count      int;
begin
  -- A. The drill catalog exists as an ordinary table in the expected schema.
  if not exists (
    select 1
      from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'drills'
       and rel.relkind = 'r'
  ) then
    raise exception
      'DRILL-FAMILY-PRE-01: public.drills does not exist as an ordinary table.';
  end if;

  -- B. The column is genuinely new. Re-running this migration, or running it
  --    against a database where some other change already introduced the
  --    column, must abort rather than reconcile two definitions.
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'drills'
       and column_name  = 'drill_family'
  ) then
    raise exception
      'DRILL-FAMILY-PRE-02: public.drills.drill_family already exists.';
  end if;

  -- C. The constraint name is free.
  if exists (
    select 1
      from pg_constraint con
      join pg_class rel      on rel.oid = con.conrelid
      join pg_namespace nsp  on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'drills'
       and con.conname = 'drills_drill_family_check'
  ) then
    raise exception
      'DRILL-FAMILY-PRE-03: constraint drills_drill_family_check already exists.';
  end if;

  -- D. Every drill that already exists is one this migration can classify from
  --    evidence. Zero rows is a valid, expected state — staging has no drills —
  --    so this asserts nothing about how many rows exist, only that every row
  --    present is recognised. An unrecognised drill is not assumed to be a
  --    full-swing drill; it stops the migration.
  select string_agg(format('%L / %L', d.name, d.target_metric), ', ' order by d.name),
         count(*)
    into v_unexpected, v_count
    from public.drills d
   where (d.name, d.target_metric) not in (
           ('One-Piece Takeaway',      'takeaway_connection'),
           ('Pump Drill',              'downswing_path'),
           ('Shaft Plane Stick Drill', 'laid_off_p4'),
           ('Towel Under Arm',         'arm_connection'),
           ('Wall Hip Turn Drill',     'early_extension')
         );

  if v_count > 0 then
    raise exception
      'DRILL-FAMILY-PRE-04: % drill row(s) are outside the frozen legacy set and cannot be classified from evidence: %',
      v_count, v_unexpected;
  end if;
end
$$;

-- ============================================================================
-- COLUMN — added nullable so the rows that already exist can be classified.
-- This nullable state cannot escape: the NOT NULL below runs in the same
-- transaction, and any failure between here and commit rolls the column away
-- entirely. No DEFAULT is given at any point, so no future insert can inherit
-- a family it did not state.
-- ============================================================================
alter table public.drills
  add column drill_family text;

-- ============================================================================
-- CLASSIFICATION — positive, by exact name and target_metric pair. There is no
-- ELSE branch, no COALESCE and no negative predicate: a row this UPDATE does
-- not match keeps NULL and is caught by the assertion below rather than being
-- quietly swept into full_swing. No row is classified 'putting'; the catalog
-- contains no putting drill, and inventing one here would be a seed.
-- ============================================================================
update public.drills
   set drill_family = 'full_swing'
 where (name, target_metric) in (
         ('One-Piece Takeaway',      'takeaway_connection'),
         ('Pump Drill',              'downswing_path'),
         ('Shaft Plane Stick Drill', 'laid_off_p4'),
         ('Towel Under Arm',         'arm_connection'),
         ('Wall Hip Turn Drill',     'early_extension')
       );

-- ============================================================================
-- POST-BACKFILL ASSERTION — positive proof that every row now carries an
-- allowed family, before the constraint or NOT NULL could report it less
-- clearly. NULL is tested explicitly: `not in` alone would never match a NULL
-- and would let an unclassified row through to a confusing later failure.
-- ============================================================================
do $$
declare
  v_bad int;
begin
  select count(*)
    into v_bad
    from public.drills
   where drill_family is null
      or drill_family not in ('full_swing', 'putting');

  if v_bad > 0 then
    raise exception
      'DRILL-FAMILY-POST-01: % drill row(s) have a missing or unsupported drill_family after classification.',
      v_bad;
  end if;
end
$$;

-- ============================================================================
-- AUTHORITY — the value set becomes impossible to violate, including through
-- the admin write path, which no application-side rule could constrain.
-- ============================================================================
alter table public.drills
  add constraint drills_drill_family_check
  check (drill_family in ('full_swing', 'putting'));

alter table public.drills
  alter column drill_family set not null;

comment on column public.drills.drill_family is
  'The mechanical family of golf motion this canonical drill trains: '
  'full_swing or putting. Authoritative and required — a drill''s family is '
  'never inferred from its name or target_metric, which records the '
  'biomechanical fault the drill addresses, not the family. Distinct from '
  'public.swing_analysis.analysis_family, which records the analysis pipeline '
  'a single uploaded swing was routed to from its validated club; that is a '
  'per-analysis routing outcome, this is static catalog metadata. The two '
  'deliberately share a value vocabulary because they describe the same '
  'partition of golf motion, and neither defines the other.';

-- ============================================================================
-- POSTFLIGHT — the committed end state is exactly what was intended: required,
-- text, no default, and constrained to the two-value vocabulary.
-- ============================================================================
do $$
declare
  v_type     text;
  v_nullable text;
  v_default  text;
begin
  select data_type, is_nullable, column_default
    into v_type, v_nullable, v_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'drills'
     and column_name  = 'drill_family';

  if v_type is distinct from 'text' then
    raise exception 'DRILL-FAMILY-POST-02: drill_family is %, expected text.', v_type;
  end if;

  if v_nullable is distinct from 'NO' then
    raise exception 'DRILL-FAMILY-POST-03: drill_family is nullable.';
  end if;

  if v_default is not null then
    raise exception 'DRILL-FAMILY-POST-04: drill_family has default %, expected none.', v_default;
  end if;

  if not exists (
    select 1
      from pg_constraint con
      join pg_class rel     on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'drills'
       and con.conname = 'drills_drill_family_check'
       and con.contype = 'c'
  ) then
    raise exception 'DRILL-FAMILY-POST-05: drills_drill_family_check is missing.';
  end if;
end
$$;

commit;
