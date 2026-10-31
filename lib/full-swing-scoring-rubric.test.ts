import { describe, expect, it } from "vitest";

// ============================================================================
// lib/full-swing-scoring-rubric.ts — server-authoritative full-swing scoring
// ============================================================================
//
// Pure unit coverage of the versioned rubric table, item outcomes and the
// arithmetic. Synthetic inputs only. Passing these tests shows the server's
// arithmetic and consistency rules; it does not validate any golf definition
// (the table is an engineering draft, not coach-reviewed).

import {
  MEASURES,
  QUALITATIVE_ITEM_IDS,
  RUBRIC_ITEMS,
  RUBRIC_ITEM_IDS,
  RUBRIC_POLICY,
  RUBRIC_START,
  RUBRIC_VERSION,
  SWING_DETAILS,
  SWING_POSITIONS,
  computeRubricScore,
  requirementGap,
  rubricItem,
  rubricOutcomes,
  type FindingStatus,
  type ItemOutcome,
  type RubricDeclarations,
  type RubricInputs,
} from "@/lib/full-swing-scoring-rubric";

const ALL_POSITIONS = Object.fromEntries(SWING_POSITIONS.map((p) => [p, "yes"])) as RubricDeclarations["positions"];
const ALL_DETAILS = Object.fromEntries(SWING_DETAILS.map((d) => [d, "visible"])) as RubricDeclarations["detail_visibility"];

function inputs(overrides: Partial<RubricInputs> & { view?: RubricDeclarations["camera_view"] } = {}): RubricInputs {
  const qualitative: Record<string, FindingStatus> = Object.fromEntries(QUALITATIVE_ITEM_IDS.map((id) => [id, "not_assessable"]));
  return {
    declarations: { camera_view: overrides.view ?? "face_on", positions: ALL_POSITIONS, detail_visibility: ALL_DETAILS },
    estimates: { shoulder_rotation: null, hip_rotation: null },
    thresholdAssessable: { shoulder_turn_at_top: false, hip_turn_at_impact: false },
    qualitative,
    ...overrides,
  };
}
const status = (outcomes: readonly ItemOutcome[], id: string) => outcomes.find((o) => o.id === id)?.status;

describe("R1. the versioned table keeps all 17 existing items and points", () => {
  it("IDs, points and kinds", () => {
    expect(RUBRIC_ITEM_IDS).toHaveLength(17);
    expect(new Set(RUBRIC_ITEM_IDS).size).toBe(17);
    const points = Object.fromEntries(RUBRIC_ITEMS.map((i) => [i.id, i.points]));
    expect(points).toEqual({
      shoulder_turn_full: 5, hip_turn_impact: 5, x_factor: 5, tempo_ratio_ideal: 3, spine_maintained: 3,
      early_extension_severe: -8, early_extension_moderate: -5, restricted_backswing_severe: -8, restricted_backswing_moderate: -5,
      body_block_severe: -8, body_block_moderate: -5, laid_off_p4: -3, over_the_top: -5, casting_early_release: -5,
      cupped_lead_wrist_top: -3, reverse_pivot: -8, minor_alignment_or_grip: -2,
    });
    expect(RUBRIC_START).toBe(75);
    expect(RUBRIC_VERSION).toContain("not-coach-reviewed");
    expect(RUBRIC_POLICY).toBe("P1-provisional");
  });

  it("the incompletely defined rules are quarantined, each with a stated reason", () => {
    const quarantined = RUBRIC_ITEMS.filter((i) => i.kind === "quarantined");
    expect(quarantined.map((i) => i.id).sort()).toEqual(
      ["casting_early_release", "early_extension_moderate", "early_extension_severe", "minor_alignment_or_grip", "spine_maintained", "tempo_ratio_ideal", "x_factor"].sort(),
    );
    for (const item of quarantined) expect(item.kind === "quarantined" && item.reason.length > 20, item.id).toBe(true);
    expect(rubricItem("x_factor")?.kind === "quarantined" && rubricItem("x_factor")).toMatchObject({ reason: expect.stringContaining("not a same-phase separation") });
    expect(rubricItem("spine_maintained")).toMatchObject({ reason: expect.stringContaining("One spine_angle estimate cannot represent a setup-to-impact change") });
    expect(rubricItem("casting_early_release")).toMatchObject({ reason: expect.stringContaining("D-CAST") });
    expect(rubricItem("minor_alignment_or_grip")).toMatchObject({ reason: expect.stringContaining("D-ALIGN") });
    expect(rubricItem("tempo_ratio_ideal")).toMatchObject({ reason: expect.stringContaining("1 frame per second") });
  });

  it("over-the-top needs the early downswing as well as the top; no item treats address as the takeaway start", () => {
    expect(rubricItem("over_the_top")).toMatchObject({ positions: ["top_of_backswing", "early_downswing"] });
    for (const item of RUBRIC_ITEMS) {
      if (item.kind === "qualitative") expect(item.positions, item.id).not.toContain("takeaway_start");
    }
    expect(SWING_POSITIONS.indexOf("address")).toBeLessThan(SWING_POSITIONS.indexOf("takeaway_start"));
  });

  it("threshold items read only the shoulder and hip measures, each with explicit requirements", () => {
    expect(MEASURES.shoulder_turn_at_top).toEqual({ estimate: "shoulder_rotation", views: ["face_on", "down_the_line"], details: ["shoulders"], positions: ["top_of_backswing"] });
    expect(MEASURES.hip_turn_at_impact).toEqual({ estimate: "hip_rotation", views: ["face_on"], details: ["pelvis"], positions: ["impact"] });
  });
});

describe("R2. item outcomes", () => {
  it("quarantined items are always not assessable", () => {
    const o = rubricOutcomes(inputs({ estimates: { shoulder_rotation: 95, hip_rotation: 50 }, thresholdAssessable: { shoulder_turn_at_top: true, hip_turn_at_impact: true } }));
    for (const id of ["x_factor", "tempo_ratio_ideal", "spine_maintained", "early_extension_severe", "early_extension_moderate", "casting_early_release", "minor_alignment_or_grip"]) {
      expect(status(o, id), id).toBe("not_assessable");
    }
  });

  it.each([
    [95, ["observed", "not_observed", "not_observed"]],
    [90, ["observed", "not_observed", "not_observed"]],
    [85, ["not_observed", "not_observed", "not_observed"]],
    [80, ["not_observed", "not_observed", "observed"]],
    [70, ["not_observed", "not_observed", "observed"]],
    [69, ["not_observed", "observed", "not_observed"]],
  ])("shoulder estimate %i (assessable) → full / severe / moderate outcomes derived by the server", (v, expected) => {
    const o = rubricOutcomes(inputs({ estimates: { shoulder_rotation: v, hip_rotation: null }, thresholdAssessable: { shoulder_turn_at_top: true, hip_turn_at_impact: false } }));
    expect([status(o, "shoulder_turn_full"), status(o, "restricted_backswing_severe"), status(o, "restricted_backswing_moderate")]).toEqual(expected);
  });

  it.each([
    [50, ["observed", "not_observed", "not_observed"]],
    [42, ["not_observed", "not_observed", "not_observed"]],
    [35, ["not_observed", "not_observed", "observed"]],
    [20, ["not_observed", "observed", "not_observed"]],
  ])("hip estimate %i (assessable) → full / severe / moderate outcomes", (v, expected) => {
    const o = rubricOutcomes(inputs({ estimates: { shoulder_rotation: null, hip_rotation: v }, thresholdAssessable: { shoulder_turn_at_top: false, hip_turn_at_impact: true } }));
    expect([status(o, "hip_turn_impact"), status(o, "body_block_severe"), status(o, "body_block_moderate")]).toEqual(expected);
  });

  it("an estimate alone never yields an outcome: not assessable without the declared assessment", () => {
    const o = rubricOutcomes(inputs({ estimates: { shoulder_rotation: 95, hip_rotation: 20 } }));
    for (const id of ["shoulder_turn_full", "restricted_backswing_severe", "hip_turn_impact", "body_block_severe"]) expect(status(o, id), id).toBe("not_assessable");
  });

  it("qualitative statuses pass through", () => {
    const o = rubricOutcomes(inputs({ qualitative: { laid_off_p4: "not_assessable", over_the_top: "not_assessable", cupped_lead_wrist_top: "not_observed", reverse_pivot: "observed" } }));
    expect([status(o, "cupped_lead_wrist_top"), status(o, "reverse_pivot")]).toEqual(["not_observed", "observed"]);
  });

  it("requirement gaps: view, then detail, then position", () => {
    const item = rubricItem("over_the_top");
    if (item?.kind !== "qualitative") throw new Error("expected a qualitative item");
    expect(requirementGap({ camera_view: "face_on", positions: ALL_POSITIONS, detail_visibility: ALL_DETAILS }, item)).toBe("view");
    expect(requirementGap({ camera_view: "unclear", positions: ALL_POSITIONS, detail_visibility: ALL_DETAILS }, item)).toBe("view");
    expect(requirementGap({ camera_view: "down_the_line", positions: ALL_POSITIONS, detail_visibility: { ...ALL_DETAILS, target_reference: "unclear" } }, item)).toBe("detail");
    expect(requirementGap({ camera_view: "down_the_line", positions: { ...ALL_POSITIONS, early_downswing: "unclear" }, detail_visibility: ALL_DETAILS }, item)).toBe("position");
    expect(requirementGap({ camera_view: "down_the_line", positions: ALL_POSITIONS, detail_visibility: ALL_DETAILS }, item)).toBeNull();
  });
});

describe("R3. arithmetic", () => {
  it("missing evidence never becomes 75: computing with nothing assessable throws", () => {
    expect(() => computeRubricScore(rubricOutcomes(inputs()))).toThrow("requires at least one assessable item");
  });

  it("earned baseline: a fully eligible assessment with no applicable adjustment legitimately yields 75", () => {
    const o = rubricOutcomes(inputs({
      estimates: { shoulder_rotation: 85, hip_rotation: 42 },
      thresholdAssessable: { shoulder_turn_at_top: true, hip_turn_at_impact: true },
      qualitative: { laid_off_p4: "not_assessable", over_the_top: "not_assessable", cupped_lead_wrist_top: "not_observed", reverse_pivot: "not_observed" },
    }));
    expect(computeRubricScore(o)).toEqual({ score: 75, breakdown: "75 (no rubric adjustments applied) = 75", applied: [], raw_total: 75 });
  });

  it("applied adjustments in table order, labelled, compact", () => {
    const o = rubricOutcomes(inputs({
      estimates: { shoulder_rotation: 95, hip_rotation: 35 },
      thresholdAssessable: { shoulder_turn_at_top: true, hip_turn_at_impact: true },
      qualitative: { laid_off_p4: "not_assessable", over_the_top: "not_assessable", cupped_lead_wrist_top: "observed", reverse_pivot: "not_observed" },
    }));
    const r = computeRubricScore(o);
    expect(r.breakdown).toBe("75 + 5 (Shoulder rotation) - 5 (Moderate body block) - 3 (Cupped lead wrist at top) = 72");
    expect(r.score).toBe(72);
    expect(r.breakdown).not.toMatch(/\n| {2}/);
  });

  it("the clamp is applied and shown", () => {
    const o = rubricOutcomes(inputs({
      view: "face_on",
      estimates: { shoulder_rotation: 60, hip_rotation: 20 },
      thresholdAssessable: { shoulder_turn_at_top: true, hip_turn_at_impact: true },
      qualitative: { laid_off_p4: "not_assessable", over_the_top: "not_assessable", cupped_lead_wrist_top: "observed", reverse_pivot: "observed" },
    }));
    const r = computeRubricScore(o);
    expect(r.raw_total).toBe(75 - 8 - 8 - 3 - 8);
    expect(r.score).toBe(55);
    expect(r.breakdown).toBe("75 - 8 (Severely restricted backswing) - 8 (Severe body block) - 3 (Cupped lead wrist at top) - 8 (Reverse pivot) = 48, clamped to 55");
  });

  it("one adjustment per issue: the larger magnitude wins when an issue has several observed items", () => {
    const outcomes: ItemOutcome[] = RUBRIC_ITEMS.map((i) => ({ id: i.id, status: "not_assessable", source: "qualitative" }));
    const set = (id: string) => (outcomes.find((o) => o.id === id) as { status: string }).status = "observed";
    set("restricted_backswing_moderate");
    set("restricted_backswing_severe");
    set("shoulder_turn_full");
    const r = computeRubricScore(outcomes);
    expect(r.applied).toEqual([{ id: "restricted_backswing_severe", label: "Severely restricted backswing", points: -8 }]);
    expect(r.score).toBe(67);
  });

  it("a quarantined item can never contribute, even if an outcome claimed it", () => {
    const outcomes: ItemOutcome[] = RUBRIC_ITEMS.map((i) => ({ id: i.id, status: i.id === "x_factor" ? "observed" : "not_observed", source: "qualitative" }));
    expect(computeRubricScore(outcomes).applied).toEqual([]);
  });
});
