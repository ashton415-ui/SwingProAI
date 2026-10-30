// ============================================================================
// ENT-1D S6-R1 — full-swing model response contract and metric evidence
// ============================================================================
//
// The full-swing route asks the model for one JSON object (RESPONSE_SCHEMA in
// app/api/analyze-swing/route.ts). The provider enforces the shape loosely, so
// nothing it returns is stored until this module has checked every field:
//
//   - whether the analysis is scored is decided by explicit, validated
//     evidence coverage (S6-R1A), never by reading free text: the model states,
//     for address, top of backswing and impact, whether the video shows that
//     position clearly enough to judge. A score exists only when all three are
//     covered and at least one pillar was actually assessed, and it must lie
//     within the rubric's own clamp (55-99). A score without that coverage is a
//     contradiction and is refused — never repaired. Full coverage is necessary
//     for a score but does not require one: other limits (for example timing
//     the video cannot show) may still prevent applying the rubric, and the
//     model then leaves score null and says why in scoring_breakdown. Eligibility
//     is never inferred from that text. A missing score is never replaced by 0
//     or by the rubric's starting value;
//   - each swing estimate is the model's own approximate value from the video,
//     or null when the video does not show it. Zero is a value, not a gap;
//   - lists may be empty when the video supports no finding, and a drill
//     exists only for a listed deficiency;
//   - a pillar may be rated "insufficient_evidence", and must be when the
//     position it rates is not covered (posture ↔ address, swing plane ↔ top of
//     backswing, impact ↔ impact).
//
// A response that fails any check is refused as a whole: nothing is repaired,
// defaulted or partly stored. The reason is a fixed code for the caller's own
// use and is never logged or returned to the golfer.
//
// Metric evidence records each value together with where it came from. The
// server assigns the source; nothing the model or client says can relabel a
// value. A client-supplied estimate — sent with the request; the server cannot
// verify where it came from — is kept beside the AI estimate, unverified, and
// never takes its place.

export const FULL_SWING_METRIC_KEYS = ["spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio"] as const;
export type FullSwingMetricKey = (typeof FULL_SWING_METRIC_KEYS)[number];

export const PILLAR_RATINGS = ["excellent", "good", "needs_work", "poor", "insufficient_evidence"] as const;
export type PillarRating = (typeof PILLAR_RATINGS)[number];

/** Upper bound on each finding list, as the response schema describes it. */
export const MAX_FINDINGS = 4;

/** The existing rubric's clamp (route SYSTEM_INSTRUCTION): a scored result lies within it. */
export const SCORE_FLOOR = 55;
export const SCORE_CEILING = 99;

/** Swing positions the scoring rubric needs; each must be covered for a score to exist. */
export const COVERAGE_POSITIONS = ["address", "top_of_backswing", "impact"] as const;
export type CoveragePosition = (typeof COVERAGE_POSITIONS)[number];
export type EvidenceCoverage = Readonly<Record<CoveragePosition, boolean>>;

/** The position each pillar rates: a rated pillar needs its position covered. */
export const PILLAR_POSITION = { posture: "address", swing_plane: "top_of_backswing", impact: "impact" } as const;

/** A tempo estimate in the "N:1" / "N.N:1" form; the same form a client estimate must have. */
export const TEMPO_RATIO_PATTERN = /^\d{1,2}(\.\d{1,2})?:1$/;

export interface FullSwingPillar {
  readonly rating: PillarRating;
  readonly observation: string;
  readonly correction: string;
}

export interface FullSwingReport {
  readonly scoring_breakdown: string;
  readonly score: number | null;
  readonly executive_summary: string;
  readonly evidence_limits: string;
  readonly evidence_coverage: EvidenceCoverage;
  readonly fault_tags: readonly string[];
  readonly spine_angle: number | null;
  readonly hip_rotation: number | null;
  readonly shoulder_rotation: number | null;
  readonly tempo_ratio: string | null;
  readonly highlights: readonly { readonly title: string; readonly description: string }[];
  readonly deficiencies: readonly { readonly title: string; readonly description: string }[];
  readonly drills: readonly { readonly name: string; readonly the_why: string; readonly the_how: string; readonly the_feel: string }[];
  readonly posture: FullSwingPillar;
  readonly swing_plane: FullSwingPillar;
  readonly impact: FullSwingPillar;
  readonly practice_focus: string | null;
  readonly pro_cue: string | null;
}

export type FullSwingRejection =
  | "not_object"
  | "bad_text"
  | "bad_score"
  | "bad_angle"
  | "bad_tempo"
  | "bad_list"
  | "bad_pillar"
  | "drill_without_deficiency"
  | "bad_coverage"
  | "score_without_coverage"
  | "score_without_assessed_pillar"
  | "pillar_without_coverage";

export type FullSwingValidation =
  | { readonly ok: true; readonly report: FullSwingReport }
  | { readonly ok: false; readonly reason: FullSwingRejection };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** A plausible angle in degrees: finite and within one turn either way. Zero is valid. */
export const isAngleEstimate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= -360 && value <= 360;

export const isTempoEstimate = (value: unknown): value is string =>
  typeof value === "string" && TEMPO_RATIO_PATTERN.test(value);

class Rejected extends Error {
  constructor(readonly reason: FullSwingRejection) {
    super(reason);
  }
}

function text(value: unknown): string {
  if (!nonEmpty(value)) throw new Rejected("bad_text");
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null) return null;
  if (!nonEmpty(value)) throw new Rejected("bad_text");
  return value;
}

function angle(value: unknown): number | null {
  if (value === null) return null;
  if (!isAngleEstimate(value)) throw new Rejected("bad_angle");
  return value;
}

function tempo(value: unknown): string | null {
  if (value === null) return null;
  if (!isTempoEstimate(value)) throw new Rejected("bad_tempo");
  return value;
}

function list<T>(value: unknown, item: (entry: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) throw new Rejected("bad_list");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Rejected("bad_list");
    return item(entry);
  });
}

function coverage(value: unknown): EvidenceCoverage {
  if (!isRecord(value)) throw new Rejected("bad_coverage");
  const out = {} as Record<CoveragePosition, boolean>;
  for (const position of COVERAGE_POSITIONS) {
    if (typeof value[position] !== "boolean") throw new Rejected("bad_coverage");
    out[position] = value[position] as boolean;
  }
  return out;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) throw new Rejected("bad_list");
  return value.map((entry) => {
    if (!nonEmpty(entry)) throw new Rejected("bad_list");
    return entry;
  });
}

function pillar(value: unknown): FullSwingPillar {
  if (!isRecord(value)) throw new Rejected("bad_pillar");
  const rating = value.rating;
  if (typeof rating !== "string" || !(PILLAR_RATINGS as readonly string[]).includes(rating)) {
    throw new Rejected("bad_pillar");
  }
  if (!nonEmpty(value.observation) || typeof value.correction !== "string") throw new Rejected("bad_pillar");
  // A rated area needs a correction; an area the video cannot show may have none.
  if (rating !== "insufficient_evidence" && !nonEmpty(value.correction)) throw new Rejected("bad_pillar");
  return { rating: rating as PillarRating, observation: value.observation, correction: value.correction };
}

/**
 * Scored and unscored must agree with the stated coverage and the pillars.
 * Contradictions are refused, never repaired.
 */
function checkScoredConsistency(report: FullSwingReport): void {
  const covered = COVERAGE_POSITIONS.every((position) => report.evidence_coverage[position]);
  for (const [pillarKey, position] of Object.entries(PILLAR_POSITION) as [keyof typeof PILLAR_POSITION, CoveragePosition][]) {
    if (report[pillarKey].rating !== "insufficient_evidence" && !report.evidence_coverage[position]) {
      throw new Rejected("pillar_without_coverage");
    }
  }
  // Unscored is always allowed (scoring_breakdown, required non-empty, says
  // why). Coverage gates a score; it never demands one (S6-R1B).
  if (report.score === null) return;
  if (!covered) throw new Rejected("score_without_coverage");
  const assessed = (Object.keys(PILLAR_POSITION) as (keyof typeof PILLAR_POSITION)[]).some(
    (pillarKey) => report[pillarKey].rating !== "insufficient_evidence",
  );
  if (!assessed) throw new Rejected("score_without_assessed_pillar");
}

/** Checks a parsed model response against the full-swing contract. Never throws. */
export function validateFullSwingModelResponse(value: unknown): FullSwingValidation {
  try {
    if (!isRecord(value)) throw new Rejected("not_object");
    const score = value.score;
    if (
      score !== null &&
      !(typeof score === "number" && Number.isInteger(score) && score >= SCORE_FLOOR && score <= SCORE_CEILING)
    ) {
      throw new Rejected("bad_score");
    }
    const faultTags = textList(value.fault_tags);
    const deficiencies = list(value.deficiencies, (entry) => ({ title: text(entry.title), description: text(entry.description) }));
    const drills = list(value.drills, (entry) => ({
      name: text(entry.name),
      the_why: text(entry.the_why),
      the_how: text(entry.the_how),
      the_feel: text(entry.the_feel),
    }));
    if (drills.length > deficiencies.length) throw new Rejected("drill_without_deficiency");
    const report: FullSwingReport = {
      scoring_breakdown: text(value.scoring_breakdown),
      score: score as number | null,
      executive_summary: text(value.executive_summary),
      evidence_limits: text(value.evidence_limits),
      evidence_coverage: coverage(value.evidence_coverage),
      fault_tags: faultTags,
      spine_angle: angle(value.spine_angle),
      hip_rotation: angle(value.hip_rotation),
      shoulder_rotation: angle(value.shoulder_rotation),
      tempo_ratio: tempo(value.tempo_ratio),
      highlights: list(value.highlights, (entry) => ({ title: text(entry.title), description: text(entry.description) })),
      deficiencies,
      drills,
      posture: pillar(value.posture),
      swing_plane: pillar(value.swing_plane),
      impact: pillar(value.impact),
      practice_focus: optionalText(value.practice_focus),
      pro_cue: optionalText(value.pro_cue),
    };
    checkScoredConsistency(report);
    return { ok: true, report };
  } catch (rejection) {
    return { ok: false, reason: rejection instanceof Rejected ? rejection.reason : "not_object" };
  }
}

// ── Metric evidence (stored in swing_analysis.metrics.metric_evidence) ───────

export const METRIC_EVIDENCE_VERSION = 1;

/** One metric's recorded values, each named by its server-assigned source. */
export interface MetricEvidenceEntry {
  /** The model's own estimate from the video, or null when the video did not show it. */
  readonly ai_video_estimate: number | string | null;
  /** A value the client sent with the request: computed off the server, unverified. */
  readonly client_unverified_estimate: number | string | null;
}

export type MetricEvidence = { readonly schema_version: typeof METRIC_EVIDENCE_VERSION } & Readonly<
  Record<FullSwingMetricKey, MetricEvidenceEntry>
>;

/** Client-supplied values the route accepted (finite angle / "N.N:1" tempo; origin unverifiable) or null. */
export interface AcceptedClientEstimates {
  readonly spineAngle: number | null;
  readonly hipRotation: number | null;
  readonly shoulderRotation: number | null;
  readonly tempoRatio: string | null;
}

/**
 * Value and source together, assigned by the server. The AI estimate is the
 * analysis value; a client estimate is recorded beside it and never replaces
 * an AI value that the video did not support.
 */
export function buildMetricEvidence(report: FullSwingReport, client: AcceptedClientEstimates): MetricEvidence {
  return {
    schema_version: METRIC_EVIDENCE_VERSION,
    spine_angle: { ai_video_estimate: report.spine_angle, client_unverified_estimate: client.spineAngle },
    hip_rotation: { ai_video_estimate: report.hip_rotation, client_unverified_estimate: client.hipRotation },
    shoulder_rotation: { ai_video_estimate: report.shoulder_rotation, client_unverified_estimate: client.shoulderRotation },
    tempo_ratio: { ai_video_estimate: report.tempo_ratio, client_unverified_estimate: client.tempoRatio },
  };
}

/** The stored evidence, re-validated on read; null when absent or malformed (a legacy or unknown row). */
export function readMetricEvidence(value: unknown): MetricEvidence | null {
  if (!isRecord(value) || value.schema_version !== METRIC_EVIDENCE_VERSION) return null;
  const out: Record<string, MetricEvidenceEntry> = {};
  for (const key of FULL_SWING_METRIC_KEYS) {
    const entry = value[key];
    if (!isRecord(entry)) return null;
    const valid = key === "tempo_ratio" ? isTempoEstimate : isAngleEstimate;
    const ai = entry.ai_video_estimate;
    const client = entry.client_unverified_estimate;
    if ((ai !== null && !valid(ai)) || (client !== null && !valid(client))) return null;
    out[key] = { ai_video_estimate: ai as number | string | null, client_unverified_estimate: client as number | string | null };
  }
  return { schema_version: METRIC_EVIDENCE_VERSION, ...(out as Record<FullSwingMetricKey, MetricEvidenceEntry>) };
}
