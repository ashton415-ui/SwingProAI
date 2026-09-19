import {
  PUTTING_SCORE_BASIS,
  PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION,
  PUTTING_SCORE_TOTAL_SECTIONS,
  PUTTING_SCORE_VERSION,
  type PuttingScoreV1,
} from "@/lib/putting-score-eq5f-d";

// ============================================================================
// EQ5F-F — reading a persisted putting score for presentation
// ============================================================================
//
// EQ5F-E wrote a versioned score. This module is the read side of that column,
// and it is deliberately the narrowest thing that can stand between untrusted
// jsonb and a golfer's screen.
//
// What it is NOT is the whole point:
//
//   * not a scorer. There is no point table, no classification vocabulary and
//     no arithmetic over a stroke anywhere below. `computePuttingScoreV1` and
//     `computePuttingScoreFromAnalysisV1` are neither imported nor called, and
//     the classification and evidence layers are not reachable from here.
//   * not a repair shop. A malformed, unsupported or future envelope resolves
//     to nothing at all. It is never patched, defaulted or partially rendered.
//   * not a backfill. `putting_analysis` is never read here, so a row that was
//     never scored cannot acquire a score at read time. EQ5F-E shipped with no
//     backfill on purpose; computing one during rendering would quietly undo
//     that release decision for every historical row at once.
//
// The imports are the frozen v1 constants rather than transcribed literals, so
// the accepted version, basis and section total cannot drift from the module
// that defines them. `PuttingScoreV1` comes across as a type only. The scorer
// module imports nothing at runtime itself, so this stays free of I/O, network,
// database, clock and randomness.
//
// One consistency rule below deserves naming, because it looks like arithmetic
// and is not: `percent` must equal the rounded share of sections that were
// scorable. That is a statement about the envelope agreeing with itself, over
// numbers the envelope already carries. It never touches `score`, and no input
// to it comes from a stroke.

/** Own-key set every stored v1 envelope must carry — no more, no fewer. */
const SCORE_KEYS = [
  "basis",
  "coverage",
  "score",
  "score_version",
  "source_classification_version",
] as const;

/** Own-key set every stored v1 coverage object must carry. */
const COVERAGE_KEYS = ["percent", "scorable_sections", "total_sections"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the object's own keys are exactly `expected` — no more, no fewer.
 *
 * `Reflect.ownKeys` rather than `Object.keys` so a symbol key or a
 * non-enumerable key cannot ride along unseen, and `hasOwnProperty` so an
 * inherited key cannot satisfy a requirement the object does not actually meet.
 * The same discipline the scorer applies to its input, applied to its output.
 */
function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  if (Reflect.ownKeys(value).length !== expected.length) return false;
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

/** A whole number within an inclusive range. Rejects NaN, Infinity and floats. */
function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Strict read-side check for a stored EQ5F-E v1 score envelope.
 *
 * Everything is required positively and exactly, because the value arrives
 * through jsonb and an untyped row projection: the declared type would be an
 * expectation rather than a guarantee, and this is the boundary where it is
 * checked instead of assumed.
 *
 * A future v2 envelope is refused here rather than rendered on v1 assumptions.
 * That is the intended behaviour: a number whose meaning has changed is worse
 * than no number, and the card simply does not appear until this module learns
 * the new version deliberately.
 */
export function isPersistedPuttingScoreV1(value: unknown): value is PuttingScoreV1 {
  if (!isPlainObject(value)) return false;
  if (!hasExactOwnKeys(value, SCORE_KEYS)) return false;

  if (value.score_version !== PUTTING_SCORE_VERSION) return false;
  if (value.basis !== PUTTING_SCORE_BASIS) return false;
  if (value.source_classification_version !== PUTTING_SCORE_SOURCE_CLASSIFICATION_VERSION) {
    return false;
  }

  const coverage = value.coverage;
  if (!isPlainObject(coverage)) return false;
  if (!hasExactOwnKeys(coverage, COVERAGE_KEYS)) return false;

  if (coverage.total_sections !== PUTTING_SCORE_TOTAL_SECTIONS) return false;
  if (!isIntegerInRange(coverage.scorable_sections, 0, PUTTING_SCORE_TOTAL_SECTIONS)) return false;
  if (!isIntegerInRange(coverage.percent, 0, 100)) return false;

  const scorable = coverage.scorable_sections as number;

  // Envelope self-agreement, not recomputation: both operands are already in
  // the envelope, and `score` takes no part in it.
  if (coverage.percent !== Math.round((100 * scorable) / PUTTING_SCORE_TOTAL_SECTIONS)) {
    return false;
  }

  const score = value.score;

  // Null and zero coverage are the same fact stated twice. An envelope
  // asserting one without the other is internally inconsistent, and a numeric
  // 0 with sections scorable stays valid — that is a real, bad stroke, not a
  // missing one.
  if (score === null) return scorable === 0;
  if (!isIntegerInRange(score, 0, 100)) return false;
  return scorable > 0;
}

/**
 * What the card is allowed to know.
 *
 * Primitives only, copied out of the envelope. The stored jsonb object itself
 * never leaves this module, so nothing downstream can reach a key the card was
 * not given — and a prop crossing into a component carries no more than the
 * three numbers a reader actually sees.
 */
export type PuttingScorePresentationState =
  | {
      readonly status: "ready";
      readonly score: number;
      readonly scorableSections: number;
      readonly totalSections: typeof PUTTING_SCORE_TOTAL_SECTIONS;
    }
  | {
      readonly status: "unavailable";
      readonly scorableSections: 0;
      readonly totalSections: typeof PUTTING_SCORE_TOTAL_SECTIONS;
    };

/**
 * Resolves a stored `swing_analysis.putting_score` into presentation state.
 *
 * `null` means "render no card at all", and it covers three different facts on
 * purpose: the column was never written (every row from before EQ5F-E), the
 * stored value is malformed, or the envelope is a version this module does not
 * support. None of those is something a golfer can act on, and a permanent
 * "unavailable" placeholder on historical rows would be noise on every page
 * they ever recorded.
 *
 * "unavailable" is reserved for the one case that is genuinely about this
 * stroke: a valid envelope saying nothing in the video could be scored.
 */
export function resolvePuttingScorePresentation(
  value: unknown,
): PuttingScorePresentationState | null {
  if (!isPersistedPuttingScoreV1(value)) return null;

  const { score, coverage } = value;

  if (score === null) {
    return Object.freeze({
      status: "unavailable" as const,
      scorableSections: 0 as const,
      totalSections: PUTTING_SCORE_TOTAL_SECTIONS,
    });
  }

  return Object.freeze({
    status: "ready" as const,
    score,
    scorableSections: coverage.scorable_sections,
    totalSections: PUTTING_SCORE_TOTAL_SECTIONS,
  });
}
