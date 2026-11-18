"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { BAG_COPY as COPY } from "@/lib/golfer-journey-bag-read-state";

/**
 * GJ-PARALLEL-02 — the My Bag page when its club or telemetry read failed, in
 * place of the Virtual Bag (so nothing reads as an empty bag, a zero count or
 * "No data").
 *
 * "Try again" only re-renders this route on the server (`router.refresh()`),
 * which repeats the page's own two reads with the server-owned session. It
 * starts no analysis, upload, fitting, equipment write or billing step. One
 * refresh at a time: a ref guards presses within the same task, and the button
 * is busy while the refresh is pending.
 */
export default function BagLoadError() {
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

  // A successful refresh replaces this view with the bag, removing the focused
  // button; hand focus to the bag's heading instead of the document.
  useEffect(() => () => {
    if (retried.current && document.activeElement === document.body) {
      document.getElementById("my-bag-heading")?.focus();
    }
  }, []);

  function retry() {
    if (inFlight.current || isPending) return;
    inFlight.current = true;
    retried.current = true;
    startTransition(() => router.refresh());
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">{COPY.title}</h1>
          <p className="text-sm text-gray-400 mt-1">{COPY.description}</p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
          {/* keyed on the failure count so each new failure is announced again */}
          <div key={failures} role="alert" className="flex items-start gap-3 flex-1 min-w-0">
            <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-red-300">{COPY.unavailableTitle}</h2>
              <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                {failures > 1 ? COPY.stillUnavailable : COPY.unavailableBody}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={retry}
            aria-disabled={isPending}
            aria-busy={isPending}
            className="shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-xl border border-white/15 bg-white/5 text-white text-sm font-medium transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 aria-disabled:cursor-wait aria-disabled:opacity-60"
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
        </div>
      </div>
    </div>
  );
}
