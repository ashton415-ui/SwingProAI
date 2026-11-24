import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { randomUUID, createHash } from "node:crypto";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-04 F1-V — the dashboard's whole account-bearing shell is removed once this browser's sign-in is CONFIRMED
 * to no longer be the one the layout was rendered for (components/navigation/RenderedSessionBoundary.tsx).
 *
 * The real boundary runs through its real effects (React's hooks replaced by the small synchronous runtime used in
 * lib/analyze-swing-auth-ingress.test.ts; context providers are expanded through). confirmOwnerSession,
 * drillHubIdentityEndFromEvent, watchLineageEnd / announceEndedLineage and the lineage digest are the real modules. The
 * shared browser client is a stand-in whose stored session and identity events the test controls; its credential-writing
 * methods are spies that must never be called (the boundary never clears, revokes or replaces the browser's session).
 * `document` / `window` are minimal event targets (visibility, pageshow) with a cookie spy. The shell children carry
 * distinct account, plan, media and End Session markers. Synthetic identities only; nothing leaves the process.
 */

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  pending: [] as number[],
  dirty: false,
  client: null as unknown,
  pathname: "/dashboard",
  // the account the browser's stored session names, as the boundary's local read sees it (undefined: the real read)
  storedSub: undefined as string | null | undefined,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  type Slot = Record<string, unknown>;
  const same = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
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
  return { ...actual, default: actual, useState, useRef, useMemo, useCallback, useEffect };
});
vi.mock("next/navigation", () => ({ usePathname: () => rt.pathname }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => rt.client }));
// Only the stored session's SUBJECT is controlled per test (the jar's cookie encoding is covered by session-storage's own
// tests); every other export, and the real read when no test sets it, is the real module.
vi.mock("@/utils/supabase/session-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/supabase/session-storage")>();
  return {
    ...actual,
    readStoredSession: () => {
      if (rt.storedSub === undefined) return actual.readStoredSession();
      if (rt.storedSub === null) return { kind: "absent" as const };
      const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const accessToken = `${b64u({ alg: "none" })}.${b64u({ sub: rt.storedSub, exp: 4_000_000_000 })}.synthetic`;
      return { kind: "present" as const, value: "synthetic", names: ["sb-127-auth-token"], envelope: { accessToken, refreshToken: "synthetic", expiresAt: 4_000_000_000 } };
    },
  };
});

import RenderedSessionBoundary from "@/components/navigation/RenderedSessionBoundary";
import { announceEndedLineage } from "@/utils/supabase/session-publication";
import { sessionLineageId } from "@/utils/supabase/session-cookie-layout";
import { confirmOwnerSession } from "@/lib/drill-hub-session";

const A = randomUUID();
const B = randomUUID();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, sid = `sid-${randomUUID()}`) => `${b64({ alg: "none" })}.${b64({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-${randomUUID()}`;
function sessionOf(user: string) {
  return { access_token: jwt(user), refresh_token: `rt-${randomUUID()}`, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: user } };
}
type Session = ReturnType<typeof sessionOf>;

// ─── tree expansion (context providers expanded through) and mount ────────────────────────────────────────────────────
interface HostNode { readonly type: string; readonly props: Record<string, unknown>; readonly children: (HostNode | string)[] }
function expand(node: unknown): (HostNode | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement;
  const props = (element.props ?? {}) as Record<string, unknown>;
  if (element.type === React.Fragment) return expand(props.children);
  if (typeof element.type === "function") return expand((element.type as (p: unknown) => unknown)(props));
  if (typeof element.type === "object" && element.type !== null && "_context" in (element.type as object)) return expand(props.children); // Context.Provider
  if (typeof element.type !== "string") return [];
  return [{ type: element.type, props, children: expand(props.children) }];
}
const textOf = (nodes: (HostNode | string)[]): string => nodes.map((n) => (typeof n === "string" ? n : textOf(n.children))).join("");
function findAll(nodes: (HostNode | string)[], match: (n: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (match(n)) out.push(n);
    out.push(...findAll(n.children, match));
  }
  return out;
}
type BoundaryProps = { ownerId: string; lineage: string | null; children: React.ReactNode };
function mount(initial: BoundaryProps) {
  let props = initial;
  rt.slots = [];
  rt.pending = [];
  rt.dirty = false;
  let nodes: (HostNode | string)[] = [];
  let unmounted = false;
  const Component = RenderedSessionBoundary as unknown as (p: unknown) => unknown;
  const render = () => {
    if (unmounted) return;
    for (let guard = 0; guard < 25; guard++) {
      rt.i = 0;
      rt.dirty = false;
      nodes = expand(Component(props));
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
  return {
    render,
    rerender: (next: Partial<BoundaryProps>) => {
      props = { ...props, ...next };
      render();
    },
    heading: () => findAll(nodes, (n) => n.type === "h1")[0] ?? null,
    notice: () => findAll(nodes, (n) => n.props["data-rendered-session-guidance"] === "refused" && n.props.role === "status")[0] ?? null,
    guidance: () => findAll(nodes, (n) => n.props["data-rendered-session-guidance"] === "ended")[0] ?? null,
    alertHasControls: () => {
      const alert = findAll(nodes, (n) => n.props.role === "alert")[0];
      return !!alert && findAll(alert.children, (n) => n.type === "button" || n.type === "a").length > 0;
    },
    unmount: () => {
      unmounted = true;
      for (const slot of rt.slots as { effect?: boolean; cleanup?: unknown }[]) if (slot?.effect && typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    },
    text: () => textOf(nodes),
    alert: () => findAll(nodes, (n) => n.props.role === "alert")[0] ?? null,
    forms: () => findAll(nodes, (n) => n.type === "form").length,
    media: () => findAll(nodes, (n) => n.type === "video").length,
    button: (label: string) => findAll(nodes, (n) => n.type === "button" && textOf(n.children).includes(label))[0] ?? null,
    link: (label: string) => findAll(nodes, (n) => n.type === "a" && textOf(n.children).includes(label))[0] ?? null,
  };
}
type Mounted = ReturnType<typeof mount>;
async function settle(page: Mounted, turns = 60) {
  for (let k = 0; k < turns; k++) await new Promise<void>((resolve) => setImmediate(resolve));
  if (rt.dirty) page.render();
}

// ─── stand-ins ────────────────────────────────────────────────────────────────────────────────────────────────────────
function managed() {
  const subscribers = new Set<(event: string, session: unknown) => void>();
  const state = { answer: (() => ({ data: { session: null as Session | null }, error: null })) as () => unknown, reads: 0 };
  const writes: string[] = [];
  const spy = (name: string) => () => { writes.push(name); return Promise.resolve({ error: null }); };
  const client = {
    auth: {
      getSession: () => {
        state.reads += 1;
        const now = state.answer();
        return now instanceof Error ? Promise.reject(now) : Promise.resolve(now);
      },
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        subscribers.add(callback);
        return { data: { subscription: { unsubscribe: () => subscribers.delete(callback) } } };
      },
      signOut: spy("signOut"),
      setSession: spy("setSession"),
      refreshSession: spy("refreshSession"),
      updateUser: spy("updateUser"),
    },
  };
  return { client, state, writes, emit: (event: string, session: unknown) => subscribers.forEach((cb) => cb(event, session)), subscribers: () => subscribers.size };
}
let browser: ReturnType<typeof managed>;
const holds = (s: Session | null | Error) => {
  browser.state.answer = () => (s instanceof Error ? s : { data: { session: s }, error: null });
};
let cookieWrites: string[] = [];
let reloads = 0;
let doc: EventTarget & { visibilityState: string; cookie: string };
let win: EventTarget & { location: { reload: () => void } };
const listening = new Map<string, number>();
function counted<T extends EventTarget>(target: T, name: string): T {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, cb: EventListenerOrEventListenerObject | null, o?: AddEventListenerOptions | boolean) => {
    listening.set(`${name}:${type}`, (listening.get(`${name}:${type}`) ?? 0) + 1);
    add(type, cb, o);
  };
  target.removeEventListener = (type: string, cb: EventListenerOrEventListenerObject | null, o?: EventListenerOptions | boolean) => {
    listening.set(`${name}:${type}`, (listening.get(`${name}:${type}`) ?? 0) - 1);
    remove(type, cb, o);
  };
  return target;
}
const persistedPageShow = () => Object.assign(new Event("pageshow"), { persisted: true });

function installMicrotaskDigest() {
  const platform = globalThis.crypto;
  const subtle = {
    digest: (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return Promise.resolve(Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer);
    },
  };
  vi.stubGlobal("crypto", Object.create(platform, { subtle: { value: subtle }, randomUUID: { value: () => platform.randomUUID() } }));
}

/** The account-bearing shell as the layout renders it: name, plan, End Session form, media and page data of A. */
const shell = () => (
  <>
    <aside><p>ACCOUNT-NAME-A</p><span>PLAN-EAGLE-A</span><form action="/api/auth/signout" method="POST"><button type="submit">End Session</button></form></aside>
    <nav><a href="/bag">My Bag</a></nav>
    <main><video src="MEDIA-A" /><p>PAGE-DATA-A</p></main>
  </>
);
const A_MARKERS = ["ACCOUNT-NAME-A", "PLAN-EAGLE-A", "PAGE-DATA-A", "End Session"];

async function openFor(owner: string, rendered: Session) {
  const lineage = await sessionLineageId(rendered.access_token);
  const page = mount({ ownerId: owner, lineage, children: shell() });
  await settle(page);
  return { page, lineage };
}
const showsShell = (page: Mounted) => A_MARKERS.every((m) => page.text().includes(m)) && page.forms() === 1 && page.media() === 1 && page.alert() === null;
const removedShell = (page: Mounted) => A_MARKERS.every((m) => !page.text().includes(m)) && page.forms() === 0 && page.media() === 0 && page.alert() !== null
  && page.heading() !== null && page.heading()!.props.tabIndex === -1 && !page.alertHasControls();

describe("F1-V: the rendered account's whole shell ends only on a confirmed end or account change", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installMicrotaskDigest();
    browser = managed();
    rt.client = browser.client;
    rt.pathname = "/dashboard";
    cookieWrites = [];
    reloads = 0;
    listening.clear();
    rt.storedSub = undefined;
    vi.stubGlobal("BroadcastChannel", undefined);
    const d = new EventTarget() as EventTarget & { visibilityState: string; cookie: string };
    let jar = "";
    Object.defineProperty(d, "cookie", { get: () => jar, set: (v: string) => { cookieWrites.push(v); jar = v; } });
    d.visibilityState = "visible";
    doc = counted(d, "document");
    const w = new EventTarget() as EventTarget & { location: { reload: () => void } };
    w.location = { reload: () => { reloads += 1; } };
    win = counted(w, "window");
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("valid session of the rendered owner: the shell stays (hydration confirms; nothing written)", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    expect(showsShell(page)).toBe(true);
    expect(browser.writes).toEqual([]);
    expect(cookieWrites).toEqual([]);
  });

  it("hydrated while the browser already holds B: the whole shell is replaced by fixed guidance (no A name, plan, media, data or End Session); B's session untouched", async () => {
    const a = sessionOf(A);
    holds(sessionOf(B));
    const { page } = await openFor(A, a);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).toContain("Signed in to a different account");
    expect(page.button("Reload page")).not.toBeNull();
    expect(page.link("Sign in")).toBeNull();
    expect(browser.writes).toEqual([]);
    expect(cookieWrites).toEqual([]);
    (page.button("Reload page")!.props.onClick as () => void)();
    expect(reloads).toBe(1);
  });

  it("End Session of the rendered lineage (here or another tab's notice): the shell ends with 'sign-in has ended' and a Sign in link", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page, lineage } = await openFor(A, a);
    expect(showsShell(page)).toBe(true);
    announceEndedLineage(lineage!);
    page.render();
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).toContain("This page's sign-in has ended");
    expect(page.link("Sign in")!.props.href).toBe("/login");
  });

  it("B signs in elsewhere (event + B stored): confirmed account change ends A's shell; nothing of B is shown and B's session is not touched", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    const b = sessionOf(B);
    holds(b);
    browser.emit("SIGNED_IN", b);
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).not.toContain(B);
    expect(browser.writes).toEqual([]);
    expect(cookieWrites).toEqual([]);
  });

  it("a sign-out (event + nothing stored): confirmed signed_out", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    holds(null);
    browser.emit("SIGNED_OUT", null);
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).toContain("This page's sign-in has ended");
  });

  it("a signal that is not confirmed never ends the view: SIGNED_OUT while A is still stored, an unavailable read, a refused (unverified) read", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    browser.emit("SIGNED_OUT", null); // e.g. a delayed notice; A is still this browser's session
    await settle(page);
    expect(showsShell(page)).toBe(true);
    holds(new TypeError("Failed to fetch synthetic")); // Auth outage / 5xx during the read
    browser.emit("SIGNED_IN", sessionOf(B));
    await settle(page);
    expect(showsShell(page)).toBe(true);
    browser.state.answer = () => ({ data: { session: null }, error: { name: "AuthRetryableFetchError", message: "unverified" } });
    browser.emit("SIGNED_IN", sessionOf(B));
    await settle(page);
    expect(showsShell(page)).toBe(true);
    // a read that never answers: the acquisition's own deadline makes it "unavailable", still no end
    browser.state.answer = () => new Promise(() => undefined);
    browser.emit("SIGNED_IN", sessionOf(B));
    await vi.advanceTimersByTimeAsync(15_000);
    await settle(page);
    expect(showsShell(page)).toBe(true);
    expect(browser.writes).toEqual([]);
  });

  it("same-owner refresh and a newer sign-in of the SAME account keep the view; nothing is revoked or replaced", async () => {
    const a1 = sessionOf(A);
    holds(a1);
    const { page } = await openFor(A, a1);
    browser.emit("TOKEN_REFRESHED", a1);
    await settle(page);
    const a2 = sessionOf(A); // another lineage of A
    holds(a2);
    browser.emit("SIGNED_IN", a2);
    await settle(page);
    expect(showsShell(page)).toBe(true);
    expect(browser.writes).toEqual([]);
  });

  it("foreground return and back/forward restoration: a sign-in that changed while the page was not running is confirmed on visibilitychange / pageshow", async () => {
    const a = sessionOf(A);
    holds(a);
    let { page } = await openFor(A, a);
    holds(sessionOf(B)); // changed while this page ran no script (no event reached it)
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(showsShell(page)).toBe(true); // hidden: no check
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(removedShell(page)).toBe(true);
    page.unmount();
    holds(a);
    ({ page } = await openFor(A, a));
    holds(null);
    const reads = browser.state.reads;
    win.dispatchEvent(new Event("pageshow")); // an ordinary load's pageshow: hydration already checked
    await settle(page);
    expect(browser.state.reads).toBe(reads);
    expect(showsShell(page)).toBe(true);
    win.dispatchEvent(persistedPageShow()); // restored from the back/forward cache
    await settle(page);
    expect(removedShell(page)).toBe(true);
  });

  it("a navigation inside the retained layout confirms again (pathname change)", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    holds(sessionOf(B));
    rt.pathname = "/bag";
    page.render();
    await settle(page);
    expect(removedShell(page)).toBe(true);
  });

  it("checks coalesce (no queue, no polling): many signals while a read is out cause at most one more read", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    const before = browser.state.reads;
    let release!: () => void;
    browser.state.answer = () => new Promise((r) => { release = () => r({ data: { session: a }, error: null }); });
    for (let k = 0; k < 5; k++) browser.emit("SIGNED_OUT", null);
    await settle(page);
    release();
    await settle(page);
    browser.state.answer = () => ({ data: { session: a }, error: null });
    await settle(page);
    expect(browser.state.reads - before).toBeLessThanOrEqual(2);
    expect(showsShell(page)).toBe(true);
    // and no periodic work: time alone reads nothing
    const idle = browser.state.reads;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle(page);
    expect(browser.state.reads).toBe(idle);
  });

  it("unmount: every listener is removed, a late answer sets no state, and later signals read nothing", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    for (const key of ["document:visibilitychange", "window:pageshow", "window:click", "window:submit"]) expect(listening.get(key), key).toBe(1);
    let release!: () => void;
    browser.state.answer = () => new Promise((r) => { release = () => r({ data: { session: sessionOf(B) }, error: null }); });
    browser.emit("SIGNED_IN", sessionOf(B));
    page.unmount();
    expect(browser.subscribers()).toBe(0);
    for (const [key, count] of Array.from(listening)) expect(count, key).toBe(0);
    rt.dirty = false;
    release();
    for (let k = 0; k < 60; k++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rt.dirty).toBe(false); // the late answer called no state setter
    const reads = browser.state.reads;
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(persistedPageShow());
    win.dispatchEvent(new Event("click", { cancelable: true }));
    for (let k = 0; k < 60; k++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(browser.state.reads).toBe(reads);
    expect(rt.dirty).toBe(false);
  });

  it("before any check answers, a press or submit in a view rendered for A is refused while the browser's stored session names B (no navigation, action or request starts); same-owner and signed-out jars are not refused", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    const reached: string[] = [];
    win.addEventListener("click", () => reached.push("click"));
    win.addEventListener("submit", () => reached.push("submit"));
    // B signed in, and no event reached this page; confirming is slow/unavailable (an Auth outage)
    rt.storedSub = B;
    let releaseSlow!: () => void;
    browser.state.answer = () => new Promise((r) => { releaseSlow = () => r({ data: { session: sessionOf(B) }, error: null }); });
    const press = new Event("click", { cancelable: true });
    win.dispatchEvent(press);
    const submit = new Event("submit", { cancelable: true });
    win.dispatchEvent(submit);
    expect(press.defaultPrevented).toBe(true);
    expect(submit.defaultPrevented).toBe(true);
    expect(reached).toEqual([]); // nothing after the guard (the router, React's form action) saw them
    await vi.advanceTimersByTimeAsync(15_000);
    await settle(page);
    expect(showsShell(page)).toBe(true); // unconfirmed: the view is not ended, nothing is cleared
    expect(browser.writes).toEqual([]);
    expect(cookieWrites).toEqual([]);
    // the refusal is never silent: a fixed notice says why and offers the one control that is let through
    expect(page.text()).toContain("so the page can't act on it");
    expect(page.button("Reload page")).not.toBeNull();
    expect(page.notice()).not.toBeNull();
    // a newer sign-in of the same account, or no stored session: presses go on as before
    for (const holder of [A, null]) {
      rt.storedSub = holder;
      const ok = new Event("click", { cancelable: true });
      win.dispatchEvent(ok);
      expect(ok.defaultPrevented).toBe(false);
    }
    expect(reached).toEqual(["click", "click"]);
    await settle(page);
    expect(page.notice()).toBeNull(); // the browser holds the rendered account again (or none): the notice goes
    // the first check answered "unavailable" at its deadline (view kept, above); the coalesced follow-up check is still
    // within its own deadline: once the slow read settles naming B, that check confirms the change and ends the view
    rt.storedSub = B;
    releaseSlow();
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(browser.writes).toEqual([]);
  });

  it("a read already in flight from before the change (joined) cannot keep A's view: an event that named another account is confirmed once more", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    let releaseOld!: () => void;
    browser.state.answer = () => new Promise((r) => { releaseOld = () => r({ data: { session: a }, error: null }); });
    const otherConsumer = confirmOwnerSession(() => browser.client as never, A); // started before B's sign-in
    const b = sessionOf(B);
    holds(b);
    browser.emit("SIGNED_IN", b);
    await settle(page);
    expect(showsShell(page)).toBe(true);
    const reads = browser.state.reads;
    releaseOld();
    await otherConsumer;
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).toContain("Signed in to a different account");
    expect(browser.state.reads - reads).toBe(1); // exactly one more read, never a loop
  });

  it("a re-render of the retained layout for another account (a refresh) ends the view instead of adopting it", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page } = await openFor(A, a);
    const b = sessionOf(B);
    holds(b);
    page.rerender({ ownerId: B, lineage: await sessionLineageId(b.access_token), children: shell() });
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.text()).toContain("Signed in to a different account");
    expect(browser.writes).toEqual([]);
    // for good: a later render for the first account again does not bring the old view back
    page.rerender({ ownerId: A, lineage: await sessionLineageId(a.access_token), children: shell() });
    await settle(page);
    expect(removedShell(page)).toBe(true);
  });

  it("between the end being decided and the guidance being drawn, nothing in the old shell acts; the guidance itself is marked as the only acting area", async () => {
    const a = sessionOf(A);
    holds(a);
    const { page, lineage } = await openFor(A, a);
    const reached: string[] = [];
    win.addEventListener("click", () => reached.push("click"));
    announceEndedLineage(lineage!);
    for (let k = 0; k < 30; k++) await Promise.resolve();
    expect(rt.dirty).toBe(true); // the end is decided (state set) ...
    expect(showsShell(page)).toBe(true); // ... but not yet drawn: the old shell is still on screen
    const press = new Event("click", { cancelable: true });
    win.dispatchEvent(press);
    const submit = new Event("submit", { cancelable: true });
    win.dispatchEvent(submit);
    expect(press.defaultPrevented).toBe(true);
    expect(submit.defaultPrevented).toBe(true);
    expect(reached).toEqual([]);
    page.render();
    await settle(page);
    expect(removedShell(page)).toBe(true);
    expect(page.guidance()).not.toBeNull(); // presses inside it (Reload, Sign in) are let through by the guard
  });
});
