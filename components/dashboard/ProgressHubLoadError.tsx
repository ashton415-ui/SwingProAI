"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { PROGRESS_HUB_UNAVAILABLE_COPY as COPY } from "@/lib/golfer-journey-read-state";

/**
 * GJ-PARALLEL-01 — shown by the Progress Hub when its analysis read failed,
 * in place of the stats and the log (so nothing reads as zero or empty).
 *
 * "Try again" only re-renders this route on the server (`router.refresh()`),
 * which repeats the page's own reads. It starts no analysis, upload, retry of
 * an analysis, provider request or write. While a refresh is pending the
 * button is busy and further presses are ignored (one refresh at a time).
 */
export default function ProgressHubLoadError() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Failed reads seen by this panel: the page load, plus every refresh that
  // ends with the panel still here (a successful one replaces it).
  const [failures, setFailures] = useState(1);
  const retried = useRef(false);
  // isPending only updates on the next render, so several presses in one task
  // would all see it false; this ref is the guard that cannot lag.
  const inFlight = useRef(false);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !isPending) setFailures((count) => count + 1);
    if (!isPending) inFlight.current = false;
    wasPending.current = isPending;
  }, [isPending]);

  // A successful refresh replaces this panel with the stats, removing the
  // focused button; hand focus to the page heading instead of the document.
  useEffect(() => () => {
    if (retried.current && document.activeElement === document.body) {
      document.getElementById("progress-hub-heading")?.focus();
    }
  }, []);

  function retry() {
    if (inFlight.current || isPending) return;
    inFlight.current = true;
    retried.current = true;
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-4 bg-red-500/10 border border-red-500/20 rounded-4xl px-6 py-5 mb-10">
      {/* keyed on the failure count so each new failure is announced again */}
      <div key={failures} role="alert" className="flex items-start gap-3 flex-1 min-w-0">
        <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-sm font-black text-red-300">{COPY.title}</h2>
          <p className="text-xs text-gray-300 mt-1 leading-relaxed">
            {failures > 1 ? COPY.stillUnavailable : COPY.body}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={retry}
        aria-disabled={isPending}
        className="shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-2xl border border-white/15 bg-white/5 text-white font-black text-[10px] uppercase tracking-widest transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green aria-disabled:cursor-wait aria-disabled:opacity-60"
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
  );
}
