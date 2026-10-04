import type { SubscriptionStatus } from "@/types/database";

/**
 * SwingProAI — Stripe subscription status → internal billing status (BILL-STATUS1).
 *
 * The one place a Stripe subscription status is translated into the five-value
 * vocabulary public.users.subscription_status accepts
 * (active | trialing | past_due | canceled | none). A raw Stripe status is never
 * persisted: Stripe has states the database refuses, and a refused write used
 * to leave the previous, possibly entitling, status in place.
 *
 *   active, trialing                    → themselves   (the only entitling states)
 *   past_due, incomplete, paused, unpaid → past_due    (recoverable, not paying)
 *   canceled, incomplete_expired        → canceled     (terminal)
 *   anything else                       → none         (fail closed)
 *
 * "Anything else" includes a future Stripe status, an empty string, a value in
 * a different case or with surrounding whitespace, and every non-string. The
 * input is compared exactly — never trimmed, never lower-cased — because an
 * approximate match is a guess, and a guess here grants or withholds paid
 * access.
 *
 * Pure: no environment, no Stripe, no Supabase, no side effects.
 */
export function normalizeStripeSubscriptionStatus(status: unknown): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "incomplete":
    case "paused":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "none";
  }
}
