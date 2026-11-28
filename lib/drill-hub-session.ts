/**
 * AG-WEB-READY-01 — the Drill Hub's session, taken from the shared browser client.
 *
 * The Drill Hub used to find its session by reading one exact cookie name out of document.cookie and parsing it. The
 * installed @supabase/ssr stores a large session as numbered chunks (`<key>.0`, `<key>.1`, …) instead, and that reader
 * could not see them: a golfer whose session was chunked got "didn't load" on every visit and could not submit a drill
 * video. The hub now asks the shared browser client (utils/supabase/client.ts). The SDK owns the cookie's names, chunks
 * and encoding, and refreshes a session that is about to expire; nothing here reads or parses a cookie.
 *
 * What the SDK returns is a browser-side credential, never authority. The database's row policies decide what an
 * access token may read, and the verification endpoint verifies its caller itself and refuses a mismatched user id.
 *
 * The reads of one load are bound to the one session acquired for that load: they carry exactly that access token.
 * A session that disappears in the meantime therefore cannot turn a read into an anonymous one — an anonymous progress
 * read returns no rows, which would show every drill as "pending" and 0 verified.
 *
 * R1: the page stops showing a golfer's drills, progress and verdicts as soon as it learns the browser was signed out
 * or now belongs to another account (see drillHubIdentityEnd), and nothing started before that can show afterwards.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { jwtClaims } from "@/utils/supabase/session-cookie-layout";
import { sessionEndPending, type OwnerRefusal } from "@/utils/supabase/session-publication";
import { sessionUnverifiedReason } from "@/utils/supabase/session-storage";
import {
  createDrillHubLoader, readDrillHub, type DrillHubLoader, type DrillHubReads, type ListReadResponse,
} from "@/lib/golfer-journey-read-state";

export interface DrillHubSession {
  /** The access token the reads and the upload carry. Never shown, stored or logged. */
  readonly accessToken: string;
  /** The golfer's id as the session states it. Used only to name the upload path, which the server checks again. */
  readonly userId: string;
}

export type DrillHubSessionResult =
  | { readonly status: "ready"; readonly session: DrillHubSession }
  /** The SDK holds no session: signed out, or the session was cleared. */
  | { readonly status: "signed_out" }
  /**
   * The SDK could not give a usable session: an Auth or network failure, or a session it could not read. `unconfirmed`:
   * the browser refused to hand over the session it holds because it could not confirm it is this browser's latest
   * sign-in (utils/supabase/session-storage.ts); signing in again settles that, trying again may not.
   */
  | { readonly status: "unavailable"; readonly unconfirmed?: true };

/** The one call used from the shared browser client (structural, so tests can drive the real client or a stand-in). */
export interface DrillHubSessionSource {
  readonly auth: {
    getSession(): PromiseLike<{ readonly data: { readonly session: unknown } | null; readonly error: unknown }>;
  };
}

const SIGNED_OUT: DrillHubSessionResult = Object.freeze({ status: "signed_out" });
const UNAVAILABLE: DrillHubSessionResult = Object.freeze({ status: "unavailable" });
const UNCONFIRMED: DrillHubSessionResult = Object.freeze({ status: "unavailable", unconfirmed: true });

/**
 * The longest the hub (or a verification) waits for the session before saying it is unavailable. When an expiring
 * session cannot be refreshed because Auth is unreachable, the installed SDK keeps retrying for up to about 30 seconds
 * per attempt (twice on a fresh page: start-up recovery, then the read); the golfer is told sooner and can Try again.
 */
export const DRILL_HUB_SESSION_DEADLINE_MS = 10_000;

/** The session read still running for each shared client: a later acquisition joins it instead of queuing another. */
const outstanding = new WeakMap<object, Promise<DrillHubSessionResult>>();

/**
 * Asks the shared browser client for the current session. `source` is called here, so a client that cannot be built
 * is "unavailable" too. Never rejects; keeps no error text.
 *
 * A returned error is "unavailable", never "signed out" and never a session: auth-js reports a failed refresh of an
 * expiring session as an error, and that must not become a new identity or an empty result. An answer that takes
 * longer than `deadlineMs` is "unavailable" too; the SDK's read keeps running, and the next acquisition for the same
 * client joins it rather than starting another, so repeated Try again presses do not stack refresh attempts.
 */
export function acquireDrillHubSession(
  source: () => DrillHubSessionSource,
  deadlineMs: number = DRILL_HUB_SESSION_DEADLINE_MS,
): Promise<DrillHubSessionResult> {
  let client: DrillHubSessionSource;
  try {
    client = source();
  } catch {
    return Promise.resolve(UNAVAILABLE);
  }
  if (client === null || typeof client !== "object") return Promise.resolve(UNAVAILABLE);
  const read = outstanding.get(client) ?? startRead(client);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(UNAVAILABLE), deadlineMs);
    read.then(
      (result) => { clearTimeout(timer); resolve(result); },
      () => { clearTimeout(timer); resolve(UNAVAILABLE); },
    );
  });
}

function startRead(client: DrillHubSessionSource): Promise<DrillHubSessionResult> {
  const started = readSession(client);
  outstanding.set(client, started);
  const clear = () => {
    if (outstanding.get(client) === started) outstanding.delete(client);
  };
  started.then(clear, clear);
  return started;
}

async function readSession(client: DrillHubSessionSource): Promise<DrillHubSessionResult> {
  try {
    const answer = await client.auth.getSession();
    if (!answer || answer.error) return UNAVAILABLE;
    const data: unknown = answer.data;
    if (data === null || typeof data !== "object") return UNAVAILABLE;
    const session: unknown = (data as { session?: unknown }).session;
    // Only an explicit "no session" without an error means signed out; anything unrecognised is unavailable.
    if (session === null) return SIGNED_OUT;
    if (session === undefined || typeof session !== "object") return UNAVAILABLE;
    const accessToken = (session as { access_token?: unknown }).access_token;
    const user = (session as { user?: unknown }).user;
    const userId = user !== null && typeof user === "object" ? (user as { id?: unknown }).id : undefined;
    if (typeof accessToken !== "string" || accessToken.length === 0) return UNAVAILABLE;
    if (typeof userId !== "string" || userId.length === 0) return UNAVAILABLE;
    return { status: "ready", session: { accessToken, userId } };
  } catch (error) {
    return sessionUnverifiedReason(error) !== null ? UNCONFIRMED : UNAVAILABLE;
  }
}

/**
 * The client the hub's reads and the upload use: bound to exactly one acquired session. Every request carries that
 * access token (and the public anon key as `apikey`); there is no anonymous fallback, no session storage and no Auth
 * client of its own (supabase-js's `accessToken` option).
 */
export function clientForDrillHubSession(session: DrillHubSession, supabaseUrl: string, anonKey: string) {
  return createSupabaseClient(supabaseUrl, anonKey, { accessToken: async () => session.accessToken });
}

// ─── A3: the page's account, confirmed for each request (utils/supabase/session-publication.ts, the A3 section) ───

export type OwnerSessionResult =
  | { readonly status: "ready"; readonly session: DrillHubSession }
  | { readonly status: OwnerRefusal };

/**
 * The session to send a request of `ownerId`'s page with, confirmed now: the shared client's session (acquired as
 * above; never anonymous) only when its user AND the subject its access token states are `ownerId` — the account the
 * server rendered the page for — and its End Session is not pending. Anything else is a refusal naming why; another
 * account's session is never returned, so a request built from the answer can only carry `ownerId`'s token. A missing
 * owner (null) confirms nothing: no session ever becomes the page's account by being the first one seen.
 */
export async function confirmOwnerSession(
  source: () => DrillHubSessionSource,
  ownerId: string | null,
  deadlineMs: number = DRILL_HUB_SESSION_DEADLINE_MS,
): Promise<OwnerSessionResult> {
  const acquired = await acquireDrillHubSession(source, deadlineMs);
  if (acquired.status === "signed_out") return { status: "signed_out" };
  if (acquired.status !== "ready") return { status: acquired.unconfirmed === true ? "unconfirmed" : "unavailable" };
  if (ownerId === null) return { status: "unconfirmed" };
  if (acquired.session.userId !== ownerId || jwtClaims(acquired.session.accessToken).sub !== ownerId) return { status: "account_changed" };
  if (await sessionEndPending({ access_token: acquired.session.accessToken })) return { status: "ended" };
  return acquired;
}

/** The Authorization header of a request to a same-origin route that verifies a Bearer token itself (resolveRouteAuth). */
export function ownerBearer(session: DrillHubSession): { readonly Authorization: string } {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/**
 * The shared client's parts an owner-bound client keeps: its Auth (acquisition, refresh, identity events). Its `from`
 * and `storage` only lend their types to the owner-bound replacements (same supabase-js clients, same API).
 */
interface ManagedClient {
  readonly auth: DrillHubSessionSource["auth"] & object;
  readonly from: unknown;
  readonly storage: unknown;
}

/**
 * What a request is built with when the page's account could not be confirmed: never a token (it names only why), so
 * the request it marks is answered here and never sent (ownerBoundClient).
 */
const OWNER_REFUSED_PREFIX = "swingproai-owner-refused:";

/** The local answer to a request that was not sent because the page's account could not be confirmed. Fixed text. */
function ownerRefusedAnswer(): Response {
  const message = "This request was not sent: this browser could not confirm it holds the sign-in the page was opened for.";
  return new Response(JSON.stringify({ code: "owner_refused", statusCode: "401", error: "owner_refused", message, details: null, hint: null }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The client of a page rendered for `ownerId`: `auth` is the shared managed client's own (session acquisition, refresh
 * and identity events stay with it), while every PostgREST and Storage request is made by a client whose token is
 * confirmed for `ownerId` at the moment that request is built (confirmOwnerSession; supabase-js asks for the token of
 * every request just before sending it). So no request of this page can leave with another account's token, even if
 * another sign-in is published between the page's own check and the request: such a request is not sent at all — it is
 * answered here with a fixed 401 ("owner_refused"), which PostgREST and Storage report as their error (and nothing
 * retries) — and nothing is ever sent anonymously. The data client is built on first use, so creating this one sends
 * and reads nothing.
 */
export function ownerBoundClient<M extends ManagedClient>(managed: M, ownerId: string | null, supabaseUrl: string, anonKey: string) {
  let data: ReturnType<typeof createSupabaseClient> | null = null;
  const bound = () =>
    (data ??= createSupabaseClient(supabaseUrl, anonKey, {
      accessToken: async () => {
        const confirmed = await confirmOwnerSession(() => managed, ownerId);
        return confirmed.status === "ready" ? confirmed.session.accessToken : `${OWNER_REFUSED_PREFIX}${confirmed.status}`;
      },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined));
          if ((headers.get("authorization") ?? "").startsWith(`Bearer ${OWNER_REFUSED_PREFIX}`)) return Promise.resolve(ownerRefusedAnswer());
          return fetch(input, init);
        },
      },
    }));
  return {
    auth: managed.auth as M["auth"],
    from: ((relation: string) => bound().from(relation)) as unknown as M["from"],
    get storage(): M["storage"] {
      return bound().storage as unknown as M["storage"];
    },
  };
}

/** What a read answers when it was never started (no usable session, or the load was cancelled first). readList
 *  classifies any error as "unavailable"; this text is never shown. */
const NOT_STARTED: ListReadResponse<never> = Object.freeze({ data: null, error: Object.freeze({ message: "read not started" }) });
/** Both reads, never started (a load whose session belongs to another golfer than the one shown). */
const NOT_STARTED_READS: DrillHubReads<never, never> = Object.freeze({
  catalog: () => Promise.resolve(NOT_STARTED),
  progress: () => Promise.resolve(NOT_STARTED),
});

/**
 * The Drill Hub's two reads for one load: one session acquisition, shared by both, then the reads `build` makes for
 * exactly that session. Without a usable session neither read is started; both answer "not started", which the hub
 * shows as unavailable, never as empty progress. If `signal` aborts first, both answer at once without waiting for the
 * acquisition (which cannot itself be cancelled), so a cancelled load never holds the loader's bound on abandoned work.
 */
export function sessionBoundDrillHubReads<Drill, Progress>(
  acquire: () => Promise<DrillHubSessionResult>,
  build: (session: DrillHubSession) => DrillHubReads<Drill, Progress>,
  signal: AbortSignal,
): DrillHubReads<Drill, Progress> {
  let bound: Promise<DrillHubReads<Drill, Progress> | null> | null = null;
  const reads = () =>
    (bound ??= untilAborted(acquire, signal).then((acquired) =>
      acquired !== null && acquired.status === "ready" && !signal.aborted ? build(acquired.session) : null,
    ));
  return {
    catalog: async () => {
      const r = await reads();
      return r ? r.catalog() : NOT_STARTED;
    },
    progress: async () => {
      const r = await reads();
      return r ? r.progress() : NOT_STARTED;
    },
  };
}

// ─── Who the hub is showing: sign-out and account change (AG-WEB-READY-01-R1) ─────────────────────────────────────

/**
 * Why a hub stopped showing a golfer's drills: the browser's sign-in ended, or now belongs to another account. Either
 * one is final for the page; the golfer signs in again, or refreshes the page for the account now signed in.
 */
export type DrillHubIdentityEnd = "signed_out" | "account_changed";

/**
 * What an observed session means for a hub showing `shownUserId`'s drills (null: nothing shown yet). Only an explicit
 * signed-out answer, or a session for another golfer, ends the hub. "Unavailable" changes nothing: it is not evidence
 * of a sign-out.
 */
export function drillHubIdentityEnd(shownUserId: string | null, observed: DrillHubSessionResult): DrillHubIdentityEnd | null {
  if (observed.status === "signed_out") return "signed_out";
  if (observed.status === "ready" && shownUserId !== null && observed.session.userId !== shownUserId) return "account_changed";
  return null;
}

/**
 * The same decision for an event from the shared client (`onAuthStateChange`), which also brings sign-outs and
 * sign-ins made through the shared client in other tabs. Reads only the event name and the user id: SIGNED_OUT ends
 * the hub; any event carrying a session for another golfer than the one shown is an account change. A null session
 * on any other event (the SDK reports a failed start-up read that way) is not a sign-out.
 */
export function drillHubIdentityEndFromEvent(shownUserId: string | null, event: string, session: unknown): DrillHubIdentityEnd | null {
  if (event === "SIGNED_OUT") return "signed_out";
  if (shownUserId === null) return null;
  const id = drillHubSessionUserId(session);
  return id !== null && id !== shownUserId ? "account_changed" : null;
}

/**
 * The user id a session object from the shared client states, or null. Never throws: auth-js can hand out a user
 * stand-in that throws when read, and no usable id is never an account change (the next session read decides).
 */
export function drillHubSessionUserId(session: unknown): string | null {
  if (session === null || typeof session !== "object") return null;
  try {
    const user = (session as { user?: unknown }).user;
    const id = user !== null && typeof user === "object" ? (user as { id?: unknown }).id : undefined;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** What the page shows for one load: the loader's states, with who a result belongs to and why a load ended. */
export type DrillHubSessionState<Drill, Progress> =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly drills: Drill[]; readonly progress: Progress[]; readonly userId: string }
  | { readonly phase: "unavailable" }
  | { readonly phase: DrillHubIdentityEnd };

/**
 * The page's Drill Hub loader: the unchanged single-flight loader over the session-bound reads, plus whose drills a
 * result is. A load whose session read said "signed out" publishes "signed_out" (Try again cannot help), not
 * "unavailable". A load whose session belongs to another golfer than `shownUser()` reads nothing and publishes
 * "account_changed". `build` makes the two reads for exactly the acquired session.
 */
export function createDrillHubSessionLoader<Drill, Progress>(
  acquire: () => Promise<DrillHubSessionResult>,
  build: (session: DrillHubSession, readSignal: AbortSignal) => DrillHubReads<Drill, Progress>,
  shownUser: () => string | null,
  publish: (state: DrillHubSessionState<Drill, Progress>) => void,
): DrillHubLoader {
  // The load in flight (the loader is single-flight, so a published result is always this load's).
  let current: { acquired: DrillHubSessionResult | null } = { acquired: null };
  return createDrillHubLoader<Drill, Progress>(
    (signal) => {
      const load: { acquired: DrillHubSessionResult | null } = { acquired: null };
      current = load;
      return readDrillHub((readSignal) => sessionBoundDrillHubReads<Drill, Progress>(
        () => acquire().then((result) => {
          load.acquired = result;
          return result;
        }),
        (session) => {
          const shown = shownUser();
          return shown !== null && session.userId !== shown ? NOT_STARTED_READS : build(session, readSignal);
        },
        readSignal,
      ), signal);
    },
    (state) => {
      if (state.phase === "loading") return publish(state);
      const acquired = current.acquired;
      if (acquired !== null) {
        const end = drillHubIdentityEnd(shownUser(), acquired);
        if (end !== null) return publish({ phase: end });
      }
      if (state.phase === "ready" && acquired !== null && acquired.status === "ready") {
        return publish({ phase: "ready", drills: state.drills, progress: state.progress, userId: acquired.session.userId });
      }
      publish({ phase: "unavailable" });
    },
  );
}

/** Added to the unavailable panel when the browser could not confirm its sign-in (see `unconfirmed`). Fixed text. */
export const DRILL_HUB_UNCONFIRMED_COPY = {
  body: "We couldn't confirm which account is signed in on this device. If trying again doesn't help, sign in again.",
  action: "Sign in again",
} as const;

/** Copy for a hub that stopped showing a golfer's drills. Fixed text; names no account. */
export const DRILL_HUB_IDENTITY_COPY = {
  signed_out: {
    title: "You're signed out",
    body: "Your drills and progress aren't shown while you're signed out. Sign in again to see them.",
    action: "Sign in",
  },
  account_changed: {
    title: "Your sign-in changed",
    body: "This browser is now signed in to a different account, so the drills shown here were cleared. Refresh the page to load the drills for the account that's signed in now.",
    action: "Refresh page",
  },
} as const;

/** The acquisition's result, or null as soon as `signal` aborts. Never rejects. */
function untilAborted(
  acquire: () => Promise<DrillHubSessionResult>,
  signal: AbortSignal,
): Promise<DrillHubSessionResult | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (result: DrillHubSessionResult | null) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result); // after an abort this is a no-op
    };
    let started: Promise<DrillHubSessionResult>;
    try {
      started = acquire();
    } catch {
      done(UNAVAILABLE);
      return;
    }
    Promise.resolve(started).then(done, () => done(UNAVAILABLE));
  });
}

// ─── Drill video verification (the existing endpoint; only its caller's session and messages) ─────────────────────

/** The fields the page shows from a successful verification answer. */
export interface DrillVerifyResult {
  readonly pass: boolean;
  readonly status: "verified" | "needs_work";
  readonly feedback: string;
}

/** A successful answer of the expected shape, or null. Nothing else from the answer is used. */
export function readDrillVerifyResult(value: unknown): DrillVerifyResult | null {
  if (value === null || typeof value !== "object") return null;
  const { pass, status, feedback } = value as { pass?: unknown; status?: unknown; feedback?: unknown };
  if (typeof pass !== "boolean" || typeof feedback !== "string") return null;
  if (status !== "verified" && status !== "needs_work") return null;
  return { pass, status, feedback };
}

/**
 * Whether a Storage upload refusal is the size limit (HTTP 413, or Storage's own statusCode "413"), which retrying
 * cannot fix. Only the two numeric fields are read; no error text is kept.
 */
export function isUploadTooLarge(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  return status === 413 || String(statusCode) === "413";
}

/**
 * Golfer-facing verification messages. Fixed text only: no server, Storage, Auth or provider wording, status code or
 * credential ever reaches the page. Only a failure that trying again can fix says "try again"; a permanent refusal
 * says what to do instead, and an outcome the page cannot know says so rather than inviting a second upload.
 */
export const DRILL_VERIFY_COPY = {
  /** Shown with the signed-out or changed-account panel when the submission itself found the change. */
  notSent: "The video you chose wasn't sent.",
  sessionUnavailable: "We couldn't confirm your sign-in just now, so this video wasn't sent. Try again in a moment.",
  tooLarge: "This video is too large to upload, so it hasn't been checked. Choose a shorter clip.",
  wrongType: "This video's format can't be uploaded, so it hasn't been checked. Choose an MP4 or MOV clip.",
  uploadRefused: "Your video wasn't accepted for upload, so it hasn't been checked. Refresh the page, then try again.",
  uploadFailed: "Your video didn't upload, so it hasn't been checked. Try again in a moment.",
  notConfirmed: "We couldn't confirm your sign-in for this check, so this video hasn't been checked. Refresh the page, then try again.",
  checkRefused: "This video couldn't be checked from this page. Refresh the page before you submit it again.",
  drillUnavailable: "This drill couldn't be checked just now, so your video hasn't been reviewed. Refresh the page, then submit it again if the drill is still listed.",
  serviceUnavailable: "Video checks aren't available right now, so this video hasn't been checked. Please try again later.",
  checkFailed: "We couldn't finish checking this video. Try again in a moment; if it fails again, try a different clip.",
  outcomeUnknown: "We couldn't tell whether this video was checked. Refresh the page to see your latest result before you submit it again.",
} as const;

export type DrillVerifyMessage = keyof typeof DRILL_VERIFY_COPY;

/**
 * The message for a Storage upload refusal, from its two numeric fields only (HTTP `status`, and Storage's own
 * `statusCode`). The size limit and an unsupported format cannot be fixed by trying again; a permission refusal
 * points at the page's sign-in state; anything else (including a network failure) is worth another try.
 */
export function drillUploadRefusal(error: unknown): DrillVerifyMessage {
  if (isUploadTooLarge(error)) return "tooLarge";
  if (error === null || typeof error !== "object") return "uploadFailed";
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const code = String(statusCode);
  if (status === 415 || code === "415") return "wrongType";
  if (status === 401 || status === 403 || code === "401" || code === "403") return "uploadRefused";
  return "uploadFailed";
}

/**
 * The message for a verification request that did not give a usable answer: the endpoint's HTTP status, or null when
 * there was no answer to read (the request failed in transit, or a success answer had an unexpected shape).
 * - 401: the server could not confirm the caller (the page also re-checks its own session first).
 * - 400, 403: refused for this request from this page (bad input, another golfer's id or folder); permanent.
 * - 404: the drill lookup failed (a missing drill, or a failed lookup): refresh first, never "in a moment".
 * - 503: checking is not available (e.g. not configured); later, not "in a moment".
 * - 429, 500, 502: the check did not complete and wrote nothing, so trying again is safe; some 500s (a clip the model
 *   cannot process) recur, so the message also suggests a different clip.
 * - anything else, and no answer: the page cannot know whether the check ran (e.g. a gateway timeout), so it asks the
 *   golfer to look at their latest result before sending the video again.
 */
export function drillVerifyRefusal(httpStatus: number | null): DrillVerifyMessage {
  switch (httpStatus) {
    case 401: return "notConfirmed";
    case 400: case 403: return "checkRefused";
    case 404: return "drillUnavailable";
    case 503: return "serviceUnavailable";
    case 429: case 500: case 502: return "checkFailed";
    default: return "outcomeUnknown";
  }
}
