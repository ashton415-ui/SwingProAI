import type { VerifiedAuth } from "@/utils/supabase/server";

/**
 * SwingProAI — V1 API response foundation.
 *
 * The smallest shared surface the native clients need: one success envelope,
 * one error envelope, a bounded request identifier, and the mapping from the
 * verified-auth resolver's outcome to an HTTP answer.
 *
 * This module deliberately contains no middleware, no logging framework, no
 * validation framework, no rate limiter and no idempotency helper. Each of
 * those is a real requirement with its own design, and inventing a skeleton for
 * them here would freeze decisions that have not been made.
 *
 * Responses are built from the Web `Response` global rather than
 * `NextResponse`. Route handlers accept either, and staying on the standard
 * type keeps this module free of a Next runtime import — which is what lets the
 * contract tests execute it directly instead of behind a route-handler harness.
 */

/**
 * The error vocabulary V1 currently answers with.
 *
 * Only codes with a live call site are listed. Adding a member later is a
 * backwards-compatible change for clients that treat an unrecognised code as a
 * generic failure of its HTTP status, which is the documented expectation.
 */
export type V1ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "SERVER_TEMPORARILY_UNAVAILABLE"
  | "INTERNAL_ERROR";

/** Every V1 response carries private, uncacheable semantics. See `v1Headers`. */
export const V1_CACHE_CONTROL = "private, no-store";

/** Request identifiers accepted from the caller. Bounded on purpose — see below. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * The part of a headers object this module needs.
 *
 * Structural rather than nominal so the same function accepts Next's
 * `ReadonlyHeaders`, a standard `Headers`, and a plain stub in a test.
 */
export interface V1HeaderReader {
  get(name: string): string | null;
}

/**
 * Correlates one request across client, server and support.
 *
 * A caller-supplied value is honoured so a native client can tie its own
 * telemetry to a server answer, but only within a fixed alphabet and length.
 * The value ends up in a response header and, later, in logs: unbounded caller
 * text there is how header splitting and log forging start. Anything that does
 * not match exactly is discarded rather than sanitised, because a repaired
 * identifier would no longer be the one the client recorded.
 */
export function resolveRequestId(headers: V1HeaderReader): string {
  const incoming = headers.get("x-request-id");
  if (incoming !== null && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

function v1Headers(requestId: string, base?: HeadersInit): Headers {
  const headers = new Headers(base);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", V1_CACHE_CONTROL);
  headers.set("X-Request-Id", requestId);
  return headers;
}

/**
 * A successful V1 answer: `{ "data": ... }` and nothing else at the top level.
 *
 * The envelope exists so that adding a sibling key later (pagination, say) does
 * not have to collide with a field name the payload already uses.
 */
export function v1Success<T>(data: T, requestId: string, init?: ResponseInit): Response {
  return new Response(JSON.stringify({ data }), {
    ...init,
    status: init?.status ?? 200,
    headers: v1Headers(requestId, init?.headers),
  });
}

/**
 * A failed V1 answer.
 *
 * `message` is always a fixed literal chosen by the call site. Supabase error
 * text, database error text, JWT claims, token or cookie material and stack
 * traces never reach this function, so they cannot reach a client: an error
 * body is read by whoever presented the credential, including whoever presented
 * a bad one.
 */
export function v1Error(
  code: V1ErrorCode,
  message: string,
  requestId: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: v1Headers(requestId),
  });
}

/**
 * Fixed, non-sensitive messages. Each says what the caller can act on and
 * nothing about why the server reached that conclusion.
 */
const AUTH_REQUIRED_MESSAGE = "Authentication is required.";
const AUTH_INVALID_MESSAGE = "The supplied credential is not valid.";
const AUTH_UNAVAILABLE_MESSAGE = "Authentication is temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";

/**
 * Turns a resolver outcome into the response it deserves, or `null` when the
 * caller is authenticated and the route should continue.
 *
 * `absent` and `invalid` are both 401 but keep distinct codes: only one of them
 * describes a credential that was presented and rejected, and a native client
 * needs that difference to decide between "sign in" and "your session ended".
 *
 * `verification_unavailable` is 503, never 401. Supabase Auth being
 * unreachable is not a statement about the golfer's credential, and answering
 * 401 would tell every signed-in client to discard a session that is still
 * perfectly good.
 *
 * This function re-verifies nothing and parses nothing. `utils/supabase/server`
 * is the sole identity authority; this only renders its verdict.
 */
export function v1AuthErrorResponse(auth: VerifiedAuth, requestId: string): Response | null {
  switch (auth.status) {
    case "authenticated":
      return null;
    case "absent":
      return v1Error("AUTH_REQUIRED", AUTH_REQUIRED_MESSAGE, requestId, 401);
    case "invalid":
      return v1Error("AUTH_INVALID", AUTH_INVALID_MESSAGE, requestId, 401);
    case "verification_unavailable":
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", AUTH_UNAVAILABLE_MESSAGE, requestId, 503);
  }

  // Unreachable while `VerifiedAuth` holds the four states above. It is kept so
  // that a state added later fails closed with an error response rather than
  // returning `null` and being read as "authenticated, continue".
  return v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);
}
