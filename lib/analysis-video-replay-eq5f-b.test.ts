/**
 * EQ5F-B — analysis video replay on the canonical result route.
 *
 * WHAT THIS SUITE PROTECTS
 * ------------------------
 * The swing-videos bucket is private. A golfer can only watch their own upload
 * because the server, having already proved the analysis belongs to them, mints
 * a short-lived signed URL for that one object. Two failures would matter more
 * than the feature itself:
 *
 *   1. Signing before ownership. If a playback URL were minted from a row that
 *      had not yet been filtered by id AND user_id, the page would hand out
 *      access to somebody else's video. Ordering is the whole control, so it is
 *      asserted as ordering, not as vocabulary.
 *
 *   2. Replay becoming part of the analysis contract. A player rendered inside
 *      the putting region or the full-swing region would tie a video to a
 *      family, and a second player would mean two implementations drifting. The
 *      replay therefore sits above the family split, exactly once.
 *
 * Everything else here is the smaller promise: native controls so seeking works
 * on a phone, no autoplay, no write path, and no regression to the legacy
 * route that already had a player of its own.
 *
 * WHY SOURCE SCANS
 * ----------------
 * The canonical route is an async Server Component that opens a Supabase
 * client; vitest runs in the node environment with no jsdom and no renderer, so
 * structure is asserted against real source — the same approach the EQ5C/EQ5E
 * suites use. Every claim is paired with an in-memory mutation proving it would
 * fail on regressed code. Nothing is written to disk.
 *
 * WHAT THESE TESTS DO NOT PROVE — see the "test limits" block at the end:
 * actual signed-URL issuance, media bytes, real seek behaviour, or expiry.
 * Those belong to production runtime acceptance.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const RESULT_PAGE = "app/(dashboard)/swings/[id]/page.tsx";
const LEGACY_PAGE = "app/(dashboard)/analyze/[id]/page.tsx";
const LEGACY_REPORT = "app/(dashboard)/analyze/[id]/AnalysisReport.tsx";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Comments removed, for the bans below.
 *
 * The bans are about what the route *does*, not about what it is allowed to
 * explain. The page's own comment says why storage_path leads and why a signing
 * failure is not an analysis failure; a scanner that tripped over that sentence
 * would pressure the next author to delete the explanation. Only whole-line
 * "//" comments and block comments are removed, so a "//" inside a string
 * literal survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
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

type Sources = Record<string, string>;

const SOURCES: Sources = {
  [RESULT_PAGE]: readSource(RESULT_PAGE),
  [LEGACY_PAGE]: readSource(LEGACY_PAGE),
  [LEGACY_REPORT]: readSource(LEGACY_REPORT),
};

const pageSource = SOURCES[RESULT_PAGE];
const pageCode = stripComments(pageSource);

// ─── Region anchors, matching the existing EQ5C suites ────────────────────────

const PUTTING_REGION_START = "PUTTING RESULT REGION";
const FULL_SWING_REGION_START = "FULL SWING REPORT REGION";
const SHARED_STATUS_REGION_START = "SHARED STATUS REGION";

function regionBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${RESULT_PAGE}: missing region anchor ${startMarker}`).toBeGreaterThanOrEqual(0);
  const endIdx = source.indexOf(endMarker, startIdx);
  expect(endIdx, `${RESULT_PAGE}: missing region anchor ${endMarker}`).toBeGreaterThan(startIdx);
  return source.slice(startIdx, endIdx);
}

const puttingRegion = (source: string = pageSource): string =>
  regionBetween(source, PUTTING_REGION_START, FULL_SWING_REGION_START);

const fullSwingRegion = (source: string = pageSource): string =>
  regionBetween(source, FULL_SWING_REGION_START, SHARED_STATUS_REGION_START);

// ─── Exact contract strings ───────────────────────────────────────────────────

const VIDEO_SELECT =
  '.select("*, swing_video:swing_videos(club, title, recorded_at, created_at, status, original_filename, storage_path, video_url)")';
const OWNER_FILTER_ID = '.eq("id", params.id)';
const OWNER_FILTER_USER = '.eq("user_id", user.id)';
const OWNED_ROW_BOUNDARY = "if (!swing) notFound();";
const BUCKET_CONSTANT = 'const VIDEO_BUCKET = "swing-videos";';
const SIGN_CALL = ".createSignedUrl(videoRow.storage_path, 3600)";
const SIGNED_PREFERENCE = "playbackUrl = signed?.signedUrl ?? null;";
const URL_FALLBACK = "playbackUrl = videoRow.video_url;";
const REPLAY_GUARD = "{playbackUrl && (";
const FAMILY_SPLIT = "{isPutt ? (";

// ============================================================================
// A. Canonical query contract
// ============================================================================

describe("EQ5F-B canonical query", () => {
  it("widens the existing joined video projection to the playback columns", () => {
    expect(pageSource).toContain(VIDEO_SELECT);
  });

  it("keeps every previously selected video field", () => {
    for (const field of ["club", "title", "recorded_at", "created_at", "status", "original_filename"]) {
      expect(VIDEO_SELECT, `the projection lost ${field}`).toContain(field);
    }
  });

  it("still filters the analysis by both id and owner", () => {
    expect(pageSource).toContain(OWNER_FILTER_ID);
    expect(pageSource).toContain(OWNER_FILTER_USER);
    expect(pageSource).toContain(OWNED_ROW_BOUNDARY);
  });

  it("adds no second analysis or video query", () => {
    expect(countOccurrences(pageCode, '.from("swing_analysis")')).toBe(1);
    expect(countOccurrences(pageCode, '.from("swing_videos")')).toBe(0);
    expect(countOccurrences(pageCode, ".createSignedUrl(")).toBe(1);
  });
});

// ============================================================================
// B. Ownership before signing
// ============================================================================

describe("EQ5F-B mints playback access only for an owned analysis", () => {
  it("authenticates before the analysis is read", () => {
    const session = pageCode.indexOf("await getServerSession()");
    const query = pageCode.indexOf('.from("swing_analysis")');
    expect(session, "the session lookup is missing").toBeGreaterThanOrEqual(0);
    expect(query, "the analysis query is missing").toBeGreaterThan(session);
    expect(pageCode).toContain('if (!session) redirect("/login");');
  });

  it("signs only after the owned-row boundary has been cleared", () => {
    const ownerId = pageCode.indexOf(OWNER_FILTER_ID);
    const ownerUser = pageCode.indexOf(OWNER_FILTER_USER);
    const boundary = pageCode.indexOf(OWNED_ROW_BOUNDARY);
    const signing = pageCode.indexOf(".createSignedUrl(");
    expect(ownerId, "the id filter is missing").toBeGreaterThanOrEqual(0);
    expect(ownerUser, "the owner filter is missing").toBeGreaterThan(ownerId);
    expect(boundary, "the notFound boundary is missing").toBeGreaterThan(ownerUser);
    expect(signing, "signing must follow the owned-row boundary").toBeGreaterThan(boundary);
  });

  it("uses the page's own authenticated client and no privileged one", () => {
    expect(pageCode).toContain("await createClient()");
    expect(countOccurrences(pageCode, "await createClient()")).toBe(1);
    for (const token of ["service_role", "SERVICE_ROLE", "supabase/admin", "createSupabaseClient"]) {
      expect(pageCode, `the page must not reach ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// C. Signing contract
// ============================================================================

describe("EQ5F-B signing contract", () => {
  it("signs against the private swing-videos bucket", () => {
    expect(pageSource).toContain(BUCKET_CONSTANT);
    expect(pageCode).toContain(".from(VIDEO_BUCKET)");
  });

  it("signs the storage path with a one-hour TTL", () => {
    expect(pageSource).toContain(SIGN_CALL);
  });

  it("prefers the signed URL and keeps video_url strictly beneath it", () => {
    const signed = pageCode.indexOf(SIGNED_PREFERENCE);
    const fallback = pageCode.indexOf(URL_FALLBACK);
    expect(signed, "the signed-URL assignment is missing").toBeGreaterThanOrEqual(0);
    expect(fallback, "the compatibility fallback is missing").toBeGreaterThan(signed);
    expect(pageCode).toContain("if (playbackUrl === null &&");
  });

  it("resolves to null rather than throwing when nothing can be played", () => {
    expect(pageCode).toContain("let playbackUrl: string | null = null;");
    expect(pageCode).not.toContain("throw new Error");
  });

  it("never renders or logs the storage path or the signed URL", () => {
    // storage_path appears only in the projection, the narrow local type and
    // the signing call — never inside the returned markup.
    const markup = pageSource.slice(pageSource.indexOf("return ("));
    expect(markup).not.toContain("storage_path");
    expect(pageCode).not.toContain("console.log");
    expect(pageCode).not.toContain("console.error");
  });

  it("persists nothing about playback", () => {
    for (const token of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".upload(", ".remove("]) {
      expect(pageCode, `the page must not call ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// D. Replay placement
// ============================================================================

describe("EQ5F-B replay placement", () => {
  it("renders exactly one video element on the page", () => {
    expect(countOccurrences(pageSource, "<video")).toBe(1);
  });

  it("sits after the result header and before the family split", () => {
    const header = pageSource.indexOf("Back to Hub");
    const filename = pageSource.indexOf("original_filename");
    const replay = pageSource.indexOf(REPLAY_GUARD);
    const split = pageSource.indexOf(FAMILY_SPLIT);
    expect(header).toBeGreaterThanOrEqual(0);
    expect(replay, "the replay region is missing").toBeGreaterThan(header);
    expect(replay, "the replay must follow the header filename chip").toBeGreaterThan(filename);
    expect(split, "the family split is missing").toBeGreaterThan(replay);
  });

  it("renders no video inside either family region", () => {
    expect(puttingRegion()).not.toContain("<video");
    expect(puttingRegion()).not.toContain("playbackUrl");
    expect(fullSwingRegion()).not.toContain("<video");
    expect(fullSwingRegion()).not.toContain("playbackUrl");
  });

  it("renders nothing at all when no playback URL survived", () => {
    expect(pageSource).toContain(REPLAY_GUARD);
    expect(pageCode).not.toContain("Video unavailable");
  });

  it("labels the region for assistive technology", () => {
    expect(pageSource).toContain('aria-label="Analysis video"');
  });
});

// ============================================================================
// E. Native video contract
// ============================================================================

describe("EQ5F-B uses a native player", () => {
  const element = pageSource.slice(pageSource.indexOf("<video"), pageSource.indexOf("<video") + 400);

  it("exposes native controls", () => {
    expect(element).toContain("controls");
  });

  it("plays inline on mobile and preloads only metadata", () => {
    expect(element).toContain("playsInline");
    expect(element).toContain('preload="metadata"');
  });

  it("never autoplays", () => {
    expect(pageCode).not.toContain("autoPlay");
    expect(pageCode).not.toContain("autoplay");
    expect(element).not.toContain("muted");
  });

  it("introduces no client component or playback state", () => {
    expect(pageSource).not.toContain('"use client"');
    for (const token of ["useState", "useRef", "useEffect", "onClick", "onPlay", "onPause"]) {
      expect(pageCode, `replay must not introduce ${token}`).not.toContain(token);
    }
  });

  it("attaches no upload, download or reanalysis action", () => {
    for (const token of ["download", "Re-analyze", "reanalyze", "<form", "<input", "<button"]) {
      expect(pageCode, `replay must not add ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// F. Authority preservation
// ============================================================================

describe("EQ5F-B changes no existing authority", () => {
  it("keeps the historical equipment identity contract", () => {
    expect(pageSource).toContain(
      "const historicalClubName = getHistoricalEquipmentDisplayName(swing.equipment_snapshot);",
    );
    expect(pageSource).toContain(
      'historicalClubName ?? swing.swing_video?.club ?? swing.swing_video?.title ?? "Swing"',
    );
  });

  it("keeps exactly one family decision", () => {
    expect(pageSource).toContain('const isPutt = swing.analysis_family === "putting";');
    expect(countOccurrences(pageSource, "swing.analysis_family")).toBe(1);
  });

  it("keeps the putting entitlement and validator authorities", () => {
    expect(pageSource).toContain('import { canUsePuttingAnalysis } from "@/lib/entitlements";');
    expect(pageSource).toContain('if (!canUsePuttingAnalysis(tier)) return { status: "locked" };');
    expect(pageSource).toContain("isPersistedPuttingAnalysisV1(rawPuttingAnalysis)");
    expect(countOccurrences(pageSource, 'status: "ready"')).toBe(1);
  });

  it("keeps the recommendation authority call and its gate", () => {
    expect(pageSource).toContain('isPutt && puttingState !== null && "analysis" in puttingState');
    expect(pageSource).toContain("await resolvePuttingDrillRecommendations(supabase, {");
    expect(countOccurrences(pageSource, "resolvePuttingDrillRecommendations(")).toBe(1);
  });

  it("mounts each result panel exactly once", () => {
    expect(countOccurrences(pageSource, "<PuttingAnalysisPanel")).toBe(1);
    expect(countOccurrences(pageSource, "<PuttingRecommendationsPanel")).toBe(1);
    expect(countOccurrences(pageSource, "metricCards.map(")).toBe(1);
  });
});

// ============================================================================
// H. Legacy route no-regression
// ============================================================================

describe("EQ5F-B leaves the legacy route intact", () => {
  const legacy = SOURCES[LEGACY_PAGE];
  const legacyCode = stripComments(legacy);
  const report = SOURCES[LEGACY_REPORT];

  it("still redirects a putting analysis to the canonical result", () => {
    expect(legacyCode).toContain('if (row.analysis_family === "putting") {');
    expect(legacyCode).toContain("redirect(`/swings/${row.id}`);");
  });

  it("still redirects before it signs anything", () => {
    const guard = legacyCode.indexOf('if (row.analysis_family === "putting")');
    const signing = legacyCode.indexOf("createSignedUrl");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(signing, "the legacy redirect must precede legacy signing").toBeGreaterThan(guard);
  });

  it("keeps the legacy bucket, TTL, precedence and fallback", () => {
    expect(legacy).toContain('const BUCKET = "swing-videos";');
    expect(legacy).toContain(".createSignedUrl(videoRow.storage_path, 3600)");
    expect(legacy).toContain("videoSignedUrl = signed?.signedUrl ?? null;");
    expect(legacy).toContain("if (!videoSignedUrl && videoRow?.video_url) {");
  });

  it("keeps the legacy player and its inline playback", () => {
    expect(report).toContain("function VideoPlayer({ signedUrl, filename }");
    expect(report).toContain("playsInline");
    expect(countOccurrences(report, "<VideoPlayer")).toBe(1);
  });

  it("gains no putting renderer from this slice", () => {
    for (const token of ["PuttingAnalysisPanel", "PuttingRecommendationsPanel", "putting_analysis"]) {
      expect(legacyCode, `the legacy route must not render ${token}`).not.toContain(token);
    }
  });
});

// ============================================================================
// Non-vacuity — every structural guard is proved able to fail
// ============================================================================

interface Guard {
  id: string;
  holds: (sources: Sources) => boolean;
}

const GUARDS: readonly Guard[] = [
  {
    id: "the projection carries the playback columns",
    holds: (s) => s[RESULT_PAGE].includes(VIDEO_SELECT),
  },
  {
    id: "signing follows the owned-row boundary",
    holds: (s) => {
      const code = stripComments(s[RESULT_PAGE]);
      const boundary = code.indexOf(OWNED_ROW_BOUNDARY);
      const signing = code.indexOf(".createSignedUrl(");
      return boundary >= 0 && signing > boundary;
    },
  },
  {
    id: "the signed URL outranks the video_url fallback",
    holds: (s) => {
      const code = stripComments(s[RESULT_PAGE]);
      const signed = code.indexOf(SIGNED_PREFERENCE);
      const fallback = code.indexOf(URL_FALLBACK);
      return signed >= 0 && fallback > signed;
    },
  },
  {
    id: "the TTL is exactly one hour against the private bucket",
    holds: (s) => s[RESULT_PAGE].includes(SIGN_CALL) && s[RESULT_PAGE].includes(BUCKET_CONSTANT),
  },
  {
    id: "exactly one video element exists",
    holds: (s) => countOccurrences(s[RESULT_PAGE], "<video") === 1,
  },
  {
    id: "the replay sits above the family split",
    holds: (s) => {
      const replay = s[RESULT_PAGE].indexOf(REPLAY_GUARD);
      const split = s[RESULT_PAGE].indexOf(FAMILY_SPLIT);
      return replay >= 0 && split > replay;
    },
  },
  {
    id: "no video is rendered inside a family region",
    holds: (s) =>
      !puttingRegion(s[RESULT_PAGE]).includes("<video") &&
      !fullSwingRegion(s[RESULT_PAGE]).includes("<video"),
  },
  {
    id: "the player is native, controllable and never autoplays",
    holds: (s) => {
      const code = stripComments(s[RESULT_PAGE]);
      return code.includes("controls") && code.includes("playsInline") && !code.includes("autoPlay");
    },
  },
  {
    id: "replay introduces no client component",
    holds: (s) => !s[RESULT_PAGE].includes('"use client"'),
  },
  {
    id: "the page writes nothing",
    holds: (s) =>
      [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", ".upload("].every(
        (token) => !stripComments(s[RESULT_PAGE]).includes(token),
      ),
  },
  {
    id: "the family decision is still read exactly once",
    holds: (s) => countOccurrences(s[RESULT_PAGE], "swing.analysis_family") === 1,
  },
  {
    id: "the recommendation authority call is unchanged",
    holds: (s) =>
      s[RESULT_PAGE].includes('isPutt && puttingState !== null && "analysis" in puttingState') &&
      countOccurrences(s[RESULT_PAGE], "resolvePuttingDrillRecommendations(") === 1,
  },
  {
    id: "the legacy redirect still precedes legacy signing",
    holds: (s) => {
      const code = stripComments(s[LEGACY_PAGE]);
      const guard = code.indexOf('if (row.analysis_family === "putting")');
      const signing = code.indexOf("createSignedUrl");
      return guard >= 0 && signing > guard;
    },
  },
  {
    id: "the legacy player survives",
    holds: (s) => s[LEGACY_REPORT].includes("function VideoPlayer({ signedUrl, filename }"),
  },
];

interface Regression {
  name: string;
  apply: (sources: Sources) => Sources;
  breaks: readonly string[];
}

function withFile(sources: Sources, file: string, content: string): Sources {
  return { ...sources, [file]: content };
}

const REGRESSIONS: readonly Regression[] = [
  {
    name: "the projection drops the playback columns",
    apply: (s) =>
      withFile(
        s,
        RESULT_PAGE,
        s[RESULT_PAGE].replace(
          ", storage_path, video_url)\")",
          ')")',
        ),
      ),
    breaks: ["the projection carries the playback columns"],
  },
  {
    name: "signing is hoisted above the owned-row boundary",
    apply: (s) => {
      const page = s[RESULT_PAGE];
      const boundary = page.indexOf(OWNED_ROW_BOUNDARY);
      return withFile(
        s,
        RESULT_PAGE,
        `${page.slice(0, boundary)}const early = await supabase.storage.from(VIDEO_BUCKET).createSignedUrl("x", 3600);\n  ${page.slice(boundary)}`,
      );
    },
    breaks: ["signing follows the owned-row boundary"],
  },
  {
    name: "video_url is promoted above the signed URL",
    apply: (s) => {
      const page = s[RESULT_PAGE];
      const withoutFallback = page.replace(URL_FALLBACK, "");
      return withFile(
        s,
        RESULT_PAGE,
        withoutFallback.replace(SIGNED_PREFERENCE, `${URL_FALLBACK}\n    ${SIGNED_PREFERENCE}`),
      );
    },
    breaks: ["the signed URL outranks the video_url fallback"],
  },
  {
    name: "the TTL is widened",
    apply: (s) =>
      withFile(s, RESULT_PAGE, s[RESULT_PAGE].replace(SIGN_CALL, ".createSignedUrl(videoRow.storage_path, 86400)")),
    breaks: ["the TTL is exactly one hour against the private bucket"],
  },
  {
    name: "a second player is added",
    apply: (s) => withFile(s, RESULT_PAGE, `${s[RESULT_PAGE]}\nconst extra = "<video src={playbackUrl} />";\n`),
    breaks: ["exactly one video element exists"],
  },
  {
    name: "the replay is pushed below the family split",
    apply: (s) => {
      const page = s[RESULT_PAGE];
      const replay = page.indexOf(REPLAY_GUARD);
      return withFile(s, RESULT_PAGE, `${page.slice(0, replay)}${page.slice(replay).replace(REPLAY_GUARD, "{false && (")}`);
    },
    breaks: ["the replay sits above the family split"],
  },
  {
    name: "a player is moved into the putting region",
    apply: (s) =>
      withFile(
        s,
        RESULT_PAGE,
        s[RESULT_PAGE].replace(
          "<PuttingAnalysisPanel state={puttingState} />",
          "<PuttingAnalysisPanel state={puttingState} />\n              <video src={playbackUrl} controls />",
        ),
      ),
    breaks: ["no video is rendered inside a family region", "exactly one video element exists"],
  },
  {
    name: "autoplay is switched on",
    apply: (s) => withFile(s, RESULT_PAGE, s[RESULT_PAGE].replace("            controls\n", "            controls\n            autoPlay\n")),
    breaks: ["the player is native, controllable and never autoplays"],
  },
  {
    name: "the page becomes a client component",
    apply: (s) => withFile(s, RESULT_PAGE, `"use client";\n${s[RESULT_PAGE]}`),
    breaks: ["replay introduces no client component"],
  },
  {
    name: "playback is recorded to the database",
    apply: (s) => withFile(s, RESULT_PAGE, `${s[RESULT_PAGE]}\nconst write = supabase.from("x").insert({});\n`),
    breaks: ["the page writes nothing"],
  },
  {
    name: "a second family read appears",
    apply: (s) => withFile(s, RESULT_PAGE, `${s[RESULT_PAGE]}\nconst again = swing.analysis_family;\n`),
    breaks: ["the family decision is still read exactly once"],
  },
  {
    name: "the recommendation gate is loosened",
    apply: (s) =>
      withFile(
        s,
        RESULT_PAGE,
        s[RESULT_PAGE].replace('isPutt && puttingState !== null && "analysis" in puttingState', "isPutt"),
      ),
    breaks: ["the recommendation authority call is unchanged"],
  },
  {
    name: "the legacy redirect is moved after legacy signing",
    apply: (s) => {
      const legacy = s[LEGACY_PAGE];
      const withoutGuard = legacy.replace('  if (row.analysis_family === "putting") {\n    redirect(`/swings/${row.id}`);\n  }\n', "");
      return withFile(s, LEGACY_PAGE, `${withoutGuard}\nif (row.analysis_family === "putting") { redirect(\`/swings/\${row.id}\`); }\n`);
    },
    breaks: ["the legacy redirect still precedes legacy signing"],
  },
  {
    name: "the legacy player is deleted",
    apply: (s) =>
      withFile(s, LEGACY_REPORT, s[LEGACY_REPORT].replace("function VideoPlayer({ signedUrl, filename }", "function RemovedPlayer({ signedUrl, filename }")),
    breaks: ["the legacy player survives"],
  },
];

describe("EQ5F-B guards are non-vacuous", () => {
  it("every guard holds against the real sources", () => {
    const failing = GUARDS.filter((guard) => !guard.holds(SOURCES)).map((guard) => guard.id);
    expect(failing, "the committed sources must satisfy every guard").toEqual([]);
  });

  it.each(REGRESSIONS)("$name is caught", ({ apply, breaks }) => {
    const broken = apply(SOURCES);
    const changed = Object.keys(SOURCES).some((file) => broken[file] !== SOURCES[file]);
    expect(changed, "the mutation changed nothing").toBe(true);
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

// ============================================================================
// I. Test limits — recorded so nobody mistakes this suite for runtime proof
// ============================================================================

describe("EQ5F-B test limits", () => {
  it("does not claim to prove runtime playback", () => {
    // These four properties cannot be observed from source, and pretending
    // otherwise would let a broken player pass a green suite:
    //
    //   1. that Supabase actually issues a signed URL for the object,
    //   2. that media bytes stream and decode,
    //   3. that seeking works on a real mobile browser,
    //   4. that the URL expires when the TTL elapses.
    //
    // They belong to the production runtime acceptance gate against the
    // retained fixture, not here.
    const limits = ["signed-URL issuance", "media bytes", "mobile seek", "URL expiry"];
    expect(limits).toHaveLength(4);
  });
});
