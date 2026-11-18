"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { GOALS_COPY as COPY } from "@/lib/golfer-journey-goals-read-state";

const LINK_CLASS =
  "inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl text-sm font-medium text-gray-300 transition-colors hover:text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400";

/**
 * GJ-PARALLEL-03 — shown on My Goals when the latest goal read failed
 * ("unavailable"), or when a saved goal's plan cannot be displayed
 * ("unreadable"), in place of onboarding, "No goals set yet", a generate
 * prompt or a plan.
 *
 * "Try again" only re-renders the current route on the server
 * (`router.refresh()`), which repeats that page's own read with the
 * server-owned session. It never submits goals, generates or regenerates a
 * plan, uploads, analyses or checks out. One refresh at a time: a ref guards
 * presses within the same task, and the button is busy while the refresh is
 * pending. The unreadable panel also links to the goals form and to the
 * Progress Hub; both are ordinary navigation.
 */
export default function GoalsLoadError({ variant }: { variant: "unavailable" | "unreadable" }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Failed reads seen by this panel: the page load, plus every refresh that
  // ends with the panel still here (a successful one replaces it).
  const [failures, setFailures] = useState(1);
  const retried = useRef(false);
  const inFlight = useRef(false);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !isPending) setFailures((count) => count + 1);
    if (!isPending) inFlight.current = false;
    wasPending.current = isPending;
  }, [isPending]);

  // A successful refresh replaces this panel, removing the focused button;
  // hand focus to the page heading instead of the document. When the refresh
  // lands on another route (My Goals → the saved plan), that heading arrives a
  // moment later, so the hand-off keeps watching for at most 2 s: it focuses
  // the heading when it appears, and again only if that heading is replaced
  // while it still had focus. It stops for good as soon as focus is anywhere
  // else, or is moved off a heading that is still in place (a later click
  // elsewhere is never undone).
  useEffect(() => () => {
    if (!retried.current) return;
    const deadline = Date.now() + 2000;
    let focused: HTMLElement | null = null;
    const handOff = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focused) return;
      if (!active || active === document.body) {
        if (focused?.isConnected) return;
        focused = document.getElementById("my-goals-heading");
        focused?.focus();
      }
      if (Date.now() < deadline) window.setTimeout(handOff, 50);
    };
    handOff();
  }, []);

  function retry() {
    if (inFlight.current || isPending) return;
    inFlight.current = true;
    retried.current = true;
    startTransition(() => router.refresh());
  }

  const unreadable = variant === "unreadable";
  const title = unreadable ? COPY.unreadableTitle : COPY.unavailableTitle;
  const body = unreadable
    ? failures > 1 ? COPY.stillUnreadable : COPY.unreadableBody
    : failures > 1 ? COPY.stillUnavailable : COPY.unavailableBody;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-4 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
      {/* keyed on the failure count so each new failure is announced again */}
      <div key={failures} role="alert" className="flex items-start gap-3 flex-1 min-w-0">
        <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-red-300">{title}</h2>
          <p className="text-xs text-gray-300 mt-1 leading-relaxed">{body}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={retry}
          aria-disabled={isPending}
          aria-busy={isPending}
          className="inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-xl border border-white/15 bg-white/5 text-white text-sm font-medium transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 aria-disabled:cursor-wait aria-disabled:opacity-60"
        >
          {isPending ? (
            <>
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {COPY.retrying}
            </>
          ) : (
            <>
              <RotateCcw size={14} aria-hidden="true" />
              {COPY.retry}
            </>
          )}
        </button>
        {unreadable && (
          <>
            {/* a document link on purpose (see plan/page.tsx): the form and Back start from fresh renders */}
            <a href="/goals?new=1" className={`${LINK_CLASS} border border-white/10`}>
              {COPY.setNewGoals}
            </a>
            <Link href="/dashboard" className={LINK_CLASS}>
              {COPY.progressHub}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
