import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// ============================================================================
// EQ5C-D — client Putter enablement
// ============================================================================
//
// Everything a putt needs already existed before this slice: the database
// derives `analysis_family` at insert, the analysis route reads that family and
// rereads the golfer's current `subscription_tier` before executing anything,
// and `/swings/[id]` renders the result behind its own entitlement check. The
// only thing missing was a way for an eligible golfer to press a button.
//
// So the risk here is not that putting works. It is that enabling the client
// quietly moves a decision into the browser that the server owns. Three
// properties carry that weight, and every assertion below exists to hold one of
// them:
//
//   1. The client may REFUSE early, but it may never AUTHORIZE. Its tier came
//      from the server layout at page load and can be stale; the route decides
//      again from the live database row.
//
//   2. The client may READ the family the server returned on a completed row.
//      It may never author one, send one, or infer one from the selector.
//
//   3. A putt must never be rendered through the full-swing mapper. It leaves
//      for the canonical result page instead.
//
// Preparation is deliberately not execution: a golfer whose plan excludes
// putting can still record and trim a putt. Only the analyzer action is locked.

const ANALYZE_PAGE = "app/(dashboard)/analyze/page.tsx";
const ANALYSIS_API = "app/api/analyze-swing/route.ts";
const ENTITLEMENTS = "lib/entitlements.ts";

/** Reads a repo-relative source file, normalized to LF. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Reduces source to code plus rendered copy. The bans below describe what the
 * page does, so they must not fire on a comment that documents the rule — the
 * Analyze page deliberately explains in prose why the client tier is not
 * authority, and a test that punished it for saying so would push the next
 * author to delete the explanation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

function sliceBetween(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  if (a < 0) return "";
  const b = source.indexOf(end, a + start.length);
  if (b < 0) return "";
  return source.slice(a, b);
}

function countOccurrences(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

// ── Region isolation ────────────────────────────────────────────────────────

const LOCKED_BRANCH_ANCHOR = "isPuttingCapture && !canUsePuttingAnalysis(userTier) ? (";

/** `startAnalysis`, isolated, so ordering is asserted against the real body. */
function submission(analyze: string): string {
  return sliceBetween(analyze, "const startAnalysis", "const setTime");
}

/** The unentitled-Putter guard at the top of `startAnalysis`. */
function puttingGuard(analyze: string): string {
  return sliceBetween(submission(analyze), "isPuttingCapturePresentation(", "}");
}

/** The client-authored `swing_analysis` INSERT object. */
function analysisInsert(analyze: string): string {
  return sliceBetween(submission(analyze), '.from("swing_analysis")', "}).select(");
}

/** The `/api/analyze-swing` request. */
function analysisRequest(analyze: string): string {
  return sliceBetween(submission(analyze), 'fetch("/api/analyze-swing"', "});");
}

/** Everything after the API response is parsed: the success routing decision. */
function successHandling(analyze: string): string {
  return sliceBetween(submission(analyze), "const { data: updatedRow }", "} catch (err");
}

/** The locked (unentitled) action-bar branch. */
function lockedActionBranch(analyze: string): string {
  return sliceBetween(analyze, LOCKED_BRANCH_ANCHOR, ") : (");
}

/** The two putting entitlement decision sites, where a duplicate plan matrix
 *  would do real damage by drifting from the server's. */
function puttingDecisionSites(analyze: string): { label: string; source: string }[] {
  return [
    { label: "startAnalysis guard", source: puttingGuard(analyze) },
    { label: "locked action branch", source: lockedActionBranch(analyze) },
  ];
}

const PLAN_LITERALS = ["birdie", "eagle", "coach_starter", "coach_pro"] as const;

// ── The contract, as reusable predicates ────────────────────────────────────

interface Sources {
  analyze: string;
  api: string;
}

function liveSources(): Sources {
  return { analyze: readSource(ANALYZE_PAGE), api: readSource(ANALYSIS_API) };
}

interface Guard {
  id: string;
  holds: (s: Sources) => boolean;
}

const GUARDS: Guard[] = [
  {
    id: "Analyze reuses the central entitlement helper",
    holds: (s) =>
      s.analyze.includes("canUsePuttingAnalysis,") &&
      s.analyze.includes('} from "@/lib/entitlements";') &&
      countOccurrences(stripComments(s.analyze), /canUsePuttingAnalysis\(/g) === 2,
  },
  {
    id: "no second plan matrix at either putting decision site",
    holds: (s) =>
      puttingDecisionSites(s.analyze).every(
        ({ source }) =>
          source.length > 0 && PLAN_LITERALS.every((tier) => !source.includes(tier)),
      ),
  },
  {
    id: "the unentitled refusal is conditional on the central helper",
    holds: (s) => {
      const guard = puttingGuard(s.analyze);
      return (
        guard.includes("isPuttingCapturePresentation(savedClubs, selectedClubId)") &&
        guard.includes("!canUsePuttingAnalysis(userTier)") &&
        guard.includes("setError(PUTTING_ANALYSIS_LOCKED_MESSAGE)")
      );
    },
  },
  {
    id: "the refusal precedes preprocessing",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        body.indexOf("!canUsePuttingAnalysis(userTier)") >= 0 &&
        body.indexOf("!canUsePuttingAnalysis(userTier)") < body.indexOf("await getTrimmedBlob()")
      );
    },
  },
  {
    id: "the refusal precedes the Storage upload",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        body.indexOf("!canUsePuttingAnalysis(userTier)") >= 0 &&
        body.indexOf("!canUsePuttingAnalysis(userTier)") < body.indexOf("supabase.storage")
      );
    },
  },
  {
    id: "the refusal precedes the swing_videos insert",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        body.indexOf("!canUsePuttingAnalysis(userTier)") >= 0 &&
        body.indexOf("!canUsePuttingAnalysis(userTier)") < body.indexOf('.from("swing_videos")')
      );
    },
  },
  {
    id: "the refusal precedes the swing_analysis insert",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        body.indexOf("!canUsePuttingAnalysis(userTier)") >= 0 &&
        body.indexOf("!canUsePuttingAnalysis(userTier)") < body.indexOf('.from("swing_analysis")')
      );
    },
  },
  {
    id: "the refusal precedes the analysis API call",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        body.indexOf("!canUsePuttingAnalysis(userTier)") >= 0 &&
        body.indexOf("!canUsePuttingAnalysis(userTier)") < body.indexOf('fetch("/api/analyze-swing"')
      );
    },
  },
  {
    id: "an entitled Putter is no longer globally refused",
    holds: (s) => {
      const code = stripComments(s.analyze);
      return (
        !code.includes("PUTTING ANALYSIS COMING SOON") &&
        !code.includes("PUTTING_ANALYSIS_UNAVAILABLE_MESSAGE") &&
        code.includes("RUN PUTTING ANALYSIS")
      );
    },
  },
  {
    id: "the entitled Putter action reaches startAnalysis",
    holds: (s) => {
      const locked = lockedActionBranch(s.analyze);
      const start = s.analyze.indexOf(LOCKED_BRANCH_ANCHOR);
      const executable = start < 0 ? "" : s.analyze.slice(s.analyze.indexOf(") : (", start));
      return (
        locked.length > 0 &&
        locked.includes("disabled") &&
        !locked.includes("onClick") &&
        executable.includes("onClick={startAnalysis}") &&
        executable.includes("RUN PUTTING ANALYSIS") &&
        executable.includes("RUN ANALYZER")
      );
    },
  },
  {
    id: "the client still writes club_id and authors no family",
    holds: (s) => {
      const insert = analysisInsert(s.analyze);
      return (
        insert.includes("club_id:") &&
        insert.includes("validatedClubId") &&
        !insert.includes("analysis_family")
      );
    },
  },
  {
    id: "the client authors no equipment_snapshot anywhere",
    holds: (s) => !s.analyze.includes("equipment_snapshot"),
  },
  {
    id: "no client code authors an analysis_family property",
    holds: (s) => !/[\b]?analysis_family[ ]*:/.test(s.analyze),
  },
  {
    id: "the API request body stays analysisId-only",
    holds: (s) => {
      const request = analysisRequest(s.analyze);
      if (!request.includes("JSON.stringify({ analysisId: analysisRow.id })")) return false;
      return ["analysis_family", "subscription_tier", "tier", "club_id", "club_type", "isPutting", "selectedPutter", "equipment_snapshot", "analysis_mode"].every(
        (field) => !request.includes(field),
      );
    },
  },
  {
    id: "success routing is decided by the server-returned family",
    holds: (s) => {
      const success = successHandling(s.analyze);
      return (
        success.includes('updatedRow.analysis_family === "putting"') &&
        !success.includes("selectedPutter") &&
        !success.includes("isPuttingCapture") &&
        !success.includes("userTier") &&
        !success.includes("canUsePuttingAnalysis")
      );
    },
  },
  {
    id: "a putting success navigates to the canonical result route",
    holds: (s) => successHandling(s.analyze).includes("router.push(`/swings/${analysisRow.id}`)"),
  },
  {
    id: "a putting success never reaches the full-swing mapper",
    holds: (s) => {
      const success = stripComments(successHandling(s.analyze));
      const decision = success.indexOf('updatedRow.analysis_family === "putting"');
      const push = success.indexOf("router.push(");
      const bail = success.indexOf("return;", push);
      const mapper = success.indexOf("setResult(dbRowToResult(updatedRow))");
      return decision >= 0 && push > decision && bail > push && mapper > bail;
    },
  },
  {
    id: "a full-swing success still renders inline",
    holds: (s) => successHandling(s.analyze).includes("setResult(dbRowToResult(updatedRow))"),
  },
  {
    id: "camera capture is never gated on putting entitlement",
    holds: (s) => {
      const code = stripComments(s.analyze);
      const cameraTokens = [
        "hasCameraRecordingCapability(",
        "cameraRecorderRef",
        "cameraStreamRef",
        "setCameraPhase(",
      ];
      // Every entitlement call belongs to one of the two putting decision sites,
      // so none of them can be gating the camera.
      return (
        countOccurrences(code, /canUsePuttingAnalysis\(/g) === 2 &&
        cameraTokens.every((token) => code.includes(token)) &&
        !code.includes("disabled={isPuttingCapture}")
      );
    },
  },
  {
    id: "an unknown tier fails closed through the existing par fallback",
    holds: (s) => {
      const reader = sliceBetween(s.analyze, "function getUserTier()", "\n}");
      return (
        reader.includes('return "par";') &&
        reader.includes('?? "par"') &&
        s.analyze.includes('useState<SubscriptionTier>("par")')
      );
    },
  },
  {
    id: "startAnalysis opens no fresh tier query",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return (
        !body.includes('.from("users")') &&
        !body.includes("subscription_tier") &&
        !body.includes("getUserTier(")
      );
    },
  },
  {
    id: "a refusal triggers no cleanup or deletion",
    holds: (s) => {
      const body = stripComments(submission(s.analyze));
      return !body.includes(".remove(") && !body.includes(".delete(");
    },
  },
  {
    id: "no putting result renderer is duplicated into Analyze",
    holds: (s) =>
      !s.analyze.includes("PuttingAnalysisPanel") &&
      !s.analyze.includes("putting-analysis-contract") &&
      !s.analyze.includes("putting_analysis"),
  },
  {
    id: "the server remains the putting execution authority",
    holds: (s) => {
      const code = stripComments(s.api);
      const family = code.indexOf("classifyAnalysisFamilyRoute(analysisRow.analysis_family)");
      const tier = code.indexOf('.select("subscription_tier")');
      const gate = code.indexOf("canUsePuttingAnalysis(currentTier)");
      const run = code.indexOf("runPuttingAnalysis(supabase, analysisRow, analysisId, user.id)");
      return (
        family >= 0 &&
        tier > family &&
        gate > tier &&
        run > gate &&
        code.includes(
          "Putting analysis isn't included with your current plan. Upgrade to unlock putting analysis.",
        )
      );
    },
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

describe("EQ5C-D source files exist", () => {
  it.each([ANALYZE_PAGE, ANALYSIS_API, ENTITLEMENTS])("%s is present", (file) => {
    expect(existsSync(path.join(repoRoot, file)), `missing file: ${file}`).toBe(true);
  });
});

describe("EQ5C-D region anchors resolve against the real source", () => {
  const sources = liveSources();

  it("isolates startAnalysis, the guard, the insert, the request and the success branch", () => {
    expect(submission(sources.analyze).length, "startAnalysis not found").toBeGreaterThan(0);
    expect(puttingGuard(sources.analyze).length, "putting guard not found").toBeGreaterThan(0);
    expect(analysisInsert(sources.analyze).length, "swing_analysis insert not found").toBeGreaterThan(0);
    expect(analysisRequest(sources.analyze).length, "analysis request not found").toBeGreaterThan(0);
    expect(successHandling(sources.analyze).length, "success branch not found").toBeGreaterThan(0);
  });

  it("isolates both action-bar branches", () => {
    expect(lockedActionBranch(sources.analyze).length, "locked branch not found").toBeGreaterThan(0);
    expect(sources.analyze.indexOf(LOCKED_BRANCH_ANCHOR)).toBeGreaterThanOrEqual(0);
  });

  it("strips comments without discarding rendered copy", () => {
    const sample = [
      "// the client tier is not authority",
      "/* never send subscription_tier */",
      'const copy = "Upgrade to unlock putting analysis.";',
    ].join("\n");
    const stripped = stripComments(sample);
    expect(stripped).not.toContain("not authority");
    expect(stripped).not.toContain("never send");
    expect(stripped).toContain('const copy = "Upgrade to unlock putting analysis.";');
  });
});

describe("EQ5C-D — client enablement contract", () => {
  const sources = liveSources();
  it.each(GUARDS.map((g) => g.id))("%s", (id) => {
    expect(guardById(id).holds(sources), `"${id}" no longer holds`).toBe(true);
  });
});

describe("EQ5C-D — frozen client copy", () => {
  const analyze = readSource(ANALYZE_PAGE);

  it("uses the locked-plan refusal, worded exactly as the server 403", () => {
    expect(analyze).toContain(
      "Putting analysis isn't included with your current plan. Upgrade to unlock putting analysis.",
    );
  });

  it("labels the locked and executable actions", () => {
    expect(analyze).toContain("UPGRADE TO UNLOCK PUTTING");
    expect(analyze).toContain("RUN PUTTING ANALYSIS");
    expect(analyze).toContain("RUN ANALYZER");
  });

  it("retires the obsolete coming-soon action copy", () => {
    expect(analyze).not.toContain("PUTTING ANALYSIS COMING SOON");
  });

  it("never tells a golfer putting is coming soon while it is running", () => {
    // The page cannot simultaneously offer to analyse a putt and describe the
    // feature as unreleased. Both historical phrasings are caught: the action
    // label that EQ5C-D replaced, and the informational line beneath the
    // capture panel that outlived it. Comment-stripped, so a future note about
    // the retired wording does not read as the wording itself.
    const code = stripComments(analyze);
    expect(code).toContain(
      "Upload your putting stroke video and trim to one complete stroke. Putting analysis is available on eligible plans.",
    );
    expect(code).not.toMatch(/\b(?:AI\s+)?putting analysis(?:\s+is)?\s+coming soon\b/i);
  });
});

describe("EQ5C-D — the full-swing path is untouched", () => {
  const analyze = readSource(ANALYZE_PAGE);
  const body = submission(analyze);

  it("keeps the established submission sequence", () => {
    const order = [
      "await getTrimmedBlob()",
      "await supabase.auth.getSession()",
      "querySavedClubs(supabase, { userId })",
      ".from(BUCKET).upload(",
      '.from("swing_videos")',
      '.from("swing_analysis")',
      'fetch("/api/analyze-swing"',
    ];
    let previous = -1;
    for (const anchor of order) {
      const index = body.indexOf(anchor);
      expect(index, `startAnalysis is missing "${anchor}"`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("keeps the full-swing mapper and its inline result", () => {
    expect(analyze).toContain("function dbRowToResult(");
    expect(analyze).toContain("setResult(dbRowToResult(updatedRow))");
  });

  it("keeps launch-monitor gating and trim rules unchanged", () => {
    expect(analyze).toContain("canUseLaunchMonitor(userTier)");
    expect(analyze).toContain("MAX_SEGMENT_SECONDS");
  });

  it("adds no putting fields to the client result shape", () => {
    const shape = sliceBetween(analyze, "interface AnalysisResult", "\n}");
    expect(shape.length).toBeGreaterThan(0);
    expect(shape).not.toContain("putting");
  });
});

// ============================================================================
// Non-vacuity
// ============================================================================
//
// Each entry regresses the real source in memory and requires the named guards
// to fail. Nothing is written to disk.

interface Regression {
  name: string;
  apply: (s: Sources) => Sources;
  breaks: string[];
}

const REGRESSIONS: Regression[] = [
  {
    name: "the entitlement condition is dropped from the submission guard",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "      isPuttingCapturePresentation(savedClubs, selectedClubId) &&\n      !canUsePuttingAnalysis(userTier)\n",
        "      isPuttingCapturePresentation(savedClubs, selectedClubId)\n",
      ),
    }),
    breaks: [
      "the unentitled refusal is conditional on the central helper",
      "the refusal precedes preprocessing",
      "the refusal precedes the Storage upload",
      "Analyze reuses the central entitlement helper",
    ],
  },
  {
    name: "the guard is moved after the Storage upload",
    apply: (s) => {
      const guard =
        "    if (\n      isPuttingCapturePresentation(savedClubs, selectedClubId) &&\n      !canUsePuttingAnalysis(userTier)\n    ) {\n      setError(PUTTING_ANALYSIS_LOCKED_MESSAGE);\n      return;\n    }\n";
      return {
        ...s,
        analyze: s.analyze
          .replace(guard, "")
          .replace("      // 2. Create the swing_videos record", guard + "      // 2. Create the swing_videos record"),
      };
    },
    breaks: ["the refusal precedes preprocessing", "the refusal precedes the Storage upload"],
  },
  {
    name: "the client starts authoring analysis_family on the insert",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "          club_id:        validatedClubId,",
        '          analysis_family: "putting",\n          club_id:        validatedClubId,',
      ),
    }),
    breaks: [
      "the client still writes club_id and authors no family",
      "no client code authors an analysis_family property",
    ],
  },
  {
    name: "the request body starts carrying a subscription tier",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "JSON.stringify({ analysisId: analysisRow.id })",
        "JSON.stringify({ analysisId: analysisRow.id, subscription_tier: userTier })",
      ),
    }),
    breaks: ["the API request body stays analysisId-only"],
  },
  {
    name: "success routing is decided by the client selector instead of the server",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace('updatedRow.analysis_family === "putting"', "selectedPutter"),
    }),
    breaks: [
      "success routing is decided by the server-returned family",
      "a putting success never reaches the full-swing mapper",
    ],
  },
  {
    name: "a putting success is poured into the full-swing mapper",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "        router.push(`/swings/${analysisRow.id}`);\n        return;\n",
        "",
      ),
    }),
    breaks: [
      "a putting success navigates to the canonical result route",
      "a putting success never reaches the full-swing mapper",
    ],
  },
  {
    name: "the canonical navigation destination is changed",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "router.push(`/swings/${analysisRow.id}`)",
        "router.push(`/analyze/${analysisRow.id}`)",
      ),
    }),
    breaks: ["a putting success navigates to the canonical result route"],
  },
  {
    name: "camera capture is disabled for a Putter",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "const cameraGuidance = isPuttingCapture",
        "const cameraLocked = !canUsePuttingAnalysis(userTier);\n  const cameraGuidance = isPuttingCapture",
      ),
    }),
    breaks: ["camera capture is never gated on putting entitlement"],
  },
  {
    name: "the central helper is replaced by a local plan list",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "      !canUsePuttingAnalysis(userTier)\n",
        '      !(userTier === "birdie" || userTier === "eagle" || userTier === "coach_starter" || userTier === "coach_pro")\n',
      ),
    }),
    breaks: [
      "no second plan matrix at either putting decision site",
      "the unentitled refusal is conditional on the central helper",
      "Analyze reuses the central entitlement helper",
    ],
  },
  {
    name: "startAnalysis opens a fresh subscription_tier query",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "      const blob = await getTrimmedBlob();",
        '      const { data: fresh } = await supabase.from("users").select("subscription_tier").single();\n      const blob = await getTrimmedBlob();',
      ),
    }),
    breaks: ["startAnalysis opens no fresh tier query"],
  },
  {
    name: "a 403 starts deleting the uploaded artifacts",
    apply: (s) => ({
      ...s,
      analyze: s.analyze.replace(
        "        throw new Error(err.error ?? `Analysis failed (${analysisRes.status})`);",
        '        await supabase.storage.from(BUCKET).remove([storagePath]);\n        throw new Error(err.error ?? `Analysis failed (${analysisRes.status})`);',
      ),
    }),
    breaks: ["a refusal triggers no cleanup or deletion"],
  },
  {
    // Not a `false &&` short-circuit: that would leave the call text sitting in
    // source order and prove nothing. The regression worth catching is the gate
    // ceasing to stand between the tier read and the pipeline.
    name: "the server entitlement gate is removed",
    apply: (s) => ({
      ...s,
      api: s.api.replace(
        '    if (!canUsePuttingAnalysis(currentTier)) {\n      return NextResponse.json(\n        {\n          error:\n            "Putting analysis isn\'t included with your current plan. Upgrade to unlock putting analysis.",\n        },\n        { status: 403 },\n      );\n    }\n',
        "",
      ),
    }),
    breaks: ["the server remains the putting execution authority"],
  },
];

describe("EQ5C-D — the contract is non-vacuous", () => {
  const live = liveSources();

  it("every guard holds against the real, unmodified sources", () => {
    const failing = GUARDS.filter((g) => !g.holds(live)).map((g) => g.id);
    expect(failing, "the compliant source must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS.map((r) => r.name))("is caught when: %s", (name) => {
    const regression = REGRESSIONS.find((r) => r.name === name)!;
    const mutated = regression.apply(live);

    expect(
      mutated.analyze !== live.analyze || mutated.api !== live.api,
      `"${name}" altered no source — the simulation anchor is stale`,
    ).toBe(true);

    for (const id of regression.breaks) {
      expect(
        guardById(id).holds(mutated),
        `"${name}" was not detected by guard "${id}" — that guard is vacuous`,
      ).toBe(false);
    }
  });
});
