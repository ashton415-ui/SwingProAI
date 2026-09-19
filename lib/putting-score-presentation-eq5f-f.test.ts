import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isPersistedPuttingScoreV1,
  resolvePuttingScorePresentation,
} from "./putting-score-presentation-eq5f-f";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5F-F — presenting the persisted putting score
// ============================================================================
//
// Two kinds of proof live here and they are not interchangeable.
//
// The validator and resolver are exercised for real: a predicate is a claim
// about values, and only running it against values can establish what it
// accepts. Every rejection below is a distinct way a stored envelope can be
// wrong, because a validator that passes on one good input tells you nothing
// about the inputs it was written to refuse.
//
// The page, the card and the surfaces this slice must leave alone are proved
// against source text, because that is what they are — claims about what a file
// does — and each guard is replayed against a deliberately regressed copy held
// in memory, so a guard that would also pass on a violating file is caught.
//
// What this suite does NOT establish: that a golfer's browser renders anything.
// No DOM, no jsdom, no database, no network.

const MODULE = "lib/putting-score-presentation-eq5f-f.ts";
const CARD = "components/putting/PuttingScoreCard.tsx";
const PAGE = "app/(dashboard)/swings/[id]/page.tsx";

/** Surfaces EQ5F-F must leave alone. */
const PROGRESS_HUB = "app/(dashboard)/dashboard/page.tsx";
const TELEMETRY = "app/(dashboard)/telemetry/page.tsx";
const ANALYSIS_PANEL = "components/putting/PuttingAnalysisPanel.tsx";
const SCORER = "lib/putting-score-eq5f-d.ts";
const COMPOSER = "lib/putting-score-from-analysis-eq5f-e.ts";

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

const PUTTING_REGION_START = "PUTTING RESULT REGION";
const FULL_SWING_REGION_START = "FULL SWING REPORT REGION";
const SHARED_STATUS_REGION_START = "SHARED STATUS REGION";

function regionBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${PAGE}: missing region anchor ${startMarker}`).toBeGreaterThanOrEqual(0);
  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${PAGE}: missing region anchor ${endMarker}`).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}

const puttingRegion = (source: string): string =>
  regionBetween(source, PUTTING_REGION_START, FULL_SWING_REGION_START);

const fullSwingRegion = (source: string): string =>
  regionBetween(source, FULL_SWING_REGION_START, SHARED_STATUS_REGION_START);

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface LooseEnvelope {
  score_version: unknown;
  basis: unknown;
  source_classification_version: unknown;
  score: unknown;
  coverage: unknown;
}

function validEnvelope(): LooseEnvelope {
  return {
    score_version: 1,
    basis: "qualitative_classification_index",
    source_classification_version: 1,
    score: 92,
    coverage: { scorable_sections: 6, total_sections: 6, percent: 100 },
  };
}

function zeroCoverageEnvelope(): LooseEnvelope {
  return {
    score_version: 1,
    basis: "qualitative_classification_index",
    source_classification_version: 1,
    score: null,
    coverage: { scorable_sections: 0, total_sections: 6, percent: 0 },
  };
}

/** The valid envelope with one coverage member replaced. */
function withCoverage(patch: Record<string, unknown>): LooseEnvelope {
  const base = validEnvelope();
  return { ...base, coverage: { ...(base.coverage as object), ...patch } };
}

/**
 * A fixture reopened as a loose bag of keys, so the corruption cases below can
 * damage it.
 *
 * `LooseEnvelope` is an interface and therefore has no index signature, so the
 * widening goes through `unknown` -- the direct cast is the one TypeScript
 * rejects, and rightly. The same idiom the EQ5C-A consumer suite uses on the
 * persisted analysis payload.
 */
function mutableCopyOf(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

// ============================================================================
// A. The validator accepts exactly what EQ5F-E persists
// ============================================================================

describe("EQ5F-F validator — accepted envelopes", () => {
  it("accepts the runtime-proven production envelope", () => {
    expect(isPersistedPuttingScoreV1(validEnvelope())).toBe(true);
  });

  it("accepts a numeric zero when sections were scorable", () => {
    // A real stroke assessed and found wanting. Refusing it would hide the
    // worst result the scorer can produce.
    expect(isPersistedPuttingScoreV1({ ...validEnvelope(), score: 0 })).toBe(true);
  });

  it("accepts a valid zero-coverage envelope carrying a null score", () => {
    expect(isPersistedPuttingScoreV1(zeroCoverageEnvelope())).toBe(true);
  });

  it("accepts every coverage fraction whose percent agrees with it", () => {
    for (let scorable = 0; scorable <= 6; scorable += 1) {
      const envelope = {
        ...validEnvelope(),
        score: scorable === 0 ? null : 50,
        coverage: {
          scorable_sections: scorable,
          total_sections: 6,
          percent: Math.round((100 * scorable) / 6),
        },
      };
      expect(isPersistedPuttingScoreV1(envelope), `scorable=${scorable}`).toBe(true);
    }
  });
});

// ============================================================================
// B. The validator refuses everything else
// ============================================================================

const REJECTED: readonly { label: string; value: unknown }[] = [
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "an array", value: [] },
  { label: "a string", value: "92" },
  { label: "a number", value: 92 },
  {
    label: "a missing top-level key",
    value: (() => {
      const envelope = mutableCopyOf(validEnvelope());
      delete envelope.basis;
      return envelope;
    })(),
  },
  { label: "an extra top-level key", value: { ...validEnvelope(), tampered: true } },
  { label: "a wrong score_version", value: { ...validEnvelope(), score_version: 2 } },
  { label: "a string score_version", value: { ...validEnvelope(), score_version: "1" } },
  {
    label: "a wrong source_classification_version",
    value: { ...validEnvelope(), source_classification_version: 2 },
  },
  { label: "a wrong basis", value: { ...validEnvelope(), basis: "measured_index" } },
  { label: "a null coverage", value: { ...validEnvelope(), coverage: null } },
  { label: "an array coverage", value: { ...validEnvelope(), coverage: [] } },
  {
    label: "a coverage missing a key",
    value: (() => {
      const envelope = validEnvelope();
      const coverage = { ...(envelope.coverage as Record<string, unknown>) };
      delete coverage.percent;
      return { ...envelope, coverage };
    })(),
  },
  { label: "a coverage extra key", value: withCoverage({ tampered: true }) },
  { label: "total_sections other than 6", value: withCoverage({ total_sections: 5 }) },
  { label: "a non-integer scorable_sections", value: withCoverage({ scorable_sections: 5.5 }) },
  { label: "a negative scorable_sections", value: withCoverage({ scorable_sections: -1, percent: 0 }) },
  { label: "a scorable_sections above 6", value: withCoverage({ scorable_sections: 7 }) },
  { label: "a string scorable_sections", value: withCoverage({ scorable_sections: "6" }) },
  { label: "a non-integer percent", value: withCoverage({ percent: 99.5 }) },
  { label: "a negative percent", value: withCoverage({ percent: -1 }) },
  { label: "a percent above 100", value: withCoverage({ percent: 101 }) },
  { label: "a percent inconsistent with scorable_sections", value: withCoverage({ percent: 50 }) },
  { label: "a non-integer score", value: { ...validEnvelope(), score: 91.5 } },
  { label: "a NaN score", value: { ...validEnvelope(), score: Number.NaN } },
  { label: "a negative score", value: { ...validEnvelope(), score: -1 } },
  { label: "a score above 100", value: { ...validEnvelope(), score: 101 } },
  { label: "a string score", value: { ...validEnvelope(), score: "92" } },
  {
    label: "a null score while sections were scorable",
    value: { ...validEnvelope(), score: null },
  },
  {
    label: "a numeric score while no section was scorable",
    value: { ...zeroCoverageEnvelope(), score: 92 },
  },
];

describe("EQ5F-F validator — refused envelopes", () => {
  it.each(REJECTED.map((r) => r.label))("refuses %s", (label) => {
    const rejected = REJECTED.find((r) => r.label === label)!;
    expect(isPersistedPuttingScoreV1(rejected.value)).toBe(false);
  });

  it("refuses an inherited key standing in for an own key", () => {
    const envelope = mutableCopyOf(validEnvelope());
    delete envelope.basis;
    const withPrototype = Object.create({ basis: "qualitative_classification_index" }) as Record<
      string,
      unknown
    >;
    Object.assign(withPrototype, envelope);
    expect(isPersistedPuttingScoreV1(withPrototype)).toBe(false);
  });

  it("refuses a non-enumerable extra key riding along unseen", () => {
    const envelope = mutableCopyOf(validEnvelope());
    Object.defineProperty(envelope, "hidden", { value: true, enumerable: false });
    expect(isPersistedPuttingScoreV1(envelope)).toBe(false);
  });

  it("refuses a symbol extra key", () => {
    const envelope: Record<string | symbol, unknown> = mutableCopyOf(validEnvelope());
    envelope[Symbol("extra")] = true;
    expect(isPersistedPuttingScoreV1(envelope)).toBe(false);
  });
});

// ============================================================================
// C. The resolver
// ============================================================================

describe("EQ5F-F resolver", () => {
  it("returns null for a historical row that was never scored", () => {
    expect(resolvePuttingScorePresentation(null)).toBeNull();
  });

  it("returns null for a malformed envelope rather than repairing it", () => {
    expect(resolvePuttingScorePresentation({ ...validEnvelope(), tampered: true })).toBeNull();
  });

  it("returns null for an unsupported future version", () => {
    expect(resolvePuttingScorePresentation({ ...validEnvelope(), score_version: 2 })).toBeNull();
  });

  it("resolves a scored stroke to ready, carrying primitives only", () => {
    const state = resolvePuttingScorePresentation(validEnvelope());
    expect(state).toEqual({
      status: "ready",
      score: 92,
      scorableSections: 6,
      totalSections: 6,
    });
  });

  it("resolves a valid zero-coverage envelope to unavailable, never to zero", () => {
    const state = resolvePuttingScorePresentation(zeroCoverageEnvelope());
    expect(state).toEqual({ status: "unavailable", scorableSections: 0, totalSections: 6 });
    expect(state && "score" in state, "unavailable must carry no score").toBe(false);
  });

  it("carries no raw payload out of the module", () => {
    const state = resolvePuttingScorePresentation(validEnvelope());
    expect(state).not.toBeNull();
    const keys = Object.keys(state as object).sort();
    expect(keys).toEqual(["score", "scorableSections", "status", "totalSections"].sort());
    for (const banned of ["coverage", "basis", "score_version", "source_classification_version"]) {
      expect(state as object, `state must not carry ${banned}`).not.toHaveProperty(banned);
    }
  });

  it("hands back a frozen state a caller cannot edit", () => {
    const state = resolvePuttingScorePresentation(validEnvelope());
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("reads nothing but the value it was given", () => {
    // A stored analysis is not an argument to this function at all: there is
    // one parameter, and it is the score.
    expect(resolvePuttingScorePresentation.length).toBe(1);
  });
});

// ============================================================================
// D. The architectural contract
// ============================================================================

interface Sources {
  module: string;
  card: string;
  page: string;
  hub: string;
  telemetry: string;
  panel: string;
}

function liveSources(): Sources {
  return {
    module: readSource(MODULE),
    card: readSource(CARD),
    page: readSource(PAGE),
    hub: readSource(PROGRESS_HUB),
    telemetry: readSource(TELEMETRY),
    panel: readSource(ANALYSIS_PANEL),
  };
}

interface Guard {
  id: string;
  holds: (s: Sources) => boolean;
}

/** Score-band vocabulary this product has never defined. */
const BANNED_BAND_WORDS = ["Elite", "Excellent", "Average", "Poor", "Needs Work"] as const;

/** Ways a number could be mis-sold as a measurement. */
const BANNED_MEASUREMENT_WORDS = [
  "percentile",
  "strokes gained",
  "Strokes Gained",
  "make percentage",
  "handicap",
  "ranking",
] as const;

const GUARDS: readonly Guard[] = [
  {
    id: "1. the read module computes no score and imports no scorer",
    holds: (s) => {
      const code = stripComments(s.module);
      return [
        "computePuttingScoreV1",
        "computePuttingScoreFromAnalysisV1",
        "classifyPuttingEvidence",
        "projectPuttingDrillEvidence",
        "putting-score-from-analysis",
        "putting-signal-classification",
        "putting-drill-evidence",
      ].every((token) => !code.includes(token));
    },
  },
  {
    id: "2. the read module never reads the stored analysis",
    holds: (s) => {
      const code = stripComments(s.module);
      return !code.includes("putting_analysis") && !code.includes("putting-analysis-contract");
    },
  },
  {
    id: "3. the read module reaches no database, network or clock",
    holds: (s) => {
      const code = stripComments(s.module);
      return ["createClient", "supabase", "fetch(", "process.env", "Date.now", "Math.random"].every(
        (token) => !code.includes(token),
      );
    },
  },
  {
    id: "4. the accepted version, basis and section total come from the frozen scorer",
    holds: (s) =>
      s.module.includes('from "@/lib/putting-score-eq5f-d"') &&
      stripComments(s.module).includes("PUTTING_SCORE_VERSION") &&
      stripComments(s.module).includes("PUTTING_SCORE_BASIS") &&
      stripComments(s.module).includes("PUTTING_SCORE_TOTAL_SECTIONS"),
  },
  {
    id: "5. the validator is a type predicate, not a bare boolean",
    holds: (s) => s.module.includes("): value is PuttingScoreV1 {"),
  },
  {
    id: "6. exact own-key checking uses Reflect.ownKeys and hasOwnProperty",
    holds: (s) => {
      const code = stripComments(s.module);
      return code.includes("Reflect.ownKeys") && code.includes("hasOwnProperty");
    },
  },
  {
    id: "7. the card is a Server Component",
    holds: (s) => !s.card.includes('"use client"') && !s.card.includes("'use client'"),
  },
  {
    id: "8. the card uses no client runtime, data access or entitlement logic",
    holds: (s) => {
      const code = stripComments(s.card);
      return [
        "useState",
        "useEffect",
        "createClient",
        "supabase",
        "canUsePuttingAnalysis",
        "putting_score",
        "putting_analysis",
        "computePuttingScore",
        "resolvePuttingDrillRecommendations",
      ].every((token) => !code.includes(token));
    },
  },
  {
    id: "9. the card names the index and discloses what it is not",
    holds: (s) => {
      const code = stripComments(s.card);
      return (
        code.includes("Putting Stroke Index") &&
        code.includes("Not a calibrated measurement") &&
        code.includes("Qualitative coaching index")
      );
    },
  },
  {
    id: "10. the card never renders a percent glyph beside the index",
    holds: (s) => !stripComments(s.card).includes("%"),
  },
  {
    id: "11. the card invents no score bands and no measurement vocabulary",
    holds: (s) => {
      const code = stripComments(s.card);
      return (
        BANNED_BAND_WORDS.every((word) => !code.includes(word)) &&
        BANNED_MEASUREMENT_WORDS.every((word) => !code.includes(word))
      );
    },
  },
  {
    id: "12. the card reports coverage as a separate fraction",
    holds: (s) => {
      const code = stripComments(s.card);
      return code.includes("Coverage") && code.includes("of {total} sections");
    },
  },
  {
    id: "13. the unavailable state renders words rather than a zero",
    holds: (s) => {
      const code = stripComments(s.card);
      return code.includes("Score unavailable") && !/>\s*0\s*</.test(code);
    },
  },
  {
    id: "14. the page imports the card and the resolver exactly once each",
    holds: (s) =>
      countOccurrences(s.page, 'from "@/components/putting/PuttingScoreCard"') === 1 &&
      countOccurrences(s.page, 'from "@/lib/putting-score-presentation-eq5f-f"') === 1,
  },
  {
    id: "15. the page mounts the card exactly once, inside the putting region",
    holds: (s) =>
      countOccurrences(s.page, "<PuttingScoreCard") === 1 &&
      puttingRegion(s.page).includes("<PuttingScoreCard"),
  },
  {
    id: "16. the card is rendered above the qualitative analysis",
    holds: (s) => {
      const region = puttingRegion(s.page);
      const card = region.indexOf("<PuttingScoreCard");
      const panel = region.indexOf("<PuttingAnalysisPanel");
      return card >= 0 && panel > card;
    },
  },
  {
    id: "17. the full-swing report never renders the putting index",
    holds: (s) => !fullSwingRegion(s.page).includes("PuttingScoreCard"),
  },
  {
    id: "18. the page resolves the score on the server and computes none of it",
    holds: (s) => {
      const code = stripComments(s.page);
      return (
        code.includes("resolvePuttingScorePresentation(") &&
        ["computePuttingScoreV1", "computePuttingScoreFromAnalysisV1", "classifyPuttingEvidence", "projectPuttingDrillEvidence"].every(
          (token) => !code.includes(token),
        )
      );
    },
  },
  {
    id: "19. the page stays a Server Component",
    holds: (s) => !s.page.includes('"use client"'),
  },
  {
    id: "20. the score is resolved only from a ready putting state",
    holds: (s) => stripComments(s.page).includes('"analysis" in puttingState'),
  },
  {
    id: "21. the stored score is treated as untrusted transport",
    holds: (s) =>
      s.page.includes("(swing.putting_score ?? null) as Record<string, unknown> | null"),
  },
  {
    id: "22. no raw score payload is handed to the analysis panel",
    holds: (s) => {
      const region = puttingRegion(s.page);
      const mount = region.indexOf("<PuttingAnalysisPanel");
      if (mount < 0) return false;
      const props = region.slice(mount, region.indexOf("/>", mount));
      return props.includes("state={puttingState}") && !props.includes("putting_score") && !props.includes("score");
    },
  },
  {
    id: "23. the analysis panel contract is unchanged and score-free",
    holds: (s) => {
      const code = stripComments(s.panel);
      return (
        code.includes("interface PuttingAnalysisPanelProps {") &&
        code.includes("state: PuttingResultState;") &&
        !code.includes("putting_score") &&
        !code.includes("PuttingScore")
      );
    },
  },
  {
    id: "24. the page never falls back from the persisted score to the full-swing score",
    holds: (s) => {
      const region = puttingRegion(s.page);
      return !region.includes("swing.score") && !stripComments(s.page).includes("?? swing.score");
    },
  },
  {
    id: "25. the Progress Hub still consumes no putting score",
    holds: (s) => !s.hub.includes("putting_score") && !s.hub.includes("putting-score-"),
  },
  {
    id: "26. Telemetry still consumes no putting score",
    holds: (s) => !s.telemetry.includes("putting_score") && !s.telemetry.includes("putting-score-"),
  },
];

function guardById(id: string): Guard {
  const found = GUARDS.find((g) => g.id === id);
  if (!found) throw new Error(`unknown guard: ${id}`);
  return found;
}

describe("EQ5F-F — the architectural contract", () => {
  const sources = liveSources();

  it.each(GUARDS.map((g) => g.id))("%s", (id) => {
    expect(guardById(id).holds(sources), `"${id}" no longer holds`).toBe(true);
  });
});

// ============================================================================
// E. The canonical page is the single authorized consumer
// ============================================================================

describe("EQ5F-F — the score has exactly one golfer-facing consumer", () => {
  it("the swing detail page is that consumer", () => {
    const page = readSource(PAGE);
    expect(page).toContain("putting_score");
    expect(page).toContain("@/lib/putting-score-presentation-eq5f-f");
  });

  it("no other golfer-facing surface reads the column", () => {
    for (const surface of [PROGRESS_HUB, TELEMETRY, ANALYSIS_PANEL]) {
      const code = readSource(surface);
      expect(code, `${surface} must not consume the score`).not.toContain("putting_score");
      expect(code, `${surface} must not import a score module`).not.toContain("putting-score-");
    }
  });

  it("the scorer and composer remain free of presentation concerns", () => {
    for (const authority of [SCORER, COMPOSER]) {
      const code = readSource(authority);
      expect(code, `${authority} must not learn about the card`).not.toContain("PuttingScoreCard");
      expect(code, `${authority} must not learn about presentation`).not.toContain(
        "putting-score-presentation",
      );
    }
  });
});

// ============================================================================
// F. Non-vacuity
// ============================================================================

interface Regression {
  name: string;
  apply: (s: Sources) => Sources;
  breaks: string[];
}

const REGRESSIONS: readonly Regression[] = [
  {
    name: "the read module recomputes the score instead of reading it",
    apply: (s) => ({
      ...s,
      module: `import { computePuttingScoreV1 } from "@/lib/putting-score-eq5f-d";\n${s.module}`,
    }),
    breaks: ["1. the read module computes no score and imports no scorer"],
  },
  {
    name: "the read module reaches for the stored analysis",
    apply: (s) => ({ ...s, module: `${s.module}\nconst a = "putting_analysis";\n` }),
    breaks: ["2. the read module never reads the stored analysis"],
  },
  {
    name: "the read module reaches a database",
    apply: (s) => ({ ...s, module: `${s.module}\nconst c = createClient();\n` }),
    breaks: ["3. the read module reaches no database, network or clock"],
  },
  {
    name: "the accepted version is transcribed instead of imported",
    apply: (s) => ({
      ...s,
      module: s.module.replace('from "@/lib/putting-score-eq5f-d"', 'from "./nowhere"'),
    }),
    breaks: ["4. the accepted version, basis and section total come from the frozen scorer"],
  },
  {
    name: "the validator degrades to a bare boolean",
    apply: (s) => ({
      ...s,
      module: s.module.replace("): value is PuttingScoreV1 {", "): boolean {"),
    }),
    breaks: ["5. the validator is a type predicate, not a bare boolean"],
  },
  {
    name: "exact own-key checking is relaxed to Object.keys",
    apply: (s) => ({ ...s, module: s.module.split("Reflect.ownKeys").join("Object.keys") }),
    breaks: ["6. exact own-key checking uses Reflect.ownKeys and hasOwnProperty"],
  },
  {
    name: "the card becomes a Client Component",
    apply: (s) => ({ ...s, card: `"use client";\n${s.card}` }),
    breaks: ["7. the card is a Server Component"],
  },
  {
    name: "the card starts deciding entitlement",
    apply: (s) => ({ ...s, card: `${s.card}\nconst gate = canUsePuttingAnalysis;\n` }),
    breaks: ["8. the card uses no client runtime, data access or entitlement logic"],
  },
  {
    name: "the card drops the not-a-measurement disclosure",
    apply: (s) => ({
      ...s,
      card: s.card.replace("Not a calibrated measurement.", ""),
    }),
    breaks: ["9. the card names the index and discloses what it is not"],
  },
  {
    name: "the card renders the index as a percentage",
    apply: (s) => ({ ...s, card: s.card.replace("{state.score}", "{state.score}%") }),
    breaks: ["10. the card never renders a percent glyph beside the index"],
  },
  {
    name: "the card invents a score band",
    apply: (s) => ({ ...s, card: s.card.replace("Score unavailable", "Excellent") }),
    breaks: [
      "11. the card invents no score bands and no measurement vocabulary",
      "13. the unavailable state renders words rather than a zero",
    ],
  },
  {
    name: "the card folds coverage into the number",
    apply: (s) => ({ ...s, card: s.card.split("of {total} sections").join("sections") }),
    breaks: ["12. the card reports coverage as a separate fraction"],
  },
  {
    name: "the page imports the card twice",
    apply: (s) => ({
      ...s,
      page: `${s.page}\nimport { PuttingScoreCard } from "@/components/putting/PuttingScoreCard";\n`,
    }),
    breaks: ["14. the page imports the card and the resolver exactly once each"],
  },
  {
    name: "the card is mounted a second time",
    apply: (s) => ({ ...s, page: `${s.page}\nconst extra = "<PuttingScoreCard />";\n` }),
    breaks: ["15. the page mounts the card exactly once, inside the putting region"],
  },
  {
    name: "the card is moved below the qualitative analysis",
    apply: (s) => {
      const region = puttingRegion(s.page);
      const card = region.indexOf("<PuttingScoreCard");
      const end = region.indexOf("</div>", card) + "</div>".length;
      const block = region.slice(card, end);
      const moved = `${region.slice(0, card)}${region.slice(end)}${block}`;
      return { ...s, page: s.page.replace(region, moved) };
    },
    breaks: ["16. the card is rendered above the qualitative analysis"],
  },
  {
    name: "the full-swing report starts rendering the putting index",
    apply: (s) => ({
      ...s,
      page: s.page.replace(FULL_SWING_REGION_START, `${FULL_SWING_REGION_START} PuttingScoreCard`),
    }),
    breaks: ["17. the full-swing report never renders the putting index"],
  },
  {
    name: "the page recomputes the score at read time",
    apply: (s) => ({
      ...s,
      page: s.page.replace(
        "resolvePuttingScorePresentation(",
        "computePuttingScoreFromAnalysisV1(",
      ),
    }),
    breaks: ["18. the page resolves the score on the server and computes none of it"],
  },
  {
    name: "the page becomes a Client Component",
    apply: (s) => ({ ...s, page: `"use client";\n${s.page}` }),
    breaks: ["19. the page stays a Server Component"],
  },
  {
    name: "the score is resolved without a ready analysis state",
    apply: (s) => ({
      ...s,
      page: s.page.split('"analysis" in puttingState').join("true"),
    }),
    breaks: ["20. the score is resolved only from a ready putting state"],
  },
  {
    name: "the stored score is trusted as a typed value",
    apply: (s) => ({
      ...s,
      page: s.page.replace(
        "(swing.putting_score ?? null) as Record<string, unknown> | null",
        "swing.putting_score as never",
      ),
    }),
    breaks: ["21. the stored score is treated as untrusted transport"],
  },
  {
    name: "the raw score is handed to the analysis panel",
    apply: (s) => ({
      ...s,
      page: s.page.replace(
        "<PuttingAnalysisPanel state={puttingState} />",
        "<PuttingAnalysisPanel state={puttingState} putting_score={rawPuttingScore} />",
      ),
    }),
    breaks: ["22. no raw score payload is handed to the analysis panel"],
  },
  {
    name: "the analysis panel learns about the score",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst leak = "putting_score";\n` }),
    breaks: ["23. the analysis panel contract is unchanged and score-free"],
  },
  {
    name: "the putting region falls back to the full-swing score",
    apply: (s) => {
      const region = puttingRegion(s.page);
      return {
        ...s,
        page: s.page.replace(region, `${region}\n{swing.score}\n`),
      };
    },
    breaks: ["24. the page never falls back from the persisted score to the full-swing score"],
  },
  {
    name: "the Progress Hub starts consuming the score",
    apply: (s) => ({ ...s, hub: `${s.hub}\nconst h = "putting_score";\n` }),
    breaks: ["25. the Progress Hub still consumes no putting score"],
  },
  {
    name: "Telemetry starts consuming the score",
    apply: (s) => ({ ...s, telemetry: `${s.telemetry}\nconst t = "putting_score";\n` }),
    breaks: ["26. Telemetry still consumes no putting score"],
  },
];

describe("EQ5F-F — the architectural contract is non-vacuous", () => {
  const live = liveSources();

  it("every guard holds against the real, unmodified sources", () => {
    const failing = GUARDS.filter((g) => !g.holds(live)).map((g) => g.id);
    expect(failing, "the compliant sources must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((r) => r.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((r) => r.name === name)!;
    const mutated = regression.apply(live);

    const changed = (Object.keys(live) as (keyof Sources)[]).some(
      (key) => mutated[key] !== live[key],
    );
    expect(changed, `"${name}" altered no source — the simulation anchor is stale`).toBe(true);

    for (const id of regression.breaks) {
      expect(
        guardById(id).holds(mutated),
        `"${name}" was not detected by guard "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });

  it("every guard participates in at least one regression", () => {
    const exercised = new Set(REGRESSIONS.flatMap((r) => r.breaks));
    const unexercised = GUARDS.map((g) => g.id).filter((id) => !exercised.has(id));
    expect(unexercised, "a guard nothing can break is a guard that proves nothing").toEqual([]);
  });

  it("every regression names only guards that exist", () => {
    const known = new Set(GUARDS.map((g) => g.id));
    const unknown = REGRESSIONS.flatMap((r) => r.breaks).filter((id) => !known.has(id));
    expect(unknown, "a regression naming a nonexistent guard silently proves nothing").toEqual([]);
  });
});

// ============================================================================
// What this suite does not prove
// ============================================================================
//
//   * that a browser renders the card — no DOM is mounted anywhere here
//   * that any production row carries a score — no database is contacted
//   * that the score is correct for a stroke. EQ5F-D owns the arithmetic and
//     EQ5F-E proved the persisted value against it; this slice only decides
//     whether a stored envelope may be shown, and what it is called
