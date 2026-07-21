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

## CM2R — Live Production Reconciliation (Source Only)

A separately authorized, read-only production metadata inspection (no
application-row data was queried) found that `v7`'s own preflight
assumption — a `coach_profiles` table with zero pre-existing RLS policies
and zero pre-existing broad grants — **does not hold in production**.
`coach_profiles` predates this repository's tracked history entirely (see
"Production schema-drift risk" above) and already carries:

- Two named RLS policies: `"Anyone can view active coach profiles"`
  (`SELECT`, `USING (is_active = true)`) and `"Coaches can manage their own
  profile"` (`ALL`, `USING (auth.uid() = user_id)`, no `WITH CHECK`).
- Broad `DELETE`/`INSERT`/`REFERENCES`/`SELECT`/`TRIGGER`/`TRUNCATE`/`UPDATE`
  table grants to `anon`, `authenticated`, **and** `service_role`.

Because `v7`'s preflight explicitly `raise exception`s the moment it finds
any pre-existing policy on `coach_profiles`, **`v7` would correctly refuse
to apply against this real production state** — this is the preflight
design working exactly as intended, not a defect to patch around.

A parallel, read-only inventory of this repository's application code found
**zero executable consumers of `coach_profiles` anywhere** — no
`.from("coach_profiles")`, no RPC call, no route, page, or component
references it at all. `v6.sql`/`v7.sql` remain unapplied, so nothing in
this application currently depends on the two legacy policies or the broad
grants continuing to work. (This does not rule out an *external*, non-repo
consumer — see "Unresolved questions" below.)

### v6 and v7 remain unchanged, historical, source-only artifacts

Both files already went through independent, multi-round security review
against their exact committed text. Rewriting either in place after the
fact would invalidate that review trail for no technical benefit, since
neither has ever been applied to any database. `supabase-schema-v8.sql`
supersedes their intended production effect entirely — it performs every
schema change `v6` was meant to make, creates every object `v7` was meant
to create, and additionally performs the production-specific reconciliation
neither anticipated, all atomically in one transaction.

### Migration authority: BYPASSRLS is not DDL authority

`v8`'s preflight verifies the role applying the migration is either the
owner of `public.coach_profiles` or a PostgreSQL superuser — **BYPASSRLS
alone is explicitly not accepted**. BYPASSRLS only changes whether row-level
security *policies* are evaluated for that role's data reads/writes; it
confers no ownership privilege and no ability to `ALTER TABLE`,
`DROP POLICY`, or `GRANT`/`REVOKE` on an object the role does not own. A
role with BYPASSRLS but lacking ownership or superuser status would have
failed partway through this transaction anyway (at `DROP POLICY` or
`ALTER TABLE ADD CONSTRAINT`) with an opaque Postgres permission error —
checking for it explicitly up front turns that into a clear, named,
early-failing exception instead.

### Preflight and postflight: checking both ends of the transaction

`v8` verifies the security posture twice: the **baseline preflight**
(before any structural statement runs) confirms the verified production
starting state still holds, and a new **final effective-access postflight**
(after every column, table, function, and view has been created and every
`REVOKE`/`GRANT`/`DROP POLICY` has been issued, but *before* `COMMIT`)
independently re-derives the resulting security posture from the catalogs
and confirms it matches what this migration intends. Every postflight check
uses `has_table_privilege()`/`has_function_privilege()` (or the equivalent
`information_schema` lookups for `PUBLIC`-grantee rows), so privilege
inherited through role membership or a `PUBLIC` grant is included, not just
what a plain grant-table row count would show. If any postflight invariant
fails — a forgotten `REVOKE`, a typo'd role name, an accidental extra
`GRANT` earlier in this same file — the whole transaction is rolled back
before it ever commits; nothing this migration changed is left in place
partially. The postflight is defense-in-depth against this migration's own
mistakes, not a substitute for the baseline preflight, which instead
guards against production having drifted from what was verified.

### The two legacy policies being removed

By exact quoted name only, after `v8`'s own preflight independently
re-confirms both exist with the exact expected definition:

- `"Anyone can view active coach profiles"`
- `"Coaches can manage their own profile"`

No replacement direct-table policy is created. `coach_profiles`'s final
state is RLS enabled with **zero** policies — matching every other
marketplace table's default-deny convention. All coach and directory access
goes exclusively through five narrow `SECURITY DEFINER` functions and the
reconciled, `service_role`-only `coach_directory_listing` view.

### The direct-grant problem

The existing `ALL`-command, own-row policy has **no `WITH CHECK`** — under
Postgres RLS semantics, `USING` governs both read-visibility and
write-validity when `WITH CHECK` is omitted, so a coach can currently write
*any* value to *any* column of their own row. Applying `v6`'s new columns
(`verification_status`, `marketplace_visibility_status`, etc.) on top of
this policy — without also replacing it — would immediately let a coach
self-verify or otherwise bypass every admin-only-field protection CM2A's
functions were built to enforce. `v8` closes this by revoking `anon`,
`authenticated`, and `PUBLIC` down to zero direct privilege on
`coach_profiles` entirely, and normalizing `service_role` to `SELECT` only.

### Why the SECURITY INVOKER rating view needs service_role SELECT on coach_reviews

`public.coach_rating_summary` is declared `WITH (security_invoker = true)` —
deliberately preserved, unchanged, from the audited CM1 design. A
`security_invoker` view evaluates the *underlying base table's* grants and
row-level security **as the invoking role**, not as the view's owner. Since
only `service_role` is ever meant to query this view (or
`coach_directory_listing`), `service_role` must hold a real, explicit
`SELECT` grant on the view's base table, `public.coach_reviews` — without
it, every query against the view would return nothing (or fail outright),
regardless of the `GRANT SELECT` on the view itself. This privilege is
**read-only** (`SELECT` only — never `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/
`REFERENCES`/`TRIGGER`) and exists solely so the server-only, approved-
review-only rating aggregate can actually be read; the other five
marketplace tables (`coach_services`, `coach_locations`,
`coach_availability_rules`, `coach_availability_exceptions`,
`coach_bookings`) remain entirely inaccessible to `service_role` in this
slice, since no audited server-side operation touches them yet.

### service_role BYPASSRLS is a required, verified assumption

`coach_reviews` (like every other marketplace table) has RLS enabled with
**zero** policies — default-deny for any role whose row-level security is
actually evaluated. For `service_role`'s explicit `SELECT` grant above to
mean anything in practice, `service_role` must have the `BYPASSRLS` role
attribute, so its row-level security is never evaluated at all and the
table-level `GRANT` is what actually governs its access. `v8` verifies this
twice: a baseline preflight (before any structural statement runs) confirms
`service_role` exists and already has `BYPASSRLS`, and a final postflight
(immediately before `COMMIT`) re-confirms `BYPASSRLS` is still set after
every grant/revoke in this migration has been applied.

### Exact function lookups fail into stable, named exceptions

Postflight D resolves each of the five coach-owned functions via
`pg_catalog.to_regprocedure(...)` rather than a direct `::regprocedure`
cast. A cast throws its own generic "function does not exist" error and
aborts the transaction before this migration's own postflight logic gets a
chance to run — `to_regprocedure` instead returns `NULL` for a missing or
mistyped signature, which is recorded as an ordinary postflight-D problem
(alongside every other check) and reported through the same stable,
`postflight D:`-prefixed exception as any other failure. A missing
function, a signature that drifted, or an unexpected additional overload
are therefore always reported the same way, never as an opaque low-level
Postgres error.

### Function ownership is positively tied to the trusted migration role

Postflight D no longer relies solely on excluding `anon`/`authenticated`/
`service_role` by name as proof a function's owner is trustworthy — that
blacklist doesn't rule out some *other* untrusted role. Each function's
owner (`pg_proc.proowner`, resolved through `pg_roles`) must equal
`current_user` — the exact same role Preflight D already proved is either
the owner of `public.coach_profiles` or a PostgreSQL superuser. The
role-name blacklist is retained as an additional, non-exclusive check.

### `marketplace_display_name` — the public identity contract

A new, dedicated, nullable `text` column, distinct from the legacy
`business_name` field. `business_name` predates the marketplace, was never
designed with public display in mind, and is not copied or backfilled into
`marketplace_display_name` by this migration (no data rewrite of any kind).
`marketplace_display_name` is nullable while `hidden`/`draft`, must be
non-blank (after `btrim`) when non-null (`coach_profiles_marketplace_
display_name_valid`, capped at 100 characters), and is required, non-null,
and non-blank to transition to `published`. `public.users.full_name` and
`email` are never exposed by any marketplace function or view — no existing
part of this application currently shows either name to an anonymous
visitor, so introducing that would be a genuinely new privacy boundary, not
a continuation of an existing public contract.

### `hourly_rate` remains deprecated/read-only

No function in `v8` accepts or writes `hourly_rate` — marketplace pricing
remains exclusively on `coach_services.price_amount_minor`.

### `is_active` — a dedicated function, not a routine profile edit

`fn_set_own_coach_active(p_is_active boolean)` is deliberately separate from
both profile-editing functions: `is_active` is an account-level switch that
takes precedence over `marketplace_visibility_status` in the directory
eligibility predicate, so it deserves its own narrow, single-purpose,
auditable boundary rather than being folded into routine content edits.

### The coach get-or-create function

No application code path, and no inspected database trigger, currently
creates a `coach_profiles` row (the `auth.users` creation trigger inserts
into `public.users` only). `fn_get_or_create_own_coach_profile()` is the
safe, idempotent, concurrency-safe replacement — `INSERT ... ON CONFLICT
(user_id) DO NOTHING` against the existing `coach_profiles_user_id_key`
uniqueness contract, never accepting an `id` or `user_id` parameter.

### Directory reads remain server-only through `service_role`

`coach_directory_listing` is revoked from `PUBLIC`, `anon`, and
`authenticated` — reachable only via a service-role Supabase client from
server-side application code. Both the future public-directory route and
its data-access helper must call `lib/coach-marketplace-access.ts`'s
`requireCoachMarketplaceEnabled()` before constructing that client or
issuing any query at all — Postgres cannot see `COACH_MARKETPLACE_ENABLED`,
so this check lives entirely in application code, exactly as CM2A
established.

### `v8` remains unapplied

Merging this source file does not authorize running it against staging or
production. The feature flag remains disabled regardless. No page, route,
component, or navigation entry is added by this slice.

### Expected deployment sequence

1. Resolve the unresolved questions below with whoever has production/
   backend visibility outside this repository.
2. Apply `v8.sql` to a **staging** Supabase project first — never
   production directly.
3. Verify in staging that the two legacy policies are gone, grants are
   tightened, and the five functions/directory view behave as designed.
4. Apply `v8.sql` to production during a low-traffic window (it briefly
   holds an `ACCESS EXCLUSIVE` lock on `coach_profiles`).
5. Only after the database change is live and verified should any future
   CM2B/CM2C application code (coach editor UI, public directory UI) be
   built against these functions/view — database and application changes
   are independently revertible and should not ship in the same release.

### Rollback / forward-fix posture

Unchanged from CM1/CM2A: database rollback is forward-fix, not a
destructive down-migration. If `v8` needs to be undone after application,
the correct approach is a new, later, forward-only migration — never a
`DROP`/`TRUNCATE` of anything `v8` created, which would destroy any data a
later phase had already accumulated.

### Unresolved questions requiring product or security sign-off

- Where does a production `coach_profiles` row actually get created today,
  if not from any code path in this repository?
- Does any consumer *outside* this git repository (a partner integration, a
  manual script, an already-deployed build, direct dashboard usage) rely on
  the current two RLS policies or broad grants continuing to work?
- Confirm the origin of the broad `anon`/`authenticated`/`service_role`
  grants (Supabase default-privilege bootstrap vs. a manual action) —
  unprovable from this repository alone.
- Confirm whether `business_name`/`bio`/`specialties`/`certification`
  should keep a dedicated write path indefinitely (as `v8` provides via
  `fn_update_own_coach_profile_legacy`) or are meant to be fully superseded
  by the marketplace column set in a later phase.
