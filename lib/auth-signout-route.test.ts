import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AUTH-LOGOUT-R1, retargeted by AG-WEB-READY-03-R1 — the End Session route and its two surfaces.
 *
 * SOURCE-CONTRACT REGRESSION COVERAGE (static). The executed behaviour of the route — revocation, the 303/503
 * answers, the budgets and the absence of any Set-Cookie — is covered by lib/auth-signout-route-removal.test.ts, and
 * the browser part of End Session by lib/session-publication.test.ts. None of this proves a hosted logout:
 * FINAL ACCEPTANCE STILL REQUIRES A PRODUCTION LOGOUT CHECK ON A REAL DEVICE, including a second already-authenticated
 * session that must REMAIN signed in, because the approved scope is `local`.
 *
 * History. The original route (a plain client with persistSession: false) never ended anything; AUTH-LOGOUT-R1 moved it
 * to the @supabase/ssr server client with a get/set/remove adapter writing removals onto the redirect. AG-WEB-READY-02
 * found that adapter looping refresh requests (its `get` returned the request cookie after the SDK removed it), and the
 * 02c review showed that ANY server answer that removes cookies can land after another tab published a newer session
 * under the same names (F1). The route is now passive: it revokes the session the request carries at Auth and writes,
 * refreshes into the browser or removes no cookie at all; the browser ends its own copy under the lease.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so no assertion depends on the checkout's line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const SIGNOUT_ROUTE = "app/api/auth/signout/route.ts";
const DASHBOARD_LAYOUT = "app/(dashboard)/layout.tsx";
const MOBILE_NAV = "components/navigation/MobileDashboardNavigation.tsx";
const SHARED_NAV = "components/navigation/dashboard-navigation.tsx";
const END_FORM = "components/navigation/EndSessionForm.tsx";

const routeSource = readSource(SIGNOUT_ROUTE);
const layoutSource = readSource(DASHBOARD_LAYOUT);
const mobileNavSource = readSource(MOBILE_NAV);
const sharedNavSource = readSource(SHARED_NAV);
const formSource = readSource(END_FORM);

/** Executable code only (the doc comment legitimately names what the route does NOT do). */
function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}
const routeCode = executable(routeSource);
const formCode = executable(formSource);

describe("End Session route — method and client contract", () => {
  it("exports a POST handler and accepts the request", () => {
    expect(routeSource).toMatch(/export\s+async\s+function\s+POST\s*\(/);
    expect(routeSource).toMatch(/POST\s*\(\s*req\s*:\s*NextRequest\s*\)/);
    expect(routeSource).toContain('from "next/server"');
  });

  it("exposes no GET handler, so logout cannot be triggered by navigation", () => {
    expect(routeSource).not.toMatch(/export\s+(async\s+)?function\s+GET\b/);
    expect(routeSource).not.toMatch(/export\s+const\s+GET\b/);
  });

  it("builds no SDK client and no cookie adapter: nothing that can read back what it removed and loop", () => {
    expect(routeCode).not.toContain("@supabase/ssr");
    expect(routeCode).not.toContain("@supabase/supabase-js");
    expect(routeCode).not.toContain("createServerClient");
    expect(routeCode).not.toContain("createClient(");
    expect(routeCode).not.toContain("@/utils/supabase/server");
    expect(routeCode).not.toContain("getServerSession");
  });

  it("uses only the public Supabase URL and anon key", () => {
    const envRefs = Array.from(routeSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)).map((m) => m[1]);
    expect(envRefs.length).toBeGreaterThan(0);
    for (const name of envRefs) expect(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]).toContain(name);
  });
});

describe("End Session route — passive: revocation only, no session cookie written or removed (F1)", () => {
  it("never sets, removes or deletes a session cookie on any answer; the ONE cookie it may set is the END INTENT (A2)", () => {
    expect(routeCode).not.toMatch(/\.cookies\.(set|delete)\(/);
    expect(routeCode).not.toContain("maxAge");
    expect(routeCode).not.toContain("planFamilyRemoval");
    expect(routeCode).not.toContain("SESSION_BINDING_COOKIE");
    // A2: exactly one Set-Cookie, appended only by the confirmed-revocation answer, naming only the END INTENT cookie
    // with the revoked lineage's digest; never a removal (Max-Age=0) and never HttpOnly (the page's own writer reads it)
    expect(routeCode.match(/Set-Cookie/g)).toHaveLength(1);
    expect(routeCode).toContain('response.headers.append(\n    "Set-Cookie",\n    `${END_INTENT_COOKIE}=${lineage}; Path=/; Max-Age=${END_INTENT_MAX_AGE_S}; SameSite=Lax${secure ? "; Secure" : ""}`,');
    expect(routeCode).not.toMatch(/Max-Age=0|HttpOnly/i);
  });

  it("reads the session from the request's own Cookie header with the shared strict layout reader", () => {
    expect(routeCode).toContain('req.headers.get("cookie")');
    expect(routeCode).toContain("readSessionLayout(");
    expect(routeCode).toContain('from "@/utils/supabase/session-cookie-layout"');
  });

  it("revokes with the explicit local scope, and refreshes at most once, only to revoke", () => {
    expect(routeCode).toContain('"logout?scope=local"');
    expect(routeCode).not.toContain("scope=global");
    expect(routeCode).not.toContain("scope=others");
    expect(routeCode.match(/"token\?grant_type=refresh_token"/g)).toHaveLength(1);
  });

  it("counts a session as ended only when Auth confirms it; even then answers honestly that this device's copy remains (A2), never a redirect that implies a complete sign-out", () => {
    // A3: only a confirmed revocation of the intended lineage gets the ended page. A4 (C2): the outcome is four-way — a
    // refresh refused by Auth is "unconfirmed" (its own honest page), never "ended"
    expect(routeCode).toMatch(/if \(revocation === "ended"\) return endedAtServer\(req, carried\);/);
    expect(routeCode).toMatch(/if \(revocation === "other_lineage"\) return otherSignIn\(\);\n\s*if \(revocation === "unconfirmed"\) return unconfirmedEnd\(\);\n\s*return notEnded\(form\.user, form\.session, "unreachable"\);/);
    // A4 review: every refusal of the revoke-only refresh but a rate limit is unconfirmed (Auth answered; no lineage named)
    expect(routeCode).toMatch(/if \(refreshed\.status === 429\) return "not_ended";\n\s*if \(refreshed\.status >= 400 && refreshed\.status <= 499\) return "unconfirmed";/);
    expect(routeCode).not.toMatch(/refreshed\.status[^;]*\? "ended"/);
    const unconfirmedStart = routeCode.indexOf("function unconfirmedEnd(");
    const unconfirmed = routeCode.slice(unconfirmedStart, routeCode.indexOf("function endedAtServer(", unconfirmedStart));
    expect(unconfirmedStart).toBeGreaterThan(-1);
    expect(unconfirmed).toContain("status: 409");
    expect(unconfirmed).not.toContain("<form");
    expect(unconfirmed).not.toContain("Set-Cookie");
    expect(routeSource).toContain("We couldn't confirm that the requested sign-in was ended.");
    // A3 review: that answer is an honest page with no retry form (a retry would present the rotated token again)
    const otherStart = routeCode.indexOf("function otherSignIn(");
    const other = routeCode.slice(otherStart, routeCode.indexOf("function endedAtServer(", otherStart));
    expect(otherStart).toBeGreaterThan(-1);
    expect(other).toContain("status: 409");
    expect(other).not.toContain("<form");
    expect(routeSource).toContain("Your session wasn't ended");
    expect(routeSource).toContain("you're still signed in on this device");
    expect(routeSource).toContain("This device still holds a copy of it until the sign-in page removes it.");
    expect(routeSource).toContain("JavaScript is off, so the sign-in page can't remove that copy.");
  });

  it("A3: the refresh made solely to revoke is checked against the form's account AND lineage before the second logout", () => {
    const body = routeCode.slice(routeCode.indexOf("async function revokeCarried("), routeCode.indexOf("export async function POST("));
    const account = body.indexOf('if (jwtClaims(current).sub !== intended.user) return "other_lineage";');
    const lineage = body.indexOf('if ((await sessionLineageId(current)) !== intended.lineage) return "other_lineage";');
    const secondLogout = body.lastIndexOf('exchange("logout?scope=local", bearer(current)');
    expect(account).toBeGreaterThan(-1);
    expect(lineage).toBeGreaterThan(account);
    expect(secondLogout).toBeGreaterThan(lineage);
    expect(routeCode).toContain("{ user: form.user, lineage: carried },");
  });

  it("returns to /dashboard, changing nothing, when the carried session belongs to another account than the page showed", () => {
    expect(routeCode).toMatch(/holder !== form\.user\) return redirect\(req, "\/dashboard"\)/);
  });

  it("A2: revokes only the session lineage the page was rendered for (never a newer sign-in, even of the same account)", () => {
    expect(routeCode).toContain("const carried = await sessionLineageId(envelope.accessToken);");
    expect(routeCode).toMatch(/if \(carried === null \|\| carried !== form\.session\) return redirect\(req, "\/dashboard"\);/);
    expect(routeCode.indexOf("carried !== form.session")).toBeLessThan(routeCode.indexOf("await revokeCarried("));
  });

  it("revokes nothing unless the form names the account and lineage: an unreadable body gets the honest page, a body naming neither gets the honest outdated-page answer (A5)", () => {
    expect(routeCode).toMatch(/if \(form\.kind === "unreadable"\) return notEnded\(null, null, "unreadable"\);/);
    expect(routeCode).toMatch(/if \(form\.kind === "none" \|\| form\.user === null \|\| form\.session === null\) return outdatedEnd\(\);/);
    expect(routeCode.indexOf('form.kind === "none"')).toBeLessThan(routeCode.indexOf("await revokeCarried("));
    // A5 (E1): decided before the carried session is read for an account or lineage — the target is never inferred from the jar
    expect(routeCode.indexOf('form.kind === "none"')).toBeLessThan(routeCode.indexOf("const holder = jwtClaims(envelope.accessToken).sub;"));
    const start = routeCode.indexOf("function outdatedEnd(): NextResponse {");
    const outdated = routeCode.slice(start, routeCode.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(outdated).toContain("status: 409,");
    expect(outdated).toContain('"Cache-Control": "private, no-store"');
    expect(outdated).not.toMatch(/Set-Cookie|cookies|<form/i);
  });

  it("A2: end_state is display only — it is read only for a post that carries no session (nothing to revoke)", () => {
    expect(routeCode).toContain('if (form.kind === "form" && form.state === "ended_unconfirmed" && sameOriginPost(req)) return endedUnconfirmed();');
    expect(routeCode).toContain('if (site !== null) return site === "same-origin";');
    expect(routeCode.indexOf("form.state")).toBeLessThan(routeCode.indexOf('if (form.kind === "unreadable")'));
    expect(routeCode.match(/form\.state/g)).toHaveLength(1);
  });
});

describe("End Session route — redirect and caching", () => {
  it("redirects to /login with an explicit 303 so the browser follows with GET (nothing to revoke here)", () => {
    expect(routeCode).toContain('redirect(req, "/login")');
    expect(routeSource).toMatch(/status:\s*303/);
  });

  it("redirects with a relative Location (the browser resolves it against the page it used: right behind a TLS proxy or on loopback, never another origin), not NEXT_PUBLIC_SITE_URL", () => {
    expect(routeSource).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(routeSource).not.toContain("localhost:3000");
    expect(routeCode).toContain("new NextResponse(null, { status: 303, headers: { Location: path } })");
    expect(routeCode).toMatch(/path: "\/login" \| "\/dashboard"/);
  });

  it("marks every answer uncacheable", () => {
    expect(routeSource).toMatch(/headers\.set\(\s*"Cache-Control",\s*"private, no-store"\s*\)/);
    expect(routeSource).toMatch(/"Cache-Control":\s*"private, no-store"/);
  });

  it("states one budget for headers and body together, separate from the form-body budget", () => {
    expect(routeCode).toMatch(/const DISPATCH_MS = 2_000;/);
    expect(routeCode).toMatch(/const REVOKE_BUDGET_MS = 6_000;/);
    expect(routeCode).toMatch(/const FORM_BUDGET_MS = 3_000;/);
    expect(routeCode).toContain("readCapped(response.body, REFRESH_BODY_CAP_BYTES, controller.signal)");
  });
});

describe("End Session — surfaces and secrets", () => {
  it("both surfaces render the one End Session form, which posts to the shared endpoint with the page's account", () => {
    expect(layoutSource).toContain("<EndSessionForm");
    expect(layoutSource).toContain("expectedUserId={user.id}");
    expect(mobileNavSource).toContain("<EndSessionForm");
    expect(mobileNavSource).toContain("expectedUserId={userId}");
    expect(mobileNavSource).not.toContain("auth.signOut");
    expect(formSource).toMatch(/<form action=\{SIGN_OUT\.href\} method="POST" onSubmit=\{handleSubmit\}>/);
    expect(formSource).toContain('name="expected_user"');
    // A2: both surfaces also name the lineage the server rendered (a digest of the session id, never a token)
    expect(layoutSource).toContain("const endSessionLineage = await sessionLineageId(session.access_token);");
    expect(layoutSource).toContain("expectedSession={endSessionLineage}");
    expect(layoutSource).toContain("endSessionLineage={endSessionLineage}");
    expect(mobileNavSource).toContain("expectedSession={endSessionLineage}");
    expect(formSource).toContain('<input type="hidden" name="expected_session" value={expectedSession} />');
    expect(formSource).toContain('<input type="hidden" name="end_state" defaultValue="" />');
  });

  it("the form posts only after the browser part has finished, never on a timer race", () => {
    expect(formCode).not.toContain("Promise.race");
    expect(formCode).not.toContain("setTimeout");
    expect(formCode).toContain("attempt = endSessionInBrowser(expectedUserId, undefined, expectedSession)");
    expect(formCode).toContain("const result = await outcome;");
    expect(formCode.indexOf("const result = await outcome;")).toBeLessThan(formCode.indexOf("target.submit()"));
  });

  it("keeps SIGN_OUT.href pointed at /api/auth/signout", () => {
    expect(sharedNavSource).toContain('href: "/api/auth/signout"');
    expect(sharedNavSource).toContain('label: "End Session"');
  });

  it("logs nothing and references no service role or browser storage; the refresh token appears only in the revoke-only refresh body", () => {
    for (const forbidden of ["console.", "service_role", "SERVICE_ROLE", "document.cookie", "localStorage", "sessionStorage"]) {
      expect(routeCode, `${forbidden} must not appear in the logout route`).not.toContain(forbidden);
    }
    expect(routeCode.match(/\brefresh_token\b/g)).toEqual(["refresh_token", "refresh_token"]); // the grant name and the body field
    expect(routeCode).toContain("JSON.stringify({ refresh_token: refreshToken })");
  });
});
