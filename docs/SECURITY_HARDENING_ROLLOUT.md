# SEC1A — Security Policy Hardening Rollout

## Status: source-only, unapplied

This document describes `supabase-security-sec1a.sql`, a source-only SQL
contract. **It has not been run against any Supabase project — staging or
production — and SEC1A remains fully unapplied.** No live policy, grant,
table, bucket, row, or configuration has been changed by this work.

Commit/push was later authorized separately and completed at commit
`81e54fc55fea45ca5f1ce7eb2c936ff3e770b688`. Draft PR #4 was subsequently
created for source review. **Neither action executed the SQL or changed any
database or storage state** — both are ordinary source-control steps, not
database steps, and neither one authorizes what follows below.

The remaining gates, each requiring its own separate, explicit authorization:

1. **Staging application** — running `supabase-security-sec1a.sql` against a
   staging Supabase project and executing the staging verification matrix
   below. Not authorized; not performed.
2. **Production application** — running the migration against the production
   project (`atlmnqispyzhsahahpjy`, "SwingProAI"). Not authorized; not
   performed.
3. **Merge / readiness actions** — marking PR #4 ready for review, merging
   it, or any deployment action. Separately authorized when appropriate; not
   granted by this document.

This document exists to make the reasoning, scope, and rollback posture
reviewable before any of the remaining gates are requested.

## Purpose

SEC1A removes exactly three weak, over-permissive Postgres Row Level Security
(RLS) policies that were identified during the GP1R read-only schema
reconciliation audit and re-confirmed unchanged during the SEC1A design
review. It changes nothing else — no new policy, no grant, no RLS-enablement
change, no column/constraint/index/trigger/function change, no storage bucket
configuration change.

## The two vulnerabilities

### 1. Anonymous swing-video upload

`storage.objects` carries a policy named **"Allow Anonymous Uploads
xuww7b_0"** that grants the `anon` role (i.e. any unauthenticated client)
`INSERT` into the private `swing-videos` bucket, checking only that
`bucket_id = 'swing-videos'` — no folder-ownership check at all. Combined
with the bucket's standard blanket table-level grant, this allows any
unauthenticated caller to upload an object to any path in the bucket.

### 2. `user_goals` identity spoofing and null-row exposure

`public.user_goals` carries two additional weak policies:

- **"Allow authenticated inserts"** — `INSERT ... WITH CHECK (true)`. Any
  authenticated user can insert a row with an arbitrary `user_id`, including
  another user's ID or `NULL`.
- **"Allow users to view own goals"** — `SELECT ... USING (auth.uid() =
  user_id OR user_id IS NULL)`. Any authenticated user can read every row
  where `user_id IS NULL`, in addition to their own rows.

### Why permissive policies combine with OR

PostgreSQL RLS evaluates multiple `PERMISSIVE` policies for the same command
by OR-ing them together — a row is visible/writable if **any** applicable
permissive policy allows it. Each table above also has a correct,
owner-scoped policy for the same command (`auth.uid() = user_id` /
folder-ownership). That correct policy does nothing to narrow access while a
broader permissive policy for the same command also exists — the broader one
wins for any row it covers. Removing the weak policy is therefore sufficient;
no `RESTRICTIVE` policy or other structural change is needed.

### Equivalent-access detection also covers the `public` role

Beyond the exact three named policies above, the fail-loud preflight and
postflight each run a supplementary scan for any *other* policy that could
recreate equivalent anonymous-upload access under a different name. That scan
treats a policy assigned to either the `anon` role **or** PostgreSQL's
`public` pseudo-role as anonymous-applicable — a policy created without an
explicit `TO` clause is recorded against `public` and applies to every role,
including unauthenticated clients, not just to `authenticated` sessions. The
scan remains narrowly bounded to `storage.objects` `INSERT` policies
referencing the `swing-videos` bucket; it does not extend to other buckets
and does not require every unrelated future policy on `storage.objects` to
stay frozen forever.

## Exactly what SEC1A removes

| Schema/table | Policy name | Command |
|---|---|---|
| `storage.objects` | `Allow Anonymous Uploads xuww7b_0` | INSERT |
| `public.user_goals` | `Allow authenticated inserts` | INSERT |
| `public.user_goals` | `Allow users to view own goals` | SELECT |

## Strict policies preserved, unchanged

| Schema/table | Policy name | Command |
|---|---|---|
| `public.user_goals` | `Users can insert own goals` | INSERT |
| `public.user_goals` | `Users can view own goals` | SELECT |
| `storage.objects` | `Users can upload their own swing videos` | INSERT |
| `storage.objects` | `Users can read their own swing videos` | SELECT |
| `storage.objects` | `Users can delete their own swing videos` | DELETE |

None of these five are recreated or modified by this contract — the
preflight only verifies they already exist, unchanged. If any has drifted
from its approved definition, the contract stops and requires redesign
rather than silently replacing it.

No swing-video `UPDATE` policy exists today, and SEC1A does not create one.

## Effective access: before vs. after

| Actor / action | Before | After |
|---|---|---|
| `anon` upload to `swing-videos` | **Allowed** (no ownership check) | Denied — no applicable policy |
| `authenticated` upload to own folder | Allowed | Allowed (unchanged) |
| `authenticated` upload to another user's folder | Denied | Denied (unchanged) |
| `authenticated` insert `user_goals` with own `user_id` | Allowed | Allowed (unchanged) |
| `authenticated` insert `user_goals` with another/null `user_id` | **Allowed** | Denied |
| `authenticated` select own `user_goals` rows | Allowed | Allowed (unchanged) |
| `authenticated` select `user_id IS NULL` rows | **Allowed** | Denied |
| `service_role` / table owner | Full bypass via `BYPASSRLS` | Unchanged |

Table-level grants (`anon`/`authenticated`/`service_role` all holding the
standard Supabase blanket grant) are **not** touched and remain the same
before and after — RLS policies, not table grants, are the actual access
boundary here, which is why this contract only ever touches policies.

## Confirmed repository compatibility

Every in-repository consumer of swing-video upload and `user_goals` was
reviewed at the pinned commit and requires authentication before acting, and
never relies on the two removed behaviors:

- `app/(dashboard)/analyze/upload-actions.ts` — requires `auth.getUser()`;
  builds the storage path as `${user.id}/...`.
- `app/api/v1/upload/route.ts` — requires `auth.getUser()`; uploads via a
  service-role client (bypasses RLS by design, independent of the removed
  `anon` policy).
- `swingmaster-web/app/(dashboard)/analyze/page.tsx` — requires
  `auth.getUser()`; builds the storage path as `${user.id}/...`.
- `app/(dashboard)/goals/actions.ts` (`submitGoals`, `generateSyllabus`) —
  every insert/select uses the authenticated user's real `user.id`; never
  inserts or depends on a null/arbitrary `user_id`.

No confirmed-incompatible or potentially-incompatible in-repository consumer
was found.

## Unresolved: external consumers

Source review cannot rule out consumers outside this repository (a mobile
client, a support tool, a third-party integration) that might depend on the
anonymous-upload hole. This is a normal limitation of a source-only audit and
is called out explicitly as **unresolved**, not as evidence of risk.

## Staging authority gate: `storage.objects` ownership

`storage.objects` is owned by `supabase_storage_admin`, not `postgres`.
Dropping a policy requires the executing role to own the relation, be a
superuser, or be a member of the owning role — `BYPASSRLS` alone does not
grant this. Catalog inspection during the SEC1A design review found no
direct `pg_auth_members` membership from `postgres` into
`supabase_storage_admin`. The migration's preflight (`SEC1A-PRE-B4`)
explicitly checks this and will **stop with a clear exception** rather than
attempt the `DROP POLICY` if the executing role lacks authority. This must be
validated in staging — under whatever execution role Supabase provides for
storage-schema policy migrations — before any production attempt. The
preflight is deliberately not weakened to force an apparent pass.

## Staging verification matrix (to run in staging only, not yet executed)

**Storage:**
- Anonymous upload to `swing-videos` → expect denied.
- Authenticated upload to own `{auth.uid()}/...` folder → expect success.
- Authenticated upload to another user's folder → expect denied.
- Authenticated read of own object → expect success.
- Authenticated read of another user's object → expect denied.
- Authenticated delete of own object → expect success.
- Authenticated delete of another user's object → expect denied.
- Unrelated `drill_videos` behavior → expect unchanged.

**Goals:**
- Authenticated insert with own `user_id` → expect success.
- Authenticated insert with another user's `user_id` → expect denied.
- Authenticated insert with null `user_id` → expect denied.
- Authenticated select of own rows → expect success.
- Authenticated select of another user's rows → expect denied.
- Authenticated select of a pre-existing null-`user_id` row → expect denied.
- `service_role` operational access → expect unaffected.

All staging test objects/rows must be created under separately authorized
test accounts and cleaned up afterward. **No production write-based security
testing is authorized.**

## Transaction / rollback behavior

The entire contract runs inside one `BEGIN ... COMMIT` transaction. If the
preflight, any `DROP POLICY`, or the postflight raises an exception, the
transaction aborts and live policy state is left completely unchanged — this
is standard PostgreSQL transactional DDL behavior, not a custom recovery
mechanism.

### Emergency reversal warning

A reversal migration that recreates the three removed policies is **not**
the preferred rollback path and is not created by this work. Recreating
"Allow Anonymous Uploads xuww7b_0" restores unauthenticated write access to
production storage; recreating the two `user_goals` policies restores the
identity-spoofing and null-row-exposure holes. If a post-deploy issue ever
appears to require reversal, the correct response is to fix the actual
application dependency, not to restore known vulnerabilities. Any reversal
would require its own separate, explicit emergency authorization.

## What this contract explicitly does not do

- No application-row cleanup or backfill of any kind.
- No change to existing `user_id IS NULL` rows in `user_goals` — they remain
  stored exactly as they are; they simply become unreadable through the
  ordinary authenticated policy path (still reachable by `service_role`).
- No grant, table, column, constraint, index, trigger, function, bucket,
  application, environment, or dependency change.
- No `file_size_limit` or `allowed_mime_types` change on the `swing-videos`
  bucket — this is explicitly **deferred to a separate SEC1C slice**, since
  changing either requires a compatibility audit across the three upload
  paths above (one of which enforces its own 500MB/3-MIME-type limit at the
  application layer today, others of which do not).
- No GP1 golfer-profile work of any kind.

## Required approvals before further action

| Gate | Status |
|---|---|
| Commit / push this branch | **Completed** — commit `81e54fc55fea45ca5f1ce7eb2c936ff3e770b688` |
| Draft PR #4 creation | **Completed** — open for source review only |
| Mark PR #4 ready for review / merge | **Not authorized as part of this work** |
| Apply to staging | **Not authorized as part of this work** |
| Apply to production | **Not authorized as part of this work** |
