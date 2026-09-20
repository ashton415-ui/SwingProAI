import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { resolveRequestId, v1AuthErrorResponse, v1Error, v1Success } from "@/lib/api/v1-response";
import { toBagDto, type BagRow } from "@/lib/api/v1-equipment-dto";

/**
 * GET /api/v1/bag
 *
 * The verified caller's own active clubs.
 *
 * There is no request body, no query parameter and no path parameter. The rows
 * returned are decided solely by the identity Supabase Auth verified, so there
 * is no input through which a caller could ask for somebody else's bag.
 *
 * Read-only: this slice exports no POST, PATCH, PUT or DELETE. Adding a club is
 * not retry-safe today — `user_equipment` carries no uniqueness over
 * (user_id, equipment_model_id) and accepts no client-supplied id, so a retried
 * create would silently produce a duplicate club. That needs an idempotency
 * design, which is deliberately not invented here.
 */

/**
 * The exact projection. Written out rather than `*` so that a column added to
 * `user_equipment` later cannot appear in this response without someone editing
 * this line. `user_id`, `is_archived`, `custom_notes` and `updated_at` are
 * deliberately absent — the caller already knows who they are, the archive flag
 * is implied by the filter below, and the other two have no native consumer.
 */
const BAG_COLUMNS =
  "id, club_type, club_designation, brand, model, custom_club, custom_brand, custom_model, shaft_flex, shaft_weight, loft_deg, is_primary, created_at";

const BAG_UNAVAILABLE_MESSAGE = "The bag could not be loaded.";

export async function GET(): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return (
        v1AuthErrorResponse(auth, requestId) ??
        v1Error("INTERNAL_ERROR", BAG_UNAVAILABLE_MESSAGE, requestId, 500)
      );
    }

    // RLS is the ownership authority here: the `Users manage own equipment`
    // policy resolves `auth.uid() = user_id` against the verified token carried
    // by this caller-scoped client. The `user_id` filter below restates that in
    // application code — defence in depth and query narrowing, not the security
    // boundary. It filters on `user_id`, never on `id`: `id` is the club's own
    // primary key, and matching it against a user id would return nothing and
    // quietly present every golfer with an empty bag.
    //
    // Archived clubs are excluded here rather than by policy, because the policy
    // deliberately lets an owner see their own archived rows. Active-only is an
    // application contract, so the application states it.
    const { data, error } = await auth.client
      .from("user_equipment")
      .select(BAG_COLUMNS)
      .eq("user_id", auth.userId)
      .eq("is_archived", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (error) {
      // The Supabase error is neither returned nor logged: it can carry table,
      // column and constraint detail.
      return v1Error("INTERNAL_ERROR", BAG_UNAVAILABLE_MESSAGE, requestId, 500);
    }

    const rows = (data ?? []) as BagRow[];
    const bag = toBagDto(rows);
    if (bag === null) {
      return v1Error("INTERNAL_ERROR", BAG_UNAVAILABLE_MESSAGE, requestId, 500);
    }

    return v1Success(bag, requestId);
  } catch {
    return v1Error("INTERNAL_ERROR", BAG_UNAVAILABLE_MESSAGE, requestId, 500);
  }
}
