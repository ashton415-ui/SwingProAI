/**
 * SwingProAI — one precedence rule for durable analysis attempts (AG-WEB-READY-10-P2).
 *
 * Shared by the analyze route (dispositions to HTTP), every status surface (the saved report, /swings/<id>, the
 * dashboard chips and Telemetry) and the tests. The database computes the same rule
 * (supabase/migrations/20261127120000_analysis_jobs.sql: admit_analysis_job and analysis_jobs_view); this module
 * never decides on its own what a stored row means, it names the golfer-facing outcome of what the database said.
 *
 * Display precedence on every surface: a completed analysis, then an open attempt, then the latest finished
 * attempt, then an analysis that never had an attempt.
 *
 * Client-safe: no server import (one type-only import).
 */

import type { AuthenticatedCaller } from "@/utils/supabase/server";

/** The request header a client sends to declare that it understands a 202 acceptance (not a security control). */
export const ADMISSION_DECLARATION_HEADER = "X-SwingProAI-Admission";
export const ADMISSION_DECLARATION_VALUE = "1";

/** The request body field naming the failed attempt a Retry refers to. */
export const RETRY_OF_ATTEMPT_FIELD = "retryOfAttemptId";

export const DISPLAY_PRECEDENCE = ["complete", "open_attempt", "finished_attempt", "no_attempt"] as const;

export const GOLFER_EXECUTIONS = ["idle", "queued", "processing", "complete", "failed", "interrupted", "paused"] as const;
export type GolferExecution = (typeof GOLFER_EXECUTIONS)[number];

export const ATTEMPT_STATES = ["queued", "processing", "complete", "failed", "interrupted"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** The only failure kinds a golfer (or any API caller) ever sees; internal kinds map to not_finished in SQL. */
export const GOLFER_FAILURE_KINDS = ["video_unusable", "not_finished"] as const;
export type GolferFailureKind = (typeof GOLFER_FAILURE_KINDS)[number];

export interface GolferAttempt {
  readonly id: string;
  readonly generation: number;
  readonly state: AttemptState;
  readonly acceptedAt: string;
  readonly dispatchedAt?: string;
  readonly finishedAt?: string;
  readonly failureKind?: GolferFailureKind;
}

export interface GolferJobState {
  readonly analysisId: string;
  readonly execution: GolferExecution;
  readonly attempt: GolferAttempt | null;
}

/**
 * A1: what a status read returned: the analysis's state (an `idle` execution is a confirmed absence of work), or
 * "unavailable" when the read failed, was refused or answered something unreadable — never treated as "no work".
 */
export type JobStateRead = GolferJobState | "unavailable";

/**
 * The admission decisions admit_analysis_job can answer, as a set (the migration header lists the precedence and the
 * conditions). `created` and `replayed` are the acceptances; `sync_mode` means "no job, run the existing
 * synchronous path".
 */
export const ADMISSION_DISPOSITIONS = [
  "admission_paused",
  "not_found",
  "complete",
  "video_not_ready",
  "family_not_queued",
  "unsupported",
  "sync_mode",
  "client_update_required",
  "replayed",
  "stalled",
  "in_progress",
  "created",
  "failed_observed",
  "superseded",
  "not_startable",
  "limit_reached",
] as const;
export type AdmissionDisposition = (typeof ADMISSION_DISPOSITIONS)[number];

// ── Golfer copy (one place for the route and the pages) ──────────────────────

/**
 * Synthetic results (slice 1: the local test adapter, lib/analysis-provider-adapter.ts). Every synthetic text starts
 * with SYNTHETIC_RESULT_LABEL; a report built from one is shown with SYNTHETIC_RESULT_NOTICE and never with copy that
 * describes a video. No real provider writes these labels.
 */
export const SYNTHETIC_RESULT_LABEL = "SYNTHETIC TEST RESULT";
export const SYNTHETIC_RESULT_NOTICE = "Synthetic test result — produced by the local test adapter, not an AI analysis of your swing.";
export const SYNTHETIC_UNSCORED_COPY = "No swing was analysed for this test result, so there is no score.";
export function isSyntheticResult(feedback: unknown): boolean {
  return typeof feedback === "string" && feedback.startsWith(SYNTHETIC_RESULT_LABEL);
}

export const IN_PROGRESS_COPY = "This analysis is already in progress. Please check back shortly.";
export const STALLED_COPY =
  "This analysis was interrupted after it started and can't be finished. Please record the swing again for a new analysis.";
export const NOT_STARTABLE_COPY = "This analysis can't be started right now. Please refresh and try again.";
export const FAILED_OBSERVED_COPY = "This analysis didn't finish. You can retry it.";
export const FAILED_NO_RETRY_COPY = "This analysis didn't finish. Record the swing again for a new analysis.";
export const SUPERSEDED_COPY = "This retry refers to an earlier attempt. Refresh to see the latest status.";
export const ADMISSION_PAUSED_COPY = "New analyses are paused right now. Your swing is saved — check back later.";
export const LIMIT_REACHED_COPY = "You've reached the analysis limit for now. Your swing is saved.";
export const CLIENT_UPDATE_COPY = "SwingProAI was updated. Refresh this page, then analyze again.";
export const NOT_FOUND_COPY = "Analysis record not found.";
export const QUEUED_HEADING = "Queued";
export const QUEUED_COPY = "Your swing is saved and queued for analysis. You can close this tab and come back to this report at any time.";
export const ANALYZING_HEADING = "Analyzing";
export const ANALYZING_COPY =
  "Your swing is being analyzed. You can close this tab. Check status to read the latest saved result.";
/**
 * A1: an attempt whose dispatch is unresolved (it started, then stopped reporting, and its outcome is not known yet).
 * A late result can still be saved (a classified holder's late report settles it) or the attempt can be reconciled, so
 * the golfer is told neither that it can't finish nor to record again: only that the outcome is not confirmed yet.
 */
export const INTERRUPTED_HEADING = "Result not confirmed yet";
export const INTERRUPTED_UNRESOLVED_COPY =
  "This analysis started but stopped reporting, so its outcome isn't confirmed yet. Check status later to see whether a result was saved.";
/**
 * A1: the status could not be read (a failed or unreadable status read). This is not "no analysis": the swing may be
 * queued or running, so no Analyze action is offered — only a fresh read.
 */
export const STATUS_UNAVAILABLE = "unavailable" as const;
export const STATUS_UNAVAILABLE_LABEL = "Status unavailable";
export const STATUS_UNAVAILABLE_HEADING = "Status unavailable";
export const STATUS_UNAVAILABLE_COPY =
  "We couldn't read this analysis's status just now. Your swing is saved. Check status to read it again.";

/** The answer for each disposition other than `complete` and `sync_mode` (which the route answers itself). */
export const ADMISSION_HTTP: Readonly<Record<Exclude<AdmissionDisposition, "complete" | "sync_mode">, { readonly http: number; readonly status: string; readonly error?: string }>> = {
  created: { http: 202, status: "queued" },
  replayed: { http: 202, status: "queued" },
  in_progress: { http: 409, status: "processing", error: IN_PROGRESS_COPY },
  stalled: { http: 409, status: "stalled", error: STALLED_COPY },
  failed_observed: { http: 409, status: "failed", error: FAILED_OBSERVED_COPY },
  superseded: { http: 409, status: "superseded", error: SUPERSEDED_COPY },
  admission_paused: { http: 503, status: "admission_paused", error: ADMISSION_PAUSED_COPY },
  limit_reached: { http: 429, status: "limit_reached", error: LIMIT_REACHED_COPY },
  video_not_ready: { http: 422, status: "video_unusable" },
  not_found: { http: 404, status: "not_found", error: NOT_FOUND_COPY },
  client_update_required: { http: 409, status: "client_update_required", error: CLIENT_UPDATE_COPY },
  not_startable: { http: 409, status: "not_startable", error: NOT_STARTABLE_COPY },
  family_not_queued: { http: 500, status: "unsupported" },
  unsupported: { http: 500, status: "unsupported" },
};

// ── Parsing what the database (or the route) returned ────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** A golfer-facing attempt exactly as the database maps it, or null for anything else. */
export function parseGolferAttempt(raw: unknown): GolferAttempt | null {
  if (!isRecord(raw)) return null;
  const { id, generation, state, acceptedAt, dispatchedAt, finishedAt, failureKind } = raw;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return null;
  if (!oneOf(ATTEMPT_STATES, state) || !isText(acceptedAt)) return null;
  if (dispatchedAt !== undefined && !isText(dispatchedAt)) return null;
  if (finishedAt !== undefined && !isText(finishedAt)) return null;
  if (failureKind !== undefined && !oneOf(GOLFER_FAILURE_KINDS, failureKind)) return null;
  return {
    id,
    generation,
    state,
    acceptedAt,
    ...(dispatchedAt !== undefined ? { dispatchedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(failureKind !== undefined ? { failureKind } : {}),
  };
}

/** read_analysis_job_state's answer, or null when it is absent or not of that shape. */
export function parseGolferJobState(raw: unknown): GolferJobState | null {
  if (!isRecord(raw)) return null;
  const { analysisId, execution, attempt } = raw;
  if (typeof analysisId !== "string" || !UUID.test(analysisId) || !oneOf(GOLFER_EXECUTIONS, execution)) return null;
  const parsed = attempt === null || attempt === undefined ? null : parseGolferAttempt(attempt);
  if (attempt !== null && attempt !== undefined && parsed === null) return null;
  return { analysisId, execution, attempt: parsed };
}

/** read_analysis_job_states's answer keyed by analysis id; malformed entries are left out. */
export function parseGolferJobStates(raw: unknown): Map<string, GolferJobState> {
  const out = new Map<string, GolferJobState>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const parsed = parseGolferJobState(entry);
    if (parsed) out.set(parsed.analysisId.toLowerCase(), parsed);
  }
  return out;
}

// ── What each surface shows ───────────────────────────────────────────────────

/**
 * The status label for list surfaces (dashboard chips, Telemetry, /swings/<id>). With a job state, the database's
 * golfer-facing execution decides. Without one (the read failed, or an older row), the stored status is shown, with
 * "Not analyzed yet" for pending (never "queued": queued is shown only after an accepted admission).
 */
export type StatusTone = "complete" | "active" | "attention" | "failed" | "neutral";
export function golferStatusLabel(analysisStatus: string | null | undefined, job: JobStateRead | null): { readonly label: string; readonly tone: StatusTone } {
  // A1: an unreadable status is never shown as "Not analyzed yet" (or as any stored status that an attempt may have
  // moved on from). A stored completed analysis stays Complete: its report is valid whatever the read did.
  if (job === STATUS_UNAVAILABLE) {
    return analysisStatus === "complete" ? { label: "Complete", tone: "complete" } : { label: STATUS_UNAVAILABLE_LABEL, tone: "attention" };
  }
  if (job) {
    switch (job.execution) {
      case "complete": return { label: "Complete", tone: "complete" };
      case "queued": return { label: "Queued", tone: "active" };
      case "processing": return { label: "Analyzing", tone: "active" };
      case "interrupted": return { label: "Interrupted", tone: "attention" };
      case "failed": return { label: "Failed", tone: "failed" };
      case "paused": return { label: "Paused", tone: "neutral" };
      case "idle": return { label: "Not analyzed yet", tone: "neutral" };
    }
  }
  switch (analysisStatus ?? "pending") {
    case "complete": return { label: "Complete", tone: "complete" };
    case "processing": return { label: "Processing", tone: "active" };
    case "failed": return { label: "Failed", tone: "failed" };
    case "pending": return { label: "Not analyzed yet", tone: "neutral" };
    default: return { label: String(analysisStatus), tone: "neutral" };
  }
}

/** The saved report's main panel. */
export type ReportView =
  | "complete"
  | "queued"
  | "processing"
  | "interrupted"
  | "failed_attempt"
  | "failed_unusable"
  | "failed_legacy"
  | "not_analyzed"
  | "paused"
  | "stored_processing"
  | "status_unavailable"
  | "other";

export function reportViewFor(analysisStatus: string, job: JobStateRead | null): ReportView {
  if (job === STATUS_UNAVAILABLE) return analysisStatus === "complete" ? "complete" : "status_unavailable";
  if (analysisStatus === "complete" || job?.execution === "complete") return "complete";
  if (job) {
    switch (job.execution) {
      case "queued": return "queued";
      case "processing": return job.attempt ? "processing" : "stored_processing";
      case "interrupted": return "interrupted";
      case "failed":
        if (!job.attempt) return "failed_legacy";
        return job.attempt.failureKind === "video_unusable" ? "failed_unusable" : "failed_attempt";
      case "paused": return "paused";
      case "idle": return "not_analyzed";
    }
  }
  if (analysisStatus === "pending") return "not_analyzed";
  if (analysisStatus === "failed") return "failed_legacy";
  if (analysisStatus === "processing") return "stored_processing";
  return "other";
}

/** An acceptance (202) of POST /api/analyze-swing, read strictly: the attempt it names for this analysis, or null. */
export function acceptedAttempt(body: unknown, analysisId: string): GolferAttempt | null {
  if (!isRecord(body) || body.analysisId !== analysisId || (body.status !== "queued" && body.status !== "processing")) return null;
  return parseGolferAttempt(body.attempt);
}

/**
 * A1: the attempt an admission answer DESCRIBES. `attempt` is always the request's own (a delayed repeat of the first
 * press names attempt 1); when the analysis has moved on to another attempt, the answer also carries it as `current`.
 * A malformed `current` is refused (null), never replaced by the request's own attempt.
 */
export function describedAttempt(body: unknown): GolferAttempt | null {
  if (!isRecord(body)) return null;
  if (body.current !== undefined && body.current !== null) return parseGolferAttempt(body.current);
  return parseGolferAttempt(body.attempt);
}

/** A1: the golfer-facing execution an open or failed attempt shows as (an answer's described attempt). */
export function executionOfAttempt(attempt: GolferAttempt): GolferExecution {
  switch (attempt.state) {
    case "queued": return "queued";
    case "processing": return "processing";
    case "interrupted": return "interrupted";
    case "complete": return "complete";
    case "failed": return "failed";
  }
}

// ── Reading the durable attempt state (golfer-facing, owner-bound) ──────────

/**
 * The analysis's golfer-facing execution and attempt, read with read_analysis_job_state ON THE CALLER'S OWN SESSION:
 * the database takes the owner from the request's verified JWT subject, never from a parameter, and maps every
 * internal state and failure kind to the golfer-facing values (lib/analysis-attempt-precedence.ts). Never an analysis
 * request.
 *
 * A1: "unavailable" when the read fails, throws, or answers anything but a state for this analysis (including no
 * answer at all: the callers read only analyses the golfer's own session has just returned, for which the database
 * always answers a state). A confirmed absence of work is a state with execution `idle`, never a failed read.
 */
export async function readGolferJobState(
  client: Pick<AuthenticatedCaller["client"], "rpc">,
  analysisId: string,
): Promise<JobStateRead> {
  try {
    const { data, error } = await client.rpc("read_analysis_job_state", { p_analysis: analysisId });
    if (error) return STATUS_UNAVAILABLE;
    const state = parseGolferJobState(data);
    return state !== null && state.analysisId.toLowerCase() === analysisId.toLowerCase() ? state : STATUS_UNAVAILABLE;
  } catch {
    return STATUS_UNAVAILABLE;
  }
}

/** The database's bound on one bulk read (read_analysis_job_states answers nothing above it). */
export const JOB_STATES_PER_READ = 50;

/** A1: the bulk answer: each listed analysis's state, or "unavailable" for one the read could not answer. */
export interface JobStatesRead {
  readonly get: (analysisId: string) => JobStateRead;
}

/**
 * The same for list surfaces (dashboard, Telemetry), in reads of at most JOB_STATES_PER_READ. A1: an analysis whose
 * read failed, or that a successful read did not answer, is "unavailable" (never "no work"); one failed read leaves
 * only its own analyses unavailable.
 */
export async function readGolferJobStates(
  client: Pick<AuthenticatedCaller["client"], "rpc">,
  analysisIds: readonly string[],
): Promise<JobStatesRead> {
  const answered = new Map<string, GolferJobState>();
  const ids = Array.from(new Set(analysisIds.map((id) => String(id).toLowerCase())));
  for (let i = 0; i < ids.length; i += JOB_STATES_PER_READ) {
    const batch = ids.slice(i, i + JOB_STATES_PER_READ);
    try {
      const { data, error } = await client.rpc("read_analysis_job_states", { p_ids: batch });
      if (error) continue;
      parseGolferJobStates(data).forEach((state, id) => {
        if (batch.includes(id)) answered.set(id, state);
      });
    } catch {
      // this batch stays unavailable
    }
  }
  return { get: (analysisId: string) => answered.get(String(analysisId).toLowerCase()) ?? STATUS_UNAVAILABLE };
}
