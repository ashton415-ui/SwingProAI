import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-05: the landing page's optional intro (components/SplashScreen.tsx).
 *
 * The real component runs on a small synchronous stand-in for React's useState/useRef/useEffect. It tracks
 * effect dependencies, runs cleanups before re-runs and on unmount, can replay mount effects the way
 * development StrictMode does (or replay every effect, as Fast Refresh does), and fills host refs with stand-in
 * nodes. The DOM pieces the intro uses are stand-ins too: a modal dialog with top-layer focus behaviour (it does
 * not focus anything by itself, so the component's own focus call is what is tested; its `close` event is a
 * real macrotask), the video, the reduced-motion media query, session storage, the page clock, user activation
 * and Save-Data hints, and the document's focused element. Timers are Vitest fake timers, so the two-second bound
 * is checked exactly. Every rendered tree is turned into markup by the real react-dom/server.
 *
 * Stand-ins prove the component's logic, not real focus or inert behaviour: the mocked browser run covers that.
 * This file imports nothing added by GJ-PARALLEL-05, so it also runs against the accepted pre-change splash
 * as a control, where the behaviour checks fail for the intended reasons.
 *
 * GJ-PARALLEL-05-R1 adds the admission cases: the page changes after the decision commit and before the commit
 * whose effect opens the intro (or after that commit's render and before its effect). Run against the reviewed GJ05
 * splash, exactly the cases where the intro must be given up, or must not be reopened, fail (it opens anyway);
 * every other case passes on both.
 */

const rt = vi.hoisted(() => ({
  states: [] as unknown[],
  si: 0,
  refs: [] as { current: unknown }[],
  ri: 0,
  effects: [] as ({ deps: unknown[] | undefined; cleanup?: () => void } | undefined)[],
  ei: 0,
  queue: [] as { i: number; fn: () => unknown; deps: unknown[] | undefined }[],
  dirty: false,
  mounted: true,
  setsAfterUnmount: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = rt.si++;
    if (!(i in rt.states)) rt.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      if (!rt.mounted) {
        rt.setsAfterUnmount++;
        return;
      }
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(rt.states[i]) : v;
      if (!Object.is(next, rt.states[i])) {
        rt.states[i] = next;
        rt.dirty = true;
      }
    };
    return [rt.states[i], set];
  }
  function useRef(init: unknown) {
    const i = rt.ri++;
    if (!(i in rt.refs)) rt.refs[i] = { current: init };
    return rt.refs[i];
  }
  function useEffect(fn: () => unknown, deps?: unknown[]) {
    const i = rt.ei++;
    const prev = rt.effects[i];
    if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))) rt.queue.push({ i, fn, deps });
  }
  return { ...actual, default: actual, useState, useRef, useEffect };
});

import SplashScreen from "@/components/SplashScreen";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const KEY = "swingproai:intro-seen";
const realSetTimeout = globalThis.setTimeout; // captured before any test fakes the timers

// ── stand-in DOM ─────────────────────────────────────────────────────────────────────────────────
let listenerCount = 0;
class Target {
  listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set();
    if (!set.has(fn)) listenerCount++;
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: unknown) => void) {
    if (this.listeners.get(type)?.delete(fn)) listenerCount--;
  }
  dispatch(type: string) {
    for (const fn of Array.from(this.listeners.get(type) ?? [])) fn({ type, target: this });
  }
}
type Node = { name: string; focus: () => void; getClientRects: () => unknown[] };
const BODY = { name: "body" };
const dom = {
  active: BODY as unknown,
  modal: null as null | FakeDialog,
  preModal: BODY as unknown,
  focusLog: [] as string[],
  blockedFocus: [] as string[],
  queries: 0,
  dialog: null as null | FakeDialog,
  skip: null as null | Node,
  video: null as null | FakeVideo,
};
function focusable(name: string, inside: () => boolean): Node {
  return {
    name,
    focus() {
      // while a modal dialog is open, everything outside it is inert
      if (dom.modal && !inside()) {
        dom.blockedFocus.push(name);
        return;
      }
      dom.active = this;
      dom.focusLog.push(name);
    },
    getClientRects: () => [{}],
  };
}
const SIGN_IN = focusable("landing:sign-in", () => false);
class FakeDialog extends Target {
  open = false;
  connected = true;
  showModalCalls = 0;
  closeCalls = 0;
  throwOnShow = false;
  showModal() {
    if (this.throwOnShow) throw new Error("InvalidStateError (stand-in)");
    if (!this.connected || this.open) throw new Error("InvalidStateError");
    this.open = true;
    this.showModalCalls++;
    dom.preModal = dom.active;
    dom.modal = this;
    // deliberately no focus move here: the component must put focus on Skip intro itself
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.closeCalls++;
    this.leaveTopLayer();
    realSetTimeout(() => this.dispatch("close"), 0); // a task, as in browsers
  }
  // Escape, or a platform back gesture: the browser closes the dialog itself
  nativeClose() {
    if (!this.open) return;
    this.open = false;
    this.leaveTopLayer();
    realSetTimeout(() => this.dispatch("close"), 0);
  }
  leaveTopLayer() {
    if (dom.modal === this) dom.modal = null;
    if (this.contains(dom.active)) dom.active = dom.preModal; // focus goes back where it was
  }
  contains(el: unknown) {
    return el === this || el === dom.skip || el === dom.video;
  }
}
class FakeVideo extends Target {
  error: null | { code: number } = null;
  playCalls = 0;
  playMode: "pending" | "reject" | "throw" | "undefined" = "pending";
  rejectPlay: (() => void)[] = [];
  play() {
    this.playCalls++;
    if (this.playMode === "throw") throw new Error("NotSupportedError (stand-in)");
    if (this.playMode === "undefined") return undefined;
    if (this.playMode === "reject") return Promise.reject(new Error("NotAllowedError (stand-in)"));
    return new Promise<void>((_, reject) => this.rejectPlay.push(() => reject(new Error("AbortError (stand-in)"))));
  }
  pause() {}
}
class FakeMQL extends Target {
  matches = false;
  media = "(prefers-reduced-motion: reduce)";
  change(matches: boolean) {
    this.matches = matches;
    this.dispatch("change");
  }
}
const env = {
  mql: new FakeMQL(),
  data: new Map<string, string>(),
  ops: [] as string[],
  getThrows: false,
  setThrows: false,
  storageGetterThrows: false,
  noMatchMedia: false,
  scrollY: 0,
  t0: 0,
  pageAgeAtMount: 150, // ms since navigation start when the test starts (a fast hydration)
  activated: false,
  saveData: false,
  hintsThrow: false,
};
const store = {
  getItem(k: string) {
    env.ops.push(`get:${k}`);
    if (env.getThrows) throw new Error("SecurityError (stand-in)");
    return env.data.has(k) ? env.data.get(k)! : null;
  },
  setItem(k: string, v: string) {
    env.ops.push(`set:${k}=${v}`);
    if (env.setThrows) throw new Error("QuotaExceededError (stand-in)");
    env.data.set(k, String(v));
  },
  removeItem(k: string) {
    env.ops.push(`remove:${k}`);
    env.data.delete(k);
  },
  clear() {
    env.ops.push("clear");
    env.data.clear();
  },
  key(i: number) {
    env.ops.push(`key:${i}`);
    return Array.from(env.data.keys())[i] ?? null;
  },
  get length() {
    env.ops.push("length");
    return env.data.size;
  },
};
const win = {
  get matchMedia() {
    return env.noMatchMedia ? undefined : () => env.mql;
  },
  get sessionStorage() {
    if (env.storageGetterThrows) throw new Error("SecurityError (stand-in)");
    return store;
  },
  get scrollY() {
    return env.scrollY;
  },
  // the page clock follows the fake timers (Date is faked with them)
  performance: { now: () => env.pageAgeAtMount + (Date.now() - env.t0) },
  navigator: {
    get userActivation() {
      if (env.hintsThrow) throw new Error("SecurityError (stand-in)");
      return { hasBeenActive: env.activated };
    },
    get connection() {
      return { saveData: env.saveData };
    },
  },
};
const doc = {
  body: BODY,
  get activeElement() {
    return dom.active;
  },
  querySelectorAll() {
    dom.queries++;
    return [dom.skip, SIGN_IN].filter(Boolean);
  },
};
function DialogSupport() {}
DialogSupport.prototype.showModal = function showModal() {};

// ── a tiny synchronous renderer for the one component ────────────────────────────────────────────
type El = React.ReactElement<Record<string, unknown>> & { ref?: unknown };
const owners = new Map<string, { current: unknown }>();
function hostNodes(node: unknown, out: El[] = []): El[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) hostNodes(n, out);
    return out;
  }
  const el = node as El;
  if (typeof el.type === "string") out.push(el);
  hostNodes(el.props?.children, out);
  return out;
}
function standIn(type: string): unknown {
  if (type === "dialog") return (dom.dialog ??= new FakeDialog());
  if (type === "button") return (dom.skip ??= focusable("intro:skip", () => true));
  if (type === "video") return (dom.video ??= new FakeVideo());
  return { type };
}
function removeStandIn(type: string) {
  if (type === "dialog" && dom.dialog) {
    dom.dialog.connected = false;
    if (dom.modal === dom.dialog) dom.dialog.leaveTopLayer();
    if (dom.dialog.contains(dom.active)) dom.active = BODY; // focus fixup
    dom.dialog = null;
  }
  if (type === "button") dom.skip = null;
  if (type === "video") dom.video = null;
}
function attach(tree: unknown) {
  const present = new Set<string>();
  for (const el of hostNodes(tree)) {
    const ref = el.ref;
    if (ref && typeof ref === "object" && "current" in (ref as object)) {
      const type = el.type as string;
      present.add(type);
      (ref as { current: unknown }).current = standIn(type);
      owners.set(type, ref as { current: unknown });
    }
  }
  for (const [type, ref] of Array.from(owners)) {
    if (!present.has(type)) {
      ref.current = null;
      owners.delete(type);
      removeStandIn(type);
    }
  }
}
let tree: unknown = null;
let renders = 0;
function runEffect(q: { i: number; fn: () => unknown; deps: unknown[] | undefined }) {
  const c = q.fn();
  rt.effects[q.i] = { deps: q.deps, cleanup: typeof c === "function" ? (c as () => void) : undefined };
}
// `beforeEffects` runs after the render is attached and before its effects: a browser's moment between a commit's DOM
// changes and its passive effects.
function commit(strict = false, beforeEffects?: () => void) {
  rt.si = rt.ri = rt.ei = 0;
  rt.queue = [];
  rt.dirty = false;
  tree = (SplashScreen as () => unknown)();
  renders++;
  attach(tree);
  beforeEffects?.();
  const queued = rt.queue;
  for (const q of queued) rt.effects[q.i]?.cleanup?.();
  for (const q of queued) runEffect(q);
  if (strict) {
    // development StrictMode: every mount effect is cleaned up and run again, with state and refs kept
    for (const q of queued) rt.effects[q.i]?.cleanup?.();
    for (const q of queued) runEffect(q);
  }
}
function flush() {
  for (let n = 0; rt.dirty; n++) {
    if (n > 20) throw new Error("render loop");
    commit();
  }
}
function mount(opts: { strict?: boolean } = {}) {
  rt.mounted = true;
  commit(!!opts.strict);
  flush();
}
// Cleans up and re-runs every current effect, as Fast Refresh (or a future preserved-route re-show) does while mounted.
function replayEffects() {
  for (const e of rt.effects) e?.cleanup?.();
  rt.effects = rt.effects.map(() => undefined); // forget the dependencies, so every effect runs again
  rt.si = rt.ri = rt.ei = 0;
  rt.queue = [];
  tree = (SplashScreen as () => unknown)();
  attach(tree);
  for (const q of rt.queue) runEffect(q);
  flush();
}
function unmount() {
  for (const e of rt.effects) e?.cleanup?.();
  rt.mounted = false;
  for (const [type, ref] of Array.from(owners)) {
    ref.current = null;
    owners.delete(type);
    removeStandIn(type);
  }
}
function remountFresh() {
  rt.mounted = true;
  rt.states = [];
  rt.refs = [];
  rt.effects = [];
}
const html = () => (tree ? renderToStaticMarkup(tree as React.ReactElement) : "");
const introShown = () => !!dom.dialog && dom.dialog.open && dom.modal === dom.dialog && html().includes("<dialog");
const skipButton = () => hostNodes(tree).find((e) => e.type === "button");
const pressSkip = () => (skipButton()!.props.onClick as (e: { detail: number }) => void)({ detail: 0 });
const tasks = () => new Promise((r) => realSetTimeout(r, 5)); // let real macrotasks (dialog close events) and promise jobs run
// The intro's own button is the only thing that ever received focus; nothing on the page behind was focused.
const onlySkipWasFocused = () => dom.focusLog.length > 0 && dom.focusLog.every((f) => f === "intro:skip");

beforeEach(() => {
  vi.useFakeTimers();
  rt.states = [];
  rt.refs = [];
  rt.effects = [];
  rt.queue = [];
  rt.dirty = false;
  rt.mounted = true;
  rt.setsAfterUnmount = 0;
  owners.clear();
  tree = null;
  renders = 0;
  listenerCount = 0;
  Object.assign(dom, { active: BODY, modal: null, preModal: BODY, focusLog: [], blockedFocus: [], queries: 0, dialog: null, skip: null, video: null });
  env.mql = new FakeMQL();
  env.data = new Map([["another-app:key", "kept"]]);
  env.ops = [];
  Object.assign(env, { getThrows: false, setThrows: false, storageGetterThrows: false, noMatchMedia: false, scrollY: 0, t0: Date.now(), pageAgeAtMount: 150, activated: false, saveData: false, hintsThrow: false });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLDialogElement", DialogSupport);
});
afterEach(() => {
  if (rt.mounted) unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Everything torn down: no timer, no listener, no modal, the page focusable again, focus back at the page start,
// and the component never searched the document or moved focus onto the page.
function expectClean() {
  expect(vi.getTimerCount()).toBe(0);
  expect(listenerCount).toBe(0);
  expect(dom.modal).toBeNull();
  expect(tree).toBeNull();
  expect(dom.active).toBe(BODY);
  expect(dom.queries).toBe(0);
  expect(dom.blockedFocus).toEqual([]);
}

describe("before hydration and without JavaScript", () => {
  it("the first render (the server's render) emits no overlay and reads no browser state", () => {
    const first = (SplashScreen as () => unknown)();
    expect(first).toBeNull();
    expect(env.ops).toEqual([]);
    expect(dom.queries).toBe(0);
  });

  it("keeps the public component interface: a default-exported component without props", () => {
    expect(typeof SplashScreen).toBe("function");
    expect((SplashScreen as (...a: unknown[]) => unknown).length).toBe(0);
  });
});

describe("first visit in a tab session", () => {
  it("opens as a modal dialog, puts focus on the named Skip intro button itself, and plays the existing video", () => {
    mount();
    expect(introShown()).toBe(true);
    expect(dom.dialog!.showModalCalls).toBe(1);
    expect(dom.active).toBe(dom.skip);
    expect(onlySkipWasFocused()).toBe(true);
    expect(dom.video!.playCalls).toBe(1);
    const markup = html();
    expect(markup).toMatch(/<dialog[^>]*aria-label="SwingProAI intro"/);
    expect(markup).toMatch(/<button type="button"[^>]*>Skip intro<\/button>/);
    expect(markup).toContain('src="/logo-animation.mp4"');
    expect(markup).toContain('poster="/swingproai_logo.png"');
  });

  it("fades in: rendered transparent, then shown once the dialog is open", () => {
    rt.mounted = true;
    commit(); // the decision render: nothing yet
    expect(tree).toBeNull();
    commit(); // the dialog's first render; this commit also runs its effect, but `tree` is the markup rendered before it
    expect(html()).toMatch(/<dialog[^>]*class="[^"]*opacity-0 duration-200/);
    flush();
    expect(html()).toMatch(/<dialog[^>]*class="[^"]*opacity-100 duration-200/);
  });

  it("writes one namespaced flag with a constant value and touches no other key", () => {
    mount();
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]);
    expect(Array.from(env.data.entries())).toEqual([["another-app:key", "kept"], [KEY, "1"]]);
  });

  it("ends within two seconds of appearing, fade included, and cleans everything up", () => {
    mount();
    vi.advanceTimersByTime(1699);
    expect(introShown()).toBe(true);
    expect(html()).toContain("opacity-100");
    vi.advanceTimersByTime(1);
    flush();
    expect(html()).toContain("opacity-0 duration-300"); // the fade
    vi.advanceTimersByTime(299);
    flush();
    expect(introShown()).toBe(true);
    vi.advanceTimersByTime(1);
    flush();
    expectClean();
    expect(onlySkipWasFocused()).toBe(true);
  });
});

describe("ending the intro: once, and focus always back at the page start", () => {
  it("Skip intro (any input: pointer, keyboard, assistive technology) ends it at once", () => {
    mount();
    vi.advanceTimersByTime(400);
    pressSkip();
    flush();
    expectClean();
    expect(onlySkipWasFocused()).toBe(true);
  });

  it("a repeated or held key on Skip can activate nothing on the landing (focus is not moved onto a link)", () => {
    mount();
    pressSkip();
    flush();
    expect(dom.active).toBe(BODY);
    expect(dom.focusLog.includes("landing:sign-in")).toBe(false);
  });

  it("Escape (the browser closing the dialog) ends it the same way", async () => {
    mount();
    dom.dialog!.nativeClose();
    await tasks();
    flush();
    expectClean();
  });

  it("Escape during the fade ends it at once", async () => {
    mount();
    vi.advanceTimersByTime(1800);
    flush();
    dom.dialog!.nativeClose();
    await tasks();
    flush();
    expectClean();
  });

  it("the video ending fades it out early", () => {
    mount();
    vi.advanceTimersByTime(500);
    dom.video!.dispatch("ended");
    flush();
    expect(html()).toContain("opacity-0 duration-300");
    vi.advanceTimersByTime(300);
    flush();
    expectClean();
  });

  it("the two-second bound still holds when the video ends just before it", () => {
    mount();
    vi.advanceTimersByTime(1900);
    dom.video!.dispatch("ended");
    flush();
    vi.advanceTimersByTime(100);
    flush();
    expectClean();
  });

  it("a video error ends it at once, also one that happened before the listeners were attached", () => {
    mount();
    dom.video!.dispatch("error");
    flush();
    expectClean();

    remountFresh();
    env.data.delete(KEY);
    const early = new FakeVideo();
    early.error = { code: 4 };
    dom.video = early;
    mount();
    expectClean();
    expect(early.playCalls).toBe(0);
  });

  it("blocked autoplay ends it at once", async () => {
    dom.video = new FakeVideo();
    dom.video.playMode = "reject";
    mount();
    await tasks();
    flush();
    expectClean();
  });

  it("a play() that throws, or a browser without a play promise, never leaves it stuck", () => {
    dom.video = new FakeVideo();
    dom.video.playMode = "throw";
    mount();
    flush();
    expectClean();

    remountFresh();
    env.data.delete(KEY);
    dom.video = new FakeVideo();
    dom.video.playMode = "undefined";
    mount();
    expect(introShown()).toBe(true);
    vi.advanceTimersByTime(2000);
    flush();
    expectClean();
  });

  it("a dialog that cannot open modally never blocks the page", () => {
    dom.dialog = new FakeDialog();
    dom.dialog.throwOnShow = true;
    mount();
    flush();
    expectClean();
  });

  it("ends only once when Skip, Escape, the video ending, an error and the timeout race", async () => {
    mount();
    const dialog = dom.dialog!;
    vi.advanceTimersByTime(1750); // fading has started
    dom.video!.dispatch("ended");
    pressSkip();
    pressSkip();
    dom.video?.dispatch("error");
    dialog.nativeClose();
    vi.advanceTimersByTime(5000);
    await tasks();
    flush();
    expectClean();
    expect(dialog.closeCalls).toBe(1);
    expect(onlySkipWasFocused()).toBe(true);
  });
});

describe("unmount, StrictMode and effect replays", () => {
  it("unmounting before any callback cancels all pending work: no later state change, focus or close", async () => {
    mount();
    const dialog = dom.dialog!;
    const video = dom.video!;
    vi.advanceTimersByTime(300);
    const focusesBefore = dom.focusLog.length;
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCount).toBe(0);
    expect(dom.modal).toBeNull(); // removed from the document, so out of the top layer
    expect(dom.active).toBe(BODY);
    for (const reject of video.rejectPlay) reject();
    vi.advanceTimersByTime(5000);
    dialog.dispatch("close");
    video.dispatch("ended");
    await tasks();
    expect(rt.setsAfterUnmount).toBe(0);
    expect(dom.focusLog.length).toBe(focusesBefore);
    expect(dialog.closeCalls).toBe(0);
  });

  it("StrictMode's mount replay shows it once, reads and writes storage once, and leaks no timer or listener", () => {
    mount({ strict: true });
    expect(introShown()).toBe(true);
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]);
    expect(dom.dialog!.showModalCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(2000);
    flush();
    expectClean();
  });

  it("replaying the effects while it is open neither reopens nor leaks, and keeps the bound from its first appearance", () => {
    mount();
    vi.advanceTimersByTime(500);
    const before = listenerCount;
    replayEffects();
    expect(dom.dialog!.showModalCalls).toBe(1);
    expect(listenerCount).toBe(before);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(1499);
    flush();
    expect(introShown()).toBe(true);
    vi.advanceTimersByTime(1); // 2000 ms after it first appeared, not 2000 ms after the replay
    flush();
    expectClean();
  });

  it("replaying the effects after it has ended does not open it again", () => {
    mount();
    pressSkip();
    flush();
    replayEffects();
    expect(tree).toBeNull();
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]);
    expectClean();
  });
});

describe("when the intro is skipped entirely", () => {
  it("reduced motion: no dialog, no video, no storage access", () => {
    env.mql.matches = true;
    mount();
    expect(tree).toBeNull();
    expect(env.ops).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCount).toBe(0);
  });

  it("a switch to reduced motion while it is open ends it at once", () => {
    mount();
    vi.advanceTimersByTime(200);
    env.mql.change(true);
    flush();
    expectClean();
  });

  it("a returning visit in the same tab session: never shown and nothing written", () => {
    env.data.set(KEY, "1");
    mount();
    expect(tree).toBeNull();
    expect(renders).toBe(1);
    expect(env.ops).toEqual([`get:${KEY}`]);
  });

  it.each([
    ["reading throws", () => (env.getThrows = true)],
    ["writing throws", () => (env.setThrows = true)],
    ["access itself throws", () => (env.storageGetterThrows = true)],
  ])("session storage %s: the landing stays usable, no other key is touched", (_, arrange) => {
    arrange();
    mount();
    expect(tree).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(env.ops.every((op) => op === `get:${KEY}` || op === `set:${KEY}=1`)).toBe(true);
    expect(env.data.get("another-app:key")).toBe("kept");
  });

  it.each([
    ["focus is already on the page", () => (dom.active = SIGN_IN)],
    ["the page has been scrolled", () => (env.scrollY = 120)],
    ["the golfer has already tapped, clicked or pressed a key", () => (env.activated = true)],
    ["the page took more than a second to become interactive", () => (env.pageAgeAtMount = 1001)],
    ["reduced data use (Save-Data) is on", () => (env.saveData = true)],
  ])("%s: not shown, not interrupted, nothing written", (_, arrange) => {
    const activeBefore = (arrange(), dom.active);
    mount();
    expect(tree).toBeNull();
    expect(dom.active).toBe(activeBefore);
    expect(env.ops).toEqual([]);
  });

  it("just inside the one-second start budget it is still shown", () => {
    env.pageAgeAtMount = 1000;
    mount();
    expect(introShown()).toBe(true);
  });

  it("a browser without a modal dialog or without media queries", () => {
    vi.stubGlobal("HTMLDialogElement", undefined);
    mount();
    expect(tree).toBeNull();

    unmount();
    vi.stubGlobal("HTMLDialogElement", DialogSupport);
    remountFresh();
    env.noMatchMedia = true;
    mount();
    expect(tree).toBeNull();
    expect(env.ops).toEqual([]);
  });
});

// GJ-PARALLEL-05-R1. Deciding (the first commit's effect: the checks, the storage read and the reservation, then `open`
// set) and opening (the next commit's effect: showModal, focus on Skip intro, play) are separate steps, and the golfer
// or the system can act in between. These cases change the page exactly there: after the decision commit has run its
// effects and before the next commit renders. (`commit()` runs its own effects, so nothing is injected after the
// opening effect.)
describe("admission: the page changes after the decision and before the intro opens", () => {
  // The decision commit only. The stand-ins the opening render will use are created first, so they can be inspected
  // after the intro has been given up and removed.
  function decideOnly(strict = false) {
    rt.mounted = true;
    const dialog = (dom.dialog = new FakeDialog());
    const video = (dom.video = new FakeVideo());
    commit(strict);
    expect(tree).toBeNull(); // nothing rendered yet
    expect(rt.dirty).toBe(true); // the opening render is pending
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]); // reserved
    expect(dialog.showModalCalls).toBe(0);
    return { dialog, video };
  }
  // Given up before opening: no modal, no focus move, no playback, nothing left running, storage untouched since the
  // reservation, and the page exactly as the golfer left it.
  function expectGivenUp({ dialog, video }: { dialog: FakeDialog; video: FakeVideo }, activeBefore: unknown, focusesBefore: string[]) {
    // one comparison first, so a failure shows everything the opening did
    expect({ showModalCalls: dialog.showModalCalls, focusedSince: dom.focusLog.slice(focusesBefore.length), focusStayed: dom.active === activeBefore, playCalls: video.playCalls })
      .toEqual({ showModalCalls: 0, focusedSince: [], focusStayed: true, playCalls: 0 });
    expect(dialog.open).toBe(false);
    expect(dom.focusLog).toEqual(focusesBefore);
    expect(tree).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCount).toBe(0);
    expect(dom.modal).toBeNull();
    expect(dom.queries).toBe(0);
    expect(dom.blockedFocus).toEqual([]);
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]);
    expect(env.data.get("another-app:key")).toBe("kept");
  }

  it.each([
    ["the golfer moves focus onto the landing (Sign In)", () => {}, () => SIGN_IN.focus()],
    ["the golfer taps, clicks or presses a key (user activation)", () => {}, () => (env.activated = true)],
    ["reduced motion is switched on (before the intro listens for the change)", () => {}, () => env.mql.change(true)],
    ["the page is scrolled", () => {}, () => (env.scrollY = 120)],
    ["Save-Data is switched on", () => {}, () => (env.saveData = true)],
    ["the one-second start budget runs out", () => (env.pageAgeAtMount = 990), () => vi.advanceTimersByTime(11)],
  ])("%s: the intro is given up before it opens", (_, arrange, between) => {
    arrange();
    const stand = decideOnly();
    between();
    const activeBefore = dom.active;
    const focusesBefore = [...dom.focusLog];
    flush(); // the opening render and its effect
    expectGivenUp(stand, activeBefore, focusesBefore);
  });

  it("under StrictMode's mount replay too: focus moved in between is kept", () => {
    const stand = decideOnly(true);
    SIGN_IN.focus();
    flush();
    expectGivenUp(stand, SIGN_IN, ["landing:sign-in"]);
  });

  it.each([
    ["the golfer moves focus onto the landing (Sign In)", () => SIGN_IN.focus()],
    ["the golfer taps, clicks or presses a key (user activation)", () => (env.activated = true)],
    ["reduced motion is switched on", () => env.mql.change(true)],
    ["the page is scrolled", () => (env.scrollY = 120)],
  ])("%s after the opening render and before its effect: given up too (the check is not made during render)", (_, between) => {
    const stand = decideOnly();
    let activeBefore: unknown = null;
    let focusesBefore: string[] = [];
    commit(false, () => {
      expect(html()).toContain("<dialog"); // the closed dialog is in the page; its effect has not run yet
      expect(stand.dialog.showModalCalls).toBe(0);
      between();
      activeBefore = dom.active;
      focusesBefore = [...dom.focusLog];
    });
    flush();
    expectGivenUp(stand, activeBefore, focusesBefore);
  });

  it("a readiness check that throws at the opening gives the intro up the same way", () => {
    const stand = decideOnly();
    env.hintsThrow = true;
    flush();
    expectGivenUp(stand, BODY, []);
  });

  it("an effect replay after it was given up does not open it", () => {
    const stand = decideOnly();
    SIGN_IN.focus();
    flush();
    replayEffects();
    expectGivenUp(stand, SIGN_IN, ["landing:sign-in"]);
  });

  it("Escape racing an effect replay: an intro that has appeared and was closed is never reopened", async () => {
    mount();
    const dialog = dom.dialog!;
    vi.advanceTimersByTime(300);
    dialog.nativeClose(); // its close event is still queued when the replay runs
    replayEffects();
    expect(dialog.showModalCalls).toBe(1);
    expect(dialog.open).toBe(false);
    await tasks();
    flush();
    expectClean();
    expect(onlySkipWasFocused()).toBe(true);
  });

  it("nothing changed in between: it opens once, from the one reservation, with focus on Skip intro and the video playing", () => {
    const { dialog, video } = decideOnly();
    flush();
    expect(introShown()).toBe(true);
    expect(dialog.showModalCalls).toBe(1);
    expect(dom.active).toBe(dom.skip);
    expect(onlySkipWasFocused()).toBe(true);
    expect(video.playCalls).toBe(1);
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`]);
    vi.advanceTimersByTime(2000);
    flush();
    expectClean();
  });

  it("still inside the start budget when it opens (exactly one second): it opens", () => {
    env.pageAgeAtMount = 990;
    decideOnly();
    vi.advanceTimersByTime(10);
    flush();
    expect(introShown()).toBe(true);
  });

  it("an intro given up at its opening still counts as this tab session's intro (kept reservation, no second one)", () => {
    const { dialog } = decideOnly();
    env.scrollY = 120;
    flush();
    expect(dialog.showModalCalls).toBe(0);
    expect(tree).toBeNull();
    unmount();
    remountFresh();
    env.scrollY = 0;
    mount();
    expect(tree).toBeNull();
    expect(env.ops).toEqual([`get:${KEY}`, `set:${KEY}=1`, `get:${KEY}`]);
  });

  it("an effect replay while it is open is not mistaken for the golfer using the page", () => {
    mount();
    vi.advanceTimersByTime(1200); // past the start budget, and focus is on Skip intro rather than the page start
    env.activated = true; // e.g. a key pressed inside the intro
    replayEffects();
    expect(introShown()).toBe(true);
    expect(dom.dialog!.showModalCalls).toBe(1);
    expect(dom.active).toBe(dom.skip);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(799);
    flush();
    expect(introShown()).toBe(true);
    vi.advanceTimersByTime(1); // still 2000 ms after it first appeared
    flush();
    expectClean();
  });
});

describe("presentation", () => {
  it("adds no second h1, names the dialog, and hides the decorative video and wordmark from assistive technology", () => {
    mount();
    const markup = html();
    expect(markup).not.toMatch(/<h[1-6]/);
    expect(markup).toMatch(/<video[^>]*aria-hidden="true"/);
    expect(markup).toMatch(/<div aria-hidden="true" class="text-center">/);
  });

  it("Skip intro is a 44px button whose focus outline shows from the moment it is focused; the caption is no longer 10px gray-600", () => {
    mount();
    const cls = String(skipButton()!.props.className).split(/\s+/);
    for (const c of ["min-h-11", "min-w-11", "focus:outline", "focus:outline-2", "focus:outline-golf-green"]) expect(cls).toContain(c);
    expect(cls).not.toContain("focus:outline-none");
    const markup = html();
    expect(markup).not.toContain("text-gray-600");
    expect(markup).not.toContain("text-[10px]");
    expect(markup).toContain("Golf Swing Analyzer");
  });

  it("the fades are switched off for reduced motion, the backdrop never darkens the page, and the logo has a vh fallback", () => {
    mount();
    const markup = html();
    expect(markup).toContain("motion-reduce:transition-none");
    expect(markup).toContain("backdrop:bg-transparent");
    expect(markup).toContain("h-[min(18rem,60vw,calc(100vh_-_14rem))]");
    expect(markup).toContain("supports-[height:100dvh]:h-[min(18rem,60vw,calc(100dvh_-_14rem))]");
  });
});

describe("source guards", () => {
  const src = source("components/SplashScreen.tsx");
  it("one session-storage flag; no other storage, cookie, navigation, network, action or attribute writes", () => {
    expect(src.match(/sessionStorage/g)).toHaveLength(1);
    expect(src.match(/swingproai:intro-seen/g)).toHaveLength(1);
    expect(src).not.toMatch(/localStorage|indexedDB|caches\.|document\.cookie|\.clear\(|removeItem|\.key\(|Object\.keys|for \(const \w+ in/);
    expect(src).not.toMatch(/next\/navigation|next\/link|useRouter|router\.|location\.|history\.|fetch\(|XMLHttpRequest|sendBeacon|window\.open|postMessage|import\(/);
    expect(src).not.toMatch(/\.click\(|dispatchEvent|\.submit\(|requestSubmit|querySelector/);
    expect(src).not.toMatch(/setAttribute|removeAttribute|\binert\b|body\.style|documentElement\.style|requestAnimationFrame/);
    expect(src).not.toMatch(/autoPlay/);
    expect(src.match(/\.focus\(/g)).toHaveLength(1); // only Skip intro is ever focused
  });

  it("only the landing page renders the intro (no login, signup or dashboard route imports it)", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(tsx?|jsx?)$/.test(e.name) && /SplashScreen/.test(source(rel)) && rel !== "components/SplashScreen.tsx") importers.push(rel);
      }
    };
    walk("app");
    walk("components");
    expect(importers).toEqual(["app/page.tsx"]);
  });
});
