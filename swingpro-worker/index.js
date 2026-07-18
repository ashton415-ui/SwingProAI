import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { createApp } from './app.js';
import { logSafe } from './safeLog.js';
import { createProductionSwingAnalyzer } from './productionSwingAnalyzer.js';
import { createLegacySwingAnalyzerAdapter } from './legacySwingAnalyzerAdapter.js';

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

// --- NEW SCHEMA FOR DRILL VERIFICATION ---
const VERIFICATION_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    pass: { type: SchemaType.BOOLEAN, description: "true if the golfer successfully executed the drill correctly" },
    feedback: { type: SchemaType.STRING, description: "1-2 sentences explaining exactly why they passed or precisely what needs to improve" },
  },
  required: ["pass", "feedback"],
};

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

const productionAnalyzeSwing = createProductionSwingAnalyzer({
  supabase,
  geminiApiKey,
});

const analyzeSwing = createLegacySwingAnalyzerAdapter({
  supabase,
  productionAnalyzeSwing,
});

const app = createApp({ supabase, analyzeSwing });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`SwingPro Worker running on port ${PORT}`)
);