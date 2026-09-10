/**
 * The swing-detail result page's family split.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The page once decided whether a completed analysis was a putt by reading
 * swing.swing_category, falling back to analysis_v2 -> swing_category. Neither
 * column exists on public.swing_analysis, so the classifier could only ever
 * evaluate to false, and the panel was additionally gated on its negation. The
 * result was that every full-swing report rendered a Putting Analysis section
 * (an upgrade card, for an unentitled golfer) while a genuine putt would have
 * rendered none.
 *
 * The database already owns this decision. analysis_family is derived before
 * insert from the validated, non-archived, owner-checked equipment row --
 * 'putting' for a Putter, 'full_swing' otherwise, null with no club -- is
 * constrained to those two values, and is immutable afterwards. The page's only
 * correct move is to read it.
 *
 * WHAT EQ5C-A CHANGED HERE
 * ------------------------
 * This suite previously asserted that the page passes putt_tempo_ratio,
 * face_angle_at_impact_deg and path_deviation_mm into the panel. That
 * assertion pinned a defect rather than a guarantee: the EQ5B putting pipeline
 * is forbidden from writing those three columns (see
 * analysis-family-router.test.ts), so the wiring could only ever deliver nulls,
 * and the panel's own "no data" branch keyed on them -- meaning a fully
 * successful putting analysis would have rendered an empty state forever.
 *
 * It is replaced, not weakened. The page is now structurally family-aware, and
 * the assertions below are stricter than the ones they retire: the putting
 * region must consume none of those columns, and the panel may only receive a
 * server-decided state.
 *
 * WHY THE ASSERTIONS ARE STATIC
 * -----------------------------
 * This is an async server component that opens a Supabase client. Vitest runs
 * in the node environment here, with no jsdom and no renderer, so which branch
 * the page takes cannot be observed by rendering it. The structure is therefore
 * asserted against source -- but each assertion runs inside an isolated region,
 * so a change elsewhere on the page can neither break them nor quietly make
 * them vacuous.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED
 * ---------------------------------
 * analysisV2 is not banned from the page. Its putting-classification use is
 * gone, but a separate equipment-fitting use remains and is load-bearing, so
 * the last test below pins that dependency down: a later cleanup must not
 * delete analysisV2 on the assumption that removing the dead classifier
 * orphaned it. The bare token "swing_category" is likewise not banned
 * repository-wide -- the AI backend and the empty legacy swing_analyses table
 * legitimately use that vocabulary. Only this page, and only this contract.
 *
 * dangerouslySetInnerHTML is not banned from the file either. The full-swing
 * Deep Biomechanical Audit legitimately uses it on prose sanitised at write
 * time, and EQ5C-A did not touch that. What matters is that it stays out of the
 * putting region, which is asserted inside the isolated region below.
 *
 * No database, no network, no Supabase client, no jsdom, no credential.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const pageSource = readSource(RESULT_PAGE);

/**
 * Region anchors. Each is a deliberately plain ASCII marker written into the
 * page as a JSX comment, so no region can drift on an encoding difference and
 * none is a line number.
 */
const PUTTING_REGION_START = "PUTTING RESULT REGION";
const FULL_SWING_REGION_START = "FULL SWING REPORT REGION";
const SHARED_STATUS_REGION_START = "SHARED STATUS REGION";

function regionBetween(startMarker: string, endMarker: string): string {
  const startIdx = pageSource.indexOf(startMarker);
  expect(startIdx, `${RESULT_PAGE}: region start anchor not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const endIdx = pageSource.indexOf(endMarker, startIdx);
  expect(endIdx, `${RESULT_PAGE}: region end anchor not found: ${endMarker}`).toBeGreaterThan(startIdx);
  return pageSource.slice(startIdx, endIdx);
}

/** Everything rendered for a putting row, and nothing else. */
function puttingRegion(): string {
  return regionBetween(PUTTING_REGION_START, FULL_SWING_REGION_START);
}

/** Everything rendered for a full-swing or null-family row, and nothing else. */
function fullSwingRegion(): string {
  return regionBetween(FULL_SWING_REGION_START, SHARED_STATUS_REGION_START);
}

function countOccurrences(haystack: string, needle: string): number {
  let total = 0;
  let cursor = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) return total;
    total += 1;
    cursor = idx + needle.length;
  }
}

// ─── Database-owned family ────────────────────────────────────────────────────

describe("swing detail page classifies putts from the database-owned analysis family", () => {
  it("derives isPutt from swing_analysis.analysis_family", () => {
    expect(pageSource).toContain('const isPutt = swing.analysis_family === "putting";');
  });

  it("does not read a swing_category column, which public.swing_analysis does not have", () => {
    expect(pageSource).not.toContain("swing.swing_category");
  });

  it("does not fall back to an analysis_v2 swing_category key, which the table also does not have", () => {
    expect(pageSource).not.toContain("analysisV2?.swing_category");
  });

  it("reads the family exactly once, so no second classifier can drift from it", () => {
    expect(countOccurrences(pageSource, "swing.analysis_family")).toBe(1);
  });
});

// ─── The family split is structural ───────────────────────────────────────────

describe("the page is structurally family-aware, not merely null-tolerant", () => {
  it("branches the whole report on isPutt", () => {
    expect(pageSource).toContain("{isPutt ? (");
  });

  it("does not branch on the negation of isPutt", () => {
    expect(pageSource).not.toContain("{!isPutt && (");
  });

  it("exposes all three regions in source order", () => {
    const putting = pageSource.indexOf(PUTTING_REGION_START);
    const fullSwing = pageSource.indexOf(FULL_SWING_REGION_START);
    const shared = pageSource.indexOf(SHARED_STATUS_REGION_START);
    expect(putting).toBeGreaterThanOrEqual(0);
    expect(fullSwing).toBeGreaterThan(putting);
    expect(shared).toBeGreaterThan(fullSwing);
  });

  it("mounts the putting panel exactly once, inside the putting region", () => {
    // The JSX tag, not the import: `import { PuttingAnalysisPanel }` cannot
    // match, so a second render site anywhere on the page fails this.
    expect(countOccurrences(pageSource, "<PuttingAnalysisPanel")).toBe(1);
    expect(puttingRegion()).toContain("<PuttingAnalysisPanel");
  });
});

// ─── The putting region consumes only the canonical payload ───────────────────

describe("the putting region carries no legacy numeric wiring", () => {
  it("passes none of the three legacy putting columns the EQ5B pipeline never writes", () => {
    const region = puttingRegion();
    for (const column of [
      "putt_tempo_ratio",
      "face_angle_at_impact_deg",
      "path_deviation_mm",
      "putt_analytics",
    ]) {
      expect(region, `putting region must not read ${column}`).not.toContain(column);
    }
  });

  it("passes no legacy camelCase metric props either", () => {
    const region = puttingRegion();
    for (const prop of ["puttTempoRatio", "faceAngleAtImpactDeg", "pathDeviationMm", "greenReading"]) {
      expect(region, `putting region must not pass ${prop}`).not.toContain(prop);
    }
  });

  it("hands the panel a server-decided state rather than a tier", () => {
    const region = puttingRegion();
    expect(region).toContain("state={puttingState}");
    expect(region, "the panel must not receive a tier to judge for itself").not.toContain("tier={");
  });

  it("renders no putting narrative through raw HTML", () => {
    expect(puttingRegion()).not.toContain("dangerouslySetInnerHTML");
  });
});

// ─── Server-owned result visibility ───────────────────────────────────────────

describe("result visibility is decided on the server, before any prop is built", () => {
  it("uses the centralized putting entitlement helper", () => {
    expect(pageSource).toContain('import { canUsePuttingAnalysis } from "@/lib/entitlements";');
    expect(pageSource).toContain("canUsePuttingAnalysis(tier)");
  });

  it("validates the stored payload with the shared persisted-v1 predicate", () => {
    expect(pageSource).toContain(
      'import { isPersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";'
    );
    expect(pageSource).toContain("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
  });

  it("treats the stored jsonb as untrusted transport", () => {
    expect(pageSource).toContain(
      'const rawPuttingAnalysis = (swing.putting_analysis ?? null) as Record<string, unknown> | null;'
    );
  });

  it("refuses an unentitled tier before the payload is ever looked at", () => {
    const source = pageSource;
    const entitlement = source.indexOf("if (!canUsePuttingAnalysis(tier)) return { status: \"locked\" };");
    const validation = source.indexOf("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
    expect(entitlement, "the locked short-circuit is missing").toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(entitlement);
  });

  it("builds a ready state only from the narrowed payload", () => {
    // The single ready construction site, and its only possible source.
    expect(countOccurrences(pageSource, 'status: "ready"')).toBe(1);
    expect(pageSource).toContain('return { status: "ready", analysis: rawPuttingAnalysis };');
  });

  it("does not hard-code the putting tier matrix on the page", () => {
    // Tier names appear on this page for the unrelated equipment-fitting gate,
    // so the ban is scoped to the putting state resolver rather than the file.
    const start = pageSource.indexOf("const puttingState");
    expect(start, "putting state resolver not found").toBeGreaterThanOrEqual(0);
    const end = pageSource.indexOf("return (", start);
    expect(end).toBeGreaterThan(start);
    const resolver = pageSource.slice(start, end);
    for (const tier of ["birdie", "eagle", "coach_starter", "coach_pro", "par", "none"]) {
      expect(resolver, `putting state must not hard-code the ${tier} tier`).not.toContain(`"${tier}"`);
    }
  });

  it("does not label an unfinished analysis unavailable", () => {
    expect(pageSource).toContain(
      'const isAwaitingResult = swing.status === "processing" || swing.status === "pending";'
    );
    expect(pageSource).toContain("if (isAwaitingResult) return null;");
  });
});

// ─── Full-swing and null-family compatibility ─────────────────────────────────

describe("the full-swing report survives the family split unchanged", () => {
  it("keeps every full-swing render site that putting suppresses", () => {
    const region = fullSwingRegion();
    for (const anchor of [
      "metricCards.map((m) => (",
      "Ideal: {m.ideal}",
      'm.label === "Swing Score"',
      "Scoring Math",
      "AI Coach Feedback",
      "Deep Biomechanical Audit",
      "<SwingHighlightsPanel",
      "<MechanicalDeficienciesPanel",
      "<EquipmentRecommendations",
      "Improvement Protocols",
      "Raw Telemetry",
    ]) {
      expect(region, `full-swing region lost ${anchor}`).toContain(anchor);
    }
  });

  it("renders the six full-swing metric cards from exactly one site", () => {
    // The definitions live above the JSX, so the family split works by not
    // rendering them rather than by removing them.
    expect(countOccurrences(pageSource, "metricCards.map(")).toBe(1);
    expect(fullSwingRegion()).toContain("metricCards.map(");
    expect(puttingRegion()).not.toContain("metricCards");
  });

  it("keeps the full-swing detailed-summary HTML rendering it already had", () => {
    // Sanitised at write time by the v1 analyze route. EQ5C-A does not touch
    // it; it only keeps it out of the putting branch.
    expect(fullSwingRegion()).toContain("dangerouslySetInnerHTML");
  });

  it("renders no full-swing metric card for a putting row", () => {
    const region = puttingRegion();
    for (const anchor of [
      "Swing Score",
      "Swing Speed",
      "Spine Angle",
      "Hip Rotation",
      "Shoulder Rotation",
      "Scoring Math",
      "AI Coach Feedback",
      "Deep Biomechanical Audit",
      "<SwingHighlightsPanel",
      "<MechanicalDeficienciesPanel",
      "<EquipmentRecommendations",
      "Improvement Protocols",
      "Raw Telemetry",
    ]) {
      expect(region, `putting region must not render ${anchor}`).not.toContain(anchor);
    }
  });

  it("leaves a null analysis_family on the full-swing path", () => {
    // isPutt is a strict equality against "putting", so null -- the established
    // compatibility case for rows recorded without a club -- is false and takes
    // the full-swing branch. A truthiness check or a null test here would
    // silently reroute every legacy row.
    expect(pageSource).toContain('swing.analysis_family === "putting"');
    expect(pageSource).not.toContain("analysis_family !== ");
    expect(pageSource).not.toContain("analysis_family == null");
  });

  it("keeps the status banners family-neutral", () => {
    const shared = pageSource.slice(pageSource.indexOf(SHARED_STATUS_REGION_START));
    expect(shared).toContain("AI analysis in progress");
    expect(shared).toContain("Analysis queued");
    expect(shared, "the shared banners must not re-test the family").not.toContain("isPutt");
  });
});

// ─── The separate analysis_v2 equipment-fitting dependency survives ───────────

describe("the separate analysis_v2 equipment-fitting dependency survives", () => {
  it("still derives equipmentFitting from analysisV2", () => {
    // analysisV2 lost its putting-classification use, not its only use. This
    // pins the remaining one so a later cleanup cannot delete the declaration
    // and silently break the Equipment Recommendations panel.
    expect(pageSource).toContain(
      "const equipmentFitting = (analysisV2?.equipment_fitting ?? null) as EquipmentFitting | null;"
    );
  });
});
