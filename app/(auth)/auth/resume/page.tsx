"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { serialize } from "@supabase/ssr";
import { createClient } from "@/utils/supabase/client";
import { RESUME_MARKER_COOKIE, RESUME_MARKER_MAX_AGE_S, safeResumeTarget } from "@/utils/supabase/session-cookie-layout";
import { sessionUnverifiedReason } from "@/utils/supabase/session-storage";

// /auth/resume — where a protected page navigation goes when its session cookie is due to expire
// (utils/supabase/session-resume.ts). The server never refreshes or writes a session; this page lets the browser's own
// client do it, under the session-publication lease, and then continues to `next`.
// - `seen` is the stored expiry the server saw. A stored session that expires later was already refreshed (another tab,
//   this page's own client start-up): continue without another refresh. Otherwise refresh once, explicitly.
// - No session (a refusal the client already acted on): /login. Auth unreachable: say so and offer to try again; the
//   session is kept.
// - Before continuing it sets a one-minute marker cookie (no credential) so the middleware lets the next request through
//   to the server's own verification instead of sending it back here.
// - A session the browser cannot verify against its recorded lineage (another tab's write not visible here yet, a
//   session written outside the browser's own writer, or a lineage store that failed — session-storage.ts) is never
//   used and never treated as signed out: the page says it cannot confirm which account is signed in and offers to try
//   again or sign in again. A browser that cannot support the synchronization contract at all is told so.
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;
/** Each session read or refresh is given this long (the SDK's own retries can otherwise run for about 25 s). */
const CALL_DEADLINE_MS = 8_000;
/** After an unsettled jar, a session read with at least this long left goes straight back (the middleware's own margin). */
const UNSETTLED_FRESH_MS = 30_000;

function withDeadline<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CALL_DEADLINE_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Phase = "working" | "unavailable" | "unconfirmed" | "unsupported";

const PHASE_COPY: Record<Exclude<Phase, "working">, string> = {
  unavailable: "We can't reach the sign-in service right now. You're still signed in on this device; please try again in a moment.",
  unconfirmed:
    "We couldn't confirm which account is signed in on this device, so nothing was loaded. Try again, or sign in again to continue.",
  unsupported:
    "This browser can't keep your sign-in safe. Private browsing or blocked site data can cause this; try a regular window or another browser.",
};

export default function ResumeSessionPage() {
  const [phase, setPhase] = useState<Phase>("working");
  const started = useRef(false);

  const resume = useCallback(async () => {
    setPhase("working");
    const params = new URLSearchParams(window.location.search);
    const next = safeResumeTarget(params.get("next"), window.location.origin);
    const seenRaw = Number(params.get("seen"));
    const seen = Number.isSafeInteger(seenRaw) && seenRaw > 0 ? seenRaw : null;
    // the server saw an ambiguous jar (see session-resume.ts): a session the browser reads now is the one to go back with
    const unsettled = params.get("unsettled") === "1";
    const leave = (target: string) => {
      document.cookie = serialize(RESUME_MARKER_COOKIE, "1", {
        path: "/",
        sameSite: "lax",
        secure: window.location.protocol === "https:",
        maxAge: RESUME_MARKER_MAX_AGE_S,
      });
      window.location.replace(target);
    };
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      setPhase("unavailable");
      return;
    }
    // the last read refused as unverified (see the header), if any: it decides the message instead of "can't reach"
    let unverified: ReturnType<typeof sessionUnverifiedReason> = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      unverified = null;
      try {
        const read = await withDeadline(client.auth.getSession());
        if (read === null) continue; // no answer in time: try again, then say so
        unverified = sessionUnverifiedReason(read.error);
        const session = read.data?.session ?? null;
        if (!read.error && session === null) {
          window.location.replace("/login");
          return;
        }
        if (session !== null) {
          const expiresAt = typeof session.expires_at === "number" ? session.expires_at : null;
          const fresh = unsettled
            ? expiresAt !== null && expiresAt * 1000 - Date.now() > UNSETTLED_FRESH_MS // the session read now, if not expiring
            : seen !== null && expiresAt !== null ? expiresAt > seen : false;
          if (fresh) {
            leave(next);
            return;
          }
          const refreshed = await withDeadline(client.auth.refreshSession());
          if (refreshed !== null && !refreshed.error && refreshed.data?.session) {
            leave(next);
            return;
          }
          unverified = refreshed === null ? null : sessionUnverifiedReason(refreshed.error);
        }
      } catch (failure) {
        unverified = sessionUnverifiedReason(failure); // try again
      }
    }
    setPhase(unverified === "unsupported" ? "unsupported" : unverified !== null ? "unconfirmed" : "unavailable");
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void resume();
  }, [resume]);

  return (
    <div className="relative min-h-screen bg-golf-dark flex items-center justify-center px-4 py-10">
      <main className="relative w-full max-w-md min-w-0 bg-golf-surface border border-white/5 rounded-5xl p-6 sm:p-8 text-center">
        <h1 className="text-sm font-black uppercase tracking-[0.2em] text-gray-300">Restoring your session</h1>
        <p role="status" aria-live="polite" className="mt-4 text-sm text-gray-300">
          {phase === "working" ? "One moment while we bring you back." : PHASE_COPY[phase]}
        </p>
        <noscript>
          <p className="mt-4 text-sm text-gray-300">Restoring your session needs JavaScript. You can sign in again instead.</p>
        </noscript>
        <div className="mt-6 flex flex-col gap-3">
          {(phase === "unavailable" || phase === "unconfirmed") && (
            <button
              type="button"
              onClick={() => void resume()}
              className="min-h-11 w-full rounded-2xl bg-golf-green text-black text-xs font-black uppercase tracking-widest"
            >
              Try again
            </button>
          )}
          <Link href="/login" className="min-h-11 flex items-center justify-center text-xs font-bold text-gray-400 underline">
            Sign in again
          </Link>
        </div>
      </main>
    </div>
  );
}
