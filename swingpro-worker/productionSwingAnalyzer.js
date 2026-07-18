// Side-effect-free, AbortSignal-aware production swing analyzer.
//
// This module owns the real Gemini vision pipeline: storage download,
// Gemini file upload/polling, generateContent, and biometric enrichment. It
// performs NO swing/job database writes — it returns telemetry only. The
// caller (a legacy adapter or a lease-aware task processor) is responsible
// for the atomic terminal transition.
//
// Constructing the factory and importing this module must never touch the
// network, a database, the filesystem, or environment variables — every
// external effect is injected.
import { calcSpineAngle, calcHipRotation, calcShoulderRotation } from './biometrics.js';
import { logSafe } from './safeLog.js';

const SWING_VIDEOS_BUCKET = 'swing-videos';
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=';
const GEMINI_POLL_URL_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/';
const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
const POLL_ACTIVE_STATE = 'ACTIVE';
const POLL_PROCESSING_STATE = 'PROCESSING';

// Gemini response schema — mirrors the telemetry_data JSONB structure.
// Unchanged from the pre-extraction pipeline.
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    coaching_assessment: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        score_label: { type: 'string' },
        ai_coach_assessment: { type: 'string' },
        pro_cue: { type: 'string' },
        weekly_priority_text: { type: 'string' },
      },
      required: ['score', 'score_label', 'ai_coach_assessment', 'pro_cue', 'weekly_priority_text'],
    },
    equipment_insight: {
      type: 'object',
      properties: {
        shaft_flex_recommendation: { type: 'string' },
        driver_config_recommendation: { type: 'string' },
        ball_spec_recommendation: { type: 'string' },
        insight_text: { type: 'string' },
      },
      required: ['shaft_flex_recommendation', 'driver_config_recommendation', 'ball_spec_recommendation', 'insight_text'],
    },
    estimated_metrics: {
      type: 'object',
      properties: {
        swing_speed: { type: 'integer' },
        ball_speed: { type: 'integer' },
        smash_factor: { type: 'number' },
        tempo: { type: 'string' },
      },
      required: ['swing_speed', 'ball_speed', 'smash_factor', 'tempo'],
    },
    breakdowns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          score: { type: 'integer' },
          feedback: { type: 'string' },
          pro_tip: { type: 'string' },
        },
        required: ['component', 'score', 'feedback', 'pro_tip'],
      },
    },
    strengths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title', 'description'],
      },
    },
    faults: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          drill: { type: 'string' },
        },
        required: ['title', 'description', 'drill'],
      },
    },
    pose_data: {
      type: 'object',
      properties: {
        '11': { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, required: ['x', 'y', 'z'] },
        '12': { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, required: ['x', 'y', 'z'] },
        '23': { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, required: ['x', 'y', 'z'] },
        '24': { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, required: ['x', 'y', 'z'] },
      },
      required: ['11', '12', '23', '24']
    }
  },
  required: ['coaching_assessment', 'equipment_insight', 'estimated_metrics', 'breakdowns', 'strengths', 'faults', 'pose_data'],
};

function configurationError() {
  return new Error('invalid production swing analyzer configuration');
}

function analyzerError() {
  return new Error('Swing analysis failed');
}

// Never throws signal.reason directly — it may carry sensitive content
// (e.g. a caller-supplied abort reason). This is the only error shape used
// to signal cancellation anywhere in this module.
function createAbortError() {
  const error = new Error('Analysis aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw createAbortError();
  }
}

// Default abort-aware wait. Resolves after `ms` unless the signal fires
// first, in which case it rejects promptly with the sanitized AbortError.
// Leaves no timer or listener behind in either outcome.
function defaultAbortAwareSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSupabaseDependency(supabase) {
  return (
    isPlainObject(supabase) &&
    isPlainObject(supabase.storage) &&
    typeof supabase.storage.from === 'function'
  );
}

function isValidBiometrics(biometrics) {
  return (
    isPlainObject(biometrics) &&
    typeof biometrics.calcSpineAngle === 'function' &&
    typeof biometrics.calcHipRotation === 'function' &&
    typeof biometrics.calcShoulderRotation === 'function'
  );
}

function isValidAiAnalysis(aiAnalysis) {
  try {
    if (!isPlainObject(aiAnalysis)) return false;

    const coachingAssessment = aiAnalysis.coaching_assessment;
    const equipmentInsight = aiAnalysis.equipment_insight;
    const estimatedMetrics = aiAnalysis.estimated_metrics;
    const breakdowns = aiAnalysis.breakdowns;
    const strengths = aiAnalysis.strengths;
    const faults = aiAnalysis.faults;
    const poseData = aiAnalysis.pose_data;

    if (!isPlainObject(coachingAssessment)) return false;
    if (!isPlainObject(equipmentInsight)) return false;
    if (!isPlainObject(estimatedMetrics)) return false;
    if (!Array.isArray(breakdowns)) return false;
    if (!Array.isArray(strengths)) return false;
    if (!Array.isArray(faults)) return false;
    if (!isPlainObject(poseData)) return false;

    return true;
  } catch {
    return false;
  }
}

async function downloadSwingVideo({ supabase, storagePath, signal, logSafeImpl, swingId }) {
  throwIfAborted(signal); // checkpoint: before storage download

  let result;
  try {
    result = await supabase.storage.from(SWING_VIDEOS_BUCKET).download(storagePath, {}, { signal });
  } catch {
    if (signal && signal.aborted) throw createAbortError();
    logSafeImpl('storage_download_failed', { swingId });
    throw analyzerError();
  }

  throwIfAborted(signal); // checkpoint: after storage download, before inspecting the result

  const data = result ? result.data : undefined;
  const error = result ? result.error : undefined;

  if (error || !data) {
    logSafeImpl('storage_download_failed', { swingId });
    throw analyzerError();
  }

  return data;
}

async function uploadToGemini({ videoBlob, signal, fetchImpl, geminiApiKey, sleepImpl, logSafeImpl, swingId }) {
  throwIfAborted(signal); // checkpoint: before Gemini upload fetch

  let uploadRes;
  try {
    uploadRes = await fetchImpl(`${GEMINI_UPLOAD_URL}${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Goog-Upload-File-Name': 'swing-analysis.mp4',
      },
      body: videoBlob,
      signal,
    });
  } catch {
    if (signal && signal.aborted) throw createAbortError();
    logSafeImpl('gemini_upload_failed', { swingId });
    throw analyzerError();
  }

  throwIfAborted(signal); // checkpoint: after Gemini upload fetch, before inspecting the response

  if (!uploadRes.ok) {
    try { await uploadRes.text(); } catch { /* discard body safely */ }
    logSafeImpl('gemini_upload_failed', { swingId });
    throw analyzerError();
  }

  let uploadData;
  try {
    uploadData = await uploadRes.json();
  } catch {
    if (signal && signal.aborted) throw createAbortError();
    logSafeImpl('gemini_upload_failed', { swingId });
    throw analyzerError();
  }

  const file = uploadData ? uploadData.file : undefined;
  const fileUri = file ? file.uri : undefined;
  const geminiFileName = file ? file.name : undefined;
  let fileState = file ? file.state : undefined;

  if (
    typeof fileUri !== 'string' || fileUri.length === 0 ||
    typeof geminiFileName !== 'string' || geminiFileName.length === 0 ||
    typeof fileState !== 'string' || fileState.length === 0
  ) {
    logSafeImpl('gemini_upload_failed', { swingId });
    throw analyzerError();
  }

  throwIfAborted(signal); // checkpoint: after Gemini upload field validation

  let attempts = 0;
  while (fileState === POLL_PROCESSING_STATE && attempts < POLL_MAX_ATTEMPTS) {
    throwIfAborted(signal); // checkpoint: before every polling wait

    try {
      await sleepImpl(POLL_INTERVAL_MS, signal);
    } catch {
      if (signal && signal.aborted) throw createAbortError();
      logSafeImpl('gemini_poll_failed', { swingId });
      throw analyzerError();
    }

    throwIfAborted(signal); // checkpoint: after every polling wait, before the next fetch

    let pollRes;
    try {
      pollRes = await fetchImpl(`${GEMINI_POLL_URL_PREFIX}${geminiFileName}?key=${geminiApiKey}`, { signal });
    } catch {
      if (signal && signal.aborted) throw createAbortError();
      logSafeImpl('gemini_poll_failed', { swingId });
      throw analyzerError();
    }

    throwIfAborted(signal); // checkpoint: after every polling fetch, before inspecting the response

    if (!pollRes.ok) {
      try { await pollRes.text(); } catch { /* discard body safely */ }
      logSafeImpl('gemini_poll_failed', { swingId });
      throw analyzerError();
    }

    let pollData;
    try {
      pollData = await pollRes.json();
    } catch {
      if (signal && signal.aborted) throw createAbortError();
      logSafeImpl('gemini_poll_failed', { swingId });
      throw analyzerError();
    }

    fileState = pollData ? pollData.state : undefined;
    attempts++;
  }

  if (fileState !== POLL_ACTIVE_STATE) {
    logSafeImpl('gemini_processing_failed', { swingId });
    throw analyzerError();
  }

  return fileUri;
}

async function generateAnalysis({ fetchImpl, geminiApiKey, coachPrompt, fileUri, signal, logSafeImpl, swingId }) {
  throwIfAborted(signal); // checkpoint: before generateContent fetch

  let geminiRes;
  try {
    geminiRes = await fetchImpl(`${GEMINI_GENERATE_URL}${geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: coachPrompt },
            { fileData: { mimeType: 'video/mp4', fileUri } },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
        },
      }),
      signal,
    });
  } catch {
    if (signal && signal.aborted) throw createAbortError();
    logSafeImpl('gemini_generate_failed', { swingId });
    throw analyzerError();
  }

  throwIfAborted(signal); // checkpoint: after generateContent fetch, before inspecting the response

  if (!geminiRes.ok) {
    try { await geminiRes.text(); } catch { /* discard body safely */ }
    logSafeImpl('gemini_generate_failed', { swingId });
    throw analyzerError();
  }

  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch {
    if (signal && signal.aborted) throw createAbortError();
    logSafeImpl('gemini_generate_failed', { swingId });
    throw analyzerError();
  }

  const candidates = geminiData ? geminiData.candidates : undefined;
  const firstCandidate = Array.isArray(candidates) ? candidates[0] : undefined;
  const content = firstCandidate ? firstCandidate.content : undefined;
  const parts = content ? content.parts : undefined;
  const text = Array.isArray(parts) && parts[0] ? parts[0].text : undefined;

  if (typeof text !== 'string' || text.length === 0) {
    logSafeImpl('gemini_response_invalid', { swingId });
    throw analyzerError();
  }

  let aiAnalysis;
  try {
    aiAnalysis = JSON.parse(text);
  } catch {
    logSafeImpl('gemini_response_invalid', { swingId });
    throw analyzerError();
  }

  if (!isValidAiAnalysis(aiAnalysis)) {
    logSafeImpl('gemini_response_invalid', { swingId });
    throw analyzerError();
  }

  throwIfAborted(signal); // checkpoint: after generateContent response parsing and validation

  return aiAnalysis;
}

function buildCoachPrompt({ equipmentContext, slope, isPutting }) {
  const equipmentString = equipmentContext
    ? `${equipmentContext.make ?? ''} ${equipmentContext.model ?? ''} ${equipmentContext.club_type ?? ''}`.trim()
      + (equipmentContext.shaft_flex ? ` (Flex: ${equipmentContext.shaft_flex})` : '')
      + (equipmentContext.loft ? ` (Loft: ${equipmentContext.loft}°)` : '')
    : 'Unknown Club';

  const strictInstructions = `
       CRITICAL SYSTEM INSTRUCTIONS:
       1. You MUST fully populate the 'estimated_metrics' block with realistic numerical estimates. Do NOT use 0.
       2. You MUST provide at least 3 items in the 'breakdowns' array (e.g., Posture, Takeaway, Impact).
       3. Extract the exact normalized (0.0 to 1.0) x, y, z landmark coordinates at impact for Left Shoulder (11), Right Shoulder (12), Left Hip (23), and Right Hip (24). Output these strictly into the 'pose_data' JSON field.
       4. In the 'ai_coach_assessment' field, write a dense, highly technical 3-4 sentence biomechanical breakdown. Analyze the X-Factor (shoulder vs hip turn differential), early extension, spine angle maintenance, and club position at P4. Use precise terminology similar to elite PGA coaching.
       5. For each item in the 'breakdowns' array, provide a 'pro_tip' string that offers a specific, actionable drill or swing thought to fix the exact biomechanical deficiency identified.`;

  if (isPutting) {
    return `You are an elite PGA Tour-caliber putting coach. The player is using a ${equipmentString}.
       The green undulation slope sensor read ${slope ?? 0}°.
       Watch the putting stroke in this video. Analyze ONLY putting mechanics:
       1. Eye position and alignment over the ball.
       2. Lower body stillness — zero hip rotation during the stroke.
       3. Pure shoulder-controlled pendulum tempo.
       4. Putter face angle at impact and follow-through.
       For estimated_metrics: swing_speed and ball_speed will be very low (putts); smash_factor for a clean putt is exactly 1.0.
       Provide a score 1–100 with label 'Par', 'Birdie', or 'Eagle'. Be specific about what you observe in the video.
       ${strictInstructions}`;
  }

  return `You are an elite PGA Tour-caliber golf instructor and biomechanics expert. The player is using a ${equipmentString}.
       Watch the full swing in this video. Evaluate:
       1. Setup: posture, ball position, grip, alignment.
       2. Backswing: takeaway width, hip and shoulder turn, club plane at the top.
       3. Downswing: kinematic sequence (hips → torso → arms → club), lag retention.
       4. Impact: clubface angle, hip clearance, spine angle maintenance, weight transfer.
       5. Follow-through: extension, balance, finish position.
       Estimate swing_speed (mph), ball_speed (mph), smash_factor, and tempo ratio based on what you observe.
       Provide a score 1–100 with label 'Par', 'Birdie', or 'Eagle'. Be specific about what you observe in the video — reference actual body positions and movements seen.
       ${strictInstructions}`;
}

/**
 * Creates the production swing analyzer. Every external effect (fetch,
 * sleep, logging, biometric math) is injectable so this module can be
 * exercised entirely with fakes. Constructing the factory performs no
 * network call, no database call, no environment read, and no process-level
 * registration.
 */
function createProductionSwingAnalyzer({
  supabase,
  geminiApiKey,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultAbortAwareSleep,
  logSafeImpl = logSafe,
  biometrics: biometricsImpl = { calcSpineAngle, calcHipRotation, calcShoulderRotation },
} = {}) {
  if (!isValidSupabaseDependency(supabase)) throw configurationError();
  if (typeof geminiApiKey !== 'string' || geminiApiKey.length === 0) throw configurationError();
  if (typeof fetchImpl !== 'function') throw configurationError();
  if (typeof sleepImpl !== 'function') throw configurationError();
  if (typeof logSafeImpl !== 'function') throw configurationError();
  if (!isValidBiometrics(biometricsImpl)) throw configurationError();

  // userId is part of the processor's database-derived analyzer contract but
  // is intentionally unused here — it must never drive authorization or
  // database writes inside this analyzer.
  async function analyzeSwing({ swingId, storagePath, equipmentContext, slope, userId, signal }) {
    void userId;
    const isPutting = equipmentContext?.club_type === 'Putter';

    const videoBlob = await downloadSwingVideo({ supabase, storagePath, signal, logSafeImpl, swingId });

    const fileUri = await uploadToGemini({
      videoBlob,
      signal,
      fetchImpl,
      geminiApiKey,
      sleepImpl,
      logSafeImpl,
      swingId,
    });

    const coachPrompt = buildCoachPrompt({ equipmentContext, slope, isPutting });

    const aiAnalysis = await generateAnalysis({
      fetchImpl,
      geminiApiKey,
      coachPrompt,
      fileUri,
      signal,
      logSafeImpl,
      swingId,
    });

    throwIfAborted(signal); // checkpoint: before biometric processing

    try {
      const poseData = aiAnalysis.pose_data;
      const calculatedSpine = biometricsImpl.calcSpineAngle(poseData);
      const calculatedHip = biometricsImpl.calcHipRotation(poseData);
      const calculatedShoulder = biometricsImpl.calcShoulderRotation(poseData);

      aiAnalysis.estimated_metrics.spineAngle = calculatedSpine;
      aiAnalysis.estimated_metrics.hipRotation = calculatedHip;
      aiAnalysis.estimated_metrics.shoulderTurn = calculatedShoulder;
    } catch {
      logSafeImpl('pose_math_failed', { swingId });
    }

    throwIfAborted(signal); // checkpoint: before returning telemetry

    return {
      spatial_slope: isPutting ? slope : null,
      coaching_assessment: aiAnalysis.coaching_assessment,
      equipment_insight: aiAnalysis.equipment_insight,
      estimated_metrics: aiAnalysis.estimated_metrics,
      breakdowns: aiAnalysis.breakdowns,
      strengths: aiAnalysis.strengths,
      faults: aiAnalysis.faults,
      raw_pose_data: aiAnalysis.pose_data,
    };
  }

  return analyzeSwing;
}

export { createProductionSwingAnalyzer, defaultAbortAwareSleep };
