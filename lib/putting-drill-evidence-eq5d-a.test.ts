import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUTTING_ASSESSMENT_ENUMS,
  PUTTING_SECTIONS,
  type PersistedPuttingAnalysisV1,
} from "@/lib/putting-analysis-contract";
import {
  PUTTING_DRILL_EVIDENCE_VERSION,
  isCanonicalDrillReference,
  projectPuttingDrillEvidence,
} from "@/lib/putting-drill-evidence-eq5d-a";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const CONTRACT = "lib/putting-drill-evidence-eq5d-a.ts";
const EQ5B_CONTRACT = "lib/putting-analysis-contract.ts";
const EQ5B_MODULE = "@/lib/putting-analysis-contract";

// ============================================================================
// EQ5D-A — the putting drill evidence boundary
// ============================================================================
//
// Two kinds of coverage, deliberately separated.
//
// BEHAVIOURAL, for what the projection and the identity guard actually do:
// that evidence is copied faithfully, that unclear and unavailable survive,
// that the caller's analysis is never touched, that measurements never cross,
// and that an identity carrying invented content is refused.
//
// STRUCTURAL, for what the module must never become. A boundary is defined as
// much by its absences — no recommender, no drill content, no tier logic, no
// runtime dependency at all — and absences cannot be observed by calling a
// function, so they are asserted against the real source. Every such ban is
// paired with an in-memory mutation proving the ban would actually fire,
// because a guard that cannot fail is decoration.
//
// This suite imports PUTTING_SECTIONS and PUTTING_ASSESSMENT_ENUMS from the
// EQ5B contract at runtime on purpose: the purity rule applies to the module
// under test, and reading the real section list is what lets this suite notice
// drift rather than assert against a hardcoded copy of it.

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code plus rendered copy. The bans below describe what the
 * module does, so they must not fire on the comments explaining why it does
 * not do those things — the contract deliberately names "recommendation",
 * "equipment" and the Gemini SDK in prose to record why none is present.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * Blanks string and template literals so the export scanner cannot be fooled
 * by the word "export" appearing inside one, in either direction.
 */
function stripStringLiterals(code: string): string {
  return code
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `code` depends on `mod` through any import form: a static import
 * with `from`, a bare side-effect import, a dynamic import, or a require.
 * Matched as a prefix and under either quote style.
 */
function importsModule(code: string, mod: string): boolean {
  const m = escapeForRegex(mod);
  return [
    new RegExp(`from\\s*['"]${m}`),
    new RegExp(`import\\s*['"]${m}`),
    new RegExp(`import\\s*\\(\\s*['"]${m}`),
    new RegExp(`require\\s*\\(\\s*['"]${m}`),
  ].some((pattern) => pattern.test(code));
}

/** Every `export` token, paired with the text that follows it. */
function exportTails(code: string): string[] {
  const scannable = stripStringLiterals(code);
  return Array.from(scannable.matchAll(/\bexport\b/g)).map((match) =>
    scannable.slice(match.index + "export".length).replace(/^\s+/, "").slice(0, 120),
  );
}

/** The only export form this module is permitted to use. */
const ALLOWED_EXPORT_TAIL = /^(?:const|type|interface|function)\s+(\w+)/;

function sectionValue(assessment: string, observation: string) {
  return { assessment, observation };
}

/** A complete, realistic persisted analysis, including an unclear and an
 *  unavailable section so their survival is asserted rather than assumed. */
function persistedAnalysis(): PersistedPuttingAnalysisV1 {
  return {
    schema_version: 1,
    evidence_basis: "ai_video_analysis_uncalibrated",
    numeric_measurements: {
      putt_tempo_ratio: "unavailable",
      face_angle_at_impact_deg: "unavailable",
      path_deviation_mm: "unavailable",
    },
    summary: "The stroke appears repeatable with a steady lower body.",
    setup_alignment: sectionValue("sound", "Eyes appear positioned over the ball at address."),
    stroke_path: sectionValue("arc", "The path appears to arc gently inside on the backstroke."),
    face_at_impact: sectionValue("appears_square", "The face appears square to the path at impact."),
    tempo_rhythm: sectionValue("unclear", "The camera angle does not support a tempo assessment."),
    stroke_symmetry: sectionValue("unavailable", "This section could not be assessed from the video."),
    stability: sectionValue("stable", "The head appears to stay still through the stroke."),
    primary_finding: "Alignment and stability appear sound; path is the area to watch.",
    practice_focus: "Work on keeping the putter face aligned with the intended start line.",
  };
}

// ── Behaviour: projection ───────────────────────────────────────────────────

describe("EQ5D-A projection — behaviour", () => {
  it("is deterministic for identical inputs", () => {
    const analysis = persistedAnalysis();
    expect(projectPuttingDrillEvidence(analysis, "analysis-id")).toEqual(
      projectPuttingDrillEvidence(analysis, "analysis-id"),
    );
  });

  it("carries the allowed evidence across verbatim", () => {
    const analysis = persistedAnalysis();
    const evidence = projectPuttingDrillEvidence(analysis, "analysis-id");

    expect(evidence.evidence_version).toBe(PUTTING_DRILL_EVIDENCE_VERSION);
    expect(evidence.source_analysis_id).toBe("analysis-id");
    expect(evidence.schema_version).toBe(analysis.schema_version);
    expect(evidence.evidence_basis).toBe(analysis.evidence_basis);
    expect(evidence.summary).toBe(analysis.summary);
    expect(evidence.primary_finding).toBe(analysis.primary_finding);

    for (const section of PUTTING_SECTIONS) {
      expect(evidence.sections[section].assessment).toBe(analysis[section].assessment);
      expect(evidence.sections[section].observation).toBe(analysis[section].observation);
    }
  });

  it("copies the practice focus byte for byte, including awkward text", () => {
    const analysis = persistedAnalysis();
    analysis.practice_focus = "  Work on  tempo — keep it SMOOTH.  ";
    expect(projectPuttingDrillEvidence(analysis, "analysis-id").practice_focus).toBe(
      "  Work on  tempo — keep it SMOOTH.  ",
    );
  });

  it("preserves an unclear assessment as unclear", () => {
    const evidence = projectPuttingDrillEvidence(persistedAnalysis(), "analysis-id");
    expect(evidence.sections.tempo_rhythm.assessment).toBe("unclear");
    expect(PUTTING_ASSESSMENT_ENUMS.tempo_rhythm).toContain("unclear");
  });

  it("preserves an unavailable assessment as unavailable", () => {
    const evidence = projectPuttingDrillEvidence(persistedAnalysis(), "analysis-id");
    expect(evidence.sections.stroke_symmetry.assessment).toBe("unavailable");
    expect(PUTTING_ASSESSMENT_ENUMS.stroke_symmetry).toContain("unavailable");
  });

  it("covers every canonical section and invents none", () => {
    const evidence = projectPuttingDrillEvidence(persistedAnalysis(), "analysis-id");
    expect(Object.keys(evidence.sections).sort()).toEqual([...PUTTING_SECTIONS].sort());
  });

  it("does not mutate or alias the source analysis", () => {
    const analysis = persistedAnalysis();
    const snapshot = structuredClone(analysis);
    const evidence = projectPuttingDrillEvidence(analysis, "analysis-id");

    expect(analysis).toEqual(snapshot);
    expect(evidence.sections.setup_alignment).not.toBe(analysis.setup_alignment);
  });

  it("freezes the evidence it returns, at every level", () => {
    const evidence = projectPuttingDrillEvidence(persistedAnalysis(), "analysis-id");
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.sections)).toBe(true);
    for (const section of PUTTING_SECTIONS) {
      expect(Object.isFrozen(evidence.sections[section])).toBe(true);
    }
  });

  it("excludes numeric measurements from the evidence entirely", () => {
    const evidence = projectPuttingDrillEvidence(persistedAnalysis(), "analysis-id");
    expect("numeric_measurements" in evidence).toBe(false);
    const serialized = JSON.stringify(evidence);
    for (const field of ["putt_tempo_ratio", "face_angle_at_impact_deg", "path_deviation_mm"]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("treats source_analysis_id as opaque and imposes no format", () => {
    for (const id of ["a", "not-a-uuid", " padded ", "0f2b7c1e-1234-4aaa-8bbb-998877665544-extra"]) {
      expect(projectPuttingDrillEvidence(persistedAnalysis(), id).source_analysis_id).toBe(id);
    }
  });
});

// ── Behaviour: identity guard ───────────────────────────────────────────────

describe("EQ5D-A canonical drill identity — strict shape", () => {
  it("accepts an identity carrying nothing but a drill id", () => {
    expect(isCanonicalDrillReference({ drill_id: "canonical-id" })).toBe(true);
  });

  it("rejects an empty or blank drill id", () => {
    expect(isCanonicalDrillReference({ drill_id: "" })).toBe(false);
    expect(isCanonicalDrillReference({ drill_id: "   " })).toBe(false);
    expect(isCanonicalDrillReference({ drill_id: "\t\n " })).toBe(false);
  });

  it("rejects a non-object, a null, an array and a bare drill name", () => {
    expect(isCanonicalDrillReference("Gate Drill")).toBe(false);
    expect(isCanonicalDrillReference(null)).toBe(false);
    expect(isCanonicalDrillReference(undefined)).toBe(false);
    expect(isCanonicalDrillReference([])).toBe(false);
    expect(isCanonicalDrillReference([{ drill_id: "canonical-id" }])).toBe(false);
    expect(isCanonicalDrillReference(42)).toBe(false);
  });

  it("rejects an object without a drill id", () => {
    expect(isCanonicalDrillReference({ name: "Gate Drill" })).toBe(false);
    expect(isCanonicalDrillReference({})).toBe(false);
  });

  it("rejects invented content smuggled alongside a valid id", () => {
    expect(isCanonicalDrillReference({ drill_id: "canonical-id", name: "Gate Drill" })).toBe(false);
    expect(
      isCanonicalDrillReference({ drill_id: "canonical-id", target_metric: "stroke_path" }),
    ).toBe(false);
  });

  it("rejects an extra symbol own key", () => {
    const smuggled = { drill_id: "canonical-id" } as Record<PropertyKey, unknown>;
    smuggled[Symbol("name")] = "Gate Drill";
    expect(isCanonicalDrillReference(smuggled)).toBe(false);
  });

  it("rejects an extra non-enumerable own key", () => {
    const smuggled: Record<string, unknown> = { drill_id: "canonical-id" };
    Object.defineProperty(smuggled, "name", { value: "Gate Drill", enumerable: false });
    expect(isCanonicalDrillReference(smuggled)).toBe(false);
  });

  it("rejects an inherited-only drill id", () => {
    expect(isCanonicalDrillReference(Object.create({ drill_id: "canonical-id" }) as unknown)).toBe(false);
  });

  it("imposes no UUID syntax and normalizes nothing", () => {
    expect(isCanonicalDrillReference({ drill_id: "not-a-uuid" })).toBe(true);
    const reference = { drill_id: " padded-id " };
    expect(isCanonicalDrillReference(reference)).toBe(true);
    expect(reference.drill_id).toBe(" padded-id ");
  });
});

// ── Structure: what this module must never become ───────────────────────────

const ALGORITHM_TOKENS = [
  "recommendDrill",
  "selectDrill",
  "rankDrills",
  "mapFindingToDrill",
  "ranking",
  "confidence",
  "embedding",
] as const;

const FORBIDDEN_MODULES = [
  "@supabase",
  "next",
  "react",
  "@google/generative-ai",
  "openai",
  "stripe",
  "@/lib/entitlements",
  "@/utils/supabase",
  "node:fs",
  "node:path",
  "node:url",
] as const;

const IMPURE_TOKENS = [
  "Date.now(",
  "Math.random(",
  "randomUUID(",
  "process.env",
  "fetch(",
  "console.",
] as const;

const MODEL_TOKENS = [
  "GoogleGenerativeAI",
  "generateContent",
  "SchemaType",
  "gemini",
  "SYSTEM_INSTRUCTION",
  "prompt",
] as const;

const EQUIPMENT_PATTERNS = [
  /\bequipment_snapshot\b/,
  /\bmanufacturer\b/i,
  /\bclub_type\b/,
  /\bbrand\b/i,
  /\bsponsor/i,
  /\bplacement\b/i,
] as const;

const TIER_PATTERNS = [
  /\bpar\b/,
  /\bbirdie\b/,
  /\beagle\b/,
  /\bcoach_starter\b/,
  /\bcoach_pro\b/,
  /\bcanUsePuttingAnalysis\b/,
  /\bsubscription_tier\b/,
] as const;

const DRILL_CONTENT_PATTERNS = [
  /\bname\s*:/,
  /\btarget_metric\b/,
  /\bthe_why\b/,
  /\bthe_how\b/,
  /\bthe_feel\b/,
  /\bai_verification_prompt\b/,
  /\binstructional_video_url\b/,
] as const;

const PRESCRIPTION_PATTERNS = [
  /\breps?\b/i,
  /\brepetitions?\b/i,
  /\bsets\b/i,
  /\bminutes?\b/i,
  /\bseconds?\b/i,
  /\bduration\b/i,
] as const;

const FROZEN_EXPORTS = [
  "CanonicalDrillReference",
  "PUTTING_DRILL_EVIDENCE_VERSION",
  "PuttingDrillEvidenceV1",
  "PuttingSectionEvidence",
  "isCanonicalDrillReference",
  "projectPuttingDrillEvidence",
] as const;

const EQ5B_RUNTIME_FORMS = (mod: string) => {
  const m = escapeForRegex(mod);
  return [
    new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}`),
    new RegExp(`import\\s*['"]${m}`),
    new RegExp(`import\\s*\\(\\s*['"]${m}`),
    new RegExp(`require\\s*\\(\\s*['"]${m}`),
  ];
};

interface Guard {
  id: string;
  holds: (code: string) => boolean;
}

const GUARDS: Guard[] = [
  {
    id: "contains no recommendation algorithm",
    holds: (code) => ALGORITHM_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "imports no framework, database, model, entitlement or node module",
    holds: (code) => FORBIDDEN_MODULES.every((mod) => !importsModule(code, mod)),
  },
  {
    id: "depends on the EQ5B contract only as a type",
    holds: (code) => {
      const occurrences = Array.from(code.matchAll(new RegExp(escapeForRegex(EQ5B_MODULE), "g")));
      if (occurrences.length !== 1) return false;
      const typeOnly = new RegExp(
        `import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*['"]${escapeForRegex(EQ5B_MODULE)}['"]`,
      );
      if (!typeOnly.test(code)) return false;
      return EQ5B_RUNTIME_FORMS(EQ5B_MODULE).every((pattern) => !pattern.test(code));
    },
  },
  {
    id: "carries no model vocabulary of any kind",
    holds: (code) => MODEL_TOKENS.every((token) => !new RegExp(escapeForRegex(token), "i").test(code)),
  },
  {
    id: "performs no impure operation",
    holds: (code) => IMPURE_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "admits no equipment or commercial input",
    holds: (code) => EQUIPMENT_PATTERNS.every((pattern) => !pattern.test(code)),
  },
  {
    id: "contains no entitlement or tier logic",
    holds: (code) => TIER_PATTERNS.every((pattern) => !pattern.test(code)),
  },
  {
    id: "carries drill identity only, never drill content",
    holds: (code) => DRILL_CONTENT_PATTERNS.every((pattern) => !pattern.test(code)),
  },
  {
    id: "generates no practice prescription",
    holds: (code) => PRESCRIPTION_PATTERNS.every((pattern) => !pattern.test(code)),
  },
  {
    id: "excludes numeric measurements from the contract surface",
    holds: (code) => !code.includes("numeric_measurements"),
  },
  {
    id: "reimplements none of the EQ5B safety rules",
    holds: (code) => !code.includes("DRILL_PATTERNS") && !/new RegExp\(/.test(code),
  },
  {
    id: "freezes no recommendation cardinality",
    holds: (code) =>
      !/recommendations?\s*:/.test(code) && !/CanonicalDrillReference\s*\[\]/.test(code),
  },
  {
    id: "copies the practice focus verbatim and never writes back",
    holds: (code) =>
      code.includes("practice_focus: analysis.practice_focus,") &&
      !/analysis\.practice_focus\s*\./.test(code) &&
      !/practice_focus\s*=/.test(code) &&
      !/analysis\.[a-z_]+\s*=/.test(code),
  },
  {
    id: "lists every putting section explicitly rather than looping a runtime list",
    holds: (code) =>
      ["setup_alignment", "stroke_path", "face_at_impact", "tempo_rhythm", "stroke_symmetry", "stability"].every(
        (section) => code.includes(`${section}: copySection(analysis.${section})`),
      ) && !code.includes("PUTTING_SECTIONS"),
  },
  {
    id: "declares the evidence surface readonly",
    holds: (code) => {
      const start = code.indexOf("interface PuttingDrillEvidenceV1");
      const body = code.slice(start, code.indexOf("\n}", start));
      const fields = body.match(/^\s+(?:readonly\s+)?\w+\s*:/gm) ?? [];
      return fields.length > 0 && fields.every((field) => field.includes("readonly"));
    },
  },
  {
    id: "declares the canonical drill id readonly",
    holds: (code) => /interface CanonicalDrillReference\s*\{\s*readonly drill_id: string;\s*\}/.test(code),
  },
  {
    id: "uses only the permitted export form",
    holds: (code) => exportTails(code).every((tail) => ALLOWED_EXPORT_TAIL.test(tail)),
  },
  {
    id: "exports exactly the frozen boundary symbols",
    holds: (code) => {
      const names = exportTails(code)
        .map((tail) => ALLOWED_EXPORT_TAIL.exec(tail)?.[1])
        .filter((name): name is string => typeof name === "string");
      return (
        names.length === FROZEN_EXPORTS.length &&
        [...names].sort().join(",") === [...FROZEN_EXPORTS].sort().join(",")
      );
    },
  },
];

describe("EQ5D-A contract — structural boundary", () => {
  const code = stripComments(readSource(CONTRACT));

  it("the contract module exists", () => {
    expect(existsSync(path.join(repoRoot, CONTRACT)), `missing file: ${CONTRACT}`).toBe(true);
  });

  it.each(GUARDS.map((g) => g.id))("%s", (id) => {
    const guard = GUARDS.find((g) => g.id === id)!;
    expect(guard.holds(code), `"${id}" no longer holds`).toBe(true);
  });

  it("keeps the canonical drill reference to identity alone", () => {
    const start = code.indexOf("interface CanonicalDrillReference");
    const body = code.slice(start, code.indexOf("}", start));
    const fields = (body.match(/^\s*(?:readonly\s+)?(\w+)\s*:/gm) ?? []).map((m) =>
      m.trim().replace(/^readonly\s+/, "").replace(":", ""),
    );
    expect(fields).toEqual(["drill_id"]);
  });

  it("leaves the EQ5B contract as an untouched dependency that still owns the firewall", () => {
    const eq5b = readSource(EQ5B_CONTRACT);
    expect(eq5b).toContain("const DRILL_PATTERNS");
    expect(eq5b).toContain("drill or practice-program prescription is out of scope");
    expect(eq5b).toContain('from "@google/generative-ai"');
  });
});

// ── Non-vacuity ─────────────────────────────────────────────────────────────

interface Regression {
  name: string;
  apply: (code: string) => string;
  breaks: string[];
}

const TYPE_IMPORT =
  'import type {\n  PersistedPuttingAnalysisV1,\n  PuttingSection,\n} from "@/lib/putting-analysis-contract";';

const REGRESSIONS: Regression[] = [
  {
    name: "the EQ5B dependency becomes a runtime import",
    apply: (code) =>
      code.replace(
        TYPE_IMPORT,
        'import { PUTTING_SECTIONS, type PersistedPuttingAnalysisV1, type PuttingSection } from "@/lib/putting-analysis-contract";',
      ),
    breaks: ["depends on the EQ5B contract only as a type"],
  },
  {
    name: "the Gemini SDK is imported statically",
    apply: (code) => `import { SchemaType } from "@google/generative-ai";\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "carries no model vocabulary of any kind",
    ],
  },
  {
    name: "the Gemini SDK is imported for side effects",
    apply: (code) => `import "@google/generative-ai";\n${code}`,
    breaks: ["imports no framework, database, model, entitlement or node module"],
  },
  {
    name: "the Gemini SDK is imported dynamically",
    apply: (code) => `${code}\nconst sdk = import('@google/generative-ai');\n`,
    breaks: ["imports no framework, database, model, entitlement or node module"],
  },
  {
    name: "a Supabase client is imported with single quotes",
    apply: (code) => `import { createClient } from '@supabase/supabase-js';\n${code}`,
    breaks: ["imports no framework, database, model, entitlement or node module"],
  },
  {
    name: "the entitlement helper is imported",
    apply: (code) => `import { canUsePuttingAnalysis } from '@/lib/entitlements';\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "contains no entitlement or tier logic",
    ],
  },
  {
    name: "a recommendation function is added",
    apply: (code) => `${code}\nexport function recommendDrill() { return null; }\n`,
    breaks: ["contains no recommendation algorithm", "exports exactly the frozen boundary symbols"],
  },
  {
    name: "a timestamp makes the projection non-deterministic",
    apply: (code) =>
      code.replace(
        "source_analysis_id: sourceAnalysisId,",
        "source_analysis_id: sourceAnalysisId, projected_at: Date.now(),",
      ),
    breaks: ["performs no impure operation"],
  },
  {
    name: "equipment context is admitted as evidence",
    apply: (code) =>
      code.replace("summary: analysis.summary,", "summary: analysis.summary, equipment_snapshot: null,"),
    breaks: ["admits no equipment or commercial input"],
  },
  {
    name: "numeric measurements are carried across",
    apply: (code) =>
      code.replace(
        "summary: analysis.summary,",
        "summary: analysis.summary, numeric_measurements: analysis.numeric_measurements,",
      ),
    breaks: ["excludes numeric measurements from the contract surface"],
  },
  {
    name: "drill content leaks into the identity reference",
    apply: (code) =>
      code.replace("  readonly drill_id: string;", "  readonly drill_id: string;\n  readonly target_metric: string;"),
    breaks: ["carries drill identity only, never drill content", "declares the canonical drill id readonly"],
  },
  {
    name: "a practice prescription appears in the contract",
    apply: (code) =>
      code.replace("  readonly practice_focus: string;", "  readonly practice_focus: string;\n  readonly reps: number;"),
    breaks: ["generates no practice prescription"],
  },
  {
    name: "the practice focus is trimmed instead of copied",
    apply: (code) =>
      code.replace(
        "practice_focus: analysis.practice_focus,",
        "practice_focus: analysis.practice_focus.trim(),",
      ),
    breaks: ["copies the practice focus verbatim and never writes back"],
  },
  {
    name: "the explicit section list is replaced by a runtime loop",
    apply: (code) =>
      code.replace(
        "      setup_alignment: copySection(analysis.setup_alignment),",
        "      ...Object.fromEntries(PUTTING_SECTIONS.map((s) => [s, copySection(analysis[s])])),",
      ),
    breaks: ["lists every putting section explicitly rather than looping a runtime list"],
  },
  {
    name: "the evidence surface loses readonly",
    apply: (code) => code.replace("  readonly summary: string;", "  summary: string;"),
    breaks: ["declares the evidence surface readonly"],
  },
  {
    name: "cardinality is frozen to many",
    apply: (code) => `${code}\nexport interface Bundle { recommendations: CanonicalDrillReference[] }\n`,
    breaks: ["freezes no recommendation cardinality", "exports exactly the frozen boundary symbols"],
  },
  {
    name: "the EQ5B safety regexes are reimplemented locally",
    apply: (code) => `${code}\nconst DRILL_PATTERNS = [new RegExp("gate", "i")];\n`,
    breaks: ["reimplements none of the EQ5B safety rules"],
  },
  {
    name: "an indented seventh symbol is exported",
    apply: (code) => `${code}\n  export const EXTRA = 1;\n`,
    breaks: ["exports exactly the frozen boundary symbols"],
  },
  {
    name: "an indented default export is added",
    apply: (code) => `${code}\n    export default projectPuttingDrillEvidence;\n`,
    breaks: ["uses only the permitted export form"],
  },
  {
    name: "an export is split across a newline",
    apply: (code) => `${code}\nexport\n  class DrillSelector {}\n`,
    breaks: ["uses only the permitted export form"],
  },
  {
    name: "an export list is added",
    apply: (code) => `${code}\nexport { PUTTING_DRILL_EVIDENCE_VERSION as VERSION };\n`,
    breaks: ["uses only the permitted export form"],
  },
  {
    name: "a star re-export is added",
    apply: (code) => `${code}\nexport * from "@/lib/putting-analysis-contract";\n`,
    breaks: ["uses only the permitted export form"],
  },
  {
    name: "an exported enum is added",
    apply: (code) => `${code}\nexport enum DrillKind { Putting }\n`,
    breaks: ["uses only the permitted export form"],
  },
  {
    name: "an exported async function is added",
    apply: (code) => `${code}\nexport async function loadDrill() { return null; }\n`,
    breaks: ["uses only the permitted export form"],
  },
];

describe("EQ5D-A contract — the boundary is non-vacuous", () => {
  const code = stripComments(readSource(CONTRACT));

  it("every guard holds against the real module", () => {
    const failing = GUARDS.filter((g) => !g.holds(code)).map((g) => g.id);
    expect(failing, "the real contract must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((r) => r.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((r) => r.name === name)!;
    const mutated = stripComments(regression.apply(readSource(CONTRACT)));

    expect(mutated, `"${name}" altered no source — the simulation anchor is stale`).not.toBe(code);

    for (const id of regression.breaks) {
      const guard = GUARDS.find((g) => g.id === id)!;
      expect(
        guard.holds(mutated),
        `"${name}" was not detected by "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });

  it("is caught when the exact-key identity check is weakened", () => {
    // Behavioural rather than structural: removing the own-key check leaves
    // source that looks innocent, so it is proven by evaluating the weakened
    // predicate directly rather than by a token ban.
    const weakened = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return false;
      if (Array.isArray(value)) return false;
      const drillId = (value as { drill_id: unknown }).drill_id;
      return typeof drillId === "string" && drillId.trim().length > 0;
    };

    const smuggled = { drill_id: "canonical-id", name: "Model Invented Drill" };
    expect(weakened(smuggled), "the weakened predicate must accept smuggled content").toBe(true);
    expect(
      isCanonicalDrillReference(smuggled),
      "the real guard must reject what the weakened one accepts",
    ).toBe(false);
    expect(readSource(CONTRACT), "the own-key check must still be present").toContain(
      "Reflect.ownKeys(value)",
    );
  });
});
