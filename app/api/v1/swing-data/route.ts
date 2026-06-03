import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import type { SwingTelemetryPayload } from "@/types/database";

const VALID_VIEW_ANGLES = ["face_on", "down_the_line"] as const;

function isValidPayload(body: unknown): body is SwingTelemetryPayload {
  if (!body || typeof body !== "object") return false;
  const p = body as Record<string, unknown>;
  if (typeof p.userId !== "string") return false;
  if (typeof p.captureTimestamp !== "string") return false;
  if (!VALID_VIEW_ANGLES.includes(p.viewAngle as never)) return false;
  if (!p.biomechanics || typeof p.biomechanics !== "object") return false;
  const b = p.biomechanics as Record<string, unknown>;
  if (typeof b.spineAngleDegree !== "number") return false;
  if (typeof b.hipSwayInches !== "number") return false;
  if (typeof b.headDropFactor !== "number") return false;
  if (typeof b.tempoRatio !== "number") return false;
  return true;
}

/**
 * POST /api/v1/swing-data
 * Receives SwingTelemetryPayload from the C# client.
 * Requires: Authorization: Bearer <supabase-jwt>
 */
export async function POST(req: NextRequest) {
  // 1. Authenticate via Supabase JWT
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse and validate payload
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidPayload(body)) {
    return NextResponse.json(
      { error: "Invalid payload. Check data-contract.md for the required schema." },
      { status: 422 }
    );
  }

  // 3. Ensure userId matches authenticated user
  if (body.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 4. Create swing_video record (pending)
  const { data: video, error: videoError } = await supabase
    .from("swing_videos")
    .insert({
      user_id: user.id,
      storage_path: "", // populated later when video upload completes
      status: "processing",
    })
    .select()
    .single();

  if (videoError || !video) {
    console.error("swing_videos insert error:", videoError);
    return NextResponse.json({ error: "Failed to create swing record" }, { status: 500 });
  }

  // 5. Persist analysis record with incoming biomechanics data
  const { data: analysis, error: analysisError } = await supabase
    .from("swing_analysis")
    .insert({
      swing_video_id: video.id,
      user_id: user.id,
      spine_angle_deg: body.biomechanics.spineAngleDegree,
      tempo_ratio: body.biomechanics.tempoRatio,
      raw_result: {
        viewAngle: body.viewAngle,
        captureTimestamp: body.captureTimestamp,
        biomechanics: body.biomechanics,
      },
    })
    .select()
    .single();

  if (analysisError || !analysis) {
    console.error("swing_analysis insert error:", analysisError);
    return NextResponse.json({ error: "Failed to save analysis" }, { status: 500 });
  }

  // 6. TODO: forward raw_result to Python FastAPI for full AI processing
  // await fetch(`${process.env.AI_BACKEND_URL}/analyze`, { method: "POST", body: JSON.stringify(analysis) })

  return NextResponse.json(
    { message: "Swing data received", data: { swingId: analysis.id } },
    { status: 201 }
  );
}
