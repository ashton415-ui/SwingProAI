/**
 * SwingProAI — Centralized Entitlement Layer
 *
 * Single source of truth for what each subscription tier can do.
 * All feature gating should go through this file — never hardcode
 * tier names in individual components or API routes.
 */

export type SubscriptionTier =
  | "par"
  | "birdie"
  | "eagle"
  | "coach_starter"
  | "coach_pro"
  | "none";

export type AnalysisMode = "basic" | "advanced" | "ultra";

// ─── Analysis mode per tier ───────────────────────────────────────────────────

export function getAnalysisModeForTier(tier: SubscriptionTier): AnalysisMode {
  switch (tier) {
    case "eagle":
    case "coach_pro":
      return "ultra";
    case "birdie":
    case "coach_starter":
      return "advanced";
    case "par":
    case "none":
    default:
      return "basic";
  }
}

// ─── Feature flags ────────────────────────────────────────────────────────────

/** Launch monitor CSV/JSON upload + video fusion */
export function canUseLaunchMonitor(tier: SubscriptionTier): boolean {
  return ["birdie", "eagle", "coach_starter", "coach_pro"].includes(tier);
}

/** Ultra-deep biomechanical report (Eagle / Coach Pro only) */
export function canUseUltraDeepAnalysis(tier: SubscriptionTier): boolean {
  return tier === "eagle" || tier === "coach_pro";
}

/** Frame-by-frame comparison (Eagle only) */
export function canUseFrameComparison(tier: SubscriptionTier): boolean {
  return tier === "eagle";
}

/** Priority processing queue position (lower = higher priority) */
export function getPriorityForTier(tier: SubscriptionTier): number {
  switch (tier) {
    case "eagle":      return 10;
    case "coach_pro":  return 20;
    case "birdie":     return 30;
    case "coach_starter": return 35;
    case "par":
    case "none":
    default:           return 100;
  }
}

/** Max saved swing analyses */
export function getSwingLimitForTier(tier: SubscriptionTier): number | null {
  switch (tier) {
    case "eagle":
    case "coach_pro":
    case "birdie":
    case "coach_starter":
      return null; // unlimited
    case "par":
      return 10;
    case "none":
    default:
      return 3;
  }
}

/** Human-readable tier display name */
export function getTierDisplayName(tier: SubscriptionTier): string {
  const names: Record<SubscriptionTier, string> = {
    par: "Par",
    birdie: "Birdie",
    eagle: "Eagle",
    coach_starter: "Coach Starter",
    coach_pro: "Coach Pro",
    none: "Free",
  };
  return names[tier] ?? "Free";
}

/** Upsell target tier for a given tier */
export function getUpsellTier(tier: SubscriptionTier): SubscriptionTier | null {
  switch (tier) {
    case "none":
    case "par":   return "birdie";
    case "birdie": return "eagle";
    default:       return null;
  }
}
