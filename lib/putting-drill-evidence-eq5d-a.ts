import type {
  PersistedPuttingAnalysisV1,
  PuttingSection,
} from "@/lib/putting-analysis-contract";

// ============================================================================
// EQ5D-A — the putting drill evidence boundary
// ============================================================================
//
// This module is a boundary, not an engine. It answers exactly one question:
// what may a future putting drill recommendation layer look at?
//
// The answer is deliberately narrow, because the analysis it draws from is
// qualitative. A putt is assessed from an uncalibrated phone video, so the
// persisted envelope records observations and enumerated assessments — never
// measurements. Those three numeric fields exist there only as fixed
// "unavailable" sentinels, and they are excluded here so no later layer can
// quietly promote a sentinel into a number it then reasons about.
//
// The dependency on the EQ5B contract is type-only, and that is load-bearing
// rather than stylistic: that module imports a value from the Gemini SDK, so a
// runtime import of it would pull the SDK in behind this one. Types are erased
// at compile time, so nothing here reaches the model layer. The field types are
// derived from the persisted envelope rather than restated as fresh literals,
// which keeps the two in step without linking them at runtime.
//
// Three things this module must never become:
//
//   1. A recommender. There is no mapping, ranking, scoring or selection here,
//      and no function that returns a drill. Choosing one is a separate,
//      separately authorized concern.
//
//   2. A second drill vocabulary. Canonical identity lives in public.drills.
//      This module can carry an opaque reference to one; it cannot carry,
//      generate or infer drill content. A drill named by prose is a drill
//      nobody can verify.
//
//   3. A way back into the analysis. The practice focus says WHAT to work on
//      and is historical evidence. It is copied verbatim and never rewritten,
//      appended to, parsed for an identity, or written back.
//
// Equipment is absent on purpose. The analysis row carries an equipment
// snapshot elsewhere; letting it reach a recommendation would make what a
// golfer is told depend on what they bought.
//
// The module is pure: no runtime import of any kind, no network, no database,
// no framework, no clock, no randomness, no I/O. Identical input yields
// identical output.
//
// Validation is not repeated here. The caller must supply an analysis that has
// already passed the EQ5B validator; a second copy of those rules would be a
// second thing to keep in step.

/**
 * Version of the EQ5D evidence envelope.
 *
 * Deliberately independent of the EQ5B schema version: the analysis envelope
 * and the evidence a recommendation layer consumes are allowed to evolve on
 * different schedules, and conflating them would make one a hostage of the
 * other.
 */
export const PUTTING_DRILL_EVIDENCE_VERSION = 1;

/**
 * One section's evidence: its enumerated assessment and the observation that
 * supports it.
 *
 * Derived structurally from the persisted analysis rather than redeclared, so
 * this file cannot drift from EQ5B and EQ5B needs no change to serve it.
 */
export type PuttingSectionEvidence = PersistedPuttingAnalysisV1[PuttingSection];

/**
 * Everything a future putting drill recommendation layer is permitted to see.
 *
 * What is absent matters as much as what is present. There is no measurement,
 * no equipment, no tier, no drill, no repetition count, and no container that
 * would decide whether one drill or several are eventually recommended.
 *
 * Every field is readonly because the projection freezes what it returns; the
 * type now says what the runtime already enforced.
 */
export interface PuttingDrillEvidenceV1 {
  /** Envelope version for this evidence shape. */
  readonly evidence_version: typeof PUTTING_DRILL_EVIDENCE_VERSION;
  /**
   * Opaque identifier of the analysis this evidence was projected from.
   *
   * Provenance, not evidence. It exists so a later decision can be traced back
   * to what it was based on. This module attaches no meaning to its format,
   * never parses it, and performs no lookup: carrying an id is not a claim
   * that a matching row exists.
   */
  readonly source_analysis_id: string;
  /** Schema version of the analysis this evidence came from, copied verbatim. */
  readonly schema_version: PersistedPuttingAnalysisV1["schema_version"];
  /**
   * How the underlying evidence was obtained, copied verbatim. Carried forward
   * so no downstream layer can treat uncalibrated video observation as
   * instrument measurement.
   */
  readonly evidence_basis: PersistedPuttingAnalysisV1["evidence_basis"];
  /** The analysis summary, copied verbatim. */
  readonly summary: string;
  /**
   * Per-section assessments and observations, copied verbatim.
   *
   * An unclear assessment survives as unclear, and an unavailable one as
   * unavailable. A section the video could not support is not evidence of
   * anything, and must never be resolved into a firmer conclusion on the way
   * through.
   */
  readonly sections: Readonly<Record<PuttingSection, Readonly<PuttingSectionEvidence>>>;
  /** The single highest-signal conclusion, copied verbatim. */
  readonly primary_finding: string;
  /**
   * What to work on, copied verbatim.
   *
   * Not a drill, not a programme, and not an input to be rewritten. The EQ5B
   * contract already refuses to let a drill name, repetition count, set count
   * or timed routine exist in this field; nothing here relaxes that, and
   * nothing here re-implements it.
   */
  readonly practice_focus: string;
}

/**
 * A reference to a drill in the canonical catalog.
 *
 * Identity only. Not the drill's title, its coaching content, or its
 * verification prompt — those live in public.drills and can be read by id when
 * something actually needs them. Keeping the reference opaque is what stops a
 * generated string from ever passing as a drill.
 */
export interface CanonicalDrillReference {
  readonly drill_id: string;
}

/**
 * Runtime guard for a canonical drill reference.
 *
 * Strict by design: the object must carry exactly one own key, that key must
 * be drill_id, and its value must be a non-blank string. Anything richer is
 * rejected — an object that also carries a title is how invented content would
 * arrive wearing an identity's clothes, so a reference with a name must fail
 * just as loudly as a bare string does.
 *
 * Reflect.ownKeys is used rather than Object.keys so that a symbol key or a
 * non-enumerable key cannot ride along unseen, and so that an inherited-only
 * drill_id yields no own keys and fails.
 *
 * This checks shape, not existence. Whether the id names a real catalog row is
 * a server concern, and no lookup happens here.
 */
export function isCanonicalDrillReference(
  value: unknown,
): value is CanonicalDrillReference {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== 1) return false;
  if (ownKeys[0] !== "drill_id") return false;

  const drillId = (value as { drill_id: unknown }).drill_id;
  return typeof drillId === "string" && drillId.trim().length > 0;
}

/**
 * Copies one section's evidence into a fresh frozen object.
 *
 * A copy and nothing else: no trimming, no normalising, no translating, no
 * resolving of unclear or unavailable into something firmer, and no reading of
 * the prose. Unexported, because it is an implementation detail of the
 * projection rather than part of the boundary.
 */
function copySection(value: PuttingSectionEvidence): Readonly<PuttingSectionEvidence> {
  return Object.freeze({
    assessment: value.assessment,
    observation: value.observation,
  });
}

/**
 * Projects an already-validated persisted putting analysis into the EQ5D
 * evidence envelope.
 *
 * A copy, not an interpretation. Every narrative field is carried across
 * unchanged, every assessment keeps its exact value, and nothing is
 * summarised, scored, ranked, inferred or improved.
 *
 * The six sections are listed explicitly rather than looped over a runtime
 * list, so the Record type makes a future seventh section a compile error here
 * until this projection is updated — an omission that a loop would have hidden.
 *
 * The returned object shares no mutable structure with the input and is
 * frozen, so a later layer cannot edit evidence it was handed.
 */
export function projectPuttingDrillEvidence(
  analysis: PersistedPuttingAnalysisV1,
  sourceAnalysisId: string,
): PuttingDrillEvidenceV1 {
  const sections: Readonly<Record<PuttingSection, Readonly<PuttingSectionEvidence>>> =
    Object.freeze({
      setup_alignment: copySection(analysis.setup_alignment),
      stroke_path: copySection(analysis.stroke_path),
      face_at_impact: copySection(analysis.face_at_impact),
      tempo_rhythm: copySection(analysis.tempo_rhythm),
      stroke_symmetry: copySection(analysis.stroke_symmetry),
      stability: copySection(analysis.stability),
    });

  return Object.freeze({
    evidence_version: PUTTING_DRILL_EVIDENCE_VERSION,
    source_analysis_id: sourceAnalysisId,
    schema_version: analysis.schema_version,
    evidence_basis: analysis.evidence_basis,
    summary: analysis.summary,
    sections,
    primary_finding: analysis.primary_finding,
    practice_focus: analysis.practice_focus,
  });
}
