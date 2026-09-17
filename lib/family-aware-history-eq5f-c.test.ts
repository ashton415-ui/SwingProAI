import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5F-C — family-aware history / progress UX
// ============================================================================
//
// Progress Hub lists every analysis a golfer owns, of every family. The
// full-swing numbers were already family-safe before this slice: a putt is
// excluded from both averages and renders a neutral em dash rather than a
// fabricated zero. What was missing was the golfer's side of it — a putting row
// looked like an ordinary swing row whose numbers happened to be blank, and the
// only way to learn otherwise was to open the result.
//
// EQ5F-C names the family in the row itself, and says out loud on Telemetry
// that Telemetry is a full-swing surface. It is presentation only:
//
//   * `analysis_family` stays database-owned and immutable. Nothing here writes
//     it, repairs it, infers it or adds a persistence state.
//   * no metric changes. No putting score is invented, estimated or displayed —
//     that is EQ5F-D's subject, and this suite actively forbids it here.
//   * no query, filter, route, entitlement or equipment authority moves.
//
// Three label states collapse to two golfer-facing names on purpose:
//
//   "putting"      → "Putting"
//   "full_swing"   → "Full Swing"
//   null           → "Full Swing"
//
// The null mapping is the load-bearing judgement. A literal null is not simply
// "old": the shipping router treats it as the valid no-club full-swing
// capability, so a null row really did receive a full-swing analysis and really
// is counted in the full-swing averages. A third label ("Legacy Swing", or a
// bare "Swing" beside "Full Swing") would advertise a distinction the product
// does not have and would misdescribe a null row recorded today.

const PROGRESS_HUB = "app/(dashboard)/dashboard/page.tsx";
const TELEMETRY = "app/(dashboard)/telemetry/page.tsx";

// Read-only witness. EQ5F-C deliberately does NOT rename the global navigation
// item; this file is never modified by this slice, and is read here only so
// that "no navigation rename" is a proven claim rather than an assumption.
const NAVIGATION = "components/navigation/dashboard-navigation.tsx";

const IMPLEMENTATION_FILES = [PROGRESS_HUB, TELEMETRY];

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code plus rendered copy.
 *
 * Every ban below is about what a page *does*, so none of them may fire on a
 * comment that documents the rule. Both edited files explain their constraints
 * in prose — the Progress Hub helper's docstring discusses the label the
 * product deliberately does not use, and the Telemetry filter spells out the
 * SQL predicate it refuses to write. A suite that failed on those sentences
 * would pressure the next author into deleting the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** Text from `start` up to (not including) the next `end`, or "" if either
 *  anchor is missing. Returning "" rather than throwing lets one helper serve
 *  both the live assertions and the in-memory regression replay below. */
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

function countLiteral(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

// ── Region isolation ────────────────────────────────────────────────────────

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

/** Progress Hub: the derivation block between the query and the JSX, minus its
 *  first line, so the frozen `const totalSwings = swings?.length ?? 0;` is not
 *  caught by the `?? 0` ban. */
function hubAverages(hub: string): string {
  const block = sliceBetween(stripComments(hub), "const totalSwings", "return (");
  return block.slice(block.indexOf("\n") + 1);
}

/** Telemetry: the `swing_analysis` select list. */
function telemetrySelect(telemetry: string): string {
  return sliceBetween(telemetry, '.from("swing_analysis")', "`)");
}

/** Telemetry: the application-side family filter expression. */
function telemetryFamilyFilter(telemetry: string): string {
  return sliceBetween(stripComments(telemetry), "const fullSwingRows", "const swingLogs");
}

/** Telemetry: the average derivation. */
function telemetryAverage(telemetry: string): string {
  return sliceBetween(stripComments(telemetry), "const scoreObservations", "return (");
}

/** Telemetry: the portal header, where the scope sentence lives. */
function telemetryHeader(telemetry: string): string {
  return sliceBetween(telemetry, "Portal header", "Summary stat bar");
}

// ── Frozen expressions ──────────────────────────────────────────────────────

const LABEL_SIGNATURE = "function analysisFamilyLabel(";
const PUTTING_BRANCH = 'if (family === "putting") return "Putting";';
const FULL_SWING_BRANCH = 'if (family === "full_swing") return "Full Swing";';
const NULL_RETURN = 'return "Full Swing";';

const FAMILY_CALL = "analysisFamilyLabel(swing.analysis_family)";
/** The label must reach the DOM as text, not as a class name or a colour. */
const FAMILY_TEXT_CHILD = />\s*\{analysisFamilyLabel\(swing\.analysis_family\)\}\s*</;

const CLUB_EXPRESSION =
  'getHistoricalEquipmentDisplayName(swing.equipment_snapshot) ?? swing.swing_video?.club ?? "Unknown"';
const SCORE_CELL = '{fullSwingScore(swing) !== null ? `${swing.score} pts` : "—"}';
const TEMPO_CELL = 'swing.analysis_family === "putting" ? "—" :';
const HISTORY_LINK = "/swings/${swing.id}";
const LEGACY_LINK = "/analyze/${swing.id}";

const SCOPE_SENTENCE =
  "Full-swing telemetry only. Putting analyses remain available in Progress Hub.";

const TELEMETRY_ALLOW_LIST =
  '(r) => r.analysis_family === null || r.analysis_family === "full_swing",';

const NAV_TELEMETRY_ITEM =
  '{ href: "/telemetry", label: "Telemetry Logs", icon: TrendingUp, bottomTab: false },';

/**
 * Any PostgREST/SQL-level filter on the family column, banned on both surfaces:
 * `analysis_family <> 'putting'` is *unknown* for a NULL row in SQL three-valued
 * logic, so it would silently discard the entire legacy population.
 */
const SQL_FAMILY_PREDICATE = /\.(?:neq|eq|in|not|or)\(\s*[`"']?analysis_family/;

/** Authority these two presentation surfaces must never acquire. */
const BANNED_AUTHORITY_TOKENS = [
  "createSignedUrl",
  ".insert(",
  ".update(",
  ".upsert(",
  ".delete(",
  "service_role",
  "auth.admin",
  "resolvePuttingDrillRecommendations",
  "canUsePutting",
  "PuttingRecommendationsPanel",
  "<video",
];

/** EQ5F-D owns any numeric putting score. None of these may appear here. */
const BANNED_PUTTING_SCORE_TOKENS = [
  "puttingScore",
  "putting_score",
  "PuttingScore",
  "PUTTING_SCORE",
  "derivePutting",
];

/** Putting metric columns the Progress Hub must not start rendering. */
const BANNED_PUTTING_METRIC_TOKENS = [
  "putt_tempo_ratio",
  "face_angle_at_impact_deg",
  "path_deviation_mm",
];

interface Sources {
  hub: string;
  telemetry: string;
  nav: string;
}

function liveSources(): Sources {
  return {
    hub: readSource(PROGRESS_HUB),
    telemetry: readSource(TELEMETRY),
    nav: readSource(NAVIGATION),
  };
}

interface Guard {
  id: string;
  holds: (s: Sources) => boolean;
}

// ── The contract, as reusable predicates ────────────────────────────────────
//
// Numbered to match the frozen EQ5F-C contract one-to-one. They are predicates
// rather than inline assertions so the non-vacuity section at the bottom can
// replay every one of them against deliberately regressed source, in memory,
// without touching disk.

const GUARDS: Guard[] = [
  {
    id: "1. one module-scope family-label authority exists on the Progress Hub",
    holds: (s) => {
      const code = stripComments(s.hub);
      const declarations = countLiteral(code, LABEL_SIGNATURE);
      const declaredAt = code.indexOf(LABEL_SIGNATURE);
      const component = code.indexOf("export default async function DashboardPage(");
      return declarations === 1 && declaredAt >= 0 && component > declaredAt;
    },
  },
  {
    id: '2. "putting" maps to "Putting"',
    holds: (s) => topLevelFunction(s.hub, LABEL_SIGNATURE).includes(PUTTING_BRANCH),
  },
  {
    id: '3. "full_swing" maps to "Full Swing"',
    holds: (s) => topLevelFunction(s.hub, LABEL_SIGNATURE).includes(FULL_SWING_BRANCH),
  },
  {
    // Proven positionally: whatever survives both explicit branches — which is
    // exactly null, by the column's type — must return the full-swing label.
    id: '4. null maps to "Full Swing"',
    holds: (s) => {
      const fn = topLevelFunction(s.hub, LABEL_SIGNATURE);
      const afterExplicitBranches = fn.indexOf(FULL_SWING_BRANCH);
      if (afterExplicitBranches < 0) return false;
      const tail = fn.slice(afterExplicitBranches + FULL_SWING_BRANCH.length);
      return tail.includes(NULL_RETURN) && !tail.includes("null");
    },
  },
  {
    id: '5. no "Legacy Swing" family label is introduced',
    holds: (s) =>
      !stripComments(s.hub).includes("Legacy Swing") &&
      !stripComments(s.telemetry).includes("Legacy Swing"),
  },
  {
    id: "6. desktop history renders the shared family-label helper",
    holds: (s) => hubDesktopTable(s.hub).includes(FAMILY_CALL),
  },
  {
    id: "7. phone history renders the shared family-label helper",
    holds: (s) => hubPhoneList(s.hub).includes(FAMILY_CALL),
  },
  {
    id: "8. desktop and phone expose equivalent textual family semantics",
    holds: (s) => {
      const phone = hubPhoneList(s.hub);
      const desktop = hubDesktopTable(s.hub);
      return (
        countLiteral(phone, FAMILY_CALL) === 1 &&
        countLiteral(desktop, FAMILY_CALL) === 1 &&
        countLiteral(s.hub, FAMILY_CALL) === 2
      );
    },
  },
  {
    id: "9. family meaning is textual, not colour-only",
    holds: (s) =>
      FAMILY_TEXT_CHILD.test(hubPhoneList(s.hub)) && FAMILY_TEXT_CHILD.test(hubDesktopTable(s.hub)),
  },
  {
    id: "10. the table gains no new column for family",
    holds: (s) => {
      const table = hubDesktopTable(s.hub);
      if (countOccurrences(table, /<th\b/g) !== 6) return false;
      for (const field of ["Timestamp", "Club", "Score", "Tempo", "Status"]) {
        if (!table.includes(`<th className="px-8 py-4">${field}</th>`)) return false;
      }
      return table.includes('<th className="px-8 py-4"></th>');
    },
  },
  {
    id: "11. putting Score retains the exact neutral em-dash behaviour",
    holds: (s) =>
      [hubPhoneList(s.hub), hubDesktopTable(s.hub)].every(
        (region) => region.length > 0 && region.includes(SCORE_CELL),
      ),
  },
  {
    id: "12. putting Tempo retains the exact neutral em-dash behaviour",
    holds: (s) =>
      [hubPhoneList(s.hub), hubDesktopTable(s.hub)].every(
        (region) => region.length > 0 && region.includes(TEMPO_CELL),
      ),
  },
  {
    id: "13. no putting score or tempo numeric derivation appears",
    holds: (s) => {
      const code = stripComments(s.hub);
      return BANNED_PUTTING_METRIC_TOKENS.every((token) => !code.includes(token));
    },
  },
  {
    id: "14. fullSwingScore still gates non-full-swing-compatible rows",
    holds: (s) =>
      topLevelFunction(s.hub, "function fullSwingScore(").includes(
        "if (!isFullSwingCompatible(swing)) return null;",
      ),
  },
  {
    id: "15. isFullSwingCompatible still accepts the legacy null family",
    holds: (s) =>
      topLevelFunction(s.hub, "function isFullSwingCompatible(").includes(
        "swing.analysis_family === null",
      ),
  },
  {
    id: '16. isFullSwingCompatible still accepts an explicit "full_swing" family',
    holds: (s) =>
      topLevelFunction(s.hub, "function isFullSwingCompatible(").includes(
        'swing.analysis_family === "full_swing"',
      ),
  },
  {
    id: "17. isFullSwingCompatible remains a positive allow-list",
    holds: (s) => {
      const fn = topLevelFunction(s.hub, "function isFullSwingCompatible(");
      return fn.length > 0 && !fn.includes("putting") && !fn.includes("!==");
    },
  },
  {
    id: "18. score observations remain family-gated",
    holds: (s) =>
      hubAverages(s.hub).includes("isFullSwingCompatible(a) && isNumericObservation(a.score)"),
  },
  {
    id: "19. tempo observations remain family-gated",
    holds: (s) =>
      hubAverages(s.hub).includes("isFullSwingCompatible(a) && isNumericObservation(a.tempo_ratio)"),
  },
  {
    id: "20. score and tempo keep independent denominators",
    holds: (s) => {
      const averages = hubAverages(s.hub);
      return (
        averages.includes("/ scoreObservations.length") &&
        averages.includes("/ tempoObservations.length")
      );
    },
  },
  {
    id: "21. no average divides by the raw row count",
    holds: (s) => !hubAverages(s.hub).includes("swings.length"),
  },
  {
    id: "22. no missing metric is replaced with a fabricated zero",
    holds: (s) => !hubAverages(s.hub).includes("?? 0"),
  },
  {
    id: "23. the historical equipment expression remains present exactly twice",
    holds: (s) => countLiteral(s.hub, CLUB_EXPRESSION) === 2,
  },
  {
    id: "24. history links remain the canonical /swings/<id> route",
    holds: (s) =>
      hubPhoneList(s.hub).includes(HISTORY_LINK) && hubDesktopTable(s.hub).includes(HISTORY_LINK),
  },
  {
    id: "25. no /analyze/<id> history destination is introduced",
    holds: (s) => !stripComments(s.hub).includes(LEGACY_LINK),
  },
  {
    id: "26. Telemetry retains analysis_family in its select",
    holds: (s) => telemetrySelect(s.telemetry).includes("analysis_family"),
  },
  {
    id: "27. Telemetry retains the null + full_swing allow-list",
    holds: (s) => telemetryFamilyFilter(s.telemetry).includes(TELEMETRY_ALLOW_LIST),
  },
  {
    id: "28. putting remains excluded before SwingLog construction",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      const filter = code.indexOf("const fullSwingRows");
      const build = code.indexOf("const swingLogs: SwingLog[] = fullSwingRows.map((r) => {");
      return (
        filter >= 0 && build > filter && !code.includes("(swingResult.data ?? []).map(")
      );
    },
  },
  {
    id: "29. no SQL/PostgREST family predicate is introduced",
    holds: (s) =>
      !SQL_FAMILY_PREDICATE.test(stripComments(s.hub)) &&
      !SQL_FAMILY_PREDICATE.test(stripComments(s.telemetry)),
  },
  {
    id: "30. the Telemetry average remains derived from the filtered swingLogs",
    holds: (s) => telemetryAverage(s.telemetry).includes("swingLogs.flatMap("),
  },
  {
    // Textual position proves nothing on its own: SwingLogCard is declared above
    // the page component but only ever runs on data the page hands it. What keeps
    // the optimizer unreachable for a putt is the data path, so that is what is
    // asserted — one call site inside the card, one card rendered from a timeline
    // item, and the timeline built from the already-filtered collection.
    id: "31. computeEquipmentInsight remains reachable only through a filtered SwingLog",
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
        code.includes('...swingLogs.map((d) => ({ kind: "swing" as const')
      );
    },
  },
  {
    id: "32. the exact Telemetry scope sentence is rendered in the portal header",
    holds: (s) => telemetryHeader(s.telemetry).includes(SCOPE_SENTENCE),
  },
  {
    // The sentence is a claim about the data flow. It may only stand while the
    // flow actually enforces it: the allow-list filters before construction and
    // nothing re-admits putting further down.
    id: "33. the Telemetry copy and its data-flow semantics agree",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      return (
        telemetryHeader(s.telemetry).includes(SCOPE_SENTENCE) &&
        telemetryFamilyFilter(s.telemetry).includes(TELEMETRY_ALLOW_LIST) &&
        code.includes("const swingLogs: SwingLog[] = fullSwingRows.map((r) => {") &&
        !code.includes('analysis_family === "putting"')
      );
    },
  },
  {
    id: "34. no Telemetry putting inclusion, tab or filter is introduced",
    holds: (s) => {
      const code = stripComments(s.telemetry);
      if (code.includes('analysis_family === "putting"')) return false;
      if (/const\s+puttingRows/.test(code)) return false;
      if (/familyTab|puttingTab|setFamilyFilter/.test(code)) return false;
      // The unrelated legacy metrics.putting_analysis card is untouched.
      return (
        code.includes('typeof raw.putting_analysis === "string"') &&
        code.includes("log.bio.putting_analysis")
      );
    },
  },
  {
    id: "35. no navigation rename is introduced",
    holds: (s) =>
      s.nav.includes(NAV_TELEMETRY_ITEM) &&
      !stripComments(s.hub).includes("dashboard-navigation") &&
      !stripComments(s.telemetry).includes("dashboard-navigation"),
  },
  {
    id: "36. no DB/API/persistence/entitlement/recommendation/video authority is introduced",
    holds: (s) => {
      const hub = stripComments(s.hub);
      const telemetry = stripComments(s.telemetry);
      if (countOccurrences(hub, /\.from\(/g) !== 1) return false;
      if (countOccurrences(telemetry, /\.from\(/g) !== 2) return false;
      if (countOccurrences(hub, /await supabase/g) !== 1) return false;
      return BANNED_AUTHORITY_TOKENS.every(
        (token) => !hub.includes(token) && !telemetry.includes(token),
      );
    },
  },
  {
    id: "37. no putting score authority is introduced",
    holds: (s) => {
      const hub = stripComments(s.hub);
      const telemetry = stripComments(s.telemetry);
      return BANNED_PUTTING_SCORE_TOKENS.every(
        (token) => !hub.includes(token) && !telemetry.includes(token),
      );
    },
  },
  {
    id: "38. no swingmaster-web implementation path is used",
    holds: (s) => !s.hub.includes("swingmaster-web") && !s.telemetry.includes("swingmaster-web"),
  },
];

function guardById(id: string): Guard {
  const found = GUARDS.find((g) => g.id === id);
  if (!found) throw new Error(`unknown guard: ${id}`);
  return found;
}

// ============================================================================
// The live contract
// ============================================================================

describe("EQ5F-C implementation files exist", () => {
  it.each(IMPLEMENTATION_FILES)("%s is present", (file) => {
    expect(existsSync(path.join(repoRoot, file)), `missing file: ${file}`).toBe(true);
  });

  it("the read-only navigation witness is present", () => {
    expect(existsSync(path.join(repoRoot, NAVIGATION)), `missing file: ${NAVIGATION}`).toBe(true);
  });
});

describe("EQ5F-C region anchors resolve against the real sources", () => {
  const sources = liveSources();

  it("the Progress Hub phone list, desktop table and average block all isolate", () => {
    expect(hubPhoneList(sources.hub).length, `${PROGRESS_HUB}: phone list not found`).toBeGreaterThan(0);
    expect(hubDesktopTable(sources.hub).length, `${PROGRESS_HUB}: desktop table not found`).toBeGreaterThan(0);
    expect(hubAverages(sources.hub).length, `${PROGRESS_HUB}: average block not found`).toBeGreaterThan(0);
  });

  it("the family-label helper isolates as a top-level function", () => {
    expect(
      topLevelFunction(sources.hub, LABEL_SIGNATURE).length,
      `${PROGRESS_HUB}: analysisFamilyLabel not found at module scope`,
    ).toBeGreaterThan(0);
  });

  it("the Telemetry select, filter, average and portal header all isolate", () => {
    expect(telemetrySelect(sources.telemetry).length, `${TELEMETRY}: select not found`).toBeGreaterThan(0);
    expect(telemetryFamilyFilter(sources.telemetry).length, `${TELEMETRY}: filter not found`).toBeGreaterThan(0);
    expect(telemetryAverage(sources.telemetry).length, `${TELEMETRY}: average not found`).toBeGreaterThan(0);
    expect(telemetryHeader(sources.telemetry).length, `${TELEMETRY}: portal header not found`).toBeGreaterThan(0);
  });

  it("stripComments removes prose without removing rendered copy", () => {
    const sample = [
      "// a Legacy Swing label is exactly what we do not ship",
      '/* .neq("analysis_family", "putting") would drop every legacy row */',
      'const label = "Legacy Swing stays when rendered";',
    ].join("\n");
    const stripped = stripComments(sample);
    expect(stripped, "line comments must be removed").not.toContain("exactly what we do not ship");
    expect(stripped, "block comments must be removed").not.toContain("would drop every legacy row");
    expect(stripped, "rendered copy must survive").toContain('const label = "Legacy Swing stays when rendered";');
    expect(
      SQL_FAMILY_PREDICATE.test(stripped),
      "a documented ban must not read as a violation once comments are stripped",
    ).toBe(false);
  });
});

describe("EQ5F-C — the frozen contract", () => {
  const sources = liveSources();
  it.each(GUARDS.map((g) => g.id))("%s", (id) => {
    expect(guardById(id).holds(sources), `"${id}" no longer holds`).toBe(true);
  });
});

// ============================================================================
// Non-vacuity
// ============================================================================
//
// Every guard above is a claim about source text, and such a claim is worthless
// if it would also pass on regressed source. Each entry below regresses the real
// files *in memory*, replays the named guards, and requires them to fail.
// Nothing is written to disk. A final coverage assertion proves that no guard
// sits outside this exercise.

/** Replaces text only inside one Progress Hub renderer. Both chips are
 *  deliberately byte-identical — that is the desktop/phone parity contract —
 *  so a plain `String.replace` could never address the desktop one. */
function mutateRegion(
  hub: string,
  which: "phone" | "desktop",
  from: string,
  to: string,
): string {
  const start =
    which === "phone" ? hub.search(/<ul className="[^"]*md:hidden[^"]*"/) : hub.indexOf("<table");
  if (start < 0) return hub;
  const end = which === "phone" ? hub.indexOf("</ul>", start) : hub.indexOf("</table>", start);
  if (end < 0) return hub;
  return hub.slice(0, start) + hub.slice(start, end).replace(from, to) + hub.slice(end);
}

/** Deletes a whole top-level function declaration from real source. */
function removeTopLevelFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return source;
  const end = source.indexOf("\n}", start);
  if (end < 0) return source;
  return source.slice(0, start) + source.slice(end + 3);
}

const COLOUR_ONLY_CHIP =
  '<span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${analysisFamilyLabel(swing.analysis_family) === "Putting" ? "bg-amber-400" : "bg-golf-green"}`} />';

const CHIP_TEXT_CHILD = "{analysisFamilyLabel(swing.analysis_family)}";

const TELEMETRY_FILTER_BLOCK =
  '  const fullSwingRows = (swingResult.data ?? []).filter(\n    (r) => r.analysis_family === null || r.analysis_family === "full_swing",\n  );\n\n';

interface Regression {
  name: string;
  apply: (s: Sources) => Sources;
  breaks: string[];
}

const REGRESSIONS: Regression[] = [
  {
    name: "the family-label helper is deleted outright",
    apply: (s) => ({ ...s, hub: removeTopLevelFunction(s.hub, LABEL_SIGNATURE) }),
    breaks: [
      "1. one module-scope family-label authority exists on the Progress Hub",
      '2. "putting" maps to "Putting"',
      '3. "full_swing" maps to "Full Swing"',
      '4. null maps to "Full Swing"',
    ],
  },
  {
    name: "putting is relabelled",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(PUTTING_BRANCH, 'if (family === "putting") return "Putt";'),
    }),
    breaks: ['2. "putting" maps to "Putting"'],
  },
  {
    name: "the explicit full_swing branch is removed",
    apply: (s) => ({ ...s, hub: s.hub.replace(`  ${FULL_SWING_BRANCH}\n`, "") }),
    breaks: ['3. "full_swing" maps to "Full Swing"'],
  },
  {
    name: "null falls through to a Legacy Swing label",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        `${FULL_SWING_BRANCH}\n  ${NULL_RETURN}`,
        `${FULL_SWING_BRANCH}\n  return "Legacy Swing";`,
      ),
    }),
    breaks: ['4. null maps to "Full Swing"', '5. no "Legacy Swing" family label is introduced'],
  },
  {
    name: "the desktop family chip is removed",
    apply: (s) => ({ ...s, hub: mutateRegion(s.hub, "desktop", CHIP_TEXT_CHILD, "") }),
    breaks: [
      "6. desktop history renders the shared family-label helper",
      "8. desktop and phone expose equivalent textual family semantics",
      "9. family meaning is textual, not colour-only",
    ],
  },
  {
    name: "the phone family chip is removed",
    apply: (s) => ({ ...s, hub: mutateRegion(s.hub, "phone", CHIP_TEXT_CHILD, "") }),
    breaks: [
      "7. phone history renders the shared family-label helper",
      "8. desktop and phone expose equivalent textual family semantics",
      "9. family meaning is textual, not colour-only",
    ],
  },
  {
    name: "the family chip becomes colour-only in one renderer",
    apply: (s) => ({
      ...s,
      hub: mutateRegion(
        s.hub,
        "desktop",
        `<span className="mt-1.5 inline-block px-2 py-0.5 rounded-full bg-white/5 border border-white/5 text-[9px] font-black uppercase tracking-widest text-gray-400">\n                        ${CHIP_TEXT_CHILD}\n                      </span>`,
        COLOUR_ONLY_CHIP,
      ),
    }),
    breaks: ["9. family meaning is textual, not colour-only"],
  },
  {
    name: "a dedicated family column is added to the table",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        '<th className="px-8 py-4">Club</th>',
        '<th className="px-8 py-4">Type</th>\n                  <th className="px-8 py-4">Club</th>',
      ),
    }),
    breaks: ["10. the table gains no new column for family"],
  },
  {
    name: "a putting row is given a numeric score",
    apply: (s) => ({
      ...s,
      hub: mutateRegion(s.hub, "desktop", SCORE_CELL, "{`${swing.score ?? 0} pts`}"),
    }),
    breaks: ["11. putting Score retains the exact neutral em-dash behaviour"],
  },
  {
    name: "a putting tempo number is derived from the putting columns",
    apply: (s) => ({
      ...s,
      hub: mutateRegion(
        s.hub,
        "desktop",
        `${TEMPO_CELL} swing.tempo_ratio?.toFixed(1) ?? "—"`,
        'swing.putt_tempo_ratio?.toFixed(1) ?? "—"',
      ),
    }),
    breaks: [
      "12. putting Tempo retains the exact neutral em-dash behaviour",
      "13. no putting score or tempo numeric derivation appears",
    ],
  },
  {
    name: "fullSwingScore stops gating non-compatible rows",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace("  if (!isFullSwingCompatible(swing)) return null;\n", ""),
    }),
    breaks: ["14. fullSwingScore still gates non-full-swing-compatible rows"],
  },
  {
    name: "compatibility drops the legacy null family",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        'swing.analysis_family === null || swing.analysis_family === "full_swing"',
        'swing.analysis_family === "full_swing"',
      ),
    }),
    breaks: ["15. isFullSwingCompatible still accepts the legacy null family"],
  },
  {
    name: "compatibility drops the explicit full_swing family",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        'swing.analysis_family === null || swing.analysis_family === "full_swing"',
        "swing.analysis_family === null",
      ),
    }),
    breaks: ['16. isFullSwingCompatible still accepts an explicit "full_swing" family'],
  },
  {
    name: "compatibility becomes a not-putting denial list",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        'swing.analysis_family === null || swing.analysis_family === "full_swing"',
        'swing.analysis_family !== "putting"',
      ),
    }),
    breaks: [
      "15. isFullSwingCompatible still accepts the legacy null family",
      '16. isFullSwingCompatible still accepts an explicit "full_swing" family',
      "17. isFullSwingCompatible remains a positive allow-list",
    ],
  },
  {
    name: "score observations lose their family gate",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        "isFullSwingCompatible(a) && isNumericObservation(a.score)",
        "isNumericObservation(a.score)",
      ),
    }),
    breaks: ["18. score observations remain family-gated"],
  },
  {
    name: "tempo observations lose their family gate",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        "isFullSwingCompatible(a) && isNumericObservation(a.tempo_ratio)",
        "isNumericObservation(a.tempo_ratio)",
      ),
    }),
    breaks: ["19. tempo observations remain family-gated"],
  },
  {
    name: "both averages revert to the raw row denominator",
    apply: (s) => ({
      ...s,
      hub: s.hub
        .split("/ scoreObservations.length")
        .join("/ swings.length")
        .split("/ tempoObservations.length")
        .join("/ swings.length"),
    }),
    breaks: [
      "20. score and tempo keep independent denominators",
      "21. no average divides by the raw row count",
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
    breaks: [
      "18. score observations remain family-gated",
      "22. no missing metric is replaced with a fabricated zero",
    ],
  },
  {
    name: "the desktop row reverts to the legacy club string",
    apply: (s) => ({
      ...s,
      hub: mutateRegion(s.hub, "desktop", CLUB_EXPRESSION, 'swing.swing_video?.club ?? "Unknown"'),
    }),
    breaks: ["23. the historical equipment expression remains present exactly twice"],
  },
  {
    name: "history links move back to the legacy /analyze route",
    apply: (s) => ({ ...s, hub: s.hub.split(HISTORY_LINK).join(LEGACY_LINK) }),
    breaks: [
      "24. history links remain the canonical /swings/<id> route",
      "25. no /analyze/<id> history destination is introduced",
    ],
  },
  {
    name: "Telemetry drops analysis_family from its select",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace("analysis_family, equipment_snapshot,", "equipment_snapshot,"),
    }),
    breaks: ["26. Telemetry retains analysis_family in its select"],
  },
  {
    name: "Telemetry admits every family into the mapping",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry
        .replace(TELEMETRY_FILTER_BLOCK, "")
        .replace(
          "const swingLogs: SwingLog[] = fullSwingRows.map((r) => {",
          "const swingLogs: SwingLog[] = (swingResult.data ?? []).map((r) => {",
        ),
    }),
    breaks: [
      "27. Telemetry retains the null + full_swing allow-list",
      "28. putting remains excluded before SwingLog construction",
      "33. the Telemetry copy and its data-flow semantics agree",
    ],
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
    breaks: ["29. no SQL/PostgREST family predicate is introduced"],
  },
  {
    name: "the Telemetry average reverts to the unfiltered rows",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace("swingLogs.flatMap(", "(swingResult.data ?? []).flatMap("),
    }),
    breaks: ["30. the Telemetry average remains derived from the filtered swingLogs"],
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
    breaks: ["31. computeEquipmentInsight remains reachable only through a filtered SwingLog"],
  },
  {
    name: "the Telemetry scope sentence is removed",
    apply: (s) => ({ ...s, telemetry: s.telemetry.replace(SCOPE_SENTENCE, "") }),
    breaks: [
      "32. the exact Telemetry scope sentence is rendered in the portal header",
      "33. the Telemetry copy and its data-flow semantics agree",
    ],
  },
  {
    name: "Telemetry gains a putting inclusion branch",
    apply: (s) => ({
      ...s,
      telemetry: s.telemetry.replace(
        "  const swingLogs: SwingLog[] = fullSwingRows.map((r) => {",
        '  const puttingRows = (swingResult.data ?? []).filter((r) => r.analysis_family === "putting");\n  const swingLogs: SwingLog[] = fullSwingRows.map((r) => {',
      ),
    }),
    breaks: ["34. no Telemetry putting inclusion, tab or filter is introduced"],
  },
  {
    name: "the global navigation item is renamed",
    apply: (s) => ({
      ...s,
      nav: s.nav.replace('label: "Telemetry Logs"', 'label: "Swing Telemetry"'),
    }),
    breaks: ["35. no navigation rename is introduced"],
  },
  {
    name: "the Progress Hub acquires a second data authority",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        "  const totalSwings = swings?.length ?? 0;",
        '  const { data: drills } = await supabase.from("drills").select("*");\n  const totalSwings = swings?.length ?? 0;',
      ),
    }),
    breaks: [
      "36. no DB/API/persistence/entitlement/recommendation/video authority is introduced",
    ],
  },
  {
    name: "a putting score authority is introduced on the Progress Hub",
    apply: (s) => ({
      ...s,
      hub: s.hub.replace(
        "  const totalSwings = swings?.length ?? 0;",
        "  const puttingScore = (swings ?? []).map((a) => a.putt_tempo_ratio ?? 0);\n  const totalSwings = swings?.length ?? 0;",
      ),
    }),
    breaks: [
      "13. no putting score or tempo numeric derivation appears",
      "37. no putting score authority is introduced",
    ],
  },
  {
    name: "an implementation path leaks into swingmaster-web",
    apply: (s) => ({
      ...s,
      hub: `import { legacyThing } from "swingmaster-web/lib/legacy";\n${s.hub}`,
    }),
    breaks: ["38. no swingmaster-web implementation path is used"],
  },
];

describe("EQ5F-C — the contract is non-vacuous", () => {
  const live = liveSources();

  it("every guard holds against the real, unmodified sources", () => {
    const failing = GUARDS.filter((g) => !g.holds(live)).map((g) => g.id);
    expect(failing, "the compliant source must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((r) => r.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((r) => r.name === name)!;
    const mutated = regression.apply(live);

    const changed =
      mutated.hub !== live.hub ||
      mutated.telemetry !== live.telemetry ||
      mutated.nav !== live.nav;
    expect(changed, `"${name}" altered no source — the simulation anchor is stale`).toBe(true);

    for (const id of regression.breaks) {
      expect(
        guardById(id).holds(mutated),
        `"${name}" was not detected by guard "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });

  it("every guard participates in at least one regression", () => {
    const exercised = new Set(REGRESSIONS.flatMap((r) => r.breaks));
    const unexercised = GUARDS.map((g) => g.id).filter((id) => !exercised.has(id));
    expect(unexercised, "a guard nothing can break is a guard that proves nothing").toEqual([]);
  });

  it("every regression names only guards that exist", () => {
    const known = new Set(GUARDS.map((g) => g.id));
    const unknown = REGRESSIONS.flatMap((r) => r.breaks).filter((id) => !known.has(id));
    expect(unknown, "a regression naming a nonexistent guard silently proves nothing").toEqual([]);
  });
});

// ============================================================================
// What this suite does not prove
// ============================================================================
//
// These are source contracts. They prove what the two pages are written to do;
// they do not prove what a browser does with the result. Specifically, this
// suite does NOT establish:
//
//   * rendered pixels, spacing, contrast or that the chip is legible
//   * real phone layout — no viewport is instantiated and no CSS is evaluated
//   * screen-reader output or focus order
//   * that production data contains any putting row at all
//   * that the deployed build serves this source
//
// Those belong to the production runtime acceptance gate, which requires an
// authenticated browser against the real deployment.
