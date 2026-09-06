/**
 * EQ3-S1 — the Analyze saved-club selector.
 *
 * Two kinds of coverage, deliberately separated.
 *
 * BEHAVIOURAL, for the rules that decide what a golfer's analysis records.
 * resolveInitialClubId and isSelectionStillValid are pure functions over an
 * already-fetched SavedClubsResult, so the query-parameter and revalidation
 * rules are exercised directly against real inputs — malformed, unknown,
 * foreign, archived and every non-ok status — rather than inferred from
 * substrings in an 800-line page.
 *
 * STRUCTURAL, for the wiring those rules depend on. Whether Analyze reuses the
 * one saved-club reader, keeps a single managed client, and orders submission
 * correctly cannot be observed without rendering the page, so it is asserted
 * against source — but ordering is asserted inside an isolated startAnalysis
 * body, never by searching the whole file, so adding another session lookup
 * elsewhere can neither break these tests nor quietly make them meaningless.
 *
 * WHAT "FOREIGN" AND "ARCHIVED" MEAN HERE
 * ---------------------------------------
 * Neither can appear in a SavedClubsResult at all: querySavedClubs filters by
 * the caller's user id alongside row-level security and excludes archived rows
 * in the query itself. So both reach these helpers as "an id that is not in the
 * list", which is exactly the case covered below — and exactly why every
 * rejection is indistinguishable to the caller.
 *
 * No database, no network, no Supabase client, no jsdom, no credential.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPuttingCapturePresentation,
  isSelectionStillValid,
  resolveInitialClubId,
} from "@/lib/equipment/analyze-club-selection";
import type {
  SavedClubsResult,
  SelectableClub,
} from "@/lib/equipment/saved-clubs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ANALYZE_PAGE = "app/(dashboard)/analyze/page.tsx";
const BAG_CLIENT = "app/(dashboard)/bag/BagPageClient.tsx";
const ANALYZE_API = "app/api/analyze-swing/route.ts";
const DB0_MIGRATION =
  "supabase/migrations/20260830162046_equipment_snapshot_active_guard_eq3_s1_db0.sql";

const analyzeSource = readSource(ANALYZE_PAGE);
const bagClientSource = readSource(BAG_CLIENT);
const analyzeApiSource = readSource(ANALYZE_API);
const db0Source = readSource(DB0_MIGRATION);
/** EQ3-S2 reads this only to prove it was not touched. */
const entitlementsSource = readSource("lib/entitlements.ts");

/**
 * The startAnalysis body, isolated by the same boundaries the other Analyze
 * suites use. Submission ordering is only meaningful inside this region.
 */
function submissionBody(): string {
  const startIdx = analyzeSource.indexOf("const startAnalysis");
  expect(startIdx).toBeGreaterThanOrEqual(0);
  const endIdx = analyzeSource.indexOf("const setTime", startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return analyzeSource.slice(startIdx, endIdx);
}

const submissionSource = submissionBody();

/** Everything before startAnalysis: imports, state and the selector load. */
function initializationSource(): string {
  const endIdx = analyzeSource.indexOf("const startAnalysis");
  expect(endIdx).toBeGreaterThan(0);
  return analyzeSource.slice(0, endIdx);
}

const initSource = initializationSource();

// ─── Fixtures, hand-written so no expectation is derived from the reader ──────

function club(id: string, overrides: Partial<SelectableClub> = {}): SelectableClub {
  return {
    id,
    clubType: "Iron",
    displayName: "7i · Titleist T100",
    isPrimary: false,
    ...overrides,
  };
}

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
/** Not in any fixture list: stands in for unknown, foreign and archived ids. */
const ABSENT_ID = "99999999-9999-4999-8999-999999999999";

const OK_RESULT: SavedClubsResult = {
  status: "ok",
  clubs: [
    club(PRIMARY_ID, {
      clubType: "Driver",
      displayName: "Driver · TaylorMade Qi10",
      isPrimary: true,
    }),
    club(SECOND_ID),
    club(THIRD_ID, { clubType: "Putter", displayName: "Putter · Scotty Cameron" }),
  ],
};

const NON_OK_RESULTS: SavedClubsResult[] = [
  { status: "empty", clubs: [] },
  { status: "auth_error", clubs: [] },
  { status: "database_error", clubs: [] },
  { status: "malformed_data", clubs: [] },
];

// ─── Behavioural: resolveInitialClubId ───────────────────────────────────────

describe("resolveInitialClubId — the query parameter is a hint, never authorization", () => {
  it("returns null when there is no club_id in the URL", () => {
    expect(resolveInitialClubId(OK_RESULT, null)).toBeNull();
  });

  it("returns the exact id when it is present in an active owned result", () => {
    expect(resolveInitialClubId(OK_RESULT, SECOND_ID)).toBe(SECOND_ID);
  });

  it("returns null for an id that is not in the result", () => {
    // Unknown, another golfer's, and archived ids are all this case: none of
    // them can appear in a result the reader already scoped and filtered.
    expect(resolveInitialClubId(OK_RESULT, ABSENT_ID)).toBeNull();
  });

  it("returns null for a malformed id", () => {
    for (const malformed of ["", "not-a-uuid", "../../etc/passwd", "  ", "null", "0"]) {
      expect(resolveInitialClubId(OK_RESULT, malformed)).toBeNull();
    }
  });

  it("never repairs, trims or normalizes the query value", () => {
    // A near-miss stays a miss: matching is exact identity, not resemblance.
    expect(resolveInitialClubId(OK_RESULT, ` ${SECOND_ID} `)).toBeNull();
    expect(resolveInitialClubId(OK_RESULT, SECOND_ID.toUpperCase())).toBeNull();
  });

  it("returns null for every non-ok result, even with a well-formed id", () => {
    for (const result of NON_OK_RESULTS) {
      expect(resolveInitialClubId(result, SECOND_ID)).toBeNull();
    }
  });

  it("does not fall back to the first club", () => {
    expect(resolveInitialClubId(OK_RESULT, ABSENT_ID)).not.toBe(PRIMARY_ID);
    expect(resolveInitialClubId(OK_RESULT, null)).not.toBe(PRIMARY_ID);
  });

  it("does not fall back to the primary club", () => {
    const primaryLast: SavedClubsResult = {
      status: "ok",
      clubs: [club(SECOND_ID), club(PRIMARY_ID, { isPrimary: true })],
    };
    expect(resolveInitialClubId(primaryLast, ABSENT_ID)).toBeNull();
    expect(resolveInitialClubId(primaryLast, null)).toBeNull();
  });

  it("does not auto-select the only club in a one-club bag", () => {
    const single: SavedClubsResult = { status: "ok", clubs: [club(SECOND_ID)] };
    expect(resolveInitialClubId(single, null)).toBeNull();
    expect(resolveInitialClubId(single, ABSENT_ID)).toBeNull();
  });
});

// ─── Behavioural: isSelectionStillValid ──────────────────────────────────────

describe("isSelectionStillValid — submission-time revalidation", () => {
  it("is true only for an exact id present in an ok result", () => {
    expect(isSelectionStillValid(OK_RESULT, SECOND_ID)).toBe(true);
    expect(isSelectionStillValid(OK_RESULT, PRIMARY_ID)).toBe(true);
    expect(isSelectionStillValid(OK_RESULT, THIRD_ID)).toBe(true);
  });

  it("is false for an id that has left the active bag", () => {
    // The archive case: the club was selectable when the page loaded and is
    // simply absent from the fresh result.
    expect(isSelectionStillValid(OK_RESULT, ABSENT_ID)).toBe(false);
  });

  it("is false for every non-ok status", () => {
    for (const result of NON_OK_RESULTS) {
      expect(isSelectionStillValid(result, SECOND_ID)).toBe(false);
    }
  });

  it("fails closed rather than substituting another club", () => {
    // It returns a boolean, never a replacement id, so there is no shape in
    // which it could silently swap equipment.
    expect(typeof isSelectionStillValid(OK_RESULT, ABSENT_ID)).toBe("boolean");
  });
});

// ─── Structural: shared foundations are reused, not reimplemented ────────────

describe("EQ3-S1 Analyze — reuses the shared saved-club foundations", () => {
  it("imports the one saved-club reader rather than querying user_equipment itself", () => {
    expect(analyzeSource).toContain("querySavedClubs");
    expect(analyzeSource).toContain('from "@/lib/equipment/saved-clubs"');
    // No second query implementation may appear in the page.
    expect(analyzeSource).not.toContain("user_equipment");
    expect(analyzeSource).not.toContain("is_archived");
  });

  it("imports the shared ClubSelector rather than building another picker", () => {
    expect(analyzeSource).toContain(
      'import ClubSelector from "@/components/equipment/ClubSelector"'
    );
    expect(analyzeSource).toContain("<ClubSelector");
    expect(analyzeSource).not.toContain("<select");
    expect(analyzeSource).not.toContain("<optgroup");
  });

  it("imports the pure selection helpers", () => {
    expect(analyzeSource).toContain("resolveInitialClubId");
    expect(analyzeSource).toContain("isSelectionStillValid");
    expect(analyzeSource).toContain('from "@/lib/equipment/analyze-club-selection"');
  });

  it("reads the club_id hint through the App Router search params", () => {
    expect(analyzeSource).toContain('import { useSearchParams } from "next/navigation"');
    expect(analyzeSource).toContain('searchParams.get("club_id")');
  });
});

// ─── Structural: one stable managed client ───────────────────────────────────

describe("EQ3-S1 Analyze — one stable managed browser client", () => {
  it("creates the client exactly once, lazily, in a ref", () => {
    expect(analyzeSource.match(/createClient\(\)/g) ?? []).toHaveLength(1);
    expect(analyzeSource).toContain("supabaseRef.current = createClient();");
    expect(analyzeSource).toMatch(/const\s+supabase\s*=\s*supabaseRef\.current/);
  });

  it("does not use a memo as the owner of that client", () => {
    // A memo is a cache the runtime may discard, which would hand the selector
    // load and the submission two different clients.
    expect(analyzeSource).not.toContain("useMemo");
  });

  it("keeps the managed factory and adds no alternative auth path", () => {
    expect(analyzeSource).toContain('import { createClient } from "@/utils/supabase/client"');
    expect(analyzeSource).not.toContain("@/utils/supabase/server");
    expect(analyzeSource).not.toContain("getServerSession");
    expect(analyzeSource).not.toContain("service_role");
    expect(analyzeSource).not.toContain("SERVICE_ROLE");
  });

  it("loads the selector through that same binding", () => {
    expect(initSource).toContain("querySavedClubs(supabase, { userId: clubsUserId })");
    expect(initSource).toContain("await supabase.auth.getSession()");
  });
});

// ─── Structural: initialization has no auto-selection ────────────────────────

describe("EQ3-S1 Analyze — initialization selects nothing on its own", () => {
  it("starts with a null selection and a loading-distinct clubs state", () => {
    expect(analyzeSource).toMatch(
      /const\s+\[selectedClubId,\s*setSelectedClubId\]\s*=\s*useState<string \| null>\(null\)/
    );
    expect(analyzeSource).toMatch(
      /useState<SavedClubsResult \| null>\(null\)/
    );
  });

  it("applies the URL hint at most once", () => {
    expect(initSource).toContain("clubHintApplied");
    expect(initSource).toMatch(/if\s*\(!clubHintApplied\.current\)/);
    expect(initSource).toContain("clubHintApplied.current = true;");
  });

  it("only ever sets a selection that the helper returned", () => {
    expect(initSource).toContain("resolveInitialClubId(result, searchParams.get(\"club_id\"))");
    expect(initSource).toMatch(/if\s*\(hinted\s*!==\s*null\)\s*setSelectedClubId\(hinted\)/);
  });

  it("contains no primary, first-club or first-group fallback", () => {
    expect(initSource).not.toContain("isPrimary");
    expect(initSource).not.toContain("clubs[0]");
    expect(initSource).not.toContain(".find(");
  });

  it("cancels a stale async load instead of writing to an unmounted page", () => {
    expect(initSource).toContain("let cancelled = false;");
    expect(initSource).toContain("if (cancelled) return;");
    expect(initSource).toContain("cancelled = true;");
  });
});

// ─── Structural: submission ordering, isolated to startAnalysis ──────────────

describe("EQ3-S1 Analyze — submission order and the club revalidation step", () => {
  const anchors = {
    preprocessing: "await getTrimmedBlob()",
    session: "await supabase.auth.getSession()",
    revalidation: "querySavedClubs(supabase, { userId })",
    storage: ".from(BUCKET).upload(",
    videos: '.from("swing_videos")',
    analysis: '.from("swing_analysis")',
    api: 'fetch("/api/analyze-swing"',
  } as const;

  function at(anchor: string): number {
    const index = submissionSource.indexOf(anchor);
    expect(index, `expected startAnalysis to contain: ${anchor}`).toBeGreaterThan(-1);
    return index;
  }

  it("runs preprocessing, then session resolution, then the club re-check", () => {
    expect(at(anchors.preprocessing)).toBeLessThan(at(anchors.session));
    expect(at(anchors.session)).toBeLessThan(at(anchors.revalidation));
  });

  it("places the session-failure guard before the club re-check", () => {
    const guard = submissionSource.search(
      /if\s*\(\s*sessionError\s*\|\|\s*!session\s*\|\|\s*!userId\s*\)\s*throw/
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(at(anchors.revalidation));
  });

  it("re-checks the club before Storage and before any row is written", () => {
    const revalidation = at(anchors.revalidation);
    expect(revalidation).toBeLessThan(at(anchors.storage));
    expect(revalidation).toBeLessThan(at(anchors.videos));
    expect(revalidation).toBeLessThan(at(anchors.analysis));
    expect(revalidation).toBeLessThan(at(anchors.api));
  });

  it("preserves Storage, swing_videos, swing_analysis and the API in order", () => {
    expect(at(anchors.storage)).toBeLessThan(at(anchors.videos));
    expect(at(anchors.videos)).toBeLessThan(at(anchors.analysis));
    expect(at(anchors.analysis)).toBeLessThan(at(anchors.api));
  });

  it("only re-checks when a club is actually selected", () => {
    expect(submissionSource).toMatch(/if\s*\(selectedClubId\s*!==\s*null\)/);
  });

  it("throws fixed copy before Storage when the club is gone", () => {
    const failure = submissionSource.indexOf("throw new Error(CLUB_UNAVAILABLE_MESSAGE)");
    expect(failure).toBeGreaterThan(-1);
    expect(failure).toBeLessThan(at(anchors.storage));
    expect(submissionSource).toMatch(
      /if\s*\(!isSelectionStillValid\(currentClubs,\s*selectedClubId\)\)/
    );
  });

  it("never substitutes, clears to primary, or silently continues with no club", () => {
    expect(submissionSource).not.toContain("isPrimary");
    expect(submissionSource).not.toContain("clubs[0]");
    expect(submissionSource).not.toContain("setSelectedClubId");
  });
});

// ─── Structural: what the client writes, and what it must not ────────────────

describe("EQ3-S1 Analyze — the client writes club_id and nothing else the DB owns", () => {
  it("declares validatedClubId as a nullable id that starts null", () => {
    expect(submissionSource).toMatch(
      /let\s+validatedClubId:\s*string\s*\|\s*null\s*=\s*null;/
    );
    expect(submissionSource).toMatch(/validatedClubId\s*=\s*selectedClubId;/);
  });

  it("writes exactly club_id: validatedClubId on the swing_analysis insert", () => {
    expect(submissionSource).toMatch(/club_id:\s*validatedClubId,/);
    expect(submissionSource).toMatch(/swing_video_id:\s*videoRow\.id,/);
    expect(submissionSource).toMatch(/status:\s*"pending",/);
  });

  it("never writes the DB-authored equipment fields", () => {
    expect(analyzeSource).not.toContain("analysis_family");
    expect(analyzeSource).not.toContain("equipment_snapshot");
  });

  it("does not send club_id to the analysis API", () => {
    expect(submissionSource).toContain("JSON.stringify({ analysisId: analysisRow.id })");
    const bodyIdx = submissionSource.indexOf("JSON.stringify({ analysisId");
    expect(submissionSource.slice(bodyIdx, bodyIdx + 200)).not.toContain("club_id");
  });

  it("no longer renders raw database text when the analysis insert fails", () => {
    // DB0 can now legitimately refuse this insert during the final archive
    // race, so its reason must not become golfer-facing copy.
    expect(submissionSource).toContain("throw new Error(ANALYSIS_CREATE_FAILED_MESSAGE)");
    expect(analyzeSource).toContain("We couldn't create this analysis. Please try again.");
    expect(submissionSource).not.toContain("Failed to create analysis record: $");
  });
});

// ─── Structural: loading and failure are never an empty bag ──────────────────

describe("EQ3-S1 Analyze — truthful selector states", () => {
  it("renders a loading state instead of an empty club list", () => {
    expect(analyzeSource).toContain("Loading your bag…");
    expect(analyzeSource).toMatch(/savedClubs\s*===\s*null\s*\?/);
  });

  it("distinguishes an auth failure from an empty bag", () => {
    expect(analyzeSource).toContain(
      "We couldn't confirm your session, so your clubs aren't available. You can still analyze without a club."
    );
    expect(analyzeSource).toMatch(/savedClubs\.status\s*===\s*"auth_error"/);
  });

  it("uses one safe message for database and malformed-data failures", () => {
    expect(analyzeSource).toContain(
      "We couldn't load your clubs right now. You can still analyze without a club."
    );
    expect(analyzeSource).toMatch(/savedClubs\.status\s*===\s*"database_error"/);
    expect(analyzeSource).toMatch(/savedClubs\.status\s*===\s*"malformed_data"/);
  });

  it("passes the real club list to the selector, so an empty bag stays truthful", () => {
    expect(analyzeSource).toMatch(/clubs=\{savedClubs\.clubs\}/);
    expect(analyzeSource).not.toMatch(/clubs=\{\[\]\}/);
  });

  it("keeps club selection optional", () => {
    expect(analyzeSource).toContain("Optional");
    expect(analyzeSource).not.toContain("allowEmpty={false}");
  });

  it("places the club panel first inside the right results deck", () => {
    const marker = analyzeSource.indexOf("RIGHT: Results deck");
    expect(marker).toBeGreaterThan(-1);
    const deckDiv = analyzeSource.indexOf(
      '<div className="flex-1 bg-[#12140F] overflow-y-auto">',
      marker
    );
    expect(deckDiv).toBeGreaterThan(marker);
    const clubPanel = analyzeSource.indexOf("Club Context Panel", deckDiv);
    const launchMonitor = analyzeSource.indexOf("Launch Monitor Panel", deckDiv);
    expect(clubPanel).toBeGreaterThan(deckDiv);
    expect(clubPanel).toBeLessThan(launchMonitor);
    // Nothing may sit between the marker and the deck's own opening div.
    expect(analyzeSource.slice(marker, deckDiv)).not.toContain("ClubSelector");
  });
});

// ─── Behavioural: isPuttingCapturePresentation (EQ3-S2) ──────────────────────

describe("isPuttingCapturePresentation — classifies the selection, nothing more", () => {
  it("is false while the bag is still loading, whatever is selected", () => {
    expect(isPuttingCapturePresentation(null, THIRD_ID)).toBe(false);
    expect(isPuttingCapturePresentation(null, PRIMARY_ID)).toBe(false);
    expect(isPuttingCapturePresentation(null, null)).toBe(false);
  });

  it("is false when nothing is selected", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, null)).toBe(false);
  });

  it("is false for every non-Putter club type", () => {
    const nonPutters: SelectableClub["clubType"][] = [
      "Driver",
      "Wood",
      "Hybrid",
      "Iron",
      "Wedge",
    ];
    for (const clubType of nonPutters) {
      const result: SavedClubsResult = {
        status: "ok",
        clubs: [club(SECOND_ID, { clubType })],
      };
      expect(
        isPuttingCapturePresentation(result, SECOND_ID),
        `${clubType} must not produce putting capture presentation`,
      ).toBe(false);
    }
  });

  it("is false for the Driver and Iron already in the shared fixture", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, PRIMARY_ID)).toBe(false);
    expect(isPuttingCapturePresentation(OK_RESULT, SECOND_ID)).toBe(false);
  });

  it("is true only for the exact saved Putter that is selected", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, THIRD_ID)).toBe(true);
  });

  it("is false for an id that is not in the result", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, ABSENT_ID)).toBe(false);
  });

  it("is false for every non-ok result, even when a Putter id is passed", () => {
    for (const result of NON_OK_RESULTS) {
      expect(
        isPuttingCapturePresentation(result, THIRD_ID),
        `${result.status} must never grant putting capture presentation`,
      ).toBe(false);
    }
  });

  it("returns to false when the golfer switches Putter to a non-Putter", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, THIRD_ID)).toBe(true);
    expect(isPuttingCapturePresentation(OK_RESULT, SECOND_ID)).toBe(false);
  });

  it("returns to false when the golfer clears the selection", () => {
    expect(isPuttingCapturePresentation(OK_RESULT, THIRD_ID)).toBe(true);
    expect(isPuttingCapturePresentation(OK_RESULT, null)).toBe(false);
  });

  it("never throws on any combination this page can produce", () => {
    const ids = [null, PRIMARY_ID, SECOND_ID, THIRD_ID, ABSENT_ID];
    const results: (SavedClubsResult | null)[] = [null, OK_RESULT, ...NON_OK_RESULTS];
    for (const result of results) {
      for (const id of ids) {
        expect(typeof isPuttingCapturePresentation(result, id)).toBe("boolean");
      }
    }
  });
});

// ─── Structural: EQ3-S2 desktop putting capture presentation ─────────────────

describe("EQ3-S2 Analyze — putting capture presentation is derived, never routed", () => {
  it("imports the shared classifier rather than re-deriving Putter inline", () => {
    expect(initSource).toContain("isPuttingCapturePresentation");
    expect(initSource).toContain("@/lib/equipment/analyze-club-selection");
    expect(initSource).toContain(
      "isPuttingCapturePresentation(savedClubs, selectedClubId)",
    );
  });

  it("gates capture presentation on there being no result yet", () => {
    // Two layers on purpose: the classifier answers "is a Putter selected",
    // the page answers "may that change the screen". Without the result guard,
    // moving the selector after an analysis would relabel a finished report.
    expect(initSource).toContain("const isPuttingCapture = selectedPutter && result === null;");
  });

  it("keeps every full-swing string exactly as it was", () => {
    expect(analyzeSource).toContain("Import Swing Video");
    expect(analyzeSource).toContain(
      "Use the trim handles in the timeline to isolate just the swing segment before analyzing.",
    );
    expect(analyzeSource).toContain(
      "Upload your swing video, trim to the impact zone, then hit Run Analyzer.",
    );
    expect(analyzeSource).toContain("RUN ANALYZER");
  });

  it("adds the exact putting capture copy", () => {
    expect(analyzeSource).toContain("Import Putting Stroke Video");
    expect(analyzeSource).toContain(
      "Use the trim handles in the timeline to isolate one complete putting stroke.",
    );
    expect(analyzeSource).toContain(
      "Upload your putting stroke video and trim to one complete stroke. AI putting analysis is coming soon.",
    );
  });

  it("hides the launch monitor input surface only for putting capture", () => {
    const panelIdx = analyzeSource.indexOf("── Launch Monitor Panel ──");
    const guardIdx = analyzeSource.indexOf("{!isPuttingCapture && (");
    const entitlementIdx = analyzeSource.indexOf("canUseLaunchMonitor(userTier)");
    expect(panelIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(panelIdx);
    expect(entitlementIdx).toBeGreaterThan(guardIdx);
    // The entitlement expression itself is untouched: the panel is hidden, not
    // granted or revoked, and no putting tier rule is introduced.
    expect(analyzeSource).toContain("canUseLaunchMonitor(userTier) ? (");
  });

  it("offers a Putter no executable analyzer action", () => {
    const branchIdx = analyzeSource.indexOf("isPuttingCapture ? (");
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    const branch = analyzeSource.slice(branchIdx, analyzeSource.indexOf(") : (", branchIdx));
    expect(branch).toContain("PUTTING ANALYSIS COMING SOON");
    expect(branch).toContain("disabled");
    expect(branch).not.toContain("onClick");
    expect(branch).not.toContain("startAnalysis");
  });

  it("leaves the full-swing analyzer action executable", () => {
    expect(analyzeSource).toContain("onClick={startAnalysis}");
  });
});
// ─── Structural: EQ3-S2 defence in depth ─────────────────────────────────────

describe("EQ3-S2 Analyze — a selected Putter can never enter the full-swing pipeline", () => {
  const guard = "isPuttingCapturePresentation(savedClubs, selectedClubId)";

  function at(anchor: string): number {
    const idx = submissionSource.indexOf(anchor);
    expect(idx, `startAnalysis is missing "${anchor}"`).toBeGreaterThanOrEqual(0);
    return idx;
  }

  it("refuses inside startAnalysis, not only in the rendered action", () => {
    expect(submissionSource).toContain(guard);
    expect(submissionSource).toContain("setError(PUTTING_ANALYSIS_UNAVAILABLE_MESSAGE)");
  });

  it("refuses before preprocessing", () => {
    expect(at(guard)).toBeLessThan(at("await getTrimmedBlob()"));
  });

  it("refuses before Storage", () => {
    expect(at(guard)).toBeLessThan(at("supabase.storage"));
  });

  it("refuses before both database inserts", () => {
    expect(at(guard)).toBeLessThan(at(String.raw`.from("swing_videos")`));
    expect(at(guard)).toBeLessThan(at(String.raw`.from("swing_analysis")`));
  });

  it("refuses before the analysis API call", () => {
    expect(at(guard)).toBeLessThan(at(String.raw`fetch("/api/analyze-swing"`));
  });

  it("uses fixed golfer-facing copy that explains rather than blames", () => {
    expect(analyzeSource).toContain(
      "Putting analysis is coming soon. To avoid an incorrect full-swing report, this putter video can't be analyzed yet.",
    );
  });
});
// ─── Structural: EQ3-S2 boundaries this slice must not cross ─────────────────

describe("EQ3-S2 — presentation only, no routing and no new surfaces", () => {
  it("never writes a routing field from the client", () => {
    expect(analyzeSource).not.toContain("analysis_family");
    expect(analyzeSource).not.toContain("swing_category");
  });

  it("keeps the analysis request body limited to the analysis id", () => {
    expect(submissionSource).toContain("JSON.stringify({ analysisId: analysisRow.id })");
  });

  it("keeps the existing club_id write and its revalidation", () => {
    expect(submissionSource).toContain("club_id:");
    expect(submissionSource).toContain("validatedClubId");
    expect(submissionSource).toContain("isSelectionStillValid(currentClubs, selectedClubId)");
  });

  it("introduces no canonical catalog query", () => {
    for (const table of [
      "equipment_models",
      "equipment_manufacturers",
      "equipment_putter_model_specs",
      "equipment_model_sources",
    ]) {
      expect(analyzeSource, `${table} must not be queried from Analyze`).not.toContain(table);
    }
  });

  it("keeps EQ4-S2 mobile capture out of the analysis and equipment contracts", () => {
    // EQ4-S2 has since added a mobile camera path, so the original
    // camera-absence ban is obsolete. What still matters is that capture stays
    // a client presentation concern: it must not reach the analysis API or
    // re-derive equipment, which is what this replacement pins.
    expect(analyzeApiSource).not.toContain("getUserMedia");
    expect(analyzeApiSource).not.toContain("MediaRecorder");
    expect(analyzeApiSource).toContain("analysisId: string;");
    expect(analyzeSource).toContain("@/lib/analyze-camera-capture");
  });

  it("leaves the analysis API untouched by putting presentation", () => {
    expect(analyzeApiSource).not.toContain("isPuttingCapturePresentation");
    expect(analyzeApiSource).not.toContain("PUTTING ANALYSIS COMING SOON");
    expect(analyzeApiSource).toContain("analysisId: string;");
  });

  it("leaves entitlement and model routing untouched", () => {
    expect(entitlementsSource).not.toContain("isPuttingCapturePresentation");
    expect(entitlementsSource).not.toContain("Putter");
    expect(analyzeSource).toContain("getAnalysisModeForTier");
  });
});

// ─── Structural: untouched boundaries ────────────────────────────────────────

describe("EQ3-S1 — boundaries this slice must not cross", () => {
  it("leaves the My Bag Get Fitting route exactly as it was", () => {
    expect(bagClientSource).toContain("router.push(`/analyze?club_id=${clubId}`)");
  });

  it("leaves the analysis API free of any club contract", () => {
    expect(analyzeApiSource).toContain("analysisId: string;");
    expect(analyzeApiSource).not.toContain("club_id");
    expect(analyzeApiSource).not.toContain("analysis_family");
    expect(analyzeApiSource).not.toContain("equipment_snapshot");
  });

  it("leaves DB0 as the database authority for the archive race", () => {
    expect(db0Source).toContain("and user_equipment.is_archived = false");
    expect(db0Source).toContain("for share;");
  });
});

// ─── Structural: EQ4-S1 mobile club selector placement ──────────────────────
describe("EQ4-S1 Analyze — mobile club selector placement", () => {
  const rootClass =
    'flex flex-col lg:h-screen lg:flex-row lg:overflow-hidden';
  const leftClass =
    'w-full lg:w-[600px] flex flex-col border-r border-white/10 bg-black flex-shrink-0 relative';
  const rightClass =
    'flex-1 bg-[#12140F] overflow-y-auto';
  const mobileMarker = "EQ4-S1 Mobile Club Context Panel";
  const desktopMarker = "{/* ── Club Context Panel ── */}";
  const launchMonitorMarker = "Launch Monitor Panel";
  const importAnchor = '<input type="file" accept="video/*" className="hidden"';

  function mobileBlock(): string {
    const leftIdx = analyzeSource.indexOf(leftClass);
    expect(leftIdx).toBeGreaterThanOrEqual(0);
    const markerIdx = analyzeSource.indexOf(mobileMarker, leftIdx);
    expect(markerIdx).toBeGreaterThan(leftIdx);
    const importIdx = analyzeSource.indexOf(importAnchor, markerIdx);
    expect(importIdx).toBeGreaterThan(markerIdx);
    return analyzeSource.slice(markerIdx, importIdx);
  }

  function desktopBlock(): string {
    const rightIdx = analyzeSource.indexOf(rightClass);
    expect(rightIdx).toBeGreaterThanOrEqual(0);
    const markerIdx = analyzeSource.indexOf(desktopMarker, rightIdx);
    expect(markerIdx).toBeGreaterThan(rightIdx);
    const launchIdx = analyzeSource.indexOf(launchMonitorMarker, markerIdx);
    expect(launchIdx).toBeGreaterThan(markerIdx);
    return analyzeSource.slice(markerIdx, launchIdx);
  }

  it("preserves the established stacked-mobile and row-desktop Analyze shell", () => {
    expect(analyzeSource).toContain(`<div className="${rootClass}">`);
    expect(analyzeSource).toContain(`<div className="${leftClass}">`);
    expect(analyzeSource).toContain(`<div className="${rightClass}">`);
  });

  it("places the mobile Club Context Panel inside the LEFT workspace before video import", () => {
    const leftIdx = analyzeSource.indexOf(leftClass);
    const mobileIdx = analyzeSource.indexOf(mobileMarker, leftIdx);
    const importIdx = analyzeSource.indexOf(importAnchor, leftIdx);

    expect(leftIdx).toBeGreaterThanOrEqual(0);
    expect(mobileIdx).toBeGreaterThan(leftIdx);
    expect(importIdx).toBeGreaterThan(mobileIdx);
    expect(mobileBlock()).toContain('className="lg:hidden border-b border-white/5 p-4"');
  });

  it("keeps the desktop Club Context Panel in the RIGHT deck and hides it below lg", () => {
    const rightIdx = analyzeSource.indexOf(rightClass);
    const desktopIdx = analyzeSource.indexOf(desktopMarker, rightIdx);
    const launchIdx = analyzeSource.indexOf(launchMonitorMarker, desktopIdx);

    expect(rightIdx).toBeGreaterThanOrEqual(0);
    expect(desktopIdx).toBeGreaterThan(rightIdx);
    expect(launchIdx).toBeGreaterThan(desktopIdx);
    expect(desktopBlock()).toContain(
      'className="hidden lg:block border-b border-white/5 p-4"',
    );
  });

  it("renders exactly two responsive presentations of the shared ClubSelector", () => {
    expect(analyzeSource.match(/<ClubSelector\b/g) ?? []).toHaveLength(2);
    expect(mobileBlock().match(/<ClubSelector\b/g) ?? []).toHaveLength(1);
    expect(desktopBlock().match(/<ClubSelector\b/g) ?? []).toHaveLength(1);
    expect(mobileBlock()).toContain("lg:hidden");
    expect(desktopBlock()).toContain("hidden lg:block");
    expect(analyzeSource).not.toContain("<select");
    expect(analyzeSource).not.toContain("<optgroup");
  });

  it("binds both presentations to the same optional club data and state", () => {
    for (const block of [mobileBlock(), desktopBlock()]) {
      expect(block).toContain("Optional — analyze with or without one");
      expect(block).toContain("clubs={savedClubs.clubs}");
      expect(block).toContain("selectedClubId={selectedClubId}");
      expect(block).toContain("onChange={setSelectedClubId}");
      expect(block).toContain("disabled={isAnalyzing}");
      expect(block).toContain('label="Club used for this swing"');
      expect(block).not.toContain("allowEmpty={false}");
    }
  });

  it("keeps selection and saved-club loading single-owner while preserving submission revalidation", () => {
    expect(
      analyzeSource.match(
        /const\s+\[selectedClubId,\s*setSelectedClubId\]\s*=\s*useState<string \| null>\(null\)/g,
      ) ?? [],
    ).toHaveLength(1);

    expect(
      initSource.match(
        /querySavedClubs\(supabase,\s*\{\s*userId:\s*clubsUserId\s*\}\)/g,
      ) ?? [],
    ).toHaveLength(1);

    expect(
      submissionSource.match(
        /querySavedClubs\(supabase,\s*\{\s*userId\s*\}\)/g,
      ) ?? [],
    ).toHaveLength(1);

    expect(initSource).toContain(
      'resolveInitialClubId(result, searchParams.get("club_id"))',
    );
  });

  it("preserves file import, full-swing copy, putting presentation, and the fail-closed Putter path", () => {
    expect(analyzeSource).toContain(importAnchor);
    expect(analyzeSource).toContain("Import Swing Video");
    expect(analyzeSource).toContain("Import Putting Stroke Video");
    expect(analyzeSource).toContain(
      "Use the trim handles in the timeline to isolate one complete putting stroke.",
    );
    expect(analyzeSource).toContain("PUTTING ANALYSIS COMING SOON");

    const puttingBranchIdx = analyzeSource.indexOf("isPuttingCapture ? (");
    expect(puttingBranchIdx).toBeGreaterThanOrEqual(0);
    const puttingBranchEnd = analyzeSource.indexOf(") : (", puttingBranchIdx);
    expect(puttingBranchEnd).toBeGreaterThan(puttingBranchIdx);
    const puttingBranch = analyzeSource.slice(puttingBranchIdx, puttingBranchEnd);
    expect(puttingBranch).toContain("disabled");
    expect(puttingBranch).not.toContain("onClick");

    const guard = submissionSource.indexOf(
      "isPuttingCapturePresentation(savedClubs, selectedClubId)",
    );
    const preprocessing = submissionSource.indexOf("await getTrimmedBlob()");
    const storage = submissionSource.indexOf("supabase.storage");
    const videos = submissionSource.indexOf('.from("swing_videos")');
    const analysis = submissionSource.indexOf('.from("swing_analysis")');
    const api = submissionSource.indexOf('fetch("/api/analyze-swing"');

    for (const idx of [guard, preprocessing, storage, videos, analysis, api]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }

    expect(guard).toBeLessThan(preprocessing);
    expect(guard).toBeLessThan(storage);
    expect(guard).toBeLessThan(videos);
    expect(guard).toBeLessThan(analysis);
    expect(guard).toBeLessThan(api);
  });

  it("still never writes the DB-authored routing fields from the client", () => {
    // The camera bans that used to live here retired with EQ4-S2. These two
    // did not: analysis_family and equipment_snapshot are database-authored,
    // and a client write would silently claim authority it does not have.
    expect(analyzeSource).not.toContain("analysis_family");
    expect(analyzeSource).not.toContain("equipment_snapshot");
  });
});
