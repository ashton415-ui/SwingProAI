import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { randomUUID, createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-09-P1 — opening a saved swing report is safe: it never sends an analysis request
 * (app/(dashboard)/analyze/[id]/AnalysisReport.tsx).
 *
 * The real report component is driven through its real effects with the small synchronous hook runtime of
 * lib/web-ready04-report-status.test.tsx (the whole tree is expanded on each pass; the module itself is not re-imported
 * between mounts, as in a browser tab). The shared browser client is a stand-in, every request goes to a recording fetch,
 * and lib/drill-hub-session.ts confirmOwnerSession / ownerBearer are the real modules. Synthetic identities only; nothing
 * leaves the process.
 *
 * Covered: every stored status opens with zero requests (also after time passes, a re-render and a remount); a stored
 * "processing" row shows its saved status, no invented progress, and "Check status" is a page reload (no request); a
 * pending swing's "Analyze swing" and a stored failure's "Retry analysis" send exactly one request per accepted press —
 * a double press, a re-render and a remount while it is out send no second one; the guard is released when the request
 * settles; completed, unusable and stalled cases offer no action that sends work; and every status-panel control is a
 * labelled button or link with a 44x44 px minimum target and a visible focus outline.
 */

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  pending: [] as number[],
  dirty: false,
  rendered: null as null | { ownerId: string; lineage: string | null },
  client: null as unknown,
}));

vi.mock("server-only", () => ({}));
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
  const useContext = () => rt.rendered;
  return { ...actual, default: actual, useState, useRef, useMemo, useCallback, useEffect, useContext };
});
vi.mock("lucide-react", () => {
  const none = () => null;
  return Object.fromEntries(
    ["CheckCircle2", "AlertTriangle", "Loader2", "Zap", "Target", "ChevronDown", "ChevronUp", "RotateCcw", "Play", "Pause",
      "TrendingUp", "AlertCircle", "Lightbulb", "Dumbbell"].map((name) => [name, none]),
  );
});
vi.mock("@/utils/supabase/client", () => ({ createClient: () => rt.client }));

import AnalysisReport, { type AnalysisData } from "@/app/(dashboard)/analyze/[id]/AnalysisReport";
import { sessionLineageId } from "@/utils/supabase/session-cookie-layout";
import { VIDEO_UNUSABLE_COPY, VIDEO_UNUSABLE_STATUS } from "@/lib/swing-video-source";

const A = randomUUID();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, sid = `sid-${randomUUID()}`) => `${b64({ alg: "none" })}.${b64({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-${randomUUID()}`;
function sessionOf(user: string) {
  return { access_token: jwt(user), refresh_token: `rt-${randomUUID()}`, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: user } };
}
type Session = ReturnType<typeof sessionOf>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ─── tree expansion and the hook runtime's mount (as lib/web-ready04-report-status.test.tsx) ─────────────────────────
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
function mount<P>(Component: (props: P) => unknown, props: P) {
  rt.slots = [];
  rt.pending = [];
  rt.dirty = false;
  let nodes: (HostNode | string)[] = [];
  let unmounted = false;
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
    unmount: () => {
      unmounted = true;
      for (const slot of rt.slots as { effect?: boolean; cleanup?: unknown }[]) if (slot?.effect && typeof slot.cleanup === "function") (slot.cleanup as () => void)();
    },
    text: () => textOf(nodes),
    pill: () => {
      const spans = findAll(nodes, (n) => n.type === "span" && typeof n.props.className === "string" && (n.props.className as string).includes("rounded-full border"));
      return spans.length ? textOf(spans[0].children) : null;
    },
    buttons: () => findAll(nodes, (n) => n.type === "button").map((n) => textOf(n.children).trim()),
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
  const state = { session: null as Session | null };
  const subscribers = new Set<(event: string, session: unknown) => void>();
  const client = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: state.session }, error: null }),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        subscribers.add(callback);
        return { data: { subscription: { unsubscribe: () => subscribers.delete(callback) } } };
      },
    },
  };
  return { client, state, emit: (event: string, session: unknown) => subscribers.forEach((cb) => cb(event, session)) };
}
let browser: ReturnType<typeof managed>;
let wire: { url: string; method: string | null; authorization: string | null; credentials: string | null; body: string | null }[] = [];
let respond: () => Promise<Response>;
const analysisRequests = () => wire.filter((r) => r.url === "/api/analyze-swing");

const base = (status: string, id = randomUUID()): AnalysisData => ({ id, status, score: null, feedback: null, swing_highlights: null, mechanical_deficiencies: null, metrics: null, swing_video: null });
const completion = (a: AnalysisData, feedback: string) => ({ message: "Analysis complete", data: { ...a, status: "complete", score: 74, feedback, swing_highlights: [], mechanical_deficiencies: [], metrics: {} } });

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

let session: Session;
async function open(analysis: AnalysisData, extra: Record<string, unknown> = {}) {
  const page = mount(AnalysisReport as unknown as (p: unknown) => unknown, { analysis, videoSignedUrl: null, clubDisplayName: "Synthetic 7i", ...extra });
  await settle(page);
  return page;
}
/** a press as the golfer's click (the click handler, then the render it causes); no settle, so presses can be stacked */
function press(page: Mounted, label: string) {
  const button = page.button(label);
  expect(button, label).not.toBeNull();
  (button!.props.onClick as () => void)();
  page.render();
}
/** "Check status" / "Check again": a reload of the page (its own owner-bound server read); returns the reloads caused */
async function pressCheck(page: Mounted, label = "Check status") {
  let reloads = 0;
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const previous = g.window;
  g.window = { location: { reload: () => { reloads += 1; } } };
  try {
    press(page, label);
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
  await settle(page);
  return reloads;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const INVENTED_PROGRESS = /Connecting to AI coach|Evaluating posture|Analysing swing plane|Assessing impact|Generating drill|Finalising report|AI Coach Active/;

describe("09-P1: the saved swing report never sends an analysis request on its own; only the golfer's deliberate press does", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installMicrotaskDigest();
    browser = managed();
    rt.client = browser.client;
    session = sessionOf(A);
    rt.rendered = { ownerId: A, lineage: await sessionLineageId(session.access_token) };
    browser.state.session = session;
    wire = [];
    respond = async () => json({ error: "Analysis is temporarily unavailable. Please try again shortly." }, 503);
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      wire.push({
        url,
        method: init?.method ?? null,
        authorization: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials ?? null,
        body: typeof init?.body === "string" ? init.body : null,
      });
      return respond();
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("every stored status opens with ZERO requests — also after time passes, a re-render and a remount", async () => {
    const cases: [string, AnalysisData, Record<string, unknown>][] = [
      ["pending", base("pending"), {}],
      ["processing", base("processing"), {}],
      ["failed", base("failed"), {}],
      ["failed (video unusable)", base("failed"), { failedReason: VIDEO_UNUSABLE_STATUS }],
      ["complete", { ...base("complete"), score: 70, feedback: "Synthetic 09 stored report" }, {}],
      ["an unknown status", base("queued"), {}],
    ];
    for (const [name, analysis, extra] of cases) {
      let page = await open(analysis, extra);
      await vi.advanceTimersByTimeAsync(120_000);
      await settle(page);
      page.render();
      await settle(page);
      page.unmount();
      page = await open(analysis, extra); // opened again (back navigation / a remount)
      await vi.advanceTimersByTimeAsync(120_000);
      await settle(page);
      expect(wire, name).toEqual([]);
      expect(page.text(), name).not.toMatch(INVENTED_PROGRESS);
      page.unmount();
    }
  });

  it("a stored 'processing' row shows its saved status and no invented progress; 'Check status' is a page reload and sends nothing", async () => {
    const page = await open(base("processing"));
    expect(page.pill()).toBe("processing");
    expect(page.text()).toContain("Analysis not finished");
    expect(page.text()).toContain("no result has been saved yet");
    expect(page.text()).toContain("may have stopped and need recovery");
    expect(page.text()).not.toMatch(INVENTED_PROGRESS);
    expect(page.buttons()).toEqual(["Check status"]); // no analysis action for a row that may still be held
    expect(await pressCheck(page)).toBe(1);
    expect(await pressCheck(page)).toBe(1); // each check is one fresh read (one reload per press); none sends work
    expect(wire).toEqual([]);
  });

  it("a pending swing offers one explicit action; one press sends exactly ONE request, as the rendered owner (confirmed Bearer, no cookie)", async () => {
    const analysis = base("pending");
    respond = async () => json(completion(analysis, "Synthetic 09 analysed now"));
    const page = await open(analysis);
    expect(page.text()).toContain("Not analyzed yet");
    expect(page.buttons()).toEqual(["Analyze swing"]);
    press(page, "Analyze swing");
    await settle(page);
    expect(analysisRequests()).toEqual([{
      url: "/api/analyze-swing", method: "POST", authorization: `Bearer ${session.access_token}`, credentials: "omit", body: JSON.stringify({ analysisId: analysis.id }),
    }]);
    expect(page.pill()).toBe("complete");
    expect(page.text()).toContain("Synthetic 09 analysed now");
    expect(page.buttons().filter((b) => /Analyze|Retry/.test(b))).toEqual([]); // a completed report offers no re-run
  });

  it("a double press, a re-render and a remount while the request is out send no second request; the guard is released when it settles", async () => {
    const analysis = base("pending");
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const page = await open(analysis);
    const click = page.button("Analyze swing")!.props.onClick as () => void;
    click();
    click(); // the same tick: the second activation is refused before anything is awaited
    page.render();
    await settle(page);
    expect(analysisRequests()).toHaveLength(1);
    click(); // a stale handle of the button, pressed again while the request is out
    page.render();
    await settle(page);
    expect(analysisRequests()).toHaveLength(1);
    expect(page.text()).toContain("Starting Your Analysis"); // 09-P1-A1: phase-neutral waiting heading
    expect(page.text()).toContain("We're confirming your sign-in and starting this swing's analysis.");
    expect(page.text()).not.toMatch(INVENTED_PROGRESS);
    expect(page.buttons()).toEqual([]);
    // the report left and opened again (a remount) while the request is still out: this view sends nothing either
    page.unmount();
    const again = await open(analysis);
    expect(again.text()).toContain("Earlier request not finished");
    expect(again.button("Analyze swing")).toBeNull();
    expect(again.buttons()).toEqual(["Check status"]);
    expect(await pressCheck(again)).toBe(1);
    expect(analysisRequests()).toHaveLength(1);
    // the first request settles (its view is gone: nothing of it is shown); the guard is released
    gate.resolve(json(completion(analysis, "LATE-NOT-SHOWN")));
    await settle(again);
    again.unmount();
    const later = await open(analysis);
    expect(later.text()).not.toContain("LATE-NOT-SHOWN");
    expect(later.button("Analyze swing")).not.toBeNull(); // a fresh view of a still-pending swing may be analysed deliberately
    expect(analysisRequests()).toHaveLength(1);
  });

  it("review: another account's sign-in event while the pending view is idle — the press sends nothing, says why, and the guard is released (a later view offers the action again)", async () => {
    const analysis = base("pending");
    const page = await open(analysis);
    browser.emit("SIGNED_IN", sessionOf(randomUUID())); // another account signed in (here or in another tab)
    await settle(page);
    press(page, "Analyze swing");
    await settle(page);
    expect(wire).toEqual([]);
    expect(page.text()).toContain("This browser is now signed in to a different account, so this analysis wasn't started.");
    expect(page.text()).not.toContain("Starting Your Analysis");
    page.unmount();
    const later = await open(analysis);
    expect(later.text()).not.toContain("Earlier request not finished");
    expect(later.button("Analyze swing")).not.toBeNull();
    expect(wire).toEqual([]);
  });

  it("09-P1-A1: while the sign-in check is held after an explicit press, the heading and description describe the wait and nothing is sent; releasing a valid check sends exactly one request", async () => {
    const analysis = base("pending");
    respond = async () => json(completion(analysis, "Synthetic A1 completion"));
    const read = deferred<{ data: { session: Session | null }; error: null }>();
    (browser.client.auth as { getSession: () => Promise<unknown> }).getSession = () => read.promise;
    const page = await open(analysis);
    press(page, "Analyze swing");
    await settle(page);
    await vi.advanceTimersByTimeAsync(5_000); // the check stays unresolved (well inside its 12 s deadline)
    await settle(page);
    expect(page.text()).toContain("Starting Your Analysis");
    expect(page.text()).toContain("We're confirming your sign-in and starting this swing's analysis.");
    expect(page.text()).not.toMatch(/was sent|Analysing Your Swing|AI Coach Active/);
    expect(analysisRequests()).toHaveLength(0);
    expect(page.buttons()).toEqual([]); // nothing to press again while it waits
    read.resolve({ data: { session }, error: null });
    await settle(page);
    expect(analysisRequests()).toHaveLength(1);
    expect(analysisRequests()[0].authorization).toBe(`Bearer ${session.access_token}`);
    expect(page.pill()).toBe("complete");
    expect(page.text()).toContain("Synthetic A1 completion");
  });

  it("review: the view is left while the owner check is still out, and opened again — the new view sends nothing and offers a status read; once the check settles nothing was sent and the guard is released", async () => {
    const analysis = base("pending");
    const read = deferred<{ data: { session: Session | null }; error: null }>();
    (browser.client.auth as { getSession: () => Promise<unknown> }).getSession = () => read.promise;
    const page = await open(analysis);
    press(page, "Analyze swing");
    await settle(page);
    expect(page.text()).toContain("Starting Your Analysis"); // no claim that anything was sent
    expect(page.text()).toContain("We're confirming your sign-in");
    page.unmount();
    const again = await open(analysis);
    expect(again.text()).toContain("Earlier request not finished");
    expect(again.buttons()).toEqual(["Check status"]);
    read.resolve({ data: { session }, error: null });
    await settle(again);
    expect(wire).toEqual([]); // the left view's press never reached the network
    again.unmount();
    const later = await open(analysis);
    expect(later.button("Analyze swing")).not.toBeNull();
    expect(wire).toEqual([]);
  });

  it("a stored failure offers a clearly named 'Retry analysis': one press, one request; a double press sends one", async () => {
    const analysis = base("failed");
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const page = await open(analysis);
    expect(page.pill()).toBe("failed");
    expect(page.text()).toContain("Analysis Failed");
    expect(page.buttons()).toEqual(["Retry analysis"]);
    const click = page.button("Retry analysis")!.props.onClick as () => void;
    click();
    click();
    page.render();
    await settle(page);
    expect(analysisRequests()).toHaveLength(1);
    gate.resolve(json(completion(analysis, "Synthetic 09 retried")));
    await settle(page);
    expect(page.pill()).toBe("complete");
    expect(page.text()).toContain("Synthetic 09 retried");
    expect(analysisRequests()).toHaveLength(1);
  });

  it("an uncertain outcome offers a fresh status read before any new attempt; a certain refusal keeps one deliberate Retry", async () => {
    const uncertain: [string, () => Promise<Response>][] = [
      ["503", async () => json({ error: "Analysis is temporarily unavailable. Please try again shortly." }, 503)],
      ["unreachable", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["unreadable", async () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } })],
      ["500", async () => json({ error: "Analysis failed. Please try again." }, 500)],
      ["404", async () => json({ error: "Analysis record not found." }, 404)],
      ["409 not startable", async () => json({ error: "This analysis can't be started right now. Please refresh and try again." }, 409)],
      ["409 processing", async () => json({ error: "This analysis is already in progress. Please check back shortly.", status: "processing" }, 409)],
      ["2xx not a completion", async () => json({ message: "Analysis complete", data: null })],
    ];
    for (const [name, answer] of uncertain) {
      wire = [];
      respond = answer;
      const page = await open(base("pending"));
      press(page, "Analyze swing");
      await settle(page);
      expect(analysisRequests(), name).toHaveLength(1);
      expect(page.button("Retry"), name).toBeNull();
      expect(page.button("Analyze swing"), name).toBeNull();
      const check = page.button("Check status") ? "Check status" : "Check again";
      expect(await pressCheck(page, check), name).toBe(1);
      expect(analysisRequests(), name).toHaveLength(1);
      page.unmount();
    }
    for (const [name, answer] of [
      ["401", async () => json({ error: "Unauthorized" }, 401)],
      ["403", async () => json({ error: "Putting analysis isn't included with your current plan." }, 403)],
    ] as const) {
      wire = [];
      respond = answer;
      const page = await open(base("pending"));
      press(page, "Analyze swing");
      await settle(page);
      expect(page.button("Check status"), name).toBeNull();
      respond = async () => json({ error: "Analysis is temporarily unavailable. Please try again shortly." }, 503);
      press(page, "Retry");
      await settle(page);
      expect(analysisRequests(), name).toHaveLength(2); // exactly one more per deliberate press
      page.unmount();
    }
  });

  it("completed, unusable-video and stalled cases offer no action that sends work", async () => {
    let page = await open({ ...base("complete"), score: 66, feedback: "Synthetic 09 complete" });
    expect(page.buttons().filter((b) => /Analyze|Retry|Check/.test(b))).toEqual([]);
    page.unmount();
    page = await open(base("failed"), { failedReason: VIDEO_UNUSABLE_STATUS });
    expect(page.text()).toContain(VIDEO_UNUSABLE_COPY);
    expect(page.buttons()).toEqual([]);
    expect(page.link("Upload a new video")!.props.href).toBe("/analyze");
    page.unmount();
    respond = async () => json({ error: "This analysis was interrupted after it started and can't be finished.", status: "stalled" }, 409);
    page = await open(base("pending"));
    press(page, "Analyze swing");
    await settle(page);
    expect(page.pill()).toBe("interrupted");
    expect(page.buttons()).toEqual([]);
    expect(page.link("Record a new swing")!.props.href).toBe("/analyze");
    expect(analysisRequests()).toHaveLength(1);
    page.unmount();
    respond = async () => json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, 422);
    page = await open(base("pending"));
    press(page, "Analyze swing");
    await settle(page);
    expect(page.pill()).toBe("failed");
    expect(page.buttons()).toEqual([]);
    expect(page.link("Upload a new video")).not.toBeNull();
  });

  it("server render of every passive state: labelled controls with a 44x44 px minimum, a visible focus outline and type=button; decorative icons hidden", () => {
    const states: [string, AnalysisData, Record<string, unknown>, string[]][] = [
      ["pending", base("pending"), {}, ["Analyze swing"]],
      ["processing", base("processing"), {}, ["Check status"]],
      ["failed", base("failed"), {}, ["Retry analysis"]],
      ["unknown status", base("queued"), {}, ["Check status"]],
      ["unusable", base("failed"), { failedReason: VIDEO_UNUSABLE_STATUS }, ["Upload a new video"]],
    ];
    for (const [name, analysis, extra, labels] of states) {
      rt.slots = [];
      rt.pending = [];
      rt.i = 0;
      const html = renderToStaticMarkup(React.createElement(AnalysisReport as unknown as React.ComponentType<Record<string, unknown>>, { analysis, videoSignedUrl: null, clubDisplayName: null, ...extra }));
      const controls = Array.from(html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)).filter(([, , attrs]) => !/aria-label="(Play|Pause)"/.test(attrs));
      expect(controls.map(([, , , inner]) => inner.replace(/<[^>]+>/g, "").trim()), name).toEqual(labels);
      for (const [, tag, attrs] of controls) {
        expect(attrs, name).toMatch(/min-h-11/);
        expect(attrs, name).toMatch(/min-w-11/);
        expect(attrs, name).toMatch(/focus-visible:outline-2/);
        expect(attrs, name).toMatch(/focus-visible:outline-(golf-green|white)/);
        if (tag === "button") expect(attrs, name).toContain('type="button"');
      }
      expect(wire, name).toEqual([]);
    }
  });
});
