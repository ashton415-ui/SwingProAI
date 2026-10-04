import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VerifiedAuth } from "@/utils/supabase/server";

/**
 * PI-0 — /api/v1/practice/plans route contract.
 *
 * The real route handlers run against an in-memory stand-in for Supabase:
 *
 *   * the caller's client sees only rows whose user_id is the caller (RLS) and
 *     is refused every write (browser roles hold SELECT only);
 *   * the elevated client sees everything and may write;
 *   * `pi_create_practice_plan` is simulated with the migration's contract.
 *
 * The simulation is not the database. The SQL itself is pinned by
 * lib/pi0-practice-foundation-schema.test.ts; this suite proves what the
 * routes do with the answers they get.
 */

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const DRILL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRILL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_DRILL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_1 = "0f000000-0000-4000-8000-000000000001";
const KEY_2 = "0f000000-0000-4000-8000-000000000002";

// ─── In-memory Supabase stand-in ──────────────────────────────────────────────

type Row = Record<string, any>;
type DbError = { code: string; message: string };
type Result = { data: any; error: DbError | null };

interface Call {
  who: "user" | "admin";
  kind: "select" | "insert" | "update" | "rpc";
  table: string;
  filters: [string, unknown][];
  payload?: unknown;
}

const OWNED_TABLES = new Set([
  "practice_plans",
  "practice_plan_items",
  "practice_sessions",
  "practice_session_results",
]);

function makeDb() {
  const tables: Record<string, Row[]> = {
    practice_plans: [],
    practice_plan_items: [],
    practice_sessions: [],
    practice_session_results: [],
    drills: [{ id: DRILL_A }, { id: DRILL_B }],
    // PI-1A: the entitlement authority reads tier and status from here.
    users: [
      { id: CALLER_ID, subscription_tier: "birdie", subscription_status: "active" },
      { id: OTHER_ID, subscription_tier: "eagle", subscription_status: "trialing" },
    ],
  };
  const calls: Call[] = [];
  const failures: ((call: Call) => DbError | undefined)[] = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) + tick++ * 1000).toISOString();

  const err = (code: string): Result => ({ data: null, error: { code, message: `simulated ${code}` } });

  function insertRow(table: string, payload: Row): Result {
    const rows = tables[table];
    const row: Row = { id: crypto.randomUUID(), created_at: now(), ...payload };
    if (table === "practice_plans") {
      Object.assign(row, { origin: "golfer", status: "active", archived_at: null, updated_at: row.created_at }, payload);
    }
    if (table === "practice_sessions") {
      Object.assign(row, { status: "in_progress", started_at: now(), ended_at: null, notes: null, plan_id: null }, payload);
      if (row.plan_id !== null && !tables.practice_plans.some((p) => p.id === row.plan_id && p.user_id === row.user_id)) {
        return err("23503");
      }
      if (rows.some((s) => s.user_id === row.user_id && s.status === "in_progress")) return err("23505");
    }
    if (table === "practice_session_results") {
      Object.assign(row, { evidence_type: "user_entered", recorded_at: now() }, payload);
    }
    if (
      "idempotency_key" in row &&
      rows.some((r) => r.user_id === row.user_id && r.idempotency_key === row.idempotency_key)
    ) {
      return err("23505");
    }
    rows.push(row);
    return { data: row, error: null };
  }

  class Query implements PromiseLike<Result> {
    private kind: "select" | "insert" | "update" = "select";
    private columns = "*";
    private filters: [string, unknown][] = [];
    private orders: [string, boolean][] = [];
    private limitN: number | null = null;
    private rangeFT: [number, number] | null = null;
    private payload: Row | null = null;
    private mode: "many" | "maybe" | "single" = "many";

    constructor(
      private who: "user" | "admin",
      private uid: string,
      private table: string,
    ) {}

    select(columns: string) {
      this.columns = columns;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    order(column: string, opts?: { ascending?: boolean }) {
      this.orders.push([column, opts?.ascending !== false]);
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    range(from: number, to: number) {
      this.rangeFT = [from, to];
      return this;
    }
    insert(payload: Row) {
      this.kind = "insert";
      this.payload = payload;
      return this;
    }
    update(payload: Row) {
      this.kind = "update";
      this.payload = payload;
      return this;
    }
    maybeSingle() {
      this.mode = "maybe";
      return this;
    }
    single() {
      this.mode = "single";
      return this;
    }

    private project(row: Row): Row {
      if (this.columns === "*") return { ...row };
      const out: Row = {};
      for (const c of this.columns.split(",").map((s) => s.trim())) out[c] = row[c] ?? null;
      return out;
    }

    private matches(row: Row): boolean {
      return this.filters.every(([c, v]) => row[c] === v);
    }

    private execute(): Result {
      const call: Call = {
        who: this.who,
        kind: this.kind,
        table: this.table,
        filters: [...this.filters],
        payload: this.payload ?? undefined,
      };
      calls.push(call);
      for (const f of failures) {
        const e = f(call);
        if (e) return { data: null, error: e };
      }

      if (this.kind !== "select") {
        // Browser roles hold SELECT only.
        if (this.who === "user" && OWNED_TABLES.has(this.table)) return err("42501");
        if (this.kind === "insert") {
          const r = insertRow(this.table, this.payload as Row);
          if (r.error) return r;
          return { data: this.project(r.data), error: null };
        }
        const updated: Row[] = [];
        for (const row of tables[this.table]) {
          if (!this.matches(row)) continue;
          const next = { ...row, ...(this.payload as Row) };
          if (next.ended_at && next.started_at && next.ended_at < next.started_at) return err("23514");
          Object.assign(row, this.payload);
          updated.push(this.project(row));
        }
        return { data: updated, error: null };
      }

      let rows = tables[this.table].filter((r) => this.matches(r));
      if (this.who === "user" && OWNED_TABLES.has(this.table)) {
        rows = rows.filter((r) => r.user_id === this.uid);
      }
      // public.users RLS: a caller sees only their own profile row.
      if (this.who === "user" && this.table === "users") {
        rows = rows.filter((r) => r.id === this.uid);
      }
      for (const [col, asc] of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.rangeFT) rows = rows.slice(this.rangeFT[0], this.rangeFT[1] + 1);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      const projected = rows.map((r) => this.project(r));
      if (this.mode === "many") return { data: projected, error: null };
      if (projected.length > 1) return err("PGRST116");
      if (projected.length === 0) return this.mode === "maybe" ? { data: null, error: null } : err("PGRST116");
      return { data: projected[0], error: null };
    }

    then<A = Result, B = never>(
      onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
      onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
    }
  }

  function createPlan(a: Row): Result {
    const plans = tables.practice_plans;
    const prior = plans.find((p) => p.user_id === a.p_user_id && p.idempotency_key === a.p_idempotency_key);
    if (prior) {
      return prior.request_fingerprint === a.p_request_fingerprint
        ? { data: { outcome: "replayed", plan_id: prior.id }, error: null }
        : { data: { outcome: "idempotency_conflict" }, error: null };
    }
    const items = a.p_items as Row[];
    if (!Array.isArray(items) || items.length < 1 || items.length > 20) return err("22023");
    if (items.some((i) => !tables.drills.some((d) => d.id === i.drillId))) {
      return { data: { outcome: "drill_not_found" }, error: null };
    }
    const plan = insertRow("practice_plans", {
      user_id: a.p_user_id,
      title: a.p_title,
      focus: a.p_focus,
      idempotency_key: a.p_idempotency_key,
      request_fingerprint: a.p_request_fingerprint,
    }).data;
    items.forEach((item, index) =>
      insertRow("practice_plan_items", {
        plan_id: plan.id,
        user_id: a.p_user_id,
        drill_id: item.drillId,
        position: index + 1,
        target_reps: item.targetReps ?? null,
        target_note: item.targetNote ?? null,
      }),
    );
    return { data: { outcome: "created", plan_id: plan.id }, error: null };
  }

  function recordResult(a: Row): Result {
    const results = tables.practice_session_results;
    const prior = results.find((r) => r.user_id === a.p_user_id && r.idempotency_key === a.p_idempotency_key);
    if (prior) {
      return prior.request_fingerprint === a.p_request_fingerprint
        ? { data: { outcome: "replayed", result_id: prior.id }, error: null }
        : { data: { outcome: "idempotency_conflict" }, error: null };
    }
    const session = tables.practice_sessions.find((s) => s.id === a.p_session_id && s.user_id === a.p_user_id);
    if (!session) return { data: { outcome: "session_not_found" }, error: null };
    if (session.status !== "in_progress") return { data: { outcome: "session_not_active" }, error: null };
    if (!tables.drills.some((d) => d.id === a.p_drill_id)) return { data: { outcome: "drill_not_found" }, error: null };
    if (a.p_plan_item_id !== null) {
      const ok = tables.practice_plan_items.some(
        (i) =>
          i.id === a.p_plan_item_id &&
          i.plan_id === session.plan_id &&
          i.user_id === a.p_user_id &&
          i.drill_id === a.p_drill_id,
      );
      if (session.plan_id === null || !ok) return { data: { outcome: "plan_item_invalid" }, error: null };
    }
    const row = insertRow("practice_session_results", {
      user_id: a.p_user_id,
      session_id: a.p_session_id,
      plan_id: session.plan_id,
      plan_item_id: a.p_plan_item_id,
      drill_id: a.p_drill_id,
      attempts: a.p_attempts,
      successes: a.p_successes,
      self_rating: a.p_self_rating,
      note: a.p_note,
      idempotency_key: a.p_idempotency_key,
      request_fingerprint: a.p_request_fingerprint,
    }).data;
    return { data: { outcome: "created", result_id: row.id }, error: null };
  }

  function client(who: "user" | "admin", uid: string) {
    return {
      from: (table: string) => new Query(who, uid, table),
      rpc: async (name: string, args: Row): Promise<Result> => {
        const call: Call = { who, kind: "rpc", table: name, filters: [], payload: args };
        calls.push(call);
        for (const f of failures) {
          const e = f(call);
          if (e) return { data: null, error: e };
        }
        if (who === "user") return err("42501");
        if (name === "pi_create_practice_plan") return createPlan(args);
        if (name === "pi_record_practice_result") return recordResult(args);
        return err("PGRST202");
      },
    };
  }

  return { tables, calls, failures, client };
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: null as unknown,
  admin: null as unknown,
  adminThrows: false,
  adminConstructions: 0,
  authCalls: 0,
  incomingRequestId: null as string | null,
}));

// `server-only` throws outside a Next.js server context; Vitest is not one.
vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name.toLowerCase() === "x-request-id" ? state.incomingRequestId : null),
  }),
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveRouteAuth: async () => {
    state.authCalls += 1;
    return state.auth;
  },
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions += 1;
    if (state.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return state.admin;
  },
}));

import { GET as listPlans, POST as createPlanRoute } from "@/app/api/v1/practice/plans/route";
import { GET as getPlan } from "@/app/api/v1/practice/plans/[planId]/route";
import { POST as archivePlan } from "@/app/api/v1/practice/plans/[planId]/archive/route";

let db: ReturnType<typeof makeDb>;

function signIn(userId: string): void {
  state.auth = {
    status: "authenticated",
    userId,
    email: "golfer@example.com",
    accessToken: "not-a-real-token",
    client: db.client("user", userId),
    source: "bearer",
  } as unknown as VerifiedAuth;
}

const BASE = "https://www.swingpro-ai.com/api/v1/practice/plans";

function postPlan(body: unknown, key: string | null = KEY_1, raw?: string): Request {
  const headers: Record<string, string> = {};
  if (key !== null) headers["Idempotency-Key"] = key;
  return new Request(BASE, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Wedge week",
    focus: "Distance control",
    items: [{ drillId: DRILL_A, targetReps: 30 }, { drillId: DRILL_B, targetNote: "Slow tempo" }],
    ...overrides,
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await json(response);
  expect(body.error.code).toBe(code);
  expect(Object.keys(body)).toEqual(["error"]);
}

function writes(): Call[] {
  return db.calls.filter((c) => c.kind !== "select");
}

const ORIGINAL_FLAG = process.env.PRACTICE_INTELLIGENCE_ENABLED;

beforeEach(() => {
  db = makeDb();
  state.admin = db.client("admin", "service_role");
  state.adminThrows = false;
  state.adminConstructions = 0;
  state.authCalls = 0;
  state.incomingRequestId = null;
  process.env.PRACTICE_INTELLIGENCE_ENABLED = "true";
  signIn(CALLER_ID);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
  else process.env.PRACTICE_INTELLIGENCE_ENABLED = ORIGINAL_FLAG;
});

async function seedPlan(userId = CALLER_ID, key = KEY_1): Promise<string> {
  signIn(userId);
  const response = await createPlanRoute(postPlan(validPlan(), key));
  expect(response.status).toBe(201);
  const id = (await json(response)).data.plan.id as string;
  signIn(CALLER_ID);
  // Seeding is setup, not the behaviour under test.
  db.calls.length = 0;
  state.adminConstructions = 0;
  return id;
}

// ─── Feature flag ─────────────────────────────────────────────────────────────

describe("practice plans — feature flag", () => {
  const handlers: [string, () => Promise<Response>][] = [
    ["GET list", () => listPlans(new Request(BASE))],
    ["POST create", () => createPlanRoute(postPlan(validPlan()))],
    ["GET detail", () => getPlan(new Request(`${BASE}/x`), { params: { planId: DRILL_A } })],
    ["POST archive", () => archivePlan(new Request(`${BASE}/x/archive`), { params: { planId: DRILL_A } })],
  ];

  for (const value of [undefined, "", "false", "1", "yes", "on", "enabled", "TRUE1"]) {
    it(`answers 404 FEATURE_UNAVAILABLE for PRACTICE_INTELLIGENCE_ENABLED=${JSON.stringify(value)} before auth or DB`, async () => {
      if (value === undefined) delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
      else process.env.PRACTICE_INTELLIGENCE_ENABLED = value;
      for (const [, handler] of handlers) {
        const response = await handler();
        await expectError(response, 404, "FEATURE_UNAVAILABLE");
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
      expect(state.authCalls).toBe(0);
      expect(db.calls).toEqual([]);
      expect(state.adminConstructions).toBe(0);
    });
  }

  it("accepts the exact word true in any casing and surrounding whitespace", async () => {
    process.env.PRACTICE_INTELLIGENCE_ENABLED = "  True ";
    const response = await listPlans(new Request(BASE));
    expect(response.status).toBe(200);
  });
});

// ─── Authentication ───────────────────────────────────────────────────────────

describe("practice plans — authentication", () => {
  const cases: ["absent" | "invalid" | "verification_unavailable", number, string][] = [
    ["absent", 401, "AUTH_REQUIRED"],
    ["invalid", 401, "AUTH_INVALID"],
    ["verification_unavailable", 503, "SERVER_TEMPORARILY_UNAVAILABLE"],
  ];
  for (const [status, http, code] of cases) {
    it(`maps ${status} to ${http} ${code} on every handler and touches nothing`, async () => {
      state.auth = { status } as VerifiedAuth;
      await expectError(await listPlans(new Request(BASE)), http, code);
      await expectError(await createPlanRoute(postPlan(validPlan())), http, code);
      await expectError(await getPlan(new Request(BASE), { params: { planId: DRILL_A } }), http, code);
      await expectError(await archivePlan(new Request(BASE), { params: { planId: DRILL_A } }), http, code);
      expect(db.calls).toEqual([]);
      expect(state.adminConstructions).toBe(0);
    });
  }

  it("echoes a well-formed X-Request-Id and marks responses private", async () => {
    state.incomingRequestId = "client-req-0001";
    const response = await listPlans(new Request(BASE));
    expect(response.headers.get("X-Request-Id")).toBe("client-req-0001");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

// ─── Entitlement (PI-1A) ──────────────────────────────────────────────────────

function setMembership(userId: string, tier: unknown, status: unknown): void {
  const row = db.tables.users.find((u) => u.id === userId)!;
  row.subscription_tier = tier;
  row.subscription_status = status;
}

describe("practice plans — entitlement (PI-1A)", () => {
  const handlers: [string, () => Promise<Response>][] = [
    ["GET list", () => listPlans(new Request(BASE))],
    ["POST create", () => createPlanRoute(postPlan(validPlan()))],
    ["GET detail", () => getPlan(new Request(`${BASE}/x`), { params: { planId: DRILL_A } })],
    ["POST archive", () => archivePlan(new Request(`${BASE}/x/archive`), { params: { planId: DRILL_A } })],
  ];

  /** The only thing a refused caller may cause: one read of their own profile. */
  function expectOnlyOwnProfileRead(): void {
    expect(db.calls).toEqual([
      { who: "user", kind: "select", table: "users", filters: [["id", CALLER_ID]], payload: undefined },
    ]);
    expect(state.adminConstructions).toBe(0);
  }

  const DENIED: [string, unknown, unknown][] = [
    ["par + active", "par", "active"],
    ["none + none", "none", "none"],
    ["birdie + past_due", "birdie", "past_due"],
    ["eagle + canceled", "eagle", "canceled"],
    ["coach_pro + none", "coach_pro", "none"],
    ["unknown tier", "platinum", "active"],
    ["unknown status", "birdie", "paused"],
    ["null tier", null, "active"],
    ["null status", "birdie", null],
    ["non-string tier", 7, "active"],
  ];

  for (const [label, tier, status] of DENIED) {
    it(`answers 403 ENTITLEMENT_REQUIRED for ${label} on every handler, before any practice read or write`, async () => {
      setMembership(CALLER_ID, tier, status);
      for (const [name, handler] of handlers) {
        db.calls.length = 0;
        const response = await handler();
        expect(response.status, name).toBe(403);
        const body = await json(response);
        expect(body.error.code).toBe("ENTITLEMENT_REQUIRED");
        expect(body.error.message).toBe("Practice Intelligence isn't available with your current membership.");
        expect(JSON.stringify(body)).not.toMatch(/birdie|eagle|coach|par\b|active|trialing|past_due|canceled|tier|status/i);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expectOnlyOwnProfileRead();
      }
      expect(db.tables.practice_plans).toHaveLength(0);
    });
  }

  for (const [tier, status] of [
    ["birdie", "active"],
    ["birdie", "trialing"],
    ["eagle", "active"],
    ["coach_starter", "trialing"],
    ["coach_pro", "active"],
  ] as const) {
    it(`lets ${tier} + ${status} through to the practice surface`, async () => {
      setMembership(CALLER_ID, tier, status);
      expect((await createPlanRoute(postPlan(validPlan()))).status).toBe(201);
      expect((await listPlans(new Request(BASE))).status).toBe(200);
    });
  }

  it("decides on the membership before reading the path, the key or the body", async () => {
    setMembership(CALLER_ID, "none", "none");
    db.calls.length = 0;
    await expectError(await createPlanRoute(postPlan(null, null, "{not json")), 403, "ENTITLEMENT_REQUIRED");
    await expectError(await getPlan(new Request(BASE), { params: { planId: "not-a-uuid" } }), 403, "ENTITLEMENT_REQUIRED");
    await expectError(await listPlans(new Request(`${BASE}?status=deleted`)), 403, "ENTITLEMENT_REQUIRED");
    expect(writes()).toEqual([]);
  });

  it("answers 503 when the profile read fails, writing nothing", async () => {
    db.failures.push((c) => (c.table === "users" ? { code: "XX000", message: "secret-detail" } : undefined));
    for (const [name, handler] of handlers) {
      db.calls.length = 0;
      const response = await handler();
      expect(response.status, name).toBe(503);
      const body = await json(response);
      expect(body.error.code).toBe("SERVER_TEMPORARILY_UNAVAILABLE");
      expect(body.error.message).toBe("Practice access is temporarily unavailable. Please retry.");
      expect(JSON.stringify(body)).not.toContain("secret-detail");
      expectOnlyOwnProfileRead();
    }
  });

  it("answers 503, not 403, when the verified caller has no profile row", async () => {
    db.tables.users = db.tables.users.filter((u) => u.id !== CALLER_ID);
    for (const [name, handler] of handlers) {
      db.calls.length = 0;
      const response = await handler();
      expect(response.status, name).toBe(503);
      expectOnlyOwnProfileRead();
    }
  });

  it("does not grant access from role: an admin on no plan is refused", async () => {
    db.tables.users[0] = { id: CALLER_ID, role: "admin", subscription_tier: "none", subscription_status: "none" };
    await expectError(await listPlans(new Request(BASE)), 403, "ENTITLEMENT_REQUIRED");
  });
});

// ─── Create ───────────────────────────────────────────────────────────────────

describe("POST /api/v1/practice/plans — create", () => {
  it("creates a plan and its ordered items and answers 201", async () => {
    const response = await createPlanRoute(postPlan(validPlan()));
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotent-Replayed")).toBeNull();
    const { data } = await json(response);
    expect(data.plan).toMatchObject({
      title: "Wedge week",
      focus: "Distance control",
      origin: "golfer",
      status: "active",
      archivedAt: null,
    });
    expect(data.plan.items.map((i: Row) => [i.position, i.drillId, i.targetReps, i.targetNote])).toEqual([
      [1, DRILL_A, 30, null],
      [2, DRILL_B, null, "Slow tempo"],
    ]);
    expect(db.tables.practice_plans).toHaveLength(1);
    expect(db.tables.practice_plan_items).toHaveLength(2);
  });

  it("binds the owner to the verified identity through the elevated client only", async () => {
    await createPlanRoute(postPlan(validPlan()));
    const rpc = db.calls.filter((c) => c.kind === "rpc");
    expect(rpc).toHaveLength(1);
    expect(rpc[0].who).toBe("admin");
    expect(rpc[0].table).toBe("pi_create_practice_plan");
    expect((rpc[0].payload as Row).p_user_id).toBe(CALLER_ID);
    expect((rpc[0].payload as Row).p_idempotency_key).toBe(KEY_1);
    expect((rpc[0].payload as Row).p_request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(db.calls.filter((c) => c.who === "user" && c.kind !== "select")).toEqual([]);
    expect(state.adminConstructions).toBe(1);
  });

  it("never exposes owner or idempotency bookkeeping", async () => {
    const text = await (await createPlanRoute(postPlan(validPlan()))).text();
    for (const leaked of ["user_id", "userId", "idempotency", "fingerprint", CALLER_ID, KEY_1]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("refuses a caller-supplied owner", async () => {
    await expectError(await createPlanRoute(postPlan(validPlan({ userId: OTHER_ID }))), 400, "VALIDATION_ERROR");
    await expectError(await createPlanRoute(postPlan(validPlan({ user_id: OTHER_ID }))), 400, "VALIDATION_ERROR");
    expect(writes()).toEqual([]);
  });

  it("requires a lowercase canonical Idempotency-Key", async () => {
    // Surrounding whitespace is not tested: the Fetch Headers type strips it
    // before the route can see it.
    for (const key of [null, "", "not-a-uuid", KEY_1.toUpperCase(), KEY_1.slice(0, -1), `${KEY_1}0`, `{${KEY_1}}`]) {
      await expectError(await createPlanRoute(postPlan(validPlan(), key)), 400, "VALIDATION_ERROR");
    }
    expect(writes()).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });

  it("refuses every malformed body before any write", async () => {
    const bad: unknown[] = [
      null,
      [],
      "plan",
      {},
      validPlan({ title: "" }),
      validPlan({ title: "   " }),
      validPlan({ title: "x".repeat(121) }),
      validPlan({ title: 7 }),
      validPlan({ focus: "x".repeat(501) }),
      validPlan({ focus: 3 }),
      validPlan({ items: [] }),
      validPlan({ items: Array.from({ length: 21 }, () => ({ drillId: DRILL_A })) }),
      validPlan({ items: [{ drillId: "nope" }] }),
      validPlan({ items: [{ drillId: DRILL_A, targetReps: 0 }] }),
      validPlan({ items: [{ drillId: DRILL_A, targetReps: 501 }] }),
      validPlan({ items: [{ drillId: DRILL_A, targetReps: 2.5 }] }),
      validPlan({ items: [{ drillId: DRILL_A, targetReps: "10" }] }),
      validPlan({ items: [{ drillId: DRILL_A, targetNote: "x".repeat(501) }] }),
      validPlan({ items: [{ drillId: DRILL_A, position: 1 }] }),
      validPlan({ origin: "coach" }),
      validPlan({ status: "archived" }),
    ];
    for (const body of bad) {
      await expectError(await createPlanRoute(postPlan(body)), 400, "VALIDATION_ERROR");
    }
    await expectError(await createPlanRoute(postPlan(null, KEY_1, "{not json")), 400, "VALIDATION_ERROR");
    expect(writes()).toEqual([]);
  });

  it("accepts the boundaries: 120-character title, 20 items, reps 1 and 500", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ drillId: DRILL_A, targetReps: i % 2 ? 1 : 500 }));
    const response = await createPlanRoute(postPlan(validPlan({ title: "t".repeat(120), items })));
    expect(response.status).toBe(201);
    expect((await json(response)).data.plan.items).toHaveLength(20);
  });

  it("replays the same key and body with 200 and Idempotent-Replayed: true", async () => {
    const first = await json(await createPlanRoute(postPlan(validPlan())));
    const again = await createPlanRoute(postPlan(validPlan()));
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await json(again)).data.plan.id).toBe(first.data.plan.id);
    expect(db.tables.practice_plans).toHaveLength(1);
    expect(db.tables.practice_plan_items).toHaveLength(2);
  });

  it("treats a normalised-equal body as the same request", async () => {
    await createPlanRoute(postPlan(validPlan()));
    const again = await createPlanRoute(
      postPlan({
        items: [{ targetReps: 30, drillId: DRILL_A.toUpperCase(), targetNote: "  " }, { drillId: DRILL_B, targetNote: "Slow tempo" }],
        focus: "  Distance control ",
        title: " Wedge week ",
      }),
    );
    expect(again.status).toBe(200);
  });

  it("answers 409 IDEMPOTENCY_CONFLICT when the key is reused for a different body, writing nothing", async () => {
    await createPlanRoute(postPlan(validPlan()));
    await expectError(await createPlanRoute(postPlan(validPlan({ title: "Other" }))), 409, "IDEMPOTENCY_CONFLICT");
    expect(db.tables.practice_plans).toHaveLength(1);
  });

  it("scopes idempotency keys per golfer", async () => {
    await seedPlan(OTHER_ID, KEY_1);
    const response = await createPlanRoute(postPlan(validPlan(), KEY_1));
    expect(response.status).toBe(201);
    expect(db.tables.practice_plans).toHaveLength(2);
  });

  it("answers 409 DRILL_NOT_FOUND for a non-canonical drill and writes nothing", async () => {
    const body = validPlan({ items: [{ drillId: DRILL_A }, { drillId: MISSING_DRILL }] });
    await expectError(await createPlanRoute(postPlan(body)), 409, "DRILL_NOT_FOUND");
    expect(db.tables.practice_plans).toHaveLength(0);
    expect(db.tables.practice_plan_items).toHaveLength(0);
  });

  it("maps a foreign-key race to DRILL_NOT_FOUND and other function errors to 503", async () => {
    db.failures.push((c) => (c.kind === "rpc" ? { code: "23503", message: "fk" } : undefined));
    await expectError(await createPlanRoute(postPlan(validPlan())), 409, "DRILL_NOT_FOUND");
    db.failures.length = 0;
    db.failures.push((c) => (c.kind === "rpc" ? { code: "XX000", message: "boom" } : undefined));
    const response = await createPlanRoute(postPlan(validPlan(), KEY_2));
    await expectError(response, 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("answers 503 when the server configuration is missing", async () => {
    state.adminThrows = true;
    await expectError(await createPlanRoute(postPlan(validPlan())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("never leaks database error text", async () => {
    db.failures.push((c) => (c.kind === "rpc" ? { code: "XX000", message: "secret-internal-detail" } : undefined));
    const text = await (await createPlanRoute(postPlan(validPlan()))).text();
    expect(text).not.toContain("secret-internal-detail");
  });
});

// ─── List ─────────────────────────────────────────────────────────────────────

describe("GET /api/v1/practice/plans — list", () => {
  it("lists only the caller's plans, newest first", async () => {
    await seedPlan(CALLER_ID, KEY_1);
    await seedPlan(OTHER_ID, KEY_1);
    await seedPlan(CALLER_ID, KEY_2);
    const response = await listPlans(new Request(BASE));
    expect(response.status).toBe(200);
    const { data } = await json(response);
    expect(data.plans).toHaveLength(2);
    expect(data.plans[0].createdAt >= data.plans[1].createdAt).toBe(true);
    expect(JSON.stringify(data)).not.toContain("user_id");
    // Reads run on the caller's client, restating ownership.
    const reads = db.calls.filter((c) => c.kind === "select" && c.table === "practice_plans");
    expect(reads.at(-1)?.who).toBe("user");
    expect(reads.at(-1)?.filters).toContainEqual(["user_id", CALLER_ID]);
  });

  it("filters by status", async () => {
    const id = await seedPlan();
    await seedPlan(CALLER_ID, KEY_2);
    await archivePlan(new Request(BASE), { params: { planId: id } });
    const archived = await json(await listPlans(new Request(`${BASE}?status=archived`)));
    expect(archived.data.plans.map((p: Row) => p.id)).toEqual([id]);
    const active = await json(await listPlans(new Request(`${BASE}?status=active`)));
    expect(active.data.plans).toHaveLength(1);
  });

  it("refuses an unknown status or query parameter", async () => {
    for (const q of ["?status=deleted", "?status=", "?status=active&status=archived", "?userId=x"]) {
      await expectError(await listPlans(new Request(`${BASE}${q}`)), 400, "VALIDATION_ERROR");
    }
  });

  it("answers 503 on a read error", async () => {
    db.failures.push(() => ({ code: "XX000", message: "down" }));
    await expectError(await listPlans(new Request(BASE)), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── Detail ───────────────────────────────────────────────────────────────────

describe("GET /api/v1/practice/plans/{planId} — detail", () => {
  it("returns the caller's plan with items and empty progress", async () => {
    const id = await seedPlan();
    const response = await getPlan(new Request(BASE), { params: { planId: id } });
    expect(response.status).toBe(200);
    const { data } = await json(response);
    expect(data.plan.id).toBe(id);
    expect(data.plan.items).toHaveLength(2);
    expect(data.plan.progress).toEqual(
      data.plan.items.map((i: Row) => ({
        planItemId: i.id,
        drillId: i.drillId,
        completedSessionCount: 0,
        totalAttempts: null,
        totalSuccesses: null,
        lastPracticedAt: null,
      })),
    );
    expect(db.calls.every((c) => c.who === "user")).toBe(true);
  });

  it("answers 404 for another golfer's plan, an unknown id, or a malformed id", async () => {
    const theirs = await seedPlan(OTHER_ID);
    for (const planId of [theirs, MISSING_DRILL, "not-a-uuid", ""]) {
      await expectError(await getPlan(new Request(BASE), { params: { planId } }), 404, "PRACTICE_PLAN_NOT_FOUND");
    }
  });

  it("derives progress from completed sessions only", async () => {
    const id = await seedPlan();
    const item = db.tables.practice_plan_items.find((i) => i.plan_id === id && i.position === 1)!;
    const base = { user_id: CALLER_ID, plan_id: id, idempotency_key: KEY_1, request_fingerprint: "f".repeat(64) };
    db.tables.practice_sessions.push(
      { ...base, id: "s-done", status: "completed", idempotency_key: "k1" },
      { ...base, id: "s-open", status: "in_progress", idempotency_key: "k2" },
      { ...base, id: "s-quit", status: "abandoned", idempotency_key: "k3" },
    );
    const result = (sessionId: string, attempts: number | null, successes: number | null, recordedAt: string) => ({
      id: crypto.randomUUID(),
      user_id: CALLER_ID,
      session_id: sessionId,
      plan_id: id,
      plan_item_id: item.id,
      attempts,
      successes,
      recorded_at: recordedAt,
    });
    db.tables.practice_session_results.push(
      result("s-done", 10, 7, "2026-09-30T13:00:00.000Z"),
      result("s-done", null, null, "2026-09-30T13:05:00.000Z"),
      result("s-open", 100, 100, "2026-09-30T14:00:00.000Z"),
      result("s-quit", 100, 100, "2026-09-30T15:00:00.000Z"),
    );
    const { data } = await json(await getPlan(new Request(BASE), { params: { planId: id } }));
    expect(data.plan.progress[0]).toEqual({
      planItemId: item.id,
      drillId: DRILL_A,
      completedSessionCount: 1,
      totalAttempts: 10,
      totalSuccesses: 7,
      lastPracticedAt: "2026-09-30T13:05:00.000Z",
    });
    expect(JSON.stringify(data)).not.toMatch(/percent|rate|score/i);
  });

  it("answers 503 rather than progress from a failed read", async () => {
    const id = await seedPlan();
    db.failures.push((c) => (c.table === "practice_session_results" ? { code: "XX000", message: "x" } : undefined));
    await expectError(await getPlan(new Request(BASE), { params: { planId: id } }), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── Archive ──────────────────────────────────────────────────────────────────

describe("POST /api/v1/practice/plans/{planId}/archive", () => {
  it("archives the caller's active plan with one guarded elevated update", async () => {
    const id = await seedPlan();
    db.calls.length = 0;
    const response = await archivePlan(new Request(BASE), { params: { planId: id } });
    expect(response.status).toBe(200);
    const { data } = await json(response);
    expect(data.plan.status).toBe("archived");
    expect(typeof data.plan.archivedAt).toBe("string");
    const updates = writes();
    expect(updates).toHaveLength(1);
    expect(updates[0].who).toBe("admin");
    expect(updates[0].filters).toEqual([
      ["id", id],
      ["user_id", CALLER_ID],
      ["status", "active"],
    ]);
    expect(Object.keys(updates[0].payload as Row).sort()).toEqual(["archived_at", "status", "updated_at"]);
  });

  it("is idempotent: archiving an archived plan answers 200 and writes nothing", async () => {
    const id = await seedPlan();
    await archivePlan(new Request(BASE), { params: { planId: id } });
    db.calls.length = 0;
    const again = await archivePlan(new Request(BASE), { params: { planId: id } });
    expect(again.status).toBe(200);
    expect((await json(again)).data.plan.status).toBe("archived");
    expect(writes()).toEqual([]);
  });

  it("answers 404 for another golfer's plan and never writes it", async () => {
    const theirs = await seedPlan(OTHER_ID);
    db.calls.length = 0;
    await expectError(await archivePlan(new Request(BASE), { params: { planId: theirs } }), 404, "PRACTICE_PLAN_NOT_FOUND");
    await expectError(await archivePlan(new Request(BASE), { params: { planId: "bad" } }), 404, "PRACTICE_PLAN_NOT_FOUND");
    expect(writes()).toEqual([]);
    expect(state.adminConstructions).toBe(0);
    expect(db.tables.practice_plans[0].status).toBe("active");
  });

  it("answers from one re-read when a concurrent archive wins the race", async () => {
    const id = await seedPlan();
    db.failures.push((c) => {
      if (c.kind === "update") {
        const plan = db.tables.practice_plans.find((p) => p.id === id)!;
        plan.status = "archived";
        plan.archived_at = "2026-09-30T12:59:00.000Z";
      }
      return undefined;
    });
    const response = await archivePlan(new Request(BASE), { params: { planId: id } });
    expect(response.status).toBe(200);
    expect((await json(response)).data.plan.archivedAt).toBe("2026-09-30T12:59:00.000Z");
  });

  it("answers 503 when the elevated update fails", async () => {
    const id = await seedPlan();
    db.failures.push((c) => (c.kind === "update" ? { code: "XX000", message: "x" } : undefined));
    await expectError(await archivePlan(new Request(BASE), { params: { planId: id } }), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});
