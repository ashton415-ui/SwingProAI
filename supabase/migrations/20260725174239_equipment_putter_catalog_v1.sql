-- ============================================================================
-- SwingProAI — EQ1-S2 Curated Putter Equipment Catalog v1 (Canonical Source Artifact)
-- ============================================================================
--
-- PRODUCTION STATE VERIFIED PRESENT. This migration remains the canonical
-- reproducible source artifact. Historical application mechanism/date and
-- staging application status are not asserted here.
--
-- Generated deterministically by scripts/generate-equipment-catalog-putters-v1.mjs
-- from data/equipment-catalog-putters-v1.json. Do not hand-edit this file —
-- edit the JSON source and regenerate.
--
-- Adds putter-specific fitting metadata (public.equipment_putter_model_specs)
-- and isolated, non-browser-readable source provenance
-- (public.equipment_model_sources) on top of the EQ1-S1R equipment catalog
-- foundation, then seeds 21 officially verified, currently marketed
-- putter models across all five existing parent manufacturers (TaylorMade,
-- Callaway, Titleist, PING, Mizuno). Consumer-facing sub-brands (e.g. Odyssey
-- under Callaway, Scotty Cameron under Titleist) are represented via the new
-- nullable brand_line/brand_line_slug columns on equipment_models, never as
-- additional parent manufacturer rows.
--
-- Model identity is anchored to an immutable catalog_key per model, and every
-- model/source UUID is a deterministic UUIDv5 derived from that key so display
-- names, slugs, and metadata remain freely correctable without ever changing
-- a model's identity.
--
-- SCOPE BOUNDARY
-- ---------------
-- This migration does NOT modify public.user_equipment, public.swing_analysis,
-- public.user_bags, or public.user_clubs. It performs zero backfill, zero
-- fuzzy matching, and zero alias-table creation. It does NOT alter
-- equipment_snapshot schema_version (remains 1) or either EQ1-S1R trigger
-- function. This file is the canonical source artifact for that schema and
-- asserts no application history of its own.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================
do $$
declare
  v_manufacturer_slugs text[] := array['taylormade','callaway','titleist','ping','mizuno'];
  v_slug text;
  v_count int;
begin
  if to_regclass('public.equipment_manufacturers') is null then
    raise exception 'EQ1S2-PRE-1: public.equipment_manufacturers does not exist.';
  end if;
  if to_regclass('public.equipment_models') is null then
    raise exception 'EQ1S2-PRE-2: public.equipment_models does not exist.';
  end if;
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) then
    raise exception 'EQ1S2-PRE-3: public.club_type_enum does not exist.';
  end if;

  foreach v_slug in array v_manufacturer_slugs loop
    select count(*) into v_count from public.equipment_manufacturers where slug = v_slug;
    if v_count <> 1 then
      raise exception 'EQ1S2-PRE-4: expected exactly one manufacturer with slug %, found %.', v_slug, v_count;
    end if;
  end loop;

  select count(*) into v_count from public.equipment_models;
  if v_count <> 0 then
    raise exception 'EQ1S2-PRE-5: public.equipment_models must contain zero rows before this migration, found %.', v_count;
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'catalog_key') then
    raise exception 'EQ1S2-PRE-6: public.equipment_models.catalog_key already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'brand_line') then
    raise exception 'EQ1S2-PRE-7: public.equipment_models.brand_line already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'model_family') then
    raise exception 'EQ1S2-PRE-8: public.equipment_models.model_family already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'release_year') then
    raise exception 'EQ1S2-PRE-9: public.equipment_models.release_year already exists.';
  end if;

  if to_regclass('public.equipment_putter_model_specs') is not null then
    raise exception 'EQ1S2-PRE-10: public.equipment_putter_model_specs already exists.';
  end if;
  if to_regclass('public.equipment_model_sources') is not null then
    raise exception 'EQ1S2-PRE-11: public.equipment_model_sources already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and con.conname = 'equipment_models_slug_unique'
  ) or exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equipment_models_slug_unique'
  ) then
    raise exception 'EQ1S2-PRE-16: equipment_models_slug_unique already exists.';
  end if;

  if (
    select array_agg(e.enumlabel::text order by e.enumsortorder)
    from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) is distinct from array['Driver','Wood','Hybrid','Iron','Wedge','Putter'] then
    raise exception 'EQ1S2-PRE-12: public.club_type_enum values have changed from the expected six values.';
  end if;

  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    raise exception 'EQ1S2-PRE-13: current role % lacks CREATE privilege on schema public.', current_user;
  end if;

  if current_setting('server_version_num')::int < 140000 then
    raise exception 'EQ1S2-PRE-14: PostgreSQL server_version_num % is below the minimum supported 140000.', current_setting('server_version_num');
  end if;

  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ1S2-PRE-15: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_valid_putter_standard_lengths'
  ) then
    raise exception 'EQ1S2-PRE-17: public.is_valid_putter_standard_lengths already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and con.conname = 'equipment_putter_model_specs_lengths_valid'
  ) then
    raise exception 'EQ1S2-PRE-18: equipment_putter_model_specs_lengths_valid already exists.';
  end if;

  raise notice 'EQ1S2-PRE-OK: reconciled schema matched, no conflicting objects found — proceeding.';
end $$;

-- ============================================================================
-- equipment_models additions
-- ============================================================================

alter table public.equipment_models
  add column catalog_key text not null default '',
  add column brand_line text,
  add column brand_line_slug text,
  add column model_family text,
  add column model_family_slug text,
  add column release_year smallint;

alter table public.equipment_models
  alter column catalog_key drop default;

alter table public.equipment_models
  add constraint equipment_models_catalog_key_nonblank check (btrim(catalog_key) <> ''),
  add constraint equipment_models_catalog_key_format check (catalog_key ~ '^[a-z0-9]+(/[a-z0-9-]+)+$'),
  add constraint equipment_models_catalog_key_unique unique (catalog_key),
  add constraint equipment_models_brand_line_pair check (
    (brand_line is null and brand_line_slug is null) or (brand_line is not null and brand_line_slug is not null)
  ),
  add constraint equipment_models_brand_line_slug_format check (
    brand_line_slug is null or brand_line_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  add constraint equipment_models_model_family_pair check (
    (model_family is null and model_family_slug is null) or (model_family is not null and model_family_slug is not null)
  ),
  add constraint equipment_models_model_family_slug_format check (
    model_family_slug is null or model_family_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  add constraint equipment_models_release_year_range check (
    release_year is null or release_year between 1900 and 2100
  );

-- Global slug uniqueness, in addition to (and not replacing) the existing
-- equipment_models_manufacturer_type_name_year_uidx compound identity index.
-- Safe to add here because EQ1S2-PRE-5 already requires zero existing rows.
alter table public.equipment_models
  add constraint equipment_models_slug_unique unique (slug);

-- ============================================================================
-- Database-level standard-length validation (EQ1-S2-A1-C2)
--
-- The generator already rejects a nonempty/sorted/unique/[20,60]-bounded
-- violation at authoring time (validateAndLoad), but that check-time-only
-- guarantee is not a substitute for a live database constraint. This
-- function is the single source of truth for what a valid populated
-- standard_lengths_inches array looks like at the database layer.
-- ============================================================================

create function public.is_valid_putter_standard_lengths(
  p_lengths numeric[]
)
returns boolean
language sql
immutable
strict
security invoker
set search_path to ''
as $function$
  select
    pg_catalog.array_ndims(p_lengths) = 1
    and pg_catalog.cardinality(p_lengths) > 0
    and not exists (
      select 1
      from pg_catalog.generate_subscripts(p_lengths, 1) as s(i)
      where p_lengths[s.i] is null
         or p_lengths[s.i] < 20
         or p_lengths[s.i] > 60
         or (
           s.i > pg_catalog.array_lower(p_lengths, 1)
           and p_lengths[s.i] <= p_lengths[s.i - 1]
         )
    );
$function$;

revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from public;
revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from anon;
revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from authenticated;
grant execute on function public.is_valid_putter_standard_lengths(numeric[]) to service_role;

-- ============================================================================
-- public.equipment_putter_model_specs
-- ============================================================================

create table public.equipment_putter_model_specs (
  equipment_model_id uuid not null,
  head_shape text not null,
  neck_type text,
  neck_source_label text,
  toe_hang_class text,
  face_construction text,
  handedness text,
  standard_lengths_inches numeric[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_putter_model_specs_pkey primary key (equipment_model_id),
  constraint equipment_putter_model_specs_model_fkey foreign key (equipment_model_id)
    references public.equipment_models (id) on delete cascade,
  constraint equipment_putter_model_specs_head_shape_check check (
    head_shape in ('blade','mid_mallet','mallet')
  ),
  constraint equipment_putter_model_specs_neck_type_check check (
    neck_type is null or neck_type in (
      'plumbers_neck','slant_neck','flow_neck','long_neck',
      'single_bend','double_bend','center_shaft','broomstick_center_shaft'
    )
  ),
  constraint equipment_putter_model_specs_neck_source_label_nonblank check (
    neck_source_label is null or btrim(neck_source_label) <> ''
  ),
  constraint equipment_putter_model_specs_toe_hang_class_check check (
    toe_hang_class is null or toe_hang_class in ('face_balanced','slight','moderate','strong','toe_down')
  ),
  constraint equipment_putter_model_specs_face_construction_check check (
    face_construction is null or face_construction in ('milled','insert','hybrid')
  ),
  constraint equipment_putter_model_specs_handedness_check check (
    handedness is null or handedness in ('right','left','both')
  ),
  constraint equipment_putter_model_specs_lengths_nonempty check (
    standard_lengths_inches is null or cardinality(standard_lengths_inches) > 0
  ),
  constraint equipment_putter_model_specs_lengths_valid check (
    standard_lengths_inches is null
    or public.is_valid_putter_standard_lengths(
      standard_lengths_inches
    )
  )
);

create trigger equipment_putter_model_specs_set_updated_at
  before update on public.equipment_putter_model_specs
  for each row execute function public.handle_updated_at();

-- Database-enforced rule: only Putter-club-type models may have a specs row.
create function public.guard_putter_model_specs_club_type()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_club_type public.club_type_enum;
begin
  select club_type into v_club_type from public.equipment_models where equipment_models.id = new.equipment_model_id;

  if not found then
    raise exception 'EQ1S2: equipment_model_id % does not reference an existing equipment model.', new.equipment_model_id;
  end if;

  if v_club_type is distinct from 'Putter'::public.club_type_enum then
    raise exception 'EQ1S2: equipment_putter_model_specs rows are only permitted for club_type = Putter models.';
  end if;

  return new;
end;
$function$;

create trigger equipment_putter_model_specs_guard_club_type
  before insert or update of equipment_model_id
  on public.equipment_putter_model_specs
  for each row execute function public.guard_putter_model_specs_club_type();

revoke all on function public.guard_putter_model_specs_club_type() from public;
revoke all on function public.guard_putter_model_specs_club_type() from anon;
revoke all on function public.guard_putter_model_specs_club_type() from authenticated;

-- ============================================================================
-- public.equipment_model_sources — isolated, never browser-readable
-- ============================================================================

create table public.equipment_model_sources (
  id uuid not null,
  equipment_model_id uuid not null,
  source_type text not null,
  source_name text not null,
  source_url text not null,
  verified_at date not null,
  created_at timestamptz not null default now(),
  constraint equipment_model_sources_pkey primary key (id),
  constraint equipment_model_sources_model_fkey foreign key (equipment_model_id)
    references public.equipment_models (id) on delete cascade,
  constraint equipment_model_sources_type_check check (
    source_type in ('official_product_page','official_spec_pdf','official_archive')
  ),
  constraint equipment_model_sources_name_nonblank check (btrim(source_name) <> ''),
  constraint equipment_model_sources_url_https check (source_url ~ '^https://'),
  constraint equipment_model_sources_verified_not_future check (verified_at <= current_date),
  constraint equipment_model_sources_model_url_unique unique (equipment_model_id, source_url)
);

-- ============================================================================
-- RLS and grants
-- ============================================================================

alter table public.equipment_putter_model_specs enable row level security;
alter table public.equipment_model_sources enable row level security;

-- Postgres/Supabase default privileges automatically grant new public tables
-- full CRUD to authenticated (and anon) at CREATE TABLE time; each must be
-- explicitly revoked before any intended grant is applied.
revoke all on public.equipment_putter_model_specs from public;
revoke all on public.equipment_putter_model_specs from anon;
revoke all on public.equipment_putter_model_specs from authenticated;
revoke all on public.equipment_model_sources from public;
revoke all on public.equipment_model_sources from anon;
revoke all on public.equipment_model_sources from authenticated;

grant select on public.equipment_putter_model_specs to authenticated;
grant select, insert, update, delete on public.equipment_putter_model_specs to service_role;

-- equipment_model_sources: service_role only. No authenticated grant at all —
-- provenance must never be reachable through the browser Data API.
grant select, insert, update, delete on public.equipment_model_sources to service_role;

create policy equipment_putter_model_specs_select_active_model
  on public.equipment_putter_model_specs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.equipment_models
      where equipment_models.id = equipment_putter_model_specs.equipment_model_id
        and equipment_models.is_active
    )
  );

-- ============================================================================
-- Seed data (generated — do not hand-edit)
-- ============================================================================

insert into public.equipment_models (
  id, manufacturer_id, club_type, canonical_name, slug, normalized_name,
  model_year, specifications, is_active,
  catalog_key, brand_line, brand_line_slug, model_family, model_family_slug, release_year
)
values
  ('c21858cc-613f-5708-8ba3-f4199ef4a945', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Putter'::public.club_type_enum, 'Odyssey Ai-ONE 2-Ball CH', 'ai-one-2-ball-ch', 'odysseyaione2ballch', null, '{}'::jsonb, true, 'callaway/odyssey/ai-one-2-ball-ch/v1', 'Odyssey', 'odyssey', 'Ai-ONE', 'ai-one', null),
  ('8209ad9d-202b-51ef-9fc3-a206d2ffe6dd', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Putter'::public.club_type_enum, 'Odyssey Ai-ONE Rossie DB', 'ai-one-rossie-db', 'odysseyaionerossiedb', null, '{}'::jsonb, true, 'callaway/odyssey/ai-one-rossie-db/v1', 'Odyssey', 'odyssey', 'Ai-ONE', 'ai-one', null),
  ('213eb82d-cf9b-533c-a277-fc52d04ad304', (select id from public.equipment_manufacturers where slug = 'callaway'), 'Putter'::public.club_type_enum, 'Odyssey Ai-ONE Square 2 Square #7 Center Shaft', 'ai-one-square-2-square-7-center-shaft', 'odysseyaionesquare2square7centershaft', null, '{}'::jsonb, true, 'callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1', 'Odyssey', 'odyssey', 'Ai-ONE Square 2 Square', 'ai-one-square-2-square', null),
  ('52159ff3-35f1-52b1-85a2-d1d3a471308e', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Putter'::public.club_type_enum, 'Mizuno M.Craft Kyoto.P', 'm-craft-kyoto-p', 'mizunomcraftkyotop', null, '{}'::jsonb, true, 'mizuno/m-craft/kyoto-p/v1', null, null, 'M.Craft', 'm-craft', null),
  ('bec3dae1-8018-5e71-9d92-ca71fe2a5f1a', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Putter'::public.club_type_enum, 'Mizuno M.Craft Kyoto.S', 'm-craft-kyoto-s', 'mizunomcraftkyotos', null, '{}'::jsonb, true, 'mizuno/m-craft/kyoto-s/v1', null, null, 'M.Craft', 'm-craft', null),
  ('29845a42-ffc8-5ac1-9b1f-5973219e52f0', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Putter'::public.club_type_enum, 'Mizuno M.Craft Tokyo.B', 'm-craft-tokyo-b', 'mizunomcrafttokyob', null, '{}'::jsonb, true, 'mizuno/m-craft/tokyo-b/v1', null, null, 'M.Craft', 'm-craft', null),
  ('cb70a3c4-69f8-54f5-80ba-1610424c1f39', (select id from public.equipment_manufacturers where slug = 'mizuno'), 'Putter'::public.club_type_enum, 'Mizuno M.Craft Tokyo.S', 'm-craft-tokyo-s', 'mizunomcrafttokyos', null, '{}'::jsonb, true, 'mizuno/m-craft/tokyo-s/v1', null, null, 'M.Craft', 'm-craft', null),
  ('aa1030dd-5e81-5e31-b4b3-bebe1b14ea63', (select id from public.equipment_manufacturers where slug = 'ping'), 'Putter'::public.club_type_enum, 'PING PLD Milled Anser 2D', 'pld-milled-anser-2d', 'pingpldmilledanser2d', null, '{}'::jsonb, true, 'ping/pld-milled/anser-2d/v1', null, null, 'PLD Milled', 'pld-milled', null),
  ('774b3448-59a4-59a5-8087-066f8c61896a', (select id from public.equipment_manufacturers where slug = 'ping'), 'Putter'::public.club_type_enum, 'PING PLD Milled Anser', 'pld-milled-anser', 'pingpldmilledanser', null, '{}'::jsonb, true, 'ping/pld-milled/anser/v1', null, null, 'PLD Milled', 'pld-milled', null),
  ('26beef6f-4d05-59ec-8f8a-5c53d112a766', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Putter'::public.club_type_enum, 'TaylorMade Spider Tour Double Bend', 'spider-tour-double-bend', 'taylormadespidertourdoublebend', null, '{}'::jsonb, true, 'taylormade/spider-tour/spider-tour-double-bend/v1', null, null, 'Spider Tour', 'spider-tour', null),
  ('b2f2b846-3eaf-513e-8cb6-dd51f934f804', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Putter'::public.club_type_enum, 'TaylorMade Spider Tour Small Slant', 'spider-tour-small-slant', 'taylormadespidertoursmallslant', null, '{}'::jsonb, true, 'taylormade/spider-tour/spider-tour-small-slant/v1', null, null, 'Spider Tour', 'spider-tour', null),
  ('82e275b8-f26a-57bd-9557-30eabb6865b5', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Putter'::public.club_type_enum, 'TaylorMade Spider Tour X Double Bend', 'spider-tour-x-double-bend', 'taylormadespidertourxdoublebend', null, '{}'::jsonb, true, 'taylormade/spider-tour/spider-tour-x-double-bend/v1', null, null, 'Spider Tour', 'spider-tour', null),
  ('faf2b59b-01cc-58b6-827c-6bb962d46bf2', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Putter'::public.club_type_enum, 'TaylorMade Spider Tour X L-Neck', 'spider-tour-x-l-neck', 'taylormadespidertourxlneck', null, '{}'::jsonb, true, 'taylormade/spider-tour/spider-tour-x-l-neck/v1', null, null, 'Spider Tour', 'spider-tour', null),
  ('5143c663-7207-5b5e-8bc5-65a0888e667e', (select id from public.equipment_manufacturers where slug = 'taylormade'), 'Putter'::public.club_type_enum, 'TaylorMade Spider Tour X Small Slant', 'spider-tour-x-small-slant', 'taylormadespidertourxsmallslant', null, '{}'::jsonb, true, 'taylormade/spider-tour/spider-tour-x-small-slant/v1', null, null, 'Spider Tour', 'spider-tour', null),
  ('42149734-9d75-5364-b8f0-c71cbe7ad19e', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 5.2', 'phantom-5-2', 'scottycameronphantom52', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-5-2/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('83463ffd-5d64-507f-94be-aaf0e9c51e32', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 5.5', 'phantom-5-5', 'scottycameronphantom55', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-5-5/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('d10e5bd9-b33c-58ce-9f59-2a92c4a85d47', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 5 OC', 'phantom-5-oc', 'scottycameronphantom5oc', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-5-oc/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('8db96cdd-61d5-591a-9d48-11b1e5a0518d', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 5', 'phantom-5', 'scottycameronphantom5', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-5/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('4cf03d1f-acd2-5031-9add-b03a23c3a68f', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 7.2', 'phantom-7-2', 'scottycameronphantom72', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-7-2/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('85f50cb2-5b83-5c03-bb67-8eb604094158', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 7.5', 'phantom-7-5', 'scottycameronphantom75', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-7-5/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null),
  ('14d9aae7-766c-5a4e-932d-ec8e3dc29766', (select id from public.equipment_manufacturers where slug = 'titleist'), 'Putter'::public.club_type_enum, 'Scotty Cameron Phantom 7', 'phantom-7', 'scottycameronphantom7', null, '{}'::jsonb, true, 'titleist/scotty-cameron/phantom-7/v1', 'Scotty Cameron', 'scotty-cameron', 'Phantom', 'phantom', null);

insert into public.equipment_putter_model_specs (
  equipment_model_id, head_shape, neck_type, neck_source_label,
  toe_hang_class, face_construction, handedness, standard_lengths_inches
)
values
  ('c21858cc-613f-5708-8ba3-f4199ef4a945', 'mallet', null, 'Crank Hosel', 'moderate', 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('8209ad9d-202b-51ef-9fc3-a206d2ffe6dd', 'mallet', 'double_bend', 'Double Bend', 'face_balanced', 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('213eb82d-cf9b-533c-a277-fc52d04ad304', 'mallet', 'center_shaft', 'Center Shaft', null, 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('52159ff3-35f1-52b1-85a2-d1d3a471308e', 'blade', 'plumbers_neck', 'Kyoto.P', null, 'milled', 'both', array[34, 35]::numeric[]),
  ('bec3dae1-8018-5e71-9d92-ca71fe2a5f1a', 'blade', 'slant_neck', 'Kyoto.S', null, 'milled', 'right', array[34, 35]::numeric[]),
  ('29845a42-ffc8-5ac1-9b1f-5973219e52f0', 'mallet', 'double_bend', 'Tokyo.B', null, 'milled', 'right', array[34, 35]::numeric[]),
  ('cb70a3c4-69f8-54f5-80ba-1610424c1f39', 'mallet', 'slant_neck', 'Tokyo.S', null, 'milled', 'right', array[34, 35]::numeric[]),
  ('aa1030dd-5e81-5e31-b4b3-bebe1b14ea63', 'blade', null, 'H1 Hosel', null, 'milled', null, array[35]::numeric[]),
  ('774b3448-59a4-59a5-8087-066f8c61896a', 'blade', null, 'H1 Hosel', null, 'milled', null, array[35]::numeric[]),
  ('26beef6f-4d05-59ec-8f8a-5c53d112a766', 'mallet', 'double_bend', 'Double Bend', 'face_balanced', 'insert', 'both', array[34, 35]::numeric[]),
  ('b2f2b846-3eaf-513e-8cb6-dd51f934f804', 'mallet', 'slant_neck', 'Small Slant', null, 'insert', 'both', array[33, 34, 35]::numeric[]),
  ('82e275b8-f26a-57bd-9557-30eabb6865b5', 'mallet', 'double_bend', 'Double Bend', 'face_balanced', 'insert', 'right', array[34, 35]::numeric[]),
  ('faf2b59b-01cc-58b6-827c-6bb962d46bf2', 'mallet', null, 'L-Neck', null, 'insert', 'right', array[34, 35]::numeric[]),
  ('5143c663-7207-5b5e-8bc5-65a0888e667e', 'mallet', 'slant_neck', 'Small Slant', null, 'insert', 'both', array[34, 35]::numeric[]),
  ('42149734-9d75-5364-b8f0-c71cbe7ad19e', 'mallet', 'plumbers_neck', 'Plumbing Neck', null, 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('83463ffd-5d64-507f-94be-aaf0e9c51e32', 'mallet', null, 'Jet Neck', null, 'insert', 'both', array[33, 34, 35]::numeric[]),
  ('d10e5bd9-b33c-58ce-9f59-2a92c4a85d47', 'mallet', 'center_shaft', 'Onset Center (OC)', null, 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('8db96cdd-61d5-591a-9d48-11b1e5a0518d', 'mallet', 'single_bend', 'Mid-Single Bend', null, 'insert', null, array[33, 34, 35]::numeric[]),
  ('4cf03d1f-acd2-5031-9add-b03a23c3a68f', 'mallet', 'plumbers_neck', 'Plumbing Neck', null, 'insert', 'right', array[33, 34, 35]::numeric[]),
  ('85f50cb2-5b83-5c03-bb67-8eb604094158', 'mallet', null, 'Jet Neck', null, 'insert', 'both', array[33, 34, 35]::numeric[]),
  ('14d9aae7-766c-5a4e-932d-ec8e3dc29766', 'mallet', 'double_bend', 'Double Bend', null, 'insert', 'both', array[33, 34, 35]::numeric[]);

insert into public.equipment_model_sources (
  id, equipment_model_id, source_type, source_name, source_url, verified_at
)
values
  ('29ed8e7f-cab5-555d-85a1-ccaf2481c2f6', 'c21858cc-613f-5708-8ba3-f4199ef4a945', 'official_product_page', 'Odyssey Ai-ONE 2-Ball CH product page', 'https://odyssey.callawaygolf.com/ody/putters/ai-one/putters-2024-ai-one-2-ball-ch.html', '2026-07-25'::date),
  ('018d9ada-875b-5fe7-820e-fba9dac88711', '8209ad9d-202b-51ef-9fc3-a206d2ffe6dd', 'official_product_page', 'Odyssey Ai-ONE Rossie DB product page', 'https://odyssey.callawaygolf.com/putters/ai-one/putters-2024-ai-one-rossie-db.html', '2026-07-25'::date),
  ('4c7c8b74-237a-5120-b014-e78c5aedcdb7', '213eb82d-cf9b-533c-a277-fc52d04ad304', 'official_product_page', 'Odyssey Ai-ONE Square 2 Square #7 product page', 'https://www.callawaygolf.com/square-2-square/putters-2025-square-to-square-seven.html', '2026-07-25'::date),
  ('f2b0aa68-53a2-5b9c-82e5-4380a2c9cf1e', '52159ff3-35f1-52b1-85a2-d1d3a471308e', 'official_product_page', 'Mizuno M.Craft putters page', 'https://mizunogolf.com/us/golf-clubs/m-craft-putters/', '2026-07-25'::date),
  ('b5956352-866a-54f2-a7a6-ba15099a4f82', 'bec3dae1-8018-5e71-9d92-ca71fe2a5f1a', 'official_product_page', 'Mizuno M.Craft putters page', 'https://mizunogolf.com/us/golf-clubs/m-craft-putters/', '2026-07-25'::date),
  ('95ec59e4-dc27-5ad0-bdb4-c2544cda01a9', '29845a42-ffc8-5ac1-9b1f-5973219e52f0', 'official_product_page', 'Mizuno M.Craft putters page', 'https://mizunogolf.com/us/golf-clubs/m-craft-putters/', '2026-07-25'::date),
  ('e2fa9427-17cb-5fec-a5c7-8842f16e2acb', 'cb70a3c4-69f8-54f5-80ba-1610424c1f39', 'official_product_page', 'Mizuno M.Craft putters page', 'https://mizunogolf.com/us/golf-clubs/m-craft-putters/', '2026-07-25'::date),
  ('0d568572-adc5-5112-ad44-41be4ed01a0e', 'aa1030dd-5e81-5e31-b4b3-bebe1b14ea63', 'official_product_page', 'PING PLD Milled Anser 2D product page', 'https://ping.com/en-us/clubs/putters/pld-milled-plus/anser-2d', '2026-07-25'::date),
  ('d39a2fdd-54c7-5111-aa47-a125e571ca86', '774b3448-59a4-59a5-8087-066f8c61896a', 'official_product_page', 'PING PLD Milled Anser product page', 'https://ping.com/en-us/clubs/putters/pld-milled-plus/anser', '2026-07-25'::date),
  ('8b2b0d0c-2b3d-56d6-b629-3f8a5071bc02', '26beef6f-4d05-59ec-8f8a-5c53d112a766', 'official_product_page', 'TaylorMade Spider Tour Double Bend product page', 'https://www.taylormadegolf.com/Spider-Tour-Double-Bend/DW-TC845.html', '2026-07-25'::date),
  ('e52b095d-851c-5559-9195-9dc48cfad781', 'b2f2b846-3eaf-513e-8cb6-dd51f934f804', 'official_product_page', 'TaylorMade Spider Tour Small Slant product page', 'https://www.taylormadegolf.com/Spider-Tour-Small-Slant-/DW-TE672.html', '2026-07-25'::date),
  ('c7116e05-798b-5375-88af-8175cbd2cf6a', '82e275b8-f26a-57bd-9557-30eabb6865b5', 'official_product_page', 'TaylorMade Spider Tour X Double Bend product page', 'https://www.taylormadegolf.com/Spider-Tour-X-Double-Bend/DW-TC847.html', '2026-07-25'::date),
  ('2df633ad-8851-58db-8687-f34e5858eed5', 'faf2b59b-01cc-58b6-827c-6bb962d46bf2', 'official_product_page', 'TaylorMade Spider Tour X L-Neck product page', 'https://www.taylormadegolf.com/Spider-Tour-X-L-Neck/DW-TC928.html', '2026-07-25'::date),
  ('bcad2448-1e07-5cc6-bca0-56fce33991c0', '5143c663-7207-5b5e-8bc5-65a0888e667e', 'official_product_page', 'TaylorMade Spider Tour X Small Slant product page', 'https://www.taylormadegolf.com/Spider-Tour-X-Small-Slant/DW-TE675.html', '2026-07-25'::date),
  ('0742db26-48db-5549-bc1b-a90e72beedfc', '42149734-9d75-5364-b8f0-c71cbe7ad19e', 'official_product_page', 'Scotty Cameron Phantom 5.2 product page', 'https://www.scottycameron.com/putters/phantom/phantom-5-2/', '2026-07-25'::date),
  ('1f54a54e-8188-5e49-bb78-e18dc8522165', '83463ffd-5d64-507f-94be-aaf0e9c51e32', 'official_product_page', 'Scotty Cameron Phantom 5.5 product page', 'https://www.scottycameron.com/putters/phantom/phantom-5-5/', '2026-07-25'::date),
  ('c509922c-f996-54f1-961a-c9785944d6fe', 'd10e5bd9-b33c-58ce-9f59-2a92c4a85d47', 'official_product_page', 'Scotty Cameron Phantom 5 OC product page', 'https://www.scottycameron.com/putters/phantom/phantom-5-oc/', '2026-07-25'::date),
  ('b0bcf01b-c860-58f6-8c85-31fa87e5d0dc', '8db96cdd-61d5-591a-9d48-11b1e5a0518d', 'official_product_page', 'Scotty Cameron Phantom 5 product page', 'https://www.scottycameron.com/putters/phantom/phantom-5/', '2026-07-25'::date),
  ('bd070ada-0418-5ec0-8c30-f93dbb85e4d7', '4cf03d1f-acd2-5031-9add-b03a23c3a68f', 'official_product_page', 'Scotty Cameron Phantom 7.2 product page', 'https://www.scottycameron.com/putters/phantom/phantom-7-2/', '2026-07-25'::date),
  ('c8849caf-a75e-5fe0-b5a1-8e30bd6ce735', '85f50cb2-5b83-5c03-bb67-8eb604094158', 'official_product_page', 'Scotty Cameron Phantom 7.5 product page', 'https://www.scottycameron.com/putters/phantom/phantom-7-5/', '2026-07-25'::date),
  ('1763286a-d671-51db-bda6-c361c1e3a00e', '14d9aae7-766c-5a4e-932d-ec8e3dc29766', 'official_product_page', 'Scotty Cameron Phantom 7 product page', 'https://www.scottycameron.com/putters/phantom/phantom-7/', '2026-07-25'::date);

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================
do $$
declare
  v_count int;
  v_model_count int;
  v_spec_count int;
  v_source_count int;
  v_manufacturer_count int;
  v_fn record;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_putter_model_specs' and c.relkind = 'r') then
    raise exception 'EQ1S2-POST-1: public.equipment_putter_model_specs was not created.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_model_sources' and c.relkind = 'r') then
    raise exception 'EQ1S2-POST-2: public.equipment_model_sources was not created.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'equipment_models'
      and column_name in ('catalog_key','brand_line','brand_line_slug','model_family','model_family_slug','release_year');
  if v_count <> 6 then
    raise exception 'EQ1S2-POST-3: public.equipment_models is missing one or more required new columns (found %).', v_count;
  end if;

  select count(*) into v_model_count from public.equipment_models;
  if v_model_count <> 21 then
    raise exception 'EQ1S2-POST-4: expected exactly 21 equipment_models rows, found %.', v_model_count;
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models'
      and con.conname = 'equipment_models_slug_unique' and con.contype = 'u'
  ) then
    raise exception 'EQ1S2-POST-29: equipment_models_slug_unique is missing or is not a unique constraint.';
  end if;

  if (
    select array_agg(a.attname::text order by a.attname)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join unnest(con.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = rel.oid and a.attnum = k.attnum
    where rel.relname = 'equipment_models' and con.conname = 'equipment_models_slug_unique'
  ) is distinct from array['slug'] then
    raise exception 'EQ1S2-POST-30: equipment_models_slug_unique is not scoped to exactly the slug column.';
  end if;

  -- Live proof that a duplicate slug is actually rejected by PostgreSQL, not
  -- merely declared. The nested exception block acts as an implicit
  -- savepoint: on unique_violation the failed insert is undone and the
  -- outer transaction (this migration) is otherwise unaffected.
  declare
    v_existing_manufacturer_id uuid;
    v_existing_slug text;
  begin
    select manufacturer_id, slug into v_existing_manufacturer_id, v_existing_slug
      from public.equipment_models order by slug limit 1;
    begin
      insert into public.equipment_models (
        id, manufacturer_id, club_type, canonical_name, slug, normalized_name, catalog_key
      ) values (
        gen_random_uuid(), v_existing_manufacturer_id, 'Putter'::public.club_type_enum,
        'EQ1S2-POST-31-duplicate-slug-probe', v_existing_slug, 'eq1s2post31probe',
        'eq1s2post31/duplicate-slug-probe/v1'
      );
      raise exception 'EQ1S2-POST-31: a duplicate equipment_models.slug was unexpectedly accepted.';
    exception when unique_violation then
      null; -- expected: proves equipment_models_slug_unique is enforced live.
    end;
  end;

  select count(*) into v_count from public.equipment_models where canonical_name = 'EQ1S2-POST-31-duplicate-slug-probe';
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-32: the duplicate-slug probe row was unexpectedly persisted (rollback failed).';
  end if;

  -- Live proof that an explicit empty numeric array is actually rejected by
  -- PostgreSQL, not merely declared. Same implicit-savepoint pattern as the
  -- duplicate-slug proof above: on check_violation the failed update is
  -- undone and the outer transaction (this migration) is otherwise
  -- unaffected.
  declare
    v_length_probe_model_id uuid;
    v_original_lengths numeric[];
    v_lengths_after_probe numeric[];
  begin
    select equipment_model_id, standard_lengths_inches
      into v_length_probe_model_id, v_original_lengths
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
    order by equipment_model_id
    limit 1;

    if v_length_probe_model_id is null then
      raise exception 'EQ1S2-POST-33: no seeded non-null standard_lengths_inches row exists for the empty-array live probe.';
    end if;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = '{}'::numeric[]
      where equipment_model_id = v_length_probe_model_id;

      raise exception 'EQ1S2-POST-33: an empty standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null; -- expected: proves equipment_putter_model_specs_lengths_nonempty is enforced live.
    end;

    select standard_lengths_inches into v_lengths_after_probe
      from public.equipment_putter_model_specs
      where equipment_model_id = v_length_probe_model_id;

    if v_lengths_after_probe is distinct from v_original_lengths then
      raise exception 'EQ1S2-POST-34: the rejected empty-array probe did not restore the original standard_lengths_inches.';
    end if;
  end;

  -- EQ1-S2-A1-C2: database-level standard-length integrity (function
  -- contract, constraint wiring, privilege boundary, live invalid-array
  -- rejection proofs).
  declare
    v_length_fn_lang name;
    v_length_fn_volatile "char";
    v_length_fn_strict boolean;
    v_length_fn_secdef boolean;
    v_length_fn_def text;
    v_length_fn_args text;
    v_length_fn_ret text;
    v_length_con_def text;
    v_length_valid_probe_model_id uuid;
    v_length_valid_probe_original numeric[];
    v_length_valid_probe_after numeric[];
    v_invalid_row_count integer;
  begin
    select l.lanname, p.provolatile, p.proisstrict, p.prosecdef, pg_catalog.pg_get_functiondef(p.oid),
           pg_catalog.pg_get_function_arguments(p.oid), pg_catalog.pg_get_function_result(p.oid)
      into v_length_fn_lang, v_length_fn_volatile, v_length_fn_strict, v_length_fn_secdef, v_length_fn_def,
           v_length_fn_args, v_length_fn_ret
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.proname = 'is_valid_putter_standard_lengths';

    if v_length_fn_lang is null then
      raise exception 'EQ1S2-POST-35: public.is_valid_putter_standard_lengths does not exist.';
    end if;
    if v_length_fn_lang <> 'sql' then
      raise exception 'EQ1S2-POST-35: expected language sql for is_valid_putter_standard_lengths, found %.', v_length_fn_lang;
    end if;
    if v_length_fn_volatile <> 'i' then
      raise exception 'EQ1S2-POST-35: expected IMMUTABLE volatility, found %.', v_length_fn_volatile;
    end if;
    if not v_length_fn_strict then
      raise exception 'EQ1S2-POST-35: expected STRICT, function is not strict.';
    end if;
    if v_length_fn_secdef then
      raise exception 'EQ1S2-POST-35: expected SECURITY INVOKER, found SECURITY DEFINER.';
    end if;
    if v_length_fn_def not ilike '%set search_path to %''%' then
      raise exception 'EQ1S2-POST-35: is_valid_putter_standard_lengths does not set an empty search_path.';
    end if;
    if v_length_fn_args <> 'p_lengths numeric[]' then
      raise exception 'EQ1S2-POST-35: expected argument p_lengths numeric[], found %.', v_length_fn_args;
    end if;
    if v_length_fn_ret <> 'boolean' then
      raise exception 'EQ1S2-POST-35: expected boolean return type, found %.', v_length_fn_ret;
    end if;

    select pg_catalog.pg_get_constraintdef(con.oid) into v_length_con_def
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_putter_model_specs'
      and con.conname = 'equipment_putter_model_specs_lengths_valid' and con.contype = 'c';

    if v_length_con_def is null then
      raise exception 'EQ1S2-POST-36: equipment_putter_model_specs_lengths_valid is missing or is not a CHECK constraint.';
    end if;
    if v_length_con_def not ilike '%is_valid_putter_standard_lengths(standard_lengths_inches)%' then
      raise exception 'EQ1S2-POST-36: equipment_putter_model_specs_lengths_valid does not call is_valid_putter_standard_lengths(standard_lengths_inches).';
    end if;

    if exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'is_valid_putter_standard_lengths'
        and grantee in ('PUBLIC','anon','authenticated')
    ) then
      raise exception 'EQ1S2-POST-37: is_valid_putter_standard_lengths remains executable by PUBLIC, anon, or authenticated.';
    end if;

    if not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'is_valid_putter_standard_lengths'
        and grantee = 'service_role' and privilege_type = 'EXECUTE'
    ) then
      raise exception 'EQ1S2-POST-38: service_role is missing EXECUTE on is_valid_putter_standard_lengths.';
    end if;

    select equipment_model_id, standard_lengths_inches
      into v_length_valid_probe_model_id, v_length_valid_probe_original
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
    order by equipment_model_id
    limit 1;

    if v_length_valid_probe_model_id is null then
      raise exception 'EQ1S2-POST-39: no seeded non-null standard_lengths_inches row exists for the invalid-array live probes.';
    end if;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[35,34]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-39: an unsorted standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[34,34]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-40: a duplicate-value standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[19]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-41: a below-range standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[61]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-42: an above-range standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[34,null]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-43: a NULL-containing standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[[34,35],[36,37]]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-44: a multidimensional standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    select standard_lengths_inches into v_length_valid_probe_after
    from public.equipment_putter_model_specs
    where equipment_model_id = v_length_valid_probe_model_id;

    if v_length_valid_probe_after is distinct from v_length_valid_probe_original then
      raise exception 'EQ1S2-POST-45: the rejected invalid-array probes did not restore the original standard_lengths_inches.';
    end if;

    select count(*) into v_invalid_row_count
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
      and not public.is_valid_putter_standard_lengths(standard_lengths_inches);

    if v_invalid_row_count <> 0 then
      raise exception 'EQ1S2-POST-46: % persisted equipment_putter_model_specs row(s) have an invalid standard_lengths_inches value.', v_invalid_row_count;
    end if;
  end;

  select count(*) into v_spec_count from public.equipment_putter_model_specs;
  if v_spec_count <> v_model_count then
    raise exception 'EQ1S2-POST-5: expected % equipment_putter_model_specs rows (one per model), found %.', v_model_count, v_spec_count;
  end if;

  select count(*) into v_source_count from public.equipment_model_sources;
  if v_source_count <> 21 then
    raise exception 'EQ1S2-POST-6: expected exactly 21 equipment_model_sources rows, found %.', v_source_count;
  end if;

  select count(*) into v_manufacturer_count from public.equipment_manufacturers;
  if v_manufacturer_count <> 5 then
    raise exception 'EQ1S2-POST-7: expected exactly 5 parent manufacturers to remain, found %.', v_manufacturer_count;
  end if;

  if exists (
    select 1 from public.equipment_models m
    where not exists (select 1 from public.equipment_manufacturers mf where mf.id = m.manufacturer_id)
  ) then
    raise exception 'EQ1S2-POST-8: one or more equipment_models rows reference a nonexistent manufacturer.';
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter';
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-9: expected every seeded model to have club_type = Putter, found % exceptions.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models m
    where not exists (select 1 from public.equipment_putter_model_specs s where s.equipment_model_id = m.id);
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-10: % model(s) are missing a putter specs row.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models m
    where not exists (select 1 from public.equipment_model_sources s where s.equipment_model_id = m.id);
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-11: % model(s) are missing at least one source row.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where specifications <> '{}'::jsonb;
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-12: % seeded model(s) unexpectedly have a non-empty specifications jsonb.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where is_active is distinct from true;
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-13: % seeded model(s) are not is_active = true.', v_count;
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_putter_model_specs' and c.relrowsecurity) then
    raise exception 'EQ1S2-POST-14: RLS is not enabled on public.equipment_putter_model_specs.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_model_sources' and c.relrowsecurity) then
    raise exception 'EQ1S2-POST-15: RLS is not enabled on public.equipment_model_sources.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('equipment_putter_model_specs','equipment_model_sources') and grantee = 'anon'
  ) then
    raise exception 'EQ1S2-POST-16: anon has an unexpected grant on one of the new tables.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'EQ1S2-POST-17: authenticated has an unexpected write grant on equipment_putter_model_specs.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'equipment_model_sources' and grantee = 'authenticated'
  ) then
    raise exception 'EQ1S2-POST-18: authenticated unexpectedly has any grant on equipment_model_sources.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'authenticated' and privilege_type = 'SELECT') then
    raise exception 'EQ1S2-POST-19: authenticated is missing the required SELECT grant on equipment_putter_model_specs.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'service_role')
     or not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_model_sources' and grantee = 'service_role') then
    raise exception 'EQ1S2-POST-20: service_role is missing access on one or both new tables.';
  end if;

  for v_fn in
    select p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_putter_model_specs_club_type'
  loop
    if v_fn.def ilike '%security definer%' then
      raise exception 'EQ1S2-POST-21: function % is unexpectedly SECURITY DEFINER.', v_fn.proname;
    end if;
    if v_fn.def not ilike '%set search_path to %''%' then
      raise exception 'EQ1S2-POST-22: function % does not set an empty search_path.', v_fn.proname;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'guard_putter_model_specs_club_type'
      and grantee in ('PUBLIC','anon','authenticated')
  ) then
    raise exception 'EQ1S2-POST-23: guard_putter_model_specs_club_type remains executable by PUBLIC, anon, or authenticated.';
  end if;

  if to_regclass('public.equipment_manufacturer_aliases') is not null or to_regclass('public.equipment_model_aliases') is not null then
    raise exception 'EQ1S2-POST-24: an alias table exists but was not authorized for EQ1-S2.';
  end if;

  select count(*) into v_count from public.user_equipment where updated_at > (select min(created_at) from public.user_equipment);
  -- informational only; no user_equipment row is touched by this migration, verified structurally below.

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('user_equipment','swing_analysis','user_bags','user_clubs')
      and column_name in ('catalog_key','brand_line','model_family','release_year')
  ) then
    raise exception 'EQ1S2-POST-25: a user-owned table unexpectedly gained an EQ1-S2 column.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'equipment_snapshot'
  ) then
    raise exception 'EQ1S2-POST-26: swing_analysis.equipment_snapshot is unexpectedly missing.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'apply_swing_analysis_equipment_snapshot',
      'guard_swing_analysis_equipment_immutability',
      'validate_user_equipment_catalog_reference'
    )
  ) then
    raise exception 'EQ1S2-POST-27: one or more EQ1-S1R trigger functions are unexpectedly missing.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'analysis_mode' and data_type = 'text';
  if v_count <> 1 then
    raise exception 'EQ1S2-POST-28: swing_analysis.analysis_mode changed unexpectedly during this migration.';
  end if;

  raise notice 'EQ1S2-POST-OK: putter catalog v1 verified (% models, % specs, % sources, 5 manufacturers).', v_model_count, v_spec_count, v_source_count;
end $$;

commit;
