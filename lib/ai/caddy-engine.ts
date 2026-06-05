/**
 * SwingProAI — AI Caddy Engine
 *
 * Generates tour-caddy-style hole recommendations by fusing
 * a golfer's shot profile with live hole geometry and conditions.
 *
 * This module is pure TypeScript — it does NOT call any external API directly.
 * The Gemini call is made from the API route (/api/v1/caddy) using the
 * output of buildCaddyPrompt(), keeping API keys server-side.
 */

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface GolferProfile {
  userId: string;
  handicapIndex: number | null;
  typicalShotShape: "draw" | "fade" | "straight" | "hook" | "slice" | null;
  prominentMiss: "left" | "right" | "thin" | "fat" | "top" | "shank" | null;
  averageDriverCarryYards: number | null;
  subscriptionTier: string;
}

export interface HazardDescriptor {
  type: "water" | "bunker" | "ob" | "trees" | "rough";
  position: "left" | "right" | "front" | "carry" | "green_side";
  distanceFromTeeYards?: number;
  severityNote?: string;
}

export interface WindVector {
  speedMph: number;
  directionDeg: number; // 0 = headwind, 180 = tailwind, 90/270 = crosswind
}

export interface HoleGeometry {
  holeNumber: number;
  par: number;
  yardsBack: number;
  yardsMiddle: number;
  yardsWhite?: number;
  doglegDirection: "left" | "right" | "straight" | null;
  doglegYards: number | null; // distance to apex
  hazards: HazardDescriptor[];
  greenUndulationSummary?: string; // e.g. "front-to-back slope, false front left"
  wind?: WindVector;
}

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface ClubRecommendation {
  primaryClub: string;           // e.g. "3-wood" or "6-iron"
  alternativeClub?: string;      // conservative/aggressive option
  targetYards: number;
  confidenceLevel: "high" | "medium" | "low";
  rationale: string;
}

export interface AimOffset {
  horizontal: "left_edge" | "center" | "right_edge" | "left_rough" | "right_rough";
  verticalBias?: "front_of_green" | "pin" | "back_of_green";
  offsetYards: number;           // positive = right, negative = left
  reasoning: string;
}

export interface HazardMitigation {
  primaryThreat: string;
  mitigationStrategy: string;
  noGoZone?: string;
}

export interface CaddyRecommendation {
  summary: string;               // One-sentence hole overview
  clubRecommendation: ClubRecommendation;
  aimOffset: AimOffset;
  hazardMitigation: HazardMitigation;
  shotShapeInstruction: string;  // e.g. "Play your natural draw — it works with the dogleg"
  mentalCue: string;             // e.g. "Aggressive to the left center, trust your yardage"
  windAdjustmentNote?: string;
  _generatedBy: "gemini" | "local";
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

export function buildCaddyPrompt(
  profile: GolferProfile,
  hole: HoleGeometry
): string {
  const shotShape = profile.typicalShotShape ?? "straight";
  const miss = profile.prominentMiss ?? "right";
  const carry = profile.averageDriverCarryYards ?? 240;
  const hcp = profile.handicapIndex ?? 18;

  const windDesc = hole.wind
    ? `Wind: ${hole.wind.speedMph}mph at ${hole.wind.directionDeg}° (0=headwind, 180=tailwind)`
    : "Wind: calm";

  const hazardDesc = hole.hazards.length
    ? hole.hazards.map(h => `${h.type} ${h.position}${h.distanceFromTeeYards ? ` at ${h.distanceFromTeeYards}yds` : ""}`).join(", ")
    : "No major hazards";

  const doglegDesc = hole.doglegDirection && hole.doglegDirection !== "straight"
    ? `Dogleg ${hole.doglegDirection} at ${hole.doglegYards ?? "?"}yds`
    : "Straight hole";

  return `You are an elite PGA Tour caddy with 20 years of experience.
Your golfer profile: Handicap ${hcp}, natural ${shotShape}, typical miss ${miss}, driver carry ${carry}yds.

Hole ${hole.holeNumber}: Par ${hole.par}, ${hole.yardsMiddle}yds from middle tees.
Layout: ${doglegDesc}. ${windDesc}.
Hazards: ${hazardDesc}.
${hole.greenUndulationSummary ? `Green: ${hole.greenUndulationSummary}.` : ""}

Provide a precise, tactical caddy recommendation. Think like a tour caddy — be specific about yardages, aim points, and shot shape.

Return JSON with exactly these fields:
{
  "summary": "one sentence hole overview",
  "clubRecommendation": {
    "primaryClub": "club name",
    "alternativeClub": "conservative option",
    "targetYards": number,
    "confidenceLevel": "high|medium|low",
    "rationale": "why this club"
  },
  "aimOffset": {
    "horizontal": "left_edge|center|right_edge|left_rough|right_rough",
    "verticalBias": "front_of_green|pin|back_of_green",
    "offsetYards": number,
    "reasoning": "tactical aim reasoning"
  },
  "hazardMitigation": {
    "primaryThreat": "describe the main threat",
    "mitigationStrategy": "how to avoid it",
    "noGoZone": "where to absolutely not miss"
  },
  "shotShapeInstruction": "specific shape instruction for this golfer",
  "mentalCue": "single confident thought",
  "windAdjustmentNote": "wind adjustment if applicable"
}`;
}

// ─── Local Fallback (no API call) ─────────────────────────────────────────────

export function generateLocalCaddyFeedback(
  profile: GolferProfile,
  hole: HoleGeometry
): CaddyRecommendation {
  const carry = profile.averageDriverCarryYards ?? 240;
  const shotShape = profile.typicalShotShape ?? "straight";
  const miss = profile.prominentMiss ?? "right";
  const distToPin = hole.yardsMiddle;

  // Simple club selection heuristic
  let primaryClub = "driver";
  let targetYards = carry;
  if (distToPin <= 130) { primaryClub = "9-iron"; targetYards = 130; }
  else if (distToPin <= 160) { primaryClub = "7-iron"; targetYards = 155; }
  else if (distToPin <= 200) { primaryClub = "5-iron"; targetYards = 190; }
  else if (distToPin <= 240) { primaryClub = "3-wood"; targetYards = 230; }

  // Simple aim offset: play away from miss
  const horizontal = miss === "right" ? "left_edge" : miss === "left" ? "right_edge" : "center";
  const offsetYards = miss === "right" ? -8 : miss === "left" ? 8 : 0;

  const doglegNote = hole.doglegDirection && hole.doglegDirection !== "straight"
    ? `Position for the dogleg ${hole.doglegDirection}.`
    : "Play to the center of the fairway.";

  return {
    summary: `Par ${hole.par}, ${distToPin} yards. ${doglegNote}`,
    clubRecommendation: {
      primaryClub,
      alternativeClub: primaryClub === "driver" ? "3-wood" : undefined,
      targetYards,
      confidenceLevel: "medium",
      rationale: `Standard club for ${distToPin}yds. Adjusted for your ${carry}yd carry average.`,
    },
    aimOffset: {
      horizontal: horizontal as AimOffset["horizontal"],
      verticalBias: "front_of_green",
      offsetYards,
      reasoning: `Your miss tendency is ${miss} — aim ${Math.abs(offsetYards)}yds opposite to give margin.`,
    },
    hazardMitigation: {
      primaryThreat: hole.hazards[0]
        ? `${hole.hazards[0].type} ${hole.hazards[0].position}`
        : "Rough",
      mitigationStrategy: "Favor the safe side. Bogey is a perfectly acceptable score here.",
      noGoZone: hole.hazards[0]?.position ?? "Short left",
    },
    shotShapeInstruction: `Play your natural ${shotShape}. Don't fight your ball flight on this hole.`,
    mentalCue: "One shot, one target. Commit fully.",
    _generatedBy: "local",
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generates caddy feedback.
 * For Eagle/Coach Pro: calls Gemini (done server-side via /api/v1/caddy).
 * For Birdie/Par: returns smart local heuristic recommendation.
 */
export async function generateCaddyFeedback(
  profile: GolferProfile,
  hole: HoleGeometry,
  geminiResponseText?: string // pre-fetched from server route for Eagle users
): Promise<CaddyRecommendation> {
  if (geminiResponseText) {
    try {
      const parsed = JSON.parse(geminiResponseText);
      return { ...parsed, _generatedBy: "gemini" };
    } catch {
      // Fall through to local
    }
  }
  return generateLocalCaddyFeedback(profile, hole);
}
