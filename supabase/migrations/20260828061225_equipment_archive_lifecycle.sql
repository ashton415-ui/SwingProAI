-- ============================================================================
-- EQ3-DB1 — equipment archive lifecycle: schema foundation
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Adds exactly one column, public.user_equipment.is_archived, and its comment.
-- Nothing else. No index, no policy, no function, no trigger, no grant, no
-- privilege change, and no row is read, written, or inferred.
--
-- WHY A COLUMN AND NOT A DELETE
-- -----------------------------
-- public.swing_analysis.club_id references public.user_equipment(id) with
-- ON DELETE SET NULL, while swing_analysis_guard_equipment_immutability rejects
-- every post-insert change to club_id. Once an analysis records a club, a hard
-- delete of that club therefore cannot succeed: the referential action would
-- have to null an immutable column. public.swing_telemetry.club_id carries the
-- same referential action with no such guard, so a hard delete there would
-- instead silently discard historical per-club attribution.
--
-- Preserving the row and marking it archived avoids both outcomes. Historical
-- equipment relationships and the immutable equipment_snapshot stay intact.
--
-- HOW THE GUARDS PROVE THAT
-- -------------------------
-- The referential contract above is the entire justification for this column,
-- so it is verified through pg_catalog semantics rather than through deparsed
-- constraint text. Substring matching on pg_get_constraintdef() output cannot
-- distinguish public.user_equipment from a same-named table in another schema,
-- cannot prove the constrained column is exactly club_id, and cannot rule out a
-- composite key that merely includes club_id. Comparing conrelid, confrelid,
-- conkey, confkey and confdeltype against the catalog does prove all of that,
-- and fails closed on anything else.
--
-- SCOPE BOUNDARY
-- --------------
-- This migration is the schema foundation only. No application code reads
-- is_archived yet; consuming it in My Bag, in the saved-club reader, and in the
-- removal action is separately authorized later work, as is any change to
-- DELETE privileges. Existing rows are untouched and therefore remain active,
-- which is the correct reading: nothing has been archived yet.
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail closed if the schema is not exactly what this migration was
-- written against. Schema catalogs only; no application row is read.
-- ============================================================================
do $$
begin
  -- A. The target table exists as an ordinary table.
  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment' and c.relkind = 'r'
  ) then
    raise exception 'EQ3DB1-PRE-1: public.user_equipment does not exist as a table.';
  end if;

  -- B. The column must not already exist, so this migration can never be a
  --    silent no-op over a differently-shaped column.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived'
  ) then
    raise exception 'EQ3DB1-PRE-2: public.user_equipment.is_archived already exists.';
  end if;

  -- C. The updated-at contract this table relies on is intact. Archiving is an
  --    ordinary UPDATE, so the existing timestamp lifecycle must still hold.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'updated_at'
      and data_type = 'timestamp with time zone'
      and is_nullable = 'NO'
  ) then
    raise exception 'EQ3DB1-PRE-3: public.user_equipment.updated_at is not a NOT NULL timestamptz.';
  end if;

  -- D. The trigger that maintains it still exists.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and t.tgname = 'set_updated_at_user_equipment' and not t.tgisinternal
  ) then
    raise exception 'EQ3DB1-PRE-4: trigger set_updated_at_user_equipment is missing on public.user_equipment.';
  end if;

  -- E. The named foreign key exists on exactly the right child relation. This
  --    is separated from the relationship check below so that "the constraint
  --    is gone" and "the constraint no longer means what it meant" stay
  --    distinguishable diagnostics.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      where fk.conname = 'swing_analysis_club_id_fkey'
        and fk.contype = 'f'
        and child_ns.nspname = 'public'
        and child_rel.relname = 'swing_analysis'
  ) then
    raise exception 'EQ3DB1-PRE-5: no foreign-key constraint named swing_analysis_club_id_fkey exists on public.swing_analysis.';
  end if;

  -- F. The relationship itself, proven from the catalog rather than from
  --    deparsed text. Array equality against a one-element array is
  --    deliberate: it proves a single-column key on each side, so a composite
  --    key that merely includes club_id/id fails closed.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.conname = 'swing_analysis_club_id_fkey'
        and fk.contype = 'f'
        and child_ns.nspname = 'public'
        and child_rel.relname = 'swing_analysis'
        and parent_ns.nspname = 'public'
        and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped
        and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB1-PRE-6: swing_analysis_club_id_fkey is not exactly public.swing_analysis.club_id -> public.user_equipment.id as a single-column key with delete action SET NULL (confdeltype n).';
  end if;

  -- G. The immutability guard still exists. This migration does not touch it;
  --    it is verified because the archive design depends on it holding.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'swing_analysis'
      and t.tgname = 'swing_analysis_guard_equipment_immutability' and not t.tgisinternal
  ) then
    raise exception 'EQ3DB1-PRE-7: trigger swing_analysis_guard_equipment_immutability is missing on public.swing_analysis.';
  end if;
end
$$;

-- ============================================================================
-- SCHEMA CHANGE — one column, one comment.
-- ============================================================================

alter table public.user_equipment
  add column is_archived boolean not null default false;

comment on column public.user_equipment.is_archived is
  'True when the golfer has removed this club from their active bag. Archived '
  'rows are intended to be excluded by active-bag and selectable-club consumers '
  'rather than deleted, so that historical swing_analysis and swing_telemetry '
  'relationships, and the immutable equipment_snapshot captured with each '
  'analysis, remain intact.';

-- ============================================================================
-- POSTFLIGHT — verify through the catalogs that exactly the intended change
-- took effect and that the surrounding contract is unchanged.
-- ============================================================================
do $$
begin
  -- 1-4. The new column exists with the exact intended physical contract.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived'
  ) then
    raise exception 'EQ3DB1-POST-1: public.user_equipment.is_archived was not added.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived' and data_type = 'boolean'
  ) then
    raise exception 'EQ3DB1-POST-2: public.user_equipment.is_archived is not boolean.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived' and is_nullable = 'NO'
  ) then
    raise exception 'EQ3DB1-POST-3: public.user_equipment.is_archived is not NOT NULL.';
  end if;

  -- The default is compared to the exact canonical deparsed form. On the locked
  -- PostgreSQL 17.6 environments an ordinary boolean column declared with
  -- DEFAULT false deparses through pg_get_expr as exactly false, so a cast, a
  -- wrapping expression, or any other literal fails closed here rather than
  -- passing on a substring resemblance.
  if not exists (
    select 1 from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and a.attname = 'is_archived'
      and pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'
  ) then
    raise exception 'EQ3DB1-POST-4: public.user_equipment.is_archived does not default to exactly false.';
  end if;

  -- 5-6. It is a plain stored column: neither generated nor an identity column.
  if exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and a.attname = 'is_archived'
      and (a.attgenerated <> '' or a.attidentity <> '')
  ) then
    raise exception 'EQ3DB1-POST-5: public.user_equipment.is_archived is generated or an identity column.';
  end if;

  -- 7. The updated-at trigger survived the ALTER.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and t.tgname = 'set_updated_at_user_equipment' and not t.tgisinternal
  ) then
    raise exception 'EQ3DB1-POST-6: trigger set_updated_at_user_equipment is no longer present.';
  end if;

  -- 8. The analysis foreign key still means exactly what preflight proved it
  --    meant. This migration does not alter it; postflight proves preservation,
  --    using the identical catalog-semantic contract rather than a weaker
  --    existence or rendered-text check.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.conname = 'swing_analysis_club_id_fkey'
        and fk.contype = 'f'
        and child_ns.nspname = 'public'
        and child_rel.relname = 'swing_analysis'
        and parent_ns.nspname = 'public'
        and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped
        and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB1-POST-7: swing_analysis_club_id_fkey is no longer exactly public.swing_analysis.club_id -> public.user_equipment.id as a single-column key with delete action SET NULL (confdeltype n).';
  end if;

  -- 9. The immutability guard is untouched.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'swing_analysis'
      and t.tgname = 'swing_analysis_guard_equipment_immutability' and not t.tgisinternal
  ) then
    raise exception 'EQ3DB1-POST-8: trigger swing_analysis_guard_equipment_immutability is no longer present.';
  end if;

  -- The column comment is part of the intended change, so its absence is a
  -- failure rather than a cosmetic difference.
  if coalesce(pg_catalog.col_description(
       (select c.oid from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'user_equipment'),
       (select a.attnum from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'user_equipment'
          and a.attname = 'is_archived')
     ), '') = '' then
    raise exception 'EQ3DB1-POST-9: public.user_equipment.is_archived carries no column comment.';
  end if;
end
$$;

commit;
