// ============================================================================
// Session-publication lease (browser only)
// ============================================================================
//
// Every change this application makes to the browser's session cookies — a
// refresh committed by the SDK, a refusal's removal, a sign-in's publication,
// End Session — happens inside a SECTION. Sections are mutually exclusive:
//
// - within the tab, through a FIFO queue (one active section at a time);
// - across tabs and windows of this origin, through one exclusive Web Lock
//   (`navigator.locks`, name `swingproai:session-publication:<storage key>`)
//   that the tab holds while it has an active or queued section and releases
//   when it has none. The lock is never stolen and never requested with
//   `steal`; a waiter that runs out of time, or whose caller cancels, gives up
//   and its request is aborted, so it can never be granted later (the SDK's own
//   navigatorLock steals on timeout, which is why it is not used).
//
// A section counts as active (activeSection()) only once this tab HOLDS the
// lock and has settled its view of the jar (below); until then nothing runs
// inside it. A section's critical step (read the jar, compare, write) is
// synchronous, so under this exclusion no other tab's SwingProAI code can change
// the jar between the comparison and the write. The server writes and removes
// no session cookie at all (see app/api/auth/signout/route.ts).
//
// SYNCHRONIZATION CONTRACT (supported: browsers with Web Locks, IndexedDB and
// SubtleCrypto in a secure context — every current engine over HTTPS or on
// localhost). Web Locks order the holders but say nothing about when a cookie
// written by one holder becomes visible to document.cookie in another process.
// So every holder that changes the jar appends the resulting LINEAGE — a digest
// of the stored refresh token, or "none" — to an IndexedDB record in one
// read-write transaction, and waits for it to complete, before it lets the SDK
// announce the change and before it releases the lock. IndexedDB orders
// transactions on the same record, so the next holder, which reads the record
// after it acquires the lock, sees every earlier append. Before anything acts
// on a view of the jar it compares that view with the latest recorded lineage
// (the view is read FIRST and the record after it, so "equal" means the view
// was still the latest at a moment after it was read):
// - equal (or nothing recorded yet in this browser): the view is current;
// - anything else — an EARLIER recorded lineage (a previous holder's writes are
//   not visible here yet), or one never recorded (a writer outside this
//   contract: a cleared or expired cookie, a tab still running a previous
//   bundle, a holder that stopped before it could record) — is waited out for
//   up to VIEW_SETTLE_MS, and if the view still differs it is UNTRUSTED.
// FAIL CLOSED. A section whose view is untrusted sends no refresh, writes no
// continuation of what it sees, removes nothing and ends nothing here; a session
// read outside a section (session-storage.ts getItem) that cannot be verified is
// refused (reported as unavailable, never as signed out and never as the
// session it saw); an identity announcement that cannot be verified is not
// delivered (client.ts). Where Web Locks, IndexedDB or SubtleCrypto is missing,
// or a lineage read or append fails or runs out of time, nothing is verified:
// the same refusals apply (counted: noWebLocks / lineageUnavailable /
// lineageWriteFailures), and leaseSupport() tells callers when the browser
// cannot support the contract at all, so they can say so. Only a write that
// names its own outcome — a sign-in's publication (its permit) — re-anchors the
// lineage, and only when its record lands while its section is still held; trust
// then holds for the rest of this tab's tenure of the lock.
//
// SECTION LIFETIME. Each section carries a signal that aborts when the section
// ends (left, backstop, expiry). Lineage work started inside a section is bound
// to it: after every await the section must still be the active one, and the
// append checks the signal immediately before it opens its transaction and
// aborts the transaction if the section ends before it commits. So work that
// outlives its section — a digest still being computed when a backstop fired —
// can never append an obsolete lineage after a later holder's record, and never
// sets this tab's tenure trusted afterwards.
//
// OBSERVED LINEAGE. Every record this tab reads is kept as the newest it has
// seen (by record epoch and sequence; it never moves backwards). The event
// fence decides each delivery synchronously against it, so an identity
// announcement older than any lineage this tab has already seen is never
// delivered, whatever order the asynchronous checks finished in.
//
// Kinds:
// - "refresh": one refresh request, from before it is sent until the SDK has
//   committed its answer AND dispatched the announcement of that commit
//   (TOKEN_REFRESHED, or SIGNED_OUT for a refusal), or the SDK's refresh call
//   has settled without one (a refused save, its own discard), or a backstop.
//   It is released when the announcement is DISPATCHED — the SDK has posted it
//   to other tabs and started this tab's subscribers — never after awaiting the
//   subscribers, so a subscriber that calls back into the SDK cannot deadlock
//   on the lease.
// - "publish": a sign-in's publication; its permit names the new refresh token.
// - "end": End Session; its permit names the lineage being ended. Held until the
//   page unloads (the form post navigates away), with a backstop.
// - "storage": a storage change the SDK makes outside any other section.
//
// A refresh request for a token named by the permit of a held publish or end
// section runs inside it (that section's own SDK call needs it). Refresh requests
// already queued when such a section becomes held are admitted the same way, so
// the SDK's per-client single-flight refresh can never wait on a request queued
// behind the section that is waiting for it. Any other request waits its turn.

export type SectionKind = "refresh" | "publish" | "end" | "storage";

export type Permit =
  | { readonly kind: "publish"; readonly refreshToken: string }
  | {
      readonly kind: "end";
      /** the JWT session_id of the session being ended, when its token states one */
      readonly sessionId: string | null;
      /** the refresh tokens of that session seen during this section (grows when the section's refresh commits) */
      readonly refreshTokens: Set<string>;
    };

/** What the jar holds, as the storage reads it (synchronous; document.cookie). */
export type JarView =
  | { readonly kind: "present"; readonly refreshToken: string }
  | { readonly kind: "absent" }
  /** an ambiguous layout, or a complete one that is not a usable session */
  | { readonly kind: "unsettled" };

export interface Section {
  readonly id: number;
  readonly kind: SectionKind;
  permit: Permit | null;
  /** true once this tab holds the cross-tab lock for this section and has settled its view */
  held: boolean;
  /** false when this section's view of the jar is not the recorded lineage, or could not be verified: fail closed */
  viewTrusted: boolean;
  /** this tenure's verdict on the jar: "verified", or why not (an unverifiable store or browser is not a stale view) */
  viewCheck: "verified" | Unverified;
  /** refresh sections: the commit the SDK will make with the answer handed to it */
  expect: { readonly origin: string; readonly result: string | null } | null;
  /** refresh sections: the SDK has made (or skipped) that commit; the section now waits for its announcement */
  committed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** aborts when the section ends (left, backstop, expiry): work bound to the section stops there */
  readonly lifetime: AbortController;
}

export interface RefreshHandle {
  readonly section: Section;
  /** true: running inside a held publish/end section whose permit names this token */
  readonly admitted: boolean;
}

interface Waiter {
  readonly section: Section;
  /** set for a refresh request: the token a held publish/end section may admit */
  readonly refreshToken: string | null;
  readonly grant: () => void;
  readonly admit: (into: Section) => void;
}

/**
 * One record per storage key: the recorded lineages, oldest first (at most LINEAGE_HISTORY). `epoch` names the
 * record's creation (a new one after the browser's site data was cleared); `seq` grows with every append.
 */
export interface LineageRecord {
  readonly epoch?: string;
  readonly seq: number;
  readonly history: readonly string[];
}
export interface LineageStore {
  read(): Promise<LineageRecord | null>;
  /**
   * Appends `digest` in one read-modify-write transaction (no-op when it is already the latest) and returns the record
   * as committed. `signal` is checked immediately before the transaction is opened (aborted: nothing is appended) and
   * aborts the transaction if it has not committed yet.
   */
  append(digest: string, signal?: AbortSignal): Promise<LineageRecord | void>;
}

/** Why a view was not verified (see the header). */
export type Unverified = "stale" | "unrecorded" | "unavailable" | "unsupported";

const LOCK_PREFIX = "swingproai:session-publication:";
/** How long a refresh section waits for the SDK to commit and announce its answer before it ends anyway. */
const COMMIT_BACKSTOP_MS = 10_000;
/** How long a holder or reader waits for its stale view of the jar to show the recorded lineage. */
export const VIEW_SETTLE_MS = 500;
const VIEW_POLL_MS = 25;
/** Each IndexedDB read is given this long; a lineage commit (digest and append) is given this long in all. */
const LINEAGE_IO_MS = 1_000;
const LINEAGE_HISTORY = 8;
const LINEAGE_DB = "swingproai-session-lineage";
const LINEAGE_OBJECTS = "lineage";
export const NO_SESSION_LINEAGE = "none";

let lockName: string | null = null;
let lineageKey: string | null = null;
let webHeld = false;
/** this tab's verdict on its view of the jar for its current tenure of the lock (see settle) */
let tenureTrusted = false;
let tenureCheck: "verified" | Unverified = "unavailable";
/**
 * The jar as this tenure last verified or changed it (its settled view, then each of its own writes): inside a held
 * section the jar must still be exactly this, or something outside the contract wrote it meanwhile (a previous bundle's
 * page; fail closed). null: nothing verified in this tenure.
 */
let tenureView: JarView | null = null;
let releaseWeb: (() => void) | null = null;
let active: Section | null = null;
let nextId = 1;
const waiting: Waiter[] = [];
let jarView: () => JarView = () => ({ kind: "absent" });
let lineageStore: LineageStore | null | undefined; // undefined: not chosen yet (IndexedDB by default)
/** the newest lineage record this tab has read or committed (never moves backwards within one epoch) */
let observed: LineageRecord | null = null;
const counters = {
  leaseTimeouts: 0,
  leaseCancels: 0,
  noWebLocks: 0,
  admittedQueued: 0,
  commitBackstops: 0,
  staleViews: 0,
  unrecordedViews: 0,
  lineageUnavailable: 0,
  lineageWriteFailures: 0,
  lateLineage: 0,
};

/** Names the lock after the SDK storage key; called by the browser client factory. */
export function configureLease(storageKey: string): void {
  lockName = `${LOCK_PREFIX}${storageKey}`;
  lineageKey = storageKey;
}

/** Wires the storage's synchronous jar reader (and, for tests, a lineage store; null: none). */
export function configureLineage(options: { readonly jarView: () => JarView; readonly store?: LineageStore | null }): void {
  jarView = options.jarView;
  if (options.store !== undefined) lineageStore = options.store;
}

/** Count-only diagnostics. */
export function leaseCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/**
 * "unsupported" when this browser lacks something the synchronization contract needs (Web Locks, IndexedDB,
 * SubtleCrypto): nothing that needs ordering can be done here at all, and callers say so instead of "try again".
 */
export function leaseSupport(): "supported" | "unsupported" {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!locks || !subtle) return "unsupported";
  if (lineageStore === null) return "unsupported";
  if (lineageStore === undefined && typeof indexedDB === "undefined") return "unsupported";
  return "supported";
}

const sameView = (a: JarView, b: JarView) =>
  a.kind === b.kind && (a.kind !== "present" || (b.kind === "present" && a.refreshToken === b.refreshToken));

/** Inside a held section: does `view` equal the jar as this tenure verified or last changed it? */
export function tenureMatches(view: JarView): boolean {
  return tenureView !== null && sameView(tenureView, view);
}

/**
 * Inside a held section: may `view` be acted on? A jar holding no session always may (nothing is handed over; the
 * fail-closed direction); a session only when it is exactly the tenure's own (tenureMatches).
 */
export function tenureAdmits(view: JarView): boolean {
  return view.kind === "absent" || tenureMatches(view);
}

/** The storage changed the jar inside this tab's held section (synchronously, under the lock): this is now the jar. */
export function noteOwnChange(view: JarView): void {
  if (activeSection() !== null) tenureView = view;
}

/** The section this tab is running, once it holds the cross-tab lock; null otherwise. */
export function activeSection(): Section | null {
  return active !== null && active.held ? active : null;
}

function admits(section: Section, refreshToken: string): boolean {
  if (section.kind !== "publish" && section.kind !== "end") return false;
  const permit = section.permit;
  if (permit === null) return false;
  return permit.kind === "publish" ? permit.refreshToken === refreshToken : permit.refreshTokens.has(refreshToken);
}

// ─── Lineage (IndexedDB record + SHA-256 digests) ─────────────────────────────────────────────────────────────────

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("lineage timeout")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** `work`, or a rejection as soon as `signal` aborts (the work itself is left to observe the signal). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new Error("lineage work abandoned"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("lineage work abandoned"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function newEpoch(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let text = "";
  for (let at = 0; at < bytes.length; at++) text += bytes[at].toString(16).padStart(2, "0");
  return text;
}

function indexedDbStore(key: string): LineageStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(LINEAGE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LINEAGE_OBJECTS)) request.result.createObjectStore(LINEAGE_OBJECTS);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("lineage store blocked"));
    }).catch((error: unknown) => {
      opened = null;
      throw error;
    }));
  const valid = (value: unknown): LineageRecord | null => {
    if (!value || typeof value !== "object") return null;
    const { epoch, seq, history } = value as { epoch?: unknown; seq?: unknown; history?: unknown };
    if (typeof seq !== "number" || !Array.isArray(history) || !history.every((d) => typeof d === "string")) return null;
    return { epoch: typeof epoch === "string" ? epoch : "", seq, history };
  };
  return {
    async read() {
      const db = await open();
      return new Promise<LineageRecord | null>((resolve, reject) => {
        const request = db.transaction(LINEAGE_OBJECTS, "readonly").objectStore(LINEAGE_OBJECTS).get(key);
        request.onsuccess = () => resolve(valid(request.result));
        request.onerror = () => reject(request.error);
      });
    },
    async append(digest: string, signal?: AbortSignal) {
      const db = await open();
      // checked in the same synchronous step that opens the transaction: an ended section never starts one
      if (signal?.aborted) throw new Error("lineage append abandoned");
      return new Promise<LineageRecord>((resolve, reject) => {
        const transaction = db.transaction(LINEAGE_OBJECTS, "readwrite");
        let result: LineageRecord | null = null;
        signal?.addEventListener(
          "abort",
          () => {
            try {
              transaction.abort();
            } catch {
              // already committed: it committed before any later transaction on this record could start
            }
          },
          { once: true },
        );
        const objects = transaction.objectStore(LINEAGE_OBJECTS);
        const request = objects.get(key);
        request.onsuccess = () => {
          const current = valid(request.result);
          const history = current?.history ?? [];
          if (current !== null && history[history.length - 1] === digest) {
            result = current;
            return;
          }
          result = { epoch: current?.epoch || newEpoch(), seq: (current?.seq ?? 0) + 1, history: [...history, digest].slice(-LINEAGE_HISTORY) };
          objects.put(result, key);
        };
        transaction.oncomplete = () => (result === null ? reject(new Error("lineage append incomplete")) : resolve(result));
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("lineage append aborted"));
      });
    },
  };
}

function lineage(): LineageStore | null {
  if (lineageStore === undefined) {
    if (lineageKey === null) return null; // not configured yet (no shared client): nothing is decided or cached
    try {
      lineageStore = indexedDbStore(lineageKey);
    } catch {
      lineageStore = null;
    }
  }
  return lineageStore;
}

/** The lineage digest of a jar view: "none" without a usable session, else a SHA-256 of its refresh token; null when
 *  SubtleCrypto is unavailable or fails. The token itself is never stored. */
export async function lineageDigest(view: JarView): Promise<string | null> {
  if (view.kind !== "present") return NO_SESSION_LINEAGE;
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return null;
  try {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`swingproai-lineage:${view.refreshToken}`)));
    let text = "";
    for (let at = 0; at < bytes.length; at++) text += bytes[at].toString(16).padStart(2, "0");
    return text;
  } catch {
    return null;
  }
}

/** Keeps `record` as the newest lineage this tab has seen when it is newer (same epoch, higher seq) or a new epoch. */
function noteRecord(record: LineageRecord | null): void {
  if (record === null) {
    observed = null; // nothing recorded (the site's data was cleared): this browser starts over
    return;
  }
  if (observed === null || (record.epoch ?? "") !== (observed.epoch ?? "") || record.seq > observed.seq) observed = record;
}

/** The latest lineage this tab has seen (synchronous; for decisions made in the same step as an action), or null. */
export function observedLatest(): string | null {
  const history = observed?.history ?? [];
  return history.length > 0 ? history[history.length - 1] : null;
}

/** Whether `digest` appears anywhere in the lineage history this tab has seen. */
export function observedIncludes(digest: string): boolean {
  return (observed?.history ?? []).includes(digest);
}

/** Reads the lineage record afresh (and notes it as observed); "unavailable" when there is no store or it fails. */
export async function readLineageRecord(): Promise<LineageRecord | null | "unavailable"> {
  const store = lineage();
  if (store === null) {
    counters.lineageUnavailable += 1;
    return "unavailable";
  }
  try {
    const record = await withTimeout(store.read(), LINEAGE_IO_MS);
    noteRecord(record);
    return record;
  } catch {
    counters.lineageUnavailable += 1;
    return "unavailable";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why verification failed when the record or digest could not be had: the browser lacks the facility, or it failed. */
function unverifiable(): Unverified {
  return leaseSupport() === "unsupported" ? "unsupported" : "unavailable";
}

export type ViewCheck<T> =
  | { readonly verified: true; readonly value: T; readonly view: JarView }
  | { readonly verified: false; readonly reason: Unverified; readonly value: T; readonly view: JarView };

/**
 * Compares the jar (read through `read`, which returns the caller's own reading and its view) with the recorded lineage,
 * waiting out a differing view for up to VIEW_SETTLE_MS (see the header). The jar is read FIRST and the record after it.
 * With `waitUnsettled` (readers without the lock), an ambiguous view may be another tab's write in progress and is
 * waited out too; one that stays ambiguous is verified only when the browser records no session ("none") or nothing.
 */
export async function checkView<T>(read: () => { readonly value: T; readonly view: JarView }, waitUnsettled: boolean): Promise<ViewCheck<T>> {
  // a browser that cannot support the contract verifies nothing, whatever the record says (nothing of this application
  // can have written there in order)
  if (leaseSupport() === "unsupported") return { verified: false, reason: "unsupported", ...read() };
  const deadline = performance.now() + VIEW_SETTLE_MS;
  for (;;) {
    const reading = read();
    const digest = await lineageDigest(reading.view);
    if (digest === null) return { verified: false, reason: unverifiable(), ...reading };
    const record = await readLineageRecord();
    if (record === "unavailable") return { verified: false, reason: unverifiable(), ...reading };
    const latest = observedLatest();
    const waitOut = waitUnsettled && reading.view.kind === "unsettled";
    if (!waitOut && (latest === null || digest === latest)) return { verified: true, ...reading };
    if (performance.now() >= deadline) {
      if (waitOut && (latest === null || latest === NO_SESSION_LINEAGE)) return { verified: true, ...reading };
      return { verified: false, reason: observedIncludes(digest) ? "stale" : "unrecorded", ...reading };
    }
    await sleep(VIEW_POLL_MS);
  }
}

/** A change of this tenure whose record did not land: nothing more is trusted in this tenure (fail closed). */
function failTenure(section: Section): void {
  if (activeSection() !== section) return;
  tenureTrusted = false;
  tenureCheck = "unrecorded";
  tenureView = null;
  section.viewTrusted = false;
  section.viewCheck = "unrecorded";
}

/**
 * Records `view` — the jar as this section left it — as the latest lineage; awaited before the SDK announces the change.
 * True only when the record committed while the section was still the active one; otherwise the tenure is no longer
 * trusted (failTenure). A publication's record (`anchors`:
 * its permit named what it wrote) also makes this tab's view current for the rest of its tenure. Bound to the section:
 * the whole commit (digest and append) is given LINEAGE_IO_MS, and nothing is appended or anchored once the section
 * has ended (see SECTION LIFETIME in the header).
 */
export async function commitLineage(section: Section, view: JarView, anchors = false): Promise<boolean> {
  if (activeSection() !== section) return false;
  const store = lineage();
  if (store === null) {
    counters.lineageUnavailable += 1;
    failTenure(section);
    return false;
  }
  const io = new AbortController();
  const timer = setTimeout(() => io.abort(), LINEAGE_IO_MS);
  const stop = () => io.abort();
  section.lifetime.signal.addEventListener("abort", stop, { once: true });
  try {
    const digest = await lineageDigest(view);
    if (digest === null) {
      counters.lineageUnavailable += 1;
      failTenure(section);
      return false;
    }
    // after the await: the section may have ended (backstop, expiry) and a later holder recorded since
    if (io.signal.aborted || activeSection() !== section) {
      counters.lateLineage += 1;
      failTenure(section); // (only while it is still the active section: an ended one has no tenure left)
      return false;
    }
    // the store aborts its transaction on the signal; the wait itself also ends there, whatever the store does
    const committed = await untilAborted(store.append(digest, io.signal), io.signal);
    if (committed) noteRecord(committed);
    if (activeSection() !== section) {
      counters.lateLineage += 1;
      return false;
    }
    if (anchors) {
      tenureTrusted = true;
      tenureCheck = "verified";
      tenureView = view;
      section.viewTrusted = true;
      section.viewCheck = "verified";
    }
    return true;
  } catch {
    counters.lineageWriteFailures += 1;
    failTenure(section);
    return false;
  } finally {
    clearTimeout(timer);
    section.lifetime.signal.removeEventListener("abort", stop);
    io.abort(); // an append still pending past this point can never commit
  }
}

// ─── The cross-tab lock ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Holds the Web Lock within waitMs (or until `signal` aborts); true when held. A request that gives up is aborted.
 * Without Web Locks nothing can be ordered across tabs: false (counted), never a per-tab substitute.
 */
async function holdWebLock(waitMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (webHeld) return true;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || lockName === null) {
    counters.noWebLocks += 1;
    return false;
  }
  if (signal?.aborted) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, waitMs));
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      locks
        .request(lockName as string, { mode: "exclusive", signal: controller.signal }, () => {
          webHeld = true;
          resolve();
          return new Promise<void>((release) => {
            releaseWeb = release;
          });
        })
        .catch(reject);
    });
    return true;
  } catch {
    return false; // not granted in time, cancelled, or not available: the caller gives up, nothing is stolen
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function releaseWebLock(): void {
  webHeld = false;
  tenureTrusted = false;
  tenureCheck = "unavailable";
  tenureView = null;
  const release = releaseWeb;
  releaseWeb = null;
  release?.();
}

/** Admits every queued refresh whose token a newly held publish/end section's permit names. */
function admitQueued(section: Section): void {
  for (let at = waiting.length - 1; at >= 0; at--) {
    const entry = waiting[at];
    if (entry.refreshToken !== null && admits(section, entry.refreshToken)) {
      waiting.splice(at, 1);
      counters.admittedQueued += 1;
      entry.admit(section);
    }
  }
}

interface EnterOptions {
  readonly waitMs: number;
  readonly permit?: Permit | null;
  readonly holdMs?: number;
  /** the caller's cancellation: a section not yet held is given up at once, and its lock request aborted */
  readonly signal?: AbortSignal;
}

async function enter(kind: SectionKind, options: EnterOptions, refreshToken: string | null): Promise<RefreshHandle | null> {
  const section: Section = {
    id: nextId++,
    kind,
    permit: options.permit ?? null,
    held: false,
    viewTrusted: false,
    viewCheck: "unavailable",
    expect: null,
    committed: false,
    timer: null,
    lifetime: new AbortController(),
  };
  const signal = options.signal;
  if (signal?.aborted) {
    counters.leaseCancels += 1;
    return null;
  }
  const startedAt = performance.now();
  if (active === null && waiting.length === 0) {
    active = section;
  } else {
    const outcome = await new Promise<Section | "granted" | "timeout" | "cancelled">((resolve) => {
      const drop = (why: "timeout" | "cancelled") => {
        const at = waiting.indexOf(entry);
        if (at === -1) return; // already granted or admitted
        waiting.splice(at, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(why);
      };
      const onAbort = () => drop("cancelled");
      const timer = setTimeout(() => drop("timeout"), Math.max(0, options.waitMs));
      const entry: Waiter = {
        section,
        refreshToken,
        grant: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve("granted");
        },
        admit: (into) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(into);
        },
      };
      waiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (outcome === "timeout" || outcome === "cancelled") {
      counters[outcome === "timeout" ? "leaseTimeouts" : "leaseCancels"] += 1;
      return null;
    }
    if (outcome !== "granted") return { section: outcome, admitted: true };
  }
  const fresh = !webHeld;
  if (!(await holdWebLock(options.waitMs - (performance.now() - startedAt), signal))) {
    if (signal?.aborted) counters.leaseCancels += 1;
    else if (typeof navigator !== "undefined" && navigator.locks) counters.leaseTimeouts += 1;
    leaveSection(section);
    return null;
  }
  if (fresh) {
    // A new holder: settle this tab's view of the jar against the recorded lineage before anything acts on it. The
    // verdict holds for this whole tenure of the lock (sections handed over within the tab share it). Anything but a
    // verified view — stale, never recorded, or not verifiable at all — is untrusted (fail closed).
    const settled = await checkView(() => ({ value: null, view: jarView() }), false);
    tenureTrusted = settled.verified;
    tenureCheck = settled.verified ? "verified" : settled.reason;
    tenureView = settled.verified ? settled.view : null;
    if (!settled.verified) {
      if (settled.reason === "stale") counters.staleViews += 1;
      else if (settled.reason === "unrecorded") counters.unrecordedViews += 1;
    }
  }
  section.viewTrusted = tenureTrusted;
  section.viewCheck = tenureCheck;
  if (signal?.aborted) {
    counters.leaseCancels += 1;
    leaveSection(section);
    return null;
  }
  section.held = true;
  if (options.holdMs !== undefined) section.timer = setTimeout(() => leaveSection(section), options.holdMs);
  admitQueued(section);
  return { section, admitted: false };
}

/**
 * Enters a section: waits for the tab's queue, then for the cross-tab lock, within `waitMs` in all (or until `signal`
 * aborts). Null when either was not available in time, the caller cancelled, or this browser has no Web Locks
 * (leaseSupport()); a lock request that gives up is aborted, so it is never granted later. `holdMs` ends the section
 * by itself after that long (End Session's backstop), counted from the moment the section is held. Give a
 * publish/end section its permit here, so it admits its own refreshes.
 */
export async function enterSection(kind: SectionKind, options: EnterOptions): Promise<Section | null> {
  const handle = await enter(kind, options, null);
  return handle === null ? null : handle.section;
}

/** Ends a section (idempotent); the next queued section of this tab starts, or the cross-tab lock is released. */
export function leaveSection(section: Section): void {
  if (active !== section) return;
  if (section.timer !== null) clearTimeout(section.timer);
  section.timer = null;
  section.held = false;
  section.lifetime.abort();
  active = null;
  const next = waiting.shift();
  if (next) {
    active = next.section;
    next.grant();
    return;
  }
  releaseWebLock();
}

/** The section a refresh request runs in: the held publish/end section that admits its token, or a new one. */
export async function enterRefresh(refreshToken: string, waitMs: number): Promise<RefreshHandle | null> {
  const current = activeSection();
  if (current !== null && admits(current, refreshToken)) return { section: current, admitted: true };
  return enter("refresh", { waitMs }, refreshToken);
}

/**
 * Ends a refresh request's part. An admitted request belongs to its publish/end section, which ends itself. Otherwise,
 * with no commit to wait for the section ends now; with one it ends when the SDK has committed and announced it (or its
 * refresh call settled without an announcement), or at the backstop.
 */
export function finishRefresh(handle: RefreshHandle, expect: { readonly origin: string; readonly result: string | null } | null): void {
  if (handle.admitted) return;
  if (expect === null) {
    leaveSection(handle.section);
    return;
  }
  const section = handle.section;
  section.expect = expect;
  section.timer = setTimeout(() => {
    if (active === section) counters.commitBackstops += 1;
    leaveSection(section);
  }, COMMIT_BACKSTOP_MS);
}

function awaitingCommit(): Section | null {
  const section = activeSection();
  return section !== null && section.kind === "refresh" && section.expect !== null ? section : null;
}

/**
 * Called by the storage when the SDK's commit of the expected answer has been applied, found already applied, or
 * skipped (`token`: the saved token, or the token whose session was to be removed). The section now waits for the SDK
 * to announce it.
 */
export function observeCommit(token: string): void {
  const section = awaitingCommit();
  if (section === null) return;
  if (section.expect?.result === token || section.expect?.origin === token) section.committed = true;
}

/** Called by the storage when it refused the SDK's commit (the SDK announces nothing then): the section ends now. */
export function abandonCommit(): void {
  const section = awaitingCommit();
  if (section !== null) leaveSection(section);
}

/**
 * Called once the SDK has dispatched (posted to other tabs and started this tab's subscribers) — or the event fence
 * dropped — a local announcement. Ends the refresh section that was waiting for exactly that announcement.
 */
export function noticeDispatched(event: string, refreshToken: string | null): void {
  const section = awaitingCommit();
  if (section === null || !section.committed || section.expect === null) return;
  const announced =
    section.expect.result === null ? event === "SIGNED_OUT" : event === "TOKEN_REFRESHED" && refreshToken === section.expect.result;
  if (announced) leaveSection(section);
}

/** Called when the SDK's refresh call for `origin` has settled: a section still waiting on it (no announcement came) ends. */
export function refreshCallSettled(origin: string): void {
  const section = awaitingCommit();
  if (section !== null && section.expect?.origin === origin) leaveSection(section);
}
