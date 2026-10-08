/**
 * SwingProAI — who may open the Stripe billing portal (PRICING-1).
 *
 * The one rule shared by the portal route, which enforces it, and the Plan &
 * Billing page, which only decides what to render. A golfer can manage billing
 * when the server holds a Stripe customer for them AND their stored status is
 * one Stripe has a billing relationship behind:
 *
 *   active, trialing   cancel at period end
 *   past_due           update the payment method
 *   canceled           review invoice history
 *
 * "none" has no subscription to manage and is refused. Statuses are compared
 * exactly as stored: BILL-STATUS1 already normalized them before persistence,
 * and nothing is mapped, trimmed or lower-cased here.
 *
 * Pure: no environment, no Stripe, no Supabase, no side effects.
 */
export const MANAGE_BILLING_STATUSES = ["active", "trialing", "past_due", "canceled"] as const;

export type ManageBillingStatus = (typeof MANAGE_BILLING_STATUSES)[number];

export function canManageBilling(customerId: unknown, status: unknown): boolean {
  if (typeof customerId !== "string" || customerId.trim().length === 0) return false;
  return (MANAGE_BILLING_STATUSES as readonly unknown[]).includes(status);
}
