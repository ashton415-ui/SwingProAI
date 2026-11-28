# Durable full-swing analysis admission and jobs: rollout notes

Status: AG-WEB-READY-10-P2-A1 local candidate. Design: AG-WEB-READY-10-P1 ADR v3.4, with the P2 work order's five corrections
and the A1 corrections (below).
These notes record how the switches work; they authorize nothing. Every hosted step (migration, deployment, worker
hosting, real inference, limits) needs its own explicit owner approval.

## What M1 adds (`supabase/migrations/20261127120000_analysis_jobs.sql`)

- Roles: `analysis_jobs_owner` (NOLOGIN; owns the tables and functions; outside the ENT-1D guard's override allow-list)
  and `analysis_worker` (NOLOGIN; may execute only the nine worker functions).
- Tables: `analysis_jobs` (one row per accepted attempt, unique `(analysis_id, generation)`), `analysis_admission_control`
  (exactly one row), `analysis_spend_ledger` (one row per job; no foreign keys: it survives job and account deletion).
- Functions: `admit_analysis_job` (service_role), `read_analysis_job_state(s)` (authenticated; owner from the request's
  JWT subject), the worker functions (analysis_worker), `reconcile_analysis_job` (postgres only, SECURITY INVOKER).
- Triggers: `swing_analysis_job_claim_guard` (refuses a synchronous claim on any analysis that has a job, unless the job
  holds that claim), `analysis_jobs_ledger_on_delete` (deleting a job never frees spent or held capacity).
- The postflight fails closed unless every M1 object, and every grant the owner role holds on existing tables, carries
  exactly the designed grantee/privilege set (checked with `aclexplode`), with the designed ownership, memberships,
  policies and function settings.

## The control row (operator statements, as postgres)

Default after M1: `execution_mode_full_swing = 'sync'`, `admissions_enabled = false`, `dispatch_enabled = false`,
`provider_mode = 'none'`, `legacy_failed_admission = false`. With these values no build changes behaviour: analyses that
have never had a job take today's synchronous path (`sync_mode`).

| Column | Meaning |
|---|---|
| `execution_mode_full_swing` | `sync` (no job: synchronous path) or `queue` (no job: a declared request creates one). An analysis that has ever had a job always goes to admission, whatever the mode. |
| `admissions_enabled` | Creating a job. Replays, complete, stalled and failed-observed answers are unaffected. |
| `dispatch_enabled` | The worker's acquire and dispatch mark. Off holds the queue; jobs and claims are kept. |
| `provider_mode` | `none` (nothing dispatches), `synthetic` (the test adapter), `real` (needs both daily limits; refused otherwise). The worker's adapter must equal it. |
| `legacy_failed_admission` | Queued admission of a failed analysis that never had a job (the `retryOfAttemptId: "legacy"` sentinel). Off pending the owner's decision. |
| `max_open_jobs_per_user`, `max_concurrent_dispatch`, `max_requeues`, `units_full_swing`, `per_user_daily_units`, `global_daily_units` | Limits in units. Numbers are owner decisions; tests use synthetic units. |

Limits are read from the surviving ledger:

- admission counts outstanding reservations (state `reserved`, any age) plus units dispatched in the last 24 h;
- the dispatch mark counts units dispatched in the last 24 h (`dispatched_at`, recorded on the ledger at the mark), so a
  backlog admitted earlier is held (`policy_hold`, a requeue that is not counted) until the window has room.

A dispatch slot (`max_concurrent_dispatch`) is occupied by a claimed job with a live undispatched lease, and by every
ledger row in state `dispatched` or `held`, whether or not its job or account still exists. A dispatched attempt keeps
its slot after its lease expires, until a known terminal outcome or an explicit reconciliation.

## Order of steps (each separately authorized)

1. **M1** (additive). No behaviour change. M1 must be applied before the application: an application without M1 answers
   every full-swing analysis request with 503 (admission cannot be decided; nothing is claimed and no provider is called).
2. **Application** with admission, the declaration header (`X-SwingProAI-Admission: 1`, not a security control), the 202
   path on every surface, the V1 upload reuse on the web upload page and the additive V1 read fields.
3. **Drain:** at least 300 s after the application deploy; retire old deployment URLs; confirm `swingmaster-web` and the
   external model callers are retired or contained. Pre-ENT-1D builds can call the provider even when a database write is
   refused, so they must not be reachable.
4. **Local, then staging fixtures:** `queue` with admissions on and dispatch off; then `provider_mode = 'synthetic'` with
   dispatch on and the synthetic consumer, on disposable fixtures only.
5. **Real worker and provider:** limits set, worker hosting and identity decided (Render is designated but unverified;
   the full service-role key is not recommended), `provider_mode = 'real'`.

## Worker identity (deferred)

Slice 1 has no long-running worker and no database driver. Tests and the local demonstration reach `analysis_worker`
with `SET ROLE` on the disposable stack. How a hosted worker reaches the role (a project-signed JWT with
`grant analysis_worker to authenticator`, or a database login over a private connection) is an owner decision that
needs security review.

## Reconcile (operator)

A job in `outcome_unknown` (the worker reported no definite answer, or the classifier found a dispatched job whose
lease expired) holds its slot and its spend until reconciled. Inside the ENT-1D operator transaction:

```sql
begin;
select set_config('swingproai.execution_guard', 'operator_override:' || txid_current(), true);
select public.reconcile_analysis_job('<job id>', 'charged');   -- or 'released' when the provider demonstrably did not run
commit;
```

It releases the analysis to `failed` (a dispatched lease is kept as the record), marks the job `reconciled` and settles
the ledger. For a held ledger row whose job is gone (account or analysis deleted after dispatch), the same call settles
the ledger row only. The function refuses to run outside the operator transaction.

Do **not** release a job-bearing analysis with the direct ENT-1D statement: the job would stay `outcome_unknown` and keep
its slot. Never run operator sessions with `session_replication_role = replica`: it skips the delete trigger and the
ledger settlement.

## Retention

Job lineage is retained: a job leaves only with its analysis or account (the `retry_of_job_id` foreign key keeps every
earlier generation a later one names, and the delete trigger refuses a direct delete of the last job of a live
analysis). Ledger rows are never deleted by M1. Retention periods for jobs, client metrics and the ledger are owner
decisions.

## Rollback

- Set `admissions_enabled = false` (new attempts stop; jobs and claims are kept) and/or `dispatch_enabled = false`.
- Setting `execution_mode_full_swing = 'sync'` affects only analyses that never had a job; analyses with a job stay in
  admission, which answers `admission_paused` while admissions are off.
- Completed reports are immutable and remain readable through the existing entitlement checks.
- Drop the trigger or tables only in a separate reviewed migration, after the tables are empty or archived.

## Deviations from ADR v3.4 (recorded for review)

- The per-function `SET swingproai.execution_guard = ''` pin is not permitted to a non-superuser migration role on
  PostgreSQL 17 ("permission denied to set parameter"). Every callable definer function instead refuses to run while an
  override marker is set (`analysis_jobs_refuse_override`); the primary control (the owner role is not on the guard's
  allow-list) is unchanged.
- The read functions take the owner from `request.jwt.claims` (the ADR's claims branch) on every stack, so no grant on
  schema `auth` is needed; a null, empty or malformed subject returns nothing.
- `admit_analysis_job` checks the video binding only when it would create a job: a completed report stays readable if
  its video later becomes unusable, and `sync_mode` reaches today's synchronous path with its own video handling
  unchanged (the ADR's sync-mode "422 for a video not uploaded" difference is not adopted).
- `mark_job_dispatched` returns a typed reason with the job, claim and generation; the worker calls the adapter only on
  `dispatched` for exactly its own job, claim and generation (P2 correction 1).
- The ledger gains `dispatched`, `dispatched_at` and `worker_claim_id`; slots and rolling limits are read from it
  (P2 corrections 2 and 3).
- Per-attempt retention of earlier generations is not supported (lineage is retained; see Retention).
- ADR §11 items 7 and 8: `lib/analysis-execution-claim.ts` (`readExecutionState`) and the result-read authority are
  unchanged; the pages and the V1 read call `read_analysis_job_state(s)` directly through
  `lib/analysis-attempt-precedence.ts` (`readGolferJobState(s)`), on the golfer's own session.
- (P2, superseded by A1) The P2 web upload page did not call V1 authorize and uploaded directly with the owner-bound
  client; A1 uses V1 authorize and its signed transfer (see "AG-WEB-READY-10-P2-A1 corrections").
- The upload identity lives in the page's memory for the current selection. A reload, or choosing the file again, is a
  new deliberate selection with its own identity (the work order: "A new intentional selection gets its own identity").
- `ent1d-mixed-version` and `ent1d-claim-guard` (ADR §11 item 13) are unchanged: their phases need a pre-guard
  database; mixed versions are covered by the new suites and a run-owned check of the pinned route.
- Additions beyond the ADR: the `not_startable` answer (an analysis status no rule covers), `analysis_jobs.worker_id`,
  `analysis_admission_control.legacy_failed_admission` (the legacy sentinel, off), the ledger's `dispatched` state,
  `dispatched_at` and `worker_claim_id`, and `lock_timeout` on admission and every worker function (5 s; 2 s on the
  dispatch mark, the one function that waits on an analysis row while holding the control row, so an admission queued
  behind it never reaches its own timeout).
- The dispatch mark also refuses an expired undispatched claim and recounts live slots under the control lock, and a
  heartbeat never revives an expired undispatched claim (an expired claim's slot may already be in use elsewhere).
- The database result bound checks key sets, types, list lengths, the summary bound and total sizes. Total sizes
  (metrics 64 KiB, result 256 KiB) are database-only limits with no matching TypeScript check; a validated answer
  above them is refused at completion and fails as `save_failed`. Whether the validator should enforce them on both
  paths is an owner decision.
- The full-swing summary bound (`MAX_EXECUTIVE_SUMMARY_CHARS`, 4000) is enforced by the shared validator, so it also
  applies to the synchronous path (ADR §5).
- Every full-swing request (also in `sync` mode) takes the control row lock briefly. An operator transaction must never
  hold that row open. A waiting dispatch mark delays admissions by at most its 2 s lock timeout.
- When acquire's video re-check fails (the video row is no longer the owner's uploaded, canonical object), the attempt
  ends as `video_unusable`, so the golfer sees the upload-again view. A changed analysis binding (owner or video id)
  stays `superseded_binding`.
- A completion retried after its first call committed answers `completed` (same claim, job succeeded).
- The postflight compares grant options too; it does not check grants held by PUBLIC on columns of `users` or
  `swing_videos` beyond the owner role's own designed set (the definer functions use `search_path = ''` and fixed code).
- (P2) No test checked every combination of states for agreement between the admission answer and the status view.
  A1 adds the agreement matrix (sql suite) for the synchronous-claim states, the paused and startable full swing and
  putting; the states it covers agree case for case.

## AG-WEB-READY-10-P2-A1 corrections

- **Attempt identity.** Every admission answer's `attempt` is the attempt the request's own intent was accepted as: the
  initial press (no `retryOfAttemptId`, or the `legacy` sentinel once the analysis has a job) is generation 1; a Retry
  naming attempt X is X's one successor. When the status describes another attempt, the answer also carries it as
  `current` (202 bodies, 409 bodies and the completed 200 body of `POST /api/analyze-swing`). Clients show and retry
  `current ?? attempt`; a 202's `status` describes `current ?? attempt`. A repeat never creates a job: only the initial
  press of an analysis that never had a job, or a Retry naming the latest terminal attempt, can.
- **Admission and the status read agree** case for case: a live synchronous claim (heartbeat within the lease, dispatched
  or not) is `processing` and a press answers in progress; an expired claim that never dispatched, on an analysis that
  never had a job, reads as startable (`idle`, or `paused` while full-swing admissions are paused) because the next
  press takes it over; anything else that is processing without an open job reads `interrupted` and a press answers
  `stalled`. The full-swing pause applies to full swing only (a null family is pre-family full swing); putting reads
  `idle` and keeps its synchronous path whatever the full-swing switches say.
- **Unresolved dispatch.** An attempt in `outcome_unknown` is shown as "result not confirmed yet" with a status read (a
  classified holder's late result settles it once, or reconcile does); the golfer is not told it can't finish. The
  synchronous stall (no interrupted attempt) keeps its record-again guidance.
- **Unavailable status.** A status read that fails, is refused or answers nothing usable is `"unavailable"`, never "no
  work": the saved report and `/swings/<id>` say so and offer only Check status (a reload); the dashboard and Telemetry
  label the row "Status unavailable"; the V1 read answers `execution: "unavailable"` with `attempt: null` (additive; an
  `idle` execution is the confirmed absence of work and keeps the Analyze action). A stored completed report is shown as
  before. Consequence for the order of steps: an application deployed without M1 shows every unfinished swing as
  "Status unavailable" with no Analyze action (M1 first remains required).
- **Web upload through V1 authorize.** The upload page's first transfer of a selection asks `POST /api/v1/uploads/authorize`
  (the page's confirmed Bearer) and sends the clip over the signed resumable (TUS) transfer the answer names: its
  endpoint and short-lived, path-scoped signature, in the contract's 6 MiB chunks, with no Authorization header, no
  cookie and no redirect followed. The page accepts only the endpoint its own project URL implies, the caller's own key,
  this upload id and content type, and no upsert; the transfer address must stay on the endpoint's origin and path. The
  signature lives in page memory for the selection only. A repeat asks V1 finalize first; a transfer left part-way is
  resumed from the server's offset while its signature is usable; a key Storage refuses to sign (already stored) is
  decided by finalize. One upload id per selection, the finalize body (display name, trim, MIME) and the native
  finalize request are unchanged.
- **Local seam.** `SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT=1` (server-only) lets authorize hand a disposable local
  stack's own loopback endpoint (`http://127.0.0.1:<port>/storage/v1/upload/resumable/sign`) to the page, and only when
  `NEXT_PUBLIC_SUPABASE_URL` is exactly `http://127.0.0.1:<port>`. It changes nothing for a hosted project and is never
  set on a hosted deployment.
- **Storage behaviour of the signed transfer (local storage-api v1.72.1; hosted unverified).** A signature is refused
  for any other key (another golfer's folder or another upload id). Within its lifetime (7200 s), however, the same
  signature could create a second transfer for a key that was already stored and replace its bytes, and of two
  transfers to one key the last to complete is stored. The page always sends the selection's identical bytes, and
  authorize refuses to sign a stored key (finalize then decides), so the stored clip is the selection's clip; but a
  golfer can replace their own finalized object within the lifetime, which adds to the existing time-of-check note
  (finalize proves size and type once): the hosted worker must re-check size and type at download (see below).
- **Custom domain (owner decision).** The hosted endpoint rule is unchanged: authorize derives
  `https://<ref>.storage.supabase.co/...` from a `*.supabase.co` project URL and answers 500 otherwise. The web upload now
  depends on it (P2's direct upload did not), so a custom Supabase domain would stop every web upload until the rule
  supports it. The hosted signed transfer (direct Storage host, cross-origin) is verified only on the local stack.

## Hosted-worker preconditions (not met by slice 1; each needs its own decision)

- **Video source:** the hosted `WorkerVideoSource` must take the key from `acquire_analysis_job` only, parse it with
  `parseOwnedSwingVideoPath` for the job's owner, and re-check the object's size and content type at download. Finalize's
  size and type proof is time-of-check only: the owner's Storage policies let a golfer replace the object behind a
  finalized key (the effect stays within that golfer's own analysis).
- **Long loads:** the worker sends no heartbeat between acquire and the dispatch mark, so a video load longer than the
  900 s lease is fenced at the mark, and a takeover does not count toward `max_requeues`. Heartbeat during the load or
  bound its time, and count takeovers, before a hosted worker runs.
- **Mark lock timeout:** a dispatch mark that fails with SQLSTATE 55P03 (lock timeout) did not commit; slice 1's worker
  reports it as `dispatch_uncertain` and the live claim keeps its slot until its lease expires (with a cap of 1 the queue
  waits up to 900 s). Treat 55P03 as not committed and requeue.
- **Deletion during a dispatch:** a cascade delete locks the analysis before the job (the reverse of the holder writes;
  PostgreSQL's deadlock detector aborts one side). A heartbeat after the job is deleted returns false and the worker
  aborts the adapter without reporting, so the held ledger row waits for reconcile.
- **Worker identity, Storage identity and the download-before-permission order** (the worker downloads the video before
  asking for dispatch permission) are decided with the hosted worker.
