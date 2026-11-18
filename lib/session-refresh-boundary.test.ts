import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { parseCookie } from "next/dist/compiled/@edge-runtime/cookies";
import { createChunks as ssrCreateChunks } from "@supabase/ssr";
import { middleware, config } from "@/middleware";

// ============================================================================
// Session refresh boundary — the real middleware, the real SDK
// ============================================================================
//
// `middleware()` runs with a real NextRequest. The installed @supabase/ssr
// 0.3.0 and auth-js run unmodified. Only Auth HTTP is replaced, at the
// platform fetch, by an in-memory synthetic stand-in. The forwarded cookie is
// composed into the real verifier (`resolveVerifiedAuth`) through a mocked
// `next/headers` that serves exactly the effective downstream cookie header.
//
// Test-only observation, no production hook: `createServerClient` is wrapped
// (importOriginal) so the bounded fetch the boundary passes in can be
// observed call by call, and console methods are spied on until settlement.
//
// Every case reports its sub-checks by name. A failure message carries
// `observed {json}` with the failing names and a redacted observation (names,
// counts, booleans; never a token or cookie value), so the control judge can
// tell a named failure from a vacuous preservation pass.
//
// The only static app import is `@/middleware`; the boundary module and the
// verifier are imported dynamically, so this file also loads on the control
// tree (the unchanged pass-through middleware).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_URL = "http://127.0.0.1:54329";
const ANON = "ag-session-02-synthetic-anon-key";
const KEY = "sb-127-auth-token";
const APP = "http://127.0.0.1:3941";
const FIXED = { reject: "Auth refresh rejected", fail: "Auth refresh failed", local: "Auth refresh not completed" };
const ALLOWED = ["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"];
const NETWORK = [502, 503, 504, 520, 521, 522, 523, 524, 530];
const MAX_AGE = 2592000;
const T_A = 3000;
const K = 2;
const T_B = 5000;
const STEP = 10;
const SETTLE_MS = 36_000;
const BOUNDARY = "utils/supabase/session-refresh.ts";
const MARK = `zq${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`; // synthetic marker prefix (starts with a letter)

// ── module mocks (test-only observation) ────────────────────────────────────
interface WrapperCall {
  t: number;
  seq: number;
  dispatchesBefore: number;
  dispatchesAfter: number;
  status: number;
  headerNames: string[];
  body: Uint8Array;
  tReturned: number;
}
const cap = vi.hoisted(() => ({
  created: 0,
  throwOnCreate: false,
  throwInCommit: false,
  shapes: [] as { cookieKeys: string[]; auth: Record<string, unknown>; globalKeys: string[] }[],
  calls: [] as WrapperCall[],
  seq: 0,
  dispatchCount: (() => 0) as () => number,
}));
const downstream = vi.hoisted(() => ({ cookie: null as string | null }));

vi.mock("@supabase/ssr", async (importOriginal) => {
  const real = await importOriginal<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createChunks: (...args: Parameters<typeof real.createChunks>) => {
      if (cap.throwInCommit) throw new Error("injected commit-path failure");
      return real.createChunks(...args);
    },
    createServerClient: (url: string, key: string, options: Parameters<typeof real.createServerClient>[2]) => {
      cap.created += 1;
      if (cap.throwOnCreate) throw new Error("injected construction failure");
      const o = options as unknown as { cookies: Record<string, unknown>; auth?: Record<string, unknown>; global?: Record<string, unknown> };
      cap.shapes.push({ cookieKeys: Object.keys(o.cookies).sort(), auth: { ...(o.auth ?? {}) }, globalKeys: Object.keys(o.global ?? {}).sort() });
      const inner = o.global?.fetch as typeof fetch;
      const capturing = async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = { t: Date.now(), seq: ++cap.seq, dispatchesBefore: cap.dispatchCount() } as WrapperCall;
        const response = await inner(input, init);
        call.tReturned = Date.now();
        call.dispatchesAfter = cap.dispatchCount();
        call.status = response.status;
        call.headerNames = Array.from(response.headers.keys());
        call.body = new Uint8Array(await response.clone().arrayBuffer());
        cap.calls.push(call);
        return response;
      };
      return real.createServerClient(url, key, { ...options, global: { ...(o.global ?? {}), fetch: capturing } } as typeof options);
    },
  };
});

vi.mock("next/headers", async () => {
  const { RequestCookies } = await import("next/dist/compiled/@edge-runtime/cookies");
  return {
    cookies: async () => new RequestCookies(new Headers(downstream.cookie === null ? {} : { cookie: downstream.cookie })),
    headers: async () => new Headers(),
  };
});

// ── the synthetic Auth stand-in (platform fetch) ────────────────────────────
interface Family {
  id: number;
  userId: string;
  tokens: string[];
  revokedAt: Map<string, number>;
  access: string;
  accessExp: number;
  alive: boolean;
  pending: number;
  padding: number;
}
type Mode =
  | { kind: "grant"; delay?: number }
  | { kind: "drop"; delay?: number }
  | { kind: "hang" }
  | {
      kind: "raw";
      status: number;
      body?: string | Uint8Array | null;
      headers?: Record<string, string>;
      delay?: number;
      bodyHang?: boolean;
      armParseThrow?: boolean;
      stream?: boolean;
    };
interface TokenCall {
  t: number;
  seq: number;
  refreshToken: string;
  redirect: string | undefined;
  sentBody: Uint8Array | null;
  streamCancelled: boolean;
  aborted: number | null;
  timers: number;
}
const sim = {
  families: [] as Family[],
  script: [] as Mode[],
  fallback: { kind: "grant" } as Mode,
  tokenCalls: [] as TokenCall[],
  userCalls: [] as { t: number; family: number | null; current: boolean }[],
  egress: [] as string[],
  seq: 0,
  parentRule: true,
  reuseDetection: true,
  reuseIntervalMs: 10_000,
  conflict: false,
  secrets: new Set<string>(),
};
const tok = (kind: string) => {
  const v = `${kind}-${crypto.randomUUID()}`;
  sim.secrets.add(v);
  return v;
};
const nowS = () => Math.floor(Date.now() / 1000);
function newFamily(opts: { padding?: number } = {}): Family {
  const fam: Family = {
    id: sim.families.length + 1,
    userId: crypto.randomUUID(),
    tokens: [tok("rt")],
    revokedAt: new Map(),
    access: tok("at"),
    accessExp: Date.now() - 60_000, // the planted access token has expired
    alive: true,
    pending: 0,
    padding: opts.padding ?? 0,
  };
  sim.families.push(fam);
  return fam;
}
const sessionBody = (fam: Family) =>
  JSON.stringify({
    access_token: fam.access,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: nowS() + 3600,
    refresh_token: fam.tokens[fam.tokens.length - 1],
    user: {
      id: fam.userId,
      aud: "authenticated",
      role: "authenticated",
      email: "golfer@example.invalid",
      app_metadata: {},
      user_metadata: fam.padding ? { pad: "p".repeat(fam.padding) } : {},
    },
  });
const V = { "X-Supabase-Api-Version": "2024-01-01" };
const JSON_H = { "content-type": "application/json; charset=utf-8" };
const HTML_H = { "content-type": "text/html; charset=utf-8" };
function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = { ...JSON_H, ...V }): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
function grant(call: TokenCall): Response {
  const fam = sim.families.find((f) => f.tokens.includes(call.refreshToken));
  if (!fam) return jsonAnswer(400, { code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" });
  if (!fam.alive) return jsonAnswer(400, { code: "refresh_token_already_used", message: "Invalid Refresh Token: Already Used" });
  const index = fam.tokens.indexOf(call.refreshToken);
  const active = fam.tokens.length - 1;
  const ok = () => {
    const text = sessionBody(fam);
    call.sentBody = new TextEncoder().encode(text);
    return new Response(text, { status: 200, headers: JSON_H });
  };
  if (index === active) {
    fam.revokedAt.set(call.refreshToken, Date.now());
    fam.tokens.push(tok("rt"));
    fam.access = tok("at");
    fam.accessExp = Date.now() + 3_600_000;
    return ok();
  }
  if (index === active - 1 && sim.parentRule) return ok(); // the parent of the active token returns the active token
  const revoked = fam.revokedAt.get(call.refreshToken) ?? 0;
  if (!sim.reuseDetection || Date.now() - revoked < sim.reuseIntervalMs) return ok();
  fam.alive = false; // any other reuse terminates the family
  return jsonAnswer(400, { code: "refresh_token_already_used", message: "Invalid Refresh Token: Already Used" });
}
function build(mode: Mode, call: TokenCall, signal: AbortSignal | undefined): Response {
  if (mode.kind === "grant") return grant(call);
  if (mode.kind !== "raw") throw new Error("unexpected mode");
  const body = mode.body ?? null;
  if (mode.bodyHang || mode.stream) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body ?? new Uint8Array(0);
    if (!mode.bodyHang) call.sentBody = bytes;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode.bodyHang) signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      },
      pull(controller) {
        if (mode.bodyHang) return new Promise<void>(() => undefined); // headers only; the body never arrives
        if (offset >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 4096));
        offset += 4096;
      },
      cancel() {
        call.streamCancelled = true;
      },
    });
    return new Response(stream, { status: mode.status, headers: mode.headers });
  }
  if (typeof body === "string") call.sentBody = new TextEncoder().encode(body);
  else if (body) call.sentBody = body;
  return new Response(body as BodyInit | null, { status: mode.status, headers: mode.headers });
}
async function standInFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const seq = ++sim.seq;
  if (url.origin !== SUPABASE_URL) {
    sim.egress.push(url.origin);
    throw new TypeError("stand-in: non-stand-in origin refused");
  }
  if (url.pathname === "/auth/v1/user") {
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const fam = sim.families.find((f) => f.access === bearer) ?? null;
    const current = !!fam && fam.alive && fam.accessExp > Date.now();
    sim.userCalls.push({ t: Date.now(), family: fam?.id ?? null, current });
    if (!fam || !current) return jsonAnswer(401, { code: "bad_jwt", message: "invalid JWT" });
    return jsonAnswer(200, { id: fam.userId, aud: "authenticated", role: "authenticated", email: "golfer@example.invalid", app_metadata: {}, user_metadata: {} });
  }
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
    const call: TokenCall = { t: Date.now(), seq, refreshToken: String(sent.refresh_token ?? ""), redirect: init?.redirect, sentBody: null, streamCancelled: false, aborted: null, timers: vi.getTimerCount() };
    sim.tokenCalls.push(call);
    let mode = sim.script.length ? (sim.script.shift() as Mode) : sim.fallback;
    const fam = sim.families.find((f) => f.tokens.includes(call.refreshToken));
    if (mode.kind === "grant" && sim.conflict && fam && fam.pending > 0) {
      mode = { kind: "raw", status: 409, body: JSON.stringify({ code: "conflict", message: "conflict" }), headers: { ...JSON_H, ...V } };
    }
    if (fam) fam.pending += 1;
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (fam) fam.pending -= 1;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        call.aborted = Date.now();
        done();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (mode.kind === "hang") return;
      timer = setTimeout(() => {
        done();
        if (mode.kind === "drop") return reject(new TypeError("fetch failed"));
        try {
          const response = build(mode, call, signal);
          if (mode.kind === "raw" && mode.armParseThrow) {
            vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
              throw new TypeError("injected parser failure");
            });
          }
          resolve(response);
        } catch (e) {
          reject(e);
        }
      }, mode.kind === "grant" || mode.kind === "drop" || mode.kind === "raw" ? mode.delay ?? 1 : 1);
    });
  }
  sim.egress.push(`${url.origin}${url.pathname}`);
  return jsonAnswer(404, { message: "stand-in: not found" });
}

// ── fixtures ────────────────────────────────────────────────────────────────
interface Envelope {
  access?: string;
  refresh?: string;
  expiresAt?: number | string | null;
  userId?: string;
  email?: string;
  userMeta?: Record<string, unknown>;
  appMeta?: Record<string, unknown>;
  pad?: number;
}
function envelope(fam: Family, e: Envelope = {}): string {
  const user = {
    id: e.userId ?? fam.userId,
    aud: "authenticated",
    role: "authenticated",
    email: e.email ?? "golfer@example.invalid",
    app_metadata: e.appMeta ?? {},
    user_metadata: e.pad ? { ...(e.userMeta ?? {}), pad: "q".repeat(e.pad) } : e.userMeta ?? {},
  };
  return JSON.stringify({
    access_token: e.access ?? fam.access,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: e.expiresAt === undefined ? nowS() - 30 : e.expiresAt,
    refresh_token: e.refresh ?? fam.tokens[fam.tokens.length - 1],
    user,
  });
}
/** family pairs as the browser writer stores them (name=encodeURIComponent(value)) */
function familyPairs(value: string, layout: "bare" | "chunked" = "bare"): string[] {
  const chunks = layout === "bare" ? [{ name: KEY, value }] : ssrCreateChunks(KEY, value);
  if (layout === "chunked" && chunks.length < 2) throw new Error("fixture too small to chunk");
  for (const c of chunks) sim.secrets.add(encodeURIComponent(c.value).slice(0, 60));
  return chunks.map((c) => `${c.name}=${encodeURIComponent(c.value)}`);
}
const cookieOf = (...pairs: (string | string[])[]) => pairs.flat().join("; ");

// ── observation ─────────────────────────────────────────────────────────────
interface SetCookie {
  name: string;
  value: string;
  attrs: Record<string, string>;
}
function parseSetCookieLine(line: string): SetCookie {
  const [first, ...rest] = line.split(/; */);
  const at = first.indexOf("=");
  const attrs: Record<string, string> = {};
  for (const a of rest) {
    const i = a.indexOf("=");
    attrs[(i === -1 ? a : a.slice(0, i)).toLowerCase()] = i === -1 ? "" : a.slice(i + 1);
  }
  return { name: first.slice(0, at), value: decodeURIComponent(first.slice(at + 1)), attrs };
}
const isFamily = (name: string) => name === KEY || /^sb-127-auth-token\.\d+$/.test(name);
function effectiveCookie(response: Response, original: string | null): string | null {
  const override = response.headers.get("x-middleware-override-headers");
  if (override === null) return original;
  const keys = override.split(",").map((k) => k.trim());
  return keys.includes("cookie") ? response.headers.get("x-middleware-request-cookie") : null;
}
function joinFamily(map: Map<string, string>): string | undefined {
  const bare = map.get(KEY);
  if (bare) return bare;
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    const c = map.get(`${KEY}.${i}`);
    if (!c) break;
    parts.push(c);
  }
  return parts.length ? parts.join("") : undefined;
}
function sessionIn(cookieHeader: string | null): { access_token?: string; refresh_token?: string } | null {
  if (!cookieHeader) return null;
  const parsed = parseCookie(cookieHeader);
  const joined = joinFamily(new Map(Array.from(parsed.entries()).filter(([n]) => isFamily(n))));
  if (!joined) return null;
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}
const realTick = () => new Promise<void>((r) => setImmediate(r));
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const unhandled = { count: 0 };
const onUnhandled = () => {
  unhandled.count += 1;
};

interface Obs {
  t0: number;
  R: number | null;
  threw: boolean;
  response: Response | null;
  headersAtR: [string, string][];
  headersAtZ: [string, string][];
  setCookies: SetCookie[];
  override: boolean;
  effective: string | null;
  lines: Record<string, unknown>[];
  allLines: Record<string, unknown>[];
  record: Record<string, unknown> | null;
  seal: number | null;
  tokenCalls: TokenCall[];
  dispatchesAtR: number;
  calls: WrapperCall[];
  console: { m: string; args: unknown[]; t: number }[];
  timersAtZ: number;
  unhandled: number;
  created: number;
  bodyUsed: boolean;
  verifier: { status: string; userId: string | null } | null;
  userCalls: { family: number | null; current: boolean }[];
}
interface RunSpec {
  cookie?: string | null;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  script?: Mode[];
  fallback?: Mode;
  verify?: boolean;
}

async function runAll(specs: RunSpec[]): Promise<Obs[]> {
  cap.calls = [];
  cap.created = 0;
  cap.shapes = [];
  sim.tokenCalls = [];
  sim.userCalls = [];
  sim.egress = [];
  sim.script = [...(specs[0].script ?? [])];
  sim.fallback = specs[0].fallback ?? { kind: "grant" };
  const consoleCalls: { m: string; args: unknown[]; t: number }[] = [];
  const spies = METHODS.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleCalls.push({ m, args, t: Date.now() });
    }),
  );
  const unhandledBefore = unhandled.count;
  const t0 = Date.now();
  const states = specs.map((spec) => {
    const headers = new Headers(spec.headers ?? {});
    if (spec.cookie != null) headers.set("cookie", spec.cookie);
    const request = new NextRequest(spec.url ?? `${APP}/goals`, { method: spec.method ?? "GET", headers, body: spec.body });
    const st = { spec, request, R: null as number | null, response: null as Response | null, threw: false, headersAtR: [] as [string, string][], dispatchesAtR: 0 };
    Promise.resolve()
      .then(() => middleware(request))
      .then(
        (r) => {
          st.R = Date.now();
          st.response = r as Response;
          st.headersAtR = Array.from((r as Response).headers.entries());
          st.dispatchesAtR = sim.tokenCalls.length;
        },
        () => {
          st.R = Date.now();
          st.threw = true;
        },
      );
    return st;
  });
  for (let i = 0; states.some((s) => s.R === null) && i < 2500; i++) {
    await vi.advanceTimersByTimeAsync(STEP);
    await realTick();
  }
  await vi.advanceTimersByTimeAsync(SETTLE_MS); // ≥ 35 s past R: beyond the SDK's 30 s horizon and its longest backoff
  for (let i = 0; i < 20; i++) await realTick();
  const timersAtZ = vi.getTimerCount();
  for (const s of spies) s.mockRestore();
  const allLines = consoleCalls
    .filter((c) => c.m === "info" && typeof c.args[0] === "string" && (c.args[0] as string).startsWith("session-refresh "))
    .map((c) => JSON.parse((c.args[0] as string).slice("session-refresh ".length)) as Record<string, unknown>);
  const out: Obs[] = [];
  for (let index = 0; index < states.length; index++) {
    const st = states[index];
    const response = st.response;
    // concurrent runs: lines are judged in aggregate (fake timers do not carry async context)
    const lines = specs.length > 1 ? [] : allLines;
    void index;
    const record = lines[0] ?? null;
    const seal = record && typeof record.ms_to_seal === "number" ? t0 + (record.ms_to_seal as number) : null;
    const obs: Obs = {
      t0,
      R: st.R,
      threw: st.threw,
      response,
      headersAtR: st.headersAtR,
      headersAtZ: response ? Array.from(response.headers.entries()) : [],
      setCookies: response ? response.headers.getSetCookie().map(parseSetCookieLine) : [],
      override: !!response?.headers.get("x-middleware-override-headers"),
      effective: response ? effectiveCookie(response, st.spec.cookie ?? null) : st.spec.cookie ?? null,
      lines,
      allLines,
      record,
      seal,
      tokenCalls: sim.tokenCalls.slice(),
      dispatchesAtR: st.dispatchesAtR,
      calls: cap.calls.slice(),
      console: consoleCalls,
      timersAtZ,
      unhandled: unhandled.count - unhandledBefore,
      created: cap.created,
      bodyUsed: st.request.bodyUsed,
      verifier: null,
      userCalls: [],
    };
    if (st.spec.verify !== false) {
      downstream.cookie = obs.effective;
      const userBefore = sim.userCalls.length;
      const server = await import("@/utils/supabase/server");
      let result: { status: string; userId?: string } | null = null;
      const pending = server.resolveVerifiedAuth().then((r) => {
        result = r as { status: string; userId?: string };
      });
      for (let i = 0; !result && i < 200; i++) {
        await vi.advanceTimersByTimeAsync(STEP);
        await realTick();
      }
      await pending;
      const r = result as { status: string; userId?: string } | null;
      obs.verifier = r ? { status: r.status, userId: r.status === "authenticated" ? r.userId ?? null : null } : null;
      obs.userCalls = sim.userCalls.slice(userBefore).map((u) => ({ family: u.family, current: u.current }));
    }
    out.push(obs);
  }
  return out;
}
const run = async (spec: RunSpec) => (await runAll([spec]))[0];

// ── shape of what the SDK received ──────────────────────────────────────────
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const FIXED_BODIES = new Set([
  JSON.stringify({ msg: FIXED.fail }),
  JSON.stringify({ msg: FIXED.local }),
  ...ALLOWED.map((c) => JSON.stringify({ msg: FIXED.reject, error_code: c })),
]);
function shapeOf(call: WrapperCall, tokenCalls: TokenCall[]): string {
  if (call.headerNames.length > 0) return "HAS_HEADERS";
  const body = text(call.body);
  if (call.status === 500 && body === JSON.stringify({ msg: FIXED.local })) return "L-N";
  if (call.status === 503 && call.body.byteLength === 0) return "L-R-or-503";
  if (call.body.byteLength === 0 && NETWORK.includes(call.status)) return "network-status";
  if (FIXED_BODIES.has(body)) return body.includes(FIXED.reject) ? "fixed-reject" : "fixed-fail";
  if (call.status >= 200 && call.status < 300) {
    const dispatched = tokenCalls.slice(call.dispatchesBefore, call.dispatchesAfter);
    const real = dispatched.find((d) => d.sentBody && Buffer.compare(Buffer.from(d.sentBody), Buffer.from(call.body)) === 0);
    try {
      const v = JSON.parse(body);
      if (real && v && v.access_token && v.refresh_token && v.expires_in) return "session";
    } catch {
      /* not JSON */
    }
  }
  return "OTHER";
}

// ── the per-layer sub-checks (DESIGN.md §5.1; draft §6.1) ───────────────────
function layers(o: Obs): Record<string, boolean> {
  const seal = o.seal;
  const tokenAfterSeal = seal === null ? 0 : o.tokenCalls.filter((c) => c.t > seal).length;
  const tokenAfterR = o.tokenCalls.length - o.dispatchesAtR;
  const late = seal === null ? [] : o.calls.filter((c) => c.t > seal);
  return {
    D_no_dispatch_after_seal: tokenAfterSeal === 0,
    D_no_dispatch_after_R: tokenAfterR === 0,
    D_record_counts_every_dispatch: o.record === null ? o.tokenCalls.length === 0 : o.record.dispatches === o.tokenCalls.length,
    I_at_most_one_late_call: late.length <= 1,
    I_late_calls_are_local_final_without_dispatch: late.every((c) => shapeOf(c, o.tokenCalls) === "L-N" && c.dispatchesAfter === c.dispatchesBefore),
    I_every_dispatch_answered_by_Z: o.calls.length >= o.tokenCalls.length,
    C_response_unchanged_after_R: JSON.stringify(o.headersAtR) === JSON.stringify(o.headersAtZ),
    Z_no_timer_left: o.timersAtZ === 0,
    Z_no_unhandled_rejection: o.unhandled === 0,
    no_throw: !o.threw,
  };
}
/** Concurrent runs: per-request seal times are not attributable under fake timers, so the layers are judged in aggregate. */
function layersMany(os: Obs[]): Record<string, boolean> {
  const lines = os[0].allLines;
  const tokens = os[0].tokenCalls;
  const lastR = Math.max(...os.map((o) => o.R ?? Infinity));
  const calls = os[0].calls;
  return {
    D_no_dispatch_after_the_last_R: tokens.filter((c) => c.t > lastR).length === 0,
    D_records_count_every_dispatch: lines.reduce((n, l) => n + (l.dispatches as number), 0) === tokens.length,
    I_every_invocation_dispatched_no_local_answer: calls.length === tokens.length && calls.every((c) => shapeOf(c, tokens) !== "L-N" && shapeOf(c, tokens) !== "L-R-or-503"),
    C_responses_unchanged_after_R: os.every((o) => JSON.stringify(o.headersAtR) === JSON.stringify(o.headersAtZ)),
    Z_no_timer_left: os[0].timersAtZ === 0,
    Z_no_unhandled_rejection: os[0].unhandled === 0,
    one_line_per_request: lines.length === os.length,
  };
}
const vacuity = (o: Obs) => (o.record === null && o.tokenCalls.length === 0 ? ["D", "I", "C"] : []);
function summary(o: Obs) {
  return {
    outcome: o.record?.outcome ?? (o.allLines.length > 1 ? o.allLines.map((l) => l.outcome) : null),
    record: o.record ? { ...o.record } : null,
    R: o.R === null ? null : o.R - o.t0,
    seal: o.seal === null ? null : o.seal - o.t0,
    dispatches: o.tokenCalls.length,
    late: o.seal === null ? 0 : o.calls.filter((c) => c.t > (o.seal as number)).length,
    setCookie: o.setCookies.map((c) => ({ name: c.name, maxAge: c.attrs["max-age"] ?? null, flags: Object.keys(c.attrs).sort() })),
    override: o.override,
    verifier: o.verifier?.status ?? null,
    created: o.created,
    timersAtZ: o.timersAtZ,
    unhandled: o.unhandled,
  };
}
function judge(name: string, checks: Record<string, boolean>, o: Obs | Obs[]) {
  const list = Array.isArray(o) ? o : [o];
  const failed = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const observed = { case: name, failed, checks: Object.keys(checks), vacuous: Array.from(new Set(list.flatMap(vacuity))), obs: list.map(summary) };
  expect(failed, `observed ${JSON.stringify(observed)}`).toEqual([]);
}

// SDK console output: only the reachable F21 sites, with the fixed content of DESIGN.md §5.2
function consoleText(arg: unknown): string {
  const parts = [typeof arg === "string" ? arg : inspect(arg, { depth: 8, showHidden: true, breakLength: Infinity })];
  if (arg && typeof arg === "object") {
    const e = arg as Record<string, unknown>;
    for (const k of ["message", "code", "status", "reasons", "originalError"]) parts.push(inspect(e[k], { depth: 4, showHidden: true }));
    if (typeof (e as { toJSON?: unknown }).toJSON === "function") parts.push(JSON.stringify((e as { toJSON: () => unknown }).toJSON()));
  }
  return parts.join("\n");
}
function sdkLines(o: Obs) {
  return o.console.filter((c) => !(c.m === "info" && typeof c.args[0] === "string" && (c.args[0] as string).startsWith("session-refresh ")));
}
function fixedSdkOutput(o: Obs): boolean {
  return sdkLines(o).every((c) => {
    if (c.args.length !== 1) return false;
    const e = c.args[0] as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return false;
    const name = e.name;
    if ("originalError" in e || "reasons" in e) return false;
    if (c.m === "warn") return name === "AuthSessionMissingError" && e.message === "Auth session missing!" && e.status === 400;
    if (c.m !== "error") return false;
    if (name === "AuthApiError")
      return [FIXED.reject, FIXED.fail, FIXED.local].includes(e.message as string) && typeof e.status === "number" && (e.code === undefined || ALLOWED.includes(e.code as string));
    if (name === "AuthRetryableFetchError") return e.message === "{}";
    if (name === "AuthRefreshDiscardedError") return true;
    return false;
  });
}
function leaks(o: Obs, extra: string[] = []): string[] {
  const needles = [MARK, ...extra, ...Array.from(sim.secrets), ...sim.families.map((f) => f.userId), "@example.invalid", ...FORGED_IDS];
  const hay = [...o.console.flatMap((c) => c.args.map(consoleText)), JSON.stringify(o.lines)].join("\n");
  return needles.filter((n) => n && hay.includes(n)).map((n) => (n.startsWith(MARK) ? "marker" : "secret"));
}

const FORGED_IDS = ["00000000-0000-4000-8000-00000000f0f0", "00000000-0000-4000-8000-0000000bad00"];
const familySetCookies = (o: Obs) => o.setCookies.filter((c) => isFamily(c.name));
const clears = (o: Obs) => familySetCookies(o).filter((c) => c.attrs["max-age"] === "0");
const writes = (o: Obs) => familySetCookies(o).filter((c) => c.attrs["max-age"] !== "0");
const policyAttrs = (c: SetCookie, secure: boolean) =>
  c.attrs["path"] === "/" &&
  (c.attrs["samesite"] ?? "").toLowerCase() === "lax" &&
  !("httponly" in c.attrs) &&
  !("domain" in c.attrs) &&
  ("secure" in c.attrs) === secure;

async function boundaryModule(): Promise<Record<string, unknown> | null> {
  if (!existsSync(path.join(ROOT, BOUNDARY))) return null;
  return (await import("@/utils/supabase/session-refresh" as string)) as Record<string, unknown>;
}

// ── lifecycle ───────────────────────────────────────────────────────────────
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 10, 15, 12, 0, 0) });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
  vi.stubGlobal("fetch", standInFetch);
  cap.dispatchCount = () => sim.tokenCalls.length;
  cap.throwOnCreate = false;
  cap.throwInCommit = false;
  sim.families = [];
  sim.parentRule = true;
  sim.reuseDetection = true;
  sim.conflict = false;
  downstream.cookie = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================================
// U1–U19: behaviour
// ============================================================================
describe("session refresh boundary: behaviour", () => {
  it("U1 fresh session: no Auth call, no client, no Set-Cookie, no override", async () => {
    const fam = newFamily();
    fam.accessExp = Date.now() + 3_600_000;
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { expiresAt: nowS() + 3600 }))) });
    judge("U1", { ...layers(o), no_auth_call: o.tokenCalls.length === 0, no_client: o.created === 0, no_set_cookie: o.setCookies.length === 0, no_override: !o.override, no_line: o.lines.length === 0, verifier_authenticated: o.verifier?.status === "authenticated" }, o);
  });

  for (const scheme of ["http", "https"] as const) {
    const id = scheme === "http" ? "U2" : "U2s";
    it(`${id} expired access, valid refresh, single cookie (${scheme}): one grant, policy cookie, verifier sees the new token and the stand-in's id`, async () => {
      const fam = newFamily();
      const r0 = fam.tokens[0];
      const o = await run({
        url: `${scheme}://127.0.0.1:3941/goals`,
        cookie: cookieOf(familyPairs(envelope(fam, { userId: "00000000-0000-4000-8000-00000000f0f0", email: "forged@example.invalid" }))),
      });
      const w = writes(o);
      const fwd = sessionIn(o.effective);
      judge(id, {
        ...layers(o),
        outcome_refreshed: o.record?.outcome === "refreshed",
        exactly_one_grant: o.tokenCalls.length === 1,
        grant_carried_the_cookie_refresh_token: o.tokenCalls[0]?.refreshToken === r0,
        set_cookie_is_the_bare_key: w.length === 1 && w[0].name === KEY && clears(o).length === 0,
        policy_attributes: w.length === 1 && policyAttrs(w[0], scheme === "https") && w[0].attrs["max-age"] === String(MAX_AGE),
        forwarded_access_is_the_granted_one: fwd?.access_token === fam.access,
        verifier_used_the_new_token: o.userCalls.length === 1 && o.userCalls[0].family === fam.id && o.userCalls[0].current,
        verifier_identity_is_the_stand_in_id: o.verifier?.status === "authenticated" && o.verifier.userId === fam.userId,
        sdk_output_fixed: fixedSdkOutput(o),
        no_leak: leaks(o).length === 0,
      }, o);
    });
  }

  const layoutsU3: [string, number, "bare" | "chunked", number][] = [
    ["bare to chunked", 0, "bare", 4000],
    ["3 chunks to 2", 7000, "chunked", 4000],
    ["chunked to bare", 4000, "chunked", 0],
  ];
  for (const [label, cookiePad, layout, newPad] of layoutsU3) {
    it(`U3 chunk transition ${label}: writes exactly W, expires every other family name, forwards only W`, async () => {
      const fam = newFamily({ padding: newPad });
      const pairs = familyPairs(envelope(fam, { pad: cookiePad }), layout);
      const extra = ["sb-127-auth-token-user=%7B%22u%22%3A1%7D", "theme=dark"];
      const o = await run({ cookie: cookieOf(pairs, extra) });
      const w = writes(o);
      const wMap = new Map(w.map((c) => [c.name, c.value]));
      const joined = joinFamily(wMap);
      const expected = joined ? ssrCreateChunks(KEY, joined) : [];
      const requestNames = pairs.map((p) => p.split("=")[0]);
      const fwdFamily = Array.from(parseCookie(o.effective ?? "").keys()).filter(isFamily).sort();
      judge("U3", {
        ...layers(o),
        outcome_refreshed: o.record?.outcome === "refreshed",
        precondition_layout: label !== "3 chunks to 2" || pairs.length === 3,
        w_equals_createChunks: expected.length === w.length && expected.every((c) => wMap.get(c.name) === c.value),
        w_shape: label === "chunked to bare" ? w.length === 1 && w[0].name === KEY : w.length >= 2,
        every_other_family_name_expired: requestNames.filter((n) => !wMap.has(n)).every((n) => clears(o).some((c) => c.name === n)) && clears(o).every((c) => requestNames.includes(c.name)),
        forwarded_holds_only_w: JSON.stringify(fwdFamily) === JSON.stringify(Array.from(wMap.keys()).sort()),
        user_cookie_untouched: !o.setCookies.some((c) => c.name === "sb-127-auth-token-user") && (o.effective ?? "").includes("sb-127-auth-token-user=%7B%22u%22%3A1%7D"),
        policy_attributes: w.every((c) => policyAttrs(c, false) && c.attrs["max-age"] === String(MAX_AGE)),
        verifier_authenticated: o.verifier?.status === "authenticated" && o.verifier.userId === fam.userId,
      }, o);
    });
  }

  for (const status of [400, 401, 403]) {
    for (const code of ALLOWED) {
      it(`U4 rejected ${status} ${code}: every family name expired, none forwarded, code-verifier untouched, verifier absent`, async () => {
        const fam = newFamily();
        const pairs = familyPairs(envelope(fam, { pad: 4000 }), "chunked");
        const verifier = "sb-127-auth-token-code-verifier=cv-synthetic";
        const o = await run({
          cookie: cookieOf(pairs, verifier),
          script: [{ kind: "raw", status, body: JSON.stringify({ code, message: "rejected" }), headers: { ...JSON_H, ...V } }],
        });
        const names = pairs.map((p) => p.split("=")[0]);
        judge("U4", {
          ...layers(o),
          outcome_rejected: o.record?.outcome === "rejected",
          exactly_one_dispatch: o.tokenCalls.length === 1,
          every_family_name_expired: names.every((n) => clears(o).some((c) => c.name === n)) && writes(o).length === 0,
          clear_attributes: clears(o).every((c) => policyAttrs(c, false)),
          no_family_forwarded: o.override && !Array.from(parseCookie(o.effective ?? "").keys()).some(isFamily),
          code_verifier_untouched: !o.setCookies.some((c) => c.name.endsWith("-code-verifier")) && (o.effective ?? "").includes(verifier),
          record_code_class: o.record?.code_class === code && o.record?.status === status,
          verifier_absent: o.verifier?.status === "absent",
          sdk_output_fixed: fixedSdkOutput(o),
        }, o);
      });
    }
  }

  const notRejected: [string, Mode, string][] = [
    ["401 Invalid API key without a code", { kind: "raw", status: 401, body: JSON.stringify({ message: "Invalid API key" }), headers: JSON_H }, "none"],
    ["404 HTML", { kind: "raw", status: 404, body: "<html><body>Not Found</body></html>", headers: HTML_H }, "none"],
    ["404 JSON without a code", { kind: "raw", status: 404, body: JSON.stringify({ message: "not found" }), headers: { ...JSON_H, ...V } }, "none"],
    ["403 HTML", { kind: "raw", status: 403, body: "<html><body>Forbidden</body></html>", headers: HTML_H }, "none"],
    ["400 without a code", { kind: "raw", status: 400, body: JSON.stringify({ msg: "bad request" }), headers: { ...JSON_H, ...V } }, "none"],
    ["422 unknown code", { kind: "raw", status: 422, body: JSON.stringify({ code: "validation_failed", msg: "unprocessable" }), headers: { ...JSON_H, ...V } }, "other"],
    ["409 conflict", { kind: "raw", status: 409, body: JSON.stringify({ code: "conflict", msg: "conflict" }), headers: { ...JSON_H, ...V } }, "other"],
    ["200 {}", { kind: "raw", status: 200, body: "{}", headers: JSON_H }, "malformed_2xx"],
    ["200 without expires_in", { kind: "raw", status: 200, body: JSON.stringify({ access_token: "a", refresh_token: "b", token_type: "bearer" }), headers: JSON_H }, "malformed_2xx"],
    ["200 null", { kind: "raw", status: 200, body: "null", headers: JSON_H }, "malformed_2xx"],
  ];
  for (const [label, mode, expectClass] of notRejected) {
    it(`U4n not rejected: ${label}`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), fallback: mode });
      const lbr = (o.record?.local_by_reason ?? {}) as Record<string, number>;
      judge("U4n", {
        ...layers(o),
        outcome_unavailable_line: o.record?.outcome === "unavailable",
        dispatches_ge_1: o.tokenCalls.length >= 1 && (o.record?.dispatches as number) >= 1,
        expected_class_recorded: expectClass === "malformed_2xx" ? (lbr.malformed_2xx ?? 0) >= 1 : o.record?.code_class === expectClass,
        no_set_cookie: o.setCookies.length === 0,
        no_override: !o.override,
        sdk_output_fixed: fixedSdkOutput(o),
      }, o);
    });
  }

  const unavailable: [string, Mode[], Mode][] = [
    ["a fetch throw", [], { kind: "drop" }],
    ["a hang beyond T_a", [], { kind: "hang" }],
    ["502", [], { kind: "raw", status: 502, body: "bad gateway", headers: HTML_H }],
    ["503", [], { kind: "raw", status: 503, body: JSON.stringify({ message: "unavailable" }), headers: JSON_H }],
    ["500", [], { kind: "raw", status: 500, body: JSON.stringify({ code: "unexpected_failure", msg: "degraded" }), headers: { ...JSON_H, ...V } }],
    ["429", [], { kind: "raw", status: 429, body: JSON.stringify({ code: "over_request_rate_limit", msg: "slow down" }), headers: { ...JSON_H, ...V } }],
    ["200 HTML", [], { kind: "raw", status: 200, body: "<html>ok</html>", headers: HTML_H }],
    ["400 HTML", [], { kind: "raw", status: 400, body: "<html>bad</html>", headers: HTML_H }],
    ["403 HTML", [], { kind: "raw", status: 403, body: "<html>no</html>", headers: HTML_H }],
    ["404 HTML", [], { kind: "raw", status: 404, body: "<html>none</html>", headers: HTML_H }],
    ["500 HTML", [], { kind: "raw", status: 500, body: "<html>err</html>", headers: HTML_H }],
  ];
  for (const [label, script, fallback] of unavailable) {
    it(`U5 unavailable: ${label}`, async () => {
      const fam = newFamily();
      const pairs = familyPairs(envelope(fam));
      const o = await run({ cookie: cookieOf(pairs), script, fallback });
      const sdkErrors = sdkLines(o).map((c) => c.args[0] as Record<string, unknown>);
      judge("U5", {
        ...layers(o),
        outcome_unavailable_line: o.record?.outcome === "unavailable",
        dispatches_ge_1: o.tokenCalls.length >= 1,
        dispatches_le_K: o.tokenCalls.length <= K,
        returned_by_deadline: o.R !== null && o.R - o.t0 <= T_B + 50,
        no_set_cookie: o.setCookies.length === 0,
        no_override: !o.override,
        sdk_output_fixed: fixedSdkOutput(o),
        sdk_errors_hold_no_raw_content: sdkErrors.every((e) => !("originalError" in e) && !("reasons" in e) && (e.code === undefined || ALLOWED.includes(e.code as string))),
        never_unknown_error: sdkErrors.every((e) => e.name !== "AuthUnknownError"),
      }, o);
    });
  }

  it("U6(a) forged user fields with a valid refresh: identity is the stand-in's only", async () => {
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { userId: "00000000-0000-4000-8000-0000000bad00", email: "attacker@example.invalid" }))) });
    judge("U6(a)", { ...layers(o), outcome_refreshed: o.record?.outcome === "refreshed", identity_from_stand_in: o.verifier?.status === "authenticated" && o.verifier.userId === fam.userId }, o);
  });
  it("U6(b) far-future expires_at on an expired access token: fresh, no grant, verifier invalid", async () => {
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { expiresAt: nowS() + 86_400 * 365 }))) });
    judge("U6(b)", { ...layers(o), no_grant: o.tokenCalls.length === 0, no_client: o.created === 0, no_line: o.lines.length === 0, no_write: o.setCookies.length === 0, verifier_invalid: o.verifier?.status === "invalid" }, o);
  });
  it("U6(c) forged refresh token answered refresh_token_not_found: rejected", async () => {
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { refresh: "rt-forged-not-issued" }))) });
    judge("U6(c)", { ...layers(o), outcome_rejected: o.record?.outcome === "rejected", cleared: clears(o).length === 1, verifier_absent: o.verifier?.status === "absent" }, o);
  });
  it("U6(d) test-auth alone: skip_absent, no call", async () => {
    const o = await run({ cookie: "test-auth=works" });
    judge("U6(d)", { ...layers(o), no_grant: o.tokenCalls.length === 0, no_client: o.created === 0, no_line: o.lines.length === 0, no_write: o.setCookies.length === 0, no_override: !o.override, verifier_absent: o.verifier?.status === "absent" }, o);
  });
  it("U6(e) edited user_metadata and app_metadata with markers: refreshed; no marker in identity, log or committed cookie", async () => {
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { userMeta: { role: `${MARK}-um` }, appMeta: { role: "admin", tier: `${MARK}-am` } }))) });
    const committed = writes(o).map((c) => c.value).join("");
    judge("U6(e)", {
      ...layers(o),
      outcome_refreshed: o.record?.outcome === "refreshed",
      identity_from_stand_in: o.verifier?.status === "authenticated" && o.verifier.userId === fam.userId,
      no_marker_in_log_or_console: leaks(o).filter((k) => k === "marker").length === 0,
      committed_cookie_is_the_stand_in_answer: committed.length > 0 && !committed.includes(MARK) && sessionIn(o.effective)?.refresh_token === fam.tokens[fam.tokens.length - 1],
    }, o);
  });

  for (const [label, value] of [["valid Bearer", "Bearer synthetic-bearer-token"], ["garbage", "garbage"], ["empty", ""]] as const) {
    it(`U7 Authorization present (${label}) with an expired cookie: no Auth call, untouched`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), headers: { authorization: value } });
      judge("U7", { ...layers(o), no_grant: o.tokenCalls.length === 0, no_client: o.created === 0, no_write: o.setCookies.length === 0, no_override: !o.override, no_line: o.lines.length === 0 }, o);
    });
  }

  it("U8 parallel: 5 concurrent calls with the same R0 against the parent rule: one grant each, every committed token is the active one", async () => {
    const fam = newFamily();
    const cookie = cookieOf(familyPairs(envelope(fam)));
    const os = await runAll(Array.from({ length: 5 }, () => ({ cookie })));
    const active = fam.tokens[fam.tokens.length - 1];
    const committed = os.map((o) => sessionIn(o.effective)?.refresh_token);
    judge("U8", {
      ...layersMany(os),
      every_call_refreshed: os[0].allLines.length === 5 && os[0].allLines.every((l) => l.outcome === "refreshed") && os.every((o) => writes(o).length === 1),
      exactly_one_grant_per_call: os[0].tokenCalls.length === 5 && os[0].allLines.every((l) => l.dispatches === 1),
      every_committed_token_is_active: committed.every((t) => t === active),
      family_alive: fam.alive,
    }, os);
  });
  it("U8 grandparent: a token two rotations old is rejected", async () => {
    const fam = newFamily();
    const r0 = fam.tokens[0];
    fam.tokens.push(tok("rt"), tok("rt"));
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam, { refresh: r0 }))) });
    judge("U8-grandparent", { ...layers(o), outcome_rejected: o.record?.outcome === "rejected", cleared: clears(o).length === 1, record_code: o.record?.code_class === "refresh_token_already_used" }, o);
  });
  it("U8 conflict: concurrent grants answered 409 conflict are unavailable with no clearing", async () => {
    sim.conflict = true;
    const fam = newFamily();
    const cookie = cookieOf(familyPairs(envelope(fam)));
    const os = await runAll(Array.from({ length: 3 }, () => ({ cookie })));
    const lines = os[0].allLines;
    const outcomes = lines.map((l) => l.outcome);
    judge("U8-conflict", {
      ...layersMany(os),
      one_refreshed_others_unavailable: outcomes.filter((x) => x === "refreshed").length === 1 && outcomes.filter((x) => x === "unavailable").length === 2,
      one_grant_each: os[0].tokenCalls.length === 3 && lines.every((l) => l.dispatches === 1),
      no_clearing: os.every((o) => clears(o).length === 0),
      conflict_is_other: lines.filter((l) => l.outcome === "unavailable").every((l) => l.code_class === "other" && l.status === 409),
    }, os);
  });

  const malformed: [string, () => string][] = [
    ["non-JSON", () => cookieOf(`${KEY}=not-json-at-all`)],
    ["a chunk gap", () => cookieOf(`${KEY}.0=%7B%22access_token%22%3A`, `${KEY}.2=%22x%22%7D`)],
    ["JSON without refresh_token", () => cookieOf(`${KEY}=${encodeURIComponent(JSON.stringify({ access_token: "a", expires_at: nowS() - 30 }))}`)],
    ['refresh_token ""', () => cookieOf(`${KEY}=${encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: "", expires_at: nowS() - 30 }))}`)],
    ["refresh_token null", () => cookieOf(`${KEY}=${encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: null, expires_at: nowS() - 30 }))}`)],
    ["expires_at not numeric", () => cookieOf(`${KEY}=${encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: "b", expires_at: "soon" }))}`)],
    ["expires_at 0", () => cookieOf(`${KEY}=${encodeURIComponent(JSON.stringify({ access_token: "a", refresh_token: "b", expires_at: 0 }))}`)],
  ];
  for (const [label, cookie] of malformed) {
    it(`U9 malformed: ${label}: unusable, no client, no Auth call, no write, terminates`, async () => {
      const o = await run({ cookie: cookie() });
      judge("U9", { ...layers(o), no_client: o.created === 0, no_grant: o.tokenCalls.length === 0, no_write: o.setCookies.length === 0, no_override: !o.override, no_line: o.lines.length === 0, returned: o.R !== null }, o);
    });
  }

  it("U10 boundary exception (client construction throws): plain next(), no Set-Cookie, outcome=error, nothing thrown", async () => {
    cap.throwOnCreate = true;
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))) });
    judge("U10", { ...layers(o), outcome_error: o.record?.outcome === "error", sealed_in_the_finally: typeof o.record?.ms_to_seal === "number", no_set_cookie: o.setCookies.length === 0, no_override: !o.override, nothing_thrown: !o.threw }, o);
  });
  it("U10b exception in the commit path after the first dispatch: error, plain next(), sealed, no dispatch after R", async () => {
    cap.throwInCommit = true;
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))) });
    judge("U10b", {
      ...layers(o),
      outcome_error: o.record?.outcome === "error",
      dispatched_first: o.tokenCalls.length === 1,
      no_set_cookie: o.setCookies.length === 0,
      no_override: !o.override,
      sealed_before_R: o.seal !== null && o.R !== null && o.seal <= o.R,
    }, o);
  });

  it("U11 Server Action-shaped request: refreshed and forwarded; the body is never read", async () => {
    const fam = newFamily();
    const o = await run({
      method: "POST",
      cookie: cookieOf(familyPairs(envelope(fam))),
      headers: { "next-action": "0123456789abcdef0123456789abcdef01234567", "content-type": "application/x-www-form-urlencoded", origin: APP },
      body: "1_goal=Break+85",
    });
    judge("U11", {
      ...layers(o),
      outcome_refreshed: o.record?.outcome === "refreshed" && o.record?.kind === "action",
      forwarded: sessionIn(o.effective)?.access_token === fam.access,
      body_not_read: o.bodyUsed === false,
      verifier_authenticated: o.verifier?.status === "authenticated",
    }, o);
  });

  for (const [variant, mode] of [
    ["400 allow-listed rejection", { kind: "raw", status: 400, body: JSON.stringify({ code: "session_expired", msg: "x" }), headers: { ...JSON_H, ...V } }],
    ["429", { kind: "raw", status: 429, body: JSON.stringify({ code: "over_request_rate_limit", msg: "x" }), headers: { ...JSON_H, ...V } }],
  ] as [string, Mode][]) {
    it(`U12 removal re-entry (${variant}): bare cookie plus stale valid older-session chunks; exactly one dispatch`, async () => {
      const current = newFamily();
      const older = newFamily();
      const stale = familyPairs(envelope(older, { pad: 4000 }), "chunked");
      const o = await run({ cookie: cookieOf(familyPairs(envelope(current)), stale), script: [mode] });
      const late = o.seal === null ? [] : o.calls.filter((c) => c.t > (o.seal as number));
      const isRejection = variant.startsWith("400");
      judge(isRejection ? "U12-400" : "U12-429", {
        ...layers(o),
        exactly_one_dispatch: o.tokenCalls.length === 1 && o.record?.dispatches === 1,
        no_late_call: late.length === 0,
        outcome: isRejection ? o.record?.outcome === "rejected" : o.record?.outcome === "unavailable",
        clearing: isRejection ? clears(o).length === 3 : o.setCookies.length === 0,
      }, o);
    });
  }

  it("U13(a) E2: dispatch 2 hangs with no per-dispatch timer; the deadline seals and answers locally", async () => {
    const fam = newFamily();
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), script: [{ kind: "hang" }, { kind: "hang" }] });
    const lbr = (o.record?.local_by_reason ?? {}) as Record<string, number>;
    const late = o.seal === null ? [] : o.calls.filter((c) => c.t > (o.seal as number));
    judge("U13(a)", {
      ...layers(o),
      R_at_deadline: o.R !== null && Math.abs(o.R - o.t0 - T_B) <= 20,
      dispatches_2: o.tokenCalls.length === 2,
      second_dispatch_at_3200: o.tokenCalls.length === 2 && Math.abs(o.tokenCalls[1].t - o.t0 - 3200) <= 20,
      no_per_dispatch_timer_for_dispatch_2: o.tokenCalls[1]?.timers === 1,
      second_dispatch_aborted_by_deadline_only: o.tokenCalls[1]?.aborted !== null && Math.abs((o.tokenCalls[1]?.aborted ?? 0) - o.t0 - T_B) <= 20,
      deadline_in_record: lbr.deadline === 1 && lbr.timeout_retryable === 1,
      no_late_call: late.length === 0,
      outcome_unavailable_unknown: o.record?.outcome === "unavailable" && o.record?.remote === "unknown",
      sdk_output_fixed: fixedSdkOutput(o),
    }, o);
  });
  it("U13(b) E3: the deadline falls inside the 400 ms sleep after dispatch 2's real 503; exactly one late local call", async () => {
    const fam = newFamily();
    const r503 = (delay: number): Mode => ({ kind: "raw", status: 503, body: "x", headers: HTML_H, delay });
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), script: [r503(1500), r503(2950)] });
    const seal = o.seal ?? 0;
    const late = o.calls.filter((c) => c.t > seal);
    judge("U13(b)", {
      ...layers(o),
      R_at_deadline: o.R !== null && Math.abs(o.R - o.t0 - T_B) <= 20,
      dispatches_2: o.tokenCalls.length === 2 && o.record?.dispatches === 2,
      exactly_one_late_call: late.length === 1,
      late_call_within_400ms_of_seal_and_after_R: late.length === 1 && late[0].t - seal <= 400 && o.R !== null && late[0].t >= o.R,
      late_call_local_final_no_dispatch: late.length === 1 && shapeOf(late[0], o.tokenCalls) === "L-N" && late[0].dispatchesAfter === late[0].dispatchesBefore,
      outcome_unavailable_known: o.record?.outcome === "unavailable" && o.record?.remote === "known",
      late_console_line_fixed: fixedSdkOutput(o) && sdkLines(o).some((c) => c.t > seal),
    }, o);
  });
  it("U13(c) E6: a body still being read at T_b is aborted at the deadline", async () => {
    const fam = newFamily();
    const o = await run({
      cookie: cookieOf(familyPairs(envelope(fam))),
      script: [{ kind: "hang" }, { kind: "raw", status: 200, headers: JSON_H, bodyHang: true, delay: 1790 }],
    });
    const lbr = (o.record?.local_by_reason ?? {}) as Record<string, number>;
    const late = o.seal === null ? [] : o.calls.filter((c) => c.t > (o.seal as number));
    judge("U13(c)", {
      ...layers(o),
      R_at_deadline: o.R !== null && Math.abs(o.R - o.t0 - T_B) <= 20,
      dispatches_2: o.tokenCalls.length === 2,
      deadline_in_record: lbr.deadline === 1,
      no_late_call: late.length === 0,
      outcome_unavailable_unknown: o.record?.outcome === "unavailable" && o.record?.remote === "unknown",
      sdk_output_fixed: fixedSdkOutput(o),
    }, o);
  });
  it("U13(d) tie: a per-dispatch budget that would end exactly at T_b arms no timer; only the deadline aborts", async () => {
    const fam = newFamily();
    const o = await run({
      cookie: cookieOf(familyPairs(envelope(fam))),
      script: [{ kind: "raw", status: 503, body: "x", headers: HTML_H, delay: 1800 }, { kind: "hang" }],
    });
    const lbr = (o.record?.local_by_reason ?? {}) as Record<string, number>;
    const late = o.seal === null ? [] : o.calls.filter((c) => c.t > (o.seal as number));
    judge("U13(d)", {
      ...layers(o),
      R_at_deadline: o.R !== null && Math.abs(o.R - o.t0 - T_B) <= 20,
      dispatches_2: o.tokenCalls.length === 2,
      second_dispatch_at_2000: o.tokenCalls.length === 2 && Math.abs(o.tokenCalls[1].t - o.t0 - 2000) <= 20,
      no_per_dispatch_timer_at_the_tie: o.tokenCalls[1]?.timers === 1,
      sdk_output_fixed: fixedSdkOutput(o),
      single_abort_at_deadline: Math.abs((o.tokenCalls[1]?.aborted ?? 0) - o.t0 - T_B) <= 20,
      deadline_in_record: lbr.deadline === 1 && !lbr.timeout_retryable,
      no_late_call: late.length === 0,
      outcome_unavailable_unknown: o.record?.outcome === "unavailable" && o.record?.remote === "unknown",
    }, o);
  });

  it("U14 logging: one redacted boundary line per logged outcome, none otherwise; SDK output fixed; no secret or marker anywhere through settlement", async () => {
    const all: Obs[] = [];
    const lineCounts: Record<string, number> = {};
    const scenario = async (label: string, spec: () => RunSpec, expectLine: boolean) => {
      const o = await run(spec());
      all.push(o);
      lineCounts[label] = o.lines.length;
      return expectLine ? o.lines.length === 1 : o.lines.length === 0;
    };
    const m = (s: string) => `${MARK}-${s}`;
    const markerBody = JSON.stringify({ msg: m("msg"), message: m("message"), error_description: m("ed"), error: m("error"), details: m("details"), hint: m("hint"), code: m("code"), error_code: m("ec"), weak_password: { reasons: [m("reason")] } });
    const results = [
      await scenario("refreshed", () => ({ cookie: cookieOf(familyPairs(envelope(newFamily(), { userMeta: { x: m("um") } }))) }), true),
      await scenario("rejected", () => ({ cookie: cookieOf(familyPairs(envelope(newFamily()))), fallback: { kind: "raw", status: 400, body: JSON.stringify({ code: "refresh_token_not_found", msg: m("rej") }), headers: { ...JSON_H, ...V } } }), true),
      await scenario("unavailable-markers", () => ({ cookie: cookieOf(familyPairs(envelope(newFamily()))), fallback: { kind: "raw", status: 403, body: markerBody, headers: { ...JSON_H, ...V } } }), true),
      await scenario("unavailable-deadline", () => ({ cookie: cookieOf(familyPairs(envelope(newFamily()))), fallback: { kind: "hang" } }), true),
      await scenario("error", () => {
        cap.throwOnCreate = true;
        return { cookie: cookieOf(familyPairs(envelope(newFamily()))) };
      }, true),
      await scenario("skip_bearer", () => {
        cap.throwOnCreate = false;
        return { cookie: cookieOf(familyPairs(envelope(newFamily()))), headers: { authorization: "Bearer x" } };
      }, false),
      await scenario("skip_absent", () => ({ cookie: "theme=dark" }), false),
      await scenario("fresh", () => ({ cookie: cookieOf(familyPairs(envelope(newFamily(), { expiresAt: nowS() + 3600 }))) }), false),
      await scenario("unusable", () => ({ cookie: `${KEY}=not-json` }), false),
    ];
    const lineKeys = all.flatMap((o) => o.lines.map((l) => Object.keys(l).sort().join(",")));
    judge("U14", {
      line_per_logged_outcome_and_none_otherwise: results.every(Boolean),
      line_schema_fixed: lineKeys.every((k) => k === "code_class,committed,dispatches,invocations_before_seal,kind,local_by_reason,ms_to_seal,ms_total,outcome,remote,status"),
      sdk_output_only_fixed_sites: all.every(fixedSdkOutput),
      fetch_js_console_error_never_fires: all.every((o) => sdkLines(o).every((c) => (c.args[0] as { name?: string })?.name?.startsWith("Auth"))),
      no_secret_or_marker: all.every((o) => leaks(o).length === 0),
      settled: all.every((o) => o.timersAtZ === 0 && o.unhandled === 0),
      every_run_holds_its_layers: all.every((o) => Object.values(layers(o)).every(Boolean)),
    }, all);
  });

  it("U16 cross-tenant: 10 interleaved concurrent calls for 5 users each forward and set only their own tokens", async () => {
    const fams = Array.from({ length: 5 }, () => newFamily());
    const specs = Array.from({ length: 10 }, (_, i) => ({ cookie: cookieOf(familyPairs(envelope(fams[i % 5]))) }));
    const os = await runAll(specs);
    const own = os.map((o, i) => {
      const fam = fams[i % 5];
      const fwd = sessionIn(o.effective);
      const set = sessionIn(writes(o).map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; "));
      return fwd?.refresh_token === fam.tokens[fam.tokens.length - 1] && set?.access_token === fam.access && o.verifier?.userId === fam.userId;
    });
    judge("U16", {
      ...layersMany(os),
      every_call_refreshed: os[0].allLines.length === 10 && os[0].allLines.every((l) => l.outcome === "refreshed"),
      each_holds_only_its_own_tokens: own.every(Boolean),
    }, os);
  });

  it("U17 header injection: no top-level rewrite, location, set-cookie or authorization override; only x-middleware-request-* copies and family Set-Cookie", async () => {
    const fam = newFamily();
    const injected = {
      "x-middleware-rewrite": "http://127.0.0.2/x",
      location: "http://127.0.0.2/y",
      "x-middleware-override-headers": "authorization",
      "x-middleware-request-authorization": "Bearer injected-synthetic",
      "x-middleware-set-cookie": "injected=1",
    };
    const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), headers: injected });
    const names = o.headersAtR.map(([k]) => k);
    const requestNames = new Set([...Object.keys(injected), "cookie"]);
    const allowed = (n: string) => n === "set-cookie" || n === "x-middleware-next" || n === "x-middleware-override-headers" || (n.startsWith("x-middleware-request-") && requestNames.has(n.slice("x-middleware-request-".length)));
    const overrideList = (o.response?.headers.get("x-middleware-override-headers") ?? "").split(",").map((s) => s.trim());
    judge("U17", {
      ...layers(o),
      refreshed: o.record?.outcome === "refreshed",
      no_top_level_rewrite_location_or_set_cookie_header: !names.includes("x-middleware-rewrite") && !names.includes("location") && !names.includes("x-middleware-set-cookie"),
      no_authorization_override: !names.includes("x-middleware-request-authorization") && !overrideList.includes("authorization"),
      request_copies_present: names.some((n) => n.startsWith("x-middleware-request-")),
      only_expected_headers: names.every(allowed),
      only_family_set_cookie: o.setCookies.every((c) => isFamily(c.name)),
    }, o);
  });

  const nonFamily = ["bad=%E0%A4%A", "theme=dark", "a=1"];
  for (const variant of ["refreshed", "rejected"] as const) {
    const mode: Mode | undefined = variant === "rejected" ? { kind: "raw", status: 401, body: JSON.stringify({ code: "session_expired", msg: "x" }), headers: { ...JSON_H, ...V } } : undefined;
    it(`U18(a) non-family cookies are byte-identical in the effective downstream header (${variant})`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(nonFamily[0], familyPairs(envelope(fam)), nonFamily.slice(1)), script: mode ? [mode] : [] });
      const pairs = (o.effective ?? "").split(/; */).filter((p) => !isFamily(p.split("=")[0]));
      judge("U18(a)", { non_family_pairs_byte_identical: JSON.stringify(pairs) === JSON.stringify(nonFamily) }, o);
    });
    it(`U18(b) outcome with non-family cookies present (${variant})`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(nonFamily[0], familyPairs(envelope(fam)), nonFamily.slice(1)), script: mode ? [mode] : [] });
      judge("U18(b)", { ...layers(o), outcome: o.record?.outcome === variant }, o);
    });
  }

  for (const [label, cookie] of [
    ["key twice", () => cookieOf(familyPairs(envelope(newFamily())), familyPairs(envelope(newFamily())))],
    ["key.0 with an invalid escape", () => cookieOf(`${KEY}.0=%E0%A4%A`, `${KEY}.1=x`)],
  ] as [string, () => string][]) {
    it(`U19(a) duplicate or undecodable family pair (${label}): unusable, no client, no write`, async () => {
      const o = await run({ cookie: cookie() });
      judge("U19(a)", { ...layers(o), no_client: o.created === 0, no_grant: o.tokenCalls.length === 0, no_write: o.setCookies.length === 0, no_override: !o.override, no_line: o.lines.length === 0 }, o);
    });
  }
  it("U19(b) parse edge cases next to a refresh-due session: refreshed, with Next's parseCookie pairs preserved", async () => {
    const fam = newFamily();
    const raw = `a=1;${familyPairs(envelope(fam))[0]};flag; b=2;;c=3`;
    const o = await run({ cookie: raw });
    const before = Array.from(parseCookie(raw).entries()).filter(([n]) => !isFamily(n));
    const after = Array.from(parseCookie(o.effective ?? "").entries()).filter(([n]) => !isFamily(n));
    judge("U19(b)", {
      ...layers(o),
      outcome_refreshed: o.record?.outcome === "refreshed",
      next_parse_pairs_preserved: JSON.stringify(before) === JSON.stringify(after),
      forwarded_family_is_new: sessionIn(o.effective)?.access_token === fam.access,
    }, o);
  });
});

// ============================================================================
// U20: response normalization (markers in every field)
// ============================================================================
const m = (field: string) => `${MARK}-${field}`;
const ALL_FIELDS = {
  msg: m("msg"),
  message: m("message"),
  error_description: m("error_description"),
  error: m("error"),
  details: m("details"),
  hint: m("hint"),
  code: m("code"),
  error_code: m("error_code"),
  weak_password: { reasons: [m("reason")] },
};
const OBJECT_ERROR = { ...ALL_FIELDS, error: { message: m("error_object") } };
type BodyKind = "json" | "json-object-error" | "html" | "short";
type VersionKind = "v" | "nov" | "badv";
interface Row {
  id: string;
  status: number;
  body: BodyKind;
  version: VersionKind;
}
const STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 200];
const ROWS: Row[] = STATUSES.flatMap((status) =>
  (["v", "nov", "badv"] as VersionKind[]).flatMap((version) =>
    (["json", "html", "short"] as BodyKind[]).map((body) => ({ id: `${status}-${body}-${version}`, status, body, version })),
  ),
).concat([{ id: "400-json-object-error-nov", status: 400, body: "json-object-error", version: "nov" }]);
function rowMode(row: Row): Mode {
  const headers: Record<string, string> = row.body.startsWith("json") ? { ...JSON_H } : { ...HTML_H };
  if (row.version === "v") headers["X-Supabase-Api-Version"] = "2024-01-01";
  if (row.version === "badv") headers["X-Supabase-Api-Version"] = m("version");
  const body =
    row.body === "json" ? JSON.stringify(ALL_FIELDS) : row.body === "json-object-error" ? JSON.stringify(OBJECT_ERROR) : row.body === "html" ? `${m("html")} <html><body>error page</body></html>` : m("short");
  return { kind: "raw", status: row.status, body, headers };
}
/** rows whose wrapper answer a mutant changes (DESIGN.md §5.2 / draft U20-NC) */
const rowIs = {
  network: (r: Row) => NETWORK.includes(r.status),
  twoxx: (r: Row) => r.status === 200,
  json: (r: Row) => r.body.startsWith("json"),
  unparseableNonOk: (r: Row) => r.status !== 200 && !NETWORK.includes(r.status) && !r.body.startsWith("json"),
  unknownCode: (r: Row) => r.status !== 200 && !NETWORK.includes(r.status) && r.body.startsWith("json"),
};

describe("U20 normalization rows", () => {
  const obs = new Map<string, Obs>();
  beforeAll(async () => {
    for (const row of ROWS) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 10, 15, 12, 0, 0) });
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
      vi.stubGlobal("fetch", standInFetch);
      cap.dispatchCount = () => sim.tokenCalls.length;
      cap.throwOnCreate = false;
      cap.throwInCommit = false;
      const fam = newFamily();
      obs.set(row.id, await run({ cookie: cookieOf(familyPairs(envelope(fam))), fallback: rowMode(row) }));
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }, 600_000);
  for (const row of ROWS) {
    it(`U20(a) row ${row.id}: no marker in any console argument, the boundary record or any SDK error property; no unknown or weak-password error`, () => {
      const o = obs.get(row.id) as Obs;
      const errs = sdkLines(o).map((c) => c.args[0] as Record<string, unknown>).filter((e) => e && typeof e === "object");
      judge(`U20(a) ${row.id}`, {
        no_marker: leaks(o).filter((k) => k === "marker").length === 0,
        structural_no_unknown_or_weak_password_error: errs.every((e) => e.name !== "AuthUnknownError" && e.name !== "AuthWeakPasswordError" && !("originalError" in e) && !("reasons" in e)),
      }, o);
    });
    it(`U20(f) row ${row.id}: every Response the SDK received is byte-built with no headers and is a session pass-through or a fixed rewrite`, () => {
      const o = obs.get(row.id) as Obs;
      const shapes = o.calls.map((c) => shapeOf(c, o.tokenCalls));
      judge(`U20(f) ${row.id}`, { only_allowed_shapes: shapes.every((s) => s !== "OTHER" && s !== "HAS_HEADERS"), every_dispatch_answered: o.calls.length >= o.tokenCalls.length }, o);
    });
    it(`U20(z) row ${row.id}: the per-layer checks hold through settlement, and the row was exercised (a dispatch and exactly one SDK line)`, () => {
      const o = obs.get(row.id) as Obs;
      judge(`U20(z) ${row.id}`, { ...layers(o), row_exercised: o.tokenCalls.length >= 1 && sdkLines(o).length === 1 }, o);
    });
    if (row.status !== 200) {
      it(`U20(d) row ${row.id}: unknown or gateway answer is unavailable, no clearing, class other or none`, () => {
        const o = obs.get(row.id) as Obs;
        const expected = row.body.startsWith("json") && row.version !== "badv" ? "other" : row.body.startsWith("json") ? "other" : "none";
        judge(`U20(d) ${row.id}`, {
          ...layers(o),
          outcome_unavailable: o.record?.outcome === "unavailable",
          no_clearing: clears(o).length === 0,
          class_other_or_none: o.record?.code_class === (NETWORK.includes(row.status) ? "none" : expected),
          status_is_real: o.record?.status === row.status,
        }, o);
      });
    }
  }
});

describe("U20(b) allow-listed codes with markers everywhere else", () => {
  const cases = [400, 401, 403].flatMap((status) =>
    ALLOWED.flatMap((code) => [
      { id: `${status}-${code}-code-v`, status, code, via: "code" as const },
      { id: `${status}-${code}-error_code-nov`, status, code, via: "error_code" as const },
    ]),
  );
  const obs = new Map<string, Obs>();
  beforeAll(async () => {
    for (const c of cases) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 10, 15, 12, 0, 0) });
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON);
      vi.stubGlobal("fetch", standInFetch);
      cap.dispatchCount = () => sim.tokenCalls.length;
      const fam = newFamily();
      const body = c.via === "code" ? { ...ALL_FIELDS, code: c.code, error_code: m("error_code") } : { ...ALL_FIELDS, code: m("code"), error_code: c.code };
      const headers = c.via === "code" ? { ...JSON_H, ...V } : { ...JSON_H };
      obs.set(c.id, await run({ cookie: cookieOf(familyPairs(envelope(fam))), fallback: { kind: "raw", status: c.status, body: JSON.stringify(body), headers } }));
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }, 600_000);
  for (const c of cases) {
    it(`U20(b1) ${c.id}: rejected, every family name expired, record class and status from the real answer`, () => {
      const o = obs.get(c.id) as Obs;
      judge(`U20(b1) ${c.id}`, {
        ...layers(o),
        outcome_rejected: o.record?.outcome === "rejected",
        cleared: clears(o).length === 1,
        record_class_is_the_code: o.record?.code_class === c.code,
        record_status_is_real: o.record?.status === c.status,
      }, o);
    });
    it(`U20(b2) ${c.id}: what the SDK shows (candidate only)`, () => {
      const o = obs.get(c.id) as Obs;
      const errs = sdkLines(o).map((x) => x.args[0] as Record<string, unknown>);
      const ok =
        c.code === "session_not_found"
          ? errs.length === 1 && errs[0].name === "AuthSessionMissingError" && errs[0].message === "Auth session missing!" && errs[0].code === undefined && errs[0].status === 400
          : errs.length === 1 && errs[0].name === "AuthApiError" && errs[0].message === FIXED.reject && errs[0].code === c.code && errs[0].status === c.status;
      judge(`U20(b2) ${c.id}`, { sdk_shows_fixed_rejection: ok, no_marker: leaks(o).filter((k) => k === "marker").length === 0 }, o);
    });
  }
});

describe("U20(c) the code rule is mirrored, not invented", () => {
  const oracleRows: { id: string; status: number; headers: Record<string, string>; body: Record<string, unknown>; expect?: string }[] = [
    { id: "allow-listed code without version or error_code", status: 400, headers: {}, body: { code: "refresh_token_not_found", msg: "x" }, expect: "none" },
    { id: "valid version + code conflict + allow-listed error_code", status: 400, headers: { ...V }, body: { code: "conflict", error_code: "session_expired", msg: "x" }, expect: "other" },
    { id: "valid version + empty code + allow-listed error_code", status: 400, headers: { ...V }, body: { code: "", error_code: "session_expired", msg: "x" }, expect: "none" },
    { id: "version 2023-12-31 + allow-listed code", status: 400, headers: { "X-Supabase-Api-Version": "2023-12-31" }, body: { code: "session_expired", msg: "x" }, expect: "none" },
    { id: "version 2024-02-31 + allow-listed code", status: 400, headers: { "X-Supabase-Api-Version": "2024-02-31" }, body: { code: "session_expired", msg: "x" } },
    { id: "numeric code + allow-listed error_code", status: 400, headers: { ...V }, body: { code: 400, error_code: "refresh_token_already_used", msg: "x" }, expect: "refresh_token_already_used" },
    { id: "session_not_found via code", status: 401, headers: { ...V }, body: { code: "session_not_found", msg: "x" }, expect: "session_not_found" },
    { id: "unknown error_code without version", status: 403, headers: {}, body: { error_code: "something_else", msg: "x" }, expect: "other" },
  ];
  const oracle = new Map<string, string>();
  beforeAll(async () => {
    // the unmodified SDK on the same raw response, outside every other observation (real timers; its own discarded spies)
    vi.useRealTimers();
    const { AuthClient } = await import("@supabase/auth-js");
    for (const row of oracleRows) {
      const spies = METHODS.map((mm) => vi.spyOn(console, mm).mockImplementation(() => undefined));
      const client = new AuthClient({
        url: `${SUPABASE_URL}/auth/v1`,
        headers: { apikey: ANON },
        persistSession: false,
        autoRefreshToken: false,
        fetch: (async () => new Response(JSON.stringify(row.body), { status: row.status, headers: { ...JSON_H, ...row.headers } })) as typeof fetch,
      });
      const { error } = await client.refreshSession({ refresh_token: "rt-oracle-only" });
      const e = error as { name?: string; code?: string } | null;
      oracle.set(row.id, !e ? "no-error" : e.name === "AuthSessionMissingError" ? "session_not_found" : e.code ? (ALLOWED.includes(e.code) ? e.code : "other") : "none");
      for (const s of spies) s.mockRestore();
    }
  });
  for (const row of oracleRows) {
    it(`U20(c) ${row.id}: the record's class equals the unmodified SDK's`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), fallback: { kind: "raw", status: row.status, body: JSON.stringify(row.body), headers: { ...JSON_H, ...row.headers } } });
      const sdk = oracle.get(row.id);
      const rejected = [400, 401, 403].includes(row.status) && ALLOWED.includes(sdk ?? "");
      judge(`U20(c) ${row.id}`, {
        ...layers(o),
        record_class_equals_sdk: o.record?.code_class === sdk,
        expected_where_stated: row.expect === undefined || sdk === row.expect,
        outcome_follows: o.record?.outcome === (rejected ? "rejected" : "unavailable"),
      }, o);
    });
  }
});

describe("U20(e) local answers never classify as a rejection", () => {
  const localCases: [string, Mode[], Record<string, number>][] = [
    ["two per-dispatch timeouts then the deadline", [{ kind: "hang" }, { kind: "hang" }], { timeout_retryable: 1, deadline: 1 }],
    ["a drop then a coded rejection delayed beyond T_a", [{ kind: "drop" }, { kind: "raw", status: 400, body: JSON.stringify({ code: "refresh_token_not_found" }), headers: { ...JSON_H, ...V }, delay: 6000 }], { timeout_retryable: 1, exhausted: 1 }],
    ["a coded rejection delayed beyond T_a, then a hang", [{ kind: "raw", status: 400, body: JSON.stringify({ code: "session_expired" }), headers: { ...JSON_H, ...V }, delay: 3500 }, { kind: "hang" }], { timeout_retryable: 1, deadline: 1 }],
  ];
  for (const [label, script, reasons] of localCases) {
    it(`U20(e) positive ${label}: unavailable, expected local reasons, class none, no clearing`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), script });
      const lbr = (o.record?.local_by_reason ?? {}) as Record<string, number>;
      judge("U20(e)+", {
        ...layers(o),
        outcome_unavailable: o.record?.outcome === "unavailable",
        expected_local_reasons: Object.entries(reasons).every(([k, v]) => lbr[k] === v),
        class_none: o.record?.code_class === "none",
        no_clearing: clears(o).length === 0,
      }, o);
    });
    it(`U20(e) negative ${label}: never rejected`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), script });
      judge("U20(e)-", { ...layers(o), never_rejected: o.record?.outcome !== "rejected" && clears(o).length === 0 }, o);
    });
  }
});

// ============================================================================
// U21: wrapper edge statuses and caps
// ============================================================================
describe("U21 wrapper edge statuses and caps", () => {
  const big = (n: number) => "s".repeat(n);
  const sessionOf = (pad: number) =>
    JSON.stringify({ access_token: tok("at"), token_type: "bearer", expires_in: 3600, expires_at: nowS() + 3600, refresh_token: tok("rt"), user: { id: crypto.randomUUID(), user_metadata: { pad: big(pad) } } });
  const edge: [string, () => Mode, (o: Obs) => Record<string, boolean>][] = [
    ["304", () => ({ kind: "raw", status: 304, headers: {} }), (o) => ({ unexpected_status: reasonOf(o, "unexpected_status") && o.record?.outcome === "unavailable" })],
    ["302 to another loopback port", () => ({ kind: "raw", status: 302, headers: { location: "http://127.0.0.1:54330/steal" } }), (o) => ({
      unexpected_status: reasonOf(o, "unexpected_status"),
      dispatch_used_manual_redirect: o.tokenCalls.every((c) => c.redirect === "manual"),
      no_second_request_to_location: sim.egress.length === 0,
    })],
    ["200 JSON object without a session", () => ({ kind: "raw", status: 200, body: JSON.stringify({ user: { id: "x" } }), headers: JSON_H }), (o) => ({ malformed: reasonOf(o, "malformed_2xx") })],
    ["200 []", () => ({ kind: "raw", status: 200, body: "[]", headers: JSON_H }), (o) => ({ malformed: reasonOf(o, "malformed_2xx") })],
    ["200 null", () => ({ kind: "raw", status: 200, body: "null", headers: JSON_H }), (o) => ({ malformed: reasonOf(o, "malformed_2xx"), no_type_error: o.unhandled === 0 })],
    ["empty 204", () => ({ kind: "raw", status: 204, headers: {} }), (o) => ({ unparseable_retry_then_final: ((o.record?.local_by_reason as Record<string, number>)?.unparseable_2xx ?? 0) === 2 && o.tokenCalls.length === 2 && o.calls[0] !== undefined && shapeOf(o.calls[0], o.tokenCalls) === "L-R-or-503" })],
    ["session just under the 2xx cap", () => ({ kind: "raw", status: 200, body: sessionOf(64 * 1024 - 600), headers: JSON_H, stream: true }), (o) => ({ refreshed: o.record?.outcome === "refreshed" })],
    ["session just over the 2xx cap", () => ({ kind: "raw", status: 200, body: sessionOf(64 * 1024 + 100), headers: JSON_H, stream: true }), (o) => ({ unparseable: reasonOf(o, "unparseable_2xx") && o.record?.outcome === "unavailable" })],
    ["session well over the 2xx cap (the read stops at the cap)", () => ({ kind: "raw", status: 200, body: sessionOf(96 * 1024), headers: JSON_H, stream: true }), (o) => ({ unparseable: reasonOf(o, "unparseable_2xx") && o.record?.outcome === "unavailable", stream_cancelled: o.tokenCalls.length === 2 && o.tokenCalls.every((c) => c.streamCancelled) })],
    ["non-OK body just over the non-OK cap", () => ({ kind: "raw", status: 400, body: JSON.stringify({ code: "refresh_token_not_found", pad: big(16 * 1024) }), headers: { ...JSON_H, ...V }, stream: true }), (o) => ({
      class_none: o.record?.code_class === "none" && o.record?.outcome === "unavailable" && clears(o).length === 0,
    })],
    ["non-OK body well over the non-OK cap (the read stops at the cap)", () => ({ kind: "raw", status: 400, body: JSON.stringify({ code: "refresh_token_not_found", pad: big(40 * 1024) }), headers: { ...JSON_H, ...V }, stream: true }), (o) => ({
      class_none: o.record?.code_class === "none" && o.record?.outcome === "unavailable" && clears(o).length === 0,
      stream_cancelled: o.tokenCalls[0]?.streamCancelled === true,
    })],
    ["non-OK coded body just under the non-OK cap", () => ({ kind: "raw", status: 400, body: JSON.stringify({ code: "refresh_token_not_found", pad: big(16 * 1024 - 80) }), headers: { ...JSON_H, ...V }, stream: true }), (o) => ({
      rejected: o.record?.code_class === "refresh_token_not_found" && o.record?.outcome === "rejected",
    })],
    ["a parser throw inside the wrapper", () => ({ kind: "raw", status: 200, body: "{\"x\":1}", headers: JSON_H, armParseThrow: true }), (o) => ({
      internal: reasonOf(o, "internal") && o.record?.outcome === "unavailable",
      fetch_js_console_error_never_fires: sdkLines(o).every((c) => (c.args[0] as { name?: string })?.name?.startsWith("Auth")),
    })],
  ];
  function reasonOf(o: Obs, reason: string) {
    return (((o.record?.local_by_reason ?? {}) as Record<string, number>)[reason] ?? 0) >= 1;
  }
  for (const [label, mode, checks] of edge) {
    it(`U21 ${label}`, async () => {
      const fam = newFamily();
      const o = await run({ cookie: cookieOf(familyPairs(envelope(fam))), script: [mode()], fallback: mode() });
      judge(`U21 ${label}`, { ...layers(o), ...checks(o), sdk_output_fixed: fixedSdkOutput(o), wrapper_never_threw: !o.threw }, o);
    });
  }
});

// ============================================================================
// U15, G1–G5: structure
// ============================================================================
describe("structure", () => {
  it("U15 key derivation equals authStorageKey() for three Supabase URL shapes", async () => {
    const boundary = await boundaryModule();
    if (!boundary) throw new Error("STRUCTURAL: boundary module absent");
    const server = await import("@/utils/supabase/server");
    const shapes = ["http://127.0.0.1:54329", "https://abcdefghijklmnopqrst.supabase.co", "http://localhost:54321", "https://auth.example.invalid/sub/path"];
    const results = shapes.map((url) => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
      return (boundary.sessionCookieKey as (u: string) => string)(url) === server.authStorageKey();
    });
    expect(results).toEqual(shapes.map(() => true));
  });

  it("G1 matcher guard: the matcher equals the protected segments under app/(dashboard)", () => {
    const base = path.join(ROOT, "app", "(dashboard)");
    const segments: string[] = [];
    const routeFiles: string[] = [];
    const walk = (dir: string, top: boolean) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && /^route\.(t|j)sx?$/.test(e.name)) routeFiles.push(path.join(dir, e.name));
        if (!e.isDirectory()) continue;
        if (e.name.startsWith("_") || e.name.startsWith("@")) continue;
        if (e.name.startsWith("(") && e.name.endsWith(")")) walk(path.join(dir, e.name), top);
        else {
          if (top) segments.push(e.name);
          walk(path.join(dir, e.name), false);
        }
      }
    };
    walk(base, true);
    const matcher = (config as { matcher: string[] }).matcher.slice().sort();
    const expected = segments.sort().map((s) => `/${s}/:path*`);
    const publicOrApi = matcher.filter((x) => /^\/(api|login|signup|auth)(\/|$|:)/.test(x) || x === "/" || x === "/:path*");
    judge("G1", {
      matcher_equals_protected_segments: JSON.stringify(matcher) === JSON.stringify(expected),
      twelve_segments: expected.length === 12,
      no_route_handler_under_dashboard: routeFiles.length === 0,
      public_and_api_paths_absent: publicOrApi.length === 0,
    }, [] as Obs[]);
  });

  function stripComments(src: string): string {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j;
      } else if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        out += "\n";
      } else if (c === "/" && src[i + 1] === "*") {
        i = src.indexOf("*/", i + 2) + 1;
      } else out += c;
    }
    return out;
  }

  it("G2 source guard on the boundary", () => {
    if (!existsSync(path.join(ROOT, BOUNDARY))) throw new Error("STRUCTURAL: boundary module absent");
    const src = stripComments(readFileSync(path.join(ROOT, BOUNDARY), "utf8"));
    const imports = Array.from(src.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)).map((x) => x[1]).sort();
    const forbidden = ["getAll", "setAll", "httpOnly: true", "domain", "getUser(", "getClaims", "setSession", "exchangeCodeForSession", "signIn", "signUp", "verifyOtp", "signOut", ".user", "email", "user_metadata", "app_metadata", "atob", "service_role", "redirect(", "NextResponse.redirect", "rewrite", "debug"];
    const envNames = Array.from(src.matchAll(/process\.env\.([A-Z0-9_]+)/g)).map((x) => x[1]);
    const topLevel = src.split("\n").filter((l) => /^(let|var)\s/.test(l) || /^const\s+\w+[^=]*=\s*new\s/.test(l));
    const redirects = Array.from(src.matchAll(/redirect\s*[:(]\s*("[^"]*")?/g)).map((x) => x[0]);
    judge("G2", {
      imports_exactly_ssr_and_next_server: JSON.stringify(imports) === JSON.stringify(["@supabase/ssr", "next/server"]),
      adapter_keys_get_set_remove: /cookies:\s*\{\s*get,\s*set,\s*remove\s*\}/.test(src),
      skip_auto_initialize: /skipAutoInitialize:\s*true/.test(src),
      no_forbidden_token: forbidden.every((f) => !src.includes(f)),
      only_manual_redirect_property: redirects.every((r) => /^redirect:\s*"manual"$/.test(r)),
      only_two_public_env_names: envNames.every((n) => n === "NEXT_PUBLIC_SUPABASE_URL" || n === "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      no_mutable_module_state: topLevel.length === 0,
      one_console_call_site: (src.match(/console\./g) ?? []).length === 1,
      max_age_is_op1: /COOKIE_MAX_AGE_S\s*=\s*2_?592_?000/.test(src),
      settings_are_e1: /PER_DISPATCH_MS\s*=\s*3_?000/.test(src) && /MAX_DISPATCHES\s*=\s*2;/.test(src) && /DEADLINE_MS\s*=\s*5_?000/.test(src),
    }, [] as Obs[]);
  });

  it("G3 import graph and call shape", () => {
    if (!existsSync(path.join(ROOT, BOUNDARY))) throw new Error("STRUCTURAL: boundary module absent");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "swingmaster-web", "ai-backend"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
          if (/session-refresh/.test(readFileSync(p, "utf8"))) importers.push(path.relative(ROOT, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(ROOT);
    const boundary = stripComments(readFileSync(path.join(ROOT, BOUNDARY), "utf8"));
    const mw = stripComments(readFileSync(path.join(ROOT, "middleware.ts"), "utf8"));
    const nextCalls = Array.from((boundary + mw).matchAll(/NextResponse\.next\((.*?)\);/g)).map((x) => x[1].replace(/\s+/g, " ").trim());
    judge("G3", {
      only_middleware_imports_the_boundary: JSON.stringify(importers.filter((f) => f !== BOUNDARY)) === JSON.stringify(["middleware.ts"]),
      boundary_does_not_import_the_verifier: !/utils\/supabase\/server|["']\.\/server["']/.test(boundary),
      next_calls_shape: nextCalls.length > 0 && nextCalls.every((a) => a === "" || a === "{ request: { headers } }"),
      middleware_has_no_redirect_or_rewrite: !/redirect|rewrite|new Response|NextResponse\.json/.test(mw),
    }, [] as Obs[]);
  });

  it("G4 version pin: the installed @supabase/ssr is 0.3.0", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "@supabase", "ssr", "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.3.0");
  });

  it("G5 app-wide guards: no wholesale headers(), no set-cookie read, no cookie writes outside route handlers", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/^route\.(ts|tsx)$/.test(e.name)) {
          const s = stripComments(readFileSync(p, "utf8"));
          const rel = path.relative(ROOT, p).replace(/\\/g, "/");
          const headerUses = Array.from(s.matchAll(/\bheaders\(\)/g)).map((x) => s.slice(x.index ?? 0, (x.index ?? 0) + 40));
          if (headerUses.some((u) => !/^headers\(\)\)?\.get\("(?!set-cookie)[a-z0-9-]+"\)/i.test(u))) offenders.push(`${rel}: headers() used whole`);
          if (/\.get\(\s*["']set-cookie["']\s*\)/i.test(s)) offenders.push(`${rel}: reads set-cookie`);
          if (/cookies\(\)\)?\.(set|delete)\(|cookieStore\.(set|delete)\(/.test(s)) offenders.push(`${rel}: cookie write`);
        }
      }
    };
    walk(path.join(ROOT, "app"));
    expect(offenders).toEqual([]);
  });
});
