import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GJ-PARALLEL-05: the shared page description in app/layout.tsx, which /login and /signup (and every page
 * without its own description) inherit. Only the description string may change: the title, icons, font, body
 * and layout structure stay as accepted, and the landing keeps its own page description. The font loader is a
 * stand-in (nothing is fetched); the real exported `metadata` object is read.
 *
 * The layout guard is deliberately strict for this slice (the work order allows only the description string to
 * change); a later slice that changes the root layout updates it in the same change. The full-tree boundary is
 * checked by the scratch contract tool (devtools/contract-diff.mjs).
 *
 * This file imports nothing added by GJ-PARALLEL-05, so it also runs against the accepted root layout as a
 * control: the description checks fail there, the unchanged-parts guards pass on both.
 */
vi.mock("next/font/google", () => ({ Space_Grotesk: () => ({ variable: "font-stand-in", className: "font-stand-in", style: {} }) }));

import { metadata } from "@/app/layout";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const DESCRIPTION =
  "SwingProAI brings AI swing reviews, goals and practice tools together. AI feedback offers observations and suggestions, not measurements or a coach's review.";
const ACCEPTED_DESCRIPTION_LINE = '  description: "Professional-grade golf analytics powered by AI. Fix your swing in real-time.",';
const DESCRIPTION_LINE = `  description: "${DESCRIPTION}",`;
// accepted GJ04 end state of app/layout.tsx, line endings normalised to LF
const ACCEPTED_LAYOUT_SHA = "baf7c54530dce2989281fc967aefb5052ce4cdae1671777a3888d0aca83a0a3a";
const LANDING_DESCRIPTION =
  "Upload a swing video for an AI review with practice suggestions, then set goals, work through drills, save the clubs in your bag and look back over your past reviews.";
const UNSUPPORTED = /real[- ]?time|professional[- ]grade|pro[- ]level|tour[- ]level|biomechanic|precis|accura|instant|guarantee|certified|licensed|endorsed|official|\bfree\b|\$\d|price|per month|fix your swing/i;

describe("the shared description (inherited by /login and /signup)", () => {
  it("is the neutral wording", () => {
    expect(metadata.description).toBe(DESCRIPTION);
  });

  it("makes no real-time, professional-grade, accuracy, availability, price, endorsement or licensed-data claim", () => {
    expect(String(metadata.description)).not.toMatch(UNSUPPORTED);
  });

  it("matches the landing's disclosure: AI observations and suggestions, not measurements or a coach's review", () => {
    expect(String(metadata.description)).toMatch(/^SwingProAI brings AI swing reviews/);
    expect(String(metadata.description)).toMatch(/observations and suggestions, not measurements or a coach's review\.$/);
    expect(source("app/page.tsx")).toContain("It isn&apos;t a measurement or a coach&apos;s review.");
  });
});

describe("everything else in the root layout is unchanged", () => {
  it("the title and icons are as accepted", () => {
    expect(metadata.title).toBe("SwingProAI — AI-Powered Golf Analysis");
    expect(metadata.icons).toEqual({ icon: "/swingproai_logo.png", apple: "/swingproai_logo.png" });
    expect(Object.keys(metadata).sort()).toEqual(["description", "icons", "title"]);
  });

  it("app/layout.tsx differs from the accepted file only in the description string", () => {
    const src = source("app/layout.tsx");
    expect(src.split(DESCRIPTION_LINE)).toHaveLength(2);
    expect(sha(src.replace(DESCRIPTION_LINE, ACCEPTED_DESCRIPTION_LINE))).toBe(ACCEPTED_LAYOUT_SHA);
  });

  it("the landing keeps its own page description", () => {
    expect(source("app/page.tsx")).toContain(`export const metadata: Metadata = {\n  description:\n    "${LANDING_DESCRIPTION}",\n};`);
  });
});
