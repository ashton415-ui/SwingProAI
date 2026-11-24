"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { watchLineageEnd } from "@/utils/supabase/session-publication";
import { jwtClaims } from "@/utils/supabase/session-cookie-layout";
import { readStoredSession } from "@/utils/supabase/session-storage";
import { confirmOwnerSession, drillHubIdentityEndFromEvent } from "@/lib/drill-hub-session";
import { RenderedSessionProvider } from "@/components/navigation/SessionKeeper";

/**
 * AG-WEB-READY-04 F1 — the dashboard's whole account-bearing shell (sidebar with the account name, plan badge and End
 * Session, the phone/tablet navigation and drawer, and the page) belongs to the account and session lineage the layout
 * was rendered for (RenderedSessionProvider, SessionKeeper.tsx). When this browser's sign-in is CONFIRMED to no longer be
 * that one, the shell is removed from the screen and replaced by fixed guidance: no name, plan, media, data or actionable
 * control of the old account stays on screen, so nothing in it can be pressed or submitted. This is a presentation
 * boundary, not an identity fence around browser requests: work a page already started, or that code starts without a
 * press (see the limits below), is not stopped here. Some components fence their own late answers (GoalsForm, the plan
 * view's generation since AG-WEB-READY-06-P1, the analysis report); a component without its own fence is not covered by
 * this boundary. (What the page already loaded stays in its memory until it is reloaded or left: removal is from the
 * screen and its controls, not from the browser.)
 *
 * Only established primitives decide; nothing here writes a credential:
 *  - End Session of the rendered lineage, in this tab or another (watchLineageEnd), ends the view.
 *  - An identity event of the shared client (a sign-out, or a session for another account: drillHubIdentityEndFromEvent),
 *    a return to the page (visibilitychange to visible, a back/forward restoration: pageshow persisted), hydration and a
 *    navigation inside the retained layout are only SIGNALS: each asks confirmOwnerSession, the verification every
 *    owner-bound request uses, and only its confirmed answers end the view — signed out or ended → "signed_out", another
 *    account → "account_changed". An event that named an end is confirmed once more after the read it may have joined
 *    (a read already in flight can predate the change), never more.
 *  - An answer that confirms nothing (unavailable: an Auth outage, a slow or refused read; unconfirmed) never ends the
 *    view and is never treated as a sign-out; the pages keep refusing what they cannot confirm, as before.
 *  - Until a check answers, a press or submit in the view is refused before the page acts on it when the browser's
 *    stored session cookie envelope (the local read SessionKeeper's action keeper uses) names ANOTHER account than the
 *    rendered one. That read and the request's dispatch are not atomic with a sign-in published in between, so this is a best-effort
 *    refusal of stale presses, not a guarantee about every request. A refused press or submit starts no navigation,
 *    Server Action or request, and the view is checked at once. A fixed notice then says why the page can't act and offers a reload (the only control
 *    that is let through), so a check that cannot confirm (an Auth outage) never leaves a silently dead page. That read
 *    only refuses; it never ends the view, adopts the account or changes the session. Once the view has ended, every
 *    press or submit outside the guidance is refused (the old shell can still be on screen until the guidance is drawn).
 *    Not intercepted (no press or submit event): link prefetch (viewport, hover, touch), router.refresh or timers started
 *    by code, a submit React replays after hydration, browser back/forward (popstate), drag-and-drop or pointer/key-only
 *    handlers; a link opened in a new tab is a fresh page the server renders for the account signed in then.
 *  - A newer sign-in of the SAME account is not an account change (existing lineage rules: only End Session of the
 *    rendered lineage ends it), and the browser's current session — another account's, or a newer one — is never cleared,
 *    revoked or replaced: this boundary only stops showing the old view. An explicit reload renders the current account
 *    through the server's own verification; a re-render of the retained layout for another account (a refresh) is not an
 *    adoption: the view ends as an account change.
 *
 * No new periodic work, refresh or upkeep: checks run only on those events. JavaScript cannot act in a page that is not
 * running (a frozen or suspended tab): such a page is checked when it runs again (pageshow / visibilitychange).
 */
type ViewEnd = "signed_out" | "account_changed";

const REFUSED_COPY =
  "This browser's sign-in changed after this page was opened, so the page can't act on it. Reload to continue with the current sign-in.";

const ENDED_COPY: Readonly<Record<ViewEnd, { readonly heading: string; readonly body: string }>> = {
  signed_out: {
    heading: "This page's sign-in has ended",
    body: "This page was opened for a sign-in that has ended, so its details are no longer shown. Reload to continue with this browser's current sign-in, or sign in again.",
  },
  account_changed: {
    heading: "Signed in to a different account",
    body: "This browser is now signed in to a different account, so this page's details are no longer shown. Reload to continue with the account that's signed in now.",
  },
};

/** The account the browser's stored session names (local read; no request), or null when none can be read. */
function storedSubject(): string | null {
  try {
    const stored = readStoredSession();
    return stored.kind === "present" ? jwtClaims(stored.envelope.accessToken).sub : null;
  } catch {
    return null;
  }
}

export default function RenderedSessionBoundary({
  ownerId,
  lineage,
  children,
}: {
  readonly ownerId: string;
  readonly lineage: string | null;
  readonly children: ReactNode;
}) {
  const [ended, setEnded] = useState<ViewEnd | null>(null);
  // a press or submit was refused because the browser now holds another account (shown until it holds this one again)
  const [refused, setRefused] = useState(false);
  const endedRef = useRef<ViewEnd | null>(null);
  const checkRef = useRef<() => void>(() => undefined);
  const pathname = usePathname();
  const firstPathRef = useRef(true);
  // the account this view was first rendered for: a later render of the retained layout for another account ends it
  // (for good: a later render for the first account again does not bring the old view back)
  const firstOwnerRef = useRef(ownerId);
  const movedRef = useRef(false);
  if (ownerId !== firstOwnerRef.current) movedRef.current = true;
  const moved = movedRef.current;

  useEffect(() => {
    if (moved) return;
    let live = true;
    let running = false;
    let again = false;
    const end = (why: ViewEnd) => {
      if (!live || endedRef.current !== null) return;
      endedRef.current = why;
      setEnded(why);
    };
    const verify = async () => {
      let answer: Awaited<ReturnType<typeof confirmOwnerSession>>;
      try {
        answer = await confirmOwnerSession(() => createClient(), ownerId);
      } catch {
        return; // nothing confirmed: the view stays
      }
      if (!live) return; // a late answer after unmount changes nothing
      if (answer.status === "signed_out" || answer.status === "ended") end("signed_out");
      else if (answer.status === "account_changed") end("account_changed");
    };
    const check = () => {
      if (!live || endedRef.current !== null) return;
      if (running) {
        again = true; // one more check after the one in flight, never a queue
        return;
      }
      running = true;
      void verify().finally(() => {
        running = false;
        if (again && live && endedRef.current === null) {
          again = false;
          check();
        }
      });
    };
    checkRef.current = check;

    const stopLineageWatch = watchLineageEnd(lineage, () => end("signed_out"));
    let unsubscribe = () => undefined as void;
    try {
      const { data } = createClient().auth.onAuthStateChange((event, session) => {
        if (drillHubIdentityEndFromEvent(ownerId, event, session) === null) return;
        check();
        // the read this check started may have joined one already in flight from before the change: confirm once more
        if (running) again = true;
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      // no shared client: no events; the checks below still confirm
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) check(); // restored from the back/forward cache
    };
    // A press or submit in a view rendered for another account than the one the browser now holds is refused before
    // the page (or the router) acts on it; the check then ends the view once it is confirmed.
    const refuse = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    let refusedShown = false;
    const guard = (event: Event) => {
      // the guidance's own controls (the ended view, the refusal notice) always act
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      if (target && typeof target.closest === "function" && target.closest("[data-rendered-session-guidance]")) return;
      if (endedRef.current !== null) {
        refuse(event); // ended: the old shell may still be on screen for a moment; nothing in it acts
        return;
      }
      const holder = storedSubject();
      if (holder === null || holder === ownerId) {
        if (refusedShown && live) {
          refusedShown = false;
          setRefused(false);
        }
        return;
      }
      refuse(event);
      if (!refusedShown && live) {
        refusedShown = true;
        setRefused(true);
      }
      check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("click", guard, true);
    window.addEventListener("submit", guard, true);
    check(); // hydration: a page rendered for this account while the browser already holds another sign-in

    return () => {
      live = false;
      checkRef.current = () => undefined;
      stopLineageWatch();
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("click", guard, true);
      window.removeEventListener("submit", guard, true);
    };
  }, [ownerId, lineage, moved]);

  // A navigation inside the retained dashboard layout (the layout, and this boundary, stay mounted) confirms again.
  useEffect(() => {
    if (firstPathRef.current) {
      firstPathRef.current = false;
      return;
    }
    checkRef.current();
  }, [pathname]);

  const shown = ended ?? (moved ? "account_changed" : null);
  if (shown !== null) return <EndedView why={shown} />;
  return (
    <>
      <RenderedSessionProvider ownerId={ownerId} lineage={lineage}>
        {children}
      </RenderedSessionProvider>
      {refused && <RefusedNotice />}
    </>
  );
}

function RefusedNotice() {
  return (
    <div
      data-rendered-session-guidance="refused"
      role="status"
      className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-3 bg-golf-header border-b border-white/10 px-4 py-3 text-sm text-gray-200"
    >
      <span className="max-w-xl text-center">{REFUSED_COPY}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl bg-golf-green hover:bg-golf-green/90 text-xs font-black uppercase tracking-widest text-golf-dark transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
      >
        Reload page
      </button>
    </div>
  );
}

function EndedView({ why }: { readonly why: ViewEnd }) {
  const copy = ENDED_COPY[why];
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // the control that had focus was removed with the shell: focus moves to the guidance
  useEffect(() => {
    headingRef.current?.focus();
  }, [why]);
  return (
    <main data-rendered-session-guidance="ended" className="flex-1 min-w-0 min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center bg-golf-header border border-white/5 rounded-2xl p-7">
        <h1 ref={headingRef} tabIndex={-1} className="text-white font-bold mb-2 outline-none">{copy.heading}</h1>
        <p role="alert" className="text-sm text-gray-300 mb-6">{copy.body}</p>
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-golf-dark transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            Reload page
          </button>
          {why === "signed_out" && (
            <a
              href="/login"
              className="inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl border border-white/10 text-sm font-bold text-gray-300 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
            >
              Sign in
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
