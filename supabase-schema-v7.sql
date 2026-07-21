-- SwingProAI — Schema v7: Coach Marketplace CM2A (Secure Data Contract)
-- Run in: Supabase Dashboard > SQL Editor > New query > Run
--
-- ============================================================================
-- THIS MIGRATION IS UNAPPLIED BY CM2A. IT IS SOURCE ONLY.
-- CM2A does not run this file against any Supabase project (staging or
-- production), and merging or committing this file does NOT authorize
-- applying it. Applying it is a separate, later, explicitly-approved step
-- that requires a live-schema reconciliation pass first (see
-- docs/COACH_MARKETPLACE_ROLLOUT.md, "CM2A live-schema reconciliation").
-- CM2A creates no page, route, component, or otherwise active user-facing
-- feature — it is a database contract only. CM2A does not enable, set, or
-- depend on COACH_MARKETPLACE_ENABLED being true; the flag remains false by
-- default regardless of whether this file is ever applied. This file
-- contains no Stripe code, no booking logic, no review logic, no payment
-- logic, and no Supabase Storage/upload logic of any kind.
-- ============================================================================
--
-- Unlike supabase-schema-v6.sql, this file does NOT use IF NOT EXISTS /
-- CREATE OR REPLACE / skip-on-conflict idempotency. v6 only ever created
-- brand-new, CM1-owned tables with no prior history. v7 instead modifies
-- and layers new objects onto public.coach_profiles, a pre-existing table
-- whose live RLS/policy/grant state cannot be verified from this
-- repository. Every check below therefore FAILS LOUDLY (raises an
-- exception and aborts the transaction) on any unexpected pre-existing
-- state, rather than silently skipping or silently layering on top of it.
-- Nothing is ever dropped or replaced automatically; any conflict found
-- requires manual reconciliation before this file can be applied.
--
-- Security model (see docs/COACH_MARKETPLACE_ROLLOUT.md for full rationale):
--   - authenticated receives EXECUTE on two narrow SECURITY DEFINER
--     functions only. It receives NO direct SELECT/UPDATE grant, and NO
--     RLS policy is created on coach_profiles, on either the table or any
--     individual column. Both functions derive the caller's identity only
--     from auth.uid() and re-verify public.users.role = 'coach' themselves
--     — they do not depend on RLS to be safe.
--   - anon receives nothing at all: no table/column grant, no EXECUTE on
--     either function, no SELECT on the directory view.
--   - The public coach-directory read path is server-only: the directory
--     view is revoked from PUBLIC, anon, and authenticated, and granted
--     only to service_role. No browser-facing Supabase REST call can ever
--     reach it. The server-only COACH_MARKETPLACE_ENABLED flag
--     (lib/feature-flags.ts, enforced via lib/coach-marketplace-access.ts)
--     must be checked by any future caller before constructing a
--     service-role client or issuing this query at all — that check lives
--     in application code, since Postgres cannot see a Vercel env var.
--
-- Created:
--   public.fn_get_own_coach_marketplace_profile()      — narrow, own-row-only read
--   public.fn_update_coach_marketplace_profile(...)     — narrow, own-row-only write
--   public.coach_directory_listing (view)                — private, service_role-only projection
--
-- Deferred to later, separately-reviewed slices:
--   profile-photo upload/storage (profile_photo_url remains read-only via
--   this file's functions), pages/routes/components/navigation, search,
--   pagination, booking, reviews, payments, Stripe Connect.

begin;

-- ============================================================================
-- PREFLIGHT 1 of 5 — required columns exist with compatible types
-- ============================================================================
do $$
declare
  r record;
  v_missing text[] := array[]::text[];
begin
  for r in
    select * from (values
      ('users',           'id',                            'uuid',                      null::text),
      ('users',           'role',                           'text',                      null::text),
      ('coach_profiles',  'id',                             'uuid',                      null::text),
      ('coach_profiles',  'user_id',                        'uuid',                      null::text),
      ('coach_profiles',  'public_slug',                    'text',                      null::text),
      ('coach_profiles',  'marketplace_headline',           'text',                      null::text),
      ('coach_profiles',  'profile_photo_url',               'text',                      null::text),
      ('coach_profiles',  'bio',                            'text',                      null::text),
      ('coach_profiles',  'years_coaching',                 'integer',                   null::text),
      ('coach_profiles',  'lesson_delivery_modes',           'ARRAY',                     '_text'),
      ('coach_profiles',  'public_city',                    'text',                      null::text),
      ('coach_profiles',  'public_region',                  'text',                      null::text),
      ('coach_profiles',  'timezone',                       'text',                      null::text),
      ('coach_profiles',  'marketplace_visibility_status',   'text',                      null::text),
      ('coach_profiles',  'verification_status',            'text',                      null::text),
      ('coach_profiles',  'minimum_booking_notice_hours',    'integer',                   null::text),
      ('coach_profiles',  'cancellation_policy_summary',     'text',                      null::text),
      ('coach_profiles',  'updated_at',                     'timestamp with time zone',  null::text),
      ('coach_profiles',  'is_active',                      'boolean',                   null::text)
    ) as expected(table_name, column_name, expected_data_type, expected_udt_name)
  loop
    if not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = r.table_name
        and c.column_name = r.column_name
        and c.data_type = r.expected_data_type
        and (r.expected_udt_name is null or c.udt_name = r.expected_udt_name)
    ) then
      v_missing := v_missing || (r.table_name || '.' || r.column_name || ' (expected ' || r.expected_data_type || ')');
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'preflight: missing or incompatible required columns — reconcile manually before applying this migration: %',
      array_to_string(v_missing, ', ');
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT 2 of 5 — PostgreSQL 15+ required (no unsafe pre-15 fallback)
-- ============================================================================
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'preflight: PostgreSQL 15 or newer is required for CM2A (security_invoker view); current server_version_num=%',
      current_setting('server_version_num');
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT 3 of 5 — no colliding object already exists
-- ============================================================================
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_get_own_coach_marketplace_profile'
  ) then
    raise exception 'preflight: public.fn_get_own_coach_marketplace_profile already exists — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_update_coach_marketplace_profile'
  ) then
    raise exception 'preflight: public.fn_update_coach_marketplace_profile already exists (at least one overload) — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'coach_directory_listing'
  ) then
    raise exception 'preflight: an object named public.coach_directory_listing already exists — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'coach_profiles'
  ) then
    raise exception 'preflight: public.coach_profiles already has at least one RLS policy — CM2A assumes zero pre-existing policies; reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT 4 of 5 — no effective browser-facing access already exists
-- ============================================================================
-- has_table_privilege()/has_any_column_privilege() report EFFECTIVE
-- privilege (table-level grants, column-level grants, and privileges
-- inherited via a PUBLIC grant are all folded in automatically by
-- PostgreSQL for any role argument) — a plain information_schema lookup
-- alone would miss column-level and PUBLIC-derived access.
do $$
declare
  v_problems text[] := array[]::text[];
begin
  if has_table_privilege('authenticated', 'public.coach_profiles', 'SELECT') then
    v_problems := v_problems || 'authenticated has effective table-level SELECT on public.coach_profiles';
  end if;
  if has_table_privilege('authenticated', 'public.coach_profiles', 'UPDATE') then
    v_problems := v_problems || 'authenticated has effective table-level UPDATE on public.coach_profiles';
  end if;
  if has_any_column_privilege('authenticated', 'public.coach_profiles', 'SELECT') then
    v_problems := v_problems || 'authenticated has effective column-level SELECT on at least one column of public.coach_profiles';
  end if;
  if has_any_column_privilege('authenticated', 'public.coach_profiles', 'UPDATE') then
    v_problems := v_problems || 'authenticated has effective column-level UPDATE on at least one column of public.coach_profiles';
  end if;

  if has_table_privilege('anon', 'public.coach_profiles', 'SELECT') then
    v_problems := v_problems || 'anon has effective table-level SELECT on public.coach_profiles';
  end if;
  if has_table_privilege('anon', 'public.coach_profiles', 'UPDATE') then
    v_problems := v_problems || 'anon has effective table-level UPDATE on public.coach_profiles';
  end if;
  if has_any_column_privilege('anon', 'public.coach_profiles', 'SELECT') then
    v_problems := v_problems || 'anon has effective column-level SELECT on at least one column of public.coach_profiles';
  end if;
  if has_any_column_privilege('anon', 'public.coach_profiles', 'UPDATE') then
    v_problems := v_problems || 'anon has effective column-level UPDATE on at least one column of public.coach_profiles';
  end if;

  -- Explicit, separately-labeled PUBLIC-grantee check (in addition to the
  -- has_table_privilege()/has_any_column_privilege() checks above, which
  -- already transitively include PUBLIC-derived privilege for any role).
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'coach_profiles'
      and grantee = 'PUBLIC' and privilege_type in ('SELECT', 'UPDATE')
  ) then
    v_problems := v_problems || 'PUBLIC has an explicit table-level SELECT or UPDATE grant on public.coach_profiles';
  end if;

  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'coach_profiles'
      and grantee = 'PUBLIC' and privilege_type in ('SELECT', 'UPDATE')
  ) then
    v_problems := v_problems || 'PUBLIC has an explicit column-level SELECT or UPDATE grant on public.coach_profiles';
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception 'preflight: browser-facing roles already have effective access to public.coach_profiles that CM2A requires to be absent — reconcile manually before applying this migration: %',
      array_to_string(v_problems, '; ');
  end if;

  if not has_table_privilege('service_role', 'public.coach_profiles', 'SELECT') then
    raise exception 'preflight: service_role lacks the underlying SELECT privilege on public.coach_profiles required to query the security_invoker directory view — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT 5 of 5 — enable RLS (idempotent; CM2A creates no policy)
-- ============================================================================
alter table public.coach_profiles enable row level security;

-- ============================================================================
-- B. FUNCTION — public.fn_get_own_coach_marketplace_profile()
-- ============================================================================
-- SECURITY DEFINER is used deliberately so authenticated never needs a
-- direct table grant on coach_profiles at all (see file header). Identity
-- is derived only from auth.uid() — there is no target-ID parameter, so
-- "own row only" is structural, not merely checked. Zero parameters.
create function public.fn_get_own_coach_marketplace_profile()
returns table (
  coach_profile_id uuid,
  public_slug text,
  marketplace_headline text,
  profile_photo_url text,
  bio text,
  years_coaching integer,
  lesson_delivery_modes text[],
  public_city text,
  public_region text,
  timezone text,
  marketplace_visibility_status text,
  verification_status text,
  minimum_booking_notice_hours integer,
  cancellation_policy_summary text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_id uuid;
  v_role      text;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'fn_get_own_coach_marketplace_profile: no authenticated caller';
  end if;

  select u.role into v_role from public.users u where u.id = v_caller_id;
  if v_role is distinct from 'coach' then
    raise exception 'fn_get_own_coach_marketplace_profile: caller is not a coach';
  end if;

  return query
    select
      cp.id,
      cp.public_slug,
      cp.marketplace_headline,
      cp.profile_photo_url,
      cp.bio,
      cp.years_coaching,
      cp.lesson_delivery_modes,
      cp.public_city,
      cp.public_region,
      cp.timezone,
      cp.marketplace_visibility_status,
      cp.verification_status,
      cp.minimum_booking_notice_hours,
      cp.cancellation_policy_summary,
      cp.updated_at
    from public.coach_profiles cp
    where cp.user_id = v_caller_id;
end;
$fn$;

comment on function public.fn_get_own_coach_marketplace_profile() is
  'SECURITY DEFINER, own-row-only read of the calling coach''s marketplace profile fields. Zero parameters — identity comes only from auth.uid(). Returns zero rows if the caller has no coach_profiles row. Never returns public.coach_profiles or a wildcard select — the RETURNS TABLE list is the entire, closed contract.';

revoke execute on function public.fn_get_own_coach_marketplace_profile() from public;
revoke execute on function public.fn_get_own_coach_marketplace_profile() from anon;
grant execute on function public.fn_get_own_coach_marketplace_profile() to authenticated;

-- ============================================================================
-- C. FUNCTION — public.fn_update_coach_marketplace_profile(...)
-- ============================================================================
-- The sole authoritative write boundary for a coach's own marketplace
-- profile fields. SECURITY DEFINER for the same reason as the read
-- function above: authenticated holds no direct UPDATE grant on
-- coach_profiles, so this function cannot be bypassed via a direct
-- PostgREST call the way a SECURITY INVOKER function relying on a real
-- authenticated-role grant could be. Every validation rule below is
-- enforced here — not only in future client-side form code — because this
-- function is the single place these guarantees can be trusted to hold.
create function public.fn_update_coach_marketplace_profile(
  p_public_slug text,
  p_marketplace_headline text,
  p_bio text,
  p_years_coaching integer,
  p_lesson_delivery_modes text[],
  p_public_city text,
  p_public_region text,
  p_timezone text,
  p_marketplace_visibility_status text,
  p_minimum_booking_notice_hours integer,
  p_cancellation_policy_summary text
)
returns table (
  coach_profile_id uuid,
  public_slug text,
  marketplace_headline text,
  profile_photo_url text,
  bio text,
  years_coaching integer,
  lesson_delivery_modes text[],
  public_city text,
  public_region text,
  timezone text,
  marketplace_visibility_status text,
  verification_status text,
  minimum_booking_notice_hours integer,
  cancellation_policy_summary text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_id       uuid;
  v_role            text;
  v_current_status  text;
  v_mode            text;
  v_mode_count      integer;
  v_distinct_count  integer;
  v_constraint_name text;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'fn_update_coach_marketplace_profile: no authenticated caller';
  end if;

  select u.role into v_role from public.users u where u.id = v_caller_id;
  if v_role is distinct from 'coach' then
    raise exception 'fn_update_coach_marketplace_profile: caller is not a coach';
  end if;

  -- ── marketplace_visibility_status: required, exact allowlist ─────────
  if p_marketplace_visibility_status is null
     or p_marketplace_visibility_status not in ('hidden', 'draft', 'published') then
    raise exception 'fn_update_coach_marketplace_profile: marketplace_visibility_status must be exactly hidden, draft, or published';
  end if;

  -- ── public_slug ────────────────────────────────────────────────────
  if p_public_slug is not null then
    if p_public_slug <> btrim(p_public_slug) then
      raise exception 'fn_update_coach_marketplace_profile: public_slug must not have leading or trailing whitespace';
    end if;
    if length(p_public_slug) < 3 or length(p_public_slug) > 80 then
      raise exception 'fn_update_coach_marketplace_profile: public_slug must be between 3 and 80 characters';
    end if;
    if p_public_slug <> lower(p_public_slug) then
      raise exception 'fn_update_coach_marketplace_profile: public_slug must be lowercase';
    end if;
    if p_public_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'fn_update_coach_marketplace_profile: public_slug must match ^[a-z0-9]+(-[a-z0-9]+)*$';
    end if;
  end if;

  -- ── marketplace_headline ──────────────────────────────────────────
  if p_marketplace_headline is not null and length(p_marketplace_headline) > 120 then
    raise exception 'fn_update_coach_marketplace_profile: marketplace_headline must be 120 characters or fewer';
  end if;

  -- ── bio (plain text only in CM2 — no HTML behavior introduced) ─────
  if p_bio is not null and length(p_bio) > 2000 then
    raise exception 'fn_update_coach_marketplace_profile: bio must be 2000 characters or fewer';
  end if;

  -- ── years_coaching ─────────────────────────────────────────────────
  if p_years_coaching is not null and (p_years_coaching < 0 or p_years_coaching > 80) then
    raise exception 'fn_update_coach_marketplace_profile: years_coaching must be between 0 and 80';
  end if;

  -- ── lesson_delivery_modes ─────────────────────────────────────────
  if p_lesson_delivery_modes is not null then
    v_mode_count := array_length(p_lesson_delivery_modes, 1);
    if v_mode_count is not null then
      if v_mode_count > 3 then
        raise exception 'fn_update_coach_marketplace_profile: lesson_delivery_modes must contain no more than 3 entries';
      end if;
      select count(*) into v_distinct_count from (select distinct unnest(p_lesson_delivery_modes)) as d;
      if v_distinct_count <> v_mode_count then
        raise exception 'fn_update_coach_marketplace_profile: lesson_delivery_modes must not contain duplicate entries';
      end if;
      foreach v_mode in array p_lesson_delivery_modes loop
        if v_mode not in ('in_person', 'remote', 'hybrid') then
          raise exception 'fn_update_coach_marketplace_profile: lesson_delivery_modes may only contain in_person, remote, or hybrid';
        end if;
      end loop;
    end if;
  end if;

  -- ── public_city / public_region ───────────────────────────────────
  if p_public_city is not null and length(p_public_city) > 100 then
    raise exception 'fn_update_coach_marketplace_profile: public_city must be 100 characters or fewer';
  end if;
  if p_public_region is not null and length(p_public_region) > 100 then
    raise exception 'fn_update_coach_marketplace_profile: public_region must be 100 characters or fewer';
  end if;

  -- ── timezone ───────────────────────────────────────────────────────
  if p_timezone is not null then
    if length(p_timezone) > 100 then
      raise exception 'fn_update_coach_marketplace_profile: timezone must be 100 characters or fewer';
    end if;
    if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = p_timezone) then
      raise exception 'fn_update_coach_marketplace_profile: timezone must be a recognized IANA timezone name';
    end if;
  end if;

  -- ── minimum_booking_notice_hours ──────────────────────────────────
  if p_minimum_booking_notice_hours is not null
     and (p_minimum_booking_notice_hours < 0 or p_minimum_booking_notice_hours > 720) then
    raise exception 'fn_update_coach_marketplace_profile: minimum_booking_notice_hours must be between 0 and 720';
  end if;

  -- ── cancellation_policy_summary ───────────────────────────────────
  if p_cancellation_policy_summary is not null and length(p_cancellation_policy_summary) > 1000 then
    raise exception 'fn_update_coach_marketplace_profile: cancellation_policy_summary must be 1000 characters or fewer';
  end if;

  -- ── Publish-readiness. City/region deliberately NOT required — a
  --    remote-only coach may legitimately have no public location. ─────
  if p_marketplace_visibility_status = 'published' then
    if p_public_slug is null then
      raise exception 'fn_update_coach_marketplace_profile: publishing requires a valid public_slug';
    end if;
    if p_marketplace_headline is null or btrim(p_marketplace_headline) = '' then
      raise exception 'fn_update_coach_marketplace_profile: publishing requires a nonblank marketplace_headline';
    end if;
    if p_lesson_delivery_modes is null or array_length(p_lesson_delivery_modes, 1) is null then
      raise exception 'fn_update_coach_marketplace_profile: publishing requires at least one lesson_delivery_mode';
    end if;
  end if;

  -- ── Lock the caller's own row before checking current state, closing
  --    the race window between "check not suspended" and "write". ─────
  select cp.marketplace_visibility_status into v_current_status
    from public.coach_profiles cp
   where cp.user_id = v_caller_id
   for update;

  if not found then
    raise exception 'fn_update_coach_marketplace_profile: no owned coach_profiles row found for caller';
  end if;
  if v_current_status = 'suspended' then
    raise exception 'fn_update_coach_marketplace_profile: profile is suspended and cannot be self-edited';
  end if;

  -- ── Apply the update. verification_status, id, user_id, hourly_rate,
  --    and profile_photo_url are never assigned here. ──────────────────
  begin
    update public.coach_profiles set
      public_slug                   = p_public_slug,
      marketplace_headline          = p_marketplace_headline,
      bio                           = p_bio,
      years_coaching                = p_years_coaching,
      lesson_delivery_modes         = p_lesson_delivery_modes,
      public_city                   = p_public_city,
      public_region                 = p_public_region,
      timezone                      = p_timezone,
      marketplace_visibility_status = p_marketplace_visibility_status,
      minimum_booking_notice_hours  = p_minimum_booking_notice_hours,
      cancellation_policy_summary   = p_cancellation_policy_summary,
      updated_at                    = pg_catalog.now()
    where user_id = v_caller_id;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'idx_coach_profiles_public_slug_unique' then
        raise exception 'fn_update_coach_marketplace_profile: public_slug is already taken';
      else
        raise;
      end if;
  end;

  return query
    select
      cp.id,
      cp.public_slug,
      cp.marketplace_headline,
      cp.profile_photo_url,
      cp.bio,
      cp.years_coaching,
      cp.lesson_delivery_modes,
      cp.public_city,
      cp.public_region,
      cp.timezone,
      cp.marketplace_visibility_status,
      cp.verification_status,
      cp.minimum_booking_notice_hours,
      cp.cancellation_policy_summary,
      cp.updated_at
    from public.coach_profiles cp
    where cp.user_id = v_caller_id;
end;
$fn$;

comment on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) is
  'SECURITY DEFINER, own-row-only write of the calling coach''s marketplace profile fields. No target user/coach/profile ID parameter — identity comes only from auth.uid(). Never accepts or writes verification_status, id, user_id, hourly_rate, or profile_photo_url (profile-photo upload is deferred to its own later slice). Rejects a currently-suspended row and rejects assigning suspended. Validates every field before writing; translates only the exact idx_coach_profiles_public_slug_unique conflict to a friendly error and re-raises any unrelated unique_violation unchanged.';

revoke execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) from public;
revoke execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) from anon;
grant execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) to authenticated;

-- ============================================================================
-- D. VIEW — public.coach_directory_listing
-- ============================================================================
-- Private, server-only projection. This view is revoked from PUBLIC, anon,
-- AND authenticated — it is queried only by server-side application code
-- using the service-role client (see lib/coach-marketplace-access.ts),
-- never directly by a browser-facing role through Supabase REST. It is
-- still declared WITH (security_invoker = true) as defense-in-depth: if
-- its grants were ever mistakenly loosened later, it would still enforce
-- RLS/grants as the querying role rather than silently running with an
-- owner's elevated privileges.
--
-- Trust-and-safety decision (CM2A, conservative default — confirm with
-- whoever owns coach verification before this is ever applied): a
-- REJECTED verification is excluded from the public directory, not only a
-- SUSPENDED one. "Rejected" means an admin explicitly reviewed and denied
-- the coach's verification request — visually indistinguishable to a
-- golfer from "unverified"/"pending", but a real denial, not a neutral
-- in-progress state. Continuing to publicly list a profile whose
-- verification was explicitly denied would undermine the verification
-- badge's meaning. "unverified" and "pending" remain listable.
--
-- is_active is also required (cp.is_active = true). An inactive coach
-- profile must never be publicly listable, even if
-- marketplace_visibility_status was left at 'published' from before the
-- coach (or an admin) deactivated the account — is_active is a pre-CM1,
-- account-level switch and takes precedence over the marketplace-specific
-- visibility status. is_active is deliberately NOT projected by this view
-- (it's an input to the filter, not public information) and is not
-- coach-writable by either function in this file.
create view public.coach_directory_listing
with (security_invoker = true)
as
select
  cp.id as coach_profile_id,
  cp.public_slug,
  cp.marketplace_headline,
  cp.profile_photo_url,
  cp.bio,
  cp.years_coaching,
  cp.lesson_delivery_modes,
  cp.public_city,
  cp.public_region,
  cp.timezone,
  cp.verification_status,
  cp.minimum_booking_notice_hours,
  cp.cancellation_policy_summary
from public.coach_profiles cp
where cp.marketplace_visibility_status = 'published'
  and cp.public_slug is not null
  and cp.is_active = true
  and cp.verification_status not in ('suspended', 'rejected');

comment on view public.coach_directory_listing is
  'Private, server-only public-directory projection. Excludes hidden, draft, and suspended-visibility profiles (via the published-only predicate), excludes inactive coach profiles (is_active = true required), and excludes suspended- and rejected-verification profiles. Never exposes marketplace_visibility_status, is_active, user_id, hourly_rate, business_name, certification, specialties, created_at, updated_at, or anything from public.users or public.coach_locations. Revoked from PUBLIC, anon, and authenticated — granted only to service_role, and must only ever be queried from server-only application code after lib/coach-marketplace-access.ts confirms COACH_MARKETPLACE_ENABLED is true.';

revoke all on public.coach_directory_listing from public, anon, authenticated;
grant select on public.coach_directory_listing to service_role;

commit;
