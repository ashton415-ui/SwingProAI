import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChunks } from "@supabase/ssr";
import { resumeExpiringSession } from "@/utils/supabase/session-resume";
import { sessionBinding } from "@/utils/supabase/session-cookie-layout";

// AG-WEB-READY-03-R1 — expiring-session routing (utils/supabase/session-resume.ts) and the /auth/resume page contract.
// The server never refreshes or writes a session: a protected page navigation (GET/HEAD, no Authorization) whose
// session cookie states an expiry less than 30 s away, or past, is sent with 307 to /auth/resume?next=&seen=, where the
// browser's own client refreshes under the lease; everything else passes through untouched. It is not an
// authentication gate. Executed with real NextRequests; Auth must never be contacted (the platform fetch throws).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sb-127-auth-token";
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const APP = "http://127.0.0.1:3941";

const value = (expiresInS: number | null, pad = 0) =>
  JSON.stringify({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    ...(expiresInS === null ? {} : { expires_at: Math.floor(NOW / 1000) + expiresInS }),
    user: { id: "u", p: "p".repeat(pad) },
  });
const bare = (v: string) => `${KEY}=${encodeURIComponent(v)}`;
const chunked = (v: string) => createChunks(KEY, v).map((c: { name: string; value: string }) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");

function request(pathAndQuery: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  return new NextRequest(`${APP}${pathAndQuery}`, { method: init.method ?? "GET", headers });
}
const passesThrough = (r: Response) => r.headers.get("x-middleware-next") === "1" && r.headers.get("location") === null;
const noSideEffects = (r: Response) => {
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("x-middleware-override-headers")).toBeNull();
  expect(r.headers.get("x-middleware-rewrite")).toBeNull();
};

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

describe("routing an expiring session to /auth/resume", () => {
  for (const [label, cookie] of [
    ["bare, 29 s left", bare(value(29))],
    ["bare, already expired", bare(value(-600))],
    ["chunked, 10 s left", chunked(value(10, 5000))],
  ] as const) {
    it(`${label}: 307 to /auth/resume with next and seen, private no-store, no cookie written`, async () => {
      const r = (await resumeExpiringSession(request("/drills?tab=2", { cookie })));
      expect(r.status).toBe(307);
      const to = new URL(r.headers.get("location") as string);
      expect([to.pathname, to.searchParams.get("next"), r.headers.get("cache-control")]).toEqual(["/auth/resume", "/drills?tab=2", "private, no-store"]);
      expect(Number(to.searchParams.get("seen"))).toBe(Math.floor(NOW / 1000) + Number(label.includes("expired") ? -600 : label.includes("29") ? 29 : 10));
      noSideEffects(r);
    });
  }

  // A4 (C4): the browser's writer stores expires_at as null; the expiry is the access token's exp claim
  const nullStored = (expInS: number | null) =>
    JSON.stringify({
      access_token: `h.${Buffer.from(JSON.stringify(expInS === null ? { sub: "u" } : { sub: "u", exp: Math.floor(NOW / 1000) + expInS })).toString("base64url")}.sig`,
      refresh_token: "synthetic-refresh",
      expires_at: null,
      user: { id: "u" },
    });
  it("A4 (C4): a null-stored session is routed by its access token's exp — expiring (bare or chunked) goes by resume with that exp as seen; fresh, or with no exp claim, passes through", async () => {
    for (const [cookie, expected] of [
      [bare(nullStored(20)), Math.floor(NOW / 1000) + 20],
      [chunked(JSON.stringify({ ...JSON.parse(nullStored(-60)), user: { id: "u", p: "p".repeat(5000) } })), Math.floor(NOW / 1000) - 60],
    ] as const) {
      const r = await resumeExpiringSession(request("/drills", { cookie }));
      expect(r.status).toBe(307);
      const seen = Number(new URL(r.headers.get("location") as string).searchParams.get("seen"));
      expect(seen).toBe(expected);
      noSideEffects(r);
    }
    for (const cookie of [bare(nullStored(3600)), bare(nullStored(null))]) {
      const r = await resumeExpiringSession(request("/drills", { cookie }));
      expect(passesThrough(r)).toBe(true);
      noSideEffects(r);
    }
  });

  it("margin edges: exactly 30 s left passes through; 29.999 s is sent to resume", async () => {
    vi.setSystemTime(NOW);
    expect(passesThrough(await resumeExpiringSession(request("/drills", { cookie: bare(value(30)) })))).toBe(true);
    vi.setSystemTime(NOW + 1);
    expect((await resumeExpiringSession(request("/drills", { cookie: bare(value(30)) }))).status).toBe(307);
  });

  for (const [label, cookie] of [
    ["bare beside chunks", `${bare(value(3600))}; ${chunked(value(3600, 5000))}`],
    ["a chunked session caught without its head (.0 removed first by a writer in another tab)", `${KEY}.1=x; ${KEY}.2=y`],
    ["a malformed member", `${KEY}.00=${encodeURIComponent(value(3600))}`],
  ] as const) {
    it(`an ambiguous jar (${label}): 307 to /auth/resume with next and unsettled=1 (no seen), where the browser waits it out — never taken for no session (QA F-A)`, async () => {
      const r = (await resumeExpiringSession(request("/drills?tab=2", { cookie })));
      expect(r.status).toBe(307);
      const to = new URL(r.headers.get("location") as string);
      expect([to.pathname, to.searchParams.get("next"), to.searchParams.get("unsettled"), to.searchParams.get("seen"), r.headers.get("cache-control")]).toEqual([
        "/auth/resume",
        "/drills?tab=2",
        "1",
        null,
        "private, no-store",
      ]);
      noSideEffects(r);
    });
  }

  it("HEAD is routed like GET; an RSC navigation or prefetch (same GET with RSC headers) is routed too (AM-N3: Next follows the 307)", async () => {
    expect((await resumeExpiringSession(request("/drills", { method: "HEAD", cookie: bare(value(5)) }))).status).toBe(307);
    expect((await resumeExpiringSession(request("/drills?_rsc=x", { cookie: bare(value(5)), headers: { rsc: "1", "next-router-prefetch": "1" } }))).status).toBe(307);
  });
});

describe("everything else passes through untouched", () => {
  for (const [label, init] of [
    ["a fresh session", { cookie: bare(value(3600)) }],
    ["no session", { cookie: "other=1" }],
    ["no cookie header", {}],
    ["a POST (a server action or form)", { method: "POST", cookie: bare(value(5)) }],
    ["a PUT", { method: "PUT", cookie: bare(value(5)) }],
    ["an Authorization header (bearer ingress)", { cookie: bare(value(5)), headers: { authorization: "Bearer x" } }],
    ["the one-minute resume marker", { cookie: `${bare(value(5))}; swingproai-session-resumed=1` }],
    ["an ambiguous jar after a resume (the one-minute marker)", { cookie: `${KEY}.1=x; swingproai-session-resumed=1` }],
    ["no expires_at", { cookie: bare(value(null)) }],
    ["a value that is not JSON", { cookie: `${KEY}=not-json` }],
  ] as [string, { method?: string; cookie?: string; headers?: Record<string, string> }][]) {
    it(label, async () => {
      const r = (await resumeExpiringSession(request("/drills", init)));
      expect(passesThrough(r)).toBe(true);
      noSideEffects(r);
    });
  }

  it("a thrown error inside routing passes through (never an auth gate)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a url");
    const r = await resumeExpiringSession(request("/drills", { cookie: bare(value(5)) }));
    expect(passesThrough(r)).toBe(true);
  });
});

describe("the binding cookie (A1 R2: a session written outside the browser's own writer)", () => {
  const BINDING = "swingproai-session-binding";
  const fresh = value(3600);
  const bindingOf = async (accessToken: string) => (await sessionBinding(accessToken)) as string;

  it("a binding that names the carried access token: routed exactly as without one (fresh passes; expiring goes by resume with seen)", async () => {
    const b = await bindingOf("synthetic-access");
    expect(passesThrough(await resumeExpiringSession(request("/drills", { cookie: `${bare(fresh)}; ${BINDING}=${b}` })))).toBe(true);
    const r = await resumeExpiringSession(request("/drills", { cookie: `${bare(value(5))}; ${BINDING}=${b}` }));
    expect([r.status, new URL(r.headers.get("location") as string).searchParams.has("seen")]).toEqual([307, true]);
  });

  for (const [label, binding] of [
    ["names another session (a previous bundle's late write after the browser's own writer stored a newer one)", "other"],
    ["says the browser's own writer removed the session ('none')", "none"],
    ["is not a binding value", "zz"],
  ] as const) {
    it(`a FRESH complete session whose binding ${label}: 307 to /auth/resume?unsettled=1 (never handed to the server as that session)`, async () => {
      const b = binding === "other" ? await bindingOf("synthetic-other-access") : binding;
      const r = await resumeExpiringSession(request("/drills?tab=2", { cookie: `${bare(fresh)}; ${BINDING}=${b}` }));
      expect(r.status).toBe(307);
      const to = new URL(r.headers.get("location") as string);
      expect([to.pathname, to.searchParams.get("next"), to.searchParams.get("unsettled"), to.searchParams.get("seen")]).toEqual(["/auth/resume", "/drills?tab=2", "1", null]);
      noSideEffects(r);
    });
  }

  it("a duplicated binding vouches for nothing: unsettled", async () => {
    const b = await bindingOf("synthetic-access");
    const r = await resumeExpiringSession(request("/drills", { cookie: `${bare(fresh)}; ${BINDING}=${b}; ${BINDING}=${b}` }));
    expect(new URL(r.headers.get("location") as string).searchParams.get("unsettled")).toBe("1");
  });

  it("negative controls: no binding at all (the pre-migration state) passes; a mismatch on a POST, with the resume marker, or with no session passes through untouched", async () => {
    expect(passesThrough(await resumeExpiringSession(request("/drills", { cookie: bare(fresh) })))).toBe(true);
    const other = await bindingOf("synthetic-other-access");
    for (const init of [
      { method: "POST", cookie: `${bare(fresh)}; ${BINDING}=${other}` },
      { cookie: `${bare(fresh)}; ${BINDING}=${other}; swingproai-session-resumed=1` },
      { cookie: `${BINDING}=${other}` },
      { cookie: `${BINDING}=none` },
    ]) {
      const r = await resumeExpiringSession(request("/drills", init));
      expect(passesThrough(r)).toBe(true);
      noSideEffects(r);
    }
  });
});

describe("the /auth/resume page contract (static; its runtime is exercised in the real-browser harness)", () => {
  const page = readFileSync(path.join(ROOT, "app", "(auth)", "auth", "resume", "page.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("continues only to a checked same-origin target, sets the no-credential marker first, and never writes a session", () => {
    expect(page).toContain("safeResumeTarget(params.get(\"next\"), window.location.origin)");
    expect(page).toContain("serialize(RESUME_MARKER_COOKIE, \"1\"");
    expect(page).toContain("maxAge: RESUME_MARKER_MAX_AGE_S");
    expect(page).not.toMatch(/setSession|signIn|access_token|refresh_token/);
  });
  it("bounds every call (8 s, 2 attempts) and sends a golfer with no session to /login", () => {
    expect(page).toContain("const CALL_DEADLINE_MS = 8_000;");
    expect(page).toContain("const ATTEMPTS = 2;");
    expect(page).toContain('window.location.replace("/login")');
  });
  it("after an unsettled jar, a session the browser reads with more than 30 s left goes straight back; otherwise it is refreshed first", () => {
    expect(page).toContain('const unsettled = params.get("unsettled") === "1";');
    expect(page).toContain("const UNSETTLED_FRESH_MS = 30_000;");
    expect(page).toMatch(/const fresh = unsettled\s*\?\s*expiresAt !== null && expiresAt \* 1000 - Date\.now\(\) > UNSETTLED_FRESH_MS/);
  });
  it("always offers Sign in again, a noscript note and a 44 px Try again when Auth is unreachable", () => {
    expect(page).toContain("Sign in again");
    expect(page).toContain("<noscript>");
    expect(page).toMatch(/min-h-11[^"]*w-full/);
    expect(page).toContain("You're still signed in on this device");
  });
  it("A1: a refused (unverified) session read is never used and never read as signed out: the page says it cannot confirm which account (Try again offered), or that the browser is unsupported; only an Auth failure says 'still signed in'", () => {
    expect(page).toContain("sessionUnverifiedReason");
    expect(page).toContain('setPhase(unverified === "unsupported" ? "unsupported" : unverified !== null ? "unconfirmed" : "unavailable");');
    expect(page).toContain("We couldn't confirm which account is signed in on this device, so nothing was loaded.");
    expect(page).toContain("This browser can't keep your sign-in safe.");
    expect(page).toContain('{(phase === "unavailable" || phase === "unconfirmed") && (');
  });
});
