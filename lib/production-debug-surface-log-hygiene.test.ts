import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PRODUCTION SECURITY SOURCE-CONTRACT REGRESSION COVERAGE.
 *
 * This suite is static/structural only. It reads source text and asserts a
 * security contract. It does NOT import or execute any route handler, does NOT
 * read process.env, does NOT contact Supabase, Gemini or Vercel, does NOT read
 * .env files, and makes no network request of any kind. A passing run proves
 * what the source says, not what a deployed runtime does.
 *
 * Background — two defects were found in production source:
 *
 * 1. Two obsolete debug routes were live and unauthenticated.
 *    `app/api/debug/gemini/route.ts` returned an 8-character prefix of the
 *    configured Gemini credential plus its exact length, and called Google's
 *    API with that credential on behalf of any anonymous caller.
 *    `app/api/debug/route.ts` returned session identity fields. Neither had a
 *    product consumer. Both were deleted rather than gated: an endpoint that
 *    does not exist cannot be probed.
 *
 * 2. `app/api/analyze-swing/route.ts` logged a credential-derived prefix, the
 *    golfer's user id, the analysis id, raw client metrics, the complete Gemini
 *    report, the full database payload, and arbitrary database/SDK/network
 *    error text — and returned raw database and provider error text to the
 *    golfer in its failure responses.
 *
 * The contract below is ALLOWLIST-BASED for logs: a dynamic value may appear in
 * an ordinary production log only if its shape is bounded from source. Failure
 * responses are fixed copy. These assertions exist to stop both patterns from
 * returning.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so no assertion here
 *  depends on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ANALYZE_API = "app/api/analyze-swing/route.ts";
const DEBUG_ROUTE = "app/api/debug/route.ts";
const DEBUG_GEMINI_ROUTE = "app/api/debug/gemini/route.ts";
const DEBUG_DIR = "app/api/debug";

const apiSource = readSource(ANALYZE_API);

/**
 * Every `console.*` call in a source file, returned as complete call text
 * including its full argument list.
 *
 * Scanning by paren depth rather than by line matters: some calls span several
 * physical lines, and a line-based check would miss their later arguments.
 * String and template literals are skipped so a parenthesis inside a message
 * cannot end a call early.
 */
function extractConsoleCalls(source: string): string[] {
  const calls: string[] = [];
  let cursor = 0;

  for (;;) {
    const start = source.indexOf("console.", cursor);
    if (start === -1) break;

    const open = source.indexOf("(", start);
    if (open === -1) break;

    let depth = 0;
    let quote: string | null = null;
    let end = open;

    for (; end < source.length; end++) {
      const ch = source[end];

      if (quote !== null) {
        if (ch === "\\") {
          end++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }

      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }

    calls.push(source.slice(start, end + 1));
    cursor = end + 1;
  }

  return calls;
}

/** Every `NextResponse.json(...)` call, extracted the same way. */
function extractJsonResponses(source: string): string[] {
  const calls: string[] = [];
  let cursor = 0;

  for (;;) {
    const start = source.indexOf("NextResponse.json", cursor);
    if (start === -1) break;

    const open = source.indexOf("(", start);
    if (open === -1) break;

    let depth = 0;
    let quote: string | null = null;
    let end = open;

    for (; end < source.length; end++) {
      const ch = source[end];

      if (quote !== null) {
        if (ch === "\\") {
          end++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }

      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }

    calls.push(source.slice(start, end + 1));
    cursor = end + 1;
  }

  return calls;
}

const consoleCalls = extractConsoleCalls(apiSource);
const jsonResponses = extractJsonResponses(apiSource);

/** Calls that contain `needle` anywhere in their text. */
function callsContaining(calls: string[], needle: string): string[] {
  return calls.filter((call) => call.includes(needle));
}

/** Recursively collects non-test .ts/.tsx files under a repo-relative root. */
function collectSourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];

  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      found.push(full);
    }
  };

  walk(absoluteRoot);
  return found;
}

// ─── PART A — the obsolete debug surface is gone ─────────────────────────────

describe("production debug surface", () => {
  it("no longer ships the anonymous Gemini credential debug route", () => {
    expect(
      existsSync(path.join(repoRoot, DEBUG_GEMINI_ROUTE)),
      `${DEBUG_GEMINI_ROUTE} returned a credential prefix and length to anonymous callers and must not exist`,
    ).toBe(false);
  });

  it("no longer ships the session-introspection debug route", () => {
    expect(
      existsSync(path.join(repoRoot, DEBUG_ROUTE)),
      `${DEBUG_ROUTE} returned session identity fields and must not exist`,
    ).toBe(false);
  });

  it("has no route handler of any kind beneath app/api/debug", () => {
    const absoluteDebugDir = path.join(repoRoot, DEBUG_DIR);
    if (!existsSync(absoluteDebugDir)) return;

    const handlers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (/^route\.tsx?$/.test(entry)) handlers.push(path.relative(repoRoot, full));
      }
    };
    walk(absoluteDebugDir);

    expect(handlers, "a debug route handler reappeared under app/api/debug").toEqual([]);
  });

  it("is not referenced by any application source file", () => {
    const referencing: string[] = [];

    for (const root of ["app", "components", "lib", "utils"]) {
      for (const file of collectSourceFiles(root)) {
        const text = readFileSync(file, "utf8");
        if (text.includes("/api/debug")) referencing.push(path.relative(repoRoot, file));
      }
    }

    expect(referencing, "application source still calls a deleted debug route").toEqual([]);
  });
});

// ─── PART B — the Gemini credential contract ─────────────────────────────────

describe("analyze-swing Gemini credential contract", () => {
  it("keeps the environment-variable precedence unchanged", () => {
    expect(apiSource).toContain(
      "process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY",
    );
  });

  it("still constructs the Gemini client from the configured credential", () => {
    expect(apiSource).toContain("new GoogleGenerativeAI(geminiKey)");
  });

  it("never derives a substring or length from the credential", () => {
    expect(apiSource).not.toContain("geminiKey.slice");
    expect(apiSource).not.toContain("geminiKey.substring");
    expect(apiSource).not.toContain("geminiKey.substr");
    expect(apiSource).not.toContain("geminiKey.length");
  });

  it("logs only a boolean presence signal for the credential", () => {
    const keyCalls = callsContaining(consoleCalls, "geminiKey");
    expect(keyCalls).toHaveLength(1);
    expect(keyCalls[0]).toContain('"[analyze-swing] Gemini key configured:"');
    expect(keyCalls[0]).toContain("!!geminiKey");
  });
});

// ─── PART C — runtime log data hygiene ───────────────────────────────────────

describe("analyze-swing log hygiene", () => {
  it("still logs operational progress", () => {
    expect(consoleCalls.length).toBeGreaterThan(0);
    expect(apiSource).toContain('console.log("[analyze-swing] POST received")');
  });

  /**
   * These identifiers stay legal in functional control flow — the route still
   * needs `analysisId`, `clientMetrics`, `rawText` and its error bindings. Only
   * their appearance inside a console argument list is a defect, so every
   * assertion below inspects extracted console calls, never the whole file.
   */
  it("emits no golfer identity, record id, payload or report content", () => {
    for (const banned of [
      "user.id",
      "user?.id",
      "analysisId",
      "clientMetrics",
      "JSON.stringify",
      "payload",
    ]) {
      expect(
        callsContaining(consoleCalls, banned),
        `console output must not include ${banned}`,
      ).toEqual([]);
    }
  });

  /**
   * `rawText` is the complete Gemini-generated golfer report, so it cannot be
   * banned outright and it cannot be allowed outright: the contract keeps one
   * bounded diagnostic, `rawText.length`, and forbids the value itself. A bare
   * substring ban would reject the allowed length; a bare allowance would let
   * the whole report back into the logs. Both halves are asserted here.
   */
  it("logs the Gemini response length but never the response itself", () => {
    const rawTextCalls = callsContaining(consoleCalls, "rawText");

    expect(rawTextCalls, "exactly one console call may mention rawText").toHaveLength(1);
    expect(rawTextCalls[0]).toContain('"[analyze-swing] Gemini response length (chars):"');
    expect(rawTextCalls[0]).toContain("rawText.length");

    const lengthOccurrences = rawTextCalls[0].match(/\brawText\.length\b/g) ?? [];
    expect(lengthOccurrences, "only the bounded length diagnostic is allowed").toHaveLength(1);

    // With every allowed `rawText.length` removed, no bare `rawText` may remain
    // anywhere in that call — the report content itself must never be logged.
    const withoutAllowedLength = rawTextCalls[0].replace(/\brawText\.length\b/g, "");
    expect(withoutAllowedLength).not.toMatch(/\brawText\b/);
  });

  it("emits no arbitrary database, provider or network error text", () => {
    for (const banned of [
      ".message",
      ".details",
      ".hint",
      "authError.",
      "authError?.",
      "fetchErr",
      "markErr",
      "parseErr",
      "updateErr",
      "failErr",
      "String(err",
      "err instanceof Error",
    ]) {
      expect(
        callsContaining(consoleCalls, banned),
        `console output must not include ${banned}`,
      ).toEqual([]);
    }
  });

  it("no longer carries the historical payload-dumping labels", () => {
    for (const label of [
      "INCOMING MEDIAPIPE PAYLOAD",
      "FULL Gemini response",
      "RAW Gemini string",
      "full raw response",
      "FINAL SUPABASE PAYLOAD",
      "SUPABASE REJECTION",
      "Gemini key present",
    ]) {
      expect(apiSource, `${label} must not return to the Analyze route`).not.toContain(label);
    }
  });

  it("keeps the bounded diagnostics that remain useful", () => {
    expect(apiSource).toContain('console.log("[analyze-swing] row status:", analysisRow.status)');
    expect(apiSource).toContain(
      'console.log("[analyze-swing] metrics available:", hasRealMetrics)',
    );
    expect(apiSource).toContain(
      'console.log("[analyze-swing] prompt length (chars):", userPrompt.length)',
    );
    expect(apiSource).toContain(
      'console.log("[analyze-swing] Gemini response length (chars):", rawText.length)',
    );
    // Field NAMES are application constants; the values behind them are not logged.
    expect(apiSource).toContain(
      'console.error("[analyze-swing] response missing required fields:", missing.join(", "))',
    );
  });
});

// ─── PART D — golfer-facing failure responses ────────────────────────────────

describe("analyze-swing failure responses", () => {
  it("keeps the existing fixed request and auth copy", () => {
    expect(apiSource).toContain('{ error: "Unauthorized" }, { status: 401 }');
    expect(apiSource).toContain('{ error: "Invalid JSON body" }, { status: 400 }');
    expect(apiSource).toContain('{ error: "Missing analysisId" }, { status: 400 }');
    expect(apiSource).toContain('{ error: "Analysis record not found." }, { status: 404 }');
  });

  it("returns fixed copy when the AI service is unavailable", () => {
    expect(apiSource).toContain(
      '{ error: "AI analysis is temporarily unavailable. Please try again later." }',
    );
    expect(apiSource).toContain("{ status: 503 }");
  });

  it("returns fixed copy when the completion write fails", () => {
    expect(apiSource).toContain(
      '{ error: "We couldn\'t save your analysis. Please try again." }',
    );
  });

  it("returns fixed copy from the catch-all failure path", () => {
    expect(apiSource).toContain('{ error: "Analysis failed. Please try again." }');
    expect(apiSource).toContain("{ status: 500 }");
  });

  it("exposes no database or provider detail to the golfer", () => {
    for (const banned of [
      "updateErr",
      "msg",
      "details:",
      "hint:",
      "code:",
      ".message",
    ]) {
      expect(
        callsContaining(jsonResponses, banned),
        `failure responses must not include ${banned}`,
      ).toEqual([]);
    }
  });

  it("no longer carries the historical leaking copy", () => {
    expect(apiSource).not.toContain(
      "AI service not configured. Set GEMINI_API_KEY in environment variables.",
    );
    expect(apiSource).not.toContain("Database write failed");
    expect(apiSource).not.toContain("Analysis failed: ");
  });
});

// ─── PART E — the functional contract is untouched ───────────────────────────

describe("analyze-swing functional anchors", () => {
  it("keeps the server auth and ownership flow", () => {
    expect(apiSource).toContain("await createClient()");
    expect(apiSource).toContain("supabase.auth.getUser()");
    expect(apiSource).toContain("analysisId: string;");
    expect(apiSource).toContain('.eq("user_id", user.id)');
  });

  it("keeps the Gemini request configuration", () => {
    expect(apiSource).toContain('model: "gemini-2.5-flash"');
    expect(apiSource).toContain("SYSTEM_INSTRUCTION");
    expect(apiSource).toContain("RESPONSE_SCHEMA");
    expect(apiSource).toContain("temperature: 0.0");
    expect(apiSource).toContain("maxOutputTokens: 8192");
  });

  it("keeps the Storage and parsing flow", () => {
    expect(apiSource).toContain("createSignedUrl");
    expect(apiSource).toContain("MAX_INLINE_VIDEO_BYTES");
    expect(apiSource).toContain("JSON.parse(rawText)");
    expect(apiSource).toContain("requiredFields");
  });

  it("keeps every analysis status write and the success response", () => {
    expect(apiSource).toContain('status: "processing"');
    // Written inside an aligned object literal, so match on shape not spacing.
    expect(apiSource).toMatch(/status:\s+"complete"/);
    expect(apiSource).toContain('status: "failed"');
    expect(apiSource).toContain('{ message: "Analysis complete", data: updated }');
  });

  it("leaves the EQ3-S1 equipment boundary out of the API", () => {
    expect(apiSource).not.toContain("club_id");
    expect(apiSource).not.toContain("analysis_family");
    expect(apiSource).not.toContain("equipment_snapshot");
  });
});
