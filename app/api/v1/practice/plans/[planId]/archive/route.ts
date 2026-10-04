import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPracticeIntelligenceEnabled } from "@/lib/feature-flags";
import { requirePracticeAccess } from "@/lib/practice-entitlement-authority";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
} from "@/lib/api/v1-response";
import { PLAN_COLUMNS, parsePathId, toPlanDto } from "@/lib/api/v1-practice-dto";

/**
 * POST /api/v1/practice/plans/{planId}/archive
 *
 * Archives one of the caller's own active plans. Idempotent: archiving an
 * archived plan answers 200 with the plan as it is.
 *
 * The plan is found on the caller's client, so another golfer's plan answers
 * 404. The write is one guarded statement on the elevated client, bound to
 * the verified identity and to `status = 'active'`, so it can only ever move a
 * plan the caller owns from active to archived.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice plans are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const NOT_FOUND_MESSAGE = "The practice plan could not be found.";

export async function POST(
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
  const notFound = () => v1Error("PRACTICE_PLAN_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const refused = await requirePracticeAccess(auth, requestId);
    if (refused) return refused;

    const planId = parsePathId(params?.planId);
    if (planId === null) {
      return notFound();
    }

    const readOwn = () =>
      auth.client
        .from("practice_plans")
        .select(PLAN_COLUMNS)
        .eq("id", planId)
        .eq("user_id", auth.userId)
        .maybeSingle();

    const current = await readOwn();
    if (current.error) {
      return unavailable();
    }
    if (!current.data) {
      return notFound();
    }
    if (current.data.status === "archived") {
      const dto = toPlanDto(current.data);
      return dto === null ? internal() : v1Success({ plan: dto }, requestId);
    }

    let updated;
    try {
      const admin = createAdminClient();
      const now = new Date().toISOString();
      updated = await admin
        .from("practice_plans")
        .update({ status: "archived", archived_at: now, updated_at: now })
        .eq("id", planId)
        .eq("user_id", auth.userId)
        .eq("status", "active")
        .select(PLAN_COLUMNS);
    } catch {
      return unavailable();
    }
    if (updated.error || !Array.isArray(updated.data)) {
      return unavailable();
    }
    if (updated.data.length === 1) {
      const dto = toPlanDto(updated.data[0]);
      return dto === null ? internal() : v1Success({ plan: dto }, requestId);
    }
    if (updated.data.length > 1) {
      return internal();
    }

    // Nothing matched: a concurrent archive won. One re-read decides.
    const after = await readOwn();
    if (after.error) {
      return unavailable();
    }
    if (!after.data) {
      return notFound();
    }
    const dto = toPlanDto(after.data);
    return dto === null || dto.status !== "archived" ? internal() : v1Success({ plan: dto }, requestId);
  } catch {
    return internal();
  }
}
