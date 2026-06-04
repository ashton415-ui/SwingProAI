// ─── Enums ───────────────────────────────────────────────────────────────────

export type UserRole = "golfer" | "coach" | "admin";
export type SubscriptionTier = "par" | "birdie" | "eagle" | "coach_starter" | "coach_pro" | "none";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "none";
export type SwingVideoStatus = "pending" | "uploaded" | "processing" | "complete" | "failed";
export type RelationshipStatus = "pending" | "active" | "declined" | "removed";
export type FeedbackPriority = "low" | "medium" | "high" | "critical";
export type LessonPlanStatus = "active" | "completed" | "archived";
export type ViewAngle = "face_on" | "down_the_line";

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
  hourly_rate: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
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
}

// ─── Swing Analysis ───────────────────────────────────────────────────────────

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
  created_at: string;
  // joined
  swing_video?: SwingVideo;
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
