// ============================================================================
// ENT-1D S6-R1 — how full-swing estimates, scores and assessments are shown
// ============================================================================
//
// One place decides how a full-swing value reaches a golfer, for every
// surface (history, swing detail, report, analyze). The rules come from the
// Product Constitution §B: never present an estimate as a measurement, never
// show more precision than the evidence supports, and say when a value is
// unavailable.
//
//   - Angles show to the nearest 5° and tempo to the nearest 0.5, always with
//     "≈" and a label naming the source. Zero is a value; an absent or
//     malformed value is "Not available", never 0.
//   - A client-supplied estimate (the server cannot verify its origin) is shown
//     only as a separate, unverified line, never as the value.
//   - No rating, target or benchmark is shown unless METRIC_REFERENCES holds a
//     range WITH a cited source. None does yet, so none renders.
//   - The score is shown with its basis; an unscored analysis says so.
//
// Pure and client-safe: no server import, so client components may use it.
// The input types mirror the read authority's view structurally.

export type MetricKey = "spine_angle" | "hip_rotation" | "shoulder_rotation" | "tempo_ratio";
export const METRIC_KEYS: readonly MetricKey[] = ["spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio"];

export interface MetricViewInput {
  readonly value: number | string | null;
  readonly source: "ai_video_estimate" | "unrecorded";
  readonly client_unverified_estimate: number | string | null;
}

export const METRIC_LABELS: Readonly<Record<MetricKey, string>> = {
  spine_angle: "Spine Angle",
  hip_rotation: "Hip Rotation",
  shoulder_rotation: "Shoulder Turn",
  tempo_ratio: "Tempo",
};

/**
 * The only home of target guidance. A range renders only with a cited source,
 * and only once "spine angle" and the others have an agreed definition. Until a
 * cited source is added, every entry is empty and no target is shown anywhere.
 */
export interface MetricReference {
  readonly definition: string | null;
  readonly range: { readonly min: number; readonly max: number } | null;
  readonly source: string | null;
}

export const METRIC_REFERENCES: Readonly<Record<MetricKey, MetricReference>> = {
  spine_angle: { definition: null, range: null, source: null },
  hip_rotation: { definition: null, range: null, source: null },
  shoulder_rotation: { definition: null, range: null, source: null },
  tempo_ratio: { definition: null, range: null, source: null },
};

export const SOURCE_LABELS = {
  ai_video_estimate: "AI estimate from video",
  unrecorded: "Estimate · source not recorded",
} as const;

// S6-R1A. Shared by every row, including historical ones whose source was not
// recorded, so neither line claims an origin; each value carries its own label.
export const ESTIMATES_HEADING = "Swing estimates";
export const ESTIMATES_DISCLOSURE =
  "Approximate estimates, rounded. Not instrument measurements. Each value shows its source where one was recorded; client-supplied values cannot be verified.";
export const UNAVAILABLE_DISPLAY = "Not available";
export const UNAVAILABLE_FROM_VIDEO = "The video didn't show this clearly enough to estimate.";

export const ASSESSMENT_LABEL = "AI coaching assessment · from your video, not a measurement";
export const SCORE_BASIS =
  "AI rubric score · estimated from your video with SwingProAI's scoring rubric; not a calibrated measurement.";
export const UNSCORED_LABEL = "Not scored";
export const UNSCORED_COPY =
  "The video didn't show enough of the swing to apply the scoring rubric, so no score was given.";
export const EVIDENCE_LIMITS_LABEL = "What this video couldn't show";

export const SWING_SPEED_LABEL = "Swing Speed";
export const SWING_SPEED_NOT_MEASURED = "Not measured";
export const SWING_SPEED_NOTE = "SwingProAI does not measure swing speed from video.";

export type PresentedMetric =
  | {
      readonly status: "estimate";
      readonly label: string;
      readonly display: string;
      readonly sourceLabel: string;
      readonly clientNote: string | null;
      readonly reference: string | null;
    }
  | {
      readonly status: "unavailable";
      readonly label: string;
      readonly display: typeof UNAVAILABLE_DISPLAY;
      readonly sourceLabel: string | null;
      readonly clientNote: string | null;
      readonly reference: null;
    };

const isAngle = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -360 && v <= 360;

function tempoNumber(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const match = /^(\d{1,2}(?:\.\d{1,2})?):1$/.exec(v);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "≈50°": nearest 5°, never a decimal. -0 shows as 0. */
export function formatAngle(value: number): string {
  const rounded = Math.round(value / 5) * 5;
  return `≈${rounded === 0 ? 0 : rounded}°`;
}

/** "≈2:1" / "≈2.5:1": nearest 0.5. */
export function formatTempo(value: number): string {
  const rounded = Math.round(value * 2) / 2;
  return `≈${rounded}:1`;
}

function display(key: MetricKey, value: unknown): string | null {
  if (key === "tempo_ratio") {
    const t = tempoNumber(value);
    return t === null ? null : formatTempo(t);
  }
  return isAngle(value) ? formatAngle(value) : null;
}

function reference(key: MetricKey): string | null {
  const ref = METRIC_REFERENCES[key];
  if (!ref.range || !ref.source) return null;
  const unit = key === "tempo_ratio" ? ":1" : "°";
  return `Reference (${ref.source}): ${ref.range.min}–${ref.range.max}${unit}`;
}

/** How one estimate is shown. Missing or malformed input is unavailable, never 0. */
export function presentMetric(key: MetricKey, entry: MetricViewInput | null | undefined): PresentedMetric {
  const label = METRIC_LABELS[key];
  const client = entry ? display(key, entry.client_unverified_estimate) : null;
  const clientNote = client ? `Client-supplied estimate — unverified: ${client}` : null;
  const shown = entry ? display(key, entry.value) : null;
  if (!entry || shown === null) {
    return {
      status: "unavailable",
      label,
      display: UNAVAILABLE_DISPLAY,
      sourceLabel: entry?.source === "ai_video_estimate" ? UNAVAILABLE_FROM_VIDEO : null,
      clientNote,
      reference: null,
    };
  }
  return { status: "estimate", label, display: shown, sourceLabel: SOURCE_LABELS[entry.source], clientNote, reference: reference(key) };
}

/** All four, in display order. A missing view (legacy or putting) is all unavailable. */
export function presentFullSwingMetrics(
  view: Readonly<Record<MetricKey, MetricViewInput>> | null | undefined,
): PresentedMetric[] {
  return METRIC_KEYS.map((key) => presentMetric(key, view ? view[key] : null));
}

/** A score is a finite number from 0 to 100; anything else is "not scored". Zero is a score. */
export function presentScore(score: unknown): { readonly scored: true; readonly value: number } | { readonly scored: false } {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
    ? { scored: true, value: score }
    : { scored: false };
}
