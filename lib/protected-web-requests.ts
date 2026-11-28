/**
 * AG-WEB-READY-10-P4: the protected browser path for the Analyze page's four application requests.
 *
 * Why it exists. A deployment behind a platform sign-in (Vercel Authentication, for one) admits a browser request only
 * when it carries the platform's own first-party cookie. The page's four requests below go with `credentials: "omit"`
 * so that no session cookie — possibly another sign-in's — can travel with the golfer's confirmed Bearer; the platform
 * then refuses them before the application runs (observed on staging: AG-WEB-READY-09-S1 and 10-S2).
 *
 * The opt-in. `NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS=1` at build time, and nothing else, turns it on (the build
 * fixes it: next.config.mjs). Any other value, or none, is the default: each request goes to its existing endpoint
 * exactly as before (the native and public API contracts are unchanged), with the Bearer alone and no cookie.
 *
 * On the opt-in, each request goes to a fixed web endpoint on this app's exact origin (`/api/web/...`):
 *   - `mode: "same-origin"`: the browser refuses to send it anywhere else;
 *   - `credentials: "same-origin"`: the browser's eligible cookies go only to this origin (that is what lets the
 *     platform's sign-in cookie through);
 *   - `redirect: "error"`: a redirect (for example, the platform's sign-in redirect) is never followed; the request
 *     fails, and the page's existing recovery copy applies;
 *   - the same headers, so the same confirmed Bearer, and the same body.
 * The cookies that now travel are not identity. Each web endpoint refuses a request that carries no Authorization
 * header before anything else runs, and otherwise runs the existing handler, whose verifier reads a presented
 * Authorization header and never the cookie (lib/api/protected-web-boundary.ts, utils/supabase/server.ts).
 *
 * Nothing here is a security control by itself: the server decides. A request whose owner the page has not confirmed is
 * never built at all (the page's checks run before each send, unchanged).
 */

/** The four application requests of one Analyze submission. */
export type AppRequestName = "authorize" | "finalize" | "analyses" | "analyze";

/** The existing endpoints: the default path, unchanged. */
export const APP_REQUEST_PATHS: Readonly<Record<AppRequestName, string>> = {
  authorize: "/api/v1/uploads/authorize",
  finalize: "/api/v1/uploads/finalize",
  analyses: "/api/v1/analyses",
  analyze: "/api/analyze-swing",
};

/** The fixed same-origin web endpoints of the opt-in. Each requires a Bearer, then runs the existing handler. */
export const PROTECTED_WEB_PATHS: Readonly<Record<AppRequestName, string>> = {
  authorize: "/api/web/uploads/authorize",
  finalize: "/api/web/uploads/finalize",
  analyses: "/api/web/analyses",
  analyze: "/api/web/analyze-swing",
};

/**
 * Whether this build opted in. next.config.mjs states the variable for every build ("1" only when the build is given
 * exactly "1", otherwise "0"), and Next.js inlines it into the browser bundle and the server bundle alike, so both sides
 * of one build agree and a runtime-only setting changes neither. It is read here by its literal name, which is what the
 * inlining replaces; outside a Next.js build (unit tests) it is read from the environment.
 */
export function protectedWebRequestsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SWINGPROAI_PROTECTED_WEB_REQUESTS === "1";
}

/** What the page supplies: the request's headers (its confirmed Bearer included) and its body. */
export interface AppRequest {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Sends one of the four application requests on the path this build uses. */
export function sendAppRequest(name: AppRequestName, request: AppRequest): Promise<Response> {
  if (!protectedWebRequestsEnabled()) {
    // the default path, exactly as before: the Bearer alone identifies the request; no cookie goes with it
    return fetch(APP_REQUEST_PATHS[name], {
      method: "POST",
      credentials: "omit",
      headers: request.headers,
      body: request.body,
    });
  }
  const origin = window.location.origin;
  const target = new URL(PROTECTED_WEB_PATHS[name], origin);
  // a fixed relative path always resolves on this origin; anything else is refused before a byte is sent
  if (target.origin !== origin) return Promise.reject(new TypeError("Failed to fetch"));
  return fetch(target.href, {
    method: "POST",
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    headers: request.headers,
    body: request.body,
  });
}
