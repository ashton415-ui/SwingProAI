import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RequestCookies, ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";

// AG-SESSION-03: the browser session-cookie policy of utils/supabase/client.ts, driven through the real installed
// @supabase/ssr 0.3.0 browser client and supabase-js/auth-js 2.107.0.
//
// Controlled surface (test-only; nothing here is a product hook):
// - window/document/location are stubbed per test. document.cookie is a small browser-like cookie store (`Jar`): it
//   records every serialized write, honours Max-Age (0 deletes; capped at 400 days like Chrome), keeps one entry per
//   name/path/domain, ignores Secure writes from an http page and HttpOnly writes from script, and returns
//   "name=value" pairs in creation order. BroadcastChannel is absent (it only carries cross-tab notifications).
// - The platform fetch is an in-memory synthetic Auth stand-in (password and refresh grants, logout, recover, user).
//   Tokens are random per run and never leave memory; observations carry names, attributes, counts and booleans.
// - "@supabase/ssr" is wrapped only to record which cookie methods the factory hands the SDK and each call the SDK
//   makes to them; every call goes to a fresh copy of the real installed module (fresh per test, so the SDK's own
//   browser singleton starts empty), with the same arguments.
//
// Every case ends in judge(): the failure message carries the case's JSON observation, so a control run against the
// unchanged factory is judged on named checks with a non-empty observation (harness/control-unit-s03.py).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

type CookieMethods = Record<string, unknown>;
type AdapterCall = { op: "get" | "set" | "remove"; name: string; browser: boolean; options?: Record<string, unknown>; value?: string; found?: boolean };
type SsrModule = {
  createBrowserClient: (url: string, key: string, options?: Record<string, unknown>) => SbClient;
  isBrowser: () => boolean;
  parse: (s: string) => Record<string, string>;
  serialize: (name: string, value: string, options?: Record<string, unknown>) => string;
  createChunks: (key: string, value: string) => { name: string; value: string }[];
  DEFAULT_COOKIE_OPTIONS: Record<string, unknown>;
};
// the slice of the real client these tests drive
type SbSession = { access_token: string; refresh_token: string; expires_at?: number; user?: { user_metadata?: Record<string, unknown> } };
type SbAuth = {
  initialize: () => Promise<unknown>;
  getSession: () => Promise<{ data: { session: SbSession | null }; error: unknown }>;
  signInWithPassword: (c: { email: string; password: string }) => Promise<{ data: { session: SbSession | null }; error: unknown }>;
  refreshSession: () => Promise<{ data: { session: SbSession | null }; error: unknown }>;
  signOut: () => Promise<{ error: unknown }>;
  resetPasswordForEmail: (email: string) => Promise<{ error: unknown }>;
  dispose?: () => Promise<void> | void;
  stopAutoRefresh?: () => Promise<void>;
};
type SbClient = { auth: SbAuth };

const cap = vi.hoisted(() => ({
  real: null as unknown as SsrModule,
  factoryCookieMethods: [] as string[][],
  adapter: [] as AdapterCall[],
  adapters: [] as CookieMethods[],
  clients: [] as SbClient[],
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (url: string, key: string, options?: Record<string, unknown>) => {
    const cookies = ((options?.cookies as CookieMethods | undefined) ?? {}) as Record<string, (...a: unknown[]) => unknown>;
    cap.factoryCookieMethods.push(Object.keys(cookies).sort());
    const wrapped: Record<string, unknown> = { ...cookies };
    const browser = () => typeof window !== "undefined";
    if (typeof cookies.get === "function") {
      wrapped.get = (name: string) => {
        const r = cookies.get(name);
        cap.adapter.push({ op: "get", name, browser: browser(), found: r !== undefined && r !== null });
        return r;
      };
    }
    if (typeof cookies.set === "function") {
      wrapped.set = (name: string, value: string, o: Record<string, unknown>) => {
        cap.adapter.push({ op: "set", name, browser: browser(), options: { ...o }, value });
        return cookies.set(name, value, o);
      };
    }
    if (typeof cookies.remove === "function") {
      wrapped.remove = (name: string, o: Record<string, unknown>) => {
        cap.adapter.push({ op: "remove", name, browser: browser(), options: { ...o } });
        return cookies.remove(name, o);
      };
    }
    cap.adapters.push(wrapped);
    const client = cap.real.createBrowserClient(url, key, { ...options, cookies: wrapped });
    cap.clients.push(client);
    return client;
  },
  createServerClient: (...a: unknown[]) => (cap.real as unknown as { createServerClient: (...x: unknown[]) => unknown }).createServerClient(...a),
  isBrowser: () => cap.real.isBrowser(),
  parse: (s: string) => cap.real.parse(s),
  serialize: (name: string, value: string, options?: Record<string, unknown>) => cap.real.serialize(name, value, options),
  createChunks: (key: string, value: string) => cap.real.createChunks(key, value),
}));

/** A fresh copy of the real installed @supabase/ssr (its browser singleton is module state). */
function freshSsr(): SsrModule {
  const p = requireFromHere.resolve("@supabase/ssr");
  delete requireFromHere.cache[p];
  return requireFromHere(p) as SsrModule;
}

// ── constants (synthetic only) ──────────────────────────────────────────────────────────────────────────────
const LOOPBACK_SUPABASE = "http://127.0.0.1:54329"; // never contacted: fetch is the in-memory stand-in
const HOSTED_SHAPED_SUPABASE = "https://synthetic-ref.supabase.invalid";
const HTTP_PAGE = "http://127.0.0.1:3941";
const HTTPS_PAGE = "https://app.example.invalid";
const ANON = "synthetic-anon-key-not-a-secret";
const GOLFER = "00000000-0000-4000-8000-0000000000a3";
const EMAIL = "golfer@example.invalid";
const PASSWORD = "synthetic-password-not-a-secret";
const SESSION_MAX_AGE = "2592000";
const DAY_MS = 86_400_000;
const keyFor = (url: string) => `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 15));
};

// every synthetic token issued in this run (in memory; observations are checked against them)
const ISSUED: string[] = [];

// ── the controlled cookie surface ───────────────────────────────────────────────────────────────────────────
type Parsed = { name: string; value: string; attrs: Record<string, string> };
type Write = Parsed & { raw: string; accepted: boolean; reason: string | null; at: number };
type Entry = { name: string; value: string; attrs: Record<string, string>; expiresAt: number | null; created: number };
function parseRaw(raw: string): Parsed {
  const parts = raw.split(";");
  const pair = parts[0];
  const eq = pair.indexOf("=");
  const attrs: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    const k = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    if (k) attrs[k] = i === -1 ? "" : p.slice(i + 1).trim();
  }
  return { name: (eq === -1 ? "" : pair.slice(0, eq)).trim(), value: (eq === -1 ? pair : pair.slice(eq + 1)).trim(), attrs };
}
class Jar {
  readonly writes: Write[] = [];
  private readonly store = new Map<string, Entry>();
  private seq = 0;
  reads = 0;
  constructor(readonly https: boolean, readonly host: string) {}
  /** a document.cookie write from script */
  write(raw: string) {
    const w: Write = { ...parseRaw(raw), raw, accepted: false, reason: null, at: Date.now() };
    this.writes.push(w);
    this.apply(w);
  }
  /** a cookie that is already in the jar before the test (planted; not a write under test) */
  plant(raw: string) {
    this.apply({ ...parseRaw(raw), raw, accepted: false, reason: null, at: Date.now() });
  }
  private apply(w: Write) {
    const reject = (reason: string) => {
      w.reason = reason;
    };
    if (!w.name) return reject("no-name");
    if ("secure" in w.attrs && !this.https) return reject("secure-from-http-page");
    if ("httponly" in w.attrs) return reject("httponly-from-script");
    if ("domain" in w.attrs) {
      const d = w.attrs.domain.replace(/^\./, "").toLowerCase();
      if (this.host !== d && !this.host.endsWith(`.${d}`)) return reject("domain-mismatch");
    }
    const id = `${w.name}|${w.attrs.path ?? "/"}|${w.attrs.domain ?? ""}`;
    const maxAge = w.attrs["max-age"] !== undefined ? Number(w.attrs["max-age"]) : null;
    const expires = w.attrs.expires !== undefined ? Date.parse(w.attrs.expires) : null;
    const now = Date.now();
    const expiresAt = maxAge !== null && Number.isFinite(maxAge)
      ? now + Math.min(maxAge, 400 * 86_400) * 1000
      : expires !== null && Number.isFinite(expires) ? Math.min(expires, now + 400 * DAY_MS) : null;
    w.accepted = true;
    if (expiresAt !== null && expiresAt <= now) {
      this.store.delete(id);
      return;
    }
    const old = this.store.get(id);
    this.store.set(id, { name: w.name, value: w.value, attrs: w.attrs, expiresAt, created: old ? old.created : ++this.seq });
  }
  private live(): Entry[] {
    const now = Date.now();
    const out: Entry[] = [];
    this.store.forEach((e, id) => {
      if (e.expiresAt !== null && e.expiresAt <= now) this.store.delete(id);
      else out.push(e);
    });
    return out.sort((a, b) => a.created - b.created);
  }
  header(): string {
    this.reads += 1;
    return this.live().map((e) => `${e.name}=${e.value}`).join("; ");
  }
  entry(name: string): Entry | undefined {
    return this.live().find((e) => e.name === name);
  }
  names(): string[] {
    return this.live().map((e) => e.name);
  }
}

function installBrowser(page: string): Jar {
  const url = new URL("/login", page);
  const jar = new Jar(url.protocol === "https:", url.hostname);
  const doc = {
    get cookie() { return jar.header(); },
    set cookie(v: string) { jar.write(String(v)); },
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  const loc = { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port,
    pathname: url.pathname, search: url.search, hash: url.hash, assign() {}, replace() {}, reload() {} };
  const win = { document: doc, location: loc, addEventListener() {}, removeEventListener() {}, history: { state: null, replaceState() {} } };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", loc);
  vi.stubGlobal("BroadcastChannel", undefined);
  return jar;
}

// ── the synthetic Auth stand-in ─────────────────────────────────────────────────────────────────────────────
type Issued = { access: string; refresh: string; session: Record<string, unknown> };
type StandIn = ReturnType<typeof standIn>;
function standIn(supabaseUrl: string) {
  const origin = new URL(supabaseUrl).origin;
  const st = {
    issued: [] as Issued[],
    active: null as string | null,
    meta: {} as Record<string, unknown>,
    refreshMode: "grant" as "grant" | "reject" | "outage500",
    calls: [] as { kind: string; status: number; clientInfo: string | null }[],
    unexpected: 0,
  };
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function issue(expiresIn = 3600): Issued {
    const now = Math.floor(Date.now() / 1000);
    const access = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: GOLFER, exp: now + expiresIn, aud: "authenticated", role: "authenticated", session_id: randomUUID() })}.${randomUUID().replace(/-/g, "")}`;
    const refresh = `rt${randomUUID().replace(/-/g, "")}`;
    ISSUED.push(access, refresh);
    const session = { access_token: access, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: refresh,
      user: { id: GOLFER, aud: "authenticated", role: "authenticated", email: EMAIL, app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: st.meta, created_at: "2026-01-01T00:00:00Z" } };
    const i = { access, refresh, session };
    st.issued.push(i);
    st.active = refresh;
    return i;
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const call = { kind: "other", status: 0, clientInfo: req.headers.get("x-client-info") };
    st.calls.push(call);
    if (url.origin !== origin) {
      st.unexpected += 1;
      throw new TypeError("stand-in: request outside the synthetic Auth origin refused");
    }
    const body = req.method === "POST" ? await req.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) : {};
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const answer = (kind: string, r: Response) => {
      call.kind = kind;
      call.status = r.status;
      return r;
    };
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      if (body.email === EMAIL && body.password === PASSWORD) return answer("password", json(200, issue().session));
      return answer("password", json(400, { code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (st.refreshMode === "outage500") return answer("refresh", json(500, { code: "unexpected_failure", msg: "synthetic outage" }));
      if (st.refreshMode === "reject" || !st.active || body.refresh_token !== st.active)
        return answer("refresh", json(400, { code: "refresh_token_not_found", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }));
      return answer("refresh", json(200, issue().session));
    }
    if (url.pathname === "/auth/v1/logout") {
      st.active = null;
      return answer("logout", new Response(null, { status: 204 }));
    }
    if (url.pathname === "/auth/v1/recover") return answer("recover", json(200, {}));
    if (url.pathname === "/auth/v1/user") {
      const cur = st.issued[st.issued.length - 1];
      return answer("user", cur && bearer === cur.access ? json(200, cur.session.user) : json(401, { code: "bad_jwt", msg: "invalid JWT" }));
    }
    st.unexpected += 1;
    return answer("unexpected", json(404, { msg: "not found" }));
  }
  return {
    st,
    fetch: fetchFn,
    /** a session the stand-in knows (the active refresh token), as a near-expiry or fresh session object */
    seed(expiresInS: number) {
      const i = issue(3600);
      const now = Math.floor(Date.now() / 1000);
      i.session.expires_at = now + expiresInS;
      i.session.expires_in = expiresInS;
      return i;
    },
    count: (kind: string) => st.calls.filter((c) => c.kind === kind).length,
    last: () => st.issued[st.issued.length - 1],
  };
}

// ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────
type Booted = { jar: Jar; sb: StandIn; key: string; https: boolean; createClient: () => SbClient; isFamily: (n: string) => boolean };
/** envUrl: the exact NEXT_PUBLIC_SUPABASE_URL text, when it differs from the URL the stand-in answers (K1) */
async function boot({ page = HTTP_PAGE, supabaseUrl = LOOPBACK_SUPABASE, envUrl = null as string | null, meta = {} as Record<string, unknown>, plant = [] as string[] } = {}): Promise<Booted> {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", envUrl ?? supabaseUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  const jar = installBrowser(page);
  for (const raw of plant) jar.plant(raw);
  const sb = standIn(supabaseUrl);
  sb.st.meta = meta;
  vi.stubGlobal("fetch", sb.fetch);
  const mod = await import("@/utils/supabase/client");
  const key = keyFor(supabaseUrl);
  const isFamily = (n: string) => n === key || (n.startsWith(`${key}.`) && /^\d+$/.test(n.slice(key.length + 1)));
  return { jar, sb, key, https: page.startsWith("https:"), createClient: mod.createClient as unknown as () => SbClient, isFamily };
}
beforeEach(() => {
  cap.real = freshSsr();
  cap.factoryCookieMethods = [];
  cap.adapter = [];
  cap.adapters = [];
  cap.clients = [];
});
afterEach(async () => {
  await settle();
  const seen: SbClient[] = [];
  for (const c of cap.clients) {
    if (seen.indexOf(c) !== -1) continue;
    seen.push(c);
    try {
      if (typeof c.auth.dispose === "function") await c.auth.dispose();
      else await c.auth.stopAutoRefresh?.();
    } catch {
      // teardown only
    }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── raw cookie formats ──────────────────────────────────────────────────────────────────────────────────────
/** what the accepted factory's SDK default path writes (0.3.0 serialize with DEFAULT_COOKIE_OPTIONS) */
const controlFormat = (name: string, value: string) => cap.real.serialize(name, value, { ...cap.real.DEFAULT_COOKIE_OPTIONS });
/** the approved session policy, serialized */
const policyFormat = (name: string, value: string, secure: boolean) => cap.real.serialize(name, value, { path: "/", sameSite: "lax", secure, maxAge: 2592000 });
/** the AG-SESSION-02 server boundary's write (Next ResponseCookies with the boundary's options) */
function serverFormat(name: string, value: string, secure: boolean): string {
  const h = new Headers();
  new ResponseCookies(h).set(name, value, { path: "/", sameSite: "lax", secure, maxAge: 2592000 });
  return h.getSetCookie()[0];
}
const chunksOf = (key: string, value: string) => cap.real.createChunks(key, value);
const plantSession = (b: { key: string }, session: unknown, fmt: (n: string, v: string) => string) =>
  chunksOf(b.key, JSON.stringify(session)).map((c) => fmt(c.name, c.value));

// ── observations ────────────────────────────────────────────────────────────────────────────────────────────
function attrsOf(w: Write, isFamily: (n: string) => boolean) {
  return {
    name: w.name.replace(/^sb-[^.]+?-auth-token/, "<key>"), family: isFamily(w.name), valueLength: w.value.length,
    maxAge: w.attrs["max-age"] ?? null, path: w.attrs.path ?? null, sameSite: w.attrs.samesite?.toLowerCase() ?? null,
    secure: "secure" in w.attrs, httpOnly: "httponly" in w.attrs, domain: "domain" in w.attrs, expires: "expires" in w.attrs,
    accepted: w.accepted, rejected: w.reason,
  };
}
function familyWrites(b: Booted, from = 0) {
  return b.jar.writes.slice(from).filter((w) => b.isFamily(w.name));
}
const live = (ws: Write[]) => ws.filter((w) => w.attrs["max-age"] !== "0");
const removals = (ws: Write[]) => ws.filter((w) => w.attrs["max-age"] === "0");
function decodeJoined(b: Booted): { joined: string | null; session: SbSession | null } {
  const names = b.jar.names();
  const get = (n: string) => {
    const e = b.jar.entry(n);
    return e ? decodeURIComponent(e.value) : undefined;
  };
  let joined = names.indexOf(b.key) !== -1 ? get(b.key) ?? null : null;
  if (joined === null) {
    const parts: string[] = [];
    for (let i = 0; names.indexOf(`${b.key}.${i}`) !== -1; i++) parts.push(get(`${b.key}.${i}`) ?? "");
    joined = parts.length ? parts.join("") : null;
  }
  try {
    return { joined, session: joined ? (JSON.parse(joined) as SbSession) : null };
  } catch {
    return { joined, session: null };
  }
}
const policyAttrsHold = (ws: Write[]) => ({
  path_root: ws.length > 0 && ws.every((w) => w.attrs.path === "/"),
  samesite_lax: ws.length > 0 && ws.every((w) => (w.attrs.samesite ?? "").toLowerCase() === "lax"),
  no_domain: ws.every((w) => !("domain" in w.attrs)),
  no_httponly: ws.every((w) => !("httponly" in w.attrs)),
  no_expires_attribute: ws.every((w) => !("expires" in w.attrs)),
});
const jarExpiryDays = (b: Booted, n: string) => {
  const e = b.jar.entry(n);
  return e && e.expiresAt !== null ? Math.round(((e.expiresAt - Date.now()) / DAY_MS) * 100) / 100 : null;
};
const within30Days = (b: Booted, n: string) => {
  const e = b.jar.entry(n);
  return !!e && e.expiresAt !== null && Math.abs(e.expiresAt - Date.now() - 2_592_000_000) < 15_000;
};
function adapterSummary() {
  const c = { get: 0, set: 0, remove: 0 };
  for (const a of cap.adapter) c[a.op] += 1;
  return c;
}
function baseObs(b: Booted, ws: Write[]) {
  return {
    page: b.https ? "https" : "http", factoryCookieMethods: cap.factoryCookieMethods[0] ?? null, adapterCalls: adapterSummary(),
    familyWrites: ws.map((w) => attrsOf(w, b.isFamily)), maxAges: Array.from(new Set(ws.map((w) => w.attrs["max-age"] ?? "none"))),
    authCalls: b.sb.st.calls.map((c) => `${c.kind}:${c.status}`), unexpectedRequests: b.sb.st.unexpected,
  };
}
/** every live session write in `ws` came through the factory's adapter set() between two adapter-log marks, in order */
function adapterSawEvery(b: Booted, ws: Write[], from: number, to = cap.adapter.length) {
  const sets = cap.adapter.slice(from, to).filter((a) => a.op === "set" && b.isFamily(a.name));
  return ws.length >= 1 && sets.length === ws.length && sets.every((a, i) => a.name === ws[i].name);
}
function judge(name: string, checks: Record<string, boolean>, obs: Record<string, unknown>) {
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  const text = JSON.stringify({ case: name, failed, checks: Object.keys(checks), obs });
  expect(ISSUED.some((t) => text.includes(t) || text.includes(encodeURIComponent(t))), "an observation must carry no token value").toBe(false);
  expect(failed, `observed ${text}`).toEqual([]);
}
const CRED = { email: EMAIL, password: PASSWORD };

// ── A: the installed SDK calls the factory's 0.3.0 adapter ──────────────────────────────────────────────────
describe("AG-SESSION-03 browser session cookie policy (installed @supabase/ssr 0.3.0)", () => {
  it("A1 the installed SDK calls the factory's get/set/remove for sign-in, refresh and sign-out (HTTP)", async () => {
    const b = await boot();
    const client = b.createClient();
    await client.auth.initialize();
    const m0 = b.jar.writes.length;
    const a0 = cap.adapter.length;
    const signIn = await client.auth.signInWithPassword(CRED);
    await settle();
    const m1 = b.jar.writes.length;
    const a1 = cap.adapter.length;
    const refreshed = await client.auth.refreshSession();
    await settle();
    const m2 = b.jar.writes.length;
    const a2 = cap.adapter.length;
    await client.auth.signOut();
    await settle();
    const fam = (from: number, to: number) => b.jar.writes.slice(from, to).filter((w) => b.isFamily(w.name));
    const famSet = (from: number, to: number) => cap.adapter.slice(from, to).filter((a) => a.op === "set" && b.isFamily(a.name));
    const famRemove = (from: number) => cap.adapter.slice(from).filter((a) => a.op === "remove" && b.isFamily(a.name));
    const inSignIn = fam(m0, m1), inRefresh = fam(m1, m2), inSignOut = fam(m2, b.jar.writes.length);
    const allSets = cap.adapter.filter((a) => a.op === "set" && b.isFamily(a.name));
    judge("A1", {
      signed_in_and_refreshed: !signIn.error && !refreshed.error && b.sb.count("password") === 1 && b.sb.count("refresh") === 1,
      raw_family_write_on_sign_in: live(inSignIn).length >= 1,
      raw_family_write_on_refresh: live(inRefresh).length >= 1,
      raw_family_removal_on_sign_out: removals(inSignOut).length >= 1,
      factory_passes_the_0_3_0_adapter: JSON.stringify(cap.factoryCookieMethods[0]) === JSON.stringify(["get", "remove", "set"]),
      sdk_called_get: cap.adapter.some((a) => a.op === "get" && b.isFamily(a.name)),
      sdk_called_set_on_sign_in: famSet(a0, a1).length >= 1 && famSet(a0, a1).length === live(inSignIn).length,
      sdk_called_set_on_refresh: famSet(a1, a2).length >= 1 && famSet(a1, a2).length === live(inRefresh).length,
      sdk_called_remove_on_sign_out: famRemove(a2).length >= 1 && famRemove(a2).length === removals(inSignOut).length,
      sdk_overrides_max_age_in_set_options: allSets.length >= 1 && allSets.every((a) => a.options?.maxAge === cap.real.DEFAULT_COOKIE_OPTIONS.maxAge),
    }, { ...baseObs(b, familyWrites(b, m0)), phases: { signIn: inSignIn.length, refresh: inRefresh.length, signOut: inSignOut.length },
      sdkSetMaxAges: Array.from(new Set(allSets.map((a) => String(a.options?.maxAge)))) });
  });

  it("A3 on an HTTPS page the installed SDK calls the factory's set/remove for every chunk of sign-in, refresh and sign-out", async () => {
    const b = await boot({ page: HTTPS_PAGE, supabaseUrl: HOSTED_SHAPED_SUPABASE, meta: { pad: "q".repeat(7000) } });
    const client = b.createClient();
    await client.auth.initialize();
    const m0 = b.jar.writes.length;
    const a0 = cap.adapter.length;
    const signIn = await client.auth.signInWithPassword(CRED);
    await settle();
    const m1 = b.jar.writes.length;
    const a1 = cap.adapter.length;
    const refreshed = await client.auth.refreshSession();
    await settle();
    const m2 = b.jar.writes.length;
    const a2 = cap.adapter.length;
    const present = b.jar.names().filter(b.isFamily);
    await client.auth.signOut();
    await settle();
    const fam = (from: number, to: number) => b.jar.writes.slice(from, to).filter((w) => b.isFamily(w.name));
    const inSignIn = live(fam(m0, m1)), inRefresh = live(fam(m1, m2)), outs = removals(fam(m2, b.jar.writes.length));
    const removeCalls = cap.adapter.slice(a2).filter((a) => a.op === "remove" && b.isFamily(a.name)).map((a) => a.name);
    const sorted = (x: string[]) => JSON.stringify(x.slice().sort());
    judge("A3", {
      signed_in_and_refreshed: !signIn.error && !refreshed.error && b.sb.count("password") === 1 && b.sb.count("refresh") === 1,
      chunked_session: present.length >= 2,
      raw_family_writes_on_sign_in_and_refresh: inSignIn.length >= 2 && inRefresh.length >= 2,
      raw_removal_of_every_chunk_and_none_left: present.length >= 2 && sorted(outs.map((w) => w.name)) === sorted(present) && b.jar.names().filter(b.isFamily).length === 0,
      factory_passes_the_0_3_0_adapter: JSON.stringify(cap.factoryCookieMethods[0]) === JSON.stringify(["get", "remove", "set"]),
      sdk_called_set_for_every_sign_in_chunk: adapterSawEvery(b, inSignIn, a0, a1),
      sdk_called_set_for_every_refresh_chunk: adapterSawEvery(b, inRefresh, a1, a2),
      sdk_called_remove_for_every_chunk: present.length >= 2 && sorted(removeCalls) === sorted(present) && removeCalls.length === outs.length,
      removals_carry_path_lax_no_domain_and_secure_on_https: outs.length >= 2 && outs.every((w) => w.attrs.path === "/" && (w.attrs.samesite ?? "").toLowerCase() === "lax" &&
        !("domain" in w.attrs) && "secure" in w.attrs),
    }, { ...baseObs(b, fam(m0, b.jar.writes.length)), phases: { signIn: inSignIn.length, refresh: inRefresh.length, signOut: outs.length } });
  });

  it("A2 without a browser global the factory's adapter methods are inert (no document access, no throw)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOOPBACK_SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
    vi.stubGlobal("fetch", standIn(LOOPBACK_SUPABASE).fetch);
    const { createClient } = await import("@/utils/supabase/client");
    createClient();
    const a = cap.adapters[0] as Record<string, unknown>;
    const present = ["get", "set", "remove"].every((k) => typeof a[k] === "function");
    let threw = false;
    let got: unknown = "untouched";
    try {
      if (present) {
        got = (a.get as (n: string) => unknown)("sb-127-auth-token");
        (a.set as (n: string, v: string, o: object) => unknown)("sb-127-auth-token", "x", {});
        (a.remove as (n: string, o: object) => unknown)("sb-127-auth-token", {});
      }
    } catch {
      threw = true;
    }
    judge("A2", {
      adapter_present: present,
      no_throw_without_a_browser: !threw,
      get_returns_nothing_without_a_browser: present && got === undefined,
      no_browser_global_created: typeof window === "undefined" && typeof document === "undefined",
    }, { factoryCookieMethods: cap.factoryCookieMethods[0] ?? null, threw });
  });

  it("P1 SDK fact: the installed client overrides cookieOptions.maxAge on every write (so the factory sets it per write)", async () => {
    const b = await boot();
    const client = cap.real.createBrowserClient(LOOPBACK_SUPABASE, ANON, { cookieOptions: { maxAge: 2592000 } });
    cap.clients.push(client);
    await client.auth.initialize();
    const m = b.jar.writes.length;
    await client.auth.signInWithPassword(CRED);
    await settle();
    const ws = live(familyWrites(b, m));
    judge("P1", {
      wrote_session: ws.length >= 1,
      cookie_options_max_age_was_replaced_by_the_sdk_default: ws.every((w) => w.attrs["max-age"] === String(cap.real.DEFAULT_COOKIE_OPTIONS.maxAge)),
    }, baseObs(b, ws));
  });

  // ── W/R: serialized attributes for sign-in and near-expiry refresh, HTTP and HTTPS ─────────────────────────
  for (const [id, page, supabaseUrl] of [["W1", HTTP_PAGE, LOOPBACK_SUPABASE], ["W2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    const https = page === HTTPS_PAGE;
    it(`${id} sign-in on an ${https ? "HTTPS" : "HTTP"} page writes the session cookie with Max-Age=2592000, Path=/, SameSite=Lax${https ? ", Secure" : ", no Secure"}`, async () => {
      const b = await boot({ page, supabaseUrl });
      const client = b.createClient();
      await client.auth.initialize();
      const m = b.jar.writes.length;
      const a0 = cap.adapter.length;
      const r = await client.auth.signInWithPassword(CRED);
      await settle();
      const ws = live(familyWrites(b, m));
      const issued = b.sb.last();
      const { joined, session } = decodeJoined(b);
      const read = await client.auth.getSession();
      judge(id, {
        signed_in: !r.error && b.sb.count("password") === 1,
        wrote_session: ws.length >= 1 && ws.every((w) => w.accepted),
        adapter_saw_every_session_write: adapterSawEvery(b, ws, a0),
        max_age_2592000: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === SESSION_MAX_AGE),
        ...policyAttrsHold(ws),
        [https ? "secure_on_https" : "no_secure_on_http"]: ws.length >= 1 && ws.every((w) => ("secure" in w.attrs) === https),
        names_and_values_are_the_sdk_chunks_of_the_session: !!joined && JSON.stringify(chunksOf(b.key, joined)) ===
          JSON.stringify(ws.map((w) => ({ name: w.name, value: decodeURIComponent(w.value) }))),
        stored_session_is_the_granted_one: !!session && session.access_token === issued.access && session.refresh_token === issued.refresh,
        jar_expiry_30_days: ws.every((w) => within30Days(b, w.name)),
        ...(https ? { jar_entry_secure: ws.every((w) => "secure" in (b.jar.entry(w.name)?.attrs ?? {})) } : {}),
        readback_through_the_factory: read.data.session?.access_token === issued.access,
      }, { ...baseObs(b, ws), jarExpiryDays: ws.map((w) => jarExpiryDays(b, w.name)) });
    });
  }
  for (const [id, page, supabaseUrl] of [["R1", HTTP_PAGE, LOOPBACK_SUPABASE], ["R2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    const https = page === HTTPS_PAGE;
    it(`${id} the SDK's own near-expiry refresh on an ${https ? "HTTPS" : "HTTP"} page rewrites the session cookie with the policy`, async () => {
      const key = keyFor(supabaseUrl);
      const b = await boot({ page, supabaseUrl });
      const seeded = b.sb.seed(20); // expires within the SDK's 90 s margin
      for (const raw of plantSession({ key }, seeded.session, controlFormat)) b.jar.plant(raw);
      const m = b.jar.writes.length;
      const a0 = cap.adapter.length;
      const client = b.createClient();
      await client.auth.initialize();
      await settle();
      const ws = live(familyWrites(b, m));
      const issued = b.sb.last();
      const { session } = decodeJoined(b);
      const read = await client.auth.getSession();
      judge(id, {
        one_refresh_grant: b.sb.count("refresh") === 1 && b.sb.st.calls.some((c) => c.kind === "refresh" && c.status === 200),
        adapter_saw_every_session_write: adapterSawEvery(b, ws, a0),
        wrote_rotated_session: ws.length >= 1 && !!session && session.refresh_token === issued.refresh && session.access_token === issued.access && issued.refresh !== seeded.refresh,
        max_age_2592000: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === SESSION_MAX_AGE),
        ...policyAttrsHold(ws),
        [https ? "secure_on_https" : "no_secure_on_http"]: ws.length >= 1 && ws.every((w) => ("secure" in w.attrs) === https),
        jar_expiry_30_days: ws.length >= 1 && ws.every((w) => within30Days(b, w.name)),
        readback_through_the_factory: read.data.session?.access_token === issued.access,
      }, { ...baseObs(b, ws), jarExpiryDays: ws.map((w) => jarExpiryDays(b, w.name)) });
    });
  }

  it("K1 the factory classifies the SDK's own storage key for an untrimmed URL (supabase-js trims, then derives the key)", async () => {
    // NBSP and BOM around the configured URL: supabase-js trims them (String.prototype.trim) before deriving the key
    const b = await boot({ envUrl: `\u00a0\ufeff${LOOPBACK_SUPABASE}\u00a0` });
    const client = b.createClient();
    await client.auth.initialize();
    const m = b.jar.writes.length;
    await client.auth.signInWithPassword(CRED);
    await settle();
    const ws = live(familyWrites(b, m));
    const read = await client.auth.getSession();
    judge("K1", {
      sdk_storage_key_is_the_trimmed_default: (client.auth as unknown as Record<string, unknown>).storageKey === b.key,
      wrote_session: ws.length >= 1,
      max_age_2592000: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === SESSION_MAX_AGE),
      no_secure_on_http: ws.length >= 1 && ws.every((w) => !("secure" in w.attrs)),
      jar_expiry_30_days: ws.length >= 1 && ws.every((w) => within30Days(b, w.name)),
      readback_through_the_factory: read.data.session?.access_token === b.sb.last().access,
    }, { ...baseObs(b, ws), jarExpiryDays: ws.map((w) => jarExpiryDays(b, w.name)) });
  });

  // ── C: chunked values (names, values, chunk encoding and ordering are the SDK's) ──────────────────────────
  for (const [id, page, supabaseUrl] of [["C1", HTTP_PAGE, LOOPBACK_SUPABASE], ["C2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    const https = page === HTTPS_PAGE;
    it(`${id} a chunked session on an ${https ? "HTTPS" : "HTTP"} page: every chunk carries the policy, in the SDK's order and encoding`, async () => {
      // multi-byte and reserved characters so the SDK's chunker must avoid splitting inside an escape
      const b = await boot({ page, supabaseUrl, meta: { pad: "é🙂;,= %\"<x>".repeat(420) } });
      const client = b.createClient();
      await client.auth.initialize();
      const m = b.jar.writes.length;
      const a0 = cap.adapter.length;
      await client.auth.signInWithPassword(CRED);
      await settle();
      const ws = live(familyWrites(b, m));
      const { joined, session } = decodeJoined(b);
      const expected = joined ? chunksOf(b.key, joined) : [];
      const sets = cap.adapter.slice(a0).filter((a) => a.op === "set" && b.isFamily(a.name));
      const read = await client.auth.getSession();
      judge(id, {
        chunked: ws.length >= 2 && ws.every((w, i) => w.name === `${b.key}.${i}`),
        raw_names_in_sdk_order: expected.length >= 2 && JSON.stringify(ws.map((w) => w.name)) === JSON.stringify(expected.map((c) => c.name)),
        raw_values_are_the_sdk_chunks: expected.length >= 2 && JSON.stringify(ws.map((w) => decodeURIComponent(w.value))) === JSON.stringify(expected.map((c) => c.value)),
        raw_values_are_uri_component_encoded: ws.every((w) => w.value === encodeURIComponent(decodeURIComponent(w.value))),
        adapter_saw_every_chunk: sets.length === ws.length && JSON.stringify(sets.map((a) => a.name)) === JSON.stringify(ws.map((w) => w.name)),
        every_chunk_max_age_2592000: ws.length >= 2 && ws.every((w) => w.attrs["max-age"] === SESSION_MAX_AGE),
        ...policyAttrsHold(ws),
        [https ? "every_chunk_secure_on_https" : "no_secure_on_http"]: ws.length >= 2 && ws.every((w) => ("secure" in w.attrs) === https),
        every_chunk_jar_expiry_30_days: ws.length >= 2 && ws.every((w) => within30Days(b, w.name)),
        ...(https ? { every_jar_chunk_secure: ws.every((w) => "secure" in (b.jar.entry(w.name)?.attrs ?? {})) } : {}),
        session_round_trips: !!session && session.access_token === b.sb.last().access && session.user?.user_metadata?.pad === b.sb.st.meta.pad,
        readback_through_the_factory: read.data.session?.access_token === b.sb.last().access,
      }, { ...baseObs(b, ws), chunks: expected.length });
    });
  }

  // ── D: deletion (Max-Age=0, never a fresh write); positive on the control as well ─────────────────────────
  for (const [id, page, supabaseUrl, pad] of [["D1", HTTP_PAGE, LOOPBACK_SUPABASE, 0], ["D2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE, 7000]] as const) {
    const https = page === HTTPS_PAGE;
    it(`${id} sign-out on an ${https ? "HTTPS page removes every chunk" : "HTTP page removes the bare cookie"} with Max-Age=0 and never rewrites it`, async () => {
      const b = await boot({ page, supabaseUrl, meta: pad ? { pad: "q".repeat(pad) } : {} });
      const client = b.createClient();
      await client.auth.initialize();
      await client.auth.signInWithPassword(CRED);
      await settle();
      const before = b.jar.names().filter(b.isFamily);
      const m = b.jar.writes.length;
      const out = await client.auth.signOut();
      await settle();
      const ws = familyWrites(b, m);
      const read = await client.auth.getSession();
      judge(id, {
        had_a_session: before.length >= (pad ? 2 : 1),
        sign_out_ok: !out.error && b.sb.count("logout") === 1,
        removal_writes_all_max_age_0: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === "0"),
        removal_never_a_fresh_write: live(ws).length === 0,
        each_present_name_removed_once: JSON.stringify(ws.map((w) => w.name).sort()) === JSON.stringify(before.slice().sort()),
        removal_path_root_no_domain: ws.every((w) => w.attrs.path === "/" && !("domain" in w.attrs)),
        jar_has_no_session_cookie: b.jar.names().filter(b.isFamily).length === 0,
        session_gone: read.data.session === null,
      }, { ...baseObs(b, ws), removedChunks: before.length });
    });
  }
  it("D3 a coded refresh rejection (400 refresh_token_not_found): the SDK's removal is Max-Age=0 and never a fresh write", async () => {
    const b = await boot();
    const seeded = b.sb.seed(20);
    for (const raw of plantSession(b, seeded.session, controlFormat)) b.jar.plant(raw);
    b.sb.st.refreshMode = "reject";
    const m = b.jar.writes.length;
    const client = b.createClient();
    await client.auth.initialize();
    await settle();
    const ws = familyWrites(b, m);
    const read = await client.auth.getSession();
    judge("D3", {
      refresh_rejected_once: b.sb.count("refresh") === 1,
      removal_writes_all_max_age_0: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === "0"),
      removal_never_a_fresh_write: live(ws).length === 0,
      jar_has_no_session_cookie: b.jar.names().filter(b.isFamily).length === 0,
      session_gone: read.data.session === null,
    }, baseObs(b, ws));
  });
  it("D4 inherited SDK outage handling is unchanged (500 on refresh: the SDK clears, with Max-Age=0 only)", async () => {
    const b = await boot();
    const seeded = b.sb.seed(20);
    for (const raw of plantSession(b, seeded.session, controlFormat)) b.jar.plant(raw);
    b.sb.st.refreshMode = "outage500";
    const m = b.jar.writes.length;
    const client = b.createClient();
    await client.auth.initialize();
    await settle();
    const ws = familyWrites(b, m);
    judge("D4", {
      refresh_attempted_once: b.sb.count("refresh") === 1,
      inherited_clearing_on_500_unchanged: b.jar.names().filter(b.isFamily).length === 0,
      removal_writes_all_max_age_0: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === "0"),
      removal_never_a_fresh_write: live(ws).length === 0,
    }, baseObs(b, ws));
  });

  // ── E: encoding and unrelated cookies (positive on the control as well) ───────────────────────────────────
  it("E1 URL-escaped values round-trip and unrelated cookie pairs are never touched (sign-in, refresh, sign-out)", async () => {
    const unrelated = ["theme=dark", "pref=a%20b%3Bc", "bad=%E0%A4%A", 'quoted="qv"', "sb-other-auth-token=%7B%7D", "plain=x=y"];
    const note = 'a;b,c=d %e "q" é 🙂 <x> \\ /';
    const b = await boot({ meta: { note }, plant: unrelated.map((p) => `${p}; Path=/`) });
    const rawOf = (n: string) => b.jar.entry(n)?.value;
    const plantedValues = unrelated.map((p) => parseRaw(p)).map((p) => ({ name: p.name, value: p.value }));
    const client = b.createClient();
    await client.auth.initialize();
    const m = b.jar.writes.length;
    await client.auth.signInWithPassword(CRED);
    await settle();
    const afterSignIn = decodeJoined(b);
    const readSignedIn = await client.auth.getSession();
    await client.auth.refreshSession();
    await settle();
    const afterRefresh = decodeJoined(b);
    await client.auth.signOut();
    await settle();
    const writes = b.jar.writes.slice(m);
    const sdkName = (n: string) => b.isFamily(n) || n === `${b.key}-code-verifier` || n === `${b.key}-user`;
    judge("E1", {
      escaped_value_round_trips: afterSignIn.session?.user?.user_metadata?.note === note && afterRefresh.session?.user?.user_metadata?.note === note,
      raw_values_use_only_uri_component_characters: writes.every((w) => /^[A-Za-z0-9%!'()*\-._~]*$/.test(w.value)),
      get_tolerates_an_undecodable_unrelated_cookie: readSignedIn.data.session?.access_token === b.sb.st.issued[0]?.access,
      no_write_names_an_unrelated_cookie: writes.length >= 2 && writes.every((w) => sdkName(w.name)),
      unrelated_values_unchanged: plantedValues.every((p) => rawOf(p.name) === p.value),
      signed_out_session_gone_unrelated_present: b.jar.names().filter(b.isFamily).length === 0 && plantedValues.every((p) => b.jar.names().indexOf(p.name) !== -1),
    }, { ...baseObs(b, familyWrites(b, m)), writeNames: writes.map((w) => (b.isFamily(w.name) ? "<family>" : w.name.replace(b.key, "<key>"))) });
  });

  // ── N: non-session names keep the SDK's own handling ──────────────────────────────────────────────────────
  it("N1 the PKCE code verifier (a non-session name) keeps the SDK's own serialization, on HTTPS too, and is removed with Max-Age=0", async () => {
    const b = await boot({ page: HTTPS_PAGE, supabaseUrl: HOSTED_SHAPED_SUPABASE });
    const name = `${b.key}-code-verifier`;
    const client = b.createClient();
    await client.auth.initialize();
    const m = b.jar.writes.length;
    const a0 = cap.adapter.length;
    const rec = await client.auth.resetPasswordForEmail(EMAIL);
    await settle();
    const vw = b.jar.writes.slice(m).filter((w) => w.name === name);
    const verifier = vw[0] ? decodeURIComponent(vw[0].value) : null;
    if (verifier) ISSUED.push(verifier);
    const m2 = b.jar.writes.length;
    await client.auth.signInWithPassword(CRED);
    await settle();
    const removed = b.jar.writes.slice(m2).filter((w) => w.name === name);
    const dflt = cap.real.DEFAULT_COOKIE_OPTIONS;
    judge("N1", {
      recover_ok: !rec.error && b.sb.count("recover") === 1,
      verifier_written_once: vw.length === 1 && vw[0].attrs["max-age"] !== "0",
      verifier_bytes_equal_the_sdk_default: !!verifier && vw[0].raw === cap.real.serialize(name, verifier, { ...dflt, maxAge: dflt.maxAge }),
      verifier_not_given_the_session_policy: vw.every((w) => w.attrs["max-age"] !== SESSION_MAX_AGE),
      adapter_saw_verifier: cap.adapter.slice(a0).some((a) => a.op === "set" && a.name === name),
      verifier_removed_with_max_age_0: removed.length === 1 && removed[0].raw === cap.real.serialize(name, "", { ...dflt, maxAge: 0 }),
      verifier_gone: b.jar.entry(name) === undefined,
    }, { page: "https", factoryCookieMethods: cap.factoryCookieMethods[0] ?? null, adapterCalls: adapterSummary(),
      verifierWrites: vw.map((w) => attrsOf(w, b.isFamily)), verifierRemovals: removed.map((w) => attrsOf(w, b.isFamily)) });
  });

  // ── S/M: singleton, initialization and the server/no-browser contract ─────────────────────────────────────
  it("S1 repeated factory calls in a browser return the SDK's one cached client, and its writes carry the policy", async () => {
    const b = await boot();
    const first = b.createClient();
    const second = b.createClient();
    await second.auth.initialize();
    const m = b.jar.writes.length;
    await second.auth.signInWithPassword(CRED);
    await settle();
    const ws = live(familyWrites(b, m));
    judge("S1", {
      same_instance: first === second,
      factory_called_twice_sdk_returned_the_cached_client: cap.factoryCookieMethods.length === 2 && cap.clients[0] === cap.clients[1],
      wrote_session: ws.length >= 1,
      writes_after_second_call_use_policy: ws.length >= 1 && ws.every((w) => w.attrs["max-age"] === SESSION_MAX_AGE && !("secure" in w.attrs)),
    }, baseObs(b, ws));
  });
  it("S2 the SDK initialization contract is unchanged (PKCE, auto-refresh, URL detection, persistence, storage key, client info)", async () => {
    const b = await boot();
    const client = b.createClient();
    await client.auth.initialize();
    await client.auth.signInWithPassword(CRED);
    await settle();
    const a = client.auth as unknown as Record<string, unknown>;
    const storage = a.storage as Record<string, unknown> | undefined;
    judge("S2", {
      flow_type_pkce: a.flowType === "pkce",
      auto_refresh_on_in_a_browser: a.autoRefreshToken === true,
      detect_session_in_url_on: a.detectSessionInUrl === true,
      persist_session_on: a.persistSession === true,
      storage_key_is_the_sdk_default: a.storageKey === b.key,
      storage_is_not_server: storage?.isServer === false,
      client_info_header_is_ssr_0_3_0: b.sb.st.calls.length >= 1 && b.sb.st.calls.every((c) => c.clientInfo === "supabase-ssr/0.3.0"),
    }, { factoryCookieMethods: cap.factoryCookieMethods[0] ?? null, calls: b.sb.st.calls.length });
  });
  it("S3 without a browser (server render of a client page): a new client per call, no auto-refresh, an empty session and no throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOOPBACK_SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
    const sb = standIn(LOOPBACK_SUPABASE);
    vi.stubGlobal("fetch", sb.fetch);
    const { createClient } = await import("@/utils/supabase/client");
    const one = createClient() as unknown as SbClient;
    const two = createClient() as unknown as SbClient;
    let threw = false;
    let session: unknown = "untouched";
    try {
      session = (await one.auth.getSession()).data.session;
    } catch {
      threw = true;
    }
    judge("S3", {
      distinct_instances_without_a_browser: one !== two,
      auto_refresh_off_without_a_browser: (one.auth as unknown as Record<string, unknown>).autoRefreshToken === false,
      empty_session_without_a_browser: !threw && session === null,
      no_auth_request: sb.st.calls.length === 0,
      no_browser_global_created: typeof window === "undefined" && typeof document === "undefined",
    }, { threw, calls: sb.st.calls.length });
  });
  it("M1 importing the factory module touches no browser global", async () => {
    const earlier = await import("@/utils/supabase/client");
    let touched = 0;
    const trap = { configurable: true, get() { touched += 1; return undefined; } };
    Object.defineProperty(globalThis, "window", trap);
    Object.defineProperty(globalThis, "document", trap);
    let threw = false;
    let exported: string[] = [];
    let reEvaluated = false;
    try {
      vi.resetModules();
      const mod = await import("@/utils/supabase/client");
      exported = Object.keys(mod).sort();
      reEvaluated = mod !== earlier && mod.createClient !== earlier.createClient;
    } catch {
      threw = true;
    } finally {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).document;
    }
    judge("M1", {
      import_did_not_throw: !threw,
      module_was_re_evaluated: reEvaluated,
      no_browser_global_read_during_import: touched === 0,
      exports_create_client: JSON.stringify(exported) === JSON.stringify(["createClient"]),
    }, { touched, exported, reEvaluated });
  });

  // ── X: coexistence with the server writer, and readability by candidate and rollback control ──────────────
  for (const [id, page, supabaseUrl] of [["X1", HTTP_PAGE, LOOPBACK_SUPABASE], ["X1s", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    const https = page === HTTPS_PAGE;
    it(`${id} a cookie written by the AG-SESSION-02 server boundary (${https ? "HTTPS, Secure" : "HTTP"}) is read by the factory without a rewrite`, async () => {
      const b = await boot({ page, supabaseUrl });
      const seeded = b.sb.seed(3600);
      const raws = chunksOf(b.key, JSON.stringify(seeded.session)).map((c) => serverFormat(c.name, c.value, https));
      for (const raw of raws) b.jar.plant(raw);
      const m = b.jar.writes.length;
      const client = b.createClient();
      await client.auth.initialize();
      const read = await client.auth.getSession();
      await settle();
      judge(id, {
        server_cookie_planted: b.jar.names().filter(b.isFamily).length >= 1,
        read_by_the_factory: read.data.session?.access_token === seeded.access,
        no_write_on_read: b.jar.writes.length === m,
      }, { page: https ? "https" : "http", factoryCookieMethods: cap.factoryCookieMethods[0] ?? null, adapterCalls: adapterSummary() });
    });
  }
  it("X2 a cookie written by the browser factory is read by the server's cookie parser (Next RequestCookies) as the same session", async () => {
    const b = await boot({ meta: { note: "é; =%" } });
    const client = b.createClient();
    await client.auth.initialize();
    await client.auth.signInWithPassword(CRED);
    await settle();
    const rc = new RequestCookies(new Headers({ cookie: b.jar.header() }));
    const bare = rc.get(b.key)?.value;
    let joined = bare;
    if (!joined) {
      const parts: string[] = [];
      for (let i = 0; rc.get(`${b.key}.${i}`); i++) parts.push(rc.get(`${b.key}.${i}`)!.value);
      joined = parts.join("") || undefined;
    }
    let parsed: SbSession | null = null;
    try {
      parsed = joined ? (JSON.parse(joined) as SbSession) : null;
    } catch {
      parsed = null;
    }
    judge("X2", {
      server_parser_sees_the_session: !!parsed && parsed.access_token === b.sb.last().access && parsed.refresh_token === b.sb.last().refresh,
      metadata_round_trips: parsed?.user?.user_metadata?.note === "é; =%",
    }, { familyWrites: b.jar.writes.filter((w) => b.isFamily(w.name)).length });
  });
  it("X3 readability across candidate and rollback: a policy-format cookie and an accepted-format (SDK default) cookie both read", async () => {
    const results: Record<string, boolean> = {};
    for (const [label, fmt] of [["policy_format", (n: string, v: string) => policyFormat(n, v, false)], ["accepted_format", controlFormat]] as const) {
      const b = await boot();
      const seeded = b.sb.seed(3600);
      for (const raw of plantSession(b, seeded.session, fmt)) b.jar.plant(raw);
      const m = b.jar.writes.length;
      const client = b.createClient();
      await client.auth.initialize();
      const read = await client.auth.getSession();
      await settle();
      results[`${label}_read`] = read.data.session?.access_token === seeded.access;
      results[`${label}_not_rewritten_on_read`] = b.jar.writes.length === m;
      for (const c of cap.clients) await c.auth.dispose?.();
      cap.real = freshSsr(); // a new page load: a fresh SDK singleton
      cap.clients = [];
      vi.unstubAllGlobals();
    }
    judge("X3", results, { factoryCookieMethods: cap.factoryCookieMethods[0] ?? null });
  });
  it("X4 an existing longer-lived cookie is not rewritten on read (no one-time cleanup; repaired only when the SDK next writes)", async () => {
    const b = await boot({ page: HTTPS_PAGE, supabaseUrl: HOSTED_SHAPED_SUPABASE });
    const seeded = b.sb.seed(3600);
    for (const raw of plantSession(b, seeded.session, controlFormat)) b.jar.plant(raw);
    const before = jarExpiryDays(b, b.key);
    const m = b.jar.writes.length;
    const client = b.createClient();
    await client.auth.initialize();
    const read = await client.auth.getSession();
    await settle();
    judge("X4", {
      read_ok: read.data.session?.access_token === seeded.access,
      no_write_on_read: b.jar.writes.length === m,
      old_cookie_keeps_its_attributes: jarExpiryDays(b, b.key) === before && !("secure" in (b.jar.entry(b.key)?.attrs ?? {})),
    }, { jarExpiryDaysBefore: before, jarExpiryDaysAfter: jarExpiryDays(b, b.key) });
  });

  // ── G: the factory source (structural) ────────────────────────────────────────────────────────────────────
  it("G1 the factory source: one createClient() export, the 0.3.0 get/set/remove adapter, no token or identity reads", () => {
    const src = readFileSync(path.join(ROOT, "utils/supabase/client.ts"), "utf8").replace(/\r\n/g, "\n");
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = Array.from(code.matchAll(/^import [^;]* from "([^"]+)";$/gm)).map((x) => x[1]);
    const envNames = Array.from(new Set(Array.from(code.matchAll(/process\.env\.([A-Z0-9_]+)/g)).map((x) => x[1]))).sort();
    judge("G1", {
      one_create_client_export_with_no_parameters: (code.match(/\bexport\b/g) ?? []).length === 1 && /export function createClient\(\)/.test(code),
      imports_only_the_installed_ssr_package: JSON.stringify(imports) === JSON.stringify(["@supabase/ssr"]),
      backed_by_create_browser_client: /createBrowserClient\(/.test(code),
      has_get_set_remove_adapter: /\bget\(name: string\)/.test(code) && /\bset\(name: string, value: string,/.test(code) && /\bremove\(name: string,/.test(code),
      no_getall_setall_adapter: !/getAll|setAll/.test(code),
      session_max_age_2592000_constant: /=\s*2_592_000;/.test(code),
      reads_no_token_or_identity_field: !/access_token|refresh_token|JSON\.parse|atob|\buser\b|jwt|decode/i.test(code),
      no_storage_network_or_console: !/\blocalStorage\b|\bsessionStorage\b|\bfetch\(|\bconsole\.|XMLHttpRequest/.test(code),
      env_names_unchanged: JSON.stringify(envNames) === JSON.stringify(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]),
    }, { imports, envNames, lines: src.split("\n").length });
  });
});
