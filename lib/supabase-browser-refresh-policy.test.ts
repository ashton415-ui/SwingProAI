import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { acquireDrillHubSession, drillHubIdentityEnd } from "@/lib/drill-hub-session";
import type { LineageRecord, LineageStore } from "@/utils/supabase/session-lease";

// AG-WEB-READY-02: the refresh-answer policy of the shared browser client (utils/supabase/client.ts), driven through
// the real installed @supabase/ssr 0.3.0 and supabase-js/auth-js 2.107.0. Every request the SDK makes goes through the
// client's fetch to an in-memory Auth stand-in (the platform fetch is stubbed), so "a real request" below means one
// that reached the stand-in; an answer the policy gives itself never does. Synthetic golfers and tokens only; nothing
// leaves memory. window/document/location are stubbed per test (a small cookie store that honours Max-Age); there is
// no BroadcastChannel. The clock is fake (setTimeout/setInterval, Date and performance), so the SDK's own retry
// backoff, its 30-second ticker and the policy's cooldown run in fake time and every boundary is exact to the
// millisecond: the stand-in records the fake time of each request it receives.
// Continuation (review finding 1): the stand-in labels every session it issues (A#1, A#2, B#1 …) and records which one
// each request presented and issued; each tab records which golfer every SDK event names. Labels only, never a token.
// AG-WEB-READY-03-R1: the shared client now stores its session through the layout-managed session storage under the
// session-publication lease (utils/supabase/session-storage.ts, session-lease.ts), and a policy tab signs in through the
// browser's sign-in publication (utils/supabase/session-publication.ts: a non-persisting client asks Auth, setSession
// publishes; the shared client never calls signInWithPassword itself). Tabs of one test share a Web Locks shim; there is
// no IndexedDB here (the lineage check is skipped and counted; lib/session-publication.test.ts covers it). Every R2
// refresh-answer expectation is unchanged; the continuation cases whose outcome the new design changes say so.

const requireFromHere = createRequire(import.meta.url);
type SsrModule = Record<string, (...a: unknown[]) => unknown>;
const cap = vi.hoisted(() => ({ real: null as unknown as Record<string, (...a: unknown[]) => unknown>, options: [] as Record<string, unknown>[], clients: [] as unknown[] }));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...a: unknown[]) => {
    cap.options.push((a[2] ?? {}) as Record<string, unknown>);
    const c = cap.real.createBrowserClient(...a);
    cap.clients.push(c);
    return c;
  },
  createServerClient: (...a: unknown[]) => cap.real.createServerClient(...a),
  isBrowser: () => cap.real.isBrowser(),
  parse: (...a: unknown[]) => cap.real.parse(...a),
  serialize: (...a: unknown[]) => cap.real.serialize(...a),
  createChunks: (...a: unknown[]) => cap.real.createChunks(...a),
  // the installed constant (lib/session-publication.test.ts checks it against the real module)
  DEFAULT_COOKIE_OPTIONS: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 * 1000 },
}));
/** A fresh copy of the real installed module per test, so the SDK's browser singleton starts empty. */
function freshSsr(): SsrModule {
  const p = requireFromHere.resolve("@supabase/ssr");
  delete requireFromHere.cache[p];
  return requireFromHere(p) as SsrModule;
}

const SUPABASE = "http://127.0.0.1:54329";
const OTHER_PROJECT = "http://127.0.0.1:54330"; // in-memory too; never contacted
const ANON = "synthetic-anon-key-not-a-secret";
const KEY = "sb-127-auth-token";
const GOLFERS = {
  A: { id: "00000000-0000-4000-8000-0000000000aa", email: "golfer-a@example.invalid" },
  B: { id: "00000000-0000-4000-8000-0000000000bb", email: "golfer-b@example.invalid" },
} as const;
type Who = keyof typeof GOLFERS;
const PASSWORD = "synthetic-password-not-a-secret";
// 6 Nov 2026 08:49:00 UTC: a whole second (HTTP-dates have one-second resolution) on a single-digit day of the month
// (so the asctime form's " 6" day is exercised)
const START = Date.UTC(2026, 10, 6, 8, 49, 0);
const ORIGINAL = "ORIGINAL-TEXT"; // in every stand-in refusal body: must never reach an SDK error or the console
const SECOND = 1000;
const FLOOR = 30 * SECOND;
const CAP = 3600 * SECOND;

/** Real macrotask turns (setImmediate is not faked), so every pending promise chain settles without moving the clock. */
const flush = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r)); };
/** Moves the fake clock by ms, running every timer due on the way and settling promises between them. */
const run = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

/** navigator.locks for the tabs of one test: FIFO exclusive grants, abort signals honoured until granted. Grants are
 *  microtasks, so a free lock never moves a request off the fake-clock instant the R2 timelines below are pinned to. */
function lockManager() {
  type Req = { callback: (l: unknown) => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const queue: Req[] = [];
  let held = false;
  const pump = () => {
    if (held || queue.length === 0) return;
    const r = queue.shift()!;
    held = true;
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => r.callback({}))
        .then((v) => { held = false; r.resolve(v); pump(); }, (e) => { held = false; r.reject(e); pump(); });
    });
  };
  return {
    request(_name: string, options: { signal?: AbortSignal }, callback: (l: unknown) => unknown) {
      return new Promise((resolve, reject) => {
        const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
        if (options.signal?.aborted) return reject(abortError());
        const r: Req = { callback, resolve, reject };
        options.signal?.addEventListener("abort", () => {
          const at = queue.indexOf(r);
          if (at !== -1) { queue.splice(at, 1); reject(abortError()); }
        }, { once: true });
        queue.push(r);
        pump();
      });
    },
  };
}

/**
 * The browser's IndexedDB lineage record (A1: the lineage is part of every supported browser; an unsupported one fails
 * closed), in memory and shared by the tabs of one browser. Its operations settle as microtasks, so they never move a
 * request off the fake-clock instant the R2 timelines below are pinned to.
 */
function memoryLineage(): LineageStore & { recordNow(digest: string): void } {
  let record: LineageRecord | null = null;
  const put = (digest: string) => {
    const h = record?.history ?? [];
    if (h[h.length - 1] !== digest) record = { epoch: "e1", seq: (record?.seq ?? 0) + 1, history: [...h, digest].slice(-8) };
    return record!;
  };
  return {
    async read() {
      return record;
    },
    async append(digest: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("abandoned");
      return put(digest);
    },
    /** What End Session in another tab records with its removal ("none"), at the same instant (test-side only). */
    recordNow(digest: string) {
      put(digest);
    },
  };
}

function installBrowser(visibility: "visible" | "hidden", store = new Map<string, string>(), locks = lockManager(), lineage = memoryLineage()) {
  const listeners: Record<string, ((e?: unknown) => unknown)[]> = {};
  const doc = {
    get cookie() { return Array.from(store, ([n, v]) => `${n}=${v}`).join("; "); },
    set cookie(raw: string) {
      const [pair, ...attrs] = String(raw).split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      if (maxAge !== undefined && Number(maxAge.slice(8)) <= 0) store.delete(name);
      else store.set(name, pair.slice(eq + 1).trim());
    },
    // "hidden": the SDK runs no ticker, so only the reads a test makes meet the session. "visible": its 30 s ticker runs.
    visibilityState: visibility,
    addEventListener() {},
    removeEventListener() {},
  };
  const loc = { href: "http://127.0.0.1:3941/drills", origin: "http://127.0.0.1:3941", protocol: "http:", host: "127.0.0.1:3941", hostname: "127.0.0.1",
    port: "3941", pathname: "/drills", search: "", hash: "", assign() {}, replace() {}, reload() {} };
  // the SDK registers its visibilitychange callback on window; it is recorded so a test can deliver a tab return
  const win = { document: doc, location: loc, history: { state: null, replaceState() {} },
    addEventListener(type: string, cb: (e?: unknown) => unknown) { (listeners[type] ??= []).push(cb); }, removeEventListener() {} };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", loc);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("navigator", { locks, userAgent: "synthetic" });
  /** The golfer comes back to the tab: it becomes visible and the SDK's own visibilitychange callback runs. */
  const showTab = () => { doc.visibilityState = "visible"; for (const cb of listeners.visibilitychange ?? []) void cb(); };
  return { family: () => Array.from(store.keys()).filter((n) => n === KEY || n.startsWith(`${KEY}.`)), store, showTab, locks, lineage };
}

type Answer = { status: number; body?: string | null; headers?: Record<string, string>; endless?: boolean; lockedBody?: boolean; bodyAfterMs?: number };
// presented / issued: the stand-in's synthetic label of the session whose refresh token a refresh presented, and of the
// session a refresh or sign-in issued ("A#1" = golfer A's first issued session); never a token value
type Sent = { kind: "refresh" | "password" | "logout" | "rest" | "user" | "other"; at: number; status: number; origin: string; presented?: string; issued?: string };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Answer =>
  ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", ...headers } });
const FAIL_500 = (): Answer => json(500, { code: "unexpected_failure", msg: `synthetic outage ${ORIGINAL}` });
function toResponse(a: Answer): Response {
  if (a.endless) {
    // a body that starts but never finishes
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"code":"refresh_token_not_found",')); } });
    return new Response(stream, { status: a.status, headers: a.headers });
  }
  if (a.bodyAfterMs !== undefined) {
    // the whole body arrives after bodyAfterMs (fake time), then the stream ends
    const bytes = new TextEncoder().encode(a.body ?? "");
    const stream = new ReadableStream<Uint8Array>({ start(c) { setTimeout(() => { try { c.enqueue(bytes); c.close(); } catch { /* the reader gave up first */ } }, a.bodyAfterMs); } });
    return new Response(stream, { status: a.status, headers: a.headers });
  }
  const response = new Response(a.body ?? null, { status: a.status, headers: a.headers });
  if (a.lockedBody) response.body?.getReader(); // a body something else has already locked: it cannot be read
  return response;
}

function standIn() {
  const st = {
    expiresIn: 60, // inside the SDK's 90-second margin at once: the next session read refreshes
    refreshAnswer: null as null | ((n: number) => Answer), // n = 1 for the first real refresh request; null = grant
    passwordAnswer: null as null | Answer,
    restAnswer: null as null | Answer,
    // Auth's refresh-token rotation: a used token presented again within the reuse interval gets the session it was
    // rotated into; later, refresh_token_already_used. loseAnswer: rotate, but answer with that status instead (an
    // answer lost on the way back, e.g. a gateway timeout).
    reuseIntervalMs: 10_000,
    loseAnswer: null as null | number,
    rejectRefresh: false, // the platform fetch itself rejects (a network failure, or an answer CORS withholds)
    // a granted refresh whose answer body arrives this long (fake ms) after its status line: the answer is in flight
    grantBodyAfterMs: null as null | number,
    // golfer A's sessions carry a large synthetic user_metadata, so the SDK stores them as numbered cookie chunks
    bigA: false,
    live: [] as { who: Who; label: string; access: string; refresh: string; used: boolean; usedAt?: number; child?: unknown }[],
    issuedCount: { A: 0, B: 0 } as Record<Who, number>,
    sent: [] as Sent[],
    lastResponse: null as Response | null,
  };
  function issue(who: Who, expiresIn: number) {
    const now = Math.floor(Date.now() / SECOND);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const access = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: GOLFERS[who].id, exp: now + expiresIn, role: "authenticated" })}.${randomBytes(24).toString("base64url")}`;
    const refresh = randomBytes(12).toString("base64url");
    st.live.push({ who, label: `${who}#${++st.issuedCount[who]}`, access, refresh, used: false });
    return { access_token: access, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: refresh,
      user: { id: GOLFERS[who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[who].email, app_metadata: {},
        user_metadata: st.bigA && who === "A" ? { synthetic_padding: "p".repeat(6000) } : {}, created_at: "2026-01-01T00:00:00Z" } };
  }
  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== SUPABASE && url.origin !== OTHER_PROJECT) throw new TypeError("stand-in: outside the synthetic origins");
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, string>) : {};
    const grant = url.searchParams.get("grant_type");
    let kind: Sent["kind"] = "other";
    let a: Answer;
    let presented: string | undefined;
    let issued: string | undefined;
    if (url.origin === SUPABASE && method === "POST" && url.pathname === "/auth/v1/token" && grant === "refresh_token") {
      kind = "refresh";
      if (st.rejectRefresh) {
        st.sent.push({ kind, at: Date.now(), status: 0, origin: url.origin });
        throw new TypeError("Failed to fetch");
      }
      const n = st.sent.filter((s) => s.kind === "refresh").length + 1;
      const live = st.live.find((l) => l.refresh === body.refresh_token);
      presented = live?.label ?? "unknown";
      if (st.refreshAnswer) a = st.refreshAnswer(n);
      else if (live && !live.used) {
        live.used = true;
        live.usedAt = Date.now();
        live.child = issue(live.who, 3600);
        issued = st.live[st.live.length - 1].label;
        if (st.loseAnswer !== null) { a = json(st.loseAnswer, { msg: `lost on the way back ${ORIGINAL}` }); st.loseAnswer = null; }
        else a = { ...json(200, live.child), ...(st.grantBodyAfterMs !== null ? { bodyAfterMs: st.grantBodyAfterMs } : {}) };
      } else if (live && live.child && Date.now() - (live.usedAt ?? 0) <= st.reuseIntervalMs) a = json(200, live.child);
      else if (live) a = json(400, { code: "refresh_token_already_used", msg: `Already Used ${ORIGINAL}` });
      else a = json(400, { code: "refresh_token_not_found", msg: `Invalid Refresh Token ${ORIGINAL}` });
    } else if (url.origin === SUPABASE && method === "POST" && url.pathname === "/auth/v1/token" && grant === "password") {
      kind = "password";
      const who = (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].email === body.email);
      if (st.passwordAnswer) a = st.passwordAnswer;
      else if (who && body.password === PASSWORD) {
        a = json(200, issue(who, st.expiresIn));
        issued = st.live[st.live.length - 1].label;
      } else a = json(400, { code: "invalid_credentials", msg: "Invalid login credentials" });
    } else if (url.origin === SUPABASE && method === "POST" && url.pathname === "/auth/v1/logout") {
      kind = "logout";
      a = { status: 204 };
    } else if (url.origin === SUPABASE && method === "GET" && url.pathname === "/auth/v1/user") {
      kind = "user";
      const bearer = new Headers(init?.headers).get("authorization");
      const live = st.live.find((l) => `Bearer ${l.access}` === bearer);
      presented = live?.label;
      a = live
        ? json(200, { id: GOLFERS[live.who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[live.who].email, app_metadata: {},
          user_metadata: st.bigA && live.who === "A" ? { synthetic_padding: "p".repeat(6000) } : {}, created_at: "2026-01-01T00:00:00Z" })
        : json(401, { code: "bad_jwt", msg: "invalid JWT" });
    } else if (url.origin === SUPABASE && url.pathname.startsWith("/rest/v1/")) {
      kind = "rest";
      a = st.restAnswer ?? json(200, []);
    } else {
      a = st.refreshAnswer ? st.refreshAnswer(0) : json(404, { msg: "not served" });
    }
    st.sent.push({ kind, at: Date.now(), status: a.status, origin: url.origin, ...(presented ? { presented } : {}), ...(issued ? { issued } : {}) });
    st.lastResponse = toResponse(a);
    return st.lastResponse;
  }
  const refreshes = () => st.sent.filter((s) => s.kind === "refresh" && s.origin === SUPABASE);
  return { st, fetch: fetchFn, refreshes };
}

type AuthError = { name?: string; status?: number; code?: string; message?: string } | null;
type SessionShape = { access_token: string; refresh_token: string; user: { id: string } };
type Shared = {
  auth: {
    initialize(): Promise<unknown>;
    signInWithPassword(c: { email: string; password: string }): Promise<{ data: { session: SessionShape | null }; error: AuthError }>;
    getSession(): Promise<{ data: { session: SessionShape | null }; error: AuthError }>;
    refreshSession(): Promise<{ data: { session: SessionShape | null }; error: AuthError }>;
    signOut(o?: { scope?: "global" | "local" | "others" }): Promise<{ error: AuthError }>;
    onAuthStateChange(cb: (e: string, s: unknown) => void): { data: { subscription: { unsubscribe(): void } } };
    stopAutoRefresh(): Promise<void>;
  };
  from(table: string): { select(columns?: string): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null; status: number }> };
};

/** A tab: the shared client (or, with `sdkAlone`, the installed SDK with the same cookies and no policy), signed in.
 *  With `page`, another page of the same browser (a reload, or a second tab): a new SDK singleton over the same cookie
 *  store and the same Auth stand-in, not signed in again. */
type Tab = { browser: ReturnType<typeof installBrowser>; sb: ReturnType<typeof standIn>; client: Shared; events: string[]; seen: [string, Who | "none" | "other"][]; unsubscribe: () => void;
  /** the policy tab's sign-in publication; null for the SDK-alone arm */
  publication: typeof import("@/utils/supabase/session-publication") | null };
/** Which synthetic golfer an SDK event's session belongs to ("none": no session). The SDK's user stand-in throws on
 *  any property read, so the read is guarded. */
function whoOf(session: unknown): Who | "none" | "other" {
  if (!session) return "none";
  try {
    const id = (session as { user?: { id?: unknown } }).user?.id;
    return (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].id === id) ?? "other";
  } catch { return "other"; }
}
async function boot(opts: { visibility?: "visible" | "hidden"; who?: Who; sdkAlone?: boolean; signIn?: boolean; page?: Tab; url?: string; store?: Map<string, string>; bigA?: boolean } = {}): Promise<Tab> {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", opts.url ?? SUPABASE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  if (opts.page) {
    cap.real = freshSsr();
    vi.resetModules();
  }
  const browser = installBrowser(opts.visibility ?? "hidden", opts.page?.browser.store ?? opts.store, opts.page?.browser.locks, opts.page?.browser.lineage);
  const sb = opts.page?.sb ?? standIn();
  vi.stubGlobal("fetch", sb.fetch);
  let client: Shared;
  let publication: Tab["publication"] = null;
  if (opts.sdkAlone) {
    // the comparison arm: the same installed SDK, cookie storage and stand-in, without the shared client's fetch
    const store = { get: (n: string) => (cap.real.parse(document.cookie) as Record<string, string>)[n],
      set: (n: string, v: string) => { document.cookie = cap.real.serialize(n, v, { path: "/", maxAge: 2_592_000 }) as string; },
      remove: (n: string) => { document.cookie = cap.real.serialize(n, "", { path: "/", maxAge: 0 }) as string; } };
    client = cap.real.createBrowserClient(SUPABASE, ANON, { cookies: store, isSingleton: false }) as unknown as Shared;
    cap.clients.push(client);
  } else {
    const lease = await import("@/utils/supabase/session-lease");
    lease.configureLineage({ jarView: () => ({ kind: "absent" }), store: browser.lineage }); // the browser's IndexedDB record
    const mod = await import("@/utils/supabase/client");
    publication = await import("@/utils/supabase/session-publication");
    client = mod.createClient() as unknown as Shared;
  }
  const events: string[] = [];
  const seen: Tab["seen"] = [];
  if (opts.page) {
    // a page that loads with a stored session: the SDK's start-up recovery may meet the outage; the caller drives it
    return { browser, sb, client, events, seen, unsubscribe: () => {}, publication };
  }
  await client.auth.initialize();
  await flush();
  const { data } = client.auth.onAuthStateChange((event, session) => { events.push(event); seen.push([event, whoOf(session)]); });
  await flush();
  if (opts.signIn ?? true) {
    const who = opts.who ?? "A";
    sb.st.bigA = !!opts.bigA;
    const signed = await signInAs({ client, publication }, who);
    await flush();
    expect(signed.error).toBeNull();
    if (opts.bigA) expect(browser.family().length >= 2 && browser.family().every((n) => n.startsWith(`${KEY}.`))).toBe(true); // numbered chunks only
    else expect(browser.family()).toEqual([KEY]);
  }
  return { browser, sb, client, events, seen, unsubscribe: () => data.subscription.unsubscribe(), publication };
}

/**
 * A sign-in in `tab`: through the browser's sign-in publication for a policy tab (the session is published into the
 * shared client by setSession, under the lease), through the installed SDK's own signInWithPassword for the SDK-alone
 * arm. The fake clock keeps running while it waits (the publication's own steps are timed). The outcome as an
 * SDK-shaped `{ error }`: null when signed in.
 */
async function signInAs(tab: Pick<Tab, "client" | "publication">, who: Who, password = PASSWORD): Promise<{ error: { outcome: string } | AuthError }> {
  if (tab.publication === null) return tab.client.auth.signInWithPassword({ email: GOLFERS[who].email, password });
  const pending = tab.publication.signInAndPublish(GOLFERS[who].email, password);
  let outcome: string | undefined;
  void pending.then((o) => { outcome = o; });
  for (let i = 0; i < 400 && outcome === undefined; i++) { await flush(4); if (outcome === undefined) await vi.advanceTimersByTimeAsync(5); }
  await flush();
  return { error: outcome === "signed_in" ? null : { outcome: outcome ?? "pending" } };
}

/** A session read that may sit through the SDK's retry backoff: the clock runs until it answers. */
async function readSession(tab: Tab, within = 30 * SECOND) {
  const p = tab.client.auth.getSession();
  let answer: Awaited<typeof p> | undefined;
  void p.then((r) => { answer = r; });
  for (let t = 0; t < within && answer === undefined; t += 100) await run(100);
  expect(answer).toBeDefined();
  return answer!;
}

let printed: string[] = [];
beforeEach(() => {
  vi.resetModules(); // a fresh shared-client module per test
  cap.real = freshSsr();
  cap.options = [];
  cap.clients = [];
  printed = [];
  for (const m of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      printed.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"], now: START });
  // A1: every session read and section now digests the jar's lineage (SubtleCrypto SHA-256). The platform's digest
  // completes on a worker thread, off the fake clock, which would move each request off the instant the R2 timelines
  // are pinned to; the same SHA-256 is served here from node:crypto as a microtask (identical output).
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    return new Uint8Array(createHash("sha256").update(view).digest()).buffer;
  });
});
afterEach(async () => {
  for (const c of (cap.clients as Shared[]).filter((x, i, all) => all.indexOf(x) === i)) {
    try { await c.auth.stopAutoRefresh(); } catch { /* teardown */ }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Nothing the stand-in wrote into a refusal, and no token value, reached the console or an SDK error. */
function noRawText(tab: Tab, ...errors: AuthError[]) {
  const secrets = tab.sb.st.live.flatMap((l) => [l.access, l.refresh]);
  const seen = [...printed, ...errors.map((e) => JSON.stringify(e ?? {})), ...errors.map((e) => e?.message ?? "")];
  expect(seen.filter((s) => s.includes(ORIGINAL))).toEqual([]);
  expect(seen.filter((s) => secrets.some((v) => s.includes(v)))).toEqual([]);
}

describe("AG-WEB-READY-02 — a transient refresh failure keeps the browser session", () => {
  for (const [label, answer] of [
    ["500", FAIL_500],
    ["429", () => json(429, { code: "over_request_rate_limit", msg: `synthetic rate limit ${ORIGINAL}` })],
  ] as const) {
    it(`a ${label} on refresh (the SDK alone would remove the session): the stored session stays, no SIGNED_OUT, the read reports an error (the Drill Hub says unavailable), and the SDK's whole retry loop sent exactly one real request`, async () => {
      const tab = await boot();
      tab.sb.st.refreshAnswer = answer;
      const T0 = Date.now();
      const hub = acquireDrillHubSession(() => tab.client as never); // the page's read, with its 10 s deadline
      let hubAnswer: unknown;
      void hub.then((r) => { hubAnswer = r; });
      await flush();
      await run(10 * SECOND);
      expect(hubAnswer).toEqual({ status: "unavailable" });
      const read = await readSession(tab); // joins the SDK's refresh, still backing off
      expect(read.data.session).toBeNull();
      expect(read.error?.name).toBe("AuthRetryableFetchError");
      expect(read.error?.status).toBe(503);
      await run(SECOND);
      expect(Date.now() - T0).toBeLessThan(FLOOR); // the whole 25.4 s retry loop ran inside the cooldown
      expect(tab.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, Number(label)]]);
      expect(tab.browser.family()).toEqual([KEY]);
      expect(tab.events).not.toContain("SIGNED_OUT");
      noRawText(tab, read.error);
      tab.unsubscribe();
    });
  }

  it("for comparison, the SDK alone removes the session after that same 500 at once (the defect this change removes)", async () => {
    const tab = await boot({ sdkAlone: true });
    tab.sb.st.refreshAnswer = FAIL_500;
    const read = await readSession(tab, 5 * SECOND);
    expect([read.error?.name, tab.browser.family(), tab.events.includes("SIGNED_OUT"), tab.sb.refreshes().length]).toEqual(["AuthApiError", [], true, 1]);
    tab.unsubscribe();
  });

  for (const status of [502, 503, 504, 520, 524, 530]) {
    it(`a ${status} without Retry-After (the SDK already retries it): its own retries in the first 8 s still go out, as with the SDK alone (0, 0.2, 0.6, 1.4, 3.0 and 6.2 s); then nothing until 30 s after the last; the session stays`, async () => {
      const tab = await boot();
      tab.sb.st.refreshAnswer = withRetryAfter(status, null);
      const T0 = Date.now();
      const read = await readSession(tab);
      expect(read.error?.name).toBe("AuthRetryableFetchError");
      const grace = [0, 200, 600, 1400, 3000, 6200];
      expect(tab.sb.refreshes().map((s) => s.at - T0)).toEqual(grace);
      await run(6200 + FLOOR - 1 - (Date.now() - T0));
      const probe = tab.client.auth.getSession(); // 1 ms before the cooldown from the last failure ends
      await flush();
      expect(tab.sb.refreshes()).toHaveLength(grace.length);
      await run(1);
      await run(30 * SECOND);
      await probe;
      expect(tab.sb.refreshes().map((s) => s.at - T0).slice(grace.length, grace.length + 1)[0]).toBeGreaterThanOrEqual(6200 + FLOOR);
      expect([tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual([[KEY], false]);
      noRawText(tab, read.error);
      tab.unsubscribe();
    });
  }

  it("an answer lost after Auth rotated the token (a 504 on the way back): the SDK's own retry 200 ms later presents the old token inside Auth's reuse interval and gets the session back, as with the SDK alone", async () => {
    for (const sdkAlone of [false, true]) {
      if (sdkAlone) { vi.unstubAllGlobals(); cap.real = freshSsr(); }
      const tab = await boot({ sdkAlone });
      const original = tab.sb.st.live.at(-1)!;
      tab.sb.st.loseAnswer = 504;
      const T0 = Date.now();
      const read = await readSession(tab, 5 * SECOND);
      expect({ sdkAlone, user: read.data.session?.user.id, at: tab.sb.refreshes().map((s) => [s.at - T0, s.status]) })
        .toEqual({ sdkAlone, user: GOLFERS.A.id, at: [[0, 504], [200, 200]] });
      expect(read.data.session?.refresh_token).toBe((original.child as { refresh_token: string }).refresh_token);
      expect(tab.events).not.toContain("SIGNED_OUT");
      tab.unsubscribe();
    }
  });

  it("a 500 lost after Auth rotated the token: the next real attempt, after the 30 s cooldown, is past the reuse interval and is refused, so the session ends (the SDK alone ends it at once on the 500)", async () => {
    const tab = await boot();
    tab.sb.st.loseAnswer = 500;
    const T0 = Date.now();
    await readSession(tab);
    await run(FLOOR - (Date.now() - T0));
    const read = await readSession(tab, 5 * SECOND);
    expect(tab.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 500], [FLOOR, 400]]);
    expect([read.error?.code, tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual(["refresh_token_already_used", [], true]);
    tab.unsubscribe();
  });

  it("a 429 during the 8 s of retries ends them: nothing more is sent until its own cooldown is over", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = (n) => (n === 1 ? withRetryAfter(503, null)() : withRetryAfter(429, "45")());
    const T0 = Date.now();
    await readSession(tab);
    await run(200 + 45 * SECOND - 1 - (Date.now() - T0));
    const probe = tab.client.auth.getSession();
    await flush();
    expect(tab.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 503], [200, 429]]);
    await run(30 * SECOND);
    await probe;
    expect(tab.sb.refreshes()[2].at - T0).toBeGreaterThanOrEqual(200 + 45 * SECOND);
    tab.unsubscribe();
  });

  it("Auth recovers: the first read after the cooldown refreshes the SAME golfer (one 200, TOKEN_REFRESHED, the stored session holds the new tokens), the Drill Hub is ready with the new access token, and no password was asked for", async () => {
    const tab = await boot();
    const original = tab.sb.st.live.at(-1)!;
    tab.sb.st.refreshAnswer = FAIL_500;
    const T0 = Date.now();
    await readSession(tab);
    await run(FLOOR - (Date.now() - T0)); // exactly at the end of the cooldown
    tab.sb.st.refreshAnswer = null; // Auth is back
    const ready = acquireDrillHubSession(() => tab.client as never);
    let result: Awaited<typeof ready> | undefined;
    void ready.then((r) => { result = r; });
    await run(SECOND);
    const issued = tab.sb.st.live.at(-1)!;
    expect(tab.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 500], [FLOOR, 200]]);
    expect(original.used).toBe(true); // the stored refresh token was the one presented, once, after recovery
    expect(issued.who).toBe("A");
    expect(result).toEqual({ status: "ready", session: { accessToken: issued.access, userId: GOLFERS.A.id } });
    expect(tab.events).toContain("TOKEN_REFRESHED");
    expect(tab.events).not.toContain("SIGNED_OUT");
    expect(tab.sb.st.sent.filter((s) => s.kind === "password")).toHaveLength(1); // the original sign-in only
    const stored = decodeURIComponent(tab.browser.store.get(KEY) ?? "");
    expect(stored.includes(issued.refresh) && !stored.includes(original.access)).toBe(true);
    noRawText(tab);
    tab.unsubscribe();
  });
});

// The cooldown each answer starts, from the moment its real request was answered (T0). Both sides of every boundary
// are probed on a fresh tab: a read 1 ms before the end is answered by the policy (nothing reaches Auth at that
// instant, and the first real request after T0 is at or after the end), and a read exactly at the end is sent.
const at = (ms: number) => new Date(START + ms);
const imf = (ms: number) => at(ms).toUTCString(); // IMF-fixdate, e.g. "Fri, 06 Nov 2026 08:51:00 GMT"
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
const month = (d: Date) => d.toUTCString().slice(8, 11);
const rfc850 = (ms: number, yy = at(ms).getUTCFullYear() % 100) => { const d = at(ms); return `${DAYS_LONG[d.getUTCDay()]}, ${two(d.getUTCDate())}-${month(d)}-${two(yy)} ${clock(d)} GMT`; };
const asctime = (ms: number) => { const d = at(ms); return `${d.toUTCString().slice(0, 3)} ${month(d)} ${String(d.getUTCDate()).padStart(2, " ")} ${clock(d)} ${d.getUTCFullYear()}`; };
const withRetryAfter = (status: number, value: string | null) => () =>
  json(status, { code: status === 429 ? "over_request_rate_limit" : "unexpected_failure", msg: `synthetic ${ORIGINAL}` }, value === null ? {} : { "retry-after": value });

const COOLDOWNS: { name: string; answer: () => Answer; cooldown: number }[] = [
  { name: "429 without Retry-After: the 30 s floor", answer: withRetryAfter(429, null), cooldown: FLOOR },
  { name: "500 without Retry-After: the 30 s floor", answer: withRetryAfter(500, null), cooldown: FLOOR },
  { name: "501 without Retry-After: the 30 s floor", answer: withRetryAfter(501, null), cooldown: FLOOR },
  { name: "503 Retry-After: 40 (a readable Retry-After: no 8 s of SDK retries) -> 40 s", answer: withRetryAfter(503, "40"), cooldown: 40 * SECOND },
  { name: "429 Retry-After: 0 -> the 30 s floor", answer: withRetryAfter(429, "0"), cooldown: FLOOR },
  { name: "429 Retry-After: 10 (below the floor) -> 30 s", answer: withRetryAfter(429, "10"), cooldown: FLOOR },
  { name: "429 Retry-After: 45 -> 45 s", answer: withRetryAfter(429, "45"), cooldown: 45 * SECOND },
  { name: "500 Retry-After: 50 -> 50 s", answer: withRetryAfter(500, "50"), cooldown: 50 * SECOND },
  { name: "429 Retry-After: 3600 (exactly the cap) -> 1 h", answer: withRetryAfter(429, "3600"), cooldown: CAP },
  { name: "429 Retry-After: 7200 (above the cap) -> 1 h", answer: withRetryAfter(429, "7200"), cooldown: CAP },
  { name: "429 Retry-After: an IMF-fixdate 120 s ahead -> 120 s", answer: () => withRetryAfter(429, imf(Date.now() - START + 120 * SECOND))(), cooldown: 120 * SECOND },
  { name: "503 Retry-After: an IMF-fixdate 31 s ahead -> 31 s", answer: () => withRetryAfter(503, imf(Date.now() - START + 31 * SECOND))(), cooldown: 31 * SECOND },
  { name: "503 Retry-After: an IMF-fixdate two days ahead -> the 1 h cap", answer: () => withRetryAfter(503, imf(Date.now() - START + 172_800 * SECOND))(), cooldown: CAP },
  { name: "429 Retry-After: an IMF-fixdate 60 s in the past -> the 30 s floor", answer: () => withRetryAfter(429, imf(Date.now() - START - 60 * SECOND))(), cooldown: FLOOR },
  { name: "429 Retry-After: an rfc850-date 90 s ahead -> 90 s", answer: () => withRetryAfter(429, rfc850(Date.now() - START + 90 * SECOND))(), cooldown: 90 * SECOND },
  { name: "429 Retry-After: an asctime-date 75 s ahead (single-digit day) -> 75 s", answer: () => withRetryAfter(429, asctime(Date.now() - START + 75 * SECOND))(), cooldown: 75 * SECOND },
  { name: "429 Retry-After: an rfc850-date with year 76 (2076, not more than 50 years ahead) -> the 1 h cap", answer: () => withRetryAfter(429, rfc850(Date.now() - START + 90 * SECOND, 76))(), cooldown: CAP },
  { name: "429 Retry-After: an rfc850-date with year 77 (1977: more than 50 years ahead means the past) -> the 30 s floor", answer: () => withRetryAfter(429, rfc850(Date.now() - START + 90 * SECOND, 77))(), cooldown: FLOOR },
  // each of these would give 45 s (or more) if it were wrongly read as a number or a date
  ...["45.5", "+45", "-45", "4 5", "45s", "1e3", "0x40", "soon", "", "Fri, 31 Nov 2026 08:52:00 GMT", "fri, 06 nov 2026 08:52:00 gmt", "Fri, 06 Nov 2026 08:52:00 UTC",
    "Fri, 06 Nov 2026 25:00:00 GMT", "Fri, 6 Nov 2026 08:52:00 GMT", "2026-11-06T08:52:00Z", "120, 120"].map((value) => (
    { name: `429 Retry-After: ${JSON.stringify(value)} (not a valid value) -> the 30 s floor`, answer: withRetryAfter(429, value), cooldown: FLOOR })),
];

/** One tab whose first real refresh request gets `answer` at T0; then a read at T0 + probeAt. */
async function probeCooldown(answer: () => Answer, probeAt: number) {
  const tab = await boot();
  tab.sb.st.refreshAnswer = (n) => (n === 1 ? answer() : FAIL_500());
  const T0 = Date.now();
  const first = tab.client.auth.getSession();
  await flush(); // attempt 0 reaches the stand-in at exactly T0
  await run(probeAt); // the SDK's own retry loop (local answers only) runs and ends on the way
  const firstRead = await first;
  const beforeProbe = tab.sb.refreshes().map((s) => s.at - T0);
  const probe = tab.client.auth.getSession(); // attempt 0 of a new refresh, at exactly T0 + probeAt
  await flush();
  const atProbe = tab.sb.refreshes().filter((s) => s.at - T0 === probeAt).length;
  await run(30 * SECOND); // let the probe's own retry loop finish (it may send once the cooldown is over)
  const probeRead = await probe;
  const later = tab.sb.refreshes().map((s) => s.at - T0).filter((t) => t > 0);
  return { tab, firstRead, probeRead, beforeProbe, atProbe, firstRealAfterT0: later[0] ?? null };
}

describe("AG-WEB-READY-02 — the cooldown honours Retry-After (delay-seconds and HTTP-date) between a 30 s floor and a 1 h cap", () => {
  for (const c of COOLDOWNS) {
    it(`${c.name}: a read at +${c.cooldown - 1} ms sends nothing; a read at +${c.cooldown} ms is sent`, async () => {
      const before = await probeCooldown(c.answer, c.cooldown - 1);
      expect(before.beforeProbe).toEqual([0]); // one real request, then only local answers until the probe
      expect(before.atProbe).toBe(0);
      expect(before.firstRealAfterT0).not.toBeNull();
      expect(before.firstRealAfterT0!).toBeGreaterThanOrEqual(c.cooldown); // the SDK's next retry, once the cooldown is over
      expect(before.firstRead.error?.name).toBe("AuthRetryableFetchError");
      expect(before.tab.browser.family()).toEqual([KEY]);
      expect(before.tab.events).not.toContain("SIGNED_OUT");
      noRawText(before.tab, before.firstRead.error, before.probeRead.error);
      before.tab.unsubscribe();
      vi.unstubAllGlobals();
      cap.real = freshSsr();
      vi.resetModules();
      const onTime = await probeCooldown(c.answer, c.cooldown);
      expect(onTime.beforeProbe).toEqual([0]);
      expect(onTime.atProbe).toBe(1);
      expect(onTime.tab.browser.family()).toEqual([KEY]);
      onTime.tab.unsubscribe();
    }, 60_000);
  }
});

describe("AG-WEB-READY-02 — real refresh traffic stays bounded through a long outage", () => {
  /** Ten minutes of an outage (500 or 503) on a visible tab (the SDK's 30 s ticker runs) with a page read every 5 s. */
  async function tenMinutes(sdkAlone: boolean, status: 500 | 503) {
    const tab = await boot({ visibility: "visible", sdkAlone });
    tab.sb.st.refreshAnswer = () => json(status, { code: "unexpected_failure", msg: `synthetic outage ${ORIGINAL}` });
    const T0 = Date.now();
    for (let t = 0; t < 600 * SECOND; t += 5 * SECOND) {
      void tab.client.auth.getSession();
      await run(5 * SECOND);
    }
    const times = tab.sb.refreshes().map((s) => s.at - T0);
    return { tab, T0, times, gaps: times.slice(1).map((t, i) => t - times[i]) };
  }

  it("a 10-minute 500 outage with the shared client: real refresh requests at least 30 s apart, so at most 21 over the 10 minutes from the first (0 s to 600 s inclusive), the session kept throughout; after Auth recovers the next real attempt refreshes golfer A", async () => {
    const r = await tenMinutes(false, 500);
    expect(r.times.length).toBeGreaterThanOrEqual(10); // it keeps trying, never gives up
    expect(r.times.every((t) => t >= 0 && t <= 600 * SECOND)).toBe(true);
    expect(r.times.length).toBeLessThanOrEqual(1 + (600 * SECOND) / FLOOR);
    expect(Math.min(...r.gaps)).toBeGreaterThanOrEqual(FLOOR);
    expect(r.tab.browser.family()).toEqual([KEY]);
    expect(r.tab.events).not.toContain("SIGNED_OUT");
    r.tab.sb.st.refreshAnswer = null; // Auth is back
    await run(2 * FLOOR + 5 * SECOND); // the ticker (and the SDK's retries) reach the first real attempt after the cooldown
    const ok = r.tab.sb.refreshes().filter((s) => s.status === 200);
    expect(ok).toHaveLength(1);
    expect(r.tab.sb.st.live.at(-1)!.who).toBe("A");
    expect(r.tab.events).toContain("TOKEN_REFRESHED");
    noRawText(r.tab);
    r.tab.unsubscribe();
  }, 60_000);

  it("a 10-minute 503 outage (a status the SDK alone retries, keeping the session): the shared client sends the SDK's six retries of the first 8 s, then one per 30 s at most (at most 6 + 20); the SDK alone sends more than three times as many", async () => {
    const policy = await tenMinutes(false, 503);
    const bounded = policy.times.length;
    expect(policy.times.slice(0, 6)).toEqual([0, 200, 600, 1400, 3000, 6200]);
    expect(Math.min(...policy.gaps.slice(5))).toBeGreaterThanOrEqual(FLOOR);
    expect(bounded).toBeLessThanOrEqual(6 + 20);
    expect([policy.tab.browser.family(), policy.tab.events.includes("SIGNED_OUT")]).toEqual([[KEY], false]);
    policy.tab.unsubscribe();
    await policy.tab.client.auth.stopAutoRefresh();
    await run(30 * SECOND); // its last retry loop ends against its own stand-in
    const alone = await tenMinutes(true, 503);
    expect(alone.times.length).toBeGreaterThan(3 * bounded);
    expect(Math.min(...alone.gaps)).toBeLessThan(SECOND);
    alone.tab.unsubscribe();
  }, 60_000);
});

// Every other 4xx keeps the SDK's own rejection path: the same status, the same error class and code, the session
// removed and SIGNED_OUT, just as the SDK alone does with the same answer; only the answer's own text is replaced.
const REJECTIONS: { name: string; answer: () => Answer; code: string | undefined; errorName: string; sameAsSdk: boolean }[] = [
  { name: "400 refresh_token_not_found (coded)", answer: () => json(400, { code: "refresh_token_not_found", msg: `Invalid Refresh Token ${ORIGINAL}` }), code: "refresh_token_not_found", errorName: "AuthApiError", sameAsSdk: true },
  { name: "400 with no code", answer: () => json(400, { msg: `synthetic uncoded refusal ${ORIGINAL}` }), code: undefined, errorName: "AuthApiError", sameAsSdk: true },
  { name: "400 with error_code only and no API version header", answer: () => ({ status: 400, body: JSON.stringify({ error_code: "refresh_token_already_used", msg: ORIGINAL }), headers: { "content-type": "application/json" } }), code: "refresh_token_already_used", errorName: "AuthApiError", sameAsSdk: true },
  { name: "400 with code and error_code under API version 2023-12-31 (auth-js takes error_code)", answer: () => json(400, { code: "ignored_code", error_code: "legacy_code", msg: ORIGINAL }, { "x-supabase-api-version": "2023-12-31" }), code: "legacy_code", errorName: "AuthApiError", sameAsSdk: true },
  { name: "401 bad_jwt", answer: () => json(401, { code: "bad_jwt", msg: `invalid JWT ${ORIGINAL}` }), code: "bad_jwt", errorName: "AuthApiError", sameAsSdk: true },
  { name: "403 session_not_found", answer: () => json(403, { code: "session_not_found", msg: `Session not found ${ORIGINAL}` }), code: undefined, errorName: "AuthSessionMissingError", sameAsSdk: true },
  { name: "404 with no body", answer: () => ({ status: 404 }), code: undefined, errorName: "AuthApiError", sameAsSdk: false }, // the SDK alone: AuthUnknownError
  { name: "400 with an HTML body", answer: () => ({ status: 400, body: `<html>${ORIGINAL}</html>`, headers: { "content-type": "text/html" } }), code: undefined, errorName: "AuthApiError", sameAsSdk: false }, // the SDK alone: AuthUnknownError
  { name: "400 whose body is over the 16 KB cap (its code is not read)", answer: () => json(400, { code: "refresh_token_not_found", msg: ORIGINAL, pad: "x".repeat(20_000) }), code: undefined, errorName: "AuthApiError", sameAsSdk: false },
];

describe("AG-WEB-READY-02 — genuine refresh rejections still end the session, exactly as the SDK does", () => {
  async function rejectOnce(answer: () => Answer, sdkAlone: boolean) {
    const tab = await boot({ sdkAlone });
    tab.sb.st.refreshAnswer = answer;
    const read = await readSession(tab, 10 * SECOND);
    await flush();
    return { tab, read, removed: tab.browser.family().length === 0, signedOut: tab.events.includes("SIGNED_OUT"), real: tab.sb.refreshes().length };
  }
  for (const c of REJECTIONS) {
    it(`${c.name}: one real request, the session removed, SIGNED_OUT, error ${c.errorName}${c.code ? ` (${c.code})` : ""}, none of the answer's text${c.sameAsSdk ? "; the same outcome as the SDK alone" : ""}`, async () => {
      const mine = await rejectOnce(c.answer, false);
      expect(mine.real).toBe(1);
      expect(mine.removed).toBe(true);
      expect(mine.signedOut).toBe(true);
      expect(mine.read.data.session).toBeNull();
      expect(mine.read.error?.name).toBe(c.errorName);
      expect(mine.read.error?.code).toBe(c.code);
      noRawText(mine.tab, mine.read.error);
      // no cooldown follows a rejection: a fresh sign-in's refresh goes out at once
      const again = await signInAs(mine.tab, "A");
      expect(again.error).toBeNull();
      mine.tab.sb.st.refreshAnswer = null;
      const fresh = await readSession(mine.tab, 5 * SECOND);
      expect(fresh.data.session?.user.id).toBe(GOLFERS.A.id);
      expect(mine.tab.sb.refreshes().map((s) => s.status)).toEqual([c.answer().status, 200]);
      mine.tab.unsubscribe();
      vi.unstubAllGlobals();
      cap.real = freshSsr();
      const sdk = await rejectOnce(c.answer, true);
      expect([sdk.real, sdk.removed, sdk.signedOut, sdk.read.data.session]).toEqual([1, true, true, null]);
      if (c.sameAsSdk) expect([sdk.read.error?.name, sdk.read.error?.status, sdk.read.error?.code]).toEqual([mine.read.error?.name, mine.read.error?.status, mine.read.error?.code]);
      sdk.tab.unsubscribe();
    }, 30_000);
  }

  it("a 400 whose body never finishes: the read is cut at 3 s and the session still ends (the SDK alone would wait on the body)", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = () => ({ status: 400, endless: true, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
    const T0 = Date.now();
    const p = tab.client.auth.getSession();
    let read: Awaited<typeof p> | undefined;
    void p.then((r) => { read = r; });
    await flush();
    await run(3 * SECOND - 1);
    expect(read).toBeUndefined();
    await run(1);
    expect(read?.error?.name).toBe("AuthApiError");
    expect(read?.error?.code).toBeUndefined();
    expect(Date.now() - T0).toBe(3 * SECOND);
    expect(tab.browser.family()).toEqual([]);
    expect(tab.events).toContain("SIGNED_OUT");
    expect(tab.sb.refreshes()).toHaveLength(1);
    noRawText(tab, read!.error);
    tab.unsubscribe();
  });
});

describe("AG-WEB-READY-02 — only this client's refresh request is touched", () => {
  it("sign-in answers (400, 429 and 500) are refusals of the sign-in only: they start no cooldown and are not held back by one (the sign-in itself goes through the publication's own client; the shared transport passes any sign-in grant through untouched)", async () => {
    const tab = await boot();
    const policyFetch = (cap.options[0]?.global as { fetch: typeof fetch }).fetch;
    const passwordUrl = `${SUPABASE}/auth/v1/token?grant_type=password`;
    tab.sb.st.passwordAnswer = json(429, { code: "over_request_rate_limit", msg: "synthetic sign-in rate limit" });
    const direct = await policyFetch(passwordUrl, { method: "POST", body: JSON.stringify({ email: GOLFERS.A.email, password: PASSWORD }) });
    expect([direct === tab.sb.st.lastResponse, direct.status]).toEqual([true, 429]); // untouched by the shared transport
    tab.sb.st.passwordAnswer = null;
    const wrong = await signInAs(tab, "A", "wrong-synthetic");
    expect(wrong.error).toEqual({ outcome: "refused" });
    tab.sb.st.passwordAnswer = json(429, { code: "over_request_rate_limit", msg: "synthetic sign-in rate limit" });
    expect((await signInAs(tab, "A")).error).toEqual({ outcome: "refused" });
    tab.sb.st.passwordAnswer = json(500, { code: "unexpected_failure", msg: "synthetic sign-in failure" });
    expect((await signInAs(tab, "A")).error).toEqual({ outcome: "refused" });
    tab.sb.st.passwordAnswer = null;
    // no cooldown from those: the stored (expiring) session's refresh goes out at once
    const read = await readSession(tab, 5 * SECOND);
    expect(read.data.session?.user.id).toBe(GOLFERS.A.id);
    expect(tab.sb.refreshes().map((s) => s.status)).toEqual([200]);
    // and during a refresh cooldown a sign-in is still sent: golfer B signs in, and the tab holds B's session only
    tab.sb.st.refreshAnswer = FAIL_500;
    tab.sb.st.expiresIn = 3600;
    await run(3600 * SECOND - 80 * SECOND); // A's refreshed session is now inside the 90 s margin
    await readSession(tab);
    const coolingSince = tab.sb.refreshes().at(-1)!.at;
    const b = await signInAs(tab, "B");
    expect(b.error).toBeNull();
    expect(Date.now() - coolingSince).toBeLessThan(FLOOR);
    const hub = acquireDrillHubSession(() => tab.client as never);
    await flush();
    expect(await hub).toEqual({ status: "ready", session: { accessToken: tab.sb.st.live.at(-1)!.access, userId: GOLFERS.B.id } });
    expect(tab.sb.st.sent.filter((s) => s.kind === "password").map((s) => s.status)).toEqual([200, 429, 400, 429, 500, 200]);
    tab.unsubscribe();
  });

  it("the client's other requests pass through untouched: a database read's 500 reaches the caller as a 500 and starts no cooldown", async () => {
    const tab = await boot();
    tab.sb.st.restAnswer = json(500, { code: "XX000", message: "synthetic database failure" });
    const first = await tab.client.from("drills").select("*"); // its token lookup refreshes the expiring session first
    expect([first.status, first.error?.message]).toEqual([500, "synthetic database failure"]);
    await run(3600 * SECOND - 80 * SECOND); // the refreshed session is inside the 90 s margin again
    const second = await tab.client.from("drills").select("*");
    expect(second.status).toBe(500);
    // the second refresh went out right after the first read's 500: no cooldown came from it
    const rest = tab.sb.st.sent.filter((s) => s.kind === "rest");
    expect(tab.sb.refreshes().map((s) => s.status)).toEqual([200, 200]);
    expect(tab.sb.refreshes()[1].at).toBe(rest[1].at);
    expect(rest.map((s) => s.status)).toEqual([500, 500]);
    tab.unsubscribe();
  });

  it("the fetch handed to the SDK: only POST <project>/auth/v1/token?grant_type=refresh_token is answered by the policy; other methods, paths, grants and projects get the real answer object itself, and a successful refresh answer is returned as received", async () => {
    await boot({ signIn: false });
    const policyFetch = (cap.options[0]?.global as { fetch?: typeof fetch } | undefined)?.fetch;
    expect(typeof policyFetch).toBe("function");
    const sb = standIn();
    vi.stubGlobal("fetch", sb.fetch);
    sb.st.refreshAnswer = FAIL_500; // every untouched request below gets a 500 too, so a rewrite would show
    sb.st.restAnswer = FAIL_500();
    const refreshUrl = `${SUPABASE}/auth/v1/token?grant_type=refresh_token`;
    const untouched: [string, RequestInfo | URL, RequestInit | undefined][] = [
      ["GET of the refresh URL", refreshUrl, { method: "GET" }],
      ["no method (GET)", refreshUrl, undefined],
      ["another project's refresh URL", `${OTHER_PROJECT}/auth/v1/token?grant_type=refresh_token`, { method: "POST" }],
      ["another path", `${SUPABASE}/auth/v1/tokens?grant_type=refresh_token`, { method: "POST" }],
      ["a REST path", `${SUPABASE}/rest/v1/token?grant_type=refresh_token`, { method: "POST" }],
      ["another grant", `${SUPABASE}/auth/v1/token?grant_type=pkce`, { method: "POST" }],
      ["no grant", `${SUPABASE}/auth/v1/token`, { method: "POST" }],
    ];
    for (const [what, input, init] of untouched) {
      const res = await policyFetch!(input, init);
      expect({ what, same: res === sb.st.lastResponse, status: res.status }).toEqual({ what, same: true, status: 500 });
    }
    // the refresh request itself, in each input form, is the policy's: one whose body does not carry the SDK's refresh
    // token is answered 503 here and never sent (AG-WEB-READY-03-R1: the token in the body is the request's origin)
    const r1 = await policyFetch!(refreshUrl, { method: "POST", body: "{}" });
    const r2 = await policyFetch!(new URL(refreshUrl), { method: "post", body: "{}" });
    const r3 = await policyFetch!(new Request(refreshUrl, { method: "POST", body: "{}" }));
    expect([r1.status, r2.status, r3.status, await r1.text(), await r3.text()]).toEqual([503, 503, 503, "", ""]);
    expect(sb.refreshes()).toHaveLength(0);
    // a token the browser does not hold (none here) is never sent either: the SDK is told the session is gone
    const notHeld = await policyFetch!(refreshUrl, { method: "POST", body: JSON.stringify({ refresh_token: "synthetic-not-stored" }) });
    expect([notHeld.status, ((await notHeld.json()) as { code?: string }).code, sb.refreshes().length]).toEqual([400, "session_not_found", 0]);
  });

  it("R16: the shared client's own signOut outside End Session (no app code calls it) sends its logout untouched but cannot remove the session (no end section) and announces nothing; End Session in the browser removes it", async () => {
    const tab = await boot();
    tab.sb.st.expiresIn = 3600;
    expect((await signInAs(tab, "A")).error).toBeNull();
    const out = await tab.client.auth.signOut({ scope: "local" });
    await flush();
    expect(out.error).toBeNull();
    expect(tab.sb.st.sent.filter((s) => s.kind === "logout").map((s) => s.status)).toEqual([204]);
    expect(tab.browser.family()).toEqual([KEY]); // the removal was skipped by the storage …
    expect(tab.events).not.toContain("SIGNED_OUT"); // … and its SIGNED_OUT dropped by the event fence
    let ended: string | undefined;
    void tab.publication!.endSessionInBrowser(GOLFERS.A.id).then((o) => { ended = o; });
    for (let i = 0; i < 100 && ended === undefined; i++) await run(50);
    expect([ended, tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual(["ended", [], true]);
    expect(tab.sb.refreshes()).toEqual([]);
    tab.unsubscribe();
  });

  for (const [what, url] of [["a trailing slash", `${SUPABASE}/`], ["surrounding spaces", `  ${SUPABASE}  `], ["an upper-case scheme", SUPABASE.replace("http", "HTTP")]] as const) {
    it(`a project URL written with ${what} still gets the policy: a 500 on refresh keeps the session`, async () => {
      const tab = await boot({ url });
      tab.sb.st.refreshAnswer = FAIL_500;
      await readSession(tab);
      expect([tab.sb.refreshes().length, tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual([1, [KEY], false]);
      tab.unsubscribe();
    });
  }

  it("without a browser (server-side import), two createClient() calls do not throw and each client has its own cooldown", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
    const sb = standIn();
    vi.stubGlobal("fetch", sb.fetch);
    const mod = await import("@/utils/supabase/client");
    expect(() => { mod.createClient(); mod.createClient(); }).not.toThrow();
    const [f1, f2] = cap.options.map((o) => (o.global as { fetch: typeof fetch }).fetch);
    expect(f1).not.toBe(f2);
    sb.st.refreshAnswer = FAIL_500;
    const refreshUrl = `${SUPABASE}/auth/v1/token?grant_type=refresh_token`;
    const body = JSON.stringify({ refresh_token: "synthetic-server-token" });
    const statuses = [(await f1(refreshUrl, { method: "POST", body })).status, (await f1(refreshUrl, { method: "POST", body })).status,
      (await f2(refreshUrl, { method: "POST", body })).status];
    // without a browser there is no jar to hold the token: nothing is ever sent (the server never refreshes a session)
    expect([statuses, sb.refreshes().length]).toEqual([[400, 400, 400], 0]);
  });
});

describe("AG-WEB-READY-02 — refusal bodies: bounded reads, both sides of each bound", () => {
  const sized = (bytes: number) => {
    const empty = JSON.stringify({ code: "refresh_token_not_found", msg: "" });
    return JSON.stringify({ code: "refresh_token_not_found", msg: "x".repeat(bytes - empty.length) });
  };
  const H = { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" };
  for (const [what, answer, code] of [
    ["a body of exactly 16384 bytes: its code is read", { status: 400, body: sized(16_384), headers: H }, "refresh_token_not_found"],
    ["a body of 16385 bytes: over the cap, no code", { status: 400, body: sized(16_385), headers: H }, undefined],
    ["a body that completes at 2999 ms: its code is read", { status: 400, body: sized(100), headers: H, bodyAfterMs: 2_999 }, "refresh_token_not_found"],
    ["a body that completes at 3001 ms: past the deadline, no code", { status: 400, body: sized(100), headers: H, bodyAfterMs: 3_001 }, undefined],
    ["a body that cannot be read at all (already locked)", { status: 400, body: sized(100), headers: H, lockedBody: true }, undefined],
    ["a code that is not in Auth's snake_case form (upper case, carrying the answer's text)", json(400, { code: `${ORIGINAL}-${"Y".repeat(40)}`, msg: ORIGINAL }), undefined],
    ["a 10 KB code", json(400, { code: "a".repeat(10_000), msg: ORIGINAL }), undefined],
  ] as [string, Answer, string | undefined][]) {
    it(`${what}: still a refusal (status 400, the session removed, SIGNED_OUT), never a kept session`, async () => {
      const tab = await boot();
      tab.sb.st.refreshAnswer = () => answer;
      const read = await readSession(tab, 10 * SECOND);
      expect([read.error?.name, read.error?.status, read.error?.code]).toEqual(["AuthApiError", 400, code]);
      expect([tab.browser.family(), tab.events.includes("SIGNED_OUT"), tab.sb.refreshes().length]).toEqual([[], true, 1]);
      noRawText(tab, read.error);
      tab.unsubscribe();
    });
  }
});

describe("AG-WEB-READY-02 — the golfer's lifecycle around a refresh outage", () => {
  it("a page that LOADS with an expiring stored session during a 500: the SDK's start-up recovery sends one real request; the session stays; the Drill Hub says unavailable within its 10 s; nothing more is sent before the cooldown ends", async () => {
    const before = await boot(); // signed in on an earlier page; the session is now inside the SDK's 90 s margin
    before.unsubscribe();
    await before.client.auth.stopAutoRefresh();
    before.sb.st.refreshAnswer = FAIL_500;
    const T0 = Date.now();
    const page = await boot({ page: before }); // the reload: a new SDK client reading the same cookie, starting up
    await flush();
    const hub = acquireDrillHubSession(() => page.client as never);
    let hubAnswer: unknown;
    void hub.then((r) => { hubAnswer = r; });
    await run(10 * SECOND);
    expect(hubAnswer).toEqual({ status: "unavailable" });
    await run(FLOOR - 1 - (Date.now() - T0));
    expect(page.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 500]]);
    expect(page.browser.family()).toEqual([KEY]);
    expect((await readSession(page, 31 * SECOND)).data.session).toBeNull(); // still failing after the cooldown: an error, not a session
    expect(page.browser.family()).toEqual([KEY]);
  });

  it("a page that loads with an expiring stored session the refresh then REFUSES (400): the session is removed at start-up, so the Drill Hub says signed out", async () => {
    const before = await boot();
    before.unsubscribe();
    await before.client.auth.stopAutoRefresh();
    before.sb.st.refreshAnswer = () => json(400, { code: "refresh_token_not_found", msg: ORIGINAL });
    const page = await boot({ page: before });
    await run(SECOND);
    expect(page.browser.family()).toEqual([]);
    const hub = acquireDrillHubSession(() => page.client as never);
    await run(SECOND);
    expect(await hub).toEqual({ status: "signed_out" });
    expect(page.sb.refreshes().map((s) => s.status)).toEqual([400]);
  });

  it("returning to the tab during a cooldown (the SDK's own visibilitychange recovery and its ticker): nothing is sent until the cooldown ends; then one real request per 30 s; no SIGNED_OUT", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = FAIL_500;
    const T0 = Date.now();
    await readSession(tab);
    tab.browser.showTab();
    await flush();
    await run(FLOOR - 1 - (Date.now() - T0));
    expect(tab.sb.refreshes().map((s) => s.at - T0)).toEqual([0]);
    await run(70 * SECOND);
    const times = tab.sb.refreshes().map((s) => s.at - T0);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times.slice(1).every((t, i) => t - times[i] >= FLOOR)).toBe(true);
    expect([tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual([[KEY], false]);
    tab.unsubscribe();
  });

  it("a transient 500, then a genuine refusal once the cooldown is over: the session ends at the first real attempt and the Drill Hub says signed out", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = (n) => (n === 1 ? FAIL_500() : json(400, { code: "refresh_token_not_found", msg: ORIGINAL }));
    const T0 = Date.now();
    await readSession(tab);
    await run(FLOOR - (Date.now() - T0));
    const read = await readSession(tab, 5 * SECOND);
    expect(tab.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 500], [FLOOR, 400]]);
    expect([read.error?.code, tab.browser.family(), tab.events.includes("SIGNED_OUT")]).toEqual(["refresh_token_not_found", [], true]);
    const hub = acquireDrillHubSession(() => tab.client as never);
    await run(SECOND);
    expect(await hub).toEqual({ status: "signed_out" });
    tab.unsubscribe();
  });

  it("a rejected fetch (a network failure, or an answer CORS withholds) passes through as before: the SDK retries it itself, eight real attempts per 25.4 s loop, exactly as the SDK alone; the session stays", async () => {
    const counts: number[][] = [];
    for (const sdkAlone of [false, true]) {
      if (sdkAlone) { vi.unstubAllGlobals(); cap.real = freshSsr(); }
      const tab = await boot({ sdkAlone });
      tab.sb.st.rejectRefresh = true;
      const T0 = Date.now();
      const read = await readSession(tab);
      expect([read.error?.name, tab.browser.family()]).toEqual(["AuthRetryableFetchError", [KEY]]);
      counts.push(tab.sb.refreshes().map((s) => s.at - T0));
      tab.unsubscribe();
    }
    expect(counts[0]).toEqual([0, 200, 600, 1400, 3000, 6200, 12600, 25400]);
    expect(counts[1]).toEqual(counts[0]);
  });

  for (const [what, jump] of [["forward 2 h", 2 * 3600 * SECOND], ["back 2 h", -2 * 3600 * SECOND]] as const) {
    it(`the cooldown runs on the monotonic clock: the wall clock jumping ${what} neither ends it early nor extends it`, async () => {
      const tab = await boot();
      tab.sb.st.refreshAnswer = FAIL_500;
      const T0 = performance.now();
      await readSession(tab);
      vi.setSystemTime(Date.now() + jump); // Date moves; performance.now() does not
      await run(FLOOR - 1 - (performance.now() - T0));
      const early = tab.client.auth.refreshSession();
      await flush();
      expect(tab.sb.refreshes()).toHaveLength(1);
      await run(30 * SECOND);
      await early;
      expect(tab.sb.refreshes().length).toBeGreaterThanOrEqual(2); // sent once the 30 s had passed on the monotonic clock
      tab.unsubscribe();
    });
  }

  it("a successful sign-in ends a cooldown: golfer B signs in during A's 1 h Retry-After cooldown, and B's own refresh later is sent at once", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = () => withRetryAfter(429, "3600")();
    await readSession(tab);
    tab.sb.st.refreshAnswer = null;
    await run(60 * SECOND);
    const b = await signInAs(tab, "B"); // B's session: 60 s, refreshed at once on read
    expect(b.error).toBeNull();
    const read = await readSession(tab, 5 * SECOND);
    expect(read.data.session?.user.id).toBe(GOLFERS.B.id);
    expect(tab.sb.refreshes().map((s) => s.status)).toEqual([429, 200]);
    tab.unsubscribe();
  });

  it("a failed sign-in (a wrong password) does not end a Retry-After cooldown: the refresh is still answered here until the server's wait is over", async () => {
    const tab = await boot();
    tab.sb.st.refreshAnswer = () => withRetryAfter(429, "120")();
    const T0 = Date.now();
    await readSession(tab);
    const wrong = await signInAs(tab, "A", "wrong-synthetic");
    expect(wrong.error).toEqual({ outcome: "refused" });
    tab.sb.st.refreshAnswer = null;
    await run(120 * SECOND - 1 - (Date.now() - T0));
    const early = tab.client.auth.getSession();
    await flush();
    expect(tab.sb.refreshes().map((s) => s.status)).toEqual([429]);
    await run(30 * SECOND);
    expect((await early).data.session?.user.id).toBe(GOLFERS.A.id);
    expect(tab.sb.refreshes().map((s) => s.status)).toEqual([429, 200]);
    tab.unsubscribe();
  });

  it("an outage that ended where this tab did not see it (another tab refreshed the shared cookie) is forgotten: a separate failure an hour later again gets the SDK's quick retries, so an answer lost after rotation recovers as with the SDK alone", async () => {
    const tab1 = await boot();
    tab1.sb.st.refreshAnswer = withRetryAfter(503, null);
    await readSession(tab1); // a 503 outage seen by tab 1 (its 8 s of retries, then a cooldown)
    tab1.sb.st.refreshAnswer = null; // Auth is back; another tab refreshes the shared session
    await run(40 * SECOND);
    const tab2 = await boot({ page: tab1 });
    await run(SECOND);
    expect(tab1.sb.refreshes().at(-1)?.status).toBe(200);
    await run(3600 * SECOND - 80 * SECOND); // tab 1 sent nothing since; the refreshed session is now inside the margin
    tab1.sb.st.loseAnswer = 504;
    const T1 = Date.now();
    const read = await readSession(tab1, 5 * SECOND);
    expect(tab1.sb.refreshes().filter((s) => s.at >= T1).map((s) => [s.at - T1, s.status])).toEqual([[0, 504], [200, 200]]);
    expect([read.data.session?.user.id, tab1.browser.family(), tab1.events.includes("SIGNED_OUT")]).toEqual([GOLFERS.A.id, [KEY], false]);
    tab1.unsubscribe();
    tab2.unsubscribe();
  });

  it("two tabs, one cooling down for golfer A: End Session elsewhere, then golfer B signs in in the other tab, then Auth recovers; the cooling tab never sends A's token again, B's session survives, and that tab's next read finds B (the hub: account changed)", async () => {
    const tab1 = await boot(); // A
    tab1.sb.st.refreshAnswer = FAIL_500;
    const T0 = Date.now();
    const loop = tab1.client.auth.getSession(); // the 500 at T0; tab 1's own retry loop now runs on local answers
    await flush();
    await run(5 * SECOND);
    // End Session (the server route): A's session ends at Auth and its cookie is removed by the response
    tab1.sb.st.live = tab1.sb.st.live.filter((l) => l.who !== "A");
    tab1.browser.store.delete(KEY);
    await run(5 * SECOND);
    tab1.sb.st.expiresIn = 3600;
    const tab2 = await boot({ page: tab1 });
    await run(SECOND);
    expect((await signInAs(tab2, "B")).error).toBeNull();
    tab1.sb.st.refreshAnswer = null; // Auth is back
    await run(60 * SECOND);
    await loop;
    expect(tab1.sb.refreshes().map((s) => [s.at - T0, s.status])).toEqual([[0, 500]]);
    const stored = decodeURIComponent(tab1.browser.store.get(KEY) ?? "");
    const bLive = tab1.sb.st.live.find((l) => l.who === "B")!;
    expect(stored.includes(bLive.refresh)).toBe(true);
    const seen = await acquireDrillHubSession(() => tab1.client as never);
    expect(seen.status === "ready" && seen.session.userId === GOLFERS.B.id).toBe(true);
    // had that tab shown A's drills, its hub would end as "account changed" (if it had shown none, it now loads B's)
    expect(drillHubIdentityEnd(GOLFERS.A.id, seen)).toBe("account_changed");
    tab1.unsubscribe();
  });

  it("FIXED (was RESIDUAL; AG-WEB-READY-03-R1): a refresh A's tab started before End Session, retried after golfer B signed in in another tab, is never sent for A (the browser holds B) and B's session is kept. The SDK alone (control) still sends it, is refused and removes B's session", async () => {
    const outcome: Record<string, unknown> = {};
    for (const sdkAlone of [false, true]) {
      if (sdkAlone) { vi.unstubAllGlobals(); cap.real = freshSsr(); vi.resetModules(); }
      const tab1 = await boot({ sdkAlone });
      tab1.sb.st.refreshAnswer = sdkAlone ? withRetryAfter(503, null) : FAIL_500;
      const T0 = Date.now();
      await readSession(tab1); // the first loop ends at about 25.4 s
      await run(26 * SECOND - (Date.now() - T0));
      const late = tab1.client.auth.getSession(); // a Try again at 26 s: a new loop with A's token
      await flush();
      await run(SECOND); // 27 s: End Session
      tab1.sb.st.live = tab1.sb.st.live.filter((l) => l.who !== "A");
      tab1.browser.store.delete(KEY);
      tab1.sb.st.expiresIn = 3600;
      const tab2 = await boot({ page: tab1, sdkAlone });
      expect((await signInAs(tab2, "B")).error).toBeNull();
      tab1.sb.st.refreshAnswer = null; // Auth is back at about 28 s
      await run(30 * SECOND);
      await late;
      outcome[sdkAlone ? "sdkAlone" : "policy"] = { last: tab1.sb.refreshes().at(-1)?.status, bSessionKept: tab1.browser.family().length > 0 };
      tab1.unsubscribe();
    }
    expect(outcome).toEqual({ policy: { last: 500, bSessionKept: true }, sdkAlone: { last: 400, bSessionKept: false } });
  });
});

// ── AG-WEB-READY-02 continuation (review finding 1): a refresh golfer A's tab started before End Session, answered 200
// after it. End Session during an Auth outage removes the browser's session cookie but cannot revoke A at Auth (auth-js
// signOut returns on a failed refresh of an expiring session before its logout call; otherwise the logout call itself
// fails), so a refresh loop the SDK started earlier, still
// holding A's refresh token, can reach a recovered Auth and be answered 200 with a new A session. Modelled honestly: only
// the cookie is removed; A's sessions stay live at the stand-in, which really rotates A's token and issues the new
// session (A#2). Coordination is the real one: auth-js 2.107 is lockless by default (its `lock` stays null unless the
// caller passes one, in browsers too; @supabase/ssr 0.3.0 passes none), so nothing holds golfer B's sign-in back while A's
// refresh is pending, in this tab or another. The fixture has no BroadcastChannel; in a browser that channel only relays
// events to other tabs' subscribers and never writes storage (the real-browser run covers it). What decides the outcome
// is auth-js's own commit guard in _callRefreshToken: it reads storage when the refresh starts and again after the
// answer, and discards the new tokens (AuthRefreshDiscardedError, 409: nothing saved, no event) when the stored session
// was cleared or replaced in between. The shared client's fetch passes the 200 through untouched. Every timeline below is
// attached to its test's result (task meta) with synthetic labels only.

// start: what starts the late loop. read = a session read (Try again); tabReturn = the SDK's tab-return recovery;
// initialSession = an onAuthStateChange subscriber's initial-session read (what started it in Chrome); ticker = the
// SDK's 30 s auto-refresh ticker (visible tab). For tabReturn and ticker a session read made just after joins the
// same loop, so its result is observed too. chunked: A's sessions are stored as numbered cookie chunks.
type LateCase = { sdkAlone: boolean; start: "read" | "tabReturn" | "initialSession" | "ticker"; b: "none" | "otherTab" | "sameTab"; endSession: boolean; inFlight: boolean; chunked?: boolean };
type Row = [number, Sent["kind"], number, string | null, string | null]; // [ms since T0, request, status, presented, issued]
type Settled = { ms: number; error: string | null; status: number | null; session: string };

/** The session the browser's cookie holds now, as the stand-in's label. Read by the test only; the client never decodes it. */
function holder(tab: Tab): string | null {
  const order = (n: string) => (n === KEY ? -1 : Number(n.slice(KEY.length + 1)));
  const names = tab.browser.family().sort((x, y) => order(x) - order(y));
  if (names.length === 0) return null;
  const text = decodeURIComponent(names.map((n) => tab.browser.store.get(n) ?? "").join(""));
  return tab.sb.st.live.find((l) => text.includes(l.refresh))?.label ?? "unknown";
}

/** A cookie store whose next read, once armed, returns what it holds and then loses the session cookie: a barrier that
 *  places End Session's cookie removal exactly after one particular storage read of the SDK. */
class BarrierStore extends Map<string, string> {
  armed = false;
  hits = 0;
  /** A1: End Session records "none" in the browser's lineage with its removal (set by lateRefresh) */
  onRemove: (() => void) | null = null;
  [Symbol.iterator](): MapIterator<[string, string]> {
    const snapshot = Array.from(super.entries());
    if (this.armed) {
      this.armed = false;
      this.hits++;
      for (const [n] of snapshot) if (n === KEY || n.startsWith(`${KEY}.`)) super.delete(n);
      this.onRemove?.();
    }
    return snapshot[Symbol.iterator]() as unknown as MapIterator<[string, string]>;
  }
}

async function lateRefresh(c: LateCase, barrier?: "atStart" | "afterAnswer") {
  const store = barrier ? new BarrierStore() : undefined;
  const tab = await boot({ sdkAlone: c.sdkAlone, store, visibility: c.start === "ticker" ? "visible" : "hidden", bigA: c.chunked });
  // A1: End Session (in another tab) records "none" in the browser's lineage together with its removal, as
  // utils/supabase/session-storage.ts does; the SDK-alone control has no lineage and ignores it
  if (store) store.onRemove = () => tab.browser.lineage.recordNow("none");
  const T0 = Date.now();
  const ms = () => Date.now() - T0;
  const sentMark = tab.sb.st.sent.length;
  const seenMark = tab.seen.length;
  const steps: { ms: number; step: string }[] = [];
  const say = (step: string) => steps.push({ ms: ms(), step });
  /** Moves the fake clock to `t` ms after T0 in 100 ms steps, settling promises after each, so answers land on time. */
  const to = async (t: number) => { while (ms() < t) await run(Math.min(100, t - ms())); };
  // The policy meets a 500: one real request, then its 30 s cooldown answers the SDK's own retries here; the late refresh
  // is a second loop started at 26 s, whose 32.2 s retry is the first after the cooldown (the review's timeline). The SDK
  // alone meets a 503, which it retries itself until 25.4 s; its 12.6 s retry is the late one. With the policy and the
  // ticker, the 500 carries Retry-After 45 s, so the ticker's 30 s round starts the second loop inside the cooldown and
  // its 55.4 s retry is the late one.
  const policyTicker = !c.sdkAlone && c.start === "ticker";
  const t = c.sdkAlone ? { start: 0, end: 7_000, b: 7_500, back: 8_000, late: 12_600, until: 40_000 }
    : policyTicker ? { start: 30_000, end: 37_000, b: 37_500, back: 38_000, late: 55_400, until: 90_000 }
      : { start: 26_000, end: 27_000, b: 27_500, back: 28_000, late: 32_200, until: 60_000 };
  tab.sb.st.refreshAnswer = c.sdkAlone ? withRetryAfter(503, null) : policyTicker ? withRetryAfter(500, "45") : FAIL_500;
  say(`Auth outage: refreshes are answered ${c.sdkAlone ? 503 : policyTicker ? "500 with Retry-After 45" : 500}`);
  if (!c.sdkAlone && !policyTicker) { await readSession(tab); say("A's first refresh loop has ended: after its one real 500, the cooldown answered every SDK retry locally"); }
  if (policyTicker) say("the SDK's ticker refreshes at once (its first round): one real 500, then its retries are answered locally");
  await to(t.start);
  const late: { settled?: Settled } = {};
  const settle = (r: Awaited<ReturnType<Shared["auth"]["getSession"]>>) => {
    late.settled = { ms: ms(), error: r.error?.name ?? null, status: r.error?.status ?? null, session: whoOf(r.data.session) };
  };
  const subscriptions: { unsubscribe(): void }[] = [];
  if (barrier === "atStart") store!.armed = true; // the SDK's session read that starts the loop is the last to see A's cookie
  if (c.start === "read") {
    void tab.client.auth.getSession().then(settle);
    say("A's tab reads its session (Try again): a refresh loop starts, holding A's refresh token");
  } else if (c.start === "tabReturn") {
    tab.browser.showTab();
    say("A's tab is shown again: the SDK's tab-return recovery starts a refresh loop, holding A's refresh token");
    await flush();
    void tab.client.auth.getSession().then(settle);
    say("a session read in A's tab joins that loop");
  } else if (c.start === "initialSession") {
    const { data } = tab.client.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") late.settled = { ms: ms(), error: null, status: null, session: whoOf(session) };
    });
    subscriptions.push(data.subscription);
    say("a component of A's page subscribes to auth events: the SDK's initial-session read starts a refresh loop, holding A's refresh token");
  } else {
    await to(t.start + 100);
    void tab.client.auth.getSession().then(settle);
    say(`the SDK's ticker round at ${t.start} ms started a refresh loop holding A's refresh token; a session read in A's tab joins it`);
  }
  await flush();
  if (barrier === "atStart") say("BARRIER: End Session's cookie removal lands right after the SDK's session read, before the loop's own storage snapshot");
  const endSession = () => {
    for (const n of tab.browser.family()) tab.browser.store.delete(n);
    tab.browser.lineage.recordNow("none"); // A1: End Session records its removal in the browser's lineage
    say("End Session during the outage: the browser's session cookie is removed; A is NOT revoked at Auth (its sessions stay live)");
  };
  const tabs: Tab[] = [];
  const bSignsIn = async () => {
    tab.sb.st.expiresIn = 3600;
    if (c.b === "otherTab") tabs.push(await boot({ page: tab, sdkAlone: c.sdkAlone }));
    const r = await signInAs(c.b === "otherTab" ? tabs[0] : tab, "B");
    expect(r.error).toBeNull();
    say(`golfer B signs in ${c.b === "otherTab" ? "in another tab" : "in this same tab"}; nothing holds it back (the client is lockless)`);
  };
  const back = () => { tab.sb.st.refreshAnswer = null; say(`Auth recovers${c.inFlight ? "; each granted answer's body now arrives 500 ms after its status" : ""}`); };
  if (c.inFlight) {
    tab.sb.st.grantBodyAfterMs = 500;
    await to(t.back); back();
    await to(t.late + 100); if (c.endSession) endSession();
    if (c.b !== "none") { await to(t.late + 200); await bSignsIn(); }
  } else {
    if (c.endSession) { await to(t.end); endSession(); }
    if (c.b !== "none") { await to(t.b); await bSignsIn(); }
    await to(t.back); back();
    if (barrier === "afterAnswer") {
      await to(t.late - 100);
      store!.armed = true; // the next storage read is the guard's own re-read after the late answer
      say("BARRIER: End Session's cookie removal lands right after the guard's re-read of storage, before the SDK saves");
    }
  }
  await to(t.until);
  const rows: Row[] = tab.sb.st.sent.slice(sentMark).filter((s) => s.kind === "refresh" || s.kind === "password")
    .map((s) => [s.at - T0, s.kind, s.status, s.presented ?? null, s.issued ?? null]);
  for (const r of rows) steps.push({ ms: r[0], step: `Auth gets a ${r[1]} request${r[3] ? ` presenting ${r[3]}` : ""}: ${r[2]}${r[4] ? `, issues ${r[4]}` : ""}` });
  const s = late.settled;
  if (s) steps.push({ ms: s.ms, step: c.start === "initialSession" ? `the subscriber's INITIAL_SESSION arrives with the session of ${s.session}`
    : `A's pending read settles: ${s.error ? `${s.error} (${s.status})` : `the session of ${s.session}`}` });
  const discardPrints = printed.filter((p) => p.startsWith("AuthRefreshDiscardedError")).length; // the SDK's own console.error (initial-session path only)
  for (const x of subscriptions) x.unsubscribe();
  const events = tab.seen.slice(seenMark);
  const next = await readSession(tab, 5 * SECOND);
  const hub = await acquireDrillHubSession(() => tab.client as never);
  steps.sort((x, y) => x.ms - y.ms);
  const outcome = {
    rows,
    settled: s ?? null,
    cookie: holder(tab),
    events,
    next: whoOf(next.data.session),
    hub: hub.status === "ready" ? `ready:${whoOf({ user: { id: hub.session.userId } })}` : hub.status,
    discardPrints,
  };
  steps.push({ ms: ms(), step: `after: the cookie holds ${outcome.cookie ?? "nothing"}; A's tab's events since T0 ${JSON.stringify(events)}; its next read: ${outcome.next}; the hub: ${outcome.hub}` });
  const aAtAuth = tab.sb.st.live.filter((l) => l.who === "A").map((l) => [l.label, l.used] as const);
  for (const x of tabs) x.unsubscribe();
  return { tab, steps, outcome, aAtAuth, hits: store?.hits ?? 0 };
}

const P500: Row = [0, "refresh", 500, "A#1", null];
const LATE_200: Row = [32_200, "refresh", 200, "A#1", "A#2"];
const DISCARDED = (msAt: number): Settled => ({ ms: msAt, error: "AuthRefreshDiscardedError", status: 409, session: "none" });
const SDK_503S: Row[] = [0, 200, 600, 1_400, 3_000, 6_200].map((at): Row => [at, "refresh", 503, "A#1", null]);
const SDK_LATE_200: Row = [12_600, "refresh", 200, "A#1", "A#2"];
type Want = { rows: Row[]; settled: Settled | null; cookie: string | null; events: Tab["seen"]; next: string; hub: string; discardPrints: number;
  /** A's sessions at Auth afterwards: [label, used]; default: A#1 rotated by the late refresh, A#2 issued and never presented */
  aAtAuth?: [string, boolean][] };
/** End Session only: A's late 200 discarded; the browser stays signed out. */
const ENDED = (rows: Row[], settled: Settled | null, x: Partial<Want> = {}): Want => ({ rows, settled, cookie: null, events: [], next: "none", hub: "signed_out", discardPrints: 0, ...x });
/** B signed in before A's late 200: discarded; B's session stays stored and A's tab's next read finds B. */
const B_KEPT = (rows: Row[], settled: Settled | null, x: Partial<Want> = {}): Want => ({ rows, settled, cookie: "B#1", events: [], next: "B", hub: "ready:B", discardPrints: 0, ...x });
/** Control (no End Session): the same late 200 is saved and announced; A recovers without a password. */
const PUBLISHED = (rows: Row[], msAt: number, x: Partial<Want> = {}): Want =>
  ({ rows, settled: { ms: msAt, error: null, status: null, session: "A" }, cookie: "A#2", events: [["TOKEN_REFRESHED", "A"]], next: "A", hub: "ready:A", discardPrints: 0, ...x });
const B_IN = (at: number): Row => [at, "password", 200, null, "B#1"];
// AG-WEB-READY-03-R1 (the policy arm): the transport reads the jar before it sends anything. Once End Session removed A's
// cookie (or another sign-in replaced it), A's late retry is never sent — A's refresh token is never presented again —
// and the SDK is answered with what the browser holds: a local session_not_found for an empty jar (its removal finds
// nothing, and the SIGNED_OUT it announces is delivered, because the browser really holds no session), or the stored
// session for B (the SDK's own guard then discards it, 409).
const LOCAL_MISSING = (msAt: number): Settled => ({ ms: msAt, error: "AuthSessionMissingError", status: 400, session: "none" });
const NEVER_SENT: [string, boolean][] = [["A#1", false]];
const OUT: Tab["seen"] = [["SIGNED_OUT", "none"]];
const TICK_500: Row = [0, "refresh", 500, "A#1", null];
const TICK_LATE_200: Row = [55_400, "refresh", 200, "A#1", "A#2"];
const POLICY = { sdkAlone: false, start: "read", b: "none", endSession: true, inFlight: false } as const;
const ALONE = { ...POLICY, sdkAlone: true } as const;
const LATE_CASES: { name: string; c: LateCase; want: Want }[] = [
  // the policy (the shared client), the review's 500 timeline
  { name: "(a) End Session only (no other account), A's Try again at 26 s: A's 32.2 s retry is never sent (the jar holds no session); the SDK is answered session_not_found, removes nothing, and its SIGNED_OUT is delivered; A's token is never presented again",
    c: POLICY, want: ENDED([P500], LOCAL_MISSING(32_200), { events: OUT, aAtAuth: NEVER_SENT }) },
  { name: "(a) the late loop started by the SDK's tab-return recovery at 26 s (a read joins it): never sent; the recovery's own second removal (S8) announces a second SIGNED_OUT, also true (the jar is empty)",
    c: { ...POLICY, start: "tabReturn" }, want: ENDED([P500], LOCAL_MISSING(32_200), { events: [...OUT, ...OUT], aAtAuth: NEVER_SENT }) },
  { name: "(a) the late loop started by an auth-event subscriber's initial-session read at 26 s (the start seen in Chrome): never sent; the subscriber gets INITIAL_SESSION with no session; nothing is printed",
    c: { ...POLICY, start: "initialSession" }, want: ENDED([P500], { ms: 32_200, error: null, status: null, session: "none" }, { events: OUT, aAtAuth: NEVER_SENT }) },
  { name: "(a) the late loop started by the SDK's 30 s ticker (visible tab; the first 500 carried Retry-After 45 s): End Session at 37 s; the 55.4 s retry is never sent",
    c: { ...POLICY, start: "ticker" }, want: ENDED([TICK_500], LOCAL_MISSING(55_400), { events: OUT, aAtAuth: NEVER_SENT }) },
  { name: "(a) A's sessions stored as numbered cookie chunks: End Session removed every chunk; the late retry is never sent; no chunk comes back",
    c: { ...POLICY, chunked: true }, want: ENDED([P500], LOCAL_MISSING(32_200), { events: OUT, aAtAuth: NEVER_SENT }) },
  { name: "(b) golfer B signs in in another tab at 27.5 s, before A's pending refresh settles: A's 32.2 s retry is never sent (the jar holds B); the SDK is handed B's stored session and its guard discards it (409); B stays; A's tab's next read finds B",
    c: { ...POLICY, b: "otherTab" }, want: B_KEPT([P500, B_IN(27_500)], DISCARDED(32_200), { aAtAuth: NEVER_SENT }) },
  { name: "(b) golfer B signs in in the same tab at 27.5 s: B's published sign-in ends this tab's cooldown, so A's pending loop retries at 29.0 s — never sent (the jar holds B), discarded (409); only B's SIGNED_IN; B stays",
    c: { ...POLICY, b: "sameTab" }, want: B_KEPT([P500, B_IN(27_500)], DISCARDED(29_000), { events: [["SIGNED_IN", "B"]], aAtAuth: NEVER_SENT }) },
  { name: "(b) ticker start, B signs in in another tab at 37.5 s: A's 55.4 s retry is never sent; discarded (409); B stays",
    c: { ...POLICY, start: "ticker", b: "otherTab" }, want: B_KEPT([TICK_500, B_IN(37_500)], DISCARDED(55_400), { aAtAuth: NEVER_SENT }) },
  { name: "in flight (a): End Session lands at 32.3 s, after Auth answered A's retry 200 (32.2 s) and before its body arrived (32.7 s): the jar is read again after the body, holds no session, so the answer is never handed to the SDK (A#2 is never stored); session_not_found; SIGNED_OUT (true)",
    c: { ...POLICY, inFlight: true }, want: ENDED([P500, LATE_200], LOCAL_MISSING(32_700), { events: OUT }) },
  { name: "in flight (b): End Session at 32.3 s and B's sign-in in another tab at 32.4 s while A's 200 is in flight: A's answer is never handed over (the jar is empty at 32.7 s: SIGNED_OUT, true then); B's publication waits for A's section and then stays",
    c: { ...POLICY, b: "otherTab", inFlight: true }, want: B_KEPT([P500, LATE_200, B_IN(32_400)], LOCAL_MISSING(32_700), { events: OUT }) },
  { name: "control, same golfer (no End Session), Try again start: the same late 200 IS saved and announced (TOKEN_REFRESHED for A); A recovers without a password",
    c: { ...POLICY, endSession: false }, want: PUBLISHED([P500, LATE_200], 32_200) },
  { name: "control, tab-return start: the late 200 IS saved and announced (so the tab-return case above is a discard, not an answer never processed)",
    c: { ...POLICY, start: "tabReturn", endSession: false }, want: PUBLISHED([P500, LATE_200], 32_200) },
  { name: "control, initial-session start: the subscriber gets INITIAL_SESSION with A's refreshed session; nothing is printed",
    c: { ...POLICY, start: "initialSession", endSession: false }, want: PUBLISHED([P500, LATE_200], 32_200) },
  { name: "control, chunked A: the late 200 IS saved as chunks and announced",
    c: { ...POLICY, chunked: true, endSession: false }, want: PUBLISHED([P500, LATE_200], 32_200) },
  // the SDK alone (no policy): a 503 outage it retries itself
  { name: "SDK alone (no policy; a 503 outage it retries itself), (a): End Session at 7 s, Auth back at 8 s, its 12.6 s retry is answered 200: the same guard discards it",
    c: ALONE, want: ENDED([...SDK_503S, SDK_LATE_200], DISCARDED(12_600)) },
  { name: "SDK alone, (a), the loop started by the SDK's ticker (visible tab; its first round at once; a read joins it): discarded",
    c: { ...ALONE, start: "ticker" }, want: ENDED([...SDK_503S, SDK_LATE_200], DISCARDED(12_600)) },
  { name: "SDK alone, (b): B signs in in another tab at 7.5 s: A's late 200 discarded; B stays",
    c: { ...ALONE, b: "otherTab" }, want: B_KEPT([...SDK_503S, B_IN(7_500), SDK_LATE_200], DISCARDED(12_600)) },
  { name: "SDK alone, (b): B signs in in the same tab at 7.5 s: A's late 200 discarded; only B's SIGNED_IN; B stays",
    c: { ...ALONE, b: "sameTab" }, want: B_KEPT([...SDK_503S, B_IN(7_500), SDK_LATE_200], DISCARDED(12_600), { events: [["SIGNED_IN", "B"]] }) },
  { name: "SDK alone, in flight (a): End Session at 12.7 s, after Auth's 200 (12.6 s) and before its body (13.1 s): discarded at 13.1 s",
    c: { ...ALONE, inFlight: true }, want: ENDED([...SDK_503S, SDK_LATE_200], DISCARDED(13_100)) },
  { name: "SDK alone, in flight (b): End Session at 12.7 s and B in another tab at 12.8 s while A's 200 is in flight: discarded at 13.1 s; B stays",
    c: { ...ALONE, b: "otherTab", inFlight: true }, want: B_KEPT([...SDK_503S, SDK_LATE_200, B_IN(12_800)], DISCARDED(13_100)) },
  { name: "SDK alone, control (no End Session): its late 200 is saved and announced",
    c: { ...ALONE, endSession: false }, want: PUBLISHED([...SDK_503S, SDK_LATE_200], 12_600) },
];

describe("AG-WEB-READY-02 continuation — a refresh A's tab started before End Session is answered 200 afterwards (A never revoked at Auth)", () => {
  for (const k of LATE_CASES) {
    it(k.name, async ({ task }) => {
      const { tab, steps, outcome, aAtAuth } = await lateRefresh(k.c);
      Object.assign(task.meta as Record<string, unknown>, { timeline: steps, outcome, aAtAuth });
      const { aAtAuth: wantAtAuth, ...want } = k.want;
      expect(outcome).toEqual(want);
      // A was never revoked at Auth: where the late refresh was sent, A#1 was rotated and A#2 issued, and no request ever
      // presented A#2 (in the End Session cases it reached no storage; in the controls it is the stored session); where
      // it was never sent (the policy after End Session or B's sign-in), A#1 was never presented again
      expect(aAtAuth).toEqual(wantAtAuth ?? [["A#1", true], ["A#2", false]]);
      // chunked control: the saved session really is numbered chunks (so the chunked End Session case is not vacuous)
      if (k.c.chunked && k.want.cookie === "A#2") expect(tab.browser.family().length >= 2 && tab.browser.family().every((n) => n.startsWith(`${KEY}.`))).toBe(true);
      noRawText(tab);
      tab.unsubscribe();
    });
  }

  for (const barrier of ["atStart", "afterAnswer"] as const) {
    it(`RESIDUAL of the SDK alone (control; inherited: its guard is two storage reads, not one atomic step), barrier ${barrier}: an End Session cookie removal forced in between ${barrier === "atStart" ? "the SDK's session read and the loop's own storage snapshot (the guard then has nothing to compare)" : "the guard's re-read and the SDK's save"} is not seen, and A's late 200 IS saved after End Session. This passes because it asserts that failure`, async ({ task }) => {
      const { tab, steps, outcome, aAtAuth, hits } = await lateRefresh({ ...ALONE, endSession: false }, barrier);
      Object.assign(task.meta as Record<string, unknown>, { timeline: steps, outcome, aAtAuth });
      expect(hits).toBe(1);
      expect(outcome).toEqual(PUBLISHED([...SDK_503S, SDK_LATE_200], 12_600));
      noRawText(tab);
      tab.unsubscribe();
    });
    it(`CLOSED for the policy (was RESIDUAL; AG-WEB-READY-03-R1), barrier ${barrier}: the same forced removal is seen at the transport's own read of the jar, before anything is sent; A's late retry is never sent and nothing is saved. (The storage's save is itself a synchronous compare-and-set against the jar at save time, so no placement of the removal can let a stale 200 be saved: lib/session-storage.test.ts)`, async ({ task }) => {
      const { tab, steps, outcome, aAtAuth, hits } = await lateRefresh({ ...POLICY, endSession: false }, barrier);
      Object.assign(task.meta as Record<string, unknown>, { timeline: steps, outcome, aAtAuth });
      expect(hits).toBe(1);
      // A1 (R1): every session read is verified against the recorded lineage. atStart: the forced removal (recorded
      // "none", as End Session records it) is seen by that verified read itself, so the read reports no session at once
      // (one 25 ms settle poll) — no loop starts and this tab has nothing to remove or announce. afterAnswer: seen at the
      // transport's own read as before, 25 ms later (the verified read's one settle poll). Either way nothing is sent
      // for A, nothing is saved, and A#1 is never presented again.
      expect(outcome).toEqual(
        barrier === "atStart"
          ? ENDED([P500], { ms: 26_025, error: null, status: null, session: "none" }, { events: [] })
          : ENDED([P500], LOCAL_MISSING(32_225), { events: OUT }),
      );
      expect(aAtAuth).toEqual(NEVER_SENT);
      noRawText(tab);
      tab.unsubscribe();
    });
  }
});

describe("AG-WEB-READY-02 — the factory keeps its cookie contract", () => {
  it("createClient hands the SDK the layout-managed session storage (no cookie adapter) plus the fetch, and creates one client per tab", async () => {
    const tab = await boot({ signIn: false });
    const mod = await import("@/utils/supabase/client");
    expect(mod.createClient()).toBe(tab.client); // one shared client per tab
    expect(Object.keys(cap.options[0]).sort()).toEqual(["auth", "global"]);
    expect(Object.keys(cap.options[0].auth as object)).toEqual(["storage"]);
    expect(Object.keys((cap.options[0].auth as { storage: object }).storage).sort()).toEqual(["getItem", "isServer", "removeItem", "setItem"]);
    expect(Object.keys(cap.options[0].global as object)).toEqual(["fetch"]);
    tab.unsubscribe();
  });
});
