import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// BILL-STATUS1 — Stripe status normalization and fail-closed webhook writes
// ============================================================================
//
// The normalizer is exercised directly. The webhook handler is executed for
// real against deterministic stand-ins: Stripe (signature check and current
// subscription retrieval), the server-only admin client, and NextResponse. No
// network call, no Stripe API, no database. Identifiers are synthetic.
//
// BILL-TIER1: tier is the current subscription's actual price mapped through
// the server plan authority; the synthetic plan prices below stand in for the
// server configuration and are restored after the file.

const PRICE_ENV_KEYS = ["STRIPE_PAR_PRICE_ID", "STRIPE_BIRDIE_PRICE_ID", "STRIPE_EAGLE_PRICE_ID"] as const;

const state = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["STRIPE_PAR_PRICE_ID", "STRIPE_BIRDIE_PRICE_ID", "STRIPE_EAGLE_PRICE_ID"]) {
    saved[key] = process.env[key];
  }
  process.env.STRIPE_SECRET_KEY = "test-stripe-secret-not-real";
  process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret-not-real";
  process.env.STRIPE_PAR_PRICE_ID = "price_TEST_PAR";
  process.env.STRIPE_BIRDIE_PRICE_ID = "price_TEST_BIRDIE";
  process.env.STRIPE_EAGLE_PRICE_ID = "price_TEST_EAGLE";
  return {
    savedPriceEnv: saved,
    event: null as unknown,
    badSignature: false,
    constructArgs: [] as unknown[][],
    subscriptions: new Map<string, unknown>(),
    retrieveCalls: [] as string[],
    retrieveThrows: false,
    adminConstructions: 0,
    adminThrows: false,
    /** Every billing_apply_subscription_state call, viewed as the write it asks for. */
    writes: [] as { table: string; patch: unknown; eq: [string, unknown] | null; select: string | null }[],
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    /** Default writer answer; rpcQueue answers take precedence, in order. */
    writeResult: { data: "applied", error: null } as { data: unknown; error: unknown },
    rpcQueue: [] as { data: unknown; error: unknown }[],
    writeThrows: false,
    /** subscriptions.list pages, served in order. */
    listPages: [] as unknown[],
    listCalls: [] as Record<string, unknown>[],
    listThrows: false,
    /** public.users id lookups by customer (checkout without subscription). */
    lookups: [] as { column: string; value: unknown }[],
    lookupResult: { data: [{ id: "user_TEST_0001" }], error: null } as { data: unknown; error: unknown },
  };
});

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = {
      constructEvent: (...args: unknown[]) => {
        state.constructArgs.push(args);
        if (state.badSignature) throw new Error("No signatures found matching the expected signature");
        return state.event;
      },
    };
    subscriptions = {
      retrieve: async (id: string) => {
        state.retrieveCalls.push(id);
        if (state.retrieveThrows) throw new Error("provider-secret-detail sub_LEAK");
        if (!state.subscriptions.has(id)) throw new Error("No such subscription");
        return state.subscriptions.get(id);
      },
      list: async (params: Record<string, unknown>) => {
        state.listCalls.push(params);
        if (state.listThrows) throw new Error("provider-secret-detail list");
        return state.listPages.shift() ?? { object: "list", data: [], has_more: false };
      },
    };
  },
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions++;
    if (state.adminThrows) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        if (fn === "billing_apply_subscription_state") {
          state.writes.push({
            table: "users",
            patch: { subscription_status: args.p_subscription_status, subscription_tier: args.p_subscription_tier },
            eq: ["stripe_customer_id", args.p_stripe_customer_id],
            select: null,
          });
        }
        if (state.writeThrows) throw new Error("db-secret-detail connection reset");
        return state.rpcQueue.shift() ?? state.writeResult;
      },
      from: () => ({
        select: () => ({
          eq: async (column: string, value: unknown) => {
            state.lookups.push({ column, value });
            return state.lookupResult;
          },
        }),
      }),
    };
  },
}));

import { normalizeStripeSubscriptionStatus } from "@/lib/billing/stripe-subscription-status";
import { POST } from "@/app/api/webhooks/stripe/route";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
const WEBHOOK = "app/api/webhooks/stripe/route.ts";

const CUSTOMER = "cus_TEST_0001";
const SUB = "sub_TEST_0001";
const RAW_BODY = '{"id":"evt_TEST","object":"event"}';

const PRICE = { par: "price_TEST_PAR", birdie: "price_TEST_BIRDIE", eagle: "price_TEST_EAGLE" } as const;

/** Subscription items carrying the given price ids, as Stripe returns them. */
function items(...priceIds: unknown[]) {
  return { object: "list", data: priceIds.map((id, i) => ({ id: `si_TEST_${i}`, price: { id } })) };
}

/** A current subscription paying the Birdie price, with metadata that must be ignored. */
function subscription(status: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    object: "subscription",
    status,
    customer: CUSTOMER,
    items: items(PRICE.birdie),
    metadata: { tier: "birdie" },
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>) {
  return { id: "evt_TEST", type, data: { object } };
}

async function deliver(body = RAW_BODY): Promise<Response> {
  const request = new Request("https://www.swingpro-ai.com/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body,
  });
  return POST(request as never);
}

let logged: string[] = [];

beforeEach(() => {
  state.event = null;
  state.badSignature = false;
  state.constructArgs = [];
  state.subscriptions = new Map();
  state.retrieveCalls = [];
  state.retrieveThrows = false;
  state.adminConstructions = 0;
  state.adminThrows = false;
  state.writes = [];
  state.rpcCalls = [];
  state.writeResult = { data: "applied", error: null };
  state.rpcQueue = [];
  state.writeThrows = false;
  state.listPages = [];
  state.listCalls = [];
  state.listThrows = false;
  state.lookups = [];
  state.lookupResult = { data: [{ id: "user_TEST_0001" }], error: null };
  logged = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.STRIPE_PAR_PRICE_ID = PRICE.par;
  process.env.STRIPE_BIRDIE_PRICE_ID = PRICE.birdie;
  process.env.STRIPE_EAGLE_PRICE_ID = PRICE.eagle;
});

afterAll(() => {
  for (const key of PRICE_ENV_KEYS) {
    const value = state.savedPriceEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function expectFailure(response: Response) {
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: "Webhook processing failed" });
  for (const leak of [CUSTOMER, SUB, "secret-detail", "row-1", "provider", "db-"]) expect(text).not.toContain(leak);
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

describe("normalizeStripeSubscriptionStatus — frozen mapping", () => {
  const MAPPING: [unknown, string][] = [
    ["active", "active"], // 1
    ["trialing", "trialing"], // 2
    ["past_due", "past_due"], // 3
    ["incomplete", "past_due"], // 4
    ["paused", "past_due"], // 5
    ["unpaid", "past_due"], // 6
    ["canceled", "canceled"], // 7
    ["incomplete_expired", "canceled"], // 8
    ["suspended_future_state", "none"], // 9
    ["", "none"], // 10
    ["ACTIVE", "none"], // 11
    [" active ", "none"], // 12
    [null, "none"], // 13
    [undefined, "none"], // 14
    [1, "none"], // 15
    [true, "none"], // 16
    [{ status: "active" }, "none"], // 17
    [["active"], "none"], // 18
  ];
  for (const [input, expected] of MAPPING) {
    it(`${JSON.stringify(input) ?? "undefined"} → ${expected}`, () => {
      expect(normalizeStripeSubscriptionStatus(input)).toBe(expected);
    });
  }

  it("only active and trialing come out as entitling states", () => {
    for (const input of ["past_due", "incomplete", "paused", "unpaid", "canceled", "incomplete_expired", "x", null]) {
      expect(["active", "trialing"]).not.toContain(normalizeStripeSubscriptionStatus(input));
    }
  });

  it("is pure: no environment, Stripe or Supabase access", () => {
    const src = code("lib/billing/stripe-subscription-status.ts");
    expect(src).not.toMatch(/process\.env|from "stripe"|supabase|createAdminClient|fetch\(/);
    expect(src).toContain('import type { SubscriptionStatus } from "@/types/database";');
  });
});

// ─── Signature boundary ───────────────────────────────────────────────────────

describe("signature boundary", () => {
  it("19. verifies the signature against the raw request body", async () => {
    state.event = event("customer.created", {});
    await deliver(RAW_BODY);
    expect(state.constructArgs).toHaveLength(1);
    expect(state.constructArgs[0][0]).toBe(RAW_BODY);
    expect(state.constructArgs[0][1]).toBe("t=1,v1=test");
    const src = code(WEBHOOK);
    expect(src.indexOf("await req.text()")).toBeGreaterThan(-1);
    expect(src.indexOf("await req.text()")).toBeLessThan(src.indexOf("constructEvent("));
    expect(src).not.toContain("req.json(");
  });

  it("20. an invalid signature answers 400 and writes nothing", async () => {
    state.badSignature = true;
    const response = await deliver();
    expect(response.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });
});

// ─── Events ───────────────────────────────────────────────────────────────────

describe("checkout.session.completed", () => {
  it("21-22. retrieves the current subscription and persists trialing, never a literal active", async () => {
    state.subscriptions.set(SUB, subscription("trialing"));
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER });
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes).toEqual([
      {
        table: "users",
        patch: { subscription_status: "trialing", subscription_tier: "birdie" },
        eq: ["stripe_customer_id", CUSTOMER],
        select: null,
      },
    ]);
    // One atomic writer call carrying the bound subscription identity.
    expect(state.rpcCalls).toEqual([
      {
        fn: "billing_apply_subscription_state",
        args: {
          p_stripe_customer_id: CUSTOMER,
          p_claim_token: null,
          p_subscription_id: SUB,
          p_subscription_status: "trialing",
          p_subscription_tier: "birdie",
          p_trial_received: false,
          p_allow_unbound_terminal: false,
        },
      },
    ]);
  });

  it("accepts an expanded subscription object; missing metadata no longer defaults a tier", async () => {
    state.subscriptions.set(SUB, subscription("active", { metadata: {}, items: items(PRICE.par) }));
    state.event = event("checkout.session.completed", { subscription: { id: SUB }, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "par" });
  });

  it("metadata tier=eagle on an actual Par price persists par", async () => {
    state.subscriptions.set(SUB, subscription("trialing", { metadata: { tier: "eagle" }, items: items(PRICE.par) }));
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "trialing", subscription_tier: "par" });
  });

  it("metadata tier=coach_pro on an unknown price persists none", async () => {
    state.subscriptions.set(SUB, subscription("active", { metadata: { tier: "coach_pro" }, items: items("price_TEST_UNKNOWN") }));
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "none" });
  });

  it("23. with no subscription writes no billing state at all (PRICING-1: never none/none)", async () => {
    state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it("with no subscription and no customer answers 500 and writes nothing", async () => {
    state.event = event("checkout.session.completed", { subscription: null, customer: null });
    await expectFailure(await deliver());
    expect(state.writes).toEqual([]);
  });
});

describe("customer.subscription.updated", () => {
  it("24-25. a stale payload saying active loses to the current unpaid subscription → past_due", async () => {
    state.subscriptions.set(SUB, subscription("unpaid"));
    state.event = event("customer.subscription.updated", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "birdie" });
  });

  it("26. a current unknown status persists none", async () => {
    state.subscriptions.set(SUB, subscription("some_future_state"));
    state.event = event("customer.subscription.updated", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "none", subscription_tier: "birdie" });
  });

  it("follows the current price, not stale payload items or metadata", async () => {
    state.subscriptions.set(SUB, subscription("active", { items: items(PRICE.eagle), metadata: {} }));
    state.event = event("customer.subscription.updated", subscription("active", { items: items(PRICE.par) }));
    await deliver();
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "eagle" });
  });

  it("writes tier every time: a stale premium tier cannot survive an unknown current price", async () => {
    state.subscriptions.set(SUB, subscription("active", { metadata: { tier: "eagle" }, items: items("price_TEST_UNKNOWN") }));
    state.event = event("customer.subscription.updated", subscription("active", { metadata: { tier: "eagle" } }));
    await deliver();
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "none" });
  });

  const FAIL_CLOSED_ITEMS: [string, unknown][] = [
    ["zero items", items()],
    ["multiple items", items(PRICE.birdie, PRICE.eagle)],
    ["an item without a price", { object: "list", data: [{ id: "si_TEST_0" }] }],
    ["a missing items list", undefined],
  ];
  for (const [label, currentItems] of FAIL_CLOSED_ITEMS) {
    it(`${label} → tier none`, async () => {
      state.subscriptions.set(SUB, subscription("active", { items: currentItems }));
      state.event = event("customer.subscription.updated", subscription("active"));
      expect((await deliver()).status).toBe(200);
      expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "none" });
    });
  }

  it("a price configured for two plans → tier none", async () => {
    process.env.STRIPE_EAGLE_PRICE_ID = PRICE.birdie;
    state.subscriptions.set(SUB, subscription("active"));
    state.event = event("customer.subscription.updated", subscription("active"));
    await deliver();
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "none" });
  });

  it("derives the customer from the current subscription, not the payload", async () => {
    state.subscriptions.set(SUB, subscription("active", { customer: { id: CUSTOMER } }));
    state.event = event("customer.subscription.updated", subscription("active", { customer: "cus_STALE_9999" }));
    await deliver();
    expect(state.writes[0].eq).toEqual(["stripe_customer_id", CUSTOMER]);
  });
});

// ─── PRICING-1: portal cancellation at period end ─────────────────────────────
// A portal cancellation only schedules the end. Access stays until Stripe
// actually ends the subscription and sends customer.subscription.deleted.

describe("customer.subscription.updated — cancellation scheduled at period end", () => {
  it("active with cancel_at_period_end keeps status active and the paid tier", async () => {
    const scheduled = subscription("active", { cancel_at_period_end: true, cancel_at: 1893456000 });
    state.subscriptions.set(SUB, scheduled);
    state.event = event("customer.subscription.updated", scheduled);
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "birdie" });
  });

  it("trialing with cancel_at_period_end keeps status trialing and the paid tier", async () => {
    const scheduled = subscription("trialing", { cancel_at_period_end: true, cancel_at: 1893456000 });
    state.subscriptions.set(SUB, scheduled);
    state.event = event("customer.subscription.updated", scheduled);
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "trialing", subscription_tier: "birdie" });
  });
});

describe("customer.subscription.deleted", () => {
  it("27. resolves the current subscription and persists its status with tier none", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.event = event("customer.subscription.deleted", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes[0].patch).toEqual({ subscription_status: "canceled", subscription_tier: "none" });
  });
});

describe("invoice.payment_failed", () => {
  it("28. with a subscription persists the current normalized status and actual-price tier", async () => {
    state.subscriptions.set(SUB, subscription("past_due"));
    state.event = event("invoice.payment_failed", { subscription: SUB, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "birdie" });
  });

  it("follows the current subscription, not the event name", async () => {
    state.subscriptions.set(SUB, subscription("active", { items: items(PRICE.eagle) }));
    state.event = event("invoice.payment_failed", { subscription: SUB, customer: CUSTOMER });
    await deliver();
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "eagle" });
  });

  it("29. without a subscription performs no entitlement write and acknowledges", async () => {
    state.event = event("invoice.payment_failed", { subscription: null, customer: CUSTOMER });
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });
});

// ─── invoice.payment_failed: current (2026-04-22.dahlia) snapshot shape ───────
// Current API versions name the subscription at
// parent.subscription_details.subscription instead of a top-level field.

describe("invoice.payment_failed — version-tolerant subscription reference", () => {
  const dahlia = (subscriptionRef: unknown, extra: Record<string, unknown> = {}) => ({
    customer: CUSTOMER,
    parent: { type: "subscription_details", quote_details: null, subscription_details: { subscription: subscriptionRef, ...extra } },
  });

  async function expectNoWrite() {
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  }

  it("DAHLIA-1. a parent string id is retrieved and its current status and actual-price tier persisted", async () => {
    state.subscriptions.set(SUB, subscription("past_due"));
    state.event = event("invoice.payment_failed", dahlia(SUB));
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "birdie" });
    expect(state.writes[0].eq).toEqual(["stripe_customer_id", CUSTOMER]);
  });

  it("DAHLIA-2. an expanded parent subscription reference resolves by its id", async () => {
    state.subscriptions.set(SUB, subscription("unpaid"));
    state.event = event("invoice.payment_failed", dahlia({ id: SUB, object: "subscription" }));
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "birdie" });
  });

  it("DAHLIA-3. a null parent with no top-level subscription writes nothing and acknowledges", async () => {
    state.event = event("invoice.payment_failed", { customer: CUSTOMER, parent: null });
    await expectNoWrite();
  });

  it("DAHLIA-4. a quote parent never yields a subscription", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    state.event = event("invoice.payment_failed", {
      customer: CUSTOMER,
      parent: { type: "quote_details", quote_details: { quote: "qt_TEST_0001" }, subscription_details: { subscription: SUB } },
    });
    await expectNoWrite();
  });

  it("DAHLIA-5. malformed current shapes fail closed with no write", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    const MALFORMED: unknown[] = [
      { type: "subscription_details", subscription_details: null },
      { type: "subscription_details", subscription_details: "sub_TEST_0001" },
      { type: "subscription_details", subscription_details: { subscription: "" } },
      { type: "subscription_details", subscription_details: { subscription: 42 } },
      { type: "subscription_details", subscription_details: { subscription: { id: "" } } },
      { type: "subscription_details", subscription_details: { subscription: null } },
      { subscription_details: { subscription: SUB } },
      "subscription_details",
    ];
    for (const parent of MALFORMED) {
      state.retrieveCalls = [];
      state.writes = [];
      state.adminConstructions = 0;
      state.event = event("invoice.payment_failed", { customer: CUSTOMER, parent });
      await expectNoWrite();
    }
  });

  it("DAHLIA-6. a top-level id that contradicts the parent id fails with no retrieval or write", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    state.subscriptions.set("sub_TEST_0002", subscription("active", { id: "sub_TEST_0002" }));
    state.event = event("invoice.payment_failed", { ...dahlia(SUB), subscription: "sub_TEST_0002" });
    await expectFailure(await deliver());
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });

  it("DAHLIA-7. matching top-level and parent ids retrieve once and write once", async () => {
    state.subscriptions.set(SUB, subscription("past_due", { items: items(PRICE.eagle) }));
    state.event = event("invoice.payment_failed", { ...dahlia(SUB), subscription: SUB });
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "eagle" });
  });

  it("LEGACY-MALFORMED. a present top-level subscription with no usable id still fails with no retrieval or write", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    state.event = event("invoice.payment_failed", { customer: CUSTOMER, subscription: { object: "subscription" } });
    await expectFailure(await deliver());
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });

  it("DAHLIA-8. a higher-plan hint in the parent cannot outrank the actual Par price", async () => {
    state.subscriptions.set(SUB, subscription("active", { items: items(PRICE.par), metadata: { tier: "eagle" } }));
    state.event = event("invoice.payment_failed", dahlia(SUB, { metadata: { tier: "eagle" } }));
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "active", subscription_tier: "par" });
  });
});

describe("unhandled events", () => {
  it("36. perform no entitlement write and no Stripe call", async () => {
    state.event = event("customer.created", { id: CUSTOMER });
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(state.writes).toEqual([]);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });
});

// ─── Persistence proof and failure acknowledgement ───────────────────────────

describe("trusted write proof and generic failure", () => {
  const HANDLED: [string, () => void][] = [
    ["checkout", () => (state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER }))],
    ["checkout without subscription", () => (state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER }))],
    ["updated", () => (state.event = event("customer.subscription.updated", subscription("active")))],
    ["deleted", () => (state.event = event("customer.subscription.deleted", subscription("canceled")))],
    ["payment_failed", () => (state.event = event("invoice.payment_failed", { subscription: SUB, customer: CUSTOMER }))],
  ];
  beforeEach(() => state.subscriptions.set(SUB, subscription("active")));

  // A completed Session without a subscription writes no billing state.
  const WRITING = HANDLED.filter(([n]) => n !== "checkout without subscription");

  it("30, 37. every handled write is one atomic writer call bound to the customer, acknowledged 2xx", async () => {
    for (const [name, setup] of WRITING) {
      state.writes = [];
      state.rpcCalls = [];
      setup();
      const response = await deliver();
      expect(response.status, name).toBe(200);
      expect(state.writes, name).toHaveLength(1);
      expect(state.rpcCalls.map((c) => c.fn), name).toEqual(["billing_apply_subscription_state"]);
      expect(state.writes[0].eq, name).toEqual(["stripe_customer_id", CUSTOMER]);
    }
  });

  const FAILURES: [string, () => void][] = [
    ["31. Supabase error", () => (state.writeResult = { data: null, error: { message: "db-secret-detail" } })],
    ["32. Supabase throw", () => (state.writeThrows = true)],
    ["33. no profile for the customer", () => (state.writeResult = { data: "not_found", error: null })],
    ["34. subscription identity conflict", () => (state.writeResult = { data: "conflict", error: null })],
    ["34. unknown writer outcome", () => (state.writeResult = { data: "row-1", error: null })],
    ["34. malformed result", () => (state.writeResult = { data: { id: "row-1" }, error: null })],
    ["admin client construction", () => (state.adminThrows = true)],
  ];
  for (const [label, breakIt] of FAILURES) {
    it(`${label} → generic 500 on every writing event, never received:true`, async () => {
      breakIt();
      for (const [name, setup] of WRITING) {
        setup();
        const response = await deliver();
        expect(response.status, name).toBe(500);
        await expectFailure(response);
      }
    });
  }

  it("35. a Stripe retrieval failure answers generic 500 and writes nothing", async () => {
    state.retrieveThrows = true;
    for (const [name, setup] of HANDLED.filter(([n]) => n !== "checkout without subscription")) {
      state.writes = [];
      setup();
      await expectFailure(await deliver());
      expect(state.writes, name).toEqual([]);
    }
  });

  it("an unretrievable or identity-less subscription answers generic 500", async () => {
    state.subscriptions.set(SUB, subscription("active", { customer: null }));
    state.event = event("customer.subscription.updated", subscription("active"));
    await expectFailure(await deliver());
    state.event = event("customer.subscription.updated", { id: "", status: "active" });
    await expectFailure(await deliver());
    expect(state.writes).toEqual([]);
  });

  it("38-40. nothing identifying or provider/database detail is logged or returned", async () => {
    state.retrieveThrows = true;
    state.event = event("customer.subscription.updated", subscription("active"));
    const failedText = await (await deliver()).text();
    state.retrieveThrows = false;
    state.writeResult = { data: null, error: { message: "db-secret-detail", details: CUSTOMER } };
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER });
    const writeFailedText = await (await deliver()).text();
    state.writeResult = { data: "applied", error: null };
    await deliver();
    for (const text of [failedText, writeFailedText, ...logged]) {
      for (const leak of [CUSTOMER, SUB, "secret-detail", "row-1"]) expect(text).not.toContain(leak);
    }
    const src = code(WEBHOOK);
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*(customer|subscription|sub\b|error|\$\{)/i);
  });
});

// ─── Source contract ──────────────────────────────────────────────────────────

describe("webhook source contract", () => {
  const src = code(WEBHOOK);

  it("41. never writes a raw Stripe status", () => {
    expect(src).not.toMatch(/subscription_status:\s*(sub|subscription|event[\w.]*)\.status/);
    expect(src).not.toMatch(/subscription_status:\s*"active"/);
    // Value writes only; the SubscriptionState type annotation is not a write.
    const writes = (src.match(/subscription_status:\s*[^,}\n]+/g) ?? []).filter(
      (w) => !/subscription_status:\s*SubscriptionStatus;/.test(w),
    );
    // The derivation, and its pass-through to the atomic writer.
    expect(writes).toEqual(["subscription_status: status", "subscription_status: state.subscription_status"]);
    expect(src).toContain("const status = normalizeStripeSubscriptionStatus(subscription.status);");
    expect(src).toContain("p_subscription_status: state.subscription_status,");
  });

  it("42. maps every known non-entitling status away from active/trialing", () => {
    for (const status of ["past_due", "incomplete", "paused", "unpaid", "canceled", "incomplete_expired"]) {
      expect(normalizeStripeSubscriptionStatus(status)).not.toMatch(/^(active|trialing)$/);
    }
  });

  it("keeps the trusted writer, the customer binding and a proved outcome", () => {
    expect(src).toContain('import { createAdminClient } from "@/utils/supabase/admin";');
    expect(src).toContain('rpc("billing_apply_subscription_state", {');
    expect(src).toContain("p_stripe_customer_id: customerId,");
    expect(src).toContain("!APPLY_OUTCOMES.includes(result.data)");
    // The one remaining public.users access is a read used to release a claim.
    expect((src.match(/\.from\("users"\)/g) ?? []).length).toBe(1);
    expect(src).toContain('.from("users").select("id").eq("stripe_customer_id", customerId)');
    expect(src).not.toMatch(/\.(update|insert|upsert)\(/);
  });

  it("acknowledges received:true exactly once, after the failure catch", () => {
    expect((src.match(/received: true/g) ?? []).length).toBe(1);
    expect(src.lastIndexOf("return failed();")).toBeLessThan(src.indexOf("received: true"));
  });

  it("derives tier from the actual price through the plan authority, never from metadata", () => {
    expect(src).not.toMatch(/metadata/);
    expect(src).toContain('import { tierForStripePriceId } from "@/lib/billing/stripe-plan-authority";');
    expect(src).toContain("subscription.items?.data");
    expect(src).toContain("items.length !== 1");
    expect(src).not.toMatch(/prices\.retrieve|products\.retrieve/);
    // Every tier written is either derived from the price or the literal none.
    const tiers = (src.match(/subscription_tier:\s*[^,}\n]+/g) ?? []).filter(
      (w) => !/subscription_tier:\s*SubscriptionTier;/.test(w),
    );
    expect(tiers).toEqual([
      'subscription_tier: status === "canceled" ? "none" : tierOf(subscription)',
      "subscription_tier: state.subscription_tier",
    ]);
  });

  it("only the webhook consumes the normalizer", () => {
    const consumers = ["app/api/webhooks/stripe/route.ts"];
    for (const f of consumers) expect(read(f)).toContain("@/lib/billing/stripe-subscription-status");
  });
});

// ─── PRICING-1: subscription identity, claim tokens and unbound terminals ─────
// The atomic writer's own semantics are proved against its SQL source in
// lib/pricing1-billing-guard-schema.test.ts; here the route's handling of each
// writer outcome is executed.

describe("PRICING-1 — webhook subscription identity", () => {
  const TOKEN = "3f0c9a2e-7b1d-4c5e-9a8f-1d2e3f4a5b6c";
  const LIVE = "sub_TEST_LIVE";

  const applyCalls = () => state.rpcCalls.filter((c) => c.fn === "billing_apply_subscription_state");
  const page = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });

  it("ID-1. a completed Checkout binds its subscription and carries its claim token", async () => {
    state.subscriptions.set(SUB, subscription("trialing", { trial_start: 1700000000 }));
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER, client_reference_id: TOKEN });
    expect((await deliver()).status).toBe(200);
    expect(applyCalls()).toHaveLength(1);
    expect(applyCalls()[0].args).toMatchObject({
      p_subscription_id: SUB,
      p_claim_token: TOKEN,
      p_trial_received: true,
      p_allow_unbound_terminal: false,
    });
  });

  it("ID-2. a client_reference_id that is not a claim UUID becomes a NULL token", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    for (const ref of ["not-a-token", "", 42, "3F0C9A2E-7B1D-4C5E-9A8F-1D2E3F4A5B6C"]) {
      state.rpcCalls = [];
      state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER, client_reference_id: ref });
      expect((await deliver()).status).toBe(200);
      expect(applyCalls()[0].args.p_claim_token).toBeNull();
    }
  });

  it("ID-3. a later nonterminal event names the subscription so a late completion can still bind", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    state.event = event("customer.subscription.updated", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(applyCalls()[0].args).toMatchObject({ p_subscription_id: SUB, p_subscription_status: "active" });
  });

  it("ID-4. the same bound subscription updates normally", async () => {
    state.subscriptions.set(SUB, subscription("past_due"));
    state.event = event("customer.subscription.updated", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "past_due", subscription_tier: "birdie" });
  });

  it("ID-5. a different nonterminal subscription is a conflict: retryable 500, nothing else attempted", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    state.writeResult = { data: "conflict", error: null };
    state.event = event("customer.subscription.updated", subscription("active"));
    await expectFailure(await deliver());
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["billing_apply_subscription_state"]);
    expect(state.listCalls).toEqual([]);
  });

  it("ID-6. a conflict on a completed Checkout never releases the claim", async () => {
    state.subscriptions.set(SUB, subscription("trialing"));
    state.writeResult = { data: "conflict", error: null };
    state.event = event("checkout.session.completed", { subscription: SUB, customer: CUSTOMER, client_reference_id: TOKEN });
    await expectFailure(await deliver());
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["billing_apply_subscription_state"]);
    expect(state.rpcCalls.some((c) => c.fn === "billing_release_checkout")).toBe(false);
  });

  it("ID-7. the bound subscription's terminal event writes canceled and tier none", async () => {
    state.subscriptions.set(SUB, subscription("canceled", { items: items(PRICE.eagle) }));
    state.event = event("customer.subscription.deleted", subscription("active"));
    expect((await deliver()).status).toBe(200);
    expect(applyCalls()[0].args).toMatchObject({
      p_subscription_id: SUB,
      p_subscription_status: "canceled",
      p_subscription_tier: "none",
      p_allow_unbound_terminal: false,
      p_claim_token: null,
    });
  });

  it("ID-8. incomplete_expired is terminal too: canceled, tier none", async () => {
    state.subscriptions.set(SUB, subscription("incomplete_expired"));
    state.event = event("customer.subscription.updated", subscription("incomplete"));
    expect((await deliver()).status).toBe(200);
    expect(state.writes[0].patch).toEqual({ subscription_status: "canceled", subscription_tier: "none" });
  });

  it("ID-9. a terminal event for a different bound subscription is a 200 no-op with no history read", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.writeResult = { data: "stale_terminal", error: null };
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(applyCalls()).toHaveLength(1);
    expect(state.listCalls).toEqual([]);
  });

  it("ID-10. an unbound terminal event triggers a full customer-wide Stripe recheck", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("canceled")])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(state.listCalls).toEqual([{ customer: CUSTOMER, status: "all", limit: 100 }]);
  });

  it("ID-11. unbound + zero nonterminal → the writer is re-called with the unbound allowance", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("canceled"), subscription("incomplete_expired", { id: "sub_TEST_OLD" })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(applyCalls().map((c) => c.args.p_allow_unbound_terminal)).toEqual([false, true]);
    expect(applyCalls()[1].args).toMatchObject({
      p_subscription_id: SUB,
      p_subscription_status: "canceled",
      p_subscription_tier: "none",
      p_claim_token: null,
    });
  });

  it("ID-12. unbound + zero nonterminal, but bound in the meantime → stale outcome is a safe 200", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.rpcQueue = [
      { data: "unbound_terminal_recheck", error: null },
      { data: "stale_terminal", error: null },
    ];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(applyCalls()).toHaveLength(2);
  });

  it("ID-13. unbound + zero nonterminal, second pass not applied → retryable 500", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    for (const outcome of ["conflict", "not_found", "unbound_terminal_recheck"]) {
      state.rpcQueue = [
        { data: "unbound_terminal_recheck", error: null },
        { data: outcome, error: null },
      ];
      state.event = event("customer.subscription.deleted", subscription("canceled"));
      await expectFailure(await deliver());
    }
  });

  it("ID-14. unbound + exactly one recognized nonterminal → binds that current subscription, never cancels", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.subscriptions.set(LIVE, subscription("active", { id: LIVE, items: items(PRICE.eagle) }));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("canceled"), subscription("active", { id: LIVE })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([SUB, LIVE]);
    expect(applyCalls()).toHaveLength(2);
    expect(applyCalls()[1].args).toEqual({
      p_stripe_customer_id: CUSTOMER,
      p_claim_token: null,
      p_subscription_id: LIVE,
      p_subscription_status: "active",
      p_subscription_tier: "eagle",
      p_trial_received: false,
      p_allow_unbound_terminal: false,
    });
    expect(applyCalls().some((c) => c.args.p_allow_unbound_terminal === true)).toBe(false);
  });

  it("ID-15. unbound + one nonterminal that binds into a conflict → retryable 500", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.subscriptions.set(LIVE, subscription("active", { id: LIVE }));
    state.rpcQueue = [
      { data: "unbound_terminal_recheck", error: null },
      { data: "conflict", error: null },
    ];
    state.listPages = [page([subscription("active", { id: LIVE })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    await expectFailure(await deliver());
  });

  it("ID-16. unbound + multiple nonterminal → retryable 500, no second write", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("active", { id: LIVE }), subscription("trialing", { id: "sub_TEST_OTHER" })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    await expectFailure(await deliver());
    expect(applyCalls()).toHaveLength(1);
  });

  it("ID-17. unbound + one nonterminal with an unrecognized price → retryable 500, no second write", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.subscriptions.set(LIVE, subscription("active", { id: LIVE, items: items("price_TEST_UNKNOWN") }));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("active", { id: LIVE })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    await expectFailure(await deliver());
    expect(applyCalls()).toHaveLength(1);
  });

  it("ID-18. unbound + one nonterminal that is terminal on re-read → retryable 500", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.subscriptions.set(LIVE, subscription("canceled", { id: LIVE }));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("active", { id: LIVE })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    await expectFailure(await deliver());
    expect(applyCalls()).toHaveLength(1);
  });

  it("ID-19. unbound + unknown or paused statuses count as nonterminal (fail closed)", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [page([subscription("some_future_state", { id: LIVE }), subscription("paused", { id: "sub_TEST_P" })])];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    await expectFailure(await deliver());
    expect(applyCalls()).toHaveLength(1);
  });

  it("ID-20. the recheck reads every page before deciding", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    state.subscriptions.set(LIVE, subscription("active", { id: LIVE }));
    state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
    state.listPages = [
      page([subscription("canceled", { id: "sub_TEST_A" })], true),
      page([subscription("active", { id: LIVE })]),
    ];
    state.event = event("customer.subscription.deleted", subscription("canceled"));
    expect((await deliver()).status).toBe(200);
    expect(state.listCalls).toEqual([
      { customer: CUSTOMER, status: "all", limit: 100 },
      { customer: CUSTOMER, status: "all", limit: 100, starting_after: "sub_TEST_A" },
    ]);
    // The live subscription on page two is bound; nothing is cancelled.
    expect(applyCalls()[1].args.p_subscription_id).toBe(LIVE);
  });

  it("ID-21. a history read failure or inconsistent pagination → retryable 500, no second write", async () => {
    state.subscriptions.set(SUB, subscription("canceled"));
    const BROKEN: (() => void)[] = [
      () => (state.listThrows = true),
      () => (state.listPages = [page([], true)]),
      () => (state.listPages = [{ object: "list", data: null, has_more: false }]),
      () =>
        (state.listPages = [
          page([subscription("canceled", { id: "sub_TEST_A" })], true),
          page([subscription("canceled", { id: "sub_TEST_A" })], true),
        ]),
    ];
    for (const breakIt of BROKEN) {
      state.rpcCalls = [];
      state.listThrows = false;
      state.listPages = [];
      breakIt();
      state.rpcQueue = [{ data: "unbound_terminal_recheck", error: null }];
      state.event = event("customer.subscription.deleted", subscription("canceled"));
      await expectFailure(await deliver());
      expect(applyCalls()).toHaveLength(1);
    }
  });

  it("ID-22. updated, deleted and payment_failed always pass a NULL claim token", async () => {
    state.subscriptions.set(SUB, subscription("active"));
    const EVENTS: [string, Record<string, unknown>][] = [
      ["customer.subscription.updated", subscription("active", { client_reference_id: TOKEN })],
      ["customer.subscription.deleted", subscription("canceled", { client_reference_id: TOKEN })],
      ["invoice.payment_failed", { subscription: SUB, customer: CUSTOMER, client_reference_id: TOKEN }],
    ];
    for (const [type, object] of EVENTS) {
      state.rpcCalls = [];
      state.event = event(type, object);
      expect((await deliver()).status, type).toBe(200);
      expect(applyCalls()[0].args.p_claim_token, type).toBeNull();
    }
  });

  it("ID-23. a completed Session without a subscription releases only its own claim on exactly one profile", async () => {
    state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER, client_reference_id: TOKEN });
    expect((await deliver()).status).toBe(200);
    expect(state.lookups).toEqual([{ column: "stripe_customer_id", value: CUSTOMER }]);
    expect(state.rpcCalls).toEqual([
      { fn: "billing_release_checkout", args: { p_user_id: "user_TEST_0001", p_claim_token: TOKEN } },
    ]);
    expect(state.writes).toEqual([]);
  });

  it("ID-24. a completed Session without a subscription and without a token touches nothing", async () => {
    state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER, client_reference_id: null });
    expect((await deliver()).status).toBe(200);
    expect(state.lookups).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });

  it("ID-25. a subscription-less release that cannot prove exactly one profile → retryable 500", async () => {
    const RESULTS: { data: unknown; error: unknown }[] = [
      { data: [], error: null },
      { data: [{ id: "user_TEST_0001" }, { id: "user_TEST_0002" }], error: null },
      { data: null, error: { message: "db-secret-detail" } },
    ];
    for (const result of RESULTS) {
      state.rpcCalls = [];
      state.lookupResult = result;
      state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER, client_reference_id: TOKEN });
      await expectFailure(await deliver());
      expect(state.rpcCalls).toEqual([]);
    }
  });

  it("ID-26. trial evidence is the current subscription's trial_start, nothing else", async () => {
    state.subscriptions.set(SUB, subscription("active", { trial_start: null, metadata: { trial: "yes" } }));
    state.event = event("customer.subscription.updated", subscription("trialing", { trial_start: 1700000000 }));
    await deliver();
    expect(applyCalls()[0].args.p_trial_received).toBe(false);

    state.rpcCalls = [];
    state.subscriptions.set(SUB, subscription("active", { trial_start: 1700000000 }));
    state.event = event("customer.subscription.updated", subscription("active"));
    await deliver();
    expect(applyCalls()[0].args.p_trial_received).toBe(true);
  });

  it("ID-27. a retrieved subscription whose id differs from the one named fails closed", async () => {
    state.subscriptions.set(SUB, subscription("active", { id: "sub_TEST_SWAPPED" }));
    state.event = event("customer.subscription.updated", subscription("active"));
    await expectFailure(await deliver());
    expect(state.rpcCalls).toEqual([]);
  });

  it("ID-28. the webhook source routes every event through the writer with the frozen token rules", () => {
    const src = code(WEBHOOK);
    expect(src).not.toMatch(/metadata/);
    expect(src).toContain("const claimToken = claimTokenOf(session.client_reference_id);");
    expect(src).toContain("p_allow_unbound_terminal: allowUnboundTerminal,");
    expect(src).toContain("await applySubscriptionState(customerId, claimToken, terminal, true);");
    expect(src).toContain("await applySubscriptionState(customerId, null, state, false);");
    expect(src.match(/await applySubscription\(await currentSubscription\([^)]*\), null\)/g)).toHaveLength(2);
  });
});
