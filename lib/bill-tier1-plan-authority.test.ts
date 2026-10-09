import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// BILL-TIER1 — server-authoritative Stripe price-to-tier binding
// ============================================================================
//
// The plan authority is exercised directly. The checkout route and the webhook
// run for real against deterministic stand-ins for Stripe, the verified-auth
// resolver, the server-only admin client and NextResponse. No network, no
// Stripe API, no database. Every price id and identifier is synthetic, and the
// price environment is restored after the file.

const state = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["STRIPE_PAR_PRICE_ID", "STRIPE_BIRDIE_PRICE_ID", "STRIPE_EAGLE_PRICE_ID"]) {
    saved[key] = process.env[key];
  }
  process.env.STRIPE_SECRET_KEY = "test-stripe-secret-not-real";
  process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret-not-real";
  return {
    savedPriceEnv: saved,
    /** The durable customer the claim answer carries (users.stripe_customer_id). */
    linkedCustomer: null as string | null,
    /** billing_link_checkout_customer's answer. */
    linkOutcome: "linked" as unknown,
    order: [] as string[],
    customersCreated: 0,
    sessions: [] as Record<string, unknown>[],
    adminConstructions: 0,
    writes: [] as { patch: unknown; eq: [string, unknown] }[],
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    event: null as unknown,
    subscription: null as unknown,
  };
});

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200 }),
    redirect: (url: string | URL, init?: { status?: number }) =>
      new Response(null, { status: init?.status ?? 307, headers: { location: String(url) } }),
  },
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveVerifiedAuth: async () => ({
    status: "authenticated",
    userId: "user_TEST_0001",
    email: "golfer@example.test",
    source: "cookie",
    client: {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { stripe_customer_id: state.linkedCustomer, full_name: null }, error: null }),
          }),
        }),
      }),
    },
  }),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions++;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        state.order.push(`rpc:${fn}`);
        if (fn === "billing_link_checkout_customer") return { data: state.linkOutcome, error: null };
        if (fn === "billing_apply_subscription_state") {
          state.writes.push({
            patch: { subscription_status: args.p_subscription_status, subscription_tier: args.p_subscription_tier },
            eq: ["stripe_customer_id", args.p_stripe_customer_id],
          });
          return { data: "applied", error: null };
        }
        if (fn === "billing_begin_checkout") {
          return {
            data: {
              outcome: "claimed",
              claim_token: "3f0c9a2e-7b1d-4c5e-9a8f-1d2e3f4a5b6c",
              claim_acquired_at: new Date().toISOString(),
              claim_expires_at: new Date(Date.now() + 2100 * 1000).toISOString(),
              claim_age_seconds: 0,
              claim_remaining_seconds: 2100,
              held_session_id: null,
              trial_used: false,
              stripe_customer_id: state.linkedCustomer,
            },
            error: null,
          };
        }
        return { data: true, error: null };
      },
      from: () => ({
        update: (patch: unknown) => {
          const write = { patch, eq: ["", null] as [string, unknown] };
          state.writes.push(write);
          const chain = {
            eq: (column: string, value: unknown) => {
              write.eq = [column, value];
              return chain;
            },
            is: () => chain,
            select: async () => ({ data: [{ id: "row-1" }], error: null }),
          };
          return chain;
        },
      }),
    };
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = {
      create: async () => {
        state.customersCreated++;
        state.order.push("stripe:customers.create");
        return { id: "cus_TEST_NEW" };
      },
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          state.sessions.push(params);
          state.order.push("stripe:sessions.create");
          return { id: "cs_TEST_0001", url: "https://checkout.stripe.com/c/pay/cs_TEST_0001" };
        },
      },
    };
    subscriptions = {
      retrieve: async () => state.subscription,
      list: async () => ({ object: "list", data: [], has_more: false }),
    };
    webhooks = { constructEvent: () => state.event };
  },
}));

import { resolveStripePlan, tierForStripePriceId } from "@/lib/billing/stripe-plan-authority";
import { POST as checkoutPOST } from "@/app/api/stripe/checkout/route";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/route";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

const AUTHORITY = "lib/billing/stripe-plan-authority.ts";
const CHECKOUT = "app/api/stripe/checkout/route.ts";
const WEBHOOK = "app/api/webhooks/stripe/route.ts";
const BUTTON = "components/CheckoutButton.tsx";
const UPGRADE = "app/(dashboard)/upgrade/page.tsx";

const PRICE = { par: "price_TEST_PAR", birdie: "price_TEST_BIRDIE", eagle: "price_TEST_EAGLE" } as const;
const ENV = { par: "STRIPE_PAR_PRICE_ID", birdie: "STRIPE_BIRDIE_PRICE_ID", eagle: "STRIPE_EAGLE_PRICE_ID" } as const;

function configure(prices: Partial<Record<keyof typeof ENV, string | undefined>> = PRICE) {
  for (const plan of Object.keys(ENV) as (keyof typeof ENV)[]) {
    const value = prices[plan];
    if (value === undefined) delete process.env[ENV[plan]];
    else process.env[ENV[plan]] = value;
  }
}

beforeEach(() => {
  configure();
  state.linkedCustomer = null;
  state.linkOutcome = "linked";
  state.order = [];
  state.customersCreated = 0;
  state.sessions = [];
  state.adminConstructions = 0;
  state.writes = [];
  state.rpcCalls = [];
  state.event = null;
  state.subscription = null;
});

afterAll(() => {
  for (const [key, value] of Object.entries(state.savedPriceEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ─── Plan authority ───────────────────────────────────────────────────────────

describe("resolveStripePlan — exact positive allow-list", () => {
  it("1-3. par, birdie and eagle resolve to their own tier and configured price", () => {
    expect(resolveStripePlan("par")).toEqual({ plan: "par", tier: "par", priceId: PRICE.par });
    expect(resolveStripePlan("birdie")).toEqual({ plan: "birdie", tier: "birdie", priceId: PRICE.birdie });
    expect(resolveStripePlan("eagle")).toEqual({ plan: "eagle", tier: "eagle", priceId: PRICE.eagle });
  });

  const REJECTED: [string, unknown][] = [
    ["4. coach_starter", "coach_starter"],
    ["5. coach_pro", "coach_pro"],
    ["6. none", "none"],
    ["7. empty", ""],
    ["8. uppercase", "PAR"],
    ["9. whitespace-wrapped", " birdie "],
    ["10. unknown string", "albatross"],
    ["11. null", null],
    ["12. undefined", undefined],
    ["13. number", 1],
    ["14. boolean", true],
    ["15. object", { plan: "par" }],
    ["16. array", ["par"]],
  ];
  for (const [label, selector] of REJECTED) {
    it(`${label} → null`, () => {
      expect(resolveStripePlan(selector)).toBeNull();
    });
  }

  it("17. the selected plan's price missing → null", () => {
    configure({ ...PRICE, birdie: undefined });
    expect(resolveStripePlan("birdie")).toBeNull();
  });

  it("18. the selected plan's price empty → null", () => {
    configure({ ...PRICE, birdie: "" });
    expect(resolveStripePlan("birdie")).toBeNull();
  });

  it("19. the selected plan's price shared with another plan → null for both", () => {
    configure({ ...PRICE, eagle: PRICE.birdie });
    expect(resolveStripePlan("birdie")).toBeNull();
    expect(resolveStripePlan("eagle")).toBeNull();
    expect(resolveStripePlan("par")).toEqual({ plan: "par", tier: "par", priceId: PRICE.par });
  });

  it("20. an unrelated missing price does not break a uniquely configured plan", () => {
    configure({ par: PRICE.par, eagle: PRICE.eagle });
    expect(resolveStripePlan("par")).toEqual({ plan: "par", tier: "par", priceId: PRICE.par });
    expect(resolveStripePlan("eagle")).toEqual({ plan: "eagle", tier: "eagle", priceId: PRICE.eagle });
    expect(resolveStripePlan("birdie")).toBeNull();
  });
});

describe("tierForStripePriceId — webhook authority", () => {
  it("21-23. each configured price maps to exactly its tier", () => {
    expect(tierForStripePriceId(PRICE.par)).toBe("par");
    expect(tierForStripePriceId(PRICE.birdie)).toBe("birdie");
    expect(tierForStripePriceId(PRICE.eagle)).toBe("eagle");
  });

  it("24. an unknown price → null", () => {
    expect(tierForStripePriceId("price_TEST_UNKNOWN")).toBeNull();
    expect(tierForStripePriceId(` ${PRICE.par}`)).toBeNull();
  });

  it("25. an empty price → null", () => {
    expect(tierForStripePriceId("")).toBeNull();
  });

  it("26. a non-string → null", () => {
    for (const input of [null, undefined, 1, true, { id: PRICE.par }, [PRICE.par]]) {
      expect(tierForStripePriceId(input)).toBeNull();
    }
  });

  it("27. a price configured for two plans → null", () => {
    configure({ ...PRICE, eagle: PRICE.birdie });
    expect(tierForStripePriceId(PRICE.birdie)).toBeNull();
    expect(tierForStripePriceId(PRICE.par)).toBe("par");
  });

  it("28. an unrelated missing price does not break a unique recognized price", () => {
    configure({ par: PRICE.par, eagle: PRICE.eagle });
    expect(tierForStripePriceId(PRICE.par)).toBe("par");
    expect(tierForStripePriceId(PRICE.birdie)).toBeNull();
  });
});

describe("plan authority server boundary", () => {
  const src = code(AUTHORITY);

  it("29. imports server-only and touches no Stripe, Supabase, request or log", () => {
    expect(read(AUTHORITY).startsWith('import "server-only";')).toBe(true);
    expect(src).not.toMatch(/from "stripe"|supabase|createAdminClient|fetch\(|console\.|headers\(|cookies\(/);
  });

  it("30. holds exactly the three golfer price keys and no coach mapping", () => {
    expect(src.match(/STRIPE_[A-Z_]+_PRICE_ID/g)?.sort()).toEqual(
      ["STRIPE_BIRDIE_PRICE_ID", "STRIPE_EAGLE_PRICE_ID", "STRIPE_PAR_PRICE_ID"],
    );
    expect(src).not.toMatch(/coach_starter|coach_pro|COACH/);
  });
});

// ─── Checkout ─────────────────────────────────────────────────────────────────

/** A same-origin form POST carrying exactly the given fields. */
async function checkout(fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(fields);
  return checkoutPOST(
    new Request("https://www.swingpro-ai.com/api/stripe/checkout", {
      method: "POST",
      headers: { origin: "https://www.swingpro-ai.com", "content-type": "application/x-www-form-urlencoded" },
      body,
    }) as never,
  );
}

describe("checkout — plan selector only", () => {
  const src = code(CHECKOUT);

  it("31-33. reads plan, never a browser priceId or tier", () => {
    expect(src).toContain('selector = (await req.formData()).get("plan");');
    expect(src).not.toMatch(/\.get\("priceId"\)/);
    expect(src).not.toMatch(/\.get\("tier"\)/);
    expect(src).not.toMatch(/searchParams/);
  });

  const UNRESOLVED: [string, Record<string, string>, () => void][] = [
    ["no plan", {}, () => {}],
    ["a raw price id and forged tier", { priceId: PRICE.par, tier: "eagle" }, () => {}],
    ["coach_pro", { plan: "coach_pro" }, () => {}],
    ["an unconfigured plan", { plan: "birdie" }, () => configure({ ...PRICE, birdie: undefined })],
    ["a duplicated plan price", { plan: "eagle" }, () => configure({ ...PRICE, eagle: PRICE.par })],
  ];
  for (const [label, fields, setup] of UNRESOLVED) {
    it(`34. ${label} is rejected before claim, customer creation, link or session`, async () => {
      setup();
      const response = await checkout(fields);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://www.swingpro-ai.com/upgrade?error=missing-plan");
      expect(state.customersCreated).toBe(0);
      expect(state.adminConstructions).toBe(0);
      expect(state.rpcCalls).toEqual([]);
      expect(state.sessions).toEqual([]);
    });
  }

  it("35-36. a forged tier alongside a plan cannot change the server-resolved price or tier", async () => {
    state.linkedCustomer = "cus_TEST_0001";
    await checkout({ plan: "par", tier: "eagle", priceId: PRICE.eagle });
    expect(state.sessions).toHaveLength(1);
    const session = state.sessions[0] as {
      line_items: unknown;
      subscription_data: { trial_period_days: number; metadata: unknown };
      success_url: string;
      cancel_url: string;
    };
    expect(session.line_items).toEqual([{ price: PRICE.par, quantity: 1 }]);
    expect(session.subscription_data.metadata).toEqual({ tier: "par", supabase_user_id: "user_TEST_0001" });
    expect(session.subscription_data.trial_period_days).toBe(7);
    expect(session.success_url).toBe("https://www.swingpro-ai.com/dashboard?upgraded=true");
    expect(session.cancel_url).toBe("https://www.swingpro-ai.com/upgrade");
  });

  it("PRICING-1. the claim's durable customer is reused: no customer create and no link", async () => {
    state.linkedCustomer = "cus_TEST_0001";
    await checkout({ plan: "eagle" });
    expect(state.customersCreated).toBe(0);
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("billing_link_checkout_customer");
    expect(state.sessions[0].customer).toBe("cus_TEST_0001");
    expect(state.sessions[0].line_items).toEqual([{ price: PRICE.eagle, quantity: 1 }]);
  });

  it("PRICING-1. a claim with no customer creates one, links it with the claim token, then opens the Session", async () => {
    await checkout({ plan: "birdie" });
    expect(state.customersCreated).toBe(1);
    const link = state.rpcCalls.find((c) => c.fn === "billing_link_checkout_customer");
    expect(link?.args).toEqual({
      p_user_id: "user_TEST_0001",
      p_claim_token: "3f0c9a2e-7b1d-4c5e-9a8f-1d2e3f4a5b6c",
      p_stripe_customer_id: "cus_TEST_NEW",
    });
    expect(state.order.indexOf("rpc:billing_link_checkout_customer")).toBeGreaterThan(state.order.indexOf("stripe:customers.create"));
    expect(state.order.indexOf("stripe:sessions.create")).toBeGreaterThan(state.order.indexOf("rpc:billing_link_checkout_customer"));
    expect(state.sessions[0].customer).toBe("cus_TEST_NEW");
    expect(state.sessions[0].line_items).toEqual([{ price: PRICE.birdie, quantity: 1 }]);
    // No direct public.users write remains in checkout.
    expect(state.writes).toEqual([]);
  });

  it("PRICING-1. an unconfirmed customer link opens no Session", async () => {
    for (const outcome of ["lost", "blocked", "customer_conflict", "not_found", "weird", null]) {
      state.sessions = [];
      state.linkOutcome = outcome;
      const response = await checkout({ plan: "par" });
      expect(response.status, String(outcome)).toBe(303);
      expect(response.headers.get("location"), String(outcome)).toMatch(/^https:\/\/www\.swingpro-ai\.com\/upgrade\?checkout=/);
      expect(state.sessions, String(outcome)).toEqual([]);
    }
  });

  it("37-38. keeps the conditional 7-day trial and the fixed success/cancel destinations", () => {
    expect(src).toContain("...(trialEligible ? { trial_period_days: 7 } : {})");
    expect(src).toContain('const SUCCESS_URL = `${CANONICAL_ORIGIN}/dashboard?upgraded=true`;');
    expect(src).toContain('const CANCEL_URL = `${CANONICAL_ORIGIN}/upgrade`;');
    expect(src).toContain("success_url: SUCCESS_URL,");
    expect(src).toContain("cancel_url: CANCEL_URL,");
    expect(src).not.toContain("SITE_URL}");
    expect(src).toContain("line_items: [{ price: plan.priceId, quantity: 1 }]");
    expect(src).toContain("metadata: { tier: plan.tier, supabase_user_id: auth.userId }");
  });
});

// ─── Client / UI ──────────────────────────────────────────────────────────────

describe("CheckoutButton and upgrade page", () => {
  const button = code(BUTTON);
  const upgrade = code(UPGRADE);

  it("39-41. CheckoutButton takes a plan, not a priceId or tier", () => {
    expect(button).toMatch(/plan: CheckoutPlan;/);
    expect(button).toContain('type CheckoutPlan = "par" | "birdie" | "eagle";');
    expect(button).not.toMatch(/priceId/);
    expect(button).not.toMatch(/\btier\b/);
    expect(button).not.toContain("stripe-plan-authority");
  });

  it("42-44. the form carries plan only, by POST", () => {
    expect(button).toContain('<form method="POST" action="/api/stripe/checkout"');
    expect(button).toContain('<input type="hidden" name="plan" value={plan} />');
    expect(button.match(/<input /g)).toHaveLength(1);
    expect(button).not.toContain("href=");
    expect(button).not.toContain("?plan=");
    expect(button).not.toContain("priceId=");
    expect(button).not.toContain("tier=");
  });

  it("45. the upgrade page no longer reads any Stripe price configuration", () => {
    expect(upgrade).not.toMatch(/STRIPE_|priceEnvKey|process\.env|priceId/);
  });

  it("46. the upgrade page offers exactly Par, Birdie and Eagle", () => {
    expect(upgrade.match(/id: "[a-z_]+" as const/g)).toEqual([
      'id: "par" as const',
      'id: "birdie" as const',
      'id: "eagle" as const',
    ]);
    expect(upgrade).not.toMatch(/coach_starter|coach_pro/);
  });

  it("47. the upgrade page passes the plan selector only", () => {
    expect(upgrade).toContain("plan={plan.id}");
    expect(upgrade).not.toMatch(/tier=\{/);
  });

  it("PRICING-1. each plan displays its own launch price (presentation only)", () => {
    const pairs = Array.from(upgrade.matchAll(/id: "([a-z_]+)" as const,[\s\S]*?price: "([^"]+)"/g), (m) => [m[1], m[2]]);
    expect(pairs).toEqual([
      ["par", "$7.99"],
      ["birdie", "$14.99"],
      ["eagle", "$24.99"],
    ]);
    expect(upgrade).not.toContain("$9.99");
    expect(upgrade).not.toContain("$49.99");
    expect(upgrade.match(/\$24\.99/g)).toHaveLength(1);
  });
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

const CUSTOMER = "cus_TEST_0001";
const SUB = "sub_TEST_0001";

function currentSubscription(status: string, priceIds: unknown[], metadata: Record<string, string> = {}) {
  return {
    id: SUB,
    status,
    customer: CUSTOMER,
    metadata,
    items: { object: "list", data: priceIds.map((id) => ({ price: { id } })) },
  };
}

async function deliver(type: string, object: Record<string, unknown>) {
  state.event = { id: "evt_TEST", type, data: { object } };
  const request = new Request("https://www.swingpro-ai.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body: "{}",
  });
  return webhookPOST(request as never);
}

describe("webhook — tier is the price actually paid", () => {
  const src = code(WEBHOOK);

  it("48-49. never reads metadata; reads the subscription's items", () => {
    expect(src).not.toMatch(/metadata/);
    expect(src).toContain("subscription.items?.data");
    expect(src).toContain("tierForStripePriceId(");
  });

  it("50. exactly one recognized item maps its tier", async () => {
    state.subscription = currentSubscription("active", [PRICE.eagle]);
    expect((await deliver("customer.subscription.updated", { id: SUB })).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "eagle" });
  });

  const FAIL_CLOSED: [string, unknown[], () => void][] = [
    ["51. unknown price", ["price_TEST_UNKNOWN"], () => {}],
    ["52. zero items", [], () => {}],
    ["53. multiple items", [PRICE.par, PRICE.eagle], () => {}],
    ["54. duplicate price configuration", [PRICE.birdie], () => configure({ ...PRICE, eagle: PRICE.birdie })],
  ];
  for (const [label, prices, setup] of FAIL_CLOSED) {
    it(`${label} → tier none, status still normalized`, async () => {
      setup();
      state.subscription = currentSubscription("trialing", prices, { tier: "coach_pro" });
      expect((await deliver("customer.subscription.updated", { id: SUB })).status).toBe(200);
      expect(state.writes[0].patch).toEqual({ subscription_status: "trialing", subscription_tier: "none" });
    });
  }

  it("55. checkout completed with a subscription persists the mapped tier", async () => {
    state.subscription = currentSubscription("trialing", [PRICE.par], { tier: "eagle" });
    await deliver("checkout.session.completed", { subscription: SUB, customer: CUSTOMER });
    expect(state.writes[0].patch).toEqual({ subscription_status: "trialing", subscription_tier: "par" });
    expect(state.writes[0].eq).toEqual(["stripe_customer_id", CUSTOMER]);
  });

  it("56. checkout completed without a subscription writes no billing state (PRICING-1)", async () => {
    await deliver("checkout.session.completed", { subscription: null, customer: CUSTOMER });
    expect(state.writes).toEqual([]);
  });

  it("57-58. updated persists the current mapped tier; a stale premium tier cannot survive", async () => {
    state.subscription = currentSubscription("active", [PRICE.birdie], { tier: "eagle" });
    await deliver("customer.subscription.updated", { id: SUB, items: { data: [{ price: { id: PRICE.eagle } }] } });
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "birdie" });

    state.writes = [];
    state.subscription = currentSubscription("active", ["price_TEST_RETIRED"], { tier: "eagle" });
    await deliver("customer.subscription.updated", { id: SUB });
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "none" });
  });

  it("59. invoice.payment_failed with a subscription persists status and actual-price tier", async () => {
    state.subscription = currentSubscription("past_due", [PRICE.eagle], { tier: "coach_pro" });
    await deliver("invoice.payment_failed", { subscription: SUB, customer: CUSTOMER });
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "eagle" });
  });

  it("60. deleted clears tier to none", async () => {
    state.subscription = currentSubscription("canceled", [PRICE.eagle], { tier: "eagle" });
    await deliver("customer.subscription.deleted", { id: SUB });
    expect(state.writes[0].patch).toEqual({ subscription_status: "canceled", subscription_tier: "none" });
  });

  it("a missing unrelated price does not downgrade a uniquely matching Par subscriber", async () => {
    configure({ par: PRICE.par, eagle: PRICE.eagle });
    state.subscription = currentSubscription("active", [PRICE.par]);
    await deliver("customer.subscription.updated", { id: SUB });
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "par" });
  });
});
