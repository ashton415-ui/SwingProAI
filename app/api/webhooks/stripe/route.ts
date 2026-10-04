import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/utils/supabase/admin";
import { normalizeStripeSubscriptionStatus } from "@/lib/billing/stripe-subscription-status";
import { tierForStripePriceId } from "@/lib/billing/stripe-plan-authority";
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
 *   * Every write is matched by stripe_customer_id (unique) and must prove it
 *     changed exactly one row. A write that errors, throws or matches any other
 *     number of rows answers 500, so Stripe retries instead of being told the
 *     entitlement change was recorded.
 *   * Nothing identifying — customer, subscription, user, provider or database
 *     error — is logged or returned.
 *
 * BILL-TIER1:
 *
 *   * Tier is the plan the current subscription actually pays for: its single
 *     item's price, mapped through the server plan authority. Subscription
 *     metadata is never read — checkout writes a tier there for traceability,
 *     but a value the browser once influenced is not an entitlement source.
 *   * Every subscription-bearing write persists tier alongside status, so an
 *     unknown or ambiguous price clears a previous premium tier instead of
 *     leaving it in place.
 */

/** Persistence or provider failure after a valid signature. */
class BillingWriteFailure extends Error {}

type BillingPatch = {
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
};

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

/** The subscription as Stripe holds it now. */
async function currentSubscription(reference: unknown): Promise<Stripe.Subscription> {
  const subscriptionId = idOf(reference);
  if (!subscriptionId) throw new BillingWriteFailure();
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    throw new BillingWriteFailure();
  }
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

/** The single trusted write: exactly one linked profile row, proved. */
async function persistBillingState(customerId: string, patch: BillingPatch): Promise<void> {
  let result: { data: unknown; error: unknown };
  try {
    const admin = createAdminClient();
    result = await admin
      .from("users")
      .update(patch)
      .eq("stripe_customer_id", customerId)
      .select("id");
  } catch {
    throw new BillingWriteFailure();
  }
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) {
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
        if (session.subscription) {
          // A seven-day trial checkout is "trialing", not "active".
          const subscription = await currentSubscription(session.subscription);
          await persistBillingState(customerOf(subscription), {
            subscription_status: normalizeStripeSubscriptionStatus(subscription.status),
            subscription_tier: tierOf(subscription),
          });
        } else {
          // No subscription: nothing here grants access.
          const customerId = idOf(session.customer);
          if (!customerId) throw new BillingWriteFailure();
          await persistBillingState(customerId, { subscription_status: "none", subscription_tier: "none" });
        }
        break;
      }

      case "customer.subscription.updated": {
        // The payload names the subscription; its status and price are not trusted.
        const subscription = await currentSubscription(event.data.object as Stripe.Subscription);
        await persistBillingState(customerOf(subscription), {
          subscription_status: normalizeStripeSubscriptionStatus(subscription.status),
          subscription_tier: tierOf(subscription),
        });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = await currentSubscription(event.data.object as Stripe.Subscription);
        await persistBillingState(customerOf(subscription), {
          subscription_status: normalizeStripeSubscriptionStatus(subscription.status),
          subscription_tier: "none",
        });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // An invoice with no subscription says nothing about entitlement.
        if (!invoice.subscription) break;
        const subscription = await currentSubscription(invoice.subscription);
        await persistBillingState(customerOf(subscription), {
          subscription_status: normalizeStripeSubscriptionStatus(subscription.status),
          subscription_tier: tierOf(subscription),
        });
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
