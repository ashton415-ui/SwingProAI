/**
 * EQ5C-A — the canonical qualitative putting result consumer.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * EQ5B established that an uncalibrated phone video supports qualitative
 * observation and nothing else, and it enforced that on the way *in*: the
 * pipeline validates Gemini's output and persists a closed
 * PersistedPuttingAnalysisV1 envelope whose three numeric slots are the literal
 * string "unavailable".
 *
 * EQ5C-A is the matching guarantee on the way *out*. A payload that survived
 * the write-side firewall can still be betrayed by a reader that grades it,
 * converts an enum into degrees, or advertises a green map next to it. This
 * suite pins the reader.
 *
 * WHY THE UI ASSERTIONS ARE SOURCE SCANS
 * --------------------------------------
 * The result page is an async server component that opens a Supabase client,
 * and the panel is a client component. Vitest runs in the node environment here
 * with no jsdom and no renderer, so neither can be mounted. Structure is
 * therefore asserted against source -- but every claim is scoped to an isolated
 * region or to the panel file, so a change elsewhere can neither break these
 * nor quietly make them vacuous.
 *
 * The contract-level assertions below are genuinely behavioural: they execute
 * the pure contract module directly.
 *
 * A NOTE ON THE BANS
 * ------------------
 * The forbidden-vocabulary tests use anchored patterns, never bare substrings.
 * The design system's own colour token is `text-golf-green`, and the word
 * "summary" contains the letters "mm" -- a naive `.not.toContain("green")` or
 * `.not.toContain("mm")` would fail on correct code and teach the next reader
 * to weaken the suite. Word boundaries and phrase anchors are used instead.
 *
 * No database, no network, no Supabase client, no Gemini, no jsdom.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPersistedPuttingAnalysis,
  isPersistedPuttingAnalysisV1,
  validatePuttingModelResponse,
  PUTTING_SECTIONS,
  type PuttingModelResponse,
} from "./putting-analysis-contract";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const PANEL = "components/putting/PuttingAnalysisPanel.tsx";
const CONTRACT = "lib/putting-analysis-contract.ts";

const pageSource = readSource(RESULT_PAGE);
const panelSource = readSource(PANEL);
const contractSource = readSource(CONTRACT);

const PUTTING_REGION_START = "PUTTING RESULT REGION";
const FULL_SWING_REGION_START = "FULL SWING REPORT REGION";
const SHARED_STATUS_REGION_START = "SHARED STATUS REGION";

function regionBetween(startMarker: string, endMarker: string): string {
  const startIdx = pageSource.indexOf(startMarker);
  expect(startIdx, `${RESULT_PAGE}: missing region anchor ${startMarker}`).toBeGreaterThanOrEqual(0);
  const endIdx = pageSource.indexOf(endMarker, startIdx);
  expect(endIdx, `${RESULT_PAGE}: missing region anchor ${endMarker}`).toBeGreaterThan(startIdx);
  return pageSource.slice(startIdx, endIdx);
}

const puttingRegion = (): string => regionBetween(PUTTING_REGION_START, FULL_SWING_REGION_START);
const fullSwingRegion = (): string => regionBetween(FULL_SWING_REGION_START, SHARED_STATUS_REGION_START);

/**
 * Source with comments removed, for the forbidden-vocabulary bans below.
 *
 * Those bans are about what a putting row *renders* and *reads*, not about what
 * its documentation is allowed to say. A comment explaining why "Appears Open"
 * must never be shortened to "Open" is the rule being written down, and a
 * scanner that failed on it would pressure the next author to delete the
 * explanation to get green -- the exact opposite of what this suite is for.
 *
 * Region anchors live inside JSX comments, so regions are always sliced from
 * raw source first and stripped afterwards. Line comments are only removed when
 * they own the whole line, so a "//" inside a string literal is never eaten.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * The putting ANALYSIS surface: PuttingAnalysisPanel plus the page's putting
 * region.
 *
 * Deliberately no longer described as everything a putting row can render. The
 * region also mounts the EQ5E-D practice-suggestion presentation
 * (components/putting/PuttingRecommendationsPanel.tsx), which renders canonical
 * catalog drills by design and carries its own evidence, assignment and
 * ordering contract in lib/putting-recommendation-consumer-eq5e-d.test.ts. Only
 * its mount point is visible from here, so the bans below keep protecting the
 * qualitative analysis without reaching into a surface they were not written
 * for.
 */
function puttingAnalysisSurfaces(): { label: string; source: string }[] {
  return [
    { label: PANEL, source: panelSource },
    { label: `${RESULT_PAGE} (putting region)`, source: puttingRegion() },
  ];
}

/** The same two surfaces, reduced to code and rendered copy. */
function puttingAnalysisCode(): { label: string; source: string }[] {
  return puttingAnalysisSurfaces().map(({ label, source }) => ({
    label,
    source: stripComments(source),
  }));
}

const panelCode = stripComments(panelSource);

/**
 * A canonical payload reopened as a loose bag of keys, so the corruption tests
 * below can damage it. PersistedPuttingAnalysisV1 is an interface and therefore
 * has no index signature, so the widening goes through `unknown` -- the direct
 * cast is the one TypeScript rejects, and rightly.
 */
function mutableCopyOf(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
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

describe("the comment stripper used by the vocabulary bans actually works", () => {
  it("removes prose but keeps code and rendered copy", () => {
    expect(panelSource).toContain("// tier, performs no entitlement calculation");
    expect(panelCode).not.toContain("// tier, performs no entitlement calculation");
    expect(panelCode).toContain("export function PuttingAnalysisPanel");
    expect(panelCode).toContain("Qualitative observations from video");
  });
});

function baseResponse(): PuttingModelResponse {
  return {
    summary: "The stroke is compact and repeatable, with a settled lower body throughout.",
    setup_alignment: { assessment: "sound", observation: "The eyes sit over the ball at address." },
    stroke_path: { assessment: "arc", observation: "The path appears to arc gently inside." },
    face_at_impact: { assessment: "appears_square", observation: "Face at impact appears square to the path." },
    tempo_rhythm: { assessment: "smooth", observation: "The rhythm looks smooth and unhurried." },
    stroke_symmetry: { assessment: "balanced", observation: "Backswing and through-stroke look evenly matched." },
    stability: { assessment: "stable", observation: "The head stays quiet from address to finish." },
    primary_finding: "Alignment and stability are the strengths of this stroke.",
    practice_focus: "Work on maintaining a quieter lower body throughout the stroke.",
  };
}

// ─── 1-2 — the shared validator and its narrowing ─────────────────────────────

describe("the server result boundary reuses the one persisted-v1 validator", () => {
  it("imports the shared predicate rather than re-deriving validation", () => {
    expect(pageSource).toContain(
      'import { isPersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";'
    );
    expect(pageSource).toContain("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
  });

  it("adds no second validator to the page or the panel", () => {
    for (const { label, source } of [
      { label: RESULT_PAGE, source: pageSource },
      { label: PANEL, source: panelSource },
    ]) {
      expect(source, `${label} must not re-check the schema version itself`).not.toContain(
        "schema_version ==="
      );
      expect(source, `${label} must not re-check the evidence basis itself`).not.toContain(
        "evidence_basis ==="
      );
    }
  });

  it("declares the predicate as a type predicate, not a bare boolean", () => {
    expect(contractSource).toContain("): value is PersistedPuttingAnalysisV1 {");
  });

  it("narrows an unknown value to the canonical contract", () => {
    const stored: unknown = buildPersistedPuttingAnalysis(baseResponse());

    expect(isPersistedPuttingAnalysisV1(stored)).toBe(true);

    if (isPersistedPuttingAnalysisV1(stored)) {
      // These property reads do not compile against `unknown`. If the predicate
      // ever reverts to a plain boolean return, `tsc --noEmit` fails here --
      // which is the entire point of the signature change.
      expect(stored.schema_version).toBe(1);
      expect(stored.evidence_basis).toBe("ai_video_analysis_uncalibrated");
      expect(stored.numeric_measurements.putt_tempo_ratio).toBe("unavailable");
      expect(stored.face_at_impact.assessment).toBe("appears_square");
      expect(stored.practice_focus.length).toBeGreaterThan(0);
    } else {
      throw new Error("a freshly built canonical payload must validate");
    }
  });

  it("still fails closed on everything it rejected before", () => {
    expect(isPersistedPuttingAnalysisV1(null)).toBe(false);
    expect(isPersistedPuttingAnalysisV1(undefined)).toBe(false);
    expect(isPersistedPuttingAnalysisV1({})).toBe(false);

    const wrongVersion = mutableCopyOf(buildPersistedPuttingAnalysis(baseResponse()));
    wrongVersion.schema_version = 2;
    expect(isPersistedPuttingAnalysisV1(wrongVersion)).toBe(false);

    const numeric = mutableCopyOf(buildPersistedPuttingAnalysis(baseResponse()));
    numeric.numeric_measurements = {
      putt_tempo_ratio: 2,
      face_angle_at_impact_deg: "unavailable",
      path_deviation_mm: "unavailable",
    };
    expect(isPersistedPuttingAnalysisV1(numeric)).toBe(false);

    const extraKey = mutableCopyOf(buildPersistedPuttingAnalysis(baseResponse()));
    extraKey.green_reading = "breaks left";
    expect(isPersistedPuttingAnalysisV1(extraKey)).toBe(false);
  });
});

// ─── STATUS SUCCESS BOUNDARY — a canonical payload is never enough ────────────
//
// WHAT THIS SECTION EXISTS TO PREVENT
// -----------------------------------
// The first EQ5C-A implementation expressed success as the negation of the two
// in-flight statuses: anything that was not "processing" and not "pending" fell
// through to the validation call, so a row carrying a valid envelope was shown
// as a finished report whatever its status said. swing_analysis.status is
// unconstrained text -- `status text not null default 'pending'`, no CHECK
// constraint, and typed as a bare string -- so that deny-list was open to every
// value nobody thought to exclude, including "failed" and any status a later
// slice or a background worker introduces.
//
// It was not a theoretical gap. Nothing in the repository ever clears
// putting_analysis, and the failure path writes only { status: "failed" }, so a
// row that once completed keeps a valid envelope through every later
// transition. "Your analysis failed" and "here is your analysis" are not
// interchangeable.
//
// The contract is therefore a POSITIVE requirement of "complete", and the tests
// below are written as an enumeration rather than as a mirror of the guards --
// a deny-list in the test would have shared the implementation's blind spot,
// which is exactly how the original defect passed 2870 tests.
//
// HOW THE PROOF IS CONSTRUCTED
// ----------------------------
// The source assertions carry the proof: each guard must exist, in order, in
// the real page. The table then documents the outcome of every status the
// tracked vocabulary can produce. The model function is pinned to the source by
// the guard list and by a return-count assertion, so it cannot quietly drift
// into testing itself.

/** The putting state resolver as it appears in the page, and nothing else. */
function puttingResolverSource(): string {
  const start = pageSource.indexOf("const puttingState");
  expect(start, `${RESULT_PAGE}: putting state resolver not found`).toBeGreaterThanOrEqual(0);
  const marker = "})();";
  const end = pageSource.indexOf(marker, start);
  expect(end, `${RESULT_PAGE}: putting state resolver is unterminated`).toBeGreaterThan(start);
  return pageSource.slice(start, end + marker.length);
}

/**
 * The five guards, in the order the contract requires. Each entry is the exact
 * production line, so the ordering test below compares execution sites rather
 * than a paraphrase.
 */
const RESOLVER_GUARDS: readonly { label: string; source: string }[] = [
  {
    label: "entitlement short-circuit",
    source: 'if (!canUsePuttingAnalysis(tier)) return { status: "locked" };',
  },
  {
    label: "processing/pending early return",
    source: "if (isAwaitingResult) return null;",
  },
  {
    label: "positive complete boundary",
    source: 'if (swing.status !== "complete") return { status: "unavailable" };',
  },
  {
    label: "canonical validation",
    source: "if (isPersistedPuttingAnalysisV1(rawPuttingAnalysis)) {",
  },
  {
    label: "ready construction",
    source: 'return { status: "ready", analysis: rawPuttingAnalysis };',
  },
] as const;

describe("the resolver requires a completed analysis before it will show one", () => {
  it("contains all five guards", () => {
    const resolver = puttingResolverSource();
    for (const { label, source } of RESOLVER_GUARDS) {
      expect(resolver, `resolver is missing the ${label}`).toContain(source);
    }
  });

  it("runs them in the required order", () => {
    const resolver = puttingResolverSource();
    for (let i = 1; i < RESOLVER_GUARDS.length; i += 1) {
      const previous = RESOLVER_GUARDS[i - 1];
      const current = RESOLVER_GUARDS[i];
      expect(
        resolver.indexOf(previous.source),
        `${previous.label} must run before ${current.label}`,
      ).toBeLessThan(resolver.indexOf(current.source));
    }
  });

  it("validates only after the complete boundary has been cleared", () => {
    const resolver = puttingResolverSource();
    expect(resolver.indexOf('swing.status !== "complete"')).toBeLessThan(
      resolver.indexOf("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)"),
    );
  });

  it("constructs no ready state before the complete boundary", () => {
    const resolver = puttingResolverSource();
    const boundary = resolver.indexOf('swing.status !== "complete"');
    expect(boundary, "the complete boundary is missing").toBeGreaterThanOrEqual(0);
    expect(resolver.indexOf('status: "ready"')).toBeGreaterThan(boundary);
    // One construction site in the whole page, and it is inside the resolver.
    expect(countOccurrences(pageSource, 'status: "ready"')).toBe(1);
  });

  it("still defines the in-flight statuses exactly as before", () => {
    expect(pageSource).toContain(
      'const isAwaitingResult = swing.status === "processing" || swing.status === "pending";',
    );
  });

  it("requires completion positively rather than listing the failures", () => {
    // A deny-list is what the original defect was. Naming "failed" here would
    // fix that one case and leave every future status wide open again.
    const resolver = puttingResolverSource();
    expect(resolver).toContain('!== "complete"');
    expect(resolver, "the boundary must not enumerate failure statuses").not.toContain('"failed"');
  });

  it("has no path out of the resolver other than the five contract outcomes", () => {
    // Pins the shape, so the model below cannot drift away from the source: a
    // sixth branch would have to change this count.
    const resolver = puttingResolverSource();
    expect(countOccurrences(resolver, "return ")).toBe(5);
  });
});

// The four statuses the tracked runtime can currently produce. `pending` is
// also the column default, and the column accepts anything, which is why the
// unknown values below are part of the contract rather than a curiosity.
const TRACKED_STATUS_VOCABULARY = ["pending", "processing", "complete", "failed"] as const;

type ResolvedOutcome = "locked" | "no-panel" | "ready" | "unavailable";

/**
 * The contract, expressed independently of the page. Every branch here has a
 * verbatim counterpart asserted in RESOLVER_GUARDS above, and the resolver is
 * pinned to exactly five returns, so this cannot pass while the page disagrees.
 */
function expectedOutcome(
  entitled: boolean,
  status: string,
  payloadIsValid: boolean,
): ResolvedOutcome {
  if (!entitled) return "locked";
  if (status === "processing" || status === "pending") return "no-panel";
  if (status !== "complete") return "unavailable";
  if (payloadIsValid) return "ready";
  return "unavailable";
}

const STATUS_CASES: readonly {
  entitled: boolean;
  status: string;
  payloadIsValid: boolean;
  expected: ResolvedOutcome;
}[] = [
  // Entitled, and the analysis finished.
  { entitled: true, status: "complete", payloadIsValid: true, expected: "ready" },
  { entitled: true, status: "complete", payloadIsValid: false, expected: "unavailable" },

  // Entitled, still in flight: the shared banner speaks, not the panel.
  { entitled: true, status: "processing", payloadIsValid: true, expected: "no-panel" },
  { entitled: true, status: "processing", payloadIsValid: false, expected: "no-panel" },
  { entitled: true, status: "pending", payloadIsValid: true, expected: "no-panel" },
  { entitled: true, status: "pending", payloadIsValid: false, expected: "no-panel" },

  // Entitled, and the analysis did not finish. The first of these is the case
  // the original implementation got wrong.
  { entitled: true, status: "failed", payloadIsValid: true, expected: "unavailable" },
  { entitled: true, status: "failed", payloadIsValid: false, expected: "unavailable" },

  // Entitled, and the status is something this slice never wrote. The column
  // has no CHECK constraint, so these are reachable, not hypothetical.
  { entitled: true, status: "queued", payloadIsValid: true, expected: "unavailable" },
  { entitled: true, status: "queued", payloadIsValid: false, expected: "unavailable" },
  { entitled: true, status: "cancelled", payloadIsValid: true, expected: "unavailable" },
  { entitled: true, status: "error", payloadIsValid: true, expected: "unavailable" },
  { entitled: true, status: "COMPLETE", payloadIsValid: true, expected: "unavailable" },
  { entitled: true, status: "", payloadIsValid: true, expected: "unavailable" },

  // Unentitled: locked regardless of status or payload.
  { entitled: false, status: "complete", payloadIsValid: true, expected: "locked" },
  { entitled: false, status: "processing", payloadIsValid: true, expected: "locked" },
  { entitled: false, status: "pending", payloadIsValid: false, expected: "locked" },
  { entitled: false, status: "failed", payloadIsValid: true, expected: "locked" },
  { entitled: false, status: "queued", payloadIsValid: true, expected: "locked" },
] as const;

describe("the result status contract, enumerated", () => {
  it.each(STATUS_CASES)(
    "entitled=$entitled status=$status valid=$payloadIsValid -> $expected",
    ({ entitled, status, payloadIsValid, expected }) => {
      expect(expectedOutcome(entitled, status, payloadIsValid)).toBe(expected);
    },
  );

  it("covers every status the tracked runtime can write", () => {
    const covered = new Set(STATUS_CASES.map((c) => c.status));
    for (const status of TRACKED_STATUS_VOCABULARY) {
      expect(covered.has(status), `status ${status} is not covered by the table`).toBe(true);
    }
  });

  it("never returns ready for a status other than complete", () => {
    for (const status of [...TRACKED_STATUS_VOCABULARY, "queued", "cancelled", "error", "COMPLETE", ""]) {
      if (status === "complete") continue;
      expect(
        expectedOutcome(true, status, true),
        `a valid payload must not make ${status || "(empty)"} ready`,
      ).not.toBe("ready");
    }
  });

  it("treats a valid payload as insufficient on its own", () => {
    // The regression in one line: same payload, different status.
    expect(expectedOutcome(true, "complete", true)).toBe("ready");
    expect(expectedOutcome(true, "failed", true)).toBe("unavailable");
  });
});

// ─── 3 — the nine-section contract ────────────────────────────────────────────

describe("the ready state renders the nine canonical sections and nothing else", () => {
  it("titles all six assessment sections", () => {
    for (const title of [
      "Setup & Alignment",
      "Stroke Path",
      "Face at Impact",
      "Tempo & Rhythm",
      "Stroke Symmetry",
      "Stability",
    ]) {
      expect(panelSource, `panel is missing the ${title} section`).toContain(title);
    }
  });

  it("renders the three prose fields from the canonical payload", () => {
    expect(panelSource).toContain("analysis.summary");
    expect(panelSource).toContain("analysis.primary_finding");
    expect(panelSource).toContain("analysis.practice_focus");
    expect(panelSource).toContain("Primary Finding");
    expect(panelSource).toContain("Practice Focus");
  });

  it("iterates exactly the canonical section set", () => {
    for (const section of PUTTING_SECTIONS) {
      expect(panelSource, `panel is missing section key ${section}`).toContain(`"${section}"`);
    }
    // Section order is declared locally so the client bundle need not import the
    // contract module at runtime, but it is typed against PuttingSection -- the
    // label Records stop compiling if the canonical set ever changes.
    expect(panelSource).toContain("const SECTION_ORDER: readonly PuttingSection[]");
    expect(panelSource).toContain("Record<PuttingSection, string>");
  });

  it("reads no putting result source other than the canonical payload", () => {
    // Every payload read on the panel goes through `analysis.`; nothing else is
    // authoritative for a putting video result.
    expect(panelCode).not.toContain("swing.");
    expect(panelCode).not.toContain("metrics");
  });
});

// ─── 4-6 — assessment labels keep their caution ───────────────────────────────

describe("assessment labels preserve the evidence hedge", () => {
  it("keeps the Appears hedge on every face-at-impact label", () => {
    expect(panelSource).toContain('appears_square: "Appears Square"');
    expect(panelSource).toContain('appears_open: "Appears Open"');
    expect(panelSource).toContain('appears_closed: "Appears Closed"');
  });

  it("never renders an unhedged face-at-impact verdict", () => {
    // The bare forms would restate a model inference as observed fact.
    for (const bare of ['"Square"', '"Open"', '"Closed"']) {
      expect(panelCode, `an unhedged ${bare} label is a measurement claim`).not.toContain(bare);
    }
  });

  it("maps every remaining assessment value to its frozen label", () => {
    for (const pair of [
      'sound: "Sound"',
      'needs_attention: "Needs Attention"',
      'straight: "Straight"',
      'in_to_out: "In-to-Out"',
      'out_to_in: "Out-to-In"',
      'arc: "Arcing"',
      'smooth: "Smooth"',
      'rushed: "Rushed"',
      'decelerating: "Decelerating"',
      'uneven: "Uneven"',
      'balanced: "Balanced"',
      'backswing_dominant: "Backswing-Dominant"',
      'through_stroke_dominant: "Through-Stroke-Dominant"',
      'stable: "Stable"',
      'head_motion: "Head Motion"',
      'lower_body_motion: "Lower-Body Motion"',
      'mixed_motion: "Mixed Motion"',
    ]) {
      expect(panelSource, `missing assessment label mapping: ${pair}`).toContain(pair);
    }
  });

  it("maps unclear to Unclear and unavailable to Not Assessable", () => {
    expect(panelSource).toContain('unclear: "Unclear"');
    expect(panelSource).toContain('unavailable: "Not Assessable"');
    // Every section carries both, so an honest non-answer never falls through
    // to a fabricated one.
    const unclearCount = (panelSource.match(/unclear: "Unclear"/g) ?? []).length;
    const unavailableCount = (panelSource.match(/unavailable: "Not Assessable"/g) ?? []).length;
    expect(unclearCount).toBe(PUTTING_SECTIONS.length);
    expect(unavailableCount).toBe(PUTTING_SECTIONS.length);
  });
});

// ─── 7 — the empty observation is reported, never filled ──────────────────────

describe("an unassessable section is reported as itself", () => {
  it("falls back to fixed neutral copy rather than substitute analysis", () => {
    expect(panelSource).toContain("NOT_ASSESSABLE_NOTE");
    expect(panelSource).toContain("This section could not be assessed from the video.");
    expect(panelSource).toContain("observation.length > 0 ? observation : NOT_ASSESSABLE_NOTE");
  });

  it("the contract still permits an empty observation only when unavailable", () => {
    const emptyButAssessed: PuttingModelResponse = {
      ...baseResponse(),
      stability: { assessment: "stable", observation: "   " },
    };
    expect(validatePuttingModelResponse(emptyButAssessed).ok).toBe(false);

    const emptyAndUnavailable: PuttingModelResponse = {
      ...baseResponse(),
      stability: { assessment: "unavailable", observation: "" },
    };
    expect(validatePuttingModelResponse(emptyAndUnavailable).ok).toBe(true);
  });
});

// ─── 8 — the legacy numeric columns are gone from the read path ───────────────

describe("the putting result reads none of the legacy numeric columns", () => {
  it("consumes no legacy putting column anywhere on the putting analysis surface", () => {
    for (const { label, source } of puttingAnalysisSurfaces()) {
      for (const column of [
        "putt_tempo_ratio",
        "face_angle_at_impact_deg",
        "path_deviation_mm",
        "putt_analytics",
      ]) {
        expect(source, `${label} must not read ${column}`).not.toContain(column);
      }
    }
  });

  it("keeps the retired camelCase metric props out of the panel", () => {
    for (const prop of ["puttTempoRatio", "faceAngleAtImpactDeg", "pathDeviationMm"]) {
      expect(panelSource, `panel must not accept ${prop}`).not.toContain(prop);
    }
  });
});

// ─── 9 — measurement, green and aim vocabulary ────────────────────────────────
//
// Anchored patterns only. `text-golf-green` is the design system's colour token
// and "summary" contains the letters "mm", so bare substring bans would fail on
// correct code.

const FORBIDDEN_CLAIMS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /°/, why: "a degree symbol is a face-angle measurement claim" },
  { pattern: /\bdeg\b|\bdegrees?\b/i, why: "degrees are not produced by this pipeline" },
  { pattern: /\bmm\b|\bmillimet(er|re)s?\b/i, why: "millimetres are not produced by this pipeline" },
  { pattern: /\bratio\b/i, why: "a tempo ratio is not produced by this pipeline" },
  { pattern: /\d\s*:\s*1\b/, why: "an x:1 tempo figure is a fabricated measurement" },
  { pattern: /Tour[- ]ideal/i, why: "a Tour-ideal band implies a calibrated scale" },
  { pattern: /\bIdeal:/i, why: "an ideal range implies a measured value to compare against" },
  { pattern: /\bten feet\b|\b10\s*(ft|feet)\b/i, why: "path deviation at a stated distance is uncalibrated" },
  { pattern: /\bdynamic loft\b|\bloft\b/i, why: "dynamic loft is out of scope in v1" },
  { pattern: /green\s*(reading|read|topograph|map)/i, why: "green reading is out of scope" },
  { pattern: /\btopograph/i, why: "topography is out of scope" },
  { pattern: /\bundulation/i, why: "undulation is out of scope" },
  { pattern: /aim[- ]?line/i, why: "aim lines are out of scope" },
  { pattern: /recommended\s*entry/i, why: "a recommended entry is a target-line claim" },
  { pattern: /recommendedEntry/, why: "the legacy green-reading prop is retired" },
  { pattern: /UndulationGrid/, why: "the fabricated topography grid is retired" },
  { pattern: /greenReading/, why: "the legacy green-reading prop is retired" },
  { pattern: /\bcaddy\b|\bcaddie\b/i, why: "an AI caddy line is out of scope" },
  { pattern: /\bslope\b/i, why: "slope is out of scope" },
  { pattern: /\bgrain\b/i, why: "grain is out of scope" },
];

describe("the putting analysis surface makes no unsupported claim", () => {
  it.each(FORBIDDEN_CLAIMS)("rejects $why", ({ pattern, why }) => {
    for (const { label, source } of puttingAnalysisCode()) {
      expect(pattern.test(source), `${label}: ${why} (matched ${pattern})`).toBe(false);
    }
  });

  it("still states the evidence basis in product language", () => {
    expect(panelSource).toContain(
      "Qualitative observations from video — not calibrated measurements."
    );
  });

  it("does not surface the raw internal evidence token", () => {
    for (const { label, source } of puttingAnalysisCode()) {
      expect(source, `${label} must not print the internal token`).not.toContain(
        "ai_video_analysis_uncalibrated"
      );
    }
  });

  it("carries no tier-depth claim", () => {
    // All entitled tiers consume the same qualitative payload in EQ5C, so a
    // depth badge would advertise an analysis the server does not produce.
    for (const { label, source } of puttingAnalysisCode()) {
      for (const badge of ["Eagle Deep", "Birdie AI", "Ultra", "deeper"]) {
        expect(source, `${label} must not claim ${badge}`).not.toContain(badge);
      }
    }
  });
});

// ─── 10-11 — raw payload and raw HTML ─────────────────────────────────────────

describe("the canonical payload is never rendered raw", () => {
  it("serializes no putting payload into the UI", () => {
    expect(panelSource).not.toContain("JSON.stringify");
    expect(puttingRegion()).not.toContain("JSON.stringify");
  });

  it("renders no putting narrative through raw HTML", () => {
    expect(panelSource).not.toContain("dangerouslySetInnerHTML");
    expect(puttingRegion()).not.toContain("dangerouslySetInnerHTML");
  });

  it("leaves the unrelated full-swing raw-HTML block exactly where it was", () => {
    // The Deep Biomechanical Audit renders prose sanitised at write time by the
    // v1 analyze route. Banning dangerouslySetInnerHTML from the whole page
    // file would delete a working full-swing feature, so the ban is scoped to
    // the putting surfaces above and this asserts the full-swing one survives.
    expect(fullSwingRegion()).toContain("dangerouslySetInnerHTML");
  });
});

// ─── 12 — practice focus is not a drill prescription ──────────────────────────
//
// The analysis produces one line of practice-focus prose. EQ5E-D separately
// presents rule-set-selected catalog drills in its own component, which these
// bans do not scan. They exist so the two never merge: the focus line must not
// be relabelled as a prescribed drill, and the analysis surface must not start
// prescribing quantities of its own.

describe("practice focus stays focus text", () => {
  it("is labelled Practice Focus", () => {
    expect(panelSource).toContain("Practice Focus");
  });

  it("is never relabelled as a drill or a programme", () => {
    for (const word of ["Drill", "Exercise", "Protocol", "Routine", "Program"]) {
      for (const { label, source } of puttingAnalysisCode()) {
        expect(source, `${label} must not present focus text as a ${word}`).not.toContain(word);
      }
    }
  });

  it("prescribes no repetitions, sets or timings", () => {
    for (const pattern of [/\breps?\b/i, /\brepetitions?\b/i, /\bsets\b/i, /\bseconds?\b/i, /\bminutes?\b/i]) {
      for (const { label, source } of puttingAnalysisCode()) {
        expect(pattern.test(source), `${label} must not prescribe ${pattern}`).toBe(false);
      }
    }
  });
});

// ─── 13-14 — the family split ─────────────────────────────────────────────────

describe("the putting family suppresses every full-swing-only region", () => {
  it("renders no full-swing metric, panel or block for a putting row", () => {
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
      expect(region, `the putting region must not render ${anchor}`).not.toContain(anchor);
    }
  });

  it("keeps the shared header and status chrome available to a putt", () => {
    expect(pageSource).toContain("Back to Hub");
    expect(pageSource).toContain("original_filename");
    const shared = pageSource.slice(pageSource.indexOf(SHARED_STATUS_REGION_START));
    expect(shared).toContain("AI analysis in progress");
    expect(shared).toContain("Analysis queued");
  });
});

describe("full-swing and null-family rows are untouched", () => {
  it("keeps every full-swing render site intact", () => {
    const region = fullSwingRegion();
    for (const anchor of [
      "metricCards.map((m) => (",
      "{m.label}",
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
      expect(region, `the full-swing region lost ${anchor}`).toContain(anchor);
    }
  });

  it("keeps the six full-swing metric cards and their ideal ranges byte-for-byte", () => {
    // The card definitions sit in the page's derivation block, above the JSX,
    // so they are asserted against the file while their single render site is
    // asserted against the full-swing region above. Putting suppresses the
    // render, not the declaration.
    for (const card of [
      '{ label: "Swing Score", value: swing.score, unit: " pts", ideal: "80–100 pts" }',
      '{ label: "Tempo Ratio", value: swing.tempo_ratio, unit: ":1", ideal: "3.0 : 1" }',
      '{ label: "Swing Speed", value: swing.swing_speed_mph, unit: " mph", ideal: "90–110 mph" }',
      'label: "Spine Angle"',
      'label: "Hip Rotation"',
      'label: "Shoulder Rotation"',
    ]) {
      expect(pageSource, `full-swing metric card changed: ${card}`).toContain(card);
    }
    expect(countOccurrences(pageSource, "metricCards.map(")).toBe(1);
  });

  it("routes a null analysis_family down the full-swing path", () => {
    // Strict equality against "putting" means null -- the established
    // compatibility case for rows recorded without a club -- is false.
    expect(pageSource).toContain('const isPutt = swing.analysis_family === "putting";');
    expect(pageSource).not.toContain("analysis_family !== ");
  });
});

// ─── 15 — locked copy promises only what v1 delivers ──────────────────────────

describe("the locked state advertises only supported capabilities", () => {
  it("lists the qualitative capabilities the contract actually produces", () => {
    for (const capability of [
      "AI putting stroke analysis",
      "Setup & alignment observations",
      "Stroke-path tendencies",
      "Face appearance at impact",
      "Tempo & rhythm",
      "Stroke symmetry",
      "Stability",
      "Primary finding",
      "Practice focus",
    ]) {
      expect(panelSource, `locked copy is missing: ${capability}`).toContain(capability);
    }
  });

  it("promises no capability the pipeline cannot deliver", () => {
    // The retired copy advertised putt tempo ratios, face angle in degrees,
    // path deviation at 10ft, AI green topography maps and AI caddy aim-line
    // suggestions. None of those is produced, and the anchored bans above
    // already cover the whole panel file -- including this locked branch.
    expect(panelCode).not.toContain("Putt Tempo");
    expect(panelCode).not.toContain("Face Angle");
    expect(panelCode).not.toContain("Path Drift");
    expect(panelCode).not.toContain("personalized drill");
    expect(panelCode).not.toContain("Personalized drill");
  });

  it("keeps an upgrade route available", () => {
    expect(panelSource).toContain('href="/upgrade"');
  });
});
