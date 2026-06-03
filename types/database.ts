export type ViewAngle = "face_on" | "down_the_line";
export type SwingVideoStatus = "pending" | "uploaded" | "processing" | "complete" | "failed";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "none";
export type SubscriptionTier = "par" | "birdie" | "eagle" | "none";

// Matches actual public.users table
export interface User {
  id: string;
  email: string | null;
  full_name: string | null;
  handicap_index: number | null;
  stripe_customer_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
  created_at: string;
}

// Matches actual public.swing_videos table
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
  status: SwingVideoStatus;
  recorded_at: string | null;
  created_at: string;
}

// Matches actual public.swing_analysis table
export interface SwingAnalysis {
  id: string;
  swing_video_id: string;
  user_id: string;
  status: string;
  tempo_ratio: number | null;
  swing_speed_mph: number | null;
  score: number | null;
  feedback: string | null;
  metrics: Record<string, unknown> | null; // jsonb — biomechanics breakdown
  created_at: string;
  // joined relation
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
