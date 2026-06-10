import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import fs from "fs";
import path from "path";

export const maxDuration = 120;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeTypeFromPath(storagePath: string): string {
  const ext = storagePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

// ── POST /api/verify-drill ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse JSON body ─────────────────────────────────────────────────────────
  let body: { drillId?: unknown; userId?: unknown; videoStoragePath?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { drillId, userId, videoStoragePath } = body;

  if (!drillId || typeof drillId !== "string") {
    return NextResponse.json({ error: "Missing drillId" }, { status: 400 });
  }
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }
  if (!videoStoragePath || typeof videoStoragePath !== "string") {
    return NextResponse.json({ error: "Missing videoStoragePath" }, { status: 400 });
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

  // ── Gemini key ──────────────────────────────────────────────────────────────
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!geminiKey) {
    console.error("[verify-drill] FATAL: no Gemini API key");
    return NextResponse.json({ error: "AI service not configured" }, { status: 503 });
  }

  // ── Download video from Supabase Storage ────────────────────────────────────
  const admin = createAdminClient();
  console.log("[verify-drill] downloading from drill_videos:", videoStoragePath);

  const { data: videoBlob, error: downloadErr } = await admin.storage
    .from("drill_videos")
    .download(videoStoragePath);

  if (downloadErr || !videoBlob) {
    console.error("[verify-drill] storage download failed:", downloadErr?.message);
    return NextResponse.json({ error: "Failed to download video from storage" }, { status: 502 });
  }

  const mimeType = mimeTypeFromPath(videoStoragePath);
  const ext      = mimeType === "video/quicktime" ? "mov" : mimeType === "video/webm" ? "webm" : "mp4";
  const tmpName  = `drill_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const tmpPath  = path.join("/tmp", tmpName);

  console.log("[verify-drill] video size:", (videoBlob.size / 1_048_576).toFixed(1), "MB | tmp:", tmpPath);

  // ── Write to /tmp ───────────────────────────────────────────────────────────
  const arrayBuf = await videoBlob.arrayBuffer();
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

  // ── Upload to Gemini File API + call model ──────────────────────────────────
  let verificationResult: { pass: boolean; feedback: string };
  let geminiFileName: string | undefined;

  try {
    const fileManager = new GoogleAIFileManager(geminiKey);

    console.log("[verify-drill] uploading to Gemini File API…");
    const uploadResponse = await fileManager.uploadFile(tmpPath, {
      mimeType,
      displayName: `drill-${drillId}-${Date.now()}`,
    });

    geminiFileName = uploadResponse.file.name;
    console.log("[verify-drill] Gemini file uploaded:", geminiFileName, "| state:", uploadResponse.file.state);

    // Poll until the file is ACTIVE (usually instant for short clips)
    let geminiFile = uploadResponse.file;
    let pollAttempts = 0;
    while (geminiFile.state === FileState.PROCESSING && pollAttempts < 12) {
      await new Promise((r) => setTimeout(r, 5_000));
      geminiFile = await fileManager.getFile(geminiFile.name);
      pollAttempts++;
      console.log("[verify-drill] polling Gemini file state:", geminiFile.state, `(attempt ${pollAttempts})`);
    }

    if (geminiFile.state === FileState.FAILED) {
      throw new Error("Gemini file processing failed");
    }
    if (geminiFile.state !== FileState.ACTIVE) {
      throw new Error(`Gemini file still not active after polling (state: ${geminiFile.state})`);
    }

    console.log("[verify-drill] Gemini file ACTIVE — calling gemini-2.5-flash");

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction:
        "You are a PGA Tour swing coach verifying whether a golfer correctly executed a specific practice drill. " +
        "Watch the video carefully and assess only what is asked in the verification prompt. " +
        "Be direct and specific — cite what you see in the video, not generalities.",
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [
      {
        fileData: {
          mimeType: geminiFile.mimeType,
          fileUri:  geminiFile.uri,
        },
      },
      { text: drill.ai_verification_prompt },
    ];

    const result = await model.generateContent({
      contents: [{ role: "user", parts: contentParts }],
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
  } finally {
    // Always clean up /tmp and Gemini file, regardless of success or failure
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
    if (geminiFileName) {
      const fileManager = new GoogleAIFileManager(geminiKey);
      fileManager.deleteFile(geminiFileName).catch(() => { /* non-fatal */ });
    }
  }

  const status = verificationResult.pass ? "verified" : "needs_work";

  // ── Upsert user_drills ──────────────────────────────────────────────────────
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
      .update({ status, latest_ai_feedback: verificationResult.feedback, video_url: videoStoragePath })
      .eq("id", existing.id);
    dbError = error;
  } else {
    const { error } = await supabase
      .from("user_drills")
      .insert({ user_id: userId, drill_id: drillId, status, latest_ai_feedback: verificationResult.feedback, video_url: videoStoragePath });
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
