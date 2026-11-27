import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextRequest } from "next/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-03-R1-A4 (C1) — explicit request identity for the analysis execution endpoint and its two callers.
 *
 * Part 1 executes POST /api/analyze-swing with the REAL shared verifier (utils/supabase/server.ts resolveRouteAuth and its
 * cookie reader). Only the outer boundaries are stood in: the request headers (next/headers), Supabase Auth and PostgREST
 * behind the platform fetch (every request recorded with the credential it carried, as a synthetic label), the server-only
 * admin client (records any construction) and the single-attempt provider transport (a counter; no provider is ever
 * reached). It covers: Bearer A with no cookie; Bearer A beside B's cookie; malformed / invalid / expired Bearer beside a
 * valid B cookie — refused, never falling back; no Authorization header with a valid / absent / invalid / unbound cookie
 * (legacy cookie ingress unchanged); Auth unreachable — an honest 503 before the body is read and before any database,
 * claim or provider work; and that every owned read after verification carries the verified caller's own token.
 *
 * Part 2 drives the analysis report (app/(dashboard)/analyze/[id]/AnalysisReport.tsx) through its real component code:
 * React's hooks are replaced by a small synchronous runtime (as in lib/session-consumer-recovery.test.tsx, expanding the
 * whole tree in each pass), the shared browser client is a stand-in whose session reads and events the test controls, and
 * every request the report sends goes to a recording fetch. lib/drill-hub-session.ts confirmOwnerSession / ownerBearer and
 * the ended-lineage notice are the real modules. Synthetic identities only; nothing leaves the process.
 *
 * AG-WEB-READY-09-P1: the report no longer sends its request when it opens; it sends it on the golfer's explicit "Analyze
 * swing" press. openReport() therefore opens the report, checks that nothing was sent, and presses it once; every
 * identity, Bearer and late-answer assertion below is unchanged.
 */

const rt = vi.hoisted(() => ({
  // Part 1
  headers: new Headers(),
  adminConstructed: 0,
  providerCalls: 0,
  // Part 2 (hook runtime)
  slots: [] as unknown[],
  i: 0,
  pending: [] as number[],
  dirty: false,
  rendered: null as null | { ownerId: string; lineage: string | null },
  client: null as unknown,
}));

vi.mock("server-only", () => ({}));
// AG-WEB-READY-10-P2: the durable admission boundary answers as the stored default (`sync_mode`: no job, so the
// existing synchronous path runs, which is what this suite covers). Admission itself is tested against the real
// database (supabase/tests/app-integration/analysis-jobs.*.integration.test.ts).
const admission = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  answer: null as unknown,
}));
vi.mock("@/lib/analysis-job-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-job-admission")>();
  return {
    ...actual,
    admitAnalysisJob: async (request: Record<string, unknown>) => {
      admission.calls.push(request);
      return admission.answer ?? { outcome: "decided", disposition: "sync_mode", attempt: null };
    },
  };
});
vi.mock("next/headers", () => ({ headers: async () => rt.headers }));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    rt.adminConstructed += 1;
    throw new Error("the admin client is never needed on these paths");
  },
}));
vi.mock("@/lib/gemini-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini-transport")>();
  return {
    ...actual,
    generateContentOnce: async () => {
      rt.providerCalls += 1;
      throw new Error("no provider call is ever allowed here");
    },
  };
});
vi.mock("@/lib/biometrics", () => ({
  extractSwingMetrics: async () => ({
    spineAngle: null, hipRotation: null, shoulderRotation: null, tempoRatio: null, setup: { spineAngle: null }, impact: { spineAngle: null },
  }),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  type Slot = Record<string, unknown>;
  const same = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  function useState(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = rt.slots[i] as Slot;
    slot.set ??= (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(slot.value) : v;
      if (!Object.is(next, slot.value)) {
        slot.value = next;
        rt.dirty = true;
      }
    };
    return [slot.value, slot.set];
  }
  function useRef(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = { current: init };
    return rt.slots[i];
  }
  function memoSlot(fn: () => unknown, deps: unknown[]) {
    const i = rt.i++;
    const slot = rt.slots[i] as Slot | undefined;
    if (slot && same(slot.deps, deps)) return slot.value;
    const value = fn();
    rt.slots[i] = { deps, value };
    return value;
  }
  const useMemo = memoSlot;
  const useCallback = (fn: unknown, deps: unknown[]) => memoSlot(() => fn, deps);
  function useEffect(fn: () => unknown, deps?: unknown[]) {
    const i = rt.i++;
    const slot = rt.slots[i] as Slot | undefined;
    if (slot && deps !== undefined && same(slot.deps, deps)) return;
    rt.slots[i] = { deps, fn, cleanup: slot?.cleanup, effect: true };
    rt.pending.push(i);
  }
  // the only context the report reads is the dashboard layout's rendered session (SessionKeeper.tsx useRenderedSession)
  const useContext = () => rt.rendered;
  return { ...actual, default: actual, useState, useRef, useMemo, useCallback, useEffect, useContext };
});
vi.mock("lucide-react", () => {
  const none = () => null;
  return Object.fromEntries(
    ["CheckCircle2", "AlertTriangle", "Loader2", "Zap", "Target", "ChevronDown", "ChevronUp", "RotateCcw", "Play", "Pause",
      "TrendingUp", "AlertCircle", "Lightbulb", "Dumbbell"].map((name) => [name, none]),
  );
});
vi.mock("@/utils/supabase/client", () => ({ createClient: () => rt.client }));

import { POST } from "@/app/api/analyze-swing/route";
import AnalysisReport, { type AnalysisData } from "@/app/(dashboard)/analyze/[id]/AnalysisReport";
import { announceEndedLineage } from "@/utils/supabase/session-publication";
import { sessionLineageId } from "@/utils/supabase/session-cookie-layout";
import { VIDEO_UNUSABLE_STATUS } from "@/lib/swing-video-source";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const SUPABASE = "http://127.0.0.1:54329";
const KEY = "sb-127-auth-token";
const A = randomUUID();
const B = randomUUID();
const ANALYSIS_ID = randomUUID();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, sid = `sid-${randomUUID()}`) => `${b64({ alg: "none" })}.${b64({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-${randomUUID()}`;

// ─── The stand-in network (Auth + PostgREST), recording every request's credential as a label ─────────────────────────

interface Seen {
  readonly path: string;
  /** whose token the Authorization header carried: "A", "B", "anon" (the anon key), a token label, or null */
  readonly as: string | null;
}
let seen: Seen[] = [];
let authOutage = false;
/** A4 review: Auth answers the verification with this (status, body) instead of judging the token */
let authAnswer: null | { status: number; body: string } = null;
const labels = new Map<string, { label: string; user: string | null }>();
function token(label: string, user: string | null) {
  const t = user === null ? `not-a-valid-token-${label}` : jwt(user);
  labels.set(t, { label, user });
  return t;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function standInFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
  const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const known = labels.get(bearer);
  seen.push({ path: url.pathname, as: known ? known.label : bearer === "synthetic-anon-key-not-a-secret" ? "anon" : bearer ? "unknown" : null });
  if (url.pathname === "/auth/v1/user") {
    if (authOutage) return Promise.reject(new TypeError("fetch failed"));
    if (authAnswer) return Promise.resolve(new Response(authAnswer.body, { status: authAnswer.status, headers: { "content-type": "application/json" } }));
    if (!known || known.user === null) return Promise.resolve(json({ code: "bad_jwt", message: "invalid JWT" }, 403));
    if (known.label.startsWith("expired")) return Promise.resolve(json({ code: "bad_jwt", message: "token is expired" }, 403));
    return Promise.resolve(json({ id: known.user, aud: "authenticated", email: null }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const owner = known?.user ?? null;
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const table = url.pathname.slice("/rest/v1/".length);
    let rows: Record<string, unknown>[] = [];
    // the analysis is golfer A's: only a read carrying A's token and filtered to A finds it (as the owner RLS rule would)
    if (table === "swing_analysis" && owner === A && url.searchParams.get("user_id") === `eq.${A}` && url.searchParams.get("id") === `eq.${ANALYSIS_ID}`) {
      rows = [{ id: ANALYSIS_ID, user_id: A, status: "pending", analysis_family: "full_swing", swing_video: null }];
    }
    if (table === "users" && owner !== null && url.searchParams.get("id") === `eq.${owner}`) {
      rows = [{ subscription_tier: "par", subscription_status: "active" }];
    }
    if (wantsObject) return Promise.resolve(rows.length === 1 ? json(rows[0]) : json({ code: "PGRST116", message: "no rows" }, 406));
    return Promise.resolve(json(rows));
  }
  return Promise.resolve(json({}, 404));
}

/** A browser session cookie (legacy: no binding cookie) holding `access`. */
function sessionCookie(access: string, refresh = `rt-${randomUUID()}`) {
  return `${KEY}=${encodeURIComponent(JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: "envelope-user-is-never-read" } }))}`;
}
/** The request as the route sees it; `json()` counts whether the body was read. */
function routeRequest(body: unknown = { analysisId: ANALYSIS_ID }) {
  const read = vi.fn(async () => body);
  // P2: the same headers the ingress reads (the admission declaration is read from the request itself)
  return { req: { json: read, headers: rt.headers } as unknown as NextRequest, bodyRead: () => read.mock.calls.length };
}
async function call(headers: Record<string, string>) {
  rt.headers = new Headers(headers);
  const { req, bodyRead } = routeRequest();
  const response = await POST(req);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, bodyRead: bodyRead() };
}

describe("Part 1 — POST /api/analyze-swing ingress (A4 C1): Bearer or cookie, never a fallback; one verified identity throughout", () => {
  beforeEach(() => {
    seen = [];
    authOutage = false;
    authAnswer = null;
    labels.clear();
    rt.adminConstructed = 0;
    rt.providerCalls = 0;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key-not-a-secret");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    vi.stubGlobal("fetch", standInFetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("Bearer A with no cookie: verified as A; the owned row and the entitlement read carry A's token, and nothing else is used (no provider: the key is absent here)", async () => {
    const a = token("A", A);
    const r = await call({ authorization: `Bearer ${a}` });
    expect(r.status).toBe(503); // pending full-swing row, entitlement allowed, no provider key configured in this test
    expect(r.body.error).toBe("AI analysis is temporarily unavailable. Please try again later.");
    expect(seen).toEqual([
      { path: "/auth/v1/user", as: "A" },
      { path: "/rest/v1/swing_analysis", as: "A" },
      { path: "/rest/v1/users", as: "A" },
    ]);
    expect([r.bodyRead, rt.adminConstructed, rt.providerCalls]).toEqual([1, 0, 0]);
  });

  it("Bearer A while B's valid session cookie is present: A, and B's cookie is never read, verified or used", async () => {
    const a = token("A", A);
    const b = token("B", B);
    const r = await call({ authorization: `Bearer ${a}`, cookie: sessionCookie(b) });
    expect(r.status).toBe(503);
    expect(seen.map((s) => s.as)).toEqual(["A", "A", "A"]);
    expect(seen.some((s) => s.as === "B")).toBe(false);
  });

  for (const [label, header] of [
    ["malformed (no scheme)", (t: string) => t],
    ["malformed (two credentials)", (t: string) => `Bearer ${t}, Bearer ${t}`],
    ["empty", () => ""],
    ["a token Auth refuses as invalid", () => `Bearer ${token("invalid", null)}`],
    ["an expired token (Auth refuses it)", () => `Bearer ${token("expired-A", A)}`],
  ] as const) {
    it(`a ${label} Bearer beside B's VALID cookie: 401, no fallback to B; the body is never read and nothing else is requested`, async () => {
      const b = token("B", B);
      const r = await call({ authorization: header(token("A", A)), cookie: sessionCookie(b) });
      expect(r).toEqual({ status: 401, body: { error: "Unauthorized" }, bodyRead: 0 });
      expect(seen.every((s) => s.path === "/auth/v1/user")).toBe(true); // at most the one verification of what was presented
      expect(seen.some((s) => s.as === "B")).toBe(false);
      expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
    });
  }

  it("no Authorization header: the legacy cookie ingress is unchanged — a valid cookie authenticates its own account, and every owned read carries that same token", async () => {
    const a = token("A", A);
    const r = await call({ cookie: sessionCookie(a) });
    expect(r.status).toBe(503); // A's own pending row; no provider key here
    expect(seen).toEqual([
      { path: "/auth/v1/user", as: "A" },
      { path: "/rest/v1/swing_analysis", as: "A" },
      { path: "/rest/v1/users", as: "A" },
    ]);
  });

  for (const [label, headers] of [
    ["Bearer B while A's valid cookie is present", () => ({ authorization: `Bearer ${token("B", B)}`, cookie: sessionCookie(token("A", A)) })],
    ["B's cookie alone", () => ({ cookie: sessionCookie(token("B", B)) })],
  ] as const) {
    it(`A4 review: ${label}, asking for A's analysis — 404 as for a missing row: B's own token reads nothing of A's; no entitlement read, admin client, claim or provider`, async () => {
      const r = await call(headers());
      expect([r.status, r.body]).toEqual([404, { error: "Analysis record not found." }]);
      expect(seen).toEqual([
        { path: "/auth/v1/user", as: "B" },
        { path: "/rest/v1/swing_analysis", as: "B" },
      ]);
      expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
    });
  }

  for (const [label, cookie] of [
    ["no cookie at all", null],
    ["a cookie holding a token Auth refuses", () => sessionCookie(token("invalid", null))],
    ["a cookie written outside the browser's own writer (its binding names another session)", () => `${sessionCookie(token("B", B))}; swingproai-session-binding=${"0".repeat(64)}`],
    ["an ambiguous jar (bare key beside a chunk)", () => `${sessionCookie(token("B", B))}; ${KEY}.0=x`],
  ] as const) {
    it(`no Authorization header and ${label}: 401 before the body is read; no owned read`, async () => {
      const r = await call(cookie === null ? {} : { cookie: cookie() });
      expect(r).toEqual({ status: 401, body: { error: "Unauthorized" }, bodyRead: 0 });
      expect(seen.some((s) => s.path.startsWith("/rest/v1/"))).toBe(false);
    });
  }

  for (const [label, headers] of [
    ["Bearer mode", () => ({ authorization: `Bearer ${token("A", A)}` })],
    ["cookie mode", () => ({ cookie: sessionCookie(token("A", A)) })],
  ] as const) {
    it(`Auth unreachable (${label}): an honest 503 — never 401, never a sign-out — before the body, any database read, claim or provider work`, async () => {
      authOutage = true;
      const r = await call(headers());
      expect(r).toEqual({ status: 503, body: { error: "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly." }, bodyRead: 0 });
      expect(seen.map((s) => s.path)).toEqual(["/auth/v1/user"]);
      expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
    });
  }

  for (const [label, answer] of [
    ["Auth's own failure (500)", { status: 500, body: '{"code":"unexpected_failure","msg":"synthetic"}' }],
    ["a rate limit (429)", { status: 429, body: '{"code":"over_request_rate_limit","msg":"synthetic"}' }],
    ["an unreadable 200 (not JSON)", { status: 200, body: "<html>gateway</html>" }],
  ] as const) {
    it(`A4 review: Auth answering with ${label} is an outage — 503, never 401 — before the body or any other work (Bearer and cookie)`, async () => {
      authAnswer = answer;
      const modes: Record<string, string>[] = [{ authorization: `Bearer ${token("A", A)}` }, { cookie: sessionCookie(token("A", A)) }];
      for (const headers of modes) {
        seen = [];
        const r = await call(headers);
        expect(r).toEqual({ status: 503, body: { error: "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly." }, bodyRead: 0 });
        expect(seen.map((x) => x.path)).toEqual(["/auth/v1/user"]);
      }
      expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
    });
  }

  it("source: the route authenticates through resolveRouteAuth before reading the body, and every later owned step uses the verified caller's client and id (no second client from the cookie)", () => {
    const route = source("app/api/analyze-swing/route.ts");
    const post = route.slice(route.indexOf("export async function POST("));
    const auth = post.indexOf("const auth = await resolveRouteAuth();");
    const unavailable = post.indexOf('if (auth.status === "verification_unavailable") {');
    const refused = post.indexOf('if (auth.status !== "authenticated") {');
    const client = post.indexOf("const supabase = auth.client;");
    const user = post.indexOf("const user = { id: auth.userId } as const;");
    const body = post.indexOf("rawBody = await req.json();");
    const owned = post.indexOf('.eq("user_id", user.id)');
    expect([auth, unavailable, refused, client, user].every((i) => i > -1)).toBe(true);
    expect(auth).toBeLessThan(unavailable);
    expect(unavailable).toBeLessThan(refused);
    expect(refused).toBeLessThan(client);
    expect(user).toBeLessThan(body);
    expect(body).toBeLessThan(owned);
    expect(route).not.toMatch(/\bcreateClient\(/); // the cookie-scoped client is gone from this route
    expect(route).not.toContain("auth.getUser(");
    expect(route).toContain('import { resolveRouteAuth, type AuthenticatedCaller } from "@/utils/supabase/server";');
    expect(route).toContain('type RouteSupabaseClient = AuthenticatedCaller["client"];');
  });
});

// ─── Part 2 — the analysis report's execution request ─────────────────────────────────────────────────────────────────

interface HostNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: (HostNode | string)[];
}
function expand(node: unknown): (HostNode | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement;
  const props = (element.props ?? {}) as Record<string, unknown>;
  if (element.type === React.Fragment) return expand(props.children);
  if (typeof element.type === "function") return expand((element.type as (p: unknown) => unknown)(props));
  if (typeof element.type !== "string") return [];
  return [{ type: element.type, props, children: expand(props.children) }];
}
const textOf = (nodes: (HostNode | string)[]): string => nodes.map((n) => (typeof n === "string" ? n : textOf(n.children))).join("");
function findAll(nodes: (HostNode | string)[], match: (n: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (match(n)) out.push(n);
    out.push(...findAll(n.children, match));
  }
  return out;
}
/** Mounts a component: each pass expands the whole tree (so child components' hooks run in the same pass), then runs effects. */
function mount<P>(Component: (props: P) => unknown, props: P) {
  rt.slots = [];
  rt.pending = [];
  rt.dirty = false;
  let nodes: (HostNode | string)[] = [];
  const render = () => {
    for (let guard = 0; guard < 25; guard++) {
      rt.i = 0;
      rt.dirty = false;
      nodes = expand(Component(props));
      for (const i of rt.pending.splice(0)) {
        const slot = rt.slots[i] as { fn: () => unknown; cleanup?: unknown };
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = slot.fn();
      }
      if (!rt.dirty) return;
    }
    throw new Error("render did not settle");
  };
  render();
  return {
    render,
    unmount: () => {
      for (const slot of rt.slots as { effect?: boolean; cleanup?: unknown }[]) if (slot?.effect && typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    },
    text: () => textOf(nodes),
    button: (label: string) => findAll(nodes, (n) => n.type === "button" && textOf(n.children).includes(label))[0] ?? null,
  };
}
type Mounted = ReturnType<typeof mount>;
async function settle(page: Mounted, turns = 60) {
  for (let k = 0; k < turns; k++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (rt.dirty) page.render();
}

/** A session as the SDK hands it out; each call is a new sign-in (its own lineage) unless `sid` names one. */
function sessionOf(user: string, sid = `sid-${randomUUID()}`) {
  return { access_token: jwt(user, sid), refresh_token: `rt-${randomUUID()}`, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: user } };
}
type Session = ReturnType<typeof sessionOf>;
function refusedRead(): Error {
  const error = new Error("We couldn't confirm your sign-in on this device. Refresh the page, or sign in again.");
  error.name = "AuthRetryableFetchError";
  Object.defineProperty(error, "__swingproaiSessionUnverified", { value: "unrecorded", enumerable: false });
  return error;
}
type SessionAnswer = { data: { session: Session | null }; error: unknown };

/** The shared browser client: session reads answered from what "the browser holds now"; events only when emitted. */
function managed() {
  const subscribers = new Set<(event: string, session: unknown) => void>();
  const state = { answer: (() => ({ data: { session: null }, error: null })) as () => SessionAnswer | Error, reads: 0 };
  const client = {
    auth: {
      getSession: () => {
        state.reads += 1;
        const now = state.answer();
        return now instanceof Error ? Promise.reject(now) : Promise.resolve(now);
      },
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        subscribers.add(callback);
        return { data: { subscription: { unsubscribe: () => subscribers.delete(callback) } } };
      },
    },
  };
  return { client, state, emit: (event: string, session: unknown) => subscribers.forEach((cb) => cb(event, session)), subscribers: () => subscribers.size };
}
let browser: ReturnType<typeof managed>;
const holds = (s: Session | null | Error) => {
  browser.state.answer = () => (s instanceof Error ? s : { data: { session: s }, error: null });
};

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly credentials: string | null;
  readonly body: string | null;
}
let wire: Sent[] = [];
let respond: (request: Sent) => Promise<Response>;
const reportCalls = () => wire.filter((r) => r.url === "/api/analyze-swing");
const carrying = (s: Session) => wire.filter((r) => r.authorization === `Bearer ${s.access_token}`);

const COMPLETE = (feedback: string) => ({ message: "Analysis complete", data: { ...PENDING, status: "complete", score: 77, feedback, swing_highlights: [], mechanical_deficiencies: [], metrics: {} } });
const PENDING: AnalysisData = { id: ANALYSIS_ID, status: "pending", score: null, feedback: null, swing_highlights: null, mechanical_deficiencies: null, metrics: null, swing_video: null };
const COPY = {
  expired: "Your session has expired. Please sign in again.",
  unconfirmed: "We couldn't confirm which account is signed in on this device, so this analysis wasn't started. Try again, or sign in again.",
  unavailable: "We couldn't check your sign-in just now, so this analysis wasn't started. Try again in a moment.",
  changed: "This browser is now signed in to a different account, so this analysis wasn't started. Refresh the page to continue with the account that's signed in now.",
  afterChange: "This browser's sign-in changed while your swing was being analyzed, so the result isn't shown here. Refresh the page to continue with the account that's signed in now.",
  network: "We couldn't reach SwingProAI. Check your connection, then check this swing's status before trying again.", // 09-P1
};

async function renderedFor(owner: string | null, s?: Session) {
  rt.rendered = owner === null ? null : { ownerId: owner, lineage: s ? await sessionLineageId(s.access_token) : null };
}
/** 09-P1: one press of a labelled button, as the golfer's click (then the render it causes). */
function press(page: ReturnType<typeof mount>, label: string) {
  const button = page.button(label);
  expect(button, label).not.toBeNull();
  (button!.props.onClick as () => void)();
  page.render();
}
/** 09-P1: open the pending report (nothing is sent), then the golfer's one "Analyze swing" press. */
async function openReport() {
  const sentBefore = reportCalls().length;
  const page = mount(AnalysisReport as unknown as (p: unknown) => unknown, { analysis: PENDING, videoSignedUrl: null, clubDisplayName: "Synthetic 7i" });
  await settle(page);
  expect(reportCalls(), "opening the report sends nothing").toHaveLength(sentBefore);
  press(page, "Analyze swing");
  await settle(page);
  return page;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function heldBody(status: number) {
  let release!: (body: unknown) => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      release = (body) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      };
    },
  });
  return { response: new Response(stream, { status, headers: { "content-type": "application/json" } }), release };
}

/** WebCrypto SHA-256 (lineage digests) served from node:crypto in a microtask, so it finishes inside the settle window. */
function installMicrotaskDigest() {
  const platform = globalThis.crypto;
  const subtle = {
    digest: (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return Promise.resolve(Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer);
    },
  };
  vi.stubGlobal("crypto", Object.create(platform, { subtle: { value: subtle }, randomUUID: { value: () => platform.randomUUID() } }));
}

describe("Part 2 — the analysis report sends its execution request only as the account it was rendered for (A4 C1)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installMicrotaskDigest();
    browser = managed();
    rt.client = browser.client;
    rt.rendered = null;
    wire = [];
    respond = async () => json(COMPLETE("Synthetic A feedback"));
    vi.stubGlobal("BroadcastChannel", undefined); // the ended-lineage notice stays within this "tab"
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const request: Sent = {
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials ?? null,
        body: typeof init?.body === "string" ? init.body : null,
      };
      wire.push(request);
      return respond(request);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("healthy: opening sends nothing; the golfer's press sends ONE request with the rendered owner's confirmed Bearer, `credentials: \"omit\"` and the analysis id; the completed report is shown", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const page = await openReport();
    expect(reportCalls()).toEqual([{ url: "/api/analyze-swing", authorization: `Bearer ${a.access_token}`, credentials: "omit", body: JSON.stringify({ analysisId: ANALYSIS_ID }) }]);
    expect(page.text()).toContain("Synthetic A feedback");
    expect(page.text()).toContain("complete");
  });

  it("rendered for A while the browser already holds B: nothing is sent (never B's token), fixed copy; Retry confirms again and still sends nothing", async () => {
    await renderedFor(A, sessionOf(A));
    const b = sessionOf(B);
    holds(b);
    const page = await openReport();
    expect(wire).toEqual([]);
    expect(page.text()).toContain(COPY.changed);
    (page.button("Retry")!.props.onClick as () => void)();
    page.render();
    await settle(page);
    expect(wire).toEqual([]);
    expect(carrying(b)).toEqual([]);
  });

  for (const [label, held, copy] of [
    ["signed out", () => null, COPY.expired],
    ["a read the shared storage refuses as unverified", () => refusedRead(), COPY.unconfirmed],
    ["a read that fails outright", () => new TypeError("Failed to fetch synthetic-internal"), COPY.unavailable],
  ] as const) {
    it(`${label}: nothing is sent, fixed copy (no SDK text), and a deliberate Retry is offered`, async () => {
      await renderedFor(A);
      holds(held());
      const page = await openReport();
      expect(wire).toEqual([]);
      expect(page.text()).toContain(copy);
      expect(page.text()).not.toMatch(/synthetic-internal|AuthRetryableFetchError|TypeError/);
      expect(page.button("Retry")).not.toBeNull();
    });
  }

  it("outside the dashboard layout (no rendered owner): nothing is sent, whatever the browser holds (no first-seen adoption)", async () => {
    await renderedFor(null);
    holds(sessionOf(A));
    const page = await openReport();
    expect(wire).toEqual([]);
    expect(page.text()).toContain(COPY.unconfirmed);
  });

  it("forced: B is published immediately AFTER the report's confirmation and before the request is built (an obsolete writer; no event) — the request still carries only A's confirmed Bearer and no cookie", async () => {
    const a = sessionOf(A);
    const b = sessionOf(B);
    await renderedFor(A, a);
    browser.state.answer = () => {
      const now = { data: { session: a }, error: null };
      holds(b); // lands right after this read
      return now;
    };
    const page = await openReport();
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0]).toMatchObject({ authorization: `Bearer ${a.access_token}`, credentials: "omit" });
    expect(carrying(b)).toEqual([]);
    expect(page.text()).toContain("Synthetic A feedback");
  });

  it("an account-change event delivered while the report's confirmation read is still out (the read then answers A): nothing is sent, and the refusal copy says another account is signed in", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    const read = deferred<SessionAnswer>();
    (browser.client.auth as { getSession: () => Promise<SessionAnswer> }).getSession = () => read.promise;
    const page = mount(AnalysisReport as unknown as (p: unknown) => unknown, { analysis: PENDING, videoSignedUrl: null, clubDisplayName: null });
    await settle(page);
    press(page, "Analyze swing"); // 09-P1: the golfer's press starts the confirmation read
    await settle(page);
    browser.emit("SIGNED_IN", sessionOf(B));
    read.resolve({ data: { session: a }, error: null }); // a stale read of A
    await settle(page);
    expect(wire).toEqual([]);
    expect(page.text()).toContain(COPY.changed);
    expect(page.text()).not.toContain(COPY.afterChange); // nothing was being analyzed
  });

  it("a newer sign-in of the SAME account: the request carries that newer token of the rendered owner (never another account's)", async () => {
    const a1 = sessionOf(A);
    const a2 = sessionOf(A); // a newer sign-in of A (another lineage)
    await renderedFor(A, a1);
    holds(a2);
    await openReport();
    expect(reportCalls().map((r) => r.authorization)).toEqual([`Bearer ${a2.access_token}`]);
  });

  it("an account change (B's event) while the request runs: its answer is NOT shown (no completion), the sign-in-changed notice is", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const page = await openReport();
    expect(reportCalls()).toHaveLength(1);
    browser.emit("SIGNED_IN", sessionOf(B));
    gate.resolve(json(COMPLETE("Synthetic A feedback")));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic A feedback");
    expect(page.text()).toContain(COPY.afterChange);
    expect(page.button("Refresh page")).not.toBeNull();
  });

  it("End Session of the RENDERED sign-in (another tab's notice) while the request runs: the answer is not shown", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const page = await openReport();
    announceEndedLineage((await sessionLineageId(a.access_token))!);
    gate.resolve(json(COMPLETE("Synthetic A feedback")));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic A feedback");
    expect(page.text()).toContain(COPY.afterChange);
  });

  it("a held body: headers arrive for A, B signs in, then the body completes — checked after the whole answer was read, nothing of it is shown", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const held = heldBody(200);
    respond = async () => held.response;
    const page = await openReport();
    browser.emit("SIGNED_IN", sessionOf(B));
    held.release(COMPLETE("Synthetic A feedback"));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic A feedback");
    expect(page.text()).toContain(COPY.afterChange);
  });

  it("left before the answer (unmount, also with a held body): nothing changes afterwards", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const held = heldBody(200);
    respond = async () => held.response;
    // the completion branch's first act is to drop the stored client metrics: observed through a sessionStorage stand-in
    const removed: string[] = [];
    vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: (key: string) => { removed.push(key); } });
    const page = await openReport();
    expect(reportCalls()).toHaveLength(1); // the call really went out before the report was left (QA review)
    page.unmount();
    held.release(COMPLETE("Synthetic A feedback"));
    await settle(page);
    expect(removed).toEqual([]); // the late completion never ran its branch
    // the state as it was left (render again: the mount effect does not run again, so the report stays "left"): the late
    // completion set nothing — no result, no notice, no failure
    page.render();
    expect(page.text()).not.toContain("Synthetic A feedback");
    expect(page.text()).not.toContain(COPY.afterChange);
    expect(page.text()).toContain("Starting Your Analysis"); // 09-P1-A1: the phase-neutral waiting heading
  });

  it("control: the same held completion with the report still shown runs its branch (drops the stored metrics) and shows the result", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const held = heldBody(200);
    respond = async () => held.response;
    const removed: string[] = [];
    vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: (key: string) => { removed.push(key); } });
    const page = await openReport();
    held.release(COMPLETE("Synthetic A feedback"));
    await settle(page);
    expect(removed).toEqual([`mediapipe_${ANALYSIS_ID}`]);
    expect(page.text()).toContain("Synthetic A feedback");
  });

  it("the layout rendered again for ANOTHER account while the report stays mounted ends its view: the running request's answer is not shown", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const page = await openReport();
    expect(reportCalls()).toHaveLength(1);
    await renderedFor(B, sessionOf(B)); // a refresh rendered the dashboard layout for B
    page.render();
    gate.resolve(json(COMPLETE("Synthetic A feedback")));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic A feedback");
    expect(page.text()).toContain(COPY.afterChange);
  });

  it("the route's honest auth-unavailable 503 reaches the golfer as its fixed copy, with a status read (09-P1: every 503 offers a fresh read before a new attempt)", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    respond = async () => json({ error: "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly." }, 503);
    const page = await openReport();
    expect(page.text()).toContain("We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly.");
    expect(page.button("Check status")).not.toBeNull();
    expect(page.button("Retry")).toBeNull();
  });

  it("a sign-in whose End Session the server already confirmed (its removal still pending here): nothing is sent; the copy says it was ended (not 'expired')", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    vi.stubGlobal("document", { cookie: `swingproai-session-ended=${await sessionLineageId(a.access_token)}` });
    const page = await openReport();
    expect(wire).toEqual([]);
    expect(page.text()).toContain("This sign-in was ended, so this analysis wasn't started. Sign in again to continue.");
  });

  it("left while the confirmation is still pending: nothing is ever sent", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    const read = deferred<SessionAnswer>();
    browser.state.answer = () => {
      throw new Error("not used");
    };
    (browser.client.auth as { getSession: () => Promise<SessionAnswer> }).getSession = () => read.promise;
    const page = await openReport();
    page.unmount();
    read.resolve({ data: { session: a }, error: null });
    await settle(page);
    expect(wire).toEqual([]);
  });

  it("control: report behaviour — 409 processing shows 'Still Analysing'; 409 stalled offers no Retry; an unusable video asks for a new upload; a network failure is fixed copy with a status read (09-P1: no resend); after a 401 Retry confirms again before resending", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    holds(a);
    respond = async () => json({ error: "This analysis is already in progress. Please check back shortly.", status: "processing" }, 409);
    let page = await openReport();
    expect(page.text()).toContain("Still Analysing");
    respond = async () => json({ error: "Interrupted.", status: "stalled" }, 409);
    page = await openReport();
    expect(page.text()).toContain("Analysis Interrupted");
    expect(page.button("Retry")).toBeNull();
    respond = async () => json({ error: "We couldn't read this video.", status: VIDEO_UNUSABLE_STATUS }, 422);
    page = await openReport();
    expect(page.text()).toContain("Upload a new video");
    wire = [];
    respond = async () => {
      throw new TypeError("Failed to fetch");
    };
    page = await openReport();
    expect(page.text()).toContain(COPY.network);
    expect(page.button("Retry")).toBeNull(); // 09-P1: the request may have arrived: a status read comes first
    expect(page.button("Check status")).not.toBeNull();
    // a certain outcome where nothing was analyzed (401) keeps its Retry, which confirms again before resending
    wire = [];
    respond = async () => json({ error: "Unauthorized" }, 401);
    page = await openReport();
    const before = browser.state.reads;
    respond = async () => json(COMPLETE("Synthetic A feedback"));
    press(page, "Retry");
    await settle(page);
    expect(browser.state.reads).toBeGreaterThan(before); // re-confirmed for the retry
    expect(reportCalls().map((r) => r.authorization)).toEqual([`Bearer ${a.access_token}`, `Bearer ${a.access_token}`]);
    expect(page.text()).toContain("Synthetic A feedback");
  });

  it("server render (no effects): a pending report renders its saved status and the explicit analysis action without touching the browser client (09-P1: no 'Analysing' claim before a request)", () => {
    rt.rendered = null;
    rt.slots = [];
    rt.pending = [];
    rt.i = 0;
    const markup = renderToStaticMarkup(React.createElement(AnalysisReport as unknown as React.ComponentType<Record<string, unknown>>, { analysis: PENDING, videoSignedUrl: null, clubDisplayName: null }));
    expect(markup).toContain("Not analyzed yet");
    expect(markup).toContain("Analyze swing");
    expect(markup).not.toContain("Analysing Your Swing");
    expect(markup).not.toContain("Starting Your Analysis"); // 09-P1-A1: nothing waits before a press
    expect(wire).toEqual([]);
  });
});

describe("P2 — the route's admission boundary", () => {
  beforeEach(() => {
    seen = [];
    authOutage = false;
    authAnswer = null;
    labels.clear();
    rt.adminConstructed = 0;
    rt.providerCalls = 0;
    admission.calls = [];
    admission.answer = null;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key-not-a-secret");
    vi.stubEnv("GEMINI_API_KEY", "synthetic-key-never-used");
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    vi.stubGlobal("fetch", standInFetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("`declared` is Bearer AND the declaration header: Bearer with it, Bearer without it, and the header with a cookie session", async () => {
    const a = token("A", A);
    await call({ authorization: `Bearer ${a}`, "x-swingproai-admission": "1" });
    await call({ authorization: `Bearer ${a}` });
    await call({ cookie: sessionCookie(a), "x-swingproai-admission": "1" });
    expect(admission.calls.map((c) => [c.userId, c.declared])).toEqual([[A, true], [A, false], [A, false]]);
  });

  it("an admission that cannot be decided answers 503 before any claim or provider call", async () => {
    admission.answer = { outcome: "unavailable" };
    const r = await call({ authorization: `Bearer ${token("A", A)}`, "x-swingproai-admission": "1" });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "Analysis is temporarily unavailable. Please try again shortly." });
    expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
  });

  it("a cookie session with the header is not declared, so the database's client_update_required answers 409 and nothing runs", async () => {
    admission.answer = { outcome: "decided", disposition: "client_update_required", attempt: null };
    const r = await call({ cookie: sessionCookie(token("A", A)), "x-swingproai-admission": "1" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ status: "client_update_required" });
    expect(admission.calls[0]).toMatchObject({ declared: false });
    expect([rt.adminConstructed, rt.providerCalls]).toEqual([0, 0]);
  });
});
