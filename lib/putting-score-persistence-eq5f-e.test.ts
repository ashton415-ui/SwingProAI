import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computePuttingScoreFromAnalysisV1 } from "./putting-score-from-analysis-eq5f-e";
import { computePuttingScoreV1 } from "./putting-score-eq5f-d";
import { PUTTING_SECTIONS, type PersistedPuttingAnalysisV1 } from "./putting-analysis-contract";
import { APPROVED_MIGRATIONS, EXPECTED_MIGRATION_COUNT } from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5F-E — versioned putting score persistence
// ============================================================================
//
// EQ5F-D built a scorer and left it dormant. EQ5F-E is the slice that actually
// stores a score, and storing one raises a question the pure scorer never had
// to answer: who is allowed to say what a golfer's score is?
//
// The answer is the server, and only the server. The analysis route runs as the
// signed-in golfer, and under this table's RLS an owner may update their own
// row — so a new column would be authorable from a browser by default. The
// database therefore refuses a first write that did not arrive as the trusted
// server role, and refuses any later change to a score that already exists.
//
// Two kinds of proof live here and they are not interchangeable:
//
//   * the arithmetic and the fail-closed behaviour are proved by running the
//     real composer. A source contract cannot establish what a number is.
//   * the route wiring, the migration and the architectural boundaries are
//     proved against source text, because that is what they are — claims about
//     what a file does, replayed against deliberately regressed copies held in
//     memory so a guard that would also pass on a violating file is caught.
//
// What this suite does NOT establish, stated plainly: the hosted role
// semantics. That `current_user` is `service_role` for a service-role Data API
// request is release-managed platform authority, asserted here only as source.
// No database is contacted. Exercising it for real is the separate, mandatory
// staging database gate.

const COMPOSER = "lib/putting-score-from-analysis-eq5f-e.ts";
const ROUTE = "app/api/analyze-swing/route.ts";
const MIGRATION = "supabase/migrations/20260918154500_putting_score_eq5f_e.sql";
const INVENTORY = "lib/migration-inventory.ts";
const TYPES = "types/database.ts";

/** Read-only witnesses: files EQ5F-E must leave alone. */
const CONTRACT_V1 = "lib/putting-analysis-contract.ts";
const RECOMMENDATION_AUTHORITY = "lib/putting-recommendation-authority-eq5e-c.ts";
const CANONICAL_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const PROGRESS_HUB = "app/(dashboard)/dashboard/page.tsx";
const TELEMETRY = "app/(dashboard)/telemetry/page.tsx";

const RETAINED_FIXTURE_ID = "1dbebcb8-5c20-4fd4-9a42-42090806d1e9";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** SQL comments, so a rule the migration explains in prose is not read as a
 *  rule it breaks. */
function stripSqlComments(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, " ");
}

function countLiteral(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

/** The route-local putting helper only, as the router suite isolates it. */
function puttingHelper(route: string): string {
  const start = route.indexOf("async function runPuttingAnalysis(");
  if (start < 0) return "";
  const end = route.indexOf("export async function POST(", start);
  if (end < 0) return "";
  return route.slice(start, end);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Assessments are the real vocabulary from the EQ5B contract, chosen for the
// classification each produces. Nothing here restates the mapping itself: the
// suite asserts scores through the real composer, so a change to the mapping
// shows up as a changed score rather than as a stale copy of a table.

const STRENGTH_ASSESSMENT: Record<string, string> = {
  setup_alignment: "sound",
  stroke_path: "straight",
  face_at_impact: "appears_square",
  tempo_rhythm: "smooth",
  stroke_symmetry: "balanced",
  stability: "stable",
};

const NEEDS_IMPROVEMENT_ASSESSMENT: Record<string, string> = {
  setup_alignment: "needs_attention",
  stroke_path: "out_to_in",
  face_at_impact: "appears_open",
  tempo_rhythm: "rushed",
  stroke_symmetry: "uneven",
  stability: "head_motion",
};

function analysisWith(assessments: Record<string, string>): PersistedPuttingAnalysisV1 {
  const sections: Record<string, { assessment: string; observation: string }> = {};
  for (const section of PUTTING_SECTIONS) {
    sections[section] = {
      assessment: assessments[section],
      observation: "The stroke was described in ordinary words.",
    };
  }
  return {
    schema_version: 1,
    evidence_basis: "ai_video_analysis_uncalibrated",
    numeric_measurements: {
      putt_tempo_ratio: "unavailable",
      face_angle_at_impact_deg: "unavailable",
      path_deviation_mm: "unavailable",
    },
    summary: "A steady stroke described qualitatively.",
    ...sections,
    primary_finding: "The stroke held its line.",
    practice_focus: "Keep the head still through the stroke.",
  } as PersistedPuttingAnalysisV1;
}

function uniformAnalysis(assessment: string): PersistedPuttingAnalysisV1 {
  const map: Record<string, string> = {};
  for (const section of PUTTING_SECTIONS) map[section] = assessment;
  return analysisWith(map);
}

/** A classification envelope built directly, for the one case the persisted
 *  vocabulary cannot reach (see the all-acceptable test below). */
function classificationOf(classification: string): unknown {
  const sections: Record<string, unknown> = {};
  for (const section of PUTTING_SECTIONS) {
    sections[section] = { assessment: "recorded", classification };
  }
  return { classification_version: 1, sections };
}

// ============================================================================
// A. The composer — proved by execution
// ============================================================================

describe("EQ5F-E composer — deterministic score from a persisted analysis", () => {
  it("every implementation path exists", () => {
    for (const file of [COMPOSER, ROUTE, MIGRATION, INVENTORY, TYPES]) {
      expect(existsSync(path.join(repoRoot, file)), `missing file: ${file}`).toBe(true);
    }
  });

  it("scores an all-strength analysis 100 with full coverage", () => {
    const result = computePuttingScoreFromAnalysisV1(analysisWith(STRENGTH_ASSESSMENT), "a-1");
    expect(result).not.toBeNull();
    expect(result).toEqual({
      score_version: 1,
      basis: "qualitative_classification_index",
      source_classification_version: 1,
      score: 100,
      coverage: { scorable_sections: 6, total_sections: 6, percent: 100 },
    });
  });

  it("scores an all-needs-improvement analysis 0 with full coverage", () => {
    const result = computePuttingScoreFromAnalysisV1(
      analysisWith(NEEDS_IMPROVEMENT_ASSESSMENT),
      "a-2",
    )!;
    expect(result.score).toBe(0);
    expect(result.coverage).toEqual({ scorable_sections: 6, total_sections: 6, percent: 100 });
  });

  it("scores an evenly split analysis 50", () => {
    const mixed: Record<string, string> = {
      setup_alignment: STRENGTH_ASSESSMENT.setup_alignment,
      stroke_path: STRENGTH_ASSESSMENT.stroke_path,
      face_at_impact: STRENGTH_ASSESSMENT.face_at_impact,
      tempo_rhythm: NEEDS_IMPROVEMENT_ASSESSMENT.tempo_rhythm,
      stroke_symmetry: NEEDS_IMPROVEMENT_ASSESSMENT.stroke_symmetry,
      stability: NEEDS_IMPROVEMENT_ASSESSMENT.stability,
    };
    expect(computePuttingScoreFromAnalysisV1(analysisWith(mixed), "a-3")!.score).toBe(50);
  });

  it("scores an all-acceptable classification 50, which no persisted analysis can reach", () => {
    // Worth stating rather than hiding: "acceptable" is produced by exactly one
    // assessment in the whole vocabulary — stroke_path "arc". An all-acceptable
    // analysis therefore cannot exist, so the arithmetic is proved against the
    // classification envelope directly instead of against an impossible fixture.
    expect(computePuttingScoreV1(classificationOf("acceptable"))!.score).toBe(50);

    const arcEverywhere = computePuttingScoreFromAnalysisV1(uniformAnalysis("arc"), "a-4")!;
    expect(arcEverywhere.coverage.scorable_sections).toBe(1);
    expect(arcEverywhere.score).toBe(50);
  });

  it("returns a valid zero-coverage envelope when nothing could be read", () => {
    const result = computePuttingScoreFromAnalysisV1(uniformAnalysis("unclear"), "a-5")!;
    expect(result).not.toBeNull();
    expect(result.score).toBeNull();
    expect(result.coverage).toEqual({ scorable_sections: 0, total_sections: 6, percent: 0 });
  });

  it("excludes unreadable sections rather than scoring them zero", () => {
    const oneStrength: Record<string, string> = {
      setup_alignment: STRENGTH_ASSESSMENT.setup_alignment,
      stroke_path: "unclear",
      face_at_impact: "unavailable",
      tempo_rhythm: "unclear",
      stroke_symmetry: "unclear",
      stability: "unavailable",
    };
    const result = computePuttingScoreFromAnalysisV1(analysisWith(oneStrength), "a-6")!;
    expect(result.score).toBe(100);
    expect(result.coverage).toEqual({ scorable_sections: 1, total_sections: 6, percent: 17 });
  });

  it("returns outer null for a malformed analysis rather than throwing", () => {
    for (const malformed of [
      {},
      { schema_version: 1 },
      null,
      { ...analysisWith(STRENGTH_ASSESSMENT), stability: undefined },
    ]) {
      let result: unknown;
      expect(() => {
        result = computePuttingScoreFromAnalysisV1(
          malformed as unknown as PersistedPuttingAnalysisV1,
          "a-7",
        );
      }).not.toThrow();
      expect(result).toBeNull();
    }
  });

  it("distinguishes a refused pipeline from an unreadable stroke", () => {
    expect(
      computePuttingScoreFromAnalysisV1({} as unknown as PersistedPuttingAnalysisV1, "a-8"),
    ).toBeNull();
    expect(computePuttingScoreFromAnalysisV1(uniformAnalysis("unclear"), "a-9")).not.toBeNull();
  });

  it("is deterministic and ignores the provenance id", () => {
    const analysis = analysisWith(STRENGTH_ASSESSMENT);
    const first = computePuttingScoreFromAnalysisV1(analysis, "a-10");
    expect(computePuttingScoreFromAnalysisV1(analysis, "a-10")).toEqual(first);
    expect(computePuttingScoreFromAnalysisV1(analysis, "completely-different")).toEqual(first);
  });

  it("freezes what it returns", () => {
    const result = computePuttingScoreFromAnalysisV1(analysisWith(STRENGTH_ASSESSMENT), "a-11")!;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.coverage)).toBe(true);
  });

  it("does not mutate the analysis it was handed", () => {
    const analysis = analysisWith(STRENGTH_ASSESSMENT);
    const before = JSON.stringify(analysis);
    computePuttingScoreFromAnalysisV1(analysis, "a-12");
    expect(JSON.stringify(analysis)).toBe(before);
  });
});

// ============================================================================
// B. Architectural guards — replayed against regressed source
// ============================================================================

interface Sources {
  composer: string;
  route: string;
  migration: string;
  inventory: string;
  types: string;
}

function liveSources(): Sources {
  return {
    composer: readSource(COMPOSER),
    route: readSource(ROUTE),
    migration: readSource(MIGRATION),
    inventory: readSource(INVENTORY),
    types: readSource(TYPES),
  };
}

interface Guard {
  id: string;
  holds: (s: Sources) => boolean;
}

const SCORING_ALGORITHM_TOKENS = [
  "strength",
  "acceptable",
  "needs_improvement",
  "insufficient_evidence",
  "Math.round",
  "pointSum",
];

const GUARDS: Guard[] = [
  {
    id: "1. the composer uses the evidence projector",
    holds: (s) => stripComments(s.composer).includes("projectPuttingDrillEvidence(persisted, sourceAnalysisId)"),
  },
  {
    id: "2. the composer uses the signal classifier",
    holds: (s) => stripComments(s.composer).includes("classifyPuttingEvidence(evidence)"),
  },
  {
    id: "3. the composer uses the EQ5F-D scorer",
    holds: (s) => stripComments(s.composer).includes("computePuttingScoreV1(classification)"),
  },
  {
    id: "4. the composer duplicates no scoring algorithm",
    holds: (s) => {
      const code = stripComments(s.composer);
      return SCORING_ALGORITHM_TOKENS.every((token) => !code.includes(token));
    },
  },
  {
    id: "5. the composer imports the model contract type-only",
    holds: (s) => {
      const code = stripComments(s.composer);
      return (
        code.includes('import type { PersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract"') &&
        !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/putting-analysis-contract"/m.test(code)
      );
    },
  },
  {
    id: "6. the composer touches no database, network, clock or environment",
    holds: (s) => {
      const code = stripComments(s.composer);
      return ["supabase", "createClient", "fetch(", "process.env", "Date.now", "new Date", "Math.random", "console."].every(
        (token) => !code.includes(token),
      );
    },
  },
  {
    id: "7. the composer never consults a recommendation",
    holds: (s) => {
      const code = stripComments(s.composer);
      // The word "drill" cannot be the ban: the evidence projector this module
      // is required to call lives in putting-drill-evidence, and a rule that
      // forbids a shared word would forbid the correct implementation. The
      // recommendation layer is named exactly instead.
      return [
        "rankPuttingDrillRecommendations",
        "resolvePuttingDrillRecommendations",
        "putting-drill-recommendation",
        "putting-recommendation-authority",
      ].every((token) => !code.includes(token));
    },
  },
  {
    id: "8. the route derives the score after validation and envelope construction",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      const validate = helper.indexOf("validatePuttingModelResponse(puttingParsed)");
      const build = helper.indexOf("buildPersistedPuttingAnalysis(puttingValidated.response)");
      const score = helper.indexOf("computePuttingScoreFromAnalysisV1(persistedPuttingAnalysis");
      return validate >= 0 && build > validate && score > build;
    },
  },
  {
    id: "9. the route fails closed when the score is unavailable",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      const guard = helper.indexOf("if (puttingScore === null)");
      const admin = helper.indexOf("createAdminClient()");
      return guard >= 0 && admin > guard && helper.slice(guard, admin).includes("markFailed()");
    },
  },
  {
    id: "10. the elevated client is constructed exactly once, for the completion write",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      const admin = helper.indexOf("createAdminClient()");
      const write = helper.indexOf("putting_score: puttingScore,");
      return countLiteral(helper, "createAdminClient()") === 1 && admin >= 0 && write > admin;
    },
  },
  {
    id: "11. the completion write sets exactly the three success fields",
    holds: (s) => {
      const helper = puttingHelper(s.route);
      const write = helper.indexOf("putting_score: puttingScore,");
      if (write < 0) return false;
      const start = helper.lastIndexOf(".update({", write);
      const end = helper.indexOf("})", write);
      if (start < 0 || end < 0) return false;
      const payload = helper.slice(start, end);
      const keys = (payload.match(/^\s{8}([a-z_]+):/gm) ?? []).map((l) => l.trim().replace(":", ""));
      return (
        keys.length === 3 &&
        keys.includes("status") &&
        keys.includes("putting_analysis") &&
        keys.includes("putting_score")
      );
    },
  },
  {
    id: "12. the completion write is bounded by row, owner, family and absent score",
    holds: (s) => {
      const helper = puttingHelper(s.route);
      const write = helper.indexOf("putting_score: puttingScore,");
      if (write < 0) return false;
      const region = helper.slice(write, write + 600);
      return [
        '.eq("id", analysisId)',
        '.eq("user_id", authenticatedUserId)',
        '.eq("analysis_family", "putting")',
        '.is("putting_score", null)',
        ".select()",
      ].every((filter) => region.includes(filter));
    },
  },
  {
    id: "13. exactly one affected row is required, and zero cannot pass",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      return (
        helper.includes("Array.isArray(puttingUpdatedRows)") &&
        helper.includes("puttingUpdatedRows.length !== 1") &&
        helper.includes("puttingUpdatedRows[0]")
      );
    },
  },
  {
    id: "14. the authenticated user id is threaded into the putting helper",
    holds: (s) => {
      const code = stripComments(s.route);
      return (
        code.includes("authenticatedUserId: string,") &&
        code.includes("runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)")
      );
    },
  },
  {
    id: "15. the cache hit still returns before any privileged work",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      const cache = helper.indexOf("isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)");
      const admin = helper.indexOf("createAdminClient()");
      return cache >= 0 && admin > cache;
    },
  },
  {
    id: "16. the route never logs the score envelope",
    holds: (s) => {
      const helper = stripComments(puttingHelper(s.route));
      return !/console\.[a-z]+\([^)]*puttingScore/.test(helper);
    },
  },
  {
    id: "17. the full-swing completion payload writes no putting score",
    holds: (s) => {
      const code = stripComments(s.route);
      const payload = code.indexOf("const payload = {");
      if (payload < 0) return false;
      return !code.slice(payload, code.indexOf("};", payload)).includes("putting_score");
    },
  },
  {
    id: "18. the migration adds one nullable jsonb column with no default",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        /alter table public\.swing_analysis\s+add column putting_score jsonb;/.test(sql) &&
        !/putting_score jsonb[^;]*default/i.test(sql) &&
        !/putting_score jsonb[^;]*not null/i.test(sql)
      );
    },
  },
  {
    id: "19. the migration backfills nothing",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return !/update\s+public\.swing_analysis\s+set/i.test(sql);
    },
  },
  {
    id: "20. the guard function and trigger carry the frozen names",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("create function public.guard_swing_analysis_putting_score()") &&
        sql.includes("create trigger swing_analysis_guard_putting_score") &&
        /before update of putting_score on public\.swing_analysis/.test(sql) &&
        sql.includes("for each row execute function public.guard_swing_analysis_putting_score()")
      );
    },
  },
  {
    id: "21. the guard is SECURITY INVOKER with an empty search_path",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("security invoker") &&
        sql.includes("set search_path to ''") &&
        !/security definer/i.test(sql)
      );
    },
  },
  {
    id: "22. the first non-null write requires the service role via current_user",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return /current_user::text <> 'service_role'/.test(sql);
    },
  },
  {
    id: "23. no weaker signal stands in for server authorship",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return ["session_user", "auth.uid()", "auth.role()", "app_metadata", "request.jwt"].every(
        (token) => !sql.includes(token),
      );
    },
  },
  {
    id: "24. the score is write-once for every role",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("if old.putting_score is not null then") &&
        /write-once|cannot be changed/i.test(sql) &&
        sql.includes("new.putting_score is not distinct from old.putting_score")
      );
    },
  },
  {
    id: "25. a score is accepted only on a putting analysis",
    holds: (s) => stripSqlComments(s.migration).includes("new.analysis_family is distinct from 'putting'"),
  },
  {
    id: "26. the stored envelope's exact key sets are enforced",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("'basis', 'coverage', 'score', 'score_version', 'source_classification_version'") &&
        sql.includes("'percent', 'scorable_sections', 'total_sections'")
      );
    },
  },
  {
    id: "27. the frozen versions, basis and section total are enforced",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("(new.putting_score -> 'score_version') is distinct from '1'::jsonb") &&
        sql.includes("(new.putting_score -> 'source_classification_version') is distinct from '1'::jsonb") &&
        sql.includes("'\"qualitative_classification_index\"'::jsonb") &&
        sql.includes("(v_coverage -> 'total_sections') is distinct from '6'::jsonb")
      );
    },
  },
  {
    id: "28. numeric ranges are enforced and malformed numbers fail before any cast",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("!~ '^[0-9]+$'") &&
        sql.includes("v_scorable < 0 or v_scorable > 6") &&
        sql.includes("v_percent < 0 or v_percent > 100")
      );
    },
  },
  {
    id: "29. a null score and zero scorable sections are required to agree",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("if v_scorable <> 0 then") &&
        sql.includes("if v_scorable = 0 then")
      );
    },
  },
  {
    id: "30. the migration encodes no scoring algorithm",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        !/'strength'/.test(sql) &&
        !/'acceptable'/.test(sql) &&
        !/'needs_improvement'/.test(sql) &&
        !/pointSum/i.test(sql) &&
        !/100\s*\*/.test(sql) &&
        !/round\s*\(/i.test(sql)
      );
    },
  },
  {
    id: "31. direct EXECUTE is withdrawn from the browser-reachable roles",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return ["from public;", "from anon;", "from authenticated;"].every((suffix) =>
        sql.includes(`revoke all on function public.guard_swing_analysis_putting_score() ${suffix}`),
      );
    },
  },
  {
    id: "32. the migration adds no policy and changes no table grant",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        !/create policy/i.test(sql) &&
        !/alter policy/i.test(sql) &&
        !/drop policy/i.test(sql) &&
        !/grant .* on public\.swing_analysis/i.test(sql)
      );
    },
  },
  {
    id: "33. the migration touches no neighbouring column",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return [
        "putt_analytics",
        "putt_tempo_ratio",
        "face_angle_at_impact_deg",
        "path_deviation_mm",
        "equipment_snapshot",
      ].every((column) => !sql.includes(column));
    },
  },
  {
    id: "34. the retained production fixture appears nowhere in the change",
    holds: (s) =>
      !s.migration.includes(RETAINED_FIXTURE_ID) &&
      !s.route.includes(RETAINED_FIXTURE_ID) &&
      !s.composer.includes(RETAINED_FIXTURE_ID),
  },
  {
    id: "35. the migration is registered exactly once in the inventory",
    holds: (s) =>
      countLiteral(s.inventory, '"20260918154500_putting_score_eq5f_e.sql"') === 1 &&
      countLiteral(s.inventory, "PUTTING_SCORE_EQ5F_E_FILENAME,") === 1,
  },
  {
    id: "36. the inventory count stays derived",
    holds: (s) => s.inventory.includes("EXPECTED_MIGRATION_COUNT = APPROVED_MIGRATIONS.length"),
  },
  {
    id: "37. the database type gains exactly one nullable putting_score field",
    holds: (s) => countLiteral(s.types, "putting_score: Record<string, unknown> | null;") === 1,
  },
  {
    // Guard 21 proves the migration *declares* `set search_path to ''`. This
    // guard is about a different thing: the literal the postflight compares
    // pg_proc.proconfig against. PostgreSQL does not store an empty search_path
    // as the bare `search_path=` — it stores the quoted empty identifier, so on
    // PostgreSQL 17.6 proconfig reads `search_path=""`. A postflight testing the
    // bare form therefore rejects a correctly pinned function every time. That
    // is not hypothetical: it is exactly how this migration's first staging
    // application failed, with the function created correctly and EQ5FE-POST-6
    // raised anyway.
    //
    // This stays a source contract. It pins the serialization the postflight
    // must name; it does not execute SQL. Whether the migration actually applies
    // remains provable only by the hosted staging database gate.
    id: "38. the postflight compares proconfig against PostgreSQL's stored empty search_path",
    holds: (s) => {
      const sql = stripSqlComments(s.migration);
      return (
        sql.includes("'search_path=\"\"' = any(v_config)") &&
        !sql.includes("'search_path=' = any(")
      );
    },
  },
];

function guardById(id: string): Guard {
  const found = GUARDS.find((g) => g.id === id);
  if (!found) throw new Error(`unknown guard: ${id}`);
  return found;
}

describe("EQ5F-E — the architectural contract", () => {
  const sources = liveSources();

  it.each(GUARDS.map((g) => g.id))("%s", (id) => {
    expect(guardById(id).holds(sources), `"${id}" no longer holds`).toBe(true);
  });
});

// ============================================================================
// C. Boundaries — what EQ5F-E must leave untouched
// ============================================================================

describe("EQ5F-E — untouched boundaries", () => {
  it("the persisted V1 contract keeps its exact-key validator", () => {
    const contract = readSource(CONTRACT_V1);
    expect(contract).toContain("export function isPersistedPuttingAnalysisV1(");
    expect(contract).toContain("PERSISTED_TOP_LEVEL_KEYS");
    expect(contract, "the V1 envelope must not learn about scores").not.toContain("putting_score");
    expect(contract).not.toContain("score_version");
  });

  it("the recommendation authority is independent of the score", () => {
    const authority = readSource(RECOMMENDATION_AUTHORITY);
    expect(authority).not.toContain("putting_score");
    expect(authority).not.toContain("computePuttingScore");
  });

  it("no consumer surface renders a score", () => {
    for (const surface of [CANONICAL_PAGE, PROGRESS_HUB, TELEMETRY]) {
      const code = readSource(surface);
      expect(code, `${surface} must not consume the score yet`).not.toContain("putting_score");
      expect(code, `${surface} must not import the scorer`).not.toContain("putting-score-");
    }
  });

  it("Telemetry still selects its own explicit column list", () => {
    const telemetry = readSource(TELEMETRY);
    expect(telemetry).toContain("analysis_family, equipment_snapshot,");
    expect(telemetry).not.toContain("putting_score");
  });

  it("the new migration is the last approved one and is present on disk", () => {
    const filename = "20260918154500_putting_score_eq5f_e.sql";
    expect(APPROVED_MIGRATIONS).toContain(filename);
    expect(APPROVED_MIGRATIONS.filter((m) => m === filename)).toHaveLength(1);
    expect(APPROVED_MIGRATIONS[APPROVED_MIGRATIONS.length - 1]).toBe(filename);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
    for (const other of APPROVED_MIGRATIONS.slice(0, -1)) {
      expect(filename > other, `${filename} must sort after ${other}`).toBe(true);
    }
    expect(existsSync(path.join(repoRoot, "supabase", "migrations", filename))).toBe(true);
  });

  it("states plainly which part of the guard is not proved locally", () => {
    // The hosted role semantics are release-managed authority. This suite
    // asserts the migration's source rule and nothing about a live database.
    const sql = readSource(MIGRATION);
    // The phrase wraps across two comment lines, so this matches across the
    // break rather than pinning the assertion to the file's current wrapping.
    expect(sql).toMatch(/staging[\s\S]{0,40}database gate/i);
    expect(sql).toMatch(/does not and cannot prove it by itself/i);
  });
});

// ============================================================================
// D. Non-vacuity
// ============================================================================

interface Regression {
  name: string;
  apply: (s: Sources) => Sources;
  breaks: string[];
}

const REGRESSIONS: Regression[] = [
  {
    name: "the composer inlines the point table instead of calling the scorer",
    apply: (s) => ({
      ...s,
      composer: s.composer.replace(
        "return computePuttingScoreV1(classification);",
        "const points = { strength: 2, acceptable: 1, needs_improvement: 0 };\n    return points as never;",
      ),
    }),
    breaks: ["3. the composer uses the EQ5F-D scorer", "4. the composer duplicates no scoring algorithm"],
  },
  {
    name: "the composer skips the projector",
    apply: (s) => ({
      ...s,
      composer: s.composer.replace("projectPuttingDrillEvidence(persisted, sourceAnalysisId)", "persisted as never"),
    }),
    breaks: ["1. the composer uses the evidence projector"],
  },
  {
    name: "the composer skips the classifier",
    apply: (s) => ({
      ...s,
      composer: s.composer.replace("classifyPuttingEvidence(evidence)", "evidence as never"),
    }),
    breaks: ["2. the composer uses the signal classifier"],
  },
  {
    name: "the composer imports the model contract at runtime",
    apply: (s) => ({
      ...s,
      composer: s.composer.replace(
        'import type { PersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";',
        'import { PUTTING_SECTIONS, type PersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";',
      ),
    }),
    breaks: ["5. the composer imports the model contract type-only"],
  },
  {
    name: "the composer reaches for a database",
    apply: (s) => ({
      ...s,
      composer: `import { createClient } from "@/utils/supabase/server";\n${s.composer}`,
    }),
    breaks: ["6. the composer touches no database, network, clock or environment"],
  },
  {
    name: "the composer consults a recommendation",
    apply: (s) => ({
      ...s,
      composer: s.composer.replace(
        "const evidence =",
        "const ranked = rankPuttingDrillRecommendations;\n    const evidence =",
      ),
    }),
    breaks: ["7. the composer never consults a recommendation"],
  },
  {
    name: "the route scores before validating the model response",
    apply: (s) => ({
      ...s,
      route: s.route
        .replace("  const persistedPuttingAnalysis = buildPersistedPuttingAnalysis(puttingValidated.response);\n", "")
        .replace(
          "  const puttingValidated = validatePuttingModelResponse(puttingParsed);",
          "  const persistedPuttingAnalysis = buildPersistedPuttingAnalysis(puttingValidated.response);\n  const puttingValidated = validatePuttingModelResponse(puttingParsed);",
        ),
    }),
    breaks: ["8. the route derives the score after validation and envelope construction"],
  },
  {
    name: "the route completes even when the score is unavailable",
    apply: (s) => ({
      ...s,
      route: s.route.replace("if (puttingScore === null) {", "if (false) {"),
    }),
    breaks: ["9. the route fails closed when the score is unavailable"],
  },
  {
    name: "the route reads through the elevated client as well",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "  const persistedPuttingAnalysis =",
        "  const preload = createAdminClient();\n  const persistedPuttingAnalysis =",
      ),
    }),
    breaks: ["10. the elevated client is constructed exactly once, for the completion write"],
  },
  {
    name: "the completion write smuggles a fourth field",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "        putting_score: puttingScore,",
        "        putting_score: puttingScore,\n        model_used: null,",
      ),
    }),
    breaks: ["11. the completion write sets exactly the three success fields"],
  },
  {
    name: "the completion write drops the owner filter",
    apply: (s) => ({
      ...s,
      route: s.route.replace('      .eq("user_id", authenticatedUserId)\n', ""),
    }),
    breaks: ["12. the completion write is bounded by row, owner, family and absent score"],
  },
  {
    name: "the completion write drops the absent-score filter",
    apply: (s) => ({
      ...s,
      route: s.route.replace('      .is("putting_score", null)\n', ""),
    }),
    breaks: ["12. the completion write is bounded by row, owner, family and absent score"],
  },
  {
    name: "a zero-row result is treated as success",
    apply: (s) => ({
      ...s,
      route: s.route.replace("puttingUpdatedRows.length !== 1", "puttingUpdatedRows.length < 0"),
    }),
    breaks: ["13. exactly one affected row is required, and zero cannot pass"],
  },
  {
    name: "the authenticated user id is no longer threaded through",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)",
        "runPuttingAnalysis(supabase, analysisRow, analysisId)",
      ),
    }),
    breaks: ["14. the authenticated user id is threaded into the putting helper"],
  },
  {
    name: "the cache hit is moved after the privileged client",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "    isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)",
        "    createAdminClient() && isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)",
      ),
    }),
    breaks: ["15. the cache hit still returns before any privileged work"],
  },
  {
    name: "the route logs the score envelope",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "  if (puttingScore === null) {",
        '  console.log("score", puttingScore);\n  if (puttingScore === null) {',
      ),
    }),
    breaks: ["16. the route never logs the score envelope"],
  },
  {
    name: "the full-swing payload starts writing a putting score",
    apply: (s) => ({
      ...s,
      route: s.route.replace(
        "    const payload = {\n      status:            \"complete\",",
        "    const payload = {\n      putting_score:     null,\n      status:            \"complete\",",
      ),
    }),
    breaks: ["17. the full-swing completion payload writes no putting score"],
  },
  {
    name: "the column gains a default",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "  add column putting_score jsonb;",
        "  add column putting_score jsonb default '{}'::jsonb;",
      ),
    }),
    breaks: ["18. the migration adds one nullable jsonb column with no default"],
  },
  {
    name: "the migration backfills historical rows",
    apply: (s) => ({
      ...s,
      migration: `${s.migration}\nupdate public.swing_analysis set putting_score = '{}'::jsonb;\n`,
    }),
    breaks: ["19. the migration backfills nothing"],
  },
  {
    name: "the trigger is renamed",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "create trigger swing_analysis_guard_putting_score",
        "create trigger swing_analysis_check_putting_score",
      ),
    }),
    breaks: ["20. the guard function and trigger carry the frozen names"],
  },
  {
    name: "the guard becomes SECURITY DEFINER",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace("security invoker", "security definer"),
    }),
    breaks: ["21. the guard is SECURITY INVOKER with an empty search_path"],
  },
  {
    name: "the first-write role check is removed",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace("current_user::text <> 'service_role'", "false"),
    }),
    breaks: ["22. the first non-null write requires the service role via current_user"],
  },
  {
    name: "a weaker signal stands in for server authorship",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "current_user::text <> 'service_role'",
        "session_user::text <> 'service_role'",
      ),
    }),
    breaks: [
      "22. the first non-null write requires the service role via current_user",
      "23. no weaker signal stands in for server authorship",
    ],
  },
  {
    name: "a stored score becomes replaceable",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace("if old.putting_score is not null then", "if false then"),
    }),
    breaks: ["24. the score is write-once for every role"],
  },
  {
    name: "a score is accepted on any family",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace("new.analysis_family is distinct from 'putting'", "false"),
    }),
    breaks: ["25. a score is accepted only on a putting analysis"],
  },
  {
    name: "the exact key set is relaxed",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "'basis', 'coverage', 'score', 'score_version', 'source_classification_version'",
        "'basis', 'coverage'",
      ),
    }),
    breaks: ["26. the stored envelope's exact key sets are enforced"],
  },
  {
    name: "the frozen version pin is dropped",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "(new.putting_score -> 'score_version') is distinct from '1'::jsonb",
        "false",
      ),
    }),
    breaks: ["27. the frozen versions, basis and section total are enforced"],
  },
  {
    name: "malformed numbers are left to a cast",
    apply: (s) => ({ ...s, migration: s.migration.split("!~ '^[0-9]+$'").join("is null") }),
    breaks: ["28. numeric ranges are enforced and malformed numbers fail before any cast"],
  },
  {
    name: "a null score no longer has to agree with zero coverage",
    apply: (s) => ({
      ...s,
      migration: s.migration
        .replace("if v_scorable <> 0 then", "if false then")
        .replace("if v_scorable = 0 then", "if false then"),
    }),
    breaks: ["29. a null score and zero scorable sections are required to agree"],
  },
  {
    name: "the migration starts computing the score",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "  return new;\nend;\n$function$;",
        "  if (new.putting_score ->> 'score')::integer <> round(100 * 2 / 2) then null; end if;\n  return new;\nend;\n$function$;",
      ),
    }),
    breaks: ["30. the migration encodes no scoring algorithm"],
  },
  {
    name: "the guard becomes executable by the browser roles",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "revoke all on function public.guard_swing_analysis_putting_score() from authenticated;",
        "",
      ),
    }),
    breaks: ["31. direct EXECUTE is withdrawn from the browser-reachable roles"],
  },
  {
    name: "the migration adds a policy",
    apply: (s) => ({
      ...s,
      migration: `${s.migration}\ncreate policy "score" on public.swing_analysis for update using (true);\n`,
    }),
    breaks: ["32. the migration adds no policy and changes no table grant"],
  },
  {
    name: "the migration touches a neighbouring column",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "  add column putting_score jsonb;",
        "  add column putting_score jsonb,\n  alter column putt_analytics set default '{}'::jsonb;",
      ),
    }),
    breaks: ["33. the migration touches no neighbouring column"],
  },
  {
    name: "the retained fixture id is hard-coded into the change",
    apply: (s) => ({
      ...s,
      migration: `${s.migration}\n-- ${RETAINED_FIXTURE_ID}\n`.replace("-- ", ""),
    }),
    breaks: ["34. the retained production fixture appears nowhere in the change"],
  },
  {
    name: "the migration is registered twice",
    apply: (s) => ({
      ...s,
      inventory: s.inventory.replace(
        "  PUTTING_SCORE_EQ5F_E_FILENAME,\n];",
        "  PUTTING_SCORE_EQ5F_E_FILENAME,\n  PUTTING_SCORE_EQ5F_E_FILENAME,\n];",
      ),
    }),
    breaks: ["35. the migration is registered exactly once in the inventory"],
  },
  {
    name: "the inventory count is hard-coded",
    apply: (s) => ({
      ...s,
      inventory: s.inventory.replace(
        "EXPECTED_MIGRATION_COUNT = APPROVED_MIGRATIONS.length",
        "EXPECTED_MIGRATION_COUNT = 34",
      ),
    }),
    breaks: ["36. the inventory count stays derived"],
  },
  {
    name: "the database type loses the new field",
    apply: (s) => ({
      ...s,
      types: s.types.replace("  putting_score: Record<string, unknown> | null;\n", ""),
    }),
    breaks: ["37. the database type gains exactly one nullable putting_score field"],
  },
  {
    name: "the postflight compares proconfig against the bare literal PostgreSQL never stores",
    apply: (s) => ({
      ...s,
      migration: s.migration.replace(
        "'search_path=\"\"' = any(v_config)",
        "'search_path=' = any(v_config)",
      ),
    }),
    breaks: ["38. the postflight compares proconfig against PostgreSQL's stored empty search_path"],
  },
];

describe("EQ5F-E — the architectural contract is non-vacuous", () => {
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
//   * that PostgREST really impersonates the request role, or that current_user
//     is 'service_role' for a service-role write — release-managed platform
//     authority, asserted here only as migration source
//   * that the migration applies cleanly, or that the guard rejects anything at
//     runtime — no database is contacted anywhere in this file
//   * that any production row has, or will receive, a score
//   * that a golfer ever sees one — no consumer reads the column in EQ5F-E
