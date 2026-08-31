import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SOURCE-CONTRACT REGRESSION COVERAGE.
 *
 * This suite is static/structural only. It reads the Analyze page source and
 * asserts the shape of its authentication path. It does NOT execute the page,
 * does NOT talk to Supabase, and therefore does NOT — and cannot — prove that a
 * real expired access token is actually refreshed at runtime.
 *
 * ACTUAL EXPIRED-TOKEN RECOVERY STILL REQUIRES PHYSICAL BROWSER/DEVICE
 * VALIDATION AFTER DEPLOYMENT. A passing run here means only that the source
 * still delegates session handling to the managed browser client in the
 * required order — not that the AR-08 device blocker is resolved.
 *
 * Background: a real Android Chrome session failed a legitimate repeat upload
 * with `Video upload failed: "exp" claim timestamp check failed`. The cause was
 * an Analyze-local Supabase client built from a hand-parsed auth cookie, frozen
 * into an `Authorization: Bearer` header, with session persistence and
 * auto-refresh disabled — a token that could never be refreshed. These
 * assertions exist to stop that pattern from returning.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file. Normalized to LF so none of the checks
 *  below depend on whether this checkout has CRLF or LF line endings — every
 *  assertion here operates on content, not line shape. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ANALYZE_PAGE = "app/(dashboard)/analyze/page.tsx";
const MANAGED_CLIENT = "utils/supabase/client.ts";

const analyzeSource = readSource(ANALYZE_PAGE);
const managedClientSource = readSource(MANAGED_CLIENT);

/** The production auth cookie name the Analyze page used to hard-code. Written
 *  here as test data so the assertion below has something concrete to search
 *  for; it must never appear in the Analyze page itself again. */
const HARD_CODED_AUTH_COOKIE = "sb-atlmnqispyzhsahahpjy-auth-token";

/** Ordered structural anchors in the submission flow. Index-based comparison is
 *  used rather than regex lookahead so a failure reports which step moved. */
const ANCHORS = {
  preprocessing: "await getTrimmedBlob()",
  sessionResolution: "auth.getSession()",
  storageUpload: ".from(BUCKET).upload(",
  swingVideosInsert: `.from("swing_videos")`,
  swingAnalysisInsert: `.from("swing_analysis")`,
  analysisApi: `"/api/analyze-swing"`,
  /** EQ3-S1: the fresh active-bag re-read that guards a stale club selection. */
  clubRevalidation: "querySavedClubs(supabase, { userId })",
} as const;

/**
 * The startAnalysis body, isolated.
 *
 * Submission ordering must be asserted against this slice rather than against
 * the whole file. The page now resolves a managed session twice — once when the
 * club selector loads, and once inside startAnalysis — so a whole-file
 * `indexOf("auth.getSession()")` would find the selector's call and silently
 * stop describing submission at all. Two of the ordering tests below would
 * additionally fail outright, because the selector's resolution sits earlier in
 * the file than preprocessing does.
 *
 * Boundaries match the proven pattern already used by
 * lib/responsive-page-content.test.ts, so both suites isolate the same region.
 */
function startAnalysisSource(): string {
  const startMarker = "const startAnalysis";
  const startIdx = analyzeSource.indexOf(startMarker);
  expect(startIdx, `expected Analyze source to contain: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const endMarker = "const setTime";
  const endIdx = analyzeSource.indexOf(endMarker, startIdx);
  expect(
    endIdx,
    `expected "${endMarker}" to follow "${startMarker}"`
  ).toBeGreaterThan(startIdx);

  return analyzeSource.slice(startIdx, endIdx);
}

const submissionSource = startAnalysisSource();

/** Index of an anchor within the isolated submission body. */
function indexInSubmission(anchor: string): number {
  const index = submissionSource.indexOf(anchor);
  expect(index, `expected startAnalysis to contain: ${anchor}`).toBeGreaterThan(-1);
  return index;
}

describe("Analyze auth/session source contract — managed browser client", () => {
  it("imports the managed browser client utility from @/utils/supabase/client", () => {
    expect(analyzeSource).toMatch(
      /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@\/utils\/supabase\/client["']/
    );
  });

  it("keeps the managed browser client backed by @supabase/ssr createBrowserClient", () => {
    // The Analyze fix depends on this utility staying the managed, cookie-backed,
    // auto-refreshing client. If it is ever swapped for a raw client, the Analyze
    // page silently loses refresh again even though its own source looks correct.
    expect(managedClientSource).toContain("createBrowserClient");
    expect(managedClientSource).toContain("@supabase/ssr");
    expect(managedClientSource).toMatch(/export\s+function\s+createClient\s*\(/);
  });

  it("no longer constructs a raw @supabase/supabase-js client for submission auth", () => {
    expect(analyzeSource).not.toContain("@supabase/supabase-js");
    expect(analyzeSource).not.toContain("createSupabaseClient");
  });

  it("does not hard-code the Supabase auth cookie name", () => {
    expect(analyzeSource).not.toContain(HARD_CODED_AUTH_COOKIE);
    expect(analyzeSource).not.toContain("-auth-token");
  });

  it("does not read document.cookie to extract a session", () => {
    // The page still reads a server-injected tier via document.getElementById,
    // which is unrelated to auth. Cookie access specifically must be gone.
    expect(analyzeSource).not.toContain("document.cookie");
    expect(analyzeSource).not.toContain("getSessionFromCookie");
    expect(analyzeSource).not.toContain("getAuthClient");
  });

  it("does not inject a custom Authorization: Bearer header", () => {
    expect(analyzeSource).not.toContain("Authorization");
    expect(analyzeSource).not.toContain("Bearer");
  });

  it("does not disable autoRefreshToken or persistSession on an Analyze-specific client", () => {
    expect(analyzeSource).not.toContain("autoRefreshToken");
    expect(analyzeSource).not.toContain("persistSession");
  });
});

describe("Analyze auth/session source contract — submission ordering", () => {
  it("awaits managed-session resolution before the Storage upload", () => {
    const sessionIndex = indexInSubmission(ANCHORS.sessionResolution);
    const uploadIndex = indexInSubmission(ANCHORS.storageUpload);
    expect(sessionIndex).toBeLessThan(uploadIndex);
    // Resolution must be awaited, not fired and forgotten.
    expect(submissionSource).toMatch(/await\s+supabase\.auth\.getSession\(\)/);
  });

  it("resolves the session from the one stable managed client", () => {
    // The client is created once, lazily, in a ref that lives as long as the
    // mounted page, so the selector load and the submission provably share it.
    // A memo would be wrong here: the runtime may discard a memo, which would
    // hand those two paths different clients.
    expect(analyzeSource).toMatch(
      /const\s+supabaseRef\s*=\s*useRef<ReturnType<typeof\s+createClient>\s*\|\s*null>\(null\)/
    );
    expect(analyzeSource).toContain("supabaseRef.current = createClient();");
    expect(analyzeSource).toMatch(/const\s+supabase\s*=\s*supabaseRef\.current/);
    // Submission uses that binding rather than constructing its own client.
    expect(submissionSource).not.toContain("createClient(");
    expect(submissionSource).toContain("await supabase.auth.getSession()");
  });

  it("re-checks a selected club after the session guard and before Storage", () => {
    // EQ3-S1: a club archived since the selector loaded must not cause a
    // Storage object or any row to be written. The database keeps the final
    // word on an archive that lands after this point.
    const guardIndex = submissionSource.search(
      /if\s*\(\s*sessionError\s*\|\|\s*!session\s*\|\|\s*!userId\s*\)\s*throw/
    );
    expect(guardIndex).toBeGreaterThan(-1);
    const revalidationIndex = indexInSubmission(ANCHORS.clubRevalidation);
    expect(guardIndex).toBeLessThan(revalidationIndex);
    expect(revalidationIndex).toBeLessThan(indexInSubmission(ANCHORS.storageUpload));
    expect(revalidationIndex).toBeLessThan(indexInSubmission(ANCHORS.swingVideosInsert));
    expect(revalidationIndex).toBeLessThan(indexInSubmission(ANCHORS.swingAnalysisInsert));
    expect(revalidationIndex).toBeLessThan(indexInSubmission(ANCHORS.analysisApi));
    // The refusal is fixed copy, and no other club is substituted.
    expect(submissionSource).toContain("throw new Error(CLUB_UNAVAILABLE_MESSAGE)");
  });

  it("does not force a refreshSession() on every submission", () => {
    // getSession() refreshes only when the stored session is at/near expiry.
    // An unconditional refresh would add a network round-trip to every upload.
    expect(analyzeSource).not.toContain("refreshSession");
  });

  it("requires a non-null session and user id before any authenticated write", () => {
    expect(analyzeSource).toMatch(/const\s+userId\s*=\s*session\?\.user\?\.id/);
    expect(analyzeSource).toMatch(
      /if\s*\(\s*sessionError\s*\|\|\s*!session\s*\|\|\s*!userId\s*\)\s*throw/
    );
  });

  it("places the session-failure guard before Storage, both inserts, and the analysis API", () => {
    const guardIndex = submissionSource.search(
      /if\s*\(\s*sessionError\s*\|\|\s*!session\s*\|\|\s*!userId\s*\)\s*throw/
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(indexInSubmission(ANCHORS.storageUpload));
    expect(guardIndex).toBeLessThan(indexInSubmission(ANCHORS.swingVideosInsert));
    expect(guardIndex).toBeLessThan(indexInSubmission(ANCHORS.swingAnalysisInsert));
    expect(guardIndex).toBeLessThan(indexInSubmission(ANCHORS.analysisApi));
  });

  it("surfaces an actionable auth message without leaking raw Supabase token detail", () => {
    expect(analyzeSource).toContain("Your session has expired. Please sign in again.");
    // The guard must throw the fixed message, never the Supabase error object.
    expect(analyzeSource).not.toMatch(/throw\s+new\s+Error\(\s*sessionError/);
    expect(analyzeSource).not.toContain("sessionError.message");
    expect(analyzeSource).not.toContain("access_token");
    expect(analyzeSource).not.toContain("refresh_token");
  });

  it("derives storage ownership and both user_id columns from the current session", () => {
    expect(analyzeSource).toMatch(
      /const\s+storagePath\s*=\s*`\$\{userId\}\/\$\{crypto\.randomUUID\(\)\}\//
    );
    // swing_videos and swing_analysis both carry the session-derived id.
    expect(analyzeSource).toMatch(/user_id:\s*userId,/);
    expect(analyzeSource.match(/user_id:\s*userId,/g) ?? []).toHaveLength(2);
    // No hand-parsed ownership field may survive.
    expect(analyzeSource).not.toContain("user_id: s.user_id");
    expect(analyzeSource).not.toContain("session.user_id");
  });

  it("reuses the same managed client for Storage, swing_videos, and swing_analysis", () => {
    expect(analyzeSource).toContain("await supabase.storage");
    expect(analyzeSource).toMatch(/await\s+supabase\s*\n?\s*\.from\("swing_videos"\)/);
    expect(analyzeSource).toMatch(/await\s+supabase\s*\n?\s*\.from\("swing_analysis"\)/);
    // Exactly one client is constructed in the whole page.
    expect(analyzeSource.match(/createClient\(\)/g) ?? []).toHaveLength(1);
  });

  it("preserves the full success ordering through the analysis API", () => {
    const order = [
      ANCHORS.preprocessing,
      ANCHORS.sessionResolution,
      ANCHORS.clubRevalidation,
      ANCHORS.storageUpload,
      ANCHORS.swingVideosInsert,
      ANCHORS.swingAnalysisInsert,
      ANCHORS.analysisApi,
    ].map((anchor) => ({ anchor, index: indexInSubmission(anchor) }));

    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].index,
        `${order[i - 1].anchor} must precede ${order[i].anchor}`
      ).toBeLessThan(order[i].index);
    }
  });

  it("keeps the busy-state cleanup so a failed submission leaves the UI usable", () => {
    expect(analyzeSource).toMatch(/finally\s*\{\s*\n?\s*setIsAnalyzing\(false\);/);
  });
});

describe("Analyze auth/session source contract — preprocessing left untouched", () => {
  /** The getTrimmedBlob body, isolated so the auth slice can be proven not to
   *  have reached into Slice 1 preprocessing. */
  function getTrimmedBlobBody(): string {
    const start = analyzeSource.indexOf("const getTrimmedBlob = async ()");
    expect(start, "expected getTrimmedBlob to still exist").toBeGreaterThan(-1);
    const end = analyzeSource.indexOf("function dbRowToResult", start);
    expect(end, "expected dbRowToResult to still follow getTrimmedBlob").toBeGreaterThan(start);
    return analyzeSource.slice(start, end);
  }

  it("retains the Slice 1 preprocessing guards and encoder settings", () => {
    expect(analyzeSource).toContain("const MAX_FILE_MB = 250");
    expect(analyzeSource).toContain("const MAX_SEGMENT_SECONDS = 15");

    const body = getTrimmedBlobBody();
    expect(body).toContain("18 * 1024 * 1024");
    expect(body).toContain("captureStream");
    expect(body).toContain("new MediaRecorder");
    expect(body).toContain('mimeType: "video/webm"');
    expect(body).toContain("videoBitsPerSecond: 800_000");
    // Fail-closed: preprocessing must reject rather than substitute the original.
    expect(body).toContain("reject(new Error(PREPROCESSING_FAILED_MESSAGE))");
  });

  it("keeps preprocessing free of any authentication concern", () => {
    const body = getTrimmedBlobBody();
    expect(body).not.toContain("supabase");
    expect(body).not.toContain("session");
    expect(body).not.toContain("userId");
    expect(body).not.toContain("createClient");
  });

  it("still calls preprocessing before anything authenticated happens", () => {
    // Scoped to startAnalysis: the selector's own session resolution lives
    // earlier in the file, and comparing against it would say nothing about
    // submission ordering.
    expect(indexInSubmission(ANCHORS.preprocessing)).toBeLessThan(
      indexInSubmission(ANCHORS.sessionResolution)
    );
  });
});
