export type ViewAngle = "face_on" | "down_the_line";
export type SwingStatus = "pending" | "processing" | "complete" | "failed";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "none";
export type SubscriptionTier = "par" | "birdie" | "eagle" | "none";

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  stripe_customer_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
  created_at: string;
  updated_at: string;
}

export interface SwingVideo {
  id: string;
  user_id: string;
  storage_path: string;
  duration_sec: number | null;
  club_type: string | null;
  status: SwingStatus;
  created_at: string;
}

export interface SwingAnalysis {
  id: string;
  swing_video_id: string;
  user_id: string;
  hip_rotation_deg: number | null;
  shoulder_rotation_deg: number | null;
  spine_angle_deg: number | null;
  wrist_hinge_deg: number | null;
  tempo_ratio: number | null;
  swing_plane_deg: number | null;
  summary: string | null;
  suggestions: string[] | null;
  raw_result: Record<string, unknown> | null;
  created_at: string;
  // joined
  swing_video?: SwingVideo;
}

// C# inbound payload shape (mirrors SwingTelemetryPayload.cs)
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
