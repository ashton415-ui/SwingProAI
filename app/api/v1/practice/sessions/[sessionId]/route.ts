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
  RESULT_COLUMNS,
  SESSION_COLUMNS,
  mapAll,
  parsePathId,
  readAllPages,
  toResultDto,
  toSessionDto,
} from "@/lib/api/v1-practice-dto";

/**
 * GET /api/v1/practice/sessions/{sessionId}
 *
 * One of the caller's own sessions and every result recorded in it, read on
 * the caller's client. Another golfer's session is invisible under RLS and
 * answers exactly like one that does not exist.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice sessions are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const NOT_FOUND_MESSAGE = "The practice session could not be found.";

export async function GET(
  _request: Request,
  { params }: { params: { sessionId: string } },
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

    const sessionId = parsePathId(params?.sessionId);
    if (sessionId === null) {
      return v1Error("PRACTICE_SESSION_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);
    }

    const session = await auth.client
      .from("practice_sessions")
      .select(SESSION_COLUMNS)
      .eq("id", sessionId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (session.error) {
      return unavailable();
    }
    if (!session.data) {
      return v1Error("PRACTICE_SESSION_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);
    }

    const results = await readAllPages((from, to) =>
      auth.client
        .from("practice_session_results")
        .select(RESULT_COLUMNS)
        .eq("session_id", sessionId)
        .eq("user_id", auth.userId)
        .order("recorded_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (results === null) {
      return unavailable();
    }

    const sessionDto = toSessionDto(session.data);
    const resultDtos = mapAll(results, toResultDto);
    if (sessionDto === null || resultDtos === null) {
      return internal();
    }
    return v1Success({ session: { ...sessionDto, results: resultDtos } }, requestId);
  } catch {
    return internal();
  }
}
