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
  readonly metrics: {
    scoring_breakdown?: string;
    spine_angle?: number;
    hip_rotation?: number;
    shoulder_rotation?: number;
    spine_angle_deg?: number;
    hip_rotation_deg?: number;
    shoulder_rotation_deg?: number;
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
  readonly swing_highlights: readonly { checkpoint: string; positive_movement: string; mechanical_benefit: string }[];
  readonly mechanical_deficiencies: readonly {
    checkpoint: string;
    joint_coordinate: { joint: string } | string;
    fault_description: string;
    severity: "minor" | "major";
    corrective_drill_title: string;
    corrective_drill_detail: string | null;
  }[];
  readonly putting_analysis: PersistedPuttingAnalysisV1 | null;
  readonly putting_score: Record<string, unknown> | null;
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

export interface FullSwingCoachingV1 {
  readonly scoringBreakdown: string | null;
  readonly faultTags: string[];
  /** Legacy rows' tips, still shown on the web history. */
  readonly suggestions: string[];
  readonly strengths: { readonly checkpoint: string; readonly movement: string; readonly benefit: string }[];
  readonly improvementAreas: {
    readonly checkpoint: string;
    readonly joint: string | null;
    readonly description: string;
    readonly detailTitle: string;
    readonly detail: string | null;
    readonly severity: "minor" | "major";
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
  readonly score: number | null;
  readonly feedback: string | null;
  readonly measurements: {
    readonly tempoRatio: number | null;
    readonly swingSpeedMph: number | null;
    readonly spineAngle: number | null;
    readonly hipRotation: number | null;
    readonly shoulderRotation: number | null;
  };
  /** Core coaching for a full-swing analysis; null for a putt. */
  readonly coaching: FullSwingCoachingV1 | null;
  /** Putting result for a putt; null for full swing. */
  readonly putting: {
    readonly access: "available" | "locked";
    readonly analysis: PersistedPuttingAnalysisV1 | null;
    readonly strokeIndex: PuttingScorePresentationState | null;
  } | null;
}

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
        faultTags: [...(m.fault_tags ?? [])],
        suggestions: [...(m.suggestions ?? [])],
        strengths: view.swing_highlights.map((h) => ({
          checkpoint: h.checkpoint,
          movement: h.positive_movement,
          benefit: h.mechanical_benefit,
        })),
        improvementAreas: view.mechanical_deficiencies.map((d) => ({
          checkpoint: d.checkpoint,
          joint: typeof d.joint_coordinate === "string" ? d.joint_coordinate : d.joint_coordinate.joint || null,
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
    // Same precedence as the web history: the dedicated column, then the
    // current metrics key, then the legacy *_deg key.
    measurements: {
      tempoRatio: view.tempo_ratio,
      swingSpeedMph: view.swing_speed_mph,
      spineAngle: view.spine_angle ?? m.spine_angle ?? m.spine_angle_deg ?? null,
      hipRotation: view.hip_rotation ?? m.hip_rotation ?? m.hip_rotation_deg ?? null,
      shoulderRotation: view.shoulder_rotation ?? m.shoulder_rotation ?? m.shoulder_rotation_deg ?? null,
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
