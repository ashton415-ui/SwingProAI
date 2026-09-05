-- ============================================================================
-- EQ-S2-C — non-putter canonical equipment catalog expansion v2
--
-- GENERATED FILE — DO NOT HAND-EDIT.
-- Source of truth : data/equipment-catalog-non-putters-v2.json
-- Generator       : scripts/generate-equipment-catalog-non-putters-v2.mjs
--
-- This migration is DATA-ONLY, transactional, append-only and fail-loud. It
-- defines no schema object, changes no existing row and removes nothing. It
-- inserts:
--
--   0   equipment_manufacturers  (all six parents already exist)
--   201 non-putter equipment_models
--   201 equipment_model_sources
--
-- v2 is an ADDITIVE DELTA. The 30 rows of the closed non-putter v1 catalog are
-- already present and are not restated here. The catalog goes from 51 models
-- to 252: 231 non-putters and the untouched 21 putters.
--
-- Identity is deterministic. Every model and source id is an RFC 4122 UUIDv5
-- derived from namespace 05690d1f-f17d-5ab8-a2b6-ef0328a2783a
-- over "model:<catalog_key>" and "source:<catalog_key>:<source_url>". No
-- manufacturer id is ever written as a literal: every model resolves its parent
-- by canonical slug.
--
-- Loft, shaft flex, shaft weight, club number and retail SKU are golfer-level
-- customization on public.user_equipment. They are never canonical identity and
-- appear nowhere in this migration.
--
-- Putter coverage is the closed EQ1-S2 artifact family. This migration adds no
-- Putter row and touches no existing putter row or putter-spec row. It links no
-- user_equipment row to a catalog model.
--
-- EQ-S2-B2 IS A HARD PREREQUISITE. One provenance row uses the
-- official_category_page class, which only exists once B2 has widened the
-- source-type rule to four values. The exact deployed rule is proven before any
-- INSERT and proven again before COMMIT. Neither proof changes it.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- EQ-S2-B2 prerequisite — the live source-type rule must already admit all four provenance classes
--
-- This delta inserts one official_category_page provenance row. That class only
-- became nameable when EQ-S2-B2 widened the source-type CHECK from three values
-- to four. Against a database still carrying the three-value rule the INSERT
-- would fail on a constraint violation with nothing to explain why, so the exact
-- deployed rule is proven here, before any row is written.
--
-- Read-only catalog introspection. This migration never rewrites the rule: it
-- refuses to proceed unless the rule is already exactly the deployed B2 shape.
-- ----------------------------------------------------------------------------

do $$
declare
  v_def       text;
  v_norm      text;
  v_blank     text;
  v_found     text[];
  v_literals  int;
  v_col       text;
  v_expected  text[] := array[
    'official_archive',
    'official_category_page',
    'official_product_page',
    'official_spec_pdf'
  ];
begin
  -- A. The provenance table exists as an ordinary table.
  if not exists (
    select 1 from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and rel.relkind = 'r'
  ) then
    raise exception 'EQ2SC-B2PRE-A: public.equipment_model_sources is missing or is not an ordinary table.';
  end if;

  -- B. Exactly one CHECK constraint governs source_type.
  if (
    select count(*)
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid, false) ~ '\msource_type\M'
  ) <> 1 then
    raise exception 'EQ2SC-B2PRE-B: public.equipment_model_sources does not have exactly one source_type CHECK constraint.';
  end if;

  -- C. That rule carries the exact expected name.
  select pg_get_constraintdef(con.oid, false)
    into v_def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'equipment_model_sources'
     and con.contype = 'c'
     and con.conname = 'equipment_model_sources_type_check';

  if v_def is null then
    raise exception 'EQ2SC-B2PRE-C: constraint equipment_model_sources_type_check is missing. EQ-S2-B2 is not deployed on this database.';
  end if;

  v_norm := btrim(regexp_replace(v_def, '\s+', ' ', 'g'));

  -- D. It is a CHECK expression.
  if v_norm !~ '^CHECK ' then
    raise exception 'EQ2SC-B2PRE-D: the source_type rule is not a CHECK expression. Definition: %', v_norm;
  end if;

  -- E. It is a simple membership predicate.
  if v_norm !~ '= ANY' and v_norm !~ '\mIN\M' then
    raise exception 'EQ2SC-B2PRE-E: the source_type rule is not a simple membership predicate. Definition: %', v_norm;
  end if;

  v_blank := upper(regexp_replace(v_norm, '''[^'']*''', ' ', 'g'));

  -- F. Once the quoted literals are blanked, no further logic remains.
  if v_blank ~ '\mOR\M'
     or v_blank ~ '\mAND\M'
     or v_blank ~ '\mNOT\M'
     or v_blank ~ '\mIS\M'
     or v_blank ~ '\mLIKE\M'
     or v_blank ~ '\mILIKE\M'
     or v_blank ~ '\mSIMILAR\M'
     or v_blank ~ '[<>]'
     or v_blank ~ '!='
     or v_blank ~ '~' then
    raise exception 'EQ2SC-B2PRE-F: the source_type rule carries extra logic beyond simple membership. Definition: %', v_norm;
  end if;

  -- G. source_type is named exactly once, as the governed column.
  if (select count(*) from regexp_matches(v_blank, '\mSOURCE_TYPE\M', 'g')) <> 1 then
    raise exception 'EQ2SC-B2PRE-G: the source_type rule does not reference source_type exactly once. Definition: %', v_norm;
  end if;

  -- H. No second column of the table participates in the rule.
  for v_col in
    select att.attname
      from pg_attribute att
      join pg_class rel on rel.oid = att.attrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and att.attnum > 0
       and not att.attisdropped
       and att.attname <> 'source_type'
  loop
    if v_blank ~ ('\m' || upper(v_col) || '\M') then
      raise exception 'EQ2SC-B2PRE-H: the source_type rule also references column %. Definition: %', v_col, v_norm;
    end if;
  end loop;

  -- I. Exactly four admitted literals are named.
  select count(*) into v_literals
    from regexp_matches(v_norm, '''([^'']*)''', 'g');

  if v_literals <> array_length(v_expected, 1) then
    raise exception 'EQ2SC-B2PRE-I: the source_type rule names % literals, expected %. Definition: %',
      v_literals, array_length(v_expected, 1), v_norm;
  end if;

  select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[])
    into v_found
    from regexp_matches(v_norm, '''([^'']*)''', 'g') as m;

  -- J. No admitted literal is repeated.
  if array_length(v_found, 1) is distinct from v_literals then
    raise exception 'EQ2SC-B2PRE-J: the source_type rule repeats an admitted literal. Definition: %', v_norm;
  end if;

  -- K. The admitted set is exactly the four authorized provenance classes.
  if v_found is distinct from (select array_agg(x order by x) from unnest(v_expected) as x) then
    raise exception 'EQ2SC-B2PRE-K: the source_type rule admits % but exactly % was expected. Definition: %',
      v_found, v_expected, v_norm;
  end if;

  -- L. The sibling provenance rules are present.
  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_url_https'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_verified_not_future'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_model_url_unique'
  ) then
    raise exception 'EQ2SC-B2PRE-L: a sibling constraint on public.equipment_model_sources is missing.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Preconditions — refuse to apply against anything but the exact intended
-- post-v1 / post-B2 foundation.
-- ----------------------------------------------------------------------------

do $$
declare
  v_count bigint;
  v_slugs text[];
  v_enum text[];
  v_i int;
  v_expected_keys text[] := array[
    'callaway/odyssey/ai-one-2-ball-ch/v1',
    'callaway/odyssey/ai-one-rossie-db/v1',
    'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1',
    'callaway/opus-sp/opus-sp-chrome-wedge/v1',
    'callaway/quantum/quantum-max-driver/v1',
    'callaway/quantum/quantum-max-fairway-woods/v1',
    'callaway/quantum/quantum-max-hybrids/v1',
    'callaway/quantum/quantum-max-irons/v1',
    'cobra/king/king-irons/v1',
    'cobra/king/king-wedge/v1',
    'cobra/optm/optm-hybrid/v1',
    'cobra/optm/optm-max-k-driver/v1',
    'cobra/optm/optm-x-fairway/v1',
    'mizuno/jpx-one/jpx-one-driver/v1',
    'mizuno/jpx-one/jpx-one-fairway/v1',
    'mizuno/jpx-one/jpx-one-hybrid/v1',
    'mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1',
    'mizuno/m-craft/kyoto-p/v1',
    'mizuno/m-craft/kyoto-s/v1',
    'mizuno/m-craft/tokyo-b/v1',
    'mizuno/m-craft/tokyo-s/v1',
    'mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1',
    'ping/g440/g440-hybrid/v1',
    'ping/g440/g440-max-driver/v1',
    'ping/g440/g440-max-fairway/v1',
    'ping/i240/i240-irons/v1',
    'ping/pld-milled/anser-2d/v1',
    'ping/pld-milled/anser/v1',
    'ping/s259/s259-wedge/v1',
    'taylormade/mg5/mg5-wedge/v1',
    'taylormade/p790/p790-irons/v1',
    'taylormade/qi35/qi35-driver/v1',
    'taylormade/qi35/qi35-fairway/v1',
    'taylormade/qi35/qi35-rescue/v1',
    'taylormade/spider-tour/spider-tour-double-bend/v1',
    'taylormade/spider-tour/spider-tour-small-slant/v1',
    'taylormade/spider-tour/spider-tour-x-double-bend/v1',
    'taylormade/spider-tour/spider-tour-x-l-neck/v1',
    'taylormade/spider-tour/spider-tour-x-small-slant/v1',
    'titleist/gt2/gt2-driver/v1',
    'titleist/gt2/gt2-fairway/v1',
    'titleist/gt2/gt2-hybrid/v1',
    'titleist/scotty-cameron/phantom-5-2/v1',
    'titleist/scotty-cameron/phantom-5-5/v1',
    'titleist/scotty-cameron/phantom-5-oc/v1',
    'titleist/scotty-cameron/phantom-5/v1',
    'titleist/scotty-cameron/phantom-7-2/v1',
    'titleist/scotty-cameron/phantom-7-5/v1',
    'titleist/scotty-cameron/phantom-7/v1',
    'titleist/t250/t250-irons/v1',
    'titleist/vokey-design/vokey-sm11-wedge/v1'
  ];
  v_expected_slugs text[] := array[
    'ai-one-2-ball-ch',
    'ai-one-rossie-db',
    'ai-one-square-2-square-7-center-shaft',
    'g440-hybrid',
    'g440-max-driver',
    'g440-max-fairway',
    'gt2-driver',
    'gt2-fairway',
    'gt2-hybrid',
    'i240-irons',
    'jpx-one-driver',
    'jpx-one-fairway',
    'jpx-one-hybrid',
    'jpx925-hot-metal-irons',
    'king-irons',
    'king-wedge',
    'm-craft-kyoto-p',
    'm-craft-kyoto-s',
    'm-craft-tokyo-b',
    'm-craft-tokyo-s',
    'mg5-wedge',
    'mizuno-pro-t3-wedge',
    'optm-hybrid',
    'optm-max-k-driver',
    'optm-x-fairway',
    'opus-sp-chrome-wedge',
    'p790-irons',
    'phantom-5',
    'phantom-5-2',
    'phantom-5-5',
    'phantom-5-oc',
    'phantom-7',
    'phantom-7-2',
    'phantom-7-5',
    'pld-milled-anser',
    'pld-milled-anser-2d',
    'qi35-driver',
    'qi35-fairway',
    'qi35-rescue',
    'quantum-max-driver',
    'quantum-max-fairway-woods',
    'quantum-max-hybrids',
    'quantum-max-irons',
    's259-wedge',
    'spider-tour-double-bend',
    'spider-tour-small-slant',
    'spider-tour-x-double-bend',
    'spider-tour-x-l-neck',
    'spider-tour-x-small-slant',
    't250-irons',
    'vokey-sm11-wedge'
  ];
  v_identity_keys text[] := array[
    'callaway/odyssey/ai-one-2-ball-ch/v1',
    'callaway/odyssey/ai-one-rossie-db/v1',
    'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1',
    'callaway/opus-sp/opus-sp-chrome-wedge/v1',
    'callaway/quantum/quantum-max-driver/v1',
    'callaway/quantum/quantum-max-fairway-woods/v1',
    'callaway/quantum/quantum-max-hybrids/v1',
    'callaway/quantum/quantum-max-irons/v1',
    'cobra/king/king-irons/v1',
    'cobra/king/king-wedge/v1',
    'cobra/optm/optm-hybrid/v1',
    'cobra/optm/optm-max-k-driver/v1',
    'cobra/optm/optm-x-fairway/v1',
    'mizuno/jpx-one/jpx-one-driver/v1',
    'mizuno/jpx-one/jpx-one-fairway/v1',
    'mizuno/jpx-one/jpx-one-hybrid/v1',
    'mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1',
    'mizuno/m-craft/kyoto-p/v1',
    'mizuno/m-craft/kyoto-s/v1',
    'mizuno/m-craft/tokyo-b/v1',
    'mizuno/m-craft/tokyo-s/v1',
    'mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1',
    'ping/g440/g440-hybrid/v1',
    'ping/g440/g440-max-driver/v1',
    'ping/g440/g440-max-fairway/v1',
    'ping/i240/i240-irons/v1',
    'ping/pld-milled/anser-2d/v1',
    'ping/pld-milled/anser/v1',
    'ping/s259/s259-wedge/v1',
    'taylormade/mg5/mg5-wedge/v1',
    'taylormade/p790/p790-irons/v1',
    'taylormade/qi35/qi35-driver/v1',
    'taylormade/qi35/qi35-fairway/v1',
    'taylormade/qi35/qi35-rescue/v1',
    'taylormade/spider-tour/spider-tour-double-bend/v1',
    'taylormade/spider-tour/spider-tour-small-slant/v1',
    'taylormade/spider-tour/spider-tour-x-double-bend/v1',
    'taylormade/spider-tour/spider-tour-x-l-neck/v1',
    'taylormade/spider-tour/spider-tour-x-small-slant/v1',
    'titleist/gt2/gt2-driver/v1',
    'titleist/gt2/gt2-fairway/v1',
    'titleist/gt2/gt2-hybrid/v1',
    'titleist/scotty-cameron/phantom-5-2/v1',
    'titleist/scotty-cameron/phantom-5-5/v1',
    'titleist/scotty-cameron/phantom-5-oc/v1',
    'titleist/scotty-cameron/phantom-5/v1',
    'titleist/scotty-cameron/phantom-7-2/v1',
    'titleist/scotty-cameron/phantom-7-5/v1',
    'titleist/scotty-cameron/phantom-7/v1',
    'titleist/t250/t250-irons/v1',
    'titleist/vokey-design/vokey-sm11-wedge/v1'
  ];
  v_identity_normalized text[] := array[
    'odysseyaione2ballch',
    'odysseyaionerossiedb',
    'odysseyaionesquare2square7centershaft',
    'callawayopusspchromewedge',
    'callawayquantummaxdriver',
    'callawayquantummaxfairwaywoods',
    'callawayquantummaxhybrids',
    'callawayquantummaxirons',
    'cobrakingirons',
    'cobrakingwedge',
    'cobraoptmhybrid',
    'cobraoptmmaxkdriver',
    'cobraoptmxfairway',
    'mizunojpxonedriver',
    'mizunojpxonefairway',
    'mizunojpxonehybrid',
    'mizunojpx925hotmetalirons',
    'mizunomcraftkyotop',
    'mizunomcraftkyotos',
    'mizunomcrafttokyob',
    'mizunomcrafttokyos',
    'mizunoprot3wedge',
    'pingg440hybrid',
    'pingg440maxdriver',
    'pingg440maxfairway',
    'pingi240irons',
    'pingpldmilledanser2d',
    'pingpldmilledanser',
    'pings259wedge',
    'taylormademg5wedge',
    'taylormadep790irons',
    'taylormadeqi35driver',
    'taylormadeqi35fairway',
    'taylormadeqi35rescue',
    'taylormadespidertourdoublebend',
    'taylormadespidertoursmallslant',
    'taylormadespidertourxdoublebend',
    'taylormadespidertourxlneck',
    'taylormadespidertourxsmallslant',
    'titleistgt2driver',
    'titleistgt2fairway',
    'titleistgt2hybrid',
    'scottycameronphantom52',
    'scottycameronphantom55',
    'scottycameronphantom5oc',
    'scottycameronphantom5',
    'scottycameronphantom72',
    'scottycameronphantom75',
    'scottycameronphantom7',
    'titleistt250irons',
    'titleistvokeysm11wedge'
  ];
  v_actual_keys text[];
  v_actual_slugs text[];
begin
  -- Required tables.
  if to_regclass('public.equipment_manufacturers') is null then
    raise exception 'EQ2SC-PRE-1: public.equipment_manufacturers does not exist.';
  end if;
  if to_regclass('public.equipment_models') is null then
    raise exception 'EQ2SC-PRE-1: public.equipment_models does not exist.';
  end if;
  if to_regclass('public.equipment_putter_model_specs') is null then
    raise exception 'EQ2SC-PRE-1: public.equipment_putter_model_specs does not exist.';
  end if;
  if to_regclass('public.equipment_model_sources') is null then
    raise exception 'EQ2SC-PRE-1: public.equipment_model_sources does not exist.';
  end if;
  if to_regclass('public.user_equipment') is null then
    raise exception 'EQ2SC-PRE-1: public.user_equipment does not exist.';
  end if;

  -- club_type_enum still carries exactly the six expected values, in order.
  select array_agg(e.enumlabel::text order by e.enumsortorder) into v_enum
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname = 'club_type_enum';
  if v_enum is distinct from array['Driver', 'Wood', 'Hybrid', 'Iron', 'Wedge', 'Putter']::text[] then
    raise exception 'EQ2SC-PRE-2: public.club_type_enum values have changed from the expected six values.';
  end if;

  -- Required identity constraints/indexes still exist.
  if not exists (
    select 1 from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = 'equipment_models_catalog_key_unique'
  ) then
    raise exception 'EQ2SC-PRE-3: constraint equipment_models_catalog_key_unique is missing.';
  end if;
  if not exists (
    select 1 from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = 'equipment_models_slug_unique'
  ) then
    raise exception 'EQ2SC-PRE-3: constraint equipment_models_slug_unique is missing.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equipment_models_manufacturer_type_name_year_uidx'
  ) then
    raise exception 'EQ2SC-PRE-4: index equipment_models_manufacturer_type_name_year_uidx is missing.';
  end if;

  -- Exactly the six locked manufacturers, and nothing else.
  select array_agg(slug order by slug) into v_slugs from public.equipment_manufacturers;
  if v_slugs is distinct from array['callaway', 'cobra', 'mizuno', 'ping', 'taylormade', 'titleist']::text[] then
    raise exception 'EQ2SC-PRE-5: expected exactly the six locked manufacturer slugs, found %.', v_slugs;
  end if;

  select count(*) into v_count from public.equipment_manufacturers;
  if v_count <> 6 then
    raise exception 'EQ2SC-PRE-6: expected exactly 6 equipment_manufacturers rows, found %.', v_count;
  end if;

  -- Exactly the 51 existing models: 30 non-putters and 21 putters.
  select count(*) into v_count from public.equipment_models;
  if v_count <> 51 then
    raise exception 'EQ2SC-PRE-7: expected exactly 51 existing equipment_models rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;
  if v_count <> 30 then
    raise exception 'EQ2SC-PRE-8: expected exactly 30 existing non-Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2SC-PRE-9: expected exactly 21 existing Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_model_sources;
  if v_count <> 51 then
    raise exception 'EQ2SC-PRE-10: expected exactly 51 existing equipment_model_sources rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs;
  if v_count <> 21 then
    raise exception 'EQ2SC-PRE-11: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;
  end if;

  -- The existing 51 catalog keys and slugs are exactly the two protected v1
  -- catalogs, so this delta is landing on the foundation it was reconciled
  -- against and on no other.
  select array_agg(catalog_key order by catalog_key) into v_actual_keys from public.equipment_models;
  if v_actual_keys is distinct from v_expected_keys then
    raise exception 'EQ2SC-PRE-12: the existing 51 catalog_key set does not match the protected v1 catalogs.';
  end if;

  select array_agg(slug order by slug) into v_actual_slugs from public.equipment_models;
  if v_actual_slugs is distinct from v_expected_slugs then
    raise exception 'EQ2SC-PRE-13: the existing 51 slug set does not match the protected v1 catalogs.';
  end if;

  -- Each existing canonical identity is present under its own catalog key.
  for v_i in 1..array_length(v_identity_keys, 1) loop
    select count(*) into v_count from public.equipment_models
     where catalog_key = v_identity_keys[v_i]
       and normalized_name = v_identity_normalized[v_i];
    if v_count <> 1 then
      raise exception 'EQ2SC-PRE-14: existing canonical identity for % is missing or has changed.', v_identity_keys[v_i];
    end if;
  end loop;

  -- User-equipment guard. Deliberately scoped to canonical model references
  -- only: staging holds zero user_equipment rows while production holds real
  -- rows, so a total row-count assertion would make this file environment-
  -- specific.
  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ2SC-PRE-15: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Non-putter equipment models (201 rows, generated — do not hand-edit)
-- ----------------------------------------------------------------------------

insert into public.equipment_models (
  id, manufacturer_id, club_type, canonical_name, slug, normalized_name,
  model_year, specifications, is_active,
  catalog_key, brand_line, brand_line_slug, model_family, model_family_slug, release_year
)
values
  ('b028d022-3e32-5500-a14c-e2428a1f5992', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Ai150 Irons', 'apex-ai150-irons', 'callawayapexai150irons', null, '{}'::jsonb, true, 'callaway/apex-ai150/apex-ai150-irons/v1', null, null, 'Apex Ai150', 'apex-ai150', null),
  ('8ff69801-de0f-5ef4-b572-a6ef300d3ae7', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Ai200 Irons', 'apex-ai200-irons', 'callawayapexai200irons', null, '{}'::jsonb, true, 'callaway/apex-ai200/apex-ai200-irons/v1', null, null, 'Apex Ai200', 'apex-ai200', null),
  ('f0da3045-0914-5df2-976b-a3c04d75534a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Ai300 Irons', 'apex-ai300-irons', 'callawayapexai300irons', null, '{}'::jsonb, true, 'callaway/apex-ai300/apex-ai300-irons/v1', null, null, 'Apex Ai300', 'apex-ai300', null),
  ('babe39f1-8eda-5f19-9b8a-0b1614118f6a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex CB Irons', 'apex-cb-irons', 'callawayapexcbirons', null, '{}'::jsonb, true, 'callaway/apex-cb/apex-cb-irons/v1', null, null, 'Apex CB', 'apex-cb', null),
  ('3990104d-2c42-52ad-b599-a268e51c6109', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex MB Irons', 'apex-mb-irons', 'callawayapexmbirons', null, '{}'::jsonb, true, 'callaway/apex-mb/apex-mb-irons/v1', null, null, 'Apex MB', 'apex-mb', null),
  ('029d4d22-5041-5ff0-9c85-ea05eda1f32e', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Pro Irons', 'apex-pro-irons', 'callawayapexproirons', null, '{}'::jsonb, true, 'callaway/apex-pro/apex-pro-irons/v1', null, null, 'Apex Pro', 'apex-pro', null),
  ('b8b18d5a-eac7-5130-88c1-121182ef02e4', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex TCB ''24 Irons', 'apex-tcb-24-irons', 'callawayapextcb24irons', null, '{}'::jsonb, true, 'callaway/apex-tcb-24/apex-tcb-24-irons/v1', null, null, 'Apex TCB ''24', 'apex-tcb-24', null),
  ('18483ceb-8993-5180-bf47-c3a86a6e0193', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Ti Fusion 250 Irons', 'apex-ti-fusion-250-irons', 'callawayapextifusion250irons', null, '{}'::jsonb, true, 'callaway/apex-ti-fusion/apex-ti-fusion-250-irons/v1', null, null, 'Apex Ti Fusion', 'apex-ti-fusion', null),
  ('0c0d2a68-3ce7-51ea-a247-d5274917191c', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Apex Ti Fusion Irons', 'apex-ti-fusion-irons', 'callawayapextifusionirons', null, '{}'::jsonb, true, 'callaway/apex-ti-fusion/apex-ti-fusion-irons/v1', null, null, 'Apex Ti Fusion', 'apex-ti-fusion', null),
  ('c7756a1f-5782-5a64-96ef-47d0bba558a5', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Apex Ti Super Hybrids', 'apex-ti-super-hybrids', 'callawayapextisuperhybrids', null, '{}'::jsonb, true, 'callaway/apex-ti-super/apex-ti-super-hybrids/v1', null, null, 'Apex Ti Super', 'apex-ti-super', null),
  ('edfc0db0-88a5-5d1c-8d4b-ee367c0a6de1', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Women''s Big Bertha REVA Fairway Woods', 'womens-big-bertha-reva-fairway-woods', 'callawaywomensbigbertharevafairwaywoods', null, '{}'::jsonb, true, 'callaway/big-bertha-reva/womens-big-bertha-reva-fairway-woods/v1', null, null, 'Big Bertha REVA', 'big-bertha-reva', null),
  ('78032edb-8c5f-58b2-b736-7cbfc547b92e', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Women''s Big Bertha REVA Hybrids', 'womens-big-bertha-reva-hybrids', 'callawaywomensbigbertharevahybrids', null, '{}'::jsonb, true, 'callaway/big-bertha-reva/womens-big-bertha-reva-hybrids/v1', null, null, 'Big Bertha REVA', 'big-bertha-reva', null),
  ('d5e59e6d-c200-54ea-9c5c-ad6269d1a273', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Big Bertha Fairway Woods', 'big-bertha-fairway-woods', 'callawaybigberthafairwaywoods', null, '{}'::jsonb, true, 'callaway/big-bertha/big-bertha-fairway-woods/v1', null, null, 'Big Bertha', 'big-bertha', null),
  ('eb194721-0975-5ef3-ba40-3763bcc85c5a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Big Bertha Hybrids', 'big-bertha-hybrids', 'callawaybigberthahybrids', null, '{}'::jsonb, true, 'callaway/big-bertha/big-bertha-hybrids/v1', null, null, 'Big Bertha', 'big-bertha', null),
  ('cda8badb-df33-5ae0-93c8-4ea76d6cb3f9', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Big Bertha Irons', 'big-bertha-irons', 'callawaybigberthairons', null, '{}'::jsonb, true, 'callaway/big-bertha/big-bertha-irons/v1', null, null, 'Big Bertha', 'big-bertha', null),
  ('0c9174c6-79a6-5abe-bf3e-e83d8f1937a2', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway CB 12 Wedge', 'cb-12-wedge', 'callawaycb12wedge', null, '{}'::jsonb, true, 'callaway/cb-12/cb-12-wedge/v1', null, null, 'CB 12', 'cb-12', null),
  ('a527bb01-9a82-5174-9d7a-fa7600811ef2', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Elyte Driver', 'elyte-driver', 'callawayelytedriver', null, '{}'::jsonb, true, 'callaway/elyte/elyte-driver/v1', null, null, 'Elyte', 'elyte', null),
  ('69208ba5-84ce-50ce-b70f-4e662f48beef', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Elyte Fairway Woods', 'elyte-fairway-woods', 'callawayelytefairwaywoods', null, '{}'::jsonb, true, 'callaway/elyte/elyte-fairway-woods/v1', null, null, 'Elyte', 'elyte', null),
  ('d719ac7f-1043-5fa4-85c2-ce20477f1b00', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Elyte HL Irons', 'elyte-hl-irons', 'callawayelytehlirons', null, '{}'::jsonb, true, 'callaway/elyte/elyte-hl-irons/v1', null, null, 'Elyte', 'elyte', null),
  ('82a66c14-d986-599b-91ce-f28a9867b97d', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Elyte Hybrids', 'elyte-hybrids', 'callawayelytehybrids', null, '{}'::jsonb, true, 'callaway/elyte/elyte-hybrids/v1', null, null, 'Elyte', 'elyte', null),
  ('42070948-0e20-57aa-bed3-ac43cb6df7e9', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Elyte Irons', 'elyte-irons', 'callawayelyteirons', null, '{}'::jsonb, true, 'callaway/elyte/elyte-irons/v1', null, null, 'Elyte', 'elyte', null),
  ('933038e5-b98c-5c6a-83ce-c2185336ec1c', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Elyte Max Fast Driver', 'elyte-max-fast-driver', 'callawayelytemaxfastdriver', null, '{}'::jsonb, true, 'callaway/elyte/elyte-max-fast-driver/v1', null, null, 'Elyte', 'elyte', null),
  ('74b7a033-260a-5e74-9f4b-979fb208262f', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Elyte Max Fast Fairway Woods', 'elyte-max-fast-fairway-woods', 'callawayelytemaxfastfairwaywoods', null, '{}'::jsonb, true, 'callaway/elyte/elyte-max-fast-fairway-woods/v1', null, null, 'Elyte', 'elyte', null),
  ('f8cebc1f-4004-5bc9-9336-23c3869073f5', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Elyte Max Fast Hybrids', 'elyte-max-fast-hybrids', 'callawayelytemaxfasthybrids', null, '{}'::jsonb, true, 'callaway/elyte/elyte-max-fast-hybrids/v1', null, null, 'Elyte', 'elyte', null),
  ('2c6ad879-53a3-59fb-a514-4325721980b4', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Elyte Max Fast Irons', 'elyte-max-fast-irons', 'callawayelytemaxfastirons', null, '{}'::jsonb, true, 'callaway/elyte/elyte-max-fast-irons/v1', null, null, 'Elyte', 'elyte', null),
  ('e46ac34b-b019-5680-b16d-6081205ef91f', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Elyte Titanium Fairway Woods', 'elyte-titanium-fairway-woods', 'callawayelytetitaniumfairwaywoods', null, '{}'::jsonb, true, 'callaway/elyte/elyte-titanium-fairway-woods/v1', null, null, 'Elyte', 'elyte', null),
  ('fced413f-a328-5138-9610-dd3fdfdc9871', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Elyte Triple Diamond Driver', 'elyte-triple-diamond-driver', 'callawayelytetriplediamonddriver', null, '{}'::jsonb, true, 'callaway/elyte/elyte-triple-diamond-driver/v1', null, null, 'Elyte', 'elyte', null),
  ('4643ecd9-b18f-5dac-bc6e-21ba0b50c27a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Elyte Triple Diamond Fairway Woods', 'elyte-triple-diamond-fairway-woods', 'callawayelytetriplediamondfairwaywoods', null, '{}'::jsonb, true, 'callaway/elyte/elyte-triple-diamond-fairway-woods/v1', null, null, 'Elyte', 'elyte', null),
  ('2d533c58-ed5c-587a-8755-378d3f9fcaa3', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Elyte X Driver', 'elyte-x-driver', 'callawayelytexdriver', null, '{}'::jsonb, true, 'callaway/elyte/elyte-x-driver/v1', null, null, 'Elyte', 'elyte', null),
  ('1d37940f-bbcc-5683-be5f-8009b0c87fdb', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Elyte X Fairway Woods', 'elyte-x-fairway-woods', 'callawayelytexfairwaywoods', null, '{}'::jsonb, true, 'callaway/elyte/elyte-x-fairway-woods/v1', null, null, 'Elyte', 'elyte', null),
  ('84e58ebc-eb45-5686-aa7d-c8fe3ae46c94', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Elyte X Hybrids', 'elyte-x-hybrids', 'callawayelytexhybrids', null, '{}'::jsonb, true, 'callaway/elyte/elyte-x-hybrids/v1', null, null, 'Elyte', 'elyte', null),
  ('8bc3aa28-f8bf-5144-86fa-c0774d96adbf', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Elyte X Irons', 'elyte-x-irons', 'callawayelytexirons', null, '{}'::jsonb, true, 'callaway/elyte/elyte-x-irons/v1', null, null, 'Elyte', 'elyte', null),
  ('04260143-0065-5d99-bd8e-f014e7d80339', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Full Toe SP Wedge', 'full-toe-sp-wedge', 'callawayfulltoespwedge', null, '{}'::jsonb, true, 'callaway/full-toe-sp/full-toe-sp-wedge/v1', null, null, 'Full Toe SP', 'full-toe-sp', null),
  ('0745d40e-9c25-57b8-9a2a-94accdda33a0', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Great Big Bertha Fairway Woods', 'great-big-bertha-fairway-woods', 'callawaygreatbigberthafairwaywoods', null, '{}'::jsonb, true, 'callaway/great-big-bertha/great-big-bertha-fairway-woods/v1', null, null, 'Great Big Bertha', 'great-big-bertha', null),
  ('a1efbde6-68f3-51df-8645-310ef3845ba1', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Great Big Bertha Hybrids', 'great-big-bertha-hybrids', 'callawaygreatbigberthahybrids', null, '{}'::jsonb, true, 'callaway/great-big-bertha/great-big-bertha-hybrids/v1', null, null, 'Great Big Bertha', 'great-big-bertha', null),
  ('08c17240-0efc-5caa-bb12-05472e4f341d', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Jaws Raw Wedge', 'jaws-raw-wedge', 'callawayjawsrawwedge', null, '{}'::jsonb, true, 'callaway/jaws-raw/jaws-raw-wedge/v1', null, null, 'Jaws Raw', 'jaws-raw', null),
  ('bb6201c4-0dd6-50d2-a2df-ba09e4a35715', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Women''s MAVRIK MAX W Hybrids', 'womens-mavrik-max-w-hybrids', 'callawaywomensmavrikmaxwhybrids', null, '{}'::jsonb, true, 'callaway/mavrik-max-w/womens-mavrik-max-w-hybrids/v1', null, null, 'MAVRIK MAX W', 'mavrik-max-w', null),
  ('7f294239-851d-52e9-8d81-148f4ec78182', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway MAVRIK Fairway Woods', 'mavrik-fairway-woods', 'callawaymavrikfairwaywoods', null, '{}'::jsonb, true, 'callaway/mavrik/mavrik-fairway-woods/v1', null, null, 'MAVRIK', 'mavrik', null),
  ('5811c7ed-69ef-5839-ba28-b8384a8c23b9', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway MAVRIK Hybrids', 'mavrik-hybrids', 'callawaymavrikhybrids', null, '{}'::jsonb, true, 'callaway/mavrik/mavrik-hybrids/v1', null, null, 'MAVRIK', 'mavrik', null),
  ('761d65a1-cb5f-5e04-a4e0-d2ea331a6508', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway MAVRIK Irons', 'mavrik-irons', 'callawaymavrikirons', null, '{}'::jsonb, true, 'callaway/mavrik/mavrik-irons/v1', null, null, 'MAVRIK', 'mavrik', null),
  ('b8328a0d-8464-59e2-9632-292fdf5f9d60', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Opus Platinum Wedge', 'opus-platinum-wedge', 'callawayopusplatinumwedge', null, '{}'::jsonb, true, 'callaway/opus-platinum/opus-platinum-wedge/v1', null, null, 'Opus Platinum', 'opus-platinum', null),
  ('efbfefca-e301-54c9-8a0b-9dff7bfc852d', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Opus SP+ Wedge', 'opus-sp-wedge', 'callawayopusspwedge', null, '{}'::jsonb, true, 'callaway/opus-sp-plus/opus-sp-wedge/v1', null, null, 'Opus SP+', 'opus-sp-plus', null),
  ('7859464f-7ee1-53e1-8fd5-9a67290349cd', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Opus Wedge', 'opus-wedge', 'callawayopuswedge', null, '{}'::jsonb, true, 'callaway/opus/opus-wedge/v1', null, null, 'Opus', 'opus', null),
  ('7c8fc797-a0b2-5be5-85e5-484172864d26', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Paradym Ai Smoke HL Hybrids', 'paradym-ai-smoke-hl-hybrids', 'callawayparadymaismokehlhybrids', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-hl-hybrids/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('3b561a07-dd3c-5d5a-b18d-a96c11e383aa', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Paradym Ai Smoke HL Irons', 'paradym-ai-smoke-hl-irons', 'callawayparadymaismokehlirons', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-hl-irons/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('8d82cc7a-95d5-5e19-b41d-98f8cadd62d5', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Paradym Ai Smoke Hybrid', 'paradym-ai-smoke-hybrid', 'callawayparadymaismokehybrid', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-hybrid/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('0dedcb5d-de2c-5ab8-9560-e18530a7e058', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Paradym Ai Smoke Irons', 'paradym-ai-smoke-irons', 'callawayparadymaismokeirons', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-irons/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('f69d112d-f8c9-5575-b8e0-bf48bc80a219', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Paradym Ai Smoke MAX Driver', 'paradym-ai-smoke-max-driver', 'callawayparadymaismokemaxdriver', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-max-driver/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('56d9d71f-d294-5d2a-b2f6-313472868376', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Paradym Ai Smoke MAX Fairway Woods', 'paradym-ai-smoke-max-fairway-woods', 'callawayparadymaismokemaxfairwaywoods', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-max-fairway-woods/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('5d69f27d-d883-5882-9bb7-bb39a9f00729', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Paradym Ai Smoke MAX Fast Irons', 'paradym-ai-smoke-max-fast-irons', 'callawayparadymaismokemaxfastirons', null, '{}'::jsonb, true, 'callaway/paradym-ai-smoke/paradym-ai-smoke-max-fast-irons/v1', null, null, 'Paradym Ai Smoke', 'paradym-ai-smoke', null),
  ('6db9cb72-8e72-5cea-be27-23ccf4c9432c', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Paradym Super Hybrid', 'paradym-super-hybrid', 'callawayparadymsuperhybrid', null, '{}'::jsonb, true, 'callaway/paradym-super/paradym-super-hybrid/v1', null, null, 'Paradym Super', 'paradym-super', null),
  ('fef96cf9-98b0-561a-bad8-6a89de62b847', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Paradym Fairway Woods', 'paradym-fairway-woods', 'callawayparadymfairwaywoods', null, '{}'::jsonb, true, 'callaway/paradym/paradym-fairway-woods/v1', null, null, 'Paradym', 'paradym', null),
  ('914a07cf-6e53-5649-9e5a-3bf681eeb259', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Paradym Irons', 'paradym-irons', 'callawayparadymirons', null, '{}'::jsonb, true, 'callaway/paradym/paradym-irons/v1', null, null, 'Paradym', 'paradym', null),
  ('61a09ec5-ce04-59c3-8b17-bcb1686f352a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Quantum Max D Driver', 'quantum-max-d-driver', 'callawayquantummaxddriver', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-d-driver/v1', null, null, 'Quantum', 'quantum', null),
  ('58c915e3-11c2-573c-bf25-6be9e9b6a86d', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Max D Fairway Woods', 'quantum-max-d-fairway-woods', 'callawayquantummaxdfairwaywoods', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-d-fairway-woods/v1', null, null, 'Quantum', 'quantum', null),
  ('865360d5-075b-5a17-9c56-d505c6609937', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Quantum Max Fast Driver', 'quantum-max-fast-driver', 'callawayquantummaxfastdriver', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-fast-driver/v1', null, null, 'Quantum', 'quantum', null),
  ('92460ed2-18fa-5cd0-a6cc-a0d4d63578e7', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Max Fast Fairway Woods', 'quantum-max-fast-fairway-woods', 'callawayquantummaxfastfairwaywoods', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-fast-fairway-woods/v1', null, null, 'Quantum', 'quantum', null),
  ('0a8a3502-6e4e-523f-a18c-f4636d2faed1', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Quantum Max Fast Hybrids', 'quantum-max-fast-hybrids', 'callawayquantummaxfasthybrids', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-fast-hybrids/v1', null, null, 'Quantum', 'quantum', null),
  ('95fd87d7-e3f1-5753-917c-a25f5ed23578', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Quantum Max Fast Irons', 'quantum-max-fast-irons', 'callawayquantummaxfastirons', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-fast-irons/v1', null, null, 'Quantum', 'quantum', null),
  ('d217ce69-f1bb-543d-8490-9f8777a89100', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Quantum Max OS Hybrids', 'quantum-max-os-hybrids', 'callawayquantummaxoshybrids', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-os-hybrids/v1', null, null, 'Quantum', 'quantum', null),
  ('e2fbff14-51e6-521f-b0a1-4ae16cb2d530', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Quantum Max OS Irons', 'quantum-max-os-irons', 'callawayquantummaxosirons', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-os-irons/v1', null, null, 'Quantum', 'quantum', null),
  ('146e00cb-22f2-5c76-8c50-ecca1465065e', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Quantum Max OS Wedges', 'quantum-max-os-wedges', 'callawayquantummaxoswedges', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-os-wedges/v1', null, null, 'Quantum', 'quantum', null),
  ('9bf9bcd6-881e-5776-a1a0-0a1366a39878', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Quantum Max Wedges', 'quantum-max-wedges', 'callawayquantummaxwedges', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-wedges/v1', null, null, 'Quantum', 'quantum', null),
  ('f8997505-913f-53c6-b21b-b84c5a8f67c7', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Mini Spinner Fairway Wood', 'quantum-mini-spinner-fairway-wood', 'callawayquantumminispinnerfairwaywood', null, '{}'::jsonb, true, 'callaway/quantum/quantum-mini-spinner-fairway-wood/v1', null, null, 'Quantum', 'quantum', null),
  ('3477a641-a588-5ccd-b44c-b0cd6845c851', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Ti Fairway Woods', 'quantum-ti-fairway-woods', 'callawayquantumtifairwaywoods', null, '{}'::jsonb, true, 'callaway/quantum/quantum-ti-fairway-woods/v1', null, null, 'Quantum', 'quantum', null),
  ('10466a4f-3181-534c-99ed-abb9692b2543', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Quantum Triple Diamond Driver', 'quantum-triple-diamond-driver', 'callawayquantumtriplediamonddriver', null, '{}'::jsonb, true, 'callaway/quantum/quantum-triple-diamond-driver/v1', null, null, 'Quantum', 'quantum', null),
  ('0cee0a4c-1f70-54ac-93b1-4d6f80241bc5', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Triple Diamond Fairway Woods', 'quantum-triple-diamond-fairway-woods', 'callawayquantumtriplediamondfairwaywoods', null, '{}'::jsonb, true, 'callaway/quantum/quantum-triple-diamond-fairway-woods/v1', null, null, 'Quantum', 'quantum', null),
  ('a9d2f5e9-fecd-541b-81ec-17d0734193e3', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Quantum Triple Diamond Max Driver', 'quantum-triple-diamond-max-driver', 'callawayquantumtriplediamondmaxdriver', null, '{}'::jsonb, true, 'callaway/quantum/quantum-triple-diamond-max-driver/v1', null, null, 'Quantum', 'quantum', null),
  ('0ff98956-3645-54cf-859d-9748512cfeea', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway REVA RISE Driver', 'reva-rise-driver', 'callawayrevarisedriver', null, '{}'::jsonb, true, 'callaway/reva-rise/reva-rise-driver/v1', null, null, 'REVA RISE', 'reva-rise', null),
  ('cef00c69-9325-5cbe-8f1f-0bc7f3cfaa0f', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway REVA RISE Fairway Woods', 'reva-rise-fairway-woods', 'callawayrevarisefairwaywoods', null, '{}'::jsonb, true, 'callaway/reva-rise/reva-rise-fairway-woods/v1', null, null, 'REVA RISE', 'reva-rise', null),
  ('4534a953-11c9-5e41-a85f-99cb4794ee49', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway REVA RISE Hybrid', 'reva-rise-hybrid', 'callawayrevarisehybrid', null, '{}'::jsonb, true, 'callaway/reva-rise/reva-rise-hybrid/v1', null, null, 'REVA RISE', 'reva-rise', null),
  ('40ddaff2-639b-55ce-b0f6-10bb008790b8', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway REVA RISE Irons', 'reva-rise-irons', 'callawayrevariseirons', null, '{}'::jsonb, true, 'callaway/reva-rise/reva-rise-irons/v1', null, null, 'REVA RISE', 'reva-rise', null),
  ('8ae75d35-b2cc-5784-a968-6660df188880', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Rogue ST ''24 MAX Irons', 'rogue-st-24-max-irons', 'callawayroguest24maxirons', null, '{}'::jsonb, true, 'callaway/rogue-st/rogue-st-24-max-irons/v1', null, null, 'Rogue ST', 'rogue-st', null),
  ('8b9e0675-0266-5abb-b479-dd5d57e61998', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Rogue ST MAX D Fairway Woods', 'rogue-st-max-d-fairway-woods', 'callawayroguestmaxdfairwaywoods', null, '{}'::jsonb, true, 'callaway/rogue-st/rogue-st-max-d-fairway-woods/v1', null, null, 'Rogue ST', 'rogue-st', null),
  ('bfe75eb6-fa86-5177-bb19-619b204c2216', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Rogue ST MAX OS Lite Irons', 'rogue-st-max-os-lite-irons', 'callawayroguestmaxosliteirons', null, '{}'::jsonb, true, 'callaway/rogue-st/rogue-st-max-os-lite-irons/v1', null, null, 'Rogue ST', 'rogue-st', null),
  ('a4c5bd7d-182b-5706-88d6-605f77d2f78f', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway X Forged Max Irons', 'x-forged-max-irons', 'callawayxforgedmaxirons', null, '{}'::jsonb, true, 'callaway/x-forged-max/x-forged-max-irons/v1', null, null, 'X Forged Max', 'x-forged-max', null),
  ('b193bce0-5201-5485-a343-d736efe8752a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway X Forged Irons', 'x-forged-irons', 'callawayxforgedirons', null, '{}'::jsonb, true, 'callaway/x-forged/x-forged-irons/v1', null, null, 'X Forged', 'x-forged', null),
  ('a7b7cc32-67f7-5bc5-9067-67c792140913', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra 3DP MB Irons', '3dp-mb-irons', 'cobra3dpmbirons', null, '{}'::jsonb, true, 'cobra/3dp-mb/3dp-mb-irons/v1', null, null, '3DP MB', '3dp-mb', null),
  ('f19314a3-6eea-5d7e-81f5-151c9769fd90', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra 3DP Tour Irons', '3dp-tour-irons', 'cobra3dptourirons', null, '{}'::jsonb, true, 'cobra/3dp-tour/3dp-tour-irons/v1', null, null, '3DP Tour', '3dp-tour', null),
  ('80bbc6a4-5320-5dc8-84f3-7790db9c2e0b', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra 3DP X Irons', '3dp-x-irons', 'cobra3dpxirons', null, '{}'::jsonb, true, 'cobra/3dp-x/3dp-x-irons/v1', null, null, '3DP X', '3dp-x', null),
  ('00b95f2c-c3f0-5235-8645-e9b8c65afda7', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Hybrid'::public.club_type_enum, 'Cobra BAFFLER Hybrid', 'baffler-hybrid', 'cobrabafflerhybrid', null, '{}'::jsonb, true, 'cobra/baffler/baffler-hybrid/v1', null, null, 'BAFFLER', 'baffler', null),
  ('27561a0a-1e87-5158-acc3-78ab461beb7c', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra BAFFLER Irons', 'baffler-irons', 'cobrabafflerirons', null, '{}'::jsonb, true, 'cobra/baffler/baffler-irons/v1', null, null, 'BAFFLER', 'baffler', null),
  ('a56d4605-5066-5f9a-ab6b-636af0f470f9', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DARKSPEED LS Driver', 'darkspeed-ls-driver', 'cobradarkspeedlsdriver', null, '{}'::jsonb, true, 'cobra/darkspeed/darkspeed-ls-driver/v1', null, null, 'DARKSPEED', 'darkspeed', null),
  ('4b3eed29-b4e5-51d3-b7a4-bfcfd53f1244', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DARKSPEED LS Fairway', 'darkspeed-ls-fairway', 'cobradarkspeedlsfairway', null, '{}'::jsonb, true, 'cobra/darkspeed/darkspeed-ls-fairway/v1', null, null, 'DARKSPEED', 'darkspeed', null),
  ('af40ef79-01b9-542d-9b48-b0e8cbcf6b27', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DARKSPEED MAX Fairway', 'darkspeed-max-fairway', 'cobradarkspeedmaxfairway', null, '{}'::jsonb, true, 'cobra/darkspeed/darkspeed-max-fairway/v1', null, null, 'DARKSPEED', 'darkspeed', null),
  ('2ee6e73f-d982-55ba-be98-a4ec14e9f58a', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DARKSPEED X Driver', 'darkspeed-x-driver', 'cobradarkspeedxdriver', null, '{}'::jsonb, true, 'cobra/darkspeed/darkspeed-x-driver/v1', null, null, 'DARKSPEED', 'darkspeed', null),
  ('7dce54b9-00da-5dfb-b6bd-283d921b80ca', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DARKSPEED X Fairway', 'darkspeed-x-fairway', 'cobradarkspeedxfairway', null, '{}'::jsonb, true, 'cobra/darkspeed/darkspeed-x-fairway/v1', null, null, 'DARKSPEED', 'darkspeed', null),
  ('e5d04dae-ce01-53ba-86a5-2273138c18d6', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Hybrid'::public.club_type_enum, 'Cobra DS-ADAPT Hybrid', 'ds-adapt-hybrid', 'cobradsadapthybrid', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-hybrid/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('68a5a46b-9944-5a60-9c02-041628545a27', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DS-ADAPT LS Driver', 'ds-adapt-ls-driver', 'cobradsadaptlsdriver', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-ls-driver/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('a05a676d-bdc5-5d87-b3e2-eae11a4bd8bf', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DS-ADAPT LS Fairway', 'ds-adapt-ls-fairway', 'cobradsadaptlsfairway', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-ls-fairway/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('adf4c508-a326-5c20-b3fe-549f6ae413ab', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DS-ADAPT MAX-D Driver', 'ds-adapt-max-d-driver', 'cobradsadaptmaxddriver', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-max-d-driver/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('3e93f818-dc52-5daa-a3b7-1301d368f165', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DS-ADAPT MAX Fairway', 'ds-adapt-max-fairway', 'cobradsadaptmaxfairway', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-max-fairway/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('eac93b66-2373-51c9-94b1-853056fbe8f5', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DS-ADAPT MAX-K Driver', 'ds-adapt-max-k-driver', 'cobradsadaptmaxkdriver', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-max-k-driver/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('01994c8a-df56-58b8-9825-912803e15d7b', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra DS-ADAPT X Driver', 'ds-adapt-x-driver', 'cobradsadaptxdriver', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-x-driver/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('ef30c49b-3fa4-5e8a-9684-dbbb1639cfe8', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra DS-ADAPT X Fairway', 'ds-adapt-x-fairway', 'cobradsadaptxfairway', null, '{}'::jsonb, true, 'cobra/ds-adapt/ds-adapt-x-fairway/v1', null, null, 'DS-ADAPT', 'ds-adapt', null),
  ('5eaf77e9-e981-5598-bed9-e7535c3eeb6e', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING CB/MB Irons', 'king-cb-mb-irons', 'cobrakingcbmbirons', null, '{}'::jsonb, true, 'cobra/king-cb-mb/king-cb-mb-irons/v1', null, null, 'KING CB/MB', 'king-cb-mb', null),
  ('b4ef2e28-d055-5af4-ba8b-120b5f243338', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING MAX Irons', 'king-max-irons', 'cobrakingmaxirons', null, '{}'::jsonb, true, 'cobra/king-max/king-max-irons/v1', null, null, 'KING MAX', 'king-max', null),
  ('4aa04bf1-4e95-51cf-b847-e44c047c1d7d', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING TEC X Irons', 'king-tec-x-irons', 'cobrakingtecxirons', null, '{}'::jsonb, true, 'cobra/king-tec-x/king-tec-x-irons/v1', null, null, 'KING TEC X', 'king-tec-x', null),
  ('44e1dd98-0af7-5a5b-890f-9ed226db02b4', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Hybrid'::public.club_type_enum, 'Cobra KING TEC-X ONE Length Hybrid', 'king-tec-x-one-length-hybrid', 'cobrakingtecxonelengthhybrid', null, '{}'::jsonb, true, 'cobra/king-tec-x/king-tec-x-one-length-hybrid/v1', null, null, 'KING TEC-X', 'king-tec-x', null),
  ('1836380a-0724-55c2-8274-bcab8610f60d', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING TEC X ONE Length Irons', 'king-tec-x-one-length-irons', 'cobrakingtecxonelengthirons', null, '{}'::jsonb, true, 'cobra/king-tec-x/king-tec-x-one-length-irons/v1', null, null, 'KING TEC X', 'king-tec-x', null),
  ('e0edb234-2fce-5885-a472-d3cb32171fec', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Hybrid'::public.club_type_enum, 'Cobra KING TEC Hybrid', 'king-tec-hybrid', 'cobrakingtechybrid', null, '{}'::jsonb, true, 'cobra/king-tec/king-tec-hybrid/v1', null, null, 'KING TEC', 'king-tec', null),
  ('bed2d1b0-87d9-51a3-82ef-0b6849003df8', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING TEC Irons', 'king-tec-irons', 'cobrakingtecirons', null, '{}'::jsonb, true, 'cobra/king-tec/king-tec-irons/v1', null, null, 'KING TEC', 'king-tec', null),
  ('31067bf7-53dc-525e-b880-ac4e679ca93d', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING Tour Irons', 'king-tour-irons', 'cobrakingtourirons', null, '{}'::jsonb, true, 'cobra/king-tour/king-tour-irons/v1', null, null, 'KING Tour', 'king-tour', null),
  ('811e1242-e388-5b0e-b0ef-1246dcfea6dd', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wedge'::public.club_type_enum, 'Cobra KING-X Wedge', 'king-x-wedge', 'cobrakingxwedge', null, '{}'::jsonb, true, 'cobra/king-x/king-x-wedge/v1', null, null, 'KING-X', 'king-x', null),
  ('ed3cedbf-d1ab-53b6-b5aa-527d935b176d', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra OPTM LS Driver', 'optm-ls-driver', 'cobraoptmlsdriver', null, '{}'::jsonb, true, 'cobra/optm/optm-ls-driver/v1', null, null, 'OPTM', 'optm', null),
  ('1a3fe3a1-6210-5f6b-8be1-328f4642260f', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra OPTM LS Titanium Fairway', 'optm-ls-titanium-fairway', 'cobraoptmlstitaniumfairway', null, '{}'::jsonb, true, 'cobra/optm/optm-ls-titanium-fairway/v1', null, null, 'OPTM', 'optm', null),
  ('ec41fa32-99de-547d-8ac8-46983fdf9a1e', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra OPTM MAX-D Driver', 'optm-max-d-driver', 'cobraoptmmaxddriver', null, '{}'::jsonb, true, 'cobra/optm/optm-max-d-driver/v1', null, null, 'OPTM', 'optm', null),
  ('a01e8cf0-e097-5bf6-a587-c0013d99515a', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra OPTM MAX Fairway', 'optm-max-fairway', 'cobraoptmmaxfairway', null, '{}'::jsonb, true, 'cobra/optm/optm-max-fairway/v1', null, null, 'OPTM', 'optm', null),
  ('5112d2b8-84fd-55da-889e-883842d87aab', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra OPTM X Driver', 'optm-x-driver', 'cobraoptmxdriver', null, '{}'::jsonb, true, 'cobra/optm/optm-x-driver/v1', null, null, 'OPTM', 'optm', null),
  ('420a7af8-ea58-524e-8054-7fe8123c0a37', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Driver'::public.club_type_enum, 'Mizuno JPX ONE SELECT Driver', 'jpx-one-select-driver', 'mizunojpxoneselectdriver', null, '{}'::jsonb, true, 'mizuno/jpx-one/jpx-one-select-driver/v1', null, null, 'JPX ONE', 'jpx-one', null),
  ('32ea55ff-c2dc-54ad-9a69-c1e407be08c5', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno JPX925 Forged Irons', 'jpx925-forged-irons', 'mizunojpx925forgedirons', null, '{}'::jsonb, true, 'mizuno/jpx925-forged/jpx925-forged-irons/v1', null, null, 'JPX925 Forged', 'jpx925-forged', null),
  ('513682f2-b4ad-5306-b611-857b2bba1d21', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno JPX925 Hot Metal HL Irons', 'jpx925-hot-metal-hl-irons', 'mizunojpx925hotmetalhlirons', null, '{}'::jsonb, true, 'mizuno/jpx925-hot-metal/jpx925-hot-metal-hl-irons/v1', null, null, 'JPX925 Hot Metal', 'jpx925-hot-metal', null),
  ('30e5500b-1f63-5a0b-bd96-73a46446ad9d', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno JPX925 Hot Metal Pro Irons', 'jpx925-hot-metal-pro-irons', 'mizunojpx925hotmetalproirons', null, '{}'::jsonb, true, 'mizuno/jpx925-hot-metal/jpx925-hot-metal-pro-irons/v1', null, null, 'JPX925 Hot Metal', 'jpx925-hot-metal', null),
  ('7501380d-5777-563e-a360-2a35eb0d1896', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno Pro M-13 Irons', 'mizuno-pro-m13-irons', 'mizunoprom13irons', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-m13/mizuno-pro-m13-irons/v1', null, null, 'Mizuno Pro M-13', 'mizuno-pro-m13', null),
  ('ec006f05-17ed-5e2e-a7db-3afd5cb935a8', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno Pro M-15 Irons', 'mizuno-pro-m15-irons', 'mizunoprom15irons', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-m15/mizuno-pro-m15-irons/v1', null, null, 'Mizuno Pro M-15', 'mizuno-pro-m15', null),
  ('bf26de36-6446-5201-828a-47abad9d084d', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno Pro S-1 Irons', 'mizuno-pro-s1-irons', 'mizunopros1irons', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-s1/mizuno-pro-s1-irons/v1', null, null, 'Mizuno Pro S-1', 'mizuno-pro-s1', null),
  ('71672aba-8333-588e-acc3-91a6ef0c089e', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno Pro S-3 Irons', 'mizuno-pro-s3-irons', 'mizunopros3irons', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-s3/mizuno-pro-s3-irons/v1', null, null, 'Mizuno Pro S-3', 'mizuno-pro-s3', null),
  ('e50284f1-af86-5f30-a596-6213517e23b7', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno Pro S-4 Irons', 'mizuno-pro-s4-irons', 'mizunopros4irons', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-s4/mizuno-pro-s4-irons/v1', null, null, 'Mizuno Pro S-4', 'mizuno-pro-s4', null),
  ('8698abfb-0b93-5af9-abb5-abf597083ae8', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Wedge'::public.club_type_enum, 'Mizuno Pro T-1 Wedge', 'mizuno-pro-t1-wedge', 'mizunoprot1wedge', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-t1/mizuno-pro-t1-wedge/v1', null, null, 'Mizuno Pro T-1', 'mizuno-pro-t1', null),
  ('8b86d75b-32d9-5903-81f6-479638f68728', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Hybrid'::public.club_type_enum, 'Mizuno ST-Max Hybrid', 'st-max-hybrid', 'mizunostmaxhybrid', null, '{}'::jsonb, true, 'mizuno/st-max/st-max-hybrid/v1', null, null, 'ST-Max', 'st-max', null),
  ('f99a48c4-1e7a-5e64-bd16-b7428f45a967', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING BLUEPRINT S Irons', 'blueprint-s-irons', 'pingblueprintsirons', null, '{}'::jsonb, true, 'ping/blueprint-s/blueprint-s-irons/v1', null, null, 'BLUEPRINT S', 'blueprint-s', null),
  ('474867d8-9e79-5726-8cc4-ffef50ca3724', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING BLUEPRINT T Irons', 'blueprint-t-irons', 'pingblueprinttirons', null, '{}'::jsonb, true, 'ping/blueprint-t/blueprint-t-irons/v1', null, null, 'BLUEPRINT T', 'blueprint-t', null),
  ('603c535e-5732-567a-aa91-b5b7e602144f', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wedge'::public.club_type_enum, 'PING BunkR Wedge', 'bunkr-wedge', 'pingbunkrwedge', null, '{}'::jsonb, true, 'ping/bunkr/bunkr-wedge/v1', null, null, 'BunkR', 'bunkr', null),
  ('c318bfef-7ecb-5df9-bc50-e0609fc8184a', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G Le3 Driver', 'g-le3-driver', 'pinggle3driver', null, '{}'::jsonb, true, 'ping/g-le3/g-le3-driver/v1', null, null, 'G Le3', 'g-le3', null),
  ('6de8a5a9-7746-520a-9dcf-e7d20fa4615f', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G Le3 Fairway', 'g-le3-fairway', 'pinggle3fairway', null, '{}'::jsonb, true, 'ping/g-le3/g-le3-fairway/v1', null, null, 'G Le3', 'g-le3', null),
  ('0a4d8f9a-a61c-5352-8457-2b3c01701e6d', (select id from public.equipment_manufacturers where slug = 'ping'), 'Hybrid'::public.club_type_enum, 'PING G Le3 Hybrid', 'g-le3-hybrid', 'pinggle3hybrid', null, '{}'::jsonb, true, 'ping/g-le3/g-le3-hybrid/v1', null, null, 'G Le3', 'g-le3', null),
  ('5f286b01-1ebb-5ece-af61-6e992b1db885', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G Le3 Irons', 'g-le3-irons', 'pinggle3irons', null, '{}'::jsonb, true, 'ping/g-le3/g-le3-irons/v1', null, null, 'G Le3', 'g-le3', null),
  ('3ff70dc6-8e0b-5d74-b0e5-2a7722c22185', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G Le4 Driver', 'g-le4-driver', 'pinggle4driver', null, '{}'::jsonb, true, 'ping/g-le4/g-le4-driver/v1', null, null, 'G Le4', 'g-le4', null),
  ('f111c5f4-babb-52cf-a6eb-afe87642f10a', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G Le4 Fairway', 'g-le4-fairway', 'pinggle4fairway', null, '{}'::jsonb, true, 'ping/g-le4/g-le4-fairway/v1', null, null, 'G Le4', 'g-le4', null),
  ('015345a0-93a8-5e77-867f-5ec6293e568e', (select id from public.equipment_manufacturers where slug = 'ping'), 'Hybrid'::public.club_type_enum, 'PING G Le4 Hybrid', 'g-le4-hybrid', 'pinggle4hybrid', null, '{}'::jsonb, true, 'ping/g-le4/g-le4-hybrid/v1', null, null, 'G Le4', 'g-le4', null),
  ('51ad5f23-4310-5ef2-93f2-e3d76c8c9639', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G Le4 Irons', 'g-le4-irons', 'pinggle4irons', null, '{}'::jsonb, true, 'ping/g-le4/g-le4-irons/v1', null, null, 'G Le4', 'g-le4', null),
  ('7eff920a-eb8b-5e42-8734-c61459416910', (select id from public.equipment_manufacturers where slug = 'ping'), 'Hybrid'::public.club_type_enum, 'PING G430 Hybrid', 'g430-hybrid', 'pingg430hybrid', null, '{}'::jsonb, true, 'ping/g430/g430-hybrid/v1', null, null, 'G430', 'g430', null),
  ('b511a912-f614-5198-9374-733f0609626e', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G430 Irons', 'g430-irons', 'pingg430irons', null, '{}'::jsonb, true, 'ping/g430/g430-irons/v1', null, null, 'G430', 'g430', null),
  ('1a8f6533-0d20-5900-b2fc-697079fef786', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G430 LST Driver', 'g430-lst-driver', 'pingg430lstdriver', null, '{}'::jsonb, true, 'ping/g430/g430-lst-driver/v1', null, null, 'G430', 'g430', null),
  ('7bd7eda6-2639-5475-be7c-27067c968d43', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G430 LST Fairway', 'g430-lst-fairway', 'pingg430lstfairway', null, '{}'::jsonb, true, 'ping/g430/g430-lst-fairway/v1', null, null, 'G430', 'g430', null),
  ('35a1a9a7-475e-5726-929f-2208b42acd9c', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G430 MAX 10K Driver', 'g430-max-10k-driver', 'pingg430max10kdriver', null, '{}'::jsonb, true, 'ping/g430/g430-max-10k-driver/v1', null, null, 'G430', 'g430', null),
  ('48f807eb-ae6c-5522-97c2-6a1e5890a790', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G430 MAX Driver', 'g430-max-driver', 'pingg430maxdriver', null, '{}'::jsonb, true, 'ping/g430/g430-max-driver/v1', null, null, 'G430', 'g430', null),
  ('f6c1aa75-0c86-595f-b56b-4d177e9f94ba', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G430 MAX Fairway', 'g430-max-fairway', 'pingg430maxfairway', null, '{}'::jsonb, true, 'ping/g430/g430-max-fairway/v1', null, null, 'G430', 'g430', null),
  ('cf89941a-e969-58ac-a9ba-23ef86d6a802', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G430 SFT Driver', 'g430-sft-driver', 'pingg430sftdriver', null, '{}'::jsonb, true, 'ping/g430/g430-sft-driver/v1', null, null, 'G430', 'g430', null),
  ('d61b0595-a6f4-551f-8d09-d96435546494', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G430 SFT Fairway', 'g430-sft-fairway', 'pingg430sftfairway', null, '{}'::jsonb, true, 'ping/g430/g430-sft-fairway/v1', null, null, 'G430', 'g430', null),
  ('a6bb67ec-f7be-5fb2-bd05-1220cecf5eae', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G440 Irons', 'g440-irons', 'pingg440irons', null, '{}'::jsonb, true, 'ping/g440/g440-irons/v1', null, null, 'G440', 'g440', null),
  ('85f548bf-3506-56e1-b4b6-cb6f086d61c8', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G440 K Driver', 'g440-k-driver', 'pingg440kdriver', null, '{}'::jsonb, true, 'ping/g440/g440-k-driver/v1', null, null, 'G440', 'g440', null),
  ('d8678bd9-d4e6-50af-9d66-3463f7d32a4e', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G440 LST Driver', 'g440-lst-driver', 'pingg440lstdriver', null, '{}'::jsonb, true, 'ping/g440/g440-lst-driver/v1', null, null, 'G440', 'g440', null),
  ('9a11bf45-481c-57cf-8ee9-5388b2eaf1e0', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G440 LST Fairway', 'g440-lst-fairway', 'pingg440lstfairway', null, '{}'::jsonb, true, 'ping/g440/g440-lst-fairway/v1', null, null, 'G440', 'g440', null),
  ('9705d01e-cccd-59c8-aea5-f76c1a74d541', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G440 SFT Driver', 'g440-sft-driver', 'pingg440sftdriver', null, '{}'::jsonb, true, 'ping/g440/g440-sft-driver/v1', null, null, 'G440', 'g440', null),
  ('eab68b2e-2846-575e-942d-4f25ab7388f9', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G440 SFT Fairway', 'g440-sft-fairway', 'pingg440sftfairway', null, '{}'::jsonb, true, 'ping/g440/g440-sft-fairway/v1', null, null, 'G440', 'g440', null),
  ('b68336b3-9158-52d9-84d1-7fdfd6d76aaf', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G730 Irons', 'g730-irons', 'pingg730irons', null, '{}'::jsonb, true, 'ping/g730/g730-irons/v1', null, null, 'G730', 'g730', null),
  ('f43d7bfe-f55d-53d8-ad26-ea457dc44b29', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING G740 Irons', 'g740-irons', 'pingg740irons', null, '{}'::jsonb, true, 'ping/g740/g740-irons/v1', null, null, 'G740', 'g740', null),
  ('749abd44-e790-5799-ab4f-ab14f90472bf', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING i230 Irons', 'i230-irons', 'pingi230irons', null, '{}'::jsonb, true, 'ping/i230/i230-irons/v1', null, null, 'i230', 'i230', null),
  ('16493a42-ec59-5ca6-b2ef-b3c1f4ae41a5', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING i530 Irons', 'i530-irons', 'pingi530irons', null, '{}'::jsonb, true, 'ping/i530/i530-irons/v1', null, null, 'i530', 'i530', null),
  ('9d9377fe-10f3-5e3f-a606-601becedae29', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING i540 Irons', 'i540-irons', 'pingi540irons', null, '{}'::jsonb, true, 'ping/i540/i540-irons/v1', null, null, 'i540', 'i540', null),
  ('2686fccf-2a7a-5a54-82ce-16f5e3f4e93b', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wedge'::public.club_type_enum, 'PING s159 Wedge', 's159-wedge', 'pings159wedge', null, '{}'::jsonb, true, 'ping/s159/s159-wedge/v1', null, null, 's159', 's159', null),
  ('4e984976-224e-51b7-a4e1-371f62351c60', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade Hi-Toe 4 Wedge', 'hi-toe-4-wedge', 'taylormadehitoe4wedge', null, '{}'::jsonb, true, 'taylormade/hi-toe-4/hi-toe-4-wedge/v1', null, null, 'Hi-Toe 4', 'hi-toe-4', null),
  ('e3d60884-aca8-5ccf-93ca-31aa9178ed37', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade Hi-Toe 5 Wedge', 'hi-toe-5-wedge', 'taylormadehitoe5wedge', null, '{}'::jsonb, true, 'taylormade/hi-toe-5/hi-toe-5-wedge/v1', null, null, 'Hi-Toe 5', 'hi-toe-5', null),
  ('6a0cf05f-ae20-5a59-ac49-650feb4982cd', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Kalea Gold Women''s Driver', 'kalea-gold-womens-driver', 'taylormadekaleagoldwomensdriver', null, '{}'::jsonb, true, 'taylormade/kalea-gold/kalea-gold-womens-driver/v1', null, null, 'Kalea Gold', 'kalea-gold', null),
  ('eaffecc7-e418-5d4e-8a2b-9318686f12af', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Kalea Gold Women''s Fairway', 'kalea-gold-womens-fairway', 'taylormadekaleagoldwomensfairway', null, '{}'::jsonb, true, 'taylormade/kalea-gold/kalea-gold-womens-fairway/v1', null, null, 'Kalea Gold', 'kalea-gold', null),
  ('58970b05-dd5d-5719-8f5a-1ba8aea00020', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade Kalea Gold Women''s Irons', 'kalea-gold-womens-irons', 'taylormadekaleagoldwomensirons', null, '{}'::jsonb, true, 'taylormade/kalea-gold/kalea-gold-womens-irons/v1', null, null, 'Kalea Gold', 'kalea-gold', null),
  ('7e3363b2-e91b-59de-b2f5-cb2b0877116c', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade Kalea Gold Women''s Rescue', 'kalea-gold-womens-rescue', 'taylormadekaleagoldwomensrescue', null, '{}'::jsonb, true, 'taylormade/kalea-gold/kalea-gold-womens-rescue/v1', null, null, 'Kalea Gold', 'kalea-gold', null),
  ('735a54d8-10b1-5d60-8fb8-859eef57b6a2', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade Milled Grind Chrome Wedge', 'milled-grind-chrome-wedge', 'taylormademilledgrindchromewedge', null, '{}'::jsonb, true, 'taylormade/milled-grind/milled-grind-chrome-wedge/v1', null, null, 'Milled Grind', 'milled-grind', null),
  ('83d88f21-4c2b-53e8-835d-409705c7aa41', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade P·770 Irons', 'p770-irons', 'taylormadep770irons', null, '{}'::jsonb, true, 'taylormade/p770/p770-irons/v1', null, null, 'P·770', 'p770', null),
  ('fa8525ea-50dd-57b3-b1d8-ca5a9cd07da8', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade P·7CB Irons', 'p7cb-irons', 'taylormadep7cbirons', null, '{}'::jsonb, true, 'taylormade/p7cb/p7cb-irons/v1', null, null, 'P·7CB', 'p7cb', null),
  ('24630ceb-a81d-582c-9db8-0ebf93bf558c', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade P·7MB Irons', 'p7mb-irons', 'taylormadep7mbirons', null, '{}'::jsonb, true, 'taylormade/p7mb/p7mb-irons/v1', null, null, 'P·7MB', 'p7mb', null),
  ('afed4a01-c1d1-5024-a2c2-ddbdb49ea6bd', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade P·7TW Irons', 'p7tw-irons', 'taylormadep7twirons', null, '{}'::jsonb, true, 'taylormade/p7tw/p7tw-irons/v1', null, null, 'P·7TW', 'p7tw', null),
  ('e6462a5d-f61a-5ae9-819e-fd8c52afb8a2', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade Qi Max HL Irons', 'qi-max-hl-irons', 'taylormadeqimaxhlirons', null, '{}'::jsonb, true, 'taylormade/qi-max/qi-max-hl-irons/v1', null, null, 'Qi Max', 'qi-max', null),
  ('92293d84-ca20-54bf-9658-66f87ea4de5d', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade Qi Max Irons', 'qi-max-irons', 'taylormadeqimaxirons', null, '{}'::jsonb, true, 'taylormade/qi-max/qi-max-irons/v1', null, null, 'Qi Max', 'qi-max', null),
  ('a4f694ab-b7aa-5a23-ba54-1aadeaa46bca', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade Qi Max Wedge', 'qi-max-wedge', 'taylormadeqimaxwedge', null, '{}'::jsonb, true, 'taylormade/qi-max/qi-max-wedge/v1', null, null, 'Qi Max', 'qi-max', null),
  ('4e8aa9a4-0e81-5fda-b717-040e027931f4', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade Qi HL Irons', 'qi-hl-irons', 'taylormadeqihlirons', null, '{}'::jsonb, true, 'taylormade/qi/qi-hl-irons/v1', null, null, 'Qi', 'qi', null),
  ('601b9616-9c17-5e52-aed6-85ab75eb6346', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade Qi Irons', 'qi-irons', 'taylormadeqiirons', null, '{}'::jsonb, true, 'taylormade/qi/qi-irons/v1', null, null, 'Qi', 'qi', null),
  ('091e4185-55b8-55ee-87a1-2c647792cfc9', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade Qi Wedge', 'qi-wedge', 'taylormadeqiwedge', null, '{}'::jsonb, true, 'taylormade/qi/qi-wedge/v1', null, null, 'Qi', 'qi', null),
  ('8e1ab005-5db0-5b2c-ab70-a3964f3e2a89', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi35 LS Driver', 'qi35-ls-driver', 'taylormadeqi35lsdriver', null, '{}'::jsonb, true, 'taylormade/qi35/qi35-ls-driver/v1', null, null, 'Qi35', 'qi35', null),
  ('7fbbd6fd-2eac-5c81-89e2-dd33c1b40f79', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi4D Driver', 'qi4d-driver', 'taylormadeqi4ddriver', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-driver/v1', null, null, 'Qi4D', 'qi4d', null),
  ('62a42b21-d712-5c21-93a6-be35f58b7647', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Qi4D Fairway', 'qi4d-fairway', 'taylormadeqi4dfairway', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-fairway/v1', null, null, 'Qi4D', 'qi4d', null),
  ('ca16a6cf-202d-573d-aeb8-5b6df35d1663', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi4D LS Driver', 'qi4d-ls-driver', 'taylormadeqi4dlsdriver', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-ls-driver/v1', null, null, 'Qi4D', 'qi4d', null),
  ('ef3e1ef2-3a83-516c-b81e-d61cd6a51201', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi4D Max Driver', 'qi4d-max-driver', 'taylormadeqi4dmaxdriver', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-driver/v1', null, null, 'Qi4D', 'qi4d', null),
  ('b9633f25-0a9b-5aba-8c6b-b0dd9896ba7e', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Qi4D Max Fairway', 'qi4d-max-fairway', 'taylormadeqi4dmaxfairway', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-fairway/v1', null, null, 'Qi4D', 'qi4d', null),
  ('9d96d702-0a74-5d04-bb6e-a52b274242af', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi4D Max Lite Driver', 'qi4d-max-lite-driver', 'taylormadeqi4dmaxlitedriver', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-lite-driver/v1', null, null, 'Qi4D', 'qi4d', null),
  ('354a28da-2423-55b3-9b30-690bfe96f375', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Qi4D Max Lite Fairway', 'qi4d-max-lite-fairway', 'taylormadeqi4dmaxlitefairway', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-lite-fairway/v1', null, null, 'Qi4D', 'qi4d', null),
  ('e5101e29-3c74-5dd7-8965-545dece65a27', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade Qi4D Max Lite Rescue', 'qi4d-max-lite-rescue', 'taylormadeqi4dmaxliterescue', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-lite-rescue/v1', null, null, 'Qi4D', 'qi4d', null),
  ('0e9ba0f3-6680-5cae-886e-b8a5d01b4f1e', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade Qi4D Max Rescue', 'qi4d-max-rescue', 'taylormadeqi4dmaxrescue', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-max-rescue/v1', null, null, 'Qi4D', 'qi4d', null),
  ('56bcb020-8d31-5a4b-aaf3-09a6c6541efd', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade Qi4D Rescue', 'qi4d-rescue', 'taylormadeqi4drescue', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-rescue/v1', null, null, 'Qi4D', 'qi4d', null),
  ('2ec3b958-a370-53a4-a598-d1602fc5e2ad', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Qi4D Tour Fairway', 'qi4d-tour-fairway', 'taylormadeqi4dtourfairway', null, '{}'::jsonb, true, 'taylormade/qi4d/qi4d-tour-fairway/v1', null, null, 'Qi4D', 'qi4d', null),
  ('8ebfa2ca-528c-508a-9dcf-db20008dd028', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade SIM2 Max Driver', 'sim2-max-driver', 'taylormadesim2maxdriver', null, '{}'::jsonb, true, 'taylormade/sim2-max/sim2-max-driver/v1', null, null, 'SIM2 Max', 'sim2-max', null),
  ('75a873e0-a838-5383-9ee8-1b568cbc838a', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade SIM2 Max Fairway', 'sim2-max-fairway', 'taylormadesim2maxfairway', null, '{}'::jsonb, true, 'taylormade/sim2-max/sim2-max-fairway/v1', null, null, 'SIM2 Max', 'sim2-max', null),
  ('f236d75d-8df9-5704-8631-2ddf182e7ac7', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade SIM2 Max Irons', 'sim2-max-irons', 'taylormadesim2maxirons', null, '{}'::jsonb, true, 'taylormade/sim2-max/sim2-max-irons/v1', null, null, 'SIM2 Max', 'sim2-max', null),
  ('651ef2c2-8675-54e3-9551-5ab51649d23b', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade SIM2 Max Rescue', 'sim2-max-rescue', 'taylormadesim2maxrescue', null, '{}'::jsonb, true, 'taylormade/sim2-max/sim2-max-rescue/v1', null, null, 'SIM2 Max', 'sim2-max', null),
  ('243a5336-3264-5e33-b1dc-55b6c446f406', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist 620 CB Irons', '620-cb-irons', 'titleist620cbirons', null, '{}'::jsonb, true, 'titleist/620-cb/620-cb-irons/v1', null, null, '620 CB', '620-cb', null),
  ('75385aa7-967c-5268-859f-3ea3ae83ba60', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist 620 MB Irons', '620-mb-irons', 'titleist620mbirons', null, '{}'::jsonb, true, 'titleist/620-mb/620-mb-irons/v1', null, null, '620 MB', '620-mb', null),
  ('420e3c1a-35b2-54fc-a402-ed8910efe65d', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wood'::public.club_type_enum, 'Titleist GT1 3Tour Fairway', 'gt1-3tour-fairway', 'titleistgt13tourfairway', null, '{}'::jsonb, true, 'titleist/gt1/gt1-3tour-fairway/v1', null, null, 'GT1', 'gt1', null),
  ('f935399f-414d-597d-99bd-84fd27a942e3', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Driver'::public.club_type_enum, 'Titleist GT1 Driver', 'gt1-driver', 'titleistgt1driver', null, '{}'::jsonb, true, 'titleist/gt1/gt1-driver/v1', null, null, 'GT1', 'gt1', null),
  ('ca09b7cf-49e3-58bd-a3c7-cdefda148378', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wood'::public.club_type_enum, 'Titleist GT1 Fairway', 'gt1-fairway', 'titleistgt1fairway', null, '{}'::jsonb, true, 'titleist/gt1/gt1-fairway/v1', null, null, 'GT1', 'gt1', null),
  ('63a6b026-ab70-5f4c-b3e2-cd08fcbd0054', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Hybrid'::public.club_type_enum, 'Titleist GT1 Hybrid', 'gt1-hybrid', 'titleistgt1hybrid', null, '{}'::jsonb, true, 'titleist/gt1/gt1-hybrid/v1', null, null, 'GT1', 'gt1', null),
  ('2156ab5e-589a-508b-ac2b-cd50e9bb3085', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Hybrid'::public.club_type_enum, 'Titleist GT3 Hybrid', 'gt3-hybrid', 'titleistgt3hybrid', null, '{}'::jsonb, true, 'titleist/gt3/gt3-hybrid/v1', null, null, 'GT3', 'gt3', null),
  ('50754396-7a29-5e25-a178-2a56e81671b1', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Driver'::public.club_type_enum, 'Titleist GTS2 Driver', 'gts2-driver', 'titleistgts2driver', null, '{}'::jsonb, true, 'titleist/gts2/gts2-driver/v1', null, null, 'GTS2', 'gts2', null),
  ('6cba22b7-d6f4-5562-b99f-cd994f2418d6', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wood'::public.club_type_enum, 'Titleist GTS2 Fairway', 'gts2-fairway', 'titleistgts2fairway', null, '{}'::jsonb, true, 'titleist/gts2/gts2-fairway/v1', null, null, 'GTS2', 'gts2', null),
  ('304b009c-865c-5d36-bb06-e05ce893abbc', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Driver'::public.club_type_enum, 'Titleist GTS3 Driver', 'gts3-driver', 'titleistgts3driver', null, '{}'::jsonb, true, 'titleist/gts3/gts3-driver/v1', null, null, 'GTS3', 'gts3', null),
  ('a2d37982-a9c2-5883-8d67-cdf47aa3ae83', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wood'::public.club_type_enum, 'Titleist GTS3 Fairway', 'gts3-fairway', 'titleistgts3fairway', null, '{}'::jsonb, true, 'titleist/gts3/gts3-fairway/v1', null, null, 'GTS3', 'gts3', null),
  ('35aa8696-4239-55e1-9084-d8a295196a29', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Driver'::public.club_type_enum, 'Titleist GTS4 Driver', 'gts4-driver', 'titleistgts4driver', null, '{}'::jsonb, true, 'titleist/gts4/gts4-driver/v1', null, null, 'GTS4', 'gts4', null),
  ('75b2f743-936b-5e75-bbe8-decc15aa2ab7', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist T100 Irons', 't100-irons', 'titleistt100irons', null, '{}'::jsonb, true, 'titleist/t100/t100-irons/v1', null, null, 'T100', 't100', null),
  ('ddf0eda4-aabd-5119-8d3e-faf9a67ccada', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist T150 Irons', 't150-irons', 'titleistt150irons', null, '{}'::jsonb, true, 'titleist/t150/t150-irons/v1', null, null, 'T150', 't150', null),
  ('86debd79-f05d-5d77-b305-2a1829da09c8', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist T250 Launch Spec Irons', 't250-launch-spec-irons', 'titleistt250launchspecirons', null, '{}'::jsonb, true, 'titleist/t250/t250-launch-spec-irons/v1', null, null, 'T250', 't250', null),
  ('0a01f510-87fa-5dfb-be6d-d5d947dbfc18', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist T350 Irons', 't350-irons', 'titleistt350irons', null, '{}'::jsonb, true, 'titleist/t350/t350-irons/v1', null, null, 'T350', 't350', null);

-- ----------------------------------------------------------------------------
-- 2. Official identity provenance (201 rows, one per model)
--
-- Every row cites a directly observed official manufacturer resource that
-- establishes the product's identity. No performance claim, loft, shaft option,
-- price or marketing statement is imported from any of them. Exactly one row
-- uses the official_category_page class, for the single model whose product
-- page, specification PDF and archive were all exhausted.
-- ----------------------------------------------------------------------------

insert into public.equipment_model_sources (
  id, equipment_model_id, source_type, source_name, source_url, verified_at
)
values
  ('8f0f6e13-6a5d-527c-9244-31e71b7720ef', 'b028d022-3e32-5500-a14c-e2428a1f5992', 'official_product_page', 'Callaway Apex Ai150 Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-apex-ai150.html', '2026-09-04'::date),
  ('6d823947-9004-5822-9128-1452d0edde8a', '8ff69801-de0f-5ef4-b572-a6ef300d3ae7', 'official_product_page', 'Callaway Apex Ai200 Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ai200.html', '2026-09-04'::date),
  ('58c7bc52-5a04-5e42-b2b3-de6908f227bc', 'f0da3045-0914-5df2-976b-a3c04d75534a', 'official_product_page', 'Callaway Apex Ai300 Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ai300.html', '2026-09-04'::date),
  ('655b115a-0315-5055-be9e-299712d15521', 'babe39f1-8eda-5f19-9b8a-0b1614118f6a', 'official_product_page', 'Callaway Apex CB Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-cb-chrome.html', '2026-09-04'::date),
  ('bb50b066-6320-5ce1-b4dc-928d720bbfaf', '3990104d-2c42-52ad-b599-a268e51c6109', 'official_product_page', 'Callaway Apex MB Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-mb-chrome.html', '2026-09-04'::date),
  ('a8db3ef1-627d-5ad6-b2da-5fa6caee94a0', '029d4d22-5041-5ff0-9c85-ea05eda1f32e', 'official_product_page', 'Callaway Apex Pro Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-pro.html', '2026-09-04'::date),
  ('63f16e0b-4a80-5536-ba97-a7a0e24c429d', 'b8b18d5a-eac7-5130-88c1-121182ef02e4', 'official_product_page', 'Callaway Apex TCB ''24 Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-tcb.html', '2026-09-04'::date),
  ('d2bb6399-9c24-52ff-967d-b903011c632d', '18483ceb-8993-5180-bf47-c3a86a6e0193', 'official_product_page', 'Callaway Apex Ti Fusion 250 Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-apex-ti-fusion-250.html', '2026-09-04'::date),
  ('d090a117-ed27-5e18-9489-e047f4b797e8', '0c0d2a68-3ce7-51ea-a247-d5274917191c', 'official_product_page', 'Callaway Apex Ti Fusion Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ti-fusion.html', '2026-09-04'::date),
  ('4b2e068a-5770-54ef-87f7-feb7decf6816', 'c7756a1f-5782-5a64-96ef-47d0bba558a5', 'official_product_page', 'Callaway Apex Ti Super Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-apex-ti-super.html', '2026-09-04'::date),
  ('a7e407ea-0d0f-587d-9651-4ca1301fa9d7', 'edfc0db0-88a5-5d1c-8d4b-ee367c0a6de1', 'official_product_page', 'Callaway Women''s Big Bertha REVA Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2023-big-bertha-reva-womens.html', '2026-09-04'::date),
  ('dc4c41fa-58cf-59f9-8768-22fc076c44db', '78032edb-8c5f-58b2-b736-7cbfc547b92e', 'official_product_page', 'Callaway Women''s Big Bertha REVA Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-big-bertha-reva-womens.html', '2026-09-04'::date),
  ('b9f78d7b-b63e-5b82-8734-4705e675eb37', 'd5e59e6d-c200-54ea-9c5c-ad6269d1a273', 'official_product_page', 'Callaway Big Bertha Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-big-bertha.html', '2026-09-04'::date),
  ('59b8c760-82b0-548e-932a-849b9b22d286', 'eb194721-0975-5ef3-ba40-3763bcc85c5a', 'official_product_page', 'Callaway Big Bertha Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-big-bertha.html', '2026-09-04'::date),
  ('28189bff-fe08-52a7-8bfe-176f32caad45', 'cda8badb-df33-5ae0-93c8-4ea76d6cb3f9', 'official_product_page', 'Callaway Big Bertha Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2023-big-bertha.html', '2026-09-04'::date),
  ('e0a6e9e5-5986-5520-b1e9-e9cbeb78c304', '0c9174c6-79a6-5abe-bf3e-e83d8f1937a2', 'official_product_page', 'Callaway CB 12 Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2025-cb12.html', '2026-09-04'::date),
  ('ca126f4a-9954-52a3-b9b5-ecab44468c91', 'a527bb01-9a82-5174-9d7a-fa7600811ef2', 'official_product_page', 'Callaway Elyte Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte.html', '2026-09-04'::date),
  ('9a4bd6ad-8cda-5de6-bc78-7e366be288eb', '69208ba5-84ce-50ce-b70f-4e662f48beef', 'official_product_page', 'Callaway Elyte Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte.html', '2026-09-04'::date),
  ('cf817270-9074-5279-8336-01501081f7cb', 'd719ac7f-1043-5fa4-85c2-ce20477f1b00', 'official_product_page', 'Callaway Elyte HL Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-hl.html', '2026-09-04'::date),
  ('3105c89a-220e-5f37-8a0a-29c435a478a3', '82a66c14-d986-599b-91ce-f28a9867b97d', 'official_product_page', 'Callaway Elyte Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte.html', '2026-09-04'::date),
  ('127fa12b-6242-520b-9673-5f32d904453e', '42070948-0e20-57aa-bed3-ac43cb6df7e9', 'official_product_page', 'Callaway Elyte Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte.html', '2026-09-04'::date),
  ('92f36b47-8326-5478-9598-a90182a916bc', '933038e5-b98c-5c6a-83ce-c2185336ec1c', 'official_product_page', 'Callaway Elyte Max Fast Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-max-fast.html', '2026-09-04'::date),
  ('298caf45-57aa-5bc4-bc02-9f631960e927', '74b7a033-260a-5e74-9f4b-979fb208262f', 'official_product_page', 'Callaway Elyte Max Fast Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2025-elyte-max-fast.html', '2026-09-04'::date),
  ('012b31c4-c691-51a0-bfcc-5fa9876905fb', 'f8cebc1f-4004-5bc9-9336-23c3869073f5', 'official_product_page', 'Callaway Elyte Max Fast Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte-max-fast.html', '2026-09-04'::date),
  ('5b91b0c7-6121-55eb-9786-7fd5f253954c', '2c6ad879-53a3-59fb-a514-4325721980b4', 'official_product_page', 'Callaway Elyte Max Fast Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-max-fast.html', '2026-09-04'::date),
  ('e89281ad-3ea0-5c88-b25d-6ed877b38ab9', 'e46ac34b-b019-5680-b16d-6081205ef91f', 'official_product_page', 'Callaway Elyte Titanium Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-ti.html', '2026-09-04'::date),
  ('a4c6bfbd-d6cc-5078-bfcf-bd7530ad6859', 'fced413f-a328-5138-9610-dd3fdfdc9871', 'official_product_page', 'Callaway Elyte Triple Diamond Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-td.html', '2026-09-04'::date),
  ('82137e4c-832c-51f3-ba79-74a8dcc8a44d', '4643ecd9-b18f-5dac-bc6e-21ba0b50c27a', 'official_product_page', 'Callaway Elyte Triple Diamond Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-td.html', '2026-09-04'::date),
  ('b8326c32-7fcd-5a18-92e5-c31989781f46', '2d533c58-ed5c-587a-8755-378d3f9fcaa3', 'official_product_page', 'Callaway Elyte X Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-x.html', '2026-09-04'::date),
  ('3e873163-ba8a-582c-b2c9-f3aa43e4f23b', '1d37940f-bbcc-5683-be5f-8009b0c87fdb', 'official_product_page', 'Callaway Elyte X Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-x.html', '2026-09-04'::date),
  ('7430e11e-064f-54d2-a9de-e6bb94543961', '84e58ebc-eb45-5686-aa7d-c8fe3ae46c94', 'official_product_page', 'Callaway Elyte X Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte-x.html', '2026-09-04'::date),
  ('e367d74b-158c-5444-a776-6e15fcffa88f', '8bc3aa28-f8bf-5144-86fa-c0774d96adbf', 'official_product_page', 'Callaway Elyte X Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-x.html', '2026-09-04'::date),
  ('2d3f857c-3028-537f-83e6-c81284071e3c', '04260143-0065-5d99-bd8e-f014e7d80339', 'official_product_page', 'Callaway Full Toe SP Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-full-toe-sp-chrome.html', '2026-09-04'::date),
  ('8b12656d-5572-530d-b380-3860eb79a7ec', '0745d40e-9c25-57b8-9a2a-94accdda33a0', 'official_product_page', 'Callaway Great Big Bertha Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-gbb.html', '2026-09-04'::date),
  ('c8d8f67d-4f75-57cc-b79b-58ce4c2cf736', 'a1efbde6-68f3-51df-8645-310ef3845ba1', 'official_product_page', 'Callaway Great Big Bertha Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-gbb.html', '2026-09-04'::date),
  ('06d6c93d-06c1-5b92-a8ce-b20a0aae2812', '08c17240-0efc-5caa-bb12-05472e4f341d', 'official_product_page', 'Callaway Jaws Raw Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2022-jaws-raw-chrome.html', '2026-09-04'::date),
  ('62effe6d-55cb-5c21-876e-72de959d1e83', 'bb6201c4-0dd6-50d2-a2df-ba09e4a35715', 'official_product_page', 'Callaway Women''s MAVRIK MAX W Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2022-mavrik-max-womens.html', '2026-09-04'::date),
  ('46b134d2-d95b-59ee-8709-d12668b426b9', '7f294239-851d-52e9-8d81-148f4ec78182', 'official_product_page', 'Callaway MAVRIK Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2022-mavrik.html', '2026-09-04'::date),
  ('73188ca3-5f21-5aee-be54-93619d424e08', '5811c7ed-69ef-5839-ba28-b8384a8c23b9', 'official_product_page', 'Callaway MAVRIK Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2022-mavrik.html', '2026-09-04'::date),
  ('adfc9e5d-d0a0-517d-9eac-3d7b9dce74f7', '761d65a1-cb5f-5e04-a4e0-d2ea331a6508', 'official_product_page', 'Callaway MAVRIK Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2022-mavrik.html', '2026-09-04'::date),
  ('03779891-5b17-5778-8bc2-d4ffd56d4c4c', 'b8328a0d-8464-59e2-9632-292fdf5f9d60', 'official_product_page', 'Callaway Opus Platinum Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2024-opus-platinum-chrome.html', '2026-09-04'::date),
  ('1709d877-3bb4-5b2c-ba0d-341cdba05f53', 'efbfefca-e301-54c9-8a0b-9dff7bfc852d', 'official_product_page', 'Callaway Opus SP+ Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-opus-sp-plus-chrome.html', '2026-09-04'::date),
  ('fe77aba9-c2e5-5a83-b88d-53383ecd5b5a', '7859464f-7ee1-53e1-8fd5-9a67290349cd', 'official_product_page', 'Callaway Opus Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2024-opus-chrome.html', '2026-09-04'::date),
  ('99ad0772-4c29-5a8a-886d-d0d3ad654b63', '7c8fc797-a0b2-5be5-85e5-484172864d26', 'official_product_page', 'Callaway Paradym Ai Smoke HL Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2024-paradym-ai-smoke-hl.html', '2026-09-04'::date),
  ('7287cf28-7cea-52a4-b40b-75fdd9f16551', '3b561a07-dd3c-5d5a-b18d-a96c11e383aa', 'official_product_page', 'Callaway Paradym Ai Smoke HL Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke-hl.html', '2026-09-04'::date),
  ('868ed0df-8d6e-5fcf-996a-4ca848437602', '8d82cc7a-95d5-5e19-b41d-98f8cadd62d5', 'official_product_page', 'Callaway Paradym Ai Smoke Hybrid official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2024-paradym-ai-smoke.html', '2026-09-04'::date),
  ('24049173-cf65-5c35-ac43-421b6311aeed', '0dedcb5d-de2c-5ab8-9560-e18530a7e058', 'official_product_page', 'Callaway Paradym Ai Smoke Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke.html', '2026-09-04'::date),
  ('a28358c3-6705-5bd4-ac85-08b7ea19cf64', 'f69d112d-f8c9-5575-b8e0-bf48bc80a219', 'official_product_page', 'Callaway Paradym Ai Smoke MAX Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2024-paradym-ai-smoke-max.html', '2026-09-04'::date),
  ('2e3c8e6f-fd05-5b45-9d7a-82f4f781f3d9', '56d9d71f-d294-5d2a-b2f6-313472868376', 'official_product_page', 'Callaway Paradym Ai Smoke MAX Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2024-paradym-ai-smoke-max.html', '2026-09-04'::date),
  ('3eb6ec3c-7681-556d-a664-b0ce616633fc', '5d69f27d-d883-5882-9bb7-bb39a9f00729', 'official_product_page', 'Callaway Paradym Ai Smoke MAX Fast Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke-max-fast.html', '2026-09-04'::date),
  ('a2fd3238-33f6-5112-b0ac-fc0f2d05b3f0', '6db9cb72-8e72-5cea-be27-23ccf4c9432c', 'official_product_page', 'Callaway Paradym Super Hybrid official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-paradym-super.html', '2026-09-04'::date),
  ('59987507-fe6d-57b9-b0e6-b476392b5128', 'fef96cf9-98b0-561a-bad8-6a89de62b847', 'official_product_page', 'Callaway Paradym Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-paradym.html', '2026-09-04'::date),
  ('a0578544-16b7-5593-841b-461ee85e3902', '914a07cf-6e53-5649-9e5a-3bf681eeb259', 'official_product_page', 'Callaway Paradym Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2023-paradym.html', '2026-09-04'::date),
  ('dff8f8e6-7429-5339-833f-ccbb0ecbd898', '61a09ec5-ce04-59c3-8b17-bcb1686f352a', 'official_product_page', 'Callaway Quantum Max D Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max-d.html', '2026-09-04'::date),
  ('34c6a950-cd79-5367-a26a-2b596617085e', '58c915e3-11c2-573c-bf25-6be9e9b6a86d', 'official_product_page', 'Callaway Quantum Max D Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max-d.html', '2026-09-04'::date),
  ('f66db156-ef3f-5572-8773-0abd1f5cce00', '865360d5-075b-5a17-9c56-d505c6609937', 'official_product_page', 'Callaway Quantum Max Fast Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max-fast.html', '2026-09-04'::date),
  ('d6145824-a713-50bf-9862-48a447e91a31', '92460ed2-18fa-5cd0-a6cc-a0d4d63578e7', 'official_product_page', 'Callaway Quantum Max Fast Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max-fast.html', '2026-09-04'::date),
  ('3e112d32-a9b4-5b68-9f75-6c56e58d37a5', '0a8a3502-6e4e-523f-a18c-f4636d2faed1', 'official_product_page', 'Callaway Quantum Max Fast Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max-fast.html', '2026-09-04'::date),
  ('4ae9b1c6-d099-5e77-a088-052bc7765af5', '95fd87d7-e3f1-5753-917c-a25f5ed23578', 'official_product_page', 'Callaway Quantum Max Fast Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max-fast.html', '2026-09-04'::date),
  ('0e140685-cd2e-5043-9606-def4ea4706ba', 'd217ce69-f1bb-543d-8490-9f8777a89100', 'official_product_page', 'Callaway Quantum Max OS Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max-os.html', '2026-09-04'::date),
  ('23f40216-30ec-5f06-b118-4496a8b3a60d', 'e2fbff14-51e6-521f-b0a1-4ae16cb2d530', 'official_product_page', 'Callaway Quantum Max OS Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max-os.html', '2026-09-04'::date),
  ('90a067be-1242-54fd-abf8-6c37bd4679b5', '146e00cb-22f2-5c76-8c50-ecca1465065e', 'official_product_page', 'Callaway Quantum Max OS Wedges official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-quantum-max-os.html', '2026-09-04'::date),
  ('a2d9315c-de99-59bb-8212-8ec9061f4a69', '9bf9bcd6-881e-5776-a1a0-0a1366a39878', 'official_product_page', 'Callaway Quantum Max Wedges official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-quantum-max.html', '2026-09-04'::date),
  ('d589a7fc-86a7-50f3-b615-131d02ce1d7b', 'f8997505-913f-53c6-b21b-b84c5a8f67c7', 'official_product_page', 'Callaway Quantum Mini Spinner Fairway Wood official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-mini-spinner.html', '2026-09-04'::date),
  ('73d9334a-d84c-5700-9e35-a5d2961379b0', '3477a641-a588-5ccd-b44c-b0cd6845c851', 'official_product_page', 'Callaway Quantum Ti Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-ti.html', '2026-09-04'::date),
  ('dc1142fd-191c-5663-a2e3-16fd2332118a', '10466a4f-3181-534c-99ed-abb9692b2543', 'official_product_page', 'Callaway Quantum Triple Diamond Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-triple-diamond.html', '2026-09-04'::date),
  ('f8af860f-c1c1-562a-bd07-bfdbe638065f', '0cee0a4c-1f70-54ac-93b1-4d6f80241bc5', 'official_product_page', 'Callaway Quantum Triple Diamond Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-triple-diamond.html', '2026-09-04'::date),
  ('6ad1e29d-d02d-56ed-a6b0-69f56aae4511', 'a9d2f5e9-fecd-541b-81ec-17d0734193e3', 'official_product_page', 'Callaway Quantum Triple Diamond Max Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-triple-diamond-max.html', '2026-09-04'::date),
  ('c9782ba8-45c4-507e-8fa5-0c933f0aa387', '0ff98956-3645-54cf-859d-9748512cfeea', 'official_product_page', 'Callaway REVA RISE Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-reva-rise-womens.html', '2026-09-04'::date),
  ('d9885ea4-6f6d-5c15-a0c2-690ae6eb4fd7', 'cef00c69-9325-5cbe-8f1f-0bc7f3cfaa0f', 'official_product_page', 'Callaway REVA RISE Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-reva-rise-womens.html', '2026-09-04'::date),
  ('a3d8fdab-2d29-50c8-9bcf-5bd295c8aa9c', '4534a953-11c9-5e41-a85f-99cb4794ee49', 'official_product_page', 'Callaway REVA RISE Hybrid official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-reva-rise-womens.html', '2026-09-04'::date),
  ('5a805a0d-ece4-5d98-aa8c-d550762249f3', '40ddaff2-639b-55ce-b0f6-10bb008790b8', 'official_product_page', 'Callaway REVA RISE Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-reva-rise-womens.html', '2026-09-04'::date),
  ('1a751d6c-b540-5381-a57c-9622e63e7170', '8ae75d35-b2cc-5784-a968-6660df188880', 'official_product_page', 'Callaway Rogue ST ''24 MAX Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-rogue-st-max.html', '2026-09-04'::date),
  ('7730a34c-3d70-5b56-ab00-0662822be04e', '8b9e0675-0266-5abb-b479-dd5d57e61998', 'official_product_page', 'Callaway Rogue ST MAX D Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2022-rogue-st-max-d.html', '2026-09-04'::date),
  ('4f3dfcca-2eb3-5f53-8c33-dc242365671a', 'bfe75eb6-fa86-5177-bb19-619b204c2216', 'official_product_page', 'Callaway Rogue ST MAX OS Lite Irons official product page', 'https://www.callawaygolf.com/golf-clubs/iron-sets/irons-2022-rogue-st-max-os-lite.html', '2026-09-04'::date),
  ('ecfc6275-cd32-56c5-a3e0-e306232b1a62', 'a4c5bd7d-182b-5706-88d6-605f77d2f78f', 'official_product_page', 'Callaway X Forged Max Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-x-forged-max.html', '2026-09-04'::date),
  ('68c43af0-176f-59b0-9847-3b4889b7159d', 'b193bce0-5201-5485-a343-d736efe8752a', 'official_product_page', 'Callaway X Forged Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-x-forged.html', '2026-09-04'::date),
  ('24d62345-9e0e-51ef-a21b-3402fee0ef5b', 'a7b7cc32-67f7-5bc5-9067-67c792140913', 'official_product_page', 'Cobra 3DP MB Irons official product page', 'https://www.cobragolf.com/products/cobra-3dp-mb-irons', '2026-09-04'::date),
  ('690f13ba-83f1-5d81-a460-934600d911bd', 'f19314a3-6eea-5d7e-81f5-151c9769fd90', 'official_product_page', 'Cobra 3DP Tour Irons official product page', 'https://www.cobragolf.com/products/cobra-3dp-tour-irons', '2026-09-04'::date),
  ('cbe23aa5-95bd-533e-bf9f-bb9392806b51', '80bbc6a4-5320-5dc8-84f3-7790db9c2e0b', 'official_product_page', 'Cobra 3DP X Irons official product page', 'https://www.cobragolf.com/products/cobra-3dp-x-irons', '2026-09-04'::date),
  ('9cb83173-ccff-5f23-96ba-3eceb546ff9d', '00b95f2c-c3f0-5235-8645-e9b8c65afda7', 'official_product_page', 'Cobra BAFFLER Hybrid official product page', 'https://www.cobragolf.com/products/baffler-hybrid', '2026-09-04'::date),
  ('af9a15b5-c14e-5cab-b526-fcd65c1c0bb1', '27561a0a-1e87-5158-acc3-78ab461beb7c', 'official_product_page', 'Cobra BAFFLER Irons official product page', 'https://www.cobragolf.com/products/baffler-hybrid-iron-combo-set', '2026-09-04'::date),
  ('1667ff40-d316-506f-8b77-e2cbb81090e3', 'a56d4605-5066-5f9a-ab6b-636af0f470f9', 'official_product_page', 'Cobra DARKSPEED LS Driver official product page', 'https://www.cobragolf.com/products/darkspeed-ls-driver', '2026-09-04'::date),
  ('3a408c74-abd5-5570-b607-c135ed122c4c', '4b3eed29-b4e5-51d3-b7a4-bfcfd53f1244', 'official_product_page', 'Cobra DARKSPEED LS Fairway official product page', 'https://www.cobragolf.com/products/darkspeed-ls-fairway', '2026-09-04'::date),
  ('9832612b-ffe5-5c5c-a9b3-b550dc76b519', 'af40ef79-01b9-542d-9b48-b0e8cbcf6b27', 'official_product_page', 'Cobra DARKSPEED MAX Fairway official product page', 'https://www.cobragolf.com/products/darkspeed-max-fairway', '2026-09-04'::date),
  ('832708e1-0857-57c9-8c35-b4e355c1e678', '2ee6e73f-d982-55ba-be98-a4ec14e9f58a', 'official_product_page', 'Cobra DARKSPEED X Driver official product page', 'https://www.cobragolf.com/products/darkspeed-x-driver', '2026-09-04'::date),
  ('562d3637-2fd3-53d9-85b3-7c223dc01354', '7dce54b9-00da-5dfb-b6bd-283d921b80ca', 'official_product_page', 'Cobra DARKSPEED X Fairway official product page', 'https://www.cobragolf.com/products/darkspeed-x-fairway', '2026-09-04'::date),
  ('bc9bc780-a5c5-5de9-abb4-aa4c9ac8f484', 'e5d04dae-ce01-53ba-86a5-2273138c18d6', 'official_product_page', 'Cobra DS-ADAPT Hybrid official product page', 'https://www.cobragolf.com/products/ds-adapt-hybrid', '2026-09-04'::date),
  ('9dfe5129-5f69-5733-b317-cf5f615a48cf', '68a5a46b-9944-5a60-9c02-041628545a27', 'official_product_page', 'Cobra DS-ADAPT LS Driver official product page', 'https://www.cobragolf.com/products/ds-adapt-ls-driver', '2026-09-04'::date),
  ('59897ab5-198c-5b74-b00c-fab7b3100fa8', 'a05a676d-bdc5-5d87-b3e2-eae11a4bd8bf', 'official_product_page', 'Cobra DS-ADAPT LS Fairway official product page', 'https://www.cobragolf.com/products/ds-adapt-ls-fairway', '2026-09-04'::date),
  ('8d13e038-82e3-58ca-ac91-91cb5f157598', 'adf4c508-a326-5c20-b3fe-549f6ae413ab', 'official_product_page', 'Cobra DS-ADAPT MAX-D Driver official product page', 'https://www.cobragolf.com/products/ds-adapt-max-d-driver', '2026-09-04'::date),
  ('e8f6f400-4d93-5c0a-a5a4-f819f5f196e7', '3e93f818-dc52-5daa-a3b7-1301d368f165', 'official_product_page', 'Cobra DS-ADAPT MAX Fairway official product page', 'https://www.cobragolf.com/products/ds-adapt-max-fairway', '2026-09-04'::date),
  ('af12fc41-bb39-5d7c-9392-6dca0e8b767c', 'eac93b66-2373-51c9-94b1-853056fbe8f5', 'official_product_page', 'Cobra DS-ADAPT MAX-K Driver official product page', 'https://www.cobragolf.com/products/ds-adapt-max-k-driver', '2026-09-04'::date),
  ('a46dc45c-def4-53b6-8e9d-f531e1949cd3', '01994c8a-df56-58b8-9825-912803e15d7b', 'official_product_page', 'Cobra DS-ADAPT X Driver official product page', 'https://www.cobragolf.com/products/ds-adapt-x-driver', '2026-09-04'::date),
  ('35926cea-d1b1-595f-b3c5-c28b9c9d6014', 'ef30c49b-3fa4-5e8a-9684-dbbb1639cfe8', 'official_product_page', 'Cobra DS-ADAPT X Fairway official product page', 'https://www.cobragolf.com/products/ds-adapt-x-fairway', '2026-09-04'::date),
  ('1fc5f75a-f344-561f-93be-6446e04c07b5', '5eaf77e9-e981-5598-bed9-e7535c3eeb6e', 'official_product_page', 'Cobra KING CB/MB Irons official product page', 'https://www.cobragolf.com/products/king-cb-mb-irons-2023', '2026-09-04'::date),
  ('beefca86-27c0-5c68-88aa-3ae4445b88c5', 'b4ef2e28-d055-5af4-ba8b-120b5f243338', 'official_product_page', 'Cobra KING MAX Irons official product page', 'https://www.cobragolf.com/products/king-max-irons', '2026-09-04'::date),
  ('b281383e-60f1-54fb-a609-1fc2e047934e', '4aa04bf1-4e95-51cf-b847-e44c047c1d7d', 'official_product_page', 'Cobra KING TEC X Irons official product page', 'https://www.cobragolf.com/products/king-tec-x-irons', '2026-09-04'::date),
  ('e332da2f-1172-5efa-8964-2f3d5aa842d6', '44e1dd98-0af7-5a5b-890f-9ed226db02b4', 'official_product_page', 'Cobra KING TEC-X ONE Length Hybrid official product page', 'https://www.cobragolf.com/products/king-tec-x-one-length-hybrid', '2026-09-04'::date),
  ('56c231e3-de85-52b6-9dc0-7b1935a99015', '1836380a-0724-55c2-8274-bcab8610f60d', 'official_product_page', 'Cobra KING TEC X ONE Length Irons official product page', 'https://www.cobragolf.com/products/king-tec-x-one-length-irons', '2026-09-04'::date),
  ('957ae4f4-3bd6-5b75-849d-4631172571f1', 'e0edb234-2fce-5885-a472-d3cb32171fec', 'official_product_page', 'Cobra KING TEC Hybrid official product page', 'https://www.cobragolf.com/products/king-tec-hybrid-2025', '2026-09-04'::date),
  ('cd5592eb-4a71-53e8-9ba5-d55653469e54', 'bed2d1b0-87d9-51a3-82ef-0b6849003df8', 'official_product_page', 'Cobra KING TEC Irons official product page', 'https://www.cobragolf.com/products/king-tec-irons', '2026-09-04'::date),
  ('a6c1952f-f4bf-5cfd-99c8-83536c74c1ab', '31067bf7-53dc-525e-b880-ac4e679ca93d', 'official_product_page', 'Cobra KING Tour Irons official product page', 'https://www.cobragolf.com/products/king-tour-irons-2023', '2026-09-04'::date),
  ('32b9e2ea-d5e3-5940-bbe0-d611fd8901d5', '811e1242-e388-5b0e-b0ef-1246dcfea6dd', 'official_product_page', 'Cobra KING-X Wedge official product page', 'https://www.cobragolf.com/products/king-x-wedge-2025', '2026-09-04'::date),
  ('3f6a552c-5505-5497-8cca-520af1835a84', 'ed3cedbf-d1ab-53b6-b5aa-527d935b176d', 'official_product_page', 'Cobra OPTM LS Driver official product page', 'https://www.cobragolf.com/products/optm-ls-driver', '2026-09-04'::date),
  ('39d9bcb0-504b-5821-af1d-0f461a55da91', '1a3fe3a1-6210-5f6b-8be1-328f4642260f', 'official_product_page', 'Cobra OPTM LS Titanium Fairway official product page', 'https://www.cobragolf.com/products/optm-ls-titanium-fairway', '2026-09-04'::date),
  ('8d2d8587-70f8-568d-9533-a55d70c20e88', 'ec41fa32-99de-547d-8ac8-46983fdf9a1e', 'official_product_page', 'Cobra OPTM MAX-D Driver official product page', 'https://www.cobragolf.com/products/optm-max-d-driver', '2026-09-04'::date),
  ('989c890e-699d-5144-b33e-ecbb2a37e13c', 'a01e8cf0-e097-5bf6-a587-c0013d99515a', 'official_product_page', 'Cobra OPTM MAX Fairway official product page', 'https://www.cobragolf.com/products/optm-max-fairway', '2026-09-04'::date),
  ('5da2bd04-baf1-5be0-aa6d-dc4df28bcafe', '5112d2b8-84fd-55da-889e-883842d87aab', 'official_product_page', 'Cobra OPTM X Driver official product page', 'https://www.cobragolf.com/products/optm-x-driver', '2026-09-04'::date),
  ('ae7df518-f18d-5994-bc9f-66cdd196bdb6', '420a7af8-ea58-524e-8054-7fe8123c0a37', 'official_product_page', 'Mizuno JPX ONE SELECT Driver official product page', 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-driver/', '2026-09-04'::date),
  ('95a144a8-b62c-58ef-9a45-2146336fb03d', '32ea55ff-c2dc-54ad-9a69-c1e407be08c5', 'official_product_page', 'Mizuno JPX925 Forged Irons official product page', 'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-forged/', '2026-09-04'::date),
  ('7e4da4e5-5557-5639-b080-2bbfab85e526', '513682f2-b4ad-5306-b611-857b2bba1d21', 'official_product_page', 'Mizuno JPX925 Hot Metal HL Irons official product page', 'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/', '2026-09-04'::date),
  ('baf5a5ac-6641-5bb6-8c86-c954a38d9152', '30e5500b-1f63-5a0b-bd96-73a46446ad9d', 'official_product_page', 'Mizuno JPX925 Hot Metal Pro Irons official product page', 'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/', '2026-09-04'::date),
  ('48668e19-1897-5ed8-b718-a73b2d4f245b', '7501380d-5777-563e-a360-2a35eb0d1896', 'official_product_page', 'Mizuno Pro M-13 Irons official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-m13/', '2026-09-04'::date),
  ('6bc30e32-8fa6-5abf-b3b4-1bd1e2858ade', 'ec006f05-17ed-5e2e-a7db-3afd5cb935a8', 'official_product_page', 'Mizuno Pro M-15 Irons official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-m15/', '2026-09-04'::date),
  ('b2c06a7e-ca92-5e84-8ae3-c2d4066be3b6', 'bf26de36-6446-5201-828a-47abad9d084d', 'official_product_page', 'Mizuno Pro S-1 Irons official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s1/', '2026-09-04'::date),
  ('3563d9c6-c545-5953-b591-770370e5ba48', '71672aba-8333-588e-acc3-91a6ef0c089e', 'official_product_page', 'Mizuno Pro S-3 Irons official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s3/', '2026-09-04'::date),
  ('47fa1db6-9ff3-54a5-9f8a-f8bd2d1c2f7c', 'e50284f1-af86-5f30-a596-6213517e23b7', 'official_product_page', 'Mizuno Pro S-4 Irons official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s4/', '2026-09-04'::date),
  ('529ab1e6-0f2b-5e8e-b114-2e51d6d4aed7', '8698abfb-0b93-5af9-abb5-abf597083ae8', 'official_product_page', 'Mizuno Pro T-1 Wedge official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-t1/', '2026-09-04'::date),
  ('43b41558-c85f-56a0-9ab9-d0b90148fd24', '8b86d75b-32d9-5903-81f6-479638f68728', 'official_category_page', 'Mizuno ST-Max Hybrid official category page', 'https://mizunogolf.com/us/hybrids/', '2026-09-04'::date),
  ('d349c6f6-2f49-5a54-9e0c-cdf43d76dd95', 'f99a48c4-1e7a-5e64-bd16-b7428f45a967', 'official_product_page', 'PING BLUEPRINT S Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/blueprint-s-iron', '2026-09-04'::date),
  ('a2911965-87a1-51a8-b289-3c9a68804b2b', '474867d8-9e79-5726-8cc4-ffef50ca3724', 'official_product_page', 'PING BLUEPRINT T Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/blueprint-t-iron', '2026-09-04'::date),
  ('2f01470a-6fd0-5727-83c8-1c1961c06a16', '603c535e-5732-567a-aa91-b5b7e602144f', 'official_product_page', 'PING BunkR Wedge official product page', 'https://ping.com/en-us/golf-clubs/wedges/bunkr-wedge', '2026-09-04'::date),
  ('2eedf167-33e4-53af-8a79-87fec5d50931', 'c318bfef-7ecb-5df9-bc50-e0609fc8184a', 'official_product_page', 'PING G Le3 Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g-le3-driver', '2026-09-04'::date),
  ('45e7b5b1-b627-5fa3-a83c-f8010244a285', '6de8a5a9-7746-520a-9dcf-e7d20fa4615f', 'official_product_page', 'PING G Le3 Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g-le3-fairway', '2026-09-04'::date),
  ('0e9f6cfd-ea7c-5496-8d14-11eea6066d87', '0a4d8f9a-a61c-5352-8457-2b3c01701e6d', 'official_product_page', 'PING G Le3 Hybrid official product page', 'https://ping.com/en-us/golf-clubs/irons/g-le3-iron', '2026-09-04'::date),
  ('6b5028d7-2c6e-568f-a9c7-319e64286ec5', '5f286b01-1ebb-5ece-af61-6e992b1db885', 'official_product_page', 'PING G Le3 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g-le3-iron', '2026-09-04'::date),
  ('b9b37819-8849-5101-937b-fd568fa322cc', '3ff70dc6-8e0b-5d74-b0e5-2a7722c22185', 'official_product_page', 'PING G Le4 Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g-le4-driver', '2026-09-04'::date),
  ('38bd8f75-a7aa-575e-bf1f-1f04301fd67e', 'f111c5f4-babb-52cf-a6eb-afe87642f10a', 'official_product_page', 'PING G Le4 Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g-le4-fairway', '2026-09-04'::date),
  ('da72fadc-bba5-5f7e-b125-9372ef4b6004', '015345a0-93a8-5e77-867f-5ec6293e568e', 'official_product_page', 'PING G Le4 Hybrid official product page', 'https://ping.com/en-us/golf-clubs/irons/g-le4-iron', '2026-09-04'::date),
  ('0543a75d-b2f9-5637-9231-0d0d338f6977', '51ad5f23-4310-5ef2-93f2-e3d76c8c9639', 'official_product_page', 'PING G Le4 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g-le4-iron', '2026-09-04'::date),
  ('5d1403b4-9edf-500e-a26d-e7935dcac695', '7eff920a-eb8b-5e42-8734-c61459416910', 'official_product_page', 'PING G430 Hybrid official product page', 'https://ping.com/en-us/golf-clubs/hybrids/g430-hybrid', '2026-09-04'::date),
  ('97202df8-b008-54cb-bf5c-9ab9556b575f', 'b511a912-f614-5198-9374-733f0609626e', 'official_product_page', 'PING G430 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g430-iron', '2026-09-04'::date),
  ('c2c11a75-fdb2-5759-b40c-4589f08a88a9', '1a8f6533-0d20-5900-b2fc-697079fef786', 'official_product_page', 'PING G430 LST Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g430-lst-driver', '2026-09-04'::date),
  ('e20e2927-261e-54d2-85b7-c78abbf1490e', '7bd7eda6-2639-5475-be7c-27067c968d43', 'official_product_page', 'PING G430 LST Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g430-lst-fairway', '2026-09-04'::date),
  ('11185190-c1d7-5dfe-98a4-d427452d0977', '35a1a9a7-475e-5726-929f-2208b42acd9c', 'official_product_page', 'PING G430 MAX 10K Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g430-max-10k-driver', '2026-09-04'::date),
  ('55fd02d1-f824-5a4c-a1b5-18c3e4bf1d5b', '48f807eb-ae6c-5522-97c2-6a1e5890a790', 'official_product_page', 'PING G430 MAX Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g430-max-driver', '2026-09-04'::date),
  ('e9e9eaa8-68d5-50e8-be7f-60256f768c68', 'f6c1aa75-0c86-595f-b56b-4d177e9f94ba', 'official_product_page', 'PING G430 MAX Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g430-max-fairway', '2026-09-04'::date),
  ('14440cea-103e-5751-be3a-3d17029b1706', 'cf89941a-e969-58ac-a9ba-23ef86d6a802', 'official_product_page', 'PING G430 SFT Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g430-sft-driver', '2026-09-04'::date),
  ('05554267-79c8-5cfe-a53a-a54b3ed06918', 'd61b0595-a6f4-551f-8d09-d96435546494', 'official_product_page', 'PING G430 SFT Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g430-sft-fairway', '2026-09-04'::date),
  ('11f70ea7-b149-5f88-abdd-64b14b46ec5b', 'a6bb67ec-f7be-5fb2-bd05-1220cecf5eae', 'official_product_page', 'PING G440 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g440-iron', '2026-09-04'::date),
  ('0f0e7e8c-0165-5188-b7ef-8de0640df55e', '85f548bf-3506-56e1-b4b6-cb6f086d61c8', 'official_product_page', 'PING G440 K Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g440-k-driver', '2026-09-04'::date),
  ('ce662271-1184-526a-85de-ef7aba2e4b9b', 'd8678bd9-d4e6-50af-9d66-3463f7d32a4e', 'official_product_page', 'PING G440 LST Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g440-lst-driver', '2026-09-04'::date),
  ('4f51a2ac-3c09-5331-a40e-ee6b6e695854', '9a11bf45-481c-57cf-8ee9-5388b2eaf1e0', 'official_product_page', 'PING G440 LST Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g440-lst-fairway', '2026-09-04'::date),
  ('aeef3f3b-27ea-54cb-ba2a-d23d5e8e4faa', '9705d01e-cccd-59c8-aea5-f76c1a74d541', 'official_product_page', 'PING G440 SFT Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g440-sft-driver', '2026-09-04'::date),
  ('88ae1bb4-5531-5565-a5c2-c15dad347e6f', 'eab68b2e-2846-575e-942d-4f25ab7388f9', 'official_product_page', 'PING G440 SFT Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g440-sft-fairway', '2026-09-04'::date),
  ('621c329c-36cd-526c-a06f-b79876419ce1', 'b68336b3-9158-52d9-84d1-7fdfd6d76aaf', 'official_product_page', 'PING G730 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g730-iron', '2026-09-04'::date),
  ('77028b4e-d82a-502e-8eb2-12965b723996', 'f43d7bfe-f55d-53d8-ad26-ea457dc44b29', 'official_product_page', 'PING G740 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/g740-iron', '2026-09-04'::date),
  ('e4ad2d43-5623-5999-a174-c1e29149ed55', '749abd44-e790-5799-ab4f-ab14f90472bf', 'official_product_page', 'PING i230 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/i230-iron', '2026-09-04'::date),
  ('fe4c2ccd-0db2-5aa8-9797-f75605086070', '16493a42-ec59-5ca6-b2ef-b3c1f4ae41a5', 'official_product_page', 'PING i530 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/i530-iron', '2026-09-04'::date),
  ('ece40595-b966-5944-80a5-ac02a9e85f89', '9d9377fe-10f3-5e3f-a606-601becedae29', 'official_product_page', 'PING i540 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/i540-iron', '2026-09-04'::date),
  ('9b9605b4-9bca-539a-aaa0-f758b2ee7d99', '2686fccf-2a7a-5a54-82ce-16f5e3f4e93b', 'official_product_page', 'PING s159 Wedge official product page', 'https://ping.com/en-us/golf-clubs/wedges/s159-wedge', '2026-09-04'::date),
  ('8661c59d-b52c-58f0-9742-525b4f2c497b', '4e984976-224e-51b7-a4e1-371f62351c60', 'official_product_page', 'TaylorMade Hi-Toe 4 Wedge official product page', 'https://www.taylormadegolf.com/Hi-Toe-4-Wedge/N2926509.html?lang=en_US', '2026-09-04'::date),
  ('1fa781bb-4c3e-56f9-a211-2ad321809b8d', 'e3d60884-aca8-5ccf-93ca-31aa9178ed37', 'official_product_page', 'TaylorMade Hi-Toe 5 Wedge official product page', 'https://www.taylormadegolf.com/Hi-Toe-5-Wedge/DW-TC708.html?lang=en_US', '2026-09-04'::date),
  ('f682a6ce-d1aa-5e97-bdbb-b40b8184d235', '6a0cf05f-ae20-5a59-ac49-650feb4982cd', 'official_product_page', 'TaylorMade Kalea Gold Women''s Driver official product page', 'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Driver/DW-TC347.html?lang=en_US', '2026-09-04'::date),
  ('5b4b5175-3ff4-5aec-81e1-cfd72a13a4c5', 'eaffecc7-e418-5d4e-8a2b-9318686f12af', 'official_product_page', 'TaylorMade Kalea Gold Women''s Fairway official product page', 'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Fairway/DW-TC348.html?lang=en_US', '2026-09-04'::date),
  ('d1d5d60b-961a-5ffe-8e25-2f49b236c5a1', '58970b05-dd5d-5719-8f5a-1ba8aea00020', 'official_product_page', 'TaylorMade Kalea Gold Women''s Irons official product page', 'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Irons/DW-TC585.html?lang=en_US', '2026-09-04'::date),
  ('1176ecf9-49ca-5e1f-ac83-6d5de06dcde9', '7e3363b2-e91b-59de-b2f5-cb2b0877116c', 'official_product_page', 'TaylorMade Kalea Gold Women''s Rescue official product page', 'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Rescue/DW-TC349.html?lang=en_US', '2026-09-04'::date),
  ('f09082c4-0087-58af-ade7-b6ab71a56dee', '735a54d8-10b1-5d60-8fb8-859eef57b6a2', 'official_product_page', 'TaylorMade Milled Grind Chrome Wedge official product page', 'https://www.taylormadegolf.com/Milled-Grind-Chrome/N2904409.html?lang=en_US', '2026-09-04'::date),
  ('ae2ecd2b-9836-51ce-b218-fa53c957e246', '83d88f21-4c2b-53e8-835d-409705c7aa41', 'official_product_page', 'TaylorMade P·770 Irons official product page', 'https://www.taylormadegolf.com/P%E2%88%99770-Irons/V9872011.html?lang=en_US', '2026-09-04'::date),
  ('9480150c-1f84-5161-a5e6-7e2521642586', 'fa8525ea-50dd-57b3-b1d8-ca5a9cd07da8', 'official_product_page', 'TaylorMade P·7CB Irons official product page', 'https://www.taylormadegolf.com/P%E2%88%997CB-Irons/V9874611.html?lang=en_US', '2026-09-04'::date),
  ('92b5edf9-d1df-563c-a0d0-b88da119dc9d', '24630ceb-a81d-582c-9db8-0ebf93bf558c', 'official_product_page', 'TaylorMade P·7MB Irons official product page', 'https://www.taylormadegolf.com/P%E2%88%997MB-Irons/DW-TA238.html?lang=en_US', '2026-09-04'::date),
  ('c2c28c44-07d1-5582-bc80-989abef6ad1c', 'afed4a01-c1d1-5024-a2c2-ddbdb49ea6bd', 'official_product_page', 'TaylorMade P·7TW Irons official product page', 'https://www.taylormadegolf.com/p7tw-tiger-woods-iron.html', '2026-09-04'::date),
  ('1fe3723e-d916-50c2-b1c8-df926b25202c', 'e6462a5d-f61a-5ae9-819e-fd8c52afb8a2', 'official_product_page', 'TaylorMade Qi Max HL Irons official product page', 'https://www.taylormadegolf.com/Qi-Max-HL-Irons/DW-TC680.html?lang=default', '2026-09-04'::date),
  ('2a18a302-41d3-50d3-9eb8-f72e3c935b01', '92293d84-ca20-54bf-9658-66f87ea4de5d', 'official_product_page', 'TaylorMade Qi Max Irons official product page', 'https://www.taylormadegolf.com/Qi-Max-Irons/M2118704.html?lang=en_US', '2026-09-04'::date),
  ('fc8d6c05-13b7-5086-813a-3231a8d06eb8', 'a4f694ab-b7aa-5a23-ba54-1aadeaa46bca', 'official_product_page', 'TaylorMade Qi Max Wedge official product page', 'https://www.taylormadegolf.com/Qi-Max-Wedge/DW-TC67W.html?lang=en_US', '2026-09-04'::date),
  ('0a846431-58d4-5910-81f5-09fa823ad17b', '4e8aa9a4-0e81-5fda-b717-040e027931f4', 'official_product_page', 'TaylorMade Qi HL Irons official product page', 'https://www.taylormadegolf.com/Qi-HL-Irons/N2890307.html?lang=en_US', '2026-09-04'::date),
  ('76645ef7-83f1-5217-839f-9fc83bed2e3b', '601b9616-9c17-5e52-aed6-85ab75eb6346', 'official_product_page', 'TaylorMade Qi Irons official product page', 'https://www.taylormadegolf.com/Qi-Irons/N2797409.html?bvstate=pg%3A22%2Fct%3Ar&customize=true&lang=en_US', '2026-09-04'::date),
  ('6e460e13-bc08-57bf-9dcd-9b7034ee82ce', '091e4185-55b8-55ee-87a1-2c647792cfc9', 'official_product_page', 'TaylorMade Qi Wedge official product page', 'https://www.taylormadegolf.com/Qi-Wedge/DW-TC557-W.html?lang=en_US', '2026-09-04'::date),
  ('a9a3f53e-39ff-5225-8a1a-586d26d336d2', '8e1ab005-5db0-5b2c-ab70-a3964f3e2a89', 'official_product_page', 'TaylorMade Qi35 LS Driver official product page', 'https://www.taylormadegolf.com/Qi35-LS-Driver/DW-TC366.html?dwvar_DW-TC366_color=M14479&lang=en_US', '2026-09-04'::date),
  ('91e0cc34-a461-58fb-9cc9-a78ff006f38b', '7fbbd6fd-2eac-5c81-89e2-dd33c1b40f79', 'official_product_page', 'TaylorMade Qi4D Driver official product page', 'https://www.taylormadegolf.com/Qi4D-Driver/DW-TC441.html?lang=en_US', '2026-09-04'::date),
  ('58d6933f-e139-5c4c-8542-87f16ef2d184', '62a42b21-d712-5c21-93a6-be35f58b7647', 'official_product_page', 'TaylorMade Qi4D Fairway official product page', 'https://www.taylormadegolf.com/Qi4D-Fairway/DW-TC448.html?lang=default', '2026-09-04'::date),
  ('ff6f9844-7612-5281-8fca-a8d30816f9e0', 'ca16a6cf-202d-573d-aeb8-5b6df35d1663', 'official_product_page', 'TaylorMade Qi4D LS Driver official product page', 'https://www.taylormadegolf.com/Qi4D-LS-Driver/DW-TC438.html?lang=en_US', '2026-09-04'::date),
  ('e69dc137-ef90-56a2-b23c-30adcbb54d75', 'ef3e1ef2-3a83-516c-b81e-d61cd6a51201', 'official_product_page', 'TaylorMade Qi4D Max Driver official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Driver/DW-TC451.html?lang=en_US', '2026-09-04'::date),
  ('3ace202d-e932-5be0-bf0c-476164e54fa7', 'b9633f25-0a9b-5aba-8c6b-b0dd9896ba7e', 'official_product_page', 'TaylorMade Qi4D Max Fairway official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Fairway/DW-TC455.html?lang=en_US&lang=us', '2026-09-04'::date),
  ('8032abce-2c63-5e34-9501-368b1e2ccd28', '9d96d702-0a74-5d04-bb6e-a52b274242af', 'official_product_page', 'TaylorMade Qi4D Max Lite Driver official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Lite-Driver/DW-TC453.html?lang=en_US', '2026-09-04'::date),
  ('7ed2d88a-2bab-5fe3-bf5e-043d258851b7', '354a28da-2423-55b3-9b30-690bfe96f375', 'official_product_page', 'TaylorMade Qi4D Max Lite Fairway official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Lite-Fairway/DW-TC456.html?lang=en_US', '2026-09-04'::date),
  ('643b147b-8634-5a91-ae2e-08274976ce24', 'e5101e29-3c74-5dd7-8965-545dece65a27', 'official_product_page', 'TaylorMade Qi4D Max Lite Rescue official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Lite-Rescue/DW-TC459.html?lang=en_US', '2026-09-04'::date),
  ('bd3b2901-5431-5a36-b515-245486c874f2', '0e9ba0f3-6680-5cae-886e-b8a5d01b4f1e', 'official_product_page', 'TaylorMade Qi4D Max Rescue official product page', 'https://www.taylormadegolf.com/Qi4D-Max-Rescue/DW-TC458.html?lang=en_US', '2026-09-04'::date),
  ('1aae14fd-2a88-5d19-9039-1c5a6625aaf5', '56bcb020-8d31-5a4b-aaf3-09a6c6541efd', 'official_product_page', 'TaylorMade Qi4D Rescue official product page', 'https://www.taylormadegolf.com/Qi4D-Rescue/DW-TC449.html?lang=default', '2026-09-04'::date),
  ('c630bfd2-4ab8-59f5-be01-1aa0b59488c5', '2ec3b958-a370-53a4-a598-d1602fc5e2ad', 'official_product_page', 'TaylorMade Qi4D Tour Fairway official product page', 'https://www.taylormadegolf.com/Qi4D-Tour-Fairway/DW-TC440.html?lang=us', '2026-09-04'::date),
  ('28aa12ec-17f5-5583-8bdf-46426d0b1e7e', '8ebfa2ca-528c-508a-9dcf-db20008dd028', 'official_product_page', 'TaylorMade SIM2 Max Driver official product page', 'https://www.taylormadegolf.com/SIM2-Max-Driver/N7365709.html?lang=en_US', '2026-09-04'::date),
  ('4c783cd9-347f-5157-aed4-1c42c179df6a', '75a873e0-a838-5383-9ee8-1b568cbc838a', 'official_product_page', 'TaylorMade SIM2 Max Fairway official product page', 'https://www.taylormadegolf.com/SIM2-Max-Fairway/DW-JJI58.html?lang=default', '2026-09-04'::date),
  ('7c0aebcf-82a3-520a-8aca-b548c7c37b7f', 'f236d75d-8df9-5704-8631-2ddf182e7ac7', 'official_product_page', 'TaylorMade SIM2 Max Irons official product page', 'https://www.taylormadegolf.com/SIM2-Max-Irons/N6978109.html?lang=en_US', '2026-09-04'::date),
  ('b3204dde-feb6-504f-bcba-ffef3a79a6bf', '651ef2c2-8675-54e3-9551-5ab51649d23b', 'official_product_page', 'TaylorMade SIM2 Max Rescue official product page', 'https://www.taylormadegolf.com/SIM2-Max-Rescue/N7358807.html?lang=default', '2026-09-04'::date),
  ('366b9077-c339-5dce-9d91-01057f6363d9', '243a5336-3264-5e33-b1dc-55b6c446f406', 'official_product_page', 'Titleist 620 CB Irons official product page', 'https://www.titleist.com/product/620-cb/540C.html', '2026-09-04'::date),
  ('6404ac13-5512-5bdd-96bc-7b3c8635aede', '75385aa7-967c-5268-859f-3ea3ae83ba60', 'official_product_page', 'Titleist 620 MB Irons official product page', 'https://www.titleist.com/product/620-mb/541C.html', '2026-09-04'::date),
  ('aff930df-10b1-5362-98cd-5f941587fdb6', '420e3c1a-35b2-54fc-a402-ed8910efe65d', 'official_product_page', 'Titleist GT1 3Tour Fairway official product page', 'https://www.titleist.com/product/gt1-3tour/673AC.html', '2026-09-04'::date),
  ('e845d42c-6cc0-554e-8931-bed3ff0b68a0', 'f935399f-414d-597d-99bd-84fd27a942e3', 'official_product_page', 'Titleist GT1 Driver official product page', 'https://www.titleist.com/product/gt1-driver/672C.html', '2026-09-04'::date),
  ('40ffe186-6d32-546f-b69d-307d6a443b5b', 'ca09b7cf-49e3-58bd-a3c7-cdefda148378', 'official_product_page', 'Titleist GT1 Fairway official product page', 'https://www.titleist.com/product/gt1-fairway/673C.html', '2026-09-04'::date),
  ('3814e10c-353b-5e2f-8c1c-656564224f2d', '63a6b026-ab70-5f4c-b3e2-cd08fcbd0054', 'official_product_page', 'Titleist GT1 Hybrid official product page', 'https://www.titleist.com/product/gt1-hybrid/674C.html', '2026-09-04'::date),
  ('f6aad9b5-b433-5385-a648-8a681198ba67', '2156ab5e-589a-508b-ac2b-cd50e9bb3085', 'official_product_page', 'Titleist GT3 Hybrid official product page', 'https://www.titleist.com/product/gt3-hybrid/676C.html', '2026-09-04'::date),
  ('55f26e43-9e84-5ec5-b56c-24e1354f0a44', '50754396-7a29-5e25-a178-2a56e81671b1', 'official_product_page', 'Titleist GTS2 Driver official product page', 'https://www.titleist.com/product/gts2-driver/678C.html', '2026-09-04'::date),
  ('e4a775a7-a646-5a8b-a7bd-c506df18f3ff', '6cba22b7-d6f4-5562-b99f-cd994f2418d6', 'official_product_page', 'Titleist GTS2 Fairway official product page', 'https://www.titleist.com/product/gts2-fairway/681C.html', '2026-09-04'::date),
  ('2f1b248a-0bc2-5947-aac8-d0731c7d5c88', '304b009c-865c-5d36-bb06-e05ce893abbc', 'official_product_page', 'Titleist GTS3 Driver official product page', 'https://www.titleist.com/product/gts3-driver/679C.html', '2026-09-04'::date),
  ('f8da05ce-29cd-551c-ac11-e8c4ff3f0ab6', 'a2d37982-a9c2-5883-8d67-cdf47aa3ae83', 'official_product_page', 'Titleist GTS3 Fairway official product page', 'https://www.titleist.com/product/gts3-fairway/682C.html', '2026-09-04'::date),
  ('f497011b-50db-55d9-ac96-2344d47b408f', '35aa8696-4239-55e1-9084-d8a295196a29', 'official_product_page', 'Titleist GTS4 Driver official product page', 'https://www.titleist.com/product/gts4-driver/680C.html', '2026-09-04'::date),
  ('f9301a95-880d-56f0-9758-fefcb42c5f40', '75b2f743-936b-5e75-bbe8-decc15aa2ab7', 'official_product_page', 'Titleist T100 Irons official product page', 'https://www.titleist.com/product/t100/559C.html', '2026-09-04'::date),
  ('f389c3f6-7ab4-5931-b96e-da63a97edcd2', 'ddf0eda4-aabd-5119-8d3e-faf9a67ccada', 'official_product_page', 'Titleist T150 Irons official product page', 'https://www.titleist.com/product/t150/560C.html', '2026-09-04'::date),
  ('7d9f6d8d-7ee0-51b4-9587-e7c06fcaa963', '86debd79-f05d-5d77-b305-2a1829da09c8', 'official_product_page', 'Titleist T250 Launch Spec Irons official product page', 'https://www.titleist.com/product/t250-launch-spec/562C.html', '2026-09-04'::date),
  ('dd6971a0-ed8b-5f69-96bb-6d567d19a667', '0a01f510-87fa-5dfb-be6d-d5d947dbfc18', 'official_product_page', 'Titleist T350 Irons official product page', 'https://www.titleist.com/product/t350/563C.html', '2026-09-04'::date);

-- ----------------------------------------------------------------------------
-- Postconditions — prove the exact intended row set landed and nothing else
-- moved. Stated as canonical identity / expected row-set preservation, never as
-- a claim about physical PostgreSQL row storage.
-- ----------------------------------------------------------------------------

do $$
declare
  v_count bigint;
  v_i int;
  v_expected_keys text[] := array[
    'callaway/odyssey/ai-one-2-ball-ch/v1',
    'callaway/odyssey/ai-one-rossie-db/v1',
    'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1',
    'callaway/opus-sp/opus-sp-chrome-wedge/v1',
    'callaway/quantum/quantum-max-driver/v1',
    'callaway/quantum/quantum-max-fairway-woods/v1',
    'callaway/quantum/quantum-max-hybrids/v1',
    'callaway/quantum/quantum-max-irons/v1',
    'cobra/king/king-irons/v1',
    'cobra/king/king-wedge/v1',
    'cobra/optm/optm-hybrid/v1',
    'cobra/optm/optm-max-k-driver/v1',
    'cobra/optm/optm-x-fairway/v1',
    'mizuno/jpx-one/jpx-one-driver/v1',
    'mizuno/jpx-one/jpx-one-fairway/v1',
    'mizuno/jpx-one/jpx-one-hybrid/v1',
    'mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1',
    'mizuno/m-craft/kyoto-p/v1',
    'mizuno/m-craft/kyoto-s/v1',
    'mizuno/m-craft/tokyo-b/v1',
    'mizuno/m-craft/tokyo-s/v1',
    'mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1',
    'ping/g440/g440-hybrid/v1',
    'ping/g440/g440-max-driver/v1',
    'ping/g440/g440-max-fairway/v1',
    'ping/i240/i240-irons/v1',
    'ping/pld-milled/anser-2d/v1',
    'ping/pld-milled/anser/v1',
    'ping/s259/s259-wedge/v1',
    'taylormade/mg5/mg5-wedge/v1',
    'taylormade/p790/p790-irons/v1',
    'taylormade/qi35/qi35-driver/v1',
    'taylormade/qi35/qi35-fairway/v1',
    'taylormade/qi35/qi35-rescue/v1',
    'taylormade/spider-tour/spider-tour-double-bend/v1',
    'taylormade/spider-tour/spider-tour-small-slant/v1',
    'taylormade/spider-tour/spider-tour-x-double-bend/v1',
    'taylormade/spider-tour/spider-tour-x-l-neck/v1',
    'taylormade/spider-tour/spider-tour-x-small-slant/v1',
    'titleist/gt2/gt2-driver/v1',
    'titleist/gt2/gt2-fairway/v1',
    'titleist/gt2/gt2-hybrid/v1',
    'titleist/scotty-cameron/phantom-5-2/v1',
    'titleist/scotty-cameron/phantom-5-5/v1',
    'titleist/scotty-cameron/phantom-5-oc/v1',
    'titleist/scotty-cameron/phantom-5/v1',
    'titleist/scotty-cameron/phantom-7-2/v1',
    'titleist/scotty-cameron/phantom-7-5/v1',
    'titleist/scotty-cameron/phantom-7/v1',
    'titleist/t250/t250-irons/v1',
    'titleist/vokey-design/vokey-sm11-wedge/v1'
  ];
  v_expected_slugs text[] := array[
    'ai-one-2-ball-ch',
    'ai-one-rossie-db',
    'ai-one-square-2-square-7-center-shaft',
    'g440-hybrid',
    'g440-max-driver',
    'g440-max-fairway',
    'gt2-driver',
    'gt2-fairway',
    'gt2-hybrid',
    'i240-irons',
    'jpx-one-driver',
    'jpx-one-fairway',
    'jpx-one-hybrid',
    'jpx925-hot-metal-irons',
    'king-irons',
    'king-wedge',
    'm-craft-kyoto-p',
    'm-craft-kyoto-s',
    'm-craft-tokyo-b',
    'm-craft-tokyo-s',
    'mg5-wedge',
    'mizuno-pro-t3-wedge',
    'optm-hybrid',
    'optm-max-k-driver',
    'optm-x-fairway',
    'opus-sp-chrome-wedge',
    'p790-irons',
    'phantom-5',
    'phantom-5-2',
    'phantom-5-5',
    'phantom-5-oc',
    'phantom-7',
    'phantom-7-2',
    'phantom-7-5',
    'pld-milled-anser',
    'pld-milled-anser-2d',
    'qi35-driver',
    'qi35-fairway',
    'qi35-rescue',
    'quantum-max-driver',
    'quantum-max-fairway-woods',
    'quantum-max-hybrids',
    'quantum-max-irons',
    's259-wedge',
    'spider-tour-double-bend',
    'spider-tour-small-slant',
    'spider-tour-x-double-bend',
    'spider-tour-x-l-neck',
    'spider-tour-x-small-slant',
    't250-irons',
    'vokey-sm11-wedge'
  ];
  v_model_ids text[] := array[
    'b028d022-3e32-5500-a14c-e2428a1f5992',
    '8ff69801-de0f-5ef4-b572-a6ef300d3ae7',
    'f0da3045-0914-5df2-976b-a3c04d75534a',
    'babe39f1-8eda-5f19-9b8a-0b1614118f6a',
    '3990104d-2c42-52ad-b599-a268e51c6109',
    '029d4d22-5041-5ff0-9c85-ea05eda1f32e',
    'b8b18d5a-eac7-5130-88c1-121182ef02e4',
    '18483ceb-8993-5180-bf47-c3a86a6e0193',
    '0c0d2a68-3ce7-51ea-a247-d5274917191c',
    'c7756a1f-5782-5a64-96ef-47d0bba558a5',
    'edfc0db0-88a5-5d1c-8d4b-ee367c0a6de1',
    '78032edb-8c5f-58b2-b736-7cbfc547b92e',
    'd5e59e6d-c200-54ea-9c5c-ad6269d1a273',
    'eb194721-0975-5ef3-ba40-3763bcc85c5a',
    'cda8badb-df33-5ae0-93c8-4ea76d6cb3f9',
    '0c9174c6-79a6-5abe-bf3e-e83d8f1937a2',
    'a527bb01-9a82-5174-9d7a-fa7600811ef2',
    '69208ba5-84ce-50ce-b70f-4e662f48beef',
    'd719ac7f-1043-5fa4-85c2-ce20477f1b00',
    '82a66c14-d986-599b-91ce-f28a9867b97d',
    '42070948-0e20-57aa-bed3-ac43cb6df7e9',
    '933038e5-b98c-5c6a-83ce-c2185336ec1c',
    '74b7a033-260a-5e74-9f4b-979fb208262f',
    'f8cebc1f-4004-5bc9-9336-23c3869073f5',
    '2c6ad879-53a3-59fb-a514-4325721980b4',
    'e46ac34b-b019-5680-b16d-6081205ef91f',
    'fced413f-a328-5138-9610-dd3fdfdc9871',
    '4643ecd9-b18f-5dac-bc6e-21ba0b50c27a',
    '2d533c58-ed5c-587a-8755-378d3f9fcaa3',
    '1d37940f-bbcc-5683-be5f-8009b0c87fdb',
    '84e58ebc-eb45-5686-aa7d-c8fe3ae46c94',
    '8bc3aa28-f8bf-5144-86fa-c0774d96adbf',
    '04260143-0065-5d99-bd8e-f014e7d80339',
    '0745d40e-9c25-57b8-9a2a-94accdda33a0',
    'a1efbde6-68f3-51df-8645-310ef3845ba1',
    '08c17240-0efc-5caa-bb12-05472e4f341d',
    'bb6201c4-0dd6-50d2-a2df-ba09e4a35715',
    '7f294239-851d-52e9-8d81-148f4ec78182',
    '5811c7ed-69ef-5839-ba28-b8384a8c23b9',
    '761d65a1-cb5f-5e04-a4e0-d2ea331a6508',
    'b8328a0d-8464-59e2-9632-292fdf5f9d60',
    'efbfefca-e301-54c9-8a0b-9dff7bfc852d',
    '7859464f-7ee1-53e1-8fd5-9a67290349cd',
    '7c8fc797-a0b2-5be5-85e5-484172864d26',
    '3b561a07-dd3c-5d5a-b18d-a96c11e383aa',
    '8d82cc7a-95d5-5e19-b41d-98f8cadd62d5',
    '0dedcb5d-de2c-5ab8-9560-e18530a7e058',
    'f69d112d-f8c9-5575-b8e0-bf48bc80a219',
    '56d9d71f-d294-5d2a-b2f6-313472868376',
    '5d69f27d-d883-5882-9bb7-bb39a9f00729',
    '6db9cb72-8e72-5cea-be27-23ccf4c9432c',
    'fef96cf9-98b0-561a-bad8-6a89de62b847',
    '914a07cf-6e53-5649-9e5a-3bf681eeb259',
    '61a09ec5-ce04-59c3-8b17-bcb1686f352a',
    '58c915e3-11c2-573c-bf25-6be9e9b6a86d',
    '865360d5-075b-5a17-9c56-d505c6609937',
    '92460ed2-18fa-5cd0-a6cc-a0d4d63578e7',
    '0a8a3502-6e4e-523f-a18c-f4636d2faed1',
    '95fd87d7-e3f1-5753-917c-a25f5ed23578',
    'd217ce69-f1bb-543d-8490-9f8777a89100',
    'e2fbff14-51e6-521f-b0a1-4ae16cb2d530',
    '146e00cb-22f2-5c76-8c50-ecca1465065e',
    '9bf9bcd6-881e-5776-a1a0-0a1366a39878',
    'f8997505-913f-53c6-b21b-b84c5a8f67c7',
    '3477a641-a588-5ccd-b44c-b0cd6845c851',
    '10466a4f-3181-534c-99ed-abb9692b2543',
    '0cee0a4c-1f70-54ac-93b1-4d6f80241bc5',
    'a9d2f5e9-fecd-541b-81ec-17d0734193e3',
    '0ff98956-3645-54cf-859d-9748512cfeea',
    'cef00c69-9325-5cbe-8f1f-0bc7f3cfaa0f',
    '4534a953-11c9-5e41-a85f-99cb4794ee49',
    '40ddaff2-639b-55ce-b0f6-10bb008790b8',
    '8ae75d35-b2cc-5784-a968-6660df188880',
    '8b9e0675-0266-5abb-b479-dd5d57e61998',
    'bfe75eb6-fa86-5177-bb19-619b204c2216',
    'a4c5bd7d-182b-5706-88d6-605f77d2f78f',
    'b193bce0-5201-5485-a343-d736efe8752a',
    'a7b7cc32-67f7-5bc5-9067-67c792140913',
    'f19314a3-6eea-5d7e-81f5-151c9769fd90',
    '80bbc6a4-5320-5dc8-84f3-7790db9c2e0b',
    '00b95f2c-c3f0-5235-8645-e9b8c65afda7',
    '27561a0a-1e87-5158-acc3-78ab461beb7c',
    'a56d4605-5066-5f9a-ab6b-636af0f470f9',
    '4b3eed29-b4e5-51d3-b7a4-bfcfd53f1244',
    'af40ef79-01b9-542d-9b48-b0e8cbcf6b27',
    '2ee6e73f-d982-55ba-be98-a4ec14e9f58a',
    '7dce54b9-00da-5dfb-b6bd-283d921b80ca',
    'e5d04dae-ce01-53ba-86a5-2273138c18d6',
    '68a5a46b-9944-5a60-9c02-041628545a27',
    'a05a676d-bdc5-5d87-b3e2-eae11a4bd8bf',
    'adf4c508-a326-5c20-b3fe-549f6ae413ab',
    '3e93f818-dc52-5daa-a3b7-1301d368f165',
    'eac93b66-2373-51c9-94b1-853056fbe8f5',
    '01994c8a-df56-58b8-9825-912803e15d7b',
    'ef30c49b-3fa4-5e8a-9684-dbbb1639cfe8',
    '5eaf77e9-e981-5598-bed9-e7535c3eeb6e',
    'b4ef2e28-d055-5af4-ba8b-120b5f243338',
    '4aa04bf1-4e95-51cf-b847-e44c047c1d7d',
    '44e1dd98-0af7-5a5b-890f-9ed226db02b4',
    '1836380a-0724-55c2-8274-bcab8610f60d',
    'e0edb234-2fce-5885-a472-d3cb32171fec',
    'bed2d1b0-87d9-51a3-82ef-0b6849003df8',
    '31067bf7-53dc-525e-b880-ac4e679ca93d',
    '811e1242-e388-5b0e-b0ef-1246dcfea6dd',
    'ed3cedbf-d1ab-53b6-b5aa-527d935b176d',
    '1a3fe3a1-6210-5f6b-8be1-328f4642260f',
    'ec41fa32-99de-547d-8ac8-46983fdf9a1e',
    'a01e8cf0-e097-5bf6-a587-c0013d99515a',
    '5112d2b8-84fd-55da-889e-883842d87aab',
    '420a7af8-ea58-524e-8054-7fe8123c0a37',
    '32ea55ff-c2dc-54ad-9a69-c1e407be08c5',
    '513682f2-b4ad-5306-b611-857b2bba1d21',
    '30e5500b-1f63-5a0b-bd96-73a46446ad9d',
    '7501380d-5777-563e-a360-2a35eb0d1896',
    'ec006f05-17ed-5e2e-a7db-3afd5cb935a8',
    'bf26de36-6446-5201-828a-47abad9d084d',
    '71672aba-8333-588e-acc3-91a6ef0c089e',
    'e50284f1-af86-5f30-a596-6213517e23b7',
    '8698abfb-0b93-5af9-abb5-abf597083ae8',
    '8b86d75b-32d9-5903-81f6-479638f68728',
    'f99a48c4-1e7a-5e64-bd16-b7428f45a967',
    '474867d8-9e79-5726-8cc4-ffef50ca3724',
    '603c535e-5732-567a-aa91-b5b7e602144f',
    'c318bfef-7ecb-5df9-bc50-e0609fc8184a',
    '6de8a5a9-7746-520a-9dcf-e7d20fa4615f',
    '0a4d8f9a-a61c-5352-8457-2b3c01701e6d',
    '5f286b01-1ebb-5ece-af61-6e992b1db885',
    '3ff70dc6-8e0b-5d74-b0e5-2a7722c22185',
    'f111c5f4-babb-52cf-a6eb-afe87642f10a',
    '015345a0-93a8-5e77-867f-5ec6293e568e',
    '51ad5f23-4310-5ef2-93f2-e3d76c8c9639',
    '7eff920a-eb8b-5e42-8734-c61459416910',
    'b511a912-f614-5198-9374-733f0609626e',
    '1a8f6533-0d20-5900-b2fc-697079fef786',
    '7bd7eda6-2639-5475-be7c-27067c968d43',
    '35a1a9a7-475e-5726-929f-2208b42acd9c',
    '48f807eb-ae6c-5522-97c2-6a1e5890a790',
    'f6c1aa75-0c86-595f-b56b-4d177e9f94ba',
    'cf89941a-e969-58ac-a9ba-23ef86d6a802',
    'd61b0595-a6f4-551f-8d09-d96435546494',
    'a6bb67ec-f7be-5fb2-bd05-1220cecf5eae',
    '85f548bf-3506-56e1-b4b6-cb6f086d61c8',
    'd8678bd9-d4e6-50af-9d66-3463f7d32a4e',
    '9a11bf45-481c-57cf-8ee9-5388b2eaf1e0',
    '9705d01e-cccd-59c8-aea5-f76c1a74d541',
    'eab68b2e-2846-575e-942d-4f25ab7388f9',
    'b68336b3-9158-52d9-84d1-7fdfd6d76aaf',
    'f43d7bfe-f55d-53d8-ad26-ea457dc44b29',
    '749abd44-e790-5799-ab4f-ab14f90472bf',
    '16493a42-ec59-5ca6-b2ef-b3c1f4ae41a5',
    '9d9377fe-10f3-5e3f-a606-601becedae29',
    '2686fccf-2a7a-5a54-82ce-16f5e3f4e93b',
    '4e984976-224e-51b7-a4e1-371f62351c60',
    'e3d60884-aca8-5ccf-93ca-31aa9178ed37',
    '6a0cf05f-ae20-5a59-ac49-650feb4982cd',
    'eaffecc7-e418-5d4e-8a2b-9318686f12af',
    '58970b05-dd5d-5719-8f5a-1ba8aea00020',
    '7e3363b2-e91b-59de-b2f5-cb2b0877116c',
    '735a54d8-10b1-5d60-8fb8-859eef57b6a2',
    '83d88f21-4c2b-53e8-835d-409705c7aa41',
    'fa8525ea-50dd-57b3-b1d8-ca5a9cd07da8',
    '24630ceb-a81d-582c-9db8-0ebf93bf558c',
    'afed4a01-c1d1-5024-a2c2-ddbdb49ea6bd',
    'e6462a5d-f61a-5ae9-819e-fd8c52afb8a2',
    '92293d84-ca20-54bf-9658-66f87ea4de5d',
    'a4f694ab-b7aa-5a23-ba54-1aadeaa46bca',
    '4e8aa9a4-0e81-5fda-b717-040e027931f4',
    '601b9616-9c17-5e52-aed6-85ab75eb6346',
    '091e4185-55b8-55ee-87a1-2c647792cfc9',
    '8e1ab005-5db0-5b2c-ab70-a3964f3e2a89',
    '7fbbd6fd-2eac-5c81-89e2-dd33c1b40f79',
    '62a42b21-d712-5c21-93a6-be35f58b7647',
    'ca16a6cf-202d-573d-aeb8-5b6df35d1663',
    'ef3e1ef2-3a83-516c-b81e-d61cd6a51201',
    'b9633f25-0a9b-5aba-8c6b-b0dd9896ba7e',
    '9d96d702-0a74-5d04-bb6e-a52b274242af',
    '354a28da-2423-55b3-9b30-690bfe96f375',
    'e5101e29-3c74-5dd7-8965-545dece65a27',
    '0e9ba0f3-6680-5cae-886e-b8a5d01b4f1e',
    '56bcb020-8d31-5a4b-aaf3-09a6c6541efd',
    '2ec3b958-a370-53a4-a598-d1602fc5e2ad',
    '8ebfa2ca-528c-508a-9dcf-db20008dd028',
    '75a873e0-a838-5383-9ee8-1b568cbc838a',
    'f236d75d-8df9-5704-8631-2ddf182e7ac7',
    '651ef2c2-8675-54e3-9551-5ab51649d23b',
    '243a5336-3264-5e33-b1dc-55b6c446f406',
    '75385aa7-967c-5268-859f-3ea3ae83ba60',
    '420e3c1a-35b2-54fc-a402-ed8910efe65d',
    'f935399f-414d-597d-99bd-84fd27a942e3',
    'ca09b7cf-49e3-58bd-a3c7-cdefda148378',
    '63a6b026-ab70-5f4c-b3e2-cd08fcbd0054',
    '2156ab5e-589a-508b-ac2b-cd50e9bb3085',
    '50754396-7a29-5e25-a178-2a56e81671b1',
    '6cba22b7-d6f4-5562-b99f-cd994f2418d6',
    '304b009c-865c-5d36-bb06-e05ce893abbc',
    'a2d37982-a9c2-5883-8d67-cdf47aa3ae83',
    '35aa8696-4239-55e1-9084-d8a295196a29',
    '75b2f743-936b-5e75-bbe8-decc15aa2ab7',
    'ddf0eda4-aabd-5119-8d3e-faf9a67ccada',
    '86debd79-f05d-5d77-b305-2a1829da09c8',
    '0a01f510-87fa-5dfb-be6d-d5d947dbfc18'
  ];
  v_model_keys text[] := array[
    'callaway/apex-ai150/apex-ai150-irons/v1',
    'callaway/apex-ai200/apex-ai200-irons/v1',
    'callaway/apex-ai300/apex-ai300-irons/v1',
    'callaway/apex-cb/apex-cb-irons/v1',
    'callaway/apex-mb/apex-mb-irons/v1',
    'callaway/apex-pro/apex-pro-irons/v1',
    'callaway/apex-tcb-24/apex-tcb-24-irons/v1',
    'callaway/apex-ti-fusion/apex-ti-fusion-250-irons/v1',
    'callaway/apex-ti-fusion/apex-ti-fusion-irons/v1',
    'callaway/apex-ti-super/apex-ti-super-hybrids/v1',
    'callaway/big-bertha-reva/womens-big-bertha-reva-fairway-woods/v1',
    'callaway/big-bertha-reva/womens-big-bertha-reva-hybrids/v1',
    'callaway/big-bertha/big-bertha-fairway-woods/v1',
    'callaway/big-bertha/big-bertha-hybrids/v1',
    'callaway/big-bertha/big-bertha-irons/v1',
    'callaway/cb-12/cb-12-wedge/v1',
    'callaway/elyte/elyte-driver/v1',
    'callaway/elyte/elyte-fairway-woods/v1',
    'callaway/elyte/elyte-hl-irons/v1',
    'callaway/elyte/elyte-hybrids/v1',
    'callaway/elyte/elyte-irons/v1',
    'callaway/elyte/elyte-max-fast-driver/v1',
    'callaway/elyte/elyte-max-fast-fairway-woods/v1',
    'callaway/elyte/elyte-max-fast-hybrids/v1',
    'callaway/elyte/elyte-max-fast-irons/v1',
    'callaway/elyte/elyte-titanium-fairway-woods/v1',
    'callaway/elyte/elyte-triple-diamond-driver/v1',
    'callaway/elyte/elyte-triple-diamond-fairway-woods/v1',
    'callaway/elyte/elyte-x-driver/v1',
    'callaway/elyte/elyte-x-fairway-woods/v1',
    'callaway/elyte/elyte-x-hybrids/v1',
    'callaway/elyte/elyte-x-irons/v1',
    'callaway/full-toe-sp/full-toe-sp-wedge/v1',
    'callaway/great-big-bertha/great-big-bertha-fairway-woods/v1',
    'callaway/great-big-bertha/great-big-bertha-hybrids/v1',
    'callaway/jaws-raw/jaws-raw-wedge/v1',
    'callaway/mavrik-max-w/womens-mavrik-max-w-hybrids/v1',
    'callaway/mavrik/mavrik-fairway-woods/v1',
    'callaway/mavrik/mavrik-hybrids/v1',
    'callaway/mavrik/mavrik-irons/v1',
    'callaway/opus-platinum/opus-platinum-wedge/v1',
    'callaway/opus-sp-plus/opus-sp-wedge/v1',
    'callaway/opus/opus-wedge/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-hl-hybrids/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-hl-irons/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-hybrid/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-irons/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-max-driver/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-max-fairway-woods/v1',
    'callaway/paradym-ai-smoke/paradym-ai-smoke-max-fast-irons/v1',
    'callaway/paradym-super/paradym-super-hybrid/v1',
    'callaway/paradym/paradym-fairway-woods/v1',
    'callaway/paradym/paradym-irons/v1',
    'callaway/quantum/quantum-max-d-driver/v1',
    'callaway/quantum/quantum-max-d-fairway-woods/v1',
    'callaway/quantum/quantum-max-fast-driver/v1',
    'callaway/quantum/quantum-max-fast-fairway-woods/v1',
    'callaway/quantum/quantum-max-fast-hybrids/v1',
    'callaway/quantum/quantum-max-fast-irons/v1',
    'callaway/quantum/quantum-max-os-hybrids/v1',
    'callaway/quantum/quantum-max-os-irons/v1',
    'callaway/quantum/quantum-max-os-wedges/v1',
    'callaway/quantum/quantum-max-wedges/v1',
    'callaway/quantum/quantum-mini-spinner-fairway-wood/v1',
    'callaway/quantum/quantum-ti-fairway-woods/v1',
    'callaway/quantum/quantum-triple-diamond-driver/v1',
    'callaway/quantum/quantum-triple-diamond-fairway-woods/v1',
    'callaway/quantum/quantum-triple-diamond-max-driver/v1',
    'callaway/reva-rise/reva-rise-driver/v1',
    'callaway/reva-rise/reva-rise-fairway-woods/v1',
    'callaway/reva-rise/reva-rise-hybrid/v1',
    'callaway/reva-rise/reva-rise-irons/v1',
    'callaway/rogue-st/rogue-st-24-max-irons/v1',
    'callaway/rogue-st/rogue-st-max-d-fairway-woods/v1',
    'callaway/rogue-st/rogue-st-max-os-lite-irons/v1',
    'callaway/x-forged-max/x-forged-max-irons/v1',
    'callaway/x-forged/x-forged-irons/v1',
    'cobra/3dp-mb/3dp-mb-irons/v1',
    'cobra/3dp-tour/3dp-tour-irons/v1',
    'cobra/3dp-x/3dp-x-irons/v1',
    'cobra/baffler/baffler-hybrid/v1',
    'cobra/baffler/baffler-irons/v1',
    'cobra/darkspeed/darkspeed-ls-driver/v1',
    'cobra/darkspeed/darkspeed-ls-fairway/v1',
    'cobra/darkspeed/darkspeed-max-fairway/v1',
    'cobra/darkspeed/darkspeed-x-driver/v1',
    'cobra/darkspeed/darkspeed-x-fairway/v1',
    'cobra/ds-adapt/ds-adapt-hybrid/v1',
    'cobra/ds-adapt/ds-adapt-ls-driver/v1',
    'cobra/ds-adapt/ds-adapt-ls-fairway/v1',
    'cobra/ds-adapt/ds-adapt-max-d-driver/v1',
    'cobra/ds-adapt/ds-adapt-max-fairway/v1',
    'cobra/ds-adapt/ds-adapt-max-k-driver/v1',
    'cobra/ds-adapt/ds-adapt-x-driver/v1',
    'cobra/ds-adapt/ds-adapt-x-fairway/v1',
    'cobra/king-cb-mb/king-cb-mb-irons/v1',
    'cobra/king-max/king-max-irons/v1',
    'cobra/king-tec-x/king-tec-x-irons/v1',
    'cobra/king-tec-x/king-tec-x-one-length-hybrid/v1',
    'cobra/king-tec-x/king-tec-x-one-length-irons/v1',
    'cobra/king-tec/king-tec-hybrid/v1',
    'cobra/king-tec/king-tec-irons/v1',
    'cobra/king-tour/king-tour-irons/v1',
    'cobra/king-x/king-x-wedge/v1',
    'cobra/optm/optm-ls-driver/v1',
    'cobra/optm/optm-ls-titanium-fairway/v1',
    'cobra/optm/optm-max-d-driver/v1',
    'cobra/optm/optm-max-fairway/v1',
    'cobra/optm/optm-x-driver/v1',
    'mizuno/jpx-one/jpx-one-select-driver/v1',
    'mizuno/jpx925-forged/jpx925-forged-irons/v1',
    'mizuno/jpx925-hot-metal/jpx925-hot-metal-hl-irons/v1',
    'mizuno/jpx925-hot-metal/jpx925-hot-metal-pro-irons/v1',
    'mizuno/mizuno-pro-m13/mizuno-pro-m13-irons/v1',
    'mizuno/mizuno-pro-m15/mizuno-pro-m15-irons/v1',
    'mizuno/mizuno-pro-s1/mizuno-pro-s1-irons/v1',
    'mizuno/mizuno-pro-s3/mizuno-pro-s3-irons/v1',
    'mizuno/mizuno-pro-s4/mizuno-pro-s4-irons/v1',
    'mizuno/mizuno-pro-t1/mizuno-pro-t1-wedge/v1',
    'mizuno/st-max/st-max-hybrid/v1',
    'ping/blueprint-s/blueprint-s-irons/v1',
    'ping/blueprint-t/blueprint-t-irons/v1',
    'ping/bunkr/bunkr-wedge/v1',
    'ping/g-le3/g-le3-driver/v1',
    'ping/g-le3/g-le3-fairway/v1',
    'ping/g-le3/g-le3-hybrid/v1',
    'ping/g-le3/g-le3-irons/v1',
    'ping/g-le4/g-le4-driver/v1',
    'ping/g-le4/g-le4-fairway/v1',
    'ping/g-le4/g-le4-hybrid/v1',
    'ping/g-le4/g-le4-irons/v1',
    'ping/g430/g430-hybrid/v1',
    'ping/g430/g430-irons/v1',
    'ping/g430/g430-lst-driver/v1',
    'ping/g430/g430-lst-fairway/v1',
    'ping/g430/g430-max-10k-driver/v1',
    'ping/g430/g430-max-driver/v1',
    'ping/g430/g430-max-fairway/v1',
    'ping/g430/g430-sft-driver/v1',
    'ping/g430/g430-sft-fairway/v1',
    'ping/g440/g440-irons/v1',
    'ping/g440/g440-k-driver/v1',
    'ping/g440/g440-lst-driver/v1',
    'ping/g440/g440-lst-fairway/v1',
    'ping/g440/g440-sft-driver/v1',
    'ping/g440/g440-sft-fairway/v1',
    'ping/g730/g730-irons/v1',
    'ping/g740/g740-irons/v1',
    'ping/i230/i230-irons/v1',
    'ping/i530/i530-irons/v1',
    'ping/i540/i540-irons/v1',
    'ping/s159/s159-wedge/v1',
    'taylormade/hi-toe-4/hi-toe-4-wedge/v1',
    'taylormade/hi-toe-5/hi-toe-5-wedge/v1',
    'taylormade/kalea-gold/kalea-gold-womens-driver/v1',
    'taylormade/kalea-gold/kalea-gold-womens-fairway/v1',
    'taylormade/kalea-gold/kalea-gold-womens-irons/v1',
    'taylormade/kalea-gold/kalea-gold-womens-rescue/v1',
    'taylormade/milled-grind/milled-grind-chrome-wedge/v1',
    'taylormade/p770/p770-irons/v1',
    'taylormade/p7cb/p7cb-irons/v1',
    'taylormade/p7mb/p7mb-irons/v1',
    'taylormade/p7tw/p7tw-irons/v1',
    'taylormade/qi-max/qi-max-hl-irons/v1',
    'taylormade/qi-max/qi-max-irons/v1',
    'taylormade/qi-max/qi-max-wedge/v1',
    'taylormade/qi/qi-hl-irons/v1',
    'taylormade/qi/qi-irons/v1',
    'taylormade/qi/qi-wedge/v1',
    'taylormade/qi35/qi35-ls-driver/v1',
    'taylormade/qi4d/qi4d-driver/v1',
    'taylormade/qi4d/qi4d-fairway/v1',
    'taylormade/qi4d/qi4d-ls-driver/v1',
    'taylormade/qi4d/qi4d-max-driver/v1',
    'taylormade/qi4d/qi4d-max-fairway/v1',
    'taylormade/qi4d/qi4d-max-lite-driver/v1',
    'taylormade/qi4d/qi4d-max-lite-fairway/v1',
    'taylormade/qi4d/qi4d-max-lite-rescue/v1',
    'taylormade/qi4d/qi4d-max-rescue/v1',
    'taylormade/qi4d/qi4d-rescue/v1',
    'taylormade/qi4d/qi4d-tour-fairway/v1',
    'taylormade/sim2-max/sim2-max-driver/v1',
    'taylormade/sim2-max/sim2-max-fairway/v1',
    'taylormade/sim2-max/sim2-max-irons/v1',
    'taylormade/sim2-max/sim2-max-rescue/v1',
    'titleist/620-cb/620-cb-irons/v1',
    'titleist/620-mb/620-mb-irons/v1',
    'titleist/gt1/gt1-3tour-fairway/v1',
    'titleist/gt1/gt1-driver/v1',
    'titleist/gt1/gt1-fairway/v1',
    'titleist/gt1/gt1-hybrid/v1',
    'titleist/gt3/gt3-hybrid/v1',
    'titleist/gts2/gts2-driver/v1',
    'titleist/gts2/gts2-fairway/v1',
    'titleist/gts3/gts3-driver/v1',
    'titleist/gts3/gts3-fairway/v1',
    'titleist/gts4/gts4-driver/v1',
    'titleist/t100/t100-irons/v1',
    'titleist/t150/t150-irons/v1',
    'titleist/t250/t250-launch-spec-irons/v1',
    'titleist/t350/t350-irons/v1'
  ];
  v_source_ids text[] := array[
    '8f0f6e13-6a5d-527c-9244-31e71b7720ef',
    '6d823947-9004-5822-9128-1452d0edde8a',
    '58c7bc52-5a04-5e42-b2b3-de6908f227bc',
    '655b115a-0315-5055-be9e-299712d15521',
    'bb50b066-6320-5ce1-b4dc-928d720bbfaf',
    'a8db3ef1-627d-5ad6-b2da-5fa6caee94a0',
    '63f16e0b-4a80-5536-ba97-a7a0e24c429d',
    'd2bb6399-9c24-52ff-967d-b903011c632d',
    'd090a117-ed27-5e18-9489-e047f4b797e8',
    '4b2e068a-5770-54ef-87f7-feb7decf6816',
    'a7e407ea-0d0f-587d-9651-4ca1301fa9d7',
    'dc4c41fa-58cf-59f9-8768-22fc076c44db',
    'b9f78d7b-b63e-5b82-8734-4705e675eb37',
    '59b8c760-82b0-548e-932a-849b9b22d286',
    '28189bff-fe08-52a7-8bfe-176f32caad45',
    'e0a6e9e5-5986-5520-b1e9-e9cbeb78c304',
    'ca126f4a-9954-52a3-b9b5-ecab44468c91',
    '9a4bd6ad-8cda-5de6-bc78-7e366be288eb',
    'cf817270-9074-5279-8336-01501081f7cb',
    '3105c89a-220e-5f37-8a0a-29c435a478a3',
    '127fa12b-6242-520b-9673-5f32d904453e',
    '92f36b47-8326-5478-9598-a90182a916bc',
    '298caf45-57aa-5bc4-bc02-9f631960e927',
    '012b31c4-c691-51a0-bfcc-5fa9876905fb',
    '5b91b0c7-6121-55eb-9786-7fd5f253954c',
    'e89281ad-3ea0-5c88-b25d-6ed877b38ab9',
    'a4c6bfbd-d6cc-5078-bfcf-bd7530ad6859',
    '82137e4c-832c-51f3-ba79-74a8dcc8a44d',
    'b8326c32-7fcd-5a18-92e5-c31989781f46',
    '3e873163-ba8a-582c-b2c9-f3aa43e4f23b',
    '7430e11e-064f-54d2-a9de-e6bb94543961',
    'e367d74b-158c-5444-a776-6e15fcffa88f',
    '2d3f857c-3028-537f-83e6-c81284071e3c',
    '8b12656d-5572-530d-b380-3860eb79a7ec',
    'c8d8f67d-4f75-57cc-b79b-58ce4c2cf736',
    '06d6c93d-06c1-5b92-a8ce-b20a0aae2812',
    '62effe6d-55cb-5c21-876e-72de959d1e83',
    '46b134d2-d95b-59ee-8709-d12668b426b9',
    '73188ca3-5f21-5aee-be54-93619d424e08',
    'adfc9e5d-d0a0-517d-9eac-3d7b9dce74f7',
    '03779891-5b17-5778-8bc2-d4ffd56d4c4c',
    '1709d877-3bb4-5b2c-ba0d-341cdba05f53',
    'fe77aba9-c2e5-5a83-b88d-53383ecd5b5a',
    '99ad0772-4c29-5a8a-886d-d0d3ad654b63',
    '7287cf28-7cea-52a4-b40b-75fdd9f16551',
    '868ed0df-8d6e-5fcf-996a-4ca848437602',
    '24049173-cf65-5c35-ac43-421b6311aeed',
    'a28358c3-6705-5bd4-ac85-08b7ea19cf64',
    '2e3c8e6f-fd05-5b45-9d7a-82f4f781f3d9',
    '3eb6ec3c-7681-556d-a664-b0ce616633fc',
    'a2fd3238-33f6-5112-b0ac-fc0f2d05b3f0',
    '59987507-fe6d-57b9-b0e6-b476392b5128',
    'a0578544-16b7-5593-841b-461ee85e3902',
    'dff8f8e6-7429-5339-833f-ccbb0ecbd898',
    '34c6a950-cd79-5367-a26a-2b596617085e',
    'f66db156-ef3f-5572-8773-0abd1f5cce00',
    'd6145824-a713-50bf-9862-48a447e91a31',
    '3e112d32-a9b4-5b68-9f75-6c56e58d37a5',
    '4ae9b1c6-d099-5e77-a088-052bc7765af5',
    '0e140685-cd2e-5043-9606-def4ea4706ba',
    '23f40216-30ec-5f06-b118-4496a8b3a60d',
    '90a067be-1242-54fd-abf8-6c37bd4679b5',
    'a2d9315c-de99-59bb-8212-8ec9061f4a69',
    'd589a7fc-86a7-50f3-b615-131d02ce1d7b',
    '73d9334a-d84c-5700-9e35-a5d2961379b0',
    'dc1142fd-191c-5663-a2e3-16fd2332118a',
    'f8af860f-c1c1-562a-bd07-bfdbe638065f',
    '6ad1e29d-d02d-56ed-a6b0-69f56aae4511',
    'c9782ba8-45c4-507e-8fa5-0c933f0aa387',
    'd9885ea4-6f6d-5c15-a0c2-690ae6eb4fd7',
    'a3d8fdab-2d29-50c8-9bcf-5bd295c8aa9c',
    '5a805a0d-ece4-5d98-aa8c-d550762249f3',
    '1a751d6c-b540-5381-a57c-9622e63e7170',
    '7730a34c-3d70-5b56-ab00-0662822be04e',
    '4f3dfcca-2eb3-5f53-8c33-dc242365671a',
    'ecfc6275-cd32-56c5-a3e0-e306232b1a62',
    '68c43af0-176f-59b0-9847-3b4889b7159d',
    '24d62345-9e0e-51ef-a21b-3402fee0ef5b',
    '690f13ba-83f1-5d81-a460-934600d911bd',
    'cbe23aa5-95bd-533e-bf9f-bb9392806b51',
    '9cb83173-ccff-5f23-96ba-3eceb546ff9d',
    'af9a15b5-c14e-5cab-b526-fcd65c1c0bb1',
    '1667ff40-d316-506f-8b77-e2cbb81090e3',
    '3a408c74-abd5-5570-b607-c135ed122c4c',
    '9832612b-ffe5-5c5c-a9b3-b550dc76b519',
    '832708e1-0857-57c9-8c35-b4e355c1e678',
    '562d3637-2fd3-53d9-85b3-7c223dc01354',
    'bc9bc780-a5c5-5de9-abb4-aa4c9ac8f484',
    '9dfe5129-5f69-5733-b317-cf5f615a48cf',
    '59897ab5-198c-5b74-b00c-fab7b3100fa8',
    '8d13e038-82e3-58ca-ac91-91cb5f157598',
    'e8f6f400-4d93-5c0a-a5a4-f819f5f196e7',
    'af12fc41-bb39-5d7c-9392-6dca0e8b767c',
    'a46dc45c-def4-53b6-8e9d-f531e1949cd3',
    '35926cea-d1b1-595f-b3c5-c28b9c9d6014',
    '1fc5f75a-f344-561f-93be-6446e04c07b5',
    'beefca86-27c0-5c68-88aa-3ae4445b88c5',
    'b281383e-60f1-54fb-a609-1fc2e047934e',
    'e332da2f-1172-5efa-8964-2f3d5aa842d6',
    '56c231e3-de85-52b6-9dc0-7b1935a99015',
    '957ae4f4-3bd6-5b75-849d-4631172571f1',
    'cd5592eb-4a71-53e8-9ba5-d55653469e54',
    'a6c1952f-f4bf-5cfd-99c8-83536c74c1ab',
    '32b9e2ea-d5e3-5940-bbe0-d611fd8901d5',
    '3f6a552c-5505-5497-8cca-520af1835a84',
    '39d9bcb0-504b-5821-af1d-0f461a55da91',
    '8d2d8587-70f8-568d-9533-a55d70c20e88',
    '989c890e-699d-5144-b33e-ecbb2a37e13c',
    '5da2bd04-baf1-5be0-aa6d-dc4df28bcafe',
    'ae7df518-f18d-5994-bc9f-66cdd196bdb6',
    '95a144a8-b62c-58ef-9a45-2146336fb03d',
    '7e4da4e5-5557-5639-b080-2bbfab85e526',
    'baf5a5ac-6641-5bb6-8c86-c954a38d9152',
    '48668e19-1897-5ed8-b718-a73b2d4f245b',
    '6bc30e32-8fa6-5abf-b3b4-1bd1e2858ade',
    'b2c06a7e-ca92-5e84-8ae3-c2d4066be3b6',
    '3563d9c6-c545-5953-b591-770370e5ba48',
    '47fa1db6-9ff3-54a5-9f8a-f8bd2d1c2f7c',
    '529ab1e6-0f2b-5e8e-b114-2e51d6d4aed7',
    '43b41558-c85f-56a0-9ab9-d0b90148fd24',
    'd349c6f6-2f49-5a54-9e0c-cdf43d76dd95',
    'a2911965-87a1-51a8-b289-3c9a68804b2b',
    '2f01470a-6fd0-5727-83c8-1c1961c06a16',
    '2eedf167-33e4-53af-8a79-87fec5d50931',
    '45e7b5b1-b627-5fa3-a83c-f8010244a285',
    '0e9f6cfd-ea7c-5496-8d14-11eea6066d87',
    '6b5028d7-2c6e-568f-a9c7-319e64286ec5',
    'b9b37819-8849-5101-937b-fd568fa322cc',
    '38bd8f75-a7aa-575e-bf1f-1f04301fd67e',
    'da72fadc-bba5-5f7e-b125-9372ef4b6004',
    '0543a75d-b2f9-5637-9231-0d0d338f6977',
    '5d1403b4-9edf-500e-a26d-e7935dcac695',
    '97202df8-b008-54cb-bf5c-9ab9556b575f',
    'c2c11a75-fdb2-5759-b40c-4589f08a88a9',
    'e20e2927-261e-54d2-85b7-c78abbf1490e',
    '11185190-c1d7-5dfe-98a4-d427452d0977',
    '55fd02d1-f824-5a4c-a1b5-18c3e4bf1d5b',
    'e9e9eaa8-68d5-50e8-be7f-60256f768c68',
    '14440cea-103e-5751-be3a-3d17029b1706',
    '05554267-79c8-5cfe-a53a-a54b3ed06918',
    '11f70ea7-b149-5f88-abdd-64b14b46ec5b',
    '0f0e7e8c-0165-5188-b7ef-8de0640df55e',
    'ce662271-1184-526a-85de-ef7aba2e4b9b',
    '4f51a2ac-3c09-5331-a40e-ee6b6e695854',
    'aeef3f3b-27ea-54cb-ba2a-d23d5e8e4faa',
    '88ae1bb4-5531-5565-a5c2-c15dad347e6f',
    '621c329c-36cd-526c-a06f-b79876419ce1',
    '77028b4e-d82a-502e-8eb2-12965b723996',
    'e4ad2d43-5623-5999-a174-c1e29149ed55',
    'fe4c2ccd-0db2-5aa8-9797-f75605086070',
    'ece40595-b966-5944-80a5-ac02a9e85f89',
    '9b9605b4-9bca-539a-aaa0-f758b2ee7d99',
    '8661c59d-b52c-58f0-9742-525b4f2c497b',
    '1fa781bb-4c3e-56f9-a211-2ad321809b8d',
    'f682a6ce-d1aa-5e97-bdbb-b40b8184d235',
    '5b4b5175-3ff4-5aec-81e1-cfd72a13a4c5',
    'd1d5d60b-961a-5ffe-8e25-2f49b236c5a1',
    '1176ecf9-49ca-5e1f-ac83-6d5de06dcde9',
    'f09082c4-0087-58af-ade7-b6ab71a56dee',
    'ae2ecd2b-9836-51ce-b218-fa53c957e246',
    '9480150c-1f84-5161-a5e6-7e2521642586',
    '92b5edf9-d1df-563c-a0d0-b88da119dc9d',
    'c2c28c44-07d1-5582-bc80-989abef6ad1c',
    '1fe3723e-d916-50c2-b1c8-df926b25202c',
    '2a18a302-41d3-50d3-9eb8-f72e3c935b01',
    'fc8d6c05-13b7-5086-813a-3231a8d06eb8',
    '0a846431-58d4-5910-81f5-09fa823ad17b',
    '76645ef7-83f1-5217-839f-9fc83bed2e3b',
    '6e460e13-bc08-57bf-9dcd-9b7034ee82ce',
    'a9a3f53e-39ff-5225-8a1a-586d26d336d2',
    '91e0cc34-a461-58fb-9cc9-a78ff006f38b',
    '58d6933f-e139-5c4c-8542-87f16ef2d184',
    'ff6f9844-7612-5281-8fca-a8d30816f9e0',
    'e69dc137-ef90-56a2-b23c-30adcbb54d75',
    '3ace202d-e932-5be0-bf0c-476164e54fa7',
    '8032abce-2c63-5e34-9501-368b1e2ccd28',
    '7ed2d88a-2bab-5fe3-bf5e-043d258851b7',
    '643b147b-8634-5a91-ae2e-08274976ce24',
    'bd3b2901-5431-5a36-b515-245486c874f2',
    '1aae14fd-2a88-5d19-9039-1c5a6625aaf5',
    'c630bfd2-4ab8-59f5-be01-1aa0b59488c5',
    '28aa12ec-17f5-5583-8bdf-46426d0b1e7e',
    '4c783cd9-347f-5157-aed4-1c42c179df6a',
    '7c0aebcf-82a3-520a-8aca-b548c7c37b7f',
    'b3204dde-feb6-504f-bcba-ffef3a79a6bf',
    '366b9077-c339-5dce-9d91-01057f6363d9',
    '6404ac13-5512-5bdd-96bc-7b3c8635aede',
    'aff930df-10b1-5362-98cd-5f941587fdb6',
    'e845d42c-6cc0-554e-8931-bed3ff0b68a0',
    '40ffe186-6d32-546f-b69d-307d6a443b5b',
    '3814e10c-353b-5e2f-8c1c-656564224f2d',
    'f6aad9b5-b433-5385-a648-8a681198ba67',
    '55f26e43-9e84-5ec5-b56c-24e1354f0a44',
    'e4a775a7-a646-5a8b-a7bd-c506df18f3ff',
    '2f1b248a-0bc2-5947-aac8-d0731c7d5c88',
    'f8da05ce-29cd-551c-ac11-e8c4ff3f0ab6',
    'f497011b-50db-55d9-ac96-2344d47b408f',
    'f9301a95-880d-56f0-9758-fefcb42c5f40',
    'f389c3f6-7ab4-5931-b96e-da63a97edcd2',
    '7d9f6d8d-7ee0-51b4-9587-e7c06fcaa963',
    'dd6971a0-ed8b-5f69-96bb-6d567d19a667'
  ];
  v_source_model_ids text[] := array[
    'b028d022-3e32-5500-a14c-e2428a1f5992',
    '8ff69801-de0f-5ef4-b572-a6ef300d3ae7',
    'f0da3045-0914-5df2-976b-a3c04d75534a',
    'babe39f1-8eda-5f19-9b8a-0b1614118f6a',
    '3990104d-2c42-52ad-b599-a268e51c6109',
    '029d4d22-5041-5ff0-9c85-ea05eda1f32e',
    'b8b18d5a-eac7-5130-88c1-121182ef02e4',
    '18483ceb-8993-5180-bf47-c3a86a6e0193',
    '0c0d2a68-3ce7-51ea-a247-d5274917191c',
    'c7756a1f-5782-5a64-96ef-47d0bba558a5',
    'edfc0db0-88a5-5d1c-8d4b-ee367c0a6de1',
    '78032edb-8c5f-58b2-b736-7cbfc547b92e',
    'd5e59e6d-c200-54ea-9c5c-ad6269d1a273',
    'eb194721-0975-5ef3-ba40-3763bcc85c5a',
    'cda8badb-df33-5ae0-93c8-4ea76d6cb3f9',
    '0c9174c6-79a6-5abe-bf3e-e83d8f1937a2',
    'a527bb01-9a82-5174-9d7a-fa7600811ef2',
    '69208ba5-84ce-50ce-b70f-4e662f48beef',
    'd719ac7f-1043-5fa4-85c2-ce20477f1b00',
    '82a66c14-d986-599b-91ce-f28a9867b97d',
    '42070948-0e20-57aa-bed3-ac43cb6df7e9',
    '933038e5-b98c-5c6a-83ce-c2185336ec1c',
    '74b7a033-260a-5e74-9f4b-979fb208262f',
    'f8cebc1f-4004-5bc9-9336-23c3869073f5',
    '2c6ad879-53a3-59fb-a514-4325721980b4',
    'e46ac34b-b019-5680-b16d-6081205ef91f',
    'fced413f-a328-5138-9610-dd3fdfdc9871',
    '4643ecd9-b18f-5dac-bc6e-21ba0b50c27a',
    '2d533c58-ed5c-587a-8755-378d3f9fcaa3',
    '1d37940f-bbcc-5683-be5f-8009b0c87fdb',
    '84e58ebc-eb45-5686-aa7d-c8fe3ae46c94',
    '8bc3aa28-f8bf-5144-86fa-c0774d96adbf',
    '04260143-0065-5d99-bd8e-f014e7d80339',
    '0745d40e-9c25-57b8-9a2a-94accdda33a0',
    'a1efbde6-68f3-51df-8645-310ef3845ba1',
    '08c17240-0efc-5caa-bb12-05472e4f341d',
    'bb6201c4-0dd6-50d2-a2df-ba09e4a35715',
    '7f294239-851d-52e9-8d81-148f4ec78182',
    '5811c7ed-69ef-5839-ba28-b8384a8c23b9',
    '761d65a1-cb5f-5e04-a4e0-d2ea331a6508',
    'b8328a0d-8464-59e2-9632-292fdf5f9d60',
    'efbfefca-e301-54c9-8a0b-9dff7bfc852d',
    '7859464f-7ee1-53e1-8fd5-9a67290349cd',
    '7c8fc797-a0b2-5be5-85e5-484172864d26',
    '3b561a07-dd3c-5d5a-b18d-a96c11e383aa',
    '8d82cc7a-95d5-5e19-b41d-98f8cadd62d5',
    '0dedcb5d-de2c-5ab8-9560-e18530a7e058',
    'f69d112d-f8c9-5575-b8e0-bf48bc80a219',
    '56d9d71f-d294-5d2a-b2f6-313472868376',
    '5d69f27d-d883-5882-9bb7-bb39a9f00729',
    '6db9cb72-8e72-5cea-be27-23ccf4c9432c',
    'fef96cf9-98b0-561a-bad8-6a89de62b847',
    '914a07cf-6e53-5649-9e5a-3bf681eeb259',
    '61a09ec5-ce04-59c3-8b17-bcb1686f352a',
    '58c915e3-11c2-573c-bf25-6be9e9b6a86d',
    '865360d5-075b-5a17-9c56-d505c6609937',
    '92460ed2-18fa-5cd0-a6cc-a0d4d63578e7',
    '0a8a3502-6e4e-523f-a18c-f4636d2faed1',
    '95fd87d7-e3f1-5753-917c-a25f5ed23578',
    'd217ce69-f1bb-543d-8490-9f8777a89100',
    'e2fbff14-51e6-521f-b0a1-4ae16cb2d530',
    '146e00cb-22f2-5c76-8c50-ecca1465065e',
    '9bf9bcd6-881e-5776-a1a0-0a1366a39878',
    'f8997505-913f-53c6-b21b-b84c5a8f67c7',
    '3477a641-a588-5ccd-b44c-b0cd6845c851',
    '10466a4f-3181-534c-99ed-abb9692b2543',
    '0cee0a4c-1f70-54ac-93b1-4d6f80241bc5',
    'a9d2f5e9-fecd-541b-81ec-17d0734193e3',
    '0ff98956-3645-54cf-859d-9748512cfeea',
    'cef00c69-9325-5cbe-8f1f-0bc7f3cfaa0f',
    '4534a953-11c9-5e41-a85f-99cb4794ee49',
    '40ddaff2-639b-55ce-b0f6-10bb008790b8',
    '8ae75d35-b2cc-5784-a968-6660df188880',
    '8b9e0675-0266-5abb-b479-dd5d57e61998',
    'bfe75eb6-fa86-5177-bb19-619b204c2216',
    'a4c5bd7d-182b-5706-88d6-605f77d2f78f',
    'b193bce0-5201-5485-a343-d736efe8752a',
    'a7b7cc32-67f7-5bc5-9067-67c792140913',
    'f19314a3-6eea-5d7e-81f5-151c9769fd90',
    '80bbc6a4-5320-5dc8-84f3-7790db9c2e0b',
    '00b95f2c-c3f0-5235-8645-e9b8c65afda7',
    '27561a0a-1e87-5158-acc3-78ab461beb7c',
    'a56d4605-5066-5f9a-ab6b-636af0f470f9',
    '4b3eed29-b4e5-51d3-b7a4-bfcfd53f1244',
    'af40ef79-01b9-542d-9b48-b0e8cbcf6b27',
    '2ee6e73f-d982-55ba-be98-a4ec14e9f58a',
    '7dce54b9-00da-5dfb-b6bd-283d921b80ca',
    'e5d04dae-ce01-53ba-86a5-2273138c18d6',
    '68a5a46b-9944-5a60-9c02-041628545a27',
    'a05a676d-bdc5-5d87-b3e2-eae11a4bd8bf',
    'adf4c508-a326-5c20-b3fe-549f6ae413ab',
    '3e93f818-dc52-5daa-a3b7-1301d368f165',
    'eac93b66-2373-51c9-94b1-853056fbe8f5',
    '01994c8a-df56-58b8-9825-912803e15d7b',
    'ef30c49b-3fa4-5e8a-9684-dbbb1639cfe8',
    '5eaf77e9-e981-5598-bed9-e7535c3eeb6e',
    'b4ef2e28-d055-5af4-ba8b-120b5f243338',
    '4aa04bf1-4e95-51cf-b847-e44c047c1d7d',
    '44e1dd98-0af7-5a5b-890f-9ed226db02b4',
    '1836380a-0724-55c2-8274-bcab8610f60d',
    'e0edb234-2fce-5885-a472-d3cb32171fec',
    'bed2d1b0-87d9-51a3-82ef-0b6849003df8',
    '31067bf7-53dc-525e-b880-ac4e679ca93d',
    '811e1242-e388-5b0e-b0ef-1246dcfea6dd',
    'ed3cedbf-d1ab-53b6-b5aa-527d935b176d',
    '1a3fe3a1-6210-5f6b-8be1-328f4642260f',
    'ec41fa32-99de-547d-8ac8-46983fdf9a1e',
    'a01e8cf0-e097-5bf6-a587-c0013d99515a',
    '5112d2b8-84fd-55da-889e-883842d87aab',
    '420a7af8-ea58-524e-8054-7fe8123c0a37',
    '32ea55ff-c2dc-54ad-9a69-c1e407be08c5',
    '513682f2-b4ad-5306-b611-857b2bba1d21',
    '30e5500b-1f63-5a0b-bd96-73a46446ad9d',
    '7501380d-5777-563e-a360-2a35eb0d1896',
    'ec006f05-17ed-5e2e-a7db-3afd5cb935a8',
    'bf26de36-6446-5201-828a-47abad9d084d',
    '71672aba-8333-588e-acc3-91a6ef0c089e',
    'e50284f1-af86-5f30-a596-6213517e23b7',
    '8698abfb-0b93-5af9-abb5-abf597083ae8',
    '8b86d75b-32d9-5903-81f6-479638f68728',
    'f99a48c4-1e7a-5e64-bd16-b7428f45a967',
    '474867d8-9e79-5726-8cc4-ffef50ca3724',
    '603c535e-5732-567a-aa91-b5b7e602144f',
    'c318bfef-7ecb-5df9-bc50-e0609fc8184a',
    '6de8a5a9-7746-520a-9dcf-e7d20fa4615f',
    '0a4d8f9a-a61c-5352-8457-2b3c01701e6d',
    '5f286b01-1ebb-5ece-af61-6e992b1db885',
    '3ff70dc6-8e0b-5d74-b0e5-2a7722c22185',
    'f111c5f4-babb-52cf-a6eb-afe87642f10a',
    '015345a0-93a8-5e77-867f-5ec6293e568e',
    '51ad5f23-4310-5ef2-93f2-e3d76c8c9639',
    '7eff920a-eb8b-5e42-8734-c61459416910',
    'b511a912-f614-5198-9374-733f0609626e',
    '1a8f6533-0d20-5900-b2fc-697079fef786',
    '7bd7eda6-2639-5475-be7c-27067c968d43',
    '35a1a9a7-475e-5726-929f-2208b42acd9c',
    '48f807eb-ae6c-5522-97c2-6a1e5890a790',
    'f6c1aa75-0c86-595f-b56b-4d177e9f94ba',
    'cf89941a-e969-58ac-a9ba-23ef86d6a802',
    'd61b0595-a6f4-551f-8d09-d96435546494',
    'a6bb67ec-f7be-5fb2-bd05-1220cecf5eae',
    '85f548bf-3506-56e1-b4b6-cb6f086d61c8',
    'd8678bd9-d4e6-50af-9d66-3463f7d32a4e',
    '9a11bf45-481c-57cf-8ee9-5388b2eaf1e0',
    '9705d01e-cccd-59c8-aea5-f76c1a74d541',
    'eab68b2e-2846-575e-942d-4f25ab7388f9',
    'b68336b3-9158-52d9-84d1-7fdfd6d76aaf',
    'f43d7bfe-f55d-53d8-ad26-ea457dc44b29',
    '749abd44-e790-5799-ab4f-ab14f90472bf',
    '16493a42-ec59-5ca6-b2ef-b3c1f4ae41a5',
    '9d9377fe-10f3-5e3f-a606-601becedae29',
    '2686fccf-2a7a-5a54-82ce-16f5e3f4e93b',
    '4e984976-224e-51b7-a4e1-371f62351c60',
    'e3d60884-aca8-5ccf-93ca-31aa9178ed37',
    '6a0cf05f-ae20-5a59-ac49-650feb4982cd',
    'eaffecc7-e418-5d4e-8a2b-9318686f12af',
    '58970b05-dd5d-5719-8f5a-1ba8aea00020',
    '7e3363b2-e91b-59de-b2f5-cb2b0877116c',
    '735a54d8-10b1-5d60-8fb8-859eef57b6a2',
    '83d88f21-4c2b-53e8-835d-409705c7aa41',
    'fa8525ea-50dd-57b3-b1d8-ca5a9cd07da8',
    '24630ceb-a81d-582c-9db8-0ebf93bf558c',
    'afed4a01-c1d1-5024-a2c2-ddbdb49ea6bd',
    'e6462a5d-f61a-5ae9-819e-fd8c52afb8a2',
    '92293d84-ca20-54bf-9658-66f87ea4de5d',
    'a4f694ab-b7aa-5a23-ba54-1aadeaa46bca',
    '4e8aa9a4-0e81-5fda-b717-040e027931f4',
    '601b9616-9c17-5e52-aed6-85ab75eb6346',
    '091e4185-55b8-55ee-87a1-2c647792cfc9',
    '8e1ab005-5db0-5b2c-ab70-a3964f3e2a89',
    '7fbbd6fd-2eac-5c81-89e2-dd33c1b40f79',
    '62a42b21-d712-5c21-93a6-be35f58b7647',
    'ca16a6cf-202d-573d-aeb8-5b6df35d1663',
    'ef3e1ef2-3a83-516c-b81e-d61cd6a51201',
    'b9633f25-0a9b-5aba-8c6b-b0dd9896ba7e',
    '9d96d702-0a74-5d04-bb6e-a52b274242af',
    '354a28da-2423-55b3-9b30-690bfe96f375',
    'e5101e29-3c74-5dd7-8965-545dece65a27',
    '0e9ba0f3-6680-5cae-886e-b8a5d01b4f1e',
    '56bcb020-8d31-5a4b-aaf3-09a6c6541efd',
    '2ec3b958-a370-53a4-a598-d1602fc5e2ad',
    '8ebfa2ca-528c-508a-9dcf-db20008dd028',
    '75a873e0-a838-5383-9ee8-1b568cbc838a',
    'f236d75d-8df9-5704-8631-2ddf182e7ac7',
    '651ef2c2-8675-54e3-9551-5ab51649d23b',
    '243a5336-3264-5e33-b1dc-55b6c446f406',
    '75385aa7-967c-5268-859f-3ea3ae83ba60',
    '420e3c1a-35b2-54fc-a402-ed8910efe65d',
    'f935399f-414d-597d-99bd-84fd27a942e3',
    'ca09b7cf-49e3-58bd-a3c7-cdefda148378',
    '63a6b026-ab70-5f4c-b3e2-cd08fcbd0054',
    '2156ab5e-589a-508b-ac2b-cd50e9bb3085',
    '50754396-7a29-5e25-a178-2a56e81671b1',
    '6cba22b7-d6f4-5562-b99f-cd994f2418d6',
    '304b009c-865c-5d36-bb06-e05ce893abbc',
    'a2d37982-a9c2-5883-8d67-cdf47aa3ae83',
    '35aa8696-4239-55e1-9084-d8a295196a29',
    '75b2f743-936b-5e75-bbe8-decc15aa2ab7',
    'ddf0eda4-aabd-5119-8d3e-faf9a67ccada',
    '86debd79-f05d-5d77-b305-2a1829da09c8',
    '0a01f510-87fa-5dfb-be6d-d5d947dbfc18'
  ];
  v_source_urls text[] := array[
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-apex-ai150.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ai200.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ai300.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-cb-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-mb-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-pro.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-tcb.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-apex-ti-fusion-250.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-apex-ti-fusion.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-apex-ti-super.html',
    'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2023-big-bertha-reva-womens.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-big-bertha-reva-womens.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-big-bertha.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-big-bertha.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2023-big-bertha.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2025-cb12.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-hl.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2025-elyte-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-ti.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-td.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-td.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-elyte-x.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-elyte-x.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-elyte-x.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-elyte-x.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-full-toe-sp-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-gbb.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-gbb.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2022-jaws-raw-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2022-mavrik-max-womens.html',
    'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2022-mavrik.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2022-mavrik.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2022-mavrik.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2024-opus-platinum-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-opus-sp-plus-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2024-opus-chrome.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2024-paradym-ai-smoke-hl.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke-hl.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2024-paradym-ai-smoke.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2024-paradym-ai-smoke-max.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2024-paradym-ai-smoke-max.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-paradym-ai-smoke-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2023-paradym-super.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2023-paradym.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2023-paradym.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max-d.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max-d.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max-fast.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max-os.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max-os.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-quantum-max-os.html',
    'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2026-quantum-max.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-mini-spinner.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-ti.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-triple-diamond.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-triple-diamond.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-triple-diamond-max.html',
    'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2025-reva-rise-womens.html',
    'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2025-reva-rise-womens.html',
    'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2025-reva-rise-womens.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-reva-rise-womens.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2024-rogue-st-max.html',
    'https://www.callawaygolf.com/golf-clubs/fairway-woods/fwoods-2022-rogue-st-max-d.html',
    'https://www.callawaygolf.com/golf-clubs/iron-sets/irons-2022-rogue-st-max-os-lite.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-x-forged-max.html',
    'https://www.callawaygolf.com/golf-clubs/irons/irons-2025-x-forged.html',
    'https://www.cobragolf.com/products/cobra-3dp-mb-irons',
    'https://www.cobragolf.com/products/cobra-3dp-tour-irons',
    'https://www.cobragolf.com/products/cobra-3dp-x-irons',
    'https://www.cobragolf.com/products/baffler-hybrid',
    'https://www.cobragolf.com/products/baffler-hybrid-iron-combo-set',
    'https://www.cobragolf.com/products/darkspeed-ls-driver',
    'https://www.cobragolf.com/products/darkspeed-ls-fairway',
    'https://www.cobragolf.com/products/darkspeed-max-fairway',
    'https://www.cobragolf.com/products/darkspeed-x-driver',
    'https://www.cobragolf.com/products/darkspeed-x-fairway',
    'https://www.cobragolf.com/products/ds-adapt-hybrid',
    'https://www.cobragolf.com/products/ds-adapt-ls-driver',
    'https://www.cobragolf.com/products/ds-adapt-ls-fairway',
    'https://www.cobragolf.com/products/ds-adapt-max-d-driver',
    'https://www.cobragolf.com/products/ds-adapt-max-fairway',
    'https://www.cobragolf.com/products/ds-adapt-max-k-driver',
    'https://www.cobragolf.com/products/ds-adapt-x-driver',
    'https://www.cobragolf.com/products/ds-adapt-x-fairway',
    'https://www.cobragolf.com/products/king-cb-mb-irons-2023',
    'https://www.cobragolf.com/products/king-max-irons',
    'https://www.cobragolf.com/products/king-tec-x-irons',
    'https://www.cobragolf.com/products/king-tec-x-one-length-hybrid',
    'https://www.cobragolf.com/products/king-tec-x-one-length-irons',
    'https://www.cobragolf.com/products/king-tec-hybrid-2025',
    'https://www.cobragolf.com/products/king-tec-irons',
    'https://www.cobragolf.com/products/king-tour-irons-2023',
    'https://www.cobragolf.com/products/king-x-wedge-2025',
    'https://www.cobragolf.com/products/optm-ls-driver',
    'https://www.cobragolf.com/products/optm-ls-titanium-fairway',
    'https://www.cobragolf.com/products/optm-max-d-driver',
    'https://www.cobragolf.com/products/optm-max-fairway',
    'https://www.cobragolf.com/products/optm-x-driver',
    'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-driver/',
    'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-forged/',
    'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/',
    'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-m13/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-m15/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s1/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s3/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-s4/',
    'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-t1/',
    'https://mizunogolf.com/us/hybrids/',
    'https://ping.com/en-us/golf-clubs/irons/blueprint-s-iron',
    'https://ping.com/en-us/golf-clubs/irons/blueprint-t-iron',
    'https://ping.com/en-us/golf-clubs/wedges/bunkr-wedge',
    'https://ping.com/en-us/golf-clubs/drivers/g-le3-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g-le3-fairway',
    'https://ping.com/en-us/golf-clubs/irons/g-le3-iron',
    'https://ping.com/en-us/golf-clubs/irons/g-le3-iron',
    'https://ping.com/en-us/golf-clubs/drivers/g-le4-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g-le4-fairway',
    'https://ping.com/en-us/golf-clubs/irons/g-le4-iron',
    'https://ping.com/en-us/golf-clubs/irons/g-le4-iron',
    'https://ping.com/en-us/golf-clubs/hybrids/g430-hybrid',
    'https://ping.com/en-us/golf-clubs/irons/g430-iron',
    'https://ping.com/en-us/golf-clubs/drivers/g430-lst-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g430-lst-fairway',
    'https://ping.com/en-us/golf-clubs/drivers/g430-max-10k-driver',
    'https://ping.com/en-us/golf-clubs/drivers/g430-max-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g430-max-fairway',
    'https://ping.com/en-us/golf-clubs/drivers/g430-sft-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g430-sft-fairway',
    'https://ping.com/en-us/golf-clubs/irons/g440-iron',
    'https://ping.com/en-us/golf-clubs/drivers/g440-k-driver',
    'https://ping.com/en-us/golf-clubs/drivers/g440-lst-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g440-lst-fairway',
    'https://ping.com/en-us/golf-clubs/drivers/g440-sft-driver',
    'https://ping.com/en-us/golf-clubs/fairways/g440-sft-fairway',
    'https://ping.com/en-us/golf-clubs/irons/g730-iron',
    'https://ping.com/en-us/golf-clubs/irons/g740-iron',
    'https://ping.com/en-us/golf-clubs/irons/i230-iron',
    'https://ping.com/en-us/golf-clubs/irons/i530-iron',
    'https://ping.com/en-us/golf-clubs/irons/i540-iron',
    'https://ping.com/en-us/golf-clubs/wedges/s159-wedge',
    'https://www.taylormadegolf.com/Hi-Toe-4-Wedge/N2926509.html?lang=en_US',
    'https://www.taylormadegolf.com/Hi-Toe-5-Wedge/DW-TC708.html?lang=en_US',
    'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Driver/DW-TC347.html?lang=en_US',
    'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Fairway/DW-TC348.html?lang=en_US',
    'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Irons/DW-TC585.html?lang=en_US',
    'https://www.taylormadegolf.com/Kalea-Gold-Women%27s-Rescue/DW-TC349.html?lang=en_US',
    'https://www.taylormadegolf.com/Milled-Grind-Chrome/N2904409.html?lang=en_US',
    'https://www.taylormadegolf.com/P%E2%88%99770-Irons/V9872011.html?lang=en_US',
    'https://www.taylormadegolf.com/P%E2%88%997CB-Irons/V9874611.html?lang=en_US',
    'https://www.taylormadegolf.com/P%E2%88%997MB-Irons/DW-TA238.html?lang=en_US',
    'https://www.taylormadegolf.com/p7tw-tiger-woods-iron.html',
    'https://www.taylormadegolf.com/Qi-Max-HL-Irons/DW-TC680.html?lang=default',
    'https://www.taylormadegolf.com/Qi-Max-Irons/M2118704.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi-Max-Wedge/DW-TC67W.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi-HL-Irons/N2890307.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi-Irons/N2797409.html?bvstate=pg%3A22%2Fct%3Ar&customize=true&lang=en_US',
    'https://www.taylormadegolf.com/Qi-Wedge/DW-TC557-W.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi35-LS-Driver/DW-TC366.html?dwvar_DW-TC366_color=M14479&lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Driver/DW-TC441.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Fairway/DW-TC448.html?lang=default',
    'https://www.taylormadegolf.com/Qi4D-LS-Driver/DW-TC438.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Max-Driver/DW-TC451.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Max-Fairway/DW-TC455.html?lang=en_US&lang=us',
    'https://www.taylormadegolf.com/Qi4D-Max-Lite-Driver/DW-TC453.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Max-Lite-Fairway/DW-TC456.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Max-Lite-Rescue/DW-TC459.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Max-Rescue/DW-TC458.html?lang=en_US',
    'https://www.taylormadegolf.com/Qi4D-Rescue/DW-TC449.html?lang=default',
    'https://www.taylormadegolf.com/Qi4D-Tour-Fairway/DW-TC440.html?lang=us',
    'https://www.taylormadegolf.com/SIM2-Max-Driver/N7365709.html?lang=en_US',
    'https://www.taylormadegolf.com/SIM2-Max-Fairway/DW-JJI58.html?lang=default',
    'https://www.taylormadegolf.com/SIM2-Max-Irons/N6978109.html?lang=en_US',
    'https://www.taylormadegolf.com/SIM2-Max-Rescue/N7358807.html?lang=default',
    'https://www.titleist.com/product/620-cb/540C.html',
    'https://www.titleist.com/product/620-mb/541C.html',
    'https://www.titleist.com/product/gt1-3tour/673AC.html',
    'https://www.titleist.com/product/gt1-driver/672C.html',
    'https://www.titleist.com/product/gt1-fairway/673C.html',
    'https://www.titleist.com/product/gt1-hybrid/674C.html',
    'https://www.titleist.com/product/gt3-hybrid/676C.html',
    'https://www.titleist.com/product/gts2-driver/678C.html',
    'https://www.titleist.com/product/gts2-fairway/681C.html',
    'https://www.titleist.com/product/gts3-driver/679C.html',
    'https://www.titleist.com/product/gts3-fairway/682C.html',
    'https://www.titleist.com/product/gts4-driver/680C.html',
    'https://www.titleist.com/product/t100/559C.html',
    'https://www.titleist.com/product/t150/560C.html',
    'https://www.titleist.com/product/t250-launch-spec/562C.html',
    'https://www.titleist.com/product/t350/563C.html'
  ];
  v_surviving text[];
begin
  select count(*) into v_count from public.equipment_manufacturers;
  if v_count <> 6 then
    raise exception 'EQ2SC-POST-1: expected exactly 6 equipment_manufacturers rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models;
  if v_count <> 252 then
    raise exception 'EQ2SC-POST-2: expected exactly 252 equipment_models rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2SC-POST-3: expected exactly 21 Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;
  if v_count <> 231 then
    raise exception 'EQ2SC-POST-4: expected exactly 231 non-Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type = 'Driver'::public.club_type_enum;
  if v_count <> 46 then
    raise exception 'EQ2SC-POST-5: expected exactly 46 Driver models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Wood'::public.club_type_enum;
  if v_count <> 49 then
    raise exception 'EQ2SC-POST-5: expected exactly 49 Wood models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Hybrid'::public.club_type_enum;
  if v_count <> 36 then
    raise exception 'EQ2SC-POST-5: expected exactly 36 Hybrid models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Iron'::public.club_type_enum;
  if v_count <> 77 then
    raise exception 'EQ2SC-POST-5: expected exactly 77 Iron models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Wedge'::public.club_type_enum;
  if v_count <> 23 then
    raise exception 'EQ2SC-POST-5: expected exactly 23 Wedge models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2SC-POST-5: expected exactly 21 Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_model_sources;
  if v_count <> 252 then
    raise exception 'EQ2SC-POST-6: expected exactly 252 equipment_model_sources rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs;
  if v_count <> 21 then
    raise exception 'EQ2SC-POST-7: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;
  end if;

  -- Every new model resolves to its expected deterministic identity.
  for v_i in 1..array_length(v_model_ids, 1) loop
    select count(*) into v_count from public.equipment_models
     where id = v_model_ids[v_i]::uuid and catalog_key = v_model_keys[v_i];
    if v_count <> 1 then
      raise exception 'EQ2SC-POST-8: expected model % at its deterministic identity %.', v_model_keys[v_i], v_model_ids[v_i];
    end if;
  end loop;

  -- Every new provenance row resolves to its expected deterministic identity.
  for v_i in 1..array_length(v_source_ids, 1) loop
    select count(*) into v_count from public.equipment_model_sources
     where id = v_source_ids[v_i]::uuid
       and equipment_model_id = v_source_model_ids[v_i]::uuid
       and source_url = v_source_urls[v_i];
    if v_count <> 1 then
      raise exception 'EQ2SC-POST-9: expected the deterministic provenance row for %.', v_source_urls[v_i];
    end if;
  end loop;

  -- Each new model carries exactly one provenance row.
  select count(*) into v_count from (
    select s.equipment_model_id
      from public.equipment_model_sources s
     where s.equipment_model_id = any(v_model_ids::uuid[])
     group by s.equipment_model_id
    having count(*) <> 1
  ) as offending_sources;
  if v_count <> 0 then
    raise exception 'EQ2SC-POST-10: % new models do not have exactly one provenance row.', v_count;
  end if;

  -- The original 51 catalog keys and slugs remain present.
  select array_agg(catalog_key order by catalog_key) into v_surviving
    from public.equipment_models where catalog_key = any(v_expected_keys);
  if v_surviving is distinct from v_expected_keys then
    raise exception 'EQ2SC-POST-11: the original 51 catalog_key set is no longer intact.';
  end if;

  select array_agg(slug order by slug) into v_surviving
    from public.equipment_models where slug = any(v_expected_slugs);
  if v_surviving is distinct from v_expected_slugs then
    raise exception 'EQ2SC-POST-12: the original 51 slug set is no longer intact.';
  end if;

  -- All 201 new catalog keys are present.
  select count(*) into v_count from public.equipment_models where catalog_key = any(v_model_keys);
  if v_count <> 201 then
    raise exception 'EQ2SC-POST-13: expected all 201 v2 catalog keys to be present, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs s
    join public.equipment_models m on m.id = s.equipment_model_id
   where m.club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2SC-POST-14: expected all 21 putter-spec relationships to remain intact, found %.', v_count;
  end if;

  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ2SC-POST-15: this migration must not link any user_equipment row to a catalog model, found %.', v_count;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- EQ-S2-B2 preservation — the source-type rule is still exactly the four deployed classes
--
-- The identical proof, re-run after the 201 provenance rows have been written.
-- This migration performs no schema change, so the rule must come out of the
-- transaction exactly as it went in; anything else means something outside this
-- file moved it, and the transaction must not be allowed to commit.
--
-- Read-only catalog introspection. This migration never rewrites the rule: it
-- refuses to proceed unless the rule is already exactly the deployed B2 shape.
-- ----------------------------------------------------------------------------

do $$
declare
  v_def       text;
  v_norm      text;
  v_blank     text;
  v_found     text[];
  v_literals  int;
  v_col       text;
  v_expected  text[] := array[
    'official_archive',
    'official_category_page',
    'official_product_page',
    'official_spec_pdf'
  ];
begin
  -- A. The provenance table exists as an ordinary table.
  if not exists (
    select 1 from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and rel.relkind = 'r'
  ) then
    raise exception 'EQ2SC-B2POST-A: public.equipment_model_sources is missing or is not an ordinary table.';
  end if;

  -- B. Exactly one CHECK constraint governs source_type.
  if (
    select count(*)
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid, false) ~ '\msource_type\M'
  ) <> 1 then
    raise exception 'EQ2SC-B2POST-B: public.equipment_model_sources does not have exactly one source_type CHECK constraint.';
  end if;

  -- C. That rule carries the exact expected name.
  select pg_get_constraintdef(con.oid, false)
    into v_def
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'equipment_model_sources'
     and con.contype = 'c'
     and con.conname = 'equipment_model_sources_type_check';

  if v_def is null then
    raise exception 'EQ2SC-B2POST-C: constraint equipment_model_sources_type_check is missing. EQ-S2-B2 is not deployed on this database.';
  end if;

  v_norm := btrim(regexp_replace(v_def, '\s+', ' ', 'g'));

  -- D. It is a CHECK expression.
  if v_norm !~ '^CHECK ' then
    raise exception 'EQ2SC-B2POST-D: the source_type rule is not a CHECK expression. Definition: %', v_norm;
  end if;

  -- E. It is a simple membership predicate.
  if v_norm !~ '= ANY' and v_norm !~ '\mIN\M' then
    raise exception 'EQ2SC-B2POST-E: the source_type rule is not a simple membership predicate. Definition: %', v_norm;
  end if;

  v_blank := upper(regexp_replace(v_norm, '''[^'']*''', ' ', 'g'));

  -- F. Once the quoted literals are blanked, no further logic remains.
  if v_blank ~ '\mOR\M'
     or v_blank ~ '\mAND\M'
     or v_blank ~ '\mNOT\M'
     or v_blank ~ '\mIS\M'
     or v_blank ~ '\mLIKE\M'
     or v_blank ~ '\mILIKE\M'
     or v_blank ~ '\mSIMILAR\M'
     or v_blank ~ '[<>]'
     or v_blank ~ '!='
     or v_blank ~ '~' then
    raise exception 'EQ2SC-B2POST-F: the source_type rule carries extra logic beyond simple membership. Definition: %', v_norm;
  end if;

  -- G. source_type is named exactly once, as the governed column.
  if (select count(*) from regexp_matches(v_blank, '\mSOURCE_TYPE\M', 'g')) <> 1 then
    raise exception 'EQ2SC-B2POST-G: the source_type rule does not reference source_type exactly once. Definition: %', v_norm;
  end if;

  -- H. No second column of the table participates in the rule.
  for v_col in
    select att.attname
      from pg_attribute att
      join pg_class rel on rel.oid = att.attrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'equipment_model_sources'
       and att.attnum > 0
       and not att.attisdropped
       and att.attname <> 'source_type'
  loop
    if v_blank ~ ('\m' || upper(v_col) || '\M') then
      raise exception 'EQ2SC-B2POST-H: the source_type rule also references column %. Definition: %', v_col, v_norm;
    end if;
  end loop;

  -- I. Exactly four admitted literals are named.
  select count(*) into v_literals
    from regexp_matches(v_norm, '''([^'']*)''', 'g');

  if v_literals <> array_length(v_expected, 1) then
    raise exception 'EQ2SC-B2POST-I: the source_type rule names % literals, expected %. Definition: %',
      v_literals, array_length(v_expected, 1), v_norm;
  end if;

  select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[])
    into v_found
    from regexp_matches(v_norm, '''([^'']*)''', 'g') as m;

  -- J. No admitted literal is repeated.
  if array_length(v_found, 1) is distinct from v_literals then
    raise exception 'EQ2SC-B2POST-J: the source_type rule repeats an admitted literal. Definition: %', v_norm;
  end if;

  -- K. The admitted set is exactly the four authorized provenance classes.
  if v_found is distinct from (select array_agg(x order by x) from unnest(v_expected) as x) then
    raise exception 'EQ2SC-B2POST-K: the source_type rule admits % but exactly % was expected. Definition: %',
      v_found, v_expected, v_norm;
  end if;

  -- L. The sibling provenance rules are present.
  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_url_https'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_verified_not_future'
  ) or not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'
       and con.conname = 'equipment_model_sources_model_url_unique'
  ) then
    raise exception 'EQ2SC-B2POST-L: a sibling constraint on public.equipment_model_sources is missing.';
  end if;
end $$;

commit;
