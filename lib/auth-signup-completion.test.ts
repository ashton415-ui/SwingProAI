import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles the page's TSX with the classic JSX runtime, which needs React in scope (as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-AUTH-03 — sign-up completion and error handling, driven through the actual sign-up action and page.
 *
 * Three layers, each with only the external boundary replaced:
 *   A. the real action -> the real server client factory (utils/supabase/server.ts) -> the installed supabase-js /
 *      auth-js 2.107.0, with the HTTP transport (global fetch) answering with Auth-shaped responses. This is what turns
 *      a provider answer into the SDK's `{ data, error }`, so the code-only mapping is checked against the SDK's own
 *      error construction, not against a hand-made error object.
 *   B. the real action with the server client replaced by a fake whose results are tracking proxies: which fields the
 *      action reads (never a message, the session or user details), malformed shapes, thrown exceptions and framework
 *      control flow.
 *   C. the real page -> the real action -> the installed SDK, transport answered as in A, rendered by the real
 *      react-dom/server: every recognized answer renders the same markup, failures render fixed copy, recovery works.
 * Nothing reaches a network: the transport is a stub, and the configured Auth URL is a closed loopback port. The server
 * request cookie store (next/headers) is a recorder. Synthetic canary values are generated per run.
 *
 * Tags: [behavior] the AG-AUTH-03 behaviour; it must fail against the accepted AG-SESSION-03 action and page (which
 * return the provider message and redirect on success) for that reason. [preserve] the existing contract; passes on
 * both. [guard] source checks of the two changed files.
 */

const hooks = vi.hoisted(() => ({
  // the page's hook runtime (as in lib/auth-form-recovery.test.tsx): state and refs kept across renders, effects run on
  // demand, and updates made inside a running form action held until it settles
  slots: [] as unknown[],
  i: 0,
  effects: [] as (() => unknown)[],
  formPending: false,
  holding: 0,
  held: [] as (() => void)[],
  // the server boundary
  cookieWrites: [] as string[],
  cookieValues: {} as Record<string, string>, // what the request cookie store holds (empty unless a test plants one)
  fakeClient: null as null | (() => unknown), // layer B: replaces the server client
  onClient: null as null | ((client: unknown) => void), // layers A and C: sees each real per-request client
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = hooks.i++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const apply = () => { hooks.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[i]) : v; };
      if (hooks.holding) hooks.held.push(apply); else apply();
    };
    return [hooks.slots[i], set];
  }
  function useRef(init: unknown) {
    const i = hooks.i++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current: init };
    return hooks.slots[i];
  }
  const useEffect = (fn: () => unknown) => { hooks.effects.push(fn); };
  return { ...actual, default: actual, useState, useRef, useEffect };
});
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, useFormStatus: () => ({ pending: hooks.formPending, data: null, method: null, action: null }) };
});
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { ...p, href: p.href }) };
});
// the request cookie store a Server Action reads and writes through: reads find only what a test planted, writes are
// recorded by name
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (name in hooks.cookieValues ? { name, value: hooks.cookieValues[name] } : undefined),
    getAll: () => Object.entries(hooks.cookieValues).map(([name, value]) => ({ name, value })),
    has: (name: string) => name in hooks.cookieValues,
    set: (name: string) => { hooks.cookieWrites.push(`set:${name}`); },
    delete: (name: string) => { hooks.cookieWrites.push(`delete:${name}`); },
  }),
  headers: () => new Headers(),
}));
// the real server client factory, unchanged; each client it builds is shown to the test (layers A and C), or a fake
// client is returned instead (layer B)
vi.mock("@/utils/supabase/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/supabase/server")>();
  return {
    ...real,
    createClient: async () => {
      if (hooks.fakeClient) return hooks.fakeClient();
      const client = await real.createClient();
      hooks.onClient?.(client);
      return client;
    },
  };
});

import { signupAction } from "@/app/(auth)/signup/actions";
import SignupPage from "@/app/(auth)/signup/page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => source(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const COPY = {
  continueHeading: "Continue with your account",
  continueBody: "Sign in to continue. If email confirmation is required, check your inbox first.",
  signUpFailed: "We couldn't create your account. Check your details or try again in a moment. If you already have an account, sign in instead.",
  signUpUnconfirmed: "We couldn't confirm whether your account was created. Check your email or try signing in before creating it again.",
};
const COMPLETION = '{"outcome":"continue"}';
// What the completion must never claim: an account was created, the golfer is signed in, or an email was sent.
const CLAIMS = /account (?:has been|was|is) created|created your account|you(?:'|&#x27;)re signed in|signed in as|logged in|welcome|we(?:'|&#x27;)ve sent|we sent|email (?:has been|was) sent|confirmed your email/i;

// ── synthetic canaries (per run) and Auth-shaped answers ────────────────────────────────────────────────────────
const C = {
  email: `golfer-${randomUUID()}@example.invalid`,
  password: `pw-${randomUUID()}`,
  fullName: `Synthetic Golfer ${randomUUID().slice(0, 8)}`,
  accessToken: `agauth03-access-${randomUUID()}`,
  refreshToken: `agauth03-refresh-${randomUUID()}`,
  userId: randomUUID(),
  obfuscatedId: randomUUID(),
  providerText: `agauth03-provider-text-${randomUUID()}`,
};
const CANARIES = Object.values(C).flatMap((v) => [v, encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+")]);
const leaked = (text: string) => CANARIES.filter((v) => text.includes(v));
const SUPABASE_URL = "http://127.0.0.1:1"; // a closed loopback port: an unstubbed request could not leave the machine
const SIGNUP_URL = `${SUPABASE_URL}/auth/v1/signup`;

const iso = () => new Date().toISOString();
const identity = () => ({ identity_id: randomUUID(), id: C.userId, user_id: C.userId, provider: "email", email: C.email,
  identity_data: { email: C.email, sub: C.userId, full_name: C.fullName, email_verified: false }, created_at: iso(), updated_at: iso() });
const userObject = (id: string, identities: unknown[]) => ({ id, aud: "authenticated", role: "authenticated", email: C.email, phone: "",
  confirmation_sent_at: iso(), app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { full_name: C.fullName, email: C.email, sub: id },
  identities, created_at: iso(), updated_at: iso(), is_anonymous: false });
const VERSIONED = { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" };
const LEGACY = { "content-type": "application/json" };
type Answer = () => Response;
const reply = (status: number, body: unknown, headers: Record<string, string> = VERSIONED): Answer => () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const sessionBody = () => ({ access_token: C.accessToken, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: C.refreshToken, user: userObject(C.userId, [identity()]) });

// The four recognized answers. They must produce one identical app-owned completion.
const RECOGNIZED: Array<[string, Answer]> = [
  ["a new user with a session (Confirm email off)", reply(200, sessionBody())],
  ["a new user without a session (Confirm email on)", reply(200, userObject(C.userId, [identity()]))],
  ["the obfuscated user Auth can return for an existing address (no error, no identities, no session)", reply(200, userObject(C.obfuscatedId, []))],
  ["the recognized duplicate code (user_already_exists, 422)", reply(422, { code: "user_already_exists", message: `User already registered ${C.email} ${C.providerText}` })],
];
// the same recognized duplicate in the pre-2024 error body (no API-version header; the code in error_code)
const LEGACY_DUPLICATE: Answer = reply(422, { code: 422, error_code: "user_already_exists", msg: `User already registered ${C.providerText}` }, LEGACY);

const NOT_RECOGNIZED: Array<[string, Answer, "failed" | "unconfirmed"]> = [
  ["a duplicate message with no code (pre-2024 body, no error_code)", reply(422, { code: 422, msg: `User already registered ${C.providerText}` }, LEGACY), "failed"],
  ["a duplicate message with no code (2024 body, no code)", reply(400, { message: `User already registered ${C.email}` }), "failed"],
  ["an unknown code", reply(422, { code: "agauth03_unknown_future_code", message: C.providerText }), "failed"],
  ["the unrelated existence code email_exists", reply(422, { code: "email_exists", message: `Email address already exists ${C.email}` }), "failed"],
  ["the unrelated existence code phone_exists", reply(422, { code: "phone_exists", message: C.providerText }), "failed"],
  ["the unrelated existence code identity_already_exists", reply(422, { code: "identity_already_exists", message: C.providerText }), "failed"],
  ["a conflict (409)", reply(409, { code: "conflict", message: C.providerText }), "failed"],
  ["an email rate limit (429)", reply(429, { code: "over_email_send_rate_limit", message: `email rate limit exceeded ${C.providerText}` }), "failed"],
  ["a request rate limit (429)", reply(429, { code: "over_request_rate_limit", message: C.providerText }), "failed"],
  ["a weak password (the SDK's AuthWeakPasswordError)", reply(422, { code: "weak_password", message: `Password is too weak ${C.providerText}`,
    weak_password: { reasons: ["length", "characters"] } }), "failed"],
  ["sign-ups disabled", reply(422, { code: "signup_disabled", message: C.providerText }), "failed"],
  ["a server failure after the account may have been created (500)", reply(500, { code: "unexpected_failure", message: `Error sending confirmation email ${C.providerText}` }), "unconfirmed"],
  ["a gateway timeout (504, the SDK's AuthRetryableFetchError)", reply(504, `upstream timed out ${C.providerText}`, { "content-type": "text/plain" }), "unconfirmed"],
  ["service unavailable (503)", reply(503, { message: C.providerText }), "unconfirmed"],
  ["a refusal whose body is not JSON (400; the SDK's AuthUnknownError, no status)", reply(400, `<html>${C.providerText}</html>`, { "content-type": "text/html" }), "unconfirmed"],
  ["a server error whose body is not JSON (500; the SDK's AuthUnknownError)", reply(500, `<html>${C.providerText}</html>`, { "content-type": "text/html" }), "unconfirmed"],
  ["session_not_found (the SDK's AuthSessionMissingError, 400, no code)", reply(400, { code: "session_not_found", message: C.providerText }), "failed"],
  ["a 200 that is not JSON", reply(200, `<html>${C.providerText}</html>`, { "content-type": "text/html" }), "unconfirmed"],
  ["a 200 whose body is JSON null", reply(200, "null"), "unconfirmed"],
  ["a 200 empty object", reply(200, {}), "unconfirmed"],
  ["a 200 whose user has no id", reply(200, { user: { email: C.email, user_metadata: { full_name: C.fullName } } }), "unconfirmed"],
  ["a 200 session with no user", reply(200, { access_token: C.accessToken, refresh_token: C.refreshToken, expires_in: 3600, token_type: "bearer" }), "unconfirmed"],
];

// ── the boundary: transport stub, per-request clients, console ────────────────────────────────────────────────
type Sent = { url: string; method: string; body: string | null; authorization?: string | null };
let sent: Sent[] = [];
function serve(answer: Answer | (() => never)) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null,
      authorization: new Headers(init?.headers).get("authorization") });
    return answer();
  });
}
// every public Auth method that would sign in, read, keep or refresh a session, or make another Auth request; each call
// on a real per-request client is recorded. (The installed SDK's own internals are not public calls: signUp saves a
// returned session into the per-request client's memory and emits SIGNED_IN, and the client's own auth listener reads
// that memory for its initial event. That none of this becomes a refresh or any second Auth request is shown by the
// transport record, taken after pending timers and promises have been flushed: exactly one request, the sign-up.)
const WATCHED = ["setSession", "refreshSession", "signInWithPassword", "signInWithOtp", "signInWithIdToken", "signInAnonymously", "signOut",
  "exchangeCodeForSession", "getSession", "getUser", "updateUser", "resend", "verifyOtp", "reauthenticate", "startAutoRefresh"];
// let the SDK's own asynchronous work after the answer (its auth listener's initial event, any lock release) run out
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };
let authCalls: string[] = [];
let clients: Array<Record<string, unknown>> = [];
function instrument(client: unknown) {
  const auth = (client as { auth: Record<string, unknown> }).auth;
  clients.push(auth);
  for (const name of WATCHED) {
    const original = auth[name];
    if (typeof original !== "function") continue;
    auth[name] = (...args: unknown[]) => { authCalls.push(name); return (original as (...a: unknown[]) => unknown).apply(auth, args); };
  }
}
let logged: Array<{ method: string; args: unknown[] }> = [];
const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;

let win: { location: { href: string } };
beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  hooks.formPending = false;
  hooks.holding = 0;
  hooks.held = [];
  hooks.cookieWrites = [];
  hooks.cookieValues = {};
  hooks.fakeClient = null;
  hooks.onClient = instrument;
  sent = [];
  authCalls = [];
  clients = [];
  logged = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "agauth03-synthetic-anon-key-not-a-secret");
  vi.stubGlobal("fetch", async () => { throw new Error("no transport answer arranged"); });
  for (const m of CONSOLE) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push({ method: m, args }); });
  win = { location: { href: "about:blank" } };
  (globalThis as Record<string, unknown>).window = win;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).window;
});

const form = () => {
  const fd = new FormData();
  fd.set("fullName", C.fullName);
  fd.set("email", C.email);
  fd.set("password", C.password);
  return fd;
};
// what the one sign-up request carried (booleans only) and where it went
function sentRecord() {
  return sent.map((s) => {
    const body = (() => { try { return JSON.parse(s.body ?? "null"); } catch { return null; } })();
    return { url: s.url === SIGNUP_URL ? "the sign-up endpoint" : "OTHER", method: s.method,
      email: body?.email === C.email, password: body?.password === C.password, fullName: body?.data?.full_name === C.fullName,
      dataKeys: Object.keys(body?.data ?? {}).sort() };
  });
}
const ONE_SIGNUP_REQUEST = [{ url: "the sign-up endpoint", method: "POST", email: true, password: true, fullName: true, dataKeys: ["full_name"] }];

// ── A. the real action and the installed SDK, transport stubbed ────────────────────────────────────────────────
describe("A. the action through the installed SDK (auth-js 2.107.0), HTTP transport stubbed", () => {
  it.each(RECOGNIZED)("[behavior] %s: the one fixed completion, one sign-up request, nothing persisted, logged or leaked", async (_, answer) => {
    serve(answer);
    const result = await signupAction(form());
    await flush();
    const json = JSON.stringify(result);
    const seen = { json, leaked: leaked(json), sent: sentRecord(), authCalls, cookieWrites: hooks.cookieWrites, logged: logged.length, clients: clients.length };
    expect(seen).toEqual({ json: COMPLETION, leaked: [], sent: ONE_SIGNUP_REQUEST, authCalls: [], cookieWrites: [], logged: 0, clients: 1 });
    // the per-request client keeps nothing beyond this request (the SDK's own settings on it, recorded)
    expect({ persistSession: clients[0].persistSession, autoRefreshToken: clients[0].autoRefreshToken }).toEqual({ persistSession: false, autoRefreshToken: false });
  });

  it("[behavior] the recognized duplicate in the pre-2024 error body (code in error_code) is the same completion", async () => {
    serve(LEGACY_DUPLICATE);
    expect(JSON.stringify(await signupAction(form()))).toBe(COMPLETION);
    expect(sentRecord()).toEqual(ONE_SIGNUP_REQUEST);
  });

  it("[behavior] equality: the four recognized answers give byte-identical app-owned objects with the single key `outcome`", async () => {
    const out: string[] = [];
    for (const [, answer] of RECOGNIZED) {
      serve(answer);
      const result = await signupAction(form());
      expect(Object.keys(result as object)).toEqual(["outcome"]);
      out.push(JSON.stringify(result));
    }
    expect(out).toEqual([COMPLETION, COMPLETION, COMPLETION, COMPLETION]);
    expect(sent).toHaveLength(4);
  });

  it.each(NOT_RECOGNIZED)("[behavior] %s: a fixed error, never the completion, and nothing leaked", async (_, answer, outcome) => {
    serve(answer);
    const result = await signupAction(form());
    await flush();
    const json = JSON.stringify(result);
    const seen = { json, leaked: leaked(json), sent: sentRecord(), authCalls, cookieWrites: hooks.cookieWrites, logged: logged.length };
    expect(seen).toEqual({ json: `{"outcome":"${outcome}"}`, leaked: [], sent: ONE_SIGNUP_REQUEST, authCalls: [], cookieWrites: [], logged: 0 });
  });

  it("[behavior] a returned session already inside the SDK's refresh margin (expires in 10 s): still the completion, one request, no refresh", async () => {
    serve(reply(200, { ...sessionBody(), expires_in: 10, expires_at: Math.floor(Date.now() / 1000) + 10 }));
    const result = await signupAction(form());
    await flush();
    expect({ json: JSON.stringify(result), sent: sentRecord(), authCalls, cookieWrites: hooks.cookieWrites, logged: logged.length })
      .toEqual({ json: COMPLETION, sent: ONE_SIGNUP_REQUEST, authCalls: [], cookieWrites: [], logged: 0 });
  });

  it("[behavior] a scripted call without a FormData is unknown and makes no request at all", async () => {
    serve(RECOGNIZED[0][1]);
    for (const input of [{}, null, "email=x"]) {
      expect(JSON.stringify(await signupAction(input as unknown as FormData))).toBe('{"outcome":"unconfirmed"}');
    }
    await flush();
    expect({ sent: sent.length, clients: clients.length, authCalls }).toEqual({ sent: 0, clients: 0, authCalls: [] });
  });

  it("[behavior] a transport failure (the request never answered): unconfirmed; the only console output is the installed SDK's own", async () => {
    const thrown = new TypeError(`fetch failed ${C.providerText}`);
    serve(() => { throw thrown; });
    const result = await signupAction(form());
    expect(JSON.stringify(result)).toBe('{"outcome":"unconfirmed"}');
    expect(leaked(JSON.stringify(result))).toEqual([]);
    expect(sentRecord()).toEqual(ONE_SIGNUP_REQUEST); // one attempt: no retry
    expect({ authCalls, cookieWrites: hooks.cookieWrites }).toEqual({ authCalls: [], cookieWrites: [] });
    // auth-js 2.107.0 lib/fetch.js _handleRequest: `console.error(e)` with the transport's own error object, then an
    // AuthRetryableFetchError. Inherited SDK logging of the transport error, not the action's: the action logs nothing.
    expect(logged.map((l) => ({ method: l.method, isTheTransportError: l.args.length === 1 && l.args[0] === thrown }))).toEqual([{ method: "error", isTheTransportError: true }]);
  });

  it("[behavior] with a session cookie already in the request, the answer is interpreted the same way and no cookie is written", async () => {
    // the unchanged server client factory reads the stored session's access token and sends it as its bearer (inherited
    // behaviour of utils/supabase/server.ts createClient, recorded here as a boolean); the action neither reads nor
    // replaces that cookie
    hooks.cookieValues = { "sb-127-auth-token": encodeURIComponent(JSON.stringify({ access_token: C.accessToken, refresh_token: C.refreshToken })) };
    for (const [, answer] of [RECOGNIZED[0], NOT_RECOGNIZED[0]] as const) {
      serve(answer as Answer);
      await signupAction(form());
    }
    expect(sent.map((s) => s.authorization === `Bearer ${C.accessToken}`)).toEqual([true, true]);
    sent = [];
    serve(RECOGNIZED[0][1]);
    const json = JSON.stringify(await signupAction(form()));
    await flush();
    expect({ json, leaked: leaked(json), cookieWrites: hooks.cookieWrites, authCalls, sent: sentRecord() })
      .toEqual({ json: COMPLETION, leaked: [], cookieWrites: [], authCalls: [], sent: ONE_SIGNUP_REQUEST });
  });
});

// ── B. the real action with a fake server client: what it reads, odd shapes, exceptions, control flow ───────────────
type Log = string[];
// a proxy that records every property read as "<label>.<prop>"; with `forbid`, reading a named property throws
function track<T extends object>(label: string, target: T, log: Log, forbid: Array<string | symbol> = []): T {
  return new Proxy(target, {
    get(t, p, r) {
      log.push(`${label}.${String(p)}`);
      if (forbid.includes(p)) throw new Error(`forbidden read: ${label}.${String(p)}`);
      return Reflect.get(t, p, r);
    },
    has(t, p) { log.push(`${label} has ${String(p)}`); return Reflect.has(t, p); },
  });
}
const HOSTILE: Array<string | symbol> = ["message", "toString", "toJSON", "stack", "cause", "name", Symbol.toPrimitive, "valueOf"];
// awaiting any object makes the promise machinery itself read its `then`; that read is not the action's
const byAction = (log: Log) => log.filter((l) => l !== "result.then");
// plain functions (no spy wrapper, which could itself read the returned value): calls counted, sign-up arguments kept
function fake(signUp: (...a: unknown[]) => unknown) {
  const calls: Record<string, number> = {};
  const args: unknown[][] = [];
  const auth = Object.fromEntries(["signUp", ...WATCHED, "getSession"].map((n) => [n, (...a: unknown[]) => {
    calls[n] = (calls[n] ?? 0) + 1;
    if (n !== "signUp") return undefined;
    args.push(a);
    return signUp(...a);
  }]));
  hooks.fakeClient = () => ({ auth });
  return { calls, args };
}

describe("B. the action with the server client faked: reads, shapes, exceptions and control flow", () => {
  it("[preserve] signUp is called once with exactly the submitted email, password and full name", async () => {
    const { args, calls } = fake(() => ({ data: { user: null, session: null }, error: { code: "x", status: 400 } }));
    await signupAction(form());
    expect(args).toEqual([[{ email: C.email, password: C.password, options: { data: { full_name: C.fullName } } }]]);
    expect(calls).toEqual({ signUp: 1 });
  });

  it("[behavior] success: reads only result.data, result.error, data.user and user.id; never the session or other user fields; nothing persisted", async () => {
    const log: Log = [];
    const user = track("user", userObject(C.userId, [identity()]), log, ["email", "user_metadata", "identities", "app_metadata", ...HOSTILE]);
    const session = track("session", { access_token: C.accessToken, refresh_token: C.refreshToken }, log, ["access_token", "refresh_token", "user", ...HOSTILE]);
    const data = track("data", { user, session }, log, ["session", ...HOSTILE]);
    const { calls } = fake(() => track("result", { data, error: null }, log, HOSTILE));
    const result = await signupAction(form());
    expect(JSON.stringify(result)).toBe(COMPLETION);
    expect(byAction(log)).toEqual(["result.data", "result.error", "data.user", "user.id"]);
    expect(calls).toEqual({ signUp: 1 });
    expect(hooks.cookieWrites).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("[behavior] a provider error: reads only its code and status; a throwing message getter (and toString/toJSON/name) is never touched", async () => {
    for (const [fields, outcome] of [
      [{ code: "user_already_exists", status: 422 }, "continue"],
      [{ code: "over_email_send_rate_limit", status: 429 }, "failed"],
      [{ status: 422 }, "failed"], // message-only duplicate: the message is there, but never read
      [{ code: "unexpected_failure", status: 500 }, "unconfirmed"],
      [{ name: "AuthRetryableFetchError", status: 0 }, "unconfirmed"],
    ] as const) {
      const log: Log = [];
      let messageReads = 0;
      const target = { ...fields };
      Object.defineProperty(target, "message", { get() { messageReads++; throw new Error("message getter"); }, enumerable: true });
      const error = track("error", target, log, HOSTILE);
      const data = track("data", { user: null, session: null }, log, HOSTILE);
      fake(() => track("result", { data, error }, log, HOSTILE));
      const result = await signupAction(form());
      expect({ fields, json: JSON.stringify(result), messageReads, log: byAction(log) }).toEqual({ fields, json: `{"outcome":"${outcome}"}`, messageReads: 0,
        log: ["result.data", "result.error", "error.code", "error.status"] });
    }
    expect(logged).toEqual([]);
  });

  it("[behavior] equality through the fake client: session, no session, obfuscated user and coded duplicate are one object", async () => {
    const out: string[] = [];
    for (const r of [
      { data: { user: { id: C.userId }, session: { access_token: C.accessToken } }, error: null },
      { data: { user: { id: C.userId }, session: null }, error: null },
      { data: { user: { id: C.obfuscatedId, identities: [] }, session: null }, error: null },
      { data: { user: null, session: null }, error: { code: "user_already_exists", status: 422, message: C.providerText } },
    ]) {
      fake(() => r);
      out.push(JSON.stringify(await signupAction(form())));
    }
    expect(new Set(out)).toEqual(new Set([COMPLETION]));
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", C.providerText],
    ["an empty object", {}],
    ["no error key (only data)", { data: { user: { id: C.userId }, session: null } }],
    ["error undefined", { data: { user: { id: C.userId }, session: null }, error: undefined }],
    ["data null", { data: null, error: null }],
    ["data with no user", { data: {}, error: null }],
    ["user null", { data: { user: null, session: { access_token: C.accessToken } }, error: null }],
    ["user without an id", { data: { user: { email: C.email } }, error: null }],
    ["user id not a string", { data: { user: { id: 42 } }, error: null }],
    ["user id empty", { data: { user: { id: "" } }, error: null }],
    ["error a string", { data: { user: { id: C.userId } }, error: C.providerText }],
    ["error with a code but no status (other code)", { data: null, error: { code: "email_exists" } }],
  ])("[behavior] a malformed result (%s) is unknown, never the completion", async (_, r) => {
    fake(() => r);
    const json = JSON.stringify(await signupAction(form()));
    expect({ json, leaked: leaked(json) }).toEqual({ json: '{"outcome":"unconfirmed"}', leaked: [] });
  });

  it.each([
    ["a different case", { code: "USER_ALREADY_EXISTS", status: 422 }],
    ["surrounding space", { code: " user_already_exists", status: 422 }],
    ["a prefix", { code: "user_already_exists_v2", status: 422 }],
    ["email_exists", { code: "email_exists", status: 422 }],
    ["phone_exists", { code: "phone_exists", status: 422 }],
    ["identity_already_exists", { code: "identity_already_exists", status: 422 }],
    ["no code, the message says registered", { status: 400, message: "User already registered" }],
  ])("[behavior] code-only: %s is a failure, not the completion", async (_, error) => {
    fake(() => ({ data: { user: null, session: null }, error }));
    expect(JSON.stringify(await signupAction(form()))).toBe('{"outcome":"failed"}');
  });

  it("[behavior] a recognized code with no status is still the completion (the code alone decides)", async () => {
    fake(() => ({ data: { user: null, session: null }, error: { code: "user_already_exists" } }));
    expect(JSON.stringify(await signupAction(form()))).toBe(COMPLETION);
  });

  it("[behavior] thrown exceptions are unknown: an Error, a non-Error, and an object whose every getter throws; nothing read but `digest`", async () => {
    for (const make of [
      () => new Error(`${C.providerText} ${C.email}`),
      () => C.providerText,
      () => { const log: Log = []; return { value: track("thrown", {}, log, HOSTILE), log }; },
    ]) {
      const made = make() as unknown;
      const tracked = typeof made === "object" && made !== null && "log" in made ? (made as { value: unknown; log: Log }) : null;
      fake(() => { throw tracked ? tracked.value : made; });
      const json = JSON.stringify(await signupAction(form()));
      expect({ json, leaked: leaked(json) }).toEqual({ json: '{"outcome":"unconfirmed"}', leaked: [] });
      if (tracked) expect(tracked.log).toEqual(["thrown has digest"]);
    }
    // a rejected promise is the same
    fake(() => Promise.reject(new Error(C.providerText)));
    expect(JSON.stringify(await signupAction(form()))).toBe('{"outcome":"unconfirmed"}');
    expect(logged).toEqual([]);
  });

  it("[behavior] the client factory itself failing is unknown, and no sign-up is attempted", async () => {
    hooks.fakeClient = () => { throw new Error(C.providerText); };
    expect(JSON.stringify(await signupAction(form()))).toBe('{"outcome":"unconfirmed"}');
  });

  it.each([
    ["a redirect (replace)", "NEXT_REDIRECT;replace;/dashboard;307;"],
    ["a redirect (push)", "NEXT_REDIRECT;push;/dashboard;303;"],
    ["a not-found", "NEXT_NOT_FOUND"],
  ])("[preserve] Next's own control flow (%s) is rethrown untouched", async (_, digest) => {
    const signal = Object.assign(new Error(digest.split(";")[0]), { digest });
    fake(() => { throw signal; });
    await expect(signupAction(form())).rejects.toBe(signal);
  });

  it.each([
    ["a look-alike digest", "NEXT_REDIRECTX;replace;/dashboard;307;"],
    ["a redirect digest without a status", "NEXT_REDIRECT;replace;/dashboard"],
    ["a numeric server digest", "2817364519"],
  ])("[behavior] %s is not control flow: unknown", async (_, digest) => {
    fake(() => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest }); });
    expect(JSON.stringify(await signupAction(form()))).toBe('{"outcome":"unconfirmed"}');
  });

  it("[behavior] even when a session comes back, no Auth method other than signUp runs and no cookie is written", async () => {
    const { calls } = fake(() => ({ data: { user: { id: C.userId }, session: { access_token: C.accessToken, refresh_token: C.refreshToken } }, error: null }));
    expect(JSON.stringify(await signupAction(form()))).toBe(COMPLETION);
    expect({ calls, cookieWrites: hooks.cookieWrites }).toEqual({ calls: { signUp: 1 }, cookieWrites: [] });
  });
});

// ── C. the real page, through the real action and the installed SDK ─────────────────────────────────────────────
type El = React.ReactElement<Record<string, unknown>>;
const FORWARD_REF = Symbol.for("react.forward_ref");
const focusLog: string[] = [];
function expand(node: unknown): unknown[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  const el = node as El;
  const type = el.type as unknown;
  if (type === React.Fragment) return expand(el.props.children);
  if (typeof type === "function") return expand((type as (p: unknown) => unknown)(el.props));
  if (type && typeof type === "object" && (type as { $$typeof?: symbol }).$$typeof === FORWARD_REF) {
    return expand((type as { render: (p: unknown, r: unknown) => unknown }).render(el.props, null));
  }
  if (typeof type === "string") {
    const { children, ...props } = el.props;
    const ref = (el as unknown as { ref?: unknown }).ref;
    if (ref && typeof ref === "object" && "current" in ref) {
      (ref as { current: unknown }).current = { id: props.id ?? null, focus: () => { focusLog.push(String(props.id ?? type)); } };
    }
    return [React.createElement(type, props, ...(expand(children) as React.ReactNode[]))];
  }
  throw new Error(`unexpected element type ${String(type)}`);
}
function markup(nodes: unknown[]): React.ReactNode[] {
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n as React.ReactNode;
    const { children, ...props } = (n as El).props;
    const kept = Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v !== "function"));
    const kids = Array.isArray(children) ? children : children === undefined ? [] : [children];
    return React.createElement((n as El).type as string, kept, ...markup(kids));
  });
}
function render() {
  hooks.i = 0;
  hooks.effects = [];
  const nodes = expand(React.createElement(SignupPage as unknown as React.FC));
  return { nodes, html: renderToStaticMarkup(React.createElement(React.Fragment, null, ...markup(nodes))) };
}
function all(nodes: unknown[], pred: (e: El) => boolean, out: El[] = []): El[] {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const e = n as El;
    if (pred(e)) out.push(e);
    const kids = e.props.children;
    all(Array.isArray(kids) ? kids : [kids], pred, out);
  }
  return out;
}
function textOf(e: unknown): string {
  if (e == null || typeof e === "boolean") return "";
  if (typeof e === "string" || typeof e === "number") return String(e);
  if (Array.isArray(e)) return e.map(textOf).join("");
  return textOf((e as El).props.children);
}
const alerts = (nodes: unknown[]) => all(nodes, (e) => e.props.role === "alert").map((a) => textOf(a).trim());
const BODY = { id: "body" };
function runEffects(active: unknown = BODY) {
  focusLog.length = 0;
  (globalThis as Record<string, unknown>).document = { body: BODY, activeElement: active };
  try { for (const fn of hooks.effects) fn(); } finally { delete (globalThis as Record<string, unknown>).document; }
  return [...focusLog];
}
const formAction = () => all(render().nodes, (e) => e.type === "form")[0]?.props.action as ((f: FormData) => Promise<void>) | undefined;
// run the page's own form action the way React runs one: pending while it runs, updates held until it settles
async function submit(fd = form()) {
  const action = formAction();
  if (!action) throw new Error("no form on the page");
  hooks.formPending = true;
  hooks.holding++;
  try {
    await action(fd);
  } finally {
    hooks.holding--;
    if (!hooks.holding) { hooks.held.splice(0).forEach((apply) => apply()); hooks.formPending = false; }
  }
}
const fresh = () => { hooks.slots = []; hooks.effects = []; };

describe("C. the page, through the real action and the installed SDK", () => {
  it("[behavior] UI equality: the four recognized answers render byte-identical markup: the fixed heading, body and one sign-in link", async () => {
    const pages: string[] = [];
    for (const [, answer] of RECOGNIZED) {
      fresh();
      serve(answer);
      await submit();
      pages.push(render().html);
    }
    expect(new Set(pages).size).toBe(1);
    expect(sent).toHaveLength(4);
    const { nodes, html } = render();
    expect(html).toBe(pages[0]);
    const heading = all(nodes, (e) => e.type === "h2");
    expect(heading.map((h) => [textOf(h).trim(), h.props.id, h.props.tabIndex])).toEqual([[COPY.continueHeading, "signup-continue-heading", -1]]);
    expect(all(nodes, (e) => e.type === "p" && textOf(e).trim() === COPY.continueBody)).toHaveLength(1);
    const links = all(nodes, (e) => e.type === "a");
    expect(links.map((l) => [l.props.href, textOf(l).trim()])).toEqual([["/login", "Sign in"]]);
    expect(String(links[0].props.className)).toMatch(/\bmin-h-11\b/);
    expect(String(links[0].props.className)).toMatch(/\bw-full\b/);
    expect(String(links[0].props.className)).toMatch(/focus-visible:outline-2/);
    // no form, field, hidden value, alert or status region remains; no branch-specific attribute
    expect(all(nodes, (e) => ["form", "input", "button"].includes(e.type as string))).toEqual([]);
    expect(all(nodes, (e) => e.props.role === "alert" || e.props.role === "status")).toEqual([]);
    expect(html).not.toMatch(/type="hidden"|data-outcome|data-session|data-duplicate/);
    expect(html).not.toMatch(CLAIMS);
    expect(leaked(html)).toEqual([]);
    expect({ href: win.location.href, cookieWrites: hooks.cookieWrites, authCalls, logged: logged.length }).toEqual({ href: "about:blank", cookieWrites: [], authCalls: [], logged: 0 });
  });

  it("[behavior] after the completion, focus that fell to the page moves to the heading; focus elsewhere is left", async () => {
    serve(RECOGNIZED[1][1]);
    await submit();
    render();
    expect(runEffects(BODY)).toEqual(["signup-continue-heading"]);
    render();
    expect(runEffects({ id: "elsewhere" })).toEqual([]);
  });

  async function rendersOnTheForm(answer: Answer, copy: string) {
    serve(answer);
    await submit();
    const { nodes, html } = render();
    expect(alerts(nodes)).toEqual([copy]);
    expect(html).not.toContain(COPY.continueHeading);
    const button = all(nodes, (e) => e.type === "button")[0];
    expect([button.props.disabled, button.props["aria-busy"]]).toEqual([false, false]);
    expect(leaked(html)).toEqual([]);
  }
  // definite refusals already showed the fixed failure copy on the accepted page; preserved
  it.each([
    ["a rate limit", NOT_RECOGNIZED.find(([n]) => n.startsWith("an email rate limit"))![1]],
    ["a message-only duplicate", NOT_RECOGNIZED[0][1]],
    ["an unrelated existence code", NOT_RECOGNIZED.find(([n]) => n.includes("email_exists"))![1]],
  ])("[preserve] %s renders the fixed failure copy on the form, never a completion; the form recovers", async (_, answer) => {
    await rendersOnTheForm(answer, COPY.signUpFailed);
  });
  // AG-AUTH-03: an unknown outcome is no longer called a failure (the account may exist)
  it.each([
    ["a server failure", NOT_RECOGNIZED.find(([n]) => n.includes("(500)"))![1]],
    ["a malformed answer", NOT_RECOGNIZED.find(([n]) => n.includes("empty object"))![1]],
  ])("[behavior] %s renders the uncertainty copy on the form, never the completion; the form recovers", async (_, answer) => {
    await rendersOnTheForm(answer, COPY.signUpUnconfirmed);
  });

  it("[behavior] a lost request (transport failure) shows the uncertainty copy, then a retry can complete", async () => {
    serve(() => { throw new TypeError("fetch failed"); });
    await submit();
    expect(alerts(render().nodes)).toEqual([COPY.signUpUnconfirmed]);
    serve(RECOGNIZED[0][1]);
    await submit();
    const after = render();
    expect(alerts(after.nodes)).toEqual([]);
    expect(after.html).toContain(COPY.continueHeading);
    expect(sent).toHaveLength(2);
  });

  it("[behavior] a second submission while the first is in flight makes no second request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), method: init?.method ?? "GET", body: null });
      await gate;
      return RECOGNIZED[1][1]();
    });
    const action = formAction()!;
    hooks.formPending = true;
    hooks.holding++;
    const first = action(form());
    const second = action(form()); // the same moment, before the disabled button renders
    await new Promise((r) => setTimeout(r, 0));
    const during = sent.length;
    release();
    await Promise.all([first, second]);
    hooks.holding--;
    hooks.held.splice(0).forEach((apply) => apply());
    hooks.formPending = false;
    expect({ during, total: sent.length }).toEqual({ during: 1, total: 1 });
    expect(render().html).toContain(COPY.continueHeading);
  });
});

// ── guards: the two changed files ─────────────────────────────────────────────────────────────────────────────
describe("source guards", () => {
  const ACTION = "app/(auth)/signup/actions.ts";
  const PAGE = "app/(auth)/signup/page.tsx";
  it("[guard] the action reads no message, logs nothing, redirects nowhere, touches no cookie and makes one Auth call", () => {
    const src = code(ACTION);
    expect(src).not.toMatch(/\.message\b|console\.|redirect|next\/navigation|next\/headers|cookies\(|JSON\.stringify|toString|String\(|`/);
    expect(src).not.toMatch(/setSession|refreshSession|signInWith|signOut|exchangeCodeForSession|getSession|getUser|updateUser|resend|verifyOtp/);
    expect(src.match(/\.auth\./g)).toHaveLength(1);
    expect(src.match(/signUp\(/g)).toHaveLength(1);
    expect(src.match(/return \{ outcome \};/g)).toHaveLength(1);
    expect(Array.from(source(ACTION).matchAll(/^import .* from "([^"]+)";$/gm)).map((m) => m[1])).toEqual(["@/utils/supabase/server"]);
  });
  it("[guard] the duplicate allow-list is exactly the one SDK code", () => {
    expect(/const DUPLICATE_CODES: ReadonlySet<string> = new Set\((\[[^\]]*\])\);/.exec(source(ACTION))?.[1]).toBe('["user_already_exists"]');
  });
  it("[guard] the page holds the exact completion copy, one completion site and one fixed sign-in destination for it", () => {
    const src = source(PAGE);
    const constant = (name: string) => (new RegExp(`const ${name} =\\s*"([^"]*)";`).exec(src) || [])[1];
    expect([constant("CONTINUE_HEADING"), constant("CONTINUE_BODY")]).toEqual([COPY.continueHeading, COPY.continueBody]);
    expect(src.match(/setCompleted\(/g)).toHaveLength(1);
    expect(src.match(/setCompleted\(true\)/g)).toHaveLength(1);
    expect(src.match(/href="\/login"/g)).toHaveLength(2); // the completion's link and the existing account link
    expect(code(PAGE)).not.toMatch(/router|useRouter|window\.location|searchParams|URLSearchParams|redirect/);
  });
});
