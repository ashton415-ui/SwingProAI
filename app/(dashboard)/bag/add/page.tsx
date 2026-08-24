import { redirect } from "next/navigation";
import { createClient, getServerSession } from "@/utils/supabase/server";
import {
  queryCanonicalEquipmentCatalog,
  type CanonicalCatalogResult,
  type CatalogSupabaseClient,
} from "@/lib/equipment/catalog";
import AddClubForm, { type CatalogOption, type CatalogState } from "./AddClubForm";

export const metadata = { title: "Add Club — SwingProAI" };

/**
 * Reduce the canonical catalog result to the minimum the browser needs.
 *
 * Two things are load-bearing here:
 *
 * 1. Only five identity fields per model cross to the client. Specifications,
 *    putter fitting metadata, provenance and catalog bookkeeping stay on the
 *    server — the selector needs none of them.
 *
 * 2. A failed query never becomes an empty catalog, and its message/code never
 *    leave this function. `unavailable` deliberately carries no payload, so
 *    there is no route by which raw PostgREST or SQL text could be rendered.
 */
function toCatalogState(result: CanonicalCatalogResult): CatalogState {
  switch (result.status) {
    case "ok": {
      const options: CatalogOption[] = result.entries.map((entry) => ({
        clubType: entry.club_type,
        manufacturerId: entry.manufacturer.id,
        manufacturerName: entry.manufacturer.canonical_name,
        modelId: entry.id,
        modelName: entry.canonical_name,
      }));
      return { status: "ready", options };
    }

    // `missing_coverage` cannot arise from the full-catalog call below, which
    // passes no club type. It is handled for exhaustiveness, not by inventing
    // a second per-club-type query.
    case "empty":
    case "missing_coverage":
      return { status: "empty" };

    case "auth_error":
    case "database_error":
    case "malformed_data":
      // Status classification only — never the message, code, hint or detail.
      console.error("Canonical equipment catalog unavailable:", result.status);
      return { status: "unavailable" };
  }
}

export default async function AddClubPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Authenticated server client: RLS grants `authenticated` SELECT on active
  // catalog rows, so no service-role client is involved.
  const supabase = await createClient();

  // The reader's CatalogSupabaseClient types from() as already carrying eq()
  // and being thenable; a real Supabase client only gains those after select().
  // The chain the reader actually builds — from().select().eq().eq() — is valid
  // on the real client, so this is a loose declared type rather than a runtime
  // mismatch. lib/equipment/catalog.ts is out of scope for this slice, so the
  // gap is absorbed here at the single call site. (The reader's own test double
  // needs the same cast, which is worth tightening in a later reader-scoped
  // change.)
  const catalogClient = supabase as unknown as CatalogSupabaseClient;
  const catalog = toCatalogState(await queryCanonicalEquipmentCatalog(catalogClient));

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Add Club</h1>
          <p className="text-sm text-gray-400 mt-1">
            Add a club to your virtual bag to track per-club telemetry.
          </p>
        </div>
        <AddClubForm userId={session.user.id} catalog={catalog} />
      </div>
    </div>
  );
}
