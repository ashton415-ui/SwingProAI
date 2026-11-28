import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope.
(globalThis as Record<string, unknown>).React = React;

/**
 * AG-AUTH-01 — sign-in and sign-up form recovery, driven through the pages' actual submit handlers.
 *
 * The auth calls are spies (a fake browser client whose construction and `signInWithPassword` are counted, and a spy
 * for `signupAction`; AG-AUTH-02: the login action module is recorded, see below); nothing reaches a network, a
 * database or a provider. A small hook
 * runtime keeps state and refs across renders (as React does) and models what React does with a form action: while
 * the action runs, the form status is pending and state updates made inside it are held until it settles. The sign-in
 * form submits through an ordinary event handler, whose updates apply at once. Real scheduling in the installed
 * Next.js/React runtime is checked separately by the mocked browser pass; this file checks the handlers' decisions.
 *
 * The file imports only the two pages and their unchanged dependencies, so it also runs against earlier accepted pages
 * as a behaviour control:
 *   [behavior]  (AG-AUTH-01) observable recovery and duplicate-guard behaviour; each must fail on the pre-AG-AUTH-01
 *               pages (accepted AG-S1) for the behaviour named (a stuck pending state, a missing message, a duplicate
 *               call, an unusable answer treated as success), not because of a missing import or a changed signature;
 *               they pass on the accepted AG-AUTH-01 R1 pages;
 *   [preserve]  the existing contract (calls, arguments, order, navigation, returned-failure copy); passes on both;
 *   [taxonomy]  the exact new copy; [guard] source checks on the two pages.
 *
 * R1 (AUTH-R1-A): the sign-in page is not submittable until its own handler is ready. The first render here is the
 * server-rendered state (effects have not run); hydration is modelled by running the effects once. The [guard] checks of
 * that state are static: the runtime proof is the browser pass with JavaScript off and with hydration held (N1-N3).
 *
 * AG-AUTH-02: the sign-in page no longer hands the session's tokens to a login Server Action (which ignored them and set
 * an unrelated test cookie). The login action module is not replaced by a fake here: the real module is loaded with each
 * of its exports wrapped so that any call is recorded, and the request cookie store a Server Action writes through
 * (`next/headers`) is a recorder (cookie names and attributes only). Run against the accepted AG-AUTH-01 R1 pages, the real
 * handoff therefore runs and its cookie write is seen, so the controls below fail on that behaviour, not on a missing
 * import:
 *   [retired]        must fail on the accepted R1 pages because the handoff runs (an action call, a server cookie write,
 *                    or a handoff failure blocking a completed sign-in), and pass here;
 *   [retired-guard]  source checks of the retirement;
 *   every other test passes on both the accepted R1 pages and here (the accepted behaviour, preserved). Handoff-only
 *   tests were removed, not kept. The browser SDK's own cookie storage is inherited and unchanged; this file does not
 *   model it (the browser pass observes it).
 *
 * AG-AUTH-03: the sign-up action now returns one of three fixed outcomes ({ outcome: "continue" | "failed" |
 * "unconfirmed" }) instead of provider text and a dashboard redirect, and a recognized answer replaces the form with one
 * fixed next step. The sign-up expectations below use that contract (the stubbed action returns those outcomes), and
 * the uncertainty copy no longer mentions the dashboard. The action itself is tested through the installed SDK in
 * lib/auth-signup-completion.test.ts. The sign-in tests are unchanged.
 *
 * A1 (AG-WEB-READY-03-R1-A1): the sign-in page no longer builds a browser client and calls signInWithPassword itself.
 * It makes exactly one call, utils/supabase/session-publication.ts signInAndPublish(email, password), which owns the
 * scratch sign-in client, the shared client and the publication under the session-publication lease, and answers with
 * one fixed outcome: "signed_in" | "refused" | "interrupted" | "unsupported" (tested with the real SDK and a multi-tab
 * stand-in in lib/session-publication.test.ts). That call is the page's boundary, so it is the spy here, replacing the
 * old fake client and its signInWithPassword; every sign-in behaviour is still asserted against it: the fixed failure
 * and interruption copy, a thrown or unusable result, retry, the duplicate-submit guard, privacy (no provider text or
 * entered email on the page) and no server handoff (no Server Action, no server cookie write, no fetch). A1 adds the
 * fixed "unsupported" outcome (this browser cannot keep a sign-in safely; nothing was sent).
 */

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  effects: [] as (() => unknown)[],
  formPending: false,
  holding: 0,
  held: [] as (() => void)[],
  publish: null as null | ((...a: unknown[]) => unknown),
  signup: null as null | ((...a: unknown[]) => unknown),
  // AG-AUTH-02 recorders: calls into the login action module, and writes to the server request cookie store
  actionCalls: [] as { name: string; carriesTheSessionTokens: boolean }[],
  cookieWrites: [] as Record<string, unknown>[],
  cookies: null as null | (() => unknown),
  isSessionTokens: ((_a: unknown[]) => false) as (a: unknown[]) => boolean,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      const apply = () => { rt.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(rt.slots[i]) : v; };
      if (rt.holding) rt.held.push(apply); else apply(); // updates inside a running form action wait for it to settle
    };
    return [rt.slots[i], set];
  }
  function useRef(init: unknown) {
    const i = rt.i++;
    if (!(i in rt.slots)) rt.slots[i] = { current: init };
    return rt.slots[i];
  }
  const useEffect = (fn: () => unknown) => { rt.effects.push(fn); };
  return { ...actual, default: actual, useState, useRef, useEffect };
});
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, useFormStatus: () => ({ pending: rt.formPending, data: null, method: null, action: null }) };
});
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { ...p, href: p.href }) };
});
// A1: the page's one sign-in call (see the header)
// A2: the sign-in page also asks whether an End Session completion is pending (none here: a plain visit) and never runs one
vi.mock("@/utils/supabase/session-publication", () => ({
  signInAndPublish: (...a: unknown[]) => rt.publish!(...a),
  endIntentPending: () => false,
  completeEndedSession: () => Promise.reject(new Error("a plain visit runs no End Session completion")),
}));
// AG-AUTH-02: the real login action module, each exported function wrapped so a call is recorded and then run as is
vi.mock("@/app/(auth)/login/actions", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, v]) => [name, typeof v !== "function" ? v : (...a: unknown[]) => {
    rt.actionCalls.push({ name, carriesTheSessionTokens: rt.isSessionTokens(a) });
    return (v as (...x: unknown[]) => unknown)(...a);
  }]));
});
// the request cookie store a Server Action writes through: a recorder (rt.cookies)
vi.mock("next/headers", () => ({ cookies: () => rt.cookies!(), headers: () => new Headers() }));
vi.mock("@/app/(auth)/signup/actions", () => ({ signupAction: (...a: unknown[]) => rt.signup!(...a) }));

import LoginPage from "@/app/(auth)/login/page";
import SignupPage from "@/app/(auth)/signup/page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const COPY = {
  signInFailed: "We couldn't sign you in. Check your email and password, or try again in a moment.",
  signInInterrupted: "We couldn't finish signing you in. Please try again in a moment.",
  signInNotReady: "Sign-in needs JavaScript. If the button stays unavailable, check that JavaScript is on and reload this page.",
  // A1 (R5): this browser cannot keep a sign-in safely; nothing was sent
  signInUnsupported: "This browser can't keep your sign-in safe, so you weren't signed in and nothing was sent. Private browsing or blocked site data can cause this; try a regular window or another browser.",
  signUpFailed: "We couldn't create your account. Check your details or try again in a moment. If you already have an account, sign in instead.",
  // AG-AUTH-03: without the dashboard sentence (sign-up no longer redirects); the one completion's heading and body
  signUpUnconfirmed: "We couldn't confirm whether your account was created. Check your email or try signing in before creating it again.",
  continueHeading: "Continue with your account",
  continueBody: "Sign in to continue. If email confirmation is required, check your inbox first.",
};
// AG-AUTH-03: the sign-up action's fixed answers
const SIGNUP_FAILED = { outcome: "failed" } as const;
const SIGNUP_CONTINUE = { outcome: "continue" } as const;
// Synthetic provider/internal text: none of it may ever reach the page.
const RAW = 'Invalid login credentials: relation "auth.users" 42501 (synthetic) token=agauth-synthetic-internal-9c1e';
const RAW_PARTS = /Invalid login credentials|auth\.users|42501|synthetic|token=|agauth-synthetic|TypeError|Failed to fetch|already registered/i;
// Dummy values, generated per run so no credential-like literal is kept in the test or its logs.
const DUMMY = { email: `golfer-${randomUUID()}@example.invalid`, password: randomUUID(), fullName: `Synthetic Golfer ${randomUUID().slice(0, 8)}` };
const TOKENS = { access_token: `agauth-${randomUUID()}`, refresh_token: `agauth-${randomUUID()}` };
rt.isSessionTokens = (a) => a.includes(TOKENS.access_token) || a.includes(TOKENS.refresh_token);
// a server request cookie store that records each write by name and attributes, never the value
const recordingCookieStore = () => ({
  get: () => undefined,
  getAll: () => [],
  has: () => false,
  set: (name: string, _value: unknown, o?: Record<string, unknown>) => {
    rt.cookieWrites.push({ name, httpOnly: o?.httpOnly ?? null, secure: o?.secure ?? null, sameSite: o?.sameSite ?? null, maxAge: o?.maxAge ?? null });
  },
  delete: (name: string) => { rt.cookieWrites.push({ name, deleted: true }); },
});

// ── a tiny synchronous renderer: function components are called, host elements kept ──────────────────────
type El = React.ReactElement<Record<string, unknown>>;
const FORWARD_REF = Symbol.for("react.forward_ref");
const focusLog: string[] = [];
function expand(node: unknown): unknown[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(expand);
  const el = node as El;
  const type = el.type as unknown;
  if (type === React.Fragment) return expand(el.props.children);
  if (typeof type === "function") return expand((type as (p: unknown) => unknown)(el.props));
  if (type && typeof type === "object" && (type as { $$typeof?: symbol }).$$typeof === FORWARD_REF) {
    return expand((type as { render: (p: unknown, r: unknown) => unknown }).render(el.props, null));
  }
  if (typeof type === "string") {
    const { children, ...props } = el.props;
    const ref = (el as unknown as { ref?: unknown }).ref;
    if (ref && typeof ref === "object" && "current" in ref) {
      (ref as { current: unknown }).current = { id: props.id ?? null, focus: () => { focusLog.push(String(props.id ?? type)); } };
    }
    return [React.createElement(type, props, ...(expand(children) as React.ReactNode[]))];
  }
  throw new Error(`unexpected element type ${String(type)}`);
}
function markup(nodes: unknown[]): React.ReactNode[] {
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n as React.ReactNode;
    const { children, ...props } = (n as El).props;
    const kept = Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v !== "function"));
    const kids = Array.isArray(children) ? children : children === undefined ? [] : [children];
    return React.createElement((n as El).type as string, kept, ...markup(kids));
  });
}
function render(Page: unknown) {
  rt.i = 0;
  rt.effects = [];
  const nodes = expand(React.createElement(Page as React.FC));
  return { nodes, html: renderToStaticMarkup(React.createElement(React.Fragment, null, ...markup(nodes))) };
}
function all(nodes: unknown[], pred: (e: El) => boolean, out: El[] = []): El[] {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const e = n as El;
    if (pred(e)) out.push(e);
    const kids = e.props.children;
    all(Array.isArray(kids) ? kids : [kids], pred, out);
  }
  return out;
}
function textOf(e: unknown): string {
  if (e == null || typeof e === "boolean") return "";
  if (typeof e === "string" || typeof e === "number") return String(e);
  if (Array.isArray(e)) return e.map(textOf).join("");
  return textOf((e as El).props.children);
}
const alerts = (nodes: unknown[]) => all(nodes, (e) => e.props.role === "alert").map((a) => textOf(a).trim());
const button = (nodes: unknown[]) => {
  const b = all(nodes, (e) => e.type === "button" && e.props.type === "submit");
  expect(b).toHaveLength(1);
  return b[0];
};
// A2: the sign-in page's End Session completion has its own status region (id login-end-status), empty on a plain visit
const status = (nodes: unknown[]) => all(nodes, (e) => e.props.role === "status" && e.props.id !== "login-end-status").map(textOf).join("|");
const BODY = { id: "body" };
function runEffects(active: unknown = BODY) {
  focusLog.length = 0;
  (globalThis as Record<string, unknown>).document = { body: BODY, activeElement: active };
  try { for (const fn of rt.effects) fn(); } finally { delete (globalThis as Record<string, unknown>).document; }
  return [...focusLog];
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// sign-in: the page's own onSubmit with a fake event (the form's two named fields, a reset spy that must stay unused)
const loginEvent = () => ({
  preventDefault: vi.fn(),
  currentTarget: { reset: vi.fn(), elements: { namedItem: (n: string) => (n === "email" ? { value: DUMMY.email } : n === "password" ? { value: DUMMY.password } : null) } },
});
const loginSubmit = () => {
  const forms = all(render(LoginPage).nodes, (e) => e.type === "form");
  return forms[0].props.onSubmit as (e: unknown) => Promise<void>;
};
// sign-up: the page's own form action, run the way React runs a form action (pending, updates held until it settles)
const signupData = () => {
  const fd = new FormData();
  fd.set("fullName", DUMMY.fullName);
  fd.set("email", DUMMY.email);
  fd.set("password", DUMMY.password);
  return fd;
};
const signupAction = () => all(render(SignupPage).nodes, (e) => e.type === "form")[0].props.action as (f: FormData) => Promise<void>;
async function runFormAction(action: (f: FormData) => Promise<void>, fd: FormData) {
  rt.formPending = true;
  rt.holding++;
  try {
    await action(fd);
  } finally {
    rt.holding--;
    if (!rt.holding) {
      rt.held.splice(0).forEach((apply) => apply());
      rt.formPending = false;
    }
  }
}
const settle = (p: Promise<unknown>) => p.then(() => "resolved", () => "rejected");

let publish: ReturnType<typeof vi.fn>;
let signup: ReturnType<typeof vi.fn>;
let win: { location: { href: string } };
beforeEach(() => {
  rt.slots = [];
  rt.effects = [];
  rt.formPending = false;
  rt.holding = 0;
  rt.held = [];
  publish = vi.fn();
  signup = vi.fn();
  rt.publish = publish;
  rt.signup = signup;
  rt.actionCalls = [];
  rt.cookieWrites = [];
  const store = recordingCookieStore();
  rt.cookies = () => store;
  win = { location: { href: "about:blank" } };
  (globalThis as Record<string, unknown>).window = win;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});
// A1: the helper's fixed outcomes (the session's tokens never reach the page)
const SIGNED_IN = "signed_in";
const REFUSED = "refused";

// ── sign-in ─────────────────────────────────────────────────────────────────────────────────────────────
describe("sign-in: thrown, lost and unusable results settle visibly", () => {
  beforeEach(() => {
    render(LoginPage);
    runEffects(BODY); // hydrated: the page's effects have run (R1: the submit handler is ready)
  });
  // AG-AUTH-02: the two handoff cases (a lost or unusable handoff answer) were removed with the handoff itself
  // A1: the old client-creation / signInWithPassword failures are now failures of the one sign-in call
  const cases: Array<[string, () => void, (keyof typeof COPY), { publish: number }]> = [
    ["the sign-in call throws at once (a browser client cannot be created)", () => { publish.mockImplementation(() => { throw new Error(RAW); }); }, "signInInterrupted", { publish: 1 }],
    ["the sign-in call rejects (a lost request)", () => { publish.mockRejectedValue(new TypeError("Failed to fetch")); }, "signInInterrupted", { publish: 1 }],
    ["the sign-in call returns nothing usable", () => { publish.mockResolvedValue(undefined); }, "signInInterrupted", { publish: 1 }],
    ["the sign-in call returns an outcome the page does not know", () => { publish.mockResolvedValue({ data: { session: { ...TOKENS } }, error: null }); }, "signInInterrupted", { publish: 1 }],
    ["the sign-in call reports the attempt interrupted (no answer in time, or the session could not be published and recorded)", () => { publish.mockResolvedValue("interrupted"); }, "signInInterrupted", { publish: 1 }],
    ["the sign-in call reports this browser unsupported (A1 R5: nothing was sent)", () => { publish.mockResolvedValue("unsupported"); }, "signInUnsupported", { publish: 1 }],
  ];
  it.each(cases)("[behavior] %s: the fixed message, pending cleared, no navigation", async (_, arrange, copy, calls) => {
    arrange();
    const outcome = await settle(loginSubmit()(loginEvent()));
    const after = render(LoginPage);
    expect(alerts(after.nodes)).toEqual([COPY[copy]]);
    expect(button(after.nodes).props.disabled).toBe(false);
    expect(button(after.nodes).props["aria-busy"]).toBe(false);
    expect(status(after.nodes)).toBe("");
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(after.html).not.toContain(DUMMY.email);
    expect(win.location.href).toBe("about:blank");
    expect(outcome).toBe("resolved"); // nothing escapes as an unhandled rejection
    expect({ publish: publish.mock.calls.length }).toEqual(calls);
  });

  it("[behavior] after an interrupted attempt the message takes focus when focus had fallen to the page", async () => {
    publish.mockRejectedValue(new TypeError("Failed to fetch"));
    await settle(loginSubmit()(loginEvent()));
    render(LoginPage);
    expect(runEffects(BODY)).toEqual(["login-error"]);
    render(LoginPage);
    expect(runEffects({ id: "login-password" })).toEqual([]); // focus on a field stays there
  });

  it("[behavior] a second submit before the first settles starts no second request, and still blocks the browser's own submission", async () => {
    const d = deferred<unknown>();
    publish.mockReturnValue(d.promise);
    const handler = loginSubmit();
    const e1 = loginEvent(), e2 = loginEvent(), e3 = loginEvent();
    const first = handler(e1);
    const second = handler(e2); // the same moment: before React has re-rendered the disabled button
    const third = loginSubmit()(e3); // after a re-render too
    await new Promise((r) => setTimeout(r, 0)); // let every started attempt reach its first request
    const counts = { publish: publish.mock.calls.length };
    d.resolve(REFUSED);
    await Promise.all([first, second, third].map(settle));
    expect(counts).toEqual({ publish: 1 });
    for (const e of [e1, e2, e3]) expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(alerts(render(LoginPage).nodes)).toEqual([COPY.signInFailed]);
  });

  it("[behavior] after a thrown attempt, another deliberate attempt runs again and can succeed", async () => {
    publish.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(SIGNED_IN);
    await settle(loginSubmit()(loginEvent()));
    expect(button(render(LoginPage).nodes).props.disabled).toBe(false);
    await loginSubmit()(loginEvent());
    expect(publish).toHaveBeenCalledTimes(2);
    expect(win.location.href).toBe("/dashboard");
  });

  it("[preserve] success: one sign-in with exactly the entered email and password, then /dashboard; no message, still busy, nothing reset", async () => {
    publish.mockResolvedValue(SIGNED_IN);
    const ev = loginEvent();
    await loginSubmit()(ev);
    expect(publish.mock.calls).toEqual([[DUMMY.email, DUMMY.password]]);
    expect(win.location.href).toBe("/dashboard");
    const after = render(LoginPage);
    expect(alerts(after.nodes)).toEqual([]);
    expect(button(after.nodes).props.disabled).toBe(true); // stays busy while the browser navigates
    expect(ev.currentTarget.reset).not.toHaveBeenCalled();
  });

  // A1: a returned sign-in error, no session, an invalid token response or no data at all are each "refused" inside
  // the helper (its own contract, lib/session-publication.test.ts); the page shows the one fixed failure message for it
  it.each([
    ["the helper's refused outcome (any returned sign-in error, or no session)", () => { publish.mockResolvedValue(REFUSED); }],
    ["a refused outcome after a first refusal (the same fixed message again)", () => { publish.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(REFUSED); }],
  ])("[preserve] %s: the existing fixed message, values left in the form, another attempt possible", async (_, arrange) => {
    arrange();
    const ev = loginEvent();
    await loginSubmit()(ev);
    const after = render(LoginPage);
    expect(alerts(after.nodes)).toEqual([COPY.signInFailed]);
    expect(button(after.nodes).props.disabled).toBe(false);
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(win.location.href).toBe("about:blank");
    expect(ev.currentTarget.reset).not.toHaveBeenCalled();
  });

  it("[preserve] pending: the button is disabled and busy and the status region announces it", async () => {
    const d = deferred<unknown>();
    publish.mockReturnValue(d.promise);
    const done = loginSubmit()(loginEvent());
    const during = render(LoginPage);
    expect(button(during.nodes).props.disabled).toBe(true);
    expect(button(during.nodes).props["aria-busy"]).toBe(true);
    expect(status(during.nodes)).toBe("Signing in…");
    d.resolve(REFUSED);
    await done;
  });
});

// ── AG-AUTH-02: the sign-in token handoff is retired ────────────────────────────────────────────────────
describe("AG-AUTH-02: after sign-in the page makes no further request with the session; no login Server Action, no server cookie write", () => {
  beforeEach(() => {
    render(LoginPage);
    runEffects(BODY); // hydrated
  });
  // a failure message that carries the whole observed record (names, counts and booleans only), so a control run shows
  // which behaviour made it fail
  const observed = (o: unknown) => `observed ${JSON.stringify(o)}`;

  it("[retired] success: no login Server Action is called, no cookie is written through the server and no fetch is made; the page goes to /dashboard", async () => {
    publish.mockResolvedValue(SIGNED_IN);
    // any request the page might make by itself (for example to another session route) would go through fetch
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => { fetchCalls++; return Promise.reject(new Error("no network in this test")); }) as typeof fetch;
    try {
      await loginSubmit()(loginEvent());
    } finally {
      globalThis.fetch = realFetch;
    }
    const seen = { actionCalls: rt.actionCalls, cookieWrites: rt.cookieWrites, fetchCalls, publish: publish.mock.calls.length, href: win.location.href };
    expect(seen, observed(seen)).toEqual({ actionCalls: [], cookieWrites: [], fetchCalls: 0, publish: 1, href: "/dashboard" });
  });

  it("[retired] a completed sign-in no longer depends on a second request: with the server cookie store failing, the session still leads to /dashboard", async () => {
    rt.cookies = () => { throw new Error("request cookie store unavailable (synthetic)"); };
    publish.mockResolvedValue(SIGNED_IN);
    const outcome = await settle(loginSubmit()(loginEvent()));
    const seen = { outcome, alerts: alerts(render(LoginPage).nodes), href: win.location.href, actionCalls: rt.actionCalls };
    expect(seen, observed(seen)).toEqual({ outcome: "resolved", alerts: [], href: "/dashboard", actionCalls: [] });
  });

  it("[retired] retry after a definite failure, then success: two sign-in calls, one navigation, and across both no action call or server cookie write", async () => {
    publish.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(SIGNED_IN);
    await loginSubmit()(loginEvent());
    expect(alerts(render(LoginPage).nodes)).toEqual([COPY.signInFailed]);
    expect(win.location.href).toBe("about:blank");
    await loginSubmit()(loginEvent());
    const seen = { publish: publish.mock.calls.length, href: win.location.href, actionCalls: rt.actionCalls, cookieWrites: rt.cookieWrites };
    expect(seen, observed(seen)).toEqual({ publish: 2, href: "/dashboard", actionCalls: [], cookieWrites: [] });
  });

  it("[retired] duplicate submits while a successful sign-in is pending (the same task, and after a re-render): one sign-in, one navigation, no action call", async () => {
    const assigned: string[] = [];
    win.location = { set href(v: string) { assigned.push(v); }, get href() { return assigned[assigned.length - 1] ?? "about:blank"; } };
    const d = deferred<unknown>();
    publish.mockReturnValue(d.promise);
    const handler = loginSubmit();
    const first = handler(loginEvent());
    const second = handler(loginEvent()); // the same task, before React re-renders the disabled button
    const third = loginSubmit()(loginEvent()); // after a re-render
    d.resolve(SIGNED_IN);
    await Promise.all([first, second, third].map(settle));
    const seen = { publish: publish.mock.calls.length, navigations: assigned, actionCalls: rt.actionCalls };
    expect(seen, observed(seen)).toEqual({ publish: 1, navigations: ["/dashboard"], actionCalls: [] });
  });

  it("[retired-guard] the sign-in page's code imports no Server Action and names no token, cookie or session handoff", () => {
    const src = source("app/(auth)/login/page.tsx");
    // code only: line comments and JSX comments are removed first (the comments describe the inherited cookie honestly)
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from "\.\/actions"|setSessionAction|setSession\(|access_token|refresh_token|cookie|test-auth|fetch\(/i);
    // A1: the one sign-in call comes from the publication module (no browser client, no SDK call in the page itself)
    expect(Array.from(src.matchAll(/^import .* from "([^"]+)";$/gm)).map((m) => m[1])).toEqual(["react", "@/utils/supabase/session-publication", "next/link", "lucide-react"]);
    expect(src.match(/signInAndPublish\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/signInWithPassword|createClient/);
    expect(src.match(/window\.location\.href = "\/dashboard";/g)).toHaveLength(1);
  });

  it("[retired-guard] the login action module is retired: no export, not a Server Action module, no cookie access", () => {
    const src = source("app/(auth)/login/actions.ts");
    expect(src.replace(/^\s*\/\/.*$/gm, "").trim()).toBe("export {};");
    expect(src).not.toMatch(/use server|next\/headers|cookies\(|\.set\(|test-auth|console\./);
  });
});

// ── sign-up ─────────────────────────────────────────────────────────────────────────────────────────────
describe("sign-up: effective pending state, one request at a time, honest uncertainty", () => {
  it("[behavior] while the action is in flight the submit button is disabled (the form's pending state), busy and announced", async () => {
    const d = deferred<unknown>();
    signup.mockReturnValue(d.promise);
    const run = runFormAction(signupAction(), signupData());
    const during = render(SignupPage);
    expect(button(during.nodes).props.disabled).toBe(true);
    expect(button(during.nodes).props["aria-busy"]).toBe(true);
    expect(status(during.nodes)).toBe("Creating account…");
    d.resolve(SIGNUP_FAILED);
    await run;
  });

  it("[behavior] a second submission before the pending state has rendered starts no second action", async () => {
    const d = deferred<unknown>();
    signup.mockReturnValue(d.promise);
    const action = signupAction();
    const first = runFormAction(action, signupData());
    const second = runFormAction(action, signupData()); // a fast double press or Enter: before the disabled button renders
    const third = runFormAction(signupAction(), signupData()); // after a re-render too
    await new Promise((r) => setTimeout(r, 0)); // let every started submission reach its action call
    const calls = signup.mock.calls.length;
    d.resolve(SIGNUP_FAILED);
    await Promise.all([first, second, third].map(settle));
    expect(calls).toBe(1);
    expect(alerts(render(SignupPage).nodes)).toEqual([COPY.signUpFailed]);
  });

  const unknown: Array<[string, () => void]> = [
    ["the action throws (a lost request)", () => { signup.mockRejectedValue(new TypeError("Failed to fetch")); }],
    ["the action resolves with no result (a response that is not the action's own)", () => { signup.mockResolvedValue(undefined); }],
    ["the action resolves with an answer the page cannot read", () => { signup.mockResolvedValue({ error: 42 }); }],
    // AG-AUTH-03: the action's own uncertain outcome, and the retired { error: <text> } shape, are not definite either
    ["the action resolves with its own uncertain outcome", () => { signup.mockResolvedValue({ outcome: "unconfirmed" }); }],
    ["the action resolves with the retired { error: <text> } shape", () => { signup.mockResolvedValue({ error: RAW }); }],
  ];
  it.each(unknown)("[behavior] %s: the uncertainty message, settled (button usable again), nothing escapes", async (_, arrange) => {
    arrange();
    const outcome = await settle(runFormAction(signupAction(), signupData()));
    const after = render(SignupPage);
    expect(outcome).toBe("resolved");
    expect(alerts(after.nodes)).toEqual([COPY.signUpUnconfirmed]);
    expect(button(after.nodes).props.disabled).toBe(false);
    expect(button(after.nodes).props["aria-busy"]).toBe(false);
    expect(status(after.nodes)).toBe("");
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(after.html).not.toContain(DUMMY.email);
    expect(signup).toHaveBeenCalledTimes(1);
  });

  it("[behavior] after an uncertain result the message takes focus when focus had fallen to the page, and another attempt can run", async () => {
    signup.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(SIGNUP_FAILED);
    await settle(runFormAction(signupAction(), signupData()));
    render(SignupPage);
    expect(runEffects(BODY)).toEqual(["signup-error"]);
    await runFormAction(signupAction(), signupData());
    expect(signup).toHaveBeenCalledTimes(2);
    expect(alerts(render(SignupPage).nodes)).toEqual([COPY.signUpFailed]);
  });

  it("[preserve] a returned failure: the existing fixed message, the FormData passed once and unchanged, another attempt possible", async () => {
    signup.mockResolvedValueOnce(SIGNUP_FAILED).mockResolvedValueOnce(SIGNUP_FAILED);
    const fd = signupData();
    await runFormAction(signupAction(), fd);
    expect(signup.mock.calls[0][0]).toBe(fd);
    const after = render(SignupPage);
    expect(alerts(after.nodes)).toEqual([COPY.signUpFailed]);
    expect(button(after.nodes).props.disabled).toBe(false);
    await runFormAction(signupAction(), signupData());
    expect(signup).toHaveBeenCalledTimes(2);
  });

  // AG-AUTH-03: the completion settles the attempt (nothing pending, nothing announced as a failure) and leaves no form to
  // submit again; after a failure or an uncertain result, a retry can reach it
  it("[behavior] a recognized answer: pending ends, the form is replaced by the fixed next step, and nothing else is shown", async () => {
    signup.mockResolvedValueOnce(SIGNUP_CONTINUE);
    const outcome = await settle(runFormAction(signupAction(), signupData()));
    const after = render(SignupPage);
    expect(outcome).toBe("resolved");
    expect(rt.formPending).toBe(false);
    expect(alerts(after.nodes)).toEqual([]);
    expect(status(after.nodes)).toBe("");
    expect(all(after.nodes, (e) => e.type === "form")).toEqual([]);
    expect(all(after.nodes, (e) => e.type === "h2").map((h) => textOf(h).trim())).toEqual([COPY.continueHeading]);
    expect(all(after.nodes, (e) => e.type === "a").map((a) => [a.props.href, textOf(a).trim()])).toEqual([["/login", "Sign in"]]);
    expect(win.location.href).toBe("about:blank");
    expect(rt.cookieWrites).toEqual([]);
  });

  it("[behavior] a failure, then an uncertain result, then a retry that completes: three calls, each settled", async () => {
    signup.mockResolvedValueOnce(SIGNUP_FAILED).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(SIGNUP_CONTINUE);
    await runFormAction(signupAction(), signupData());
    expect(alerts(render(SignupPage).nodes)).toEqual([COPY.signUpFailed]);
    await settle(runFormAction(signupAction(), signupData()));
    expect(alerts(render(SignupPage).nodes)).toEqual([COPY.signUpUnconfirmed]);
    expect(button(render(SignupPage).nodes).props.disabled).toBe(false);
    await runFormAction(signupAction(), signupData());
    const after = render(SignupPage);
    expect(signup).toHaveBeenCalledTimes(3);
    expect(alerts(after.nodes)).toEqual([]);
    expect(after.html).toContain(COPY.continueHeading);
  });

  // AG-AUTH-03: a successful sign-up no longer redirects (the action returns its fixed completion). These cases cover
  // Next's own control-flow errors should one ever reach the client.
  it.each([
    ["a redirect", "NEXT_REDIRECT;replace;/dashboard;307;"],
    ["a push redirect", "NEXT_REDIRECT;push;/dashboard;303;"],
    ["a not-found", "NEXT_NOT_FOUND"],
  ])("[preserve] Next's own control flow reaching the client (%s) is left to Next.js: rethrown untouched, nothing shown", async (_, digest) => {
    const signal = Object.assign(new Error(digest.split(";")[0]), { digest });
    signup.mockRejectedValue(signal);
    let caught: unknown = null;
    await runFormAction(signupAction(), signupData()).catch((e) => { caught = e; });
    expect(caught).toBe(signal);
    expect(alerts(render(SignupPage).nodes)).toEqual([]);
  });

  it.each([
    ["a look-alike digest", { digest: "NEXT_REDIRECTX;replace;/dashboard;307;" }],
    ["a redirect digest with no status", { digest: "NEXT_REDIRECT;replace;/dashboard" }],
    ["a numeric server-error digest", { digest: "2817364519" }],
    ["a message that only mentions NEXT_REDIRECT", {}],
  ])("[behavior] an error that is not Next's own control flow (%s) is an unknown result: the uncertainty message, not rethrown", async (_, extra) => {
    signup.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), extra));
    const outcome = await settle(runFormAction(signupAction(), signupData()));
    expect(outcome).toBe("resolved");
    expect(alerts(render(SignupPage).nodes)).toEqual([COPY.signUpUnconfirmed]);
  });
});

// ── R1: the sign-in form before its handler is ready (AUTH-R1-A) ───────────────────────────────────────
describe("R1: the sign-in form is not submittable until its own handler is ready", () => {
  const form = (nodes: unknown[]) => all(nodes, (e) => e.type === "form")[0];
  const readiness = (nodes: unknown[]) => all(nodes, (e) => e.props.id === "login-readiness");

  it("[guard] server-rendered state (no effect has run): the button is disabled, the form posts, the readiness note is shown and linked", () => {
    const ssr = render(LoginPage);
    const b = button(ssr.nodes);
    expect(b.props.disabled).toBe(true);
    expect(b.props["aria-busy"]).toBe(false);
    expect(textOf(b).trim()).toBe("Sign in");
    expect(b.props["aria-describedby"]).toBe("login-readiness");
    expect(form(ssr.nodes).props.method).toBe("post");
    expect(form(ssr.nodes).props.action).toBeUndefined();
    expect(readiness(ssr.nodes).map((e) => textOf(e).trim())).toEqual([COPY.signInNotReady]);
    expect(status(ssr.nodes)).toBe("");
    expect(alerts(ssr.nodes)).toEqual([]);
    // the same in the markup the server sends
    expect(ssr.html).toMatch(/<form method="post"/);
    expect(ssr.html).toMatch(/<button type="submit" disabled=""/);
  });

  it("[guard] once the effects have run (hydrated): the button works, the note is gone, the form still posts", () => {
    render(LoginPage);
    runEffects(BODY);
    const ready = render(LoginPage);
    expect(button(ready.nodes).props.disabled).toBe(false);
    expect(button(ready.nodes).props["aria-describedby"]).toBeUndefined();
    expect(readiness(ready.nodes)).toEqual([]);
    expect(form(ready.nodes).props.method).toBe("post");
  });

  it("[guard] pending after readiness still disables the button (the duplicate guard is unchanged)", async () => {
    render(LoginPage);
    runEffects(BODY);
    const d = deferred<unknown>();
    publish.mockReturnValue(d.promise);
    const done = loginSubmit()(loginEvent());
    expect(button(render(LoginPage).nodes).props.disabled).toBe(true);
    d.resolve(REFUSED);
    await done;
    expect(button(render(LoginPage).nodes).props.disabled).toBe(false);
  });

  it("[guard] source: the form posts, the button waits for readiness, readiness is set only by a mount effect, no action URL, no timer", () => {
    const src = source("app/(auth)/login/page.tsx");
    expect(src.match(/<form method="post" onSubmit=\{handleSubmit\}/g)).toHaveLength(1);
    expect(src).toContain("disabled={loading || !ready}");
    expect(src).toMatch(/const \[ready, setReady\] = useState\(false\);/);
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s*setReady\(true\);\n\s*\}, \[\]\);/);
    expect(src.match(/setReady\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/<form[^>]*\saction=/);
    expect(src).not.toMatch(/setTimeout|setInterval|location\.reload/);
  });

  it("[taxonomy] the readiness note says what is needed, never names a provider reason or an account", () => {
    const text = (new RegExp('const SIGN_IN_NOT_READY = "([^"]*)";').exec(source("app/(auth)/login/page.tsx")) || [])[1] ?? "";
    expect(text).toBe(COPY.signInNotReady);
    expect(text).toMatch(/JavaScript/);
    expect(text).toMatch(/reload this page/);
    expect(text).not.toMatch(/account|password|invalid|exists|registered/i);
  });
});

// ── copy and source guards ──────────────────────────────────────────────────────────────────────────────
describe("copy and source guards", () => {
  const pageConstant = (rel: string, name: string) => (new RegExp(`const ${name} =\\s*"([^"]*)";`).exec(source(rel)) || [])[1] ?? "";
  // AG-AUTH-03: sign-up no longer redirects, so the copy no longer mentions being taken to the dashboard
  it("[taxonomy] the page's uncertainty copy does not say the account was not created, promises no redirect, and points to email or sign-in", () => {
    const text = pageConstant("app/(auth)/signup/page.tsx", "SIGN_UP_UNCONFIRMED");
    expect(text).not.toMatch(/wasn't created|was not created|not created|failed|couldn't create/i);
    expect(text).toMatch(/couldn't confirm whether/);
    expect(text).not.toMatch(/dashboard|taken to/i);
    expect(text).toMatch(/Check your email or try signing in before creating it again/);
  });

  it("[taxonomy] the completion claims no created account, no signed-in state and no sent email, and names one next step", () => {
    const heading = pageConstant("app/(auth)/signup/page.tsx", "CONTINUE_HEADING");
    const body = pageConstant("app/(auth)/signup/page.tsx", "CONTINUE_BODY");
    for (const text of [heading, body]) {
      expect(text).not.toMatch(/created|signed in(?! to)|logged in|welcome|sent|delivered|exists|registered|already/i);
    }
    expect(body).toMatch(/^Sign in to continue\./);
    expect(body).toMatch(/If email confirmation is required, check your inbox first\.$/);
  });

  it("[taxonomy] no page message names the provider's reason or says whether an account exists", () => {
    const texts = [pageConstant("app/(auth)/login/page.tsx", "SIGN_IN_FAILED"), pageConstant("app/(auth)/login/page.tsx", "SIGN_IN_INTERRUPTED"),
      pageConstant("app/(auth)/login/page.tsx", "SIGN_IN_UNSUPPORTED"),
      pageConstant("app/(auth)/signup/page.tsx", "SIGN_UP_FAILED"), pageConstant("app/(auth)/signup/page.tsx", "SIGN_UP_UNCONFIRMED"),
      pageConstant("app/(auth)/signup/page.tsx", "CONTINUE_HEADING"), pageConstant("app/(auth)/signup/page.tsx", "CONTINUE_BODY")];
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/exists|registered|not found|invalid|confirmed your|already have an account(?!, sign in instead)/i);
    }
  });

  it("[guard] the pages hold the exact copy constants", () => {
    const constant = (rel: string, name: string) => (new RegExp(`const ${name} =\\s*"([^"]*)";`).exec(source(rel)) || [])[1];
    expect(constant("app/(auth)/login/page.tsx", "SIGN_IN_FAILED")).toBe(COPY.signInFailed);
    expect(constant("app/(auth)/login/page.tsx", "SIGN_IN_INTERRUPTED")).toBe(COPY.signInInterrupted);
    expect(constant("app/(auth)/login/page.tsx", "SIGN_IN_UNSUPPORTED")).toBe(COPY.signInUnsupported);
    expect(constant("app/(auth)/signup/page.tsx", "SIGN_UP_FAILED")).toBe(COPY.signUpFailed);
    expect(constant("app/(auth)/signup/page.tsx", "SIGN_UP_UNCONFIRMED")).toBe(COPY.signUpUnconfirmed);
    expect(constant("app/(auth)/signup/page.tsx", "CONTINUE_HEADING")).toBe(COPY.continueHeading);
    expect(constant("app/(auth)/signup/page.tsx", "CONTINUE_BODY")).toBe(COPY.continueBody);
  });

  it("[guard] no storage, logging, URL parameters, cookie writes, timers or retry loops in either page", () => {
    for (const rel of ["app/(auth)/login/page.tsx", "app/(auth)/signup/page.tsx"]) {
      const src = source(rel);
      expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|URLSearchParams|searchParams|document\.cookie|setTimeout|setInterval|while\s*\(|for\s*\(/);
    }
  });

  // AG-AUTH-02: the setSessionAction call-site count was removed with the handoff (see the [retired-guard] checks)
  // A1: the one sign-in call site is signInAndPublish (it replaced the page's own signInWithPassword)
  it("[guard] the same calls: one sign-in call site (signInAndPublish) and one signupAction call site; the same destination", () => {
    const login = source("app/(auth)/login/page.tsx");
    const signupSrc = source("app/(auth)/signup/page.tsx");
    expect(login.match(/signInAndPublish\(/g)).toHaveLength(1);
    expect(login.match(/window\.location\.href = "\/dashboard";/g)).toHaveLength(1);
    expect(signupSrc.match(/await signupAction\(formData\)/g)).toHaveLength(1);
    expect(signupSrc).toContain("<form action={handleSubmit}");
    expect(login).toContain('<form method="post" onSubmit={handleSubmit}');
    for (const src of [login, signupSrc]) expect(src.match(/className="w-full min-h-11 /g)).toHaveLength(1); // 44px submit buttons
  });
});
