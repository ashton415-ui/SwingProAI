import "server-only";

/**
 * SwingProAI — Stripe subscription plan authority (BILL-TIER1).
 *
 * The one place a purchasable plan, the tier it grants and the Stripe price it
 * is sold at are bound together. Checkout resolves a plan selector here, so the
 * browser never chooses a price or a tier; the webhook maps the price a current
 * subscription actually pays for back through the same catalog, so the tier
 * persisted is the tier that was bought.
 *
 * Positive allow-list only:
 *
 *   par    → STRIPE_PAR_PRICE_ID
 *   birdie → STRIPE_BIRDIE_PRICE_ID
 *   eagle  → STRIPE_EAGLE_PRICE_ID
 *
 * coach_starter and coach_pro are internal tiers with no configured price, so
 * nothing here can sell or grant them.
 *
 * Every answer is decided from the evidence for that one plan or price: a
 * missing or duplicated configuration fails closed for the plans it touches and
 * leaves a uniquely configured plan working. Selectors and price ids are
 * compared exactly — never trimmed, never lower-cased.
 *
 * Server-only: no Stripe, no Supabase, no request state, no logging.
 */

export type PurchasablePlan = "par" | "birdie" | "eagle";

export type PurchasableTier = PurchasablePlan;

export interface ResolvedStripePlan {
  plan: PurchasablePlan;
  tier: PurchasableTier;
  priceId: string;
}

const PRICE_ENV: Readonly<Record<PurchasablePlan, string>> = {
  par: "STRIPE_PAR_PRICE_ID",
  birdie: "STRIPE_BIRDIE_PRICE_ID",
  eagle: "STRIPE_EAGLE_PRICE_ID",
};

const PLANS: readonly PurchasablePlan[] = ["par", "birdie", "eagle"];

function configuredPrice(plan: PurchasablePlan): string | null {
  const priceId = process.env[PRICE_ENV[plan]];
  return typeof priceId === "string" && priceId.length > 0 ? priceId : null;
}

/** Every plan configured with this exact price id. */
function plansPricedAt(priceId: string): PurchasablePlan[] {
  return PLANS.filter((plan) => configuredPrice(plan) === priceId);
}

/**
 * Checkout authority: the plan a selector names, with the one price it is sold
 * at. null for anything that is not exactly a purchasable plan, and for a plan
 * whose price is missing or shared with another plan.
 */
export function resolveStripePlan(selector: unknown): ResolvedStripePlan | null {
  if (selector !== "par" && selector !== "birdie" && selector !== "eagle") return null;
  const priceId = configuredPrice(selector);
  if (!priceId || plansPricedAt(priceId).length !== 1) return null;
  return { plan: selector, tier: selector, priceId };
}

/**
 * Webhook authority: the tier a Stripe price id grants. null unless it matches
 * exactly one configured plan.
 */
export function tierForStripePriceId(priceId: unknown): PurchasableTier | null {
  if (typeof priceId !== "string" || priceId.length === 0) return null;
  const plans = plansPricedAt(priceId);
  return plans.length === 1 ? plans[0] : null;
}
