"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

/**
 * AG-WEB-READY-08-P1 — a presentation-only path from a page component to the rendered-session boundary around it
 * (components/navigation/RenderedSessionBoundary.tsx): "this view has confirmed that its sign-in ended or changed to another
 * account". The plan view (app/(dashboard)/goals/plan/PlanDisplay.tsx) uses it after a generation's answer was withheld on
 * such a CONFIRMED observation (confirmOwnerSession), so the surrounding shell — account name, plan header, saved-goal
 * details, sidebar, phone/tablet navigation and End Session — is removed with the plan, instead of staying on screen until
 * the boundary hears of the change some other way.
 *
 * A report is a fixed enum and nothing else: which end was confirmed, and what can truthfully be said about the plan request
 * (refused before anything was saved, or a plan may already have been saved for the account the page was opened for). It
 * carries no account id, name, token, plan, message or other data, and it is not an identity source: it can only remove the
 * view it belongs to. It never adopts an account, grants access, writes, clears or revokes a credential, or changes what the
 * server or any request is sent as.
 *
 * Scope and lifetime. Each boundary generation (one mounted boundary, for one rendered owner and session lineage) makes its
 * own channel; the boundary accepts a report only through the channel of its current generation while it is mounted. A
 * reporter is bound to the channel it was obtained with and to its own component's lifetime, ended in the very commit that
 * removes the component (useCommitPhaseEffect below): from that commit on, or after the boundary was re-rendered for another
 * lineage or owner, or unmounted, the old reporter does nothing — a report from a view that is gone can never end a newer view
 * (another account's, a newer sign-in of the same account, or the page that replaced it under the same boundary). No store,
 * event bus, global singleton, listener protocol, timer or cross-tab channel is involved; nothing is persisted.
 */
export type RenderedViewEnd = "signed_out" | "account_changed";
/** What can truthfully be said about a plan request whose answer was withheld: a known refusal, or "may already be saved". */
export type RenderedPlanOutcome = "refused" | "may_be_saved";
export interface RenderedViewEndReport {
  readonly end: RenderedViewEnd;
  readonly plan: RenderedPlanOutcome;
}
/** Reports a confirmed end of the reporter's own rendered view; true when the boundary accepted it (and will remove the view). */
export type ReportRenderedViewEnd = (report: RenderedViewEndReport) => boolean;

/** The rendered owner and session lineage one boundary generation was rendered for (non-credential facts, never shared). */
interface Generation {
  readonly ownerId: string;
  readonly lineage: string | null;
}

export interface RenderedViewEndChannel {
  /** Called by the reporters below; true when the attached boundary accepted the report. */
  readonly report: ReportRenderedViewEnd;
  /**
   * Called only by the boundary generation the channel was made for (same owner and lineage, or nothing is attached), from
   * its mounted effect; returns the detach the effect's cleanup calls. While one acceptor is attached a second attach is
   * refused (nothing replaces the boundary's own acceptor).
   */
  readonly attach: (generation: Generation, accept: ReportRenderedViewEnd) => () => void;
}

const ENDS: ReadonlySet<unknown> = new Set<RenderedViewEnd>(["signed_out", "account_changed"]);
const PLAN_OUTCOMES: ReadonlySet<unknown> = new Set<RenderedPlanOutcome>(["refused", "may_be_saved"]);

/** One boundary generation's channel. Only the two fixed enum values of a report are passed on; anything else is ignored. */
export function createRenderedViewEndChannel(own: Generation): RenderedViewEndChannel {
  let accept: ReportRenderedViewEnd | null = null;
  return Object.freeze({
    report: (report: RenderedViewEndReport): boolean => {
      const handler = accept;
      if (handler === null || report === null || typeof report !== "object") return false;
      const end: unknown = report.end;
      const plan: unknown = report.plan;
      if (!ENDS.has(end) || !PLAN_OUTCOMES.has(plan)) return false;
      return handler({ end: end as RenderedViewEnd, plan: plan as RenderedPlanOutcome }) === true;
    },
    attach: (generation: Generation, next: ReportRenderedViewEnd): (() => void) => {
      if (generation.ownerId !== own.ownerId || generation.lineage !== own.lineage || accept !== null) return () => undefined;
      accept = next;
      return () => {
        if (accept === next) accept = null;
      };
    },
  });
}

const RenderedViewEndContext = createContext<RenderedViewEndChannel | null>(null);

/** Provided by the rendered-session boundary around its own account-bearing view only. */
export function RenderedViewEndProvider({ channel, children }: { readonly channel: RenderedViewEndChannel; readonly children: ReactNode }) {
  return <RenderedViewEndContext.Provider value={channel}>{children}</RenderedViewEndContext.Provider>;
}

/*
 * The reporter's lifetime follows its component's COMMITS, not its passive effects: it is switched on and off in a
 * layout-phase effect. React runs a removed component's layout-effect cleanup while it commits the removal — before any
 * layout effect of that commit is set up (other components' layout cleanups of the same commit run in tree order alongside
 * it), and before any later microtask or passive effect — so from the commit
 * that removes a view, that view's reporter is already inert, even while its boundary (same owner and lineage) stays mounted
 * for the page that replaced it. A passive cleanup would leave a window after the removal commit in which a captured
 * reporter could still end the retained boundary and clear the replacement page. On the server (no DOM, no commits; React
 * warns about layout effects there) the ordinary effect stands in; it never runs there, so nothing is reported either.
 */
const useCommitPhaseEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The calling component's reporter: bound to the boundary channel present when it was obtained and active only from the
 * commit that mounted the component until the commit that removes it. Outside a boundary, or once detached, it reports
 * nothing (returns false).
 */
export function useRenderedViewEndReport(): ReportRenderedViewEnd {
  const channel = useContext(RenderedViewEndContext);
  const mounted = useRef(false);
  useCommitPhaseEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useMemo<ReportRenderedViewEnd>(() => (report) => mounted.current && channel !== null && channel.report(report), [channel]);
}
