/**
 * EQ5F-A — historical equipment identity authority.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * `public.swing_analysis.equipment_snapshot` is written by a before-insert
 * database trigger and frozen afterwards. It is therefore the only record of
 * what a golfer actually swung, and it stays correct after the saved club is
 * edited, archived, deleted or corrected in the catalog. The legacy
 * `public.swing_videos.club` string is none of those things: it is free text
 * captured beside the upload.
 *
 * Two failures matter more than the feature. The first is a second opinion — a
 * consumer reconstructing historical identity from the live bag, the catalog,
 * `club_id`, the filename, the analysis family or a model's output would name a
 * club from evidence that can change after the fact. The second is a silent
 * downgrade — a helper that returns "Putter" or "Iron" whenever real identity
 * text is missing would always succeed, and would outrank a legacy value that
 * may actually name the club.
 *
 * So the helper is tested behaviourally, and the consumers are pinned against
 * their real source: the precedence they encode is the contract, and there is
 * no renderer here to observe it any other way (vitest runs in the node
 * environment with no jsdom). Every source claim is paired with an in-memory
 * mutation proving it would fail on regressed code. Nothing is written to disk.
 *
 * No database, no network, no Supabase client, no model, no filesystem write.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getHistoricalEquipmentDisplayName,
  getHistoricalEquipmentDisplayNameConsensus,
} from "@/lib/equipment/historical-equipment-display-name";
import { CLUB_DISPLAY_NAME_SEPARATOR } from "@/lib/equipment/club-display-name";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

function countOccurrences(haystack: string, needle: string): number {
  let total = 0;
  let cursor = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) return total;
    total += 1;
    cursor = idx + needle.length;
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const HELPER = "lib/equipment/historical-equipment-display-name.ts";
const DASHBOARD = "app/(dashboard)/dashboard/page.tsx";
const SWING_DETAIL = "app/(dashboard)/swings/[id]/page.tsx";
const TELEMETRY = "app/(dashboard)/telemetry/page.tsx";
const ANALYZE_PAGE = "app/(dashboard)/analyze/[id]/page.tsx";
const ANALYSIS_REPORT = "app/(dashboard)/analyze/[id]/AnalysisReport.tsx";
const ADMIN_VIDEOS = "app/(dashboard)/admin/swings/page.tsx";
const COACH_REVIEWS = "app/(dashboard)/coach/reviews/page.tsx";
const ANALYZE_API = "app/api/analyze-swing/route.ts";

const HELPER_MODULE = "@/lib/equipment/historical-equipment-display-name";

type Sources = Record<string, string>;

const SOURCES: Sources = {
  [HELPER]: readSource(HELPER),
  [DASHBOARD]: readSource(DASHBOARD),
  [SWING_DETAIL]: readSource(SWING_DETAIL),
  [TELEMETRY]: readSource(TELEMETRY),
  [ANALYZE_PAGE]: readSource(ANALYZE_PAGE),
  [ANALYSIS_REPORT]: readSource(ANALYSIS_REPORT),
  [ADMIN_VIDEOS]: readSource(ADMIN_VIDEOS),
  [COACH_REVIEWS]: readSource(COACH_REVIEWS),
  [ANALYZE_API]: readSource(ANALYZE_API),
};

// ─── Snapshot fixtures ────────────────────────────────────────────────────────
//
// Shaped exactly as public.apply_swing_analysis_equipment_snapshot() builds
// them. Canonical names are deliberately different from the entered names so
// precedence is observable rather than assumed.

type Snapshot = Record<string, unknown>;

function v1(overrides: Snapshot = {}): Snapshot {
  return {
    schema_version: 1,
    captured_at: "2026-01-01T00:00:00.000Z",
    equipment_id: "11111111-1111-4111-8111-111111111111",
    club_type: "Iron",
    manufacturer: { id: "m-1", canonical_name: "Ping Golf", slug: "ping-golf" },
    model: { id: "mo-1", canonical_name: "G440 Max", slug: "g440-max", model_year: 2024 },
    entered_brand: "PING",
    entered_model: "G440",
    custom_club: false,
    custom_brand: null,
    custom_model: null,
    shaft_flex: "Stiff",
    shaft_weight_grams: 100,
    loft_deg: 30,
    ...overrides,
  };
}

function v2(overrides: Snapshot = {}): Snapshot {
  return { ...v1(), schema_version: 2, club_designation: null, ...overrides };
}

// ============================================================================
// 1-4. V1 identity
// ============================================================================

describe("EQ5F-A helper — V1 snapshots", () => {
  it("names the club from the entered brand and model", () => {
    expect(getHistoricalEquipmentDisplayName(v1())).toBe("PING G440");
  });

  it("falls back to the frozen canonical identity when nothing was entered", () => {
    expect(
      getHistoricalEquipmentDisplayName(v1({ entered_brand: null, entered_model: null })),
    ).toBe("Ping Golf G440 Max");
  });

  it("prefers the golfer's own words for a custom club", () => {
    expect(
      getHistoricalEquipmentDisplayName(
        v1({ custom_club: true, custom_brand: "Grandad's", custom_model: "Blade" }),
      ),
    ).toBe("Grandad's Blade");
  });

  it("never prefixes a designation, even if one somehow sits on the row", () => {
    const name = getHistoricalEquipmentDisplayName(v1({ club_designation: "7I" }));
    expect(name).toBe("PING G440");
    expect(name).not.toContain(CLUB_DISPLAY_NAME_SEPARATOR);
  });
});

// ============================================================================
// 5-11. V2 identity and designation
// ============================================================================

describe("EQ5F-A helper — V2 snapshots", () => {
  it("names the club from the entered brand and model", () => {
    expect(getHistoricalEquipmentDisplayName(v2())).toBe("PING G440");
  });

  it("falls back to the frozen canonical identity when nothing was entered", () => {
    expect(
      getHistoricalEquipmentDisplayName(v2({ entered_brand: null, entered_model: null })),
    ).toBe("Ping Golf G440 Max");
  });

  it("prefers the golfer's own words for a custom club", () => {
    expect(
      getHistoricalEquipmentDisplayName(
        v2({ custom_club: true, custom_brand: "Grandad's", custom_model: "Blade" }),
      ),
    ).toBe("Grandad's Blade");
  });

  it("prefixes a stored iron designation", () => {
    expect(getHistoricalEquipmentDisplayName(v2({ club_designation: "7I" }))).toBe(
      `7I${CLUB_DISPLAY_NAME_SEPARATOR}PING G440`,
    );
  });

  it.each([
    ["Wood", "3W"],
    ["Hybrid", "4H"],
    ["Wedge", "SW"],
    ["Iron", "PW"],
    ["Wedge", "PW"],
  ])("prefixes a stored %s designation %s", (clubType, designation) => {
    expect(
      getHistoricalEquipmentDisplayName(v2({ club_type: clubType, club_designation: designation })),
    ).toBe(`${designation}${CLUB_DISPLAY_NAME_SEPARATOR}PING G440`);
  });

  it("invents no designation for a Putter", () => {
    const name = getHistoricalEquipmentDisplayName(
      v2({ club_type: "Putter", club_designation: "7I" }),
    );
    expect(name).toBe("PING G440");
    expect(name).not.toContain(CLUB_DISPLAY_NAME_SEPARATOR);
  });

  it("invents no designation for a Driver", () => {
    const name = getHistoricalEquipmentDisplayName(
      v2({ club_type: "Driver", club_designation: "3W" }),
    );
    expect(name).toBe("PING G440");
    expect(name).not.toContain(CLUB_DISPLAY_NAME_SEPARATOR);
  });

  it("drops a designation that is illegal for the club type rather than repairing it", () => {
    expect(getHistoricalEquipmentDisplayName(v2({ club_type: "Iron", club_designation: "3W" }))).toBe(
      "PING G440",
    );
    expect(getHistoricalEquipmentDisplayName(v2({ club_designation: "" }))).toBe("PING G440");
    expect(getHistoricalEquipmentDisplayName(v2({ club_designation: 7 }))).toBe("PING G440");
  });
});

// ============================================================================
// 12-18. Malformed input, whitespace and precedence
// ============================================================================

describe("EQ5F-A helper — unusable input fails safely to null", () => {
  it.each([
    ["missing version", v1({ schema_version: undefined })],
    ["version 0", v1({ schema_version: 0 })],
    ["version 3", v1({ schema_version: 3 })],
    ["string version", v1({ schema_version: "1" })],
    ["null version", v1({ schema_version: null })],
  ])("rejects an unrecognised schema version: %s", (_label, snapshot) => {
    expect(getHistoricalEquipmentDisplayName(snapshot)).toBeNull();
  });

  it.each([
    ["unknown club type", "Chipper"],
    ["wrong case", "iron"],
    ["empty", ""],
    ["numeric", 7],
    ["null", null],
    ["missing", undefined],
  ])("returns null rather than throwing for a malformed club_type: %s", (_label, clubType) => {
    expect(() => getHistoricalEquipmentDisplayName(v2({ club_type: clubType }))).not.toThrow();
    expect(getHistoricalEquipmentDisplayName(v2({ club_type: clubType }))).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "PING G440"],
    ["a number", 7],
    ["an array", [v1()]],
  ])("returns null for a non-snapshot value: %s", (_label, value) => {
    expect(getHistoricalEquipmentDisplayName(value)).toBeNull();
  });

  it("returns null when a valid snapshot carries no identity text at all", () => {
    // The club type is known and legal here. Returning "Iron" would always
    // succeed and would suppress a legacy video club value that may name the
    // real club, so the helper reports no identity instead.
    const nameless = v2({
      entered_brand: null,
      entered_model: null,
      manufacturer: null,
      model: null,
      custom_club: false,
      custom_brand: null,
      custom_model: null,
    });
    expect(getHistoricalEquipmentDisplayName(nameless)).toBeNull();
  });

  it("treats whitespace-only text as absent and falls through", () => {
    expect(
      getHistoricalEquipmentDisplayName(v1({ entered_brand: "   ", entered_model: "\t\n" })),
    ).toBe("Ping Golf G440 Max");
  });

  it("trims surviving text without otherwise normalising it", () => {
    expect(
      getHistoricalEquipmentDisplayName(v1({ entered_brand: "  ping  ", entered_model: " g440 " })),
    ).toBe("ping g440");
  });

  it("uses whichever entered piece survives", () => {
    expect(getHistoricalEquipmentDisplayName(v1({ entered_model: null }))).toBe("PING");
    expect(getHistoricalEquipmentDisplayName(v1({ entered_brand: null }))).toBe("G440");
  });

  it("uses whichever custom piece survives", () => {
    expect(
      getHistoricalEquipmentDisplayName(v1({ custom_club: true, custom_brand: "Grandad's" })),
    ).toBe("Grandad's");
    expect(
      getHistoricalEquipmentDisplayName(v1({ custom_club: true, custom_model: "Blade" })),
    ).toBe("Blade");
  });

  it("falls through to the entered identity when a custom club has no custom text", () => {
    expect(
      getHistoricalEquipmentDisplayName(
        v1({ custom_club: true, custom_brand: null, custom_model: "   " }),
      ),
    ).toBe("PING G440");
  });

  it("prefers custom text over entered text when the row is custom", () => {
    expect(
      getHistoricalEquipmentDisplayName(
        v1({ custom_club: true, custom_brand: "Grandad's", custom_model: "Blade" }),
      ),
    ).not.toBe("PING G440");
  });

  it("prefers entered text over the canonical catalog identity", () => {
    expect(getHistoricalEquipmentDisplayName(v1())).toBe("PING G440");
    expect(getHistoricalEquipmentDisplayName(v1())).not.toBe("Ping Golf G440 Max");
  });

  it("does not mutate the snapshot it was given", () => {
    const snapshot = v2({ club_designation: "7I" });
    const before = JSON.stringify(snapshot);
    getHistoricalEquipmentDisplayName(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

// ============================================================================
// 26. History is independent of anything that can change later
// ============================================================================

describe("EQ5F-A helper — history cannot be rewritten by current state", () => {
  it("names each snapshot from its own frozen evidence", () => {
    // Same saved club id, renamed between the two analyses. Each analysis keeps
    // the identity captured at its own insert; nothing consults the live row.
    const equipment_id = "22222222-2222-4222-8222-222222222222";
    const older = v2({ equipment_id, entered_brand: "PING", entered_model: "G425" });
    const newer = v2({ equipment_id, entered_brand: "PING", entered_model: "G440" });
    expect(getHistoricalEquipmentDisplayName(older)).toBe("PING G425");
    expect(getHistoricalEquipmentDisplayName(newer)).toBe("PING G440");
  });

  it("reads no archive, primary or catalog-linkage state", () => {
    const archived = v2({ is_archived: true, is_primary: false, equipment_model_id: null });
    expect(getHistoricalEquipmentDisplayName(archived)).toBe("PING G440");
  });
});

// ============================================================================
// 27-30. Consensus across the analyses of one video
// ============================================================================

describe("EQ5F-A helper — consensus", () => {
  it("returns null when no snapshot can name a club", () => {
    expect(getHistoricalEquipmentDisplayNameConsensus([])).toBeNull();
    expect(getHistoricalEquipmentDisplayNameConsensus([null, undefined, {}])).toBeNull();
    expect(getHistoricalEquipmentDisplayNameConsensus([v1({ schema_version: 9 })])).toBeNull();
  });

  it("returns the single usable identity", () => {
    expect(getHistoricalEquipmentDisplayNameConsensus([null, v1(), {}])).toBe("PING G440");
  });

  it("returns the identity every usable snapshot agrees on", () => {
    expect(
      getHistoricalEquipmentDisplayNameConsensus([v1(), v2(), v1({ captured_at: "later" })]),
    ).toBe("PING G440");
  });

  it("reports no consensus when usable identities disagree", () => {
    const other = v1({ entered_brand: "TaylorMade", entered_model: "Qi10" });
    expect(getHistoricalEquipmentDisplayNameConsensus([v1(), other])).toBeNull();
    expect(getHistoricalEquipmentDisplayNameConsensus([other, v1()])).toBeNull();
  });

  it("treats a designation difference as disagreement rather than choosing one", () => {
    expect(
      getHistoricalEquipmentDisplayNameConsensus([
        v2({ club_designation: "7I" }),
        v2({ club_designation: "8I" }),
      ]),
    ).toBeNull();
  });
});

// ============================================================================
// 21-25. The helper is pure
// ============================================================================

/** Module specifiers the helper imports, anchored to real import statements. */
function importedModules(code: string): string[] {
  const sideEffect = Array.from(code.matchAll(/^import\s+["']([^"']+)["']/gm)).map((m) => m[1]);
  const withClause = Array.from(code.matchAll(/^import\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)).map(
    (m) => m[1],
  );
  return [...sideEffect, ...withClause];
}

const ALLOWED_HELPER_MODULES = [
  "@/types/database",
  "@/lib/equipment/club-designation-options",
  "@/lib/equipment/club-display-name",
];

describe("EQ5F-A helper — purity", () => {
  const code = stripComments(SOURCES[HELPER]);

  it("imports only the approved modules", () => {
    expect([...importedModules(code)].sort()).toEqual([...ALLOWED_HELPER_MODULES].sort());
  });

  it("reaches no database, client or network", () => {
    for (const token of [
      "supabase",
      "createClient",
      "fetch(",
      "from(",
      ".select(",
      "user_equipment",
      "equipment_models",
      "equipment_manufacturers",
      "club_id",
      "next/",
      "react",
      "process.env",
    ]) {
      expect(code.toLowerCase(), `the helper must not reach ${token}`).not.toContain(
        token.toLowerCase(),
      );
    }
  });

  it("is deterministic — no clock and no randomness", () => {
    expect(/\bDate\b/.test(code), "the helper must not read a clock").toBe(false);
    expect(/Math\.random/.test(code), "the helper must not use randomness").toBe(false);
  });

  it("delegates designation compatibility instead of restating the vocabulary", () => {
    expect(code).toContain("isClubDesignationValidFor");
    for (const token of ['"7I"', '"3W"', '"SW"', '"PW"']) {
      expect(code, `the helper must not transcribe the designation vocabulary (${token})`).not.toContain(
        token,
      );
    }
  });

  it("does not borrow the live-bag naming authority", () => {
    expect(code).not.toContain("getClubDisplayName(");
  });

  it("emits no placeholder word of its own", () => {
    expect(code).not.toContain('"Unknown"');
    expect(code).not.toContain('"Swing"');
  });
});

// ============================================================================
// 19-20 + consumer contract. Who uses the authority, and in what order
// ============================================================================

const DASHBOARD_EXPRESSION =
  'getHistoricalEquipmentDisplayName(swing.equipment_snapshot) ?? swing.swing_video?.club ?? "Unknown"';
const SWING_DETAIL_RESOLUTION =
  "const historicalClubName = getHistoricalEquipmentDisplayName(swing.equipment_snapshot);";
const SWING_DETAIL_EXPRESSION =
  'historicalClubName ?? swing.swing_video?.club ?? swing.swing_video?.title ?? "Swing"';
const TELEMETRY_EXPRESSION =
  "getHistoricalEquipmentDisplayName(r.equipment_snapshot) ?? video?.club ?? null";
const ANALYZE_EXPRESSION =
  "getHistoricalEquipmentDisplayName(row.equipment_snapshot) ?? videoRow?.club ?? null";
const ADMIN_EXPRESSION =
  'getHistoricalEquipmentDisplayNameConsensus(analysisSnapshotsOf(v)) ?? v.club ?? "—"';
const COACH_EXPRESSION =
  'f.swing_video?.club ?? f.swing_video?.original_filename ?? "Swing"';

interface Guard {
  id: string;
  holds: (sources: Sources) => boolean;
}

const GUARDS: readonly Guard[] = [
  {
    id: "the Progress Hub reads the snapshot before the legacy club, twice",
    holds: (s) =>
      s[DASHBOARD].includes(HELPER_MODULE) &&
      countOccurrences(s[DASHBOARD], DASHBOARD_EXPRESSION) === 2,
  },
  {
    id: "the canonical swing detail resolves the snapshot and leads its header with it",
    holds: (s) =>
      s[SWING_DETAIL].includes(HELPER_MODULE) &&
      s[SWING_DETAIL].includes(SWING_DETAIL_RESOLUTION) &&
      s[SWING_DETAIL].includes(SWING_DETAIL_EXPRESSION),
  },
  {
    id: "Telemetry selects the snapshot and prefers it over the legacy club",
    holds: (s) =>
      s[TELEMETRY].includes(HELPER_MODULE) &&
      s[TELEMETRY].includes("equipment_snapshot,") &&
      s[TELEMETRY].includes(TELEMETRY_EXPRESSION),
  },
  {
    id: "Telemetry keeps its full-swing family filter",
    holds: (s) =>
      s[TELEMETRY].includes(
        '(r) => r.analysis_family === null || r.analysis_family === "full_swing",',
      ),
  },
  {
    id: "the legacy analyze page selects the snapshot and resolves the name on the server",
    holds: (s) =>
      s[ANALYZE_PAGE].includes(HELPER_MODULE) &&
      s[ANALYZE_PAGE].includes("equipment_snapshot,") &&
      s[ANALYZE_PAGE].includes(ANALYZE_EXPRESSION) &&
      s[ANALYZE_PAGE].includes("clubDisplayName={clubDisplayName}"),
  },
  {
    id: "the legacy analyze page keeps its putting redirect",
    holds: (s) => s[ANALYZE_PAGE].includes("redirect(`/swings/${row.id}`);"),
  },
  {
    id: "AnalysisReport renders the resolved prop and parses no snapshot itself",
    holds: (s) =>
      s[ANALYSIS_REPORT].includes('clubDisplayName ?? "Unknown"') &&
      !s[ANALYSIS_REPORT].includes(HELPER_MODULE) &&
      !s[ANALYSIS_REPORT].includes("equipment_snapshot"),
  },
  {
    id: "the admin video list resolves by consensus, never by picking one analysis",
    holds: (s) =>
      s[ADMIN_VIDEOS].includes(HELPER_MODULE) &&
      s[ADMIN_VIDEOS].includes("analyses:swing_analysis(equipment_snapshot)") &&
      s[ADMIN_VIDEOS].includes(ADMIN_EXPRESSION) &&
      !/analyses\s*\[\s*0\s*\]/.test(s[ADMIN_VIDEOS]),
  },
  {
    id: "Coach Reviews is untouched by this slice",
    holds: (s) =>
      !s[COACH_REVIEWS].includes(HELPER_MODULE) &&
      !s[COACH_REVIEWS].includes("equipment_snapshot") &&
      s[COACH_REVIEWS].includes(COACH_EXPRESSION),
  },
  {
    id: "the analyze-swing route is untouched by this slice",
    holds: (s) =>
      !s[ANALYZE_API].includes(HELPER_MODULE) &&
      s[ANALYZE_API].includes('"Club: unknown"'),
  },
  {
    id: "no consumer reconstructs identity from the live bag or the catalog",
    holds: (s) =>
      [DASHBOARD, SWING_DETAIL, TELEMETRY, ANALYZE_PAGE, ANALYSIS_REPORT, ADMIN_VIDEOS].every(
        (file) => {
          const code = stripComments(s[file]);
          return (
            !code.includes('from("user_equipment")') &&
            !code.includes('from("equipment_models")') &&
            !code.includes('from("equipment_manufacturers")') &&
            !code.includes("getClubDisplayName(")
          );
        },
      ),
  },
];

describe("EQ5F-A consumer contract", () => {
  it.each(GUARDS)("$id", ({ holds }) => {
    expect(holds(SOURCES)).toBe(true);
  });

  it("a usable snapshot identity is read before any legacy club value", () => {
    // The precedence is the product contract: where both exist, the immutable
    // snapshot wins. Each expression places the helper call to the left of the
    // legacy value's `??`, which is what makes that true at runtime.
    for (const [file, expression, legacy] of [
      [DASHBOARD, DASHBOARD_EXPRESSION, "swing.swing_video?.club"],
      [TELEMETRY, TELEMETRY_EXPRESSION, "video?.club"],
      [ANALYZE_PAGE, ANALYZE_EXPRESSION, "videoRow?.club"],
      [ADMIN_VIDEOS, ADMIN_EXPRESSION, "v.club"],
    ] as const) {
      const at = SOURCES[file].indexOf(expression);
      expect(at, `${file}: the snapshot-first expression is missing`).toBeGreaterThanOrEqual(0);
      expect(
        expression.indexOf("getHistoricalEquipmentDisplayName"),
        `${file}: the snapshot must be consulted before ${legacy}`,
      ).toBeLessThan(expression.indexOf(legacy));
    }
  });

  it("every legacy fallback and final floor survives", () => {
    expect(SOURCES[DASHBOARD]).toContain('?? "Unknown"');
    expect(SOURCES[SWING_DETAIL]).toContain('?? "Swing"');
    expect(SOURCES[TELEMETRY]).toContain('log.club ?? log.filename ?? "Untitled Swing"');
    expect(SOURCES[ANALYSIS_REPORT]).toContain('?? "Unknown"');
    expect(SOURCES[ADMIN_VIDEOS]).toContain('?? "—"');
  });
});

// ============================================================================
// Non-vacuity — every consumer guard is proved able to fail
// ============================================================================

interface Regression {
  name: string;
  apply: (sources: Sources) => Sources;
  breaks: readonly string[];
}

function withFile(sources: Sources, file: string, content: string): Sources {
  return { ...sources, [file]: content };
}

const REGRESSIONS: readonly Regression[] = [
  {
    name: "the Progress Hub drops back to the legacy club alone",
    apply: (s) =>
      withFile(
        s,
        DASHBOARD,
        s[DASHBOARD].split(DASHBOARD_EXPRESSION).join('swing.swing_video?.club ?? "Unknown"'),
      ),
    breaks: ["the Progress Hub reads the snapshot before the legacy club, twice"],
  },
  {
    name: "the swing detail header stops leading with the snapshot",
    apply: (s) =>
      withFile(
        s,
        SWING_DETAIL,
        s[SWING_DETAIL].replace(SWING_DETAIL_EXPRESSION, 'swing.swing_video?.club ?? "Swing"'),
      ),
    breaks: ["the canonical swing detail resolves the snapshot and leads its header with it"],
  },
  {
    name: "Telemetry stops selecting the snapshot",
    apply: (s) =>
      withFile(
        s,
        TELEMETRY,
        s[TELEMETRY].replace(
          "analysis_family, equipment_snapshot,",
          "analysis_family,",
        ),
      ),
    breaks: ["Telemetry selects the snapshot and prefers it over the legacy club"],
  },
  {
    name: "Telemetry loses its full-swing family filter",
    apply: (s) =>
      withFile(
        s,
        TELEMETRY,
        s[TELEMETRY].replace(
          '(r) => r.analysis_family === null || r.analysis_family === "full_swing",',
          "(r) => r !== null,",
        ),
      ),
    breaks: ["Telemetry keeps its full-swing family filter"],
  },
  {
    name: "the legacy analyze page stops passing the resolved name down",
    apply: (s) =>
      withFile(s, ANALYZE_PAGE, s[ANALYZE_PAGE].replace("clubDisplayName={clubDisplayName}", "")),
    breaks: ["the legacy analyze page selects the snapshot and resolves the name on the server"],
  },
  {
    name: "the legacy analyze page loses its putting redirect",
    apply: (s) =>
      withFile(s, ANALYZE_PAGE, s[ANALYZE_PAGE].replace("redirect(`/swings/${row.id}`);", "")),
    breaks: ["the legacy analyze page keeps its putting redirect"],
  },
  {
    name: "AnalysisReport starts parsing the snapshot itself",
    apply: (s) =>
      withFile(
        s,
        ANALYSIS_REPORT,
        `import { getHistoricalEquipmentDisplayName } from "${HELPER_MODULE}";\n${s[ANALYSIS_REPORT]}`,
      ),
    breaks: ["AnalysisReport renders the resolved prop and parses no snapshot itself"],
  },
  {
    name: "the admin list picks the first analysis instead of a consensus",
    apply: (s) =>
      withFile(
        s,
        ADMIN_VIDEOS,
        s[ADMIN_VIDEOS].replace(
          ADMIN_EXPRESSION,
          'getHistoricalEquipmentDisplayName(analyses[0]) ?? v.club ?? "—"',
        ),
      ),
    breaks: ["the admin video list resolves by consensus, never by picking one analysis"],
  },
  {
    name: "Coach Reviews is dragged into this slice",
    apply: (s) =>
      withFile(
        s,
        COACH_REVIEWS,
        `import { getHistoricalEquipmentDisplayName } from "${HELPER_MODULE}";\n${s[COACH_REVIEWS]}`,
      ),
    breaks: ["Coach Reviews is untouched by this slice"],
  },
  {
    name: "the analyze-swing route is dragged into this slice",
    apply: (s) =>
      withFile(
        s,
        ANALYZE_API,
        `import { getHistoricalEquipmentDisplayName } from "${HELPER_MODULE}";\n${s[ANALYZE_API]}`,
      ),
    breaks: ["the analyze-swing route is untouched by this slice"],
  },
  {
    name: "a consumer reconstructs the name from the live bag",
    apply: (s) =>
      withFile(
        s,
        DASHBOARD,
        `${s[DASHBOARD]}\nconst live = getClubDisplayName(currentClub);\n`,
      ),
    breaks: ["no consumer reconstructs identity from the live bag or the catalog"],
  },
];

describe("EQ5F-A guards are non-vacuous", () => {
  it("every guard holds against the real sources", () => {
    const failing = GUARDS.filter((guard) => !guard.holds(SOURCES)).map((guard) => guard.id);
    expect(failing, "the committed sources must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS)("$name is caught", ({ apply, breaks }) => {
    const broken = apply(SOURCES);
    const changed = Object.keys(SOURCES).some((file) => broken[file] !== SOURCES[file]);
    expect(changed, "the mutation changed nothing").toBe(true);
    for (const id of breaks) {
      const guard = GUARDS.find((candidate) => candidate.id === id);
      expect(guard, `unknown guard: ${id}`).toBeDefined();
      expect(guard?.holds(broken), `guard did not fire: ${id}`).toBe(false);
    }
  });

  it("every guard is exercised by at least one regression", () => {
    const covered = new Set(REGRESSIONS.flatMap((regression) => regression.breaks));
    const uncovered = GUARDS.map((guard) => guard.id).filter((id) => !covered.has(id));
    expect(uncovered).toEqual([]);
  });
});
