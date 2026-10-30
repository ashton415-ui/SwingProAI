import { describe, expect, it } from "vitest";

// ============================================================================
// ENT-1D S6-R1 — lib/full-swing-analysis-contract.ts
// ============================================================================
//
// Pure unit coverage of the full-swing model-response contract and metric
// evidence. Synthetic objects only.

import {
  MAX_FINDINGS,
  buildMetricEvidence,
  readMetricEvidence,
  validateFullSwingModelResponse,
  type FullSwingReport,
} from "@/lib/full-swing-analysis-contract";

const pillar = (rating = "good") => ({ rating, observation: "Seen at address.", correction: "Stand taller." });

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scoring_breakdown: "75 + 5 (Hip rotation) - 3 (Laid off) = 77",
    score: 77,
    executive_summary: "An approximate summary of what the video shows.",
    evidence_limits: "Face-on view; frame rate too low to time the transition.",
    evidence_coverage: { address: true, top_of_backswing: true, impact: true },
    fault_tags: ["laid_off_top"],
    spine_angle: 35,
    hip_rotation: 45,
    shoulder_rotation: 90,
    tempo_ratio: "3:1",
    highlights: [{ title: "Balanced finish", description: "The finish is held." }],
    deficiencies: [{ title: "Laid off at the top", description: "The club points left at the top; it may lead to compensation." }],
    drills: [{ name: "Split grip", the_why: "Why.", the_how: "How.", the_feel: "Feel." }],
    posture: pillar(),
    swing_plane: pillar("needs_work"),
    impact: pillar(),
    practice_focus: "Top position.",
    pro_cue: "Club over the hands.",
    ...overrides,
  };
}

const accepted = (overrides: Record<string, unknown> = {}): FullSwingReport => {
  const result = validateFullSwingModelResponse(report(overrides));
  if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`);
  return result.report;
};

const rejection = (value: unknown) => {
  const result = validateFullSwingModelResponse(value);
  return result.ok ? "accepted" : result.reason;
};

describe("F1. a well-formed response is accepted as given", () => {
  it("keeps every value", () => {
    const r = accepted();
    expect(r.score).toBe(77);
    expect([r.spine_angle, r.hip_rotation, r.shoulder_rotation, r.tempo_ratio]).toEqual([35, 45, 90, "3:1"]);
    expect(r.evidence_limits).toBe("Face-on view; frame rate too low to time the transition.");
  });

  it("drops keys outside the contract instead of carrying them", () => {
    const r = accepted({ handicap_band: "elite", tour_average: 90 }) as unknown as Record<string, unknown>;
    expect("handicap_band" in r).toBe(false);
    expect("tour_average" in r).toBe(false);
  });
});

describe("F2. unavailable values and insufficient evidence are representable", () => {
  it("score null is an unscored analysis, never 0 or 75", () => {
    const r = accepted({
      score: null,
      scoring_breakdown: "Not scored: impact is out of frame.",
      evidence_coverage: { address: true, top_of_backswing: true, impact: false },
      impact: { rating: "insufficient_evidence", observation: "Impact is out of frame.", correction: "" },
    });
    expect(r.score).toBeNull();
  });

  it("each estimate may be null; zero is kept as a value", () => {
    const r = accepted({ spine_angle: null, hip_rotation: 0, shoulder_rotation: null, tempo_ratio: null });
    expect([r.spine_angle, r.hip_rotation, r.shoulder_rotation, r.tempo_ratio]).toEqual([null, 0, null, null]);
  });

  it("findings may all be empty", () => {
    const r = accepted({ fault_tags: [], highlights: [], deficiencies: [], drills: [], practice_focus: null, pro_cue: null });
    expect([r.fault_tags, r.highlights, r.deficiencies, r.drills]).toEqual([[], [], [], []]);
    expect([r.practice_focus, r.pro_cue]).toEqual([null, null]);
  });

  it("a pillar may be insufficient_evidence with no correction", () => {
    const r = accepted({ impact: { rating: "insufficient_evidence", observation: "Impact is out of frame.", correction: "" } });
    expect(r.impact).toEqual({ rating: "insufficient_evidence", observation: "Impact is out of frame.", correction: "" });
  });
});

describe("F3. anything malformed is refused as a whole", () => {
  it.each([
    ["not an object", "x", "not_object"],
    ["an array", [report()], "not_object"],
    ["null", null, "not_object"],
  ])("%s → %s", (_label, value, reason) => {
    expect(rejection(value)).toBe(reason);
  });

  it.each([
    ["score as a string", { score: "77" }, "bad_score"],
    ["fractional score", { score: 77.5 }, "bad_score"],
    ["score above 100", { score: 101 }, "bad_score"],
    ["negative score", { score: -1 }, "bad_score"],
    ["missing score", { score: undefined }, "bad_score"],
    ["angle as a string", { spine_angle: "35" }, "bad_angle"],
    ["angle out of range", { hip_rotation: 361 }, "bad_angle"],
    ["NaN angle", { shoulder_rotation: Number.NaN }, "bad_angle"],
    ["missing angle", { spine_angle: undefined }, "bad_angle"],
    ["tempo without :1", { tempo_ratio: "3" }, "bad_tempo"],
    ["tempo as a number", { tempo_ratio: 3 }, "bad_tempo"],
    ["empty summary", { executive_summary: " " }, "bad_text"],
    ["missing evidence limits", { evidence_limits: undefined }, "bad_text"],
    ["empty breakdown", { scoring_breakdown: "" }, "bad_text"],
    ["empty practice focus string", { practice_focus: "" }, "bad_text"],
    ["too many highlights", { highlights: Array.from({ length: MAX_FINDINGS + 1 }, () => ({ title: "t", description: "d" })) }, "bad_list"],
    ["a highlight without text", { highlights: [{ title: "t", description: "" }] }, "bad_text"],
    ["a non-object deficiency", { deficiencies: ["fault"] }, "bad_list"],
    ["a fault tag that is not text", { fault_tags: [7] }, "bad_list"],
    ["fault tags not a list", { fault_tags: "early_extension" }, "bad_list"],
    ["unknown pillar rating", { posture: pillar("elite") }, "bad_pillar"],
    ["rated pillar without a correction", { posture: { rating: "good", observation: "o", correction: "" } }, "bad_pillar"],
    ["missing pillar", { swing_plane: undefined }, "bad_pillar"],
    ["a drill without a deficiency", { deficiencies: [], drills: [{ name: "n", the_why: "w", the_how: "h", the_feel: "f" }] }, "drill_without_deficiency"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(report(patch))).toBe(reason);
  });
});

describe("F4. metric evidence records value and source together", () => {
  const client = { spineAngle: 60, hipRotation: 170, shoulderRotation: null, tempoRatio: "9.9:1" };

  it("AI values are the analysis values; client values sit beside them, unverified", () => {
    const evidence = buildMetricEvidence(accepted({ shoulder_rotation: null }), client);
    expect(evidence).toEqual({
      schema_version: 1,
      spine_angle: { ai_video_estimate: 35, client_unverified_estimate: 60 },
      hip_rotation: { ai_video_estimate: 45, client_unverified_estimate: 170 },
      shoulder_rotation: { ai_video_estimate: null, client_unverified_estimate: null },
      tempo_ratio: { ai_video_estimate: "3:1", client_unverified_estimate: "9.9:1" },
    });
  });

  it("an unavailable AI value is never replaced by a client value", () => {
    const evidence = buildMetricEvidence(accepted({ hip_rotation: null }), client);
    expect(evidence.hip_rotation.ai_video_estimate).toBeNull();
    expect(evidence.hip_rotation.client_unverified_estimate).toBe(170);
  });

  it("stored evidence round-trips; zero survives", () => {
    const evidence = buildMetricEvidence(accepted({ hip_rotation: 0 }), client);
    expect(readMetricEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it.each([
    ["absent", undefined],
    ["another version", { schema_version: 2 }],
    ["a missing metric", { schema_version: 1, spine_angle: { ai_video_estimate: 1, client_unverified_estimate: null } }],
    ["text in place of an angle", {
      schema_version: 1,
      spine_angle: { ai_video_estimate: "35°", client_unverified_estimate: null },
      hip_rotation: { ai_video_estimate: null, client_unverified_estimate: null },
      shoulder_rotation: { ai_video_estimate: null, client_unverified_estimate: null },
      tempo_ratio: { ai_video_estimate: null, client_unverified_estimate: null },
    }],
  ])("malformed stored evidence (%s) is not read", (_label, value) => {
    expect(readMetricEvidence(value)).toBeNull();
  });
});

// ─── S6-R1A: scored / unscored consistency from explicit coverage ─────────────

const NOTHING_ASSESSABLE = {
  scoring_breakdown: "Not scored: the swing is out of frame from address to impact.",
  spine_angle: null,
  hip_rotation: null,
  shoulder_rotation: null,
  tempo_ratio: null,
  fault_tags: [],
  highlights: [],
  deficiencies: [],
  drills: [],
  posture: { rating: "insufficient_evidence", observation: "Address is out of frame.", correction: "" },
  swing_plane: { rating: "insufficient_evidence", observation: "The top is out of frame.", correction: "" },
  impact: { rating: "insufficient_evidence", observation: "Impact is out of frame.", correction: "" },
  practice_focus: null,
  pro_cue: null,
};
const NONE = { address: false, top_of_backswing: false, impact: false };
const ALL = { address: true, top_of_backswing: true, impact: true };

/** S6-R1B: every position covered, pillars assessed, timing unavailable, honestly unscored. */
const HONEST_UNSCORED_FULL_COVERAGE = {
  score: null,
  scoring_breakdown: "Not scored: the frame rate is too low to judge the transition or tempo, so the rubric cannot be applied.",
  evidence_coverage: ALL,
  tempo_ratio: null,
};

describe("F5. a response declaring insufficient evidence cannot carry a score", () => {
  it.each([0, 75, 99, 100])("the counterexample (nothing covered, all pillars insufficient) with score %i is refused", (score) => {
    const reason = rejection(report({ ...NOTHING_ASSESSABLE, evidence_coverage: NONE, score }));
    expect(reason).toBe(score === 0 || score === 100 ? "bad_score" : "score_without_coverage");
  });

  it.each([0, 75, 99, 100])("the counterexample claiming full coverage with score %i is refused", (score) => {
    const reason = rejection(report({ ...NOTHING_ASSESSABLE, evidence_coverage: ALL, score }));
    expect(reason).toBe(score === 0 || score === 100 ? "bad_score" : "score_without_assessed_pillar");
  });

  it("the counterexample with score null is a valid unscored analysis", () => {
    const r = accepted({ ...NOTHING_ASSESSABLE, evidence_coverage: NONE, score: null });
    expect(r.score).toBeNull();
    expect(r.evidence_coverage).toEqual(NONE);
  });

  it("free text never decides: a 'not scored' breakdown with full coverage and a score is a scored analysis", () => {
    expect(accepted({ scoring_breakdown: "Not scored", score: 70 }).score).toBe(70);
  });

  it("an honest unscored result with full coverage is accepted (S6-R1B)", () => {
    // All positions covered and pillars assessed, but the video's timing cannot
    // be judged, so the rubric cannot be applied: score null with the reason.
    const r = accepted(HONEST_UNSCORED_FULL_COVERAGE);
    expect(r.score).toBeNull();
    expect(r.evidence_coverage).toEqual(ALL);
    expect(r.tempo_ratio).toBeNull();
    expect([r.posture.rating, r.swing_plane.rating, r.impact.rating]).toEqual(["good", "needs_work", "good"]);
    expect(r.scoring_breakdown).toBe(HONEST_UNSCORED_FULL_COVERAGE.scoring_breakdown);
  });

  it.each([
    ["partial coverage with a score", { evidence_coverage: { ...ALL, impact: false }, impact: { rating: "insufficient_evidence", observation: "o", correction: "" } }, "score_without_coverage"],
    ["a rated pillar whose position is not covered", { score: null, evidence_coverage: { ...ALL, address: false } }, "pillar_without_coverage"],
    ["coverage missing", { evidence_coverage: undefined }, "bad_coverage"],
    ["coverage as text", { evidence_coverage: { address: "yes", top_of_backswing: true, impact: true } }, "bad_coverage"],
    ["a score below the rubric clamp", { score: 54 }, "bad_score"],
    ["a score above the rubric clamp", { score: 100 }, "bad_score"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(report(patch))).toBe(reason);
  });

  it("the clamp bounds themselves are scores; a zero-valued estimate is kept", () => {
    expect(accepted({ score: 55 }).score).toBe(55);
    expect(accepted({ score: 99, hip_rotation: 0 }).hip_rotation).toBe(0);
  });
});
