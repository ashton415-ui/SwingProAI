import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AUTH-LOGOUT-R1 — the End Session route.
 *
 * SOURCE-CONTRACT REGRESSION COVERAGE. This suite is static/structural only.
 * It reads the signout route and the two navigation surfaces and asserts the
 * shape of the logout path. It does NOT execute the route, does NOT talk to
 * Supabase, and therefore CANNOT prove that a real browser session is actually
 * ended. FINAL ACCEPTANCE STILL REQUIRES A PRODUCTION LOGOUT CHECK ON A REAL
 * DEVICE, including a second already-authenticated session that must REMAIN
 * signed in, because the approved scope is `local`.
 *
 * Background: production "End Session" did not reliably log the golfer out.
 * The route built a plain supabase-js client with `persistSession: false`, so
 * `auth.signOut()` loaded no session from anywhere, never called the Auth
 * server, and — with no response-cookie writer — never cleared the browser
 * cookie that `getServerSession()` trusts. It also redirected with the
 * NextResponse default 307, which preserves the method and re-POSTs to /login.
 * These assertions exist to stop each of those from returning.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so no assertion here
 *  depends on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const SIGNOUT_ROUTE = "app/api/auth/signout/route.ts";
const DASHBOARD_LAYOUT = "app/(dashboard)/layout.tsx";
const MOBILE_NAV = "components/navigation/MobileDashboardNavigation.tsx";
const SHARED_NAV = "components/navigation/dashboard-navigation.tsx";

const routeSource = readSource(SIGNOUT_ROUTE);
const layoutSource = readSource(DASHBOARD_LAYOUT);
const mobileNavSource = readSource(MOBILE_NAV);
const sharedNavSource = readSource(SHARED_NAV);

/**
 * The Supabase cookie adapter object literal, isolated from the rest of the
 * route. Scoping matters here: the route also calls the Next.js
 * `req.cookies.getAll()` in its fail-closed fallback, which is a completely
 * different API and must not be confused with a Supabase adapter method.
 */
function cookieAdapterSource(): string {
  const start = routeSource.indexOf("cookies: {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = routeSource.indexOf("const { error }", start);
  expect(end).toBeGreaterThan(start);
  return routeSource.slice(start, end);
}

/** The fail-closed sweep, isolated to the `if (error)` branch. */
function errorFallbackSource(): string {
  const start = routeSource.indexOf("if (error) {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = routeSource.indexOf("return response;", start);
  expect(end).toBeGreaterThan(start);
  return routeSource.slice(start, end);
}

/**
 * The route with comments stripped. Identifier and ordering assertions below
 * run against executable code only: the route's doc comment legitimately names
 * `getServerSession()` and `auth.signOut()` when explaining the original
 * defect, and a raw substring search would match that prose rather than code.
 */
function executableRouteSource(): string {
  return routeSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

const routeCode = executableRouteSource();

// ─── Method and client contract ──────────────────────────────────────────────

describe("AUTH-LOGOUT-R1 signout route — method and client contract", () => {
  it("exports a POST handler and accepts the request", () => {
    expect(routeSource).toMatch(/export\s+async\s+function\s+POST\s*\(/);
    // The request object is required: both the cookie reader and the redirect
    // origin are derived from it.
    expect(routeSource).toMatch(/POST\s*\(\s*req\s*:\s*NextRequest\s*\)/);
    expect(routeSource).toContain('from "next/server"');
  });

  it("exposes no GET handler, so logout cannot be triggered by navigation", () => {
    // A GET logout is fired by any <img>, prefetch or drive-by link.
    expect(routeSource).not.toMatch(/export\s+(async\s+)?function\s+GET\b/);
    expect(routeSource).not.toMatch(/export\s+const\s+GET\b/);
  });

  it("builds the cookie-capable SSR server client from @supabase/ssr", () => {
    expect(routeSource).toContain('from "@supabase/ssr"');
    expect(routeSource).toContain("createServerClient(");
    // Package specifiers are case-sensitive on Linux builders even when the
    // local Windows checkout tolerates a wrong case.
    expect(routeSource).not.toContain("@Supabase/ssr");
  });

  it("no longer uses the non-cookie-capable server helper", () => {
    // utils/supabase/server.ts only reads cookies and cannot emit Set-Cookie,
    // which is why the original implementation could never end a session.
    expect(routeSource).not.toContain("@/utils/supabase/server");
    expect(routeCode).not.toContain("getServerSession");
  });

  it("uses only the public Supabase URL and anon key", () => {
    const envRefs = Array.from(
      routeSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)
    ).map((m) => m[1]);
    expect(envRefs.length).toBeGreaterThan(0);
    const allowed = new Set([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]);
    for (const name of envRefs) {
      expect(allowed.has(name), `unexpected environment variable: ${name}`).toBe(true);
    }
  });
});

// ─── Cookie ownership ────────────────────────────────────────────────────────

describe("AUTH-LOGOUT-R1 signout route — cookie ownership", () => {
  it("reads session cookies from the request", () => {
    expect(cookieAdapterSource()).toContain("req.cookies.get(name)?.value");
  });

  it("writes cookie mutations onto the redirect response", () => {
    expect(cookieAdapterSource()).toContain("response.cookies.set({ name, value, ...options })");
  });

  it("writes cookie removals onto the same redirect response", () => {
    // Removal is what actually ends the session for this browser: the dashboard
    // guard trusts the cookie, so it must leave in this response.
    expect(cookieAdapterSource()).toContain('response.cookies.set({ name, value: "", ...options })');
  });

  it("uses the 0.3.0 get/set/remove adapter, not the newer getAll/setAll pair", () => {
    const adapter = cookieAdapterSource();
    expect(adapter).toMatch(/\bget\s*\(\s*name\s*:\s*string\s*\)/);
    expect(adapter).toMatch(/\bset\s*\(\s*name\s*:\s*string/);
    expect(adapter).toMatch(/\bremove\s*\(\s*name\s*:\s*string/);

    // @supabase/ssr 0.3.0 never calls getAll/setAll. An adapter written in the
    // newer shape type-checks but silently does nothing at runtime, which is a
    // far worse failure than a compile error.
    expect(adapter).not.toMatch(/\bgetAll\s*\(/);
    expect(adapter).not.toMatch(/\bsetAll\s*\(/);

    // Scoped deliberately to the adapter. The route legitimately calls the
    // Next.js RequestCookies API `req.cookies.getAll()` in its fallback, and
    // that call must not be mistaken for a Supabase adapter method.
    expect(routeSource).toContain("req.cookies.getAll()");
  });

  it("constructs the response before the client so removals can be written to it", () => {
    const responseIdx = routeCode.indexOf("NextResponse.redirect(");
    const clientIdx = routeCode.indexOf("createServerClient(");
    const signOutIdx = routeCode.indexOf("auth.signOut(");
    expect(responseIdx).toBeGreaterThanOrEqual(0);
    expect(clientIdx).toBeGreaterThan(responseIdx);
    expect(signOutIdx).toBeGreaterThan(clientIdx);
  });
});

// ─── Scope, redirect and fail-closed clearing ────────────────────────────────

describe("AUTH-LOGOUT-R1 signout route — scope, redirect and fail-closed clearing", () => {
  it("signs out with the explicit local scope", () => {
    // Product contract: End Session ends THIS browser only. The library default
    // is `global`, so the scope is stated explicitly rather than inherited.
    expect(routeSource).toMatch(/auth\.signOut\(\s*\{\s*scope:\s*"local"\s*\}\s*\)/);
    expect(routeSource).not.toContain('scope: "global"');
    expect(routeSource).not.toContain('scope: "others"');
  });

  it("redirects to /login", () => {
    expect(routeSource).toContain('new URL("/login", req.url)');
  });

  it("derives the redirect origin from the request, not NEXT_PUBLIC_SITE_URL", () => {
    // The old route redirected to an env-configured origin, falling back to
    // http://localhost:3000 when unset — off-origin from the Set-Cookie.
    expect(routeSource).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(routeSource).not.toContain("localhost:3000");
    expect(routeSource).toContain("req.url");
  });

  it("redirects with an explicit 303 so the browser follows with GET", () => {
    // NextResponse.redirect defaults to 307, which preserves POST and re-posts
    // to the /login page route.
    expect(routeSource).toMatch(/status:\s*303/);
  });

  it("marks the logout response uncacheable", () => {
    expect(routeSource).toMatch(
      /headers\.set\(\s*"Cache-Control",\s*"private, no-store"\s*\)/
    );
  });

  it("clears every auth storage root and its chunks when signOut errors", () => {
    const fallback = errorFallbackSource();

    // auth-js returns before clearing storage on any error other than
    // 401/403/404, so without this sweep an Auth outage leaves the golfer
    // signed in — the original defect, only rarer.
    expect(fallback).toContain("storageRoots");

    // The key is derived from the configured project URL, never hard-coded.
    expect(fallback).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(fallback).toContain("-auth-token");

    // All three roots _removeSession() clears must be named explicitly, so the
    // intent is auditable rather than hidden behind a loose prefix match.
    expect(fallback).toContain("storageKey,");
    expect(fallback).toContain("`${storageKey}-code-verifier`");
    expect(fallback).toContain("`${storageKey}-user`");

    // Both match forms: the unchunked root and the `<root>.<index>` chunks
    // @supabase/ssr writes for oversized values.
    expect(fallback).toContain("cookie.name === root");
    expect(fallback).toContain("cookie.name.startsWith(`${root}.`)");

    // The sweep clears only matching auth cookies, and expires them on the
    // same path @supabase/ssr wrote them to.
    expect(fallback).toContain("req.cookies.getAll()");
    expect(fallback).toMatch(/maxAge:\s*0/);
    expect(fallback).toMatch(/path:\s*"\/"/);
  });
});

// ─── Surfaces and secrets ────────────────────────────────────────────────────

describe("AUTH-LOGOUT-R1 — surfaces and secrets", () => {
  it("keeps the desktop End Session form posting to the shared endpoint", () => {
    expect(layoutSource).toContain("SIGN_OUT");
    expect(layoutSource).toMatch(
      /<form\s+action=\{SIGN_OUT\.href\}\s+method="POST">/
    );
  });

  it("keeps the mobile End Session form posting to the shared endpoint", () => {
    // Desktop and mobile deliberately share one endpoint, so the route fix
    // covers both surfaces and neither needs its own logout handler.
    expect(mobileNavSource).toContain("SIGN_OUT");
    expect(mobileNavSource).toMatch(
      /<form\s+action=\{SIGN_OUT\.href\}\s+method="POST">/
    );
    expect(mobileNavSource).not.toContain("auth.signOut");
  });

  it("keeps SIGN_OUT.href pointed at /api/auth/signout", () => {
    expect(sharedNavSource).toContain('href: "/api/auth/signout"');
    expect(sharedNavSource).toContain('label: "End Session"');
  });

  it("logs nothing and references no service role or token literal", () => {
    // Note: the generic substring "token" is legitimate here — the derived
    // storage key ends in "-auth-token". These bans target the constructs that
    // would actually leak credentials.
    for (const forbidden of [
      "console.log",
      "console.debug",
      "console.info",
      "console.warn",
      "console.error",
      "service_role",
      "SERVICE_ROLE",
      "access_token",
      "refresh_token",
      "document.cookie",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(routeSource, `${forbidden} must not appear in the logout route`).not.toContain(
        forbidden
      );
    }
  });
});
