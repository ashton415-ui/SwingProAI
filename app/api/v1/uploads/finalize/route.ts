import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
  v1ValidationError,
} from "@/lib/api/v1-response";
import {
  FINALIZE_ROW_COLUMNS,
  PG_UNIQUE_VIOLATION,
  UPLOAD_BUCKET,
  UPLOAD_FINALIZED_STATUS,
  buildUploadFinalizeDto,
  buildUploadObjectPath,
  isCanonicalFinalizedRow,
  parseUploadFinalizeRequest,
  validateStoredUploadMetadata,
} from "@/lib/api/v1-upload-dto";

/**
 * POST /api/v1/uploads/finalize
 *
 * Turns a completed direct-to-Storage upload into exactly one canonical
 * `swing_videos` row. This is the boundary where a set of bytes becomes a
 * resource, and nothing else.
 *
 * The caller supplies only an upload id and a content type. Everything that
 * decides what gets registered — the owner, the bucket, the object path, the
 * byte count, the stored content type — is derived server-side or read from
 * Storage. The legacy finalization route accepted `storagePath`, `fileSize`
 * and `mimeType` from the client and persisted them unchecked; a caller could
 * register a row describing an object it had never uploaded. That is the
 * specific mistake this route exists not to repeat.
 *
 * Storage is the size and type authority. A declared `fileSize` is not accepted
 * at all: at authorization time a declared size is the only one that exists, but
 * here the bytes are already stored, so asking the client would be choosing the
 * less reliable of two available answers.
 *
 * Idempotency rests on the upload id being the row's primary key. The same
 * upload id, from the same verified caller, for the same object, is the same
 * resource — so a client that loses a response can safely retry, and a repeat
 * returns the same 200 as the original.
 *
 * This slice creates no analysis. No `swing_analysis` row, no tier lookup, no
 * analysis mode, no priority, no equipment. `analysis_mode` and `priority` carry
 * database defaults precisely so finalization need not know anything about
 * entitlement; API-E owns that decision and owns it alone.
 *
 * One rule outranks every failure path below: a database problem never deletes
 * the uploaded object. The golfer's upload succeeded, and that object is what
 * makes a retry possible.
 */

const FINALIZE_UNAVAILABLE_MESSAGE = "Finalization is temporarily unavailable. Please retry.";
const NOT_READY_MESSAGE = "The upload could not be found or is not ready.";
const METADATA_INVALID_MESSAGE = "The uploaded file is not valid.";
const CONFLICT_MESSAGE = "This upload has already been finalized differently.";
const INTERNAL_MESSAGE = "The request could not be completed.";

/** HTTP status Storage returns for an object that is not there. */
const STORAGE_NOT_FOUND_STATUS = 404;

/**
 * Hosted Supabase Storage can report a missing object as HTTP 400 while the
 * service-level 404 travels in the error body, which storage-js surfaces as the
 * typed string `statusCode`. Accepted only together with that exact 400.
 */
const STORAGE_WRAPPED_NOT_FOUND_STATUS = 400;
const STORAGE_NOT_FOUND_STATUS_CODE = "404";

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  try {
    // Authentication resolves before the body is read. An unauthenticated
    // caller learns only that it is unauthenticated — never which fields this
    // endpoint validates, and never whether a given upload id exists.
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return (
        v1AuthErrorResponse(auth, requestId) ??
        v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500)
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return v1ValidationError(requestId);
    }

    const parsed = parseUploadFinalizeRequest(rawBody);
    if (parsed === null) {
      return v1ValidationError(requestId);
    }

    // The same builder D1 used to mint the capability. One canonical path
    // implementation means the object this route verifies is necessarily the
    // object that route authorized — a second builder could drift from the
    // first and leave finalization looking in the wrong place.
    const objectPath = buildUploadObjectPath(auth.userId, parsed.uploadId, parsed.mimeType);

    // Exact-path lookup on the caller-scoped client, so the Storage
    // owner-folder policy applies to this read. No listing, no search, no
    // guessing: the path is already known, and a folder scan would let a
    // failure to find one object turn into a look at others.
    let info;
    try {
      info = await auth.client.storage.from(UPLOAD_BUCKET).info(objectPath);
    } catch {
      // A throw here is transport or client failure, never evidence about the
      // object. Reporting "not found" would tell the caller to stop retrying a
      // finalization that may well succeed in a moment.
      return v1Error(
        "SERVER_TEMPORARILY_UNAVAILABLE",
        FINALIZE_UNAVAILABLE_MESSAGE,
        requestId,
        503,
      );
    }

    if (info.error) {
      // Classified on the typed status fields only. The provider message can
      // carry the object path and bucket internals, and matching on its prose
      // would also break silently the first time that prose is reworded.
      //
      // Missing means a direct HTTP 404, or the hosted shape of an HTTP 400
      // carrying a service-level "404". Any other 400 is not evidence of
      // absence and stays an outage. Storage also answers "not found" when a
      // policy hides the object, so this means "not found or not visible",
      // which the deliberately non-disclosing public message already allows for.
      const { status, statusCode } = info.error as { status?: unknown; statusCode?: unknown };
      const missing =
        status === STORAGE_NOT_FOUND_STATUS ||
        (status === STORAGE_WRAPPED_NOT_FOUND_STATUS &&
          statusCode === STORAGE_NOT_FOUND_STATUS_CODE);
      if (missing) {
        return v1Error("UPLOAD_NOT_FOUND_OR_NOT_READY", NOT_READY_MESSAGE, requestId, 409);
      }
      // Authorization, configuration and unknown Storage failures are outages,
      // not absences, and must not be disguised as "not ready".
      return v1Error(
        "SERVER_TEMPORARILY_UNAVAILABLE",
        FINALIZE_UNAVAILABLE_MESSAGE,
        requestId,
        503,
      );
    }

    // A success envelope with no object, or one lacking the object's own
    // identity, is not proof of a completed upload. Fail closed rather than
    // registering a row against something that may not have materialised.
    const stored = info.data;
    if (!stored || typeof stored.id !== "string" || stored.id.length === 0) {
      return v1Error("UPLOAD_NOT_FOUND_OR_NOT_READY", NOT_READY_MESSAGE, requestId, 409);
    }

    const metadata = validateStoredUploadMetadata(
      { size: stored.size, contentType: stored.contentType },
      parsed.mimeType,
    );
    if (metadata === null) {
      return v1Error("UPLOAD_METADATA_INVALID", METADATA_INVALID_MESSAGE, requestId, 409);
    }

    const expected = {
      uploadId: parsed.uploadId,
      userId: auth.userId,
      objectPath,
      fileSize: metadata.size,
      contentType: metadata.contentType,
    };

    // Owner-scoped lookup. RLS already restricts this to the caller's own rows;
    // the explicit `user_id` filter says the same thing the policy says, which
    // is belt and braces rather than the security boundary.
    const existing = await auth.client
      .from("swing_videos")
      .select(FINALIZE_ROW_COLUMNS)
      .eq("id", parsed.uploadId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (existing.error) {
      return v1Error(
        "SERVER_TEMPORARILY_UNAVAILABLE",
        FINALIZE_UNAVAILABLE_MESSAGE,
        requestId,
        503,
      );
    }

    if (existing.data) {
      // A repeat is success only if the stored row describes this exact upload.
      // Anything else is a different upload wearing the same identifier, and
      // D2 reports that rather than quietly reshaping the row to agree.
      if (!isCanonicalFinalizedRow(existing.data, expected)) {
        return v1Error("UPLOAD_CONFLICT", CONFLICT_MESSAGE, requestId, 409);
      }
      return v1Success(
        buildUploadFinalizeDto({
          uploadId: parsed.uploadId,
          objectPath,
          fileSize: metadata.size,
          contentType: metadata.contentType,
          created: false,
        }),
        requestId,
      );
    }

    // Exactly seven columns. Everything omitted — created_at, trim_start,
    // analysis_mode, launch_monitor_attached, priority — carries a database
    // default, which is what keeps entitlement routing out of this route
    // entirely rather than merely unused.
    const inserted = await auth.client.from("swing_videos").insert({
      id: parsed.uploadId,
      user_id: auth.userId,
      storage_path: objectPath,
      video_url: objectPath,
      file_size: metadata.size,
      mime_type: metadata.contentType,
      status: UPLOAD_FINALIZED_STATUS,
    });

    if (!inserted.error) {
      return v1Success(
        buildUploadFinalizeDto({
          uploadId: parsed.uploadId,
          objectPath,
          fileSize: metadata.size,
          contentType: metadata.contentType,
          created: true,
        }),
        requestId,
      );
    }

    // Anything other than a unique violation is an infrastructure failure. The
    // uploaded object is deliberately left untouched: it is the golfer's
    // successful upload and the anchor a retry depends on. Deleting it here —
    // as the legacy route does — would turn a transient database problem into
    // permanent data loss.
    if ((inserted.error as { code?: unknown }).code !== PG_UNIQUE_VIOLATION) {
      return v1Error(
        "SERVER_TEMPORARILY_UNAVAILABLE",
        FINALIZE_UNAVAILABLE_MESSAGE,
        requestId,
        503,
      );
    }

    // A unique violation means the primary key is taken. Either a concurrent
    // finalization by this caller won, or the id belongs to someone else.
    // Exactly one owner-scoped re-read distinguishes them; no retry loop.
    const afterConflict = await auth.client
      .from("swing_videos")
      .select(FINALIZE_ROW_COLUMNS)
      .eq("id", parsed.uploadId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (afterConflict.error) {
      return v1Error(
        "SERVER_TEMPORARILY_UNAVAILABLE",
        FINALIZE_UNAVAILABLE_MESSAGE,
        requestId,
        503,
      );
    }

    if (afterConflict.data && isCanonicalFinalizedRow(afterConflict.data, expected)) {
      // The concurrent winner produced the row this request would have. Both
      // callers get the same answer; only one reports having created it.
      return v1Success(
        buildUploadFinalizeDto({
          uploadId: parsed.uploadId,
          objectPath,
          fileSize: metadata.size,
          contentType: metadata.contentType,
          created: false,
        }),
        requestId,
      );
    }

    // No visible own row means the id is held by another golfer, since RLS
    // hides it. The answer is identical to a mismatched own row on purpose:
    // distinguishing them would confirm that a stranger's upload exists, and
    // turn this endpoint into a way to probe for other people's identifiers.
    return v1Error("UPLOAD_CONFLICT", CONFLICT_MESSAGE, requestId, 409);
  } catch {
    return v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
  }
}
