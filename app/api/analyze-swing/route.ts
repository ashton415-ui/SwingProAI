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
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { extractSwingMetrics } from "@/lib/biometrics";
import { computePuttingScoreFromAnalysisV1 } from "@/lib/putting-score-from-analysis-eq5f-e";
import { classifyAnalysisFamilyRoute } from "@/lib/analysis-family-router";
import { canUsePuttingAnalysis, type SubscriptionTier } from "@/lib/entitlements";
import {
  PUTTING_RESPONSE_SCHEMA,
  PUTTING_SYSTEM_INSTRUCTION,
  buildPersistedPuttingAnalysis,
  buildPuttingUserPrompt,
  buildTrustedEquipmentContext,
  isPersistedPuttingAnalysisV1,
  validatePuttingModelResponse,
} from "@/lib/putting-analysis-contract";

export const maxDuration = 300;

/** Single home of the credential precedence, so the putting branch cannot
 *  drift from the full-swing path. Pure: it never logs the value. */
function resolveGeminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
}

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
  } catch {
    console.warn("[analyze-swing] video fetch error");
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

// ── Native Structured Output schema ──────────────────────────────────────────
// Passed to generationConfig.responseSchema — Gemini enforces every field type
// and shape at the API level, so no markdown fences can ever appear in the
// response and JSON.parse() receives a clean string every time.

const pillarSchema = {
  type: SchemaType.OBJECT,
  properties: {
    rating:      { type: SchemaType.STRING, enum: ["excellent", "good", "needs_work", "poor"] },
    observation: { type: SchemaType.STRING },
    correction:  { type: SchemaType.STRING },
  },
  required: ["rating", "observation", "correction"],
};

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    scoring_breakdown: {
      type: SchemaType.STRING,
      description: "Show your math. Start at a baseline of 75 and list every addition and deduction based on the rubric. E.g., '75 + 5 (Shoulders) - 5 (Early Ext) - 3 (Laid off) = 72'.",
    },
    score: {
      type: SchemaType.INTEGER,
      description: "The exact final integer calculated in the scoring_breakdown.",
    },
    executive_summary: {
      type: SchemaType.STRING,
      description: "3-5 authoritative coaching sentences citing exact measurements, faults, and ball-flight patterns",
    },
    fault_tags: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "2-4 snake_case fault identifiers, e.g. early_extension, restricted_backswing",
    },
    spine_angle:       { type: SchemaType.NUMBER, description: "Echo exact measured value — do not re-estimate" },
    hip_rotation:      { type: SchemaType.NUMBER, description: "Echo exact measured value — do not re-estimate" },
    shoulder_rotation: { type: SchemaType.NUMBER, description: "Echo exact measured value — do not re-estimate" },
    tempo_ratio:       { type: SchemaType.STRING, description: "e.g. '3.0:1' — echo measured value or estimate from video" },
    highlights: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline for this strength" },
          description: { type: SchemaType.STRING, description: "2-3 sentences citing measured data" },
        },
        required: ["title", "description"],
      },
      description: "2-4 genuine strengths — each must cite a measured value or specific visual observation",
    },
    deficiencies: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline naming the fault" },
          description: { type: SchemaType.STRING, description: "3-4 sentences: measurement → fault → ball-flight → root cause" },
        },
        required: ["title", "description"],
      },
      description: "2-4 faults — each must follow: measurement → fault → ball-flight → root cause",
    },
    drills: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name:     { type: SchemaType.STRING, description: "Official drill name, e.g. Wall Hip Drill" },
          the_why:  { type: SchemaType.STRING, description: "2-3 sentences: biomechanical reason this drill fixes THIS golfer's fault" },
          the_how:  { type: SchemaType.STRING, description: "3-5 sentences of step-by-step execution with reps and tempo" },
          the_feel: { type: SchemaType.STRING, description: "1-2 sentences: vivid first-person kinesthetic cue unique to this golfer's data" },
        },
        required: ["name", "the_why", "the_how", "the_feel"],
      },
      description: "One drill per deficiency — tailored to this golfer's exact measurements",
    },
    posture:     pillarSchema,
    swing_plane: pillarSchema,
    impact:      pillarSchema,
    practice_focus: {
      type: SchemaType.STRING,
      description: "Single highest-priority drill prescription with reps and timeline",
    },
    pro_cue: {
      type: SchemaType.STRING,
      description: "One elite swing thought in 10 words or fewer",
    },
  },
  required: [
    "scoring_breakdown", "score", "executive_summary", "fault_tags",
    "spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio",
    "highlights", "deficiencies", "drills",
    "posture", "swing_plane", "impact",
    "practice_focus", "pro_cue",
  ],
};

// ── System instruction ────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
You are an elite, world-renowned PGA Tour swing coach with 25+ years of experience on Tour, certified in biomechanics analysis, kinematic sequencing, and TrackMan data interpretation. Your students have won multiple major championships. You deliver brutally honest, technically precise coaching reports that elite players and serious amateurs rely on.

PERSONA & EXPERTISE
────────────────────
Analyze every swing through the lens of biomechanics, kinematic sequencing, and ground reaction forces — the same framework used by leading Tour instructors. Use the P-System throughout your report (P1 = Address, P2 = Club parallel to ground on takeaway, P3 = Lead arm parallel to ground, P4 = Top of backswing, P5 = Club parallel to ground on downswing, P6 = Impact, P7 = Club parallel to ground on follow-through, P8 = Finish).

Always distinguish ROOT CAUSES from SYMPTOMS: early extension is usually a compensation for a steep shaft or an over-the-top downswing path; a cupped wrist at the top is often a symptom of grip pressure or takeaway timing, not a standalone fault. Explain the causal chain, not just the outcome.

When relevant, compare the golfer's numbers to PGA Tour averages (e.g., Tour average shoulder rotation: 90°, Tour average hip clearance at impact: 45°, Tour average tempo ratio: 3:1). This context transforms raw data into actionable insight.

When providing drills, always include a vivid, elite KINESTHETIC CUE or SWING THOUGHT — the kind of feel-based trigger that bypasses conscious thought and produces instant motor change (e.g., "feel the handle lead like a drawn bow before releasing," "sense the left hip pocket moving toward the target before the club reaches P3").

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

SCORING ALGORITHM — MANDATORY DETERMINISTIC CALCULATION
──────────────────────────────────────────────────────────────────────────────────
You MUST write out the mathematical formula in the 'scoring_breakdown' field BEFORE
generating the final 'score' integer. Do NOT use intuition, prior examples, or creative
reasoning. Apply every applicable adjustment mechanically and record the running total in
scoring_breakdown. The 'score' field must equal the final number you arrive at in
scoring_breakdown — any mismatch is an error.

STEP 1 — Start at baseline 75 (a functional amateur swing with no glaring faults).

STEP 2 — ADD points for exceptional metrics:
• Shoulder rotation ≥ 90°: +5 pts
• Hip rotation at impact ≥ 45°: +5 pts
• X-Factor (shoulder − hip separation) ≥ 45°: +5 pts
• Tempo ratio in ideal 2.8–3.5 range: +3 pts
• Spine angle maintained from setup to impact (< 3° change): +3 pts

STEP 3 — DEDUCT points for faults:
• Severe early extension (spine drop > 8°): −8 pts
• Moderate early extension (spine drop 5–8°): −5 pts
• Severely restricted backswing (shoulder rotation < 70°): −8 pts
• Moderately restricted backswing (shoulder rotation 70–80°): −5 pts
• Severe body block (hip rotation < 30°): −8 pts
• Moderate body block (hip rotation 30–40°): −5 pts
• Laid-off club at P4: −3 pts
• Over-the-top downswing path: −5 pts
• Casting / early release (tempo ratio < 2.5): −5 pts
• Cupped lead wrist at top: −3 pts
• Reverse pivot: −8 pts
• Minor alignment or grip issue: −2 pts

Each fault tagged in the deficiencies array must map to exactly one deduction above.
Do NOT double-count: if a fault is already captured by a STEP 2 metric (e.g. spine drop
penalised as early extension), do not apply a separate STEP 3 deduction for the same
root issue — take the larger of the two.

STEP 4 — Clamp: Floor 55, Ceiling 99. Round to the nearest integer.

VERIFICATION REQUIREMENT: The scoring_breakdown string must show the full chain,
  e.g. "75 + 5 (Shoulders) - 5 (Early Ext) - 3 (Laid off) = 72".
  Copy the final clamped integer verbatim into the score field.

If measurements are unavailable, estimate from video, state the estimated values
explicitly in prose, and apply the same algorithm to those estimates.

HANDICAP BANDS (for context after you compute the score)
─────────────────────────────────────────────────────────
55-65: high-handicapper — systemic faults causing slices, chunks, and inconsistency
65-75: mid-handicapper — solid contact but fixable mechanical leaks
75-85: low-handicapper / near-scratch — subtle faults costing yards and dispersion
85-99: elite / tour-level — fine-tuning only

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
`.trim();

// ── EQ5C-B subscription-tier narrowing ───────────────────────────────────────
//
// The tier arrives from a database column, so it is untrusted transport however
// the type system describes it. It is recognised by a positive allow-list and
// narrowed by a real type guard: an unknown, renamed or malformed value can
// never reach canUsePuttingAnalysis, and there is no cast that could grant
// access to one. A missing member here fails closed, which is the safe
// direction.
//
// This lives above the putting pipeline rather than beside it because it is
// POST-handler infrastructure, not part of runPuttingAnalysis — and the gate it
// serves has to sit outside that helper to be worth anything.

const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  "par",
  "birdie",
  "eagle",
  "coach_starter",
  "coach_pro",
  "none",
];

function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && SUBSCRIPTION_TIERS.some((tier) => tier === value);
}

// ── EQ5B-S1 putting pipeline ─────────────────────────────────────────────────
//
// Reached only when the database-authored family on the owned row is "putting".
// It shares infrastructure with full swing — auth, the owned row, the video
// helper, the SDK — but none of its semantics: no client metrics, no MediaPipe,
// no biomechanics, no score. An uncalibrated phone video supports qualitative
// observation only, so nothing here writes the numeric putting columns.

type RouteSupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function runPuttingAnalysis(
  supabase: RouteSupabaseClient,
  analysisRow: Record<string, unknown>,
  analysisId: string,
  authenticatedUserId: string,
): Promise<NextResponse> {
  // A complete row is only reusable when its stored payload still satisfies the
  // current envelope AND the current safety rules, so a payload written by an
  // older or looser validator can never be served from cache.
  if (
    analysisRow.status === "complete" &&
    isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)
  ) {
    console.log("[analyze-swing] putting cache hit");
    return NextResponse.json({ message: "Analysis complete", data: analysisRow });
  }

  console.log("[analyze-swing] putting analysis requested");

  const markFailed = async (): Promise<void> => {
    try {
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    } catch {
      // Best effort. A failed status write must not change the response the
      // golfer already earned from the originating condition.
    }
  };

  const puttingApiKey = resolveGeminiKey();
  if (!puttingApiKey) {
    await markFailed();
    return NextResponse.json(
      { error: "AI analysis is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }

  const { error: puttingProcessingError } = await supabase
    .from("swing_analysis")
    .update({ status: "processing" })
    .eq("id", analysisId);

  if (puttingProcessingError) {
    // Full swing logs this and continues. Putting deliberately does not: if the
    // server cannot record that work started, it must not spend a Gemini call on
    // a row whose state it is unable to track.
    await markFailed();
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }

  const puttingVideo = analysisRow.swing_video as { storage_path?: string | null } | null;
  const storagePath =
    typeof puttingVideo?.storage_path === "string" ? puttingVideo.storage_path : null;

  let inlineVideo: { inlineData: { mimeType: string; data: string } } | null = null;
  if (storagePath) {
    const { data: signed } = await supabase.storage
      .from("swing-videos")
      .createSignedUrl(storagePath, 3600);
    if (signed?.signedUrl) {
      const videoData = await fetchVideoBytes(signed.signedUrl, MAX_INLINE_VIDEO_BYTES);
      if (videoData) {
        inlineVideo = {
          inlineData: {
            mimeType: videoData.mimeType,
            data: arrayBufferToBase64(videoData.buffer),
          },
        };
      }
    }
  }

  if (!inlineVideo) {
    // There is no text-only putting fallback. Without the stroke itself, any
    // observation would be invention from equipment identity alone.
    console.error("[analyze-swing] putting requires video");
    await markFailed();
    return NextResponse.json(
      { error: "We couldn't read your video. Please try again." },
      { status: 500 },
    );
  }

  let puttingParsed: unknown;
  try {
    const puttingModel = new GoogleGenerativeAI(puttingApiKey).getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: PUTTING_SYSTEM_INSTRUCTION,
    });
    const equipmentContext = buildTrustedEquipmentContext(analysisRow.equipment_snapshot);
    const puttingResult = await puttingModel.generateContent({
      contents: [
        {
          role: "user",
          parts: [inlineVideo, { text: buildPuttingUserPrompt(equipmentContext) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PUTTING_RESPONSE_SCHEMA,
        temperature: 0.0,
        maxOutputTokens: 4096,
      },
    });
    // Deliberately not named rawText, and never logged.
    const puttingRawText = puttingResult.response.text();
    puttingParsed = JSON.parse(puttingRawText);
  } catch {
    await markFailed();
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }

  const puttingValidated = validatePuttingModelResponse(puttingParsed);
  if (!puttingValidated.ok) {
    // The rejection reason is an internal diagnostic: never logged, never returned.
    console.error("[analyze-swing] putting response rejected");
    await markFailed();
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }

  const persistedPuttingAnalysis = buildPersistedPuttingAnalysis(puttingValidated.response);

  // EQ5F-E. The score is derived from the envelope that is about to be stored,
  // by composing the existing deterministic authorities. A null here means the
  // pipeline refused its own input — a failure, and a different fact from a
  // valid envelope whose score is null because no section was scorable. The
  // reason stays internal, like every other putting rejection on this route.
  const puttingScore = computePuttingScoreFromAnalysisV1(persistedPuttingAnalysis, analysisId);

  if (puttingScore === null) {
    console.error("[analyze-swing] putting score unavailable");
    await markFailed();
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }

  // EQ5F-E. The completion write is the one privileged step on this route. The
  // score is a server statement about the stroke, and the database refuses a
  // first write that did not come from the trusted server role — so this single
  // UPDATE runs as service_role while everything above it (auth, ownership,
  // family, entitlement, validation) has already been decided by the golfer's
  // own client. The filters restate every one of those facts rather than trust
  // the elevated client: this row, this owner, this family, and only while no
  // score has been recorded yet.
  let puttingUpdatedRows: unknown = null;
  let puttingSaveFailed = false;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("swing_analysis")
      .update({
        status: "complete",
        putting_analysis: persistedPuttingAnalysis,
        putting_score: puttingScore,
      })
      .eq("id", analysisId)
      .eq("user_id", authenticatedUserId)
      .eq("analysis_family", "putting")
      .is("putting_score", null)
      .select();

    puttingUpdatedRows = data;
    puttingSaveFailed = Boolean(error);
  } catch {
    // A missing service-role configuration throws on construction. That is a
    // failure to complete, never a silent success.
    puttingSaveFailed = true;
  }

  // Exactly one row, proved rather than assumed. Zero rows is the interesting
  // case: it means the row moved, was never this golfer's, was not a putt, or
  // already carries a score — none of which may be reported as a completion.
  if (
    puttingSaveFailed ||
    !Array.isArray(puttingUpdatedRows) ||
    puttingUpdatedRows.length !== 1
  ) {
    console.error("[analyze-swing] putting completion write did not affect exactly one row");
    await markFailed();
    return NextResponse.json(
      { error: "We couldn't save your analysis. Please try again." },
      { status: 400 },
    );
  }

  return NextResponse.json({ message: "Analysis complete", data: puttingUpdatedRows[0] });
}


// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[analyze-swing] POST received");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  console.log("[analyze-swing] authenticated:", !authError && !!user);

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

  console.log("[analyze-swing] analysis id received");

  if (!analysisId) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  // ── Fetch DB row + video metadata ─────────────────────────────────────────
  console.log("[analyze-swing] fetching analysis row");
  const { data: analysisRow, error: fetchErr } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(id, club, original_filename, video_url, storage_path, mime_type, file_size)")
    .eq("id", analysisId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !analysisRow) {
    console.error("[analyze-swing] analysis row fetch failed");
    return NextResponse.json({ error: "Analysis record not found." }, { status: 404 });
  }

  // ── EQ5A server analysis router ──────────────────────────────────────────
  // Routed from the database-authored family on the owned row, never from the
  // request. This sits before the row-status log, the complete-row rerun
  // warning and the processing update, so a refused request leaves the row
  // exactly as it was found and emits no claim that Gemini is being re-run.
  const analysisRoute = classifyAnalysisFamilyRoute(analysisRow.analysis_family);

  if (analysisRoute === "putting_pipeline") {
    // EQ5C-B execution entitlement. Putting analysis is a paid capability, and
    // this is the boundary that decides whether the work may run at all — the
    // result page's own check decides only what may be displayed.
    //
    // The tier is read here, from the authenticated user's own row, because the
    // request cannot be trusted to describe what its sender has paid for. Only
    // subscription_tier is selected: nothing else about the golfer is needed to
    // answer this question.
    //
    // The gate sits outside runPuttingAnalysis on purpose. Every putting side
    // effect lives inside that helper — the cached-result early return first of
    // all — so refusing before the call is what stops an unentitled golfer from
    // reading back a premium result that a paid period once produced.
    let currentTier: SubscriptionTier | null = null;
    try {
      const { data: profile, error: tierError } = await supabase
        .from("users")
        .select("subscription_tier")
        .eq("id", user.id)
        .single();

      const storedTier: unknown = profile?.subscription_tier;
      if (!tierError && isSubscriptionTier(storedTier)) {
        currentTier = storedTier;
      }
    } catch {
      // A thrown query must not fall through into execution as an absent tier
      // would; both land on the same fail-closed branch below.
      currentTier = null;
    }

    if (currentTier === null) {
      // Missing row, query error, or an unrecognised value. The golfer is told
      // nothing about which: the reason is a server concern, and the copy is
      // the route's existing generic failure text.
      return NextResponse.json(
        { error: "Analysis failed. Please try again." },
        { status: 500 },
      );
    }

    if (!canUsePuttingAnalysis(currentTier)) {
      return NextResponse.json(
        {
          error:
            "Putting analysis isn't included with your current plan. Upgrade to unlock putting analysis.",
        },
        { status: 403 },
      );
    }

    return await runPuttingAnalysis(supabase, analysisRow, analysisId, user.id);
  }

  if (analysisRoute === "unsupported_family") {
    // Fixed literal: the unrecognized value is never logged or returned.
    console.error("[analyze-swing] unsupported analysis family");
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 },
    );
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
    console.error("[analyze-swing] mark-processing update failed");
  }

  const geminiKey = resolveGeminiKey();
  console.log("[analyze-swing] Gemini key configured:", !!geminiKey);
  if (!geminiKey) {
    console.error("[analyze-swing] FATAL: no Gemini API key — set GEMINI_API_KEY or GOOGLE_AI_API_KEY in Vercel env vars");
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json(
      { error: "AI analysis is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
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
  console.log("[analyze-swing] metrics available:", hasRealMetrics);

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
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    // Build explicit content parts so the SDK never misinterprets a bare string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentParts: any[] = [];
    if (videoPayload) contentParts.push(videoPayload);
    contentParts.push({ text: userPrompt });

    console.log("[analyze-swing] calling gemini-2.5-flash — parts:", contentParts.length, videoPayload ? "(video + text)" : "(text only)");
    console.log("[analyze-swing] prompt length (chars):", userPrompt.length);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: contentParts }],
      generationConfig: {
        responseMimeType: "application/json",  // required alongside responseSchema
        responseSchema:   RESPONSE_SCHEMA as Schema, // enforces structure at API level — no markdown fences possible
        temperature: 0.0,
        maxOutputTokens: 8192,
      },
    });
    const rawText = result.response.text();

    // responseSchema guarantees clean JSON — log length so we can verify in Vercel
    console.log("[analyze-swing] Gemini response length (chars):", rawText.length);

    // ── Step 6: parse + validate ──────────────────────────────────────────
    let report: {
      scoring_breakdown: string;
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
      // responseSchema means rawText is always valid JSON — no brace-extraction needed.
      report = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("[analyze-swing] JSON parse failure");
      throw new Error(`Gemini returned non-JSON response: ${String(parseErr)}`);
    }

    // Validate the hard-required fields — these are non-negotiable for a valid analysis
    const requiredFields = [
      "scoring_breakdown", "score", "executive_summary", "fault_tags",
      "spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio",
      "highlights", "deficiencies", "drills",
      "posture", "swing_plane", "impact",
      "practice_focus", "pro_cue",
    ] as const;

    const missing = requiredFields.filter((f) => report[f] == null);
    if (missing.length > 0) {
      console.error("[analyze-swing] response missing required fields:", missing.join(", "));
      throw new Error(`Gemini response missing required fields: ${missing.join(", ")}`);
    }

    // drills is required but gracefully handle if absent
    if (!report.drills || !Array.isArray(report.drills) || report.drills.length === 0) {
      console.warn("[analyze-swing] drills array missing or empty — storing without drills");
    }


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
      scoring_breakdown: toStr(report.scoring_breakdown) || null,
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


    const { data: updated, error: updateErr } = await supabase
      .from("swing_analysis")
      .update(payload)
      .eq("id", analysisId)
      .select()
      .single();

    if (updateErr) {
      console.error("[analyze-swing] analysis completion update failed");
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
      return NextResponse.json(
        { error: "We couldn't save your analysis. Please try again." },
        { status: 400 },
      );
    }

    console.log("[analyze-swing] complete — status:", updated?.status);
    return NextResponse.json({ message: "Analysis complete", data: updated });

  } catch {
    console.error("[analyze-swing] analysis pipeline failed");
    try {
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    } catch {
      console.error("[analyze-swing] failed-status update also failed");
    }
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 },
    );
  }
}
