-- ============================================================================
-- EQ Slice 2 — non-putter canonical equipment catalog v1
--
-- GENERATED FILE — DO NOT HAND-EDIT.
-- Source of truth : data/equipment-catalog-non-putters-v1.json
-- Generator       : scripts/generate-equipment-catalog-non-putters-v1.mjs
--
-- This migration is DATA-ONLY, transactional, append-only and fail-loud. It
-- creates no schema object, alters nothing, and deletes nothing. It inserts:
--
--   1  new parent manufacturer  (Cobra)
--   30 non-putter equipment_models
--   30 equipment_model_sources
--
-- Identity is deterministic. Every model and source id is an RFC 4122 UUIDv5
-- derived from namespace 05690d1f-f17d-5ab8-a2b6-ef0328a2783a
-- over "model:<catalog_key>" and "source:<catalog_key>:<source_url>". The new
-- manufacturer id derives from "manufacturer:<slug>". The five incumbent
-- manufacturer ids were created under the pre-existing gen_random_uuid()
-- default, are NOT deterministic across environments, and are never rewritten
-- here: models resolve their parent by canonical slug instead.
--
-- Loft, shaft flex, shaft weight, club number and retail SKU are golfer-level
-- customization on public.user_equipment. They are never canonical identity and
-- appear nowhere in this migration.
--
-- Putter coverage is the closed EQ1-S2 artifact family. This migration adds no
-- Putter row and touches no existing putter row or putter-spec row.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Preconditions — refuse to apply against anything but the exact intended
-- foundation.
-- ----------------------------------------------------------------------------

do $$
declare
  v_count bigint;
  v_slugs text[];
  v_expected_putter_keys text[] := array[
    'callaway/odyssey/ai-one-2-ball-ch/v1',
    'callaway/odyssey/ai-one-rossie-db/v1',
    'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1',
    'mizuno/m-craft/kyoto-p/v1',
    'mizuno/m-craft/kyoto-s/v1',
    'mizuno/m-craft/tokyo-b/v1',
    'mizuno/m-craft/tokyo-s/v1',
    'ping/pld-milled/anser-2d/v1',
    'ping/pld-milled/anser/v1',
    'taylormade/spider-tour/spider-tour-double-bend/v1',
    'taylormade/spider-tour/spider-tour-small-slant/v1',
    'taylormade/spider-tour/spider-tour-x-double-bend/v1',
    'taylormade/spider-tour/spider-tour-x-l-neck/v1',
    'taylormade/spider-tour/spider-tour-x-small-slant/v1',
    'titleist/scotty-cameron/phantom-5-2/v1',
    'titleist/scotty-cameron/phantom-5-5/v1',
    'titleist/scotty-cameron/phantom-5-oc/v1',
    'titleist/scotty-cameron/phantom-5/v1',
    'titleist/scotty-cameron/phantom-7-2/v1',
    'titleist/scotty-cameron/phantom-7-5/v1',
    'titleist/scotty-cameron/phantom-7/v1'
  ];
  v_actual_putter_keys text[];
  v_enum text[];
begin
  -- Required tables.
  if to_regclass('public.equipment_manufacturers') is null then
    raise exception 'EQ2S2-PRE-1: public.equipment_manufacturers does not exist.';
  end if;
  if to_regclass('public.equipment_models') is null then
    raise exception 'EQ2S2-PRE-1: public.equipment_models does not exist.';
  end if;
  if to_regclass('public.equipment_putter_model_specs') is null then
    raise exception 'EQ2S2-PRE-1: public.equipment_putter_model_specs does not exist.';
  end if;
  if to_regclass('public.equipment_model_sources') is null then
    raise exception 'EQ2S2-PRE-1: public.equipment_model_sources does not exist.';
  end if;
  if to_regclass('public.user_equipment') is null then
    raise exception 'EQ2S2-PRE-1: public.user_equipment does not exist.';
  end if;

  -- club_type_enum still carries exactly the six expected values, in order.
  select array_agg(e.enumlabel::text order by e.enumsortorder) into v_enum
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname = 'club_type_enum';
  if v_enum is distinct from array['Driver', 'Wood', 'Hybrid', 'Iron', 'Wedge', 'Putter']::text[] then
    raise exception 'EQ2S2-PRE-2: public.club_type_enum values have changed from the expected six values.';
  end if;

  -- Required identity constraints/indexes still exist.
  if not exists (
    select 1 from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = 'equipment_models_catalog_key_unique'
  ) then
    raise exception 'EQ2S2-PRE-3: constraint equipment_models_catalog_key_unique is missing.';
  end if;
  if not exists (
    select 1 from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = 'equipment_models_slug_unique'
  ) then
    raise exception 'EQ2S2-PRE-3: constraint equipment_models_slug_unique is missing.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equipment_models_manufacturer_type_name_year_uidx'
  ) then
    raise exception 'EQ2S2-PRE-4: index equipment_models_manufacturer_type_name_year_uidx is missing.';
  end if;

  -- Exactly the five incumbent manufacturers, and no Cobra yet.
  select array_agg(slug order by slug) into v_slugs from public.equipment_manufacturers;
  if v_slugs is distinct from array['callaway', 'mizuno', 'ping', 'taylormade', 'titleist']::text[] then
    raise exception 'EQ2S2-PRE-5: expected exactly the five incumbent manufacturer slugs, found %.', v_slugs;
  end if;

  select count(*) into v_count from public.equipment_manufacturers where slug = 'cobra';
  if v_count <> 0 then
    raise exception 'EQ2S2-PRE-6: manufacturer cobra already exists; this migration inserts it and must not be re-applied.';
  end if;

  -- Exactly the 21 existing putter models, and nothing else.
  select count(*) into v_count from public.equipment_models;
  if v_count <> 21 then
    raise exception 'EQ2S2-PRE-7: expected exactly 21 existing equipment_models rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;
  if v_count <> 0 then
    raise exception 'EQ2S2-PRE-8: expected zero non-Putter equipment_models rows before this migration, found %.', v_count;
  end if;

  select array_agg(catalog_key order by catalog_key) into v_actual_putter_keys from public.equipment_models;
  if v_actual_putter_keys is distinct from v_expected_putter_keys then
    raise exception 'EQ2S2-PRE-9: the existing 21 putter catalog_key set does not match the expected putter catalog artifact.';
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs;
  if v_count <> 21 then
    raise exception 'EQ2S2-PRE-10: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_model_sources;
  if v_count <> 21 then
    raise exception 'EQ2S2-PRE-11: expected exactly 21 equipment_model_sources rows, found %.', v_count;
  end if;

  -- User-equipment guard. Deliberately scoped to canonical model references
  -- only: staging holds zero user_equipment rows while production holds real
  -- rows, so a total row-count assertion would make this file environment-
  -- specific. manufacturer_id may legitimately be populated already.
  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ2S2-PRE-12: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. New parent manufacturer (deterministic UUIDv5 identity)
-- ----------------------------------------------------------------------------

insert into public.equipment_manufacturers (id, canonical_name, slug, normalized_name)
values
  ('4f88964a-be63-543e-bbfa-d5451b6faab6', 'Cobra', 'cobra', 'cobra');

-- ----------------------------------------------------------------------------
-- 2. Non-putter equipment models (30 rows, generated — do not hand-edit)
-- ----------------------------------------------------------------------------

insert into public.equipment_models (
  id, manufacturer_id, club_type, canonical_name, slug, normalized_name,
  model_year, specifications, is_active,
  catalog_key, brand_line, brand_line_slug, model_family, model_family_slug, release_year
)
values
  ('05783640-1d05-56d2-b294-3bdc3553b97a', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wedge'::public.club_type_enum, 'Callaway Opus SP Chrome Wedge', 'opus-sp-chrome-wedge', 'callawayopusspchromewedge', null, '{}'::jsonb, true, 'callaway/opus-sp/opus-sp-chrome-wedge/v1', null, null, 'Opus SP', 'opus-sp', null),
  ('8f8be9bf-5d7f-5ccb-a510-fe6ddf9e80d4', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Driver'::public.club_type_enum, 'Callaway Quantum Max Driver', 'quantum-max-driver', 'callawayquantummaxdriver', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-driver/v1', null, null, 'Quantum', 'quantum', null),
  ('dbc4d8af-eb54-5d5e-abc5-7845a3c77430', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Wood'::public.club_type_enum, 'Callaway Quantum Max Fairway Woods', 'quantum-max-fairway-woods', 'callawayquantummaxfairwaywoods', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-fairway-woods/v1', null, null, 'Quantum', 'quantum', null),
  ('cdd3c088-8c9d-59ce-a9bf-37cb95536e36', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Hybrid'::public.club_type_enum, 'Callaway Quantum Max Hybrids', 'quantum-max-hybrids', 'callawayquantummaxhybrids', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-hybrids/v1', null, null, 'Quantum', 'quantum', null),
  ('c968a340-1feb-56fb-8201-1b5d53932326', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Iron'::public.club_type_enum, 'Callaway Quantum Max Irons', 'quantum-max-irons', 'callawayquantummaxirons', null, '{}'::jsonb, true, 'callaway/quantum/quantum-max-irons/v1', null, null, 'Quantum', 'quantum', null),
  ('eff55fd7-3140-5e29-9537-60f55d2b9fd6', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Iron'::public.club_type_enum, 'Cobra KING Irons', 'king-irons', 'cobrakingirons', null, '{}'::jsonb, true, 'cobra/king/king-irons/v1', null, null, 'KING', 'king', null),
  ('329b058e-ce57-5678-8076-375f6ab622b9', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wedge'::public.club_type_enum, 'Cobra KING Wedge', 'king-wedge', 'cobrakingwedge', null, '{}'::jsonb, true, 'cobra/king/king-wedge/v1', null, null, 'KING', 'king', null),
  ('ba18473a-43a8-5b14-a1b7-8b2f7b59de0c', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Hybrid'::public.club_type_enum, 'Cobra OPTM Hybrid', 'optm-hybrid', 'cobraoptmhybrid', null, '{}'::jsonb, true, 'cobra/optm/optm-hybrid/v1', null, null, 'OPTM', 'optm', null),
  ('a7fced08-e396-59a8-a758-6ad19173eae9', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Driver'::public.club_type_enum, 'Cobra OPTM MAX-K Driver', 'optm-max-k-driver', 'cobraoptmmaxkdriver', null, '{}'::jsonb, true, 'cobra/optm/optm-max-k-driver/v1', null, null, 'OPTM', 'optm', null),
  ('404bf841-b492-5d42-bfe5-95638cb99ed4', (select id from public.equipment_manufacturers where slug = 'cobra'), 'Wood'::public.club_type_enum, 'Cobra OPTM X Fairway', 'optm-x-fairway', 'cobraoptmxfairway', null, '{}'::jsonb, true, 'cobra/optm/optm-x-fairway/v1', null, null, 'OPTM', 'optm', null),
  ('255a2a5e-6fc6-570d-bb87-ba50e32672c7', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Driver'::public.club_type_enum, 'Mizuno JPX ONE Driver', 'jpx-one-driver', 'mizunojpxonedriver', null, '{}'::jsonb, true, 'mizuno/jpx-one/jpx-one-driver/v1', null, null, 'JPX ONE', 'jpx-one', null),
  ('345042b3-db30-511b-bcdc-828b9fc2ad91', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Wood'::public.club_type_enum, 'Mizuno JPX ONE Fairway', 'jpx-one-fairway', 'mizunojpxonefairway', null, '{}'::jsonb, true, 'mizuno/jpx-one/jpx-one-fairway/v1', null, null, 'JPX ONE', 'jpx-one', null),
  ('871ead13-353c-50b0-9ca2-a4a26c2240a2', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Hybrid'::public.club_type_enum, 'Mizuno JPX ONE Hybrid', 'jpx-one-hybrid', 'mizunojpxonehybrid', null, '{}'::jsonb, true, 'mizuno/jpx-one/jpx-one-hybrid/v1', null, null, 'JPX ONE', 'jpx-one', null),
  ('c6cb6553-eb9c-5f35-9fe8-2f421310893b', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Iron'::public.club_type_enum, 'Mizuno JPX925 Hot Metal Irons', 'jpx925-hot-metal-irons', 'mizunojpx925hotmetalirons', null, '{}'::jsonb, true, 'mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1', null, null, 'JPX925 Hot Metal', 'jpx925-hot-metal', null),
  ('a5314eb0-7d93-50bb-b687-2e8b50a51c97', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Wedge'::public.club_type_enum, 'Mizuno Pro T-3 Wedge', 'mizuno-pro-t3-wedge', 'mizunoprot3wedge', null, '{}'::jsonb, true, 'mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1', null, null, 'Mizuno Pro T-3', 'mizuno-pro-t3', null),
  ('3e6d0121-7c84-53b1-b9ec-dc89d9bbbe81', (select id from public.equipment_manufacturers where slug = 'ping'), 'Hybrid'::public.club_type_enum, 'PING G440 Hybrid', 'g440-hybrid', 'pingg440hybrid', null, '{}'::jsonb, true, 'ping/g440/g440-hybrid/v1', null, null, 'G440', 'g440', null),
  ('99a76604-a06c-5696-aeac-786acc148c72', (select id from public.equipment_manufacturers where slug = 'ping'), 'Driver'::public.club_type_enum, 'PING G440 MAX Driver', 'g440-max-driver', 'pingg440maxdriver', null, '{}'::jsonb, true, 'ping/g440/g440-max-driver/v1', null, null, 'G440', 'g440', null),
  ('75d81429-c3d8-58de-91b9-bbdda8b48587', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wood'::public.club_type_enum, 'PING G440 MAX Fairway', 'g440-max-fairway', 'pingg440maxfairway', null, '{}'::jsonb, true, 'ping/g440/g440-max-fairway/v1', null, null, 'G440', 'g440', null),
  ('1458e98a-56d8-58f5-8389-e7a638cb3c55', (select id from public.equipment_manufacturers where slug = 'ping'), 'Iron'::public.club_type_enum, 'PING i240 Irons', 'i240-irons', 'pingi240irons', null, '{}'::jsonb, true, 'ping/i240/i240-irons/v1', null, null, 'i240', 'i240', null),
  ('48d2a6c5-e0c9-57d9-8469-33640122b6bc', (select id from public.equipment_manufacturers where slug = 'ping'), 'Wedge'::public.club_type_enum, 'PING s259 Wedge', 's259-wedge', 'pings259wedge', null, '{}'::jsonb, true, 'ping/s259/s259-wedge/v1', null, null, 's259', 's259', null),
  ('3c158b87-6d8a-544a-a896-e21aeed03220', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wedge'::public.club_type_enum, 'TaylorMade MG5 Wedge', 'mg5-wedge', 'taylormademg5wedge', null, '{}'::jsonb, true, 'taylormade/mg5/mg5-wedge/v1', null, null, 'MG5', 'mg5', null),
  ('dae7e91f-c275-5db5-9869-5b9450ead1d1', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Iron'::public.club_type_enum, 'TaylorMade P·790 Irons', 'p790-irons', 'taylormadep790irons', null, '{}'::jsonb, true, 'taylormade/p790/p790-irons/v1', null, null, 'P·790', 'p790', null),
  ('391d3044-8395-5106-a1d2-4bd58656c412', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Driver'::public.club_type_enum, 'TaylorMade Qi35 Driver', 'qi35-driver', 'taylormadeqi35driver', null, '{}'::jsonb, true, 'taylormade/qi35/qi35-driver/v1', null, null, 'Qi35', 'qi35', null),
  ('ac1ad455-ed47-5489-bf3d-5c4d103cafb7', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Wood'::public.club_type_enum, 'TaylorMade Qi35 Fairway', 'qi35-fairway', 'taylormadeqi35fairway', null, '{}'::jsonb, true, 'taylormade/qi35/qi35-fairway/v1', null, null, 'Qi35', 'qi35', null),
  ('fb465f5d-a6a2-5adb-953f-9674035fe34b', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Hybrid'::public.club_type_enum, 'TaylorMade Qi35 Rescue', 'qi35-rescue', 'taylormadeqi35rescue', null, '{}'::jsonb, true, 'taylormade/qi35/qi35-rescue/v1', null, null, 'Qi35', 'qi35', null),
  ('efb1fd7c-9344-5801-8962-a34962e89e0e', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Driver'::public.club_type_enum, 'Titleist GT2 Driver', 'gt2-driver', 'titleistgt2driver', null, '{}'::jsonb, true, 'titleist/gt2/gt2-driver/v1', null, null, 'GT2', 'gt2', null),
  ('47f3a7c5-7ffa-58af-b30a-5564d5f9869e', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wood'::public.club_type_enum, 'Titleist GT2 Fairway', 'gt2-fairway', 'titleistgt2fairway', null, '{}'::jsonb, true, 'titleist/gt2/gt2-fairway/v1', null, null, 'GT2', 'gt2', null),
  ('90368084-d86b-512f-a554-87c126175621', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Hybrid'::public.club_type_enum, 'Titleist GT2 Hybrid', 'gt2-hybrid', 'titleistgt2hybrid', null, '{}'::jsonb, true, 'titleist/gt2/gt2-hybrid/v1', null, null, 'GT2', 'gt2', null),
  ('999ebceb-8d17-58c9-a761-881e3d60734e', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Iron'::public.club_type_enum, 'Titleist T250 Irons', 't250-irons', 'titleistt250irons', null, '{}'::jsonb, true, 'titleist/t250/t250-irons/v1', null, null, 'T250', 't250', null),
  ('9f827747-7c1e-59c7-ab27-169525990448', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Wedge'::public.club_type_enum, 'Titleist Vokey SM11 Wedge', 'vokey-sm11-wedge', 'titleistvokeysm11wedge', null, '{}'::jsonb, true, 'titleist/vokey-design/vokey-sm11-wedge/v1', 'Vokey Design', 'vokey-design', 'SM11', 'sm11', null);

-- ----------------------------------------------------------------------------
-- 3. Official identity provenance (30 rows, one per model)
--
-- Every row cites a directly observed official manufacturer resource that
-- establishes the product's identity. No performance claim, loft, shaft option,
-- price or marketing statement is imported from any of them.
-- ----------------------------------------------------------------------------

insert into public.equipment_model_sources (
  id, equipment_model_id, source_type, source_name, source_url, verified_at
)
values
  ('a46fb0c0-4f34-571d-aa79-99466fde0419', '05783640-1d05-56d2-b294-3bdc3553b97a', 'official_product_page', 'Callaway Opus SP Chrome Wedge official product page', 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2025-opus-sp-chrome.html', '2026-08-20'::date),
  ('ed024165-dac5-527b-90c0-300cf4a6c8e8', '8f8be9bf-5d7f-5ccb-a510-fe6ddf9e80d4', 'official_product_page', 'Callaway Quantum Max Driver official product page', 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max.html', '2026-08-20'::date),
  ('90af496c-02c9-54ae-b7cf-19107d3d5fd4', 'dbc4d8af-eb54-5d5e-abc5-7845a3c77430', 'official_product_page', 'Callaway Quantum Max Fairway Woods official product page', 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max.html', '2026-08-20'::date),
  ('ffb74480-1a4b-5705-b129-d0066c224d57', 'cdd3c088-8c9d-59ce-a9bf-37cb95536e36', 'official_product_page', 'Callaway Quantum Max Hybrids official product page', 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max.html', '2026-08-20'::date),
  ('09910fef-f5b5-5543-bd33-e37848ce7073', 'c968a340-1feb-56fb-8201-1b5d53932326', 'official_product_page', 'Callaway Quantum Max Irons official product page', 'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max.html', '2026-08-20'::date),
  ('1d6f0068-bf4c-5699-9e4e-8525b45e26e9', 'eff55fd7-3140-5e29-9537-60f55d2b9fd6', 'official_product_page', 'Cobra KING Irons official product page', 'https://www.cobragolf.com/products/king-irons', '2026-08-20'::date),
  ('1c1744b1-6d6d-54b1-bfb0-37b2e855c311', '329b058e-ce57-5678-8076-375f6ab622b9', 'official_product_page', 'Cobra KING Wedge official product page', 'https://www.cobragolf.com/products/king-wedge-2025', '2026-08-20'::date),
  ('e42415fb-a97b-50a1-b56b-eb34c3ad14f8', 'ba18473a-43a8-5b14-a1b7-8b2f7b59de0c', 'official_product_page', 'Cobra OPTM Hybrid official product page', 'https://www.cobragolf.com/products/optm-hybrid', '2026-08-20'::date),
  ('ad5bb2ff-3301-5d23-886f-b15f53070a0c', 'a7fced08-e396-59a8-a758-6ad19173eae9', 'official_product_page', 'Cobra OPTM MAX-K Driver official product page', 'https://www.cobragolf.com/products/optm-max-k-driver', '2026-08-20'::date),
  ('e6d573a4-978c-58bd-bb4f-4ed63e6cf461', '404bf841-b492-5d42-bfe5-95638cb99ed4', 'official_product_page', 'Cobra OPTM X Fairway official product page', 'https://www.cobragolf.com/products/optm-x-fairway', '2026-08-20'::date),
  ('3ee3caae-f13f-55c0-a430-92b68d8f6a56', '255a2a5e-6fc6-570d-bb87-ba50e32672c7', 'official_product_page', 'Mizuno JPX ONE Driver official product page', 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-driver/', '2026-08-20'::date),
  ('ee71ce47-0a30-5bae-b8ad-e5bf18d31f88', '345042b3-db30-511b-bcdc-828b9fc2ad91', 'official_product_page', 'Mizuno JPX ONE Fairway official product page', 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-fairway/', '2026-08-20'::date),
  ('e84229cb-5edc-5243-a558-9c2145a18c57', '871ead13-353c-50b0-9ca2-a4a26c2240a2', 'official_product_page', 'Mizuno JPX ONE Hybrid official product page', 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-hybrid/', '2026-08-20'::date),
  ('2a5960d5-c18c-582f-a36f-ec011c4002bb', 'c6cb6553-eb9c-5f35-9fe8-2f421310893b', 'official_product_page', 'Mizuno JPX925 Hot Metal Irons official product page', 'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/', '2026-08-20'::date),
  ('d2b89829-9465-5f70-ac6e-db543178bb0c', 'a5314eb0-7d93-50bb-b687-2e8b50a51c97', 'official_product_page', 'Mizuno Pro T-3 official product page', 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-t3/', '2026-08-20'::date),
  ('3327a9e4-8e07-585b-92ab-ff18b40997a4', '3e6d0121-7c84-53b1-b9ec-dc89d9bbbe81', 'official_product_page', 'PING G440 Hybrid official product page', 'https://ping.com/en-us/golf-clubs/hybrids/g440-hybrid', '2026-08-20'::date),
  ('3e9d0bc7-d01c-5171-817e-dfea6179c4ed', '99a76604-a06c-5696-aeac-786acc148c72', 'official_product_page', 'PING G440 MAX Driver official product page', 'https://ping.com/en-us/golf-clubs/drivers/g440-max-driver', '2026-08-20'::date),
  ('d7e02c15-28eb-5317-bf8d-bfff645c5a39', '75d81429-c3d8-58de-91b9-bbdda8b48587', 'official_product_page', 'PING G440 MAX Fairway official product page', 'https://ping.com/en-us/golf-clubs/fairways/g440-max-fairway', '2026-08-20'::date),
  ('c2a138a1-8029-5267-b155-abfb92a1cc17', '1458e98a-56d8-58f5-8389-e7a638cb3c55', 'official_product_page', 'PING i240 Irons official product page', 'https://ping.com/en-us/golf-clubs/irons/i240-iron', '2026-08-20'::date),
  ('d515bbea-946c-5385-944b-6e155bfbc489', '48d2a6c5-e0c9-57d9-8469-33640122b6bc', 'official_product_page', 'PING s259 Wedge official product page', 'https://ping.com/en-us/golf-clubs/wedges/s259-wedge', '2026-08-20'::date),
  ('4d47927b-890b-5977-90c1-3dcba32c02de', '3c158b87-6d8a-544a-a896-e21aeed03220', 'official_product_page', 'TaylorMade MG5 Wedge official product page', 'https://www.taylormadegolf.com/MG5-Wedge/DW-TC647.html', '2026-08-20'::date),
  ('9d6e74ff-f4e4-5661-a361-f1a38459f2f2', 'dae7e91f-c275-5db5-9869-5b9450ead1d1', 'official_product_page', 'TaylorMade P·790 Irons official product page', 'https://www.taylormadegolf.com/P%E2%88%99790-Irons/DW-TC635.html', '2026-08-20'::date),
  ('01812abd-4913-5815-9b19-7d1b7ecefecb', '391d3044-8395-5106-a1d2-4bd58656c412', 'official_spec_pdf', 'TaylorMade Qi35 Driver official specification PDF', 'https://www.taylormadegolf.com/on/demandware.static/-/Sites-TMaG-Library/en_US/v1736272938439/docs/productspecs/2025/Qi35-Core-Driver.pdf', '2026-08-20'::date),
  ('612845e7-b46b-5fa5-9638-afdf8b50a5e1', 'ac1ad455-ed47-5489-bf3d-5c4d103cafb7', 'official_product_page', 'TaylorMade Qi35 Fairway official product page', 'https://www.taylormadegolf.com/Qi35-Fairway/DW-TC373.html', '2026-08-20'::date),
  ('10e03a4c-c24f-5ba2-9bdb-fa4c4385f926', 'fb465f5d-a6a2-5adb-953f-9674035fe34b', 'official_product_page', 'TaylorMade Qi35 Rescue official product page', 'https://www.taylormadegolf.com/Qi35-3-Rescue/M1465109.html', '2026-08-20'::date),
  ('3f1560aa-1ae2-5e20-bed0-35641113625f', 'efb1fd7c-9344-5801-8962-a34962e89e0e', 'official_product_page', 'Titleist GT2 Driver official product page', 'https://www.titleist.com/golf-clubs/drivers/gt2', '2026-08-20'::date),
  ('d4f70b18-05d0-5483-a174-d407753b4c9d', '47f3a7c5-7ffa-58af-b30a-5564d5f9869e', 'official_product_page', 'Titleist GT2 Fairway official product page', 'https://www.titleist.com/golf-clubs/fairways/gt2', '2026-08-20'::date),
  ('89dc7716-221f-5ca8-b1f9-114eff97102c', '90368084-d86b-512f-a554-87c126175621', 'official_product_page', 'Titleist GT2 Hybrid official product page', 'https://www.titleist.com/product/gt2-hybrid/675C.html', '2026-08-20'::date),
  ('5846df39-baa1-5ec9-baec-0edf2ca6775a', '999ebceb-8d17-58c9-a761-881e3d60734e', 'official_product_page', 'Titleist T250 Irons official product page', 'https://www.titleist.com/product/t250/561C.html', '2026-08-20'::date),
  ('060cd85d-336e-5c33-9a27-a129f191c96d', '9f827747-7c1e-59c7-ab27-169525990448', 'official_product_page', 'Titleist Vokey SM11 official product page', 'https://www.titleist.com/product/vokey-sm11/MASTER-SM11.html', '2026-08-20'::date);

-- ----------------------------------------------------------------------------
-- Postconditions — prove the exact intended row set landed and nothing else
-- moved. Stated as canonical identity / expected row-set preservation, never as
-- a claim about physical PostgreSQL row storage.
-- ----------------------------------------------------------------------------

do $$
declare
  v_count bigint;
  v_expected_putter_keys text[] := array[
    'callaway/odyssey/ai-one-2-ball-ch/v1',
    'callaway/odyssey/ai-one-rossie-db/v1',
    'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1',
    'mizuno/m-craft/kyoto-p/v1',
    'mizuno/m-craft/kyoto-s/v1',
    'mizuno/m-craft/tokyo-b/v1',
    'mizuno/m-craft/tokyo-s/v1',
    'ping/pld-milled/anser-2d/v1',
    'ping/pld-milled/anser/v1',
    'taylormade/spider-tour/spider-tour-double-bend/v1',
    'taylormade/spider-tour/spider-tour-small-slant/v1',
    'taylormade/spider-tour/spider-tour-x-double-bend/v1',
    'taylormade/spider-tour/spider-tour-x-l-neck/v1',
    'taylormade/spider-tour/spider-tour-x-small-slant/v1',
    'titleist/scotty-cameron/phantom-5-2/v1',
    'titleist/scotty-cameron/phantom-5-5/v1',
    'titleist/scotty-cameron/phantom-5-oc/v1',
    'titleist/scotty-cameron/phantom-5/v1',
    'titleist/scotty-cameron/phantom-7-2/v1',
    'titleist/scotty-cameron/phantom-7-5/v1',
    'titleist/scotty-cameron/phantom-7/v1'
  ];
  v_actual_putter_keys text[];
begin
  select count(*) into v_count from public.equipment_manufacturers;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-1: expected exactly 6 equipment_manufacturers rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_manufacturers
   where id = '4f88964a-be63-543e-bbfa-d5451b6faab6'
     and canonical_name = 'Cobra'
     and slug = 'cobra'
     and normalized_name = 'cobra';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-2: the new manufacturer row is missing or does not match its deterministic identity.';
  end if;

  select count(*) into v_count from public.equipment_models;
  if v_count <> 51 then
    raise exception 'EQ2S2-POST-3: expected exactly 51 equipment_models rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2S2-POST-4: expected exactly 21 Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;
  if v_count <> 30 then
    raise exception 'EQ2S2-POST-5: expected exactly 30 non-Putter models, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where club_type = 'Driver'::public.club_type_enum;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-6: expected exactly 6 Driver models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Wood'::public.club_type_enum;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-6: expected exactly 6 Wood models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Hybrid'::public.club_type_enum;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-6: expected exactly 6 Hybrid models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Iron'::public.club_type_enum;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-6: expected exactly 6 Iron models, found %.', v_count;
  end if;
  select count(*) into v_count from public.equipment_models where club_type = 'Wedge'::public.club_type_enum;
  if v_count <> 6 then
    raise exception 'EQ2S2-POST-6: expected exactly 6 Wedge models, found %.', v_count;
  end if;

  -- Every locked manufacturer/club-type cell carries exactly one non-putter row.
  select count(*) into v_count from (
    select m.manufacturer_id, m.club_type
      from public.equipment_models m
     where m.club_type <> 'Putter'::public.club_type_enum
     group by m.manufacturer_id, m.club_type
    having count(*) <> 1
  ) as offending_cells;
  if v_count <> 0 then
    raise exception 'EQ2S2-POST-7: % manufacturer/club-type cells do not hold exactly one non-putter model.', v_count;
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs;
  if v_count <> 21 then
    raise exception 'EQ2S2-POST-8: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;
  end if;

  select count(*) into v_count from public.equipment_model_sources;
  if v_count <> 51 then
    raise exception 'EQ2S2-POST-9: expected exactly 51 equipment_model_sources rows, found %.', v_count;
  end if;

  -- Each new model resolves to its expected deterministic identity, and carries
  -- exactly one provenance row with the expected deterministic source id.
  select count(*) into v_count from public.equipment_models
   where id = '05783640-1d05-56d2-b294-3bdc3553b97a' and catalog_key = 'callaway/opus-sp/opus-sp-chrome-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'Callaway Opus SP Chrome Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model callaway/opus-sp/opus-sp-chrome-wedge/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '8f8be9bf-5d7f-5ccb-a510-fe6ddf9e80d4' and catalog_key = 'callaway/quantum/quantum-max-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'Callaway Quantum Max Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model callaway/quantum/quantum-max-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'dbc4d8af-eb54-5d5e-abc5-7845a3c77430' and catalog_key = 'callaway/quantum/quantum-max-fairway-woods/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'Callaway Quantum Max Fairway Woods';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model callaway/quantum/quantum-max-fairway-woods/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'cdd3c088-8c9d-59ce-a9bf-37cb95536e36' and catalog_key = 'callaway/quantum/quantum-max-hybrids/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'Callaway Quantum Max Hybrids';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model callaway/quantum/quantum-max-hybrids/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'c968a340-1feb-56fb-8201-1b5d53932326' and catalog_key = 'callaway/quantum/quantum-max-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'Callaway Quantum Max Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model callaway/quantum/quantum-max-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'eff55fd7-3140-5e29-9537-60f55d2b9fd6' and catalog_key = 'cobra/king/king-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'Cobra KING Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model cobra/king/king-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '329b058e-ce57-5678-8076-375f6ab622b9' and catalog_key = 'cobra/king/king-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'Cobra KING Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model cobra/king/king-wedge/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'ba18473a-43a8-5b14-a1b7-8b2f7b59de0c' and catalog_key = 'cobra/optm/optm-hybrid/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'Cobra OPTM Hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model cobra/optm/optm-hybrid/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'a7fced08-e396-59a8-a758-6ad19173eae9' and catalog_key = 'cobra/optm/optm-max-k-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'Cobra OPTM MAX-K Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model cobra/optm/optm-max-k-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '404bf841-b492-5d42-bfe5-95638cb99ed4' and catalog_key = 'cobra/optm/optm-x-fairway/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'Cobra OPTM X Fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model cobra/optm/optm-x-fairway/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '255a2a5e-6fc6-570d-bb87-ba50e32672c7' and catalog_key = 'mizuno/jpx-one/jpx-one-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'Mizuno JPX ONE Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model mizuno/jpx-one/jpx-one-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '345042b3-db30-511b-bcdc-828b9fc2ad91' and catalog_key = 'mizuno/jpx-one/jpx-one-fairway/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'Mizuno JPX ONE Fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model mizuno/jpx-one/jpx-one-fairway/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '871ead13-353c-50b0-9ca2-a4a26c2240a2' and catalog_key = 'mizuno/jpx-one/jpx-one-hybrid/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'Mizuno JPX ONE Hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model mizuno/jpx-one/jpx-one-hybrid/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'c6cb6553-eb9c-5f35-9fe8-2f421310893b' and catalog_key = 'mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'Mizuno JPX925 Hot Metal Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'a5314eb0-7d93-50bb-b687-2e8b50a51c97' and catalog_key = 'mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'Mizuno Pro T-3 Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '3e6d0121-7c84-53b1-b9ec-dc89d9bbbe81' and catalog_key = 'ping/g440/g440-hybrid/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'PING G440 Hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model ping/g440/g440-hybrid/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '99a76604-a06c-5696-aeac-786acc148c72' and catalog_key = 'ping/g440/g440-max-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'PING G440 MAX Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model ping/g440/g440-max-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '75d81429-c3d8-58de-91b9-bbdda8b48587' and catalog_key = 'ping/g440/g440-max-fairway/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'PING G440 MAX Fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model ping/g440/g440-max-fairway/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '1458e98a-56d8-58f5-8389-e7a638cb3c55' and catalog_key = 'ping/i240/i240-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'PING i240 Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model ping/i240/i240-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '48d2a6c5-e0c9-57d9-8469-33640122b6bc' and catalog_key = 'ping/s259/s259-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'PING s259 Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model ping/s259/s259-wedge/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '3c158b87-6d8a-544a-a896-e21aeed03220' and catalog_key = 'taylormade/mg5/mg5-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'TaylorMade MG5 Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model taylormade/mg5/mg5-wedge/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'dae7e91f-c275-5db5-9869-5b9450ead1d1' and catalog_key = 'taylormade/p790/p790-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'TaylorMade P·790 Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model taylormade/p790/p790-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '391d3044-8395-5106-a1d2-4bd58656c412' and catalog_key = 'taylormade/qi35/qi35-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'TaylorMade Qi35 Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model taylormade/qi35/qi35-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'ac1ad455-ed47-5489-bf3d-5c4d103cafb7' and catalog_key = 'taylormade/qi35/qi35-fairway/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'TaylorMade Qi35 Fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model taylormade/qi35/qi35-fairway/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'fb465f5d-a6a2-5adb-953f-9674035fe34b' and catalog_key = 'taylormade/qi35/qi35-rescue/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'TaylorMade Qi35 Rescue';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model taylormade/qi35/qi35-rescue/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = 'efb1fd7c-9344-5801-8962-a34962e89e0e' and catalog_key = 'titleist/gt2/gt2-driver/v1'
     and club_type = 'Driver'::public.club_type_enum
     and canonical_name = 'Titleist GT2 Driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model titleist/gt2/gt2-driver/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '47f3a7c5-7ffa-58af-b30a-5564d5f9869e' and catalog_key = 'titleist/gt2/gt2-fairway/v1'
     and club_type = 'Wood'::public.club_type_enum
     and canonical_name = 'Titleist GT2 Fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model titleist/gt2/gt2-fairway/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '90368084-d86b-512f-a554-87c126175621' and catalog_key = 'titleist/gt2/gt2-hybrid/v1'
     and club_type = 'Hybrid'::public.club_type_enum
     and canonical_name = 'Titleist GT2 Hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model titleist/gt2/gt2-hybrid/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '999ebceb-8d17-58c9-a761-881e3d60734e' and catalog_key = 'titleist/t250/t250-irons/v1'
     and club_type = 'Iron'::public.club_type_enum
     and canonical_name = 'Titleist T250 Irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model titleist/t250/t250-irons/v1 at its deterministic identity.';
  end if;
  select count(*) into v_count from public.equipment_models
   where id = '9f827747-7c1e-59c7-ab27-169525990448' and catalog_key = 'titleist/vokey-design/vokey-sm11-wedge/v1'
     and club_type = 'Wedge'::public.club_type_enum
     and canonical_name = 'Titleist Vokey SM11 Wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-10: expected model titleist/vokey-design/vokey-sm11-wedge/v1 at its deterministic identity.';
  end if;

  select count(*) into v_count from public.equipment_model_sources
   where id = 'a46fb0c0-4f34-571d-aa79-99466fde0419' and equipment_model_id = '05783640-1d05-56d2-b294-3bdc3553b97a'
     and source_url = 'https://www.callawaygolf.com/golf-clubs/wedges/wedges-2025-opus-sp-chrome.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for callaway/opus-sp/opus-sp-chrome-wedge/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'ed024165-dac5-527b-90c0-300cf4a6c8e8' and equipment_model_id = '8f8be9bf-5d7f-5ccb-a510-fe6ddf9e80d4'
     and source_url = 'https://www.callawaygolf.com/golf-clubs/drivers/drivers-2026-quantum-max.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for callaway/quantum/quantum-max-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '90af496c-02c9-54ae-b7cf-19107d3d5fd4' and equipment_model_id = 'dbc4d8af-eb54-5d5e-abc5-7845a3c77430'
     and source_url = 'https://www.callawaygolf.com/golf-clubs/woods/fwoods-2026-quantum-max.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for callaway/quantum/quantum-max-fairway-woods/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'ffb74480-1a4b-5705-b129-d0066c224d57' and equipment_model_id = 'cdd3c088-8c9d-59ce-a9bf-37cb95536e36'
     and source_url = 'https://www.callawaygolf.com/golf-clubs/hybrids/hybrids-2026-quantum-max.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for callaway/quantum/quantum-max-hybrids/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '09910fef-f5b5-5543-bd33-e37848ce7073' and equipment_model_id = 'c968a340-1feb-56fb-8201-1b5d53932326'
     and source_url = 'https://www.callawaygolf.com/golf-clubs/irons/irons-2026-quantum-max.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for callaway/quantum/quantum-max-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '1d6f0068-bf4c-5699-9e4e-8525b45e26e9' and equipment_model_id = 'eff55fd7-3140-5e29-9537-60f55d2b9fd6'
     and source_url = 'https://www.cobragolf.com/products/king-irons';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for cobra/king/king-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '1c1744b1-6d6d-54b1-bfb0-37b2e855c311' and equipment_model_id = '329b058e-ce57-5678-8076-375f6ab622b9'
     and source_url = 'https://www.cobragolf.com/products/king-wedge-2025';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for cobra/king/king-wedge/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'e42415fb-a97b-50a1-b56b-eb34c3ad14f8' and equipment_model_id = 'ba18473a-43a8-5b14-a1b7-8b2f7b59de0c'
     and source_url = 'https://www.cobragolf.com/products/optm-hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for cobra/optm/optm-hybrid/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'ad5bb2ff-3301-5d23-886f-b15f53070a0c' and equipment_model_id = 'a7fced08-e396-59a8-a758-6ad19173eae9'
     and source_url = 'https://www.cobragolf.com/products/optm-max-k-driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for cobra/optm/optm-max-k-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'e6d573a4-978c-58bd-bb4f-4ed63e6cf461' and equipment_model_id = '404bf841-b492-5d42-bfe5-95638cb99ed4'
     and source_url = 'https://www.cobragolf.com/products/optm-x-fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for cobra/optm/optm-x-fairway/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '3ee3caae-f13f-55c0-a430-92b68d8f6a56' and equipment_model_id = '255a2a5e-6fc6-570d-bb87-ba50e32672c7'
     and source_url = 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-driver/';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for mizuno/jpx-one/jpx-one-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'ee71ce47-0a30-5bae-b8ad-e5bf18d31f88' and equipment_model_id = '345042b3-db30-511b-bcdc-828b9fc2ad91'
     and source_url = 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-fairway/';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for mizuno/jpx-one/jpx-one-fairway/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'e84229cb-5edc-5243-a558-9c2145a18c57' and equipment_model_id = '871ead13-353c-50b0-9ca2-a4a26c2240a2'
     and source_url = 'https://mizunogolf.com/us/golf-clubs/jpx-one-series/jpx-one-hybrid/';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for mizuno/jpx-one/jpx-one-hybrid/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '2a5960d5-c18c-582f-a36f-ec011c4002bb' and equipment_model_id = 'c6cb6553-eb9c-5f35-9fe8-2f421310893b'
     and source_url = 'https://mizunogolf.com/us/golf-clubs/jpx925-series/jpx925-hot-metals/';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for mizuno/jpx925-hot-metal/jpx925-hot-metal-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'd2b89829-9465-5f70-ac6e-db543178bb0c' and equipment_model_id = 'a5314eb0-7d93-50bb-b687-2e8b50a51c97'
     and source_url = 'https://mizunogolf.com/us/golf-clubs/mp-series/mizuno-pro-t3/';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for mizuno/mizuno-pro-t3/mizuno-pro-t3-wedge/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '3327a9e4-8e07-585b-92ab-ff18b40997a4' and equipment_model_id = '3e6d0121-7c84-53b1-b9ec-dc89d9bbbe81'
     and source_url = 'https://ping.com/en-us/golf-clubs/hybrids/g440-hybrid';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ping/g440/g440-hybrid/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '3e9d0bc7-d01c-5171-817e-dfea6179c4ed' and equipment_model_id = '99a76604-a06c-5696-aeac-786acc148c72'
     and source_url = 'https://ping.com/en-us/golf-clubs/drivers/g440-max-driver';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ping/g440/g440-max-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'd7e02c15-28eb-5317-bf8d-bfff645c5a39' and equipment_model_id = '75d81429-c3d8-58de-91b9-bbdda8b48587'
     and source_url = 'https://ping.com/en-us/golf-clubs/fairways/g440-max-fairway';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ping/g440/g440-max-fairway/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'c2a138a1-8029-5267-b155-abfb92a1cc17' and equipment_model_id = '1458e98a-56d8-58f5-8389-e7a638cb3c55'
     and source_url = 'https://ping.com/en-us/golf-clubs/irons/i240-iron';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ping/i240/i240-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'd515bbea-946c-5385-944b-6e155bfbc489' and equipment_model_id = '48d2a6c5-e0c9-57d9-8469-33640122b6bc'
     and source_url = 'https://ping.com/en-us/golf-clubs/wedges/s259-wedge';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ping/s259/s259-wedge/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '4d47927b-890b-5977-90c1-3dcba32c02de' and equipment_model_id = '3c158b87-6d8a-544a-a896-e21aeed03220'
     and source_url = 'https://www.taylormadegolf.com/MG5-Wedge/DW-TC647.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for taylormade/mg5/mg5-wedge/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '9d6e74ff-f4e4-5661-a361-f1a38459f2f2' and equipment_model_id = 'dae7e91f-c275-5db5-9869-5b9450ead1d1'
     and source_url = 'https://www.taylormadegolf.com/P%E2%88%99790-Irons/DW-TC635.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for taylormade/p790/p790-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '01812abd-4913-5815-9b19-7d1b7ecefecb' and equipment_model_id = '391d3044-8395-5106-a1d2-4bd58656c412'
     and source_url = 'https://www.taylormadegolf.com/on/demandware.static/-/Sites-TMaG-Library/en_US/v1736272938439/docs/productspecs/2025/Qi35-Core-Driver.pdf';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for taylormade/qi35/qi35-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '612845e7-b46b-5fa5-9638-afdf8b50a5e1' and equipment_model_id = 'ac1ad455-ed47-5489-bf3d-5c4d103cafb7'
     and source_url = 'https://www.taylormadegolf.com/Qi35-Fairway/DW-TC373.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for taylormade/qi35/qi35-fairway/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '10e03a4c-c24f-5ba2-9bdb-fa4c4385f926' and equipment_model_id = 'fb465f5d-a6a2-5adb-953f-9674035fe34b'
     and source_url = 'https://www.taylormadegolf.com/Qi35-3-Rescue/M1465109.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for taylormade/qi35/qi35-rescue/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '3f1560aa-1ae2-5e20-bed0-35641113625f' and equipment_model_id = 'efb1fd7c-9344-5801-8962-a34962e89e0e'
     and source_url = 'https://www.titleist.com/golf-clubs/drivers/gt2';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for titleist/gt2/gt2-driver/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = 'd4f70b18-05d0-5483-a174-d407753b4c9d' and equipment_model_id = '47f3a7c5-7ffa-58af-b30a-5564d5f9869e'
     and source_url = 'https://www.titleist.com/golf-clubs/fairways/gt2';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for titleist/gt2/gt2-fairway/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '89dc7716-221f-5ca8-b1f9-114eff97102c' and equipment_model_id = '90368084-d86b-512f-a554-87c126175621'
     and source_url = 'https://www.titleist.com/product/gt2-hybrid/675C.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for titleist/gt2/gt2-hybrid/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '5846df39-baa1-5ec9-baec-0edf2ca6775a' and equipment_model_id = '999ebceb-8d17-58c9-a761-881e3d60734e'
     and source_url = 'https://www.titleist.com/product/t250/561C.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for titleist/t250/t250-irons/v1.';
  end if;
  select count(*) into v_count from public.equipment_model_sources
   where id = '060cd85d-336e-5c33-9a27-a129f191c96d' and equipment_model_id = '9f827747-7c1e-59c7-ab27-169525990448'
     and source_url = 'https://www.titleist.com/product/vokey-sm11/MASTER-SM11.html';
  if v_count <> 1 then
    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for titleist/vokey-design/vokey-sm11-wedge/v1.';
  end if;

  select count(*) into v_count from (
    select s.equipment_model_id
      from public.equipment_model_sources s
      join public.equipment_models m on m.id = s.equipment_model_id
     where m.club_type <> 'Putter'::public.club_type_enum
     group by s.equipment_model_id
    having count(*) <> 1
  ) as offending_sources;
  if v_count <> 0 then
    raise exception 'EQ2S2-POST-12: % non-putter models do not have exactly one provenance row.', v_count;
  end if;

  -- The original 21 putter identities remain present and unmodified in identity.
  select array_agg(catalog_key order by catalog_key) into v_actual_putter_keys
    from public.equipment_models where club_type = 'Putter'::public.club_type_enum;
  if v_actual_putter_keys is distinct from v_expected_putter_keys then
    raise exception 'EQ2S2-POST-13: the original 21 putter catalog_key set is no longer intact.';
  end if;

  select count(*) into v_count from public.equipment_putter_model_specs s
    join public.equipment_models m on m.id = s.equipment_model_id
   where m.club_type = 'Putter'::public.club_type_enum;
  if v_count <> 21 then
    raise exception 'EQ2S2-POST-14: expected all 21 putter-spec relationships to remain intact, found %.', v_count;
  end if;

  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ2S2-POST-15: this migration must not link any user_equipment row to a catalog model, found %.', v_count;
  end if;
end $$;

commit;
