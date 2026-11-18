import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-03 — My Goals pages, rendered for real against a fake
 * caller-scoped client (no network, no database, no provider). Each read is a
 * controllable thenable that records the query it was built from; any method
 * other than the read methods (an insert, update, upsert, delete or rpc) is
 * recorded and fails the test. The goals actions are stubs that must never be
 * called while a page renders.
 *
 * This file deliberately imports nothing added by GJ-PARALLEL-03, so it also
 * runs against the accepted pre-change pages as a control. The fake also
 * answers `.single()` the way PostgREST does, for the pre-change plan page.
 */

type Outcome =
  | { kind: "rows"; rows: unknown[] }
  | { kind: "error"; withRows?: boolean }
  | { kind: "reject"; error?: unknown }
  | { kind: "throw" } // the client throws while the query is being built
  | { kind: "data"; data: unknown }; // a raw response body with no error

interface Call { table: string; ops: unknown[][] }
let outcome: Outcome;
let calls: Call[] = [];
let forbidden: string[] = [];
let createError: unknown = null;
let session: unknown;
const ERROR = { message: 'permission denied for table "user_goals" (synthetic 42501)', code: "42501", details: null, hint: null };
const READ_OPS = new Set(["select", "eq", "order", "limit", "single", "maybeSingle", "abortSignal"]);

function settle(single: boolean): Promise<unknown> {
  switch (outcome.kind) {
    case "rows":
      if (!single) return Promise.resolve({ data: outcome.rows, error: null });
      return Promise.resolve(outcome.rows.length === 1
        ? { data: outcome.rows[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null } });
    case "error": {
      const rows = outcome.withRows ? [row()] : null;
      return Promise.resolve({ data: single ? rows?.[0] ?? null : rows, error: ERROR });
    }
    case "data":
      // .single() on an array body behaves as PostgREST does: exactly one row → that row, otherwise PGRST116
      if (single && Array.isArray(outcome.data)) {
        return Promise.resolve(outcome.data.length === 1
          ? { data: outcome.data[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null } });
      }
      return Promise.resolve({ data: outcome.data, error: null });
    case "reject": return Promise.reject(outcome.error ?? new Error("TypeError: fetch failed (synthetic 10.9.9.9)"));
    default: return Promise.reject(new Error("unreachable"));
  }
}

function fakeServerClient() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      let single = false;
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) => settle(single).then(onFulfilled, onRejected);
          }
          if (typeof prop !== "string") return undefined;
          if (!READ_OPS.has(prop)) {
            forbidden.push(`${table}.${prop}`);
            throw new Error(`forbidden client method ${prop}`);
          }
          return (...args: unknown[]) => {
            if (outcome.kind === "throw" && prop === "select") throw new Error("synthetic client failure while building");
            call.ops.push([prop, ...args]);
            if (prop === "single" || prop === "maybeSingle") single = true;
            return builder;
          };
        },
      });
      return builder;
    },
  };
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => {
    if (createError) throw createError;
    return fakeServerClient();
  }),
  getServerSession: vi.fn(async () => session),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT") as Error & { digest: string };
    e.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw e;
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/goals",
}));
vi.mock("@/app/(dashboard)/goals/actions", () => ({ submitGoals: vi.fn(), generateSyllabus: vi.fn() }));

import GoalsPage from "@/app/(dashboard)/goals/page";
import GoalsPlanPage from "@/app/(dashboard)/goals/plan/page";
import PlanDisplay from "@/app/(dashboard)/goals/plan/PlanDisplay";
import { createClient, getServerSession } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { generateSyllabus, submitGoals } from "@/app/(dashboard)/goals/actions";

// ── synthetic data ──────────────────────────────────────────────────────────
const PLAN = {
  summary: "Two weeks to steadier contact with the irons and a calmer putting stroke.",
  weeks: [
    { week: 1, theme: "Foundation", focus: "Setup and strike",
      drills: [
        { name: "Gate Drill", description: "Set two tees a clubhead apart and swing through the gate.", duration: "20 min", category: "irons" },
        { name: "Clock Putting", description: "Putt from four spots around the hole at three feet.", duration: "15 min", category: "putting" },
      ],
      weekly_goal: "Strike 7 of 10 balls from the centre of the face.", pro_tip: "Slow the takeaway." },
    { week: 2, theme: "Pattern Building", focus: "Tempo",
      drills: [{ name: "Pump Drill", description: "Pump to waist height twice, then swing.", duration: "50 reps", category: "driving" }],
      weekly_goal: "Hold one tempo for a full bucket.", pro_tip: "Count to three at the top." },
  ],
};
const row = (over: Record<string, unknown> = {}) => ({
  id: "goal-row-1", handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85 this season", ai_syllabus: PLAN, ...over,
});
const CONTEXT = "Handicap 12.4 · Primary miss: Slice · Break 85 this season";
const RAW = /permission denied|42501|PGRST|fetch failed|TypeError|10\.9\.9\.9|synthetic|digest|\[object Object\]/i;
const PLAN_COLUMNS = ["id", "handicap_baseline", "primary_miss", "target_goal", "ai_syllabus"];

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}
async function renderPlan() {
  const element = await GoalsPlanPage();
  const html = renderToStaticMarkup(element);
  return { element, html, text: text(html) };
}
async function renderEntry(searchParams: Record<string, string | string[] | undefined> = {}) {
  const html = renderToStaticMarkup(await (GoalsPage as (p: unknown) => Promise<React.ReactElement>)({ searchParams }));
  return { html, text: text(html) };
}
/** The PlanDisplay element in a rendered page tree (or null). */
function findPlanDisplay(node: unknown): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findPlanDisplay(child); if (hit) return hit; }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (node.type === PlanDisplay) return node;
  return findPlanDisplay((node.props as { children?: unknown }).children);
}
function selectedColumns(call: Call): string[] {
  const select = call.ops.find((op) => op[0] === "select");
  return String(select?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
}

beforeEach(() => {
  calls = [];
  forbidden = [];
  createError = null;
  session = { access_token: "synthetic", user: { id: "golfer-1", email: null } };
  outcome = { kind: "rows", rows: [row()] };
  vi.clearAllMocks();
});
/** The opening tag of the link to `href`, whatever the attribute order (or ""). */
function linkTag(html: string, href: string) {
  return Array.from(html.matchAll(/<a\b[^>]*>/g), (m) => m[0]).find((tag) => tag.includes(`href="${href}"`)) ?? "";
}
afterEach(() => {
  // Viewing, revisiting or retrying a read never submits goals, generates a plan or writes.
  expect(vi.mocked(submitGoals)).not.toHaveBeenCalled();
  expect(vi.mocked(generateSyllabus)).not.toHaveBeenCalled();
  expect(forbidden).toEqual([]);
});

// ── /goals/plan ─────────────────────────────────────────────────────────────
describe("Your AI Plan — the latest-goal read", () => {
  it("signed out: the unchanged login redirect, before any table read", async () => {
    session = null;
    await expect(GoalsPlanPage()).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    expect(calls).toEqual([]);
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
  });

  it("auth outage: the auth failure propagates (never 'no goals'), before any table read", async () => {
    const outage = Object.assign(new Error("Supabase Auth verification is unavailable."), { name: "AuthVerificationUnavailableError" });
    vi.mocked(getServerSession).mockRejectedValueOnce(outage);
    await expect(GoalsPlanPage()).rejects.toBe(outage);
    expect(calls).toEqual([]);
  });

  it("one read: user_goals, the session owner, newest first, one row, only the goal fields (no count/history/other user)", async () => {
    vi.mocked(createClient).mockClear();
    await renderPlan();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.table).toBe("user_goals");
    const cols = selectedColumns(call);
    for (const c of ["handicap_baseline", "primary_miss", "target_goal", "ai_syllabus"]) expect(cols).toContain(c);
    expect(cols.every((c) => PLAN_COLUMNS.includes(c))).toBe(true);
    expect(call.ops.filter((op) => op[0] === "eq")).toEqual([["eq", "user_id", "golfer-1"]]);
    expect(call.ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(call.ops).toContainEqual(["limit", 1]);
    expect(call.ops.every((op) => ["select", "eq", "order", "limit", "single"].includes(op[0] as string))).toBe(true);
  });
});

describe("Your AI Plan — states from a successful read", () => {
  it("no goal row: the genuine no-goals path with a route to the form", async () => {
    outcome = { kind: "rows", rows: [] };
    const { text: t, html } = await renderPlan();
    expect(t).toContain("No goals set yet");
    expect(html).toMatch(/href="\/goals"/);
    expect(t).not.toMatch(/didn.t load|couldn.t be shown|Generate My Plan/);
  });

  it("saved goal without a plan (null): goal context and the explicit Generate My Plan path, nothing generated", async () => {
    outcome = { kind: "rows", rows: [row({ ai_syllabus: null })] };
    const { text: t } = await renderPlan();
    expect(t).toContain(CONTEXT);
    expect(t).toContain("Generate My Plan");
    expect(t).not.toMatch(/No goals set yet|didn.t load|couldn.t be shown/);
  });

  it("saved goal with the plan field absent: the same Generate path", async () => {
    const { ai_syllabus: _omit, ...withoutPlan } = row();
    void _omit;
    outcome = { kind: "rows", rows: [withoutPlan] };
    const { text: t } = await renderPlan();
    expect(t).toContain("Generate My Plan");
    expect(t).not.toMatch(/No goals set yet|didn.t load/);
  });

  it("a saved plan (object): summary, weeks, drills and labels shown, no generate prompt", async () => {
    const { text: t } = await renderPlan();
    expect(t).toContain(CONTEXT);
    expect(t).toContain(PLAN.summary);
    expect(t).toContain("Foundation");
    expect(t).toContain("Pattern Building");
    expect(t).toContain("Gate Drill"); // week 1 is open
    expect(t).toContain("Irons");
    expect(t).toContain("Putting");
    expect(t).not.toMatch(/Generate My Plan|No goals set yet|didn.t load/);
  });

  it("the golfer's own answers are labelled as theirs; AI tips are not presented as a professional's; drill counts read naturally", async () => {
    const { text: t } = await renderPlan();
    expect(t).toContain(`Your answers: ${CONTEXT}`);
    expect(t).not.toMatch(/Pro Tip/i);
    expect(t).toMatch(/2 drills/);
    expect(t).toMatch(/1 drill\b/);
    expect(t).not.toMatch(/1 drills/);
  });

  it("a saved plan stored as a legacy JSON string renders the same", async () => {
    outcome = { kind: "rows", rows: [row({ ai_syllabus: JSON.stringify(PLAN) })] };
    const { text: t } = await renderPlan();
    expect(t).toContain(PLAN.summary);
    expect(t).toContain("Gate Drill");
    expect(t).not.toMatch(/Generate My Plan|couldn.t be shown/);
  });

  it("the plan label counts the weeks actually saved (no invented 4-week claim) and says it is AI-generated, not coach-reviewed", async () => {
    const { text: t } = await renderPlan();
    expect(t).toMatch(/AI-Generated · 2-Week Plan/i);
    expect(t).not.toMatch(/4-Week/i);
    expect(t).toMatch(/hasn't been reviewed by a coach/);
  });

  it("an unknown drill category is not labelled as Irons (or anything else)", async () => {
    const odd = { summary: "One week.", weeks: [{ week: 1, theme: "Chipping", focus: "Contact", weekly_goal: "Ten clean chips.", pro_tip: "Quiet hands.",
      drills: [{ name: "Landing Spot Drill", description: "Land five chips on a towel.", duration: "15 min", category: "chipping" }] }] };
    outcome = { kind: "rows", rows: [row({ ai_syllabus: odd })] };
    const { text: t } = await renderPlan();
    expect(t).toContain("Landing Spot Drill");
    expect(t).not.toMatch(/\bIrons\b|Driving|Short Game/);
  });

  it("the Generate prompt does not present the AI as a coach", async () => {
    outcome = { kind: "rows", rows: [row({ ai_syllabus: null })] };
    const { text: t } = await renderPlan();
    expect(t).not.toMatch(/AI coach/i);
    expect(t).toMatch(/isn't reviewed by a coach/);
  });
});

describe("Your AI Plan — a stored plan that cannot be shown is said plainly (never 'no goals' or a generate prompt)", () => {
  const MALFORMED: [string, unknown][] = [
    ["unparseable JSON string", "{\"summary\": \"cut off"],
    ["weeks is not an array", { summary: "x", weeks: "four" }],
    ["no weeks", { summary: "x", weeks: [] }],
    ["summary is an object", { summary: { text: "x" }, weeks: PLAN.weeks }],
    ["a week is null", { summary: "x", weeks: [null] }],
    ["a week has no drills array", { summary: "x", weeks: [{ week: 1, theme: "t", focus: "f", weekly_goal: "g", pro_tip: "p" }] }],
    ["a drill name is an object", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ name: { en: "Gate" }, description: "d", duration: "5 min", category: "irons" }] }] }],
    ["a pro tip is an array", { summary: "x", weeks: [{ ...PLAN.weeks[0], pro_tip: ["a", "b"] }] }],
  ];
  for (const [label, stored] of MALFORMED) {
    it(label, async () => {
      outcome = { kind: "rows", rows: [row({ ai_syllabus: stored })] };
      const { text: t, html } = await renderPlan();
      expect(t).toContain("Your plan couldn't be shown");
      expect(t).toContain("Try again");
      expect(t).toContain(CONTEXT); // the saved goal is still acknowledged
      expect(html).toMatch(/href="\/goals\?new=1"/);
      expect(t).not.toMatch(/No goals set yet|Generate My Plan|didn.t load/);
      expect(t).not.toMatch(RAW);
    });
  }
});

describe("Your AI Plan — a failed read is unavailable (never 'no goals', a generate prompt or a fake plan)", () => {
  const FAILURES: [string, () => void][] = [
    ["returned error, no rows", () => { outcome = { kind: "error" }; }],
    ["returned error carrying a real row", () => { outcome = { kind: "error", withRows: true }; }],
    ["rejected read", () => { outcome = { kind: "reject" }; }],
    ["client throws while building the query", () => { outcome = { kind: "throw" }; }],
    ["client construction fails", () => { createError = new Error("supabaseUrl is required (synthetic)"); }],
    ["no error and no data (null envelope)", () => { outcome = { kind: "data", data: null }; }],
    ["no error, a non-array body", () => { outcome = { kind: "data", data: { unexpected: true } }; }],
    ["more rows than the one asked for", () => { outcome = { kind: "data", data: [row(), row({ id: "goal-row-0" })] }; }],
    ["a row that is not a record", () => { outcome = { kind: "data", data: ["goal-row-1"] }; }],
    ["a goal field of the wrong type", () => { outcome = { kind: "data", data: [row({ handicap_baseline: { value: 12.4 } })] }; }],
    ["an ordinary error that happens to carry a digest", () => { outcome = { kind: "reject", error: Object.assign(new Error("boom"), { digest: "2731400000" }) }; }],
  ];
  for (const [label, arrange] of FAILURES) {
    it(label, async () => {
      arrange();
      const { text: t, html, element } = await renderPlan();
      expect(t).toContain("Your goals didn't load");
      expect(t).toContain("Try again");
      expect(html).toMatch(/role="alert"/);
      expect(t).not.toMatch(/No goals set yet|Generate My Plan|Regenerate|couldn.t be shown|Foundation|Gate Drill|Handicap/);
      expect(html).not.toMatch(/href="\/goals\?new=1"/);
      expect(t).not.toMatch(RAW);
      expect(findPlanDisplay(element)).toBeNull();
    });
  }

  it("Next.js control flow raised inside the read is passed through, not reclassified", async () => {
    for (const digest of ["NEXT_REDIRECT;replace;/login;307;", "NEXT_NOT_FOUND", "DYNAMIC_SERVER_USAGE"]) {
      const flow = Object.assign(new Error(digest), { digest });
      createError = flow;
      await expect(GoalsPlanPage()).rejects.toBe(flow);
      createError = null;
      outcome = { kind: "reject", error: flow };
      await expect(GoalsPlanPage()).rejects.toBe(flow);
      outcome = { kind: "rows", rows: [row()] };
    }
  });
});

describe("Your AI Plan — the plan view is tied to the current saved plan", () => {
  async function planKey(rows: unknown[]) {
    outcome = { kind: "rows", rows };
    const display = findPlanDisplay((await renderPlan()).element);
    expect(display).not.toBeNull();
    return display!.key;
  }

  it("a newer goal row or a regenerated plan gets a new identity; the same saved plan keeps it; the row id is not exposed", async () => {
    const a1 = await planKey([row()]);
    const a2 = await planKey([row()]);
    const newer = await planKey([row({ id: "goal-row-2", ai_syllabus: { ...PLAN, summary: "A newer plan." } })]);
    const regenerated = await planKey([row({ ai_syllabus: { ...PLAN, summary: "Regenerated elsewhere." } })]);
    const sameContentNewRow = await planKey([row({ id: "goal-row-3" })]);
    const goalOnly = await planKey([row({ ai_syllabus: null })]);
    expect(a1).toBeTruthy();
    expect(a2).toBe(a1);
    expect(new Set([a1, newer, regenerated, sameContentNewRow, goalOnly]).size).toBe(5);
    for (const key of [a1, newer, regenerated, sameContentNewRow, goalOnly]) expect(String(key)).not.toContain("goal-row");
  });

  it("only the checked plan reaches the client view (no row, no unknown fields)", async () => {
    outcome = { kind: "rows", rows: [row({ private_note: "not for the view", ai_syllabus: { ...PLAN, internal: "x" } })] };
    const display = findPlanDisplay((await renderPlan()).element)!;
    const props = display.props as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["hasGoals", "initialSyllabus"]);
    expect(JSON.stringify(props)).not.toMatch(/private_note|internal|goal-row|golfer-1/);
  });
});

describe("Your AI Plan — accessible controls in the saved-plan view", () => {
  it("week accordions expose expanded state and the region they control; regenerate and new-goals controls are named 44px targets", async () => {
    const { html } = await renderPlan();
    const toggles = Array.from(html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g));
    expect(toggles.map((m) => m[1])).toEqual(["true", "false"]);
    const controls = /aria-controls="([^"]+)"/.exec(toggles[0][0])?.[1];
    expect(controls && html.includes(`id="${controls}"`)).toBe(true);
    expect(toggles[1][0]).not.toMatch(/aria-controls/);
    // each week toggle is a heading's button, spoken as "Week n: …" (the visual W badge is hidden from assistive tech)
    expect(Array.from(html.matchAll(/<h2><button[^>]*aria-expanded=/g))).toHaveLength(2);
    expect(html).toMatch(/<span class="sr-only">Week 1: <\/span><span aria-hidden="true"[^>]*>W1<\/span>/);
    // Regenerate has a visible name (not an icon only) and a 44px target
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*min-w-11[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*Regenerate plan<\/button>/);
    expect(linkTag(html, "/goals?new=1")).toMatch(/class="[^"]*min-h-11/);
    expect(html).toMatch(/<h1[^>]*id="my-goals-heading"/);
  });
});

describe("Your AI Plan — a plan the view cannot show, however it arrives", () => {
  it("PlanDisplay given a non-conforming plan (e.g. a freshly generated one) shows the recoverable panel, never a crash or [object Object]", () => {
    const html = renderToStaticMarkup(
      <PlanDisplay hasGoals initialSyllabus={{ summary: { text: "x" }, weeks: "four" } as unknown as React.ComponentProps<typeof PlanDisplay>["initialSyllabus"]} />,
    );
    const t = text(html);
    expect(t).toContain("Your plan couldn't be shown");
    expect(t).toContain("Try again");
    expect(html).toMatch(/role="alert"/);
    expect(t).not.toMatch(/\[object Object\]|Generate My Plan|AI-Generated/);
  });
});

// ── /goals ──────────────────────────────────────────────────────────────────
describe("My Goals entry", () => {
  it("signed out: the unchanged login redirect, before any table read", async () => {
    session = null;
    await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams: {} })).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    expect(calls).toEqual([]);
  });

  it("auth outage: the auth failure propagates, before any table read", async () => {
    const outage = Object.assign(new Error("Supabase Auth verification is unavailable."), { name: "AuthVerificationUnavailableError" });
    vi.mocked(getServerSession).mockRejectedValueOnce(outage);
    await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams: {} })).rejects.toBe(outage);
    expect(calls).toEqual([]);
  });

  it("a golfer with a saved goal is taken to the saved plan", async () => {
    await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams: {} })).rejects.toMatchObject({ digest: expect.stringContaining(";/goals/plan;") });
    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/goals/plan");
  });

  it("the entry read: user_goals, the session owner, newest first, one row, the id only", async () => {
    outcome = { kind: "rows", rows: [] };
    await renderEntry();
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("user_goals");
    expect(selectedColumns(calls[0])).toEqual(["id"]);
    expect(calls[0].ops.filter((op) => op[0] === "eq")).toEqual([["eq", "user_id", "golfer-1"]]);
    expect(calls[0].ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls[0].ops).toContainEqual(["limit", 1]);
  });

  it("confirmed no goals: the unchanged goals form", async () => {
    outcome = { kind: "rows", rows: [] };
    const { text: t } = await renderEntry();
    expect(t).toContain("Set Your Goals");
    expect(t).toContain("Step 1 of 3");
    expect(t).toContain("Current Handicap Index");
    expect(t).not.toMatch(/didn.t load/);
  });

  const ENTRY_FAILURES: [string, () => void][] = [
    ["returned error", () => { outcome = { kind: "error" }; }],
    ["returned error carrying a real row", () => { outcome = { kind: "error", withRows: true }; }],
    ["rejected read", () => { outcome = { kind: "reject" }; }],
    ["client construction fails", () => { createError = new Error("supabaseUrl is required (synthetic)"); }],
    ["no error and no data", () => { outcome = { kind: "data", data: null }; }],
  ];
  for (const [label, arrange] of ENTRY_FAILURES) {
    it(`a failed entry read is unavailable, not onboarding: ${label}`, async () => {
      arrange();
      const { text: t, html } = await renderEntry();
      expect(t).toContain("Your goals didn't load");
      expect(html).toMatch(/role="alert"/);
      expect(t).not.toMatch(/Step 1 of 3|Set Your Goals|Generate My Plan|No goals set yet/);
      expect(t).not.toMatch(RAW);
      expect(vi.mocked(redirect)).not.toHaveBeenCalled();
    });
  }

  it("Set new goals (?new=1): the unchanged form on purpose, with a way back, no read and no redirect even with a saved goal", async () => {
    const { text: t, html } = await renderEntry({ new: "1" });
    expect(t).toContain("Step 1 of 3");
    expect(t).toMatch(/Nothing changes until you submit/);
    expect(t).toContain("Back to My Goals");
    expect(linkTag(html, "/goals")).toMatch(/class="[^"]*min-h-11/);
    expect(calls).toEqual([]);
    expect(vi.mocked(redirect)).not.toHaveBeenCalled();
  });

  it("Set new goals (?new=1) signed out: the unchanged login redirect, no read and no form", async () => {
    session = null;
    await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams: { new: "1" } })).rejects.toMatchObject({ digest: expect.stringContaining(";/login;") });
    expect(calls).toEqual([]);
  });

  it("Set new goals (?new=1) during an auth outage: the auth failure propagates", async () => {
    const outage = Object.assign(new Error("Supabase Auth verification is unavailable."), { name: "AuthVerificationUnavailableError" });
    vi.mocked(getServerSession).mockRejectedValueOnce(outage);
    await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams: { new: "1" } })).rejects.toBe(outage);
    expect(calls).toEqual([]);
  });

  it("any other value of the parameter is the ordinary entry", async () => {
    for (const searchParams of [{ new: "true" }, { new: ["1", "1"] }, { fresh: "1" }]) {
      calls = [];
      await expect((GoalsPage as (p: unknown) => Promise<unknown>)({ searchParams })).rejects.toMatchObject({ digest: expect.stringContaining(";/goals/plan;") });
      expect(calls).toHaveLength(1);
    }
  });
});
