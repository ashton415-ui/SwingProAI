import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@/utils/supabase/server";

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

  const supabase = await createClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = session.customer as string;
      // Retrieve subscription to get tier metadata
      const sub = await stripe.subscriptions.retrieve(session.subscription as string);
      const tier = sub.metadata?.tier ?? "par";
      await supabase
        .from("users")
        .update({ subscription_status: "active", subscription_tier: tier })
        .eq("stripe_customer_id", customerId);
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const tier = sub.metadata?.tier;
      await supabase
        .from("users")
        .update({
          subscription_status: sub.status,
          ...(tier ? { subscription_tier: tier } : {}),
        })
        .eq("stripe_customer_id", sub.customer as string);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await supabase
        .from("users")
        .update({ subscription_status: "canceled", subscription_tier: "none" })
        .eq("stripe_customer_id", sub.customer as string);
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
