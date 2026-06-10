import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createClient } from "@/utils/supabase/server";

export const maxDuration = 120;

/** Encode an ArrayBuffer to base64 without spread/downlevelIteration. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Structured output schema ──────────────────────────────────────────────────

const VERIFICATION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    pass: {
      type: SchemaType.BOOLEAN,
      description: "true if the golfer successfully executed the drill correctly, false if they need more work",
    },
    feedback: {
      type: SchemaType.STRING,
      description: "1-2 sentences explaining exactly why they passed or precisely what needs to improve",
    },
  },
  required: ["pass", "feedback"],
};

// ── POST /api/verify-drill ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse FormData ──────────────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const drillId   = formData.get("drillId");
  const userId    = formData.get("userId");
  const videoFile = formData.get("video");

  if (!drillId || typeof drillId !== "string") {
    return NextResponse.json({ error: "Missing drillId" }, { status: 400 });
  }
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }
  if (!videoFile || !(videoFile instanceof File)) {
    return NextResponse.json({ error: "Missing video file" }, { status: 400 });
  }

  // Prevent a user submitting a verification on behalf of someone else
  if (userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Fetch the drill's AI verification prompt ────────────────────────────────
  const { data: drill, error: drillErr } = await supabase
    .from("drills")
    .select("name, ai_verification_prompt")
    .eq("id", drillId)
    .single();

  if (drillErr || !drill) {
    console.error("[verify-drill] drill not found:", drillId, drillErr?.message);
    return NextResponse.json({ error: "Drill not found" }, { status: 404 });
  }

  // ── Gemini setup ────────────────────────────────────────────────────────────
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!geminiKey) {
    console.error("[verify-drill] FATAL: no Gemini API key");
    return NextResponse.json({ error: "AI service not configured" }, { status: 503 });
  }

  // ── Convert video file → inline base64 ─────────────────────────────────────
  const arrayBuf = await videoFile.arrayBuffer();
  const base64   = arrayBufferToBase64(arrayBuf);
  const mimeType = videoFile.type || "video/mp4";

  console.log("[verify-drill] drill:", drill.name, "| video size:", (arrayBuf.byteLength / 1_048_576).toFixed(1), "MB");

  // ── Call Gemini 2.5 Flash ───────────────────────────────────────────────────
  let verificationResult: { pass: boolean; feedback: string };

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You are a PGA Tour swing coach verifying whether a golfer correctly executed a specific practice drill. " +
        "Watch the video carefully and assess only what is asked in the verification prompt. " +
        "Be direct and specific — cite what you see in the video, not generalities.",
    });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: drill.ai_verification_prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema:   VERIFICATION_SCHEMA as Schema,
        temperature:      0.0,
        maxOutputTokens:  512,
      },
    });

    const rawText = result.response.text();
    console.log("[verify-drill] Gemini response:", rawText);
    verificationResult = JSON.parse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[verify-drill] Gemini error:", msg);
    return NextResponse.json({ error: `AI verification failed: ${msg}` }, { status: 500 });
  }

  const status = verificationResult.pass ? "verified" : "needs_work";

  // ── Upsert user_drills ──────────────────────────────────────────────────────
  // Select-then-update pattern: avoids needing a unique constraint on (user_id, drill_id).
  // RLS on user_drills allows the authenticated user to insert/update their own rows.
  const { data: existing } = await supabase
    .from("user_drills")
    .select("id")
    .eq("user_id", userId)
    .eq("drill_id", drillId)
    .maybeSingle();

  let dbError: { message: string } | null = null;

  if (existing) {
    const { error } = await supabase
      .from("user_drills")
      .update({ status, latest_ai_feedback: verificationResult.feedback })
      .eq("id", existing.id);
    dbError = error;
  } else {
    const { error } = await supabase
      .from("user_drills")
      .insert({ user_id: userId, drill_id: drillId, status, latest_ai_feedback: verificationResult.feedback });
    dbError = error;
  }

  if (dbError) {
    console.error("[verify-drill] DB write error:", dbError.message);
    return NextResponse.json({ error: `Database write failed: ${dbError.message}` }, { status: 500 });
  }

  console.log("[verify-drill] complete — drill:", drill.name, "| status:", status);

  return NextResponse.json({
    pass:     verificationResult.pass,
    status,
    feedback: verificationResult.feedback,
    drillId,
    userId,
  });
}
