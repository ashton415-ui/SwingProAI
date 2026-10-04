import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// PI-1A — Practice Intelligence entitlement contract
// ============================================================================
//
// A. the central policy helper, as a full tier × status matrix;
// B. the server-side access authority, against a recording stand-in client;
// C. the structural boundary: server-only, caller-scoped, no policy in routes;
// D. /me parity: effective availability = server flag AND the same helper.
//
// Synthetic identifiers only. Nothing here touches a live database.

// `server-only` throws outside a Next.js server context; Vitest is not one.
vi.mock("server-only", () => ({}));

import { canUsePracticeIntelligence } from "@/lib/entitlements";
import {
  PRACTICE_ACCESS_COLUMNS,
  PRACTICE_ACCESS_UNAVAILABLE_MESSAGE,
  PRACTICE_ENTITLEMENT_MESSAGE,
  requirePracticeAccess,
  resolvePracticeAccess,
} from "@/lib/practice-entitlement-authority";
import { toMeResponse, type MeProfileRow } from "@/lib/api/me-dto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

const CALLER_ID = "0a000000-0000-4000-8000-000000000001";

const ALLOWED_TIERS = ["birdie", "eagle", "coach_starter", "coach_pro"] as const;
const ALLOWED_STATUSES = ["active", "trialing"] as const;
const DENIED_TIERS: unknown[] = ["par", "none", "platinum", "Birdie", " birdie", "", null, undefined, 3, {}, ["birdie"]];
const DENIED_STATUSES: unknown[] = ["past_due", "canceled", "none", "unpaid", "paused", "incomplete", "Active", "", null, undefined, true, {}];

// ─── A. Policy matrix ─────────────────────────────────────────────────────────

describe("A. canUsePracticeIntelligence — tier × status", () => {
  it("allows every allowed tier with every allowed status (8 combinations)", () => {
    for (const tier of ALLOWED_TIERS) {
      for (const status of ALLOWED_STATUSES) {
        expect(canUsePracticeIntelligence(tier, status), `${tier}/${status}`).toBe(true);
      }
    }
  });

  it("denies every allowed tier with any denied or malformed status", () => {
    for (const tier of ALLOWED_TIERS) {
      for (const status of DENIED_STATUSES) {
        expect(canUsePracticeIntelligence(tier, status), `${tier}/${String(status)}`).toBe(false);
      }
    }
  });

  it("denies every denied or malformed tier, even with an allowed status", () => {
    for (const tier of DENIED_TIERS) {
      for (const status of ALLOWED_STATUSES) {
        expect(canUsePracticeIntelligence(tier, status), `${String(tier)}/${status}`).toBe(false);
      }
    }
  });

  it("denies when both are denied or missing", () => {
    expect(canUsePracticeIntelligence(undefined, undefined)).toBe(false);
    expect(canUsePracticeIntelligence(null, null)).toBe(false);
    expect(canUsePracticeIntelligence("none", "none")).toBe(false);
    expect(canUsePracticeIntelligence("par", "past_due")).toBe(false);
  });
});

// ─── B. Server-side authority ─────────────────────────────────────────────────

interface Recorded {
  table: string | null;
  columns: string | null;
  filters: [string, unknown][];
  terminal: string | null;
  writes: string[];
}

function fakeCaller(answer: () => Promise<{ data: unknown; error: unknown }> | never) {
  const rec: Recorded = { table: null, columns: null, filters: [], terminal: null, writes: [] };
  const query = {
    select(columns: string) {
      rec.columns = columns;
      return query;
    },
    eq(column: string, value: unknown) {
      rec.filters.push([column, value]);
      return query;
    },
    maybeSingle() {
      rec.terminal = "maybeSingle";
      return answer();
    },
    insert: () => (rec.writes.push("insert"), query),
    update: () => (rec.writes.push("update"), query),
    upsert: () => (rec.writes.push("upsert"), query),
    delete: () => (rec.writes.push("delete"), query),
  };
  const client = {
    from(table: string) {
      rec.table = table;
      return query;
    },
    rpc: () => {
      rec.writes.push("rpc");
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { caller: { userId: CALLER_ID, client } as never, rec };
}

const row = (tier: unknown, status: unknown) => async () => ({
  data: { subscription_tier: tier, subscription_status: status },
  error: null,
});

describe("B. resolvePracticeAccess — the caller's own row, narrowly", () => {
  it("reads exactly subscription_tier and subscription_status of the verified caller's own row", async () => {
    const { caller, rec } = fakeCaller(row("birdie", "active"));
    await resolvePracticeAccess(caller);
    expect(rec).toEqual({
      table: "users",
      columns: "subscription_tier, subscription_status",
      filters: [["id", CALLER_ID]],
      terminal: "maybeSingle",
      writes: [],
    });
    expect(PRACTICE_ACCESS_COLUMNS).toBe("subscription_tier, subscription_status");
  });

  it("classifies allowed and denied memberships through the central helper", async () => {
    for (const tier of ALLOWED_TIERS) {
      for (const status of ALLOWED_STATUSES) {
        expect(await resolvePracticeAccess(fakeCaller(row(tier, status)).caller)).toEqual({ status: "allowed" });
      }
    }
    for (const [tier, status] of [
      ["par", "active"],
      ["none", "none"],
      ["eagle", "past_due"],
      ["birdie", "canceled"],
      ["platinum", "active"],
      ["coach_pro", "paused"],
      [null, "active"],
      ["eagle", undefined],
    ]) {
      expect(await resolvePracticeAccess(fakeCaller(row(tier, status)).caller), `${tier}/${status}`).toEqual({
        status: "denied",
      });
    }
  });

  it("ignores role entirely: an admin or coach on no plan is denied", async () => {
    const { caller } = fakeCaller(async () => ({
      data: { role: "admin", subscription_tier: "none", subscription_status: "none" },
      error: null,
    }));
    expect(await resolvePracticeAccess(caller)).toEqual({ status: "denied" });
  });

  it("is unavailable — never denied — when the read errors, throws or finds no row", async () => {
    const cases: (() => Promise<{ data: unknown; error: unknown }>)[] = [
      async () => ({ data: null, error: { code: "XX000", message: "down" } }),
      async () => {
        throw new Error("socket hang up");
      },
      async () => ({ data: null, error: null }),
    ];
    for (const answer of cases) {
      const { caller, rec } = fakeCaller(answer);
      expect(await resolvePracticeAccess(caller)).toEqual({ status: "unavailable" });
      expect(rec.writes).toEqual([]);
    }
  });

  it("requirePracticeAccess: null when allowed, fixed 403 when denied, fixed 503 when unavailable", async () => {
    expect(await requirePracticeAccess(fakeCaller(row("eagle", "trialing")).caller, "req-00000001")).toBeNull();

    const denied = (await requirePracticeAccess(fakeCaller(row("par", "active")).caller, "req-00000002"))!;
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await denied.json()).toEqual({
      error: { code: "ENTITLEMENT_REQUIRED", message: PRACTICE_ENTITLEMENT_MESSAGE, requestId: "req-00000002" },
    });
    expect(PRACTICE_ENTITLEMENT_MESSAGE).toBe("Practice Intelligence isn't available with your current membership.");

    const unavailable = (await requirePracticeAccess(
      fakeCaller(async () => ({ data: null, error: { message: "secret-detail" } })).caller,
      "req-00000003",
    ))!;
    expect(unavailable.status).toBe(503);
    const body = await unavailable.json();
    expect(body).toEqual({
      error: {
        code: "SERVER_TEMPORARILY_UNAVAILABLE",
        message: PRACTICE_ACCESS_UNAVAILABLE_MESSAGE,
        requestId: "req-00000003",
      },
    });
    expect(PRACTICE_ACCESS_UNAVAILABLE_MESSAGE).toBe("Practice access is temporarily unavailable. Please retry.");
    expect(JSON.stringify(body)).not.toContain("secret-detail");
  });
});

// ─── C. Structural boundary ───────────────────────────────────────────────────

const AUTHORITY = "lib/practice-entitlement-authority.ts";
const ROUTES = [
  "app/api/v1/practice/plans/route.ts",
  "app/api/v1/practice/plans/[planId]/route.ts",
  "app/api/v1/practice/plans/[planId]/archive/route.ts",
  "app/api/v1/practice/sessions/route.ts",
  "app/api/v1/practice/sessions/[sessionId]/route.ts",
  "app/api/v1/practice/sessions/[sessionId]/results/route.ts",
  "app/api/v1/practice/sessions/[sessionId]/complete/route.ts",
];

describe("C. structural boundary", () => {
  it("the authority's first import is server-only", () => {
    expect(read(AUTHORITY).trimStart().startsWith('import "server-only";')).toBe(true);
  });

  it("the authority uses the caller-scoped client only and never writes", () => {
    const code = stripComments(read(AUTHORITY));
    expect(code).not.toMatch(/createAdminClient|@\/utils\/supabase\/admin|SUPABASE_SERVICE_ROLE_KEY|service_role/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(code).toContain("caller.client");
    expect(code).toContain('.eq("id", caller.userId)');
  });

  it("the authority delegates the decision to the central helper and names no tier or status", () => {
    const code = stripComments(read(AUTHORITY));
    expect(code).toContain('import { canUsePracticeIntelligence } from "@/lib/entitlements";');
    expect(code).not.toMatch(/"(birdie|eagle|coach_starter|coach_pro|par|active|trialing|past_due|canceled)"/);
  });

  it("all nine handlers consume the authority; no route restates the policy", () => {
    let handlerCount = 0;
    for (const file of ROUTES) {
      const code = stripComments(read(file));
      expect(code, file).toContain('import { requirePracticeAccess } from "@/lib/practice-entitlement-authority";');
      const handlers = code.split(/export async function (?:GET|POST)\b/).slice(1);
      handlerCount += handlers.length;
      for (const handler of handlers) {
        expect(handler, file).toContain("await requirePracticeAccess(auth, requestId)");
      }
      expect(code, file).not.toMatch(/"(birdie|eagle|coach_starter|coach_pro|par|trialing|past_due|canceled)"/);
      expect(code, file).not.toMatch(/canUsePracticeIntelligence|subscription_(tier|status)|@\/lib\/entitlements/);
    }
    expect(handlerCount).toBe(9);
  });
});

// ─── D. /me parity ────────────────────────────────────────────────────────────

describe("D. /me practiceIntelligence = server flag AND central helper", () => {
  const caller = { userId: CALLER_ID, email: "golfer@example.test" };
  const profile = (tier: unknown, status: unknown): MeProfileRow => ({
    role: "golfer",
    subscription_tier: tier,
    subscription_status: status,
  });
  const me = (tier: unknown, status: unknown, on: boolean) =>
    toMeResponse(caller, profile(tier, status), new Date(), { practiceIntelligence: on }).entitlement.capabilities
      .practiceIntelligence;

  it("flag OFF + entitled → false", () => {
    for (const tier of ALLOWED_TIERS) for (const status of ALLOWED_STATUSES) expect(me(tier, status, false)).toBe(false);
  });

  it("flag ON + entitled → true", () => {
    for (const tier of ALLOWED_TIERS) for (const status of ALLOWED_STATUSES) expect(me(tier, status, true)).toBe(true);
  });

  it("flag ON + denied tier or status → false", () => {
    expect(me("par", "active", true)).toBe(false);
    expect(me("none", "trialing", true)).toBe(false);
    expect(me("eagle", "past_due", true)).toBe(false);
    expect(me("birdie", "canceled", true)).toBe(false);
    expect(me("coach_pro", "none", true)).toBe(false);
  });

  it("unknown or malformed values → false, and agree with the route decision", async () => {
    for (const [tier, status] of [
      ["platinum", "active"],
      ["eagle", "unpaid"],
      [null, "active"],
      ["birdie", undefined],
      [7, "trialing"],
    ] as [unknown, unknown][]) {
      expect(me(tier, status, true)).toBe(false);
      expect(await resolvePracticeAccess(fakeCaller(row(tier, status)).caller)).toEqual({ status: "denied" });
    }
  });

  it("/me and the route authority agree on every combination when the flag is on", async () => {
    for (const tier of [...ALLOWED_TIERS, ...DENIED_TIERS]) {
      for (const status of [...ALLOWED_STATUSES, ...DENIED_STATUSES]) {
        const routeAllows = (await resolvePracticeAccess(fakeCaller(row(tier, status)).caller)).status === "allowed";
        expect(me(tier, status, true), `${String(tier)}/${String(status)}`).toBe(routeAllows);
      }
    }
  });
});
