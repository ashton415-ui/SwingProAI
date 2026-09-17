import type {
  PuttingEvidenceClassificationV1,
  PuttingSignalClassification,
} from "@/lib/putting-signal-classification-eq5e-a";

// ============================================================================
// EQ5F-D — the versioned putting score
// ============================================================================
//
// This module turns a classified putting stroke into one number, and it is very
// careful about what that number is allowed to mean.
//
// It is a qualitative coaching INDEX. It is not a measurement, not a percentage
// of any physical quantity, not a launch-monitor metric, not the existing
// full-swing score, and not a rank. The stroke behind it was recorded on an
// uncalibrated phone camera, so the only honest raw material is the closed set
// of four coaching states an earlier layer already derived from enumerated
// assessments. This module adds arithmetic over those states and nothing else.
//
// What that forbids is worth stating plainly, because each of these would be a
// way of smuggling precision back in:
//
//   * no model-authored number. The model never sees this module and never
//     produces a figure it could hand over.
//   * no prose. A section's narrative is not read here. The carried assessment
//     token is checked as a string for compatibility and is then ignored by the
//     arithmetic, so what a golfer is told cannot depend on how a sentence was
//     phrased.
//   * no measurements. The three numeric putting columns are permanently
//     unwritten upstream, and nothing here consumes, mentions or reconstructs
//     them.
//   * no identity. No golfer, tier, purchase, history or clock reaches this
//     function, so two strokes classified alike score alike, always.
//
// The single dependency is type-only, and that is load-bearing rather than
// stylistic: the classification module's own dependency chain reaches a model
// SDK, and a runtime import would drag that behind this file. Types are erased
// at compile time, so this module imports nothing at runtime at all — no I/O,
// no network, no database, no clock, no randomness.
//
// Two things it must never become:
//
//   1. A recommender. There is no catalog identity here, no ranking, no
//      selection, and no import of either recommendation module. A score says
//      how a stroke looked; it does not choose anybody's practice.
//
//   2. The full-swing score. That column is written by one full-swing branch of
//      the analysis route and read by full-swing consumers. It is never read,
//      written or referenced here, and this index shares nothing with it but
//      the coincidence of both being numbers.
//
// Nothing here persists. The result exists only in the returned envelope, and
// no row, column or cache is touched, so every analysis recorded before this
// module existed remains exactly as it was.

/**
 * Version of the EQ5F-D scoring algorithm.
 *
 * Deliberately independent of every upstream version: how a stroke is
 * described, how a description is graded, what evidence a recommender may see
 * and how drills are ranked are four separate compatibility events, and a score
 * that borrowed any of their numbers would become a hostage of that layer's
 * release schedule.
 *
 * v1 semantics are frozen. A future change to the arithmetic is a new version
 * with its own function, never an edit to `computePuttingScoreV1` — which is
 * why no "latest" alias is exported: an alias is exactly the mechanism by which
 * a historical score would silently change meaning.
 */
export const PUTTING_SCORE_VERSION = 1;

/**
 * What the number is derived from, carried in the result so a reader can never
 * mistake it for an instrument reading.
 */
export const PUTTING_SCORE_BASIS = "qualitative_classification_index";

/** The classification envelope version this scorer accepts. */
export const PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION = 1;

/** Every canonical section, whether or not the video supported it. */
export const PUTTING_SCORE_TOTAL_SECTIONS = 6;

/**
 * How much of the stroke the score actually speaks for.
 *
 * Reported beside the score rather than folded into it. A stroke where one
 * section was readable and a stroke where all six were are different facts, and
 * a bare number would present them identically — which is the kind of
 * manufactured completeness this product does not ship.
 */
export interface PuttingScoreCoverageV1 {
  /** Sections that carried a usable classification. */
  readonly scorable_sections: number;
  /** Always the full canonical set, so the fraction is readable without context. */
  readonly total_sections: typeof PUTTING_SCORE_TOTAL_SECTIONS;
  /** scorable_sections as a whole percentage of the canonical set. */
  readonly percent: number;
}

/**
 * One scored stroke.
 *
 * `score` is null when nothing was scorable. Null is the honest answer there:
 * zero would claim a stroke was assessed and found faultless-in-reverse, when
 * in fact it was never assessed at all.
 */
export interface PuttingScoreV1 {
  readonly score_version: typeof PUTTING_SCORE_VERSION;
  readonly basis: typeof PUTTING_SCORE_BASIS;
  readonly source_classification_version: typeof PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION;
  /** 0-100 inclusive, or null when no section was scorable. */
  readonly score: number | null;
  readonly coverage: PuttingScoreCoverageV1;
}

/**
 * The canonical section keys, transcribed rather than imported.
 *
 * A runtime import of the upstream list would reach the model SDK behind it, so
 * the list is restated here as a compatibility check — this is what an accepted
 * envelope must contain — and this module's test reconciles it against the
 * canonical vocabulary, so the two cannot drift apart unnoticed.
 */
const CANONICAL_SECTION_KEYS = [
  "setup_alignment",
  "stroke_path",
  "face_at_impact",
  "tempo_rhythm",
  "stroke_symmetry",
  "stability",
] as const;

const ENVELOPE_KEYS = ["classification_version", "sections"] as const;

const SECTION_ENTRY_KEYS = ["assessment", "classification"] as const;

/** The three states that carry points. */
type ScorablePuttingClassification = Exclude<
  PuttingSignalClassification,
  "insufficient_evidence"
>;

/**
 * The v1 point mapping. Equal weight for every section: there is no
 * section-specific multiplier anywhere in this module, because nothing in the
 * evidence establishes that one part of a stroke matters more than another.
 *
 * `insufficient_evidence` is deliberately absent. It is not worth zero points —
 * it is worth no points and no denominator slot, and a table entry for it would
 * be the first step toward scoring a golfer down for a camera angle.
 */
const SECTION_POINTS = Object.freeze({
  strength: 2,
  acceptable: 1,
  needs_improvement: 0,
}) satisfies Readonly<Record<ScorablePuttingClassification, number>>;

/** Points a single section can contribute at most. */
const MAX_POINTS_PER_SECTION = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the object's own keys are exactly `expected` — no more, no fewer.
 *
 * `Reflect.ownKeys` rather than `Object.keys` so a symbol key or a
 * non-enumerable key cannot ride along unseen, and `hasOwnProperty` so an
 * inherited key cannot satisfy a requirement the object does not actually meet.
 */
function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  if (Reflect.ownKeys(value).length !== expected.length) return false;
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

function isPuttingSignalClassification(
  value: unknown,
): value is PuttingSignalClassification {
  return (
    value === "strength" ||
    value === "acceptable" ||
    value === "needs_improvement" ||
    value === "insufficient_evidence"
  );
}

/**
 * Strict compatibility check for an EQ5E-A classification envelope.
 *
 * Everything is required positively and exactly. A deny-list would let every
 * shape nobody thought of through, and the shapes nobody thought of are the
 * ones worth refusing: a payload carrying its own `score`, a seventh section, a
 * section entry that also carries prose, an envelope from a future
 * classification version whose states may mean something else.
 *
 * A malformed envelope is never repaired into `insufficient_evidence`. That
 * state is a real finding about a real stroke; borrowing it for "this object
 * was wrong" would let a broken payload score as an honestly unreadable one.
 */
function isCompatibleClassificationEnvelope(
  value: unknown,
): value is PuttingEvidenceClassificationV1 {
  if (!isPlainObject(value)) return false;
  if (!hasExactOwnKeys(value, ENVELOPE_KEYS)) return false;
  if (value.classification_version !== PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION) {
    return false;
  }

  const sections = value.sections;
  if (!isPlainObject(sections)) return false;
  if (!hasExactOwnKeys(sections, CANONICAL_SECTION_KEYS)) return false;

  for (const key of CANONICAL_SECTION_KEYS) {
    const entry = sections[key];
    if (!isPlainObject(entry)) return false;
    if (!hasExactOwnKeys(entry, SECTION_ENTRY_KEYS)) return false;
    if (typeof entry.assessment !== "string") return false;
    if (!isPuttingSignalClassification(entry.classification)) return false;
  }

  return true;
}

/**
 * Scores one classified putting stroke under v1.
 *
 * Fails closed by returning null rather than throwing: a caller deciding what
 * to render should not have to survive an exception to discover that a stored
 * payload was incompatible, and an exception thrown through a server component
 * would take a whole page down over one unreadable row.
 *
 * The input is `unknown` on purpose. The value arrives through untyped jsonb
 * and an untyped row projection, so the declared type would be an expectation
 * rather than a guarantee; this is the boundary where it is checked instead of
 * assumed.
 *
 * Nothing is written to the input, and the result is frozen at every level, so
 * a caller cannot edit a score it was handed.
 */
export function computePuttingScoreV1(input: unknown): PuttingScoreV1 | null {
  if (!isCompatibleClassificationEnvelope(input)) return null;

  let pointSum = 0;
  let scorableSections = 0;

  // The canonical list is the iteration order, not the object's own key order.
  // Reading the payload's order would let the shape of a stored row decide the
  // arithmetic, and the score must not depend on how a payload was serialised.
  for (const key of CANONICAL_SECTION_KEYS) {
    const { classification } = input.sections[key];
    if (classification === "insufficient_evidence") continue;
    pointSum += SECTION_POINTS[classification];
    scorableSections += 1;
  }

  const score =
    scorableSections > 0
      ? Math.round((100 * pointSum) / (MAX_POINTS_PER_SECTION * scorableSections))
      : null;

  const coverage: PuttingScoreCoverageV1 = Object.freeze({
    scorable_sections: scorableSections,
    total_sections: PUTTING_SCORE_TOTAL_SECTIONS,
    percent: Math.round((100 * scorableSections) / PUTTING_SCORE_TOTAL_SECTIONS),
  });

  return Object.freeze({
    score_version: PUTTING_SCORE_VERSION,
    basis: PUTTING_SCORE_BASIS,
    source_classification_version: PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION,
    score,
    coverage,
  });
}
