import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// ENT-1D S6-R1 — lib/swing-metric-presentation.ts
// ============================================================================
//
// Pure unit coverage of how full-swing estimates and scores are presented, plus
// a source check that targets live in one table only. Rendered surfaces are
// covered in lib/ent-1a-analysis-authority.test.ts, section AB4.

import {
  METRIC_REFERENCES,
  SOURCE_LABELS,
  UNAVAILABLE_DISPLAY,
  UNAVAILABLE_FROM_VIDEO,
  formatAngle,
  formatTempo,
  presentFullSwingMetrics,
  presentMetric,
  presentScore,
  type MetricViewInput,
} from "@/lib/swing-metric-presentation";

const ai = (value: number | string | null, client: number | string | null = null): MetricViewInput => ({
  value,
  source: "ai_video_estimate",
  client_unverified_estimate: client,
});

describe("P1. approximate display, never more precise than the evidence", () => {
  it.each([
    [49.4, "≈50°"],
    [50.4, "≈50°"],
    [52.4, "≈50°"],
    [52.5, "≈55°"],
    [9.6, "≈10°"],
    [2, "≈0°"],
    [-2, "≈0°"],
    [0, "≈0°"],
    [-12, "≈-10°"],
  ])("angle %s → %s", (value, shown) => {
    expect(formatAngle(value)).toBe(shown);
  });

  it.each([
    [2.0, "≈2:1"],
    [2.24, "≈2:1"],
    [2.26, "≈2.5:1"],
    [3.1, "≈3:1"],
    [9.9, "≈10:1"],
  ])("tempo %s → %s", (value, shown) => {
    expect(formatTempo(value)).toBe(shown);
  });

  it("an estimate carries its source label and no decimal", () => {
    const shown = presentMetric("hip_rotation", ai(50.4));
    expect(shown).toEqual({
      status: "estimate",
      label: "Hip Rotation",
      display: "≈50°",
      sourceLabel: SOURCE_LABELS.ai_video_estimate,
      clientNote: null,
      reference: null,
    });
    expect(presentMetric("tempo_ratio", ai("2.0:1")).display).toBe("≈2:1");
    expect(presentMetric("spine_angle", { value: 31, source: "unrecorded", client_unverified_estimate: null }).sourceLabel).toBe(
      "Estimate · source not recorded",
    );
  });

  it("a client estimate is a separate, unverified note — never the value", () => {
    const shown = presentMetric("hip_rotation", ai(44, 170));
    expect(shown.display).toBe("≈45°");
    expect(shown.clientNote).toBe("Client-supplied estimate — unverified: ≈170°");
  });
});

describe("P2. unavailable is said plainly, never 0", () => {
  it.each([
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["out of range", 900],
    ["a numeric string for an angle", "45"],
  ])("angle %s → Not available", (_label, value) => {
    const shown = presentMetric("spine_angle", ai(value as number | string | null));
    expect(shown.status).toBe("unavailable");
    expect(shown.display).toBe(UNAVAILABLE_DISPLAY);
    expect(shown.sourceLabel).toBe(UNAVAILABLE_FROM_VIDEO);
  });

  it.each(["fast", "3", "0:1", "3:2", 3])("tempo %s → Not available", (value) => {
    expect(presentMetric("tempo_ratio", ai(value as string)).status).toBe("unavailable");
  });

  it("a missing view (legacy or absent) is all unavailable, with no invented source", () => {
    const shown = presentFullSwingMetrics(null);
    expect(shown.map((m) => m.status)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
    expect(shown.map((m) => m.sourceLabel)).toEqual([null, null, null, null]);
  });

  it("an unavailable value still shows an unverified client note when one was recorded", () => {
    const shown = presentMetric("hip_rotation", ai(null, 170));
    expect(shown.status).toBe("unavailable");
    expect(shown.clientNote).toBe("Client-supplied estimate — unverified: ≈170°");
  });

  it.each([
    [67, { scored: true, value: 67 }],
    [0, { scored: true, value: 0 }],
    [null, { scored: false }],
    [undefined, { scored: false }],
    [Number.NaN, { scored: false }],
    [140, { scored: false }],
    ["67", { scored: false }],
  ])("score %s → %j", (score, shown) => {
    expect(presentScore(score)).toEqual(shown);
  });
});

describe("P3. targets render only from one table, and only with a cited source", () => {
  it("no reference has a source today, so none renders", () => {
    for (const ref of Object.values(METRIC_REFERENCES)) {
      expect(ref.source).toBeNull();
      expect(ref.range).toBeNull();
    }
    for (const m of presentFullSwingMetrics({
      spine_angle: ai(35), hip_rotation: ai(45), shoulder_rotation: ai(90), tempo_ratio: ai("3:1"),
    })) {
      expect(m.reference).toBeNull();
    }
  });

  it("no full-swing surface declares a target outside METRIC_REFERENCES", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const surfaces = [
      "app/(dashboard)/telemetry/page.tsx",
      "app/(dashboard)/swings/[id]/page.tsx",
      "app/(dashboard)/analyze/[id]/AnalysisReport.tsx",
      "app/api/analyze-swing/route.ts",
    ];
    for (const rel of surfaces) {
      const source = readFileSync(path.join(root, rel), "utf8");
      expect(source, `${rel} declares a Tour target`).not.toMatch(/Tour (ideal|avg|average)\s*[:(]/i);
      expect(source, `${rel} declares an ideal range`).not.toMatch(/ideal:\s*"/);
      expect(source, `${rel} declares a benchmark`).not.toMatch(/benchmark=/);
    }
    // The table itself is declared once, in the presentation module.
    const libDir = path.join(root, "lib");
    const declaring = readdirSync(libDir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && statSync(path.join(libDir, f)).isFile())
      .filter((f) => readFileSync(path.join(libDir, f), "utf8").includes("METRIC_REFERENCES: Readonly"));
    expect(declaring).toEqual(["swing-metric-presentation.ts"]);
  });
});

describe("P4. shared disclosures make no origin claim, so they fit unrecorded historical values (S6-R1A)", () => {
  it("heading and disclosure name no source; each value carries its own", async () => {
    const { ESTIMATES_HEADING, ESTIMATES_DISCLOSURE } = await import("@/lib/swing-metric-presentation");
    expect(ESTIMATES_HEADING).toBe("Swing estimates");
    for (const claim of ["AI estimates", "from video", "device"]) expect(ESTIMATES_DISCLOSURE).not.toContain(claim);
    expect(ESTIMATES_DISCLOSURE).toContain("client-supplied values cannot be verified");
    expect(presentMetric("hip_rotation", { value: 44, source: "unrecorded", client_unverified_estimate: null }).sourceLabel).toBe(
      "Estimate · source not recorded",
    );
  });
});
