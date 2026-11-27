// ============================================================================
// AG-WEB-READY-10-P2 — the worker core (lib/analysis-job-worker.ts) with the synthetic adapter, against the real
// local database
// ============================================================================
//
// The P2 corrections:
//   C1 typed dispatch result: policy hold, ineligibility, a lost claim, a missing and a lost acknowledgement and a
//      malformed answer each give ZERO adapter calls; an uncertain dispatch stays held for reconciliation.
//   C2 a dispatched attempt keeps its slot after its lease and grace expire until a known terminal outcome or
//      reconciliation; with a cap of one, a late finish settles exactly once and only then frees the slot.
//   C3 spend and held capacity survive job and account deletion; a backlog crossing the window and a held slot
//      whose account disappears have deterministic outcomes. Synthetic units only.
// and ADR matrix rows 8–14, 16, 17, 19, 29, 36, rollback with jobs in flight, and SIGTERM.
//
// Replaced boundaries: `server-only` (marker). The worker's RPC transport is the harness's SET ROLE analysis_worker
// transport (ADR §11: slice 1). The video source downloads the object from the run's local Storage with the service
// role after checking it lies in the job owner's folder. No provider exists: the adapter is the synthetic one.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { runWorkerOnce, classifyStalledJobs, type HeartbeatScheduler, type WorkerVideoSource, type WorkerRpc } from "@/lib/analysis-job-worker";
import { createSyntheticFullSwingAdapter, syntheticFullSwingResponse, SYNTHETIC_RESULT_LABEL } from "@/lib/analysis-provider-adapter";
import { toStoredFullSwingResult, validateFullSwingModelResponse } from "@/lib/full-swing-analysis-contract";
import { admin, cleanupFixtures, createAnalysis, createGolfer, row, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";
import {
  admitSql, ageClaim, ageJob, ageLedger, analysisRow, callAs, drainQueue, jobsOf, ledgerOfJob, liveSlots, lit, operator, psql,
  psqlAsync, psqlTry, queueMode, readStateAs, resetControl, setControl, workerRpc, type RpcFault,
  createUntrackedGolfer, cleanupUntracked, ageUnknown, until, someoneWaitsOnLock, sessionSleeping, sessionWaitsOnLock,
} from "./analysis-jobs-harness";

const video: WorkerVideoSource = {
  async load(job) {
    if (!job.storagePath.startsWith(`${job.userId}/`)) return { status: "unusable" };
    const r = await admin.storage.from("swing-videos").download(job.storagePath);
    if (r.error || !r.data) return { status: "unusable" };
    return { status: "ok", bytes: await r.data.arrayBuffer(), mimeType: "video/mp4" };
  },
};
const transientVideo: WorkerVideoSource = { load: async () => ({ status: "transient" }) };

/** A heartbeat scheduler the test drives by hand (no timer; the lease ages only when the test says so). */
function manualScheduler() {
  const ticks: (() => void)[] = [];
  const scheduler: HeartbeatScheduler = { every: (_ms, tick) => { ticks.push(tick); return () => void ticks.splice(ticks.indexOf(tick), 1); } };
  return { scheduler, tick: () => ticks.forEach((t) => t()), active: () => ticks.length };
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { wait: () => opened, open };
}

let golfer: Golfer;
beforeAll(async () => {
  golfer = await createGolfer("birdie");
});
beforeEach(() => {
  resetControl();
  drainQueue();
});
afterAll(async () => {
  resetControl();
  drainQueue();
  expect(await cleanupUntracked(), "untracked cleanup").toEqual([]);
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

const attemptOf = (r: Record<string, unknown>) => (r.attempt as { id: string }).id;
async function queued(g: Golfer = golfer, metrics: unknown = null): Promise<{ analysisId: string; jobId: string }> {
  const analysisId = await createAnalysis(g, "full_swing", { upload: true });
  const r = admitSql(g.id, analysisId, true, null, metrics);
  expect(r.disposition).toBe("created");
  return { analysisId, jobId: attemptOf(r) };
}
const dispatchCount = (jobId: string) =>
  Number(psql(`select count(*) from public.analysis_jobs where id = ${lit(jobId, "uuid")} and dispatched_at is not null;`, "postgres"));

describe("the happy path", () => {
  it("one acceptance, one simulated dispatch, one labelled unscored result; the ledger is charged with its dispatch time", async () => {
    queueMode();
    const { analysisId, jobId } = await queued(golfer, { spineAngle: 31, tempoRatio: "3:1" });
    const adapter = createSyntheticFullSwingAdapter();
    const tick = await runWorkerOnce({ workerId: "w1", rpc: workerRpc(), adapter, video });
    expect(tick).toEqual({ kind: "completed", jobId, outcome: "completed" });
    expect(adapter.calls()).toBe(1);
    const stored = await row(analysisId);
    expect(stored).toMatchObject({ status: "complete", score: null, spine_angle: null });
    expect(String(stored.feedback)).toMatch(new RegExp(`^${SYNTHETIC_RESULT_LABEL}`));
    const v = validateFullSwingModelResponse(syntheticFullSwingResponse());
    if (!v.ok) throw new Error(v.reason);
    const expected = toStoredFullSwingResult(v.report, v.assessment, { spineAngle: 31, hipRotation: null, shoulderRotation: null, tempoRatio: "3:1" });
    expect(stored.metrics).toEqual(JSON.parse(JSON.stringify(expected.metrics)));
    expect(jobsOf(analysisId)).toMatchObject([{ id: jobId, state: "succeeded", generation: 1 }]);
    const l = ledgerOfJob(jobId)!;
    expect(l).toMatchObject({ state: "charged", units: 1, reason: "completed" });
    expect(l.dispatched_at).not.toBeNull();
    expect(dispatchCount(jobId)).toBe(1);
    expect(readStateAs(golfer.id, analysisId)).toMatchObject({ execution: "complete", attempt: { id: jobId, state: "complete" } });
    expect(await runWorkerOnce({ workerId: "w1", rpc: workerRpc(), adapter, video })).toEqual({ kind: "idle" });
    expect(adapter.calls()).toBe(1);
  });
});

describe("C1 — the adapter runs only on an acknowledged `dispatched` for the current attempt and claim", () => {
  const run = (fault: RpcFault, adapter = createSyntheticFullSwingAdapter(), extra: Partial<Parameters<typeof runWorkerOnce>[0]> = {}) =>
    runWorkerOnce({ workerId: "c1", rpc: workerRpc(fault), adapter, video, scheduler: manualScheduler().scheduler, ...extra }).then((t) => ({ t, adapter }));

  it("policy hold (dispatch switched off, or the adapter no longer matches the mode) between acquire and mark: 0 calls, policy requeue (17)", async () => {
    queueMode();
    const { analysisId, jobId } = await queued();
    const { t, adapter } = await run((fn) => { if (fn === "mark_job_dispatched") setControl({ dispatch_enabled: false }); return "pass"; });
    expect(t).toMatchObject({ kind: "requeued", jobId, policy: true, outcome: "requeued" });
    expect(adapter.calls()).toBe(0);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "queued", requeue_count: 0, dispatched_at: null });
    expect((await row(analysisId)).status).toBe("pending");
    expect(readStateAs(golfer.id, analysisId)).toMatchObject({ execution: "queued" });
    queueMode();
    ageJob(jobId, 60);
    const mismatch = await run((fn) => { if (fn === "mark_job_dispatched") setControl({ per_user_daily_units: 100, global_daily_units: 100, provider_mode: "real" }); return "pass"; });
    expect(mismatch.t).toMatchObject({ kind: "requeued", policy: true });
    expect(mismatch.adapter.calls()).toBe(0);
    expect(dispatchCount(jobId)).toBe(0);
  });

  it("ineligible (the binding changed, or the tier is no longer recognised) before dispatch: 0 calls, cancelled, released (36)", async () => {
    queueMode();
    const { analysisId, jobId } = await queued();
    const spare = crypto.randomUUID();
    const ins = await admin.from("swing_videos").insert({ id: spare, user_id: golfer.id, status: "uploaded", storage_path: `${golfer.id}/${spare}/x.mp4`, video_url: `${golfer.id}/${spare}/x.mp4` });
    expect(ins.error).toBeNull();
    const { t, adapter } = await run((fn) => {
      if (fn === "mark_job_dispatched") operator(`update public.swing_analysis set swing_video_id = ${lit(spare, "uuid")} where id = ${lit(analysisId, "uuid")};`);
      return "pass";
    });
    expect(t).toEqual({ kind: "cancelled_ineligible", jobId });
    expect(adapter.calls()).toBe(0);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "cancelled_ineligible", failure_kind: "ineligible" });
    expect(ledgerOfJob(jobId)).toMatchObject({ state: "released", reason: "ineligible" });
    expect((await row(analysisId)).status).toBe("failed");
    expect(readStateAs(golfer.id, analysisId)).toMatchObject({ execution: "failed", attempt: { failureKind: "not_finished" } });
    // An unrecognised tier cannot be stored (users_subscription_tier_check mirrors the TypeScript allow-list); probe the
    // database's re-check in one rolled-back transaction with the constraint lifted.
    const other = await createGolfer("par");
    const q = await queued(other);
    const probe = psqlTry(`begin;
      set local role analysis_worker;
      select public.acquire_analysis_job('probe', 'synthetic')::text as j \\gset
      reset role;
      alter table public.users drop constraint users_subscription_tier_check;
      update public.users set subscription_tier = 'gold' where id = ${lit(other.id, "uuid")};
      set local role analysis_worker;
      select 'M:' || public.mark_job_dispatched((:'j'::jsonb ->> 'jobId')::uuid, (:'j'::jsonb ->> 'claimId')::uuid, 'synthetic')::text;
      rollback;`);
    expect(probe.code, probe.err).toBe(0);
    expect(JSON.parse(probe.out.split(/\r?\n/).find((l) => l.startsWith("M:"))!.slice(2))).toMatchObject({ reason: "ineligible", jobId: q.jobId });
    expect(jobsOf(q.analysisId)[0]).toMatchObject({ state: "queued" }); // rolled back
  });

  it("a lost claim (taken over after the lease expired) is fenced: 0 calls from that response", async () => {
    queueMode();
    const { analysisId, jobId } = await queued();
    let takeoverClaim: unknown = null;
    const { t, adapter } = await run((fn) => {
      if (fn === "mark_job_dispatched") {
        ageClaim(analysisId, 1000);
        takeoverClaim = (callAs("analysis_worker", "acquire_analysis_job", { p_worker: "other", p_adapter: "synthetic" }) as { claimId: string; recovered: boolean });
      }
      return "pass";
    });
    expect(takeoverClaim).toMatchObject({ jobId, recovered: true });
    expect(t).toEqual({ kind: "fenced", jobId, step: "mark" });
    expect(adapter.calls()).toBe(0);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "claimed", worker_claim_id: (takeoverClaim as { claimId: string }).claimId });
  });

  it("a missing acknowledgement (never reached the database): 0 calls; the undispatched claim is recovered later, dispatched once (10)", async () => {
    queueMode();
    const { analysisId, jobId } = await queued();
    const { t, adapter } = await run((fn) => (fn === "mark_job_dispatched" ? "drop" : "pass"));
    expect(t).toEqual({ kind: "dispatch_uncertain", jobId });
    expect(adapter.calls()).toBe(0);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "claimed", dispatched_at: null });
    // while the lease is live the claim holds the only slot
    const b = await queued(await createGolfer("par"));
    expect(liveSlots()).toBe(1);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" })).toBeNull();
    ageClaim(analysisId, 1000);
    const second = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "c1b", rpc: workerRpc(), adapter: second, video })).toEqual({ kind: "completed", jobId, outcome: "completed" });
    expect(second.calls()).toBe(1);
    expect(dispatchCount(jobId)).toBe(1);
    expect(jobsOf(b.analysisId)[0].state).toBe("queued");
  });

  it("a lost acknowledgement after commit: 0 calls; the dispatch is held (slot occupied) until reconciliation (11)", async () => {
    queueMode();
    const { analysisId, jobId } = await queued();
    const { t, adapter } = await run((fn) => (fn === "mark_job_dispatched" ? "lose_after_commit" : "pass"));
    expect(t).toEqual({ kind: "dispatch_uncertain", jobId });
    expect(adapter.calls()).toBe(0);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "dispatched" });
    expect(ledgerOfJob(jobId)).toMatchObject({ state: "dispatched" });
    const b = await queued(await createGolfer("par"));
    ageClaim(analysisId, 2000);
    expect(liveSlots()).toBe(1); // the expired lease does not free a dispatched slot (C2)
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" })).toBeNull();
    expect(await classifyStalledJobs(workerRpc())).toBe(1);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "outcome_unknown", outcome_unknown_source: "classifier" });
    expect(ledgerOfJob(jobId)).toMatchObject({ state: "held" });
    expect(readStateAs(golfer.id, analysisId)).toMatchObject({ execution: "interrupted" });
    expect(admitSql(golfer.id, analysisId)).toMatchObject({ disposition: "stalled" });
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" })).toBeNull();
    const refused = psqlTry(`select public.reconcile_analysis_job(${lit(jobId, "uuid")}, 'released');`, "postgres");
    expect(refused.err).toContain("AJ-RECONCILE-2"); // only inside the operator transaction
    operator(`select public.reconcile_analysis_job(${lit(jobId, "uuid")}, 'released');`);
    expect(jobsOf(analysisId)[0]).toMatchObject({ state: "reconciled" });
    expect(ledgerOfJob(jobId)).toMatchObject({ state: "released", reason: "reconciled" });
    expect((await row(analysisId)).status).toBe("failed");
    expect(liveSlots()).toBe(0);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" })).toMatchObject({ jobId: b.jobId });
  });

  it("a malformed or mismatched acknowledgement is uncertain: 0 calls", async () => {
    queueMode();
    for (const replace of [{ reason: "dispatched", jobId: crypto.randomUUID(), claimId: crypto.randomUUID(), generation: 1 }, { reason: "maybe" }, "dispatched", null]) {
      drainQueue();
      const { jobId } = await queued();
      const { t, adapter } = await run((fn) => (fn === "mark_job_dispatched" ? { replace } : "pass"));
      expect(t, JSON.stringify(replace)).toEqual({ kind: "dispatch_uncertain", jobId });
      expect(adapter.calls()).toBe(0);
    }
  });

  it("SIGTERM: a worker told to stop never calls the provider (before the mark: policy requeue; after it: held)", async () => {
    queueMode();
    const a = await queued();
    let stopping = false;
    const before = await run((fn) => { if (fn === "mark_job_dispatched") stopping = true; return "pass"; }, undefined, { shouldStop: () => stopping });
    expect(before.adapter.calls()).toBe(0);
    expect(before.t).toEqual({ kind: "dispatch_uncertain", jobId: a.jobId }); // the stop came with the mark: held
    drainQueue();
    const b = await queued();
    let n = 0;
    const early = await run(() => "pass", undefined, { shouldStop: () => ++n > 1 }); // stop after acquiring, before the mark
    expect(early.t).toMatchObject({ kind: "requeued", jobId: b.jobId, policy: true });
    expect(early.adapter.calls()).toBe(0);
  });
});

describe("C2 — a dispatched attempt keeps its slot until a known outcome", () => {
  it("cap 1: A is delayed beyond lease and grace, B is offered and waits; A finishes late; settlement happens exactly once", async () => {
    queueMode({ max_concurrent_dispatch: 1 });
    const a = await queued();
    const g = gate();
    const hb = manualScheduler();
    const adapterA = createSyntheticFullSwingAdapter({ gate: g.wait });
    const workerA = runWorkerOnce({ workerId: "A", rpc: workerRpc(), adapter: adapterA, video, scheduler: hb.scheduler });
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && adapterA.calls() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(adapterA.calls()).toBe(1);
    ageClaim(a.analysisId, 2000); // past the 900 s lease
    expect(await classifyStalledJobs(workerRpc())).toBe(1);
    ageUnknown(a.jobId, 2000); // and past the ADR's 900 s classifier grace: the slot must still be held (C2)
    const b = await queued(await createGolfer("par"));
    expect(liveSlots()).toBe(1);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "B", p_adapter: "synthetic" })).toBeNull();
    expect(readStateAs(golfer.id, a.analysisId)).toMatchObject({ execution: "interrupted" });
    g.open();
    expect(await workerA).toEqual({ kind: "completed", jobId: a.jobId, outcome: "completed" });
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "succeeded", outcome_unknown_source: null });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged" });
    expect(readStateAs(golfer.id, a.analysisId)).toMatchObject({ execution: "complete" });
    const claimA = jobsOf(a.analysisId)[0].worker_claim_id;
    const settled = JSON.stringify([analysisRow(a.analysisId), jobsOf(a.analysisId), ledgerOfJob(a.jobId)]);
    // a repeat by the same claim answers completed (r3) and writes nothing; another claim is fenced
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: a.jobId, p_claim: claimA, p_result: {} })).toBe("completed");
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: a.jobId, p_claim: crypto.randomUUID(), p_result: {} })).toBe("fenced");
    expect(JSON.stringify([analysisRow(a.analysisId), jobsOf(a.analysisId), ledgerOfJob(a.jobId)])).toBe(settled);
    expect(liveSlots()).toBe(0);
    const adapterB = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "B", rpc: workerRpc(), adapter: adapterB, video })).toEqual({ kind: "completed", jobId: b.jobId, outcome: "completed" });
    expect(adapterA.calls() + adapterB.calls()).toBe(2);
    expect(Number(psql(`select count(*) from public.analysis_spend_ledger where job_id in (${lit(a.jobId, "uuid")}, ${lit(b.jobId, "uuid")}) and state = 'charged';`, "postgres"))).toBe(2);
  });

  it("a revived worker heartbeats its classified job back to dispatched (12); a fenced heartbeat stops it without writing", async () => {
    queueMode();
    const a = await queued();
    const g = gate();
    const hb = manualScheduler();
    const adapter = createSyntheticFullSwingAdapter({ gate: g.wait });
    const worker = runWorkerOnce({ workerId: "R", rpc: workerRpc(), adapter, video, scheduler: hb.scheduler });
    for (let i = 0; i < 100 && adapter.calls() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    ageClaim(a.analysisId, 2000);
    await classifyStalledJobs(workerRpc());
    hb.tick();
    for (let i = 0; i < 50 && jobsOf(a.analysisId)[0].state !== "dispatched"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "dispatched" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "dispatched" });
    // now the operator reconciles while it still runs: its next heartbeat is refused and nothing more is written
    ageClaim(a.analysisId, 2000);
    await classifyStalledJobs(workerRpc());
    operator(`select public.reconcile_analysis_job(${lit(a.jobId, "uuid")}, 'charged');`);
    hb.tick();
    await new Promise((r) => setTimeout(r, 1500));
    g.open();
    expect(await worker).toEqual({ kind: "fenced", jobId: a.jobId, step: "heartbeat" });
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "reconciled" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged", reason: "reconciled" });
    expect((await row(a.analysisId)).status).toBe("failed");
  });

  it("N workers against a cap of k: at most k live slots (19)", async () => {
    queueMode({ max_concurrent_dispatch: 2 });
    const others = await Promise.all([1, 2, 3, 4].map(() => createGolfer("par")));
    for (const o of others) await queued(o);
    const sql = "begin; set local role analysis_worker; select 'R:' || coalesce(public.acquire_analysis_job('n', 'synthetic')::text, 'null'); commit;";
    const answers = await Promise.all([1, 2, 3, 4].map(() => psqlAsync(sql)));
    const got = answers.map((a) => JSON.parse(a.out.split(/\r?\n/).find((l) => l.startsWith("R:"))!.slice(2)));
    expect(got.filter((x) => x !== null)).toHaveLength(2);
    expect(liveSlots()).toBe(2);
  });
});

describe("C3 — spend and held capacity survive deletion; windows are deterministic", () => {
  it("a dispatched job whose account is deleted keeps its spend and its slot; the late report settles it once (16)", async () => {
    queueMode({ max_concurrent_dispatch: 1, global_daily_units: 1000 });
    const x = await createUntrackedGolfer("par");
    const a = await queued(x);
    const g = gate();
    const adapter = createSyntheticFullSwingAdapter({ gate: g.wait });
    const worker = runWorkerOnce({ workerId: "X", rpc: workerRpc(), adapter, video, scheduler: manualScheduler().scheduler });
    for (let i = 0; i < 100 && adapter.calls() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const before = Number(psql("select coalesce(sum(units),0) from public.analysis_spend_ledger where state in ('dispatched','held','charged') and dispatched_at > now() - interval '24 hours';", "postgres"));
    expect((await admin.auth.admin.deleteUser(x.id)).error).toBeNull();
    expect(jobsOf(a.analysisId)).toEqual([]);
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "held", reason: "job_deleted", units: 1 });
    expect(Number(psql("select coalesce(sum(units),0) from public.analysis_spend_ledger where state in ('dispatched','held','charged') and dispatched_at > now() - interval '24 hours';", "postgres"))).toBe(before);
    const b = await queued();
    expect(liveSlots()).toBe(1);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "Y", p_adapter: "synthetic" })).toBeNull();
    g.open();
    expect(await worker).toEqual({ kind: "completed", jobId: a.jobId, outcome: "job_gone_settled" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged", reason: "job_deleted_completed" });
    const claim = ledgerOfJob(a.jobId)!.worker_claim_id;
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: a.jobId, p_claim: claim, p_result: {} })).toBe("fenced");
    expect(liveSlots()).toBe(0);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "Y", p_adapter: "synthetic" })).toMatchObject({ jobId: b.jobId });
  });

  it("a held slot whose account disappears and whose worker never reports is freed only by reconciliation", async () => {
    queueMode({ max_concurrent_dispatch: 1 });
    const x = await createUntrackedGolfer("par");
    const a = await queued(x);
    const { t } = await runWorkerOnce({ workerId: "X", rpc: workerRpc((fn) => (fn === "mark_job_dispatched" ? "lose_after_commit" : "pass")), adapter: createSyntheticFullSwingAdapter(), video }).then((t) => ({ t }));
    expect(t.kind).toBe("dispatch_uncertain");
    expect((await admin.auth.admin.deleteUser(x.id)).error).toBeNull();
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "held" });
    expect(liveSlots()).toBe(1);
    operator(`select public.reconcile_analysis_job(${lit(a.jobId, "uuid")}, 'charged');`);
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged", reason: "reconciled_orphan" });
    expect(liveSlots()).toBe(0);
  });

  it("a completed analysis deleted inside the window still counts against the golfer's limit", async () => {
    const x = await createGolfer("par");
    queueMode({ per_user_daily_units: 1 });
    const a = await queued(x);
    expect((await runWorkerOnce({ workerId: "w", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter(), video })).kind).toBe("completed");
    expect((await admin.from("swing_analysis").delete().eq("id", a.analysisId)).error).toBeNull();
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged" });
    const next = await createAnalysis(x, "full_swing", { upload: true });
    expect(admitSql(x.id, next)).toMatchObject({ disposition: "limit_reached", reason: "units" });
    ageLedger(a.jobId, 25 * 3600);
    expect(admitSql(x.id, next).disposition).toBe("created");
  });

  it("a backlog crossing the window: reservations count until settled; dispatch is held by the window, then proceeds", async () => {
    const x = await createGolfer("par");
    queueMode({ per_user_daily_units: 2, dispatch_enabled: false });
    const j1 = await queued(x);
    const j2 = await queued(x);
    ageLedger(j1.jobId, 25 * 3600);
    ageLedger(j2.jobId, 25 * 3600);
    const third = await createAnalysis(x, "full_swing", { upload: true });
    expect(admitSql(x.id, third)).toMatchObject({ disposition: "limit_reached", reason: "units" }); // old reservations still count
    setControl({ dispatch_enabled: true, per_user_daily_units: 1 });
    const adapter = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "w", rpc: workerRpc(), adapter, video })).toMatchObject({ kind: "completed", jobId: j1.jobId });
    expect(await runWorkerOnce({ workerId: "w", rpc: workerRpc(), adapter, video })).toMatchObject({ kind: "requeued", jobId: j2.jobId, policy: true });
    expect(adapter.calls()).toBe(1);
    expect(jobsOf(j2.analysisId)[0]).toMatchObject({ state: "queued", requeue_count: 0 });
    ageLedger(j1.jobId, 25 * 3600);
    ageJob(j2.jobId, 120);
    expect(await runWorkerOnce({ workerId: "w", rpc: workerRpc(), adapter, video })).toMatchObject({ kind: "completed", jobId: j2.jobId });
    expect(adapter.calls()).toBe(2);
  });

  it("a job deleted while queued releases its reservation; one deleted while claimed fences the worker", async () => {
    queueMode();
    const x = await createUntrackedGolfer("par");
    const q = await queued(x);
    expect((await admin.from("swing_analysis").delete().eq("id", q.analysisId)).error).toBeNull();
    expect(ledgerOfJob(q.jobId)).toMatchObject({ state: "released", reason: "job_deleted" });
    const c = await queued(x);
    const adapter = createSyntheticFullSwingAdapter();
    const t = await runWorkerOnce({ workerId: "w", rpc: workerRpc((fn) => {
      if (fn === "mark_job_dispatched") psql(`delete from auth.users where id = ${lit(x.id, "uuid")};`);
      return "pass";
    }), adapter, video });
    expect(t).toEqual({ kind: "fenced", jobId: c.jobId, step: "mark" });
    expect(adapter.calls()).toBe(0);
    expect(ledgerOfJob(c.jobId)).toMatchObject({ state: "released", reason: "job_deleted" });
  });
});

describe("matrix rows on the worker path", () => {
  it("a head job that is not acquirable is superseded and the scan continues (8)", async () => {
    queueMode();
    const head = await queued();
    const next = await queued(await createGolfer("par"));
    operator(`update public.swing_analysis set status = 'complete' where id = ${lit(head.analysisId, "uuid")};`);
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "s", p_adapter: "synthetic" })).toMatchObject({ jobId: next.jobId });
    expect(jobsOf(head.analysisId)[0]).toMatchObject({ state: "superseded", failure_kind: "superseded_state" });
    expect(ledgerOfJob(head.jobId)).toMatchObject({ state: "released", reason: "superseded_state" });
  });

  it("a retry after a paid failure claims from failed with the kept lease (9)", async () => {
    queueMode();
    const a = await queued();
    expect(await runWorkerOnce({ workerId: "p", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter({ outcome: { kind: "unusable" } }), video }))
      .toMatchObject({ kind: "failed", failure: "response_unusable" });
    const failed = analysisRow(a.analysisId)!;
    expect(failed.status).toBe("failed");
    expect(failed.provider_dispatched_at).not.toBeNull(); // the paid dispatch is kept as the record
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged", reason: "response_unusable" });
    const retry = admitSql(golfer.id, a.analysisId, true, a.jobId);
    expect(retry).toMatchObject({ disposition: "created", attempt: { generation: 2 } });
    expect(await runWorkerOnce({ workerId: "p", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter(), video })).toMatchObject({ kind: "completed", jobId: attemptOf(retry) });
  });

  it("repeated transient storage errors back off without blocking the queue, then exhaust (13)", async () => {
    queueMode({ max_requeues: 2 });
    const a = await queued();
    const adapter = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "t", rpc: workerRpc(), adapter, video: transientVideo })).toMatchObject({ kind: "requeued", policy: false });
    const j = jobsOf(a.analysisId)[0];
    expect(j).toMatchObject({ state: "queued", requeue_count: 1 });
    expect(Date.parse(String(j.available_at))).toBeGreaterThan(Date.now() + 20_000);
    const b = await queued(await createGolfer("par"));
    expect(await runWorkerOnce({ workerId: "t", rpc: workerRpc(), adapter, video })).toMatchObject({ kind: "completed", jobId: b.jobId }); // no head-blocking
    ageJob(a.jobId, 3600);
    expect(await runWorkerOnce({ workerId: "t", rpc: workerRpc(), adapter, video: transientVideo })).toMatchObject({ kind: "requeued", outcome: "requeued" });
    ageJob(a.jobId, 3600);
    expect(await runWorkerOnce({ workerId: "t", rpc: workerRpc(), adapter, video: transientVideo })).toMatchObject({ kind: "requeued", outcome: "exhausted" });
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "failed_definite", failure_kind: "requeue_exhausted" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "released" });
    expect((await row(a.analysisId)).status).toBe("failed");
    expect(adapter.calls()).toBe(1);
  });

  it("a definite provider rejection releases the reservation (14); an unusable video fails before any dispatch", async () => {
    queueMode();
    const a = await queued();
    expect(await runWorkerOnce({ workerId: "r", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter({ outcome: { kind: "rejected" } }), video }))
      .toMatchObject({ kind: "failed", failure: "provider_rejected", outcome: "failed" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "released", reason: "provider_rejected" });
    const missing = await createAnalysis(golfer, "full_swing", { upload: false });
    const m = admitSql(golfer.id, missing);
    const adapter = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "r", rpc: workerRpc(), adapter, video })).toMatchObject({ kind: "failed", failure: "video_unusable" });
    expect(adapter.calls()).toBe(0);
    expect(ledgerOfJob(attemptOf(m))).toMatchObject({ state: "released", reason: "video_unusable" });
    expect(readStateAs(golfer.id, missing)).toMatchObject({ execution: "failed", attempt: { failureKind: "video_unusable" } });
  });

  it("no definite answer marks the outcome unknown and holds the spend; the analysis is stalled", async () => {
    queueMode();
    const a = await queued();
    expect(await runWorkerOnce({ workerId: "u", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter({ outcome: { kind: "unknown" } }), video }))
      .toMatchObject({ kind: "outcome_unknown", outcome: "held" });
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "outcome_unknown", outcome_unknown_source: "worker" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "held" });
    expect(analysisRow(a.analysisId)!.processing_heartbeat_at).toMatch(/^1970-01-01/);
    expect(liveSlots()).toBe(1);
  });

  it("the result bound refuses extra keys, lease columns, oversized text and bad kinds (29); a refused result fails as save_failed", async () => {
    queueMode();
    const a = await queued();
    const j = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "b", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    expect(callAs("analysis_worker", "mark_job_dispatched", { p_job: j.jobId, p_claim: j.claimId, p_adapter: "synthetic" })).toMatchObject({ reason: "dispatched" });
    const v = validateFullSwingModelResponse(syntheticFullSwingResponse());
    if (!v.ok) throw new Error(v.reason);
    const good = JSON.parse(JSON.stringify(toStoredFullSwingResult(v.report, v.assessment, { spineAngle: null, hipRotation: null, shoulderRotation: null, tempoRatio: null })));
    const bad = [
      { ...good, status: "complete" }, { ...good, processing_claim_id: null }, { ...good, user_id: golfer.id },
      { ...good, feedback: "x".repeat(4001) }, { ...good, score: 101 }, { ...good, spine_angle: "35" },
      { ...good, metrics: { ...good.metrics, secret: 1 } }, { ...good, swing_highlights: Array(5).fill({ checkpoint: null, positive_movement: "a", mechanical_benefit: "b" }) },
      (({ feedback: _f, ...rest }) => rest)(good),
      // security review 1 note 6 / QA row 29: sizes and section types
      { ...good, metrics: { ...good.metrics, scoring_breakdown: "x".repeat(70_000) } },
      { ...good, metrics: { ...good.metrics, fault_tags: [1] } },
      { ...good, metrics: { ...good.metrics, posture: { rating: "a", observation: "b", correction: "c", extra: "d" } } },
      { ...good, metrics: { ...good.metrics, drills: [{ name: 5 }] } },
      { ...good, tempo_ratio: 100 },
      { ...good, mechanical_deficiencies: Array(5).fill({}) },
      { ...good, feedback: "" },
    ];
    for (const p of bad) expect(callAs("analysis_worker", "complete_analysis_job", { p_job: j.jobId, p_claim: j.claimId, p_result: p })).toBe("result_refused");
    expect(callAs("analysis_worker", "fail_analysis_job", { p_job: j.jobId, p_claim: j.claimId, p_kind: "operator" })).toBe("bad_kind");
    expect((await row(a.analysisId)).status).toBe("processing");
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: j.jobId, p_claim: j.claimId, p_result: good })).toBe("completed");
    // the worker maps a refused (validated) result to save_failed: charged, definite failure
    drainQueue();
    const b = await queued();
    const refusing: RpcFault = (fn) => (fn === "complete_analysis_job" ? { respond: "result_refused" } : "pass");
    expect(await runWorkerOnce({ workerId: "b", rpc: workerRpc(refusing), adapter: createSyntheticFullSwingAdapter(), video }))
      .toEqual({ kind: "failed", jobId: b.jobId, failure: "save_failed", outcome: "failed" });
    expect(ledgerOfJob(b.jobId)).toMatchObject({ state: "charged", reason: "save_failed" });
    expect(jobsOf(b.analysisId)[0]).toMatchObject({ state: "failed_definite", failure_kind: "save_failed" });
  });

  it("rollback with jobs in flight: switches off hold the queue, the mode change keeps job-bearing analyses in admission, and a running dispatch may still finish", async () => {
    queueMode();
    const a = await queued();
    const b = await queued(await createGolfer("par"));
    const g = gate();
    const adapter = createSyntheticFullSwingAdapter({ gate: g.wait });
    const worker = runWorkerOnce({ workerId: "rb", rpc: workerRpc(), adapter, video, scheduler: manualScheduler().scheduler });
    for (let i = 0; i < 100 && adapter.calls() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    setControl({ execution_mode_full_swing: "sync", admissions_enabled: false, dispatch_enabled: false });
    expect(admitSql(golfer.id, a.analysisId)).toMatchObject({ disposition: "replayed", attempt: { id: a.jobId, state: "processing" } });
    expect(admitSql((await row(b.analysisId)).user_id as string, b.analysisId)).toMatchObject({ disposition: "replayed", attempt: { id: b.jobId, state: "queued" } });
    expect(callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" })).toBeNull();
    g.open();
    expect(await worker).toMatchObject({ kind: "completed", jobId: a.jobId });
    expect(jobsOf(b.analysisId)[0]).toMatchObject({ state: "queued" });
    expect(adapter.calls()).toBe(1);
  });
});

describe("reviews 1: an expired holder never dispatches; reconciled attempts can be retried; a lost completion answer is retried", () => {
  it("cap 1: A's claim expires and its slot goes to B (A's row was locked during the scan); A's mark and heartbeat are fenced (arch 1)", async () => {
    queueMode({ max_concurrent_dispatch: 1 });
    const a = await queued();
    const jobA = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "A", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    expect(jobA.jobId).toBe(a.jobId);
    ageClaim(a.analysisId, 1000); // A stopped reporting before its mark
    const b = await queued(await createGolfer("par"));
    // A's analysis row is briefly locked (an old-build claim attempt, a cascade): the scan skips it and B gets the slot
    const hold = psqlAsync(`set application_name = 'p2_hold_a1'; begin; select 1 from public.swing_analysis where id = ${lit(a.analysisId, "uuid")} for update; select pg_sleep(3); commit;`);
    await until(() => sessionSleeping("p2_hold_a1"), 5000, 50); // A's row is provably locked before B's acquire
    const jobB = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "B", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    await hold;
    expect(jobB.jobId).toBe(b.jobId);
    expect(callAs("analysis_worker", "heartbeat_analysis_job", { p_job: jobA.jobId, p_claim: jobA.claimId })).toBe(false);
    expect(callAs("analysis_worker", "mark_job_dispatched", { p_job: jobA.jobId, p_claim: jobA.claimId, p_adapter: "synthetic" })).toMatchObject({ reason: "fenced" });
    expect(callAs("analysis_worker", "mark_job_dispatched", { p_job: jobB.jobId, p_claim: jobB.claimId, p_adapter: "synthetic" })).toMatchObject({ reason: "dispatched" });
    expect(Number(psql("select count(*) from public.analysis_jobs where dispatched_at is not null and state in ('dispatched','outcome_unknown');", "postgres"))).toBe(1);
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "claimed", dispatched_at: null }); // recoverable later by takeover
  });

  it("the dispatch mark recounts the cap under the control lock: above the cap it is a policy hold", async () => {
    queueMode({ max_concurrent_dispatch: 2 });
    const a = await queued(await createGolfer("par"));
    const b = await queued(await createGolfer("par"));
    const ja = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    const jb = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "y", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    expect(new Set([ja.jobId, jb.jobId])).toEqual(new Set([a.jobId, b.jobId]));
    setControl({ max_concurrent_dispatch: 1 });
    expect(callAs("analysis_worker", "mark_job_dispatched", { p_job: ja.jobId, p_claim: ja.claimId, p_adapter: "synthetic" })).toMatchObject({ reason: "policy_hold" });
    expect(callAs("analysis_worker", "requeue_undispatched_job", { p_job: ja.jobId, p_claim: ja.claimId, p_policy: true })).toBe("requeued");
    expect(callAs("analysis_worker", "mark_job_dispatched", { p_job: jb.jobId, p_claim: jb.claimId, p_adapter: "synthetic" })).toMatchObject({ reason: "dispatched" });
  });

  it("an attempt reconciled by the operator can be retried by naming it (21)", async () => {
    queueMode();
    const a = await queued();
    expect(await runWorkerOnce({ workerId: "r", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter({ outcome: { kind: "unknown" } }), video })).toMatchObject({ kind: "outcome_unknown" });
    operator(`select public.reconcile_analysis_job(${lit(a.jobId, "uuid")}, 'released');`);
    expect(admitSql(golfer.id, a.analysisId)).toMatchObject({ disposition: "failed_observed", attempt: { id: a.jobId, state: "failed", failureKind: "not_finished" } });
    const retry = admitSql(golfer.id, a.analysisId, true, a.jobId);
    expect(retry).toMatchObject({ disposition: "created", attempt: { generation: 2 } });
    expect(await runWorkerOnce({ workerId: "r", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter(), video })).toMatchObject({ kind: "completed", jobId: attemptOf(retry) });
  });

  it("a completion whose answer never arrived is retried once and lands", async () => {
    queueMode();
    const a = await queued();
    let dropped = 0;
    const tick = await runWorkerOnce({ workerId: "c", rpc: workerRpc((fn) => (fn === "complete_analysis_job" && dropped++ === 0 ? "drop" : "pass")), adapter: createSyntheticFullSwingAdapter(), video });
    expect(tick).toEqual({ kind: "completed", jobId: a.jobId, outcome: "completed" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged" });
  });
});

describe("reviews 1: one golfer's locked row delays another golfer's admission at most by the mark's 2 s lock timeout", () => {
  it("admission for B answers while A's analysis row is locked, and while A's dispatch mark waits on it (mark gives up after lock_timeout)", async () => {
    queueMode();
    const a = await queued();
    const jobA = callAs("analysis_worker", "acquire_analysis_job", { p_worker: "l", p_adapter: "synthetic" }) as { jobId: string; claimId: string };
    expect(jobA.jobId).toBe(a.jobId);
    const b = await createGolfer("par");
    const idB = await createAnalysis(b, "full_swing", { upload: true });
    const hold = psqlAsync(`set application_name = 'p2_hold_li'; begin; select 1 from public.swing_analysis where id = ${lit(a.analysisId, "uuid")} for update; select pg_sleep(9); commit;`);
    await until(() => sessionSleeping("p2_hold_li"), 5000, 50); // A's row is provably locked
    let t0 = Date.now();
    const plain = await psqlAsync(`begin; set local role service_role; select 'R:' || public.admit_analysis_job(${lit(b.id, "uuid")}, ${lit(idB, "uuid")}, true)::text; commit;`);
    const plainMs = Date.now() - t0;
    expect(plain.out).toContain('"disposition": "created"');
    expect(plainMs).toBeLessThan(2500);
    // A's mark takes the control row and then waits on A's analysis row
    const mark = psqlAsync(`set application_name = 'p2_mark'; begin; set local role analysis_worker; select 'R:' || public.mark_job_dispatched(${lit(jobA.jobId, "uuid")}, ${lit(jobA.claimId, "uuid")}, 'synthetic')::text; commit;`);
    await until(() => sessionWaitsOnLock("p2_mark"), 4000, 25); // the mark holds the control row and waits on A's row
    const idB2 = await createAnalysis(b, "full_swing", { upload: true });
    t0 = Date.now();
    const during = await psqlAsync(`begin; set local role service_role; select 'R:' || public.admit_analysis_job(${lit(b.id, "uuid")}, ${lit(idB2, "uuid")}, true)::text; commit;`);
    const duringMs = Date.now() - t0;
    const m = await mark;
    await hold;
    expect(m.code).not.toBe(0);
    expect(m.err).toMatch(/lock timeout/i);
    expect(during.code).toBe(0);
    expect(during.out).toMatch(/"disposition": "(created|limit_reached)"/);
    expect(duringMs).toBeLessThan(4000); // bounded by the mark's 2 s lock_timeout (below admission's 5 s), not by the 9 s row lock
    console.log(JSON.stringify({ lockIndependence: { plainMs, duringMs } }));
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "claimed", dispatched_at: null });
    expect(someoneWaitsOnLock()).toBe(false);
  });
});

describe("reviews 2: a committed completion whose answer was lost", () => {
  it("the retry answers completed (same claim, job succeeded): the tick reports completed, charged once", async () => {
    queueMode();
    const a = await queued();
    let n = 0;
    const tick = await runWorkerOnce({ workerId: "lc", rpc: workerRpc((fn) => (fn === "complete_analysis_job" && n++ === 0 ? "lose_after_commit" : "pass")), adapter: createSyntheticFullSwingAdapter(), video });
    expect(n).toBe(2);
    expect(tick).toEqual({ kind: "completed", jobId: a.jobId, outcome: "completed" });
    expect(jobsOf(a.analysisId)[0]).toMatchObject({ state: "succeeded" });
    expect(ledgerOfJob(a.jobId)).toMatchObject({ state: "charged", reason: "completed" });
    // another claim never gets that answer
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: a.jobId, p_claim: crypto.randomUUID(), p_result: {} })).toBe("fenced");
  });
});
