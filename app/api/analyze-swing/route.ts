/**
 * POST /api/analyze-swing
 *
 * Pipeline
 * ────────────────────────────────────────────────────────────────────────────
 * 1. Authenticate + fetch the swing_analysis + swing_videos row from Supabase.
 * 2. Call extractSwingMetrics(signedVideoUrl) from lib/biometrics.ts.
 *    → In this Node.js context the function immediately returns all-null fields
 *      (it guards on `typeof window === "undefined"`).  Any real numbers arrive
 *      via the optional `mediapipeMetrics` field in the request body, which the
 *      AnalysisReport client component should pre-compute and include.
 * 3. Merge server-side (null) and client-side metrics — client values win.
 * 4. Fetch the raw video bytes (up to MAX_INLINE_VIDEO_BYTES = 20 MB).
 *    Anything larger is skipped; Gemini still works from metadata + numbers.
 * 5. Call Gemini 1.5 Pro with:
 *    a) A world-class PGA coach system instruction with embedded diagnostic rules
 *    b) Inline video base64 (when within size budget)
 *    c) Raw biomechanical numbers with plain-English clinical interpretations
 *    d) JSON-only response format
 * 6. Parse the JSON response, validate required fields, log any failures.
 * 7. Write results to swing_analysis and return.
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@/utils/supabase/server";
import { extractSwingMetrics } from "@/lib/biometrics";

export const maxDuration = 60;

// Inline video budget sent to Gemini. Videos larger than this are analysed
// from metadata + MediaPipe numbers only — still high quality.
const MAX_INLINE_VIDEO_BYTES = 20 * 1_048_576; // 20 MB

// ── Request body ──────────────────────────────────────────────────────────────

interface RequestBody {
  analysisId: string;
  /**
   * Pre-computed MediaPipe metrics from the client component.
   * The server-side extractSwingMetrics() call always returns null (browser-only),
   * so the client should call extractSwingMetrics(signedUrl) before hitting this
   * endpoint and pass the results here.  All fields are optional — the prompt
   * gracefully handles missing values.
   */
  mediapipeMetrics?: {
    spineAngle?:        number | null;
    hipRotation?:       number | null;
    shoulderRotation?:  number | null;
    tempoRatio?:        string | null;
    setupSpineAngle?:   number | null;   // for early-extension diagnosis
    impactSpineAngle?:  number | null;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTempoRatioToNumber(s: string): number | null {
  const parts = s.split(":").map(Number);
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[1] !== 0) {
    return parts[0] / parts[1];
  }
  return null;
}

/** Fetch up to `limitBytes` from `url`. Returns null on network error or if the
 *  response is larger than the limit. */
async function fetchVideoBytes(
  url: string,
  limitBytes: number,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn("[analyze-swing] video fetch failed:", res.status);
      return null;
    }

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > limitBytes) {
      console.warn(
        `[analyze-swing] video too large for inline (${(contentLength / 1_048_576).toFixed(1)} MB > ${limitBytes / 1_048_576} MB limit) — proceeding without video`,
      );
      return null;
    }

    const rawMime = res.headers.get("content-type") ?? "";
    const mimeType = rawMime.includes("quicktime") ? "video/quicktime"
                   : rawMime.includes("mp4")        ? "video/mp4"
                   : "video/mp4";

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > limitBytes) {
      console.warn("[analyze-swing] video exceeded inline limit after full download — skipping");
      return null;
    }

    return { buffer: Buffer.from(arrayBuf), mimeType };
  } catch (err) {
    console.warn("[analyze-swing] fetchVideoBytes error:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Biomechanical interpretation rules ────────────────────────────────────────
// Each rule maps a measured value to a plain-English clinical finding.
// These are injected verbatim into the Gemini prompt so the model can
// reference them when writing personalised coaching sentences.

function buildMetricsContext(metrics: {
  spineAngle?:       number | null;
  hipRotation?:      number | null;
  shoulderRotation?: number | null;
  tempoRatio?:       string | null;
  setupSpineAngle?:  number | null;
  impactSpineAngle?: number | null;
}): string {
  const lines: string[] = ["=== RAW BIOMECHANICAL MEASUREMENTS ==="];

  // Spine angle at address
  if (metrics.spineAngle != null) {
    const s = metrics.spineAngle;
    let dx = "";
    if (s < 30)       dx = "⚠ CRITICAL: Spine too upright at address (<30°). Expect thin contact and poor weight transfer.";
    else if (s < 35)  dx = "⚠ Slightly upright spine angle. Address posture should deepen by 5-10°.";
    else if (s <= 45) dx = "✓ Ideal spine angle range (35-45°). Solid foundation.";
    else if (s <= 50) dx = "⚠ Slightly excessive tilt. Monitor for early extension to compensate.";
    else              dx = "⚠ Excessive spine tilt (>50°). High risk of reverse pivot.";
    lines.push(`Spine Angle (address): ${s}° — ${dx}`);
  } else {
    lines.push("Spine Angle: not measured — estimate from visual posture cues.");
  }

  // Early extension diagnosis (setup vs impact spine angle change)
  if (metrics.setupSpineAngle != null && metrics.impactSpineAngle != null) {
    const drop = metrics.setupSpineAngle - metrics.impactSpineAngle;
    if (drop > 5) {
      lines.push(`Early Extension DETECTED: spine angle dropped ${drop.toFixed(1)}° from setup (${metrics.setupSpineAngle}°) to impact (${metrics.impactSpineAngle}°). Hips thrusting toward ball — causes blocks, pulls, and thin strikes. Must address immediately.`);
    } else if (drop < -5) {
      lines.push(`Standing-Up DETECTED: spine angle increased ${Math.abs(drop).toFixed(1)}° at impact — losing posture through the ball. Causes topped shots and inconsistent contact.`);
    } else {
      lines.push(`Spine angle maintenance: stable within ${Math.abs(drop).toFixed(1)}° from address to impact. Good postural retention.`);
    }
  }

  // Shoulder rotation at top of backswing
  if (metrics.shoulderRotation != null) {
    const r = metrics.shoulderRotation;
    let dx = "";
    if (r < 70)       dx = "⚠ CRITICAL: Severely restricted backswing (<70°). Major power and timing loss.";
    else if (r < 80)  dx = "⚠ Below-average shoulder turn (70-80°). Common in older/less flexible golfers. Work on thoracic mobility.";
    else if (r <= 95) dx = "✓ Good shoulder rotation. Solid coil for power.";
    else if (r <= 105) dx = "✓ Excellent shoulder turn. Tour-level rotation.";
    else              dx = "⚠ Over-rotation risk (>105°). May introduce loop or loss of control.";
    lines.push(`Shoulder Rotation (top of swing): ${r}° — ${dx}`);
  } else {
    lines.push("Shoulder Rotation: not measured — estimate from visual backswing extent.");
  }

  // Hip rotation at impact
  if (metrics.hipRotation != null) {
    const h = metrics.hipRotation;
    let dx = "";
    if (h < 30)       dx = "⚠ CRITICAL: Insufficient hip clearance (<30°). Arms will race ahead of body — blocks and pushes.";
    else if (h < 40)  dx = "⚠ Below-average hip drive (30-40°). Body not leading the downswing.";
    else if (h <= 50) dx = "✓ Good hip rotation at impact. Strong sequencing.";
    else if (h <= 60) dx = "✓ Excellent hip clearance. Tour-level body rotation.";
    else              dx = "⚠ Possibly excessive hip rotation (>60°). Watch for early extension compensation.";
    lines.push(`Hip Rotation (impact): ${h}° — ${dx}`);
  } else {
    lines.push("Hip Rotation: not measured — estimate from visual hip position at impact.");
  }

  // X-Factor (shoulder turn relative to hip turn — power differential)
  if (metrics.shoulderRotation != null && metrics.hipRotation != null) {
    const xFactor = metrics.shoulderRotation - metrics.hipRotation;
    if (xFactor >= 45)       lines.push(`X-Factor: ${xFactor.toFixed(0)}° separation — excellent power loading.`);
    else if (xFactor >= 30)  lines.push(`X-Factor: ${xFactor.toFixed(0)}° separation — good. Average tour X-Factor is 45°.`);
    else if (xFactor >= 15)  lines.push(`X-Factor: ${xFactor.toFixed(0)}° separation — below average. Insufficient shoulder-hip differential, reducing stored power.`);
    else                     lines.push(`X-Factor: ${xFactor.toFixed(0)}° — MINIMAL separation. Body and shoulders turning together destroys power; work on hip resistance in backswing.`);
  }

  // Tempo ratio
  if (metrics.tempoRatio) {
    const t = metrics.tempoRatio;
    const num = parseTempoRatioToNumber(t);
    let dx = "";
    if (num != null) {
      if (num < 2)        dx = "⚠ Extremely fast transition. Casting, no lag, power leak.";
      else if (num < 2.5) dx = "⚠ Quick tempo — may cause early release.";
      else if (num <= 3.5) dx = "✓ Ideal tempo range (tour average 3:1).";
      else if (num <= 4.5) dx = "⚠ Slow tempo — risk of deceleration at impact.";
      else                 dx = "⚠ Very slow tempo — significant power loss.";
    }
    lines.push(`Tempo Ratio (backswing:downswing): ${t}${dx ? " — " + dx : ""}`);
  } else {
    lines.push("Tempo Ratio: not measured — assess from visual rhythm of the swing.");
  }

  return lines.join("\n");
}

// ── JSON output schema (for the prompt — Gemini enforces via responseMimeType) ─

const JSON_SCHEMA_DESCRIPTION = `
You MUST return ONLY a valid JSON object matching this exact schema (no markdown, no comments):
{
  "score": integer (0-100),
  "overall_assessment": string (3-5 sentences integrating the biomechanical findings above),
  "spine_angle": number (degrees — use measured value if provided, else visually estimate),
  "hip_rotation": number (degrees),
  "shoulder_rotation": number (degrees),
  "tempo_ratio": string (e.g. "3:1"),
  "highlights": string[] (2-4 concise positives with ball-flight benefit),
  "deficiencies": string[] (2-4 priority faults with ball-flight consequence and drill),
  "putting_analysis": string (2-3 sentences on putting tendencies from setup/grip/alignment),
  "posture": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string, "correction": string },
  "swing_plane": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string, "correction": string },
  "impact": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string, "correction": string },
  "practice_focus": string (single highest-priority sentence),
  "pro_cue": string (one elite swing thought, 10 words or fewer)
}
`.trim();

// ── System instruction ────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
You are a world-class PGA Tour swing coach with 25+ years of experience on Tour, certified in biomechanics analysis and TrackMan data interpretation. Your students have won multiple major championships. You deliver brutally honest, technically precise coaching reports that elite players and serious amateurs rely on.

YOUR CORE MANDATE
────────────────
When raw biomechanical measurements are provided (spine angle, hip rotation, shoulder rotation, tempo ratio), you MUST interpret those specific numbers in your analysis. Do not give generic feedback — reference the actual measured values and diagnose the specific fault each number reveals. For example:
• A measured spine angle drop of >5° from setup to impact is a confirmed early extension — say so explicitly.
• A shoulder rotation <80° is a restricted backswing — identify the likely cause (thoracic mobility, grip tension).
• A hip rotation <35° at impact means the arms are racing the body — name the resulting ball flight (block, push-draw, thin).
• A tempo ratio <2.5:1 indicates casting or early release — prescribe a specific rehearsal drill.

SCORING RUBRIC
──────────────
40-65: high-handicapper — systemic faults causing slices, chunks, and inconsistency
65-78: mid-handicapper — solid contact but fixable mechanical leaks
78-88: low-handicapper / near-scratch — subtle faults costing yards and dispersion
88+:   elite / tour-level — fine-tuning only

COACHING STANDARDS
──────────────────
• Name joints, planes, and degrees where possible.
• Every deficiency must include: what is wrong → what the ball does → one specific drill.
• Every highlight must reinforce a genuine positive — never generic praise.
• Putting analysis must connect the full-swing setup/alignment pattern to putting tendencies.
• The pro_cue must be a single feel-image a touring pro would recognise (10 words max).

${JSON_SCHEMA_DESCRIPTION}
`.trim();

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[analyze-swing] POST received");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  console.log("[analyze-swing] auth:", user?.id ?? "none", authError?.message ?? "ok");

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { analysisId, mediapipeMetrics: clientMetrics } = body;
  if (!analysisId) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  // ── Fetch DB row + video metadata ─────────────────────────────────────────
  console.log("[analyze-swing] fetching row:", analysisId);
  const { data: analysisRow, error: fetchErr } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(id, club, original_filename, video_url, storage_path, mime_type, file_size)")
    .eq("id", analysisId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !analysisRow) {
    console.error("[analyze-swing] fetch error:", fetchErr?.message, fetchErr?.details, fetchErr?.hint);
    return NextResponse.json({ error: "Analysis record not found." }, { status: 404 });
  }

  console.log("[analyze-swing] row status:", analysisRow.status);
  if (analysisRow.status === "complete") {
    return NextResponse.json({ message: "Already complete", data: analysisRow });
  }

  // Mark as processing
  const { error: markErr } = await supabase
    .from("swing_analysis")
    .update({ status: "processing" })
    .eq("id", analysisId);

  if (markErr) {
    console.error("[analyze-swing] mark-processing error:", markErr.message, markErr.details, markErr.hint);
  }

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!geminiKey) {
    console.error("[analyze-swing] no Gemini API key (GEMINI_API_KEY / GOOGLE_AI_API_KEY)");
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json({ error: "AI service not configured." }, { status: 503 });
  }

  // ── Video metadata ────────────────────────────────────────────────────────
  const videoRow = analysisRow.swing_video as {
    id: string;
    club: string | null;
    original_filename: string | null;
    video_url: string;
    storage_path: string | null;
    mime_type: string | null;
    file_size: number | null;
  } | null;

  const clubLabel = videoRow?.club
    ? `Club: ${videoRow.club}`
    : videoRow?.original_filename
    ? `File: ${videoRow.original_filename}`
    : "Club: unknown";

  const sizeLabel = videoRow?.file_size
    ? `(${(videoRow.file_size / 1_048_576).toFixed(1)} MB)`
    : "";

  // ── Step 2: extractSwingMetrics (server-side = null; client values override) ─
  // The function guards on `typeof window === "undefined"` and returns all-null.
  // Real measurements come from the client via `mediapipeMetrics` in the body.
  console.log("[analyze-swing] calling extractSwingMetrics (server-side: will return null fields)");
  const serverMetrics = await extractSwingMetrics(videoRow?.video_url ?? "");

  // Merge: client-provided values take precedence over the server no-op
  const merged = {
    spineAngle:       clientMetrics?.spineAngle       ?? serverMetrics.spineAngle,
    hipRotation:      clientMetrics?.hipRotation      ?? serverMetrics.hipRotation,
    shoulderRotation: clientMetrics?.shoulderRotation ?? serverMetrics.shoulderRotation,
    tempoRatio:       clientMetrics?.tempoRatio       ?? serverMetrics.tempoRatio,
    setupSpineAngle:  clientMetrics?.setupSpineAngle  ?? serverMetrics.setup.spineAngle,
    impactSpineAngle: clientMetrics?.impactSpineAngle ?? serverMetrics.impact.spineAngle,
  };

  const hasRealMetrics = Object.values(merged).some((v) => v != null);
  console.log("[analyze-swing] metrics available:", hasRealMetrics, JSON.stringify(merged));

  // ── Step 4: fetch video bytes for inline Gemini input ─────────────────────
  // Generate a 1-hour signed URL from Supabase Storage (the public URL may
  // require auth headers that the fetch inside Vercel can't send).
  let videoPayload: { inlineData: { mimeType: string; data: string } } | null = null;

  if (videoRow?.storage_path) {
    const BUCKET = "swing-videos";
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(videoRow.storage_path, 3600);

    const fetchUrl = signed?.signedUrl ?? videoRow.video_url;
    console.log("[analyze-swing] fetching video for inline (limit:", MAX_INLINE_VIDEO_BYTES / 1_048_576, "MB)");
    const videoData = await fetchVideoBytes(fetchUrl, MAX_INLINE_VIDEO_BYTES);

    if (videoData) {
      videoPayload = {
        inlineData: {
          mimeType: videoData.mimeType,
          data: videoData.buffer.toString("base64"),
        },
      };
      console.log("[analyze-swing] video loaded inline:", (videoData.buffer.byteLength / 1_048_576).toFixed(1), "MB");
    }
  }

  // ── Step 5: build Gemini request ──────────────────────────────────────────
  const metricsContext = buildMetricsContext(merged);

  const userPrompt = [
    `Perform a complete biomechanical swing analysis for this golfer.`,
    ``,
    `Session context: ${clubLabel} ${sizeLabel}`,
    ``,
    metricsContext,
    ``,
    videoPayload
      ? `You have the actual swing video. Use it to visually verify the measured numbers and add observations about grip, alignment, ball position, and any visual cues the numbers do not capture.`
      : `No video data was transmitted (file too large or unavailable). Base your visual observations on the biomechanical measurements above and context clues. Be explicit about which findings are inferred from the numbers vs. directly observed.`,
    ``,
    `Return ONLY the JSON object described in your instructions. No markdown fencing, no preamble.`,
  ].join("\n");

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.4,
        maxOutputTokens: 4096,
      },
    });

    // Build content parts: [video (optional), text prompt]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];
    if (videoPayload) parts.push(videoPayload);
    parts.push(userPrompt);

    console.log("[analyze-swing] calling gemini-1.5-pro, parts:", parts.length, videoPayload ? "(video + text)" : "(text only)");

    const result = await model.generateContent(parts);
    const rawText = result.response.text();

    console.log("[analyze-swing] Gemini response length:", rawText.length);
    console.log("[analyze-swing] response preview:", rawText.slice(0, 200));

    // ── Step 6: parse + validate ──────────────────────────────────────────
    let report: {
      score: number;
      overall_assessment: string;
      spine_angle: number;
      hip_rotation: number;
      shoulder_rotation: number;
      tempo_ratio: string;
      highlights: string[];
      deficiencies: string[];
      putting_analysis: string;
      posture: { rating: string; observation: string; correction: string };
      swing_plane: { rating: string; observation: string; correction: string };
      impact: { rating: string; observation: string; correction: string };
      practice_focus: string;
      pro_cue: string;
    };

    try {
      // Strip any accidental markdown fence that slipped through
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      report = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[analyze-swing] JSON parse failure:", parseErr instanceof Error ? parseErr.message : parseErr);
      console.error("[analyze-swing] raw response (first 500 chars):", rawText.slice(0, 500));
      throw new Error(`Gemini returned non-JSON response: ${String(parseErr)}`);
    }

    // Validate required top-level fields
    const requiredFields = [
      "score", "overall_assessment", "spine_angle", "hip_rotation",
      "shoulder_rotation", "tempo_ratio", "highlights", "deficiencies",
      "putting_analysis", "posture", "swing_plane", "impact",
      "practice_focus", "pro_cue",
    ] as const;

    const missing = requiredFields.filter((f) => report[f] == null);
    if (missing.length > 0) {
      console.error("[analyze-swing] response missing fields:", missing.join(", "));
      console.error("[analyze-swing] full response:", rawText);
      throw new Error(`Gemini response missing required fields: ${missing.join(", ")}`);
    }

    console.log("[analyze-swing] parsed — score:", report.score, "spine:", report.spine_angle, "hips:", report.hip_rotation, "shoulders:", report.shoulder_rotation);

    // ── Step 7: map to DB schema + save ──────────────────────────────────
    const metrics = {
      spine_angle:      report.spine_angle,
      hip_rotation:     report.hip_rotation,
      shoulder_rotation: report.shoulder_rotation,
      tempo_ratio:      report.tempo_ratio,
      putting_analysis: report.putting_analysis,
      posture:          report.posture,
      swing_plane:      report.swing_plane,
      impact:           report.impact,
      practice_focus:   report.practice_focus,
      pro_cue:          report.pro_cue,
    };

    // Wrap plain strings into the JSONB array shapes required by DB constraints
    const swing_highlights = report.highlights.map((h) => ({
      checkpoint: "impact" as const,
      positive_movement: h,
      mechanical_benefit: "",
    }));

    const mechanical_deficiencies = report.deficiencies.map((d) => ({
      checkpoint: "impact" as const,
      joint_coordinate: { joint: "general", x: 0.5, y: 0.5 },
      fault_description: d,
      severity: "minor" as const,
      corrective_drill_title: "",
    }));

    const tempoNumeric = parseTempoRatioToNumber(report.tempo_ratio);

    console.log("[analyze-swing] writing to DB:", analysisId);

    const { data: updated, error: updateErr } = await supabase
      .from("swing_analysis")
      .update({
        status: "complete",
        score:                  report.score,
        feedback:               report.overall_assessment,
        tempo_ratio:            tempoNumeric,
        metrics,
        swing_highlights,
        mechanical_deficiencies,
      })
      .eq("id", analysisId)
      .select()
      .single();

    if (updateErr) {
      console.error("[analyze-swing] DB update error:", updateErr.message, updateErr.details, updateErr.hint, updateErr.code);
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
      return NextResponse.json({ error: `Failed to save analysis: ${updateErr.message}` }, { status: 500 });
    }

    console.log("[analyze-swing] complete — status:", updated?.status);
    return NextResponse.json({ message: "Analysis complete", data: updated });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-swing] fatal error:", msg);
    try {
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    } catch (failErr) {
      console.error("[analyze-swing] also failed to mark row failed:", failErr);
    }
    return NextResponse.json({ error: `Analysis failed: ${msg}` }, { status: 500 });
  }
}
