import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "server-only" throws outside a server context. Vitest runs in plain Node with
// no such boundary, so it is mocked to a no-op — exactly as the existing
// coach-marketplace access guard's suite does — and the production module's own
// `import "server-only";` therefore needs no Vitest configuration. vi.mock is
// hoisted above the imports below, so this applies before the module loads.
vi.mock("server-only", () => ({}));

import {
  PUTTING_SECTIONS,
  isPersistedPuttingAnalysisV1,
  type PersistedPuttingAnalysisV1,
  type PuttingSection,
} from "@/lib/putting-analysis-contract";
import {
  canUsePuttingRecommendations,
  type SubscriptionTier,
} from "@/lib/entitlements";
import {
  resolvePuttingDrillRecommendations,
  type PuttingRecommendationResultV1,
} from "./putting-recommendation-authority-eq5e-c";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const CONTRACT = "lib/putting-recommendation-authority-eq5e-c.ts";
const ENTITLEMENTS = "lib/entitlements.ts";
const SERVER_CLIENT_MODULE = "@/utils/supabase/server";

// ============================================================================
// EQ5E-C — putting recommendation authority
// ============================================================================
//
// Three kinds of coverage, deliberately separated.
//
// ENTITLEMENT, for who may be shown anything at all, including the proof that
// the new capability is genuinely its own policy rather than a second name for
// an existing one.
//
// BEHAVIOURAL, for what the resolver does with a fake authenticated client:
// every way an analysis can fail to be authoritative, the pipeline it runs when
// it is, the short circuit that keeps the catalog untouched when there is
// nothing to recommend, and every way the catalog can disagree with the rules.
//
// STRUCTURAL, for what the module must never become — no writes, no model, no
// client construction, no duplicated rule set, no catalog copy. Those are
// absences, and an absence cannot be observed by calling a function, so they
// are asserted against the real source and each one is paired with an in-memory
// mutation proving the assertion would actually fire. No mutated source is ever
// written to disk.

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

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

const SOURCE = readSource(CONTRACT);
const CODE = stripComments(SOURCE);
const ENTITLEMENTS_SOURCE = readSource(ENTITLEMENTS);

// ── Canonical fixtures, stated independently of the modules under test ──────

const TEMPO_DRILL_ID = "6530ed44-b218-519d-9cdd-57cf2199e44e";
const SETUP_DRILL_ID = "d0366fc8-c428-5a21-a145-18ef24b15220";
const FACE_DRILL_ID = "87a51ed8-6cdc-50c7-864b-2bb9d88af5f7";
const PATH_DRILL_ID = "bcae0cfe-9834-5502-9e0b-03b93d5c8a10";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_ID = "33333333-3333-4333-8333-333333333333";

const SAFE_PROSE = {
  summary: "The stroke looked settled through the ball.",
  observation: "Seen in the visible part of the stroke.",
  primary_finding: "The face is the most informative part of this stroke.",
  practice_focus: "Attention belongs on what the face is doing through the ball.",
};

function makeAnalysis(
  assessments: Record<string, string>,
): PersistedPuttingAnalysisV1 {
  const section = (name: PuttingSection) => ({
    assessment: assessments[name] ?? "unclear",
    observation: SAFE_PROSE.observation,
  });

  return {
    schema_version: 1,
    evidence_basis: "ai_video_analysis_uncalibrated",
    numeric_measurements: {
      putt_tempo_ratio: "unavailable",
      face_angle_at_impact_deg: "unavailable",
      path_deviation_mm: "unavailable",
    },
    summary: SAFE_PROSE.summary,
    setup_alignment: section("setup_alignment"),
    stroke_path: section("stroke_path"),
    face_at_impact: section("face_at_impact"),
    tempo_rhythm: section("tempo_rhythm"),
    stroke_symmetry: section("stroke_symmetry"),
    stability: section("stability"),
    primary_finding: SAFE_PROSE.primary_finding,
    practice_focus: SAFE_PROSE.practice_focus,
  };
}

const NO_CANDIDATE_ANALYSIS = makeAnalysis({});
const ONE_CANDIDATE_ANALYSIS = makeAnalysis({ tempo_rhythm: "rushed" });
const TWO_CANDIDATE_ANALYSIS = makeAnalysis({
  setup_alignment: "needs_attention",
  face_at_impact: "appears_open",
});
const ARC_ANALYSIS = makeAnalysis({ stroke_path: "arc" });

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ANALYSIS_ID,
    user_id: USER_ID,
    status: "complete",
    analysis_family: "putting",
    putting_analysis: ONE_CANDIDATE_ANALYSIS,
    ...overrides,
  };
}

function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPO_DRILL_ID,
    name: "Two-Count Tempo",
    target_metric: "stroke_tempo",
    the_why: "why text",
    the_how: "how text",
    the_feel: "feel text",
    instructional_video_url: null,
    drill_family: "putting",
    ...overrides,
  };
}

// ── A fake authenticated server client that records what it was asked ───────

interface RecordedQuery {
  table: string;
  select?: string;
  eq: [string, unknown][];
  inFilter?: [string, unknown];
  single: boolean;
}

type Outcome = unknown | { __throws: true };

interface FakeClient {
  client: Parameters<typeof resolvePuttingDrillRecommendations>[0];
  queries: RecordedQuery[];
}

function makeClient(outcomes: Record<string, Outcome>): FakeClient {
  const queries: RecordedQuery[] = [];

  const settle = (table: string): Promise<unknown> => {
    const outcome = outcomes[table];
    if (outcome === undefined) return Promise.reject(new Error("unexpected table"));
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      (outcome as { __throws?: unknown }).__throws === true
    ) {
      return Promise.reject(new Error("query failed"));
    }
    return Promise.resolve(outcome);
  };

  const from = (table: string) => {
    const record: RecordedQuery = { table, eq: [], single: false };
    queries.push(record);

    const builder = {
      select(columns: string) {
        record.select = columns;
        return builder;
      },
      eq(column: string, value: unknown) {
        record.eq.push([column, value]);
        return builder;
      },
      in(column: string, value: unknown) {
        record.inFilter = [column, value];
        return builder;
      },
      single() {
        record.single = true;
        return settle(table);
      },
      then(
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) {
        return settle(table).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return {
    client: { from } as unknown as Parameters<typeof resolvePuttingDrillRecommendations>[0],
    queries,
  };
}

const okParams = {
  userId: USER_ID,
  tier: "birdie" as SubscriptionTier,
  sourceAnalysisId: ANALYSIS_ID,
};

async function resolveWith(
  outcomes: Record<string, Outcome>,
  params: typeof okParams = okParams,
): Promise<{ result: PuttingRecommendationResultV1; queries: RecordedQuery[] }> {
  const fake = makeClient(outcomes);
  const result = await resolvePuttingDrillRecommendations(fake.client, params);
  return { result, queries: fake.queries };
}

// ============================================================================
// Fixture sanity — the fixtures must be real, or every test below is vacuous
// ============================================================================

describe("EQ5E-C fixtures", () => {
  it("exists at the frozen path", () => {
    expect(existsSync(path.join(repoRoot, CONTRACT)), `missing file: ${CONTRACT}`).toBe(true);
  });

  it.each([
    ["no candidate", NO_CANDIDATE_ANALYSIS],
    ["one candidate", ONE_CANDIDATE_ANALYSIS],
    ["two candidates", TWO_CANDIDATE_ANALYSIS],
    ["arc", ARC_ANALYSIS],
  ])("the %s analysis fixture passes the canonical validator", (_label, analysis) => {
    expect(isPersistedPuttingAnalysisV1(analysis)).toBe(true);
  });

  it("covers every canonical section", () => {
    expect(PUTTING_SECTIONS).toHaveLength(6);
  });
});

// ============================================================================
// A. Entitlement
// ============================================================================

const ALLOWED: SubscriptionTier[] = ["birdie", "eagle", "coach_starter", "coach_pro"];
const DENIED: SubscriptionTier[] = ["par", "none"];

describe("EQ5E-C entitlement", () => {
  it.each(ALLOWED)("%s is allowed", (tier) => {
    expect(canUsePuttingRecommendations(tier)).toBe(true);
  });

  it.each(DENIED)("%s is denied", (tier) => {
    expect(canUsePuttingRecommendations(tier)).toBe(false);
  });

  it("denies an unrecognised runtime tier", () => {
    for (const value of ["", " ", "BIRDIE", "premium", "admin", "__proto__", "toString"]) {
      expect(canUsePuttingRecommendations(value as SubscriptionTier), value).toBe(false);
    }
  });

  it("is written as its own positive allow-list", () => {
    const helper = /export function canUsePuttingRecommendations[\s\S]*?\n}/.exec(
      ENTITLEMENTS_SOURCE,
    );
    expect(helper, "helper not found in lib/entitlements.ts").not.toBeNull();
    const body = helper?.[0] ?? "";
    for (const tier of ALLOWED) expect(body).toContain(`"${tier}"`);
    for (const tier of DENIED) expect(body).not.toContain(`"${tier}"`);
  });

  it("does not call, alias, wrap or derive from any other entitlement helper", () => {
    const helper = /export function canUsePuttingRecommendations[\s\S]*?\n}/.exec(
      ENTITLEMENTS_SOURCE,
    );
    const body = stripComments(helper?.[0] ?? "");
    for (const other of [
      "canUsePuttingAnalysis",
      "canUseLaunchMonitor",
      "canUseUltraDeepAnalysis",
      "canUseFrameComparison",
      "getAnalysisModeForTier",
      "getPriorityForTier",
      "getSwingLimitForTier",
    ]) {
      expect(body, other).not.toContain(other);
    }
    for (const reexport of [
      "canUsePuttingRecommendations = canUsePuttingAnalysis",
      "canUsePuttingRecommendations = canUseLaunchMonitor",
      "export { canUsePuttingAnalysis as canUsePuttingRecommendations }",
      "export { canUseLaunchMonitor as canUsePuttingRecommendations }",
    ]) {
      expect(ENTITLEMENTS_SOURCE, reexport).not.toContain(reexport);
    }
  });

  it("leaves the existing putting-analysis helper untouched", () => {
    expect(ENTITLEMENTS_SOURCE).toContain("export function canUsePuttingAnalysis(tier: SubscriptionTier): boolean {");
  });

  it.each(DENIED)("a %s tier is locked and reads no database at all", async (tier) => {
    const { result, queries } = await resolveWith({}, { ...okParams, tier });
    expect(result).toEqual({ status: "locked" });
    expect(queries).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ============================================================================
// B. Source authority
// ============================================================================

describe("EQ5E-C source authority", () => {
  it("proceeds for an owned, complete, putting analysis with a valid payload", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    expect(result.status).toBe("ready");
  });

  it("filters the source query on both id and user_id, selecting five columns", async () => {
    const { queries } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    const source = queries[0];
    expect(source.table).toBe("swing_analysis");
    expect(source.select).toBe("id, user_id, status, analysis_family, putting_analysis");
    expect(source.eq).toEqual([
      ["id", ANALYSIS_ID],
      ["user_id", USER_ID],
    ]);
    expect(source.single).toBe(true);
    expect(source.select?.split(", ")).toHaveLength(5);
  });

  const unavailableCases: { label: string; outcome: Outcome }[] = [
    { label: "query error", outcome: { data: null, error: { message: "boom" } } },
    { label: "thrown query", outcome: { __throws: true } },
    { label: "missing row", outcome: { data: null, error: null } },
    { label: "primitive row", outcome: { data: 7, error: null } },
    { label: "non-object outcome", outcome: null },
    { label: "id mismatch", outcome: { data: sourceRow({ id: OTHER_USER_ID }), error: null } },
    { label: "non-string id", outcome: { data: sourceRow({ id: 5 }), error: null } },
    { label: "user mismatch", outcome: { data: sourceRow({ user_id: OTHER_USER_ID }), error: null } },
    { label: "non-string user", outcome: { data: sourceRow({ user_id: null }), error: null } },
    { label: "full_swing family", outcome: { data: sourceRow({ analysis_family: "full_swing" }), error: null } },
    { label: "null family", outcome: { data: sourceRow({ analysis_family: null }), error: null } },
    { label: "pending status", outcome: { data: sourceRow({ status: "pending" }), error: null } },
    { label: "processing status", outcome: { data: sourceRow({ status: "processing" }), error: null } },
    { label: "failed status", outcome: { data: sourceRow({ status: "failed" }), error: null } },
    { label: "completed misspelling", outcome: { data: sourceRow({ status: "completed" }), error: null } },
    { label: "unknown status", outcome: { data: sourceRow({ status: "archived" }), error: null } },
    { label: "missing payload", outcome: { data: sourceRow({ putting_analysis: null }), error: null } },
    { label: "invalid payload", outcome: { data: sourceRow({ putting_analysis: { schema_version: 1 } }), error: null } },
  ];

  it.each(unavailableCases)("$label yields the generic unavailable result", async ({ outcome }) => {
    const { result, queries } = await resolveWith({ swing_analysis: outcome, drills: { data: [], error: null } });
    expect(result).toEqual({ status: "unavailable" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(queries.filter((q) => q.table === "drills")).toEqual([]);
  });

  it("does not distinguish a non-owned analysis from a missing one", async () => {
    const notOwned = await resolveWith({
      swing_analysis: { data: sourceRow({ user_id: OTHER_USER_ID }), error: null },
    });
    const missing = await resolveWith({ swing_analysis: { data: null, error: null } });
    expect(notOwned.result).toEqual(missing.result);
  });

  it("does not take the user id or family from the persisted payload", async () => {
    const poisoned = {
      ...sourceRow({ user_id: OTHER_USER_ID, analysis_family: "full_swing" }),
      putting_analysis: ONE_CANDIDATE_ANALYSIS,
    };
    const { result } = await resolveWith({ swing_analysis: { data: poisoned, error: null } });
    expect(result).toEqual({ status: "unavailable" });
  });
});

// ============================================================================
// C / D. Pipeline and the zero-candidate short circuit
// ============================================================================

describe("EQ5E-C pipeline", () => {
  it("returns a ready empty result and never touches the catalog when nothing is recommended", async () => {
    const { result, queries } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: NO_CANDIDATE_ANALYSIS }), error: null },
    });
    expect(result).toEqual({
      status: "ready",
      source_analysis_id: ANALYSIS_ID,
      recommendations: [],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe("swing_analysis");
    expect(queries.some((q) => q.table === "drills")).toBe(false);
    if (result.status !== "ready") throw new Error("unreachable");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recommendations)).toBe(true);
  });

  it("treats an acceptable arc as no recommendation", async () => {
    const { result, queries } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: ARC_ANALYSIS }), error: null },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("unreachable");
    expect(result.recommendations).toEqual([]);
    expect(queries.some((q) => q.table === "drills")).toBe(false);
  });

  it("returns one recommendation for one candidate", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].drill_id).toBe(TEMPO_DRILL_ID);
    expect(result.recommendations[0].rank).toBe(1);
  });

  it("returns two recommendations in candidate order, never database order", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: TWO_CANDIDATE_ANALYSIS }), error: null },
      drills: {
        // Deliberately reversed relative to the rule-set priority.
        data: [
          catalogRow({ id: FACE_DRILL_ID, name: "Start-Line Gate", target_metric: "start_line_control" }),
          catalogRow({ id: SETUP_DRILL_ID, name: "Eye-Line Setup Check", target_metric: "address_setup" }),
        ],
        error: null,
      },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.recommendations.map((r) => r.drill_id)).toEqual([SETUP_DRILL_ID, FACE_DRILL_ID]);
    expect(result.recommendations.map((r) => r.rank)).toEqual([1, 2]);
    expect(result.recommendations.map((r) => r.source_section)).toEqual([
      "setup_alignment",
      "face_at_impact",
    ]);
  });

  it("never returns more than two", async () => {
    const everything = makeAnalysis({
      setup_alignment: "needs_attention",
      face_at_impact: "appears_open",
      stroke_path: "out_to_in",
      tempo_rhythm: "rushed",
      stroke_symmetry: "uneven",
      stability: "head_motion",
    });
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: everything }), error: null },
      drills: {
        data: [
          catalogRow({ id: SETUP_DRILL_ID, name: "Eye-Line Setup Check", target_metric: "address_setup" }),
          catalogRow({ id: FACE_DRILL_ID, name: "Start-Line Gate", target_metric: "start_line_control" }),
        ],
        error: null,
      },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.recommendations).toHaveLength(2);
  });
});

// ============================================================================
// E. Catalog authority
// ============================================================================

describe("EQ5E-C catalog authority", () => {
  it("queries the exact candidate ids with a positive family filter and approved columns", async () => {
    const { queries } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    const catalog = queries.find((q) => q.table === "drills");
    expect(catalog).toBeDefined();
    expect(catalog?.select).toBe(
      "id, name, target_metric, the_why, the_how, the_feel, instructional_video_url, drill_family",
    );
    expect(catalog?.inFilter).toEqual(["id", [TEMPO_DRILL_ID]]);
    expect(catalog?.eq).toEqual([["drill_family", "putting"]]);
    expect(catalog?.single).toBe(false);
    expect(catalog?.select).not.toContain("ai_verification_prompt");
  });

  const catalogFailures: { label: string; outcome: Outcome }[] = [
    { label: "query error", outcome: { data: null, error: { message: "boom" } } },
    { label: "thrown query", outcome: { __throws: true } },
    { label: "non-object outcome", outcome: null },
    { label: "non-array data", outcome: { data: {}, error: null } },
    { label: "missing row", outcome: { data: [], error: null } },
    { label: "extra row", outcome: { data: [catalogRow(), catalogRow({ id: PATH_DRILL_ID })], error: null } },
    { label: "duplicate id", outcome: { data: [catalogRow(), catalogRow()], error: null } },
    { label: "wrong id", outcome: { data: [catalogRow({ id: PATH_DRILL_ID })], error: null } },
    { label: "non-object row", outcome: { data: [7], error: null } },
    { label: "non-string id", outcome: { data: [catalogRow({ id: 9 })], error: null } },
    { label: "wrong family", outcome: { data: [catalogRow({ drill_family: "full_swing" })], error: null } },
    { label: "null family", outcome: { data: [catalogRow({ drill_family: null })], error: null } },
    { label: "target mismatch", outcome: { data: [catalogRow({ target_metric: "address_setup" })], error: null } },
    { label: "missing name", outcome: { data: [catalogRow({ name: null })], error: null } },
    { label: "empty name", outcome: { data: [catalogRow({ name: "" })], error: null } },
    { label: "malformed the_why", outcome: { data: [catalogRow({ the_why: 5 })], error: null } },
    { label: "malformed the_how", outcome: { data: [catalogRow({ the_how: {} })], error: null } },
    { label: "malformed the_feel", outcome: { data: [catalogRow({ the_feel: [] })], error: null } },
    { label: "malformed video url", outcome: { data: [catalogRow({ instructional_video_url: 1 })], error: null } },
  ];

  it.each(catalogFailures)("$label fails closed to catalog_unavailable", async ({ outcome }) => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: outcome,
    });
    expect(result).toEqual({ status: "catalog_unavailable" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails the whole result rather than promoting the second recommendation", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: TWO_CANDIDATE_ANALYSIS }), error: null },
      drills: {
        // Rank 1's row has drifted; rank 2's is perfect.
        data: [
          catalogRow({ id: SETUP_DRILL_ID, name: "Eye-Line Setup Check", target_metric: "stroke_tempo" }),
          catalogRow({ id: FACE_DRILL_ID, name: "Start-Line Gate", target_metric: "start_line_control" }),
        ],
        error: null,
      },
    });
    expect(result).toEqual({ status: "catalog_unavailable" });
  });

  it("never looks a drill up by name", () => {
    expect(CODE).not.toContain('.eq("name"');
    expect(CODE).not.toContain('"name",');
  });
});

// ============================================================================
// F. Output contract
// ============================================================================

describe("EQ5E-C output", () => {
  it("carries exactly the twelve contract fields", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(sorted(Object.keys(result.recommendations[0]))).toEqual([
      "drill_id",
      "instructional_video_url",
      "name",
      "observed_assessment",
      "rank",
      "reason_code",
      "ruleset_version",
      "source_section",
      "target_category",
      "the_feel",
      "the_how",
      "the_why",
    ]);
    expect(sorted(Object.keys(result))).toEqual([
      "recommendations",
      "source_analysis_id",
      "status",
    ]);
  });

  it("preserves the rule-set fields and takes display copy from the catalog", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow({ the_feel: null, instructional_video_url: "https://example.test/v" })], error: null },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    const recommendation = result.recommendations[0];
    expect(recommendation.target_category).toBe("stroke_tempo");
    expect(recommendation.source_section).toBe("tempo_rhythm");
    expect(recommendation.observed_assessment).toBe("rushed");
    expect(recommendation.reason_code).toBe("tempo_rhythm_needs_improvement");
    expect(recommendation.ruleset_version).toBe(1);
    expect(recommendation.name).toBe("Two-Count Tempo");
    expect(recommendation.the_why).toBe("why text");
    expect(recommendation.the_how).toBe("how text");
    expect(recommendation.the_feel).toBeNull();
    expect(recommendation.instructional_video_url).toBe("https://example.test/v");
  });

  it("copies the observed assessment verbatim", async () => {
    const odd = "  RuShEd  ";
    const analysis = makeAnalysis({});
    const withOdd = {
      ...analysis,
      tempo_rhythm: { assessment: odd, observation: SAFE_PROSE.observation },
    } as PersistedPuttingAnalysisV1;
    // An unrecognised assessment classifies as insufficient evidence, so this
    // proves the verbatim rule at the boundary where it is observable: nothing
    // is normalised on the way in, and nothing is recommended from it either.
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: withOdd }), error: null },
    });
    expect(result.status).toBe("unavailable");
  });

  it("takes source_analysis_id from the authoritative row", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.source_analysis_id).toBe(ANALYSIS_ID);
  });

  it("exposes no internal catalog field", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    });
    const serialised = JSON.stringify(result);
    for (const absent of [
      "target_metric",
      "drill_family",
      "ai_verification_prompt",
      "created_at",
      "user_id",
    ]) {
      expect(serialised, absent).not.toContain(absent);
    }
  });

  it("freezes the result, the array and every recommendation", async () => {
    const { result } = await resolveWith({
      swing_analysis: { data: sourceRow({ putting_analysis: TWO_CANDIDATE_ANALYSIS }), error: null },
      drills: {
        data: [
          catalogRow({ id: SETUP_DRILL_ID, name: "Eye-Line Setup Check", target_metric: "address_setup" }),
          catalogRow({ id: FACE_DRILL_ID, name: "Start-Line Gate", target_metric: "start_line_control" }),
        ],
        error: null,
      },
    });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recommendations)).toBe(true);
    for (const recommendation of result.recommendations) {
      expect(Object.isFrozen(recommendation)).toBe(true);
    }
  });

  it("does not mutate its inputs", async () => {
    const row = sourceRow();
    const rows = [catalogRow()];
    const params = { ...okParams };
    const beforeRow = JSON.stringify(row);
    const beforeRows = JSON.stringify(rows);
    const beforeParams = JSON.stringify(params);

    await resolveWith(
      { swing_analysis: { data: row, error: null }, drills: { data: rows, error: null } },
      params,
    );

    expect(JSON.stringify(row)).toBe(beforeRow);
    expect(JSON.stringify(rows)).toBe(beforeRows);
    expect(JSON.stringify(params)).toBe(beforeParams);
  });

  it("is deterministic across repeated calls", async () => {
    const outcomes = {
      swing_analysis: { data: sourceRow(), error: null },
      drills: { data: [catalogRow()], error: null },
    };
    const first = JSON.stringify((await resolveWith(outcomes)).result);
    for (let i = 0; i < 3; i += 1) {
      expect(JSON.stringify((await resolveWith(outcomes)).result)).toBe(first);
    }
  });
});

// ============================================================================
// G. Structural boundaries, asserted against the real source
// ============================================================================

const ALLOWED_MODULES = [
  "server-only",
  SERVER_CLIENT_MODULE,
  "@/lib/entitlements",
  "@/lib/putting-analysis-contract",
  "@/lib/putting-drill-evidence-eq5d-a",
  "@/lib/putting-signal-classification-eq5e-a",
  "@/lib/putting-drill-recommendation-eq5e-b",
];

const WRITE_TOKENS = [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".storage"];
const PERSISTENCE_TOKENS = ["user_drills", "automated_prescriptions", "verify-drill"];
const MODEL_TOKENS = ["gemini", "generative-ai", "generativeai", "getgenerativemodel", "openai", "generatecontent"];
const RUNTIME_TOKENS = ["fetch(", "nextrequest", "nextresponse", "next/server", "next/headers", "react"];
const EQUIPMENT_TOKENS = ["club_id", "equipment", "putter", "manufacturer"];
const GRADING_TOKENS = ["confidence", "severity", "probability", "weight", ".sort("];
const ADMIN_TOKENS = ["service_role", "SUPABASE_SERVICE_ROLE", "createClient(", "admin"];
const RULESET_TOKENS = [
  "setup_alignment",
  "face_at_impact",
  "stroke_path",
  "tempo_rhythm",
  "address_setup",
  "start_line_control",
  "stroke_path_control",
  "stroke_tempo",
  "needs_improvement",
];
const CATALOG_COPY_TOKENS = [
  "Eye-Line Setup Check",
  "Start-Line Gate",
  "Heel-Toe Strike Gate",
  "Rail Path Channel",
  "Distance Ladder",
  "Two-Count Tempo",
  "Three-Foot Circle",
  "ai_verification_prompt",
];

const EXPECTED_EXPORTS = [
  "HydratedPuttingDrillRecommendationV1",
  "PuttingRecommendationAuthorityClient",
  "PuttingRecommendationResultV1",
  "resolvePuttingDrillRecommendations",
];

function exportedNames(code: string): string[] {
  return Array.from(
    code.matchAll(
      /^export\s+(?:async\s+)?(?:const|type|interface|function)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    ),
  ).map((match) => match[1]);
}

/**
 * Module specifiers this file actually imports.
 *
 * Anchored to real import statements. A looser scan matches the string literal
 * `"from"` that appears inside the client's `Pick<…, "from">` type and then
 * swallows the rest of the file as a specifier, so both patterns start at a
 * line-leading `import` and the from-clause body may not cross a semicolon.
 */
function importedModules(code: string): string[] {
  const sideEffect = Array.from(code.matchAll(/^import\s+["']([^"']+)["']/gm)).map((m) => m[1]);
  const withClause = Array.from(code.matchAll(/^import\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)).map(
    (m) => m[1],
  );
  return [...sideEffect, ...withClause];
}

interface Guard {
  id: string;
  holds: (code: string) => boolean;
}

const GUARDS: Guard[] = [
  {
    id: "declares the server-only boundary",
    holds: (code) => /^import "server-only";$/m.test(code),
  },
  {
    id: "depends on the server client only as a type",
    holds: (code) => {
      const m = escapeForRegex(SERVER_CLIENT_MODULE);
      if (Array.from(code.matchAll(new RegExp(m, "g"))).length !== 1) return false;
      if (!new RegExp(`import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}['"]`).test(code)) return false;
      return !new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"]${m}['"]`).test(code);
    },
  },
  {
    id: "imports only the approved modules",
    holds: (code) => importedModules(code).every((mod) => ALLOWED_MODULES.includes(mod)),
  },
  {
    id: "constructs no client and reaches no elevated credential",
    holds: (code) => ADMIN_TOKENS.every((token) => !code.toLowerCase().includes(token.toLowerCase())),
  },
  {
    id: "performs no write of any kind",
    holds: (code) => WRITE_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "touches no practice, prescription or verification surface",
    holds: (code) => PERSISTENCE_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "reaches no model surface",
    holds: (code) => MODEL_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "reaches no network, framework or client runtime",
    holds: (code) => RUNTIME_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "carries no equipment vocabulary",
    holds: (code) => EQUIPMENT_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "grades nothing by confidence, severity or probability",
    holds: (code) => GRADING_TOKENS.every((token) => !code.toLowerCase().includes(token)),
  },
  {
    id: "duplicates no rule-set vocabulary",
    holds: (code) => RULESET_TOKENS.every((token) => !code.includes(token)),
  },
  {
    id: "duplicates no canonical catalog copy or identity",
    holds: (code) =>
      CATALOG_COPY_TOKENS.every((token) => !code.includes(token)) &&
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(code),
  },
  {
    id: "reaches no clock, randomness or environment",
    holds: (code) =>
      !/\bDate\b/.test(code) &&
      !/Math\.random/.test(code) &&
      !/process\.env/.test(code) &&
      !/globalThis/.test(code),
  },
  {
    id: "reads exactly two tables",
    holds: (code) => {
      const tables = Array.from(code.matchAll(/\.from\("([a-z_]+)"\)/g)).map((m) => m[1]);
      return sorted(tables).join(",") === "drills,swing_analysis";
    },
  },
  {
    id: "selects only the approved columns",
    holds: (code) =>
      code.includes('"id, user_id, status, analysis_family, putting_analysis"') &&
      code.includes(
        '"id, name, target_metric, the_why, the_how, the_feel, instructional_video_url, drill_family"',
      ),
  },
  {
    id: "exports exactly the frozen public surface",
    holds: (code) => sorted(exportedNames(code)).join(",") === sorted(EXPECTED_EXPORTS).join(","),
  },
];

describe("EQ5E-C contract — structural boundary", () => {
  it.each(GUARDS)("$id", ({ holds }) => {
    expect(holds(CODE)).toBe(true);
  });

  it("exposes exactly one function", () => {
    const functions = Array.from(
      CODE.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm),
    ).map((m) => m[1]);
    expect(functions).toEqual(["resolvePuttingDrillRecommendations"]);
  });

  it("creates no reverse dependency", () => {
    for (const upstream of [
      "lib/entitlements.ts",
      "lib/putting-analysis-contract.ts",
      "lib/putting-drill-evidence-eq5d-a.ts",
      "lib/putting-signal-classification-eq5e-a.ts",
      "lib/putting-drill-recommendation-eq5e-b.ts",
    ]) {
      expect(readSource(upstream), upstream).not.toContain("eq5e-c");
    }
  });
});

// ============================================================================
// H. Activation — the canonical putting result page, and nothing else
// ============================================================================
//
// EQ5E-C shipped dormant, and this section used to require exactly that: no
// production file anywhere could name the module. EQ5E-D is the slice that
// intentionally ends that dormancy, on one surface only, so the requirement is
// now an exact allow-list rather than an empty one.
//
// Two kinds of reference are kept apart because they carry different risk. A
// runtime import executes this module — it opens queries and carries the
// server-only boundary with it — and exactly one file may do that: the swing
// detail Server Component, which already owns the authenticated client, the
// tier and the owned row. A type-only import is erased by the compiler and
// executes nothing, so the presentation component may use one to describe the
// result it renders without becoming a second consumer.
//
// Classification fails safe. A file counts as type-only only when every code
// occurrence of the module specifier sits inside an `import type { ... } from`
// statement. Anything else — a value import, an inline `type` modifier (which
// can still leave a side-effect import behind), a dynamic import, a re-export,
// a bare side-effect import — makes it a runtime importer.
//
// The lists stay exact. A directory, naming-pattern or "any page" allowance
// would let an unreviewed consumer appear without this suite noticing, which is
// the one thing it exists to prevent.

describe("EQ5E-C activation — canonical putting result page only", () => {
  const SPECIFIER = "putting-recommendation-authority-eq5e-c";
  const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
  const PRESENTATION = "components/putting/PuttingRecommendationsPanel.tsx";

  const AUTHORIZED_RUNTIME_IMPORTERS: readonly string[] = [RESULT_PAGE];
  const AUTHORIZED_TYPE_ONLY_REFERENCES: readonly string[] = [PRESENTATION];
  const AUTHORIZED_REFERENCES: readonly string[] = [RESULT_PAGE, PRESENTATION];

  interface SourceFile {
    filePath: string;
    content: string;
  }

  /** Every non-test file, other than the module itself, that names it at all. */
  function referencesOf(files: readonly SourceFile[]): string[] {
    return files
      .filter((file) => !file.filePath.includes(".test."))
      .filter((file) => file.filePath !== CONTRACT)
      .filter((file) => file.content.includes(SPECIFIER))
      .map((file) => file.filePath);
  }

  /** True only when every code occurrence of the specifier is an `import type { ... }`. */
  function isTypeOnlyReference(content: string): boolean {
    const code = stripComments(content);
    const occurrences = code.split(SPECIFIER).length - 1;
    const typeOnlyImports = Array.from(
      code.matchAll(
        new RegExp(`^import\\s+type\\s*\\{[^}]*\\}\\s*from\\s*["'][^"']*${SPECIFIER}["'];?`, "gm"),
      ),
    ).length;
    return occurrences > 0 && occurrences === typeOnlyImports;
  }

  function runtimeImportersOf(files: readonly SourceFile[]): string[] {
    const referencing = new Set(referencesOf(files));
    return files
      .filter((file) => referencing.has(file.filePath) && !isTypeOnlyReference(file.content))
      .map((file) => file.filePath);
  }

  function typeOnlyReferencesOf(files: readonly SourceFile[]): string[] {
    const referencing = new Set(referencesOf(files));
    return files
      .filter((file) => referencing.has(file.filePath) && isTypeOnlyReference(file.content))
      .map((file) => file.filePath);
  }

  function collect(dirs: readonly string[]): SourceFile[] {
    const out: SourceFile[] = [];
    for (const dir of dirs) {
      const absolute = path.join(repoRoot, dir);
      if (!existsSync(absolute)) continue;
      for (const entry of readdirSyncRecursive(absolute)) {
        if (!/\.tsx?$/.test(entry)) continue;
        out.push({
          filePath: path.relative(repoRoot, entry).split(path.sep).join("/"),
          content: readFileSync(entry, "utf8"),
        });
      }
    }
    return out;
  }

  const files = collect(["app", "lib", "components", "utils"]);

  it("scanned a plausible number of source files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.filePath === CONTRACT)).toBe(true);
    expect(files.some((f) => f.filePath === RESULT_PAGE)).toBe(true);
    expect(files.some((f) => f.filePath === PRESENTATION)).toBe(true);
  });

  it("is named by exactly the two authorized files", () => {
    expect(sorted(referencesOf(files))).toEqual(sorted(AUTHORIZED_REFERENCES));
  });

  it("has exactly one runtime importer: the canonical putting result page", () => {
    expect(sorted(runtimeImportersOf(files))).toEqual(sorted(AUTHORIZED_RUNTIME_IMPORTERS));
  });

  it("has exactly one type-only reference: the presentation component", () => {
    expect(sorted(typeOnlyReferencesOf(files))).toEqual(sorted(AUTHORIZED_TYPE_ONLY_REFERENCES));
  });

  it("classifies every reference as exactly one kind", () => {
    const runtime = runtimeImportersOf(files);
    const typeOnly = typeOnlyReferencesOf(files);
    expect(runtime.filter((filePath) => typeOnly.includes(filePath))).toEqual([]);
    expect(sorted([...runtime, ...typeOnly])).toEqual(sorted(referencesOf(files)));
  });

  it("is executed from the page through its exported entry point", () => {
    const page = files.find((file) => file.filePath === RESULT_PAGE);
    expect(page?.content).toContain(
      `import { resolvePuttingDrillRecommendations } from "@/lib/${SPECIFIER}";`,
    );
  });

  it("counts a type-only import as type-only, and everything else as runtime", () => {
    const cases: readonly { content: string; typeOnly: boolean }[] = [
      { content: `import type { PuttingRecommendationResultV1 } from "@/lib/${SPECIFIER}";`, typeOnly: true },
      { content: `import type {\n  A,\n  B,\n} from "@/lib/${SPECIFIER}";`, typeOnly: true },
      { content: `import { resolvePuttingDrillRecommendations } from "@/lib/${SPECIFIER}";`, typeOnly: false },
      // An inline type modifier still emits a module specifier in some
      // configurations, so it is not accepted as erased.
      { content: `import { type PuttingRecommendationResultV1 } from "@/lib/${SPECIFIER}";`, typeOnly: false },
      { content: `import type { A } from "@/lib/${SPECIFIER}";\nconst m = await import("@/lib/${SPECIFIER}");`, typeOnly: false },
      { content: `export { resolvePuttingDrillRecommendations } from "@/lib/${SPECIFIER}";`, typeOnly: false },
      { content: `import "@/lib/${SPECIFIER}";`, typeOnly: false },
      { content: `const m = require("@/lib/${SPECIFIER}");`, typeOnly: false },
      { content: `// only a mention of @/lib/${SPECIFIER} in prose`, typeOnly: false },
    ];
    for (const { content, typeOnly } of cases) {
      expect(isTypeOnlyReference(content), content).toBe(typeOnly);
    }
  });

  it("would notice a production reference if one appeared", () => {
    expect(
      referencesOf([
        { filePath: "app/api/example/route.ts", content: `import x from "@/lib/${SPECIFIER}";` },
        { filePath: "lib/other.test.ts", content: `import x from "@/lib/${SPECIFIER}";` },
      ]),
    ).toEqual(["app/api/example/route.ts"]);
  });

  it("an injected unauthorized importer breaks the exact reference set", () => {
    const intruder: SourceFile = {
      filePath: "app/api/example/route.ts",
      content: `import { resolvePuttingDrillRecommendations } from "@/lib/${SPECIFIER}";`,
    };
    const withIntruder = [...files, intruder];
    expect(sorted(referencesOf(withIntruder))).not.toEqual(sorted(AUTHORIZED_REFERENCES));
    expect(runtimeImportersOf(withIntruder)).toContain(intruder.filePath);
  });

  it("an injected second runtime importer breaks the exact runtime allow-list", () => {
    const second: SourceFile = {
      filePath: "components/putting/InjectedRecommendationConsumer.tsx",
      content: `import { resolvePuttingDrillRecommendations } from "@/lib/${SPECIFIER}";`,
    };
    const runtime = sorted(runtimeImportersOf([...files, second]));
    expect(runtime).not.toEqual(sorted(AUTHORIZED_RUNTIME_IMPORTERS));
    expect(runtime).toContain(second.filePath);
  });

  it("the presentation component becoming a runtime importer breaks both allow-lists", () => {
    const presentation = files.find((file) => file.filePath === PRESENTATION);
    expect(presentation, "the presentation component was not scanned").toBeDefined();
    const mutated = files.map((file) =>
      file.filePath === PRESENTATION
        ? { ...file, content: file.content.replace("import type {", "import {") }
        : file,
    );
    expect(mutated.find((file) => file.filePath === PRESENTATION)?.content).not.toBe(
      presentation?.content,
    );
    expect(sorted(runtimeImportersOf(mutated))).not.toEqual(sorted(AUTHORIZED_RUNTIME_IMPORTERS));
    expect(sorted(typeOnlyReferencesOf(mutated))).not.toEqual(
      sorted(AUTHORIZED_TYPE_ONLY_REFERENCES),
    );
  });

  it("reaches no route handler, and no page or component beyond the authorized pair", () => {
    const surfaced = files
      .filter(
        (file) =>
          (file.filePath.startsWith("app/") || file.filePath.startsWith("components/")) &&
          file.content.includes(SPECIFIER),
      )
      .map((file) => file.filePath);
    expect(sorted(surfaced)).toEqual(sorted(AUTHORIZED_REFERENCES));
    expect(surfaced.some((filePath) => filePath.startsWith("app/api/"))).toBe(false);
  });
});

function readdirSyncRecursive(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirSyncRecursive(full));
    else out.push(full);
  }
  return out;
}

// ============================================================================
// Non-vacuity — every structural guard is proved able to fail
// ============================================================================

interface Regression {
  name: string;
  apply: (code: string) => string;
  breaks: string[];
}

const SERVER_ONLY_LINE = 'import "server-only";';
const TYPE_IMPORT = `import type { createClient } from "${SERVER_CLIENT_MODULE}";`;

const REGRESSIONS: Regression[] = [
  {
    name: "the server-only boundary is removed",
    apply: (code) => code.replace(SERVER_ONLY_LINE, ""),
    breaks: ["declares the server-only boundary"],
  },
  {
    name: "the server client becomes a runtime import",
    apply: (code) =>
      code.replace(TYPE_IMPORT, `import { createClient } from "${SERVER_CLIENT_MODULE}";`),
    breaks: ["depends on the server client only as a type"],
  },
  {
    name: "an admin client is imported",
    apply: (code) => `import { admin } from "@/utils/supabase/admin";\n${code}`,
    breaks: [
      "imports only the approved modules",
      "constructs no client and reaches no elevated credential",
    ],
  },
  {
    name: "a row is written",
    apply: (code) => `${code}\nasync function save(c: never) { await (c as never as { from: (t: string) => { insert: (v: unknown) => unknown } }).from("x").insert({}); }\n`,
    breaks: ["performs no write of any kind"],
  },
  {
    name: "practice state is touched",
    apply: (code) => `${code}\nconst target = "user_drills";\n`,
    breaks: ["touches no practice, prescription or verification surface"],
  },
  {
    name: "the model SDK is imported",
    apply: (code) => `import { SchemaType } from "@google/generative-ai";\n${code}`,
    breaks: ["imports only the approved modules", "reaches no model surface"],
  },
  {
    name: "the network is reached",
    apply: (code) => `${code}\nconst r = fetch("https://example.test");\n`,
    breaks: ["reaches no network, framework or client runtime"],
  },
  {
    name: "a framework module is imported",
    apply: (code) => `import { NextResponse } from "next/server";\n${code}`,
    breaks: ["imports only the approved modules", "reaches no network, framework or client runtime"],
  },
  {
    name: "equipment reaches the authority",
    apply: (code) => `${code}\nconst putterModel = "unknown";\n`,
    breaks: ["carries no equipment vocabulary"],
  },
  {
    name: "a grading score is introduced",
    apply: (code) => `${code}\nconst severityWeight = 1;\n`,
    breaks: ["grades nothing by confidence, severity or probability"],
  },
  {
    name: "the rule set is duplicated",
    apply: (code) => `${code}\nconst priority = ["setup_alignment", "face_at_impact"];\n`,
    breaks: ["duplicates no rule-set vocabulary"],
  },
  {
    name: "canonical catalog copy is duplicated",
    apply: (code) => `${code}\nconst label = "Two-Count Tempo";\n`,
    breaks: ["duplicates no canonical catalog copy or identity"],
  },
  {
    name: "a catalog identity is embedded",
    apply: (code) => `${code}\nconst pinned = "6530ed44-b218-519d-9cdd-57cf2199e44e";\n`,
    breaks: ["duplicates no canonical catalog copy or identity"],
  },
  {
    name: "the verification prompt column is selected",
    apply: (code) =>
      code.replace(
        '"id, name, target_metric, the_why, the_how, the_feel, instructional_video_url, drill_family"',
        '"id, name, target_metric, ai_verification_prompt, drill_family"',
      ),
    breaks: ["duplicates no canonical catalog copy or identity", "selects only the approved columns"],
  },
  {
    name: "a third table is read",
    apply: (code) => `${code}\nconst extra = (null as never as { from: (t: string) => unknown }).from("user_drills");\n`,
    breaks: ["reads exactly two tables", "touches no practice, prescription or verification surface"],
  },
  {
    name: "the source select is widened",
    apply: (code) =>
      code.replace(
        '"id, user_id, status, analysis_family, putting_analysis"',
        '"*"',
      ),
    breaks: ["selects only the approved columns"],
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
    name: "an internal helper is exported",
    apply: (code) => code.replace("function isNullableText", "export function isNullableText"),
    breaks: ["exports exactly the frozen public surface"],
  },
];

describe("EQ5E-C contract — guards are non-vacuous", () => {
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
