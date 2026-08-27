/**
 * EQDS1 D3-S2 — editing an existing saved club.
 *
 * These are static source contracts, in the established style of this
 * repository's other equipment suites. There is no jsdom or Testing Library in
 * this project and this slice does not add one.
 *
 * The load-bearing assertions are the negative ones. A golfer may correct how a
 * club is fitted; they may not turn one saved club into a different club, and
 * this route must not be able to do so even by accident. So the update payload
 * is pinned to exactly five keys, every identity column is asserted absent, and
 * the row-spread that would quietly reintroduce them is forbidden outright.
 *
 * Assertions are scoped to the region that owns the behaviour — the update
 * payload literal, the designation branch, the isolated ClubRow — so a test
 * cannot pass merely because a token appears elsewhere in a large file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const NEWLINE = String.fromCharCode(10);

/**
 * Strips TypeScript/JSX comments so "must not contain" assertions describe
 * executable code. A comment documenting a prohibition must not fail the very
 * test asserting it. String literals are preserved — the tokens these tests
 * look for live inside them.
 */
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

const EDIT_PAGE = "app/(dashboard)/bag/[clubId]/edit/page.tsx";
const EDIT_FORM = "app/(dashboard)/bag/[clubId]/edit/EditClubForm.tsx";
const ADD_FORM = "app/(dashboard)/bag/add/AddClubForm.tsx";
const BAG_CLIENT = "app/(dashboard)/bag/BagPageClient.tsx";
const VIRTUAL_BAG = "components/swing/VirtualBag.tsx";

/** Exactly the columns D3-S2 may write. */
const WRITABLE = [
  "club_designation",
  "loft_deg",
  "shaft_flex",
  "shaft_weight",
  "is_primary",
];

/** Columns that must never appear in the update payload, even unchanged. */
const FORBIDDEN = [
  "id",
  "user_id",
  "club_type",
  "equipment_model_id",
  "manufacturer_id",
  "brand",
  "model",
  "custom_club",
  "custom_brand",
  "custom_model",
  "custom_notes",
  "created_at",
  "updated_at",
];

/** The `const payload: UserEquipmentUpdate = { ... }` object literal. */
function updatePayload(source: string): string {
  const code = stripTsComments(source);
  const start = code.indexOf("const payload: UserEquipmentUpdate = {");
  expect(start, `${EDIT_FORM}: the update payload must be a declared literal`).toBeGreaterThan(-1);
  const end = code.indexOf("};", start);
  expect(end, `${EDIT_FORM}: could not locate the end of the update payload`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The top-level keys of the update payload literal. */
function payloadKeys(source: string): string[] {
  return updatePayload(source)
    .split(NEWLINE)
    .map((line) => line.match(/^\s{6}([a-z_]+):/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1]);
}

/** The `.update(...)` call chain, through its terminating call. */
function updateChain(source: string): string {
  const code = stripTsComments(source);
  const start = code.indexOf('.from("user_equipment")');
  expect(start, `${EDIT_FORM}: the update target must be user_equipment`).toBeGreaterThan(-1);
  const end = code.indexOf(";", start);
  expect(end, `${EDIT_FORM}: could not locate the end of the update chain`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** The Driver/Putter no-designation branch of the designation control. */
function designationNote(source: string): string {
  const code = stripTsComments(source);
  const start = code.indexOf("designationOptions.length === 0");
  expect(start, `${EDIT_FORM}: could not locate the no-options branch`).toBeGreaterThan(-1);
  const end = code.indexOf("</p>", start);
  expect(end, `${EDIT_FORM}: could not locate the end of the note`).toBeGreaterThan(start);
  return code.slice(start, end);
}

/** ClubRow, isolated from the rest of VirtualBag. */
function clubRow(source: string): string {
  const start = source.indexOf("function ClubRow({");
  expect(start, `${VIRTUAL_BAG}: could not locate ClubRow`).toBeGreaterThan(-1);
  const end = source.indexOf("// ── Main component", start);
  expect(end, `${VIRTUAL_BAG}: could not locate the end of ClubRow`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The clubDisplayName body — D4 territory, frozen for D3. */
function clubDisplayNameBody(source: string): string {
  const start = source.indexOf("function clubDisplayName(club: ClubRecord): string {");
  expect(start, `${VIRTUAL_BAG}: could not locate clubDisplayName`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `${VIRTUAL_BAG}: could not locate the end of clubDisplayName`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The quoted string list assigned to SHAFT_FLEX_OPTIONS in a given file. */
function shaftFlexOptions(source: string, fileLabel: string): string[] {
  const match = source.match(/const SHAFT_FLEX_OPTIONS = \[([^\]]*)\]/);
  expect(match, `${fileLabel}: could not locate SHAFT_FLEX_OPTIONS`).not.toBeNull();
  return Array.from(match![1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

// ============================================================================
// 1–6. The edit route and its owner-scoped server page.
// ============================================================================

describe("D3-S2 edit route — server page", () => {
  it("exists at the [clubId]/edit path", () => {
    expect(existsSync(path.join(repoRoot, EDIT_PAGE)), `missing file: ${EDIT_PAGE}`).toBe(true);
    expect(existsSync(path.join(repoRoot, EDIT_FORM)), `missing file: ${EDIT_FORM}`).toBe(true);
    expect(EDIT_PAGE).toContain("[clubId]/edit/page.tsx");
  });

  it("types the route param as clubId", () => {
    const source = readSource(EDIT_PAGE);
    expect(source).toMatch(/params\s*}:\s*\{\s*params:\s*\{\s*clubId:\s*string\s*\}\s*\}/);
    expect(source).toContain("params.clubId");
  });

  it("authenticates through the established session helper", () => {
    const source = readSource(EDIT_PAGE);
    expect(source).toContain("getServerSession()");
    expect(source).toContain('redirect("/login")');
    expect(source).toContain('from "@/utils/supabase/server"');
  });

  it("scopes the row fetch by BOTH id and the authenticated user_id", () => {
    const code = stripTsComments(readSource(EDIT_PAGE));
    expect(code).toContain('.eq("id", params.clubId)');
    expect(code).toContain('.eq("user_id", session.user.id)');
  });

  it("resolves a missing or non-owned row through notFound, leaking nothing", () => {
    const source = readSource(EDIT_PAGE);
    expect(source).toContain("notFound()");
    expect(source).toMatch(/if\s*\(!club\)\s*notFound\(\)/);
  });

  it("requires no catalog data, because equipment identity is immutable", () => {
    const code = stripTsComments(readSource(EDIT_PAGE));
    for (const forbidden of ["queryCanonicalEquipmentCatalog", "CatalogState", "CatalogOption"]) {
      expect(code, `${EDIT_PAGE}: "${forbidden}" is not needed when identity cannot change`).not.toContain(
        forbidden
      );
    }
  });

  it("never uses a service-role client", () => {
    const code = stripTsComments(readSource(EDIT_PAGE));
    for (const forbidden of ["SERVICE_ROLE", "service_role", "serviceRole"]) {
      expect(code, `${EDIT_PAGE}: RLS must remain the authority`).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// 7–17. The update contract.
// ============================================================================

describe("D3-S2 edit form — update contract", () => {
  const source = readSource(EDIT_FORM);

  it("uses the authenticated browser client", () => {
    expect(source).toContain('from "@/utils/supabase/client"');
    for (const forbidden of ["SERVICE_ROLE", "service_role", "serviceRole"]) {
      expect(stripTsComments(source), `${EDIT_FORM}: RLS must remain the authority`).not.toContain(
        forbidden
      );
    }
  });

  it("performs exactly one user_equipment update", () => {
    const code = stripTsComments(source);
    expect((code.match(/\.update\(/g) ?? []).length).toBe(1);
    expect(code).toContain('.from("user_equipment")');
  });

  it("writes exactly the five permitted columns", () => {
    expect(payloadKeys(source)).toEqual(WRITABLE);
  });

  it("omits every identity and bookkeeping column from the payload", () => {
    const payload = updatePayload(source);
    for (const column of FORBIDDEN) {
      expect(
        payload,
        `${EDIT_FORM}: "${column}" must not be writable through the edit route`
      ).not.toMatch(new RegExp(`^\\s+${column}:`, "m"));
    }
  });

  it("never spreads the fetched row into the payload", () => {
    const payload = updatePayload(source);
    expect(payload, `${EDIT_FORM}: a spread would silently reintroduce identity columns`).not.toContain(
      "..."
    );
  });

  it("filters the update by both id and user_id", () => {
    const chain = updateChain(source);
    expect(chain).toContain('.eq("id", club.id)');
    expect(chain).toContain('.eq("user_id", userId)');
  });

  it("returns the updated row so a zero-row update cannot read as success", () => {
    const chain = updateChain(source);
    expect(chain).toContain('.select("id")');
    expect(chain).toContain(".maybeSingle()");
    expect(stripTsComments(source)).toMatch(/if\s*\(err\s*\|\|\s*!data\)/);
  });

  it("never carries userId into the payload", () => {
    expect(updatePayload(source)).not.toContain("userId");
  });

  it("adds no second write of any kind", () => {
    const code = stripTsComments(source);
    for (const forbidden of [".insert(", ".upsert(", ".delete(", ".rpc("]) {
      expect(code, `${EDIT_FORM}: "${forbidden}" is out of D3-S2 scope`).not.toContain(forbidden);
    }
  });

  it("never authors an equipment snapshot", () => {
    const code = stripTsComments(source);
    expect(code, `${EDIT_FORM}: the snapshot is database-owned`).not.toContain("equipment_snapshot");
    expect(code).not.toContain("schema_version");
  });

  it("shows generic copy on failure and keeps database detail out of the UI", () => {
    const code = stripTsComments(source);
    expect(code).toContain("Could not update this club. Please try again.");
    expect(code, `${EDIT_FORM}: raw database text must not be rendered`).not.toContain(
      "setError(err.message)"
    );
    expect(code, `${EDIT_FORM}: the underlying error may be logged, not displayed`).toContain(
      "console.error"
    );
  });
});

// ============================================================================
// 16–21. Designation behaviour.
// ============================================================================

describe("D3-S2 edit form — club designation", () => {
  const source = readSource(EDIT_FORM);

  it("reuses the shared D3-S1 helper", () => {
    expect(source).toContain('from "@/lib/equipment/club-designation-options"');
    expect(source).toContain("getClubDesignationOptions");
    expect(source).toContain("isClubDesignationValidFor");
  });

  it("transcribes no designation vocabulary of its own", () => {
    const code = stripTsComments(source);
    for (const token of ["2W", "1H", "9I", "SW", "PW", "AW", "GW", "LW"]) {
      expect(
        code,
        `${EDIT_FORM}: "${token}" must come from the helper, not from this component`
      ).not.toContain(`"${token}"`);
    }
  });

  it("narrows the options by the immutable saved club type", () => {
    expect(stripTsComments(source)).toContain("getClubDesignationOptions(club.club_type)");
  });

  it("initialises a stored designation only when it is still valid for the club type", () => {
    expect(stripTsComments(source)).toMatch(
      /isClubDesignationValidFor\(club\.club_type,\s*club\.club_designation \?\? ""\)\s*\n?\s*\?\s*club\.club_designation\s*\n?\s*:\s*""/
    );
  });

  it("resolves blank or incompatible selections to null at submit", () => {
    const code = stripTsComments(source);
    expect(code).toMatch(
      /const clubDesignation: ClubDesignation \| null = isClubDesignationValidFor\(\s*\n?\s*club\.club_type,\s*\n?\s*form\.club_designation\s*\n?\s*\)\s*\n?\s*\?\s*form\.club_designation\s*\n?\s*:\s*null;/
    );
    expect(updatePayload(source)).toContain("club_designation: clubDesignation,");
    expect(updatePayload(source)).not.toContain('club_designation: ""');
  });

  it("offers a blank first option and no sentinel value", () => {
    expect(source).toContain('<option value="">— None —</option>');
    for (const sentinel of ["Unknown", "Other", "Custom", "N/A", "None"]) {
      expect(source, `${EDIT_FORM}: "${sentinel}" must not be offered`).not.toContain(
        `<option value="${sentinel}"`
      );
    }
  });

  it("gives Driver and Putter a neutral note rather than a warning", () => {
    const note = designationNote(source);
    expect(note).toContain("No separate club designation is recorded for this club type.");
    for (const alarm of ["amber", "red-", "green-", "emerald", "noticeCls"]) {
      expect(note, `${EDIT_FORM}: a normal state must not look like a problem`).not.toContain(alarm);
    }
    expect(note).toMatch(/className="[^"]*text-(?:gray|slate)-\d{3}[^"]*"/);
  });
});

// ============================================================================
// 22–29. Loft, shaft flex, shaft weight.
// ============================================================================

describe("D3-S2 edit form — fitting fields", () => {
  const source = readSource(EDIT_FORM);

  it("keeps the established loft input semantics", () => {
    const code = stripTsComments(source);
    expect(code).toContain('step="0.5"');
    expect(code).toMatch(/type="number"[\s\S]{0,80}step="0\.5"[\s\S]{0,40}min="0"/);
  });

  it("treats a blank loft as null and rejects a negative or non-finite value", () => {
    const code = stripTsComments(source);
    expect(code).toMatch(/let loftDeg: number \| null = null;/);
    expect(code).toMatch(/!Number\.isFinite\(parsed\) \|\| parsed < 0/);
    expect(updatePayload(source)).toContain("loft_deg: loftDeg,");
  });

  it("offers exactly the five established shaft flex values", () => {
    expect(shaftFlexOptions(source, EDIT_FORM)).toEqual([
      "Ladies",
      "Senior",
      "Regular",
      "Stiff",
      "X-Stiff",
    ]);
  });

  it("keeps the edit flex vocabulary identical to Add Club, so the two cannot drift", () => {
    expect(shaftFlexOptions(source, EDIT_FORM)).toEqual(
      shaftFlexOptions(readSource(ADD_FORM), ADD_FORM)
    );
  });

  it("writes the validated shaft flex rather than raw form state", () => {
    const payload = updatePayload(source);
    expect(payload).toContain("shaft_flex: shaftFlex,");
    expect(
      payload,
      `${EDIT_FORM}: an unvalidated form value must never reach the row`
    ).not.toContain("shaft_flex: form.shaft_flex");
    expect(payload).not.toContain("form.shaft_flex || null");
  });

  // A pre-existing row can hold a shaft_flex outside the five values this form
  // supports — the column is plain text with no database CHECK. Fail closed in
  // both directions, exactly as the designation does: such a value neither
  // survives into form state nor gets written back.
  it("derives shaft-flex membership from the option list itself", () => {
    const code = stripTsComments(source);
    expect(code).toMatch(/const SHAFT_FLEX_OPTIONS = \[[^\]]*\] as const;/);
    expect(code).toMatch(/type ShaftFlex = \(typeof SHAFT_FLEX_OPTIONS\)\[number\];/);
    expect(code).toMatch(/function isShaftFlex\(value: string\): value is ShaftFlex \{/);
    expect(code).toContain("SHAFT_FLEX_OPTIONS.some((option) => option === value)");
  });

  it("transcribes no second flex vocabulary for validation", () => {
    const code = stripTsComments(source);
    for (const flex of ["Ladies", "Senior", "Regular", "Stiff", "X-Stiff"]) {
      expect(
        (code.match(new RegExp(`"${flex}"`, "g")) ?? []).length,
        `${EDIT_FORM}: "${flex}" must appear only in SHAFT_FLEX_OPTIONS`
      ).toBe(1);
    }
  });

  it("initialises a stored flex only when it is one of the five supported values", () => {
    const code = stripTsComments(source);
    expect(code).toMatch(
      /shaft_flex: isShaftFlex\(club\.shaft_flex \?\? ""\) \? \(club\.shaft_flex as ShaftFlex\) : "",/
    );
    expect(
      code,
      `${EDIT_FORM}: the unguarded initialiser would carry an unsupported value forward`
    ).not.toContain('shaft_flex: club.shaft_flex ?? ""');
  });

  it("validates membership again at submit time", () => {
    expect(stripTsComments(source)).toMatch(
      /const shaftFlex: ShaftFlex \| null = isShaftFlex\(form\.shaft_flex\) \? form\.shaft_flex : null;/
    );
  });

  it("keeps shaft weight in grams and never renames the column", () => {
    const code = stripTsComments(source);
    expect(code).toContain("Shaft Weight (g)");
    expect(code, `${EDIT_FORM}: shaft_weight_grams is a snapshot key, not a column`).not.toContain(
      "shaft_weight_grams"
    );
    expect(payloadKeys(source)).toContain("shaft_weight");
  });

  it("requires whole grams and treats blank as null", () => {
    const code = stripTsComments(source);
    expect(code).toMatch(/let shaftWeight: number \| null = null;/);
    expect(code).toMatch(/!Number\.isInteger\(parsed\) \|\| parsed < 0/);
    expect(code).toMatch(/type="number"[\s\S]{0,80}min="0"[\s\S]{0,40}step="1"/);
    expect(updatePayload(source)).toContain("shaft_weight: shaftWeight,");
  });
});

// ============================================================================
// 30–31. is_primary stays an independent boolean.
// ============================================================================

describe("D3-S2 edit form — is_primary", () => {
  const source = readSource(EDIT_FORM);

  it("writes a plain boolean", () => {
    expect(updatePayload(source)).toContain("is_primary: form.is_primary,");
    expect(source).toContain('type="checkbox"');
  });

  it("never touches a sibling row's primary flag", () => {
    const code = stripTsComments(source);
    expect(
      (code.match(/\.update\(/g) ?? []).length,
      `${EDIT_FORM}: exactly one row may be updated per submit`
    ).toBe(1);
    expect(code, `${EDIT_FORM}: no sibling lookup`).not.toContain('.eq("club_type"');
    expect(code, `${EDIT_FORM}: no sibling reset`).not.toContain("is_primary: false");
    expect(code).not.toContain(".neq(");
  });
});

// ============================================================================
// 32–38. My Bag affordance, and the D4 / EQ3 boundaries.
// ============================================================================

describe("D3-S2 My Bag — edit affordance", () => {
  const bag = readSource(VIRTUAL_BAG);

  it("exposes an onEditClub callback rather than a one-off link", () => {
    expect(bag).toMatch(/onEditClub\?:\s*\(clubId: string\) => void;/);
    expect(bag).toContain("onEdit={onEditClub ? () => onEditClub(club.id) : undefined}");
    expect(clubRow(bag), `${VIRTUAL_BAG}: the row must not navigate on its own`).not.toContain(
      "next/link"
    );
  });

  it("renders an accessible edit button with a 44px touch target", () => {
    const row = clubRow(bag);
    expect(row).toContain('title="Edit club"');
    expect(row).toContain("aria-label={`Edit ${clubDisplayName(club)}`}");
    expect(row).toContain("<Pencil className=");
    const tagStart = row.lastIndexOf("<button", row.indexOf("onClick={onEdit}"));
    const tag = row.slice(tagStart, row.indexOf(">", row.indexOf("onClick={onEdit}")) + 1);
    for (const required of ["min-h-11", "min-w-11"]) {
      expect(tag, `${VIRTUAL_BAG}: edit button missing "${required}"`).toContain(required);
    }
    for (const forbidden of ["hidden", "invisible", "opacity-0", "group-hover:"]) {
      expect(tag, `${VIRTUAL_BAG}: the edit control must be visible without hover`).not.toContain(
        forbidden
      );
    }
  });

  it("routes editing from BagPageClient to the club's edit page", () => {
    const client = readSource(BAG_CLIENT);
    expect(client).toContain("function handleEditClub(clubId: string)");
    expect(client).toContain("router.push(`/bag/${clubId}/edit`)");
    expect(client).toContain("onEditClub={handleEditClub}");
  });

  it("leaves clubDisplayName untouched — display naming is D4", () => {
    const body = clubDisplayNameBody(bag);
    expect(body, `${VIRTUAL_BAG}: designation-first naming belongs to D4`).not.toContain(
      "club_designation"
    );
    expect(body).toContain("club.custom_brand ?? club.brand ?? 'Custom'");
    expect(body, `${VIRTUAL_BAG}: a designation-first label belongs to D4`).not.toContain(" · ");
  });

  // The two new files are held to the full boundary. The modified files are
  // held only to "gained nothing new": BagPageClient already routes the Fit
  // action to /analyze?club_id=…, which is pre-existing navigation on main and
  // not the analysis persistence EQ3 owns.
  it("introduces no D4 display helper and no EQ3 analysis wiring in the new files", () => {
    for (const file of [EDIT_PAGE, EDIT_FORM]) {
      const code = stripTsComments(readSource(file));
      for (const forbidden of [
        "saved-clubs",
        "displayName",
        "swing_analysis",
        "club_id",
        "swing_telemetry",
        "launch_monitor",
      ]) {
        expect(code, `${file}: "${forbidden}" is out of D3-S2 scope`).not.toContain(forbidden);
      }
    }
  });

  it("adds no D4 or EQ3 surface to the modified files either", () => {
    for (const file of [BAG_CLIENT, VIRTUAL_BAG]) {
      const code = stripTsComments(readSource(file));
      for (const forbidden of [
        "saved-clubs",
        "swing_analysis",
        "swing_telemetry",
        "launch_monitor",
      ]) {
        expect(code, `${file}: "${forbidden}" is out of D3-S2 scope`).not.toContain(forbidden);
      }
    }
    // The one pre-existing club_id usage is the Fit navigation, unchanged.
    const client = stripTsComments(readSource(BAG_CLIENT));
    expect(
      (client.match(/club_id/g) ?? []).length,
      `${BAG_CLIENT}: the only club_id usage must remain the pre-existing Fit link`
    ).toBe(1);
    expect(client).toContain("router.push(`/analyze?club_id=${clubId}`)");
  });
});
