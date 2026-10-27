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
 * 4. Fetch the raw video bytes (up to MAX_ANALYSIS_VIDEO_BYTES = 14 MB).
 *    ENT-1D: a video that cannot be loaded — missing, empty, oversized,
 *    unrecognised, or not fetchable right now — ends the request before the
 *    model is called. Client metrics never stand in for the video, and
 *    nothing is scored or stored (videoLoadRefused).
 * 5. Call Gemini 1.5 Pro with:
 *    a) A world-class PGA coach system instruction with embedded diagnostic rules
 *    b) Inline video base64
 *    c) Raw biomechanical numbers with plain-English clinical interpretations
 *    d) JSON-only response format
 * 6. Parse the JSON response, validate required fields, log any failures.
 * 7. Write results to swing_analysis and return.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  SchemaType,
  type Schema,
} from "@google/generative-ai";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { extractSwingMetrics } from "@/lib/biometrics";
import { computePuttingScoreFromAnalysisV1 } from "@/lib/putting-score-from-analysis-eq5f-e";
import { classifyAnalysisFamilyRoute } from "@/lib/analysis-family-router";
import { canUsePuttingAnalysis, type SubscriptionTier } from "@/lib/entitlements";
import {
  NO_PREMIUM_ACCESS,
  resolveAnalysisAccess,
  type AnalysisAccess,
} from "@/lib/analysis-entitlement-authority";
import {
  claimAnalysisExecution,
  markClaimOutcomeUnknown,
  markProviderDispatched,
  readExecutionState,
  releaseAnalysisClaimAsFailed,
  releaseUndispatchedClaimAsFailed,
  type ExecutionFamily,
} from "@/lib/analysis-execution-claim";
import {
  loadOwnedSwingVideo,
  MAX_ANALYSIS_VIDEO_BYTES,
  UNUSABLE_VIDEO_LOADS,
  VIDEO_UNUSABLE_COPY,
  VIDEO_UNUSABLE_STATUS,
} from "@/lib/swing-video-source";
import {
  ANALYSIS_OWNER_COLUMNS,
  readOwnedAnalysisPayloads,
  serializeAnalysisResult,
} from "@/lib/analysis-result-read-authority";
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

// ── Biomechanical interpretation rules ────────────────────────────────────────
// Each rule maps a client-reported estimate to a plain-English reading of what
// that value would indicate. ENT-1D: the values are computed on the golfer's
// device and sent with the request, so the server cannot verify them; every
// reading is framed as "if the estimate holds", never as a confirmed finding.

function buildMetricsContext(metrics: {
  spineAngle?:       number | null;
  hipRotation?:      number | null;
  shoulderRotation?: number | null;
  tempoRatio?:       string | null;
  setupSpineAngle?:  number | null;
  impactSpineAngle?: number | null;
}): string {
  const lines: string[] = [
    "=== CLIENT-REPORTED ESTIMATES: what each value would indicate (not independently verified) ===",
  ];

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
    lines.push("Spine Angle: not supplied — estimate from visual posture cues.");
  }

  // Early extension diagnosis (setup vs impact spine angle change)
  if (metrics.setupSpineAngle != null && metrics.impactSpineAngle != null) {
    const drop = metrics.setupSpineAngle - metrics.impactSpineAngle;
    if (drop > 5) {
      lines.push(`Early extension indicated by the estimates: spine angle drops ${drop.toFixed(1)}° from setup (${metrics.setupSpineAngle}°) to impact (${metrics.impactSpineAngle}°). If the video confirms it, hips are thrusting toward the ball — causes blocks, pulls, and thin strikes.`);
    } else if (drop < -5) {
      lines.push(`Standing up indicated by the estimates: spine angle increases ${Math.abs(drop).toFixed(1)}° at impact. If the video confirms it, posture is lost through the ball — causes topped shots and inconsistent contact.`);
    } else {
      lines.push(`Spine angle maintenance: the estimates show it stable within ${Math.abs(drop).toFixed(1)}° from address to impact.`);
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
    lines.push("Shoulder Rotation: not supplied — estimate from visual backswing extent.");
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
    lines.push("Hip Rotation: not supplied — estimate from visual hip position at impact.");
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
    lines.push("Tempo Ratio: not supplied — assess from visual rhythm of the swing.");
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
      description: "3-5 authoritative coaching sentences citing the estimates (named as estimates), visual observations, faults, and ball-flight patterns",
    },
    fault_tags: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "2-4 snake_case fault identifiers, e.g. early_extension, restricted_backswing",
    },
    spine_angle:       { type: SchemaType.NUMBER, description: "The client-reported estimate when one is supplied, repeated as given (put any disagreement with the video in the prose). Otherwise your own visual estimate." },
    hip_rotation:      { type: SchemaType.NUMBER, description: "The client-reported estimate when one is supplied, repeated as given (put any disagreement with the video in the prose). Otherwise your own visual estimate." },
    shoulder_rotation: { type: SchemaType.NUMBER, description: "The client-reported estimate when one is supplied, repeated as given (put any disagreement with the video in the prose). Otherwise your own visual estimate." },
    tempo_ratio:       { type: SchemaType.STRING, description: "e.g. '3.0:1'. The client-reported estimate when one is supplied, repeated as given (put any disagreement with the video in the prose). Otherwise your own visual estimate." },
    highlights: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline for this strength" },
          description: { type: SchemaType.STRING, description: "2-3 sentences citing an estimate (named as an estimate) or a visual observation" },
        },
        required: ["title", "description"],
      },
      description: "2-4 genuine strengths — each must cite a supplied estimate or a specific visual observation",
    },
    deficiencies: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline naming the fault" },
          description: { type: SchemaType.STRING, description: "3-4 sentences: estimate or visual observation (with its source) → fault → ball-flight → root cause" },
        },
        required: ["title", "description"],
      },
      description: "2-4 faults — each must follow: estimate or visual observation (with its source) → fault → ball-flight → root cause",
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
      description: "One drill per deficiency — tailored to this golfer's estimates and what the video shows",
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
player's data. If you cannot trace a claim to a supplied estimate or a visual
observation from the video, do not write it.

DIAGNOSTIC RULES (apply only where the video supports the value — no template substitution)
────────────────────────────────────────────────────────────────
• EARLY EXTENSION: spine_angle_setup − spine_angle_impact > 5° → indicates early
  extension. Cite the estimated drop and whether the video supports it. Name the resulting
  ball flight pattern.
• RESTRICTED BACKSWING: shoulder_rotation < 80° → identify the specific restricting structure
  (thoracic rotation, lead arm tension, grip pressure). State the estimate and its source.
• BODY BLOCK: hip_rotation_at_impact < 35° → diagnose arms racing the body. Name the ball
  flight (block, push-draw, or thin contact). State the estimate and its source.
• CASTING / EARLY RELEASE: tempo_ratio < 2.5 → diagnose lag loss. Name the release timing
  fault and prescribe a one-movement rehearsal drill tied to this golfer's tempo number.
• X-FACTOR DEFICIT: (shoulder_rotation − hip_rotation) < 30° → diagnose insufficient power
  differential. Reference both estimates.
Every deficiency output must follow: [estimate or visual observation, with its source] → [mechanical fault] → [ball-flight consequence] → [specific drill name].
Apply a rule only when the video supports the value it rests on.

SCORING ALGORITHM — MANDATORY DETERMINISTIC CALCULATION
──────────────────────────────────────────────────────────────────────────────────
You MUST write out the mathematical formula in the 'scoring_breakdown' field BEFORE
generating the final 'score' integer. Do NOT use intuition, prior examples, or creative
reasoning. Apply every adjustment the evidence supports and record the running total in
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

If no estimates are supplied, estimate from video, state the estimated values
explicitly in prose, and apply the same algorithm to those estimates.

HANDICAP BANDS (for context after you compute the score)
─────────────────────────────────────────────────────────
55-65: high-handicapper — systemic faults causing slices, chunks, and inconsistency
65-75: mid-handicapper — solid contact but fixable mechanical leaks
75-85: low-handicapper / near-scratch — subtle faults costing yards and dispersion
85-99: elite / tour-level — fine-tuning only

COACHING STANDARDS
──────────────────
• Name the joints, planes and swing positions involved in every observation — never write a vague "your swing plane is off". Give degrees only when they come from a supplied estimate (named as one) or are clearly readable from the video, and call a degree read from the video approximate.
• Every deficiency entry must follow the chain: [estimate or visual observation, with its source] → [mechanical fault] → [ball-flight consequence] → [root cause for this golfer].
• Every highlight entry must cite a supplied estimate or a specific visual observation — never generic praise like "good tempo".
• The drills array must contain exactly one drill per deficiency. Each drill must be tailored to THIS golfer's numbers, not a generic prescription.
• the_feel inside each drill must be a visceral, first-person kinesthetic cue tied to the identified fault — if hip_rotation is 28° the cue should describe what clearing frozen hips actually feels like for a body that has been blocking.
• executive_summary must read like a paragraph from a PGA Tour coach's assessment letter — authoritative, detailed, and specific to this golfer's data.
• The pro_cue must be the kind of one-liner a Tour coach whispers on the 18th tee (10 words max).

MEASUREMENT PROVENANCE — READ BEFORE USING ANY NUMBER
──────────────────────────────────────────────────────
Values in the CLIENT-REPORTED ESTIMATES sections were computed on the golfer's own
device from this swing and sent with the request. They are estimates, NOT independently
verified instrument measurements, and they may be wrong.
• Call them estimates in your prose (e.g. "an estimated 32° spine angle"). Never present
  them as precise, measured or verified.
• Check every estimate against the attached video. Where the video disagrees, or the value
  cannot be judged from the video, say so plainly in the relevant observation and state
  your uncertainty. Never invent agreement, and never invent a more precise number.
• Do not apply a scoring adjustment or diagnostic rule on the strength of an estimate the
  video contradicts or cannot support; say that you did not.
• In the spine_angle, hip_rotation, shoulder_rotation and tempo_ratio JSON fields, repeat a
  supplied estimate as given and put any disagreement in the prose. When no estimate is
  supplied, give your own visual estimate.
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

// ── Trusted analysis writes ──────────────────────────────────────────────────
//
// Clients hold no INSERT or UPDATE privilege on swing_analysis: a status or a
// result is a server statement, and a golfer's own session must not be able to
// author one. So every write this route makes to the table goes through the
// server-only writer, and every call site restates the two facts the elevated
// client cannot know for itself — this row, and this owner — as filters.
//
// Reads, ownership and Storage signing stay on the golfer's own session. The
// elevated client decides nothing; it only records what the caller-scoped
// checks above each write have already established.
function trustedAnalysisTable() {
  return createAdminClient().from("swing_analysis");
}

/**
 * Best-effort failure write for the full-swing path. ENT-1D: fenced by the
 * claim this request holds, so a superseded request changes nothing and a
 * completed analysis can never be turned into a failed one.
 */
async function markAnalysisFailed(
  analysisId: string,
  authenticatedUserId: string,
  claimId: string,
): Promise<void> {
  // releaseAnalysisClaimAsFailed never throws; a failed status write must not
  // replace the response the originating condition already decided.
  await releaseAnalysisClaimAsFailed({ analysisId, userId: authenticatedUserId, claimId });
}

/**
 * What a putting response may carry. The putting entitlement gate has already
 * passed when any putting response is built, so the putting class is released
 * and nothing else premium is.
 */
const PUTTING_RESULT_ACCESS: AnalysisAccess = Object.freeze({ ...NO_PREMIUM_ACCESS, puttingAnalysis: true });

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
    // ENT-1D: the explicit authorized view, never the raw owned row.
    return NextResponse.json({
      message: "Analysis complete",
      data: serializeAnalysisResult(analysisRow, PUTTING_RESULT_ACCESS),
    });
  }

  console.log("[analyze-swing] putting analysis requested");

  // ENT-1D. Set once this request holds the execution claim. Every status write
  // below is fenced by it: a superseded request writes nothing, and no failure
  // write can overwrite a completed putt.
  let puttingClaimId: string | null = null;

  const markFailed = async (): Promise<void> => {
    if (puttingClaimId === null) return;
    // Best effort, and it never throws: a failed status write must not change
    // the response the golfer already earned from the originating condition.
    // The shared release clears an undispatched lease (ENT-1D R1) and keeps a
    // dispatched one.
    await releaseAnalysisClaimAsFailed({ analysisId, userId: authenticatedUserId, claimId: puttingClaimId });
  };

  const puttingApiKey = resolveGeminiKey();
  if (!puttingApiKey) {
    // Checked before the claim, so the row is left exactly as it was found.
    return NextResponse.json(
      { error: "AI analysis is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }

  // ENT-1D. One atomic claim per putt: only the request that takes it may call
  // the model, so simultaneous requests cannot both spend a Gemini call and a
  // losing request cannot fail the winner's completed row.
  const puttingClaim = await claimAnalysisExecution({
    analysisId,
    userId: authenticatedUserId,
    family: "putting",
  });

  if (puttingClaim.outcome === "unavailable") {
    // If the server cannot record that work started, it must not spend a
    // Gemini call on a row whose state it is unable to track.
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }
  if (puttingClaim.outcome === "not_claimed") {
    return await answerUnclaimed(supabase, analysisId, authenticatedUserId, "putting", PUTTING_RESULT_ACCESS);
  }
  puttingClaimId = puttingClaim.claimId;

  // The golfer's own canonical object only, re-validated here; see
  // lib/swing-video-source.ts. No other source is ever fetched.
  const puttingVideo = analysisRow.swing_video as { storage_path?: string | null } | null;
  const videoData = await loadOwnedSwingVideo(supabase, puttingVideo?.storage_path, authenticatedUserId, MAX_ANALYSIS_VIDEO_BYTES);

  let inlineVideo: { inlineData: { mimeType: string; data: string } } | null = null;
  if (videoData.status === "ok") {
    inlineVideo = {
      inlineData: {
        mimeType: videoData.mimeType,
        data: arrayBufferToBase64(videoData.buffer),
      },
    };
  }

  if (!inlineVideo) {
    // There is no text-only putting fallback. Without the stroke itself, any
    // observation would be invention from equipment identity alone.
    console.error("[analyze-swing] putting requires video");
    return await videoLoadRefused(analysisId, authenticatedUserId, puttingClaimId, videoData.status);
  }

  // The last step before the provider: if this request no longer holds the
  // claim, it does not call the model.
  if (!(await markProviderDispatched({ analysisId, userId: authenticatedUserId, claimId: puttingClaimId }))) {
    return await dispatchRefused(analysisId, authenticatedUserId, puttingClaimId);
  }

  let puttingParsed: unknown;
  try {
    const puttingModel = new GoogleGenerativeAI(puttingApiKey).getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: PUTTING_SYSTEM_INSTRUCTION,
    });
    const equipmentContext = buildTrustedEquipmentContext(analysisRow.equipment_snapshot);
    let puttingResult;
    try {
      puttingResult = await puttingModel.generateContent({
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
    } catch (providerError) {
      // ENT-1D. No definite answer from the provider: it may have run, so the
      // putt is stalled, never released for a retry.
      if (!isDefiniteProviderRejection(providerError)) {
        await markClaimOutcomeUnknown({ analysisId, userId: authenticatedUserId, claimId: puttingClaimId });
        return stalledResponse();
      }
      throw providerError;
    }
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
        // ENT-1D: the holder's claim, proved in the row (migration 20261027120000).
        processing_claim_proof: puttingClaimId,
      })
      .eq("id", analysisId)
      .eq("user_id", authenticatedUserId)
      .eq("analysis_family", "putting")
      .eq("status", "processing")
      .eq("processing_claim_id", puttingClaimId)
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

  return NextResponse.json({
    message: "Analysis complete",
    data: serializeAnalysisResult(puttingUpdatedRows[0] as Record<string, unknown>, PUTTING_RESULT_ACCESS),
  });
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
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Valid JSON is not necessarily an object: `null` or an array would make the
  // destructuring below throw outside any handler.
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const body = rawBody as Partial<RequestBody>;
  const { analysisId, mediapipeMetrics: clientMetrics } = body;

  console.log("[analyze-swing] analysis id received");

  if (typeof analysisId !== "string" || analysisId.length === 0) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  // ── Fetch DB row + video metadata ─────────────────────────────────────────
  console.log("[analyze-swing] fetching analysis row");
  const { data: analysisRow, error: fetchErr } = await supabase
    .from("swing_analysis")
    // ENT-1C. The identity and core columns only: the result payload is read
    // by the server after ownership is proved, never by the caller's session.
    .select(`${ANALYSIS_OWNER_COLUMNS}, swing_video:swing_videos(id, club, original_filename, storage_path, mime_type, file_size)`)
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
            "Putting analysis isn't included with your current plan.",
        },
        { status: 403 },
      );
    }

    // ENT-1C. The stored putting envelope the helper's cache check reads comes
    // from the server-only payload read, bounded by this owned row and user,
    // and only after the entitlement above has passed. The putting contract
    // itself is unchanged.
    const puttingPayloads = await readOwnedAnalysisPayloads([analysisId], user.id);
    if (puttingPayloads === null) {
      return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
    }
    (analysisRow as Record<string, unknown>).putting_analysis =
      puttingPayloads.get(analysisId)?.putting_analysis ?? null;

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

  // ── ENT-1A full-swing entitlement ────────────────────────────────────────
  // Decided on the server from the caller's own users row, before anything is
  // returned or run. Full swing is open to every legitimate account, FREE
  // included; the decision also says which premium result classes this caller
  // may receive. An unreadable or unrecognised state runs nothing and returns
  // nothing — not even a stored result.
  const entitlement = await resolveAnalysisAccess(supabase, user.id);
  if (entitlement.status !== "allowed") {
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }
  const access = entitlement.access;

  // A completed analysis is answered from the stored row. Gemini is never re-run
  // for it, so a replayed or repeated request cannot spend a second model call.
  if (analysisRow.status === "complete") {
    console.log("[analyze-swing] completed analysis served from the stored row");
    return await completedResponse(analysisRow, user.id, access);
  }

  // A processing row is not answered here: the claim below decides, so a
  // live claim answers 409 and an expired claim whose holder never reached the
  // model can be recovered (ENT-1D).

  const geminiKey = resolveGeminiKey();
  console.log("[analyze-swing] Gemini key configured:", !!geminiKey);
  if (!geminiKey) {
    // Checked before the claim, so a missing key leaves the row exactly as it
    // was found instead of stranding it in processing or marking it failed.
    console.error("[analyze-swing] FATAL: no Gemini API key — set GEMINI_API_KEY or GOOGLE_AI_API_KEY in Vercel env vars");
    return NextResponse.json(
      { error: "AI analysis is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }

  // ── ENT-1A / ENT-1D atomic execution claim ──────────────────────────────
  // One conditional UPDATE takes the row for this request, with a fresh claim
  // id. Postgres re-checks the WHERE clause against the latest row version once
  // it holds the row lock, so of any number of simultaneous requests exactly
  // one takes it; every other one affects zero rows. Only the holder may call
  // Gemini, and every later write it makes is fenced by its claim id. The
  // filters restate this row, this owner and the full-swing family rather than
  // trusting the elevated client (lib/analysis-execution-claim.ts).
  const claim = await claimAnalysisExecution({ analysisId, userId: user.id, family: "full_swing" });

  if (claim.outcome === "unavailable") {
    console.error("[analyze-swing] execution claim could not be recorded");
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }

  if (claim.outcome === "not_claimed") {
    // Another request holds it, it is finished, or it cannot be started. One
    // owner-bound read decides the answer; there is no retry loop and no
    // Gemini call.
    return await answerUnclaimed(supabase, analysisId, user.id, "full_swing", access);
  }
  const claimId = claim.claimId;

  // ── Video metadata ────────────────────────────────────────────────────────
  const videoRow = analysisRow.swing_video as unknown as {
    id: string;
    club: string | null;
    original_filename: string | null;
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
  // Client-computed estimates arrive via `mediapipeMetrics` in the body; the
  // server cannot verify them and labels them as estimates in the prompt.
  // No URL is passed: the server-side call never loads a video, and
  // browser-written video_url is never a source on the server.
  console.log("[analyze-swing] calling extractSwingMetrics (server-side: will return null fields)");
  const serverMetrics = await extractSwingMetrics("");

  // Merge: client-provided values take precedence over the server no-op.
  // ENT-1A. Every client value is spliced into the model prompt, so each one
  // must be the shape the client's own estimate produces — a finite angle,
  // or a "N.N:1" tempo — or it is dropped. Free text and oversized values never
  // reach Gemini.
  const client = clientMetrics !== null && typeof clientMetrics === "object" ? clientMetrics : undefined;
  const merged = {
    spineAngle:       clientAngle(client?.spineAngle)        ?? serverMetrics.spineAngle,
    hipRotation:      clientAngle(client?.hipRotation)       ?? serverMetrics.hipRotation,
    shoulderRotation: clientAngle(client?.shoulderRotation)  ?? serverMetrics.shoulderRotation,
    tempoRatio:       clientTempoRatio(client?.tempoRatio)   ?? serverMetrics.tempoRatio,
    setupSpineAngle:  clientAngle(client?.setupSpineAngle)   ?? serverMetrics.setup.spineAngle,
    impactSpineAngle: clientAngle(client?.impactSpineAngle)  ?? serverMetrics.impact.spineAngle,
  };

  const hasRealMetrics = Object.values(merged).some((v) => v != null);
  console.log("[analyze-swing] metrics available:", hasRealMetrics);

  // ── Step 4: fetch video bytes for inline Gemini input ─────────────────────
  // Only the golfer's own canonical Storage object, re-validated and signed on
  // the golfer's session, downloaded from the configured Storage endpoint with
  // redirects refused (lib/swing-video-source.ts). There is no fallback to any
  // other URL, and none to a text-only analysis: without the swing itself,
  // every observation and score would be invented, whatever metrics the
  // client sent (ENT-1D D1).
  console.log("[analyze-swing] fetching video for inline (limit:", MAX_ANALYSIS_VIDEO_BYTES / 1_048_576, "MB)");
  const videoData = await loadOwnedSwingVideo(supabase, videoRow?.storage_path, user.id, MAX_ANALYSIS_VIDEO_BYTES);
  if (videoData.status !== "ok") {
    console.error("[analyze-swing] full swing requires video:", videoData.status);
    return await videoLoadRefused(analysisId, user.id, claimId, videoData.status);
  }
  const videoPayload = {
    inlineData: {
      mimeType: videoData.mimeType,
      data: arrayBufferToBase64(videoData.buffer),
    },
  };
  console.log("[analyze-swing] video loaded inline:", (videoData.buffer.byteLength / 1_048_576).toFixed(1), "MB");

  // ── Step 5: build Gemini request ──────────────────────────────────────────
  const metricsContext = buildMetricsContext(merged);

  // Build a clearly-labelled data block that Gemini must read before writing anything
  const exactValuesBlock = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║          GOLFER-SPECIFIC DATA — READ BEFORE WRITING          ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    `Session: ${clubLabel} ${sizeLabel}`,
    ``,
    `CLIENT-REPORTED ESTIMATES (computed on the golfer's device; not independently verified — check each against the video):`,
    merged.spineAngle       != null ? `  Spine Angle (address):    ${merged.spineAngle}°` : `  Spine Angle (address):    NOT SUPPLIED — estimate from video`,
    merged.hipRotation      != null ? `  Hip Rotation (impact):    ${merged.hipRotation}°` : `  Hip Rotation (impact):    NOT SUPPLIED — estimate from video`,
    merged.shoulderRotation != null ? `  Shoulder Rotation (top):  ${merged.shoulderRotation}°` : `  Shoulder Rotation (top):  NOT SUPPLIED — estimate from video`,
    merged.tempoRatio       != null ? `  Tempo Ratio:              ${merged.tempoRatio}` : `  Tempo Ratio:              NOT SUPPLIED — estimate from video`,
    merged.setupSpineAngle  != null && merged.impactSpineAngle != null
      ? `  Spine angle change (setup→impact): ${merged.setupSpineAngle}° → ${merged.impactSpineAngle}° (${(merged.setupSpineAngle - merged.impactSpineAngle).toFixed(1)}° drop)`
      : `  Spine angle change: insufficient frame data`,
    ``,
    `WHAT THE ESTIMATES WOULD INDICATE (confirm against the video before relying on any of it):`,
    metricsContext,
  ].join("\n");

  const userPrompt = [
    exactValuesBlock,
    ``,
    `You have the actual swing video attached. Check each client-reported estimate above against it, and add observations about grip, alignment, ball position, and anything the estimates do not capture. Where the video and an estimate disagree, or an estimate cannot be judged from the video, say so and state your uncertainty — do not force agreement and do not invent a more precise number.`,
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
    const contentParts: any[] = [videoPayload, { text: userPrompt }];

    console.log("[analyze-swing] calling gemini-2.5-flash — parts:", contentParts.length, "(video + text)");
    console.log("[analyze-swing] prompt length (chars):", userPrompt.length);

    // ENT-1D. The last step before the provider: if this request no longer
    // holds the claim, it does not call the model.
    if (!(await markProviderDispatched({ analysisId, userId: user.id, claimId }))) {
      return await dispatchRefused(analysisId, user.id, claimId);
    }

    let result;
    try {
      result = await model.generateContent({
        contents: [{ role: "user", parts: contentParts }],
        generationConfig: {
          responseMimeType: "application/json",  // required alongside responseSchema
          responseSchema:   RESPONSE_SCHEMA as Schema, // enforces structure at API level — no markdown fences possible
          temperature: 0.0,
          maxOutputTokens: 8192,
        },
      });
    } catch (providerError) {
      // ENT-1D. No definite answer from the provider: it may have run, so the
      // analysis is stalled, never released for a retry.
      if (!isDefiniteProviderRejection(providerError)) {
        console.error("[analyze-swing] provider outcome unknown");
        await markClaimOutcomeUnknown({ analysisId, userId: user.id, claimId });
        return stalledResponse();
      }
      throw providerError;
    }
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

    // Stored numeric fields keep the client-reported estimate when one was sent
    // (the model puts any disagreement with the video in the prose), else the
    // model's own visual estimate. Neither is an independently verified
    // measurement, and no column records which one a value is: see
    // docs/ENT1D_ROLLOUT_NOTES.md (measurement provenance).
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
      // ENT-1D: the holder's claim, proved in the row (migration 20261027120000).
      processing_claim_proof: claimId,
    };


    // Completes only the row this request claimed: still processing, this
    // owner, this claim. Exactly one affected row is proved rather than assumed.
    const { data: completedRows, error: updateErr } = await trustedAnalysisTable()
      .update(payload)
      .eq("id", analysisId)
      .eq("user_id", user.id)
      .eq("status", "processing")
      .eq("processing_claim_id", claimId)
      .select();

    if (updateErr || !Array.isArray(completedRows) || completedRows.length !== 1) {
      console.error("[analyze-swing] analysis completion update failed");
      await markAnalysisFailed(analysisId, user.id, claimId);
      return NextResponse.json(
        { error: "We couldn't save your analysis. Please try again." },
        { status: 400 },
      );
    }

    const completedRow = completedRows[0] as Record<string, unknown>;
    console.log("[analyze-swing] complete — status:", completedRow.status);
    // The stored row keeps every section; the response is the explicit
    // authorized view, never the raw row.
    const updated = serializeAnalysisResult(completedRow, access);
    return NextResponse.json({ message: "Analysis complete", data: updated });

  } catch {
    console.error("[analyze-swing] analysis pipeline failed");
    if (!(await releaseAnalysisClaimAsFailed({ analysisId, userId: user.id, claimId }))) {
      console.error("[analyze-swing] failed-status update also failed");
    }
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 },
    );
  }
}

// ── ENT-1A full-swing answers that never call Gemini ──────────────────────────

const FULL_SWING_UNAVAILABLE_COPY = "Analysis is temporarily unavailable. Please try again shortly.";
const IN_PROGRESS_COPY = "This analysis is already in progress. Please check back shortly.";
const NOT_STARTABLE_COPY = "This analysis can't be started right now. Please refresh and try again.";

const STALLED_COPY =
  "This analysis was interrupted after it started and can't be finished. Please record the swing again for a new analysis.";

/**
 * ENT-1D. HTTP statuses at which the provider necessarily refused the request
 * before any model ran, so a later attempt duplicates nothing:
 *
 *   401  UNAUTHENTICATED — the API key was not accepted
 *   403  PERMISSION_DENIED — the key may not call this model or method
 *   404  NOT_FOUND — the model or method does not exist
 *
 * Each is decided by authentication or routing, before a model is selected.
 *
 * Everything else is an unknown outcome and is never retried for the same
 * analysis. That deliberately includes 400 (an argument such as an
 * undecodable video may be rejected after processing began) and 429 (a rate
 * limit such as output tokens may be enforced after admission): the
 * repository holds no provider evidence that either means "no work done".
 * Also unknown: 408 and 499 (deadline / cancellation), every 5xx, any other
 * or missing status, and every non-HTTP error (transport failure, abort,
 * timeout, body read failure). Widening this list needs provider evidence.
 */
const DEFINITE_REJECTION_STATUSES: readonly number[] = [401, 403, 404];

/**
 * True only for a non-OK HTTP response the SDK actually received
 * (GoogleGenerativeAIFetchError carries its status) whose status is on the
 * allow-list above. Matched by class, not by name: the SDK does not set error
 * names.
 *
 * A response that arrived in full but is unusable (blocked, bad finish reason,
 * not JSON) is a different, known outcome: the SDK raises it from
 * response.text(), and JSON.parse from the body, after this call returns, so
 * it never reaches this classifier and is released as a definite failure.
 * Nothing here claims exactly-once provider execution.
 */
function isDefiniteProviderRejection(error: unknown): boolean {
  return (
    error instanceof GoogleGenerativeAIFetchError &&
    typeof error.status === "number" &&
    DEFINITE_REJECTION_STATUSES.includes(error.status)
  );
}

/**
 * The family as the router defines it, for the owner-scoped re-read: the
 * explicit value, or null on legacy full-swing rows.
 */
const FAMILY_FILTER: Record<ExecutionFamily, string> = {
  full_swing: "analysis_family.is.null,analysis_family.eq.full_swing",
  putting: "analysis_family.eq.putting",
};

/** A client-computed angle estimate in degrees, or null when it is not one. */
function clientAngle(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= -360 && value <= 360 ? value : null;
}

/** A client-computed tempo estimate in the "N.N:1" form lib/biometrics produces, or null. */
function clientTempoRatio(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,2}(\.\d{1,2})?:1$/.test(value) ? value : null;
}

/**
 * A stored, completed row as this caller may see it: the owned columns plus
 * the server-read payload, through the shared serializer. The joined video
 * never enters the view.
 */
async function completedResponse(
  row: Record<string, unknown>,
  authenticatedUserId: string,
  access: AnalysisAccess,
): Promise<NextResponse> {
  // The owner is the verified caller, never a value taken from the row; a row
  // that does not belong to them is refused before any elevated read.
  const id = typeof row.id === "string" ? row.id : "";
  if (id.length === 0 || row.user_id !== authenticatedUserId) {
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }
  const payloads = await readOwnedAnalysisPayloads([id], authenticatedUserId);
  if (payloads === null) {
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }
  const updated = serializeAnalysisResult({ ...row, ...payloads.get(id) }, access);
  return NextResponse.json({ message: "Analysis complete", data: updated });
}

function inProgressResponse(): NextResponse {
  return NextResponse.json({ error: IN_PROGRESS_COPY, status: "processing" }, { status: 409 });
}

/**
 * ENT-1D. The holder reached the provider and then stopped reporting: the
 * provider outcome is unknown, so the analysis is never re-run automatically
 * (lib/analysis-execution-claim.ts).
 */
function stalledResponse(): NextResponse {
  return NextResponse.json({ error: STALLED_COPY, status: "stalled" }, { status: 409 });
}

/**
 * The dispatch mark was not confirmed, so the model is not called. The
 * refusal may have been an outage, a takeover, or a write that persisted but
 * whose response was lost — the three cannot be told apart here. The claim is
 * released as failed only if it is still this request's AND no dispatch is
 * recorded for it; then nothing reached the provider and a retry is safe.
 * Otherwise the row is left alone: in progress, then stalled for an operator,
 * never automatically re-runnable.
 */
async function dispatchRefused(
  analysisId: string,
  authenticatedUserId: string,
  claimId: string,
): Promise<NextResponse> {
  if (await releaseUndispatchedClaimAsFailed({ analysisId, userId: authenticatedUserId, claimId })) {
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }
  return inProgressResponse();
}

/**
 * ENT-1D D1. The golfer's video could not be loaded, so nothing is analysed.
 * Reached before the dispatch mark: no provider call has been made and none
 * is made now. Only an undispatched claim this request still holds is
 * released, lease cleared; nothing is scored or stored, and a completed
 * analysis is never touched (the release is fenced to this request's
 * processing claim).
 *
 * Two answers, because the golfer's way forward differs:
 *   - the video itself is unusable (no object, empty, oversized, not a
 *     recognised video): 422 `video_unusable`, and the copy asks for a new
 *     upload — re-sending the same object cannot help;
 *   - the service could not fetch it (signing, an untrusted URL, a failed or
 *     timed-out download): 503 with the temporary-unavailability copy, and a
 *     retry of the same video may succeed.
 */
async function videoLoadRefused(
  analysisId: string,
  authenticatedUserId: string,
  claimId: string,
  loadStatus: string,
): Promise<NextResponse> {
  if (!(await releaseUndispatchedClaimAsFailed({ analysisId, userId: authenticatedUserId, claimId }))) {
    return inProgressResponse();
  }
  if (UNUSABLE_VIDEO_LOADS.has(loadStatus)) {
    return NextResponse.json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, { status: 422 });
  }
  return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
}

/** The single answer for a request that did not get the claim. */
async function answerUnclaimed(
  supabase: RouteSupabaseClient,
  analysisId: string,
  authenticatedUserId: string,
  family: ExecutionFamily,
  access: AnalysisAccess,
): Promise<NextResponse> {
  const state = await readExecutionState({ analysisId, userId: authenticatedUserId, family });
  switch (state) {
    case "in_progress":
      return inProgressResponse();
    case "stalled":
      return stalledResponse();
    case "not_startable":
    case "not_found":
      return NextResponse.json({ error: NOT_STARTABLE_COPY }, { status: 409 });
    case "unavailable":
      return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
    case "complete":
      break;
  }
  // Finished by another request: answer from the stored result, read as on
  // every other path: owned columns on the caller's session, payload on the
  // server.
  try {
    const { data, error } = await supabase
      .from("swing_analysis")
      .select(ANALYSIS_OWNER_COLUMNS)
      .eq("id", analysisId)
      .eq("user_id", authenticatedUserId)
      .or(FAMILY_FILTER[family])
      .maybeSingle();
    const current = data as Record<string, unknown> | null;
    if (error || current?.status !== "complete") {
      return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
    }
    return await completedResponse(current, authenticatedUserId, access);
  } catch {
    return NextResponse.json({ error: FULL_SWING_UNAVAILABLE_COPY }, { status: 503 });
  }
}
