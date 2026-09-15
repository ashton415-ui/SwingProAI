import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUTTING_SECTIONS,
  type PuttingSection,
} from "@/lib/putting-analysis-contract";
import {
  PUTTING_SIGNAL_CLASSIFICATION_VERSION,
  type PuttingEvidenceClassificationV1,
  type PuttingSignalClassification,
} from "@/lib/putting-signal-classification-eq5e-a";
import {
  PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION,
  rankPuttingDrillRecommendations,
} from "@/lib/putting-drill-recommendation-eq5e-b";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const CONTRACT = "lib/putting-drill-recommendation-eq5e-b.ts";
const EQ5E_A_MODULE = "@/lib/putting-signal-classification-eq5e-a";
const EQ5E_B_MODULE = "@/lib/putting-drill-recommendation-eq5e-b";
const SEED_MIGRATION = "supabase/migrations/20260914034708_putting_drill_catalog_seed.sql";

// ============================================================================
// EQ5E-B — deterministic putting drill mapping and ranking
// ============================================================================
//
// Three kinds of coverage, deliberately separated.
//
// RECONCILIATION, against the canonical catalog. The mapping is private, so
// this suite reads it out of the real source and checks every identity against
// the seed migration that created those rows. A catalog id that drifts, or a
// fifth identity appearing here, fails by name.
//
// BEHAVIOURAL, for what the ranking actually returns: the four mapped
// sections, the single eligible classification, the load-bearing arc case, the
// fixed priority, the cap of two, the zero-result cases, verbatim assessments,
// determinism, and every malformed shape failing closed.
//
// STRUCTURAL, for what the module must never become. A boundary is defined as
// much by its absences — no catalog copy, no provenance, no tier, no database,
// no model, no runtime dependency at all — and absences cannot be observed by
// calling a function, so they are asserted against the real source. Every such
// ban is paired with an in-memory mutation proving the ban would actually
// fire. No mutated source is ever written to disk.
//
// Expected results are stated independently below rather than derived from the
// production mapping, because a table generated from the module under test
// could only ever agree with it.

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

const SOURCE = readSource(CONTRACT);
const CODE = stripComments(SOURCE);
const SEED_SQL = readSource(SEED_MIGRATION);

// ── The frozen contract, stated independently of the module under test ──────

interface ExpectedRule {
  readonly source_section: string;
  readonly target_category: string;
  readonly drill_id: string;
  readonly reason_code: string;
  readonly canonical_name: string;
}

/** Priority order is the array order. Written out, never derived. */
const EXPECTED_RULES: readonly ExpectedRule[] = [
  {
    source_section: "setup_alignment",
    target_category: "address_setup",
    drill_id: "d0366fc8-c428-5a21-a145-18ef24b15220",
    reason_code: "setup_alignment_needs_improvement",
    canonical_name: "Eye-Line Setup Check",
  },
  {
    source_section: "face_at_impact",
    target_category: "start_line_control",
    drill_id: "87a51ed8-6cdc-50c7-864b-2bb9d88af5f7",
    reason_code: "face_at_impact_needs_improvement",
    canonical_name: "Start-Line Gate",
  },
  {
    source_section: "stroke_path",
    target_category: "stroke_path_control",
    drill_id: "bcae0cfe-9834-5502-9e0b-03b93d5c8a10",
    reason_code: "stroke_path_needs_improvement",
    canonical_name: "Rail Path Channel",
  },
  {
    source_section: "tempo_rhythm",
    target_category: "stroke_tempo",
    drill_id: "6530ed44-b218-519d-9cdd-57cf2199e44e",
    reason_code: "tempo_rhythm_needs_improvement",
    canonical_name: "Two-Count Tempo",
  },
];

/** Deliberately unmapped: no accepted signal can establish any of these. */
const UNMAPPED_DRILLS: readonly { id: string; category: string; name: string }[] = [
  {
    id: "25299bc9-cee3-5188-b01e-b678f3b5d5f2",
    category: "strike_location",
    name: "Heel-Toe Strike Gate",
  },
  {
    id: "0975bf69-b793-515a-bf5e-7f5a582d2c74",
    category: "distance_control",
    name: "Distance Ladder",
  },
  {
    id: "e9e69977-64e7-582f-b721-228f594e7f9a",
    category: "short_putt_conversion",
    name: "Three-Foot Circle",
  },
];

const UNMAPPED_SECTIONS: readonly PuttingSection[] = ["stroke_symmetry", "stability"];

// ── The private rule list, read out of the real source ──────────────────────

function parseMappingRules(source: string): ExpectedRule[] {
  const start = source.indexOf("const MAPPING_RULES");
  if (start === -1) throw new Error("mapping rule list not found");
  const end = source.indexOf("] as const satisfies", start);
  if (end === -1) throw new Error("mapping rule list is not terminated as expected");

  const block = source.slice(start, end);
  const pairs = Array.from(block.matchAll(/^\s{4}([a-z_]+): "([^"]+)",$/gm)).map(
    (match) => [match[1], match[2]] as const,
  );

  const rules: ExpectedRule[] = [];
  for (let i = 0; i + 3 < pairs.length; i += 4) {
    const entry: Record<string, string> = {};
    for (let j = 0; j < 4; j += 1) entry[pairs[i + j][0]] = pairs[i + j][1];
    rules.push({
      source_section: entry.source_section,
      target_category: entry.target_category,
      drill_id: entry.drill_id,
      reason_code: entry.reason_code,
      canonical_name: "",
    });
  }
  return rules;
}

const PARSED_RULES = parseMappingRules(SOURCE);

// ── Fixtures ────────────────────────────────────────────────────────────────

interface SectionState {
  assessment: string;
  classification: PuttingSignalClassification;
}

const NEUTRAL: SectionState = {
  assessment: "unavailable",
  classification: "insufficient_evidence",
};

const NEEDS = (assessment: string): SectionState => ({
  assessment,
  classification: "needs_improvement",
});

function envelope(
  overrides: Record<string, SectionState>,
  order: readonly PuttingSection[] = PUTTING_SECTIONS,
): PuttingEvidenceClassificationV1 {
  const sections: Record<string, SectionState> = {};
  for (const section of order) {
    sections[section] = overrides[section] ?? { ...NEUTRAL };
  }
  return {
    classification_version: 1,
    sections,
  } as unknown as PuttingEvidenceClassificationV1;
}

/** Builds an envelope from an arbitrary runtime shape, for malformed cases. */
function rawEnvelope(value: unknown): PuttingEvidenceClassificationV1 {
  return value as PuttingEvidenceClassificationV1;
}

const ALL_MAPPED_NEED_WORK: Record<string, SectionState> = {
  setup_alignment: NEEDS("needs_attention"),
  face_at_impact: NEEDS("appears_open"),
  stroke_path: NEEDS("out_to_in"),
  tempo_rhythm: NEEDS("rushed"),
};

// ============================================================================
// A–C. The mapping table, reconciled against the canonical catalog
// ============================================================================

describe("EQ5E-B mapping — reconciled against the canonical catalog", () => {
  it("exists at the frozen path", () => {
    expect(existsSync(path.join(repoRoot, CONTRACT)), `missing file: ${CONTRACT}`).toBe(true);
  });

  it("declares exactly four rules, in the frozen priority order", () => {
    expect(PARSED_RULES).toHaveLength(4);
    expect(PARSED_RULES.map((rule) => rule.source_section)).toEqual([
      "setup_alignment",
      "face_at_impact",
      "stroke_path",
      "tempo_rhythm",
    ]);
  });

  it.each(EXPECTED_RULES.map((rule, index) => ({ index, ...rule })))(
    "rule $index maps $source_section to $target_category",
    ({ index, source_section, target_category, drill_id, reason_code }) => {
      expect(PARSED_RULES[index].source_section).toBe(source_section);
      expect(PARSED_RULES[index].target_category).toBe(target_category);
      expect(PARSED_RULES[index].drill_id).toBe(drill_id);
      expect(PARSED_RULES[index].reason_code).toBe(reason_code);
    },
  );

  it.each(EXPECTED_RULES)(
    "$drill_id and $target_category exist in the canonical seed migration",
    ({ drill_id, target_category, canonical_name }) => {
      expect(SEED_SQL).toContain(drill_id);
      expect(SEED_SQL).toContain(target_category);
      expect(SEED_SQL).toContain(canonical_name);
    },
  );

  it("carries exactly the four mapped catalog identities and no others", () => {
    const uuids = Array.from(
      CODE.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi),
    ).map((match) => match[0]);
    expect(uuids).toHaveLength(4);
    expect(sorted(uuids)).toEqual(sorted(EXPECTED_RULES.map((rule) => rule.drill_id)));
  });

  it("stamps the frozen rule-set version, and accepts the published envelope version", () => {
    expect(PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION).toBe(1);
    expect(PUTTING_SIGNAL_CLASSIFICATION_VERSION).toBe(1);
  });
});

// ============================================================================
// D–G. Only needs_improvement is eligible
// ============================================================================

const NON_ELIGIBLE: PuttingSignalClassification[] = [
  "strength",
  "acceptable",
  "insufficient_evidence",
];

describe("EQ5E-B eligibility — only a section needing work earns a candidate", () => {
  it.each(EXPECTED_RULES)(
    "$source_section needing improvement produces its mapped candidate",
    ({ source_section, drill_id, target_category, reason_code }) => {
      const result = rankPuttingDrillRecommendations(
        envelope({ [source_section as PuttingSection]: NEEDS("observed") }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].drill_id).toBe(drill_id);
      expect(result[0].target_category).toBe(target_category);
      expect(result[0].source_section).toBe(source_section);
      expect(result[0].reason_code).toBe(reason_code);
      expect(result[0].rank).toBe(1);
      expect(result[0].ruleset_version).toBe(1);
    },
  );

  for (const state of NON_ELIGIBLE) {
    it(`a mapped section classified ${state} produces no candidate`, () => {
      for (const rule of EXPECTED_RULES) {
        const result = rankPuttingDrillRecommendations(
          envelope({
            [rule.source_section as PuttingSection]: {
              assessment: "observed",
              classification: state,
            },
          }),
        );
        expect(result, `${rule.source_section}/${state}`).toEqual([]);
      }
    });
  }

  it("returns nothing when every mapped section is a strength", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({
        setup_alignment: { assessment: "sound", classification: "strength" },
        face_at_impact: { assessment: "appears_square", classification: "strength" },
        stroke_path: { assessment: "straight", classification: "strength" },
        tempo_rhythm: { assessment: "smooth", classification: "strength" },
      }),
    );
    expect(result).toEqual([]);
  });

  it("returns nothing when every section is insufficient evidence", () => {
    expect(rankPuttingDrillRecommendations(envelope({}))).toEqual([]);
  });
});

// ============================================================================
// H. The load-bearing arc case
// ============================================================================

describe("EQ5E-B arc — acceptable never becomes a recommendation", () => {
  it("produces nothing when the only notable section is an acceptable arc", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({ stroke_path: { assessment: "arc", classification: "acceptable" } }),
    );
    expect(result).toEqual([]);
  });

  it("skips an acceptable arc without consuming a rank", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({
        stroke_path: { assessment: "arc", classification: "acceptable" },
        tempo_rhythm: NEEDS("rushed"),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].source_section).toBe("tempo_rhythm");
    expect(result[0].drill_id).toBe("6530ed44-b218-519d-9cdd-57cf2199e44e");
    expect(result[0].target_category).toBe("stroke_tempo");
    expect(result[0].rank).toBe(1);
  });

  it("never emits the stroke-path identity from an arc", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({
        stroke_path: { assessment: "arc", classification: "acceptable" },
        setup_alignment: NEEDS("needs_attention"),
        face_at_impact: NEEDS("appears_closed"),
      }),
    );
    expect(result.map((candidate) => candidate.drill_id)).not.toContain(
      "bcae0cfe-9834-5502-9e0b-03b93d5c8a10",
    );
  });
});

// ============================================================================
// I–M. Nothing unmapped is ever inferred
// ============================================================================

describe("EQ5E-B unmapped — sections and catalog entries that stay out", () => {
  it.each(UNMAPPED_SECTIONS)("%s needing improvement produces no candidate", (section) => {
    const result = rankPuttingDrillRecommendations(
      envelope({ [section]: NEEDS("uneven") }),
    );
    expect(result).toEqual([]);
  });

  it("both unmapped sections needing improvement together still produce nothing", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({
        stroke_symmetry: NEEDS("backswing_dominant"),
        stability: NEEDS("head_motion"),
      }),
    );
    expect(result).toEqual([]);
  });

  it("an unmapped section cannot change what the mapped sections produce", () => {
    const withoutNoise = rankPuttingDrillRecommendations(
      envelope({ tempo_rhythm: NEEDS("rushed") }),
    );
    const withNoise = rankPuttingDrillRecommendations(
      envelope({
        tempo_rhythm: NEEDS("rushed"),
        stroke_symmetry: NEEDS("uneven"),
        stability: NEEDS("mixed_motion"),
      }),
    );
    expect(JSON.stringify(withNoise)).toBe(JSON.stringify(withoutNoise));
  });

  it.each(UNMAPPED_DRILLS)(
    "$name / $category is never produced and never named in the module",
    ({ id, category, name }) => {
      const everything = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
      expect(everything.map((candidate) => candidate.drill_id)).not.toContain(id);
      expect(
        everything.map((candidate) => candidate.target_category as string),
      ).not.toContain(category);
      expect(CODE).not.toContain(id);
      expect(CODE).not.toContain(category);
      expect(CODE).not.toContain(name);
    },
  );
});

// ============================================================================
// N–S, W. Priority, ranking and cardinality
// ============================================================================

describe("EQ5E-B priority and cardinality", () => {
  it("returns at most two candidates when all four mapped sections need work", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    expect(result).toHaveLength(2);
    expect(result[0].source_section).toBe("setup_alignment");
    expect(result[0].rank).toBe(1);
    expect(result[1].source_section).toBe("face_at_impact");
    expect(result[1].rank).toBe(2);
  });

  it("caps out stroke_path and tempo_rhythm when the two higher rules fire", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    const sections = result.map((candidate) => candidate.source_section);
    expect(sections).not.toContain("stroke_path");
    expect(sections).not.toContain("tempo_rhythm");
  });

  it("honours the fixed order for every pair of eligible sections", () => {
    const order = ["setup_alignment", "face_at_impact", "stroke_path", "tempo_rhythm"] as const;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const result = rankPuttingDrillRecommendations(
          envelope({
            [order[j]]: NEEDS("later"),
            [order[i]]: NEEDS("earlier"),
          }),
        );
        expect(result).toHaveLength(2);
        expect(result[0].source_section, `${order[i]} before ${order[j]}`).toBe(order[i]);
        expect(result[0].rank).toBe(1);
        expect(result[1].source_section).toBe(order[j]);
        expect(result[1].rank).toBe(2);
      }
    }
  });

  it("returns exactly one candidate for a single eligible section", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({ tempo_rhythm: NEEDS("decelerating") }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe(1);
  });

  it("returns two, ranked one then two, for two eligible sections", () => {
    const result = rankPuttingDrillRecommendations(
      envelope({
        setup_alignment: NEEDS("needs_attention"),
        tempo_rhythm: NEEDS("uneven"),
      }),
    );
    expect(result.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(result.map((candidate) => candidate.source_section)).toEqual([
      "setup_alignment",
      "tempo_rhythm",
    ]);
  });

  it("never returns three or more", () => {
    for (const extra of UNMAPPED_SECTIONS) {
      const result = rankPuttingDrillRecommendations(
        envelope({ ...ALL_MAPPED_NEED_WORK, [extra]: NEEDS("uneven") }),
      );
      expect(result.length).toBeLessThanOrEqual(2);
    }
  });
});

// ============================================================================
// T. Order independence
// ============================================================================

describe("EQ5E-B order independence", () => {
  it("ignores the order the caller's sections were inserted in", () => {
    const forward = rankPuttingDrillRecommendations(
      envelope(ALL_MAPPED_NEED_WORK, PUTTING_SECTIONS),
    );
    const reversed = rankPuttingDrillRecommendations(
      envelope(ALL_MAPPED_NEED_WORK, [...PUTTING_SECTIONS].reverse()),
    );
    const shuffled = rankPuttingDrillRecommendations(
      envelope(ALL_MAPPED_NEED_WORK, [
        "tempo_rhythm",
        "stability",
        "face_at_impact",
        "stroke_symmetry",
        "stroke_path",
        "setup_alignment",
      ]),
    );

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
    expect(forward.map((candidate) => candidate.source_section)).toEqual([
      "setup_alignment",
      "face_at_impact",
    ]);
  });
});

// ============================================================================
// U, V, X. Candidate content
// ============================================================================

describe("EQ5E-B candidate content", () => {
  it("copies the observed assessment verbatim", () => {
    const odd = "  NeEdS_AtTeNtIoN  ";
    const result = rankPuttingDrillRecommendations(
      envelope({ setup_alignment: NEEDS(odd) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].observed_assessment).toBe(odd);
  });

  it.each(EXPECTED_RULES)("emits reason code $reason_code", ({ source_section, reason_code }) => {
    const result = rankPuttingDrillRecommendations(
      envelope({ [source_section as PuttingSection]: NEEDS("x") }),
    );
    expect(result[0].reason_code).toBe(reason_code);
  });

  it("stamps the rule-set version on every candidate", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    for (const candidate of result) {
      expect(candidate.ruleset_version).toBe(PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION);
    }
  });

  it("carries exactly the seven contract fields and nothing else", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    for (const candidate of result) {
      expect(sorted(Object.keys(candidate))).toEqual([
        "drill_id",
        "observed_assessment",
        "rank",
        "reason_code",
        "ruleset_version",
        "source_section",
        "target_category",
      ]);
    }
  });

  it("carries no provenance, catalog copy, family, tier or grading fields", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    const serialised = JSON.stringify(result);
    for (const absent of [
      "source_analysis_id",
      "the_why",
      "the_how",
      "the_feel",
      "instructional_video_url",
      "ai_verification_prompt",
      "drill_family",
      "name",
      "tier",
      "confidence",
      "severity",
      "probability",
    ]) {
      expect(serialised, absent).not.toContain(absent);
    }
  });
});

// ============================================================================
// Y, Z, AA, AB. Determinism and immutability
// ============================================================================

describe("EQ5E-B determinism and immutability", () => {
  it("returns deep-equivalent output for repeated identical input", () => {
    const input = envelope(ALL_MAPPED_NEED_WORK);
    const first = JSON.stringify(rankPuttingDrillRecommendations(input));
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(rankPuttingDrillRecommendations(input))).toBe(first);
    }
    expect(JSON.stringify(rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK)))).toBe(
      first,
    );
  });

  it("does not mutate the caller's envelope", () => {
    const input = envelope(ALL_MAPPED_NEED_WORK);
    const before = JSON.stringify(input);
    rankPuttingDrillRecommendations(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("freezes every candidate it returns", () => {
    const result = rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK));
    expect(result).toHaveLength(2);
    for (const candidate of result) {
      expect(Object.isFrozen(candidate)).toBe(true);
    }
  });

  it("freezes the returned array, including the empty one", () => {
    expect(Object.isFrozen(rankPuttingDrillRecommendations(envelope(ALL_MAPPED_NEED_WORK)))).toBe(
      true,
    );
    expect(Object.isFrozen(rankPuttingDrillRecommendations(envelope({})))).toBe(true);
    expect(Object.isFrozen(rankPuttingDrillRecommendations(rawEnvelope(null)))).toBe(true);
  });
});

// ============================================================================
// AC, AD. Malformed runtime input fails closed
// ============================================================================

describe("EQ5E-B malformed input fails closed", () => {
  const badVersions: unknown[] = [undefined, null, 0, 2, "1", true, {}, [], NaN];

  it.each(badVersions.map((v, i) => ({ i, v })))(
    "rejects an unacceptable classification_version (#$i)",
    ({ v }) => {
      const result = rankPuttingDrillRecommendations(
        rawEnvelope({
          classification_version: v,
          sections: { setup_alignment: NEEDS("needs_attention") },
        }),
      );
      expect(result).toEqual([]);
    },
  );

  const badSections: unknown[] = [undefined, null, 1, "sections", true];

  it.each(badSections.map((v, i) => ({ i, v })))("rejects a malformed sections container (#$i)", ({ v }) => {
    const result = rankPuttingDrillRecommendations(
      rawEnvelope({ classification_version: 1, sections: v }),
    );
    expect(result).toEqual([]);
  });

  it("rejects a malformed envelope entirely", () => {
    for (const value of [null, undefined, 1, "x", true, []]) {
      expect(rankPuttingDrillRecommendations(rawEnvelope(value))).toEqual([]);
    }
  });

  const badSectionValues: { label: string; value: unknown }[] = [
    { label: "missing", value: undefined },
    { label: "null", value: null },
    { label: "primitive", value: 7 },
    { label: "string", value: "needs_improvement" },
    { label: "missing classification", value: { assessment: "needs_attention" } },
    { label: "unknown classification", value: { assessment: "x", classification: "urgent" } },
    { label: "empty classification", value: { assessment: "x", classification: "" } },
    { label: "missing assessment", value: { classification: "needs_improvement" } },
    { label: "non-string assessment", value: { classification: "needs_improvement", assessment: 5 } },
    { label: "null assessment", value: { classification: "needs_improvement", assessment: null } },
  ];

  it.each(badSectionValues)("skips a $label mapped section", ({ value }) => {
    const sections: Record<string, unknown> = {};
    for (const section of PUTTING_SECTIONS) sections[section] = { ...NEUTRAL };
    sections.setup_alignment = value;
    const result = rankPuttingDrillRecommendations(
      rawEnvelope({ classification_version: 1, sections }),
    );
    expect(result).toEqual([]);
  });

  it("skips a malformed section while a valid lower-priority rule still fires", () => {
    const sections: Record<string, unknown> = {};
    for (const section of PUTTING_SECTIONS) sections[section] = { ...NEUTRAL };
    sections.setup_alignment = null;
    sections.face_at_impact = { classification: "needs_improvement", assessment: 42 };
    sections.tempo_rhythm = NEEDS("rushed");

    const result = rankPuttingDrillRecommendations(
      rawEnvelope({ classification_version: 1, sections }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].source_section).toBe("tempo_rhythm");
    expect(result[0].rank).toBe(1);
  });

  it("does not read a mapped section through the prototype chain", () => {
    const proto = { setup_alignment: NEEDS("needs_attention") };
    const sections = Object.create(proto) as Record<string, unknown>;
    sections.tempo_rhythm = { ...NEUTRAL };

    expect((sections as { setup_alignment?: unknown }).setup_alignment).toBeDefined();
    const result = rankPuttingDrillRecommendations(
      rawEnvelope({ classification_version: 1, sections }),
    );
    expect(result).toEqual([]);
  });

  it("never throws, whatever it is given", () => {
    for (const value of [undefined, null, 0, "", [], {}, Symbol("s")]) {
      expect(() => rankPuttingDrillRecommendations(rawEnvelope(value))).not.toThrow();
    }
  });
});

// ============================================================================
// AE–AM. Structural boundaries, asserted against the real source
// ============================================================================

const PROSE_FIELDS = ["observation", "summary", "primary_finding", "practice_focus"];

const GRADING_TOKENS = ["confidence", "severity", "probability", "weight", "score", ".sort("];

const PRODUCT_TOKENS = [
  "SubscriptionTier",
  "canUsePutting",
  "entitlement",
  "coach_pro",
  "coach_starter",
  "birdie",
  "eagle",
];

const EQUIPMENT_TOKENS = ["club_id", "equipment", "putter", "manufacturer", "toe_hang"];

const CATALOG_COPY_TOKENS = [
  ...EXPECTED_RULES.map((rule) => rule.canonical_name),
  ...UNMAPPED_DRILLS.map((drill) => drill.name),
  "the_why",
  "the_how",
  "the_feel",
  "instructional_video_url",
  "ai_verification_prompt",
  "drill_family",
];

const PERSISTENCE_TOKENS = [
  "supabase",
  "public.drills",
  "user_drills",
  "automated_prescriptions",
  "from(",
  "insert(",
  "upsert(",
];

const MODEL_TOKENS = [
  "gemini",
  "generative-ai",
  "generativeai",
  "getgenerativemodel",
  "prompt",
  "openai",
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
  "@/lib/putting-analysis-contract",
  "@/lib/putting-drill-evidence-eq5d-a",
  "node:fs",
  "fs",
  "node:crypto",
  "crypto",
  "node:path",
];

const EXPECTED_EXPORTS = [
  "PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION",
  "PuttingDrillRecommendationCandidateV1",
  "PuttingRecommendationReasonCode",
  "PuttingRecommendationSourceSection",
  "PuttingRecommendationTargetCategory",
  "rankPuttingDrillRecommendations",
];

function exportedNames(code: string): string[] {
  return Array.from(
    code.matchAll(/^export\s+(?:const|type|interface|function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm),
  ).map((match) => match[1]);
}

function typeOnlyImportOf(code: string, mod: string): boolean {
  const m = escapeForRegex(mod);
  if (Array.from(code.matchAll(new RegExp(m, "g"))).length !== 1) return false;
  if (!new RegExp(`import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}['"]`).test(code)) return false;
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
    id: "has no runtime import of any kind",
    holds: (code) => {
      const all = (code.match(/^import\s/gm) ?? []).length;
      const typeOnly = (code.match(/^import\s+type\s/gm) ?? []).length;
      return (
        all === 1 &&
        typeOnly === 1 &&
        !/\brequire\s*\(/.test(code) &&
        !/\bimport\s*\(/.test(code)
      );
    },
  },
  {
    id: "depends on the classification contract only as a type",
    holds: (code) => typeOnlyImportOf(code, EQ5E_A_MODULE),
  },
  {
    id: "imports no framework, database, model, entitlement or node module",
    holds: (code) => FORBIDDEN_MODULES.every((mod) => !importsModule(code, mod)),
  },
  {
    id: "reaches no database or persistence surface",
    holds: (code) => PERSISTENCE_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "reaches no model surface",
    holds: (code) => MODEL_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "reads no narrative field",
    holds: (code) => PROSE_FIELDS.every((field) => !code.includes(field)),
  },
  {
    id: "grades nothing by confidence, severity or probability",
    holds: (code) => GRADING_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "carries no tier or entitlement vocabulary",
    holds: (code) =>
      PRODUCT_TOKENS.every((token) => !code.toLowerCase().includes(token.toLowerCase())),
  },
  {
    id: "carries no equipment vocabulary",
    holds: (code) => EQUIPMENT_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "duplicates no canonical catalog copy",
    holds: (code) => CATALOG_COPY_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "fabricates no analysis provenance",
    holds: (code) => !code.includes("source_analysis_id"),
  },
  {
    id: "carries exactly four catalog identities",
    holds: (code) =>
      Array.from(
        code.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi),
      ).length === 4,
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
    id: "exports exactly the frozen public surface",
    holds: (code) => sorted(exportedNames(code)).join(",") === sorted(EXPECTED_EXPORTS).join(","),
  },
  {
    id: "keeps the mapping rules private",
    holds: (code) => !/export\s+(?:const|default)\s+MAPPING_RULES\b/.test(code),
  },
  {
    id: "freezes its mapping at load",
    holds: (code) => /const MAPPING_RULES:[\s\S]{0,80}Object\.freeze\(\[/.test(code),
  },
];

describe("EQ5E-B contract — structural boundary", () => {
  it.each(GUARDS)("$id", ({ holds }) => {
    expect(holds(CODE)).toBe(true);
  });

  it("names exactly one upstream dependency", () => {
    const modules = Array.from(CODE.matchAll(/from\s*['"]([^'"]+)['"]/g)).map((m) => m[1]);
    expect(modules).toEqual([EQ5E_A_MODULE]);
  });

  it("exposes exactly one function", () => {
    const functions = Array.from(
      CODE.matchAll(/^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/gm),
    ).map((m) => m[1]);
    expect(functions).toEqual(["rankPuttingDrillRecommendations"]);
  });

  it("creates no reverse dependency", () => {
    for (const upstream of [
      "lib/putting-signal-classification-eq5e-a.ts",
      "lib/putting-drill-evidence-eq5d-a.ts",
      "lib/putting-analysis-contract.ts",
    ]) {
      expect(readSource(upstream), upstream).not.toContain("eq5e-b");
    }
  });
});

// ============================================================================
// AO. The module stays dormant
// ============================================================================

interface RepoFile {
  readonly filePath: string;
  readonly content: string;
}

function collectSourceFiles(dirs: readonly string[]): RepoFile[] {
  const files: RepoFile[] = [];
  for (const dir of dirs) {
    const absolute = path.join(repoRoot, dir);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.tsx?$/.test(entry.name)) continue;
      const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath
        ?? (entry as unknown as { path: string }).path;
      const full = path.join(parent, entry.name);
      files.push({
        filePath: path.relative(repoRoot, full).split(path.sep).join("/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

function productionImportersOf(specifier: string, files: readonly RepoFile[]): string[] {
  return files
    .filter((file) => !file.filePath.includes(".test."))
    .filter((file) => file.filePath !== CONTRACT)
    .filter((file) => file.content.includes(specifier))
    .map((file) => file.filePath);
}

describe("EQ5E-B activation — dormant", () => {
  const repoFiles = collectSourceFiles(["app", "lib", "components"]);

  it("scanned a plausible number of source files", () => {
    expect(repoFiles.length).toBeGreaterThan(50);
    expect(repoFiles.some((file) => file.filePath === CONTRACT)).toBe(true);
  });

  it("has no production importer", () => {
    expect(productionImportersOf(EQ5E_B_MODULE, repoFiles)).toEqual([]);
  });

  it("is imported by its own test only", () => {
    const importers = repoFiles
      .filter((file) => file.filePath !== CONTRACT)
      .filter((file) => file.content.includes(EQ5E_B_MODULE))
      .map((file) => file.filePath);
    expect(importers).toEqual(["lib/putting-drill-recommendation-eq5e-b.test.ts"]);
  });

  it("would notice a production importer if one appeared", () => {
    const synthetic: RepoFile[] = [
      { filePath: "app/api/example/route.ts", content: `import x from "${EQ5E_B_MODULE}";` },
      { filePath: "lib/other.test.ts", content: `import x from "${EQ5E_B_MODULE}";` },
    ];
    expect(productionImportersOf(EQ5E_B_MODULE, synthetic)).toEqual([
      "app/api/example/route.ts",
    ]);
  });
});

// ============================================================================
// AN. Non-vacuity — every structural guard is proved able to fail
// ============================================================================

interface Regression {
  name: string;
  apply: (code: string) => string;
  breaks: string[];
}

const TYPE_IMPORT = `import type { PuttingEvidenceClassificationV1 } from "${EQ5E_A_MODULE}";`;

const REGRESSIONS: Regression[] = [
  {
    name: "the classification contract becomes a runtime import",
    apply: (code) =>
      code.replace(
        TYPE_IMPORT,
        `import { PUTTING_SIGNAL_CLASSIFICATION_VERSION, type PuttingEvidenceClassificationV1 } from "${EQ5E_A_MODULE}";`,
      ),
    breaks: [
      "depends on the classification contract only as a type",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a Supabase client is imported",
    apply: (code) => `import { createClient } from '@supabase/supabase-js';\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
      "reaches no database or persistence surface",
    ],
  },
  {
    name: "the model SDK is imported",
    apply: (code) => `import { SchemaType } from "@google/generative-ai";\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
      "reaches no model surface",
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
    name: "the analysis contract is imported",
    apply: (code) =>
      `import { PUTTING_SECTIONS } from "@/lib/putting-analysis-contract";\n${code}`,
    breaks: [
      "imports no framework, database, model, entitlement or node module",
      "has no runtime import of any kind",
    ],
  },
  {
    name: "a catalog table is queried",
    apply: (code) => `${code}\nconst rows = client.from("drills");\n`,
    breaks: ["reaches no database or persistence surface"],
  },
  {
    name: "practice state is written",
    apply: (code) => `${code}\nconst target = "user_drills";\n`,
    breaks: ["reaches no database or persistence surface"],
  },
  {
    name: "a model prompt appears",
    apply: (code) => `${code}\nconst promptText = "rank these";\n`,
    breaks: ["reaches no model surface"],
  },
  {
    name: "narrative prose is read",
    apply: (code) =>
      code.replace("observed_assessment: record.assessment,", "observed_assessment: record.observation,"),
    breaks: ["reads no narrative field"],
  },
  {
    name: "a grading score is introduced",
    apply: (code) => `${code}\nconst severityWeight = 1;\n`,
    breaks: ["grades nothing by confidence, severity or probability"],
  },
  {
    name: "results are sorted by runtime data",
    apply: (code) => `${code}\nconst ordered = [1, 2].sort();\n`,
    breaks: ["grades nothing by confidence, severity or probability"],
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
    name: "equipment reaches the ranking",
    apply: (code) => `${code}\nconst putterModel = "unknown";\n`,
    breaks: ["carries no equipment vocabulary"],
  },
  {
    name: "canonical catalog copy is duplicated",
    apply: (code) => `${code}\nconst label = "Eye-Line Setup Check";\n`,
    breaks: ["duplicates no canonical catalog copy"],
  },
  {
    name: "provenance is fabricated",
    apply: (code) => `${code}\nconst source_analysis_id = "made-up";\n`,
    breaks: ["fabricates no analysis provenance"],
  },
  {
    name: "a fifth catalog identity is added",
    apply: (code) =>
      `${code}\nconst extra = "25299bc9-cee3-5188-b01e-b678f3b5d5f2";\n`,
    breaks: ["carries exactly four catalog identities"],
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
    name: "the environment is read",
    apply: (code) => `${code}\nconst flag = process.env.SOMETHING;\n`,
    breaks: ["reaches no clock, randomness or environment"],
  },
  {
    name: "the mapping rules are exported",
    apply: (code) => code.replace("const MAPPING_RULES", "export const MAPPING_RULES"),
    breaks: ["exports exactly the frozen public surface", "keeps the mapping rules private"],
  },
  {
    name: "a diagnostic helper is exported",
    apply: (code) => `${code}\nexport function debugRules(): number {\n  return 4;\n}\n`,
    breaks: ["exports exactly the frozen public surface"],
  },
  {
    name: "the mapping is left unfrozen",
    apply: (code) =>
      code.replace(
        "const MAPPING_RULES: readonly MappingRule[] = Object.freeze([",
        "const MAPPING_RULES: readonly MappingRule[] = ([",
      ),
    breaks: ["freezes its mapping at load"],
  },
];

describe("EQ5E-B contract — guards are non-vacuous", () => {
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
