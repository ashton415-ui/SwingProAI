# Coach Marketplace Rollout

This document describes the phased rollout of the Coach Marketplace feature
and the current state of **CM1 — Foundation**.

## What CM1 is

CM1 is an additive, unapplied, invisible, feature-flagged-off foundation.
Concretely:

- **Additive**: every schema change is a new column (with a nullable type
  or a safe constant default) or a brand-new table. Nothing existing is
  dropped, renamed, retyped, or destructively rewritten.
- **Unapplied**: `supabase-schema-v6.sql` ships as source only. CM1 does not
  run this file against any Supabase project. Applying it is a distinct,
  later, human-initiated action — see "Mandatory live-schema reconciliation
  before applying v6" below.
- **Invisible**: CM1 adds no page, no navigation entry, no button, no form,
  and no API/RPC call site anywhere in the application. There is nothing
  for a user — golfer, coach, or admin — to see or click.
- **Feature-flagged off**: `COACH_MARKETPLACE_ENABLED` defaults to `false`
  (see `.env.example`). Even if a future phase wires marketplace UI behind
  this flag, the flag itself ships disabled.

### The root application remains canonical

All CM1 work targets the repository root application (`app/`, `components/`,
`lib/`, `types/`, `utils/`) — the deployed Vercel production app. This is
the same tree the existing coach portal (`app/(dashboard)/coach/...`),
golfer↔coach relationships, coach feedback, lesson plans, and Stripe
subscription flows already live in.

**`swingmaster-web/` is not modified by this rollout.** It is a separate,
secondary Capacitor mobile-wrapper build with its own divergent schema
assumptions (`coach_student_relationships`, not `coach_golfer_relationships`)
and no Stripe integration. CM1 does not touch it, does not port its
invite-code flow, and does not attempt to reconcile the two trees' coach
data models. That reconciliation, if ever needed, is out of scope for the
Coach Marketplace effort entirely.

### Existing systems remain canonical and unchanged

CM1 does not modify:

- the existing coach portal pages (`coach/page.tsx`, `coach/golfers/page.tsx`,
  `coach/lesson-plans/page.tsx`, `coach/reviews/page.tsx`);
- `coach_golfer_relationships` (the golfer↔coach pairing mechanism);
- `coach_feedback` (coach-reviews-golfer's-swing notes — unrelated to the
  new golfer-reviews-coach `coach_reviews` table);
- `lesson_plans` (curriculum/goals objects — unrelated to the new
  time-slotted `coach_bookings` table);
- `subscriptions` state (still columns on `users`, still governed by
  `lib/entitlements.ts`);
- the existing Stripe subscription checkout route
  (`app/api/stripe/checkout/route.ts`) or webhook
  (`app/api/webhooks/stripe/route.ts`).

`coach_starter`/`coach_pro` remain exactly what they already were: golfer-
analysis subscription SKUs a coach can buy for their own account. CM1
introduces no new meaning for those tier names and no marketplace-access
entitlement layer riding on them.

## Data ownership

| Table | Owned/authored by |
|---|---|
| `coach_profiles` (extended) | The coach (existing table; CM1 adds marketplace columns only) |
| `coach_services` | The coach who owns the parent `coach_profiles` row |
| `coach_locations` | The coach who owns the parent `coach_profiles` row |
| `coach_availability_rules` | The coach who owns the parent `coach_profiles` row |
| `coach_availability_exceptions` | The coach who owns the parent `coach_profiles` row |
| `coach_bookings` | Jointly referenced by the golfer (`golfer_id`) and the coach (`coach_profile_id`); written by neither directly in CM1 — see "Why arbitrary transitions are denied in CM1" |
| `coach_reviews` | The golfer who completed the linked booking (`golfer_id`), reviewing the coach on that booking (`coach_profile_id`) |
| `coach_rating_summary` (view) | Derived only — owned by no one, written by no one |

## Profile visibility and verification states

`coach_profiles.marketplace_visibility_status` (`hidden | draft | published |
suspended`) and `coach_profiles.verification_status` (`unverified | pending
| verified | rejected | suspended`) are **independent** axes. A profile can
be `published` and `unverified` at the same time, or `hidden` and
`verified`. Neither state has any effect in CM1 — no query anywhere reads
either column, and no RLS policy exists that would ever expose a
`published` profile publicly. These columns exist so a later phase (CM2) has
somewhere to record the decision without a further migration.

## Service pricing

`coach_services.price_amount_minor` is an **integer**, in minor currency
units (e.g. USD cents), paired with `coach_services.currency_code` (exactly
three uppercase letters, e.g. `USD`). This is the marketplace transaction
source of truth. `coach_bookings` freezes a snapshot of this price at
booking time (`gross_amount_minor_snapshot`, `currency_code_snapshot`) so a
later edit to a service's price never silently rewrites a past booking's
recorded price.

**`coach_profiles.hourly_rate` is legacy/default informational data only.**
It predates CM1, is not read by any query in the app today, and is never
read as the source of truth for a booking's price by anything CM1
introduces. It is retained unchanged, purely to avoid a destructive column
drop.

## Location privacy

`coach_locations` has **no street-address field**, by design — only
`city`, `region`, and `postal_code_prefix` (a prefix like `"802"`, never a
full postal code tied to an exact address). `private_location_name` is
explicitly internal-only.

`latitude`/`longitude` are constrained to valid ranges ([-90, 90] /
[-180, 180]) and must either both be present or both be null. **They are
never exposed publicly in CM1** — no view, RPC, or query selects them for
any client-facing purpose, and `public.coach_rating_summary` (the only
public-adjacent read model CM1 creates) does not include the
`coach_locations` table at all.

**Future CM3 nearby-search RPC/view boundary**: distance/nearby search is
explicitly deferred to CM3. When it ships, it will be a dedicated,
privacy-safe RPC or view that computes and returns only what a searcher
needs (e.g. an approximate distance or a coarse match), and that boundary —
not raw `SELECT` access to `coach_locations` — will be the *only* way any
client ever learns anything about a coach's location. `latitude`,
`longitude`, and `private_location_name` must never be selected by that
boundary either. CM1 requires no PostGIS extension; whether CM3 needs one is
a decision for that phase.

## Booking lifecycle

`coach_bookings.status` is constrained to exactly: `requested`, `accepted`,
`declined`, `pending_payment`, `confirmed`, `completed`, `canceled_by_golfer`,
`canceled_by_coach`, `no_show`, `refunded`.

### Why arbitrary transitions are denied in CM1

CM1 creates **no** status-transition RPC and **no** operational RLS policy
of any kind on `coach_bookings`. Combined with Row Level Security being
enabled on the table with zero policies, this means **no client role —
golfer, coach, or otherwise — can write to `coach_bookings` at all** in
CM1's current state, let alone move a booking through an arbitrary sequence
of statuses. This is intentional: booking-state transitions are exactly the
kind of business logic (who is allowed to move a booking from `requested`
to `accepted`? can a golfer un-cancel? what happens to a `pending_payment`
booking that times out?) that deserves a dedicated, reviewed RPC in a later
phase (CM4), not an open `UPDATE` policy that trusts client-supplied status
values.

## Completed-booking, verified-review rule

A row in `coach_reviews` may only be inserted — or have its `booking_id`,
`coach_profile_id`, or `golfer_id` reassigned — when the referenced
`coach_bookings` row has `status = 'completed'`. This is enforced two ways,
deliberately redundant:

1. **Structurally**, via a composite foreign key
   (`coach_reviews.(booking_id, coach_profile_id, golfer_id)` references
   `coach_bookings.(id, coach_profile_id, golfer_id)`) — a review can never
   reference a booking together with a coach or golfer ID that doesn't
   actually match that booking.
2. **Procedurally**, via a `BEFORE INSERT OR UPDATE` trigger
   (`fn_enforce_coach_review_completed_booking`) that additionally checks
   the booking's `status`. The function is declared `SECURITY INVOKER` (the
   default, stated explicitly for clarity) — it runs with the privileges of
   whichever role performs the write, never with elevated owner privileges,
   so it can never be used as a side channel to read booking data a caller
   couldn't otherwise see. It also sets `SET search_path = ''`, and every
   relation it references (`public.coach_bookings`) is explicitly
   schema-qualified — name resolution inside the function cannot be
   redirected by a malicious `search_path`, on top of `SECURITY INVOKER`
   already ruling out privilege elevation.

Because there is no INSERT policy on `coach_reviews` in CM1, no client can
actually reach this trigger yet — it is a structural safeguard already in
place for when a later phase adds the operational INSERT policy, so that
policy can be added without also having to design and test this validation
logic at the same time.

### Operational note for the future INSERT-policy phase

`SECURITY INVOKER` means the trigger's `coach_bookings` lookup is evaluated
under the *calling role's own* RLS visibility, not the function owner's —
that is the whole point of choosing `SECURITY INVOKER` over `SECURITY
DEFINER` here (see "Why arbitrary transitions are denied in CM1" above for
the same least-privilege reasoning). The function additionally locks
`SET search_path = ''`, and every relation it touches is written as
`public.coach_bookings`, never a bare, unqualified table name — so this
guarantee holds regardless of any role's or session's `search_path`
setting. A consequence follows: when a later phase adds the operational
`coach_reviews` INSERT policy, the same role it grants INSERT to must also
receive a narrowly scoped `coach_bookings` SELECT policy that permits
seeing the specific completed booking being reviewed. Without that paired
SELECT policy, the trigger cannot see the booking row at all and fails
closed — rejecting even a genuinely completed, valid booking's review with
"referenced booking does not exist." This is a design step to carry out
deliberately alongside that future INSERT policy, not a bug to work around
by switching the trigger to `SECURITY DEFINER` — doing so would let the
trigger read `coach_bookings` rows the caller isn't otherwise permitted to
see, which is exactly the privilege escalation `SECURITY INVOKER` was
chosen to avoid.

## Moderation model

`coach_reviews.moderation_status` is `pending | approved | rejected |
hidden`, defaulting to `pending`. CM1 defines the column and its constraint
only — no moderation UI, RPC, or admin action exists yet. A review's
`coach_response`/`coach_responded_at` fields exist for a future
coach-replies-to-a-review feature, also unimplemented in CM1.

## Rating summary

`public.coach_rating_summary` is a view, **not a table**, and is the *only*
rating read model in this schema. It aggregates exclusively
`moderation_status = 'approved'` rows from `coach_reviews`, grouped by
`coach_profile_id`, exposing only: `coach_profile_id`,
`approved_review_count`, and the five `*_rating_average` columns. It never
selects `review_body`, `golfer_id`, `coach_response`, or anything from
`coach_locations`.

**There is no client-writable rating aggregate anywhere in this schema.**
`coach_profiles` gained no `avg_rating` or `review_count` column — a
coach's rating can only ever be computed live from approved reviews, never
stored and mutated directly. The view uses `security_invoker` when the
running Postgres version supports it (15+), so it enforces RLS as the
querying role rather than the view owner's privileges. It is explicitly
`REVOKE`d from `anon` and `authenticated` in this migration — no role can
query it yet.

## Subscriptions remain separate from lesson transactions

`coach_bookings` has no Stripe checkout/session/payment-intent field of any
kind, and does not reuse `users.stripe_customer_id`,
`users.stripe_subscription_id`, `users.subscription_status`, or
`users.subscription_tier` for anything booking-related. A golfer's
SwingProAI subscription and a golfer's lesson booking are, and will remain,
two entirely separate financial relationships with two entirely separate
data models.

## Future Stripe Connect boundary

**No Stripe execution code of any kind exists in CM1** — not in the
migration, not in `lib/feature-flags.ts`, not in `types/database.ts`. When
Stripe Connect work begins (CM6), it introduces coach-side connected
accounts, one-time lesson payments tied to `coach_bookings`, platform
commissions, payouts, refunds, and dispute handling — all net-new schema
and routes at that time. Nothing in CM1's schema assumes or hardcodes a
particular Connect integration shape; `coach_bookings.gross_amount_minor_snapshot`
is deliberately payment-processor-agnostic (it's just an integer amount a
booking was made for, not a Stripe object reference).

## Production schema-drift risk

This repository has **no tracked base schema**. The four pre-existing
schema files (`supabase-schema-v2.sql` through `v5.sql`) are incremental
`ALTER`/`CREATE`-additive files that assume an untracked base
`supabase-schema.sql` — which does not exist anywhere in this repository —
already created `users`, `coach_profiles`, `coach_golfer_relationships`,
`coach_feedback`, and `lesson_plans` live in the Supabase project. CM1's own
`supabase-schema-v6.sql` inherits this same risk: it assumes
`public.coach_profiles` already exists with (at least) the shape
`types/database.ts`'s `CoachProfile` interface describes, and it assumes
`public.users(id)` exists as a valid foreign-key target.

### Mandatory live-schema reconciliation before applying v6

**`supabase-schema-v6.sql` must not be applied to any Supabase project —
staging or production — without first confirming, against the actual live
schema, that:**

1. `public.coach_profiles` exists, with an `id uuid primary key` column
   compatible with the new foreign keys in `coach_services`,
   `coach_locations`, `coach_availability_rules`,
   `coach_availability_exceptions`, and `coach_bookings`.
2. `public.users` exists, with an `id uuid primary key` column compatible
   with `coach_bookings.golfer_id`'s foreign key.
3. None of the twelve new column names being added to `coach_profiles`
   (`public_slug`, `marketplace_headline`, `profile_photo_url`,
   `years_coaching`, `lesson_delivery_modes`, `public_city`,
   `public_region`, `timezone`, `marketplace_visibility_status`,
   `verification_status`, `minimum_booking_notice_hours`,
   `cancellation_policy_summary`) already exist with an incompatible type
   or meaning.
4. None of the six new table names, the new view name
   (`coach_rating_summary`), the new function name
   (`fn_enforce_coach_review_completed_booking`), or the new trigger name
   (`trg_coach_reviews_enforce_completed_booking`) already exist with a
   different, incompatible shape.

This reconciliation is a deliberate, explicit, separate step — outside CM1's
scope, which touches no live database at all.

## Feature-flag operation

`lib/feature-flags.ts` exports `isCoachMarketplaceEnabled()`, which reads
**only** the server-only environment variable `COACH_MARKETPLACE_ENABLED`
(never a `NEXT_PUBLIC_`-prefixed variable, so it is never sent to the
browser). The raw value is trimmed and lowercased; only the exact
normalized string `"true"` returns `true` — `"1"`, `"yes"`, `"on"`,
`"enabled"`, and every other value return `false`, including when the
variable is unset entirely. `.env.example` documents it as
`COACH_MARKETPLACE_ENABLED=false`. CM1 itself calls this function nowhere
in application code (there is no marketplace UI yet to gate) — it exists so
CM2 has a single, already-tested boundary to wrap its first route/page in.

## Forward-only migration posture

`supabase-schema-v6.sql` contains no `DROP TABLE`, no `DROP COLUMN`, no
`TRUNCATE`, no `DELETE FROM`, and no destructive data rewrite of any kind.
Every statement is idempotent (`IF NOT EXISTS` / catalog-existence guards),
matching this repository's existing `supabase-schema-v4.sql`/`v5.sql`
convention, so re-running the file after it has already been applied is
always a safe no-op.

## Rollback strategy

- **Application rollback**: setting `COACH_MARKETPLACE_ENABLED` back to
  `false` (or simply never setting it) is the immediate, complete
  application-level rollback for any future phase's UI — CM1 itself needs
  no rollback since it exposes nothing to roll back.
- **Database rollback is forward-fix, not a destructive down-migration.**
  Because every new table starts RLS-enabled with zero policies, and
  `coach_profiles`'s new columns are additive and never read by any
  existing query, applying `v6` (once reconciled per the section above)
  carries no behavioral risk to existing features even if left in place
  indefinitely. If a future phase's *additional* migration needs to be
  undone, the correct approach is a new, later, forward-only migration that
  adjusts state going forward — not a `DROP`/`TRUNCATE` of `v6`'s objects,
  which would destroy any data a later phase had already accumulated in
  them.

## Rollout phases

| Phase | Scope |
|---|---|
| **CM1** | Foundation schema, types, flag, tests, documentation *(this document)* |
| **CM2** | Coach profile editor and public directory, behind the flag |
| **CM3** | Privacy-safe nearby discovery and location RPC |
| **CM4** | Services, availability, and booking requests — without payments |
| **CM5** | Completed-booking verification and moderated reviews |
| **CM6** | Stripe Connect onboarding, one-time lesson payments, platform commissions, payouts, refunds, disputes, and coach revenue reporting |

### CM1 explicitly, one more time

- CM1 applies no migration.
- CM1 exposes no page or navigation.
- CM1 grants no operational marketplace access (RLS default-deny, zero
  policies, on every new table).
- Disabling the feature flag remains the immediate application rollback.
- Database rollback is forward-fix rather than a destructive down migration.

## CM2A — Secure Data Contract (Source Only)

**CM1 is merged** (`e382425a`, "Merge PR #1: Coach Marketplace CM1
foundation", into `main`). CM2A is the first CM2 slice: a **source-only,
unapplied database security contract**. Like `supabase-schema-v6.sql`
before it, `supabase-schema-v7.sql` is never executed against any Supabase
project by this slice — merging CM2A does not authorize applying v7, any
more than merging CM1 authorized applying v6. CM2A adds no page, route,
form, component, or navigation entry of any kind; there is nothing new for
any user to see or click.

### What v7 creates

Exactly three objects, all narrowly scoped:

- `public.fn_get_own_coach_marketplace_profile()` — a `SECURITY DEFINER`,
  zero-parameter function that returns the calling coach's own marketplace
  profile fields, via an explicit 15-column `RETURNS TABLE` contract (never
  `RETURNS public.coach_profiles`, never a wildcard select).
- `public.fn_update_coach_marketplace_profile(...)` — a `SECURITY DEFINER`
  function with one explicit typed parameter per coach-editable field (never
  a generic `jsonb` payload, never a target-ID parameter) that validates,
  then writes, the calling coach's own row.
- `public.coach_directory_listing` — a private, `security_invoker` view
  projecting only public-safe columns for published, non-suspended,
  non-rejected coach profiles.

### Why SECURITY DEFINER, and why authenticated gets no direct grant

Both functions are `SECURITY DEFINER` — a deliberate departure from the
`SECURITY INVOKER` trigger function CM1 introduced (see "Completed-booking,
verified-review rule" above). The reason is the opposite of a convenience
shortcut: **`authenticated` receives no direct `SELECT`/`UPDATE` grant on
`coach_profiles` at all, at either the table or column level, and no RLS
policy is created for it either.** A `SECURITY INVOKER` function would have
*required* such a grant to do its job, and that same standing grant would
let any authenticated client bypass the function entirely via a direct
Supabase REST call — completely defeating its coach-role check, its
suspended-row lock, its field validation, and its slug-conflict handling.
`SECURITY DEFINER` lets `authenticated` hold `EXECUTE` on the function only,
never a table privilege it could route around. Both functions still do
every authorization check themselves — they derive identity only from
`auth.uid()`, reject a null caller, and re-verify `public.users.role =
'coach'` — because a `SECURITY DEFINER` function cannot lean on RLS the way
the CM1 trigger does.

### The public directory is server-only

`coach_directory_listing` is revoked from `PUBLIC`, `anon`, **and**
`authenticated` — granted only to `service_role`. There is no client-side
(anon-key) path to it at all. Any future route or data-access module that
reads it must run entirely server-side, using a service-role Supabase
client, and — before constructing that client or issuing any query — must
call `lib/coach-marketplace-access.ts`'s `requireCoachMarketplaceEnabled()`.
That helper is the single authoritative gate: it throws
`CoachMarketplaceDisabledError` unless `COACH_MARKETPLACE_ENABLED` is
exactly `"true"`, and both the future route (via `notFound()`) and the
future data-access function must check it, as independent, redundant
layers — so a future route can't forget the flag even if it forgets the
other check.

### profile_photo_url is read-only in CM2A

`fn_update_coach_marketplace_profile` deliberately has **no**
`p_profile_photo_url` parameter. `profile_photo_url` remains readable
(via both functions' return contract) but cannot be written by this
function. Profile-photo upload requires its own Supabase Storage bucket
and storage RLS policies, which is out of scope for CM2A and deferred to a
dedicated later slice.

### Inactive, rejected, and suspended profiles are excluded from the public directory

`coach_directory_listing`'s predicate is:

```sql
where marketplace_visibility_status = 'published'
  and public_slug is not null
  and is_active = true
  and verification_status not in ('suspended', 'rejected')
```

Excluding `suspended` verification is the literal minimum. CM2A additionally
excludes `rejected` verification as a conservative trust-and-safety default:
`rejected` means an admin explicitly reviewed and denied the coach's
verification request — visually indistinguishable to a golfer from
`unverified`/`pending`, but a real denial rather than a neutral in-progress
state. Continuing to publicly list a profile whose verification was
explicitly denied would undermine the verification badge's meaning.
`unverified` and `pending` remain listable. **This is a product/trust-and-
safety decision that should be confirmed by whoever owns coach verification
before v7 is ever applied** — it is not settled by CM2A alone.

**`is_active = true` is also required.** `coach_profiles.is_active` is a
pre-CM1, account-level switch (not a marketplace-specific field) and takes
precedence over `marketplace_visibility_status`: a coach whose account has
been deactivated must never be publicly listable, even if their
`marketplace_visibility_status` was left at `'published'` from before
deactivation — there is no reason to expect those two independent fields to
be kept in sync by anything else in this schema, so the directory predicate
enforces it directly. `is_active` is deliberately **not** projected by the
view (it's an input to the filter, not information about the coach) and is
not coach-writable by either function `v7` creates — it never appears as a
parameter or as an assignment in `fn_update_coach_marketplace_profile`.

### Fail-loud posture and preflight

Unlike `v6`, `v7` uses **no** `IF NOT EXISTS` / `CREATE OR REPLACE` /
skip-on-conflict idempotency for anything it creates. `v6` only ever created
brand-new, CM1-owned tables with no prior history; `v7` instead layers new
objects onto `coach_profiles`, a pre-existing table whose live RLS/policy/
grant state cannot be verified from this repository. Every check in `v7`
therefore raises an exception and aborts the whole transaction on any
unexpected pre-existing state, rather than silently skipping it or layering
on top of it. Nothing is ever dropped or replaced automatically.

**Before creating any object, `v7` runs five preflight checks, in order:**

1. Every required `public.users`/`public.coach_profiles` column exists with
   a compatible type (19 columns checked, including `is_active boolean`; all
   missing/incompatible ones are reported together, not just the first).
2. The running PostgreSQL version is 15 or newer (required for
   `security_invoker` views) — there is no pre-15 fallback branch; an older
   server fails the whole migration outright.
3. None of `fn_get_own_coach_marketplace_profile`,
   `fn_update_coach_marketplace_profile` (any overload), or
   `coach_directory_listing` already exist, and `coach_profiles` has zero
   pre-existing RLS policies.
4. `authenticated` and `anon` have **no effective** `SELECT`/`UPDATE` access
   to `coach_profiles` — checked at both table and column level via
   `has_table_privilege()`/`has_any_column_privilege()` (which already fold
   in privilege inherited via a `PUBLIC` grant), plus an explicit,
   separately-reported check of `information_schema.table_privileges`/
   `column_privileges` for a `PUBLIC`-grantee row. `service_role` is
   confirmed to already have the underlying `SELECT` privilege the
   `security_invoker` directory view will need.
5. Only after all of the above pass: `alter table public.coach_profiles
   enable row level security;` (idempotent; CM2A creates no policy).

**None of this preflight logic connects to Supabase or runs anywhere except
inside the unapplied `v7.sql` text itself.** When `v7` is eventually a
candidate for applying, the same live-schema reconciliation discipline as
`v6` (see "Mandatory live-schema reconciliation before applying v6" above)
applies here too — the preflight is a safety net for that moment, not a
substitute for deliberately deciding to apply it.
