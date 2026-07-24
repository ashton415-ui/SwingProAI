import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_SECTION,
  UPGRADE_CALLOUT,
  getSectionsForRole,
  getEffectiveNavItems,
  getBottomTabItems,
  shouldShowUpgradeCallout,
  type NavItem,
} from "@/components/navigation/dashboard-navigation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file. Normalized to LF so none of the
 *  checks below depend on whether this checkout has CRLF or LF line
 *  endings — every assertion here operates on content, not line shape. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const LAYOUT_FILE = "app/(dashboard)/layout.tsx";
const NAV_MODEL_FILE = "components/navigation/dashboard-navigation.tsx";
const MOBILE_NAV_FILE = "components/navigation/MobileDashboardNavigation.tsx";
const LAUNCH_GATES_FILE = "docs/LAUNCH_GATES.md";

// The three files whose own implementation must be scanned for placeholder
// language. Deliberately excludes this test file itself (which legitimately
// contains the literal words "TODO"/"FIXME"/etc. as data in the phrase list
// below) and the launch-gate doc (checked separately, for required content
// rather than absence of words).
const RW1_IMPLEMENTATION_FILES = [LAYOUT_FILE, NAV_MODEL_FILE, MOBILE_NAV_FILE];

function hrefLabelPairs(items: NavItem[]): [string, string][] {
  return items.map((i) => [i.href, i.label]);
}

// Independently transcribed from the task's required inventory — not read
// back from dashboard-navigation.tsx — so a change to the shared model that
// silently drops, renames, or reorders an item is caught here rather than
// only self-confirmed against its own source.
const EXPECTED_GOLFER: [string, string][] = [
  ["/dashboard", "Progress Hub"],
  ["/telemetry", "Telemetry Logs"],
  ["/analyze", "Analyze Swing"],
  ["/bag", "My Bag"],
  ["/goals", "My Goals"],
  ["/range", "Practice Range"],
  ["/drills", "Drill Hub"],
  ["/lessons", "My Lessons"],
];

const EXPECTED_COACH: [string, string][] = [
  ["/coach", "Coach Hub"],
  ["/coach/golfers", "My Golfers"],
  ["/coach/reviews", "Swing Reviews"],
  ["/coach/lesson-plans", "Lesson Plans"],
];

const EXPECTED_ADMIN_OWN: [string, string][] = [
  ["/admin", "Command Center"],
  ["/admin/users", "All Users"],
  ["/admin/coaches", "Coaches"],
  ["/admin/swings", "All Swings"],
  ["/upgrade", "View Plans"],
];

// ============================================================================
// 1. Golfer exact navigation inventory
// ============================================================================
describe("dashboard navigation — golfer inventory", () => {
  it("golfer role receives exactly the golfer section", () => {
    expect(getSectionsForRole("golfer").map((s) => s.id)).toEqual(["golfer"]);
  });

  it("golfer effective inventory matches the exact required hrefs and labels, in order", () => {
    expect(hrefLabelPairs(getEffectiveNavItems("golfer"))).toEqual(EXPECTED_GOLFER);
  });
});

// ============================================================================
// 2. Coach exact navigation inventory
// ============================================================================
describe("dashboard navigation — coach inventory", () => {
  it("coach role receives exactly the coach section", () => {
    expect(getSectionsForRole("coach").map((s) => s.id)).toEqual(["coach"]);
  });

  it("coach effective inventory matches the exact required hrefs and labels, in order", () => {
    expect(hrefLabelPairs(getEffectiveNavItems("coach"))).toEqual(EXPECTED_COACH);
  });
});

// ============================================================================
// 3 & 4. Admin exact combined navigation inventory, exact labels/hrefs
// ============================================================================
describe("dashboard navigation — admin combined inventory", () => {
  it("admin role receives golfer, coach, and admin sections, in that order", () => {
    expect(getSectionsForRole("admin").map((s) => s.id)).toEqual(["golfer", "coach", "admin"]);
  });

  it("admin effective inventory is exactly golfer + coach + admin's own items, in order", () => {
    const expected = [...EXPECTED_GOLFER, ...EXPECTED_COACH, ...EXPECTED_ADMIN_OWN];
    expect(hrefLabelPairs(getEffectiveNavItems("admin"))).toEqual(expected);
  });
});

// ============================================================================
// 5. No duplicate hrefs per effective role
// ============================================================================
describe("dashboard navigation — structural guarantees", () => {
  it("has no duplicate hrefs within any role's effective inventory", () => {
    for (const role of ["golfer", "coach", "admin"]) {
      const hrefs = getEffectiveNavItems(role).map((i) => i.href);
      expect(new Set(hrefs).size, `duplicate href found for role ${role}`).toBe(hrefs.length);
    }
  });

  it("every effective nav item exposes a real icon component reference", () => {
    for (const role of ["golfer", "coach", "admin"]) {
      for (const item of getEffectiveNavItems(role)) {
        expect(item.icon, `${role} item ${item.href} is missing an icon`).toBeDefined();
      }
    }
  });
});

// ============================================================================
// 6 & 7. Upgrade callout availability
// ============================================================================
describe("dashboard navigation — upgrade callout", () => {
  it("inactive golfer receives the upgrade callout", () => {
    expect(shouldShowUpgradeCallout("golfer", false)).toBe(true);
  });

  it("active/trialing golfer does not receive the upgrade callout", () => {
    // The layout computes isActive as (status === "active" || status ===
    // "trialing") before calling this function, so both active and
    // trialing collapse to isActive=true at this boundary.
    expect(shouldShowUpgradeCallout("golfer", true)).toBe(false);
  });

  it("coach and admin never receive the golfer upgrade callout, regardless of isActive", () => {
    expect(shouldShowUpgradeCallout("coach", false)).toBe(false);
    expect(shouldShowUpgradeCallout("coach", true)).toBe(false);
    expect(shouldShowUpgradeCallout("admin", false)).toBe(false);
    expect(shouldShowUpgradeCallout("admin", true)).toBe(false);
  });

  it("the upgrade callout and admin's View Plans link resolve to the same route", () => {
    const viewPlans = ADMIN_SECTION.items.find((i) => i.label === "View Plans");
    expect(viewPlans?.href).toBe(UPGRADE_CALLOUT.href);
  });
});

// ============================================================================
// 8 & 9. Phone bottom tabs are valid subsets; omitted links remain in the drawer
// ============================================================================
describe("dashboard navigation — phone bottom tabs / tablet rail", () => {
  it.each(["golfer", "coach", "admin"])("%s bottom-tab items are a non-empty subset of the full inventory", (role) => {
    const full = new Set(getEffectiveNavItems(role).map((i) => i.href));
    const tabs = getBottomTabItems(role);
    expect(tabs.length).toBeGreaterThan(0);
    for (const t of tabs) expect(full.has(t.href)).toBe(true);
  });

  it.each(["golfer", "coach", "admin"])("%s: every link omitted from bottom tabs remains in the full drawer inventory", (role) => {
    const full = getEffectiveNavItems(role).map((i) => i.href);
    const tabHrefs = new Set(getBottomTabItems(role).map((i) => i.href));
    const omitted = full.filter((h) => !tabHrefs.has(h));
    for (const h of omitted) expect(full).toContain(h);
  });
});

// ============================================================================
// 10. Source guard: no placeholder/stub phrases in the RW1 implementation files
// ============================================================================
describe("RW1 source guards — no placeholder implementation", () => {
  const FORBIDDEN_PHRASES = ["TODO", "FIXME", "placeholder", "keep existing", "stub", "coming soon"];

  it.each(RW1_IMPLEMENTATION_FILES)("%s contains no placeholder/stub phrases", (file) => {
    const source = readSource(file).toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(source, `found forbidden phrase "${phrase}" in ${file}`).not.toContain(phrase.toLowerCase());
    }
  });

  it.each(RW1_IMPLEMENTATION_FILES)("%s contains no bare 'later' or 'temporary' as a standalone word", (file) => {
    const source = readSource(file).toLowerCase();
    expect(source).not.toMatch(/\blater\b/);
    expect(source).not.toMatch(/\btemporary\b/);
  });
});

// ============================================================================
// 11, 12, 13, 14. Structural responsive contract in the layout source
// ============================================================================
describe("RW1 source guards — structural responsive contract", () => {
  function mainTagClassNames(): string[] {
    const source = readSource(LAYOUT_FILE);
    const mainTagMatch = source.match(/<main[\s\S]*?>/);
    expect(mainTagMatch, "expected to find a <main> tag in the layout").not.toBeNull();
    const classMatch = mainTagMatch![0].match(/className="([^"]*)"/);
    expect(classMatch, "expected a className on <main>").not.toBeNull();
    return classMatch![1].split(/\s+/).filter(Boolean);
  }

  it("desktop sidebar is gated behind a large-screen (lg) visibility boundary", () => {
    const source = readSource(LAYOUT_FILE);
    const asideTagMatch = source.match(/<aside[\s\S]*?>/);
    expect(asideTagMatch, "expected to find an <aside> tag in the layout").not.toBeNull();
    const classMatch = asideTagMatch![0].match(/className="([^"]*)"/);
    expect(classMatch, "expected a className on <aside>").not.toBeNull();
    const tokens = classMatch![1].split(/\s+/).filter(Boolean);
    expect(tokens).toContain("hidden");
    expect(tokens).toContain("lg:flex");
  });

  it("main content no longer carries an unconditional ml-64 (only an lg:-scoped one)", () => {
    const tokens = mainTagClassNames();
    expect(tokens).toContain("lg:ml-64");
    expect(tokens).not.toContain("ml-64");
  });

  it("main content reserves phone bottom padding for the fixed bottom-tab bar", () => {
    const tokens = mainTagClassNames();
    expect(tokens.some((t) => /^pb-\[calc\(/.test(t))).toBe(true);
  });

  it("safe-area-inset handling is present in the shell/navigation source", () => {
    const combined = [LAYOUT_FILE, MOBILE_NAV_FILE].map(readSource).join("\n");
    expect(combined).toContain("safe-area-inset");
  });
});

// ============================================================================
// 15. Source guard: mobile controls include required accessibility attributes
// ============================================================================
describe("RW1 source guards — mobile navigation accessibility", () => {
  const source = readSource(MOBILE_NAV_FILE);

  it("exposes aria-expanded on drawer-opening controls", () => {
    expect(source).toContain("aria-expanded");
  });

  it("exposes aria-controls linking to the drawer", () => {
    expect(source).toContain("aria-controls");
  });

  it("exposes aria-label on interactive controls", () => {
    expect(source).toContain("aria-label");
  });

  it("the drawer uses dialog semantics", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });

  it("Escape-key handling is present", () => {
    expect(source).toContain('"Escape"');
  });

  it("body scroll lock is present while the drawer is open", () => {
    expect(source).toContain("document.body.style.overflow");
  });
});

// ============================================================================
// 16, 17, 18. Launch-gate document
// ============================================================================
describe("launch-gate document — required content", () => {
  const doc = readSource(LAUNCH_GATES_FILE).toLowerCase();

  const REQUIRED_PHRASES = [
    "robust responsive web",
    "early mobile-formatted web testing",
    "android apk",
    "android play store",
    "iphone testflight",
    "iphone app store",
    "landscape-first ipad coach command center",
    "igolf course and scorecard",
    "golf gps mvp",
    "front, center, and back",
    "swing analysis and personalized reports",
    "golfer progress, goals, bag, drills, and lessons",
    "coach marketplace and coach-to-golfer workflows",
  ];

  it.each(REQUIRED_PHRASES)("launch-gate document records: %s", (phrase) => {
    expect(doc).toContain(phrase.toLowerCase());
  });

  it("records the separate-authorization boundary", () => {
    expect(doc).toContain("separately authorized");
  });

  it("marks advanced AI caddie, automatic shot detection, 3D course maps, and Green Heat Maps as post-launch", () => {
    expect(doc).toContain("post-launch");
    expect(doc).toContain("ai caddie");
    expect(doc).toContain("shot detection");
    expect(doc).toContain("3d");
    expect(doc).toContain("green heat map");
  });

  it("does not claim any gate is already complete", () => {
    expect(doc).not.toContain("has been completed");
    expect(doc).not.toContain("is complete");
    expect(doc).not.toContain("already launched");
  });
});
