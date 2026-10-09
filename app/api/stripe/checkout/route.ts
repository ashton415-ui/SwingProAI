import { NextRequest, NextResponse } from "next/server";
import { resolveVerifiedAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { resolveStripePlan } from "@/lib/billing/stripe-plan-authority";
import { classifySubscriptionHistory } from "@/lib/billing/subscription-preflight";
import Stripe from "stripe";

/**
 * POST /api/stripe/checkout — open a Stripe Checkout Session (PRICING-1).
 *
 * The browser sends a same-origin form POST naming a plan and nothing else.
 * The price charged and the tier recorded both come from the server plan
 * authority (BILL-TIER1); trial eligibility, customer, URLs, claim and expiry
 * are all the server's.
 *
 * This is a web-commerce surface and stays one: it authenticates the browser
 * session cookie only, and deliberately does not accept a Bearer credential. A
 * native client never purchases here — the approved path is a subscription
 * bought on the website, normalized into server entitlement, and read back
 * after sign-in.
 *
 * Concurrency (billing_checkout_guard):
 *
 *   * billing_begin_checkout atomically checks local eligibility (no bound
 *     subscription, status none or canceled) and takes the one checkout claim,
 *     or reports the claim already held. A held claim is never overwritten.
 *   * A held claim is recovered only by compare-and-swap takeover: an
 *     unattached claim once it is 180 seconds old; an attached Session only
 *     once Stripe shows it expired, or has expired it on request after the
 *     local claim lapsed. An open or completed attached Session is left alone.
 *   * Customer authority comes from the claim itself: begin and takeover
 *     return the profile's durable stripe_customer_id, read under the same
 *     lock that granted the claim. A pre-claim snapshot never decides it.
 *   * A new Stripe customer is linked only through
 *     billing_link_checkout_customer, which writes it for the CURRENT claim
 *     token alone and never replaces an existing customer. A superseded
 *     request gets lost and creates no Session. Every Stripe create is
 *     idempotent on server-derived keys.
 *   * A Session expires exactly when its claim does, so no Session outlives
 *     the claim that authorized it.
 *   * A Session that cannot be attached to its claim is expired and its URL
 *     never returned.
 *
 * A request can lose its claim while a Stripe call is in flight; Postgres and
 * Stripe cannot share one transaction. Such a stale request may leave a
 * transient Stripe customer or Session behind, but it can never link the
 * customer, attach the Session, return its URL, or touch the successor claim.
 *
 * One trial per account: the trial is offered only when the account has never
 * recorded one AND the customer's full Stripe history shows none. A prior
 * trial removes the trial, never a paid checkout. An existing nonterminal
 * subscription blocks checkout entirely.
 *
 * Nothing identifying — customer, subscription, Session, claim or provider
 * detail — is logged or returned.
 */

const CANONICAL_ORIGIN = "https://www.swingpro-ai.com";
const UPGRADE_URL = `${CANONICAL_ORIGIN}/upgrade`;
const SUCCESS_URL = `${CANONICAL_ORIGIN}/dashboard?upgraded=true`;
const CANCEL_URL = `${CANONICAL_ORIGIN}/upgrade`;
const STRIPE_CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";

const CLAIM_TTL_SECONDS = 2100;
const UNATTACHED_CLAIM_STALE_SECONDS = 180;
const MIN_REMAINING_SECONDS_BEFORE_SESSION_CREATE = 1830;

/** History pages read before giving up; a customer never legitimately nears it. */
const MAX_SUBSCRIPTION_PAGES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Admin = ReturnType<typeof createAdminClient>;

interface Claim {
  token: string;
  expiresAt: number;
  /** Seconds left on the claim when the database answered. */
  remainingSeconds: number;
  /** Local clock when the database answered; only elapsed time is used. */
  observedAt: number;
  trialUsed: boolean;
}

/** The answers billing_link_checkout_customer can give. */
const LINK_OUTCOMES: readonly string[] = [
  "linked",
  "already_linked_same",
  "lost",
  "blocked",
  "customer_conflict",
  "not_found",
];

type ClaimResult =
  | { outcome: "claimed"; claim: Claim; customerId: string | null }
  | { outcome: "held"; claim: Claim; ageSeconds: number; heldSessionId: string | null }
  | { outcome: "blocked" | "not_found" | "lost" };

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

function notice(checkout: string): NextResponse {
  return seeOther(`${UPGRADE_URL}?checkout=${checkout}`);
}

const unavailable = () => notice("unavailable");
const inProgress = () => notice("in-progress");

/** A claim answer from the guard functions, or null if it is not one. */
function parseClaimResult(data: unknown): ClaimResult | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  const outcome = row.outcome;
  if (outcome === "blocked" || outcome === "not_found" || outcome === "lost") return { outcome };
  if (outcome !== "claimed" && outcome !== "held") return null;

  const token = row.claim_token;
  const expiresAt = typeof row.claim_expires_at === "string" ? Date.parse(row.claim_expires_at) : NaN;
  const remaining = Number(row.claim_remaining_seconds);
  if (typeof token !== "string" || !UUID.test(token)) return null;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(remaining) || typeof row.trial_used !== "boolean") return null;

  const claim: Claim = {
    token,
    expiresAt,
    remainingSeconds: remaining,
    observedAt: Date.now(),
    trialUsed: row.trial_used,
  };
  if (outcome === "claimed") {
    // The durable customer as the claim's own locked read saw it: NULL or a
    // non-empty id. Absent or anything else is not a claim answer.
    if (!("stripe_customer_id" in row)) return null;
    const customerId = row.stripe_customer_id;
    if (customerId !== null && (typeof customerId !== "string" || customerId.length === 0)) return null;
    return { outcome, claim, customerId };
  }

  const age = Number(row.claim_age_seconds);
  const held = row.held_session_id;
  if (!Number.isFinite(age)) return null;
  if (held !== null && (typeof held !== "string" || held.length === 0)) return null;
  return { outcome, claim, ageSeconds: age, heldSessionId: held };
}

async function claimRpc(admin: Admin, fn: string, args: Record<string, unknown>): Promise<ClaimResult | null> {
  try {
    const { data, error } = await admin.rpc(fn, args);
    if (error) return null;
    return parseClaimResult(data);
  } catch {
    return null;
  }
}

/** The link function's answer, or null for an error, throw or unknown answer. */
async function linkCustomer(admin: Admin, userId: string, token: string, customerId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("billing_link_checkout_customer", {
      p_user_id: userId,
      p_claim_token: token,
      p_stripe_customer_id: customerId,
    });
    if (error || typeof data !== "string" || !LINK_OUTCOMES.includes(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Seconds the claim still has, by elapsed local time since the database answered. */
function remainingNow(claim: Claim): number {
  return claim.remainingSeconds - (Date.now() - claim.observedAt) / 1000;
}

/** Releases only this exact token; a newer claim is never touched. */
async function release(admin: Admin, userId: string, token: string): Promise<void> {
  try {
    await admin.rpc("billing_release_checkout", { p_user_id: userId, p_claim_token: token });
  } catch {
    // An unreleased claim falls to the stale-claim recovery path.
  }
}

/** True only once Stripe shows this exact Session expired. */
async function ensureSessionExpired(stripe: Stripe, sessionId: string): Promise<boolean> {
  try {
    const expired = await stripe.checkout.sessions.expire(sessionId);
    if (expired?.status === "expired") return true;
  } catch {
    // Already expired is fine; anything else is decided by the re-read below.
  }
  try {
    const current = await stripe.checkout.sessions.retrieve(sessionId);
    return current?.status === "expired";
  } catch {
    return false;
  }
}

/** Every subscription the customer has ever had, or a throw. Never partial. */
async function subscriptionHistory(stripe: Stripe, customerId: string): Promise<Stripe.Subscription[]> {
  const all: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page++) {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== "boolean") {
      throw new Error("Malformed subscription page");
    }
    all.push(...result.data);
    if (!result.has_more) return all;
    const last = result.data[result.data.length - 1];
    if (!last || typeof last.id !== "string" || last.id.length === 0 || last.id === startingAfter) {
      throw new Error("Inconsistent subscription pagination");
    }
    startingAfter = last.id;
  }
  throw new Error("Subscription history too long");
}

export async function POST(req: NextRequest) {
  // Opening a Checkout Session is a side effect, so a cross-site form must not
  // be able to trigger one. The check runs before any credential is touched.
  if (req.headers.get("origin") !== CANONICAL_ORIGIN) return forbidden();

  const auth = await resolveVerifiedAuth();

  if (auth.status === "verification_unavailable") {
    // The credential was never judged. Sending the golfer to /login would
    // claim they are signed out, which is not what happened.
    return notice("auth-unavailable");
  }

  if (auth.status !== "authenticated") return seeOther(`${CANONICAL_ORIGIN}/login`);

  if (auth.source !== "cookie") return forbidden();

  // The only browser input: a plan selector. An unknown plan, or one whose
  // price is missing or shared with another plan, stops here: before any
  // claim, Stripe customer, link write or Session.
  let selector: unknown = null;
  try {
    selector = (await req.formData()).get("plan");
  } catch {
    selector = null;
  }
  const plan = resolveStripePlan(selector);

  if (!plan) return seeOther(`${UPGRADE_URL}?error=missing-plan`);

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return unavailable();

  // Presentation only: the name written onto a new Stripe customer. Customer
  // authority comes from the claim below, never from this snapshot.
  const supabase = auth.client;
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("full_name")
    .eq("id", auth.userId)
    .single();

  if (profileError || !profile) return unavailable();

  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return unavailable();
  }

  const stripe = new Stripe(secretKey);
  const userId = auth.userId;

  // ── Claim ──────────────────────────────────────────────────────────────────
  const begun = await claimRpc(admin, "billing_begin_checkout", {
    p_user_id: userId,
    p_ttl_seconds: CLAIM_TTL_SECONDS,
  });

  if (!begun) return unavailable();
  if (begun.outcome === "blocked") return notice("existing-subscription");

  let claim: Claim;
  let claimedCustomerId: string | null;

  if (begun.outcome === "claimed") {
    claim = begun.claim;
    claimedCustomerId = begun.customerId;
  } else if (begun.outcome !== "held") {
    // not_found (or a takeover-only answer): never a claim.
    return unavailable();
  } else {
    // ── Held claim recovery ──────────────────────────────────────────────────
    const held = begun;
    let expectedSessionId: string | null = null;

    if (held.heldSessionId === null) {
      // Another request may be between claiming and attaching right now.
      if (held.ageSeconds < UNATTACHED_CLAIM_STALE_SECONDS) return inProgress();
    } else {
      let status: unknown;
      try {
        status = (await stripe.checkout.sessions.retrieve(held.heldSessionId))?.status;
      } catch {
        return unavailable();
      }

      if (status === "complete") return notice("processing");

      if (status === "open") {
        // Still usable by whoever holds it: leave it alone.
        if (remainingNow(held.claim) > 0) return inProgress();
        if (!(await ensureSessionExpired(stripe, held.heldSessionId))) return unavailable();
      } else if (status !== "expired") {
        return unavailable();
      }
      expectedSessionId = held.heldSessionId;
    }

    const taken = await claimRpc(admin, "billing_takeover_checkout", {
      p_user_id: userId,
      p_old_claim_token: held.claim.token,
      p_expected_session_id: expectedSessionId,
      p_ttl_seconds: CLAIM_TTL_SECONDS,
    });

    if (!taken) return unavailable();
    if (taken.outcome === "blocked") return notice("existing-subscription");
    if (taken.outcome !== "claimed") return inProgress();
    claim = taken.claim;
    claimedCustomerId = taken.customerId;
  }

  // From here this request owns the claim.

  // ── Customer ───────────────────────────────────────────────────────────────
  // The claim's own answer is the customer authority.
  let customerId: string;

  if (claimedCustomerId !== null) {
    customerId = claimedCustomerId;
  } else {
    // Identity here is verified, not parsed out of a cookie: the email and id
    // written onto the Stripe customer are the ones Supabase Auth confirmed.
    let customer: Stripe.Customer;
    try {
      customer = await stripe.customers.create(
        {
          email: auth.email ?? undefined,
          name: profile.full_name ?? undefined,
          metadata: { supabase_user_id: auth.userId },
        },
        { idempotencyKey: `swingproai-customer-v1:${userId}` },
      );
    } catch {
      await release(admin, userId, claim.token);
      return unavailable();
    }

    if (typeof customer?.id !== "string" || customer.id.length === 0) return unavailable();

    // The link is a billing fact, written only for the CURRENT claim token. A
    // link that is not confirmed creates no Session and releases nothing: the
    // claim lapses into the guarded recovery window rather than inviting an
    // uncontrolled retry.
    const linked = await linkCustomer(admin, userId, claim.token, customer.id);
    if (linked === "lost") return inProgress();
    if (linked === "blocked") return notice("existing-subscription");
    if (linked !== "linked" && linked !== "already_linked_same") return unavailable();

    customerId = customer.id;
  }

  // ── Stripe history preflight ───────────────────────────────────────────────
  // Always, once the customer is durable: the user-scoped idempotency key can
  // replay an earlier customer, so a customer that was just created is not
  // assumed to have no history. The full history, every page, or nothing: a
  // partial read decides neither eligibility nor trial.
  let history: Stripe.Subscription[];
  try {
    history = await subscriptionHistory(stripe, customerId);
  } catch {
    await release(admin, userId, claim.token);
    return unavailable();
  }

  const preflight = classifySubscriptionHistory(history);
  if (preflight.hasNonterminal) {
    await release(admin, userId, claim.token);
    return notice("existing-subscription");
  }
  const priorTrial = preflight.priorTrial;

  // One trial per account, and never twice on the same Stripe customer.
  const trialEligible = !claim.trialUsed && !priorTrial;

  // Stripe refuses a Session expiring under 30 minutes out; never ask it to
  // outlive the claim instead.
  if (!(remainingNow(claim) >= MIN_REMAINING_SECONDS_BEFORE_SESSION_CREATE)) {
    await release(admin, userId, claim.token);
    return unavailable();
  }

  // ── Session ────────────────────────────────────────────────────────────────
  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: plan.priceId, quantity: 1 }],
        subscription_data: {
          ...(trialEligible ? { trial_period_days: 7 } : {}),
          // Traceability only. The webhook derives tier from the price paid and
          // never reads this.
          metadata: { tier: plan.tier, supabase_user_id: auth.userId },
        },
        // Correlation only: lets the webhook clear exactly this claim.
        client_reference_id: claim.token,
        expires_at: Math.floor(claim.expiresAt / 1000),
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
      },
      { idempotencyKey: `swingproai-checkout-v1:${claim.token}` },
    );
  } catch {
    // A Session may exist without an answer; the unattached claim is left to
    // the 180-second recovery window rather than released.
    return unavailable();
  }

  const sessionId = checkoutSession?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return unavailable();

  const sessionUrl = checkoutSession.url;
  if (typeof sessionUrl !== "string" || !sessionUrl.startsWith(STRIPE_CHECKOUT_URL_PREFIX)) {
    if (await ensureSessionExpired(stripe, sessionId)) await release(admin, userId, claim.token);
    return unavailable();
  }

  let attached = false;
  try {
    const { data, error } = await admin.rpc("billing_attach_checkout_session", {
      p_user_id: userId,
      p_claim_token: claim.token,
      p_session_id: sessionId,
    });
    attached = !error && data === true;
  } catch {
    attached = false;
  }

  if (!attached) {
    // The claim no longer authorizes this Session: it must never be usable.
    if (await ensureSessionExpired(stripe, sessionId)) {
      await release(admin, userId, claim.token);
      return inProgress();
    }
    return unavailable();
  }

  return seeOther(sessionUrl);
}
