import { NextRequest, NextResponse } from "next/server";
import {
  END_INTENT_COOKIE,
  END_INTENT_MAX_AGE_S,
  isSessionLineageId,
  jwtClaims,
  parseCookieHeader,
  readEnvelope,
  readSessionLayout,
  sessionCookieKey,
  sessionLineageId,
} from "@/utils/supabase/session-cookie-layout";

/**
 * End Session (server side).
 *
 * POST-only. A GET logout would be triggerable by any link or <img> tag.
 *
 * With JavaScript, the End Session control ends the session in the browser
 * first (components/navigation/EndSessionForm.tsx →
 * utils/supabase/session-publication.ts: refresh if it must, revoke that
 * session at Auth with local scope, remove it — under the session-publication
 * lease, held until this request's redirect has replaced the page) and then
 * posts here without a session cookie, so this handler only redirects.
 *
 * Without JavaScript, before the page's script has started, or when the browser
 * could not hold the lease in time, the request carries the session itself.
 * This handler then REVOKES that session at Auth and never writes, refreshes
 * into the browser, or removes any session cookie: a response that removed
 * cookies would land in the browser whenever it arrives, and by then another tab
 * may have published a newer session under the same names — no Set-Cookie can
 * say "only if it still holds A". Revocation instead ends exactly the carried
 * session wherever it is held: Auth refuses its refresh token and, on every
 * server-verified page, its access token. The revoked cookies themselves stay
 * in the browser until the browser's own writer removes them (A2: the sign-in
 * page, acting on the END INTENT below, only while the jar still holds that
 * lineage), a later sign-in replaces them, or End Session runs with JavaScript;
 * until then, and until it expires, the access token remains a validly signed
 * JWT for any service that checks only its signature.
 * - It revokes with the carried access token (POST <project URL>/auth/v1/logout
 *   ?scope=local, as auth-js GoTrueAdminApi.signOut sends it). When Auth
 *   refuses that token (401/403: typically expired), it refreshes ONCE with the
 *   carried refresh token — solely to revoke: the new tokens are used for one
 *   logout and then dropped, never written, logged or returned — and logs out
 *   with the new access token. A3: only when that new token is still the
 *   form's account and lineage. The envelope carries its refresh token apart
 *   from its access token, so a jar mixing two sign-ins (expired A access, B or
 *   a newer A refresh) passes the access-token checks below; the refresh then
 *   returns the other sign-in's session, and no logout is sent with it: the
 *   answer is an honest 409 page saying nothing was ended (no retry form).
 *   That refresh has already rotated the other sign-in's refresh token at Auth
 *   and its result is dropped, so — with Auth's refresh-token reuse detection —
 *   the other sign-in's own next refresh after the reuse interval can be
 *   refused and end it.
 * - A4 (C2): a refresh REFUSED by Auth (any 4xx but a 429 rate limit: gone,
 *   already used, or uncoded) states no lineage: the carried refresh token is
 *   opaque and independent of the access token, so its refusal may describe
 *   another sign-in's spent token (another account's, or a newer one of the
 *   same account) and proves nothing about the requested session. It is
 *   reported as UNCONFIRMED: an honest 409 page saying it could not be confirmed that the
 *   requested sign-in was ended, no END INTENT, no second logout (there is no
 *   token to send one with), no cookie written. That the route sent nothing
 *   more does not mean the refresh attempt itself had no effect at Auth.
 * - The session counts as ended only when Auth confirms it for the requested
 *   session: a logout with its own access token (or, after one refresh, with a
 *   token proved to be its account and lineage) answered 2xx or 404. Then the
 *   answer is the honest "ended at the sign-in service, this device's copy still
 *   to be removed" page (A2, below). Otherwise (Auth unreachable, slow, or any
 *   other answer) the answer is an honest page saying the session was NOT
 *   ended, with a way to try again: never a redirect that implies it was.
 * - When the form names the account the page was rendered for and the carried
 *   session's token names another account (one signed in since, in this
 *   browser), it changes nothing and returns to /dashboard: End Session ends
 *   the account the golfer saw, never a later sign-in. When the form body
 *   cannot be read whole (too slow, over 4 KB, failed) or names an account in
 *   a form that is not a user id, which account was meant is unknown: nothing
 *   is revoked and the honest page says the session was not ended. A request
 *   that names no account or no lineage (a page from before the fields existed:
 *   the previous bundle's End Session is a plain form that posts no field at
 *   all) ends nothing either, and A5 (E1) says so: an honest 409 page (fixed
 *   copy, no retry form, nothing written) that points to /dashboard, whose End
 *   Session names the account and lineage it shows. Before A5 it returned
 *   silently to /dashboard, which, once the carried session had expired,
 *   resumed the very session the golfer had pressed End Session to end.
 * - A request carrying no usable session (none, or an ambiguous jar that holds
 *   no session for anyone) has nothing to revoke: 303 to /login.
 *
 * Budgets, on one clock: the form body (≤ 4 KB) is read within FORM_BUDGET_MS;
 * revocation — at most three Auth requests, each bounded at DISPATCH_MS for its
 * headers AND its whole body, never past the shared REVOKE_BUDGET_MS — runs
 * after it. So a request is answered within FORM_BUDGET_MS + REVOKE_BUDGET_MS
 * (9 s) of its arrival, plus local processing. Every Auth request is aborted and
 * every unread body cancelled when its exchange ends, so nothing outlives the
 * response.
 *
 * Scope is `local` by product decision: End Session ends this browser's session
 * only and leaves the golfer's other devices signed in. Every answer is
 * `Cache-Control: private, no-store`.
 *
 * A2 — lineage, and an honest completion:
 * - The form also names the session LINEAGE the page was rendered for
 *   (`expected_session`: a digest of the Auth session id, never a token;
 *   utils/supabase/session-cookie-layout.ts). The carried session is revoked
 *   only when it is that lineage, so a delayed or replayed request can never
 *   end a newer sign-in — not even a newer sign-in of the same golfer: it
 *   returns to /dashboard, changing nothing. A form naming no lineage is a page
 *   from before it was named: nothing is ended (as for no account; A5: the
 *   honest outdated-page answer above).
 * - When Auth confirmed the revocation of a session the request carried, the
 *   browser still holds its copy (this handler never clears cookies). The answer
 *   is then a page that says exactly that — ended at the sign-in service, this
 *   device's copy still to be removed, and, without JavaScript, how to remove
 *   it — instead of a redirect implying a complete sign-out. It also sets the
 *   END INTENT cookie (single-use, the lineage digest only; it removes nothing
 *   itself): with JavaScript the page continues to /login, where the browser's
 *   own writer removes the jar's session under the session-publication lease
 *   only if it is still that lineage, then deletes the intent
 *   (session-publication.ts completeEndedSession).
 * - A post without a session cookie (JavaScript End Session already removed it
 *   here) may say, as display only, that Auth did not confirm the revocation
 *   (`end_state=ended_unconfirmed`): when the post comes from this site's own
 *   page (Sec-Fetch-Site, else Origin), the answer then says the session was
 *   removed from this browser but its revocation was not confirmed. Otherwise:
 *   303 to /login.
 */
const DISPATCH_MS = 2_000;
const REVOKE_BUDGET_MS = 6_000;
const FORM_BUDGET_MS = 3_000;
const REFRESH_BODY_CAP_BYTES = 64 * 1024;
const FORM_BODY_CAP_BYTES = 4 * 1024;
const USER_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 303 to a path on the page's own origin. The Location is relative: the browser resolves it against the URL it actually
 * used, so the answer is right behind a TLS-terminating proxy or on a loopback address too (where the request URL the
 * server sees can carry another scheme, port or host), and it can never name another origin.
 */
function redirect(_req: NextRequest, path: "/login" | "/dashboard"): NextResponse {
  const response = new NextResponse(null, { status: 303, headers: { Location: path } });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/** The honest answer when the session could not be confirmed ended: fixed text, no provider text, no cookie. */
const NOT_ENDED_REASONS = {
  unreachable:
    "We couldn't reach the sign-in service to end your session, so you're still signed in on this device. Please try again in a moment.",
  unreadable:
    "We couldn't read your End Session request in full, so nothing was changed and you may still be signed in on this device. Please go back to the dashboard and try End Session again.",
} as const;

const PAGE_STYLE =
  "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:#0a0f0d;color:#e5e7eb;font-family:system-ui,sans-serif}main{max-width:28rem;width:100%;text-align:center}h1{font-size:1rem;letter-spacing:.1em;text-transform:uppercase}p{font-size:.9rem;color:#d1d5db;line-height:1.5}button,a{display:flex;align-items:center;justify-content:center;min-height:44px;width:100%;margin-top:12px;border-radius:16px;font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:.1em}button{border:0;background:#22c55e;color:#000;cursor:pointer}a{color:#9ca3af}</style>";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
${PAGE_STYLE}</head>
<body><main>${body}</main></body></html>`;
}

function notEnded(expectedUserId: string | null, expectedSession: string | null, reason: keyof typeof NOT_ENDED_REASONS): NextResponse {
  // A5 review: a retry is offered only when it can name the account AND the lineage again; a retry naming neither (an
  // unreadable request) would only meet the outdated-page answer, so that page offers the dashboard instead
  const retry =
    expectedUserId === null || expectedSession === null
      ? ""
      : `<form action="/api/auth/signout" method="POST"><input type="hidden" name="expected_user" value="${expectedUserId}"><input type="hidden" name="expected_session" value="${expectedSession}"><button type="submit">Try again</button></form>`;
  const html = page(
    "Session not ended",
    `<h1>Your session wasn't ended</h1><p role="status">${NOT_ENDED_REASONS[reason]}</p>
${retry}<a href="/dashboard">Back to dashboard</a>`,
  );
  return new NextResponse(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/**
 * A3 review: the carried session's refresh token turned out to belong to another sign-in (another account's, or a newer
 * one of the same account), so nothing was ended — neither the requested session nor that other one. An honest page with
 * fixed copy and no retry form: a retry would present that other sign-in's (now rotated) refresh token to Auth again.
 */
const OTHER_SIGN_IN =
  "This browser's saved sign-in didn't match the session you asked to end, so nothing was ended here. Open the dashboard to see which account is signed in on this device.";

function otherSignIn(): NextResponse {
  const html = page(
    "Session not ended",
    `<h1>Your session wasn't ended</h1><p role="status">${OTHER_SIGN_IN}</p><a href="/dashboard">Back to dashboard</a>`,
  );
  return new NextResponse(html, {
    status: 409,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/**
 * A4 (C2): the carried access token was refused and Auth refused the refresh made solely to revoke (gone, already used,
 * uncoded). That refusal names no sign-in (the refresh token may have been another sign-in's spent one), so neither
 * "ended" nor "not ended" is known: fixed copy that says exactly that, no END INTENT, no retry form (a retry would present the same refused token).
 */
const UNCONFIRMED_END =
  "We couldn't confirm that the requested sign-in was ended. Nothing more was sent to the sign-in service. Open the dashboard to see whether you're still signed in on this device.";

function unconfirmedEnd(): NextResponse {
  const html = page(
    "Session end not confirmed",
    `<h1>We couldn't confirm your session was ended</h1><p role="status">${UNCONFIRMED_END}</p><a href="/dashboard">Back to dashboard</a>`,
  );
  return new NextResponse(html, {
    status: 409,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/**
 * A5 (E1): a post that names no account or no lineage — the End Session form of a page from before End Session named
 * them (the previous bundle's control is a plain form that posts no field at all) — cannot say which sign-in was meant,
 * and the session the request carries may be a later one (another account's, or a newer sign-in of the same account).
 * Nothing is revoked, written or removed, and the target is never inferred from the jar. The answer says exactly that:
 * fixed copy, no retry form (a retry would post the same unnamed request), and a link to the dashboard, whose current
 * End Session names the account and lineage it shows (opening it ends nothing; only a deliberate press there does).
 */
const OUTDATED_END =
  "This page didn't say which sign-in to end (it may be from an earlier version of SwingProAI), so nothing was ended. Open the dashboard to see which account is signed in on this device, then use End Session there.";

function outdatedEnd(): NextResponse {
  const html = page(
    "Session not ended",
    `<h1>Your session wasn't ended</h1><p role="status">${OUTDATED_END}</p><a href="/dashboard">Back to dashboard</a>`,
  );
  return new NextResponse(html, {
    status: 409,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/** A2: fixed copy for a revocation Auth confirmed while this browser still holds its copy (see the header). */
const ENDED_AT_SERVER = {
  status: "The sign-in service confirmed your session has ended. This device still holds a copy of it until the sign-in page removes it.",
  noScript:
    "JavaScript is off, so the sign-in page can't remove that copy. The ended session can't be renewed and SwingProAI's pages won't accept it; to remove it from this device, turn on JavaScript and open the sign-in page, or clear this site's data in your browser settings.",
} as const;

/**
 * A2: Auth confirmed the revocation of the carried lineage; the browser's copy is still there. An honest page (no
 * redirect that implies a complete sign-out) and the single-use END INTENT naming that lineage (no credential, removes
 * nothing itself). With JavaScript the page continues to /login, which completes the removal under the lease.
 */
function endedAtServer(req: NextRequest, lineage: string): NextResponse {
  const html = page(
    "Session ended",
    `<h1>Your session was ended</h1><p role="status">${ENDED_AT_SERVER.status}</p>
<noscript><p>${ENDED_AT_SERVER.noScript}</p></noscript><a href="/login">Continue to sign in</a>
<script>window.location.replace("/login")</script>`,
  );
  const response = new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
  const secure = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  response.headers.append(
    "Set-Cookie",
    `${END_INTENT_COOKIE}=${lineage}; Path=/; Max-Age=${END_INTENT_MAX_AGE_S}; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
  return response;
}

/** A2: JavaScript End Session removed the session here but Auth did not confirm its revocation (display only). */
const ENDED_UNCONFIRMED =
  "Your session was removed from this browser, but we couldn't reach the sign-in service to confirm it was ended there as well.";

/**
 * A2: whether this post came from this site's own page: Sec-Fetch-Site says so (every current browser sends it), or,
 * where it is absent, the Origin is this request's own. Used only to decide what to display, never to authorise.
 */
function sameOriginPost(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = req.headers.get("origin");
  return origin !== null && origin === req.nextUrl.origin;
}

function endedUnconfirmed(): NextResponse {
  const html = page(
    "Signed out on this device",
    `<h1>You're signed out on this device</h1><p role="status">${ENDED_UNCONFIRMED}</p><a href="/login">Continue to sign in</a>`,
  );
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

/**
 * Reads a stream whole before `signal` aborts, or null when it is over `cap` bytes, errors, or is cut off by the abort
 * (the read is cancelled at once; a body cut short is never taken for a whole one, whatever the fetch implementation
 * does with its own stream on abort).
 */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) {
    stop();
    return null;
  }
  signal.addEventListener("abort", stop, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return null;
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        stop();
        return null;
      }
      parts.push(value);
    }
  } catch {
    stop();
    return null;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

type EndForm =
  | {
      readonly kind: "form";
      /** the account the page was rendered for, or null when the form names none */
      readonly user: string | null;
      /** the session lineage the page was rendered for (A2), or null when the form names none */
      readonly session: string | null;
      /** what JavaScript End Session reports it did in the browser (display only; authorises nothing) */
      readonly state: "ended" | "ended_unconfirmed" | null;
    }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/**
 * The End Session form. "none": the request has no url-encoded body. "unreadable": the body could not be read whole
 * (≤ 4 KB, by `deadline`), failed, or names an account or lineage in a form that is not one — which session the golfer
 * meant is unknown, so nothing may be revoked on its behalf. A form naming neither is a page from before they existed.
 */
async function endForm(req: NextRequest, deadline: number): Promise<EndForm> {
  const text = await formText(req, deadline);
  if (text === "none" || text === "unreadable") return { kind: text };
  const fields = new URLSearchParams(text);
  const user = fields.get("expected_user");
  const session = fields.get("expected_session");
  const state = fields.get("end_state");
  if (user !== null && !USER_ID_FORMAT.test(user)) return { kind: "unreadable" };
  if (session !== null && !isSessionLineageId(session)) return { kind: "unreadable" };
  return { kind: "form", user, session, state: state === "ended" || state === "ended_unconfirmed" ? state : null };
}

/**
 * The url-encoded body as text: "none" without one, "unreadable" when it cannot be read whole in time or within the cap.
 */
async function formText(req: NextRequest, deadline: number): Promise<string | "none" | "unreadable"> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded") || !req.body) return "none";
  const body = req.body;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  const reader = body.getReader();
  const read = (async (): Promise<string | null> => {
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FORM_BODY_CAP_BYTES) return null;
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return new TextDecoder().decode(bytes);
  })().catch(() => null);
  const text = await Promise.race([read, late]);
  clearTimeout(timer);
  void reader.cancel().catch(() => undefined); // read whole, over the cap, or too slow: nothing more is read
  return text === null ? "unreadable" : text;
}

interface Exchange {
  readonly status: number;
  /** the whole body when it was asked for and read within the cap and time; otherwise null */
  readonly body: Uint8Array | null;
}

/**
 * One POST to Auth (`path` relative to <project URL>/auth/v1/) whose headers AND body (when `readBody`) must both arrive
 * within DISPATCH_MS and before `deadline`; null when Auth did not answer in time or could not be reached. The request
 * is aborted and any unread body cancelled when the exchange ends, whatever its outcome.
 */
async function exchange(
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  deadline: number,
  readBody: boolean,
): Promise<Exchange | null> {
  const left = Math.min(DISPATCH_MS, deadline - Date.now());
  if (left <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), left);
  let response: Response | null = null;
  try {
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
    const url = new URL(path, new URL("auth/v1/", base.endsWith("/") ? base : `${base}/`));
    const sent = fetch(url, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", "X-Supabase-Api-Version": "2024-01-01", ...headers },
      body,
    });
    // the abort ends the wait for the headers even if the platform fetch were slow to honour it; a late answer is
    // cancelled unread
    const gaveUp = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("dispatch timed out")), { once: true });
    });
    gaveUp.catch(() => undefined); // the final abort below also settles it; that is not an error
    sent.then((late) => {
      if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined);
    }, () => undefined);
    response = await Promise.race([sent, gaveUp]);
    if (!readBody || !response.body) return { status: response.status, body: null };
    const bytes = await readCapped(response.body, REFRESH_BODY_CAP_BYTES, controller.signal);
    if (bytes === null && controller.signal.aborted) return null; // the body did not arrive in time
    return { status: response.status, body: bytes };
  } catch {
    return null; // unreachable, slow or refused
  } finally {
    clearTimeout(timer);
    void response?.body?.cancel().catch(() => undefined);
    controller.abort();
  }
}

const logoutConfirms = (status: number) => (status >= 200 && status <= 299) || status === 404;

/**
 * - "ended": Auth confirmed the intended session is ended.
 * - "not_ended": that could not be confirmed within the budget (Auth unreachable, slow, or another answer).
 * - "other_lineage" (A3): the refresh made solely to revoke returned a session that is not the intended lineage — the
 *   carried refresh token belonged to another sign-in (another account's, or a newer one of the same account), or the
 *   returned token names no lineage that can be computed. Nothing was logged out; the refresh itself may already have
 *   rotated that other sign-in's refresh token at Auth (the request cannot avoid that: a refresh token states no
 *   lineage until it is used).
 * - "unconfirmed" (A4 C2): the carried access token was refused and Auth refused the refresh (any 4xx but a 429: gone,
 *   already used, uncoded). The refusal names no sign-in, so it does not establish that the intended session ended (the
 *   refresh token may have been another sign-in's spent one). Nothing more was sent; the outcome is unknown, and is never
 *   reported as ended — nor as "unreachable", since Auth answered.
 */
type Revocation = "ended" | "not_ended" | "other_lineage" | "unconfirmed";

/**
 * Revokes the carried session at Auth (local scope), only as the lineage `intended` (the page's, already compared with
 * the carried access token). When Auth refuses the carried access token, one refresh supplies a current one for a
 * single logout; nothing from it is kept. A3: that second logout goes out only when the refreshed session is still the
 * intended account and lineage — the envelope's refresh token is carried independently of its access token, so it
 * could be another sign-in's, and a logout with what it returned would end that sign-in instead.
 */
async function revokeCarried(
  accessToken: string,
  refreshToken: string,
  intended: { readonly user: string; readonly lineage: string },
  deadline: number,
): Promise<Revocation> {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const first = await exchange("logout?scope=local", bearer(accessToken), undefined, deadline, false);
  if (first === null) return "not_ended";
  if (logoutConfirms(first.status)) return "ended";
  if (first.status !== 401 && first.status !== 403) return "not_ended";
  const refreshed = await exchange(
    "token?grant_type=refresh_token",
    { "Content-Type": "application/json;charset=UTF-8" },
    JSON.stringify({ refresh_token: refreshToken }),
    deadline,
    true,
  );
  if (refreshed === null) return "not_ended";
  // A4 (C2): a refusal states no lineage — never taken for the intended session's end; a rate limit is not a refusal
  if (refreshed.status === 429) return "not_ended";
  if (refreshed.status >= 400 && refreshed.status <= 499) return "unconfirmed";
  if (refreshed.status < 200 || refreshed.status > 299 || refreshed.body === null) return "not_ended";
  const current = readEnvelope(new TextDecoder().decode(refreshed.body))?.accessToken ?? null;
  if (current === null) return "not_ended";
  // A3: the returned session must still be the intended account and lineage before anything can target it
  if (jwtClaims(current).sub !== intended.user) return "other_lineage";
  if ((await sessionLineageId(current)) !== intended.lineage) return "other_lineage";
  const second = await exchange("logout?scope=local", bearer(current), undefined, deadline, false);
  return second !== null && logoutConfirms(second.status) ? "ended" : "not_ended";
}

export async function POST(req: NextRequest) {
  const arrived = Date.now();
  let key: string;
  try {
    key = sessionCookieKey(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    return redirect(req, "/login");
  }
  const layout = readSessionLayout(parseCookieHeader(req.headers.get("cookie") ?? ""), key);
  const envelope = layout.kind === "present" ? readEnvelope(layout.value) : null;
  const form = await endForm(req, arrived + FORM_BUDGET_MS);
  if (envelope === null) {
    // nothing usable to revoke; no cookie is touched. JavaScript End Session may report that Auth did not confirm the
    // revocation it attempted (display only): say so rather than imply a complete sign-out — but only for this site's
    // own page (another site's form could otherwise show it on this origin to a golfer who is still signed in)
    if (form.kind === "form" && form.state === "ended_unconfirmed" && sameOriginPost(req)) return endedUnconfirmed();
    return redirect(req, "/login");
  }
  // which session the golfer meant is unknown: revoke nothing (the session may be another sign-in's) and say so
  if (form.kind === "unreadable") return notEnded(null, null, "unreadable");
  // a page from before End Session named its account and lineage: nothing is ended, and (A5) the answer says so; the
  // dashboard's End Session names them
  if (form.kind === "none" || form.user === null || form.session === null) return outdatedEnd();
  const holder = jwtClaims(envelope.accessToken).sub;
  if (holder !== null && holder !== form.user) return redirect(req, "/dashboard");
  // A2: only the lineage the page was rendered for: never a newer sign-in, even of the same golfer
  const carried = await sessionLineageId(envelope.accessToken);
  if (carried === null || carried !== form.session) return redirect(req, "/dashboard");
  const revocation = await revokeCarried(
    envelope.accessToken,
    envelope.refreshToken,
    { user: form.user, lineage: carried },
    Date.now() + REVOKE_BUDGET_MS,
  );
  if (revocation === "ended") return endedAtServer(req, carried);
  // A3: the carried refresh token was another sign-in's: nothing was logged out, and that sign-in is never logged out
  // from here; the golfer is told nothing was ended (A3 review: not a silent return)
  if (revocation === "other_lineage") return otherSignIn();
  // A4 (C2): a refresh refusal proves nothing about the requested session: unconfirmed, never "ended"
  if (revocation === "unconfirmed") return unconfirmedEnd();
  return notEnded(form.user, form.session, "unreachable");
}
