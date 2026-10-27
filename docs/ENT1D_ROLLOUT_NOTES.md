# ENT-1D rollout notes: execution lease, claim guard, result privileges and owner-bound video sources

Status: CANDIDATE. These notes record requirements; they do not authorize any
migration, deployment, rollback or production action. Every step below needs
its own owner authorization.

**Evidence.** Detailed local test evidence (logs, results files, screenshots,
harness copies) is retained outside this repository and is not part of the
commit. It was produced on disposable local Supabase stacks with synthetic
golfers and a mocked AI provider; credentials files and credential lines were
never copied into it. It is identified by run ID, and the key files by
SHA-256:

| Run | What it covers | Key file (SHA-256) |
|---|---|---|
| `ent1d-accept-91a418d1`, `-8b3ba285`, `-bc1521d1`, `-2460b0eb`, `-859d3af1` | earlier database and application acceptance passes | — |
| `ent1d-accept-30d9f7c9` | final database regression, including the R1b reproduction (guard off) and prevention (guard on) | `vitest-claim-guard-guard-off.log` `9d813af297ea46f6f61fe850719e3f31ec402905b002a1b59a36415b18358ae2`; `vitest-claim-guard-guard-on.log` `c9ff922348ebd991cbb80fce50264d5ce707429edc20888268a71e2bbcbce6ee` |
| `ent1d-accept-9dd7d1c0` | confirmation of the cascade depth check | — |
| `ent1d-m2compat-cecc3867` | migration 2 two-profile preflight | — |
| `ent1d-locktimeout-7717324f` | lock-timeout contention (findings section 8) | — |
| `ent1d-browser-4ebd8dc2`, `ent1d-browser-624f0d28` | production-build browser acceptance (upload, analysis, report, playback, putting, entitlement, failure and recovery, phone, keyboard) | `results-final.json` `187a15fbde1d95a7e1f7d4c221d4a47522c1ea823b2606ab89420c27da4ba31b`; `afdf3d871acc680ba5f929bb58cd17e733f2d7afb4aea8fb1bd803f8d6d932ce` |
| `ent1d-final-5d94605c` | final candidate: measurement provenance, reloaded unusable-video state, affected browser paths | `results-final.json` `aace47aa70f5951efc42c463b46881d1ed1c98b3b17046638c2fc25b67417922`; candidate manifest `manifest-sha256-final.txt` `9243b51574a5b91174960d6ba96840b2f2411c781fcafac4fc33c133ae6ace98` (taken before this documentation cleanup, which changed only the two ENT-1D documents) |

Results summary of the final candidate (local only):

- unit suite 6145/6145; typecheck clean;
- application-to-database integration against the local stack: on the final
  candidate, video-source 17/17 and analyze-route 14/14 with the guards on;
  the guard-off phase (mixed-version, claim-guard, claim-module,
  analyze-route) last ran on the preceding candidate (run
  `ent1d-browser-624f0d28`), before the final prompt-wording and read-only
  failure-classifier changes;
- production build with no warnings and no test-only code in the artifact;
  browser acceptance of the affected paths with no failures.

None of it is hosted, deployment-order, physical-device or real-provider
evidence.

## Artifacts

| # | Migration | What it does |
|---|---|---|
| 1 | `20261026120000_ent1d_analysis_execution_lease.sql` | lease columns, claim-shape CHECK, backfill (additive) |
| 1b | `20261026120050_ent1d_claim_proof_column.sql` | `processing_claim_proof` column + a trigger that only consumes it (inert) |
| 2 | `20261026120100_ent1d_analysis_result_privileges.sql` | browser privilege hardening |
| 3 | `20261027120000_ent1d_execution_claim_guard.sql` | enforcing claim contract (R1b, option C) |
| 4 | `20261027120100_ent1d_swing_video_source_guard.sql` | canonical owner-bound `storage_path`; `video_url = storage_path` |

Application: `lib/analysis-execution-claim.ts` (claims; every holder write
carries the claim proof), `lib/swing-video-source.ts` (owner-bound video
sources), `app/api/analyze-swing/route.ts`, the two playback pages, and the
legacy upload server action (records `video_url` as the key).

## 1. The database claim contract (R1, R1b)

**R1** (fixed earlier in the application): an undispatched release now clears
the whole lease, so an old status-only claim cannot inherit it.

**R1b, as found.** The pre-ENT-1D putting writes filter on neither status nor
claim (HEAD 168bd88 `route.ts:540-545`, `:562-566`). An overlapping old
putting request could overwrite a live ENT-1D claim. Two variants were
reproduced locally with the exact old writes and the real claim module
(run `ent1d-accept-30d9f7c9`, `vitest-claim-guard-guard-off.log`; evidence
outside the repository):

- **undispatched:** the new app later took the row over while an old request
  ran;
- **dispatched:** the golfer's next request claimed the row while the first
  provider call ran.

**Option C, implemented as migrations 1b and 3.** A trigger sees OLD and NEW,
never the caller's WHERE clause, so it cannot know who issued a write. The
holder therefore proves itself in the row: every write it makes to its
claimed row sets `processing_claim_proof` to its claim id. The guard compares
that with the row's current claim and always discards it (a CHECK proves it
is never stored). The rules:

| Situation | Admitted |
|---|---|
| insert | only unclaimed and not `processing` |
| `pending`/`failed` → `processing` | only a claim: a new claim id, start and heartbeat, no dispatch (status-only claims refused) |
| claimed `processing` row, same claim | only with proof = current claim; it stays `processing` or becomes `failed` or `complete`; `complete` needs a recorded dispatch; a recorded dispatch is never changed; an unknown-outcome row (dispatched, epoch heartbeat) is not written at all |
| claimed row, claim cleared | only the holder's undispatched release, leaving `processing` |
| claimed row, claim replaced | only a takeover of an undispatched claim to a new undispatched claim |
| `processing` row with no lease | may only leave `processing`, with no lease |
| → `complete` | only from `processing` |
| `complete` | never rewritten (no column changes) |
| other rows | the lease is kept or cleared entirely |
| `club_id` / `telemetry_id` → null only, from a cascade | admitted (`ON DELETE SET NULL`; a direct write of the same change is refused) |

**What the guard does NOT establish:**

- **Lease expiry.** The application decides when a takeover is due.
- **Fencing for new code in general.** The application's WHERE clauses
  remain the fence; the proof additionally makes a stale holder's writes fail.
- **Anything about code already running.** A request that claimed a row
  before activation has made, or will make, its provider call. The guard only
  refuses that request's later writes when they touch a claimed row.

Verified locally with the guard active (run `ent1d-accept-30d9f7c9`,
`vitest-claim-guard-guard-on.log`; concurrency K28-K30):

- both R1b variants are prevented, and every old write shape is refused or
  harmless;
- an old write waiting on a live holder's row lock is refused when it
  re-evaluates against the holder's committed version;
- the new lifecycle is unchanged: claim, retry, takeover, dispatch, heartbeat,
  release, completion, and outcome-unknown.

**Which old build?** Two old route versions exist, and the live one must be
confirmed before activation (UNVERIFIED here):

- the main-line route (main `7ad1238`), most likely what serves today;
- HEAD 168bd88, the unmerged ENT-1A to ENT-1C candidate.

Both are exercised locally with their exact write shapes
(`supabase/tests/app-integration/ent1d-legacy-writes.ts`).

**Old code under the guard (from the main-line route source):**

- **Full swing:** its processing write (main `:832-836`) has no status filter.
  A refused write is only logged, and the route **calls the provider anyway**
  (`:840-844`). Its completion and failure writes (`:1144-1148`,
  `:1166-1168`) are unfiltered. It deliberately re-runs completed analyses.
  Under the guard, every one of those writes is refused on claimed, pending
  (completion) and completed rows, so no stored state is corrupted. **The
  provider call is not prevented: the guard protects rows, not spend.**
- **Video:** it also falls back to fetching `video_url` (main `:908`). That
  server-side request forgery path exists for as long as any main-line
  instance can be invoked.
- **Putting:** it stops on a refused processing write, as below.

**Old code under the guard (from the HEAD 168bd88 route source):**

- **Full swing:** a refused claim returns 503 before any provider call
  (HEAD `:917-920`).
- **Putting:** a refused processing write returns 500 before any provider call
  (HEAD `:573-578`). Its unfiltered failure write is refused on claimed,
  unknown-outcome and completed rows, but still admitted on `pending` rows (a
  harmless status change that a new claim then supersedes).
- **Limit:** an old request whose claim landed BEFORE activation can still
  finish its row (a lease-less `processing` row), and its provider call is
  outside any database control. Hence the drain in section 3.
- **Limit:** a main-line instance invoked after activation still spends a
  provider call per request, and still has its `video_url` fetch. Only
  retiring every old instance closes both (section 3).

## 2. Owner-bound video sources

- **The trust boundary.**
  - The server reads a golfer's video only from that golfer's own canonical
    object in the private `swing-videos` bucket.
  - The key is re-validated at every signing and download
    (`parseOwnedSwingVideoPath`), signed on the golfer's own session (so
    Storage's folder policy applies too), and accepted only if the signed URL
    is exactly the configured project's
    `/storage/v1/object/sign/swing-videos/<key>?token=...` (the whole string
    is compared).
  - It is downloaded with `redirect: "error"` and a byte limit.
  - `video_url` is never fetched, signed or played back.
  - Any failure means no video and no analysis, for both families. There is
    no fallback, and no text-only analysis (see "Unusable video" below).
- **Canonical key.** `<user_id>/<file>` or `<user_id>/<uuid>/<file>`, where
  file is 1-255 of `[A-Za-z0-9._-]` and not `.` or `..`. Nothing is decoded,
  trimmed or normalised. The TypeScript and SQL rules are the same, verified
  on 38 shared vectors (37 in SQL; PostgreSQL text cannot hold NUL).
- **Insert/update guard (migration 4).**
  - New or changed rows need a canonical key in the row owner's folder, and
    `video_url` equal to it.
  - It applies to every role, including server inserts.
  - RLS and grants are unchanged. The browser still has INSERT only, and the
    insert policy still binds `user_id`.
  - Object existence stays a separate Storage check (`/api/v1/analyses`); the
    guard never consults `storage.objects`.
- **Historical rows (compatibility policy).**
  - Nothing is deleted, rewritten or backfilled.
  - A non-canonical historical row keeps working for every write that leaves
    `storage_path`, `video_url` and `user_id` unchanged.
  - It has no video source: no inline analysis video, and no replay.
  - Diagnostic:

```sql
select id, user_id, storage_path, video_url, created_at
  from public.swing_videos
 where not public.ent1d_is_canonical_swing_video_key(storage_path, user_id)
    or video_url is distinct from storage_path;
```

- **Unusable video (D1).**
  - Before the provider is called, the loaded bytes must be at least
    `MIN_VIDEO_BYTES` (1 KB), at most `MAX_ANALYSIS_VIDEO_BYTES` (14 MB: the
    provider caps an inline request at about 20 MB and base64 adds a third),
    and start with a recognised container signature (ISO-BMFF `ftyp` with a
    video brand, QuickTime, or WebM). A signature is not proof the stream
    decodes.
  - No canonical key, no object, or an empty, oversized or unrecognised
    object: 422 `status: "video_unusable"` with upload-again copy. Signing,
    URL or download failures on the service side: 503, retryable. Either way
    only an undispatched claim is released (lease cleared, nothing scored);
    client metrics never stand in for the video.
  - **Revisiting a refused analysis.** No failure reason is stored (no new
    column or migration). For a `failed` row, both report pages call
    `classifyFailedAnalysisVideo`, which applies the same rules to the stored
    object through the same owner-bound signed path, reading at most 4 KB with
    a Range request and a 5 s bound. It never calls the provider or writes.
    "video_unusable" shows the upload-again guidance; anything else, including
    a Storage outage or a provider failure with a usable video, keeps Retry.
    Compatibility: it works for rows failed before this change, and stays
    correct if a row later fails for a different reason.
- **Measurement provenance.**
  - `mediapipeMetrics` are computed on the golfer's device and cannot be
    verified by the server. The prompt labels them "client-reported
    estimates", tells the model to check each against the video, and to state
    uncertainty (not agreement) where the video disagrees or cannot show it.
  - The stored `spine_angle`, `hip_rotation`, `shoulder_rotation` and
    `tempo_ratio` keep the client estimate when one was sent, else the model's
    own visual estimate. No column records which; neither is an instrument
    measurement. Labelling stored values by source needs a product and schema
    decision. No live client currently sends `mediapipeMetrics`.

## 3. Activation sequence (each step separately authorized)

1. **Apply 1 and 1b.** Both are additive and change no behaviour of any
   application version.
2. **Deploy the ENT-1D application.** Only this build writes the claim proof
   and canonical `video_url` everywhere. It requires 1b, because PostgREST
   refuses writes to an unknown column.
3. **Drain and retire old builds.**
   - Wait at least `maxDuration` (300 s) plus a margin after promotion.
   - Confirm that no pre-ENT-1D deployment is aliased or serving.
   - Retire or protect every old immutable deployment URL. Those stay
     invokable after a promotion, and the main-line route on them still calls
     the provider and fetches `video_url`.
   - Confirm no writer outside this repository writes these tables without
     the new contract. Candidates:
     - the Cloud Run `swingpro-worker`: its deployed source writes only
       `swings`, and it is contained (public invoker binding and production
       storage webhook removed; findings "Status update"). Keep it contained:
       neither may be restored without separate owner approval;
     - the edge function `process-swing-video`;
     - the `AI_BACKEND_URL` service;
     - mobile builds;
     - the Render worker;
     - the `swingmaster-web` tree, which writes a public URL into `video_url`.

     Apart from the worker's write contract, all are UNVERIFIED; see
     `docs/ENT1D_HOSTED_PREFLIGHT_FINDINGS.md` section 4.
   - Then run the post-drain checks in section 5.
4. **Apply 2** (privileges). Its preflight proves 1 only.
5. **Apply 3** (claim guard). Its preflight proves 1, 1b (the consuming guard)
   and 2. No catalog check can see the deployed build, so steps 2-3 are a
   deployment rule.
6. **Apply 4** (video source guard). It requires the deployed application;
   the previous server action wrote a public URL and would now be refused.

**Accepted starting states for 2.** The read-only hosted check of
2026-10-27 is recorded in `docs/ENT1D_HOSTED_PREFLIGHT_FINDINGS.md`.

- Production matches the **production** profile exactly.
- Staging matches the **sec0a** profile exactly. That profile comes from
  PRICING-2 SEC0A, which is applied on staging only and is not in this
  repository.
- Migration 2 accepts exactly these two profiles. It fails closed on any mix,
  subset, grant option, foreign grantor or owner, column ACL, browser-role
  membership, extra grantee, or SUPERUSER/BYPASSRLS browser role.
- Both profiles end in the identical state.
- Re-check immediately before applying. Any drift since 2026-10-27 stops
  migration 2.

**Staging the migrations.** `supabase db push` cannot be used on the hosted
projects. Production's ledger carries versions that no local file has, so a
push requires `migration repair`, which writes ledger rows without running SQL
and is excluded.

The evidenced, reviewable path (section 3 of the findings) is:

- submit each file verbatim, one call per step, through the Management API
  migrations endpoint;
- each call is one transaction and records one ledger row;
- verify `md5(array_to_string(statements, E'\n'))` against the local file,
  then rerun the catalog query.

Each file now begins with `set local lock_timeout = '3s'` and a check that
refuses to run unless that limit is active, so a non-transactional runner
fails closed. A lock-timeout failure (SQLSTATE 55P03) applies nothing and
records no ledger row. Retry the unchanged file later (findings section 8).

Locally, the CLI runner applied 2 from the production profile, and the SEC0A
profile was exercised through `ent1d_m2_preflight_negative.sh`. Supabase CLI
2.117.0 mis-splits an `IF … = CASE … END THEN` inside a DO block; migration 2
avoids that shape.

**Locally exercised:**

- full replay of all 45 migrations;
- the new migrations' main preflight failure codes, with the schema verified
  unchanged after each (`ent1d_guard_preflight_negative.sh`; not every
  postflight code);
- application of 3 and 4 by the real CLI runner, after the first three
  migrations.

**Not exercised:** the hosted order, the drain, or old and new application
builds actually running side by side.

## 4. Rollback constraints (security-preserving)

- **After 3:**
  - legacy pre-ENT-1D builds and any build that does not write the claim
    proof are NOT valid rollback targets (owner accepted);
  - roll back only to a build that writes the proof and includes the R1
    correction;
  - deactivating the guard (restoring the consuming body of 1b) is its own
    reviewed migration, and reopens R1b only if old code can run again.
- **After 4:** roll back only to a build whose every upload flow writes a
  canonical key with `video_url = key`. Dropping the trigger and its two
  functions removes only the rule; no data was changed.
- **After 2:** never restore payload SELECT or destructive grants to browser
  roles.
- **1b:** roll back only before 3, and only after the application stops
  writing the proof.
- **1:** roll back only before 2, and only on a build that writes no lease
  columns.

## 5. Operator recovery (non-routine)

**Preconditions.**

- No pre-ENT-1D build is serving: at least 300 s since the last promotion,
  confirmed in the hosting dashboard.
- The provider's request logs and billing have been checked for each
  analysis. A release accepts a possible second provider call on the golfer's
  next request.

**Find.**

```sql
-- stalled: no lease (claimed by pre-lease code), or dispatched with an expired lease
select id, user_id, analysis_family, status, processing_claim_id,
       processing_started_at, processing_heartbeat_at, provider_dispatched_at
  from public.swing_analysis
 where status = 'processing'
   and (processing_claim_id is null
        or (provider_dispatched_at is not null
            and processing_heartbeat_at < now() - interval '15 minutes'));

-- post-drain check: failed rows still carrying an undispatched lease
-- (artefacts of old code before the guard). Claimable; clear if wanted.
select id, processing_claim_id from public.swing_analysis
 where status = 'failed' and processing_claim_id is not null and provider_dispatched_at is null;
```

**Release exactly what was inspected.**

- Run as the database owner, never as an API role. The guard ignores its
  override for `anon`, `authenticated` and `service_role`.
- Run in one transaction, with the override bound to that transaction:
  `select set_config('swingproai.execution_guard', 'operator_override:' || txid_current(), true);`.
  The guard honours it only for the owner roles `postgres` and
  `supabase_admin`, and only when the value names the current transaction. A
  session-level or role-level setting applies only to a transaction whose id
  it happens to name; always set it inside the transaction. Each use is written to
  the server log.
- Restate every observed value, writing an observed null as the bare keyword
  `NULL`.
- Each block raises unless exactly one row changed.

```sql
begin;
select set_config('swingproai.execution_guard', 'operator_override:' || txid_current(), true);
do $$ declare n int; begin
  update public.swing_analysis
     set status = 'failed'          -- a dispatched lease is kept as the record
   where id = '<id>' and status = 'processing'
     and processing_claim_id is not distinct from <observed claim id | NULL>
     and provider_dispatched_at is not distinct from <observed value | NULL>
     and processing_heartbeat_at is not distinct from <observed value | NULL>
     and (processing_claim_id is null
          or (provider_dispatched_at is not null
              and processing_heartbeat_at < now() - interval '15 minutes'));
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'expected exactly one row, got %', n; end if;
end $$;
commit;

-- clearing a failed row's undispatched lease (all four columns together);
-- the guard admits this without the override
do $$ declare n int; begin
  update public.swing_analysis
     set processing_claim_id = null, processing_started_at = null,
         processing_heartbeat_at = null, provider_dispatched_at = null
   where id = '<id>' and status = 'failed'
     and processing_claim_id = '<observed claim id>' and provider_dispatched_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'expected exactly one row, got %', n; end if;
end $$;
```

An expired, undispatched ENT-1D claim needs no operator: the golfer's next
request takes it over.

**Never:**

- clear `provider_dispatched_at` on a row whose outcome is unknown (the
  claim-shape CHECK would accept it; only this rule and the guard stop it);
- release a row with a fresh heartbeat;
- set the override in a session that serves application traffic;
- rewrite a completed result (the guard refuses it without the override).

## 6. Remaining release blockers

- Confirm which build is live (main-line or later), and retire every old
  deployment URL before activating the guards.
- Confirm the writers outside this repository and their deployed revisions:
  - the Cloud Run `swingpro-worker`: write contract settled (only `swings`)
    and contained on 2026-10-27 (public invoker binding and production
    storage webhook removed). Not verified by invocation; its historical
    effect on existing rows was not assessed. Its remediation or retirement
    is a separate decision;
  - the production edge function `process-swing-video`;
  - the `AI_BACKEND_URL` service;
  - mobile builds;
  - swingmaster-web;
  - any Render service.

  See findings section 4 for the metadata the owner must supply.
- Approval of the staged mechanism (findings section 3) and of a lock-timeout
  policy.
- A re-check of the hosted ACL profile immediately before applying 2.

  Done 2026-10-27: production matches the production profile, staging the
  sec0a profile. The ledgers were read.
- Owner-approved activation sequencing, including the drain.
- Adoption of the operator procedure.
- Local production-build browser acceptance was run with synthetic data and a
  mocked provider. Outstanding:
  - physical-device acceptance, including the native file dialog
    (NOT_VERIFIED_ON_DEVICE); phone and tablet results come from viewport
    emulation;
  - real-provider (Gemini) quality acceptance, including how the model
    handles disagreement with client estimates (only prompt construction is
    proven);
  - user-facing measurement provenance: stored swing metrics are not labelled
    as estimates or by source on the report and history pages (section 2,
    "Measurement provenance").
- Separate authorization for commit, push, PR, database and production
  actions.
