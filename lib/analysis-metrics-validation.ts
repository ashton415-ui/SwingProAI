/**
 * SwingProAI — client-supplied swing estimates, validated (AG-WEB-READY-10-P2).
 *
 * The analyze route and the background worker both splice client estimates into
 * the model prompt, so both keep only values with the shape of an estimate: a
 * finite angle in degrees within one turn, or an "N:1" / "N.N:1" tempo. Free
 * text, nested values and oversized numbers are dropped. The server cannot
 * verify where these values came from; they stay unverified estimates
 * (ENT-1D S6-R1A). The database CHECK on analysis_jobs.client_metrics
 * (analysis_metrics_values_ok) applies the same rules.
 *
 * Extracted from app/api/analyze-swing/route.ts (clientAngle / clientTempoRatio)
 * without change, so the route and the worker share one implementation.
 */

/** The six estimate keys a client may send, in the route's request field `mediapipeMetrics`. */
export const CLIENT_METRIC_KEYS = [
  "spineAngle",
  "hipRotation",
  "shoulderRotation",
  "tempoRatio",
  "setupSpineAngle",
  "impactSpineAngle",
] as const;

export type ClientMetricKey = (typeof CLIENT_METRIC_KEYS)[number];

/** The tempo form the route accepts (and the database CHECK mirrors). */
export const CLIENT_TEMPO_RATIO_PATTERN = /^\d{1,2}(\.\d{1,2})?:1$/;

/** A client-supplied angle estimate in degrees (unverified), or null when it is not one. */
export function clientAngle(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= -360 && value <= 360 ? value : null;
}

/** A client-supplied tempo estimate (unverified) in the "N.N:1" form, or null. */
export function clientTempoRatio(value: unknown): string | null {
  return typeof value === "string" && CLIENT_TEMPO_RATIO_PATTERN.test(value) ? value : null;
}

export interface ClientMetrics {
  spineAngle?: number;
  hipRotation?: number;
  shoulderRotation?: number;
  tempoRatio?: string;
  setupSpineAngle?: number;
  impactSpineAngle?: number;
}

/**
 * Only the well-formed estimates of a request body's `mediapipeMetrics`, with no
 * null or invalid entry, or null when none is usable. Never throws.
 */
export function sanitizeClientMetrics(raw: unknown): ClientMetrics | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: ClientMetrics = {};
  for (const key of CLIENT_METRIC_KEYS) {
    if (key === "tempoRatio") {
      const tempo = clientTempoRatio(source[key]);
      if (tempo !== null) out.tempoRatio = tempo;
    } else {
      const angle = clientAngle(source[key]);
      if (angle !== null) out[key] = angle;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
