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
    return `You are a professional golf coach. Analyze this golf swing video.
Be concise. Keep all text fields under 80 words each.
Return JSON with these exact fields:
- feedback: string (2-3 sentences max)
- score: number 0-100
- weakSpots: string[] (3 items, each under 6 words)
- drills: array of 3 objects, each: {name:string, why:string(1 sentence), how:string(1-2 sentences), feel:string(1 sentence), videoUrl:string(YouTube embed URL)}
- metrics: {swingSpeed:number(mph), ballSpeed:number(mph), launchAngle:number(degrees), smashFactor:number}`;
  }

  // basic — minimal prompt
  return `You are a golf coach. Review this swing video briefly.
Keep all text under 50 words each.
Return JSON: feedback(string), score(0-100), weakSpots(string[] 2 items), drills(array 2 objects each with name/why/how/feel/videoUrl), metrics({swingSpeed,ballSpeed,launchAngle,smashFactor})`;
}
