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
 * 3. Accept only well-formed client-supplied estimates. The server cannot
 *    verify where they came from, so they are unverified: shown to the model
 *    as client-supplied estimates and recorded beside the AI's own values,
 *    never in place of them (S6-R1, S6-R1A).
 * 4. Fetch the raw video bytes (up to MAX_ANALYSIS_VIDEO_BYTES = 14 MB).
 *    ENT-1D: a video that cannot be loaded — missing, empty, oversized,
 *    unrecognised, or not fetchable right now — ends the request before the
 *    model is called. Client metrics never stand in for the video, and
 *    nothing is scored or stored (videoLoadRefused).
 * 5. Call gemini-2.5-flash once (lib/gemini-transport.ts) with:
 *    a) an evidence-first system instruction: no credentials, no uncited
 *       targets, no forced numbers or causes, an explicit "cannot judge" path
 *    b) Inline video base64
 *    c) Any client estimates, labelled unverified
 *    d) JSON-only response format
 * 6. Complete only on an explicit STOP (lib/gemini-completion-policy.ts), then
 *    parse and validate the whole object (lib/full-swing-analysis-contract.ts).
 * 7. Write results to swing_analysis and return. An analysis the video cannot
 *    score completes with score null, never a default.
 */

import { NextRequest, NextResponse } from "next/server";
import { SchemaType, type Schema } from "@google/generative-ai";
import { GeminiHttpError, generateContentOnce, responseText } from "@/lib/gemini-transport";
import {
  describeGeminiResponse,
  logGeminiResponseDiagnostics,
  withRejectionCode,
  withTextLength,
  type GeminiResponseDiagnostics,
  type ResponseOutcome,
} from "@/lib/gemini-response-diagnostics";
import { decideProviderCompletion } from "@/lib/gemini-completion-policy";
import {
  PILLAR_RATINGS,
  buildMetricEvidence,
  validateFullSwingModelResponse,
} from "@/lib/full-swing-analysis-contract";
import {
  CAMERA_VIEWS,
  DETAIL_VISIBILITY,
  FINDING_STATUSES,
  POSITION_VISIBILITY,
  QUALITATIVE_ITEM_IDS,
  SWING_DETAILS,
  SWING_POSITIONS,
  THRESHOLD_MEASURES,
} from "@/lib/full-swing-scoring-rubric";
import { resolveRouteAuth, type AuthenticatedCaller } from "@/utils/supabase/server";
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
   * Client-supplied estimates (field name kept for compatibility). The server
   * cannot verify where they came from or how they were produced, so they are
   * unverified: listed to the model as such and stored beside, never in place
   * of, the AI's own values (S6-R1A). All fields are optional.
   */
  mediapipeMetrics?: {
    spineAngle?:        number | null;
    hipRotation?:       number | null;
    shoulderRotation?:  number | null;
    tempoRatio?:        string | null;
    setupSpineAngle?:   number | null;   // listed to the model as an unverified pair
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

// ── Client-supplied estimates for the prompt ─────────────────────────────────
// ENT-1D S6-R1/S6-R1A. Values a client sent with the request. The server
// cannot verify where they came from or how they were produced, so they are
// listed as client-supplied estimates, unverified, and nothing more: no ranges,
// ratings, benchmarks or implied causes are attached, and the model is told to
// check each against the video.

function buildMetricsContext(metrics: {
  spineAngle?:       number | null;
  hipRotation?:      number | null;
  shoulderRotation?: number | null;
  tempoRatio?:       string | null;
  setupSpineAngle?:  number | null;
  impactSpineAngle?: number | null;
}): string {
  const supplied: string[] = [];
  if (metrics.spineAngle != null)       supplied.push(`  Spine angle at address: ${metrics.spineAngle}°`);
  if (metrics.shoulderRotation != null) supplied.push(`  Shoulder rotation at the top: ${metrics.shoulderRotation}°`);
  if (metrics.hipRotation != null)      supplied.push(`  Hip rotation at impact: ${metrics.hipRotation}°`);
  if (metrics.tempoRatio != null)       supplied.push(`  Tempo ratio (backswing:downswing): ${metrics.tempoRatio}`);
  if (metrics.setupSpineAngle != null && metrics.impactSpineAngle != null) {
    supplied.push(`  Spine angle at setup / at impact: ${metrics.setupSpineAngle}° / ${metrics.impactSpineAngle}°`);
  }
  if (supplied.length === 0) {
    return "CLIENT-SUPPLIED ESTIMATES: none were supplied. Use only what the video shows.";
  }
  return [
    "CLIENT-SUPPLIED ESTIMATES (sent with the request; unverified — the server cannot verify where they came from, and they may be wrong):",
    ...supplied,
    "Check each against the video. Mention one only as a client-supplied estimate (unverified), say plainly where the video disagrees or cannot show it, and do not apply a scoring adjustment or a diagnosis on a client-supplied estimate alone. Do not copy any of them into the JSON estimate fields.",
  ].join("\n");
}

// ── Native Structured Output schema ──────────────────────────────────────────
// Passed to generationConfig.responseSchema — Gemini enforces every field type
// and shape at the API level, so no markdown fences can ever appear in the
// response and JSON.parse() receives a clean string every time.

// ENT-1D S6-R1. Nullable means "the video does not support a value": the
// model may say so instead of inventing one, and the route validates the
// whole object (lib/full-swing-analysis-contract.ts) before anything is kept.
//
// Server-authoritative scoring (provider contract fs-provider-v2): the model
// reports what the video lets it see and judge; it never writes the score, the
// scoring breakdown or fault tags, and never sees the rubric's points or
// numeric cutoffs. The server applies the rubric (lib/full-swing-scoring-rubric.ts).
const pillarSchema = {
  type: SchemaType.OBJECT,
  properties: {
    rating:      { type: SchemaType.STRING, enum: [...PILLAR_RATINGS] },
    observation: { type: SchemaType.STRING, description: "What the video shows for this area, or what it does not let you see when the rating is insufficient_evidence." },
    correction:  { type: SchemaType.STRING, description: "One supportable adjustment for what you observed. Required when the rating is needs_work or poor. May be empty when the rating is good, excellent or insufficient_evidence; never invent an adjustment to fill it." },
  },
  required: ["rating", "observation", "correction"],
};

const estimateDescription = (what: string) =>
  `Your own approximate estimate from the video of ${what}, in whole degrees, or null when the video does not show it clearly. Never guess to fill the field, and do not copy a client-supplied estimate.`;

const positionSchema = (what: string) => ({
  type: SchemaType.OBJECT,
  description: what,
  properties: {
    visible: { type: SchemaType.STRING, enum: [...POSITION_VISIBILITY], description: "yes when the video shows this moment clearly; no when it is not in the video; unclear when you cannot tell." },
    at:      { type: SchemaType.STRING, nullable: true, description: "The approximate video time of this moment as M:SS, M:SS.s or M:SS.ss (one or two minute digits; seconds 00 to 59), only when visible is yes; otherwise null. It must be later than the time of every earlier moment you timed; only takeaway_start may share the time of address." },
  },
  required: ["visible", "at"],
});

const thresholdAssessmentSchema = (what: string) => ({
  type: SchemaType.OBJECT,
  description: what,
  properties: {
    assessable: { type: SchemaType.BOOLEAN, description: "true only when the video shows this turn clearly enough for your estimate to be used and every requirement listed for this turn is met; otherwise false." },
    basis:      { type: SchemaType.STRING, nullable: true, description: "When assessable: what you see that supports your estimate. Otherwise null." },
  },
  required: ["assessable", "basis"],
});

// Evidence first, the scorability statement last: declarations of what the
// video shows, the AI's own estimates and assessments, the pillar and rubric
// findings, then the coaching and, last, whether the rubric can be applied.
// propertyOrdering is the documented Schema field that sets the order of the
// properties in the response; the properties are also declared in that order.
const RESPONSE_PROPERTY_ORDER = [
  "evidence_limits", "camera_view", "positions", "detail_visibility",
  "spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio", "threshold_assessments",
  "posture", "swing_plane", "impact", "rubric_findings",
  "highlights", "deficiencies", "drills",
  "executive_summary", "practice_focus", "pro_cue",
  "scorable", "unscored_reason",
];

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    evidence_limits: {
      type: SchemaType.STRING,
      description: "What this video does not let you judge: camera angle, framing, distance, frame rate, lighting, body or club out of frame, occlusion.",
    },
    camera_view: {
      type: SchemaType.STRING,
      enum: [...CAMERA_VIEWS],
      description: "The camera view the video shows: face_on, down_the_line, other, or unclear when you cannot tell.",
    },
    positions: {
      type: SchemaType.OBJECT,
      description: "For each moment of the swing, whether the video shows it clearly, and when. The moments happen in the order listed.",
      properties: {
        address:          positionSchema("Address: the set-up before the club moves."),
        takeaway_start:   positionSchema("Takeaway start: the moment the club starts back. Not the same as address."),
        top_of_backswing: positionSchema("The top of the backswing."),
        early_downswing:  positionSchema("The early downswing, just after the top."),
        impact:           positionSchema("Impact."),
      },
      required: [...SWING_POSITIONS],
    },
    detail_visibility: {
      type: SchemaType.OBJECT,
      description: "For each body or club detail: visible, not_visible, or unclear when you are unsure.",
      properties: Object.fromEntries(SWING_DETAILS.map((detail) => [detail, { type: SchemaType.STRING, enum: [...DETAIL_VISIBILITY] }])),
      required: [...SWING_DETAILS],
    },
    spine_angle:       { type: SchemaType.NUMBER, nullable: true, description: estimateDescription("the spine angle at address") },
    hip_rotation:      { type: SchemaType.NUMBER, nullable: true, description: estimateDescription("the hip turn at impact") },
    shoulder_rotation: { type: SchemaType.NUMBER, nullable: true, description: estimateDescription("the shoulder turn at the top of the backswing") },
    tempo_ratio:       { type: SchemaType.STRING, nullable: true, description: "Your own approximate backswing:downswing estimate from the video as 'N:1' or 'N.N:1', or null when the video's timing does not show it. Do not copy a client-supplied estimate." },
    threshold_assessments: {
      type: SchemaType.OBJECT,
      description: "Whether each turn can be assessed from this video, and on what visible basis. You do not compare any estimate with a cutoff.",
      properties: {
        shoulder_turn_at_top: thresholdAssessmentSchema("The shoulder turn at the top of the backswing (shoulder_rotation). Requires a face_on or down_the_line view, shoulders visible, top_of_backswing yes and a shoulder_rotation estimate."),
        hip_turn_at_impact:   thresholdAssessmentSchema("The hip turn at impact (hip_rotation). Requires a face_on view (down_the_line does not qualify), pelvis visible, impact yes and a hip_rotation estimate."),
      },
      required: [...THRESHOLD_MEASURES],
    },
    posture:     pillarSchema,
    swing_plane: pillarSchema,
    impact:      pillarSchema,
    rubric_findings: {
      type: SchemaType.ARRAY,
      description: "One entry for each listed rubric item: observed, not_observed (the video clearly shows it is absent) or not_assessable.",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id:     { type: SchemaType.STRING, enum: [...QUALITATIVE_ITEM_IDS] },
          status: { type: SchemaType.STRING, enum: [...FINDING_STATUSES] },
        },
        required: ["id", "status"],
      },
    },
    highlights: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline for this strength" },
          description: { type: SchemaType.STRING, description: "1-3 sentences naming what the video shows and where in the swing" },
        },
        required: ["title", "description"],
      },
      description: "0-4 strengths the video shows. Empty when the video supports none; never generic praise.",
    },
    deficiencies: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title:       { type: SchemaType.STRING, description: "3-6 word headline naming what you observed" },
          description: { type: SchemaType.STRING, description: "2-4 sentences: what the video shows and where in the swing, then why it may matter, stated as a possibility unless the video shows the result" },
          rubric_id:   { type: SchemaType.STRING, nullable: true, enum: [...QUALITATIVE_ITEM_IDS], description: "The rubric item this deficiency describes, only when you marked that item observed in rubric_findings; otherwise null. Each item may be linked by at most one deficiency: put every observation about the same item into that one deficiency." },
        },
        required: ["title", "description", "rubric_id"],
      },
      description: "0-4 faults the video shows. Empty when the video supports none; never a typical fault the video does not show.",
    },
    drills: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name:     { type: SchemaType.STRING, description: "Drill name" },
          the_why:  { type: SchemaType.STRING, description: "1-2 sentences: how this drill addresses the observed deficiency" },
          the_how:  { type: SchemaType.STRING, description: "3-5 sentences of step-by-step execution" },
          the_feel: { type: SchemaType.STRING, description: "One short first-person feel cue for practising this drill" },
        },
        required: ["name", "the_why", "the_how", "the_feel"],
      },
      description: "At most one drill per listed deficiency, in the same order. Empty when there are no deficiencies.",
    },
    executive_summary: {
      type: SchemaType.STRING,
      description: "2-5 plain sentences on what the video shows and the most useful next step. Call any number approximate and say it is estimated from the video. State the main limits.",
    },
    practice_focus: {
      type: SchemaType.STRING,
      nullable: true,
      description: "One practice priority the video supports, or null when there is none.",
    },
    pro_cue: {
      type: SchemaType.STRING,
      nullable: true,
      description: "One swing thought in 10 words or fewer for what the video shows, or null when there is none.",
    },
    scorable: {
      type: SchemaType.BOOLEAN,
      description: "true only when address, top_of_backswing and impact are all visible, at least one pillar is rated and at least one rubric item or turn is assessable, and nothing else prevents applying the rubric. Full coverage alone does not require true.",
    },
    unscored_reason: {
      type: SchemaType.STRING,
      nullable: true,
      description: "When scorable is false: one compact line explaining what prevented scoring. When scorable is true: null.",
    },
  },
  propertyOrdering: [...RESPONSE_PROPERTY_ORDER],
  // Every property stays required; listed in the same order.
  required: [...RESPONSE_PROPERTY_ORDER],
};

// ── System instruction ────────────────────────────────────────────────────────
// ENT-1D S6-R1. Evidence first (Product Constitution §B): no claimed
// credentials, no uncited targets, Tour comparisons or handicap bands, no
// forced numbers and no causes the video cannot show. The scoring rubric's
// items and weights are unchanged and applied by the server, only to what the
// model reports it could see; an unscorable swing is reported as such.
//
// S6 content candidate: general evidence discipline only. A body region in
// frame is not its detailed anatomy; numbers, moments and times need visible
// support; a still pose is not swing motion; an unscored answer names its
// reason from the video; a partly assessable swing keeps its supported
// observations. The response schema, contract, rubric and request settings
// are unchanged.

const SYSTEM_INSTRUCTION = `
You are SwingProAI's golf swing analysis assistant. You review one golf swing video and write coaching a golfer can trust. You are an AI model: do not claim personal experience, credentials, certifications, Tour history or students.

EVIDENCE RULES — READ FIRST
───────────────────────────
• Base every statement on what the attached video shows, or on a client-supplied estimate named as unverified. If you cannot see something, say so. Never fill a gap with a typical fault, a template or another golfer's pattern.
• Fill evidence_limits with what this video does not let you judge: camera angle, framing, distance, frame rate, lighting, body or club out of frame, occlusion.
• Keep observation and inference apart. Describe an effect as a possibility ("can", "may", "is often associated with") unless the video shows it. The video does not show ball flight unless the ball is visible in flight, so never state a ball-flight result as fact.
• Do not state a root cause the video cannot show. If you suggest one, call it a possible cause.
• Do not compare the golfer with PGA Tour or other averages, ideal ranges, benchmarks, handicap levels or ability bands, and do not give a target number.
• Findings may be empty. Use an empty list for highlights, deficiencies or drills when the video supports none. Never invent a strength or a fault to fill a list.
• "unclear", "not_assessable" and an unscored result are honest answers. Use them whenever you are unsure; never claim to see what the video does not show clearly.

WHAT THE VIDEO SHOWS
────────────────────
• camera_view: face_on, down_the_line, other, or unclear when you cannot tell.
• positions: for address, takeaway_start (the moment the club starts back; not address), top_of_backswing, early_downswing (just after the top) and impact, say yes with the approximate video time when the video shows that moment clearly, no when it is not in the video, and unclear when you cannot tell. Give a time only with yes.
• Times: write a time as M:SS, M:SS.s or M:SS.ss (one or two minute digits; seconds 00 to 59). The moments happen in this order: address, takeaway_start, top_of_backswing, early_downswing, impact. Each time you give must be later than the time of every earlier moment you timed. The one exception: takeaway_start may share the time of address, although they are different moments.
• If the video does not let you place a moment clearly after the earlier ones, mark that moment unclear with no time. Never change a time, add precision or claim a moment is visible just to keep the order. Whatever depends on a moment you marked unclear follows the rules below: its estimate is null, its rubric items are not_assessable, its pillar is insufficient_evidence, and the swing may be unscored.
• detail_visibility: for shoulders, pelvis, spine_line, lead_wrist, hands_grip, club_shaft, clubface and target_reference, say visible, not_visible or unclear.

WHAT COUNTS AS SEEN
───────────────────
• A body region in view is not the same as its detailed anatomy. detail_visibility declares whether each body region or club detail can be seen: shoulders or pelvis are visible when that part of the body is in view and can be told apart. Seeing a region does not, on its own, show the joints, lines or landmarks needed to judge an angle, an alignment or an amount of turn, and it does not on its own support an estimate or make a turn assessable. When a region is visible but those landmarks are not clear (because of distance, resolution, clothing, blur, occlusion or a simplified, low-detail figure), keep its detail_visibility as visible; show the missing detail where it applies instead: a null estimate, assessable false, a not_assessable rubric item and an observation that says what is missing. Describe the region in general terms and do not name or judge a joint, angle or alignment the video does not show.
• A moment is yes only when the video shows the club and body passing through or holding that position as part of the swing. A pose that resembles a swing position is not, on its own, evidence that the swing reached that moment. If you can tell that a moment occurs but not where in the video it is, mark it unclear.
• A time is where in this video you see the moment, no more precise than the video lets you place it. Never work out a time from a typical swing rhythm, from the times of other moments or from the frame rate alone.
• Still pose versus swing motion: a single position, a held pose or a video without clear club motion supports static comments only, about the set-up, posture, stance and alignment the view shows. Claims about movement (the order or timing of moments, tempo, club path, the plane through the swing, turn, weight shift, head or body movement) need the video to show that movement between the moments involved. Never describe motion you inferred from a still position.
• One camera view shows some directions and hides others. You may comment on a set-up or position within what the view shows and say that the comment is view-limited; do not rate or describe anything that needs depth or an angle this view does not show.
• When you are unsure, use the uncertain answer of the field concerned. In positions, a moment you are unsure of is unclear, with no time. In detail_visibility, a region or detail you are unsure of is unclear. In rubric_findings, an item you cannot judge is not_assessable. For a pillar you cannot rate, the rating is insufficient_evidence, with an observation saying what is missing. An estimate you cannot support is null, and a turn you cannot assess has assessable false. Low confidence is neither a sighting nor an absence.

NUMBERS
───────
• spine_angle (at address), hip_rotation (at impact), shoulder_rotation (at the top of the backswing) and tempo_ratio are your own approximate estimates from the video. Give one only when the video clearly shows it; otherwise use null. Never guess a number to fill a field, and never copy a client-supplied estimate into these fields.
• An estimate depends on what you declared visible: spine_angle needs spine_line and address; shoulder_rotation needs shoulders and top_of_backswing; hip_rotation needs pelvis and impact; tempo_ratio needs takeaway_start, top_of_backswing and impact. If any of these is not visible, the estimate is null.
• spine_angle, hip_rotation and shoulder_rotation are geometric estimates. Give one only when you can name the visible landmarks it is measured from at the moment it refers to. A turn amount also needs the same body line to be visible both before and after the turn. Seeing a body region never supports a geometric estimate on its own. When that support is doubtful, use null and say what is missing.
• tempo_ratio is a timing estimate, not a geometric one. Give it only when takeaway_start, top_of_backswing and impact are each identifiable in the video and the times you gave them are supported by where you see those moments. Never derive it from a typical rhythm, invent or adjust a time to produce it, or give it more precision than those times support; otherwise use null.
• Whenever you mention a number in prose, call it approximate and say it is estimated from the video. Do not give more precision than the video supports.

CLIENT-SUPPLIED ESTIMATES
─────────────────────────
Values in the CLIENT-SUPPLIED ESTIMATES section were sent with the request by the client. The server cannot verify where they came from or how they were produced; they are unverified and may be wrong. Mention one only as a client-supplied estimate (unverified), check it against the video, and say plainly where the video disagrees or cannot show it. Never present one as measured or confirmed, and never apply a diagnosis or scoring adjustment on a client-supplied estimate alone.

SWING POSITIONS
───────────────
Name the positions you describe (address, takeaway, top of the backswing, downswing, impact, follow-through, finish) and the body regions involved; name a joint only when the video shows it clearly. Avoid vague statements such as "your swing plane is off".

SCORING
───────
SwingProAI's server applies its scoring rubric to what you report. You do not write a score. The rubric is a coaching rubric, not a calibrated measurement; do not describe it as one, and do not present any scoring criterion to the golfer as a target.
• threshold_assessments: for shoulder_turn_at_top and hip_turn_at_impact, assessable is true only when the video shows that turn clearly enough for your estimate to be used, with basis naming what you see; otherwise assessable is false and basis is null. You do not compare any estimate with a cutoff. Each turn also has fixed requirements; when any is missing, assessable is false:
  – shoulder_turn_at_top: a face_on or down_the_line view, shoulders visible, top_of_backswing yes, and a shoulder_rotation estimate.
  – hip_turn_at_impact: a face_on view only (down_the_line does not qualify), pelvis visible, impact yes, and a hip_rotation estimate.
  An estimate and its turn's assessability are separate: give the estimate whenever the video supports it, even when its turn is not assessable (for example a hip_rotation estimate from a down_the_line view), and set assessable to false.
• rubric_findings: one entry for each listed item. observed when the video shows it; not_observed only when the video clearly shows it is absent; not_assessable when the view, details or moments it needs are not clearly visible. Never mark something not_observed because you cannot see it. An estimate you made is not, on its own, evidence of a fault.
  – laid_off_p4: a laid-off club at the top. Needs a down_the_line view, club_shaft and target_reference visible, and top_of_backswing.
  – over_the_top: an over-the-top downswing path. Needs a down_the_line view, club_shaft and target_reference visible, top_of_backswing and early_downswing.
  – cupped_lead_wrist_top: a cupped lead wrist at the top. Needs a face_on or down_the_line view, lead_wrist and hands_grip visible, and top_of_backswing.
  – reverse_pivot: a reverse pivot. Needs a face_on view, shoulders and pelvis visible, address and top_of_backswing.
• scorable: true only when address, top_of_backswing and impact are all visible (yes), at least one pillar is rated, at least one rubric item or turn is assessable, and nothing else prevents applying the rubric. Full coverage alone does not require true. When scorable is false, unscored_reason is one compact line explaining what prevented scoring; when it is true, unscored_reason is null.
• An unscored result is a valid answer even when the listed requirements appear to be met, if this video's evidence is too weak to apply the rubric with confidence. unscored_reason names the specific moment, view or detail of this video that prevented scoring and agrees with what you reported in positions and detail_visibility. Never give a generic or invented reason, and never leave a swing unscored just to avoid judging what the video does show.

COACHING
────────
• executive_summary: plain, specific sentences about this video, with its main limits.
• Each deficiency: what the video shows and where in the swing, then why it may matter, stated as a possibility unless the video shows the result. Set its rubric_id to the rubric item it describes only when you marked that item observed; otherwise rubric_id is null.
• Each rubric item may be linked by at most one deficiency. When several observations describe the same observed item, combine them into that one linked deficiency. Coaching that does not describe a rubric item stays its own deficiency with rubric_id null. Do not drop or unlink a deficiency that describes an observed item just to avoid a repeated link; combine it instead.
• Each drill addresses one listed deficiency, in the same order; no drill without a deficiency.
• posture, swing_plane, impact: rate posture only when address is visible, swing_plane only when top_of_backswing is visible, and impact only when impact is visible. Otherwise use rating "insufficient_evidence" and say in the observation what is missing. When scorable is true, at least one of them must be rated.
• Every pillar needs an observation. A needs_work or poor rating needs a correction: one supportable adjustment. A good, excellent or insufficient_evidence rating may have an empty correction. Never invent an adjustment, fault or observation, and never change a rating just to fill or empty the correction.
• practice_focus and pro_cue: null when the video supports nothing to recommend.
• When only part of the swing or body can be assessed, keep what is supported. Rate a pillar only when its moment is visible and the video gives enough evidence for that particular rating; otherwise keep a supported observation and use insufficient_evidence. Report the observations, strengths and faults the visible part supports, and say in the summary what could not be judged. An unscored result still describes what the video shows. Never pad it with general advice the video does not support.
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

/** A4 (C1): the verified caller's own caller-scoped client (utils/supabase/server.ts resolveRouteAuth). */
type RouteSupabaseClient = AuthenticatedCaller["client"];

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
  // ENT-1D S6 diagnostics: set once the provider has answered, with the stage a
  // failure from here on would have stopped at (lib/gemini-response-diagnostics.ts).
  let puttingDiagnostics: GeminiResponseDiagnostics | null = null;
  let puttingStage: ResponseOutcome = "response_blocked";
  try {
    const equipmentContext = buildTrustedEquipmentContext(analysisRow.equipment_snapshot);
    let puttingResult;
    try {
      // ENT-1D S6: at most one HTTPS request, never redirected or retried, and
      // bounded by one deadline (lib/gemini-transport.ts).
      puttingResult = await generateContentOnce(puttingApiKey, {
      systemInstruction: PUTTING_SYSTEM_INSTRUCTION,
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
    puttingDiagnostics = describeGeminiResponse(puttingResult);
    // ENT-1D S6-R1. Only an explicit STOP may become a putt, decided from the
    // response before any text is read: a blocked, cut-short or unexplained
    // answer fails here whatever its text (lib/gemini-completion-policy.ts).
    const puttingCompletion = decideProviderCompletion(puttingResult);
    if (!puttingCompletion.complete) {
      puttingStage = puttingCompletion.kind === "blocked" ? "response_blocked" : "incomplete_generation";
      throw new Error("provider response not complete");
    }
    // Deliberately not named rawText, and never logged.
    const puttingRawText = responseText(puttingResult);
    puttingDiagnostics = withTextLength(puttingDiagnostics, puttingRawText.length);
    puttingStage = "json_parse_failed";
    puttingParsed = JSON.parse(puttingRawText);
  } catch {
    logGeminiResponseDiagnostics("putting", puttingStage, puttingDiagnostics);
    await markFailed();
    return NextResponse.json({ error: "Analysis failed. Please try again." }, { status: 500 });
  }

  const puttingValidated = validatePuttingModelResponse(puttingParsed);
  if (!puttingValidated.ok) {
    // The rejection reason is an internal diagnostic: never logged, never returned.
    console.error("[analyze-swing] putting response rejected");
    logGeminiResponseDiagnostics("putting", "validation_rejected", puttingDiagnostics);
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
    logGeminiResponseDiagnostics("putting", "score_unavailable", puttingDiagnostics);
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
    logGeminiResponseDiagnostics("putting", "completion_write_failed", puttingDiagnostics);
    await markFailed();
    return NextResponse.json(
      { error: "We couldn't save your analysis. Please try again." },
      { status: 400 },
    );
  }

  logGeminiResponseDiagnostics("putting", "completed", puttingDiagnostics);
  return NextResponse.json({
    message: "Analysis complete",
    data: serializeAnalysisResult(puttingUpdatedRows[0] as Record<string, unknown>, PUTTING_RESULT_ACCESS),
  });
}


// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[analyze-swing] POST received");

  // ── Auth ──────────────────────────────────────────────────────────────────
  // A4 (C1). This route opts into the shared route ingress (utils/supabase/server.ts resolveRouteAuth). An
  // Authorization header selects Bearer mode — the web app's Analyze page and report send only the confirmed token
  // of the account they were rendered for, with no cookie — and a presented credential that is malformed, invalid or
  // expired is refused: it never falls back to whatever session cookie the browser carries. Without the header the
  // session-cookie ingress is unchanged for any other caller. An Auth outage is not a sign-out: it is answered 503,
  // honestly. All of this happens before the body is read and before any database, Storage, claim or provider work,
  // and everything below runs on the verified caller's own client and user id — no second client is ever built from
  // the cookie for a caller verified by Bearer.
  const auth = await resolveRouteAuth();
  console.log("[analyze-swing] authenticated:", auth.status === "authenticated");

  if (auth.status === "verification_unavailable") {
    return NextResponse.json({ error: AUTH_UNAVAILABLE_COPY }, { status: 503 });
  }
  if (auth.status !== "authenticated") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = auth.client;
  const user = { id: auth.userId } as const;

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

  // ── Step 2: extractSwingMetrics (server-side = null) ──────────────────────────
  // The function guards on `typeof window === "undefined"` and returns all-null.
  // Client-supplied estimates arrive via `mediapipeMetrics` in the body; the
  // server cannot verify their origin and labels them unverified in the prompt.
  // No URL is passed: the server-side call never loads a video, and
  // browser-written video_url is never a source on the server.
  console.log("[analyze-swing] calling extractSwingMetrics (server-side: will return null fields)");
  const serverMetrics = await extractSwingMetrics("");

  // The accepted client estimates (the server-side call is a no-op). S6-R1:
  // they are shown to the model as unverified and recorded beside the AI's own
  // values (buildMetricEvidence); they never become the analysis values.
  // ENT-1A. Every client value is spliced into the model prompt, so each one
  // must have the shape of an estimate — a finite angle,
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
  // ENT-1D S6-R1. The session line and any client estimates, listed as
  // unverified; no ranges, ratings or implied causes (buildMetricsContext).
  const exactValuesBlock = [
    `GOLFER-SPECIFIC DATA — READ BEFORE WRITING`,
    `Session: ${clubLabel} ${sizeLabel}`,
    ``,
    buildMetricsContext(merged),
  ].join("\n");

  const userPrompt = [
    exactValuesBlock,
    ``,
    `The swing video is attached. Describe only what it shows, state what it does not let you judge, and use null or empty lists where the video supports no value or finding.`,
    ``,
    `Follow the response schema. Set scorable to false and explain why in unscored_reason whenever the video does not support applying the rubric. Output the JSON object. No markdown, no preamble.`,
  ].join("\n");

  // ENT-1D S6 diagnostics: set once the provider has answered, with the stage a
  // failure from here on would have stopped at (lib/gemini-response-diagnostics.ts).
  let responseDiagnostics: GeminiResponseDiagnostics | null = null;
  let responseStage: ResponseOutcome = "response_blocked";

  try {
    // Explicit content parts: the inline video, then the prompt text.
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
      // ENT-1D S6: at most one HTTPS request, never redirected or retried, and
      // bounded by one deadline (lib/gemini-transport.ts).
      result = await generateContentOnce(geminiKey, {
        systemInstruction: SYSTEM_INSTRUCTION,
        contents: [{ role: "user", parts: contentParts }],
        generationConfig: {
          responseMimeType: "application/json",  // required alongside responseSchema
          responseSchema:   RESPONSE_SCHEMA as Schema, // enforces structure at API level — no markdown fences possible
          temperature: 0.0,
          maxOutputTokens: 16384,
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
    responseDiagnostics = describeGeminiResponse(result);
    // ENT-1D S6-R1. Only an explicit STOP may become an analysis, decided from
    // the response before any text is read: a blocked, cut-short or
    // unexplained answer fails here whatever its text, even valid JSON
    // (lib/gemini-completion-policy.ts). The diagnostics above only describe it.
    const completion = decideProviderCompletion(result);
    if (!completion.complete) {
      responseStage = completion.kind === "blocked" ? "response_blocked" : "incomplete_generation";
      throw new Error("provider response not complete");
    }
    const rawText = responseText(result);
    responseDiagnostics = withTextLength(responseDiagnostics, rawText.length);
    responseStage = "json_parse_failed";

    // responseSchema guarantees clean JSON — log length so we can verify in Vercel
    console.log("[analyze-swing] Gemini response length (chars):", rawText.length);

    // ── Step 6: parse + validate ──────────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.error("[analyze-swing] JSON parse failure");
      throw new Error("Gemini returned a non-JSON response");
    }

    // ENT-1D S6-R1. The whole object is checked before anything is kept:
    // nullable estimates and score, possibly empty findings, a drill only for a
    // listed deficiency. Nothing is repaired or defaulted
    // (lib/full-swing-analysis-contract.ts).
    responseStage = "validation_rejected";
    const validated = validateFullSwingModelResponse(parsed);
    if (!validated.ok) {
      // The rejection reason is never returned. Approved exception: its fixed
      // code, classified against an exhaustive allowlist, is added to the
      // diagnostics line logged below; no rejected value or text is taken.
      responseDiagnostics = withRejectionCode(responseDiagnostics, validated.reason);
      console.error("[analyze-swing] full-swing response rejected");
      throw new Error("full-swing response rejected");
    }
    // The canonical report (stored and served shapes unchanged) and the internal
    // rubric assessment; the score and breakdown are the server's.
    const { report, assessment } = validated;
    responseStage = "post_parse_failure";

    // ── Step 7: mapping + DB write ───────────────────────────────────────
    // The stored estimates are the model's own values from the video, null
    // where the video did not show them. A client estimate is recorded beside
    // each one, labelled unverified, and never takes its place. Every value and
    // its source are stored together in metrics.metric_evidence; the score is
    // null when the video could not be scored, never 0 or a default.
    const metricEvidence = buildMetricEvidence(report, merged);

    const metrics = {
      scoring_breakdown: report.scoring_breakdown,
      evidence_limits:   report.evidence_limits,
      evidence_coverage: report.evidence_coverage,
      metric_evidence:   metricEvidence,
      fault_tags:        report.fault_tags,
      drills:            report.drills,
      posture:           report.posture,
      swing_plane:       report.swing_plane,
      impact:            report.impact,
      practice_focus:    report.practice_focus,
      pro_cue:           report.pro_cue,
      // Internal and versioned: model declarations, item outcomes and the applied
      // adjustments. Never served: the read authority's metrics allow-list drops it.
      rubric_assessment: assessment,
    };

    // S6-R1A. The model assesses no checkpoint, joint position or severity, so
    // none is stored: these are null ("not assessed"), never the constants this
    // route used to write ("impact", {general, 0.5, 0.5}, "minor"). The coaching
    // text is kept as written.
    const swing_highlights = report.highlights.map((h) => ({
      checkpoint:         null,
      positive_movement:  h.title,
      mechanical_benefit: h.description,
    }));

    const mechanical_deficiencies = report.deficiencies.map((d) => ({
      checkpoint:              null,
      joint_coordinate:        null,
      fault_description:       d.title,
      corrective_drill_detail: d.description,
      severity:                null,
      corrective_drill_title:  "",
    }));

    const payload = {
      status:            "complete",
      score:             report.score,
      feedback:          report.executive_summary,
      spine_angle:       report.spine_angle,
      hip_rotation:      report.hip_rotation,
      shoulder_rotation: report.shoulder_rotation,
      tempo_ratio:       report.tempo_ratio === null ? null : parseTempoRatioToNumber(report.tempo_ratio),
      metrics,
      swing_highlights,
      mechanical_deficiencies,
      // ENT-1D: the holder's claim, proved in the row (migration 20261027120000).
      processing_claim_proof: claimId,
    };

    // Completes only the row this request claimed: still processing, this
    // owner, this claim. Exactly one affected row is proved rather than assumed.
    responseStage = "completion_write_failed";
    const { data: completedRows, error: updateErr } = await trustedAnalysisTable()
      .update(payload)
      .eq("id", analysisId)
      .eq("user_id", user.id)
      .eq("status", "processing")
      .eq("processing_claim_id", claimId)
      .select();

    if (updateErr || !Array.isArray(completedRows) || completedRows.length !== 1) {
      console.error("[analyze-swing] analysis completion update failed");
      logGeminiResponseDiagnostics("full_swing", "completion_write_failed", responseDiagnostics);
      await markAnalysisFailed(analysisId, user.id, claimId);
      return NextResponse.json(
        { error: "We couldn't save your analysis. Please try again." },
        { status: 400 },
      );
    }

    const completedRow = completedRows[0] as Record<string, unknown>;
    console.log("[analyze-swing] complete — status:", completedRow.status);
    logGeminiResponseDiagnostics("full_swing", "completed", responseDiagnostics);
    // Logged once: a later failure in this block is not a provider-response outcome.
    responseDiagnostics = null;
    // The stored row keeps every section; the response is the explicit
    // authorized view, never the raw row.
    const updated = serializeAnalysisResult(completedRow, access);
    return NextResponse.json({ message: "Analysis complete", data: updated });

  } catch {
    // Nothing is logged here unless the provider answered (diagnostics set).
    logGeminiResponseDiagnostics("full_swing", responseStage, responseDiagnostics);
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
/** A4 (C1): Auth could not be reached to verify the caller (not a sign-out); nothing was read or started. */
const AUTH_UNAVAILABLE_COPY = "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly.";
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
 * status, a redirect (never followed), and every non-HTTP error (transport
 * failure, the transport deadline, an unreadable 2xx body). Widening this list
 * needs provider evidence.
 */
const DEFINITE_REJECTION_STATUSES: readonly number[] = [401, 403, 404];

/**
 * True only for a non-OK HTTP response the transport actually received
 * (GeminiHttpError carries its status) whose status is on the allow-list
 * above. Matched by class, not by name. A redirect or any failure without a
 * provider answer is a GeminiOutcomeUnknownError and is never on the list.
 *
 * A response that arrived in full but is unusable (blocked, bad finish reason,
 * not JSON) is a different, known outcome: responseText() raises it, and
 * JSON.parse rejects the text, after this call returns, so it never reaches
 * this classifier and is released as a definite failure.
 * Nothing here claims exactly-once provider execution.
 */
function isDefiniteProviderRejection(error: unknown): boolean {
  return (
    error instanceof GeminiHttpError &&
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

/** A client-supplied angle estimate in degrees (unverified), or null when it is not one. */
function clientAngle(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= -360 && value <= 360 ? value : null;
}

/** A client-supplied tempo estimate (unverified) in the "N.N:1" form, or null. */
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
