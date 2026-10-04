import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { isPracticeIntelligenceEnabled } from "@/lib/feature-flags";
import { requirePracticeAccess } from "@/lib/practice-entitlement-authority";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
} from "@/lib/api/v1-response";
import {
  PLAN_COLUMNS,
  PLAN_ITEM_COLUMNS,
  PROGRESS_RESULT_COLUMNS,
  mapAll,
  parsePathId,
  readAllPages,
  toPlanDto,
  toPlanItemDto,
} from "@/lib/api/v1-practice-dto";
import { derivePlanProgress, type ProgressResult } from "@/lib/practice-progress";

/**
 * GET /api/v1/practice/plans/{planId}
 *
 * One of the caller's own plans, its items, and per-item progress derived from
 * results in completed sessions. Every read is on the caller's client; a plan
 * that belongs to someone else is invisible under RLS and answers exactly like
 * one that does not exist.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice plans are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const NOT_FOUND_MESSAGE = "The practice plan could not be found.";

export async function GET(
  _request: Request,
  { params }: { params: { planId: string } },
): Promise<Response> {
  const requestId = resolveRequestId(await headers());
  if (!isPracticeIntelligenceEnabled()) {
    return v1Error("FEATURE_UNAVAILABLE", FEATURE_UNAVAILABLE_MESSAGE, requestId, 404);
  }

  const unavailable = () =>
    v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
  const internal = () => v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const refused = await requirePracticeAccess(auth, requestId);
    if (refused) return refused;

    // A malformed id cannot name a plan the caller owns.
    const planId = parsePathId(params?.planId);
    if (planId === null) {
      return v1Error("PRACTICE_PLAN_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);
    }

    const plan = await auth.client
      .from("practice_plans")
      .select(PLAN_COLUMNS)
      .eq("id", planId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (plan.error) {
      return unavailable();
    }
    if (!plan.data) {
      return v1Error("PRACTICE_PLAN_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);
    }

    const items = await auth.client
      .from("practice_plan_items")
      .select(PLAN_ITEM_COLUMNS)
      .eq("plan_id", planId)
      .eq("user_id", auth.userId)
      .order("position", { ascending: true });
    if (items.error) {
      return unavailable();
    }

    const completedSessions = await readAllPages((from, to) =>
      auth.client
        .from("practice_sessions")
        .select("id, status")
        .eq("plan_id", planId)
        .eq("user_id", auth.userId)
        .eq("status", "completed")
        .order("id", { ascending: true })
        .range(from, to),
    );
    const results = await readAllPages((from, to) =>
      auth.client
        .from("practice_session_results")
        .select(PROGRESS_RESULT_COLUMNS)
        .eq("plan_id", planId)
        .eq("user_id", auth.userId)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (completedSessions === null || results === null) {
      // Progress is never answered from a partial set.
      return unavailable();
    }

    const planDto = toPlanDto(plan.data);
    const itemDtos = mapAll(items.data, toPlanItemDto);
    const sessionRows = mapAll(completedSessions, toProgressSession);
    const resultRows = mapAll(results, toProgressResult);
    if (planDto === null || itemDtos === null || sessionRows === null || resultRows === null) {
      return internal();
    }

    const progress = derivePlanProgress(
      itemDtos.map((item) => ({ id: item.id, drillId: item.drillId })),
      sessionRows,
      resultRows,
    );

    return v1Success({ plan: { ...planDto, items: itemDtos, progress } }, requestId);
  } catch {
    return internal();
  }
}

function toProgressSession(row: unknown): { id: string; status: string } | null {
  if (typeof row !== "object" || row === null) return null;
  const { id, status } = row as Record<string, unknown>;
  return typeof id === "string" && typeof status === "string" ? { id, status } : null;
}

function toProgressResult(row: unknown): ProgressResult | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const nullableInt = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v));
  if (typeof r.session_id !== "string" || typeof r.recorded_at !== "string") return null;
  if (!(r.plan_item_id === null || typeof r.plan_item_id === "string")) return null;
  if (!nullableInt(r.attempts) || !nullableInt(r.successes)) return null;
  return {
    sessionId: r.session_id,
    planItemId: r.plan_item_id as string | null,
    attempts: r.attempts as number | null,
    successes: r.successes as number | null,
    recordedAt: r.recorded_at,
  };
}
