import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { resolveRequestId, v1AuthErrorResponse, v1Error, v1Success } from "@/lib/api/v1-response";
import {
  queryCanonicalEquipmentCatalog,
  type CatalogSupabaseClient,
} from "@/lib/equipment/catalog";
import { toEquipmentCatalogDto } from "@/lib/api/v1-equipment-dto";

/**
 * GET /api/v1/equipment/catalog
 *
 * The canonical equipment catalog, for authenticated callers only.
 *
 * Authentication is required even though the rows are not personal data: the
 * catalog tables grant SELECT to `authenticated` and nothing to `anon`, so this
 * endpoint matches the live database boundary rather than widening it. There is
 * no tier gate — no entitlement helper governs equipment today, and inventing
 * one at the API edge would create a rule the product does not have.
 *
 * The query itself is delegated to `queryCanonicalEquipmentCatalog`, the single
 * canonical reader. It already owns active-model filtering, active-manufacturer
 * filtering via an `!inner` embed, and a deterministic total ordering. Writing a
 * second query here would create a rival source of truth that could silently
 * drift from the one the web surfaces use.
 *
 * No query parameters, no pagination, no filtering: the live catalog is small
 * and wholly active, so the complete payload is bounded. Nothing is read from
 * the request but its headers, so there is no input to validate and no way to
 * ask for anything other than the whole active catalog.
 */

const CATALOG_UNAVAILABLE_MESSAGE = "The equipment catalog could not be loaded.";

export async function GET(): Promise<Response> {
  const requestId = resolveRequestId(await headers());

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      // The helper answers all three failure states; the fallback exists only so
      // a state added to the resolver later fails closed rather than falling
      // through to the read below.
      return (
        v1AuthErrorResponse(auth, requestId) ??
        v1Error("INTERNAL_ERROR", CATALOG_UNAVAILABLE_MESSAGE, requestId, 500)
      );
    }

    // The caller-scoped client carries the verified access token, so PostgREST
    // runs as `authenticated` and the active-only policies apply. The cast is
    // the structural narrowing the reader's own injected-client contract
    // expects; no elevated client exists on this path.
    const result = await queryCanonicalEquipmentCatalog(
      auth.client as unknown as CatalogSupabaseClient,
    );

    // `ok` and `empty` are both successful answers about a healthy catalog.
    //
    // Every other state is a server-side problem the caller can do nothing
    // about, so all of them collapse to one opaque 500. `auth_error` is
    // included deliberately: the caller's credential was already verified above,
    // so a permission refusal here is an RLS or grant misconfiguration, and
    // answering 401 would tell a correctly signed-in client to discard a session
    // that is perfectly good. `missing_coverage` cannot occur because no club
    // type is requested; if it ever did, the reader's contract would have
    // changed underneath this route, which is a failure, not an empty catalog.
    if (result.status !== "ok" && result.status !== "empty") {
      return v1Error("INTERNAL_ERROR", CATALOG_UNAVAILABLE_MESSAGE, requestId, 500);
    }

    const catalog = toEquipmentCatalogDto(result.entries);
    if (catalog === null) {
      return v1Error("INTERNAL_ERROR", CATALOG_UNAVAILABLE_MESSAGE, requestId, 500);
    }

    return v1Success(catalog, requestId);
  } catch {
    // The thrown value is discarded rather than logged or serialised: it can
    // carry query, row and connection detail.
    return v1Error("INTERNAL_ERROR", CATALOG_UNAVAILABLE_MESSAGE, requestId, 500);
  }
}
