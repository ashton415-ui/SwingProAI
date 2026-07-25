-- ============================================================================
-- SwingProAI — EQ1-S1R Equipment Intelligence, Manufacturer Catalog,
-- Analysis-Family, and Premium Putting Foundation (Canonical, Source-Only)
-- ============================================================================
--
-- THIS MIGRATION IS SOURCE-ONLY. IT HAS NOT BEEN APPLIED TO ANY PROJECT.
--
-- WHAT THIS IS
-- ------------
-- Creates the secure data foundation for a normalized equipment-manufacturer
-- and club-model catalog, permanent equipment snapshots on swing analyses,
-- and server-authoritative putting-versus-full-swing routing. It extends —
-- and never duplicates — the putting-analysis infrastructure already present
-- in the live schema (swing_analysis.putt_tempo_ratio,
-- face_angle_at_impact_deg, path_deviation_mm, putt_analytics,
-- putting_analysis, and the existing analysis_mode depth-routing contract).
--
-- CRITICAL NAMING RULE
-- ---------------------
-- public.swing_videos.analysis_mode and public.swing_analysis.analysis_mode
-- already mean "AI depth / subscription-driven model routing" (basic /
-- advanced / ultra). Neither is renamed, repurposed, or reconstrained here.
--
-- A new, separate column — public.swing_analysis.analysis_family — is added
-- with exactly two allowed values, full_swing and putting, meaning "which
-- mechanical analysis pipeline the validated selected club routes to." The
-- two concepts are orthogonal and independently varying.
--
-- SOURCE OF TRUTH
-- ----------------
-- Every existing relation, column, type, constraint, and policy referenced
-- below was read directly from the live PostgreSQL catalogs of project
-- atlmnqispyzhsahahpjy (Postgres 17.6.1) via read-only queries immediately
-- before this file was written. No column, constraint, policy, or grant on
-- an existing table was invented or assumed. No application row, auth
-- identity, Stripe ID, storage object, credential, or secret is included
-- anywhere in this file.
--
-- SCOPE BOUNDARY
-- ---------------
-- This migration does NOT insert equipment-model rows (EQ1-S2), does NOT
-- change any existing user_equipment/swing_analysis RLS policy, does NOT add
-- swing_videos.user_equipment_id, does NOT touch chip/pitch/bunker
-- specialization, and is NOT applied to any Supabase project by this task.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail loud if the target does not match the reconciled live
-- schema this migration was authored against, or if any planned object
-- already exists.
-- ============================================================================
do $$
declare
  v_required_columns text[][] := array[
    array['user_equipment','id','uuid'],
    array['user_equipment','user_id','uuid'],
    array['user_equipment','club_type','USER-DEFINED'],
    array['user_equipment','brand','text'],
    array['user_equipment','model','text'],
    array['user_equipment','shaft_flex','text'],
    array['user_equipment','shaft_weight','integer'],
    array['user_equipment','loft_deg','numeric'],
    array['user_equipment','custom_club','boolean'],
    array['user_equipment','custom_brand','text'],
    array['user_equipment','custom_model','text'],
    array['user_equipment','custom_notes','text'],
    array['user_equipment','is_primary','boolean'],
    array['user_equipment','created_at','timestamp with time zone'],
    array['user_equipment','updated_at','timestamp with time zone'],
    array['swing_analysis','id','uuid'],
    array['swing_analysis','swing_video_id','uuid'],
    array['swing_analysis','user_id','uuid'],
    array['swing_analysis','status','text'],
    array['swing_analysis','analysis_mode','text'],
    array['swing_analysis','model_used','text'],
    array['swing_analysis','putt_tempo_ratio','numeric'],
    array['swing_analysis','face_angle_at_impact_deg','numeric'],
    array['swing_analysis','path_deviation_mm','numeric'],
    array['swing_analysis','putt_analytics','jsonb'],
    array['swing_analysis','putting_analysis','jsonb'],
    array['swing_analysis','ai_equipment_recommendations','jsonb'],
    array['swing_analysis','club_id','uuid'],
    array['swing_analysis','telemetry_id','uuid'],
    array['swing_videos','analysis_mode','text']
  ];
  v_row text[];
begin
  -- Required base tables and enum type exist.
  if to_regclass('public.user_equipment') is null then
    raise exception 'EQ1S1R-PRE-1: public.user_equipment does not exist.';
  end if;
  if to_regclass('public.swing_analysis') is null then
    raise exception 'EQ1S1R-PRE-2: public.swing_analysis does not exist.';
  end if;
  if to_regclass('public.swing_videos') is null then
    raise exception 'EQ1S1R-PRE-3: public.swing_videos does not exist.';
  end if;
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) then
    raise exception 'EQ1S1R-PRE-4: public.club_type_enum does not exist.';
  end if;

  -- Every required existing column is present with a compatible type.
  foreach v_row slice 1 in array v_required_columns
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = v_row[1]
        and column_name = v_row[2]
        and data_type = v_row[3]
    ) then
      raise exception 'EQ1S1R-PRE-5: expected public.%.% to exist with data_type %, but it does not match the reconciled live schema.', v_row[1], v_row[2], v_row[3];
    end if;
  end loop;

  -- club_type_enum still has exactly the six expected values, in order.
  if (
    select array_agg(e.enumlabel::text order by e.enumsortorder)
    from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) is distinct from array['Driver','Wood','Hybrid','Iron','Wedge','Putter'] then
    raise exception 'EQ1S1R-PRE-6: public.club_type_enum values have changed from the expected six values.';
  end if;

  -- swing_analysis.club_id still references user_equipment.id.
  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis' and con.contype = 'f'
      and pg_get_constraintdef(con.oid) ilike '%FOREIGN KEY (club_id) REFERENCES user_equipment(id)%'
  ) then
    raise exception 'EQ1S1R-PRE-7: public.swing_analysis.club_id no longer references public.user_equipment.id.';
  end if;

  -- swing_videos.analysis_mode still allows exactly basic/advanced/ultra.
  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_videos' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) = 'CHECK ((analysis_mode = ANY (ARRAY[''basic''::text, ''advanced''::text, ''ultra''::text])))'
  ) then
    raise exception 'EQ1S1R-PRE-8: public.swing_videos.analysis_mode constraint no longer matches basic/advanced/ultra exactly.';
  end if;

  -- The shared updated-at trigger function exists and has a compatible body
  -- before this migration relies on reusing it (it is never modified here).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_updated_at'
      and pg_get_functiondef(p.oid) ilike '%new.updated_at%now()%'
  ) then
    raise exception 'EQ1S1R-PRE-9: public.handle_updated_at() is missing or has an incompatible definition; refusing to reuse it.';
  end if;

  -- None of the planned new relations already exist.
  if to_regclass('public.equipment_manufacturers') is not null then
    raise exception 'EQ1S1R-PRE-10: public.equipment_manufacturers already exists.';
  end if;
  if to_regclass('public.equipment_models') is not null then
    raise exception 'EQ1S1R-PRE-11: public.equipment_models already exists.';
  end if;

  -- None of the planned new columns already exist.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'analysis_family') then
    raise exception 'EQ1S1R-PRE-12: public.swing_analysis.analysis_family already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'equipment_snapshot') then
    raise exception 'EQ1S1R-PRE-13: public.swing_analysis.equipment_snapshot already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_equipment' and column_name = 'manufacturer_id') then
    raise exception 'EQ1S1R-PRE-14: public.user_equipment.manufacturer_id already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_equipment' and column_name = 'equipment_model_id') then
    raise exception 'EQ1S1R-PRE-15: public.user_equipment.equipment_model_id already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'swing_videos' and column_name = 'user_equipment_id') then
    raise exception 'EQ1S1R-PRE-16: public.swing_videos.user_equipment_id must never be added and already exists.';
  end if;

  -- None of the planned functions, triggers, indexes, constraints, or
  -- policies already exist under a conflicting name.
  if to_regprocedure('public.validate_user_equipment_catalog_reference()') is not null
     or to_regprocedure('public.apply_swing_analysis_equipment_snapshot()') is not null
     or to_regprocedure('public.guard_swing_analysis_equipment_immutability()') is not null then
    raise exception 'EQ1S1R-PRE-17: one or more planned trigger function names already exist.';
  end if;

  if exists (
    select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and tg.tgname in (
      'user_equipment_validate_catalog_reference',
      'swing_analysis_apply_equipment_snapshot',
      'swing_analysis_guard_equipment_immutability',
      'equipment_manufacturers_set_updated_at',
      'equipment_models_set_updated_at'
    )
  ) then
    raise exception 'EQ1S1R-PRE-18: one or more planned trigger names already exist.';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in (
      'equipment_manufacturers_active_idx','equipment_models_manufacturer_id_idx',
      'equipment_models_club_type_idx','equipment_models_active_idx',
      'equipment_models_manufacturer_type_name_year_uidx',
      'user_equipment_manufacturer_id_idx','user_equipment_equipment_model_id_idx',
      'swing_analysis_club_id_idx'
    )
  ) then
    raise exception 'EQ1S1R-PRE-19: one or more planned index names already exist.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and con.conname in (
      'equipment_manufacturers_canonical_name_nonblank','equipment_manufacturers_normalized_name_nonblank',
      'equipment_manufacturers_slug_format','equipment_manufacturers_slug_unique','equipment_manufacturers_normalized_name_unique',
      'equipment_models_manufacturer_id_fkey','equipment_models_canonical_name_nonblank','equipment_models_normalized_name_nonblank',
      'equipment_models_slug_format','equipment_models_specifications_is_object','equipment_models_model_year_range',
      'user_equipment_manufacturer_id_fkey','user_equipment_equipment_model_id_fkey',
      'swing_analysis_analysis_family_check','swing_analysis_equipment_context_consistency'
    )
  ) then
    raise exception 'EQ1S1R-PRE-20: one or more planned constraint names already exist.';
  end if;

  if exists (
    select 1 from pg_policies where schemaname = 'public' and policyname in (
      'equipment_manufacturers_select_active','equipment_models_select_active'
    )
  ) then
    raise exception 'EQ1S1R-PRE-21: one or more planned policy names already exist.';
  end if;

  -- The migration role has sufficient DDL authority on the public schema.
  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    raise exception 'EQ1S1R-PRE-22: current role % lacks CREATE privilege on schema public.', current_user;
  end if;

  -- The database is a compatible PostgreSQL version.
  if current_setting('server_version_num')::int < 140000 then
    raise exception 'EQ1S1R-PRE-23: PostgreSQL server_version_num % is below the minimum supported 140000.', current_setting('server_version_num');
  end if;

  raise notice 'EQ1S1R-PRE-OK: reconciled live schema matched, no conflicting objects found — proceeding.';
end $$;

-- ============================================================================
-- 6. Manufacturer catalog table
-- ============================================================================

create table public.equipment_manufacturers (
  id uuid not null default gen_random_uuid(),
  canonical_name text not null,
  slug text not null,
  normalized_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_manufacturers_pkey primary key (id),
  constraint equipment_manufacturers_canonical_name_nonblank check (btrim(canonical_name) <> ''),
  constraint equipment_manufacturers_normalized_name_nonblank check (btrim(normalized_name) <> ''),
  constraint equipment_manufacturers_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint equipment_manufacturers_slug_unique unique (slug),
  constraint equipment_manufacturers_normalized_name_unique unique (normalized_name)
);

create index equipment_manufacturers_active_idx on public.equipment_manufacturers (is_active) where is_active;

create trigger equipment_manufacturers_set_updated_at
  before update on public.equipment_manufacturers
  for each row execute function public.handle_updated_at();

-- ============================================================================
-- 7. Equipment-model catalog table (no model rows are inserted in this slice)
-- ============================================================================

create table public.equipment_models (
  id uuid not null default gen_random_uuid(),
  manufacturer_id uuid not null,
  club_type public.club_type_enum not null,
  canonical_name text not null,
  slug text not null,
  normalized_name text not null,
  model_year smallint,
  specifications jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_models_pkey primary key (id),
  constraint equipment_models_manufacturer_id_fkey foreign key (manufacturer_id)
    references public.equipment_manufacturers (id) on delete restrict,
  constraint equipment_models_canonical_name_nonblank check (btrim(canonical_name) <> ''),
  constraint equipment_models_normalized_name_nonblank check (btrim(normalized_name) <> ''),
  constraint equipment_models_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint equipment_models_specifications_is_object check (jsonb_typeof(specifications) = 'object'),
  constraint equipment_models_model_year_range check (model_year is null or model_year between 1900 and 2100)
);

create unique index equipment_models_manufacturer_type_name_year_uidx
  on public.equipment_models (manufacturer_id, club_type, normalized_name, coalesce(model_year, 0));

create index equipment_models_manufacturer_id_idx on public.equipment_models (manufacturer_id);
create index equipment_models_club_type_idx on public.equipment_models (club_type);
create index equipment_models_active_idx on public.equipment_models (is_active) where is_active;

create trigger equipment_models_set_updated_at
  before update on public.equipment_models
  for each row execute function public.handle_updated_at();

-- ============================================================================
-- 8. Seed the initial manufacturer identity vocabulary (five rows, no model
--    data, no advertising or sponsorship fields)
-- ============================================================================

insert into public.equipment_manufacturers (canonical_name, slug, normalized_name)
values
  ('TaylorMade', 'taylormade', 'taylormade'),
  ('Callaway', 'callaway', 'callaway'),
  ('Titleist', 'titleist', 'titleist'),
  ('PING', 'ping', 'ping'),
  ('Mizuno', 'mizuno', 'mizuno');

-- ============================================================================
-- 9. Extend user_equipment with nullable catalog references — legacy and
--    custom text fields (brand, model, custom_brand, custom_model,
--    custom_notes, custom_club) are untouched and remain authoritative
--    wherever no catalog reference is selected.
-- ============================================================================

alter table public.user_equipment
  add column manufacturer_id uuid,
  add column equipment_model_id uuid;

alter table public.user_equipment
  add constraint user_equipment_manufacturer_id_fkey foreign key (manufacturer_id)
    references public.equipment_manufacturers (id) on delete set null,
  add constraint user_equipment_equipment_model_id_fkey foreign key (equipment_model_id)
    references public.equipment_models (id) on delete set null;

create index user_equipment_manufacturer_id_idx on public.user_equipment (manufacturer_id);
create index user_equipment_equipment_model_id_idx on public.user_equipment (equipment_model_id);

-- ============================================================================
-- 10. Manufacturer/model consistency trigger on user_equipment.
--     SECURITY INVOKER: catalog visibility (active-only) is enforced by the
--     caller's own RLS for `authenticated`; service_role sees all catalog
--     rows because it bypasses RLS, which is the intended behavior for
--     trusted server-side writes.
-- ============================================================================

create function public.validate_user_equipment_catalog_reference()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_model public.equipment_models%rowtype;
begin
  if new.equipment_model_id is not null then
    select * into v_model
      from public.equipment_models
      where equipment_models.id = new.equipment_model_id
        and equipment_models.is_active;

    if not found then
      raise exception 'EQ1S1R: equipment_model_id % does not reference an active equipment model.', new.equipment_model_id;
    end if;

    if v_model.club_type is distinct from new.club_type then
      raise exception 'EQ1S1R: the selected equipment model''s club type does not match this club''s club_type.';
    end if;

    if new.manufacturer_id is null then
      new.manufacturer_id := v_model.manufacturer_id;
    elsif new.manufacturer_id is distinct from v_model.manufacturer_id then
      raise exception 'EQ1S1R: manufacturer_id conflicts with the manufacturer of the selected equipment_model_id.';
    end if;

  elsif new.manufacturer_id is not null then
    if not exists (
      select 1 from public.equipment_manufacturers
      where equipment_manufacturers.id = new.manufacturer_id
        and equipment_manufacturers.is_active
    ) then
      raise exception 'EQ1S1R: manufacturer_id % does not reference an active equipment manufacturer.', new.manufacturer_id;
    end if;
  end if;

  return new;
end;
$function$;

create trigger user_equipment_validate_catalog_reference
  before insert or update of manufacturer_id, equipment_model_id, club_type
  on public.user_equipment
  for each row execute function public.validate_user_equipment_catalog_reference();

revoke all on function public.validate_user_equipment_catalog_reference() from public;
revoke all on function public.validate_user_equipment_catalog_reference() from anon;
revoke all on function public.validate_user_equipment_catalog_reference() from authenticated;

-- ============================================================================
-- 11. Conservative manufacturer-only backfill. Exact normalized matches on
--     effective brand text only; no fuzzy matching; no model inference; no
--     rewrite of the original brand/custom_brand text; equipment_model_id is
--     never backfilled.
-- ============================================================================

do $$
declare
  v_manufacturer record;
  v_updated int;
begin
  for v_manufacturer in
    select id, canonical_name, slug, normalized_name from public.equipment_manufacturers order by slug
  loop
    update public.user_equipment
    set manufacturer_id = v_manufacturer.id
    where manufacturer_id is null
      and equipment_model_id is null
      and regexp_replace(
            lower(coalesce(nullif(btrim(brand), ''), nullif(btrim(custom_brand), ''))),
            '[^a-z0-9]', '', 'g'
          ) = v_manufacturer.normalized_name;

    get diagnostics v_updated = row_count;
    raise notice 'EQ1S1R-BACKFILL: % row(s) mapped to manufacturer % (%).', v_updated, v_manufacturer.canonical_name, v_manufacturer.slug;
  end loop;
end $$;

-- ============================================================================
-- 12. Extend swing_analysis with nullable analysis_family and
--     equipment_snapshot. Historical rows remain null; the existing 70
--     analyses are never rewritten.
-- ============================================================================

alter table public.swing_analysis
  add column analysis_family text,
  add column equipment_snapshot jsonb;

alter table public.swing_analysis
  add constraint swing_analysis_analysis_family_check
    check (analysis_family is null or analysis_family in ('full_swing', 'putting'));

create index swing_analysis_club_id_idx on public.swing_analysis (club_id);

-- ============================================================================
-- 13-14. Equipment-snapshot contract (before-insert). The database owns
--        analysis_family and equipment_snapshot; any client-supplied values
--        for either are ignored and overwritten unconditionally.
-- ============================================================================

create function public.apply_swing_analysis_equipment_snapshot()
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

  new.equipment_snapshot := jsonb_build_object(
    'schema_version', 1,
    'captured_at', to_jsonb(now()),
    'equipment_id', to_jsonb(v_equipment.id),
    'club_type', to_jsonb(v_equipment.club_type::text),
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

create trigger swing_analysis_apply_equipment_snapshot
  before insert on public.swing_analysis
  for each row execute function public.apply_swing_analysis_equipment_snapshot();

revoke all on function public.apply_swing_analysis_equipment_snapshot() from public;
revoke all on function public.apply_swing_analysis_equipment_snapshot() from anon;
revoke all on function public.apply_swing_analysis_equipment_snapshot() from authenticated;

-- ============================================================================
-- 15. Snapshot immutability (before-update). Only club_id, analysis_family,
--     and equipment_snapshot are frozen after insert; the asynchronous
--     analysis-completion flow (status, results, metrics, putting/full-swing
--     fields, telemetry references) is entirely unaffected.
-- ============================================================================

create function public.guard_swing_analysis_equipment_immutability()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.club_id is distinct from old.club_id then
    raise exception 'EQ1S1R: swing_analysis.club_id cannot be changed after insert.';
  end if;
  if new.analysis_family is distinct from old.analysis_family then
    raise exception 'EQ1S1R: swing_analysis.analysis_family cannot be changed after insert.';
  end if;
  if new.equipment_snapshot is distinct from old.equipment_snapshot then
    raise exception 'EQ1S1R: swing_analysis.equipment_snapshot cannot be changed after insert.';
  end if;
  return new;
end;
$function$;

create trigger swing_analysis_guard_equipment_immutability
  before update of club_id, analysis_family, equipment_snapshot
  on public.swing_analysis
  for each row execute function public.guard_swing_analysis_equipment_immutability();

revoke all on function public.guard_swing_analysis_equipment_immutability() from public;
revoke all on function public.guard_swing_analysis_equipment_immutability() from anon;
revoke all on function public.guard_swing_analysis_equipment_immutability() from authenticated;

-- ============================================================================
-- 16. Equipment-context consistency constraint
-- ============================================================================

alter table public.swing_analysis
  add constraint swing_analysis_equipment_context_consistency check (
    (club_id is null and analysis_family is null and equipment_snapshot is null)
    or
    (club_id is not null and analysis_family is not null and jsonb_typeof(equipment_snapshot) = 'object')
  );

-- ============================================================================
-- 17. Catalog RLS and grants — browser-facing SELECT-only for authenticated,
--     no anonymous access, no browser write path. Existing user_equipment
--     and swing_analysis policies are left completely unchanged; broader
--     policy modernization (auth.uid() caching, explicit TO clauses on the
--     older policies) is deferred to a separately authorized security slice.
-- ============================================================================

alter table public.equipment_manufacturers enable row level security;
alter table public.equipment_models enable row level security;

-- Postgres/Supabase default privileges automatically grant new public
-- tables full CRUD to authenticated (and anon) at CREATE TABLE time; each
-- must be explicitly revoked before the intended SELECT-only grant below,
-- or the broad default grant silently survives alongside it.
revoke all on public.equipment_manufacturers from public;
revoke all on public.equipment_manufacturers from anon;
revoke all on public.equipment_manufacturers from authenticated;
revoke all on public.equipment_models from public;
revoke all on public.equipment_models from anon;
revoke all on public.equipment_models from authenticated;

grant select on public.equipment_manufacturers to authenticated;
grant select on public.equipment_models to authenticated;

grant select, insert, update, delete on public.equipment_manufacturers to service_role;
grant select, insert, update, delete on public.equipment_models to service_role;

create policy equipment_manufacturers_select_active
  on public.equipment_manufacturers
  for select
  to authenticated
  using (is_active);

create policy equipment_models_select_active
  on public.equipment_models
  for select
  to authenticated
  using (is_active);

-- ============================================================================
-- POSTFLIGHT — fail loud if the resulting catalog does not exactly match the
-- intended foundation.
-- ============================================================================
do $$
declare
  v_count int;
  v_policy_count int;
  v_manufacturer_count int;
  v_model_count int;
  v_fn record;
  v_backfill_summary jsonb;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_manufacturers' and c.relkind = 'r') then
    raise exception 'EQ1S1R-POST-1: public.equipment_manufacturers was not created.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_models' and c.relkind = 'r') then
    raise exception 'EQ1S1R-POST-2: public.equipment_models was not created.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'equipment_manufacturers'
      and column_name in ('id','canonical_name','slug','normalized_name','is_active','created_at','updated_at');
  if v_count <> 7 then
    raise exception 'EQ1S1R-POST-3: public.equipment_manufacturers is missing one or more required columns (found %).', v_count;
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'equipment_models'
      and column_name in ('id','manufacturer_id','club_type','canonical_name','slug','normalized_name','model_year','specifications','is_active','created_at','updated_at');
  if v_count <> 11 then
    raise exception 'EQ1S1R-POST-4: public.equipment_models is missing one or more required columns (found %).', v_count;
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and con.contype = 'f'
      and pg_get_constraintdef(con.oid) ilike '%FOREIGN KEY (manufacturer_id) REFERENCES equipment_manufacturers(id) ON DELETE RESTRICT%'
  ) then
    raise exception 'EQ1S1R-POST-5: equipment_models.manufacturer_id FK is missing or has the wrong delete action.';
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment' and con.contype = 'f'
      and pg_get_constraintdef(con.oid) ilike '%FOREIGN KEY (manufacturer_id) REFERENCES equipment_manufacturers(id) ON DELETE SET NULL%'
  ) then
    raise exception 'EQ1S1R-POST-6: user_equipment.manufacturer_id FK is missing or has the wrong delete action.';
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'user_equipment' and con.contype = 'f'
      and pg_get_constraintdef(con.oid) ilike '%FOREIGN KEY (equipment_model_id) REFERENCES equipment_models(id) ON DELETE SET NULL%'
  ) then
    raise exception 'EQ1S1R-POST-7: user_equipment.equipment_model_id FK is missing or has the wrong delete action.';
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_manufacturers' and c.relrowsecurity) then
    raise exception 'EQ1S1R-POST-8: RLS is not enabled on public.equipment_manufacturers.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_models' and c.relrowsecurity) then
    raise exception 'EQ1S1R-POST-9: RLS is not enabled on public.equipment_models.';
  end if;

  select count(*) into v_policy_count from pg_policies where schemaname = 'public' and tablename in ('equipment_manufacturers','equipment_models');
  if v_policy_count <> 2 then
    raise exception 'EQ1S1R-POST-10: expected exactly 2 policies across the new catalog tables, found %.', v_policy_count;
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipment_manufacturers' and policyname = 'equipment_manufacturers_select_active' and cmd = 'SELECT' and roles = '{authenticated}') then
    raise exception 'EQ1S1R-POST-11: equipment_manufacturers_select_active policy is missing or misconfigured.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'equipment_models' and policyname = 'equipment_models_select_active' and cmd = 'SELECT' and roles = '{authenticated}') then
    raise exception 'EQ1S1R-POST-12: equipment_models_select_active policy is missing or misconfigured.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('equipment_manufacturers','equipment_models') and grantee = 'anon'
  ) then
    raise exception 'EQ1S1R-POST-13: anon has an unexpected grant on the new catalog tables.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('equipment_manufacturers','equipment_models')
      and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'EQ1S1R-POST-14: authenticated has an unexpected write grant on the new catalog tables.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_manufacturers' and grantee = 'authenticated' and privilege_type = 'SELECT')
     or not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_models' and grantee = 'authenticated' and privilege_type = 'SELECT') then
    raise exception 'EQ1S1R-POST-15: authenticated is missing the required SELECT grant on one or both catalog tables.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_manufacturers' and grantee = 'service_role')
     or not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_models' and grantee = 'service_role') then
    raise exception 'EQ1S1R-POST-16: service_role is missing access on one or both catalog tables.';
  end if;

  for v_fn in
    select p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'validate_user_equipment_catalog_reference',
      'apply_swing_analysis_equipment_snapshot',
      'guard_swing_analysis_equipment_immutability'
    )
  loop
    if v_fn.def ilike '%security definer%' then
      raise exception 'EQ1S1R-POST-17: function % is unexpectedly SECURITY DEFINER.', v_fn.proname;
    end if;
    if v_fn.def not ilike '%set search_path to %''%' then
      raise exception 'EQ1S1R-POST-18: function % does not set an empty search_path.', v_fn.proname;
    end if;
  end loop;

  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'validate_user_equipment_catalog_reference',
      'apply_swing_analysis_equipment_snapshot',
      'guard_swing_analysis_equipment_immutability'
    );
  if v_count <> 3 then
    raise exception 'EQ1S1R-POST-19: expected exactly 3 new trigger functions, found %.', v_count;
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name in (
      'validate_user_equipment_catalog_reference',
      'apply_swing_analysis_equipment_snapshot',
      'guard_swing_analysis_equipment_immutability'
    ) and grantee in ('PUBLIC','anon','authenticated')
  ) then
    raise exception 'EQ1S1R-POST-20: one or more trigger functions remain executable by PUBLIC, anon, or authenticated.';
  end if;

  select count(*) into v_count
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not tg.tgisinternal and n.nspname = 'public' and tg.tgname in (
      'user_equipment_validate_catalog_reference',
      'swing_analysis_apply_equipment_snapshot',
      'swing_analysis_guard_equipment_immutability',
      'equipment_manufacturers_set_updated_at',
      'equipment_models_set_updated_at'
    );
  if v_count <> 5 then
    raise exception 'EQ1S1R-POST-21: expected exactly 5 new triggers, found %.', v_count;
  end if;

  select count(*) into v_count
    from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not tg.tgisinternal and n.nspname = 'public' and c.relname in ('equipment_manufacturers','equipment_models');
  if v_count <> 2 then
    raise exception 'EQ1S1R-POST-22: expected exactly 2 triggers total on the new catalog tables, found %.', v_count;
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis' and con.conname = 'swing_analysis_analysis_family_check'
  ) then
    raise exception 'EQ1S1R-POST-23: swing_analysis_analysis_family_check constraint is missing.';
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_analysis' and con.conname = 'swing_analysis_equipment_context_consistency'
  ) then
    raise exception 'EQ1S1R-POST-24: swing_analysis_equipment_context_consistency constraint is missing.';
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'swing_videos' and con.conname = 'swing_videos_analysis_mode_check'
      and pg_get_constraintdef(con.oid) = 'CHECK ((analysis_mode = ANY (ARRAY[''basic''::text, ''advanced''::text, ''ultra''::text])))'
  ) then
    raise exception 'EQ1S1R-POST-25: swing_videos.analysis_mode constraint changed unexpectedly during migration.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'analysis_mode' and data_type = 'text';
  if v_count <> 1 then
    raise exception 'EQ1S1R-POST-26: swing_analysis.analysis_mode column changed unexpectedly during migration.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis'
      and column_name in ('putt_tempo_ratio','face_angle_at_impact_deg','path_deviation_mm','putt_analytics','putting_analysis');
  if v_count <> 5 then
    raise exception 'EQ1S1R-POST-27: one or more existing putting columns on swing_analysis changed unexpectedly.';
  end if;

  if exists (
    select 1 from public.swing_analysis
    where club_id is null and (analysis_family is not null or equipment_snapshot is not null)
  ) then
    raise exception 'EQ1S1R-POST-28: a historical no-club analysis row was unexpectedly given analysis_family or equipment_snapshot.';
  end if;

  select count(*) into v_model_count from public.equipment_models;
  if v_model_count <> 0 then
    raise exception 'EQ1S1R-POST-29: expected zero equipment_models rows in this slice, found %.', v_model_count;
  end if;

  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ1S1R-POST-30: expected zero user_equipment rows with equipment_model_id populated by this migration, found %.', v_count;
  end if;

  select count(*) into v_manufacturer_count from public.equipment_manufacturers;
  if v_manufacturer_count <> 5 then
    raise exception 'EQ1S1R-POST-31: expected exactly 5 seeded manufacturers, found %.', v_manufacturer_count;
  end if;

  select jsonb_object_agg(m.slug, coalesce(c.cnt, 0)) into v_backfill_summary
    from public.equipment_manufacturers m
    left join (
      select manufacturer_id, count(*) as cnt from public.user_equipment where manufacturer_id is not null group by manufacturer_id
    ) c on c.manufacturer_id = m.id;

  raise notice 'EQ1S1R-POST-OK: foundation verified (5 manufacturers, 0 models, 3 trigger functions, 5 triggers, 2 catalog policies). Backfill summary by manufacturer: %', v_backfill_summary;
end $$;

commit;
