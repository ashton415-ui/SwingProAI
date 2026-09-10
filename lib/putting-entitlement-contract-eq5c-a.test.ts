/**
 * EQ5C-A — the putting result entitlement contract and the result-secrecy
 * boundary.
 *
 * TWO THINGS ARE PROTECTED HERE
 * -----------------------------
 * 1. The tier matrix itself. canUsePuttingAnalysis is a product contract in its
 *    own right. It currently grants the same four tiers as canUseLaunchMonitor,
 *    and that is a coincidence of today's price sheet rather than a
 *    relationship -- so this suite asserts the matrix directly, tier by tier,
 *    and separately asserts that the helper does not reach for the other one.
 *    Comparing the two functions' outputs to each other would encode the
 *    coincidence as a dependency and defeat the point.
 *
 * 2. Where the entitlement decision happens. The swing-detail page is a Server
 *    Component and PuttingAnalysisPanel is a Client Component. Props crossing
 *    that boundary are serialized into the RSC flight payload and are readable
 *    in the browser regardless of what the component renders, so a client-side
 *    `if (!hasAccess) return <Locked/>` suppresses pixels while shipping the
 *    data. An unentitled golfer must therefore never be handed the narrative at
 *    all, and the only way to guarantee that is to decide on the server before
 *    the prop exists.
 *
 * The matrix tests are behavioural -- they call the helper. The data-flow tests
 * are source scans, because the page opens a Supabase client and vitest runs in
 * the node environment here with no jsdom and no renderer.
 *
 * No database, no network, no Supabase client, no jsdom, no credential.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canUsePuttingAnalysis,
  canUseLaunchMonitor,
  type SubscriptionTier,
} from "./entitlements";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ENTITLEMENTS = "lib/entitlements.ts";
const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const PANEL = "components/putting/PuttingAnalysisPanel.tsx";

const entitlementsSource = readSource(ENTITLEMENTS);
const pageSource = readSource(RESULT_PAGE);
const panelSource = readSource(PANEL);

/**
 * Source with comments removed.
 *
 * The panel bans below are about what the component *does* -- what it imports,
 * what it branches on, what props it accepts -- not about what its
 * documentation may mention. The panel's own header comment explains why it
 * holds no tier, and a scanner that failed on the word "tier" appearing in that
 * explanation would pressure the next author to delete it. Only whole-line "//"
 * comments are removed, so a "//" inside a string literal is never eaten.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

const panelCode = stripComments(panelSource);

/** The canUsePuttingAnalysis declaration only, so a ban applies to the helper
 *  rather than to the whole shared entitlement file. */
function puttingHelperSource(): string {
  const start = entitlementsSource.indexOf("export function canUsePuttingAnalysis(");
  expect(start, `${ENTITLEMENTS}: canUsePuttingAnalysis not found`).toBeGreaterThanOrEqual(0);
  const next = entitlementsSource.indexOf("export function", start + 1);
  return next === -1 ? entitlementsSource.slice(start) : entitlementsSource.slice(start, next);
}

// ─── 1 — the exact matrix ─────────────────────────────────────────────────────

describe("canUsePuttingAnalysis — the frozen tier matrix", () => {
  const MATRIX: readonly [SubscriptionTier, boolean][] = [
    ["par", false],
    ["none", false],
    ["birdie", true],
    ["eagle", true],
    ["coach_starter", true],
    ["coach_pro", true],
  ];

  it.each(MATRIX)("%s -> %s", (tier, expected) => {
    expect(canUsePuttingAnalysis(tier)).toBe(expected);
  });

  it("covers every tier in the vocabulary, so no tier is left undecided", () => {
    const decided = MATRIX.map(([tier]) => tier).sort();
    const vocabulary: SubscriptionTier[] = [
      "par",
      "birdie",
      "eagle",
      "coach_starter",
      "coach_pro",
      "none",
    ];
    expect(decided).toEqual([...vocabulary].sort());
  });
});

// ─── 2 — unknown values fail closed ───────────────────────────────────────────

describe("canUsePuttingAnalysis fails closed on anything outside the vocabulary", () => {
  // `tier` is typed, but it originates in a database column, so a value the
  // type system never anticipated can reach the helper at runtime. The casts
  // below exercise exactly that.
  const HOSTILE: readonly unknown[] = [
    "platinum",
    "BIRDIE",
    "Birdie",
    "putting",
    "",
    " ",
    null,
    undefined,
    0,
    1,
    NaN,
    true,
    {},
    { tier: "birdie" },
    [],
    ["birdie"],
  ];

  it.each(HOSTILE.map((value) => [JSON.stringify(value) ?? String(value), value] as const))(
    "refuses %s",
    (_label, value) => {
      expect(canUsePuttingAnalysis(value as SubscriptionTier)).toBe(false);
    },
  );

  it("is written as a positive allow-list, never a deny-list", () => {
    const helper = puttingHelperSource();
    // A `!==` chain would grant access to any value nobody thought to exclude.
    expect(helper, "the helper must not refuse by exclusion").not.toContain("!==");
    expect(helper).toContain('tier === "birdie"');
    expect(helper).toContain('tier === "eagle"');
    expect(helper).toContain('tier === "coach_starter"');
    expect(helper).toContain('tier === "coach_pro"');
  });
});

// ─── 3 — independence from the launch-monitor capability ──────────────────────

describe("canUsePuttingAnalysis is its own contract", () => {
  it("does not call, alias, wrap or derive from canUseLaunchMonitor", () => {
    expect(puttingHelperSource()).not.toContain("canUseLaunchMonitor");
  });

  it("is a standalone declaration, not a re-export of another helper", () => {
    expect(entitlementsSource).toContain("export function canUsePuttingAnalysis(tier: SubscriptionTier): boolean {");
    expect(entitlementsSource).not.toContain("canUsePuttingAnalysis = canUseLaunchMonitor");
    expect(entitlementsSource).not.toContain("export { canUseLaunchMonitor as canUsePuttingAnalysis }");
  });

  it("leaves canUseLaunchMonitor's own mapping untouched", () => {
    // Same-set behaviour today is a coincidence, and it is asserted here as a
    // fact about canUseLaunchMonitor -- not used to define putting access.
    expect(canUseLaunchMonitor("par")).toBe(false);
    expect(canUseLaunchMonitor("none")).toBe(false);
    expect(canUseLaunchMonitor("birdie")).toBe(true);
    expect(canUseLaunchMonitor("eagle")).toBe(true);
    expect(canUseLaunchMonitor("coach_starter")).toBe(true);
    expect(canUseLaunchMonitor("coach_pro")).toBe(true);
    expect(entitlementsSource).toContain(
      'return ["birdie", "eagle", "coach_starter", "coach_pro"].includes(tier);'
    );
  });

  it("introduces no second putting tier matrix anywhere else", () => {
    for (const { label, source } of [
      { label: RESULT_PAGE, source: pageSource },
      { label: PANEL, source: panelSource },
    ]) {
      expect(stripComments(source), `${label} must not redefine the putting matrix`).not.toContain(
        "function canUsePuttingAnalysis"
      );
    }
  });
});

// ─── 4-5 — the page uses the centralized helper ───────────────────────────────

describe("the swing-detail server page owns the visibility decision", () => {
  it("imports the centralized helper", () => {
    expect(pageSource).toContain('import { canUsePuttingAnalysis } from "@/lib/entitlements";');
    expect(pageSource).toContain("canUsePuttingAnalysis(tier)");
  });

  it("resolves the tier server-side from the users table", () => {
    expect(pageSource).toContain('.from("users")');
    expect(pageSource).toContain('.select("subscription_tier")');
    expect(pageSource).toContain('const tier = (profile?.subscription_tier ?? "par") as SubscriptionTier;');
  });

  it("does not hard-code the putting tier matrix in the state resolver", () => {
    // Tier literals legitimately appear elsewhere on the page for the unrelated
    // equipment-fitting gate, so the ban is scoped to the putting resolver.
    const start = pageSource.indexOf("const puttingState");
    expect(start, "putting state resolver not found").toBeGreaterThanOrEqual(0);
    const end = pageSource.indexOf("return (", start);
    expect(end).toBeGreaterThan(start);
    const resolver = pageSource.slice(start, end);
    for (const tier of ["par", "none", "birdie", "eagle", "coach_starter", "coach_pro"]) {
      expect(resolver, `the resolver must not hard-code ${tier}`).not.toContain(`"${tier}"`);
    }
    expect(resolver, "the resolver must not borrow the launch-monitor gate").not.toContain(
      "canUseLaunchMonitor"
    );
  });
});

// ─── 6-7 — the panel holds no entitlement authority ───────────────────────────

describe("PuttingAnalysisPanel performs no entitlement calculation", () => {
  it("the comment stripper leaves the code it is asked to scan", () => {
    expect(panelSource).toContain("// tier, performs no entitlement calculation");
    expect(panelCode).not.toContain("// tier, performs no entitlement calculation");
    expect(panelCode).toContain("export function PuttingAnalysisPanel");
  });

  it("contains neither entitlement helper", () => {
    expect(panelCode).not.toContain("canUsePuttingAnalysis");
    expect(panelCode).not.toContain("canUseLaunchMonitor");
  });

  it("does not import the entitlement module at all", () => {
    expect(panelCode).not.toContain("@/lib/entitlements");
  });

  it("takes no tier and therefore cannot branch on one", () => {
    expect(panelCode).not.toContain("SubscriptionTier");
    expect(panelCode).not.toContain("tier");
  });

  it("renders exactly the state it is given", () => {
    expect(panelSource).toContain('if (state.status === "locked")');
    expect(panelSource).toContain('if (state.status === "unavailable")');
    expect(panelSource).toContain("const { analysis } = state;");
  });
});

// ─── 8-10 — the serialization firewall ────────────────────────────────────────

describe("no canonical narrative crosses the boundary for an unentitled tier", () => {
  it("declares a discriminated state in which only ready carries a payload", () => {
    expect(panelSource).toContain("export type PuttingResultState =");
    expect(panelSource).toContain('| { status: "locked" }');
    expect(panelSource).toContain('| { status: "unavailable" }');
    expect(panelSource).toContain('| { status: "ready"; analysis: PersistedPuttingAnalysisV1 };');
  });

  it("gives the locked and unavailable states no analysis property to carry", () => {
    // The union is the guarantee: `{ status: "locked" }` has nowhere to put a
    // narrative, so an unentitled render cannot smuggle one across.
    const union = panelSource.slice(
      panelSource.indexOf("export type PuttingResultState ="),
      panelSource.indexOf("interface PuttingAnalysisPanelProps"),
    );
    expect(union.length).toBeGreaterThan(0);
    expect((union.match(/analysis:/g) ?? []).length).toBe(1);
  });

  it("short-circuits to locked before the stored payload is read", () => {
    const entitlement = pageSource.indexOf('if (!canUsePuttingAnalysis(tier)) return { status: "locked" };');
    const validation = pageSource.indexOf("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
    const ready = pageSource.indexOf('return { status: "ready", analysis: rawPuttingAnalysis };');
    expect(entitlement, "the locked short-circuit is missing").toBeGreaterThanOrEqual(0);
    expect(validation, "the validation call is missing").toBeGreaterThan(entitlement);
    expect(ready, "the ready construction is missing").toBeGreaterThan(validation);
  });

  it("builds the ready state at exactly one site, guarded by both checks", () => {
    expect((pageSource.match(/status: "ready"/g) ?? []).length).toBe(1);
    // Everything between the entitlement short-circuit and the single ready
    // construction: the validation call must be the only thing standing there.
    const from = pageSource.indexOf('if (!canUsePuttingAnalysis(tier)) return { status: "locked" };');
    const to = pageSource.indexOf('return { status: "ready", analysis: rawPuttingAnalysis };');
    const between = pageSource.slice(from, to);
    expect(between).toContain("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
  });

  it("passes the panel the state and nothing else", () => {
    expect(pageSource).toContain("<PuttingAnalysisPanel state={puttingState} />");
    expect(pageSource).not.toContain("<PuttingAnalysisPanel tier=");
  });

  it("never hands the panel the raw stored payload", () => {
    expect(pageSource).not.toContain("putting_analysis={");
    expect(pageSource).not.toContain("analysis={swing.putting_analysis}");
    expect(pageSource).not.toContain("analysis={rawPuttingAnalysis}");
  });
});
