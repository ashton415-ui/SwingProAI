/**
 * EQ5C-B — server-authoritative putting execution entitlement.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * EQ5C-A decided who may *see* a putting result. This decides who may *cause*
 * one. They are different boundaries with different consequences: the first
 * withholds a narrative, the second withholds a Gemini call, a video download
 * and a database write. They deliberately share one entitlement helper and
 * nothing else.
 *
 * The interesting case is the cached one. runPuttingAnalysis opens with an
 * early return that serves a stored PersistedPuttingAnalysisV1 without doing
 * any work, so a golfer who paid once and then downgraded could read a premium
 * result back out of the API forever if the gate lived inside that helper. It
 * does not. It sits in the POST handler, before the call, which is why the
 * ordering assertions below are the load-bearing ones rather than decoration.
 *
 * WHY THE ASSERTIONS ARE SOURCE SCANS
 * -----------------------------------
 * The route is a Next.js server handler that opens a Supabase client and calls
 * Gemini. Vitest runs in the node environment here with no request, no session
 * and no network, so the handler cannot be invoked. Ordering is therefore
 * asserted against the real production source — never against a duplicated
 * model of the route, which could agree with itself while the route disagreed.
 * Every assertion below reads app/api/analyze-swing/route.ts.
 *
 * The entitlement matrix itself is NOT re-tested here. It belongs to
 * lib/putting-entitlement-contract-eq5c-a.test.ts, and duplicating it would
 * create a second copy of the product decision — the precise thing this slice
 * is meant to avoid.
 *
 * No database, no network, no Supabase client, no Gemini, no credential.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ROUTE = "app/api/analyze-swing/route.ts";
const apiSource = readSource(ROUTE);

/** The POST handler body only, so ordering compares execution sites rather than
 *  module-level declarations that appear earlier in the file. */
const handlerSource = (() => {
  const start = apiSource.indexOf("export async function POST(");
  expect(start, `${ROUTE}: POST handler not found`).toBeGreaterThanOrEqual(0);
  return apiSource.slice(start);
})();

/** Index of `needle` in the handler, failing the test if it is absent. */
function anchor(needle: string): number {
  const index = handlerSource.indexOf(needle);
  expect(index, `${ROUTE}: missing handler anchor: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** The putting branch only: from its family test to the next family branch. */
const puttingBranchSource = (() => {
  const start = handlerSource.indexOf('analysisRoute === "putting_pipeline"');
  expect(start, `${ROUTE}: putting branch not found`).toBeGreaterThanOrEqual(0);
  const end = handlerSource.indexOf('analysisRoute === "unsupported_family"', start);
  expect(end, `${ROUTE}: unsupported-family branch not found after putting`).toBeGreaterThan(start);
  return handlerSource.slice(start, end);
})();

/** Everything after the putting branch: the unsupported and full-swing paths. */
const otherFamiliesSource = (() => {
  const start = handlerSource.indexOf('analysisRoute === "unsupported_family"');
  expect(start, `${ROUTE}: unsupported-family branch not found`).toBeGreaterThanOrEqual(0);
  return handlerSource.slice(start);
})();

/** The route-local putting helper only, so "inside vs outside" is provable. */
const puttingHelperSource = (() => {
  const start = apiSource.indexOf("async function runPuttingAnalysis(");
  expect(start, `${ROUTE}: runPuttingAnalysis not found`).toBeGreaterThanOrEqual(0);
  const end = apiSource.indexOf("export async function POST(", start);
  expect(end, `${ROUTE}: POST handler not found after the putting helper`).toBeGreaterThan(start);
  return apiSource.slice(start, end);
})();

/** The RequestBody interface body, so a ban applies to the client contract
 *  rather than to the whole route. */
const requestBodySource = (() => {
  const start = apiSource.indexOf("interface RequestBody {");
  expect(start, `${ROUTE}: RequestBody interface not found`).toBeGreaterThanOrEqual(0);
  const end = apiSource.indexOf("\n}\n", start);
  expect(end, `${ROUTE}: RequestBody interface is unterminated`).toBeGreaterThan(start);
  return apiSource.slice(start, end);
})();

const FIVE_HUNDRED_COPY = "Analysis failed. Please try again.";
const FOUR_OH_THREE_COPY =
  "Putting analysis isn't included with your current plan. Upgrade to unlock putting analysis.";

// ─── The helper is reused, never re-implemented ───────────────────────────────

describe("the route defers to the centralized entitlement helper", () => {
  it("imports canUsePuttingAnalysis from the shared entitlement module", () => {
    expect(apiSource).toContain(
      'import { canUsePuttingAnalysis, type SubscriptionTier } from "@/lib/entitlements";',
    );
  });

  it("does not re-declare the helper locally", () => {
    expect(apiSource).not.toContain("function canUsePuttingAnalysis");
  });

  it("does not re-derive the entitlement decision from tier literals", () => {
    // The narrowing vocabulary lives at module scope and is a different thing:
    // it recognises which strings are tiers at all. The branch must not decide
    // *entitlement* by comparing against granting tiers, or the product rule
    // would exist in two places and drift.
    for (const granting of ['=== "birdie"', '=== "eagle"', '=== "coach_starter"', '=== "coach_pro"']) {
      expect(
        puttingBranchSource,
        `the putting branch must not decide entitlement with ${granting}`,
      ).not.toContain(granting);
    }
  });

  it("borrows no other entitlement helper for putting", () => {
    expect(apiSource).not.toContain("canUseLaunchMonitor");
    expect(apiSource).not.toContain("canUseUltraDeepAnalysis");
    expect(apiSource).not.toContain("getAnalysisModeForTier");
  });
});

// ─── The stored tier is untrusted until it is narrowed ────────────────────────

describe("the database tier is narrowed before it can be judged", () => {
  it("declares a positive type guard over the tier vocabulary", () => {
    expect(apiSource).toContain("function isSubscriptionTier(value: unknown): value is SubscriptionTier {");
  });

  it("recognises exactly the six known tiers, by allow-list", () => {
    const start = apiSource.indexOf("const SUBSCRIPTION_TIERS");
    expect(start, `${ROUTE}: tier vocabulary not found`).toBeGreaterThanOrEqual(0);
    const end = apiSource.indexOf("];", start);
    expect(end).toBeGreaterThan(start);
    const vocabulary = apiSource.slice(start, end);

    for (const tier of ["par", "birdie", "eagle", "coach_starter", "coach_pro", "none"]) {
      expect(vocabulary, `tier vocabulary is missing ${tier}`).toContain(`"${tier}"`);
    }
    // Typed against SubscriptionTier, so the vocabulary cannot drift into a
    // string nobody has declared.
    expect(apiSource).toContain("const SUBSCRIPTION_TIERS: readonly SubscriptionTier[]");
  });

  it("reads the stored value as unknown rather than trusting its declared type", () => {
    expect(puttingBranchSource).toContain("const storedTier: unknown = profile?.subscription_tier;");
  });

  it("grants nothing by cast", () => {
    // A cast is how an unrecognised tier would sneak past the guard.
    expect(puttingBranchSource).not.toContain("as SubscriptionTier");
    expect(puttingBranchSource).not.toContain("as any");
    expect(apiSource).not.toContain("as any");
  });

  it("never substitutes a default tier for an unusable one", () => {
    // Defaulting to "none" or "par" would silently convert a lookup failure
    // into an entitlement answer. The contract calls that a failure, not a tier.
    expect(puttingBranchSource).not.toContain('?? "none"');
    expect(puttingBranchSource).not.toContain('?? "par"');
  });

  it("passes the helper only a narrowed tier", () => {
    expect(puttingBranchSource).toContain("let currentTier: SubscriptionTier | null = null;");
    expect(puttingBranchSource).toContain("canUsePuttingAnalysis(currentTier)");
  });
});

// ─── The lookup is server-side, current, and minimal ──────────────────────────

describe("the tier comes from the authenticated user's own row", () => {
  it("queries the users table on the server", () => {
    expect(puttingBranchSource).toContain('.from("users")');
  });

  it("selects only the subscription tier", () => {
    expect(puttingBranchSource).toContain('.select("subscription_tier")');
    expect(puttingBranchSource, "no whole-row read").not.toContain('.select("*")');
  });

  it("scopes the lookup to the authenticated identity", () => {
    expect(puttingBranchSource).toContain('.eq("id", user.id)');
  });

  it("reads the tier fresh, with no caching", () => {
    // One query, evaluated per request. A module-level cache would let a
    // downgrade go unnoticed for the life of the process.
    expect((apiSource.match(/\.select\("subscription_tier"\)/g) ?? []).length).toBe(1);
  });
});

// ─── The client may not author authority ──────────────────────────────────────

describe("no client-supplied field can influence execution authority", () => {
  it("keeps the request body limited to its established contract", () => {
    expect(requestBodySource).toContain("analysisId: string;");
    for (const field of [
      "tier",
      "subscription_tier",
      "analysis_family",
      "equipment_snapshot",
      "club_id",
      "club_type",
      "isPutting",
      "selectedPutter",
    ]) {
      expect(requestBodySource, `RequestBody must not accept ${field}`).not.toContain(field);
    }
  });

  it("still routes the family from the database row alone", () => {
    expect(apiSource).toContain("classifyAnalysisFamilyRoute(analysisRow.analysis_family)");
    // Exactly one read: the classifier argument, unchanged by this slice.
    expect(apiSource.split("analysisRow.analysis_family")).toHaveLength(2);
  });
});

// ─── Failure semantics ────────────────────────────────────────────────────────

describe("an untrustworthy tier fails closed with generic copy", () => {
  it("treats a missing, errored or unrecognised tier as one failure", () => {
    expect(puttingBranchSource).toContain("if (currentTier === null) {");
    expect(puttingBranchSource).toContain(`{ error: "${FIVE_HUNDRED_COPY}" }`);
    expect(puttingBranchSource).toContain("{ status: 500 }");
  });

  it("catches a thrown lookup rather than letting it escape into execution", () => {
    const tryIdx = puttingBranchSource.indexOf("try {");
    const catchIdx = puttingBranchSource.indexOf("} catch {");
    const gate = puttingBranchSource.indexOf("if (currentTier === null) {");
    expect(tryIdx, "the lookup must be guarded").toBeGreaterThanOrEqual(0);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    expect(gate, "the fail-closed branch must follow the catch").toBeGreaterThan(catchIdx);
  });

  it("scopes the catch to the lookup, not to the rest of the branch", () => {
    // Exactly one in the putting branch: the tier lookup's own. The full-swing
    // path further down has its own long-standing try/catch blocks around
    // Gemini and parsing, which are none of this slice's business and are not
    // counted here.
    expect((puttingBranchSource.match(/\} catch \{/g) ?? []).length).toBe(1);

    // Whatever the catch swallows becomes a refusal, never an execution: the
    // only statement inside it sets the tier back to null.
    const catchIdx = puttingBranchSource.indexOf("} catch {");
    const closeIdx = puttingBranchSource.indexOf("}", puttingBranchSource.indexOf("\n", catchIdx));
    const body = puttingBranchSource.slice(catchIdx, closeIdx);
    expect(body).toContain("currentTier = null;");
    expect(body, "the catch must not resume execution").not.toContain("runPuttingAnalysis");
  });

  it("says nothing about the database or the tier", () => {
    for (const leak of [
      "tierError.message",
      "tierError)",
      "subscription_tier}",
      "${currentTier",
      "${storedTier",
    ]) {
      expect(puttingBranchSource, `the refusal must not surface ${leak}`).not.toContain(leak);
    }
  });
});

describe("an unentitled tier is refused with the frozen product copy", () => {
  it("returns 403 with the exact copy", () => {
    expect(puttingBranchSource).toContain("if (!canUsePuttingAnalysis(currentTier)) {");
    expect(puttingBranchSource).toContain(`"${FOUR_OH_THREE_COPY}"`);
    expect(puttingBranchSource).toContain("{ status: 403 }");
  });

  it("names no tier in the golfer-facing copy", () => {
    for (const tier of ["par", "birdie", "eagle", "coach_starter", "coach_pro"]) {
      expect(FOUR_OH_THREE_COPY.toLowerCase()).not.toContain(tier);
    }
  });
});

// ─── Ordering: the gate precedes every putting side effect ────────────────────

describe("nothing putting-specific happens before the gate", () => {
  it("runs the lookup, the narrowing and the judgement in that order", () => {
    const family = anchor("classifyAnalysisFamilyRoute(analysisRow.analysis_family)");
    const branch = anchor('analysisRoute === "putting_pipeline"');
    const lookup = anchor('.select("subscription_tier")');
    const narrow = anchor("isSubscriptionTier(storedTier)");
    const judge = anchor("canUsePuttingAnalysis(currentTier)");
    const run = anchor("runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)");

    expect(family).toBeLessThan(branch);
    expect(branch).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(narrow);
    expect(narrow).toBeLessThan(judge);
    expect(judge).toBeLessThan(run);
  });

  it("refuses before the pipeline is ever called", () => {
    const refusal500 = anchor("{ status: 500 }");
    const refusal403 = anchor("{ status: 403 }");
    const run = anchor("runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)");
    expect(refusal500).toBeLessThan(run);
    expect(refusal403).toBeLessThan(run);
  });

  /**
   * Every ordering assertion above locates the pipeline call with indexOf, which
   * finds the FIRST one. That proves the first call is gated and says nothing
   * about a second. A later ungated invocation — a fallback after the routing
   * branches, a duplicate inside full swing, a retry appended to the handler —
   * would satisfy all of them while handing an unentitled golfer the pipeline.
   *
   * So the invariant is counted, not merely ordered: the handler contains
   * exactly one invocation, it lives in the putting branch, and it comes after
   * the entitlement check. One call site that is gated means no ungated one can
   * exist.
   *
   * The declaration is not a call site. It is excluded structurally rather than
   * by subtracting one from a total — the handler slice begins at POST, and the
   * assertions below prove the declaration sits outside it rather than assuming
   * so.
   */
  it("calls the pipeline from exactly one place, and that place is behind the gate", () => {
    const invocation = /\brunPuttingAnalysis\s*\(/g;
    const declaration = "async function runPuttingAnalysis(";

    // The declaration exists exactly once and is outside the handler slice, so
    // nothing counted below is the declaration.
    expect((apiSource.match(/\basync function runPuttingAnalysis\s*\(/g) ?? [])).toHaveLength(1);
    expect(handlerSource, "the handler slice must not contain the declaration").not.toContain(
      declaration,
    );
    expect(apiSource.indexOf(declaration)).toBeLessThan(
      apiSource.indexOf("export async function POST("),
    );

    // Exactly one invocation in the whole POST handler — not merely one before
    // some cut-off point.
    expect(
      handlerSource.match(invocation) ?? [],
      "the POST handler must invoke the putting pipeline exactly once",
    ).toHaveLength(1);

    // That one invocation is the one inside the putting branch, and the other
    // families invoke it not at all.
    expect(
      puttingBranchSource.match(invocation) ?? [],
      "the sole invocation must be the putting branch's",
    ).toHaveLength(1);
    expect(
      otherFamiliesSource.match(invocation) ?? [],
      "no full-swing, unsupported-family or trailing handler call may exist",
    ).toHaveLength(0);

    // And it runs after the entitlement decision, inside that same branch.
    const gate = puttingBranchSource.indexOf("canUsePuttingAnalysis(currentTier)");
    const call = puttingBranchSource.search(/\brunPuttingAnalysis\s*\(/);
    expect(gate, "the entitlement check is missing from the branch").toBeGreaterThanOrEqual(0);
    expect(call, "the sole invocation must follow the entitlement check").toBeGreaterThan(gate);
  });

  /**
   * The side effects are not listed in the handler at all — they live inside
   * runPuttingAnalysis. Proving the gate precedes the call, and that each side
   * effect is inside the helper, is what proves the gate precedes them all.
   */
  it("keeps every putting side effect inside the helper the gate guards", () => {
    for (const sideEffect of [
      "isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)",
      '"[analyze-swing] putting cache hit"',
      '.update({ status: "processing" })',
      ".createSignedUrl(storagePath, 3600)",
      "await fetchVideoBytes(",
      "puttingModel.generateContent({",
      // EQ5F-E builds the envelope into a local before deriving the score from
      // it, so the inline form is gone. The property this line stands for is
      // unchanged: constructing the persisted analysis, and persisting the
      // completed result, both remain side effects of the guarded helper.
      "buildPersistedPuttingAnalysis(puttingValidated.response)",
      "putting_score: puttingScore,",
      '.update({ status: "failed" })',
    ]) {
      expect(
        puttingHelperSource,
        `${sideEffect} must remain inside runPuttingAnalysis`,
      ).toContain(sideEffect);
    }
  });

  it("puts the gate outside that helper, so the cache cannot answer first", () => {
    expect(puttingHelperSource).not.toContain("canUsePuttingAnalysis");
    expect(puttingHelperSource).not.toContain('.select("subscription_tier")');
    expect(puttingHelperSource).not.toContain("isSubscriptionTier");
    // The cached early return is the first thing the helper does, which is
    // exactly why the gate cannot be delegated to it.
    const cache = puttingHelperSource.indexOf("isPersistedPuttingAnalysisV1(analysisRow.putting_analysis)");
    expect(cache).toBeGreaterThanOrEqual(0);
    expect(anchor("canUsePuttingAnalysis(currentTier)")).toBeLessThan(
      anchor("runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)"),
    );
  });

  it("reaches the existing pipeline unchanged when entitled", () => {
    expect(puttingBranchSource).toContain(
      "return await runPuttingAnalysis(supabase, analysisRow, analysisId, user.id);",
    );
    expect(apiSource).toContain("async function runPuttingAnalysis(");
  });
});

// ─── The other two families are untouched ─────────────────────────────────────

describe("only putting pays for putting", () => {
  it("evaluates the entitlement in the putting branch alone", () => {
    expect(puttingBranchSource).toContain("canUsePuttingAnalysis(");
    expect(otherFamiliesSource).not.toContain("canUsePuttingAnalysis(");
    expect(otherFamiliesSource).not.toContain("isSubscriptionTier(");
    expect(otherFamiliesSource).not.toContain('.select("subscription_tier")');
  });

  it("leaves the unsupported-family refusal exactly as it was", () => {
    expect(otherFamiliesSource).toContain(`{ error: "${FIVE_HUNDRED_COPY}" }`);
    expect(otherFamiliesSource).toContain(
      'console.error("[analyze-swing] unsupported analysis family")',
    );
  });

  it("leaves the full-swing pipeline unregressed", () => {
    for (const anchorText of [
      'console.log("[analyze-swing] row status:", analysisRow.status)',
      "const geminiKey = resolveGeminiKey()",
      "extractSwingMetrics(",
      "generateContent(",
    ]) {
      expect(otherFamiliesSource, `full swing lost ${anchorText}`).toContain(anchorText);
    }
  });
});

// ─── Logging hygiene for the new code ─────────────────────────────────────────

describe("the entitlement code says nothing it should not", () => {
  it("adds no logging to the putting branch at all", () => {
    // The contract prefers silence here over a careful log: there is no
    // diagnostic worth the risk of one day interpolating the tier into it.
    expect(puttingBranchSource).not.toContain("console.");
  });

  it("keeps identifiers and provider detail out of every console call", () => {
    const consoleLines = apiSource.split("\n").filter((line) => line.includes("console."));
    for (const banned of [
      "subscription_tier",
      "currentTier",
      "storedTier",
      "tierError",
      "user.id",
      "user?.id",
      "analysisId",
    ]) {
      for (const line of consoleLines) {
        expect(line, `a console call must not carry ${banned}`).not.toContain(banned);
      }
    }
  });
});
