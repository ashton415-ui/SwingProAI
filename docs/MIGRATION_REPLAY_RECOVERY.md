# SEC1A-RR1 — Migration Replay Recovery

## Status: source-only, unapplied, locally validated

This document describes `supabase/migrations/20260721220000_swingproai_production_baseline.sql`,
a source-only, canonical baseline migration. It has been validated locally
against a real Supabase-flavored PostgreSQL instance (see
[Local validation](#local-validation) below) but **has not been run against
any hosted Supabase project — staging or production.** No live policy,
grant, table, row, or configuration on the hosted SwingProAI project
(`atlmnqispyzhsahahpjy`) has been changed by this work.

## Background: the failed sec1a-staging branch

An earlier attempt to validate SEC1A (`supabase-security-sec1a.sql`) against
a real Supabase staging branch failed and that branch was deleted.
**No SEC1A SQL ran during that attempt or at any point since** —
`supabase-security-sec1a.sql` remains exactly as committed on
`fix/security-policy-hardening-sec1a` (merged to `main` in PR #4): a
source-only contract that removes three weak policies, never applied to any
database. The staging attempt failed for an environment-provisioning reason
unrelated to SEC1A's own correctness: the recorded Supabase migration-ledger
replay chain does not reproduce the schema SEC1A needs to run against, so a
fresh branch built from that ledger never reaches a state where SEC1A's own
preflight (which expects the current production policy catalog, including
the three weak policies) can pass.

## The migration-ledger replay defects

Read-only inspection of the repository's `supabase-schema-v2.sql` through
`v8.sql` files and the SwingProAI project's recorded migration history
surfaced the following defects, all confirmed against live production
catalog metadata during SEC1A-RR1:

1. `20260611030421_coach_hub_tables` references `public.drills` before any
   recorded migration creates it.
2. `20260711231548_enable_rls_swings_text_user_id` operates on
   `public.swings`, but no recorded migration creates `public.swings`.
3. `20260711231833_enable_rls_user_bags_clean` operates on
   `public.user_bags`, but no recorded migration creates `public.user_bags`.
4. `public.user_goals` and its policies (including the two SEC1A-relevant
   weak policies and their two strict counterparts) are entirely absent from
   the recorded replay chain — the table demonstrably exists in production
   with all four policies live, but no migration file creates any of it.
5. The current migration ledger, replayed in order from empty, does not
   reproduce the full production schema (28 application-owned tables, 5
   functions, 4 triggers, 67 policies across `public` and
   `storage.objects` were confirmed live in production; the recorded ledger
   accounts for only a subset) or the pre-SEC1A policy catalog SEC1A's own
   preflight depends on.

None of the historical schema files (`supabase-schema-v2.sql` through
`v8.sql`) were edited, concealed, or reinterpreted to hide these defects —
they are reported here exactly as found.

## Why a later migration cannot repair an earlier replay failure

Supabase's migration model is strictly append-only and order-dependent: each
migration file is replayed, in timestamp order, against the cumulative
result of every migration before it. If migration N assumes an object that
migration N-1 was supposed to create but didn't, no migration N+1 can go
back and retroactively insert that missing object into N-1's position in the
sequence — replaying the ledger from empty will always fail at N, regardless
of what is added afterward. A new migration appended at the end of the
ledger can only ever build on top of a **already-broken** replay; it cannot
fix the break itself. This is why SEC1A-RR1 does not attempt to patch or
insert a corrective migration into the existing timestamp sequence. Instead,
it produces a **new canonical baseline** — a single migration that, on its
own, from empty, reproduces the current schema — so that a *future*, fresh
migration history (production's ledger *tracking*, not production's actual
schema) can be realigned to start from a state that actually matches reality.

## Four distinct states — do not conflate them

1. **Production schema state** — the actual, live PostgreSQL catalog objects
   in the hosted `atlmnqispyzhsahahpjy` project right now. This is what
   SEC1A-RR1 read (read-only) and what this baseline reproduces.
2. **Production migration-ledger state** — Supabase's own bookkeeping
   (`supabase_migrations.schema_migrations`) of which migration timestamps
   have been marked as applied. This ledger is currently **inconsistent**
   with state 1 — it does not account for `drills`, `swings`, `user_bags`,
   or `user_goals` the way they actually exist live.
3. **Checked-in baseline source** — the file this document describes. It is
   pure, inert SQL text in this repository. It has no effect on states 1 or
   2 until someone explicitly applies it somewhere.
4. **Future temporary staging branch state** — a not-yet-created, ephemeral
   Supabase branch that would be built by applying this baseline (and
   nothing else) to a fresh empty database, for the sole purpose of later
   testing SEC1A against a faithful target. This state does not exist yet.

SEC1A-RR1 produces artifacts relevant to states 3 only. It does not touch
states 1 or 2, and state 4 has not been created.

## The baseline file

`supabase/migrations/20260721220000_swingproai_production_baseline.sql`
recreates, from an empty standard Supabase project, the current production
application-owned schema: 28 tables (including `drills`, `swings`,
`user_bags`, and `user_goals` — all missing from the recorded ledger), 2
enum types, 42 foreign keys, 60 indexes, 5 functions, 4 triggers, RLS
enabled on all 28 tables, 67 RLS policies (61 on `public` relations, 6 on
`storage.objects`), 28 tables' worth of standard grants, and the two
storage bucket configuration rows (`swing-videos`, `drill_videos`). It
recreates no Supabase-managed relation (`auth.users`, `storage.objects`,
`storage.buckets` themselves are never `CREATE TABLE`d — only
application-owned triggers and policies are added to them).

### The baseline intentionally reproduces the pre-SEC1A weak policies

This is not an oversight. The baseline's purpose is to be a faithful target
against which SEC1A can later be tested — that only works if the target
actually has the vulnerabilities SEC1A is designed to remove. The baseline
therefore includes, unmodified:

- `storage.objects` — `"Allow Anonymous Uploads xuww7b_0"`
- `public.user_goals` — `"Allow authenticated inserts"`
- `public.user_goals` — `"Allow users to view own goals"`

alongside the five strict, SEC1A-protected policies (`"Users can upload
their own swing videos"`, `"Users can read their own swing videos"`,
`"Users can delete their own swing videos"`, `"Users can insert own
goals"`, `"Users can view own goals"`). **SEC1A itself is not applied
anywhere in this baseline** — `supabase-security-sec1a.sql` was not
executed, and its three `DROP POLICY` statements do not appear in this
file.

## Local validation

Performed against a real Supabase-flavored PostgreSQL 17.6 instance
(`public.ecr.aws/supabase/postgres:17.6.1.143`, already present in the local
Docker image cache from a prior local-development session — no new image
was pulled and the Supabase CLI itself was not installed) running in an
isolated, temporary Docker container:

- The container's own bundled Supabase bootstrap (its standard
  `docker-entrypoint-initdb.d` migrations) ran unmodified, producing the
  real `auth` schema, `auth.users` table, and `anon`/`authenticated`/
  `service_role`/`supabase_storage_admin` roles — genuinely equivalent to
  what a fresh hosted or CLI-provisioned Supabase project starts from.
- The container did **not** include the separate `storage-api` service
  (only the base Postgres image was started), so the real `storage` schema
  was not present. A minimal, clearly test-only stub (`storage.buckets`,
  `storage.objects` with the columns the baseline's policies actually
  reference, plus the standard public `storage.foldername()` helper) was
  created directly via `psql`, matching the well-known, publicly documented
  shape Supabase's real storage-api provisions. This stub was **never**
  written to any file in this repository and was destroyed with the
  container.
- The standard Supabase helper function `auth.jwt()` — used by production's
  live `"Allow admins to modify drills"` policy — is normally provided by
  the full GoTrue/auth service, which was likewise not started in this
  single-container setup. Its well-known, publicly documented standard
  definition was added the same way, directly via `psql`, for the same
  test-only reason, and was destroyed with the container.
- With those two environment-level additions in place (neither of which
  required any change to the candidate baseline file itself), the baseline
  was applied via `psql -f` **unmodified, exactly as authored on disk**. It
  completed successfully end to end: all 28 tables, 42 foreign keys, 60
  indexes, 2 enum types, 5 functions, 4 triggers, RLS enablement on all 28
  tables, all 67 policies, all 28 tables' grants, and the storage bucket
  insert all applied without error, and the baseline's own postflight
  self-check (`RR1-POST-1` through `RR1-POST-4`) confirmed the exact
  expected inventory before `COMMIT`.
- The temporary container was stopped and removed immediately after
  validation. No database artifact persisted to the host filesystem (no
  volume was mounted).

### Catalog comparison

After the local replay committed, the following aggregate structural counts
were independently queried from both the local replay and, read-only, from
the live `atlmnqispyzhsahahpjy` production catalog, for direct comparison:

| Metric | Local replay | Production | Match |
|---|---|---|---|
| `public` tables | 28 | 28 | ✅ |
| Total `public` columns | 299 | 299 | ✅ |
| `public` RLS policies | 61 | 61 | ✅ |
| `storage.objects` policies | 6 | 6 | ✅ |
| `public` functions | 5 | 5 | ✅ |
| Application-relevant triggers | 4 | 4 | ✅ |
| `public` foreign keys | 42 | 42 | ✅ |
| `public` primary keys | 28 | 28 | ✅ |
| `public` unique constraints | 7 | 7 | ✅ |
| `public` check constraints | 15 | 15 | ✅ |
| `public` indexes | 60 | 60 | ✅ |
| `public` enum types | 2 | 2 | ✅ |

All twelve independently-checked structural metrics matched exactly. This is
a genuine post-hoc comparison, not merely a restatement of the same read
used to author the baseline — it re-queried both sides independently after
the local replay committed. It is a comprehensive **structural** comparison
(relation/column/constraint/index/policy/function/trigger/enum counts
across every table), not an exhaustive statement-by-statement byte diff of
every column's full type/default/expression text against production; the
baseline's per-column definitions were themselves transcribed directly from
the same live catalog metadata this comparison re-queried, so the two are
consistent rather than independently re-derived from scratch.

## Ledger-export and rollback requirements (future work, not performed here)

Before any ledger realignment is attempted, the following must happen under
separate, explicit authorization:

1. Export the current production `supabase_migrations.schema_migrations`
   ledger contents (read-only) so the pre-realignment state is recorded and
   reversible.
2. Decide, explicitly, how the ledger will be realigned — most likely by
   marking this baseline's timestamp as applied in the ledger *without*
   executing its DDL against production (since production's schema already
   has this content) — versus any other approach.
3. Perform that ledger write as its own isolated, explicitly authorized
   action, separate from any schema change.

**Ledger repair changes tracking metadata only and must never execute this
baseline's DDL against production** — production's schema already has the
tables, functions, triggers, and policies this file creates; running the
file's `CREATE TABLE`/`CREATE POLICY`/etc. statements against production
would fail immediately at this file's own clean-environment preflight
(`RR1-PRE-1`), by design.

## Remaining separately-authorized gates

Each of the following requires its own separate, explicit authorization and
none has occurred as part of SEC1A-RR1:

- **Ledger realignment** against production tracking metadata.
- **Temporary staging branch creation** — creating a Supabase branch is a
  billed action; the branch must be deleted promptly after use to avoid
  ongoing cost, and its creation/deletion are both separately gated.
- **SEC1A staging application** — running `supabase-security-sec1a.sql`
  against a temporary staging branch built from this baseline, and running
  the staging verification matrix already documented in
  `docs/SECURITY_HARDENING_ROLLOUT.md`.
- **SEC1A production application.**
- **Commit, push, and PR creation** for the SEC1A-RR1 artifacts themselves.

## Unresolved: storage.objects policy-DDL authority

This remains a mandatory staging gate, carried over unchanged from the
SEC1A design and audit work: `storage.objects` is owned by
`supabase_storage_admin`, not `postgres`, and catalog inspection has
consistently found no `pg_auth_members` membership path from `postgres`
into `supabase_storage_admin` in the live production project. SEC1A's own
preflight (`SEC1A-PRE-B4`) will stop rather than assume this authority
exists. Whatever role actually applies migrations in a real Supabase
staging/production context must be proven to hold this authority — or
proven to be a different, sufficiently-privileged role — before SEC1A can
be applied anywhere beyond source review. SEC1A-RR1 does not resolve this;
it only reproduces the same pre-SEC1A ownership structure in its baseline
so that this question can eventually be tested for real, on a real staging
branch, under separate authorization.

## What this work does not claim

- It does not claim the production migration ledger has been repaired —
  only tracking metadata realignment, not yet performed, could do that.
- It does not claim a staging branch exists — none was created.
- It does not claim SEC1A has been applied anywhere — it has not.
- It does not claim production equivalence is proven by source inspection
  alone — the [catalog comparison](#catalog-comparison) section above is
  the actual evidence, and its scope (structural counts, not an exhaustive
  per-column byte diff) is stated precisely rather than overstated.
