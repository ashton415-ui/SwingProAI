import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-04 — sign-in, sign-up and landing pages.
 *
 * The two auth pages are driven through their real submit handlers with
 * spies in place of the auth calls: a fake browser client whose
 * `signInWithPassword` is a spy, and a spy for `signupAction`. AG-AUTH-02: the
 * sign-in page no longer calls a login Server Action; the real (retired) login
 * action module is loaded with any exported function recorded, and Server
 * Action cookie writes (`next/headers`) are recorded by name, so a handoff
 * would show. Nothing reaches a network, a database or a provider. React's
 * `useState`/`useEffect`/`useRef` are replaced by a small synchronous stand-in
 * so a page can be rendered, submitted and rendered again without a DOM
 * library; the form status hook is a stand-in the test sets. Every rendered
 * tree is turned into static markup by the real `react-dom/server`.
 *
 * This file deliberately imports nothing added by GJ-PARALLEL-04, so it also
 * runs against the accepted pre-change pages as a control: the presentation
 * checks fail there for the intended reasons, while the contract checks (the
 * credential read, the auth call arguments and order, the action arguments,
 * the redirect, the field names and validation) pass on both.
 * AG-AUTH-02 changed the sign-in contract deliberately (no token handoff after
 * a session), so its sign-in contract guard now fails on the earlier pages for
 * that reason; the other contract checks are unchanged.
 * AG-AUTH-03 changed the sign-up contract deliberately: the action returns one
 * of three fixed outcomes ({ outcome: "continue" | "failed" | "unconfirmed" })
 * instead of provider text and a dashboard redirect, and the page renders one
 * fixed completion. The sign-up expectations below use that contract; the
 * action itself is tested through the installed SDK in
 * lib/auth-signup-completion.test.ts.
 */

const hooks = vi.hoisted(() => ({
  state: [] as unknown[],
  i: 0,
  effects: [] as (() => unknown)[],
  formPending: false,
  signIn: null as null | ((...args: unknown[]) => unknown),
  signup: null as null | ((...args: unknown[]) => unknown),
  loginActionCalls: [] as string[], // AG-AUTH-02: names of login action exports called (none may be)
  cookieWrites: [] as string[], // AG-AUTH-02: names written to the server request cookie store (none may be)
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState(init: unknown) {
    const i = hooks.i++;
    if (!(i in hooks.state)) hooks.state[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      hooks.state[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.state[i]) : v;
    };
    return [hooks.state[i], set];
  }
  // Effects are collected per render and run on demand (runEffects); refs are plain objects the renderer fills in.
  const useEffect = (fn: () => unknown) => { hooks.effects.push(fn); };
  return { ...actual, default: actual, useState, useEffect, useRef: (v: unknown) => ({ current: v }) };
});
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, useFormStatus: () => ({ pending: hooks.formPending, data: null, method: null, action: null }) };
});
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { ...p, href: p.href }) };
});
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithPassword: (...a: unknown[]) => hooks.signIn!(...a) } }),
}));
vi.mock("@/app/(auth)/login/actions", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, v]) => [name, typeof v !== "function" ? v
    : (...a: unknown[]) => { hooks.loginActionCalls.push(name); return (v as (...x: unknown[]) => unknown)(...a); }]));
});
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined, getAll: () => [], has: () => false,
    set: (name: string) => { hooks.cookieWrites.push(name); }, delete: (name: string) => { hooks.cookieWrites.push(name); } }),
  headers: () => new Headers(),
}));
vi.mock("@/app/(auth)/signup/actions", () => ({ signupAction: (...a: unknown[]) => hooks.signup!(...a) }));
vi.mock("@/components/SplashScreen", () => ({ default: () => null }));

import LoginPage from "@/app/(auth)/login/page";
import SignupPage from "@/app/(auth)/signup/page";
import HomePage from "@/app/page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const SIGN_IN_FAILED = "We couldn't sign you in. Check your email and password, or try again in a moment.";
const SIGN_UP_FAILED =
  "We couldn't create your account. Check your details or try again in a moment. If you already have an account, sign in instead.";
// AG-AUTH-01: fixed copy for an attempt that did not complete (sign-in) or whose result is unknown (sign-up)
const SIGN_IN_INTERRUPTED = "We couldn't finish signing you in. Please try again in a moment.";
// AG-AUTH-03: the uncertainty copy no longer mentions the dashboard (sign-up no longer redirects), and the one completion
const SIGN_UP_UNCONFIRMED =
  "We couldn't confirm whether your account was created. Check your email or try signing in before creating it again.";
const CONTINUE_HEADING = "Continue with your account";
const CONTINUE_BODY = "Sign in to continue. If email confirmation is required, check your inbox first.";
// AG-AUTH-03: the action's fixed answers (what the page receives)
const FAILED = { outcome: "failed" } as const;
const CONTINUE = { outcome: "continue" } as const;
// Synthetic internal failure text: none of it may ever reach the page.
const RAW = 'Invalid login credentials: relation "auth.users" 42501 (synthetic) token=gj-synthetic-internal-7f3a';
const RAW_PARTS = /Invalid login credentials|auth\.users|42501|synthetic|token=|gj-synthetic|already registered|Email not confirmed|User not found|Login failed/i;
// Dummy form values, generated per run so no credential-like literal is kept in the test or its logs.
const DUMMY = { email: `golfer-${randomUUID()}@example.invalid`, password: randomUUID(), fullName: `Synthetic Golfer ${randomUUID().slice(0, 8)}` };

// ── a tiny synchronous renderer: function components are called, host elements kept ──────────────────────
type El = React.ReactElement<Record<string, unknown>>;
const FORWARD_REF = Symbol.for("react.forward_ref");
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
    // an object ref receives a stand-in node whose focus() is recorded
    const ref = (el as unknown as { ref?: unknown }).ref;
    if (ref && typeof ref === "object" && "current" in ref) {
      (ref as { current: unknown }).current = { id: props.id ?? null, focus: () => { focusLog.push(String(props.id ?? type)); } };
    }
    return [React.createElement(type, props, ...(expand(children) as React.ReactNode[]))];
  }
  throw new Error(`unexpected element type ${String(type)}`);
}
// Runs the effects of the latest render with `active` as document.activeElement; returns what received focus.
const focusLog: string[] = [];
const BODY = { id: "body" };
function runEffects(active: unknown = BODY) {
  focusLog.length = 0;
  (globalThis as Record<string, unknown>).document = { body: BODY, activeElement: active };
  try { for (const fn of hooks.effects) fn(); } finally { delete (globalThis as Record<string, unknown>).document; }
  return [...focusLog];
}
// Static markup of the expanded tree. Function props (handlers, the form action) are dropped first: they never
// appear in markup, and the stable react-dom/server used here warns about a function `action`.
function markup(nodes: unknown[]): React.ReactNode[] {
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n as React.ReactNode;
    const { children, ...props } = (n as El).props;
    const kept = Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v !== "function"));
    const kids = Array.isArray(children) ? children : children === undefined ? [] : [children];
    return React.createElement((n as El).type as string, kept, ...markup(kids));
  });
}
function render(Page: () => unknown) {
  hooks.i = 0;
  hooks.effects = [];
  const nodes = expand(React.createElement(Page as React.FC));
  const tree = React.createElement(React.Fragment, null, ...markup(nodes));
  return { nodes, html: renderToStaticMarkup(tree) };
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
const one = (nodes: unknown[], pred: (e: El) => boolean) => {
  const found = all(nodes, pred);
  expect(found).toHaveLength(1);
  return found[0];
};
const byType = (t: string) => (e: El) => e.type === t;
const alerts = (nodes: unknown[]) => all(nodes, (e) => e.props.role === "alert");
const submitButton = (nodes: unknown[]) => one(nodes, (e) => e.type === "button" && e.props.type === "submit");
const statusText = (nodes: unknown[]) => all(nodes, (e) => e.props.role === "status").map(textOf).join("|");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const fakeLoginEvent = (values: Record<string, string>) => ({
  preventDefault: vi.fn(),
  currentTarget: { elements: { namedItem: (n: string) => (n in values ? { value: values[n] } : null) } },
});
const signupData = () => {
  const fd = new FormData();
  fd.set("fullName", DUMMY.fullName);
  fd.set("email", DUMMY.email);
  fd.set("password", DUMMY.password);
  return fd;
};

let signIn: ReturnType<typeof vi.fn>;
let signup: ReturnType<typeof vi.fn>;
let win: { location: { href: string } };
beforeEach(() => {
  hooks.state = [];
  hooks.effects = [];
  hooks.formPending = false;
  signIn = vi.fn();
  signup = vi.fn();
  hooks.signIn = signIn;
  hooks.signup = signup;
  hooks.loginActionCalls = [];
  hooks.cookieWrites = [];
  win = { location: { href: "about:blank" } };
  (globalThis as Record<string, unknown>).window = win;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

// ── 1. form fields: labels, ids, autocomplete, and unchanged names/types/validation ─────────────────────
const LOGIN_FIELDS = [
  { name: "email", type: "email", label: /^Email address$/i, autoComplete: "username", required: true },
  { name: "password", type: "password", label: /^Password$/i, autoComplete: "current-password", required: true },
];
const SIGNUP_FIELDS = [
  { name: "fullName", type: "text", label: /^Full name$/i, autoComplete: "name", required: true },
  { name: "email", type: "email", label: /^Email address$/i, autoComplete: "email", required: true },
  { name: "password", type: "password", label: /^Password$/i, autoComplete: "new-password", required: true, minLength: 8 },
];

describe.each([
  ["login", LoginPage as () => unknown, LOGIN_FIELDS],
  ["signup", SignupPage as () => unknown, SIGNUP_FIELDS],
])("%s form fields", (_name, Page, fields) => {
  it("keeps the same field names, types and validation (contract guard)", () => {
    const { nodes } = render(Page);
    const inputs = all(nodes, byType("input"));
    expect(inputs.map((i) => [i.props.name, i.props.type, !!i.props.required, i.props.minLength ?? null])).toEqual(
      fields.map((f) => [f.name, f.type, f.required, (f as { minLength?: number }).minLength ?? null]),
    );
  });

  it("associates each visible label with a unique input id", () => {
    const { nodes, html } = render(Page);
    const inputs = all(nodes, byType("input"));
    const labels = all(nodes, byType("label"));
    expect(labels).toHaveLength(fields.length);
    const ids = inputs.map((i) => i.props.id);
    expect(new Set(ids).size).toBe(fields.length);
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      const input = inputs[k];
      expect(typeof input.props.id, f.name).toBe("string");
      const label = labels.find((l) => l.props.htmlFor === input.props.id);
      expect(label, `label for ${f.name}`).toBeDefined();
      expect(textOf(label).trim()).toMatch(f.label);
      expect(html.match(new RegExp(`id="${input.props.id}"`, "g"))).toHaveLength(1);
    }
  });

  it("names the autocomplete purpose of every field and leaves paste and zoom alone", () => {
    const { nodes, html } = render(Page);
    const inputs = all(nodes, byType("input"));
    expect(inputs.map((i) => i.props.autoComplete)).toEqual(fields.map((f) => f.autoComplete));
    expect(html).not.toMatch(/autocomplete="off"/i);
    // (the viewport meta is not rendered by these pages; the browser run checks zoom on the served page)
    for (const i of inputs) {
      expect(i.props.onPaste).toBeUndefined();
      expect(i.props.onCopy).toBeUndefined();
      // 16px text: phones do not zoom into the field on focus
      expect(String(i.props.className)).toMatch(/\btext-base\b/);
      // a visible focus indicator on the field itself
      expect(String(i.props.className)).toMatch(/focus:ring-2/);
    }
  });

  it("uses a main landmark, one h1 naming the page and readable, focusable account links", () => {
    const { nodes } = render(Page);
    one(nodes, byType("main"));
    const h1 = one(nodes, byType("h1"));
    expect(textOf(h1).trim()).toMatch(_name === "login" ? /^Sign in$/i : /^Create your account$/i);
    const links = all(nodes, byType("a"));
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link.props.href).toBe(_name === "login" ? "/signup" : "/login");
    expect(textOf(link).trim()).toMatch(_name === "login" ? /^Create an account$/ : /^Sign in$/);
    expect(String(link.props.className)).toMatch(/\bmin-h-11\b/);
    expect(String(link.props.className)).toMatch(/\bmin-w-11\b/);
    expect(String(link.props.className)).toMatch(/focus-visible:outline-2/);
    const button = submitButton(nodes);
    expect(String(button.props.className)).toMatch(/\bmin-h-11\b/);
    expect(String(button.props.className)).toMatch(/focus-visible:outline-2/);
  });
});

// ── 2. sign-in: idle, pending, returned failures, another attempt, and the unchanged call contract ─────────
describe("sign-in page", () => {
  it("idle: no alert, an empty status region and an idle submit button", () => {
    // AG-AUTH-01 R1: the server-rendered form cannot be submitted until the page's handler is ready
    const ssr = render(LoginPage);
    expect(submitButton(ssr.nodes).props.disabled).toBe(true);
    runEffects(); // hydrated
    const { nodes } = render(LoginPage);
    expect(alerts(nodes)).toHaveLength(0);
    expect(statusText(nodes)).toBe("");
    const b = submitButton(nodes);
    expect(textOf(b).trim()).toBe("Sign in");
    expect(b.props.disabled).toBe(false);
    expect(b.props["aria-busy"]).toBe(false);
  });

  it("pending then a returned failure: busy and announced, then one fixed message with no raw text", async () => {
    const d = deferred<unknown>();
    signIn.mockReturnValue(d.promise);
    render(LoginPage);
    runEffects(); // hydrated (AG-AUTH-01 R1: the button waits for the page's handler)
    const { nodes: n0 } = render(LoginPage);
    const ev = fakeLoginEvent(DUMMY);
    const submit = one(n0, byType("form")).props.onSubmit as (e: unknown) => Promise<void>;
    const done = submit(ev);
    const pending = render(LoginPage);
    const b = submitButton(pending.nodes);
    expect(b.props.disabled).toBe(true);
    expect(b.props["aria-busy"]).toBe(true);
    expect(textOf(b).trim()).toBe("Signing in…");
    expect(statusText(pending.nodes)).toBe("Signing in…");
    d.resolve({ data: { session: null, user: null }, error: { message: RAW, status: 400, code: "invalid_credentials" } });
    await done;
    const failed = render(LoginPage);
    const a = alerts(failed.nodes);
    expect(a).toHaveLength(1);
    expect(textOf(a[0]).trim()).toBe(SIGN_IN_FAILED);
    expect(a[0].props.tabIndex).toBe(-1);
    expect(failed.html).not.toMatch(RAW_PARTS);
    expect(failed.html).not.toContain(DUMMY.email);
    expect(submitButton(failed.nodes).props.disabled).toBe(false);
    expect(statusText(failed.nodes)).toBe("");
    // the fields keep their labels while the message shows
    expect(all(failed.nodes, byType("label"))).toHaveLength(2);
  });

  it("every returned failure shows the same message, so the page never says whether an account exists", async () => {
    const shown: string[] = [];
    // causes and shapes: wrong password, unconfirmed, unknown user, rate limit (429), a network failure the client
    // returns as AuthRetryableFetchError (status 0), and a provider message that echoes the entered email
    for (const error of [
      { message: "Invalid login credentials", status: 400 }, { message: "Email not confirmed", status: 400 }, { message: "User not found", status: 400 },
      { message: "Request rate limit reached", status: 429 }, { name: "AuthRetryableFetchError", message: "TypeError: fetch failed", status: 0 },
      { message: `Invalid login credentials for ${DUMMY.email}`, status: 400 }, { message: RAW, status: 400 },
    ]) {
      hooks.state = [];
      signIn.mockResolvedValueOnce({ data: { session: null, user: null }, error });
      const { nodes } = render(LoginPage);
      await (one(nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
      const after = render(LoginPage);
      shown.push(alerts(after.nodes).map(textOf).join("|"));
      expect(after.html).not.toMatch(RAW_PARTS);
      expect(after.html).not.toMatch(/fetch failed|TypeError/);
      expect(after.html).not.toContain(DUMMY.email);
    }
    hooks.state = [];
    signIn.mockResolvedValueOnce({ data: { session: null, user: null }, error: null }); // no error and no session
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    shown.push(alerts(render(LoginPage).nodes).map(textOf).join("|"));
    expect(new Set(shown)).toEqual(new Set([SIGN_IN_FAILED]));
  });

  it("another deliberate attempt clears the message while pending and shows it again on a second failure", async () => {
    signIn.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: RAW } });
    const submit = () => (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    await submit();
    expect(alerts(render(LoginPage).nodes)).toHaveLength(1);
    const d = deferred<unknown>();
    signIn.mockReturnValueOnce(d.promise);
    const second = submit();
    const during = render(LoginPage);
    expect(alerts(during.nodes)).toHaveLength(0);
    expect(statusText(during.nodes)).toBe("Signing in…");
    d.resolve({ data: { session: null, user: null }, error: { message: "Email not confirmed" } });
    await second;
    const again = render(LoginPage);
    expect(alerts(again.nodes).map(textOf)).toEqual([SIGN_IN_FAILED]);
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("focus after a failure: moves to the message only when it had fallen to the page", async () => {
    render(LoginPage);
    expect(runEffects(BODY)).toEqual([]); // idle: nothing to focus
    signIn.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: RAW } });
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    render(LoginPage);
    expect(runEffects(BODY)).toEqual(["login-error"]); // the pressed button was disabled, so focus was on the page
    render(LoginPage);
    expect(runEffects({ id: "login-password" })).toEqual([]); // submitted with Enter from a field: focus stays there
  });

  it("contract guard: reads the two named fields and calls signInWithPassword with exactly { email, password }", async () => {
    signIn.mockResolvedValue({ data: { session: null, user: null }, error: { message: RAW } });
    const ev = fakeLoginEvent(DUMMY);
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(ev);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn.mock.calls[0]).toEqual([{ email: DUMMY.email, password: DUMMY.password }]);
    expect(hooks.loginActionCalls).toEqual([]);
    expect(win.location.href).toBe("about:blank");
  });

  // AG-AUTH-02: replaces "on a session, hands the two tokens to setSessionAction, then goes to /dashboard"
  it("contract guard: on a session, goes straight to /dashboard; no login Server Action is called and no cookie is written through the server", async () => {
    signIn.mockResolvedValue({ data: { session: { access_token: "gj-synthetic-a", refresh_token: "gj-synthetic-r" } }, error: null });
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    const seen = { loginActionCalls: hooks.loginActionCalls, cookieWrites: hooks.cookieWrites };
    expect(seen, `observed ${JSON.stringify(seen)}`).toEqual({ loginActionCalls: [], cookieWrites: [] });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("/dashboard");
    // no success state is invented on the page
    expect(alerts(render(LoginPage).nodes)).toHaveLength(0);
  });

  // AG-AUTH-02: replaces "an error returned by the session action shows the fixed message" (the handoff is retired);
  // what the installed auth-js returns when the token response holds no usable session
  it("an invalid token response (the SDK's AuthInvalidTokenResponseError, no session) shows the fixed message and does not navigate", async () => {
    signIn.mockResolvedValue({ data: { session: null, user: null }, error: { name: "AuthInvalidTokenResponseError", message: RAW, status: 500 } });
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    const after = render(LoginPage);
    expect(alerts(after.nodes).map(textOf)).toEqual([SIGN_IN_FAILED]);
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(win.location.href).toBe("about:blank");
  });
});

// ── 3. sign-up: idle, pending, returned failures, another attempt, and the unchanged call contract ─────────
describe("sign-up page", () => {
  it("idle: no alert, an empty status region, an idle submit button and a persistent password hint", () => {
    const { nodes } = render(SignupPage);
    expect(alerts(nodes)).toHaveLength(0);
    expect(statusText(nodes)).toBe("");
    const b = submitButton(nodes);
    expect(textOf(b).trim()).toBe("Create account");
    expect(b.props.disabled).toBe(false);
    expect(b.props["aria-busy"]).toBe(false);
    const password = one(nodes, (e) => e.type === "input" && e.props.name === "password");
    const hint = one(nodes, (e) => e.props.id === password.props["aria-describedby"]);
    expect(textOf(hint).trim()).toBe("At least 8 characters.");
  });

  it("the form status marks the submit button busy and announces it, and an earlier failure is hidden meanwhile", async () => {
    signup.mockResolvedValueOnce(FAILED);
    await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
    expect(alerts(render(SignupPage).nodes)).toHaveLength(1);
    hooks.formPending = true; // React's form status while the action request is in flight
    hooks.state[1] = false; // in the browser, `loading` set inside the form action is held until the action ends
    const pending = render(SignupPage);
    const b = submitButton(pending.nodes);
    // AG-AUTH-01: the button is disabled by the form's effective pending state, so a second press submits nothing
    expect(b.props.disabled).toBe(true);
    expect(b.props["aria-busy"]).toBe(true);
    expect(textOf(b).trim()).toBe("Creating account…");
    expect(statusText(pending.nodes)).toBe("Creating account…");
    expect(alerts(pending.nodes)).toHaveLength(0);
  });

  // AG-AUTH-03: the action now returns a fixed outcome, never the provider's message (its causes are covered in
  // lib/auth-signup-completion.test.ts); a returned failure that also carries extra fields shows none of them
  it("a returned failure shows one fixed message with no raw text, whatever else its answer carries", async () => {
    const shown: string[] = [];
    for (const answer of [FAILED, { ...FAILED, message: "User already registered" }, { ...FAILED, error: RAW },
      { ...FAILED, detail: `User ${DUMMY.email} (${DUMMY.fullName}) already registered` }]) {
      hooks.state = [];
      signup.mockResolvedValueOnce(answer);
      await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
      const after = render(SignupPage);
      const a = alerts(after.nodes);
      expect(a).toHaveLength(1);
      expect(a[0].props.tabIndex).toBe(-1);
      shown.push(textOf(a[0]).trim());
      expect(after.html).not.toMatch(RAW_PARTS);
      expect(after.html).not.toContain(DUMMY.email);
      expect(after.html).not.toContain(DUMMY.fullName);
      expect(submitButton(after.nodes).props.disabled).toBe(false);
      expect(all(after.nodes, byType("label"))).toHaveLength(3);
    }
    expect(new Set(shown)).toEqual(new Set([SIGN_UP_FAILED]));
  });

  it("contract guard: passes the submitted FormData to signupAction once, unchanged", async () => {
    signup.mockResolvedValueOnce(FAILED);
    const fd = signupData();
    await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(fd);
    expect(signup).toHaveBeenCalledTimes(1);
    expect(signup.mock.calls[0][0]).toBe(fd);
  });

  it("focus after a failure: the message takes focus only when focus had fallen to the page", async () => {
    signup.mockResolvedValueOnce(FAILED);
    await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
    render(SignupPage);
    expect(runEffects(BODY)).toEqual(["signup-error"]);
    render(SignupPage);
    expect(runEffects({ id: "submit-button" })).toEqual([]); // focus still on the pressed button: left there
  });

  it("when the action returns nothing, its own uncertain outcome, or an answer that is not the action's, the page claims neither success nor failure", async () => {
    for (const answer of [undefined, { outcome: "unconfirmed" }, { error: RAW }, { outcome: "continued" }]) {
      hooks.state = [];
      signup.mockResolvedValueOnce(answer);
      await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
      const after = render(SignupPage);
      // AG-AUTH-01: the fixed uncertainty message, never the failure message and never a success claim; the form settles
      expect(alerts(after.nodes).map(textOf)).toEqual([SIGN_UP_UNCONFIRMED]);
      expect(after.html).not.toMatch(/welcome|you(?:'|&#x27;)re signed in|account (?:has been|is) created|confirmed your email/i);
      expect(after.html).not.toMatch(RAW_PARTS);
      expect(submitButton(after.nodes).props.disabled).toBe(false);
    }
  });

  it("another deliberate attempt after a failure calls the action again and shows the message again", async () => {
    const action = () => (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
    signup.mockResolvedValueOnce(FAILED);
    await action();
    signup.mockResolvedValueOnce(FAILED);
    await action();
    expect(signup).toHaveBeenCalledTimes(2);
    expect(alerts(render(SignupPage).nodes).map(textOf)).toEqual([SIGN_UP_FAILED]);
  });

  // AG-AUTH-03: the action's completion replaces the form with one fixed next step, whatever the answer was
  it("the completion: the fixed heading, body and one 44px sign-in link to /login; no form, alert, status or claim", async () => {
    signup.mockResolvedValueOnce(CONTINUE);
    await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
    const { nodes, html } = render(SignupPage);
    expect(textOf(one(nodes, byType("h1"))).trim()).toBe("Create your account");
    const heading = one(nodes, byType("h2"));
    expect(textOf(heading).trim()).toBe(CONTINUE_HEADING);
    expect(heading.props.tabIndex).toBe(-1);
    expect(all(nodes, (e) => e.type === "p" && textOf(e).trim() === CONTINUE_BODY)).toHaveLength(1);
    const link = one(nodes, byType("a"));
    expect([link.props.href, textOf(link).trim()]).toEqual(["/login", "Sign in"]);
    expect(String(link.props.className)).toMatch(/\bmin-h-11\b/);
    expect(String(link.props.className)).toMatch(/focus-visible:outline-2/);
    expect(all(nodes, byType("form"))).toHaveLength(0);
    expect(all(nodes, byType("input"))).toHaveLength(0);
    expect(alerts(nodes)).toHaveLength(0);
    expect(statusText(nodes)).toBe("");
    expect(html).not.toMatch(/welcome|you(?:'|&#x27;)re signed in|account (?:has been|was|is) created|we(?:'|&#x27;)ve sent|email (?:has been|was) sent/i);
    expect(html).not.toContain(DUMMY.email);
    expect(html).not.toContain(DUMMY.fullName);
    expect(win.location.href).toBe("about:blank");
    // focus that fell to the page goes to the heading; focus elsewhere stays
    expect(runEffects(BODY)).toEqual(["signup-continue-heading"]);
    render(SignupPage);
    expect(runEffects({ id: "elsewhere" })).toEqual([]);
  });
});

// ── 4. contract guards: the submit handlers' behaviour, the copy, the wiring, and the unchanged server files ──
describe("byte-level contract guards", () => {
  // AG-AUTH-01 replaced the two accepted handler snapshots (which pinned the handlers' text) with behaviour: the
  // handlers now guard a second submit and recover from thrown or unusable results, and these tests pin what they do.
  it("the sign-in handler: a second submit while one is running makes no second call; a thrown request settles with fixed copy", async () => {
    render(LoginPage);
    runEffects(); // hydrated (AG-AUTH-01 R1: the button waits for the page's handler)
    const d = deferred<unknown>();
    signIn.mockReturnValueOnce(d.promise);
    const submit = one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>;
    const first = submit(fakeLoginEvent(DUMMY));
    const ev2 = fakeLoginEvent(DUMMY);
    await submit(ev2); // the same handler again, before the first has finished
    expect(ev2.preventDefault).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledTimes(1);
    d.resolve({ data: { session: null, user: null }, error: { message: RAW } });
    await first;
    signIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await (one(render(LoginPage).nodes, byType("form")).props.onSubmit as (e: unknown) => Promise<void>)(fakeLoginEvent(DUMMY));
    const after = render(LoginPage);
    expect(alerts(after.nodes).map(textOf)).toEqual([SIGN_IN_INTERRUPTED]);
    expect(submitButton(after.nodes).props.disabled).toBe(false);
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(win.location.href).toBe("about:blank");
  });
  it("the sign-up handler: a second submission while one is running makes no second call; a thrown action settles with the uncertainty copy", async () => {
    const d = deferred<unknown>();
    signup.mockReturnValueOnce(d.promise);
    const action = one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>;
    const first = action(signupData());
    await action(signupData()); // the same action again, before the first has finished
    expect(signup).toHaveBeenCalledTimes(1);
    d.resolve(FAILED);
    await first;
    signup.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await (one(render(SignupPage).nodes, byType("form")).props.action as (f: FormData) => Promise<void>)(signupData());
    const after = render(SignupPage);
    expect(alerts(after.nodes).map(textOf)).toEqual([SIGN_UP_UNCONFIRMED]);
    expect(submitButton(after.nodes).props.disabled).toBe(false);
    expect(after.html).not.toMatch(RAW_PARTS);
    expect(signup).toHaveBeenCalledTimes(2);
  });
  it("every outcome shows exactly one of the fixed message constants, and the constants hold the expected copy", () => {
    const login = source("app/(auth)/login/page.tsx");
    const signupSrc = source("app/(auth)/signup/page.tsx");
    expect(Array.from(login.matchAll(/setError\(([^;]*)\);/g)).map((m) => m[1])).toEqual(["null", "message"]);
    // AG-AUTH-02: the three handoff outcomes (lost, error, unusable answer) went with the handoff
    expect(Array.from(login.matchAll(/\bstop\(([^)]*)\);/g)).map((m) => m[1])).toEqual(["SIGN_IN_FAILED", "SIGN_IN_INTERRUPTED"]);
    // AG-AUTH-03: the fixed outcome decides; the one completion is the only other settled state
    expect(Array.from(signupSrc.matchAll(/setError\(([^;]*)\);/g)).map((m) => m[1])).toEqual(
      ["null", 'outcome === "failed" ? SIGN_UP_FAILED : SIGN_UP_UNCONFIRMED']);
    expect(Array.from(signupSrc.matchAll(/setCompleted\(([^;]*)\);/g)).map((m) => m[1])).toEqual(["true"]);
    const constant = (rel: string, name: string) => (new RegExp(`const ${name} =\\s*"([^"]*)";`).exec(source(rel)) || [])[1];
    expect(constant("app/(auth)/login/page.tsx", "SIGN_IN_FAILED")).toBe(SIGN_IN_FAILED);
    expect(constant("app/(auth)/login/page.tsx", "SIGN_IN_INTERRUPTED")).toBe(SIGN_IN_INTERRUPTED);
    expect(constant("app/(auth)/signup/page.tsx", "SIGN_UP_FAILED")).toBe(SIGN_UP_FAILED);
    expect(constant("app/(auth)/signup/page.tsx", "SIGN_UP_UNCONFIRMED")).toBe(SIGN_UP_UNCONFIRMED);
    expect(constant("app/(auth)/signup/page.tsx", "CONTINUE_HEADING")).toBe(CONTINUE_HEADING);
    expect(constant("app/(auth)/signup/page.tsx", "CONTINUE_BODY")).toBe(CONTINUE_BODY);
  });
  it("the forms keep their wiring: sign-in submits through onSubmit, sign-up through the form action", () => {
    const login = one(render(LoginPage).nodes, byType("form"));
    expect(typeof login.props.onSubmit).toBe("function");
    expect(login.props.action).toBeUndefined();
    const signupForm = one(render(SignupPage).nodes, byType("form"));
    expect(typeof signupForm.props.action).toBe("function");
    expect(signupForm.props.onSubmit).toBeUndefined();
  });
  it("the auth actions, callback, Supabase utilities, middleware and dashboard layout are byte-identical to the accepted files", () => {
    // hashed with line endings normalised to LF, so a CRLF checkout compares the same bytes
    const sha = (rel: string) => createHash("sha256").update(source(rel)).digest("hex");
    expect(Object.fromEntries(Object.keys(ACCEPTED_SHA).map((rel) => [rel, sha(rel)]))).toEqual(ACCEPTED_SHA);
  });
});
// SHA-256 of the accepted (GJ-PARALLEL-03 end) files, LF line endings.
const ACCEPTED_SHA: Record<string, string> = {
  "app/(auth)/login/actions.ts": "63d7b7bdf2158fa946c4672e394efe156409d5c65c613b3b98f2dd415f6e2958", // AG-AUTH-02: the retired module (no export, no cookie write)
  "app/(auth)/signup/actions.ts": "677d36755b7252402bc0278f7f2f0b42ac911ea2f06b4312f062f1e2b3f618b6", // AG-AUTH-03: fixed outcomes only; no provider text, no redirect, no session use
  "app/(auth)/auth/callback/route.ts": "521e9a1d068247e55234b2b5613fdb9a6f361050579f79810f6286da1f3395d4",
  "utils/supabase/client.ts": "f937ab3b250769d442c81b1e3845c30a26ff93adb7872bbe4b0d21145bfc4ff4", // AG-SESSION-03: the 0.3.0 get/set/remove adapter; 30-day, Secure-on-HTTPS session-cookie writes
  "utils/supabase/server.ts": "43e341460fa254d92bcd041774c6b085ab99931c9dc4cf631d6959d9c921fe74",
  "middleware.ts": "2eeae0934c1d87a6bc985ddc90b56178752f9943c0eb4425b87fab12556f1026", // AG-SESSION-02: the protected matcher and one call to the refresh boundary
  "app/(dashboard)/layout.tsx": "9a23da7e57dab5eff961ccdbb43a55200840b5430f0ca5f16f6bfddde07bfeb0",
};

// ── 5. landing page: truthful copy, the same destinations, usable links ──────────────────────────────────
// Visible text of rendered markup, with the entities react-dom/server writes decoded.
const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
describe("landing page", () => {
  const page = () => render(HomePage as () => unknown);
  const UNSUPPORTED =
    /real[- ]?time|tour[- ]level|professional[- ]grade|pro analytics|biomechanic|tempo|spine angle|rotational velocity|x-factor|hip sway|head drop|swing plane|telemetry|verify if you|master your mechanics/i;

  it("makes no real-time, tour-level or precise biomechanical measurement claim", () => {
    const { html } = page();
    expect(plain(html)).not.toMatch(UNSUPPORTED);
  });

  it("describes AI output as observations and suggestions, not measurement or a coach's review", () => {
    const text = plain(page().html);
    expect(text).toContain("It isn't a measurement or a coach's review.");
    expect(text).toMatch(/AI observations about your setup and motion/);
    expect(text).toMatch(/AI-generated practice plan/);
  });

  it("names putting only as limited to eligible plans", () => {
    const text = plain(page().html);
    expect(text).toMatch(/putting stroke[^.]*\. Available on eligible plans only\./i);
  });

  it("covers swing review, goals and practice, drills, bag and past reviews, and progress — as a list", () => {
    const { nodes } = page();
    const titles = all(nodes, byType("h3")).map((h) => textOf(h).trim());
    expect(titles).toEqual([
      "AI Swing Review", "Putting Feedback", "Goals and Practice Plan", "Drill Hub", "My Bag and Past Reviews", "Progress Hub",
    ]);
    expect(one(nodes, byType("ul")).props.role).toBe("list");
    expect(all(nodes, byType("li"))).toHaveLength(6);
    // the cards are not links, so they do not change on hover as if they were
    for (const li of all(nodes, byType("li"))) expect(String(li.props.className)).not.toMatch(/hover:/);
  });

  it("does not claim one combined bag-and-history place or a trend view", () => {
    const text = plain(page().html);
    expect(text).not.toMatch(/together in one place|swing history together|bag and swing history|change over time|trend/i);
    expect(plain(page().html)).toMatch(/Review Your Swing\. Practice With a Plan\./);
  });

  it("invents no endorsement, user count, accuracy figure, price, date or licensed data", () => {
    const text = plain(page().html);
    expect(text).not.toMatch(/\$\d|\d+%|\d[\d,]*\+? (golfers|users|players)|accura|trusted by|endorsed|PGA|iGolf|GPS|coming soon|20\d\d|launch(es|ing)? (on|in)/i);
  });

  it("keeps the sign-in, sign-up and View Plans destinations, with 44px targets and visible focus", () => {
    const links = all(page().nodes, byType("a"));
    expect(links.map((l) => [textOf(l).trim(), l.props.href])).toEqual([
      ["Sign In", "/login"],
      ["Get Started", "/signup"],
      ["Get Started", "/signup"],
      ["View Plans", "/upgrade"],
    ]);
    for (const l of links) {
      expect(String(l.props.className)).toMatch(/\bmin-h-11\b/);
      expect(String(l.props.className)).toMatch(/focus-visible:outline-2/);
    }
  });

  it("has a banner, a labelled navigation, a main landmark and one h1; decorative icons are hidden", () => {
    const { nodes, html } = page();
    one(nodes, byType("header"));
    expect(one(nodes, byType("nav")).props["aria-label"]).toBe("Account");
    one(nodes, byType("main"));
    one(nodes, byType("h1"));
    const svgs = all(nodes, byType("svg"));
    expect(svgs.length).toBeGreaterThan(0);
    for (const s of svgs) expect(s.props["aria-hidden"]).toBe("true");
    // the header logo names the brand once (its CSS-uppercased wordmark is hidden from assistive technology); the
    // large hero mark is decorative
    const imgs = all(nodes, byType("img"));
    expect(imgs.map((i) => i.props.alt)).toEqual(["SwingProAI", ""]);
    const wordmark = one(nodes, (e) => e.type === "span" && /^Swing ?Pro ?AI$/.test(textOf(e).trim()));
    expect(wordmark.props["aria-hidden"]).toBe("true");
    expect(plain(html)).toMatch(/Swing ?Pro ?AI/);
  });

  it("the page description makes no real-time claim either", async () => {
    const mod = (await import("@/app/page")) as { metadata?: { description?: string } };
    expect(mod.metadata?.description ?? "").not.toMatch(UNSUPPORTED);
    expect(mod.metadata?.description).toBeTruthy();
  });
});
