/**
 * GJ-PARALLEL-03 — My Goals: honest read states for the latest saved goal and
 * the plan stored with it.
 *
 * Both goals pages read at most one row: the golfer's newest `user_goals` row.
 * That read either succeeded — and then "no row" genuinely means no goals yet —
 * or it did not, and then nothing is known: not "no goals", not "no plan". A
 * stored plan is a separate fact again: it may be absent (never generated),
 * displayable, or stored in a shape the plan view cannot show safely.
 *
 * Read-only by construction: this module only awaits the read it is given. It
 * never retries on its own, writes, generates a plan or calls a provider, and it
 * keeps no error text, so nothing raw can reach a golfer-facing message.
 */

/** The `/goals` entry read: only whether a latest goal row exists. */
export const GOAL_ENTRY_COLUMNS = "id";
/** The `/goals/plan` read: the four existing fields plus the row id (used only to identify the current plan). */
export const GOAL_PLAN_COLUMNS = "id, handicap_baseline, primary_miss, target_goal, ai_syllabus";

/** The shape a Supabase read resolves to. Only these two fields are used. */
export interface GoalReadResponse {
  readonly data: unknown;
  readonly error: unknown;
}

/**
 * Next.js signals redirects, notFound() and dynamic-rendering bail-outs by
 * throwing (Next 14.2: a `digest` starting NEXT_REDIRECT, NEXT_NOT_FOUND,
 * DYNAMIC_SERVER_USAGE or BAILOUT_TO_CLIENT_SIDE_RENDERING; a
 * NEXT_STATIC_GEN_BAILOUT `code`; a React postpone). Those are control flow,
 * never a failed read, so they are rethrown untouched.
 */
export function isNextControlFlow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { digest, code } = error as { digest?: unknown; code?: unknown };
  if (typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/.test(digest)) return true;
  if (code === "NEXT_STATIC_GEN_BAILOUT") return true;
  return (error as { $$typeof?: unknown }).$$typeof === Symbol.for("react.postpone");
}

/**
 * Runs one read (client construction included) and returns its rows only when
 * it is a successful bounded list: no error, an array, at most one row (the
 * reads ask for one). Anything else is `null` (unavailable). Never rejects,
 * except to pass Next.js control flow through.
 */
async function boundedRows(run: () => PromiseLike<GoalReadResponse>): Promise<unknown[] | null> {
  let response: GoalReadResponse;
  try {
    response = await run();
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return null;
  }
  if (typeof response !== "object" || response === null) return null;
  if (response.error || !Array.isArray(response.data) || response.data.length > 1) return null;
  return response.data;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRowId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// ─── /goals entry ─────────────────────────────────────────────────────────────

export type GoalEntryRead = { readonly status: "saved" } | { readonly status: "none" } | { readonly status: "unavailable" };

/** Whether the golfer has a latest saved goal: "saved", a confirmed "none", or "unavailable". */
export async function readGoalEntry(run: () => PromiseLike<GoalReadResponse>): Promise<GoalEntryRead> {
  const rows = await boundedRows(run);
  if (rows === null) return { status: "unavailable" };
  if (rows.length === 0) return { status: "none" };
  const row = rows[0];
  return isRecord(row) && isRowId(row.id) ? { status: "saved" } : { status: "unavailable" };
}

/** `/goals?new=1` opens the unchanged goals form on purpose. A display choice only: it grants nothing and writes nothing. */
export function isNewGoalsRequest(searchParams: unknown): boolean {
  return isRecord(searchParams) && searchParams.new === "1";
}

// ─── Stored plan shape ────────────────────────────────────────────────────────

export const PLAN_CATEGORIES = ["driving", "irons", "short_game", "putting", "mental"] as const;
export type PlanCategory = (typeof PLAN_CATEGORIES)[number];

export interface PlanDrill {
  readonly name: string;
  readonly description: string | null;
  readonly duration: string | null;
  /** null when the stored category is absent or not one of the five known categories: no label is shown. */
  readonly category: PlanCategory | null;
}
export interface PlanWeek {
  readonly week: number;
  readonly theme: string;
  readonly focus: string | null;
  readonly drills: readonly PlanDrill[];
  readonly weekly_goal: string | null;
  readonly pro_tip: string | null;
}
/** A saved plan reduced to exactly the fields the plan view renders (field names as the existing writer stores them). */
export interface GoalPlan {
  readonly summary: string;
  readonly weeks: readonly PlanWeek[];
}

const INVALID = Symbol("invalid");
const requiredText = (value: unknown) => (typeof value === "string" ? value : INVALID);
const optionalText = (value: unknown) => (value === null || value === undefined ? null : typeof value === "string" ? value : INVALID);

/**
 * The narrow display policy for a stored plan (no writer schema, no week
 * count, no coaching judgement). Required: an object with a text `summary` and
 * a non-empty `weeks` array; each week an object with a text `theme` and a
 * `drills` array; each drill an object with a text `name`. Optional (absent or
 * null → that line is not shown): week `focus`, `weekly_goal`, `pro_tip`, drill
 * `description`, `duration`, and `category` (an unknown category shows no
 * label). A week number that is absent, or not a whole number from 1 to 99,
 * shows the week's position instead. Any value of another type (an object,
 * array or number where text is rendered, a non-number week) makes the whole
 * plan not displayable — it is never shown partly, coerced to text or
 * replaced. Unknown extra fields are dropped. The result is itself valid
 * input, so checking it again changes nothing.
 */
export function toGoalPlan(value: unknown): GoalPlan | null {
  if (!isRecord(value)) return null;
  const summary = requiredText(value.summary);
  if (summary === INVALID || !Array.isArray(value.weeks) || value.weeks.length === 0) return null;
  const weeks: PlanWeek[] = [];
  for (let index = 0; index < value.weeks.length; index++) {
    const week: unknown = value.weeks[index];
    if (!isRecord(week) || !Array.isArray(week.drills)) return null;
    const stored = week.week;
    if (stored !== null && stored !== undefined && (typeof stored !== "number" || !Number.isFinite(stored))) return null;
    const number = typeof stored === "number" && Number.isInteger(stored) && stored >= 1 && stored <= 99 ? stored : index + 1;
    const theme = requiredText(week.theme);
    const focus = optionalText(week.focus);
    const weeklyGoal = optionalText(week.weekly_goal);
    const proTip = optionalText(week.pro_tip);
    if (theme === INVALID || focus === INVALID || weeklyGoal === INVALID || proTip === INVALID) return null;
    const drills: PlanDrill[] = [];
    for (const drill of week.drills as unknown[]) {
      if (!isRecord(drill)) return null;
      const name = requiredText(drill.name);
      const description = optionalText(drill.description);
      const duration = optionalText(drill.duration);
      const category = optionalText(drill.category);
      if (name === INVALID || description === INVALID || duration === INVALID || category === INVALID) return null;
      const known = (PLAN_CATEGORIES as readonly string[]).includes(category ?? "") ? (category as PlanCategory) : null;
      drills.push({ name, description, duration, category: known });
    }
    weeks.push({ week: number, theme, focus, drills, weekly_goal: weeklyGoal, pro_tip: proTip });
  }
  return { summary, weeks };
}

// ─── /goals/plan ──────────────────────────────────────────────────────────────

/** The golfer's own answers on the latest goal row (user-entered, shown as given). */
export interface GoalContext {
  readonly handicap_baseline: number | null;
  readonly primary_miss: string | null;
  readonly target_goal: string | null;
}

export type LatestGoalRead =
  /** The read did not succeed (or returned something other than the row it asked for): nothing is known. */
  | { readonly status: "unavailable" }
  /** The read succeeded and the golfer has no goal row. */
  | { readonly status: "none" }
  /** A saved goal with no stored plan (never generated, or generation failed): the explicit Generate path. */
  | { readonly status: "goal"; readonly context: GoalContext; readonly planKey: string }
  /** A saved goal with a plan the view can show. */
  | { readonly status: "plan"; readonly context: GoalContext; readonly plan: GoalPlan; readonly planKey: string }
  /** A saved goal whose stored plan cannot be parsed or shown safely. */
  | { readonly status: "unreadable"; readonly context: GoalContext };

const UNAVAILABLE: LatestGoalRead = Object.freeze({ status: "unavailable" });

/** 32-bit FNV-1a, hex. Only used to tell plans apart; not a security property. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Identifies the current saved plan: the goal row and what it holds. The plan
 * view is keyed by it, so a newer goal row, or a plan regenerated elsewhere,
 * mounts a fresh view instead of reusing the previous plan's client state. The
 * row id is folded into the hash, never sent to the browser as such.
 */
export function goalPlanKey(rowId: string, plan: GoalPlan | null): string {
  return `goal-plan-${fnv1a(`${rowId}\u0000${JSON.stringify(plan)}`)}`;
}

/**
 * Reads and classifies the golfer's latest goal row (see LatestGoalRead).
 * A returned error (even with rows), a rejected or thrown read (client
 * construction included), a non-array response, more than one row, or a row
 * that is not the record asked for is "unavailable". A stored plan given as
 * an object or as a legacy JSON string is checked with `toGoalPlan`.
 */
export async function readLatestGoal(run: () => PromiseLike<GoalReadResponse>): Promise<LatestGoalRead> {
  const rows = await boundedRows(run);
  if (rows === null) return UNAVAILABLE;
  if (rows.length === 0) return { status: "none" };
  const row = rows[0];
  if (!isRecord(row) || !isRowId(row.id)) return UNAVAILABLE;
  const handicap = row.handicap_baseline ?? null;
  const primaryMiss = optionalText(row.primary_miss);
  const targetGoal = optionalText(row.target_goal);
  if ((handicap !== null && (typeof handicap !== "number" || !Number.isFinite(handicap))) || primaryMiss === INVALID || targetGoal === INVALID) {
    return UNAVAILABLE;
  }
  const context: GoalContext = { handicap_baseline: handicap, primary_miss: primaryMiss, target_goal: targetGoal };

  const stored = row.ai_syllabus;
  if (stored === null || stored === undefined) return { status: "goal", context, planKey: goalPlanKey(row.id, null) };
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return { status: "unreadable", context };
    }
  }
  const plan = toGoalPlan(value);
  if (!plan) return { status: "unreadable", context };
  return { status: "plan", context, plan, planKey: goalPlanKey(row.id, plan) };
}

/** The header line under "Your AI Plan": the golfer's own answers, formatted exactly as before. */
export function goalContextLine(context: GoalContext): string {
  const parts: string[] = [];
  if (context.handicap_baseline != null) parts.push(`Handicap ${context.handicap_baseline}`);
  if (context.primary_miss && context.primary_miss !== "None") parts.push(`Primary miss: ${context.primary_miss}`);
  if (context.target_goal) parts.push(context.target_goal);
  return parts.join(" · ");
}

export const GOALS_COPY = {
  entryTitle: "My Goals",
  planTitle: "Your AI Plan",
  /** Precedes the golfer's own answers in the plan header (user-entered, not measured or inferred). */
  answersPrefix: "Your answers: ",
  setNewGoals: "Set new goals",
  newGoalsTitle: "Set New Goals",
  newGoalsBody: "Answer three quick questions to set new goals. Nothing changes until you submit; after that, My Goals shows your new goals and your current plan is no longer shown there.",
  backToGoals: "Back to My Goals",
  aiPlanNote: "Generated by AI from your answers. It hasn't been reviewed by a coach.",
  regenerate: "Regenerate plan",
  unavailableTitle: "Your goals didn't load",
  unavailableBody: "We couldn't load your goals just now. Try again in a moment.",
  stillUnavailable: "Your goals still didn't load. Try again in a moment.",
  unreadableTitle: "Your plan couldn't be shown",
  unreadableBody: "Your goals are saved, but their plan couldn't be displayed here. Try again, or set new goals to build a new plan.",
  stillUnreadable: "Your plan still couldn't be shown. You can set new goals to build a new plan.",
  progressHub: "Go to Progress Hub",
  retry: "Try again",
  retrying: "Trying again…",
} as const;
