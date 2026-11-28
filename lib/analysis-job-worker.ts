import "server-only";
import { validateFullSwingModelResponse, toStoredFullSwingResult } from "@/lib/full-swing-analysis-contract";
import { sanitizeClientMetrics, type ClientMetrics } from "@/lib/analysis-metrics-validation";
import type { AnalysisProviderAdapter } from "@/lib/analysis-provider-adapter";

/**
 * SwingProAI — the background analysis worker core (AG-WEB-READY-10-P2; ADR 10-P1 §7).
 *
 * One `runWorkerOnce` call works at most one job:
 *
 *   1. acquire_analysis_job (the database locks the job and the analysis and takes the ENT-1D claim);
 *   2. resolve the video through the injected source (canonical, owner-bound; the queue carries no media, URL or
 *      key): unusable -> fail(video_unusable); transient -> requeue with backoff;
 *   3. re-validate the stored client estimates with the shared validators;
 *   4. mark_job_dispatched. C1: the adapter is called ONLY when the typed answer is `dispatched` for exactly this
 *      job, claim and generation. policy_hold -> policy requeue; ineligible -> cancel_ineligible_job; fenced -> stop
 *      without writing; an error, a lost or malformed answer -> no call and no further write: the dispatch is
 *      uncertain and stays held for the classifier and reconciliation;
 *   5. heartbeat while the adapter runs; a refused heartbeat means fenced out: the adapter is aborted and nothing is
 *      written afterwards;
 *   6. settle: a valid result -> complete (a result the database bound refuses -> fail(save_failed)); a definite
 *      rejection -> fail(provider_rejected); an unusable answer -> fail(response_unusable); no definite answer ->
 *      mark_job_outcome_unknown.
 *
 * The RPC transport is injected (ADR §11 item 3): how the analysis_worker role is reached is an owner decision
 * (§13.2), and no database driver is added in slice 1. Tests and the local demonstration use `SET ROLE
 * analysis_worker` on the disposable stack. Exactly-once provider execution is not claimed; at most one dispatch mark
 * per job is.
 */

export type WorkerFunction =
  | "acquire_analysis_job"
  | "mark_job_dispatched"
  | "heartbeat_analysis_job"
  | "requeue_undispatched_job"
  | "complete_analysis_job"
  | "fail_analysis_job"
  | "mark_job_outcome_unknown"
  | "cancel_ineligible_job"
  | "classify_stalled_jobs";

export interface WorkerRpc {
  call(fn: WorkerFunction, args: Readonly<Record<string, unknown>>): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false }>;
}

export interface AcquiredJob {
  readonly jobId: string;
  readonly analysisId: string;
  readonly userId: string;
  readonly videoId: string;
  readonly generation: number;
  readonly claimId: string;
  readonly recovered: boolean;
  readonly storagePath: string;
  readonly clientMetrics: unknown;
}

export type VideoLoad =
  | { readonly status: "ok"; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | { readonly status: "unusable" }
  | { readonly status: "transient" };

export interface WorkerVideoSource {
  load(job: AcquiredJob): Promise<VideoLoad>;
}

export interface HeartbeatScheduler {
  every(ms: number, tick: () => void): () => void;
}

export const realScheduler: HeartbeatScheduler = {
  every(ms, tick) {
    const handle = setInterval(tick, ms);
    return () => clearInterval(handle);
  },
};

export interface WorkerOptions {
  readonly workerId: string;
  readonly rpc: WorkerRpc;
  readonly adapter: AnalysisProviderAdapter;
  readonly video: WorkerVideoSource;
  readonly heartbeatMs?: number;
  readonly scheduler?: HeartbeatScheduler;
  /** SIGTERM: stop acquiring; never call the provider after it is set. */
  readonly shouldStop?: () => boolean;
}

export type WorkerTick =
  | { readonly kind: "idle" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unavailable"; readonly step: string; readonly jobId?: string }
  | { readonly kind: "requeued"; readonly jobId: string; readonly policy: boolean; readonly outcome: string }
  | { readonly kind: "cancelled_ineligible"; readonly jobId: string }
  | { readonly kind: "fenced"; readonly jobId: string; readonly step: string }
  | { readonly kind: "dispatch_uncertain"; readonly jobId: string }
  | { readonly kind: "completed"; readonly jobId: string; readonly outcome: string }
  | { readonly kind: "failed"; readonly jobId: string; readonly failure: string; readonly outcome: string }
  | { readonly kind: "outcome_unknown"; readonly jobId: string; readonly outcome: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** acquire_analysis_job's answer, read strictly; null for "nothing" or any other shape. */
export function parseAcquiredJob(data: unknown): AcquiredJob | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  for (const key of ["jobId", "analysisId", "userId", "videoId", "claimId"] as const) {
    if (typeof r[key] !== "string" || !UUID.test(r[key] as string)) return null;
  }
  if (typeof r.generation !== "number" || !Number.isInteger(r.generation) || r.generation < 1) return null;
  if (typeof r.storagePath !== "string" || r.storagePath.length === 0) return null;
  return {
    jobId: r.jobId as string,
    analysisId: r.analysisId as string,
    userId: r.userId as string,
    videoId: r.videoId as string,
    generation: r.generation,
    claimId: r.claimId as string,
    recovered: r.recovered === true,
    storagePath: r.storagePath,
    clientMetrics: r.clientMetrics ?? null,
  };
}

export type DispatchReason = "dispatched" | "policy_hold" | "ineligible" | "fenced";

/**
 * C1. mark_job_dispatched's typed answer. `permitted` is true only for `dispatched` naming exactly this job, claim and
 * generation; any other shape is `uncertain` (the call may or may not have committed).
 */
export function readDispatchPermission(
  data: unknown,
  job: Pick<AcquiredJob, "jobId" | "claimId" | "generation">,
): { readonly kind: "decided"; readonly reason: DispatchReason; readonly permitted: boolean } | { readonly kind: "uncertain" } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "uncertain" };
  const r = data as Record<string, unknown>;
  const reason = r.reason;
  if (reason !== "dispatched" && reason !== "policy_hold" && reason !== "ineligible" && reason !== "fenced") return { kind: "uncertain" };
  if (r.jobId !== job.jobId || r.claimId !== job.claimId) return { kind: "uncertain" };
  if (reason === "dispatched") {
    if (r.generation !== job.generation) return { kind: "uncertain" };
    return { kind: "decided", reason, permitted: true };
  }
  return { kind: "decided", reason, permitted: false };
}

const asText = (r: { ok: true; data: unknown } | { ok: false }): string | null =>
  r.ok && typeof r.data === "string" ? r.data : null;

export async function runWorkerOnce(options: WorkerOptions): Promise<WorkerTick> {
  const { rpc, adapter } = options;
  const stop = options.shouldStop ?? (() => false);
  if (stop()) return { kind: "stopped" };

  const acquired = await rpc.call("acquire_analysis_job", { p_worker: options.workerId, p_adapter: adapter.providerMode });
  if (!acquired.ok) return { kind: "unavailable", step: "acquire" };
  if (acquired.data === null) return { kind: "idle" };
  const job = parseAcquiredJob(acquired.data);
  if (!job) return { kind: "unavailable", step: "acquire" };
  const fence = { p_job: job.jobId, p_claim: job.claimId };

  const requeue = async (policy: boolean): Promise<WorkerTick> => {
    const r = await rpc.call("requeue_undispatched_job", { ...fence, p_policy: policy });
    const outcome = asText(r);
    return outcome === null ? { kind: "unavailable", step: "requeue", jobId: job.jobId } : { kind: "requeued", jobId: job.jobId, policy, outcome };
  };
  const fail = async (kind: string): Promise<WorkerTick> => {
    const r = await rpc.call("fail_analysis_job", { ...fence, p_kind: kind });
    const outcome = asText(r);
    return outcome === null ? { kind: "unavailable", step: "fail", jobId: job.jobId } : { kind: "failed", jobId: job.jobId, failure: kind, outcome };
  };

  // 2. the video, resolved now from the canonical source
  let video: VideoLoad;
  try {
    video = await options.video.load(job);
  } catch {
    video = { status: "transient" };
  }
  if (video.status === "unusable") return fail("video_unusable");
  if (video.status === "transient") return requeue(false);

  // 3. the stored estimates, re-validated with the route's own validators
  const clientMetrics: ClientMetrics | null = sanitizeClientMetrics(job.clientMetrics);

  if (stop()) return requeue(true);

  // 4. C1: the typed permission to dispatch
  const marked = await rpc.call("mark_job_dispatched", { ...fence, p_adapter: adapter.providerMode });
  if (!marked.ok) return { kind: "dispatch_uncertain", jobId: job.jobId };
  const permission = readDispatchPermission(marked.data, job);
  if (permission.kind === "uncertain") return { kind: "dispatch_uncertain", jobId: job.jobId };
  if (!permission.permitted) {
    if (permission.reason === "policy_hold") return requeue(true);
    if (permission.reason === "ineligible") {
      const r = await rpc.call("cancel_ineligible_job", fence);
      return r.ok && r.data === true ? { kind: "cancelled_ineligible", jobId: job.jobId } : { kind: "fenced", jobId: job.jobId, step: "cancel" };
    }
    return { kind: "fenced", jobId: job.jobId, step: "mark" };
  }
  // SIGTERM after the mark: the provider is never called; the dispatch stays held for reconciliation.
  if (stop()) return { kind: "dispatch_uncertain", jobId: job.jobId };

  // 5. heartbeat while the provider runs
  const abort = new AbortController();
  let fencedOut = false;
  const scheduler = options.scheduler ?? realScheduler;
  const cancelHeartbeat = scheduler.every(options.heartbeatMs ?? 30_000, () => {
    void rpc.call("heartbeat_analysis_job", fence).then((r) => {
      if (r.ok && r.data === false) {
        fencedOut = true;
        abort.abort();
      }
    });
  });

  let outcome;
  try {
    outcome = await adapter.run({
      jobId: job.jobId,
      analysisId: job.analysisId,
      generation: job.generation,
      video: { bytes: video.bytes, mimeType: video.mimeType },
      clientMetrics,
      signal: abort.signal,
    });
  } catch {
    outcome = { kind: "unknown" as const };
  } finally {
    cancelHeartbeat();
  }
  if (fencedOut) return { kind: "fenced", jobId: job.jobId, step: "heartbeat" };

  // 6. settle
  if (outcome.kind === "rejected") return fail("provider_rejected");
  if (outcome.kind === "unusable") return fail("response_unusable");
  if (outcome.kind === "unknown") {
    const r = await rpc.call("mark_job_outcome_unknown", fence);
    const o = asText(r);
    return o === null ? { kind: "unavailable", step: "outcome_unknown", jobId: job.jobId } : { kind: "outcome_unknown", jobId: job.jobId, outcome: o };
  }
  const validated = validateFullSwingModelResponse(outcome.body);
  if (!validated.ok) return fail("response_unusable");
  const stored = toStoredFullSwingResult(validated.report, validated.assessment, {
    spineAngle: clientMetrics?.spineAngle ?? null,
    hipRotation: clientMetrics?.hipRotation ?? null,
    shoulderRotation: clientMetrics?.shoulderRotation ?? null,
    tempoRatio: clientMetrics?.tempoRatio ?? null,
  });
  let completed = await rpc.call("complete_analysis_job", { ...fence, p_result: stored });
  // A lost answer is retried once: a completion that did commit answers `fenced` the second time (the job is no longer
  // dispatched), so a retry can never write twice; one that did not commit lands now.
  if (asText(completed) === null) completed = await rpc.call("complete_analysis_job", { ...fence, p_result: stored });
  const result = asText(completed);
  if (result === null) {
    // The completion's answer was lost: it may have committed. Report the outcome as unknown; a committed
    // completion makes this a no-op (fenced), an uncommitted one is held for reconciliation.
    const r = await rpc.call("mark_job_outcome_unknown", fence);
    const o = asText(r);
    return o === null ? { kind: "unavailable", step: "complete", jobId: job.jobId } : { kind: "outcome_unknown", jobId: job.jobId, outcome: o };
  }
  if (result === "result_refused") return fail("save_failed");
  if (result === "completed" || result === "job_gone_settled") return { kind: "completed", jobId: job.jobId, outcome: result };
  return { kind: "fenced", jobId: job.jobId, step: "complete" };
}

/** The classifier step (ADR §5): dispatched jobs whose lease expired become outcome_unknown; the analysis is untouched. */
export async function classifyStalledJobs(rpc: WorkerRpc): Promise<number | null> {
  const r = await rpc.call("classify_stalled_jobs", {});
  return r.ok && typeof r.data === "number" ? r.data : null;
}
