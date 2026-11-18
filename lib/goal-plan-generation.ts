import "server-only";
import OpenAI from "openai";
import { resolveVerifiedAuth } from "@/utils/supabase/server";
import {
  GOAL_PLAN_COLUMNS,
  isNextControlFlow,
  readLatestGoal,
  toGoalPlan,
  type GoalPlan,
  type GoalReadResponse,
  type LatestGoalRead,
} from "@/lib/golfer-journey-goals-read-state";

/**
 * AG-S1 — the one server boundary for saving goal answers and generating a goal plan.
 *
 * What a golfer is told is decided by what was observed, never by what was attempted:
 * - `saved` only when a bounded, owner-scoped readback of the stored plan, checked with the accepted
 *   `toGoalPlan` rules, displays exactly what was generated (the displayed form matched; fields the
 *   display drops are not compared). The plan returned is the persisted one.
 * - The write's own response (an id, zero rows, an error, nothing) is logged only. A lost response or
 *   readback is "couldn't confirm", never "nothing saved".
 *
 * Limits, stated directly (AG-PLAN-01-R1):
 * - No proof before spending that the plan can be saved: the caller-scoped write happens after the
 *   paid generation and can fail. This module makes that visible; it does not prevent it.
 * - Billing is unknown for any error once the SDK call has started; an abort is not proof of no charge.
 * - No provenance: a stored plan may not have been produced here. No server rate limit or single-flight.
 *   No exactly-once behaviour. `saved` describes one observation.
 *
 * Writes: the submit's goal insert (exactly user_id + the three answers) and one `ai_syllabus` update.
 * No probe write, no privileged client, no schema change. No automatic retry anywhere: the provider
 * client is built with `maxRetries: 0`, and every read uses `.retry(false)` (installed postgrest-js
 * retries GETs by default). Membership: the owner chose no new gate (OD-1), so no tier is read.
 */

// ── engineering values (AG-PLAN-01-R1 §7: offline candidate inputs, not hosted evidence) ─────────────

export const HANDICAP_MIN = -10;
export const HANDICAP_MAX = 54;
export const TARGET_GOAL_MAX = 500;
export const MISS_OPTIONS = ["None", "Slice", "Hook", "Fat", "Thin"] as const;
/** Sized against the plan schema: a maximal plan (4 weeks × 5 drills at the described sizes) is ≈3,500 tokens at a
 *  conservative 3 characters per token. `finish_reason: "length"` is a failure, never written. */
export const OUTPUT_TOKEN_CAP = 4000;
/** Candidate only (CLAUDE.md:17 states a 15 s limit as local intent). Hosted fact H7 must replace it. */
export const FUNCTION_BUDGET_MS = 15_000;
/** Budget kept for the write and the readback after the model call (each is aborted at half of it). */
export const POST_CALL_MS = 2_500;
/** Deadline for each database read and write (an abort reaches postgrest-js as status 0: "no response"). */
export const DB_STEP_TIMEOUT_MS = 1_250;
/** Margin for clock skew between this server and the Auth issuer. */
export const SKEW_MS = 5_000;
/** The model call's limit: the budget less POST_CALL_MS and a 1.5 s allowance for the steps before it. Enforced by the
 *  SDK timeout (until response headers) and by an abort signal that also covers reading the response body. */
export const PROVIDER_TIMEOUT_MS = 11_000;
export const MODEL = "gpt-4o-mini";

// ── outcomes and fixed copy ───────────────────────────────────────────────────────────────────────────

export type GenerationOutcome =
  | "saved"
  | "other_plan_stored"
  | "no_plan_stored"
  | "stored_plan_unreadable"
  | "goal_missing"
  | "save_unconfirmed"
  | "not_authenticated"
  | "auth_unavailable"
  | "no_goal"
  | "goal_unavailable"
  | "invalid_input"
  | "time_insufficient"
  | "provider_not_configured"
  | "provider_failed";
export type SubmitOutcome = GenerationOutcome | "goal_save_failed" | "goal_save_unconfirmed";

/** What the plan view shows after an attempt: the persisted plan, no plan, the unreadable state, the
 *  missing-goal state, or whatever verified plan is already on screen ("keep"). */
export type PlanDisplayState = "stored_plan" | "no_plan" | "unreadable" | "goal_missing" | "keep";

export interface GenerationResult {
  readonly outcome: GenerationOutcome;
  /** Fixed copy; null only for a plain `saved`. Never provider or database text. */
  readonly message: string | null;
  readonly display: PlanDisplayState;
  /** Only ever the persisted, validated plan observed by the readback (`saved`, `other_plan_stored`). */
  readonly plan: GoalPlan | null;
  /** True when the outcome came from the content readback (the view then offers "Reload My Plan"). */
  readonly observed: boolean;
}
export interface SubmitResult extends Omit<GenerationResult, "outcome"> {
  readonly outcome: SubmitOutcome;
  /** True only when the goal insert was confirmed (exactly one row returned). */
  readonly goalSaved: boolean;
}

export const PLAN_COPY = {
  saved: "Your new plan is saved.",
  other_plan_stored: "Your new plan isn't the plan saved now. This is your saved plan.",
  no_plan_stored: "No plan is saved for this goal right now. Your new plan wasn't confirmed.",
  stored_plan_unreadable: "Your new plan wasn't confirmed.",
  goal_missing: "We couldn't find this goal. Open My Goals.",
  save_unconfirmed: "We couldn't confirm whether your new plan was saved. Reload My Plan to see what's saved.",
  not_authenticated: "Please sign in again.",
  auth_unavailable: "We couldn't check your sign-in right now. Try again shortly.",
  no_goal: "Set your goals first.",
  goal_unavailable: "We couldn't load your goals.",
  time_session: "Please sign in again, then try.",
  time_budget: "Please try again.",
  provider_not_configured: "Plan generation is unavailable right now.",
  provider_failed: "We couldn't create a new plan. Nothing new was saved from this attempt.",
  goal_save_failed: "We couldn't save your answers.",
  goal_save_unconfirmed: "We couldn't confirm your answers were saved. Open My Goals to check before trying again.",
  answers_saved: "Your answers were saved.",
  submit_provider_failed: "We couldn't create a plan. No plan was saved from this attempt.",
  submit_other_plan_stored: "Your new plan isn't the plan saved now. Open My Plan to see what's saved.",
  invalid_handicap: `Enter a handicap index between ${HANDICAP_MIN} and ${HANDICAP_MAX}, or leave it blank.`,
  invalid_miss: "Choose one of the listed misses.",
  invalid_goal: `Keep your goal to ${TARGET_GOAL_MAX} characters or fewer.`,
  invalid_stored: "Your saved answers can't be used for a plan. Set new goals to build one.",
} as const;

// ── answers ───────────────────────────────────────────────────────────────────────────────────────────

export interface GoalAnswers {
  readonly handicap_baseline: number | null;
  readonly primary_miss: string | null;
  readonly target_goal: string | null;
}
type Checked = { ok: true; answers: GoalAnswers } | { ok: false; message: string };

function checkAnswers(handicap: number | null, miss: string | null, goal: string | null): Checked {
  if (handicap !== null && (!Number.isFinite(handicap) || handicap < HANDICAP_MIN || handicap > HANDICAP_MAX)) {
    return { ok: false, message: PLAN_COPY.invalid_handicap };
  }
  if (miss !== null && !(MISS_OPTIONS as readonly string[]).includes(miss)) return { ok: false, message: PLAN_COPY.invalid_miss };
  if (goal !== null && goal.length > TARGET_GOAL_MAX) return { ok: false, message: PLAN_COPY.invalid_goal };
  return { ok: true, answers: { handicap_baseline: handicap, primary_miss: miss, target_goal: goal } };
}

/** The three answers as the form sends them. Every field must be present as text; an empty handicap or goal is "not given". */
export function parseSubmittedAnswers(formData: FormData): Checked {
  if (!(formData instanceof FormData)) return { ok: false, message: PLAN_COPY.invalid_handicap };
  const h = formData.get("handicap_baseline");
  const m = formData.get("primary_miss");
  const g = formData.get("target_goal");
  if (typeof h !== "string" || typeof m !== "string" || typeof g !== "string") return { ok: false, message: PLAN_COPY.invalid_handicap };
  const handicapText = h.trim();
  if (handicapText !== "" && !/^-?\d{1,2}(\.\d{1,2})?$/.test(handicapText)) return { ok: false, message: PLAN_COPY.invalid_handicap };
  const goal = g.trim();
  return checkAnswers(handicapText === "" ? null : Number(handicapText), m === "" ? null : m, goal === "" ? null : goal);
}

// ── prompt (unchanged from the accepted action) ───────────────────────────────────────────────────────

const SYLLABUS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 sentence overview of the plan rationale and expected outcome." },
    weeks: {
      type: "array",
      description: "Exactly 4 weekly blocks, progressing from foundation to competition prep.",
      items: {
        type: "object",
        properties: {
          week: { type: "integer", description: "Week number 1-4." },
          theme: { type: "string", description: "Short catchy name for the week, e.g. 'Foundation & Fault Diagnosis'." },
          focus: { type: "string", description: "Primary technical area for this week." },
          drills: {
            type: "array",
            description: "3-5 specific, executable drills.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Specific named drill." },
                description: { type: "string", description: "Clear, actionable instruction in 2-3 sentences." },
                duration: { type: "string", description: "e.g. '20 min', '50 reps', '3 sets × 15 swings'." },
                category: { type: "string", enum: ["driving", "irons", "short_game", "putting", "mental"] },
              },
              required: ["name", "description", "duration", "category"],
              additionalProperties: false,
            },
          },
          weekly_goal: { type: "string", description: "Measurable, observable outcome to achieve by end of week." },
          pro_tip: { type: "string", description: "One elite-level insight or swing thought for the week." },
        },
        required: ["week", "theme", "focus", "drills", "weekly_goal", "pro_tip"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "weeks"],
  additionalProperties: false,
} as const;

function buildMessages(a: GoalAnswers): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: `You are an expert PGA golf instructor and sports performance coach specialising in structured practice design.

Generate a personalised 4-week golf practice plan tailored to the golfer's exact profile.

Rules:
- Exactly 4 weeks in the plan
- Each week has 3-5 drills
- Logical progression: Week 1 = diagnosis & foundation, Week 2 = pattern building, Week 3 = feel & variability, Week 4 = pressure simulation & competition prep
- All drills must be executable at a practice range without special equipment
- Tailor every detail — drill names, cues, focus areas — to the golfer's specific handicap, miss pattern, and goal`,
    },
    {
      role: "user",
      content: `Generate a 4-week personalised golf practice plan for this golfer:

Handicap Index: ${a.handicap_baseline != null ? a.handicap_baseline : "Unknown (assume ~18)"}
Primary miss: ${a.primary_miss ?? "None specified"}
Target goal: ${a.target_goal ?? "General improvement"}`,
    },
  ];
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => Date.now();

/** `exp` (ms) from the access token Auth has just verified; never from the cookie envelope. Null when absent or not numeric. */
function verifiedTokenExpiryMs(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

interface Log {
  action: "submit" | "generate";
  outcome: SubmitOutcome;
  writeResponse?: "one_row" | "zero_rows" | "rejected" | "error" | "no_response";
  readback?: LatestGoalRead["status"];
  entitlementGate: "none";
  providerCalled: boolean;
  providerMs?: number;
  totalMs: number;
  requestId: string;
}
/** One bounded line per action: codes and timings only (no email, user object, answers, plan, token or provider/DB text). */
function logLine(entry: Log) {
  console.info(`[goal-plan] ${JSON.stringify(entry)}`);
}

type Client = Extract<Awaited<ReturnType<typeof resolveVerifiedAuth>>, { status: "authenticated" }>["client"];
type Verified = { userId: string; client: Client; expMs: number | null };
type IdentityResult = { ok: true; caller: Verified } | { ok: false; outcome: "not_authenticated" | "auth_unavailable" };

async function identity(): Promise<IdentityResult> {
  let auth: Awaited<ReturnType<typeof resolveVerifiedAuth>>;
  try {
    auth = await resolveVerifiedAuth();
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return { ok: false, outcome: "auth_unavailable" };
  }
  if (auth.status === "verification_unavailable") return { ok: false, outcome: "auth_unavailable" };
  if (auth.status !== "authenticated") return { ok: false, outcome: "not_authenticated" };
  return { ok: true, caller: { userId: auth.userId, client: auth.client, expMs: verifiedTokenExpiryMs(auth.accessToken) } };
}

/** Runs a bounded read through the accepted classifier and also keeps the row id it was answered with. */
async function classifiedRead(run: () => PromiseLike<GoalReadResponse>): Promise<{ read: LatestGoalRead; id: string | null }> {
  let id: string | null = null;
  const read = await readLatestGoal(async () => {
    const response = await run();
    const rows = (response as { data?: unknown }).data;
    if (Array.isArray(rows) && rows.length === 1) {
      const candidate = (rows[0] as { id?: unknown } | null)?.id;
      if (typeof candidate === "string" && UUID.test(candidate)) id = candidate;
    }
    return response;
  });
  return { read, id };
}

const refusal = (outcome: GenerationOutcome, message: string): GenerationResult => ({ outcome, message, display: "keep", plan: null, observed: false });

// ── generation steps 6–10 for a known goal row ────────────────────────────────────────────────────────

async function generateForRow(
  caller: Verified,
  goalId: string,
  answers: GoalAnswers,
  t0: number,
  log: Log,
): Promise<GenerationResult> {
  // 6. fresh pre-dispatch time decision (a bounded-time assumption, not a guarantee)
  const decisionAt = now();
  const needed = PROVIDER_TIMEOUT_MS + POST_CALL_MS;
  const tokenLeft = caller.expMs === null ? -Infinity : caller.expMs - decisionAt - SKEW_MS;
  const budgetLeft = t0 + FUNCTION_BUDGET_MS - decisionAt;
  if (tokenLeft < needed) return refusal("time_insufficient", PLAN_COPY.time_session);
  if (budgetLeft < needed) return refusal("time_insufficient", PLAN_COPY.time_budget);

  // 7. one provider call, no retries
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return refusal("provider_not_configured", PLAN_COPY.provider_not_configured);
  let openai: OpenAI;
  try {
    // logLevel "warn" overrides OPENAI_LOG, so a debug setting can never log request bodies (the golfer's answers)
    openai = new OpenAI({ apiKey, maxRetries: 0, timeout: PROVIDER_TIMEOUT_MS, logLevel: "warn" });
  } catch {
    return refusal("provider_not_configured", PLAN_COPY.provider_not_configured);
  }
  const failed = refusal("provider_failed", PLAN_COPY.provider_failed);
  let raw: unknown;
  log.providerCalled = true;
  const callStart = now();
  try {
    const completion = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: buildMessages(answers),
        max_completion_tokens: OUTPUT_TOKEN_CAP,
        response_format: { type: "json_schema", json_schema: { name: "golf_lesson_plan", strict: true, schema: SYLLABUS_SCHEMA } },
      },
      // the SDK's own timeout stops once headers arrive; this signal also bounds reading the body
      { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) },
    );
    log.providerMs = now() - callStart;
    const choice = completion?.choices?.[0];
    const content = choice?.message?.content;
    if (!choice || choice.finish_reason !== "stop" || typeof content !== "string") return failed;
    raw = JSON.parse(content);
  } catch {
    // nothing in this try calls a Next API, so no error here is control flow (the SDK copies `code` from the
    // provider's error body; rethrowing on it would let an endpoint skip the log line and surface its text)
    log.providerMs = now() - callStart;
    return failed;
  }
  const generated = toGoalPlan(raw);
  if (!generated) return failed;

  // 8. the one write: only ai_syllabus, filtered by the known row and the verified owner; its response is logged only
  try {
    const response = await caller.client.from("user_goals").update({ ai_syllabus: raw }).eq("id", goalId).eq("user_id", caller.userId).select("id")
      .abortSignal(AbortSignal.timeout(DB_STEP_TIMEOUT_MS));
    const status = (response as { status?: unknown }).status;
    const code = (response.error as { code?: unknown } | null)?.code;
    log.writeResponse = !response.error
      ? (Array.isArray(response.data) && response.data.length === 1 ? "one_row" : "zero_rows")
      : typeof status === "number" && status >= 400 && status < 500 && typeof code === "string" && code.length > 0
        ? "rejected"
        : status === 0 ? "no_response" : "error";
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    log.writeResponse = "no_response";
  }

  // 9. the content readback, once, whatever the write said
  const { read } = await classifiedRead(() =>
    caller.client.from("user_goals").select(GOAL_PLAN_COLUMNS).eq("id", goalId).eq("user_id", caller.userId).limit(1).retry(false)
      .abortSignal(AbortSignal.timeout(DB_STEP_TIMEOUT_MS)),
  );
  log.readback = read.status;

  // 10. the outcome follows the observation
  const observed = (outcome: GenerationOutcome, message: string | null, display: PlanDisplayState, plan: GoalPlan | null): GenerationResult =>
    ({ outcome, message, display, plan, observed: true });
  if (read.status === "plan" && JSON.stringify(read.plan) === JSON.stringify(generated)) {
    return observed("saved", PLAN_COPY.saved, "stored_plan", read.plan);
  }
  // A write with no definite answer (aborted, dropped, or a non-4xx error) may still commit after the readback, so a
  // readback that does not show the new plan proves nothing yet: the last verified plan stays, nothing is offered as
  // "saved now", and the golfer is pointed at a fresh read. A row that is gone stays goal_missing (an update cannot
  // bring it back).
  const writeDefinite = log.writeResponse === "one_row" || log.writeResponse === "zero_rows" || log.writeResponse === "rejected";
  if (!writeDefinite && read.status !== "none") return observed("save_unconfirmed", PLAN_COPY.save_unconfirmed, "keep", null);
  switch (read.status) {
    case "plan":
      return observed("other_plan_stored", PLAN_COPY.other_plan_stored, "stored_plan", read.plan);
    case "goal":
      return observed("no_plan_stored", PLAN_COPY.no_plan_stored, "no_plan", null);
    case "unreadable":
      return observed("stored_plan_unreadable", PLAN_COPY.stored_plan_unreadable, "unreadable", null);
    case "none":
      return observed("goal_missing", PLAN_COPY.goal_missing, "goal_missing", null);
    default:
      return observed("save_unconfirmed", PLAN_COPY.save_unconfirmed, "keep", null);
  }
}

// ── public entry points (called only by the two Server Actions) ───────────────────────────────────────

/** Generate or regenerate the plan for the golfer's latest goal. */
export async function generateGoalPlan(): Promise<GenerationResult> {
  const t0 = now();
  const log: Log = { action: "generate", outcome: "not_authenticated", entitlementGate: "none", providerCalled: false, totalMs: 0, requestId: crypto.randomUUID() };
  const finish = (result: GenerationResult) => {
    log.outcome = result.outcome;
    log.totalMs = now() - t0;
    logLine(log);
    return result;
  };

  const who = await identity();
  if (!who.ok) return finish(refusal(who.outcome, PLAN_COPY[who.outcome]));
  const { caller } = who;
  // 3. membership: OD-1 = no new gate (owner, offline candidate) — nothing is read

  // 4. the latest goal, scoped to the verified owner before its id is known
  const { read, id } = await classifiedRead(() =>
    caller.client.from("user_goals").select(GOAL_PLAN_COLUMNS).eq("user_id", caller.userId).order("created_at", { ascending: false }).limit(1).retry(false)
      .abortSignal(AbortSignal.timeout(DB_STEP_TIMEOUT_MS)),
  );
  if (read.status === "none") return finish(refusal("no_goal", PLAN_COPY.no_goal));
  if (read.status === "unavailable" || id === null) return finish(refusal("goal_unavailable", PLAN_COPY.goal_unavailable));

  // 5. the stored answers must be within the bounds
  const checked = checkAnswers(read.context.handicap_baseline, read.context.primary_miss, read.context.target_goal);
  if (!checked.ok) return finish(refusal("invalid_input", PLAN_COPY.invalid_stored));

  return finish(await generateForRow(caller, id, checked.answers, t0, log));
}

/** Save the three answers for the verified golfer, then generate a plan for that new goal row. */
export async function submitGoalAnswers(formData: FormData): Promise<SubmitResult> {
  const t0 = now();
  const log: Log = { action: "submit", outcome: "not_authenticated", entitlementGate: "none", providerCalled: false, totalMs: 0, requestId: crypto.randomUUID() };
  const finish = (result: SubmitResult) => {
    log.outcome = result.outcome;
    log.totalMs = now() - t0;
    logLine(log);
    return result;
  };
  const notSaved = (outcome: SubmitOutcome, message: string): SubmitResult => ({ outcome, message, display: "keep", plan: null, observed: false, goalSaved: false });

  const who = await identity();
  if (!who.ok) return finish(notSaved(who.outcome, PLAN_COPY[who.outcome]));
  const { caller } = who;

  const checked = parseSubmittedAnswers(formData);
  if (!checked.ok) return finish(notSaved("invalid_input", checked.message));

  // the insert: exactly user_id (verified) and the three answers
  let goalId: string | null = null;
  try {
    const response = await caller.client
      .from("user_goals")
      .insert({ user_id: caller.userId, ...checked.answers })
      .select("id")
      .abortSignal(AbortSignal.timeout(DB_STEP_TIMEOUT_MS));
    const rows = response.data;
    if (!response.error && Array.isArray(rows) && rows.length === 1 && typeof rows[0]?.id === "string" && UUID.test(rows[0].id)) {
      goalId = rows[0].id;
    } else {
      const status = (response as { status?: unknown }).status;
      const code = (response.error as { code?: unknown } | null)?.code;
      const rejected = typeof status === "number" && status >= 400 && status < 500 && typeof code === "string" && code.length > 0;
      return finish(rejected ? notSaved("goal_save_failed", PLAN_COPY.goal_save_failed) : notSaved("goal_save_unconfirmed", PLAN_COPY.goal_save_unconfirmed));
    }
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return finish(notSaved("goal_save_unconfirmed", PLAN_COPY.goal_save_unconfirmed));
  }

  // membership: OD-1 = no new gate — saving goals and attempting generation stay open to verified golfers
  const result = await generateForRow(caller, goalId, checked.answers, t0, log);
  // the form shows the message next to "Your answers were saved." with no plan on screen
  const message = result.outcome === "provider_failed" ? PLAN_COPY.submit_provider_failed
    : result.outcome === "other_plan_stored" ? PLAN_COPY.submit_other_plan_stored
    : result.message;
  return finish({ ...result, message, goalSaved: true });
}
