// ============================================================================
// Server-authoritative full-swing scoring rubric (local candidate, P1 provisional)
// ============================================================================
//
// The full-swing score is computed here, never written by the model. The model
// reports declarations (camera view, which positions and details the video
// shows), its own approximate estimates, whether each threshold measure could
// be assessed and on what visible basis, and an observed / not observed / not
// assessable finding for each qualitative item. This module turns those into
// item outcomes, applies the rubric's existing points and writes the
// arithmetic.
//
// Status of the table: ENGINEERING DRAFT, NOT COACH-REVIEWED, NOT VALIDATED.
// The 17 item IDs, points and thresholds are the rubric's existing ones; the
// view, detail and position requirements are a provisional engineering draft
// accepted only for this local candidate (owner decision D-VIEW). Items whose
// rule is not completely defined are QUARANTINED: always not assessable, no
// points, no rubric-linked coaching.
//
// What this module can and cannot do: it enforces arithmetic, the item set,
// points, clamp and "larger of" rule, and consistency with what the model
// declared. It cannot establish that any declaration, estimate or finding is
// true, or which frames the provider sampled.

export const RUBRIC_VERSION = "fs-rubric-1-draft-not-coach-reviewed" as const;
export const RUBRIC_POLICY = "P1-provisional" as const;
export const RUBRIC_START = 75;
export const RUBRIC_SCORE_FLOOR = 55;
export const RUBRIC_SCORE_CEILING = 99;

export const CAMERA_VIEWS = ["face_on", "down_the_line", "other", "unclear"] as const;
export type CameraView = (typeof CAMERA_VIEWS)[number];
/** Views a rubric item can be assessed from; "other" and "unclear" never qualify. */
export type AssessableView = "face_on" | "down_the_line";

/** Swing events in the order they occur. Address is not the takeaway start. */
export const SWING_POSITIONS = ["address", "takeaway_start", "top_of_backswing", "early_downswing", "impact"] as const;
export type SwingPosition = (typeof SWING_POSITIONS)[number];
export const POSITION_VISIBILITY = ["yes", "no", "unclear"] as const;
export type PositionVisibility = (typeof POSITION_VISIBILITY)[number];

export const SWING_DETAILS = [
  "shoulders", "pelvis", "spine_line", "lead_wrist", "hands_grip", "club_shaft", "clubface", "target_reference",
] as const;
export type SwingDetail = (typeof SWING_DETAILS)[number];
export const DETAIL_VISIBILITY = ["visible", "not_visible", "unclear"] as const;
export type DetailVisibility = (typeof DETAIL_VISIBILITY)[number];

export const FINDING_STATUSES = ["observed", "not_observed", "not_assessable"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Measures the server compares against the rubric's numeric conditions. The model never sees the cutoffs. */
export const THRESHOLD_MEASURES = ["shoulder_turn_at_top", "hip_turn_at_impact"] as const;
export type ThresholdMeasure = (typeof THRESHOLD_MEASURES)[number];

export interface MeasureDefinition {
  /** The AI estimate field the measure reads (degrees). */
  readonly estimate: "shoulder_rotation" | "hip_rotation";
  readonly views: readonly AssessableView[];
  readonly details: readonly SwingDetail[];
  readonly positions: readonly SwingPosition[];
}

export const MEASURES: Readonly<Record<ThresholdMeasure, MeasureDefinition>> = {
  shoulder_turn_at_top: { estimate: "shoulder_rotation", views: ["face_on", "down_the_line"], details: ["shoulders"], positions: ["top_of_backswing"] },
  hip_turn_at_impact: { estimate: "hip_rotation", views: ["face_on"], details: ["pelvis"], positions: ["impact"] },
};

interface ItemBase {
  readonly id: string;
  readonly label: string;
  readonly points: number;
  /** Items describing the same issue: only the larger-magnitude applied adjustment counts. */
  readonly issue: string;
}
export interface QualitativeItem extends ItemBase {
  readonly kind: "qualitative";
  readonly views: readonly AssessableView[];
  readonly details: readonly SwingDetail[];
  readonly positions: readonly SwingPosition[];
}
export interface ThresholdItem extends ItemBase {
  readonly kind: "threshold";
  readonly measure: ThresholdMeasure;
  /** The rubric's existing numeric condition on the AI estimate, applied by the server only. */
  readonly applies: (estimate: number) => boolean;
}
export interface QuarantinedItem extends ItemBase {
  readonly kind: "quarantined";
  readonly reason: string;
}
export type RubricItem = QualitativeItem | ThresholdItem | QuarantinedItem;

export const RUBRIC_ITEMS: readonly RubricItem[] = [
  { id: "shoulder_turn_full", label: "Shoulder rotation", points: 5, issue: "shoulder_turn", kind: "threshold", measure: "shoulder_turn_at_top", applies: (v) => v >= 90 },
  { id: "hip_turn_impact", label: "Hip rotation at impact", points: 5, issue: "hip_turn", kind: "threshold", measure: "hip_turn_at_impact", applies: (v) => v >= 45 },
  { id: "x_factor", label: "X-Factor", points: 5, issue: "x_factor", kind: "quarantined",
    reason: "The only inputs are a shoulder estimate at the top and a hip estimate at impact; their difference is not a same-phase separation, and no same-phase inputs are collected." },
  { id: "tempo_ratio_ideal", label: "Tempo ratio", points: 3, issue: "tempo", kind: "quarantined",
    reason: "The request sends the video at the provider's documented default sampling (1 frame per second); sub-second takeaway, top and impact timing cannot be represented or verified from it." },
  { id: "spine_maintained", label: "Spine angle maintained", points: 3, issue: "spine_change", kind: "quarantined",
    reason: "One spine_angle estimate cannot represent a setup-to-impact change; no paired setup and impact inputs are collected." },
  { id: "early_extension_severe", label: "Severe early extension", points: -8, issue: "spine_change", kind: "quarantined",
    reason: "One spine_angle estimate cannot represent a setup-to-impact change; no paired setup and impact inputs are collected." },
  { id: "early_extension_moderate", label: "Moderate early extension", points: -5, issue: "spine_change", kind: "quarantined",
    reason: "One spine_angle estimate cannot represent a setup-to-impact change; no paired setup and impact inputs are collected." },
  { id: "restricted_backswing_severe", label: "Severely restricted backswing", points: -8, issue: "shoulder_turn", kind: "threshold", measure: "shoulder_turn_at_top", applies: (v) => v < 70 },
  { id: "restricted_backswing_moderate", label: "Moderately restricted backswing", points: -5, issue: "shoulder_turn", kind: "threshold", measure: "shoulder_turn_at_top", applies: (v) => v >= 70 && v <= 80 },
  { id: "body_block_severe", label: "Severe body block", points: -8, issue: "hip_turn", kind: "threshold", measure: "hip_turn_at_impact", applies: (v) => v < 30 },
  { id: "body_block_moderate", label: "Moderate body block", points: -5, issue: "hip_turn", kind: "threshold", measure: "hip_turn_at_impact", applies: (v) => v >= 30 && v <= 40 },
  { id: "laid_off_p4", label: "Laid-off club at P4", points: -3, issue: "laid_off", kind: "qualitative",
    views: ["down_the_line"], details: ["club_shaft", "target_reference"], positions: ["top_of_backswing"] },
  { id: "over_the_top", label: "Over-the-top downswing path", points: -5, issue: "over_the_top", kind: "qualitative",
    views: ["down_the_line"], details: ["club_shaft", "target_reference"], positions: ["top_of_backswing", "early_downswing"] },
  { id: "casting_early_release", label: "Casting / early release", points: -5, issue: "tempo", kind: "quarantined",
    reason: "The rubric defines a release fault by tempo ratio; the tempo-versus-release definition is an unresolved domain decision (D-CAST)." },
  { id: "cupped_lead_wrist_top", label: "Cupped lead wrist at top", points: -3, issue: "lead_wrist", kind: "qualitative",
    views: ["face_on", "down_the_line"], details: ["lead_wrist", "hands_grip"], positions: ["top_of_backswing"] },
  { id: "reverse_pivot", label: "Reverse pivot", points: -8, issue: "pivot", kind: "qualitative",
    views: ["face_on"], details: ["shoulders", "pelvis"], positions: ["address", "top_of_backswing"] },
  { id: "minor_alignment_or_grip", label: "Minor alignment or grip issue", points: -2, issue: "alignment_grip", kind: "quarantined",
    reason: "A compound item: alignment and grip need different visible detail and meaning; the split/keep/remove decision is unresolved (D-ALIGN)." },
];

export const RUBRIC_ITEM_IDS = RUBRIC_ITEMS.map((item) => item.id);
export const QUALITATIVE_ITEM_IDS = RUBRIC_ITEMS.filter((item) => item.kind === "qualitative").map((item) => item.id);
export const rubricItem = (id: string): RubricItem | undefined => RUBRIC_ITEMS.find((item) => item.id === id);

// ── Declarations and inputs (validated by lib/full-swing-analysis-contract.ts) ──

export interface RubricDeclarations {
  readonly camera_view: CameraView;
  readonly positions: Readonly<Record<SwingPosition, PositionVisibility>>;
  readonly detail_visibility: Readonly<Record<SwingDetail, DetailVisibility>>;
}

export interface RubricInputs {
  readonly declarations: RubricDeclarations;
  readonly estimates: { readonly shoulder_rotation: number | null; readonly hip_rotation: number | null };
  readonly thresholdAssessable: Readonly<Record<ThresholdMeasure, boolean>>;
  /** Qualitative findings by item ID (validated: exactly the qualitative IDs). */
  readonly qualitative: Readonly<Record<string, FindingStatus>>;
}

/** Why a requirement is not met by the declarations, or null when it is. */
export function requirementGap(
  declarations: RubricDeclarations,
  requirement: { readonly views: readonly AssessableView[]; readonly details: readonly SwingDetail[]; readonly positions: readonly SwingPosition[] },
): "view" | "detail" | "position" | null {
  if (!(requirement.views as readonly string[]).includes(declarations.camera_view)) return "view";
  if (requirement.details.some((detail) => declarations.detail_visibility[detail] !== "visible")) return "detail";
  if (requirement.positions.some((position) => declarations.positions[position] !== "yes")) return "position";
  return null;
}

export interface ItemOutcome {
  readonly id: string;
  readonly status: FindingStatus;
  readonly source: "qualitative" | "threshold" | "quarantined";
}

/**
 * Item outcomes from validated inputs. Threshold outcomes are derived here from
 * the estimate when the measure was declared assessable; quarantined items are
 * always not assessable.
 */
export function rubricOutcomes(inputs: RubricInputs): ItemOutcome[] {
  return RUBRIC_ITEMS.map((item): ItemOutcome => {
    if (item.kind === "quarantined") return { id: item.id, status: "not_assessable", source: "quarantined" };
    if (item.kind === "qualitative") return { id: item.id, status: inputs.qualitative[item.id], source: "qualitative" };
    const estimate = inputs.estimates[MEASURES[item.measure].estimate];
    if (!inputs.thresholdAssessable[item.measure] || estimate === null) {
      return { id: item.id, status: "not_assessable", source: "threshold" };
    }
    return { id: item.id, status: item.applies(estimate) ? "observed" : "not_observed", source: "threshold" };
  });
}

export interface AppliedAdjustment {
  readonly id: string;
  readonly label: string;
  readonly points: number;
}

export interface RubricScore {
  readonly score: number;
  readonly breakdown: string;
  readonly applied: readonly AppliedAdjustment[];
  readonly raw_total: number;
}

/**
 * The score from item outcomes: the start value plus each applied adjustment,
 * one per issue (the larger magnitude where an issue has several), clamped to
 * 55-99. 75 is a result only when assessed items earned no adjustment; a caller
 * must never use this to fill in for missing evidence (it requires at least one
 * assessable item).
 */
export function computeRubricScore(outcomes: readonly ItemOutcome[]): RubricScore {
  if (!outcomes.some((o) => o.status !== "not_assessable")) {
    throw new Error("computeRubricScore requires at least one assessable item");
  }
  const byIssue = new Map<string, AppliedAdjustment>();
  for (const item of RUBRIC_ITEMS) {
    const outcome = outcomes.find((o) => o.id === item.id);
    if (outcome?.status !== "observed" || item.kind === "quarantined") continue;
    const current = byIssue.get(item.issue);
    if (!current || Math.abs(item.points) > Math.abs(current.points)) {
      byIssue.set(item.issue, { id: item.id, label: item.label, points: item.points });
    }
  }
  const applied = RUBRIC_ITEMS.map((item) => byIssue.get(item.issue)).filter(
    (a, i, all): a is AppliedAdjustment => a !== undefined && all.indexOf(a) === i,
  );
  const raw = applied.reduce((sum, a) => sum + a.points, RUBRIC_START);
  const score = Math.min(RUBRIC_SCORE_CEILING, Math.max(RUBRIC_SCORE_FLOOR, raw));
  const terms = applied.map((a) => `${a.points > 0 ? "+" : "-"} ${Math.abs(a.points)} (${a.label})`);
  const arithmetic = terms.length === 0 ? `${RUBRIC_START} (no rubric adjustments applied) = ${raw}` : `${RUBRIC_START} ${terms.join(" ")} = ${raw}`;
  const breakdown = score === raw ? arithmetic : `${arithmetic}, clamped to ${score}`;
  return { score, breakdown, applied, raw_total: raw };
}
