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

/**
 * Premium putting analysis — its own product contract (EQ5C-A).
 *
 * Deliberately independent of every other helper in this file. It happens to
 * grant the same four tiers as the launch-monitor capability today, and that
 * is a coincidence of the current price sheet, not a relationship: putting
 * access must be free to move without dragging launch-monitor access with it.
 * So this never calls, aliases, wraps or derives from another helper, and the
 * tier list is written out in full even though it currently repeats.
 *
 * The allow-list is positive on purpose. `tier` is typed, but it originates in
 * a database column, so an unrecognised value can reach here at runtime; a
 * deny-list would grant such a value access. Anything not named below is
 * refused.
 *
 * Result visibility only. Server-side enforcement of putting *execution* is a
 * separate boundary in the analysis API and is not implied by this helper.
 */
export function canUsePuttingAnalysis(tier: SubscriptionTier): boolean {
  return (
    tier === "birdie" ||
    tier === "eagle" ||
    tier === "coach_starter" ||
    tier === "coach_pro"
  );
}

/**
 * Putting drill recommendations — its own product contract (EQ5E-C).
 *
 * Being told what your stroke did and being told what to practise about it are
 * two things a golfer can be sold separately, so they are gated separately.
 * This grants the same four tiers as putting analysis today, and as with the
 * launch-monitor coincidence above that is the current price sheet rather than
 * a relationship: either capability must be free to move without dragging the
 * other with it. So this never calls, aliases, wraps or derives from
 * canUsePuttingAnalysis or from any other helper here, and the tier list is
 * written out in full even though it currently repeats one.
 *
 * The allow-list is positive for the same reason as above: `tier` is typed but
 * originates in a database column, so an unrecognised value can reach here at
 * runtime, and a deny-list would hand it access. Anything not named below is
 * refused.
 *
 * Eligibility only. It says who may be shown a recommendation, not whether one
 * exists — ownership, analysis family, completion and canonical catalog
 * agreement are all a separate server authority boundary, and none of them is
 * implied by this helper.
 */
export function canUsePuttingRecommendations(tier: SubscriptionTier): boolean {
  return (
    tier === "birdie" ||
    tier === "eagle" ||
    tier === "coach_starter" ||
    tier === "coach_pro"
  );
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
