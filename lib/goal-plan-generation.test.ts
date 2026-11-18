import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AG-S1 — the goal-plan boundary, driven through the two Server Actions exactly as the goals UI calls them.
 *
 * Everything outside the boundary is a stand-in: a caller-scoped Supabase client over an in-memory `user_goals`
 * table (with scripted insert, update and read responses), the OpenAI SDK (scripted answers; constructor
 * options recorded), Supabase Auth verification, and the clock (Vitest fake Date). No network, database or
 * provider is reached.
 *
 * Test names carry their purpose:
 *   [behavior]  shape-neutral: they inspect what the golfer would be shown, what was written, what was logged and
 *               what reached the provider — never the new result fields — so they also run against the accepted
 *               (pre-S1) actions as the behaviour control, where they must fail for the behaviour named.
 *   [preserve]  shape-neutral properties the accepted code already had (they pass on both; not counted as controls).
 *   [taxonomy]  the new outcome codes and fixed copy. Most fail on the accepted actions only because those return a
 *               different shape; some pass there. Either way they are not counted as behaviour controls.
 *   [guard]     source and constant checks on the new module.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const USER = "00000000-0000-4000-8000-0000000000a1";
  return {
    USER,
    rec: { queries: [] as Array<Record<string, unknown>>, ctor: [] as Array<Record<string, unknown>>, calls: [] as Array<Record<string, unknown>>, callOptions: [] as unknown[] },
    env: {
      auth: "ok" as "ok" | "absent" | "invalid" | "unavailable" | "throw" | "redirect",
      expInSec: 3600 as number | null | "text",
      provider: (() => Promise.resolve({})) as (params: Record<string, unknown>) => Promise<unknown>,
      client: null as unknown,
    },
  };
});

vi.mock("@/utils/supabase/server", () => ({
  // the accepted actions build their own client and ask Auth; the S1 boundary uses the verified-caller helper
  createClient: vi.fn(async () => h.env.client),
  resolveVerifiedAuth: vi.fn(async () => {
    if (h.env.auth === "throw") throw new Error("synthetic auth client failure");
    if (h.env.auth === "redirect") throw REDIRECT;
    switch (h.env.auth) {
      case "ok": return { status: "authenticated", userId: h.USER, email: EMAIL, accessToken: token(h.env.expInSec), client: h.env.client, source: "cookie" };
      case "unavailable": return { status: "verification_unavailable" };
      default: return { status: h.env.auth };
    }
  }),
  getServerSession: vi.fn(async () => null),
}));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat: unknown;
    constructor(options: Record<string, unknown>) {
      h.rec.ctor.push(options);
      this.chat = { completions: { create: (params: Record<string, unknown>, options?: unknown) => { h.rec.calls.push(params); h.rec.callOptions.push(options); return h.env.provider(params); } } };
    }
  }
  return { default: FakeOpenAI };
});

import { generateSyllabus, submitGoals } from "@/app/(dashboard)/goals/actions";

// ── synthetic data ────────────────────────────────────────────────────────────────────────────────────
const USER = h.USER;
const EMAIL = "golfer-s1@example.invalid";
const FULL_NAME = "Synthetic Golfer Sixty";
const GOAL = "a0000000-0000-4000-8000-000000000001";
const NEW_GOAL = "a0000000-0000-4000-8000-000000000002";
const ANSWER_TEXT = "Break 85 at Pebble Creek by October";
const RAW_DB = 'permission denied for table "user_goals" (synthetic 42501)';
const RAW_PROVIDER = "provider exploded: rate limit org-synthetic sk-synthetic-0000";
const RAW = /permission denied|42501|PGRST|fetch failed|TypeError|socket|provider exploded|org-synthetic|sk-synthetic|AI service error|JWT expired/i;
/** What Next.js throws for redirect(): control flow, which must pass through untouched (I10). */
const REDIRECT = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });

const plan = (summary: string, drill: string) => ({
  summary,
  weeks: [1, 2, 3, 4].map((week) => ({
    week,
    theme: `Week ${week} theme`,
    focus: "Strike",
    drills: [{ name: `${drill} ${week}`, description: "Swing through the gate.", duration: "20 min", category: "irons" }],
    weekly_goal: "Seven of ten centred strikes.",
    pro_tip: "Slow the takeaway.",
  })),
});
const G = plan("Generated plan G: a four-week build.", "Gate Drill G");
const V = plan("Previously saved plan V.", "Ladder Drill V");
const Q = plan("Concurrently stored plan Q.", "Clock Drill Q");

interface Row { id: string; user_id: string; handicap_baseline: number | null; primary_miss: string | null; target_goal: string | null; ai_syllabus: unknown; created_at: string }
let store: Row[];
const sc = {
  goalRead: "store" as "store" | "error" | "throw" | "redirect",
  insert: "ok" as "ok" | "rejected" | "status0" | "5xx" | "throw" | "zero" | "unauthorized" | "redirect",
  write: "apply" as "apply" | "zero" | "error" | "lost" | "throw" | "transform" | "replace_after" | "expired" | "row_deleted" | "redirect" | "late" | "gateway504" | "aborted_row_gone",
  readback: "store" as "store" | "error" | "throw" | "legacy_string" | "extra_fields" | "redirect",
  advanceOnGoalRead: 0,
  advanceOnInsert: 0,
  pendingLate: null as null | { id: string; value: unknown },
};

function token(expInSec: number | null | "text") {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload: Record<string, unknown> = { sub: USER, role: "authenticated" };
  if (expInSec === "text") payload.exp = "soon";
  else if (expInSec !== null) payload.exp = Math.floor(Date.now() / 1000) + expInSec;
  return `${enc({ alg: "none" })}.${enc(payload)}.synthetic-signature`;
}

type Q = { table: string; method: "select" | "insert" | "update"; payload?: Record<string, unknown>; cols?: string; single?: boolean; ops: unknown[][] };
function shape(q: Q, rows: unknown[]) {
  if (!q.single) return { data: rows, error: null, status: 200 };
  return rows.length === 1
    ? { data: rows[0], error: null, status: 200 }
    : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null }, status: 406 };
}
async function respond(q: Q): Promise<unknown> {
  const eq = Object.fromEntries(q.ops.filter((o) => o[0] === "eq").map((o) => [o[1], o[2]]));
  const matches = () => store.filter((r) => r.id === eq.id && (!("user_id" in eq) || r.user_id === eq.user_id));
  if (q.method === "insert") {
    if (sc.advanceOnInsert) vi.setSystemTime(Date.now() + sc.advanceOnInsert);
    switch (sc.insert) {
      case "ok": {
        store.push({ ...(q.payload as Omit<Row, "id" | "ai_syllabus" | "created_at">), id: NEW_GOAL, ai_syllabus: null, created_at: new Date(Date.now()).toISOString() } as Row);
        return shape(q, [{ id: NEW_GOAL }]);
      }
      case "rejected": return { data: null, error: { code: "42501", message: RAW_DB, details: null, hint: null }, status: 403 };
      case "status0": return { data: null, error: { code: "", message: "TypeError: fetch failed (synthetic)", details: "", hint: "" }, status: 0 };
      case "5xx": return { data: null, error: { code: "PGRST000", message: "synthetic upstream 503" }, status: 503 };
      case "throw": throw new Error("synthetic socket hang up");
      case "unauthorized": return { data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 };
      case "redirect": throw REDIRECT;
      default: return shape(q, []);
    }
  }
  if (q.method === "update") {
    const apply = (value: unknown) => matches().forEach((r) => { r.ai_syllabus = value; });
    const ids = () => matches().map((r) => ({ id: r.id }));
    switch (sc.write) {
      case "apply": apply(q.payload!.ai_syllabus); return shape(q, ids());
      case "zero": return shape(q, []);
      case "error": return { data: null, error: { code: "42501", message: RAW_DB }, status: 403 };
      case "lost": apply(q.payload!.ai_syllabus); return { data: null, error: { code: "", message: "TypeError: fetch failed (synthetic)" }, status: 0 };
      case "throw": throw new Error("synthetic socket hang up");
      case "transform": apply(Q); return shape(q, ids());
      case "replace_after": { apply(q.payload!.ai_syllabus); const out = shape(q, ids()); apply(Q); return out; }
      case "expired": return { data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 };
      case "row_deleted": store = store.filter((r) => r.id !== eq.id); return shape(q, []); // removed concurrently (another tab)
      case "redirect": throw REDIRECT;
      // the client gave up at its deadline (postgrest-js answers status 0); the statement commits after the readback
      case "late": sc.pendingLate = { id: String(eq.id), value: q.payload!.ai_syllabus }; return { data: null, error: { code: "20", message: "AbortError: signal timed out" }, status: 0 };
      case "gateway504": return { data: null, error: { code: "", message: "<html>504 Gateway Time-out</html>" }, status: 504 };
      case "aborted_row_gone": store = store.filter((r) => r.id !== eq.id); return { data: null, error: { code: "20", message: "AbortError: signal timed out" }, status: 0 };
    }
  }
  // reads: the readback filters by id; the discovery read does not
  const readback = "id" in eq;
  const mode = readback ? sc.readback : sc.goalRead;
  if (!readback && sc.advanceOnGoalRead) vi.setSystemTime(Date.now() + sc.advanceOnGoalRead);
  if (mode === "error") return { data: null, error: { code: "PGRST000", message: RAW_DB }, status: 500 };
  if (mode === "throw") throw new Error("synthetic read socket closed");
  if (mode === "redirect") throw REDIRECT;
  const limit = (q.ops.find((o) => o[0] === "limit")?.[1] as number | undefined) ?? 1000;
  const rows = store
    .filter((r) => (!("user_id" in eq) || r.user_id === eq.user_id) && (!("id" in eq) || r.id === eq.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
  const cols = String(q.cols ?? "*").split(",").map((c) => c.trim());
  const projected = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c] = (r as unknown as Record<string, unknown>)[c];
    if (mode === "legacy_string" && cols.includes("ai_syllabus")) out.ai_syllabus = JSON.stringify(r.ai_syllabus);
    if (mode === "extra_fields" && cols.includes("ai_syllabus") && r.ai_syllabus && typeof r.ai_syllabus === "object") {
      out.ai_syllabus = { ...(r.ai_syllabus as object), stored_by: "a trigger", weeks: (r.ai_syllabus as typeof G).weeks.map((w) => ({ ...w, internal_note: "dropped by the display" })) };
    }
    return out;
  });
  const response = shape(q, projected);
  if (readback && sc.pendingLate) { // the late write commits only after the readback has been answered
    const late = sc.pendingLate;
    sc.pendingLate = null;
    store.filter((r) => r.id === late.id).forEach((r) => { r.ai_syllabus = late.value; });
  }
  return response;
}
function fakeClient() {
  return {
    auth: {
      getUser: async () => (h.env.auth === "ok"
        ? { data: { user: { id: USER, email: EMAIL, user_metadata: { full_name: FULL_NAME }, app_metadata: {} } }, error: null }
        : { data: { user: null }, error: { message: "Auth session missing!" } }),
    },
    from(table: string) {
      const q: Q = { table, method: "select", ops: [] };
      h.rec.queries.push(q as unknown as Record<string, unknown>);
      const builder: Record<string, unknown> = {
        select(cols: string) { q.ops.push(["select", cols]); if (q.method === "select") q.cols = cols; return builder; },
        insert(payload: Record<string, unknown>) { q.method = "insert"; q.payload = payload; return builder; },
        update(payload: Record<string, unknown>) { q.method = "update"; q.payload = payload; return builder; },
        eq(column: string, value: unknown) { q.ops.push(["eq", column, value]); return builder; },
        order(column: string, options: unknown) { q.ops.push(["order", column, options]); return builder; },
        limit(n: number) { q.ops.push(["limit", n]); return builder; },
        single() { q.ops.push(["single"]); q.single = true; return builder; },
        maybeSingle() { q.ops.push(["maybeSingle"]); q.single = true; return builder; },
        retry(enabled: boolean) { q.ops.push(["retry", enabled]); return builder; },
        abortSignal(signal: unknown) { q.ops.push(["abortSignal", signal instanceof AbortSignal]); return builder; },
        then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) { return respond(q).then(onFulfilled, onRejected); },
      };
      return builder;
    },
  };
}

// provider answers
const answer = (content: unknown, finish = "stop") => async () => ({ choices: [{ finish_reason: finish, message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
const failWith = (error: Error) => async () => { throw error; };
class APIConnectionError extends Error { constructor() { super("Connection error."); this.name = "APIConnectionError"; } }
class APIConnectionTimeoutError extends Error { constructor() { super("Request timed out."); this.name = "APIConnectionTimeoutError"; } }

// observation helpers (shape-neutral: they work on the accepted results too)
type AnyResult = Record<string, unknown>;
const shownPlan = (r: AnyResult) => (r.plan ?? r.syllabus ?? null) as { summary?: string } | null;
const updates = () => h.rec.queries.filter((q) => q.method === "update") as unknown as Q[];
const inserts = () => h.rec.queries.filter((q) => q.method === "insert") as unknown as Q[];
const reads = () => h.rec.queries.filter((q) => q.method === "select") as unknown as Q[];
const eqOf = (q: Q) => Object.fromEntries(q.ops.filter((o) => o[0] === "eq").map((o) => [o[1], o[2]]));
let logs: string[];
const form = (over: Partial<Record<"handicap_baseline" | "primary_miss" | "target_goal", string>> = {}) => {
  const fd = new FormData();
  fd.set("handicap_baseline", over.handicap_baseline ?? "12.4");
  fd.set("primary_miss", over.primary_miss ?? "Slice");
  fd.set("target_goal", over.target_goal ?? ANSWER_TEXT);
  return fd;
};
const seed = (ai_syllabus: unknown = V, over: Partial<Row> = {}) => {
  store = [{ id: GOAL, user_id: USER, handicap_baseline: 12.4, primary_miss: "Slice", target_goal: ANSWER_TEXT, ai_syllabus, created_at: "2026-11-01T00:00:00.000Z", ...over }];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T20:00:00.000Z"));
  h.rec.queries = [];
  h.rec.ctor = [];
  h.rec.calls = [];
  h.rec.callOptions = [];
  h.env.auth = "ok";
  h.env.expInSec = 3600;
  h.env.provider = answer(G);
  h.env.client = fakeClient();
  Object.assign(sc, { goalRead: "store", insert: "ok", write: "apply", readback: "store", advanceOnGoalRead: 0, advanceOnInsert: 0, pendingLate: null });
  seed();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-key-ag-s1");
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); });
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── [behavior] controls ───────────────────────────────────────────────────────────────────────────────
describe("controls and preserved properties: what the golfer is shown follows what is stored", () => {
  it("[behavior] a write that changes nothing: the generated plan is never presented; the stored plan is", async () => {
    sc.write = "zero";
    const r = (await generateSyllabus()) as unknown as AnyResult;
    expect(shownPlan(r)?.summary).not.toBe(G.summary);
    expect(shownPlan(r)?.summary).toBe(V.summary);
  });

  it("[behavior] a write path that stores something else: the stored content is shown, not the generated plan", async () => {
    sc.write = "transform";
    const r = (await generateSyllabus()) as unknown as AnyResult;
    expect(shownPlan(r)?.summary).toBe(Q.summary);
  });

  it("[behavior] a lost readback: no unconfirmed plan is presented", async () => {
    sc.readback = "error";
    const r = (await generateSyllabus()) as unknown as AnyResult;
    expect(shownPlan(r)).toBeNull();
  });

  it("[behavior] after a successful write the stored row is read back, by id and the verified owner, without library retries", async () => {
    await generateSyllabus();
    const all = h.rec.queries as unknown as Q[];
    const writeAt = all.findIndex((q) => q.method === "update");
    const readback = all.slice(writeAt + 1).find((q) => q.method === "select" && "id" in eqOf(q));
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(readback).toBeDefined();
    expect(eqOf(readback!)).toEqual({ id: GOAL, user_id: USER });
    expect(readback!.ops).toContainEqual(["retry", false]);
  });

  it("[behavior] every read is built with .retry(false) (installed postgrest-js retries GETs by default)", async () => {
    await generateSyllabus();
    expect(reads().length).toBeGreaterThan(0);
    for (const q of reads()) expect(q.ops).toContainEqual(["retry", false]);
  });

  it("[behavior] the plan update is filtered by the row id and the verified owner, and writes only ai_syllabus", async () => {
    await generateSyllabus();
    expect(updates()).toHaveLength(1);
    expect(eqOf(updates()[0])).toEqual({ id: GOAL, user_id: USER });
    expect(Object.keys(updates()[0].payload!)).toEqual(["ai_syllabus"]);
  });

  it("[behavior] the provider client is built with no SDK retries, the chosen timeout and warn-level SDK logging; the call carries an abort signal", async () => {
    await generateSyllabus();
    expect(h.rec.ctor).toHaveLength(1);
    expect(h.rec.ctor[0].maxRetries).toBe(0);
    expect(h.rec.ctor[0].timeout).toBe(11_000);
    expect(h.rec.ctor[0].logLevel).toBe("warn"); // overrides OPENAI_LOG, so request bodies (answers) are never debug-logged
    expect((h.rec.callOptions[0] as { signal?: unknown } | undefined)?.signal).toBeInstanceOf(AbortSignal); // bounds the body read too
  });

  it("[behavior] every database step carries a deadline (abort signal)", async () => {
    await submitGoals(form());
    const qs = h.rec.queries as unknown as Q[];
    expect(qs.length).toBeGreaterThanOrEqual(1);
    for (const q of qs) expect(q.ops).toContainEqual(["abortSignal", true]);
    expect(qs.length).toBeGreaterThanOrEqual(3); // insert, write, readback
  });

  it("[behavior] a finish other than 'stop' (length) is not written", async () => {
    h.env.provider = answer(G, "length");
    await generateSyllabus();
    expect(updates()).toHaveLength(0);
  });

  it("[behavior] provider error text never reaches the golfer", async () => {
    h.env.provider = failWith(new Error(RAW_PROVIDER));
    const r = await generateSyllabus();
    expect(JSON.stringify(r)).not.toMatch(RAW);
  });

  it("[behavior] database error text never reaches the golfer (submit rejected by the database)", async () => {
    sc.insert = "rejected";
    const r = await submitGoals(form());
    expect(JSON.stringify(r)).not.toMatch(RAW);
  });

  it("[behavior] a lost insert response is never reported as a plain failure", async () => {
    sc.insert = "status0";
    const r = (await submitGoals(form())) as unknown as AnyResult;
    const said = JSON.stringify(r);
    expect(said).not.toMatch(RAW);
    expect(said).toMatch(/couldn't confirm/i);
  });

  it("[behavior] no personal data, answers, plan content or raw text in logs", async () => {
    await submitGoals(form());
    sc.write = "error";
    await generateSyllabus();
    const all = logs.join("\n");
    for (const forbidden of [EMAIL, FULL_NAME, USER, ANSWER_TEXT, G.summary, "Gate Drill G", RAW_DB]) expect(all).not.toContain(forbidden);
  });

  it.each([
    ["an out-of-range handicap", { handicap_baseline: "99" }],
    ["a handicap that is not a number", { handicap_baseline: "12abc" }],
    ["a miss outside the five options", { primary_miss: "Shank" }],
    ["a goal over 500 characters", { target_goal: "x".repeat(501) }],
  ])("[behavior] %s: nothing is inserted and the provider is not called", async (_, over) => {
    await submitGoals(form(over));
    expect(inserts()).toHaveLength(0);
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[behavior] the session expires within the call window: the provider is not called", async () => {
    h.env.expInSec = 5;
    await generateSyllabus();
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[behavior] a token without a numeric exp: the provider is not called", async () => {
    h.env.expInSec = "text";
    await generateSyllabus();
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[behavior] the function budget runs out during the earlier reads: the provider is not called", async () => {
    sc.advanceOnGoalRead = 10_000;
    await generateSyllabus();
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[preserve] the insert carries exactly user_id and the three answers (user_id from verified identity)", async () => {
    await submitGoals(form());
    expect(inserts()).toHaveLength(1);
    expect(Object.keys(inserts()[0].payload!).sort()).toEqual(["handicap_baseline", "primary_miss", "target_goal", "user_id"]);
    expect(inserts()[0].payload!.user_id).toBe(USER);
  });

  it("[preserve] a provider failure attempts no write", async () => {
    h.env.provider = failWith(new APIConnectionError());
    await generateSyllabus();
    expect(updates()).toHaveLength(0);
  });
});

// ── [taxonomy] outcomes and copy ──────────────────────────────────────────────────────────────────────
describe("[taxonomy] generation outcomes decided by the content readback", () => {
  it("[taxonomy] saved: the displayed form of the stored plan equals the generated plan; the persisted plan is returned", async () => {
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "saved", display: "stored_plan", observed: true, message: "Your new plan is saved." });
    expect(r.plan?.summary).toBe(G.summary);
    expect(h.rec.calls).toHaveLength(1);
  });

  it("[taxonomy] a legacy JSON-string value equal to the generated plan is saved (readLatestGoal parses it)", async () => {
    sc.readback = "legacy_string";
    expect((await generateSyllabus()).outcome).toBe("saved");
  });

  it("[taxonomy] stored content differing only in fields the display drops is saved (the displayed plan matched)", async () => {
    sc.readback = "extra_fields";
    const r = await generateSyllabus();
    expect(r.outcome).toBe("saved");
    expect(JSON.stringify(r.plan)).not.toContain("internal_note");
  });

  it("[taxonomy] the write reports an error but the readback shows the generated plan: saved, by observation", async () => {
    sc.write = "lost";
    expect((await generateSyllabus()).outcome).toBe("saved");
  });

  it("[taxonomy] the write reports one row but a transforming path stored something else: other_plan_stored, never saved", async () => {
    sc.write = "transform";
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "other_plan_stored", display: "stored_plan", message: "Your new plan isn't the plan saved now. This is your saved plan." });
    expect(r.plan?.summary).toBe(Q.summary);
  });

  it("[taxonomy] a concurrent writer replaces the plan between write and readback: other_plan_stored with the neutral copy", async () => {
    sc.write = "replace_after";
    const r = await generateSyllabus();
    expect(r.outcome).toBe("other_plan_stored");
    expect(r.plan?.summary).toBe(Q.summary);
  });

  it("[taxonomy] a rejected write with the previous plan still stored: other_plan_stored showing that plan", async () => {
    sc.write = "zero";
    const r = await generateSyllabus();
    expect(r.outcome).toBe("other_plan_stored");
    expect(r.plan?.summary).toBe(V.summary);
  });

  it("[taxonomy] no plan stored after the attempt: no_plan_stored", async () => {
    seed(null);
    sc.write = "zero";
    expect(await generateSyllabus()).toMatchObject({ outcome: "no_plan_stored", display: "no_plan", plan: null, message: "No plan is saved for this goal right now. Your new plan wasn't confirmed." });
  });

  it("[taxonomy] a malformed stored plan: stored_plan_unreadable", async () => {
    sc.write = "zero";
    seed({ summary: { text: "x" }, weeks: "four" });
    expect(await generateSyllabus()).toMatchObject({ outcome: "stored_plan_unreadable", display: "unreadable", plan: null });
  });

  it("[taxonomy] the row is gone at readback: goal_missing", async () => {
    sc.write = "row_deleted";
    expect(await generateSyllabus()).toMatchObject({ outcome: "goal_missing", display: "goal_missing", plan: null, message: "We couldn't find this goal. Open My Goals." });
  });

  it.each([
    ["a read error", "error"],
    ["a thrown read", "throw"],
  ] as const)("[taxonomy] %s at readback: save_unconfirmed (never 'nothing saved'); the last verified plan is kept", async (_, mode) => {
    sc.readback = mode;
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "save_unconfirmed", display: "keep", plan: null, observed: true });
    expect(r.message).toBe("We couldn't confirm whether your new plan was saved. Reload My Plan to see what's saved.");
    expect(JSON.stringify(r)).not.toMatch(/nothing (new )?was saved|wasn't saved/i);
  });

  it("[taxonomy] expiry between the call and the write: the write fails and the readback is unavailable, so save_unconfirmed", async () => {
    sc.write = "expired";
    sc.readback = "error";
    expect((await generateSyllabus()).outcome).toBe("save_unconfirmed");
  });

  it("[taxonomy] the write throws (no response) and the readback shows the old plan: save_unconfirmed, last verified plan kept", async () => {
    sc.write = "throw";
    expect(await generateSyllabus()).toMatchObject({ outcome: "save_unconfirmed", display: "keep", plan: null });
  });

  it("[taxonomy] the write is aborted at its deadline and commits after the readback: save_unconfirmed, never 'isn't the plan saved now'", async () => {
    sc.write = "late";
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "save_unconfirmed", display: "keep", plan: null, message: "We couldn't confirm whether your new plan was saved. Reload My Plan to see what's saved." });
    expect(store[0].ai_syllabus).toEqual(G); // what a reload would now show
  });

  it("[taxonomy] the write is aborted, nothing was stored before, and it commits late: save_unconfirmed, not 'no plan' (no invitation to pay again)", async () => {
    seed(null);
    sc.write = "late";
    expect(await generateSyllabus()).toMatchObject({ outcome: "save_unconfirmed", display: "keep" });
  });

  it("[taxonomy] the write gets a 504 from the gateway and the readback shows the old plan: save_unconfirmed", async () => {
    sc.write = "gateway504";
    expect(await generateSyllabus()).toMatchObject({ outcome: "save_unconfirmed", display: "keep" });
  });

  it("[taxonomy] the write is definitely rejected (403 with a PostgREST code): the readback decides, other_plan_stored", async () => {
    sc.write = "error";
    expect(await generateSyllabus()).toMatchObject({ outcome: "other_plan_stored", display: "stored_plan" });
  });

  it("[taxonomy] the write is aborted and the row is gone: goal_missing (an update cannot bring it back)", async () => {
    sc.write = "aborted_row_gone";
    expect((await generateSyllabus()).outcome).toBe("goal_missing");
  });

  it.each([
    ["late", "no_response"],
    ["gateway504", "error"],
    ["error", "rejected"],
    ["zero", "zero_rows"],
  ] as const)("[taxonomy] write mode %s is logged as writeResponse %s", async (mode, logged) => {
    sc.write = mode;
    await generateSyllabus();
    const entry = JSON.parse(logs.filter((l) => l.startsWith("[goal-plan] "))[0].slice("[goal-plan] ".length));
    expect(entry.writeResponse).toBe(logged);
  });
});

describe("[taxonomy] refusals before any call", () => {
  const cases: Array<[string, () => void, string, string]> = [
    ["no session", () => { h.env.auth = "absent"; }, "not_authenticated", "Please sign in again."],
    ["a rejected session", () => { h.env.auth = "invalid"; }, "not_authenticated", "Please sign in again."],
    ["an Auth outage", () => { h.env.auth = "unavailable"; }, "auth_unavailable", "We couldn't check your sign-in right now. Try again shortly."],
    ["no goal", () => { store = []; }, "no_goal", "Set your goals first."],
    ["a failed goal read", () => { sc.goalRead = "error"; }, "goal_unavailable", "We couldn't load your goals."],
    ["a thrown goal read", () => { sc.goalRead = "throw"; }, "goal_unavailable", "We couldn't load your goals."],
    ["stored answers out of bounds", () => { seed(V, { target_goal: "y".repeat(501) }); }, "invalid_input", "Your saved answers can't be used for a plan. Set new goals to build one."],
    ["the session expiring", () => { h.env.expInSec = 5; }, "time_insufficient", "Please sign in again, then try."],
    ["no numeric exp", () => { h.env.expInSec = null; }, "time_insufficient", "Please sign in again, then try."],
    ["the function budget spent", () => { sc.advanceOnGoalRead = 10_000; }, "time_insufficient", "Please try again."],
    ["no provider key", () => { vi.stubEnv("OPENAI_API_KEY", ""); }, "provider_not_configured", "Plan generation is unavailable right now."],
  ];
  it.each(cases)("[taxonomy] %s: %s with 0 provider calls and no write", async (_, arrange, outcome, message) => {
    arrange();
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome, message, display: "keep", plan: null, observed: false });
    expect(h.rec.calls).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });
});

describe("[taxonomy] provider failures: billing unknown, no write", () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["a connection error", failWith(new APIConnectionError())],
    ["a timeout (the SDK aborts at the configured timeout)", failWith(new APIConnectionTimeoutError())],
    ["another error", failWith(new Error(RAW_PROVIDER))],
    ["finish_reason length", answer(G, "length")],
    ["content that is not JSON", answer("{not json")],
    ["a plan the display rules reject", answer({ summary: 42, weeks: [] })],
    ["a refusal (no content)", async () => ({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] })],
  ];
  it.each(cases)("[taxonomy] %s: provider_failed", async (_, behaviour) => {
    h.env.provider = behaviour as never;
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "provider_failed", display: "keep", plan: null, message: "We couldn't create a new plan. Nothing new was saved from this attempt." });
    expect(h.rec.calls).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  it("[taxonomy] two invocations are independent: two calls (S1 is not a single-flight)", async () => {
    await Promise.all([generateSyllabus(), generateSyllabus()]);
    expect(h.rec.calls).toHaveLength(2);
  });

  it("[taxonomy] the request uses the same model and strict schema, and caps output tokens", async () => {
    await generateSyllabus();
    const params = h.rec.calls[0] as { model: string; max_completion_tokens: number; response_format: { json_schema: { strict: boolean } } };
    expect(params.model).toBe("gpt-4o-mini");
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(params.max_completion_tokens).toBe(4000);
  });
});

describe("[taxonomy] submit", () => {
  it("[taxonomy] a confirmed insert, then saved", async () => {
    const r = await submitGoals(form());
    expect(r).toMatchObject({ outcome: "saved", goalSaved: true, display: "stored_plan" });
    expect(updates()[0] && eqOf(updates()[0])).toEqual({ id: NEW_GOAL, user_id: USER });
  });

  it("[taxonomy] a confirmed insert and a plan that was not confirmed: goalSaved with the observed outcome", async () => {
    sc.write = "zero";
    expect(await submitGoals(form())).toMatchObject({ outcome: "no_plan_stored", goalSaved: true });
  });

  it("[taxonomy] a 4xx rejection with a PostgREST code: goal_save_failed, no call", async () => {
    sc.insert = "rejected";
    expect(await submitGoals(form())).toMatchObject({ outcome: "goal_save_failed", goalSaved: false, message: "We couldn't save your answers." });
    expect(h.rec.calls).toHaveLength(0);
  });

  it.each(["status0", "5xx", "throw", "zero"] as const)("[taxonomy] insert %s: goal_save_unconfirmed (never goal_save_failed), no call", async (mode) => {
    sc.insert = mode;
    expect(await submitGoals(form())).toMatchObject({ outcome: "goal_save_unconfirmed", goalSaved: false, message: "We couldn't confirm your answers were saved. Open My Goals to check before trying again." });
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[taxonomy] empty handicap and goal are 'not given' (stored as null), as before", async () => {
    await submitGoals(form({ handicap_baseline: "", target_goal: "   " }));
    expect(inserts()[0].payload).toMatchObject({ handicap_baseline: null, target_goal: null, primary_miss: "Slice" });
  });

  it("[taxonomy] a signed-out submit inserts nothing", async () => {
    h.env.auth = "absent";
    expect(await submitGoals(form())).toMatchObject({ outcome: "not_authenticated", goalSaved: false });
    expect(inserts()).toHaveLength(0);
  });

  it("[taxonomy] one bounded log line per action, with codes and timings only", async () => {
    await submitGoals(form());
    const lines = logs.filter((l) => l.startsWith("[goal-plan] "));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0].slice("[goal-plan] ".length));
    expect(Object.keys(entry).sort()).toEqual(["action", "entitlementGate", "outcome", "providerCalled", "providerMs", "readback", "requestId", "totalMs", "writeResponse"]);
    expect(entry).toMatchObject({ action: "submit", outcome: "saved", entitlementGate: "none", providerCalled: true, writeResponse: "one_row", readback: "plan" });
  });
});

// ── [guard] constants and source ──────────────────────────────────────────────────────────────────────
describe("[guard] the chosen constants and the module's boundaries", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("[guard] the time constants fit inside the candidate budget, and the output cap covers a maximal plan", async () => {
    const m = await import("@/lib/goal-plan-generation");
    expect(m.FUNCTION_BUDGET_MS).toBe(15_000);
    expect(m.PROVIDER_TIMEOUT_MS + m.POST_CALL_MS).toBeLessThan(m.FUNCTION_BUDGET_MS);
    expect(m.SKEW_MS).toBeGreaterThan(0);
    // a maximal plan: 4 weeks × 5 drills at the schema's described sizes; ≈3 characters per token (conservative)
    const text = (n: number) => "w".repeat(n);
    const maximal = { summary: text(400), weeks: [1, 2, 3, 4].map((week) => ({ week, theme: text(60), focus: text(80), weekly_goal: text(150), pro_tip: text(150),
      drills: Array.from({ length: 5 }, () => ({ name: text(60), description: text(250), duration: text(20), category: "short_game" })) })) };
    expect(Math.ceil(JSON.stringify(maximal).length / 3)).toBeLessThanOrEqual(m.OUTPUT_TOKEN_CAP);
  });

  it("[guard] the boundary is server-only, uses no admin client, writes no target_goal and has no retry loop", () => {
    const s = source("lib/goal-plan-generation.ts");
    expect(s.startsWith('import "server-only";')).toBe(true);
    expect(s).not.toMatch(/utils\/supabase\/admin|createAdminClient|service_role|SUPABASE_SERVICE/i);
    expect(s).not.toMatch(/update\(\{[^}]*target_goal/);
    expect(s).not.toMatch(/\bwhile\s*\(|\bfor\s*\(\s*let\s+\w+\s*=\s*0;\s*\w+\s*<\s*\w*retr/i);
    expect(s.match(/\.update\(/g)).toHaveLength(1);
    expect(s.match(/\.insert\(/g)).toHaveLength(1);
    expect(s).toContain('new OpenAI({ apiKey, maxRetries: 0, timeout: PROVIDER_TIMEOUT_MS, logLevel: "warn" })');
    expect(s).toContain("{ signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }");
    expect(s.match(/\.abortSignal\(AbortSignal\.timeout\(DB_STEP_TIMEOUT_MS\)\)/g)).toHaveLength(4); // discovery, insert, write, readback
    expect(s).not.toMatch(/expires_at|cookies\(|getServerSession/); // identity only from resolveVerifiedAuth; exp only from the verified token
    expect(s.match(/\.limit\(1\)\.retry\(false\)/g)).toHaveLength(2); // the discovery read and the readback
  });

  it("[guard] the actions are thin: no client, provider, logging or ids from the caller", () => {
    const a = source("app/(dashboard)/goals/actions.ts");
    expect(a).not.toMatch(/console\.|openai|createClient|from\(|user_id|goalId/i);
    expect(a).toMatch(/export async function submitGoals\(formData: FormData\)/);
    expect(a).toMatch(/export async function generateSyllabus\(\)/);
  });
});

// ── review additions: isolation, control flow, freshness, thresholds ─────────────────────────────────
describe("review additions: owner isolation, Next control flow, fresh clock and thresholds", () => {
  it("[preserve] another golfer's newer row is never chosen: discovery is owner-scoped, their answers never reach the provider, their row is untouched", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000000b2";
    store.push({ id: "a0000000-0000-4000-8000-0000000000f9", user_id: OTHER, handicap_baseline: 3, primary_miss: "Hook", target_goal: "OTHER GOLFER SECRET GOAL",
      ai_syllabus: Q, created_at: "2026-11-13T00:00:00.000Z" });
    await generateSyllabus();
    const discovery = reads()[0];
    expect(eqOf(discovery)).toEqual({ user_id: USER });
    expect(JSON.stringify(h.rec.calls)).not.toContain("OTHER GOLFER SECRET GOAL");
    expect(store.find((r) => r.user_id === OTHER)!.ai_syllabus).toBe(Q);
  });

  it("[taxonomy] the plan write and the readback are filtered by the goal id and the verified owner (the accepted write filtered by id only and relied on RLS)", async () => {
    await generateSyllabus();
    expect(updates()).toHaveLength(1);
    expect(eqOf(updates()[0])).toEqual({ id: GOAL, user_id: USER });
    expect(eqOf(reads()[reads().length - 1])).toEqual({ id: GOAL, user_id: USER });
  });

  it("[taxonomy] extra form fields (user_id, id, ai_syllabus) are ignored: the insert keeps exactly four keys with the verified user_id", async () => {
    const fd = form();
    fd.set("user_id", "00000000-0000-4000-8000-0000000000b2");
    fd.set("id", "a0000000-0000-4000-8000-0000000000f9");
    fd.set("ai_syllabus", JSON.stringify(Q));
    await submitGoals(fd);
    expect(Object.keys(inserts()[0].payload!).sort()).toEqual(["handicap_baseline", "primary_miss", "target_goal", "user_id"]);
    expect(inserts()[0].payload!.user_id).toBe(USER);
  });

  it("[taxonomy] an argument passed to generateSyllabus is ignored (no goal id from the client)", async () => {
    const r = await (generateSyllabus as unknown as (x: unknown) => Promise<{ outcome: string }>)({ goalId: "a0000000-0000-4000-8000-0000000000f9" });
    expect(r.outcome).toBe("saved");
    expect(eqOf(updates()[0])).toEqual({ id: GOAL, user_id: USER });
  });

  it("[taxonomy] a non-FormData argument to submitGoals is refused as invalid_input, nothing inserted", async () => {
    const r = await (submitGoals as unknown as (x: unknown) => Promise<{ outcome: string }>)({ handicap_baseline: "12" });
    expect(r.outcome).toBe("invalid_input");
    expect(inserts()).toHaveLength(0);
  });

  it("[taxonomy] a discovered row id that is not a UUID: goal_unavailable, no call", async () => {
    seed(V, { id: "not-a-uuid" });
    expect((await generateSyllabus()).outcome).toBe("goal_unavailable");
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[taxonomy] the verified-auth helper throws: auth_unavailable, never 'signed out'", async () => {
    h.env.auth = "throw";
    expect((await generateSyllabus()).outcome).toBe("auth_unavailable");
  });

  it("[taxonomy] an insert rejected with 401 and a PostgREST code: goal_save_failed, no call", async () => {
    sc.insert = "unauthorized";
    expect((await submitGoals(form())).outcome).toBe("goal_save_failed");
    expect(h.rec.calls).toHaveLength(0);
  });

  const flows: Array<[string, () => void, () => void]> = [
    ["identity", () => { h.env.auth = "redirect"; }, () => { expect(reads()).toHaveLength(0); }],
    ["the discovery read", () => { sc.goalRead = "redirect"; }, () => { expect(h.rec.calls).toHaveLength(0); }],
    ["the write", () => { sc.write = "redirect"; }, () => { expect(reads().filter((q) => "id" in eqOf(q))).toHaveLength(0); }],
    ["the readback", () => { sc.readback = "redirect"; }, () => { expect(updates()).toHaveLength(1); }],
  ];
  it.each(flows)("[taxonomy] Next control flow raised in %s passes through untouched (I10) and no later step runs", async (_, arrange, after) => {
    arrange();
    await expect(generateSyllabus()).rejects.toBe(REDIRECT);
    after();
  });

  it.each([
    ["a redirect digest", REDIRECT],
    ["a static-generation bailout code", Object.assign(new Error("provider said: bail out"), { status: 400, code: "NEXT_STATIC_GEN_BAILOUT" })],
  ])("[taxonomy] a provider error shaped like Next control flow (%s) is a provider failure: no write, fixed copy, one log line", async (_, error) => {
    h.env.provider = async () => { throw error; };
    const r = await generateSyllabus();
    expect(r).toMatchObject({ outcome: "provider_failed", message: "We couldn't create a new plan. Nothing new was saved from this attempt." });
    expect(updates()).toHaveLength(0);
    const lines = logs.filter((l) => l.startsWith("[goal-plan] "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"outcome":"provider_failed"');
    expect(logs.join("\n")).not.toContain("provider said");
  });

  it("[taxonomy] submit-context copy: a provider failure after the answers were saved says no plan was saved, not 'nothing new'", async () => {
    h.env.provider = failWith(new APIConnectionError());
    expect(await submitGoals(form())).toMatchObject({ outcome: "provider_failed", goalSaved: true, message: "We couldn't create a plan. No plan was saved from this attempt." });
  });

  it("[taxonomy] submit-context copy: another plan stored on the new row points to My Plan (no plan is on the form's screen)", async () => {
    sc.write = "transform";
    expect(await submitGoals(form())).toMatchObject({ outcome: "other_plan_stored", goalSaved: true, message: "Your new plan isn't the plan saved now. Open My Plan to see what's saved." });
  });

  it("[taxonomy] Next control flow raised by the insert passes through and nothing is generated", async () => {
    sc.insert = "redirect";
    await expect(submitGoals(form())).rejects.toBe(REDIRECT);
    expect(h.rec.calls).toHaveLength(0);
  });

  it("[taxonomy] the time decision uses a fresh clock: exp 19 s is enough at the start but not after 1 s of reads", async () => {
    h.env.expInSec = 19;
    await generateSyllabus();
    expect(h.rec.calls).toHaveLength(1); // 19 s − 5 s skew = 14 s >= 13.5 s needed
    h.rec.calls = [];
    h.env.client = fakeClient();
    seed();
    sc.advanceOnGoalRead = 1_000;
    const r = await generateSyllabus();
    expect(r.outcome).toBe("time_insufficient");
    expect(r.message).toBe("Please sign in again, then try.");
    expect(h.rec.calls).toHaveLength(0);
  });

  it.each([
    [1_500, 1], // budget left exactly 13.5 s: dispatched
    [1_501, 0], // 1 ms less: refused
  ])("[taxonomy] function-budget threshold: %i ms spent before dispatch gives %i call(s)", async (spent, calls) => {
    sc.advanceOnGoalRead = spent;
    const r = await generateSyllabus();
    expect(h.rec.calls).toHaveLength(calls);
    if (!calls) expect(r).toMatchObject({ outcome: "time_insufficient", message: "Please try again." });
  });

  it("[taxonomy] submit: time spent on the insert is counted; the goal is saved but nothing is called", async () => {
    sc.advanceOnInsert = 2_000;
    expect(await submitGoals(form())).toMatchObject({ outcome: "time_insufficient", goalSaved: true });
    expect(h.rec.calls).toHaveLength(0);
  });

  it.each([
    ["provider_failed", () => { h.env.provider = failWith(new APIConnectionError()); }],
    ["save_unconfirmed", () => { sc.readback = "error"; }],
  ] as const)("[taxonomy] submit then %s: goalSaved stays true", async (outcome, arrange) => {
    arrange();
    expect(await submitGoals(form())).toMatchObject({ outcome, goalSaved: true });
  });
});
