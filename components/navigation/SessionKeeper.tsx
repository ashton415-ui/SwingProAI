"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { createClient } from "@/utils/supabase/client";
import { jwtClaims, parseCookieHeader, readBinding } from "@/utils/supabase/session-cookie-layout";
import { readStoredSession } from "@/utils/supabase/session-storage";

/**
 * Mounted once in the dashboard layout; renders nothing. Creating the shared browser client starts the SDK's own
 * session upkeep on every dashboard page — start-up recovery, the auto-refresh ticker while the page is visible, the
 * refresh on returning to it — all through the session-publication lease, so the session cookie stays current for
 * page navigations. The server no longer refreshes (utils/supabase/session-resume.ts).
 *
 * Server Actions. A Server Action is a POST from this page to its own path, carrying the session cookie; the server
 * verifies the access token it carries and never refreshes it. The previous middleware refreshed an expiring session on
 * that POST; now the browser must. While the page is visible the SDK's ticker keeps the session fresh, but after the
 * tab was hidden (the ticker stops) or the device slept, the first action can leave before the SDK's catch-up refresh
 * has finished, carrying an expired token ("Not authenticated."). So this keeper holds each same-origin Server Action
 * request (`Next-Action` header) whose stored session expires within the SDK's refresh margin until the shared
 * client's getSession() has refreshed it under the lease (joining a refresh already running), for at most
 * ACTION_WAIT_MS; then the request goes as it was, with whatever the jar holds. Nothing about the request is changed and
 * no other request is held. When the session cannot be refreshed or verified (an Auth outage, another tab's write not
 * visible here), the action still goes and the server's own verification decides, as it would have. If the jar names a
 * different account after the wait than before it (another sign-in published meanwhile), the action is not sent: it was
 * rendered for the account that was signed in, and the caller gets a rejected request, as for a network failure.
 */
const ACTION_REFRESH_MARGIN_MS = 90_000; // auth-js EXPIRY_MARGIN_MS: getSession refreshes a session inside it
const ACTION_WAIT_MS = 8_000;

/*
 * A2 — rollout: taking the refresh before a previous bundle's tab does.
 *
 * A tab still running the previous deployment's page refreshes the shared session with its own SDK once it finds the
 * session inside that SDK's threshold (auth-js 2.107: the ticker at ≤ 3 ticks of 30 s left, a read at < 90 s). Its write
 * carries no binding (utils/supabase/session-cookie-layout.ts), so every current page refuses that session until the
 * golfer signs in again — and the same happens at every later expiry while that tab stays open. So while any current
 * dashboard page is open, this keeper refreshes the session through the lease once it is within KEEPER_LEAD (5 minutes,
 * at most half the token's lifetime) of its expiry: an old tab then never finds it expiring and never writes. The
 * refresh names the exact token seen expiring, so it is idempotent across tabs: a tab whose jar no longer holds that
 * token is answered from the jar without any request (utils/supabase/client.ts).
 *
 * And the fence's first moment: a jar with no binding at all was last written before the current writer ran in this
 * browser (the legacy state the server still accepts). The first current dashboard page that finds one refreshes it
 * once, at once, through the same lease, so the binding exists from then on instead of from the session's next expiry
 * (a failed attempt is tried again at most twice more on that page). A session this browser cannot verify is never
 * refreshed (the transport sends nothing for an untrusted view).
 *
 * Only while the page is visible — exactly when the SDK's own upkeep runs — so a hidden or background tab keeps no
 * session alive that it would not have kept before (session lifetime policy is unchanged; the cost: a visible previous-
 * bundle tab beside only hidden current pages can still refresh first). And never again within half the token's
 * lifetime of this page's previous keeper refresh (monotonic clock), so a device clock far ahead of Auth's — every new
 * token looking "due" at once — cannot make it refresh again and again.
 */
const KEEPER_LEAD_MAX_MS = 300_000;
const KEEPER_CHECK_MS = 15_000;
const KEEPER_LEGACY_ATTEMPTS = 3;

/**
 * The refresh token the keeper should refresh now, or null: the stored session is within its lead of expiry, or (once
 * per page) it carries no binding at all. `spacingMs`: how long this page then waits before another keeper refresh.
 * Read only to decide; the token is handed to the shared client and nowhere else.
 */
export function keeperRefreshDue(
  now: number,
  legacyChecked: boolean,
): { readonly token: string; readonly legacy: boolean; readonly spacingMs: number } | null {
  try {
    const stored = readStoredSession();
    if (stored.kind !== "present") return null;
    const { expiresAt, refreshToken } = stored.envelope;
    const lifetimeMs = Number(stored.envelope.stored["expires_in"]) * 1000;
    const spacingMs = Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs / 2 : KEEPER_LEAD_MAX_MS;
    if (!legacyChecked && readBinding(parseCookieHeader(document.cookie)).kind === "absent") return { token: refreshToken, legacy: true, spacingMs };
    if (expiresAt === null || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return null;
    const lead = Math.min(KEEPER_LEAD_MAX_MS, lifetimeMs / 2);
    return expiresAt * 1000 - now < lead ? { token: refreshToken, legacy: false, spacingMs } : null;
  } catch {
    return null;
  }
}

/** The shared client's one call the keeper uses (structural, so tests can drive the real client or a stand-in). */
interface KeeperClient {
  readonly auth: { refreshSession(current: { refresh_token: string }): PromiseLike<{ readonly error: unknown }> };
}

/**
 * Starts this page's session upkeep (see above): a check now and every KEEPER_CHECK_MS, acting only while the page is
 * visible, one refresh at a time, spaced, with the bounded one-time binding refresh. Returns the stop.
 */
export function startSessionUpkeep(client: KeeperClient): () => void {
  let legacyChecked = false;
  let legacyAttempts = 0;
  let refreshing = false;
  let lastRefreshAt = -Infinity;
  const keep = () => {
    if (refreshing || typeof document === "undefined" || document.visibilityState !== "visible") return;
    const due = keeperRefreshDue(Date.now(), legacyChecked);
    if (due === null) return;
    if (!due.legacy && performance.now() - lastRefreshAt < due.spacingMs) return;
    if (due.legacy) {
      legacyChecked = true;
      legacyAttempts += 1;
    }
    refreshing = true;
    lastRefreshAt = performance.now();
    const failed = () => {
      if (due.legacy && legacyAttempts < KEEPER_LEGACY_ATTEMPTS) legacyChecked = false; // tried again at the next check
    };
    void Promise.resolve()
      .then(() => client.auth.refreshSession({ refresh_token: due.token }))
      .then((result) => {
        if (result?.error) failed();
      }, failed)
      .finally(() => {
        refreshing = false;
      });
  };
  keep();
  const ticker = setInterval(keep, KEEPER_CHECK_MS);
  const onVisible = () => keep();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function isServerAction(input: RequestInfo | URL, init: RequestInit | undefined, origin: string): boolean {
  try {
    const request = typeof input === "object" && "method" in input ? (input as Request) : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method !== "POST") return false;
    const headers = new Headers(init?.headers ?? request?.headers);
    if (!headers.has("next-action")) return false;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url, origin);
    return url.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** The stored session: whether it expires within the refresh margin, and whose it is (read only to decide; never used). */
function storedState(): { readonly expiringSoon: boolean; readonly sub: string | null } {
  try {
    const stored = readStoredSession();
    if (stored.kind !== "present") return { expiringSoon: false, sub: null };
    const { expiresAt, accessToken } = stored.envelope;
    return { expiringSoon: expiresAt !== null && expiresAt * 1000 - Date.now() < ACTION_REFRESH_MARGIN_MS, sub: jwtClaims(accessToken).sub };
  } catch {
    return { expiringSoon: false, sub: null };
  }
}

function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work.then(() => undefined, () => undefined), late]).finally(() => clearTimeout(timer));
}

/**
 * `original` with same-origin Server Action requests held for an expiring session's refresh (see above). `origin` is the
 * page's own origin.
 */
export function serverActionFetch(
  original: typeof fetch,
  client: { readonly auth: { getSession(): PromiseLike<unknown> } },
  origin: string,
): typeof fetch {
  return async (input, init) => {
    if (isServerAction(input, init, origin)) {
      const before = storedState();
      if (before.expiringSoon) {
        await settledWithin(Promise.resolve(client.auth.getSession()), ACTION_WAIT_MS);
        const after = storedState();
        if (before.sub !== null && after.sub !== null && after.sub !== before.sub) {
          throw new TypeError("Failed to fetch"); // another account was signed in meanwhile: the action is not sent
        }
      }
    }
    return original(input, init);
  };
}

/*
 * A3 — the account a dashboard page was rendered for.
 *
 * The dashboard layout verifies the session server-side (utils/supabase/server.ts getServerSession) before it renders
 * anything, and renders its End Session controls for that account and session lineage. RenderedSessionProvider carries
 * exactly those two non-credential facts — the verified user id and the lineage digest (session-cookie-layout.ts
 * sessionLineageId; never a token) — to the client pages below it, so a page can send its requests only as the account
 * it was rendered for (lib/drill-hub-session.ts ownerBoundClient / confirmOwnerSession + ownerBearer: A4, the Analyze
 * page and the analysis report) instead of adopting whichever session the browser happens to hold when it first looks. The
 * layout stays mounted across client navigation inside the dashboard, so a page reached that way gets the account the
 * layout was rendered for; a browser now signed in to another account is then refused, never adopted, until a reload
 * renders the layout for it. A page rendered outside the provider gets null: it has no account to send as.
 */
export interface RenderedSession {
  /** the user id the server verified and rendered the dashboard for */
  readonly ownerId: string;
  /** the rendered session lineage (a digest of the Auth session id), or null when it could not be computed */
  readonly lineage: string | null;
}

const RenderedSessionContext = createContext<RenderedSession | null>(null);

export function RenderedSessionProvider({ ownerId, lineage, children }: RenderedSession & { readonly children: ReactNode }) {
  const value = useMemo<RenderedSession>(() => ({ ownerId, lineage }), [ownerId, lineage]);
  return <RenderedSessionContext.Provider value={value}>{children}</RenderedSessionContext.Provider>;
}

/** The account (and lineage) the enclosing dashboard layout was rendered for, or null outside it. */
export function useRenderedSession(): RenderedSession | null {
  return useContext(RenderedSessionContext);
}

export default function SessionKeeper() {
  useEffect(() => {
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      return; // no client: pages that need one report that themselves
    }
    const original = window.fetch;
    const keeper = serverActionFetch((input, init) => original.call(window, input, init), client, window.location.origin);
    window.fetch = keeper;
    // A2: the early refresh and the fence's first write (see above)
    const stopUpkeep = startSessionUpkeep(client);
    return () => {
      stopUpkeep();
      if (window.fetch === keeper) window.fetch = original;
    };
  }, []);
  return null;
}
