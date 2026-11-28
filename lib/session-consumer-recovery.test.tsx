import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope (as the other render tests arrange).
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-03-R1-A2 — the Analyze page and the Add Club form after the shared browser client began REFUSING a session
 * read it cannot confirm (utils/supabase/session-storage.ts: the SDK's retryable error, marked "unverified").
 *
 * Both consumers are driven through their real handlers and effects: React's hooks are replaced by a small synchronous
 * runtime that keeps state, refs, memos and effects (with dependency comparison and cleanup) across renders the way React
 * does, so a page can be mounted, its effects run, a button pressed or a form submitted, and the result rendered again;
 * every rendered tree is turned into markup by the real react-dom/server. The shared browser client is a stand-in whose
 * session reads, events, queries and uploads the test controls; the Add Club form's add goes through the REAL supabase-js
 * client bound to the confirmed session (lib/drill-hub-session.ts), down to a recording fetch stub, so the request it sends
 * — or does not send — is the one a browser would send. The unverified-read classifier and the ended-lineage notice are
 * the real modules (utils/supabase/session-storage.ts, utils/supabase/session-publication.ts); one test obtains a
 * genuine refusal from the real storage. Synthetic identities only; nothing reaches a network.
 *
 * Coverage (A2 acceptance):
 *  - unconfirmed (refused), unavailable (failed / no answer in time), genuinely signed-out and valid session reads;
 *  - the Analyze club panel always leaves "Loading your bag…", and offers the one action that can help;
 *  - Add Club keeps the entered details, settles its pending state, shows fixed copy, and sends no add without a confirmed
 *    session for the account the form was rendered for;
 *  - deliberate retry after a failure, and duplicate-press control;
 *  - stale results: cancellation, account switch, A's answer finishing after B became current, End Session elsewhere;
 *  - no anonymous or wrong-account request, no raw technical error names or provider text, accessible status/alerts.
 */

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  pending: [] as number[],
  dirty: false,
  idSeq: 0,
  client: null as unknown,
  search: new URLSearchParams(),
  pushes: [] as string[],
  refreshes: 0,
  /** A3: what the dashboard layout's RenderedSessionProvider gives the page (useContext), or null outside it */
  rendered: null as null | { ownerId: string; lineage: string | null },
  /**
   * A4 (C1): how the stand-in network answers the analysis call (/api/analyze-swing), which the page now sends with
   * plain fetch — the owner's confirmed Bearer, `credentials: "omit"` — so it is on the wire record like every other
   * request (null: a healthy full-swing answer).
   */
  analysisAnswer: null as null | ((request: { authorization: string | null }) => Promise<Response>),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  type Slot = Record<string, unknown>;
  const same = (a: unknown, b: unknown) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
  function useState(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = { value: typeof init === "function" ? (init as () => unknown)() : init };
    const slot = rt.slots[i] as Slot;
    slot.set ??= (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(slot.value) : v;
      if (!Object.is(next, slot.value)) {
        slot.value = next;
        rt.dirty = true;
      }
    };
    return [slot.value, slot.set];
  }
  function useRef(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = { current: init };
    return rt.slots[i];
  }
  function memoSlot(fn: () => unknown, deps: unknown[]) {
    const i = rt.i++;
    const slot = rt.slots[i] as Slot | undefined;
    if (slot && same(slot.deps, deps)) return slot.value;
    const value = fn();
    rt.slots[i] = { deps, value };
    return value;
  }
  const useMemo = memoSlot;
  const useCallback = (fn: unknown, deps: unknown[]) => memoSlot(() => fn, deps);
  function useEffect(fn: () => unknown, deps?: unknown[]) {
    const i = rt.i++;
    const slot = rt.slots[i] as Slot | undefined;
    if (slot && deps !== undefined && same(slot.deps, deps)) return;
    rt.slots[i] = { deps, fn, cleanup: slot?.cleanup, effect: true };
    rt.pending.push(i);
  }
  const useId = () => `id-${rt.idSeq++}`;
  // A3: the only context these consumers read is the layout's rendered session (SessionKeeper.tsx useRenderedSession)
  const useContext = () => rt.rendered;
  return { ...actual, default: actual, useState, useRef, useMemo, useCallback, useEffect, useId, useContext };
});
// A4 (C1): the A3 cookie-session sender is retired; the page's analysis call is an ordinary fetch (recorded below), so the
// real session-publication module is used as it is.
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
  useSearchParams: () => rt.search,
  usePathname: () => "/analyze",
}));
const routerStub = vi.hoisted(() => ({
  push: (href: string) => { rt.pushes.push(href); },
  refresh: () => { rt.refreshes += 1; },
  back: () => undefined,
  replace: () => undefined,
  prefetch: () => undefined,
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { href: p.href, className: p.className }, p.children as never) };
});
vi.mock("lucide-react", () => {
  const none = () => null;
  return Object.fromEntries(
    ["Upload", "Target", "CheckCircle2", "AlertCircle", "Loader2", "Play", "Info", "Maximize2", "X", "Activity", "Zap", "Lock",
      "BarChart2", "FileUp", "Camera", "Square"].map((name) => [name, none]),
  );
});
vi.mock("@/components/equipment/ClubSelector", async () => {
  const { createElement } = await import("react");
  return {
    default: (p: { clubs: { id: string; displayName: string }[]; selectedClubId: string | null; onChange: (v: string | null) => void }) =>
      createElement(
        "select",
        { "data-club-selector": "", value: p.selectedClubId ?? "", onChange: (e: { target: { value: string } }) => p.onChange(e.target.value || null) },
        p.clubs.map((club) => createElement("option", { key: club.id, value: club.id }, club.displayName)),
      ),
  };
});
vi.mock("@/utils/supabase/client", () => ({ createClient: () => rt.client }));

import AnalyzePage from "@/app/(dashboard)/analyze/page";
import AddClubForm, { type CatalogState } from "@/app/(dashboard)/bag/add/AddClubForm";
import { announceEndedLineage } from "@/utils/supabase/session-publication";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { VIDEO_UNUSABLE_STATUS } from "@/lib/swing-video-source";
import { sessionLineageId } from "@/utils/supabase/session-cookie-layout";
import { DRILL_HUB_SESSION_DEADLINE_MS } from "@/lib/drill-hub-session";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// ─── Fixed copy (what the golfer may see) ───────────────────────────────────────────────────────────────────────────

const ANALYZE = {
  loading: "Loading your bag…",
  auth: "We couldn't confirm your session, so your clubs aren't available. You can still analyze without a club.",
  clubsUnconfirmed: "We couldn't confirm which account is signed in on this device, so your clubs aren't shown. Try again, or sign in again.",
  clubsUnavailable: "We couldn't check your sign-in just now, so your clubs aren't shown. Try again in a moment.",
  clubsChanged:
    "This browser is now signed in to a different account, so the clubs shown here were cleared. Refresh the page to continue with the account that's signed in now.",
  expired: "Your session has expired. Please sign in again.",
  unconfirmed:
    "We couldn't confirm which account is signed in on this device, so your swing wasn't analyzed. Your video is still selected — try again, or sign in again.",
  unavailable:
    "We couldn't check your sign-in just now, so your swing wasn't analyzed. Your video is still selected — try again in a moment.",
  changed: "This browser is now signed in to a different account, so this analysis was stopped. Refresh the page before you try again.",
  failed: "We couldn't finish this analysis. Please try again.",
  afterChange:
    "This browser's sign-in changed while your swing was being analyzed, so the result isn't shown here. Refresh the page to continue with the account that's signed in now.",
  uploadFailed: "We couldn't upload your video. Check your connection, then tap Run Analyzer again — your video is still selected.",
  // AG-WEB-READY-10-P3: the transfer is kept, but Storage has not confirmed how much of the clip arrived
  uploadUnconfirmed:
    "Your upload was interrupted and we couldn't confirm how much of your video arrived. Check your connection, then tap Run Analyzer again to continue — your video is still selected.",
};
const ADD = {
  signedOut: "You're signed out, so this club wasn't added. Sign in again to add it to your bag.",
  unconfirmed:
    "We couldn't confirm which account is signed in on this device, so this club wasn't added. Your details are still here — try again, or sign in again.",
  unavailable: "We couldn't check your sign-in just now, so this club wasn't added. Your details are still here — try again in a moment.",
  changed:
    "This browser is now signed in to a different account, so this club wasn't added. Refresh the page to add clubs for the account that's signed in now.",
  refused: "Your sign-in wasn't accepted for this change, so this club wasn't added. Refresh the page, then try again.",
  failed: "We couldn't add this club right now. Your details are still here — try again in a moment.",
  unknown: "We couldn't tell whether this club was added. Check your bag before you add it again.",
  addedThenChanged:
    "This club was added, but this browser's sign-in changed meanwhile. Refresh the page to see the bag for the account that's signed in now.",
};
/** Synthetic technical text: none of it may ever reach a page. */
const RAW = /AuthRetryableFetchError|AuthApiError|TypeError|AbortError|row-level security|42501|PGRST|synthetic-internal|Failed to fetch|refresh_token|access_token/i;

// ─── Synthetic identities ────────────────────────────────────────────────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
interface Golfer {
  readonly id: string;
}
const A: Golfer = { id: randomUUID() };
const B: Golfer = { id: randomUUID() };
/**
 * A session object as the SDK hands it out (the JWT is unsigned test data: nothing here verifies it). Each call is a new
 * sign-in (its own Auth session id, so its own lineage) unless `sid` names one.
 */
function sessionOf(golfer: Golfer, sid = `sid-${randomUUID()}`) {
  return {
    access_token: `${b64({ alg: "none" })}.${b64({ sub: golfer.id, session_id: sid, exp: 4_000_000_000 })}.synthetic`,
    refresh_token: `rt-${randomUUID()}`,
    expires_at: 4_000_000_000,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: golfer.id },
  };
}
type Session = ReturnType<typeof sessionOf>;

/** The SDK's retryable error as the shared storage marks a refused read (same mark the real classifier reads). */
function refusedRead(reason: "stale" | "unrecorded" | "unavailable" = "stale"): Error {
  const error = new Error("We couldn't confirm your sign-in on this device. Refresh the page, or sign in again.");
  error.name = "AuthRetryableFetchError";
  Object.defineProperty(error, "__swingproaiSessionUnverified", { value: reason, enumerable: false });
  return error;
}

// ─── A controllable shared client ────────────────────────────────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SessionAnswer = { data: { session: Session | null }; error: unknown };

function sharedClient() {
  const subscribers = new Set<(event: string, session: unknown) => void>();
  const sessionReads: Deferred<SessionAnswer>[] = [];
  /**
   * A3: when `answer` is set, every session read is answered at once from it — what the browser's jar holds now, so a
   * test models another tab's publication by changing it (no event is delivered unless the test emits one). `held`
   * reads still wait as deferreds (read(k)).
   */
  const auto = { answer: null as null | (() => SessionAnswer | Error), held: 0 };
  /**
   * A3 review: the managed client's OWN data requests choose their credential when they are sent, as the real shared
   * client does (supabase-js reads the session for every request): modelled by a real supabase-js client whose token is
   * whatever the browser holds at that moment (the anon key when it holds none), down to the same recording fetch — so a
   * page that sent its data through the managed client would put another account's token on the wire.
   */
  let managedData: ReturnType<typeof createSupabaseJsClient> | null = null;
  const data = () =>
    (managedData ??= createSupabaseJsClient("http://127.0.0.1:54329", "synthetic-anon-key-not-a-secret", {
      accessToken: async () => {
        const now = auto.answer?.();
        return now && !(now instanceof Error) ? now.data.session?.access_token ?? null : null;
      },
    }));
  const client = {
    auth: {
      getSession: vi.fn(() => {
        if (auto.answer !== null && auto.held === 0) {
          const now = auto.answer();
          return now instanceof Error ? Promise.reject(now) : Promise.resolve(now);
        }
        if (auto.held > 0) auto.held -= 1;
        const read = deferred<SessionAnswer>();
        sessionReads.push(read);
        return read.promise;
      }),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        subscribers.add(callback);
        return { data: { subscription: { unsubscribe: () => subscribers.delete(callback) } } };
      },
    },
    from: (table: string) => data().from(table),
    get storage() {
      return data().storage;
    },
  };
  return {
    client,
    auto,
    sessionReads,
    emit: (event: string, session: unknown) => subscribers.forEach((callback) => callback(event, session)),
    subscriberCount: () => subscribers.size,
  };
}
let shared: ReturnType<typeof sharedClient>;
/** The page's k-th session read (0-based), asserting that the page made it (a page that skips one fails here, by name). */
function read(k: number): Deferred<SessionAnswer> {
  const r = shared.sessionReads[k];
  expect(r, `the page made no session read #${k + 1}`).toBeDefined();
  return r;
}

// ─── Network: every request is recorded; none leaves the process ─────────────────────────────────────────────────────

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
  /** A3 review: the request's credentials mode (null: the platform default, which sends cookies same-origin) */
  readonly credentials: string | null;
  /** A4: whether the request was given a cancel signal (a sent analysis call is never cancelled by the page) */
  readonly cancellable: boolean;
  /** A1: the signed transfer's own headers (TUS) and the size of a binary body */
  readonly signature: string | null;
  readonly uploadOffset: string | null;
  readonly uploadLength: string | null;
  readonly uploadMetadata: string | null;
  readonly bodySize: number | null;
  /** review: the request's redirect mode (null: the platform default, "follow") */
  readonly redirect: string | null;
}
let sent: Sent[] = [];
let answer: (request: Sent, signal: AbortSignal | undefined) => Promise<Response>;

function installFetch() {
  sent = [];
  transfers = new Map();
  answer = async () => new Response(null, { status: 201 });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const request: Sent = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials ?? null,
      cancellable: init?.signal !== undefined && init?.signal !== null,
      signature: headers.get("x-signature"),
      uploadOffset: headers.get("upload-offset"),
      uploadLength: headers.get("upload-length"),
      uploadMetadata: headers.get("upload-metadata"),
      bodySize: init?.body instanceof Blob ? init.body.size : null,
      redirect: init?.redirect ?? null,
    };
    sent.push(request);
    return answer(request, init?.signal ?? undefined);
  });
}

// ─── A minimal renderer over the hook runtime ────────────────────────────────────────────────────────────────────────

interface HostNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly ref: unknown;
  readonly children: (HostNode | string)[];
}

function expand(node: unknown): (HostNode | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement & { ref?: unknown };
  const props = (element.props ?? {}) as Record<string, unknown>;
  if (element.type === React.Fragment) return expand(props.children);
  if (typeof element.type === "function") return expand((element.type as (p: unknown) => unknown)(props));
  if (typeof element.type !== "string") return [];
  return [{ type: element.type, props, ref: element.ref ?? null, children: expand(props.children) }];
}

function textOf(nodes: (HostNode | string)[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : textOf(n.children))).join("");
}

function findAll(nodes: (HostNode | string)[], match: (n: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (match(n)) out.push(n);
    out.push(...findAll(n.children, match));
  }
  return out;
}

interface Mounted {
  render(): void;
  unmount(): void;
  nodes(): (HostNode | string)[];
  text(): string;
  markup(): string;
  button(label: string): HostNode | null;
}

function mount<P>(Component: (props: P) => unknown, props: P): Mounted {
  rt.slots = [];
  rt.pending = [];
  rt.dirty = false;
  let tree: unknown = null;
  const render = () => {
    for (let guard = 0; guard < 25; guard++) {
      rt.i = 0;
      rt.dirty = false;
      tree = Component(props);
      for (const i of rt.pending.splice(0)) {
        const slot = rt.slots[i] as { fn: () => unknown; cleanup?: unknown };
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = slot.fn();
      }
      if (!rt.dirty) return;
    }
    throw new Error("render did not settle");
  };
  render();
  const nodes = () => expand(tree);
  return {
    render,
    unmount: () => {
      for (const slot of rt.slots as { effect?: boolean; cleanup?: unknown }[]) {
        if (slot?.effect && typeof slot.cleanup === "function") (slot.cleanup as () => void)();
      }
    },
    nodes,
    text: () => textOf(nodes()),
    markup: () => renderToStaticMarkup(tree as React.ReactElement),
    button: (label: string) => findAll(nodes(), (n) => n.type === "button" && textOf(n.children).includes(label))[0] ?? null,
  };
}

/** Lets pending promise work (including WebCrypto digests) finish, then renders any state it changed. */
async function settle(page: Mounted, turns = 30): Promise<void> {
  for (let k = 0; k < turns; k++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (rt.dirty) page.render();
}

const press = (node: HostNode | null) => {
  expect(node, "control not rendered").not.toBeNull();
  (node!.props.onClick as () => void)();
};

/**
 * The lineage digests (WebCrypto SHA-256) are served from node:crypto in a microtask: identical bytes, but finished within
 * the settle window instead of whenever the platform's worker thread returns.
 */
function installMicrotaskDigest() {
  const platform = globalThis.crypto;
  const subtle = {
    digest: (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return Promise.resolve(Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer);
    },
  };
  vi.stubGlobal("crypto", Object.create(platform, {
    subtle: { value: subtle },
    // the platform's own methods, called on the platform object (they need it as their receiver)
    randomUUID: { value: () => platform.randomUUID() },
    getRandomValues: { value: (array: Uint8Array) => platform.getRandomValues(array) },
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  installMicrotaskDigest();
  shared = sharedClient();
  rt.client = shared.client;
  rt.search = new URLSearchParams();
  rt.pushes = [];
  rt.refreshes = 0;
  rt.rendered = null;
  rt.analysisAnswer = null;
  installFetch();
  // no BroadcastChannel: the ended-lineage notice is delivered within this "tab" only (no handle keeps the run alive)
  vi.stubGlobal("BroadcastChannel", undefined);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54329";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon-key-not-a-secret";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Analyze ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// A3: the page belongs to the account its dashboard layout was rendered for (rt.rendered: what
// components/navigation/SessionKeeper.tsx RenderedSessionProvider gives it). Its data requests go through the REAL
// supabase-js client of lib/drill-hub-session.ts ownerBoundClient down to the recording fetch stub, so every request
// that would leave — and the credential it would carry — is on the wire record (`sent`). The managed client is the
// stand-in: its session reads are answered from what "the browser holds now" (shared.auto), and a test models another
// tab's publication by changing that, with NO event delivered unless it emits one (the account-change notification
// has not reached the page). A4 (C1): the analysis call is an ordinary fetch on the same wire record (analysisCalls()),
// answered by the stand-in network (rt.analysisAnswer).

const clubRow = (name: string) => ({
  id: randomUUID(), club_type: "Iron", club_designation: null, brand: "Synthetic", model: name,
  custom_club: false, custom_brand: null, custom_model: null, is_primary: false,
});
const SUPABASE_ORIGIN = "http://127.0.0.1:54329";
const lineageOfSession = async (s: Session) => (await sessionLineageId(s.access_token))!;

/** The browser now holds `s` (null: signed out); every later read sees it. No event is delivered. */
function browserHolds(s: Session | null | Error) {
  shared.auto.answer = () => (s instanceof Error ? s : { data: { session: s }, error: null });
}
/** The dashboard layout was rendered for `golfer` (and the lineage of `s`, when given). */
async function renderedFor(golfer: Golfer | null, s?: Session) {
  rt.rendered = golfer === null ? null : { ownerId: golfer.id, lineage: s ? await lineageOfSession(s) : null };
}

// What the page's requests are, as they would leave the browser
const clubReads = () => sent.filter((r) => r.url.startsWith(`${SUPABASE_ORIGIN}/rest/v1/user_equipment`) && r.method === "GET");
// A1: the clip goes through V1 authorize and its signed resumable transfer; one upload is one TUS creation, and its
// object key travels in the creation's Upload-Metadata (objectName)
const TUS_ENDPOINT = `${SUPABASE_ORIGIN}/storage/v1/upload/resumable/sign`;
const SIGNATURE = "synthetic-path-scoped-signature";
const authorizations = () => sent.filter((r) => r.url === "/api/v1/uploads/authorize");
const uploadsSent = () => sent.filter((r) => r.url === TUS_ENDPOINT && r.method === "POST");
const metadataOf = (r: Sent): Record<string, string> =>
  Object.fromEntries((r.uploadMetadata ?? "").split(",").filter(Boolean).map((pair) => {
    const [k, v] = pair.split(" ");
    return [k, Buffer.from(v, "base64").toString("utf8")];
  }));
const objectKeyOf = (r: Sent) => metadataOf(r).objectName ?? "";
const ownerOfBearer = (authorization: string | null) =>
  (JSON.parse(Buffer.from(String(authorization).replace(/^Bearer /, "").split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { sub?: string }).sub;
// P2: the swing_videos row is written by V1 finalize (the page holds no swing_videos write of its own any more)
const videoInserts = () => sent.filter((r) => r.url === "/api/v1/uploads/finalize");

const doorway = () => sent.filter((r) => r.url === "/api/v1/analyses");
const analysisCalls = () => sent.filter((r) => r.url === "/api/analyze-swing");
const HEALTHY_ANALYSIS = { data: { analysis_family: "full_swing", score: 82, feedback: "Synthetic feedback", metrics: {} } };
const carrying = (s: Session) => sent.filter((r) => r.authorization === `Bearer ${s.access_token}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The stand-in network for a healthy run: the clubs read, the Storage upload, the swing_videos insert and the doorway.
 * `onAnswered(kind)` runs as each request is answered (a test changes what the browser holds there).
 */
/** The clubs the stand-in answers with (one fixed list per test, so a re-check finds the club chosen from it). */
let bagRows = [clubRow("S7")];
type Answered = "clubs" | "authorize" | "create" | "upload" | "insert" | "doorway" | "analysis";
/** A1: the stand-in's signed transfers, by upload URL: bytes stored and the declared length. */
let transfers = new Map<string, { offset: number; length: number }>();
/**
 * A1: the stand-in for V1 authorize (the caller's own key, signed for that path) and the signed resumable endpoint
 * (creation, chunk, offset read), exactly as the local stack serves them; null for any other request.
 */
function signedStorage(r: Sent, onAnswered: (kind: Answered) => void): Response | null {
  if (r.url === "/api/v1/uploads/authorize") {
    onAnswered("authorize");
    const { uploadId, mimeType } = JSON.parse(r.body ?? "{}") as { uploadId: string; mimeType: string };
    return json({ data: {
      uploadId, bucket: "swing-videos", objectPath: `${ownerOfBearer(r.authorization)}/${uploadId}/source.mp4`, endpoint: TUS_ENDPOINT,
      signature: SIGNATURE, expiresInSeconds: 7200, chunkSize: 6291456, contentType: mimeType, upsert: false,
    } });
  }
  if (r.url === TUS_ENDPOINT && r.method === "POST") {
    onAnswered("create");
    const url = `${TUS_ENDPOINT}/upload-${transfers.size + 1}`;
    transfers.set(url, { offset: 0, length: Number(r.uploadLength) });
    return new Response(null, { status: 201, headers: { Location: url, "Tus-Resumable": "1.0.0" } });
  }
  if (r.url.startsWith(`${TUS_ENDPOINT}/`)) {
    const t = transfers.get(r.url);
    if (!t || r.signature !== SIGNATURE) return new Response(null, { status: 404 });
    if (r.method === "HEAD") return new Response(null, { status: 200, headers: { "Upload-Offset": String(t.offset), "Upload-Length": String(t.length) } });
    if (r.method === "PATCH") {
      if (Number(r.uploadOffset) !== t.offset) return new Response(null, { status: 409 });
      t.offset += r.bodySize ?? 0;
      onAnswered("upload");
      return new Response(null, { status: 204, headers: { "Upload-Offset": String(t.offset) } });
    }
  }
  return null;
}
function healthyNetwork(clubs = bagRows, onAnswered: (kind: Answered) => void = () => undefined) {
  answer = async (r) => {
    if (r.url.startsWith(`${SUPABASE_ORIGIN}/rest/v1/user_equipment`)) {
      onAnswered("clubs");
      return json(clubs);
    }
    const signed = signedStorage(r, onAnswered);
    if (signed) return signed;
    // P2: V1 finalize writes the one swing_videos row for the upload id
    if (r.url === "/api/v1/uploads/finalize") {
      onAnswered("insert");
      const { uploadId } = JSON.parse(r.body ?? "{}") as { uploadId: string };
      return json({ data: { swingVideoId: uploadId, uploadId, status: "uploaded" } });
    }
    if (r.url === "/api/v1/analyses") {
      onAnswered("doorway");
      return json({ data: { analysisId: "analysis-1" } }, 201);
    }
    if (r.url === "/api/analyze-swing") {
      onAnswered("analysis");
      return rt.analysisAnswer ? rt.analysisAnswer(r) : json(HEALTHY_ANALYSIS);
    }
    return new Response(null, { status: 404 });
  };
}

async function analyzeWithClubsFor(golfer: Golfer) {
  const s = sessionOf(golfer);
  bagRows = [clubRow("S7")];
  await renderedFor(golfer, s);
  browserHolds(s);
  healthyNetwork();
  const page = mount(AnalyzePage as () => unknown, undefined);
  await settle(page, 80);
  expect(page.text()).toContain("Synthetic S7");
  return { page, session: s };
}

describe("Analyze club panel — every session outcome settles, with fixed copy and one recovery action", () => {
  beforeEach(async () => {
    await renderedFor(A);
  });

  it("a refused (unconfirmed) read leaves loading, reads nothing, and offers Try again and Sign in again", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    expect(page.text()).toContain(ANALYZE.loading);
    expect(page.markup()).toMatch(/<p role="status" aria-live="polite" class="sr-only">Loading your bag…<\/p>/);
    read(0).reject(refusedRead());
    await settle(page);
    expect(page.text()).not.toContain(ANALYZE.loading);
    expect(page.text()).toContain(ANALYZE.clubsUnconfirmed);
    expect(page.button("Try again")).not.toBeNull();
    expect(page.markup()).toContain('href="/login"');
    // the same persistent region now announces the outcome
    expect(page.markup()).toContain(`<p role="status" aria-live="polite" class="sr-only">${ANALYZE.clubsUnconfirmed.replace(/'/g, "&#x27;")}</p>`);
    expect(sent).toHaveLength(0);
    expect(page.markup()).not.toMatch(RAW);
  });

  it("a failed read (rejected, or answered with an error) is unavailable — never a sign-out — and reads nothing", async () => {
    for (const fail of [
      (d: Deferred<SessionAnswer>) => d.reject(new TypeError("Failed to fetch (synthetic-internal)")),
      (d: Deferred<SessionAnswer>) => d.resolve({ data: { session: null }, error: { name: "AuthRetryableFetchError", message: "synthetic-internal" } }),
    ]) {
      shared = sharedClient();
      rt.client = shared.client;
      const page = mount(AnalyzePage as () => unknown, undefined);
      fail(read(0));
      await settle(page);
      expect(page.text()).toContain(ANALYZE.clubsUnavailable);
      expect(page.text()).not.toContain(ANALYZE.auth);
      expect(page.button("Try again")).not.toBeNull();
      expect(sent).toHaveLength(0);
      expect(page.markup()).not.toMatch(RAW);
      page.unmount();
    }
  });

  it("a read with no answer in time is unavailable after the bound, and its late answer is dropped", async () => {
    healthyNetwork();
    const page = mount(AnalyzePage as () => unknown, undefined);
    await vi.advanceTimersByTimeAsync(12_000);
    await settle(page);
    expect(page.text()).toContain(ANALYZE.clubsUnavailable);
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(page);
    expect(sent).toHaveLength(0); // the abandoned load never reads
    expect(page.text()).toContain(ANALYZE.clubsUnavailable);
  });

  it("a genuine sign-out keeps the established copy, offers Sign in again, and reads nothing", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    read(0).resolve({ data: { session: null }, error: null });
    await settle(page);
    expect(page.text()).toContain(ANALYZE.auth);
    expect(page.button("Try again")).toBeNull();
    expect(page.markup()).toContain('href="/login"');
    expect(sent).toHaveLength(0);
  });

  it("the rendered golfer's confirmed session reads exactly that golfer's clubs, on the wire with that golfer's token only", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    expect(clubReads()).toHaveLength(1);
    expect(clubReads()[0].url).toContain(`user_id=eq.${A.id}`);
    expect(clubReads()[0].authorization).toBe(`Bearer ${session.access_token}`);
    expect(sent.every((r) => r.authorization === `Bearer ${session.access_token}`)).toBe(true); // never anonymous
    expect(page.text()).not.toContain(ANALYZE.loading);
  });

  it("Try again after a failure loads once more (one load per press, a second press in the same moment adds none)", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    read(0).reject(refusedRead("unavailable"));
    await settle(page);
    const retry = page.button("Try again");
    const s = sessionOf(A);
    browserHolds(s);
    healthyNetwork();
    press(retry);
    press(retry); // before React re-renders
    page.render();
    await settle(page, 80);
    expect(page.text()).toContain("Synthetic S7");
    expect(clubReads()).toHaveLength(1);
  });

  it("a stale Try again pressed while the retried load is still in flight starts no second load", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    read(0).reject(refusedRead("unavailable"));
    await settle(page);
    const retry = page.button("Try again");
    press(retry);
    page.render(); // the retried load is now in flight (its session read is pending)
    await settle(page);
    expect(shared.client.auth.getSession).toHaveBeenCalledTimes(2);
    press(retry); // the same handler, from the earlier render
    page.render();
    await settle(page);
    expect(shared.client.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it("A3 forced: B is published between the page's confirmation of A and the read's credential selection (no event yet) — the read is NOT sent, nothing leaves with B's token, and A's view ends", async () => {
    const a = sessionOf(A);
    const b = sessionOf(B);
    await renderedFor(A, a);
    healthyNetwork();
    let reads = 0;
    // the page's own read confirms A; every read after it (the request's credential selection) finds B
    shared.auto.answer = () => ({ data: { session: reads++ === 0 ? a : b }, error: null });
    const page = mount(AnalyzePage as () => unknown, undefined);
    await settle(page, 80);
    expect(sent).toHaveLength(0); // not even A's token: the read was answered locally (owner_refused)
    expect(carrying(b)).toHaveLength(0);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    expect(page.button("Refresh page")).not.toBeNull();
    expect(shared.subscriberCount()).toBe(1); // nothing was emitted: the page learned it from its own checks
  });

  it("A3: a layout rendered for A while the browser already holds B (before the page ever ran) never adopts B: no request at all, the changed notice, and a run sends nothing", async () => {
    const b = sessionOf(B);
    await renderedFor(A);
    browserHolds(b);
    healthyNetwork();
    const page = mount(AnalyzePage as () => unknown, undefined);
    await settle(page, 80);
    expect(sent).toHaveLength(0);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    expect(page.text()).not.toContain("Synthetic S7");
    await withVideo(page);
    const readsBefore = shared.client.auth.getSession.mock.calls.length;
    press(runButton(page));
    await settle(page, 80);
    expect(banner(page)).toContain(ANALYZE.changed);
    expect(shared.client.auth.getSession.mock.calls.length).toBe(readsBefore); // the ended view runs nothing, not even a session read
    expect(sent).toHaveLength(0);
    expect(analysisCalls()).toHaveLength(0);
  });

  it("A3: without a rendered account (outside the dashboard layout) nothing is read or sent — fixed unconfirmed copy, never the browser's session adopted", async () => {
    await renderedFor(null);
    browserHolds(sessionOf(A));
    healthyNetwork();
    const page = mount(AnalyzePage as () => unknown, undefined);
    await settle(page, 80);
    expect(sent).toHaveLength(0);
    expect(page.text()).toContain(ANALYZE.clubsUnconfirmed);
    await withVideo(page);
    press(runButton(page));
    await settle(page, 80);
    expect(banner(page)).toContain(ANALYZE.unconfirmed);
    expect(sent).toHaveLength(0);
    expect(analysisCalls()).toHaveLength(0);
  });

  it("A3: an event carrying B before anything was loaded already ends the view of the rendered A (measured against the layout's account)", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    shared.emit("INITIAL_SESSION", sessionOf(B));
    await settle(page);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    read(0).resolve({ data: { session: sessionOf(A) }, error: null }); // a late read changes nothing
    await settle(page, 80);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    expect(sent).toHaveLength(0);
  });

  it("A3: the layout re-rendered for another account while the page stays mounted ends the page's view (client navigation keeps the old layout's account until then)", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await renderedFor(B);
    page.render();
    await settle(page);
    expect(page.text()).not.toContain("Synthetic S7");
    expect(page.text()).toContain(ANALYZE.clubsChanged);
  });

  it("A's clubs answer finishing after B became current is never shown (the answer's identity re-check names B)", async () => {
    const a = sessionOf(A);
    const b = sessionOf(B);
    browserHolds(a);
    healthyNetwork([clubRow("A-only club")], (kind) => {
      if (kind === "clubs") browserHolds(b); // B signs in elsewhere while A's read is in flight
    });
    const page = mount(AnalyzePage as () => unknown, undefined);
    await settle(page, 80);
    expect(clubReads()).toHaveLength(1);
    expect(clubReads()[0].authorization).toBe(`Bearer ${a.access_token}`);
    expect(page.text()).not.toContain("A-only club");
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    expect(page.button("Refresh page")).not.toBeNull();
  });

  it("an answer whose identity re-check finds a sign-out is never shown", async () => {
    browserHolds(sessionOf(A));
    healthyNetwork([], (kind) => {
      if (kind === "clubs") browserHolds(null);
    });
    const page = mount(AnalyzePage as () => unknown, undefined);
    await settle(page, 80);
    expect(page.text()).not.toContain("No saved clubs");
    expect(page.text()).toContain(ANALYZE.auth);
  });

  it("an account change after A's clubs were shown clears them and the chosen club at once, and offers Refresh, not Try again", async () => {
    const { page } = await analyzeWithClubsFor(A);
    const selector = findAll(page.nodes(), (n) => n.type === "select" && "data-club-selector" in n.props)[0];
    const clubId = (findAll(selector.children as (HostNode | string)[], (n) => n.type === "option")[0].props.value) as string;
    (selector.props.onChange as (e: unknown) => void)({ target: { value: clubId } });
    page.render();
    expect(findAll(page.nodes(), (n) => n.type === "select" && "data-club-selector" in n.props)[0].props.value).toBe(clubId);
    shared.emit("SIGNED_IN", sessionOf(B));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic S7");
    expect(findAll(page.nodes(), (n) => n.type === "select" && "data-club-selector" in n.props)).toHaveLength(0);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
    expect(page.button("Try again")).toBeNull(); // refresh, not retry, for another account
    expect(page.button("Refresh page")).not.toBeNull();
  });

  it("a sign-out event clears the clubs and says so", async () => {
    const { page } = await analyzeWithClubsFor(A);
    shared.emit("SIGNED_OUT", null);
    await settle(page);
    expect(page.text()).not.toContain("Synthetic S7");
    expect(page.text()).toContain(ANALYZE.auth);
  });

  it("End Session of A's lineage (anywhere in the browser) ends the view; another lineage — even A's newer sign-in — does not", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    const newer = await sessionLineageId(sessionOf(A, `sid-newer-${randomUUID()}`).access_token);
    announceEndedLineage(newer!);
    await settle(page);
    expect(page.text()).toContain("Synthetic S7");
    announceEndedLineage(await lineageOfSession(session));
    await settle(page);
    expect(page.text()).not.toContain("Synthetic S7");
    expect(page.text()).toContain(ANALYZE.auth);
  });

  it("A3: End Session of the RENDERED lineage ends the view from the moment the page mounts (before any read answered)", async () => {
    const a = sessionOf(A);
    await renderedFor(A, a);
    const page = mount(AnalyzePage as () => unknown, undefined);
    announceEndedLineage(await lineageOfSession(a));
    await settle(page);
    expect(page.text()).toContain(ANALYZE.auth);
    browserHolds(a);
    read(0).resolve({ data: { session: a }, error: null });
    await settle(page, 80);
    expect(sent).toHaveLength(0); // the ended view reads nothing afterwards
  });

  it("unmounting cancels: a load finishing afterwards changes nothing and leaves no subscription", async () => {
    const page = mount(AnalyzePage as () => unknown, undefined);
    expect(shared.subscriberCount()).toBe(1);
    page.unmount();
    expect(shared.subscriberCount()).toBe(0);
    rt.dirty = false;
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(page);
    expect(sent).toHaveLength(0);
    expect(rt.dirty).toBe(false);
  });

  it("a GENUINE refusal from the real shared storage is classified as unconfirmed (not signed out, not SDK text)", async () => {
    const storage = await import("@/utils/supabase/session-storage");
    const lease = await import("@/utils/supabase/session-lease");
    vi.stubGlobal("document", { cookie: "", getElementById: () => null });
    vi.stubGlobal("navigator", { locks: { request: () => Promise.resolve() } });
    const sdkStorage = storage.createSessionStorage("sb-127-auth-token");
    lease.configureLineage({
      jarView: storage.storedJarView,
      store: { read: () => Promise.reject(new Error("synthetic store failure")), append: () => Promise.reject(new Error("synthetic")) },
    });
    let refusal: unknown = null;
    await sdkStorage.getItem("sb-127-auth-token").catch((e: unknown) => {
      refusal = e;
    });
    expect(storage.sessionUnverifiedReason(refusal)).not.toBeNull();
    const page = mount(AnalyzePage as () => unknown, undefined);
    read(0).reject(refusal);
    await settle(page);
    expect(page.text()).toContain(ANALYZE.clubsUnconfirmed);
    expect(page.markup()).not.toMatch(RAW);
  });
});

// ─── Analyze submission ──────────────────────────────────────────────────────────────────────────────────────────────

async function withVideo(page: Mounted) {
  const input = findAll(page.nodes(), (n) => n.type === "input" && n.props.type === "file" && n.props.accept === "video/*")[0];
  const video = new File([new Uint8Array(4096)], "swing.mp4", { type: "video/mp4" });
  (input.props.onChange as (e: unknown) => void)({ target: { files: [video], value: "" } });
  page.render();
  const element = findAll(page.nodes(), (n) => n.type === "video" && n.ref !== null)[0];
  (element.ref as { current: unknown }).current = {
    readyState: 0, duration: 0, videoWidth: 1280, videoHeight: 720, currentTime: 0,
    addEventListener: () => undefined, removeEventListener: () => undefined, pause: () => undefined,
  };
  page.render();
  return video;
}
const runButton = (page: Mounted) => page.button("RUN ANALYZER");
const banner = (page: Mounted) => findAll(page.nodes(), (n) => n.props.role === "alert").map((n) => textOf(n.children)).join(" ");
const hasVideo = (page: Mounted) => findAll(page.nodes(), (n) => n.type === "video" && n.ref !== null).length > 0;
/** Selects the first club in A's panel (so the run re-checks it). */
function chooseFirstClub(page: Mounted) {
  const selector = findAll(page.nodes(), (n) => n.type === "select" && "data-club-selector" in n.props)[0];
  const clubId = (findAll(selector.children as (HostNode | string)[], (n) => n.type === "option")[0].props.value) as string;
  (selector.props.onChange as (e: unknown) => void)({ target: { value: clubId } });
  page.render();
}

describe("Analyze submission — no upload without the page's confirmed golfer; fixed copy; the video stays selected", () => {
  async function startRun(page: Mounted, turns = 80) {
    press(runButton(page));
    await settle(page, turns);
  }

  it.each([
    ["refused (unconfirmed)", () => refusedRead(), ANALYZE.unconfirmed],
    ["failed", () => new TypeError("Load failed synthetic-internal"), ANALYZE.unavailable],
  ])("a %s session read stops before Storage with fixed copy and settles", async (_label, failure, copy) => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    browserHolds(failure());
    await startRun(page);
    expect(banner(page)).toContain(copy);
    expect(banner(page)).not.toMatch(RAW);
    expect(sent).toHaveLength(0);
    expect(analysisCalls()).toHaveLength(0);
    expect(runButton(page)).not.toBeNull(); // not busy any more; the video is still selected
  });

  it.each([
    ["answered with an error", { data: { session: null }, error: { message: "synthetic-internal" } }, ANALYZE.unavailable],
    ["signed out", { data: { session: null }, error: null }, ANALYZE.expired],
  ])("a session read %s stops before Storage with fixed copy and settles", async (_label, outcome, copy) => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    shared.auto.answer = () => outcome as SessionAnswer;
    await startRun(page);
    expect(banner(page)).toContain(copy);
    expect(sent).toHaveLength(0);
  });

  it("a session of another account than the page was rendered for is never analyzed, and the page's view ends", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    const b = sessionOf(B);
    browserHolds(b);
    await startRun(page);
    expect(banner(page)).toContain(ANALYZE.changed);
    expect(sent).toHaveLength(0);
    expect(analysisCalls()).toHaveLength(0);
    expect(page.text()).toContain(ANALYZE.clubsChanged);
  });

  it("A's session read finishing after B's event stops before the upload", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    shared.auto.held = 1;
    press(runButton(page));
    await settle(page);
    shared.emit("SIGNED_IN", sessionOf(B));
    await settle(page);
    shared.sessionReads.at(-1)!.resolve({ data: { session }, error: null });
    await settle(page, 80);
    expect(banner(page)).toContain(ANALYZE.changed);
    expect(uploadsSent()).toHaveLength(0);
  });

  it("an account change (its event) during the upload stops the analysis before any row is written", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    healthyNetwork(undefined, (kind) => {
      if (kind === "upload") shared.emit("SIGNED_IN", sessionOf(B));
    });
    await startRun(page);
    expect(uploadsSent()).toHaveLength(1);
    expect(objectKeyOf(uploadsSent()[0])).toMatch(new RegExp(`^${A.id}/`)); // A1: A's own key, signed for A
    expect(authorizations()[0].authorization).toBe(`Bearer ${session.access_token}`);
    expect(uploadsSent()[0].authorization).toBeNull(); // the transfer carries only the path-scoped signature
    expect(banner(page)).toContain(ANALYZE.changed);
    expect(videoInserts()).toHaveLength(0);
    expect(doorway()).toHaveLength(0);
  });

  it("a submission's session read with no answer in time settles as unavailable (bounded), and sends nothing", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    shared.auto.held = 1;
    press(runButton(page));
    await settle(page);
    await vi.advanceTimersByTimeAsync(12_000);
    await settle(page);
    expect(banner(page)).toContain(ANALYZE.unavailable);
    expect(runButton(page)).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a session whose End Session the server already confirmed (its removal still pending here) is not used", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    const lineage = await lineageOfSession(session);
    vi.stubGlobal("document", { cookie: `swingproai-session-ended=${lineage}`, getElementById: () => null });
    await withVideo(page);
    sent = [];
    await startRun(page);
    expect(banner(page)).toContain(ANALYZE.expired);
    expect(sent).toHaveLength(0);
  });

  it("A4 (C1): a NEWER sign-in of the same golfer in the jar when the analysis call is confirmed: the call carries that newer token of the rendered account, never another account's", async () => {
    const { page, session: a1 } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    const a2 = sessionOf(A); // a newer sign-in of A (another lineage)
    healthyNetwork(undefined, (kind) => {
      if (kind === "doorway") browserHolds(a2);
    });
    await startRun(page);
    expect(doorway()[0].authorization).toBe(`Bearer ${a1.access_token}`);
    expect(analysisCalls().map((r) => [r.authorization, r.credentials])).toEqual([[`Bearer ${a2.access_token}`, "omit"]]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("A3/A4: a healthy run — every request leaves as the rendered golfer: the re-check, upload and insert with A's token, the doorway AND the analysis call with A's Bearer and no cookie; the result is shown", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    chooseFirstClub(page);
    await withVideo(page);
    sent = [];
    await startRun(page);
    expect(sent.map((r) => r.url.split("?")[0])).toEqual([
      `${SUPABASE_ORIGIN}/rest/v1/user_equipment`, // the club re-check
      "/api/v1/uploads/authorize", // A1: V1 authorize signs this selection's V1 key
      TUS_ENDPOINT, // A1: the signed transfer's creation …
      `${TUS_ENDPOINT}/upload-1`, // … and its chunk
      "/api/v1/uploads/finalize", // P2: V1 finalize writes the swing_videos row
      "/api/v1/analyses",
      "/api/analyze-swing", // A4 (C1): an ordinary request now, on the wire record
    ]);
    // A1: every request that carries a credential carries A's; the transfer carries only the path-scoped signature
    expect(sent.filter((r) => !r.url.startsWith(TUS_ENDPOINT)).every((r) => r.authorization === `Bearer ${session.access_token}`)).toBe(true);
    expect(sent.filter((r) => r.url.startsWith(TUS_ENDPOINT)).every((r) => r.authorization === null && r.signature === SIGNATURE)).toBe(true);
    // review: no redirect is ever followed with the signature
    expect(sent.filter((r) => r.url.startsWith(TUS_ENDPOINT)).map((r) => r.redirect)).toEqual(["error", "error"]);
    // P2: one upload id from the Storage key to the analysis request; the selection's clip metadata goes with finalize
    const uploadId = (JSON.parse(videoInserts()[0].body!) as { uploadId: string }).uploadId;
    expect(objectKeyOf(uploadsSent()[0])).toBe(`${A.id}/${uploadId}/source.mp4`);
    expect(JSON.parse(authorizations()[0].body!)).toEqual({ uploadId, mimeType: "video/mp4", fileSize: 4096 });
    expect(JSON.parse(videoInserts()[0].body!)).toEqual({ uploadId, mimeType: "video/mp4", originalFilename: "swing.mp4" });
    expect(videoInserts()[0].credentials).toBe("omit");
    expect(JSON.parse(doorway()[0].body!)).toEqual({ swingVideoId: uploadId, clubId: expect.any(String) });
    expect(doorway()[0].credentials).toBe("omit"); // A3 review: the Bearer alone; no cookie (possibly another sign-in's) goes with it
    // A4 (C1): the analysis call likewise — A's confirmed Bearer, `credentials: "omit"`, no cancel signal once sent
    expect(analysisCalls().map(({ method, body, credentials, cancellable }) => ({ method, body, credentials, cancellable }))).toEqual([
      { method: "POST", body: JSON.stringify({ analysisId: "analysis-1" }), credentials: "omit", cancellable: false },
    ]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("A4 (C1) forced: B published immediately AFTER the analysis call's confirmation and before it is sent (an obsolete writer; no event) — the call still carries only A's confirmed Bearer and no cookie; nothing carries B's token", async () => {
    const { page, session: a } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    const b = sessionOf(B);
    let doorwayAnswered = false;
    healthyNetwork(undefined, (kind) => {
      if (kind === "doorway") doorwayAnswered = true;
    });
    // the read after the doorway is the analysis call's confirmation: it sees A, and B lands right after it
    shared.auto.answer = () => {
      const now = { data: { session: a }, error: null };
      if (doorwayAnswered) browserHolds(b);
      return now;
    };
    await startRun(page);
    expect(analysisCalls()).toHaveLength(1);
    expect(analysisCalls()[0].authorization).toBe(`Bearer ${a.access_token}`);
    expect(analysisCalls()[0].credentials).toBe("omit");
    expect(carrying(b)).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete"); // A's own result for A's own request
  });

  it("a deliberate run after a failed one goes through once, and its result is shown", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    browserHolds(new TypeError("Failed to fetch synthetic-internal"));
    await startRun(page);
    expect(banner(page)).toContain(ANALYZE.unavailable);
    browserHolds(session);
    await startRun(page);
    expect(doorway()).toHaveLength(1);
    expect(analysisCalls()).toHaveLength(1);
    expect(uploadsSent()).toHaveLength(1);
    expect(page.text()).toContain("Analysis Complete");
  });

  // A3 (F1) — the decisive schedules: B is published (the browser now holds B) right after A was confirmed for a step,
  // before the page has been told (no event). Nothing may leave with B's credential; the step is not sent at all.
  for (const [step, flipAt, sentBefore, copy] of [
    ["the club re-check", "submission-read", [] as string[], ANALYZE.changed],
    // A1: the upload starts with V1 authorize, which confirms the owner itself
    ["the upload authorization", "clubs", ["user_equipment"], ANALYZE.changed],
    // A1: the signed transfer carries no account credential (only A's path-scoped signature, for A's own key); the next
    // credentialed request, finalize, is the one that is not sent
    ["finalize after the signed transfer (B published once A's upload was authorized)", "authorize", ["user_equipment", "/api/v1/uploads/authorize", "storage", "storage"], ANALYZE.changed],
    // P2: V1 finalize writes the swing_videos row
    ["finalize (the swing_videos row)", "upload", ["user_equipment", "/api/v1/uploads/authorize", "storage", "storage"], ANALYZE.changed],
    ["the analysis-request doorway", "insert", ["user_equipment", "/api/v1/uploads/authorize", "storage", "storage", "/api/v1/uploads/finalize"], ANALYZE.changed],
    // A4 (C1): the analysis call confirms the owner itself (it no longer goes to a cookie sender)
    ["the analysis call", "doorway", ["user_equipment", "/api/v1/uploads/authorize", "storage", "storage", "/api/v1/uploads/finalize", "/api/v1/analyses"], ANALYZE.changed],
  ] as const) {
    it(`A3 forced: B published just before ${step} (no event yet) — that request is not sent, nothing carries B's token, fixed copy`, async () => {
      const { page, session: a } = await analyzeWithClubsFor(A);
      chooseFirstClub(page);
      await withVideo(page);
      sent = [];
      const b = sessionOf(B);
      let submissionReads = 0;
      if (flipAt === "submission-read") {
        // the run's own read confirms A; the very next read (the re-check's credential selection) finds B
        shared.auto.answer = () => ({ data: { session: submissionReads++ === 0 ? a : b }, error: null });
      }
      healthyNetwork(undefined, (kind) => {
        if (kind === flipAt) browserHolds(b);
      });
      await startRun(page);
      expect(carrying(b)).toHaveLength(0);
      // A1: every credentialed request is A's; the signed transfer carries no account credential at all
      expect(sent.filter((r) => !r.url.includes("/storage/")).every((r) => r.authorization === `Bearer ${a.access_token}`)).toBe(true);
      expect(sent.filter((r) => r.url.includes("/storage/")).every((r) => r.authorization === null)).toBe(true);
      const kinds = sent.map((r) => (r.url.includes("user_equipment") ? "user_equipment" : r.url.includes("/storage/") ? "storage" : r.url));
      expect(kinds).toEqual(sentBefore);
      expect(analysisCalls()).toHaveLength(0);
      expect(rt.pushes).toEqual([]);
      expect(banner(page)).toContain(copy);
      expect(banner(page)).not.toMatch(RAW);
      expect(page.text()).toContain(ANALYZE.clubsChanged); // A3 review: the page ends its view itself (no event was delivered)
      expect(page.text()).not.toContain("Synthetic S7");
    });
  }

  // A4 (C1): A3's cookie preflight is retired with the cookie sender. The analysis call no longer depends on the session
  // cookie or its binding at all (it carries the confirmed Bearer and no cookie), so a jar with no binding yet (the legacy
  // state) no longer refuses a run; another account's session and an ended session are still refused before any side
  // effect by the run's own confirmation (the tests above), and an account change just before the analysis call by its
  // own confirmation (the forced schedule above, "the analysis call").
  it("A4 (C1): the run's checks before any side effect are the session read, the rendered owner and its End Session — nothing reads or depends on the cookie's binding", async () => {
    const page = source("app/(dashboard)/analyze/page.tsx");
    const run = page.slice(page.indexOf("const startAnalysis = async () => {"), page.indexOf("// 1. Upload the clip"));
    expect(run).not.toMatch(/Preflight|binding|document\.cookie/i);
    expect(run).toContain("if (userId !== ownerRef.current) {");
    expect(run).toContain("if (await sessionEndPending(session)) throw new Error(SESSION_EXPIRED_MESSAGE);");
  });

  it("an analysis that finishes after B became current shows nothing of it, navigates nowhere, and says why", async () => {
    for (const family of ["full_swing", "putting"]) {
      shared = sharedClient();
      rt.client = shared.client;
      rt.pushes = [];
      sent = [];
      const { page } = await analyzeWithClubsFor(A);
      await withVideo(page);
      const gate = deferred<Response>();
      rt.analysisAnswer = () => gate.promise;
      await startRun(page);
      expect(analysisCalls()).toHaveLength(1);
      shared.emit("SIGNED_IN", sessionOf(B)); // while the analysis is running
      gate.resolve(json({ data: { analysis_family: family, score: 82, feedback: "Synthetic A feedback", metrics: {} } }));
      await settle(page, 80);
      expect(page.text()).not.toContain("Analysis Complete");
      expect(page.text()).not.toContain("Synthetic A feedback");
      expect(rt.pushes).toEqual([]);
      expect(banner(page)).toContain(ANALYZE.afterChange);
      page.unmount();
    }
  });

  it("an analysis that finishes after the golfer left the page changes nothing and navigates nowhere", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const gate = deferred<Response>();
    rt.analysisAnswer = () => gate.promise;
    await startRun(page);
    page.unmount();
    rt.dirty = false;
    gate.resolve(json({ data: { analysis_family: "putting" } }));
    await settle(page, 80);
    expect(rt.pushes).toEqual([]);
  });

  it("A4 (C1): leaving the page while the analysis call's confirmation is still pending sends nothing; a call already sent runs on (the page gives it no cancel signal)", async () => {
    const { page, session: a } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    let doorwayAnswered = false;
    healthyNetwork(undefined, (kind) => {
      if (kind === "doorway") {
        doorwayAnswered = true;
        shared.auto.held = 1; // the next read — the analysis call's confirmation — is held
      }
    });
    await startRun(page);
    expect(doorwayAnswered).toBe(true);
    expect(analysisCalls()).toHaveLength(0); // waiting for its confirmation
    page.unmount();
    shared.sessionReads.at(-1)!.resolve({ data: { session: a }, error: null });
    await settle(page, 80);
    expect(analysisCalls()).toHaveLength(0); // left before it was sent: never sent
    expect(rt.pushes).toEqual([]);
  });

  it("a press while an analysis runs starts nothing more", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const gate = deferred<Response>();
    rt.analysisAnswer = () => gate.promise;
    sent = [];
    const run = runButton(page);
    press(run);
    press(run); // before React re-renders the busy overlay
    await settle(page, 80);
    expect(uploadsSent()).toHaveLength(1);
    expect(analysisCalls()).toHaveLength(1);
    expect(analysisCalls()[0].cancellable).toBe(false); // once sent it runs on, as before A3
  });

  it("SDK or runtime error text is never shown: a refused read inside the upload's credential selection is 'unconfirmed' (and the upload is not sent)", async () => {
    const { page, session: a } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    let reads = 0;
    // the run's own read confirms A; the upload's credential selection is refused by the shared storage
    shared.auto.answer = () => (reads++ === 0 ? { data: { session: a }, error: null } : refusedRead("unrecorded"));
    await startRun(page);
    expect(uploadsSent()).toHaveLength(0);
    expect(banner(page)).toContain(ANALYZE.unconfirmed);
    expect(banner(page)).not.toMatch(RAW);
  });

  it("SDK or runtime error text is never shown: a runtime failure of the analysis call is fixed copy", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    rt.analysisAnswer = async () => {
      throw new RangeError("AuthRetryableFetchError: synthetic-internal");
    };
    await startRun(page);
    expect(banner(page)).toContain(ANALYZE.failed);
    expect(banner(page)).not.toMatch(RAW);
  });

  // ── AG-WEB-READY-10-P2 (C5): one stable upload identity per deliberate selection ─────────────────────────────
  const finalizeIds = () => videoInserts().map((r) => (JSON.parse(r.body!) as { uploadId: string }).uploadId);

  it("P2: the same selection pressed again after a lost answer re-sends the same upload id: finalize first, no second upload, the same analysis request", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    rt.analysisAnswer = async () => { throw new TypeError("Failed to fetch"); }; // the analysis call's answer is lost
    await startRun(page);
    expect(analysisCalls()).toHaveLength(1);
    const first = finalizeIds()[0];
    expect(objectKeyOf(uploadsSent()[0])).toBe(`${A.id}/${first}/source.mp4`);
    rt.analysisAnswer = null;
    sent = [];
    await startRun(page);
    expect(sent.map((r) => r.url.replace(/\?.*/, ""))).toEqual(["/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing"]);
    expect(finalizeIds()).toEqual([first]);
    expect(uploadsSent()).toHaveLength(0);
    expect(JSON.parse(doorway()[0].body!)).toMatchObject({ swingVideoId: first });
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P2: a repeat whose object was never stored uploads it once after finalize says so", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    rt.analysisAnswer = async () => { throw new TypeError("Failed to fetch"); };
    await startRun(page);
    const first = finalizeIds()[0];
    rt.analysisAnswer = null;
    let finalizes = 0;
    const healthy = answer;
    answer = async (r, signal) => {
      if (r.url === "/api/v1/uploads/finalize" && finalizes++ === 0) {
        return json({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY", message: "The upload could not be found or is not ready." } }, 409);
      }
      return healthy(r, signal);
    };
    transfers.clear(); // A1: the earlier transfer is gone too (nothing of it can be resumed)
    sent = [];
    await startRun(page);
    expect(sent.map((r) => (r.url.includes("/storage/") ? `storage ${r.method}` : r.url.replace(/\?.*/, "")))).toEqual(
      ["/api/v1/uploads/finalize", "storage HEAD", "/api/v1/uploads/authorize", "storage POST", "storage PATCH", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing"]);
    expect(finalizeIds()).toEqual([first, first]);
    expect(objectKeyOf(uploadsSent()[0])).toBe(`${A.id}/${first}/source.mp4`); // the same key, signed again
  });

  it("P2: another file, or another club, is a new deliberate selection with a new upload id", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    rt.analysisAnswer = async () => { throw new TypeError("Failed to fetch"); };
    await startRun(page);
    const first = finalizeIds()[0];
    chooseFirstClub(page); // the same file, now with a club
    rt.analysisAnswer = null;
    sent = [];
    await startRun(page);
    const second = finalizeIds()[0];
    expect(second).not.toBe(first);
    expect(uploadsSent()).toHaveLength(1);
    expect(page.text()).toContain("Analysis Complete");
    press(page.button("NEW VIDEO")); // the page's own control for another file
    page.render();
    await withVideo(page); // another file
    sent = [];
    await startRun(page);
    const third = finalizeIds()[0];
    expect(new Set([first, second, third]).size).toBe(3);
    expect(objectKeyOf(uploadsSent()[0])).toBe(`${A.id}/${third}/source.mp4`);
    // the identity is the page's account's: another account's session never reuses it (the run stops first)
    expect(source("app/(dashboard)/analyze/page.tsx")).toContain("intent.ownerId !== null && intent.ownerId === selection.ownerId");
  });

  it("a Storage refusal keeps its fixed upload copy (unchanged behaviour)", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    // A1: the refusal now comes from the signed transfer's creation (authorize itself answered)
    answer = async (r) =>
      r.url === TUS_ENDPOINT && r.method === "POST"
        ? json({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy synthetic-internal" }, 403)
        : signedStorage(r, () => undefined) ?? new Response(null, { status: 404 });
    await startRun(page);
    expect(banner(page)).toContain(ANALYZE.uploadFailed);
    expect(banner(page)).not.toMatch(RAW);
  });

  // ── AG-WEB-READY-10-P2-A1: the V1 authorize answer and its scoped signed transport ─────────────────────────────
  const tus = () => sent.filter((r) => r.url === TUS_ENDPOINT || r.url.startsWith(`${TUS_ENDPOINT}/`));

  it("A1: the first transfer uses exactly the V1 authorize answer: its endpoint and path-scoped signature over the resumable protocol, then V1 finalize; no Bearer or cookie goes to Storage", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    await withVideo(page);
    sent = [];
    await startRun(page);
    const auth = authorizations();
    expect(auth).toHaveLength(1);
    const uploadId = finalizeIds()[0];
    expect(JSON.parse(auth[0].body!)).toEqual({ uploadId, mimeType: "video/mp4", fileSize: 4096 });
    expect([auth[0].method, auth[0].authorization, auth[0].credentials]).toEqual(["POST", `Bearer ${session.access_token}`, "omit"]);
    const [create, patch, ...rest] = tus();
    expect(rest).toEqual([]);
    expect([create.method, create.url, create.signature, create.uploadLength, create.authorization, create.credentials])
      .toEqual(["POST", TUS_ENDPOINT, SIGNATURE, "4096", null, "omit"]);
    expect(metadataOf(create)).toEqual({ bucketName: "swing-videos", objectName: `${A.id}/${uploadId}/source.mp4`, contentType: "video/mp4", cacheControl: "3600" });
    expect([patch.method, patch.url, patch.signature, patch.uploadOffset, patch.bodySize, patch.authorization, patch.credentials])
      .toEqual(["PATCH", `${TUS_ENDPOINT}/upload-1`, SIGNATURE, "0", 4096, null, "omit"]);
    // the order: authorize, the signed transfer, then finalize, the doorway and the analysis call
    const order = sent.map((r) => r.url);
    expect(order.indexOf("/api/v1/uploads/authorize")).toBeLessThan(order.indexOf(TUS_ENDPOINT));
    expect(order.indexOf(`${TUS_ENDPOINT}/upload-1`)).toBeLessThan(order.indexOf("/api/v1/uploads/finalize"));
    expect(page.text()).toContain("Analysis Complete");
  });

  for (const [label, change] of [
    ["another upload id", (d: Record<string, unknown>) => ({ ...d, uploadId: randomUUID() })],
    ["another golfer's key", (d: Record<string, unknown>) => ({ ...d, objectPath: `${B.id}/${d.uploadId}/source.mp4` })],
    ["another content type", (d: Record<string, unknown>) => ({ ...d, contentType: "video/webm" })],
    ["an upsert", (d: Record<string, unknown>) => ({ ...d, upsert: true })],
    ["another chunk size", (d: Record<string, unknown>) => ({ ...d, chunkSize: 1024 })],
    ["no signature", (d: Record<string, unknown>) => ({ ...d, signature: "" })],
    ["a plain-http remote endpoint", (d: Record<string, unknown>) => ({ ...d, endpoint: "http://storage.invalid/storage/v1/upload/resumable/sign" })],
    // review: only the endpoint this deployment's project URL implies
    ["a hosted endpoint this deployment does not use", (d: Record<string, unknown>) => ({ ...d, endpoint: "https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable/sign" })],
    ["another loopback port", (d: Record<string, unknown>) => ({ ...d, endpoint: "http://127.0.0.1:54321/storage/v1/upload/resumable/sign" })],
  ] as const) {
    it(`A1: an authorize answer with ${label} is refused: nothing is transferred, fixed upload copy`, async () => {
      const { page } = await analyzeWithClubsFor(A);
      await withVideo(page);
      const healthy = answer;
      answer = async (r, signal) => {
        if (r.url === "/api/v1/uploads/authorize") {
          const good = (await (await healthy(r, signal)).json()) as { data: Record<string, unknown> };
          return json({ data: change(good.data) });
        }
        return healthy(r, signal);
      };
      sent = [];
      await startRun(page);
      expect(tus()).toEqual([]);
      expect(videoInserts()).toHaveLength(0); // nothing was transferred, so nothing is finalized
      expect(doorway()).toHaveLength(0);
      expect(banner(page)).toContain(ANALYZE.uploadFailed);
    });
  }

  it("A1: a creation Location on another origin is refused: the signature is never sent there", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const healthy = answer;
    answer = async (r, signal) => r.url === TUS_ENDPOINT && r.method === "POST"
      ? new Response(null, { status: 201, headers: { Location: "http://elsewhere.invalid/storage/v1/upload/resumable/sign/x" } })
      : healthy(r, signal);
    sent = [];
    await startRun(page);
    expect(sent.filter((r) => r.url.includes("elsewhere.invalid"))).toEqual([]);
    expect(tus().map((r) => r.method)).toEqual(["POST"]);
    expect(doorway()).toHaveLength(0);
    expect(banner(page)).toContain(ANALYZE.uploadFailed);
  });

  it("A1: the last chunk's acknowledgement is lost after it was stored: the page reads the stored offset and finalizes without re-sending a byte", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const healthy = answer;
    answer = async (r, signal) => {
      if (r.method === "PATCH") {
        await healthy(r, signal); // stored by the stand-in …
        throw new TypeError("Failed to fetch"); // … and its answer lost
      }
      return healthy(r, signal);
    };
    sent = [];
    await startRun(page);
    expect(tus().map((r) => r.method)).toEqual(["POST", "PATCH", "HEAD"]);
    expect(tus().map((r) => r.redirect)).toEqual(["error", "error", "error"]); // review 2: the offset read too
    expect(authorizations()).toHaveLength(1);
    expect(videoInserts()).toHaveLength(1);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("A1: a transfer interrupted part-way is resumed by the repeat press from the server's offset: one authorization, one creation, finalize first", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const healthy = answer;
    let refuse = true;
    answer = async (r, signal) => {
      if (refuse && (r.method === "PATCH" || r.method === "HEAD")) throw new TypeError("Failed to fetch"); // the connection drops
      // finalize finds nothing stored while the transfer is incomplete (as V1 finalize does)
      if (r.url === "/api/v1/uploads/finalize" && Array.from(transfers.values()).some((t) => t.offset < t.length)) {
        return json({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY", message: "The upload could not be found or is not ready." } }, 409);
      }
      return healthy(r, signal);
    };
    sent = [];
    await startRun(page);
    // P3: the status read was lost too, so how much arrived is not confirmed: the transfer is kept for the repeat
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(tus().filter((r) => r.method === "POST")).toHaveLength(1);
    expect(videoInserts()).toHaveLength(0);
    refuse = false;
    const firstId = (JSON.parse(authorizations()[0].body!) as { uploadId: string }).uploadId;
    sent = [];
    await startRun(page);
    // the repeat asks finalize first (nothing stored yet), then resumes the same transfer from the server's offset
    expect(sent.map((r) => (r.url.startsWith(TUS_ENDPOINT) ? `tus ${r.method}` : r.url))).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(finalizeIds()).toEqual([firstId, firstId]);
    expect(authorizations()).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("A1 (review): a 13 MiB clip goes in three 6 MiB-bounded chunks; a drop after the first chunk is resumed by the repeat press from the server's offset (mid-file), never from 0", async () => {
    const { page } = await analyzeWithClubsFor(A);
    const size = 13 * 1_048_576;
    {
      const input = findAll(page.nodes(), (n) => n.type === "input" && n.props.type === "file" && n.props.accept === "video/*")[0];
      const video = new File([new Uint8Array(size)], "swing.mp4", { type: "video/mp4" });
      (input.props.onChange as (e: unknown) => void)({ target: { files: [video], value: "" } });
      page.render();
      const element = findAll(page.nodes(), (n) => n.type === "video" && n.ref !== null)[0];
      (element.ref as { current: unknown }).current = {
        readyState: 0, duration: 0, videoWidth: 1280, videoHeight: 720, currentTime: 0,
        addEventListener: () => undefined, removeEventListener: () => undefined, pause: () => undefined,
      };
      page.render();
    }
    const healthy = answer;
    let patches = 0;
    let drop = true;
    answer = async (r, signal) => {
      if (drop && r.method === "PATCH" && ++patches > 1) throw new TypeError("Failed to fetch"); // the second chunk is lost …
      if (drop && r.method === "HEAD") throw new TypeError("Failed to fetch"); // … and so is the offset read
      if (r.url === "/api/v1/uploads/finalize" && Array.from(transfers.values()).some((t) => t.offset < t.length)) {
        return json({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY", message: "The upload could not be found or is not ready." } }, 409);
      }
      return healthy(r, signal);
    };
    sent = [];
    await startRun(page);
    // P3: the status read was lost too, so how much arrived is not confirmed: the transfer is kept for the repeat
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(tus().filter((r) => r.method === "PATCH").map((r) => [r.uploadOffset, r.bodySize])).toEqual([["0", 6291456], ["6291456", 6291456]]);
    expect(Array.from(transfers.values())).toEqual([{ offset: 6291456, length: size }]);
    drop = false;
    sent = [];
    await startRun(page);
    expect(sent.map((r) => (r.url.startsWith(TUS_ENDPOINT) ? `tus ${r.method} ${r.uploadOffset ?? ""}`.trim() : r.url))).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 6291456", "tus PATCH 12582912",
      "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(tus().filter((r) => r.method === "PATCH").map((r) => r.bodySize)).toEqual([6291456, size - 12582912]);
    expect(Array.from(transfers.values())).toEqual([{ offset: size, length: size }]); // one transfer, every byte once
    expect(authorizations()).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("A1 (review): a 409 stalled that names an interrupted attempt hands over to its report; a synchronous stall stays on the banner", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    rt.analysisAnswer = async () => json({ status: "stalled", error: "This analysis started but stopped reporting, so its outcome isn't confirmed yet. Check status later to see whether a result was saved.",
      attempt: { id: randomUUID(), generation: 1, state: "interrupted", acceptedAt: "2026-11-27T04:00:00.000Z" } }, 409);
    sent = [];
    await startRun(page);
    expect(rt.pushes).toEqual(["/analyze/analysis-1"]);
    expect(analysisCalls()).toHaveLength(1); // review 2: the handover only navigates; nothing is retried
    expect(sent.filter((r) => r.url === "/api/analyze-swing" || r.url === "/api/v1/analyses")).toHaveLength(2);
    rt.pushes = [];
    // review 2: the DESCRIBED attempt decides — the request's own attempt finished, the current one is interrupted
    const { page: p1 } = await analyzeWithClubsFor(A);
    await withVideo(p1);
    rt.analysisAnswer = async () => json({ status: "stalled", error: "This analysis started but stopped reporting, so its outcome isn't confirmed yet. Check status later to see whether a result was saved.",
      attempt: { id: randomUUID(), generation: 1, state: "failed", acceptedAt: "2026-11-27T04:00:00.000Z", failureKind: "not_finished", finishedAt: "2026-11-27T04:01:00.000Z" },
      current: { id: randomUUID(), generation: 2, state: "interrupted", acceptedAt: "2026-11-27T04:02:00.000Z" } }, 409);
    await startRun(p1);
    expect(rt.pushes).toEqual(["/analyze/analysis-1"]);
    rt.pushes = [];
    const { page: p2 } = await analyzeWithClubsFor(A);
    await withVideo(p2);
    rt.analysisAnswer = async () => json({ status: "stalled", error: "This analysis was interrupted after it started and can't be finished. Please record the swing again for a new analysis." }, 409);
    await startRun(p2);
    expect(rt.pushes).toEqual([]);
    expect(banner(p2)).toContain("can't be finished");
  });

  it("A1: a key that is already stored is not signed again (503): finalize proves it and nothing is transferred", async () => {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const healthy = answer;
    answer = async (r, signal) => r.url === "/api/v1/uploads/authorize"
      ? json({ error: { code: "SERVER_TEMPORARILY_UNAVAILABLE", message: "Upload authorization is temporarily unavailable. Please retry." } }, 503)
      : healthy(r, signal);
    sent = [];
    await startRun(page);
    expect(tus()).toEqual([]);
    expect(sent.map((r) => r.url)).toEqual([
      "/api/v1/uploads/authorize", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(page.text()).toContain("Analysis Complete");
  });

  // ── AG-WEB-READY-10-P3: the resume position is one Storage stated explicitly; an unknown one keeps the transfer ──
  const CHUNK = 6291456;
  const P3_SIZE = 13 * 1_048_576; // three chunks: 6 MiB, 6 MiB, 1 MiB
  /** Selects a 13 MiB clip. */
  function withLargeVideo(page: Mounted) {
    const input = findAll(page.nodes(), (n) => n.type === "input" && n.props.type === "file" && n.props.accept === "video/*")[0];
    const video = new File([new Uint8Array(P3_SIZE)], "swing.mp4", { type: "video/mp4" });
    (input.props.onChange as (e: unknown) => void)({ target: { files: [video], value: "" } });
    page.render();
    const element = findAll(page.nodes(), (n) => n.type === "video" && n.ref !== null)[0];
    (element.ref as { current: unknown }).current = {
      readyState: 0, duration: 0, videoWidth: 1280, videoHeight: 720, currentTime: 0,
      addEventListener: () => undefined, removeEventListener: () => undefined, pause: () => undefined,
    };
    page.render();
  }
  /** Each request as the network saw it: the transfer's as "tus <method> [offset]", the app's by path. */
  const p3Label = (r: Sent) => (r.url === TUS_ENDPOINT || r.url.startsWith(`${TUS_ENDPOINT}/`)
    ? `tus ${r.method}${r.method === "PATCH" ? ` ${r.uploadOffset}` : ""}` : r.url);
  const tusTrace = () => tus().map((r) => (r.method === "PATCH" ? `PATCH ${r.uploadOffset}` : r.method));
  const patchesFrom = (url: string) => tus().filter((r) => r.method === "PATCH" && r.url === url).map((r) => r.uploadOffset);
  /** The stand-in Storage's faults: the connection drops (after the first stored chunk, or before any chunk is stored);
   *  `status` answers the transfer's status reads (HEAD) instead of Storage (null: Storage answers); `ack` replaces the
   *  first chunk acknowledgement's Upload-Offset after Storage stored the chunk (null value: header omitted). */
  let drop: "after-first" | "all" | "patches-after-first" | "last-ack" | null = null;
  let status: ((r: Sent) => Response | null | Promise<Response | null>) | null = null;
  let beforeHead: (() => void) | null = null;
  let onDrop: (() => void) | null = null;
  let ack: ((offset: number, size: number) => string | null) | null = null;
  let expiresInSeconds: number | null = null;
  let conflicts = 0;
  function installP3Network() {
    drop = null; status = null; ack = null; expiresInSeconds = null; conflicts = 0; beforeHead = null; onDrop = null;
    const healthy = answer;
    let patches = 0;
    answer = async (r, signal) => {
      if (r.method === "HEAD" && beforeHead !== null) beforeHead();
      if (drop === "patches-after-first" && r.method === "PATCH" && ++patches > 1) throw new TypeError("Failed to fetch");
      if (drop === "last-ack" && r.method === "PATCH" && Number(r.uploadOffset) + (r.bodySize ?? 0) === P3_SIZE) {
        await healthy(r, signal); // the last chunk is stored …
        throw new TypeError("Failed to fetch"); // … and its acknowledgement lost
      }
      if ((drop === "after-first" || drop === "all") && r.method === "PATCH" && (drop === "all" || ++patches > 1)) {
        if (onDrop !== null) onDrop();
        throw new TypeError("Failed to fetch");
      }
      if ((drop === "after-first" || drop === "all" || drop === "last-ack") && r.method === "HEAD") throw new TypeError("Failed to fetch");
      if (status !== null && r.method === "HEAD") {
        const answered = await status(r);
        if (answered !== null) return answered;
      }
      // V1 finalize finds the object only once the selection's latest transfer is complete
      if (r.url === "/api/v1/uploads/finalize") {
        const latest = Array.from(transfers.values()).pop();
        if (!latest || latest.offset < latest.length) {
          return json({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY", message: "The upload could not be found or is not ready." } }, 409);
        }
      }
      const res = await healthy(r, signal);
      if (r.url === "/api/v1/uploads/authorize" && expiresInSeconds !== null) {
        const body = (await res.json()) as { data: Record<string, unknown> };
        return json({ data: { ...body.data, expiresInSeconds } });
      }
      if (r.method === "PATCH" && res.status === 409) conflicts += 1;
      if (r.method === "PATCH" && res.status === 204 && ack !== null) {
        const value = ack(Number(r.uploadOffset), r.bodySize ?? 0);
        ack = null; // the first acknowledgement only
        return new Response(null, { status: 204, headers: value === null ? {} : { "Upload-Offset": value } });
      }
      return res;
    };
  }
  const statusAnswer = (offset: string | null) => () =>
    new Response(null, { status: 200, headers: offset === null ? { "Upload-Length": String(P3_SIZE) } : { "Upload-Offset": offset, "Upload-Length": String(P3_SIZE) } });
  /** The first press: the first 6 MiB are stored and acknowledged, then the connection drops (the second chunk and the
   *  status read never reach Storage). Returns the transfer's address and the selection's upload id. */
  async function firstPressStoresSixMiB(page: Mounted) {
    installP3Network();
    drop = "after-first";
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD"]);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(runButton(page)).not.toBeNull(); // the retry control: the selection is kept
    drop = null;
    return {
      uploadUrl: tus().find((r) => r.method === "PATCH")!.url,
      uploadId: (JSON.parse(authorizations()[0].body!) as { uploadId: string }).uploadId,
    };
  }
  const RESUMED = [
    "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 6291456", "tus PATCH 12582912",
    "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
  ];

  it("P3: a status read that answers 200 with the offset omitted, then empty, keeps the transfer and sends nothing more; once Storage confirms 6 MiB the retry continues there on the same transfer and upload id", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl, uploadId } = await firstPressStoresSixMiB(page);
    for (const offset of [null, ""]) {
      status = statusAnswer(offset);
      sent = [];
      await startRun(page);
      // finalize first (nothing stored yet), then ONE status read: no chunk, no authorization, no creation
      expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
      expect(tus().every((r) => r.url === uploadUrl && r.redirect === "error")).toBe(true);
      expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
      expect(runButton(page)).not.toBeNull();
      expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    }
    status = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(tus().filter((r) => r.method === "PATCH").map((r) => r.bodySize)).toEqual([CHUNK, P3_SIZE - 2 * CHUNK]);
    expect(finalizeIds()).toEqual([uploadId, uploadId]);
    expect(authorizations()).toHaveLength(0);
    expect(uploadsSent()).toHaveLength(0);
    expect(Array.from(transfers.values())).toEqual([{ offset: P3_SIZE, length: P3_SIZE }]); // one transfer, every byte once
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([
    ["a decimal point", "6291456.0"],
    ["an exponent", "6.291456e6"],
    ["a hexadecimal prefix", "0x600000"],
    ["a plus sign", "+6291456"],
    ["a minus sign", "-1"],
    ["two values", "6291456, 6291456"],
    ["inner spaces", "6 291 456"],
    ["a value past the clip's length", String(13 * 1_048_576 + 1)],
    ["a value past the safe integer range", "99999999999999999999"],
  ])("P3: a status read whose Upload-Offset has %s is not a position: the transfer is kept and nothing more is sent", async (_label, value) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = statusAnswer(value);
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
  });

  it.each([
    ["answers 503", 503],
    ["answers 500", 500],
    ["answers 429", 429],
    ["answers a generic 400 (P3-A1: no reliable terminal signal)", 400],
    ["answers a generic 401 (P3-A1)", 401],
    ["answers a generic 403 (P3-A1)", 403],
  ])("P3: a status read that %s on a usable transfer keeps it: no new authorization or creation, recoverable copy; once Storage answers, the retry continues from its confirmed offset", async (_label, code) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = () => new Response(null, { status: code });
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(authorizations()).toHaveLength(0);
    expect(uploadsSent()).toHaveLength(0);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(runButton(page)).not.toBeNull(); // P3-A1 (QA): the retry control and the transfer survive the press
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    // the connection then fails outright on the next retry: still kept, still nothing more
    status = () => { throw new TypeError("Failed to fetch"); };
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    // once Storage answers, the next retry continues from its confirmed 6 MiB on the same transfer
    status = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3: an explicit zero that Storage's own state contradicts is reconciled: the conflicting chunk is followed by a status read, never by a new authorization or creation", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    let once = true;
    status = () => (once ? ((once = false), statusAnswer("0")()) : null); // the first read says 0; Storage holds 6 MiB
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 0", "tus HEAD", "tus PATCH 6291456", "tus PATCH 12582912",
      "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(conflicts).toBe(1); // Storage refused the chunk from 0 (409); nothing it holds was overwritten
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(authorizations()).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([400, 401, 403])("P3-A1 (review): mid-resume, a chunk fails and the reconciliation status read answers a generic %s: the transfer is kept, no authorization, recoverable copy; the next press resumes it", async (code) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    drop = "patches-after-first"; // the resumed chunk is lost; status reads reach Storage
    let reads = 0;
    status = () => (++reads === 1 ? null : new Response(null, { status: code })); // 6 MiB confirmed, then the generic answer
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 6291456", "tus HEAD"]);
    expect(authorizations()).toHaveLength(0);
    expect(uploadsSent()).toHaveLength(0);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(runButton(page)).not.toBeNull();
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    drop = null;
    status = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([400, 401, 403])("P3-A1 (review): in the first pass, a chunk fails and the status read answers a generic %s: unconfirmed (not failed), the transfer is kept; the next press resumes it", async (code) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "patches-after-first"; // the first 6 MiB are stored; the next chunk is lost
    status = () => new Response(null, { status: code });
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD"]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(banner(page)).not.toContain(ANALYZE.uploadFailed);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    const uploadUrl = tus()[1].url;
    drop = null;
    status = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(authorizations()).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3-A1 (review): a refusal that persists keeps the transfer while its signature is live; once the signature's known lifetime has passed, the existing replacement applies (one authorization, one creation from byte 0)", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    expiresInSeconds = 61; // usable for 1 s once the page's one-minute margin is taken
    drop = "after-first";
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD"]);
    const first = tus()[1].url;
    drop = null;
    status = (r) => (r.url === first ? new Response(null, { status: 403 }) : null);
    sent = [];
    await startRun(page); // still live: kept
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2_000); // the 1 s lifetime has passed
    try {
      sent = [];
      await startRun(page);
      expect(sent.map(p3Label)).toEqual([
        "/api/v1/uploads/finalize", "/api/v1/uploads/authorize", "tus POST", "tus PATCH 0", "tus PATCH 6291456",
        "tus PATCH 12582912", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
      ]);
      expect(tus().some((r) => r.url === first)).toBe(false);
      expect(page.text()).toContain("Analysis Complete");
    } finally {
      clock.mockRestore();
    }
  });

  it("P3-A1: a status answer of 204 with a valid offset is read like a 200: the retry continues from it on the same transfer", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = () => new Response(null, { status: 204, headers: { "Upload-Offset": String(CHUNK), "Upload-Length": String(P3_SIZE) } });
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(authorizations()).toHaveLength(0);
    expect(Array.from(transfers.values())).toEqual([{ offset: P3_SIZE, length: P3_SIZE }]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([
    ["no Upload-Offset", null],
    ["an empty Upload-Offset", ""],
    ["a decimal point", "6291456.0"],
    ["a minus sign", "-1"],
    ["a hexadecimal prefix", "0x600000"],
    ["a value past the clip's length", String(13 * 1_048_576 + 1)],
  ])("P3-A1: a status answer of 204 with %s is not a position: the transfer is kept and nothing more is sent", async (_label, value) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = () => new Response(null, { status: 204, headers: value === null ? { "Upload-Length": String(P3_SIZE) } : { "Upload-Offset": value, "Upload-Length": String(P3_SIZE) } });
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(authorizations()).toHaveLength(0);
    expect(uploadsSent()).toHaveLength(0);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
  });

  it("P3-A1: a status answer of 204 with an explicit zero is a position: when Storage holds nothing yet, the retry sends the clip from byte 0 on the same transfer", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "all";
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "HEAD"]);
    const uploadUrl = tus()[1].url;
    drop = null;
    status = () => new Response(null, { status: 204, headers: { "Upload-Offset": "0", "Upload-Length": String(P3_SIZE) } });
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 0", "tus PATCH 6291456", "tus PATCH 12582912",
      "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(patchesFrom(uploadUrl)).toEqual(["0", "6291456", "12582912"]);
    expect(authorizations()).toHaveLength(0);
    expect(conflicts).toBe(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3: an explicit zero is a position: when Storage confirms it holds nothing yet, the retry sends the clip from byte 0 on the same transfer", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "all"; // even the first chunk is lost before Storage stored it, and so is the status read
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "HEAD"]);
    expect(Array.from(transfers.values())).toEqual([{ offset: 0, length: P3_SIZE }]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    const uploadUrl = tus()[1].url;
    drop = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "tus PATCH 0", "tus PATCH 6291456", "tus PATCH 12582912",
      "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(patchesFrom(uploadUrl)).toEqual(["0", "6291456", "12582912"]);
    expect(authorizations()).toHaveLength(0);
    expect(conflicts).toBe(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([
    [404, "gone"], [410, "gone"],
  ])("P3: a transfer Storage confirmed gone (%s: %s) is replaced through the existing flow: one new authorization and creation, the clip from byte 0, the same upload id", async (code) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl, uploadId } = await firstPressStoresSixMiB(page);
    status = (r) => (r.url === uploadUrl ? new Response(null, { status: code }) : null);
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "tus HEAD", "/api/v1/uploads/authorize", "tus POST", "tus PATCH 0", "tus PATCH 6291456",
      "tus PATCH 12582912", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    const replacement = tus().find((r) => r.method === "PATCH")!.url;
    expect(replacement).not.toBe(uploadUrl);
    expect(patchesFrom(replacement)).toEqual(["0", "6291456", "12582912"]);
    expect((JSON.parse(authorizations()[0].body!) as { uploadId: string }).uploadId).toBe(uploadId);
    expect(finalizeIds()).toEqual([uploadId, uploadId]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3: once the signature's lifetime has passed, the existing replacement flow applies without a status read of the old transfer", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    expiresInSeconds = 60; // usable for 0 s once the page's one-minute margin is taken
    drop = "after-first";
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD"]);
    const first = tus()[1].url;
    drop = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "/api/v1/uploads/authorize", "tus POST", "tus PATCH 0", "tus PATCH 6291456",
      "tus PATCH 12582912", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(tus().some((r) => r.url === first)).toBe(false);
    expect(page.text()).toContain("Analysis Complete");
  });

  it.each([
    ["names a position past the chunk's end", (o: number, n: number): string | null => String(o + n + 1)],
    ["names a position inside the chunk", (o: number, n: number): string | null => String(o + n - 1)],
    ["names the chunk's start (no progress)", (o: number): string | null => String(o)],
    ["has an empty offset", (): string | null => ""],
    ["has no offset", (): string | null => null],
  ])("P3: a chunk acknowledgement that %s does not confirm the chunk: a status read decides where the next chunk starts", async (_label, ackOf) => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    ack = ackOf;
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "HEAD", "PATCH 6291456", "PATCH 12582912"]);
    expect(conflicts).toBe(0); // no chunk was sent from a position Storage did not confirm
    expect(Array.from(transfers.values())).toEqual([{ offset: P3_SIZE, length: P3_SIZE }]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3: a contradicting acknowledgement whose status read confirms no position stops the pass: the transfer is kept and nothing more is sent", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    ack = (o, n) => String(o + n + 1);
    status = statusAnswer(null);
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "HEAD"]);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    expect(videoInserts()).toHaveLength(0);
    expect(runButton(page)).not.toBeNull();
  });

  it("P3 (review): the retries of one pass are bounded: a chunk that keeps failing at a confirmed position is tried 4 times with 3 status reads, then the pass stops with the transfer kept; the next press resumes it", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "patches-after-first"; // every chunk after the first is lost; Storage's status reads answer (6 MiB)
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD", "PATCH 6291456", "HEAD", "PATCH 6291456", "HEAD", "PATCH 6291456"]);
    expect(banner(page)).toContain(ANALYZE.uploadFailed); // the position is known: the existing copy
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    const uploadUrl = tus()[1].url;
    drop = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(RESUMED);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(authorizations()).toHaveLength(0);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3 (review): the last chunk is stored but its acknowledgement and the status read are lost: the next press asks finalize first, which proves the object, and sends nothing to Storage", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "last-ack";
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "PATCH 12582912", "HEAD"]);
    expect(Array.from(transfers.values())).toEqual([{ offset: P3_SIZE, length: P3_SIZE }]); // all stored
    expect(banner(page)).toContain(ANALYZE.uploadUnconfirmed);
    drop = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing"]);
    expect(tus()).toEqual([]);
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3 (review): an account change noticed at the resume's status read stops it: no chunk is sent, the account-changed copy shows", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = () => {
      shared.emit("SIGNED_IN", sessionOf(B)); // B's session appears while A's status read is answered (6 MiB)
      return null;
    };
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(tus().every((r) => r.url === uploadUrl)).toBe(true);
    expect(banner(page)).toContain(ANALYZE.changed);
    // the page is now B's: a further press sends nothing at all (A's transfer is never touched again)
    status = null;
    sent = [];
    await startRun(page);
    expect(sent).toEqual([]);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
  });

  it("P3 (review 2): an account change noticed in a failed chunk's answer stops the pass before the reconciliation status read", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "after-first";
    onDrop = () => shared.emit("SIGNED_IN", sessionOf(B)); // B's session appears while A's second chunk fails
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456"]); // no status read of A's transfer after the change
    expect(banner(page)).toContain(ANALYZE.changed);
  });

  it("P3 (review 2): leaving the page while the replacement's owner check is pending sends no authorization", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    await firstPressStoresSixMiB(page);
    status = () => {
      shared.auto.held = 1; // the next session read — the replacement authorize's owner check — is held
      return new Response(null, { status: 404 }); // Storage confirms the transfer gone: replacement
    };
    sent = [];
    press(runButton(page));
    await settle(page, 40);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    page.unmount();
    rt.dirty = false;
    shared.sessionReads.at(-1)!.resolve({ data: { session }, error: null });
    await settle(page, 80);
    expect(authorizations()).toHaveLength(0);
    expect(uploadsSent()).toHaveLength(0);
  });

  it("P3 (review): when the page's account can no longer be confirmed, that refusal outranks the unconfirmed-upload copy", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    installP3Network();
    drop = "after-first";
    beforeHead = () => browserHolds(refusedRead()); // the session read after the lost status read is refused
    sent = [];
    await startRun(page);
    expect(tusTrace()).toEqual(["POST", "PATCH 0", "PATCH 6291456", "HEAD"]);
    expect(banner(page)).toContain(ANALYZE.unconfirmed);
    expect(banner(page)).not.toContain(ANALYZE.uploadUnconfirmed);
  });

  it("P3 (review): a transfer confirmed gone whose replacement finds the account unconfirmed sends no authorization; once confirmed, the next press authorizes a new transfer without touching the old one", async () => {
    const { page, session } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    const { uploadUrl } = await firstPressStoresSixMiB(page);
    status = (r) => {
      if (r.url !== uploadUrl) return null;
      browserHolds(refusedRead()); // the owner check before authorize is refused
      return new Response(null, { status: 404 });
    };
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(banner(page)).toContain(ANALYZE.unconfirmed);
    browserHolds(session);
    status = null;
    sent = [];
    await startRun(page);
    expect(sent.map(p3Label)).toEqual([
      "/api/v1/uploads/finalize", "/api/v1/uploads/authorize", "tus POST", "tus PATCH 0", "tus PATCH 6291456",
      "tus PATCH 12582912", "/api/v1/uploads/finalize", "/api/v1/analyses", "/api/analyze-swing",
    ]);
    expect(tus().some((r) => r.url === uploadUrl)).toBe(false); // the gone transfer was dropped
    expect(page.text()).toContain("Analysis Complete");
  });

  it("P3 (review): leaving the page while the resume's status read is pending sends nothing more", async () => {
    const { page } = await analyzeWithClubsFor(A);
    withLargeVideo(page);
    await firstPressStoresSixMiB(page);
    const gate = deferred<Response | null>();
    status = () => gate.promise;
    sent = [];
    press(runButton(page));
    await settle(page, 40);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    page.unmount();
    rt.dirty = false;
    gate.resolve(statusAnswer(String(CHUNK))()); // Storage answers after the golfer left: 6 MiB
    await settle(page, 80);
    expect(sent.map(p3Label)).toEqual(["/api/v1/uploads/finalize", "tus HEAD"]);
    expect(Array.from(transfers.values())).toEqual([{ offset: CHUNK, length: P3_SIZE }]);
    expect(rt.pushes).toEqual([]);
  });

});

// ─── A3 (F2): the analysis call's error body is acted on only while the page and its sign-in are still current ─────

describe("Analyze — a held error body: nothing navigates or changes after the page left or its sign-in changed", () => {
  /** A Response whose headers have arrived (status) while its body is still held until `release`. */
  function heldBody(status: number) {
    let release!: (body: unknown) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = (body) => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        };
      },
    });
    return { response: new Response(stream, { status, headers: { "content-type": "application/json" } }), release };
  }
  async function runUntilHeld(status: number) {
    const { page } = await analyzeWithClubsFor(A);
    await withVideo(page);
    const held = heldBody(status);
    rt.analysisAnswer = async () => held.response;
    sent = [];
    press(runButton(page));
    await settle(page, 80);
    expect(analysisCalls()).toHaveLength(1);
    return { page, release: held.release };
  }

  it("control: a 409 'processing' body hands over to that analysis's report page", async () => {
    const { page, release } = await runUntilHeld(409);
    release({ status: "processing", error: "Already running" });
    await settle(page, 80);
    expect(rt.pushes).toEqual(["/analyze/analysis-1"]);
  });

  it("a 409 'processing' body that finishes after B signed in navigates nowhere and says the sign-in changed", async () => {
    const { page, release } = await runUntilHeld(409);
    shared.emit("SIGNED_IN", sessionOf(B)); // headers arrived for A; the body is still held
    await settle(page);
    release({ status: "processing", error: "Already running" });
    await settle(page, 80);
    expect(rt.pushes).toEqual([]);
    expect(banner(page)).toContain(ANALYZE.afterChange);
  });

  it("a 409 'processing' body that finishes after the golfer left navigates nowhere and changes nothing", async () => {
    const { page, release } = await runUntilHeld(409);
    page.unmount();
    rt.dirty = false;
    release({ status: "processing", error: "Already running" });
    await settle(page, 80);
    expect(rt.pushes).toEqual([]);
  });

  it("control: an unusable-video body clears the selection and shows the server's explanation", async () => {
    const { page, release } = await runUntilHeld(422);
    expect(hasVideo(page)).toBe(true);
    release({ status: VIDEO_UNUSABLE_STATUS, error: "We couldn't read this video. Choose or record it again." });
    await settle(page, 80);
    expect(hasVideo(page)).toBe(false);
    expect(banner(page)).toContain("We couldn't read this video.");
  });

  it("an unusable-video body that finishes after B signed in clears nothing (the golfer's video stays) and says the sign-in changed", async () => {
    const { page, release } = await runUntilHeld(422);
    shared.emit("SIGNED_IN", sessionOf(B));
    await settle(page);
    release({ status: VIDEO_UNUSABLE_STATUS, error: "We couldn't read this video. Choose or record it again." });
    await settle(page, 80);
    expect(hasVideo(page)).toBe(true);
    expect(banner(page)).toContain(ANALYZE.afterChange);
    expect(banner(page)).not.toContain("We couldn't read this video.");
  });

  it("an unusable-video body that finishes after the golfer left changes nothing (the selection is not cleared)", async () => {
    const { page, release } = await runUntilHeld(422);
    page.unmount();
    release({ status: VIDEO_UNUSABLE_STATUS, error: "We couldn't read this video." });
    await settle(page, 80);
    page.render(); // the state as it was left: the mount effect does not run again, so the page stays unmounted
    expect(hasVideo(page)).toBe(true);
    expect(banner(page)).not.toContain("We couldn't read this video.");
    expect(rt.pushes).toEqual([]);
  });
});

// ─── Add Club ────────────────────────────────────────────────────────────────────────────────────────────────────────

const UNAVAILABLE_CATALOG: CatalogState = { status: "unavailable" }; // Custom / Other is the mode, as it is today

function addClubFor(golfer: Golfer) {
  const page = mount(AddClubForm as (p: { userId: string; catalog: CatalogState }) => unknown, { userId: golfer.id, catalog: UNAVAILABLE_CATALOG });
  const field = (placeholder: string) => findAll(page.nodes(), (n) => n.type === "input" && n.props.placeholder === placeholder)[0];
  (field("e.g. KBS").props.onChange as (e: unknown) => void)({ target: { value: "Synthetic Brand" } });
  page.render();
  (field("e.g. Tour 90").props.onChange as (e: unknown) => void)({ target: { value: "Synthetic Model" } });
  page.render();
  return {
    page,
    submit: () => {
      const form = findAll(page.nodes(), (n) => n.type === "form")[0];
      void (form.props.onSubmit as (e: unknown) => unknown)({ preventDefault: () => undefined });
    },
    entered: () => [field("e.g. KBS").props.value, field("e.g. Tour 90").props.value],
    alert: () => findAll(page.nodes(), (n) => n.props.role === "alert").map((n) => textOf(n.children)).join(" "),
    busy: () => findAll(page.nodes(), (n) => n.type === "button" && n.props.type === "submit")[0].props.disabled === true,
  };
}
const adds = () => sent.filter((r) => r.url.includes("/rest/v1/user_equipment") && r.method === "POST");

describe("Add Club — no add without a confirmed session for this form's golfer; fixed copy; details kept", () => {
  it.each([
    ["refused (unconfirmed)", (d: Deferred<SessionAnswer>) => d.reject(refusedRead()), ADD.unconfirmed, "/login"],
    ["failed", (d: Deferred<SessionAnswer>) => d.reject(new TypeError("Failed to fetch synthetic-internal")), ADD.unavailable, null],
    ["answered with an error", (d: Deferred<SessionAnswer>) => d.resolve({ data: { session: null }, error: { message: "synthetic-internal" } }), ADD.unavailable, null],
    ["signed out", (d: Deferred<SessionAnswer>) => d.resolve({ data: { session: null }, error: null }), ADD.signedOut, "/login"],
    ["another account", (d: Deferred<SessionAnswer>) => d.resolve({ data: { session: sessionOf(B) }, error: null }), ADD.changed, null],
  ])("a %s session read adds nothing, settles, keeps the details and shows fixed copy", async (_label, outcome, copy, link) => {
    const form = addClubFor(A);
    form.submit();
    form.page.render();
    expect(form.busy()).toBe(true);
    outcome(read(0));
    await settle(form.page);
    expect(form.busy()).toBe(false);
    expect(form.alert()).toContain(copy);
    expect(form.alert()).not.toMatch(RAW);
    expect(form.entered()).toEqual(["Synthetic Brand", "Synthetic Model"]);
    expect(sent).toHaveLength(0);
    expect(rt.pushes).toHaveLength(0);
    if (link !== null) expect(form.page.markup()).toContain(`href="${link}"`);
  });

  it("no answer in time is unavailable (bounded), and nothing is added", async () => {
    const form = addClubFor(A);
    form.submit();
    await vi.advanceTimersByTimeAsync(DRILL_HUB_SESSION_DEADLINE_MS);
    await settle(form.page);
    expect(form.alert()).toContain(ADD.unavailable);
    expect(form.busy()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("a confirmed session adds once, carrying exactly that session's access token (never anonymous), then goes to the bag", async () => {
    const form = addClubFor(A);
    const s = sessionOf(A);
    form.submit();
    read(0).resolve({ data: { session: s }, error: null });
    await settle(form.page);
    expect(adds()).toHaveLength(1);
    expect(adds()[0].authorization).toBe(`Bearer ${s.access_token}`);
    expect(JSON.parse(adds()[0].body!)).toMatchObject({ user_id: A.id, custom_club: true, custom_brand: "Synthetic Brand", custom_model: "Synthetic Model" });
    expect(sent.every((r) => r.url.startsWith("http://127.0.0.1:54329/"))).toBe(true);
    expect(rt.pushes).toEqual(["/bag"]);
  });

  it("a second press while an add runs adds nothing more", async () => {
    const form = addClubFor(A);
    form.submit();
    form.submit(); // before React re-renders the disabled button
    expect(shared.client.auth.getSession).toHaveBeenCalledTimes(1);
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    form.submit(); // succeeded and navigating: still nothing more
    await settle(form.page);
    expect(adds()).toHaveLength(1);
  });

  it("a failed add shows fixed copy, keeps the details, and a deliberate retry adds once", async () => {
    const form = addClubFor(A);
    answer = async () =>
      new Response(JSON.stringify({ code: "XX000", message: "synthetic-internal PGRST failure", details: null, hint: null }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    expect(form.alert()).toContain(ADD.failed);
    expect(form.alert()).not.toMatch(RAW);
    expect(form.entered()).toEqual(["Synthetic Brand", "Synthetic Model"]);
    answer = async () => new Response(null, { status: 201 });
    form.submit();
    read(1).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    expect(adds()).toHaveLength(2);
    expect(rt.pushes).toEqual(["/bag"]);
  });

  it("a refused add (policy / sign-in not accepted) shows fixed copy without the database text", async () => {
    const form = addClubFor(A);
    answer = async () =>
      new Response(JSON.stringify({ code: "42501", message: 'new row violates row-level security policy for table "user_equipment"', details: null, hint: null }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    expect(form.alert()).toContain(ADD.refused);
    expect(form.page.markup()).not.toMatch(RAW);
  });

  it("an add with no answer in time is reported as unknown (check the bag), never as failed", async () => {
    const form = addClubFor(A);
    answer = (_r, signal) =>
      new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle(form.page);
    expect(form.alert()).toContain(ADD.unknown);
    expect(form.page.markup()).toContain('href="/bag"');
    expect(form.busy()).toBe(false);
  });

  it("an add whose request got no answer at all (status 0: it may have been stored) is unknown, never failed", async () => {
    const form = addClubFor(A);
    answer = async () => { throw new TypeError("Failed to fetch synthetic-internal"); };
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    expect(form.alert()).toContain(ADD.unknown);
    expect(form.alert()).not.toMatch(RAW);
    expect(form.page.markup()).toContain('href="/bag"');
  });

  it("a session whose End Session the server already confirmed adds nothing (sign in again)", async () => {
    const form = addClubFor(A);
    const s = sessionOf(A);
    vi.stubGlobal("document", { cookie: `swingproai-session-ended=${await sessionLineageId(s.access_token)}` });
    form.submit();
    read(0).resolve({ data: { session: s }, error: null });
    await settle(form.page);
    expect(form.alert()).toContain(ADD.signedOut);
    expect(sent).toHaveLength(0);
  });

  it("A's session read finishing after B became current adds nothing", async () => {
    const form = addClubFor(A);
    form.submit();
    shared.emit("SIGNED_IN", sessionOf(B));
    read(0).resolve({ data: { session: sessionOf(A) }, error: null }); // A's stale answer
    await settle(form.page);
    expect(form.alert()).toContain(ADD.changed);
    expect(sent).toHaveLength(0);
  });

  it("an add finishing after B became current does not present itself as B's result (no navigation into the bag)", async () => {
    const form = addClubFor(A);
    const gate = deferred<Response>();
    answer = () => gate.promise;
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    expect(adds()).toHaveLength(1);
    shared.emit("SIGNED_IN", sessionOf(B));
    gate.resolve(new Response(null, { status: 201 }));
    await settle(form.page);
    expect(form.alert()).toContain(ADD.addedThenChanged);
    expect(rt.pushes).toHaveLength(0);
  });

  it("leaving the page while an add runs: its completion shows nothing and navigates nowhere", async () => {
    const form = addClubFor(A);
    const gate = deferred<Response>();
    answer = () => gate.promise;
    form.submit();
    read(0).resolve({ data: { session: sessionOf(A) }, error: null });
    await settle(form.page);
    form.page.unmount();
    rt.dirty = false;
    gate.resolve(new Response(null, { status: 201 }));
    await settle(form.page);
    expect(rt.pushes).toHaveLength(0);
    expect(rt.dirty).toBe(false);
  });

  it("the form's validation and catalog copy are unchanged, and a refused read is announced as an alert", async () => {
    const form = addClubFor(A);
    form.submit();
    read(0).reject(refusedRead());
    await settle(form.page);
    expect(form.page.markup()).toMatch(/<div role="alert"[^>]*><p>We couldn&#x27;t confirm which account is signed in/);
    // with no canonical catalog the form is in Custom / Other mode, as before; leaving it shows the catalog notice
    const custom = findAll(form.page.nodes(), (n) => n.type === "input" && n.props.id === "custom_club")[0];
    expect(custom.props.checked).toBe(true);
    (custom.props.onChange as (e: unknown) => void)({ target: { checked: false } });
    form.page.render();
    expect(form.page.text()).toContain("Canonical equipment selection is temporarily unavailable.");
    form.submit();
    form.page.render();
    expect(form.alert()).toContain("Choose a manufacturer and model, or switch to Custom / Other.");
    expect(shared.client.auth.getSession).toHaveBeenCalledTimes(1); // validation sends nothing and reads nothing
  });
});

// ─── Source guards (supporting the behaviour above) ──────────────────────────────────────────────────────────────────

describe("source guards", () => {
  it("Add Club never renders an error's own text, and adds only through the session-bound client", () => {
    const form = source("app/(dashboard)/bag/add/AddClubForm.tsx");
    expect(form).not.toMatch(/setError\(\s*err\./);
    expect(form).not.toContain("err.message");
    expect(form).not.toMatch(/createClient\(\)\s*\.from\(/);
    expect(form).toContain('bound.from("user_equipment").insert(payload)');
    expect(form).toContain("acquireDrillHubSession(createClient)");
  });

  it("Analyze never shows an arbitrary error's message, and never reads the auth cookie or builds a credential itself", () => {
    const page = source("app/(dashboard)/analyze/page.tsx");
    expect(page).not.toContain("setError(err instanceof Error ? err.message");
    expect(page).toContain("setError(golferMessage(err, analysisStarted));");
    expect(page).toContain("sessionAnswer = await settleWithin(async () => await supabase.auth.getSession(), SESSION_READ_DEADLINE_MS);");
    for (const banned of ["document.cookie", "access_token", "Authorization", "accessToken"]) expect(page).not.toContain(banned);
    expect(page).not.toMatch(/Bearer \$\{/); // A3: the Bearer headers come from the confirmed session (ownerBearer)
    // A4 (C1) + P2 + A1: four Bearer requests — V1 authorize, V1 finalize, the doorway and the analysis call — each sent
    // with no cookie; and the signed transfer's three request kinds (creation, chunk, offset read), which carry no
    // account credential at all, likewise with no cookie
    expect(page.match(/\.\.\.ownerBearer\(/g)).toHaveLength(4);
    expect(page.match(/credentials: "omit",/g)).toHaveLength(7);
  });

  it("A3: Analyze takes its account from the rendered layout once and never adopts the browser's first session", () => {
    const page = source("app/(dashboard)/analyze/page.tsx");
    expect(page).toContain("const rendered = useRenderedSession();");
    expect(page).toContain("const ownerRef = useRef<string | null>(rendered?.ownerId ?? null);");
    expect(page).not.toContain("clubsUserRef");
    expect(page).not.toMatch(/ownerRef\.current\s*(\?\?=|=)\s/); // never reassigned (no adoption)
    expect(page).toContain("supabaseRef.current = analyzeClientFor(ownerRef.current);");
    // A4 (C1): the analysis call confirms the owner itself and sends its Bearer (no cookie sender any more)
    expect(page).toContain("const analysisSession = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);");
    expect(page).toContain('const analysisRes = await fetch("/api/analyze-swing", {');
    expect(page).not.toMatch(/cookieSessionRequests|cookieSessionPreflight/);
  });
});
