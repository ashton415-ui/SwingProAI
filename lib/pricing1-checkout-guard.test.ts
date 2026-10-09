import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// PRICING-1 — trial eligibility and the concurrent checkout guard
// ============================================================================
//
// The pure preflight helper is exercised directly. The checkout route runs for
// real against deterministic stand-ins for Stripe, the verified-auth resolver,
// the server-only admin client and NextResponse.
//
// The admin client's billing RPCs are served by GuardModel below: an in-memory
// model of the FROZEN contract of the migration's functions (begin, takeover,
// attach, release). It lets the route's state machine be driven end to end,
// including two checkout attempts against one account. It is a model, not the
// database: real row locks and concurrent transactions are proved in the
// separately authorized staging acceptance gate, and the SQL itself is pinned
// by lib/pricing1-billing-guard-schema.test.ts.
//
// No network, no Stripe API, no database. Every identifier is synthetic.

const USER = "user_TEST_0001";
const CUSTOMER = "cus_TEST_0001";
const ORIGIN = "https://www.swingpro-ai.com";

const state = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["STRIPE_PAR_PRICE_ID", "STRIPE_BIRDIE_PRICE_ID", "STRIPE_EAGLE_PRICE_ID", "STRIPE_SECRET_KEY"]) {
    saved[key] = process.env[key];
  }
  return {
    saved,
    log: [] as string[],
    auth: null as unknown,
    /** Pre-claim presentation read. A forged customer here must never be authority. */
    profile: { full_name: null as string | null } as Record<string, unknown>,
    profileError: null as unknown,
    adminThrows: false,
    /** Any direct public.users write from the route. Must stay zero. */
    directUserWrites: 0,
    /** Every billing RPC answer, in call order. */
    rpcResults: [] as { fn: string; result: unknown }[],
    customerId: "cus_TEST_NEW" as unknown,
    /** Runs inside customers.create / sessions.create: a concurrent request's move. */
    duringCustomerCreate: null as null | (() => void),
    duringSessionCreate: null as null | (() => void),
    rpcOverride: {} as Record<string, (args: Record<string, unknown>) => unknown>,
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    customersCreated: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    customerThrows: false,
    sessionsCreated: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
    sessionCreateThrows: false,
    sessionUrl: null as string | null | undefined,
    stripeSessions: new Map<string, string>(),
    retrieveThrows: false,
    expireThrows: false,
    expireCalls: [] as string[],
    listCalls: [] as Record<string, unknown>[],
    listPages: [] as unknown[],
    history: [] as Record<string, unknown>[],
    listThrows: false,
  };
});

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } }),
    redirect: (url: string | URL, init?: { status?: number }) =>
      new Response(null, { status: init?.status ?? 307, headers: { location: String(url) } }),
  },
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveVerifiedAuth: async () => {
    state.log.push("auth");
    return state.auth;
  },
}));

// ─── Guard model: the frozen RPC contract, in memory ─────────────────────────

interface GuardRow {
  trial_used_at: number | null;
  claim_token: string | null;
  claim_acquired_at: number | null;
  claim_expires_at: number | null;
  claim_session_id: string | null;
}

const model = vi.hoisted(() => ({
  exists: true,
  stripe_subscription_id: null as string | null,
  subscription_status: "none" as string,
  guard: null as GuardRow | null,
  seq: 0,
  /** users.stripe_customer_id: durable customer authority. */
  stripe_customer_id: null as string | null,
  /** Customers already linked to OTHER profiles (users_stripe_customer_id_key). */
  otherAccountCustomers: [] as string[],
}));

function eligible(): boolean {
  return model.stripe_subscription_id === null && ["none", "canceled"].includes(model.subscription_status);
}

function claimAnswer(outcome: "claimed" | "held", g: GuardRow) {
  const now = Date.now();
  return {
    outcome,
    claim_token: g.claim_token,
    claim_acquired_at: new Date(g.claim_acquired_at!).toISOString(),
    claim_expires_at: new Date(g.claim_expires_at!).toISOString(),
    claim_age_seconds: (now - g.claim_acquired_at!) / 1000,
    claim_remaining_seconds: (g.claim_expires_at! - now) / 1000,
    held_session_id: g.claim_session_id,
    trial_used: g.trial_used_at !== null,
    // Only a successful claim carries the customer, read under the same lock.
    ...(outcome === "claimed" ? { stripe_customer_id: model.stripe_customer_id } : {}),
  };
}

function newClaim(g: GuardRow, ttl: number) {
  model.seq++;
  const now = Date.now();
  g.claim_token = `00000000-0000-4000-8000-${String(model.seq).padStart(12, "0")}`;
  g.claim_acquired_at = now;
  g.claim_expires_at = now + ttl * 1000;
  g.claim_session_id = null;
}

const GUARD_MODEL: Record<string, (a: Record<string, unknown>) => unknown> = {
  billing_begin_checkout: (a) => {
    const ttl = a.p_ttl_seconds as number;
    if (!(ttl >= 1800 && ttl <= 3600)) return { data: null, error: { message: "PRICING1-BEGIN-2" } };
    if (!model.exists) return { data: { outcome: "not_found" }, error: null };
    if (!eligible()) return { data: { outcome: "blocked" }, error: null };
    model.guard ??= { trial_used_at: null, claim_token: null, claim_acquired_at: null, claim_expires_at: null, claim_session_id: null };
    if (model.guard.claim_token !== null) return { data: claimAnswer("held", model.guard), error: null };
    newClaim(model.guard, ttl);
    return { data: claimAnswer("claimed", model.guard), error: null };
  },
  billing_takeover_checkout: (a) => {
    if (!model.exists) return { data: { outcome: "not_found" }, error: null };
    if (!eligible()) return { data: { outcome: "blocked" }, error: null };
    const g = model.guard;
    if (!g || g.claim_token !== a.p_old_claim_token || g.claim_session_id !== (a.p_expected_session_id ?? null)) {
      return { data: { outcome: "lost" }, error: null };
    }
    if (a.p_expected_session_id === null && Date.now() - g.claim_acquired_at! < 180_000) {
      return { data: { outcome: "lost" }, error: null };
    }
    newClaim(g, a.p_ttl_seconds as number);
    return { data: claimAnswer("claimed", g), error: null };
  },
  billing_link_checkout_customer: (a) => {
    const customer = a.p_stripe_customer_id;
    if (typeof customer !== "string" || customer.length === 0) {
      return { data: null, error: { code: "22023", message: "PRICING1-LINK-1" } };
    }
    if (!model.exists) return { data: "not_found", error: null };
    if (!eligible()) return { data: "blocked", error: null };
    const g = model.guard;
    if (
      !g ||
      a.p_claim_token === null ||
      g.claim_token !== a.p_claim_token ||
      g.claim_expires_at === null ||
      g.claim_expires_at <= Date.now() ||
      g.claim_session_id !== null
    ) {
      return { data: "lost", error: null };
    }
    if (model.stripe_customer_id === null) {
      // users_stripe_customer_id_key: the whole call rolls back.
      if (model.otherAccountCustomers.includes(customer)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      model.stripe_customer_id = customer;
      return { data: "linked", error: null };
    }
    if (model.stripe_customer_id === customer) return { data: "already_linked_same", error: null };
    return { data: "customer_conflict", error: null };
  },
  billing_attach_checkout_session: (a) => {
    const g = model.guard;
    const ok =
      eligible() &&
      !!g &&
      g.claim_token === a.p_claim_token &&
      g.claim_session_id === null &&
      g.claim_expires_at! > Date.now() &&
      typeof a.p_session_id === "string" &&
      a.p_session_id.length > 0;
    if (ok) g!.claim_session_id = a.p_session_id as string;
    return { data: ok, error: null };
  },
  billing_release_checkout: (a) => {
    const g = model.guard;
    const ok = !!g && a.p_claim_token !== null && g.claim_token === a.p_claim_token;
    if (ok) {
      g!.claim_token = null;
      g!.claim_acquired_at = null;
      g!.claim_expires_at = null;
      g!.claim_session_id = null;
    }
    return { data: ok, error: null };
  },
};

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.log.push("admin");
    if (state.adminThrows) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.log.push(`rpc:${fn}`);
        state.rpcCalls.push({ fn, args });
        const override = state.rpcOverride[fn];
        const result = override ? override(args) : GUARD_MODEL[fn](args);
        state.rpcResults.push({ fn, result });
        return result;
      },
      // A tripwire: the route must never write public.users directly.
      from: () => ({
        update: () => {
          state.directUserWrites++;
          throw new Error("direct public.users write");
        },
      }),
    };
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        state.log.push("stripe:customers.create");
        if (state.customerThrows) throw new Error("provider-secret-detail");
        state.customersCreated.push({ params, options });
        state.duringCustomerCreate?.();
        return { id: state.customerId };
      },
    };
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          state.log.push("stripe:sessions.create");
          if (state.sessionCreateThrows) throw new Error("provider-secret-detail");
          state.sessionsCreated.push({ params, options });
          state.duringSessionCreate?.();
          const id = `cs_TEST_${state.sessionsCreated.length}`;
          state.stripeSessions.set(id, "open");
          return {
            id,
            url: state.sessionUrl === undefined ? `https://checkout.stripe.com/c/pay/${id}` : state.sessionUrl,
          };
        },
        retrieve: async (id: string) => {
          state.log.push("stripe:sessions.retrieve");
          if (state.retrieveThrows) throw new Error("provider-secret-detail");
          return { id, status: state.stripeSessions.get(id) };
        },
        expire: async (id: string) => {
          state.log.push("stripe:sessions.expire");
          state.expireCalls.push(id);
          if (state.expireThrows) throw new Error("provider-secret-detail");
          if (state.stripeSessions.get(id) !== "open") throw new Error("Only open sessions can be expired");
          state.stripeSessions.set(id, "expired");
          return { id, status: "expired" };
        },
      },
    };
    subscriptions = {
      list: async (params: Record<string, unknown>) => {
        state.log.push("stripe:subscriptions.list");
        state.listCalls.push(params);
        if (state.listThrows) throw new Error("provider-secret-detail");
        if (state.listPages.length > 0) return state.listPages.shift();
        return { object: "list", data: state.history, has_more: false };
      },
    };
  },
}));

import {
  TERMINAL_STRIPE_SUBSCRIPTION_STATUSES,
  classifySubscriptionHistory,
  hadTrial,
  isTerminalStripeSubscriptionStatus,
} from "@/lib/billing/subscription-preflight";
import { POST } from "@/app/api/stripe/checkout/route";
import * as checkoutRoute from "@/app/api/stripe/checkout/route";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

const CHECKOUT = "app/api/stripe/checkout/route.ts";
const PREFLIGHT = "lib/billing/subscription-preflight.ts";
const BUTTON = "components/CheckoutButton.tsx";
const UPGRADE = "app/(dashboard)/upgrade/page.tsx";

const PRICE = { par: "price_TEST_PAR", birdie: "price_TEST_BIRDIE", eagle: "price_TEST_EAGLE" } as const;
const UPGRADE_URL = `${ORIGIN}/upgrade`;

function cookieAuth(overrides: Record<string, unknown> = {}) {
  return {
    status: "authenticated",
    userId: USER,
    email: "golfer@example.test",
    source: "cookie",
    client: {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => {
              state.log.push("profile");
              return { data: state.profileError ? null : { ...state.profile }, error: state.profileError };
            },
          }),
        }),
      }),
    },
    ...overrides,
  };
}

async function post(
  fields: Record<string, string> = { plan: "birdie" },
  headers: Record<string, string | null> = { origin: ORIGIN },
): Promise<Response> {
  const h = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  for (const [k, v] of Object.entries(headers)) if (v !== null) h.set(k, v);
  return POST(
    new Request(`${ORIGIN}/api/stripe/checkout`, { method: "POST", headers: h, body: new URLSearchParams(fields) }) as never,
  );
}

const location = (r: Response) => r.headers.get("location");
const fnCalls = (fn: string) => state.rpcCalls.filter((c) => c.fn === fn);
const lastSession = () => state.sessionsCreated[state.sessionsCreated.length - 1];

/** Seeds a held claim in the model, aged and optionally attached. */
function holdClaim(opts: { ageSeconds: number; ttlSeconds?: number; sessionId?: string | null; trialUsed?: boolean }) {
  const now = Date.now();
  model.seq++;
  model.guard = {
    trial_used_at: opts.trialUsed ? now - 86_400_000 : null,
    claim_token: `00000000-0000-4000-8000-${String(model.seq).padStart(12, "0")}`,
    claim_acquired_at: now - opts.ageSeconds * 1000,
    claim_expires_at: now - opts.ageSeconds * 1000 + (opts.ttlSeconds ?? 2100) * 1000,
    claim_session_id: opts.sessionId ?? null,
  };
  return model.guard.claim_token!;
}

let logged: string[] = [];

beforeEach(() => {
  process.env.STRIPE_PAR_PRICE_ID = PRICE.par;
  process.env.STRIPE_BIRDIE_PRICE_ID = PRICE.birdie;
  process.env.STRIPE_EAGLE_PRICE_ID = PRICE.eagle;
  process.env.STRIPE_SECRET_KEY = "test-stripe-secret-not-real";
  state.log = [];
  state.auth = cookieAuth();
  state.profile = { full_name: null };
  state.profileError = null;
  state.adminThrows = false;
  state.directUserWrites = 0;
  state.rpcResults = [];
  state.customerId = "cus_TEST_NEW";
  state.duringCustomerCreate = null;
  state.duringSessionCreate = null;
  state.rpcOverride = {};
  state.rpcCalls = [];
  state.customersCreated = [];
  state.customerThrows = false;
  state.sessionsCreated = [];
  state.sessionCreateThrows = false;
  state.sessionUrl = undefined;
  state.stripeSessions = new Map();
  state.retrieveThrows = false;
  state.expireThrows = false;
  state.expireCalls = [];
  state.listCalls = [];
  state.listPages = [];
  state.history = [];
  state.listThrows = false;
  model.exists = true;
  model.stripe_subscription_id = null;
  model.subscription_status = "none";
  model.guard = null;
  model.seq = 0;
  model.stripe_customer_id = CUSTOMER;
  model.otherAccountCustomers = [];
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
  for (const [key, value] of Object.entries(state.saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ─── 39. Subscription preflight helper ────────────────────────────────────────

describe("subscription preflight — terminal classification", () => {
  it("PF-1. exactly canceled and incomplete_expired are terminal", () => {
    expect([...TERMINAL_STRIPE_SUBSCRIPTION_STATUSES]).toEqual(["canceled", "incomplete_expired"]);
    expect(isTerminalStripeSubscriptionStatus("canceled")).toBe(true);
    expect(isTerminalStripeSubscriptionStatus("incomplete_expired")).toBe(true);
  });

  for (const status of ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"]) {
    it(`PF-2. known blocker ${status} is nonterminal`, () => {
      expect(isTerminalStripeSubscriptionStatus(status)).toBe(false);
      expect(classifySubscriptionHistory([{ id: "sub_A", status, trial_start: null }]).hasNonterminal).toBe(true);
    });
  }

  it("PF-3. an unknown, malformed or missing status fails closed as nonterminal", () => {
    for (const status of ["some_future_state", "", "CANCELED", " canceled", null, undefined, 1, {}]) {
      expect(isTerminalStripeSubscriptionStatus(status), String(status)).toBe(false);
      expect(classifySubscriptionHistory([{ id: "sub_A", status }]).hasNonterminal, String(status)).toBe(true);
    }
  });

  it("PF-4. lists every nonterminal subscription, in order", () => {
    const history = [
      { id: "sub_A", status: "canceled", trial_start: null },
      { id: "sub_B", status: "active", trial_start: null },
      { id: "sub_C", status: "incomplete_expired", trial_start: null },
      { id: "sub_D", status: "unpaid", trial_start: null },
    ];
    const result = classifySubscriptionHistory(history);
    expect(result.nonterminalSubscriptions.map((s) => s.id)).toEqual(["sub_B", "sub_D"]);
    expect(result.hasNonterminal).toBe(true);
  });

  it("PF-5. an empty history has no nonterminal subscription and no prior trial", () => {
    expect(classifySubscriptionHistory([])).toEqual({ hasNonterminal: false, nonterminalSubscriptions: [], priorTrial: false });
  });
});

describe("subscription preflight — prior trial", () => {
  it("PF-6. any subscription with a non-null trial_start is a prior trial", () => {
    expect(
      classifySubscriptionHistory([
        { id: "sub_A", status: "canceled", trial_start: null },
        { id: "sub_B", status: "canceled", trial_start: 1700000000 },
      ]).priorTrial,
    ).toBe(true);
  });

  it("PF-7. null or absent trial_start is no trial evidence", () => {
    expect(hadTrial({ trial_start: null })).toBe(false);
    expect(hadTrial({})).toBe(false);
    expect(hadTrial({ trial_start: 0 })).toBe(true);
  });

  it("PF-8. prior trial with only terminal subscriptions: paid checkout allowed, trial removed", () => {
    const result = classifySubscriptionHistory([
      { id: "sub_A", status: "canceled", trial_start: 1700000000 },
      { id: "sub_B", status: "incomplete_expired", trial_start: null },
    ]);
    expect(result.hasNonterminal).toBe(false);
    expect(result.priorTrial).toBe(true);
  });

  it("PF-9. the helper is pure: no environment, Stripe, Supabase or network", () => {
    const src = code(PREFLIGHT);
    expect(src).not.toMatch(/process\.env|from "stripe"|supabase|createAdminClient|fetch\(|\bawait\b|import /);
  });
});

// ─── 40. Method, Origin and browser authority ─────────────────────────────────

describe("checkout — POST only, exact Origin, cookie session only", () => {
  it("CK-1. exports POST and no GET", () => {
    expect(typeof checkoutRoute.POST).toBe("function");
    expect((checkoutRoute as Record<string, unknown>).GET).toBeUndefined();
  });

  it("CK-2. the canonical Origin is accepted and reaches Stripe Checkout", async () => {
    const response = await post();
    expect(response.status).toBe(303);
    expect(location(response)).toBe("https://checkout.stripe.com/c/pay/cs_TEST_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  const REJECTED: [string, string | null][] = [
    ["missing", null],
    ["cross-site", "https://evil.example"],
    ["vercel.app", "https://swing-pro-ai.vercel.app"],
    ["apex", "https://swingpro-ai.com"],
    ["HTTP", "http://www.swingpro-ai.com"],
    ["trailing slash", "https://www.swingpro-ai.com/"],
    ["null", "null"],
  ];
  for (const [label, origin] of REJECTED) {
    it(`CK-3. a ${label} Origin is 403 before auth, database or Stripe`, async () => {
      const response = await post({ plan: "birdie" }, { origin });
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "Forbidden" });
      expect(state.log).toEqual([]);
    });
  }

  it("CK-4. a Bearer-sourced caller is refused before any database or Stripe work", async () => {
    state.auth = cookieAuth({ source: "bearer" });
    const response = await post();
    expect(response.status).toBe(403);
    expect(state.log).toEqual(["auth"]);
  });

  it("CK-5. signed-out → canonical login; auth outage → auth-unavailable notice", async () => {
    state.auth = { status: "absent" };
    expect(location(await post())).toBe(`${ORIGIN}/login`);
    state.auth = { status: "verification_unavailable" };
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=auth-unavailable`);
    expect(state.log.filter((l) => l !== "auth")).toEqual([]);
  });

  it("CK-6. only the cookie resolver is used; Bearer/native resolution is absent", () => {
    const src = code(CHECKOUT);
    expect(src).toContain("await resolveVerifiedAuth()");
    expect(src).not.toContain("resolveRouteAuth");
    expect(src).not.toMatch(/authorization/i);
  });

  it("CK-7. the browser supplies plan only: price, trial, customer, URLs and expiry are ignored", async () => {
    await post({
      plan: "par",
      priceId: PRICE.eagle,
      price: PRICE.eagle,
      tier: "eagle",
      trial: "true",
      trial_period_days: "30",
      customer: "cus_TEST_EVIL",
      subscription: "sub_TEST_EVIL",
      success_url: "https://evil.example/s",
      cancel_url: "https://evil.example/c",
      expires_at: "9999999999",
      claim_token: "00000000-0000-4000-8000-999999999999",
      userId: "user_TEST_EVIL",
    });
    const { params } = lastSession();
    expect(params.line_items).toEqual([{ price: PRICE.par, quantity: 1 }]);
    expect(params.customer).toBe(CUSTOMER);
    expect(params.success_url).toBe(`${ORIGIN}/dashboard?upgraded=true`);
    expect(params.cancel_url).toBe(`${ORIGIN}/upgrade`);
    expect((params.subscription_data as Record<string, unknown>).trial_period_days).toBe(7);
    expect(params.client_reference_id).not.toBe("00000000-0000-4000-8000-999999999999");
    expect(params.expires_at).not.toBe(9999999999);
    expect(fnCalls("billing_begin_checkout")[0].args).toEqual({ p_user_id: USER, p_ttl_seconds: 2100 });
  });

  it("CK-8. the route reads exactly one browser field and never a query string", () => {
    const src = code(CHECKOUT);
    expect(src.match(/\.get\("[a-z_]+"\)/gi)).toEqual(['.get("origin")', '.get("plan")']);
    expect(src).not.toMatch(/searchParams|req\.json\(|req\.url|nextUrl/);
  });

  it("CK-9. the server resolves the Stripe price through the plan authority", async () => {
    for (const [plan, price] of Object.entries(PRICE)) {
      model.guard = null;
      await post({ plan });
      expect(lastSession().params.line_items).toEqual([{ price, quantity: 1 }]);
    }
    expect(code(CHECKOUT)).toContain("const plan = resolveStripePlan(selector);");
  });

  it("CK-10. success and cancel URLs are fixed canonical www URLs; NEXT_PUBLIC_SITE_URL is not an authority", async () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://swing-pro-ai.vercel.app";
    try {
      await post();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = saved;
    }
    expect(lastSession().params.success_url).toBe("https://www.swingpro-ai.com/dashboard?upgraded=true");
    expect(lastSession().params.cancel_url).toBe("https://www.swingpro-ai.com/upgrade");
    const src = read(CHECKOUT);
    expect(src).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(src).not.toContain("vercel.app");
  });

  it("CK-11. an unresolvable plan stops before any claim or Stripe call", async () => {
    for (const plan of ["coach_pro", "", "PAR"]) {
      state.log = [];
      const response = await post({ plan });
      expect(location(response)).toBe(`${UPGRADE_URL}?error=missing-plan`);
      expect(state.log).toEqual(["auth"]);
    }
  });

  it("CK-12. a profile read failure stops before any claim or Stripe call", async () => {
    state.profileError = { message: "db-secret-detail" };
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.log).toEqual(["auth", "profile"]);
  });
});

// ─── 22. Begin outcomes ───────────────────────────────────────────────────────

describe("checkout — begin claim outcomes", () => {
  for (const [status, sub] of [
    ["active", null],
    ["trialing", null],
    ["past_due", null],
    ["canceled", "sub_TEST_BOUND"],
    ["none", "sub_TEST_BOUND"],
  ] as [string, string | null][]) {
    it(`BG-1. locally ineligible (${status}, ${sub ? "bound" : "unbound"}) → existing-subscription, no Stripe write`, async () => {
      model.subscription_status = status;
      model.stripe_subscription_id = sub;
      const response = await post();
      expect(location(response)).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
      expect(state.log.filter((l) => l.startsWith("stripe:"))).toEqual([]);
      expect(model.guard).toBeNull();
    });
  }

  it("BG-2. a canceled, unbound golfer may buy again", async () => {
    model.subscription_status = "canceled";
    expect(location(await post())).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("BG-3. not_found or an RPC error → generic unavailable, no Stripe write", async () => {
    for (const override of [
      () => ({ data: { outcome: "not_found" }, error: null }),
      () => ({ data: null, error: { message: "db-secret-detail" } }),
      () => ({ data: { outcome: "weird" }, error: null }),
      () => ({ data: { outcome: "claimed", claim_token: "not-a-uuid" }, error: null }),
      () => {
        throw new Error("db-secret-detail");
      },
    ]) {
      state.log = [];
      state.rpcOverride.billing_begin_checkout = override;
      expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(state.log.filter((l) => l.startsWith("stripe:"))).toEqual([]);
    }
  });

  it("BG-4. the admin client failing → unavailable before any claim", async () => {
    state.adminThrows = true;
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.rpcCalls).toEqual([]);
  });

  it("BG-5. the claim ttl sent is exactly 2100 seconds and the user id is the verified one", async () => {
    await post();
    expect(fnCalls("billing_begin_checkout").map((c) => c.args)).toEqual([{ p_user_id: USER, p_ttl_seconds: 2100 }]);
  });
});

// ─── 23-24, 42. Held claim recovery ───────────────────────────────────────────

describe("checkout — held claim recovery", () => {
  it("HC-1. held + unattached + younger than 180s → in-progress, no takeover, no Stripe", async () => {
    holdClaim({ ageSeconds: 179 });
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
    expect(state.log.filter((l) => l.startsWith("stripe:"))).toEqual([]);
  });

  it("HC-2. held + unattached + 180s or older → CAS takeover with NULL expected Session, then checkout", async () => {
    const old = holdClaim({ ageSeconds: 181 });
    const response = await post();
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fnCalls("billing_takeover_checkout").map((c) => c.args)).toEqual([
      { p_user_id: USER, p_old_claim_token: old, p_expected_session_id: null, p_ttl_seconds: 2100 },
    ]);
    expect(lastSession().params.client_reference_id).not.toBe(old);
    expect(model.guard?.claim_token).not.toBe(old);
  });

  it("HC-3. a takeover that loses the compare-and-swap → in-progress, no Stripe write", async () => {
    holdClaim({ ageSeconds: 600 });
    state.rpcOverride.billing_takeover_checkout = () => ({ data: { outcome: "lost" }, error: null });
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(state.log.filter((l) => l.startsWith("stripe:"))).toEqual([]);
  });

  it("HC-4. a stale token takeover cannot replace a newer claim (model contract)", async () => {
    holdClaim({ ageSeconds: 600 });
    const result = GUARD_MODEL.billing_takeover_checkout({
      p_user_id: USER,
      p_old_claim_token: "00000000-0000-4000-8000-000000000000",
      p_expected_session_id: null,
      p_ttl_seconds: 2100,
    }) as { data: { outcome: string } };
    expect(result.data.outcome).toBe("lost");
  });

  it("HC-5. held + attached + open + claim still valid → in-progress; no expire, no new Session", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "open");
    holdClaim({ ageSeconds: 600, sessionId: "cs_TEST_HELD" });
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(state.expireCalls).toEqual([]);
    expect(state.sessionsCreated).toEqual([]);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
  });

  it("HC-6. held + attached + complete → processing; claim kept, no takeover, no Session", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "complete");
    const token = holdClaim({ ageSeconds: 3000, sessionId: "cs_TEST_HELD" });
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=processing`);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
    expect(state.sessionsCreated).toEqual([]);
    expect(model.guard?.claim_token).toBe(token);
  });

  it("HC-7. held + attached + expired → takeover naming that exact Session, then checkout", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "expired");
    const old = holdClaim({ ageSeconds: 2200, sessionId: "cs_TEST_HELD" });
    const response = await post();
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fnCalls("billing_takeover_checkout")[0].args).toEqual({
      p_user_id: USER,
      p_old_claim_token: old,
      p_expected_session_id: "cs_TEST_HELD",
      p_ttl_seconds: 2100,
    });
    expect(state.expireCalls).toEqual([]);
  });

  it("HC-8. held + attached + open + local claim expired → expire that exact Session before takeover", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "open");
    holdClaim({ ageSeconds: 2200, sessionId: "cs_TEST_HELD" });
    const response = await post();
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(state.expireCalls[0]).toBe("cs_TEST_HELD");
    const order = state.log.filter((l) => l === "stripe:sessions.expire" || l === "rpc:billing_takeover_checkout");
    expect(order.slice(0, 2)).toEqual(["stripe:sessions.expire", "rpc:billing_takeover_checkout"]);
  });

  it("HC-9. Session retrieve failure → fail closed: no takeover, no new Session", async () => {
    state.retrieveThrows = true;
    holdClaim({ ageSeconds: 2200, sessionId: "cs_TEST_HELD" });
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
    expect(state.sessionsCreated).toEqual([]);
  });

  it("HC-10. Session expire failure → fail closed: no takeover, no new Session", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "open");
    state.expireThrows = true;
    holdClaim({ ageSeconds: 2200, sessionId: "cs_TEST_HELD" });
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
    expect(state.sessionsCreated).toEqual([]);
  });

  it("HC-11. an unknown attached Session status fails closed", async () => {
    state.stripeSessions.set("cs_TEST_HELD", "mystery");
    holdClaim({ ageSeconds: 2200, sessionId: "cs_TEST_HELD" });
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(fnCalls("billing_takeover_checkout")).toEqual([]);
  });

  it("HC-12. a takeover answering blocked → existing-subscription", async () => {
    holdClaim({ ageSeconds: 600 });
    state.rpcOverride.billing_takeover_checkout = () => ({ data: { outcome: "blocked" }, error: null });
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
  });

  it("HC-13. a held claim is never replaced by begin itself (model contract)", () => {
    const token = holdClaim({ ageSeconds: 99_999 });
    const result = GUARD_MODEL.billing_begin_checkout({ p_user_id: USER, p_ttl_seconds: 2100 }) as {
      data: { outcome: string; claim_token: string };
    };
    expect(result.data.outcome).toBe("held");
    expect(result.data.claim_token).toBe(token);
  });
});

// ─── 25, 44. Customer creation serialization ──────────────────────────────────

describe("checkout — customer creation is serialized and idempotent", () => {
  beforeEach(() => {
    model.stripe_customer_id = null;
  });

  it("CU-1. only after owning the claim does the route create a customer", async () => {
    await post();
    const claim = state.log.indexOf("rpc:billing_begin_checkout");
    const create = state.log.indexOf("stripe:customers.create");
    expect(claim).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(claim);
  });

  it("CU-2. a non-owner (held, young) never reaches customer creation", async () => {
    holdClaim({ ageSeconds: 10 });
    await post();
    expect(state.customersCreated).toEqual([]);
  });

  it("CU-3. the customer idempotency key derives from the verified user id only", async () => {
    await post({ plan: "eagle", userId: "user_TEST_EVIL" });
    expect(state.customersCreated[0].options).toEqual({ idempotencyKey: `swingproai-customer-v1:${USER}` });
    expect(state.customersCreated[0].params).toEqual({
      email: "golfer@example.test",
      name: undefined,
      metadata: { supabase_user_id: USER },
    });
  });

  it("CU-4. customer created but link not confirmed → no Session, claim kept for stale recovery", async () => {
    for (const breakIt of [
      () => (state.rpcOverride.billing_link_checkout_customer = () => ({ data: "customer_conflict", error: null })),
      () => (state.rpcOverride.billing_link_checkout_customer = () => ({ data: null, error: { message: "db-secret-detail" } })),
      () =>
        (state.rpcOverride.billing_link_checkout_customer = () => {
          throw new Error("db-secret-detail");
        }),
    ]) {
      model.guard = null;
      model.stripe_customer_id = null;
      state.rpcOverride = {};
      state.sessionsCreated = [];
      state.rpcCalls = [];
      breakIt();
      expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(state.sessionsCreated).toEqual([]);
      expect(fnCalls("billing_release_checkout")).toEqual([]);
      // The model's guard row was rebuilt by the route; read it afresh.
      const guard = model.guard as GuardRow | null;
      expect(guard?.claim_token).not.toBeNull();
    }
  });

  it("CU-5. customer creation failing releases only the current claim and creates no Session", async () => {
    state.customerThrows = true;
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    const releases = fnCalls("billing_release_checkout");
    expect(releases).toHaveLength(1);
    expect(releases[0].args).toEqual({ p_user_id: USER, p_claim_token: "00000000-0000-4000-8000-000000000001" });
    expect(model.guard?.claim_token).toBeNull();
    expect(state.sessionsCreated).toEqual([]);
  });

  it("CU-6. a newly created customer still gets the full history read, and keeps the trial when it is clean", async () => {
    await post();
    expect(state.listCalls).toEqual([{ customer: "cus_TEST_NEW", status: "all", limit: 100 }]);
    expect((lastSession().params.subscription_data as Record<string, unknown>).trial_period_days).toBe(7);
    expect(lastSession().params.customer).toBe("cus_TEST_NEW");
  });

  it("CU-7. an existing customer is reused, never re-created", async () => {
    model.stripe_customer_id = CUSTOMER;
    await post();
    expect(state.customersCreated).toEqual([]);
    expect(lastSession().params.customer).toBe(CUSTOMER);
  });
});

// ─── 26-27, 43. Trial eligibility and Stripe history ──────────────────────────

describe("checkout — one trial per account, Stripe history preflight", () => {
  const trialOf = () => (lastSession().params.subscription_data as Record<string, unknown>).trial_period_days;

  it("TR-1. account trial unused + new customer → 7-day trial", async () => {
    model.stripe_customer_id = null;
    await post();
    expect(trialOf()).toBe(7);
  });

  it("TR-2. account trial unused + existing customer with no prior trial → 7-day trial", async () => {
    state.history = [{ id: "sub_A", status: "canceled", trial_start: null }];
    await post();
    expect(trialOf()).toBe(7);
  });

  it("TR-3. account trial already used → no trial, paid checkout still opens", async () => {
    model.guard = { trial_used_at: Date.now() - 1, claim_token: null, claim_acquired_at: null, claim_expires_at: null, claim_session_id: null };
    const response = await post();
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(trialOf()).toBeUndefined();
    expect(lastSession().params.subscription_data).toEqual({ metadata: { tier: "birdie", supabase_user_id: USER } });
  });

  it("TR-4. same customer with a historical trial → no trial", async () => {
    state.history = [{ id: "sub_A", status: "canceled", trial_start: 1700000000 }];
    await post();
    expect(trialOf()).toBeUndefined();
  });

  it("TR-5. a new customer cannot bypass the account's recorded trial", async () => {
    model.stripe_customer_id = null;
    model.guard = { trial_used_at: Date.now() - 1, claim_token: null, claim_acquired_at: null, claim_expires_at: null, claim_session_id: null };
    await post();
    expect(state.customersCreated).toHaveLength(1);
    expect(trialOf()).toBeUndefined();
  });

  it("TR-6. a prior trial never blocks a paid, no-trial checkout", async () => {
    state.history = [{ id: "sub_A", status: "incomplete_expired", trial_start: 1700000000 }];
    const response = await post();
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
  });

  for (const status of ["active", "trialing", "past_due", "incomplete", "unpaid", "paused", "some_future_state"]) {
    it(`TR-7. an existing ${status} Stripe subscription blocks checkout and releases only this claim`, async () => {
      state.history = [{ id: "sub_A", status, trial_start: null }];
      const response = await post();
      expect(location(response)).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
      expect(state.sessionsCreated).toEqual([]);
      const begun = fnCalls("billing_begin_checkout").length;
      expect(begun).toBe(1);
      expect(fnCalls("billing_release_checkout")).toHaveLength(1);
      expect(model.guard?.claim_token).toBeNull();
    });
  }

  it("TR-8. history is listed with customer, status all, limit 100 and paged to the end", async () => {
    state.listPages = [
      { object: "list", data: [{ id: "sub_A", status: "canceled", trial_start: null }], has_more: true },
      { object: "list", data: [{ id: "sub_B", status: "canceled", trial_start: 1700000000 }], has_more: false },
    ];
    await post();
    expect(state.listCalls).toEqual([
      { customer: CUSTOMER, status: "all", limit: 100 },
      { customer: CUSTOMER, status: "all", limit: 100, starting_after: "sub_A" },
    ]);
    // The trial on page two removed the trial: the decision waited for every page.
    expect(trialOf()).toBeUndefined();
  });

  it("TR-9. a nonterminal subscription on a later page still blocks", async () => {
    state.listPages = [
      { object: "list", data: [{ id: "sub_A", status: "canceled", trial_start: null }], has_more: true },
      { object: "list", data: [{ id: "sub_B", status: "active", trial_start: null }], has_more: false },
    ];
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
  });

  it("TR-10. a history error, malformed page or inconsistent pagination fails closed and releases the claim", async () => {
    const BROKEN: (() => void)[] = [
      () => (state.listThrows = true),
      () => (state.listPages = [{ object: "list", data: [], has_more: true }]),
      () => (state.listPages = [{ object: "list", data: null, has_more: false }]),
      () => (state.listPages = [{ object: "list", data: [{ id: "sub_A", status: "canceled" }] }]),
      () =>
        (state.listPages = [
          { object: "list", data: [{ id: "sub_A", status: "canceled" }], has_more: true },
          { object: "list", data: [{ id: "sub_A", status: "canceled" }], has_more: true },
        ]),
    ];
    for (const breakIt of BROKEN) {
      model.guard = null;
      state.listThrows = false;
      state.listPages = [];
      state.rpcCalls = [];
      state.sessionsCreated = [];
      breakIt();
      expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(state.sessionsCreated).toEqual([]);
      expect(fnCalls("billing_release_checkout")).toHaveLength(1);
    }
  });

  it("TR-11. an abandoned or merely created Session consumes no trial", async () => {
    await post();
    expect(model.guard?.trial_used_at).toBeNull();
    // A second attempt after the first Session expires still gets the trial.
    state.stripeSessions.set("cs_TEST_1", "expired");
    model.guard!.claim_expires_at = Date.now() - 1;
    await post();
    expect(state.sessionsCreated).toHaveLength(2);
    expect((state.sessionsCreated[1].params.subscription_data as Record<string, unknown>).trial_period_days).toBe(7);
  });

  it("TR-12. the route never records trial usage; only the webhook writer does", () => {
    const src = code(CHECKOUT);
    expect(src).not.toMatch(/trial_used_at|trial_subscription_id|billing_apply_subscription_state/);
    expect(src).toContain("const trialEligible = !claim.trialUsed && !priorTrial;");
    expect(src).not.toMatch(/subscription_status|subscription_tier/);
  });
});

// ─── 28-31, 42, 44. Session create, alignment and attach safety ──────────────

describe("checkout — Session creation, expiry alignment and attach safety", () => {
  it("SE-1. the Session is created with exactly the server-held contract", async () => {
    await post({ plan: "eagle" });
    const { params, options } = lastSession();
    const token = fnCalls("billing_attach_checkout_session")[0].args.p_claim_token as string;
    expect(params).toEqual({
      customer: CUSTOMER,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PRICE.eagle, quantity: 1 }],
      subscription_data: { trial_period_days: 7, metadata: { tier: "eagle", supabase_user_id: USER } },
      client_reference_id: token,
      expires_at: params.expires_at,
      success_url: "https://www.swingpro-ai.com/dashboard?upgraded=true",
      cancel_url: "https://www.swingpro-ai.com/upgrade",
    });
    expect(options).toEqual({ idempotencyKey: `swingproai-checkout-v1:${token}` });
  });

  it("SE-2. the Session expires exactly when its claim does", async () => {
    await post();
    expect(lastSession().params.expires_at).toBe(Math.floor(model.guard!.claim_expires_at! / 1000));
  });

  it("SE-3. a Session outlives no claim: expires_at is never after claim_expires_at", async () => {
    await post();
    expect((lastSession().params.expires_at as number) * 1000).toBeLessThanOrEqual(model.guard!.claim_expires_at!);
  });

  it("SE-4. attach is called with the claim token and the created Session id", async () => {
    await post();
    expect(fnCalls("billing_attach_checkout_session")[0].args).toEqual({
      p_user_id: USER,
      p_claim_token: lastSession().params.client_reference_id,
      p_session_id: "cs_TEST_1",
    });
    expect(model.guard?.claim_session_id).toBe("cs_TEST_1");
  });

  it("SE-5. the route refuses to create a Session with under 1830 seconds left, releasing its own token", async () => {
    state.rpcOverride.billing_begin_checkout = () => ({
      data: {
        outcome: "claimed",
        claim_token: "00000000-0000-4000-8000-000000000777",
        claim_acquired_at: new Date().toISOString(),
        claim_expires_at: new Date(Date.now() + 1829 * 1000).toISOString(),
        claim_age_seconds: 271,
        claim_remaining_seconds: 1829,
        held_session_id: null,
        trial_used: false,
        stripe_customer_id: CUSTOMER,
      },
      error: null,
    });
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.sessionsCreated).toEqual([]);
    expect(fnCalls("billing_release_checkout").map((c) => c.args)).toEqual([
      { p_user_id: USER, p_claim_token: "00000000-0000-4000-8000-000000000777" },
    ]);
  });

  it("SE-6. exactly 1830 seconds left is enough", async () => {
    state.rpcOverride.billing_begin_checkout = () => ({
      data: {
        outcome: "claimed",
        claim_token: "00000000-0000-4000-8000-000000000778",
        claim_acquired_at: new Date().toISOString(),
        claim_expires_at: new Date(Date.now() + 1831 * 1000).toISOString(),
        claim_age_seconds: 0,
        claim_remaining_seconds: 1831,
        held_session_id: null,
        trial_used: false,
        stripe_customer_id: CUSTOMER,
      },
      error: null,
    });
    state.rpcOverride.billing_attach_checkout_session = () => ({ data: true, error: null });
    expect(location(await post())).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("SE-7. a failed attach expires the new Session and never returns its URL", async () => {
    state.rpcOverride.billing_attach_checkout_session = () => ({ data: false, error: null });
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(location(response)).not.toContain("checkout.stripe.com");
    expect(state.expireCalls).toEqual(["cs_TEST_1"]);
    expect(state.stripeSessions.get("cs_TEST_1")).toBe("expired");
  });

  it("SE-8. a failed attach releases the claim only after the Session is safely expired", async () => {
    state.rpcOverride.billing_attach_checkout_session = () => ({ data: false, error: null });
    await post();
    const order = state.log.filter((l) => l === "stripe:sessions.expire" || l === "rpc:billing_release_checkout");
    expect(order).toEqual(["stripe:sessions.expire", "rpc:billing_release_checkout"]);
  });

  it("SE-9. a failed attach whose expiry also fails still returns no URL and keeps the claim", async () => {
    state.rpcOverride.billing_attach_checkout_session = () => ({ data: null, error: { message: "db-secret-detail" } });
    state.expireThrows = true;
    state.retrieveThrows = true;
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
  });

  it("SE-10. an attach that throws is treated as failed", async () => {
    state.rpcOverride.billing_attach_checkout_session = () => {
      throw new Error("db-secret-detail");
    };
    const response = await post();
    expect(location(response)).not.toContain("checkout.stripe.com");
    expect(state.expireCalls).toEqual(["cs_TEST_1"]);
  });

  for (const [label, url] of [
    ["absent", null],
    ["off-domain", "https://evil.example/pay"],
    ["lookalike", "https://checkout.stripe.com.evil.example/pay"],
    ["http", "http://checkout.stripe.com/pay"],
  ] as [string, string | null][]) {
    it(`SE-11. an ${label} Session URL is never returned; the Session is expired first`, async () => {
      state.sessionUrl = url;
      const response = await post();
      expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(state.expireCalls).toEqual(["cs_TEST_1"]);
      expect(fnCalls("billing_attach_checkout_session")).toEqual([]);
      expect(fnCalls("billing_release_checkout")).toHaveLength(1);
    });
  }

  it("SE-12. a Session create error keeps the unattached claim for stale recovery, never releasing it", async () => {
    state.sessionCreateThrows = true;
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
    expect(model.guard?.claim_token).not.toBeNull();
  });

  it("SE-13. the Session idempotency key derives from the claim token only", async () => {
    await post({ plan: "par", idempotencyKey: "browser-key" });
    const token = lastSession().params.client_reference_id as string;
    expect(lastSession().options).toEqual({ idempotencyKey: `swingproai-checkout-v1:${token}` });
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("SE-14. success redirects 303 to the Stripe-hosted page with private, no-store", async () => {
    const response = await post();
    expect(response.status).toBe(303);
    expect(location(response)).toBe("https://checkout.stripe.com/c/pay/cs_TEST_1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

// ─── 44. Two checkout attempts against one account ────────────────────────────

describe("checkout — concurrent attempts under the frozen RPC contract", () => {
  it("CC-1. two simultaneous attempts create exactly one Session", async () => {
    const [a, b] = await Promise.all([post(), post()]);
    expect(state.sessionsCreated).toHaveLength(1);
    const locations = [location(a), location(b)];
    expect(locations.filter((l) => l === `${UPGRADE_URL}?checkout=in-progress`)).toHaveLength(1);
    expect(locations.filter((l) => l?.startsWith("https://checkout.stripe.com/"))).toHaveLength(1);
  });

  it("CC-2. a second attempt while the first Session is open is in-progress, not a second Session", async () => {
    await post();
    const second = await post();
    expect(location(second)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(state.sessionsCreated).toHaveLength(1);
  });

  it("CC-3. after the first Session expires a fresh claim and Session follow, under a new token", async () => {
    await post();
    const firstToken = lastSession().params.client_reference_id;
    state.stripeSessions.set("cs_TEST_1", "expired");
    await post();
    expect(state.sessionsCreated).toHaveLength(2);
    expect(lastSession().params.client_reference_id).not.toBe(firstToken);
    expect(lastSession().options.idempotencyKey).not.toBe(state.sessionsCreated[0].options.idempotencyKey);
  });

  it("CC-4. a completed first Session blocks a second purchase while the webhook catches up", async () => {
    await post();
    state.stripeSessions.set("cs_TEST_1", "complete");
    expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=processing`);
    expect(state.sessionsCreated).toHaveLength(1);
  });

  it("CC-5. a stale release cannot clear a newer claim (model contract)", async () => {
    const old = holdClaim({ ageSeconds: 600 });
    await post();
    const current = model.guard!.claim_token;
    expect(current).not.toBe(old);
    const result = GUARD_MODEL.billing_release_checkout({ p_user_id: USER, p_claim_token: old }) as { data: boolean };
    expect(result.data).toBe(false);
    expect(model.guard!.claim_token).toBe(current);
  });

  it("CC-6. release is always by the route's own token, never by user alone", () => {
    const src = code(CHECKOUT);
    const releases = src.match(/release\(admin, userId, [a-z.]+\)/gi) ?? [];
    expect(releases.length).toBeGreaterThan(0);
    for (const r of releases) expect(r).toBe("release(admin, userId, claim.token)");
    expect(src).toContain('admin.rpc("billing_release_checkout", { p_user_id: userId, p_claim_token: token })');
  });
});

// ─── Source contract and UI ───────────────────────────────────────────────────

describe("checkout — source contract", () => {
  const src = code(CHECKOUT);

  it("SC-1. freezes the claim timing constants", () => {
    expect(src).toContain("const CLAIM_TTL_SECONDS = 2100;");
    expect(src).toContain("const UNATTACHED_CLAIM_STALE_SECONDS = 180;");
    expect(src).toContain("const MIN_REMAINING_SECONDS_BEFORE_SESSION_CREATE = 1830;");
  });

  it("SC-2. the Origin check precedes auth, profile, RPC and Stripe", () => {
    const origin = src.indexOf('req.headers.get("origin") !== CANONICAL_ORIGIN');
    for (const later of ["resolveVerifiedAuth()", '.from("users")', "createAdminClient()", "new Stripe(", '"billing_begin_checkout"']) {
      expect(src.indexOf(later), later).toBeGreaterThan(origin);
    }
  });

  it("SC-3. the History, customer and Session creates each happen after the claim", () => {
    const claim = src.indexOf('"billing_begin_checkout"');
    for (const later of ["stripe.customers.create(", "await subscriptionHistory(stripe", "stripe.checkout.sessions.create("]) {
      expect(src.indexOf(later), later).toBeGreaterThan(claim);
    }
  });

  it("SC-4. logs nothing", () => {
    expect(src).not.toMatch(/console\./);
  });

  it("SC-5. nothing identifying reaches the response body or headers", async () => {
    state.history = [{ id: "sub_TEST_LEAK", status: "active", trial_start: null }];
    const blocked = await post();
    state.rpcOverride.billing_begin_checkout = () => ({ data: null, error: { message: "db-secret-detail cus_TEST_0001" } });
    const failed = await post();
    for (const response of [blocked, failed]) {
      const text = `${location(response)} ${await response.text()}`;
      for (const leak of [CUSTOMER, "sub_TEST_LEAK", "secret-detail", USER, "00000000-0000-4000"]) {
        expect(text).not.toContain(leak);
      }
    }
    expect(logged).toEqual([]);
  });
});

describe("checkout — button and Plan & Billing notices", () => {
  const button = code(BUTTON);
  const upgrade = code(UPGRADE);

  it("UI-1. the CheckoutButton is a plain POST form with one hidden plan field and no state-changing link", () => {
    expect(button).toContain('<form method="POST" action="/api/stripe/checkout"');
    expect(button).toContain('<input type="hidden" name="plan" value={plan} />');
    expect(button).toContain('<button type="submit"');
    expect(button).not.toMatch(/<a\b|href=|router|fetch\(|onClick/);
  });

  it("UI-2. the button carries no billing secret, identifier or trial flag", () => {
    expect(button).not.toMatch(/priceId|price_|customer|subscription|trial|claim|token|process\.env|STRIPE_/i);
  });

  it("UI-3. the button keeps the 44px minimum touch target", () => {
    expect(button).toContain("min-h-[44px]");
  });

  it("UI-4. the upgrade page carries every checkout notice, generically worded", () => {
    for (const key of ['"in-progress":', "processing:", '"existing-subscription":', "unavailable:", '"auth-unavailable":']) {
      expect(upgrade.slice(upgrade.indexOf("CHECKOUT_NOTICES"))).toContain(key);
    }
    const notices = upgrade.slice(upgrade.indexOf("const CHECKOUT_NOTICES"), upgrade.indexOf("};", upgrade.indexOf("const CHECKOUT_NOTICES")));
    expect(notices).not.toMatch(/cus_|sub_|cs_|token|session id|stripe error/i);
  });

  it("UI-5. only known notice keys render; an arbitrary query value renders nothing", () => {
    expect(upgrade).toContain('(typeof checkout === "string" ? CHECKOUT_NOTICES[checkout] ?? null : null)');
    expect(upgrade).not.toMatch(/\{checkout\}|\{searchParams\??\.checkout\}/);
  });

  it("UI-6. canceled resubscription behaviour is intact", () => {
    expect(upgrade).toContain("{!hasLiveSubscription && (");
    expect(upgrade).toContain("Your subscription has ended");
    expect(upgrade).toMatch(/LIVE_SUBSCRIPTION_STATUSES = \["active", "trialing", "past_due"\]/);
  });
});


// ─── Stale-owner customer link (Option B) ─────────────────────────────────────
// A claim owner can lose its claim while a Stripe call is in flight. It may
// leave a transient Stripe customer or Session behind, but it can never link
// the customer, attach or disclose a Session, or touch the successor claim.

describe("checkout — stale-owner customer link (Option B)", () => {
  /** Another request taking the claim over: a new token, as a CAS takeover writes it. */
  function successorTakesOver(): string {
    newClaim(model.guard!, 2100);
    return model.guard!.claim_token!;
  }
  const linkCalls = () => fnCalls("billing_link_checkout_customer");
  const linkResults = () => state.rpcResults.filter((r) => r.fn === "billing_link_checkout_customer").map((r) => r.result);
  const call = (fn: string, args: Record<string, unknown>) => GUARD_MODEL[fn](args) as { data: unknown; error: unknown };

  beforeEach(() => {
    model.stripe_customer_id = null;
  });

  it("SO-1. a stale owner cannot link after a takeover: in-progress, no Session", async () => {
    let successor = "";
    state.duringCustomerCreate = () => (successor = successorTakesOver());
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=in-progress`);
    expect(state.sessionsCreated).toEqual([]);
    expect(model.guard?.claim_token).toBe(successor);
  });

  it("SO-2. the stale link answer is lost", async () => {
    state.duringCustomerCreate = () => successorTakesOver();
    await post();
    expect(linkResults()).toEqual([{ data: "lost", error: null }]);
  });

  it("SO-3. the stale owner makes no durable customer write", async () => {
    state.duringCustomerCreate = () => successorTakesOver();
    await post();
    expect(model.stripe_customer_id).toBeNull();
    expect(state.directUserWrites).toBe(0);
  });

  it("SO-4. after a failed stale link the stale owner creates no Checkout Session", async () => {
    state.duringCustomerCreate = () => successorTakesOver();
    await post();
    expect(state.log).not.toContain("stripe:sessions.create");
    expect(state.log).not.toContain("stripe:subscriptions.list");
  });

  it("SO-5. the stale owner releases nothing, so the successor claim is untouched", async () => {
    let successor = "";
    state.duringCustomerCreate = () => (successor = successorTakesOver());
    await post();
    expect(fnCalls("billing_release_checkout")).toEqual([]);
    expect(model.guard?.claim_token).toBe(successor);
    // And a stale-token release, had it been sent, is a no-op.
    expect(call("billing_release_checkout", { p_user_id: USER, p_claim_token: "00000000-0000-4000-8000-000000000001" }).data).toBe(false);
    expect(model.guard?.claim_token).toBe(successor);
  });

  it("SO-6. the current token links a previously-null customer, server-side arguments only", async () => {
    await post({ plan: "birdie", customer: "cus_TEST_EVIL", claim_token: "00000000-0000-4000-8000-999999999999" });
    expect(linkCalls().map((c) => c.args)).toEqual([
      { p_user_id: USER, p_claim_token: "00000000-0000-4000-8000-000000000001", p_stripe_customer_id: "cus_TEST_NEW" },
    ]);
    expect(linkResults()).toEqual([{ data: "linked", error: null }]);
    expect(model.stripe_customer_id).toBe("cus_TEST_NEW");
    expect(lastSession().params.customer).toBe("cus_TEST_NEW");
  });

  it("SO-7. the same customer is idempotent for the current token", async () => {
    model.stripe_customer_id = null;
    const claimed = call("billing_begin_checkout", { p_user_id: USER, p_ttl_seconds: 2100 });
    const token = (claimed.data as { claim_token: string }).claim_token;
    const args = { p_user_id: USER, p_claim_token: token, p_stripe_customer_id: "cus_TEST_NEW" };
    expect(call("billing_link_checkout_customer", args).data).toBe("linked");
    expect(call("billing_link_checkout_customer", args).data).toBe("already_linked_same");
    expect(model.stripe_customer_id).toBe("cus_TEST_NEW");
  });

  it("SO-8. a different existing customer is a conflict and is never overwritten", async () => {
    // The claim answered NULL, but someone outside the protocol linked another.
    state.duringCustomerCreate = () => (model.stripe_customer_id = "cus_TEST_OTHER");
    const response = await post();
    expect(linkResults()).toEqual([{ data: "customer_conflict", error: null }]);
    expect(model.stripe_customer_id).toBe("cus_TEST_OTHER");
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.sessionsCreated).toEqual([]);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
  });

  it("SO-9. an expired claim cannot link", () => {
    const token = holdClaim({ ageSeconds: 2200 });
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: token, p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("lost");
    expect(model.stripe_customer_id).toBeNull();
  });

  it("SO-10. a claim with an attached Session cannot link", () => {
    const token = holdClaim({ ageSeconds: 10, sessionId: "cs_TEST_HELD" });
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: token, p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("lost");
    expect(model.stripe_customer_id).toBeNull();
  });

  it("SO-11. a locally ineligible status blocks the link; the route answers existing-subscription and releases nothing", async () => {
    state.duringCustomerCreate = () => (model.subscription_status = "trialing");
    const response = await post();
    expect(linkResults()).toEqual([{ data: "blocked", error: null }]);
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
    expect(model.stripe_customer_id).toBeNull();
  });

  it("SO-12. a bound subscription blocks the link", () => {
    const token = holdClaim({ ageSeconds: 10 });
    model.stripe_subscription_id = "sub_TEST_BOUND";
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: token, p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("blocked");
  });

  it("SO-13. a missing profile is not_found; the route answers generic unavailable", async () => {
    state.duringCustomerCreate = () => (model.exists = false);
    const response = await post();
    expect(linkResults()).toEqual([{ data: "not_found", error: null }]);
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.sessionsCreated).toEqual([]);
  });

  it("SO-14. a missing guard row is lost", () => {
    model.guard = null;
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: "00000000-0000-4000-8000-000000000001", p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("lost");
  });

  it("SO-15. an empty customer id is refused: the model errors and the route never links it", async () => {
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: "x", p_stripe_customer_id: "" }).error).toEqual({ code: "22023", message: "PRICING1-LINK-1" });
    for (const bad of ["", null, 42]) {
      model.guard = null;
      state.rpcCalls = [];
      state.sessionsCreated = [];
      state.customerId = bad;
      expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(linkCalls()).toEqual([]);
      expect(state.sessionsCreated).toEqual([]);
    }
  });

  it("SO-16. a customer already linked to another account fails closed with nothing written", async () => {
    model.otherAccountCustomers = ["cus_TEST_NEW"];
    const response = await post();
    expect(linkResults()).toEqual([{ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }]);
    expect(model.stripe_customer_id).toBeNull();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
    expect(state.sessionsCreated).toEqual([]);
    expect(fnCalls("billing_release_checkout")).toEqual([]);
  });

  it("SO-17. begin's claimed answer carries the current durable customer", () => {
    model.stripe_customer_id = "cus_TEST_DURABLE";
    const claimed = call("billing_begin_checkout", { p_user_id: USER, p_ttl_seconds: 2100 }).data as Record<string, unknown>;
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.stripe_customer_id).toBe("cus_TEST_DURABLE");
    const held = call("billing_begin_checkout", { p_user_id: USER, p_ttl_seconds: 2100 }).data as Record<string, unknown>;
    expect(held.outcome).toBe("held");
    expect("stripe_customer_id" in held).toBe(false);
  });

  it("SO-18. takeover's claimed answer carries the current durable customer", () => {
    const old = holdClaim({ ageSeconds: 600 });
    model.stripe_customer_id = "cus_TEST_DURABLE";
    const taken = call("billing_takeover_checkout", {
      p_user_id: USER,
      p_old_claim_token: old,
      p_expected_session_id: null,
      p_ttl_seconds: 2100,
    }).data as Record<string, unknown>;
    expect(taken.outcome).toBe("claimed");
    expect(taken.stripe_customer_id).toBe("cus_TEST_DURABLE");
  });

  it("SO-19. the pre-claim profile snapshot is not customer authority", async () => {
    state.profile = { full_name: null, stripe_customer_id: "cus_TEST_FORGED" };
    await post();
    expect(lastSession().params.customer).toBe("cus_TEST_NEW");
    expect(code(CHECKOUT)).toContain('.select("full_name")');
    expect(code(CHECKOUT)).not.toMatch(/profile\??\.stripe_customer_id/);
  });

  it("SO-20. a customer linked by the previous owner is returned to the successor's takeover", async () => {
    const old = holdClaim({ ageSeconds: 200 });
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: old, p_stripe_customer_id: "cus_TEST_C1" }).data).toBe("linked");
    await post();
    const taken = state.rpcResults.find((r) => r.fn === "billing_takeover_checkout")?.result as { data: Record<string, unknown> };
    expect(taken.data.outcome).toBe("claimed");
    expect(taken.data.stripe_customer_id).toBe("cus_TEST_C1");
  });

  it("SO-21. the successor reuses that customer instead of creating a second one", async () => {
    const old = holdClaim({ ageSeconds: 200 });
    call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: old, p_stripe_customer_id: "cus_TEST_C1" });
    const response = await post();
    expect(state.customersCreated).toEqual([]);
    expect(linkCalls()).toEqual([]);
    expect(lastSession().params.customer).toBe("cus_TEST_C1");
    expect(location(response)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("SO-22. no direct public.users customer write exists in the route or happens at runtime", async () => {
    await post();
    expect(state.directUserWrites).toBe(0);
    const src = code(CHECKOUT);
    expect(src).not.toMatch(/\.from\("users"\)\s*\.update\(/);
    expect(src).not.toMatch(/\.update\(\{\s*stripe_customer_id/);
    expect(src).toContain('admin.rpc("billing_link_checkout_customer", {');
  });

  it("SO-23. history and Session creation happen only after the link is confirmed", async () => {
    await post();
    const link = state.log.indexOf("rpc:billing_link_checkout_customer");
    expect(link).toBeGreaterThan(state.log.indexOf("stripe:customers.create"));
    expect(state.log.indexOf("stripe:subscriptions.list")).toBeGreaterThan(link);
    expect(state.log.indexOf("stripe:sessions.create")).toBeGreaterThan(link);
  });

  it("SO-24. a link error, throw or unknown answer creates no Session and discloses nothing", async () => {
    const BROKEN: (() => unknown)[] = [
      () => ({ data: null, error: { message: "db-secret-detail cus_TEST_NEW" } }),
      () => ({ data: "weird", error: null }),
      () => ({ data: true, error: null }),
      () => {
        throw new Error("db-secret-detail cus_TEST_NEW");
      },
    ];
    for (const broken of BROKEN) {
      model.guard = null;
      state.rpcCalls = [];
      state.sessionsCreated = [];
      state.rpcOverride = { billing_link_checkout_customer: broken };
      const response = await post();
      const text = `${location(response)} ${await response.text()}`;
      expect(location(response)).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      for (const leak of ["cus_TEST_NEW", "secret-detail", USER, "00000000-0000-4000"]) expect(text).not.toContain(leak);
      expect(state.sessionsCreated).toEqual([]);
      expect(fnCalls("billing_release_checkout")).toEqual([]);
    }
    expect(logged).toEqual([]);
  });

  it("SO-25. Option B: a stale owner that reaches Stripe Session creation can't attach, disclose or touch the successor", async () => {
    model.stripe_customer_id = CUSTOMER;
    let successor = "";
    state.duringSessionCreate = () => (successor = successorTakesOver());
    const response = await post();
    // The Session exists at Stripe for a moment, but it is never usable.
    expect(state.sessionsCreated).toHaveLength(1);
    expect(fnCalls("billing_attach_checkout_session").map((c) => state.rpcResults.find((r) => r.fn === c.fn)?.result)).toEqual([
      { data: false, error: null },
    ]);
    expect(location(response)).not.toContain("checkout.stripe.com");
    expect(state.expireCalls).toEqual(["cs_TEST_1"]);
    expect(state.stripeSessions.get("cs_TEST_1")).toBe("expired");
    expect(model.guard?.claim_token).toBe(successor);
    expect(model.guard?.claim_session_id).toBeNull();
  });

  it("SO-26. claim age past 180 s alone does not invalidate the current token", () => {
    const token = holdClaim({ ageSeconds: 200 });
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: token, p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("linked");
  });

  it("SO-27. a newly linked customer replayed with a past trial gets no trial", async () => {
    state.history = [{ id: "sub_TEST_OLD", status: "canceled", trial_start: 1700000000 }];
    await post();
    expect(state.customersCreated).toHaveLength(1);
    expect((lastSession().params.subscription_data as Record<string, unknown>).trial_period_days).toBeUndefined();
  });

  it("SO-28. a newly linked customer replayed with a live subscription blocks and releases only its claim", async () => {
    state.history = [{ id: "sub_TEST_LIVE", status: "active", trial_start: null }];
    const response = await post();
    expect(location(response)).toBe(`${UPGRADE_URL}?checkout=existing-subscription`);
    expect(state.sessionsCreated).toEqual([]);
    expect(fnCalls("billing_release_checkout").map((c) => c.args.p_claim_token)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("SO-29. a claimed answer with a missing or malformed customer field fails closed", async () => {
    const claimed = (customer: Record<string, unknown>) => () => ({
      data: {
        outcome: "claimed",
        claim_token: "00000000-0000-4000-8000-000000000555",
        claim_acquired_at: new Date().toISOString(),
        claim_expires_at: new Date(Date.now() + 2100 * 1000).toISOString(),
        claim_age_seconds: 0,
        claim_remaining_seconds: 2100,
        held_session_id: null,
        trial_used: false,
        ...customer,
      },
      error: null,
    });
    for (const customer of [{}, { stripe_customer_id: "" }, { stripe_customer_id: 42 }, { stripe_customer_id: {} }]) {
      state.log = [];
      state.rpcOverride = { billing_begin_checkout: claimed(customer) };
      expect(location(await post())).toBe(`${UPGRADE_URL}?checkout=unavailable`);
      expect(state.log.filter((l) => l.startsWith("stripe:"))).toEqual([]);
    }
  });

  it("SO-30. the stale-owner customer stays an unlinked external orphan", async () => {
    let successor = "";
    state.duringCustomerCreate = () => (successor = successorTakesOver());
    await post();
    expect(state.customersCreated).toHaveLength(1);
    expect(model.stripe_customer_id).toBeNull();
    // The successor can still link the account's customer with its own token.
    expect(call("billing_link_checkout_customer", { p_user_id: USER, p_claim_token: successor, p_stripe_customer_id: "cus_TEST_NEW" }).data).toBe("linked");
  });
});
