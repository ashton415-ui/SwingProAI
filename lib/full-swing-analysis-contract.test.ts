import { describe, expect, it } from "vitest";

// ============================================================================
// ENT-1D S6-R1 — lib/full-swing-analysis-contract.ts (provider contract fs-provider-v2)
// ============================================================================
//
// Pure unit coverage of provider-response validation, server scoring and the
// canonical stored report, plus metric evidence. Synthetic objects only. The
// tests show structural and declared-consistency rules; they do not show that
// any declaration or finding is true.

import {
  MAX_FINDINGS,
  PROVIDER_FORBIDDEN_KEYS,
  buildMetricEvidence,
  readMetricEvidence,
  scoreFullSwing,
  toCanonicalFullSwingReport,
  validateFullSwingModelResponse,
  validateFullSwingProviderResponse,
  type FullSwingReport,
  type RubricAssessment,
} from "@/lib/full-swing-analysis-contract";
import { RUBRIC_VERSION, SWING_DETAILS } from "@/lib/full-swing-scoring-rubric";

const pillar = (rating = "good") => ({ rating, observation: "Seen at address.", correction: "Stand taller." });
const INSUFFICIENT = (what: string) => ({ rating: "insufficient_evidence", observation: `${what} is not visible.`, correction: "" });
const seen = (at: string) => ({ visible: "yes", at });
const unseen = (visible: "no" | "unclear" = "unclear") => ({ visible, at: null });
const ALL_DETAILS_VISIBLE = Object.fromEntries(SWING_DETAILS.map((d) => [d, "visible"]));
const FINDINGS = (overrides: Record<string, string> = {}) =>
  Object.entries({ laid_off_p4: "not_assessable", over_the_top: "not_assessable", cupped_lead_wrist_top: "not_observed", reverse_pivot: "observed", ...overrides })
    .map(([id, status]) => ({ id, status }));

/** A scored face-on provider response: shoulder turn assessable (95), hips assessable (42), reverse pivot observed. */
function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence_limits: "Face-on view; club path relative to the target line cannot be judged.",
    camera_view: "face_on",
    positions: {
      address: seen("0:00.5"),
      takeaway_start: seen("0:01.0"),
      top_of_backswing: seen("0:02.0"),
      early_downswing: seen("0:02.3"),
      impact: seen("0:02.6"),
    },
    detail_visibility: { ...ALL_DETAILS_VISIBLE, target_reference: "not_visible", clubface: "unclear" },
    spine_angle: 35,
    hip_rotation: 42,
    shoulder_rotation: 95,
    tempo_ratio: "3:1",
    threshold_assessments: {
      shoulder_turn_at_top: { assessable: true, basis: "Shoulder line clearly turned at the top." },
      hip_turn_at_impact: { assessable: true, basis: "Belt line visible at impact." },
    },
    posture: pillar(),
    swing_plane: INSUFFICIENT("The plane relative to the target line"),
    impact: pillar(),
    rubric_findings: FINDINGS(),
    highlights: [{ title: "Full shoulder turn", description: "The shoulders turn well at the top." }],
    deficiencies: [{ title: "Reverse pivot", description: "The upper body moves toward the target at the top; it may affect contact.", rubric_id: "reverse_pivot" }],
    drills: [{ name: "Pump drill", the_why: "Why.", the_how: "How.", the_feel: "Feel." }],
    executive_summary: "An approximate summary of what the video shows.",
    practice_focus: "Backswing pivot.",
    pro_cue: "Turn over the trail leg.",
    scorable: true,
    unscored_reason: null,
    ...overrides,
  };
}

const accepted = (overrides: Record<string, unknown> = {}): { report: FullSwingReport; assessment: RubricAssessment } => {
  const result = validateFullSwingModelResponse(provider(overrides));
  if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`);
  return result;
};
const rejection = (value: unknown) => {
  const result = validateFullSwingModelResponse(value);
  return result.ok ? "accepted" : result.reason;
};

describe("F1. a well-formed provider response maps to the canonical report; the server scores it", () => {
  it("score and breakdown are the server's; coverage is the existing boolean map; fault tags are derived", () => {
    const { report } = accepted();
    expect(report.score).toBe(72);
    expect(report.scoring_breakdown).toBe("75 + 5 (Shoulder rotation) - 8 (Reverse pivot) = 72");
    expect(report.evidence_coverage).toEqual({ address: true, top_of_backswing: true, impact: true });
    expect(report.fault_tags).toEqual(["reverse_pivot"]);
    expect([report.spine_angle, report.hip_rotation, report.shoulder_rotation, report.tempo_ratio]).toEqual([35, 42, 95, "3:1"]);
    expect(report.deficiencies).toEqual([{ title: "Reverse pivot", description: "The upper body moves toward the target at the top; it may affect contact." }]);
    expect(report.highlights).toEqual([{ title: "Full shoulder turn", description: "The shoulders turn well at the top." }]);
  });

  it("the canonical report keeps exactly the previously stored keys", () => {
    expect(Object.keys(accepted().report).sort()).toEqual([
      "deficiencies", "drills", "evidence_coverage", "evidence_limits", "executive_summary", "fault_tags", "highlights",
      "hip_rotation", "impact", "posture", "practice_focus", "pro_cue", "score", "scoring_breakdown", "shoulder_rotation",
      "spine_angle", "swing_plane", "tempo_ratio",
    ]);
  });

  it("the internal assessment is versioned and records declarations, outcomes and applied adjustments", () => {
    const { assessment } = accepted();
    expect(assessment).toMatchObject({
      version: 1, provider_contract: "fs-provider-v2", rubric_version: RUBRIC_VERSION, policy: "P1-provisional",
      scorable_declared: true, outcome: "scored", raw_total: 72,
      applied: [{ id: "shoulder_turn_full", points: 5 }, { id: "reverse_pivot", points: -8 }],
    });
    expect(assessment.declarations.camera_view).toBe("face_on");
    expect(assessment.findings).toHaveLength(17);
    expect(assessment.findings.find((f) => f.id === "x_factor")).toEqual({ id: "x_factor", status: "not_assessable", source: "quarantined" });
  });

  it("drops keys outside the contract instead of carrying them", () => {
    const { report } = accepted({ handicap_band: "elite", tour_average: 90 });
    expect("handicap_band" in report).toBe(false);
  });

  it("the three steps are separate functions with the same result", () => {
    const v = validateFullSwingProviderResponse(provider());
    if (!v.ok) throw new Error(v.reason);
    expect(toCanonicalFullSwingReport(v.provider, scoreFullSwing(v.provider)).report).toEqual(accepted().report);
  });
});

describe("F2. the provider never authors the score, breakdown, fault tags or coverage", () => {
  it.each(PROVIDER_FORBIDDEN_KEYS.map((k) => [k]))("%s present → refused", (key) => {
    expect(rejection(provider({ [key]: key === "score" ? 72 : key === "fault_tags" ? [] : key === "evidence_coverage" ? {} : "75 = 75" }))).toBe("provider_authored_scoring");
  });
  it("even a null score is refused: the key itself is the server's", () => {
    expect(rejection(provider({ score: null }))).toBe("provider_authored_scoring");
  });
});

describe("F3. honest uncertainty is a valid unscored result; full coverage never forces a score", () => {
  it("full coverage, scorable false with a reason → score null, reason as breakdown, coverage true", () => {
    const { report, assessment } = accepted({ scorable: false, unscored_reason: "The transition cannot be timed from this clip." });
    expect(report.score).toBeNull();
    expect(report.scoring_breakdown).toBe("The transition cannot be timed from this clip.");
    expect(report.evidence_coverage).toEqual({ address: true, top_of_backswing: true, impact: true });
    expect(assessment.outcome).toBe("unscored");
    expect(assessment.raw_total).toBeNull();
  });

  it("partial coverage: impact unclear, impact pillar insufficient, hip turn not assessable, no hip estimate → unscored", () => {
    const { report } = accepted({
      positions: { ...(provider().positions as object), impact: unseen() },
      hip_rotation: null,
      tempo_ratio: null,
      threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: "b" }, hip_turn_at_impact: { assessable: false, basis: null } },
      impact: INSUFFICIENT("Impact"),
      scorable: false,
      unscored_reason: "Impact is not clearly visible.",
    });
    expect(report.score).toBeNull();
    expect(report.evidence_coverage).toEqual({ address: true, top_of_backswing: true, impact: false });
  });

  it("nothing visible: everything unclear, no estimates, empty lists, unscored", () => {
    const none = Object.fromEntries(["address", "takeaway_start", "top_of_backswing", "early_downswing", "impact"].map((p) => [p, unseen()]));
    const { report } = accepted({
      camera_view: "unclear", positions: none, detail_visibility: Object.fromEntries(SWING_DETAILS.map((d) => [d, "unclear"])),
      spine_angle: null, hip_rotation: null, shoulder_rotation: null, tempo_ratio: null,
      threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: false, basis: null } },
      posture: INSUFFICIENT("Address"), swing_plane: INSUFFICIENT("The top"), impact: INSUFFICIENT("Impact"),
      rubric_findings: FINDINGS({ cupped_lead_wrist_top: "not_assessable", reverse_pivot: "not_assessable" }),
      highlights: [], deficiencies: [], drills: [], practice_focus: null, pro_cue: null,
      scorable: false, unscored_reason: "The swing is not visible.",
    });
    expect(report.score).toBeNull();
    expect(report.evidence_coverage).toEqual({ address: false, top_of_backswing: false, impact: false });
    expect([report.fault_tags, report.highlights, report.deficiencies, report.drills]).toEqual([[], [], [], []]);
  });

  it("earned baseline: everything assessed, nothing applies → 75 from server arithmetic, not a default", () => {
    const { report, assessment } = accepted({
      shoulder_rotation: 85, hip_rotation: 42,
      rubric_findings: FINDINGS({ reverse_pivot: "not_observed" }),
      deficiencies: [], drills: [],
    });
    expect(report.score).toBe(75);
    expect(report.scoring_breakdown).toBe("75 (no rubric adjustments applied) = 75");
    expect(assessment.applied).toEqual([]);
  });

  it("missing evidence never becomes 75: scorable with nothing assessable is refused, not defaulted", () => {
    expect(rejection(provider({
      threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: false, basis: null } },
      rubric_findings: FINDINGS({ cupped_lead_wrist_top: "not_assessable", reverse_pivot: "not_assessable" }),
      deficiencies: [], drills: [],
    }))).toBe("scorable_without_assessable_item");
  });
});

describe("F4. structural refusals", () => {
  it.each([
    ["not an object", "x", "not_object"],
    ["an array", [provider()], "not_object"],
    ["null", null, "not_object"],
  ])("%s → %s", (_label, value, reason) => {
    expect(rejection(value)).toBe(reason);
  });

  it.each([
    ["angle as a string", { spine_angle: "35" }, "bad_angle"],
    ["angle out of range", { hip_rotation: 361 }, "bad_angle"],
    ["missing angle", { spine_angle: undefined }, "bad_angle"],
    ["tempo without :1", { tempo_ratio: "3" }, "bad_tempo"],
    ["empty summary", { executive_summary: " " }, "bad_text"],
    ["missing evidence limits", { evidence_limits: undefined }, "bad_text"],
    ["empty practice focus string", { practice_focus: "" }, "bad_text"],
    ["too many highlights", { highlights: Array.from({ length: MAX_FINDINGS + 1 }, () => ({ title: "t", description: "d" })) }, "bad_list"],
    ["a non-object deficiency", { deficiencies: ["fault"] }, "bad_list"],
    ["unknown pillar rating", { posture: pillar("elite") }, "bad_pillar"],
    ["rated pillar without a correction", { posture: { rating: "good", observation: "o", correction: "" } }, "bad_pillar"],
    ["a drill without a deficiency", { deficiencies: [], drills: [{ name: "n", the_why: "w", the_how: "h", the_feel: "f" }] }, "drill_without_deficiency"],
    ["unknown camera view", { camera_view: "overhead" }, "bad_declaration"],
    ["missing a position", { positions: { address: seen("0:00") } }, "bad_declaration"],
    ["a detail outside the vocabulary", { detail_visibility: { ...ALL_DETAILS_VISIBLE, shoulders: "partly" } }, "bad_declaration"],
    ["missing scorable", { scorable: undefined }, "bad_scorable"],
    ["scorable false without a reason", { scorable: false, unscored_reason: null }, "bad_scorable"],
    ["scorable true with a reason", { unscored_reason: "x" }, "bad_scorable"],
    ["a malformed threshold assessment", { threshold_assessments: { shoulder_turn_at_top: { assessable: "yes", basis: "b" }, hip_turn_at_impact: { assessable: false, basis: null } } }, "bad_threshold_assessment"],
    ["assessable without a basis", { threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: null }, hip_turn_at_impact: { assessable: false, basis: null } } }, "bad_threshold_assessment"],
    ["not assessable with a basis", { threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: "b" }, hip_turn_at_impact: { assessable: false, basis: "b" } } }, "bad_threshold_assessment"],
    ["a qualitative item missing", { rubric_findings: FINDINGS().slice(1) }, "bad_rubric_finding"],
    ["a qualitative item twice", { rubric_findings: [...FINDINGS(), { id: "reverse_pivot", status: "observed" }] }, "bad_rubric_finding"],
    ["an unknown item", { rubric_findings: [...FINDINGS(), { id: "chicken_wing", status: "observed" }] }, "bad_rubric_finding"],
    ["an unknown status", { rubric_findings: FINDINGS({ reverse_pivot: "maybe" }) }, "bad_rubric_finding"],
    ["a deficiency linked to an unknown item", { deficiencies: [{ title: "t", description: "d", rubric_id: "chicken_wing" }] }, "bad_rubric_link"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(provider(patch))).toBe(reason);
  });
});

describe("F5. timestamps: format, non-negative, applicable order; no duration bound without a known duration", () => {
  const at = (patch: Record<string, unknown>) => ({ positions: { ...(provider().positions as object), ...patch } });
  it.each([
    ["a malformed time", at({ impact: seen("2.6s") }), "bad_position_time"],
    ["a negative time", at({ address: seen("-0:01") }), "bad_position_time"],
    ["seconds above 59", at({ impact: seen("0:61") }), "bad_position_time"],
    ["yes without a time", at({ impact: { visible: "yes", at: null } }), "bad_position_time"],
    ["a time without yes", at({ impact: { visible: "unclear", at: "0:02.6" } }), "bad_position_time"],
    ["impact before the top", at({ impact: seen("0:01.9") }), "position_order"],
    ["the early downswing after impact", at({ early_downswing: seen("0:03.0") }), "position_order"],
    ["the top at the same time as impact", at({ top_of_backswing: seen("0:02.6"), early_downswing: unseen("no") }), "position_order"],
    ["takeaway after the top", at({ takeaway_start: seen("0:02.5") }), "position_order"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(provider(patch))).toBe(reason);
  });

  it("address and takeaway start may coincide; a long clip is not bounded by an assumed duration", () => {
    expect(accepted(at({ address: seen("0:01.0") })).report.score).toBe(72);
    expect(accepted({ positions: { address: seen("1:00"), takeaway_start: seen("1:01"), top_of_backswing: seen("1:02"), early_downswing: seen("1:02.5"), impact: seen("1:03") } }).report.score).toBe(72);
  });
});

describe("F6. estimates need the evidence they depend on (E5a corrected: refused, never nulled or kept as supported)", () => {
  it.each([
    ["spine angle with the spine line unclear", { detail_visibility: { ...ALL_DETAILS_VISIBLE, spine_line: "unclear", target_reference: "not_visible" } }],
    ["shoulder turn with the shoulders not visible", { detail_visibility: { ...ALL_DETAILS_VISIBLE, shoulders: "not_visible" }, threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: true, basis: "b" } }, rubric_findings: FINDINGS({ reverse_pivot: "not_assessable" }), deficiencies: [], drills: [] }],
    ["hip turn with impact unclear", { positions: { ...(provider().positions as object), impact: unseen() }, impact: INSUFFICIENT("Impact"), tempo_ratio: null, scorable: false, unscored_reason: "r" }],
    ["tempo with the takeaway start unclear", { positions: { ...(provider().positions as object), takeaway_start: unseen() } }],
    ["an estimate at a cutoff (90) with the shoulders unclear", { shoulder_rotation: 90, detail_visibility: { ...ALL_DETAILS_VISIBLE, shoulders: "unclear" } }],
  ])("%s → refused", (_label, patch) => {
    expect(rejection(provider(patch))).toBe("estimate_without_declared_evidence");
  });

  it("an estimate with its evidence visible but the turn not assessable is kept as an AI estimate and earns nothing", () => {
    const { report, assessment } = accepted({ threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: true, basis: "b" } } });
    expect(report.shoulder_rotation).toBe(95);
    expect(assessment.findings.find((f) => f.id === "shoulder_turn_full")?.status).toBe("not_assessable");
    expect(report.score).toBe(67);
  });
});

describe("F7. threshold items: the server derives the outcome; the model never classifies against a cutoff", () => {
  it.each([
    ["view other", { camera_view: "other" }, "threshold_assessable_without_evidence"],
    ["hip turn assessable from down the line (draft requirement: face-on)", { camera_view: "down_the_line", rubric_findings: FINDINGS({ reverse_pivot: "not_assessable", cupped_lead_wrist_top: "not_assessable" }), deficiencies: [], drills: [] }, "threshold_assessable_without_evidence"],
    ["assessable without an estimate", { hip_rotation: null }, "threshold_assessable_without_estimate"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(provider(patch))).toBe(reason);
  });

  it.each(["shoulder_turn_full", "restricted_backswing_severe", "body_block_moderate", "hip_turn_impact"])(
    "a rubric finding for threshold item %s → refused", (id) => {
      expect(rejection(provider({ rubric_findings: [...FINDINGS(), { id, status: "not_assessable" }] }))).toBe("threshold_item_classified");
    },
  );
});

describe("F8. quarantined items: never assessable, no points, no linked coaching", () => {
  const QUARANTINED = ["x_factor", "tempo_ratio_ideal", "spine_maintained", "early_extension_severe", "early_extension_moderate", "casting_early_release", "minor_alignment_or_grip"];
  it.each(QUARANTINED)("%s claimed observed or not_observed → refused", (id) => {
    expect(rejection(provider({ rubric_findings: [...FINDINGS(), { id, status: "observed" }] }))).toBe("quarantined_item_claimed");
    expect(rejection(provider({ rubric_findings: [...FINDINGS(), { id, status: "not_observed" }] }))).toBe("quarantined_item_claimed");
  });
  it.each(QUARANTINED)("%s reported not_assessable is consistent and contributes nothing", (id) => {
    const { report, assessment } = accepted({ rubric_findings: [...FINDINGS(), { id, status: "not_assessable" }] });
    expect(report.score).toBe(72);
    expect(assessment.findings.find((f) => f.id === id)?.status).toBe("not_assessable");
  });
  it.each(QUARANTINED)("a deficiency linked to %s → refused; no rubric-linked tag can be produced", (id) => {
    expect(rejection(provider({ deficiencies: [{ title: "t", description: "d", rubric_id: id }] }))).toBe("quarantined_item_claimed");
  });
});

describe("F9. qualitative assessability applies to observed and not_observed alike", () => {
  it.each([
    ["over-the-top observed face-on", { rubric_findings: FINDINGS({ over_the_top: "observed" }) }, "finding_view_mismatch"],
    ["laid-off not_observed face-on (an unassessable absence)", { rubric_findings: FINDINGS({ laid_off_p4: "not_observed" }) }, "finding_view_mismatch"],
    ["reverse pivot with the view unclear", { camera_view: "unclear", threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: false, basis: null } } }, "finding_view_mismatch"],
    ["cupped wrist observed with the lead wrist unclear", { detail_visibility: { ...ALL_DETAILS_VISIBLE, lead_wrist: "unclear" }, rubric_findings: FINDINGS({ cupped_lead_wrist_top: "observed" }) }, "finding_detail_unavailable"],
    ["cupped wrist not_observed with the hands not visible", { detail_visibility: { ...ALL_DETAILS_VISIBLE, hands_grip: "not_visible" } }, "finding_detail_unavailable"],
    ["over-the-top down the line without the early downswing", {
      camera_view: "down_the_line",
      positions: { ...(provider().positions as object), early_downswing: unseen() },
      detail_visibility: ALL_DETAILS_VISIBLE,
      threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: "b" }, hip_turn_at_impact: { assessable: false, basis: null } },
      rubric_findings: FINDINGS({ over_the_top: "observed", reverse_pivot: "not_assessable" }),
      deficiencies: [], drills: [],
    }, "finding_position_unavailable"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(provider(patch))).toBe(reason);
  });

  it("over-the-top down the line with top and early downswing visible is assessable and scored by the server", () => {
    const { report } = accepted({
      camera_view: "down_the_line",
      detail_visibility: ALL_DETAILS_VISIBLE,
      threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: "b" }, hip_turn_at_impact: { assessable: false, basis: null } },
      rubric_findings: FINDINGS({ over_the_top: "observed", reverse_pivot: "not_assessable" }),
      deficiencies: [{ title: "Over the top", description: "d", rubric_id: "over_the_top" }],
    });
    expect(report.scoring_breakdown).toBe("75 + 5 (Shoulder rotation) - 5 (Over-the-top downswing path) = 75");
    expect(report.fault_tags).toEqual(["over_the_top"]);
  });
});

describe("F10. pillars, scorability and coaching links", () => {
  it.each([
    ["a rated pillar whose position is not visible", { positions: { ...(provider().positions as object), address: unseen() }, spine_angle: null, scorable: false, unscored_reason: "r", rubric_findings: FINDINGS({ reverse_pivot: "not_assessable" }), deficiencies: [], drills: [] }, "pillar_without_coverage"],
    ["scorable with impact not visible", { positions: { ...(provider().positions as object), impact: unseen() }, impact: INSUFFICIENT("Impact"), hip_rotation: null, tempo_ratio: null, threshold_assessments: { shoulder_turn_at_top: { assessable: true, basis: "b" }, hip_turn_at_impact: { assessable: false, basis: null } } }, "scorable_without_coverage"],
    ["scorable with every pillar insufficient", { posture: INSUFFICIENT("a"), swing_plane: INSUFFICIENT("b"), impact: INSUFFICIENT("c") }, "scorable_without_assessed_pillar"],
    ["a deficiency linked to an item marked not_observed", { rubric_findings: FINDINGS({ reverse_pivot: "not_observed" }) }, "deficiency_rubric_mismatch"],
    ["a deficiency linked to a threshold item", { deficiencies: [{ title: "t", description: "d", rubric_id: "restricted_backswing_severe" }] }, "deficiency_rubric_mismatch"],
    ["two deficiencies linked to the same item", { deficiencies: [
      { title: "a", description: "d", rubric_id: "reverse_pivot" }, { title: "b", description: "d", rubric_id: "reverse_pivot" }] }, "duplicate_rubric_link"],
  ])("%s → %s", (_label, patch, reason) => {
    expect(rejection(provider(patch))).toBe(reason);
  });

  it("an unlinked deficiency is allowed and produces no fault tag (its truth is not checked here)", () => {
    const { report } = accepted({ deficiencies: [{ title: "Grip looks weak", description: "d", rubric_id: null }] });
    expect(report.fault_tags).toEqual([]);
    expect(report.deficiencies).toEqual([{ title: "Grip looks weak", description: "d" }]);
  });
});

describe("F11. not detectable: a structurally consistent but false declaration passes (content evaluation remains necessary)", () => {
  it("a down-the-line view declared for any clip, with an observed over-the-top finding, is accepted and scored", () => {
    const { report } = accepted({
      camera_view: "down_the_line",
      detail_visibility: ALL_DETAILS_VISIBLE,
      threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: false, basis: null } },
      rubric_findings: FINDINGS({ over_the_top: "observed", reverse_pivot: "not_assessable", cupped_lead_wrist_top: "not_assessable" }),
      deficiencies: [{ title: "Over the top", description: "d", rubric_id: "over_the_top" }],
    });
    expect(report.score).toBe(70);
  });
});

describe("F12. metric evidence records value and source together", () => {
  const client = { spineAngle: 60, hipRotation: 170, shoulderRotation: null, tempoRatio: "9.9:1" };

  it("AI values are the analysis values; client values sit beside them, unverified", () => {
    const evidence = buildMetricEvidence(accepted({ shoulder_rotation: null, threshold_assessments: { shoulder_turn_at_top: { assessable: false, basis: null }, hip_turn_at_impact: { assessable: true, basis: "b" } } }).report, client);
    expect(evidence).toEqual({
      schema_version: 1,
      spine_angle: { ai_video_estimate: 35, client_unverified_estimate: 60 },
      hip_rotation: { ai_video_estimate: 42, client_unverified_estimate: 170 },
      shoulder_rotation: { ai_video_estimate: null, client_unverified_estimate: null },
      tempo_ratio: { ai_video_estimate: "3:1", client_unverified_estimate: "9.9:1" },
    });
  });

  it("stored evidence round-trips; zero survives", () => {
    const evidence = buildMetricEvidence(accepted({ hip_rotation: 0 }).report, client);
    expect(evidence.hip_rotation.ai_video_estimate).toBe(0);
    expect(readMetricEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it.each([
    ["absent", undefined],
    ["another version", { schema_version: 2 }],
    ["a missing metric", { schema_version: 1, spine_angle: { ai_video_estimate: 1, client_unverified_estimate: null } }],
  ])("malformed stored evidence (%s) is not read", (_label, value) => {
    expect(readMetricEvidence(value)).toBeNull();
  });
});
