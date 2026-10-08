import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// PRICING-1 — self-service billing portal
// ============================================================================
//
// The portal route runs for real against deterministic stand-ins for Stripe,
// the verified-auth resolver and NextResponse. No network, no Stripe API, no
// database. Every identifier is synthetic, and the Stripe environment is
// restored after the file.

const state = vi.hoisted(() => {
  const saved = {
    secret: process.env.STRIPE_SECRET_KEY,
    configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID,
  };
  return {
    saved,
    auth: null as unknown,
    profile: { data: null as unknown, error: null as unknown },
    queries: [] as { table: string; select: string | null; eq: [string, unknown] | null }[],
    routeAuthCalls: 0,
    adminConstructions: 0,
    stripeKeys: [] as unknown[],
    portalSessions: [] as Record<string, unknown>[],
    portalUrl: "https://billing.stripe.com/p/session/test_TEST_SESSION" as unknown,
    portalThrows: false,
    customersCreated: 0,
    subscriptionCalls: 0,
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
    redirect: (url: string | URL, init?: { status?: number } | number) =>
      new Response(null, {
        status: typeof init === "number" ? init : init?.status ?? 307,
        headers: { location: String(url) },
      }),
  },
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveVerifiedAuth: async () => state.auth,
  resolveRouteAuth: async () => {
    state.routeAuthCalls++;
    return state.auth;
  },
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions++;
    throw new Error("the portal route must not use the admin client");
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    constructor(key: unknown) {
      state.stripeKeys.push(key);
    }
    billingPortal = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          state.portalSessions.push(params);
          if (state.portalThrows) throw new Error("No such customer: 'cus_TEST_OWNED' config bpc_TEST_APP");
          return { id: "bps_TEST_SESSION", url: state.portalUrl };
        },
      },
    };
    customers = {
      create: async () => {
        state.customersCreated++;
        return { id: "cus_TEST_NEW" };
      },
    };
    subscriptions = {
      update: async () => {
        state.subscriptionCalls++;
        return {};
      },
      cancel: async () => {
        state.subscriptionCalls++;
        return {};
      },
    };
  },
}));

import { POST } from "@/app/api/stripe/portal/route";
import * as portalRoute from "@/app/api/stripe/portal/route";
import { canManageBilling, MANAGE_BILLING_STATUSES } from "@/lib/billing/manage-billing-eligibility";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

const ROUTE = "app/api/stripe/portal/route.ts";
const UPGRADE = "app/(dashboard)/upgrade/page.tsx";

const ORIGIN = "https://www.swingpro-ai.com";
const USER = "user_TEST_0001";
const CUSTOMER = "cus_TEST_OWNED";
const CONFIGURATION = "bpc_TEST_APP";
const SECRET = "test-stripe-secret-not-real";
const UNAVAILABLE = "https://www.swingpro-ai.com/upgrade?billing=unavailable";

function client() {
  return {
    from: (table: string) => {
      const query = { table, select: null as string | null, eq: null as [string, unknown] | null };
      state.queries.push(query);
      return {
        select: (columns: string) => {
          query.select = columns;
          return {
            eq: (column: string, value: unknown) => {
              query.eq = [column, value];
              return { single: async () => state.profile };
            },
          };
        },
      };
    },
  };
}

function signedIn(source: "cookie" | "bearer" = "cookie") {
  return { status: "authenticated", userId: USER, email: "golfer@example.test", accessToken: "tok", client: client(), source };
}

function owns(status: unknown, customer: unknown = CUSTOMER) {
  state.profile = { data: { stripe_customer_id: customer, subscription_status: status }, error: null };
}

async function post(
  origin: string | null = ORIGIN,
  body = "",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", ...extraHeaders };
  if (origin !== null) headers.origin = origin;
  const request = new Request(`${ORIGIN}/api/stripe/portal`, { method: "POST", headers, body });
  return POST(request as never);
}

let logged: string[] = [];

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = SECRET;
  process.env.STRIPE_PORTAL_CONFIGURATION_ID = CONFIGURATION;
  state.auth = signedIn();
  owns("active");
  state.queries = [];
  state.routeAuthCalls = 0;
  state.adminConstructions = 0;
  state.stripeKeys = [];
  state.portalSessions = [];
  state.portalUrl = "https://billing.stripe.com/p/session/test_TEST_SESSION";
  state.portalThrows = false;
  state.customersCreated = 0;
  state.subscriptionCalls = 0;
  logged = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of [
    ["STRIPE_SECRET_KEY", state.saved.secret],
    ["STRIPE_PORTAL_CONFIGURATION_ID", state.saved.configuration],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function expectNoSideEffects() {
  expect(state.portalSessions).toEqual([]);
  expect(state.stripeKeys).toEqual([]);
  expect(state.customersCreated).toBe(0);
  expect(state.subscriptionCalls).toBe(0);
  expect(state.adminConstructions).toBe(0);
}

function expectUnavailable(response: Response) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(UNAVAILABLE);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

// ─── Method ───────────────────────────────────────────────────────────────────

describe("portal route method", () => {
  it("1. exposes POST and no GET handler", () => {
    expect(typeof portalRoute.POST).toBe("function");
    expect((portalRoute as Record<string, unknown>).GET).toBeUndefined();
  });
});

// ─── Origin ───────────────────────────────────────────────────────────────────

describe("canonical origin boundary", () => {
  const rejected: [string, string | null][] = [
    ["2. missing Origin", null],
    ["3. cross-site Origin", "https://evil.example"],
    ["4. vercel.app Origin", "https://swing-pro-ai.vercel.app"],
    ["5. apex non-www Origin", "https://swingpro-ai.com"],
    ["6. http canonical-host Origin", "http://www.swingpro-ai.com"],
  ];

  for (const [name, origin] of rejected) {
    it(`${name} is rejected 403 before auth, database or Stripe`, async () => {
      let authRead = false;
      state.auth = new Proxy(signedIn(), {
        get(target, key) {
          authRead = true;
          return Reflect.get(target, key);
        },
      });
      const response = await post(origin);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(authRead).toBe(false);
      expect(state.queries).toEqual([]);
      expectNoSideEffects();
    });
  }

  it("rejects the literal null Origin", async () => {
    expect((await post("null")).status).toBe(403);
    expectNoSideEffects();
  });

  it("7. the canonical https://www.swingpro-ai.com Origin is accepted", async () => {
    const response = await post(ORIGIN);
    expect(response.status).toBe(303);
    expect(state.portalSessions).toHaveLength(1);
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("verified browser session", () => {
  it("8. absent auth redirects to login", async () => {
    state.auth = { status: "absent" };
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://www.swingpro-ai.com/login");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.queries).toEqual([]);
    expectNoSideEffects();
  });

  it("9. invalid auth redirects to login", async () => {
    state.auth = { status: "invalid" };
    const response = await post();
    expect(response.headers.get("location")).toBe("https://www.swingpro-ai.com/login");
    expectNoSideEffects();
  });

  it("10. unavailable verification redirects to auth-unavailable", async () => {
    state.auth = { status: "verification_unavailable" };
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://www.swingpro-ai.com/upgrade?billing=auth-unavailable");
    expectNoSideEffects();
  });

  it("11. an authenticated caller whose source is not the cookie is rejected 403", async () => {
    state.auth = signedIn("bearer");
    const response = await post(ORIGIN, "", { authorization: "Bearer tok" });
    expect(response.status).toBe(403);
    expect(state.queries).toEqual([]);
    expectNoSideEffects();
  });

  it("12. never consults the Bearer-capable resolver", async () => {
    await post();
    expect(state.routeAuthCalls).toBe(0);
    expect(code(ROUTE)).not.toContain("resolveRouteAuth");
    expect(code(ROUTE)).not.toMatch(/authorization/i);
  });
});

// ─── Ownership and input ──────────────────────────────────────────────────────

describe("server-owned billing identity", () => {
  it("13. reads only the caller's own row, by verified user id", async () => {
    await post();
    expect(state.queries).toEqual([
      { table: "users", select: "stripe_customer_id, subscription_status", eq: ["id", USER] },
    ]);
  });

  const hostile = new URLSearchParams({
    customer: "cus_TEST_ATTACKER",
    stripe_customer_id: "cus_TEST_ATTACKER",
    subscription: "sub_TEST_ATTACKER",
    configuration: "bpc_TEST_DEFAULT",
    return_url: "https://evil.example/phish",
  }).toString();

  it("14. the request body cannot choose the customer", async () => {
    await post(ORIGIN, hostile);
    expect(state.portalSessions[0].customer).toBe(CUSTOMER);
  });

  it("15. the request body cannot choose a subscription", async () => {
    await post(ORIGIN, hostile);
    expect(state.portalSessions[0]).not.toHaveProperty("subscription");
    expect(JSON.stringify(state.portalSessions[0])).not.toContain("sub_TEST_ATTACKER");
  });

  it("16. the request body cannot choose the configuration", async () => {
    await post(ORIGIN, hostile);
    expect(state.portalSessions[0].configuration).toBe(CONFIGURATION);
  });

  it("17. the request body cannot choose the return URL", async () => {
    await post(ORIGIN, hostile);
    expect(state.portalSessions[0].return_url).toBe("https://www.swingpro-ai.com/upgrade");
    expect(code(ROUTE)).not.toMatch(/req\.(json|formData|text|nextUrl)|searchParams/);
  });
});

// ─── Eligibility ──────────────────────────────────────────────────────────────

describe("server-side manage-billing eligibility", () => {
  it("18. a missing customer fails closed with no Stripe call", async () => {
    owns("active", null);
    expectUnavailable(await post());
    expectNoSideEffects();
  });

  it("an empty-string customer fails closed", async () => {
    owns("active", "");
    expectUnavailable(await post());
    expectNoSideEffects();
  });

  it("19. status none fails closed", async () => {
    owns("none");
    expectUnavailable(await post());
    expectNoSideEffects();
  });

  for (const [n, status] of [
    ["20", "active"],
    ["21", "trialing"],
    ["22", "past_due"],
    ["23", "canceled"],
  ] as const) {
    it(`${n}. ${status} may open the portal`, async () => {
      owns(status);
      const response = await post();
      expect(response.status).toBe(303);
      expect(state.portalSessions).toHaveLength(1);
    });
  }

  it("24. an unsupported status fails closed", async () => {
    for (const status of ["incomplete", "unpaid", "ACTIVE", " active", null, 1]) {
      owns(status);
      expectUnavailable(await post());
    }
    expectNoSideEffects();
  });

  it("a profile lookup error fails closed", async () => {
    state.profile = { data: null, error: { message: "row not found" } };
    expectUnavailable(await post());
    expectNoSideEffects();
  });
});

// ─── Environment ──────────────────────────────────────────────────────────────

describe("server configuration", () => {
  it("25. a missing STRIPE_SECRET_KEY fails closed before Stripe is constructed", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expectUnavailable(await post());
    expectNoSideEffects();
  });

  it("26. a missing STRIPE_PORTAL_CONFIGURATION_ID fails closed, never falling back to the default", async () => {
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    expectUnavailable(await post());
    expectNoSideEffects();
  });
});

// ─── Stripe session ───────────────────────────────────────────────────────────

describe("portal session creation", () => {
  it("27. sends exactly customer, configuration and return_url", async () => {
    await post();
    expect(state.stripeKeys).toEqual([SECRET]);
    expect(state.portalSessions).toEqual([
      { customer: CUSTOMER, configuration: CONFIGURATION, return_url: "https://www.swingpro-ai.com/upgrade" },
    ]);
  });

  it("28. sends no flow_data", async () => {
    await post();
    expect(state.portalSessions[0]).not.toHaveProperty("flow_data");
    expect(code(ROUTE)).not.toContain("flow_data");
  });

  it("29. uses no admin client and writes no database row", async () => {
    await post();
    expect(state.adminConstructions).toBe(0);
    expect(code(ROUTE)).not.toMatch(/createAdminClient|\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  });

  it("30. creates no Stripe customer", async () => {
    owns("active", null);
    await post();
    owns("active");
    await post();
    expect(state.customersCreated).toBe(0);
    expect(code(ROUTE)).not.toContain("customers.");
  });

  it("31. never updates or cancels a subscription directly", async () => {
    await post();
    expect(state.subscriptionCalls).toBe(0);
    expect(code(ROUTE)).not.toContain("subscriptions.");
  });

  it("32. success is a 303 to the Stripe billing URL with no-store", async () => {
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://billing.stripe.com/p/session/test_TEST_SESSION");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("33. a session URL outside billing.stripe.com fails closed", async () => {
    for (const url of ["https://evil.example/p/session", "http://billing.stripe.com/p/x", "https://billing.stripe.com.evil.example/", null]) {
      state.portalUrl = url;
      expectUnavailable(await post());
    }
  });

  it("34. a Stripe failure is generic and exposes no billing identifier", async () => {
    state.portalThrows = true;
    const response = await post();
    expectUnavailable(response);
    const body = await response.text();
    const surface = [body, response.headers.get("location") ?? "", ...logged].join("\n");
    for (const secret of [CUSTOMER, CONFIGURATION, SECRET, "bps_TEST_SESSION", "No such customer"]) {
      expect(surface).not.toContain(secret);
    }
    expect(logged).toEqual([]);
  });

  it("logs nothing on success", async () => {
    await post();
    expect(logged).toEqual([]);
    expect(code(ROUTE)).not.toMatch(/console\./);
  });
});

// ─── UI and helper contract ───────────────────────────────────────────────────

describe("Plan & Billing page contract", () => {
  const page = code(UPGRADE);

  it("35. live subscribers (active, trialing, past_due) see no checkout CTA", () => {
    expect(page).toMatch(/LIVE_SUBSCRIPTION_STATUSES = \["active", "trialing", "past_due"\]/);
    expect(page).toMatch(/hasLiveSubscription = canManage && LIVE_SUBSCRIPTION_STATUSES\.includes\(status\)/);
    const cards = page.indexOf("{!hasLiveSubscription && (");
    expect(cards).toBeGreaterThan(-1);
    expect(page.indexOf("<CheckoutButton")).toBeGreaterThan(cards);
  });

  it("36. free or ineligible golfers keep the checkout path and launch prices", () => {
    expect(page).toContain("<CheckoutButton");
    expect(page).toContain('price: "$7.99"');
    expect(page).toContain('price: "$14.99"');
    expect(page).toContain('price: "$24.99"');
    expect(page).toContain(
      "All plans include a 7-day free trial. A card is required at checkout; billing starts when your trial ends.",
    );
  });

  it("37. a canceled customer gets Manage billing and keeps the plan cards to resubscribe", () => {
    // canceled passes canManageBilling but is not a live subscription.
    expect(canManageBilling(CUSTOMER, "canceled")).toBe(true);
    expect(page).toContain("{canManage && (");
    expect(page).toContain("{!hasLiveSubscription && (");
  });

  it("38. a canceled customer is not presented as on a plan", () => {
    expect(page).toContain("Your subscription has ended");
    expect(page).toMatch(/currentPlanName = hasLiveSubscription \?/);
  });

  it("39. Manage billing is a POST form to /api/stripe/portal and renders no billing identifier", () => {
    expect(page).toContain('<form method="POST" action="/api/stripe/portal"');
    expect(page).toContain("Manage billing");
    expect(page).not.toMatch(/\{profile\??\.stripe_customer_id\}/);
    expect(page).not.toContain("STRIPE_PORTAL_CONFIGURATION_ID");
  });

  it("40. the eligibility helper matrix is exact", () => {
    expect([...MANAGE_BILLING_STATUSES]).toEqual(["active", "trialing", "past_due", "canceled"]);
    for (const status of MANAGE_BILLING_STATUSES) expect(canManageBilling(CUSTOMER, status)).toBe(true);
    for (const status of ["none", "incomplete", "unpaid", "paused", "Active", "", null, undefined, 0]) {
      expect(canManageBilling(CUSTOMER, status)).toBe(false);
    }
    for (const customer of [null, undefined, "", "   ", 42, {}]) {
      expect(canManageBilling(customer, "active")).toBe(false);
    }
  });
});
