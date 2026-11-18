import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-S1 — the goals form and the plan view, driven end to end through the REAL Server Actions and the goal-plan
 * boundary, with the database, the provider and Auth replaced by stand-ins (no network). The two client
 * components run on a small synchronous stand-in for useState/useTransition (as the accepted splash tests do);
 * their rendered trees are turned into markup by the real react-dom/server. The error panel component is a stub,
 * and the router records navigation.
 *
 * [behavior] tests inspect only what is on screen, what was called and where the golfer was sent, so they also run
 * against the accepted (pre-S1) components and actions as the behaviour control, failing for the behaviour named.
 * [preserve] tests check properties the accepted components already had (they pass on both; not counted as controls).
 * [taxonomy] tests check the new outcome copy; [guard] tests read the component source.
 */

const h = vi.hoisted(() => ({
  rt: { states: [] as unknown[], si: 0, pending: [] as Promise<unknown>[] },
  nav: { push: [] as string[], refresh: 0 },
  rec: { calls: 0, queries: [] as Array<{ method: string; table: string }> },
  env: {
    auth: "ok" as "ok" | "absent" | "unavailable",
    exp: 3600 as number,
    provider: (() => Promise.resolve({})) as () => Promise<unknown>,
    client: null as unknown,
    actionUndefined: false,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = h.rt.si++;
    if (!(i in h.rt.states)) h.rt.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => { h.rt.states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.rt.states[i]) : v; };
    return [h.rt.states[i], set];
  }
  function useTransition() {
    const i = h.rt.si++;
    if (!(i in h.rt.states)) h.rt.states[i] = false;
    const start = (cb: () => unknown) => {
      h.rt.states[i] = true;
      h.rt.pending.push(Promise.resolve().then(cb).finally(() => { h.rt.states[i] = false; }));
    };
    return [h.rt.states[i], start];
  }
  return { ...actual, default: actual, useState, useTransition };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (u: string) => h.nav.push.push(u), refresh: () => { h.nav.refresh++; }, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/goals/plan",
  redirect: vi.fn(),
}));
vi.mock("@/components/goals/GoalsLoadError", async () => {
  const R = await import("react");
  return { default: ({ variant }: { variant: string }) => R.createElement("div", { "data-stub": `goals-load-error-${variant}` }, `[load-error ${variant}]`) };
});
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => h.env.client),
  resolveVerifiedAuth: vi.fn(async () => {
    if (h.env.auth === "unavailable") return { status: "verification_unavailable" };
    if (h.env.auth !== "ok") return { status: "absent" };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const accessToken = `${enc({ alg: "none" })}.${enc({ sub: "u", exp: Math.floor(Date.now() / 1000) + h.env.exp })}.sig`;
    return { status: "authenticated", userId: USER, email: "golfer-ui@example.invalid", accessToken, client: h.env.client, source: "cookie" };
  }),
  getServerSession: vi.fn(async () => null),
}));
// The real Server Actions, wrapped only so a test can make one come back as Next does for a response that is not a
// Server Action response (a platform timeout page): the promise resolves with undefined.
vi.mock("@/app/(dashboard)/goals/actions", async (importOriginal) => {
  const real = await importOriginal<Record<string, (...args: unknown[]) => Promise<unknown>>>();
  return {
    submitGoals: (fd: unknown) => (h.env.actionUndefined ? Promise.resolve(undefined) : real.submitGoals(fd)),
    generateSyllabus: () => (h.env.actionUndefined ? Promise.resolve(undefined) : real.generateSyllabus()),
  };
});
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: () => { h.rec.calls++; return h.env.provider(); } } };
  }
  return { default: FakeOpenAI };
});

import PlanDisplay from "@/app/(dashboard)/goals/plan/PlanDisplay";
import GoalsForm from "@/app/(dashboard)/goals/GoalsForm";
import { toGoalPlan, type GoalPlan } from "@/lib/golfer-journey-goals-read-state";

// ── synthetic data and stand-ins ──────────────────────────────────────────────────────────────────────
const USER = "00000000-0000-4000-8000-0000000000a1";
const GOAL = "a0000000-0000-4000-8000-000000000001";
const NEW_GOAL = "a0000000-0000-4000-8000-000000000002";
const plan = (summary: string) => ({
  summary,
  weeks: [1, 2, 3, 4].map((week) => ({ week, theme: `Theme ${week}`, focus: "Strike",
    drills: [{ name: `Drill ${week}`, description: "Swing through the gate.", duration: "20 min", category: "irons" }],
    weekly_goal: "Seven of ten.", pro_tip: "Slow the takeaway." })),
});
const G = plan("GENERATED plan G summary.");
const V = plan("SAVED plan V summary.");
const Q = plan("OTHER plan Q summary.");
const RAW_PROVIDER = "provider exploded: org-synthetic sk-synthetic-ui";
const RAW = /permission denied|42501|PGRST|fetch failed|TypeError|provider exploded|org-synthetic|sk-synthetic|AI service error/i;
/** What a Server Action raises for platform control flow; the boundary rethrows it, so the client sees a rejected action. */
const CONTROL = () => Object.assign(new Error("Dynamic server usage (synthetic)"), { digest: "DYNAMIC_SERVER_USAGE" });

interface Row { id: string; user_id: string; handicap_baseline: number | null; primary_miss: string | null; target_goal: string | null; ai_syllabus: unknown; created_at: string }
let store: Row[];
const sc = {
  insert: "ok" as "ok" | "status0" | "rejected" | "control",
  write: "apply" as "apply" | "zero" | "row_deleted" | "control" | "late",
  readback: "store" as "store" | "error",
  goalRead: "store" as "store" | "error",
  pendingLate: null as null | { id: string; value: unknown },
};
function respond(q: { table: string; method: string; payload?: Record<string, unknown>; cols?: string; single?: boolean; ops: unknown[][] }) {
  const eq = Object.fromEntries(q.ops.filter((o) => o[0] === "eq").map((o) => [o[1], o[2]]));
  const out = (rows: unknown[]) => (q.single ? (rows.length === 1 ? { data: rows[0], error: null, status: 200 } : { data: null, error: { code: "PGRST116", message: "no rows" }, status: 406 }) : { data: rows, error: null, status: 200 });
  if (q.method === "insert") {
    if (sc.insert === "status0") return { data: null, error: { code: "", message: "TypeError: fetch failed (synthetic)" }, status: 0 };
    if (sc.insert === "control") throw CONTROL();
    if (sc.insert === "rejected") return { data: null, error: { code: "42501", message: 'permission denied for table "user_goals"' }, status: 403 };
    store.push({ ...(q.payload as object), id: NEW_GOAL, ai_syllabus: null, created_at: new Date().toISOString() } as Row);
    return out([{ id: NEW_GOAL }]);
  }
  const mine = () => store.filter((r) => r.id === eq.id && (!("user_id" in eq) || r.user_id === eq.user_id));
  if (q.method === "update") {
    if (sc.write === "control") throw CONTROL();
    if (sc.write === "late") { sc.pendingLate = { id: String(eq.id), value: q.payload!.ai_syllabus }; return { data: null, error: { code: "20", message: "AbortError: signal timed out" }, status: 0 }; }
    if (sc.write === "zero") return out([]);
    if (sc.write === "row_deleted") { store = store.filter((r) => r.id !== eq.id); return out([]); }
    mine().forEach((r) => { r.ai_syllabus = q.payload!.ai_syllabus; });
    return out(mine().map((r) => ({ id: r.id })));
  }
  const readback = "id" in eq;
  if ((readback ? sc.readback : sc.goalRead) === "error") return { data: null, error: { code: "PGRST000", message: "permission denied (synthetic)" }, status: 500 };
  const rows = store.filter((r) => (!("user_id" in eq) || r.user_id === eq.user_id) && (!("id" in eq) || r.id === eq.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 1);
  const cols = String(q.cols ?? "*").split(",").map((c) => c.trim());
  const response = out(rows.map((r) => Object.fromEntries(cols.map((c) => [c, (r as unknown as Record<string, unknown>)[c]]))));
  if (readback && sc.pendingLate) { // the aborted write commits only after the readback was answered
    const late = sc.pendingLate;
    sc.pendingLate = null;
    store.filter((r) => r.id === late.id).forEach((r) => { r.ai_syllabus = late.value; });
  }
  return response;
}
function fakeClient() {
  return {
    auth: { getUser: async () => (h.env.auth === "ok" ? { data: { user: { id: USER, email: "golfer-ui@example.invalid" } }, error: null } : { data: { user: null }, error: { message: "missing" } }) },
    from(table: string) {
      const q: { table: string; method: string; payload?: Record<string, unknown>; cols?: string; single?: boolean; ops: unknown[][] } = { table, method: "select", ops: [] };
      h.rec.queries.push(q);
      const b: Record<string, unknown> = {
        select(cols: string) { if (q.method === "select") q.cols = cols; return b; },
        insert(p: Record<string, unknown>) { q.method = "insert"; q.payload = p; return b; },
        update(p: Record<string, unknown>) { q.method = "update"; q.payload = p; return b; },
        eq(c: string, v: unknown) { q.ops.push(["eq", c, v]); return b; },
        order() { return b; },
        limit() { return b; },
        retry() { return b; },
        abortSignal() { return b; },
        single() { q.single = true; return b; },
        maybeSingle() { q.single = true; return b; },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) { return Promise.resolve().then(() => respond(q)).then(ok, bad); },
      };
      return b;
    },
  };
}
const answer = (content: unknown) => async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });

// ── a tiny driver for one client component ────────────────────────────────────────────────────────────
type El = React.ReactElement<Record<string, unknown>>;
let current: { render: () => unknown } | null = null;
let tree: unknown;
function mount(render: () => unknown) {
  h.rt.states = [];
  current = { render };
  rerender();
}
function rerender() {
  h.rt.si = 0;
  tree = current!.render();
}
async function settle() {
  for (let n = 0; n < 10 && h.rt.pending.length; n++) {
    const batch = h.rt.pending.splice(0);
    await Promise.allSettled(batch);
  }
  rerender();
}
const html = () => renderToStaticMarkup(tree as React.ReactElement);
const text = () => html().replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return out; }
  if (!React.isValidElement(node)) return out;
  const el = node as El;
  out.push(el);
  elements(el.props.children, out);
  return out;
}
const textOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) return textOf((node as El).props.children);
  return "";
};
const button = (label: RegExp) => elements(tree).find((e) => e.type === "button" && label.test(textOf(e.props.children))) ?? null;
const links = () => elements(tree).filter((e) => e.type === "a").map((e) => ({ href: e.props.href, label: textOf(e.props.children) }));
async function click(label: RegExp) {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  (b.props.onClick as () => void)();
  rerender();
  await settle();
}
/** Press a button without letting the pending action finish (to look at the screen while it runs). */
function press(label: RegExp) {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  (b.props.onClick as () => void)();
  rerender();
}
/** Regenerate, confirming if the view asks (so the same steps also drive the accepted view, which never asks). */
async function regenerate() {
  await click(/Regenerate plan/);
  if (button(/Replace plan/)) await click(/Replace plan/);
}
const showPlan = (initial: unknown) => mount(() => (PlanDisplay as (p: unknown) => unknown)({ initialSyllabus: initial === null ? null : toGoalPlan(initial) as GoalPlan, hasGoals: true }));

beforeEach(() => {
  h.rt.states = [];
  h.rt.pending = [];
  h.nav.push = [];
  h.nav.refresh = 0;
  h.rec.calls = 0;
  h.rec.queries = [];
  h.env.auth = "ok";
  h.env.exp = 3600;
  h.env.provider = answer(G);
  h.env.client = fakeClient();
  h.env.actionUndefined = false;
  Object.assign(sc, { insert: "ok", write: "apply", readback: "store", goalRead: "store", pendingLate: null });
  store = [{ id: GOAL, user_id: USER, handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85", ai_syllabus: V, created_at: "2026-11-01T00:00:00.000Z" }];
  vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-key-ag-s1-ui");
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── [behavior] ────────────────────────────────────────────────────────────────────────────────────────
describe("controls and preserved properties: the plan view shows only stored plans", () => {
  it("[behavior] Regenerate asks before replacing a saved plan; keeping it makes no provider call", async () => {
    showPlan(V);
    await click(/Regenerate plan/);
    expect(h.rec.calls).toBe(0);
    expect(button(/Keep current plan/)).not.toBeNull();
    await click(/Keep current plan/);
    expect(h.rec.calls).toBe(0);
    expect(text()).toContain(V.summary);
  });

  it("[behavior] a write that changes nothing: the saved plan stays on screen; the generated plan never appears", async () => {
    sc.write = "zero";
    showPlan(V);
    await regenerate();
    expect(h.rec.calls).toBe(1);
    expect(text()).not.toContain(G.summary);
    expect(text()).toContain(V.summary);
  });

  it("[behavior] a lost readback: the last verified plan stays; the unconfirmed plan never appears", async () => {
    sc.readback = "error";
    showPlan(V);
    await regenerate();
    expect(text()).not.toContain(G.summary);
    expect(text()).toContain(V.summary);
    expect(text()).not.toMatch(/nothing (new )?was saved/i);
  });

  it("[behavior] a provider failure keeps the saved plan and shows no provider text", async () => {
    h.env.provider = async () => { throw new Error(RAW_PROVIDER); };
    showPlan(V);
    await regenerate();
    expect(text()).toContain(V.summary);
    expect(html()).not.toMatch(RAW);
  });

  it("[behavior] an outcome decided by the readback offers Reload My Plan (a document link), with no automatic refresh", async () => {
    sc.write = "zero";
    showPlan(V);
    await regenerate();
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
    expect(h.nav.refresh).toBe(0);
    expect(h.nav.push).toEqual([]);
  });

  it("[behavior] a generation action that comes back without a result (non-action response, e.g. a timeout page): the saved plan stays, with 'couldn't confirm' and Reload My Plan", async () => {
    h.env.actionUndefined = true;
    showPlan(V);
    await regenerate();
    expect(text()).toContain(V.summary);
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
  });

  it("[taxonomy] a write aborted at its deadline that commits after the readback: the saved plan stays, 'couldn't confirm', no Generate invitation", async () => {
    sc.write = "late";
    showPlan(V);
    await regenerate();
    expect(text()).toContain(V.summary);
    expect(text()).not.toContain(G.summary);
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(text()).not.toMatch(/isn't the plan saved now|No plan is saved/);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
    expect(store[0].ai_syllabus).toEqual(G); // a reload would show it
  });

  it("[behavior] a generation action that rejects (platform error): the saved plan stays, with 'couldn't confirm' and Reload My Plan", async () => {
    sc.write = "control";
    showPlan(V);
    await regenerate();
    expect(text()).toContain(V.summary);
    expect(text()).not.toContain(G.summary);
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
    expect(html()).not.toMatch(RAW);
  });

  const generationControls = () => elements(tree).filter((e) => e.type === "button" && /Generate My Plan|Generating…|Regenerate plan|Replace plan|Keep current plan/.test(textOf(e.props.children)));

  it("[preserve] while a first generation is pending its controls are disabled", async () => {
    showPlan(null);
    press(/Generate My Plan/);
    expect(generationControls().length).toBeGreaterThanOrEqual(1);
    expect(generationControls().every((e) => e.props.disabled === true)).toBe(true);
    await settle();
    expect(h.rec.calls).toBe(1);
  });

  it("[preserve] while a regeneration is pending its controls are disabled", async () => {
    showPlan(V);
    press(/Regenerate plan/);
    if (button(/Replace plan/)) press(/Replace plan/);
    expect(generationControls().length).toBeGreaterThanOrEqual(1);
    expect(generationControls().every((e) => e.props.disabled === true)).toBe(true);
    await settle();
    expect(h.rec.calls).toBe(1);
  });
});

describe("controls and preserved properties: the goals form after submit", () => {
  async function fillAndSubmit() {
    mount(() => (GoalsForm as () => unknown)());
    (elements(tree).find((e) => e.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "12.4" } });
    rerender();
    await click(/^Next/);
    await click(/^Slice$/);
    await click(/^Next/);
    (elements(tree).find((e) => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "Break 85 at Pebble Creek" } });
    rerender();
    await click(/Generate My Plan/);
  }

  it("[preserve] while the answers are being submitted the form buttons are disabled", async () => {
    mount(() => (GoalsForm as () => unknown)());
    (elements(tree).find((e) => e.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "12.4" } });
    rerender();
    await click(/^Next/);
    await click(/^Next/);
    press(/Generate My Plan/);
    const buttons = elements(tree).filter((e) => e.type === "button");
    expect(buttons.length).toBeGreaterThanOrEqual(2); // Back and the submit button
    expect(buttons.every((e) => e.props.disabled === true)).toBe(true);
    await settle();
  });

  it("[preserve] saved: the golfer is taken to the plan", async () => {
    await fillAndSubmit();
    expect(h.nav.push).toEqual(["/goals/plan"]);
  });

  it("[behavior] answers saved but the plan not confirmed: no navigation; the form is replaced by the outcome and Open My Plan", async () => {
    sc.write = "zero";
    await fillAndSubmit();
    expect(h.nav.push).toEqual([]);
    expect(text()).toContain("Your answers were saved.");
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Open My Plan" });
    expect(button(/Generate My Plan|Back|Next/)).toBeNull();
  });

  it("[behavior] a lost insert response: 'couldn't confirm' with Open My Goals, no raw text and no resubmit", async () => {
    sc.insert = "status0";
    await fillAndSubmit();
    expect(html()).not.toMatch(RAW);
    expect(text()).toMatch(/couldn't confirm your answers were saved/i);
    expect(links()).toContainEqual({ href: "/goals", label: "Open My Goals" });
    expect(button(/Generate My Plan/)).toBeNull();
    expect(h.nav.push).toEqual([]);
  });

  it("[behavior] a submit action that comes back without a result (non-action response): 'couldn't confirm' and Open My Goals, no resubmit", async () => {
    h.env.actionUndefined = true;
    await fillAndSubmit();
    expect(text()).toMatch(/couldn't confirm your answers were saved/i);
    expect(links()).toContainEqual({ href: "/goals", label: "Open My Goals" });
    expect(button(/Generate My Plan/)).toBeNull();
    expect(h.nav.push).toEqual([]);
  });

  it("[taxonomy] submit, then the provider fails: answers saved, 'No plan was saved from this attempt', Open My Plan", async () => {
    h.env.provider = async () => { throw new Error(RAW_PROVIDER); };
    await fillAndSubmit();
    expect(text()).toContain("Your answers were saved.");
    expect(text()).toContain("We couldn't create a plan. No plan was saved from this attempt.");
    expect(text()).not.toMatch(/Nothing new was saved/);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Open My Plan" });
    expect(html()).not.toMatch(RAW);
  });

  it("[taxonomy] submit, then the new row is gone: answers saved, Open My Goals", async () => {
    sc.write = "row_deleted";
    await fillAndSubmit();
    expect(text()).toContain("Your answers were saved.");
    expect(links()).toContainEqual({ href: "/goals", label: "Open My Goals" });
  });

  it("[taxonomy] submit, then the readback is unavailable: answers saved, Reload My Plan", async () => {
    sc.readback = "error";
    await fillAndSubmit();
    expect(text()).toContain("Your answers were saved.");
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
  });

  it.each([
    ["absent", /Please sign in again\./],
    ["unavailable", /couldn't check your sign-in right now/],
  ] as const)("[taxonomy] submit with Auth %s keeps the form with the fixed message, nothing inserted", async (auth, copy) => {
    h.env.auth = auth;
    await fillAndSubmit();
    expect(text()).toMatch(copy);
    expect(button(/Generate My Plan/)).not.toBeNull();
    expect(h.rec.queries.filter((q) => q.method === "insert")).toHaveLength(0);
    expect(h.rec.calls).toBe(0);
  });

  it("[behavior] a submit action that rejects (platform error): the form is replaced by 'couldn't confirm' and Open My Goals", async () => {
    sc.insert = "control";
    await fillAndSubmit();
    expect(text()).toMatch(/couldn't confirm your answers were saved/i);
    expect(links()).toContainEqual({ href: "/goals", label: "Open My Goals" });
    expect(button(/Generate My Plan/)).toBeNull();
    expect(h.nav.push).toEqual([]);
    expect(h.rec.calls).toBe(0);
  });
});

describe("[guard] the plan view never refreshes or navigates by itself", () => {
  it("[guard] PlanDisplay has no router, no refresh and no reload (outcomes offer a document link instead)", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app/(dashboard)/goals/plan/PlanDisplay.tsx"), "utf8");
    expect(src).not.toMatch(/next\/navigation|useRouter|router\.refresh|location\.reload|location\.assign|location\.href\s*=/);
  });
});

// ── [taxonomy] every outcome's copy and display ───────────────────────────────────────────────────────
describe("[taxonomy] each generation outcome on screen", () => {
  const cases: Array<[string, () => void, RegExp, "V" | "G" | "Q" | "none" | "unreadable" | "missing"]> = [
    ["saved", () => {}, /Your new plan is saved\./, "G"],
    ["other_plan_stored", () => { sc.write = "zero"; }, /isn't the plan saved now\. This is your saved plan\./, "V"],
    ["no_plan_stored", () => { sc.write = "zero"; store[0].ai_syllabus = null; }, /No plan is saved for this goal right now\. Your new plan wasn't confirmed\./, "none"],
    ["stored_plan_unreadable", () => { sc.write = "zero"; store[0].ai_syllabus = { summary: 1, weeks: "x" }; }, /Your new plan wasn't confirmed\./, "unreadable"],
    ["goal_missing", () => { sc.write = "row_deleted"; }, /We couldn't find this goal\. Open My Goals\./, "missing"],
    ["save_unconfirmed", () => { sc.readback = "error"; }, /couldn't confirm whether your new plan was saved\. Reload My Plan/, "V"],
    ["provider_failed", () => { h.env.provider = async () => { throw new Error(RAW_PROVIDER); }; }, /We couldn't create a new plan\. Nothing new was saved from this attempt\./, "V"],
    ["provider_not_configured", () => { vi.stubEnv("OPENAI_API_KEY", ""); }, /Plan generation is unavailable right now\./, "V"],
    ["time_insufficient (session)", () => { h.env.exp = 5; }, /Please sign in again, then try\./, "V"],
    ["not_authenticated", () => { h.env.auth = "absent"; }, /Please sign in again\./, "V"],
    ["auth_unavailable", () => { h.env.auth = "unavailable"; }, /couldn't check your sign-in right now/, "V"],
    ["goal_unavailable", () => { sc.goalRead = "error"; }, /We couldn't load your goals\./, "V"],
    ["no_goal", () => { store = []; }, /Set your goals first\./, "V"],
    ["invalid_input (stored answers)", () => { store[0].primary_miss = "Shank"; }, /Your saved answers can't be used for a plan/, "V"],
  ];
  it.each(cases)("[taxonomy] %s", async (_, arrange, copy, shows) => {
    arrange();
    showPlan(V);
    await regenerate();
    expect(text()).toMatch(copy);
    expect(html()).not.toMatch(RAW);
    if (shows === "V") expect(text()).toContain(V.summary);
    if (shows === "G") expect(text()).toContain(G.summary);
    if (shows !== "V") expect(text()).not.toContain(V.summary);
    if (shows !== "G") expect(text()).not.toContain(G.summary);
    if (shows === "none") expect(button(/Generate My Plan/)).not.toBeNull();
    if (shows === "unreadable") expect(html()).toContain("goals-load-error-unreadable");
    if (shows === "missing") expect(links()).toContainEqual({ href: "/goals", label: "Open My Goals" });
  });

  it("[taxonomy] generating when no plan is saved needs no confirmation", async () => {
    store[0].ai_syllabus = null;
    showPlan(null);
    await click(/Generate My Plan/);
    expect(h.rec.calls).toBe(1);
    expect(text()).toContain(G.summary);
  });

  it("[taxonomy] submit with an invalid goal keeps the form and shows the field message", async () => {
    mount(() => (GoalsForm as () => unknown)());
    (elements(tree).find((e) => e.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "99" } });
    rerender();
    await click(/^Next/);
    await click(/^Next/);
    await click(/Generate My Plan/);
    expect(text()).toMatch(/Enter a handicap index between -10 and 54/);
    expect(button(/Generate My Plan/)).not.toBeNull();
    expect(h.rec.calls).toBe(0);
  });

  it("[taxonomy] submit rejected by the database keeps the form with the fixed message", async () => {
    sc.insert = "rejected";
    mount(() => (GoalsForm as () => unknown)());
    (elements(tree).find((e) => e.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "12" } });
    rerender();
    await click(/^Next/);
    await click(/^Next/);
    await click(/Generate My Plan/);
    expect(text()).toContain("We couldn't save your answers.");
    expect(html()).not.toMatch(RAW);
    expect(button(/Generate My Plan/)).not.toBeNull();
  });
});
