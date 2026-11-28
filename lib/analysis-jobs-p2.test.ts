import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// ============================================================================
// AG-WEB-READY-10-P2 — the durable full-swing admission and worker modules (pure units)
// ============================================================================
//
// The shared metric validators, the full-swing contract's new bound and stored-result mapping (with SQL parity), the
// synthetic adapter, the shared precedence rule, the admission answer parsing, and the worker core over a fake RPC
// transport (C1: the adapter runs only on an acknowledged `dispatched`). The database itself is exercised by
// supabase/tests/app-integration/analysis-jobs.*.integration.test.ts.

vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => { throw new Error("no admin client in unit tests"); } }));

import { CLIENT_TEMPO_RATIO_PATTERN, clientAngle, clientTempoRatio, sanitizeClientMetrics } from "@/lib/analysis-metrics-validation";
import {
  MAX_EXECUTIVE_SUMMARY_CHARS, MAX_FINDINGS, MAX_STORED_METRICS_BYTES, MAX_STORED_RESULT_BYTES, MAX_STORED_TEMPO_RATIO,
  toStoredFullSwingResult, validateFullSwingModelResponse, buildMetricEvidence, parseTempoRatioToNumber,
} from "@/lib/full-swing-analysis-contract";
import { createSyntheticFullSwingAdapter, syntheticFullSwingResponse, SYNTHETIC_RESULT_LABEL } from "@/lib/analysis-provider-adapter";
import {
  ADMISSION_DISPOSITIONS, ADMISSION_HTTP, DISPLAY_PRECEDENCE, acceptedAttempt, golferStatusLabel, parseGolferAttempt,
  parseGolferJobState, parseGolferJobStates, reportViewFor, type GolferAttempt, type GolferJobState,
  INTERRUPTED_UNRESOLVED_COPY, STALLED_COPY, describedAttempt, executionOfAttempt, readGolferJobState, readGolferJobStates,
} from "@/lib/analysis-attempt-precedence";
import { admissionResponseBody, parseAdmission, readRetryOfAttemptId } from "@/lib/analysis-job-admission";
import { parseAcquiredJob, readDispatchPermission, runWorkerOnce, type WorkerFunction, type WorkerRpc } from "@/lib/analysis-job-worker";
import { decideAnalysisAccess } from "@/lib/analysis-entitlement-authority";

const MIGRATION = readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20261127120000_analysis_jobs.sql"), "utf8");
const UUID = () => crypto.randomUUID();

describe("metric validators (shared by the route, the worker and the database CHECK)", () => {
  it("keep only finite angles within one turn and N:1 / N.N:1 tempos", () => {
    expect([0, -360, 360, 34.5].map(clientAngle)).toEqual([0, -360, 360, 34.5]);
    expect([361, -361, NaN, Infinity, "35", null, undefined, {}].map(clientAngle)).toEqual(Array(8).fill(null));
    expect(["3:1", "3.0:1", "12.25:1"].map(clientTempoRatio)).toEqual(["3:1", "3.0:1", "12.25:1"]);
    expect(["3", "3:2", "123:1", "3.123:1", " 3:1", 3, null].map(clientTempoRatio)).toEqual(Array(7).fill(null));
  });

  it("sanitize drops unknown keys, nulls, strings for angles and nested values; empty means null", () => {
    expect(sanitizeClientMetrics({ spineAngle: 31, hipRotation: "45", tempoRatio: "3:1", extra: 1, shoulderRotation: { v: 1 }, impactSpineAngle: null }))
      .toEqual({ spineAngle: 31, tempoRatio: "3:1" });
    expect(sanitizeClientMetrics({ extra: 1 })).toBeNull();
    expect(sanitizeClientMetrics([1, 2])).toBeNull();
    expect(sanitizeClientMetrics(null)).toBeNull();
  });

  it("the database CHECK uses the same tempo pattern and angle range", () => {
    expect(MIGRATION).toContain(`(e.value #>> '{}') ~ '${CLIENT_TEMPO_RATIO_PATTERN.source}'`);
    expect(MIGRATION).toContain("(e.value #>> '{}')::numeric between -360 and 360");
  });
});

describe("full-swing contract: the summary bound and the stored result (shared by the route and the worker)", () => {
  const scoredFixture = syntheticFullSwingResponse();

  it("the executive summary is bounded by MAX_EXECUTIVE_SUMMARY_CHARS with the existing rejection code", () => {
    const at = validateFullSwingModelResponse({ ...scoredFixture, executive_summary: "x".repeat(MAX_EXECUTIVE_SUMMARY_CHARS) });
    expect(at.ok).toBe(true);
    const over = validateFullSwingModelResponse({ ...scoredFixture, executive_summary: "x".repeat(MAX_EXECUTIVE_SUMMARY_CHARS + 1) });
    expect(over).toEqual({ ok: false, reason: "bad_text" });
  });

  it("toStoredFullSwingResult writes exactly the nine stored columns, with the route's mapping", () => {
    const v = validateFullSwingModelResponse(scoredFixture);
    if (!v.ok) throw new Error(v.reason);
    const client = { spineAngle: 30, hipRotation: null, shoulderRotation: null, tempoRatio: "3:1" };
    const stored = toStoredFullSwingResult(v.report, v.assessment, client);
    expect(Object.keys(stored).sort()).toEqual(["feedback", "hip_rotation", "mechanical_deficiencies", "metrics", "score", "shoulder_rotation", "spine_angle", "swing_highlights", "tempo_ratio"]);
    expect(stored.metrics).toEqual({
      scoring_breakdown: v.report.scoring_breakdown, evidence_limits: v.report.evidence_limits, evidence_coverage: v.report.evidence_coverage,
      metric_evidence: buildMetricEvidence(v.report, client), fault_tags: v.report.fault_tags, drills: v.report.drills, posture: v.report.posture,
      swing_plane: v.report.swing_plane, impact: v.report.impact, practice_focus: v.report.practice_focus, pro_cue: v.report.pro_cue,
      rubric_assessment: v.assessment,
    });
    expect(stored.feedback).toBe(v.report.executive_summary);
    expect(parseTempoRatioToNumber("3:1")).toBe(3);
    expect(parseTempoRatioToNumber("x")).toBeNull();
  });

  it("every SQL result bound is the TypeScript constant (parity), and the SQL entitlement allow-lists agree with the authority", () => {
    const parity = (name: string) => {
      const m = MIGRATION.match(new RegExp(`:= ([0-9.]+);\\s+-- parity: ${name}\\b`));
      if (!m) throw new Error(`no parity constant ${name}`);
      return Number(m[1]);
    };
    expect(parity("MAX_FINDINGS")).toBe(MAX_FINDINGS);
    expect(parity("MAX_EXECUTIVE_SUMMARY_CHARS")).toBe(MAX_EXECUTIVE_SUMMARY_CHARS);
    expect(parity("MAX_STORED_METRICS_BYTES")).toBe(MAX_STORED_METRICS_BYTES);
    expect(parity("MAX_STORED_RESULT_BYTES")).toBe(MAX_STORED_RESULT_BYTES);
    expect(parity("MAX_STORED_TEMPO_RATIO")).toBe(MAX_STORED_TEMPO_RATIO);
    const list = (name: string) => {
      const m = MIGRATION.match(new RegExp(`array\\[([^\\]]+)\\];\\s+-- parity: ${name}\\b`));
      if (!m) throw new Error(`no parity list ${name}`);
      return m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
    };
    const tiers = list("KNOWN_TIERS");
    const statuses = list("KNOWN_STATUSES");
    // set equality with the TypeScript authority's allow-lists (read from its source; they are not exported)
    const authority = readFileSync(path.join(__dirname, "analysis-entitlement-authority.ts"), "utf8");
    const tsList = (name: string) => {
      const m = authority.match(new RegExp(`const ${name}[^=]*= \\[([^\\]]+)\\]`));
      if (!m) throw new Error(`no ${name} in the authority`);
      return m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
    };
    expect([...tiers].sort()).toEqual(tsList("KNOWN_TIERS"));
    expect([...statuses].sort()).toEqual(tsList("KNOWN_STATUSES"));
    for (const t of tiers) for (const st of statuses) expect(decideAnalysisAccess(t, st).status, `${t}/${st}`).toBe("allowed");
    for (const t of ["gold", "", "PAR"]) expect(decideAnalysisAccess(t, "active").status).toBe("unavailable");
    for (const st of ["paused", "", "ACTIVE"]) expect(decideAnalysisAccess("par", st).status).toBe("unavailable");
  });
});

describe("the synthetic adapter (no network, no model, no key)", () => {
  it("answers an unscored, fully labelled response that the contract accepts; the stored report has no score", async () => {
    const body = syntheticFullSwingResponse();
    const v = validateFullSwingModelResponse(body);
    if (!v.ok) throw new Error(v.reason);
    expect(v.report.score).toBeNull();
    expect([v.report.spine_angle, v.report.hip_rotation, v.report.shoulder_rotation, v.report.tempo_ratio]).toEqual([null, null, null, null]);
    for (const text of [v.report.executive_summary, v.report.evidence_limits, v.report.scoring_breakdown, v.report.posture.observation]) {
      expect(text.startsWith(SYNTHETIC_RESULT_LABEL), text).toBe(true);
    }
    expect([v.report.highlights, v.report.deficiencies, v.report.drills]).toEqual([[], [], []]);
    const adapter = createSyntheticFullSwingAdapter();
    expect(adapter.providerMode).toBe("synthetic");
    const out = await adapter.run({ jobId: UUID(), analysisId: UUID(), generation: 1, video: { bytes: new ArrayBuffer(8), mimeType: "video/mp4" }, clientMetrics: null, signal: new AbortController().signal });
    expect(out).toEqual({ kind: "response", body });
    expect(adapter.calls()).toBe(1);
  });
});

describe("the shared precedence rule", () => {
  const att = (state: string, extra: Record<string, unknown> = {}) =>
    ({ id: UUID(), generation: 1, state, acceptedAt: "2026-11-27T04:00:00Z", ...extra }) as unknown as GolferAttempt;
  void (null as GolferJobState | null);

  it("parses only the golfer-facing shapes the database returns", () => {
    expect(parseGolferAttempt(att("queued"))).not.toBeNull();
    for (const bad of [att("claimed"), att("failed", { failureKind: "provider_rejected" }), { ...att("queued"), id: "x" }, { ...att("queued"), generation: 0 }, null, []]) {
      expect(parseGolferAttempt(bad)).toBeNull();
    }
    const id = UUID();
    expect(parseGolferJobState({ analysisId: id, execution: "queued", attempt: att("queued") })).toMatchObject({ execution: "queued" });
    expect(parseGolferJobState({ analysisId: id, execution: "dispatched", attempt: null })).toBeNull();
    expect(parseGolferJobState({ analysisId: id, execution: "queued", attempt: { id: "bad" } })).toBeNull();
    expect(parseGolferJobStates([{ analysisId: id, execution: "idle", attempt: null }, { junk: 1 }]).size).toBe(1);
  });

  it("labels: Queued only after an accepted admission; Not analyzed yet for a pending swing; an open retry is never Failed", () => {
    const id = UUID();
    expect(golferStatusLabel("pending", null).label).toBe("Not analyzed yet");
    expect(golferStatusLabel("pending", { analysisId: id, execution: "queued", attempt: att("queued") }).label).toBe("Queued");
    expect(golferStatusLabel("failed", { analysisId: id, execution: "queued", attempt: att("queued", { generation: 2 }) }).label).toBe("Queued");
    expect(golferStatusLabel("processing", { analysisId: id, execution: "processing", attempt: att("processing") }).label).toBe("Analyzing");
    expect(golferStatusLabel("processing", { analysisId: id, execution: "interrupted", attempt: att("interrupted") }).label).toBe("Interrupted");
    expect(golferStatusLabel("complete", { analysisId: id, execution: "complete", attempt: att("complete") }).label).toBe("Complete");
    expect(DISPLAY_PRECEDENCE).toEqual(["complete", "open_attempt", "finished_attempt", "no_attempt"]);
  });

  it("report views follow complete > open attempt > finished attempt > none", () => {
    const id = UUID();
    const js = (execution: string, a: unknown) => parseGolferJobState({ analysisId: id, execution, attempt: a });
    expect(reportViewFor("complete", js("queued", att("queued")))).toBe("complete");
    expect(reportViewFor("pending", js("queued", att("queued")))).toBe("queued");
    expect(reportViewFor("failed", js("failed", att("failed", { failureKind: "not_finished" })))).toBe("failed_attempt");
    expect(reportViewFor("failed", js("failed", att("failed", { failureKind: "video_unusable" })))).toBe("failed_unusable");
    expect(reportViewFor("failed", js("failed", null))).toBe("failed_legacy");
    expect(reportViewFor("pending", js("idle", null))).toBe("not_analyzed");
    expect(reportViewFor("pending", null)).toBe("not_analyzed");
    expect(reportViewFor("processing", null)).toBe("stored_processing");
  });

  it("an acceptance is read strictly for this analysis", () => {
    const id = UUID();
    expect(acceptedAttempt({ status: "queued", analysisId: id, attempt: att("queued") }, id)).not.toBeNull();
    expect(acceptedAttempt({ status: "queued", analysisId: UUID(), attempt: att("queued") }, id)).toBeNull();
    expect(acceptedAttempt({ status: "complete", analysisId: id, attempt: att("complete") }, id)).toBeNull();
  });
});

describe("admission answers", () => {
  const att = { id: UUID(), generation: 1, state: "queued", acceptedAt: "2026-11-27T04:00:00Z" };

  it("every disposition except complete and sync_mode has an HTTP answer; acceptances are 202", () => {
    for (const d of ADMISSION_DISPOSITIONS) {
      if (d === "complete" || d === "sync_mode") continue;
      expect(ADMISSION_HTTP[d], d).toBeDefined();
    }
    expect(ADMISSION_HTTP.created.http).toBe(202);
    expect(ADMISSION_HTTP.replayed.http).toBe(202);
    expect([ADMISSION_HTTP.admission_paused.http, ADMISSION_HTTP.limit_reached.http, ADMISSION_HTTP.not_found.http, ADMISSION_HTTP.client_update_required.http]).toEqual([503, 429, 404, 409]);
  });

  it("parseAdmission is strict: unknown dispositions, malformed attempts and acceptances without an attempt are unavailable", () => {
    expect(parseAdmission({ disposition: "created", attempt: att })).toMatchObject({ outcome: "decided", disposition: "created" });
    expect(parseAdmission({ disposition: "sync_mode" })).toEqual({ outcome: "decided", disposition: "sync_mode", attempt: null, current: null });
    for (const bad of [{ disposition: "maybe" }, { disposition: "created" }, { disposition: "replayed", attempt: { id: 1 } }, null, "created", []]) {
      expect(parseAdmission(bad)).toEqual({ outcome: "unavailable" });
    }
  });

  it("202 carries the attempt, the status and report locations and no-store; refusals carry fixed copy", () => {
    const id = UUID();
    const ok = admissionResponseBody("created", id, att as never, "unusable");
    expect(ok).toEqual({
      http: 202,
      headers: { "Cache-Control": "no-store", Location: `/api/v1/analyses/${id}` },
      body: { status: "queued", analysisId: id, attempt: att, statusUrl: `/api/v1/analyses/${id}`, reportUrl: `/analyze/${id}`, replayed: false },
    });
    expect(admissionResponseBody("replayed", id, att as never, "unusable").body.replayed).toBe(true);
    expect(admissionResponseBody("video_not_ready", id, null, "VIDEO COPY")).toMatchObject({ http: 422, body: { status: "video_unusable", error: "VIDEO COPY" } });
    expect(admissionResponseBody("limit_reached", id, null, "").body).toEqual({ status: "limit_reached", error: ADMISSION_HTTP.limit_reached.error });
    expect(JSON.stringify(admissionResponseBody("failed_observed", id, att as never, "").body)).not.toMatch(/claim|worker|provider/i);
  });

  it("a retry reference is a UUID, the legacy sentinel or absent; anything else is refused", () => {
    expect(readRetryOfAttemptId(undefined)).toEqual({ ok: true, value: null });
    expect(readRetryOfAttemptId(null)).toEqual({ ok: true, value: null });
    expect(readRetryOfAttemptId("legacy")).toEqual({ ok: true, value: "legacy" });
    const id = UUID();
    expect(readRetryOfAttemptId(id)).toEqual({ ok: true, value: id });
    for (const bad of ["", "x", 5, {}, `${id} `]) expect(readRetryOfAttemptId(bad)).toEqual({ ok: false });
  });
});

describe("worker core over a fake RPC transport (C1)", () => {
  const job = () => ({ jobId: UUID(), analysisId: UUID(), userId: UUID(), videoId: UUID(), generation: 1, claimId: UUID(), recovered: false, storagePath: "u/v/x.mp4", clientMetrics: null });
  function fakeRpc(j: ReturnType<typeof job>, answers: Partial<Record<WorkerFunction, () => { ok: true; data: unknown } | { ok: false }>>) {
    const calls: WorkerFunction[] = [];
    const rpc: WorkerRpc = {
      async call(fn) {
        calls.push(fn);
        const a = answers[fn];
        if (a) return a();
        if (fn === "acquire_analysis_job") return { ok: true, data: j };
        return { ok: false };
      },
    };
    return { rpc, calls };
  }
  const video = { load: async () => ({ status: "ok" as const, bytes: new ArrayBuffer(8), mimeType: "video/mp4" }) };
  const noBeat = { every: () => () => undefined };
  const dispatched = (j: ReturnType<typeof job>, extra: Record<string, unknown> = {}) => ({ ok: true as const, data: { reason: "dispatched", jobId: j.jobId, claimId: j.claimId, generation: j.generation, ...extra } });

  it("acquire answers are read strictly", () => {
    const j = job();
    expect(parseAcquiredJob(j)).toMatchObject({ jobId: j.jobId });
    expect(parseAcquiredJob({ ...j, claimId: "x" })).toBeNull();
    expect(parseAcquiredJob({ ...j, generation: 0 })).toBeNull();
    expect(parseAcquiredJob(null)).toBeNull();
  });

  it("only `dispatched` for this job, claim and generation permits the call", () => {
    const j = job();
    expect(readDispatchPermission(dispatched(j).data, j)).toEqual({ kind: "decided", reason: "dispatched", permitted: true });
    for (const data of [dispatched(j, { generation: 2 }).data, dispatched(j, { claimId: UUID() }).data, dispatched(j, { jobId: UUID() }).data, { reason: "dispatched" }, "dispatched", null]) {
      expect(readDispatchPermission(data, j)).toEqual({ kind: "uncertain" });
    }
    expect(readDispatchPermission({ reason: "policy_hold", jobId: j.jobId, claimId: j.claimId }, j)).toEqual({ kind: "decided", reason: "policy_hold", permitted: false });
  });

  it.each([
    ["policy_hold", "requeue_undispatched_job", { kind: "requeued", policy: true }],
    ["ineligible", "cancel_ineligible_job", { kind: "cancelled_ineligible" }],
    ["fenced", null, { kind: "fenced", step: "mark" }],
  ] as const)("a %s answer gives zero adapter calls and only its own follow-up", async (reason, follow, tick) => {
    const j = job();
    const { rpc, calls } = fakeRpc(j, {
      mark_job_dispatched: () => ({ ok: true, data: { reason, jobId: j.jobId, claimId: j.claimId, generation: 1 } }),
      requeue_undispatched_job: () => ({ ok: true, data: "requeued" }),
      cancel_ineligible_job: () => ({ ok: true, data: true }),
    });
    const adapter = createSyntheticFullSwingAdapter();
    expect(await runWorkerOnce({ workerId: "u", rpc, adapter, video, scheduler: noBeat })).toMatchObject(tick);
    expect(adapter.calls()).toBe(0);
    expect(calls).toEqual(["acquire_analysis_job", "mark_job_dispatched", ...(follow ? [follow] : [])]);
  });

  it("a missing or lost acknowledgement gives zero adapter calls and no further write", async () => {
    for (const mark of [() => ({ ok: false as const }), () => ({ ok: true as const, data: { reason: "dispatched" } })]) {
      const j = job();
      const { rpc, calls } = fakeRpc(j, { mark_job_dispatched: mark });
      const adapter = createSyntheticFullSwingAdapter();
      expect(await runWorkerOnce({ workerId: "u", rpc, adapter, video, scheduler: noBeat })).toEqual({ kind: "dispatch_uncertain", jobId: j.jobId });
      expect(adapter.calls()).toBe(0);
      expect(calls).toEqual(["acquire_analysis_job", "mark_job_dispatched"]);
    }
  });

  it("a refused result fails as save_failed; a lost completion answer reports the outcome unknown", async () => {
    const j = job();
    let r = fakeRpc(j, { mark_job_dispatched: () => dispatched(j), complete_analysis_job: () => ({ ok: true, data: "result_refused" }), fail_analysis_job: () => ({ ok: true, data: "failed" }) });
    expect(await runWorkerOnce({ workerId: "u", rpc: r.rpc, adapter: createSyntheticFullSwingAdapter(), video, scheduler: noBeat }))
      .toEqual({ kind: "failed", jobId: j.jobId, failure: "save_failed", outcome: "failed" });
    r = fakeRpc(j, { mark_job_dispatched: () => dispatched(j), complete_analysis_job: () => ({ ok: false }), mark_job_outcome_unknown: () => ({ ok: true, data: "held" }) });
    expect(await runWorkerOnce({ workerId: "u", rpc: r.rpc, adapter: createSyntheticFullSwingAdapter(), video, scheduler: noBeat }))
      .toEqual({ kind: "outcome_unknown", jobId: j.jobId, outcome: "held" });
    expect(r.calls.slice(-2)).toEqual(["complete_analysis_job", "mark_job_outcome_unknown"]);
  });

  it("a refused heartbeat aborts the provider call and nothing is written afterwards", async () => {
    const j = job();
    let tick: () => void = () => undefined;
    const scheduler = { every: (_ms: number, t: () => void) => { tick = t; return () => undefined; } };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { rpc, calls } = fakeRpc(j, { mark_job_dispatched: () => dispatched(j), heartbeat_analysis_job: () => ({ ok: true, data: false }) });
    const adapter = createSyntheticFullSwingAdapter({ gate: () => gate });
    const run = runWorkerOnce({ workerId: "u", rpc, adapter, video, scheduler });
    await new Promise((r) => setTimeout(r, 10));
    tick();
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await run).toEqual({ kind: "fenced", jobId: j.jobId, step: "heartbeat" });
    expect(calls).toEqual(["acquire_analysis_job", "mark_job_dispatched", "heartbeat_analysis_job"]);
  });

  it("a worker told to stop before acquiring does nothing", async () => {
    const { rpc, calls } = fakeRpc(job(), {});
    expect(await runWorkerOnce({ workerId: "u", rpc, adapter: createSyntheticFullSwingAdapter(), video, shouldStop: () => true })).toEqual({ kind: "stopped" });
    expect(calls).toEqual([]);
  });
});


// ── AG-WEB-READY-10-P2-A1: unreadable status, attempt identity in answers, accurate interrupted copy ────────────────

describe("A1: a status read that fails is 'unavailable', never 'no work'", () => {
  const id = UUID();
  const state = { analysisId: id, execution: "idle", attempt: null };
  const client = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({ rpc: vi.fn(answer) }) as never;

  it("the single reader: an error, a throw, no answer, a malformed answer or another analysis's answer are unavailable; a state is a state", async () => {
    expect(await readGolferJobState(client(async () => ({ data: null, error: { message: "x" } })), id)).toBe("unavailable");
    expect(await readGolferJobState(client(async () => { throw new TypeError("Failed to fetch"); }), id)).toBe("unavailable");
    expect(await readGolferJobState(client(async () => ({ data: null, error: null })), id)).toBe("unavailable");
    expect(await readGolferJobState(client(async () => ({ data: { analysisId: id, execution: "nope" }, error: null })), id)).toBe("unavailable");
    expect(await readGolferJobState(client(async () => ({ data: { ...state, analysisId: UUID() }, error: null })), id)).toBe("unavailable");
    expect(await readGolferJobState(client(async () => ({ data: state, error: null })), id)).toEqual(state);
  });

  it("the bulk reader reads in batches of 50; a failed batch, or an analysis a successful read did not answer, is unavailable", async () => {
    const ids = Array.from({ length: 60 }, () => UUID());
    const calls: string[][] = [];
    const reader = { rpc: vi.fn(async (_fn: string, args: { p_ids: string[] }) => {
      calls.push(args.p_ids);
      if (calls.length === 2) return { data: null, error: { message: "x" } };
      return { data: args.p_ids.slice(1).map((x) => ({ analysisId: x, execution: "queued", attempt: null })), error: null };
    }) } as never;
    const read = await readGolferJobStates(reader, ids);
    expect(calls.map((c) => c.length)).toEqual([50, 10]);
    expect(read.get(ids[0])).toBe("unavailable"); // not answered by a successful read
    expect(read.get(ids[1])).toMatchObject({ execution: "queued" });
    expect(read.get(ids[49])).toMatchObject({ execution: "queued" });
    expect(read.get(ids[55])).toBe("unavailable"); // its batch failed
    expect(read.get(ids[1].toUpperCase())).toMatchObject({ execution: "queued" });
    expect((await readGolferJobStates(reader, [])).get(UUID())).toBe("unavailable");
  });

  it("labels and the report view: unavailable is its own state; a stored completed analysis stays complete", () => {
    expect(golferStatusLabel("pending", "unavailable")).toEqual({ label: "Status unavailable", tone: "attention" });
    expect(golferStatusLabel("failed", "unavailable").label).toBe("Status unavailable");
    expect(golferStatusLabel("processing", "unavailable").label).toBe("Status unavailable");
    expect(golferStatusLabel("complete", "unavailable")).toEqual({ label: "Complete", tone: "complete" });
    expect(golferStatusLabel("pending", { analysisId: id, execution: "idle", attempt: null }).label).toBe("Not analyzed yet");
    expect(reportViewFor("pending", "unavailable")).toBe("status_unavailable");
    expect(reportViewFor("failed", "unavailable")).toBe("status_unavailable");
    expect(reportViewFor("complete", "unavailable")).toBe("complete");
    expect(reportViewFor("pending", { analysisId: id, execution: "idle", attempt: null })).toBe("not_analyzed");
  });

  it("the V1 read reports execution 'unavailable' (attempt null) for an unreadable status, and omits the fields only without a read", async () => {
    const { toAnalysisResultV1 } = await import("@/lib/api/v1-analysis-result-dto");
    const view = {
      id, swing_video_id: id, status: "pending", analysis_family: "full_swing", created_at: "2026-11-27T00:00:00Z",
      equipment_snapshot: null, score: null, feedback: null, metrics: null, full_swing_metrics: null,
      swing_highlights: [], mechanical_deficiencies: [], putting_analysis: null, putting_score: null,
    } as never;
    expect(toAnalysisResultV1(view, { puttingAnalysis: false }, "unavailable")).toMatchObject({ execution: "unavailable", attempt: null });
    expect(toAnalysisResultV1(view, { puttingAnalysis: false }, { analysisId: id, execution: "idle", attempt: null })).toMatchObject({ execution: "idle", attempt: null });
    const none = toAnalysisResultV1(view, { puttingAnalysis: false }, null);
    expect("execution" in none).toBe(false);
  });
});

describe("A1: admission answers name the request's own attempt and, separately, the current one", () => {
  const own = { id: UUID(), generation: 1, state: "failed", acceptedAt: "2026-11-27T04:00:00.000Z", failureKind: "not_finished" };
  const current = { id: UUID(), generation: 2, state: "processing", acceptedAt: "2026-11-27T04:01:00.000Z" };

  it("parseAdmission reads `current` strictly: only with an own attempt, only another attempt, only well formed", () => {
    expect(parseAdmission({ disposition: "replayed", attempt: own, current })).toEqual({ outcome: "decided", disposition: "replayed", attempt: own, current });
    expect(parseAdmission({ disposition: "replayed", attempt: current })).toEqual({ outcome: "decided", disposition: "replayed", attempt: current, current: null });
    for (const bad of [
      { disposition: "replayed", attempt: own, current: own },
      { disposition: "stalled", current },
      { disposition: "replayed", attempt: own, current: { id: "x" } },
    ]) {
      expect(parseAdmission(bad), JSON.stringify(bad)).toEqual({ outcome: "unavailable" });
    }
  });

  it("202 carries the own attempt, the current one and the current status; 409 bodies carry both; a stalled attempt is described accurately", () => {
    const id = UUID();
    const ok = admissionResponseBody("replayed", id, own as never, "unusable", current as never);
    expect(ok.http).toBe(202);
    expect(ok.body).toMatchObject({ status: "processing", analysisId: id, attempt: own, current, replayed: true });
    expect(admissionResponseBody("replayed", id, current as never, "unusable").body).toMatchObject({ status: "processing", attempt: current });
    expect("current" in admissionResponseBody("created", id, { ...current, state: "queued" } as never, "unusable").body).toBe(false);
    const failed = admissionResponseBody("failed_observed", id, own as never, "unusable", { ...current, state: "failed" } as never);
    expect(failed).toMatchObject({ http: 409, body: { status: "failed", attempt: own, current: { id: current.id } } });
    const stalledJob = admissionResponseBody("stalled", id, { ...own, state: "interrupted" } as never, "unusable");
    expect(stalledJob.body.error).toBe(INTERRUPTED_UNRESOLVED_COPY);
    expect(stalledJob.body.error).not.toMatch(/can't be finished|record the swing again/i);
    expect(admissionResponseBody("stalled", id, null, "unusable").body.error).toBe(STALLED_COPY); // a synchronous stall
    // review: a stall described by a finished attempt is the synchronous one (only an interrupted attempt may still settle)
    expect(admissionResponseBody("stalled", id, own as never, "unusable").body.error).toBe(STALLED_COPY);
  });

  it("describedAttempt: `current` when present, else the own attempt; a malformed `current` is nothing", () => {
    expect(describedAttempt({ attempt: own, current })).toEqual(current);
    expect(describedAttempt({ attempt: own })).toEqual(own);
    expect(describedAttempt({ attempt: own, current: { id: 1 } })).toBeNull();
    expect(describedAttempt(null)).toBeNull();
    expect(executionOfAttempt({ ...own, state: "interrupted" } as never)).toBe("interrupted");
  });
});
