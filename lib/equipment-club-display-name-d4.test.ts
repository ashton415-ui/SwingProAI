/**
 * EQDS1 D4 — the shared saved-club display name.
 *
 * The helper is pure and synchronous, so unlike this repository's schema and
 * component suites it is exercised as real code rather than as a source
 * contract. A few static assertions remain at the end for the properties that
 * only source can prove: that the designation vocabulary is not transcribed
 * here, and that the separator lives in exactly one place.
 *
 * The load-bearing cases are the fail-closed ones. A designation the row cannot
 * legally hold must never reach a label, and no field other than
 * `club_designation` may ever produce a prefix.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClubDisplayName,
  CLUB_DISPLAY_NAME_SEPARATOR,
  type ClubDisplayNameInput,
} from "./equipment/club-display-name";
import type { ClubDesignation, ClubType } from "../types/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const HELPER_FILE = "lib/equipment/club-display-name.ts";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const NEWLINE = String.fromCharCode(10);

/**
 * Strips comments so "must not contain" assertions describe executable code.
 * The helper's own documentation names the things it deliberately does not do
 * — Supabase, loft, shaft, snapshots — and that prose must not fail the very
 * test forbidding them. String literals are preserved.
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

/** A canonical (non-custom) saved row, overridable per case. */
function club(overrides: Partial<ClubDisplayNameInput> = {}): ClubDisplayNameInput {
  return {
    club_type: "Iron" as ClubType,
    club_designation: null,
    brand: "PING",
    model: "G440",
    custom_club: false,
    custom_brand: null,
    custom_model: null,
    ...overrides,
  };
}

/**
 * Forces a value the production types forbid, so the runtime fail-closed
 * behaviour can be proven. Used only where an impossible row must be simulated
 * — the production input type is deliberately not widened to accommodate it.
 */
function forceDesignation(value: string): ClubDesignation {
  return value as ClubDesignation;
}

// ============================================================================
// 1–4. A valid designation leads the name.
// ============================================================================

describe("D4 display name — valid designation is prefixed", () => {
  it("prefixes a wood designation", () => {
    expect(
      getClubDisplayName(club({ club_type: "Wood", club_designation: "3W", model: "G430 Max" }))
    ).toBe("3W · PING G430 Max");
  });

  it("prefixes a hybrid designation", () => {
    expect(
      getClubDisplayName(club({ club_type: "Hybrid", club_designation: "4H" }))
    ).toBe("4H · PING G440");
  });

  it("prefixes an iron designation", () => {
    expect(getClubDisplayName(club({ club_designation: "7I" }))).toBe("7I · PING G440");
  });

  it("prefixes a wedge designation", () => {
    expect(
      getClubDisplayName(club({ club_type: "Wedge", club_designation: "SW", model: "Glide 4.0" }))
    ).toBe("SW · PING Glide 4.0");
  });

  it("accepts PW under both Iron and Wedge, as the database does", () => {
    expect(getClubDisplayName(club({ club_type: "Iron", club_designation: "PW" }))).toBe(
      "PW · PING G440"
    );
    expect(getClubDisplayName(club({ club_type: "Wedge", club_designation: "PW" }))).toBe(
      "PW · PING G440"
    );
  });

  it("uses exactly one space, a middle dot, and one space", () => {
    expect(CLUB_DISPLAY_NAME_SEPARATOR).toBe(" · ");
    expect(getClubDisplayName(club({ club_designation: "7I" }))).toBe(
      `7I${CLUB_DISPLAY_NAME_SEPARATOR}PING G440`
    );
  });
});

// ============================================================================
// 5–9. Fail-closed: null, Driver/Putter, incompatible, unknown.
// ============================================================================

describe("D4 display name — fails closed to the identity name", () => {
  it("leaves an undesignated row exactly as it was before D4", () => {
    expect(getClubDisplayName(club())).toBe("PING G440");
    expect(getClubDisplayName(club())).not.toContain(CLUB_DISPLAY_NAME_SEPARATOR);
  });

  it("never prefixes a driver, whatever is stored", () => {
    expect(getClubDisplayName(club({ club_type: "Driver", club_designation: null }))).toBe(
      "PING G440"
    );
    for (const d of ["3W", "7I", "PW", "SW"]) {
      expect(
        getClubDisplayName(
          club({ club_type: "Driver", club_designation: forceDesignation(d) })
        ),
        `Driver must not be labelled "${d}"`
      ).toBe("PING G440");
    }
  });

  it("never prefixes a putter, whatever is stored", () => {
    expect(getClubDisplayName(club({ club_type: "Putter", club_designation: null }))).toBe(
      "PING G440"
    );
    for (const d of ["3W", "7I", "PW", "SW"]) {
      expect(
        getClubDisplayName(
          club({ club_type: "Putter", club_designation: forceDesignation(d) })
        ),
        `Putter must not be labelled "${d}"`
      ).toBe("PING G440");
    }
  });

  it("drops a designation that is real but illegal for this club type", () => {
    expect(
      getClubDisplayName(club({ club_type: "Wood", club_designation: forceDesignation("7I") }))
    ).toBe("PING G440");
    expect(
      getClubDisplayName(club({ club_type: "Iron", club_designation: forceDesignation("3W") }))
    ).toBe("PING G440");
    expect(
      getClubDisplayName(club({ club_type: "Hybrid", club_designation: forceDesignation("SW") }))
    ).toBe("PING G440");
  });

  it("drops a designation that is not in the vocabulary at all", () => {
    for (const junk of ["", "  ", "7 I", "7i", "Unknown", "Other", "N/A", "13I", "ZZ"]) {
      expect(
        getClubDisplayName(club({ club_designation: forceDesignation(junk) })),
        `"${junk}" must not be labelled`
      ).toBe("PING G440");
    }
  });
});

// ============================================================================
// 10–17. Identity precedence is preserved exactly.
// ============================================================================

describe("D4 display name — identity precedence is unchanged", () => {
  it("prefers custom brand and model on a custom row", () => {
    expect(
      getClubDisplayName(
        club({
          custom_club: true,
          custom_brand: "Acme",
          custom_model: "Prototype",
          brand: "PING",
          model: "G440",
        })
      )
    ).toBe("Acme Prototype");
  });

  it("falls back from custom brand to the legacy brand", () => {
    expect(
      getClubDisplayName(
        club({ custom_club: true, custom_brand: null, brand: "PING", custom_model: "Prototype" })
      )
    ).toBe("PING Prototype");
  });

  it("falls back from custom model to the legacy model", () => {
    expect(
      getClubDisplayName(
        club({ custom_club: true, custom_brand: "Acme", custom_model: null, model: "G440" })
      )
    ).toBe("Acme G440");
  });

  it('falls back to "Custom" when a custom row has no brand text at all', () => {
    expect(
      getClubDisplayName(
        club({
          custom_club: true,
          custom_brand: null,
          brand: null,
          custom_model: null,
          model: null,
        })
      )
    ).toBe("Custom");
  });

  it("keeps saved brand and model on a non-custom row", () => {
    expect(getClubDisplayName(club())).toBe("PING G440");
  });

  it("handles brand-only and model-only rows", () => {
    expect(getClubDisplayName(club({ model: null }))).toBe("PING");
    expect(getClubDisplayName(club({ brand: null }))).toBe("G440");
  });

  it("falls back to the club type when no identity text is usable", () => {
    expect(getClubDisplayName(club({ brand: null, model: null }))).toBe("Iron");
    expect(getClubDisplayName(club({ club_type: "Putter", brand: "", model: "" }))).toBe("Putter");
  });

  it("names a designated row that carries no brand or model", () => {
    expect(
      getClubDisplayName(club({ club_designation: "7I", brand: null, model: null }))
    ).toBe("7I · Iron");
  });

  it("prefixes a custom row the same way", () => {
    expect(
      getClubDisplayName(
        club({
          club_type: "Wood",
          club_designation: "3W",
          custom_club: true,
          custom_brand: "Acme",
          custom_model: "Prototype",
        })
      )
    ).toBe("3W · Acme Prototype");
  });
});

// ============================================================================
// 18. Nothing but the stored designation may produce a prefix.
// ============================================================================

describe("D4 display name — no inference", () => {
  it("ignores every field that is not club_designation", () => {
    // A 7-iron's typical loft, an iron-sounding model, and a primary flag are
    // all present; none of them may manufacture a designation.
    const inferable = {
      ...club({ club_designation: null, model: "G440 7-Iron" }),
      loft_deg: 30.5,
      shaft_flex: "Regular",
      shaft_weight: 105,
      is_primary: true,
      equipment_model_id: "11111111-1111-4111-8111-111111111111",
      manufacturer_id: "22222222-2222-4222-8222-222222222222",
    } as unknown as ClubDisplayNameInput;

    const name = getClubDisplayName(inferable);
    expect(name).toBe("PING G440 7-Iron");
    expect(name, "no designation may be invented from other fields").not.toContain(
      CLUB_DISPLAY_NAME_SEPARATOR
    );
  });

  it("reads no catalog, database or telemetry source", () => {
    const source = stripTsComments(readSource(HELPER_FILE));
    for (const forbidden of [
      "supabase",
      "fetch(",
      "await ",
      "async ",
      "equipment_model",
      "manufacturer_id",
      "loft",
      "shaft",
      "telemetry",
      "snapshot",
      "react",
      "useState",
    ]) {
      expect(source.toLowerCase(), `${HELPER_FILE}: "${forbidden}" would make the helper impure`)
        .not.toContain(forbidden.toLowerCase());
    }
  });

  it("delegates compatibility rather than transcribing the vocabulary", () => {
    const source = stripTsComments(readSource(HELPER_FILE));
    expect(source).toContain('from "@/lib/equipment/club-designation-options"');
    expect(source).toContain("isClubDesignationValidFor");
    for (const token of ["2W", "3W", "1H", "7I", "9I", "PW", "AW", "GW", "SW", "LW"]) {
      expect(
        source,
        `${HELPER_FILE}: "${token}" must come from the D1-derived helper`
      ).not.toContain(`"${token}"`);
    }
    expect(source, `${HELPER_FILE}: the union is owned by types/database.ts`).not.toMatch(
      /type\s+ClubDesignation\s*=/
    );
  });

  it("declares the separator exactly once", () => {
    const source = stripTsComments(readSource(HELPER_FILE));
    expect((source.match(/" · "/g) ?? []).length).toBe(1);
    expect(source).toContain("export const CLUB_DISPLAY_NAME_SEPARATOR");
  });

  it("derives its input type from the authoritative row type", () => {
    const source = readSource(HELPER_FILE);
    expect(source).toMatch(/Pick<\s*\n?\s*UserEquipment,/);
    expect(source).toContain('import type { UserEquipment } from "@/types/database"');
  });
});
