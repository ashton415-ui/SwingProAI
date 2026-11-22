import { NextResponse, type NextRequest } from "next/server";
import {
  RESUME_MARKER_COOKIE,
  RESUME_PATH,
  bindingAdmits,
  parseCookieHeader,
  readEnvelope,
  readSessionLayout,
  sessionCookieKey,
} from "@/utils/supabase/session-cookie-layout";

// ============================================================================
// Expiring-session routing (middleware only; replaces the session refresh boundary)
// ============================================================================
//
// The server no longer refreshes or writes a session, on any path. Supabase
// rotates the refresh token on every refresh, so a refresh is only safe where
// its result is published to the one store every reader uses, under the lock
// every other writer takes — the browser (utils/supabase/session-lease.ts). A
// server-side refresh whose Set-Cookie arrives after the browser's session has
// changed (End Session, another sign-in) is exactly what put another golfer's
// session into a browser (U5–U7).
//
// So for a protected page navigation (GET/HEAD, no Authorization header) whose
// session cookie states an expiry less than RESUME_MARGIN_MS away (or past),
// this answers 307 to /auth/resume?next=<path>&seen=<stated expiry>; the
// browser's client refreshes there and comes back. Everything else passes
// through untouched: no Set-Cookie, no Auth request, no body, no other header.
// It is not an authentication gate: the stated expiry is caller-controlled and
// only chooses this detour; the server verifier still checks the access token
// with Auth on every request. After a resume the page sets a one-minute marker
// cookie, while which nothing is sent back here (no loop).
// A navigation whose session cookies are ambiguous (a chunked session caught
// mid-replacement by another tab, or names that do not form one layout) goes
// the same way with `unsettled=1` instead of `seen`: the server would take it
// for no session and send the golfer to sign in, while the browser's client
// waits such a jar out (session-storage.ts) and either finds the session — and
// comes straight back — or confirms there is none. A complete session that the
// binding cookie does not vouch for (session-cookie-layout.ts: written outside
// the browser's own writer, such as a previous bundle's late refresh) goes the
// same way: the server verifier refuses it, and the browser either confirms its
// own recorded session or says it cannot confirm which account is signed in.

/** Within this long of its stated expiry, a page navigation goes by /auth/resume first. */
const RESUME_MARGIN_MS = 30_000;

export async function resumeExpiringSession(request: NextRequest): Promise<NextResponse> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
    if (request.headers.has("authorization")) return NextResponse.next();
    const pairs = parseCookieHeader(request.headers.get("cookie") ?? "");
    if (pairs.some((pair) => pair.name === RESUME_MARKER_COOKIE)) return NextResponse.next();
    const layout = readSessionLayout(pairs, sessionCookieKey(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""));
    if (layout.kind === "ambiguous") return toResume(request, "unsettled", "1");
    if (layout.kind !== "present") return NextResponse.next();
    const envelope = readEnvelope(layout.value);
    if (envelope === null) return NextResponse.next();
    if ((await bindingAdmits(pairs, envelope.accessToken)) === "mismatch") return toResume(request, "unsettled", "1");
    if (envelope.expiresAt === null) return NextResponse.next();
    if (envelope.expiresAt * 1000 - Date.now() >= RESUME_MARGIN_MS) return NextResponse.next();
    return toResume(request, "seen", String(Math.trunc(envelope.expiresAt)));
  } catch {
    return NextResponse.next();
  }
}

function toResume(request: NextRequest, name: "seen" | "unsettled", value: string): NextResponse {
  const target = request.nextUrl.clone();
  target.pathname = RESUME_PATH;
  target.search = "";
  target.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  target.searchParams.set(name, value);
  const response = NextResponse.redirect(target, 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
