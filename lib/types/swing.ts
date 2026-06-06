/**
 * swingmaster-web/lib/types/swing.ts
 * TypeScript types mirroring ai-backend/schemas.py exactly.
 * Single source of truth for all swing analysis data structures.
 */

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

export interface HighlightItem {
  checkpoint: string;
  positive_movement: string;
  mechanical_benefit: string;
}

export interface DeficiencyItem {
  checkpoint: string;
  joint_coordinate: string;
  fault_description: string;
  severity: 'minor' | 'major';
  corrective_drill_title: string;
}

export interface PuttAnalytics {
  stroke_path_deviation: string;
  face_angle_at_impact: string;
  tempo_ratio_text: string;
  dynamic_loft: string;
}

export interface EquipmentFitting {
  recommended_shaft_flex: string;
  shaft_reasoning: string;
  suggested_club_specs: string;
  compression_match_notes: string;
}

// ---------------------------------------------------------------------------
// Root analysis response
// ---------------------------------------------------------------------------

export type SkillRating = 'beginner' | 'intermediate' | 'advanced' | 'tour-level';
export type SwingCategory = 'full_swing' | 'putt' | 'chip' | 'pitch' | 'bunker';

export interface SwingAnalysisV2 {
  executive_summary: string;
  swing_plane_analysis: string;
  kinematic_sequence_notes: string;
  swing_highlights: HighlightItem[];
  mechanical_deficiencies: DeficiencyItem[];
  putt_analytics: PuttAnalytics | null;
  equipment_fitting: EquipmentFitting | null;
  overall_skill_rating: SkillRating;
  priority_focus_area: string;
}

// ---------------------------------------------------------------------------
// DB row shape (from swing_analyses table)
// ---------------------------------------------------------------------------

export interface SwingAnalysisRow {
  id: string;
  user_id: string;
  video_url: string | null;
  swing_category: SwingCategory | null;
  created_at: string;
  analysis_v2: SwingAnalysisV2 | null;
}

// ---------------------------------------------------------------------------
// Golf bag types (from user_golf_bag table)
// ---------------------------------------------------------------------------

export type ShaftFlex = 'L' | 'A' | 'R' | 'SR' | 'S' | 'X';

export interface GolfBag {
  id: string;
  user_id: string;
  club_brand: string | null;
  club_model: string | null;
  club_loft_deg: number | null;
  shaft_brand: string | null;
  shaft_model: string | null;
  shaft_flex: ShaftFlex | null;
  shaft_weight_g: number | null;
  grip_model: string | null;
  swing_speed_mph: number | null;
  ball_speed_mph: number | null;
  smash_factor: number | null;
  spin_rate_rpm: number | null;
  launch_angle_deg: number | null;
  carry_yards: number | null;
  created_at: string;
  updated_at: string;
}

export type GolfBagUpsert = Omit<GolfBag, 'id' | 'user_id' | 'created_at' | 'updated_at'>;

// ---------------------------------------------------------------------------
// Stripe entitlement tiers
// ---------------------------------------------------------------------------

export type PlanTier = 'par' | 'birdie' | 'eagle';

export interface UserEntitlement {
  tier: PlanTier;
  /** True if tier is birdie or eagle */
  hasEquipmentFitting: boolean;
  /** True if tier is eagle */
  hasAdvancedAnalytics: boolean;
}

export function resolveTier(stripePlan: string | null | undefined): PlanTier {
  if (!stripePlan) return 'par';
  const p = stripePlan.toLowerCase();
  if (p.includes('eagle')) return 'eagle';
  if (p.includes('birdie')) return 'birdie';
  return 'par';
}

export function getEntitlement(tier: PlanTier): UserEntitlement {
  return {
    tier,
    hasEquipmentFitting: tier === 'birdie' || tier === 'eagle',
    hasAdvancedAnalytics: tier === 'eagle',
  };
}
