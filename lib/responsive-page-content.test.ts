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

// ============================================================================
// AnalyzePage — responsive height and breakpoint repair (RW2-S3)
// ============================================================================

// Independently defined — not imported from the page — so a regression in
// AnalyzePage's source is caught here rather than only self-confirmed
// against its own layout.
const ANALYZE_PAGE_FILE = "app/(dashboard)/analyze/page.tsx";

/**
 * Locates the three top-level layout class strings in AnalyzePage's render
 * tree — the root split container, the LEFT video-workspace panel, and the
 * RIGHT results-deck panel — by walking a chain of unique source markers
 * (the "Render" section comment, then the LEFT/RIGHT panel comments) rather
 * than searching the whole file for class tokens in isolation. This keeps
 * every AnalyzePage layout assertion below scoped to the actual three
 * panels under test, and immune to unrelated nested `overflow-hidden`/
 * `<div className="...">` usages elsewhere in the file (loading overlays,
 * modals, drill cards, etc.).
 */
function getAnalyzePageLayoutClasses(source: string): { root: string; left: string; right: string } {
  const divPattern = /<div className="([^"]*)"/;

  const renderMarker = "─── Render";
  const renderIdx = source.indexOf(renderMarker);
  expect(renderIdx, `${ANALYZE_PAGE_FILE}: could not locate the "${renderMarker}" marker`).toBeGreaterThanOrEqual(0);

  const returnMarker = "return (";
  const returnIdx = source.indexOf(returnMarker, renderIdx);
  expect(returnIdx, `${ANALYZE_PAGE_FILE}: could not locate "${returnMarker}" after the render marker`).toBeGreaterThan(renderIdx);

  const rootMatch = source.slice(returnIdx).match(divPattern);
  expect(rootMatch, `${ANALYZE_PAGE_FILE}: could not find the root <div className="..."> after "${returnMarker}"`).not.toBeNull();
  const rootIdx = returnIdx + rootMatch!.index!;

  const leftMarker = "LEFT: Video workspace";
  const leftMarkerIdx = source.indexOf(leftMarker, rootIdx);
  expect(leftMarkerIdx, `${ANALYZE_PAGE_FILE}: could not locate the "${leftMarker}" marker after the root tag`).toBeGreaterThan(rootIdx);

  const leftMatch = source.slice(leftMarkerIdx).match(divPattern);
  expect(leftMatch, `${ANALYZE_PAGE_FILE}: could not find a <div className="..."> after the "${leftMarker}" marker`).not.toBeNull();
  const leftIdx = leftMarkerIdx + leftMatch!.index!;

  const rightMarker = "RIGHT: Results deck";
  const rightMarkerIdx = source.indexOf(rightMarker, leftIdx);
  expect(rightMarkerIdx, `${ANALYZE_PAGE_FILE}: could not locate the "${rightMarker}" marker after the left workspace tag`).toBeGreaterThan(leftIdx);

  const rightMatch = source.slice(rightMarkerIdx).match(divPattern);
  expect(rightMatch, `${ANALYZE_PAGE_FILE}: could not find a <div className="..."> after the "${rightMarker}" marker`).not.toBeNull();
  const rightIdx = rightMarkerIdx + rightMatch!.index!;

  // Order sanity — each marker/tag must appear strictly after the previous
  // one, proving the three panels were located in true document order.
  expect(rootIdx, `${ANALYZE_PAGE_FILE}: root tag out of expected order`).toBeLessThan(leftMarkerIdx);
  expect(leftIdx, `${ANALYZE_PAGE_FILE}: left workspace tag out of expected order`).toBeLessThan(rightMarkerIdx);

  return { root: rootMatch![1], left: leftMatch![1], right: rightMatch![1] };
}

describe("AnalyzePage — responsive height and breakpoint repair", () => {
  it("Analyze page source file exists", () => {
    expect(existsSync(path.join(repoRoot, ANALYZE_PAGE_FILE)), `missing file: ${ANALYZE_PAGE_FILE}`).toBe(true);
  });

  it("the layout helper uniquely locates the root, left workspace, and right results-deck class strings in source order", () => {
    const { root, left, right } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    expect(root, `${ANALYZE_PAGE_FILE}: root class unexpectedly empty`).toBeTruthy();
    expect(left, `${ANALYZE_PAGE_FILE}: left workspace class unexpectedly empty`).toBeTruthy();
    expect(right, `${ANALYZE_PAGE_FILE}: right results-deck class unexpectedly empty`).toBeTruthy();
  });

  it("root retains the base stacked flex structure", () => {
    const { root } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    const tokens = root.split(/\s+/).filter(Boolean);
    expect(tokens, `${ANALYZE_PAGE_FILE}: root missing "flex"`).toContain("flex");
    expect(tokens, `${ANALYZE_PAGE_FILE}: root missing "flex-col"`).toContain("flex-col");
  });

  it("root uses the desktop row split only at lg", () => {
    const { root } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    const tokens = root.split(/\s+/).filter(Boolean);
    expect(tokens, `${ANALYZE_PAGE_FILE}: root missing "lg:flex-row"`).toContain("lg:flex-row");
    expect(tokens, `${ANALYZE_PAGE_FILE}: root unexpectedly contains "md:flex-row"`).not.toContain("md:flex-row");
    expect(tokens, `${ANALYZE_PAGE_FILE}: root unexpectedly contains an unprefixed "flex-row"`).not.toContain("flex-row");
  });

  it("root no longer claims an unconditional full viewport height", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    const { root } = getAnalyzePageLayoutClasses(source);
    const tokens = root.split(/\s+/).filter(Boolean);
    expect(tokens, `${ANALYZE_PAGE_FILE}: root missing "lg:h-screen"`).toContain("lg:h-screen");
    expect(tokens, `${ANALYZE_PAGE_FILE}: root unexpectedly contains an unprefixed "h-screen"`).not.toContain("h-screen");
    expect(root, `${ANALYZE_PAGE_FILE}: root unexpectedly still contains "h-[calc(100vh-0px)]"`).not.toContain("h-[calc(100vh-0px)]");
    expect(source, `${ANALYZE_PAGE_FILE}: source unexpectedly still contains "h-[calc(100vh-0px)]" anywhere`).not.toContain("h-[calc(100vh-0px)]");
  });

  it("root clips overflow only at desktop, without rejecting legitimate nested overflow-hidden usages", () => {
    const { root } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    const tokens = root.split(/\s+/).filter(Boolean);
    expect(tokens, `${ANALYZE_PAGE_FILE}: root missing "lg:overflow-hidden"`).toContain("lg:overflow-hidden");
    expect(tokens, `${ANALYZE_PAGE_FILE}: root unexpectedly contains an unprefixed "overflow-hidden"`).not.toContain("overflow-hidden");
  });

  it("left video workspace follows the shell's lg breakpoint for its fixed width", () => {
    const { left } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    const tokens = left.split(/\s+/).filter(Boolean);
    expect(tokens, `${ANALYZE_PAGE_FILE}: left workspace missing "w-full"`).toContain("w-full");
    expect(tokens, `${ANALYZE_PAGE_FILE}: left workspace missing exact "lg:w-[600px]"`).toContain("lg:w-[600px]");
    expect(tokens, `${ANALYZE_PAGE_FILE}: left workspace unexpectedly contains "md:w-[600px]"`).not.toContain("md:w-[600px]");
  });

  it("left video workspace preserves its existing structural tokens", () => {
    const { left } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    const tokens = left.split(/\s+/).filter(Boolean);
    for (const required of ["flex", "flex-col", "border-r", "border-white/10", "bg-black", "flex-shrink-0", "relative"]) {
      expect(tokens, `${ANALYZE_PAGE_FILE}: left workspace missing "${required}" — found "${left}"`).toContain(required);
    }
  });

  it("right results deck remains unchanged", () => {
    const { right } = getAnalyzePageLayoutClasses(readSource(ANALYZE_PAGE_FILE));
    expect(right, `${ANALYZE_PAGE_FILE}: right results-deck class changed unexpectedly`).toBe("flex-1 bg-[#12140F] overflow-y-auto");
  });
});

// ============================================================================
// Telemetry page — portal header responsive stacking (RW2-S4)
// ============================================================================

// Independently defined — not imported from the page — so a regression in
// the telemetry page's source is caught here rather than only self-confirmed
// against its own layout.
const TELEMETRY_PAGE_FILE = "app/(dashboard)/telemetry/page.tsx";

/**
 * Isolates the telemetry portal header block: from the unique "Portal
 * header" comment marker through the unique "Summary stat bar" comment
 * marker that immediately follows it in source. This keeps every assertion
 * below scoped to the one header under test, rather than matching unrelated
 * `<div className="...">`/`<Link>` elements found later in the file (the
 * summary stat bar, timeline cards, empty states, etc.).
 */
function isolateTelemetryHeaderSource(source: string): string {
  const startMarker = "Portal header";
  const endMarker = "Summary stat bar";

  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${TELEMETRY_PAGE_FILE}: could not locate the "${startMarker}" marker`).toBeGreaterThanOrEqual(0);

  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${TELEMETRY_PAGE_FILE}: could not locate the "${endMarker}" marker after the portal header`).toBeGreaterThan(startIdx);

  return source.slice(startIdx, endIdx);
}

/** Within the isolated header source, extracts the header's own outer
 *  `<div className="...">` — the first such tag in the isolated block. */
function getTelemetryHeaderClassName(headerSource: string): string {
  const match = headerSource.match(/<div className="([^"]*)"/);
  expect(match, `${TELEMETRY_PAGE_FILE}: could not find the portal header's outer <div className="...">`).not.toBeNull();
  return match![1];
}

describe("Telemetry page — portal header responsive stacking", () => {
  it("Telemetry page source file exists", () => {
    expect(existsSync(path.join(repoRoot, TELEMETRY_PAGE_FILE)), `missing file: ${TELEMETRY_PAGE_FILE}`).toBe(true);
  });

  it("the helper uniquely locates the portal header", () => {
    const headerSource = isolateTelemetryHeaderSource(readSource(TELEMETRY_PAGE_FILE));
    const headerClass = getTelemetryHeaderClassName(headerSource);
    expect(headerClass, `${TELEMETRY_PAGE_FILE}: portal header class unexpectedly empty`).toBeTruthy();
  });

  it("the portal header contains the full required responsive-stacking token set", () => {
    const headerSource = isolateTelemetryHeaderSource(readSource(TELEMETRY_PAGE_FILE));
    const headerClass = getTelemetryHeaderClassName(headerSource);
    const tokens = headerClass.split(/\s+/).filter(Boolean);
    for (const required of ["flex", "flex-col", "md:flex-row", "md:items-center", "justify-between", "gap-4", "mb-8"]) {
      expect(tokens, `${TELEMETRY_PAGE_FILE}: portal header missing "${required}" — found "${headerClass}"`).toContain(required);
    }
  });

  it("the portal header does not regress to a row-only, non-stacking mobile layout", () => {
    const headerSource = isolateTelemetryHeaderSource(readSource(TELEMETRY_PAGE_FILE));
    const headerClass = getTelemetryHeaderClassName(headerSource);
    const tokens = headerClass.split(/\s+/).filter(Boolean);
    expect(tokens, `${TELEMETRY_PAGE_FILE}: portal header unexpectedly contains an unprefixed "flex-row"`).not.toContain("flex-row");
    expect(tokens, `${TELEMETRY_PAGE_FILE}: portal header missing "flex-col" — mobile stacking contract regressed`).toContain("flex-col");
  });

  it("the Range link remains present with its exact existing href and label", () => {
    const headerSource = isolateTelemetryHeaderSource(readSource(TELEMETRY_PAGE_FILE));
    expect(headerSource, `${TELEMETRY_PAGE_FILE}: missing Range link with href="/range"`).toContain('href="/range"');
    expect(headerSource, `${TELEMETRY_PAGE_FILE}: missing unchanged "Range" label`).toContain("/>Range");
  });

  it("the Analyze link remains present with its exact existing href and label", () => {
    const headerSource = isolateTelemetryHeaderSource(readSource(TELEMETRY_PAGE_FILE));
    expect(headerSource, `${TELEMETRY_PAGE_FILE}: missing Analyze link with href="/analyze"`).toContain('href="/analyze"');
    expect(headerSource, `${TELEMETRY_PAGE_FILE}: missing unchanged "Analyze" label`).toContain("/>Analyze");
  });

  it("no clipping workaround was introduced on the telemetry page", () => {
    const source = readSource(TELEMETRY_PAGE_FILE);
    expect(source, `${TELEMETRY_PAGE_FILE}: unexpected overflow-x-hidden`).not.toContain("overflow-x-hidden");
    expect(source, `${TELEMETRY_PAGE_FILE}: unexpected w-screen`).not.toContain("w-screen");
  });
});

// ============================================================================
// Goals / Add Club forms — mobile-safe input text sizing (RW2-S5)
// ============================================================================

// Independently defined — not imported from either form — so a regression
// in the actual source is caught here rather than only self-confirmed
// against its own layout.
const GOALS_FORM_FILE = "app/(dashboard)/goals/GoalsForm.tsx";
const ADD_CLUB_FORM_FILE = "app/(dashboard)/bag/add/AddClubForm.tsx";
const GOALS_PAGE_FILE = "app/(dashboard)/goals/page.tsx";
const ADD_CLUB_PAGE_FILE = "app/(dashboard)/bag/add/page.tsx";

/** Counts occurrences of the local `const inputCls =` declaration, without
 *  scanning the rest of the file for unrelated text-size tokens. */
function countInputClsDeclarations(source: string): number {
  const pattern = /const inputCls =/g;
  let count = 0;
  while (pattern.exec(source) !== null) count++;
  return count;
}

/** Extracts the exact quoted class string assigned to the local `inputCls`
 *  constant. Fails if the declaration is missing or duplicated, and never
 *  scans beyond the declaration's own assigned string. */
function extractInputCls(source: string, fileLabel: string): string {
  const declCount = countInputClsDeclarations(source);
  expect(declCount, `${fileLabel}: expected exactly one "const inputCls =" declaration, found ${declCount}`).toBe(1);

  const declIndex = source.indexOf("const inputCls =");
  expect(declIndex, `${fileLabel}: could not locate the "const inputCls =" declaration`).toBeGreaterThanOrEqual(0);

  const after = source.slice(declIndex);
  const valueMatch = after.match(/const inputCls =\s*"([^"]*)"/);
  expect(valueMatch, `${fileLabel}: could not extract the inputCls quoted class string`).not.toBeNull();
  return valueMatch![1];
}

describe("Goals form — mobile-safe input text sizing", () => {
  it("Goals form source file exists", () => {
    expect(existsSync(path.join(repoRoot, GOALS_FORM_FILE)), `missing file: ${GOALS_FORM_FILE}`).toBe(true);
  });

  it("Goals form contains exactly one inputCls declaration", () => {
    const count = countInputClsDeclarations(readSource(GOALS_FORM_FILE));
    expect(count, `${GOALS_FORM_FILE}: expected exactly one inputCls declaration`).toBe(1);
  });

  it("Goals inputCls contains text-base and lg:text-sm, with no unprefixed text-sm", () => {
    const cls = extractInputCls(readSource(GOALS_FORM_FILE), GOALS_FORM_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    expect(tokens, `${GOALS_FORM_FILE}: inputCls missing "text-base" — found "${cls}"`).toContain("text-base");
    expect(tokens, `${GOALS_FORM_FILE}: inputCls missing "lg:text-sm" — found "${cls}"`).toContain("lg:text-sm");
    expect(tokens, `${GOALS_FORM_FILE}: inputCls unexpectedly retains an unprefixed "text-sm" — found "${cls}"`).not.toContain("text-sm");
  });

  it("Goals inputCls retains all expected non-text-size tokens", () => {
    const cls = extractInputCls(readSource(GOALS_FORM_FILE), GOALS_FORM_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    for (const required of [
      "w-full", "bg-slate-800", "border", "border-white/10", "rounded-xl",
      "px-4", "py-3", "text-white", "placeholder:text-gray-600",
      "focus:outline-none", "focus:ring-1", "focus:ring-golf-green",
    ]) {
      expect(tokens, `${GOALS_FORM_FILE}: inputCls missing "${required}" — found "${cls}"`).toContain(required);
    }
  });

  it("the Goals inputCls constant remains applied to exactly the number input and the textarea", () => {
    const source = readSource(GOALS_FORM_FILE);
    const directUsages = (source.match(/className=\{inputCls\}/g) ?? []).length;
    const textareaUsages = (source.match(/className=\{`\$\{inputCls\} resize-none`\}/g) ?? []).length;
    expect(directUsages, `${GOALS_FORM_FILE}: expected exactly one direct className={inputCls} usage (the number input)`).toBe(1);
    expect(textareaUsages, `${GOALS_FORM_FILE}: expected exactly one className={\`\${inputCls} resize-none\`} usage (the textarea)`).toBe(1);
  });
});

describe("Add Club form — mobile-safe input text sizing", () => {
  it("Add Club form source file exists", () => {
    expect(existsSync(path.join(repoRoot, ADD_CLUB_FORM_FILE)), `missing file: ${ADD_CLUB_FORM_FILE}`).toBe(true);
  });

  it("Add Club form contains exactly one inputCls declaration", () => {
    const count = countInputClsDeclarations(readSource(ADD_CLUB_FORM_FILE));
    expect(count, `${ADD_CLUB_FORM_FILE}: expected exactly one inputCls declaration`).toBe(1);
  });

  it("Add Club inputCls contains text-base and lg:text-sm, with no unprefixed text-sm", () => {
    const cls = extractInputCls(readSource(ADD_CLUB_FORM_FILE), ADD_CLUB_FORM_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    expect(tokens, `${ADD_CLUB_FORM_FILE}: inputCls missing "text-base" — found "${cls}"`).toContain("text-base");
    expect(tokens, `${ADD_CLUB_FORM_FILE}: inputCls missing "lg:text-sm" — found "${cls}"`).toContain("lg:text-sm");
    expect(tokens, `${ADD_CLUB_FORM_FILE}: inputCls unexpectedly retains an unprefixed "text-sm" — found "${cls}"`).not.toContain("text-sm");
  });

  it("Add Club inputCls retains all expected non-text-size tokens", () => {
    const cls = extractInputCls(readSource(ADD_CLUB_FORM_FILE), ADD_CLUB_FORM_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    for (const required of [
      "w-full", "bg-slate-800", "border", "border-white/10", "rounded-xl",
      "px-4", "py-2.5", "text-white", "placeholder:text-gray-600",
      "focus:outline-none", "focus:ring-1", "focus:ring-indigo-500",
    ]) {
      expect(tokens, `${ADD_CLUB_FORM_FILE}: inputCls missing "${required}" — found "${cls}"`).toContain(required);
    }
  });

  it("the Add Club inputCls constant remains applied to exactly the two selects and four text/number inputs", () => {
    const source = readSource(ADD_CLUB_FORM_FILE);
    const directUsages = (source.match(/className=\{inputCls\}/g) ?? []).length;
    expect(directUsages, `${ADD_CLUB_FORM_FILE}: expected exactly six className={inputCls} usages (2 selects + 4 inputs)`).toBe(6);
  });

  it("checkbox controls remain separately styled and unaffected by the inputCls change", () => {
    const source = readSource(ADD_CLUB_FORM_FILE);
    const checkboxClass = "w-4 h-4 rounded border-white/20 bg-slate-800 accent-indigo-500";
    const checkboxUsages = (source.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxUsages, `${ADD_CLUB_FORM_FILE}: expected exactly two checkbox controls`).toBe(2);
    expect(
      source.split(checkboxClass).length - 1,
      `${ADD_CLUB_FORM_FILE}: checkbox className unexpectedly changed — expected "${checkboxClass}" to appear exactly twice`
    ).toBe(2);
    expect(checkboxClass, "checkbox className must not reference inputCls").not.toContain("inputCls");
    expect(checkboxClass, "checkbox className must not have gained text-base").not.toContain("text-base");
  });
});

describe("Goals / Add Club forms — no zoom restriction or overflow workaround introduced", () => {
  it("no viewport zoom restriction is introduced in either form or its page", () => {
    for (const file of [GOALS_FORM_FILE, ADD_CLUB_FORM_FILE, GOALS_PAGE_FILE, ADD_CLUB_PAGE_FILE]) {
      const source = readSource(file);
      expect(source, `${file}: unexpected maximumScale`).not.toContain("maximumScale");
      expect(source, `${file}: unexpected maximum-scale`).not.toContain("maximum-scale");
      expect(source, `${file}: unexpected user-scalable=no`).not.toContain("user-scalable=no");
    }
  });

  it("no overflow-x-hidden or w-screen workaround is introduced in either form", () => {
    for (const file of [GOALS_FORM_FILE, ADD_CLUB_FORM_FILE]) {
      const source = readSource(file);
      expect(source, `${file}: unexpected overflow-x-hidden`).not.toContain("overflow-x-hidden");
      expect(source, `${file}: unexpected w-screen`).not.toContain("w-screen");
    }
  });
});

// ============================================================================
// VirtualBag — ClubRow action button minimum touch targets (RW2-S6)
// ============================================================================

// Reuses VIRTUAL_BAG_FILE and isolateClubRowSource, already defined above in
// the RW2-S2 section — no duplicate file constant or isolation helper is
// introduced for the same component.

/**
 * Within an already-isolated ClubRow source, locates the unique <button>
 * opening tag whose onClick handler is the given callback marker (e.g.
 * "onClick={onFitting}"), and returns the complete opening tag text (from
 * "<button" through its closing ">"). Scoped to the actual interactive
 * <button> element — not its parent action-container <div> — by walking
 * backward from the unique callback marker to the nearest preceding
 * "<button", then forward to the tag's closing ">".
 *
 * None of the attribute values on these buttons (title, aria-label,
 * className) contain a literal ">" character, so the first ">" after the
 * callback marker is guaranteed to be the opening tag's own closer.
 */
function extractButtonOpeningTag(clubRowSource: string, callbackMarker: string, fileLabel: string): string {
  const markerOccurrences = clubRowSource.split(callbackMarker).length - 1;
  expect(markerOccurrences, `${fileLabel}: expected exactly one "${callbackMarker}" marker, found ${markerOccurrences}`).toBe(1);

  const markerIdx = clubRowSource.indexOf(callbackMarker);
  const tagStart = clubRowSource.lastIndexOf("<button", markerIdx);
  expect(tagStart, `${fileLabel}: could not find a preceding "<button" for "${callbackMarker}"`).toBeGreaterThanOrEqual(0);

  const tagEnd = clubRowSource.indexOf(">", markerIdx);
  expect(tagEnd, `${fileLabel}: could not find the closing ">" of the <button> opening tag for "${callbackMarker}"`).toBeGreaterThan(tagStart);

  return clubRowSource.slice(tagStart, tagEnd + 1);
}

/** Extracts the className value from an already-isolated <button> opening tag. */
function extractButtonClassName(buttonOpeningTag: string, fileLabel: string): string {
  const match = buttonOpeningTag.match(/className="([^"]*)"/);
  expect(match, `${fileLabel}: could not extract className from the <button> opening tag`).not.toBeNull();
  return match![1];
}

describe("VirtualBag — ClubRow action button minimum touch targets", () => {
  it("the Fit button opening tag is uniquely located via its onFitting callback", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onFitting}", VIRTUAL_BAG_FILE);
    expect(tag, `${VIRTUAL_BAG_FILE}: Fit button opening tag unexpectedly empty`).toBeTruthy();
  });

  it("the Remove button opening tag is uniquely located via its onRemove callback", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onRemove}", VIRTUAL_BAG_FILE);
    expect(tag, `${VIRTUAL_BAG_FILE}: Remove button opening tag unexpectedly empty`).toBeTruthy();
  });

  it("the Fit button carries min-h-11 and min-w-11 directly, alongside its full existing token set", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onFitting}", VIRTUAL_BAG_FILE);
    const cls = extractButtonClassName(tag, VIRTUAL_BAG_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    for (const required of [
      "flex", "min-h-11", "min-w-11", "items-center", "justify-center",
      "gap-1", "px-2", "py-1", "bg-indigo-600", "hover:bg-indigo-500",
      "text-white", "text-xs", "font-medium", "rounded-lg", "transition-colors",
    ]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: Fit button missing "${required}" — found "${cls}"`).toContain(required);
    }
  });

  it("the Remove button carries min-h-11 and min-w-11 directly, alongside its full existing token set", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onRemove}", VIRTUAL_BAG_FILE);
    const cls = extractButtonClassName(tag, VIRTUAL_BAG_FILE);
    const tokens = cls.split(/\s+/).filter(Boolean);
    for (const required of [
      "inline-flex", "min-h-11", "min-w-11", "items-center", "justify-center",
      "p-1.5", "text-slate-600", "hover:text-red-400", "transition-colors",
      "rounded-lg", "hover:bg-red-400/10",
    ]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: Remove button missing "${required}" — found "${cls}"`).toContain(required);
    }
  });

  it("the Fit button retains its exact title, aria-label, Zap icon size, and hidden sm:inline label", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onFitting}", VIRTUAL_BAG_FILE);
    expect(tag, `${VIRTUAL_BAG_FILE}: Fit button title changed`).toContain('title="AI shaft fitting"');
    expect(tag, `${VIRTUAL_BAG_FILE}: Fit button aria-label changed`).toContain("aria-label={`Get AI shaft fitting for ${clubDisplayName(club)}`}");

    const tagEndIdx = clubRow.indexOf(tag) + tag.length;
    const body = clubRow.slice(tagEndIdx, tagEndIdx + 200);
    expect(body, `${VIRTUAL_BAG_FILE}: Zap icon size changed`).toContain('<Zap className="w-3 h-3" />');
    expect(body, `${VIRTUAL_BAG_FILE}: Fit label lost "hidden sm:inline"`).toContain('<span className="hidden sm:inline">Fit</span>');
  });

  it("the Remove button retains its exact title, aria-label, and Trash2 icon size", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const tag = extractButtonOpeningTag(clubRow, "onClick={onRemove}", VIRTUAL_BAG_FILE);
    expect(tag, `${VIRTUAL_BAG_FILE}: Remove button title changed`).toContain('title="Remove from bag"');
    expect(tag, `${VIRTUAL_BAG_FILE}: Remove button aria-label changed`).toContain("aria-label={`Remove ${clubDisplayName(club)} from bag`}");

    const tagEndIdx = clubRow.indexOf(tag) + tag.length;
    const body = clubRow.slice(tagEndIdx, tagEndIdx + 100);
    expect(body, `${VIRTUAL_BAG_FILE}: Trash2 icon size changed`).toContain('<Trash2 className="w-3.5 h-3.5" />');
  });

  it("neither button opening tag introduces hidden, invisible, opacity-0, or hover-gated visibility", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const fitTag = extractButtonOpeningTag(clubRow, "onClick={onFitting}", VIRTUAL_BAG_FILE);
    const removeTag = extractButtonOpeningTag(clubRow, "onClick={onRemove}", VIRTUAL_BAG_FILE);
    for (const tag of [fitTag, removeTag]) {
      for (const forbidden of ["hidden", "invisible", "opacity-0", "group-hover:"]) {
        expect(tag, `${VIRTUAL_BAG_FILE}: unexpected "${forbidden}" on a button opening tag — found "${tag}"`).not.toContain(forbidden);
      }
    }
  });

  it("the action wrapper retains its exact class contract and did not receive the target-size classes", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    const wrapperClass = findActionContainerClassName(clubRow);
    const tokens = wrapperClass.split(/\s+/).filter(Boolean);
    for (const required of ["flex", "items-center", "gap-1", "shrink-0", "ml-1"]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: action wrapper missing "${required}" — found "${wrapperClass}"`).toContain(required);
    }
    for (const forbidden of ["min-h-11", "min-w-11"]) {
      expect(tokens, `${VIRTUAL_BAG_FILE}: minimum-target classes were incorrectly applied to the wrapper instead of the buttons`).not.toContain(forbidden);
    }
  });

  it("both buttons remain conditionally rendered with unchanged callback wiring", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "{onFitting && ("`).toContain("{onFitting && (");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "onClick={onFitting}"`).toContain("onClick={onFitting}");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "{onRemove && ("`).toContain("{onRemove && (");
    expect(clubRow, `${VIRTUAL_BAG_FILE}: missing "onClick={onRemove}"`).toContain("onClick={onRemove}");
  });

  it("no confirmation dialog or new deletion-confirmation flow was introduced", () => {
    const clubRow = isolateClubRowSource(readSource(VIRTUAL_BAG_FILE));
    for (const forbidden of ["confirm(", "window.confirm", "<Dialog", "<Modal"]) {
      expect(clubRow, `${VIRTUAL_BAG_FILE}: unexpected "${forbidden}" — a confirmation flow must not be introduced in this slice`).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// AnalyzePage — fail-closed browser preprocessing contract
//
// These are SOURCE/STATIC CONTRACT assertions. They prove the shape of the
// preprocessing code on the reachable /analyze route. They do NOT and cannot
// prove real browser behaviour — MediaRecorder/captureStream availability,
// mobile video decode, and physical device rendering remain separate
// real-device verification work.
// ============================================================================

/** Isolates the `getTrimmedBlob` implementation so assertions below cannot be
 *  satisfied (or tripped) by unrelated code elsewhere in the 800-line page. The
 *  body runs from the declaration to the start of the next top-level member,
 *  `dbRowToResult`, which immediately follows it in source order. */
function isolateGetTrimmedBlobSource(source: string): string {
  const startMarker = "const getTrimmedBlob";
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${ANALYZE_PAGE_FILE}: could not locate "${startMarker}"`).toBeGreaterThanOrEqual(0);

  const endMarker = "function dbRowToResult";
  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${ANALYZE_PAGE_FILE}: could not locate "${endMarker}" after "${startMarker}"`).toBeGreaterThan(startIdx);

  return source.slice(startIdx, endIdx);
}

/** Isolates the executable `preprocessingRequired` predicate — the parenthesized
 *  expression only, with `//` line comments stripped — so capability assertions
 *  test code rather than surrounding explanatory prose. */
function isolatePreprocessingRequiredPredicate(source: string): string {
  const block = isolateGetTrimmedBlobSource(source);
  const match = block.match(/const preprocessingRequired = !\(([\s\S]*?)\);/);
  expect(match, `${ANALYZE_PAGE_FILE}: could not locate the "const preprocessingRequired = !( … );" predicate`).not.toBeNull();
  return match![1]
    .split("\n")
    .map((line) => (line.indexOf("//") === -1 ? line : line.slice(0, line.indexOf("//"))))
    .join("\n")
    .trim();
}

/** Isolates the `cleanup` helper inside `getTrimmedBlob` so terminal-lifecycle
 *  assertions cannot be satisfied by the separate success/failure code paths. */
function isolateCleanupSource(source: string): string {
  const block = isolateGetTrimmedBlobSource(source);
  const startMarker = "const cleanup = () => {";
  const startIdx = block.indexOf(startMarker);
  expect(startIdx, `${ANALYZE_PAGE_FILE}: could not locate "${startMarker}"`).toBeGreaterThanOrEqual(0);

  const endMarker = "const succeed";
  const endIdx = block.indexOf(endMarker, startIdx);
  expect(endIdx, `${ANALYZE_PAGE_FILE}: could not locate "${endMarker}" after the cleanup helper`).toBeGreaterThan(startIdx);

  return block.slice(startIdx, endIdx);
}

/** Isolates the `seeked` handler, including the `video.play().then(...)`
 *  continuation it schedules. */
function isolateSeekedHandlerSource(source: string): string {
  const block = isolateGetTrimmedBlobSource(source);
  const startMarker = "const onSeeked = () => {";
  const startIdx = block.indexOf(startMarker);
  expect(startIdx, `${ANALYZE_PAGE_FILE}: could not locate "${startMarker}"`).toBeGreaterThanOrEqual(0);

  const endMarker = 'video.addEventListener("seeked"';
  const endIdx = block.indexOf(endMarker, startIdx);
  expect(endIdx, `${ANALYZE_PAGE_FILE}: could not locate "${endMarker}" after the seeked handler`).toBeGreaterThan(startIdx);

  return block.slice(startIdx, endIdx);
}

/** Isolates `startAnalysis` so ordering assertions are scoped to the real
 *  submission flow rather than to similar strings elsewhere in the file. */
function isolateStartAnalysisSource(source: string): string {
  const startMarker = "const startAnalysis";
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${ANALYZE_PAGE_FILE}: could not locate "${startMarker}"`).toBeGreaterThanOrEqual(0);

  const endMarker = "const setTime";
  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${ANALYZE_PAGE_FILE}: could not locate "${endMarker}" after "${startMarker}"`).toBeGreaterThan(startIdx);

  return source.slice(startIdx, endIdx);
}

describe("AnalyzePage — small/untrimmed direct-file fast path is preserved", () => {
  it("retains all three fast-path conditions", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    for (const condition of [
      "trimStart === 0",
      "Math.abs(trimEnd - duration) < 0.1",
      "file.size < 18 * 1024 * 1024",
    ]) {
      expect(block, `${ANALYZE_PAGE_FILE}: fast-path condition "${condition}" was removed or altered`).toContain(condition);
    }
  });

  it("still returns the original File directly for the fast path", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: the direct "return file;" fast path must be preserved`).toContain("return file;");
  });

  it("does not gate the fast path on any transcoding capability", () => {
    // Assert against the EXECUTABLE predicate, not raw source before the fast
    // path — the latter also spans explanatory comment prose, which legitimately
    // names the capabilities the fast path must not depend on.
    const predicate = isolatePreprocessingRequiredPredicate(readSource(ANALYZE_PAGE_FILE));
    for (const gate of ["MediaRecorder", "captureStream", "getContext"]) {
      expect(predicate, `${ANALYZE_PAGE_FILE}: "${gate}" must not gate the small/untrimmed fast path — predicate is "${predicate}"`).not.toContain(gate);
    }
  });

  it("evaluates the fast path before any preprocessing capability is touched", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    const order: [string, number][] = [
      ["const preprocessingRequired", block.indexOf("const preprocessingRequired")],
      ["if (!preprocessingRequired)", block.indexOf("if (!preprocessingRequired)")],
      ["return file;", block.indexOf("return file;")],
      ["setIsTrimming(true)", block.indexOf("setIsTrimming(true)")],
      ["captureStream", block.indexOf("(canvas as any).captureStream")],
      ["new MediaRecorder", block.indexOf("new MediaRecorder")],
    ];
    for (const [label, idx] of order) {
      expect(idx, `${ANALYZE_PAGE_FILE}: getTrimmedBlob is missing "${label}"`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1][1],
        `${ANALYZE_PAGE_FILE}: "${order[i - 1][0]}" must appear before "${order[i][0]}"`,
      ).toBeLessThan(order[i][1]);
    }
  });

  it("keeps the 15-second requested-segment guard unchanged", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    expect(source, `${ANALYZE_PAGE_FILE}: MAX_SEGMENT_SECONDS must remain 15`).toContain("const MAX_SEGMENT_SECONDS = 15;");
  });
});

describe("AnalyzePage — required preprocessing fails closed", () => {
  it("contains no silent resolve-original-file fallback", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: a silent "resolve(file)" fallback would upload a different clip than the one requested`).not.toContain("resolve(file)");
  });

  it("exposes an explicit rejection path for preprocessing failure", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: the preprocessing promise must be rejectable`).toMatch(/new Promise<Blob>\(\s*\(resolve,\s*reject\)/);
    expect(block, `${ANALYZE_PAGE_FILE}: missing a reject(...) failure path`).toContain("reject(");
  });

  it("routes every synchronous failure branch through the fail-closed helper", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    for (const branch of ["if (!ctx) { fail(); return; }", "if (!stream) { fail(); return; }", "catch { fail(); }"]) {
      expect(block, `${ANALYZE_PAGE_FILE}: expected failure branch "${branch}"`).toContain(branch);
    }
  });

  it("provides an asynchronous MediaRecorder error terminal path", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: missing recorder.onerror terminal path`).toContain("recorder.onerror");
  });

  it("cannot leave the preprocessing promise unsettled", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: missing single-settlement guard`).toContain("let settled = false;");
    expect(block, `${ANALYZE_PAGE_FILE}: missing absolute watchdog backstop`).toContain("watchdog = setTimeout(fail");
  });

  it("clears the trimming busy state on every exit", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: cleanup must clear isTrimming`).toContain("setIsTrimming(false);");
  });

  // ── Terminal lifecycle: nothing may keep running after settlement ────────
  it("cleanup owns the pending seeked listener and removes it", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    const cleanup = isolateCleanupSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: missing a cleanup-visible seeked-handler holder`).toContain("let seekedHandler");
    expect(cleanup, `${ANALYZE_PAGE_FILE}: cleanup must remove the pending seeked listener`).toContain('video.removeEventListener("seeked", seekedHandler)');
  });

  it("removes the seeked listener before restoring currentTime", () => {
    const cleanup = isolateCleanupSource(readSource(ANALYZE_PAGE_FILE));
    const removeIdx = cleanup.indexOf('removeEventListener("seeked"');
    const restoreIdx = cleanup.indexOf("currentTime = trimStart");
    expect(removeIdx, `${ANALYZE_PAGE_FILE}: cleanup does not remove the seeked listener`).toBeGreaterThanOrEqual(0);
    expect(restoreIdx, `${ANALYZE_PAGE_FILE}: cleanup does not restore currentTime`).toBeGreaterThanOrEqual(0);
    expect(removeIdx, `${ANALYZE_PAGE_FILE}: the seeked listener must be removed before currentTime restoration, otherwise cleanup can re-trigger it`).toBeLessThan(restoreIdx);
  });

  it("cleanup terminates preprocessing playback before restoring state", () => {
    const cleanup = isolateCleanupSource(readSource(ANALYZE_PAGE_FILE));
    const pauseIdx = cleanup.indexOf("video.pause()");
    const restoreIdx = cleanup.indexOf("playbackRate = 1");
    expect(pauseIdx, `${ANALYZE_PAGE_FILE}: cleanup must pause the video`).toBeGreaterThanOrEqual(0);
    expect(restoreIdx, `${ANALYZE_PAGE_FILE}: cleanup does not restore playbackRate`).toBeGreaterThanOrEqual(0);
    expect(pauseIdx, `${ANALYZE_PAGE_FILE}: playback must be paused before playback state is restored`).toBeLessThan(restoreIdx);
  });

  it("cleanup can stop an active recorder, guarded by state and exception containment", () => {
    const block = isolateGetTrimmedBlobSource(readSource(ANALYZE_PAGE_FILE));
    const cleanup = isolateCleanupSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: missing a cleanup-visible recorder holder`).toContain("let activeRecorder");
    expect(block, `${ANALYZE_PAGE_FILE}: the recorder holder is never assigned`).toContain("activeRecorder = recorder;");
    expect(cleanup, `${ANALYZE_PAGE_FILE}: cleanup must check recorder state before stopping`).toContain('activeRecorder.state !== "inactive"');
    expect(cleanup, `${ANALYZE_PAGE_FILE}: cleanup must stop an active recorder`).toContain("activeRecorder.stop()");
    expect(cleanup, `${ANALYZE_PAGE_FILE}: the cleanup recorder.stop() must be exception-contained`).toMatch(/try\s*\{\s*activeRecorder\.stop\(\);\s*\}\s*catch/);
  });

  it("guards the seeked callback against an already-settled operation", () => {
    const handler = isolateSeekedHandlerSource(readSource(ANALYZE_PAGE_FILE));
    const guardIdx = handler.indexOf("if (settled) return;");
    const playIdx = handler.indexOf("video.play()");
    expect(guardIdx, `${ANALYZE_PAGE_FILE}: the seeked callback must bail out when already settled`).toBeGreaterThanOrEqual(0);
    expect(playIdx, `${ANALYZE_PAGE_FILE}: the seeked callback no longer calls video.play()`).toBeGreaterThanOrEqual(0);
    expect(guardIdx, `${ANALYZE_PAGE_FILE}: the settlement guard must precede video.play()`).toBeLessThan(playIdx);
  });

  it("guards the play().then continuation before starting the recorder or timers", () => {
    const handler = isolateSeekedHandlerSource(readSource(ANALYZE_PAGE_FILE));
    const thenIdx = handler.indexOf("video.play().then(");
    expect(thenIdx, `${ANALYZE_PAGE_FILE}: missing the video.play().then continuation`).toBeGreaterThanOrEqual(0);
    const continuation = handler.slice(thenIdx);

    const guardIdx = continuation.indexOf("if (settled) return;");
    const startIdx = continuation.indexOf("recorder.start(");
    const intervalIdx = continuation.indexOf("setInterval(");
    const timeoutIdx = continuation.indexOf("timeout = setTimeout(");

    expect(guardIdx, `${ANALYZE_PAGE_FILE}: the play() continuation must bail out when already settled`).toBeGreaterThanOrEqual(0);
    for (const [label, idx] of [["recorder.start(", startIdx], ["setInterval(", intervalIdx], ["timeout = setTimeout(", timeoutIdx]] as [string, number][]) {
      expect(idx, `${ANALYZE_PAGE_FILE}: the play() continuation is missing "${label}"`).toBeGreaterThanOrEqual(0);
      expect(guardIdx, `${ANALYZE_PAGE_FILE}: the settlement guard must precede "${label}"`).toBeLessThan(idx);
    }
  });

  it("surfaces an actionable user-facing message without naming an unsupported browser", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    expect(source, `${ANALYZE_PAGE_FILE}: missing the preprocessing failure message constant`).toContain("PREPROCESSING_FAILED_MESSAGE");
    for (const forbidden of ["Safari", "Chrome", "iOS", "Android", "not supported", "unsupported"]) {
      expect(source, `${ANALYZE_PAGE_FILE}: the failure message must not claim a specific browser/platform is unsupported ("${forbidden}")`).not.toContain(forbidden);
    }
  });
});

describe("AnalyzePage — submission ordering is unchanged", () => {
  it("obtains the blob before any Storage upload, DB insert, or analysis call", () => {
    const block = isolateStartAnalysisSource(readSource(ANALYZE_PAGE_FILE));

    const blobIdx = block.indexOf("await getTrimmedBlob()");
    const uploadIdx = block.indexOf(".upload(");
    const videosIdx = block.indexOf('.from("swing_videos")');
    const analysisIdx = block.indexOf('.from("swing_analysis")');
    const apiIdx = block.indexOf('fetch("/api/analyze-swing"');

    for (const [label, idx] of [
      ["await getTrimmedBlob()", blobIdx],
      [".upload(", uploadIdx],
      ['.from("swing_videos")', videosIdx],
      ['.from("swing_analysis")', analysisIdx],
      ['fetch("/api/analyze-swing"', apiIdx],
    ] as [string, number][]) {
      expect(idx, `${ANALYZE_PAGE_FILE}: startAnalysis is missing "${label}"`).toBeGreaterThanOrEqual(0);
    }

    expect(blobIdx, `${ANALYZE_PAGE_FILE}: preprocessing must complete before Storage upload`).toBeLessThan(uploadIdx);
    expect(uploadIdx, `${ANALYZE_PAGE_FILE}: Storage upload must precede the swing_videos insert`).toBeLessThan(videosIdx);
    expect(videosIdx, `${ANALYZE_PAGE_FILE}: swing_videos must precede swing_analysis`).toBeLessThan(analysisIdx);
    expect(analysisIdx, `${ANALYZE_PAGE_FILE}: the analysis row must exist before the API call`).toBeLessThan(apiIdx);
  });

  it("keeps the analysis request body limited to the analysis id", () => {
    const block = isolateStartAnalysisSource(readSource(ANALYZE_PAGE_FILE));
    expect(block, `${ANALYZE_PAGE_FILE}: the API request body must remain unchanged in this slice`).toContain("JSON.stringify({ analysisId: analysisRow.id })");
    expect(block, `${ANALYZE_PAGE_FILE}: MediaPipe metrics must not be wired into the active path in this slice`).not.toContain("mediapipeMetrics");
  });

  it("adds no >20 MB final-blob guard in this slice", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    for (const forbidden of ["20 * 1024 * 1024", "20 * 1_048_576", "MAX_INLINE_VIDEO_BYTES"]) {
      expect(source, `${ANALYZE_PAGE_FILE}: the >20 MB final-blob guard is deferred to a later slice ("${forbidden}")`).not.toContain(forbidden);
    }
  });

  it("does not change the upload architecture to XHR progress in this slice", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    for (const forbidden of ["XMLHttpRequest", "upload.onprogress", "createSignedUploadUrl"]) {
      expect(source, `${ANALYZE_PAGE_FILE}: upload-progress rework is deferred ("${forbidden}")`).not.toContain(forbidden);
    }
  });
});

describe("AnalyzePage — dormant pipeline remains unwired", () => {
  it("does not import SwingUploader or upload-actions", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    for (const forbidden of ["SwingUploader", "./upload-actions", "upload-actions"]) {
      expect(source, `${ANALYZE_PAGE_FILE}: the dormant submission pipeline must not be wired in this slice ("${forbidden}")`).not.toContain(forbidden);
    }
  });

  it("does not wire client MediaPipe extraction into the active route", () => {
    const source = readSource(ANALYZE_PAGE_FILE);
    for (const forbidden of ["extractSwingMetrics", "@/lib/biometrics"]) {
      expect(source, `${ANALYZE_PAGE_FILE}: MediaPipe wiring is out of scope for this slice ("${forbidden}")`).not.toContain(forbidden);
    }
  });
});
