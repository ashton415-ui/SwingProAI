import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5C-C — history / progress / telemetry family safety
// ============================================================================
//
// `analysis_family` is written by the database from the validated club at
// insert and is immutable afterwards. It has exactly three states:
//
//   "putting"      a putting analysis
//   "full_swing"   a full-swing analysis
//   null           a legacy row written before the column existed
//
// Production today is entirely legacy null rows, and EQ5C-D has not yet
// enabled client Putter execution, so no putting row exists to exercise these
// surfaces against. That is precisely why these are source contracts: they
// must hold *before* the first putting row appears, not after somebody
// notices a putt being averaged into a full-swing score.
//
// Two properties are load-bearing throughout:
//
//   1. Family tests are a positive allow-list (null or "full_swing"), never
//      "not putting". An unforeseen family value is then excluded from
//      full-swing numbers rather than quietly counted into them.
//
//   2. Family tests live in application code, never in a PostgREST/SQL
//      predicate. `analysis_family <> 'putting'` is *unknown* for a NULL row
//      in SQL three-valued logic, so a SQL filter would discard every legacy
//      row rather than keep it.

const PROGRESS_HUB = "app/(dashboard)/dashboard/page.tsx";
const TELEMETRY = "app/(dashboard)/telemetry/page.tsx";
const LEGACY_DETAIL = "app/(dashboard)/analyze/[id]/page.tsx";

const IMPLEMENTATION_FILES = [PROGRESS_HUB, TELEMETRY, LEGACY_DETAIL];

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code plus rendered copy.
 *
 * The bans below are about what a page *does*, so they must not fire on a
 * comment that documents the rule. A test that fails on the sentence
 * explaining a constraint pressures the next author to delete the
 * explanation, which is the opposite of what this suite is for. The telemetry
 * page, for instance, deliberately spells out `.neq("analysis_family", ...)`
 * in prose to record why it is not used.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** Text from `start` up to (not including) the next `end`, or "" if either
 *  anchor is missing. Returning "" rather than throwing lets the same helper
 *  serve both the live assertions and the mutated-source simulation below. */
function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  if (a < 0) return "";
  const b = source.indexOf(end, a + start.length);
  if (b < 0) return "";
  return source.slice(a, b);
}

/** A top-level function declaration, from its signature to its closing brace. */
function topLevelFunction(source: string, signature: string): string {
  const code = stripComments(source);
  const start = code.indexOf(signature);
  if (start < 0) return "";
  const end = code.indexOf("\n}", start);
  if (end < 0) return "";
  return code.slice(start, end + 2);
}

function countOccurrences(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

/**
 * Any PostgREST/SQL-level filter on the family column. Banned outright on
 * these three consumer surfaces: every one of them would drop the legacy NULL
 * population that makes up the entire current history.
 */
const SQL_FAMILY_PREDICATE = /\.(?:neq|eq|in|not|or)\(\s*[`"']?analysis_family/;

// ── Region isolation ────────────────────────────────────────────────────────

/** Progress Hub: the derivation block between the query and the JSX. */
function hubAggregates(hub: string): string {
  return sliceBetween(stripComments(hub), "const totalSwings", "return (");
}

/** The same block without its first line, so the frozen and legitimate
 *  `const totalSwings = swings?.length ?? 0;` is not caught by the `?? 0` ban. */
function hubAverages(hub: string): string {
  const block = hubAggregates(hub);
  return block.slice(block.indexOf("\n") + 1);
}

/** Progress Hub: the phone-only (md:hidden) record list, raw. */
function hubPhoneList(hub: string): string {
  const start = hub.search(/<ul className="[^"]*md:hidden[^"]*"/);
  if (start < 0) return "";
  const end = hub.indexOf("</ul>", start);
  if (end < 0) return "";
  return hub.slice(start, end);
}

/** Progress Hub: the desktop table, raw. */
function hubDesktopTable(hub: string): string {
  return sliceBetween(hub, "<table", "</table>");
}

/** Telemetry / legacy detail: the `swing_analysis` select list. */
function selectList(source: string): string {
  return sliceBetween(source, '.from("swing_analysis")', "`)");
}

/** Telemetry: the application-side family filter expression. */
function telemetryFamilyFilter(telemetry: string): string {
  return sliceBetween(stripComments(telemetry), "const fullSwingRows", "const swingLogs");
}

/** Telemetry: the average derivation. */
function telemetryAverage(telemetry: string): string {
  return sliceBetween(stripComments(telemetry), "const scoreObservations", "return (");
}

/** Legacy detail: the page handler body. */
function detailHandler(detail: string): string {
  const code = stripComments(detail);
  const start = code.indexOf("export default async function AnalysisPage(");
  return start < 0 ? "" : code.slice(start);
}

interface Sources {
  hub: string;
  telemetry: string;
  detail: string;
}

function liveSources(): Sources {
  return {
    hub: readSource(PROGRESS_HUB),
    telemetry: readSource(TELEMETRY),
    detail: readSource(LEGACY_DETAIL),
  };
}

interface Guard {
  id: string;
  holds: (s: Sources) => boolean;
}

// ── The contract, as reusable predicates ────────────────────────────────────
//
// Each entry is one frozen semantic property. They are predicates rather than
// inline assertions so the non-vacuity section at the bottom can replay every
// one of them against deliberately regressed source without touching disk.

const PROGRESS_HUB_GUARDS: Guard[] = [
  {
    id: "aggregate eligibility accepts the legacy null family",
    holds: (s) =>
      topLevelFunction(s.hub, "function isFullSwingCompatible(").includes(
        "swing.analysis_family === null",
      ),
  },
  {
    id: "aggregate eligibility accepts an explicit full_swing family",
    holds: (s) =>
      topLevelFunction(s.hub, "function isFullSwingCompatible(").includes(
        'swing.analysis_family === "full_swing"',
      ),
  },
  {
    id: "aggregate eligibility is an allow-list that never names putting",
    holds: (s) => {
      const compat = topLevelFunction(s.hub, "function isFullSwingCompatible(");
      return compat.length > 0 && !compat.includes("putting");
    },
  },
  {
    id: "score eligibility is family-gated",
    holds: (s) =>
      hubAverages(s.hub).includes("isFullSwingCompatible(a) && isNumericObservation(a.score)"),
  },
  {
    id: "tempo eligibility is family-gated",
    holds: (s) =>
      hubAverages(s.hub).includes("isFullSwingCompatible(a) && isNumericObservation(a.tempo_ratio)"),
  },
  {
    id: "an observation must be a real finite number",
    holds: (s) => {
      const fn = topLevelFunction(s.hub, "function isNumericObservation(");
      return fn.includes('typeof value === "number"') && fn.includes("Number.isFinite(value)");
    },
  },
  {
    id: "the score average divides by its own observation count",
    holds: (s) => {
      const avg = hubAverages(s.hub);
      return avg.includes("/ scoreObservations.length") && avg.includes("scoreObservations.length\n    ?");
    },
  },
  {
    id: "the tempo average divides by its own observation count",
    holds: (s) => {
      const avg = hubAverages(s.hub);
      return avg.includes("/ tempoObservations.length") && avg.includes("tempoObservations.length\n    ?");
    },
  },
  {
    id: "no average divides by the raw row count",
    holds: (s) => !hubAverages(s.hub).includes("swings.length"),
  },
  {
    id: "no average substitutes zero for a missing metric",
    holds: (s) => !hubAverages(s.hub).includes("?? 0"),
  },
  {
    id: "the Progress Hub query carries no SQL family predicate",
    holds: (s) => !SQL_FAMILY_PREDICATE.test(stripComments(s.hub)),
  },
  {
    id: "both history renderers still iterate every analysis",
    holds: (s) => countOccurrences(stripComments(s.hub), /\{swings\.map\(/g) === 2,
  },
  {
    id: "a putting row has no full-swing score to display",
    holds: (s) =>
      topLevelFunction(s.hub, "function fullSwingScore(").includes(
        "if (!isFullSwingCompatible(swing)) return null;",
      ),
  },
  {
    id: "both score cells fall back to the neutral em dash",
    holds: (s) =>
      [hubPhoneList(s.hub), hubDesktopTable(s.hub)].every(
        (region) =>
          region.length > 0 &&
          region.includes('{fullSwingScore(swing) !== null ? `${swing.score} pts` : "—"}'),
      ),
  },
  {
    id: "both tempo cells render the neutral em dash for a putt",
    holds: (s) =>
      [hubPhoneList(s.hub), hubDesktopTable(s.hub)].every(
        (region) =>
          region.length > 0 && region.includes('swing.analysis_family === "putting" ? "—" :'),
      ),
  },
  {
    id: "an absent or invalid score is styled neutral, never red",
    holds: (s) => {
      const band = topLevelFunction(s.hub, "function scoreBandClassName(");
      const neutral = band.indexOf("if (score === null) return");
      const firstThreshold = band.indexOf("score >= 80");
      if (neutral < 0 || firstThreshold < 0 || neutral > firstThreshold) return false;
      const neutralReturn = band.slice(neutral, band.indexOf("\n", neutral));
      return (
        !neutralReturn.includes("red") &&
        !neutralReturn.includes("golf-green") &&
        !neutralReturn.includes("yellow")
      );
    },
  },
  {
    id: "real score thresholds and colour vocabulary are unchanged",
    holds: (s) => {
      const band = topLevelFunction(s.hub, "function scoreBandClassName(");
      return (
        band.includes('if (score >= 80) return "text-golf-green border-golf-green/20";') &&
        band.includes('if (score >= 60) return "text-yellow-400 border-yellow-400/20";') &&
        band.includes('return "text-red-400 border-red-500/20";')
      );
    },
  },
  {
    id: "both records link to the canonical family-aware detail route",
    holds: (s) =>
      hubPhoneList(s.hub).includes("/swings/${swing.id}") &&
      hubDesktopTable(s.hub).includes("/swings/${swing.id}"),
  },
  {
    id: "the phone renderer keeps the established tempo expression",
    holds: (s) => hubPhoneList(s.hub).includes('swing.tempo_ratio?.toFixed(1) ?? "—"'),
  },
  {
    id: "the phone renderer still sources its score from swing.score",
    holds: (s) => hubPhoneList(s.hub).includes("swing.score"),
  },
];

const TELEMETRY_GUARDS: Guard[] = [
  {
    id: "analysis_family is selected from swing_analysis",
    holds: (s) => selectList(s.telemetry).includes("analysis_family"),
  },
  {
    id: "no SQL family predicate is introduced",
    holds: (s) => !SQL_FAMILY_PREDICATE.test(stripComments(s.telemetry)),
  },
  {
    id: "compatibility accepts the legacy null family",
    holds: (s) => telemetryFamilyFilter(s.telemetry).includes("r.analysis_family === null"),
  },
  {
    id: "compatibility accepts an explicit full_swing family",
    holds: (s) => telemetryFamilyFilter(s.telemetry).includes('r.analysis_family === "full_swing"'),
  },
  {
    id: "the family filter is an allow-list that never names putting",
    holds: (s) => {
      const filter = telemetryFamilyFilter(s.telemetry);
      return filter.length > 0 && !filter.includes("putting");
    },
  },
  {
    id: "the family filter precedes SwingLog construction",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      const filter = code.indexOf("const fullSwingRows");
      const build = code.indexOf("const swingLogs: SwingLog[] =");
      return filter >= 0 && build > filter;
    },
  },
  {
    id: "SwingLogs are built only from the filtered collection",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      return (
        code.includes("const swingLogs: SwingLog[] = fullSwingRows.map((r) => {") &&
        !code.includes("(swingResult.data ?? []).map(")
      );
    },
  },
  {
    // Textual position proves nothing here: SwingLogCard is declared above the
    // page component but only ever runs on data the page hands it. What makes
    // the optimizer unreachable for a putt is the data path, so that is what
    // is asserted — the one call site lives inside SwingLogCard, the card is
    // rendered once from a timeline item, and the timeline is built from the
    // already-filtered swingLogs collection.
    id: "the equipment optimizer is reachable only through a filtered SwingLog",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      const cardStart = code.indexOf("function SwingLogCard({ log }: { log: SwingLog }) {");
      const call = code.indexOf("computeEquipmentInsight(log.bio, log.score)");
      return (
        cardStart >= 0 &&
        call > cardStart &&
        countOccurrences(code, /computeEquipmentInsight\(/g) === 2 &&
        countOccurrences(code, /<SwingLogCard/g) === 1 &&
        code.includes("log={item.data as SwingLog}") &&
        code.includes("...swingLogs.map((d) => ({ kind: \"swing\" as const")
      );
    },
  },
  {
    id: "the average is derived from the filtered SwingLog collection",
    holds: (s) => telemetryAverage(s.telemetry).includes("swingLogs.flatMap("),
  },
  {
    id: "detail links are generated only from the filtered SwingLog collection",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      const build = code.indexOf("const swingLogs: SwingLog[] =");
      return build >= 0 && countOccurrences(code, /\/analyze\/\$\{log\.id\}/g) === 2;
    },
  },
  {
    id: "the average requires a real finite numeric score",
    holds: (s) => {
      const avg = telemetryAverage(s.telemetry);
      return avg.includes('typeof s.score === "number"') && avg.includes("Number.isFinite(s.score)");
    },
  },
  {
    id: "the average numerator and denominator share one collection",
    holds: (s) => {
      const avg = telemetryAverage(s.telemetry);
      return avg.includes("scoreObservations.reduce(") && avg.includes("/ scoreObservations.length");
    },
  },
  {
    id: "completedSwings is no longer the denominator",
    holds: (s) => !stripComments(s.telemetry).includes("completedSwings"),
  },
  {
    id: "the average never substitutes zero for a missing score",
    holds: (s) => !telemetryAverage(s.telemetry).includes("?? 0"),
  },
  {
    id: "the unrelated legacy metrics.putting_analysis field is untouched",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      return (
        code.includes('typeof raw.putting_analysis === "string"') &&
        code.includes("log.bio.putting_analysis")
      );
    },
  },
  {
    id: "the range-session flow is untouched",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      return (
        code.includes('.from("range_sessions")') &&
        code.includes("parseRangeMetrics(") &&
        code.includes("const rangeLogs: RangeLog[]")
      );
    },
  },
];

const LEGACY_DETAIL_GUARDS: Guard[] = [
  {
    id: "analysis_family appears in the owned select",
    holds: (s) => selectList(s.detail).includes("analysis_family"),
  },
  {
    id: "the row-id ownership predicate is retained",
    holds: (s) => detailHandler(s.detail).includes('.eq("id", id)'),
  },
  {
    id: "the user-id ownership predicate is retained",
    holds: (s) => detailHandler(s.detail).includes('.eq("user_id", user.id)'),
  },
  {
    id: "the single-row constraint is retained",
    holds: (s) => detailHandler(s.detail).includes(".single()"),
  },
  {
    id: "the notFound guard precedes the putting redirect",
    holds: (s) => {
      const code = detailHandler(s.detail);
      const guard = code.indexOf('if (row.analysis_family === "putting")');
      const notFound = code.indexOf("if (error || !row) notFound();");
      return notFound >= 0 && guard > notFound;
    },
  },
  {
    id: "the redirect condition is strict equality on putting",
    holds: (s) => {
      const code = detailHandler(s.detail);
      return (
        code.includes('if (row.analysis_family === "putting") {') && !code.includes("analysis_family !==")
      );
    },
  },
  {
    id: "the destination is the canonical result route",
    holds: (s) => detailHandler(s.detail).includes("redirect(`/swings/${row.id}`);"),
  },
  {
    id: "the redirect precedes signed URL generation",
    holds: (s) => {
      const code = detailHandler(s.detail);
      const guard = code.indexOf('if (row.analysis_family === "putting")');
      const signed = code.indexOf("createSignedUrl");
      return guard >= 0 && signed > guard;
    },
  },
  {
    id: "the redirect precedes AnalysisData construction",
    holds: (s) => {
      const code = detailHandler(s.detail);
      const guard = code.indexOf('if (row.analysis_family === "putting")');
      const payload = code.indexOf("const analysis: AnalysisData");
      return guard >= 0 && payload > guard;
    },
  },
  {
    id: "the redirect precedes the full-swing report render",
    holds: (s) => {
      const code = detailHandler(s.detail);
      const guard = code.indexOf('if (row.analysis_family === "putting")');
      const report = code.indexOf("<AnalysisReport");
      return guard >= 0 && report > guard;
    },
  },
  {
    id: "the legacy route carries exactly one family guard",
    holds: (s) => countOccurrences(detailHandler(s.detail), /analysis_family/g) === 2,
  },
  {
    id: "no putting result renderer is duplicated onto this route",
    holds: (s) =>
      !s.detail.includes("PuttingAnalysisPanel") &&
      !s.detail.includes("putting-analysis-contract") &&
      !s.detail.includes("PuttingResultState"),
  },
  {
    id: "the legacy detail query carries no SQL family predicate",
    holds: (s) => !SQL_FAMILY_PREDICATE.test(stripComments(s.detail)),
  },
];

const ALL_GUARDS: { surface: string; guards: Guard[] }[] = [
  { surface: "Progress Hub", guards: PROGRESS_HUB_GUARDS },
  { surface: "Telemetry", guards: TELEMETRY_GUARDS },
  { surface: "legacy /analyze/[id]", guards: LEGACY_DETAIL_GUARDS },
];

function guardById(id: string): Guard {
  for (const { guards } of ALL_GUARDS) {
    const found = guards.find((g) => g.id === id);
    if (found) return found;
  }
  throw new Error(`unknown guard: ${id}`);
}

// ============================================================================
// The live contract
// ============================================================================

describe("EQ5C-C implementation files exist", () => {
  it.each(IMPLEMENTATION_FILES)("%s is present", (file) => {
    expect(existsSync(path.join(repoRoot, file)), `missing file: ${file}`).toBe(true);
  });
});

describe("EQ5C-C region anchors resolve against the real sources", () => {
  const sources = liveSources();

  it("the Progress Hub aggregate block, phone list and desktop table all isolate", () => {
    expect(hubAggregates(sources.hub).length, `${PROGRESS_HUB}: aggregate block not found`).toBeGreaterThan(0);
    expect(hubPhoneList(sources.hub).length, `${PROGRESS_HUB}: phone list not found`).toBeGreaterThan(0);
    expect(hubDesktopTable(sources.hub).length, `${PROGRESS_HUB}: desktop table not found`).toBeGreaterThan(0);
  });

  it("the Telemetry select, family filter and average all isolate", () => {
    expect(selectList(sources.telemetry).length, `${TELEMETRY}: select list not found`).toBeGreaterThan(0);
    expect(telemetryFamilyFilter(sources.telemetry).length, `${TELEMETRY}: family filter not found`).toBeGreaterThan(0);
    expect(telemetryAverage(sources.telemetry).length, `${TELEMETRY}: average block not found`).toBeGreaterThan(0);
  });

  it("the legacy detail handler and select isolate", () => {
    expect(detailHandler(sources.detail).length, `${LEGACY_DETAIL}: handler not found`).toBeGreaterThan(0);
    expect(selectList(sources.detail).length, `${LEGACY_DETAIL}: select list not found`).toBeGreaterThan(0);
  });

  it("stripComments removes prose without removing rendered copy", () => {
    const sample = [
      "// do not use ?? 0 here",
      '/* .neq("analysis_family", "putting") is wrong */',
      'const label = "?? 0 stays";',
    ].join("\n");
    const stripped = stripComments(sample);
    expect(stripped, "line comments must be removed").not.toContain("do not use");
    expect(stripped, "block comments must be removed").not.toContain("is wrong");
    expect(stripped, "rendered copy must survive").toContain('const label = "?? 0 stays";');
    expect(
      SQL_FAMILY_PREDICATE.test(stripped),
      "a documented ban must not read as a violation once comments are stripped",
    ).toBe(false);
  });
});

for (const { surface, guards } of ALL_GUARDS) {
  describe(`EQ5C-C — ${surface}`, () => {
    const sources = liveSources();
    it.each(guards.map((g) => g.id))("%s", (id) => {
      expect(guardById(id).holds(sources), `${surface}: "${id}" no longer holds`).toBe(true);
    });
  });
}

describe("EQ5C-C — the responsive history structure survives", () => {
  const hub = readSource(PROGRESS_HUB);

  it("keeps exactly one semantic table and its established width floor", () => {
    expect(countOccurrences(hub, /<table\b/g), `${PROGRESS_HUB}: expected exactly one <table`).toBe(1);
    expect(hub, `${PROGRESS_HUB}: desktop width floor changed`).toContain("min-w-[800px]");
  });

  it("keeps the phone list hidden from md up and the table hidden below md", () => {
    expect(hub, `${PROGRESS_HUB}: phone renderer must stay md:hidden`).toContain('className="md:hidden');
    expect(hub, `${PROGRESS_HUB}: desktop renderer must stay hidden md:block`).toContain('className="hidden md:block');
  });

  it("keeps the five log fields and the empty state", () => {
    for (const field of ["Timestamp", "Club", "Score", "Tempo", "Status"]) {
      expect(hub, `${PROGRESS_HUB}: desktop table lost its "${field}" column`).toContain(
        `<th className="px-8 py-4">${field}</th>`,
      );
    }
    expect(hub, `${PROGRESS_HUB}: empty state copy changed`).toContain("Telemetry Array Empty");
  });

  it("adds no second query and no second analysis-table read", () => {
    expect(countOccurrences(hub, /await supabase/g), `${PROGRESS_HUB}: a second query appeared`).toBe(1);
    expect(
      countOccurrences(hub, /\.from\("swing_analysis"\)/g),
      `${PROGRESS_HUB}: swing_analysis must be read exactly once`,
    ).toBe(1);
  });
});

describe("EQ5C-C — the Telemetry query is otherwise unchanged", () => {
  const telemetry = readSource(TELEMETRY);

  it("retains every previously selected field", () => {
    const select = selectList(telemetry);
    for (const field of [
      "id",
      "status",
      "score",
      "feedback",
      "created_at",
      "spine_angle",
      "hip_rotation",
      "shoulder_rotation",
      "metrics",
      "swing_highlights",
      "mechanical_deficiencies",
      "swing_video:swing_videos(club, original_filename)",
    ]) {
      expect(select, `${TELEMETRY}: select lost "${field}"`).toContain(field);
    }
  });

  it("retains ownership, ordering and the row ceiling", () => {
    expect(telemetry, `${TELEMETRY}: ownership filter changed`).toContain('.eq("user_id", user.id)');
    expect(telemetry, `${TELEMETRY}: ordering changed`).toContain('.order("created_at", { ascending: false })');
    expect(telemetry, `${TELEMETRY}: row ceiling changed`).toContain(".limit(50)");
  });
});

describe("EQ5C-C — client Putter execution remains fail-closed", () => {
  it("the analyze page still refuses a selected Putter before anything is mutated", () => {
    const analyze = readSource("app/(dashboard)/analyze/page.tsx");
    const guard = analyze.indexOf("isPuttingCapturePresentation(savedClubs, selectedClubId)");
    const upload = analyze.indexOf(".upload(");
    expect(guard, "the EQ3-S2 fail-closed guard is missing").toBeGreaterThanOrEqual(0);
    expect(upload, "the upload call must stay behind the fail-closed guard").toBeGreaterThan(guard);
  });
});

// ============================================================================
// Non-vacuity
// ============================================================================
//
// Every guard above is a claim about source text, and a claim about source
// text is worthless if it would also pass on a regressed file. Each entry here
// regresses the real source *in memory*, replays the named guards against the
// result, and requires them to fail. Nothing is written to disk.

interface Regression {
  name: string;
  apply: (s: Sources) => Sources;
  breaks: string[];
}

const PUTTING_GUARD_BLOCK =
  '  if (row.analysis_family === "putting") {\n    redirect(`/swings/${row.id}`);\n  }\n';

const REGRESSIONS: Regression[] = [
  {
    name: "the score denominator reverts to the raw row count",
    apply: (s) => ({ ...s, hub: s.hub.split("/ scoreObservations.length").join("/ swings.length") }),
    breaks: [
      "the score average divides by its own observation count",
      "no average divides by the raw row count",
    ],
  },
  {
    name: "the tempo denominator reverts to the raw row count",
    apply: (s) => ({ ...s, hub: s.hub.split("/ tempoObservations.length").join("/ swings.length") }),
    breaks: [
      "the tempo average divides by its own observation count",
      "no average divides by the raw row count",
    ],
  },
  {
    name: "a missing metric is substituted with zero",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        "isFullSwingCompatible(a) && isNumericObservation(a.score) ? [a.score] : []",
        "[a.score ?? 0]",
      ),
    }),
    breaks: ["score eligibility is family-gated", "no average substitutes zero for a missing metric"],
  },
  {
    name: "Progress Hub drops legacy null-family compatibility",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        'swing.analysis_family === null || swing.analysis_family === "full_swing"',
        'swing.analysis_family === "full_swing"',
      ),
    }),
    breaks: ["aggregate eligibility accepts the legacy null family"],
  },
  {
    name: "a score-less row is styled through the red band again",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace('  if (score === null) return "text-gray-600 border-white/5";\n', ""),
    }),
    breaks: ["an absent or invalid score is styled neutral, never red"],
  },
  {
    name: "putting rows are allowed into the Telemetry mapping",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry
        .replace(
          '  const fullSwingRows = (swingResult.data ?? []).filter(\n    (r) => r.analysis_family === null || r.analysis_family === "full_swing",\n  );\n\n',
          "",
        )
        .replace(
          "const swingLogs: SwingLog[] = fullSwingRows.map((r) => {",
          "const swingLogs: SwingLog[] = (swingResult.data ?? []).map((r) => {",
        ),
    }),
    breaks: [
      "compatibility accepts the legacy null family",
      "compatibility accepts an explicit full_swing family",
      "the family filter precedes SwingLog construction",
      "SwingLogs are built only from the filtered collection",
    ],
  },
  {
    name: "a second equipment-optimizer call escapes the SwingLog path",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace(
        "  const swingLogs: SwingLog[] = fullSwingRows.map((r) => {",
        "  const strayInsight = computeEquipmentInsight({}, null);\n  const swingLogs: SwingLog[] = fullSwingRows.map((r) => {",
      ),
    }),
    breaks: ["the equipment optimizer is reachable only through a filtered SwingLog"],
  },
  {
    name: "Telemetry filters the family in SQL instead of application code",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace(
        '      .eq("user_id", user.id)',
        '      .neq("analysis_family", "putting")\n      .eq("user_id", user.id)',
      ),
    }),
    breaks: ["no SQL family predicate is introduced"],
  },
  {
    name: "the Telemetry average reverts to the completed-row denominator",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace(
        "  const avgScore = scoreObservations.length\n    ? Math.round(scoreObservations.reduce((total, value) => total + value, 0) / scoreObservations.length)\n    : null;",
        '  const completedSwings = swingLogs.filter((s) => s.status === "complete").length;\n  const avgScore = completedSwings > 0\n    ? Math.round(swingLogs.filter((s) => s.score != null).reduce((a, s) => a + (s.score ?? 0), 0) / completedSwings)\n    : null;',
      ),
    }),
    breaks: [
      "the average numerator and denominator share one collection",
      "completedSwings is no longer the denominator",
      "the average never substitutes zero for a missing score",
    ],
  },
  {
    name: "the putting redirect is removed from the legacy route",
    apply: (s) => ({ ...s, detail: s.detail.replace(PUTTING_GUARD_BLOCK, "") }),
    breaks: [
      "the notFound guard precedes the putting redirect",
      "the redirect condition is strict equality on putting",
      "the destination is the canonical result route",
      "the redirect precedes signed URL generation",
      "the redirect precedes AnalysisData construction",
      "the redirect precedes the full-swing report render",
    ],
  },
  {
    name: "the putting redirect is moved after signed URL generation",
    apply: (s) => ({
      ...s,
      detail: s.detail
        .replace(PUTTING_GUARD_BLOCK, "")
        .replace(
          "  const analysis: AnalysisData = {",
          `${PUTTING_GUARD_BLOCK}\n  const analysis: AnalysisData = {`,
        ),
    }),
    breaks: ["the redirect precedes signed URL generation"],
  },
  {
    name: "the putting redirect is broadened beyond strict equality",
    apply: (s) => ({
      ...s,
      detail: s.detail.replace(
        'if (row.analysis_family === "putting") {',
        'if (row.analysis_family !== "full_swing") {',
      ),
    }),
    breaks: [
      "the redirect condition is strict equality on putting",
      "the notFound guard precedes the putting redirect",
    ],
  },
  {
    name: "the redirect destination is moved off the canonical route",
    apply: (s) => ({
      ...s,
      detail: s.detail.replace("redirect(`/swings/${row.id}`);", "redirect(`/analyze/${row.id}`);"),
    }),
    breaks: ["the destination is the canonical result route"],
  },
];

describe("EQ5C-C — the contract is non-vacuous", () => {
  const live = liveSources();

  it("every guard holds against the real, unmodified sources", () => {
    const failing = ALL_GUARDS.flatMap(({ surface, guards }) =>
      guards.filter((g) => !g.holds(live)).map((g) => `${surface}: ${g.id}`),
    );
    expect(failing, "the compliant source must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((r) => r.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((r) => r.name === name)!;
    const mutated = regression.apply(live);

    const changed =
      mutated.hub !== live.hub ||
      mutated.telemetry !== live.telemetry ||
      mutated.detail !== live.detail;
    expect(changed, `"${name}" altered no source — the simulation anchor is stale`).toBe(true);

    for (const id of regression.breaks) {
      expect(
        guardById(id).holds(mutated),
        `"${name}" was not detected by guard "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });
});
