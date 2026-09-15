import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUTTING_ASSESSMENT_ENUMS,
  PUTTING_SECTIONS,
  type PersistedPuttingAnalysisV1,
  type PuttingSection,
} from "@/lib/putting-analysis-contract";
import {
  projectPuttingDrillEvidence,
  type PuttingDrillEvidenceV1,
} from "@/lib/putting-drill-evidence-eq5d-a";
import {
  PUTTING_SIGNAL_CLASSIFICATION_VERSION,
  classifyPuttingAssessment,
  classifyPuttingEvidence,
  type PuttingSignalClassification,
} from "@/lib/putting-signal-classification-eq5e-a";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const CONTRACT = "lib/putting-signal-classification-eq5e-a.ts";
const EQ5B_MODULE = "@/lib/putting-analysis-contract";
const EQ5D_A_MODULE = "@/lib/putting-drill-evidence-eq5d-a";

// ============================================================================
// EQ5E-A — the putting signal classification contract
// ============================================================================
//
// Three kinds of coverage, deliberately separated.
//
// RECONCILIATION, against the analysis contract itself. The mapping is private
// on purpose, so this suite reads it out of the real source and compares it to
// the accepted vocabulary in both directions. A value added upstream, removed
// upstream, or invented here fails immediately and by name — which is the only
// way a private table can be prevented from silently drifting.
//
// BEHAVIOURAL, for what the classifier actually returns: every accepted pair,
// the load-bearing arc decision, the two insufficient values staying
// distinguishable, the positive values staying positive, and every malformed
// input failing closed rather than becoming work a golfer does not need.
//
// STRUCTURAL, for what the module must never become. A boundary is defined as
// much by its absences — no catalog identity, no ranking, no prose reading, no
// tier, no runtime dependency at all — and absences cannot be observed by
// calling a function, so they are asserted against the real source. Every such
// ban is paired with an in-memory mutation proving the ban would actually
// fire, because a guard that cannot fail is decoration.
//
// PUTTING_SECTIONS and PUTTING_ASSESSMENT_ENUMS are imported here at runtime on
// purpose: the purity rule applies to the module under test, and reading the
// real vocabulary is what lets this suite notice drift rather than assert
// against a hardcoded copy of it.

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code alone. The bans below describe what the module does,
 * so they must not fire on the comments explaining why it does not do those
 * things — the contract deliberately names recommendation, equipment and the
 * model SDK in prose to record why none of them is present.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `code` depends on `mod` through any import form. */
function importsModule(code: string, mod: string): boolean {
  const m = escapeForRegex(mod);
  return [
    new RegExp(`from\\s*['"]${m}['"]`),
    new RegExp(`import\\s*['"]${m}['"]`),
    new RegExp(`import\\s*\\(\\s*['"]${m}['"]`),
    new RegExp(`require\\s*\\(\\s*['"]${m}['"]`),
  ].some((pattern) => pattern.test(code));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

// ── The mapping, read out of the real source ────────────────────────────────

/**
 * Extracts the private classification table from the module source.
 *
 * Line-oriented rather than a single expression, so a failure points at the
 * shape of the table instead of at an unreadable pattern. The table is written
 * one entry per line precisely so this can stay simple.
 */
function parseClassificationTable(source: string): Record<string, Record<string, string>> {
  const lines = source.split("\n");
  const openIndex = lines.findIndex((line) => line.startsWith("const CLASSIFICATION = {"));
  if (openIndex === -1) throw new Error("classification table not found");

  const table: Record<string, Record<string, string>> = {};
  let current: string | null = null;

  for (let i = openIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("} as const satisfies")) break;

    const sectionOpen = /^ {2}([a-z_]+): \{$/.exec(line);
    if (sectionOpen) {
      current = sectionOpen[1];
      table[current] = {};
      continue;
    }
    if (/^ {2}\},$/.test(line)) {
      current = null;
      continue;
    }
    const entry = /^ {4}([a-z_]+): "([a-z_]+)",$/.exec(line);
    if (entry && current !== null) {
      table[current][entry[1]] = entry[2];
    }
  }

  return table;
}

const SOURCE = readSource(CONTRACT);
const CODE = stripComments(SOURCE);
const PARSED_TABLE = parseClassificationTable(SOURCE);

// ── The frozen contract, restated independently of the source ───────────────

/**
 * The adjudicated classification, written out in full rather than derived.
 *
 * A table generated from the module under test could only ever agree with it.
 * This is the second, independent statement that makes disagreement possible.
 */
const EXPECTED: Record<PuttingSection, Record<string, PuttingSignalClassification>> = {
  setup_alignment: {
    sound: "strength",
    needs_attention: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stroke_path: {
    straight: "strength",
    arc: "acceptable",
    in_to_out: "needs_improvement",
    out_to_in: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  face_at_impact: {
    appears_square: "strength",
    appears_open: "needs_improvement",
    appears_closed: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  tempo_rhythm: {
    smooth: "strength",
    rushed: "needs_improvement",
    decelerating: "needs_improvement",
    uneven: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stroke_symmetry: {
    balanced: "strength",
    backswing_dominant: "needs_improvement",
    through_stroke_dominant: "needs_improvement",
    uneven: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stability: {
    stable: "strength",
    head_motion: "needs_improvement",
    lower_body_motion: "needs_improvement",
    mixed_motion: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
};

const ALL_PAIRS: { section: PuttingSection; assessment: string; expected: PuttingSignalClassification }[] =
  PUTTING_SECTIONS.flatMap((section) =>
    Object.entries(EXPECTED[section]).map(([assessment, expected]) => ({
      section,
      assessment,
      expected,
    })),
  );

const POSITIVE: { section: PuttingSection; assessment: string }[] = [
  { section: "setup_alignment", assessment: "sound" },
  { section: "stroke_path", assessment: "straight" },
  { section: "face_at_impact", assessment: "appears_square" },
  { section: "tempo_rhythm", assessment: "smooth" },
  { section: "stroke_symmetry", assessment: "balanced" },
  { section: "stability", assessment: "stable" },
];

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROSE_A = {
  summary: "A steady stroke with one repeatable tendency.",
  primary_finding: "The face is the most informative thing in this stroke.",
  practice_focus: "Work on what the face is doing through the ball.",
  observation: "Observed across the visible portion of the stroke.",
};

const PROSE_B = {
  summary: "Completely different wording, describing the very same stroke.",
  primary_finding: "An entirely unrelated sentence about something else.",
  practice_focus: "Text that shares no vocabulary at all with the first fixture.",
  observation: "Wildly different prose, deliberately contradicting nothing.",
};

function makeAnalysis(
  assessments: Record<PuttingSection, string>,
  prose: typeof PROSE_A = PROSE_A,
): PersistedPuttingAnalysisV1 {
  const section = (name: PuttingSection) => ({
    assessment: assessments[name],
    observation: `${prose.observation} (${name})`,
  });

  return {
    schema_version: 1,
    evidence_basis: "ai_video_analysis_uncalibrated",
    numeric_measurements: {
      putt_tempo_ratio: "unavailable",
      face_angle_at_impact_deg: "unavailable",
      path_deviation_mm: "unavailable",
    },
    summary: prose.summary,
    setup_alignment: section("setup_alignment"),
    stroke_path: section("stroke_path"),
    face_at_impact: section("face_at_impact"),
    tempo_rhythm: section("tempo_rhythm"),
    stroke_symmetry: section("stroke_symmetry"),
    stability: section("stability"),
    primary_finding: prose.primary_finding,
    practice_focus: prose.practice_focus,
  };
}

function makeEvidence(
  assessments: Record<PuttingSection, string>,
  prose: typeof PROSE_A = PROSE_A,
): PuttingDrillEvidenceV1 {
  return projectPuttingDrillEvidence(makeAnalysis(assessments, prose), "analysis-fixture");
}

const MIXED: Record<PuttingSection, string> = {
  setup_alignment: "sound",
  stroke_path: "arc",
  face_at_impact: "appears_open",
  tempo_rhythm: "decelerating",
  stroke_symmetry: "unclear",
  stability: "unavailable",
};

// ============================================================================
// A. Upstream vocabulary reconciliation
// ============================================================================

describe("EQ5E-A vocabulary — reconciled against the analysis contract", () => {
  it("exists at the frozen path", () => {
    expect(existsSync(path.join(repoRoot, CONTRACT)), `missing file: ${CONTRACT}`).toBe(true);
  });

  it("classifies exactly the six canonical sections, and no others", () => {
    expect(sorted(Object.keys(PARSED_TABLE))).toEqual(sorted(PUTTING_SECTIONS));
    expect(sorted(Object.keys(EXPECTED))).toEqual(sorted(PUTTING_SECTIONS));
    expect(PUTTING_SECTIONS).toHaveLength(6);
  });

  it.each(PUTTING_SECTIONS)(
    "covers every accepted assessment of %s, and invents none",
    (section) => {
      const accepted = sorted(PUTTING_ASSESSMENT_ENUMS[section]);
      expect(sorted(Object.keys(PARSED_TABLE[section]))).toEqual(accepted);
      expect(sorted(Object.keys(EXPECTED[section]))).toEqual(accepted);
    },
  );

  it("maps thirty-three section/assessment pairs in total", () => {
    const upstream = PUTTING_SECTIONS.reduce(
      (total, section) => total + PUTTING_ASSESSMENT_ENUMS[section].length,
      0,
    );
    const parsed = Object.values(PARSED_TABLE).reduce(
      (total, table) => total + Object.keys(table).length,
      0,
    );
    expect(upstream).toBe(33);
    expect(parsed).toBe(33);
    expect(ALL_PAIRS).toHaveLength(33);
  });

  it("uses only the four accepted classification states", () => {
    const states = new Set(
      Object.values(PARSED_TABLE).flatMap((table) => Object.values(table)),
    );
    expect(sorted(Array.from(states))).toEqual([
      "acceptable",
      "insufficient_evidence",
      "needs_improvement",
      "strength",
    ]);
  });

  it("agrees with the source table on every pair", () => {
    for (const { section, assessment, expected } of ALL_PAIRS) {
      expect(PARSED_TABLE[section][assessment], `${section}/${assessment}`).toBe(expected);
    }
  });

  it("stamps the classification envelope version", () => {
    expect(PUTTING_SIGNAL_CLASSIFICATION_VERSION).toBe(1);
  });
});

// ============================================================================
// B. Every accepted pair
// ============================================================================

describe("EQ5E-A classification — every accepted pair", () => {
  it.each(ALL_PAIRS)(
    "classifies $section / $assessment as $expected",
    ({ section, assessment, expected }) => {
      expect(classifyPuttingAssessment(section, assessment)).toBe(expected);
    },
  );
});

// ============================================================================
// C. The arc decision
// ============================================================================

describe("EQ5E-A arc — acceptable, and nothing else", () => {
  it("classifies a gentle arc as acceptable", () => {
    expect(classifyPuttingAssessment("stroke_path", "arc")).toBe("acceptable");
  });

  it("does not treat an arc as a strength, a weakness, or missing evidence", () => {
    const actual = classifyPuttingAssessment("stroke_path", "arc");
    expect(actual).not.toBe("strength");
    expect(actual).not.toBe("needs_improvement");
    expect(actual).not.toBe("insufficient_evidence");
  });

  it("is the only assessment in the whole vocabulary classified as acceptable", () => {
    const acceptable = ALL_PAIRS.filter((pair) => pair.expected === "acceptable");
    expect(acceptable).toEqual([
      { section: "stroke_path", assessment: "arc", expected: "acceptable" },
    ]);
  });
});

// ============================================================================
// D. unclear versus unavailable
// ============================================================================

describe("EQ5E-A insufficient evidence — both values, still distinguishable", () => {
  it.each(PUTTING_SECTIONS)("treats unclear in %s as insufficient evidence", (section) => {
    expect(classifyPuttingAssessment(section, "unclear")).toBe("insufficient_evidence");
  });

  it.each(PUTTING_SECTIONS)("treats unavailable in %s as insufficient evidence", (section) => {
    expect(classifyPuttingAssessment(section, "unavailable")).toBe("insufficient_evidence");
  });

  it("keeps the original assessment so unclear and unavailable stay apart", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));

    expect(result.sections.stroke_symmetry.assessment).toBe("unclear");
    expect(result.sections.stability.assessment).toBe("unavailable");
    expect(result.sections.stroke_symmetry.classification).toBe("insufficient_evidence");
    expect(result.sections.stability.classification).toBe("insufficient_evidence");
    expect(result.sections.stroke_symmetry.assessment).not.toBe(
      result.sections.stability.assessment,
    );
  });

  it("copies each assessment verbatim, without trimming or case folding", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));
    for (const section of PUTTING_SECTIONS) {
      expect(result.sections[section].assessment).toBe(MIXED[section]);
    }
  });
});

// ============================================================================
// E. Strengths stay strengths
// ============================================================================

describe("EQ5E-A strengths — a measured section is not automatically work", () => {
  it.each(POSITIVE)("classifies $section / $assessment as a strength", ({ section, assessment }) => {
    expect(classifyPuttingAssessment(section, assessment)).toBe("strength");
  });

  it("reports every section as a strength when the whole stroke is sound", () => {
    const allPositive = Object.fromEntries(
      POSITIVE.map((entry) => [entry.section, entry.assessment]),
    ) as Record<PuttingSection, string>;

    const result = classifyPuttingEvidence(makeEvidence(allPositive));
    for (const section of PUTTING_SECTIONS) {
      expect(result.sections[section].classification).toBe("strength");
    }
  });
});

// ============================================================================
// F. Unknown input fails closed
// ============================================================================

const MALFORMED = [
  "",
  " ",
  "\t",
  "SOUND",
  "Straight",
  "Arc",
  "unknown",
  "needs_attention ",
  " sound",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
];

describe("EQ5E-A unknown input — fails closed", () => {
  it.each(MALFORMED)("classifies %j as insufficient evidence in every section", (assessment) => {
    for (const section of PUTTING_SECTIONS) {
      const actual = classifyPuttingAssessment(section, assessment);
      expect(actual, `${section}/${assessment}`).toBe("insufficient_evidence");
      expect(actual).not.toBe("strength");
      expect(actual).not.toBe("acceptable");
      expect(actual).not.toBe("needs_improvement");
    }
  });

  it("does not resolve an assessment through the object prototype", () => {
    expect(typeof Object.prototype.toString).toBe("function");
    expect(classifyPuttingAssessment("stability", "toString")).toBe("insufficient_evidence");
    expect(classifyPuttingAssessment("stability", "constructor")).toBe("insufficient_evidence");
  });

  it("fails closed on a value that is not a string at all", () => {
    const values: unknown[] = [null, undefined, 0, 1, true, {}, [], Symbol("x")];
    for (const value of values) {
      expect(classifyPuttingAssessment("tempo_rhythm", value as unknown as string)).toBe(
        "insufficient_evidence",
      );
    }
  });

  it("fails closed on a section that escaped the type boundary", () => {
    const sections: unknown[] = ["not_a_section", "", "__proto__", "toString", null, 7, {}];
    for (const section of sections) {
      expect(
        classifyPuttingAssessment(section as unknown as PuttingSection, "sound"),
      ).toBe("insufficient_evidence");
    }
  });

  it("never throws, whatever it is given", () => {
    expect(() =>
      classifyPuttingAssessment(
        undefined as unknown as PuttingSection,
        undefined as unknown as string,
      ),
    ).not.toThrow();
  });
});

// ============================================================================
// G. Determinism
// ============================================================================

describe("EQ5E-A determinism — identical input, identical output", () => {
  it("returns the same classification on repeated calls", () => {
    for (const { section, assessment } of ALL_PAIRS) {
      const first = classifyPuttingAssessment(section, assessment);
      for (let i = 0; i < 5; i += 1) {
        expect(classifyPuttingAssessment(section, assessment)).toBe(first);
      }
    }
  });

  it("produces structurally identical aggregates across repeated calls", () => {
    const evidence = makeEvidence(MIXED);
    const first = JSON.stringify(classifyPuttingEvidence(evidence));
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(classifyPuttingEvidence(evidence))).toBe(first);
    }
  });

  it("produces the same aggregate from two separately built identical inputs", () => {
    expect(JSON.stringify(classifyPuttingEvidence(makeEvidence(MIXED)))).toBe(
      JSON.stringify(classifyPuttingEvidence(makeEvidence(MIXED))),
    );
  });
});

// ============================================================================
// H. The caller's evidence is never touched
// ============================================================================

describe("EQ5E-A input immutability", () => {
  it("does not mutate a frozen evidence envelope", () => {
    const evidence = makeEvidence(MIXED);
    const before = JSON.stringify(evidence);
    classifyPuttingEvidence(evidence);
    expect(JSON.stringify(evidence)).toBe(before);
  });

  it("does not mutate an unfrozen evidence-shaped object either", () => {
    const projected = makeEvidence(MIXED);
    const mutable: PuttingDrillEvidenceV1 = {
      evidence_version: projected.evidence_version,
      source_analysis_id: projected.source_analysis_id,
      schema_version: projected.schema_version,
      evidence_basis: projected.evidence_basis,
      summary: projected.summary,
      sections: {
        setup_alignment: { ...projected.sections.setup_alignment },
        stroke_path: { ...projected.sections.stroke_path },
        face_at_impact: { ...projected.sections.face_at_impact },
        tempo_rhythm: { ...projected.sections.tempo_rhythm },
        stroke_symmetry: { ...projected.sections.stroke_symmetry },
        stability: { ...projected.sections.stability },
      },
      primary_finding: projected.primary_finding,
      practice_focus: projected.practice_focus,
    };

    const before = JSON.stringify(mutable);
    classifyPuttingEvidence(mutable);
    expect(JSON.stringify(mutable)).toBe(before);
  });

  it("shares no section object with its input", () => {
    const evidence = makeEvidence(MIXED);
    const result = classifyPuttingEvidence(evidence);
    for (const section of PUTTING_SECTIONS) {
      expect(result.sections[section]).not.toBe(evidence.sections[section]);
    }
    expect(result.sections).not.toBe(evidence.sections);
  });
});

// ============================================================================
// I. The result is frozen
// ============================================================================

describe("EQ5E-A output immutability", () => {
  it("freezes the aggregate, the sections record, and every section result", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sections)).toBe(true);
    for (const section of PUTTING_SECTIONS) {
      expect(Object.isFrozen(result.sections[section]), section).toBe(true);
    }
  });

  it("reports all six sections whatever they say", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));
    expect(sorted(Object.keys(result.sections))).toEqual(sorted(PUTTING_SECTIONS));
  });

  it("stamps its own envelope version", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));
    expect(result.classification_version).toBe(PUTTING_SIGNAL_CLASSIFICATION_VERSION);
  });
});

// ============================================================================
// J. Prose changes nothing
// ============================================================================

describe("EQ5E-A prose independence", () => {
  it("classifies identically when every narrative field is replaced", () => {
    const withProseA = classifyPuttingEvidence(makeEvidence(MIXED, PROSE_A));
    const withProseB = classifyPuttingEvidence(makeEvidence(MIXED, PROSE_B));
    expect(JSON.stringify(withProseB)).toBe(JSON.stringify(withProseA));
  });

  it("is unmoved by prose that contradicts the assessment", () => {
    const contradicting = {
      summary: "Everything about this stroke is excellent and needs no work at all.",
      primary_finding: "No fault is present anywhere; the stroke is flawless.",
      practice_focus: "Nothing requires attention.",
      observation: "Perfect, sound, smooth, balanced, stable and square throughout.",
    };
    const result = classifyPuttingEvidence(makeEvidence(MIXED, contradicting));
    expect(result.sections.face_at_impact.classification).toBe("needs_improvement");
    expect(result.sections.tempo_rhythm.classification).toBe("needs_improvement");
    expect(result.sections.stroke_symmetry.classification).toBe("insufficient_evidence");
  });

  it("carries no narrative field into its own output", () => {
    const result = classifyPuttingEvidence(makeEvidence(MIXED));
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(PROSE_A.summary);
    expect(serialised).not.toContain(PROSE_A.primary_finding);
    expect(serialised).not.toContain(PROSE_A.practice_focus);
    expect(serialised).not.toContain(PROSE_A.observation);
    expect(sorted(Object.keys(result))).toEqual(["classification_version", "sections"]);
    for (const section of PUTTING_SECTIONS) {
      expect(sorted(Object.keys(result.sections[section]))).toEqual([
        "assessment",
        "classification",
      ]);
    }
  });
});

// ============================================================================
// K-M. Structural boundaries, asserted against the real source
// ============================================================================

const DRILL_TOKENS = [
  "target_metric",
  "drill_family",
  "public.drills",
  "user_drills",
  "automated_prescriptions",
  "ai_verification_prompt",
  "instructional_video_url",
  "Eye-Line Setup Check",
  "Start-Line Gate",
  "Heel-Toe Strike Gate",
  "Rail Path Channel",
  "Distance Ladder",
  "Two-Count Tempo",
  "Three-Foot Circle",
];

const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const RANKING_TOKENS = [
  "rank",
  "score",
  "weight",
  "priority",
  "candidate",
  "recommend",
  "cardinality",
  "severity",
  "confidence",
  ".sort(",
  ".slice(",
];

const PROSE_FIELDS = ["observation", "summary", "primary_finding", "practice_focus"];

const PRODUCT_TOKENS = [
  "SubscriptionTier",
  "canUsePutting",
  "entitlement",
  "coach_pro",
  "coach_starter",
  "birdie",
  "eagle",
];

const EQUIPMENT_TOKENS = [
  "club_id",
  "equipment",
  "putter",
  "manufacturer",
  "toe_hang",
  "hosel",
  "loft",
  "lie",
];

const FORBIDDEN_MODULES = [
  "@supabase/supabase-js",
  "@supabase/ssr",
  "@google/generative-ai",
  "next/server",
  "next/navigation",
  "next/headers",
  "react",
  "@/lib/entitlements",
  "@/lib/analysis-family-router",
  "node:fs",
  "fs",
  "node:crypto",
  "crypto",
  "node:path",
];

const EXPECTED_EXPORTS = [
  "PUTTING_SIGNAL_CLASSIFICATION_VERSION",
  "PuttingEvidenceClassificationV1",
  "PuttingSectionClassificationV1",
  "PuttingSignalClassification",
  "classifyPuttingAssessment",
  "classifyPuttingEvidence",
];

function exportedNames(code: string): string[] {
  return Array.from(
    code.matchAll(/^export\s+(?:const|type|interface|function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm),
  ).map((match) => match[1]);
}

function typeOnlyImportOf(code: string, mod: string): boolean {
  const m = escapeForRegex(mod);
  const occurrences = Array.from(code.matchAll(new RegExp(m, "g")));
  if (occurrences.length !== 1) return false;
  if (!new RegExp(`import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}['"]`).test(code)) {
    return false;
  }
  return ![
    new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}['"]`),
    new RegExp(`import\\s*['"]${m}['"]`),
    new RegExp(`import\\s*\\(\\s*['"]${m}['"]`),
    new RegExp(`require\\s*\\(\\s*['"]${m}['"]`),
  ].some((pattern) => pattern.test(code));
}

interface Guard {
  id: string;
  holds: (code: string) => boolean;
}

const GUARDS: Guard[] = [
  {
    id: "carries no drill or catalog vocabulary",
    holds: (code) =>
      DRILL_TOKENS.every((token) => !code.includes(token)) && !UUID_LITERAL.test(code),
  },
  {
    id: "carries no ranking, scoring or candidate vocabulary",
    holds: (code) => RANKING_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "reads no narrative field",
    holds: (code) => PROSE_FIELDS.every((field) => !code.includes(field)),
  },
  {
    id: "carries no tier or entitlement vocabulary",
    holds: (code) => PRODUCT_TOKENS.every((token) => !code.toLowerCase().includes(token.toLowerCase())),
  },
  {
    id: "carries no equipment vocabulary",
    holds: (code) => EQUIPMENT_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "imports no framework, database, model, entitlement or node module",
    holds: (code) => FORBIDDEN_MODULES.every((mod) => !importsModule(code, mod)),
  },
  {
    id: "depends on the analysis contract only as a type",
    holds: (code) => typeOnlyImportOf(code, EQ5B_MODULE),
  },
  {
    id: "depends on the evidence boundary only as a type",
    holds: (code) => typeOnlyImportOf(code, EQ5D_A_MODULE),
  },
  {
    id: "has no runtime import of any kind",
    holds: (code) => {
      const all = (code.match(/^import\s/gm) ?? []).length;
      const typeOnly = (code.match(/^import\s+type\s/gm) ?? []).length;
      return (
        all === typeOnly &&
        all === 2 &&
        !/\brequire\s*\(/.test(code) &&
        !/\bimport\s*\(/.test(code)
      );
    },
  },
  {
    id: "exports exactly the frozen public surface",
    holds: (code) => sorted(exportedNames(code)).join(",") === sorted(EXPECTED_EXPORTS).join(","),
  },
  {
    id: "keeps the classification table private",
    holds: (code) => !/export\s+(?:const|default)\s+CLASSIFICATION\b/.test(code),
  },
  {
    id: "reaches no clock, randomness or environment",
    holds: (code) =>
      !/\bDate\b/.test(code) &&
      !/Math\.random/.test(code) &&
      !/process\.env/.test(code) &&
      !/\bfetch\s*\(/.test(code) &&
      !/globalThis/.test(code),
  },
  {
    id: "freezes its mapping at load",
    holds: (code) => /Object\.freeze\(CLASSIFICATION\)/.test(code),
  },
];

describe("EQ5E-A contract — structural boundary", () => {
  it.each(GUARDS)("$id", ({ holds }) => {
    expect(holds(CODE)).toBe(true);
  });

  it("names its two upstream dependencies and nothing else", () => {
    const modules = Array.from(CODE.matchAll(/from\s*['"]([^'"]+)['"]/g)).map((m) => m[1]);
    expect(sorted(modules)).toEqual(sorted([EQ5B_MODULE, EQ5D_A_MODULE]));
  });

  it("exposes two functions and no diagnostic helper", () => {
    const functions = Array.from(
      CODE.matchAll(/^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/gm),
    ).map((m) => m[1]);
    expect(sorted(functions)).toEqual(["classifyPuttingAssessment", "classifyPuttingEvidence"]);
    expect(CODE).not.toContain("export function isKnown");
  });
});

// ============================================================================
// N. Non-vacuity — every structural guard is proved able to fail
// ============================================================================

interface Regression {
  name: string;
  apply: (code: string) => string;
  breaks: string[];
}

const EQ5B_TYPE_IMPORT = `import type { PuttingSection } from "${EQ5B_MODULE}";`;
const EQ5D_A_TYPE_IMPORT = `import type { PuttingDrillEvidenceV1 } from "${EQ5D_A_MODULE}";`;

const REGRESSIONS: Regression[] = [
  {
    name: "the analysis contract becomes a runtime import",
    apply: (code) =>
      code.replace(
        EQ5B_TYPE_IMPORT,
        `import { PUTTING_SECTIONS, type PuttingSection } from "${EQ5B_MODULE}";`,
      ),
    breaks: ["depends on the analysis contract only as a type", "has no runtime import of any kind"],
  },
  {
    name: "the model SDK is imported statically",
    apply: (code) => `import { SchemaType } from "@google/generative-ai";\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a Supabase client is imported with single quotes",
    apply: (code) => `import { createClient } from '@supabase/supabase-js';\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "the entitlement helper is imported",
    apply: (code) => `import { canUsePuttingAnalysis } from '@/lib/entitlements';\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "carries no tier or entitlement vocabulary",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a node module is required",
    apply: (code) => `${code}\nconst fsModule = require("node:fs");\n`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a framework module is imported dynamically",
    apply: (code) => `${code}\nconst server = import("next/server");\n`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a catalog identity is embedded",
    apply: (code) =>
      `${code}\nconst pinned = "d0366fc8-c428-5a21-a145-18ef24b15220";\n`,
    breaks: ["carries no drill or catalog vocabulary"],
  },
  {
    name: "the catalog mapping column is referenced",
    apply: (code) => `${code}\nconst column = "target_metric";\n`,
    breaks: ["carries no drill or catalog vocabulary"],
  },
  {
    name: "a ranking order is introduced",
    apply: (code) =>
      `${code}\nconst priority = ["setup_alignment", "face_at_impact"];\n`,
    breaks: ["carries no ranking, scoring or candidate vocabulary"],
  },
  {
    name: "a numeric score is introduced",
    apply: (code) => `${code}\nconst score = 1;\n`,
    breaks: ["carries no ranking, scoring or candidate vocabulary"],
  },
  {
    name: "the narrative observation is read",
    apply: (code) =>
      code.replace("assessment: value.assessment,", "assessment: value.observation,"),
    breaks: ["reads no narrative field"],
  },
  {
    name: "the evidence boundary becomes a runtime import",
    apply: (code) =>
      code.replace(
        EQ5D_A_TYPE_IMPORT,
        `import { projectPuttingDrillEvidence, type PuttingDrillEvidenceV1 } from "${EQ5D_A_MODULE}";`,
      ),
    breaks: [
      "depends on the evidence boundary only as a type",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "equipment reaches the classifier",
    apply: (code) => `${code}\nconst putterModel = "unknown";\n`,
    breaks: ["carries no equipment vocabulary"],
  },
  {
    name: "the private table is exported",
    apply: (code) => code.replace("const CLASSIFICATION = {", "export const CLASSIFICATION = {"),
    breaks: ["exports exactly the frozen public surface", "keeps the classification table private"],
  },
  {
    name: "a diagnostic predicate is exported",
    apply: (code) =>
      `${code}\nexport function isKnownPuttingAssessment(): boolean {\n  return true;\n}\n`,
    breaks: ["exports exactly the frozen public surface"],
  },
  {
    name: "the clock is reached",
    apply: (code) => `${code}\nconst stamp = Date.now();\n`,
    breaks: ["reaches no clock, randomness or environment"],
  },
  {
    name: "randomness is reached",
    apply: (code) => `${code}\nconst jitter = Math.random();\n`,
    breaks: ["reaches no clock, randomness or environment"],
  },
  {
    name: "the mapping is left unfrozen",
    apply: (code) => code.replace("Object.freeze(CLASSIFICATION);", ""),
    breaks: ["freezes its mapping at load"],
  },
];

describe("EQ5E-A contract — guards are non-vacuous", () => {
  it.each(REGRESSIONS)("$name is caught", ({ apply, breaks }) => {
    const broken = stripComments(apply(SOURCE));
    expect(broken, "mutation did not change the source").not.toBe(CODE);

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
