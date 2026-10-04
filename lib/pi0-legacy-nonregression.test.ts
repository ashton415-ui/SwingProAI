/**
 * PI-0 — legacy non-regression and surface containment.
 *
 * PI-0 adds a new, flag-gated surface. This suite proves it stays contained:
 * no existing consumer, page or migration learns about it; the practice routes
 * gate on the flag before anything else; every elevated write is bound to the
 * verified identity; and the existing V1 vocabulary is extended, not changed.
 *
 * It reads source text only and writes nothing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  APPROVED_MIGRATIONS,
  PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME,
  SEC_COACH1_WRITE_AUTHORITY_FILENAME,
} from "./migration-inventory";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

const PRACTICE_ROUTES = {
  plans: "app/api/v1/practice/plans/route.ts",
  plan: "app/api/v1/practice/plans/[planId]/route.ts",
  archive: "app/api/v1/practice/plans/[planId]/archive/route.ts",
  sessions: "app/api/v1/practice/sessions/route.ts",
  session: "app/api/v1/practice/sessions/[sessionId]/route.ts",
  results: "app/api/v1/practice/sessions/[sessionId]/results/route.ts",
  complete: "app/api/v1/practice/sessions/[sessionId]/complete/route.ts",
} as const;

const PRACTICE_SOURCES = new Set<string>([
  ...Object.values(PRACTICE_ROUTES),
  "lib/api/v1-practice-dto.ts",
  "lib/practice-progress.ts",
]);

/** Tracked and new (untracked, not ignored) application sources, excluding tests. */
const SOURCES = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "app", "lib", "utils", "components"],
  { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
)
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));

const PRACTICE_TOKENS = /practice_(plans|plan_items|sessions|session_results)|pi_create_practice_plan|pi_record_practice_result|v1-practice-dto|practice-progress|isPracticeIntelligenceEnabled/;

/**
 * PI-1A: the two sources outside the practice surface that may know about it.
 * /me reports effective availability (flag AND entitlement) and so reads the
 * flag; the access authority is consumed by the practice routes. Neither may
 * touch a practice table, function or module — asserted below.
 */
const PI1A_CONSUMERS = new Set<string>(["app/api/v1/me/route.ts", "lib/practice-entitlement-authority.ts"]);
const PRACTICE_AUTHORITY = "lib/practice-entitlement-authority.ts";

// ─── Containment ──────────────────────────────────────────────────────────────

describe("PI-0 containment — only the practice surface knows about practice", () => {
  it("sees the seven practice routes among the scanned sources", () => {
    for (const route of Object.values(PRACTICE_ROUTES)) expect(SOURCES).toContain(route);
  });

  it("no other application source references practice tables, functions or modules", () => {
    const offenders = SOURCES.filter(
      (f) =>
        !PRACTICE_SOURCES.has(f) &&
        !PI1A_CONSUMERS.has(f) &&
        f !== "lib/feature-flags.ts" &&
        PRACTICE_TOKENS.test(stripComments(read(f))),
    );
    expect(offenders).toEqual([]);
  });

  it("the PI-1A consumers reach no practice table, function or module", () => {
    for (const f of Array.from(PI1A_CONSUMERS)) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(
        /practice_(plans|plan_items|sessions|session_results)|pi_create_practice_plan|pi_record_practice_result|v1-practice-dto|practice-progress/,
      );
    }
    // /me reads the flag and nothing else practice-specific.
    expect(stripComments(read("app/api/v1/me/route.ts"))).toContain("isPracticeIntelligenceEnabled()");
  });

  it("no client component imports the practice modules or the access authority", () => {
    const clients = SOURCES.filter((f) => /^\s*["']use client["']/m.test(read(f)));
    for (const f of clients) {
      expect(read(f), f).not.toMatch(/v1-practice-dto|practice-progress|app\/api\/v1\/practice|practice-entitlement-authority/);
    }
  });

  it("the canonical drill consumers are untouched by PI-0", () => {
    for (const f of ["app/(dashboard)/drills/page.tsx", "app/api/verify-drill/route.ts", "lib/drill-video-path.ts"]) {
      expect(read(f)).not.toMatch(PRACTICE_TOKENS);
    }
  });

  // PI-0 asserted that entitlements had no practice capability. PI-1A
  // supersedes that with exactly one, independent capability.
  it("entitlements gain exactly one, independent practice capability (PI-1A)", () => {
    const source = read("lib/entitlements.ts");
    const exported = Array.from(source.matchAll(/export function (\w*[Pp]ractice\w*)/g)).map((m) => m[1]);
    expect(exported).toEqual(["canUsePracticeIntelligence"]);
    const start = source.indexOf("export function canUsePracticeIntelligence(");
    const next = source.indexOf("export function", start + 1);
    const helper = stripComments(next === -1 ? source.slice(start) : source.slice(start, next));
    expect(helper).not.toMatch(/canUse(LaunchMonitor|PuttingAnalysis|PuttingRecommendations|UltraDeepAnalysis|FrameComparison)\(/);
    expect(helper).not.toMatch(/role|admin/);
  });

  it("practice code never writes drills or the legacy user_drills table", () => {
    for (const f of PRACTICE_SOURCES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/from\("drills"\)|from\("user_drills"\)|user_drills/);
    }
  });
});

// ─── Route gate order and write binding ───────────────────────────────────────

describe("PI-0 routes — flag first, verified identity always", () => {
  const exported = (code: string) =>
    (code.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).map((s) => s.split(" ").pop());

  it("each route exports exactly its methods", () => {
    const expected: Record<keyof typeof PRACTICE_ROUTES, string[]> = {
      plans: ["GET", "POST"],
      plan: ["GET"],
      archive: ["POST"],
      sessions: ["GET", "POST"],
      session: ["GET"],
      results: ["POST"],
      complete: ["POST"],
    };
    for (const [name, file] of Object.entries(PRACTICE_ROUTES)) {
      expect(exported(read(file)), file).toEqual(expected[name as keyof typeof PRACTICE_ROUTES]);
    }
  });

  it("every handler checks the flag before authenticating or touching a client", () => {
    for (const file of Object.values(PRACTICE_ROUTES)) {
      const code = stripComments(read(file));
      const handlers = code.split(/export async function (?:GET|POST)\b/).slice(1);
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) {
        const flag = handler.indexOf("isPracticeIntelligenceEnabled()");
        expect(flag, file).toBeGreaterThan(-1);
        for (const later of ["resolveRouteAuth()", "createAdminClient()", ".from(", ".rpc(", "request.json", "readJsonBody"]) {
          const at = handler.indexOf(later);
          if (at !== -1) expect(at, `${file}: ${later} before the flag`).toBeGreaterThan(flag);
        }
        expect(handler.slice(0, flag + 200)).toContain('v1Error("FEATURE_UNAVAILABLE"');
      }
    }
  });

  it("every handler runs flag → auth → entitlement → request, data and write work (PI-1A)", () => {
    for (const file of Object.values(PRACTICE_ROUTES)) {
      const code = stripComments(read(file));
      expect(code, file).toContain('import { requirePracticeAccess } from "@/lib/practice-entitlement-authority";');
      const handlers = code.split(/export async function (?:GET|POST)\b/).slice(1);
      for (const handler of handlers) {
        const flag = handler.indexOf("isPracticeIntelligenceEnabled()");
        const auth = handler.indexOf("resolveRouteAuth()");
        const access = handler.indexOf("await requirePracticeAccess(auth, requestId)");
        expect(handler.split("requirePracticeAccess(").length - 1, file).toBe(1);
        expect(flag, file).toBeGreaterThan(-1);
        expect(auth, file).toBeGreaterThan(flag);
        expect(access, `${file}: entitlement before auth`).toBeGreaterThan(auth);
        expect(handler.slice(access, access + 120)).toContain("if (refused) return refused;");
        for (const later of [
          "parsePathId(",
          "parseIdempotencyKey(",
          "parsePlanListQuery(",
          "parseSessionListQuery(",
          "readJsonBody(",
          "request.json",
          "request.url",
          ".from(",
          ".rpc(",
          "createAdminClient()",
        ]) {
          const at = handler.indexOf(later);
          if (at !== -1) expect(at, `${file}: ${later} before the entitlement`).toBeGreaterThan(access);
        }
      }
    }
  });

  it("no practice route restates the membership policy", () => {
    for (const file of Object.values(PRACTICE_ROUTES)) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(/"(birdie|eagle|coach_starter|coach_pro|par|trialing|past_due|canceled)"/);
      expect(code, file).not.toMatch(/subscription_(tier|status)|canUsePracticeIntelligence|@\/lib\/entitlements/);
    }
  });

  it("the access authority is server-only, caller-scoped and read-only", () => {
    const raw = read(PRACTICE_AUTHORITY);
    expect(raw.trimStart().startsWith('import "server-only";')).toBe(true);
    const code = stripComments(raw);
    expect(code).not.toMatch(/createAdminClient|SUPABASE_SERVICE_ROLE_KEY|service_role/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(code).toContain('.eq("id", caller.userId)');
    expect(code).toContain('"subscription_tier, subscription_status"');
    expect(code).not.toMatch(/\brole\b|app_metadata|user_metadata/);
  });

  it("the elevated client exists only in the five write handlers", () => {
    const withAdmin = Object.entries(PRACTICE_ROUTES)
      .filter(([, f]) => stripComments(read(f)).includes("createAdminClient()"))
      .map(([name]) => name)
      .sort();
    expect(withAdmin).toEqual(["archive", "complete", "plans", "results", "sessions"]);
    for (const name of ["plans", "sessions"] as const) {
      const getHandler = stripComments(read(PRACTICE_ROUTES[name])).split("export async function POST")[0];
      expect(getHandler, `${name} GET`).not.toContain("createAdminClient()");
    }
  });

  it("every elevated write is bound to the verified identity", () => {
    const code = (name: keyof typeof PRACTICE_ROUTES) => stripComments(read(PRACTICE_ROUTES[name]));
    expect(code("plans")).toContain("p_user_id: auth.userId");
    expect(code("results")).toContain("p_user_id: auth.userId");
    expect(code("sessions")).toContain("user_id: auth.userId,");
    for (const name of ["archive", "complete"] as const) {
      const update = code(name).slice(code(name).indexOf(".update("));
      const guard = update.slice(0, update.indexOf(".select("));
      expect(guard).toContain('.eq("user_id", auth.userId)');
      expect(guard).toMatch(/\.eq\("status", "(active|in_progress)"\)/);
    }
  });

  it("no practice route deletes, upserts, or takes an owner from the request", () => {
    for (const file of Object.values(PRACTICE_ROUTES)) {
      const code = stripComments(read(file));
      expect(code).not.toMatch(/\.delete\(|\.upsert\(/);
      expect(code).not.toMatch(/body\.(userId|user_id)|searchParams\.get\("(userId|user_id)"\)/);
      expect(code).not.toContain("user_metadata");
      expect(code).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("the caller's client never writes", () => {
    for (const file of Object.values(PRACTICE_ROUTES)) {
      expect(stripComments(read(file))).not.toMatch(/auth\.client\s*\.from\([^)]*\)\s*\.(insert|update|upsert|delete)\(/);
      expect(stripComments(read(file))).not.toMatch(/auth\.client\s*\.rpc\(/);
    }
  });
});

// ─── Vocabulary and configuration ─────────────────────────────────────────────

describe("PI-0 — V1 vocabulary and configuration", () => {
  const response = read("lib/api/v1-response.ts");
  const union = response.slice(response.indexOf("export type V1ErrorCode ="), response.indexOf(";", response.indexOf("export type V1ErrorCode =")));
  const codes = (union.match(/"([A-Z_]+)"/g) ?? []).map((s) => s.slice(1, -1));

  it("keeps every pre-existing error code, in order", () => {
    expect(codes.slice(0, 13)).toEqual([
      "AUTH_REQUIRED",
      "AUTH_INVALID",
      "SERVER_TEMPORARILY_UNAVAILABLE",
      "INTERNAL_ERROR",
      "VALIDATION_ERROR",
      "UPLOAD_NOT_FOUND_OR_NOT_READY",
      "UPLOAD_METADATA_INVALID",
      "UPLOAD_CONFLICT",
      "SWING_VIDEO_NOT_FOUND",
      "SWING_VIDEO_NOT_READY",
      "CLUB_INVALID",
      "ENTITLEMENT_REQUIRED",
      "ANALYSIS_CONFLICT",
    ]);
  });

  it("adds exactly the seven PI-0 codes", () => {
    expect(codes.slice(13)).toEqual([
      "FEATURE_UNAVAILABLE",
      "PRACTICE_PLAN_NOT_FOUND",
      "PRACTICE_SESSION_NOT_FOUND",
      "PRACTICE_SESSION_ALREADY_ACTIVE",
      "PRACTICE_SESSION_NOT_ACTIVE",
      "DRILL_NOT_FOUND",
      "IDEMPOTENCY_CONFLICT",
    ]);
  });

  it("documents the flag as off, server-only, in .env.example", () => {
    const env = read(".env.example");
    expect(env.match(/^PRACTICE_INTELLIGENCE_ENABLED=.*$/gm)).toEqual(["PRACTICE_INTELLIGENCE_ENABLED=false"]);
    expect(env).not.toContain("NEXT_PUBLIC_PRACTICE");
    expect(env.match(/^COACH_MARKETPLACE_ENABLED=.*$/gm)).toEqual(["COACH_MARKETPLACE_ENABLED=false"]);
  });

  it("reads the flag from exactly one server-only variable", () => {
    const flags = stripComments(read("lib/feature-flags.ts"));
    expect(flags).toContain(
      'return normalizeFlagValue(process.env.PRACTICE_INTELLIGENCE_ENABLED) === "true";',
    );
    expect(flags).toContain('return normalizeFlagValue(process.env.COACH_MARKETPLACE_ENABLED) === "true";');
    expect(flags).not.toContain("NEXT_PUBLIC_");
  });
});

// ─── Migrations ───────────────────────────────────────────────────────────────

describe("PI-0 — existing migrations are unchanged", () => {
  it("appends PI-0 as the last approved migration without reordering the others", () => {
    expect(APPROVED_MIGRATIONS[APPROVED_MIGRATIONS.length - 1]).toBe(PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME);
    expect(APPROVED_MIGRATIONS[APPROVED_MIGRATIONS.length - 2]).toBe(SEC_COACH1_WRITE_AUTHORITY_FILENAME);
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(APPROVED_MIGRATIONS);
  });

  it("leaves the applied SEC-COACH1 migration byte-identical", () => {
    const bytes = readFileSync(path.join(REPO_ROOT, "supabase", "migrations", SEC_COACH1_WRITE_AUTHORITY_FILENAME));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "38caa230b89e76b7a992eed1d667bdfd7194bfcc25b988102fd6d505b7f112f9",
    );
  });

  it("modifies no tracked migration", () => {
    const changed = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "supabase/migrations"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
    expect(changed).toBe("");
  });
});
