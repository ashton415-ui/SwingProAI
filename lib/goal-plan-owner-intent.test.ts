import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AG-WEB-READY-05-G1 — the rendered-owner restriction on both Goals entry points (save-and-generate and generate-only),
 * driven through the real Server Actions and directly through the two exported boundary functions.
 *
 * Stand-ins (no network): Supabase Auth verification (which account the request's credentials verify as; every check is
 * counted), a caller-scoped client over a two-owner in-memory `user_goals` table that behaves like the row policy (a client
 * sees and writes only its own owner's rows) and records every read, insert and update with the owner it ran as and the
 * filters it carried, and the OpenAI SDK (every construction and call recorded, with the target goal each prompt carried).
 * Assertions are on those observations — what was asked, read, written, constructed, called and returned — not on symbols.
 *
 *   [race]      A's page, B's verified request (the S3 schedule), for both entry points
 *   [negative]  missing / old-client / malformed / duplicated / tampered intent, through the actions and the core directly
 *   [positive]  matching owners (A and B), normalisation, a newer session of the same owner
 *   [lifecycle] a request verified as A that continues after the browser signs in to B; signed-out, outage, control flow,
 *               invalid answers, provider unconfigured / failing, unknown insert and readback
 *   [order]     the comparison precedes every goal operation and the provider; the log carries codes only
 *   [guard]     the required signatures and how both clients obtain the owner they send
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  ids: { A: "00000000-0000-4000-8000-00000000a0a1", B: "00000000-0000-4000-8000-00000000b0b2" } as Record<"A" | "B", string>,
  /** the account the request's credentials verify as, or an Auth outcome */
  verify: "A" as "A" | "B" | "A2" | "absent" | "invalid" | "unavailable" | "throw" | "redirect",
  ops: [] as Array<{ kind: "auth" | "read" | "insert" | "update" | "ctor" | "call"; as?: string; eq?: Record<string, unknown>; userId?: unknown; goal?: string | null }>,
  provider: "ok" as "ok" | "fail" | "hold",
  release: null as null | (() => void),
}));

const REDIRECT = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => { throw new Error("not used by the boundary"); }),
  getServerSession: vi.fn(async () => null),
  resolveVerifiedAuth: vi.fn(async () => {
    h.ops.push({ kind: "auth" });
    switch (h.verify) {
      case "throw": throw new Error("synthetic auth client failure");
      case "redirect": throw REDIRECT;
      case "unavailable": return { status: "verification_unavailable" };
      case "absent": case "invalid": return { status: h.verify };
      default: {
        const who = h.verify === "A2" ? "A" : h.verify; // A2: the same account, a newer session
        return { status: "authenticated", userId: h.ids[who], email: `${who.toLowerCase()}@example.invalid`, accessToken: token(h.ids[who], h.verify), client: clientFor(who), source: "cookie" };
      }
    }
  }),
}));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat: unknown;
    constructor() {
      h.ops.push({ kind: "ctor" });
      this.chat = { completions: { create: async (params: { messages: Array<{ content: string }> }) => {
        const goal = /Target goal: (.*)$/m.exec(params.messages[1]?.content ?? "")?.[1] ?? null;
        h.ops.push({ kind: "call", goal });
        if (h.provider === "fail") throw new Error("synthetic provider failure");
        if (h.provider === "hold") await new Promise<void>((resolve) => { h.release = resolve; });
        return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(GENERATED) } }] };
      } } };
    }
  }
  return { default: FakeOpenAI };
});

import { generateSyllabus, submitGoals } from "@/app/(dashboard)/goals/actions";
import { EXPECTED_OWNER_FIELD, PLAN_COPY, generateGoalPlan, normalizeOwnerId, submitGoalAnswers } from "@/lib/goal-plan-generation";

// ── synthetic data ────────────────────────────────────────────────────────────────────────────────────
const A = h.ids.A;
const B = h.ids.B;
const NOBODY = "00000000-0000-4000-8000-00000000c0c3"; // well-formed, nobody's
const A_TYPED = "G1 A typed answers: break 80 by spring";
const B_STORED = "G1 B stored goal: fix the driver hook";
const plan = (summary: string) => ({ summary, weeks: [1, 2, 3, 4].map((week) => ({ week, theme: `Theme ${week}`, focus: "Strike",
  drills: [{ name: `Drill ${week}`, description: "Swing through the gate.", duration: "20 min", category: "irons" }], weekly_goal: "Seven of ten.", pro_tip: "Slow the takeaway." })) });
const GENERATED = plan("G1 generated plan.");
const PLAN_A = plan("G1 saved plan of A.");
const PLAN_B = plan("G1 saved plan of B.");

function token(sub: string, session: string) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ sub, session_id: `sid-${session}`, exp: Math.floor(Date.now() / 1000) + 3600 })}.synthetic`;
}

interface Row { id: string; user_id: string; handicap_baseline: number | null; primary_miss: string | null; target_goal: string | null; ai_syllabus: unknown; created_at: string }
let rows: Row[];
const mode = { insert: "ok" as "ok" | "status0", readback: "ok" as "ok" | "error" };
const seed = () => {
  rows = [
    { id: "a0000000-0000-4000-8000-0000000000a1", user_id: A, handicap_baseline: 10, primary_miss: "Slice", target_goal: "G1 A stored goal", ai_syllabus: PLAN_A, created_at: "2026-11-20T00:00:00.000Z" },
    { id: "b0000000-0000-4000-8000-0000000000b1", user_id: B, handicap_baseline: 20, primary_miss: "Hook", target_goal: B_STORED, ai_syllabus: PLAN_B, created_at: "2026-11-21T00:00:00.000Z" },
  ];
};
const snapshot = () => JSON.stringify(rows);

/** A caller-scoped client for one owner: like the row policy, it sees and changes only that owner's rows. */
function clientFor(who: "A" | "B") {
  const owner = h.ids[who];
  return {
    from(table: string) {
      const q = { method: "select" as "select" | "insert" | "update", payload: undefined as Record<string, unknown> | undefined, eq: {} as Record<string, unknown>, cols: "*", limit: 1000 };
      const run = async () => {
        if (table !== "user_goals") return { data: [], error: null, status: 200 };
        if (q.method === "insert") {
          h.ops.push({ kind: "insert", as: who, userId: q.payload?.user_id });
          if (q.payload?.user_id !== owner) return { data: null, error: { code: "42501", message: "row-level security (synthetic)" }, status: 403 };
          if (mode.insert === "status0") return { data: null, error: { code: "", message: "TypeError: fetch failed (synthetic)" }, status: 0 };
          const id = `${who === "A" ? "a" : "b"}0000000-0000-4000-8000-0000000000${who === "A" ? "a2" : "b2"}`;
          rows.push({ ...(q.payload as Omit<Row, "id" | "ai_syllabus" | "created_at">), id, ai_syllabus: null, created_at: new Date().toISOString() } as Row);
          return { data: [{ id }], error: null, status: 201 };
        }
        const visible = rows.filter((r) => r.user_id === owner && (!("user_id" in q.eq) || r.user_id === q.eq.user_id) && (!("id" in q.eq) || r.id === q.eq.id));
        if (q.method === "update") {
          h.ops.push({ kind: "update", as: who, eq: { ...q.eq } });
          visible.forEach((r) => { r.ai_syllabus = q.payload!.ai_syllabus; });
          return { data: visible.map((r) => ({ id: r.id })), error: null, status: 200 };
        }
        h.ops.push({ kind: "read", as: who, eq: { ...q.eq } });
        if ("id" in q.eq && mode.readback === "error") return { data: null, error: { code: "PGRST000", message: "synthetic" }, status: 500 };
        const out = [...visible].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, q.limit)
          .map((r) => Object.fromEntries(q.cols.split(",").map((c) => c.trim()).map((c) => [c, (r as unknown as Record<string, unknown>)[c]])));
        return { data: out, error: null, status: 200 };
      };
      const b: Record<string, unknown> = {
        select(cols: string) { if (q.method === "select") q.cols = cols; return b; },
        insert(p: Record<string, unknown>) { q.method = "insert"; q.payload = p; return b; },
        update(p: Record<string, unknown>) { q.method = "update"; q.payload = p; return b; },
        eq(c: string, v: unknown) { q.eq[c] = v; return b; },
        order() { return b; },
        limit(n: number) { q.limit = n; return b; },
        retry() { return b; },
        abortSignal() { return b; },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) { return Promise.resolve().then(run).then(ok, bad); },
      };
      return b;
    },
  };
}

const form = (intent: unknown[] | "none", over: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("handicap_baseline", over.handicap_baseline ?? "8.5");
  fd.set("primary_miss", over.primary_miss ?? "Fat");
  fd.set("target_goal", over.target_goal ?? A_TYPED);
  if (intent !== "none") for (const v of intent) fd.append(EXPECTED_OWNER_FIELD, v as string | Blob);
  return fd;
};
const kinds = () => h.ops.map((o) => o.kind);
const goalOps = () => h.ops.filter((o) => o.kind === "read" || o.kind === "insert" || o.kind === "update");
const providerOps = () => h.ops.filter((o) => o.kind === "ctor" || o.kind === "call");
let logs: string[];
const until = async (pred: () => boolean) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 0)); return pred(); };

beforeEach(() => {
  vi.useRealTimers();
  h.verify = "A";
  h.ops = [];
  h.provider = "ok";
  h.release = null;
  Object.assign(mode, { insert: "ok", readback: "ok" });
  seed();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-key-g1");
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── [race] ────────────────────────────────────────────────────────────────────────────────────────────
describe("[race] a page rendered for A, a request whose credentials verify as B (the S3 schedule)", () => {
  it("[race] save-and-generate: refused after the one credential check, before any goal read/write or provider work; neither owner's rows change", async () => {
    h.verify = "B";
    const before = snapshot();
    const r = await submitGoals(form([A]));
    expect(r).toEqual({ outcome: "owner_mismatch", message: PLAN_COPY.owner_mismatch, display: "keep", plan: null, observed: false, goalSaved: false });
    expect(kinds()).toEqual(["auth"]);
    expect(snapshot()).toBe(before);
    expect(rows.filter((x) => x.target_goal === A_TYPED)).toEqual([]); // A's typed answers were not saved for anyone
  });

  it("[race] generate-only (B has a real goal): refused after the one credential check; B's goal is not read, no plan is generated or returned, nothing changes", async () => {
    h.verify = "B";
    const before = snapshot();
    const r = await generateSyllabus(A);
    expect(r).toEqual({ outcome: "owner_mismatch", message: PLAN_COPY.owner_mismatch, display: "keep", plan: null, observed: false });
    expect(kinds()).toEqual(["auth"]);
    expect(providerOps()).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("[race] the same holds when the boundary is called directly (not through the action)", async () => {
    h.verify = "B";
    expect((await submitGoalAnswers(form([A]))).outcome).toBe("owner_mismatch");
    expect((await generateGoalPlan(A)).outcome).toBe("owner_mismatch");
    expect(kinds()).toEqual(["auth", "auth"]);
  });
});

// ── [negative] ────────────────────────────────────────────────────────────────────────────────────────
describe("[negative] intent that is missing or unusable is refused before Auth is asked: no fallback to the cookie's account", () => {
  const generateValues: Array<[string, unknown]> = [
    ["null", null], ["a number", 123], ["a boolean", true], ["an object", {}], ["a goal id object", { goalId: "a0000000-0000-4000-8000-0000000000a1" }],
    ["a list holding A", [A]], ["empty text", ""], ["a space", " "], ["not a uuid", "not-a-uuid"], ["A padded before", ` ${A}`], ["A padded after", `${A} `],
    ["A in braces", `{${A}}`], ["A without hyphens", A.replace(/-/g, "")], ["A as a urn", `urn:uuid:${A}`], ["A with a newline", `${A}\n`], ["a Blob", new Blob([A])],
  ];
  it.each(generateValues)("[negative] generate with %s (credentials verify as A): owner_intent_invalid, no Auth request, nothing read or called", async (_, value) => {
    const before = snapshot();
    const r = await (generateSyllabus as unknown as (v: unknown) => Promise<{ outcome: string; plan: unknown; message: string | null }>)(value);
    expect(r.outcome).toBe("owner_intent_invalid");
    expect(r.plan).toBeNull();
    expect(r.message).toBe(PLAN_COPY.owner_intent_invalid);
    expect(h.ops).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("[negative] an old client calling generate with no argument, through the action and the boundary: owner_intent_invalid, nothing done", async () => {
    expect((await (generateSyllabus as unknown as () => Promise<{ outcome: string }>)()).outcome).toBe("owner_intent_invalid");
    expect((await (generateGoalPlan as unknown as () => Promise<{ outcome: string }>)()).outcome).toBe("owner_intent_invalid");
    expect(h.ops).toEqual([]);
  });

  const submitForms: Array<[string, () => unknown]> = [
    ["no field (an old client's form)", () => form("none")],
    ["an empty field", () => form([""])],
    ["malformed text", () => form(["not-a-uuid"])],
    ["A padded", () => form([` ${A} `])],
    ["a File holding A", () => form([new File([A], "owner.txt")])],
    ["A twice (duplicated)", () => form([A, A])],
    ["A and B (ambiguous)", () => form([A, B])],
    ["B and A (ambiguous)", () => form([B, A])],
    ["a plain object, not FormData", () => ({ handicap_baseline: "8.5", primary_miss: "Fat", target_goal: A_TYPED, [EXPECTED_OWNER_FIELD]: A })],
    ["null", () => null],
  ];
  it("[negative] an old client's form given to the boundary directly (submitGoalAnswers, no field): owner_intent_invalid, no Auth request, nothing saved", async () => {
    const before = snapshot();
    expect(await submitGoalAnswers(form("none"))).toMatchObject({ outcome: "owner_intent_invalid", goalSaved: false, plan: null, message: PLAN_COPY.owner_intent_invalid });
    expect(h.ops).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it.each(submitForms)("[negative] submit with %s (credentials verify as A): owner_intent_invalid, no Auth request, nothing saved or called", async (_, make) => {
    const before = snapshot();
    const r = await (submitGoals as unknown as (v: unknown) => Promise<{ outcome: string; goalSaved: boolean; plan: unknown }>)(make());
    expect(r).toMatchObject({ outcome: "owner_intent_invalid", goalSaved: false, plan: null });
    expect(h.ops).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it.each([
    ["submit", () => submitGoals(form([NOBODY]))],
    ["generate", () => generateSyllabus(NOBODY)],
  ] as const)("[negative] %s with a well-formed id that is nobody's, under B's credentials: owner_mismatch after the one check, nothing else", async (_, call) => {
    h.verify = "B";
    const before = snapshot();
    expect((await call()).outcome).toBe("owner_mismatch");
    expect(kinds()).toEqual(["auth"]);
    expect(snapshot()).toBe(before);
  });

  it("[negative] tampered: B's valid credentials with A's intent never reach A's data (no read or write filtered to A, no other-owner lookup)", async () => {
    h.verify = "B";
    await submitGoals(form([A]));
    await generateSyllabus(A);
    expect(goalOps()).toEqual([]);
    expect(h.ops.every((o) => o.kind === "auth")).toBe(true);
  });
});

// ── [positive] ────────────────────────────────────────────────────────────────────────────────────────
describe("[positive] the matching owner's ordinary work is unchanged, and only ever that owner's", () => {
  it("[positive] A on A's form: A's answers saved as A's goal, one provider call with A's answers, A's row written and read back; B untouched", async () => {
    const bBefore = JSON.stringify(rows.filter((x) => x.user_id === B));
    const r = await submitGoals(form([A]));
    expect(r).toMatchObject({ outcome: "saved", goalSaved: true });
    expect(rows.filter((x) => x.target_goal === A_TYPED).map((x) => x.user_id)).toEqual([A]);
    expect(h.ops.filter((o) => o.kind === "call").map((o) => o.goal)).toEqual([A_TYPED]);
    expect(goalOps().every((o) => o.as === "A")).toBe(true);
    expect(JSON.stringify(rows.filter((x) => x.user_id === B))).toBe(bBefore);
  });

  it("[positive] B on B's plan view: B's latest goal read, one call with B's stored answers, B's row written; A untouched (the intent permits only B's own work)", async () => {
    h.verify = "B";
    const aBefore = JSON.stringify(rows.filter((x) => x.user_id === A));
    const r = await generateSyllabus(B);
    expect(r.outcome).toBe("saved");
    expect(h.ops.filter((o) => o.kind === "call").map((o) => o.goal)).toEqual([B_STORED]);
    expect(goalOps().every((o) => o.as === "B" && o.eq?.user_id === B)).toBe(true);
    expect(JSON.stringify(rows.filter((x) => x.user_id === A))).toBe(aBefore);
  });

  it("[positive] intent in upper case is the same id (deterministic normalisation); the stored owner is the verified id", async () => {
    expect((await generateSyllabus(A.toUpperCase())).outcome).toBe("saved");
    expect((await submitGoals(form([A.toUpperCase()]))).outcome).toBe("saved");
    expect(rows.filter((x) => x.target_goal === A_TYPED).map((x) => x.user_id)).toEqual([A]);
  });

  it("[positive] a newer session of the same account (a refresh, or signing in again) is not a mismatch", async () => {
    h.verify = "A2";
    expect((await submitGoals(form([A]))).outcome).toBe("saved");
    expect((await generateSyllabus(A)).outcome).toBe("saved");
  });

  it("[positive] normalizeOwnerId: canonical ids only, lower-cased", () => {
    expect(normalizeOwnerId(A)).toBe(A);
    expect(normalizeOwnerId(A.toUpperCase())).toBe(A);
    for (const v of [undefined, null, 1, {}, [A], "", ` ${A}`, `{${A}}`, A.slice(1), `${A}0`]) expect(normalizeOwnerId(v)).toBeNull();
  });
});

// ── [lifecycle] ───────────────────────────────────────────────────────────────────────────────────────
describe("[lifecycle] what the restriction leaves exactly as it was", () => {
  it.each([
    ["submit", () => submitGoals(form([A]))],
    ["generate", () => generateSyllabus(A)],
  ] as const)("[lifecycle] %s verified as A, then the browser signs in to B mid-request: the rest of the work stays A's (no second check, no write as B)", async (_, call) => {
    h.provider = "hold";
    const pending = call();
    expect(await until(() => h.release !== null)).toBe(true);
    h.verify = "B"; // a new request from this browser would now verify as B
    const mark = h.ops.length;
    h.release!();
    const r = await pending;
    expect(r.outcome).toBe("saved");
    const after = h.ops.slice(mark);
    expect(after.map((o) => o.kind)).toEqual(["update", "read"]);
    expect(after.every((o) => o.as === "A" && o.eq?.user_id === A)).toBe(true);
    expect(kinds().filter((k) => k === "auth")).toHaveLength(1);
    expect(rows.filter((x) => x.user_id === B).map((x) => x.ai_syllabus)).toEqual([PLAN_B]);
  });

  it.each([
    ["absent", "not_authenticated"], ["invalid", "not_authenticated"], ["unavailable", "auth_unavailable"], ["throw", "auth_unavailable"],
  ] as const)("[lifecycle] valid intent, Auth %s: %s exactly as before, nothing read, saved or called", async (verify, outcome) => {
    h.verify = verify;
    expect(await submitGoals(form([A]))).toMatchObject({ outcome, goalSaved: false, message: PLAN_COPY[outcome] });
    expect(await generateSyllabus(A)).toMatchObject({ outcome, message: PLAN_COPY[outcome] });
    expect(kinds()).toEqual(["auth", "auth"]);
  });

  it("[lifecycle] Next control flow from Auth passes through untouched on both entry points", async () => {
    h.verify = "redirect";
    await expect(submitGoals(form([A]))).rejects.toBe(REDIRECT);
    await expect(generateSyllabus(A)).rejects.toBe(REDIRECT);
    expect(goalOps()).toEqual([]);
  });

  it("[lifecycle] invalid answers for the right owner: invalid_input, nothing inserted or called", async () => {
    expect((await submitGoals(form([A], { handicap_baseline: "99" }))).outcome).toBe("invalid_input");
    expect(goalOps()).toEqual([]);
    expect(providerOps()).toEqual([]);
  });

  it("[lifecycle] provider not configured: the answers are saved for A, no provider construction", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await submitGoals(form([A]))).toMatchObject({ outcome: "provider_not_configured", goalSaved: true });
    expect(providerOps()).toEqual([]);
  });

  it("[lifecycle] a failing synthetic provider: provider_failed, no plan written, no retry", async () => {
    h.provider = "fail";
    expect(await generateSyllabus(A)).toMatchObject({ outcome: "provider_failed", plan: null });
    expect(h.ops.filter((o) => o.kind === "call")).toHaveLength(1);
    expect(h.ops.filter((o) => o.kind === "update")).toEqual([]);
  });

  it("[lifecycle] an unknown insert (no response): goal_save_unconfirmed, nothing generated", async () => {
    mode.insert = "status0";
    expect(await submitGoals(form([A]))).toMatchObject({ outcome: "goal_save_unconfirmed", goalSaved: false });
    expect(providerOps()).toEqual([]);
  });

  it("[lifecycle] a lost readback after the write: save_unconfirmed, no plan returned", async () => {
    mode.readback = "error";
    expect(await generateSyllabus(A)).toMatchObject({ outcome: "save_unconfirmed", plan: null, display: "keep" });
  });
});

// ── [order] ───────────────────────────────────────────────────────────────────────────────────────────
describe("[order] the comparison comes first, and the log carries codes only", () => {
  it("[order] for the matching owner the first operation after the check is the owner's own goal step, and the provider comes after it", async () => {
    await submitGoals(form([A]));
    expect(kinds().slice(0, 4)).toEqual(["auth", "insert", "ctor", "call"]);
    h.ops = [];
    await generateSyllabus(A);
    expect(kinds().slice(0, 4)).toEqual(["auth", "read", "ctor", "call"]);
  });

  it.each([
    ["owner_mismatch", () => { h.verify = "B"; return submitGoals(form([A])); }],
    ["owner_intent_invalid", () => generateSyllabus("not-a-uuid")],
  ] as const)("[order] a %s refusal logs one line with the code only — neither account id, no answers", async (code, call) => {
    await call();
    const lines = logs.filter((l) => l.startsWith("[goal-plan] "));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice("[goal-plan] ".length))).toMatchObject({ outcome: code, providerCalled: false });
    expect(logs.join("\n")).not.toContain(A);
    expect(logs.join("\n")).not.toContain(B);
    expect(logs.join("\n")).not.toContain(A_TYPED);
  });
});

// ── [guard] ───────────────────────────────────────────────────────────────────────────────────────────
describe("[guard] required signatures, and where both clients get the owner they send", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it("[guard] both boundary entries take the intent as a required parameter and compare before their first goal step", () => {
    const s = source("lib/goal-plan-generation.ts");
    expect(s).toContain("export async function generateGoalPlan(expectedOwnerId: unknown): Promise<GenerationResult>");
    expect(s).toContain("export async function submitGoalAnswers(formData: FormData): Promise<SubmitResult>");
    const gen = s.slice(s.indexOf("export async function generateGoalPlan"), s.indexOf("export async function submitGoalAnswers"));
    expect(gen.indexOf("isExpectedOwner(intent, caller)")).toBeGreaterThan(gen.indexOf("await identity()"));
    expect(gen.indexOf("isExpectedOwner(intent, caller)")).toBeLessThan(gen.indexOf("classifiedRead("));
    const sub = s.slice(s.indexOf("export async function submitGoalAnswers"));
    expect(sub.indexOf("isExpectedOwner(intent, caller)")).toBeGreaterThan(sub.indexOf("await identity()"));
    expect(sub.indexOf("isExpectedOwner(intent, caller)")).toBeLessThan(sub.indexOf(".insert("));
    // the intent is never used as a filter, a client or a lookup
    expect(s).not.toMatch(/eq\("user_id",\s*(intent|expectedOwnerId)/);
    expect(s.match(/await identity\(\)/g)).toHaveLength(2);
  });

  it("[guard] the form sends the rendered owner as the one expected_owner_id entry; the plan view sends it as its one argument", () => {
    const form = source("app/(dashboard)/goals/GoalsForm.tsx");
    expect(form).toContain(`const EXPECTED_OWNER_FIELD = "${EXPECTED_OWNER_FIELD}";`);
    expect(form).toContain("fd.set(EXPECTED_OWNER_FIELD, rendered.ownerId);");
    expect(form.match(/fd\.set\(EXPECTED_OWNER_FIELD/g)).toHaveLength(1); // set once (one entry), never appended
    expect(form).not.toMatch(/fd\.append\(/);
    const view = source("app/(dashboard)/goals/plan/PlanDisplay.tsx");
    expect(view).toContain("const rendered = useRenderedSession();");
    expect(view).toContain("const owner = rendered?.ownerId ?? null;");
    expect(view).toContain("result = await generateSyllabus(owner);");
    expect(view).not.toMatch(/generateSyllabus\(\s*\)/);
    // neither client takes the owner from the browser's stored session
    expect(view).not.toMatch(/readStoredSession|getSession|storedSubject/);
  });
});
