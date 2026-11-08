import "server-only";
import {
  canUsePuttingAnalysis,
  canViewEquipmentFitting,
  canViewLaunchMonitorIntelligence,
  canViewUltraDeepAnalysis,
  resolvePaidAnalysisMode,
  type AnalysisMode,
  type SubscriptionTier,
} from "@/lib/entitlements";
import type { AuthenticatedCaller } from "@/utils/supabase/server";

/**
 * SwingProAI — analysis access decision (ENT-1A, revised by ENT-1C).
 *
 * The one place a full-swing execution or analysis-result path learns what the
 * verified caller may run and see. It answers from the caller's OWN
 * public.users row, read on the caller-scoped client; anon and authenticated
 * hold no INSERT or UPDATE on public.users, so a caller cannot grant
 * themselves a tier or a status, and nothing in a request is ever consulted.
 *
 * Core full-swing feedback — score, summary, strengths, improvement areas,
 * measurements and foundational drills — is not a paid capability. Every
 * legitimate account receives it, FREE included, and a downgrade never takes
 * it away. No quota is applied here; getSwingLimitForTier is not consulted.
 *
 * Premium classes each have their own helper in lib/entitlements (equipment
 * fitting, launch-monitor intelligence, ultra-deep analysis) and each requires
 * a paying status. Putting keeps its existing tier-only contract
 * (canUsePuttingAnalysis); ENT-1C does not change it.
 *
 * A missing row, a read error, or a tier or status outside the database's own
 * vocabulary is `unavailable`. Execution refuses on it; result reads fall back
 * to NO_PREMIUM_ACCESS, so ownership-proven core history stays readable while
 * nothing premium is released. Nothing here writes.
 */

/** The exact projection: the two columns the decision needs, nothing else. */
export const ANALYSIS_ENTITLEMENT_COLUMNS = "subscription_tier, subscription_status";

/** Mirrors users_subscription_tier_check. Positive allow-list. */
const KNOWN_TIERS: readonly SubscriptionTier[] = [
  "par",
  "birdie",
  "eagle",
  "coach_starter",
  "coach_pro",
  "none",
];

/** Mirrors users_subscription_status_check. Positive allow-list. */
const KNOWN_STATUSES: readonly string[] = ["active", "trialing", "past_due", "canceled", "none"];

export interface AnalysisAccess {
  /** Putting analysis and score display — the existing tier-only contract. */
  readonly puttingAnalysis: boolean;
  /** Equipment fitting attached to an analysis. */
  readonly equipmentFitting: boolean;
  /** Launch-monitor intelligence attached to an analysis. */
  readonly launchMonitorIntelligence: boolean;
  /** Ultra-deep analysis content. */
  readonly ultraDeepAnalysis: boolean;
  /** The analysis depth the membership pays for. */
  readonly analysisMode: AnalysisMode;
}

/** What an unresolved caller is given: core feedback only. */
export const NO_PREMIUM_ACCESS: AnalysisAccess = Object.freeze({
  puttingAnalysis: false,
  equipmentFitting: false,
  launchMonitorIntelligence: false,
  ultraDeepAnalysis: false,
  analysisMode: "basic",
});

export type AnalysisAccessDecision =
  | { readonly status: "allowed"; readonly tier: SubscriptionTier; readonly access: AnalysisAccess }
  | { readonly status: "unavailable" };

function isKnownTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && KNOWN_TIERS.some((tier) => tier === value);
}

function isKnownStatus(value: unknown): value is string {
  return typeof value === "string" && KNOWN_STATUSES.includes(value);
}

/** The pure decision. Unknown or malformed values are `unavailable`. */
export function decideAnalysisAccess(tier: unknown, status: unknown): AnalysisAccessDecision {
  if (!isKnownTier(tier) || !isKnownStatus(status)) {
    return { status: "unavailable" };
  }
  return {
    status: "allowed",
    tier,
    access: Object.freeze({
      puttingAnalysis: canUsePuttingAnalysis(tier),
      equipmentFitting: canViewEquipmentFitting(tier, status),
      launchMonitorIntelligence: canViewLaunchMonitorIntelligence(tier, status),
      ultraDeepAnalysis: canViewUltraDeepAnalysis(tier, status),
      analysisMode: resolvePaidAnalysisMode(tier, status),
    }),
  };
}

type EntitlementReader = AuthenticatedCaller["client"];

/** Reads the caller's own row and decides. Never throws. */
export async function resolveAnalysisAccess(
  client: EntitlementReader,
  userId: string,
): Promise<AnalysisAccessDecision> {
  try {
    const { data, error } = await client
      .from("users")
      .select(ANALYSIS_ENTITLEMENT_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return { status: "unavailable" };
    const row = data as { subscription_tier?: unknown; subscription_status?: unknown };
    return decideAnalysisAccess(row.subscription_tier, row.subscription_status);
  } catch {
    return { status: "unavailable" };
  }
}

/** Read paths: an unresolved caller keeps core feedback and receives nothing premium. */
export function accessOf(decision: AnalysisAccessDecision): AnalysisAccess {
  return decision.status === "allowed" ? decision.access : NO_PREMIUM_ACCESS;
}
