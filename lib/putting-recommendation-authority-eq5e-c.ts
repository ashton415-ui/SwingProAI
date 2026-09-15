import "server-only";

import type { createClient } from "@/utils/supabase/server";
import { canUsePuttingRecommendations, type SubscriptionTier } from "@/lib/entitlements";
import { isPersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";
import { projectPuttingDrillEvidence } from "@/lib/putting-drill-evidence-eq5d-a";
import { classifyPuttingEvidence } from "@/lib/putting-signal-classification-eq5e-a";
import {
  rankPuttingDrillRecommendations,
  type PuttingDrillRecommendationCandidateV1,
  type PuttingRecommendationReasonCode,
  type PuttingRecommendationSourceSection,
  type PuttingRecommendationTargetCategory,
} from "@/lib/putting-drill-recommendation-eq5e-b";

// ============================================================================
// EQ5E-C — putting recommendation authority
// ============================================================================
//
// Everything upstream of this module is a pure function of one already-trusted
// envelope. None of it knows whose stroke it is, whether that golfer paid for
// anything, or whether the catalog it names still says what it said when the
// rules were written. This module is where those questions get asked, and it
// asks all of them before anybody is told to practise anything.
//
// It decides nothing about WHICH work is recommended. That was settled by the
// classifier and the rule set, and re-deciding it here would create a second
// opinion nobody reconciles. What this adds is permission and provenance: the
// golfer is entitled, the analysis is theirs, it really is a putting analysis,
// it really finished, its stored payload really validates, and the catalog rows
// the rules named really exist and really still agree with them.
//
// Every one of those is required positively. `status` in particular carries no
// database constraint, so "not pending and not processing" would be a deny-list
// over a column that can hold anything — every value nobody thought to exclude
// would fall through to a finished-looking result. And a stored payload is
// never cleared when a later run fails, so a failed row can still hold a valid
// envelope; recommending from it would tell a golfer their analysis succeeded
// when it did not.
//
// Failures deliberately do not explain themselves. A request for somebody
// else's analysis, a request for one that does not exist, one that is still
// running and one that is full-swing all return the same thing, because a
// distinguishable "not yours" is a confirmation that the id exists.
//
// The catalog half fails whole rather than in part. If the row behind the first
// recommendation is missing or has drifted, quietly returning the second one
// would present different work as the top priority with nothing to say it had
// changed. Better to return nothing and let somebody look.
//
// `server-only` is imported below and enforced by the bundler: the validation
// contract this module depends on reaches a model SDK behind itself, so an
// accidental import from a client component would pull that into the browser.
// The import is load-bearing, not decorative.
//
// Three things this module must never become:
//
//   1. A recommender. No mapping, no ranking, no scoring, no re-ordering.
//   2. A writer. It reads two tables and writes nothing, anywhere, ever.
//   3. An assignment or a verification. A recommendation is a suggestion; it
//      is not work handed to a golfer, and it is not work they have proven.

/** The narrowest view of the authenticated server client this module needs. */
export type PuttingRecommendationAuthorityClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

/**
 * One recommendation, carrying both halves of its justification.
 *
 * The rule-set fields say why this drill and in what order; the canonical
 * fields say what the drill actually is. The second half is read from the
 * catalog every time rather than stored here, so a coaching correction made in
 * the catalog is the version a golfer sees.
 *
 * `target_category` survives from the candidate even though it was reconciled
 * against the stored column on the way through. The reconciliation proves the
 * two agree; keeping the rule-set value is what lets a later reader see which
 * target the rules actually selected rather than what a row happened to hold.
 */
export interface HydratedPuttingDrillRecommendationV1 {
  readonly drill_id: string;
  readonly target_category: PuttingRecommendationTargetCategory;
  readonly rank: PuttingDrillRecommendationCandidateV1["rank"];
  readonly source_section: PuttingRecommendationSourceSection;
  readonly observed_assessment: string;
  readonly reason_code: PuttingRecommendationReasonCode;
  readonly ruleset_version: PuttingDrillRecommendationCandidateV1["ruleset_version"];
  readonly name: string;
  readonly the_why: string | null;
  readonly the_how: string | null;
  readonly the_feel: string | null;
  readonly instructional_video_url: string | null;
}

/**
 * What the authority concluded.
 *
 * Four outcomes, and the distinction between the last two matters: an
 * unavailable analysis means there is nothing to recommend for this golfer,
 * while an unavailable catalog means the rules and the catalog disagree. The
 * first is ordinary; the second is a fault, and a consumer that rendered them
 * identically would hide it.
 *
 * `ready` with an empty list is an ordinary, correct answer. A stroke the
 * evidence found sound throughout, or could not read at all, genuinely has no
 * recommendation, and inventing one would be the failure.
 */
export type PuttingRecommendationResultV1 =
  | { readonly status: "locked" }
  | { readonly status: "unavailable" }
  | { readonly status: "catalog_unavailable" }
  | {
      readonly status: "ready";
      readonly source_analysis_id: string;
      readonly recommendations: readonly HydratedPuttingDrillRecommendationV1[];
    };

/** The only columns the authority needs from the source analysis. */
const SOURCE_ANALYSIS_COLUMNS = "id, user_id, status, analysis_family, putting_analysis";

/**
 * The only columns the authority needs from the canonical catalog.
 *
 * The verification-prompt column is deliberately absent. Putting verification
 * does not exist, every seeded row carries a sentinel saying so, and a sentinel
 * that never enters this module cannot be mistaken downstream for a capability.
 */
const CATALOG_COLUMNS =
  "id, name, target_metric, the_why, the_how, the_feel, instructional_video_url, drill_family";

const PUTTING_FAMILY = "putting";
const COMPLETED_STATUS = "complete";

const LOCKED: PuttingRecommendationResultV1 = Object.freeze({ status: "locked" });
const UNAVAILABLE: PuttingRecommendationResultV1 = Object.freeze({ status: "unavailable" });
const CATALOG_UNAVAILABLE: PuttingRecommendationResultV1 = Object.freeze({
  status: "catalog_unavailable",
});
const NO_RECOMMENDATIONS: readonly HydratedPuttingDrillRecommendationV1[] = Object.freeze([]);

/** The source row as it actually arrives, rather than as the column list promises. */
interface RuntimeSourceRow {
  readonly id?: unknown;
  readonly user_id?: unknown;
  readonly status?: unknown;
  readonly analysis_family?: unknown;
  readonly putting_analysis?: unknown;
}

/** A catalog row as it actually arrives. */
interface RuntimeCatalogRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly target_metric?: unknown;
  readonly the_why?: unknown;
  readonly the_how?: unknown;
  readonly the_feel?: unknown;
  readonly instructional_video_url?: unknown;
  readonly drill_family?: unknown;
}

/** A query outcome, read without trusting the client's declared generics. */
interface RuntimeQueryOutcome {
  readonly data?: unknown;
  readonly error?: unknown;
}

function asOutcome(value: unknown): RuntimeQueryOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  return value as RuntimeQueryOutcome;
}

/** True for a nullable text column that arrived as text or as null. */
function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Resolves the authoritative putting drill recommendations for one golfer and
 * one analysis.
 *
 * The caller supplies the identity and tier, because only a server route or
 * page holds the authenticated session that establishes them; nothing here
 * reads them from the request, the stored payload, or the candidates. The
 * fetched row is then re-checked against both anyway, so a query that somehow
 * returned the wrong row cannot pass on the strength of its filter alone.
 *
 * Nothing throws for an ordinary refusal. A locked tier, a missing analysis and
 * a drifted catalog are answers, not exceptions, and a caller should not have
 * to survive a throw to find out which one it got.
 */
export async function resolvePuttingDrillRecommendations(
  client: PuttingRecommendationAuthorityClient,
  params: {
    readonly userId: string;
    readonly tier: SubscriptionTier;
    readonly sourceAnalysisId: string;
  },
): Promise<PuttingRecommendationResultV1> {
  if (!canUsePuttingRecommendations(params.tier)) return LOCKED;

  let sourceOutcome: RuntimeQueryOutcome | null;
  try {
    sourceOutcome = asOutcome(
      await client
        .from("swing_analysis")
        .select(SOURCE_ANALYSIS_COLUMNS)
        .eq("id", params.sourceAnalysisId)
        .eq("user_id", params.userId)
        .single(),
    );
  } catch {
    return UNAVAILABLE;
  }

  if (sourceOutcome === null) return UNAVAILABLE;
  if (sourceOutcome.error) return UNAVAILABLE;

  const sourceData = sourceOutcome.data;
  if (typeof sourceData !== "object" || sourceData === null) return UNAVAILABLE;

  const row = sourceData as RuntimeSourceRow;
  if (typeof row.id !== "string" || row.id !== params.sourceAnalysisId) return UNAVAILABLE;
  if (typeof row.user_id !== "string" || row.user_id !== params.userId) return UNAVAILABLE;
  if (row.analysis_family !== PUTTING_FAMILY) return UNAVAILABLE;
  if (row.status !== COMPLETED_STATUS) return UNAVAILABLE;

  const persisted = row.putting_analysis;
  if (!isPersistedPuttingAnalysisV1(persisted)) return UNAVAILABLE;

  // Provenance comes from the row the authority actually proved, not from the
  // argument it was asked about. The two are equal by the check above; using
  // the row is what keeps that an assertion rather than an assumption.
  const sourceAnalysisId = row.id;

  const candidates = rankPuttingDrillRecommendations(
    classifyPuttingEvidence(projectPuttingDrillEvidence(persisted, sourceAnalysisId)),
  );

  if (candidates.length === 0) {
    return Object.freeze({
      status: "ready",
      source_analysis_id: sourceAnalysisId,
      recommendations: NO_RECOMMENDATIONS,
    });
  }

  let catalogOutcome: RuntimeQueryOutcome | null;
  try {
    catalogOutcome = asOutcome(
      await client
        .from("drills")
        .select(CATALOG_COLUMNS)
        .in(
          "id",
          candidates.map((candidate) => candidate.drill_id),
        )
        .eq("drill_family", PUTTING_FAMILY),
    );
  } catch {
    return CATALOG_UNAVAILABLE;
  }

  if (catalogOutcome === null) return CATALOG_UNAVAILABLE;
  if (catalogOutcome.error) return CATALOG_UNAVAILABLE;

  const catalogData = catalogOutcome.data;
  if (!Array.isArray(catalogData)) return CATALOG_UNAVAILABLE;

  // One row per candidate and no more. A short result means a named drill has
  // gone; a long one means the filter did not hold. Either way the rules and
  // the catalog no longer describe the same thing.
  if (catalogData.length !== candidates.length) return CATALOG_UNAVAILABLE;

  const rowsById = new Map<string, RuntimeCatalogRow>();
  for (const entry of catalogData) {
    if (typeof entry !== "object" || entry === null) return CATALOG_UNAVAILABLE;
    const catalogRow = entry as RuntimeCatalogRow;
    if (typeof catalogRow.id !== "string") return CATALOG_UNAVAILABLE;
    if (rowsById.has(catalogRow.id)) return CATALOG_UNAVAILABLE;
    rowsById.set(catalogRow.id, catalogRow);
  }

  const hydrated: HydratedPuttingDrillRecommendationV1[] = [];

  // The candidate list is the order. The query returned rows in whatever order
  // it liked, and reading them in that order would let the database decide
  // which drill a golfer is told to work on first.
  for (const candidate of candidates) {
    const catalogRow = rowsById.get(candidate.drill_id);
    if (catalogRow === undefined) return CATALOG_UNAVAILABLE;
    if (catalogRow.drill_family !== PUTTING_FAMILY) return CATALOG_UNAVAILABLE;
    if (catalogRow.target_metric !== candidate.target_category) return CATALOG_UNAVAILABLE;
    if (typeof catalogRow.name !== "string" || catalogRow.name.length === 0) {
      return CATALOG_UNAVAILABLE;
    }
    if (!isNullableText(catalogRow.the_why)) return CATALOG_UNAVAILABLE;
    if (!isNullableText(catalogRow.the_how)) return CATALOG_UNAVAILABLE;
    if (!isNullableText(catalogRow.the_feel)) return CATALOG_UNAVAILABLE;
    if (!isNullableText(catalogRow.instructional_video_url)) return CATALOG_UNAVAILABLE;

    hydrated.push(
      Object.freeze({
        drill_id: candidate.drill_id,
        target_category: candidate.target_category,
        rank: candidate.rank,
        source_section: candidate.source_section,
        observed_assessment: candidate.observed_assessment,
        reason_code: candidate.reason_code,
        ruleset_version: candidate.ruleset_version,
        name: catalogRow.name,
        the_why: catalogRow.the_why,
        the_how: catalogRow.the_how,
        the_feel: catalogRow.the_feel,
        instructional_video_url: catalogRow.instructional_video_url,
      }),
    );
  }

  return Object.freeze({
    status: "ready",
    source_analysis_id: sourceAnalysisId,
    recommendations: Object.freeze(hydrated),
  });
}
