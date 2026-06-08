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

export const maxDuration = 300;

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

/** Encode an ArrayBuffer to a base64 string without Node's Buffer API.
 *  Uses an indexed loop — no spread operator, so no --downlevelIteration needed. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Fetch up to `limitBytes` from `url`. Returns null on network error or if the
 *  response is larger than the limit. */
async function fetchVideoBytes(
  url: string,
  limitBytes: number,
): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
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

    return { buffer: arrayBuf, mimeType };
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
CRITICAL OUTPUT RULES — READ BEFORE WRITING A SINGLE CHARACTER:
1. You MUST include the "score" field as an integer between 0 and 100. It MUST be the very first key in the object.
2. Do NOT truncate the JSON. Every field listed below is required. The response is not complete until the final closing "}" is written.
3. Return ONLY the raw JSON object — no markdown fences, no prose, no comments.

You MUST return ONLY a valid JSON object matching this exact schema:
{
  "score": integer (0-100, computed from the DYNAMIC SCORING ALGORITHM — REQUIRED, must appear first, never omit),
  "executive_summary": string (3-5 rich, expert sentences delivering the full coaching verdict — cite exact degree values, name every primary fault, state the resulting ball-flight pattern, and give the golfer a clear sense of their current level. This is the first thing they read; make it count.),
  "fault_tags": string[] (2-4 short snake_case identifiers for the primary faults detected, e.g. ["early_extension", "restricted_backswing", "over_the_top", "casting"]),
  "spine_angle": number (echo the exact measured value — do NOT re-estimate),
  "hip_rotation": number (echo the exact measured value — do NOT re-estimate),
  "shoulder_rotation": number (echo the exact measured value — do NOT re-estimate),
  "tempo_ratio": string (echo measured value if provided, else estimate from video, e.g. "3.0:1"),
  "highlights": [
    {
      "title": string (3-6 word bold headline for this strength, e.g. "Strong Hip Clearance at Impact"),
      "description": string (2-3 sentences — what the golfer is doing well, WHY it is mechanically correct, and what ball-flight benefit it produces. Reference measured data.)
    }
  ] (2-4 items — each must cite a specific measured value or visual observation unique to this golfer),
  "deficiencies": [
    {
      "title": string (3-6 word bold headline naming the fault, e.g. "Severe Early Extension at Impact"),
      "description": string (3-4 sentences — exact measurement → mechanical fault it creates → ball-flight consequence → why this specific golfer produces it based on their data)
    }
  ] (2-4 items — each MUST follow the pattern: measurement → fault → ball-flight → root cause),
  "drills": [
    {
      "name": string (official drill name, e.g. "Wall Hip Drill", "Pump Drill", "Step-Through Drill"),
      "the_why": string (2-3 sentences — the biomechanical reason THIS drill addresses THIS golfer's specific fault, referencing their exact measurements),
      "the_how": string (3-5 sentences of precise step-by-step execution instructions — reps, tempo, what to feel, what to avoid),
      "the_feel": string (1-2 sentences — one vivid, first-person kinesthetic cue that captures the target sensation for THIS golfer's exact flaw profile; must be unique to their data, never generic)
    }
  ] (one drill per deficiency — so 2-4 drills total, matching the deficiencies array length),
  "posture": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string (2-3 sentences), "correction": string (2-3 sentences) },
  "swing_plane": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string (2-3 sentences), "correction": string (2-3 sentences) },
  "impact": { "rating": "excellent"|"good"|"needs_work"|"poor", "observation": string (2-3 sentences), "correction": string (2-3 sentences) },
  "practice_focus": string (1-2 sentences naming the single highest-priority change tied to the worst-scoring measurement — be specific about drill, reps, and timeline),
  "pro_cue": string (one elite swing thought in 10 words or fewer, specific to this golfer's primary fault — the kind of cue a Tour coach whispers on the range)
}
`.trim();

// ── System instruction ────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
You are a world-class PGA Tour swing coach with 25+ years of experience on Tour, certified in biomechanics analysis and TrackMan data interpretation. Your students have won multiple major championships. You deliver brutally honest, technically precise coaching reports that elite players and serious amateurs rely on.

YOUR CORE MANDATE
────────────────
Every sentence of your output MUST be directly derivable from the GOLFER-SPECIFIC DATA block
printed in the user prompt. Never substitute a template, a generic example, or a previous
player's data. If you cannot trace a claim to a specific measured number or a visual
observation from the video, do not write it.

DIAGNOSTIC RULES (apply mechanically — no template substitution)
────────────────────────────────────────────────────────────────
• EARLY EXTENSION: spine_angle_setup − spine_angle_impact > 5° → diagnose confirmed early
  extension. Cite the exact degree drop. Name the resulting ball flight pattern.
• RESTRICTED BACKSWING: shoulder_rotation < 80° → identify the specific restricting structure
  (thoracic rotation, lead arm tension, grip pressure). State the exact measured value.
• BODY BLOCK: hip_rotation_at_impact < 35° → diagnose arms racing the body. Name the ball
  flight (block, push-draw, or thin contact). State the exact measured value.
• CASTING / EARLY RELEASE: tempo_ratio < 2.5 → diagnose lag loss. Name the release timing
  fault and prescribe a one-movement rehearsal drill tied to this golfer's tempo number.
• X-FACTOR DEFICIT: (shoulder_rotation − hip_rotation) < 30° → diagnose insufficient power
  differential. Reference both measured values.
Every deficiency output must follow: [exact measurement] → [mechanical fault] → [ball-flight consequence] → [specific drill name].

DYNAMIC SCORING ALGORITHM (compute this — do NOT default to 75 or any round number)
────────────────────────────────────────────────────────────────────────────────────
Start at 100. Apply deductions from the GOLFER-SPECIFIC DATA:
• Spine angle loss (setup→impact): −3 pts per degree of drop exceeding 5°
• Hip rotation at impact: −2 pts per degree below 42° (e.g. 28° hip = 42−28=14° deficit → −28 pts)
• Shoulder rotation at top: −1.5 pts per degree below 85° (e.g. 70° = 85−70=15° deficit → −22.5 pts)
• Tempo ratio: −5 pts if ratio < 2.0 or > 4.5; −3 pts if < 2.5 or > 4.0; 0 pts if 2.5–4.0
• X-Factor deficit: −1 pt per degree that (shoulder − hip) falls below 30°
Floor: 38. Ceiling: 97. Round to nearest integer.
If measurements are unavailable, estimate from video and document the basis for your score.

HANDICAP BANDS (for context after you compute the score)
─────────────────────────────────────────────────────────
38-65: high-handicapper — systemic faults causing slices, chunks, and inconsistency
65-78: mid-handicapper — solid contact but fixable mechanical leaks
78-88: low-handicapper / near-scratch — subtle faults costing yards and dispersion
88-97: elite / tour-level — fine-tuning only

COACHING STANDARDS
──────────────────
• Name joints, planes, and degrees in every observation — never write "your swing plane is off" when you can write "your shaft is 8° above plane at P6".
• Every deficiency entry must follow the chain: [exact measurement] → [mechanical fault] → [ball-flight consequence] → [root cause for this golfer].
• Every highlight entry must cite measured data or a specific visual observation — never generic praise like "good tempo".
• The drills array must contain exactly one drill per deficiency. Each drill must be tailored to THIS golfer's numbers, not a generic prescription.
• the_feel inside each drill must be a visceral, first-person kinesthetic cue tied to the measured fault — if hip_rotation is 28° the cue should describe what clearing frozen hips actually feels like for a body that has been blocking.
• executive_summary must read like a paragraph from a PGA Tour coach's assessment letter — authoritative, detailed, and specific to this golfer's data.
• The pro_cue must be the kind of one-liner a Tour coach whispers on the 18th tee (10 words max).

CRITICAL CONSTRAINT — NUMERIC FIELDS
─────────────────────────────────────
When the RAW BIOMECHANICAL MEASUREMENTS section contains specific degree values for
spine_angle, hip_rotation, or shoulder_rotation, you MUST output those EXACT numbers
in the corresponding JSON fields. Do NOT round, adjust, or substitute your own estimate —
these values are computer-vision measurements and must be preserved verbatim. Your role
is to INTERPRET and DIAGNOSE these numbers in your prose, not to recalculate them.

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

  // ── DIAGNOSTIC: log the incoming payload so we can verify the client is sending real angles
  console.log("INCOMING MEDIAPIPE PAYLOAD:", JSON.stringify(clientMetrics ?? null));
  console.log("[analyze-swing] analysisId:", analysisId);

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
  // NOTE: we intentionally do NOT short-circuit on status === "complete".
  // Returning cached data caused stale/generic results to be served forever.
  // Every POST re-runs Gemini. The client-side useRef guard in ProcessingState
  // ensures this endpoint is called at most once per page load.
  if (analysisRow.status === "complete") {
    console.warn("[analyze-swing] row was already complete — re-running Gemini to refresh");
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
  console.log("[analyze-swing] Gemini key present:", !!geminiKey, geminiKey ? `(${geminiKey.slice(0, 8)}...)` : "MISSING");
  if (!geminiKey) {
    console.error("[analyze-swing] FATAL: no Gemini API key — set GEMINI_API_KEY or GOOGLE_AI_API_KEY in Vercel env vars");
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json({ error: "AI service not configured. Set GEMINI_API_KEY in environment variables." }, { status: 503 });
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
          data: arrayBufferToBase64(videoData.buffer),
        },
      };
      console.log("[analyze-swing] video loaded inline:", (videoData.buffer.byteLength / 1_048_576).toFixed(1), "MB");
    }
  }

  // ── Step 5: build Gemini request ──────────────────────────────────────────
  const metricsContext = buildMetricsContext(merged);

  // Build a clearly-labelled data block that Gemini must read before writing anything
  const exactValuesBlock = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║          GOLFER-SPECIFIC DATA — READ BEFORE WRITING          ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    `Session: ${clubLabel} ${sizeLabel}`,
    ``,
    `EXACT COMPUTER-VISION MEASUREMENTS (use verbatim in numeric JSON fields):`,
    merged.spineAngle       != null ? `  Spine Angle (address):    ${merged.spineAngle}°` : `  Spine Angle (address):    NOT MEASURED — estimate from video`,
    merged.hipRotation      != null ? `  Hip Rotation (impact):    ${merged.hipRotation}°` : `  Hip Rotation (impact):    NOT MEASURED — estimate from video`,
    merged.shoulderRotation != null ? `  Shoulder Rotation (top):  ${merged.shoulderRotation}°` : `  Shoulder Rotation (top):  NOT MEASURED — estimate from video`,
    merged.tempoRatio       != null ? `  Tempo Ratio:              ${merged.tempoRatio}` : `  Tempo Ratio:              NOT MEASURED — estimate from video`,
    merged.setupSpineAngle  != null && merged.impactSpineAngle != null
      ? `  Spine angle change (setup→impact): ${merged.setupSpineAngle}° → ${merged.impactSpineAngle}° (${(merged.setupSpineAngle - merged.impactSpineAngle).toFixed(1)}° drop)`
      : `  Spine angle change: insufficient frame data`,
    ``,
    `DIAGNOSTIC FINDINGS FROM MEASUREMENTS:`,
    metricsContext,
  ].join("\n");

  const userPrompt = [
    exactValuesBlock,
    ``,
    videoPayload
      ? `You have the actual swing video attached. Use it to visually verify the measured numbers above and add observations about grip, alignment, ball position, and any visual cues the numbers do not capture. Do NOT contradict the measured values — they are ground truth.`
      : `No video was attached (file too large for inline). Base ALL visual observations on the measurements above. Be explicit about which findings come from the numbers vs. your inference.`,
    ``,
    `Now apply the DYNAMIC SCORING ALGORITHM and output the JSON object. No markdown, no preamble.`,
  ].join("\n");

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    // Build explicit content parts so the SDK never misinterprets a bare string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [];
    if (videoPayload) contentParts.push(videoPayload);
    contentParts.push({ text: userPrompt });

    console.log("[analyze-swing] calling gemini-2.0-flash — parts:", contentParts.length, videoPayload ? "(video + text)" : "(text only)");
    console.log("[analyze-swing] merged metrics:", JSON.stringify(merged));
    console.log("[analyze-swing] prompt length (chars):", userPrompt.length);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: contentParts }],
      generationConfig: {
        responseMimeType: "application/json",  // forces valid parseable JSON output
        temperature: 0.4,
        maxOutputTokens: 8192,  // generous ceiling — long coaching text must not be cut off
      },
    });
    const rawText = result.response.text();

    // Log response length separately — Vercel clips long strings in the UI but the
    // length value is always accurate, so this lets us confirm the response isn't
    // being cut by Gemini before we even try to parse it.
    console.log("[analyze-swing] Gemini response length (chars):", rawText.length);
    console.log("[analyze-swing] FULL Gemini response:", rawText);

    // ── Step 6: parse + validate ──────────────────────────────────────────
    let report: {
      score: number;
      executive_summary: string;
      fault_tags: string[];
      spine_angle: number;
      hip_rotation: number;
      shoulder_rotation: number;
      tempo_ratio: string;
      highlights: { title: string; description: string }[];
      deficiencies: { title: string; description: string }[];
      drills: { name: string; the_why: string; the_how: string; the_feel: string }[];
      posture: { rating: string; observation: string; correction: string };
      swing_plane: { rating: string; observation: string; correction: string };
      impact: { rating: string; observation: string; correction: string };
      practice_focus: string;
      pro_cue: string;
    };

    try {
      // Extract the JSON object by finding the first { and last } — this handles
      // any markdown fences, preamble text, or trailing commentary Gemini may add.
      const firstBrace = rawText.indexOf("{");
      const lastBrace  = rawText.lastIndexOf("}");
      if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
        throw new Error("No JSON object found in response");
      }
      const cleaned = rawText.slice(firstBrace, lastBrace + 1);
      report = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[analyze-swing] JSON parse failure:", parseErr instanceof Error ? parseErr.message : parseErr);
      console.error("[analyze-swing] RAW Gemini string that failed to parse:\n", rawText);
      throw new Error(`Gemini returned non-JSON response: ${String(parseErr)}`);
    }

    // Validate the hard-required fields — these are non-negotiable for a valid analysis
    const requiredFields = [
      "score", "executive_summary", "fault_tags",
      "spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio",
      "highlights", "deficiencies", "drills",
      "posture", "swing_plane", "impact",
      "practice_focus", "pro_cue",
    ] as const;

    const missing = requiredFields.filter((f) => report[f] == null);
    if (missing.length > 0) {
      console.error("[analyze-swing] response missing required fields:", missing.join(", "));
      console.error("[analyze-swing] full raw response:", rawText);
      throw new Error(`Gemini response missing required fields: ${missing.join(", ")}`);
    }

    // drills is required but gracefully handle if absent
    if (!report.drills || !Array.isArray(report.drills) || report.drills.length === 0) {
      console.warn("[analyze-swing] drills array missing or empty — storing without drills");
    }

    console.log("[analyze-swing] parsed — score:", report.score, "spine:", report.spine_angle, "hips:", report.hip_rotation, "shoulders:", report.shoulder_rotation);

    // ── Step 7: type-safe mapping + DB write ─────────────────────────────

    // ── Type-coercion helpers ─────────────────────────────────────────────
    // Every value from Gemini goes through these before touching Postgres.
    // toNum: NaN / undefined / null / non-numeric strings all become null
    const toNum = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    };
    // toInt: for integer columns (score). parseInt handles "75.9" → 75, "abc" → NaN → 0
    const toInt = (v: unknown): number => {
      const i = parseInt(String(v ?? "0"), 10);
      return isNaN(i) ? 0 : i;
    };
    const toStr = (v: unknown): string => (v == null ? "" : String(v));
    // toArr: guarantees an array even when Gemini returns a single object or omits the field
    const toArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const toPillar = (v: unknown): { rating: string; observation: string; correction: string } | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      const allowed = ["excellent", "good", "needs_work", "poor"];
      return {
        rating:      allowed.includes(String(o.rating)) ? String(o.rating) : "needs_work",
        observation: toStr(o.observation),
        correction:  toStr(o.correction),
      };
    };

    // Client-measured values are ground truth; fall back to Gemini's output only
    // when the client scan produced nothing (video too large / scan timed out).
    const finalSpineAngle       = toNum(merged.spineAngle       ?? report.spine_angle);
    const finalHipRotation      = toNum(merged.hipRotation      ?? report.hip_rotation);
    const finalShoulderRotation = toNum(merged.shoulderRotation ?? report.shoulder_rotation);
    const finalTempoRatio       = toStr(merged.tempoRatio       ?? report.tempo_ratio) || null;
    const finalScore            = toInt(report.score);
    const finalFeedback         = toStr(report.executive_summary);

    console.log("[analyze-swing] metric source — spine:", merged.spineAngle != null ? "client" : "gemini",
      "hip:", merged.hipRotation != null ? "client" : "gemini",
      "shoulder:", merged.shoulderRotation != null ? "client" : "gemini");
    console.log("[analyze-swing] final values — score:", finalScore,
      "spine:", finalSpineAngle, "hip:", finalHipRotation, "shoulder:", finalShoulderRotation);

    // Map drills array — one per deficiency
    const drills = toArr(report.drills).map((d) => {
      const drill = d as { name?: unknown; the_why?: unknown; the_how?: unknown; the_feel?: unknown };
      return {
        name:     toStr(drill?.name),
        the_why:  toStr(drill?.the_why),
        the_how:  toStr(drill?.the_how),
        the_feel: toStr(drill?.the_feel),
      };
    });

    // JSONB metrics blob
    const metrics = {
      spine_angle:       finalSpineAngle,
      hip_rotation:      finalHipRotation,
      shoulder_rotation: finalShoulderRotation,
      tempo_ratio:       finalTempoRatio,
      fault_tags:        toArr(report.fault_tags).map(toStr),
      drills,
      posture:           toPillar(report.posture),
      swing_plane:       toPillar(report.swing_plane),
      impact:            toPillar(report.impact),
      practice_focus:    toStr(report.practice_focus) || null,
      pro_cue:           toStr(report.pro_cue) || null,
    };

    // Map highlight objects into the JSONB shape the DB column expects
    const swing_highlights = toArr(report.highlights).map((h) => {
      const hi = h as { title?: unknown; description?: unknown };
      return {
        checkpoint:         "impact",
        positive_movement:  toStr(hi?.title),
        mechanical_benefit: toStr(hi?.description),
      };
    });

    // Map deficiency objects into the JSONB shape the DB column expects
    const mechanical_deficiencies = toArr(report.deficiencies).map((d) => {
      const def = d as { title?: unknown; description?: unknown };
      return {
        checkpoint:              "impact",
        joint_coordinate:        { joint: "general", x: 0.5, y: 0.5 },
        fault_description:       toStr(def?.title),
        corrective_drill_detail: toStr(def?.description),
        severity:                "minor",
        corrective_drill_title:  "",
      };
    });

    const tempoNumeric = parseTempoRatioToNumber(finalTempoRatio ?? "");

    const payload = {
      status:            "complete",
      score:             finalScore,
      feedback:          finalFeedback,
      spine_angle:       finalSpineAngle,
      hip_rotation:      finalHipRotation,
      shoulder_rotation: finalShoulderRotation,
      tempo_ratio:       tempoNumeric,
      metrics,
      swing_highlights,
      mechanical_deficiencies,
    };

    console.log("FINAL SUPABASE PAYLOAD:", JSON.stringify(payload));

    const { data: updated, error: updateErr } = await supabase
      .from("swing_analysis")
      .update(payload)
      .eq("id", analysisId)
      .select()
      .single();

    if (updateErr) {
      console.error("SUPABASE REJECTION:", updateErr);
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
      return NextResponse.json(
        {
          error:   `Database write failed: ${updateErr.message}`,
          details: updateErr.details ?? null,
          hint:    updateErr.hint    ?? null,
          code:    updateErr.code    ?? null,
        },
        { status: 400 },
      );
    }

    console.log("[analyze-swing] complete — score:", finalScore, "status:", updated?.status);
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
