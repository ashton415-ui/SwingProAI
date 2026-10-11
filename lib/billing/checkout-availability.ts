/**
 * PRICING-1 checkout hold: whether new paid checkout may start.
 *
 * New memberships are paused while membership claims and tier enforcement are
 * corrected. This constant is the only switch, and it is code on purpose: no
 * environment variable, header, role or browser state can reopen checkout.
 * Reopening is a reviewed code change and a deployment.
 *
 * It gates new checkout only. Existing subscribers, the billing portal and the
 * Stripe webhook are unaffected.
 */
export const CHECKOUT_AVAILABLE = false as const;
