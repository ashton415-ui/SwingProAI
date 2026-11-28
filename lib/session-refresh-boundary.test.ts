import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChunks } from "@supabase/ssr";
import { middleware, config } from "@/middleware";

// ============================================================================
// Session refresh boundary — RETIRED (AG-WEB-READY-03-R1); its coverage retargeted to the replacement
// ============================================================================
//
// History. AG-SESSION-02 put a server-side session refresh in the middleware (utils/supabase/session-refresh.ts) and
// this file pinned it with ~550 cases (U1–U21, G1–G5). The AG-WEB-READY-02c continuation reproduced, in real Chrome,
// that the boundary wrote whatever its refresh returned onto the page response — after End Session, or over golfer B's
// newer sign-in (U5–U7) — and AG-WEB-READY-03-R1 removed it: the server no longer refreshes or writes a session on any
// path. The browser is the single publisher under the session-publication lease (utils/supabase/session-lease.ts).
//
// What is pinned here now:
// - the deletion (the module and the two inert credential routes are gone, nothing imports them);
// - the real middleware(): an expiring page navigation is sent to /auth/resume, everything else passes through, and no
//   answer ever carries a Set-Cookie, a request-header override or an Auth request (the detailed routing matrix is in
//   lib/session-resume.test.ts);
// - the structural guards that still apply: G1 the matcher equals the protected segments, U15 key derivation, G4 the
//   SDK version pin, G5 the app-wide header/cookie guards, and G6 (new) no server code writes or removes a cookie.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sb-127-auth-token";
const APP = "http://127.0.0.1:3941";
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const RETIRED = ["utils/supabase/session-refresh.ts", "app/api/auth/session/route.ts", "app/api/auth/login/route.ts"];

function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out;
}

function sourceFiles(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "swingmaster-web", "ai-backend"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return files;
}
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, "/");

describe("the retired boundary", () => {
  it("H1 the refresh boundary and both inert credential routes are deleted, and nothing imports them", () => {
    expect(RETIRED.filter((f) => existsSync(path.join(ROOT, f)))).toEqual([]);
    const importers = sourceFiles(["app", "components", "lib", "utils"])
      .concat([path.join(ROOT, "middleware.ts")])
      .filter((p) => /from\s+["'][^"']*(session-refresh|api\/auth\/session|api\/auth\/login)["']/.test(stripComments(readFileSync(p, "utf8"))))
      .map(rel);
    expect(importers).toEqual([]);
  });

  it("H2 the middleware imports only the resume router and refreshes, writes and fetches nothing", () => {
    const mw = stripComments(readFileSync(path.join(ROOT, "middleware.ts"), "utf8"));
    const imports = Array.from(mw.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)).map((x) => x[1]).sort();
    expect(imports).toEqual(["@/utils/supabase/session-resume", "next/server"]);
    expect(mw).not.toMatch(/@supabase|fetch\(|cookies\.(set|delete)|refreshSession|getUser/);
    const router = stripComments(readFileSync(path.join(ROOT, "utils", "supabase", "session-resume.ts"), "utf8"));
    expect(router).not.toMatch(/@supabase|fetch\(|cookies\.(set|delete)|Set-Cookie|refresh_token|getUser/i);
  });
});

describe("the real middleware()", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54329");
    vi.stubGlobal("fetch", () => {
      throw new Error("the middleware must never contact Auth");
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const value = (s: number, pad = 0) => JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Math.floor(NOW / 1000) + s, user: { p: "p".repeat(pad) } });
  const bare = (v: string) => `${KEY}=${encodeURIComponent(v)}`;
  const chunked = (v: string) => createChunks(KEY, v).map((c: { name: string; value: string }) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  const run = async (p: string, cookie: string, method = "GET") => await middleware(new NextRequest(`${APP}${p}`, { method, headers: { cookie } }));
  const clean = (r: Response) => {
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-middleware-override-headers")).toBeNull();
    expect(r.headers.get("x-middleware-rewrite")).toBeNull();
  };

  it("U1' a fresh session (bare or chunked): plain pass-through", async () => {
    for (const cookie of [bare(value(3600)), chunked(value(3600, 5000))]) {
      const r = await run("/dashboard", cookie);
      expect(r.headers.get("x-middleware-next")).toBe("1");
      clean(r);
    }
  });

  it("U2' an expiring or expired session on a page navigation: 307 to /auth/resume (no refresh, no Set-Cookie)", async () => {
    for (const cookie of [bare(value(10)), bare(value(-100)), chunked(value(1, 5000))]) {
      const r = await run("/bag/add?x=1", cookie);
      expect(r.status).toBe(307);
      const to = new URL(r.headers.get("location") as string);
      expect([to.pathname, to.searchParams.get("next")]).toEqual(["/auth/resume", "/bag/add?x=1"]);
      clean(r);
    }
  });

  it("U11' a server action (POST) with an expiring session passes through: its own auth check decides (SessionKeeper keeps the cookie current)", async () => {
    const r = await run("/drills", bare(value(5)), "POST");
    expect(r.headers.get("x-middleware-next")).toBe("1");
    clean(r);
  });

  it("U19' ambiguous jars go by /auth/resume?unsettled=1 (the browser waits a mid-write jar out); the verifier still fails them closed", async () => {
    for (const cookie of [`${bare(value(5))}; ${chunked(value(5, 5000))}`, `${KEY}.0=x; ${KEY}.2=y`, `${KEY}.00=${encodeURIComponent(value(5))}`]) {
      const r = await run("/drills", cookie);
      expect(r.status).toBe(307);
      expect(new URL(r.headers.get("location") as string).searchParams.get("unsettled")).toBe("1");
      clean(r);
    }
  });
});

describe("structure", () => {
  it("U15 key derivation equals authStorageKey() for four Supabase URL shapes", async () => {
    const { sessionCookieKey } = await import("@/utils/supabase/session-cookie-layout");
    const server = await import("@/utils/supabase/server");
    const shapes = ["http://127.0.0.1:54329", "https://abcdefghijklmnopqrst.supabase.co", "http://localhost:54321", "https://auth.example.invalid/sub/path"];
    const results = shapes.map((url) => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
      return sessionCookieKey(url) === server.authStorageKey();
    });
    vi.unstubAllEnvs();
    expect(results).toEqual(shapes.map(() => true));
  });

  it("G1 matcher guard: the matcher equals the protected segments under app/(dashboard)", () => {
    const base = path.join(ROOT, "app", "(dashboard)");
    const segments: string[] = [];
    const routeFiles: string[] = [];
    const walk = (dir: string, top: boolean) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && /^route\.(t|j)sx?$/.test(e.name)) routeFiles.push(path.join(dir, e.name));
        if (!e.isDirectory()) continue;
        if (e.name.startsWith("_") || e.name.startsWith("@")) continue;
        if (e.name.startsWith("(") && e.name.endsWith(")")) walk(path.join(dir, e.name), top);
        else {
          if (top) segments.push(e.name);
          walk(path.join(dir, e.name), false);
        }
      }
    };
    walk(base, true);
    const matcher = (config as { matcher: string[] }).matcher.slice().sort();
    const expected = segments.sort().map((s) => `/${s}/:path*`);
    expect({
      matcher_equals_protected_segments: JSON.stringify(matcher) === JSON.stringify(expected),
      twelve_segments: expected.length === 12,
      no_route_handler_under_dashboard: routeFiles.length === 0,
      public_and_api_paths_absent: matcher.filter((x) => /^\/(api|login|signup|auth)(\/|$|:)/.test(x) || x === "/" || x === "/:path*").length === 0,
    }).toEqual({ matcher_equals_protected_segments: true, twelve_segments: true, no_route_handler_under_dashboard: true, public_and_api_paths_absent: true });
  });

  it("G4 version pin: the installed @supabase/ssr is 0.3.0", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "@supabase", "ssr", "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.3.0");
  });

  it("G5 app-wide guards: no wholesale headers(), no set-cookie read, no cookie writes outside route handlers", () => {
    const offenders: string[] = [];
    for (const p of sourceFiles(["app"]).filter((f) => /\.(ts|tsx)$/.test(f) && !/[\\/]route\.(ts|tsx)$/.test(f))) {
      const s = stripComments(readFileSync(p, "utf8"));
      const headerUses = Array.from(s.matchAll(/\bheaders\(\)/g)).map((x) => s.slice(x.index ?? 0, (x.index ?? 0) + 40));
      if (headerUses.some((u) => !/^headers\(\)\)?\.get\("(?!set-cookie)[a-z0-9-]+"\)/i.test(u))) offenders.push(`${rel(p)}: headers() used whole`);
      if (/\.get\(\s*["']set-cookie["']\s*\)/i.test(s)) offenders.push(`${rel(p)}: reads set-cookie`);
      if (/cookies\(\)\)?\.(set|delete)\(|cookieStore\.(set|delete)\(/.test(s)) offenders.push(`${rel(p)}: cookie write`);
    }
    expect(offenders).toEqual([]);
  });

  it("G6 no server code (route handlers, middleware, server utilities) writes or removes a session cookie; A2: the one cookie any server code sets is End Session's END INTENT", () => {
    const server = sourceFiles(["app", "utils"])
      .filter((p) => /[\\/]route\.(ts|tsx)$/.test(p) || /utils[\\/]supabase[\\/](server|session-resume|admin)\.ts$/.test(p))
      .concat([path.join(ROOT, "middleware.ts")]);
    const writers = server.filter((p) => /\.cookies\.(set|delete)\(|cookies\(\)\)?\.(set|delete)\(|["']set-cookie["']/i.test(stripComments(readFileSync(p, "utf8")))).map(rel);
    expect(writers).toEqual(["app/api/auth/signout/route.ts"]);
    // that one writer: a single Set-Cookie naming only the END INTENT (the revoked lineage's digest), never a removal,
    // never through the cookie store, never a session, chunk or binding name
    const signout = stripComments(readFileSync(path.join(ROOT, "app/api/auth/signout/route.ts"), "utf8"));
    expect(signout.match(/["']set-cookie["']/gi)).toHaveLength(1);
    expect(signout).toContain("`${END_INTENT_COOKIE}=${lineage}; Path=/; Max-Age=${END_INTENT_MAX_AGE_S}; SameSite=Lax");
    expect(signout).not.toMatch(/\.cookies\.(set|delete)\(|Max-Age=0|SESSION_BINDING_COOKIE|planFamilyRemoval|maxAge/);
  });
});
