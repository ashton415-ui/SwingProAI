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
  UPLOAD_BUCKET,
  buildResumableEndpoint,
  buildUploadAuthorizationDto,
  buildUploadObjectPath,
  parseUploadAuthorizeRequest,
} from "@/lib/api/v1-upload-dto";

/**
 * POST /api/v1/uploads/authorize
 *
 * Mints a bounded, path-scoped capability for one swing video, which the
 * Native client then uploads directly to private Supabase Storage over TUS.
 *
 * No video bytes pass through this route, or through Next.js at all. That is
 * the whole point of the design: a route that buffers a quarter-gigabyte video
 * in a serverless function is the failure mode this endpoint exists to avoid.
 *
 * The caller cannot choose where its bytes land. The object key is built from
 * the verified user id, a validated UUID and a content type from a closed set;
 * no filename and no path are accepted. The Storage owner-folder policy then
 * enforces the same ownership independently, so the route's derivation and the
 * database's check would both have to be wrong for a caller to reach another
 * golfer's folder.
 *
 * This slice writes nothing. No `swing_videos` row, no `swing_analysis` row, no
 * analysis, no equipment context — a capability is not a resource, and the
 * record of an upload belongs to finalization once an object actually exists.
 */

const UPLOAD_UNAVAILABLE_MESSAGE = "Upload authorization is temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  try {
    // Authentication is resolved before the body is read. An unauthenticated
    // caller learns only that it is unauthenticated — never which fields this
    // endpoint validates or how.
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

    const parsed = parseUploadAuthorizeRequest(rawBody);
    if (parsed === null) {
      return v1ValidationError(requestId);
    }

    // Derived from configuration, never hard-coded: staging and local
    // environments must address their own project. A malformed value fails
    // closed rather than returning a half-built URL or echoing configuration.
    const endpoint = buildResumableEndpoint(process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (endpoint === null) {
      return v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
    }

    const objectPath = buildUploadObjectPath(auth.userId, parsed.uploadId, parsed.mimeType);

    // The caller-scoped client carries the verified access token, so Storage
    // applies the owner-folder INSERT policy to this signing request. No
    // elevated client exists on this path.
    //
    // `upsert: false` is explicit. The bucket has no UPDATE policy, so an
    // overwrite could not succeed anyway, but stating it keeps the intent
    // legible and means a retry re-signs the same immutable key rather than
    // silently replacing bytes.
    const { data, error } = await auth.client.storage
      .from(UPLOAD_BUCKET)
      .createSignedUploadUrl(objectPath, { upsert: false });

    if (error || !data?.token) {
      // The provider error is discarded rather than logged or returned: it can
      // carry the object path, bucket internals and request detail.
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UPLOAD_UNAVAILABLE_MESSAGE, requestId, 503);
    }

    return v1Success(
      buildUploadAuthorizationDto({
        uploadId: parsed.uploadId,
        objectPath,
        endpoint,
        signature: data.token,
        contentType: parsed.mimeType,
      }),
      requestId,
    );
  } catch {
    return v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
  }
}
