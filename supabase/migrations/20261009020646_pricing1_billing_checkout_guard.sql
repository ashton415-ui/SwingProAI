-- ============================================================================
-- PRICING-1 — billing checkout guard: one trial per account, one checkout at a
-- time, one current subscription per row
-- ============================================================================
--
-- What this migration adds
-- ------------------------
-- 1. public.billing_checkout_guard — a private, server-only row per golfer
--    holding durable trial history (trial_used_at, trial_subscription_id) and
--    the single in-flight checkout claim (token, acquired/expiry times, the
--    attached Stripe Checkout Session id). It stores no price, tier, email,
--    name or browser state. RLS is enabled with no policy, and browser roles
--    hold no privilege at all; service_role holds SELECT, INSERT and UPDATE.
--
-- 2. users_stripe_subscription_id_key — a partial unique index making the
--    bound Stripe subscription id the row's current-subscription identity.
--
-- 3. Six SECURITY INVOKER functions with an empty search_path, executable by
--    service_role only:
--
--      billing_begin_checkout            claim, or report the held claim
--      billing_takeover_checkout         compare-and-swap a stale claim
--      billing_link_checkout_customer    link a Stripe customer for the
--                                        current claim only
--      billing_attach_checkout_session   bind the created Session to a claim
--      billing_release_checkout          release by exact token only
--      billing_apply_subscription_state  the single atomic webhook writer
--
--    Every one locks the public.users row first and the guard row second, so
--    the family has one lock order and cannot deadlock against itself.
--
-- Backward compatibility
-- ----------------------
-- The currently deployed application never reads the guard table or calls
-- these functions, and never writes stripe_subscription_id, so applying this
-- migration ahead of the new application changes nothing it depends on. No
-- existing column, constraint, policy or grant is removed or weakened.
--
-- What this migration does NOT do
-- -------------------------------
-- It does not touch public.users privileges or policies (DELETE/TRUNCATE
-- hardening is a separate workstream), adds no column to public.users,
-- creates no trigger and rewrites no row.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed on a divergent database rather than adapting to it.

do $preflight$
begin
  if (select count(*) from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'PRICING1-PRE-1: the anon, authenticated and service_role roles must all exist.';
  end if;

  -- The functions run as their caller and the guard table has no policy, so
  -- service_role must bypass row level security or every call would see
  -- nothing.
  if not (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = 'service_role') then
    raise exception 'PRICING1-PRE-2: service_role must bypass row level security.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.users'::regclass
       and a.attname = 'stripe_subscription_id'
       and a.atttypid = 'text'::regtype
       and not a.attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.users'::regclass
       and a.attname = 'id'
       and a.atttypid = 'uuid'::regtype
       and not a.attisdropped
  ) then
    raise exception 'PRICING1-PRE-3: public.users must carry id uuid and stripe_subscription_id text.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('billing_checkout_guard', 'users_stripe_subscription_id_key')
  ) then
    raise exception 'PRICING1-PRE-4: a billing guard relation already exists; refusing to adapt to it.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'billing\_%'
  ) then
    raise exception 'PRICING1-PRE-5: a public billing_ function already exists; refusing to adapt to it.';
  end if;

  if exists (
    select 1 from public.users u
     where u.stripe_subscription_id is not null
     group by u.stripe_subscription_id
    having count(*) > 1
  ) then
    raise exception 'PRICING1-PRE-6: a Stripe subscription id is bound to more than one profile.';
  end if;
end;
$preflight$;

-- ── Guard table ─────────────────────────────────────────────────────────────

create table public.billing_checkout_guard (
  user_id uuid not null
    constraint billing_checkout_guard_pkey primary key
    constraint billing_checkout_guard_user_id_fkey
      references public.users (id) on delete cascade,
  trial_used_at timestamptz,
  trial_subscription_id text,
  claim_token uuid,
  claim_acquired_at timestamptz,
  claim_expires_at timestamptz,
  claim_session_id text,
  updated_at timestamptz not null default now(),

  -- No claim: every claim field empty. A claim: token and both times present,
  -- with the expiry strictly after acquisition.
  constraint billing_checkout_guard_claim_shape_check check (
    (claim_token is null
       and claim_acquired_at is null
       and claim_expires_at is null
       and claim_session_id is null)
    or
    (claim_token is not null
       and claim_acquired_at is not null
       and claim_expires_at is not null
       and claim_expires_at > claim_acquired_at)
  ),
  constraint billing_checkout_guard_claim_session_check check (
    claim_session_id is null or length(claim_session_id) > 0
  ),
  -- A recorded trial subscription implies a recorded trial time.
  constraint billing_checkout_guard_trial_check check (
    trial_subscription_id is null or trial_used_at is not null
  ),
  constraint billing_checkout_guard_trial_subscription_check check (
    trial_subscription_id is null or length(trial_subscription_id) > 0
  )
);

alter table public.billing_checkout_guard enable row level security;

-- No browser access of any kind, and service_role only what the functions use.
revoke all on table public.billing_checkout_guard from public;
revoke all on table public.billing_checkout_guard from anon;
revoke all on table public.billing_checkout_guard from authenticated;
revoke all on table public.billing_checkout_guard from service_role;
grant select, insert, update on table public.billing_checkout_guard to service_role;

-- ── Current subscription identity ───────────────────────────────────────────

create unique index users_stripe_subscription_id_key
  on public.users (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- ── billing_begin_checkout ──────────────────────────────────────────────────
-- Locks the profile, decides local purchase eligibility, then claims. An
-- existing claim is never overwritten, expired or not: it is returned as held
-- so the caller can run the recovery state machine.

create function public.billing_begin_checkout(
  p_user_id uuid,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_subscription_id text;
  v_status text;
  v_token uuid;
  v_acquired timestamptz;
  v_expires timestamptz;
  v_session text;
  v_trial_used timestamptz;
  v_customer_id text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_user_id is null then
    raise exception 'PRICING1-BEGIN-1: user is required.' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 1800 or p_ttl_seconds > 3600 then
    raise exception 'PRICING1-BEGIN-2: claim ttl must be 1800 to 3600 seconds.' using errcode = '22023';
  end if;

  -- 1. users first. The durable customer is read under the same lock, so a
  -- successful claim carries the customer authority it was decided with.
  select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id
    into v_subscription_id, v_status, v_customer_id
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  -- Only an unbound row whose status is none or canceled may buy. Anything
  -- else, including an unknown status, is blocked and creates no claim.
  if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then
    return pg_catalog.jsonb_build_object('outcome', 'blocked');
  end if;

  -- 2. guard second.
  insert into public.billing_checkout_guard (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select g.claim_token, g.claim_acquired_at, g.claim_expires_at, g.claim_session_id, g.trial_used_at
    into v_token, v_acquired, v_expires, v_session, v_trial_used
    from public.billing_checkout_guard g
   where g.user_id = p_user_id
     for update;

  if v_token is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'held',
      'claim_token', v_token,
      'claim_acquired_at', v_acquired,
      'claim_expires_at', v_expires,
      'claim_age_seconds', extract(epoch from (v_now - v_acquired)),
      'claim_remaining_seconds', extract(epoch from (v_expires - v_now)),
      'held_session_id', v_session,
      'trial_used', v_trial_used is not null
    );
  end if;

  v_token := pg_catalog.gen_random_uuid();
  v_acquired := v_now;
  v_expires := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  update public.billing_checkout_guard g
     set claim_token = v_token,
         claim_acquired_at = v_acquired,
         claim_expires_at = v_expires,
         claim_session_id = null,
         updated_at = v_now
   where g.user_id = p_user_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'claim_token', v_token,
    'claim_acquired_at', v_acquired,
    'claim_expires_at', v_expires,
    'claim_age_seconds', 0,
    'claim_remaining_seconds', p_ttl_seconds,
    'held_session_id', null,
    'trial_used', v_trial_used is not null,
    'stripe_customer_id', v_customer_id
  );
end;
$function$;

-- ── billing_takeover_checkout ───────────────────────────────────────────────
-- Compare-and-swap: replaces the claim only if the exact old token and the
-- exact attached Session (NULL-safe) are still current. An unattached claim
-- must be at least 180 seconds old by claim_acquired_at. With an attached
-- Session the caller has already proved that Session expired at Stripe.

create function public.billing_takeover_checkout(
  p_user_id uuid,
  p_old_claim_token uuid,
  p_expected_session_id text,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_subscription_id text;
  v_status text;
  v_token uuid;
  v_acquired timestamptz;
  v_session text;
  v_trial_used timestamptz;
  v_new_token uuid;
  v_expires timestamptz;
  v_customer_id text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_user_id is null or p_old_claim_token is null then
    raise exception 'PRICING1-TAKEOVER-1: user and old claim token are required.' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 1800 or p_ttl_seconds > 3600 then
    raise exception 'PRICING1-TAKEOVER-2: claim ttl must be 1800 to 3600 seconds.' using errcode = '22023';
  end if;

  -- 1. users first, reading the durable customer under the same lock.
  select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id
    into v_subscription_id, v_status, v_customer_id
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then
    return pg_catalog.jsonb_build_object('outcome', 'blocked');
  end if;

  -- 2. guard second.
  select g.claim_token, g.claim_acquired_at, g.claim_session_id, g.trial_used_at
    into v_token, v_acquired, v_session, v_trial_used
    from public.billing_checkout_guard g
   where g.user_id = p_user_id
     for update;

  if not found
     or v_token is distinct from p_old_claim_token
     or v_session is distinct from p_expected_session_id then
    return pg_catalog.jsonb_build_object('outcome', 'lost');
  end if;

  if p_expected_session_id is null and v_now - v_acquired < interval '180 seconds' then
    return pg_catalog.jsonb_build_object('outcome', 'lost');
  end if;

  v_new_token := pg_catalog.gen_random_uuid();
  v_expires := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  update public.billing_checkout_guard g
     set claim_token = v_new_token,
         claim_acquired_at = v_now,
         claim_expires_at = v_expires,
         claim_session_id = null,
         updated_at = v_now
   where g.user_id = p_user_id
     and g.claim_token = p_old_claim_token;

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'claim_token', v_new_token,
    'claim_acquired_at', v_now,
    'claim_expires_at', v_expires,
    'claim_age_seconds', 0,
    'claim_remaining_seconds', p_ttl_seconds,
    'held_session_id', null,
    'trial_used', v_trial_used is not null,
    'stripe_customer_id', v_customer_id
  );
end;
$function$;

-- ── billing_link_checkout_customer ──────────────────────────────────────────
-- Links a Stripe customer to the profile, for the CURRENT claim only. A
-- request whose token was superseded gets lost and writes nothing, even when
-- the same customer happens to be linked already. An existing, different
-- customer is never replaced. A customer already linked to another profile
-- violates users_stripe_customer_id_key and rolls the whole call back.
--
--   no profile                                 → not_found
--   bound subscription or status not buyable   → blocked
--   no guard, other token, expired or attached → lost
--   no customer linked                         → write it   → linked
--   the same customer linked                   → no write   → already_linked_same
--   a different customer linked                → no write   → customer_conflict

create function public.billing_link_checkout_customer(
  p_user_id uuid,
  p_claim_token uuid,
  p_stripe_customer_id text
) returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_subscription_id text;
  v_status text;
  v_customer_id text;
  v_token uuid;
  v_expires timestamptz;
  v_session text;
begin
  if p_stripe_customer_id is null or length(p_stripe_customer_id) = 0 then
    raise exception 'PRICING1-LINK-1: a Stripe customer is required.' using errcode = '22023';
  end if;

  -- 1. users first.
  select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id
    into v_subscription_id, v_status, v_customer_id
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return 'not_found';
  end if;

  if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then
    return 'blocked';
  end if;

  -- 2. guard second. Ownership is proved before the customer is looked at.
  select g.claim_token, g.claim_expires_at, g.claim_session_id
    into v_token, v_expires, v_session
    from public.billing_checkout_guard g
   where g.user_id = p_user_id
     for update;

  if not found
     or p_claim_token is null
     or v_token is distinct from p_claim_token
     or v_expires is null
     or v_expires <= pg_catalog.now()
     or v_session is not null then
    return 'lost';
  end if;

  if v_customer_id is null then
    update public.users u
       set stripe_customer_id = p_stripe_customer_id
     where u.id = p_user_id;
    return 'linked';
  end if;

  if v_customer_id = p_stripe_customer_id then
    return 'already_linked_same';
  end if;

  return 'customer_conflict';
end;
$function$;

-- ── billing_attach_checkout_session ─────────────────────────────────────────
-- Binds exactly one created Checkout Session to the current, unexpired,
-- not-yet-attached claim, while the row is still eligible to buy.

create function public.billing_attach_checkout_session(
  p_user_id uuid,
  p_claim_token uuid,
  p_session_id text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_subscription_id text;
  v_status text;
begin
  if p_user_id is null or p_claim_token is null or p_session_id is null or length(p_session_id) = 0 then
    return false;
  end if;

  -- 1. users first.
  select u.stripe_subscription_id, u.subscription_status
    into v_subscription_id, v_status
    from public.users u
   where u.id = p_user_id
     for update;

  if not found
     or v_subscription_id is not null
     or v_status is null
     or v_status not in ('none', 'canceled') then
    return false;
  end if;

  -- 2. guard second.
  update public.billing_checkout_guard g
     set claim_session_id = p_session_id,
         updated_at = pg_catalog.now()
   where g.user_id = p_user_id
     and g.claim_token = p_claim_token
     and g.claim_session_id is null
     and g.claim_expires_at > pg_catalog.now();

  return found;
end;
$function$;

-- ── billing_release_checkout ────────────────────────────────────────────────
-- Clears the claim only for the exact token presented. A stale token is a
-- no-op, and trial history is never touched.

create function public.billing_release_checkout(
  p_user_id uuid,
  p_claim_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_user_id is null or p_claim_token is null then
    return false;
  end if;

  -- 1. users first, even though release reads nothing from it: one lock
  -- order for the whole family.
  perform 1
     from public.users u
    where u.id = p_user_id
      for update;

  if not found then
    return false;
  end if;

  -- 2. guard second.
  update public.billing_checkout_guard g
     set claim_token = null,
         claim_acquired_at = null,
         claim_expires_at = null,
         claim_session_id = null,
         updated_at = pg_catalog.now()
   where g.user_id = p_user_id
     and g.claim_token = p_claim_token;

  return found;
end;
$function$;

-- ── billing_apply_subscription_state ────────────────────────────────────────
-- The single atomic webhook writer. One transaction locks the profile by its
-- Stripe customer, enforces subscription identity, writes normalized status
-- and server-derived tier, binds or clears the subscription id, records trial
-- usage monotonically, and clears a claim only for an exact non-NULL token.
--
--   nonterminal, unbound or same id   → bind, write         → applied
--   nonterminal, different bound id   → no write            → conflict
--   terminal, same bound id           → canceled/none, clear → applied
--   terminal, different bound id      → no write            → stale_terminal
--   terminal, unbound, not allowed    → no write            → unbound_terminal_recheck
--   terminal, unbound, allowed        → canceled/none       → applied
--   no profile for the customer       → no write            → not_found

create function public.billing_apply_subscription_state(
  p_stripe_customer_id text,
  p_claim_token uuid,
  p_subscription_id text,
  p_subscription_status text,
  p_subscription_tier text,
  p_trial_received boolean,
  p_allow_unbound_terminal boolean
) returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_bound text;
  v_now timestamptz := pg_catalog.now();
begin
  if p_stripe_customer_id is null or length(p_stripe_customer_id) = 0
     or p_subscription_id is null or length(p_subscription_id) = 0 then
    raise exception 'PRICING1-APPLY-1: customer and subscription are required.' using errcode = '22023';
  end if;
  if p_subscription_status is null
     or p_subscription_status not in ('active', 'trialing', 'past_due', 'canceled', 'none') then
    raise exception 'PRICING1-APPLY-2: unknown subscription status.' using errcode = '22023';
  end if;
  if p_subscription_tier is null
     or p_subscription_tier not in ('par', 'birdie', 'eagle', 'none') then
    raise exception 'PRICING1-APPLY-3: unknown subscription tier.' using errcode = '22023';
  end if;
  if p_trial_received is null or p_allow_unbound_terminal is null then
    raise exception 'PRICING1-APPLY-4: trial and unbound-terminal flags are required.' using errcode = '22023';
  end if;

  -- 1. users first. stripe_customer_id is unique, so at most one row.
  select u.id, u.stripe_subscription_id
    into v_user_id, v_bound
    from public.users u
   where u.stripe_customer_id = p_stripe_customer_id
     for update;

  if not found then
    return 'not_found';
  end if;

  if p_subscription_status <> 'canceled' then
    if v_bound is not null and v_bound <> p_subscription_id then
      return 'conflict';
    end if;

    update public.users u
       set subscription_status = p_subscription_status,
           subscription_tier = p_subscription_tier,
           stripe_subscription_id = p_subscription_id
     where u.id = v_user_id;
  else
    if v_bound is not null and v_bound <> p_subscription_id then
      return 'stale_terminal';
    end if;

    if v_bound is null and not p_allow_unbound_terminal then
      return 'unbound_terminal_recheck';
    end if;

    -- A terminal state never entitles: tier is none whatever was passed.
    update public.users u
       set subscription_status = 'canceled',
           subscription_tier = 'none',
           stripe_subscription_id = null
     where u.id = v_user_id;
  end if;

  -- 2. guard second.
  insert into public.billing_checkout_guard (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  perform 1
     from public.billing_checkout_guard g
    where g.user_id = v_user_id
      for update;

  -- Trial history only ever fills in; the first trial subscription sticks.
  if p_trial_received then
    update public.billing_checkout_guard g
       set trial_used_at = coalesce(g.trial_used_at, v_now),
           trial_subscription_id = coalesce(g.trial_subscription_id, p_subscription_id),
           updated_at = v_now
     where g.user_id = v_user_id;
  end if;

  -- A NULL token never clears a claim; a non-NULL one clears only its own.
  if p_claim_token is not null then
    update public.billing_checkout_guard g
       set claim_token = null,
           claim_acquired_at = null,
           claim_expires_at = null,
           claim_session_id = null,
           updated_at = v_now
     where g.user_id = v_user_id
       and g.claim_token = p_claim_token;
  end if;

  return 'applied';
end;
$function$;

-- ── Execute privileges ──────────────────────────────────────────────────────

revoke execute on function public.billing_begin_checkout(uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.billing_takeover_checkout(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke execute on function public.billing_link_checkout_customer(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.billing_attach_checkout_session(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.billing_release_checkout(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.billing_apply_subscription_state(text, uuid, text, text, text, boolean, boolean)
  from public, anon, authenticated;

grant execute on function public.billing_begin_checkout(uuid, integer) to service_role;
grant execute on function public.billing_takeover_checkout(uuid, uuid, text, integer) to service_role;
grant execute on function public.billing_link_checkout_customer(uuid, uuid, text) to service_role;
grant execute on function public.billing_attach_checkout_session(uuid, uuid, text) to service_role;
grant execute on function public.billing_release_checkout(uuid, uuid) to service_role;
grant execute on function public.billing_apply_subscription_state(text, uuid, text, text, text, boolean, boolean)
  to service_role;

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the resulting state rather than assuming the statements above had
-- the intended effect.

do $postflight$
declare
  fns regprocedure[] := array[
    'public.billing_begin_checkout(uuid, integer)'::regprocedure,
    'public.billing_takeover_checkout(uuid, uuid, text, integer)'::regprocedure,
    'public.billing_link_checkout_customer(uuid, uuid, text)'::regprocedure,
    'public.billing_attach_checkout_session(uuid, uuid, text)'::regprocedure,
    'public.billing_release_checkout(uuid, uuid)'::regprocedure,
    'public.billing_apply_subscription_state(text, uuid, text, text, text, boolean, boolean)'::regprocedure
  ];
  fn regprocedure;
  browser text;
  priv text;
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'public.billing_checkout_guard'::regclass) then
    raise exception 'PRICING1-POST-1: row level security is not enabled on public.billing_checkout_guard.';
  end if;

  if exists (select 1 from pg_catalog.pg_policy p
              where p.polrelid = 'public.billing_checkout_guard'::regclass) then
    raise exception 'PRICING1-POST-2: public.billing_checkout_guard must carry no policy.';
  end if;

  foreach browser in array array['anon', 'authenticated'] loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege(browser, 'public.billing_checkout_guard', priv) then
        raise exception 'PRICING1-POST-3: % holds % on public.billing_checkout_guard.', browser, priv;
      end if;
    end loop;
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege(browser, 'public.billing_checkout_guard', priv) then
        raise exception 'PRICING1-POST-4: % holds column-level % on public.billing_checkout_guard.', browser, priv;
      end if;
    end loop;
  end loop;

  foreach priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
    if not pg_catalog.has_table_privilege('service_role', 'public.billing_checkout_guard', priv) then
      raise exception 'PRICING1-POST-5: service_role must hold % on public.billing_checkout_guard.', priv;
    end if;
  end loop;

  foreach priv in array array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if pg_catalog.has_table_privilege('service_role', 'public.billing_checkout_guard', priv) then
      raise exception 'PRICING1-POST-6: service_role holds unneeded % on public.billing_checkout_guard.', priv;
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_index i
      join pg_catalog.pg_class c on c.oid = i.indexrelid
     where c.relname = 'users_stripe_subscription_id_key'
       and i.indrelid = 'public.users'::regclass
       and i.indisunique
       and i.indpred is not null
  ) then
    raise exception 'PRICING1-POST-7: the partial unique stripe_subscription_id index is missing.';
  end if;

  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'billing\_%') <> 6 then
    raise exception 'PRICING1-POST-8: exactly six public billing_ functions must exist.';
  end if;

  foreach fn in array fns loop
    if exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = fn
         and (p.prosecdef or p.proconfig is distinct from array['search_path=""']::text[])
    ) then
      raise exception 'PRICING1-POST-9: % must be SECURITY INVOKER with an empty search_path.', fn;
    end if;

    if pg_catalog.has_function_privilege('anon', fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'PRICING1-POST-10: a browser role can execute %.', fn;
    end if;

    if exists (
      select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(p.proacl) as x
       where p.oid = fn and x.grantee = 0
    ) or (select p.proacl is null from pg_catalog.pg_proc p where p.oid = fn) then
      raise exception 'PRICING1-POST-11: PUBLIC can execute %.', fn;
    end if;

    if not pg_catalog.has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception 'PRICING1-POST-12: service_role must be able to execute %.', fn;
    end if;
  end loop;
end;
$postflight$;

commit;
