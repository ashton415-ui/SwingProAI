/**
 * SwingProAI — Practice Intelligence (PI-0) plan progress.
 *
 * Pure derivation over rows already read on the golfer's own client. Nothing
 * here reads or writes the database, and nothing it computes is stored.
 *
 * Evidence standard: every input is a user-entered result, and the output
 * says only what those entries add up to. It reports counts and sums, never a
 * percentage, score or judgement, and it keeps "nothing was recorded" (null)
 * distinct from "zero was recorded" (0).
 *
 * Only results from COMPLETED sessions count. An in-progress session may still
 * change, and an abandoned session is one the golfer chose not to stand behind.
 */

export interface ProgressPlanItem {
  id: string;
  drillId: string;
}

export interface ProgressSession {
  id: string;
  status: string;
}

export interface ProgressResult {
  sessionId: string;
  planItemId: string | null;
  attempts: number | null;
  successes: number | null;
  recordedAt: string;
}

export interface PlanItemProgress {
  planItemId: string;
  drillId: string;
  /** Distinct completed sessions with at least one result for this item. */
  completedSessionCount: number;
  /** Sum of recorded attempts, or null when no result recorded any. */
  totalAttempts: number | null;
  /** Sum of recorded successes, or null when no result recorded any. */
  totalSuccesses: number | null;
  /** The latest recordedAt among counted results, or null when there are none. */
  lastPracticedAt: string | null;
}

const COMPLETED = "completed";

/**
 * Progress for each plan item, in the order the items were given.
 *
 * Results that belong to no listed item, or to a session that is not listed
 * as completed, are ignored rather than guessed about.
 */
export function derivePlanProgress(
  items: readonly ProgressPlanItem[],
  sessions: readonly ProgressSession[],
  results: readonly ProgressResult[],
): PlanItemProgress[] {
  const completed = new Set(sessions.filter((s) => s.status === COMPLETED).map((s) => s.id));

  return items.map((item) => {
    const sessionIds = new Set<string>();
    let totalAttempts: number | null = null;
    let totalSuccesses: number | null = null;
    let lastPracticedAt: string | null = null;
    let lastPracticedMs = Number.NEGATIVE_INFINITY;

    for (const result of results) {
      if (result.planItemId !== item.id || !completed.has(result.sessionId)) continue;

      sessionIds.add(result.sessionId);
      if (result.attempts !== null) totalAttempts = (totalAttempts ?? 0) + result.attempts;
      if (result.successes !== null) totalSuccesses = (totalSuccesses ?? 0) + result.successes;

      // Compared as instants, not strings: timestamps from the database may
      // differ in offset notation or fractional precision.
      const ms = Date.parse(result.recordedAt);
      if (Number.isFinite(ms) && ms > lastPracticedMs) {
        lastPracticedMs = ms;
        lastPracticedAt = result.recordedAt;
      }
    }

    return {
      planItemId: item.id,
      drillId: item.drillId,
      completedSessionCount: sessionIds.size,
      totalAttempts,
      totalSuccesses,
      lastPracticedAt,
    };
  });
}
