import { describe, expect, it, vi } from "vitest";
import { notFound, redirect } from "next/navigation";
import { DynamicServerError } from "next/dist/client/components/hooks-server-context";
import { BailoutToCSRError } from "next/dist/shared/lib/lazy-dynamic/bailout-to-csr";
import { StaticGenBailoutError } from "next/dist/client/components/static-generation-bailout";
import {
  GOALS_COPY,
  GOAL_ENTRY_COLUMNS,
  GOAL_PLAN_COLUMNS,
  goalContextLine,
  goalPlanKey,
  isNewGoalsRequest,
  isNextControlFlow,
  readGoalEntry,
  readLatestGoal,
  toGoalPlan,
  type GoalReadResponse,
} from "./golfer-journey-goals-read-state";

/** GJ-PARALLEL-03 — the goals read/shape classifier, with synthetic responses only. */

const PLAN = {
  summary: "Two weeks to steadier contact.",
  weeks: [
    { week: 1, theme: "Foundation", focus: "Setup", weekly_goal: "7 of 10 centred.", pro_tip: "Slow takeaway.",
      drills: [{ name: "Gate Drill", description: "Swing through two tees.", duration: "20 min", category: "irons" }] },
    { week: 2, theme: "Pattern", focus: "Tempo", weekly_goal: "One tempo.", pro_tip: "Count to three.",
      drills: [{ name: "Pump Drill", description: "Pump twice.", duration: "50 reps", category: "driving" }] },
  ],
};
const row = (over: Record<string, unknown> = {}) => ({ id: "g-1", handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85", ai_syllabus: PLAN, ...over });
const ok = (data: unknown): GoalReadResponse => ({ data, error: null });
const read = (response: unknown) => readLatestGoal(() => Promise.resolve(response as GoalReadResponse));
const ERROR = { message: "permission denied (synthetic)", code: "42501" };

describe("readLatestGoal — envelopes", () => {
  it("a successful empty list is a confirmed 'none'", async () => {
    expect(await read(ok([]))).toEqual({ status: "none" });
  });
  const UNAVAILABLE: [string, unknown][] = [
    ["returned error without data", { data: null, error: ERROR }],
    ["returned error carrying a real row", { data: [row()], error: ERROR }],
    ["null data, no error", ok(null)],
    ["object data, no error", ok(row())],
    ["two rows for a one-row read", ok([row(), row({ id: "g-0" })])],
    ["a row that is null", ok([null])],
    ["a row that is a string", ok(["g-1"])],
    ["a row that is an array", ok([[row()]])],
    ["a row without an id", ok([row({ id: undefined })])],
    ["an empty id", ok([row({ id: "" })])],
    ["a numeric id", ok([row({ id: 7 })])],
    ["handicap as text", ok([row({ handicap_baseline: "12.4" })])],
    ["handicap as an object", ok([row({ handicap_baseline: { v: 1 } })])],
    ["primary miss as a number", ok([row({ primary_miss: 3 })])],
    ["target goal as an object", ok([row({ target_goal: { text: "x" } })])],
    ["a null response", null],
    ["an undefined response", undefined],
    ["a primitive response", "ok"],
  ];
  for (const [label, response] of UNAVAILABLE) {
    it(`unavailable: ${label}`, async () => {
      expect(await read(response)).toEqual({ status: "unavailable" });
    });
  }
  it("unavailable: a rejected read, a synchronous throw (client construction), and odd thrown values; never rejects", async () => {
    expect(await readLatestGoal(() => Promise.reject(new Error("fetch failed")))).toEqual({ status: "unavailable" });
    expect(await readLatestGoal(() => { throw new Error("supabaseUrl is required"); })).toEqual({ status: "unavailable" });
    expect(await readLatestGoal(async () => { throw "string thrown"; })).toEqual({ status: "unavailable" });
    expect(await readLatestGoal(async () => { throw null; })).toEqual({ status: "unavailable" });
    expect(await readLatestGoal(() => Promise.reject(Object.assign(new Error("x"), { digest: "123456" })))).toEqual({ status: "unavailable" });
    expect(await readLatestGoal(() => Promise.reject(Object.assign(new Error("x"), { digest: "XNEXT_REDIRECT" })))).toEqual({ status: "unavailable" });
  });
  it("runs the read exactly once (no retry of its own) and keeps no error text", async () => {
    const run = vi.fn(() => Promise.resolve({ data: null, error: ERROR }));
    const result = await readLatestGoal(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/permission|42501|synthetic/);
  });
});

describe("Next.js control flow is passed through, never classified", () => {
  const FLOW: unknown[] = [
    Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }),
    Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }),
    Object.assign(new Error("Dynamic server usage"), { digest: "DYNAMIC_SERVER_USAGE" }),
    Object.assign(new Error("Bail out"), { digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" }),
    Object.assign(new Error("static bailout"), { code: "NEXT_STATIC_GEN_BAILOUT" }),
    { $$typeof: Symbol.for("react.postpone"), reason: "ppr" },
  ];
  for (const flow of FLOW) {
    it(`rethrows ${JSON.stringify((flow as { digest?: string; code?: string }).digest ?? (flow as { code?: string }).code ?? "postpone")}`, async () => {
      expect(isNextControlFlow(flow)).toBe(true);
      await expect(readLatestGoal(() => { throw flow; })).rejects.toBe(flow);
      await expect(readLatestGoal(() => Promise.reject(flow))).rejects.toBe(flow);
      await expect(readGoalEntry(() => Promise.reject(flow))).rejects.toBe(flow);
    });
  }
  it("recognises the errors the installed Next.js actually throws (not only hand-built digests)", async () => {
    const thrown: unknown[] = [];
    for (const raise of [() => redirect("/login"), () => notFound(), () => { throw new DynamicServerError("synthetic dynamic usage"); },
      () => { throw new BailoutToCSRError("synthetic bailout"); }, () => { throw new StaticGenBailoutError("synthetic static bailout"); }]) {
      try { raise(); } catch (error) { thrown.push(error); }
    }
    expect(thrown).toHaveLength(5);
    for (const error of thrown) {
      expect(isNextControlFlow(error)).toBe(true);
      await expect(readLatestGoal(() => Promise.reject(error))).rejects.toBe(error);
    }
  });
  it("ordinary errors are not control flow", () => {
    for (const e of [new Error("x"), null, undefined, "NEXT_REDIRECT", { digest: 5 }, { digest: "error-1" }, { code: "ECONNRESET" }]) {
      expect(isNextControlFlow(e)).toBe(false);
    }
  });
});

describe("readLatestGoal — a saved goal and its stored plan", () => {
  it("no stored plan (null or absent): the saved goal with its context, no plan", async () => {
    for (const r of [row({ ai_syllabus: null }), (({ ai_syllabus: _x, ...rest }) => rest)(row())]) {
      const result = await read(ok([r]));
      expect(result.status).toBe("goal");
      if (result.status !== "goal") return;
      expect(result.context).toEqual({ handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85" });
      expect(result.planKey).toMatch(/^goal-plan-[0-9a-f]{8}$/);
    }
  });
  it("a stored plan as an object or as a legacy JSON string: the same checked plan", async () => {
    const a = await read(ok([row()]));
    const b = await read(ok([row({ ai_syllabus: JSON.stringify(PLAN) })]));
    expect(a.status).toBe("plan");
    expect(b).toEqual(a);
    if (a.status !== "plan") return;
    expect(a.plan.weeks.map((w) => w.theme)).toEqual(["Foundation", "Pattern"]);
    expect(a.plan.weeks[0].drills[0]).toEqual({ name: "Gate Drill", description: "Swing through two tees.", duration: "20 min", category: "irons" });
  });
  it("missing context fields are null (absent answers are not invented)", async () => {
    const result = await read(ok([{ id: "g-1", ai_syllabus: null }]));
    expect(result).toMatchObject({ status: "goal", context: { handicap_baseline: null, primary_miss: null, target_goal: null } });
  });
  const UNREADABLE: [string, unknown][] = [
    ["an unparseable JSON string", "{\"summary\": \"cut"],
    ["a JSON string holding null", "null"],
    ["an empty string", ""],
    ["a JSON string holding a number", "42"],
    ["a double-encoded JSON string", JSON.stringify(JSON.stringify(PLAN))],
    ["a number", 42],
    ["an array", [PLAN]],
    ["no summary", { weeks: PLAN.weeks }],
    ["a numeric summary", { summary: 3, weeks: PLAN.weeks }],
    ["no weeks", { summary: "x" }],
    ["empty weeks", { summary: "x", weeks: [] }],
    ["weeks as an object", { summary: "x", weeks: { 0: PLAN.weeks[0] } }],
    ["a week that is a string", { summary: "x", weeks: ["week one"] }],
    ["a week number as text", { summary: "x", weeks: [{ ...PLAN.weeks[0], week: "1" }] }],
    ["no theme", { summary: "x", weeks: [{ ...PLAN.weeks[0], theme: undefined }] }],
    ["a numeric focus", { summary: "x", weeks: [{ ...PLAN.weeks[0], focus: 2 }] }],
    ["a weekly goal object", { summary: "x", weeks: [{ ...PLAN.weeks[0], weekly_goal: { text: "g" } }] }],
    ["a pro tip array", { summary: "x", weeks: [{ ...PLAN.weeks[0], pro_tip: ["a"] }] }],
    ["no drills array", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: undefined }] }],
    ["drills as an object", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: { a: 1 } }] }],
    ["a drill that is a string", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: ["Gate Drill"] }] }],
    ["a drill without a name", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ description: "d" }] }] }],
    ["a drill name object", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ name: { en: "Gate" } }] }] }],
    ["a description object", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ name: "n", description: { a: 1 } }] }] }],
    ["a numeric duration", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ name: "n", duration: 20 }] }] }],
    ["a numeric category", { summary: "x", weeks: [{ ...PLAN.weeks[0], drills: [{ name: "n", category: 1 }] }] }],
  ];
  for (const [label, stored] of UNREADABLE) {
    it(`a stored plan that cannot be shown is "unreadable" (the goal is kept): ${label}`, async () => {
      const result = await read(ok([row({ ai_syllabus: stored })]));
      expect(result).toEqual({ status: "unreadable", context: { handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85" } });
    });
  }
});

describe("toGoalPlan — the narrow display policy", () => {
  it("optional text may be absent or null and is then not shown; unknown or absent categories get no label; an absent week number is the position", () => {
    const plan = toGoalPlan({ summary: "", weeks: [
      { theme: "A", drills: [] },
      { week: null, theme: "B", focus: null, weekly_goal: null, pro_tip: undefined,
        drills: [{ name: "n1" }, { name: "n2", category: "chipping" }, { name: "n3", category: null, description: null, duration: "5 min" }] },
    ] });
    expect(plan).toEqual({ summary: "", weeks: [
      { week: 1, theme: "A", focus: null, weekly_goal: null, pro_tip: null, drills: [] },
      { week: 2, theme: "B", focus: null, weekly_goal: null, pro_tip: null, drills: [
        { name: "n1", description: null, duration: null, category: null },
        { name: "n2", description: null, duration: null, category: null },
        { name: "n3", description: null, duration: "5 min", category: null },
      ] },
    ] });
  });
  it("keeps every known category, any number of weeks (no four-week rule), and drops unknown fields", () => {
    const cats = ["driving", "irons", "short_game", "putting", "mental"];
    const plan = toGoalPlan({ summary: "s", extra: 1, weeks: [{ week: 7, theme: "t", secret: "x", drills: cats.map((category) => ({ name: category, category, internal: true })) }] });
    expect(plan?.weeks).toHaveLength(1);
    expect(plan?.weeks[0].week).toBe(7);
    expect(plan?.weeks[0].drills.map((d) => d.category)).toEqual(cats);
    expect(JSON.stringify(plan)).not.toMatch(/extra|secret|internal/);
  });
  it("shows a week number only when it is a whole number from 1 to 99; otherwise the week's position", () => {
    const weeks = [1, 99, 0, -1, 100, 1000000, 1.5].map((week) => ({ week, theme: "t", drills: [] }));
    expect(toGoalPlan({ summary: "s", weeks })?.weeks.map((w) => w.week)).toEqual([1, 99, 3, 4, 5, 6, 7]);
  });
  it("is idempotent: a checked plan checks to itself", () => {
    const once = toGoalPlan(PLAN);
    expect(once).not.toBeNull();
    expect(toGoalPlan(once)).toEqual(once);
  });
});

describe("goalPlanKey — identifies the current saved plan", () => {
  it("stable for the same row and plan; different for a new row or new content; the row id is not exposed", () => {
    const plan = toGoalPlan(PLAN);
    const changed = toGoalPlan({ ...PLAN, summary: "Regenerated." });
    const k = goalPlanKey("g-1", plan);
    expect(goalPlanKey("g-1", plan)).toBe(k);
    expect(new Set([k, goalPlanKey("g-2", plan), goalPlanKey("g-1", changed), goalPlanKey("g-1", null)]).size).toBe(4);
    expect(k).not.toContain("g-1");
  });
});

describe("readGoalEntry", () => {
  const entry = (response: unknown) => readGoalEntry(() => Promise.resolve(response as GoalReadResponse));
  it("saved / none / unavailable", async () => {
    expect(await entry(ok([{ id: "g-1" }]))).toEqual({ status: "saved" });
    expect(await entry(ok([]))).toEqual({ status: "none" });
    for (const response of [{ data: [{ id: "g-1" }], error: ERROR }, { data: null, error: ERROR }, ok(null), ok({ id: "g-1" }),
      ok([{ id: "a" }, { id: "b" }]), ok([{}]), ok([{ id: "" }]), ok(["g-1"]), null]) {
      expect(await entry(response)).toEqual({ status: "unavailable" });
    }
    expect(await readGoalEntry(() => Promise.reject(new Error("fetch failed")))).toEqual({ status: "unavailable" });
    expect(await readGoalEntry(() => { throw new Error("client"); })).toEqual({ status: "unavailable" });
  });
  it("selects only the id; the plan read selects only the four goal fields and the id", () => {
    expect(GOAL_ENTRY_COLUMNS).toBe("id");
    expect(GOAL_PLAN_COLUMNS.split(",").map((c) => c.trim()).sort()).toEqual(["ai_syllabus", "handicap_baseline", "id", "primary_miss", "target_goal"]);
  });
});

describe("isNewGoalsRequest — a display choice only", () => {
  it("true only for new=1", () => {
    expect(isNewGoalsRequest({ new: "1" })).toBe(true);
    for (const p of [{}, { new: "true" }, { new: ["1"] }, { new: "" }, { fresh: "1" }, undefined, null, "new=1", ["1"]]) {
      expect(isNewGoalsRequest(p)).toBe(false);
    }
  });
});

describe("goal context line and copy", () => {
  it("formats the golfer's own answers as before", () => {
    expect(goalContextLine({ handicap_baseline: 12.4, primary_miss: "Slice", target_goal: "Break 85" })).toBe("Handicap 12.4 · Primary miss: Slice · Break 85");
    expect(goalContextLine({ handicap_baseline: 0, primary_miss: "None", target_goal: null })).toBe("Handicap 0");
    expect(goalContextLine({ handicap_baseline: null, primary_miss: null, target_goal: "" })).toBe("");
  });
  it("copy is cause-neutral, never says 'no goals' for a failure, and does not claim coach review, accuracy, dates or cost", () => {
    const all = Object.values(GOALS_COPY).join(" ");
    for (const failure of [GOALS_COPY.unavailableTitle, GOALS_COPY.unavailableBody, GOALS_COPY.stillUnavailable, GOALS_COPY.unreadableBody]) {
      expect(failure).not.toMatch(/no goals|not set|empty/i);
    }
    expect(all).not.toMatch(/permission|network|server|database|error code|timeout|accura|%|\$|saved on|reviewed by your coach|coach-approved|coach approved/i);
    expect(GOALS_COPY.aiPlanNote).toMatch(/AI/);
    expect(GOALS_COPY.aiPlanNote).toMatch(/hasn't been reviewed by a coach/);
  });
});
