/**
 * EQDS1 D3-S1 — bag designation capture + display.
 *
 * Two things are under test here, and they are deliberately different in kind.
 *
 * 1. The option helper is exercised as real code: it is pure, synchronous and
 *    dependency-free, so its exact per-club-type sets can simply be asserted.
 *
 * 2. Everything about the form and the bag row is asserted as a STATIC SOURCE
 *    CONTRACT, matching the established style of this repository's other
 *    equipment suites. There is no jsdom or Testing Library in this project and
 *    this slice does not add one.
 *
 * Source assertions are scoped to the region that actually owns the behaviour —
 * the isolated payload branch, the club-type onChange handler, the metadata row —
 * so a test cannot pass merely because the same token appears somewhere else in
 * a large file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClubDesignationOptions,
  isClubDesignationValidFor,
} from "./equipment/club-designation-options";
import type { ClubDesignation, ClubType } from "../types/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Strips TypeScript/JSX comments so "must not contain" assertions describe
 * executable code. Without this, a comment that documents a prohibition — "no
 * inference from loft", "never an Unknown sentinel" — would fail the very test
 * asserting that prohibition. String literals are preserved, because the tokens
 * these tests look for live inside them.
 */
const NEWLINE = String.fromCharCode(10);

function stripTsComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote === null && two === "//") {
      const nl = source.indexOf(NEWLINE, i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (quote === null && two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const c = source[i];
    if (quote !== null) {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
    i += 1;
  }
  return out;
}

const FORM_FILE = "app/(dashboard)/bag/add/AddClubForm.tsx";
const BAG_FILE = "components/swing/VirtualBag.tsx";
const HELPER_FILE = "lib/equipment/club-designation-options.ts";
const D1_FILE = "supabase/migrations/20260824053500_equipment_user_club_designation.sql";

/** The locked D1 vocabulary, in the order the migration lists it. */
const ALL_28: ClubDesignation[] = [
  "2W", "3W", "4W", "5W", "7W", "9W", "11W",
  "1H", "2H", "3H", "4H", "5H", "6H", "7H",
  "1I", "2I", "3I", "4I", "5I", "6I", "7I", "8I", "9I",
  "PW", "AW", "GW", "SW", "LW",
];

const SENTINELS = ["Unknown", "Other", "Custom", "N/A", "None"];

/**
 * The `club_designation in ( ... )` list belonging to one club_type branch of
 * the D1 compatibility constraint. Returns null when the type has no branch,
 * which is how Driver and Putter are expressed in D1.
 */
function d1Branch(sql: string, clubType: string): string[] | null {
  const match = sql.match(
    new RegExp(
      `club_type = '${clubType}'::public\\.club_type_enum\\s*\\n?\\s*and club_designation in \\(([^)]*)\\)`
    )
  );
  if (!match) return null;
  return Array.from(match[1].matchAll(/'([^']+)'/g), (m) => m[1]);
}

/** The custom-mode payload literal, isolated from the canonical one. */
function customPayload(source: string): string {
  const start = source.indexOf("if (form.custom_club) {");
  expect(start, `${FORM_FILE}: could not locate the custom-mode payload branch`).toBeGreaterThan(-1);
  const end = source.indexOf("} else {", start);
  expect(end, `${FORM_FILE}: could not locate the end of the custom-mode branch`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The canonical payload literal, isolated from the custom one. */
function canonicalPayload(source: string): string {
  const branch = source.indexOf("} else {");
  expect(branch, `${FORM_FILE}: could not locate the payload mode branch`).toBeGreaterThan(-1);
  const start = source.indexOf("payload = {", branch);
  expect(start, `${FORM_FILE}: could not locate the canonical payload literal`).toBeGreaterThan(branch);
  const end = source.indexOf("setLoading(true)", start);
  expect(end, `${FORM_FILE}: could not locate the end of the canonical branch`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The onChange handler attached to the Club Type select. */
function clubTypeOnChange(source: string): string {
  const start = source.indexOf("club_type: e.target.value as ClubType");
  expect(start, `${FORM_FILE}: could not locate the club-type onChange handler`).toBeGreaterThan(-1);
  const end = source.indexOf("})", start);
  expect(end, `${FORM_FILE}: could not locate the end of the club-type handler`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The Driver/Putter "no designation" branch of the designation control, scoped
 * to that JSX element so the assertion cannot be satisfied by styling used
 * elsewhere in the form.
 */
function designationNote(source: string): string {
  const code = stripTsComments(source);
  const start = code.indexOf("designationOptions.length === 0");
  expect(start, `${FORM_FILE}: could not locate the no-options branch`).toBeGreaterThan(-1);
  const end = code.indexOf("</p>", start);
  expect(end, `${FORM_FILE}: could not locate the end of the note`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The secondary metadata row in the bag club row. */
function metadataRow(source: string): string {
  const start = source.indexOf('<div className="flex items-center gap-2 mt-0.5">');
  expect(start, `${BAG_FILE}: could not locate the secondary metadata row`).toBeGreaterThan(-1);
  const end = source.indexOf("{/* Telemetry stats */}", start);
  expect(end, `${BAG_FILE}: could not locate the end of the metadata row`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The clubDisplayName function body — D4 territory, frozen for D3. */
function clubDisplayNameBody(source: string): string {
  const start = source.indexOf("function clubDisplayName(club: ClubRecord): string {");
  expect(start, `${BAG_FILE}: could not locate clubDisplayName`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `${BAG_FILE}: could not locate the end of clubDisplayName`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ============================================================================
// A–F. Exact option sets per club type.
// ============================================================================

describe("D3-S1 designation options — exact per-club-type sets", () => {
  it("Wood offers exactly the seven wood designations", () => {
    expect(getClubDesignationOptions("Wood")).toEqual(["2W", "3W", "4W", "5W", "7W", "9W", "11W"]);
  });

  it("Hybrid offers exactly the seven hybrid designations", () => {
    expect(getClubDesignationOptions("Hybrid")).toEqual(["1H", "2H", "3H", "4H", "5H", "6H", "7H"]);
  });

  it("Iron offers exactly the nine iron numbers plus PW", () => {
    expect(getClubDesignationOptions("Iron")).toEqual([
      "1I", "2I", "3I", "4I", "5I", "6I", "7I", "8I", "9I", "PW",
    ]);
  });

  it("Wedge offers exactly PW, AW, GW, SW and LW", () => {
    expect(getClubDesignationOptions("Wedge")).toEqual(["PW", "AW", "GW", "SW", "LW"]);
  });

  it("Driver offers no non-null designation", () => {
    expect(getClubDesignationOptions("Driver")).toEqual([]);
  });

  it("Putter offers no non-null designation", () => {
    expect(getClubDesignationOptions("Putter")).toEqual([]);
  });
});

// ============================================================================
// G–J. Shared tokens, sentinels, and total vocabulary coverage.
// ============================================================================

describe("D3-S1 designation options — vocabulary integrity", () => {
  it("keeps PW valid for both Iron and Wedge rather than collapsing the families", () => {
    expect(getClubDesignationOptions("Iron")).toContain("PW");
    expect(getClubDesignationOptions("Wedge")).toContain("PW");
  });

  it("keeps AW and GW as distinct wedge tokens", () => {
    const wedge = getClubDesignationOptions("Wedge");
    expect(wedge).toContain("AW");
    expect(wedge).toContain("GW");
    expect(new Set(wedge).size).toBe(wedge.length);
  });

  it("covers exactly the locked 28-token vocabulary across all club types", () => {
    const types: ClubType[] = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];
    const union = new Set<string>();
    for (const t of types) for (const d of getClubDesignationOptions(t)) union.add(d);
    expect(Array.from(union).sort()).toEqual([...ALL_28].sort());
  });

  it("introduces no sentinel designation", () => {
    const types: ClubType[] = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];
    for (const t of types) {
      for (const sentinel of SENTINELS) {
        expect(
          getClubDesignationOptions(t) as readonly string[],
          `${t} must not offer the sentinel "${sentinel}"`
        ).not.toContain(sentinel);
      }
    }
    const helper = stripTsComments(readSource(HELPER_FILE));
    for (const sentinel of SENTINELS) {
      expect(
        helper.match(new RegExp(`"${sentinel}"`, "g")),
        `${HELPER_FILE}: "${sentinel}" must not appear as a value`
      ).toBeNull();
    }
  });

  it("returns a stable value rather than a fresh array per call", () => {
    expect(getClubDesignationOptions("Iron")).toBe(getClubDesignationOptions("Iron"));
  });
});

// ============================================================================
// K. Source parity with the D1 compatibility constraint.
// ============================================================================

describe("D3-S1 designation options — parity with the D1 database contract", () => {
  const d1 = readSource(D1_FILE);

  it.each([
    ["Wood" as ClubType],
    ["Hybrid" as ClubType],
    ["Iron" as ClubType],
    ["Wedge" as ClubType],
  ])("%s options match the D1 club-type compatibility branch exactly", (clubType) => {
    const branch = d1Branch(d1, clubType);
    expect(branch, `${D1_FILE}: no ${clubType} branch found`).not.toBeNull();
    expect(getClubDesignationOptions(clubType)).toEqual(branch);
  });

  it.each([["Driver" as ClubType], ["Putter" as ClubType]])(
    "%s has no D1 branch and therefore no options",
    (clubType) => {
      expect(d1Branch(d1, clubType)).toBeNull();
      expect(getClubDesignationOptions(clubType)).toEqual([]);
    }
  );

  it("does not declare a second ClubDesignation union", () => {
    const helper = readSource(HELPER_FILE);
    expect(helper, `${HELPER_FILE}: the union is owned by types/database.ts`).not.toMatch(
      /(export\s+)?type\s+ClubDesignation\s*=/
    );
    expect(helper).toContain('import type { ClubDesignation, ClubType } from "@/types/database"');
  });

  it("performs no lookup, query or inference", () => {
    const helper = stripTsComments(readSource(HELPER_FILE));
    for (const forbidden of ["supabase", "fetch(", "await ", "equipment_model", "loft", "brand"]) {
      expect(helper, `${HELPER_FILE}: "${forbidden}" would make the helper impure`).not.toContain(
        forbidden
      );
    }
  });
});

// ============================================================================
// N, O. Submit-time resolution: blank and incompatible values become null.
// ============================================================================

describe("D3-S1 submit-time designation resolution", () => {
  it("treats blank as no designation", () => {
    expect(isClubDesignationValidFor("Iron", "")).toBe(false);
    expect(isClubDesignationValidFor("Driver", "")).toBe(false);
  });

  it("rejects any designation for Driver and Putter", () => {
    for (const d of ALL_28) {
      expect(isClubDesignationValidFor("Driver", d), `Driver must reject ${d}`).toBe(false);
      expect(isClubDesignationValidFor("Putter", d), `Putter must reject ${d}`).toBe(false);
    }
  });

  it("rejects a designation carried over from an incompatible club type", () => {
    expect(isClubDesignationValidFor("Wood", "7I")).toBe(false);
    expect(isClubDesignationValidFor("Iron", "3W")).toBe(false);
    expect(isClubDesignationValidFor("Hybrid", "SW")).toBe(false);
  });

  it("accepts a designation legal for the current club type", () => {
    expect(isClubDesignationValidFor("Iron", "7I")).toBe(true);
    expect(isClubDesignationValidFor("Iron", "PW")).toBe(true);
    expect(isClubDesignationValidFor("Wedge", "PW")).toBe(true);
    expect(isClubDesignationValidFor("Wood", "3W")).toBe(true);
  });
});

// ============================================================================
// L, M, N, O, P, Q. The Add Club form's contract.
// ============================================================================

describe("D3-S1 Add Club form — designation capture", () => {
  const source = readSource(FORM_FILE);

  it("types the payload column as the database union, nullable", () => {
    const start = source.indexOf("type UserEquipmentInsert = {");
    expect(start, `${FORM_FILE}: the payload shape must remain declared`).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("};", start));
    expect(block).toMatch(/club_designation:\s*ClubDesignation\s*\|\s*null;/);
  });

  it("imports ClubDesignation rather than redefining it", () => {
    expect(source).toContain('import type { ClubDesignation } from "@/types/database"');
    expect(source, `${FORM_FILE}: the union is owned by types/database.ts`).not.toMatch(
      /type\s+ClubDesignation\s*=/
    );
  });

  it("sources its options only from the shared helper", () => {
    expect(source).toContain("getClubDesignationOptions");
    for (const token of ["2W", "1H", "9I", "SW"]) {
      expect(
        source,
        `${FORM_FILE}: "${token}" must not be transcribed into the component`
      ).not.toContain(`"${token}"`);
    }
  });

  it("names club_designation in the custom payload branch", () => {
    expect(customPayload(source)).toContain("club_designation: clubDesignation,");
  });

  it("names club_designation in the canonical payload branch", () => {
    expect(canonicalPayload(source)).toContain("club_designation: clubDesignation,");
  });

  it("resolves the submitted value against the current club type", () => {
    expect(source).toMatch(
      /const clubDesignation: ClubDesignation \| null = isClubDesignationValidFor\(\s*\n?\s*form\.club_type,\s*\n?\s*form\.club_designation\s*\n?\s*\)\s*\n?\s*\?\s*form\.club_designation\s*\n?\s*:\s*null;/
    );
  });

  it("never sends the empty string to the database", () => {
    for (const branch of [customPayload(source), canonicalPayload(source)]) {
      expect(branch, "a blank designation must resolve to null, never \"\"").not.toContain(
        'club_designation: ""'
      );
      expect(branch).not.toContain("club_designation: form.club_designation");
    }
  });

  it("clears the designation when the club type changes", () => {
    expect(clubTypeOnChange(source)).toContain('club_designation: ""');
  });

  it("still clears the canonical identity selections when the club type changes", () => {
    const handler = clubTypeOnChange(source);
    expect(handler).toContain('selectedManufacturerId: ""');
    expect(handler).toContain('selectedModelId: ""');
  });

  it("offers a blank first option and no sentinel", () => {
    expect(source).toContain('<option value="">— None —</option>');
    for (const sentinel of SENTINELS) {
      expect(source, `${FORM_FILE}: "${sentinel}" must not be offered`).not.toContain(
        `<option value="${sentinel}"`
      );
    }
  });

  it("replaces the control with a note when no designation is legal", () => {
    expect(source).toContain("designationOptions.length === 0");
    expect(source).toContain("No separate club designation is recorded for this club type.");
  });

  // For a driver or putter, having no designation is the ordinary correct
  // state — nothing is unavailable and nothing failed. Rendering it in the
  // amber `noticeCls` used by the genuine catalog warnings would tell the
  // golfer something is wrong when nothing is.
  it("styles the Driver/Putter note as neutral copy, not as a warning", () => {
    const note = designationNote(source);
    expect(note, `${FORM_FILE}: the no-designation note must still exist`).toContain(
      "No separate club designation is recorded for this club type."
    );
    expect(note, `${FORM_FILE}: the note must not borrow the amber warning treatment`).not.toContain(
      "noticeCls"
    );
    expect(note, `${FORM_FILE}: the note must use neutral gray/slate copy`).toMatch(
      /className="[^"]*text-(?:gray|slate)-\d{3}[^"]*"/
    );
    for (const alarm of ["amber", "red-", "green-", "emerald"]) {
      expect(note, `${FORM_FILE}: "${alarm}" would make a normal state look like a problem`).not.toContain(
        alarm
      );
    }
  });

  it("leaves noticeCls itself intact for the genuine catalog warnings", () => {
    expect(source).toContain(
      '"text-sm text-amber-200/90 bg-amber-400/10 border border-amber-400/20 rounded-xl px-4 py-3"'
    );
    expect(
      (source.match(/className=\{`?\$?\{?noticeCls/g) ?? []).length,
      `${FORM_FILE}: noticeCls must remain on exactly the two catalog warnings`
    ).toBe(2);
  });
});

// ============================================================================
// R, S, T, U. Everything D3-S1 must leave alone in the form.
// ============================================================================

describe("D3-S1 Add Club form — untouched contracts", () => {
  const source = readSource(FORM_FILE);

  it("leaves loft handling identical in both payload branches", () => {
    const expression = "loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null,";
    expect(customPayload(source)).toContain(expression);
    expect(canonicalPayload(source)).toContain(expression);
    expect((source.match(/parseFloat\(form\.loft_deg\)/g) ?? []).length).toBe(2);
    expect(source).toContain('step="0.5"');
  });

  it("leaves shaft flex and weight handling identical in both branches", () => {
    for (const branch of [customPayload(source), canonicalPayload(source)]) {
      expect(branch).toContain("shaft_flex: form.shaft_flex || null,");
      expect(branch).toContain(
        "shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null,"
      );
    }
  });

  it("leaves canonical catalog identity behaviour unchanged", () => {
    const canonical = canonicalPayload(source);
    expect(canonical).toContain("equipment_model_id: selectedEntry.modelId,");
    expect(canonical).toContain("manufacturer_id: null,");
    expect(canonical).toContain("brand: selectedEntry.manufacturerName,");
    expect(canonical).toContain("model: selectedEntry.modelName,");
    expect(canonical).toContain("custom_club: false,");
    expect(canonical).toContain("custom_brand: null,");
    expect(canonical).toContain("custom_model: null,");
  });

  it("leaves custom-mode identity behaviour unchanged", () => {
    const custom = customPayload(source);
    expect(custom).toContain("equipment_model_id: null,");
    expect(custom).toContain("manufacturer_id: null,");
    expect(custom).toContain("brand: null,");
    expect(custom).toContain("model: null,");
    expect(custom).toContain("custom_club: true,");
    expect(custom).toContain("custom_brand: form.custom_brand || null,");
    expect(custom).toContain("custom_model: form.custom_model || null,");
  });

  it("writes no equipment snapshot and adds no second write", () => {
    expect(source, `${FORM_FILE}: the snapshot is database-owned`).not.toContain(
      "equipment_snapshot"
    );
    expect(source).not.toContain("schema_version");
    expect((source.match(/\.insert\(/g) ?? []).length).toBe(1);
    expect(source).not.toContain(".update(");
    expect(source).not.toContain(".upsert(");
    expect(source).not.toContain(".delete(");
  });

  it("introduces no edit route, backfill or inference", () => {
    const code = stripTsComments(source);
    for (const forbidden of ["/bag/edit", "clubId]/edit", "backfill", "infer", "fuzzy"]) {
      expect(code, `${FORM_FILE}: "${forbidden}" is out of D3-S1 scope`).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// V, W, X. My Bag display and the D4 boundary.
// ============================================================================

describe("D3-S1 My Bag — designation is secondary metadata only", () => {
  const source = readSource(BAG_FILE);

  it("carries club_designation on ClubRecord as the database union", () => {
    const start = source.indexOf("export interface ClubRecord {");
    expect(start, `${BAG_FILE}: ClubRecord must remain declared`).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("\n}", start));
    expect(block).toMatch(/club_designation:\s*ClubDesignation\s*\|\s*null;/);
  });

  it("imports ClubDesignation as a type rather than redefining it", () => {
    expect(source).toContain("import type { ClubDesignation } from '@/types/database'");
    expect(source, `${BAG_FILE}: the union is owned by types/database.ts`).not.toMatch(
      /type\s+ClubDesignation\s*=/
    );
  });

  it("renders the designation inside the secondary metadata row", () => {
    const row = metadataRow(source);
    expect(row).toContain("club.club_designation");
    expect(row, "the designation belongs beside flex, loft and weight").toContain("club.loft_deg");
    expect(row).toContain("club.shaft_flex");
  });

  it("renders nothing when the designation is null", () => {
    expect(metadataRow(source)).toMatch(/\{club\.club_designation && \(/);
  });

  it("leaves clubDisplayName untouched — display naming is D4", () => {
    const body = clubDisplayNameBody(source);
    expect(body, `${BAG_FILE}: designation-first naming belongs to D4`).not.toContain(
      "club_designation"
    );
    expect(body).toContain("club.custom_brand ?? club.brand ?? 'Custom'");
    expect(body).toContain("`${club.brand ?? ''} ${club.model ?? ''}`.trim()");
    expect(
      body,
      `${BAG_FILE}: a designation-first label belongs to D4, not here`
    ).not.toContain(" · ");
  });

  it("adds no write path to a presentation component", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", "supabase"]) {
      expect(source, `${BAG_FILE}: presentation must stay read-only`).not.toContain(forbidden);
    }
  });
});
