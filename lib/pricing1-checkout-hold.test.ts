import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
// Next compiles the same page with the automatic runtime, so the page itself
// does not import it.
(globalThis as Record<string, unknown>).React = React;

// ============================================================================
// PRICING-1 — checkout hold
// ============================================================================
//
// New memberships are paused while membership claims and tier enforcement are
// corrected. The hold is the shipped value of lib/billing/checkout-availability
// (not mocked here): the checkout route runs for real against tripwire
// stand-ins for the verified-auth resolver, the server-only admin client and
// Stripe, and every one of them must stay untouched. The upgrade page is
// rendered for real against stand-ins for its session and profile reads.
//
// No network, no Stripe API, no database. Every identifier is synthetic.

const ORIGIN = "https://www.swingpro-ai.com";
const PAUSED = `${ORIGIN}/upgrade?checkout=paused`;

const state = vi.hoisted(() => ({
  /** Every downstream touch the route makes. Must stay empty while held. */
  log: [] as string[],
  auth: null as unknown,
  /** What the upgrade page's own profile read answers. */
  profile: {
    subscription_status: "none",
    subscription_tier: "none",
    role: "golfer",
    stripe_customer_id: null as string | null,
  } as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } }),
    redirect: (url: string | URL, init?: { status?: number }) =>
      new Response(null, { status: init?.status ?? 307, headers: { location: String(url) } }),
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveVerifiedAuth: async () => {
    state.log.push("auth");
    return state.auth;
  },
  getServerSession: async () => ({ user: { id: "user_TEST_0001" } }),
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { ...state.profile }, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.log.push("admin");
    return {
      rpc: async (fn: string) => {
        state.log.push(`rpc:${fn}`);
        return { data: null, error: null };
      },
      from: () => {
        state.log.push("admin:from");
        throw new Error("admin table access");
      },
    };
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    constructor() {
      state.log.push("stripe:new");
    }
    customers = {
      create: async () => {
        state.log.push("stripe:customers.create");
        return { id: "cus_TEST_NEW" };
      },
    };
    checkout = {
      sessions: {
        create: async () => {
          state.log.push("stripe:sessions.create");
          return { id: "cs_TEST_1", url: "https://checkout.stripe.com/c/pay/cs_TEST_1" };
        },
        retrieve: async () => {
          state.log.push("stripe:sessions.retrieve");
          return {};
        },
        expire: async () => {
          state.log.push("stripe:sessions.expire");
          return {};
        },
      },
    };
    subscriptions = {
      list: async () => {
        state.log.push("stripe:subscriptions.list");
        return { object: "list", data: [], has_more: false };
      },
    };
  },
}));

import { CHECKOUT_AVAILABLE } from "@/lib/billing/checkout-availability";
import { POST } from "@/app/api/stripe/checkout/route";
import UpgradePage from "@/app/(dashboard)/upgrade/page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

const HOLD = "lib/billing/checkout-availability.ts";
const CHECKOUT = "app/api/stripe/checkout/route.ts";
const UPGRADE = "app/(dashboard)/upgrade/page.tsx";
const HOME = "app/page.tsx";
const SIGNUP = "app/(auth)/signup/page.tsx";
const ANALYZE = "app/(dashboard)/analyze/page.tsx";
const PORTAL = "app/api/stripe/portal/route.ts";
const WEBHOOK = "app/api/webhooks/stripe/route.ts";

const PAUSED_MESSAGE =
  "New memberships are temporarily paused while we update our plans. Your free account, swing analysis, and history are unaffected.";

function cookieAuth(userId = "user_TEST_0001") {
  return {
    status: "authenticated",
    userId,
    email: "golfer@example.test",
    source: "cookie",
    client: {
      from: () => {
        state.log.push("profile");
        throw new Error("profile read");
      },
    },
  };
}

async function post(fields: Record<string, string>, origin: string | null = ORIGIN): Promise<Response> {
  const h = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin !== null) h.set("origin", origin);
  return POST(
    new Request(`${ORIGIN}/api/stripe/checkout`, { method: "POST", headers: h, body: new URLSearchParams(fields) }) as never,
  );
}

async function renderUpgrade(checkout?: string): Promise<string> {
  const element = await UpgradePage({ searchParams: checkout === undefined ? {} : { checkout } });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  state.log = [];
  state.auth = cookieAuth();
  state.profile = { subscription_status: "none", subscription_tier: "none", role: "golfer", stripe_customer_id: null };
  process.env.STRIPE_SECRET_KEY = "test-stripe-secret-not-real";
  process.env.STRIPE_PAR_PRICE_ID = "price_TEST_PAR";
  process.env.STRIPE_BIRDIE_PRICE_ID = "price_TEST_BIRDIE";
  process.env.STRIPE_EAGLE_PRICE_ID = "price_TEST_EAGLE";
});

// ─── The availability switch ──────────────────────────────────────────────────

describe("checkout hold — the switch", () => {
  it("HOLD-1. checkout is unavailable in the shipped code", () => {
    expect(CHECKOUT_AVAILABLE).toBe(false);
  });

  it("HOLD-2. the switch is a code constant with no override of any kind", () => {
    const src = code(HOLD);
    expect(src).toContain("export const CHECKOUT_AVAILABLE = false as const;");
    expect(src.match(/export /g)).toHaveLength(1);
    expect(src).not.toMatch(/process\.env|import |header|cookie|role|admin|function|=>/i);
  });

  it("HOLD-3. the route consults the switch once, with no bypass beside it", () => {
    const src = code(CHECKOUT);
    expect(src).toContain('import { CHECKOUT_AVAILABLE } from "@/lib/billing/checkout-availability";');
    expect(src.match(/CHECKOUT_AVAILABLE/g)).toHaveLength(2);
    expect(src).toContain('if (!CHECKOUT_AVAILABLE) return notice("paused");');
  });
});

// ─── Server-side hold ─────────────────────────────────────────────────────────

describe("checkout hold — the route fails closed", () => {
  const CASES: [string, () => void, Record<string, string>][] = [
    ["A. a signed-out visitor", () => (state.auth = { status: "absent" }), { plan: "par" }],
    ["B. a signed-in golfer", () => (state.auth = cookieAuth()), { plan: "birdie" }],
    ["C. an invalid plan selection", () => (state.auth = cookieAuth()), { plan: "coach_pro" }],
    ["C. a missing plan selection", () => (state.auth = cookieAuth()), {}],
    ["an administrator", () => (state.auth = cookieAuth("user_TEST_ADMIN")), { plan: "eagle" }],
    ["an auth outage", () => (state.auth = { status: "verification_unavailable" }), { plan: "par" }],
  ];

  for (const [label, setup, fields] of CASES) {
    it(`${label}: 303 to the paused notice with zero billing side effects`, async () => {
      setup();
      const response = await post(fields);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(PAUSED);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      // No auth resolution, profile read, admin client, RPC, Stripe client,
      // customer, history read or Session.
      expect(state.log).toEqual([]);
    });
  }

  it("the paused redirect discloses nothing", async () => {
    const response = await post({ plan: "birdie" });
    expect(await response.text()).toBe("");
    expect(response.headers.get("location")).not.toMatch(/cus_|sub_|cs_|user_|price_/);
  });

  const REJECTED: [string, string | null][] = [
    ["cross-site", "https://evil.example"],
    ["missing", null],
    ["apex", "https://swingpro-ai.com"],
    ["vercel.app", "https://swing-pro-ai.vercel.app"],
  ];
  for (const [label, origin] of REJECTED) {
    it(`D. a ${label} Origin is still 403, before the hold and before any billing work`, async () => {
      const response = await post({ plan: "par" }, origin);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
      expect(state.log).toEqual([]);
    });
  }
});

describe("checkout hold — E. guard ordering", () => {
  const src = code(CHECKOUT);
  const origin = src.indexOf('req.headers.get("origin") !== CANONICAL_ORIGIN');
  const hold = src.indexOf('if (!CHECKOUT_AVAILABLE) return notice("paused");');

  it("the hold follows the Origin check and nothing else", () => {
    expect(origin).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(origin);
    const between = src.slice(src.indexOf("return forbidden();", origin) + "return forbidden();".length, hold);
    expect(between.trim()).toBe("");
  });

  it("the hold precedes every billing-related operation", () => {
    for (const later of [
      "await resolveVerifiedAuth()",
      "req.formData()",
      "resolveStripePlan(selector)",
      'process.env.STRIPE_SECRET_KEY',
      '.from("users")',
      "createAdminClient()",
      "new Stripe(secretKey)",
      '"billing_begin_checkout"',
      '"billing_takeover_checkout"',
      "stripe.customers.create(",
      "linkCustomer(admin",
      "await subscriptionHistory(stripe",
      "stripe.checkout.sessions.create(",
      '"billing_attach_checkout_session"',
    ]) {
      const at = src.indexOf(later, src.indexOf("export async function POST"));
      expect(at, later).toBeGreaterThan(hold);
    }
  });

  it("the paused notice uses the existing safe redirect helper", () => {
    expect(src).toContain("function notice(checkout: string): NextResponse {");
    expect(src).toContain("return seeOther(`${UPGRADE_URL}?checkout=${checkout}`);");
  });
});

// ─── Membership presentation ──────────────────────────────────────────────────

describe("checkout hold — F. membership page while paused", () => {
  it("renders no form or control that can start checkout", async () => {
    const html = await renderUpgrade();
    expect(html).not.toContain("/api/stripe/checkout");
    expect(html).not.toMatch(/name="plan"/);
    expect(html).not.toMatch(/Get (Par|Birdie|Eagle)/);
    expect(html.match(/Temporarily unavailable/g)).toHaveLength(3);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  });

  it("shows the approved availability message as an accessible status", async () => {
    const html = await renderUpgrade();
    expect(html).toContain(`role="status"`);
    expect(html).toContain(PAUSED_MESSAGE);
  });

  it("keeps the three plans and their launch prices", async () => {
    const html = await renderUpgrade();
    for (const text of ["Par", "Birdie", "Eagle", "$7.99", "$14.99", "$24.99"]) expect(html).toContain(text);
    expect(html.match(/\/ month/g)).toHaveLength(3);
  });

  it("supports the paused checkout notice, and only known notice keys render", async () => {
    const paused = await renderUpgrade("paused");
    expect(paused).toContain("Checkout did not start: new memberships are paused. You have not been charged.");
    const unknown = await renderUpgrade("<script>x</script>");
    expect(unknown).not.toContain("<script>x</script>");
  });

  it("does not tell an administrator that checkout links are live", async () => {
    state.profile = { ...state.profile, role: "admin" };
    const html = await renderUpgrade();
    expect(html).not.toContain("Checkout links are live Stripe sessions");
    expect(html).not.toContain("/api/stripe/checkout");
  });

  it("keeps Manage billing for an eligible existing subscriber, posting to the portal", async () => {
    state.profile = { subscription_status: "active", subscription_tier: "birdie", role: "golfer", stripe_customer_id: "cus_TEST_0001" };
    const html = await renderUpgrade();
    expect(html).toContain('action="/api/stripe/portal"');
    expect(html).toContain("Manage billing");
    expect(html).not.toContain("cus_TEST_0001");
    expect(html).not.toContain("/api/stripe/checkout");
  });

  it("keeps the canceled-subscriber view: Manage billing plus unavailable plan cards", async () => {
    state.profile = { subscription_status: "canceled", subscription_tier: "none", role: "golfer", stripe_customer_id: "cus_TEST_0001" };
    const html = await renderUpgrade();
    expect(html).toContain("Your subscription has ended");
    expect(html).toContain('action="/api/stripe/portal"');
    expect(html.match(/Temporarily unavailable/g)).toHaveLength(3);
    expect(html).not.toContain("/api/stripe/checkout");
  });
});

// ─── Unsupported claims ───────────────────────────────────────────────────────

describe("checkout hold — G. unsupported membership claims are gone", () => {
  const BANNED: [string, RegExp][] = [
    ["five analyses per month", /5 AI-powered video analyses|analyses per month/i],
    ["unlimited analyses as a plan benefit", /unlimited swing/i],
    ["USGA-compliant handicap", /USGA-compliant/i],
    ["FIR/GIR/putts analytics", /\bFIR\b|\bGIR\b|putts per round/],
    ["most popular", /Most Popular|popular: true/i],
    ["3D putting engine", /3D putting/i],
    ["LiDAR / ARCore", /LiDAR|ARCore/i],
    ["green undulation heatmaps", /undulation|heatmap/i],
    ["real-time AI caddy", /AI caddy|caddie|caddy suggestions/i],
    ["predictive club and aim suggestions", /predictive club/i],
    ["AR smart glasses / OpenXR", /smart glasses|OpenXR/i],
    ["launch monitor fusion", /launch monitor fusion/i],
  ];

  it("the rendered membership page carries none of them", async () => {
    const html = await renderUpgrade();
    for (const [label, pattern] of BANNED) expect(html, label).not.toMatch(pattern);
    expect(html).not.toMatch(/7-day free trial|card is required/i);
  });

  for (const rel of [UPGRADE, HOME, SIGNUP]) {
    it(`${rel} source carries none of them`, () => {
      const src = read(rel);
      for (const [label, pattern] of BANNED) expect(src, label).not.toMatch(pattern);
    });
  }

  it("signup no longer promotes a trial or card terms while checkout is paused", () => {
    expect(read(SIGNUP)).not.toMatch(/7-day|free trial|card required/i);
  });

  it("the analyze upsell no longer sells unlimited swings or launch-monitor fusion as Birdie benefits", () => {
    const src = read(ANALYZE);
    expect(src).not.toContain("Get advanced biomechanics, launch monitor fusion, and unlimited swings with Birdie.");
    expect(src).toContain("AI putting analysis is included with Birdie and Eagle.");
  });

  it("the membership page lists only server-gated capabilities as plan benefits", () => {
    const src = code(UPGRADE);
    expect(src).toContain('features: ["AI putting stroke analysis", "Putting practice suggestions"],');
    expect(src).toContain('features: ["Everything in Birdie"],');
    expect(src).toContain("features: [] as string[],");
  });
});

// ─── Portal and webhook ───────────────────────────────────────────────────────

describe("checkout hold — H. billing portal and webhook are not part of the hold", () => {
  it("neither route reads the checkout switch", () => {
    for (const rel of [PORTAL, WEBHOOK]) expect(read(rel), rel).not.toContain("checkout-availability");
  });

  it("the portal still binds the dedicated configuration for eligible customers", () => {
    const src = code(PORTAL);
    expect(src).toContain("const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;");
    expect(src).toContain("canManageBilling(customerId, profile.subscription_status)");
  });

  it("the webhook still verifies the signature and writes through the approved RPC", () => {
    const src = code(WEBHOOK);
    expect(src).toContain("stripe.webhooks.constructEvent(body, sig, webhookSecret)");
    expect(src).toContain('"billing_apply_subscription_state"');
  });
});
