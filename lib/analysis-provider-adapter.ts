/**
 * SwingProAI — analysis provider adapters for the background worker (AG-WEB-READY-10-P2; ADR 10-P1 §7, §11 item 4).
 *
 * An adapter makes at most one provider request per call and reports what happened in the worker's terms. It
 * declares the database `provider_mode` it serves; the worker refuses to dispatch unless the database's mode equals
 * it (acquire_analysis_job and mark_job_dispatched check the same value).
 *
 * Slice 1 ships ONLY the synthetic adapter: deterministic, no network, no model, no key. Its answer is an UNSCORED
 * full-swing response whose every text is labelled as a synthetic test result, so a report built from it can never
 * be mistaken for an AI observation and shows no invented score. A real provider adapter is a later, separately
 * authorized step.
 */

import {
  QUALITATIVE_ITEM_IDS,
  SWING_DETAILS,
  SWING_POSITIONS,
  THRESHOLD_MEASURES,
} from "@/lib/full-swing-scoring-rubric";
import type { ClientMetrics } from "@/lib/analysis-metrics-validation";
import { SYNTHETIC_RESULT_LABEL } from "@/lib/analysis-attempt-precedence";

export { SYNTHETIC_RESULT_LABEL };

export type ProviderMode = "synthetic" | "real";

export interface ProviderRequest {
  readonly jobId: string;
  readonly analysisId: string;
  readonly generation: number;
  readonly video: { readonly bytes: ArrayBuffer; readonly mimeType: string };
  readonly clientMetrics: ClientMetrics | null;
  readonly signal: AbortSignal;
}

/**
 * - `response`: a complete answer; the worker validates it with the full-swing contract before anything is stored.
 * - `rejected`: the provider refused before any model ran (the route's 401/403/404 rule): a retry duplicates nothing.
 * - `unusable`: a complete answer that cannot become an analysis (blocked, cut short, not JSON).
 * - `unknown`: no definite answer (transport error, timeout, abort): the provider may have run.
 */
export type ProviderOutcome =
  | { readonly kind: "response"; readonly body: unknown }
  | { readonly kind: "rejected" }
  | { readonly kind: "unusable" }
  | { readonly kind: "unknown" };

export interface AnalysisProviderAdapter {
  readonly providerMode: ProviderMode;
  run(request: ProviderRequest): Promise<ProviderOutcome>;
}


/**
 * The synthetic full-swing answer: unscored (scorable false), every position and detail unclear, every rubric item
 * not assessable, no highlights, deficiencies or drills, and labelled text. It passes
 * validateFullSwingModelResponse and becomes a stored report with score null.
 */
export function syntheticFullSwingResponse(): Record<string, unknown> {
  const notAssessed = (area: string) => ({
    rating: "insufficient_evidence",
    observation: `${SYNTHETIC_RESULT_LABEL}: ${area} was not assessed. No swing was analysed.`,
    correction: "",
  });
  return {
    evidence_limits: `${SYNTHETIC_RESULT_LABEL}: produced by the local test adapter, not by an AI model. No video was analysed, so nothing here describes the swing.`,
    camera_view: "unclear",
    positions: Object.fromEntries(SWING_POSITIONS.map((p) => [p, { visible: "unclear", at: null }])),
    detail_visibility: Object.fromEntries(SWING_DETAILS.map((d) => [d, "unclear"])),
    spine_angle: null,
    hip_rotation: null,
    shoulder_rotation: null,
    tempo_ratio: null,
    threshold_assessments: Object.fromEntries(THRESHOLD_MEASURES.map((m) => [m, { assessable: false, basis: null }])),
    posture: notAssessed("Posture"),
    swing_plane: notAssessed("The swing plane"),
    impact: notAssessed("Impact"),
    rubric_findings: QUALITATIVE_ITEM_IDS.map((id) => ({ id, status: "not_assessable" })),
    highlights: [],
    deficiencies: [],
    drills: [],
    executive_summary: `${SYNTHETIC_RESULT_LABEL}: this report was produced by the local test adapter, not by an AI model. No swing was analysed; there is no score and no observation.`,
    practice_focus: null,
    pro_cue: null,
    scorable: false,
    unscored_reason: `${SYNTHETIC_RESULT_LABEL}: no swing was analysed.`,
  };
}

export interface SyntheticAdapterOptions {
  /** What the synthetic provider answers (default: the synthetic response). */
  readonly outcome?: ProviderOutcome;
  /** Resolves before the answer is returned (tests delay a worker past its lease with it). */
  readonly gate?: () => Promise<void>;
}

/** The synthetic adapter, with a call counter the tests read. No network, no key, no model. */
export function createSyntheticFullSwingAdapter(options: SyntheticAdapterOptions = {}): AnalysisProviderAdapter & {
  readonly calls: () => number;
  readonly requests: () => readonly { jobId: string; generation: number }[];
} {
  const seen: { jobId: string; generation: number }[] = [];
  return {
    providerMode: "synthetic",
    calls: () => seen.length,
    requests: () => seen.slice(),
    async run(request: ProviderRequest): Promise<ProviderOutcome> {
      seen.push({ jobId: request.jobId, generation: request.generation });
      if (options.gate) await options.gate();
      if (request.signal.aborted) return { kind: "unknown" };
      return options.outcome ?? { kind: "response", body: syntheticFullSwingResponse() };
    },
  };
}
