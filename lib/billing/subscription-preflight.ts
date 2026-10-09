/**
 * SwingProAI — Stripe subscription history preflight (PRICING-1).
 *
 * Classifies a customer's COMPLETE Stripe subscription history, already
 * retrieved and fully paginated by the caller, into the two facts checkout and
 * the webhook decide on:
 *
 *   * hasNonterminal / nonterminalSubscriptions — anything that is not finally
 *     over. Checkout refuses to open a second purchase while one exists, and
 *     the webhook refuses to cancel an unbound row because of it.
 *   * priorTrial — any subscription in the history ever carried a trial. That
 *     removes the introductory trial; it does not block a paid checkout.
 *
 * Only two Stripe statuses are terminal:
 *
 *   canceled, incomplete_expired
 *
 * Every other status — incomplete, trialing, active, past_due, unpaid, paused,
 * an unknown future status, a missing or non-string status — is treated as
 * nonterminal, so an unrecognized state blocks rather than silently passing.
 * Statuses are compared exactly: never trimmed, never lower-cased.
 *
 * Pure: no environment, no Stripe, no Supabase, no side effects.
 */

export const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired"] as const;

/** The subscription fields the classification reads. */
export interface SubscriptionHistoryEntry {
  id?: unknown;
  status?: unknown;
  trial_start?: unknown;
}

export interface SubscriptionHistoryClassification<T extends SubscriptionHistoryEntry> {
  hasNonterminal: boolean;
  nonterminalSubscriptions: T[];
  priorTrial: boolean;
}

export function isTerminalStripeSubscriptionStatus(status: unknown): boolean {
  return (TERMINAL_STRIPE_SUBSCRIPTION_STATUSES as readonly unknown[]).includes(status);
}

/** A trial is evidenced by any non-null trial_start. */
export function hadTrial(subscription: SubscriptionHistoryEntry): boolean {
  return subscription.trial_start !== null && subscription.trial_start !== undefined;
}

export function classifySubscriptionHistory<T extends SubscriptionHistoryEntry>(
  subscriptions: readonly T[],
): SubscriptionHistoryClassification<T> {
  const nonterminalSubscriptions = subscriptions.filter(
    (subscription) => !isTerminalStripeSubscriptionStatus(subscription.status),
  );
  return {
    hasNonterminal: nonterminalSubscriptions.length > 0,
    nonterminalSubscriptions,
    priorTrial: subscriptions.some(hadTrial),
  };
}
