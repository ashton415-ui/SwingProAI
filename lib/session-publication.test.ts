import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  acquireDrillHubSession,
  clientForDrillHubSession,
  drillHubIdentityEndFromEvent,
  drillHubSessionUserId,
} from "@/lib/drill-hub-session";
import { bindingAdmits, readSessionLayout, parseCookieHeader } from "@/utils/supabase/session-cookie-layout";
import type { LineageRecord, LineageStore } from "@/utils/supabase/session-lease";

// AG-WEB-READY-03-R1 — the multi-tab journey of the session-publication design, driven through the real installed
// @supabase/ssr 0.3.0 and supabase-js/auth-js 2.107.0. Every simulated TAB is its own module registry (fresh imports of
// utils/supabase/* and a fresh @supabase/ssr singleton), so each has its own SDK client, lease state and transport; the
// tabs share what a browser shares between tabs of one origin: one cookie jar (document.cookie, honouring Max-Age), one
// Web Locks manager (a FIFO shim with abort signals), the SDK's BroadcastChannel (a shim whose deliveries a test can
// hold, reorder or release per receiving tab), and one IndexedDB lineage record (an in-memory LineageStore with hooks).
// Auth, PostgREST and the logout endpoint are an in-memory stand-in reached through the stubbed platform fetch:
// synthetic golfers and tokens only; nothing leaves memory. The clock is fake (timers, Date, performance), and
// pending work is settled with real setImmediate turns, so every timeout below is exact.
//
// Every scenario asserts, as applicable: the jar (layout and whose session), the events each tab's subscribers
// received (which golfer each names), the Drill Hub's identity decision for a tab that shows a golfer, the golfer
// whose rows a browser-direct Drill Hub read returns, realtime's access token, the diagnostics counters, and Auth
// traffic per endpoint (at most 10 refresh and 3 logout requests per scenario).
//
// A1 additions: every session read outside a held section is verified against the recorded lineage (R1); the event
// fence decides against the newest lineage the tab has seen, after the announced digest and a fresh record read (R4);
// a missing or failing synchronization facility fails closed (R5); a writer outside the contract (a previous bundle's
// late complete write or removal) is never accepted by a new reader and is visible to the server through the binding
// cookie (R2). Forced schedules come with negative controls.

const requireFromHere = createRequire(import.meta.url);
type SsrModule = Record<string, (...a: unknown[]) => unknown>;
const cap = vi.hoisted(() => ({ real: null as unknown as Record<string, (...a: unknown[]) => unknown>, clients: [] as unknown[] }));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...a: unknown[]) => {
    const c = cap.real.createBrowserClient(...a);
    cap.clients.push(c);
    return c;
  },
  createServerClient: (...a: unknown[]) => cap.real.createServerClient(...a),
  createChunks: (...a: unknown[]) => cap.real.createChunks(...a),
  isBrowser: () => cap.real.isBrowser(),
  parse: (...a: unknown[]) => cap.real.parse(...a),
  serialize: (...a: unknown[]) => cap.real.serialize(...a),
  // the installed constant (checked against the real module below)
  DEFAULT_COOKIE_OPTIONS: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 * 1000 },
}));
function freshSsr(): SsrModule {
  const p = requireFromHere.resolve("@supabase/ssr");
  delete requireFromHere.cache[p];
  return requireFromHere(p) as SsrModule;
}

const SUPABASE = "http://127.0.0.1:54329";
const ANON = "synthetic-anon-key-not-a-secret";
const KEY = "sb-127-auth-token";
const PASSWORD = "synthetic-password-not-a-secret";
const GOLFERS = {
  A: { id: "00000000-0000-4000-8000-0000000000aa", email: "golfer-a@example.invalid" },
  B: { id: "00000000-0000-4000-8000-0000000000bb", email: "golfer-b@example.invalid" },
  C: { id: "00000000-0000-4000-8000-0000000000cc", email: "golfer-c@example.invalid" },
} as const;
type Who = keyof typeof GOLFERS;
const START = Date.UTC(2026, 10, 20, 9, 0, 0);
const SECOND = 1000;

// ─── Shared browser state ───────────────────────────────────────────────────────────────────────────────────────

let currentTab: string | null = null;
let timelineSink: string[] | null = null;

/** The cookie jar every tab shares; every write is logged with the layout it left (AM-X4). */
function cookieJar() {
  const store = new Map<string, string>();
  const writes: { name: string; removed: boolean; layout: string; who: string }[] = [];
  let staleView: string | null = null;
  const header = () => Array.from(store, ([n, v]) => `${n}=${v}`).join("; ");
  const layoutNow = () => {
    const l = readSessionLayout(parseCookieHeader(header()), KEY);
    return l.kind;
  };
  const whoNow = () => {
    const l = readSessionLayout(parseCookieHeader(header()), KEY);
    if (l.kind !== "present") return l.kind;
    try {
      const id = (JSON.parse(l.value) as { user?: { id?: string } }).user?.id;
      return (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].id === id) ?? "other";
    } catch {
      return "unparsable";
    }
  };
  const doc = {
    get cookie() {
      return staleView ?? header();
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = String(raw).split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith("max-age="));
      const removed = maxAge !== undefined && Number(maxAge.slice(8)) <= 0;
      if (removed) store.delete(name);
      else store.set(name, pair.slice(eq + 1).trim());
      if (name === KEY || name.startsWith(`${KEY}.`)) {
        writes.push({ name, removed, layout: layoutNow(), who: whoNow() });
        if (layoutNow() === "present") timelineSink?.push(`jar:${whoNow()}`);
      }
    },
    visibilityState: "hidden" as "hidden" | "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    doc,
    store,
    writes,
    family: () => Array.from(store.keys()).filter((n) => n === KEY || n.startsWith(`${KEY}.`)),
    who: whoNow,
    snapshot: () => header(),
    showView: (view: string) => {
      staleView = view;
    },
    thawView: () => {
      staleView = null;
    },
  };
}

/** navigator.locks for one origin: FIFO, exclusive/shared, abort signals honoured until granted; grants are tasks. */
function lockManager() {
  type Req = { id: number; owner: string; mode: string; callback: (l: unknown) => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const queue: Req[] = [];
  const holders: Req[] = [];
  const grants: string[] = [];
  let seq = 0;
  const grantable = (r: Req) => (r.mode === "shared" ? holders.every((h) => h.mode === "shared") : holders.length === 0);
  const pump = () => {
    while (queue.length > 0 && grantable(queue[0])) {
      const r = queue.shift()!;
      holders.push(r);
      grants.push(r.owner);
      setImmediate(() => {
        Promise.resolve()
          .then(() => r.callback({ name: "x", mode: r.mode }))
          .then(
            (v) => { holders.splice(holders.indexOf(r), 1); r.resolve(v); pump(); },
            (e) => { holders.splice(holders.indexOf(r), 1); r.reject(e); pump(); },
          );
      });
    }
  };
  const locks = {
    request(_name: string, options: { mode?: string; signal?: AbortSignal }, callback: (l: unknown) => unknown) {
      return new Promise((resolve, reject) => {
        const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
        if (options.signal?.aborted) return reject(abortError());
        const r: Req = { id: ++seq, owner: currentTab ?? "test", mode: options.mode ?? "exclusive", callback, resolve, reject };
        options.signal?.addEventListener("abort", () => {
          const at = queue.indexOf(r);
          if (at !== -1) {
            queue.splice(at, 1);
            reject(abortError());
          }
        }, { once: true });
        queue.push(r);
        pump();
      });
    },
  };
  return { locks, grants, holders, queue };
}

/** The SDK's BroadcastChannel between tabs; a test can hold the deliveries to a tab and release them in any order. */
function channelHub() {
  const open: Channel[] = [];
  const held: { target: Channel; data: unknown }[] = [];
  const holdFor = new Set<string>();
  class Channel {
    readonly owner = currentTab ?? "?";
    closed = false;
    listeners: ((e: { data: unknown }) => unknown)[] = [];
    constructor(readonly name: string) {
      open.push(this);
    }
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      for (const target of open) {
        if (target === this || target.name !== this.name || target.closed) continue;
        if (holdFor.has(target.owner)) held.push({ target, data: copy });
        else setImmediate(() => target.dispatch(copy));
      }
    }
    dispatch(data: unknown) {
      for (const l of this.listeners) void l({ data });
    }
    addEventListener(type: string, l: (e: { data: unknown }) => unknown) {
      if (type === "message") this.listeners.push(l);
    }
    removeEventListener() {}
    close() {
      this.closed = true;
    }
  }
  return {
    Channel,
    holdFor,
    held,
    /** Delivers the held messages for `owner` (oldest first, or newest first with `reverse`). */
    release(owner: string, reverse = false) {
      const mine = held.filter((h) => h.target.owner === owner);
      for (const h of mine) held.splice(held.indexOf(h), 1);
      for (const h of reverse ? mine.reverse() : mine) setImmediate(() => h.target.dispatch(h.data));
    },
    heldEvents: (owner: string) => held.filter((h) => h.target.owner === owner).map((h) => (h.data as { event: string }).event),
  };
}

/**
 * The IndexedDB lineage record, in memory, with hooks (hold a read or an append; fail). Operations run one at a time in
 * the order they were made, as IndexedDB runs transactions on one object store: a held append holds every later read and
 * append. An append whose signal aborts before it runs is dropped (an aborted transaction).
 */
function lineageRecord() {
  let record: LineageRecord | null = null;
  const hooks = { readGate: null as Promise<void> | null, appendGate: null as Promise<void> | null, fail: false, failAppend: false, failRead: false, appends: 0, abandoned: 0 };
  // IndexedDB scheduling on one object store: a read-write transaction starts after every earlier transaction has
  // finished; a read-only one waits only for earlier read-write ones.
  let writes: Promise<unknown> = Promise.resolve();
  let everything: Promise<unknown> = Promise.resolve();
  const asRead = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = writes.then(work, work);
    everything = Promise.all([everything, run.catch(() => undefined)]);
    return run;
  };
  const asWrite = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = everything.then(work, work);
    writes = run.catch(() => undefined);
    everything = writes;
    return run;
  };
  const store: LineageStore = {
    read() {
      return asRead(async () => {
        if (hooks.readGate) await hooks.readGate;
        if (hooks.fail || hooks.failRead) throw new Error("synthetic lineage failure");
        return record === null ? null : { seq: record.seq, history: [...record.history] };
      });
    },
    append(digest: string, signal?: AbortSignal) {
      return asWrite(async () => {
        if (hooks.appendGate) await hooks.appendGate;
        if (signal?.aborted) {
          hooks.abandoned += 1;
          throw new Error("aborted");
        }
        if (hooks.fail || hooks.failAppend) throw new Error("synthetic lineage failure");
        const history = record?.history ?? [];
        if (history[history.length - 1] === digest) return;
        hooks.appends += 1;
        record = { seq: (record?.seq ?? 0) + 1, history: [...history, digest].slice(-8) };
      });
    },
  };
  return { store, hooks, current: () => record };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// ─── Auth / PostgREST stand-in ──────────────────────────────────────────────────────────────────────────────────

type Kind = "refresh" | "password" | "user" | "logout" | "rest" | "other";
type Sent = { kind: Kind; at: number; status: number; presented?: string; issued?: string; bearer?: string };
type Answer = { status: number; body?: string; bodyAfterMs?: number; endless?: boolean };
const json = (status: number, body: unknown): Answer => ({ status, body: JSON.stringify(body) });

function standIn() {
  type Issued = { who: Who; sid: string; label: string; access: string; refresh: string; used: boolean; usedAt?: number; child?: Record<string, unknown> };
  const st = {
    expiresIn: 3600,
    skew: false, // issue tokens already expired by the device clock (a device clock ahead of Auth's)
    big: new Set<Who>(), // these golfers' sessions are large enough to be stored as numbered chunks
    reuseIntervalMs: 10_000,
    issued: [] as Issued[],
    revoked: new Set<string>(),
    issuedCount: { A: 0, B: 0, C: 0 } as Record<Who, number>,
    sent: [] as Sent[],
    /** a gate held before answering a request of this kind (the request has reached Auth) */
    gate: {} as Partial<Record<Kind, Promise<void>>>,
    refreshAnswer: null as null | ((presented: Issued | undefined) => Answer | null),
    logoutAnswer: null as null | Answer,
    userAnswer: null as null | Answer,
  };
  function issue(who: Who, sid: string = randomUUID()) {
    const now = Math.floor(Date.now() / SECOND);
    const exp = st.skew ? now - 120 : now + st.expiresIn;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const access = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: GOLFERS[who].id, exp, role: "authenticated", session_id: sid })}.${randomBytes(24).toString("base64url")}`;
    const refresh = randomBytes(12).toString("base64url");
    st.issued.push({ who, sid, label: `${who}#${++st.issuedCount[who]}`, access, refresh, used: false });
    return {
      access_token: access, token_type: "bearer", expires_in: exp - now, expires_at: exp, refresh_token: refresh,
      user: { id: GOLFERS[who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[who].email, app_metadata: {},
        user_metadata: st.big.has(who) ? { synthetic_padding: "p".repeat(6000) } : {}, created_at: "2026-01-01T00:00:00Z" },
    };
  }
  const byAccess = (bearer: string | undefined) => st.issued.find((i) => `Bearer ${i.access}` === bearer);
  function toResponse(a: Answer): Response {
    if (a.endless) {
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"access_token":')); } });
      return new Response(stream, { status: a.status, headers: { "content-type": "application/json" } });
    }
    if (a.bodyAfterMs !== undefined) {
      const bytes = new TextEncoder().encode(a.body ?? "");
      const stream = new ReadableStream<Uint8Array>({ start(c) { setTimeout(() => { try { c.enqueue(bytes); c.close(); } catch { /* reader gone */ } }, a.bodyAfterMs); } });
      return new Response(stream, { status: a.status, headers: { "content-type": "application/json" } });
    }
    return new Response(a.body ?? null, { status: a.status, headers: a.body ? { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } : {} });
  }
  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== SUPABASE) throw new TypeError("stand-in: outside the synthetic origin");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization") ?? undefined;
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? (JSON.parse(init.body) as Record<string, string>) : {};
    const grant = url.searchParams.get("grant_type");
    let kind: Kind = "other";
    if (method === "POST" && url.pathname === "/auth/v1/token" && grant === "refresh_token") kind = "refresh";
    else if (method === "POST" && url.pathname === "/auth/v1/token" && grant === "password") kind = "password";
    else if (method === "GET" && url.pathname === "/auth/v1/user") kind = "user";
    else if (method === "POST" && url.pathname === "/auth/v1/logout") kind = "logout";
    else if (url.pathname.startsWith("/rest/v1/")) kind = "rest";
    const gate = st.gate[kind];
    if (gate) await gate;
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    let a: Answer;
    let presented: string | undefined;
    let issued: string | undefined;
    if (kind === "refresh") {
      const live = st.issued.find((l) => l.refresh === body.refresh_token);
      presented = live?.label ?? "unknown";
      const override = st.refreshAnswer?.(live) ?? null;
      if (override) a = override;
      else if (!live || st.revoked.has(live.sid)) a = json(400, { code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      else if (!live.used) {
        live.used = true;
        live.usedAt = Date.now();
        live.child = issue(live.who, live.sid);
        issued = st.issued[st.issued.length - 1].label;
        a = json(200, live.child);
      } else if (live.child && Date.now() - (live.usedAt ?? 0) <= st.reuseIntervalMs) a = json(200, live.child);
      else a = json(400, { code: "refresh_token_already_used", msg: "Already Used" });
    } else if (kind === "password") {
      const who = (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].email === body.email);
      if (who && body.password === PASSWORD) {
        a = json(200, issue(who));
        issued = st.issued[st.issued.length - 1].label;
      } else a = json(400, { code: "invalid_credentials", msg: "Invalid login credentials" });
    } else if (kind === "user") {
      const live = byAccess(bearer);
      a = st.userAnswer ?? (live && !st.revoked.has(live.sid)
        ? json(200, { id: GOLFERS[live.who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[live.who].email, app_metadata: {}, user_metadata: st.big.has(live.who) ? { synthetic_padding: "p".repeat(6000) } : {}, created_at: "2026-01-01T00:00:00Z" })
        : json(403, { code: "session_not_found", msg: "Session not found" }));
      presented = live?.label;
    } else if (kind === "logout") {
      const live = byAccess(bearer);
      presented = live?.label;
      if (st.logoutAnswer) a = st.logoutAnswer;
      else if (live && !st.revoked.has(live.sid)) {
        st.revoked.add(live.sid);
        a = { status: 204 };
      } else a = json(403, { code: "session_not_found", msg: "Session not found" });
    } else if (kind === "rest") {
      const live = byAccess(bearer);
      const owner = live && !st.revoked.has(live.sid) ? live.who : null;
      a = json(200, owner === null ? [] : [{ drill_id: `drill-of-${owner}`, status: "verified", latest_ai_feedback: null, owner }]);
    } else a = json(404, { msg: "not served" });
    st.sent.push({ kind, at: Date.now(), status: a.status, ...(presented ? { presented } : {}), ...(issued ? { issued } : {}), ...(bearer ? { bearer: byAccess(bearer)?.label ?? "anon" } : {}) });
    return toResponse(a);
  }
  const count = (kind: Kind) => st.sent.filter((s) => s.kind === kind).length;
  const latest = (who: Who) => [...st.issued].reverse().find((i) => i.who === who)!;
  return { st, fetch: fetchFn, count, latest };
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────────────────────────────────────

type ClientMod = typeof import("@/utils/supabase/client");
type Shared = ReturnType<ClientMod["createClient"]>;
interface Tab {
  readonly name: string;
  readonly client: () => Shared;
  readonly lease: typeof import("@/utils/supabase/session-lease");
  readonly storage: typeof import("@/utils/supabase/session-storage");
  readonly publication: typeof import("@/utils/supabase/session-publication");
  /** every event this tab's subscriber received, with whose session it carried */
  readonly events: [string, string][];
  /** the Drill Hub's identity decisions for a hub showing `shown` (set by the test) */
  readonly hub: { shown: string | null; ends: string[] };
}

let env: ReturnType<typeof setupEnv>;
function setupEnv() {
  const jar = cookieJar();
  const lockMgr = lockManager();
  const channels = channelHub();
  const lineage = lineageRecord();
  const auth = standIn();
  const win = {
    document: jar.doc,
    location: { href: "http://127.0.0.1:3941/drills", origin: "http://127.0.0.1:3941", protocol: "http:", host: "127.0.0.1:3941", hostname: "127.0.0.1", port: "3941", pathname: "/drills", search: "", hash: "", assign() {}, replace() {}, reload() {} },
    history: { state: null, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", jar.doc);
  vi.stubGlobal("location", win.location);
  vi.stubGlobal("navigator", { locks: lockMgr.locks, userAgent: "synthetic" });
  vi.stubGlobal("BroadcastChannel", channels.Channel);
  vi.stubGlobal("fetch", auth.fetch);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  return { jar, lockMgr, channels, lineage, auth, tabs: [] as Tab[], timeline: [] as string[] };
}

function whoOf(session: unknown): string {
  const id = drillHubSessionUserId(session);
  if (id === null) return session ? "other" : "none";
  return (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].id === id) ?? "other";
}

async function openTab(name: string): Promise<Tab> {
  cap.real = freshSsr();
  vi.resetModules();
  currentTab = name;
  const lease = await import("@/utils/supabase/session-lease");
  lease.configureLineage({ jarView: () => ({ kind: "absent" }), store: env.lineage.store });
  const storage = await import("@/utils/supabase/session-storage");
  const clientMod = await import("@/utils/supabase/client");
  const publication = await import("@/utils/supabase/session-publication");
  const c = clientMod.createClient();
  currentTab = null;
  await drive(c.auth.initialize());
  const events: [string, string][] = [];
  const hub = { shown: null as string | null, ends: [] as string[] };
  c.auth.onAuthStateChange((event, session) => {
    events.push([event, whoOf(session)]);
    env.timeline.push(`${name}:${event}:${whoOf(session)}`);
    const end = drillHubIdentityEndFromEvent(hub.shown, event, session);
    if (end !== null) hub.ends.push(end);
  });
  await flush();
  const tab: Tab = { name, client: () => clientMod.createClient(), lease, storage, publication, events, hub };
  env.tabs.push(tab);
  return tab;
}

/** Real macrotask turns (setImmediate is not faked): promise chains, digests and channel deliveries settle. */
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r)); };
/** Runs fake time forward until `p` settles (or `maxMs`), flushing between steps. */
async function drive<T>(p: Promise<T>, maxMs = 60_000, stepMs = 25): Promise<T> {
  let state: "pending" | "ok" | "err" = "pending";
  let value: T | undefined;
  let error: unknown;
  p.then((v) => { state = "ok"; value = v; }, (e) => { state = "err"; error = e; });
  for (let t = 0; state === "pending" && t <= maxMs; t += stepMs) {
    await flush(4);
    if (state !== "pending") break;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  await flush();
  if (state === "pending") throw new Error(`did not settle within ${maxMs} ms`);
  if (state === "err") throw error;
  return value as T;
}
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 25) { await vi.advanceTimersByTimeAsync(25); await flush(4); } await flush(); };

async function signIn(tab: Tab, who: Who) {
  return drive(tab.publication.signInAndPublish(GOLFERS[who].email, PASSWORD));
}
/** Golfer A signed in, with the session about to need a refresh (inside the SDK's 90 s margin) when `expiring`. */
async function signedIn(who: Who, tab: Tab, opts: { expiring?: boolean } = {}) {
  env.auth.st.expiresIn = opts.expiring ? 60 : 3600;
  expect(await signIn(tab, who)).toBe("signed_in");
  env.auth.st.expiresIn = 3600;
  expect(env.jar.who()).toBe(who);
}
/** A browser-direct Drill Hub read in `tab`: whose session the hub acquires, and whose rows its read returns. */
async function hubRead(tab: Tab) {
  const acquired = await drive(acquireDrillHubSession(() => tab.client() as never));
  if (acquired.status !== "ready") return { acquired: acquired.status, rows: [] as string[] };
  const db = clientForDrillHubSession(acquired.session, SUPABASE, ANON);
  const { data } = await drive(Promise.resolve(db.from("user_drills").select("drill_id, status, latest_ai_feedback")));
  const who = (Object.keys(GOLFERS) as Who[]).find((w) => GOLFERS[w].id === acquired.session.userId) ?? "other";
  return { acquired: who, rows: ((data as { owner: string }[] | null) ?? []).map((r) => r.owner) };
}
const realtimeToken = (tab: Tab) => (tab.client() as unknown as { realtime: { accessTokenValue: string | null } }).realtime.accessTokenValue;
const diag = (tab: Tab) => tab.storage.sessionDiagnostics();
const trafficWithinCaps = () => {
  expect(env.auth.count("refresh")).toBeLessThanOrEqual(10);
  expect(env.auth.count("logout")).toBeLessThanOrEqual(3);
};

/**
 * SHA-256 from node:crypto, served as a microtask (A1: every read and section digests the jar's lineage; the platform's
 * SubtleCrypto completes on a worker thread, off the fake clock, which would make the timings below depend on host
 * speed). Identical output to SubtleCrypto's SHA-256.
 */
async function onClockDigest(_algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
  return new Uint8Array(createHash("sha256").update(view).digest()).buffer;
}

beforeEach(() => {
  cap.real = freshSsr();
  cap.clients = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"], now: START });
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(onClockDigest);
  for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  env = setupEnv();
  timelineSink = env.timeline;
});
afterEach(async () => {
  for (const c of cap.clients as { auth: { stopAutoRefresh(): Promise<void> } }[]) {
    try { await c.auth.stopAutoRefresh(); } catch { /* teardown */ }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("harness identity", () => {
  it("the stand-in DEFAULT_COOKIE_OPTIONS equals the installed @supabase/ssr constant", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@supabase/ssr");
    expect(actual.DEFAULT_COOKIE_OPTIONS).toEqual({ path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 * 1000 });
  });
});

describe("sign-in publication (normal, clock-skew, delayed, interrupted, concurrent)", () => {
  it("normal: B's sign-in publishes B in one ordered write, announces SIGNED_IN to every tab at once, ends a continuously visible tab's view of A, and reads only B's rows", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    z.hub.shown = GOLFERS.A.id;
    expect((await hubRead(z)).rows).toEqual(["A"]);
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    await flush();
    expect(env.jar.who()).toBe("B");
    expect(z.hub.ends).toEqual(["account_changed"]); // without any visibility change
    // every SIGNED_IN names the session stored at that moment: A (its sign-in, and Y's start-up finding it), then B
    expect(x.events.filter(([e]) => e === "SIGNED_IN").map(([, w]) => w).filter((w, i, all) => all[i - 1] !== w)).toEqual(["A", "B"]);
    expect(await hubRead(y)).toEqual({ acquired: "B", rows: ["B"] });
    expect(realtimeToken(z)).toBe(env.auth.latest("B").access);
    expect(env.jar.writes.filter((w) => w.layout === "absent" && !w.removed)).toEqual([]);
    trafficWithinCaps();
  });

  it("clock skew (F4): a session the device clock already sees as expired is stored as Auth returned it AND announced, so a continuously visible tab showing A ends at once", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    z.hub.shown = GOLFERS.A.id;
    env.auth.st.skew = true;
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.auth.st.skew = false;
    await flush();
    expect(env.jar.who()).toBe("B");
    expect(z.hub.ends).toEqual(["account_changed"]);
    expect(z.events.at(-1)).toEqual(["SIGNED_IN", "B"]);
    expect(diag(y).announcedPublications).toBe(1);
    expect(env.auth.count("user")).toBe(1); // only A's normal publication validated with GET /user
    // nothing refreshed the new token before it was published: the first refresh presenting B#1 (the device clock says it
    // expired, so a later read may refresh it) is a fresh rotation, never a reuse of a token something else already used
    const firstB = env.auth.st.sent.find((s) => s.kind === "refresh" && s.presented === "B#1");
    expect(firstB === undefined || (firstB.status === 200 && firstB.issued === "B#2")).toBe(true);
  });

  it("a new session inside the SDK's 90 s refresh margin is never refreshed by the scratch sign-in client before it is published (its refresh token reaches the browser unused)", async () => {
    const y = await openTab("Y");
    env.auth.st.expiresIn = 60;
    expect(await signIn(y, "B")).toBe("signed_in");
    env.auth.st.expiresIn = 3600;
    await advance(SECOND);
    expect(env.auth.st.sent.filter((s) => s.kind === "refresh")).toEqual([]);
    expect(env.auth.st.issued.find((i) => i.label === "B#1")?.used).toBe(false);
    const read = await drive(y.client().auth.getSession()); // the shared client's own refresh: a fresh rotation
    expect(whoOf(read.data.session)).toBe("B");
    expect(env.auth.st.sent.filter((s) => s.kind === "refresh").map((s) => [s.presented, s.status, s.issued])).toEqual([["B#1", 200, "B#2"]]);
  });

  it("delayed setSession validation past its 15 s deadline: interrupted; the late validation can never publish (no permit), the jar keeps A, no SIGNED_IN for B anywhere", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    const hold = deferred();
    env.auth.st.gate.user = hold.promise;
    expect(await signIn(y, "B")).toBe("interrupted");
    hold.resolve();
    delete env.auth.st.gate.user;
    await advance(2 * SECOND);
    expect(env.jar.who()).toBe("A");
    expect([...x.events, ...y.events].filter(([e, w]) => e === "SIGNED_IN" && w === "B")).toEqual([]);
    expect(diag(y).refusedSaves).toBe(1); // the late save was refused
  });

  it("a sign-in whose Auth answer never comes in 20 s: interrupted; a late answer is never published", async () => {
    const y = await openTab("Y");
    const hold = deferred();
    env.auth.st.gate.password = hold.promise;
    expect(await signIn(y, "B")).toBe("interrupted");
    hold.resolve();
    delete env.auth.st.gate.password;
    await advance(2 * SECOND);
    expect(env.jar.family()).toEqual([]);
    expect(y.events.filter(([e]) => e === "SIGNED_IN")).toEqual([]);
  });

  it("concurrent B and C sign-ins in two tabs are serialized by the lease: each publication is whole, the later one wins, and no jar between them is mixed or absent", async () => {
    const y = await openTab("Y");
    const w = await openTab("W");
    env.auth.st.big.add("C"); // C's session is chunked, B's is bare: a shape change between them
    const [b, c] = await Promise.all([drive(y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD)), drive(w.publication.signInAndPublish(GOLFERS.C.email, PASSWORD))]);
    expect([b, c]).toEqual(["signed_in", "signed_in"]);
    const last = env.jar.who();
    expect(["B", "C"]).toContain(last);
    expect(env.jar.writes.filter((x) => !x.removed && x.layout === "absent")).toEqual([]);
    expect(env.jar.writes.filter((x) => x.layout === "present").map((x) => x.who).filter((v, i, all) => all[i - 1] !== v)).toEqual(last === "C" ? ["B", "C"] : ["C", "B"]);
  });
});

describe("refresh under the lease (AM-U5/U7 shapes) and the event fence (F2)", () => {
  it("a refresh holds the lease until its TOKEN_REFRESHED is dispatched: a publication in another tab waits for it, and every tab receives A's refresh before B's sign-in", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    const y = await openTab("Y"); // A1: opened before the expiring sign-in (its own start-up would refresh an expiring A)
    await signedIn("A", x, { expiring: true });
    const appendHold = deferred();
    env.lineage.hooks.appendGate = appendHold.promise; // pause X between its storage commit and its announcement
    const read = x.client().auth.getSession();
    await advance(100);
    expect(env.auth.st.sent.filter((s) => s.kind !== "user").map((s) => `${s.kind}:${s.presented ?? ""}:${s.status}`)).toEqual(["password::200", "refresh:A#1:200"]);
    const publish = y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD);
    await advance(600); // inside the 1 s lineage I/O bound
    expect(env.jar.who()).toBe("A"); // A's refreshed session stored; B is waiting for the lease
    expect(z.events).not.toContainEqual(["SIGNED_IN", "B"]);
    env.lineage.hooks.appendGate = null;
    appendHold.resolve();
    expect((await drive(read)).data.session?.user.id).toBe(GOLFERS.A.id);
    expect(await drive(publish)).toBe("signed_in");
    await advance(SECOND); // a tab's event fence may poll the lineage for up to VIEW_SETTLE_MS (fake time)
    expect(env.jar.who()).toBe("B");
    // A's refresh was announced (dispatched in X) before B's first write: the lease was held until then
    const t = env.timeline;
    expect(t.indexOf("X:TOKEN_REFRESHED:A")).toBeGreaterThan(-1);
    expect(t.indexOf("X:TOKEN_REFRESHED:A")).toBeLessThan(t.indexOf("jar:B"));
    // every event Z received described the jar when it was delivered: A's refresh, if it came after B, was dropped
    expect(z.events.at(-1)).toEqual(["SIGNED_IN", "B"]);
    expect(t.slice(t.indexOf("jar:B")).filter((e) => e.startsWith("Z:") && e.endsWith(":A"))).toEqual([]);
  });

  it("a historical SIGNED_OUT delivered after B's publication (held, then released late) does not end the tab now showing B; realtime keeps B's token", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x, { expiring: true });
    env.channels.holdFor.add("Z");
    env.auth.st.refreshAnswer = () => json(400, { code: "refresh_token_not_found", msg: "gone" });
    await drive(x.client().auth.getSession()); // A refused: removed, SIGNED_OUT (held for Z)
    env.auth.st.refreshAnswer = null;
    expect(env.jar.family()).toEqual([]);
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    // Z receives B's SIGNED_IN first, then the older SIGNED_OUT
    expect(env.channels.heldEvents("Z")).toEqual(["SIGNED_OUT", "SIGNED_IN"]);
    env.channels.release("Z", true);
    await flush();
    z.hub.shown = GOLFERS.B.id;
    env.channels.release("Z");
    await advance(SECOND);
    expect(z.events.slice(-1)).toEqual([["SIGNED_IN", "B"]]);
    expect(z.hub.ends).toEqual([]);
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
    expect(realtimeToken(z)).toBe(env.auth.latest("B").access);
    expect(diag(z).droppedEvents).toBe(1);
  });

  it("a historical TOKEN_REFRESHED for A delivered after B's publication is dropped: no account change for the tab showing B, and realtime never receives A's token", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x, { expiring: true });
    env.channels.holdFor.add("Z");
    await drive(x.client().auth.getSession()); // A refreshed: TOKEN_REFRESHED (held for Z)
    const aToken = env.auth.latest("A").access;
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    z.hub.shown = GOLFERS.B.id;
    env.channels.release("Z", true); // SIGNED_IN(B) first, then the older TOKEN_REFRESHED(A)
    await advance(SECOND);
    expect(z.hub.ends).toEqual([]);
    expect(realtimeToken(z)).toBe(env.auth.latest("B").access);
    expect(realtimeToken(z)).not.toBe(aToken);
    expect(z.events.filter(([e, w]) => e === "TOKEN_REFRESHED" && w === "A")).toEqual([]);
  });

  it("a delayed INITIAL_SESSION computed from A but delivered after B's publication is delivered without a session (no account change, no wrong identity)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const z = await openTab("Z");
    const hold = deferred();
    env.lineage.hooks.readGate = hold.promise; // Z's INITIAL_SESSION fence waits here
    const initial: [string, string][] = [];
    z.hub.shown = null;
    z.client().auth.onAuthStateChange((event, session) => { if (event === "INITIAL_SESSION") initial.push([event, whoOf(session)]); });
    await flush();
    env.lineage.hooks.readGate = null;
    const y = await openTab("Y");
    const publish = y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD);
    await advance(200);
    hold.resolve();
    expect(await drive(publish)).toBe("signed_in");
    await advance(SECOND);
    expect(initial).toEqual([["INITIAL_SESSION", "none"]]);
    expect(diag(z).fencedInitialSessions).toBe(1);
  });

  it("the SDK's second removal (S8) after B's publication removes nothing and its SIGNED_OUT reaches no subscriber", async () => {
    const x0 = await openTab("X0");
    await signedIn("A", x0, { expiring: true });
    env.auth.st.refreshAnswer = (p) => (p?.who === "A" ? json(400, { code: "refresh_token_already_used", msg: "used" }) : null);
    const y = await openTab("Y");
    const z = await openTab("Z");
    // a fresh page (X) whose start-up recovery refreshes A, is refused, removes A, and then removes a second time
    const xPromise = openTab("X");
    const publish = y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD);
    const x = await xPromise;
    expect(await drive(publish)).toBe("signed_in");
    await advance(2 * SECOND);
    expect(env.jar.who()).toBe("B");
    z.hub.shown = GOLFERS.B.id;
    await advance(SECOND);
    expect(z.hub.ends).toEqual([]);
    expect([...x.events, ...z.events].filter(([e]) => e === "SIGNED_OUT").length).toBeLessThanOrEqual(2); // A's own removal only
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("a reentrant subscriber that calls getSession and refreshSession inside TOKEN_REFRESHED completes (no lease deadlock)", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const inner: string[] = [];
    x.client().auth.onAuthStateChange((event) => {
      if (event !== "TOKEN_REFRESHED") return;
      void x.client().auth.getSession().then((r) => inner.push(`get:${whoOf(r.data.session)}`));
    });
    await drive(x.client().auth.getSession());
    await advance(SECOND);
    expect(inner).toEqual(["get:A"]);
    const again = await drive(x.client().auth.refreshSession());
    expect(whoOf(again.data.session)).toBe("A");
    expect(x.lease.activeSection()).toBeNull();
    trafficWithinCaps();
  });

  it("many concurrent session reads during a refusal all resolve (no unresolved SDK deferred), and the session ends once", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    env.auth.st.refreshAnswer = () => json(400, { code: "refresh_token_not_found", msg: "gone" });
    const reads = Array.from({ length: 5 }, () => x.client().auth.getSession());
    const answers = await drive(Promise.all(reads));
    expect(answers.every((r) => r.data.session === null)).toBe(true);
    expect(env.jar.family()).toEqual([]);
    expect(x.events).toEqual([["INITIAL_SESSION", "none"], ["SIGNED_IN", "A"], ["SIGNED_OUT", "none"]]);
    expect(env.auth.count("refresh")).toBe(1);
  });
});

describe("End Session (F1): ownership, cancellation, fallback", () => {
  it("normal: revoked with the current token, the lineage removed, SIGNED_OUT everywhere, the end section held until the page unloads", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    z.hub.shown = GOLFERS.A.id;
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id))).toBe("ended");
    await flush();
    expect(env.jar.family()).toEqual([]);
    expect(env.auth.st.sent.filter((s) => s.kind === "logout").map((s) => s.presented)).toEqual(["A#1"]);
    expect(z.hub.ends).toEqual(["signed_out"]);
    expect(x.lease.activeSection()?.kind).toBe("end");
    expect(diag(x).revoked).toBe(1);
  });

  it("an expiring A: one refresh inside the end section, then logout with the refreshed token (AM-E4)", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id))).toBe("ended");
    expect(env.auth.st.sent.filter((s) => s.kind !== "password" && s.kind !== "user").map((s) => [s.kind, s.presented])).toEqual([
      ["refresh", "A#1"],
      ["logout", "A#2"],
    ]);
    expect(env.jar.family()).toEqual([]);
  });

  it("Auth unreachable for logout: ended locally inside the section, SIGNED_OUT announced, revocation counted as not reached (R7); A2: reported as ended_unconfirmed, never as a confirmed revocation", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    env.auth.st.logoutAnswer = json(503, { msg: "down" });
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id))).toBe("ended_unconfirmed");
    expect(env.jar.family()).toEqual([]);
    expect(diag(x).revocationNotReached).toBe(1);
    expect(x.events.at(-1)).toEqual(["SIGNED_OUT", "none"]);
  });

  it("the lease is held by a frozen holder: unavailable after the 15 s wait; the lock request is aborted and never granted later; nothing is changed", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const frozen = deferred();
    void navigator.locks.request(`swingproai:session-publication:${KEY}`, { mode: "exclusive" }, () => frozen.promise);
    await flush();
    const started = Date.now();
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id), 30_000)).toBe("unavailable");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
    expect(Date.now() - started).toBeLessThan(21_000);
    const grantsBefore = env.lockMgr.grants.length;
    frozen.resolve();
    await advance(5 * SECOND);
    expect(env.lockMgr.grants.length).toBe(grantsBefore); // the aborted request is never granted afterwards
    expect(x.lease.activeSection()).toBeNull();
    expect(env.jar.who()).toBe("A");
    expect(env.auth.count("logout")).toBe(0);
    expect(diag(x).leaseTimeouts).toBe(1);
  });

  it("cancelled while waiting: unavailable at once; the cancelled request is never granted afterwards", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const holder = deferred();
    void navigator.locks.request(`swingproai:session-publication:${KEY}`, { mode: "exclusive" }, () => holder.promise);
    await flush();
    const cancel = new AbortController();
    const end = x.publication.endSessionInBrowser(GOLFERS.A.id, cancel.signal);
    await advance(500);
    cancel.abort();
    expect(await drive(end)).toBe("unavailable");
    holder.resolve();
    await advance(2 * SECOND);
    expect(x.lease.activeSection()).toBeNull();
    expect(env.jar.who()).toBe("A");
    expect(diag(x).leaseCancels).toBe(1);
  });

  it("B publishes while A's End Session waits for the lease: once held it finds B, ends nothing and reports other_account; B and B-only reads remain", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    const hold = deferred();
    env.auth.st.gate.user = hold.promise; // B's publication holds the lease while Auth validates B
    const publish = y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD);
    await advance(200);
    const end = x.publication.endSessionInBrowser(GOLFERS.A.id);
    await advance(500);
    hold.resolve();
    delete env.auth.st.gate.user;
    expect(await drive(publish)).toBe("signed_in");
    expect(await drive(end)).toBe("other_account");
    expect(env.jar.who()).toBe("B");
    expect(env.auth.count("logout")).toBe(0);
    expect(await hubRead(x)).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("a refresh of A queued before the end section is held is admitted into it (AM-X7): no stall, one refresh, one logout", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const y = await openTab("Y");
    const hold = deferred();
    void navigator.locks.request(`swingproai:session-publication:${KEY}`, { mode: "exclusive" }, () => hold.promise);
    await flush();
    const read = y.client().auth.getSession(); // queued refresh of A in Y (cross-tab: waits for the lock)
    const end = x.publication.endSessionInBrowser(GOLFERS.A.id);
    await advance(300);
    hold.resolve();
    const outcome = await drive(end);
    await drive(read);
    expect(outcome).toBe("ended");
    expect(env.jar.family()).toEqual([]);
    trafficWithinCaps();
  });
});

describe("cookie layout through the real SDK (AM-L1/L2) and the synchronization contract (F5)", () => {
  it("bare A → chunked B sign-in: only B's chunks remain, every intermediate jar was A, ambiguous or B (never absent or mixed)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    expect(env.jar.family()).toEqual([KEY]);
    env.auth.st.big.add("B");
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(env.jar.family().every((n) => n.startsWith(`${KEY}.`))).toBe(true);
    const sequence = env.jar.writes.slice(-env.jar.family().length - 1).map((w) => (w.layout === "present" ? w.who : w.layout));
    expect(sequence.filter((s) => s === "absent")).toEqual([]);
    expect(sequence.at(-1)).toBe("B");
  });

  it("chunked A → bare B, then End Session: no family name remains and A never reappears", async () => {
    env.auth.st.big.add("A");
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(env.jar.family()).toEqual([KEY]);
    expect(await drive(y.publication.endSessionInBrowser(GOLFERS.B.id))).toBe("ended");
    expect(env.jar.family()).toEqual([]);
    expect(env.jar.writes.filter((w) => w.layout === "present" && w.who === "A").length).toBeGreaterThan(0);
    expect(env.jar.writes.slice(-3).every((w) => w.who !== "A")).toBe(true);
  });

  it("a stale view at hand-off (the previous holder's B not visible yet): the holder waits 500 ms, then sends nothing and writes nothing (fail closed)", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const viewOfA = env.jar.snapshot();
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in"); // B is written and its lineage recorded …
    env.jar.showView(viewOfA); // … but document.cookie reads still show A (the previous holder's writes not visible yet)
    const before = env.auth.count("refresh");
    // A1 R1: the read itself is refused after the 500 ms wait (marked unverified): A is never handed to the SDK
    const refusal = await drive(x.client().auth.getSession().then(() => null, (e: unknown) => x.storage.sessionUnverifiedReason(e)));
    env.jar.thawView();
    expect(refusal).toBe("stale");
    expect(env.auth.count("refresh")).toBe(before); // nothing sent for A
    expect(env.jar.who()).toBe("B");
    expect(diag(x).unverifiedReads).toBeGreaterThanOrEqual(1);
  });

  it("End Session under a stale view (B published, X still shows A past 500 ms): nothing is ended or sent from X, the outcome is 'unavailable' (the server then judges the request's real cookies), and B's cookies remain (security F-A)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const viewOfA = env.jar.snapshot();
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.jar.showView(viewOfA); // X's document.cookie still shows A
    const outcome = await drive(x.publication.endSessionInBrowser(GOLFERS.A.id));
    env.jar.thawView();
    expect(outcome).toBe("unavailable");
    expect(env.jar.who()).toBe("B");
    expect(env.auth.count("logout")).toBe(0);
    expect(diag(x).staleViews).toBeGreaterThanOrEqual(1);
    expect(diag(x).endedLocally).toBe(0);
    expect(x.lease.activeSection()).toBeNull(); // the section was left: nothing of X's holds the lease
  });

  it("a writer outside the contract (cookies cleared): the view is never recorded, so it is untrusted after 500 ms (fail closed, counted); a sign-in still publishes (its permit names its own token) and re-anchors the lineage (security F-B)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    env.jar.store.clear();
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(env.jar.who()).toBe("B");
    expect(diag(y).unrecordedViews).toBe(1);
    // re-anchored: the next holder's view (B) is current, so B's own refresh proceeds
    env.auth.st.expiresIn = 60;
    const before = env.auth.count("refresh");
    const z = await openTab("Z");
    const read = await drive(z.client().auth.refreshSession());
    expect(read.error).toBeNull();
    expect(env.auth.count("refresh")).toBe(before + 1);
    expect(diag(z).unrecordedViews + diag(z).staleViews).toBe(0);
  });

  it("a subscriber that awaits work needing a LATER event never stalls the tab's later events (the fence orders checks and dispatches, not subscriber completion; QA F-E, security F-F)", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    let release!: () => void;
    const later = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    z.client().auth.onAuthStateChange(async (event, session) => {
      if (event !== "SIGNED_IN") return;
      seen.push(whoOf(session));
      if (whoOf(session) === "A") await later; // finishes only once B's SIGNED_IN has been delivered in this tab
      else release();
    });
    await signedIn("A", x);
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    await advance(SECOND);
    // with a queue that waited for subscribers, B's SIGNED_IN would wait behind A's still-running subscriber forever
    expect(seen[0]).toBe("A");
    expect(seen.at(-1)).toBe("B");
  });

  it("End Session's logout answered 401 with a body that never ends: the body is never read (cancelled), the end completes locally within its bounds, and nothing is left running (security F-G)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    env.auth.st.logoutAnswer = { status: 401, endless: true };
    const started = Date.now();
    const outcome = await drive(x.publication.endSessionInBrowser(GOLFERS.A.id));
    expect(outcome).toBe("ended_unconfirmed"); // A2: the 401 did not confirm the revocation
    expect(Date.now() - started).toBeLessThan(5 * SECOND); // no 16 s sign-out deadline was needed
    expect(env.jar.family()).toEqual([]);
    expect(env.auth.count("logout")).toBe(1);
  });

  it("A1 R5: a lineage append that does not complete within 1 s is abandoned (aborted) and counted, and the refresh it recorded is NOT acknowledged: no TOKEN_REFRESHED anywhere, the read reports an error (never A's new session as verified), the abandoned append never lands; the next sign-in re-anchors", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    const y = await openTab("Y"); // opened before the expiring sign-in (its start-up would refresh an expiring A)
    await signedIn("A", x, { expiring: true });
    const stuck = deferred();
    env.lineage.hooks.appendGate = stuck.promise;
    const read = x.client().auth.getSession().then((r) => r, (e: unknown) => ({ data: { session: null }, error: e }));
    await advance(1500);
    env.lineage.hooks.appendGate = null;
    stuck.resolve();
    const answer = await drive(read);
    expect([answer.data.session, answer.error === null]).toEqual([null, false]);
    expect(diag(x).lineageWriteFailures + diag(x).lateLineage).toBe(1);
    expect(diag(x).unrecordedChanges).toBe(1);
    await advance(SECOND);
    expect(env.lineage.hooks.abandoned).toBe(1);
    expect([...x.events, ...z.events].filter(([e]) => e === "TOKEN_REFRESHED")).toEqual([]);
    expect((await hubRead(z)).acquired).toBe("unavailable"); // A#2 is in the jar but never recorded: refused
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(env.jar.who()).toBe("B");
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("A1 R5: the lineage store fails: nothing is verified, so nothing is trusted — a sign-in is reported interrupted and announced nowhere, every read is refused as unavailable (never signed out, never a session), nothing is removed; counted", async () => {
    const x = await openTab("X");
    await signedIn("A", x); // a working browser first
    const z = await openTab("Z");
    env.lineage.hooks.fail = true;
    const y = await openTab("Y");
    const passwordsBefore = env.auth.count("password");
    expect(await signIn(y, "B")).toBe("interrupted");
    await advance(SECOND);
    // review F3/B1: the store is asked before anything is sent: no password went out, nothing was written
    expect(env.auth.count("password")).toBe(passwordsBefore);
    expect(env.jar.who()).toBe("A");
    expect([...x.events, ...y.events, ...z.events].filter(([e, w]) => e === "SIGNED_IN" && w === "B")).toEqual([]);
    const refusal = await drive(x.client().auth.getSession().then(() => null, (e: unknown) => x.storage.sessionUnverifiedReason(e)));
    expect(refusal).toBe("unavailable");
    expect((await hubRead(z)).acquired).toBe("unavailable");
    expect(env.auth.st.sent.filter((s) => s.kind === "rest")).toEqual([]);
    expect(diag(y).lineageUnavailable + diag(y).lineageWriteFailures).toBeGreaterThan(0);
    // negative control: the store recovers; a new sign-in publishes and re-anchors, and B is read
    env.lineage.hooks.fail = false;
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("A1 R5: no Web Locks (an insecure context): nothing can be ordered, so a sign-in is 'unsupported' BEFORE the password is sent; no cookie is written; a session already in the jar is never read as anyone (refused, unsupported)", async () => {
    vi.stubGlobal("navigator", { userAgent: "synthetic" });
    const x = await openTab("X");
    expect(await signIn(x, "A")).toBe("unsupported");
    expect(env.auth.count("password")).toBe(0);
    expect(env.jar.family()).toEqual([]);
    expect(x.lease.leaseSupport()).toBe("unsupported");
    // a session another (supported) context left in the jar
    env.jar.store.set(KEY, encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: GOLFERS.A.id } })));
    const refusal = await drive(x.client().auth.getSession().then(() => null, (e: unknown) => x.storage.sessionUnverifiedReason(e)));
    expect(refusal).toBe("unsupported");
  });

  it("a refresh section whose commit never comes ends at its 10 s backstop (counted); nothing stays held after it", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const section = x.lease.enterRefresh("synthetic-unrelated-token", 1000);
    const handle = await drive(section);
    expect(handle).not.toBeNull();
    x.lease.finishRefresh(handle!, { origin: "synthetic-unrelated-token", result: "synthetic-new-token" });
    await advance(10_100);
    expect(x.lease.activeSection()).toBeNull();
    expect(diag(x).commitBackstops).toBe(1);
  });
});

describe("A1 R1: an unexpired stale or unrecorded acquisition is never read as that account", () => {
  it("newly mounted: B is recorded while this tab still sees an UNEXPIRED A; the Drill Hub's acquisition is unavailable (not A, not signed out) and no read carries A's token; negative control: the view catches up within 500 ms and B's rows are read", async () => {
    const x = await openTab("X");
    await signedIn("A", x); // unexpired (3600 s): getSession would not refresh it
    const viewOfA = env.jar.snapshot();
    const z = await openTab("Z");
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.jar.showView(viewOfA); // Z's document.cookie still shows A
    const restBefore = env.auth.st.sent.filter((s) => s.kind === "rest").length;
    const refreshBefore = env.auth.count("refresh");
    expect(await hubRead(z)).toEqual({ acquired: "unavailable", rows: [] });
    expect(env.auth.st.sent.filter((s) => s.kind === "rest").length).toBe(restBefore); // no A-bound read at all
    expect(env.auth.count("refresh")).toBe(refreshBefore);
    expect(env.jar.who()).toBe("B"); // B intact
    // negative control: the view catches up inside the settle window
    const reading = hubRead(z);
    await flush(2);
    env.jar.thawView();
    expect(await reading).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("continuously visible: a tab showing A keeps no A-bound reads once B is recorded and its view is stale — its next acquisition (Try again, a drill submission) is refused — and B's delayed SIGNED_IN then ends it as account_changed", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const z = await openTab("Z");
    z.hub.shown = GOLFERS.A.id;
    expect(await hubRead(z)).toEqual({ acquired: "A", rows: ["A"] });
    const viewOfA = env.jar.snapshot();
    env.channels.holdFor.add("Z"); // Z has not received B's announcement yet
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.jar.showView(viewOfA);
    const restBefore = env.auth.st.sent.filter((s) => s.kind === "rest").length;
    expect((await hubRead(z)).acquired).toBe("unavailable");
    expect(env.auth.st.sent.filter((s) => s.kind === "rest").length).toBe(restBefore);
    env.jar.thawView();
    env.channels.release("Z");
    await advance(SECOND);
    expect(z.hub.ends).toEqual(["account_changed"]);
    expect(realtimeToken(z)).toBe(env.auth.latest("B").access);
  });

  it("a writer outside the contract (a previous bundle's late COMPLETE write of a live, unrevoked A after B was published): every new reader refuses it (unrecorded), the binding no longer vouches for it on the server, nothing is removed or revoked; a new sign-in re-anchors to B", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const aOld = env.auth.latest("A");
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    const z = await openTab("Z");
    const bindingAfterB = parseCookieHeader(env.jar.snapshot()).find((c) => c.name === "swingproai-session-binding")?.value;
    // the old bundle's refresh of A, sent before B's sign-in and answered late: Auth rotates A (live, unrevoked) …
    const late = await env.auth.fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: "POST", body: JSON.stringify({ refresh_token: aOld.refresh }) });
    const aNew = (await late.json()) as Record<string, unknown>;
    expect(late.status).toBe(200);
    // … and it writes the new A whole with its own @supabase/ssr 0.3.0 storage: the session names only, no binding
    const aPair = { value: JSON.stringify(aNew) };
    env.jar.store.set(KEY, encodeURIComponent(aPair.value));
    expect(env.jar.who()).toBe("A");
    expect(await hubRead(z)).toEqual({ acquired: "unavailable", rows: [] });
    const refusal = await drive(z.client().auth.getSession().then(() => null, (e: unknown) => z.storage.sessionUnverifiedReason(e)));
    expect(refusal).toBe("unrecorded");
    const pairs = parseCookieHeader(env.jar.snapshot());
    const aAccess = aNew.access_token as string;
    expect(await bindingAdmits(pairs, aAccess)).toBe("mismatch"); // the server verifier and middleware refuse it
    expect(pairs.find((c) => c.name === "swingproai-session-binding")?.value).toBe(bindingAfterB);
    expect(env.auth.count("logout")).toBe(0);
    expect(env.auth.st.revoked.size).toBe(0); // A live and unrevoked throughout
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
    const after = parseCookieHeader(env.jar.snapshot());
    expect(await bindingAdmits(after, env.auth.latest("B").access)).toBe("bound");
  });

  it("a writer outside the contract REMOVES B's cookies (a previous bundle's late refusal): readers report unavailable — never signed out — and the server sees no session; a sign-in recovers", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    const z = await openTab("Z");
    z.hub.shown = GOLFERS.B.id;
    env.jar.store.delete(KEY); // the old bundle's 0.3.0 removal deletes the bare key
    const acquired = await hubRead(z);
    expect(acquired.acquired).toBe("unavailable");
    expect(z.hub.ends).toEqual([]);
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
  });
});

describe("A1 R4: an announcement is decided against the newest lineage the tab has seen, after its own digest", () => {
  /** Pauses the NEXT SubtleCrypto digest of `token`'s lineage (only that one call); every other digest runs normally. */
  function pauseNextDigestOf(token: string) {
    const gate = deferred();
    let armed = true;
    let paused = 0;
    vi.mocked(globalThis.crypto.subtle.digest).mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (armed && new TextDecoder().decode(data as Uint8Array) === `swingproai-lineage:${token}`) {
        armed = false;
        paused += 1;
        await gate.promise;
      }
      return onClockDigest(algorithm, data);
    });
    return { release: () => gate.resolve(), paused: () => paused };
  }

  async function schedule(publishC: boolean) {
    const x = await openTab("X");
    await signedIn("A", x);
    const z = await openTab("Z");
    const w = await openTab("W");
    env.channels.holdFor.add("Z");
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in"); // B's SIGNED_IN held for Z
    await advance(SECOND);
    const digest = pauseNextDigestOf(env.auth.latest("B").refresh);
    env.channels.holdFor.delete("Z");
    env.channels.release("Z"); // Z's fence starts on B's announcement(s): the B digest pauses
    for (let i = 0; i < 100 && digest.paused() === 0; i++) await flush(1);
    expect(digest.paused()).toBe(1);
    if (publishC) {
      expect(await signIn(w, "C")).toBe("signed_in"); // C published and recorded while B's check is paused
      z.hub.shown = GOLFERS.C.id;
      expect(await hubRead(z)).toEqual({ acquired: "C", rows: ["C"] }); // Z shows C (its read observed C's record)
    } else {
      z.hub.shown = GOLFERS.B.id;
    }
    digest.release();
    await advance(SECOND);
    return { z };
  }

  it("forced: B's delayed SIGNED_IN is paused in its digest, C is published and the tab shows C, then the digest completes — B is NOT delivered (no account change for the tab showing C, realtime keeps C)", async () => {
    const { z } = await schedule(true);
    expect(z.hub.ends).toEqual([]);
    expect(z.events.filter(([e, who]) => e === "SIGNED_IN" && who === "B")).toEqual([]);
    expect(z.events.at(-1)).toEqual(["SIGNED_IN", "C"]);
    expect(realtimeToken(z)).toBe(env.auth.latest("C").access);
    expect(diag(z).droppedEvents).toBeGreaterThanOrEqual(1);
  });

  it("negative control: with no publication in between, the paused B announcement is delivered once its digest completes", async () => {
    const { z } = await schedule(false);
    expect(z.events.filter(([e, who]) => e === "SIGNED_IN" && who === "B").length).toBeGreaterThanOrEqual(1);
    expect(z.hub.ends).toEqual([]);
    expect(realtimeToken(z)).toBe(env.auth.latest("B").access);
  });

  it("a delayed SIGNED_OUT (A's own removal, recorded) is delivered only while 'none' is the newest lineage: once C is recorded it is dropped", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const z = await openTab("Z");
    env.channels.holdFor.add("Z");
    env.auth.st.refreshAnswer = () => json(400, { code: "refresh_token_not_found", msg: "gone" });
    await drive(x.client().auth.getSession()); // A refused: removed, recorded 'none', SIGNED_OUT (held for Z)
    env.auth.st.refreshAnswer = null;
    const w = await openTab("W");
    expect(await signIn(w, "C")).toBe("signed_in");
    z.hub.shown = GOLFERS.C.id;
    expect(await hubRead(z)).toEqual({ acquired: "C", rows: ["C"] });
    env.channels.release("Z");
    await advance(SECOND);
    expect(z.hub.ends).toEqual([]);
    expect(realtimeToken(z)).toBe(env.auth.latest("C").access);
  });
});

describe("A1 review fixes (QA B1/I1/I5/m3, security F1/F2/F3/F6/F7)", () => {
  const bindingOf = () => parseCookieHeader(env.jar.snapshot()).find((c) => c.name === "swingproai-session-binding")?.value ?? null;
  const accessInJar = () => {
    const l = readSessionLayout(parseCookieHeader(env.jar.snapshot()), KEY);
    return l.kind === "present" ? (JSON.parse(l.value) as { access_token: string }).access_token : null;
  };

  it("B1/F1: a sign-in whose lineage append fails after B was written is interrupted AND refused everywhere: the binding is 'none' (the server refuses B), every reader refuses B, no SIGNED_IN for B anywhere, the next tenure is untrusted", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const z = await openTab("Z");
    const y = await openTab("Y");
    env.lineage.hooks.failAppend = true; // reads still work: the publication starts and writes B, then cannot record it
    expect(await signIn(y, "B")).toBe("interrupted");
    await advance(SECOND);
    expect(env.jar.who()).toBe("B"); // written, never acknowledged
    expect(bindingOf()).toBe("none");
    expect(await bindingAdmits(parseCookieHeader(env.jar.snapshot()), accessInJar() as string)).toBe("mismatch"); // server and middleware refuse
    expect([...x.events, ...y.events, ...z.events].filter(([e, w]) => e === "SIGNED_IN" && w === "B")).toEqual([]);
    expect((await hubRead(z)).acquired).toBe("unavailable");
    expect((await hubRead(y)).acquired).toBe("unavailable"); // the writing tab too (its next tenure sees B unrecorded)
    expect(env.auth.st.sent.filter((s) => s.kind === "rest" && s.bearer?.startsWith("B"))).toEqual([]);
    // negative control: the store recovers; a new sign-in publishes, records and binds B
    env.lineage.hooks.failAppend = false;
    expect(await signIn(y, "B")).toBe("signed_in");
    expect(await bindingAdmits(parseCookieHeader(env.jar.snapshot()), accessInJar() as string)).toBe("bound");
    expect(await hubRead(z)).toEqual({ acquired: "B", rows: ["B"] });
  });

  it("F2/I1: a session written outside the contract DURING a held, trusted refresh section is never handed to the SDK, read, announced or given to realtime", async () => {
    const x = await openTab("X");
    const z = await openTab("Z"); // opened first: a tab opened later would refresh the expiring session at its start-up
    await signedIn("A", x, { expiring: true });
    const hold = deferred();
    env.auth.st.gate.refresh = hold.promise; // X's refresh section is held while its request is at Auth
    const read = x.client().auth.getSession().then((r) => r, (e: unknown) => ({ data: { session: null }, error: e }));
    await advance(100);
    expect(x.lease.activeSection()?.kind).toBe("refresh");
    // an old bundle's page writes C whole in the middle of X's section (its own 0.3.0 storage; no lock, no binding)
    const cAnswer = await env.auth.fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", body: JSON.stringify({ email: GOLFERS.C.email, password: PASSWORD }) });
    env.jar.store.set(KEY, encodeURIComponent(JSON.stringify(await cAnswer.json())));
    expect(env.jar.who()).toBe("C");
    const restBefore = env.auth.st.sent.filter((s) => s.kind === "rest").length;
    const inSection = await drive(x.client().auth.getSession().then(() => "read", (e: unknown) => x.storage.sessionUnverifiedReason(e)));
    expect(inSection).toBe("unrecorded"); // refused inside the section: C is not what this tenure verified or wrote
    delete env.auth.st.gate.refresh;
    hold.resolve();
    await drive(read);
    await advance(2 * SECOND);
    expect([...x.events, ...z.events].filter(([, w]) => w === "C")).toEqual([]);
    expect(realtimeToken(x)).not.toBe(env.auth.latest("C").access);
    expect(env.auth.st.sent.filter((s) => s.kind === "rest").length).toBe(restBefore); // no read with C's (or anyone's) token
    expect((await hubRead(z)).acquired).toBe("unavailable");
  });

  it("F7: End Session whose record fails: the jar is emptied, this tab's subscribers learn SIGNED_OUT (the jar really holds none), other tabs are told nothing and refuse their next read", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    env.lineage.hooks.failAppend = true;
    await drive(x.publication.endSessionInBrowser(GOLFERS.A.id));
    await advance(SECOND);
    expect(env.jar.family()).toEqual([]);
    expect(bindingOf()).toBe("none");
    expect(x.events.at(-1)).toEqual(["SIGNED_OUT", "none"]);
    expect(z.events.filter(([e]) => e === "SIGNED_OUT")).toEqual([]);
    expect((await hubRead(z)).acquired).toBe("unavailable");
    env.lineage.hooks.failAppend = false;
  });

  it("QA B1 part 1: the store answers before the password is sent, then fails while the publication waits for its tenure check: the section could not be verified, so NOTHING is published (interrupted; A and A's binding stay)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const bindingOfA = bindingOf();
    const y = await openTab("Y");
    const hold = deferred();
    env.auth.st.gate.password = hold.promise; // the pre-check has answered; the password is at Auth
    const passwordsBefore = env.auth.count("password");
    const outcome = drive(y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD));
    await advance(100); // the pre-check read has answered; the password request waits at Auth
    env.lineage.hooks.failRead = true; // the store now fails: the publish section's tenure check cannot be made
    hold.resolve();
    delete env.auth.st.gate.password;
    expect(await outcome).toBe("interrupted");
    expect(env.auth.count("password")).toBe(passwordsBefore + 1); // the password was sent (so "interrupted", never "unsupported")
    env.lineage.hooks.failRead = false;
    await advance(SECOND);
    expect(env.jar.who()).toBe("A");
    expect(bindingOf()).toBe(bindingOfA);
    expect([...x.events, ...y.events].filter(([e, w]) => e === "SIGNED_IN" && w === "B")).toEqual([]);
    expect(await hubRead(x)).toEqual({ acquired: "A", rows: ["A"] });
  });

  it("m3: a refused sign-in (wrong password) through the real helper is 'refused': nothing is written, published or announced", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    expect(await drive(y.publication.signInAndPublish(GOLFERS.B.email, "synthetic-wrong-password"))).toBe("refused");
    await advance(SECOND);
    expect(env.jar.who()).toBe("A");
    expect([...x.events, ...y.events].filter(([e, w]) => e === "SIGNED_IN" && w === "B")).toEqual([]);
  });

  it("I5: a Drill Hub acquisition refused as unverified says so (unconfirmed), unlike an ordinary unavailable one", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const viewOfA = env.jar.snapshot();
    const z = await openTab("Z");
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.jar.showView(viewOfA);
    const acquired = await drive(acquireDrillHubSession(() => z.client() as never));
    env.jar.thawView();
    expect(acquired).toEqual({ status: "unavailable", unconfirmed: true });
  });
});

describe("SessionKeeper's Server Action gate (serverActionFetch; security F6 and negative paths)", () => {
  type Keeper = typeof import("@/components/navigation/SessionKeeper");
  async function keeperIn(tab: Tab): Promise<Keeper> {
    return import("@/components/navigation/SessionKeeper"); // the tab's module registry (its storage knows the jar)
  }
  const ORIGIN = "http://127.0.0.1:3941";
  const ACTION = { method: "POST", headers: { "Next-Action": "synthetic-action-id", "Content-Type": "text/plain;charset=UTF-8" }, body: "[]" };

  it("an expiring session: the action waits for the shared client's refresh and then goes; a fresh session, a plain POST, a GET and a cross-origin request are not held", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const keeper = await keeperIn(x);
    const sent: string[] = [];
    const original = (async (input: RequestInfo | URL) => { sent.push(String(input)); return new Response("ok"); }) as typeof fetch;
    const refreshesBefore = env.auth.count("refresh");
    const gated = keeper.serverActionFetch(original, x.client() as never, ORIGIN);
    await drive(gated(`${ORIGIN}/goals`, ACTION));
    expect(env.auth.count("refresh")).toBe(refreshesBefore + 1); // refreshed under the lease before it was sent
    expect(sent).toEqual([`${ORIGIN}/goals`]);
    const before = env.auth.count("refresh");
    await drive(gated(`${ORIGIN}/goals`, ACTION)); // fresh now: not held
    await drive(gated(`${ORIGIN}/goals`, { method: "POST", body: "x" }));
    await drive(gated(`${ORIGIN}/goals`));
    await drive(gated("https://elsewhere.example.invalid/goals", ACTION));
    await drive(gated(new Request(`${ORIGIN}/goals`, ACTION)));
    expect(env.auth.count("refresh")).toBe(before);
    expect(sent.length).toBe(6);
  });

  it("F6: when another account is signed in while the action waits, the action is NOT sent (rejected like a network failure)", async () => {
    const x = await openTab("X");
    const y = await openTab("Y"); // opened first: a tab opened later would refresh the expiring session at its start-up
    await signedIn("A", x, { expiring: true });
    const keeper = await keeperIn(x);
    const sent: string[] = [];
    const original = (async (input: RequestInfo | URL) => { sent.push(String(input)); return new Response("ok"); }) as typeof fetch;
    const hold = deferred();
    const slowClient = { auth: { getSession: async () => { await hold.promise; } } }; // the wait the golfer sees
    const gated = keeper.serverActionFetch(original, slowClient, ORIGIN);
    const action = gated(`${ORIGIN}/goals`, ACTION).then(() => "sent", (e: unknown) => String(e));
    await advance(100);
    expect(await signIn(y, "B")).toBe("signed_in");
    hold.resolve();
    expect(await drive(action)).toBe("TypeError: Failed to fetch");
    expect(sent).toEqual([]);
  });

  it("a refresh that never answers holds the action at most 8 s; one that rejects does not stop it", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const keeper = await keeperIn(x);
    const sent: number[] = [];
    const original = (async () => { sent.push(Date.now()); return new Response("ok"); }) as typeof fetch;
    const started = Date.now();
    await drive(keeper.serverActionFetch(original, { auth: { getSession: () => new Promise(() => undefined) } }, ORIGIN)(`${ORIGIN}/goals`, ACTION));
    expect(sent[0] - started).toBeGreaterThanOrEqual(8_000);
    expect(sent[0] - started).toBeLessThan(9_000);
    await drive(keeper.serverActionFetch(original, { auth: { getSession: () => Promise.reject(new Error("synthetic")) } }, ORIGIN)(`${ORIGIN}/goals`, ACTION));
    expect(sent.length).toBe(2);
  });
});

// ─── A2 (AG-WEB-READY-03-R1-A2): lineage-bound End Session and its operation-bound completion ─────────────────────────

describe("A2: End Session is bound to the session lineage; its completion acts only on that lineage, once", () => {
  /** The lineage digest of an Auth session id, computed independently of the module (session-cookie-layout.ts). */
  const lineageOf = (sid: string) => createHash("sha256").update(`swingproai-session-lineage:${sid}`).digest("hex");
  const latestLineage = (who: Who) => lineageOf(env.auth.latest(who).sid);
  const INTENT = "swingproai-session-ended";
  const intentInJar = () => parseCookieHeader(env.jar.snapshot()).find((c) => c.name === INTENT)?.value ?? null;
  /** What the server's confirmed-revocation answer does to the browser: Auth revoked the lineage; the intent cookie names it. */
  function serverRevoked(who: Who) {
    env.auth.st.revoked.add(env.auth.latest(who).sid);
    env.jar.doc.cookie = `${INTENT}=${latestLineage(who)}; Path=/; Max-Age=600; SameSite=Lax`;
  }
  const authTraffic = () => env.auth.st.sent.filter((x) => x.kind === "refresh" || x.kind === "logout" || x.kind === "user").length;
  async function sessionIn(tab: Tab): Promise<unknown> {
    const read = await drive(tab.client().auth.getSession());
    return read.data.session;
  }

  it("JS End Session names the rendered lineage: a newer sign-in of the SAME golfer is never ended from an older page (other_account), and no logout is sent", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const renderedFor = latestLineage("A");
    const y = await openTab("Y");
    expect(await signIn(y, "A")).toBe("signed_in"); // a newer sign-in of the same golfer (another Auth session id)
    expect(latestLineage("A")).not.toBe(renderedFor);
    const logoutsBefore = env.auth.count("logout");
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, renderedFor))).toBe("other_account");
    expect(env.jar.who()).toBe("A");
    expect(env.auth.count("logout")).toBe(logoutsBefore);
    expect(x.lease.activeSection()).toBeNull();
    // the page rendered for the newer lineage ends it (positive control)
    expect(await drive(y.publication.endSessionInBrowser(GOLFERS.A.id, undefined, latestLineage("A")))).toBe("ended");
    expect(env.jar.family()).toEqual([]);
    trafficWithinCaps();
  });

  it("the ended-lineage notice ends only views of that lineage, in other tabs too, also when the removal could not be recorded (F7 completed)", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    const viewOfA = await sessionIn(z);
    const ended: string[] = [];
    z.publication.watchSessionEnd(viewOfA, () => ended.push("A"));
    // a view of another lineage (an older sign-in of A, not the one being ended) is never ended by it
    const other = { access_token: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: GOLFERS.A.id, session_id: "sid-not-this-one" })).toString("base64url")}.x` };
    z.publication.watchSessionEnd(other, () => ended.push("other"));
    env.lineage.hooks.failAppend = true; // the removal cannot be recorded: the SDK's SIGNED_OUT never reaches Z
    await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, latestLineage("A")));
    await advance(SECOND);
    env.lineage.hooks.failAppend = false;
    expect(env.jar.family()).toEqual([]);
    expect(z.events.filter(([e]) => e === "SIGNED_OUT")).toEqual([]);
    expect(ended).toEqual(["A"]);
  });

  it("a plain sign-in page visit (no intent) changes nothing: no lock, no Auth request, the session stays", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const login = await openTab("L");
    const grants = env.lockMgr.grants.length;
    const traffic = authTraffic();
    expect(login.publication.endIntentPending()).toBe(false);
    expect(await drive(login.publication.completeEndedSession())).toBe("none");
    expect(env.lockMgr.grants.length).toBe(grants);
    expect(authTraffic()).toBe(traffic);
    expect(env.jar.who()).toBe("A");
  });

  it("revocation confirmed by the server, then the sign-in page: the jar's session — still that lineage — is removed under the lease, SIGNED_OUT reaches every tab, views end, the intent is deleted; no Auth request", async () => {
    const x = await openTab("X");
    const z = await openTab("Z");
    await signedIn("A", x);
    z.hub.shown = GOLFERS.A.id;
    serverRevoked("A");
    const login = await openTab("L");
    expect(login.publication.endIntentPending()).toBe(true);
    const traffic = authTraffic();
    expect(await drive(login.publication.completeEndedSession())).toBe("completed");
    await flush();
    expect(env.jar.family()).toEqual([]);
    expect(intentInJar()).toBeNull();
    expect(authTraffic()).toBe(traffic);
    expect(z.hub.ends).toEqual(["signed_out"]);
    expect(login.lease.activeSection()).toBeNull();
    // single use: the instruction is gone
    expect(await drive(login.publication.completeEndedSession())).toBe("none");
    expect((await hubRead(z)).acquired).toBe("signed_out");
  });

  it("the lineage's continuation (a refresh of the ended session) is still that lineage and is removed", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    await drive(x.client().auth.getSession()); // refreshes A#1 → A#2 (same Auth session)
    expect(env.auth.latest("A").label).toBe("A#2");
    serverRevoked("A");
    const login = await openTab("L");
    expect(await drive(login.publication.completeEndedSession())).toBe("completed");
    expect(env.jar.family()).toEqual([]);
  });

  it("a delayed or replayed intent never ends a newer sign-in: B (another golfer) and A's newer sign-in are kept; the intent is deleted", async () => {
    for (const next of ["B", "A"] as const) {
      env = setupEnv();
      const x = await openTab("X");
      await signedIn("A", x);
      const revokedLineage = latestLineage("A");
      const y = await openTab("Y");
      const z = await openTab("Z");
      expect(await signIn(y, next)).toBe("signed_in"); // published before the intent arrives (or is replayed)
      z.hub.shown = GOLFERS[next].id;
      const holder = env.auth.latest(next).label;
      env.jar.doc.cookie = `${INTENT}=${revokedLineage}; Path=/; Max-Age=600; SameSite=Lax`;
      const login = await openTab("L");
      expect(await drive(login.publication.completeEndedSession())).toBe("kept_other");
      await flush();
      expect(env.jar.who()).toBe(next);
      expect(env.auth.latest(next).label).toBe(holder);
      expect(intentInJar()).toBeNull();
      expect(z.hub.ends).toEqual([]);
      expect((await hubRead(z)).acquired).toBe(next);
    }
  });

  it("no lease in time (a frozen holder): pending — nothing changed, the intent kept; an explicit retry once the lease is free completes", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    serverRevoked("A");
    const login = await openTab("L");
    const frozen = deferred();
    void navigator.locks.request(`swingproai:session-publication:${KEY}`, { mode: "exclusive" }, () => frozen.promise);
    await flush();
    expect(await drive(login.publication.completeEndedSession(), 30_000)).toBe("pending");
    expect(env.jar.who()).toBe("A");
    expect(intentInJar()).toBe(latestLineage("A"));
    frozen.resolve();
    await flush();
    expect(await drive(login.publication.completeEndedSession())).toBe("completed");
    expect(env.jar.family()).toEqual([]);
  });

  it("a view of the jar that is not the recorded lineage decides nothing (pending), so a newer sign-in it cannot see yet is never removed", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    serverRevoked("A");
    const staleView = env.jar.snapshot(); // A and the intent naming A
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.jar.doc.cookie = `${INTENT}=${latestLineage("A")}; Path=/; Max-Age=600; SameSite=Lax`; // still there
    const login = await openTab("L");
    env.jar.showView(staleView); // this tab still sees A (B's write not visible here yet)
    expect(await drive(login.publication.completeEndedSession())).toBe("pending");
    env.jar.thawView();
    expect(env.jar.who()).toBe("B");
  });

  it("a browser that cannot support the synchronization contract removes nothing (unsupported); the intent stays for a browser that can", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    serverRevoked("A");
    const login = await openTab("L");
    login.lease.configureLineage({ jarView: login.storage.storedJarView, store: null });
    expect(await drive(login.publication.completeEndedSession())).toBe("unsupported");
    expect(env.jar.who()).toBe("A");
    expect(intentInJar()).not.toBeNull();
  });
});

describe("A2: SessionKeeper takes the refresh before a previous bundle's tab would, and installs the fence at once (rollout)", () => {
  const BINDING = "swingproai-session-binding";
  const stored = (tab: Tab) => {
    const s = tab.storage.readStoredSession();
    if (s.kind !== "present") throw new Error("no session stored");
    return s.envelope;
  };

  it("due only within min(5 min, half the token's lifetime) of expiry — before the previous SDK's own threshold (≤ 120 s) — never earlier", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    const { expiresAt, refreshToken } = stored(x);
    const expiry = (expiresAt as number) * 1000;
    expect(keeper.keeperRefreshDue(expiry - 301_000, true)).toBeNull();
    expect(keeper.keeperRefreshDue(expiry - 299_000, true)).toEqual({ token: refreshToken, legacy: false, spacingMs: 1_800_000 });
    expect(keeper.keeperRefreshDue(expiry - 121_000, true)).not.toBeNull(); // still ahead of the old tab's ticker threshold
    // a short-lived token (360 s): the lead is half its lifetime (180 s), so it is never refreshed again at once
    env.auth.st.expiresIn = 360;
    const y = await openTab("Y");
    expect(await signIn(y, "B")).toBe("signed_in");
    env.auth.st.expiresIn = 3600;
    const short = stored(y);
    const shortExpiry = (short.expiresAt as number) * 1000;
    expect(keeper.keeperRefreshDue(shortExpiry - 181_000, true)).toBeNull();
    expect(keeper.keeperRefreshDue(shortExpiry - 179_000, true)?.token).toBe(short.refreshToken);
  });

  it("every tab's keeper firing in the same window makes ONE refresh request: the others are answered from the jar", async () => {
    const x = await openTab("X");
    const y = await openTab("Y");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    const { expiresAt } = stored(x);
    vi.setSystemTime((expiresAt as number) * 1000 - 200_000);
    const due = keeper.keeperRefreshDue(Date.now(), true);
    expect(due).not.toBeNull();
    const refreshesBefore = env.auth.count("refresh");
    const [a, b] = await drive(Promise.all([
      x.client().auth.refreshSession({ refresh_token: due!.token }),
      y.client().auth.refreshSession({ refresh_token: due!.token }),
    ]));
    expect(env.auth.count("refresh") - refreshesBefore).toBe(1);
    // the other tab: answered from the jar without a request; auth-js 2.107 then keeps the stored session or discards its
    // own answer because the jar changed meanwhile (AuthRefreshDiscardedError) — never a second request, never a removal
    expect(a.error).toBeNull();
    expect(b.error === null || (b.error as Error).name === "AuthRefreshDiscardedError").toBe(true);
    expect(env.auth.latest("A").label).toBe("A#2");
    expect(env.jar.who()).toBe("A");
    expect(keeper.keeperRefreshDue(Date.now(), true)).toBeNull(); // the new session is far from expiry
    trafficWithinCaps();
  });

  it("an unbound (legacy) jar is refreshed once at once, through the lease, and is bound from then on", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    env.jar.store.delete(BINDING); // the jar as a previous bundle last left it: no binding at all
    const keeper = await import("@/components/navigation/SessionKeeper");
    const due = keeper.keeperRefreshDue(Date.now(), false);
    expect(due).toEqual({ token: stored(x).refreshToken, legacy: true, spacingMs: 1_800_000 });
    expect(keeper.keeperRefreshDue(Date.now(), true)).toBeNull(); // once per page: then only the lead decides
    await drive(x.client().auth.refreshSession({ refresh_token: due!.token }));
    const access = stored(x).accessToken;
    expect(await bindingAdmits(parseCookieHeader(env.jar.snapshot()), access)).toBe("bound");
  });

  it("a session this browser cannot verify (written outside the contract) is never refreshed by the keeper: nothing is sent", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    // a previous bundle's tab writes C whole (its own storage; no lock, no record, no binding change)
    const cAnswer = await env.auth.fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", body: JSON.stringify({ email: GOLFERS.C.email, password: PASSWORD }) });
    env.jar.store.set(KEY, encodeURIComponent(JSON.stringify(await cAnswer.json())));
    vi.setSystemTime(((stored(x).expiresAt as number) - 100) * 1000);
    const due = keeper.keeperRefreshDue(Date.now(), true);
    expect(due).not.toBeNull();
    const refreshesBefore = env.auth.count("refresh");
    const result = await drive(x.client().auth.refreshSession({ refresh_token: due!.token }), 60_000);
    expect(result.error).not.toBeNull();
    expect(env.auth.count("refresh")).toBe(refreshesBefore);
    expect(env.jar.who()).toBe("C"); // not continued, not removed: the next sign-in re-anchors
  });
});

describe("A2 review: the keeper's upkeep loop (startSessionUpkeep)", () => {
  const stored = (tab: Tab) => {
    const st = tab.storage.readStoredSession();
    if (st.kind !== "present") throw new Error("no session stored");
    return st.envelope;
  };
  const fakeClient = (answer: (args?: unknown) => Promise<{ error: unknown }>) => ({ auth: { refreshSession: vi.fn(answer) } });

  it("acts only while the page is visible (a hidden tab keeps no session alive it would not have kept)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    vi.setSystemTime(((stored(x).expiresAt as number) - 200) * 1000); // inside the lead
    env.jar.doc.visibilityState = "hidden";
    const client = fakeClient(async () => ({ error: null }));
    const stop = keeper.startSessionUpkeep(client);
    await advance(60 * SECOND);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(0);
    env.jar.doc.visibilityState = "visible";
    await advance(16 * SECOND);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(client.auth.refreshSession.mock.calls[0][0]).toEqual({ refresh_token: stored(x).refreshToken });
    stop();
    env.jar.doc.visibilityState = "hidden";
  });

  it("a device clock far ahead (every token looks due at once) still makes at most one keeper refresh per half lifetime", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    vi.setSystemTime(((stored(x).expiresAt as number) + 3600) * 1000); // an hour past expiry by this device's clock
    env.jar.doc.visibilityState = "visible";
    const client = fakeClient(async () => ({ error: null })); // the jar keeps the same (still "due") token
    const stop = keeper.startSessionUpkeep(client);
    await advance(10 * 60 * SECOND);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
    await advance(21 * 60 * SECOND); // past 30 min (half of the 1 h lifetime) since the first
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(2);
    stop();
    env.jar.doc.visibilityState = "hidden";
  });

  it("one refresh at a time: a refresh that never answers is never stacked, even once its spacing has passed", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const keeper = await import("@/components/navigation/SessionKeeper");
    vi.setSystemTime(((stored(x).expiresAt as number) + 3600) * 1000); // every token due at once (a clock far ahead)
    env.jar.doc.visibilityState = "visible";
    const client = fakeClient(() => new Promise(() => undefined));
    const stop = keeper.startSessionUpkeep(client);
    await advance(32 * 60 * SECOND); // past the 30 min spacing: only the pending refresh holds the next one back
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
    stop();
    env.jar.doc.visibilityState = "hidden";
  });

  it("the one-time binding refresh of an unbound jar is retried after a failure, at most three attempts per page", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    env.jar.store.delete("swingproai-session-binding");
    const keeper = await import("@/components/navigation/SessionKeeper");
    env.jar.doc.visibilityState = "visible";
    const client = fakeClient(async () => ({ error: { name: "AuthRetryableFetchError" } }));
    const stop = keeper.startSessionUpkeep(client);
    await advance(2 * 60 * SECOND);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(3);
    stop();
    env.jar.doc.visibilityState = "hidden";
  });
});

describe("A2 review: End Session edge states, anonymous requests and malformed intents", () => {
  const lineageOf = (sid: string) => createHash("sha256").update(`swingproai-session-lineage:${sid}`).digest("hex");

  it("a browser without SubtleCrypto (an insecure context) ends nothing here and never reloads: unavailable (the server judges), no lock, no logout", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const lineage = lineageOf(env.auth.latest("A").sid);
    const platform = globalThis.crypto;
    vi.stubGlobal("crypto", Object.create(platform, { subtle: { value: undefined } }));
    const grants = env.lockMgr.grants.length;
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, lineage))).toBe("unavailable");
    vi.stubGlobal("crypto", platform);
    expect(env.lockMgr.grants.length).toBe(grants);
    expect(env.auth.count("logout")).toBe(0);
    expect(env.jar.who()).toBe("A");
  });

  it("a jar holding no usable session (an ambiguous layout no request can revoke) is removed but reported as ended_unconfirmed, never as a confirmed end", async () => {
    const x = await openTab("X"); // nothing recorded in this browser yet: the jar decides
    env.jar.store.set(KEY, encodeURIComponent("{}"));
    env.jar.store.set(`${KEY}.0`, encodeURIComponent("{}"));
    expect(env.jar.who()).toBe("ambiguous");
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id))).toBe("ended_unconfirmed");
    expect(env.jar.family()).toEqual([]);
    expect(env.auth.count("logout")).toBe(0);
  });

  it("the shared client never sends a data request with only the anonymous key: no session means nothing is sent (fixed message), a session's request goes out with its token", async () => {
    const x = await openTab("X");
    const restBefore = env.auth.st.sent.filter((e) => e.kind === "rest").length;
    const anon = await drive(Promise.resolve(x.client().from("user_drills").select("drill_id")));
    expect(anon.error?.message).toBe("You're not signed in on this device right now, so nothing was sent. Sign in again to continue.");
    expect(anon.status).toBe(401);
    const upload = await drive(x.client().storage.from("swing-videos").upload("anon/x.mp4", new Blob(["x"]), { upsert: false }));
    expect(upload.error).not.toBeNull();
    expect(env.auth.st.sent.filter((e) => e.kind === "rest" || e.kind === "other").length).toBe(restBefore);
    expect(diag(x).anonymousRefused).toBe(2);
    await signedIn("A", x);
    const own = await drive(Promise.resolve(x.client().from("user_drills").select("drill_id")));
    expect(own.error).toBeNull();
    expect(env.auth.st.sent.filter((e) => e.kind === "rest").at(-1)?.bearer).toBe("A#1");
  });

  it("a malformed or duplicated END INTENT is no instruction: none, no lock, nothing removed", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const good = lineageOf(env.auth.latest("A").sid);
    const login = await openTab("L");
    const grants = env.lockMgr.grants.length;
    for (const value of [good.toUpperCase(), good.slice(1), `${good}0`, "z".repeat(64), ""]) {
      env.jar.doc.cookie = `swingproai-session-ended=${value}; Path=/`;
      expect(login.publication.endIntentPending()).toBe(false);
      expect(await drive(login.publication.completeEndedSession())).toBe("none");
    }
    env.jar.showView(`${env.jar.snapshot()}; swingproai-session-ended=${good}; swingproai-session-ended=${good}`); // a duplicate (e.g. a Domain variant)
    expect(await drive(login.publication.completeEndedSession())).toBe("none");
    env.jar.thawView();
    expect(env.lockMgr.grants.length).toBe(grants);
    expect(env.jar.who()).toBe("A");
  });
});

describe("A3 (F3): End Session hands a refreshed session to the SDK only for the lineage being ended", () => {
  const lineageOf = (sid: string) => createHash("sha256").update(`swingproai-session-lineage:${sid}`).digest("hex");
  /**
   * A mixed jar: `accessOf`'s (expiring) access token, user and expiry beside `refreshOf`'s current refresh token, as one
   * envelope. Its refresh token is the recorded lineage, so the browser trusts the view; its access token passes the
   * page's account and lineage checks. Written as a writer would write a bare value (no binding change).
   */
  function writeMixed(accessOf: { access: string; who: Who }, refreshOf: { refresh: string }) {
    const value = JSON.stringify({
      access_token: accessOf.access,
      token_type: "bearer",
      expires_in: 60,
      expires_at: Math.floor(Date.now() / SECOND) + 60, // inside the SDK's 90 s margin: signOut's load refreshes it
      refresh_token: refreshOf.refresh,
      user: { id: GOLFERS[accessOf.who].id, aud: "authenticated", role: "authenticated", email: GOLFERS[accessOf.who].email, app_metadata: {}, user_metadata: {} },
    });
    for (const name of env.jar.family()) env.jar.store.delete(name);
    env.jar.store.set(KEY, encodeURIComponent(value));
  }

  for (const [label, other] of [
    ["another account's refresh token (expired A access + B refresh)", "B"],
    ["a newer sign-in of the SAME account (A's later lineage's refresh token)", "A"],
  ] as const) {
    it(`${label}: the refresh returns that other sign-in; it is never stored or logged out with, nothing of it is revoked; the mixed jar is removed here and the outcome is ended_unconfirmed`, async () => {
      const x = await openTab("X");
      await signedIn("A", x, { expiring: true });
      const aSession = env.auth.latest("A");
      const renderedFor = lineageOf(aSession.sid);
      const y = await openTab("Y");
      expect(await signIn(y, other)).toBe("signed_in"); // its refresh token is now the recorded lineage
      const otherSession = env.auth.latest(other);
      expect(otherSession.sid).not.toBe(aSession.sid);
      writeMixed({ access: aSession.access, who: "A" }, otherSession);
      const before = env.auth.st.sent.length;
      const outcome = await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, renderedFor));
      const traffic = env.auth.st.sent.slice(before).filter((s) => s.kind === "refresh" || s.kind === "logout");
      // exactly one refresh, presenting the other sign-in's token (it may now be rotated at Auth), and NO logout at all
      expect(traffic.map((s) => [s.kind, s.presented])).toEqual([["refresh", otherSession.label]]);
      expect(env.auth.st.revoked.has(otherSession.sid)).toBe(false);
      expect(env.auth.st.revoked.has(aSession.sid)).toBe(false); // A's revocation was never reached: honest outcome below
      expect(outcome).toBe("ended_unconfirmed");
      // what the refresh returned was never stored (the other sign-in's new tokens appear nowhere in the jar)
      const rotated = env.auth.latest(other);
      expect(env.jar.snapshot()).not.toContain(rotated.refresh);
      expect(env.jar.family()).toEqual([]);
      expect(diag(x).revocationNotReached).toBeGreaterThanOrEqual(1);
      trafficWithinCaps();
    });
  }

  it("control: a consistent expiring A (the same lineage) is refreshed inside the end section and logged out with the refreshed token — ended", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const renderedFor = lineageOf(env.auth.latest("A").sid);
    const before = env.auth.st.sent.length;
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, renderedFor))).toBe("ended");
    expect(env.auth.st.sent.slice(before).filter((s) => s.kind === "refresh" || s.kind === "logout").map((s) => [s.kind, s.presented])).toEqual([
      ["refresh", "A#1"],
      ["logout", "A#2"],
    ]);
    expect(env.jar.family()).toEqual([]);
    trafficWithinCaps();
  });

  it("a refreshed answer that names no session id cannot be matched to the lineage: never handed over, no logout", async () => {
    const x = await openTab("X");
    await signedIn("A", x, { expiring: true });
    const renderedFor = lineageOf(env.auth.latest("A").sid);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const exp = Math.floor(Date.now() / SECOND) + 3600;
    const anonymousSid = `${b64({ alg: "HS256" })}.${b64({ sub: GOLFERS.A.id, exp })}.${randomBytes(8).toString("base64url")}`;
    env.auth.st.refreshAnswer = () => json(200, { access_token: anonymousSid, refresh_token: "synthetic-unnamed", expires_in: 3600, expires_at: exp, token_type: "bearer", user: { id: GOLFERS.A.id } });
    const before = env.auth.st.sent.length;
    expect(await drive(x.publication.endSessionInBrowser(GOLFERS.A.id, undefined, renderedFor))).toBe("ended_unconfirmed");
    expect(env.auth.st.sent.slice(before).filter((s) => s.kind === "logout")).toEqual([]);
    expect(env.jar.snapshot()).not.toContain("synthetic-unnamed");
  });
});

describe("A4 (C1): a page's requests carry an explicit owner credential; A3's cookie-only sender and its lease section are retired", () => {
  // A3's cookie-session sender (an XHR held under a "dispatch" lease section until sent) existed only because
  // /api/analyze-swing read the session cookie alone. A4 gives that route Bearer ingress (resolveRouteAuth), so the
  // Analyze page and the report send the owner's confirmed token with `credentials: "omit"` instead; the sender, its
  // preflight, its marked refusals and the lease's "dispatch" kind had no remaining caller and were removed. Its tests
  // (FakeXHR schedules) are retargeted here to the replacement contract on the same real multi-tab stack.
  it("the token an owner request carries is fixed at its confirmation: B published afterwards (another tab, before this tab is told) cannot change it; a confirmation made after B refuses as account_changed and hands out no token; no lease is held across the request", async () => {
    const { confirmOwnerSession, ownerBearer } = await import("@/lib/drill-hub-session");
    const x = await openTab("X");
    await signedIn("A", x);
    const y = await openTab("Y");
    const confirmed = await drive(confirmOwnerSession(() => x.client(), GOLFERS.A.id));
    expect(confirmed.status).toBe("ready");
    if (confirmed.status !== "ready") return;
    const header = ownerBearer(confirmed.session).Authorization;
    expect(header).toBe(`Bearer ${env.auth.latest("A").access}`);
    expect(x.lease.activeSection()).toBeNull(); // nothing is held for the request (it may run as long as the analysis)
    // B signs in elsewhere; this tab's subscriber has not been told yet when its request is built
    await drive(y.publication.signInAndPublish(GOLFERS.B.email, PASSWORD));
    expect(env.jar.who()).toBe("B");
    const again = await drive(confirmOwnerSession(() => x.client(), GOLFERS.A.id));
    expect(again).toEqual({ status: "account_changed" }); // never B's token for A's page
    // and B's own page confirms B
    const forB = await drive(confirmOwnerSession(() => y.client(), GOLFERS.B.id));
    expect(forB.status === "ready" && ownerBearer(forB.session).Authorization).toBe(`Bearer ${env.auth.latest("B").access}`);
  });

  it("a page with no rendered owner confirms nothing, whatever the browser holds (no first-seen adoption)", async () => {
    const { confirmOwnerSession } = await import("@/lib/drill-hub-session");
    const x = await openTab("X");
    await signedIn("A", x);
    expect(await drive(confirmOwnerSession(() => x.client(), null))).toEqual({ status: "unconfirmed" });
  });

  it("the retired path is gone: no cookie sender, preflight or marked refusal is exported, the lease has no 'dispatch' kind, and a storage change runs inside whatever section is held", async () => {
    const x = await openTab("X");
    for (const name of ["cookieSessionRequests", "cookieSessionPreflight", "ownerRefusal", "ownerRefusalReason", "COOKIE_REQUEST_WAIT_MS", "COOKIE_REQUEST_SEND_MS"]) {
      expect(name in x.publication, name).toBe(false);
    }
    const { readFileSync } = await import("node:fs");
    const source = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(source("utils/supabase/session-lease.ts")).toContain('export type SectionKind = "refresh" | "publish" | "end" | "storage";');
    expect(source("utils/supabase/session-lease.ts")).not.toContain('"dispatch"');
    expect(source("utils/supabase/session-storage.ts")).toContain("  if (current !== null) return work(current);");
    expect(source("utils/supabase/session-publication.ts")).not.toMatch(/XMLHttpRequest|sendWhileHeld|enterSection\("dispatch"/);
    for (const caller of ["app/(dashboard)/analyze/page.tsx", "app/(dashboard)/analyze/[id]/AnalysisReport.tsx"]) {
      const page = source(caller);
      expect(page, caller).not.toMatch(/cookieSessionRequests|cookieSessionPreflight|ownerRefusalReason/);
      // P4 (retargeted): the Analyze page sends it through the sender (default branch: credentials "omit", asserted in
      // lib/analyze-auth-session.test.ts); the saved report (AnalysisReport.tsx) is unchanged
      const anchor = caller.endsWith("page.tsx") ? 'sendAppRequest("analyze", {' : 'fetch("/api/analyze-swing", {';
      const call = page.slice(page.indexOf(anchor), page.indexOf("body:", page.indexOf(anchor)));
      expect(page.indexOf(anchor), caller).toBeGreaterThan(-1);
      if (caller.endsWith("page.tsx")) expect(call, caller).not.toContain("credentials:");
      else expect(call, caller).toContain('credentials: "omit"');
      expect(call, caller).toMatch(/\.\.\.ownerBearer\((analysisSession|confirmed)\.session\)/);
    }
  });
});

describe("A3 (F1): the dashboard layout's rendered account reaches its client pages (RenderedSessionProvider)", () => {
  it("useRenderedSession gives the provider's verified owner and lineage below it, and null outside it; the layout wraps every page in it", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    (globalThis as Record<string, unknown>).React = React; // vitest compiles TSX with the classic runtime
    const keeper = await import("@/components/navigation/SessionKeeper");
    function Probe() {
      return React.createElement("output", null, JSON.stringify(keeper.useRenderedSession()));
    }
    const inside = renderToStaticMarkup(
      React.createElement(
        keeper.RenderedSessionProvider as unknown as React.ComponentType<{ ownerId: string; lineage: string | null; children?: React.ReactNode }>,
        { ownerId: GOLFERS.A.id, lineage: "f".repeat(64) },
        React.createElement(Probe),
      ),
    );
    expect(inside).toBe(`<output>${JSON.stringify({ ownerId: GOLFERS.A.id, lineage: "f".repeat(64) }).replace(/"/g, "&quot;")}</output>`);
    expect(renderToStaticMarkup(React.createElement(Probe))).toBe("<output>null</output>");
    const { readFileSync } = await import("node:fs");
    const layout = readFileSync(new URL("../app/(dashboard)/layout.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // AG-WEB-READY-04 F1: the layout wraps its whole account-bearing shell (sidebar, phone/tablet navigation and the page)
    // in RenderedSessionBoundary, which provides exactly this RenderedSessionProvider to everything below it
    expect(layout).toContain('import SessionKeeper from "@/components/navigation/SessionKeeper";');
    expect(layout).toContain('import RenderedSessionBoundary from "@/components/navigation/RenderedSessionBoundary";');
    expect(layout).toMatch(/<SessionKeeper \/>[\s\S]*<RenderedSessionBoundary ownerId=\{user\.id\} lineage=\{endSessionLineage\}>[\s\S]*<aside[\s\S]*<MobileDashboardNavigation[\s\S]*<main[\s\S]*\{children\}\s*<\/main>\s*<\/RenderedSessionBoundary>\s*<\/div>/);
    // the verified owner comes from the server's own verification, the lineage from the same token; no token is passed
    expect(layout).toContain("const session = await getServerSession();");
    const element = layout.match(/<RenderedSessionBoundary[^>]*>/g) ?? [];
    expect(element).toEqual(["<RenderedSessionBoundary ownerId={user.id} lineage={endSessionLineage}>"]);
    expect(layout).not.toMatch(/<RenderedSessionProvider/); // provided by the boundary, not twice
    const boundary = readFileSync(new URL("../components/navigation/RenderedSessionBoundary.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(boundary).toContain('import { RenderedSessionProvider } from "@/components/navigation/SessionKeeper";');
    expect(boundary).toMatch(/<RenderedSessionProvider ownerId=\{ownerId\} lineage=\{lineage\}>\s*\{children\}\s*<\/RenderedSessionProvider>/);
  });
});

describe("A4 (C4): the session is stored with expires_at: null — a previous bundle's SDK never refreshes it by itself; current readers use the access token's exp", () => {
  const BINDING = "swingproai-session-binding";
  /** The stored session value, parsed (the jar's own bytes, as every bundle reads them). */
  const storedObject = () => {
    const layout = readSessionLayout(parseCookieHeader(env.jar.snapshot()), KEY);
    if (layout.kind !== "present") throw new Error(`no session stored (${layout.kind})`);
    return JSON.parse(layout.value) as Record<string, unknown>;
  };
  const expOf = (access: string) => (JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()) as { exp: number }).exp;
  /** Rewrites the stored value in place (keeping its binding): models what a jar holds in another representation. */
  const rewriteStored = (next: Record<string, unknown>) => {
    env.jar.store.set(KEY, encodeURIComponent(JSON.stringify(next)));
  };
  /**
   * A tab still running the PREVIOUS bundle: @supabase/ssr 0.3.0's createBrowserClient (a fresh module instance, so its
   * own singleton) with HEAD's cookie adapter (utils/supabase/client.ts at c637771e: parse/serialize on document.cookie,
   * 30-day session cookies, Max-Age=0 removals), auth-js 2.107.0 with its defaults (no lock, auto refresh, persist).
   */
  async function previousBundleTab() {
    const ssr = freshSsr();
    const parse = ssr.parse as (s: string) => Record<string, string>;
    const serialize = ssr.serialize as (n: string, v: string, o: Record<string, unknown>) => string;
    const session = (name: string) => name === KEY || /^sb-127-auth-token\.\d+$/.test(name);
    const client = ssr.createBrowserClient(SUPABASE, ANON, {
      cookies: {
        get: (name: string) => parse(document.cookie)[name],
        set: (name: string, value: string, options: Record<string, unknown>) => {
          document.cookie = session(name) ? serialize(name, value, { path: "/", sameSite: "lax", secure: false, maxAge: 2_592_000 }) : serialize(name, value, options);
        },
        remove: (name: string, options: Record<string, unknown>) => {
          document.cookie = session(name) ? serialize(name, "", { path: "/", sameSite: "lax", secure: false, maxAge: 0 }) : serialize(name, "", { ...options, maxAge: 0 });
        },
      },
    }) as { auth: { initialize(): Promise<unknown>; getSession(): Promise<{ data: { session: { access_token: string; expires_at?: number } | null }; error: unknown }>; startAutoRefresh(): Promise<void>; stopAutoRefresh(): Promise<void> } };
    await drive(client.auth.initialize());
    return client;
  }
  /** Fake time jumped forward (Date and the timers), in steps, so tickers fire as they would. */
  async function travel(ms: number, step = 5_000) {
    for (let t = 0; t < ms; t += step) {
      await vi.advanceTimersByTimeAsync(Math.min(step, ms - t)); // the clock AND every timer due meanwhile (the ticker)
      await flush(4);
    }
    await flush();
  }

  it("the current writer stores the key with value null (the published session, and every refresh); every current reader reconstructs the expiry from the access token's exp", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const first = storedObject();
    expect("expires_at" in first).toBe(true);
    expect(first.expires_at).toBeNull();
    const access = first.access_token as string;
    expect(x.storage.readStoredSession().kind).toBe("present"); // the key is there: auth-js's validity check holds
    const envelope = (x.storage.readStoredSession() as { envelope: { expiresAt: number | null } }).envelope;
    expect(envelope.expiresAt).toBe(expOf(access)); // the reconstructed expiry (middleware, keeper, transport)
    // the SDK is handed the token's expiry
    const read = await drive(x.client().auth.getSession());
    expect(read.data.session?.expires_at).toBe(expOf(access));
    // a refresh of the current tab stores the new session the same way
    vi.setSystemTime(expOf(access) * 1000 - 30_000);
    const refreshesBefore = env.auth.count("refresh");
    const after = await drive(x.client().auth.getSession());
    expect(env.auth.count("refresh") - refreshesBefore).toBe(1);
    const second = storedObject();
    expect([second.access_token === access, "expires_at" in second, second.expires_at]).toEqual([false, true, null]);
    expect(after.data.session?.access_token).toBe(second.access_token);
    expect(after.data.session?.expires_at).toBe(expOf(second.access_token as string));
    // read again: far from expiry now — no further refresh (bounded: one request per expiry)
    await drive(x.client().auth.getSession());
    expect(env.auth.count("refresh") - refreshesBefore).toBe(1);
    expect((await bindingAdmits(parseCookieHeader(env.jar.snapshot()), second.access_token as string))).toBe("bound");
    trafficWithinCaps();
  });

  it("a previous bundle's tab keeps the null-stored session and never refreshes it — not at start-up, not on reads past its expiry, not on its ticker — so it writes nothing; its reads hand out the stored (expired) token, which every server refuses", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const before = env.jar.snapshot();
    const access = storedObject().access_token as string;
    const old = await previousBundleTab();
    const refreshesBefore = env.auth.count("refresh");
    expect((await drive(old.auth.getSession())).data.session?.access_token).toBe(access);
    // past the token's expiry, with the old tab's ticker running (visible: auth-js refreshes at <= 3 ticks of 30 s)
    vi.setSystemTime(expOf(access) * 1000 - 200_000);
    await drive(old.auth.startAutoRefresh());
    await travel(260_000);
    const late = await drive(old.auth.getSession());
    await drive(old.auth.stopAutoRefresh());
    expect(late.error).toBeNull();
    expect(late.data.session?.access_token).toBe(access); // kept, never removed, never renewed
    expect(env.auth.count("refresh") - refreshesBefore).toBe(0);
    expect(env.jar.snapshot()).toBe(before); // nothing written: the binding still vouches for this writer's session
    expect(env.jar.writes.filter((w) => w.who !== "A")).toEqual([]);
  });

  it("positive control: the SAME schedule with a numeric stored expiry (the jar as it was before this writer, or this experiment reverted) makes the previous bundle's tab refresh and write by itself — a write the binding no longer vouches for", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const stored = storedObject();
    const access = stored.access_token as string;
    rewriteStored({ ...stored, expires_at: expOf(access) }); // numeric, same tokens, same binding
    const old = await previousBundleTab();
    const refreshesBefore = env.auth.count("refresh");
    vi.setSystemTime(expOf(access) * 1000 - 200_000);
    await drive(old.auth.startAutoRefresh());
    await travel(260_000);
    await drive(old.auth.stopAutoRefresh());
    expect(env.auth.count("refresh") - refreshesBefore).toBe(1); // the old automatic refresh (its ticker) …
    const written = storedObject();
    expect(written.access_token).not.toBe(access); // … and its write
    expect(typeof written.expires_at).toBe("number");
    expect(await bindingAdmits(parseCookieHeader(env.jar.snapshot()), written.access_token as string)).toBe("mismatch"); // unbound: refused
    trafficWithinCaps();
  });

  it("deleting the key instead is unsafe: the previous bundle's SDK finds no expires_at, takes the stored session for invalid and REMOVES it (a removal, not a retirement)", async () => {
    const x = await openTab("X");
    await signedIn("A", x);
    const { expires_at: _dropped, ...withoutKey } = storedObject();
    rewriteStored(withoutKey);
    expect(x.storage.readStoredSession().kind).toBe("unusable"); // the current reader refuses it too
    const old = await previousBundleTab();
    const read = await drive(old.auth.getSession());
    expect(read.data.session).toBeNull();
    expect(env.jar.family()).toEqual([]); // the old SDK removed the session cookies
    expect(env.jar.store.has(BINDING)).toBe(true); // (the binding is not the old SDK's to remove)
  });

  it("a refresh answered from the jar (another tab already rotated the token) states the stored token's own expiry, never 'expires now', so the SDK does not take it for expiring", async () => {
    const x = await openTab("X");
    const y = await openTab("Y");
    await signedIn("A", x);
    const spent = storedObject().refresh_token as string;
    vi.setSystemTime(expOf(storedObject().access_token as string) * 1000 - 30_000);
    await drive(x.client().auth.getSession()); // X rotates it
    const now = storedObject();
    const refreshesBefore = env.auth.count("refresh");
    const answered = await drive(y.client().auth.refreshSession({ refresh_token: spent })); // Y still names the spent token
    expect(env.auth.count("refresh") - refreshesBefore).toBe(0); // answered from the jar, no request
    expect(answered.error).toBeNull();
    expect(answered.data.session?.access_token).toBe(now.access_token);
    expect(answered.data.session?.expires_at).toBe(expOf(now.access_token as string));
  });

  it("the direct publication (this device's clock already past the new token's expiry: publishDirect) stores the key with value null too", async () => {
    const x = await openTab("X");
    env.auth.st.skew = true; // Auth issues a token whose exp this device's clock has already passed
    try {
      expect(await signIn(x, "A")).toBe("signed_in");
    } finally {
      env.auth.st.skew = false;
    }
    const stored = storedObject();
    expect(["expires_at" in stored, stored.expires_at]).toEqual([true, null]);
    expect(x.storage.readStoredSession().kind).toBe("present");
    expect(await bindingAdmits(parseCookieHeader(env.jar.snapshot()), stored.access_token as string)).toBe("bound");
  });
});
