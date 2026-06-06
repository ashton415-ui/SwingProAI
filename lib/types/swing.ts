/**
 * swingmaster-web/lib/types/swing.ts
 * v5 swing analysis types — equipment fitting and golf bag.
 * Core types (HighlightItem, DeficiencyItem, SubscriptionTier etc.)
 * live in @/types/database and should be imported from there.
 */

// ---------------------------------------------------------------------------
// Equipment fitting — returned by Gemini when launch data is present
// ---------------------------------------------------------------------------

export interface EquipmentFitting {
  recommended_shaft_flex: string;
  shaft_reasoning: string;
  suggested_club_specs: string;
  compression_match_notes: string;
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
// analysis_v2 jsonb shape (stored in swing_analysis.analysis_v2)
// ---------------------------------------------------------------------------

export type SkillRating = 'beginner' | 'intermediate' | 'advanced' | 'tour-level';

export interface SwingAnalysisV2 {
  executive_summary: string;
  swing_plane_analysis: string;
  kinematic_sequence_notes: string;
  swing_highlights: import('@/types/database').HighlightItem[];
  mechanical_deficiencies: import('@/types/database').DeficiencyItem[];
  putt_analytics: PuttAnalytics | null;
  equipment_fitting: EquipmentFitting | null;
  overall_skill_rating: SkillRating;
  priority_focus_area: string;
}

export interface PuttAnalytics {
  stroke_path_deviation: string;
  face_angle_at_impact: string;
  tempo_ratio_text: string;
  dynamic_loft: string;
}
