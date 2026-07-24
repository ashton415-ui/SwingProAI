import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// Independently transcribed — not read from any page file or shared
// constant — so a regression in the actual pages is caught here rather
// than only self-confirmed against its own source.
const TABLE_PAGES: { route: string; file: string; minWidth: string; hasEmptyState: boolean; emptyStateText: string }[] = [
  { route: "/coach/golfers", file: "app/(dashboard)/coach/golfers/page.tsx", minWidth: "min-w-[640px]", hasEmptyState: true, emptyStateText: "No active golfers yet" },
  { route: "/admin/users", file: "app/(dashboard)/admin/users/page.tsx", minWidth: "min-w-[760px]", hasEmptyState: false, emptyStateText: "" },
  { route: "/admin/coaches", file: "app/(dashboard)/admin/coaches/page.tsx", minWidth: "min-w-[680px]", hasEmptyState: true, emptyStateText: "No coaches yet" },
  { route: "/admin/swings", file: "app/(dashboard)/admin/swings/page.tsx", minWidth: "min-w-[760px]", hasEmptyState: true, emptyStateText: "No videos yet" },
];

/**
 * Minimal balanced-JSX scanner. Given source text and the index of a
 * `<table` occurrence, walks *backward* through the preceding sibling/
 * ancestor `<div className="...">` open-tags to find:
 *  - the nearest wrapper (the intended scroll wrapper), and
 *  - the outer rounded card wrapper (2 levels up in the known page shape).
 *
 * This intentionally does not use a full HTML/JSX parser (none is a
 * project dependency) — instead it extracts every `<div className="...">`
 * tag that appears before the `<table`, in document order, and returns
 * their className strings innermost-first. For the known, flat structure
 * of these four pages (card > [empty-state ternary] > scroll-wrapper >
 * table), the two innermost preceding div tags are exactly the scroll
 * wrapper and the outer card, respectively.
 */
function precedingDivClassNames(source: string, tableIndex: number): string[] {
  const before = source.slice(0, tableIndex);
  const divTagPattern = /<div className="([^"]*)"/g;
  const classNames: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = divTagPattern.exec(before)) !== null) {
    classNames.push(match[1]);
  }
  // innermost (closest to <table) first
  return classNames.reverse();
}

function findSingleTableIndex(source: string): number {
  const pattern = /<table\b/g;
  const indices: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    indices.push(match.index);
  }
  expect(indices.length, `expected exactly one <table in source, found ${indices.length}`).toBe(1);
  return indices[0];
}

describe("responsive page content — coach/admin table scroll wrappers", () => {
  it.each(TABLE_PAGES)("$route ($file) exists on disk", ({ file }) => {
    expect(existsSync(path.join(repoRoot, file)), `missing file: ${file}`).toBe(true);
  });

  it.each(TABLE_PAGES)("$route contains exactly one live <table element", ({ file }) => {
    const source = readSource(file);
    findSingleTableIndex(source); // throws/asserts internally if not exactly one
  });

  it.each(TABLE_PAGES)("$route table retains w-full and text-left", ({ file }) => {
    const source = readSource(file);
    const tableIdx = findSingleTableIndex(source);
    const tableTagMatch = source.slice(tableIdx).match(/^<table[\s\S]*?>/);
    expect(tableTagMatch, `${file}: could not isolate the <table ...> opening tag`).not.toBeNull();
    const classMatch = tableTagMatch![0].match(/className="([^"]*)"/);
    expect(classMatch, `${file}: <table> has no className`).not.toBeNull();
    const tokens = classMatch![1].split(/\s+/).filter(Boolean);
    expect(tokens, `${file}: <table> missing w-full`).toContain("w-full");
    expect(tokens, `${file}: <table> missing text-left`).toContain("text-left");
  });

  it.each(TABLE_PAGES)("$route table contains its independently expected min-width token", ({ file, minWidth }) => {
    const source = readSource(file);
    const tableIdx = findSingleTableIndex(source);
    const tableTagMatch = source.slice(tableIdx).match(/^<table[\s\S]*?>/);
    expect(tableTagMatch, `${file}: could not isolate the <table ...> opening tag`).not.toBeNull();
    const classMatch = tableTagMatch![0].match(/className="([^"]*)"/);
    const tokens = classMatch![1].split(/\s+/).filter(Boolean);
    expect(tokens, `${file}: expected table min-width token "${minWidth}"`).toContain(minWidth);
  });

  it.each(TABLE_PAGES)("$route table is enclosed by an immediate wrapper with overflow-x-auto and w-full", ({ file }) => {
    const source = readSource(file);
    const tableIdx = findSingleTableIndex(source);
    const precedingDivs = precedingDivClassNames(source, tableIdx);
    expect(precedingDivs.length, `${file}: expected at least one <div> wrapping the table`).toBeGreaterThan(0);

    const innermost = precedingDivs[0];
    const innermostTokens = innermost.split(/\s+/).filter(Boolean);
    expect(innermostTokens, `${file}: innermost wrapper around <table> is missing overflow-x-auto — found "${innermost}"`).toContain("overflow-x-auto");
    expect(innermostTokens, `${file}: innermost wrapper around <table> is missing w-full — found "${innermost}"`).toContain("w-full");

    // Reject a regression where the scroll wrapper's own overflow-x-auto
    // was accidentally applied to the *outer* card instead of a real,
    // separate inner wrapper (i.e. only one preceding div exists and it's
    // reused as both the card and the scroll wrapper).
    expect(precedingDivs.length, `${file}: expected a distinct scroll wrapper AND a distinct outer card div, found only ${precedingDivs.length} preceding <div>`).toBeGreaterThanOrEqual(2);
  });

  it.each(TABLE_PAGES)("$route outer rounded card retains overflow-hidden (not replaced by overflow-x-auto)", ({ file }) => {
    const source = readSource(file);
    const tableIdx = findSingleTableIndex(source);
    const precedingDivs = precedingDivClassNames(source, tableIdx);
    expect(precedingDivs.length, `${file}: expected an outer card <div> before the scroll wrapper`).toBeGreaterThanOrEqual(2);

    // The outer card is the *outermost* of the two divs we care about —
    // walk from the end (furthest from <table>, i.e. declared first in
    // source) looking for the rounded-card signature (overflow-hidden +
    // a rounded-* token), which must NOT be the same div as the scroll
    // wrapper (must not itself carry overflow-x-auto).
    const outerCard = precedingDivs.find((cls) => {
      const tokens = cls.split(/\s+/).filter(Boolean);
      return tokens.includes("overflow-hidden") && tokens.some((t) => t.startsWith("rounded-"));
    });
    expect(outerCard, `${file}: no ancestor <div> found carrying both overflow-hidden and a rounded-* token — has the outer card's overflow behavior been replaced?`).toBeDefined();

    const outerCardTokens = outerCard!.split(/\s+/).filter(Boolean);
    expect(outerCardTokens, `${file}: outer card must not itself carry overflow-x-auto (that belongs only on the inner scroll wrapper)`).not.toContain("overflow-x-auto");
  });

  it.each(TABLE_PAGES.filter((p) => p.hasEmptyState))("$route empty-state text remains present", ({ file, emptyStateText }) => {
    const source = readSource(file);
    expect(source, `${file}: expected empty-state text "${emptyStateText}" to remain present`).toContain(emptyStateText);
  });

  it.each(TABLE_PAGES)("$route: no stray overflow-x-hidden or w-screen was introduced", ({ file }) => {
    const source = readSource(file);
    expect(source, `${file}: unexpected overflow-x-hidden`).not.toContain("overflow-x-hidden");
    expect(source, `${file}: unexpected w-screen`).not.toContain("w-screen");
  });
});

// ============================================================================
// VirtualBag — touch-accessible row actions (RW2-S2)
// ============================================================================

// Independently defined — not imported from the component — so a regression
// in VirtualBag.tsx is caught here rather than only self-confirmed against
// its own source.
const VIRTUAL_BAG_FILE = "components/swing/VirtualBag.tsx";

/**
 * Isolates the `ClubRow` function body from the rest of the file: from its
 * `function ClubRow(` declaration through the comment marker that precedes
 * the main `VirtualBag` component. This keeps every VirtualBag assertion
 * below scoped to the one row-level function under test, rather than
 * matching unrelated tokens anywhere else in the file (e.g. the header's
 * own "Add Club" button, which is unrelated to per-row actions).
 */
function isolateClubRowSource(source: string): string {
  const startMarker = "function ClubRow(";
  const endMarker = "// ── Main component";

  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${VIRTUAL_BAG_FILE}: could not locate "${startMarker}" to isolate ClubRow`).toBeGreaterThanOrEqual(0);

  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${VIRTUAL_BAG_FILE}: could not locate the "${endMarker}" marker after ClubRow to bound the isolation`).toBeGreaterThan(startIdx);

  return source.slice(startIdx, endIdx);
}

/**
 * Within an already-isolated ClubRow source, finds the nearest preceding
 * `<div className="...">` open tag before the `onFitting &&` conditional —
 * i.e. the actual action-row container, identified structurally rather than
 * by searching the whole file for the class string in isolation.
 */
function findActionContainerClassName(clubRowSource: string): string {
  const conditionalMarker = "onFitting &&";
  const conditionalIdx = clubRowSource.indexOf(conditionalMarker);
  expect(conditionalIdx, `${VIRTUAL_BAG_FILE}: could not find "${conditionalMarker}" inside ClubRow`).toBeGreaterThanOrEqual(0);

  const before = clubRowSource.slice(0, conditionalIdx);
  const divTagPattern = /<div className="([^"]*)"/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = divTagPattern.exec(before)) !== null) {
    lastMatch = match;
  }
  expect(lastMatch, `${VIRTUAL_BAG_FILE}: could not find a <div className="..."> preceding "${conditionalMarker}"`).not.toBeNull();
  return lastMatch![1];
}

describe("VirtualBag — touch-accessible row actions", () => {
  it("VirtualBag source file exists", () => {
    expect(existsSync(path.join(repoRoot, VIRTUAL_BAG_FILE)), `missing file: ${VIRTUAL_BAG_FILE}`).toBe(true);
  });

  it("ClubRow retains its normal flex-row structure and the group class", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const rootDivMatch = clubRow.match(/<div className="([^"]*)"/);
    expect(rootDivMatch, `${VIRTUAL_BAG_FILE}: could not find ClubRow's root row <div>`).not.toBeNull();
    const tokens = rootDivMatch![1].split(/\s+/).filter(Boolean);
    expect(tokens, `${VIRTUAL_BAG_FILE}: ClubRow root row missing "flex"`).toContain("flex");
    expect(tokens, `${VIRTUAL_BAG_FILE}: ClubRow root row missing "items-center"`).toContain("items-center");
    expect(tokens, `${VIRTUAL_BAG_FILE}: ClubRow root row missing "group"`).toContain("group");
  });

  it("the action container is independently identified as the nearest <div> preceding onFitting &&", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const actionContainerClass = findActionContainerClassName(clubRow);
    expect(actionContainerClass, `${VIRTUAL_BAG_FILE}: action container class unexpectedly empty`).toBeTruthy();
  });

  it("the action container contains flex, items-center, gap-1, shrink-0, and ml-1", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const actionContainerClass = findActionContainerClassName(clubRow);
    const tokens = actionContainerClass.split(/\s+/).filter(Boolean);
    for (const required of ["flex", "items-center", "gap-1", "shrink-0", "ml-1"]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: action container missing "${required}" — found "${actionContainerClass}"`).toContain(required);
    }
  });

  it("the action container does not contain opacity-0, invisible, hidden, pointer-events-none, or absolute", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const actionContainerClass = findActionContainerClassName(clubRow);
    const tokens = actionContainerClass.split(/\s+/).filter(Boolean);
    for (const forbidden of ["opacity-0", "invisible", "hidden", "pointer-events-none", "absolute"]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: action container unexpectedly contains "${forbidden}" — found "${actionContainerClass}"`).not.toContain(forbidden);
    }
  });

  it("ClubRow contains no hover-only visibility contract for the action group", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    for (const forbidden of ["group-hover:opacity-100", "group-hover:visible", "group-hover:block", "group-hover:flex"]) {
      expect(clubRow, `${VIRTUAL_BAG_FILE}: ClubRow unexpectedly still contains "${forbidden}"`).not.toContain(forbidden);
    }
    // Sanity check: this test must not reject the unrelated row-background
    // hover affordance, which is expected to remain untouched.
    expect(clubRow, `${VIRTUAL_BAG_FILE}: row background hover class unexpectedly removed`).toContain("hover:bg-white/[0.04]");
  });

  it("the fitting control remains conditional with exact callback wiring", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "{onFitting && ("`).toContain("{onFitting && (");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "onClick={onFitting}"`).toContain("onClick={onFitting}");
  });

  it("the removal control remains conditional with exact callback wiring", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "{onRemove && ("`).toContain("{onRemove && (");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "onClick={onRemove}"`).toContain("onClick={onRemove}");
  });

  it("the fitting button retains its title, accessible label, icon, visible text, and sm:inline behavior", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing fitting title`).toContain('title="AI shaft fitting"');
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing exact fitting aria-label`).toContain("aria-label={`Get AI shaft fitting for ${clubDisplayName(club)}`}");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing Zap icon on the fitting button`).toContain("<Zap className=");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing visible "Fit" text`).toContain(">Fit<");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "hidden sm:inline" on the Fit label`).toContain("hidden sm:inline");
  });

  it("the removal button retains its title, accessible label, and icon", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing removal title`).toContain('title="Remove from bag"');
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing exact removal aria-label`).toContain("aria-label={`Remove ${clubDisplayName(club)} from bag`}");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing Trash2 icon on the removal button`).toContain("<Trash2 className=");
  });
});
