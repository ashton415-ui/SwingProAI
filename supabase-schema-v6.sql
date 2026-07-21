-- SwingProAI — Schema v6: Coach Marketplace CM1 (Foundation)
-- Run in: Supabase Dashboard > SQL Editor > New query > Run
--
-- ============================================================================
-- THIS MIGRATION IS UNAPPLIED BY CM1.
-- It ships as source only. CM1 does not run this file against any Supabase
-- project (staging or production). Applying it is a separate, later step
-- that requires an explicit live-schema reconciliation pass first — see
-- docs/COACH_MARKETPLACE_ROLLOUT.md, "Production schema-drift risk" and
-- "Mandatory live-schema reconciliation before applying v6".
-- ============================================================================
--
-- Safe + additive + forward-only: every statement is idempotent
-- (IF NOT EXISTS / catalog guards), so re-running is a no-op and no
-- existing data, table, column, or policy is ever dropped, truncated, or
-- destructively rewritten. No Stripe code of any kind appears in this file.
--
-- Scope: foundation schema for the Coach Marketplace only. This migration
-- creates no public-facing feature — every new table starts with Row Level
-- Security enabled and ZERO policies (default-deny). No client, anon, or
-- authenticated role can read or write any new table until a later phase
-- explicitly adds operational policies. The product remains fully gated by
-- the COACH_MARKETPLACE_ENABLED server-only flag (lib/feature-flags.ts)
-- regardless of migration state.
--
-- Extended:
--   public.coach_profiles                — additive marketplace columns only
--                                           (existing table, NOT recreated)
--
-- Created:
--   public.coach_services                — per-coach bookable service catalog
--   public.coach_locations                — privacy-safe coach location records
--   public.coach_availability_rules       — recurring weekly availability
--   public.coach_availability_exceptions  — one-off availability overrides
--   public.coach_bookings                 — lesson booking records (no payments)
--   public.coach_reviews                  — completed-booking-linked reviews
--   public.coach_rating_summary (view)    — approved-review-only rating read model
--
-- Deferred to later phases (see docs/COACH_MARKETPLACE_ROLLOUT.md):
--   operational RLS policies, status-transition RPCs, PostGIS/nearby search,
--   Stripe Connect accounts, one-time lesson payments, payouts, refunds.

begin;

-- ============================================================================
-- A. EXTEND public.coach_profiles (existing table — additive columns only)
-- ============================================================================

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
  add column if not exists cancellation_policy_summary        text;

-- Existing rows remain valid without backfill: every new column above is
-- either nullable, or NOT NULL with a constant DEFAULT that Postgres applies
-- to existing rows automatically as part of ADD COLUMN (no table rewrite,
-- no manual UPDATE required).

-- Deliberately NOT added, per CM1 scope: avg_rating, review_count (no
-- client-writable aggregate — see public.coach_rating_summary below, which
-- is the only rating read model and is entirely derived from approved
-- reviews). Deliberately NOT added: any street-address column.

comment on column public.coach_profiles.public_slug is
  'Unique public marketplace URL slug. Null until a coach opts into the marketplace. Enforced unique only when non-null (see idx_coach_profiles_public_slug_unique).';
comment on column public.coach_profiles.marketplace_headline is
  'Short public-facing tagline shown on the marketplace profile card. Not used anywhere until CM2.';
comment on column public.coach_profiles.profile_photo_url is
  'Public marketplace profile photo URL. Distinct from any private/internal avatar field on users.';
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
  'hidden | draft | published | suspended. Controls whether this profile is eligible to ever be publicly listed. CM1 creates no public-read policy regardless of this value.';
comment on column public.coach_profiles.verification_status is
  'unverified | pending | verified | rejected | suspended. Independent of marketplace_visibility_status — a profile can be published-but-unverified or hidden-but-verified.';
comment on column public.coach_profiles.minimum_booking_notice_hours is
  'Minimum lead time, in hours, a golfer must give before a bookable slot. Must be non-negative when present. Not enforced by any RPC in CM1 — informational only until a later phase.';
comment on column public.coach_profiles.cancellation_policy_summary is
  'Free-text, coach-authored summary of their cancellation policy, shown on the public profile in a later phase.';
comment on column public.coach_profiles.hourly_rate is
  'Legacy/default informational rate only. Marketplace transaction pricing lives exclusively on coach_services.price_amount_minor (integer minor units) — hourly_rate is never read as the source of truth for a booking''s price and is never written to by any booking flow.';

-- Constraints on the new columns, wrapped so re-running this file never
-- errors on an already-existing constraint (matches supabase-schema-v4.sql).
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
end $$;

-- Uniqueness for public_slug, enforced only when non-null (a coach who has
-- never set a slug does not collide with every other un-slugged coach).
create unique index if not exists idx_coach_profiles_public_slug_unique
  on public.coach_profiles (public_slug)
  where public_slug is not null;

-- ============================================================================
-- B. CREATE public.coach_services — bookable service catalog
-- ============================================================================

create table if not exists public.coach_services (
  id                  uuid        primary key default gen_random_uuid(),
  coach_profile_id    uuid        not null references public.coach_profiles(id) on delete cascade,
  title               text        not null,
  description         text,
  delivery_mode       text        not null check (delivery_mode in ('in_person', 'remote', 'hybrid')),
  -- Positive and reasonably bounded: 1 minute .. 8 hours.
  duration_minutes    integer     not null check (duration_minutes > 0 and duration_minutes <= 480),
  -- Integer minor units only (e.g. cents) — never numeric/decimal dollars.
  price_amount_minor  integer     not null check (price_amount_minor >= 0),
  currency_code       text        not null check (currency_code ~ '^[A-Z]{3}$'),
  -- Defaults false so nothing becomes publicly sellable automatically.
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
-- CM1 creates NO policy on this table. RLS enabled + zero policies = every
-- role (including the table owner querying through PostgREST) is denied by
-- default. See section "RLS AND DEFAULT-DENY SECURITY" below.

-- ============================================================================
-- C. CREATE public.coach_locations — privacy-safe location records
-- ============================================================================

create table if not exists public.coach_locations (
  id                     uuid             primary key default gen_random_uuid(),
  coach_profile_id       uuid             not null references public.coach_profiles(id) on delete cascade,
  -- Private/internal label only (e.g. "Home range bay 3") — never exposed
  -- through public.coach_rating_summary or any future public view.
  private_location_name  text,
  -- Coarse, coach-authored public label (e.g. "North Denver driving range").
  public_location_label  text,
  city                   text,
  region                 text,
  -- Prefix only (e.g. "802"), never a full postal code tied to an exact address.
  postal_code_prefix     text,
  latitude               double precision check (latitude  is null or (latitude  >= -90  and latitude  <= 90)),
  longitude              double precision check (longitude is null or (longitude >= -180 and longitude <= 180)),
  service_radius_miles   numeric          check (service_radius_miles is null or service_radius_miles > 0),
  is_active              boolean          not null default false,
  created_at             timestamptz      not null default now(),
  updated_at             timestamptz      not null default now(),
  -- Latitude and longitude are both present or both absent — never a
  -- half-populated coordinate pair.
  constraint coach_locations_lat_long_paired check ((latitude is null) = (longitude is null))
);

comment on table  public.coach_locations is
  'Privacy-safe coach location records (CM1 foundation — no PostGIS, no public exposure). No street-address field exists by design. A privacy-safe RPC or view becomes the only public nearby-search boundary in CM3 — coordinates and private_location_name are never selected from that boundary.';
comment on column public.coach_locations.private_location_name is
  'Internal-only label. MUST NEVER be exposed through public.coach_rating_summary or any future public-facing view/RPC.';
comment on column public.coach_locations.latitude is
  'Constrained to [-90, 90]. Never exposed publicly in CM1 — no public view selects this column.';
comment on column public.coach_locations.longitude is
  'Constrained to [-180, 180]. Never exposed publicly in CM1 — no public view selects this column.';
comment on column public.coach_locations.service_radius_miles is
  'Positive when present. No PostGIS extension is required or added in CM1; distance search is deferred to CM3.';

create index if not exists idx_coach_locations_coach_profile_id on public.coach_locations (coach_profile_id);

alter table public.coach_locations enable row level security;
-- CM1 creates NO policy on this table (default-deny).

-- ============================================================================
-- D. CREATE public.coach_availability_rules — recurring weekly availability
-- ============================================================================

create table if not exists public.coach_availability_rules (
  id                uuid        primary key default gen_random_uuid(),
  coach_profile_id  uuid        not null references public.coach_profiles(id) on delete cascade,
  -- 0 = Sunday .. 6 = Saturday.
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
  'IANA timezone identifier this rule''s local_start_time/local_end_time are interpreted in. Stored explicitly per-rule (not inherited implicitly) to remain correct if a coach later changes coach_profiles.timezone.';

create index if not exists idx_coach_availability_rules_coach_profile_id on public.coach_availability_rules (coach_profile_id);

alter table public.coach_availability_rules enable row level security;
-- CM1 creates NO policy on this table (default-deny).

-- ============================================================================
-- E. CREATE public.coach_availability_exceptions — one-off overrides
-- ============================================================================

create table if not exists public.coach_availability_exceptions (
  id                      uuid        primary key default gen_random_uuid(),
  coach_profile_id        uuid        not null references public.coach_profiles(id) on delete cascade,
  starts_at               timestamptz not null,
  ends_at                 timestamptz not null,
  -- true = explicitly available during this window (overrides an otherwise
  -- unavailable period); false = explicitly blocked (overrides a recurring
  -- availability rule that would otherwise apply).
  is_available_override   boolean     not null default false,
  -- Internal-only note. Never part of any public view.
  internal_note           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint coach_availability_exceptions_end_after_start check (ends_at > starts_at)
);

comment on table  public.coach_availability_exceptions is
  'One-off availability overrides layered on top of coach_availability_rules (CM1 foundation — no calendar integration is added in CM1).';
comment on column public.coach_availability_exceptions.internal_note is
  'Internal-only note (e.g. reason for blocking a window). MUST NEVER be part of any public view.';

create index if not exists idx_coach_availability_exceptions_coach_profile_id on public.coach_availability_exceptions (coach_profile_id);
create index if not exists idx_coach_availability_exceptions_window on public.coach_availability_exceptions (coach_profile_id, starts_at, ends_at);

alter table public.coach_availability_exceptions enable row level security;
-- CM1 creates NO policy on this table (default-deny).

-- ============================================================================
-- F. CREATE public.coach_bookings — lesson booking records (no payments)
-- ============================================================================

create table if not exists public.coach_bookings (
  id                            uuid        primary key default gen_random_uuid(),
  golfer_id                     uuid        not null references public.users(id)          on delete restrict,
  coach_profile_id              uuid        not null references public.coach_profiles(id) on delete restrict,
  service_id                    uuid        not null references public.coach_services(id)  on delete restrict,
  location_id                   uuid            references public.coach_locations(id)      on delete set null,
  scheduled_start_at            timestamptz not null,
  scheduled_end_at              timestamptz not null,
  timezone_snapshot             text        not null,
  -- Snapshots below freeze the service's shape at booking time, so a later
  -- edit to coach_services never silently rewrites booking history.
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
  -- Enables the composite FK from coach_reviews below: a review can only
  -- reference a booking together with the EXACT coach_profile_id/golfer_id
  -- that booking actually has, which Postgres enforces structurally rather
  -- than relying solely on trigger logic.
  constraint coach_bookings_id_coach_golfer_unique unique (id, coach_profile_id, golfer_id)
);

comment on table  public.coach_bookings is
  'Lesson booking records (CM1 foundation — NO Stripe checkout/session/payment-intent fields exist here, and no subscription field is reused for booking payments; one-time lesson payments are added in CM6). CM1 creates no operational write policy and no status-transition RPC, so no client can write arbitrary status transitions.';
comment on column public.coach_bookings.status is
  'requested | accepted | declined | pending_payment | confirmed | completed | canceled_by_golfer | canceled_by_coach | no_show | refunded. Transitions are not enforced by any RPC in CM1 — see docs/COACH_MARKETPLACE_ROLLOUT.md.';
comment on column public.coach_bookings.gross_amount_minor_snapshot is
  'Integer minor currency units, frozen at booking time from coach_services.price_amount_minor. Never numeric/decimal.';

create index if not exists idx_coach_bookings_golfer_id        on public.coach_bookings (golfer_id);
create index if not exists idx_coach_bookings_coach_profile_id on public.coach_bookings (coach_profile_id);
create index if not exists idx_coach_bookings_service_id       on public.coach_bookings (service_id);
create index if not exists idx_coach_bookings_status           on public.coach_bookings (coach_profile_id, status);

alter table public.coach_bookings enable row level security;
-- CM1 creates NO policy on this table (default-deny).

-- ============================================================================
-- G. CREATE public.coach_reviews — completed-booking-linked reviews
-- ============================================================================

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
  -- Exactly one review per booking.
  constraint coach_reviews_booking_id_unique unique (booking_id),
  -- Structural identity match: booking_id/coach_profile_id/golfer_id must
  -- refer to the SAME row in coach_bookings — a review can never be
  -- attached to a coach or golfer other than the ones on its own booking.
  constraint coach_reviews_booking_identity_fk
    foreign key (booking_id, coach_profile_id, golfer_id)
    references public.coach_bookings (id, coach_profile_id, golfer_id)
    on delete restrict
);

comment on table  public.coach_reviews is
  'Completed-booking-linked coach reviews (CM1 foundation). Every review is structurally tied to exactly one booking via a composite foreign key AND validated by a BEFORE INSERT/UPDATE trigger that the referenced booking has status = completed. No anonymous review policy exists — CM1 creates no policy at all on this table.';
comment on column public.coach_reviews.moderation_status is
  'pending | approved | rejected | hidden. Only approved reviews are aggregated into public.coach_rating_summary.';
comment on constraint coach_reviews_booking_identity_fk on public.coach_reviews is
  'Composite FK requires (booking_id, coach_profile_id, golfer_id) to match a single coach_bookings row exactly — prevents a review from being attached to a different coach or golfer than the booking it references.';

create index if not exists idx_coach_reviews_coach_profile_id on public.coach_reviews (coach_profile_id);
create index if not exists idx_coach_reviews_golfer_id        on public.coach_reviews (golfer_id);
create index if not exists idx_coach_reviews_moderation_status on public.coach_reviews (coach_profile_id, moderation_status);

alter table public.coach_reviews enable row level security;
-- CM1 creates NO policy on this table (default-deny). Note: because there
-- is no INSERT policy in CM1, no client role can insert a review at all
-- yet — the trigger below is a structural safeguard for when an
-- operational INSERT policy is added in a later phase, not a substitute
-- for RLS in CM1 itself.

-- Trigger function: a review may only be inserted, or have its
-- booking_id/coach_profile_id/golfer_id materially reassigned, when the
-- referenced booking's status is 'completed'. SECURITY INVOKER (the
-- default — stated explicitly here for clarity): this function runs with
-- the privileges of whichever role performs the INSERT/UPDATE, never with
-- elevated owner privileges, so it can never be used to read or infer
-- coach_bookings rows a caller would not otherwise be permitted to see.
-- SET search_path = '' additionally locks name resolution inside this
-- function to nothing: with an empty search_path, every unqualified
-- relation reference would fail to resolve at all, so the function is only
-- correct because every relation it touches (public.coach_bookings) is
-- already explicitly schema-qualified. This closes off search_path
-- hijacking as a vector entirely, on top of SECURITY INVOKER already
-- preventing privilege elevation — it does not elevate the caller's
-- privileges or bypass RLS.
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

  -- Redundant with coach_reviews_booking_identity_fk by design (defense in
  -- depth with a clearer error message) — a golfer may never review a
  -- different coach's booking, nor may a review be reassigned to a
  -- mismatched coach/golfer pair.
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
  'BEFORE INSERT/UPDATE trigger function for coach_reviews. SECURITY INVOKER (not SECURITY DEFINER) — runs with the calling role''s own privileges. SET search_path = '''' — every referenced relation is explicitly public.-qualified, so this cannot be hijacked by a malicious search_path and does not elevate privileges or bypass RLS. Rejects any review not linked to a completed booking, or whose coach_profile_id/golfer_id does not match that booking.';

-- Idempotent trigger creation guard (no DROP TRIGGER — matches this file's
-- no-destructive-statement posture).
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

-- ============================================================================
-- H. CREATE OR REPLACE public.coach_rating_summary — approved-review-only
--    rating read model
-- ============================================================================
--
-- security_invoker is applied when the running Postgres version supports it
-- (PostgreSQL 15+; Supabase projects are generally on 15+, but this guards
-- against an older instance rather than erroring the whole migration).
-- security_invoker makes the view enforce RLS as the QUERYING role rather
-- than the view owner's privileges — the correct, non-privilege-escalating
-- choice for a view over an RLS-protected table.

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
  'Approved-review-only rating read model. Exposes ONLY coach_profile_id and per-category averages/count — never review_body, golfer identity, coach location, coordinates, or internal notes. Not granted to anon or authenticated in CM1 (see REVOKE statements below). There is no client-writable rating aggregate anywhere in this schema.';

-- ============================================================================
-- I. Default-deny hardening — explicit REVOKE on every new object
-- ============================================================================
--
-- RLS-enabled tables with zero policies already deny all row access by
-- default. These REVOKE statements additionally strip any table/view-level
-- privilege the anon/authenticated roles might otherwise hold via default
-- PostgreSQL privileges on the public schema, as an explicit, defense-in-
-- depth statement of intent. Only the seven new objects below are touched —
-- no existing table's privileges are revoked or altered.
revoke all on public.coach_services               from anon, authenticated;
revoke all on public.coach_locations               from anon, authenticated;
revoke all on public.coach_availability_rules      from anon, authenticated;
revoke all on public.coach_availability_exceptions from anon, authenticated;
revoke all on public.coach_bookings                from anon, authenticated;
revoke all on public.coach_reviews                 from anon, authenticated;
revoke all on public.coach_rating_summary          from anon, authenticated;

commit;

-- ============================================================================
-- Deferred to later phases (see docs/COACH_MARKETPLACE_ROLLOUT.md):
--   - Operational RLS policies (owner-write, public-read-when-published,
--     admin) for every table created above.
--   - Status-transition RPCs for coach_bookings (requested -> accepted ->
--     confirmed -> completed, cancellation paths).
--   - Privacy-safe nearby-search RPC/view (CM3) — coach_locations.latitude/
--     longitude/private_location_name remain unexposed until then.
--   - Stripe Connect account linkage, one-time lesson payments, platform
--     commissions, payouts, refunds, disputes (CM6).
