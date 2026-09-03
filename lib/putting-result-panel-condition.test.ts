/**
 * The swing-detail result page's putting classification.
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
 * WHY THE ASSERTIONS ARE STATIC
 * -----------------------------
 * This is an async server component that opens a Supabase client. Vitest runs
 * in the node environment here, with no jsdom and no renderer, so which branch
 * the page takes cannot be observed by rendering it. The condition is therefore
 * asserted against source -- but the render assertions run inside an isolated
 * putting-panel region, so a change elsewhere on the page can neither break
 * them nor quietly make them vacuous.
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
 * Anchors for the putting-panel region. Both are prefixes of existing comment
 * markers on the page, chosen to stop short of any non-ASCII punctuation so the
 * region cannot drift on an encoding difference, and neither is a line number.
 */
const REGION_START = "{/* Putting Analysis";
const REGION_END = "{/* v5: Equipment Recommendations";

/**
 * The putting-panel block only: from its section comment up to the start of the
 * next section. Render assertions are meaningful only inside this slice.
 */
function puttingPanelRegion(): string {
  const startIdx = pageSource.indexOf(REGION_START);
  expect(startIdx, `${RESULT_PAGE}: putting-panel region start anchor not found`).toBeGreaterThanOrEqual(0);
  const endIdx = pageSource.indexOf(REGION_END, startIdx);
  expect(endIdx, `${RESULT_PAGE}: putting-panel region end anchor not found`).toBeGreaterThan(startIdx);
  return pageSource.slice(startIdx, endIdx);
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
});

describe("the putting panel renders for putts, not for everything else", () => {
  it("gates the panel on isPutt", () => {
    expect(puttingPanelRegion()).toContain("{isPutt && (");
  });

  it("does not gate the panel on the negation of isPutt", () => {
    expect(puttingPanelRegion()).not.toContain("{!isPutt && (");
  });

  it("mounts the panel exactly once", () => {
    // The JSX tag, not the import: `import { PuttingAnalysisPanel }` cannot
    // match, so a second render site anywhere on the page fails this.
    expect(countOccurrences(pageSource, "<PuttingAnalysisPanel")).toBe(1);
  });

  it("still passes the three putting metrics the panel expects", () => {
    const region = puttingPanelRegion();
    expect(region).toContain("puttTempoRatio: swing.putt_tempo_ratio ?? null,");
    expect(region).toContain("faceAngleAtImpactDeg: swing.face_angle_at_impact_deg ?? null,");
    expect(region).toContain("pathDeviationMm: swing.path_deviation_mm ?? null,");
  });
});

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
