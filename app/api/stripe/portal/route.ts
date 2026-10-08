import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { resolveVerifiedAuth } from "@/utils/supabase/server";
import { canManageBilling } from "@/lib/billing/manage-billing-eligibility";

/**
 * POST /api/stripe/portal — open the Stripe billing portal (PRICING-1).
 *
 * The browser sends a form POST and nothing else. Every billing authority is
 * the server's:
 *
 *   * customer       the signed-in golfer's own stored stripe_customer_id;
 *   * configuration  STRIPE_PORTAL_CONFIGURATION_ID, the dedicated non-default
 *                    portal configuration (cancel at period end, no plan
 *                    changes), never the account default;
 *   * return_url     a fixed SwingProAI page.
 *
 * The request body, query and Authorization header are never read. Cancelling
 * happens inside Stripe; the webhook remains the only writer of billing state,
 * so this route writes nothing.
 *
 * Web only: the browser session cookie is the sole accepted credential. Native
 * portal access is a separate slice.
 */

const CANONICAL_ORIGIN = "https://www.swingpro-ai.com";
const RETURN_URL = `${CANONICAL_ORIGIN}/upgrade`;
const STRIPE_BILLING_URL_PREFIX = "https://billing.stripe.com/";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function forbidden(): NextResponse {
  return noStore(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
}

/** 303 so the browser follows with GET instead of re-posting. */
function seeOther(url: string): NextResponse {
  return noStore(NextResponse.redirect(url, { status: 303 }));
}

function unavailable(): NextResponse {
  return seeOther(`${RETURN_URL}?billing=unavailable`);
}

export async function POST(req: NextRequest) {
  // Opening a portal session is a side effect, so a cross-site form must not be
  // able to trigger one. The check runs before any credential is touched.
  if (req.headers.get("origin") !== CANONICAL_ORIGIN) return forbidden();

  const auth = await resolveVerifiedAuth();

  if (auth.status === "verification_unavailable") {
    // Auth did not answer; this is not a signed-out golfer.
    return seeOther(`${RETURN_URL}?billing=auth-unavailable`);
  }

  if (auth.status !== "authenticated") return seeOther(`${CANONICAL_ORIGIN}/login`);

  if (auth.source !== "cookie") return forbidden();

  const { data: profile, error: profileError } = await auth.client
    .from("users")
    .select("stripe_customer_id, subscription_status")
    .eq("id", auth.userId)
    .single();

  if (profileError || !profile) return unavailable();

  const customerId = profile.stripe_customer_id;
  if (!canManageBilling(customerId, profile.subscription_status) || typeof customerId !== "string") {
    return unavailable();
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
  if (!secretKey || !configuration) return unavailable();

  let portalUrl: unknown;
  try {
    const stripe = new Stripe(secretKey);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration,
      return_url: RETURN_URL,
    });
    portalUrl = session.url;
  } catch {
    // Provider detail can name the customer or configuration; none of it is
    // logged or returned.
    return unavailable();
  }

  if (typeof portalUrl !== "string" || !portalUrl.startsWith(STRIPE_BILLING_URL_PREFIX)) {
    return unavailable();
  }

  return seeOther(portalUrl);
}
