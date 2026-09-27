import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { canUsePuttingAnalysis } from "@/lib/entitlements";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
  v1ValidationError,
} from "@/lib/api/v1-response";
import { UPLOAD_BUCKET } from "@/lib/api/v1-upload-dto";
import { isV1ClubType } from "@/lib/api/v1-equipment-dto";
import {
  ANALYSIS_REQUEST_COLUMNS,
  CLUB_VALIDATION_COLUMNS,
  PG_RAISE_EXCEPTION,
  PG_UNIQUE_VIOLATION,
  PUTTER_CLUB_TYPE,
  VIDEO_READINESS_COLUMNS,
  VIDEO_READY_STATUS,
  isOwnerStoragePath,
  isSameClub,
  parseAnalysisCreateRequest,
  toAnalysisRequestDto,
  toSubscriptionTier,
  type AnalysisRequestRow,
} from "@/lib/api/v1-analysis-dto";

/**
 * POST /api/v1/analyses
 *
 * The one doorway through which an analysis request comes into existence, for
 * the web app and native clients alike. It creates exactly one pending
 * `swing_analysis` row for a finalized video, and nothing else: no Gemini call,
 * no result, no mode.
 *
 * Every decision is made before anything is written, and every one of them is
 * made on the caller's own client, so RLS and the Storage owner-folder policy
 * are the authority for what the caller may see:
 *
 *   1. authenticate;
 *   2. validate the exact body;
 *   3. find the caller's own video;
 *   4. prove it is ready — `uploaded`, in the caller's folder, and the object
 *      actually exists in Storage;
 *   5. validate the club, if one was named;
 *   6. apply the putting entitlement, if the club is a Putter;
 *   7. answer an existing request idempotently.
 *
 * Only then does the trusted server writer perform a single INSERT. Clients
 * hold no INSERT privilege on `swing_analysis`, so this route cannot be
 * bypassed by writing the table directly. The elevated client is used for that
 * one statement alone; it never reads, never authorizes, and never touches
 * Storage.
 *
 * `status` is left to its database default, and `analysis_family` and
 * `equipment_snapshot` are written by the database trigger from the owned club.
 * `analysis_mode` is not written: the mode is an execution decision and belongs
 * to the tier at the time analysis runs.
 *
 * `getSwingLimitForTier` is deliberately not enforced here. The web flow does
 * not enforce it, and doing so only on this path would create a commercial rule
 * that exists for one client and not the other.
 */

const UNAVAILABLE_MESSAGE = "Analysis requests are temporarily unavailable. Please retry.";
const VIDEO_NOT_FOUND_MESSAGE = "The swing video could not be found.";
const VIDEO_NOT_READY_MESSAGE = "The swing video is not ready for analysis.";
const CLUB_INVALID_MESSAGE = "The selected club is not available.";
const ENTITLEMENT_MESSAGE = "Putting analysis isn't included with your current plan.";
const CONFLICT_MESSAGE = "An analysis already exists for this swing with a different club.";
const INTERNAL_MESSAGE = "The request could not be completed.";

/** HTTP status Storage returns for an object that is not there. */
const STORAGE_NOT_FOUND_STATUS = 404;

/**
 * Hosted Storage can report a missing object as HTTP 400 carrying a
 * service-level "404". Accepted only together with that exact 400 — the same
 * classification finalization uses.
 */
const STORAGE_WRAPPED_NOT_FOUND_STATUS = 400;
const STORAGE_NOT_FOUND_STATUS_CODE = "404";

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  const unavailable = () =>
    v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
  const internal = () => v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);

  try {
    // 1. Authentication resolves before the body is read, so an unauthenticated
    // caller learns nothing about what this endpoint validates.
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    // 2. The exact body.
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return v1ValidationError(requestId);
    }

    const parsed = parseAnalysisCreateRequest(rawBody);
    if (parsed === null) {
      return v1ValidationError(requestId);
    }

    // 3. The caller's own video. RLS scopes this read; the explicit `user_id`
    // filter restates the policy. A video owned by someone else is hidden by
    // RLS and so answers exactly like one that does not exist.
    const video = await auth.client
      .from("swing_videos")
      .select(VIDEO_READINESS_COLUMNS)
      .eq("id", parsed.swingVideoId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (video.error) {
      return unavailable();
    }
    if (!video.data) {
      return v1Error("SWING_VIDEO_NOT_FOUND", VIDEO_NOT_FOUND_MESSAGE, requestId, 404);
    }

    // 4. Readiness. `status` and `storage_path` cannot change after the row is
    // created, but `status` is still stated by whoever created it, so the
    // object's existence is proved as well rather than taken on its word.
    const storagePath: unknown = video.data.storage_path;
    if (video.data.status !== VIDEO_READY_STATUS || !isOwnerStoragePath(storagePath, auth.userId)) {
      return v1Error("SWING_VIDEO_NOT_READY", VIDEO_NOT_READY_MESSAGE, requestId, 409);
    }

    // Exact-path lookup on the caller's own client, so the Storage owner-folder
    // policy decides what is visible. Never the elevated client.
    let info;
    try {
      info = await auth.client.storage.from(UPLOAD_BUCKET).info(storagePath);
    } catch {
      return unavailable();
    }

    if (info.error) {
      // Classified on the typed status fields only; the provider message is
      // never read, returned or logged.
      const { status, statusCode } = info.error as { status?: unknown; statusCode?: unknown };
      const missing =
        status === STORAGE_NOT_FOUND_STATUS ||
        (status === STORAGE_WRAPPED_NOT_FOUND_STATUS &&
          statusCode === STORAGE_NOT_FOUND_STATUS_CODE);
      if (missing) {
        return v1Error("SWING_VIDEO_NOT_READY", VIDEO_NOT_READY_MESSAGE, requestId, 409);
      }
      return unavailable();
    }

    const stored = info.data;
    if (!stored || typeof stored.id !== "string" || stored.id.length === 0) {
      return v1Error("SWING_VIDEO_NOT_READY", VIDEO_NOT_READY_MESSAGE, requestId, 409);
    }

    // 5. The club, if one was named: the caller's own, active, and of a club
    // type the API recognises. A club that fails any of these is refused in the
    // same words, so the answer does not say which.
    let isPutter = false;
    if (parsed.clubId !== null) {
      const club = await auth.client
        .from("user_equipment")
        .select(CLUB_VALIDATION_COLUMNS)
        .eq("id", parsed.clubId)
        .eq("user_id", auth.userId)
        .maybeSingle();

      if (club.error) {
        return unavailable();
      }
      if (!club.data || club.data.is_archived !== false || !isV1ClubType(club.data.club_type)) {
        return v1Error("CLUB_INVALID", CLUB_INVALID_MESSAGE, requestId, 409);
      }
      isPutter = club.data.club_type === PUTTER_CLUB_TYPE;
    }

    // 6. Putting is a paid capability, decided from the caller's own profile.
    // An unknown or missing tier fails closed; it is never defaulted.
    if (isPutter) {
      const profile = await auth.client
        .from("users")
        .select("subscription_tier")
        .eq("id", auth.userId)
        .maybeSingle();

      if (profile.error) {
        return unavailable();
      }
      const tier = toSubscriptionTier(profile.data?.subscription_tier);
      if (tier === null) {
        return internal();
      }
      if (!canUsePuttingAnalysis(tier)) {
        return v1Error("ENTITLEMENT_REQUIRED", ENTITLEMENT_MESSAGE, requestId, 403);
      }
    }

    // 7. One analysis per video. A repeat for the same club is the same
    // request; a different club is a different request and is refused.
    const existing = await auth.client
      .from("swing_analysis")
      .select(ANALYSIS_REQUEST_COLUMNS)
      .eq("swing_video_id", parsed.swingVideoId)
      .eq("user_id", auth.userId)
      .limit(2);

    if (existing.error || !Array.isArray(existing.data)) {
      return unavailable();
    }
    if (existing.data.length > 1) {
      // More than one row for a video predates the uniqueness this contract
      // relies on. Answering for either would be picking a winner.
      return internal();
    }
    if (existing.data.length === 1) {
      return answerExisting(existing.data[0] as AnalysisRequestRow, parsed.clubId, requestId);
    }

    // 8. The single trusted write. Exactly four columns; `user_id` is the
    // verified identity and nothing from the request body.
    let inserted;
    try {
      const admin = createAdminClient();
      inserted = await admin
        .from("swing_analysis")
        .insert({
          id: parsed.swingVideoId,
          swing_video_id: parsed.swingVideoId,
          user_id: auth.userId,
          club_id: parsed.clubId,
        })
        .select(ANALYSIS_REQUEST_COLUMNS)
        .single();
    } catch {
      // A missing server configuration throws on construction. That is an
      // outage, never a success.
      return unavailable();
    }

    if (!inserted.error) {
      const dto = toAnalysisRequestDto(inserted.data as AnalysisRequestRow, true);
      return dto === null ? internal() : v1Success(dto, requestId, { status: 201 });
    }

    const code = (inserted.error as { code?: unknown }).code;
    if (code === PG_RAISE_EXCEPTION) {
      // The equipment trigger refused the club — archived or reassigned between
      // the check above and this write.
      return v1Error("CLUB_INVALID", CLUB_INVALID_MESSAGE, requestId, 409);
    }
    if (code !== PG_UNIQUE_VIOLATION) {
      return unavailable();
    }

    // A concurrent request won. Exactly one owner-scoped re-read decides the
    // answer; there is no retry loop.
    const afterConflict = await auth.client
      .from("swing_analysis")
      .select(ANALYSIS_REQUEST_COLUMNS)
      .eq("swing_video_id", parsed.swingVideoId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (afterConflict.error) {
      return unavailable();
    }
    if (!afterConflict.data) {
      return internal();
    }
    return answerExisting(afterConflict.data as AnalysisRequestRow, parsed.clubId, requestId);
  } catch {
    return internal();
  }
}

/** The idempotent answer for a video that already has an analysis. */
function answerExisting(
  row: AnalysisRequestRow & { club_id?: unknown },
  requestedClubId: string | null,
  requestId: string,
): Response {
  if (!isSameClub(row.club_id, requestedClubId)) {
    return v1Error("ANALYSIS_CONFLICT", CONFLICT_MESSAGE, requestId, 409);
  }
  const dto = toAnalysisRequestDto(row, false);
  return dto === null
    ? v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500)
    : v1Success(dto, requestId);
}
