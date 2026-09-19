import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { resolveRequestId, v1AuthErrorResponse, v1Error, v1Success } from "@/lib/api/v1-response";
import { toMeResponse, type MeProfileRow } from "@/lib/api/me-dto";

/**
 * GET /api/v1/me
 *
 * The verified caller's own profile and entitlement state. This is the first
 * endpoint a native client calls after sign-in, and the only thing it is
 * allowed to be is a read of the caller's own row.
 *
 * Identity comes from `resolveRouteAuth()` — cookie for the web app,
 * `Authorization: Bearer` for native clients, never both, never a fallback from
 * one to the other. Nothing here parses a token, reads a cookie or re-verifies
 * anything; doing so would create a second identity authority that could
 * disagree with the first.
 *
 * There is no request body, no query parameter and no path parameter. The row
 * that is read is decided solely by the identity Supabase Auth returned, so
 * there is no input through which a caller could ask for somebody else.
 */

/**
 * The exact projection. Written out rather than `*` so that a column added to
 * `public.users` later — a billing field, a coach field, a token of any kind —
 * cannot appear in this response without someone editing this line.
 *
 * `email` is not selected: the response reports the address Supabase Auth
 * verified, not the nullable copy the signup trigger wrote.
 */
const PROFILE_COLUMNS =
  "id, full_name, display_name, avatar_url, handicap_index, typical_shot_shape, prominent_miss, average_driver_carry, role, subscription_tier, subscription_status, created_at";

const PROFILE_UNAVAILABLE_MESSAGE = "The profile could not be loaded.";

export async function GET(): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  const auth = await resolveRouteAuth();
  if (auth.status !== "authenticated") {
    // The helper answers for all three failure states; the fallback exists only
    // so a state added to the resolver later fails closed instead of falling
    // through to the read below.
    return (
      v1AuthErrorResponse(auth, requestId) ??
      v1Error("INTERNAL_ERROR", PROFILE_UNAVAILABLE_MESSAGE, requestId, 500)
    );
  }

  // The caller-scoped client carries the verified access token, so PostgREST
  // runs this as `authenticated` and the `auth.uid() = id` policy is enforced
  // by the database. The `.eq` below is the application saying the same thing
  // the policy already says — belt and braces, not the security boundary. No
  // elevated client exists on this path.
  const { data, error } = await auth.client
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", auth.userId)
    .maybeSingle();

  const profile = data as MeProfileRow | null;

  // A verified user with no profile row is an invariant violation, not an
  // account state: `handle_new_user` inserts the row in the same transaction
  // that creates the auth user. So this is 500, and deliberately not a 404 or
  // an "incomplete account" code that would invite clients to build a recovery
  // flow for a situation the product does not have. The Supabase error itself
  // is neither returned nor logged — it can carry row and query detail.
  if (error || !profile) {
    return v1Error("INTERNAL_ERROR", PROFILE_UNAVAILABLE_MESSAGE, requestId, 500);
  }

  return v1Success(toMeResponse({ userId: auth.userId, email: auth.email }, profile), requestId);
}
