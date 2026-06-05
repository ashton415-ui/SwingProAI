import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";

// Allow up to 120s — video analysis with Gemini takes 20-60s
export const maxDuration = 120;

import {
  getAnalysisModeForTier,
  type SubscriptionTier,
  type AnalysisMode,
} from "@/lib/entitlements";
import { sanitizeAnalysisHtml } from "@/lib/sanitize-html";
import type { DeficiencyItem, HighlightItem } from "@/types/database";

// ─── Shape returned by the FastAPI biomechanics backend ─────────────────────────
interface BackendMetricSummary {
  swing_speed_mph: number | null;
  ball_speed_mph: number | null;
  launch_angle_deg: number | null;
  smash_factor: number | null;
  spine_angle_deg: number | null;
  hip_rotation_deg: number | null;
  shoulder_rotation_deg: number | null;
  x_factor_deg: number | null;
  wrist_hinge_deg: number | null;
  tempo_ratio: number | null;
  head_stability: string | null;
}
interface BackendAnalysis {
  score: number;
  overall_feedback: string;
  metric_summary: BackendMetricSummary;
  swing_highlights: HighlightItem[];
  mechanical_deficiencies: DeficiencyItem[];
  prose_summary: { headline: string; html: string };
  model_used?: string;
  analysis_mode?: string;
}

function resolveMode(tier: SubscriptionTier, isAdvanced: boolean): AnalysisMode {
  if (tier === "eagle" || tier === "coach_pro") return "ultra";
  if (tier === "birdie" || tier === "coach_starter") return "advanced";
  // isAdvanced from the UI can never elevate a basic tier beyond what it owns.
  return isAdvanced ? "basic" : "basic";
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { videoData, mimeType, isAdvanced, swingVideoId, userContext } = await req.json();
  if (!videoData || !mimeType) {
    return NextResponse.json({ error: "Missing videoData or mimeType" }, { status: 400 });
  }

  // Size check — Gemini inline_data limit ~18MB decoded
  const estimatedMB = ((videoData.length / 4) * 3) / (1024 * 1024);
  if (estimatedMB > 18) {
    return NextResponse.json(
      { error: `Clip too large (${estimatedMB.toFixed(1)} MB). Trim to under 10 seconds.` },
      { status: 413 }
    );
  }

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("subscription_tier")
    .eq("id", session.user.id)
    .single();

  const tier = (profile?.subscription_tier ?? "par") as SubscriptionTier;
  const analysisMode = resolveMode(tier, Boolean(isAdvanced));

  // ── Basic tier: cheap mock, no model call. Includes the new fields (empty). ──
  if (analysisMode === "basic") {
    const mockResult = {
      feedback:
        "Your swing shows good fundamentals. Focus on maintaining consistent tempo and follow-through. Upgrade to Birdie for full AI biomechanical analysis.",
      score: 65,
      weakSpots: ["Tempo inconsistency", "Follow-through position"],
      drills: [
        {
          name: "Tempo Trainer",
          why: "Builds consistent rhythm",
          how: "Count 1-2-3 on backswing, 1 on downswing",
          feel: "Like a pendulum, smooth and controlled",
          videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        },
      ],
      metrics: { swingSpeed: 85, ballSpeed: 120, launchAngle: 12, smashFactor: 1.41 },
      swing_highlights: [] as HighlightItem[],
      mechanical_deficiencies: [] as DeficiencyItem[],
      detailed_summary_html: null as string | null,
      _tier: tier,
      _mode: "basic" as const,
      _upgradeMessage:
        "Upgrade to Birdie to unlock the full AI biomechanical audit with joint-specific deficiencies and fix drills.",
    };

    if (swingVideoId) {
      await supabase
        .from("swing_videos")
        .update({ analysis_mode: "basic", requested_model: "local-basic" })
        .eq("id", swingVideoId)
        .eq("user_id", session.user.id);
    }
    return NextResponse.json(mockResult);
  }

  // ── Paid tiers: forward to the Python FastAPI biomechanics backend. ──
  const backendUrl = process.env.AI_BACKEND_URL;
  if (!backendUrl) {
    return NextResponse.json({ error: "AI backend not configured" }, { status: 503 });
  }

  try {
    const backendRes = await fetch(`${backendUrl.replace(/\/$/, "")}/api/v1/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Service-to-service shared secret (see ai-backend AI_BACKEND_SECRET).
        ...(process.env.AI_BACKEND_SECRET
          ? { "X-Internal-Secret": process.env.AI_BACKEND_SECRET }
          : {}),
      },
      body: JSON.stringify({
        video_base64: videoData,
        mime_type: mimeType,
        analysis_mode: analysisMode,
        user_context: userContext ?? null,
      }),
    });

    if (!backendRes.ok) {
      const detail = await backendRes.text().catch(() => "");
      console.error("AI backend error:", backendRes.status, detail.slice(0, 200));
      return NextResponse.json(
        { error: `AI analysis failed (${backendRes.status})`, detail: detail.slice(0, 200) },
        { status: 502 }
      );
    }

    const envelope = (await backendRes.json()) as { data: BackendAnalysis };
    const a = envelope.data;
    const m = a.metric_summary;

    // CRITICAL: sanitize untrusted model HTML before it is persisted/rendered.
    const detailedHtml = sanitizeAnalysisHtml(a.prose_summary?.html);

    // Map structured output → the legacy AnalysisResult shape the UI already
    // renders, while passing the new arrays through verbatim.
    const result = {
      feedback: a.overall_feedback,
      score: a.score,
      weakSpots: a.mechanical_deficiencies.slice(0, 4).map(
        (d) => `${d.joint_coordinate.joint} @ ${d.checkpoint}`
      ),
      drills: a.mechanical_deficiencies.slice(0, 3).map((d) => ({
        name: d.corrective_drill_title,
        why: d.fault_description,
        how: d.corrective_drill_detail ?? "",
        feel: "",
        videoUrl: "",
      })),
      metrics: {
        swingSpeed: m.swing_speed_mph ?? 0,
        ballSpeed: m.ball_speed_mph ?? 0,
        launchAngle: m.launch_angle_deg ?? 0,
        smashFactor: m.smash_factor ?? 0,
        spine_angle_deg: m.spine_angle_deg ?? undefined,
        hip_rotation_deg: m.hip_rotation_deg ?? undefined,
        shoulder_rotation_deg: m.shoulder_rotation_deg ?? undefined,
        x_factor_deg: m.x_factor_deg ?? undefined,
        wrist_hinge_deg: m.wrist_hinge_deg ?? undefined,
      },
      // New v4 telemetry — persisted by the client into swing_analysis.
      swing_highlights: a.swing_highlights ?? [],
      mechanical_deficiencies: a.mechanical_deficiencies ?? [],
      detailed_summary_html: detailedHtml || null,
      tempo_ratio: m.tempo_ratio ?? null,
      swing_speed_mph: m.swing_speed_mph ?? null,
      _tier: tier,
      _mode: analysisMode,
      _model: a.model_used ?? null,
    };

    if (swingVideoId) {
      await supabase
        .from("swing_videos")
        .update({ analysis_mode: analysisMode, requested_model: a.model_used ?? null })
        .eq("id", swingVideoId)
        .eq("user_id", session.user.id);
    }

    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Analysis error:", msg);
    return NextResponse.json({ error: `Analysis failed: ${msg}` }, { status: 500 });
  }
}
