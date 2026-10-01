import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPracticeIntelligenceEnabled } from "@/lib/feature-flags";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
  v1ValidationError,
} from "@/lib/api/v1-response";
import {
  IDEMPOTENT_REPLAY_HEADER,
  PG_FOREIGN_KEY_VIOLATION,
  RESULT_COLUMNS,
  parseIdempotencyKey,
  parsePathId,
  parseResultRecordOutcome,
  parseResultRecordRequest,
  readJsonBody,
  requestFingerprint,
  toResultDto,
} from "@/lib/api/v1-practice-dto";

/**
 * POST /api/v1/practice/sessions/{sessionId}/results
 *
 * Records one user-entered result in the caller's own in-progress session.
 *
 * Every rule is enforced inside `pi_record_practice_result`, called on the
 * server-only elevated client with the verified identity: the session must be
 * the caller's and in progress (and is locked while the result is written),
 * plan_id is taken from the session and never from the request, a named plan
 * item must belong to that plan and name the same drill, and the drill must
 * exist. Anything refused writes nothing. Results are immutable once written.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice results are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const SESSION_NOT_FOUND_MESSAGE = "The practice session could not be found.";
const SESSION_NOT_ACTIVE_MESSAGE = "The practice session is not in progress.";
const DRILL_NOT_FOUND_MESSAGE = "The drill could not be found.";
const IDEMPOTENCY_CONFLICT_MESSAGE = "This Idempotency-Key was already used for a different request.";

export async function POST(
  request: Request,
  { params }: { params: { sessionId: string } },
): Promise<Response> {
  const requestId = resolveRequestId(await headers());
  if (!isPracticeIntelligenceEnabled()) {
    return v1Error("FEATURE_UNAVAILABLE", FEATURE_UNAVAILABLE_MESSAGE, requestId, 404);
  }

  const unavailable = () =>
    v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
  const internal = () => v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
  const sessionNotFound = () =>
    v1Error("PRACTICE_SESSION_NOT_FOUND", SESSION_NOT_FOUND_MESSAGE, requestId, 404);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const sessionId = parsePathId(params?.sessionId);
    if (sessionId === null) {
      return sessionNotFound();
    }

    const idempotencyKey = parseIdempotencyKey(request.headers);
    if (idempotencyKey === null) {
      return v1ValidationError(requestId);
    }

    const body = parseResultRecordRequest(await readJsonBody(request, false));
    if (body === null) {
      return v1ValidationError(requestId);
    }

    const fingerprint = requestFingerprint("practice.result.record", { sessionId }, body);

    let rpc;
    try {
      const admin = createAdminClient();
      rpc = await admin.rpc("pi_record_practice_result", {
        p_user_id: auth.userId,
        p_session_id: sessionId,
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: fingerprint,
        p_plan_item_id: body.planItemId,
        p_drill_id: body.drillId,
        p_attempts: body.attempts,
        p_successes: body.successes,
        p_self_rating: body.selfRating,
        p_note: body.note,
      });
    } catch {
      return unavailable();
    }

    if (rpc.error) {
      if ((rpc.error as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION) {
        return v1Error("DRILL_NOT_FOUND", DRILL_NOT_FOUND_MESSAGE, requestId, 409);
      }
      return unavailable();
    }

    const outcome = parseResultRecordOutcome(rpc.data);
    if (outcome === null) {
      return internal();
    }
    switch (outcome.outcome) {
      case "idempotency_conflict":
        return v1Error("IDEMPOTENCY_CONFLICT", IDEMPOTENCY_CONFLICT_MESSAGE, requestId, 409);
      case "session_not_found":
        return sessionNotFound();
      case "session_not_active":
        return v1Error("PRACTICE_SESSION_NOT_ACTIVE", SESSION_NOT_ACTIVE_MESSAGE, requestId, 409);
      case "drill_not_found":
        return v1Error("DRILL_NOT_FOUND", DRILL_NOT_FOUND_MESSAGE, requestId, 409);
      case "plan_item_invalid":
        return v1ValidationError(requestId);
    }

    const result = await auth.client
      .from("practice_session_results")
      .select(RESULT_COLUMNS)
      .eq("id", outcome.resultId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (result.error) {
      return unavailable();
    }
    const dto = toResultDto(result.data);
    if (dto === null) {
      return internal();
    }

    const replayed = outcome.outcome === "replayed";
    return v1Success({ result: dto }, requestId, {
      status: replayed ? 200 : 201,
      headers: replayed ? { [IDEMPOTENT_REPLAY_HEADER]: "true" } : undefined,
    });
  } catch {
    return internal();
  }
}
