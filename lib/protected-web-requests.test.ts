import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// AG-WEB-READY-10-P4 — the protected browser path
// ============================================================================
//
// Part A executes the Analyze page's request sender (lib/protected-web-requests.ts) against a recording fetch: the
// default path must be the old request exactly; the opt-in path must go to the fixed same-origin web endpoint with this
// origin's cookies and no redirect followed.
//
// Part B executes the four web endpoints for real — the wrapper route, the boundary, the EXISTING handler and the REAL
// verifier (utils/supabase/server.ts). Only the two things a unit test cannot own are mocked, as in
// lib/verified-auth-resolver.test.ts: the request context (next/headers) and Supabase (its Auth verdict per token, and a
// recording client). Every case below carries a valid session cookie of ANOTHER golfer (B), so a cookie fallback
// anywhere would show up as B being verified or acted for.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const readSource = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

const state = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
  /** access token -> the user Auth confirms for it */
  users: new Map<string, { id: string; email: string }>(),
  /** Auth's answer for every verification: null = by token; otherwise an outage or refusal */
  authMode: null as null | "retryable" | "throw" | { status: number },
  /** every token Auth was asked to verify, in order */
  verified: [] as string[],
  /** every client constructed: its key kind and the Authorization it carries */
  created: [] as { key: string; authorization: string | null }[],
  /** every data or Storage call made by any client: [authorization, operation, ...] */
  calls: [] as unknown[][],
}));

// the analysis route and its authorities are server-only modules (as lib/ent-1a-analysis-authority.test.ts does)
vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => {
      const lower = name.toLowerCase();
      if (lower === "cookie") {
        return state.cookies.size === 0 ? null : Array.from(state.cookies, ([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
      }
      return state.headers.has(lower) ? (state.headers.get(lower) as string) : null;
    },
  }),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, key: string, options?: { global?: { headers?: Record<string, string> } }) => {
    const authorization = options?.global?.headers?.Authorization ?? null;
    state.created.push({ key, authorization });
    const record = (...op: unknown[]) => state.calls.push([authorization, ...op]);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "is", "in", "order", "limit", "maybeSingle", "single"]) {
      chain[m] = (...args: unknown[]) => { record("db", m, ...args); return chain; };
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "unit-test stop", code: "UNIT" } });
    return {
      auth: {
        getUser: async (jwt?: string) => {
          state.verified.push(String(jwt));
          if (state.authMode === "throw") throw new Error("socket hang up");
          if (state.authMode === "retryable") return { data: { user: null }, error: { name: "AuthRetryableFetchError", message: "fetch failed" } };
          if (state.authMode !== null) return { data: { user: null }, error: { name: "AuthApiError", status: state.authMode.status, message: "synthetic" } };
          const user = jwt ? state.users.get(jwt) : undefined;
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid claim" } };
        },
      },
      storage: {
        from: (bucket: string) => ({
          createSignedUploadUrl: async (objectPath: string, opts: unknown) => {
            record("storage", "createSignedUploadUrl", bucket, objectPath, opts);
            return { data: { signedUrl: "https://unused.example/x", token: "unit-test-signature", path: objectPath }, error: null };
          },
          info: async (objectPath: string) => { record("storage", "info", bucket, objectPath); return { data: null, error: { message: "unit-test stop" } }; },
        }),
      },
      from: (table: string) => { record("db", "from", table); return chain; },
      rpc: (...args: unknown[]) => { record("db", "rpc", ...args); return chain; },
    };
  },
}));

import {
  APP_REQUEST_PATHS,
  PROTECTED_WEB_PATHS,
  protectedWebRequestsEnabled,
  sendAppRequest,
  type AppRequestName,
} from "@/lib/protected-web-requests";
import { buildUploadObjectPath } from "@/lib/api/v1-upload-dto";
import { POST as webAuthorize } from "@/app/api/web/uploads/authorize/route";
import { POST as webFinalize } from "@/app/api/web/uploads/finalize/route";
import { POST as webAnalyses } from "@/app/api/web/analyses/route";
import { POST as webAnalyzeSwing } from "@/app/api/web/analyze-swing/route";
import { POST as v1Authorize } from "@/app/api/v1/uploads/authorize/route";
import type { NextRequest } from "next/server";

const FLAG = "NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS";
const TEST_URL = "https://abcdefghijklmnop.supabase.co";
const ANON = "test-anon-key-not-a-secret";
const SERVICE = "test-service-role-key-not-a-secret";
const COOKIE_NAME = "sb-abcdefghijklmnop-auth-token";
const A = { id: "aaaaaaaa-1111-4222-8333-444444444444", email: "golfer-a@example.test", token: "golfer-a.access.token" };
const B = { id: "bbbbbbbb-1111-4222-8333-444444444444", email: "golfer-b@example.test", token: "golfer-b.access.token" };
const UPLOAD_ID = "cccccccc-dddd-4eee-8fff-000000000000";
const AUTH_UNAVAILABLE_COPY = "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly.";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) saved[k] = process.env[k];
  delete process.env[FLAG];
  process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  state.headers.clear();
  state.cookies.clear();
  state.users.clear();
  state.users.set(A.token, { id: A.id, email: A.email });
  state.users.set(B.token, { id: B.id, email: B.email });
  state.authMode = null;
  state.verified.length = 0;
  state.created.length = 0;
  state.calls.length = 0;
  // every case carries golfer B's valid session cookie: a fallback to it anywhere would be visible
  state.cookies.set(COOKIE_NAME, JSON.stringify({ access_token: B.token, refresh_token: "r", expires_at: 1, user: { id: B.id } }));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  vi.unstubAllGlobals();
});

// ─── Part A: the page's sender ────────────────────────────────────────────────

const NAMES: AppRequestName[] = ["authorize", "finalize", "analyses", "analyze"];
const REQUEST = { headers: { "Content-Type": "application/json", Authorization: "Bearer page-confirmed" }, body: '{"x":1}' };

function recordFetch() {
  const sent: { url: string; init: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: Record<string, unknown>) => { sent.push({ url, init }); return new Response(null, { status: 204 }); });
  return sent;
}

describe("P4 sender — the default path is the old request exactly", () => {
  it.each([[undefined], ["0"], ["true"], [""], ["1 "], ["yes"]])("with the opt-in %s, each of the four requests goes to its existing endpoint with credentials \"omit\" and nothing else", async (value) => {
    if (value !== undefined) process.env[FLAG] = value;
    expect(protectedWebRequestsEnabled()).toBe(false);
    const sent = recordFetch();
    for (const name of NAMES) await sendAppRequest(name, REQUEST);
    expect(sent).toEqual(NAMES.map((name) => ({
      url: APP_REQUEST_PATHS[name],
      init: { method: "POST", credentials: "omit", headers: REQUEST.headers, body: REQUEST.body },
    })));
  });

  it("the existing endpoints are the four the page has always used", () => {
    expect(APP_REQUEST_PATHS).toEqual({
      authorize: "/api/v1/uploads/authorize",
      finalize: "/api/v1/uploads/finalize",
      analyses: "/api/v1/analyses",
      analyze: "/api/analyze-swing",
    });
  });
});

describe("P4 sender — the opt-in path", () => {
  it("each request goes to its fixed web endpoint on this exact origin: same-origin mode and cookies, no redirect followed, the same headers and body", async () => {
    process.env[FLAG] = "1";
    vi.stubGlobal("window", { location: { origin: "https://staging-app.example" } });
    const sent = recordFetch();
    for (const name of NAMES) await sendAppRequest(name, REQUEST);
    expect(sent).toEqual(NAMES.map((name) => ({
      url: `https://staging-app.example${PROTECTED_WEB_PATHS[name]}`,
      init: { method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", headers: REQUEST.headers, body: REQUEST.body },
    })));
  });

  it("the web endpoints are fixed relative paths, distinct from every existing endpoint, each with its own route file", () => {
    expect(PROTECTED_WEB_PATHS).toEqual({
      authorize: "/api/web/uploads/authorize",
      finalize: "/api/web/uploads/finalize",
      analyses: "/api/web/analyses",
      analyze: "/api/web/analyze-swing",
    });
    for (const p of Object.values(PROTECTED_WEB_PATHS)) {
      expect(p.startsWith("/api/web/")).toBe(true);
      expect(Object.values(APP_REQUEST_PATHS)).not.toContain(p);
      expect(readSource(`app${p}/route.ts`)).toContain("requireBearerHeader(");
    }
  });

  it("a rejected request (the fetch failure a refused redirect produces) reaches the page as the same TypeError a lost connection does", async () => {
    process.env[FLAG] = "1";
    vi.stubGlobal("window", { location: { origin: "https://staging-app.example" } });
    vi.stubGlobal("fetch", async (_url: string, init: { redirect?: string }) => {
      if (init.redirect === "error") throw new TypeError("Failed to fetch");
      return new Response(null, { status: 200 });
    });
    await expect(sendAppRequest("authorize", REQUEST)).rejects.toThrow(TypeError);
  });
});

// ─── Part B: the web endpoints (wrapper → boundary → existing handler → real verifier) ────────────────────────

type Route = { name: string; post: (r: Request) => Promise<Response>; shape: "v1" | "analyze-swing"; path: string };
const ROUTES: Route[] = [
  { name: "authorize", post: webAuthorize, shape: "v1", path: "/api/web/uploads/authorize" },
  { name: "finalize", post: webFinalize, shape: "v1", path: "/api/web/uploads/finalize" },
  { name: "analyses", post: webAnalyses, shape: "v1", path: "/api/web/analyses" },
  { name: "analyze-swing", post: (r) => webAnalyzeSwing(r as NextRequest), shape: "analyze-swing", path: "/api/web/analyze-swing" },
];
const request = (route: Route, body: unknown = {}) =>
  new Request(`https://staging-app.example${route.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (r: Response) => JSON.parse(await r.text());
/** nothing was read or written: no data or Storage call, no service-role client, no caller-scoped client */
const nothingTouched = () => state.calls.length === 0 && state.created.every((c) => c.key === ANON && c.authorization === null);

describe("P4 web endpoints — off by default", () => {
  it.each(ROUTES.map((r) => [r.name, r] as const))("%s answers 404 and runs nothing without the opt-in, whatever the request carries", async (_n, route) => {
    state.headers.set("authorization", `Bearer ${A.token}`);
    const r = await route.post(request(route));
    expect(r.status).toBe(404);
    expect(state.verified).toEqual([]);
    expect(state.created).toEqual([]);
    expect(state.calls).toEqual([]);
  });
});

describe("P4 web endpoints — the Bearer decides; golfer B's valid cookie is never identity", () => {
  beforeEach(() => { process.env[FLAG] = "1"; });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: no Authorization header — refused 401 before the handler; Auth is never asked; nothing is read or written", async (_n, route) => {
    const r = await route.post(request(route, { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 2048, analysisId: UPLOAD_ID, swingVideoId: UPLOAD_ID }));
    expect(r.status).toBe(401);
    const body = await json(r);
    if (route.shape === "v1") {
      expect(body.error.code).toBe("AUTH_REQUIRED");
      expect(body.error.requestId).toBe(r.headers.get("X-Request-Id"));
    } else {
      expect(body).toEqual({ error: "Unauthorized" });
    }
    expect(state.verified).toEqual([]);
    expect(state.created).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("control: the EXISTING V1 endpoint, given the same request, falls back to the cookie and verifies golfer B — the rule the web endpoint adds", async () => {
    const r = await v1Authorize(request(ROUTES[0]));
    expect(r.status).toBe(400); // authenticated (as B, from the cookie), then the empty body is refused
    expect(state.verified).toEqual([B.token]);
  });

  const MALFORMED: [string, string][] = [
    ["an empty header", ""],
    ["another scheme", `Basic ${A.token}`],
    ["the scheme alone", "Bearer"],
    ["three parts", `Bearer ${A.token} extra`],
    ["two credentials joined", `Bearer ${A.token}, Bearer ${B.token}`],
  ];
  for (const route of ROUTES) {
    it.each(MALFORMED)(`${route.name}: a malformed Authorization header (%s) is refused 401 by the existing verifier; Auth is never asked; the cookie is never used`, async (_label, value) => {
      state.headers.set("authorization", value);
      const r = await route.post(request(route, { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 2048, analysisId: UPLOAD_ID, swingVideoId: UPLOAD_ID }));
      expect(r.status).toBe(401);
      const body = await json(r);
      if (route.shape === "v1") expect(body.error.code).toBe("AUTH_INVALID");
      else expect(body).toEqual({ error: "Unauthorized" });
      expect(state.verified).toEqual([]);
      expect(nothingTouched()).toBe(true);
    });

    it.each([["an invalid token (Auth: 401)", 401], ["an expired token (Auth: 403)", 403]] as [string, number][])(`${route.name}: %s is refused 401 before any read or write; only the presented token was checked, never B's`, async (_label, status) => {
      state.authMode = { status };
      state.headers.set("authorization", "Bearer presented.but.refused");
      const r = await route.post(request(route, { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 2048, analysisId: UPLOAD_ID, swingVideoId: UPLOAD_ID }));
      expect(r.status).toBe(401);
      const body = await json(r);
      if (route.shape === "v1") expect(body.error.code).toBe("AUTH_INVALID");
      else expect(body).toEqual({ error: "Unauthorized" });
      expect(state.verified).toEqual(["presented.but.refused"]);
      expect(nothingTouched()).toBe(true);
    });

    it.each([["a transport failure", "retryable"], ["a thrown verification", "throw"], ["Auth's own 503", 503], ["a rate limit", 429]] as [string, unknown][])(`${route.name}: a verification outage (%s) is 503 — the existing recovery — and never a fallback to the cookie`, async (_label, mode) => {
      state.authMode = typeof mode === "number" ? { status: mode } : (mode as "retryable" | "throw");
      state.headers.set("authorization", `Bearer ${A.token}`);
      const r = await route.post(request(route, { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 2048, analysisId: UPLOAD_ID, swingVideoId: UPLOAD_ID }));
      expect(r.status).toBe(503);
      const body = await json(r);
      if (route.shape === "v1") expect(body.error.code).toBe("SERVER_TEMPORARILY_UNAVAILABLE");
      else expect(body).toEqual({ error: AUTH_UNAVAILABLE_COPY });
      expect(state.verified).toEqual([A.token]);
      expect(nothingTouched()).toBe(true);
    });

    it(`${route.name}: golfer A's valid Bearer with golfer B's valid cookie — the handler runs as A, on A's own client; B is never verified`, async () => {
      state.headers.set("authorization", `Bearer ${A.token}`);
      const r = await route.post(request(route, {})); // an empty body: the handler stops at its own validation, after auth
      expect(r.status).toBe(400);
      expect(state.verified).toEqual([A.token]);
      expect(state.created.filter((c) => c.authorization !== null).map((c) => c.authorization)).toEqual([`Bearer ${A.token}`]);
      expect(state.created.some((c) => c.authorization === `Bearer ${B.token}`)).toBe(false);
      expect(state.calls).toEqual([]);
    });
  }

  it("authorize end to end: A's Bearer with B's cookie signs A's own object key only, on A's client", async () => {
    state.headers.set("authorization", `Bearer ${A.token}`);
    const r = await webAuthorize(request(ROUTES[0], { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 2048 }));
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.data.objectPath).toBe(buildUploadObjectPath(A.id, UPLOAD_ID, "video/mp4"));
    expect(state.calls).toEqual([[`Bearer ${A.token}`, "storage", "createSignedUploadUrl", "swing-videos", buildUploadObjectPath(A.id, UPLOAD_ID, "video/mp4"), { upsert: false }]]);
    expect(state.verified).toEqual([A.token]);
  });
});

describe("P4 web endpoints — each reuses its existing handler with the handler's own runtime settings", () => {
  const pairs: [string, string, string, string][] = [
    ["app/api/web/uploads/authorize/route.ts", "app/api/v1/uploads/authorize/route.ts", "@/app/api/v1/uploads/authorize/route", "v1"],
    ["app/api/web/uploads/finalize/route.ts", "app/api/v1/uploads/finalize/route.ts", "@/app/api/v1/uploads/finalize/route", "v1"],
    ["app/api/web/analyses/route.ts", "app/api/v1/analyses/route.ts", "@/app/api/v1/analyses/route", "v1"],
    ["app/api/web/analyze-swing/route.ts", "app/api/analyze-swing/route.ts", "@/app/api/analyze-swing/route", "analyze-swing"],
  ];
  const settings = (src: string) => Object.fromEntries(Array.from(src.matchAll(/^export const (\w+)\s*=\s*([^;]+);/gm), (m) => [m[1], m[2].trim()]));

  it.each(pairs)("%s declares exactly the route segment settings of %s", (web, existing) => {
    expect(settings(readSource(web))).toEqual(settings(readSource(existing)));
  });

  it("the analysis route's 300 s limit is restated on its web endpoint", () => {
    expect(settings(readSource("app/api/web/analyze-swing/route.ts"))).toEqual({ maxDuration: "300" });
  });

  it.each(pairs)("%s imports the existing POST and hands it to the boundary, and does nothing else", (web, _existing, module, shape) => {
    const src = readSource(web).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(new RegExp(`import \\{ POST as (\\w+) \\} from "${module.replace(/[/@]/g, (c) => `\\${c}`)}";`));
    const handler = src.match(/import \{ POST as (\w+) \}/)?.[1];
    expect(src).toContain(`return requireBearerHeader(request, ${handler}, "${shape}");`);
    expect(src.match(/export async function POST\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/resolveRouteAuth|getServerSession|createClient|createAdminClient|cookies\(|\.json\(/);
  });

  it("the boundary reads the Authorization header through the same request context as the verifier and parses nothing itself", () => {
    const src = readSource("lib/api/protected-web-boundary.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).toContain('import { headers } from "next/headers";');
    expect(src).toContain('if (headerList.get("authorization") === null) return credentialRequired(shape, resolveRequestId(headerList));');
    expect(src).not.toMatch(/cookie|["'`]Bearer|\.split\(|\.trim\(|getUser|createClient/i); // no credential parsing of its own
  });
});

describe("P4 — the page sends its four application requests only through the sender; the build fixes the opt-in", () => {
  it("the Analyze page holds no direct fetch to an /api/ path any more, and sends each of the four exactly once through the sender", () => {
    const page = readSource("app/(dashboard)/analyze/page.tsx");
    expect(page).not.toMatch(/fetch\(\s*["'`]\/api\//);
    for (const name of NAMES) expect(page.split(`sendAppRequest("${name}", {`).length - 1).toBe(1);
    expect(page).toContain('import { sendAppRequest } from "@/lib/protected-web-requests";');
  });

  it("next.config.mjs inlines the opt-in at build time: exactly \"1\" when the build is given \"1\", otherwise \"0\" (a runtime-only setting changes nothing)", () => {
    const config = readSource("next.config.mjs");
    expect(config).toContain(
      "NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS:\n      process.env.NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS === \"1\" ? \"1\" : \"0\",",
    );
    // the reader uses the literal name the build inlines (a computed name would be read at runtime instead)
    expect(readSource("lib/protected-web-requests.ts")).toContain('return process.env.NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS === "1";');
  });

  it("the value the build inlines when the opt-in is absent (\"0\") is the default path", async () => {
    process.env[FLAG] = "0";
    const sent = recordFetch();
    await sendAppRequest("authorize", REQUEST);
    expect(sent[0].url).toBe(APP_REQUEST_PATHS.authorize);
    expect(sent[0].init.credentials).toBe("omit");
  });
});
