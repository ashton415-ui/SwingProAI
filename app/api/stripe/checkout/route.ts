import { NextRequest, NextResponse } from "next/server";
import { resolveVerifiedAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveStripePlan } from "@/lib/billing/stripe-plan-authority";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://swing-pro-ai.vercel.app";

/**
 * GET /api/stripe/checkout?plan=birdie
 * Uses GET so CloudFront/CDN layers don't block it.
 * Redirects the browser directly to Stripe Checkout.
 *
 * The browser names a plan and nothing else. The price charged and the tier
 * recorded both come from the server plan authority (BILL-TIER1), so a caller
 * cannot pair a cheap price with a premium tier.
 *
 * This is a web-commerce surface and stays one: it authenticates the browser
 * session only, and deliberately does not accept a Bearer credential. A native
 * client never purchases here — the approved path is a subscription bought on
 * the website, normalized into server entitlement, and read back after sign-in.
 */
export async function GET(req: NextRequest) {
  const auth = await resolveVerifiedAuth();

  if (auth.status === "verification_unavailable") {
    // The credential was never judged. Sending the golfer to /login would
    // claim they are signed out, which is not what happened.
    return NextResponse.redirect(new URL("/upgrade?error=auth-unavailable", req.url));
  }

  if (auth.status !== "authenticated") {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const { searchParams } = new URL(req.url);
  // An unknown plan, or one whose price is missing or shared with another
  // plan, stops here: before any Stripe customer, link write or session.
  const plan = resolveStripePlan(searchParams.get("plan"));

  if (!plan) {
    return NextResponse.redirect(new URL("/upgrade?error=missing-plan", req.url));
  }

  const supabase = auth.client;
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("stripe_customer_id, full_name")
    .eq("id", auth.userId)
    .single();

  if (profileError) {
    // Without the golfer's row there is no way to know whether they already
    // have a Stripe customer, and guessing would mint a duplicate.
    return NextResponse.redirect(new URL("/upgrade?error=account-unavailable", req.url));
  }

  let customerId: string | null = profile?.stripe_customer_id ?? null;

  if (!customerId) {
    // Identity here is verified, not parsed out of a cookie: the email and id
    // written onto the Stripe customer are the ones Supabase Auth confirmed.
    const customer = await stripe.customers.create({
      email: auth.email ?? undefined,
      name: profile?.full_name ?? undefined,
      metadata: { supabase_user_id: auth.userId },
    });

    // The link is a billing fact, and the golfer's own session holds no UPDATE
    // on public.users, so the trusted server writer records it. Identity was
    // decided above by the verified session; the elevated client only writes
    // it, bound to that golfer's row and only while no customer is linked, so
    // an existing link is never overwritten.
    let linkedRows: unknown = null;
    let linkFailed = false;
    try {
      const admin = createAdminClient();
      const { data, error: linkError } = await admin
        .from("users")
        .update({ stripe_customer_id: customer.id })
        .eq("id", auth.userId)
        .is("stripe_customer_id", null)
        .select("id");
      linkedRows = data;
      linkFailed = Boolean(linkError);
    } catch {
      // A missing server configuration throws on construction: a failed
      // link, never a silent success.
      linkFailed = true;
    }

    // Exactly one row, proved. Zero means the row was linked concurrently or
    // is not this golfer's; either way it is not a link this request made.
    if (linkFailed || !Array.isArray(linkedRows) || linkedRows.length !== 1) {
      // The webhook grants entitlement by matching stripe_customer_id back to
      // a row. If that link did not persist, a completed payment could never
      // be attributed to this golfer, so stop before taking their money
      // rather than continuing into a checkout that cannot pay off.
      return NextResponse.redirect(
        new URL("/upgrade?error=account-link-failed", req.url),
      );
    }

    customerId = customer.id;
  }

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7,
      // Traceability only. The webhook derives tier from the price paid and
      // never reads this.
      metadata: { tier: plan.tier, supabase_user_id: auth.userId },
    },
    success_url: `${SITE_URL}/dashboard?upgraded=true`,
    cancel_url: `${SITE_URL}/upgrade`,
  });

  return NextResponse.redirect(checkoutSession.url!);
}
