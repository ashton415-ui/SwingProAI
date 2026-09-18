import type { PersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";
import { projectPuttingDrillEvidence } from "@/lib/putting-drill-evidence-eq5d-a";
import { classifyPuttingEvidence } from "@/lib/putting-signal-classification-eq5e-a";
import { computePuttingScoreV1, type PuttingScoreV1 } from "@/lib/putting-score-eq5f-d";

// ============================================================================
// EQ5F-E — from a persisted putting analysis to its versioned score
// ============================================================================
//
// One composition, and deliberately nothing else. Three deterministic
// authorities already exist between a persisted analysis and a score:
//
//   projectPuttingDrillEvidence   copies the validated envelope into the
//                                 narrow evidence shape a later layer may see
//   classifyPuttingEvidence       reduces each section's enumerated assessment
//                                 to one of four coaching states
//   computePuttingScoreV1         turns those states into a versioned index
//
// This module wires them together so the server route has a single call to
// make, and so the wiring itself is testable without a database. It adds no
// arithmetic, no point table, no threshold and no vocabulary: every number in
// the result comes from EQ5F-D, which remains the sole scoring authority. If
// the score ever changes meaning, it changes there, under a new version.
//
// The contract import is type-only and that is load-bearing rather than
// stylistic: `@/lib/putting-analysis-contract` imports a value from the model
// SDK, so a runtime import of it would pull that SDK in behind this module and
// therefore behind the route. The three modules imported for their values are
// each pure and free of runtime imports of their own.
//
// Pure throughout: no database, no network, no environment, no clock, no
// randomness, no logging. Identical input yields identical output.

/**
 * Scores one already-validated persisted putting analysis.
 *
 * `sourceAnalysisId` is provenance and nothing more. The evidence projection
 * carries it so a later reader can trace a decision back to what it was based
 * on; it is never parsed, never looked up, and cannot influence the number.
 *
 * Returns null when the deterministic pipeline refuses its own input — a
 * scorer failure, and a different fact from a valid result whose `score` is
 * null because no section was scorable. A caller must not collapse the two: the
 * first means nothing trustworthy was produced, the second means the stroke was
 * genuinely unreadable and that is the honest answer.
 */
export function computePuttingScoreFromAnalysisV1(
  persisted: PersistedPuttingAnalysisV1,
  sourceAnalysisId: string,
): PuttingScoreV1 | null {
  // The declared parameter type is an expectation, not a guarantee: the value
  // reaches a caller through untyped jsonb, so a payload missing a section
  // would make the projection dereference something that is not there. That is
  // a refusal, not an exception — a server route deciding whether an analysis
  // completed should not have to survive a throw to discover its input was
  // malformed, and an escaping error would surface as a crash rather than as
  // the fail-closed failure this pipeline is built to produce.
  try {
    const evidence = projectPuttingDrillEvidence(persisted, sourceAnalysisId);
    const classification = classifyPuttingEvidence(evidence);
    return computePuttingScoreV1(classification);
  } catch {
    return null;
  }
}
