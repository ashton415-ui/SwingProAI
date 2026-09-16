/**
 * EQ5E-D — the putting recommendation consumer and its presentation contract.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * EQ5E-C is the server authority: it decides entitlement, ownership, family,
 * completion, payload validity, catalog agreement and order, and it returns one
 * frozen result. EQ5E-D is the first thing allowed to ask it a question, and
 * the first thing allowed to show a golfer the answer.
 *
 * Two failures are worth more than the feature. The first is a second opinion:
 * a consumer that re-validates, re-ranks, filters or reshapes what the
 * authority returned would create a second recommendation policy nobody
 * reconciles. The second is a promotion: a suggestion rendered as though a
 * drill had been measured, assigned by a coach, started, or saved to a practice
 * plan would claim facts nothing in this system establishes.
 *
 * So the assertions below are about absence as much as presence, and an absence
 * cannot be observed by calling a function. They are therefore scanned against
 * the real sources — and every scan is paired with an in-memory mutation
 * proving the scan would actually fire. Nothing is written to disk.
 *
 * WHY SOURCE SCANS AND NOT A RENDERER
 * -----------------------------------
 * The consumer is an async Server Component that opens a Supabase client, and
 * the presentation component is JSX. Vitest runs in the node environment here
 * with no jsdom and no renderer — the same reason the EQ5C-A suite scans
 * source — so structure is asserted against source text.
 *
 * WHAT THIS SUITE DOES NOT OWN
 * ----------------------------
 * The qualitative analysis surface (the page's putting region and
 * PuttingAnalysisPanel) keeps its own contract in the EQ5C-A suites, including
 * the bans that stop *practice focus prose* being relabelled as a drill. Those
 * bans deliberately do not scan this component: presenting canonical catalog
 * drills is exactly what it is for. Its evidence rules live here instead.
 *
 * No database, no network, no Supabase client, no model, no filesystem write.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const PANEL = "components/putting/PuttingRecommendationsPanel.tsx";
const AUTHORITY_SPECIFIER = "@/lib/putting-recommendation-authority-eq5e-c";
/**
 * The rule-set module's specifier prefix, deliberately not written in full.
 *
 * The EQ5E-B suite proves its own direct-importer set by substring, so spelling
 * that specifier out here would make this file count as an importer of the very
 * module it exists to prove neither consumer imports. The prefix still catches a
 * real import: no other module specifier begins with it.
 */
const RULESET_SPECIFIER_PREFIX = "@/lib/putting-drill-recommendation";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Comments removed, for the bans.
 *
 * The bans are about what the consumer *does* and what a golfer *reads*, not
 * about what the code is allowed to explain. The component's own header says
 * why nothing here may imply a drill was assigned or measured; a scanner that
 * failed on that sentence would pressure the next author to delete the
 * explanation to get green. Only whole-line "//" comments are removed, so a
 * "//" inside a string literal is never eaten.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

const pageSource = readSource(RESULT_PAGE);
const pageCode = stripComments(pageSource);
const panelSource = readSource(PANEL);
const panelCode = stripComments(panelSource);

const PUTTING_REGION_START = "PUTTING RESULT REGION";
const FULL_SWING_REGION_START = "FULL SWING REPORT REGION";

/** Everything the page renders for a putting row, and nothing else. */
function puttingRegion(source: string = pageSource): string {
  const start = source.indexOf(PUTTING_REGION_START);
  expect(start, `${RESULT_PAGE}: missing region anchor`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(FULL_SWING_REGION_START, start);
  expect(end, `${RESULT_PAGE}: missing region terminator`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The exact runtime import the page must carry, and the only one allowed. */
const RUNTIME_IMPORT = `import { resolvePuttingDrillRecommendations } from "${AUTHORITY_SPECIFIER}";`;

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

// ============================================================================
// Fixture sanity — a suite that scans the wrong file proves nothing
// ============================================================================

describe("EQ5E-D fixtures", () => {
  it("reads both real sources", () => {
    expect(pageSource.length).toBeGreaterThan(2000);
    expect(panelSource.length).toBeGreaterThan(1000);
  });

  it("the comment stripper removes prose and keeps code and rendered copy", () => {
    expect(panelSource).toContain("// A suggestion is not an assignment.");
    expect(panelCode).not.toContain("// A suggestion is not an assignment.");
    expect(panelCode).toContain("export function PuttingRecommendationsPanel");
    expect(panelCode).toContain("Putting Practice Suggestions");
  });
});

// ============================================================================
// A-C, W. The import boundary
// ============================================================================

describe("EQ5E-D import boundary", () => {
  it("the page is the runtime importer of the authority", () => {
    expect(pageSource).toContain(RUNTIME_IMPORT);
    expect(countOccurrences(pageCode, AUTHORITY_SPECIFIER)).toBe(1);
  });

  it("the page imports the presentation component it renders", () => {
    expect(pageSource).toContain(
      'import { PuttingRecommendationsPanel } from "@/components/putting/PuttingRecommendationsPanel";',
    );
  });

  it("the component names the authority exactly once, as a type-only import", () => {
    expect(countOccurrences(panelCode, AUTHORITY_SPECIFIER)).toBe(1);
    expect(
      new RegExp(`^import type \\{[^}]*\\} from "${AUTHORITY_SPECIFIER.replace("/", "/")}";$`, "m").test(
        panelCode,
      ),
      "the component must reference the authority through `import type` only",
    ).toBe(true);
  });

  it("the component performs no runtime import of the authority", () => {
    // Anything that survives compilation would pull a server-only module — and
    // the model SDK behind its validation contract — into whatever bundles this.
    expect(panelCode).not.toContain(`import {\n  resolvePuttingDrillRecommendations`);
    expect(panelCode).not.toContain(`from "${AUTHORITY_SPECIFIER}";\nimport`);
    expect(panelCode).not.toContain("resolvePuttingDrillRecommendations");
    expect(panelCode).not.toContain(`import "${AUTHORITY_SPECIFIER}"`);
    expect(panelCode).not.toContain(`import(`);
    expect(panelCode).not.toContain("require(");
  });

  it("neither consumer reaches past the authority to the rule set", () => {
    for (const [label, code] of [
      [RESULT_PAGE, pageCode],
      [PANEL, panelCode],
    ] as const) {
      expect(code, `${label} must not import the EQ5E-B rule set directly`).not.toContain(
        RULESET_SPECIFIER_PREFIX,
      );
      expect(code, `${label} must not import the EQ5E-A classifier directly`).not.toContain(
        "@/lib/putting-signal-classification-eq5e-a",
      );
      expect(code, `${label} must not import the EQ5D-A projector directly`).not.toContain(
        "@/lib/putting-drill-evidence-eq5d-a",
      );
    }
  });
});

// ============================================================================
// D-E. The component is a Server Component with a closed import list
// ============================================================================

/** Module specifiers the component actually imports, anchored to real statements. */
function importedModules(code: string): string[] {
  const sideEffect = Array.from(code.matchAll(/^import\s+["']([^"']+)["']/gm)).map((m) => m[1]);
  const withClause = Array.from(code.matchAll(/^import\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)).map(
    (m) => m[1],
  );
  return [...sideEffect, ...withClause];
}

const ALLOWED_PANEL_MODULES = ["next/link", "lucide-react", AUTHORITY_SPECIFIER];

describe("EQ5E-D presentation component is a Server Component", () => {
  it("carries no client directive", () => {
    expect(panelSource).not.toContain('"use client"');
    expect(panelSource).not.toContain("'use client'");
  });

  it("imports only the approved modules", () => {
    expect([...importedModules(panelCode)].sort()).toEqual([...ALLOWED_PANEL_MODULES].sort());
  });

  it("uses no client runtime, data access or entitlement logic", () => {
    for (const token of [
      "useState",
      "useEffect",
      "useMemo",
      "useRef",
      "useCallback",
      "fetch(",
      "next/server",
      "next/headers",
      "NextRequest",
      "NextResponse",
      "@supabase/supabase-js",
      "@/utils/supabase",
      "createClient",
      "@/lib/entitlements",
      "canUsePutting",
      "SubscriptionTier",
      "process.env",
    ]) {
      expect(panelCode, `the component must not reach ${token}`).not.toContain(token);
    }
  });

  it("takes exactly one prop, and it is the authority's own result", () => {
    expect(panelSource).toContain("interface PuttingRecommendationsPanelProps {");
    expect(panelSource).toContain("readonly result: PuttingRecommendationResultV1;");
    const props = panelSource.slice(
      panelSource.indexOf("interface PuttingRecommendationsPanelProps {"),
      panelSource.indexOf("// ─── Copy"),
    );
    expect(props.length).toBeGreaterThan(0);
    for (const forbidden of ["tier", "userId", "analysisId", "supabase", "analysis:"]) {
      expect(props, `the component must not accept ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// F-H. How the page invokes the authority
// ============================================================================

/** Everything on the page after the putting state resolver closes. */
function afterResolver(source: string = pageSource): string {
  const start = source.indexOf("const puttingState");
  expect(start, "putting state resolver not found").toBeGreaterThanOrEqual(0);
  const marker = "})();";
  const end = source.indexOf(marker, start);
  expect(end, "putting state resolver is unterminated").toBeGreaterThan(start);
  return source.slice(end + marker.length);
}

const INVOCATION_GATE = 'isPutt && puttingState !== null && "analysis" in puttingState';

describe("EQ5E-D authority invocation", () => {
  it("invokes the authority exactly once", () => {
    expect(countOccurrences(pageCode, "resolvePuttingDrillRecommendations(")).toBe(1);
  });

  it("invokes it after the existing putting state resolver, never inside it", () => {
    expect(afterResolver()).toContain("resolvePuttingDrillRecommendations(");
    const resolver = pageSource.slice(
      pageSource.indexOf("const puttingState"),
      pageSource.indexOf("})();") + "})();".length,
    );
    expect(resolver).not.toContain("resolvePuttingDrillRecommendations");
  });

  it("gates the call on a putting row whose analysis actually resolved", () => {
    expect(pageCode).toContain(INVOCATION_GATE);
  });

  it("passes the page's own authenticated client, identity, tier and owned row id", () => {
    const start = pageCode.indexOf("const puttingRecommendationResult");
    expect(start, "the recommendation derivation is missing").toBeGreaterThanOrEqual(0);
    const end = pageCode.indexOf(": null;", start);
    expect(end, "the recommendation derivation is unterminated").toBeGreaterThan(start);
    const call = pageCode.slice(start, end);
    expect(call).toContain("(supabase, {");
    expect(call).toContain("userId: user.id");
    expect(call).toContain("tier,");
    expect(call).toContain("sourceAnalysisId: swing.id");
  });

  it("builds no second client and reads no second identity", () => {
    expect(countOccurrences(pageCode, "await createClient()")).toBe(1);
    expect(countOccurrences(pageCode, "getServerSession()")).toBe(1);
  });

  it("adds no second ready construction and no second readiness rule", () => {
    expect(countOccurrences(pageSource, 'status: "ready"')).toBe(1);
    expect(pageCode).not.toContain('puttingState.status === "ready"');
    expect(pageCode).not.toContain('puttingRecommendationResult.status === "ready"');
  });

  it("still reads the database-owned family exactly once", () => {
    expect(countOccurrences(pageSource, "swing.analysis_family")).toBe(1);
  });

  it("re-validates, re-ranks and reshapes nothing", () => {
    const after = stripComments(afterResolver());
    for (const token of [
      "isPersistedPuttingAnalysisV1",
      ".recommendations",
      ".sort(",
      ".reverse(",
      ".filter(",
      ".slice(",
      "rank",
      'from("drills")',
    ]) {
      expect(after, `the consumer must not ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// I. Where it renders
// ============================================================================

describe("EQ5E-D render placement", () => {
  it("renders inside the putting region, after the analysis panel", () => {
    const region = puttingRegion();
    const analysis = region.indexOf("<PuttingAnalysisPanel");
    const suggestions = region.indexOf("<PuttingRecommendationsPanel");
    expect(analysis, "the analysis panel is missing from the putting region").toBeGreaterThanOrEqual(0);
    expect(suggestions, "the suggestions panel is missing from the putting region").toBeGreaterThan(
      analysis,
    );
  });

  it("mounts the suggestions panel exactly once on the whole page", () => {
    expect(countOccurrences(pageSource, "<PuttingRecommendationsPanel")).toBe(1);
  });

  it("renders nothing when the authority was never asked", () => {
    expect(puttingRegion()).toContain("{puttingRecommendationResult !== null && (");
  });

  it("hands the component the authority result and nothing else", () => {
    expect(puttingRegion()).toContain(
      "<PuttingRecommendationsPanel result={puttingRecommendationResult} />",
    );
    for (const prop of ["tier=", "userId=", "analysis=", "supabase="]) {
      expect(
        puttingRegion(),
        `the suggestions panel must not be handed ${prop}`,
      ).not.toContain(`<PuttingRecommendationsPanel ${prop}`);
    }
  });

  it("leaves the full-swing family untouched", () => {
    const fullSwing = pageSource.slice(
      pageSource.indexOf(FULL_SWING_REGION_START),
      pageSource.indexOf("SHARED STATUS REGION"),
    );
    expect(fullSwing).not.toContain("PuttingRecommendationsPanel");
    expect(fullSwing).not.toContain("puttingRecommendationResult");
  });
});

// ============================================================================
// J-Q. The presentation contract
// ============================================================================

describe("EQ5E-D presentation states", () => {
  it("handles exactly the four authority states", () => {
    for (const status of ["locked", "unavailable", "catalog_unavailable", "ready"]) {
      expect(panelCode, `the component must handle ${status}`).toContain(`case "${status}":`);
    }
    expect(countOccurrences(panelCode, "case \"")).toBe(4);
  });

  it("proves exhaustiveness through the type system", () => {
    expect(panelCode).toContain("const unhandled: never = result;");
  });

  it("keeps unavailable and catalog_unavailable distinguishable", () => {
    expect(panelSource).toContain(
      "Practice suggestions aren't available for this analysis.",
    );
    expect(panelSource).toContain("Practice suggestions are temporarily unavailable.");
  });

  it("does not reuse the analysis panel's re-record copy for a missing suggestion", () => {
    expect(panelCode).not.toContain("Record the stroke again");
  });

  it("states zero suggestions without praising or condemning the stroke", () => {
    expect(panelSource).toContain(
      "No specific putting drill is indicated by the available video observations.",
    );
    for (const claim of [
      /your stroke is (good|sound|solid)/i,
      /no problems/i,
      /nothing to work on/i,
      /\bperfect\b/i,
      /\bwell done\b/i,
      /\bgreat (stroke|work)\b/i,
    ]) {
      expect(claim.test(panelCode), `zero-suggestion copy must not claim ${claim}`).toBe(false);
    }
  });

  it("offers an upgrade route from the locked state and no drill content", () => {
    const locked = panelSource.slice(
      panelSource.indexOf("function LockedNotice()"),
      panelSource.indexOf("function SuggestionCard("),
    );
    expect(locked).toContain('href="/upgrade"');
    expect(locked).not.toContain("suggestion.");
  });

  it("preserves the authority's order rather than imposing one", () => {
    for (const token of [".sort(", ".reverse(", ".toSorted(", ".toReversed(", "localeCompare"]) {
      expect(panelCode, `the component must not ${token}`).not.toContain(token);
    }
    expect(panelCode).toContain("suggestions.map(");
  });

  it("shows no score, severity or confidence", () => {
    for (const token of ["score", "severity", "confidence", "priority", "probability"]) {
      expect(panelCode.toLowerCase(), `the component must not display ${token}`).not.toContain(token);
    }
  });
});

describe("EQ5E-D recommendation fields", () => {
  it("reads only the approved user-facing fields from a recommendation", () => {
    const read = new Set(
      Array.from(panelCode.matchAll(/\bsuggestion\.([A-Za-z_]+)/g)).map((m) => m[1]),
    );
    expect(Array.from(read).sort()).toEqual(
      ["name", "source_section", "the_feel", "the_how", "the_why"].sort(),
    );
  });

  it("reads only status and recommendations from the result", () => {
    const read = new Set(Array.from(panelCode.matchAll(/\bresult\.([A-Za-z_]+)/g)).map((m) => m[1]));
    expect(Array.from(read).sort()).toEqual(["recommendations", "status"].sort());
  });

  it("renders no internal rule-set or catalog metadata", () => {
    for (const token of [
      "drill_id",
      "target_category",
      "observed_assessment",
      "reason_code",
      "ruleset_version",
      "source_analysis_id",
    ]) {
      expect(panelCode, `the component must not render ${token}`).not.toContain(token);
    }
  });

  it("defers instructional video entirely", () => {
    expect(panelCode).not.toContain("instructional_video_url");
    expect(panelCode).not.toContain("<video");
    expect(panelCode).not.toContain("<iframe");
  });

  it("omits nullable catalog copy rather than inventing a placeholder", () => {
    expect(panelSource).toContain("function hasCopy(value: string | null): value is string {");
    for (const field of ["the_why", "the_how", "the_feel"]) {
      expect(panelCode, `${field} must be guarded`).toContain(`hasCopy(suggestion.${field})`);
    }
  });

  it("maps every source section the rule set can produce, and no other", () => {
    expect(panelSource).toContain(
      'Record<HydratedPuttingDrillRecommendationV1["source_section"], string>',
    );
    for (const section of ["setup_alignment", "face_at_impact", "stroke_path", "tempo_rhythm"]) {
      expect(panelSource, `missing section title for ${section}`).toContain(`${section}: "`);
    }
    // Sections the rule set never names must not appear, or the map would claim
    // a provenance the authority cannot produce.
    for (const section of ["stroke_symmetry", "stability"]) {
      expect(panelCode, `${section} is not a rule-set source section`).not.toContain(section);
    }
  });
});

// ============================================================================
// Q, R-V. Evidence, assignment and the write firewall
// ============================================================================

describe("EQ5E-D evidence language", () => {
  it("states the qualitative basis in product language", () => {
    expect(panelSource).toContain(
      "Suggested from qualitative video observations — not calibrated measurements.",
    );
  });

  it("claims no measurement of its own", () => {
    for (const pattern of [
      /°/,
      /\bdeg\b|\bdegrees?\b/i,
      /\bmm\b|\bmillimet(er|re)s?\b/i,
      /\bratio\b/i,
      /\bwas measured\b/i,
      /\bmeasured\s+(at|by)\b/i,
    ]) {
      expect(pattern.test(panelCode), `the component must not claim ${pattern}`).toBe(false);
    }
  });

  it("invents no prescription the catalog did not state", () => {
    for (const pattern of [
      /\breps?\b/i,
      /\brepetitions?\b/i,
      /\bsets\b/i,
      /\bseconds?\b/i,
      /\bminutes?\b/i,
      /\bdaily\b/i,
      /\btimes per\b/i,
    ]) {
      expect(pattern.test(panelCode), `the component must not prescribe ${pattern}`).toBe(false);
    }
  });
});

describe("EQ5E-D recommendation is not assignment", () => {
  it("uses no assignment, progress or verification vocabulary", () => {
    for (const pattern of [
      /\bassign/i,
      /\bverif/i,
      /\byour plan\b/i,
      /\bpractice plan\b/i,
      /\bin progress\b/i,
      /\bcompleted\b/i,
      /\bmark as\b/i,
      /\bstarted\b/i,
      /\bstreak\b/i,
      /\bcoach (assigned|prescribed)\b/i,
    ]) {
      expect(pattern.test(panelCode), `the component must not imply ${pattern}`).toBe(false);
    }
  });

  it("offers no control that could record practice", () => {
    for (const token of ["<button", "<input", "<form", "onClick", "onSubmit", "checkbox"]) {
      expect(panelCode, `the component must not render ${token}`).not.toContain(token);
    }
  });

  it("links to no practice, library or verification surface", () => {
    expect(panelCode).not.toContain("/drills");
    expect(panelCode).not.toContain("/api/verify-drill");
    expect(panelCode).not.toContain("user_drills");
    expect(panelCode).not.toContain("automated_prescriptions");
  });

  it("writes nothing, anywhere", () => {
    for (const token of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".storage", "from("]) {
      expect(panelCode, `the component must not call ${token}`).not.toContain(token);
    }
  });

  it("reaches no model surface", () => {
    for (const token of ["gemini", "generative-ai", "generativeai", "openai", "generatecontent"]) {
      expect(panelCode.toLowerCase(), `the component must not reach ${token}`).not.toContain(token);
    }
  });

  it("introduces no persistence or assignment on the page either", () => {
    const after = stripComments(afterResolver());
    for (const token of [
      "user_drills",
      "automated_prescriptions",
      "verify-drill",
      ".insert(",
      ".update(",
      ".upsert(",
      ".delete(",
      ".rpc(",
    ]) {
      expect(after, `the consumer must not touch ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// X-Y. Non-vacuity — every guard is proved able to fail
// ============================================================================

interface Guard {
  id: string;
  holds: (sources: { page: string; panel: string }) => boolean;
}

const SOURCES = { page: pageSource, panel: panelSource };

const GUARDS: readonly Guard[] = [
  {
    id: "the page imports the authority at runtime",
    holds: (s) => s.page.includes(RUNTIME_IMPORT),
  },
  {
    id: "the component references the authority as a type only",
    holds: (s) =>
      countOccurrences(stripComments(s.panel), AUTHORITY_SPECIFIER) === 1 &&
      new RegExp(`^import type \\{[^}]*\\} from "${AUTHORITY_SPECIFIER}";$`, "m").test(
        stripComments(s.panel),
      ),
  },
  {
    id: "the component is a Server Component",
    holds: (s) => !s.panel.includes('"use client"'),
  },
  {
    id: "the component imports only approved modules",
    holds: (s) =>
      importedModules(stripComments(s.panel)).every((mod) => ALLOWED_PANEL_MODULES.includes(mod)),
  },
  {
    id: "the invocation is gated on a resolved putting analysis",
    holds: (s) => stripComments(s.page).includes(INVOCATION_GATE),
  },
  {
    id: "the invocation sits outside the analysis resolver",
    holds: (s) => afterResolver(s.page).includes("resolvePuttingDrillRecommendations("),
  },
  {
    id: "the page adds no second ready construction",
    holds: (s) => countOccurrences(s.page, 'status: "ready"') === 1,
  },
  {
    id: "the suggestions panel renders after the analysis panel",
    holds: (s) => {
      const region = puttingRegion(s.page);
      return (
        region.indexOf("<PuttingRecommendationsPanel") > region.indexOf("<PuttingAnalysisPanel")
      );
    },
  },
  {
    id: "the component renders no internal metadata",
    holds: (s) =>
      ["drill_id", "target_category", "observed_assessment", "reason_code", "ruleset_version"].every(
        (token) => !stripComments(s.panel).includes(token),
      ),
  },
  {
    id: "the component defers instructional video",
    holds: (s) => !stripComments(s.panel).includes("instructional_video_url"),
  },
  {
    id: "the component imposes no order of its own",
    holds: (s) =>
      [".sort(", ".reverse(", ".toSorted("].every((token) => !stripComments(s.panel).includes(token)),
  },
  {
    id: "the component offers no practice-recording control",
    holds: (s) =>
      ["<button", "<input", "onClick"].every((token) => !stripComments(s.panel).includes(token)),
  },
  {
    id: "the component uses no assignment vocabulary",
    holds: (s) => !/\bassign/i.test(stripComments(s.panel)),
  },
  {
    id: "the component links to no verification surface",
    holds: (s) => !stripComments(s.panel).includes("/api/verify-drill"),
  },
  {
    id: "the zero-suggestion copy praises nothing",
    holds: (s) => !/your stroke is (good|sound|solid)/i.test(stripComments(s.panel)),
  },
  {
    id: "the component writes nothing",
    holds: (s) => [".insert(", ".rpc("].every((token) => !stripComments(s.panel).includes(token)),
  },
];

interface Regression {
  name: string;
  apply: (sources: { page: string; panel: string }) => { page: string; panel: string };
  breaks: readonly string[];
}

const REGRESSIONS: readonly Regression[] = [
  {
    name: "the page stops importing the authority",
    apply: (s) => ({ ...s, page: s.page.replace(RUNTIME_IMPORT, "") }),
    breaks: ["the page imports the authority at runtime"],
  },
  {
    name: "the component turns its type import into a value import",
    apply: (s) => ({ ...s, panel: s.panel.replace("import type {", "import {") }),
    breaks: ["the component references the authority as a type only"],
  },
  {
    name: "the component becomes a Client Component",
    apply: (s) => ({ ...s, panel: `"use client";\n${s.panel}` }),
    breaks: ["the component is a Server Component"],
  },
  {
    name: "the component imports a Supabase client",
    apply: (s) => ({
      ...s,
      panel: `import { createClient } from "@/utils/supabase/server";\n${s.panel}`,
    }),
    breaks: ["the component imports only approved modules"],
  },
  {
    name: "the invocation gate is dropped",
    apply: (s) => ({ ...s, page: s.page.replace(INVOCATION_GATE, "isPutt") }),
    breaks: ["the invocation is gated on a resolved putting analysis"],
  },
  {
    name: "the invocation is moved inside the analysis resolver",
    apply: (s) => {
      const withoutDerivation = s.page.replace(
        /const puttingRecommendationResult =[\s\S]*?: null;\n/,
        "",
      );
      return {
        ...s,
        page: withoutDerivation.replace(
          "  })();",
          "    const inside = await resolvePuttingDrillRecommendations(supabase, {});\n  })();",
        ),
      };
    },
    breaks: ["the invocation sits outside the analysis resolver"],
  },
  {
    name: "the page constructs a second ready state",
    apply: (s) => ({
      ...s,
      page: `${s.page}\nconst extra = { status: "ready", analysis: null };\n`,
    }),
    breaks: ["the page adds no second ready construction"],
  },
  {
    name: "the suggestions panel is hoisted above the analysis panel",
    apply: (s) => ({
      ...s,
      page: s.page
        .replace("<PuttingAnalysisPanel state={puttingState} />", "<AnalysisPanelPlaceholder />")
        .replace(
          "<PuttingRecommendationsPanel result={puttingRecommendationResult} />",
          "<PuttingAnalysisPanel state={puttingState} />",
        )
        .replace("<AnalysisPanelPlaceholder />", "<PuttingRecommendationsPanel result={null} />"),
    }),
    breaks: ["the suggestions panel renders after the analysis panel"],
  },
  {
    name: "a rule-set identifier is rendered",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst shown = "reason_code";\n` }),
    breaks: ["the component renders no internal metadata"],
  },
  {
    name: "instructional video is activated",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst media = "instructional_video_url";\n` }),
    breaks: ["the component defers instructional video"],
  },
  {
    name: "the component sorts the suggestions",
    apply: (s) => ({ ...s, panel: s.panel.replace("suggestions.map(", "suggestions.sort(") }),
    breaks: ["the component imposes no order of its own"],
  },
  {
    name: "a practice-recording control is added",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst control = "<button>Mark done</button>";\n` }),
    breaks: ["the component offers no practice-recording control"],
  },
  {
    name: "a drill is described as assigned",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst label = "Assigned by your coach";\n` }),
    breaks: ["the component uses no assignment vocabulary"],
  },
  {
    name: "a verification link is added",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst verify = "/api/verify-drill";\n` }),
    breaks: ["the component links to no verification surface"],
  },
  {
    name: "the zero-suggestion copy praises the stroke",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst copy = "Your stroke is good.";\n` }),
    breaks: ["the zero-suggestion copy praises nothing"],
  },
  {
    name: "the component writes a row",
    apply: (s) => ({ ...s, panel: `${s.panel}\nconst write = ".insert(";\n` }),
    breaks: ["the component writes nothing"],
  },
];

describe("EQ5E-D guards are non-vacuous", () => {
  it("every guard holds against the real sources", () => {
    const failing = GUARDS.filter((guard) => !guard.holds(SOURCES)).map((guard) => guard.id);
    expect(failing, "the committed sources must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS)("$name is caught", ({ apply, breaks }) => {
    const broken = apply(SOURCES);
    expect(
      broken.page !== SOURCES.page || broken.panel !== SOURCES.panel,
      "the mutation changed nothing",
    ).toBe(true);
    for (const id of breaks) {
      const guard = GUARDS.find((candidate) => candidate.id === id);
      expect(guard, `unknown guard: ${id}`).toBeDefined();
      expect(guard?.holds(broken), `guard did not fire: ${id}`).toBe(false);
    }
  });

  it("every guard is exercised by at least one regression", () => {
    const covered = new Set(REGRESSIONS.flatMap((regression) => regression.breaks));
    const uncovered = GUARDS.map((guard) => guard.id).filter((id) => !covered.has(id));
    expect(uncovered).toEqual([]);
  });
});
