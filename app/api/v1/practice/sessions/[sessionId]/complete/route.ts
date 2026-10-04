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
  v1ValidationError,
} from "@/lib/api/v1-response";
import {
  SESSION_COLUMNS,
  parsePathId,
  parseSessionCompleteRequest,
  readJsonBody,
  toSessionDto,
  type SessionOutcome,
} from "@/lib/api/v1-practice-dto";

/**
 * POST /api/v1/practice/sessions/{sessionId}/complete   { "outcome": "completed" | "abandoned" }
 *
 * Ends one of the caller's own in-progress sessions. Repeating the same
 * outcome answers 200 with the session as it is; asking for a different
 * outcome once the session has ended is PRACTICE_SESSION_NOT_ACTIVE.
 *
 * The session is found on the caller's client. The write is one guarded
 * statement on the elevated client, bound to the verified identity and to
 * `status = 'in_progress'`. ended_at is never earlier than started_at, even if
 * this server's clock trails the database's.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice sessions are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const NOT_FOUND_MESSAGE = "The practice session could not be found.";
const NOT_ACTIVE_MESSAGE = "The practice session is not in progress.";

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
  const notFound = () => v1Error("PRACTICE_SESSION_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const refused = await requirePracticeAccess(auth, requestId);
    if (refused) return refused;

    const sessionId = parsePathId(params?.sessionId);
    if (sessionId === null) {
      return notFound();
    }

    const body = parseSessionCompleteRequest(await readJsonBody(request, false));
    if (body === null) {
      return v1ValidationError(requestId);
    }

    const readOwn = () =>
      auth.client
        .from("practice_sessions")
        .select(SESSION_COLUMNS)
        .eq("id", sessionId)
        .eq("user_id", auth.userId)
        .maybeSingle();

    /** The answer for a session that has already ended. */
    const answerEnded = (row: unknown, requested: SessionOutcome): Response => {
      const dto = toSessionDto(row);
      if (dto === null || dto.status === "in_progress") return internal();
      if (dto.status !== requested) {
        return v1Error("PRACTICE_SESSION_NOT_ACTIVE", NOT_ACTIVE_MESSAGE, requestId, 409);
      }
      return v1Success({ session: dto }, requestId);
    };

    const current = await readOwn();
    if (current.error) {
      return unavailable();
    }
    if (!current.data) {
      return notFound();
    }
    if (current.data.status !== "in_progress") {
      return answerEnded(current.data, body.outcome);
    }

    const startedMs = Date.parse(String(current.data.started_at));
    if (!Number.isFinite(startedMs)) {
      return internal();
    }
    const endedAt = new Date(Math.max(Date.now(), startedMs)).toISOString();

    let updated;
    try {
      const admin = createAdminClient();
      updated = await admin
        .from("practice_sessions")
        .update({ status: body.outcome, ended_at: endedAt })
        .eq("id", sessionId)
        .eq("user_id", auth.userId)
        .eq("status", "in_progress")
        .select(SESSION_COLUMNS);
    } catch {
      return unavailable();
    }
    if (updated.error || !Array.isArray(updated.data)) {
      return unavailable();
    }
    if (updated.data.length === 1) {
      const dto = toSessionDto(updated.data[0]);
      return dto === null ? internal() : v1Success({ session: dto }, requestId);
    }
    if (updated.data.length > 1) {
      return internal();
    }

    // Nothing matched: a concurrent request ended it first. One re-read decides.
    const after = await readOwn();
    if (after.error) {
      return unavailable();
    }
    if (!after.data) {
      return notFound();
    }
    return answerEnded(after.data, body.outcome);
  } catch {
    return internal();
  }
}
