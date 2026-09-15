import type { PuttingEvidenceClassificationV1 } from "@/lib/putting-signal-classification-eq5e-a";

// ============================================================================
// EQ5E-B — deterministic putting drill mapping and ranking
// ============================================================================
//
// This module turns "which parts of the stroke need work" into "which catalog
// entries a golfer could be pointed at, in what order". It decides candidates.
// It does not decide who may see them, whether the golfer owns the analysis,
// whether the catalog rows still exist, or what any of them say. Those are the
// authority layer's, and keeping them out is what lets this one be a pure
// function with a single answer per input.
//
// Four of the six assessed sections map to a catalog entry. The other two do
// not, and neither do three of the seven catalog entries — not as an oversight
// but because nothing in the accepted evidence can establish where the ball
// was struck on the face, how far it finished, or whether a short putt fell.
// A single stroke observed on uncalibrated video says nothing about any of
// them, and a recommendation drawn from silence is a guess wearing a citation.
// The gap stays visible here rather than being filled from prose, equipment,
// resemblance between names, or an invented severity.
//
// Only one classification earns a candidate: needs_improvement. A section the
// evidence found sound is not an opportunity to reinforce, a section that is
// merely acceptable is not a soft fault, and a section the video could not
// support is not evidence of anything. That last distinction is the whole
// reason the classifier separated the four states in the first place; folding
// any of them back together here would undo it.
//
// Priority is declaration order in the rule list below, and it is a product
// decision rather than a measurement. Nothing in the evidence carries severity,
// confidence or probability, so there is nothing to sort by and no comparator
// exists. Walking a fixed list also makes the result independent of how the
// caller's object happened to be built, which a loop over input keys would not.
//
// What a candidate carries is an identity and a reason, never content. The
// catalog owns names, coaching copy and media; duplicating any of it here would
// create a second version of the truth that nobody updates. Provenance is
// likewise absent: the envelope this function receives does not know which
// analysis produced it, so attaching one would be fabrication rather than
// record-keeping. The layer that authorized the analysis attaches it.
//
// The module is pure: one type-only import, no runtime import of any kind, no
// database, no network, no model, no clock, no randomness. Identical input
// yields identical output, always.

/**
 * Version of this rule set.
 *
 * Separate from the classification envelope's version on purpose. How a
 * stroke is described, how a description is graded, and which catalog entry a
 * grade points at are three decisions that change on three schedules; a single
 * shared number would force them to move together.
 */
export const PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION = 1;

/**
 * The assessed sections that currently map to a catalog entry.
 *
 * A deliberate subset. The two absent sections are assessed by the classifier
 * and simply have nowhere to point yet.
 */
export type PuttingRecommendationSourceSection =
  | "setup_alignment"
  | "face_at_impact"
  | "stroke_path"
  | "tempo_rhythm";

/**
 * The catalog target a candidate points at.
 *
 * Named for what the target trains rather than after the column that stores
 * it. The value is the same string the catalog holds, but this type is a rule
 * set concept: the authority layer is what reconciles it against the stored
 * column, and that reconciliation should be written down there rather than
 * assumed from a matching field name.
 */
export type PuttingRecommendationTargetCategory =
  | "address_setup"
  | "start_line_control"
  | "stroke_path_control"
  | "stroke_tempo";

/**
 * Why a candidate was produced, as a stable code rather than a sentence.
 *
 * A code can be compared exactly by a test, translated later, and answered
 * without appeal to a model. Prose written here would be a second explanation
 * competing with the one the analysis already produced.
 */
export type PuttingRecommendationReasonCode =
  | "setup_alignment_needs_improvement"
  | "face_at_impact_needs_improvement"
  | "stroke_path_needs_improvement"
  | "tempo_rhythm_needs_improvement";

/**
 * One candidate: an identity, its provenance within the analysis, and its
 * place in the order.
 *
 * `observed_assessment` is the exact value the classifier recorded, copied
 * without alteration. It is what lets a later explanation say what was
 * actually seen instead of restating the conclusion, and normalising it would
 * quietly destroy the difference between two assessments that happen to share
 * a grade.
 *
 * `drill_id` stays a plain string. Narrowing it to the four literals below
 * would publish a second copy of the catalog in the type system, so every
 * consumer's types would depend on catalog contents; the private table holds
 * the literals and a test reconciles them against the canonical source.
 */
export interface PuttingDrillRecommendationCandidateV1 {
  readonly drill_id: string;
  readonly target_category: PuttingRecommendationTargetCategory;
  readonly source_section: PuttingRecommendationSourceSection;
  readonly observed_assessment: string;
  readonly reason_code: PuttingRecommendationReasonCode;
  readonly rank: 1 | 2;
  readonly ruleset_version: typeof PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION;
}

/** The classification envelope version this rule set accepts. */
const ACCEPTED_CLASSIFICATION_VERSION = 1;

/** The only classification that earns a candidate. */
const ELIGIBLE_CLASSIFICATION = "needs_improvement";

/** How many candidates a single analysis may produce. */
const MAX_RECOMMENDATIONS = 2;

interface MappingRule {
  readonly source_section: PuttingRecommendationSourceSection;
  readonly target_category: PuttingRecommendationTargetCategory;
  readonly drill_id: string;
  readonly reason_code: PuttingRecommendationReasonCode;
}

/**
 * The rule list, in priority order.
 *
 * The order is the policy. Nothing sorts this, nothing scores it, and nothing
 * reorders it at runtime; a rule earlier in the list is simply considered
 * first. Written as a list rather than a keyed object so the order is part of
 * the declaration instead of an emergent property of key enumeration.
 *
 * Frozen at load: the array and every entry. `readonly` is a compile-time
 * claim that disappears at runtime, and a mapping anything can edit is a
 * mapping that will eventually differ from the one that was reviewed.
 */
const MAPPING_RULES: readonly MappingRule[] = Object.freeze([
  Object.freeze({
    source_section: "setup_alignment",
    target_category: "address_setup",
    drill_id: "d0366fc8-c428-5a21-a145-18ef24b15220",
    reason_code: "setup_alignment_needs_improvement",
  }),
  Object.freeze({
    source_section: "face_at_impact",
    target_category: "start_line_control",
    drill_id: "87a51ed8-6cdc-50c7-864b-2bb9d88af5f7",
    reason_code: "face_at_impact_needs_improvement",
  }),
  Object.freeze({
    source_section: "stroke_path",
    target_category: "stroke_path_control",
    drill_id: "bcae0cfe-9834-5502-9e0b-03b93d5c8a10",
    reason_code: "stroke_path_needs_improvement",
  }),
  Object.freeze({
    source_section: "tempo_rhythm",
    target_category: "stroke_tempo",
    drill_id: "6530ed44-b218-519d-9cdd-57cf2199e44e",
    reason_code: "tempo_rhythm_needs_improvement",
  }),
] as const satisfies readonly MappingRule[]);

/**
 * The empty answer.
 *
 * Returning nothing is a first-class result, not a failure: most of the ways
 * an analysis can come back — sound throughout, unreadable throughout, or
 * troubled only in the two sections that map nowhere — correctly produce no
 * candidate at all. Frozen so the caller cannot turn the absence of a
 * recommendation into one.
 */
const NO_RECOMMENDATIONS: readonly PuttingDrillRecommendationCandidateV1[] =
  Object.freeze([]);

/**
 * The envelope as it actually arrives, rather than as it is declared.
 *
 * The parameter type says the version is the literal 1 and the sections are
 * present, which makes a direct comparison narrow to nothing and check nothing.
 * The value reaches this function through a runtime object, so the declaration
 * is an expectation; this shape is where it gets verified instead of assumed.
 */
interface RuntimeEnvelope {
  readonly classification_version?: unknown;
  readonly sections?: unknown;
}

/**
 * Reads one section's record, or null when the input cannot support one.
 *
 * Own-key only. `constructor`, `toString` and their kin are properties of
 * every object through its prototype, and a lookup that did not ask for own
 * keys would find something there and treat it as an assessment.
 */
function ownSectionRecord(
  sections: object,
  section: PuttingRecommendationSourceSection,
): { readonly classification?: unknown; readonly assessment?: unknown } | null {
  if (!Object.prototype.hasOwnProperty.call(sections, section)) return null;

  const value = (sections as Record<string, unknown>)[section];
  if (typeof value !== "object" || value === null) return null;

  return value as { readonly classification?: unknown; readonly assessment?: unknown };
}

/**
 * Selects and orders the catalog candidates for one classified analysis.
 *
 * Walks the fixed rule list in order, keeps the sections the classifier found
 * in need of work, and stops once two are held. Anything it cannot read with
 * confidence — a version it does not accept, a missing container, a section
 * that is absent or malformed, a classification it does not recognise — yields
 * no candidate for that rule, and never a substituted one. A wrong guess here
 * becomes practice a golfer does not need, and by the time it reaches them the
 * reason it was chosen is gone.
 *
 * Nothing throws. A caller holding six sections should not have to survive an
 * exception to discover that one of them was malformed.
 */
export function rankPuttingDrillRecommendations(
  classification: PuttingEvidenceClassificationV1,
): readonly PuttingDrillRecommendationCandidateV1[] {
  const envelope = classification as unknown as RuntimeEnvelope | null;
  if (typeof envelope !== "object" || envelope === null) return NO_RECOMMENDATIONS;
  if (envelope.classification_version !== ACCEPTED_CLASSIFICATION_VERSION) {
    return NO_RECOMMENDATIONS;
  }

  const sections = envelope.sections;
  if (typeof sections !== "object" || sections === null) return NO_RECOMMENDATIONS;

  const candidates: PuttingDrillRecommendationCandidateV1[] = [];

  for (const rule of MAPPING_RULES) {
    if (candidates.length >= MAX_RECOMMENDATIONS) break;

    const record = ownSectionRecord(sections, rule.source_section);
    if (record === null) continue;
    if (record.classification !== ELIGIBLE_CLASSIFICATION) continue;
    if (typeof record.assessment !== "string") continue;

    candidates.push(
      Object.freeze({
        drill_id: rule.drill_id,
        target_category: rule.target_category,
        source_section: rule.source_section,
        observed_assessment: record.assessment,
        reason_code: rule.reason_code,
        rank: (candidates.length + 1) as 1 | 2,
        ruleset_version: PUTTING_DRILL_RECOMMENDATION_RULESET_VERSION,
      }),
    );
  }

  if (candidates.length === 0) return NO_RECOMMENDATIONS;
  return Object.freeze(candidates);
}
