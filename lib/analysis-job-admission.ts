import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  ADMISSION_DISPOSITIONS,
  ADMISSION_HTTP,
  INTERRUPTED_UNRESOLVED_COPY,
  parseGolferAttempt,
  type AdmissionDisposition,
  type GolferAttempt,
} from "@/lib/analysis-attempt-precedence";
import type { ClientMetrics } from "@/lib/analysis-metrics-validation";

/**
 * SwingProAI — durable full-swing admission (AG-WEB-READY-10-P2; ADR 10-P1 §5–§6).
 *
 * The analyze route calls admit_analysis_job for EVERY full-swing request, after it has authenticated the caller,
 * proved the row is theirs, routed the family and resolved the entitlement with the existing TypeScript authorities.
 * The database decides in one transaction, under row locks, what this request is: a new attempt (one durable job and
 * its spend reservation), a replay of the open attempt, a finished or refused one, or `sync_mode` (no job; the
 * existing synchronous path runs, which is today's behaviour while the stored mode is `sync`).
 *
 * The verified user id is passed by the route; the function is executable only by the service role, so a browser
 * cannot call it. An RPC error, a transport failure or an answer of any other shape is `unavailable`: the route then
 * answers 503 and never falls back to the synchronous path.
 */

export interface AdmissionRequest {
  readonly userId: string;
  readonly analysisId: string;
  /** Bearer authentication AND the declaration header: a client that understands 202. */
  readonly declared: boolean;
  /** The failed attempt a Retry names (the golfer saw it), or null. */
  readonly retryOfAttemptId: string | null;
  readonly clientMetrics: ClientMetrics | null;
}

export type AdmissionAnswer =
  | {
      readonly outcome: "decided";
      readonly disposition: AdmissionDisposition;
      /** A1: the attempt this request's own intent was accepted as (or, without one, the attempt described) */
      readonly attempt: GolferAttempt | null;
      /** A1: the attempt the disposition describes, when it is another one than `attempt`; otherwise null */
      readonly current: GolferAttempt | null;
    }
  | { readonly outcome: "unavailable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request body's retry reference, or a value the database will refuse (never silently dropped). */
export function readRetryOfAttemptId(value: unknown): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && (UUID.test(value) || value === "legacy")) return { ok: true, value };
  return { ok: false };
}

export async function admitAnalysisJob(request: AdmissionRequest): Promise<AdmissionAnswer> {
  try {
    const { data, error } = await createAdminClient().rpc("admit_analysis_job", {
      p_user: request.userId,
      p_analysis: request.analysisId,
      p_declared: request.declared,
      p_retry_of: request.retryOfAttemptId,
      p_client_metrics: request.clientMetrics,
    });
    if (error) return { outcome: "unavailable" };
    return parseAdmission(data);
  } catch {
    return { outcome: "unavailable" };
  }
}

/** The database's answer, read strictly. Exported for tests. */
export function parseAdmission(data: unknown): AdmissionAnswer {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { outcome: "unavailable" };
  const record = data as Record<string, unknown>;
  const disposition = record.disposition;
  if (typeof disposition !== "string" || !(ADMISSION_DISPOSITIONS as readonly string[]).includes(disposition)) {
    return { outcome: "unavailable" };
  }
  const attempt = record.attempt === undefined || record.attempt === null ? null : parseGolferAttempt(record.attempt);
  if (record.attempt !== undefined && record.attempt !== null && attempt === null) return { outcome: "unavailable" };
  if ((disposition === "created" || disposition === "replayed") && attempt === null) return { outcome: "unavailable" };
  // A1: `current` accompanies an own attempt only, and is always another attempt
  const current = record.current === undefined || record.current === null ? null : parseGolferAttempt(record.current);
  if (record.current !== undefined && record.current !== null && (current === null || attempt === null || current.id === attempt.id)) {
    return { outcome: "unavailable" };
  }
  return { outcome: "decided", disposition: disposition as AdmissionDisposition, attempt, current };
}

/**
 * The HTTP answer for a decided disposition other than `complete` and `sync_mode`, which the route answers from the
 * stored row or with the synchronous path. 202 carries the attempt, the status location and the report location.
 */
export function admissionResponseBody(
  disposition: Exclude<AdmissionDisposition, "complete" | "sync_mode">,
  analysisId: string,
  attempt: GolferAttempt | null,
  videoUnusableCopy: string,
  current: GolferAttempt | null = null,
): { readonly http: number; readonly body: Record<string, unknown>; readonly headers: Record<string, string> } {
  const answer = ADMISSION_HTTP[disposition];
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  // A1: `attempt` is the request's own attempt; `current`, when present, is the attempt the status describes
  const described = current ?? attempt;
  if (answer.http === 202 && attempt) {
    headers.Location = `/api/v1/analyses/${analysisId}`;
    return {
      http: 202,
      headers,
      body: {
        status: described?.state === "processing" ? "processing" : answer.status,
        analysisId,
        attempt,
        ...(current ? { current } : {}),
        statusUrl: `/api/v1/analyses/${analysisId}`,
        reportUrl: `/analyze/${analysisId}`,
        replayed: disposition === "replayed",
      },
    };
  }
  const error =
    disposition === "video_not_ready" ? videoUnusableCopy
    // A1: an attempt whose dispatch is unresolved may still finish; a synchronous stall (no interrupted attempt) cannot
    : disposition === "stalled" && described?.state === "interrupted" ? INTERRUPTED_UNRESOLVED_COPY
    : answer.error ?? "Analysis failed. Please try again.";
  // the same body as the route's existing 404 for a row that is not the caller's
  if (disposition === "not_found") return { http: answer.http, headers, body: { error } };
  return {
    http: answer.http,
    headers,
    body: { status: answer.status, error, ...(attempt ? { attempt } : {}), ...(current ? { current } : {}) },
  };
}
