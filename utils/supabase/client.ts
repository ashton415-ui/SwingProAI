import { createBrowserClient } from "@supabase/ssr";
import { jwtClaims, readEnvelope, sessionCookieKey, type SessionEnvelope } from "@/utils/supabase/session-cookie-layout";
import {
  NO_SESSION_LINEAGE,
  activeSection,
  configureLease,
  enterRefresh,
  finishRefresh,
  lineageDigest,
  noticeDispatched,
  observedLatest,
  readLineageRecord,
  refreshCallSettled,
  tenureAdmits,
} from "@/utils/supabase/session-lease";
import {
  countSessionOutcome,
  createSessionStorage,
  readStoredSession,
  recordContinuation,
  recordRefusal,
  sectionChangeUnrecorded,
  sessionRefusedByBinding,
  storedJarView,
} from "@/utils/supabase/session-storage";

// The browser client. Its session storage is utils/supabase/session-storage.ts (layout-managed cookies, every change
// a compare-and-set inside a section of utils/supabase/session-lease.ts). The SDK runs lockless, as installed
// (auth-js 2.107 uses its lock only when one is supplied); exclusion across tabs is the session-publication lease,
// taken here for each refresh request and by the storage for each change.
//
// Session refresh (POST <project URL>/auth/v1/token?grant_type=refresh_token). The refresh token in the request body
// the SDK built — the session the SDK actually selected, on every attempt and on explicit-token paths alike — is the
// origin of the request. Inside a refresh section (or the publish/end section that admits that token):
// - The jar is read before anything is sent. If it no longer holds that token, nothing is sent: another tab already
//   rotated it, or another sign-in replaced it, or End Session removed it. The SDK is answered with what the jar
//   holds — the stored session repeated as a token answer (no request, no new credential), so it converges on the
//   stored session, or a local "session_not_found" refusal for an empty jar, whose removal then removes nothing.
// - After the answer's body is read, the jar is read again; an answer for a session the jar no longer holds is
//   answered the same way instead. Only then is a refusal or a session handed to the SDK, with a record of the
//   origin, and the section stays held until the storage sees the SDK's commit (the new token saved, or the refused
//   session removed), so nothing else changes the jar between this check and that commit.
// - 2xx: read whole (64 KB, 3 s); a body that is not a session (access_token, refresh_token, expires_in) is a
//   retryable 503 here, never the SDK's AuthSessionMissingError removal.
// The R2 refresh-answer policy is unchanged:
// - 429 or any 5xx: the SDK gets a bodiless 503, which it retries and then reports as an error without removing the
//   stored session. A cooldown follows, from the latest such answer: the Retry-After wait (delay-seconds or an
//   HTTP-date) when the browser lets this code read it, never less than 30 s and never more than 1 h, timed on the
//   monotonic clock. During it, refresh attempts (the SDK's own retries, its ticker, any session read) get the same 503
//   here and nothing is sent, so one real refresh request leaves this client per cooldown. One exception keeps the
//   SDK's own recovery: after an answer it already retried before (502-504, 520-524, 530) without a readable
//   Retry-After, its retries in the first 8 s of the outage still go out, as they always did, so an answer lost after
//   Auth rotated the token is retried inside Auth's refresh-token reuse interval (10 s by default). The outage ends with
//   a refresh answer that is not a 429/5xx, or a 2xx for any other grant; an outage this client has not tried to refresh through for a minute past
//   its cooldown is over too, so a later, separate failure again gets the SDK's 8 s of retries. Retry-After is not a
//   CORS-safelisted header: a cross-origin answer exposes it only through Access-Control-Expose-Headers; otherwise the
//   30 s floor applies.
// - any other 4xx, coded or not: the SDK gets the same status and the error code it would have read itself (`code`
//   from API version 2024-01-01 on, else `error_code`; forwarded only in the snake_case form Auth's codes have) under a
//   fixed message, so it ends the session exactly as before, without the answer's own text. The body read is capped at
//   16 KB and 3 s; a longer, slower or unreadable body gives the same answer without a code.
// - A rejected fetch (a network failure, an answer CORS withholds, or one dispatch over 6 s) passes through as before:
//   auth-js retries it itself.
// End Session (utils/supabase/session-publication.ts) runs the SDK's own signOut inside an end section. There, a refresh
// or logout (POST <project URL>/auth/v1/logout) that Auth does not complete — a 429/5xx, a rejected fetch, a dispatch
// over its time, or the cooldown — is answered locally with a 401 "session_not_found", so the SDK ends the session in
// this browser and announces SIGNED_OUT; whether Auth revoked it is counted. A3: a refresh answer there is handed to
// the SDK (which then logs out with it) only when its access token names the Auth session the end permit ends; any
// other — the jar's refresh token was another sign-in's — is answered the same local way, so no logout targets it (the
// refresh may already have rotated that sign-in's refresh token at Auth). Outside an end section a logout passes
// through untouched. A section whose view of the jar is not current (session-lease.ts: lineage) sends nothing: 503, or
// the local end inside End Session. No token, cookie or body is logged.
//
// Identity announcements (the event fence). The SDK announces TOKEN_REFRESHED, SIGNED_IN, SIGNED_OUT … to this tab's
// subscribers and posts them to other tabs (BroadcastChannel); supabase-js's own subscriber hands a TOKEN_REFRESHED or
// SIGNED_IN token to its realtime client. An announcement can describe a session the browser no longer holds: another
// tab's, delivered late; one computed from a read made before another tab published; a SIGNED_OUT after a removal this
// storage skipped. So every announcement — this tab's own and every one received from another tab — is checked against
// what the browser holds when it is delivered, and an announcement that no longer describes it is dropped (counted),
// for every subscriber including realtime. An announcement made inside this tab's held, trusted section is checked
// against the jar directly (no other tab can change it then): a session-bearing event only while the jar holds that
// session's refresh token, SIGNED_OUT only while it holds no usable session, and nothing from a section whose change
// was not recorded. Any other announcement is checked against the recorded lineage (session-lease.ts), in arrival
// order: the announced session's lineage digest is computed FIRST, then the record is read afresh, and the decision is
// made synchronously, immediately before the dispatch, against the newest lineage this tab has seen by then
// (observedLatest: it never moves backwards). So an announcement is delivered only while its session — or, for
// SIGNED_OUT, "no session" — is the latest recorded lineage this tab knows of: a publication recorded while its check
// was still computing a digest, or seen by any other read in this tab, makes it obsolete. Where nothing has been
// recorded in this browser yet (before its first publication), the jar decides. Where the lineage cannot be read or
// the digest computed, nothing is delivered (fail closed; counted). A subscriber's INITIAL_SESSION carrying a session
// that fails the same check — or whose read the storage refused as unverified — is delivered with no session instead
// (counted). A refresh section ends as soon as its announcement is dispatched, never after awaiting subscribers (no
// deadlock with a subscriber that calls the SDK).
const REFRESH_COOLDOWN_MIN_MS = 30_000;
const REFRESH_COOLDOWN_MAX_MS = 3_600_000;
const SDK_RETRIED_STATUSES = [502, 503, 504, 520, 521, 522, 523, 524, 530]; // auth-js lib/fetch.js NETWORK_ERROR_CODES
const SDK_RETRY_GRACE_MS = 8_000;
const OUTAGE_FORGOTTEN_MS = 60_000; // two SDK ticks past the cooldown without a refresh attempt from this client
const REFRESH_BODY_CAP_BYTES = 16 * 1024;
const REFRESH_BODY_DEADLINE_MS = 3_000;
const REFRESH_REJECTED = "Auth refresh rejected";
const ERROR_CODE_FORMAT = /^[a-z][a-z0-9_]{0,63}$/;
const API_VERSION_FORMAT = /^2[0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-9]|3[0-1])$/i; // auth-js's own pattern
const API_VERSION_2024_01_01_MS = Date.UTC(2024, 0, 1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = `(${MONTHS.join("|")})`;
const DAY_NAME = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const TIME_OF_DAY = "(\\d{2}):(\\d{2}):(\\d{2})";
// RFC 9110 5.6.7 HTTP-date: the IMF-fixdate senders use, and the obsolete rfc850-date and asctime-date forms a
// recipient must still accept
const IMF_FIXDATE = new RegExp(`^${DAY_NAME}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME_OF_DAY} GMT$`);
const RFC850_DATE = new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME_OF_DAY} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY_NAME} ${MONTH} ( \\d|\\d{2}) ${TIME_OF_DAY} (\\d{4})$`);

/** An HTTP-date as epoch milliseconds, or null when the text is not one or names no real calendar time. */
function httpDateMs(text: string, nowMs: number): number | null {
  let year: number, month: string, day: string, clock: string[];
  const imf = IMF_FIXDATE.exec(text);
  const rfc850 = imf ? null : RFC850_DATE.exec(text);
  const asctime = imf || rfc850 ? null : ASCTIME_DATE.exec(text);
  if (imf) [year, month, day, clock] = [Number(imf[3]), imf[2], imf[1], imf.slice(4, 7)];
  else if (rfc850) {
    // a two-digit year that would be more than 50 years ahead is the most recent past year with those digits
    const thisYear = new Date(nowMs).getUTCFullYear();
    year = Math.floor(thisYear / 100) * 100 + Number(rfc850[3]);
    if (year > thisYear + 50) year -= 100;
    [month, day, clock] = [rfc850[2], rfc850[1], rfc850.slice(4, 7)];
  } else if (asctime) [year, month, day, clock] = [Number(asctime[6]), asctime[1], asctime[2], asctime.slice(3, 6)];
  else return null;
  const [hours, minutes, seconds] = clock.map(Number);
  if (hours > 23 || minutes > 59 || seconds > 60) return null;
  const midnight = Date.UTC(year, MONTHS.indexOf(month), Number(day));
  if (new Date(midnight).getUTCDate() !== Number(day)) return null; // e.g. 31 Feb or day 00
  return midnight + ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** The wait a Retry-After value asks for, in milliseconds from nowMs (delay-seconds or HTTP-date), or null. */
function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = httpDateMs(text, nowMs);
  return at === null ? null : at - nowMs;
}

/** The refresh cooldown after a 429/5xx answer: its Retry-After wait (null: none readable), at least 30 s, at most 1 h. */
function refreshCooldownMs(wait: number | null): number {
  return Math.min(REFRESH_COOLDOWN_MAX_MS, Math.max(REFRESH_COOLDOWN_MIN_MS, wait ?? 0));
}


/** The body as bytes, or null when it is over the cap, slower than the deadline, or cannot be read. */
async function cappedBody(response: Response, capBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), REFRESH_BODY_DEADLINE_MS);
  });
  const whole = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.byteLength;
      if (size > capBytes) return false;
      chunks.push(value);
    }
  })().catch(() => false);
  const complete = await Promise.race([whole, late]);
  clearTimeout(timer);
  if (!complete) {
    reader.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The body as text (16 KB cap), or null when it is over the cap, slower than the deadline, or cannot be read. */
async function cappedBodyText(response: Response): Promise<string | null> {
  const bytes = await cappedBody(response, REFRESH_BODY_CAP_BYTES);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** The error code auth-js itself would take from this answer (lib/fetch.js handleError), or null for none. */
function sdkErrorCode(response: Response, text: string | null): string | null {
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { code, error_code: errorCode } = body as Record<string, unknown>;
  const version = response.headers.get("x-supabase-api-version");
  const versionMs = version !== null && API_VERSION_FORMAT.test(version) ? Date.parse(`${version}T00:00:00.0Z`) : NaN;
  const chosen = versionMs >= API_VERSION_2024_01_01_MS && typeof code === "string" ? code : typeof errorCode === "string" ? errorCode : null;
  return chosen !== null && ERROR_CODE_FORMAT.test(chosen) ? chosen : null;
}

/** POST <project URL>/auth/v1/token, as supabase-js builds it (trimmed URL, trailing slash, then auth/v1). */
function tokenEndpoint(supabaseUrl: string | undefined): string | null {
  try {
    const base = (supabaseUrl ?? "").trim();
    return new URL("auth/v1/token", base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return null;
  }
}

const SESSION_BODY_CAP_BYTES = 64 * 1024;
/**
 * One refresh dispatch; a hung request cannot hold the lease. Kept well inside Auth's refresh-token reuse interval
 * (10 s by default), so the SDK's retry of a request whose answer was lost after Auth rotated the token still lands
 * inside it.
 */
const REFRESH_DISPATCH_MS = 6_000;
const LOGOUT_DISPATCH_MS = 5_000;
/** How long a refresh request waits for the session-publication lease before it is answered 503 and retried later. */
const LEASE_WAIT_MS = 15_000;
const SESSION_NOT_FOUND = "session_not_found";

/** POST <project URL>/auth/v1/logout, as auth-js GoTrueAdminApi.signOut builds it (the scope is in the query). */
function logoutEndpoint(supabaseUrl: string | undefined): string | null {
  try {
    const base = (supabaseUrl ?? "").trim();
    return new URL("auth/v1/logout", base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return null;
  }
}

/** The refresh token in the body the SDK built for this request (`{"refresh_token": …}`), or null. */
function requestRefreshToken(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") return null;
  try {
    const body: unknown = JSON.parse(init.body);
    const token = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["refresh_token"] : undefined;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * A3: whether a 2xx refresh answer inside an End Session section continues the lineage that section ends: its access
 * token states the Auth session id the end permit names. False when the permit names none (nothing can be compared) or
 * the answer is not a session: the refreshed session is then never handed to the SDK, which would log out with it.
 */
function continuesEndedLineage(section: { readonly permit: unknown }, bytes: Uint8Array): boolean {
  const permit = section.permit as { readonly kind?: unknown; readonly sessionId?: unknown } | null;
  if (permit === null || permit.kind !== "end" || typeof permit.sessionId !== "string" || permit.sessionId.length === 0) return false;
  const envelope = readEnvelope(new TextDecoder().decode(bytes));
  return envelope !== null && jwtClaims(envelope.accessToken).sessionId === permit.sessionId;
}

/** The new refresh token of a 2xx refresh answer that is a session (auth-js hasSession), or null. */
function answeredRefreshToken(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  const envelope = readEnvelope(text);
  if (envelope === null) return null;
  return envelope.stored["expires_in"] ? envelope.refreshToken : null;
}

/** One dispatch with its own time limit (the SDK passes no signal); over it, it rejects as a network failure does. */
async function dispatch(input: RequestInfo | URL, init: RequestInit | undefined, limitMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const notCompleted = () => new Response(null, { status: 503 });

function refusalAnswer(status: number, code: string | null): Response {
  return new Response(JSON.stringify(code === null ? { msg: REFRESH_REJECTED } : { code, msg: REFRESH_REJECTED }), {
    status,
    headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
  });
}

/** End Session's local completion: the SDK ends the session in this browser (see the header). */
const endedHere = () => refusalAnswer(401, SESSION_NOT_FOUND);

/**
 * The stored session repeated as a token answer. No request is sent and no credential is created. A4 (C4): the session
 * is stored with `expires_at: null`; the answer states the expiry the access token states (envelope.expiresAt, see
 * session-cookie-layout.ts), so the SDK never takes the repeated session for one about to expire.
 */
function storedAnswer(envelope: SessionEnvelope): Response {
  const expiresIn = envelope.expiresAt === null ? 1 : Math.max(1, Math.floor(envelope.expiresAt - Date.now() / 1000));
  const expiry = envelope.expiresAt === null ? {} : { expires_at: envelope.expiresAt };
  return new Response(JSON.stringify({ ...envelope.stored, ...expiry, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The shared client's transport's way to end its outage (set for the browser's one shared client). */
let endOutage: (() => void) | null = null;

/** End sections whose logout Auth confirmed (A2): what End Session may truthfully call a confirmed revocation. */
const confirmedRevocations = new WeakSet<object>();

/** Whether Auth confirmed the revocation made inside this End Session section (A2; see session-publication.ts). */
export function revocationConfirmed(section: object): boolean {
  return confirmedRevocations.has(section);
}

/**
 * Ends the shared client's refresh outage: called after a sign-in was published into this browser (a successful sign-in
 * grant ends an outage, and the sign-in itself is not sent through this transport). Without it a sign-in made on a page
 * that stays open would inherit the previous session's cooldown.
 */
export function endRefreshOutage(): void {
  endOutage?.();
}

/**
 * A2: what a data request (PostgREST or Storage) that would leave with only the anonymous key is answered here instead.
 * Fixed golfer-facing text (some pages show a data error's message as it is), in both the PostgREST and Storage error
 * shapes; nothing is sent.
 */
const NO_SESSION_MESSAGE = "You're not signed in on this device right now, so nothing was sent. Sign in again to continue.";
function noSessionAnswer(): Response {
  return new Response(
    JSON.stringify({ code: "no_session", statusCode: "401", error: "no_session", message: NO_SESSION_MESSAGE, details: null, hint: null }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** The data API roots of the project (PostgREST and Storage), as supabase-js builds their URLs. */
function dataRoots(supabaseUrl: string | undefined): string[] {
  try {
    const base = (supabaseUrl ?? "").trim();
    const root = base.endsWith("/") ? base : `${base}/`;
    return [new URL("rest/v1/", root).href, new URL("storage/v1/", root).href];
  } catch {
    return [];
  }
}

/** The platform fetch with the session transport above, for one client (one per tab: the SDK keeps a singleton). */
function withSessionTransport(
  supabaseUrl: string | undefined,
  anonKey: string | undefined,
  onOutageControl?: (end: () => void) => void,
): typeof fetch {
  const endpoint = tokenEndpoint(supabaseUrl);
  const logout = logoutEndpoint(supabaseUrl);
  const roots = dataRoots(supabaseUrl);
  /**
   * A2: a data request carrying the anonymous key as its bearer — what supabase-js sends when the session read at
   * request time found no session (signed out meanwhile, or a refresh that failed). Every page that uses this shared
   * client is a signed-in golfer's page, so such a request is never meant: it is not sent (counted).
   */
  const anonymousData = (input: RequestInfo | URL, init?: RequestInit): boolean => {
    if (!anonKey || roots.length === 0) return false;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!roots.some((root) => url.startsWith(root))) return false;
      const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
      return headers.get("authorization") === `Bearer ${anonKey}`;
    } catch {
      return false;
    }
  };
  // performance.now() times: until graceUntil the SDK's own retries still go out; from then until coolUntil nothing is
  // sent. null: no outage.
  let outage: { graceUntil: number; coolUntil: number } | null = null;
  onOutageControl?.(() => {
    outage = null;
  });
  const classify = (input: RequestInfo | URL, init?: RequestInit): "refresh" | "other grant" | "logout" | null => {
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method);
      if (method.toUpperCase() !== "POST") return null;
      const target = `${url.origin}${url.pathname}`;
      if (logout !== null && target === logout) return "logout";
      if (endpoint === null || target !== endpoint) return null;
      return url.searchParams.get("grant_type") === "refresh_token" ? "refresh" : "other grant";
    } catch {
      return null;
    }
  };
  const cooling = (): boolean => {
    if (outage === null) return false;
    const now = performance.now();
    if (now >= outage.coolUntil + OUTAGE_FORGOTTEN_MS) {
      outage = null; // over, unseen: a new failure is a new outage
      return false;
    }
    return now >= outage.graceUntil && now < outage.coolUntil;
  };
  const noteFailure = (response: Response) => {
    const now = performance.now();
    const wait = retryAfterMs(response.headers.get("retry-after"), Date.now());
    const sdkRetried = wait === null && SDK_RETRIED_STATUSES.includes(response.status);
    outage = {
      graceUntil: outage === null ? now + (sdkRetried ? SDK_RETRY_GRACE_MS : 0) : sdkRetried ? outage.graceUntil : Math.min(outage.graceUntil, now),
      coolUntil: Math.max(outage?.coolUntil ?? -Infinity, now + refreshCooldownMs(wait)),
    };
    response.body?.cancel().catch(() => {});
  };

  async function refresh(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const token = requestRefreshToken(init);
    const local = (answer: Response) => {
      countSessionOutcome("localAnswers");
      return answer;
    };
    if (token === null) return local(notCompleted()); // not the SDK's refresh body: nothing is sent
    // without a document there is no jar to hold the token (a server render): nothing is held, sent or stored
    if (typeof document === "undefined") return local(refusalAnswer(400, SESSION_NOT_FOUND));
    const current = activeSection();
    const ending = current?.kind === "end" && current.permit?.kind === "end" && current.permit.refreshTokens.has(token);
    if (!ending && cooling()) return local(notCompleted()); // cooling down: no need to wait for the lease to send nothing
    const handle = await enterRefresh(token, LEASE_WAIT_MS);
    if (handle === null) return local(notCompleted()); // the lease was not available in time: the session is kept
    const inEnd = handle.admitted && handle.section.kind === "end";
    const holdsToken = () => {
      const stored = readStoredSession();
      return stored.kind === "present" && stored.envelope.refreshToken === token;
    };
    let expect: { origin: string; result: string | null } | null = null;
    /** End Session's local completion; its revocation is not reached through this request. */
    const endLocal = () => {
      countSessionOutcome("revocationNotReached");
      return local(endedHere());
    };
    /** The answer for a refresh of a session the jar no longer holds: what the jar holds instead. */
    const jarAnswer = () => {
      const stored = readStoredSession();
      // only what this tenure verified or wrote: a session written outside the contract meanwhile is never handed over
      if (!tenureAdmits(storedJarView()) || sessionRefusedByBinding(stored)) return local(notCompleted());
      if (stored.kind === "present") return local(storedAnswer(stored.envelope));
      if (stored.kind === "absent") {
        // the SDK removes nothing then (the jar is empty); this section waits for that removal like any refusal's
        recordRefusal(token);
        expect = { origin: token, result: null };
        return local(refusalAnswer(400, SESSION_NOT_FOUND));
      }
      return local(notCompleted()); // a jar holding no usable session: nothing is removed from here
    };
    try {
      // this section's view of the jar is not the recorded lineage: nothing is sent, handed over or ended (fail closed)
      if (!handle.section.viewTrusted) return local(notCompleted());
      if (!handle.admitted && !holdsToken()) return jarAnswer();
      if (cooling()) return inEnd ? endLocal() : local(notCompleted());
      let response: Response;
      try {
        countSessionOutcome("refreshSent");
        response = await dispatch(input, init, REFRESH_DISPATCH_MS);
      } catch (failure) {
        if (inEnd) return endLocal();
        throw failure; // a network failure: auth-js retries it itself
      }
      const failed = response.status === 429 || response.status >= 500;
      if (failed) {
        noteFailure(response);
        return inEnd ? endLocal() : local(notCompleted());
      }
      outage = null; // the outage is over
      if (response.status >= 200 && response.status <= 299) {
        const bytes = await cappedBody(response, SESSION_BODY_CAP_BYTES);
        const result = bytes === null ? null : answeredRefreshToken(bytes);
        if (bytes === null || result === null) return inEnd ? endLocal() : local(notCompleted());
        // A3: inside End Session the SDK stores this answer and then logs out with it, so it is handed over only when it
        // continues the lineage being ended. A jar whose refresh token belongs to another sign-in than its access token
        // (another account's, or a newer one of the same account) would otherwise have that sign-in revoked here.
        if (inEnd && !continuesEndedLineage(handle.section, bytes)) return endLocal();
        if (!handle.admitted && !holdsToken()) return jarAnswer();
        recordContinuation(token, result);
        expect = { origin: token, result };
        return new Response(bytes as unknown as BodyInit, { status: response.status, headers: { "content-type": "application/json" } });
      }
      if (response.status < 400) {
        response.body?.cancel().catch(() => {});
        return inEnd ? endLocal() : local(notCompleted());
      }
      let code: string | null = null;
      try {
        code = sdkErrorCode(response, await cappedBodyText(response));
      } catch {
        code = null; // an answer that cannot be read is still a refusal: same status, no code
      }
      if (!handle.admitted && !holdsToken()) return jarAnswer();
      recordRefusal(token);
      expect = { origin: token, result: null };
      return refusalAnswer(response.status, code);
    } finally {
      finishRefresh(handle, expect);
    }
  }

  async function logoutRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const section = activeSection();
    if (section?.kind !== "end") return fetch(input, init);
    try {
      const response = await dispatch(input, init, LOGOUT_DISPATCH_MS);
      // A2: Auth confirmed this End Session's revocation (2xx; 404: the session no longer exists there)
      if (response.ok || response.status === 404) confirmedRevocations.add(section);
      if (response.ok) {
        countSessionOutcome("revoked");
        return response; // the SDK never reads a successful logout's body
      }
      response.body?.cancel().catch(() => {}); // a refusal's body is never read: its status alone is handed over
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        countSessionOutcome("revocationNotReached");
        return refusalAnswer(response.status, null);
      }
    } catch {
      // not reached: End Session still ends the session in this browser
    }
    countSessionOutcome("revocationNotReached");
    return endedHere();
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const kind = classify(input, init);
    if (kind === "refresh") return refresh(input, init);
    if (kind === "logout") return logoutRequest(input, init);
    if (anonymousData(input, init)) {
      countSessionOutcome("anonymousRefused");
      return noSessionAnswer();
    }
    const response = await fetch(input, init);
    if (kind === "other grant" && response.ok) outage = null; // a successful sign-in grant: the outage is over
    return response;
  };
}

/** The installed auth-js 2.107.0 members the event fence wraps on the shared client's own instance (see the header). */
interface AuthInternals {
  _notifyAllSubscribers(event: string, session: unknown, broadcast?: boolean): Promise<void>;
  _callRefreshToken(refreshToken: string): Promise<unknown>;
  _emitInitialSession(id: string): Promise<void>;
  readonly stateChangeEmitters: Map<string, { callback: (event: string, session: unknown) => unknown }>;
  onAuthStateChange(callback: (event: string, session: unknown) => unknown): unknown;
}

/** The refresh token of a session an announcement carries, or null. Never throws. */
function announcedRefreshToken(session: unknown): string | null {
  if (session === null || typeof session !== "object") return null;
  try {
    const token = (session as { refresh_token?: unknown }).refresh_token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Inside this tab's held section (no other tab can change the jar): does the announcement describe the jar? */
function describesJarNow(event: string, session: unknown): boolean {
  const stored = readStoredSession();
  if (event === "SIGNED_OUT") return stored.kind !== "present";
  if (session === null || session === undefined) return true; // carries no identity
  const token = announcedRefreshToken(session);
  return token !== null && stored.kind === "present" && stored.envelope.refreshToken === token;
}

/**
 * Without the lock: prepares the check of whether the announcement describes the browser's latest recorded lineage (see
 * the header). The asynchronous part runs first, in this order: the announced session's lineage digest, then a fresh
 * read of the record (which also advances what this tab has observed). The returned check is synchronous, so the caller
 * makes it immediately before it dispatches, against the newest lineage this tab has seen at that moment — not against
 * a value cached before an await.
 */
async function announcementCheck(event: string, session: unknown): Promise<() => boolean> {
  const token = event === "SIGNED_OUT" ? null : announcedRefreshToken(session);
  if (event !== "SIGNED_OUT" && token === null) {
    const carriesNoIdentity = session === null || session === undefined;
    return () => carriesNoIdentity;
  }
  const announced = token === null ? NO_SESSION_LINEAGE : await lineageDigest({ kind: "present", refreshToken: token });
  if (announced === null) return () => false; // nothing can be verified here: not delivered (fail closed)
  if ((await readLineageRecord()) === "unavailable") return () => false;
  return () => {
    const latest = observedLatest();
    return latest === null ? describesJarNow(event, session) : latest === announced;
  };
}

const hooked = new WeakSet<object>();

/** Installs the event fence and the refresh-settled hook on one auth client instance (once). */
function installSessionHooks(auth: AuthInternals): void {
  if (hooked.has(auth)) return;
  hooked.add(auth);
  const notify = auth._notifyAllSubscribers.bind(auth);
  let inOrder: Promise<unknown> = Promise.resolve();
  auth._notifyAllSubscribers = (event: string, session: unknown, broadcast = true) => {
    const token = announcedRefreshToken(session);
    const section = activeSection();
    if (broadcast && section !== null && (section.viewTrusted || sectionChangeUnrecorded(section))) {
      // this tab's own announcement inside its held section: decided now, dispatched now, and the section that waits
      // for it ends right after the dispatch (before any subscriber's own awaited work). It must describe the jar as
      // this tenure verified or wrote it. A change whose lineage record did not land is never announced to other tabs;
      // only a removal is told to this tab's own subscribers (the jar here really holds no session).
      let dispatched: Promise<void> = Promise.resolve();
      const unrecorded = sectionChangeUnrecorded(section);
      const ours = tenureAdmits(storedJarView()) && describesJarNow(event, session);
      if (!unrecorded && ours) dispatched = notify(event, session, broadcast);
      else if (unrecorded && event === "SIGNED_OUT" && storedJarView().kind === "absent") dispatched = notify(event, session, false);
      else countSessionOutcome("droppedEvents");
      noticeDispatched(event, token);
      return dispatched;
    }
    // The queue orders the checks and dispatches only. It never waits for subscribers to finish: a subscriber whose own
    // awaited auth call announces an event would otherwise queue behind itself and stall every later event in this tab.
    const deliver = async (): Promise<{ readonly dispatched: Promise<void> }> => {
      const describesBrowser = await announcementCheck(event, session);
      if (!describesBrowser()) {
        countSessionOutcome("droppedEvents");
        if (broadcast) noticeDispatched(event, token);
        return { dispatched: Promise.resolve() };
      }
      const dispatched = notify(event, session, broadcast); // in the same synchronous step as the check above
      if (broadcast) noticeDispatched(event, token);
      return { dispatched };
    };
    const decided = inOrder.then(deliver, deliver);
    inOrder = decided.catch(() => undefined);
    return decided.then((outcome) => outcome.dispatched); // the caller still waits for its own subscribers
  };
  const callRefresh = auth._callRefreshToken.bind(auth);
  auth._callRefreshToken = async (refreshToken: string) => {
    try {
      return await callRefresh(refreshToken);
    } finally {
      refreshCallSettled(refreshToken);
    }
  };
  // The SDK reads the session for a new subscriber's INITIAL_SESSION from an un-awaited task. A read the storage refuses
  // (unverified: session-storage.ts) rejects there before the SDK's own error handling, which would leave the
  // subscriber without INITIAL_SESSION and the rejection unhandled; the subscriber gets INITIAL_SESSION with no session
  // instead, exactly as the SDK's own error path delivers it (counted).
  const emitInitial = auth._emitInitialSession.bind(auth);
  auth._emitInitialSession = async (id: string) => {
    try {
      await emitInitial(id);
    } catch {
      countSessionOutcome("fencedInitialSessions");
      try {
        await auth.stateChangeEmitters.get(id)?.callback("INITIAL_SESSION", null);
      } catch {
        // the subscriber's own failure, as the SDK treats it
      }
    }
  };
  const subscribe = auth.onAuthStateChange.bind(auth);
  auth.onAuthStateChange = (callback) =>
    subscribe(async (event: string, session: unknown) => {
      if (event !== "INITIAL_SESSION" || session === null || session === undefined) return callback(event, session);
      const describesBrowser = await announcementCheck(event, session);
      if (describesBrowser()) return callback(event, session);
      countSessionOutcome("fencedInitialSessions");
      return callback(event, null);
    });
}

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

/** The browser's one shared client (one per page; the SDK keeps a singleton too). */
export function createClient() {
  if (browserClient !== null) return browserClient;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const storageKey = sessionCookieKey(supabaseUrl);
  configureLease(storageKey);
  const browser = typeof window !== "undefined";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createBrowserClient(supabaseUrl, anonKey, {
    auth: { storage: createSessionStorage(storageKey) },
    global: { fetch: withSessionTransport(supabaseUrl, anonKey, browser ? (end) => (endOutage = end) : undefined) },
  });
  if (browser) {
    installSessionHooks(client.auth as unknown as AuthInternals);
    browserClient = client;
  }
  return client;
}

/**
 * Announces a session that was published without the SDK's own announcement (session-publication.ts: a device clock
 * already past the new token's expiry), exactly as setSession would: SIGNED_IN to this tab's subscribers and, through
 * the SDK's BroadcastChannel, to every other tab, so every view of another account ends without waiting for a
 * visibility change. Called inside the publish section that stored it; the event fence checks it like any other.
 */
export async function announcePublishedSession(session: object): Promise<void> {
  countSessionOutcome("announcedPublications");
  await (createClient().auth as unknown as AuthInternals)._notifyAllSubscribers("SIGNED_IN", session);
}

/**
 * A2: announces SIGNED_OUT after End Session's completion removed an ended session from the jar without the SDK
 * (session-publication.ts completeEndedSession), as the SDK's own removal would: to this tab's subscribers and, through
 * the SDK's BroadcastChannel, to every other tab. Called inside the end section that removed it; the event fence checks
 * it like any other (a removal whose record did not land reaches only this tab).
 */
export async function announceSessionRemoved(): Promise<void> {
  await (createClient().auth as unknown as AuthInternals)._notifyAllSubscribers("SIGNED_OUT", null);
}
