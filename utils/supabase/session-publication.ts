import { createClient as createSupabaseJsClient, type SupabaseClient } from "@supabase/supabase-js";
import { serialize } from "@supabase/ssr";
import {
  announcePublishedSession,
  announceSessionRemoved,
  createClient,
  endRefreshOutage,
  revocationConfirmed,
} from "@/utils/supabase/client";
import {
  END_INTENT_COOKIE,
  isSessionLineageId,
  jwtClaims,
  parseCookieHeader,
  readEndIntent,
  sessionLineageId,
} from "@/utils/supabase/session-cookie-layout";
import { activeSection, enterSection, leaseSupport, leaveSection, readLineageRecord, type Permit } from "@/utils/supabase/session-lease";
import { endLocally, publishDirect, readStoredSession } from "@/utils/supabase/session-storage";

// ============================================================================
// Sign-in publication and End Session (browser only)
// ============================================================================
//
// Sign-in. auth-js signInWithPassword saves its session without any lock, so it
// is not called on the shared client. A separate, non-persisting client (its own
// in-memory storage key, no refresh, no cookie) asks Auth; the session it gets
// is then PUBLISHED into the shared client inside a publish section of the
// session-publication lease whose permit names the new refresh token: the SDK's
// own setSession validates it (GET /user), saves it through the layout-managed
// storage (which removes every older session name: no older bare cookie can
// shadow the new session) and announces SIGNED_IN to this tab and, through the
// SDK's BroadcastChannel, to other tabs, where every view of another golfer
// ends (the Drill Hub's, for one) without waiting for the tab to become visible.
// When this device's clock is already past the new token's expiry, setSession
// would refresh it first instead; the session is then stored as Auth returned
// it under the same permit and announced the same way (announcePublishedSession).
// Every step is bounded. Once the permit's section ends — published, refused or
// timed out — a late setSession save is refused by the storage (no permit names
// its token any more), so an attempt reported as interrupted can never publish
// afterwards. The scratch client sends only the password grant (signInOnly: it
// can never refresh, and so never rotate, the session it is handing over), and
// its in-memory copy is cleared after every attempt. A publication counts only
// once its lineage record has landed (session-lease.ts); one that was stored but
// not recorded is reported as interrupted and is never announced. In a browser
// that cannot support the synchronization contract at all (no Web Locks,
// IndexedDB or SubtleCrypto: leaseSupport()), nothing is sent — not even the
// password — and the attempt is "unsupported"; one whose lineage store cannot be
// read right now (an IndexedDB that fails to open, is blocked or too slow) sends
// nothing either and is "interrupted". Once the password has been sent the
// outcome is never "unsupported" (its text says nothing was sent). A publish
// section whose tenure could not be verified at all (the store failed while it
// waited) publishes nothing.
//
// End Session. Inside an end section — held until the page unloads, so no other
// tab can publish or refresh between the local end and the server's redirect —
// the shared client's own signOut({ scope: "local" }) loads the session
// (refreshing it if it must), revokes THAT session at Auth with its current
// access token and removes it, announcing SIGNED_OUT. When Auth cannot be
// reached the transport completes it locally (see client.ts). Whatever remains
// of the lineage is then removed here. The page then posts the End Session form,
// which arrives without a session cookie, so the server only redirects. A session
// belonging to another account than the page showed (signed in since, in this
// browser) is left alone: the page reloads into that account instead. When the
// section cannot be held in time (another tab holds the lease, or the caller
// cancelled), nothing here changes anything and the lock request is aborted, so
// it can never be granted later; the caller then asks the server, which only
// revokes the session the request carries and never writes or removes a cookie.
//
// A2 — End Session is bound to a session LINEAGE, not only an account
// (session-cookie-layout.ts): the page names the lineage the server rendered it
// for, and a jar holding any other lineage — another golfer, or a newer sign-in
// of the same golfer — is never ended from it ("other_account": the page
// reloads into that sign-in). "ended" means Auth confirmed the revocation AND
// the session was removed here; "ended_unconfirmed" means it was removed here
// but Auth did not confirm the revocation (the caller says so).
//
// When the server revoked the carried lineage but could not clear this
// browser's copy (no JavaScript, before hydration, or no lease in time), it
// sets the END INTENT cookie to that lineage. completeEndedSession (the sign-in
// page) acts on that intent only: under the lease, with this tab's view of the
// jar verified, it removes the jar's session if — compared immediately before
// the removal — it is still that lineage, announces SIGNED_OUT as the SDK would,
// and deletes the intent (single use). Any other session is kept and the intent
// deleted; a lease or view it cannot have now leaves the intent for an explicit
// retry ("pending"). A /login visit with no intent changes nothing.
//
// Views. Every End Session that ends a lineage here, and every completion,
// also posts an ENDED-LINEAGE notice (the digest only) to this tab and to every
// other tab (BroadcastChannel). Views showing that lineage end at once
// (watchSessionEnd), also where the SDK's SIGNED_OUT could not be delivered
// (a removal whose lineage record did not land); views of any other lineage —
// including a newer sign-in of the same golfer — ignore it.

const SIGN_IN_DEADLINE_MS = 20_000;
const PUBLISH_WAIT_MS = 15_000;
const PUBLISH_DEADLINE_MS = 15_000;
const ANNOUNCE_DEADLINE_MS = 5_000;
/** The shared client's own start-up (it may refresh what it found) is awaited at most this long. */
const START_DEADLINE_MS = 5_000;
const END_WAIT_MS = 15_000;
/** The SDK's signOut inside the end section: one refresh dispatch (6 s + 3 s body) and one logout dispatch (5 s). */
const SIGN_OUT_DEADLINE_MS = 16_000;
/**
 * End Session's section is released by the page unloading; this ends it if the page is still here. Counted from the
 * moment the section is held; longer than the bounded work inside it plus the redirect.
 */
const END_HOLD_MS = 30_000;
const SCRATCH_STORAGE_KEY = "swingproai-sign-in-scratch";

let scratch: SupabaseClient | null = null;

/**
 * The scratch client's transport: it sends the password grant and nothing else. The scratch SDK's own start-up emits
 * INITIAL_SESSION to supabase-js's internal subscriber once it is initialized, and that read refreshes a session inside
 * its 90 s margin — when the new session's access token is short-lived, or this device's clock is ahead of Auth's — which
 * would rotate the new session's refresh token before it is published, leaving the published session with a used
 * token. Any other request is answered here, without being sent, with a refusal; the scratch SDK then forgets its
 * in-memory copy, which the sign-in has already been handed.
 */
function signInOnly(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method)).toUpperCase();
    if (method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "password") {
      return fetch(input, init);
    }
  } catch {
    // not a request this client may send
  }
  return Promise.resolve(
    new Response(JSON.stringify({ code: "refresh_token_not_found", msg: "Not sent" }), {
      status: 400,
      headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
    }),
  );
}

/** The non-persisting sign-in client (one per tab, so auth-js never sees two instances under one storage key). */
function scratchClient(): SupabaseClient {
  if (scratch === null) {
    scratch = createSupabaseJsClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: SCRATCH_STORAGE_KEY },
      global: { fetch: signInOnly },
    });
  }
  return scratch;
}

/** Forgets whatever session the scratch client holds in memory (no request, no event to another tab). */
function clearScratch(): void {
  try {
    const memory = (scratch?.auth as unknown as { memoryStorage?: Record<string, unknown> } | undefined)?.memoryStorage;
    if (memory) for (const name of Object.keys(memory)) delete memory[name];
  } catch {
    // nothing kept
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export type SignInOutcome = "signed_in" | "refused" | "interrupted" | "unsupported";

interface ScratchSession {
  readonly access_token: string;
  readonly refresh_token: string;
}

/**
 * Signs in and publishes the session into this browser. "refused": Auth returned no session (any returned error);
 * "interrupted": no answer in time, or the session could not be published and recorded (the caller shows its fixed
 * interrupted text); "unsupported": this browser cannot keep a session safely (nothing was sent). Throws only what the
 * SDK throws.
 */
export async function signInAndPublish(email: string, password: string): Promise<SignInOutcome> {
  if (leaseSupport() === "unsupported") return "unsupported";
  // the shared client configures the lease and the storage (its key, its lineage store): created before anything else,
  // also on a page that never created it (the sign-in page)
  const shared = createClient();
  // the lineage store must answer before anything is sent: a publication it cannot record would never be trusted
  if ((await readLineageRecord()) === "unavailable") return leaseSupport() === "unsupported" ? "unsupported" : "interrupted";
  let session: ScratchSession;
  try {
    const answer = await withDeadline(scratchClient().auth.signInWithPassword({ email, password }), SIGN_IN_DEADLINE_MS);
    if (answer === null) return "interrupted"; // a late answer stays in the scratch client's memory and is never published
    if (answer.error || !answer.data?.session) return "refused";
    session = answer.data.session;
  } finally {
    clearScratch();
  }
  await withDeadline(shared.auth.initialize().catch(() => null), START_DEADLINE_MS);
  const section = await enterSection("publish", {
    waitMs: PUBLISH_WAIT_MS,
    permit: { kind: "publish", refreshToken: session.refresh_token },
  });
  if (section === null) return "interrupted"; // the password was sent: never "unsupported" (its text says nothing was sent)
  if (section.viewCheck === "unavailable" || section.viewCheck === "unsupported") {
    leaveSection(section); // nothing can be recorded in this tenure: nothing is published
    return "interrupted";
  }
  try {
    const exp = jwtClaims(session.access_token).exp;
    if (exp !== null && exp <= Date.now() / 1000) {
      // This device's clock is past the new token's expiry: setSession would refresh the new token first. The session
      // is stored as Auth returned it, under the same permit, and announced as setSession would announce it.
      if (!(await publishDirect(section, session))) return "interrupted";
      endRefreshOutage();
      await withDeadline(announcePublishedSession(session).catch(() => undefined), ANNOUNCE_DEADLINE_MS);
      return activeSection() === section ? "signed_in" : "interrupted";
    }
    const result = await withDeadline(
      shared.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token }),
      PUBLISH_DEADLINE_MS,
    );
    if (result === null || result.error) return "interrupted";
    const stored = readStoredSession();
    if (stored.kind !== "present" || stored.envelope.refreshToken !== session.refresh_token) return "interrupted";
    endRefreshOutage(); // a successful sign-in ends the previous session's refresh outage, as a sign-in grant always did
    return "signed_in";
  } catch {
    return "interrupted";
  } finally {
    leaveSection(section);
  }
}

/**
 * "ended": this browser's session for the page's lineage is removed here, Auth confirmed its revocation, and the end
 * section stays held until the page unloads (the caller posts the End Session form now). "ended_unconfirmed": the same,
 * except that Auth did not confirm the revocation (unreachable, slow or refused): the caller must not present it as a
 * complete sign-out. "other_account": this browser now holds another sign-in — another account's, or a newer sign-in of
 * the same account (another lineage) — which is left alone (the caller reloads). "unavailable": the section could not be
 * held in time, the caller cancelled, or the section was lost before the end completed; nothing of another sign-in is
 * touched and no lock request remains (the caller may ask the server to revoke the session the request carries).
 */
export type EndOutcome = "ended" | "ended_unconfirmed" | "other_account" | "unavailable";

/**
 * Ends this browser's session for the page that showed `expectedUserId` (null: whatever is signed in) rendered for the
 * session lineage `expectedLineage` (session-cookie-layout.ts sessionLineageId; null or omitted: the account check only).
 */
export async function endSessionInBrowser(
  expectedUserId: string | null,
  signal?: AbortSignal,
  expectedLineage: string | null = null,
): Promise<EndOutcome> {
  // a browser that cannot support the synchronization contract (no Web Locks, IndexedDB or SubtleCrypto: an insecure
  // context, for one) ends nothing here and cannot name the jar's lineage: the caller asks the server, which does
  if (leaseSupport() === "unsupported") return "unavailable";
  const shared = createClient();
  // start-up (a failure or a slow outage) never blocks End Session: the local end below and the server still run
  await withDeadline(shared.auth.initialize().catch(() => null), START_DEADLINE_MS);
  // The permit is named BEFORE the section is entered, so the section admits its own lineage's refreshes from the
  // moment it holds the lock — including one already queued, which signOut's load would otherwise wait on.
  const before = await endPermit(expectedUserId, expectedLineage);
  if (before === "other_account") return "other_account";
  if (before === "unverifiable") return "unavailable";
  const section = await enterSection("end", { waitMs: END_WAIT_MS, holdMs: END_HOLD_MS, permit: before, signal });
  if (section === null) return "unavailable";
  if (!section.viewTrusted) {
    // this tab's view of the jar is not the recorded lineage (another sign-in's write may not be visible here yet):
    // nothing it sees is ended locally; the caller asks the server, which judges the cookies the request carries
    leaveSection(section);
    return "unavailable";
  }
  // the jar as it is once the lock is held (the lineage digest awaits, so the jar is compared again right after it)
  const held = readStoredSession();
  const now = await endPermit(expectedUserId, expectedLineage);
  if (activeSection() !== section) return "unavailable";
  const after = readStoredSession();
  if (held.kind !== after.kind || (held.kind === "present" && after.kind === "present" && held.envelope.refreshToken !== after.envelope.refreshToken)) {
    // inside the held section only something outside this application's writer can change the jar: end nothing here
    leaveSection(section);
    return "unavailable";
  }
  if (now === "other_account" || now === "unverifiable") {
    leaveSection(section);
    return now === "other_account" ? "other_account" : "unavailable";
  }
  const ending = after.kind === "present" ? await sessionLineageId(after.envelope.accessToken) : null;
  if (activeSection() !== section) return "unavailable";
  if (now !== null) {
    if (before !== null && before.sessionId === now.sessionId) now.refreshTokens.forEach((token) => before.refreshTokens.add(token));
    else section.permit = now;
    try {
      await withDeadline(shared.auth.signOut({ scope: "local" }), SIGN_OUT_DEADLINE_MS);
    } catch {
      // ended locally below
    }
  }
  if (activeSection() !== section) return "unavailable"; // the section's backstop ended it first: nothing more here
  await endLocally(section);
  if (activeSection() !== section) return "unavailable";
  // every view of the ended lineage ends, in this tab and in others, also where SIGNED_OUT could not be announced
  if (ending !== null) announceEndedLineage(ending);
  // "ended" only when Auth confirmed this section's revocation, or the jar already held nothing (another tab had ended
  // it); a jar that held something no request could revoke (an ambiguous or unusable layout) was removed unconfirmed
  return revocationConfirmed(section) || after.kind === "absent" ? "ended" : "ended_unconfirmed";
}

/**
 * The end permit for the jar's session: "other_account" when it belongs to another account than the page showed, or to
 * another lineage than the page was rendered for (a newer sign-in, even of the same account); "unverifiable" when the
 * page named a lineage but the jar's cannot be computed here (nothing is ended locally then); null when it holds none.
 */
async function endPermit(
  expectedUserId: string | null,
  expectedLineage: string | null,
): Promise<Extract<Permit, { kind: "end" }> | "other_account" | "unverifiable" | null> {
  const stored = readStoredSession();
  if (stored.kind !== "present") return null;
  const claims = jwtClaims(stored.envelope.accessToken);
  if (expectedUserId !== null && claims.sub !== null && claims.sub !== expectedUserId) return "other_account";
  if (isSessionLineageId(expectedLineage)) {
    const lineage = await sessionLineageId(stored.envelope.accessToken);
    if (lineage === null) return "unverifiable";
    if (lineage !== expectedLineage) return "other_account";
  }
  return { kind: "end", sessionId: claims.sessionId, refreshTokens: new Set([stored.envelope.refreshToken]) };
}

/**
 * A2: whether the server has already ended `session`'s lineage while its removal from this browser is still pending
 * (the END INTENT names it): such a session is not used for anything (its access token stays signature-valid until it
 * expires, but its owner ended it). Never throws; false when nothing can be computed.
 */
export async function sessionEndPending(session: unknown): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const intent = readEndIntent(parseCookieHeader(document.cookie));
  const token = sessionAccessToken(session);
  if (intent === null || token === null) return false;
  return (await sessionLineageId(token)) === intent;
}

// ─── Views of an ended lineage (A2) ───────────────────────────────────────────────────────────────────────────────

const ENDED_CHANNEL = "swingproai:session-ended";
const RECENTLY_ENDED_LIMIT = 8;
const endedListeners = new Set<(lineage: string) => void>();
/** Lineages ended recently in this tab's knowledge, so a watcher whose digest finishes after the notice still ends. */
const recentlyEnded: string[] = [];
let endedChannel: BroadcastChannel | null | undefined;

function deliverEnded(lineage: string): void {
  if (!recentlyEnded.includes(lineage)) {
    recentlyEnded.push(lineage);
    if (recentlyEnded.length > RECENTLY_ENDED_LIMIT) recentlyEnded.shift();
  }
  endedListeners.forEach((listener) => {
    try {
      listener(lineage);
    } catch {
      // one view's failure never stops another's
    }
  });
}

/** This tab's channel for ended-lineage notices (null where BroadcastChannel is missing: this tab only). */
function endedNotices(): BroadcastChannel | null {
  if (endedChannel !== undefined) return endedChannel;
  try {
    endedChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(ENDED_CHANNEL) : null;
    endedChannel?.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      const lineage = data !== null && typeof data === "object" ? (data as { lineage?: unknown }).lineage : undefined;
      if (isSessionLineageId(lineage)) deliverEnded(lineage);
    });
  } catch {
    endedChannel = null;
  }
  return endedChannel;
}

/** Tells every view of `lineage` (this tab and others) that it ended. Carries the digest only: no token, no account. */
export function announceEndedLineage(lineage: string): void {
  if (!isSessionLineageId(lineage)) return;
  deliverEnded(lineage);
  try {
    endedNotices()?.postMessage({ lineage });
  } catch {
    // other tabs then learn it from the SDK's SIGNED_OUT or their next read
  }
}

/** The access token a session object carries (the SDK's session shape), or null. Never throws. */
function sessionAccessToken(session: unknown): string | null {
  if (session === null || typeof session !== "object") return null;
  try {
    const token = (session as Record<string, unknown>)["access_token"];
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onEnded` once when End Session — in this tab or another — ends the lineage of `session` (a session object as
 * the SDK hands it out). Returns the unsubscribe. A session whose lineage cannot be named is never ended by a notice
 * (its views still end on the SDK's SIGNED_OUT or their next read); any other lineage's notice is ignored.
 */
export function watchSessionEnd(session: unknown, onEnded: () => void): () => void {
  const token = sessionAccessToken(session);
  if (token === null) return () => undefined;
  return watchLineage(sessionLineageId(token), onEnded);
}

/**
 * A3: the same for a lineage already known — the one the dashboard was rendered for (components/navigation/
 * SessionKeeper.tsx RenderedSessionProvider), so a page ends its view of that sign-in from the moment it mounts, without
 * reading a session first. A value that is not a lineage digest watches nothing. Returns the unsubscribe.
 */
export function watchLineageEnd(lineage: unknown, onEnded: () => void): () => void {
  if (!isSessionLineageId(lineage)) return () => undefined;
  return watchLineage(Promise.resolve(lineage), onEnded);
}

function watchLineage(named: Promise<string | null>, onEnded: () => void): () => void {
  let lineage: string | null = null;
  let done = false;
  const stop = () => {
    done = true;
    endedListeners.delete(listener);
  };
  const listener = (ended: string) => {
    if (done || lineage === null || ended !== lineage) return;
    stop();
    onEnded();
  };
  endedListeners.add(listener);
  endedNotices();
  void named.then(
    (id) => {
      if (done) return;
      if (id === null) return stop();
      lineage = id;
      if (recentlyEnded.includes(id)) listener(id);
    },
    () => stop(),
  );
  return stop;
}

// ─── Completing an End Session the server revoked (A2) ────────────────────────────────────────────────────────────

/**
 * - "none": no End Session intent here (a plain visit): nothing was looked at or changed.
 * - "completed": the ended lineage is no longer in this browser (removed now, or already gone); SIGNED_OUT announced.
 * - "kept_other": the jar holds another sign-in (another account, or a newer sign-in of the same one); it was kept.
 * - "pending": the lease, or a verified view of the jar, was not available now; nothing changed and the intent stays
 *   (single-use, as long as the session cookies) for an explicit retry.
 * - "unsupported": this browser cannot support the synchronization contract, so its copy cannot be removed safely here.
 */
export type EndCompletion = "none" | "completed" | "kept_other" | "pending" | "unsupported";

/** The completion's section: its own work is bounded (a digest, one removal and its record, one announcement). */
const COMPLETE_HOLD_MS = 15_000;

/** Whether this browser carries an End Session intent (synchronous; the sign-in page shows progress only then). */
export function endIntentPending(): boolean {
  return typeof document !== "undefined" && readEndIntent(parseCookieHeader(document.cookie)) !== null;
}

function clearEndIntent(): void {
  document.cookie = serialize(END_INTENT_COOKIE, "", {
    path: "/",
    sameSite: "lax",
    secure: window.location.protocol === "https:",
    maxAge: 0,
  });
}

/** Acts once on the server's End Session intent, if there is one (see the header). Never rejects. */
export async function completeEndedSession(signal?: AbortSignal): Promise<EndCompletion> {
  if (typeof document === "undefined") return "none";
  const intent = readEndIntent(parseCookieHeader(document.cookie));
  if (intent === null) return "none";
  // the server confirmed this lineage's revocation: its views end now, whatever happens to this browser's copy below
  announceEndedLineage(intent);
  if (leaseSupport() === "unsupported") return "unsupported";
  try {
    createClient(); // configures the lease and the storage (its key, its lineage store)
  } catch {
    return "pending";
  }
  const section = await enterSection("end", { waitMs: END_WAIT_MS, holdMs: COMPLETE_HOLD_MS, signal });
  if (section === null) return "pending";
  try {
    // a view of the jar that is not the recorded lineage could be hiding a newer sign-in: decide nothing on it
    if (!section.viewTrusted) return "pending";
    const stored = readStoredSession();
    if (stored.kind === "present") {
      const lineage = await sessionLineageId(stored.envelope.accessToken);
      if (activeSection() !== section) return "pending";
      // compared immediately before the removal: the jar must still hold exactly the session whose lineage was read
      const now = readStoredSession();
      if (now.kind !== "present" || now.envelope.refreshToken !== stored.envelope.refreshToken) return "pending";
      if (lineage !== intent) {
        clearEndIntent();
        return "kept_other";
      }
      section.permit = {
        kind: "end",
        sessionId: jwtClaims(now.envelope.accessToken).sessionId,
        refreshTokens: new Set([now.envelope.refreshToken]),
      };
      await endLocally(section);
      if (activeSection() !== section || readStoredSession().kind === "present") return "pending";
      await withDeadline(announceSessionRemoved().catch(() => undefined), ANNOUNCE_DEADLINE_MS);
      clearEndIntent();
      return "completed";
    }
    if (stored.kind !== "absent") return "pending"; // not a session anyone can use, but not provably the ended one
    clearEndIntent();
    return "completed";
  } catch {
    return "pending";
  } finally {
    leaveSection(section);
  }
}

// ─── Requests sent only as the account a page was rendered for (A3; A4) ──────────────────────────────────────────
//
// A page rendered for one account (the dashboard layout's verified owner: components/navigation/SessionKeeper.tsx
// RenderedSessionProvider) must never send one of its requests with another account's credential — not even in the
// moment between its own identity check and the request leaving, when another tab may publish another sign-in before
// this tab has been told. Every such request carries an explicit credential confirmed for the owner at the moment it is
// attached (lib/drill-hub-session.ts confirmOwnerSession / ownerBoundClient / ownerBearer): PostgREST and Storage
// through the owner-bound client, and same-origin routes that verify a Bearer token themselves (/api/v1/analyses and,
// A4, /api/analyze-swing: utils/supabase/server.ts resolveRouteAuth) with that Bearer and `credentials: "omit"`, so no
// cookie — whatever any writer, inside or outside this application, puts in the jar after the confirmation — travels
// with them. A4 retired A3's cookie-only dispatch (a "dispatch" lease section held until an XHR was sent): with Bearer
// ingress on the analysis route it had no remaining caller, and no session lease is held across any request.

/** Why a request meant for the page's account was not sent (it never left the browser). */
export type OwnerRefusal = "signed_out" | "unconfirmed" | "unavailable" | "account_changed" | "ended";
