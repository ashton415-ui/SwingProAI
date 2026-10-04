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
    writes: [] as { table: string; patch: unknown; eq: [string, unknown] | null; select: string | null }[],
    writeResult: { data: [{ id: "row-1" }], error: null } as { data: unknown; error: unknown },
    writeThrows: false,
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
    };
  },
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions++;
    if (state.adminThrows) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    return {
      from: (table: string) => ({
        update: (patch: unknown) => {
          const write = { table, patch, eq: null as [string, unknown] | null, select: null as string | null };
          state.writes.push(write);
          return {
            eq: (column: string, value: unknown) => {
              write.eq = [column, value];
              return {
                select: async (columns: string) => {
                  write.select = columns;
                  if (state.writeThrows) throw new Error("db-secret-detail connection reset");
                  return state.writeResult;
                },
              };
            },
          };
        },
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
  state.writeResult = { data: [{ id: "row-1" }], error: null };
  state.writeThrows = false;
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
        select: "id",
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

  it("23. with no subscription writes status none and tier none", async () => {
    state.event = event("checkout.session.completed", { subscription: null, customer: CUSTOMER });
    expect((await deliver()).status).toBe(200);
    expect(state.retrieveCalls).toEqual([]);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].patch).toEqual({ subscription_status: "none", subscription_tier: "none" });
    expect(state.writes[0].eq).toEqual(["stripe_customer_id", CUSTOMER]);
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

  it("30, 37. every handled write selects only id, proves one row, and acknowledges 2xx", async () => {
    for (const [name, setup] of HANDLED) {
      state.writes = [];
      setup();
      const response = await deliver();
      expect(response.status, name).toBe(200);
      expect(state.writes, name).toHaveLength(1);
      expect(state.writes[0].select, name).toBe("id");
      expect(state.writes[0].eq?.[0], name).toBe("stripe_customer_id");
    }
  });

  const FAILURES: [string, () => void][] = [
    ["31. Supabase error", () => (state.writeResult = { data: null, error: { message: "db-secret-detail" } })],
    ["32. Supabase throw", () => (state.writeThrows = true)],
    ["33. zero-row match", () => (state.writeResult = { data: [], error: null })],
    ["34. two rows", () => (state.writeResult = { data: [{ id: "row-1" }, { id: "row-2" }], error: null })],
    ["34. malformed result", () => (state.writeResult = { data: { id: "row-1" }, error: null })],
    ["admin client construction", () => (state.adminThrows = true)],
  ];
  for (const [label, breakIt] of FAILURES) {
    it(`${label} → generic 500 on every handled event, never received:true`, async () => {
      breakIt();
      for (const [name, setup] of HANDLED) {
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
    state.writeResult = { data: [{ id: "row-1" }], error: null };
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
    // Value writes only; the BillingPatch type annotation is not a write.
    const writes = (src.match(/subscription_status:\s*[^,}\n]+/g) ?? []).filter(
      (w) => !/subscription_status:\s*SubscriptionStatus;/.test(w),
    );
    expect(writes.length).toBe(5);
    for (const w of writes) {
      expect(w, w).toMatch(/normalizeStripeSubscriptionStatus\(|"none"/);
    }
  });

  it("42. maps every known non-entitling status away from active/trialing", () => {
    for (const status of ["past_due", "incomplete", "paused", "unpaid", "canceled", "incomplete_expired"]) {
      expect(normalizeStripeSubscriptionStatus(status)).not.toMatch(/^(active|trialing)$/);
    }
  });

  it("keeps the trusted writer, the customer binding and the exact-one-row proof", () => {
    expect(src).toContain('import { createAdminClient } from "@/utils/supabase/admin";');
    expect(src).toContain('.eq("stripe_customer_id", customerId)');
    expect(src).toContain('.select("id")');
    expect(src).toContain("result.data.length !== 1");
    expect((src.match(/\.from\("users"\)/g) ?? []).length).toBe(1);
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
    expect(tiers.length).toBe(5);
    for (const w of tiers) expect(w, w).toMatch(/tierOf\(subscription\)|"none"/);
  });

  it("only the webhook consumes the normalizer", () => {
    const consumers = ["app/api/webhooks/stripe/route.ts"];
    for (const f of consumers) expect(read(f)).toContain("@/lib/billing/stripe-subscription-status");
  });
});
