import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/utils/supabase/admin";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 400 });
  }

  // Use admin client — webhooks have no session cookie, RLS would block a normal client
  const supabase = createAdminClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = session.customer as string;

      // Retrieve subscription to get tier from metadata
      const sub = session.subscription
        ? await stripe.subscriptions.retrieve(session.subscription as string)
        : null;
      const tier = sub?.metadata?.tier ?? "par";

      const { error } = await supabase
        .from("users")
        .update({ subscription_status: "active", subscription_tier: tier })
        .eq("stripe_customer_id", customerId);

      if (error) console.error("checkout.session.completed update error:", error);
      else console.log(`Activated ${tier} for customer ${customerId}`);
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const tier = sub.metadata?.tier;
      const { error } = await supabase
        .from("users")
        .update({
          subscription_status: sub.status,
          ...(tier ? { subscription_tier: tier } : {}),
        })
        .eq("stripe_customer_id", sub.customer as string);
      if (error) console.error("subscription.updated error:", error);
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const { error } = await supabase
        .from("users")
        .update({ subscription_status: "canceled", subscription_tier: "none" })
        .eq("stripe_customer_id", sub.customer as string);
      if (error) console.error("subscription.deleted error:", error);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      await supabase
        .from("users")
        .update({ subscription_status: "past_due" })
        .eq("stripe_customer_id", invoice.customer as string);
      break;
    }

    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}
