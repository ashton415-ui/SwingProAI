// ============================================================================
// ENT-1D S6-R1 — full-swing model response contract and metric evidence
// Server-authoritative scoring (local candidate): provider contract fs-provider-v2
// ============================================================================
//
// The full-swing route asks the model for one JSON object (RESPONSE_SCHEMA in
// app/api/analyze-swing/route.ts). The provider enforces the shape loosely, so
// nothing it returns is stored until this module has checked every field. Three
// steps are kept apart:
//
//   1. validateFullSwingProviderResponse — the provider response (fs-provider-v2):
//      declarations (camera view; which swing positions and body/club details
//      the video shows, with timestamps), the model's own approximate estimates,
//      whether each threshold measure could be assessed and on what visible
//      basis, a finding per qualitative rubric item, the pillars, the coaching
//      lists and whether the rubric could be applied ("scorable"). The provider
//      never writes the score, the scoring breakdown or fault tags: a response
//      that carries them is refused.
//   2. Deterministic scoring (lib/full-swing-scoring-rubric.ts) — item outcomes
//      and the score, computed by the server from the validated inputs.
//   3. toCanonicalFullSwingReport — the stored report, in the shapes stored and
//      served before this change (score, scoring_breakdown, the boolean
//      evidence_coverage map, fault_tags, estimates, pillars, lists), plus an
//      internal, versioned rubric_assessment that readers never serve.
//
// Refusal: a response is refused as a whole when it is malformed or when its
// own parts contradict each other in a way the server can detect mechanically
// (for example an item assessed while the view or detail it needs is declared
// unavailable, an estimate given while its evidence is declared unclear,
// timestamps out of order, coaching linked to an item that was not observed).
// Nothing is repaired, defaulted, partly stored or retried. The reason is a
// fixed code for the caller's own use and is never logged or returned to the
// golfer.
//
// What these checks do not establish: whether any declaration, estimate,
// finding, timestamp or piece of prose is true. The declarations are the
// model's statements, kept internal and unverified; timestamps never prove
// which frames the provider sampled. Accuracy and usefulness still need content
// evaluation. Honest uncertainty ("unclear", not assessable, scorable false)
// is always a valid unscored outcome; full coverage never forces a score.
//
// Metric evidence records each value together with where it came from. The
// server assigns the source; nothing the model or client says can relabel a
// value. A client-supplied estimate — sent with the request; the server cannot
// verify where it came from — is kept beside the AI estimate, unverified, and
// never takes its place.

import {
  CAMERA_VIEWS,
  DETAIL_VISIBILITY,
  FINDING_STATUSES,
  MEASURES,
  POSITION_VISIBILITY,
  QUALITATIVE_ITEM_IDS,
  RUBRIC_POLICY,
  RUBRIC_SCORE_CEILING,
  RUBRIC_SCORE_FLOOR,
  RUBRIC_VERSION,
  SWING_DETAILS,
  SWING_POSITIONS,
  THRESHOLD_MEASURES,
  computeRubricScore,
  requirementGap,
  rubricItem,
  rubricOutcomes,
  type AppliedAdjustment,
  type CameraView,
  type DetailVisibility,
  type FindingStatus,
  type ItemOutcome,
  type PositionVisibility,
  type RubricDeclarations,
  type SwingDetail,
  type SwingPosition,
  type ThresholdMeasure,
} from "@/lib/full-swing-scoring-rubric";

export const FULL_SWING_METRIC_KEYS = ["spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio"] as const;
export type FullSwingMetricKey = (typeof FULL_SWING_METRIC_KEYS)[number];

export const PILLAR_RATINGS = ["excellent", "good", "needs_work", "poor", "insufficient_evidence"] as const;
export type PillarRating = (typeof PILLAR_RATINGS)[number];

/** Upper bound on each finding list, as the response schema describes it. */
export const MAX_FINDINGS = 4;

/** The rubric's clamp: a scored result lies within it. */
export const SCORE_FLOOR = RUBRIC_SCORE_FLOOR;
export const SCORE_CEILING = RUBRIC_SCORE_CEILING;

/** Swing positions the scoring rubric needs; each must be covered for a score to exist. */
export const COVERAGE_POSITIONS = ["address", "top_of_backswing", "impact"] as const;
export type CoveragePosition = (typeof COVERAGE_POSITIONS)[number];
export type EvidenceCoverage = Readonly<Record<CoveragePosition, boolean>>;

/** The position each pillar rates: a rated pillar needs its position covered. */
export const PILLAR_POSITION = { posture: "address", swing_plane: "top_of_backswing", impact: "impact" } as const;

/** A tempo estimate in the "N:1" / "N.N:1" form; the same form a client estimate must have. */
export const TEMPO_RATIO_PATTERN = /^\d{1,2}(\.\d{1,2})?:1$/;

/** A video timestamp "M:SS" or "M:SS.s" / "M:SS.ss" (non-negative by construction). */
export const POSITION_TIME_PATTERN = /^\d{1,2}:[0-5]\d(\.\d{1,2})?$/;

/** The provider contract this module validates. */
export const FULL_SWING_PROVIDER_CONTRACT = "fs-provider-v2" as const;
export const RUBRIC_ASSESSMENT_VERSION = 1;

/** Keys the provider must never write: the server computes them. */
export const PROVIDER_FORBIDDEN_KEYS = ["score", "scoring_breakdown", "fault_tags", "evidence_coverage"] as const;

/** The visible evidence each AI estimate depends on (no view requirement). */
export const ESTIMATE_EVIDENCE: Readonly<Record<FullSwingMetricKey, { readonly details: readonly SwingDetail[]; readonly positions: readonly SwingPosition[] }>> = {
  spine_angle: { details: ["spine_line"], positions: ["address"] },
  shoulder_rotation: { details: ["shoulders"], positions: ["top_of_backswing"] },
  hip_rotation: { details: ["pelvis"], positions: ["impact"] },
  tempo_ratio: { details: [], positions: ["takeaway_start", "top_of_backswing", "impact"] },
};

export interface FullSwingPillar {
  readonly rating: PillarRating;
  readonly observation: string;
  readonly correction: string;
}

/** The canonical stored report: the same shape stored before server-authoritative scoring. */
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

export interface PositionDeclaration {
  readonly visible: PositionVisibility;
  readonly at: string | null;
}

export interface LinkedFinding {
  readonly title: string;
  readonly description: string;
  readonly rubric_id: string | null;
}

/** A validated fs-provider-v2 response. Declarations are model statements, not verified facts. */
export interface FullSwingProviderResponse {
  readonly evidence_limits: string;
  readonly camera_view: CameraView;
  readonly positions: Readonly<Record<SwingPosition, PositionDeclaration>>;
  readonly detail_visibility: Readonly<Record<SwingDetail, DetailVisibility>>;
  readonly spine_angle: number | null;
  readonly hip_rotation: number | null;
  readonly shoulder_rotation: number | null;
  readonly tempo_ratio: string | null;
  readonly threshold_assessments: Readonly<Record<ThresholdMeasure, { readonly assessable: boolean; readonly basis: string | null }>>;
  readonly posture: FullSwingPillar;
  readonly swing_plane: FullSwingPillar;
  readonly impact: FullSwingPillar;
  readonly rubric_findings: Readonly<Record<string, FindingStatus>>;
  readonly highlights: FullSwingReport["highlights"];
  readonly deficiencies: readonly LinkedFinding[];
  readonly drills: FullSwingReport["drills"];
  readonly executive_summary: string;
  readonly practice_focus: string | null;
  readonly pro_cue: string | null;
  readonly scorable: boolean;
  readonly unscored_reason: string | null;
  /** Item outcomes the server derived (part of validation: coaching links and scorability depend on them). */
  readonly outcomes: readonly ItemOutcome[];
}

/** Internal audit record stored at metrics.rubric_assessment; never served. */
export interface RubricAssessment {
  readonly version: typeof RUBRIC_ASSESSMENT_VERSION;
  readonly provider_contract: typeof FULL_SWING_PROVIDER_CONTRACT;
  readonly rubric_version: typeof RUBRIC_VERSION;
  readonly policy: typeof RUBRIC_POLICY;
  /** Model statements, unverified. */
  readonly declarations: {
    readonly camera_view: CameraView;
    readonly positions: Readonly<Record<SwingPosition, PositionDeclaration>>;
    readonly detail_visibility: Readonly<Record<SwingDetail, DetailVisibility>>;
  };
  readonly threshold_assessments: FullSwingProviderResponse["threshold_assessments"];
  readonly findings: readonly ItemOutcome[];
  readonly scorable_declared: boolean;
  readonly outcome: "scored" | "unscored";
  readonly applied: readonly AppliedAdjustment[];
  readonly raw_total: number | null;
}

export type FullSwingRejection =
  | "not_object"
  | "provider_authored_scoring"
  | "bad_text"
  | "bad_angle"
  | "bad_tempo"
  | "bad_list"
  | "bad_pillar"
  | "drill_without_deficiency"
  | "bad_declaration"
  | "bad_position_time"
  | "position_order"
  | "estimate_without_declared_evidence"
  | "bad_threshold_assessment"
  | "threshold_assessable_without_evidence"
  | "threshold_assessable_without_estimate"
  | "bad_rubric_finding"
  | "threshold_item_classified"
  | "quarantined_item_claimed"
  | "finding_view_mismatch"
  | "finding_detail_unavailable"
  | "finding_position_unavailable"
  | "pillar_without_coverage"
  | "bad_scorable"
  | "scorable_without_coverage"
  | "scorable_without_assessed_pillar"
  | "scorable_without_assessable_item"
  | "bad_rubric_link"
  | "deficiency_rubric_mismatch"
  | "duplicate_rubric_link";

export type FullSwingProviderValidation =
  | { readonly ok: true; readonly provider: FullSwingProviderResponse }
  | { readonly ok: false; readonly reason: FullSwingRejection };

export type FullSwingValidation =
  | { readonly ok: true; readonly report: FullSwingReport; readonly assessment: RubricAssessment }
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], reason: FullSwingRejection): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Rejected(reason);
  return value as T;
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

const seconds = (at: string): number => {
  const [minutes, rest] = at.split(":");
  return Number(minutes) * 60 + Number(rest);
};

function positions(value: unknown): Record<SwingPosition, PositionDeclaration> {
  if (!isRecord(value)) throw new Rejected("bad_declaration");
  const out = {} as Record<SwingPosition, PositionDeclaration>;
  for (const position of SWING_POSITIONS) {
    const entry = value[position];
    if (!isRecord(entry)) throw new Rejected("bad_declaration");
    const visible = oneOf(entry.visible, POSITION_VISIBILITY, "bad_declaration");
    const at = entry.at;
    // A timestamp is given exactly when the position is declared visible.
    if (visible === "yes") {
      if (typeof at !== "string" || !POSITION_TIME_PATTERN.test(at)) throw new Rejected("bad_position_time");
    } else if (at !== null) {
      throw new Rejected("bad_position_time");
    }
    out[position] = { visible, at: at as string | null };
  }
  // Applicable ordering only; the clip's duration is not independently known here,
  // so no duration bound is checked, and no timestamp proves which frames were sampled.
  const timed = SWING_POSITIONS.filter((p) => out[p].at !== null);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = seconds(out[timed[i]].at as string);
      const b = seconds(out[timed[j]].at as string);
      const mayCoincide = timed[i] === "address" && timed[j] === "takeaway_start";
      if (mayCoincide ? a > b : a >= b) throw new Rejected("position_order");
    }
  }
  return out;
}

function detailVisibility(value: unknown): Record<SwingDetail, DetailVisibility> {
  if (!isRecord(value)) throw new Rejected("bad_declaration");
  const out = {} as Record<SwingDetail, DetailVisibility>;
  for (const detail of SWING_DETAILS) out[detail] = oneOf(value[detail], DETAIL_VISIBILITY, "bad_declaration");
  return out;
}

function thresholdAssessments(value: unknown): FullSwingProviderResponse["threshold_assessments"] {
  if (!isRecord(value)) throw new Rejected("bad_threshold_assessment");
  const out = {} as Record<ThresholdMeasure, { assessable: boolean; basis: string | null }>;
  for (const measure of THRESHOLD_MEASURES) {
    const entry = value[measure];
    if (!isRecord(entry) || typeof entry.assessable !== "boolean") throw new Rejected("bad_threshold_assessment");
    // Assessable needs a stated visible basis; not assessable carries none.
    if (entry.assessable ? !nonEmpty(entry.basis) : entry.basis !== null) throw new Rejected("bad_threshold_assessment");
    out[measure] = { assessable: entry.assessable, basis: entry.assessable ? (entry.basis as string) : null };
  }
  return out;
}

function rubricFindings(value: unknown): Record<string, FindingStatus> {
  if (!Array.isArray(value)) throw new Rejected("bad_rubric_finding");
  const out: Record<string, FindingStatus> = {};
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") throw new Rejected("bad_rubric_finding");
    const status = oneOf(entry.status, FINDING_STATUSES, "bad_rubric_finding");
    const item = rubricItem(entry.id);
    if (!item) throw new Rejected("bad_rubric_finding");
    // Threshold outcomes are the server's: the model never classifies against a cutoff.
    if (item.kind === "threshold") throw new Rejected("threshold_item_classified");
    if (item.kind === "quarantined") {
      if (status !== "not_assessable") throw new Rejected("quarantined_item_claimed");
      continue;
    }
    if (entry.id in out) throw new Rejected("bad_rubric_finding");
    out[entry.id] = status;
  }
  if (QUALITATIVE_ITEM_IDS.some((id) => !(id in out))) throw new Rejected("bad_rubric_finding");
  return out;
}

function linkedList(value: unknown): LinkedFinding[] {
  return list(value, (entry) => {
    const id = entry.rubric_id;
    if (id !== null && (typeof id !== "string" || !rubricItem(id))) throw new Rejected("bad_rubric_link");
    return { title: text(entry.title), description: text(entry.description), rubric_id: id as string | null };
  });
}

const declarationsOf = (p: {
  readonly camera_view: CameraView;
  readonly positions: Readonly<Record<SwingPosition, PositionDeclaration>>;
  readonly detail_visibility: Readonly<Record<SwingDetail, DetailVisibility>>;
}): RubricDeclarations => ({
  camera_view: p.camera_view,
  positions: Object.fromEntries(SWING_POSITIONS.map((pos) => [pos, p.positions[pos].visible])) as Record<SwingPosition, PositionVisibility>,
  detail_visibility: p.detail_visibility,
});

const GAP_REASON = { view: "finding_view_mismatch", detail: "finding_detail_unavailable", position: "finding_position_unavailable" } as const;

/** Step 1: the provider response, validated and checked for mechanical contradictions. Never throws. */
export function validateFullSwingProviderResponse(value: unknown): FullSwingProviderValidation {
  try {
    if (!isRecord(value)) throw new Rejected("not_object");
    if (PROVIDER_FORBIDDEN_KEYS.some((key) => key in value)) throw new Rejected("provider_authored_scoring");

    const deficiencies = linkedList(value.deficiencies);
    const drills = list(value.drills, (entry) => ({
      name: text(entry.name),
      the_why: text(entry.the_why),
      the_how: text(entry.the_how),
      the_feel: text(entry.the_feel),
    }));
    if (drills.length > deficiencies.length) throw new Rejected("drill_without_deficiency");

    const declared = {
      camera_view: oneOf(value.camera_view, CAMERA_VIEWS, "bad_declaration"),
      positions: positions(value.positions),
      detail_visibility: detailVisibility(value.detail_visibility),
    };
    const declarations = declarationsOf(declared);
    const estimates = {
      spine_angle: angle(value.spine_angle),
      hip_rotation: angle(value.hip_rotation),
      shoulder_rotation: angle(value.shoulder_rotation),
      tempo_ratio: tempo(value.tempo_ratio),
    };
    // An estimate given while the evidence it depends on is declared unclear or unavailable.
    for (const key of FULL_SWING_METRIC_KEYS) {
      if (estimates[key] === null) continue;
      const need = ESTIMATE_EVIDENCE[key];
      if (
        need.details.some((d) => declarations.detail_visibility[d] !== "visible") ||
        need.positions.some((p) => declarations.positions[p] !== "yes")
      ) {
        throw new Rejected("estimate_without_declared_evidence");
      }
    }

    const threshold = thresholdAssessments(value.threshold_assessments);
    for (const measure of THRESHOLD_MEASURES) {
      if (!threshold[measure].assessable) continue;
      if (requirementGap(declarations, MEASURES[measure]) !== null) throw new Rejected("threshold_assessable_without_evidence");
      if (estimates[MEASURES[measure].estimate] === null) throw new Rejected("threshold_assessable_without_estimate");
    }

    const findings = rubricFindings(value.rubric_findings);
    for (const [id, status] of Object.entries(findings)) {
      if (status === "not_assessable") continue;
      // Assessability applies to observed and not_observed alike: an unassessable feature is never an observed absence.
      const item = rubricItem(id);
      if (item?.kind !== "qualitative") throw new Rejected("bad_rubric_finding");
      const gap = requirementGap(declarations, item);
      if (gap !== null) throw new Rejected(GAP_REASON[gap]);
    }

    const posture = pillar(value.posture);
    const swingPlane = pillar(value.swing_plane);
    const impact = pillar(value.impact);
    const coverage = coverageOf(declarations);
    for (const [key, p] of [["posture", posture], ["swing_plane", swingPlane], ["impact", impact]] as const) {
      if (p.rating !== "insufficient_evidence" && !coverage[PILLAR_POSITION[key]]) throw new Rejected("pillar_without_coverage");
    }

    if (typeof value.scorable !== "boolean") throw new Rejected("bad_scorable");
    const scorable = value.scorable;
    const unscoredReason = value.unscored_reason;
    if (scorable ? unscoredReason !== null : !nonEmpty(unscoredReason)) throw new Rejected("bad_scorable");

    const outcomes = rubricOutcomes({
      declarations,
      estimates: { shoulder_rotation: estimates.shoulder_rotation, hip_rotation: estimates.hip_rotation },
      thresholdAssessable: { shoulder_turn_at_top: threshold.shoulder_turn_at_top.assessable, hip_turn_at_impact: threshold.hip_turn_at_impact.assessable },
      qualitative: findings,
    });

    if (scorable) {
      if (!COVERAGE_POSITIONS.every((p) => coverage[p])) throw new Rejected("scorable_without_coverage");
      if (![posture, swingPlane, impact].some((p) => p.rating !== "insufficient_evidence")) throw new Rejected("scorable_without_assessed_pillar");
      if (!outcomes.some((o) => o.status !== "not_assessable")) throw new Rejected("scorable_without_assessable_item");
    }

    const highlights = list(value.highlights, (entry) => ({ title: text(entry.title), description: text(entry.description) }));
    checkDeficiencyLinks(deficiencies, outcomes);

    return {
      ok: true,
      provider: {
        evidence_limits: text(value.evidence_limits),
        camera_view: declared.camera_view,
        positions: declared.positions,
        detail_visibility: declared.detail_visibility,
        ...estimates,
        threshold_assessments: threshold,
        posture,
        swing_plane: swingPlane,
        impact,
        rubric_findings: findings,
        highlights,
        deficiencies,
        drills,
        executive_summary: text(value.executive_summary),
        practice_focus: optionalText(value.practice_focus),
        pro_cue: optionalText(value.pro_cue),
        scorable,
        unscored_reason: scorable ? null : (unscoredReason as string),
        outcomes,
      },
    };
  } catch (rejection) {
    return { ok: false, reason: rejection instanceof Rejected ? rejection.reason : "not_object" };
  }
}

function coverageOf(declarations: RubricDeclarations): EvidenceCoverage {
  return {
    address: declarations.positions.address === "yes",
    top_of_backswing: declarations.positions.top_of_backswing === "yes",
    impact: declarations.positions.impact === "yes",
  };
}

/**
 * A deficiency may name the qualitative rubric item it describes, and only one
 * the model itself found observed. Threshold outcomes are the server's (the
 * model never sees the cutoffs), so a deficiency cannot be linked to one; it
 * stays unlinked coaching. Each item is linked at most once.
 */
function checkDeficiencyLinks(entries: readonly LinkedFinding[], outcomes: readonly ItemOutcome[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.rubric_id === null) continue;
    const item = rubricItem(entry.rubric_id);
    if (!item) throw new Rejected("bad_rubric_link");
    if (item.kind === "quarantined") throw new Rejected("quarantined_item_claimed");
    if (seen.has(item.id)) throw new Rejected("duplicate_rubric_link");
    seen.add(item.id);
    const observed = outcomes.find((o) => o.id === item.id)?.status === "observed";
    if (item.kind !== "qualitative" || item.points >= 0 || !observed) throw new Rejected("deficiency_rubric_mismatch");
  }
}

/** Step 2: the server's score for a validated response; null whenever the rubric was not applied. */
export function scoreFullSwing(provider: FullSwingProviderResponse): {
  readonly score: number | null;
  readonly breakdown: string;
  readonly applied: readonly AppliedAdjustment[];
  readonly raw_total: number | null;
} {
  // Unscored is decided by the declared inputs, never filled in: no start value or default.
  if (!provider.scorable) return { score: null, breakdown: provider.unscored_reason as string, applied: [], raw_total: null };
  const result = computeRubricScore(provider.outcomes);
  return { score: result.score, breakdown: result.breakdown, applied: result.applied, raw_total: result.raw_total };
}

/** Step 3: the canonical stored report and the internal assessment record. */
export function toCanonicalFullSwingReport(
  provider: FullSwingProviderResponse,
  scoring: ReturnType<typeof scoreFullSwing>,
): { readonly report: FullSwingReport; readonly assessment: RubricAssessment } {
  const declarations = declarationsOf(provider);
  const report: FullSwingReport = {
    scoring_breakdown: scoring.breakdown,
    score: scoring.score,
    executive_summary: provider.executive_summary,
    evidence_limits: provider.evidence_limits,
    evidence_coverage: coverageOf(declarations),
    // Server-derived: the rubric IDs the deficiencies are linked to, in order.
    fault_tags: provider.deficiencies.filter((d) => d.rubric_id !== null).map((d) => d.rubric_id as string),
    spine_angle: provider.spine_angle,
    hip_rotation: provider.hip_rotation,
    shoulder_rotation: provider.shoulder_rotation,
    tempo_ratio: provider.tempo_ratio,
    highlights: provider.highlights,
    deficiencies: provider.deficiencies.map((d) => ({ title: d.title, description: d.description })),
    drills: provider.drills,
    posture: provider.posture,
    swing_plane: provider.swing_plane,
    impact: provider.impact,
    practice_focus: provider.practice_focus,
    pro_cue: provider.pro_cue,
  };
  const assessment: RubricAssessment = {
    version: RUBRIC_ASSESSMENT_VERSION,
    provider_contract: FULL_SWING_PROVIDER_CONTRACT,
    rubric_version: RUBRIC_VERSION,
    policy: RUBRIC_POLICY,
    declarations: { camera_view: provider.camera_view, positions: provider.positions, detail_visibility: provider.detail_visibility },
    threshold_assessments: provider.threshold_assessments,
    findings: provider.outcomes,
    scorable_declared: provider.scorable,
    outcome: scoring.score === null ? "unscored" : "scored",
    applied: scoring.applied,
    raw_total: scoring.raw_total,
  };
  return { report, assessment };
}

/** Checks a parsed model response and returns the canonical report with its assessment. Never throws. */
export function validateFullSwingModelResponse(value: unknown): FullSwingValidation {
  const validated = validateFullSwingProviderResponse(value);
  if (!validated.ok) return validated;
  const { report, assessment } = toCanonicalFullSwingReport(validated.provider, scoreFullSwing(validated.provider));
  return { ok: true, report, assessment };
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
