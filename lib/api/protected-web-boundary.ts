import { headers } from "next/headers";
import { resolveRequestId, v1AuthErrorResponse, V1_CACHE_CONTROL } from "@/lib/api/v1-response";
import { protectedWebRequestsEnabled } from "@/lib/protected-web-requests";

/**
 * AG-WEB-READY-10-P4: the server-enforced boundary of the protected browser path (lib/protected-web-requests.ts).
 *
 * On that path the browser sends this origin's cookies, because a platform sign-in admits a request only with its own
 * cookie. The golfer's Supabase session cookie may then travel too, and it is not identity here:
 *
 *   - The existing handlers resolve identity through utils/supabase/server.ts resolveRouteAuth. A presented
 *     Authorization header selects Bearer mode: a well-formed, Auth-valid Bearer is authoritative and the cookie is not
 *     read; a malformed, invalid or expired one is refused, never replaced by the cookie; an Auth outage is a 503. Only
 *     when no Authorization header exists at all does it read the session cookie.
 *   - So the one thing a web endpoint must add is this: a request without an Authorization header is refused here,
 *     before the handler runs, whatever cookie it carries. Then the cookie can never become the identity of a web
 *     request, and the owner and every downstream read and write come from the verified Bearer, as they already do on
 *     the native path. Nothing else about the request is changed or re-parsed: the verifier stays the single judge of
 *     the credential (its bytes are pinned by lib/api-v1-upload.test.ts), and each handler keeps its own validation,
 *     ownership checks and answers.
 *
 * The rule is enforced by the endpoint itself, not by anything the client sends: a request that drops its
 * Authorization header — a client that never set it, or anything between that removed it — is refused, and no marker
 * the client could omit decides that.
 *
 * Off by default. Without the build's opt-in the web endpoints answer 404 and run nothing, so a default deployment's
 * surface is unchanged. The decision is the build's (next.config.mjs inlines it into this bundle too), so setting the
 * variable on a running default build does not open these endpoints.
 */

/** How the reused handler answers an unauthenticated caller, so the refusal looks exactly like its own. */
export type RefusalShape = "v1" | "analyze-swing";

function disabled(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": V1_CACHE_CONTROL } });
}

/** The handler's own answer for a caller with no credential. */
function credentialRequired(shape: RefusalShape, requestId: string): Response {
  if (shape === "analyze-swing") {
    // app/api/analyze-swing/route.ts answers an unauthenticated caller exactly this way
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return v1AuthErrorResponse({ status: "absent" }, requestId) as Response;
}

/**
 * Runs `handler` for `request` only when the request carries an Authorization header; otherwise answers as the handler
 * does for an absent credential. The header's contents are judged by the handler's own verifier, which never falls back
 * to the cookie once a header is present.
 */
export async function requireBearerHeader<R extends Request>(
  request: R,
  handler: (request: R) => Promise<Response>,
  shape: RefusalShape,
): Promise<Response> {
  if (!protectedWebRequestsEnabled()) return disabled();
  // the same request context the verifier reads (next/headers), so both see exactly the same Authorization header
  const headerList = await headers();
  if (headerList.get("authorization") === null) return credentialRequired(shape, resolveRequestId(headerList));
  return handler(request);
}
