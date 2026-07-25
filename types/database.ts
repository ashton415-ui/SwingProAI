// ─── Enums ───────────────────────────────────────────────────────────────────

export type UserRole = "golfer" | "coach" | "admin";
export type SubscriptionTier = "par" | "birdie" | "eagle" | "coach_starter" | "coach_pro" | "none";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "none";
export type SwingVideoStatus = "pending" | "uploaded" | "processing" | "complete" | "failed";
export type RelationshipStatus = "pending" | "active" | "declined" | "removed";
export type FeedbackPriority = "low" | "medium" | "high" | "critical";
export type LessonPlanStatus = "active" | "completed" | "archived";
export type ViewAngle = "face_on" | "down_the_line";

// ─── Equipment / Analysis-Routing Enums (EQ1-S1R — foundation only) ───────────
//
// analysis_mode = AI depth / subscription-driven model routing (basic /
//   advanced / ultra). Already live on swing_videos and swing_analysis.
// analysis_family = the mechanical analysis pipeline selected from the
//   validated club (full_swing / putting). A separate, orthogonal concept —
//   never renamed, repurposed, or conflated with analysis_mode.

export type ClubType = "Driver" | "Wood" | "Hybrid" | "Iron" | "Wedge" | "Putter";

export type AnalysisDepth = "basic" | "advanced" | "ultra";

export type AnalysisFamily = "full_swing" | "putting";

// ─── Coach Marketplace Enums (CM1 — foundation only) ──────────────────────────
// These types back an inactive, additive schema foundation (see
// supabase-schema-v6.sql). No route, page, or component uses them until a
// later phase, and every marketplace query path must be gated behind
// lib/feature-flags.ts:isCoachMarketplaceEnabled().

export type LessonDeliveryMode = "in_person" | "remote" | "hybrid";
export type MarketplaceVisibilityStatus = "hidden" | "draft" | "published" | "suspended";
export type CoachVerificationStatus = "unverified" | "pending" | "verified" | "rejected" | "suspended";
export type CoachBookingStatus =
  | "requested"
  | "accepted"
  | "declined"
  | "pending_payment"
  | "confirmed"
  | "completed"
  | "canceled_by_golfer"
  | "canceled_by_coach"
  | "no_show"
  | "refunded";
export type CoachReviewModerationStatus = "pending" | "approved" | "rejected" | "hidden";

// ─── Users ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  handicap_index: number | null;
  coach_profile_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
  created_at: string;
}

// ─── Coach Profiles ───────────────────────────────────────────────────────────

export interface CoachProfile {
  id: string;
  user_id: string;
  business_name: string | null;
  bio: string | null;
  specialties: string[] | null;
  certification: string | null;
  /**
   * Legacy/default informational rate only. Marketplace transaction pricing
   * lives exclusively on CoachService.price_amount_minor (integer minor
   * units) — hourly_rate is never the source of truth for a booking's price.
   */
  hourly_rate: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // ── Coach Marketplace fields (CM1 — foundation; see supabase-schema-v6.sql) ──
  public_slug: string | null;
  marketplace_headline: string | null;
  profile_photo_url: string | null;
  years_coaching: number | null;
  lesson_delivery_modes: LessonDeliveryMode[] | null;
  public_city: string | null;
  public_region: string | null;
  timezone: string | null;
  marketplace_visibility_status: MarketplaceVisibilityStatus;
  verification_status: CoachVerificationStatus;
  minimum_booking_notice_hours: number | null;
  cancellation_policy_summary: string | null;
  // joined
  user?: User;
}

// ─── Coach-Golfer Relationships ───────────────────────────────────────────────

export interface CoachGolferRelationship {
  id: string;
  coach_id: string;
  golfer_id: string;
  status: RelationshipStatus;
  invited_by: string | null;
  created_at: string;
  accepted_at: string | null;
  // joined
  coach?: User;
  golfer?: User;
}

// ─── Swing Videos ─────────────────────────────────────────────────────────────

export interface SwingVideo {
  id: string;
  user_id: string;
  title: string | null;
  video_url: string;
  storage_path: string | null;
  club: string | null;
  original_filename: string | null;
  file_size: number | null;
  mime_type: string | null;
  trim_start: number | null;
  trim_end: number | null;
  status: SwingVideoStatus;
  recorded_at: string | null;
  created_at: string;
  /** AI depth / subscription-driven model routing. Not the mechanical pipeline — see analysis_family. */
  analysis_mode: AnalysisDepth;
  requested_model: string | null;
  launch_monitor_attached: boolean;
  priority: number;
}

// ─── Swing Analysis ───────────────────────────────────────────────────────────

/** Swing checkpoint, kinematic order. Mirrors the FastAPI `Checkpoint` literal. */
export type SwingCheckpoint =
  | "address"
  | "takeaway"
  | "backswing"
  | "top"
  | "transition"
  | "downswing"
  | "impact"
  | "follow_through";

export type DeficiencySeverity = "minor" | "major";

/** Normalized (0..1) frame-space location of a joint, for overlay markers. */
export interface JointCoordinate {
  joint: string;
  x: number;
  y: number;
  frame_label?: string | null;
}

/** What the golfer is doing wrong — joint-specific, with severity + a fix. */
export interface DeficiencyItem {
  checkpoint: SwingCheckpoint;
  joint_coordinate: JointCoordinate;
  fault_description: string;
  severity: DeficiencySeverity;
  corrective_drill_title: string;
  corrective_drill_detail?: string | null;
}

/** What the golfer is doing right — reinforce good habits. */
export interface HighlightItem {
  checkpoint: SwingCheckpoint;
  positive_movement: string;
  mechanical_benefit: string;
}

export interface SwingAnalysis {
  id: string;
  swing_video_id: string;
  user_id: string;
  status: string;
  tempo_ratio: number | null;
  swing_speed_mph: number | null;
  score: number | null;
  feedback: string | null;
  metrics: Record<string, unknown> | null;
  // v4 granular telemetry (see supabase-schema-v4.sql)
  mechanical_deficiencies: DeficiencyItem[] | null;
  swing_highlights: HighlightItem[] | null;
  detailed_summary_html: string | null;
  created_at: string;
  /** AI depth / subscription-driven model routing. Not the mechanical pipeline — see analysis_family. */
  analysis_mode: AnalysisDepth | null;
  /** The mechanical analysis pipeline (full-swing vs. putting), database-derived from the validated club. Never client-supplied. */
  analysis_family: AnalysisFamily | null;
  model_used: string | null;
  /** References user_equipment.id (ON DELETE SET NULL). Null for analyses with no validated club selection. */
  club_id: string | null;
  telemetry_id: string | null;
  /** Database-owned, immutable after insert. See EquipmentSnapshotV1. */
  equipment_snapshot: EquipmentSnapshotV1 | null;
  putt_tempo_ratio: number | null;
  face_angle_at_impact_deg: number | null;
  path_deviation_mm: number | null;
  putt_analytics: Record<string, unknown> | null;
  putting_analysis: Record<string, unknown> | null;
  ai_equipment_recommendations: Record<string, unknown> | null;
  spine_angle: number | null;
  hip_rotation: number | null;
  shoulder_rotation: number | null;
  launch_monitor_summary: Record<string, unknown> | null;
  fusion_notes: string | null;
  // joined
  swing_video?: SwingVideo;
}

// ─── Equipment Intelligence (EQ1-S1R — foundation only) ───────────────────────
//
// Backs the additive, unapplied schema in
// supabase/migrations/<generated>_equipment_intelligence_putting_foundation.sql.
// EquipmentManufacturer/EquipmentModel are RLS-enabled with a single
// authenticated, active-only SELECT policy each — no browser write path.
// Model catalog population is EQ1-S2; no route, page, or component consumes
// these types yet.

export interface EquipmentManufacturer {
  id: string;
  canonical_name: string;
  slug: string;
  normalized_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EquipmentModel {
  id: string;
  manufacturer_id: string;
  club_type: ClubType;
  canonical_name: string;
  slug: string;
  normalized_name: string;
  model_year: number | null;
  specifications: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // joined
  manufacturer?: EquipmentManufacturer;
}

export interface UserEquipment {
  id: string;
  user_id: string;
  club_type: ClubType;
  /** Legacy/free-text brand. Coexists with manufacturer_id — never overwritten by catalog selection. */
  brand: string | null;
  /** Legacy/free-text model. Coexists with equipment_model_id — never overwritten by catalog selection. */
  model: string | null;
  shaft_flex: string | null;
  shaft_weight: number | null;
  loft_deg: number | null;
  custom_club: boolean;
  custom_brand: string | null;
  custom_model: string | null;
  custom_notes: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
  /** Nullable catalog reference. Database-validated (existence + active) via a before-insert/update trigger. */
  manufacturer_id: string | null;
  /** Nullable catalog reference. Must match manufacturer_id and club_type when present. */
  equipment_model_id: string | null;
  // joined
  manufacturer?: EquipmentManufacturer;
  equipment_model?: EquipmentModel;
}

/**
 * Database-owned snapshot written by a before-insert trigger on
 * swing_analysis and frozen thereafter. Deliberately excludes user identity,
 * freeform notes, video/storage references, and any billing/location data —
 * it must remain useful and privacy-safe after the live equipment row is
 * later edited or deleted.
 */
export interface EquipmentSnapshotV1 {
  schema_version: 1;
  captured_at: string;
  equipment_id: string;
  club_type: ClubType;
  manufacturer: { id: string; canonical_name: string; slug: string } | null;
  model: { id: string; canonical_name: string; slug: string; model_year: number | null } | null;
  entered_brand: string | null;
  entered_model: string | null;
  custom_club: boolean;
  custom_brand: string | null;
  custom_model: string | null;
  shaft_flex: string | null;
  shaft_weight_grams: number | null;
  loft_deg: number | null;
}

// ─── Coach Feedback ───────────────────────────────────────────────────────────

export interface CoachFeedback {
  id: string;
  swing_video_id: string;
  swing_analysis_id: string | null;
  coach_id: string;
  golfer_id: string;
  feedback: string;
  priority: FeedbackPriority | null;
  drills: string[];
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
  // joined
  coach?: User;
  swing_video?: SwingVideo;
}

// ─── Lesson Plans ─────────────────────────────────────────────────────────────

export interface LessonPlan {
  id: string;
  coach_id: string;
  golfer_id: string;
  title: string;
  description: string | null;
  goals: string[];
  drills: { name: string; description: string; reps?: string }[];
  due_date: string | null;
  status: LessonPlanStatus;
  created_at: string;
  updated_at: string;
  // joined
  coach?: User;
}

// ─── C# Inbound Payload ───────────────────────────────────────────────────────

export interface SwingTelemetryPayload {
  userId: string;
  captureTimestamp: string;
  viewAngle: ViewAngle;
  biomechanics: {
    spineAngleDegree: number;
    hipSwayInches: number;
    headDropFactor: number;
    tempoRatio: number;
  };
}

// ─── Coach Marketplace (CM1 — foundation) ──────────────────────────────────────
//
// Backs the additive, unapplied schema in supabase-schema-v6.sql. Every
// table above is RLS-enabled with zero policies (default-deny) and none of
// these types are consumed by any route, page, or component yet. Do not
// wire these into UI or data-fetching code without first gating the call
// site behind lib/feature-flags.ts:isCoachMarketplaceEnabled() and adding
// the operational RLS policies a later phase introduces.
//
// No Stripe Connect types are defined here — deferred to CM6.

export interface CoachService {
  id: string;
  coach_profile_id: string;
  title: string;
  description: string | null;
  delivery_mode: LessonDeliveryMode;
  duration_minutes: number;
  /** Integer minor currency units (e.g. USD cents). Never a decimal/float dollar amount. */
  price_amount_minor: number;
  /** ISO 4217 alphabetic code, exactly three uppercase letters (e.g. "USD"). */
  currency_code: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // joined
  coach_profile?: CoachProfile;
}

export interface CoachLocation {
  id: string;
  coach_profile_id: string;
  /** Internal-only label. Must never be rendered in any public UI. */
  private_location_name: string | null;
  public_location_label: string | null;
  city: string | null;
  region: string | null;
  /** Prefix only (e.g. "802") — never a full postal code tied to an exact address. */
  postal_code_prefix: string | null;
  /** Constrained to [-90, 90] at the database layer. Never rendered in public UI in CM1. */
  latitude: number | null;
  /** Constrained to [-180, 180] at the database layer. Never rendered in public UI in CM1. */
  longitude: number | null;
  service_radius_miles: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // joined
  coach_profile?: CoachProfile;
}

export interface CoachAvailabilityRule {
  id: string;
  coach_profile_id: string;
  /** 0 = Sunday .. 6 = Saturday. */
  day_of_week: number;
  local_start_time: string;
  local_end_time: string;
  timezone: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // joined
  coach_profile?: CoachProfile;
}

export interface CoachAvailabilityException {
  id: string;
  coach_profile_id: string;
  starts_at: string;
  ends_at: string;
  is_available_override: boolean;
  /** Internal-only note. Must never be part of any public view or UI. */
  internal_note: string | null;
  created_at: string;
  updated_at: string;
  // joined
  coach_profile?: CoachProfile;
}

export interface CoachBooking {
  id: string;
  golfer_id: string;
  coach_profile_id: string;
  service_id: string;
  location_id: string | null;
  scheduled_start_at: string;
  scheduled_end_at: string;
  timezone_snapshot: string;
  service_title_snapshot: string;
  duration_minutes_snapshot: number;
  /** Integer minor currency units, frozen at booking time. Never a decimal/float dollar amount. */
  gross_amount_minor_snapshot: number;
  currency_code_snapshot: string;
  delivery_mode_snapshot: LessonDeliveryMode;
  meeting_instructions: string | null;
  status: CoachBookingStatus;
  canceled_at: string | null;
  cancellation_reason_category: string | null;
  created_at: string;
  updated_at: string;
  // joined
  golfer?: User;
  coach_profile?: CoachProfile;
  service?: CoachService;
  location?: CoachLocation;
}

export interface CoachReview {
  id: string;
  booking_id: string;
  coach_profile_id: string;
  golfer_id: string;
  overall_rating: number;
  communication_rating: number | null;
  instruction_rating: number | null;
  professionalism_rating: number | null;
  value_rating: number | null;
  review_body: string | null;
  moderation_status: CoachReviewModerationStatus;
  coach_response: string | null;
  coach_responded_at: string | null;
  created_at: string;
  updated_at: string;
  // joined
  booking?: CoachBooking;
  coach_profile?: CoachProfile;
  golfer?: User;
}

/**
 * Approved-review-only rating read model (public.coach_rating_summary view).
 * Exposes ONLY these aggregate fields — never review_body, golfer identity,
 * coach location, coordinates, or internal notes. There is no
 * client-writable rating aggregate anywhere in this schema; this is always
 * derived, never stored on CoachProfile.
 */
export interface CoachRatingSummary {
  coach_profile_id: string;
  approved_review_count: number;
  overall_rating_average: number | null;
  communication_rating_average: number | null;
  instruction_rating_average: number | null;
  professionalism_rating_average: number | null;
  value_rating_average: number | null;
}
