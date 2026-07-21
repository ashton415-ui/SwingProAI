-- SwingProAI — Schema v8: Coach Marketplace CM2R (Live Production Reconciliation)
-- Run in: Supabase Dashboard > SQL Editor > New query > Run
--
-- ============================================================================
-- THIS MIGRATION IS UNAPPLIED BY CM2R. IT IS SOURCE ONLY.
-- Applying it requires a separate, explicit authorization beyond merging
-- this source file into the repository — merging does NOT authorize running
-- it against staging or production.
--
-- DO NOT RUN supabase-schema-v6.sql OR supabase-schema-v7.sql FIRST, AND DO
-- NOT RUN THEM AFTER THIS FILE EITHER. v8 supersedes the intended production
-- effect of both v6 and v7 in full: it performs every schema change v6 was
-- meant to make, every security object v7 was meant to create, AND the
-- production-specific reconciliation neither v6 nor v7 anticipated (v7's own
-- preflight explicitly assumes a zero-policy, zero-broad-grant starting
-- point on coach_profiles — a verified, read-only, out-of-band production
-- inspection found that assumption false: coach_profiles already carries two
-- named RLS policies and broad anon/authenticated/service_role table
-- privileges predating this repository's history). v6.sql and v7.sql remain
-- unmodified, historical, source-only artifacts — each already went through
-- its own independent security review against its exact committed text;
-- rewriting them in place after the fact would invalidate that review trail
-- for no technical benefit, since neither was ever applied to any database.
--
-- This file contains no Stripe code, no payment-processor integration, no
-- PostGIS extension or dependency, no page/route/component/navigation
-- change, and does not read, set, or depend on COACH_MARKETPLACE_ENABLED —
-- the feature flag remains false regardless of whether this file is ever
-- applied.
-- ============================================================================
--
-- Posture: like v7 (and unlike v6), this file uses NO "IF NOT EXISTS" /
-- "CREATE OR REPLACE" / skip-on-conflict idempotency for anything that
-- touches the pre-existing public.coach_profiles table's security surface.
-- Every fact this file depends on is re-verified against the live catalog
-- before a single structural statement runs, and every check fails LOUDLY
-- (raises an exception, aborting the whole transaction) on any deviation
-- from the verified baseline. Nothing is ever dropped, revoked, or replaced
-- blindly — the two legacy policies removed below are removed by their
-- exact quoted name, only after the preflight has independently confirmed
-- both exist with the exact expected definition.
--
-- What this migration does, atomically, in one transaction:
--   1. Adds the twelve CM1 marketplace columns to coach_profiles (identical
--      in shape to supabase-schema-v6.sql, since v6 was never applied) plus
--      one new column, marketplace_display_name.
--   2. Drops the two legacy policies ("Anyone can view active coach
--      profiles", "Coaches can manage their own profile") by exact name.
--   3. Revokes the verified broad anon/authenticated/PUBLIC privileges on
--      coach_profiles entirely, and normalizes service_role to SELECT only.
--   4. Creates the six CM1 marketplace tables, the completed-booking review
--      trigger, and the approved-review-only rating summary view — all
--      mechanically reused from supabase-schema-v6.sql's audited design,
--      unmodified in behavior.
--   5. Creates five narrow, SECURITY DEFINER, auth.uid()-only functions that
--      become the *sole* way a coach ever reads or writes their own
--      coach_profiles row (legacy or marketplace fields), replacing the two
--      legacy policies' direct-table-access model entirely.
--   6. Creates the reconciled public.coach_directory_listing view (extending
--      CM2A's audited design with marketplace_display_name and an
--      is_active/published/slug/display-name/verification eligibility
--      predicate), private and service_role-only.
--
-- Because this is a single transaction, there is no point at which another
-- session could observe the new, sensitive marketplace columns added while
-- the old broad-access legacy policies are still in effect — Postgres MVCC
-- means no other session sees any of this file's intermediate DDL states,
-- only the state before this transaction or the state after it commits.
-- Within the script's own text, the new columns are added first (step 1
-- above), then the legacy policies are dropped and the broad grants
-- revoked (steps 2-3) — this ordering has no external-visibility
-- consequence (see above), but is chosen so the file reads top-to-bottom
-- as "extend the table's shape, then correct its access model," matching
-- this migration's own section numbering. A final effective-access
-- postflight (see near the end of this file, before COMMIT) independently
-- re-verifies the resulting security posture regardless of internal
-- ordering.
--
-- Deployment: apply to a staging Supabase project first, never production
-- directly. This migration briefly holds an ACCESS EXCLUSIVE lock on
-- coach_profiles (see the explicit LOCK TABLE statement below) — apply
-- during a low-traffic window. See docs/COACH_MARKETPLACE_ROLLOUT.md,
-- "CM2R live reconciliation" for the full deployment sequencing.

begin;

-- ============================================================================
-- PREFLIGHT A — PostgreSQL 15+ required (no unsafe pre-15 fallback)
-- ============================================================================
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'preflight A: PostgreSQL 15 or newer is required; current server_version_num=%',
      current_setting('server_version_num');
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT B — required relations exist as ordinary tables
-- ============================================================================
do $$
begin
  if to_regclass('public.coach_profiles') is null then
    raise exception 'preflight B: public.coach_profiles does not exist — reconcile manually before applying this migration';
  end if;
  if (select relkind from pg_class where oid = 'public.coach_profiles'::regclass) <> 'r' then
    raise exception 'preflight B: public.coach_profiles is not an ordinary table — reconcile manually before applying this migration';
  end if;

  if to_regclass('public.users') is null then
    raise exception 'preflight B: public.users does not exist — reconcile manually before applying this migration';
  end if;
  if (select relkind from pg_class where oid = 'public.users'::regclass) <> 'r' then
    raise exception 'preflight B: public.users is not an ordinary table — reconcile manually before applying this migration';
  end if;

  if to_regclass('auth.users') is null then
    raise exception 'preflight B: auth.users does not exist — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT I (locking) — explicit lock taken immediately after confirming
-- the table exists, before any further preflight or structural statement,
-- so the remaining preflight checks and the security transition cannot race
-- with a concurrent schema change or a concurrent GRANT/REVOKE/CREATE POLICY
-- on this table from another session. ACCESS EXCLUSIVE is the strictest
-- table lock Postgres offers — it blocks ALL other access to coach_profiles
-- (including plain reads through the still-live legacy policies) for the
-- remaining duration of this transaction. Expected impact: coach_profiles
-- reads/writes from any other session block until this transaction commits
-- or rolls back; this migration's own body performs no data-row scans, so
-- the blocking window is expected to be brief (bounded by DDL/catalog
-- operations only) — still, apply only during a low-traffic window.
-- ============================================================================
lock table public.coach_profiles in access exclusive mode;

-- ============================================================================
-- PREFLIGHT C — exact ten-column baseline on public.coach_profiles
-- ============================================================================
do $$
declare
  r record;
  v_missing text[] := array[]::text[];
  v_total_columns integer;
begin
  for r in
    select * from (values
      ('id',            'uuid',                     null::text, 'NO',  'gen_random_uuid'),
      ('user_id',       'uuid',                     null::text, 'NO',  null::text),
      ('business_name', 'text',                     null::text, 'YES', null::text),
      ('bio',           'text',                     null::text, 'YES', null::text),
      ('specialties',   'ARRAY',                    '_text',    'YES', null::text),
      ('certification', 'text',                     null::text, 'YES', null::text),
      ('hourly_rate',   'numeric',                  null::text, 'YES', null::text),
      ('is_active',     'boolean',                  null::text, 'YES', 'true'),
      ('created_at',    'timestamp with time zone', null::text, 'YES', 'now'),
      ('updated_at',    'timestamp with time zone', null::text, 'YES', 'now')
    ) as expected(column_name, expected_type, expected_udt, expected_nullable, expected_default_fragment)
  loop
    if not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'coach_profiles'
        and c.column_name = r.column_name
        and c.data_type = r.expected_type
        and (r.expected_udt is null or c.udt_name = r.expected_udt)
        and c.is_nullable = r.expected_nullable
        and (r.expected_default_fragment is null or c.column_default ilike '%' || r.expected_default_fragment || '%')
    ) then
      v_missing := v_missing || (r.column_name || ' (expected ' || r.expected_type || ', nullable=' || r.expected_nullable || ')');
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'preflight C: public.coach_profiles does not match the verified ten-column baseline — mismatched or missing: %',
      array_to_string(v_missing, ', ');
  end if;

  select count(*) into v_total_columns
    from information_schema.columns
    where table_schema = 'public' and table_name = 'coach_profiles';
  if v_total_columns <> 10 then
    raise exception 'preflight C: public.coach_profiles has % columns, expected exactly 10 — reconcile manually before applying this migration',
      v_total_columns;
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT D — structural baseline: PK, unique, FK, RLS state, table owner
-- ============================================================================
do $$
declare
  v_table_owner text;
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'p'
      and con.conrelid = 'public.coach_profiles'::regclass
      and array_length(con.conkey, 1) = 1
      and att.attname = 'id'
  ) then
    raise exception 'preflight D: expected primary key on public.coach_profiles(id) not found — reconcile manually before applying this migration';
  end if;

  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'u'
      and con.conrelid = 'public.coach_profiles'::regclass
      and array_length(con.conkey, 1) = 1
      and att.attname = 'user_id'
  ) then
    raise exception 'preflight D: expected unique constraint/index on public.coach_profiles(user_id) not found — reconcile manually before applying this migration';
  end if;

  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.conrelid = 'public.coach_profiles'::regclass
      and con.confrelid = 'auth.users'::regclass
      and con.confdeltype = 'c'
      and array_length(con.conkey, 1) = 1
      and att.attname = 'user_id'
  ) then
    raise exception 'preflight D: expected foreign key coach_profiles.user_id -> auth.users(id) ON DELETE CASCADE not found — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_constraint con
    where con.contype = 'f'
      and con.conrelid = 'public.coach_profiles'::regclass
      and con.confrelid = 'public.users'::regclass
  ) then
    raise exception 'preflight D: unexpected foreign key from public.coach_profiles to public.users found — the verified baseline assumes no such reference; reconcile manually before applying this migration';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'coach_profiles'
      and c.relrowsecurity = true and c.relforcerowsecurity = false
  ) then
    raise exception 'preflight D: expected public.coach_profiles to have RLS enabled and NOT forced — reconcile manually before applying this migration';
  end if;

  -- Migration DDL authority (ALTER TABLE, DROP POLICY, GRANT/REVOKE,
  -- CREATE FUNCTION/VIEW with an implicit OWNER TO current_user) requires
  -- either table ownership or PostgreSQL superuser status — NOT merely the
  -- BYPASSRLS role attribute. BYPASSRLS only affects whether row-level
  -- security POLICIES are evaluated for that role's DML; it grants no
  -- ownership privilege and no ability to ALTER, DROP POLICY ON, or
  -- GRANT/REVOKE on an object the role does not own. A role with
  -- BYPASSRLS but lacking ownership/superuser would fail outright partway
  -- through this transaction (e.g. at DROP POLICY or ALTER TABLE ADD
  -- CONSTRAINT) — checking for it explicitly here, before any structural
  -- statement runs, turns that into a clear, early, named exception
  -- instead of an opaque mid-migration Postgres permission-denied error.
  select tableowner into v_table_owner from pg_tables where schemaname = 'public' and tablename = 'coach_profiles';
  if v_table_owner is distinct from current_user
     and not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
    raise exception 'preflight D: current_user (%) is neither the owner of public.coach_profiles (%) nor a PostgreSQL superuser — BYPASSRLS alone does not confer migration DDL authority (ownership of the altered objects or superuser is required); reconcile manually before applying this migration',
      current_user, v_table_owner;
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT E — exactly the two verified legacy policies, exact definitions
-- ============================================================================
-- Catalog expressions are normalized (whitespace and parentheses stripped,
-- lowercased) before comparison, so cosmetic pretty-printing differences
-- between Postgres versions can't cause a false failure, while any real
-- semantic drift (a different column, operator, or added condition) still
-- fails the check.
do $$
declare
  v_policy_count integer;
begin
  select count(*) into v_policy_count
    from pg_policies where schemaname = 'public' and tablename = 'coach_profiles';
  if v_policy_count <> 2 then
    raise exception 'preflight E: expected exactly 2 pre-existing policies on public.coach_profiles, found % — reconcile manually before applying this migration',
      v_policy_count;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'coach_profiles'
      and policyname = 'Anyone can view active coach profiles'
      and permissive = 'PERMISSIVE'
      and roles = array['public']::name[]
      and cmd = 'SELECT'
      and with_check is null
      and lower(regexp_replace(regexp_replace(qual, '\s+', '', 'g'), '[()]', '', 'g')) = 'is_active=true'
  ) then
    raise exception 'preflight E: policy "Anyone can view active coach profiles" not found with the exact expected definition — reconcile manually before applying this migration';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'coach_profiles'
      and policyname = 'Coaches can manage their own profile'
      and permissive = 'PERMISSIVE'
      and roles = array['public']::name[]
      and cmd = 'ALL'
      and with_check is null
      and lower(regexp_replace(regexp_replace(qual, '\s+', '', 'g'), '[()]', '', 'g')) = 'auth.uid()=user_id'
  ) then
    raise exception 'preflight E: policy "Coaches can manage their own profile" not found with the exact expected definition — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT F — effective privileges: verified broad grants must still be
-- present (about to be revoked), service_role must retain SELECT
-- ============================================================================
-- has_table_privilege() reports EFFECTIVE privilege — it folds in privilege
-- inherited via role membership or a PUBLIC grant automatically, unlike a
-- plain information_schema.role_table_grants row count.
do $$
declare
  v_missing text[] := array[]::text[];
  v_priv text;
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if not has_table_privilege(v_role, 'public.coach_profiles', v_priv) then
        v_missing := v_missing || (v_role || ' is missing expected pre-existing privilege ' || v_priv);
      end if;
    end loop;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'preflight F: verified production baseline privileges not found on public.coach_profiles — this migration expects the known broad legacy grants to still be present before it can safely revoke them: %',
      array_to_string(v_missing, '; ');
  end if;

  if not has_table_privilege('service_role', 'public.coach_profiles', 'SELECT') then
    raise exception 'preflight F: service_role lacks the expected SELECT privilege on public.coach_profiles — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT G — no colliding object already exists
-- ============================================================================
do $$
declare
  v_col text;
  v_found text[] := array[]::text[];
begin
  foreach v_col in array array[
    'public_slug', 'marketplace_headline', 'profile_photo_url', 'years_coaching',
    'lesson_delivery_modes', 'public_city', 'public_region', 'timezone',
    'marketplace_visibility_status', 'verification_status',
    'minimum_booking_notice_hours', 'cancellation_policy_summary',
    'marketplace_display_name'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'coach_profiles' and column_name = v_col
    ) then
      v_found := v_found || v_col;
    end if;
  end loop;
  if array_length(v_found, 1) > 0 then
    raise exception 'preflight G: unexpected pre-existing marketplace column(s) on public.coach_profiles: % — reconcile manually before applying this migration',
      array_to_string(v_found, ', ');
  end if;

  if to_regclass('public.coach_services') is not null then
    raise exception 'preflight G: public.coach_services already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_locations') is not null then
    raise exception 'preflight G: public.coach_locations already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_availability_rules') is not null then
    raise exception 'preflight G: public.coach_availability_rules already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_availability_exceptions') is not null then
    raise exception 'preflight G: public.coach_availability_exceptions already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_bookings') is not null then
    raise exception 'preflight G: public.coach_bookings already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_reviews') is not null then
    raise exception 'preflight G: public.coach_reviews already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_rating_summary') is not null then
    raise exception 'preflight G: public.coach_rating_summary already exists — reconcile manually before applying this migration';
  end if;
  if to_regclass('public.coach_directory_listing') is not null then
    raise exception 'preflight G: public.coach_directory_listing already exists — reconcile manually before applying this migration';
  end if;

  if exists (select 1 from pg_constraint where conname = 'coach_profiles_years_coaching_nonnegative') then
    raise exception 'preflight G: constraint coach_profiles_years_coaching_nonnegative already exists — reconcile manually before applying this migration';
  end if;
  if exists (select 1 from pg_constraint where conname = 'coach_profiles_min_notice_hours_nonnegative') then
    raise exception 'preflight G: constraint coach_profiles_min_notice_hours_nonnegative already exists — reconcile manually before applying this migration';
  end if;
  if exists (select 1 from pg_constraint where conname = 'coach_profiles_lesson_delivery_modes_valid') then
    raise exception 'preflight G: constraint coach_profiles_lesson_delivery_modes_valid already exists — reconcile manually before applying this migration';
  end if;
  if exists (select 1 from pg_constraint where conname = 'coach_profiles_marketplace_visibility_status_valid') then
    raise exception 'preflight G: constraint coach_profiles_marketplace_visibility_status_valid already exists — reconcile manually before applying this migration';
  end if;
  if exists (select 1 from pg_constraint where conname = 'coach_profiles_verification_status_valid') then
    raise exception 'preflight G: constraint coach_profiles_verification_status_valid already exists — reconcile manually before applying this migration';
  end if;
  if exists (select 1 from pg_constraint where conname = 'coach_profiles_marketplace_display_name_valid') then
    raise exception 'preflight G: constraint coach_profiles_marketplace_display_name_valid already exists — reconcile manually before applying this migration';
  end if;

  if to_regclass('public.idx_coach_profiles_public_slug_unique') is not null then
    raise exception 'preflight G: index idx_coach_profiles_public_slug_unique already exists — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_enforce_coach_review_completed_booking'
  ) then
    raise exception 'preflight G: function fn_enforce_coach_review_completed_booking already exists — reconcile manually before applying this migration';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'fn_get_own_coach_marketplace_profile',
      'fn_update_coach_marketplace_profile',
      'fn_get_or_create_own_coach_profile',
      'fn_update_own_coach_profile_legacy',
      'fn_set_own_coach_active'
    )
  ) then
    raise exception 'preflight G: at least one of the v7/v8 coach-marketplace function names already exists — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT H — public.users contract required by every new function
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'preflight H: public.users.id must be uuid — reconcile manually before applying this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'role' and data_type = 'text'
  ) then
    raise exception 'preflight H: public.users.role must be text — reconcile manually before applying this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'id' and data_type = 'uuid'
  ) then
    raise exception 'preflight H: auth.users.id must be uuid for auth.uid() comparisons against coach_profiles.user_id to type-check correctly — reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- PREFLIGHT I — service_role must have BYPASSRLS
-- ============================================================================
-- Both public.coach_rating_summary and public.coach_directory_listing are
-- declared WITH (security_invoker = true) and are queried only by
-- service_role. A security_invoker view's underlying-table access (both
-- the table-level GRANT and row-level security) is evaluated AS THE
-- INVOKING ROLE. Every base table involved (coach_profiles, coach_reviews)
-- has RLS enabled with ZERO policies — default-deny for any role whose
-- row-level security is actually evaluated. service_role must therefore
-- have BYPASSRLS, so its row-level security is never evaluated at all and
-- the explicit table-level SELECT grants above (on coach_profiles and
-- coach_reviews) are what actually govern its access, rather than being
-- silently defeated by the zero-policy default-deny posture. Without
-- BYPASSRLS, service_role would hold a real SELECT grant that RLS would
-- still block outright, making both server-only views unusable.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'preflight I: role service_role does not exist — reconcile manually before applying this migration';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls = true) then
    raise exception 'preflight I: service_role must have BYPASSRLS — both server-only security_invoker views (coach_rating_summary, coach_directory_listing) depend on it to see rows past the zero-policy RLS default-deny on their base tables; reconcile manually before applying this migration';
  end if;
end $$;

-- ============================================================================
-- SECTION 1 — EXTEND public.coach_profiles (additive columns only)
-- ============================================================================
-- Mechanically reused from supabase-schema-v6.sql Section A (never applied
-- to production), plus one new column: marketplace_display_name.

alter table public.coach_profiles
  add column if not exists public_slug                     text,
  add column if not exists marketplace_headline             text,
  add column if not exists profile_photo_url                text,
  add column if not exists years_coaching                   integer,
  add column if not exists lesson_delivery_modes             text[],
  add column if not exists public_city                      text,
  add column if not exists public_region                    text,
  add column if not exists timezone                         text,
  add column if not exists marketplace_visibility_status     text not null default 'hidden',
  add column if not exists verification_status               text not null default 'unverified',
  add column if not exists minimum_booking_notice_hours       integer,
  add column if not exists cancellation_policy_summary        text,
  add column if not exists marketplace_display_name           text;

-- Existing rows remain valid without backfill: every new column above is
-- either nullable, or NOT NULL with a constant DEFAULT that Postgres applies
-- to existing rows automatically as part of ADD COLUMN (no table rewrite,
-- no manual UPDATE, no row-by-row data migration). No column here is
-- backfilled from business_name, full_name, or any other existing field —
-- marketplace_display_name in particular starts NULL for every existing row.

comment on column public.coach_profiles.public_slug is
  'Unique public marketplace URL slug. Null until a coach opts into the marketplace. Enforced unique only when non-null (see idx_coach_profiles_public_slug_unique).';
comment on column public.coach_profiles.marketplace_headline is
  'Short public-facing tagline shown on the marketplace profile card.';
comment on column public.coach_profiles.profile_photo_url is
  'Public marketplace profile photo URL. Read-only via every CM2R function — writable only by a future dedicated storage-upload slice.';
comment on column public.coach_profiles.years_coaching is
  'Self-reported years of coaching experience. Must be non-negative when present.';
comment on column public.coach_profiles.lesson_delivery_modes is
  'Subset of {in_person, remote, hybrid} describing how this coach delivers lessons. Null or empty means not yet configured.';
comment on column public.coach_profiles.public_city is
  'Coarse public city label only. Never an exact street address — see public.coach_locations for the exact-address prohibition.';
comment on column public.coach_profiles.public_region is
  'Coarse public state/region label only.';
comment on column public.coach_profiles.timezone is
  'IANA timezone identifier (e.g. America/Denver) used to interpret this coach''s availability rules.';
comment on column public.coach_profiles.marketplace_visibility_status is
  'hidden | draft | published | suspended. A coach may self-select hidden/draft/published only, never suspended (see fn_update_coach_marketplace_profile). suspended is admin-only.';
comment on column public.coach_profiles.verification_status is
  'unverified | pending | verified | rejected | suspended. Never coach-writable by any function in this file — admin-controlled only. Independent of marketplace_visibility_status.';
comment on column public.coach_profiles.minimum_booking_notice_hours is
  'Minimum lead time, in hours, a golfer must give before a bookable slot. Must be non-negative when present. Not enforced by any booking RPC yet — informational only.';
comment on column public.coach_profiles.cancellation_policy_summary is
  'Free-text, coach-authored summary of their cancellation policy.';
comment on column public.coach_profiles.marketplace_display_name is
  'The public marketplace identity — the name shown on a directory card and public profile page. Deliberately distinct from business_name (a legacy, non-marketplace field) and never copied from business_name or public.users.full_name/display_name by this migration. Nullable while hidden/draft; required, non-null, and non-blank (after btrim) to transition to published — see coach_profiles_marketplace_display_name_valid and fn_update_coach_marketplace_profile''s publish-readiness check. Maximum 100 characters (see coach_profiles_marketplace_display_name_valid).';
comment on column public.coach_profiles.hourly_rate is
  'Legacy/read-only-by-RPC field. Marketplace transaction pricing lives exclusively on coach_services.price_amount_minor (integer minor units) — hourly_rate is never read as the source of truth for a booking''s price, and no coach-facing function in this migration writes it.';

-- Constraints on the new columns, guarded so this file can never error on an
-- already-existing constraint (mechanically reused from v6's idiom;
-- PREFLIGHT G above has already independently confirmed none of these exist
-- yet, so these guards are defense-in-depth, not a substitute for the
-- preflight).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_years_coaching_nonnegative'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_years_coaching_nonnegative
      check (years_coaching is null or years_coaching >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_min_notice_hours_nonnegative'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_min_notice_hours_nonnegative
      check (minimum_booking_notice_hours is null or minimum_booking_notice_hours >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_lesson_delivery_modes_valid'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_lesson_delivery_modes_valid
      check (
        lesson_delivery_modes is null
        or lesson_delivery_modes <@ array['in_person', 'remote', 'hybrid']::text[]
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_marketplace_visibility_status_valid'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_marketplace_visibility_status_valid
      check (marketplace_visibility_status in ('hidden', 'draft', 'published', 'suspended'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_verification_status_valid'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_verification_status_valid
      check (verification_status in ('unverified', 'pending', 'verified', 'rejected', 'suspended'));
  end if;

  -- Nullable while hidden/draft; when present, must not be blank after
  -- trimming, and capped at 100 characters — generous for a person or
  -- business display name, matching the length convention already used for
  -- public_city/public_region. Documented here and in lib/coach-marketplace-
  -- v8-reconciliation-schema.test.ts.
  if not exists (
    select 1 from pg_constraint where conname = 'coach_profiles_marketplace_display_name_valid'
  ) then
    alter table public.coach_profiles
      add constraint coach_profiles_marketplace_display_name_valid
      check (
        marketplace_display_name is null
        or (btrim(marketplace_display_name) <> '' and length(marketplace_display_name) <= 100)
      );
  end if;
end $$;

-- Uniqueness for public_slug, enforced only when non-null (mechanically
-- reused from v6, unchanged).
create unique index if not exists idx_coach_profiles_public_slug_unique
  on public.coach_profiles (public_slug)
  where public_slug is not null;

-- ============================================================================
-- SECTION 2 — ATOMIC REMOVAL OF THE TWO VERIFIED LEGACY POLICIES
-- ============================================================================
-- Removed by exact quoted name only, having been independently confirmed
-- present with the exact expected definition by PREFLIGHT E above. No
-- wildcard or pattern-based policy deletion. No replacement direct-table
-- policy is created — see SECTION 3: from this point forward, coach_profiles
-- has RLS enabled with ZERO policies, matching every other marketplace
-- table's default-deny convention. All coach and directory access from here
-- on goes exclusively through the SECURITY DEFINER functions and the
-- service-role-only directory view created later in this file.
drop policy "Anyone can view active coach profiles" on public.coach_profiles;
drop policy "Coaches can manage their own profile" on public.coach_profiles;

-- ============================================================================
-- SECTION 3 — DIRECT PRIVILEGE RECONCILIATION on public.coach_profiles
-- ============================================================================
revoke all on public.coach_profiles from public;
revoke all on public.coach_profiles from anon;
revoke all on public.coach_profiles from authenticated;
-- Normalize service_role down to SELECT only — it previously also held
-- DELETE/INSERT/REFERENCES/TRIGGER/TRUNCATE/UPDATE, none of which any
-- server-side marketplace operation in this migration needs.
revoke all on public.coach_profiles from service_role;
grant select on public.coach_profiles to service_role;

-- ============================================================================
-- SECTION 4 — CREATE THE SIX CM1 MARKETPLACE TABLES
-- ============================================================================
-- Mechanically reused, unmodified, from supabase-schema-v6.sql Sections
-- B through G (never applied to production — this is the first time these
-- objects are ever created). No table design, constraint, comment, or index
-- below has been altered from the audited v6 text.

-- ── B. coach_services — bookable service catalog ──────────────────────────

create table if not exists public.coach_services (
  id                  uuid        primary key default gen_random_uuid(),
  coach_profile_id    uuid        not null references public.coach_profiles(id) on delete cascade,
  title               text        not null,
  description         text,
  delivery_mode       text        not null check (delivery_mode in ('in_person', 'remote', 'hybrid')),
  duration_minutes    integer     not null check (duration_minutes > 0 and duration_minutes <= 480),
  price_amount_minor  integer     not null check (price_amount_minor >= 0),
  currency_code       text        not null check (currency_code ~ '^[A-Z]{3}$'),
  is_active           boolean     not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table  public.coach_services is
  'Per-coach bookable service catalog (CM1 foundation — not exposed by any route/page/RPC yet). One row per sellable lesson offering.';
comment on column public.coach_services.price_amount_minor is
  'Price in integer minor currency units (e.g. USD cents). This is the marketplace transaction source of truth — never coach_profiles.hourly_rate.';
comment on column public.coach_services.currency_code is
  'ISO 4217 alphabetic currency code, exactly three uppercase letters (e.g. USD).';
comment on column public.coach_services.is_active is
  'Defaults false. A service is never automatically sellable — a coach (or later, an operational RPC) must explicitly activate it.';

create index if not exists idx_coach_services_coach_profile_id on public.coach_services (coach_profile_id);
create index if not exists idx_coach_services_is_active        on public.coach_services (coach_profile_id, is_active);

alter table public.coach_services enable row level security;
-- Zero policies created — default-deny.

-- ── C. coach_locations — privacy-safe location records ────────────────────

create table if not exists public.coach_locations (
  id                     uuid             primary key default gen_random_uuid(),
  coach_profile_id       uuid             not null references public.coach_profiles(id) on delete cascade,
  private_location_name  text,
  public_location_label  text,
  city                   text,
  region                 text,
  postal_code_prefix     text,
  latitude               double precision check (latitude  is null or (latitude  >= -90  and latitude  <= 90)),
  longitude              double precision check (longitude is null or (longitude >= -180 and longitude <= 180)),
  service_radius_miles   numeric          check (service_radius_miles is null or service_radius_miles > 0),
  is_active              boolean          not null default false,
  created_at             timestamptz      not null default now(),
  updated_at             timestamptz      not null default now(),
  constraint coach_locations_lat_long_paired check ((latitude is null) = (longitude is null))
);

comment on table  public.coach_locations is
  'Privacy-safe coach location records (CM1 foundation — no PostGIS, no public exposure). No street-address field exists by design.';
comment on column public.coach_locations.private_location_name is
  'Internal-only label. MUST NEVER be exposed through any public-facing view/RPC.';
comment on column public.coach_locations.latitude is
  'Constrained to [-90, 90]. Never exposed publicly — no public view selects this column.';
comment on column public.coach_locations.longitude is
  'Constrained to [-180, 180]. Never exposed publicly — no public view selects this column.';
comment on column public.coach_locations.service_radius_miles is
  'Positive when present. No PostGIS extension is required or added.';

create index if not exists idx_coach_locations_coach_profile_id on public.coach_locations (coach_profile_id);

alter table public.coach_locations enable row level security;
-- Zero policies created — default-deny.

-- ── D. coach_availability_rules — recurring weekly availability ───────────

create table if not exists public.coach_availability_rules (
  id                uuid        primary key default gen_random_uuid(),
  coach_profile_id  uuid        not null references public.coach_profiles(id) on delete cascade,
  day_of_week       integer     not null check (day_of_week between 0 and 6),
  local_start_time  time        not null,
  local_end_time    time        not null,
  timezone          text        not null,
  is_active         boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint coach_availability_rules_end_after_start check (local_end_time > local_start_time)
);

comment on table  public.coach_availability_rules is
  'Recurring weekly availability windows (CM1 foundation — no booking-slot computation or calendar integration exists yet).';
comment on column public.coach_availability_rules.timezone is
  'IANA timezone identifier this rule''s local_start_time/local_end_time are interpreted in. Stored explicitly per-rule.';

create index if not exists idx_coach_availability_rules_coach_profile_id on public.coach_availability_rules (coach_profile_id);

alter table public.coach_availability_rules enable row level security;
-- Zero policies created — default-deny.

-- ── E. coach_availability_exceptions — one-off overrides ──────────────────

create table if not exists public.coach_availability_exceptions (
  id                      uuid        primary key default gen_random_uuid(),
  coach_profile_id        uuid        not null references public.coach_profiles(id) on delete cascade,
  starts_at               timestamptz not null,
  ends_at                 timestamptz not null,
  is_available_override   boolean     not null default false,
  internal_note           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint coach_availability_exceptions_end_after_start check (ends_at > starts_at)
);

comment on table  public.coach_availability_exceptions is
  'One-off availability overrides layered on top of coach_availability_rules (CM1 foundation).';
comment on column public.coach_availability_exceptions.internal_note is
  'Internal-only note. MUST NEVER be part of any public view.';

create index if not exists idx_coach_availability_exceptions_coach_profile_id on public.coach_availability_exceptions (coach_profile_id);
create index if not exists idx_coach_availability_exceptions_window on public.coach_availability_exceptions (coach_profile_id, starts_at, ends_at);

alter table public.coach_availability_exceptions enable row level security;
-- Zero policies created — default-deny.

-- ── F. coach_bookings — lesson booking records (no payments) ──────────────

create table if not exists public.coach_bookings (
  id                            uuid        primary key default gen_random_uuid(),
  golfer_id                     uuid        not null references public.users(id)          on delete restrict,
  coach_profile_id              uuid        not null references public.coach_profiles(id) on delete restrict,
  service_id                    uuid        not null references public.coach_services(id)  on delete restrict,
  location_id                   uuid            references public.coach_locations(id)      on delete set null,
  scheduled_start_at            timestamptz not null,
  scheduled_end_at              timestamptz not null,
  timezone_snapshot             text        not null,
  service_title_snapshot        text        not null,
  duration_minutes_snapshot     integer     not null check (duration_minutes_snapshot > 0),
  gross_amount_minor_snapshot   integer     not null check (gross_amount_minor_snapshot >= 0),
  currency_code_snapshot        text        not null check (currency_code_snapshot ~ '^[A-Z]{3}$'),
  delivery_mode_snapshot        text        not null check (delivery_mode_snapshot in ('in_person', 'remote', 'hybrid')),
  meeting_instructions          text,
  status                        text        not null default 'requested' check (
    status in (
      'requested', 'accepted', 'declined', 'pending_payment', 'confirmed',
      'completed', 'canceled_by_golfer', 'canceled_by_coach', 'no_show', 'refunded'
    )
  ),
  canceled_at                   timestamptz,
  cancellation_reason_category  text,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint coach_bookings_end_after_start check (scheduled_end_at > scheduled_start_at),
  constraint coach_bookings_id_coach_golfer_unique unique (id, coach_profile_id, golfer_id)
);

comment on table  public.coach_bookings is
  'Lesson booking records (CM1 foundation — NO Stripe checkout/session/payment-intent fields exist here). CM1/CM2R create no operational write policy and no status-transition RPC, so no client can write arbitrary status transitions.';
comment on column public.coach_bookings.status is
  'requested | accepted | declined | pending_payment | confirmed | completed | canceled_by_golfer | canceled_by_coach | no_show | refunded. Transitions are not enforced by any RPC yet.';
comment on column public.coach_bookings.gross_amount_minor_snapshot is
  'Integer minor currency units, frozen at booking time from coach_services.price_amount_minor. Never numeric/decimal.';

create index if not exists idx_coach_bookings_golfer_id        on public.coach_bookings (golfer_id);
create index if not exists idx_coach_bookings_coach_profile_id on public.coach_bookings (coach_profile_id);
create index if not exists idx_coach_bookings_service_id       on public.coach_bookings (service_id);
create index if not exists idx_coach_bookings_status           on public.coach_bookings (coach_profile_id, status);

alter table public.coach_bookings enable row level security;
-- Zero policies created — default-deny.

-- ── G. coach_reviews — completed-booking-linked reviews ───────────────────

create table if not exists public.coach_reviews (
  id                     uuid        primary key default gen_random_uuid(),
  booking_id             uuid        not null,
  coach_profile_id       uuid        not null,
  golfer_id              uuid        not null,
  overall_rating         integer     not null check (overall_rating between 1 and 5),
  communication_rating   integer         check (communication_rating   is null or communication_rating   between 1 and 5),
  instruction_rating     integer         check (instruction_rating     is null or instruction_rating     between 1 and 5),
  professionalism_rating integer         check (professionalism_rating is null or professionalism_rating between 1 and 5),
  value_rating           integer         check (value_rating           is null or value_rating           between 1 and 5),
  review_body            text,
  moderation_status      text        not null default 'pending' check (
    moderation_status in ('pending', 'approved', 'rejected', 'hidden')
  ),
  coach_response         text,
  coach_responded_at     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint coach_reviews_booking_id_unique unique (booking_id),
  constraint coach_reviews_booking_identity_fk
    foreign key (booking_id, coach_profile_id, golfer_id)
    references public.coach_bookings (id, coach_profile_id, golfer_id)
    on delete restrict
);

comment on table  public.coach_reviews is
  'Completed-booking-linked coach reviews (CM1 foundation). Every review is structurally tied to exactly one booking via a composite foreign key AND validated by a BEFORE INSERT/UPDATE trigger that the referenced booking has status = completed. No anonymous review policy exists.';
comment on column public.coach_reviews.moderation_status is
  'pending | approved | rejected | hidden. Only approved reviews are aggregated into public.coach_rating_summary.';
comment on constraint coach_reviews_booking_identity_fk on public.coach_reviews is
  'Composite FK requires (booking_id, coach_profile_id, golfer_id) to match a single coach_bookings row exactly — prevents a review from being attached to a different coach or golfer than the booking it references.';

create index if not exists idx_coach_reviews_coach_profile_id on public.coach_reviews (coach_profile_id);
create index if not exists idx_coach_reviews_golfer_id        on public.coach_reviews (golfer_id);
create index if not exists idx_coach_reviews_moderation_status on public.coach_reviews (coach_profile_id, moderation_status);

alter table public.coach_reviews enable row level security;
-- Zero policies created — default-deny. No INSERT policy exists, so no
-- client role can insert a review yet — the trigger below is a structural
-- safeguard for when an operational INSERT policy is added in a later
-- phase, not a substitute for RLS here.

-- Trigger function: unmodified from v6. SECURITY INVOKER (not DEFINER) —
-- runs with the calling role's own privileges, never elevated, so it can
-- never be used to read or infer coach_bookings rows a caller would not
-- otherwise be permitted to see. SET search_path = '' plus full
-- public.-qualification of every relation closes off search_path hijacking
-- entirely, on top of SECURITY INVOKER already preventing privilege
-- elevation — it does not elevate the caller's privileges or bypass RLS.
create or replace function public.fn_enforce_coach_review_completed_booking()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_booking_status           text;
  v_booking_coach_profile_id uuid;
  v_booking_golfer_id        uuid;
begin
  select status, coach_profile_id, golfer_id
    into v_booking_status, v_booking_coach_profile_id, v_booking_golfer_id
    from public.coach_bookings
    where id = new.booking_id;

  if not found then
    raise exception 'coach_reviews: referenced booking % does not exist', new.booking_id;
  end if;

  if v_booking_status <> 'completed' then
    raise exception
      'coach_reviews: booking % is not completed (status=%); a review may only be linked to a completed booking',
      new.booking_id, v_booking_status;
  end if;

  if v_booking_coach_profile_id <> new.coach_profile_id then
    raise exception 'coach_reviews: coach_profile_id does not match the referenced booking';
  end if;

  if v_booking_golfer_id <> new.golfer_id then
    raise exception 'coach_reviews: golfer_id does not match the referenced booking';
  end if;

  return new;
end;
$fn$;

comment on function public.fn_enforce_coach_review_completed_booking() is
  'BEFORE INSERT/UPDATE trigger function for coach_reviews. SECURITY INVOKER (not SECURITY DEFINER) — runs with the calling role''s own privileges. SET search_path = '''' — every referenced relation is explicitly public.-qualified. Rejects any review not linked to a completed booking, or whose coach_profile_id/golfer_id does not match that booking.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_coach_reviews_enforce_completed_booking'
      and tgrelid = 'public.coach_reviews'::regclass
  ) then
    create trigger trg_coach_reviews_enforce_completed_booking
      before insert or update of booking_id, coach_profile_id, golfer_id
      on public.coach_reviews
      for each row
      execute function public.fn_enforce_coach_review_completed_booking();
  end if;
end $$;

-- ── H. coach_rating_summary — approved-review-only rating read model ──────
-- Version-branched exactly as v6 (PREFLIGHT A already guarantees PG15+, so
-- the ELSE branch below is unreachable in practice — retained unmodified
-- from the audited v6 text rather than casually collapsed to a single
-- unbranched CREATE VIEW).

do $$
begin
  if current_setting('server_version_num')::int >= 150000 then
    execute $exec$
      create or replace view public.coach_rating_summary
      with (security_invoker = true)
      as
      select
        coach_profile_id,
        count(*)::integer                                as approved_review_count,
        round(avg(overall_rating)::numeric, 2)            as overall_rating_average,
        round(avg(communication_rating)::numeric, 2)      as communication_rating_average,
        round(avg(instruction_rating)::numeric, 2)        as instruction_rating_average,
        round(avg(professionalism_rating)::numeric, 2)    as professionalism_rating_average,
        round(avg(value_rating)::numeric, 2)              as value_rating_average
      from public.coach_reviews
      where moderation_status = 'approved'
      group by coach_profile_id
    $exec$;
  else
    execute $exec$
      create or replace view public.coach_rating_summary
      as
      select
        coach_profile_id,
        count(*)::integer                                as approved_review_count,
        round(avg(overall_rating)::numeric, 2)            as overall_rating_average,
        round(avg(communication_rating)::numeric, 2)      as communication_rating_average,
        round(avg(instruction_rating)::numeric, 2)        as instruction_rating_average,
        round(avg(professionalism_rating)::numeric, 2)    as professionalism_rating_average,
        round(avg(value_rating)::numeric, 2)              as value_rating_average
      from public.coach_reviews
      where moderation_status = 'approved'
      group by coach_profile_id
    $exec$;
  end if;
end $$;

comment on view public.coach_rating_summary is
  'Approved-review-only rating read model. Exposes ONLY coach_profile_id and per-category averages/count — never review_body, golfer identity, coach location, coordinates, or internal notes. There is no client-writable rating aggregate anywhere in this schema. Not granted to anon or authenticated; granted SELECT to service_role only (see grants below) for a future server-side ratings read path — no route/RPC reads it yet.';

-- ============================================================================
-- SECTION 5 — DEFAULT-DENY GRANTS on the six new tables + rating summary
-- ============================================================================
revoke all on public.coach_services               from public, anon, authenticated;
revoke all on public.coach_locations               from public, anon, authenticated;
revoke all on public.coach_availability_rules      from public, anon, authenticated;
revoke all on public.coach_availability_exceptions from public, anon, authenticated;
revoke all on public.coach_bookings                from public, anon, authenticated;
revoke all on public.coach_reviews                 from public, anon, authenticated;
revoke all on public.coach_rating_summary          from public, anon, authenticated;
-- No TRUNCATE/REFERENCES/TRIGGER (or any other) privilege is granted to
-- service_role on coach_services, coach_locations, coach_availability_rules,
-- coach_availability_exceptions, or coach_bookings — no audited server-side
-- operation in this migration touches them yet, so nothing beyond their
-- already-enabled, zero-policy RLS default-deny is added for them.
--
-- coach_reviews is the one exception: coach_rating_summary is declared
-- WITH (security_invoker = true) (see above), and a security_invoker view
-- evaluates the underlying base relation's privileges AND row-level
-- security AS THE INVOKING ROLE — it does NOT run with the view owner's
-- privileges the way a plain (or SECURITY DEFINER) view would. Since only
-- service_role is ever meant to query this view (see the REVOKE/GRANT on
-- the view itself, immediately below), service_role must hold real,
-- explicit, read-only SELECT on the view's own base table
-- (public.coach_reviews) or the view would be entirely unusable — every
-- query against it would return zero rows (or a permission error),
-- regardless of the GRANT SELECT on the view. This is a deliberate,
-- narrow, read-only exception: SELECT only, never INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER, and only on coach_reviews — the other five
-- marketplace tables remain entirely inaccessible to service_role in this
-- slice, matching the "no audited server-side operation needs it yet"
-- posture above. See PREFLIGHT I and POSTFLIGHT E below, which verify
-- service_role has BYPASSRLS — the reason this explicit table-level SELECT
-- grant is still sufficient for the view to work even though
-- coach_reviews has RLS enabled with zero policies (BYPASSRLS means
-- service_role's row-level security is not evaluated at all, so the
-- zero-policy default-deny posture never blocks it; only the table-level
-- GRANT actually gates its access).
grant select on public.coach_reviews to service_role;

grant select on public.coach_rating_summary to service_role;

-- ============================================================================
-- SECTION 6 — SECURITY DEFINER FUNCTIONS
-- ============================================================================
-- Every function below: SECURITY DEFINER, SET search_path = '', every
-- relation/function reference schema-qualified, identity derived only from
-- auth.uid() (no user_id/coach_profile_id/arbitrary-owner parameter exists
-- on any of them), rejects a null auth.uid(), requires public.users.role =
-- 'coach', never exposes public.users.email/full_name, narrow explicit
-- RETURNS TABLE contracts only (never RETURNS public.coach_profiles, never
-- SELECT *, never RETURNING *), no dynamic SQL anywhere. Revoked from PUBLIC
-- and anon; EXECUTE granted to authenticated only.

-- ── 6.A — fn_get_or_create_own_coach_profile() ─────────────────────────────
-- Safe replacement for the unresolved legacy profile-creation path: no
-- application code anywhere creates a coach_profiles row, and no database
-- trigger creates one either (the inspected auth.users creation trigger
-- inserts into public.users only). This function is idempotent and
-- concurrency-safe via ON CONFLICT against the existing coach_profiles_
-- user_id_key uniqueness contract — two simultaneous calls from the same
-- coach can never create two rows or raise a uniqueness error.
create function public.fn_get_or_create_own_coach_profile()
returns table (
  id uuid,
  business_name text,
  bio text,
  specialties text[],
  certification text,
  hourly_rate numeric,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  public_slug text,
  marketplace_display_name text,
  marketplace_headline text,
  profile_photo_url text,
  years_coaching integer,
  lesson_delivery_modes text[],
  public_city text,
  public_region text,
  timezone text,
  marketplace_visibility_status text,
  verification_status text,
  minimum_booking_notice_hours integer,
  cancellation_policy_summary text
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_id uuid;
  v_role text;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'fn_get_or_create_own_coach_profile: no authenticated caller';
  end if;

  select u.role into v_role from public.users u where u.id = v_caller_id;
  if v_role is distinct from 'coach' then
    raise exception 'fn_get_or_create_own_coach_profile: caller is not a coach';
  end if;

  insert into public.coach_profiles (user_id)
  values (v_caller_id)
  on conflict (user_id) do nothing;

  return query
    select
      cp.id, cp.business_name, cp.bio, cp.specialties, cp.certification,
      cp.hourly_rate, cp.is_active, cp.created_at, cp.updated_at,
      cp.public_slug, cp.marketplace_display_name, cp.marketplace_headline,
      cp.profile_photo_url, cp.years_coaching, cp.lesson_delivery_modes,
      cp.public_city, cp.public_region, cp.timezone,
      cp.marketplace_visibility_status, cp.verification_status,
      cp.minimum_booking_notice_hours, cp.cancellation_policy_summary
    from public.coach_profiles cp
    where cp.user_id = v_caller_id;
end;
$fn$;

comment on function public.fn_get_or_create_own_coach_profile() is
  'SECURITY DEFINER. Idempotent, concurrency-safe get-or-create of the calling coach''s own coach_profiles row via INSERT ... ON CONFLICT (user_id) DO NOTHING. Zero parameters — never accepts id or user_id. Inserts only user_id; every other column relies on its existing table default. Never creates a row for a non-coach. Returns no public.users data and never exposes user_id in the return contract.';

revoke execute on function public.fn_get_or_create_own_coach_profile() from public;
revoke execute on function public.fn_get_or_create_own_coach_profile() from anon;
grant execute on function public.fn_get_or_create_own_coach_profile() to authenticated;

-- ── 6.B — fn_get_own_coach_marketplace_profile() ───────────────────────────
-- Preserves CM2A's audited function, extended with marketplace_display_name.
create function public.fn_get_own_coach_marketplace_profile()
returns table (
  coach_profile_id uuid,
  public_slug text,
  marketplace_display_name text,
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
      cp.marketplace_display_name,
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
  'SECURITY DEFINER, own-row-only read of the calling coach''s marketplace profile fields, extended from the CM2A contract with marketplace_display_name. Zero parameters — identity comes only from auth.uid(). bio is included read-only here (writes go through fn_update_own_coach_profile_legacy). Never returns public.coach_profiles or a wildcard select.';

revoke execute on function public.fn_get_own_coach_marketplace_profile() from public;
revoke execute on function public.fn_get_own_coach_marketplace_profile() from anon;
grant execute on function public.fn_get_own_coach_marketplace_profile() to authenticated;

-- ── 6.C — fn_update_own_coach_profile_legacy(...) ──────────────────────────
-- The four legacy, pre-CM1 fields a coach may still self-manage. Blank
-- optional scalar values are normalized to NULL (not rejected) rather than
-- stored as empty strings; each specialties entry is trimmed and blank
-- entries are dropped. Length/count bounds are conservative and generous
-- relative to any plausible existing value, so this never invalidates data
-- a coach could already legitimately have — see
-- lib/coach-marketplace-v8-reconciliation-schema.test.ts for the exact
-- documented limits.
create function public.fn_update_own_coach_profile_legacy(
  p_business_name text,
  p_bio text,
  p_specialties text[],
  p_certification text
)
returns table (
  id uuid,
  business_name text,
  bio text,
  specialties text[],
  certification text,
  hourly_rate numeric,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_id uuid;
  v_role text;
  v_business_name text;
  v_bio text;
  v_certification text;
  v_specialties text[];
  v_entry text;
  v_specialty_count integer;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'fn_update_own_coach_profile_legacy: no authenticated caller';
  end if;

  select u.role into v_role from public.users u where u.id = v_caller_id;
  if v_role is distinct from 'coach' then
    raise exception 'fn_update_own_coach_profile_legacy: caller is not a coach';
  end if;

  v_business_name := nullif(btrim(p_business_name), '');
  if v_business_name is not null and length(v_business_name) > 200 then
    raise exception 'fn_update_own_coach_profile_legacy: business_name must be 200 characters or fewer';
  end if;

  v_bio := nullif(btrim(p_bio), '');
  if v_bio is not null and length(v_bio) > 2000 then
    raise exception 'fn_update_own_coach_profile_legacy: bio must be 2000 characters or fewer';
  end if;

  v_certification := nullif(btrim(p_certification), '');
  if v_certification is not null and length(v_certification) > 200 then
    raise exception 'fn_update_own_coach_profile_legacy: certification must be 200 characters or fewer';
  end if;

  if p_specialties is not null then
    v_specialties := array[]::text[];
    foreach v_entry in array p_specialties loop
      v_entry := nullif(btrim(v_entry), '');
      if v_entry is not null then
        if length(v_entry) > 60 then
          raise exception 'fn_update_own_coach_profile_legacy: each specialty must be 60 characters or fewer';
        end if;
        v_specialties := v_specialties || v_entry;
      end if;
    end loop;
    v_specialty_count := array_length(v_specialties, 1);
    if v_specialty_count is not null and v_specialty_count > 20 then
      raise exception 'fn_update_own_coach_profile_legacy: no more than 20 specialties are allowed';
    end if;
    if v_specialty_count is null then
      v_specialties := null;
    end if;
  else
    v_specialties := null;
  end if;

  update public.coach_profiles set
    business_name = v_business_name,
    bio            = v_bio,
    specialties    = v_specialties,
    certification  = v_certification,
    updated_at     = pg_catalog.now()
  where user_id = v_caller_id;

  if not found then
    raise exception 'fn_update_own_coach_profile_legacy: no owned coach_profiles row found for caller';
  end if;

  return query
    select cp.id, cp.business_name, cp.bio, cp.specialties, cp.certification,
           cp.hourly_rate, cp.is_active, cp.created_at, cp.updated_at
    from public.coach_profiles cp
    where cp.user_id = v_caller_id;
end;
$fn$;

comment on function public.fn_update_own_coach_profile_legacy(text, text, text[], text) is
  'SECURITY DEFINER, own-row-only write of exactly the four legacy fields (business_name, bio, specialties, certification). Never writes hourly_rate, is_active, any marketplace field, or any protected/identity/administrative field — they are simply absent from the parameter list. Requires the row to already exist. Blank scalar values normalize to NULL; blank specialties entries are dropped.';

revoke execute on function public.fn_update_own_coach_profile_legacy(text, text, text[], text) from public;
revoke execute on function public.fn_update_own_coach_profile_legacy(text, text, text[], text) from anon;
grant execute on function public.fn_update_own_coach_profile_legacy(text, text, text[], text) to authenticated;

-- ── 6.D — fn_update_coach_marketplace_profile(...) ─────────────────────────
-- Preserves every CM2A validation/protection rule, extended with
-- marketplace_display_name and with bio removed from the writable parameter
-- list (bio is reclassified as a legacy field owned by
-- fn_update_own_coach_profile_legacy — it remains a read-only passthrough
-- in this function's return contract only).
create function public.fn_update_coach_marketplace_profile(
  p_public_slug text,
  p_marketplace_display_name text,
  p_marketplace_headline text,
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
  marketplace_display_name text,
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

  -- ── marketplace_display_name ──────────────────────────────────────
  if p_marketplace_display_name is not null then
    if btrim(p_marketplace_display_name) = '' then
      raise exception 'fn_update_coach_marketplace_profile: marketplace_display_name must not be blank when provided';
    end if;
    if length(p_marketplace_display_name) > 100 then
      raise exception 'fn_update_coach_marketplace_profile: marketplace_display_name must be 100 characters or fewer';
    end if;
  end if;

  -- ── marketplace_headline ──────────────────────────────────────────
  if p_marketplace_headline is not null and length(p_marketplace_headline) > 120 then
    raise exception 'fn_update_coach_marketplace_profile: marketplace_headline must be 120 characters or fewer';
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
    if p_marketplace_display_name is null or btrim(p_marketplace_display_name) = '' then
      raise exception 'fn_update_coach_marketplace_profile: publishing requires a nonblank marketplace_display_name';
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
  --    profile_photo_url, and bio are never assigned here. ──────────────
  begin
    update public.coach_profiles set
      public_slug                   = p_public_slug,
      marketplace_display_name      = p_marketplace_display_name,
      marketplace_headline          = p_marketplace_headline,
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
      cp.marketplace_display_name,
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
  'SECURITY DEFINER, own-row-only write of the calling coach''s marketplace profile fields, extended from the CM2A contract with marketplace_display_name and with bio removed (bio now belongs to fn_update_own_coach_profile_legacy). No target user/coach/profile ID parameter. Never accepts or writes verification_status, id, user_id, hourly_rate, bio, or profile_photo_url. Rejects a currently-suspended row and rejects assigning suspended. Publish-readiness requires a nonblank public_slug, marketplace_display_name, and marketplace_headline, plus at least one lesson_delivery_mode. Translates only the exact idx_coach_profiles_public_slug_unique conflict to a friendly error and re-raises any unrelated unique_violation unchanged.';

revoke execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) from public;
revoke execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) from anon;
grant execute on function public.fn_update_coach_marketplace_profile(
  text, text, text, integer, text[], text, text, text, text, integer, text
) to authenticated;

-- ── 6.E — fn_set_own_coach_active(p_is_active boolean) ─────────────────────
-- A single-purpose account-level kill-switch, deliberately separate from
-- both profile-editing functions above: is_active takes precedence over
-- marketplace_visibility_status in the directory eligibility predicate
-- (see SECTION 7 below), so it deserves its own narrow, auditable boundary
-- rather than being folded into routine profile-content edits. The bare
-- UPDATE below already acquires a row-level lock on the caller's own row
-- for the remainder of the transaction — no separate SELECT ... FOR UPDATE
-- is needed since there is no prior-state condition to check.
create function public.fn_set_own_coach_active(p_is_active boolean)
returns table (
  id uuid,
  is_active boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_caller_id uuid;
  v_role text;
begin
  if p_is_active is null then
    raise exception 'fn_set_own_coach_active: p_is_active must not be null';
  end if;

  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'fn_set_own_coach_active: no authenticated caller';
  end if;

  select u.role into v_role from public.users u where u.id = v_caller_id;
  if v_role is distinct from 'coach' then
    raise exception 'fn_set_own_coach_active: caller is not a coach';
  end if;

  update public.coach_profiles
     set is_active  = p_is_active,
         updated_at = pg_catalog.now()
   where user_id = v_caller_id;

  if not found then
    raise exception 'fn_set_own_coach_active: no owned coach_profiles row found for caller';
  end if;

  return query
    select cp.id, cp.is_active
    from public.coach_profiles cp
    where cp.user_id = v_caller_id;
end;
$fn$;

comment on function public.fn_set_own_coach_active(boolean) is
  'SECURITY DEFINER, single-purpose own-row activation/deactivation switch. One required (non-null) boolean parameter. Updates is_active only — never marketplace_visibility_status, verification_status, or any other profile content. Never accepts an arbitrary profile/user ID.';

revoke execute on function public.fn_set_own_coach_active(boolean) from public;
revoke execute on function public.fn_set_own_coach_active(boolean) from anon;
grant execute on function public.fn_set_own_coach_active(boolean) to authenticated;

-- ============================================================================
-- SECTION 7 — RECONCILED DIRECTORY VIEW — public.coach_directory_listing
-- ============================================================================
-- Private, server-only projection, extended from CM2A's audited design with
-- marketplace_display_name and an is_active/published/slug/display-name/
-- verification eligibility predicate. Still WITH (security_invoker = true)
-- as defense-in-depth even though only service_role ever queries it. No
-- join to public.users or public.coach_locations. No email, no full_name,
-- no users.display_name, no user_id, no created_at/updated_at, no exact
-- coordinates, no private_location_name, no internal availability notes, no
-- admin-only field beyond the already-approved public verification_status
-- label. marketplace_visibility_status and is_active are inputs to the
-- filter, not public information, and are never projected.
create view public.coach_directory_listing
with (security_invoker = true)
as
select
  cp.id as coach_profile_id,
  cp.public_slug,
  cp.marketplace_display_name,
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
where cp.is_active is true
  and cp.marketplace_visibility_status = 'published'
  and cp.public_slug is not null
  and btrim(cp.public_slug) <> ''
  and cp.marketplace_display_name is not null
  and btrim(cp.marketplace_display_name) <> ''
  and cp.verification_status not in ('rejected', 'suspended');

comment on view public.coach_directory_listing is
  'Private, server-only public-directory projection (CM2R, reconciled). Requires is_active = true, marketplace_visibility_status = published, a non-blank public_slug, and a non-blank marketplace_display_name; excludes rejected- and suspended-verification profiles. Never exposes marketplace_visibility_status, is_active, user_id, hourly_rate, business_name, certification, specialties, created_at, updated_at, or anything from public.users or public.coach_locations. business_name is never used as the directory identity — marketplace_display_name is the sole public identity contract. Revoked from PUBLIC, anon, and authenticated — granted only to service_role, and must only ever be queried from server-only application code after lib/coach-marketplace-access.ts confirms COACH_MARKETPLACE_ENABLED is true.';

revoke all on public.coach_directory_listing from public, anon, authenticated;
grant select on public.coach_directory_listing to service_role;

-- ============================================================================
-- POSTFLIGHT — final effective-access verification (runs after every
-- column/table/function/view has been created and every REVOKE/GRANT/
-- DROP POLICY above has been issued, but BEFORE COMMIT). Any failure here
-- raises an exception, which rolls back this entire transaction —
-- including every schema change already made above in this same
-- transaction — so a security regression can never be left committed.
-- This is a defense-in-depth check against the migration's OWN mistakes
-- (a forgotten REVOKE, a typo'd role name, an accidental extra GRANT), not
-- a substitute for the baseline preflight above.
-- ============================================================================

-- POSTFLIGHT A — public.coach_profiles final state
do $$
declare
  v_problems text[] := array[]::text[];
  v_priv text;
  v_role text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'coach_profiles'
      and c.relrowsecurity = true and c.relforcerowsecurity = false
  ) then
    raise exception 'postflight A: public.coach_profiles must have RLS enabled and NOT forced after this migration';
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'coach_profiles') <> 0 then
    raise exception 'postflight A: public.coach_profiles must have zero policies after this migration';
  end if;

  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'coach_profiles' and grantee = 'PUBLIC'
  ) or exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'coach_profiles' and grantee = 'PUBLIC'
  ) then
    raise exception 'postflight A: PUBLIC must have no direct grant on public.coach_profiles after this migration';
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(v_role, 'public.coach_profiles', v_priv) then
        v_problems := v_problems || (v_role || ' still has effective ' || v_priv || ' on public.coach_profiles');
      end if;
    end loop;
  end loop;

  if not has_table_privilege('service_role', 'public.coach_profiles', 'SELECT') then
    v_problems := v_problems || 'service_role is missing the intended effective SELECT on public.coach_profiles';
  end if;
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('service_role', 'public.coach_profiles', v_priv) then
      v_problems := v_problems || ('service_role unexpectedly has effective ' || v_priv || ' on public.coach_profiles');
    end if;
  end loop;

  if array_length(v_problems, 1) > 0 then
    raise exception 'postflight A: public.coach_profiles final effective-access verification failed: %', array_to_string(v_problems, '; ');
  end if;
end $$;

-- POSTFLIGHT B — the six marketplace tables' final state, per-table
-- privilege matrix. coach_reviews is the sole exception: service_role
-- holds real, explicit, read-only SELECT there (see SECTION 5 above) so
-- coach_rating_summary — a SECURITY INVOKER view — can actually be
-- queried by service_role. The other five tables remain fully
-- inaccessible to service_role, matching "no audited server-side
-- operation touches them yet." PUBLIC, anon, and authenticated have zero
-- effective privilege on all six tables, without exception.
do $$
declare
  v_problems text[] := array[]::text[];
  v_table text;
  v_role text;
  v_priv text;
  v_service_role_privs text[];
begin
  foreach v_table in array array[
    'coach_services', 'coach_locations', 'coach_availability_rules',
    'coach_availability_exceptions', 'coach_bookings', 'coach_reviews'
  ] loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity = true
    ) then
      v_problems := v_problems || (v_table || ' must have RLS enabled');
    end if;

    if (select count(*) from pg_policies where schemaname = 'public' and tablename = v_table) <> 0 then
      v_problems := v_problems || (v_table || ' must have zero policies');
    end if;

    if exists (
      select 1 from information_schema.table_privileges
      where table_schema = 'public' and table_name = v_table and grantee = 'PUBLIC'
    ) then
      v_problems := v_problems || (v_table || ' must have no direct PUBLIC grant');
    end if;

    -- PUBLIC, anon, and authenticated: zero effective privilege on every
    -- one of the six tables, without exception.
    foreach v_role in array array['anon', 'authenticated'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_role, 'public.' || v_table, v_priv) then
          v_problems := v_problems || (v_role || ' unexpectedly has effective ' || v_priv || ' on public.' || v_table);
        end if;
      end loop;
    end loop;

    -- service_role: per-table matrix. coach_reviews gets exactly SELECT;
    -- every other table gets exactly nothing.
    v_service_role_privs := case
      when v_table = 'coach_reviews' then array['SELECT']::text[]
      else array[]::text[]
    end;
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if v_priv = any(v_service_role_privs) then
        if not has_table_privilege('service_role', 'public.' || v_table, v_priv) then
          v_problems := v_problems || ('service_role is missing the intended effective ' || v_priv || ' on public.' || v_table);
        end if;
      else
        if has_table_privilege('service_role', 'public.' || v_table, v_priv) then
          v_problems := v_problems || ('service_role unexpectedly has effective ' || v_priv || ' on public.' || v_table);
        end if;
      end if;
    end loop;
  end loop;

  if array_length(v_problems, 1) > 0 then
    raise exception 'postflight B: marketplace table final effective-access verification failed: %', array_to_string(v_problems, '; ');
  end if;
end $$;

-- POSTFLIGHT C — coach_rating_summary and coach_directory_listing views
do $$
declare
  v_problems text[] := array[]::text[];
  v_view text;
  v_role text;
  v_priv text;
begin
  foreach v_view in array array['coach_rating_summary', 'coach_directory_listing'] loop
    -- Explicit ACL/catalog check for a direct PUBLIC grant on the view
    -- itself — distinct from (and in addition to) the effective
    -- anon/authenticated has_table_privilege() checks below, which catch
    -- privilege inherited THROUGH a PUBLIC grant or role membership but
    -- don't themselves prove no PUBLIC-grantee row exists in the catalog.
    if exists (
      select 1 from information_schema.table_privileges
      where table_schema = 'public' and table_name = v_view
        and grantee = 'PUBLIC' and privilege_type = 'SELECT'
    ) then
      v_problems := v_problems || ('PUBLIC must not have a direct SELECT grant on public.' || v_view);
    end if;

    foreach v_role in array array['anon', 'authenticated'] loop
      if has_table_privilege(v_role, 'public.' || v_view, 'SELECT') then
        v_problems := v_problems || (v_role || ' must not be able to SELECT public.' || v_view);
      end if;
    end loop;
    if not has_table_privilege('service_role', 'public.' || v_view, 'SELECT') then
      v_problems := v_problems || ('service_role must be able to SELECT public.' || v_view);
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_role, 'public.' || v_view, v_priv) then
          v_problems := v_problems || (v_role || ' unexpectedly has effective ' || v_priv || ' on public.' || v_view);
        end if;
      end loop;
    end loop;
  end loop;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'coach_directory_listing'
      and 'security_invoker=true' = any(c.reloptions)
  ) then
    v_problems := v_problems || 'coach_directory_listing must retain security_invoker=true';
  end if;

  if array_length(v_problems, 1) > 0 then
    raise exception 'postflight C: view final effective-access verification failed: %', array_to_string(v_problems, '; ');
  end if;
end $$;

-- POSTFLIGHT D — all five coach-owned functions, exact signatures.
-- Every lookup below goes through pg_catalog.to_regprocedure(...), which
-- returns NULL for a missing/mistyped signature instead of throwing —
-- unlike a direct `signature::regprocedure` cast, which would raise its
-- own generic "function does not exist" error and abort the transaction
-- BEFORE this block gets a chance to produce its own stable, named
-- `postflight D:` exception. A NULL OID is recorded as its own problem and
-- every subsequent pg_proc/has_function_privilege check for that
-- signature is skipped (there is nothing to check), so one missing
-- function can't mask problems with the other four or crash the block
-- outright.
do $$
declare
  r record;
  v_problems text[] := array[]::text[];
  v_oid oid;
  v_owner_oid oid;
  v_owner_name text;
begin
  for r in
    select * from (values
      ('fn_get_or_create_own_coach_profile', 'public.fn_get_or_create_own_coach_profile()'),
      ('fn_get_own_coach_marketplace_profile', 'public.fn_get_own_coach_marketplace_profile()'),
      ('fn_update_own_coach_profile_legacy', 'public.fn_update_own_coach_profile_legacy(text, text, text[], text)'),
      ('fn_update_coach_marketplace_profile', 'public.fn_update_coach_marketplace_profile(text, text, text, integer, text[], text, text, text, text, integer, text)'),
      ('fn_set_own_coach_active', 'public.fn_set_own_coach_active(boolean)')
    ) as expected(fn_name, fn_signature)
  loop
    v_oid := pg_catalog.to_regprocedure(r.fn_signature);

    if v_oid is null then
      v_problems := v_problems || ('exact signature ' || r.fn_signature || ' does not resolve to any function — it is missing, mistyped, or its signature drifted');
      continue;
    end if;

    if not exists (select 1 from pg_proc p where p.oid = v_oid and p.prosecdef = true) then
      v_problems := v_problems || (r.fn_signature || ' must be SECURITY DEFINER');
    end if;

    if not exists (
      select 1 from pg_proc p
      where p.oid = v_oid
        and exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=')
    ) then
      v_problems := v_problems || (r.fn_signature || ' must have search_path locked to empty');
    end if;

    -- Positive owner-trust proof: the function's owner must be the exact
    -- role that ran this migration (current_user) — the same role
    -- PREFLIGHT D already proved is either the owner of
    -- public.coach_profiles or a PostgreSQL superuser. This is a positive
    -- assertion tied to that specific, already-vetted role, not merely a
    -- blacklist of three excluded role names (anon/authenticated/
    -- service_role could be excluded by name yet the function could still
    -- be owned by some OTHER untrusted role a blacklist wouldn't catch).
    select p.proowner into v_owner_oid from pg_proc p where p.oid = v_oid;
    select ro.rolname into v_owner_name from pg_roles ro where ro.oid = v_owner_oid;

    if v_owner_name is distinct from current_user then
      v_problems := v_problems || (r.fn_signature || ' must be owned by current_user (the migration-running role, already proven trusted by preflight D) — actual owner is ' || coalesce(v_owner_name, '<unknown>'));
    end if;
    if v_owner_name in ('anon', 'authenticated', 'service_role') then
      v_problems := v_problems || (r.fn_signature || ' must not be owned by a browser-facing or service role (owner=' || v_owner_name || ')');
    end if;

    if exists (
      select 1 from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name = r.fn_name
        and grantee = 'PUBLIC' and privilege_type = 'EXECUTE'
    ) then
      v_problems := v_problems || (r.fn_signature || ' must not have an explicit PUBLIC EXECUTE grant');
    end if;

    if has_function_privilege('anon', r.fn_signature, 'EXECUTE') then
      v_problems := v_problems || (r.fn_signature || ' must not be executable by anon');
    end if;
    if not has_function_privilege('authenticated', r.fn_signature, 'EXECUTE') then
      v_problems := v_problems || (r.fn_signature || ' must be executable by authenticated');
    end if;

    if (
      select count(*) from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
      where n2.nspname = 'public' and p2.proname = r.fn_name
    ) <> 1 then
      v_problems := v_problems || (r.fn_name || ' must have exactly one overload/signature in the public schema');
    end if;
  end loop;

  if array_length(v_problems, 1) > 0 then
    raise exception 'postflight D: function final effective-access verification failed: %', array_to_string(v_problems, '; ');
  end if;
end $$;

-- POSTFLIGHT E — service_role BYPASSRLS retained
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls = true) then
    raise exception 'postflight E: service_role must retain BYPASSRLS — both server-only security_invoker views depend on it';
  end if;
end $$;

commit;

-- ============================================================================
-- Deferred to later, separately-reviewed slices (unchanged from CM1/CM2A):
--   - Profile-photo upload/storage (profile_photo_url remains read-only via
--     every function in this file).
--   - Admin/moderation functions for verification_status and suspended
--     marketplace_visibility_status — no function in this file can write
--     either.
--   - Pages/routes/components/navigation, search, pagination, booking
--     status-transition RPCs, review moderation, payments, Stripe Connect.
--   - Privacy-safe nearby-search RPC/view — coach_locations.latitude/
--     longitude/private_location_name remain unexposed until then.
-- ============================================================================
