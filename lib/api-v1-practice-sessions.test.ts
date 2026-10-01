import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VerifiedAuth } from "@/utils/supabase/server";

/**
 * PI-0 — /api/v1/practice/sessions route contract.
 *
 * The real route handlers run against the same in-memory stand-in used by
 * lib/api-v1-practice-plans.test.ts (duplicated here so each suite runs
 * alone): the caller's client sees only its own rows and cannot write; the
 * elevated client sees everything; `pi_record_practice_result` is simulated
 * with the migration's contract. The SQL itself is pinned by
 * lib/pi0-practice-foundation-schema.test.ts.
 */

const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const DRILL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRILL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_DRILL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_1 = "0f000000-0000-4000-8000-000000000001";
const KEY_2 = "0f000000-0000-4000-8000-000000000002";
const KEY_3 = "0f000000-0000-4000-8000-000000000003";
const KEY_4 = "0f000000-0000-4000-8000-000000000004";

/** A distinct canonical key per call site. */
const key = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

import { POST as createPlanRoute } from "@/app/api/v1/practice/plans/route";
import { GET as getPlan } from "@/app/api/v1/practice/plans/[planId]/route";
import { POST as archivePlan } from "@/app/api/v1/practice/plans/[planId]/archive/route";
import { GET as listSessions, POST as startSession } from "@/app/api/v1/practice/sessions/route";
import { GET as getSession } from "@/app/api/v1/practice/sessions/[sessionId]/route";
import { POST as recordResult } from "@/app/api/v1/practice/sessions/[sessionId]/results/route";
import { POST as completeSession } from "@/app/api/v1/practice/sessions/[sessionId]/complete/route";

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

const BASE = "https://www.swingpro-ai.com/api/v1/practice/sessions";

function post(url: string, body: unknown, idempotencyKey: string | null = null, raw?: string): Request {
  const headers: Record<string, string> = {};
  if (idempotencyKey !== null) headers["Idempotency-Key"] = idempotencyKey;
  const init: RequestInit = { method: "POST", headers };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const sid = (sessionId: string) => ({ params: { sessionId } });

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

function resetCalls(): void {
  db.calls.length = 0;
  state.adminConstructions = 0;
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
  vi.useRealTimers();
  if (ORIGINAL_FLAG === undefined) delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
  else process.env.PRACTICE_INTELLIGENCE_ENABLED = ORIGINAL_FLAG;
});

async function seedPlan(userId = CALLER_ID, planKey = KEY_4): Promise<{ id: string; items: Row[] }> {
  signIn(userId);
  const response = await createPlanRoute(
    post(
      "https://www.swingpro-ai.com/api/v1/practice/plans",
      { title: "Putting ladder", items: [{ drillId: DRILL_A, targetReps: 20 }, { drillId: DRILL_B }] },
      planKey,
    ),
  );
  expect(response.status).toBe(201);
  const plan = (await json(response)).data.plan;
  signIn(CALLER_ID);
  resetCalls();
  return { id: plan.id, items: plan.items };
}

async function seedSession(
  userId = CALLER_ID,
  body: Record<string, unknown> = {},
  sessionKey = KEY_3,
): Promise<string> {
  signIn(userId);
  const response = await startSession(post(BASE, body, sessionKey));
  expect(response.status).toBe(201);
  const id = (await json(response)).data.session.id as string;
  signIn(CALLER_ID);
  resetCalls();
  return id;
}

// ─── Feature flag and authentication ──────────────────────────────────────────

describe("practice sessions — feature flag", () => {
  const handlers: (() => Promise<Response>)[] = [
    () => listSessions(new Request(BASE)),
    () => startSession(post(BASE, {}, KEY_1)),
    () => getSession(new Request(BASE), sid(DRILL_A)),
    () => recordResult(post(BASE, { drillId: DRILL_A, attempts: 1 }, KEY_1), sid(DRILL_A)),
    () => completeSession(post(BASE, { outcome: "completed" }), sid(DRILL_A)),
  ];

  for (const value of [undefined, "", "false", "0", "yes"]) {
    it(`answers 404 FEATURE_UNAVAILABLE for ${JSON.stringify(value)} before auth or DB`, async () => {
      if (value === undefined) delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
      else process.env.PRACTICE_INTELLIGENCE_ENABLED = value;
      for (const handler of handlers) {
        await expectError(await handler(), 404, "FEATURE_UNAVAILABLE");
      }
      expect(state.authCalls).toBe(0);
      expect(db.calls).toEqual([]);
      expect(state.adminConstructions).toBe(0);
    });
  }
});

describe("practice sessions — authentication", () => {
  it("answers 401/503 on every handler without touching the database", async () => {
    const cases = [
      ["absent", 401, "AUTH_REQUIRED"],
      ["invalid", 401, "AUTH_INVALID"],
      ["verification_unavailable", 503, "SERVER_TEMPORARILY_UNAVAILABLE"],
    ] as const;
    for (const [status, http, code] of cases) {
      state.auth = { status } as VerifiedAuth;
      await expectError(await listSessions(new Request(BASE)), http, code);
      await expectError(await startSession(post(BASE, {}, KEY_1)), http, code);
      await expectError(await getSession(new Request(BASE), sid(DRILL_A)), http, code);
      await expectError(
        await recordResult(post(BASE, { drillId: DRILL_A, attempts: 1 }, KEY_1), sid(DRILL_A)),
        http,
        code,
      );
      await expectError(await completeSession(post(BASE, { outcome: "completed" }), sid(DRILL_A)), http, code);
    }
    expect(db.calls).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/practice/sessions — start", () => {
  it("starts an unplanned session with no body and answers 201", async () => {
    const response = await startSession(post(BASE, undefined, KEY_1));
    expect(response.status).toBe(201);
    const { data } = await json(response);
    expect(data.session).toMatchObject({ planId: null, status: "in_progress", endedAt: null, notes: null });
    const inserts = writes();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].who).toBe("admin");
    expect(inserts[0].table).toBe("practice_sessions");
    expect(inserts[0].payload).toMatchObject({ user_id: CALLER_ID, plan_id: null, idempotency_key: KEY_1 });
    expect(Object.keys(inserts[0].payload as Row).sort()).toEqual([
      "idempotency_key",
      "notes",
      "plan_id",
      "request_fingerprint",
      "user_id",
    ]);
  });

  it("starts a session against the caller's own active plan", async () => {
    const plan = await seedPlan();
    const response = await startSession(post(BASE, { planId: plan.id, notes: " Short game " }, KEY_1));
    expect(response.status).toBe(201);
    expect((await json(response)).data.session).toMatchObject({ planId: plan.id, notes: "Short game" });
  });

  it("answers 404 PRACTICE_PLAN_NOT_FOUND for another golfer's, an archived or an unknown plan, writing nothing", async () => {
    const theirs = await seedPlan(OTHER_ID);
    const archived = await seedPlan(CALLER_ID, KEY_2);
    await archivePlan(new Request(BASE), { params: { planId: archived.id } });
    resetCalls();
    for (const planId of [theirs.id, archived.id, MISSING_DRILL]) {
      await expectError(await startSession(post(BASE, { planId }, KEY_1)), 404, "PRACTICE_PLAN_NOT_FOUND");
    }
    expect(writes()).toEqual([]);
    expect(state.adminConstructions).toBe(0);
  });

  it("maps a plan foreign-key refusal on insert to 404", async () => {
    const plan = await seedPlan();
    db.failures.push((c) => (c.kind === "insert" ? { code: "23503", message: "fk" } : undefined));
    await expectError(await startSession(post(BASE, { planId: plan.id }, KEY_1)), 404, "PRACTICE_PLAN_NOT_FOUND");
    expect(db.tables.practice_sessions).toHaveLength(0);
  });

  it("requires a canonical Idempotency-Key and refuses malformed bodies", async () => {
    await expectError(await startSession(post(BASE, {})), 400, "VALIDATION_ERROR");
    await expectError(await startSession(post(BASE, {}, KEY_1.toUpperCase())), 400, "VALIDATION_ERROR");
    const bad: unknown[] = [
      [],
      { planId: "nope" },
      { notes: "x".repeat(1001) },
      { notes: 5 },
      { userId: OTHER_ID },
      { status: "completed" },
      { startedAt: "2020-01-01T00:00:00Z" },
    ];
    for (const body of bad) {
      await expectError(await startSession(post(BASE, body, KEY_1)), 400, "VALIDATION_ERROR");
    }
    await expectError(await startSession(post(BASE, undefined, KEY_1, "{oops")), 400, "VALIDATION_ERROR");
    expect(writes()).toEqual([]);
  });

  it("replays the same key and body with 200 and Idempotent-Replayed: true", async () => {
    const first = await json(await startSession(post(BASE, { notes: "a" }, KEY_1)));
    const again = await startSession(post(BASE, { notes: "a" }, KEY_1));
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const replayed = await json(again);
    expect(replayed.data.session.id).toBe(first.data.session.id);
    expect(db.tables.practice_sessions).toHaveLength(1);
    expect(JSON.stringify(replayed)).not.toContain("fingerprint");
  });

  it("answers 409 IDEMPOTENCY_CONFLICT for the same key with a different body", async () => {
    await startSession(post(BASE, { notes: "a" }, KEY_1));
    await expectError(await startSession(post(BASE, { notes: "b" }, KEY_1)), 409, "IDEMPOTENCY_CONFLICT");
    expect(db.tables.practice_sessions).toHaveLength(1);
  });

  it("answers 409 PRACTICE_SESSION_ALREADY_ACTIVE for a second concurrent session", async () => {
    await startSession(post(BASE, {}, KEY_1));
    await expectError(await startSession(post(BASE, {}, KEY_2)), 409, "PRACTICE_SESSION_ALREADY_ACTIVE");
    expect(db.tables.practice_sessions).toHaveLength(1);
  });

  it("lets two golfers each hold a session in progress", async () => {
    await seedSession(OTHER_ID);
    expect((await startSession(post(BASE, {}, KEY_1))).status).toBe(201);
  });

  it("answers 503 when the insert fails for another reason or the server is misconfigured", async () => {
    db.failures.push((c) => (c.kind === "insert" ? { code: "XX000", message: "x" } : undefined));
    await expectError(await startSession(post(BASE, {}, KEY_1)), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
    db.failures.length = 0;
    state.adminThrows = true;
    await expectError(await startSession(post(BASE, {}, KEY_2)), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── List and detail ──────────────────────────────────────────────────────────

describe("GET /api/v1/practice/sessions — list and detail", () => {
  it("lists only the caller's sessions and filters by status", async () => {
    await seedSession(OTHER_ID);
    const mine = await seedSession();
    const all = await json(await listSessions(new Request(BASE)));
    expect(all.data.sessions.map((s: Row) => s.id)).toEqual([mine]);
    const done = await json(await listSessions(new Request(`${BASE}?status=completed`)));
    expect(done.data.sessions).toEqual([]);
    for (const q of ["?status=done", "?limit=5"]) {
      await expectError(await listSessions(new Request(`${BASE}${q}`)), 400, "VALIDATION_ERROR");
    }
  });

  it("returns the caller's session with its results, and 404 for anyone else's", async () => {
    const theirs = await seedSession(OTHER_ID, {}, KEY_2);
    const mine = await seedSession();
    await recordResult(post(BASE, { drillId: DRILL_A, attempts: 5, successes: 2 }, KEY_1), sid(mine));
    const { data } = await json(await getSession(new Request(BASE), sid(mine)));
    expect(data.session.id).toBe(mine);
    expect(data.session.results).toHaveLength(1);
    expect(data.session.results[0]).toMatchObject({
      drillId: DRILL_A,
      attempts: 5,
      successes: 2,
      evidenceType: "user_entered",
    });
    for (const id of [theirs, MISSING_DRILL, "bad"]) {
      await expectError(await getSession(new Request(BASE), sid(id)), 404, "PRACTICE_SESSION_NOT_FOUND");
    }
  });
});

// ─── Results ──────────────────────────────────────────────────────────────────

describe("POST /api/v1/practice/sessions/{sessionId}/results", () => {
  it("records a user-entered result through the function with the verified identity", async () => {
    const plan = await seedPlan();
    const session = await seedSession(CALLER_ID, { planId: plan.id });
    const item = plan.items[0];
    const response = await recordResult(
      post(
        BASE,
        { planItemId: item.id, drillId: DRILL_A, attempts: 10, successes: 6, selfRating: 4, note: " ok " },
        KEY_1,
      ),
      sid(session),
    );
    expect(response.status).toBe(201);
    const { data } = await json(response);
    expect(data.result).toMatchObject({
      sessionId: session,
      planId: plan.id,
      planItemId: item.id,
      drillId: DRILL_A,
      evidenceType: "user_entered",
      attempts: 10,
      successes: 6,
      selfRating: 4,
      note: "ok",
    });
    const rpc = db.calls.filter((c) => c.kind === "rpc");
    expect(rpc).toHaveLength(1);
    expect(rpc[0].who).toBe("admin");
    expect(rpc[0].table).toBe("pi_record_practice_result");
    expect(rpc[0].payload).toMatchObject({ p_user_id: CALLER_ID, p_session_id: session, p_idempotency_key: KEY_1 });
    expect(Object.keys(rpc[0].payload as Row)).not.toContain("p_plan_id");
  });

  it("derives plan_id from the session, never from the request", async () => {
    const plan = await seedPlan();
    const session = await seedSession(CALLER_ID, { planId: plan.id });
    await expectError(
      await recordResult(post(BASE, { planId: MISSING_DRILL, drillId: DRILL_A, attempts: 1 }, KEY_1), sid(session)),
      400,
      "VALIDATION_ERROR",
    );
    const ok = await json(await recordResult(post(BASE, { drillId: DRILL_B, note: "extra" }, KEY_2), sid(session)));
    expect(ok.data.result.planId).toBe(plan.id);
    expect(ok.data.result.planItemId).toBeNull();
  });

  it("replays and conflicts on the Idempotency-Key", async () => {
    const session = await seedSession();
    const body = { drillId: DRILL_A, attempts: 3 };
    const first = await json(await recordResult(post(BASE, body, KEY_1), sid(session)));
    const again = await recordResult(post(BASE, body, KEY_1), sid(session));
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await json(again)).data.result.id).toBe(first.data.result.id);
    await expectError(
      await recordResult(post(BASE, { drillId: DRILL_A, attempts: 4 }, KEY_1), sid(session)),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(db.tables.practice_session_results).toHaveLength(1);
  });

  it("fingerprints the session path parameter", async () => {
    const session = await seedSession();
    await recordResult(post(BASE, { drillId: DRILL_A, attempts: 3 }, KEY_1), sid(session));
    await completeSession(post(BASE, { outcome: "completed" }), sid(session));
    const other = await seedSession(CALLER_ID, {}, KEY_2);
    await expectError(
      await recordResult(post(BASE, { drillId: DRILL_A, attempts: 3 }, KEY_1), sid(other)),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("answers 404 for another golfer's session and 409 for an ended one, writing nothing", async () => {
    const theirs = await seedSession(OTHER_ID);
    const body = { drillId: DRILL_A, attempts: 1 };
    await expectError(await recordResult(post(BASE, body, KEY_1), sid(theirs)), 404, "PRACTICE_SESSION_NOT_FOUND");
    await expectError(await recordResult(post(BASE, body, KEY_1), sid("bad")), 404, "PRACTICE_SESSION_NOT_FOUND");
    const mine = await seedSession();
    await completeSession(post(BASE, { outcome: "abandoned" }), sid(mine));
    await expectError(await recordResult(post(BASE, body, KEY_2), sid(mine)), 409, "PRACTICE_SESSION_NOT_ACTIVE");
    expect(db.tables.practice_session_results).toHaveLength(0);
  });

  it("answers 409 DRILL_NOT_FOUND for a non-canonical drill", async () => {
    const session = await seedSession();
    await expectError(
      await recordResult(post(BASE, { drillId: MISSING_DRILL, attempts: 1 }, KEY_1), sid(session)),
      409,
      "DRILL_NOT_FOUND",
    );
    expect(db.tables.practice_session_results).toHaveLength(0);
  });

  it("refuses a plan item from another plan, a mismatched drill, or an item in an unplanned session", async () => {
    const plan = await seedPlan();
    const otherPlan = await seedPlan(CALLER_ID, KEY_2);
    const session = await seedSession(CALLER_ID, { planId: plan.id });
    const cases = [
      { planItemId: otherPlan.items[0].id, drillId: DRILL_A, attempts: 1 },
      { planItemId: plan.items[0].id, drillId: DRILL_B, attempts: 1 },
    ];
    let n = 100;
    for (const body of cases) {
      await expectError(await recordResult(post(BASE, body, key(n++)), sid(session)), 400, "VALIDATION_ERROR");
    }
    await completeSession(post(BASE, { outcome: "completed" }), sid(session));
    const unplanned = await seedSession(CALLER_ID, {}, KEY_1);
    await expectError(
      await recordResult(post(BASE, { planItemId: plan.items[0].id, drillId: DRILL_A, attempts: 1 }, key(n++)), sid(unplanned)),
      400,
      "VALIDATION_ERROR",
    );
    expect(db.tables.practice_session_results).toHaveLength(0);
  });

  it("refuses malformed results before calling the function", async () => {
    const session = await seedSession();
    const bad: unknown[] = [
      { drillId: DRILL_A },
      { drillId: DRILL_A, note: "   " },
      { drillId: DRILL_A, attempts: -1 },
      { drillId: DRILL_A, attempts: 1001 },
      { drillId: DRILL_A, attempts: 1.5 },
      { drillId: DRILL_A, attempts: 3, successes: 4 },
      { drillId: DRILL_A, successes: 1 },
      { drillId: DRILL_A, selfRating: 0 },
      { drillId: DRILL_A, selfRating: 6 },
      { drillId: DRILL_A, note: "x".repeat(1001) },
      { drillId: "nope", attempts: 1 },
      { attempts: 1 },
      { drillId: DRILL_A, attempts: 1, evidenceType: "measured" },
      { drillId: DRILL_A, attempts: 1, userId: OTHER_ID },
    ];
    for (const body of bad) {
      await expectError(await recordResult(post(BASE, body, KEY_1), sid(session)), 400, "VALIDATION_ERROR");
    }
    await expectError(await recordResult(post(BASE, { drillId: DRILL_A, attempts: 1 }), sid(session)), 400, "VALIDATION_ERROR");
    expect(db.calls.filter((c) => c.kind === "rpc")).toEqual([]);
  });

  it("maps function errors to 409 (foreign key) or 503 (anything else) without leaking text", async () => {
    const session = await seedSession();
    db.failures.push((c) => (c.kind === "rpc" ? { code: "23503", message: "fk" } : undefined));
    await expectError(
      await recordResult(post(BASE, { drillId: DRILL_A, attempts: 1 }, KEY_1), sid(session)),
      409,
      "DRILL_NOT_FOUND",
    );
    db.failures.length = 0;
    db.failures.push((c) => (c.kind === "rpc" ? { code: "XX000", message: "secret-detail" } : undefined));
    const response = await recordResult(post(BASE, { drillId: DRILL_A, attempts: 1 }, KEY_2), sid(session));
    expect(await response.clone().text()).not.toContain("secret-detail");
    await expectError(response, 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── Complete ─────────────────────────────────────────────────────────────────

describe("POST /api/v1/practice/sessions/{sessionId}/complete", () => {
  it("ends the caller's session with one guarded elevated update", async () => {
    const session = await seedSession();
    const response = await completeSession(post(BASE, { outcome: "completed" }), sid(session));
    expect(response.status).toBe(200);
    const { data } = await json(response);
    expect(data.session.status).toBe("completed");
    expect(typeof data.session.endedAt).toBe("string");
    const updates = writes();
    expect(updates).toHaveLength(1);
    expect(updates[0].who).toBe("admin");
    expect(updates[0].filters).toEqual([
      ["id", session],
      ["user_id", CALLER_ID],
      ["status", "in_progress"],
    ]);
    expect(Object.keys(updates[0].payload as Row).sort()).toEqual(["ended_at", "status"]);
  });

  it("repeats the same outcome with 200 and refuses a different one with 409", async () => {
    const session = await seedSession();
    await completeSession(post(BASE, { outcome: "abandoned" }), sid(session));
    resetCalls();
    const same = await completeSession(post(BASE, { outcome: "abandoned" }), sid(session));
    expect(same.status).toBe(200);
    expect((await json(same)).data.session.status).toBe("abandoned");
    await expectError(
      await completeSession(post(BASE, { outcome: "completed" }), sid(session)),
      409,
      "PRACTICE_SESSION_NOT_ACTIVE",
    );
    expect(writes()).toEqual([]);
  });

  it("answers 404 for another golfer's session and never writes it", async () => {
    const theirs = await seedSession(OTHER_ID);
    await expectError(
      await completeSession(post(BASE, { outcome: "completed" }), sid(theirs)),
      404,
      "PRACTICE_SESSION_NOT_FOUND",
    );
    expect(writes()).toEqual([]);
    expect(db.tables.practice_sessions[0].status).toBe("in_progress");
  });

  it("refuses an unknown outcome", async () => {
    const session = await seedSession();
    const bad: unknown[] = [{}, { outcome: "in_progress" }, { outcome: "done" }, { outcome: "completed", endedAt: "x" }];
    for (const body of bad) {
      await expectError(await completeSession(post(BASE, body), sid(session)), 400, "VALIDATION_ERROR");
    }
    await expectError(await completeSession(post(BASE, undefined), sid(session)), 400, "VALIDATION_ERROR");
    expect(writes()).toEqual([]);
  });

  it("never ends a session before it started, even when this server's clock trails", async () => {
    const session = await seedSession();
    const startedAt = db.tables.practice_sessions[0].started_at as string;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(startedAt) - 60_000));
    const response = await completeSession(post(BASE, { outcome: "completed" }), sid(session));
    vi.useRealTimers();
    expect(response.status).toBe(200);
    expect((await json(response)).data.session.endedAt).toBe(startedAt);
  });

  it("answers from one re-read when a concurrent request ends it first", async () => {
    const session = await seedSession();
    db.failures.push((c) => {
      if (c.kind === "update") {
        Object.assign(db.tables.practice_sessions[0], { status: "abandoned", ended_at: "2026-09-30T23:00:00.000Z" });
      }
      return undefined;
    });
    await expectError(
      await completeSession(post(BASE, { outcome: "completed" }), sid(session)),
      409,
      "PRACTICE_SESSION_NOT_ACTIVE",
    );
  });
});

// ─── End to end ───────────────────────────────────────────────────────────────

describe("practice loop — plan, practise, complete, progress", () => {
  it("counts only completed sessions and never reports a percentage", async () => {
    const plan = await seedPlan();
    const [first, second] = plan.items;
    let n = 200;
    const record = (session: string, body: Record<string, unknown>) =>
      recordResult(post(BASE, body, key(n++)), sid(session));

    const s1 = await seedSession(CALLER_ID, { planId: plan.id }, KEY_1);
    await record(s1, { planItemId: first.id, drillId: DRILL_A, attempts: 10, successes: 4 });
    await record(s1, { planItemId: first.id, drillId: DRILL_A, selfRating: 3 });
    await completeSession(post(BASE, { outcome: "completed" }), sid(s1));

    const s2 = await seedSession(CALLER_ID, { planId: plan.id }, KEY_2);
    await record(s2, { planItemId: first.id, drillId: DRILL_A, attempts: 50, successes: 50 });
    await completeSession(post(BASE, { outcome: "abandoned" }), sid(s2));

    const s3 = await seedSession(CALLER_ID, { planId: plan.id }, KEY_3);
    await record(s3, { planItemId: first.id, drillId: DRILL_A, attempts: 6, successes: 5 });
    await record(s3, { planItemId: second.id, drillId: DRILL_B, note: "felt smooth" });
    await completeSession(post(BASE, { outcome: "completed" }), sid(s3));

    expect(db.tables.practice_session_results).toHaveLength(5);

    const { data } = await json(await getPlan(new Request(BASE), { params: { planId: plan.id } }));
    const [p1, p2] = data.plan.progress;
    expect(p1).toMatchObject({ planItemId: first.id, completedSessionCount: 2, totalAttempts: 16, totalSuccesses: 9 });
    expect(p2).toMatchObject({ planItemId: second.id, completedSessionCount: 1, totalAttempts: null, totalSuccesses: null });
    expect(typeof p2.lastPracticedAt).toBe("string");
    expect(Object.keys(p1).sort()).toEqual([
      "completedSessionCount",
      "drillId",
      "lastPracticedAt",
      "planItemId",
      "totalAttempts",
      "totalSuccesses",
    ]);
  });
});
