// ============================================================================
// AG-WEB-READY-10-P2 — POST /api/analyze-swing and GET /api/v1/analyses/{id} with durable admission, against the real
// local database
// ============================================================================
//
// The actual route handlers run in-process against the run's disposable stack (real GoTrue verification, real
// PostgREST grants and RLS, real admit_analysis_job / read_analysis_job_state, real Storage). Replaced boundaries:
// `server-only` (marker), `next/headers` (request scope: the Bearer the route's ingress verifies), and
// `@/lib/gemini-transport` generateContentOnce (counted; it must never be reached on these paths). The background work
// is the real worker core with the synthetic adapter, over the SET ROLE analysis_worker transport.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ calls: 0 }));
const request = vi.hoisted(() => ({ authorization: null as string | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, getAll: () => [] }),
  headers: () => new Headers(request.authorization ? { authorization: request.authorization } : {}),
}));
vi.mock("@/lib/gemini-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini-transport")>();
  return { ...actual, generateContentOnce: async () => { provider.calls += 1; throw new Error("the provider is never called on these paths"); } };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/analyze-swing/route";
import { GET as getResultV1 } from "@/app/api/v1/analyses/[id]/route";
import { runWorkerOnce, type WorkerVideoSource } from "@/lib/analysis-job-worker";
import { createSyntheticFullSwingAdapter } from "@/lib/analysis-provider-adapter";
import { ADMISSION_PAUSED_COPY, CLIENT_UPDATE_COPY, INTERRUPTED_UNRESOLVED_COPY, IN_PROGRESS_COPY, LIMIT_REACHED_COPY, NOT_FOUND_COPY, STALLED_COPY, SUPERSEDED_COPY } from "@/lib/analysis-attempt-precedence";
import { readFileSync } from "node:fs";
import path from "node:path";
import { claimAnalysisExecution } from "@/lib/analysis-execution-claim";
import { createClient } from "@supabase/supabase-js";
import { VIDEO_UNUSABLE_COPY } from "@/lib/swing-video-source";
import { admin, cleanupFixtures, createAnalysis, createGolfer, row, setTier, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";
import { drainQueue, jobsOf, ledgerOfAnalysis, operator, psql, psqlTry, queueMode, resetControl, setControl, workerRpc } from "./analysis-jobs-harness";

const MIGRATION = readFileSync(path.resolve(__dirname, "../../migrations/20261127120000_analysis_jobs.sql"), "utf8");

const video: WorkerVideoSource = {
  async load(job) {
    if (!job.storagePath.startsWith(`${job.userId}/`)) return { status: "unusable" };
    const r = await admin.storage.from("swing-videos").download(job.storagePath);
    if (r.error || !r.data) return { status: "unusable" };
    return { status: "ok", bytes: await r.data.arrayBuffer(), mimeType: "video/mp4" };
  },
};

async function analyze(golfer: Golfer | null, analysisId: string, options: { declared?: boolean; body?: Record<string, unknown> } = {}) {
  request.authorization = golfer ? `Bearer ${golfer.accessToken}` : null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (golfer) headers.authorization = `Bearer ${golfer.accessToken}`;
  if (options.declared ?? true) headers["x-swingproai-admission"] = "1";
  const res = await POST(new NextRequest("http://localhost/api/analyze-swing", { method: "POST", headers, body: JSON.stringify({ analysisId, ...options.body }) }));
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
}
async function readV1(golfer: Golfer, analysisId: string) {
  request.authorization = `Bearer ${golfer.accessToken}`;
  const res = await getResultV1(new Request(`http://localhost/api/v1/analyses/${analysisId}`), { params: { id: analysisId } });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
}
const work = () => runWorkerOnce({ workerId: "route-test", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter(), video });
const dispatches = (analysisId: string) => jobsOf(analysisId).filter((j) => j.dispatched_at !== null).length;

let golfer: Golfer;
let stranger: Golfer;
beforeAll(async () => {
  golfer = await createGolfer("birdie");
  stranger = await createGolfer("par");
});
beforeEach(() => {
  resetControl();
  drainQueue();
  provider.calls = 0;
});
afterAll(async () => {
  resetControl();
  drainQueue();
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

describe("the default (sync) mode keeps today's behaviour", () => {
  it("keyless baseline on the changed candidate: 503 with the exact copy, the row unchanged, no job, no provider call", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const before = await row(id);
    const saved = { g: process.env.GEMINI_API_KEY, a: process.env.GOOGLE_AI_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      for (const declared of [true, false]) {
        const r = await analyze(golfer, id, { declared });
        expect(r.status).toBe(503);
        expect(r.body).toEqual({ error: "AI analysis is temporarily unavailable. Please try again later." });
      }
    } finally {
      if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
      if (saved.a !== undefined) process.env.GOOGLE_AI_API_KEY = saved.a;
    }
    expect(await row(id)).toEqual(before);
    expect(jobsOf(id)).toEqual([]);
    expect(ledgerOfAnalysis(id)).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  it("a missing control row answers 503 even in sync mode, never the synchronous path", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const { psql } = await import("./analysis-jobs-harness");
    psql("delete from public.analysis_admission_control;", "postgres");
    try {
      const r = await analyze(golfer, id);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ status: "admission_paused" });
    } finally {
      psql("insert into public.analysis_admission_control (id) values (true);", "postgres");
    }
    expect(provider.calls).toBe(0);
  });
});

describe("queue mode: one deliberate press, one durable acceptance", () => {
  it("202 with the attempt, Location and no-store; a lost answer's replay names the same attempt; no provider call", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const first = await analyze(golfer, id, { body: { mediapipeMetrics: { spineAngle: 33, tempoRatio: "3:1", hipRotation: "nope" } } });
    expect(first.status).toBe(202);
    expect(first.headers.get("location")).toBe(`/api/v1/analyses/${id}`);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatchObject({ status: "queued", analysisId: id, attempt: { generation: 1, state: "queued" }, statusUrl: `/api/v1/analyses/${id}`, reportUrl: `/analyze/${id}`, replayed: false });
    const attempt = (first.body.attempt as { id: string }).id;
    const again = await analyze(golfer, id);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ replayed: true, attempt: { id: attempt } });
    expect(jobsOf(id)).toHaveLength(1);
    expect(jobsOf(id)[0].client_metrics).toEqual({ spineAngle: 33, tempoRatio: "3:1" });
    expect(ledgerOfAnalysis(id)).toHaveLength(1);
    expect((await row(id)).status).toBe("pending");
    expect(provider.calls).toBe(0);
    const v1 = await readV1(golfer, id);
    expect(v1.status).toBe(200);
    expect(v1.body.data).toMatchObject({ status: "pending", execution: "queued", attempt: { id: attempt, state: "queued" } });
  });

  it("a Bearer request without the declaration is refused with client_update_required and creates nothing (26)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const r = await analyze(golfer, id, { declared: false });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ status: "client_update_required", error: CLIENT_UPDATE_COPY });
    expect(jobsOf(id)).toEqual([]);
    const anonymous = await analyze(null, id);
    expect(anonymous.status).toBe(401);
    expect(jobsOf(id)).toEqual([]);
  });

  it("the worker finishes; reads, replays and reopening only read: one dispatch, the labelled unscored result through the V1 read", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const attempt = ((await analyze(golfer, id)).body.attempt as { id: string }).id;
    expect((await work()).kind).toBe("completed");
    for (let i = 0; i < 3; i++) {
      const r = await analyze(golfer, id);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ message: "Analysis complete", data: { status: "complete", score: null }, attempt: { id: attempt, state: "complete" } });
      expect(String((r.body.data as { feedback: string }).feedback)).toMatch(/^SYNTHETIC TEST RESULT/);
    }
    const v1 = await readV1(golfer, id);
    expect(v1.body.data).toMatchObject({ status: "complete", score: null, execution: "complete", attempt: { id: attempt } });
    expect(dispatches(id)).toBe(1);
    expect(jobsOf(id)).toHaveLength(1);
    expect(provider.calls).toBe(0);
  });

  it("a completed report stays readable through the normal entitlement path after its video becomes unavailable or the plan changes", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    await analyze(golfer, id);
    await work();
    const stored = await row(id);
    const rm = await admin.storage.from("swing-videos").remove([`${golfer.id}/${id}/ent1d.mp4`]);
    expect(rm.error).toBeNull();
    let r = await analyze(golfer, id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: { id, status: "complete", feedback: stored.feedback } });
    await setTier(golfer.id, "none");
    r = await analyze(golfer, id);
    expect(r.status).toBe(200);
    expect((await readV1(golfer, id)).body.data).toMatchObject({ status: "complete", execution: "complete" });
    await setTier(golfer.id, "birdie");
    // another golfer gets nothing of it through the same paths
    expect((await analyze(stranger, id)).status).toBe(404);
    expect((await readV1(stranger, id)).status).toBe(404);
    expect(dispatches(id)).toBe(1);
  });

  it("retries name the attempt: failed_observed shows it; Retry creates one successor; a stale or invented reference changes nothing", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: false }); // no object: the worker finds the video unusable
    const g1 = ((await analyze(golfer, id)).body.attempt as { id: string }).id;
    expect(await work()).toMatchObject({ kind: "failed", failure: "video_unusable" });
    const observed = await analyze(golfer, id);
    expect(observed.status).toBe(409);
    expect(observed.body).toMatchObject({ status: "failed", attempt: { id: g1, state: "failed", failureKind: "video_unusable" } });
    expect(JSON.stringify(observed.body)).not.toMatch(/claim|worker|provider_rejected/);
    const [r1, r2] = await Promise.all([analyze(golfer, id, { body: { retryOfAttemptId: g1 } }), analyze(golfer, id, { body: { retryOfAttemptId: g1 } })]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    const g2 = (r1.body.attempt as { id: string }).id;
    expect((r2.body.attempt as { id: string }).id).toBe(g2);
    expect(jobsOf(id).map((j) => j.generation)).toEqual([1, 2]);
    await work(); // g2 fails the same way
    const stale = await analyze(golfer, id, { body: { retryOfAttemptId: g1 } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ status: "superseded", error: SUPERSEDED_COPY, attempt: { id: g2 } });
    for (const ref of [crypto.randomUUID(), "1; select 1", 7]) {
      const r = await analyze(golfer, id, { body: { retryOfAttemptId: ref } });
      expect(r.status, String(ref)).toBe(404);
      expect(r.body).toEqual({ error: NOT_FOUND_COPY });
    }
    expect(jobsOf(id).map((j) => j.generation)).toEqual([1, 2]);
    expect(provider.calls).toBe(0);
  });

  it("paused admissions and limits answer with their copy and create nothing; a video that is not ready is 422", async () => {
    queueMode({ admissions_enabled: false });
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    let r = await analyze(golfer, id);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ status: "admission_paused", error: ADMISSION_PAUSED_COPY });
    setControl({ admissions_enabled: true, global_daily_units: 0 });
    r = await analyze(golfer, id);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ status: "limit_reached", error: LIMIT_REACHED_COPY });
    expect(jobsOf(id)).toEqual([]);
    setControl({ global_daily_units: null });
    const { operator, lit } = await import("./analysis-jobs-harness");
    operator(`update public.swing_videos set status = 'pending' where id = ${lit(id, "uuid")};`);
    r = await analyze(golfer, id);
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ status: "video_unusable", error: VIDEO_UNUSABLE_COPY });
    expect(provider.calls).toBe(0);
  });
});

describe("reviews 1: HTTP mapping of running and interrupted work; reads through real PostgREST", () => {
  it("a live synchronous claim answers 409 processing; an attempt whose outcome is unknown answers 409 stalled", async () => {
    queueMode();
    const live = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await claimAnalysisExecution({ analysisId: live, userId: golfer.id, family: "full_swing" })).outcome).toBe("claimed");
    expect(await analyze(golfer, live)).toMatchObject({ status: 409, body: { status: "processing", error: IN_PROGRESS_COPY } });
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    await analyze(golfer, id);
    expect((await runWorkerOnce({ workerId: "route-test", rpc: workerRpc(), adapter: createSyntheticFullSwingAdapter({ outcome: { kind: "unknown" } }), video })).kind).toBe("outcome_unknown");
    const r = await analyze(golfer, id);
    expect(r.status).toBe(409);
    // A1: an attempt whose dispatch is unresolved is described accurately (its outcome is not confirmed yet), never as
    // "can't be finished" (STALLED_COPY is for a synchronous stall, which has no attempt)
    expect(r.body).toMatchObject({ status: "stalled", error: INTERRUPTED_UNRESOLVED_COPY, attempt: { state: "interrupted" } });
    expect(r.body.error).not.toBe(STALLED_COPY);
    expect(provider.calls).toBe(0);
  });

  it("read_analysis_job_state(s) over PostgREST: the owner reads its own; a stranger and a mixed list read nothing of the other; anon is refused", async () => {
    queueMode();
    const mine = await createAnalysis(golfer, "full_swing", { upload: true });
    await analyze(golfer, mine);
    const theirs = await createAnalysis(stranger, "full_swing", { upload: true });
    const as = (g: Golfer) => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${g.accessToken}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const own = await as(golfer).rpc("read_analysis_job_state", { p_analysis: mine });
    expect(own.error).toBeNull();
    expect(own.data).toMatchObject({ analysisId: mine, execution: "queued", attempt: { state: "queued" } });
    const foreign = await as(stranger).rpc("read_analysis_job_state", { p_analysis: mine });
    expect(foreign.error).toBeNull();
    expect(foreign.data).toBeNull();
    const mixed = await as(stranger).rpc("read_analysis_job_states", { p_ids: [mine, theirs] });
    expect(mixed.data).toEqual([{ analysisId: theirs, execution: "idle", attempt: null }]);
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const refused = await anon.rpc("read_analysis_job_state", { p_analysis: mine });
    expect(refused.data).toBeNull();
    expect(refused.error?.code).toBe("42501");
    // the service-role key carries no golfer: the reader takes the owner from the JWT's `sub` only
    const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const asService = await service.rpc("read_analysis_job_state", { p_analysis: mine });
    expect(asService.data ?? null).toBeNull();
    const asServiceList = await service.rpc("read_analysis_job_states", { p_ids: [mine] });
    expect(asServiceList.error ? [] : asServiceList.data).not.toContainEqual(expect.objectContaining({ execution: "queued" }));
    const admitByBrowser = await as(golfer).rpc("admit_analysis_job", { p_user: golfer.id, p_analysis: mine, p_declared: true });
    expect(admitByBrowser.error?.code).toBe("42501");
    const workerByBrowser = await as(golfer).rpc("acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" });
    expect(workerByBrowser.error?.code).toBe("42501");
  });
});

describe("reviews 2: an HTTP Retry naming another golfer's attempt", () => {
  it("answers 404 with the not-found copy and creates nothing for either golfer", async () => {
    queueMode();
    const mine = await createAnalysis(golfer, "full_swing", { upload: true });
    const theirs = await createAnalysis(stranger, "full_swing", { upload: true });
    const theirAttempt = ((await analyze(stranger, theirs)).body.attempt as { id: string }).id;
    const r = await analyze(golfer, mine, { body: { retryOfAttemptId: theirAttempt } });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: NOT_FOUND_COPY });
    expect(jobsOf(mine)).toEqual([]);
    expect(jobsOf(theirs).map((j) => j.id)).toEqual([theirAttempt]);
    expect(provider.calls).toBe(0);
  });
});


// ── AG-WEB-READY-10-P2-A1 ────────────────────────────────────────────────────

describe("A1: attempt identity, unreadable status, read/press agreement and putting, through the real routes", () => {
  it("attempt 1 fails, a Retry creates attempt 2: the first press replayed while 2 is open (202) and after it completes (200) names attempt 1 with attempt 2 as current; repeats of the Retry name attempt 2; counts", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const first = await analyze(golfer, id);
    expect(first.status).toBe(202);
    const g1 = (first.body.attempt as { id: string }).id;
    const failing = createSyntheticFullSwingAdapter({ outcome: { kind: "unusable" } });
    expect((await runWorkerOnce({ workerId: "route-a1", rpc: workerRpc(), adapter: failing, video })).kind).toBe("failed");
    const retry = await analyze(golfer, id, { body: { retryOfAttemptId: g1 } });
    expect(retry.status).toBe(202);
    const g2 = (retry.body.attempt as { id: string }).id;
    expect(g2).not.toBe(g1);
    expect(retry.body.current).toBeUndefined();
    const replay = await analyze(golfer, id);
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ status: "queued", analysisId: id, replayed: true, attempt: { id: g1, generation: 1, state: "failed" }, current: { id: g2, generation: 2, state: "queued" } });
    expect(replay.headers.get("location")).toBe(`/api/v1/analyses/${id}`);
    const again = await analyze(golfer, id, { body: { retryOfAttemptId: g1 } });
    expect(again).toMatchObject({ status: 202, body: { replayed: true, attempt: { id: g2 } } });
    expect(again.body.current).toBeUndefined();
    expect((await work()).kind).toBe("completed");
    const done = await analyze(golfer, id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ message: "Analysis complete", data: { status: "complete" }, attempt: { id: g1, state: "failed" }, current: { id: g2, state: "complete" } });
    for (let i = 0; i < 2; i++) {
      const r = await analyze(golfer, id, { body: { retryOfAttemptId: g1 } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ attempt: { id: g2, state: "complete" } });
      expect(r.body.current).toBeUndefined();
    }
    expect((await readV1(golfer, id)).body.data).toMatchObject({ status: "complete", execution: "complete", attempt: { id: g2 } });
    expect(jobsOf(id).map((j) => [j.generation, j.state])).toEqual([[1, "failed_definite"], [2, "succeeded"]]);
    expect(ledgerOfAnalysis(id).map((l) => l.state)).toEqual(["charged", "charged"]);
    expect(dispatches(id)).toBe(2);
    expect(failing.calls()).toBe(1);
    expect(provider.calls).toBe(0);
    console.log(`A1_ROUTE_IDENTITY attempts ${jobsOf(id).length}, reservations ${ledgerOfAnalysis(id).length}, dispatches ${dispatches(id)}`);
  });

  it("the V1 read says 'unavailable' when the database refuses the status read, and the state again once it is readable; nothing is written", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await analyze(golfer, id)).status).toBe(202);
    expect((await readV1(golfer, id)).body.data).toMatchObject({ status: "pending", execution: "queued", attempt: { state: "queued" } });
    const before = JSON.stringify([await row(id), jobsOf(id), ledgerOfAnalysis(id)]);
    const fn = "public.read_analysis_job_state(uuid)";
    const aclBefore = psql(`select proacl::text from pg_proc where oid = '${fn}'::regprocedure;`);
    psql(`revoke execute on function ${fn} from authenticated;`);
    try {
      const r = await readV1(golfer, id);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: "pending", execution: "unavailable", attempt: null });
    } finally {
      psql(`grant execute on function ${fn} to authenticated;`);
    }
    expect(psql(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE');`)).toBe("t");
    expect(psql(`select proacl::text from pg_proc where oid = '${fn}'::regprocedure;`)).toBe(aclBefore); // review: grantor included
    const block = MIGRATION.slice(MIGRATION.indexOf("do $postflight$"), MIGRATION.indexOf("$postflight$;") + "$postflight$;".length);
    resetControl(); // the postflight also requires the default control row
    const post = psqlTry(`begin;\n${block}\nrollback;`, "postgres");
    expect(post.code, post.err).toBe(0); // the restored grant is exactly the migration's
    expect((await readV1(golfer, id)).body.data).toMatchObject({ execution: "queued" });
    expect(JSON.stringify([await row(id), jobsOf(id), ledgerOfAnalysis(id)])).toBe(before);
    // a confirmed absence of work is idle, never unavailable
    const fresh = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await readV1(golfer, fresh)).body.data).toMatchObject({ status: "pending", execution: "idle", attempt: null });
  });

  it("a recently dispatched synchronous claim reads as processing and a press answers in progress (409), not stalled", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" })).outcome).toBe("claimed");
    operator(`update public.swing_analysis set provider_dispatched_at = now(), processing_heartbeat_at = now() where id = '${id}';`);
    expect((await readV1(golfer, id)).body.data).toMatchObject({ status: "processing", execution: "processing" });
    expect(await analyze(golfer, id)).toMatchObject({ status: 409, body: { status: "processing", error: IN_PROGRESS_COPY } });
    expect(jobsOf(id)).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  it("putting keeps its established answer whatever the full-swing switches say, and reads idle (never paused)", async () => {
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    for (const mode of ["sync", "queue", "queue_paused"] as const) {
      resetControl();
      if (mode === "queue") queueMode();
      if (mode === "queue_paused") queueMode({ admissions_enabled: false });
      const id = await createAnalysis(golfer, "putting", { upload: true });
      expect((await readV1(golfer, id)).body.data, mode).toMatchObject({ status: "pending", analysisFamily: "putting", execution: "idle" });
      const r = await analyze(golfer, id);
      answers.push({ status: r.status, body: r.body });
      expect(jobsOf(id), mode).toEqual([]);
      console.log(`A1_PUTTING mode ${mode}: read idle, press ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    // putting runs its unchanged synchronous path in every mode: here it reaches this suite's counted transport stub
    // (which throws: no network, no key) once per press, exactly as it does in sync mode
    expect(provider.calls).toBe(3);
  });
});

// In sync mode the route's admission answers sync_mode and the synchronous path decides with the ENT-1D claim library
// (lib/analysis-execution-claim.ts). With the model keys empty that path answers 503 before any claim, so the claim
// library itself — what the synchronous path calls on a press — is the deciding answer here.
describe("A1 (review): sync mode — the read and the synchronous path's claim agree", () => {
  it("a recently dispatched synchronous claim: read processing; the synchronous claim is refused (in progress); admission says sync_mode; nothing is created", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" })).outcome).toBe("claimed");
    operator(`update public.swing_analysis set provider_dispatched_at = now(), processing_heartbeat_at = now() where id = '${id}';`);
    expect((await readV1(golfer, id)).body.data).toMatchObject({ execution: "processing" });
    const again = await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" });
    expect(again.outcome).not.toBe("claimed");
    const r = await analyze(golfer, id);
    expect(jobsOf(id)).toEqual([]);
    expect(provider.calls).toBe(0);
    console.log(`A1_SYNC_LIVE read processing -> claim ${again.outcome}; route ${r.status}`);
  });

  it("an expired synchronous claim that never dispatched: read idle (startable); the synchronous claim takes it over (recovered); no job", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const first = await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" });
    if (first.outcome !== "claimed") throw new Error("claim");
    operator(`update public.swing_analysis set processing_started_at = processing_started_at - interval '1000 seconds',
      processing_heartbeat_at = processing_heartbeat_at - interval '1000 seconds' where id = '${id}';`);
    expect((await readV1(golfer, id)).body.data).toMatchObject({ status: "processing", execution: "idle" });
    const again = await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" });
    expect(again).toMatchObject({ outcome: "claimed", recovered: true });
    expect((await readV1(golfer, id)).body.data).toMatchObject({ execution: "processing" });
    expect(jobsOf(id)).toEqual([]);
    expect(provider.calls).toBe(0);
    console.log("A1_SYNC_TAKEOVER read idle -> synchronous claim recovered; no job");
  });

  it("review 2: putting with an expired claim that never dispatched reads idle in every mode, and its synchronous claim takes it over (putting never reaches admission)", async () => {
    for (const mode of ["sync", "queue_paused"] as const) {
      resetControl();
      if (mode === "queue_paused") queueMode({ admissions_enabled: false });
      const id = await createAnalysis(golfer, "putting", { upload: true });
      const first = await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "putting" });
      if (first.outcome !== "claimed") throw new Error("claim");
      operator(`update public.swing_analysis set processing_started_at = processing_started_at - interval '1000 seconds',
        processing_heartbeat_at = processing_heartbeat_at - interval '1000 seconds' where id = '${id}';`);
      expect((await readV1(golfer, id)).body.data, mode).toMatchObject({ analysisFamily: "putting", execution: "idle" });
      expect(await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "putting" }), mode).toMatchObject({ outcome: "claimed", recovered: true });
      expect(jobsOf(id), mode).toEqual([]);
    }
    expect(provider.calls).toBe(0);
  });
});
