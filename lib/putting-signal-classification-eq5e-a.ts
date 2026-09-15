import type { PuttingSection } from "@/lib/putting-analysis-contract";
import type { PuttingDrillEvidenceV1 } from "@/lib/putting-drill-evidence-eq5d-a";

// ============================================================================
// EQ5E-A — the putting signal classification contract
// ============================================================================
//
// This module answers exactly one question, and it answers it about a single
// section at a time: given the enumerated assessment an already-validated
// analysis recorded for that section, is the golfer strong there, acceptable
// there, in need of work there, or was the evidence never good enough to say?
//
// That is the whole job. Nothing here chooses what a golfer should practise.
// Choosing is a later, separately authorized concern, and it needs this answer
// before it can be made honestly — a layer that cannot tell a strength from a
// weakness would eventually hand somebody work they had already mastered,
// purely because the section happened to be observed.
//
// Four things this module must never become:
//
//   1. A recommender. There is no catalog identity here, no mapping from a
//      section to anything a golfer could be asked to do, no ranking, no
//      score, no weight, no cap on how many results exist. The four states
//      below describe a section; they do not select anything.
//
//   2. A reader of prose. The analysis carries an observation beside every
//      assessment, and a summary and closing guidance beside the set of them.
//      None of it is consulted. The enumerated assessment is the sole
//      authority, and the single-assessment entry point below cannot even
//      reach the prose, because the prose is never passed to it.
//
//   3. A second vocabulary. The accepted assessments belong to the EQ5B
//      analysis contract. This module maps them; it does not restate what the
//      legal ones are for any other purpose, and its own test reconciles the
//      mapping against that contract so the two cannot drift apart unnoticed.
//
//   4. Account-aware. Two golfers whose strokes were assessed identically
//      receive identical classifications, whatever either of them pays. Who
//      may see a result is a question for a different layer entirely.
//
// Equipment is absent, and its absence is inherited rather than re-argued: the
// evidence envelope this module consumes already excludes it, on the grounds
// that what a golfer is told should not depend on what they bought.
//
// Both dependencies are type-only, and that is load-bearing rather than
// stylistic. The EQ5B contract imports a value from a model SDK, so a runtime
// import of it — directly, or through the evidence envelope — would pull that
// SDK in behind this module. Types are erased at compile time, so nothing here
// reaches the model layer, the network, or a database.
//
// The module is pure: no runtime import of any kind, no I/O, no clock, no
// randomness. Identical input yields identical output, always.

/**
 * Version of the EQ5E-A classification envelope.
 *
 * Deliberately independent of the analysis schema version and of the evidence
 * envelope version: how a stroke is described and how a description is graded
 * are allowed to change on different schedules, and pinning them together
 * would make each a hostage of the other.
 */
export const PUTTING_SIGNAL_CLASSIFICATION_VERSION = 1;

/**
 * The four coaching states a section assessment can be reduced to.
 *
 * Deliberately not a number, a percentage, a rank or a boolean. A closed set
 * of four named states can be read by a human, compared exactly by a test, and
 * extended only by a decision — none of which survives a numeric scale, which
 * invites arithmetic that the underlying evidence cannot support.
 *
 *   strength               observed and good
 *   acceptable             observed, neither a fault nor a strength
 *   needs_improvement      observed and worth working on
 *   insufficient_evidence  not established, so nothing may be concluded
 */
export type PuttingSignalClassification =
  | "strength"
  | "acceptable"
  | "needs_improvement"
  | "insufficient_evidence";

/**
 * One section's classification, beside the assessment it was derived from.
 *
 * The original assessment is carried verbatim rather than replaced. Two
 * different assessments can share a classification — an analysis that was
 * unclear and one that was unavailable are both insufficient — and a later
 * layer explaining itself to a golfer may need to say which of the two
 * actually happened. Overwriting the assessment would destroy that
 * distinction at the first step, permanently.
 */
export interface PuttingSectionClassificationV1 {
  readonly assessment: string;
  readonly classification: PuttingSignalClassification;
}

/**
 * Every section of one analysis, classified.
 *
 * All six are present whatever they say. A section is reported as
 * insufficient rather than omitted, because an absent key and a section that
 * could not be assessed are different facts, and only one of them is true.
 */
export interface PuttingEvidenceClassificationV1 {
  readonly classification_version: typeof PUTTING_SIGNAL_CLASSIFICATION_VERSION;
  readonly sections: Readonly<Record<PuttingSection, PuttingSectionClassificationV1>>;
}

/**
 * The mapping, keyed by section first.
 *
 * Section-first is not presentation. The same token can be legal in more than
 * one section, and a flat token table would quietly assert that it must always
 * mean the same thing — true today by coincidence, and not a property anyone
 * has guaranteed for the next assessment value added upstream. Requiring the
 * section at lookup keeps that coincidence from hardening into an assumption.
 *
 * `satisfies` rather than a plain annotation: the annotation alone would widen
 * the keys away to `string` and take the literals with them, while `satisfies`
 * checks the shape and leaves them intact. Because the key type is the section
 * union, a seventh section added upstream is a compile error here, and so is a
 * key that is not a section at all.
 *
 * Order is incidental. Nothing reads these entries in sequence, and nothing
 * may: the order sections appear in is not a statement about which matters
 * most.
 */
const CLASSIFICATION = {
  setup_alignment: {
    sound: "strength",
    needs_attention: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stroke_path: {
    straight: "strength",
    arc: "acceptable",
    in_to_out: "needs_improvement",
    out_to_in: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  face_at_impact: {
    appears_square: "strength",
    appears_open: "needs_improvement",
    appears_closed: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  tempo_rhythm: {
    smooth: "strength",
    rushed: "needs_improvement",
    decelerating: "needs_improvement",
    uneven: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stroke_symmetry: {
    balanced: "strength",
    backswing_dominant: "needs_improvement",
    through_stroke_dominant: "needs_improvement",
    uneven: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
  stability: {
    stable: "strength",
    head_motion: "needs_improvement",
    lower_body_motion: "needs_improvement",
    mixed_motion: "needs_improvement",
    unclear: "insufficient_evidence",
    unavailable: "insufficient_evidence",
  },
} as const satisfies Record<
  PuttingSection,
  Readonly<Record<string, PuttingSignalClassification>>
>;

// Frozen at load. `as const` is a compile-time claim and disappears at
// runtime; freezing is what stops anything that gets hold of the table from
// editing what an assessment means for everybody afterwards.
for (const table of Object.values(CLASSIFICATION)) {
  Object.freeze(table);
}
Object.freeze(CLASSIFICATION);

/**
 * True when `section` is a key this table actually owns.
 *
 * The declared parameter type already says it will be, but the value reaches
 * the exported functions through a runtime object, so the declaration is an
 * expectation rather than a guarantee. This is the boundary where it is
 * checked instead of assumed.
 *
 * Own-key only: a value like `constructor` or `toString` is a property of
 * every object through its prototype, and a lookup that did not ask for own
 * keys would find a function there and treat it as a mapping.
 */
function ownsSection(section: unknown): section is PuttingSection {
  return (
    typeof section === "string" &&
    Object.prototype.hasOwnProperty.call(CLASSIFICATION, section)
  );
}

/**
 * Classifies one assessment within one section.
 *
 * Anything this module does not recognise — an unexpected token, a blank, a
 * different capitalisation, a value that is not a string at all, a section
 * that escaped the type system — resolves to insufficient evidence. That is
 * the only safe direction: a wrong guess toward a strength hides real work,
 * and a wrong guess toward a weakness invents it. Neither is recoverable
 * downstream, because by then the reason is gone.
 *
 * Nothing throws. A caller that must decide what to do with six sections
 * should not have to survive an exception to find out that one of them was
 * malformed.
 */
export function classifyPuttingAssessment(
  section: PuttingSection,
  assessment: string,
): PuttingSignalClassification {
  if (!ownsSection(section)) return "insufficient_evidence";
  if (typeof assessment !== "string") return "insufficient_evidence";

  const table: Readonly<Record<string, PuttingSignalClassification>> =
    CLASSIFICATION[section];

  if (!Object.prototype.hasOwnProperty.call(table, assessment)) {
    return "insufficient_evidence";
  }

  return table[assessment];
}

/**
 * Classifies one section and records the assessment it came from.
 *
 * The parameter admits the assessment and nothing else. The evidence a caller
 * holds also carries an observation, and narrowing the parameter here is what
 * makes reading it impossible rather than merely forbidden — a rule can be
 * broken by the next person editing this file; a missing field cannot.
 */
function classifySection(
  section: PuttingSection,
  value: { readonly assessment: string },
): PuttingSectionClassificationV1 {
  return Object.freeze({
    assessment: value.assessment,
    classification: classifyPuttingAssessment(section, value.assessment),
  });
}

/**
 * Classifies every section of one already-validated evidence envelope.
 *
 * The six sections are listed explicitly rather than looped over a runtime
 * list, so the record type makes a future seventh section a compile error here
 * until this function is updated — an omission a loop would have hidden.
 *
 * The result is frozen at every level and shares no mutable structure with the
 * input, and the input is never written to. A classification is a reading of
 * the evidence, and a reading that edits what it read is not one.
 */
export function classifyPuttingEvidence(
  evidence: PuttingDrillEvidenceV1,
): PuttingEvidenceClassificationV1 {
  const sections: Readonly<Record<PuttingSection, PuttingSectionClassificationV1>> =
    Object.freeze({
      setup_alignment: classifySection("setup_alignment", evidence.sections.setup_alignment),
      stroke_path: classifySection("stroke_path", evidence.sections.stroke_path),
      face_at_impact: classifySection("face_at_impact", evidence.sections.face_at_impact),
      tempo_rhythm: classifySection("tempo_rhythm", evidence.sections.tempo_rhythm),
      stroke_symmetry: classifySection("stroke_symmetry", evidence.sections.stroke_symmetry),
      stability: classifySection("stability", evidence.sections.stability),
    });

  return Object.freeze({
    classification_version: PUTTING_SIGNAL_CLASSIFICATION_VERSION,
    sections,
  });
}
