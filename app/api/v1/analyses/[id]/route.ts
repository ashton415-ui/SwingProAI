import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
  v1ValidationError,
} from "@/lib/api/v1-response";
import { isUuid } from "@/lib/api/v1-analysis-dto";
import { toAnalysisResultV1 } from "@/lib/api/v1-analysis-result-dto";
import { readAuthorizedAnalysis } from "@/lib/analysis-result-read-authority";

/**
 * GET /api/v1/analyses/{id}
 *
 * One analysis result, for the web app and native clients alike, as the
 * verified caller may receive it. Identity comes from `resolveRouteAuth()` —
 * cookie or `Authorization: Bearer`, exactly as every other V1 route. The only
 * input is the path id; nothing in the request can name an owner, a tier or a
 * status.
 *
 * Everything else belongs to the unified result-read authority: ownership on
 * the caller's own session, entitlement from the caller's own profile, the
 * payload read on the server bounded by the proved id and owner, and an
 * explicit allow-list per field. This route only maps the authorized view to
 * the V1 shape. Another golfer's analysis and a missing one are the same 404.
 * Every response is private and uncacheable (V1 headers).
 */

const NOT_FOUND_MESSAGE = "The analysis could not be found.";
const UNAVAILABLE_MESSAGE = "Analysis results are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";

export async function GET(
  _request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
    }

    const id = context.params?.id;
    if (!isUuid(id)) {
      return v1ValidationError(requestId);
    }

    const read = await readAuthorizedAnalysis(auth, id);
    if (read.status === "not_found") {
      return v1Error("ANALYSIS_NOT_FOUND", NOT_FOUND_MESSAGE, requestId, 404);
    }
    if (read.status !== "ok") {
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
    }

    return v1Success(toAnalysisResultV1(read.result, read.access), requestId);
  } catch {
    return v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
  }
}
