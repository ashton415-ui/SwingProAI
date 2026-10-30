import { getHistoricalEquipmentDisplayName } from "@/lib/equipment/historical-equipment-display-name";
import type { PersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";
import {
  resolvePuttingScorePresentation,
  type PuttingScorePresentationState,
} from "@/lib/putting-score-presentation-eq5f-f";

/**
 * GET /api/v1/analyses/{id} — the native result contract (ENT-1C).
 *
 * A pure mapper from the authorized view the result-read authority returns
 * (`AnalysisResultView`) to the camelCase V1 shape. Every field is named here;
 * nothing is spread, so a column or jsonb key added later cannot reach a
 * native client without someone editing this file. The input has already been
 * ownership-proved, entitlement-checked and item-level allow-listed.
 *
 * The view type is mirrored structurally rather than imported, so this module
 * stays free of the server-only authority and can be tested on its own.
 */

interface ResultViewInput {
  readonly id: string;
  readonly swing_video_id: string | null;
  readonly status: string;
  readonly analysis_family: "full_swing" | "putting" | null;
  readonly equipment_snapshot: unknown;
  readonly created_at: string | null;
  readonly score: number | null;
  readonly feedback: string | null;
  readonly tempo_ratio: number | null;
  readonly swing_speed_mph: number | null;
  readonly spine_angle: number | null;
  readonly hip_rotation: number | null;
  readonly shoulder_rotation: number | null;
  readonly full_swing_metrics: Readonly<
    Record<"spine_angle" | "hip_rotation" | "shoulder_rotation" | "tempo_ratio", EstimateInput>
  > | null;
  readonly metrics: {
    scoring_breakdown?: string;
    evidence_limits?: string;
    suggestions?: string[];
    fault_tags?: string[];
    drills?: { name: string; the_why: string; the_how: string; the_feel: string }[];
    posture?: PillarInput | null;
    swing_plane?: PillarInput | null;
    impact?: PillarInput | null;
    practice_focus?: string;
    pro_cue?: string;
    the_feel?: string;
  } | null;
  readonly swing_highlights: readonly { checkpoint: string | null; positive_movement: string; mechanical_benefit: string }[];
  readonly mechanical_deficiencies: readonly {
    checkpoint: string | null;
    joint_coordinate: { joint: string } | string | null;
    fault_description: string;
    severity: "minor" | "major" | null;
    corrective_drill_title: string;
    corrective_drill_detail: string | null;
  }[];
  readonly putting_analysis: PersistedPuttingAnalysisV1 | null;
  readonly putting_score: Record<string, unknown> | null;
}

interface EstimateInput {
  readonly value: number | string | null;
  readonly source: "ai_video_estimate" | "unrecorded";
  readonly client_unverified_estimate: number | string | null;
}

interface PillarInput {
  readonly rating: string;
  readonly observation: string;
  readonly correction: string;
}

export interface AnalysisPillarV1 {
  readonly rating: string;
  readonly observation: string;
  readonly correction: string;
}

/**
 * S6-R1. One full-swing estimate with its source. `value` is null when it is
 * unavailable (zero is a value). `source` "ai_video_estimate" is the model's
 * own value from the video; "unrecorded" is a row written before sources were
 * recorded. A client-supplied estimate (its origin cannot be verified) is a
 * separate, unverified entry.
 */
export interface SwingEstimateV1 {
  readonly value: number | string | null;
  readonly source: "ai_video_estimate" | "unrecorded";
  readonly clientUnverifiedEstimate: number | string | null;
}

export interface FullSwingCoachingV1 {
  readonly scoringBreakdown: string | null;
  /** What the video did not let the model judge. */
  readonly evidenceLimits: string | null;
  readonly faultTags: string[];
  /** Legacy rows' tips, still shown on the web history. */
  readonly suggestions: string[];
  /** S6-R1A: checkpoint, joint and severity are null when not assessed. */
  readonly strengths: { readonly checkpoint: string | null; readonly movement: string; readonly benefit: string }[];
  readonly improvementAreas: {
    readonly checkpoint: string | null;
    readonly joint: string | null;
    readonly description: string;
    readonly detailTitle: string;
    readonly detail: string | null;
    readonly severity: "minor" | "major" | null;
  }[];
  readonly drills: { readonly name: string; readonly why: string; readonly how: string; readonly feel: string }[];
  readonly posture: AnalysisPillarV1 | null;
  readonly swingPlane: AnalysisPillarV1 | null;
  readonly impact: AnalysisPillarV1 | null;
  readonly practiceFocus: string | null;
  readonly proCue: string | null;
  readonly feel: string | null;
}

export interface AnalysisResultV1 {
  readonly analysisId: string;
  readonly swingVideoId: string | null;
  readonly status: string;
  readonly analysisFamily: "full_swing" | "putting" | null;
  readonly createdAt: string | null;
  readonly clubDisplayName: string | null;
  /** An AI rubric score; null when the analysis could not be scored (never 0 as a default). */
  readonly score: number | null;
  readonly feedback: string | null;
  /**
   * Instrument-measured values. The keys are kept for compatibility, but no
   * instrument producer exists: every value is null. The swing values that used
   * to appear here were estimates and are now served, with their source, in
   * `estimates`. A stored legacy swing speed is not proven to be measured, so it
   * is not returned here either (S6-R1A).
   */
  readonly measurements: {
    readonly tempoRatio: null;
    readonly swingSpeedMph: null;
    readonly spineAngle: null;
    readonly hipRotation: null;
    readonly shoulderRotation: null;
  };
  /** S6-R1. Full-swing estimates with their sources; null for a putt. */
  readonly estimates: {
    readonly spineAngle: SwingEstimateV1;
    readonly hipRotation: SwingEstimateV1;
    readonly shoulderRotation: SwingEstimateV1;
    readonly tempoRatio: SwingEstimateV1;
  } | null;
  /** Core coaching for a full-swing analysis; null for a putt. */
  readonly coaching: FullSwingCoachingV1 | null;
  /** Putting result for a putt; null for full swing. */
  readonly putting: {
    readonly access: "available" | "locked";
    readonly analysis: PersistedPuttingAnalysisV1 | null;
    readonly strokeIndex: PuttingScorePresentationState | null;
  } | null;
}

const estimate = (value: EstimateInput): SwingEstimateV1 => ({
  value: value.value,
  source: value.source,
  clientUnverifiedEstimate: value.client_unverified_estimate,
});

const pillar = (value: PillarInput | null | undefined): AnalysisPillarV1 | null =>
  value ? { rating: value.rating, observation: value.observation, correction: value.correction } : null;

export function toAnalysisResultV1(
  view: ResultViewInput,
  access: { readonly puttingAnalysis: boolean },
): AnalysisResultV1 {
  const isPutt = view.analysis_family === "putting";
  const m = view.metrics ?? {};

  const coaching: FullSwingCoachingV1 | null = isPutt
    ? null
    : {
        scoringBreakdown: m.scoring_breakdown ?? null,
        evidenceLimits: m.evidence_limits ?? null,
        faultTags: [...(m.fault_tags ?? [])],
        suggestions: [...(m.suggestions ?? [])],
        strengths: view.swing_highlights.map((h) => ({
          checkpoint: h.checkpoint,
          movement: h.positive_movement,
          benefit: h.mechanical_benefit,
        })),
        improvementAreas: view.mechanical_deficiencies.map((d) => ({
          checkpoint: d.checkpoint,
          joint:
            d.joint_coordinate === null
              ? null
              : typeof d.joint_coordinate === "string"
                ? d.joint_coordinate
                : d.joint_coordinate.joint || null,
          description: d.fault_description,
          detailTitle: d.corrective_drill_title,
          detail: d.corrective_drill_detail,
          severity: d.severity,
        })),
        drills: (m.drills ?? []).map((d) => ({ name: d.name, why: d.the_why, how: d.the_how, feel: d.the_feel })),
        posture: pillar(m.posture),
        swingPlane: pillar(m.swing_plane),
        impact: pillar(m.impact),
        practiceFocus: m.practice_focus ?? null,
        proCue: m.pro_cue ?? null,
        feel: m.the_feel ?? null,
      };

  return {
    analysisId: view.id,
    swingVideoId: view.swing_video_id,
    status: view.status,
    analysisFamily: view.analysis_family,
    createdAt: view.created_at,
    clubDisplayName: getHistoricalEquipmentDisplayName(view.equipment_snapshot),
    score: view.score,
    feedback: view.feedback,
    measurements: {
      tempoRatio: null,
      swingSpeedMph: null,
      spineAngle: null,
      hipRotation: null,
      shoulderRotation: null,
    },
    // S6-R1. Value and source from the read authority's full_swing_metrics,
    // the same values the web surfaces present. Not measurements.
    estimates:
      isPutt || view.full_swing_metrics === null
        ? null
        : {
            spineAngle: estimate(view.full_swing_metrics.spine_angle),
            hipRotation: estimate(view.full_swing_metrics.hip_rotation),
            shoulderRotation: estimate(view.full_swing_metrics.shoulder_rotation),
            tempoRatio: estimate(view.full_swing_metrics.tempo_ratio),
          },
    coaching,
    // As on the web page: a result is shown only for a completed analysis, so
    // an envelope left on a failed or re-running row is never presented.
    putting: isPutt
      ? {
          access: access.puttingAnalysis ? "available" : "locked",
          analysis: access.puttingAnalysis && view.status === "complete" ? view.putting_analysis : null,
          strokeIndex:
            access.puttingAnalysis && view.status === "complete"
              ? resolvePuttingScorePresentation(view.putting_score)
              : null,
        }
      : null,
  };
}
