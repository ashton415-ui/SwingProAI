import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LineageRecord, LineageStore } from "@/utils/supabase/session-lease";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  createDrillHubLoader,
  readDrillHub,
  type DrillHubReads,
  type DrillHubState,
  type ListReadResponse,
} from "@/lib/golfer-journey-read-state";
import {
  acquireDrillHubSession,
  sessionBoundDrillHubReads,
  createDrillHubSessionLoader,
  clientForDrillHubSession,
  readDrillVerifyResult,
  isUploadTooLarge,
  drillHubIdentityEnd,
  drillHubIdentityEndFromEvent,
  drillHubSessionUserId,
  drillUploadRefusal,
  drillVerifyRefusal,
  DRILL_HUB_SESSION_DEADLINE_MS,
  DRILL_VERIFY_COPY,
  DRILL_HUB_IDENTITY_COPY,
  type DrillHubSession,
  type DrillHubSessionResult,
  type DrillHubSessionSource,
  type DrillHubSessionState,
  type DrillVerifyMessage,
} from "@/lib/drill-hub-session";

// AG-WEB-READY-01 — the Drill Hub's session from the shared browser client (utils/supabase/client.ts), driven through
// the real installed @supabase/ssr 0.3.0 and supabase-js/auth-js 2.107.0.
//
// Fixtures are made by the installed SDK itself: a synthetic golfer signs in through the browser's sign-in publication
// (utils/supabase/session-publication.ts: AG-WEB-READY-03-R1; the shared client never calls signInWithPassword or
// signOut itself) against an in-memory Auth stand-in, and the session storage writes the session cookie, whole or as
// numbered chunks (once the encoded value passes 3180 characters, here reached with synthetic user metadata). No cookie
// format is written by hand, except one deliberately malformed value, labelled as such. End Session runs in the
// browser too; its section is held until the page unloads, which a test simulates by ending that section.
//
// Test-only surface: window/document are stubbed per test with a small cookie store; the global fetch is the
// in-memory stand-in (Auth plus the two Drill Hub tables); "@supabase/ssr" is wrapped only so each test gets a fresh
// copy of the real installed module (its browser client is a module-level singleton). Tokens are random per run and
// never leave memory; observations name callers ("A", "B", "anon"), never token values.

const requireFromHere = createRequire(import.meta.url);
type SsrModule = {
  createBrowserClient: (url: string, key: string, options?: Record<string, unknown>) => unknown;
  createChunks: (key: string, value: string) => { name: string; value: string }[];
};
const cap = vi.hoisted(() => ({ real: null as unknown as Record<string, (...a: unknown[]) => unknown>, clients: [] as unknown[] }));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...a: unknown[]) => {
    const client = cap.real.createBrowserClient(...a);
    cap.clients.push(client);
    return client;
  },
  createServerClient: (...a: unknown[]) => cap.real.createServerClient(...a),
  isBrowser: () => cap.real.isBrowser(),
  parse: (...a: unknown[]) => cap.real.parse(...a),
  serialize: (...a: unknown[]) => cap.real.serialize(...a),
  createChunks: (...a: unknown[]) => cap.real.createChunks(...a),
  // the installed constant (the session storage passes it to non-session keys)
  DEFAULT_COOKIE_OPTIONS: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 * 1000 },
}));

function freshSsr() {
  const p = requireFromHere.resolve("@supabase/ssr");
  delete requireFromHere.cache[p];
  return requireFromHere(p) as Record<string, (...a: unknown[]) => unknown>;
}

// ── synthetic constants ──────────────────────────────────────────────────────────────────────────────────────────
const SUPABASE = "http://127.0.0.1:54329"; // never contacted: fetch is the in-memory stand-in
const PAGE = "http://127.0.0.1:3941/drills";
const ANON = "synthetic-anon-key-not-a-secret";
const KEY = "sb-127-auth-token";
const GOLFERS = {
  A: { id: "00000000-0000-4000-8000-0000000000aa", email: "golfer-a@example.invalid" },
  B: { id: "00000000-0000-4000-8000-0000000000bb", email: "golfer-b@example.invalid" },
} as const;
type Who = keyof typeof GOLFERS;
const PASSWORD = "synthetic-password-not-a-secret";
interface Drill { id: string; name: string; target_metric: string; the_why: string; the_how: string; the_feel: string }
interface UserDrill { drill_id: string; status: "pending" | "submitted" | "verified" | "needs_work"; latest_ai_feedback: string | null }
const DRILLS: Drill[] = [
  { id: "d-1", name: "Gate Drill", target_metric: "club_path", the_why: "w", the_how: "h", the_feel: "f" },
  { id: "d-2", name: "Pump Drill", target_metric: "lag", the_why: "w", the_how: "h", the_feel: "f" },
];
const PROGRESS: Record<Who, UserDrill[]> = {
  A: [{ drill_id: "d-1", status: "verified", latest_ai_feedback: "A: path stayed square." }],
  B: [{ drill_id: "d-2", status: "needs_work", latest_ai_feedback: "B: wrist angle released early." }],
};
const ISSUED: string[] = []; // every synthetic token of this run, so observations can be checked for leaks

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

// ── a small browser cookie store (one path, http page) ──────────────────────────────────────────────────────────
class Jar {
  private readonly store = new Map<string, string>();
  readonly writes: { name: string; removal: boolean }[] = [];
  write(raw: string) {
    const [pair, ...attrs] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const lower = attrs.map((a) => a.trim().toLowerCase());
    if (lower.includes("secure") || lower.includes("httponly")) return; // never accepted from script on an http page
    const maxAge = lower.find((a) => a.startsWith("max-age="));
    const removal = maxAge !== undefined && Number(maxAge.slice("max-age=".length)) <= 0;
    this.writes.push({ name, removal });
    if (removal) this.store.delete(name);
    else this.store.set(name, value);
  }
  /** a value already in the browser (planted; not a write under test) */
  plant(name: string, rawValue: string) {
    this.store.set(name, rawValue);
  }
  clear(name: string) {
    this.store.delete(name);
  }
  header() {
    return Array.from(this.store, ([n, v]) => `${n}=${v}`).join("; ");
  }
  names() {
    return Array.from(this.store.keys());
  }
  family() {
    return this.names().filter((n) => n === KEY || (n.startsWith(`${KEY}.`) && /^\d+$/.test(n.slice(KEY.length + 1))));
  }
  raw(name: string) {
    return this.store.get(name);
  }
}

/** visible=false models a background tab: the SDK's own auto-refresh ticker does not run there. */
function installBrowser(visible = true): Jar {
  const url = new URL(PAGE);
  const jar = new Jar();
  const doc = {
    get cookie() { return jar.header(); },
    set cookie(v: string) { jar.write(String(v)); },
    visibilityState: visible ? "visible" : "hidden",
    addEventListener() {},
    removeEventListener() {},
  };
  const loc = { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname,
    port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, assign() {}, replace() {}, reload() {} };
  vi.stubGlobal("window", { document: doc, location: loc, addEventListener() {}, removeEventListener() {}, history: { state: null, replaceState() {} } });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", loc);
  vi.stubGlobal("BroadcastChannel", undefined);
  return jar;
}

// ── the in-memory stand-in: Auth (password, refresh, logout, user) and the two Drill Hub tables ─────────────────
type Live = { who: Who; access: string; refresh: string };
function standIn() {
  const st = {
    live: [] as Live[],
    refreshMode: "grant" as "grant" | "reject400" | "fail500",
    expiresIn: 3600,
    /** the lifetime of sessions a refresh grant issues */
    refreshExpiresIn: 3600,
    meta: {} as Record<string, unknown>,
    /** token: the index of the bearer in `live` (which issued token), never its value; -1 for none/anon */
    calls: [] as { kind: string; caller: string; token: number; status: number; apikeyOk?: boolean }[],
  };
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function issue(who: Who, expiresIn = st.expiresIn) {
    const now = Math.floor(Date.now() / 1000);
    const g = GOLFERS[who];
    const access = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: g.id, exp: now + expiresIn, aud: "authenticated", role: "authenticated", session_id: randomUUID() })}.${randomUUID().replace(/-/g, "")}`;
    const refresh = `rt${randomUUID().replace(/-/g, "")}`;
    ISSUED.push(access, refresh);
    st.live.push({ who, access, refresh });
    return { access_token: access, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: refresh,
      user: { id: g.id, aud: "authenticated", role: "authenticated", email: g.email, app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: st.meta, created_at: "2026-01-01T00:00:00Z" } };
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
  const callerOf = (bearer: string): string => {
    if (bearer === ANON) return "anon";
    const l = st.live.find((x) => x.access === bearer);
    return l ? l.who : bearer ? "unknown" : "none";
  };
  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== new URL(SUPABASE).origin) throw new TypeError("stand-in: outside the synthetic origin");
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const call = { kind: "other", caller: callerOf(bearer), token: st.live.findIndex((x) => x.access === bearer), status: 0, apikeyOk: req.headers.get("apikey") === ANON };
    st.calls.push(call);
    const answer = (kind: string, r: Response) => { call.kind = kind; call.status = r.status; return r; };
    const body = req.method === "POST" ? await req.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) : {};
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      const who = (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].email === body.email);
      if (who && body.password === PASSWORD) return answer("password", json(200, issue(who)));
      return answer("password", json(400, { code: "invalid_credentials", msg: "Invalid login credentials" }));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (st.refreshMode === "fail500") return answer("refresh", json(500, { code: "unexpected_failure", msg: "synthetic outage" }));
      const l = st.live.find((x) => x.refresh === body.refresh_token);
      if (st.refreshMode === "reject400" || !l) return answer("refresh", json(400, { code: "refresh_token_not_found", msg: "Invalid Refresh Token" }));
      return answer("refresh", json(200, issue(l.who, st.refreshExpiresIn)));
    }
    if (url.pathname === "/auth/v1/logout") return answer("logout", new Response(null, { status: 204 }));
    if (url.pathname === "/auth/v1/user") {
      const l = st.live.find((x) => x.access === bearer);
      // the whole user, as Auth returns it (setSession stores this user with the published session)
      return answer("user", l ? json(200, { id: GOLFERS[l.who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[l.who].email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: st.meta, created_at: "2026-01-01T00:00:00Z" }) : json(401, { code: "bad_jwt", msg: "invalid JWT" }));
    }
    // the row-policy model: the catalog for any signed-in caller; progress only the caller's own rows; anon gets none
    if (url.pathname === "/rest/v1/drills") {
      const c = callerOf(bearer);
      return answer("drills", json(200, c === "A" || c === "B" ? DRILLS : []));
    }
    if (url.pathname === "/rest/v1/user_drills") {
      const c = callerOf(bearer);
      return answer("user_drills", json(200, c === "A" || c === "B" ? PROGRESS[c] : []));
    }
    return answer("unexpected", json(404, { msg: "not found" }));
  }
  return { st, fetch: fetchFn, latest: (who: Who) => [...st.live].reverse().find((x) => x.who === who) };
}

type SharedClient = DrillHubSessionSource & {
  auth: {
    initialize(): Promise<unknown>;
    signInWithPassword(c: { email: string; password: string }): Promise<{ error: unknown }>;
    signOut(): Promise<{ error: unknown }>;
    dispose?: () => Promise<void> | void;
    stopAutoRefresh?: () => Promise<void>;
  };
  from(table: string): { select(cols: string): PromiseLike<ListReadResponse<unknown>> };
};

/** The browser's IndexedDB lineage record, in memory (A1: part of every supported browser; without it reads fail closed). */
function memoryLineage(): LineageStore {
  let record: LineageRecord | null = null;
  return {
    async read() {
      return record;
    },
    async append(digest: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("abandoned");
      const h = record?.history ?? [];
      if (h[h.length - 1] !== digest) record = { epoch: "e1", seq: (record?.seq ?? 0) + 1, history: [...h, digest].slice(-8) };
      return record!;
    },
  };
}

async function boot({ visible = true } = {}) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  const jar = installBrowser(visible);
  const sb = standIn();
  vi.stubGlobal("fetch", sb.fetch);
  const lease = await import("@/utils/supabase/session-lease");
  lease.configureLineage({ jarView: () => ({ kind: "absent" }), store: memoryLineage() });
  const mod = await import("@/utils/supabase/client");
  const publication = await import("@/utils/supabase/session-publication");
  const shared = () => mod.createClient() as unknown as SharedClient;
  return { jar, sb, shared, publication, lease };
}

async function signIn(b: Awaited<ReturnType<typeof boot>>, who: Who) {
  // as on the login page: the shared client exists (and has finished its own start-up) before the golfer signs in
  await b.shared().auth.initialize();
  await settle();
  expect(await b.publication.signInAndPublish(GOLFERS[who].email, PASSWORD)).toBe("signed_in");
  await settle();
}

/** End Session in the browser for `who`, then the page unload that releases its section (the form post navigates). */
async function endSession(b: Awaited<ReturnType<typeof boot>>, who: Who) {
  expect(await b.publication.endSessionInBrowser(GOLFERS[who].id)).toBe("ended");
  const held = b.lease.activeSection();
  if (held !== null) b.lease.leaveSection(held);
  await settle();
}

/** The page's read client: app/(dashboard)/drills/page.tsx clientForSession calls exactly this with the public env values. */
function clientForSession(session: DrillHubSession) {
  return clientForDrillHubSession(session, SUPABASE, ANON);
}

/** The page's load, wired as the page wires it (session-bound reads with the unchanged queries, and whose drills a
 *  result is: `shown` is the golfer the page already shows, null before its first load). */
function pageLoader(b: Awaited<ReturnType<typeof boot>>, publish: (s: DrillHubSessionState<Drill, UserDrill>) => void, shown: () => string | null = () => null) {
  return createDrillHubSessionLoader<Drill, UserDrill>(
    () => acquireDrillHubSession(() => b.shared()),
    (session, readSignal) => {
      const supabase = clientForSession(session);
      return {
        catalog: () => supabase.from("drills").select("id, name, target_metric, the_why, the_how, the_feel").eq("drill_family", "full_swing").order("name").abortSignal(readSignal),
        progress: () => supabase.from("user_drills").select("drill_id, status, latest_ai_feedback").abortSignal(readSignal),
      };
    },
    shown,
    publish,
  );
}

async function loadOnce(b: Awaited<ReturnType<typeof boot>>, shown: () => string | null = () => null) {
  const states: DrillHubSessionState<Drill, UserDrill>[] = [];
  const loader = pageLoader(b, (s) => states.push(s), shown);
  expect(loader.load()).toBe(true);
  await vi.waitFor(() => expect(states.length).toBe(2), { timeout: 5000, interval: 10 });
  loader.dispose();
  return states;
}

/** The helper this assignment replaced (app/(dashboard)/drills/page.tsx at the base), kept verbatim as the control. */
function legacyReader(cookieHeader: string): { access_token: string; user_id: string } | null {
  try {
    const name = `sb-${new URL(SUPABASE).hostname.split(".")[0]}-auth-token`;
    const match = cookieHeader.split("; ").find((c) => c.startsWith(`${name}=`));
    if (!match) return null;
    const parsed = JSON.parse(decodeURIComponent(match.split("=").slice(1).join("=")));
    return { access_token: parsed.access_token, user_id: parsed.user?.id };
  } catch { return null; }
}

const restCalls = (b: Awaited<ReturnType<typeof boot>>) => b.sb.st.calls.filter((c) => c.kind === "drills" || c.kind === "user_drills");
function noTokenIn(value: unknown) {
  const text = JSON.stringify(value);
  expect(ISSUED.some((t) => text.includes(t)), "an observation must carry no token value").toBe(false);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); // a fresh shared-client module (it keeps its one client) and session lease per test
  cap.real = freshSsr();
  cap.clients = [];
  warn = vi.spyOn(console, "warn");
});
afterEach(async () => {
  await settle(2);
  for (const c of (cap.clients as SharedClient[]).filter((x, i, all) => all.indexOf(x) === i)) {
    try {
      if (typeof c.auth.dispose === "function") await c.auth.dispose();
      else await c.auth.stopAutoRefresh?.();
    } catch {
      // teardown only
    }
  }
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── 1. classification (structural sources) ──────────────────────────────────────────────────────────────────────
const source = (answer: () => unknown): (() => DrillHubSessionSource) => () => ({ auth: { getSession: () => answer() as never } });
describe("acquireDrillHubSession — what the shared client's answer means", () => {
  it("a session with an access token and a user id is ready, carrying only those two values", async () => {
    const r = await acquireDrillHubSession(source(() => Promise.resolve({ data: { session: { access_token: "t-1", refresh_token: "r", user: { id: "u-1", email: "x@example.invalid" } } }, error: null })));
    expect(r).toEqual({ status: "ready", session: { accessToken: "t-1", userId: "u-1" } });
  });

  it("an explicit no-session answer without an error is signed out", async () => {
    expect(await acquireDrillHubSession(source(() => Promise.resolve({ data: { session: null }, error: null })))).toEqual({ status: "signed_out" });
  });

  it("errors, throws and unusable shapes are unavailable — never signed out, never a session — and keep no error text", async () => {
    const cases: (() => DrillHubSessionSource)[] = [
      source(() => Promise.resolve({ data: { session: null }, error: { message: "Invalid Refresh Token (synthetic 7f3c)", status: 400 } })),
      source(() => Promise.resolve({ data: { session: { access_token: "t", user: { id: "u" } } }, error: { message: "x" } })),
      source(() => Promise.reject(new Error("TypeError: Failed to fetch 7f3c"))),
      source(() => { throw new Error("sync 7f3c"); }),
      () => { throw new Error("Your project's URL and Key are required (7f3c)"); },
      source(() => Promise.resolve(null)),
      source(() => Promise.resolve({ data: null, error: null })),
      source(() => Promise.resolve({ data: {}, error: null })),
      source(() => Promise.resolve({ data: { session: "a string" }, error: null })),
      source(() => Promise.resolve({ data: { session: { user: { id: "u" } } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: "", user: { id: "u" } } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: 42, user: { id: "u" } } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: "t" } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: "t", user: null } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: "t", user: { id: "" } } }, error: null })),
      source(() => Promise.resolve({ data: { session: { access_token: "t", get user() { throw new Error("user proxy 7f3c"); } } }, error: null })),
    ];
    for (const s of cases) {
      const r = await acquireDrillHubSession(s);
      expect(r).toEqual({ status: "unavailable" });
      expect(JSON.stringify(r)).not.toMatch(/7f3c|Refresh|fetch|URL/);
    }
  });
});

describe("acquireDrillHubSession — a bounded wait, and one outstanding session read per client", () => {
  function held() {
    let resolve!: (v: { data: { session: unknown }; error: unknown }) => void;
    const promise = new Promise<{ data: { session: unknown }; error: unknown }>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("the default deadline is 10 seconds", () => {
    expect(DRILL_HUB_SESSION_DEADLINE_MS).toBe(10_000);
  });

  it("a session read that outlives the deadline is unavailable; the read keeps running and the next acquisition joins it", async () => {
    const h = held();
    const getSession = vi.fn(() => h.promise);
    const client: DrillHubSessionSource = { auth: { getSession } };
    expect(await acquireDrillHubSession(() => client, 20)).toEqual({ status: "unavailable" });
    const second = acquireDrillHubSession(() => client, 5000); // e.g. Try again while the SDK is still retrying
    const third = acquireDrillHubSession(() => client, 5000);
    expect(getSession).toHaveBeenCalledTimes(1); // joined, not queued
    h.resolve({ data: { session: { access_token: "t-late", user: { id: "u-1" } } }, error: null });
    expect(await second).toEqual({ status: "ready", session: { accessToken: "t-late", userId: "u-1" } });
    expect(await third).toEqual({ status: "ready", session: { accessToken: "t-late", userId: "u-1" } });
    // once settled, a later acquisition reads the session again (never a cached answer)
    getSession.mockImplementation(() => Promise.resolve({ data: { session: null }, error: null }));
    expect(await acquireDrillHubSession(() => client)).toEqual({ status: "signed_out" });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("a read that fails after its deadline leaves nothing outstanding", async () => {
    const h = held();
    const getSession = vi.fn(() => h.promise);
    const client: DrillHubSessionSource = { auth: { getSession } };
    expect(await acquireDrillHubSession(() => client, 20)).toEqual({ status: "unavailable" });
    h.resolve({ data: { session: null }, error: { message: "AuthRetryableFetchError (synthetic)" } });
    await settle(1);
    getSession.mockImplementation(() => Promise.resolve({ data: { session: { access_token: "t-2", user: { id: "u-2" } } }, error: null }));
    expect(await acquireDrillHubSession(() => client)).toEqual({ status: "ready", session: { accessToken: "t-2", userId: "u-2" } });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("separate clients never share a read", async () => {
    const a = held();
    const clientA: DrillHubSessionSource = { auth: { getSession: () => a.promise } };
    const clientB: DrillHubSessionSource = { auth: { getSession: () => Promise.resolve({ data: { session: null }, error: null }) } };
    const pendingA = acquireDrillHubSession(() => clientA, 5000);
    expect(await acquireDrillHubSession(() => clientB)).toEqual({ status: "signed_out" });
    a.resolve({ data: { session: { access_token: "t-a", user: { id: "u-a" } } }, error: null });
    expect(await pendingA).toEqual({ status: "ready", session: { accessToken: "t-a", userId: "u-a" } });
  });
});

// ── 2. the shared browser client with the installed SDK (real fixtures) ─────────────────────────────────────────
describe("the shared browser client and the installed SDK's own session cookies", () => {
  it("a whole session cookie: the hub gets the golfer's session and correct progress (the replaced reader also saw this one)", async () => {
    const b = await boot();
    await signIn(b, "A");
    expect(b.jar.family()).toEqual([KEY]); // the SDK wrote one whole cookie
    const r = await acquireDrillHubSession(() => b.shared());
    expect(r.status).toBe("ready");
    expect(r.status === "ready" && r.session.accessToken === b.sb.latest("A")?.access && r.session.userId === GOLFERS.A.id).toBe(true);
    expect(legacyReader(b.jar.header())?.user_id).toBe(GOLFERS.A.id); // control: the base reader handled a whole cookie
    const states = await loadOnce(b);
    expect(states).toEqual([{ phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS.A, userId: GOLFERS.A.id }]);
    expect(restCalls(b).map((c) => c.caller)).toEqual(["A", "A"]);
    expect(restCalls(b).every((c) => c.apikeyOk)).toBe(true);
    noTokenIn({ states, calls: b.sb.st.calls, r: r.status });
  });

  it("a chunked session cookie (the SDK's own numbered chunks): the hub gets the golfer's session; the replaced reader found nothing", async () => {
    const b = await boot();
    b.sb.st.meta = { pad: "synthetic-metadata ".repeat(400) }; // a large session, as real sessions with rich metadata are
    await signIn(b, "A");
    // the jar lists cookies in creation order; the storage writes the tail first and the head `.0` last, and every
    // reader indexes the chunks by number, so they are compared in index order
    const fam = b.jar.family().sort((x, y) => Number(x.slice(KEY.length + 1)) - Number(y.slice(KEY.length + 1)));
    expect(fam.length).toBeGreaterThanOrEqual(2);
    expect(fam).toEqual(fam.map((_, i) => `${KEY}.${i}`)); // only numbered chunks, no whole cookie
    // the chunks are exactly the installed SDK's chunking of the stored session (nothing hand-made)
    const joined = fam.map((n) => decodeURIComponent(b.jar.raw(n) ?? "")).join("");
    const ssr = cap.real as unknown as SsrModule;
    expect(ssr.createChunks(KEY, joined).map((c) => c.name)).toEqual(fam);
    expect(JSON.parse(joined).user.id).toBe(GOLFERS.A.id);
    // control: the base page's reader cannot see a chunked session (the source finding, reproduced on a real fixture)
    expect(legacyReader(b.jar.header())).toBeNull();
    const r = await acquireDrillHubSession(() => b.shared());
    expect(r.status === "ready" && r.session.accessToken === b.sb.latest("A")?.access && r.session.userId === GOLFERS.A.id).toBe(true);
    const states = await loadOnce(b);
    expect(states).toEqual([{ phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS.A, userId: GOLFERS.A.id }]);
    expect(restCalls(b).map((c) => c.caller)).toEqual(["A", "A"]);
    noTokenIn({ states, calls: b.sb.st.calls });
  });

  it("the page's read client is bound to one session: no Auth client of its own, no second-client warning", async () => {
    const b = await boot();
    await signIn(b, "A");
    const r = await acquireDrillHubSession(() => b.shared());
    if (r.status !== "ready") throw new Error("expected a session");
    const client = clientForSession(r.session);
    expect(() => (client as unknown as { auth: { getSession: unknown } }).auth.getSession).toThrow();
    // (auth-js counts instances in module state shared by every test, so only warnings during this load count)
    const before = warn.mock.calls.length;
    await loadOnce(b);
    const warned = warn.mock.calls.slice(before).map((c) => String(c[0]));
    expect(warned.filter((w) => /Multiple GoTrueClient/.test(w))).toEqual([]);
  });

  it("a near-expiry session: the SDK refreshes it once, and the reads carry the NEW token for the same golfer", async () => {
    // a background tab (no SDK ticker), so the session read for the hub is what meets the expiring session
    const b = await boot({ visible: false });
    b.sb.st.expiresIn = 30; // the signed-in session is inside the SDK's own expiry margin; a refresh issues a 1-hour one
    await signIn(b, "A");
    const signedIn = b.sb.st.live.length - 1;
    expect(b.sb.st.calls.filter((c) => c.kind === "refresh")).toEqual([]);
    const r = await acquireDrillHubSession(() => b.shared());
    if (r.status !== "ready") throw new Error(`expected a session, got ${r.status}`);
    const acquired = b.sb.st.live.findIndex((l) => l.access === r.session.accessToken);
    expect(b.sb.st.calls.filter((c) => c.kind === "refresh").map((c) => c.status)).toEqual([200]);
    expect(acquired).toBeGreaterThan(signedIn); // a refreshed token, not the expiring one
    expect(b.sb.st.live[acquired].who).toBe("A");
    expect(r.session.userId).toBe(GOLFERS.A.id);
    const states = await loadOnce(b);
    expect(states.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS.A, userId: GOLFERS.A.id });
    expect(restCalls(b).map((c) => [c.caller, c.token])).toEqual([["A", acquired], ["A", acquired]]);
    expect(b.sb.st.calls.filter((c) => c.kind === "refresh").length).toBe(1); // the fresh session needed no second refresh
    noTokenIn({ states, calls: b.sb.st.calls });
  });

  it("a near-expiry session whose refresh hits an Auth 500 (AG-WEB-READY-02 policy, replacing the R1 trace): the session is KEPT, no SIGNED_OUT, the hub says unavailable (not signed out) and reads nothing; one real refresh request", async () => {
    const b = await boot({ visible: false });
    b.sb.st.expiresIn = 30;
    await signIn(b, "A");
    b.sb.st.refreshMode = "fail500";
    const events: string[] = [];
    const ends: (string | null)[] = [];
    const auth = b.shared().auth as unknown as { onAuthStateChange(cb: (e: string, s: unknown) => void): { data: { subscription: { unsubscribe(): void } } } };
    const { data: sub } = auth.onAuthStateChange((event, session) => {
      events.push(event);
      ends.push(drillHubIdentityEndFromEvent(GOLFERS.A.id, event, session));
    });
    // the SDK keeps retrying its read for about 25 s (answered locally during the client's cooldown); the hub's own
    // deadline (shortened here) says unavailable long before that
    const r = await acquireDrillHubSession(() => b.shared(), 300);
    await settle();
    expect(r).toEqual({ status: "unavailable" });
    expect(b.sb.st.calls.filter((c) => c.kind === "refresh").map((c) => c.status)).toEqual([500]);
    expect(b.jar.family()).toEqual([KEY]); // kept: an outage is not a sign-out
    expect(events).not.toContain("SIGNED_OUT");
    expect(ends.filter((e) => e !== null)).toEqual([]);
    expect(restCalls(b)).toEqual([]);
    noTokenIn({ calls: b.sb.st.calls, events });
    sub.subscription.unsubscribe();
  });

  for (const mode of ["reject400"] as const) {
    it(`a near-expiry session whose refresh is rejected (coded 400): the browser session is removed and SIGNED_OUT announced; the hub shows signed out, with no read and no new identity`, async () => {
      const b = await boot({ visible: false });
      b.sb.st.expiresIn = 30;
      await signIn(b, "A");
      expect(b.sb.st.calls.filter((c) => c.kind === "refresh")).toEqual([]);
      expect(b.jar.family()).toEqual([KEY]);
      b.sb.st.refreshMode = mode;
      const issuedBefore = b.sb.st.live.length;
      // as the page mounts: its watcher subscribes to the shared client's events (classified for a hub showing A's
      // drills) while its load acquires the session; both meet the expiring session, and the SDK refreshes it once
      const events: string[] = [];
      const ends: (string | null)[] = [];
      const auth = b.shared().auth as unknown as { onAuthStateChange(cb: (e: string, s: unknown) => void): { data: { subscription: { unsubscribe(): void } } } };
      const { data: sub } = auth.onAuthStateChange((event, session) => {
        events.push(event);
        ends.push(drillHubIdentityEndFromEvent(GOLFERS.A.id, event, session));
      });
      const r = await acquireDrillHubSession(() => b.shared());
      await settle();
      // the failed refresh is never a session (an error, or no session once the SDK removed it)
      expect(["unavailable", "signed_out"]).toContain(r.status);
      expect(b.sb.st.calls.filter((c) => c.kind === "refresh").map((c) => c.status)).toEqual([mode === "reject400" ? 400 : 0]);
      // TRACE (auth-js 2.107 GoTrueClient _callRefreshToken): a coded 400 is not retryable, so the SDK ran _removeSession;
      // the transport had recorded the refusal of exactly the stored token, so the storage removed it (under the lease)
      // and the event fence delivered SIGNED_OUT (the jar holds no session).
      expect(b.jar.family()).toEqual([]);
      expect(events).toContain("SIGNED_OUT");
      expect(ends.filter((e) => e !== null)).toEqual(["signed_out"]);
      // the hub's own load then finds no session: signed out (not Try again), with no read
      const states = await loadOnce(b, () => GOLFERS.A.id);
      expect(states).toEqual([{ phase: "loading" }, { phase: "signed_out" }]);
      expect(restCalls(b)).toEqual([]); // never an anonymous or empty "ready"
      expect(b.sb.st.live.length).toBe(issuedBefore); // no session was invented
      noTokenIn({ states, calls: b.sb.st.calls, events });
      sub.subscription.unsubscribe();
    });
  }

  it("signed out (no session cookie): signed_out, and the hub shows signed out without any read", async () => {
    const b = await boot();
    expect(await acquireDrillHubSession(() => b.shared())).toEqual({ status: "signed_out" });
    const states = await loadOnce(b);
    expect(states).toEqual([{ phase: "loading" }, { phase: "signed_out" }]);
    expect(restCalls(b)).toEqual([]);
  });

  it("a malformed session cookie (deliberately invalid input, not an SDK format): never ready, no read", async () => {
    const b = await boot();
    b.jar.plant(KEY, encodeURIComponent("{not json"));
    const r = await acquireDrillHubSession(() => b.shared());
    // the installed SDK reports no session for a stored value it cannot read (GoTrueClient __loadSession)
    expect(r).toEqual({ status: "signed_out" });
    const states = await loadOnce(b);
    expect(states).toEqual([{ phase: "loading" }, { phase: "signed_out" }]);
    expect(restCalls(b)).toEqual([]);
  });

  it("context separation: after golfer A signs out and golfer B signs in, the hub shows only B's progress", async () => {
    const b = await boot();
    await signIn(b, "A");
    const a = await loadOnce(b);
    expect(a.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS.A, userId: GOLFERS.A.id });
    await endSession(b, "A");
    expect(b.jar.family()).toEqual([]);
    const mark = b.sb.st.calls.length;
    await signIn(b, "B");
    const r = await acquireDrillHubSession(() => b.shared());
    expect(r.status === "ready" && r.session.userId === GOLFERS.B.id).toBe(true);
    const states = await loadOnce(b);
    expect(states.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS.B, userId: GOLFERS.B.id });
    const after = b.sb.st.calls.slice(mark).filter((c) => c.kind === "drills" || c.kind === "user_drills");
    expect(after.map((c) => c.caller)).toEqual(["B", "B"]);
    expect(JSON.stringify(states)).not.toContain("A: path stayed square.");
  });

  it("account change (R1): a page still showing A whose browser is now B's reads nothing and ends as account_changed", async () => {
    const b = await boot();
    await signIn(b, "A");
    const a = await loadOnce(b);
    expect(a.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS.A, userId: GOLFERS.A.id });
    // the page's watcher sees the sign-out and the new sign-in (shared client events, as other tabs' arrive)
    const ends: (string | null)[] = [];
    const auth = b.shared().auth as unknown as { onAuthStateChange(cb: (e: string, s: unknown) => void): { data: { subscription: { unsubscribe(): void } } } };
    const { data: sub } = auth.onAuthStateChange((event, session) => ends.push(drillHubIdentityEndFromEvent(GOLFERS.A.id, event, session)));
    await settle();
    await endSession(b, "A");
    await signIn(b, "B");
    expect(ends.filter((e) => e !== null)).toEqual(["signed_out", "account_changed"]);
    // a load by the page that shows A (e.g. one already under way) never reads B's rows and never shows them
    const mark = b.sb.st.calls.length;
    const states = await loadOnce(b, () => GOLFERS.A.id);
    expect(states).toEqual([{ phase: "loading" }, { phase: "account_changed" }]);
    expect(b.sb.st.calls.slice(mark).filter((c) => c.kind === "drills" || c.kind === "user_drills")).toEqual([]);
    noTokenIn({ states });
    sub.subscription.unsubscribe();
  });

  it("a session removed after it was acquired: the bound reads still carry that token, never the anonymous key", async () => {
    const b = await boot();
    await signIn(b, "A");
    const states: DrillHubState<Drill, UserDrill>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loader = createDrillHubLoader<Drill, UserDrill>(
      (signal) => readDrillHub((readSignal) =>
        sessionBoundDrillHubReads<Drill, UserDrill>(
          async () => { const r = await acquireDrillHubSession(() => b.shared()); await gate; return r; },
          (session) => {
            const supabase = clientForSession(session);
            return {
              catalog: () => supabase.from("drills").select("id").abortSignal(readSignal) as never,
              progress: () => supabase.from("user_drills").select("drill_id").abortSignal(readSignal) as never,
            };
          }, readSignal),
      signal),
      (s) => states.push(s),
    );
    loader.load();
    await settle();
    for (const n of b.jar.family()) b.jar.clear(n); // e.g. signed out in another tab between acquisition and reads
    release();
    await vi.waitFor(() => expect(states.length).toBe(2), { timeout: 5000, interval: 10 });
    expect(restCalls(b).map((c) => c.caller)).toEqual(["A", "A"]);
    // control (A1 R1): the shared client's own table read in the same state — the jar emptied by a writer this browser
    // never recorded, while the lineage still records A — is refused before any request: not A's token, and not the
    // anonymous key either (which would read zero rows: "nothing verified")
    const before = b.sb.st.calls.length;
    const control = await b.shared().from("user_drills").select("drill_id");
    expect([control.data, control.error === null]).toEqual([null, false]);
    expect(b.sb.st.calls.length).toBe(before);
    loader.dispose();
  }, 20_000); // the control read is refused before any request; postgrest-js retries that failed fetch (1 s, 2 s, 4 s)
});

// ── 3. one acquisition per load, and cancellation ───────────────────────────────────────────────────────────────
describe("sessionBoundDrillHubReads — one session per load; cancellation never waits for the session", () => {
  const ok = <T,>(data: T[]) => () => Promise.resolve<ListReadResponse<T>>({ data, error: null });
  const SESSION: DrillHubSession = { accessToken: "t-1", userId: "u-1" };
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("both reads share one acquisition and are built once, for that session", async () => {
    const acquire = vi.fn(() => Promise.resolve<DrillHubSessionResult>({ status: "ready", session: SESSION }));
    const build = vi.fn((s: DrillHubSession): DrillHubReads<string, string> => {
      expect(s).toBe(SESSION);
      return { catalog: ok(["c"]), progress: ok(["p"]) };
    });
    const read = readDrillHub<string, string>((signal) => sessionBoundDrillHubReads(acquire, build, signal));
    await expect(read.result).resolves.toEqual({ phase: "ready", drills: ["c"], progress: ["p"] });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("cancelled while the session is still being acquired: both reads answer at once; a late session builds nothing", async () => {
    const pending = deferred<DrillHubSessionResult>();
    const build = vi.fn(() => ({ catalog: ok(["c"]), progress: ok(["p"]) }));
    const outer = new AbortController();
    const read = readDrillHub<string, string>((signal) => sessionBoundDrillHubReads(() => pending.promise, build, signal), outer.signal);
    outer.abort();
    await expect(read.result).resolves.toEqual({ phase: "unavailable" });
    await expect(read.settled).resolves.toBeUndefined(); // settled without the acquisition
    pending.resolve({ status: "ready", session: SESSION });
    await settle(2);
    expect(build).not.toHaveBeenCalled();
  });

  it("an already-cancelled load starts no acquisition at all", async () => {
    const acquire = vi.fn(() => Promise.resolve<DrillHubSessionResult>({ status: "ready", session: SESSION }));
    const outer = new AbortController();
    outer.abort();
    const read = readDrillHub<string, string>((signal) => sessionBoundDrillHubReads(acquire, () => ({ catalog: ok([]), progress: ok([]) }), signal), outer.signal);
    await expect(read.result).resolves.toEqual({ phase: "unavailable" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("an acquisition that throws or rejects, or a build that throws, is unavailable without an unhandled rejection", async () => {
    for (const [acquire, build] of [
      [() => { throw new Error("sync"); }, () => ({ catalog: ok([]), progress: ok([]) })],
      [() => Promise.reject(new Error("async")), () => ({ catalog: ok([]), progress: ok([]) })],
      [() => Promise.resolve<DrillHubSessionResult>({ status: "ready", session: SESSION }), () => { throw new Error("supabaseUrl is required."); }],
    ] as [() => Promise<DrillHubSessionResult>, (s: DrillHubSession) => DrillHubReads<string, string>][]) {
      const read = readDrillHub<string, string>((signal) => sessionBoundDrillHubReads(acquire, build, signal));
      await expect(read.result).resolves.toEqual({ phase: "unavailable" });
      await expect(read.settled).resolves.toBeUndefined();
    }
  });

  it("Try again while a session is still being acquired stays single-flight (one acquisition), then recovers", async () => {
    const states: DrillHubState<string, string>[] = [];
    const first = deferred<DrillHubSessionResult>();
    let n = 0;
    const acquire = vi.fn(() => (++n === 1 ? first.promise : Promise.resolve<DrillHubSessionResult>({ status: "ready", session: SESSION })));
    const loader = createDrillHubLoader<string, string>(
      (signal) => readDrillHub((s) => sessionBoundDrillHubReads(acquire, () => ({ catalog: ok(["c"]), progress: ok(["p"]) }), s), signal),
      (s) => states.push(s),
    );
    expect(loader.load()).toBe(true);
    expect([loader.load(), loader.load(), loader.load()]).toEqual([false, false, false]);
    expect(acquire).toHaveBeenCalledTimes(1);
    first.resolve({ status: "unavailable" });
    await settle(2);
    expect(states).toEqual([{ phase: "loading" }, { phase: "unavailable" }]);
    expect(loader.load()).toBe(true);
    await settle(2);
    expect(states.at(-1)).toEqual({ phase: "ready", drills: ["c"], progress: ["p"] });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("unmount while acquiring: nothing is published and no read is built", async () => {
    const states: DrillHubState<string, string>[] = [];
    const pending = deferred<DrillHubSessionResult>();
    const build = vi.fn(() => ({ catalog: ok(["c"]), progress: ok(["p"]) }));
    const loader = createDrillHubLoader<string, string>(
      (signal) => readDrillHub((s) => sessionBoundDrillHubReads(() => pending.promise, build, s), signal),
      (s) => states.push(s),
    );
    loader.load();
    loader.dispose();
    pending.resolve({ status: "ready", session: SESSION });
    await settle(2);
    expect(states).toEqual([{ phase: "loading" }]);
    expect(build).not.toHaveBeenCalled();
  });
});

// ── 4. verification answers and messages ────────────────────────────────────────────────────────────────────────
describe("drill verification — only an expected answer is shown; messages are fixed", () => {
  it("accepts exactly the expected shape and keeps only its three fields", () => {
    expect(readDrillVerifyResult({ pass: true, status: "verified", feedback: "Nice.", drillId: "d-1", userId: "u", extra: 1 }))
      .toEqual({ pass: true, status: "verified", feedback: "Nice." });
    expect(readDrillVerifyResult({ pass: false, status: "needs_work", feedback: "" })).toEqual({ pass: false, status: "needs_work", feedback: "" });
    for (const bad of [null, undefined, "x", 1, [], {}, { error: "AI verification failed: provider said 7f3c" }, { pass: "true", status: "verified", feedback: "x" },
      { pass: true, status: "approved", feedback: "x" }, { pass: true, status: "verified" }, { pass: true, status: "verified", feedback: 7 }]) {
      expect(readDrillVerifyResult(bad)).toBeNull();
    }
  });

  it("a size-limit refusal is recognised from its numbers only; anything else is an ordinary upload failure", () => {
    expect(isUploadTooLarge({ name: "StorageApiError", status: 413, statusCode: "413", message: "Payload too large (synthetic)" })).toBe(true);
    expect(isUploadTooLarge({ status: 400, statusCode: "413" })).toBe(true); // Storage's own code inside a 400 answer
    for (const other of [null, undefined, "413", 413, {}, { status: 400, statusCode: "403" }, { status: 500 }, { statusCode: "4130" }]) {
      expect(isUploadTooLarge(other)).toBe(false);
    }
  });

  it("every verification and sign-in message is plain language with no technical detail", () => {
    const texts = [...Object.values(DRILL_VERIFY_COPY), ...Object.values(DRILL_HUB_IDENTITY_COPY).flatMap((c) => Object.values(c))];
    expect(Object.keys(DRILL_VERIFY_COPY).length).toBe(12);
    expect(texts.length).toBe(18);
    for (const text of texts) expect(text).not.toMatch(/error|sql|supabase|storage|jwt|token|cookie|exception|status code|gemini|\d{3}/i);
  });

  // R1: only a failure that trying again can fix says "try again"
  const saysRetry = (k: DrillVerifyMessage) => /try again in a moment/i.test(DRILL_VERIFY_COPY[k]);

  it("verification refusals: permanent refusals and unknown outcomes never say try again in a moment", () => {
    expect(drillVerifyRefusal(401)).toBe("notConfirmed");
    expect(drillVerifyRefusal(400)).toBe("checkRefused");
    expect(drillVerifyRefusal(403)).toBe("checkRefused");
    expect(drillVerifyRefusal(404)).toBe("drillUnavailable");
    expect(drillVerifyRefusal(503)).toBe("serviceUnavailable");
    for (const s of [429, 500, 502]) expect(drillVerifyRefusal(s)).toBe("checkFailed");
    // no answer (failed in transit, or a success of an unexpected shape) and every other status: the page cannot know
    // whether the check ran, e.g. a gateway timeout after the server wrote the result
    for (const s of [null, 504, 0, 200, 405, 409, 413, 422, 501, 520, 599]) expect(drillVerifyRefusal(s)).toBe("outcomeUnknown");
    expect(saysRetry("checkFailed")).toBe(true);
    for (const k of ["notConfirmed", "checkRefused", "drillUnavailable", "serviceUnavailable", "outcomeUnknown"] as const) expect(saysRetry(k)).toBe(false);
    expect(DRILL_VERIFY_COPY.outcomeUnknown).toMatch(/latest result before you submit/);
    // a 404 can also be a failed lookup and a 500 can recur for the same clip: neither copy over-claims
    expect(DRILL_VERIFY_COPY.drillUnavailable).not.toMatch(/anymore|no longer|removed/i);
    expect(DRILL_VERIFY_COPY.checkFailed).toMatch(/if it fails again, try a different clip/);
  });

  it("upload refusals from their two numeric fields: size, format and permission are permanent; anything else may be retried", () => {
    expect(drillUploadRefusal({ status: 413, statusCode: "413" })).toBe("tooLarge");
    expect(drillUploadRefusal({ status: 400, statusCode: "413" })).toBe("tooLarge");
    expect(drillUploadRefusal({ status: 400, statusCode: "415", message: "mime type video/x-msvideo is not supported (synthetic)" })).toBe("wrongType");
    expect(drillUploadRefusal({ status: 415 })).toBe("wrongType");
    expect(drillUploadRefusal({ status: 400, statusCode: "403", message: "new row violates row-level security policy (synthetic)" })).toBe("uploadRefused");
    expect(drillUploadRefusal({ status: 403 })).toBe("uploadRefused");
    expect(drillUploadRefusal({ status: 401, statusCode: "401" })).toBe("uploadRefused");
    for (const other of [null, undefined, "415", 403, {}, { status: 500 }, { status: 503, statusCode: "503" }, { name: "StorageUnknownError" }, { statusCode: "4150" },
      // recorded as they are (worth one more try): Storage's own 404 (bucket/object), 409 (duplicate name) and an uncoded 400
      { status: 400, statusCode: "404" }, { status: 400, statusCode: "409" }, { status: 400 }]) {
      expect(drillUploadRefusal(other)).toBe("uploadFailed");
    }
    expect(saysRetry("uploadFailed")).toBe(true);
    for (const k of ["tooLarge", "wrongType", "uploadRefused"] as const) expect(saysRetry(k)).toBe(false);
  });
});

// ── 5. sign-out and account change end the hub; nothing started before can restore it (R1) ─────────────────────
describe("who the hub shows — a sign-out or account change ends it, and late results restore nothing", () => {
  const A = "u-a", B = "u-b";
  const ready = (userId: string): DrillHubSessionResult => ({ status: "ready", session: { accessToken: `t-${userId}`, userId } });
  const ok = <T,>(data: T[]) => () => Promise.resolve<ListReadResponse<T>>({ data, error: null });

  it("an observed session: signed out ends it; another golfer is an account change; unavailable or the same golfer changes nothing", () => {
    expect(drillHubIdentityEnd(A, { status: "signed_out" })).toBe("signed_out");
    expect(drillHubIdentityEnd(null, { status: "signed_out" })).toBe("signed_out");
    expect(drillHubIdentityEnd(A, ready(B))).toBe("account_changed");
    expect(drillHubIdentityEnd(A, ready(A))).toBeNull();
    expect(drillHubIdentityEnd(null, ready(B))).toBeNull(); // nothing shown yet
    expect(drillHubIdentityEnd(A, { status: "unavailable" })).toBeNull(); // not evidence of a sign-out
  });

  it("an event from the shared client: SIGNED_OUT ends it; any event carrying another golfer's session is an account change", () => {
    expect(drillHubIdentityEndFromEvent(A, "SIGNED_OUT", null)).toBe("signed_out");
    expect(drillHubIdentityEndFromEvent(null, "SIGNED_OUT", null)).toBe("signed_out");
    for (const event of ["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION", "USER_UPDATED"]) {
      expect(drillHubIdentityEndFromEvent(A, event, { access_token: "x", user: { id: B } })).toBe("account_changed");
      expect(drillHubIdentityEndFromEvent(A, event, { access_token: "x", user: { id: A } })).toBeNull();
      expect(drillHubIdentityEndFromEvent(A, event, null)).toBeNull(); // e.g. INITIAL_SESSION after a failed start-up read
      expect(drillHubIdentityEndFromEvent(null, event, { user: { id: B } })).toBeNull();
    }
    for (const odd of [undefined, "s", 1, {}, { user: null }, { user: { id: "" } }, { user: { id: 7 } }]) {
      expect(drillHubIdentityEndFromEvent(A, "SIGNED_IN", odd)).toBeNull();
    }
    // auth-js's user stand-in throws when read (userNotAvailableProxy): never thrown into the SDK's notifier
    const throwing = { access_token: "x", get user() { return new Proxy({}, { get: () => { throw new Error("user not available (synthetic)"); } }); } };
    expect(() => drillHubIdentityEndFromEvent(A, "SIGNED_IN", throwing)).not.toThrow();
    expect(drillHubIdentityEndFromEvent(A, "SIGNED_IN", throwing)).toBeNull();
    expect(drillHubIdentityEndFromEvent(A, "SIGNED_IN", { get user(): unknown { throw new Error("getter (synthetic)"); } })).toBeNull();
  });

  it("loads: the first ready load names its golfer; signed out is its own state; another golfer's load reads nothing and is an account change", async () => {
    let shown: string | null = null;
    let next: DrillHubSessionResult = ready(A);
    const states: DrillHubSessionState<string, string>[] = [];
    const build = vi.fn((s: DrillHubSession): DrillHubReads<string, string> => ({ catalog: ok([`c-${s.userId}`]), progress: ok([`p-${s.userId}`]) }));
    const loader = createDrillHubSessionLoader<string, string>(() => Promise.resolve(next), build, () => shown, (s) => states.push(s));
    expect(loader.load()).toBe(true);
    await settle(1);
    expect(states).toEqual([{ phase: "loading" }, { phase: "ready", drills: ["c-u-a"], progress: ["p-u-a"], userId: A }]);
    shown = A; // what the page records from that result
    next = ready(B);
    expect(loader.load()).toBe(true);
    await settle(1);
    expect(states.at(-1)).toEqual({ phase: "account_changed" });
    expect(build).toHaveBeenCalledTimes(1); // B's rows were never read
    expect(JSON.stringify(states)).not.toContain("u-b");
    next = { status: "signed_out" };
    loader.load();
    await settle(1);
    expect(states.at(-1)).toEqual({ phase: "signed_out" });
    next = { status: "unavailable" };
    loader.load();
    await settle(1);
    expect(states.at(-1)).toEqual({ phase: "unavailable" }); // Try again can help here
    next = ready(A);
    loader.load();
    await settle(1);
    expect(states.at(-1)).toEqual({ phase: "ready", drills: ["c-u-a"], progress: ["p-u-a"], userId: A });
    // a read failure for the shown golfer is still unavailable, never signed out
    const failing = createDrillHubSessionLoader<string, string>(() => Promise.resolve(ready(A)),
      () => ({ catalog: () => Promise.resolve({ data: null, error: { message: "x" } }), progress: ok(["p"]) }), () => A, (s) => states.push(s));
    failing.load();
    await settle(1);
    expect(states.at(-1)).toEqual({ phase: "unavailable" });
  });

  it("the session's user id is read without ever throwing", () => {
    expect(drillHubSessionUserId({ access_token: "x", user: { id: A } })).toBe(A);
    for (const odd of [null, undefined, "s", 1, {}, { user: null }, { user: { id: "" } }, { user: { id: 7 } },
      { get user(): unknown { throw new Error("getter (synthetic)"); } }]) {
      expect(drillHubSessionUserId(odd)).toBeNull();
    }
  });

  it("first-load race: the browser switches to another golfer while the first load is still reading; that load shows nothing and ends as account_changed", async () => {
    // the page passes "the golfer shown, or else the golfer last seen" (events and session checks)
    let seen: string | null = A; // e.g. INITIAL_SESSION for A
    let release!: (v: ListReadResponse<string>) => void;
    const held = new Promise<ListReadResponse<string>>((r) => { release = r; });
    const states: DrillHubSessionState<string, string>[] = [];
    const loader = createDrillHubSessionLoader<string, string>(() => Promise.resolve(ready(A)), () => ({ catalog: () => held, progress: ok(["p-u-a"]) }),
      () => seen, (s) => states.push(s));
    loader.load();
    await settle(1);
    seen = B; // SIGNED_IN for B arrives from another tab before the first load has finished
    release({ data: ["c-u-a"], error: null });
    await settle(2);
    expect(states).toEqual([{ phase: "loading" }, { phase: "account_changed" }]);
    expect(JSON.stringify(states)).not.toContain("u-a\"");
  });

  it("late results: a load still reading when the hub ends (the page disposes its loader) publishes nothing; its reads are cancelled", async () => {
    let release!: (v: ListReadResponse<string>) => void;
    const held = new Promise<ListReadResponse<string>>((r) => { release = r; });
    const signals: AbortSignal[] = [];
    const states: DrillHubSessionState<string, string>[] = [];
    const loader = createDrillHubSessionLoader<string, string>(() => Promise.resolve(ready(A)), (_s, readSignal) => {
      signals.push(readSignal);
      return { catalog: () => held, progress: ok(["p"]) };
    }, () => null, (s) => states.push(s));
    loader.load();
    await settle(1);
    expect(signals.length).toBe(1);
    loader.dispose(); // the page's endIdentity
    expect(signals[0].aborted).toBe(true);
    release({ data: ["late catalog"], error: null });
    await settle(2);
    expect(states).toEqual([{ phase: "loading" }]); // nothing after the end, not even the late result
    expect(loader.load()).toBe(false); // and no new load
  });

  it("late results: a session that arrives after the hub ended builds no read", async () => {
    let arrive!: (r: DrillHubSessionResult) => void;
    const pending = new Promise<DrillHubSessionResult>((r) => { arrive = r; });
    const build = vi.fn(() => ({ catalog: ok(["c"]), progress: ok(["p"]) }));
    const states: DrillHubSessionState<string, string>[] = [];
    const loader = createDrillHubSessionLoader<string, string>(() => pending, build, () => null, (s) => states.push(s));
    loader.load();
    loader.dispose();
    arrive(ready(A));
    await settle(2);
    expect(build).not.toHaveBeenCalled();
    expect(states).toEqual([{ phase: "loading" }]);
  });

  it("the signed-out and changed-account copy names no account and offers the one useful action", () => {
    expect(DRILL_HUB_IDENTITY_COPY.signed_out.action).toBe("Sign in");
    expect(DRILL_HUB_IDENTITY_COPY.account_changed.action).toBe("Refresh page");
    for (const c of Object.values(DRILL_HUB_IDENTITY_COPY)) expect(`${c.title} ${c.body}`).not.toMatch(/try again|@|golfer-/i);
  });
});

// ── A3: requests bound to the account the page was rendered for ────────────────────────────────────────────────────
describe("A3: confirmOwnerSession and ownerBoundClient — a page's requests carry only its rendered account's token", () => {
  const OWNER = "00000000-0000-4000-8000-0000000000aa";
  const OTHER = "00000000-0000-4000-8000-0000000000bb";
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tokenFor = (sub: string, sid = randomUUID()) => `${b64({ alg: "none" })}.${b64({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-${randomUUID()}`;
  const sessionFor = (userId: string, sub = userId) => ({ access_token: tokenFor(sub), user: { id: userId } });
  /** A managed-client stand-in whose every read answers what `holds()` says now (a test changes it mid-schedule). */
  const managedHolding = (holds: () => unknown) => {
    const getSession = vi.fn(async () => {
      const now = holds();
      if (now instanceof Error) throw now;
      return { data: { session: now }, error: null };
    });
    return { auth: { getSession, onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, from: null as unknown, storage: null as unknown };
  };

  it("confirms only the rendered owner's session: the user AND the token's subject must be the owner; anything else is a named refusal, never another account's session", async () => {
    const { confirmOwnerSession } = await import("@/lib/drill-hub-session");
    const mine = sessionFor(OWNER);
    const ok = await confirmOwnerSession(() => managedHolding(() => mine), OWNER);
    expect(ok).toEqual({ status: "ready", session: { accessToken: mine.access_token, userId: OWNER } });
    expect(await confirmOwnerSession(() => managedHolding(() => sessionFor(OTHER)), OWNER)).toEqual({ status: "account_changed" });
    // a session object naming the owner whose token states another subject (a mixed copy): never the owner's
    expect(await confirmOwnerSession(() => managedHolding(() => sessionFor(OWNER, OTHER)), OWNER)).toEqual({ status: "account_changed" });
    expect(await confirmOwnerSession(() => managedHolding(() => null), OWNER)).toEqual({ status: "signed_out" });
    const refused = Object.assign(new Error("We couldn't confirm your sign-in on this device."), {});
    Object.defineProperty(refused, "__swingproaiSessionUnverified", { value: "stale" });
    expect(await confirmOwnerSession(() => managedHolding(() => refused), OWNER)).toEqual({ status: "unconfirmed" });
    expect(await confirmOwnerSession(() => managedHolding(() => new TypeError("Failed to fetch")), OWNER)).toEqual({ status: "unavailable" });
    // no rendered owner: nothing is confirmed, whatever the browser holds (never adopted as the first session seen)
    expect(await confirmOwnerSession(() => managedHolding(() => mine), null)).toEqual({ status: "unconfirmed" });
  });

  it("a session whose End Session is pending (the server's END INTENT names its lineage) is refused as ended", async () => {
    const { confirmOwnerSession } = await import("@/lib/drill-hub-session");
    const { sessionLineageId } = await import("@/utils/supabase/session-cookie-layout");
    const mine = sessionFor(OWNER);
    vi.stubGlobal("document", { cookie: `swingproai-session-ended=${await sessionLineageId(mine.access_token)}` });
    expect(await confirmOwnerSession(() => managedHolding(() => mine), OWNER)).toEqual({ status: "ended" });
  });

  it("the owner-bound client (real supabase-js): every PostgREST/Storage request is confirmed as it is built; a request whose owner is no longer confirmed is answered locally (401 owner_refused) and NEVER sent; nothing is anonymous", async () => {
    const { ownerBoundClient } = await import("@/lib/drill-hub-session");
    const wire: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      wire.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(url.includes("/storage/") ? { Key: "k", Id: "i" } : [{ id: "row" }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const mine = sessionFor(OWNER);
    const theirs = sessionFor(OTHER);
    let holds: unknown = mine;
    const managed = managedHolding(() => holds);
    const client = ownerBoundClient(managed, OWNER, "http://127.0.0.1:54329", "synthetic-anon-key-not-a-secret");
    expect(managed.auth.getSession).not.toHaveBeenCalled(); // creating it reads and sends nothing
    expect(client.auth).toBe(managed.auth); // acquisition, refresh and events stay with the managed client
    const first = await (client.from as (t: string) => { select: (c: string) => PromiseLike<{ error: unknown }> })("user_equipment").select("id");
    expect(first.error).toBeNull();
    expect(wire.at(-1)).toEqual({ url: expect.stringContaining("/rest/v1/user_equipment"), authorization: `Bearer ${mine.access_token}` });
    // B is published (the browser now holds B) before the next request is built — no event has been delivered
    holds = theirs;
    const before = wire.length;
    const refusedRead = await (client.from as (t: string) => { select: (c: string) => PromiseLike<{ error: { code?: string } | null; status: number }> })("user_equipment").select("id");
    const refusedUpload = await (client.storage as { from: (b: string) => { upload: (p: string, b: Blob) => Promise<{ error: unknown }> } }).from("swing-videos").upload(`${OWNER}/x/swing.mp4`, new Blob(["x"]));
    expect(wire.length).toBe(before); // neither request left the browser
    expect(wire.some((w) => w.authorization === `Bearer ${theirs.access_token}`)).toBe(false);
    expect(refusedRead.status).toBe(401);
    expect(refusedRead.error?.code).toBe("owner_refused");
    expect(refusedUpload.error).not.toBeNull();
    // signed out, or a refused read: still nothing sent, never the anonymous key
    holds = null;
    await (client.from as (t: string) => { select: (c: string) => PromiseLike<unknown> })("user_equipment").select("id");
    expect(wire.length).toBe(before);
    // the owner again (e.g. the other tab signed the owner back in): requests go out with the owner's NEW token
    const again = sessionFor(OWNER);
    holds = again;
    await (client.from as (t: string) => { select: (c: string) => PromiseLike<unknown> })("user_equipment").select("id");
    expect(wire.at(-1)?.authorization).toBe(`Bearer ${again.access_token}`);
    expect(wire.every((w) => w.authorization !== "Bearer synthetic-anon-key-not-a-secret")).toBe(true);
  });

  it("ownerBearer names exactly the confirmed session's token (the doorway verifies it; the page never builds one)", async () => {
    const { ownerBearer } = await import("@/lib/drill-hub-session");
    expect(ownerBearer({ accessToken: "t-owner", userId: OWNER })).toEqual({ Authorization: "Bearer t-owner" });
  });
});
