import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { calcSpineAngle, calcHipRotation, calcShoulderRotation } from './biometrics.js';
import { createApp } from './app.js';
import { logSafe } from './safeLog.js';
import { completeSwingAnalysis } from './swingRepository.js';

process.on('uncaughtException', () => {
  logSafe('uncaught_exception');
});
process.on('unhandledRejection', () => {
  logSafe('unhandled_rejection');
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

function assertStartupConfig() {
  const required = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
    GEMINI_API_KEY: geminiApiKey,
  };

  const missing = Object.keys(required).filter((name) => !required[name]);
  if (missing.length > 0) {
    console.error(`[Startup] Missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

assertStartupConfig();

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// Gemini response schema — mirrors the telemetry_data JSONB structure
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

// --- NEW SCHEMA FOR DRILL VERIFICATION ---
const VERIFICATION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    pass: { type: SchemaType.BOOLEAN, description: "true if the golfer successfully executed the drill correctly" },
    feedback: { type: SchemaType.STRING, description: "1-2 sentences explaining exactly why they passed or precisely what needs to improve" },
  },
  required: ["pass", "feedback"],
};

async function uploadToGemini(videoBlob) {
  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Goog-Upload-File-Name': 'swing-analysis.mp4',
      },
      body: videoBlob,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Gemini upload failed: ${err}`);
  }

  const uploadData = await uploadRes.json();
  const { uri: fileUri, name: geminiFileName, state } = uploadData.file;

  let fileState = state;
  let attempts = 0;
  while (fileState === 'PROCESSING' && attempts < 15) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${geminiFileName}?key=${geminiApiKey}`
    );
    const pollData = await pollRes.json();
    fileState = pollData.state;
    attempts++;
    console.log(`[Gemini] File state: ${fileState} (attempt ${attempts})`);
  }

  if (fileState !== 'ACTIVE') {
    throw new Error(`Gemini file processing ended in state: ${fileState}`);
  }

  return fileUri;
}

// --- NEW FUNCTION: DRILL VERIFICATION ENGINE ---
async function verifyDrill(drillId, userId, storagePath) {
  console.log(`[Drill Engine] Verifying: ${drillId}`);
  const { data: drill } = await supabase.from("drills").select("ai_verification_prompt").eq("id", drillId).single();
  const { data: videoBlob } = await supabase.storage.from("drill_videos").download(storagePath);
  
  const tmpPath = path.join("/tmp", `drill_${Date.now()}.mp4`);
  fs.writeFileSync(tmpPath, Buffer.from(await videoBlob.arrayBuffer()));
  
  const fileManager = new GoogleAIFileManager(geminiApiKey);
  const uploadRes = await fileManager.uploadFile(tmpPath, { mimeType: 'video/mp4' });
  
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [
      { fileData: { mimeType: 'video/mp4', fileUri: uploadRes.file.uri } },
      { text: drill.ai_verification_prompt }
    ]}],
    generationConfig: { responseMimeType: "application/json", responseSchema: VERIFICATION_SCHEMA },
  });
  
  const res = JSON.parse(result.response.text());
  await supabase.from("user_drills").upsert({ 
    user_id: userId, 
    drill_id: drillId, 
    status: res.pass ? "verified" : "needs_work", 
    latest_ai_feedback: res.feedback, 
    video_url: storagePath 
  });
  
  try { fs.unlinkSync(tmpPath); } catch {}
  return res;
}

async function analyzeSwing(swingId, storagePath, equipmentContext, slope, verifiedUserId) {
  console.log(`\n[AI Engine] Starting Gemini vision analysis for swing: ${swingId}`);

  // Status is already PROCESSING — the caller (app.js) claimed the row with
  // an atomic compare-and-set before invoking this function. This function
  // must never set PROCESSING itself.

  const equipmentString = equipmentContext
    ? `${equipmentContext.make ?? ''} ${equipmentContext.model ?? ''} ${equipmentContext.club_type ?? ''}`.trim()
      + (equipmentContext.shaft_flex ? ` (Flex: ${equipmentContext.shaft_flex})` : '')
      + (equipmentContext.loft ? ` (Loft: ${equipmentContext.loft}°)` : '')
    : 'Unknown Club';

  const isPutting = equipmentContext?.club_type === 'Putter';

  console.log(`[AI Engine] Downloading swing video from storage for swing: ${swingId}`);
  const { data: videoBlob, error: downloadError } = await supabase.storage
    .from('swing-videos')
    .download(storagePath);

  if (downloadError || !videoBlob) {
    logSafe('storage_download_failed', { swingId });
    throw new Error('Storage download failed');
  }

  console.log(`[AI Engine] Downloaded ${videoBlob.size} bytes. Uploading to Gemini...`);

  const fileUri = await uploadToGemini(videoBlob);
  console.log(`[AI Engine] Gemini file is ACTIVE. Running vision analysis...`);

  const strictInstructions = `
       CRITICAL SYSTEM INSTRUCTIONS:
       1. You MUST fully populate the 'estimated_metrics' block with realistic numerical estimates. Do NOT use 0.
       2. You MUST provide at least 3 items in the 'breakdowns' array (e.g., Posture, Takeaway, Impact).
       3. Extract the exact normalized (0.0 to 1.0) x, y, z landmark coordinates at impact for Left Shoulder (11), Right Shoulder (12), Left Hip (23), and Right Hip (24). Output these strictly into the 'pose_data' JSON field.
       4. In the 'ai_coach_assessment' field, write a dense, highly technical 3-4 sentence biomechanical breakdown. Analyze the X-Factor (shoulder vs hip turn differential), early extension, spine angle maintenance, and club position at P4. Use precise terminology similar to elite PGA coaching.
       5. For each item in the 'breakdowns' array, provide a 'pro_tip' string that offers a specific, actionable drill or swing thought to fix the exact biomechanical deficiency identified.`;

  const coachPrompt = isPutting
    ? `You are an elite PGA Tour-caliber putting coach. The player is using a ${equipmentString}.
       The green undulation slope sensor read ${slope ?? 0}°.
       Watch the putting stroke in this video. Analyze ONLY putting mechanics:
       1. Eye position and alignment over the ball.
       2. Lower body stillness — zero hip rotation during the stroke.
       3. Pure shoulder-controlled pendulum tempo.
       4. Putter face angle at impact and follow-through.
       For estimated_metrics: swing_speed and ball_speed will be very low (putts); smash_factor for a clean putt is exactly 1.0.
       Provide a score 1–100 with label 'Par', 'Birdie', or 'Eagle'. Be specific about what you observe in the video.
       ${strictInstructions}`
    : `You are an elite PGA Tour-caliber golf instructor and biomechanics expert. The player is using a ${equipmentString}.
       Watch the full swing in this video. Evaluate:
       1. Setup: posture, ball position, grip, alignment.
       2. Backswing: takeaway width, hip and shoulder turn, club plane at the top.
       3. Downswing: kinematic sequence (hips → torso → arms → club), lag retention.
       4. Impact: clubface angle, hip clearance, spine angle maintenance, weight transfer.
       5. Follow-through: extension, balance, finish position.
       Estimate swing_speed (mph), ball_speed (mph), smash_factor, and tempo ratio based on what you observe.
       Provide a score 1–100 with label 'Par', 'Birdie', or 'Eagle'. Be specific about what you observe in the video — reference actual body positions and movements seen.
       ${strictInstructions}`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiApiKey}`,
    {
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
    }
  );

  if (!geminiRes.ok) {
    const err = await geminiRes.text();
    throw new Error(`Gemini generateContent failed: ${err}`);
  }

  const geminiData = await geminiRes.json();
  const aiAnalysis = JSON.parse(geminiData.candidates[0].content.parts[0].text);

  console.log(`[AI Engine] Analysis complete. Score: ${aiAnalysis.coaching_assessment.score}`);

  try {
    const poseData = aiAnalysis.pose_data;
    const calculatedSpine = calcSpineAngle(poseData);
    const calculatedHip = calcHipRotation(poseData);
    const calculatedShoulder = calcShoulderRotation(poseData);

    aiAnalysis.estimated_metrics.spineAngle = calculatedSpine;
    aiAnalysis.estimated_metrics.hipRotation = calculatedHip;
    aiAnalysis.estimated_metrics.shoulderTurn = calculatedShoulder;

    console.log(`[AI Engine] Math Applied. Spine: ${calculatedSpine}°, Hip: ${calculatedHip}°, Shoulder: ${calculatedShoulder}°`);
  } catch {
    logSafe('pose_math_failed', { swingId });
  }

  const finalizeResult = await completeSwingAnalysis(supabase, {
    swingId,
    userId: verifiedUserId,
    telemetryData: {
      spatial_slope: isPutting ? slope : null,
      coaching_assessment: aiAnalysis.coaching_assessment,
      equipment_insight: aiAnalysis.equipment_insight,
      estimated_metrics: aiAnalysis.estimated_metrics,
      breakdowns: aiAnalysis.breakdowns,
      strengths: aiAnalysis.strengths,
      faults: aiAnalysis.faults,
      raw_pose_data: aiAnalysis.pose_data
    },
  });

  // Guarded by id, user_id, and status=PROCESSING — never overwrite a row
  // that has moved on to another state. Any failure (db error or zero rows
  // matched) means finalization did not happen; the caller must treat this
  // analysis as failed rather than assume COMPLETE was written.
  if (!finalizeResult.ok || !finalizeResult.changed) {
    throw new Error('Swing finalization did not apply');
  }

  return aiAnalysis;
}

const app = createApp({ supabase, analyzeSwing });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`SwingPro Worker running on port ${PORT}`)
);