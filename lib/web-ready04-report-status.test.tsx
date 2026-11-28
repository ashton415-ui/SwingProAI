import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { randomUUID, createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-WEB-READY-04 F1-R — the analysis report keeps the analysis's STORED status apart from what its latest request ended
 * with (app/(dashboard)/analyze/[id]/AnalysisReport.tsx).
 *
 * The real report component is driven through its real effects: React's hooks are replaced by the small synchronous
 * runtime used by lib/analyze-swing-auth-ingress.test.ts (the whole tree is expanded on each pass), the shared browser
 * client is a stand-in whose session reads the test controls, and every request the report sends goes to a recording
 * fetch whose answer each case chooses. lib/drill-hub-session.ts confirmOwnerSession / ownerBearer are the real modules.
 * Synthetic identities only; nothing leaves the process.
 *
 * Matrix: pending + the route's missing-provider-key 503; pending + Auth-unavailable 503; a rejected fetch; an answer that
 * is not JSON; a refused request (401); a 500 attempt; a genuine stored failure (server-rendered); video unusable
 * (server-rendered, and answered 422); 409 processing; 409 stalled; completed data; identity refusal (nothing sent); a
 * late answer after the report was left. For each: the status pill, the heading/copy, the recovery action, and the
 * exact number of requests (no new request, write, dispatch or retry beyond the golfer's own press).
 *
 * AG-WEB-READY-09-P1: opening the report no longer sends anything. Each case that exercises a request's outcome opens the
 * pending report, checks that nothing was sent, and presses the explicit "Analyze swing" action once (analyzed()); the
 * outcome, pill and identity assertions are unchanged. After an outcome that may have changed the saved status (a 503,
 * an unreachable server, an unreadable or malformed answer, a readable 500/400, 404, 409) the recovery is now "Check
 * status" — a fresh read of the saved status (a page reload; no request) — instead of an immediate Retry; a Retry stays
 * where nothing was analyzed (identity refusal, 401, an outright refusal such as 403) and on a stored failure.
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
const B = randomUUID();
const ANALYSIS_ID = randomUUID();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, sid = `sid-${randomUUID()}`) => `${b64({ alg: "none" })}.${b64({ sub, session_id: sid, exp: 4_000_000_000 })}.synthetic-${randomUUID()}`;
function sessionOf(user: string) {
  return { access_token: jwt(user), refresh_token: `rt-${randomUUID()}`, expires_at: 4_000_000_000, expires_in: 3600, token_type: "bearer", user: { id: user } };
}
type Session = ReturnType<typeof sessionOf>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ─── tree expansion and the hook runtime's mount (as lib/analyze-swing-auth-ingress.test.ts) ─────────────────────────
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
    /**
     * F1-A1 R2: the report's current tree rendered by the real react-dom/server (the same hook state, in the same order as
     * the expander uses), so an object rendered as a React child throws here exactly as it would on the page.
     */
    markup: () => {
      const pending = rt.pending.length;
      rt.i = 0;
      try {
        return renderToStaticMarkup(Component(props) as React.ReactElement);
      } finally {
        rt.pending.splice(pending); // a snapshot render schedules nothing
      }
    },
    /** the status pill: the span right after the "Status" label */
    /** F1-A1: the label above the status pill ("Status", or "Last known status") */
    statusLabel: () => {
      const label = findAll(nodes, (n) => n.type === "p" && /^(Status|Last known status)$/.test(textOf(n.children)))[0];
      return label ? textOf(label.children) : null;
    },
    pill: () => {
      const spans = findAll(nodes, (n) => n.type === "span" && typeof n.props.className === "string" && (n.props.className as string).includes("rounded-full border"));
      return spans.length ? textOf(spans[0].children) : null;
    },
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
  const client = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: state.session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  };
  return { client, state };
}
let browser: ReturnType<typeof managed>;
let wire: { url: string; authorization: string | null; method: string | null }[] = [];
let respond: () => Promise<Response>;
const reportCalls = () => wire.filter((r) => r.url === "/api/analyze-swing");

const PENDING: AnalysisData = { id: ANALYSIS_ID, status: "pending", score: null, feedback: null, swing_highlights: null, mechanical_deficiencies: null, metrics: null, swing_video: null };
const FAILED: AnalysisData = { ...PENDING, status: "failed" };
const MISSING_KEY_503 = "AI analysis is temporarily unavailable. Please try again later.";
// the route's own copies (app/api/analyze-swing/route.ts: AUTH_UNAVAILABLE_COPY; the missing-key and pipeline answers)
const AUTH_503 = "We couldn't confirm your sign-in just now, so nothing was analyzed. Please try again shortly.";
const ROUTE_500 = "Analysis failed. Please try again.";
const SAVE_400 = "We couldn't save your analysis. Please try again.";
const COPY = {
  // 09-P1: the copy names the way forward the page now offers after these outcomes (a status read, not a resend)
  network: "We couldn't reach SwingProAI. Check your connection, then check this swing's status before trying again.",
  unknown: "We couldn't confirm what happened with this request. Your swing is saved. Check its current status before trying again.",
  attempt: "This attempt didn't complete, so its result isn't confirmed. Your swing is saved. Check this analysis's current status before trying again.",
  signin: "We couldn't confirm your sign-in for this request, so nothing was analyzed. Sign in again, then retry.",
  changed: "This browser is now signed in to a different account, so this analysis wasn't started. Refresh the page to continue with the account that's signed in now.",
};

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

async function open(analysis: AnalysisData, extra: Record<string, unknown> = {}) {
  const a = sessionOf(A);
  rt.rendered = { ownerId: A, lineage: await sessionLineageId(a.access_token) };
  browser.state.session = a;
  const page = mount(AnalysisReport as unknown as (p: unknown) => unknown, { analysis, videoSignedUrl: null, clubDisplayName: "Synthetic 7i", ...extra });
  await settle(page);
  return page;
}

/** 09-P1: one press of a labelled button, as the golfer's click (then the render it causes). */
function press(page: Mounted, label: string) {
  const button = page.button(label);
  expect(button, label).not.toBeNull();
  (button!.props.onClick as () => void)();
  page.render();
}

/** 09-P1: opening the report sends nothing; the golfer's one "Analyze swing" press sends the request. */
async function analyzed(analysis: AnalysisData, extra: Record<string, unknown> = {}) {
  const sentBefore = reportCalls().length;
  const page = await open(analysis, extra);
  expect(reportCalls(), "opening the report sends nothing").toHaveLength(sentBefore);
  press(page, "Analyze swing");
  await settle(page);
  return page;
}

/** 09-P1: "Check status" / "Check again" is a reload of the page (its own server read); returns the reloads it caused. */
async function pressCheck(page: Mounted, label = "Check status") {
  let reloads = 0;
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const previous = g.window;
  g.window = { location: { reload: () => { reloads += 1; } } }; // only for the click itself (the reload is synchronous)
  try {
    press(page, label);
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
  await settle(page);
  return reloads;
}

describe("F1-R: the status pill shows what the page knows about the saved status; a request's outcome is shown separately", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installMicrotaskDigest();
    browser = managed();
    rt.client = browser.client;
    rt.rendered = null;
    wire = [];
    respond = async () => json({ error: MISSING_KEY_503 }, 503);
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      wire.push({ url, authorization: new Headers(init?.headers).get("authorization"), method: init?.method ?? null });
      return respond();
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pending + the route's missing-provider-key 503: the pill stays 'pending', the panel says the analysis is unavailable (not 'Analysis Failed'), one request, a status read (not a Retry) offered", async () => {
    const page = await analyzed(PENDING);
    expect(reportCalls()).toHaveLength(1);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Analysis unavailable right now");
    expect(page.text()).toContain(MISSING_KEY_503);
    expect(page.text()).not.toContain("Analysis Failed");
    // 09-P1: a 503 may follow a recorded change, so a fresh status read comes before any new attempt
    expect(page.button("Retry")).toBeNull();
    expect(page.button("Check status")).not.toBeNull();
    // no follow-up request of its own: only the golfer's press sends again
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(page);
    expect(reportCalls()).toHaveLength(1);
    expect(await pressCheck(page)).toBe(1); // a reload (the page's own server read) ...
    expect(reportCalls()).toHaveLength(1); // ... and no analysis request
  });

  it("pending + an Auth-unavailable 503: same honest unavailable presentation; the status is not changed", async () => {
    respond = async () => json({ error: AUTH_503 }, 503);
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Analysis unavailable right now");
    expect(page.text()).toContain(AUTH_503);
    expect(page.text()).not.toContain("Analysis Failed");
  });

  it("a rejected fetch (no answer): 'Couldn't reach SwingProAI', fixed copy, pill unchanged, a status read offered", async () => {
    respond = () => Promise.reject(new TypeError("Failed to fetch synthetic-internal"));
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Couldn't reach SwingProAI");
    expect(page.text()).toContain(COPY.network);
    expect(page.text()).not.toMatch(/synthetic-internal|TypeError|Analysis Failed/);
    // 09-P1: the request may have arrived: a status read first, never an immediate resend
    expect(page.button("Retry")).toBeNull();
    expect(page.button("Check status")).not.toBeNull();
  });

  it("an answer that is not the route's JSON (a gateway page; JSON null): outcome unknown, a status read offered, pill unchanged", async () => {
    respond = async () => new Response("<html>504 Gateway Timeout</html>", { status: 504, headers: { "content-type": "text/html" } });
    let page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Result not confirmed");
    expect(page.text()).toContain(COPY.unknown);
    expect(page.text()).not.toMatch(/Gateway|Analysis Failed/);
    // 09-P1: the outcome is unknown, so the action offered is a fresh read of the saved status (no resend)
    expect(page.button("Retry")).toBeNull();
    expect(page.button("Check status")).not.toBeNull();
    expect(page.button("Check again")).toBeNull();
    page.unmount();
    respond = async () => json(null, 200);
    page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Result not confirmed");
    expect(page.text()).not.toContain("Couldn't reach SwingProAI");
    page.unmount();
    // an error that is not text is not shown (and cannot break the page)
    respond = async () => json({ error: { message: "SYNTHETIC-OBJECT-ERROR" } }, 400);
    page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Result not confirmed");
    expect(page.text()).not.toContain("SYNTHETIC-OBJECT-ERROR");
  });

  it("401: fixed sign-in-again copy with Retry and a Sign in link; the pill keeps 'pending' (nothing was analyzed)", async () => {
    respond = async () => json({ error: "Unauthorized" }, 401);
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Sign-in not confirmed");
    expect(page.text()).toContain(COPY.signin);
    expect(page.text()).not.toContain("Unauthorized");
    expect(page.button("Retry")).not.toBeNull();
    expect(page.link("Sign in")!.props.href).toBe("/login");
  });

  it("a readable 500 or this page's 400 (the route answers them after an attempt that may have recorded a failure): the status is shown as UNCONFIRMED — neither 'pending' nor an invented 'failed'", async () => {
    for (const [status, body] of [[500, ROUTE_500], [400, SAVE_400]] as const) {
      wire = [];
      respond = async () => json({ error: body }, status);
      const page = await analyzed(PENDING);
      expect(reportCalls()).toHaveLength(1);
      expect(page.pill()).toBe("unconfirmed");
      expect(page.text()).toContain("This attempt didn't complete");
      expect(page.text()).toContain(COPY.attempt);
      expect(page.text()).not.toContain("Analysis Failed");
      // 09-P1: a failure may have been recorded: a status read first (a recorded failure then offers its own Retry)
      expect(page.button("Retry")).toBeNull();
      expect(page.button("Check status")).not.toBeNull();
      page.unmount();
    }
  });

  it("refusals that change nothing (403, 404, 409 not startable) keep the stored status and show the route's own copy", async () => {
    for (const [status, body] of [[403, "Putting analysis isn't included with your current plan."], [404, "Analysis record not found."], [409, "This analysis can't be started right now. Please refresh and try again."]] as const) {
      respond = async () => json({ error: body }, status);
      const page = await analyzed(PENDING);
      expect(page.pill()).toBe("pending");
      expect(page.text()).toContain("Request not accepted");
      expect(page.text()).toContain(body);
      page.unmount();
    }
  });

  it("09-P1: an unconfirmed status stays until a fresh read: no in-view resend is offered; 'Check status' reloads and sends nothing", async () => {
    respond = async () => json({ error: ROUTE_500 }, 500);
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("unconfirmed");
    expect(page.button("Retry")).toBeNull();
    expect(await pressCheck(page)).toBe(1);
    expect(reportCalls()).toHaveLength(1);
    expect(page.pill()).toBe("unconfirmed"); // nothing in this view claims otherwise; the reload's read decides
  });

  it("Retry is the golfer's press: after an outright refusal, exactly one more request per press, and a later healthy answer completes the report", async () => {
    respond = async () => json({ error: "Putting analysis isn't included with your current plan." }, 403);
    const page = await analyzed(PENDING);
    expect(reportCalls()).toHaveLength(1);
    respond = async () => json({ message: "Analysis complete", data: { ...PENDING, status: "complete", score: 81, feedback: "Synthetic F1 feedback", swing_highlights: [], mechanical_deficiencies: [], metrics: {} } });
    press(page, "Retry");
    await settle(page);
    expect(reportCalls()).toHaveLength(2);
    expect(page.pill()).toBe("complete");
    expect(page.text()).toContain("Synthetic F1 feedback");
  });

  it("a genuine stored failure (server-rendered 'failed'): pill 'failed', 'Analysis Failed' and Retry — unchanged; nothing is sent on its own", async () => {
    const page = await open(FAILED);
    expect(reportCalls()).toHaveLength(0);
    expect(page.pill()).toBe("failed");
    expect(page.text()).toContain("Analysis Failed");
    expect(page.button("Retry")).not.toBeNull();
  });

  it("video unusable: server-rendered (failed + reason) and answered 422 — pill 'failed', 'Analysis Failed', upload-again link, no Retry", async () => {
    let page = await open(FAILED, { failedReason: VIDEO_UNUSABLE_STATUS });
    expect(reportCalls()).toHaveLength(0);
    expect(page.pill()).toBe("failed");
    expect(page.text()).toContain(VIDEO_UNUSABLE_COPY);
    expect(page.link("Upload a new video")).not.toBeNull();
    page.unmount();
    respond = async () => json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, 422);
    page = await analyzed(PENDING);
    expect(reportCalls()).toHaveLength(1);
    expect(page.pill()).toBe("failed"); // the server reported the stored analysis failed
    expect(page.text()).toContain("Analysis Failed");
    expect(page.link("Upload a new video")).not.toBeNull();
    expect(page.button("Retry")).toBeNull();
  });

  it("409 processing and 409 stalled keep their own states", async () => {
    respond = async () => json({ error: "This analysis is already in progress.", status: "processing" }, 409);
    let page = await analyzed(PENDING);
    expect(page.text()).toContain("Still Analysing");
    expect(page.pill()).toBe("pending");
    expect(page.button("Check again")).not.toBeNull();
    // 09-P1: "Check again" reads the saved status (a reload); it never sends another analysis request
    expect(await pressCheck(page, "Check again")).toBe(1);
    expect(reportCalls()).toHaveLength(1);
    page.unmount();
    respond = async () => json({ error: "This analysis was interrupted and can't be finished.", status: "stalled" }, 409);
    page = await analyzed(PENDING);
    expect(page.text()).toContain("Analysis Interrupted");
    expect(page.pill()).toBe("interrupted");
  });

  it("identity refusal (the browser holds another account): nothing is sent, the heading says the sign-in was not confirmed, the pill stays 'pending'", async () => {
    const a = sessionOf(A);
    rt.rendered = { ownerId: A, lineage: await sessionLineageId(a.access_token) };
    browser.state.session = sessionOf(B);
    const page = mount(AnalysisReport as unknown as (p: unknown) => unknown, { analysis: PENDING, videoSignedUrl: null, clubDisplayName: null });
    await settle(page);
    expect(wire).toEqual([]); // 09-P1: opening sends nothing ...
    press(page, "Analyze swing"); // ... and the golfer's press is refused before anything is sent
    await settle(page);
    expect(wire).toEqual([]);
    expect(page.pill()).toBe("pending");
    expect(page.text()).toContain("Sign-in not confirmed");
    expect(page.text()).toContain(COPY.changed);
    expect(page.text()).not.toContain("Analysis Failed");
  });

  it("a late answer after the report was left changes nothing: no state is set at all", async () => {
    for (const late of [
      json({ message: "Analysis complete", data: { ...PENDING, status: "complete", feedback: "LATE-SHOULD-NOT-SHOW" } }),
      json({ error: ROUTE_500 }, 500),
      json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, 422),
    ]) {
      let release!: (r: Response) => void;
      respond = () => new Promise<Response>((r) => { release = r; });
      wire = [];
      const page = await analyzed(PENDING);
      expect(reportCalls()).toHaveLength(1);
      page.unmount();
      rt.dirty = false;
      release(late);
      for (let k = 0; k < 60; k++) await new Promise<void>((resolve) => setImmediate(resolve));
      // a state setter that ran after the unmount would have marked the runtime dirty
      expect(rt.dirty).toBe(false);
      expect(reportCalls()).toHaveLength(1);
    }
  });

  // ─── F1-A1 (R1): what the page knows after an ambiguous answer is shown as such ───────────────────────────────────
  const LAST_KNOWN = "Last known status";
  const NOTE = "Not confirmed since this request. Check status to read it."; // 09-P1: the note names the action offered
  // the route's generic full-swing 503, sent both before a claim and after an undispatched claim was released as failed
  // (dispatchRefused and videoLoadRefused); the page cannot tell them apart and must not try
  const FULL_SWING_503 = "Analysis is temporarily unavailable. Please try again shortly.";
  const VALID = (feedback: string) => ({ message: "Analysis complete", data: { ...PENDING, status: "complete", score: 81, feedback, swing_highlights: [], mechanical_deficiencies: [], metrics: {} } });

  it("[A1-R1] every ambiguous 503 (missing key, Auth unavailable, post-claim dispatch refused, post-claim video load refused) keeps 'pending' visibly labelled as the last known status, with the not-confirmed note; one request, no follow-up", async () => {
    for (const [name, body] of [["missing key", MISSING_KEY_503], ["auth unavailable", AUTH_503], ["post-claim dispatch refused", FULL_SWING_503], ["post-claim video load refused", FULL_SWING_503]] as const) {
      wire = [];
      respond = async () => json({ error: body }, 503);
      const page = await analyzed(PENDING);
      expect(page.pill(), name).toBe("pending");
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      expect(page.text(), name).toContain(NOTE);
      expect(page.text(), name).toContain("Analysis unavailable right now");
      expect(page.text(), name).not.toContain("Analysis Failed");
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(page);
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
    }
  });

  it("[A1-R1] an unreachable server or an unreadable answer: last known status, labelled; never 'failed'", async () => {
    for (const make of [
      () => Promise.reject(new TypeError("Failed to fetch synthetic")),
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    ]) {
      respond = make;
      const page = await analyzed(PENDING);
      expect(page.pill()).toBe("pending");
      expect(page.statusLabel()).toBe(LAST_KNOWN);
      expect(page.text()).toContain(NOTE);
      page.unmount();
    }
  });

  it("[A1-R1] refusals that say nothing about the saved analysis (401, 403) keep the plain 'Status' label", async () => {
    for (const [status, body] of [[401, "Unauthorized"], [403, "Putting analysis isn't included with your current plan."]] as const) {
      respond = async () => json({ error: body }, status);
      const page = await analyzed(PENDING);
      expect(page.statusLabel(), String(status)).toBe("Status");
      expect(page.text(), String(status)).not.toContain(NOTE);
      expect(page.pill(), String(status)).toBe("pending");
      page.unmount();
    }
  });

  it("[A1-R1] answers showing the page's status may be out of date (not found, not startable, already processing) keep it as the last known status", async () => {
    for (const [status, body] of [
      [404, { error: "Analysis record not found." }],
      [409, { error: "This analysis can't be started right now. Please refresh and try again." }],
      [409, { error: "This analysis is already in progress. Please check back shortly.", status: "processing" }],
    ] as const) {
      respond = async () => json(body, status);
      const page = await analyzed(PENDING);
      const name = `${status} ${JSON.stringify(body).slice(0, 40)}`;
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      expect(page.text(), name).toContain(NOTE);
      expect(page.pill(), name).toBe("pending");
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
      wire = [];
    }
  });

  it("[A1-R1] a server-rendered failed analysis, retried, answered 503: 'failed' stays, labelled as the last known status", async () => {
    respond = async () => json({ error: FULL_SWING_503 }, 503);
    const page = await open(FAILED);
    expect(reportCalls()).toHaveLength(0);
    (page.button("Retry")!.props.onClick as () => void)();
    page.render();
    await settle(page);
    expect(reportCalls()).toHaveLength(1);
    expect(page.pill()).toBe("failed");
    expect(page.statusLabel()).toBe(LAST_KNOWN);
    expect(page.text()).toContain(NOTE);
  });

  it("[A1-R1] a readable 500/400 stays 'unconfirmed' (09-P1: no in-view resend can weaken it — the way forward is a status read); completed data from a later press shows the plain status", async () => {
    for (const [status, body] of [[500, ROUTE_500], [400, SAVE_400]] as const) {
      wire = [];
      respond = async () => json({ error: body }, status);
      const page = await analyzed(PENDING);
      expect(page.pill()).toBe("unconfirmed");
      expect(page.statusLabel()).toBe("Status");
      expect(page.button("Retry")).toBeNull();
      expect(page.button("Analyze swing")).toBeNull();
      expect(await pressCheck(page)).toBe(1);
      expect(reportCalls()).toHaveLength(1);
      expect(page.pill()).toBe("unconfirmed");
      page.unmount();
    }
    // a press that may resend (after an outright refusal) and is answered with completed data: the plain status, no note
    wire = [];
    respond = async () => json({ error: "Putting analysis isn't included with your current plan." }, 403);
    const page = await analyzed(PENDING);
    respond = async () => json(VALID("A1 synthetic completed feedback"));
    press(page, "Retry");
    await settle(page);
    expect(reportCalls()).toHaveLength(2);
    expect(page.pill()).toBe("complete");
    expect(page.statusLabel()).toBe("Status");
    expect(page.text()).not.toContain(NOTE);
    expect(page.text()).toContain("A1 synthetic completed feedback");
  });

  // ─── F1-A1 (R2): only the completed analysis this page asked about replaces it ────────────────────────────────────
  it("[A1-R2] a 2xx that is not a valid completion of THIS analysis replaces nothing: no crash, no score or status invented, 'Result not confirmed', last known status, a status read (09-P1); one request", async () => {
    const OTHER = randomUUID();
    const cases: [string, unknown][] = [
      ["empty object", {}],
      ["empty error", { error: "" }],
      ["non-text error", { error: { message: "MALFORMED-MARKER" } }],
      ["missing data", { message: "Analysis complete" }],
      ["null data", { message: "Analysis complete", data: null }],
      ["array data", { message: "Analysis complete", data: [] }],
      ["text data", { message: "Analysis complete", data: "MALFORMED-MARKER" }],
      ["another analysis", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, id: OTHER } }],
      ["not complete", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, status: "pending" } }],
      ["failed data", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, status: "failed" } }],
      ["highlights not a list", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, swing_highlights: "MALFORMED-MARKER" } }],
      ["a null highlight", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, swing_highlights: [null] } }],
      ["metrics a list", { message: "Analysis complete", data: { ...VALID("MALFORMED-MARKER").data, metrics: [] } }],
      ["feedback not text", { message: "Analysis complete", data: { ...VALID("x").data, feedback: { text: "MALFORMED-MARKER" } } }],
      ["a highlight's text not text", { message: "Analysis complete", data: { ...VALID("x").data, swing_highlights: [{ checkpoint: null, positive_movement: { t: "MALFORMED-MARKER" }, mechanical_benefit: "b" }] } }],
      ["a deficiency's text not text", { message: "Analysis complete", data: { ...VALID("x").data, mechanical_deficiencies: [{ checkpoint: null, joint_coordinate: null, fault_description: ["MALFORMED-MARKER"], severity: null, corrective_drill_title: "t", corrective_drill_detail: null }] } }],
      ["a metrics text not text", { message: "Analysis complete", data: { ...VALID("x").data, metrics: { pro_cue: { t: "MALFORMED-MARKER" } } } }],
      ["a pillar's text not text", { message: "Analysis complete", data: { ...VALID("x").data, metrics: { posture: { rating: "Good", observation: 7, correction: "c" } } } }],
    ];
    for (const [name, body] of cases) {
      wire = [];
      respond = async () => json(body, 200);
      const page = await analyzed(PENDING);
      expect(page.pill(), name).toBe("pending");
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      expect(page.text(), name).toContain("Result not confirmed");
      expect(page.text(), name).toContain(COPY.unknown);
      expect(page.text(), name).not.toMatch(/MALFORMED-MARKER|AI COACHING|Analysis Failed/i);
      expect(page.button("Check status"), name).not.toBeNull(); // 09-P1: a status read, not a resend
      expect(page.button("Retry"), name).toBeNull();
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
    }
  });

  it("[A1-R2] an error status is never a completion, even when its body looks like one; empty errors show fixed copy, never blank text", async () => {
    const cases: [number, unknown, string, string, RegExp][] = [
      [500, VALID("MALFORMED-MARKER"), "unconfirmed", "Status", /This attempt didn't complete/],
      [503, VALID("MALFORMED-MARKER"), "pending", LAST_KNOWN, /Analysis unavailable right now/],
      [404, VALID("MALFORMED-MARKER"), "pending", LAST_KNOWN, /Request not accepted/],
      [500, { error: "" }, "unconfirmed", "Status", /This attempt didn't complete/],
      [503, { error: "" }, "pending", LAST_KNOWN, /Analysis is temporarily unavailable\. Please try again shortly\./],
      [403, {}, "pending", "Status", /This request wasn't accepted\. Your swing is saved\./],
    ];
    for (const [status, body, pill, label, shown] of cases) {
      respond = async () => json(body, status);
      const page = await analyzed(PENDING);
      const name = `${status} ${JSON.stringify(body).slice(0, 30)}`;
      expect(page.pill(), name).toBe(pill);
      expect(page.statusLabel(), name).toBe(label);
      expect(page.text(), name).toMatch(shown);
      expect(page.text(), name).not.toMatch(/MALFORMED-MARKER|AI COACHING/i);
      page.unmount();
    }
  });

  it("[A1-R2] a 2xx answer that is not JSON at all (a gateway page, an empty body) is an unknown outcome, never a completion", async () => {
    for (const make of [
      async () => new Response("<html>200 but not JSON</html>", { status: 200, headers: { "content-type": "text/html" } }),
      async () => new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      respond = make;
      const page = await analyzed(PENDING);
      expect(page.pill()).toBe("pending");
      expect(page.statusLabel()).toBe(LAST_KNOWN);
      expect(page.text()).toContain("Result not confirmed");
      page.unmount();
    }
  });

  it("[A1-R2] 'video_unusable' counts as the stored failure only with the route's 422; with another status it is not one", async () => {
    respond = async () => json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, 500);
    let page = await analyzed(PENDING);
    expect(page.pill()).toBe("unconfirmed");
    expect(page.link("Upload a new video")).toBeNull();
    page.unmount();
    respond = async () => json({ error: VIDEO_UNUSABLE_COPY, status: VIDEO_UNUSABLE_STATUS }, 200);
    page = await analyzed(PENDING);
    expect(page.pill()).toBe("pending");
    expect(page.statusLabel()).toBe(LAST_KNOWN);
    expect(page.text()).toContain("Result not confirmed");
  });

  it("[A1-R2] the server's own serialised completion (serializeAnalysisResult) is accepted: the check is not stricter than the route", async () => {
    const { serializeAnalysisResult } = await import("@/lib/analysis-result-read-authority");
    const row = {
      id: ANALYSIS_ID, user_id: A, status: "complete", analysis_family: "full_swing", score: 72, feedback: "Serialised synthetic feedback",
      metrics: { scoring_breakdown: "synthetic", pro_cue: "Stay tall", posture: { rating: "Good", observation: "o", correction: "c" }, swing_plane: null },
      swing_highlights: [{ checkpoint: "top", positive_movement: "p", mechanical_benefit: "m" }, "not-an-item"],
      mechanical_deficiencies: [{ checkpoint: null, joint_coordinate: { joint: "hips" }, fault_description: "f", severity: "minor", corrective_drill_title: "t", corrective_drill_detail: null }],
      swing_video: null,
    };
    const view = serializeAnalysisResult(row, { puttingAnalysis: false, equipmentFitting: false, launchMonitorIntelligence: false } as never);
    respond = async () => json({ message: "Analysis complete", data: view });
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("complete");
    expect(page.statusLabel()).toBe("Status");
    expect(page.text()).toContain("Serialised synthetic feedback");
  });

  // ─── F1-A1 R2 completion: the nested fields the completed view renders as text (real renderer) ─────────────────────
  const VIDEO_URL = "https://synthetic.invalid/a1-r2-playback.webm"; // non-null: the player renders its filename
  const completionWith = (over: Record<string, unknown>) => ({ message: "Analysis complete", data: { ...VALID("A1-R2 feedback").data, ...over } });
  const deficiency = (joint_coordinate: unknown) => ({ checkpoint: null, joint_coordinate, fault_description: "Synthetic fault", severity: null, corrective_drill_title: "Synthetic drill", corrective_drill_detail: null });

  it("[A1-R2] a completion whose video filename is not text (object, array, number, boolean) replaces nothing: unknown result, last known status, one request, and the real renderer neither throws nor shows an object", async () => {
    for (const [name, filename] of [["object", { bad: true }], ["array", ["a1-r2.webm"]], ["number", 7], ["boolean", true]] as const) {
      wire = [];
      respond = async () => json(completionWith({ swing_video: { id: randomUUID(), storage_path: null, original_filename: filename, club: null, created_at: "2026-11-23T00:00:00Z" } }));
      const page = await analyzed(PENDING, { videoSignedUrl: VIDEO_URL });
      expect(page.pill(), name).toBe("pending");
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      expect(page.text(), name).toContain("Result not confirmed");
      const html = page.markup(); // throws on an object child
      expect(html, name).not.toContain("[object Object]");
      expect(html, name).not.toContain("A1-R2 feedback");
      expect(reportCalls(), name).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle(page);
      expect(reportCalls(), name).toHaveLength(1); // no retry of its own
      page.unmount();
    }
  });

  it("[A1-R2] a completion whose deficiency location joint is not text (object, coercion-failing object, number, list) replaces nothing: no crash and no '[object Object]' label", async () => {
    const cases: [string, unknown][] = [
      ["object joint", { joint: {} }],
      ["joint that fails string coercion", { joint: { toString: null } }],
      ["number joint", { joint: 5 }],
      ["list joint", { joint: ["hips"] }],
    ];
    for (const [name, coordinate] of cases) {
      wire = [];
      respond = async () => json(completionWith({ mechanical_deficiencies: [deficiency(coordinate)] }));
      const page = await analyzed(PENDING, { videoSignedUrl: VIDEO_URL });
      expect(page.pill(), name).toBe("pending");
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      expect(page.text(), name).toContain("Result not confirmed");
      const html = page.markup();
      expect(html, name).not.toContain("[object Object]");
      expect(html, name).not.toContain("Synthetic fault");
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
    }
  });

  it("[A1-R2] a deficiency severity the renderer would turn into an invented 'Minor' chip (unknown text, empty, absent, number) replaces nothing", async () => {
    const withSeverity = (severity: unknown, present = true) => {
      const d: Record<string, unknown> = deficiency("left hip");
      if (present) d.severity = severity; else delete d.severity;
      return d;
    };
    const cases: [string, Record<string, unknown>][] = [
      ["unknown text", withSeverity("catastrophic")],
      ["empty text", withSeverity("")],
      ["absent", withSeverity(undefined, false)],
      ["number", withSeverity(3)],
    ];
    for (const [name, d] of cases) {
      wire = [];
      respond = async () => json(completionWith({ mechanical_deficiencies: [d] }));
      const page = await analyzed(PENDING, { videoSignedUrl: VIDEO_URL });
      expect(page.pill(), name).toBe("pending");
      expect(page.statusLabel(), name).toBe(LAST_KNOWN);
      const html = page.markup();
      expect(html, name).not.toContain("Synthetic fault");
      expect(html, name).not.toMatch(/>Minor<|>Major</);
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
    }
  });

  it("[A1-R2] the server's severities still complete and show only what they say: 'minor' → Minor, 'major' → Major, null → no chip", async () => {
    for (const [severity, chip] of [["minor", ">Minor<"], ["major", ">Major<"], [null, null]] as const) {
      wire = [];
      respond = async () => json(completionWith({ mechanical_deficiencies: [{ ...deficiency("left hip"), severity }] }));
      const page = await analyzed(PENDING, { videoSignedUrl: VIDEO_URL });
      const name = String(severity);
      expect(page.pill(), name).toBe("complete");
      const html = page.markup();
      if (chip) expect(html, name).toContain(chip);
      else expect(html, name).not.toMatch(/>Minor<|>Major</);
      expect(html, name).toContain("Synthetic fault");
      page.unmount();
    }
  });

  it("[A1-R2] legitimate filenames (text, null, absent) and locations (direct text, object with text joint, object with null joint, null) still complete, and render as text", async () => {
    const cases: [string, Record<string, unknown>, string | null][] = [
      ["text filename", { swing_video: { id: randomUUID(), storage_path: null, original_filename: "a1-r2-synthetic-swing.webm", club: null, created_at: "2026-11-23T00:00:00Z" } }, "a1-r2-synthetic-swing.webm"],
      ["null filename", { swing_video: { id: randomUUID(), storage_path: null, original_filename: null, club: null, created_at: "2026-11-23T00:00:00Z" } }, null],
      ["absent filename", { swing_video: { id: randomUUID(), storage_path: null, club: null, created_at: "2026-11-23T00:00:00Z" } }, null],
      ["direct text joint", { mechanical_deficiencies: [deficiency("left hip")] }, "left hip"],
      ["object joint with text", { mechanical_deficiencies: [deficiency({ joint: "lead shoulder" })] }, "lead shoulder"],
      ["object joint with null", { mechanical_deficiencies: [deficiency({ joint: null })] }, null],
      ["null joint", { mechanical_deficiencies: [deficiency(null)] }, null],
    ];
    for (const [name, over, shown] of cases) {
      wire = [];
      respond = async () => json(completionWith(over));
      const page = await analyzed(PENDING, { videoSignedUrl: VIDEO_URL });
      expect(page.pill(), name).toBe("complete");
      expect(page.statusLabel(), name).toBe("Status");
      const html = page.markup();
      expect(html, name).not.toContain("[object Object]");
      expect(html, name).toContain("A1-R2 feedback");
      if (shown) expect(html, name).toContain(shown);
      expect(reportCalls(), name).toHaveLength(1);
      page.unmount();
    }
  });

  it("[A1-R2] the valid completion of the requested analysis (nullable containers kept) replaces it, once", async () => {
    respond = async () => json({ message: "Analysis complete", data: { ...PENDING, status: "complete", score: 64, feedback: null, swing_highlights: null, mechanical_deficiencies: null, metrics: null } });
    const page = await analyzed(PENDING);
    expect(page.pill()).toBe("complete");
    expect(page.statusLabel()).toBe("Status");
    expect(reportCalls()).toHaveLength(1);
  });
});
