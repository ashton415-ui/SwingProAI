import { DEFAULT_COOKIE_OPTIONS, parse, serialize } from "@supabase/ssr";
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import {
  MAX_SESSION_CHUNKS,
  NO_SESSION_BINDING,
  SESSION_BINDING_COOKIE,
  SESSION_COOKIE_MAX_AGE_S,
  authStorageRoots,
  familyNames,
  jwtClaims,
  parseCookieHeader,
  planFamilyRemoval,
  planSessionWrite,
  readBinding,
  readEnvelope,
  readSessionLayout,
  sessionBinding,
  withStoredExpiry,
  withUsableExpiry,
  type CookieOperation,
  type SessionEnvelope,
} from "@/utils/supabase/session-cookie-layout";
import {
  abandonCommit,
  activeSection,
  checkView,
  commitLineage,
  configureLineage,
  enterSection,
  leaseCounters,
  leaseSupport,
  leaveSection,
  noteOwnChange,
  observeCommit,
  tenureAdmits,
  type JarView,
  type Permit,
  type Section,
  type Unverified,
} from "@/utils/supabase/session-lease";

// ============================================================================
// Browser session storage (the SDK's `auth.storage`; browser only)
// ============================================================================
//
// The installed @supabase/ssr 0.3.0 browser storage writes a session's chunks
// without removing the names it does not reuse, so an older bare cookie shadows
// a newer chunked session (both it and every server reader take the bare key
// first), a shorter session leaves a stale higher chunk that corrupts the join,
// and its removal deletes only the bare key when one exists, which brings back
// an older chunked session. This storage replaces it for the session key:
// layouts follow utils/supabase/session-cookie-layout.ts, written in an order
// in which no reader sees no session or a join of two sessions, read back
// after every write, and removed in full. Every session write or removal also
// sets the server-visible binding cookie in the same synchronous step (the
// digest of the access token stored, or "none"; see session-cookie-layout.ts).
//
// Reading. A session read outside this tab's own held section (the SDK's
// getSession, its start-up, its ticker, every data request's token, a
// subscriber's INITIAL_SESSION) hands the SDK a session only when the jar it
// read is the recorded lineage (session-lease.ts checkView: read first, record
// after, a differing view waited out for up to 500 ms). Otherwise — this tab's
// view is older than the record, the session was never recorded (a writer
// outside the contract), or nothing can be verified (no IndexedDB/SubtleCrypto,
// a failed or slow lineage read) — the read is REFUSED: it throws the SDK's
// own retryable error, marked as unverified (sessionUnverifiedReason), so
// getSession rejects and its callers report "unavailable". It is never handed
// over as the session it saw and never as "no session" (which would read as a
// sign-out), and nothing is removed. Inside this tab's held section no other
// writer of this application can change the jar: the section's own verdict
// decides, and the jar must still be exactly what this tenure verified or last
// wrote (session-lease.ts tenureAdmits) — a write by anything outside the
// contract landing during the section (a previous bundle's page) is refused the
// same way.
//
// Writing. Every change to the session key is a compare-and-set inside a held
// section of utils/supabase/session-lease.ts, read and written in one
// synchronous step:
// - a save of the token the jar already holds is a no-op (nothing is rewritten,
//   so a stale view can never write an older copy over a newer session);
// - a save of a new token is accepted only when it continues the stored
//   session — the answer to a refresh of exactly the token the jar holds
//   (recorded by the client's transport as it hands the answer to the SDK), in a
//   section whose view of the jar is current (session-lease.ts: lineage) — or is
//   a publication whose permit names it (a sign-in);
// - a removal is accepted only for the stored session whose refusal the
//   transport handed over, the lineage an End Session section is ending, or a
//   jar holding no session the SDK would accept.
// A refused save throws the SDK's own retryable error before the SDK records or
// announces anything: no TOKEN_REFRESHED or SIGNED_IN describes a session that
// was not stored, and the caller gets an error result (no removal, no rejection).
// After every change the resulting lineage is recorded before the SDK is told
// the change is done, so no announcement precedes its record. When that record
// cannot be committed (the section ended first, or the store failed or ran out
// of time) the change is NOT acknowledged and the tenure is no longer trusted: a
// save throws the same retryable error (the SDK announces nothing) and its
// binding is set to "none" in the same step: the server and every browser
// reader refuse a session whose binding is "none", also where nothing was ever
// recorded (sessionRefusedByBinding); a removal's SIGNED_OUT
// reaches only this tab's own subscribers, never other tabs (client.ts). A refused removal never throws (a
// throw inside the SDK's refusal commit would leave its single-flight refresh
// unresolved for every caller waiting on it): it is skipped and counted, and
// the SIGNED_OUT the SDK then announces is dropped by the event fence in
// utils/supabase/client.ts because the lineage still names a session.
//
// A4 (C4): every session this storage writes is stored with `expires_at: null`
// (the key kept), so a previous bundle's SDK never refreshes it on its own, and
// every read hands the SDK the same session with the expiry reconstructed from
// the access token's `exp` claim (session-cookie-layout.ts withStoredExpiry /
// withUsableExpiry). The compare-and-set rules below compare tokens, never the
// expiry, and are unchanged.
//
// Session cookies keep the established attributes: Path=/, SameSite=Lax, no
// Domain, not HttpOnly (the SDK reads them), Secure on an HTTPS page, Max-Age
// 30 days; a removal is Max-Age=0 with the same attributes. The binding cookie
// has the same attributes (never removed). Other keys (the PKCE verifier, the
// separate user) keep the SDK's own options, as before. Diagnostics are counts
// only, readable by tests and the offline harness as
// globalThis.__swingproaiSessionDiagnostics().

/** Longer than any bounded section (End Session's hold is the longest), so a change waits rather than fails. */
const CHANGE_WAIT_MS = 35_000;
/** Records of answers handed to the SDK are kept this long. */
const RECORD_TTL_MS = 60_000;

let sessionKey: string | null = null;
/** new refresh token → the token whose refresh returned it */
const continuations = new Map<string, { readonly origin: string; readonly at: number }>();
/** refresh tokens whose refusal (Auth's, or a local one for an emptied jar) was handed to the SDK */
const refusals = new Map<string, number>();
/** sections that changed the jar without their lineage record landing: nothing they did is announced */
const unrecordedChanges = new WeakSet<Section>();
const counters = {
  refusedSaves: 0,
  oversizedSaves: 0,
  writeVerifyFailures: 0,
  refusedRemovals: 0,
  skippedRemovals: 0,
  unusableRemovals: 0,
  endedLocally: 0,
  revoked: 0,
  revocationNotReached: 0,
  refreshSent: 0,
  localAnswers: 0,
  droppedEvents: 0,
  fencedInitialSessions: 0,
  announcedPublications: 0,
  unverifiedReads: 0,
  unrecordedChanges: 0,
  anonymousRefused: 0, // A2: data requests that would have left with only the anonymous key (client.ts)
};
export type SessionOutcome =
  | "revoked"
  | "revocationNotReached"
  | "refreshSent"
  | "localAnswers"
  | "droppedEvents"
  | "fencedInitialSessions"
  | "announcedPublications"
  | "anonymousRefused";

export type StoredSession =
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous"; readonly names: readonly string[] }
  /** a complete layout whose value is not a session the SDK accepts (auth-js _isValidSession) */
  | { readonly kind: "unusable"; readonly value: string; readonly names: readonly string[] }
  | { readonly kind: "present"; readonly value: string; readonly names: readonly string[]; readonly envelope: SessionEnvelope };

const refused = () => new AuthRetryableFetchError("Session write refused", 0);

const UNVERIFIED_MARK = "__swingproaiSessionUnverified";

/**
 * The SDK's own retryable error, marked: a session read that could not be verified (see the header). Its message is fixed
 * golfer-facing text, because some pages show an SDK error's message as it is.
 */
const UNVERIFIED_MESSAGE = "We couldn't confirm your sign-in on this device. Refresh the page, or sign in again.";
function unverified(reason: Unverified): AuthRetryableFetchError {
  counters.unverifiedReads += 1;
  const error = new AuthRetryableFetchError(UNVERIFIED_MESSAGE, 0);
  Object.defineProperty(error, UNVERIFIED_MARK, { value: reason, enumerable: false });
  return error;
}

/**
 * Why a session read was refused (an error from getSession, refreshSession or a data request), or null when the error
 * is not such a refusal. "unsupported": this browser cannot support the synchronization contract at all.
 */
export function sessionUnverifiedReason(error: unknown): Unverified | null {
  if (error === null || typeof error !== "object") return null;
  try {
    const reason = (error as Record<string, unknown>)[UNVERIFIED_MARK];
    return reason === "stale" || reason === "unrecorded" || reason === "unavailable" || reason === "unsupported" ? reason : null;
  } catch {
    return null;
  }
}

/** Whether this section changed the jar without its lineage record landing (its announcements are not delivered). */
export function sectionChangeUnrecorded(section: Section): boolean {
  return unrecordedChanges.has(section);
}

function prune(now: number): void {
  continuations.forEach((record, token) => {
    if (now - record.at > RECORD_TTL_MS) continuations.delete(token);
  });
  refusals.forEach((at, token) => {
    if (now - at > RECORD_TTL_MS) refusals.delete(token);
  });
}

/** The transport hands the SDK a refresh answer for `origin` that carries `result`. */
export function recordContinuation(origin: string, result: string): void {
  const now = Date.now();
  prune(now);
  continuations.set(result, { origin, at: now });
}

/** The transport hands the SDK a refusal of `token` (Auth's, or local for an emptied jar). */
export function recordRefusal(token: string): void {
  const now = Date.now();
  prune(now);
  refusals.set(token, now);
}

/** Count-only diagnostics. */
export function countSessionOutcome(name: SessionOutcome): void {
  counters[name] += 1;
}
export function sessionDiagnostics() {
  return { ...counters, ...leaseCounters() };
}

/** The jar's session as this application defines it (synchronous; document.cookie). */
export function readStoredSession(): StoredSession {
  if (sessionKey === null || typeof document === "undefined") return { kind: "absent" };
  const layout = readSessionLayout(parseCookieHeader(document.cookie), sessionKey);
  if (layout.kind === "absent") return layout;
  if (layout.kind === "ambiguous") return layout;
  const envelope = readEnvelope(layout.value);
  // auth-js accepts a stored session only with access_token, refresh_token and expires_at present (_isValidSession)
  return envelope === null || !("expires_at" in envelope.stored)
    ? { kind: "unusable", value: layout.value, names: layout.names }
    : { kind: "present", value: layout.value, names: layout.names, envelope };
}

function viewOf(stored: StoredSession): JarView {
  if (stored.kind === "present") return { kind: "present", refreshToken: stored.envelope.refreshToken };
  return stored.kind === "absent" ? { kind: "absent" } : { kind: "unsettled" };
}

/** The jar as the lease's lineage check sees it. */
export function storedJarView(): JarView {
  return viewOf(readStoredSession());
}

/**
 * A session the binding refuses outright: the jar holds a session while its binding says "none" — a change whose record
 * did not land, or a session written after a removal by something outside the contract. The server refuses it
 * (session-cookie-layout.ts bindingAdmits), so every browser reader refuses it too, also where nothing was ever recorded.
 */
export function sessionRefusedByBinding(stored: StoredSession = readStoredSession()): boolean {
  if (stored.kind !== "present") return false;
  const binding = readBinding(parseCookieHeader(document.cookie));
  return binding.kind === "present" && binding.value === NO_SESSION_BINDING;
}

/**
 * The jar's session, verified against the recorded lineage (see "Reading" in the header). Throws the marked retryable
 * error when it cannot be verified. Inside this tab's held section the section's own verdict decides.
 */
export async function verifiedStoredSession(): Promise<StoredSession> {
  const section = activeSection();
  if (section !== null) {
    const stored = readStoredSession();
    if (!section.viewTrusted || unrecordedChanges.has(section)) throw unverified(leaseSupport() === "unsupported" ? "unsupported" : "stale");
    // the jar must still be what this tenure verified or wrote: anything else was written outside the contract meanwhile
    if (!tenureAdmits(viewOf(stored)) || sessionRefusedByBinding(stored)) throw unverified("unrecorded");
    return stored;
  }
  const checked = await checkView(() => {
    const stored = readStoredSession();
    return { value: stored, view: viewOf(stored) };
  }, true);
  if (!checked.verified) throw unverified(checked.reason);
  if (sessionRefusedByBinding(checked.value)) throw unverified("unrecorded");
  return checked.value;
}

function presentFamily(root: string): string[] {
  return familyNames(parseCookieHeader(document.cookie), [root]);
}

/**
 * Every name the session family may hold: what this tab sees, plus the bare key and every chunk index a reader
 * accepts. A write or removal plans over all of them, so a name this tab's view does not show yet (another context's
 * write not visible here) is removed as well and can never be left beside the new layout; removing a name that is not
 * there changes nothing.
 */
function sessionFamilyNames(key: string): string[] {
  const names = new Set(presentFamily(key));
  names.add(key);
  for (let index = 0; index < MAX_SESSION_CHUNKS; index++) names.add(`${key}.${index}`);
  return Array.from(names);
}

function cookieAttributes(maxAge: number) {
  return { path: "/", sameSite: "lax" as const, secure: window.location.protocol === "https:", maxAge };
}

function applySession(operations: readonly CookieOperation[]): void {
  for (const operation of operations) {
    document.cookie = serialize(operation.name, operation.value ?? "", cookieAttributes(operation.value === null ? 0 : SESSION_COOKIE_MAX_AGE_S));
  }
}

/** Sets the server-visible binding (same step as the session change); true when the jar now holds exactly it. */
function writeBinding(value: string): boolean {
  document.cookie = serialize(SESSION_BINDING_COOKIE, value, cookieAttributes(SESSION_COOKIE_MAX_AGE_S));
  const read = readBinding(parseCookieHeader(document.cookie));
  return read.kind === "present" && read.value === value;
}

function removeFamily(): void {
  const key = sessionKey as string;
  applySession(planFamilyRemoval(sessionFamilyNames(key), key));
  writeBinding(NO_SESSION_BINDING);
  noteOwnChange({ kind: "absent" });
}

function removeRoot(root: string): void {
  for (const name of presentFamily(root)) document.cookie = serialize(name, "", { ...DEFAULT_COOKIE_OPTIONS, maxAge: 0 });
}

function inLineage(permit: Extract<Permit, { kind: "end" }>, envelope: SessionEnvelope): boolean {
  if (permit.refreshTokens.has(envelope.refreshToken)) return true;
  const sessionId = jwtClaims(envelope.accessToken).sessionId;
  return permit.sessionId !== null && sessionId === permit.sessionId;
}

/** Runs a change inside the held active section, or inside a storage section of its own. */
async function change<T>(work: (section: Section) => Promise<T>, unavailable: () => T): Promise<T> {
  const current = activeSection();
  if (current !== null) return work(current);
  const section = await enterSection("storage", { waitMs: CHANGE_WAIT_MS });
  if (section === null) return unavailable();
  try {
    return await work(section);
  } finally {
    leaveSection(section);
  }
}

/** The save rule for a token the jar does not hold yet (see the header). Synchronous. */
function newTokenAllowed(section: Section, stored: StoredSession, next: SessionEnvelope): boolean {
  const permit = section.permit;
  if (permit?.kind === "publish" && permit.refreshToken === next.refreshToken) return true;
  const continuation = continuations.get(next.refreshToken);
  if (continuation === undefined) return false;
  // a publication whose new token had to be refreshed first
  if (permit?.kind === "publish" && permit.refreshToken === continuation.origin) return true;
  // a refresh answer continues the stored session only when this section's view of the jar is current
  const storedToken = stored.kind === "present" ? stored.envelope.refreshToken : null;
  return section.viewTrusted && storedToken !== null && continuation.origin === storedToken;
}

/**
 * The synchronous compare-and-set of a save (with its binding, computed beforehand); throws the SDK's retryable error
 * when refused. Returns true when the jar changed (and its lineage must be recorded).
 */
function saveSession(section: Section, value: string, next: SessionEnvelope, binding: string): boolean {
  const key = sessionKey as string;
  const stored = readStoredSession();
  if (stored.kind === "present" && stored.envelope.refreshToken === next.refreshToken) {
    observeCommit(next.refreshToken); // already stored: nothing is rewritten
    return false;
  }
  if (!newTokenAllowed(section, stored, next)) {
    counters.refusedSaves += 1;
    abandonCommit();
    throw refused();
  }
  const plan = planSessionWrite(sessionFamilyNames(key), key, value);
  if (plan === null) {
    counters.oversizedSaves += 1;
    abandonCommit();
    throw refused();
  }
  applySession(plan);
  const written = readStoredSession();
  if (written.kind !== "present" || written.value !== value || !writeBinding(binding)) {
    // The browser did not keep the layout (or its binding) as written (a cookie refused or truncated): never
    // acknowledge it. What is left is removed, so the jar is empty rather than ambiguous, and the SDK reports an error.
    removeFamily();
    counters.writeVerifyFailures += 1;
    abandonCommit();
    throw refused();
  }
  continuations.delete(next.refreshToken);
  if (section.permit?.kind === "end") section.permit.refreshTokens.add(next.refreshToken);
  noteOwnChange({ kind: "present", refreshToken: next.refreshToken });
  observeCommit(next.refreshToken);
  return true;
}

/** The synchronous compare-and-set of a removal; never throws. Returns true when the jar changed. */
function removeSession(section: Section): boolean {
  const stored = readStoredSession();
  const expected = section.kind === "refresh" && section.expect !== null && section.expect.result === null ? section.expect.origin : null;
  if (!section.viewTrusted) {
    // this section's view of the jar is not current (session-lease.ts: lineage): it removes nothing it sees
    counters.skippedRemovals += 1;
    if (expected !== null) observeCommit(expected);
    return false;
  }
  if (stored.kind === "absent") {
    if (expected !== null) refusals.delete(expected);
    if (expected !== null) observeCommit(expected); // the SDK's removal after a refusal for an emptied jar: nothing to remove
    return false;
  }
  if (stored.kind !== "present") {
    removeFamily();
    counters.unusableRemovals += 1;
    if (expected !== null) observeCommit(expected);
    return true;
  }
  const token = stored.envelope.refreshToken;
  const permit = section.permit;
  const refusedHere = token === expected || (section.viewTrusted && refusals.has(token));
  if (refusedHere || (permit?.kind === "end" && inLineage(permit, stored.envelope))) {
    removeFamily();
    refusals.delete(token);
    observeCommit(token);
    return true;
  }
  // Another sign-in's session is stored (or this section's view is not current). It stays; the SIGNED_OUT the SDK
  // announces next is dropped by the event fence, because the lineage names a session.
  counters.skippedRemovals += 1;
  if (expected !== null) observeCommit(expected);
  return false;
}

/**
 * Records the jar's lineage after `section` changed it; false (and the section marked) when the record did not land.
 * A save whose record did not land also loses its binding ("none"): the server refuses that session, as the browser does.
 */
async function record(section: Section, view: JarView, anchors = false): Promise<boolean> {
  const recorded = await commitLineage(section, view, anchors);
  if (!recorded) {
    unrecordedChanges.add(section);
    counters.unrecordedChanges += 1;
    // only over this section's own write: a later holder's session (this section ended meanwhile) keeps its binding
    const now = storedJarView();
    if (view.kind === "present" && now.kind === "present" && now.refreshToken === view.refreshToken) writeBinding(NO_SESSION_BINDING);
  }
  return recorded;
}

/**
 * Publishes a session object as Auth returned it, inside the caller's held publish section (used only when the SDK's
 * setSession would refresh it first). True when stored AND recorded; the caller announces it.
 */
export async function publishDirect(section: Section, session: object): Promise<boolean> {
  if (section.permit?.kind !== "publish" || activeSection() !== section) return false;
  const value = withStoredExpiry(JSON.stringify(session)); // A4 (C4): stored with a null expiry
  const next = readEnvelope(value);
  if (next === null || !("expires_at" in next.stored)) return false;
  const binding = await sessionBinding(next.accessToken);
  if (binding === null || activeSection() !== section) return false;
  try {
    if (saveSession(section, value, next, binding) && !(await record(section, { kind: "present", refreshToken: next.refreshToken }, true))) return false;
  } catch {
    return false;
  }
  const stored = readStoredSession();
  return stored.kind === "present" && stored.envelope.refreshToken === next.refreshToken && !unrecordedChanges.has(section);
}

/**
 * End Session's local completion inside its held section: removes what remains of the lineage being ended (or a jar
 * that holds no usable session), with the PKCE verifier and separate-user roots; never another sign-in's session.
 */
export async function endLocally(section: Section): Promise<void> {
  // a section whose view of the jar is not current ends nothing here (it could be another sign-in's session by name)
  if (section.kind !== "end" || activeSection() !== section || sessionKey === null || !section.viewTrusted) return;
  const stored = readStoredSession();
  const key = sessionKey;
  const permit = section.permit;
  const ours =
    stored.kind === "ambiguous" ||
    stored.kind === "unusable" ||
    (stored.kind === "present" && permit?.kind === "end" && inLineage(permit, stored.envelope));
  if (ours) {
    removeFamily();
    counters.endedLocally += 1;
  }
  if (stored.kind === "absent" || ours) for (const root of authStorageRoots(key).slice(1)) removeRoot(root);
  if (ours) await record(section, { kind: "absent" });
}

/**
 * The SDK storage for the session key `key`. A plain object (not a class instance): @supabase/ssr merges the given
 * `auth.storage` into its own with ramda's mergeDeepRight, which copies own properties only.
 */
export function createSessionStorage(key: string) {
  sessionKey = key;
  configureLineage({ jarView: storedJarView });
  if (typeof globalThis !== "undefined" && !("__swingproaiSessionDiagnostics" in globalThis)) {
    Object.defineProperty(globalThis, "__swingproaiSessionDiagnostics", { value: sessionDiagnostics, configurable: true });
  }
  return {
    isServer: false,
    async getItem(name: string): Promise<string | null> {
      if (typeof document === "undefined") return null;
      if (name !== key) return parse(document.cookie)[name] ?? null;
      // Only a verified, usable session is handed to the SDK (see "Reading" in the header). A verified jar holding an
      // ambiguous layout or an unusable value is no session: the SDK then has nothing to remove (a removal it cannot
      // make would announce SIGNED_OUT, whose realtime handler reads the session again — a loop); a trusted End Session
      // or the next publication removes such names.
      const stored = await verifiedStoredSession();
      // A4 (C4): the SDK gets the expiry the access token states (it is stored as null)
      return stored.kind === "present" ? withUsableExpiry(stored.value) : null;
    },
    async setItem(name: string, sdkValue: string): Promise<void> {
      if (typeof document === "undefined") return;
      if (name !== key) {
        document.cookie = serialize(name, sdkValue, { ...DEFAULT_COOKIE_OPTIONS });
        return;
      }
      // A4 (C4): stored with `expires_at: null` (the key kept): a previous bundle's SDK never refreshes it by itself
      const value = withStoredExpiry(sdkValue);
      const next = readEnvelope(value);
      const binding = next === null ? null : await sessionBinding(next.accessToken);
      if (next === null || binding === null) {
        counters.refusedSaves += 1;
        abandonCommit();
        throw refused();
      }
      await change(
        async (section) => {
          if (!saveSession(section, value, next, binding)) return;
          if (!(await record(section, { kind: "present", refreshToken: next.refreshToken }, section.permit?.kind === "publish"))) {
            // stored but not recorded: never acknowledged (no announcement), and every reader refuses it (fail closed)
            abandonCommit();
            throw refused();
          }
        },
        () => {
          counters.refusedSaves += 1;
          throw refused();
        },
      );
    },
    async removeItem(name: string): Promise<void> {
      if (typeof document === "undefined") return;
      if (name !== key) {
        removeRoot(name);
        return;
      }
      await change(
        async (section) => {
          if (removeSession(section)) await record(section, { kind: "absent" });
        },
        () => {
          counters.skippedRemovals += 1;
        },
      );
    },
  };
}
