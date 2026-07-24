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
