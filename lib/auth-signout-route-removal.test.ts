import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { createChunks } from "@supabase/ssr";

// AG-WEB-READY-03-R1 — the End Session route, executed (app/api/auth/signout/route.ts).
//
// The route runs with a real NextRequest; Auth is an in-memory stand-in behind the stubbed platform fetch, which
// records every request, its abort signal and whether its body was read or cancelled. The clock is fake (setTimeout and
// Date), so every bound below is exact. Synthetic tokens only.
//
// Contract under test:
// - passive: no answer ever carries a Set-Cookie, for any layout the request carries (F1: a removal could land after
//   another tab published a newer session under the same names);
// - revocation: logout?scope=local with the carried token; on 401/403 one refresh, solely to log out with its access
//   token; the session counts as ended only when Auth confirms it (a 2xx/404 logout for the intended lineage; A4 C2: a
//   refresh refused as gone is UNCONFIRMED — it names no sign-in);
// - answers: 303 /login when ended or nothing usable was carried; 303 /dashboard when the carried session belongs to
//   another account than expected_user; otherwise an honest 503 page (never a redirect that implies success);
// - budgets (F3): each Auth exchange — headers AND body — within 2 s and within the shared 6 s revocation budget; the
//   form body within its own 3 s; so every answer within 9 s of arrival; every request aborted and every body consumed
//   or cancelled when its exchange ends; at most three Auth requests; no timer left behind.
//
// A2 (AG-WEB-READY-03-R1-A2) — lineage and an honest completion:
// - the form names the session LINEAGE the page was rendered for (expected_session: a digest of the Auth session id);
//   only that lineage is revoked: a newer sign-in — even of the same account — ends nothing (303 /dashboard, no Auth
//   request), so a delayed or replayed post never ends a newer session; a form naming no account or no lineage ends
//   nothing either and (A5, E1) says so: the honest 409 outdated-page answer, no Auth request, no cookie, no retry form;
// - a revocation Auth confirmed for a session the request carried is answered with an honest 200 page (ended at the
//   sign-in service, this device's copy still to be removed; without JavaScript how to remove it) — never a redirect
//   implying a complete sign-out — and the ONE Set-Cookie any answer may carry: the short-lived END INTENT naming only
//   that lineage's digest (never a session or binding cookie, never a removal);
// - a post without a session cookie whose end_state says Auth did not confirm the browser's own revocation gets the
//   honest "signed out on this device, revocation not confirmed" page (display only); otherwise 303 /login.

const SUPABASE = "http://127.0.0.1:54329";
const APP = "http://127.0.0.1:3941";
const KEY = "sb-127-auth-token";
const A_ID = "00000000-0000-4000-8000-0000000000aa";
const B_ID = "00000000-0000-4000-8000-0000000000bb";
const START = Date.UTC(2026, 10, 20, 9, 0, 0);

type Reply =
  | { kind: "answer"; status: number; body?: string }
  | { kind: "headers-never" } // the request reaches Auth and nothing ever comes back
  | { kind: "stall"; status: number; first: string } // headers and a first chunk, then nothing
  | { kind: "trickle"; status: number; everyMs: number } // one byte every `everyMs`
  | { kind: "error-body"; status: number } // headers, then the body errors
  | { kind: "oversized"; status: number } // a body over the 64 KB cap
  | { kind: "network" } // the fetch itself rejects
  | { kind: "delayed"; status: number; afterMs: number; body?: string }; // headers (and a whole body) after afterMs

interface Seen {
  path: string;
  bearer: string | null;
  body: string | null;
  aborted: () => boolean;
  bodyCancelled: boolean;
  bodyDone: boolean;
}

let seen: Seen[] = [];
let script: Reply[] = [];

function jwt(sub: string, expInS: number, sid = "sid-1") {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub, exp: Math.floor(START / 1000) + expInS, session_id: sid })}.${randomBytes(16).toString("base64url")}`;
}
/** A2: the lineage digest of an Auth session id, computed independently of the route (session-cookie-layout.ts). */
const lineage = (sid: string) => createHash("sha256").update(`swingproai-session-lineage:${sid}`).digest("hex");
const LINEAGE_A = lineage("sid-1");
/** The page's own End Session form for A's rendered session (A2: account and lineage). */
const FORM_A = `expected_user=${A_ID}&expected_session=${LINEAGE_A}`;
function sessionValue(sub = A_ID, pad = 0, sid = "sid-1") {
  return JSON.stringify({
    access_token: jwt(sub, 3600, sid),
    refresh_token: "synthetic-refresh-a",
    expires_at: Math.floor(START / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: sub, user_metadata: pad ? { padding: "p".repeat(pad) } : {} },
  });
}
const enc = (v: string) => encodeURIComponent(v);
const bare = (value = sessionValue()) => `${KEY}=${enc(value)}`;
const chunked = (value = sessionValue(A_ID, 6000)) =>
  createChunks(KEY, value).map((c: { name: string; value: string }) => `${c.name}=${enc(c.value)}`).join("; ");

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const signal = init?.signal ?? undefined;
  const entry: Seen = {
    path: `${url.pathname}${url.search}`,
    bearer: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? init.body : null,
    aborted: () => signal?.aborted ?? false,
    bodyCancelled: false,
    bodyDone: false,
  };
  seen.push(entry);
  const reply = script.shift() ?? { kind: "answer", status: 204 };
  let cancelTrickle = () => {};
  const stream = (start: (c: ReadableStreamDefaultController<Uint8Array>) => void) =>
    new ReadableStream<Uint8Array>({
      start,
      cancel() {
        entry.bodyCancelled = true;
        cancelTrickle();
      },
    });
  switch (reply.kind) {
    case "delayed":
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          if (!reply.body) return resolve(new Response(null, { status: reply.status }));
          resolve(new Response(stream((c) => { c.enqueue(new TextEncoder().encode(reply.body)); c.close(); entry.bodyDone = true; }), { status: reply.status }));
        }, reply.afterMs);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      });
    case "network":
      return Promise.reject(new TypeError("fetch failed"));
    case "headers-never":
      return new Promise<Response>(() => undefined); // honours nothing: the route must stop waiting by itself
    case "answer":
      if (!reply.body) return Promise.resolve(new Response(null, { status: reply.status }));
      return Promise.resolve(
        new Response(
          stream((c) => {
            c.enqueue(new TextEncoder().encode(reply.body));
            c.close();
            entry.bodyDone = true;
          }),
          { status: reply.status, headers: { "content-type": "application/json" } },
        ),
      );
    case "stall":
      return Promise.resolve(new Response(stream((c) => c.enqueue(new TextEncoder().encode(reply.first))), { status: reply.status }));
    case "trickle":
      return Promise.resolve(
        new Response(
          stream((c) => {
            const tick = () => {
              if (entry.bodyCancelled) return;
              c.enqueue(new TextEncoder().encode("x"));
              timer = setTimeout(tick, reply.everyMs);
            };
            let timer = setTimeout(tick, reply.everyMs);
            cancelTrickle = () => clearTimeout(timer);
          }),
          { status: reply.status },
        ),
      );
    case "error-body":
      return Promise.resolve(new Response(stream((c) => c.error(new Error("broken body"))), { status: reply.status }));
    case "oversized":
      return Promise.resolve(
        new Response(
          stream((c) => {
            c.enqueue(new Uint8Array(40 * 1024));
            c.enqueue(new Uint8Array(40 * 1024)); // still open: the reader must cancel it at the cap
          }),
          { status: reply.status },
        ),
      );
  }
}

/** `form` undefined: the page's own End Session form for the default carried account (A); null: no body at all. */
async function post(cookie: string | null, form: string | null | undefined = undefined, opts: { stallForm?: boolean; formAfterMs?: number; headers?: Record<string, string> } = {}) {
  if (form === undefined) form = FORM_A;
  const { POST } = await import("@/app/api/auth/signout/route");
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (cookie !== null) headers.cookie = cookie;
  let body: BodyInit | undefined;
  const streamed = opts.stallForm || opts.formAfterMs !== undefined;
  if (form !== null || streamed) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = opts.stallForm
      ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("expected_user=")); } })
      : opts.formAfterMs !== undefined
        ? new ReadableStream<Uint8Array>({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(form ?? "")); c.close(); }, opts.formAfterMs); } })
        : (form as string);
  }
  const init = { method: "POST", headers, body, ...(streamed ? { duplex: "half" } : {}) };
  const request = new NextRequest(`${APP}/api/auth/signout`, init as ConstructorParameters<typeof NextRequest>[1]);
  const started = Date.now();
  let settled = false;
  const answer = POST(request).then((r) => {
    settled = true;
    return r;
  });
  for (let t = 0; !settled && t < 20_000; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  }
  const response = await answer;
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  return { response, elapsed: Date.now() - started, text: await response.clone().text() };
}

/** The redirect's path (NextRequest presents a loopback 127.0.0.1 origin as localhost; the path is what matters). */
function where(response: Response): string | null {
  const location = response.headers.get("location");
  if (location === null) return null;
  expect(location.startsWith("/") && !location.startsWith("//")).toBe(true); // relative: always this page's own origin
  return new URL(location, APP).pathname;
}
/** A3 review: the honest "nothing was ended" answer for a mixed jar — fixed copy, no retry form, no cookie. */
function otherSignInPage(response: Response, text: string) {
  expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([409, null, "private, no-store"]);
  expect(text).toContain("<h1>Your session wasn't ended</h1>");
  expect(text).toContain("didn't match the session you asked to end, so nothing was ended here.");
  expect(text).toContain('<a href="/dashboard">Back to dashboard</a>');
  expect(text).not.toContain("<form");
  noCookieWritten(response);
}
function noCookieWritten(response: Response) {
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.getSetCookie?.() ?? []).toEqual([]);
}
/** A4 (C2): the honest "could not confirm" answer — fixed copy, 409, no retry form, no END INTENT or any other cookie. */
function unconfirmedPage(response: Response, text: string) {
  expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([409, null, "private, no-store"]);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(text).toContain("<h1>We couldn't confirm your session was ended</h1>");
  expect(text).toContain('<p role="status">We couldn\'t confirm that the requested sign-in was ended. Nothing more was sent to the sign-in service. Open the dashboard to see whether you\'re still signed in on this device.</p>');
  expect(text).toContain('<a href="/dashboard">Back to dashboard</a>');
  expect(text).not.toContain("<form");
  expect(text).not.toContain("window.location");
  noCookieWritten(response);
}
/**
 * A5 (E1): the honest answer to a post that names no sign-in (the previous bundle's End Session form posts no field) —
 * 409, fixed copy, a link to the dashboard, no retry form, no script, no cookie of any kind.
 */
function outdatedPage(response: Response, text: string) {
  expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([409, null, "private, no-store"]);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(text).toContain("<h1>Your session wasn't ended</h1>");
  expect(text).toContain(
    "<p role=\"status\">This page didn't say which sign-in to end (it may be from an earlier version of SwingProAI), so nothing was ended. Open the dashboard to see which account is signed in on this device, then use End Session there.</p>",
  );
  expect(text).toContain('<a href="/dashboard">Back to dashboard</a>');
  expect(text).not.toContain("<form");
  expect(text).not.toContain("<script");
  expect(text).not.toMatch(/signed out|Your session was ended|session has ended/i);
  noCookieWritten(response);
}
/**
 * A2: the honest "ended at the sign-in service" page and its single Set-Cookie: the END INTENT naming exactly `id` —
 * short-lived, readable by the page's own script (not HttpOnly), never a session or binding cookie, never a removal.
 */
function endedAtServer(response: Response, text: string, id = LINEAGE_A, secure = false) {
  expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([200, null, "private, no-store"]);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(text).toContain("<h1>Your session was ended</h1>");
  expect(text).toContain('<p role="status">The sign-in service confirmed your session has ended. This device still holds a copy of it until the sign-in page removes it.</p>');
  expect(text).toContain("<noscript><p>JavaScript is off, so the sign-in page can't remove that copy.");
  expect(text).toContain('<a href="/login">Continue to sign in</a>');
  expect(text).toContain('<script>window.location.replace("/login")</script>');
  const cookies = response.headers.getSetCookie();
  expect(cookies).toEqual([`swingproai-session-ended=${id}; Path=/; Max-Age=2592000; SameSite=Lax${secure ? "; Secure" : ""}`]);
  expect(cookies[0]).not.toMatch(/HttpOnly|sb-|auth-token|binding|Max-Age=0/i);
}
/** Every Auth request this answer made is over: aborted, and its body read whole or cancelled. */
function nothingLeftOver() {
  for (const s of seen) expect(s.aborted()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
}

/**
 * A2: the route digests the carried token's session id (WebCrypto SHA-256), which Node computes on its thread pool; that
 * real latency would let the fake clock run on while it is pending and blur the exact bounds below. The same SHA-256 is
 * served from node:crypto in a microtask instead (identical bytes; every other crypto member is the platform's).
 */
function installMicrotaskDigest() {
  const platform = globalThis.crypto;
  const subtle = {
    digest: (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return Promise.resolve(Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer);
    },
  };
  vi.stubGlobal("crypto", Object.create(platform, { subtle: { value: subtle } }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: START });
  installMicrotaskDigest();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key-not-a-secret");
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  seen = [];
  script = [];
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("answers and the passive contract (no Set-Cookie on any answer)", () => {
  it("no session cookie: 303 /login, no Auth request, nothing written", async () => {
    const { response } = await post(null);
    expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([303, "/login", "private, no-store"]);
    expect(seen).toEqual([]);
    noCookieWritten(response);
  });

  for (const [label, cookie] of [
    ["bare beside chunks", `${bare()}; ${chunked()}`],
    ["a gap in the chunks", `${KEY}.0=x; ${KEY}.2=y`],
    ["a malformed member (.00)", `${KEY}.00=${enc(sessionValue())}`],
    ["a duplicated name", `${bare()}; ${bare()}`],
    ["an empty value", `${KEY}=`],
  ] as const) {
    it(`an ambiguous jar (${label}) holds no session for anyone: 303 /login, no Auth request, nothing removed`, async () => {
      const { response } = await post(cookie);
      expect([response.status, where(response)]).toEqual([303, "/login"]);
      expect(seen).toEqual([]);
      noCookieWritten(response);
    });
  }

  for (const [label, cookie] of [
    ["a bare session", bare()],
    ["a chunked session with the verifier and user roots", `${chunked()}; ${KEY}-code-verifier=v; ${KEY}-user=u`],
  ] as const) {
    it(`${label}, healthy Auth: one logout?scope=local with the carried token; the honest ended page and the END INTENT, NO cookie removed`, async () => {
      script = [{ kind: "answer", status: 204 }];
      const { response, text } = await post(cookie, FORM_A);
      endedAtServer(response, text);
      expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local"]);
      expect(seen[0].bearer).toMatch(/^Bearer ey/);
      expect(text).not.toMatch(/ey[A-Za-z0-9_-]{10}|synthetic-refresh/);
      nothingLeftOver();
    });
  }

  it("the carried session belongs to another account than the page showed: 303 /dashboard, no Auth request", async () => {
    const { response } = await post(bare(sessionValue(B_ID)), FORM_A);
    expect([response.status, where(response)]).toEqual([303, "/dashboard"]);
    expect(seen).toEqual([]);
    noCookieWritten(response);
  });

  it("A2: a newer sign-in of the SAME account (another lineage) is never ended by a delayed or replayed post: 303 /dashboard, no Auth request", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response } = await post(bare(sessionValue(A_ID, 0, "sid-2")), FORM_A);
    expect([response.status, where(response), seen.length]).toEqual([303, "/dashboard", 0]);
    noCookieWritten(response);
  });

  it("A2/A5: a form naming the account but no lineage (a page from before it was named) ends nothing: the honest outdated-page answer, no Auth request", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response, text } = await post(bare(), `expected_user=${A_ID}`);
    outdatedPage(response, text);
    expect(seen.length).toBe(0);
  });

  it("A5: a form naming a lineage but no account ends nothing either: the honest outdated-page answer, no Auth request", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response, text } = await post(bare(), `expected_session=${LINEAGE_A}`);
    outdatedPage(response, text);
    expect(seen.length).toBe(0);
  });

  // A5 (E1): exactly what the previous bundle's End Session control sends — a plain form with no field: a url-encoded
  // content type and an EMPTY body — carrying the jar's session, whichever sign-in that is, and however expired it is
  for (const [label, cookie] of [
    ["the same sign-in the old page showed, its access token expired", bare(JSON.stringify({ ...JSON.parse(sessionValue()), access_token: jwt(A_ID, -60) }))],
    ["another account's newer sign-in (B), expired", bare(JSON.stringify({ ...JSON.parse(sessionValue(B_ID)), access_token: jwt(B_ID, -60) }))],
    ["a newer sign-in of the same account (another lineage)", bare(sessionValue(A_ID, 0, "sid-2"))],
    ["a chunked session", chunked()],
  ] as const) {
    it(`A5: the previous bundle's field-less form carrying ${label}: the honest outdated-page answer; nothing revoked, refreshed, verified or written`, async () => {
      script = [{ kind: "answer", status: 204 }];
      const { response, text } = await post(cookie, "");
      outdatedPage(response, text);
      expect(seen).toEqual([]);
      nothingLeftOver();
    });
  }

  it("A5 review: the same field-less post from another site, a form naming only A while the jar holds B, and a non-form body: each the honest outdated-page answer, no Auth request", async () => {
    script = [{ kind: "answer", status: 204 }, { kind: "answer", status: 204 }, { kind: "answer", status: 204 }];
    const crossSite = await post(bare(), "", { headers: { "sec-fetch-site": "cross-site", origin: "https://elsewhere.example" } });
    outdatedPage(crossSite.response, crossSite.text);
    const onlyUser = await post(bare(sessionValue(B_ID)), `expected_user=${A_ID}`);
    outdatedPage(onlyUser.response, onlyUser.text);
    const { POST } = await import("@/app/api/auth/signout/route");
    const plain = await POST(new NextRequest(`${APP}/api/auth/signout`, { method: "POST", headers: { cookie: bare(), "content-type": "text/plain" }, body: FORM_A }));
    outdatedPage(plain, await plain.clone().text());
    expect(seen).toEqual([]);
  });

  it("A5 review: the route module exports POST only (no GET or HEAD handler that could end a session)", async () => {
    const route = (await import("@/app/api/auth/signout/route")) as Record<string, unknown>;
    expect(Object.keys(route).filter((k) => /^(GET|HEAD|PUT|PATCH|DELETE|OPTIONS)$/.test(k))).toEqual([]);
    expect(typeof route.POST).toBe("function");
  });

  it("A5: the previous bundle's field-less form with no usable session in the jar: nothing to end, 303 /login (unchanged)", async () => {
    const { response } = await post(null, "");
    expect([response.status, where(response)]).toEqual([303, "/login"]);
    expect(seen).toEqual([]);
    noCookieWritten(response);
  });

  it("A2: an expected_session that is not a lineage digest is unreadable: nothing is revoked, the honest 503 page", async () => {
    const { response, text } = await post(bare(), `expected_user=${A_ID}&expected_session=sid-1`);
    expect([response.status, seen.length, text.includes("Your session wasn't ended")]).toEqual([503, 0, true]);
    noCookieWritten(response);
  });

  it("A5 review: an unreadable request's honest page offers no retry form (a retry naming no account or lineage would only meet the outdated-page answer) — the dashboard instead", async () => {
    for (const form of [`expected_user=${A_ID}&expected_session=sid-1`, "expected_user=not-a-user-id", `pad=${"x".repeat(5000)}&${FORM_A}`]) {
      const { response, text } = await post(bare(), form);
      expect(response.status).toBe(503);
      expect(text).toContain("We couldn't read your End Session request in full, so nothing was changed and you may still be signed in on this device. Please go back to the dashboard and try End Session again.");
      expect(text).not.toContain("<form");
      expect(text).toContain('<a href="/dashboard">Back to dashboard</a>');
      noCookieWritten(response);
    }
    expect(seen).toEqual([]);
  });

  it("A2: a session whose token states no session id cannot be matched to a lineage: nothing is revoked", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const noSid = JSON.stringify({
      access_token: `${b64({ alg: "HS256" })}.${b64({ sub: A_ID, exp: Math.floor(START / 1000) + 3600 })}.x`,
      refresh_token: "synthetic-refresh-a", expires_at: Math.floor(START / 1000) + 3600, expires_in: 3600, user: { id: A_ID },
    });
    const { response } = await post(bare(noSid), FORM_A);
    expect([response.status, where(response), seen.length]).toEqual([303, "/dashboard", 0]);
  });

  it("A2: the END INTENT is Secure behind an HTTPS proxy (x-forwarded-proto), and names only the revoked lineage", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { POST } = await import("@/app/api/auth/signout/route");
    const request = new NextRequest(`${APP}/api/auth/signout`, {
      method: "POST",
      headers: { cookie: bare(), "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
      body: FORM_A,
    });
    let settled = false;
    const answer = POST(request).then((r) => { settled = true; return r; });
    for (let t = 0; !settled && t < 5_000; t += 50) {
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    }
    const response = await answer;
    endedAtServer(response, await response.clone().text(), LINEAGE_A, true);
  });

  it("A2: a cookieless post whose end_state says Auth did not confirm the browser's revocation gets the honest local-only page (display only); any other is 303 /login", async () => {
    const SAME = { headers: { "sec-fetch-site": "same-origin" } };
    const unconfirmed = await post(null, `${FORM_A}&end_state=ended_unconfirmed`, SAME);
    expect([unconfirmed.response.status, where(unconfirmed.response)]).toEqual([200, null]);
    expect(unconfirmed.text).toContain("<h1>You're signed out on this device</h1>");
    expect(unconfirmed.text).toContain(
      "Your session was removed from this browser, but we couldn't reach the sign-in service to confirm it was ended there as well.",
    );
    expect(unconfirmed.text).toContain('<a href="/login">Continue to sign in</a>');
    noCookieWritten(unconfirmed.response);
    for (const form of [`${FORM_A}&end_state=ended`, `${FORM_A}&end_state=anything`, null]) {
      const { response } = await post(null, form, SAME);
      expect([response.status, where(response)]).toEqual([303, "/login"]);
      noCookieWritten(response);
    }
    expect(seen).toEqual([]);
  });

  it("A2 review: end_state is shown only for this site's own page: a cross-site (or unmarked, foreign-origin) post gets 303 /login, never the signed-out page", async () => {
    const variants: Array<Record<string, string>> = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" }, { origin: "https://elsewhere.example" }, {}];
    for (const headers of variants) {
      const { response, text } = await post(null, `${FORM_A}&end_state=ended_unconfirmed`, { headers });
      expect([response.status, where(response)]).toEqual([303, "/login"]);
      expect(text).not.toContain("signed out on this device");
      noCookieWritten(response);
    }
    // a browser that sends no Sec-Fetch-Site: shown only when Origin is this request's own (NextRequest names a loopback
    // 127.0.0.1 origin as localhost)
    const { response, text } = await post(null, `${FORM_A}&end_state=ended_unconfirmed`, { headers: { origin: new URL(APP).origin.replace("127.0.0.1", "localhost") } });
    expect([response.status, text.includes("signed out on this device")]).toEqual([200, true]);
    expect(seen).toEqual([]);
  });

  it("A2: an end_state on a post that carries the session changes nothing about the revocation (display only)", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response, text } = await post(bare(), `${FORM_A}&end_state=ended_unconfirmed`);
    endedAtServer(response, text);
    expect(seen.length).toBe(1);
  });

  for (const [label, form] of [
    ["a form read whole without expected_user (a page from before the field existed)", "other=1"],
    ["a request with no form body at all", null],
  ] as const) {
    it(`${label}: which account was meant is unnamed, so nothing is ended (the carried session may be a later sign-in's); A5: the honest outdated-page answer, no Auth request`, async () => {
      script = [{ kind: "answer", status: 204 }];
      const { response, text } = await post(bare(sessionValue(B_ID)), form);
      outdatedPage(response, text);
      expect(seen.length).toBe(0);
    });
  }

  it("logout 404 (nothing to revoke): ended, the honest ended page", async () => {
    script = [{ kind: "answer", status: 404, body: '{"code":"user_not_found"}' }];
    const { response, text } = await post(bare());
    endedAtServer(response, text);
  });

  it("logout 401 (expired token): one refresh with the carried refresh token, then logout with ITS access token; the new tokens never leave the server", async () => {
    const fresh = jwt(A_ID, 3600);
    script = [
      { kind: "answer", status: 401, body: '{"code":"bad_jwt"}' },
      { kind: "answer", status: 200, body: JSON.stringify({ access_token: fresh, refresh_token: "synthetic-refresh-a2", expires_in: 3600, token_type: "bearer" }) },
      { kind: "answer", status: 204 },
    ];
    const { response, text } = await post(bare());
    expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local", "/auth/v1/token?grant_type=refresh_token", "/auth/v1/logout?scope=local"]);
    expect(JSON.parse(seen[1].body ?? "{}")).toEqual({ refresh_token: "synthetic-refresh-a" });
    expect(seen[2].bearer).toBe(`Bearer ${fresh}`);
    endedAtServer(response, text);
    expect(text.includes(fresh) || text.includes("synthetic-refresh-a2")).toBe(false);
    expect(JSON.stringify(Array.from(response.headers.entries()))).not.toContain("synthetic-refresh-a2");
    expect(JSON.stringify(Array.from(response.headers.entries()))).not.toContain(fresh);
    nothingLeftOver();
  });

  // A3 (F3): the envelope carries its refresh token apart from its access token. A jar mixing two sign-ins — A's expired
  // access token (it passes the account and lineage checks) with another sign-in's refresh token — must never have that
  // other sign-in logged out: the refreshed session is checked against the form's account AND lineage first.
  /** A carried session: A's access token (lineage A, so the form's checks pass) with `refresh` as its refresh token. */
  const mixed = (refresh: string) =>
    bare(JSON.stringify({ ...JSON.parse(sessionValue()), refresh_token: refresh }));
  const refreshedAs = (sub: string | null, sid: string | null) => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims: Record<string, unknown> = { exp: Math.floor(START / 1000) + 3600 };
    if (sub !== null) claims.sub = sub;
    if (sid !== null) claims.session_id = sid;
    const token = `${b64({ alg: "HS256" })}.${b64(claims)}.${randomBytes(16).toString("base64url")}`;
    return { token, body: JSON.stringify({ access_token: token, refresh_token: `synthetic-rotated-${randomBytes(4).toString("hex")}`, expires_in: 3600, token_type: "bearer" }) };
  };
  for (const [label, sub, sid] of [
    ["another account's (expired A access + B refresh)", B_ID, "sid-b"],
    ["a newer sign-in of the SAME account (A's later lineage)", A_ID, "sid-newer"],
    ["a session naming no session id (its lineage cannot be computed)", A_ID, null],
    ["a session naming no account", null, "sid-1"],
  ] as const) {
    it(`A3: logout 401, and the refresh returns ${label}: NO second logout targets it; the honest 409 "nothing was ended" page (no retry form), nothing written, no END INTENT`, async () => {
      const other = refreshedAs(sub, sid);
      script = [
        { kind: "answer", status: 401, body: '{"code":"bad_jwt"}' },
        { kind: "answer", status: 200, body: other.body },
        { kind: "answer", status: 204 }, // would confirm a second logout if one were (wrongly) sent
      ];
      const { response, text } = await post(mixed("synthetic-refresh-other"));
      // exactly two Auth requests: A's logout, then the one refresh — whose supplied token may now be rotated at Auth
      expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local", "/auth/v1/token?grant_type=refresh_token"]);
      expect(JSON.parse(seen[1].body ?? "{}")).toEqual({ refresh_token: "synthetic-refresh-other" });
      expect(seen.some((s) => s.bearer === `Bearer ${other.token}`)).toBe(false);
      otherSignInPage(response, text);
      expect(text.includes(other.token)).toBe(false);
      nothingLeftOver();
    });
  }

  // A4 (C2): a refresh REFUSED as gone states no lineage. The carried refresh token is opaque and carried apart from the
  // access token, so after A's logout was refused (401/403) its gone refusal may describe B's — or a newer A sign-in's —
  // spent token: it proves nothing about A. The answer is UNCONFIRMED: fixed copy, 409, no END INTENT, no retry form, no
  // cookie, no second logout (no token to send one with). (The A3 test that pinned "ended" here is retired.)
  for (const [label, refresh] of [
    ["expired A access + another account's (B's) gone refresh token", "synthetic-refresh-b-gone"],
    ["expired A access + a NEWER same-account sign-in's gone refresh token", "synthetic-refresh-a-newer-gone"],
    ["expired A access + A's own refresh token, refused as gone (indistinguishable here)", "synthetic-refresh-a"],
  ] as const) {
    // A4 review (security finding 2): every refusal — gone, already used, or uncoded — is unconfirmed (Auth answered)
    for (const code of ["refresh_token_not_found", "session_not_found", "session_expired", "refresh_token_already_used", null]) {
      for (const first of [401, 403]) {
        it(`A4 C2: logout ${first}, refresh refused (${code ?? "uncoded"}) — ${label}: UNCONFIRMED (409, fixed copy, no END INTENT, no second logout)`, async () => {
          script = [
            { kind: "answer", status: first },
            { kind: "answer", status: 400, body: code === null ? '{"msg":"synthetic uncoded refusal"}' : JSON.stringify({ code }) },
            { kind: "answer", status: 204 }, // would confirm a second logout if one were (wrongly) sent
          ];
          const { response, text } = await post(mixed(refresh));
          // exactly two Auth requests: A's logout with A's access token, then the one refresh with the carried token
          expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local", "/auth/v1/token?grant_type=refresh_token"]);
          expect(seen[0].bearer?.startsWith("Bearer ")).toBe(true);
          expect(JSON.parse(seen[1].body ?? "{}")).toEqual({ refresh_token: refresh });
          unconfirmedPage(response, text);
          expect(text).not.toContain("Your session was ended");
          expect(text).not.toContain(refresh);
          nothingLeftOver();
        });
      }
    }
  }

  it("A4 C2 control: a rate-limited refresh (429) is not a refusal — the honest 'not ended' 503 with its retry form, never unconfirmed or ended", async () => {
    script = [{ kind: "answer", status: 401 }, { kind: "answer", status: 429, body: '{"code":"over_request_rate_limit"}' }];
    const { response, text } = await post(mixed("synthetic-refresh-b-limited"));
    expect(seen.length).toBe(2);
    expect(response.status).toBe(503);
    expect(text).toContain("Your session wasn't ended");
    expect(text).toContain('action="/api/auth/signout" method="POST"');
    noCookieWritten(response);
    nothingLeftOver();
  });

  it("A4 C2 control: logout confirmed directly (204) still gets the ended page and A's END INTENT with ONE request (no refresh)", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response, text } = await post(mixed("synthetic-refresh-b-gone"));
    expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local"]);
    endedAtServer(response, text);
    nothingLeftOver();
  });

  it("A3 control: a refresh that returns the SAME lineage still logs out with its access token (the honest ended page)", async () => {
    const same = refreshedAs(A_ID, "sid-1");
    script = [
      { kind: "answer", status: 403 },
      { kind: "answer", status: 200, body: same.body },
      { kind: "answer", status: 204 },
    ];
    const { response, text } = await post(mixed("synthetic-refresh-a"));
    expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local", "/auth/v1/token?grant_type=refresh_token", "/auth/v1/logout?scope=local"]);
    expect(seen[2].bearer).toBe(`Bearer ${same.token}`);
    endedAtServer(response, text);
    nothingLeftOver();
  });

  it("A3: a slow mismatched refresh (whole body at 1.9 s) still sends no second logout, inside the budget; and an unattributable one (a token that is not a JWT) is refused the same way", async () => {
    const other = refreshedAs(B_ID, "sid-b");
    script = [
      { kind: "answer", status: 401 },
      { kind: "delayed", status: 200, afterMs: 1_900, body: other.body },
      { kind: "answer", status: 204 },
    ];
    const { response, elapsed, text } = await post(mixed("synthetic-refresh-other"));
    expect(seen.length).toBe(2);
    otherSignInPage(response, text);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThanOrEqual(2_000);
    nothingLeftOver();
    seen = [];
    script = [{ kind: "answer", status: 401 }, { kind: "answer", status: 200, body: '{"access_token":"not-a-jwt","refresh_token":"r","expires_in":3600}' }];
    const malformed = await post(mixed("synthetic-refresh-other"));
    expect(seen.length).toBe(2); // nothing is ever sent with a token whose account and lineage cannot be read
    otherSignInPage(malformed.response, malformed.text);
    nothingLeftOver();
  });

  it("A4 C2 (was: 'the session is ended'): logout 403, refresh refused as gone (refresh_token_not_found) for an unmixed jar — still UNCONFIRMED: the route cannot tell whose refresh token was gone", async () => {
    script = [{ kind: "answer", status: 403, body: "{}" }, { kind: "answer", status: 400, body: '{"code":"refresh_token_not_found"}' }];
    const { response, text } = await post(bare());
    unconfirmedPage(response, text);
    expect(seen.length).toBe(2);
  });

  for (const [label, replies] of [
    ["logout 503", [{ kind: "answer", status: 503 }]],
    ["logout 500", [{ kind: "answer", status: 500, body: '{"msg":"provider text"}' }]],
    ["logout 429", [{ kind: "answer", status: 429 }]],
    ["logout network failure", [{ kind: "network" }]],
    ["logout 401, refresh rate-limited (429)", [{ kind: "answer", status: 401 }, { kind: "answer", status: 429 }]],
    ["logout 401, refresh 500", [{ kind: "answer", status: 401 }, { kind: "answer", status: 500 }]],
    ["logout 401, refresh 200 without a session", [{ kind: "answer", status: 401 }, { kind: "answer", status: 200, body: "{}" }]],
  ] as [string, Reply[]][]) {
    it(`${label}: NOT ended — an honest 503 page (no redirect, no provider text, retry form keeps the account), no cookie written`, async () => {
      script = replies;
      const { response, text } = await post(bare(), FORM_A);
      expect([response.status, where(response), response.headers.get("cache-control")]).toEqual([503, null, "private, no-store"]);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(text).toContain("Your session wasn't ended");
      expect(text).toContain(`name="expected_user" value="${A_ID}"`);
      expect(text).toContain(`name="expected_session" value="${LINEAGE_A}"`); // A2: the retry names the same lineage
      expect(text).toContain('action="/api/auth/signout" method="POST"');
      expect(text).not.toContain("provider text");
      expect(seen.length).toBeLessThanOrEqual(3);
      noCookieWritten(response);
      nothingLeftOver();
    });
  }
});

describe("full-body deadlines (F3): one budget for headers and body; nothing outlives the answer", () => {
  it("logout headers never arrive: given up at 2 s (the platform fetch is not even relied on to honour the abort); 503", async () => {
    script = [{ kind: "headers-never" }];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThanOrEqual(2_100);
    nothingLeftOver();
  });

  it("refresh answers 200 headers and then stalls: the body is cut off at the exchange's 2 s, cancelled, and never read as whole; 503 within the 6 s budget", async () => {
    script = [{ kind: "answer", status: 401 }, { kind: "stall", status: 200, first: '{"access_token":"' }];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503);
    expect(seen.map((s) => s.path)).toEqual(["/auth/v1/logout?scope=local", "/auth/v1/token?grant_type=refresh_token"]);
    expect(seen[1].bodyCancelled).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThanOrEqual(2_100);
    nothingLeftOver();
  });

  it("a trickling refresh body (one byte every 300 ms) is cut off at 2 s and cancelled", async () => {
    script = [{ kind: "answer", status: 401 }, { kind: "trickle", status: 200, everyMs: 300 }];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503);
    expect(seen[1].bodyCancelled).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(2_100);
    nothingLeftOver();
  });

  it("an erroring refresh body: not ended, 503, at once", async () => {
    script = [{ kind: "answer", status: 401 }, { kind: "error-body", status: 200 }];
    const { response, elapsed } = await post(bare());
    expect([response.status, elapsed < 200]).toEqual([503, true]);
    nothingLeftOver();
  });

  it("an oversized refresh body (over 64 KB): cancelled at the cap, 503", async () => {
    script = [{ kind: "answer", status: 401 }, { kind: "oversized", status: 200 }];
    const { response } = await post(bare());
    expect(response.status).toBe(503);
    expect(seen[1].bodyCancelled).toBe(true);
    nothingLeftOver();
  });

  it("three slow exchanges share the 6 s revocation budget: never more than 6 s of Auth time, never a fourth request", async () => {
    const fresh = jwt(A_ID, 3600);
    // each answer takes 1.9 s: 1.9 + 1.9 + 1.9 = 5.7 s fits; the answers below are timed by the stand-in
    script = [
      { kind: "headers-never" },
      { kind: "headers-never" },
    ];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503);
    expect(seen.length).toBe(1); // the first logout never answered: nothing to refresh for
    expect(elapsed).toBeLessThanOrEqual(2_100);
    seen = [];
    script = [
      { kind: "answer", status: 401 },
      { kind: "answer", status: 200, body: JSON.stringify({ access_token: fresh, refresh_token: "r2", expires_in: 3600 }) },
      { kind: "headers-never" },
    ];
    const second = await post(bare());
    expect(second.response.status).toBe(503);
    expect(seen.length).toBe(3);
    expect(second.elapsed).toBeLessThanOrEqual(2_100);
    nothingLeftOver();
  });

  it("a form body that never completes is given up at its own 3 s: which account was meant is unknown, so NOTHING is revoked (the carried session may be another sign-in's); the honest 503 page", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response, elapsed, text } = await post(bare(sessionValue(B_ID)), null, { stallForm: true });
    expect([response.status, text.includes("Your session wasn't ended")]).toEqual([503, true]);
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThanOrEqual(3_100);
    expect(seen).toEqual([]);
    noCookieWritten(response);
    nothingLeftOver();
  });

  it("a form body over 4 KB is unreadable: nothing is revoked (the carried session here is B's while the page named A); the honest 503 page", async () => {
    script = [{ kind: "answer", status: 204 }];
    const { response } = await post(bare(sessionValue(B_ID)), `pad=${"x".repeat(5000)}&${FORM_A}`);
    expect([response.status, seen.length]).toEqual([503, 0]);
  });

  it("an expected_user that is not a user id is unreadable too: nothing is revoked", async () => {
    const { response } = await post(bare(), "expected_user=not-a-user-id");
    expect([response.status, seen.length]).toEqual([503, 0]);
  });

  it("the revocation budget is shared: logout 401 at 1.9 s, refresh 200 at 1.9 s, the second logout never answers and is cut at the 2 s dispatch bound; 6 s in all, never a fourth request", async () => {
    const fresh = jwt(A_ID, 3600);
    script = [
      { kind: "delayed", status: 401, afterMs: 1_900 },
      { kind: "delayed", status: 200, afterMs: 1_900, body: JSON.stringify({ access_token: fresh, refresh_token: "r2", expires_in: 3600 }) },
      { kind: "headers-never" },
    ];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503);
    expect(seen.length).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(5_700);
    expect(elapsed).toBeLessThanOrEqual(6_000);
    nothingLeftOver();
  });

  it("the revocation budget caps a dispatch that would run past it: three answers at 1.99 s each leave the third only the 6 s remainder", async () => {
    const fresh = jwt(A_ID, 3600);
    script = [
      { kind: "delayed", status: 401, afterMs: 1_990 },
      { kind: "delayed", status: 200, afterMs: 1_990, body: JSON.stringify({ access_token: fresh, refresh_token: "r2", expires_in: 3600 }) },
      { kind: "delayed", status: 204, afterMs: 2_500 },
    ];
    const { response, elapsed } = await post(bare());
    expect(response.status).toBe(503); // the third answer would land after the budget: not confirmed
    expect(elapsed).toBeLessThanOrEqual(6_050);
    expect(elapsed).toBeGreaterThanOrEqual(5_900);
    nothingLeftOver();
  });

  it("the worst case of every bound together: a form body read whole at 2.9 s, then a revocation that uses its whole 6 s; answered within 9 s of arrival", async () => {
    const fresh = jwt(A_ID, 3600);
    script = [
      { kind: "delayed", status: 401, afterMs: 1_950 },
      { kind: "delayed", status: 200, afterMs: 1_950, body: JSON.stringify({ access_token: fresh, refresh_token: "r2", expires_in: 3600 }) },
      { kind: "headers-never" },
    ];
    const { response, elapsed } = await post(bare(), FORM_A, { formAfterMs: 2_900 });
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(8_700);
    expect(elapsed).toBeLessThanOrEqual(9_000);
    nothingLeftOver();
  });
});
