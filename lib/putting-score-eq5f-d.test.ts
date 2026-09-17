import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUTTING_SCORE_BASIS,
  PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION,
  PUTTING_SCORE_TOTAL_SECTIONS,
  PUTTING_SCORE_VERSION,
  computePuttingScoreV1,
} from "./putting-score-eq5f-d";
import { PUTTING_SECTIONS } from "./putting-analysis-contract";
import { PUTTING_SIGNAL_CLASSIFICATION_VERSION } from "./putting-signal-classification-eq5e-a";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5F-D — the versioned putting score
// ============================================================================
//
// Two kinds of proof live here, and they are deliberately not interchangeable.
//
// The arithmetic, the fail-closed behaviour and the immutability of the result
// are proved by running the real function. A source contract cannot establish
// what a number is, and a suite that matched text instead of executing would
// pass against an implementation that returned the wrong score for every stroke
// it was ever given.
//
// The architectural boundaries are proved against source text, because that is
// what they are: "this module never reaches a database" is a claim about what
// the file may import, not about any one call. Those guards are replayed
// against deliberately regressed source held in memory, so a guard that would
// also pass on a violating file is caught here rather than trusted.
//
// What the suite does NOT establish: that any production row scores a
// particular way, that a consumer renders the value, or that the value has been
// persisted anywhere. Nothing is persisted in this slice, and no consumer reads
// this module yet.

const MODULE_PATH = "lib/putting-score-eq5f-d.ts";

/** Reads the module under test, normalized to LF so checks don't depend on
 *  whether this checkout has CRLF or LF line endings. */
function readModuleSource(): string {
  return readFileSync(path.join(repoRoot, MODULE_PATH), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code.
 *
 * Every ban below is about what the module *does*. The file explains most of
 * these rules in prose — it names the full-swing column it refuses to touch and
 * the alias it refuses to export — and a suite that failed on those sentences
 * would pressure the next author into deleting the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

function countLiteral(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

/** Every `import ... from "..."` statement, with whether it was type-only. */
function importsOf(source: string): { typeOnly: boolean; specifier: string }[] {
  const pattern = /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm;
  const found: { typeOnly: boolean; specifier: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.push({ typeOnly: match[1] !== undefined, specifier: match[2] });
  }
  return found;
}

/** The v1 point table, isolated so a ban on one token inside it cannot be
 *  satisfied or broken by unrelated text elsewhere in the file. */
function pointTable(source: string): string {
  const code = stripComments(source);
  const start = code.indexOf("const SECTION_POINTS");
  if (start < 0) return "";
  const end = code.indexOf("})", start);
  if (end < 0) return "";
  return code.slice(start, end + 2);
}

// ── Canonical vocabulary, transcribed independently ─────────────────────────
//
// Written out here rather than imported from the module under test, so a
// regression that silently drops or renames a section is caught rather than
// self-confirmed. Reconciled against the canonical list below.

const SECTION_KEYS = [
  "setup_alignment",
  "stroke_path",
  "face_at_impact",
  "tempo_rhythm",
  "stroke_symmetry",
  "stability",
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

const CLASSIFICATIONS = [
  "strength",
  "acceptable",
  "needs_improvement",
  "insufficient_evidence",
] as const;

type Classification = (typeof CLASSIFICATIONS)[number];

/** Builds a valid classification envelope. */
function envelope(
  per: Readonly<Partial<Record<SectionKey, Classification>>>,
  options: { readonly assessment?: (key: SectionKey) => string; readonly reverse?: boolean } = {},
): Record<string, unknown> {
  const keys = options.reverse ? [...SECTION_KEYS].reverse() : [...SECTION_KEYS];
  const sections: Record<string, unknown> = {};
  for (const key of keys) {
    sections[key] = {
      assessment: options.assessment ? options.assessment(key) : "recorded_token",
      classification: per[key] ?? "insufficient_evidence",
    };
  }
  return { classification_version: 1, sections };
}

/** Every section set to one classification. */
function uniform(classification: Classification): Record<string, unknown> {
  const per: Partial<Record<SectionKey, Classification>> = {};
  for (const key of SECTION_KEYS) per[key] = classification;
  return envelope(per);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ============================================================================
// A. Version / envelope
// ============================================================================

describe("EQ5F-D — version and result envelope", () => {
  it("the module under test exists", () => {
    expect(existsSync(path.join(repoRoot, MODULE_PATH)), `missing file: ${MODULE_PATH}`).toBe(true);
  });

  it("exposes an independent score version of exactly 1", () => {
    expect(PUTTING_SCORE_VERSION).toBe(1);
  });

  it("the score version is its own constant, not an alias of the classification version", () => {
    // Both are 1 today, which is exactly why equality proves nothing. What must
    // hold is that the module never names the upstream constant, so the two can
    // move apart later without one dragging the other.
    expect(PUTTING_SIGNAL_CLASSIFICATION_VERSION).toBe(1);
    expect(stripComments(readModuleSource())).not.toContain("PUTTING_SIGNAL_CLASSIFICATION_VERSION");
  });

  it("declares the qualitative basis and the accepted source version", () => {
    expect(PUTTING_SCORE_BASIS).toBe("qualitative_classification_index");
    expect(PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION).toBe(1);
    expect(PUTTING_SCORE_TOTAL_SECTIONS).toBe(6);
  });

  it("exports the version-specific scorer taking exactly one argument", () => {
    expect(typeof computePuttingScoreV1).toBe("function");
    // One parameter: there is no second slot a narrative could arrive through.
    expect(computePuttingScoreV1.length).toBe(1);
  });

  it("returns the full envelope with the version, basis and source version carried", () => {
    const result = computePuttingScoreV1(uniform("strength"));
    expect(result).not.toBeNull();
    expect(result).toEqual({
      score_version: 1,
      basis: "qualitative_classification_index",
      source_classification_version: 1,
      score: 100,
      coverage: { scorable_sections: 6, total_sections: 6, percent: 100 },
    });
  });

  it("freezes the result and its coverage", () => {
    const result = computePuttingScoreV1(uniform("acceptable"))!;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.coverage)).toBe(true);
  });

  it("carries no identity, prose, measurement or timestamp in the result", () => {
    const result = computePuttingScoreV1(uniform("strength"))!;
    expect(Object.keys(result).sort()).toEqual([
      "basis",
      "coverage",
      "score",
      "score_version",
      "source_classification_version",
    ]);
    expect(Object.keys(result.coverage).sort()).toEqual([
      "percent",
      "scorable_sections",
      "total_sections",
    ]);
  });

  it("the transcribed section vocabulary matches the canonical one", () => {
    expect([...SECTION_KEYS].sort()).toEqual([...PUTTING_SECTIONS].sort());
    expect(SECTION_KEYS.length).toBe(PUTTING_SCORE_TOTAL_SECTIONS);
  });
});

// ============================================================================
// B. Frozen arithmetic
// ============================================================================

describe("EQ5F-D — the frozen v1 arithmetic", () => {
  const cases: {
    name: string;
    input: Record<string, unknown>;
    score: number | null;
    scorable: number;
    percent: number;
  }[] = [
    { name: "six strengths", input: uniform("strength"), score: 100, scorable: 6, percent: 100 },
    { name: "six acceptable", input: uniform("acceptable"), score: 50, scorable: 6, percent: 100 },
    {
      name: "six needs_improvement",
      input: uniform("needs_improvement"),
      score: 0,
      scorable: 6,
      percent: 100,
    },
    {
      name: "one strength and five insufficient",
      input: envelope({ setup_alignment: "strength" }),
      score: 100,
      scorable: 1,
      percent: 17,
    },
    {
      name: "all six insufficient",
      input: uniform("insufficient_evidence"),
      score: null,
      scorable: 0,
      percent: 0,
    },
    {
      name: "three strength and three acceptable",
      input: envelope({
        setup_alignment: "strength",
        stroke_path: "strength",
        face_at_impact: "strength",
        tempo_rhythm: "acceptable",
        stroke_symmetry: "acceptable",
        stability: "acceptable",
      }),
      score: 75,
      scorable: 6,
      percent: 100,
    },
    {
      name: "one strength, one acceptable and four insufficient",
      input: envelope({ setup_alignment: "strength", stroke_path: "acceptable" }),
      score: 75,
      scorable: 2,
      percent: 33,
    },
  ];

  it.each(cases)("$name", ({ input, score, scorable, percent }) => {
    const result = computePuttingScoreV1(input);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(score);
    expect(result!.coverage.scorable_sections).toBe(scorable);
    expect(result!.coverage.total_sections).toBe(6);
    expect(result!.coverage.percent).toBe(percent);
  });

  it("never produces a score outside 0-100", () => {
    for (const a of CLASSIFICATIONS) {
      for (const b of CLASSIFICATIONS) {
        const result = computePuttingScoreV1(
          envelope({
            setup_alignment: a,
            stroke_path: b,
            face_at_impact: a,
            tempo_rhythm: b,
            stroke_symmetry: a,
            stability: b,
          }),
        )!;
        if (result.score === null) continue;
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }
    }
  });
});

// ============================================================================
// C. Equal weight and order independence
// ============================================================================

describe("EQ5F-D — every section carries equal weight", () => {
  it.each([...CLASSIFICATIONS])(
    "a lone %s section contributes identically whichever section it is",
    (classification) => {
      const results = SECTION_KEYS.map((key) =>
        computePuttingScoreV1(envelope({ [key]: classification } as Partial<Record<SectionKey, Classification>>)),
      );
      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
    },
  );

  it("no section receives a hidden multiplier", () => {
    // Swapping which section holds the strength and which holds the fault must
    // not move the score; if any section were weighted, one of these would.
    const first = computePuttingScoreV1(
      envelope({ setup_alignment: "strength", stability: "needs_improvement" }),
    )!;
    const second = computePuttingScoreV1(
      envelope({ stability: "strength", setup_alignment: "needs_improvement" }),
    )!;
    expect(first).toEqual(second);
    expect(first.score).toBe(50);
  });

  it("property insertion order does not change the result", () => {
    const forward = computePuttingScoreV1(
      envelope({ setup_alignment: "strength", stroke_path: "acceptable" }),
    );
    const reversed = computePuttingScoreV1(
      envelope({ setup_alignment: "strength", stroke_path: "acceptable" }, { reverse: true }),
    );
    expect(reversed).toEqual(forward);
  });
});

// ============================================================================
// D. Insufficient evidence
// ============================================================================

describe("EQ5F-D — insufficient evidence is excluded, never penalised", () => {
  it("a single strength scores 100 whether or not the rest was readable", () => {
    // The decisive case. If insufficient_evidence were scored as zero points it
    // would be 17 here, not 100.
    expect(computePuttingScoreV1(envelope({ setup_alignment: "strength" }))!.score).toBe(100);
    expect(computePuttingScoreV1(uniform("strength"))!.score).toBe(100);
  });

  it("a single fault scores 0 rather than being diluted by unreadable sections", () => {
    expect(computePuttingScoreV1(envelope({ stability: "needs_improvement" }))!.score).toBe(0);
    expect(computePuttingScoreV1(uniform("needs_improvement"))!.score).toBe(0);
  });

  it("insufficient sections change coverage and nothing else", () => {
    const narrow = computePuttingScoreV1(
      envelope({ setup_alignment: "strength", stroke_path: "acceptable" }),
    )!;
    const wide = computePuttingScoreV1(
      envelope({
        setup_alignment: "strength",
        stroke_path: "acceptable",
        face_at_impact: "strength",
        tempo_rhythm: "acceptable",
      }),
    )!;
    expect(narrow.score).toBe(75);
    expect(wide.score).toBe(75);
    expect(narrow.coverage.scorable_sections).toBe(2);
    expect(wide.coverage.scorable_sections).toBe(4);
    expect(narrow.coverage.percent).toBe(33);
    expect(wide.coverage.percent).toBe(67);
  });

  it("zero scorable sections yields a null score, never a zero", () => {
    const result = computePuttingScoreV1(uniform("insufficient_evidence"))!;
    expect(result.score).toBeNull();
    expect(result.coverage.scorable_sections).toBe(0);
    expect(result.coverage.percent).toBe(0);
  });
});

// ============================================================================
// E. No prose or assessment-text dependency
// ============================================================================

describe("EQ5F-D — the narrative cannot move the number", () => {
  it("radically different assessment strings produce an identical result", () => {
    const per = { setup_alignment: "strength", stroke_path: "needs_improvement" } as const;
    const plain = computePuttingScoreV1(envelope(per, { assessment: () => "sound" }));
    const loud = computePuttingScoreV1(
      envelope(per, {
        assessment: (key) =>
          `${key}: the stroke was measured at two degrees open with a 3:1 tempo ratio — excellent`,
      }),
    );
    expect(loud).toEqual(plain);
    expect(loud!.score).toBe(50);
  });

  it("an empty assessment string is accepted and still does not move the number", () => {
    const withText = computePuttingScoreV1(envelope({ stability: "acceptable" }, { assessment: () => "x" }));
    const withoutText = computePuttingScoreV1(envelope({ stability: "acceptable" }, { assessment: () => "" }));
    expect(withoutText).toEqual(withText);
  });
});

// ============================================================================
// F. Strict fail-closed runtime input
// ============================================================================

describe("EQ5F-D — an incompatible envelope returns null and never throws", () => {
  const valid = () => envelope({ setup_alignment: "strength" });

  const withSections = (mutate: (sections: Record<string, unknown>) => void): unknown => {
    const built = valid();
    mutate(built.sections as Record<string, unknown>);
    return built;
  };

  const rejected: { name: string; input: unknown }[] = [
    { name: "null", input: null },
    { name: "undefined", input: undefined },
    { name: "a string", input: "strength" },
    { name: "a number", input: 100 },
    { name: "an array", input: [] },
    { name: "an empty object", input: {} },
    {
      name: "a wrong classification version",
      input: { ...valid(), classification_version: 2 },
    },
    {
      name: "a string classification version",
      input: { ...valid(), classification_version: "1" },
    },
    { name: "missing sections", input: { classification_version: 1 } },
    { name: "null sections", input: { classification_version: 1, sections: null } },
    { name: "array sections", input: { classification_version: 1, sections: [] } },
    {
      name: "an extra top-level field",
      input: { ...valid(), extra: true },
    },
    {
      name: "a top-level score field",
      input: { ...valid(), score: 100 },
    },
    {
      name: "a missing canonical section",
      input: withSections((sections) => {
        delete sections.stability;
      }),
    },
    {
      name: "an extra section",
      input: withSections((sections) => {
        sections.green_read = { assessment: "unclear", classification: "strength" };
      }),
    },
    {
      name: "a non-object section entry",
      input: withSections((sections) => {
        sections.stability = "strength";
      }),
    },
    {
      name: "a null section entry",
      input: withSections((sections) => {
        sections.stability = null;
      }),
    },
    {
      name: "an array section entry",
      input: withSections((sections) => {
        sections.stability = ["strength"];
      }),
    },
    {
      name: "a missing assessment",
      input: withSections((sections) => {
        sections.stability = { classification: "strength" };
      }),
    },
    {
      name: "a non-string assessment",
      input: withSections((sections) => {
        sections.stability = { assessment: 12, classification: "strength" };
      }),
    },
    {
      name: "a missing classification",
      input: withSections((sections) => {
        sections.stability = { assessment: "stable" };
      }),
    },
    {
      name: "an unknown classification",
      input: withSections((sections) => {
        sections.stability = { assessment: "stable", classification: "excellent" };
      }),
    },
    {
      name: "a non-string classification",
      input: withSections((sections) => {
        sections.stability = { assessment: "stable", classification: 2 };
      }),
    },
    {
      name: "an extra section-entry field",
      input: withSections((sections) => {
        sections.stability = {
          assessment: "stable",
          classification: "strength",
          observation: "the head stayed still",
        };
      }),
    },
  ];

  it.each(rejected)("rejects $name", ({ input }) => {
    let result: unknown;
    expect(() => {
      result = computePuttingScoreV1(input);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("a malformed envelope is refused outright rather than scored as unreadable", () => {
    // The distinction that matters: an honestly unreadable stroke is a valid
    // envelope of insufficient_evidence and yields a result with a null score;
    // a broken payload yields no result at all.
    expect(computePuttingScoreV1(uniform("insufficient_evidence"))).not.toBeNull();
    expect(computePuttingScoreV1({ classification_version: 1 })).toBeNull();
  });
});

// ============================================================================
// G. No input mutation
// ============================================================================

describe("EQ5F-D — the input is read, never written", () => {
  it("scores a deeply frozen envelope without mutating it", () => {
    const input = deepFreeze(envelope({ setup_alignment: "strength", stability: "acceptable" }));
    const before = JSON.stringify(input);
    const result = computePuttingScoreV1(input);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(75);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ============================================================================
// H. Determinism
// ============================================================================

describe("EQ5F-D — identical input always yields identical output", () => {
  it("repeated calls are deeply equal", () => {
    const input = envelope({ setup_alignment: "strength", tempo_rhythm: "needs_improvement" });
    const first = computePuttingScoreV1(input);
    const second = computePuttingScoreV1(input);
    const third = computePuttingScoreV1(
      envelope({ setup_alignment: "strength", tempo_rhythm: "needs_improvement" }),
    );
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

// ============================================================================
// I. Architectural boundaries
// ============================================================================

interface Guard {
  id: string;
  holds: (source: string) => boolean;
}

function bans(source: string, tokens: readonly string[]): boolean {
  const code = stripComments(source);
  return tokens.every((token) => !code.includes(token));
}

const GUARDS: Guard[] = [
  {
    id: "1. every import is type-only",
    holds: (source) => {
      const imports = importsOf(source);
      return imports.length > 0 && imports.every((entry) => entry.typeOnly);
    },
  },
  {
    id: "2. no recommendation dependency",
    holds: (source) =>
      importsOf(source).every(
        (entry) =>
          !/putting-drill-recommendation|putting-recommendation-authority/.test(entry.specifier),
      ) && bans(source, ["rankPuttingDrillRecommendations", "resolvePuttingDrillRecommendations"]),
  },
  {
    id: "3. no Supabase, database or API dependency",
    holds: (source) =>
      importsOf(source).every((entry) => !/supabase|\/api\//.test(entry.specifier)) &&
      bans(source, ["createClient", "supabase", ".from(", "NextResponse"]),
  },
  {
    id: "4. no entitlement dependency",
    holds: (source) =>
      importsOf(source).every((entry) => !/entitlements/.test(entry.specifier)) &&
      bans(source, ["canUsePutting", "SubscriptionTier"]),
  },
  {
    id: "5. no equipment dependency",
    holds: (source) => bans(source, ["equipment"]),
  },
  {
    id: "6. no clock and no randomness",
    holds: (source) => bans(source, ["Date.now", "new Date", "Math.random", "performance.now"]),
  },
  {
    id: "7. no numeric putting measurement dependency",
    holds: (source) =>
      bans(source, [
        "putt_tempo_ratio",
        "face_angle_at_impact_deg",
        "path_deviation_mm",
        "putt_analytics",
      ]),
  },
  {
    id: "8. no prose-field dependency",
    holds: (source) =>
      bans(source, ["observation", "summary", "primary_finding", "practice_focus"]),
  },
  {
    id: "9. the score version is not aliased to an upstream version",
    holds: (source) =>
      bans(source, [
        "PUTTING_ANALYSIS_SCHEMA_VERSION",
        "PUTTING_SIGNAL_CLASSIFICATION_VERSION",
        "PUTTING_DRILL_EVIDENCE_VERSION",
        "PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION",
      ]),
  },
  {
    id: "10. no logging",
    holds: (source) => bans(source, ["console."]),
  },
  {
    id: "11. the point table excludes insufficient_evidence",
    holds: (source) => {
      const table = pointTable(source);
      return table.length > 0 && !table.includes("insufficient");
    },
  },
  {
    id: "12. each canonical section key appears exactly once",
    holds: (source) => {
      const code = stripComments(source);
      return SECTION_KEYS.every((key) => countLiteral(code, key) === 1);
    },
  },
  {
    id: "13. no model SDK or analysis-contract runtime dependency",
    holds: (source) =>
      importsOf(source).every(
        (entry) => !/@google\/generative-ai|putting-analysis-contract/.test(entry.specifier),
      ) && bans(source, ["GoogleGenerativeAI", "SchemaType"]),
  },
  {
    id: "14. no persistence, filesystem, process or network access",
    holds: (source) =>
      bans(source, [
        ".insert(",
        ".update(",
        ".upsert(",
        "fetch(",
        "readFile",
        "writeFile",
        "process.env",
        "require(",
      ]),
  },
  {
    id: "15. the exported scorer is version-specific with no latest alias",
    holds: (source) => {
      const code = stripComments(source);
      return code.includes("export function computePuttingScoreV1(") && !/latest/i.test(code);
    },
  },
  {
    id: "16. no full-swing score reference",
    holds: (source) => bans(source, ["swing_analysis", "@/types/database", "tempo_ratio"]),
  },
];

function guardById(id: string): Guard {
  const found = GUARDS.find((guard) => guard.id === id);
  if (!found) throw new Error(`unknown guard: ${id}`);
  return found;
}

describe("EQ5F-D — architectural boundaries", () => {
  const source = readModuleSource();

  it.each(GUARDS.map((guard) => guard.id))("%s", (id) => {
    expect(guardById(id).holds(source), `"${id}" no longer holds`).toBe(true);
  });

  it("imports exactly one module, and only for its types", () => {
    const imports = importsOf(source);
    expect(imports).toEqual([
      { typeOnly: true, specifier: "@/lib/putting-signal-classification-eq5e-a" },
    ]);
  });
});

// ============================================================================
// J. Non-vacuity of the architectural guards
// ============================================================================
//
// Each entry regresses the real module source in memory, replays the named
// guards, and requires them to fail. Nothing is written to disk. Arithmetic and
// runtime behaviour are proved above by executing the real function, never by
// matching text.

const IMPORT_STATEMENT =
  'import type {\n  PuttingEvidenceClassificationV1,\n  PuttingSignalClassification,\n} from "@/lib/putting-signal-classification-eq5e-a";';

const SCORER_SIGNATURE = "export function computePuttingScoreV1(input: unknown): PuttingScoreV1 | null {";

/**
 * The ranking module's specifier, assembled from a prefix rather than written
 * out in one piece.
 *
 * EQ5E-B proves it is still dormant by scanning every file under app/, lib/ and
 * components/ for its own specifier and requiring the resulting importer set to
 * equal an exact list. One regression below has to name that module to show
 * this suite would notice a dependency on it — and spelling the specifier
 * verbatim here would make this file read as a fourth importer of a module it
 * never imports, failing that suite over a string in a mutation fixture.
 *
 * Joining the halves keeps the whole literal out of these bytes while the
 * mutated source built at runtime still carries the real specifier, so the
 * guard is exercised exactly as it would be by a genuine import. The prefix is
 * still specific enough that a real dependency could not hide behind it.
 */
const RULESET_SPECIFIER_PREFIX = "@/lib/putting-drill-recommendation";
const RULESET_SPECIFIER = `${RULESET_SPECIFIER_PREFIX}-eq5e-b`;

interface Regression {
  name: string;
  apply: (source: string) => string;
  breaks: string[];
}

/** Adds a statement as the first line of the scorer body. */
function inScorer(source: string, statement: string): string {
  return source.replace(SCORER_SIGNATURE, `${SCORER_SIGNATURE}\n  ${statement}`);
}

const REGRESSIONS: Regression[] = [
  {
    name: "the type-only import becomes a runtime import",
    apply: (source) => source.replace("import type {", "import {"),
    breaks: ["1. every import is type-only"],
  },
  {
    name: "the ranking module is imported",
    apply: (source) =>
      `import { rankPuttingDrillRecommendations } from "${RULESET_SPECIFIER}";\n${source}`,
    breaks: ["1. every import is type-only", "2. no recommendation dependency"],
  },
  {
    name: "the module reads and writes the analysis table",
    apply: (source) =>
      inScorer(
        `import { createClient } from "@/utils/supabase/server";\n${source}`,
        'const supabase = await createClient(); await supabase.from("swing_analysis").update({ score: 1 });',
      ),
    breaks: [
      "1. every import is type-only",
      "3. no Supabase, database or API dependency",
      "14. no persistence, filesystem, process or network access",
      "16. no full-swing score reference",
    ],
  },
  {
    name: "the scorer consults an entitlement",
    apply: (source) =>
      inScorer(
        `import { canUsePuttingAnalysis } from "@/lib/entitlements";\n${source}`,
        "if (!canUsePuttingAnalysis(\"par\")) return null;",
      ),
    breaks: ["1. every import is type-only", "4. no entitlement dependency"],
  },
  {
    name: "the scorer reads the equipment snapshot",
    apply: (source) => inScorer(source, "const club = (input as { equipment_snapshot?: unknown }).equipment_snapshot;"),
    breaks: ["5. no equipment dependency"],
  },
  {
    name: "the scorer consults the clock",
    apply: (source) => inScorer(source, "const now = new Date();"),
    breaks: ["6. no clock and no randomness"],
  },
  {
    name: "the scorer introduces randomness",
    apply: (source) => inScorer(source, "const jitter = Math.random();"),
    breaks: ["6. no clock and no randomness"],
  },
  {
    name: "the scorer consumes a numeric putting column",
    apply: (source) => inScorer(source, "const tempo = (input as { putt_tempo_ratio?: number }).putt_tempo_ratio;"),
    breaks: ["7. no numeric putting measurement dependency"],
  },
  {
    name: "the scorer reads a section's prose",
    apply: (source) => inScorer(source, "const text = (input as { observation?: string }).observation;"),
    breaks: ["8. no prose-field dependency"],
  },
  {
    name: "the score version is aliased to the classification version",
    apply: (source) =>
      source.replace(
        "export const PUTTING_SCORE_VERSION = 1;",
        "export const PUTTING_SCORE_VERSION = PUTTING_SIGNAL_CLASSIFICATION_VERSION;",
      ),
    breaks: ["9. the score version is not aliased to an upstream version"],
  },
  {
    name: "the scorer logs",
    apply: (source) => inScorer(source, 'console.log("scoring");'),
    breaks: ["10. no logging"],
  },
  {
    name: "insufficient evidence is given a point value",
    apply: (source) =>
      source.replace("  needs_improvement: 0,\n", "  needs_improvement: 0,\n  insufficient_evidence: 0,\n"),
    breaks: ["11. the point table excludes insufficient_evidence"],
  },
  {
    name: "a second section-keyed table is introduced",
    apply: (source) =>
      `${source}\nconst SECTION_WEIGHTS = { setup_alignment: 2, stroke_path: 1, face_at_impact: 1, tempo_rhythm: 1, stroke_symmetry: 1, stability: 1 };\n`,
    breaks: ["12. each canonical section key appears exactly once"],
  },
  {
    name: "the model SDK is imported",
    apply: (source) => `import { SchemaType } from "@google/generative-ai";\n${source}`,
    breaks: ["1. every import is type-only", "13. no model SDK or analysis-contract runtime dependency"],
  },
  {
    name: "the scorer reads the environment",
    apply: (source) => inScorer(source, "const flag = process.env.PUTTING_SCORE_FLAG;"),
    breaks: ["14. no persistence, filesystem, process or network access"],
  },
  {
    name: "the version-specific scorer is replaced by a latest alias",
    apply: (source) =>
      source.replace(
        "export function computePuttingScoreV1(",
        "export function computePuttingScoreLatest(",
      ),
    breaks: ["15. the exported scorer is version-specific with no latest alias"],
  },
  {
    name: "the database row type is imported for its score column",
    apply: (source) => `import type { SwingAnalysis } from "@/types/database";\n${source}`,
    breaks: ["16. no full-swing score reference"],
  },
];

describe("EQ5F-D — the architectural contract is non-vacuous", () => {
  const live = readModuleSource();

  it("the import statement anchor still matches the real source", () => {
    expect(live).toContain(IMPORT_STATEMENT);
    expect(live).toContain(SCORER_SIGNATURE);
  });

  it("every guard holds against the real, unmodified source", () => {
    const failing = GUARDS.filter((guard) => !guard.holds(live)).map((guard) => guard.id);
    expect(failing, "the compliant module must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((regression) => regression.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((entry) => entry.name === name)!;
    const mutated = regression.apply(live);

    expect(mutated, `"${name}" altered no source — the simulation anchor is stale`).not.toBe(live);

    for (const id of regression.breaks) {
      expect(
        guardById(id).holds(mutated),
        `"${name}" was not detected by guard "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });

  it("every guard participates in at least one regression", () => {
    const exercised = new Set(REGRESSIONS.flatMap((regression) => regression.breaks));
    const unexercised = GUARDS.map((guard) => guard.id).filter((id) => !exercised.has(id));
    expect(unexercised, "a guard nothing can break is a guard that proves nothing").toEqual([]);
  });

  it("every regression names only guards that exist", () => {
    const known = new Set(GUARDS.map((guard) => guard.id));
    const unknown = REGRESSIONS.flatMap((regression) => regression.breaks).filter(
      (id) => !known.has(id),
    );
    expect(unknown, "a regression naming a nonexistent guard silently proves nothing").toEqual([]);
  });
});

// ============================================================================
// What this suite does not prove
// ============================================================================
//
//   * that any production row scores a particular value — no database is read
//   * that a golfer ever sees this number — no consumer imports this module yet
//   * that a score is stored anywhere — nothing is persisted in this slice
//   * that a future score version behaves like v1 — v1 is frozen, and a later
//     algorithm is a new version with its own function and its own contract
