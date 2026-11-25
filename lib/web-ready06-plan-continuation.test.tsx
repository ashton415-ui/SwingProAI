import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-06-P1 — the plan view applies a generation's answer only while it is still the view that asked, for the
 * account it was rendered for (app/(dashboard)/goals/plan/PlanDisplay.tsx). Two lanes:
 *
 * 1. The REAL-RENDERER lane (the "[real renderer]" describe at the end): the production build's own React and ReactDOM in
 *    Chromium — real mounting, the DOM it produces, effects, unmounting and navigation — driven through the loopback service of
 *    the evidence harness (06-P1's, extended by 08-P1's), whose address is given as P1R_URL (http://127.0.0.1:<port>). Each
 *    case asks the service to run one scenario and asserts what it observed: the DOM over time (an in-page MutationObserver
 *    records the page's state after each delivered mutation batch — a state that appears and is replaced within one batch,
 *    or between two observer callbacks, is not seen, and it observes DOM changes, not React renders), the account the
 *    browser's session names, Auth writes, action POSTs, and the server's goal operations per owner and synthetic provider
 *    calls. Scheduling that only a gate can make exact (an owner change while a confirmation is awaited; the caller's
 *    handoff) runs on an EXTERNAL seam copy of the build, never on the candidate. Without P1R_URL this lane is skipped and
 *    reported as skipped; with it, any service or infrastructure failure fails the case.
 *    AG-WEB-READY-08-P1: a confirmed change or end now also ends the rendered-session boundary around the plan view (the
 *    whole account-bearing page is replaced by the boundary's fixed guidance, which takes focus), so R1/R2/R6/R6b expect
 *    that guidance; the seam copy also probes the plan view's report to the boundary ("report", never a "set:" point).
 *    The shell itself (header, saved goal, sidebar, navigation, End Session) is asserted in web-ready08-shell-coherence.
 * 2. The SIMULATED lane (every other describe): NOT React's lifecycle. React's hooks are replaced by a small synchronous
 *    runtime (the one the goals UI tests use) that keeps state across renders and runs effects and cleanups when the test
 *    mounts and unmounts; each state is then serialized by react-dom/server. It exercises the real PlanDisplay module, the
 *    real Server Actions and goal-plan boundary, and the real confirmOwnerSession and session-end check, against stand-ins:
 *    the browser's shared client (its session read answer by answer; spies on every credential-writing method — none may be
 *    called), server Auth verification, a caller-scoped two-owner goal table recording every operation with its owner, and
 *    the provider. "setsAfterUnmount" counts setter calls the component attempts after the runtime unmounted it — React
 *    itself silently discards such updates, so this count is a property of this runtime, not of React. 08-P1: the plan
 *    view's reporter to the boundary around it is a recording fixture here ("reports"); the boundary is not mounted.
 */

const h = vi.hoisted(() => ({
  ids: { A: "00000000-0000-4000-8000-00000000a6a1", B: "00000000-0000-4000-8000-00000000b6b2" } as Record<"A" | "B", string>,
  rt: { states: [] as unknown[], si: 0, pending: [] as Promise<unknown>[], due: [] as number[], mounted: true, setsAfterUnmount: 0 },
  rendered: null as null | { ownerId: string; lineage: string | null },
  // the browser's session read, answer by answer ("deferred": answered only when releaseRead is called)
  browser: { holds: "A" as "A" | "B" | "A2" | "none" | "unavailable", seq: [] as Array<"A" | "B" | "A2" | "none" | "unavailable" | "deferred">, reads: 0,
    writes: [] as string[], releaseRead: null as null | (() => void) },
  server: { verify: "A" as "A" | "B", ops: [] as Array<{ kind: string; as?: string }>, calls: [] as Array<string | null>, provider: "ok" as "ok" | "fail", readback: "ok" as "ok" | "error" },
  action: { hold: null as null | Promise<void>, mode: "real" as "real" | "undefined" | "throw", sent: [] as unknown[][] },
  // 08-P1: what the plan view reported to the boundary around it (recorded; the fixture reporter accepts every report)
  reports: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = h.rt.si++;
    if (!(i in h.rt.states)) h.rt.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      if (!h.rt.mounted) h.rt.setsAfterUnmount += 1;
      h.rt.states[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.rt.states[i]) : v;
    };
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
  function useRef(init: unknown) {
    const i = h.rt.si++;
    if (!(i in h.rt.states)) h.rt.states[i] = { current: init };
    return h.rt.states[i];
  }
  function useEffect(fn: () => unknown, deps?: unknown[]) {
    const i = h.rt.si++;
    const prev = h.rt.states[i] as { deps?: unknown[]; cleanup?: unknown } | undefined;
    if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps![k]))) return;
    h.rt.states[i] = { deps, fn, cleanup: prev?.cleanup, effect: true };
    h.rt.due.push(i);
  }
  return { ...actual, default: actual, useState, useTransition, useRef, useEffect };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/goals/plan", redirect: vi.fn() }));
vi.mock("@/components/navigation/SessionKeeper", () => ({ useRenderedSession: () => h.rendered }));
vi.mock("@/components/navigation/RenderedSessionObservation", () => ({
  useRenderedViewEndReport: () => (report: unknown) => {
    h.reports.push(report);
    return true;
  },
}));
vi.mock("@/components/goals/GoalsLoadError", async () => {
  const R = await import("react");
  return { default: ({ variant }: { variant: string }) => R.createElement("div", { "data-stub": `goals-load-error-${variant}` }, `[load-error ${variant}]`) };
});
vi.mock("@/utils/supabase/client", () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sessionOf = (sub: string, sid: string) => ({
    access_token: `${enc({ alg: "none" })}.${enc({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-p1`,
    refresh_token: `rt-${sid}`, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: sub },
  });
  const answer = (k: string) => {
    if (k === "unavailable") return Promise.reject(new TypeError("Failed to fetch (synthetic)"));
    const session = k === "none" ? null : k === "B" ? sessionOf(h.ids.B, "sid-b") : sessionOf(h.ids.A, k === "A2" ? "sid-a2" : "sid-a1");
    return Promise.resolve({ data: { session }, error: null });
  };
  const client = {
    auth: {
      getSession: () => {
        h.browser.reads += 1;
        const k = h.browser.seq.length ? h.browser.seq.shift()! : h.browser.holds;
        if (k === "deferred") return new Promise((resolve) => { h.browser.releaseRead = () => resolve(answer(h.browser.holds)); });
        return answer(k);
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signOut: () => { h.browser.writes.push("signOut"); return Promise.resolve({ error: null }); },
      setSession: () => { h.browser.writes.push("setSession"); return Promise.resolve({ error: null }); },
      refreshSession: () => { h.browser.writes.push("refreshSession"); return Promise.resolve({ error: null }); },
      signInWithPassword: () => { h.browser.writes.push("signInWithPassword"); return Promise.resolve({ error: null }); },
    },
  };
  return { createClient: () => client };
});
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => { throw new Error("not used by the boundary"); }),
  getServerSession: vi.fn(async () => null),
  resolveVerifiedAuth: vi.fn(async () => {
    h.server.ops.push({ kind: "auth", as: h.server.verify });
    const who = h.server.verify;
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return { status: "authenticated", userId: h.ids[who], email: `${who.toLowerCase()}@example.invalid`,
      accessToken: `${enc({ alg: "none" })}.${enc({ sub: h.ids[who], exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`, client: serverClient(who), source: "cookie" };
  }),
}));
// the real Server Actions; a held answer has already finished on the server and only reaches the view on release
vi.mock("@/app/(dashboard)/goals/actions", async (importOriginal) => {
  const real = await importOriginal<Record<string, (...args: unknown[]) => Promise<unknown>>>();
  return {
    submitGoals: (...args: unknown[]) => real.submitGoals(...args),
    generateSyllabus: async (...args: unknown[]) => {
      h.action.sent.push(args);
      const result = await real.generateSyllabus(...args);
      if (h.action.hold) await h.action.hold;
      if (h.action.mode === "throw") throw new Error("synthetic dropped connection");
      if (h.action.mode === "undefined") return undefined;
      return result;
    },
  };
});
vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: async (params: { messages: Array<{ content: string }> }) => {
      h.server.calls.push(/Target goal: (.*)$/m.exec(params.messages[1]?.content ?? "")?.[1] ?? null);
      if (h.server.provider === "fail") throw new Error("provider exploded: sk-synthetic-p1");
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(GENERATED) } }] };
    } } };
  }
  return { default: FakeOpenAI };
});

import PlanDisplay from "@/app/(dashboard)/goals/plan/PlanDisplay";
import { toGoalPlan, type GoalPlan } from "@/lib/golfer-journey-goals-read-state";

// ── synthetic data ────────────────────────────────────────────────────────────────────────────────────
const A = h.ids.A;
const B = h.ids.B;
const plan = (summary: string) => ({ summary, weeks: [1, 2, 3, 4].map((week) => ({ week, theme: `Theme ${week}`, focus: "Strike",
  drills: [{ name: `Drill ${week}`, description: "Swing through the gate.", duration: "20 min", category: "irons" }], weekly_goal: "Seven of ten.", pro_tip: "Slow the takeaway." })) });
const GENERATED = plan("P1 NEWLY GENERATED plan for golfer A.");
const INITIAL_A = plan("P1 INITIAL saved plan of golfer A.");
const A_GOAL = "P1 golfer A goal: lag putting";
const B_GOAL = "P1 golfer B goal: driver hook";
const CHANGED = /signed in to a different account before your plan's result arrived/;
const ENDED = /sign-in ended before your plan's result arrived/;
const UNCONFIRMED_ACCOUNT = /couldn't confirm the signed-in account, so your plan's result isn't shown here/;
const MAY_BE_SAVED = /A new plan may already have been saved/;
const RAW = /provider exploded|sk-synthetic|permission denied|PGRST/i;

interface Row { id: string; user_id: string; handicap_baseline: number | null; primary_miss: string | null; target_goal: string | null; ai_syllabus: unknown; created_at: string }
let rows: Row[];
const seed = (aPlan: unknown) => {
  rows = [
    { id: "a0000000-0000-4000-8000-00000000a601", user_id: A, handicap_baseline: 10, primary_miss: "Slice", target_goal: A_GOAL, ai_syllabus: aPlan, created_at: "2026-11-20T00:00:00.000Z" },
    { id: "b0000000-0000-4000-8000-00000000b601", user_id: B, handicap_baseline: 20, primary_miss: "Hook", target_goal: B_GOAL, ai_syllabus: null, created_at: "2026-11-21T00:00:00.000Z" },
  ];
};
/** A caller-scoped client for one owner: like the row policy, it sees and changes only that owner's rows. */
function serverClient(who: "A" | "B") {
  const owner = h.ids[who];
  return {
    from() {
      const q = { method: "select", payload: undefined as Record<string, unknown> | undefined, eq: {} as Record<string, unknown>, cols: "*" };
      const run = async () => {
        const visible = rows.filter((r) => r.user_id === owner && (!("user_id" in q.eq) || r.user_id === q.eq.user_id) && (!("id" in q.eq) || r.id === q.eq.id));
        if (q.method === "update") {
          h.server.ops.push({ kind: "update", as: who });
          visible.forEach((r) => { r.ai_syllabus = q.payload!.ai_syllabus; });
          return { data: visible.map((r) => ({ id: r.id })), error: null, status: 200 };
        }
        h.server.ops.push({ kind: "read", as: who });
        if ("id" in q.eq && h.server.readback === "error") return { data: null, error: { code: "PGRST000", message: "permission denied (synthetic)" }, status: 500 };
        const out = [...visible].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 1)
          .map((r) => Object.fromEntries(q.cols.split(",").map((c) => c.trim()).map((c) => [c, (r as unknown as Record<string, unknown>)[c]])));
        return { data: out, error: null, status: 200 };
      };
      const b: Record<string, unknown> = {
        select(cols: string) { if (q.method === "select") q.cols = cols; return b; },
        update(p: Record<string, unknown>) { q.method = "update"; q.payload = p; return b; },
        eq(c: string, v: unknown) { q.eq[c] = v; return b; },
        order() { return b; }, limit() { return b; }, retry() { return b; }, abortSignal() { return b; },
        then(ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) { return Promise.resolve().then(run).then(ok, bad); },
      };
      return b;
    },
  };
}

// ── the component driver ──────────────────────────────────────────────────────────────────────────────
type El = React.ReactElement<Record<string, unknown>>;
let current: { render: () => unknown } | null = null;
let tree: unknown;
function mount(initial: unknown) {
  h.rt.states = [];
  h.rt.due = [];
  h.rt.mounted = true;
  current = { render: () => (PlanDisplay as (p: unknown) => unknown)({ initialSyllabus: initial === null ? null : toGoalPlan(initial) as GoalPlan, hasGoals: true }) };
  rerender();
}
function rerender() {
  if (!current) return;
  h.rt.si = 0;
  tree = current.render();
  for (const i of h.rt.due.splice(0)) {
    const slot = h.rt.states[i] as { fn: () => unknown; cleanup?: unknown };
    if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    slot.cleanup = slot.fn();
  }
}
function unmount() {
  for (const slot of h.rt.states as { effect?: boolean; cleanup?: unknown }[]) if (slot?.effect && typeof slot.cleanup === "function") (slot.cleanup as () => void)();
  current = null;
  h.rt.mounted = false;
}
async function settle() {
  for (let n = 0; n < 20 && h.rt.pending.length; n++) await Promise.allSettled(h.rt.pending.splice(0));
  rerender();
}
const until = async (pred: () => boolean) => { for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 0)); return pred(); };
/** the committed tree rendered by the real react-dom/server */
const html = () => renderToStaticMarkup(tree as React.ReactElement);
const text = () => html().replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return out; }
  if (!React.isValidElement(node)) return out;
  out.push(node as El);
  elements((node as El).props.children, out);
  return out;
}
const textOf = (node: unknown): string => (typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : React.isValidElement(node) ? textOf((node as El).props.children) : "");
const button = (label: RegExp) => elements(tree).find((e) => e.type === "button" && label.test(textOf(e.props.children))) ?? null;
const links = () => elements(tree).filter((e) => e.type === "a").map((e) => ({ href: e.props.href, label: textOf(e.props.children) }));
const guidanceMarked = () => elements(tree).filter((e) => e.props["data-rendered-session-guidance"] !== undefined);
function press(label: RegExp) {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  (b.props.onClick as () => void)();
  rerender();
}
/** Generate (no saved plan) or Regenerate then Replace plan, leaving the action running. */
function pressGenerate() {
  if (button(/Generate My Plan/)) return press(/Generate My Plan/);
  press(/Regenerate plan/);
  press(/^Replace plan$/);
}
function holdAnswer() {
  let release!: () => void;
  h.action.hold = new Promise<void>((r) => { release = r; });
  return () => release();
}
const goalOps = () => h.server.ops.filter((o) => o.kind !== "auth");
const opsBy = (who: "A" | "B") => goalOps().filter((o) => o.as === who).map((o) => o.kind);
/** The account-bearing content of the view: plan text, plan controls, details. */
const accountContentGone = () => !text().includes(INITIAL_A.summary) && !text().includes(GENERATED.summary) && !button(/Generate My Plan|Regenerate plan|Replace plan|Keep current plan|Week 1/);

beforeEach(() => {
  h.rt.states = [];
  h.rt.pending = [];
  h.rt.due = [];
  h.rt.mounted = true;
  h.rt.setsAfterUnmount = 0;
  h.rendered = { ownerId: A, lineage: null };
  Object.assign(h.browser, { holds: "A", seq: [], reads: 0, writes: [], releaseRead: null });
  Object.assign(h.server, { verify: "A", ops: [], calls: [], provider: "ok", readback: "ok" });
  Object.assign(h.action, { hold: null, mode: "real", sent: [] });
  h.reports = [];
  seed(null);
  vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-key-p1");
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── the held answer and an account switch (the observed late-result schedule) ─────────────────────────
describe("[simulated] P1: A's answer held while the browser signs in to B — withheld, the whole view replaced, B's session kept", () => {
  it.each([
    ["a newly generated plan (no saved plan on screen)", null],
    ["a regeneration over A's saved plan on screen", INITIAL_A],
  ] as const)("[switch] %s: nothing of the answer shown, A's plan and controls removed, fixed guidance acts; A's server work is A's alone", async (_, initial) => {
    seed(initial);
    mount(initial);
    if (initial) expect(text()).toContain(INITIAL_A.summary);
    const release = holdAnswer();
    pressGenerate();
    expect(await until(() => h.server.calls.length === 1)).toBe(true); // the server finished as A
    h.browser.holds = "B"; // another tab signed in to B; this view received no notice
    release();
    await settle();
    // the server: verified A once, A's read / update / readback only, the provider saw A's goal; B untouched
    expect(h.server.ops.filter((o) => o.kind === "auth").map((o) => o.as)).toEqual(["A"]);
    expect(opsBy("B")).toEqual([]);
    expect(opsBy("A")).toEqual(["read", "update", "read"]);
    expect(h.server.calls).toEqual([A_GOAL]);
    expect(rows.find((r) => r.user_id === B)!.ai_syllabus).toBeNull();
    // the view: fixed guidance only — no new or initial plan, no success notice, no generation control
    expect(text()).toMatch(CHANGED);
    expect(text()).toMatch(MAY_BE_SAVED);
    expect(text()).not.toMatch(/Your new plan is saved/);
    expect(accountContentGone()).toBe(true);
    expect(links()).toEqual([{ href: "/goals/plan", label: "Reload page" }]);
    // the guidance marker is on the fixed guidance only, and it holds no generation control
    const marked = guidanceMarked();
    expect(marked).toHaveLength(1);
    expect(elements(marked[0]).some((e) => e.type === "button")).toBe(false);
    expect(String(elements(marked[0]).find((e) => e.type === "a")!.props.className)).toMatch(/min-h-11 min-w-11/);
    // B's newer session is kept; nothing retried or generated again
    expect(h.browser.writes).toEqual([]);
    expect(h.action.sent).toHaveLength(1);
    expect(h.server.calls).toHaveLength(1);
    // 08-P1: the confirmed change is reported once to the boundary around the view, as fixed enums only
    expect(h.reports).toEqual([{ end: "account_changed", plan: "may_be_saved" }]);
  });

  it("[switch] the sign-in to B is published between the two confirmations (a joined first read): the second one refuses", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    h.browser.seq = ["A", "B"]; // first read still answers A, the fresh second read sees B
    pressGenerate();
    await settle();
    expect(h.browser.reads).toBe(2);
    expect(text()).toMatch(CHANGED);
    expect(accountContentGone()).toBe(true);
    expect(h.reports).toEqual([{ end: "account_changed", plan: "may_be_saved" }]);
  });

  it("[switch] the server refused (G1 owner_mismatch: the request verified as B) and the browser holds B: the stale A view is replaced, not kept under a notice; the guidance says nothing was saved (a known refusal, not 'may have been saved')", async () => {
    seed(INITIAL_A);
    h.server.verify = "B";
    h.browser.holds = "B";
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(goalOps()).toEqual([]);
    expect(h.server.calls).toEqual([]);
    expect(text()).toMatch(/opened for a different account than the one signed in now, so nothing was saved or generated/);
    expect(text()).not.toMatch(MAY_BE_SAVED);
    expect(accountContentGone()).toBe(true);
    expect(links()).toEqual([{ href: "/goals/plan", label: "Reload page" }]);
    // 08-P1: the change is confirmed by the browser's session (B), not by the refusal code; the code only says "refused"
    expect(h.reports).toEqual([{ end: "account_changed", plan: "refused" }]);
  });

  it("[switch] the withheld guidance is the keyboard target that replaces the removed controls (focusable, not a tab stop)", async () => {
    mount(null);
    h.browser.holds = "B";
    pressGenerate();
    await settle();
    const marked = guidanceMarked();
    expect(marked).toHaveLength(1);
    expect(marked[0].props.tabIndex).toBe(-1);
    expect(marked[0].props.role).toBe("status");
  });

  it("[switch] a thrown or missing answer while the browser holds B is withheld the same way (never an 'unconfirmed' notice under A's plan)", async () => {
    for (const mode of ["throw", "undefined"] as const) {
      seed(INITIAL_A);
      h.action.mode = mode;
      h.browser.holds = "B";
      mount(INITIAL_A);
      pressGenerate();
      await settle();
      expect(text(), mode).toMatch(CHANGED);
      expect(accountContentGone(), mode).toBe(true);
      unmount();
    }
    expect(h.reports).toEqual([{ end: "account_changed", plan: "may_be_saved" }, { end: "account_changed", plan: "may_be_saved" }]);
  });
});

// ── lifecycle and other answers of the confirmation ───────────────────────────────────────────────────
describe("[simulated] P1: lifecycle — an answer is used only by a live view that was not left", () => {
  it("[lifecycle] an answer that arrives after the view was unmounted changes nothing: no state update, no retry", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    const release = holdAnswer();
    pressGenerate();
    expect(await until(() => h.server.calls.length === 1)).toBe(true);
    unmount();
    release();
    await settle();
    expect(h.rt.setsAfterUnmount).toBe(0);
    expect(h.browser.reads).toBe(0); // nothing even asked: the view was gone
    expect(h.action.sent).toHaveLength(1);
    expect(h.reports).toEqual([]); // 08-P1: a view that is gone reports nothing
  });

  it("[lifecycle] the view is unmounted while its confirmation is awaited: still nothing applied", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    h.browser.seq = ["deferred"];
    pressGenerate();
    expect(await until(() => h.browser.releaseRead !== null)).toBe(true);
    unmount();
    h.browser.holds = "B"; // even a confirmed change, answered after the view is gone, reports nothing
    h.browser.releaseRead!();
    await settle();
    expect(h.rt.setsAfterUnmount).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("[lifecycle] the account changes while the confirmation is awaited (the read answers after B was published): withheld", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    h.browser.seq = ["deferred"];
    pressGenerate();
    expect(await until(() => h.browser.releaseRead !== null)).toBe(true);
    h.browser.holds = "B";
    h.browser.releaseRead!();
    await settle();
    expect(text()).toMatch(CHANGED);
    expect(accountContentGone()).toBe(true);
    expect(h.reports).toEqual([{ end: "account_changed", plan: "may_be_saved" }]);
  });

  const LOCATION = { href: "http://127.0.0.1:3941/goals/plan", origin: "http://127.0.0.1:3941", pathname: "/goals/plan", search: "" };
  const linkTo = (href: string, attrs: Record<string, string> = {}) => ({ getAttribute: (n: string) => (n === "href" ? href : attrs[n] ?? null), hasAttribute: (n: string) => n in attrs });
  const pressOn = (link: unknown) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target: { closest: (s: string) => (s === "a[href]" ? link : null) } });
  function captureGlobals() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const capture = <T extends EventTarget>(target: T, name: string): T => {
      const add = target.addEventListener.bind(target);
      target.addEventListener = ((type: string, cb: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => {
        listeners[`${name}:${type}`] = cb as (e: unknown) => void;
        add(type, cb, o);
      }) as T["addEventListener"];
      return target;
    };
    vi.stubGlobal("document", capture(Object.assign(new EventTarget(), { cookie: "" }), "document"));
    vi.stubGlobal("window", capture(Object.assign(new EventTarget(), { location: LOCATION }), "window"));
    return listeners;
  }

  it.each(["link to another page", "back/forward"] as const)("[lifecycle] the golfer leaves while the answer is held (%s; the router queues it behind the action): the answer is not applied", async (how) => {
    const listeners = captureGlobals();
    seed(INITIAL_A);
    mount(INITIAL_A);
    const release = holdAnswer();
    pressGenerate();
    expect(await until(() => h.server.calls.length === 1)).toBe(true);
    if (how === "back/forward") listeners["window:popstate"]?.({});
    else listeners["document:click"]?.(pressOn(linkTo("/bag")));
    release();
    await settle();
    expect(text()).not.toContain(GENERATED.summary);
    expect(text()).not.toMatch(/Your new plan is saved/);
    // still on screen while the chosen navigation completes: only fixed, data-free uncertainty with a document link
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(h.browser.reads).toBe(0);
    expect(h.reports).toEqual([]); // 08-P1: a view that was left never ends the page the golfer chose
  });

  it.each(["link to another page", "back/forward"] as const)("[lifecycle] 08-P1: left while the answer is held and the browser now holds B (%s): still no report — the departure wins", async (how) => {
    const listeners = captureGlobals();
    seed(INITIAL_A);
    mount(INITIAL_A);
    const release = holdAnswer();
    pressGenerate();
    expect(await until(() => h.server.calls.length === 1)).toBe(true);
    if (how === "back/forward") listeners["window:popstate"]?.({});
    else listeners["document:click"]?.(pressOn(linkTo("/bag")));
    h.browser.holds = "B";
    release();
    await settle();
    expect(text()).not.toContain(GENERATED.summary);
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(h.browser.reads).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("[lifecycle] presses that do not leave this page are not departures: the answer still applies", async () => {
    const listeners = captureGlobals();
    for (const [name, ev] of [["new tab", pressOn(linkTo("/bag", { target: "_blank" }))], ["this same page", pressOn(linkTo("/goals/plan"))], ["ctrl-click", { ...pressOn(linkTo("/bag")), ctrlKey: true }]] as const) {
      seed(null);
      h.browser.reads = 0;
      mount(null);
      const release = holdAnswer();
      pressGenerate();
      expect(await until(() => h.server.calls.length > 0)).toBe(true);
      listeners["document:click"]?.(ev);
      release();
      await settle();
      expect(text(), name).toContain(GENERATED.summary);
      h.server.calls = [];
      unmount();
    }
  });

  it("[lifecycle] a confirmed sign-out while the answer is held: 'ended' guidance, never a result", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    h.browser.holds = "none";
    pressGenerate();
    await settle();
    expect(text()).toMatch(ENDED);
    expect(accountContentGone()).toBe(true);
    expect(h.browser.writes).toEqual([]);
    expect(h.reports).toEqual([{ end: "signed_out", plan: "may_be_saved" }]);
  });

  it("[lifecycle] End Session of the rendered lineage is pending (its end intent is in the jar): 'ended' guidance", async () => {
    const lineage = createHash("sha256").update("swingproai-session-lineage:sid-a1").digest("hex");
    vi.stubGlobal("document", Object.assign(new EventTarget(), { cookie: `swingproai-session-ended=${lineage}` }));
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { href: "http://127.0.0.1:3941/goals/plan", origin: "http://127.0.0.1:3941", pathname: "/goals/plan", search: "" } }));
    seed(INITIAL_A);
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toMatch(ENDED);
    expect(accountContentGone()).toBe(true);
    expect(h.reports).toEqual([{ end: "signed_out", plan: "may_be_saved" }]); // the rendered lineage's end, confirmed
  });

  it("[lifecycle] the account cannot be confirmed (Auth unavailable): withheld as unconfirmed — not a sign-out, not a failed save; Reload My Plan", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    h.browser.holds = "unavailable";
    pressGenerate();
    await settle();
    expect(text()).toMatch(UNCONFIRMED_ACCOUNT);
    expect(text()).toMatch(MAY_BE_SAVED);
    expect(text()).not.toMatch(/sign-in ended|signed out|nothing was saved|wasn't saved/i);
    expect(accountContentGone()).toBe(true);
    expect(links()).toEqual([{ href: "/goals/plan", label: "Reload My Plan" }]);
    expect(h.browser.writes).toEqual([]);
    expect(h.action.sent).toHaveLength(1);
    expect(h.reports).toEqual([]); // 08-P1: an unconfirmed answer never ends the page around the view
  });

  it("[lifecycle] 08-P1: no rendered account (outside the provider) and an unconfirmed answer report nothing", async () => {
    seed(INITIAL_A);
    h.rendered = null;
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(h.action.sent).toHaveLength(0);
    unmount();
    h.rendered = { ownerId: A, lineage: null };
    mount(INITIAL_A);
    h.browser.seq = ["A", "unavailable"]; // the second confirmation cannot be made
    pressGenerate();
    await settle();
    expect(text()).toMatch(UNCONFIRMED_ACCOUNT);
    expect(h.reports).toEqual([]);
  });
});

// ── the same account: ordinary behaviour kept ─────────────────────────────────────────────────────────
describe("[simulated] P1: the same account — ordinary results still apply", () => {
  it("[positive] a held answer while the same account refreshed or signed in again (newer session): the saved plan applies", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    const release = holdAnswer();
    pressGenerate();
    expect(await until(() => h.server.calls.length === 1)).toBe(true);
    h.browser.holds = "A2";
    release();
    await settle();
    expect(text()).toContain(GENERATED.summary);
    expect(text()).toMatch(/Your new plan is saved/);
    expect(h.reports).toEqual([]); // 08-P1: a newer sign-in of the same account is not an end or a change
  });

  it("[confirm] the same account's answer is confirmed exactly twice — once, then once more, never more — through the managed client's read only", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toContain(GENERATED.summary);
    expect(h.browser.reads).toBe(2);
    expect(h.browser.writes).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("[positive] generate with no saved plan: the persisted plan appears", async () => {
    mount(null);
    pressGenerate();
    await settle();
    expect(text()).toContain(GENERATED.summary);
    expect(guidanceMarked()).toHaveLength(0);
  });

  it("[positive] regenerate asks first; Keep current plan sends nothing", async () => {
    seed(INITIAL_A);
    mount(INITIAL_A);
    press(/Regenerate plan/);
    press(/Keep current plan/);
    await settle();
    expect(h.action.sent).toHaveLength(0);
    expect(text()).toContain(INITIAL_A.summary);
  });

  it("[positive] a provider failure keeps A's plan with the fixed message and no provider text", async () => {
    seed(INITIAL_A);
    h.server.provider = "fail";
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toContain(INITIAL_A.summary);
    expect(text()).toMatch(/We couldn't create a new plan/);
    expect(html()).not.toMatch(RAW);
  });

  it("[positive] provider not configured: the fixed message, the plan kept", async () => {
    seed(INITIAL_A);
    vi.stubEnv("OPENAI_API_KEY", "");
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toMatch(/Plan generation is unavailable right now/);
    expect(text()).toContain(INITIAL_A.summary);
  });

  it("[positive] an unknown readback (the write may have landed): 'couldn't confirm' with Reload My Plan — never a definite failure", async () => {
    seed(INITIAL_A);
    h.server.readback = "error";
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toMatch(/couldn't confirm whether your new plan was saved/i);
    expect(text()).not.toMatch(/Nothing new was saved|wasn't saved/);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload My Plan" });
  });

  it("[positive] a thrown or missing answer for the same account: the existing 'couldn't confirm' notice, the plan kept", async () => {
    for (const mode of ["throw", "undefined"] as const) {
      seed(INITIAL_A);
      h.action.mode = mode;
      mount(INITIAL_A);
      pressGenerate();
      await settle();
      expect(text(), mode).toContain(INITIAL_A.summary);
      expect(text(), mode).toMatch(/couldn't confirm whether your new plan was saved/i);
      unmount();
    }
  });

  it("[positive] G1's refusal while the browser still holds A (the server saw another account): the existing refusal notice under A's own plan", async () => {
    seed(INITIAL_A);
    h.server.verify = "B";
    mount(INITIAL_A);
    pressGenerate();
    await settle();
    expect(text()).toMatch(/opened for a different account than the one signed in now, so nothing was saved or generated/);
    expect(text()).toContain(INITIAL_A.summary);
    expect(links()).toContainEqual({ href: "/goals/plan", label: "Reload page" });
  });
});

// ── [real renderer] the production build's own React and ReactDOM in Chromium (the first lane in the header) ──────────
// "final" is the production build of the very bytes this file runs in (each answer carries the PlanDisplay sha256 that
// build was made from, compared below with this tree's own file); "seam" is an EXTERNAL copy of the same bytes plus
// scheduling gates and setter probes (window.__p1Seam), never part of the candidate. Times are the page's own clock.
// A run that did not happen (service error) fails at once; every other check is a soft assertion, so a failing case
// reports each property it broke.
type RealEvent = { at: number; path: string; plan: boolean; saved: boolean; initial: boolean; guidance: boolean; changed: boolean; unconfirmed: boolean; planControls: number };
// 08-P1: ended — the boundary's ended guidance (null when absent); planOutcome — its fixed plan line's enum; focusInEnded —
// keyboard focus inside that guidance
type RealView = { path: string; guidance: string[]; statuses: string[]; initialShown: boolean; generatedShown: string[]; savedNotice: boolean; focusInGuidance: boolean; pending: boolean;
  ended?: string | null; planOutcome?: string | null; focusInEnded?: boolean };
type OwnerOps = { read: number; insert: number; update: number };
type RealRun = {
  scenario: string;
  tree: string;
  buildId: string;
  error?: string;
  planDisplay: { sha256: string; seamMarkers: number; controlMarkers: number };
  steps: Record<string, boolean>;
  marks: { press: number; release: number };
  atRelease?: { path: string; planViewPresent: boolean };
  whileStillMounted?: { path: string; planViewPresent: boolean; view: RealView };
  view: RealView;
  events: RealEvent[] | null;
  seamCalls: Array<{ point: string; at: number }> | null;
  pageErrors: string[];
  ops: { perOwner: { A: OwnerOps; B: OwnerOps; other: number } };
  providerCalls: Array<{ goal: string | null; mode: string }>;
  jarAtRelease?: string | null;
  jarAfter: string | null;
  logouts: number;
  posts: number;
  controls?: { w1280: { ok: boolean }; w390: { ok: boolean } } | null;
};

const P1R_URL = process.env.P1R_URL;
const REAL_TIMEOUT = 240_000;
const REAL_A_GOAL = "P1 A stored goal: lag putting";
const REAL_A_PLAN = `[from: ${REAL_A_GOAL}]`;
const NOTHING_AS_B: OwnerOps = { read: 0, insert: 0, update: 0 };

/** One scenario on the named build, through the harness service (loopback only). A non-loopback address, a transport
 *  error, a non-200 answer or an unreadable body rejects, so an infrastructure failure fails the case rather than passing
 *  or skipping it. */
function realRun(scenario: string, tree: "final" | "seam"): Promise<RealRun> {
  const body = JSON.stringify({ scenario, tree });
  return new Promise((resolve, reject) => {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(String(P1R_URL))) {
      reject(new Error("P1R_URL must be a loopback origin (http://127.0.0.1:<port>)"));
      return;
    }
    const req = request(new URL("/run", String(P1R_URL)), { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`real-renderer service answered ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as RealRun);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(REAL_TIMEOUT - 10_000, () => req.destroy(new Error("the real-renderer service did not answer in time")));
    req.end(body);
  });
}

/** Runs the scenario; a run that did not reach its end (a harness/service error, no observer) fails the case at once. */
async function realRunOrFail(scenario: string, tree: "final" | "seam"): Promise<RealRun> {
  const r = await realRun(scenario, tree);
  expect(r.error).toBeUndefined();
  expect(Array.isArray(r.events) && r.events.length > 0).toBe(true);
  return r;
}

const ownPlanDisplay = () =>
  createHash("sha256").update(readFileSync(fileURLToPath(new URL("../app/(dashboard)/goals/plan/PlanDisplay.tsx", import.meta.url)))).digest("hex");
/** The DOM states the in-page observer recorded from the press on (one per delivered mutation batch that changed what it
 *  records, with its time; not every React commit — see the header). */
const observedSincePress = (r: RealRun) => (r.events ?? []).filter((e) => e.at >= r.marks.press);
/** The recorded DOM states from the moment the answer was released (or the handoff gate opened). */
const observedAfterRelease = (r: RealRun) => (r.events ?? []).filter((e) => e.at >= r.marks.release);
/** The continuation's setter attempts after the release, as the seam copy's probes counted them. */
const attemptsAfterRelease = (r: RealRun) => (r.seamCalls ?? []).filter((c) => c.at >= r.marks.release && c.point.startsWith("set:")).map((c) => c.point);
const seamCount = (r: RealRun, point: string) => (r.seamCalls ?? []).filter((c) => c.at >= r.marks.press && c.point === point).length;

/** The scenario ran as described (every named step), on the named build, without a page error. */
function expectRanAsDescribed(r: RealRun, tree: "final" | "seam") {
  expect.soft(r.tree).toBe(tree);
  expect.soft(Object.keys(r.steps ?? {}).length).toBeGreaterThan(0);
  for (const [step, ok] of Object.entries(r.steps ?? {})) expect.soft([step, ok]).toEqual([step, true]);
  expect.soft(r.pageErrors).toEqual([]);
  if (tree === "final") {
    expect.soft(r.planDisplay.sha256).toBe(ownPlanDisplay());
    if (r.planDisplay.seamMarkers === 0) expect.soft(r.seamCalls).toEqual([]);
  } else {
    expect.soft(r.planDisplay.seamMarkers).toBeGreaterThan(0);
    expect.soft(Array.isArray(r.seamCalls)).toBe(true);
  }
}

/** A's answer arrived after B had signed in: nothing of it was ever observed on screen, the whole page became the
 *  boundary's fixed guidance (08-P1: the plan view reported its confirmed change), B's session stayed, and nothing ran as B. */
function expectWithheldForB(r: RealRun) {
  expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved)).toEqual([]);
  expect.soft(r.view.guidance).toHaveLength(1);
  expect.soft(r.view.guidance[0] ?? "").toMatch(/^ended: Signed in to a different account/);
  expect.soft(r.view.planOutcome).toBe("may_be_saved");
  expect.soft(r.view.generatedShown).toEqual([]);
  expect.soft(r.view.savedNotice).toBe(false);
  expect.soft(r.view.initialShown).toBe(false);
  expect.soft(r.view.focusInEnded).toBe(true);
  expect.soft(r.jarAtRelease).toBe("B");
  expect.soft(r.jarAfter).toBe("B");
  expect.soft(r.logouts).toBe(0);
  expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
  expect.soft(r.ops.perOwner.other).toBe(0);
  expect.soft(r.ops.perOwner.A).toMatchObject({ insert: 0, update: 1 });
}

describe.skipIf(!P1R_URL)("[real renderer] P1: the production build's React in Chromium (harness service at P1R_URL)", () => {
  // ── the candidate's own build ──
  it.each([
    { scenario: "R1", onScreen: "no plan on screen" },
    { scenario: "R2", onScreen: "A's initial plan on screen" },
  ])("$scenario: A's answer held at the provider while B signs in from another tab ($onScreen) — withheld, B kept, nothing as B", async ({ scenario }) => {
    const r = await realRunOrFail(scenario, "final");
    expectWithheldForB(r);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "hold" }]);
    expect.soft(r.posts).toBe(1);
    expect.soft(r.controls?.w1280.ok && r.controls?.w390.ok).toBe(true);
    expectRanAsDescribed(r, "final");
  }, REAL_TIMEOUT);

  it("R3: the same account signs in again while A's answer is held — the answer applies", async () => {
    const r = await realRunOrFail("R3", "final");
    expect.soft(observedSincePress(r).filter((e) => e.guidance || e.unconfirmed)).toEqual([]);
    expect.soft(observedAfterRelease(r).some((e) => e.plan && e.saved)).toBe(true);
    expect.soft(r.view.generatedShown).toEqual([REAL_A_PLAN]);
    expect.soft(r.view.savedNotice).toBe(true);
    expect.soft(r.view.guidance).toEqual([]);
    expect.soft(r.view.ended ?? null).toBeNull(); // 08-P1: the page stays (a newer sign-in of the same account)
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "hold" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expect.soft(r.ops.perOwner.A).toMatchObject({ insert: 0, update: 1 });
    expectRanAsDescribed(r, "final");
  }, REAL_TIMEOUT);

  it("R9: ordinary generation for the signed-in account — the plan and its success notice; the plan control at 44 px", async () => {
    const r = await realRunOrFail("R9", "final");
    expect.soft(observedSincePress(r).filter((e) => e.guidance || e.unconfirmed)).toEqual([]);
    expect.soft(observedSincePress(r).some((e) => e.plan && e.saved)).toBe(true);
    expect.soft(r.view.generatedShown).toEqual([REAL_A_PLAN]);
    expect.soft(r.view.savedNotice).toBe(true);
    expect.soft(r.view.guidance).toEqual([]);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "ok" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expect.soft(r.controls?.w1280.ok && r.controls?.w390.ok).toBe(true);
    expectRanAsDescribed(r, "final");
  }, REAL_TIMEOUT);

  const expectUnmountedR4 = (r: RealRun) => {
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance || e.unconfirmed)).toEqual([]);
    expect.soft(r.atRelease).toEqual({ path: "/dashboard", planViewPresent: false });
    expect.soft(r.view.path).toBe("/dashboard");
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "hold" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expect.soft(r.posts).toBe(1);
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.jarAfter).toBe("A");
  };
  const expectQueuedDepartureR5 = (r: RealRun) => {
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance)).toEqual([]);
    expect.soft(r.atRelease).toEqual({ path: "/goals/plan", planViewPresent: true });
    expect.soft(r.view.path).toBe("/bag");
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "hold" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expect.soft(r.posts).toBe(1);
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.jarAfter).toBe("A");
  };

  it("R4: a true unmount (back) while the answer is held — nothing of it is observed on screen after it arrives", async () => {
    const r = await realRunOrFail("R4", "final");
    expectUnmountedR4(r);
    expectRanAsDescribed(r, "final");
  }, REAL_TIMEOUT);

  it("R5: a departure while the view is still mounted with its answer queued — no result is observed on screen; the navigation completes", async () => {
    const r = await realRunOrFail("R5", "final");
    expectQueuedDepartureR5(r);
    expectRanAsDescribed(r, "final");
  }, REAL_TIMEOUT);

  // ── the external seam copy: exact schedules and the caller's own setter attempts ──
  it("R4 [seam]: after the true unmount the caller attempts no setter and the helper reads no session", async () => {
    const r = await realRunOrFail("R4", "seam");
    expect.soft(attemptsAfterRelease(r)).toEqual([]);
    expect.soft(seamCount(r, "report")).toBe(0); // 08-P1: nothing reported to the boundary
    expectUnmountedR4(r);
    expect.soft(seamCount(r, "confirm")).toBe(0);
    expect.soft(seamCount(r, "handoff")).toBe(1);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it("R5 [seam]: after the queued departure the caller attempts at most the fixed notice and the helper reads no session", async () => {
    const r = await realRunOrFail("R5", "seam");
    expect.soft(attemptsAfterRelease(r).filter((p) => p !== "set:setNotice")).toEqual([]);
    expect.soft(attemptsAfterRelease(r).length).toBeLessThanOrEqual(1);
    expect.soft(seamCount(r, "report")).toBe(0);
    expectQueuedDepartureR5(r);
    expect.soft(seamCount(r, "confirm")).toBe(0);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it.each([
    ["R6", 1],
    ["R6b", 2],
  ] as const)("%s [seam]: B is published while owner confirmation %i is awaited — withheld, B kept, nothing as B", async (scenario, confirmations) => {
    const r = await realRunOrFail(scenario, "seam");
    expectWithheldForB(r);
    expect.soft(attemptsAfterRelease(r)).toEqual(["set:setWithheld"]);
    expect.soft(seamCount(r, "report")).toBe(1); // 08-P1: one report, after the caller's final checks
    expect.soft(seamCount(r, "confirm")).toBe(confirmations);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "ok" }]);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it("R7 [seam]: unmounted (back) at the helper-to-caller handoff — the caller returns without one setter attempt", async () => {
    const r = await realRunOrFail("R7", "seam");
    expect.soft(attemptsAfterRelease(r)).toEqual([]);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance || e.unconfirmed)).toEqual([]);
    expect.soft(r.atRelease).toEqual({ path: "/dashboard", planViewPresent: false });
    expect.soft(r.view.path).toBe("/dashboard");
    expect.soft(seamCount(r, "confirm")).toBe(2);
    expect.soft(seamCount(r, "handoff")).toBe(1);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "ok" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it("R8 [seam]: left while still mounted at the handoff — only the fixed uncertainty notice, never the result", async () => {
    const r = await realRunOrFail("R8", "seam");
    expect.soft(attemptsAfterRelease(r)).toEqual(["set:setNotice"]);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance)).toEqual([]);
    expect.soft(observedAfterRelease(r).some((e) => e.path === "/goals/plan" && e.unconfirmed)).toBe(true);
    expect.soft(r.whileStillMounted?.view.generatedShown).toEqual([]);
    expect.soft(r.whileStillMounted?.view.savedNotice).toBe(false);
    expect.soft(seamCount(r, "confirm")).toBe(2);
    expect.soft(seamCount(r, "handoff")).toBe(1);
    expect.soft(r.providerCalls).toEqual([{ goal: REAL_A_GOAL, mode: "ok" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it("R10 [seam]: unmounted (back) while the second owner confirmation is awaited — no setter attempt, nothing observed on screen", async () => {
    const r = await realRunOrFail("R10", "seam");
    expect.soft(attemptsAfterRelease(r)).toEqual([]);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance || e.unconfirmed)).toEqual([]);
    expect.soft(r.atRelease).toEqual({ path: "/dashboard", planViewPresent: false });
    expect.soft(seamCount(r, "confirm")).toBe(2);
    expect.soft(seamCount(r, "handoff")).toBe(1);
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);

  it("R11 [seam]: left while the first owner confirmation is awaited — no further session read, only the fixed notice", async () => {
    const r = await realRunOrFail("R11", "seam");
    expect.soft(attemptsAfterRelease(r)).toEqual(["set:setNotice"]);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(observedSincePress(r).filter((e) => e.plan || e.saved || e.guidance)).toEqual([]);
    expect.soft(observedAfterRelease(r).some((e) => e.path === "/goals/plan" && e.unconfirmed)).toBe(true);
    expect.soft(r.atRelease).toEqual({ path: "/goals/plan", planViewPresent: true });
    expect.soft(r.view.path).toBe("/bag");
    expect.soft(seamCount(r, "confirm")).toBe(1);
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING_AS_B);
    expectRanAsDescribed(r, "seam");
  }, REAL_TIMEOUT);
});
