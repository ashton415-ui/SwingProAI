import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import {
  getAnalysisModeForTier,
  type SubscriptionTier,
} from "@/lib/entitlements";
import {
  getModelForAnalysisMode,
  getPromptForMode,
  isGeminiModel,
} from "@/lib/ai/model-router";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured" }, { status: 503 });
  }

  const { videoData, mimeType, isAdvanced, swingVideoId } = await req.json();
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

  // Look up user's subscription tier
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("subscription_tier")
    .eq("id", session.user.id)
    .single();

  const tier = (profile?.subscription_tier ?? "par") as SubscriptionTier;
  // isAdvanced flag from the UI can only elevate within what the tier allows
  const analysisMode = isAdvanced && ["birdie","eagle","coach_starter","coach_pro"].includes(tier)
    ? getAnalysisModeForTier(tier)
    : tier === "eagle" || tier === "coach_pro"
    ? "ultra"
    : tier === "birdie" || tier === "coach_starter"
    ? "advanced"
    : "basic";

  const model = getModelForAnalysisMode(analysisMode);
  const prompt = getPromptForMode(analysisMode);

  // Par users: return a basic mock response to save API costs
  if (!isGeminiModel(model)) {
    const mockResult = {
      feedback: "Your swing shows good fundamentals. Focus on maintaining consistent tempo and follow-through. Upgrade to Birdie for full AI biomechanical analysis.",
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
      _tier: "par",
      _mode: "basic",
      _upgradeMessage: "Upgrade to Birdie to unlock full AI swing analysis with launch monitor fusion.",
    };

    // Update swing_videos with analysis mode if swingVideoId provided
    if (swingVideoId) {
      await supabase.from("swing_videos")
        .update({ analysis_mode: "basic", requested_model: "local-basic" })
        .eq("id", swingVideoId).eq("user_id", session.user.id);
    }

    return NextResponse.json(mockResult);
  }

  // Birdie / Eagle: call Gemini
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: videoData } },
            ],
          }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.4,
            maxOutputTokens: analysisMode === "ultra" ? 4096 : 2048,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(`Gemini error (${model}):`, response.status, err.slice(0, 200));
      return NextResponse.json(
        { error: `AI analysis failed (${response.status})`, detail: err.slice(0, 200) },
        { status: 502 }
      );
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      result = JSON.parse(cleaned);
    }

    result._tier = tier;
    result._mode = analysisMode;
    result._model = model;

    // Update swing_videos record
    if (swingVideoId) {
      await supabase.from("swing_videos")
        .update({ analysis_mode: analysisMode, requested_model: model })
        .eq("id", swingVideoId).eq("user_id", session.user.id);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: "Analysis processing failed" }, { status: 500 });
  }
}
