import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * EQ-CONSUMER-SLICE-1 — /bag/add canonical manufacturer/model selection.
 *
 * These are static source-contract tests, matching the approach every other
 * suite in lib/ uses. The repository has no jsdom, no happy-dom and no Testing
 * Library, so component rendering is not available and installing one is out of
 * scope; asserting on source text is the strongest method available here.
 *
 * The suite deliberately imports nothing from the production modules it
 * governs. Importing the constants under test would let a regression rename
 * itself into compliance — reading the files as text keeps the assertions
 * independent of the code they check.
 */

const repoRoot = path.join(__dirname, "..");

const PAGE_FILE = "app/(dashboard)/bag/add/page.tsx";
const FORM_FILE = "app/(dashboard)/bag/add/AddClubForm.tsx";
const READER_FILE = "lib/equipment/catalog.ts";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/** The Custom / Other payload literal, isolated from the canonical one. */
function isolateCustomPayload(source: string): string {
  const start = source.indexOf("if (form.custom_club) {");
  expect(start, `${FORM_FILE}: could not locate the custom-mode payload branch`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n    } else {", start);
  expect(end, `${FORM_FILE}: could not locate the end of the custom-mode payload branch`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The canonical payload literal, isolated from the Custom / Other one. */
function isolateCanonicalPayload(source: string): string {
  const branch = source.indexOf("if (form.custom_club) {");
  expect(branch, `${FORM_FILE}: could not locate the payload mode branch`).toBeGreaterThanOrEqual(0);
  const start = source.indexOf("\n    } else {", branch);
  expect(start, `${FORM_FILE}: could not locate the canonical payload branch`).toBeGreaterThan(branch);
  const end = source.indexOf("setLoading(true);", start);
  expect(end, `${FORM_FILE}: could not locate the end of the canonical payload branch`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The server-side mapping of catalog rows down to selector identity. */
function isolateOptionMapping(source: string): string {
  const start = source.indexOf("const options: CatalogOption[] = result.entries.map(");
  expect(start, `${PAGE_FILE}: could not locate the sanitizing option map`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('return { status: "ready", options };', start);
  expect(end, `${PAGE_FILE}: could not locate the end of the option map`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ============================================================================
// Server page — canonical query wiring
// ============================================================================

describe("EQC1 /bag/add page — canonical catalog query wiring", () => {
  it("both slice files exist", () => {
    expect(existsSync(path.join(repoRoot, PAGE_FILE)), `missing file: ${PAGE_FILE}`).toBe(true);
    expect(existsSync(path.join(repoRoot, FORM_FILE)), `missing file: ${FORM_FILE}`).toBe(true);
  });

  it("imports the canonical reader from the one canonical query layer", () => {
    const source = readSource(PAGE_FILE);
    expect(source, `${PAGE_FILE}: must import queryCanonicalEquipmentCatalog`).toContain(
      "queryCanonicalEquipmentCatalog"
    );
    expect(source, `${PAGE_FILE}: must import it from @/lib/equipment/catalog`).toContain(
      'from "@/lib/equipment/catalog"'
    );
  });

  it("uses the authenticated server Supabase client, never the service-role admin client", () => {
    const source = readSource(PAGE_FILE);
    expect(source, `${PAGE_FILE}: must create the server client`).toContain("createClient");
    expect(source, `${PAGE_FILE}: must import it from @/utils/supabase/server`).toContain(
      'from "@/utils/supabase/server"'
    );
    expect(source, `${PAGE_FILE}: must never reach for the service-role admin client`).not.toContain(
      "supabase/admin"
    );
    expect(source, `${PAGE_FILE}: must never reference a service-role key`).not.toContain(
      "SERVICE_ROLE"
    );
  });

  it("retains the existing authentication redirect", () => {
    const source = readSource(PAGE_FILE);
    expect(source, `${PAGE_FILE}: getServerSession must be retained`).toContain("getServerSession");
    expect(source, `${PAGE_FILE}: the /login redirect must be retained`).toContain('redirect("/login")');
    expect(source, `${PAGE_FILE}: the session guard must be retained`).toContain("if (!session)");
  });

  it("queries the canonical catalog exactly once, for the full catalog", () => {
    const source = readSource(PAGE_FILE);
    const calls = (source.match(/queryCanonicalEquipmentCatalog\(/g) ?? []).length;
    expect(calls, `${PAGE_FILE}: expected exactly one canonical catalog call site`).toBe(1);
    expect(
      source,
      `${PAGE_FILE}: the single call must pass the authenticated server client`
    ).toContain("queryCanonicalEquipmentCatalog(catalogClient)");
    expect(
      source,
      `${PAGE_FILE}: the queried client must be the authenticated server client, never a fresh or elevated one`
    ).toContain("const catalogClient = supabase as unknown as CatalogSupabaseClient");
    // Scoped to the call expression on purpose: `clubType:` also names a field
    // of the sanitized selector option, so a whole-file check would flag the
    // mapping rather than a narrowed query.
    expect(
      source,
      `${PAGE_FILE}: the canonical query must take no options argument — narrowing by club type would force a second round trip`
    ).not.toMatch(/queryCanonicalEquipmentCatalog\([^)]*,/);
  });

  it("handles every canonical result status without inventing a second query", () => {
    const source = readSource(PAGE_FILE);
    for (const status of [
      '"ok"',
      '"empty"',
      '"missing_coverage"',
      '"auth_error"',
      '"database_error"',
      '"malformed_data"',
    ]) {
      expect(source, `${PAGE_FILE}: result status ${status} must be handled explicitly`).toContain(status);
    }
  });

  it("never reaches for the rotated equipment API routes or any static catalog", () => {
    for (const file of [PAGE_FILE, FORM_FILE]) {
      const source = readSource(file);
      expect(source, `${file}: must not depend on /api/equipment`).not.toContain("/api/equipment");
      expect(source, `${file}: must not fall back to a static CATALOG constant`).not.toContain("CATALOG");
      expect(source, `${file}: must not import the Python-mirrored static catalog`).not.toContain(
        "equipment_catalog"
      );
    }
  });
});

// ============================================================================
// Server page — sanitization boundary
// ============================================================================

describe("EQC1 /bag/add page — sanitized selector contract", () => {
  it("maps catalog rows down to exactly the five selector identity fields", () => {
    const mapping = isolateOptionMapping(readSource(PAGE_FILE));
    for (const field of [
      "clubType:",
      "manufacturerId:",
      "manufacturerName:",
      "modelId:",
      "modelName:",
    ]) {
      expect(mapping, `${PAGE_FILE}: selector option must carry ${field}`).toContain(field);
    }
  });

  it("ships no catalog metadata the selector does not need", () => {
    const mapping = isolateOptionMapping(readSource(PAGE_FILE));
    for (const forbidden of [
      "specifications",
      "putter_specs",
      "equipment_model_sources",
      "catalog_key",
      "normalized_name",
      "model_year",
      "release_year",
      "brand_line",
      "model_family",
      "created_at",
      "updated_at",
    ]) {
      expect(
        mapping,
        `${PAGE_FILE}: "${forbidden}" must not cross to the browser for this selector`
      ).not.toContain(forbidden);
    }
  });

  it("never passes raw database error detail toward the client", () => {
    const source = readSource(PAGE_FILE);
    for (const leak of ["result.message", "result.code", "result.details", "result.hint"]) {
      expect(source, `${PAGE_FILE}: ${leak} must never leave the server`).not.toContain(leak);
    }
  });

  it("collapses every failure status to a payload-free unavailable state", () => {
    const source = readSource(PAGE_FILE);
    expect(source, `${PAGE_FILE}: failures must become an unavailable state`).toContain(
      'return { status: "unavailable" };'
    );
    expect(source, `${PAGE_FILE}: a failure must never be reported as an empty catalog`).not.toContain(
      'case "database_error":\n      return { status: "empty" }'
    );
  });

  it("hands the form the sanitized catalog and the authenticated user id only", () => {
    const source = readSource(PAGE_FILE);
    expect(source, `${PAGE_FILE}: the form must receive the catalog prop`).toContain("catalog={catalog}");
    expect(source, `${PAGE_FILE}: the form must receive the session user id`).toContain(
      "userId={session.user.id}"
    );
  });
});

// ============================================================================
// Form — catalog derivations
// ============================================================================

describe("EQC1 Add Club form — canonical derivations", () => {
  it("declares the sanitized selector types the page consumes", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: must export CatalogOption`).toContain("export type CatalogOption");
    expect(source, `${FORM_FILE}: must export CatalogState`).toContain("export type CatalogState");
    expect(source, `${FORM_FILE}: CatalogState must model the ready case`).toContain('status: "ready"');
    expect(source, `${FORM_FILE}: CatalogState must model the empty case`).toContain('status: "empty"');
    expect(source, `${FORM_FILE}: CatalogState must model the unavailable case`).toContain(
      'status: "unavailable"'
    );
  });

  it("derives options only from the supplied catalog, never from a literal list", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: options must come from the ready catalog`).toContain(
      'catalog.status === "ready" ? catalog.options : []'
    );
    for (const brand of ["TaylorMade", "Callaway", "Titleist", "Mizuno", "Cobra"]) {
      expect(
        source,
        `${FORM_FILE}: "${brand}" must not be hardcoded — manufacturers come from the database`
      ).not.toContain(brand);
    }
  });

  it("filters manufacturer choices by the selected club type", () => {
    const source = readSource(FORM_FILE);
    expect(
      source,
      `${FORM_FILE}: manufacturer derivation must skip options of another club type`
    ).toContain("option.clubType !== form.club_type");
  });

  it("filters model choices by both club type and selected manufacturer", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: model derivation must match the club type`).toContain(
      "option.clubType === form.club_type"
    );
    expect(source, `${FORM_FILE}: model derivation must match the selected manufacturer`).toContain(
      "option.manufacturerId === form.selectedManufacturerId"
    );
  });

  it("resolves the selected entry against all three identity dimensions", () => {
    const source = readSource(FORM_FILE);
    const start = source.indexOf("const selectedEntry");
    expect(start, `${FORM_FILE}: could not locate the selectedEntry derivation`).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 600);
    expect(block, `${FORM_FILE}: selectedEntry must match the model id`).toContain(
      "option.modelId === form.selectedModelId"
    );
    expect(block, `${FORM_FILE}: selectedEntry must match the club type`).toContain(
      "option.clubType === form.club_type"
    );
    expect(block, `${FORM_FILE}: selectedEntry must match the manufacturer`).toContain(
      "option.manufacturerId === form.selectedManufacturerId"
    );
    expect(block, `${FORM_FILE}: an unresolved selection must be null, not undefined`).toContain("?? null");
  });
});

// ============================================================================
// Form — no auto-selection, and cascade resets
// ============================================================================

describe("EQC1 Add Club form — explicit selection and cascade resets", () => {
  it("starts with no manufacturer and no model selected", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: manufacturer must start unselected`).toContain(
      'selectedManufacturerId: ""'
    );
    expect(source, `${FORM_FILE}: model must start unselected`).toContain('selectedModelId: ""');
  });

  it("never auto-selects the first manufacturer or model", () => {
    const source = readSource(FORM_FILE);
    for (const pattern of ["options[0]", "models[0]", "manufacturers[0]", "entries[0]"]) {
      expect(
        source,
        `${FORM_FILE}: "${pattern}" would silently pick equipment the golfer did not choose`
      ).not.toContain(pattern);
    }
  });

  it("clears manufacturer and model when the club type changes", () => {
    const source = readSource(FORM_FILE);
    const start = source.indexOf("club_type: e.target.value as ClubType");
    expect(start, `${FORM_FILE}: could not locate the club type change handler`).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 220);
    expect(block, `${FORM_FILE}: club type change must clear the manufacturer`).toContain(
      'selectedManufacturerId: ""'
    );
    expect(block, `${FORM_FILE}: club type change must clear the model`).toContain('selectedModelId: ""');
  });

  it("clears the model when the manufacturer changes", () => {
    const source = readSource(FORM_FILE);
    expect(
      source,
      `${FORM_FILE}: manufacturer change must clear the model rather than leave a stale one`
    ).toContain('set({ selectedManufacturerId: e.target.value, selectedModelId: "" })');
  });

  it("clears both modes' identity fields when the Custom / Other toggle flips", () => {
    const source = readSource(FORM_FILE);
    const start = source.indexOf("custom_club: e.target.checked");
    expect(start, `${FORM_FILE}: could not locate the Custom / Other change handler`).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, start + 260);
    expect(block, `${FORM_FILE}: mode switch must clear the manufacturer`).toContain(
      'selectedManufacturerId: ""'
    );
    expect(block, `${FORM_FILE}: mode switch must clear the model`).toContain('selectedModelId: ""');
    expect(block, `${FORM_FILE}: mode switch must clear the custom brand`).toContain('custom_brand: ""');
    expect(block, `${FORM_FILE}: mode switch must clear the custom model`).toContain('custom_model: ""');
  });

  it("disables the Model selector until a manufacturer is chosen", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: Model must be unusable before a manufacturer is picked`).toContain(
      'disabled={form.selectedManufacturerId === ""}'
    );
  });

  it("gives both canonical selectors a non-selected leading placeholder", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: manufacturer placeholder missing`).toContain(
      "— Select Manufacturer —"
    );
    expect(source, `${FORM_FILE}: model placeholder missing`).toContain("— Select Model —");
  });
});

// ============================================================================
// Form — insert payloads
// ============================================================================

describe("EQC1 Add Club form — canonical insert payload", () => {
  it("refuses to submit canonical mode without a resolved catalog entry", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(canonical, `${FORM_FILE}: canonical submit must require a resolved entry`).toContain(
      "if (!selectedEntry)"
    );
    expect(canonical, `${FORM_FILE}: an unresolved canonical submit must abort`).toContain("return;");
  });

  it("writes the canonical model id", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(canonical, `${FORM_FILE}: canonical payload must set equipment_model_id`).toContain(
      "equipment_model_id: selectedEntry.modelId"
    );
  });

  it("leaves manufacturer_id null so the database trigger derives it", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(
      canonical,
      `${FORM_FILE}: client state must not author the manufacturer relationship`
    ).toContain("manufacturer_id: null");
    expect(
      canonical,
      `${FORM_FILE}: manufacturer_id must not be taken from client selection state`
    ).not.toContain("manufacturer_id: form.selectedManufacturerId");
    expect(
      canonical,
      `${FORM_FILE}: manufacturer_id must not be taken from the selected entry either`
    ).not.toContain("manufacturer_id: selectedEntry.manufacturerId");
  });

  it("stores a readable canonical brand/model snapshot taken only from the selected entry", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(canonical, `${FORM_FILE}: brand snapshot must come from the selected entry`).toContain(
      "brand: selectedEntry.manufacturerName"
    );
    expect(canonical, `${FORM_FILE}: model snapshot must come from the selected entry`).toContain(
      "model: selectedEntry.modelName"
    );
  });

  it("marks the row as catalog-backed and carries no custom fields", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(canonical, `${FORM_FILE}: canonical payload must set custom_club false`).toContain(
      "custom_club: false"
    );
    expect(canonical, `${FORM_FILE}: canonical payload must clear custom_brand`).toContain(
      "custom_brand: null"
    );
    expect(canonical, `${FORM_FILE}: canonical payload must clear custom_model`).toContain(
      "custom_model: null"
    );
    expect(
      canonical,
      `${FORM_FILE}: a stale custom brand must not leak into a canonical row`
    ).not.toContain("custom_brand: form.custom_brand");
    expect(
      canonical,
      `${FORM_FILE}: a stale custom model must not leak into a canonical row`
    ).not.toContain("custom_model: form.custom_model");
  });

  it("preserves the existing fitting fields unchanged", () => {
    const canonical = isolateCanonicalPayload(readSource(FORM_FILE));
    expect(canonical).toContain("shaft_flex: form.shaft_flex || null");
    expect(canonical).toContain("shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null");
    expect(canonical).toContain("loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null");
    expect(canonical).toContain("is_primary: form.is_primary");
  });
});

describe("EQC1 Add Club form — Custom / Other insert payload", () => {
  it("carries no canonical identity at all", () => {
    const custom = isolateCustomPayload(readSource(FORM_FILE));
    expect(custom, `${FORM_FILE}: custom payload must clear equipment_model_id`).toContain(
      "equipment_model_id: null"
    );
    expect(custom, `${FORM_FILE}: custom payload must clear manufacturer_id`).toContain(
      "manufacturer_id: null"
    );
    expect(custom, `${FORM_FILE}: custom payload must clear brand`).toContain("brand: null");
    expect(custom, `${FORM_FILE}: custom payload must clear model`).toContain("model: null");
    expect(
      custom,
      `${FORM_FILE}: the custom branch must not reference the canonical selected entry`
    ).not.toContain("selectedEntry");
  });

  it("marks the row custom and preserves the golfer's own text", () => {
    const custom = isolateCustomPayload(readSource(FORM_FILE));
    expect(custom, `${FORM_FILE}: custom payload must set custom_club true`).toContain(
      "custom_club: true"
    );
    expect(custom, `${FORM_FILE}: custom brand must be preserved`).toContain(
      "custom_brand: form.custom_brand || null"
    );
    expect(custom, `${FORM_FILE}: custom model must be preserved`).toContain(
      "custom_model: form.custom_model || null"
    );
  });

  it("preserves the existing fitting fields unchanged", () => {
    const custom = isolateCustomPayload(readSource(FORM_FILE));
    expect(custom).toContain("shaft_flex: form.shaft_flex || null");
    expect(custom).toContain("shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null");
    expect(custom).toContain("loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null");
    expect(custom).toContain("is_primary: form.is_primary");
  });
});

describe("EQC1 Add Club form — cross-mode leakage is structurally impossible", () => {
  it("never spreads form state into an insert payload", () => {
    const source = readSource(FORM_FILE);
    expect(
      source,
      `${FORM_FILE}: spreading the form would let the inactive mode's fields ride along`
    ).not.toContain("...form");
    expect(source, `${FORM_FILE}: the insert must not spread an arbitrary body`).not.toContain(
      ".insert({ ...");
  });

  it("builds two disjoint literals that each name every identity column", () => {
    const source = readSource(FORM_FILE);
    const canonical = isolateCanonicalPayload(source);
    const custom = isolateCustomPayload(source);
    for (const column of [
      "user_id:",
      "club_type:",
      "equipment_model_id:",
      "manufacturer_id:",
      "brand:",
      "model:",
      "custom_club:",
      "custom_brand:",
      "custom_model:",
    ]) {
      expect(canonical, `${FORM_FILE}: canonical payload must name ${column}`).toContain(column);
      expect(custom, `${FORM_FILE}: custom payload must name ${column}`).toContain(column);
    }
  });

  it("types the payload so an omitted column is a compile error, not a runtime leak", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: the payload shape must be declared`).toContain(
      "type UserEquipmentInsert"
    );
    expect(source, `${FORM_FILE}: the payload variable must be typed`).toContain(
      "let payload: UserEquipmentInsert;"
    );
  });
});

// ============================================================================
// Form — failure and coverage UX
// ============================================================================

describe("EQC1 Add Club form — failure and coverage states never lie", () => {
  it("distinguishes an unavailable catalog from an empty one", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: unavailable copy missing`).toContain(
      "Canonical equipment selection is temporarily unavailable."
    );
    expect(source, `${FORM_FILE}: empty-catalog copy missing`).toContain(
      "The canonical equipment catalog is empty."
    );
  });

  it("explains a club type with no canonical coverage", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: club-type coverage-gap copy missing`).toContain(
      "models are available yet"
    );
    expect(source, `${FORM_FILE}: the coverage gap must be derived from the supplied options`).toContain(
      "manufacturers.length === 0"
    );
  });

  it("explains a manufacturer with no models for the selected club type", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: manufacturer coverage-gap copy missing`).toContain(
      "No canonical models for this manufacturer and club type."
    );
    expect(source, `${FORM_FILE}: the model gap must be derived from the supplied options`).toContain(
      "models.length === 0"
    );
  });

  it("keeps Custom / Other reachable in every failure and coverage state", () => {
    const source = readSource(FORM_FILE);
    const mentions = (source.match(/Custom \/ Other/g) ?? []).length;
    expect(
      mentions,
      `${FORM_FILE}: every unavailable/empty/coverage-gap message must point at the Custom / Other escape`
    ).toBeGreaterThanOrEqual(4);
    expect(source, `${FORM_FILE}: Custom / Other defaults on when there is nothing to select`).toContain(
      "custom_club: options.length === 0"
    );
  });

  it("renders no raw catalog database error text", () => {
    const source = readSource(FORM_FILE);
    for (const leak of ["catalog.message", "catalog.code", "PostgREST", "SQLSTATE"]) {
      expect(source, `${FORM_FILE}: ${leak} must never be rendered`).not.toContain(leak);
    }
  });
});

// ============================================================================
// Boundaries — no backfill, no scope creep
// ============================================================================

describe("EQC1 — historical bag rows and out-of-scope surfaces are untouched", () => {
  it("writes new rows only: no update, upsert or delete in the slice", () => {
    for (const file of [PAGE_FILE, FORM_FILE]) {
      const source = readSource(file);
      expect(source, `${file}: the slice must not update existing bag rows`).not.toContain(".update(");
      expect(source, `${file}: the slice must not upsert bag rows`).not.toContain(".upsert(");
      expect(source, `${file}: the slice must not delete bag rows`).not.toContain(".delete(");
    }
    const form = readSource(FORM_FILE);
    expect(
      (form.match(/\.insert\(/g) ?? []).length,
      `${FORM_FILE}: expected exactly one insert — the new club`
    ).toBe(1);
    expect(form, `${FORM_FILE}: the insert target must remain user_equipment`).toContain(
      'from("user_equipment")'
    );
  });

  it("introduces no legacy matching, normalization or backfill logic", () => {
    for (const file of [PAGE_FILE, FORM_FILE]) {
      const source = readSource(file);
      for (const forbidden of ["backfill", "normalizeBrand", "matchLegacy", "fuzzy", "levenshtein"]) {
        expect(source, `${file}: "${forbidden}" would be silent historical linking`).not.toContain(
          forbidden
        );
      }
    }
  });

  it("does not pull in the /bag display surface", () => {
    for (const file of [PAGE_FILE, FORM_FILE]) {
      const source = readSource(file);
      expect(source, `${file}: must not import BagPageClient`).not.toContain("BagPageClient");
    }
    const form = readSource(FORM_FILE);
    expect(
      form,
      `${FORM_FILE}: VirtualBag may only be a type import, never a component dependency`
    ).toContain('import type { ClubType } from "@/components/swing/VirtualBag"');
  });

  it("leaves the canonical reader untouched in its established contract", () => {
    const reader = readSource(READER_FILE);
    expect(reader, `${READER_FILE}: the reader must remain read-only`).not.toContain(".insert(");
    expect(reader, `${READER_FILE}: the reader must remain read-only`).not.toContain(".update(");
    expect(reader, `${READER_FILE}: the reader must never read provenance`).not.toContain(
      'from("equipment_model_sources")'
    );
  });
});

// ============================================================================
// Mobile safety of the new controls
// ============================================================================

describe("EQC1 Add Club form — new selectors stay mobile-safe", () => {
  it("applies the protected input class to all nine controls", () => {
    const source = readSource(FORM_FILE);
    expect(
      (source.match(/className=\{inputCls\}/g) ?? []).length,
      `${FORM_FILE}: expected nine controls (5 selects + 4 text/number inputs)`
    ).toBe(9);
    expect(
      (source.match(/<select/g) ?? []).length,
      `${FORM_FILE}: expected five selects — Club Type, Club Number / Designation, Manufacturer, Model, Shaft Flex`
    ).toBe(5);
  });

  it("keeps exactly the two existing checkbox controls", () => {
    const source = readSource(FORM_FILE);
    expect(
      (source.match(/type="checkbox"/g) ?? []).length,
      `${FORM_FILE}: Custom / Other and Primary Club must remain the only checkboxes`
    ).toBe(2);
  });

  it("introduces no width floor, viewport hack or zoom restriction", () => {
    const source = readSource(FORM_FILE);
    expect(source, `${FORM_FILE}: a fixed width floor would reintroduce horizontal scrolling`).not.toContain(
      "min-w-["
    );
    expect(source, `${FORM_FILE}: unexpected w-screen`).not.toContain("w-screen");
    expect(source, `${FORM_FILE}: unexpected overflow-x-hidden`).not.toContain("overflow-x-hidden");
    expect(source, `${FORM_FILE}: unexpected maximumScale`).not.toContain("maximumScale");
    expect(source, `${FORM_FILE}: unexpected user-scalable=no`).not.toContain("user-scalable=no");
  });

  it("stacks the canonical identity row on phones", () => {
    const source = readSource(FORM_FILE);
    expect(
      source,
      `${FORM_FILE}: manufacturer/model must stack single-column on phone before pairing at sm`
    ).toContain("grid grid-cols-1 sm:grid-cols-2 gap-4");
  });
});
