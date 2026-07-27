# SEC1A-RR1 — Migration Replay Recovery

## Status: canonical baseline merged and hosted-validated; production ledger not yet realigned

This document describes `supabase/migrations/20260721220000_swingproai_production_baseline.sql`,
a canonical baseline migration, and the historical migration-history bridge
files that accompany it. Their current status, stated precisely and without
conflating distinct facts:

- The canonical baseline **source is merged** to `main` (PR #5).
- It has been **validated locally** against a real Supabase-flavored
  PostgreSQL instance (see [Local validation](#local-validation) below).
- It has been **applied successfully to the standalone hosted staging
  project** `swingproai-eq1-s3-staging` (ref `vyusdgvongfdzoteqyxz`).
- It has **never been executed against production**
  (`atlmnqispyzhsahahpjy`). No live policy, grant, table, row, or
  configuration on the hosted production project has been changed by any of
  this work.
- The **production migration ledger remains unrepaired** — it still does not
  contain the canonical baseline timestamp, and this document does not claim
  otherwise.
- **EQ1-S1R** (`20260725020835_equipment_intelligence_putting_foundation.sql`)
  and **EQ1-S2** (`20260725174239_equipment_putter_catalog_v1.sql`) have also
  been validated end-to-end against that same standalone staging project.

Hosted staging validation used the standalone project's own MCP-generated
ledger version `20260726171411` for this baseline — **never** the canonical
source timestamp `20260721220000`, which has not been recorded in any hosted
project's ledger. These two timestamps identify the same source content but
are never interchangeable when reading a ledger export; do not conflate them.

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
4. **Retained standalone staging project state** — a real, currently active,
   billed Supabase project (`swingproai-eq1-s3-staging`, ref
   `vyusdgvongfdzoteqyxz`) built by applying the canonical baseline,
   EQ1-S1R, and EQ1-S2 to a fresh empty database, for the purpose of
   validating all three end-to-end before any production change. This
   state **does exist** and is currently retained pending the production
   rollout gates below; it incurs ongoing monthly cost until deleted. Its
   ledger uses MCP-generated versions, not the canonical/historical
   production timestamps:

   | Migration | Staging ledger version |
   |---|---|
   | Canonical baseline | `20260726171411` |
   | EQ1-S1R | `20260726173526` |
   | EQ1-S2 | `20260726174518` |

   Current catalog state: 5 manufacturers / 21 models / 21 putter specs / 21
   provenance sources. Current Auth and synthetic-test-data residue: zero —
   all disposable-identity and synthetic-row validation work has been fully
   cleaned up.

SEC1A-RR1 originally produced artifacts relevant to state 3 only. Later work
(EQ1-S3) created and retains state 4 as described above. States 1 and 2
remain untouched by any of this work; production has received zero writes.

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
2. The 16 historical migration-history bridge files (see
   [The 16 historical migration-history bridge files](#the-16-historical-migration-history-bridge-files)
   below) reconcile *local* migration history against the *remote* ledger
   first, without changing production in any way. This is a prerequisite
   for using standard Supabase CLI tooling against production at all — it
   is not itself a ledger realignment.
3. **Baseline-timestamp repair remains a later, separate,
   production-ledger-mutating gate.** Implementing the bridge files does not
   perform, and is not, that repair. As of this document, **no
   production-ledger mutation of any kind has occurred.**
4. When that separate gate is authorized, the ledger will be realigned by
   marking the baseline's timestamp (`20260721220000`) as applied in the
   ledger *without* executing its DDL against production (since production's
   schema already has this content).
5. Perform that ledger write as its own isolated, explicitly authorized
   action, separate from any schema change and separate from the bridge-file
   implementation described in this document.

**Ledger repair changes tracking metadata only and must never execute this
baseline's DDL against production** — production's schema already has the
tables, functions, triggers, and policies this file creates; running the
file's `CREATE TABLE`/`CREATE POLICY`/etc. statements against production
would fail immediately at this file's own clean-environment preflight
(`RR1-PRE-1`), by design.

## The 16 historical migration-history bridge files

Production's migration ledger contains 16 historical versions
(`20260602035147` through `20260712143342`) that have no corresponding file
anywhere in this repository's `supabase/migrations` directory. This is the
same defect documented above under
[The migration-ledger replay defects](#the-migration-ledger-replay-defects):
the recorded history is real (production's ledger genuinely contains these
16 rows) but the repository never checked in matching migration files for
them.

This absence has a direct, empirically proven consequence for standard
Supabase CLI tooling: `supabase db push` refuses to run — even in
`--dry-run` mode — whenever the linked project's remote ledger contains any
version absent from the local `supabase/migrations` directory. See
[Empirical CLI evidence](#empirical-cli-evidence-eq1-p1r2--eq1-p1r3) below
for the exact observed behavior, including that the `--include-all` flag
does not bypass this refusal.

`supabase migration fetch` can reproduce the actual, byte-exact historical
SQL payloads stored in production's ledger, and doing so does remove the
`db push` refusal. However, that reproduced 16-file chain is **proven not to
replay from empty** — a real local replay attempt fails partway through, at
`coach_hub_tables`, because it references `public.drills` before any
migration in the chain creates it (see
[The migration-ledger replay defects](#the-migration-ledger-replay-defects)).
Committing that fetched, known-broken chain permanently to this repository
would silently hand every future fresh-environment consumer (CI, a new
developer, a future staging rebuild) a migration history that fails loudly
and confusingly the moment they try to use it.

Instead, this repository commits 16 **comment-only, no-op bridge files**,
using the exact 16 historical timestamps and migration names, containing no
executable SQL whatsoever. Their properties:

- **CLI matching is timestamp-based only** — `supabase migration list` and
  `supabase db push` compare local and remote migration history purely by
  timestamp, never by file content. A comment-only file with the correct
  timestamp satisfies this comparison exactly as well as the real historical
  SQL would.
- **Production treats them as already applied.** Every one of the 16
  timestamps already exists in production's real ledger; the bridge files
  never cause any of them to be (re-)applied, because their timestamps are
  never "pending" against a project whose ledger already contains them.
- **A fresh replay (a genuinely empty database, or a future re-creation of
  the standalone staging project) executes all 16 files as true no-ops** —
  they contain no SQL — and only then reaches the canonical baseline at
  `20260721220000_swingproai_production_baseline.sql`, which builds the full
  schema from there.
- **Production's own ledger remains the sole authoritative source** for the
  16 historical statements' actual payloads. This repository does not
  attempt to reproduce, approximate, or fabricate that content.
- **Bridge files are not original migration bodies** and must never be
  edited to pretend otherwise.
- **Bridge files are not migration repair.** They are ordinary repository
  files; committing them changes nothing about any hosted project's ledger,
  schema, or data. `supabase migration repair` — a separate, later,
  separately-gated action — is what would ever mutate a hosted ledger.
- **Bridge files do not modify production, or any hosted project, in any
  way.** Adding them to this repository is a purely local, git-tracked
  change.

### Empirical CLI evidence (EQ1-P1R2 / EQ1-P1R3)

All of the following was directly observed using the installed Supabase CLI,
version `2.109.1`, invoked read-only/dry-run-only against the real
production project (`atlmnqispyzhsahahpjy`) — not inferred from
documentation alone.

**Before any local historical counterparts existed:**

- `supabase migration list` succeeds (exit 0) and displays the divergence:
  16 remote-only entries, 3 local-only entries (baseline, EQ1-S1R, EQ1-S2).
- `supabase db push --dry-run` fails (exit 1): *"Remote migration versions
  not found in local migrations directory."*
- `supabase db push --dry-run --include-all` fails identically — the
  `--include-all` flag does not bypass this refusal.

**With the real historical SQL fetched locally** (`supabase migration
fetch`, never committed to this repository):

- `supabase db push --dry-run` succeeds and proposes exactly the canonical
  baseline, EQ1-S1R, and EQ1-S2 — none of the 16 fetched historical files.

**With the 16 comment-only bridge files described above** (the files this
repository actually commits):

- `supabase db push --dry-run` succeeds and proposes exactly the same three
  files: the canonical baseline, EQ1-S1R, and EQ1-S2.

**With the canonical baseline and EQ1-S2 temporarily omitted, leaving only
the 16 bridge files plus EQ1-S1R** (an isolation simulation, never applied to
any hosted project):

- `supabase db push --dry-run` proposes exactly one file: EQ1-S1R.

No real (non-dry-run) push was performed at any point during this
evidence-gathering. Production and the standalone staging project were both
independently reconfirmed unchanged after every probe.

## Source-control status

The SEC1A-RR1 artifacts were committed and pushed to
`fix/sec1a-rr1-migration-replay-baseline`, and PR #5 was opened against
`main`. **PR #5 is merged.**

Later, independently authorized work also merged to `main`:

- **PR #13** — EQ1-S1R equipment intelligence and putting foundation, merge
  commit `72290544a4f226d4300999353ca9feba2b571cca`.
- **PR #14** — EQ1-S2 curated putter catalog, merge commit
  `07a9d9f7d6c32f8b9509366df6cd50dff81b8b88`.

None of these merges applied the baseline, altered the production migration
ledger, created a Supabase branch, or executed SEC1A.

## Remaining separately-authorized gates

Each of the following still requires its own separate, explicit
authorization and has not occurred as part of this work:

1. Bridge implementation (this document's own subject).
2. Independent bridge-implementation audit.
3. Commit.
4. Commit audit.
5. Push.
6. Remote-push audit.
7. Draft pull request.
8. Independent PR audit.
9. Ready-for-review transition.
10. Merge-readiness audit.
11. Explicit merge.
12. Post-merge verification.
13. Production baseline-ledger repair.
14. Independent ledger verification.
15. EQ1-S1R application to production.
16. EQ1-S1R production verification.
17. EQ1-S2 application to production.
18. EQ1-S2 production verification.
19. Final production audit.
20. Staging-deletion decision.

No later gate in this list is authorized by the completion of an earlier
one. Each requires its own separate, explicit authorization.

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
- It does not claim a Supabase *Branch* was created — none was. The retained
  validation environment described in
  [Four distinct states](#four-distinct-states--do-not-conflate-them) is the
  standalone project `swingproai-eq1-s3-staging`, not a Supabase Branch.
- It does not claim SEC1A has been applied anywhere — it has not.
- It does not claim production equivalence is proven by source inspection
  alone — the [catalog comparison](#catalog-comparison) section above is
  the actual evidence, and its scope (structural counts, not an exhaustive
  per-column byte diff) is stated precisely rather than overstated.
