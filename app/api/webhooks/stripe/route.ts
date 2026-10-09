import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/utils/supabase/admin";
import { normalizeStripeSubscriptionStatus } from "@/lib/billing/stripe-subscription-status";
import { tierForStripePriceId } from "@/lib/billing/stripe-plan-authority";
import {
  classifySubscriptionHistory,
  hadTrial,
  isTerminalStripeSubscriptionStatus,
} from "@/lib/billing/subscription-preflight";
import type { SubscriptionStatus, SubscriptionTier } from "@/types/database";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

/**
 * Stripe webhook — the trusted writer of billing state on public.users.
 *
 * BILL-STATUS1:
 *
 *   * The signature is verified against the raw request body before anything
 *     else is read.
 *   * Billing truth is the CURRENT Stripe subscription, retrieved by id, never
 *     the status carried in the event payload: Stripe does not guarantee
 *     delivery order, and a stale payload must not overwrite a newer state.
 *   * Every status written goes through normalizeStripeSubscriptionStatus, so
 *     only the five values the database accepts are ever persisted.
 *   * A write that errors, throws, finds no profile, or is refused answers 500,
 *     so Stripe retries instead of being told the entitlement change was
 *     recorded.
 *   * Nothing identifying — customer, subscription, user, provider or database
 *     error — is logged or returned.
 *
 * BILL-TIER1:
 *
 *   * Tier is the plan the current subscription actually pays for: its single
 *     item's price, mapped through the server plan authority. The key/value
 *     annotations on a subscription are never read — checkout writes a tier
 *     there for traceability, but a value the browser once influenced is not
 *     an entitlement source.
 *   * Every subscription-bearing write persists tier alongside status, so an
 *     unknown or ambiguous price clears a previous premium tier instead of
 *     leaving it in place.
 *
 * PRICING-1:
 *
 *   * Every billing write is one call to billing_apply_subscription_state,
 *     which in a single transaction locks the profile by its Stripe customer,
 *     enforces subscription identity, writes status and tier, binds or clears
 *     the bound subscription id, records trial usage monotonically, and clears
 *     a checkout claim only for an exact non-NULL token.
 *   * A nonterminal subscription that differs from the bound one is a
 *     conflict: nothing is written, the claim stays held, and the event is
 *     retried until an operator resolves it.
 *   * A terminal event for a different bound subscription changes nothing.
 *   * A terminal event for an unbound row is never trusted alone: the
 *     customer's full Stripe history decides. No nonterminal subscription →
 *     canceled. Exactly one with a recognized price → bind that one instead.
 *     Anything else → retry, no write.
 *   * Only checkout.session.completed carries a claim token (the Session's
 *     client_reference_id). Every other event passes NULL, which can never
 *     clear a claim.
 */

/** Persistence or provider failure after a valid signature. */
class BillingWriteFailure extends Error {}

type ApplyOutcome = "applied" | "stale_terminal" | "conflict" | "unbound_terminal_recheck" | "not_found";

const APPLY_OUTCOMES: readonly string[] = [
  "applied",
  "stale_terminal",
  "conflict",
  "unbound_terminal_recheck",
  "not_found",
];

interface SubscriptionState {
  subscriptionId: string;
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
  trialReceived: boolean;
}

/** History pages read before giving up; a customer never legitimately nears it. */
const MAX_SUBSCRIPTION_PAGES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function failed(): NextResponse {
  return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
}

/** A Stripe reference arrives as an id string or as an expanded object. */
function idOf(reference: unknown): string | null {
  if (typeof reference === "string") return reference.length > 0 ? reference : null;
  if (typeof reference === "object" && reference !== null) {
    const id = (reference as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

function objectLike(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** The checkout claim a Session correlates to, or null. Never an authority. */
function claimTokenOf(reference: unknown): string | null {
  return typeof reference === "string" && UUID.test(reference) ? reference : null;
}

/**
 * The subscription that generated an invoice, from whichever snapshot shape
 * the webhook endpoint's API version renders: current versions name it at
 * parent.subscription_details.subscription (only when parent.type says so);
 * 2024-04-10 names it at the top-level subscription field. null when neither
 * names one. A top-level reference that is present but carries no usable id,
 * or two different subscriptions, are faults in signed data, never a choice:
 * those fail, before any retrieval or write.
 */
function invoiceSubscriptionId(invoice: unknown): string | null {
  const fields = objectLike(invoice);
  if (!fields) return null;
  const parent = objectLike(fields.parent);
  const details = parent?.type === "subscription_details" ? objectLike(parent.subscription_details) : null;
  const current = details ? idOf(details.subscription) : null;
  const legacy = idOf(fields.subscription);
  if (fields.subscription && !legacy) throw new BillingWriteFailure();
  if (current && legacy && current !== legacy) throw new BillingWriteFailure();
  return current ?? legacy;
}

/** The subscription as Stripe holds it now. */
async function currentSubscription(reference: unknown): Promise<Stripe.Subscription> {
  const subscriptionId = idOf(reference);
  if (!subscriptionId) throw new BillingWriteFailure();
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    throw new BillingWriteFailure();
  }
  if (idOf(subscription?.id) !== subscriptionId) throw new BillingWriteFailure();
  return subscription;
}

function customerOf(subscription: Stripe.Subscription): string {
  const customerId = idOf(subscription.customer);
  if (!customerId) throw new BillingWriteFailure();
  return customerId;
}

/**
 * The tier the subscription pays for. Exactly one item, whose price matches
 * exactly one configured plan; anything else — no items, several items, a
 * missing, unknown or ambiguously configured price — grants nothing.
 */
function tierOf(subscription: Stripe.Subscription): SubscriptionTier {
  const items: unknown = subscription.items?.data;
  if (!Array.isArray(items) || items.length !== 1) return "none";
  const price: unknown = (items[0] as { price?: unknown } | null)?.price;
  const priceId = typeof price === "object" && price !== null ? (price as { id?: unknown }).id : undefined;
  return tierForStripePriceId(priceId) ?? "none";
}

/** What a current subscription says, normalized and server-derived. */
function stateOf(subscription: Stripe.Subscription): SubscriptionState {
  const status = normalizeStripeSubscriptionStatus(subscription.status);
  return {
    subscriptionId: subscription.id,
    subscription_status: status,
    // A terminal subscription never entitles, whatever it was paying for.
    subscription_tier: status === "canceled" ? "none" : tierOf(subscription),
    trialReceived: hadTrial(subscription),
  };
}

function admin() {
  try {
    return createAdminClient();
  } catch {
    throw new BillingWriteFailure();
  }
}

/** The single trusted billing write: one atomic database call. */
async function applySubscriptionState(
  customerId: string,
  claimToken: string | null,
  state: SubscriptionState,
  allowUnboundTerminal: boolean,
): Promise<ApplyOutcome> {
  let result: { data: unknown; error: unknown };
  try {
    result = await admin().rpc("billing_apply_subscription_state", {
      p_stripe_customer_id: customerId,
      p_claim_token: claimToken,
      p_subscription_id: state.subscriptionId,
      p_subscription_status: state.subscription_status,
      p_subscription_tier: state.subscription_tier,
      p_trial_received: state.trialReceived,
      p_allow_unbound_terminal: allowUnboundTerminal,
    });
  } catch {
    throw new BillingWriteFailure();
  }
  if (result.error || typeof result.data !== "string" || !APPLY_OUTCOMES.includes(result.data)) {
    throw new BillingWriteFailure();
  }
  return result.data as ApplyOutcome;
}

/** Every subscription the customer has ever had, or a throw. Never partial. */
async function subscriptionHistory(customerId: string): Promise<Stripe.Subscription[]> {
  const all: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page++) {
      const result = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      if (!result || !Array.isArray(result.data) || typeof result.has_more !== "boolean") break;
      all.push(...result.data);
      if (!result.has_more) return all;
      const last = result.data[result.data.length - 1];
      if (!last || typeof last.id !== "string" || last.id.length === 0 || last.id === startingAfter) break;
      startingAfter = last.id;
    }
  } catch {
    throw new BillingWriteFailure();
  }
  throw new BillingWriteFailure();
}

/**
 * A terminal event for a row with no bound subscription. The row may carry
 * entitlement written before subscription identity existed, so the event is
 * neither ignored nor trusted alone: the customer's whole Stripe history
 * decides.
 */
async function reconcileUnboundTerminal(
  customerId: string,
  claimToken: string | null,
  terminal: SubscriptionState,
): Promise<void> {
  const { nonterminalSubscriptions } = classifySubscriptionHistory(await subscriptionHistory(customerId));

  if (nonterminalSubscriptions.length === 0) {
    // Truly over: cancel, unless a subscription was bound in the meantime.
    const outcome = await applySubscriptionState(customerId, claimToken, terminal, true);
    if (outcome !== "applied" && outcome !== "stale_terminal") throw new BillingWriteFailure();
    return;
  }

  // Never cancel because of the terminal event while something is still live.
  if (nonterminalSubscriptions.length !== 1) throw new BillingWriteFailure();

  const current = await currentSubscription(nonterminalSubscriptions[0].id);
  if (customerOf(current) !== customerId || isTerminalStripeSubscriptionStatus(current.status)) {
    throw new BillingWriteFailure();
  }
  const state = stateOf(current);
  // A live subscription whose price is not recognized is not something to bind.
  if (state.subscription_tier === "none") throw new BillingWriteFailure();

  const outcome = await applySubscriptionState(customerId, null, state, false);
  if (outcome !== "applied") throw new BillingWriteFailure();
}

/** Applies one current subscription; anything but a safe outcome retries. */
async function applySubscription(subscription: Stripe.Subscription, claimToken: string | null): Promise<void> {
  const customerId = customerOf(subscription);
  const state = stateOf(subscription);
  const outcome = await applySubscriptionState(customerId, claimToken, state, false);

  switch (outcome) {
    case "applied":
    case "stale_terminal":
      return;
    case "unbound_terminal_recheck":
      return reconcileUnboundTerminal(customerId, claimToken, state);
    default:
      // conflict, not_found: no write, claim untouched, Stripe retries.
      throw new BillingWriteFailure();
  }
}

/**
 * A completed Session that created no subscription grants and revokes
 * nothing; it only releases the claim it correlates to, on exactly one
 * profile.
 */
async function releaseClaimForCustomer(customerId: string, claimToken: string): Promise<void> {
  const client = admin();
  let rows: unknown;
  try {
    const { data, error } = await client.from("users").select("id").eq("stripe_customer_id", customerId);
    if (error) throw new BillingWriteFailure();
    rows = data;
  } catch {
    throw new BillingWriteFailure();
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw new BillingWriteFailure();
  const profileId = (rows[0] as { id?: unknown }).id;
  if (typeof profileId !== "string") throw new BillingWriteFailure();
  try {
    const { error } = await client.rpc("billing_release_checkout", {
      p_user_id: profileId,
      p_claim_token: claimToken,
    });
    if (error) throw new BillingWriteFailure();
  } catch {
    throw new BillingWriteFailure();
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const claimToken = claimTokenOf(session.client_reference_id);
        if (session.subscription) {
          // A seven-day trial checkout is "trialing", not "active".
          await applySubscription(await currentSubscription(session.subscription), claimToken);
        } else {
          // No subscription: nothing here grants or revokes access.
          const customerId = idOf(session.customer);
          if (!customerId) throw new BillingWriteFailure();
          if (claimToken) await releaseClaimForCustomer(customerId, claimToken);
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // The payload names the subscription; its status and price are not trusted.
        await applySubscription(await currentSubscription(event.data.object as Stripe.Subscription), null);
        break;
      }

      case "invoice.payment_failed": {
        // An invoice with no subscription says nothing about entitlement.
        const subscriptionId = invoiceSubscriptionId(event.data.object);
        if (!subscriptionId) break;
        await applySubscription(await currentSubscription(subscriptionId), null);
        break;
      }

      default:
        break;
    }
  } catch {
    return failed();
  }

  return NextResponse.json({ received: true });
}
