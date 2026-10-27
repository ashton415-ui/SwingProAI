# ENT-1D hosted preflight findings (read-only, sanitized)

Status: CANDIDATE evidence. Read-only inspection on 2026-10-27 (UTC) under the
ENT-1D read-only hosted preflight authorization. No hosted mutation, customer
row, row count, secret value, provider call, worker invocation, key rotation or
deployment change was made. This file records observations and options; it
authorizes nothing.

Sections 1-8 are the observations of that inspection, dated 2026-10-27 and
kept as recorded. Later events are in "Status update" below; where they
differ, the update is current. Run identifiers (`ent1d-…`) name local test evidence
that is retained outside this repository; it is not part of the commit.

Redactions: webhook URL, path, query and header values; account identities in
migration ledgers (`created_by`); environment variable values. This published
copy also omits hosted project references and numbers, cloud project IDs,
deployment IDs, revision names, image digests and storage locations; where an
item must be distinguished, it is named by role. Those identifiers, and the
exact restoration details for the containment below, are kept with the
restricted evidence outside this repository. One query inadvertently read
invocation dates from `supabase_functions.hooks` (a per-invocation request
log, not a hook definition table); those dates are not recorded here or used
anywhere.

## Status update (2026-10-27, after this inspection)

**Legacy worker source.** The Cloud Run `swingpro-worker` source archive was
later inspected read-only under a separate authorization. Build provenance ties
it to the live revision's image (the buildpack image layers themselves were not
inspected). The deployed code has one route, `POST /process-swing`; no request
authentication; a service-role client; writes only the `swings` table; and no
AI provider calls. It does not write `swing_analysis` or `swing_videos`, so it
is not an ENT-1D writer. Its completed rows carry fixed, hard-coded results.

**Legacy worker containment (CONTAINMENT_COMPLETE).** Under a separate owner
authorization:

- The public invoker binding (`roles/run.invoker` for `allUsers`) was removed
  from the service. No service-level binding remains; ingress, revision and
  traffic were not changed.
- The production storage webhook that called the worker on every
  `storage.objects` insert was deleted by the owner in the Supabase
  dashboard, after its definition was backed up outside Git. Afterwards no
  database trigger calls `supabase_functions.http_request()`, and the
  remaining `storage.objects` triggers matched their baseline.

Limits of what this establishes:

- Nothing was invoked to test either change; refusal of unauthenticated
  requests is what Cloud Run IAM implies, not an observation.
- Requests already in flight before the changes may have completed.
- Project owner and editor principals can still invoke the service;
  organization- and folder-level IAM was not inspectable.
- What the worker did while it was public, and its effect on existing rows,
  was not assessed and is not accepted by this record.
- Restoring either the binding or the webhook requires separate owner
  approval after the worker is remediated.

## 1. Database identity and ENT-1D compatibility

| | Production | Staging |
|---|---|---|
| Project | production project | staging project |
| PostgreSQL | 17.6 (`server_version_num` 170006) | 17.6 (170006) |
| Owner of both tables | `postgres` | `postgres` |
| RLS on both tables / force | on / off | on / off |
| Browser ACL profile | **production** (exact) | **sec0a** (exact) |
| Grantor of every table entry | `postgres` | `postgres` |
| Grant options, PUBLIC grants, column ACLs | none | none |
| Memberships of anon / authenticated | none | none |
| anon / authenticated SUPERUSER or BYPASSRLS | no | no |
| Table grantees | postgres, anon, authenticated, service_role | same |
| service_role | all 8 on both tables | same |
| ENT-1D objects present | none | none |
| Publications, views, SECURITY DEFINER functions on the tables | none | none |
| pg_graphql / pg_cron | absent | absent |
| pg_net | 0.20.3 | absent |

Per migration (as now written):

| Migration | Production | Staging |
|---|---|---|
| M1 lease (LEASE-PRE-1..4) | passes | passes |
| M1b proof column (PROOF-PRE-1..3) | passes after M1 | passes after M1 |
| M2 privileges (PRIV-PRE-1..13) | passes after M1 (production profile) | passes after M1 (sec0a profile) |
| M3 claim guard (GUARD-PRE-1..3) | after M1, M1b, M2 | after M1, M1b, M2 |
| M4 video guard (VIDEO-PRE-1..3) | passes | passes |

Before the change recorded in section 2, M2 failed closed on staging
(PRE-5/PRE-6).

Other drift observed (outside ENT-1D scope):

- staging only: `public.handle_new_user` (SECURITY DEFINER) is executable by
  anon and authenticated;
- the table policies on both tables apply to `{PUBLIC}`, and PRE-3 accepts
  any SELECT policy (pre-existing; not tightened here).

## 2. The staging-only migration and the M2 change

**Provenance.** Staging ledger entry `20261013034848
pricing2_sec0a_harden_seven_table_privileges` holds one statement of 55,789
bytes. It is byte-identical (md5 `e5c13967be2c368e1f7f2b2106dd0f2f`) to
the PRICING-2 file `20261012134114_pricing2_sec0a_harden_seven_table_privileges.sql`
in a separate local PRICING-2 worktree (on `main` 7ad1238), where that file
is **untracked and never committed**. Its test file and its
`lib/migration-inventory.ts` entry are also uncommitted. No local or remote
Git ref contains it. It is absent from production and from this candidate.

**Effect.** Its only change is `revoke truncate, references, trigger, maintain
... from anon, authenticated` on seven tables. Those are `swing_analysis`,
`swing_videos`, `rounds`, `user_goals`, `user_equipment`,
`launch_monitor_data` and `launch_monitor_sessions`. It has exact
preflight/postflight checks and touches nothing else (service_role, PUBLIC,
default privileges, policies, rows).

**Repository replay.** It was deliberately **not** added to this branch's
replay. It belongs to PRICING-2, covers five tables outside ENT-1D, and its
ownership and release decision sit with that work order.

**M2 change.** The preflight now accepts exactly two coherent profiles. The
profile is chosen once and must hold for all four (role, table) sets.

| Table | production | sec0a |
|---|---|---|
| swing_analysis | DELETE, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE | DELETE, SELECT |
| swing_videos | DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE | DELETE, INSERT, SELECT |

It also adds fail-closed checks:

- **PRE-9:** owner not `postgres`, or a grantor other than the owner;
- **PRE-10:** any column ACL;
- **PRE-11:** anon or authenticated is a member of a role;
- **PRE-12:** a table grantee outside {owner, anon, authenticated, service_role};
- **PRE-13:** anon or authenticated is SUPERUSER or BYPASSRLS.

The body and postflight are unchanged, so both profiles end in the identical
least-privilege state. No privilege is restored to satisfy the preflight.

**CLI splitter defect found and avoided.** Supabase CLI 2.117.0 split the DO
block of the first draft mid-statement when an `IF v_set = CASE ... END THEN`
appeared inside the dollar-quoted body. The error was "syntax error at end of
input" at statement 0. It was isolated on a disposable stack by probes that
append `select 1 / 0`:

- the pre-edit file splits correctly;
- the same draft with only that expression parenthesised splits correctly;
- removing other edits or shifting byte offsets did not help.

The final file assigns the expected set to a variable first. The CLI's
internal cause is unverified.

**Local acceptance** (run `ent1d-m2compat-cecc3867`, disposable stack):

- Replay ran through M1b. M2 was then applied by `supabase migration up`
  from the production profile.
- `ent1d_m2_preflight_negative.sh` passed 38/38 cases:
  - **both starting profiles** end at one identical snapshot (C12, C15, C26,
    C27b);
  - **mixes, subsets, grant options, foreign grantor and owner, column ACLs,
    memberships, extra grantees, BYPASSRLS and double-apply** fail with the
    expected code and leave the state unchanged;
  - **atomicity:** a failure after M2's revokes inside the psql transaction
    (C25) and inside the CLI runner's file (C27) leaves nothing behind.
- The full guard-off and guard-on phases passed after M3/M4 were applied by
  the CLI:
  - claim-guard, video-source, claim-module and analyze-route suites;
  - acceptance SQL and single session;
  - PostgREST 62/62;
  - concurrency 29/29 off and 31/31 on;
  - guard preflight 15/15.
- Unit suite 6047/6047. tsc: the same 7 pre-existing errors in three
  untouched test files.
- Teardown left no run resources.

Two earlier attempts are recorded honestly:

- **Run `ent1d-m2compat-41fcdfa4`** found the splitter defect. A harness
  restore bug (the reserved-role ALTER) then invalidated its later steps. It
  was torn down and is not evidence of a pass.
- **Run `cecc3867`'s first harness pass** aborted on a second restore gap (a
  service_role grant option). The harness now stops on any failed restore.
  The stack was returned to the recorded baseline digest and the harness
  re-run in full.

## 3. Migration application mechanism (evidence, not adoption)

Ledger shape on both projects (`supabase_migrations.schema_migrations`):

- **Pattern A** (prod 2026-06-02 … 2026-10-10; all staging entries but one):
  - one whole-file statement;
  - `created_by` set to an account;
  - no idempotency key;
  - version assigned at apply time.

  Nine production entries applied since 2026-08-20 (including every entry
  since 2026-09-26) are byte-identical to the repository files. The staging SEC0A entry is
  byte-identical to its local file. This is the recording shape of the
  Management API `POST /v1/projects/{ref}/database/migrations` endpoint. Per
  Supabase docs, that endpoint "will automatically create a migration inside
  the supabase_migrations schema and run the migration. If the schema
  migration fails, the changes will be rolled back." The Supabase MCP
  `apply_migration` tool is one client of it. Which client recorded each row
  is not provable from the ledger.
- **Pattern B** (production 2026-07-21 … 2026-08-04, plus
  `equipment_non_putter_catalog_v2` on both):
  - multiple split statements;
  - `created_by` null;
  - versions equal to the repository filenames.

  This is consistent with the CLI (`db push` / `migration up`).

Several older production entries do not byte-match the current repository
files (edited after application, or split differently).

**Consequences**

- **`supabase db push`:** compares local files with the ledger by version.
  - Production has 16 pattern-A versions that no local file carries, so push
    reports the history as out of sync and requires `migration repair`.
  - Repair writes or deletes ledger rows without running SQL, so it is
    excluded as a fabrication of history.
- **Supported, reviewable path:**
  - submit each ENT-1D file verbatim, one call per file, in order, through
    the migrations endpoint (pattern A);
  - each call is one transaction and records one ledger row with a new
    version;
  - verify the result with
    `md5(array_to_string(statements, E'\n'))` = the local file's md5, plus
    the post-apply catalog query.

  The local file's SHA-256 is recorded separately.
- **Timeouts:**
  - the endpoint session observed via the connector runs as `postgres` with
    `statement_timeout = 2min` and `lock_timeout = 0`;
  - `authenticator` has `statement_timeout = 8s`, `lock_timeout = 8s`.

  M1 and M1b take ACCESS EXCLUSIVE locks (ADD COLUMN, ADD CONSTRAINT with a
  validating scan). With `lock_timeout = 0` a blocked lock queues every API
  query on `swing_analysis` for up to two minutes.

  **Implemented locally:** each ENT-1D file now begins with
  `set local lock_timeout = '3s';`. The SQL body is otherwise byte-identical.
  On timeout, retry in a quiet window. The default statement timeout stays.
  Contention results are in section 8.

## 4. Writers and access: verified versus unverified

**Database writers to `swing_analysis` / `swing_videos`.**

| Source | Evidence | Status |
|---|---|---|
| Production query statistics since 2026-06-21 | service_role shapes: analysis insert (club_id, id, swing_video_id, user_id); putting completion update. authenticated: historical inserts/updates from before the ARA revoke, and swing_videos inserts. One operator `postgres` insert shape. | Observed shapes only. Absence of a shape does not prove a writer cannot run. |
| Vercel production build (main 842f6b6) | analyze-swing claims and completes via service_role (`createAdminClient`) | in repo; no full-swing service_role claim/complete shape recorded since 2026-06-21 |
| `ai-backend` (FastAPI, on main) | mounted routes call Gemini and return; the only DB writer (`app/swing.py` → `swing_analyses`) is not mounted | deployed revision and host UNVERIFIED (`AI_BACKEND_URL` value not read) |
| Cloud Run `swingpro-worker` | See the Cloud Run detail below. | deployed source UNVERIFIED at the time; since inspected: writes only `swings` (Status update) |
| Edge function `process-swing-video` (production only, active, `verify_jwt=false`) | deployed source, retrieved by the release manager (not invoked): acknowledges Storage events and returns "Deferred to worker pipeline"; no database writes or provider calls in its implementation | not a writer per deployed source; says nothing about the Cloud Run worker |
| Mobile app (`swingproai-app`, Expo `swingpro-mobile`) | local source (branch `fix/mobile-pipeline-phase-1` 5d8d493): uploads `<userId>/<ms>.mp4` to `swing-videos` (or `drill_videos`) with the user's token; inserts `swings`; POSTs `{swingId, storagePath, equipmentContext}` or `{drillId, userId, storagePath}` to `${EXPO_PUBLIC_WORKER_URL}/analyze` (build-time value, not in repo); no `swing_analysis`/`swing_videos` access | distributed build and its worker URL UNVERIFIED |
| Google AI Studio applet (separate cloud project) | `managed-by: google-ai-studio`; env names `APPLET_ID`, `GEMINI_API_KEY`, `PROXY_CONFIG` only (no Supabase credential by name); latest revision 2026-09-01; no IAM bindings | candidate only for `AI_BACKEND_URL`; not shown to be it |
| `swingmaster-web` tree | browser inserts swing_videos with a URL and swing_analysis(status pending) | deployment UNVERIFIED; swing_analysis insert already refused by grants |
| `/api/v1/swing-data` (same on main and candidate) | session inserts swing_videos without `video_url` | already non-functional (NOT NULL `video_url`; no INSERT on swing_analysis) |
| pg_cron, other webhooks, triggers calling `net.http_*` | none | verified absent |
| Render worker | no definition or configuration found | UNVERIFIED |

**Cloud Run `swingpro-worker`** (as observed during this inspection, before
the containment in the Status update). Metadata was read with the already
authenticated gcloud CLI (fields restricted; no values, logs, payloads or
source contents).

- **Project:** its project number matched the webhook host. The project holds
  no other Cloud Run service.
- **Live revision:** one revision took 100% of traffic.
  - Created 2026-07-08.
  - Built by `gcloud run deploy --source` from a source archive uploaded the
    same day.
  - No git or source labels.
- **Revision history:** 14 revisions, 2026-07-07 … 2026-07-08.
- **Exposure at the time:**
  - ingress `all`;
  - IAM `roles/run.invoker` → **`allUsers`** (public); removed since (Status
    update);
  - runs as the default compute service account;
  - concurrency 80, timeout 600 s, max 20 instances.
- **Credentials held:** environment variable names `SUPABASE_URL` and
  **`SUPABASE_SERVICE_KEY`**, both plain literals, not Secret Manager
  references. Values were not read.
- **Source match:** no known source revision provably equals the deployed
  archive.
  - The earliest committed worker source, `3973711` ("Baseline existing swing
    analysis worker before Phase 2"), is dated 2026-07-15.
  - The untracked local copy's `index.js` was modified 2026-07-14. Both are
    later than the deploy.
  - All known revisions write `swings`, `user_drills` and `drills` reads.
    Phase-2 branches use `swing_analysis_jobs` RPCs that do not exist hosted.
  - Worker authentication and ownership checks first appear in `bf73f73`
    (2026-07-16), also after the deploy.

  So, at the time of this inspection, the deployed worker was a public
  endpoint holding a service-role key, with an unknown write contract. The
  later source inspection settled the contract (it writes only `swings`, with
  no request authentication), and the public binding and the webhook have
  since been removed (Status update).

**RLS ownership predicates** (catalog, identical on production and staging):

| Table | Policies (command) | Roles | Predicate |
|---|---|---|---|
| `swing_analysis` | select, insert, update, delete | `{PUBLIC}` | `auth.uid() = user_id` (USING; WITH CHECK for insert) |
| `swing_videos` | select, insert, update, delete | `{PUBLIC}` | `auth.uid() = user_id` |
| `storage.objects` | read, insert, delete for `swing-videos`; read, insert for `drill_videos` | `{authenticated}` | `bucket_id = '<bucket>' and (storage.foldername(name))[1] = auth.uid()::text` |

No policy uses `true` or another non-owner predicate. `storage.objects` has
no UPDATE policy. These predicates bind browser sessions only: the
service-role key bypasses RLS. Row isolation for anything holding it (Vercel
server routes, the Cloud Run worker) rests on that code, not on these
policies or on the privilege hardening.

**Owner-supplied metadata still needed** (no connector or authorization
available here):

1. **Cloud Run `swingpro-worker` source.** Resolved since: the deployed
   archive was inspected read-only (Status update). Its location is recorded
   with the restricted evidence, not here.
2. **`AI_BACKEND_URL`:**
   - the hostname only;
   - Vercel → the production project → Settings → Environment Variables →
     `AI_BACKEND_URL` (stored as sensitive, so not readable here).
3. **Later, not blocking the worker question:**
   - the distributed mobile build and its worker URL;
   - whether `swingmaster-web` or any Render service is deployed.

## 5. Deployment inventory (corrected)

| Item | Confirmed | Not confirmed |
|---|---|---|
| Current production deployment (production web project) | source git main 842f6b6; READY; aliases www/apex custom domains + three `*.vercel.app` aliases | that runtime traffic reaches only it |
| Protection (production web project and a second, older web project) | SSO `all_except_custom_domains`; password and trusted IPs off | bypass tokens, shareable links |
| Old deployments (production web project: 278 production, 82 preview; second project: 40) | exist, READY, SSO-protected generated URLs | reachability, credentials each holds, whether any is invoked |
| Staging web project | no deployments; SSO `all`; Supabase URL = staging project | — |
| Env names / targets (production web project) | Preview and Production both list `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AI_BACKEND_URL`, `AI_BACKEND_SECRET`, Supabase URL/anon key | that Preview and Production hold the same values; which Supabase project each points to (masked) |
| Database identity of Vercel builds | staging project explicit; production inferred from query shapes matching current code | per-deployment database target |

Masked key presence does not show that two deployments hold the same key.
Historical deployments are potential, not confirmed, writers.

## 6. Retirement and access-control options (not performed)

| Option | Stops | Consumers affected | Rollback consequence |
|---|---|---|---|
| Delete specific old deployments (per ID) | invocation of those builds; 30-day recovery window per Vercel | anyone using those preview links | removes them as instant-rollback targets (intended after M3) |
| Deployment retention policy | future accumulation; ages out old builds | same, by age | same, for aged builds |
| Tighten protection to all deployments | not usable: it would cover the public custom domains | public site | — |
| Remove protection bypass / shareable links (if any) | automation access to old builds | CI or tools that use them | none |
| Scope `SUPABASE_SERVICE_ROLE_KEY` and provider keys to Production only | new previews getting server credentials | preview testing of server flows | none; existing deployments keep their build-time values |
| Supabase: create a new secret API key for the new build, then revoke the key old builds hold | every holder of the old key, including old deployments | all unknown holders (Cloud Run worker, which still holds a service-role key, edge function, AI backend, scripts) unless migrated first | old builds lose DB access; requires the section 4 inventory first |
| Rotate the legacy JWT secret | every anon and service key at once | web, mobile, workers: broad outage risk | not recommended |
| Provider keys (Gemini/OpenAI): issue new, revoke old | old builds' provider calls, which the DB guard cannot stop | every holder | old builds fail at the provider |

Least-disruptive order (proposal):

1. Complete the writer inventory.
2. Scope preview credentials.
3. Delete or retire old deployments by explicit list.
4. Only then consider per-key revocation for holders that were inventoried and
   migrated.

## 7. Prepared historical-data checks (NOT executed)

The owner excluded customer rows and counts. These are written as
aggregate-only queries for a future authorization:

- H1: status distribution;
- H2: processing rows by age;
- H3: swing_videos keys failing the canonical rule;
- H4: `video_url <> storage_path`;
- H5: analyses per swing_video_id > 1;
- H6: webhook response-status distribution.

## 8. Lock-timeout protection (local acceptance)

Each ENT-1D file now starts with `set local lock_timeout = '3s';`, followed
by a DO block. The DO block raises `ENT1D-LOCK-TIMEOUT` unless the setting is
active. `SET LOCAL` outside a transaction is a no-op, so this makes a
non-transactional runner fail closed. The rest of each file is unchanged:
removing the block yields the previously accepted bytes.

Run `ent1d-locktimeout-7717324f` used a disposable stack replayed up to
ENT-1D. Each file was applied by `supabase migration up` while a second
session held a lock on the target table:

| File | Blocker | Result |
|---|---|---|
| M1 lease | ROW EXCLUSIVE (in-flight write) | SQLSTATE 55P03 after ~3.9 s; no ledger row; schema fingerprint unchanged; then applied normally |
| M1b proof column | ROW EXCLUSIVE | 55P03 after ~4.0 s; unchanged; then applied |
| M2 privileges | ACCESS EXCLUSIVE | applied while held: GRANT/REVOKE take no conflicting table lock |
| M3 claim guard | ACCESS EXCLUSIVE | 55P03 after ~3.9 s (its diagnostic count needs ACCESS SHARE); unchanged |
| M3 claim guard | ROW EXCLUSIVE | applied while held (replaces a function body only) |
| M4 video guard | ROW EXCLUSIVE on swing_videos | 55P03 after ~4.0 s; unchanged; then applied |

Elapsed time includes about 1 s of CLI overhead. Other checks in the same
run:

- **One psql session:**
  - `lock_timeout` was 0 before the transaction, 3s inside it, and 0 after
    commit;
  - it was 3s inside and 0 after rollback;
  - outside a transaction, `SET LOCAL` only warns.
- **Autocommit application** (`psql -f`, no transaction) stopped at
  `ENT1D-LOCK-TIMEOUT` with the schema unchanged.
- **Unchanged after the run:** role and database settings
  (`pg_db_role_setting`) and the session `lock_timeout`.
- **Affected checks, rerun:**
  - guard preflight 15/15;
  - M2 harness 38/38;
  - acceptance SQL 5/5;
  - single session 4/4;
  - the 30 migration-reading unit files, 2535 tests (including a new static
    test on all five files).

**Not verified:** that the hosted Management API endpoint runs each file in
one transaction. Docs say it rolls back on failure. If it did not, the new
check would make the file fail at its first statement rather than run without
a lock limit.

**Retry rule:** a 55P03 failure applies nothing and records no ledger row.
Retry the same file later. Do not edit it. Lock limits do not bound the
lease migration's backfill UPDATE and validating CHECK scan, which run under
ACCESS EXCLUSIVE once acquired. Their duration depends on `swing_analysis`
size, which was not measured: customer counts are excluded.
