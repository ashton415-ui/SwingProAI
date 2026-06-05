/**
 * SwingProAI — AI Model Router
 *
 * Model names are driven by environment variables — never hardcoded.
 * Set these in Vercel:
 *
 *   GEMINI_BASIC_MODEL    = local-basic          (no API call — mock/template response)
 *   GEMINI_ADVANCED_MODEL = gemini-2.5-flash     (Birdie / Coach Starter)
 *   GEMINI_ULTRA_MODEL    = gemini-2.5-pro        (Eagle / Coach Pro)
 */

import type { AnalysisMode } from "@/lib/entitlements";

export function getModelForAnalysisMode(mode: AnalysisMode): string {
  switch (mode) {
    case "ultra":
      return process.env.GEMINI_ULTRA_MODEL ?? "gemini-2.5-pro";
    case "advanced":
      return process.env.GEMINI_ADVANCED_MODEL ?? "gemini-2.5-flash";
    case "basic":
    default:
      return process.env.GEMINI_BASIC_MODEL ?? "local-basic";
  }
}

/** Returns true when the model is a real Gemini API model (not a local mock) */
export function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

/**
 * Builds the analysis prompt for a given mode.
 * More detailed prompts cost more tokens — reserved for higher tiers.
 */
export function getPromptForMode(mode: AnalysisMode, isAdvancedProMode = false): string {
  if (mode === "ultra") {
    return `You are a world-class biomechanics expert and PGA certified coach performing a FORENSIC DEEP ANALYSIS.
Analyze the kinetic chain, X-Factor separation, transition dynamics, wrist hinge, hip rotation,
shoulder plane, head stability, and ball flight physics.
Provide numeric estimations for all metrics. Be extremely precise and technical.
Return JSON: feedback, score (0-100), weakSpots, drills (3, each with name/why/how/feel/videoUrl),
metrics: {swingSpeed, ballSpeed, launchAngle, smashFactor, wristHinge:{feedback,overlay:{x1,y1,x2,y2}},
hipRotation:{feedback,overlay:{x1,y1,x2,y2}}, shoulderRotation:{feedback,overlay:{x1,y1,x2,y2}},
headStability:{feedback,overlay:{x1,y1,x2,y2}}}`;
  }

  if (mode === "advanced") {
    return `You are a professional golf coach and ball flight analyst.
Analyze this swing video for key mechanics, launch physics, and corrective drills.
Focus on swing speed, ball speed, launch angle, smash factor, and the top 3 mechanical issues.
Return JSON: feedback, score (0-100), weakSpots, drills (3, each with name/why/how/feel/videoUrl),
metrics: {swingSpeed (mph), ballSpeed (mph), launchAngle (degrees), smashFactor (ratio)}`;
  }

  // basic — minimal prompt to save cost
  return `You are a golf coach giving quick feedback on a swing video.
Identify the 2-3 most important mechanical issues and give a score.
Return JSON: feedback (2-3 sentences), score (0-100), weakSpots (2-3 items),
drills (2, each with name/why/how/feel/videoUrl),
metrics: {swingSpeed (estimated mph), ballSpeed (estimated mph), launchAngle (degrees), smashFactor (ratio)}`;
}
