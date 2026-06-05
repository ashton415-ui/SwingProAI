import { NextRequest, NextResponse } from "next/server";
import { createClient, getServerSession } from "@/utils/supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://swing-pro-ai.vercel.app";

export async function POST(req: NextRequest) {
  // Use our cookie-based session (not supabase.auth.getUser which fails)
  const session = await getServerSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const body = await req.json();
  const priceId = body.priceId as string;
  const tier = body.tier as string;

  if (!priceId || !tier) {
    return NextResponse.redirect(new URL("/upgrade?error=missing-plan", req.url));
  }

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("stripe_customer_id, email, full_name")
    .eq("id", session.user.id)
    .single();

  // Reuse or create Stripe customer
  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.user.email,
      name: profile?.full_name ?? undefined,
      metadata: { supabase_user_id: session.user.id },
    });
    customerId = customer.id;
    await supabase
      .from("users")
      .update({ stripe_customer_id: customerId })
      .eq("id", session.user.id);
  }

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7,
      metadata: { tier, supabase_user_id: session.user.id },
    },
    success_url: `${SITE_URL}/dashboard?upgraded=true`,
    cancel_url: `${SITE_URL}/upgrade`,
  });

  // Return JSON — client JS navigates to Stripe (avoids CloudFront POST blocking)
  return NextResponse.json({ url: checkoutSession.url });
}
