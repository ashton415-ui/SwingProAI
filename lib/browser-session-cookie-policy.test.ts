import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LineageRecord, LineageStore } from "@/utils/supabase/session-lease";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RequestCookies } from "next/dist/compiled/@edge-runtime/cookies";

// AG-SESSION-03 browser session-cookie policy, RETARGETED by AG-WEB-READY-03-R1 to the layout-managed session storage
// (utils/supabase/session-storage.ts; layout rules in utils/supabase/session-cookie-layout.ts). The policy itself is
// unchanged: session cookies are written with Path=/, SameSite=Lax, no Domain, not HttpOnly, Secure on an HTTPS page and
// Max-Age 30 days (OP-1); a removal is Max-Age=0 with the same attributes; other keys (the PKCE verifier) keep the
// SDK's own serialization. What changed is who writes: the SDK's `auth.storage` (one compare-and-set per change under
// the session-publication lease) instead of @supabase/ssr's cookie adapter, and sign-in/End Session go through
// utils/supabase/session-publication.ts (the shared client never calls signInWithPassword or signOut itself).
//
// Controlled surface (test-only): window/document/location stubbed per test; document.cookie is a browser-like store
// (`Jar`) that records every serialized write, honours Max-Age (0 deletes; capped at 400 days like Chrome), keeps one
// entry per name/path/domain, refuses Secure writes from an http page, HttpOnly writes from script and foreign Domain
// writes, and returns pairs in creation order. No Web Locks and no IndexedDB in this file (a single tab: the lease runs
// tab-only and the lineage check is skipped; both are counted — the multi-tab contract is lib/session-publication.test.ts).
// The platform fetch is an in-memory synthetic Auth stand-in. Every case ends in judge(): the failure message carries
// the case's JSON observation, which must never carry a token value.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

type SsrModule = {
  createBrowserClient: (url: string, key: string, options?: Record<string, unknown>) => SbClient;
  isBrowser: () => boolean;
  parse: (s: string) => Record<string, string>;
  serialize: (name: string, value: string, options?: Record<string, unknown>) => string;
  createChunks: (key: string, value: string) => { name: string; value: string }[];
  DEFAULT_COOKIE_OPTIONS: Record<string, unknown>;
};
type SbSession = { access_token: string; refresh_token: string; expires_at?: number; user?: { user_metadata?: Record<string, unknown> } };
type SbAuth = {
  initialize: () => Promise<unknown>;
  getSession: () => Promise<{ data: { session: SbSession | null }; error: unknown }>;
  refreshSession: () => Promise<{ data: { session: SbSession | null }; error: unknown }>;
  resetPasswordForEmail: (email: string) => Promise<{ error: unknown }>;
  stopAutoRefresh?: () => Promise<void>;
};
type SbClient = { auth: SbAuth };

const cap = vi.hoisted(() => ({ real: null as unknown as SsrModule, clients: [] as SbClient[], options: [] as Record<string, unknown>[] }));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (url: string, key: string, options?: Record<string, unknown>) => {
    cap.options.push(options ?? {});
    const client = cap.real.createBrowserClient(url, key, options);
    cap.clients.push(client);
    return client;
  },
  createServerClient: (...a: unknown[]) => (cap.real as unknown as { createServerClient: (...x: unknown[]) => unknown }).createServerClient(...a),
  isBrowser: () => cap.real.isBrowser(),
  parse: (s: string) => cap.real.parse(s),
  serialize: (name: string, value: string, options?: Record<string, unknown>) => cap.real.serialize(name, value, options),
  createChunks: (key: string, value: string) => cap.real.createChunks(key, value),
  DEFAULT_COOKIE_OPTIONS: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 60 * 60 * 24 * 365 * 1000 },
}));
function freshSsr(): SsrModule {
  const p = requireFromHere.resolve("@supabase/ssr");
  delete requireFromHere.cache[p];
  return requireFromHere(p) as SsrModule;
}

const LOOPBACK_SUPABASE = "http://127.0.0.1:54329";
const HOSTED_SHAPED_SUPABASE = "https://synthetic-ref.supabase.invalid";
const HTTP_PAGE = "http://127.0.0.1:3941";
const HTTPS_PAGE = "https://app.example.invalid";
const ANON = "synthetic-anon-key-not-a-secret";
const GOLFER = "00000000-0000-4000-8000-0000000000a3";
const EMAIL = "golfer@example.invalid";
const PASSWORD = "synthetic-password-not-a-secret";
const DAY_MS = 86_400_000;
const keyFor = (url: string) => `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 15));
};
const ISSUED: string[] = [];

// ── the controlled cookie surface ───────────────────────────────────────────────────────────────────────────
type Parsed = { name: string; value: string; attrs: Record<string, string> };
type Write = Parsed & { raw: string; accepted: boolean; reason: string | null };
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
  constructor(readonly https: boolean, readonly host: string) {}
  write(raw: string) {
    const w: Write = { ...parseRaw(raw), raw, accepted: false, reason: null };
    this.writes.push(w);
    this.apply(w);
  }
  plant(raw: string) {
    this.apply({ ...parseRaw(raw), raw, accepted: false, reason: null });
  }
  private apply(w: Write) {
    if (!w.name) return void (w.reason = "no-name");
    if ("secure" in w.attrs && !this.https) return void (w.reason = "secure-from-http-page");
    if ("httponly" in w.attrs) return void (w.reason = "httponly-from-script");
    if ("domain" in w.attrs) {
      const d = w.attrs.domain.replace(/^\./, "").toLowerCase();
      if (this.host !== d && !this.host.endsWith(`.${d}`)) return void (w.reason = "domain-mismatch");
    }
    const id = `${w.name}|${w.attrs.path ?? "/"}|${w.attrs.domain ?? ""}`;
    const maxAge = w.attrs["max-age"] !== undefined ? Number(w.attrs["max-age"]) : null;
    const now = Date.now();
    const expiresAt = maxAge !== null && Number.isFinite(maxAge) ? now + Math.min(maxAge, 400 * 86_400) * 1000 : null;
    w.accepted = true;
    if (expiresAt !== null && expiresAt <= now) return void this.store.delete(id);
    const old = this.store.get(id);
    this.store.set(id, { name: w.name, value: w.value, attrs: w.attrs, expiresAt, created: old ? old.created : ++this.seq });
  }
  private live(): Entry[] {
    const now = Date.now();
    const out: Entry[] = [];
    this.store.forEach((e, id) => (e.expiresAt !== null && e.expiresAt <= now ? this.store.delete(id) : out.push(e)));
    return out.sort((a, b) => a.created - b.created);
  }
  header(): string {
    return this.live().map((e) => `${e.name}=${e.value}`).join("; ");
  }
  entry(name: string): Entry | undefined {
    return this.live().find((e) => e.name === name);
  }
  names(): string[] {
    return this.live().map((e) => e.name);
  }
}

/** navigator.locks for one tab (A1: Web Locks are part of every supported browser; without them nothing is ordered). */
function tabLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(_name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>) {
      if (options.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const granted = tail.then(() => callback());
      tail = granted.catch(() => undefined);
      return granted;
    },
  };
}

/** The browser's IndexedDB lineage record, in memory (A1: part of every supported browser). */
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

function installBrowser(page: string): Jar {
  const url = new URL("/login", page);
  const jar = new Jar(url.protocol === "https:", url.hostname);
  const doc = { get cookie() { return jar.header(); }, set cookie(v: string) { jar.write(String(v)); }, visibilityState: "hidden", addEventListener() {}, removeEventListener() {} };
  const loc = { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, assign() {}, replace() {}, reload() {} };
  vi.stubGlobal("window", { document: doc, location: loc, addEventListener() {}, removeEventListener() {}, history: { state: null, replaceState() {} } });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", loc);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("navigator", { userAgent: "synthetic", locks: tabLocks() });
  return jar;
}

// ── the synthetic Auth stand-in ─────────────────────────────────────────────────────────────────────────────
type Issued = { access: string; refresh: string; session: Record<string, unknown> };
function standIn(supabaseUrl: string) {
  const origin = new URL(supabaseUrl).origin;
  const st = { issued: [] as Issued[], active: null as string | null, meta: {} as Record<string, unknown>, refreshMode: "grant" as "grant" | "reject" | "outage500", expiresIn: 3600, calls: [] as { kind: string; status: number }[], unexpected: 0 };
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function issue(expiresIn = st.expiresIn): Issued {
    const now = Math.floor(Date.now() / 1000);
    const access = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: GOLFER, exp: now + expiresIn, aud: "authenticated", role: "authenticated", session_id: randomUUID() })}.${randomUUID().replace(/-/g, "")}`;
    const refresh = `rt${randomUUID().replace(/-/g, "")}`;
    ISSUED.push(access, refresh);
    const session = { access_token: access, token_type: "bearer", expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: refresh,
      user: { id: GOLFER, aud: "authenticated", role: "authenticated", email: EMAIL, app_metadata: { provider: "email" }, user_metadata: st.meta, created_at: "2026-01-01T00:00:00Z" } };
    const i = { access, refresh, session };
    st.issued.push(i);
    st.active = refresh;
    return i;
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });
  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const call = { kind: "other", status: 0 };
    st.calls.push(call);
    if (url.origin !== origin) {
      st.unexpected += 1;
      throw new TypeError("stand-in: request outside the synthetic Auth origin refused");
    }
    const body = req.method === "POST" ? await req.text().then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) : {};
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const answer = (kind: string, r: Response) => Object.assign(call, { kind, status: r.status }) && r;
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      if (body.email === EMAIL && body.password === PASSWORD) return answer("password", json(200, issue().session));
      return answer("password", json(400, { code: "invalid_credentials", msg: "Invalid login credentials" }));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (st.refreshMode === "outage500") return answer("refresh", json(500, { code: "unexpected_failure", msg: "synthetic outage" }));
      if (st.refreshMode === "reject" || !st.active || body.refresh_token !== st.active) return answer("refresh", json(400, { code: "refresh_token_not_found", msg: "Invalid Refresh Token" }));
      return answer("refresh", json(200, issue(3600).session));
    }
    if (url.pathname === "/auth/v1/logout") {
      st.active = null;
      return answer("logout", new Response(null, { status: 204 }));
    }
    if (url.pathname === "/auth/v1/recover") return answer("recover", json(200, {}));
    if (url.pathname === "/auth/v1/user") {
      const cur = st.issued.find((i) => i.access === bearer);
      return answer("user", cur ? json(200, cur.session.user) : json(401, { code: "bad_jwt", msg: "invalid JWT" }));
    }
    st.unexpected += 1;
    return answer("unexpected", json(404, { msg: "not found" }));
  }
  return {
    st,
    fetch: fetchFn,
    seed(expiresInS: number) {
      const i = issue(3600);
      i.session.expires_at = Math.floor(Date.now() / 1000) + expiresInS;
      i.session.expires_in = expiresInS;
      return i;
    },
    count: (kind: string) => st.calls.filter((c) => c.kind === kind).length,
    last: () => st.issued[st.issued.length - 1],
  };
}

type Mods = {
  client: typeof import("@/utils/supabase/client");
  publication: typeof import("@/utils/supabase/session-publication");
  storage: typeof import("@/utils/supabase/session-storage");
};
type Booted = { jar: Jar; sb: ReturnType<typeof standIn>; key: string; https: boolean; mods: Mods; shared: () => SbClient; isFamily: (n: string) => boolean };
async function boot({ page = HTTP_PAGE, supabaseUrl = LOOPBACK_SUPABASE, envUrl = null as string | null, meta = {} as Record<string, unknown>, plant = [] as string[] } = {}): Promise<Booted> {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", envUrl ?? supabaseUrl);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  const jar = installBrowser(page);
  for (const raw of plant) jar.plant(raw);
  const sb = standIn(supabaseUrl);
  sb.st.meta = meta;
  vi.stubGlobal("fetch", sb.fetch);
  (await import("@/utils/supabase/session-lease")).configureLineage({ jarView: () => ({ kind: "absent" }), store: memoryLineage() });
  const mods: Mods = {
    client: await import("@/utils/supabase/client"),
    publication: await import("@/utils/supabase/session-publication"),
    storage: await import("@/utils/supabase/session-storage"),
  };
  const key = keyFor(supabaseUrl);
  const isFamily = (n: string) => n === key || n.startsWith(`${key}.`);
  return { jar, sb, key, https: page.startsWith("https:"), mods, shared: () => mods.client.createClient() as unknown as SbClient, isFamily };
}
beforeEach(() => {
  vi.resetModules();
  cap.real = freshSsr();
  cap.clients = [];
  cap.options = [];
  for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(async () => {
  await settle();
  for (const c of cap.clients) {
    try { await c.auth.stopAutoRefresh?.(); } catch { /* teardown */ }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const accepted = (n: string, v: string) => cap.real.serialize(n, v, { ...cap.real.DEFAULT_COOKIE_OPTIONS }); // ssr 0.3.0's own format
const policyFormat = (n: string, v: string, secure: boolean) => cap.real.serialize(n, v, { path: "/", sameSite: "lax", secure, maxAge: 2592000 });
const chunksOf = (key: string, value: string) => cap.real.createChunks(key, value);
const plantSession = (key: string, session: unknown, fmt: (n: string, v: string) => string) => chunksOf(key, JSON.stringify(session)).map((c) => fmt(c.name, c.value));
const familyWrites = (b: Booted, from = 0) => b.jar.writes.slice(from).filter((w) => b.isFamily(w.name));
const live = (ws: Write[]) => ws.filter((w) => w.attrs["max-age"] !== "0");
const removals = (ws: Write[]) => ws.filter((w) => w.attrs["max-age"] === "0");
function decodeJoined(b: Booted): SbSession | null {
  const { readSessionLayout, parseCookieHeader } = requireLayout();
  const l = readSessionLayout(parseCookieHeader(b.jar.header()), b.key);
  if (l.kind !== "present") return null;
  try { return JSON.parse(l.value) as SbSession; } catch { return null; }
}
let layoutModule: typeof import("@/utils/supabase/session-cookie-layout") | null = null;
const requireLayout = () => layoutModule as typeof import("@/utils/supabase/session-cookie-layout");
beforeEach(async () => {
  layoutModule = await import("@/utils/supabase/session-cookie-layout");
});
const policyAttrsHold = (ws: Write[], secure: boolean) => ({
  path_root: ws.length > 0 && ws.every((w) => w.attrs.path === "/"),
  samesite_lax: ws.length > 0 && ws.every((w) => (w.attrs.samesite ?? "").toLowerCase() === "lax"),
  secure_exactly_on_https: ws.every((w) => ("secure" in w.attrs) === secure),
  no_domain: ws.every((w) => !("domain" in w.attrs)),
  no_httponly: ws.every((w) => !("httponly" in w.attrs)),
  no_expires_attribute: ws.every((w) => !("expires" in w.attrs)),
  every_write_accepted: ws.every((w) => w.accepted),
});
const within30Days = (b: Booted, n: string) => {
  const e = b.jar.entry(n);
  return !!e && e.expiresAt !== null && Math.abs(e.expiresAt - Date.now() - 2_592_000_000) < 15_000;
};
function attrsOf(w: Write, b: Booted) {
  return { name: w.name.replace(/^sb-[^.]+?-auth-token/, "<key>"), maxAge: w.attrs["max-age"] ?? null, path: w.attrs.path ?? null, sameSite: w.attrs.samesite ?? null,
    secure: "secure" in w.attrs, httpOnly: "httponly" in w.attrs, domain: "domain" in w.attrs, accepted: w.accepted, rejected: w.reason, family: b.isFamily(w.name) };
}
function judge(name: string, checks: Record<string, boolean>, obs: Record<string, unknown>) {
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  const text = JSON.stringify({ case: name, failed, checks: Object.keys(checks), obs });
  expect(ISSUED.some((t) => text.includes(t) || text.includes(encodeURIComponent(t))), "an observation must carry no token value").toBe(false);
  expect(failed, `observed ${text}`).toEqual([]);
}
async function signIn(b: Booted) {
  return b.mods.publication.signInAndPublish(EMAIL, PASSWORD);
}

describe("browser session cookie policy through the layout-managed session storage", () => {
  for (const [id, page, supabaseUrl] of [["W1", HTTP_PAGE, LOOPBACK_SUPABASE], ["W2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    it(`${id} a sign-in's publication writes the session with the policy attributes (${page.startsWith("https") ? "HTTPS: Secure" : "HTTP: no Secure"}), 30 days, readable as the session`, async () => {
      const b = await boot({ page, supabaseUrl });
      const outcome = await signIn(b);
      await settle();
      const ws = familyWrites(b);
      judge(id, {
        signed_in: outcome === "signed_in" && b.sb.count("password") === 1 && b.sb.count("user") === 1,
        ...policyAttrsHold(live(ws), b.https),
        max_age_30_days: live(ws).every((w) => w.attrs["max-age"] === "2592000") && within30Days(b, b.key),
        // the writer plans over every name a reader accepts (the bare key and .0-.15), so names this tab cannot see are
        // removed too; on an empty jar each such removal is a no-op, carries the policy, and leaves exactly the session
        removals_only_unused_family_names: removals(ws).every((w) => w.name.startsWith(`${b.key}.`) && /^(\d|1[0-5])$/.test(w.name.slice(b.key.length + 1))),
        removals_carry_the_policy: Object.values(policyAttrsHold(removals(ws), b.https)).every(Boolean),
        only_the_bare_key_remains: JSON.stringify(b.jar.names().filter(b.isFamily)) === JSON.stringify([b.key]),
        joined_is_the_session: decodeJoined(b)?.refresh_token === b.sb.last().refresh,
      }, { writes: ws.map((w) => attrsOf(w, b)), calls: b.sb.st.calls.map((c) => `${c.kind}:${c.status}`) });
    });
  }

  for (const [id, page, supabaseUrl] of [["R1", HTTP_PAGE, LOOPBACK_SUPABASE], ["R2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    it(`${id} a refresh's commit writes the new session with the same policy (${page.startsWith("https") ? "HTTPS" : "HTTP"})`, async () => {
      const b = await boot({ page, supabaseUrl });
      b.sb.st.expiresIn = 60; // inside the SDK's 90 s margin: the next read refreshes
      await signIn(b);
      const m = b.jar.writes.length;
      const read = await b.shared().auth.getSession();
      await settle();
      const ws = familyWrites(b, m);
      judge(id, {
        refreshed: !read.error && b.sb.count("refresh") === 1 && read.data.session?.refresh_token === b.sb.last().refresh,
        ...policyAttrsHold(live(ws), b.https),
        stored_is_the_new_session: decodeJoined(b)?.refresh_token === b.sb.last().refresh,
      }, { writes: ws.map((w) => attrsOf(w, b)) });
    });
  }

  for (const [id, page, supabaseUrl] of [["C1", HTTP_PAGE, LOOPBACK_SUPABASE], ["C2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE]] as const) {
    it(`${id} chunked sessions: every chunk carries the policy; a smaller refreshed session removes the obsolete chunk names with Max-Age=0 and the same attributes`, async () => {
      const b = await boot({ page, supabaseUrl, meta: { padding: "p".repeat(7000) } });
      b.sb.st.expiresIn = 60;
      await signIn(b);
      const chunkedNames = b.jar.names().filter(b.isFamily);
      b.sb.st.meta = {}; // the refreshed session is small: one bare cookie
      const m = b.jar.writes.length;
      await b.shared().auth.getSession();
      await settle();
      const ws = familyWrites(b, m);
      judge(id, {
        signed_in_chunked: chunkedNames.length >= 3 && chunkedNames.every((n) => n.startsWith(`${b.key}.`)),
        ...policyAttrsHold(ws, b.https),
        removals_are_max_age_0: chunkedNames.every((n) => removals(ws).some((w) => w.name === n)) && removals(ws).length <= 16,
        only_the_bare_key_remains: JSON.stringify(b.jar.names().filter(b.isFamily)) === JSON.stringify([b.key]),
        stored_is_the_new_session: decodeJoined(b)?.refresh_token === b.sb.last().refresh,
      }, { before: chunkedNames.map((n) => n.replace(b.key, "<key>")), writes: ws.map((w) => attrsOf(w, b)) });
    });
  }

  for (const [id, page, supabaseUrl, pad] of [["D1", HTTP_PAGE, LOOPBACK_SUPABASE, 0], ["D2", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE, 7000]] as const) {
    it(`${id} End Session in the browser removes every family name (${pad ? "chunked" : "bare"}) and the verifier/user roots with Max-Age=0 and the policy attributes, after revoking with the current token`, async () => {
      const b = await boot({ page, supabaseUrl, meta: pad ? { padding: "p".repeat(pad) } : {} });
      await signIn(b);
      b.jar.plant(`${b.key}-code-verifier=v; Path=/`);
      b.jar.plant(`${b.key}-user=u; Path=/`);
      const m = b.jar.writes.length;
      const outcome = await b.mods.publication.endSessionInBrowser(GOLFER);
      await settle();
      const ws = familyWrites(b, m).filter((w) => w.name === b.key || /\.\d+$/.test(w.name));
      judge(id, {
        ended: outcome === "ended" && b.sb.count("logout") === 1,
        ...policyAttrsHold(ws, b.https),
        only_removals: ws.length >= 1 && removals(ws).length === ws.length,
        nothing_left: b.jar.names().filter((n) => n.startsWith(b.key)).length === 0,
      }, { writes: familyWrites(b, m).map((w) => attrsOf(w, b)) });
    });
  }

  it("D3 a coded refresh rejection (400 refresh_token_not_found): the session is removed with Max-Age=0, never a fresh write", async () => {
    const b = await boot();
    b.sb.st.expiresIn = 60;
    await signIn(b);
    b.sb.st.refreshMode = "reject";
    const m = b.jar.writes.length;
    const read = await b.shared().auth.getSession();
    await settle();
    const ws = familyWrites(b, m);
    judge("D3", {
      refused: read.data.session === null && b.sb.count("refresh") === 1,
      ...policyAttrsHold(ws, false),
      only_removals: ws.length >= 1 && live(ws).length === 0,
      jar_empty: b.jar.names().filter(b.isFamily).length === 0,
    }, { writes: ws.map((w) => attrsOf(w, b)) });
  });

  it("D4 a 500 on refresh keeps the stored session (the AG-WEB-READY-02 policy: an outage is not a sign-out); nothing is written or removed", async () => {
    // fake time for this case, so the SDK's own ~25 s retry loop (answered locally during the cooldown) completes here
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    try {
      const b = await boot();
      b.sb.st.expiresIn = 60;
      const drive = async <T,>(p: Promise<T>): Promise<T> => {
        let done = false;
        let value: T | undefined;
        void p.then((v) => { done = true; value = v; });
        for (let i = 0; i < 2_000 && !done; i++) {
          await vi.advanceTimersByTimeAsync(25);
          for (let k = 0; k < 4; k++) await new Promise<void>((r) => setImmediate(r));
        }
        expect(done).toBe(true);
        return value as T;
      };
      await drive(signIn(b));
      b.sb.st.refreshMode = "outage500";
      const m = b.jar.writes.length;
      const read = await drive(b.shared().auth.getSession());
      judge("D4", {
        error_reported: !!read.error && read.data.session === null,
        one_real_request: b.sb.count("refresh") === 1,
        no_family_write: familyWrites(b, m).length === 0,
        session_kept: decodeJoined(b)?.refresh_token === b.sb.last().refresh,
      }, { error: (read.error as { name?: string } | null)?.name ?? null, writes: familyWrites(b, m).map((w) => attrsOf(w, b)) });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("E1 URL-escaped values round-trip and unrelated cookie pairs are never touched (sign-in, refresh, End Session)", async () => {
    const b = await boot({ meta: { note: "é; =% \"q\"" }, plant: ["unrelated=keep%20me; Path=/", "other.0=x; Path=/"] });
    b.sb.st.expiresIn = 60;
    await signIn(b);
    const afterSignIn = decodeJoined(b);
    await b.shared().auth.getSession();
    await settle();
    await b.mods.publication.endSessionInBrowser(GOLFER);
    await settle();
    judge("E1", {
      metadata_round_trips: afterSignIn?.user?.user_metadata?.note === "é; =% \"q\"",
      unrelated_untouched: b.jar.writes.every((w) => w.name !== "unrelated" && w.name !== "other.0") && b.jar.entry("unrelated")?.value === "keep%20me",
    }, { names: b.jar.names().map((n) => n.replace(b.key, "<key>")) });
  });

  it("N1 the PKCE code verifier (a non-session name) keeps the SDK's own serialization, on HTTPS too", async () => {
    const b = await boot({ page: HTTPS_PAGE, supabaseUrl: HOSTED_SHAPED_SUPABASE });
    const m = b.jar.writes.length;
    await b.shared().auth.resetPasswordForEmail(EMAIL);
    await settle();
    const verifier = b.jar.writes.slice(m).find((w) => w.name === `${b.key}-code-verifier`);
    judge("N1", {
      written: !!verifier && verifier.accepted,
      sdk_default_options: !!verifier && verifier.attrs.path === "/" && (verifier.attrs.samesite ?? "").toLowerCase() === "lax" && !("secure" in verifier.attrs) && Number(verifier.attrs["max-age"]) > 2592000,
    }, { verifier: verifier ? attrsOf(verifier, b) : null });
  });

  it("S1 repeated factory calls in a browser return the one cached client, built with the session storage and the session transport", async () => {
    const b = await boot();
    const one = b.shared();
    const two = b.shared();
    const options = cap.options[0] as { auth?: { storage?: Record<string, unknown> }; global?: { fetch?: unknown } };
    judge("S1", {
      same_client: one === two && cap.options.length === 1,
      storage_object: typeof options.auth?.storage?.getItem === "function" && typeof options.auth?.storage?.setItem === "function" && typeof options.auth?.storage?.removeItem === "function",
      plain_object_storage: Object.getPrototypeOf(options.auth?.storage) === Object.prototype,
      transport: typeof options.global?.fetch === "function",
      no_cookie_adapter: !("cookies" in (options as Record<string, unknown>)),
    }, { optionKeys: Object.keys(options) });
  });

  it("S2 the SDK initialization contract is unchanged (PKCE, auto-refresh, URL detection, persistence, storage key, client info)", async () => {
    const b = await boot();
    const auth = b.shared().auth as unknown as { flowType: string; autoRefreshToken: boolean; detectSessionInUrl: boolean; persistSession: boolean; storageKey: string; headers: Record<string, string> };
    judge("S2", {
      pkce: auth.flowType === "pkce",
      auto_refresh: auth.autoRefreshToken === true,
      detects_url: auth.detectSessionInUrl === true,
      persists: auth.persistSession === true,
      storage_key: auth.storageKey === b.key,
      client_info: /supabase-ssr\/0\.3\.0/.test(auth.headers["X-Client-Info"] ?? ""),
    }, { flowType: auth.flowType, storageKey: auth.storageKey.replace(b.key, "<key>") });
  });

  it("S3 without a browser (server render of a client page): a new client per call, no auto-refresh, an empty session, no throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOOPBACK_SUPABASE);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
    const mod = await import("@/utils/supabase/client");
    const one = mod.createClient() as unknown as SbClient;
    const two = mod.createClient() as unknown as SbClient;
    const read = await one.auth.getSession();
    judge("S3", {
      distinct: one !== two,
      no_auto_refresh: (one.auth as unknown as { autoRefreshToken: boolean }).autoRefreshToken === false,
      empty: read.data.session === null && !read.error,
    }, {});
  });

  it("M1 importing the factory and the session modules touches no browser global", async () => {
    const touched: string[] = [];
    for (const name of ["window", "document", "navigator", "location", "indexedDB"]) {
      Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); return undefined; } });
    }
    await import("@/utils/supabase/client");
    await import("@/utils/supabase/session-publication");
    for (const name of ["window", "document", "navigator", "location", "indexedDB"]) delete (globalThis as Record<string, unknown>)[name];
    judge("M1", { nothing_touched: touched.length === 0 }, { touched });
  });

  for (const [id, page, supabaseUrl, pad] of [["X1", HTTP_PAGE, LOOPBACK_SUPABASE, 0], ["X1s", HTTPS_PAGE, HOSTED_SHAPED_SUPABASE, 7000]] as const) {
    it(`${id} a session the browser storage wrote (${pad ? "chunked" : "bare"}) is read by the server's parser (Next RequestCookies) and the shared layout reader as the same session`, async () => {
      const b = await boot({ page, supabaseUrl, meta: { note: "é; =%", ...(pad ? { padding: "p".repeat(pad) } : {}) } });
      await signIn(b);
      const rc = new RequestCookies(new Headers({ cookie: b.jar.header() }));
      const header = rc.getAll().map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
      const { readSessionLayout, parseCookieHeader } = requireLayout();
      const layout = readSessionLayout(parseCookieHeader(header), b.key);
      const parsed = layout.kind === "present" ? (JSON.parse(layout.value) as SbSession) : null;
      judge(id, {
        server_reads_the_session: parsed?.access_token === b.sb.last().access && parsed?.refresh_token === b.sb.last().refresh,
        metadata_round_trips: parsed?.user?.user_metadata?.note === "é; =%",
      }, { layout: layout.kind });
    });
  }

  it("X3 rollback readability: the installed @supabase/ssr reader reads what this storage wrote, and this storage reads what ssr 0.3.0 wrote", async () => {
    const b = await boot({ meta: { padding: "p".repeat(5000) } });
    await signIn(b);
    const written = decodeJoined(b);
    const legacy = cap.real.createBrowserClient(LOOPBACK_SUPABASE, ANON, { isSingleton: false }) as SbClient; // ssr's own cookie storage
    const legacyRead = await legacy.auth.getSession();
    const results: Record<string, boolean> = { ssr_reads_ours: legacyRead.data.session?.refresh_token === written?.refresh_token };
    const c = await boot({ meta: { padding: "p".repeat(5000) } });
    const seeded = c.sb.seed(3600);
    for (const raw of plantSession(c.key, seeded.session, accepted)) c.jar.plant(raw);
    const m = c.jar.writes.length;
    const read = await c.shared().auth.getSession();
    results.ours_reads_ssr_format = read.data.session?.access_token === seeded.access;
    results.not_rewritten_on_read = c.jar.writes.length === m;
    judge("X3", results, {});
  });

  it("X4 an existing longer-lived cookie is not rewritten on read (repaired only when the session is next written)", async () => {
    const b = await boot({ page: HTTPS_PAGE, supabaseUrl: HOSTED_SHAPED_SUPABASE });
    const seeded = b.sb.seed(3600);
    for (const raw of plantSession(b.key, seeded.session, accepted)) b.jar.plant(raw);
    const before = b.jar.entry(b.key)?.expiresAt ?? null;
    const m = b.jar.writes.length;
    const read = await b.shared().auth.getSession();
    await settle();
    judge("X4", {
      read_ok: read.data.session?.access_token === seeded.access,
      no_write_on_read: b.jar.writes.length === m,
      keeps_its_attributes: b.jar.entry(b.key)?.expiresAt === before && !("secure" in (b.jar.entry(b.key)?.attrs ?? {})),
    }, {});
  });

  it("K1 the storage classifies the SDK's own key for an untrimmed URL (supabase-js trims, then derives the key)", async () => {
    const b = await boot({ envUrl: `  ${LOOPBACK_SUPABASE}  ` });
    await signIn(b);
    judge("K1", { written_under_the_sdk_key: b.jar.names().includes(b.key) && decodeJoined(b) !== null }, { names: b.jar.names().map((n) => n.replace(b.key, "<key>")) });
  });

  it("A2 without a browser global the session storage is inert (no document access, no throw)", async () => {
    const { createSessionStorage } = await import("@/utils/supabase/session-storage");
    const storage = createSessionStorage("sb-127-auth-token");
    const results = await Promise.all([storage.getItem("sb-127-auth-token"), storage.setItem("sb-127-auth-token", "{}"), storage.removeItem("sb-127-auth-token")]);
    judge("A2", { inert: results[0] === null && results[1] === undefined && results[2] === undefined }, {});
  });

  it("G1 structure: the factory hands the SDK this storage and transport; the storage alone serializes session cookies, with the policy attributes and no token logging", () => {
    const strip = (src: string) => src.replace(/\r\n/g, "\n").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const client = strip(readFileSync(path.join(ROOT, "utils/supabase/client.ts"), "utf8"));
    const storage = strip(readFileSync(path.join(ROOT, "utils/supabase/session-storage.ts"), "utf8"));
    const envNames = Array.from(new Set(Array.from(client.matchAll(/process\.env\.([A-Z0-9_]+)/g)).map((x) => x[1]))).sort();
    judge("G1", {
      client_uses_storage_and_transport: /auth: \{ storage: createSessionStorage\(storageKey\) \}/.test(client) && /global: \{ fetch: withSessionTransport\(supabaseUrl, /.test(client),
      client_has_no_cookie_adapter: !/cookies:\s*\{/.test(client) && !/getAll|setAll/.test(client),
      client_writes_no_cookie: !/document\.cookie\s*=/.test(client),
      // A1: one attribute helper for the session family and the binding cookie; session writes 30 days, removals 0
      storage_policy_attributes:
        /return \{ path: "\/", sameSite: "lax" as const, secure: window\.location\.protocol === "https:", maxAge \};/.test(storage) &&
        /cookieAttributes\(operation\.value === null \? 0 : SESSION_COOKIE_MAX_AGE_S\)/.test(storage) &&
        /serialize\(SESSION_BINDING_COOKIE, value, cookieAttributes\(SESSION_COOKIE_MAX_AGE_S\)\)/.test(storage),
      storage_secure_from_protocol: /secure: window\.location\.protocol === "https:"/.test(storage),
      storage_no_httponly_or_domain: !/httpOnly:\s*true|domain:/.test(storage),
      no_console_or_web_storage: !/\bconsole\.|localStorage|sessionStorage/.test(client + storage),
      env_names_unchanged: JSON.stringify(envNames) === JSON.stringify(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]),
    }, { envNames });
  });
});
