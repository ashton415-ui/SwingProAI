"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Zap,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Loader2,
  Target,
  Clock,
  Lightbulb,
  CheckCircle2,
} from "lucide-react";
import { generateSyllabus } from "../actions";
import GoalsLoadError from "@/components/goals/GoalsLoadError";
import { useRenderedSession } from "@/components/navigation/SessionKeeper";
import { GOALS_COPY, toGoalPlan, type GoalPlan, type PlanCategory } from "@/lib/golfer-journey-goals-read-state";
import { createClient } from "@/utils/supabase/client";
import { confirmOwnerSession } from "@/lib/drill-hub-session";

// ── Category styling ───────────────────────────────────────────────────────────

const CATEGORY_STYLE: Record<
  PlanCategory,
  { label: string; bg: string; border: string; text: string }
> = {
  driving: {
    label: "Driving",
    bg: "bg-violet-500/10",
    border: "border-violet-500/25",
    text: "text-violet-400",
  },
  irons: {
    label: "Irons",
    bg: "bg-blue-500/10",
    border: "border-blue-500/25",
    text: "text-blue-400",
  },
  short_game: {
    label: "Short Game",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/25",
    text: "text-emerald-400",
  },
  putting: {
    label: "Putting",
    bg: "bg-amber-500/10",
    border: "border-amber-500/25",
    text: "text-amber-400",
  },
  mental: {
    label: "Mental",
    bg: "bg-rose-500/10",
    border: "border-rose-500/25",
    text: "text-rose-400",
  },
};

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** A saved plan already checked by the server (GJ-PARALLEL-03), or null when none is stored. */
  initialSyllabus: GoalPlan | null;
  hasGoals: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

type View = "plan" | "unreadable" | "goal_missing";
const UNCONFIRMED = "We couldn't confirm whether your new plan was saved. Reload My Plan to see what's saved.";
// AG-WEB-READY-05-G1: a plan is requested only for the account this view was rendered for (useRenderedSession: the
// server-verified owner), sent as generateSyllabus's one argument — never the account the browser happens to hold when the
// request leaves. The server refuses before reading a goal or calling the provider when the verified caller is another
// account, or when no usable owner was sent; with no rendered owner nothing is sent at all. The plan on screen stays, a
// fixed message says nothing was generated, and a fresh page (a document link) is offered; nothing is retried.
const OWNER_MISMATCH =
  "This page was opened for a different account than the one signed in now, so nothing was saved or generated. Reload the page to continue with the account that's signed in.";
const OWNER_INTENT_INVALID = "This page is out of date, so nothing was saved or generated. Reload the page to continue.";
// AG-WEB-READY-06-P1: the answer to a generation is applied only by the view that asked for it — still on screen, not left,
// and still showing the account this page was rendered for (useRenderedSession: the server-verified owner), confirmed when
// the answer arrives the way owner-bound requests are (confirmOwnerSession; the managed client's ordinary session read, which
// may renew an expiring session of that same account, as everywhere else). A confirmation can join a session read that began
// before a sign-in was published, so a "ready" answer is confirmed once more — a fresh read, since the joined one has ended —
// and only then applied, with no further wait (the rendered-session boundary's rule: confirmed once more, never more). That
// second answer can only refuse. Nothing here reads the stored session itself, writes, refreshes or ends a session, and
// nothing is adopted from the browser.
// A request already sent is neither retried, cancelled nor compensated: the server may already have saved the plan for the
// account it verified. When the sign-in was confirmed changed or ended, or cannot be confirmed now (an Auth outage is not a
// sign-out), the answer is withheld and the whole view — plan, details and controls — is replaced by fixed guidance with a
// fresh page; nothing generates by itself.
const RESULT_SIGN_IN_CHANGED =
  "This browser signed in to a different account before your plan's result arrived, so it isn't shown here. A new plan may already have been saved for the account this page was opened for. Reload the page to continue with the account that's signed in now.";
const RESULT_SIGN_IN_ENDED =
  "This page's sign-in ended before your plan's result arrived, so it isn't shown here. A new plan may already have been saved. Reload the page to continue.";
const RESULT_ACCOUNT_UNCONFIRMED =
  "We couldn't confirm the signed-in account, so your plan's result isn't shown here. A new plan may already have been saved. Reload My Plan to see what's saved.";
type Withheld = "changed" | "ended" | "unconfirmed";
const WITHHELD_COPY: Readonly<Record<Withheld, string>> = { changed: RESULT_SIGN_IN_CHANGED, ended: RESULT_SIGN_IN_ENDED, unconfirmed: RESULT_ACCOUNT_UNCONFIRMED };

/**
 * P1: a press that will leave this page in this window — a primary, unmodified press on a same-origin link to a different
 * page (not a new tab or window, not a download, not this same page or a fragment of it). Same rule as GoalsForm's.
 */
function leavesThisPage(event: Event): boolean {
  const press = event as MouseEvent;
  if (press.defaultPrevented || (typeof press.button === "number" && press.button !== 0)) return false;
  if (press.metaKey || press.ctrlKey || press.shiftKey || press.altKey) return false;
  const target = press.target as { closest?: (selector: string) => unknown } | null;
  const link = target && typeof target.closest === "function" ? (target.closest("a[href]") as HTMLAnchorElement | null) : null;
  if (!link) return false;
  const opens = link.getAttribute("target");
  if ((opens && opens !== "_self") || link.hasAttribute("download")) return false;
  try {
    const to = new URL(link.getAttribute("href") ?? "", window.location.href);
    return to.origin === window.location.origin && (to.pathname !== window.location.pathname || to.search !== window.location.search);
  } catch {
    return false;
  }
}
interface Notice {
  text: string;
  /** "error": nothing new was attempted or stored; "info": an observed outcome other than saved; "ok": saved. */
  tone: "error" | "info" | "ok";
  /** The outcome came from the content readback: offer a fresh, server-rendered view of what is saved. */
  reload: boolean;
  /** G1: an ownership refusal — rendered as guidance the rendered-session boundary lets act, with "Reload page". */
  owner?: boolean;
}

export default function PlanDisplay({ initialSyllabus, hasGoals }: Props) {
  const rendered = useRenderedSession();
  const [isPending, startTransition] = useTransition();
  // AG-S1: only a plan that came from storage is ever shown — the page's own read, or the boundary's content
  // readback after an attempt. A generated plan the server could not confirm never replaces it.
  const [syllabus, setSyllabus] = useState<GoalPlan | null>(initialSyllabus);
  const [view, setView] = useState<View>("plan");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [openWeek, setOpenWeek] = useState<number>(0);
  // P1: the answer to a generation was withheld (the sign-in changed, ended or could not be confirmed when it arrived). When
  // the server's answer was itself a fixed G1 refusal (nothing was saved), that known outcome is said instead of "may already
  // have been saved"; it carries no data either way.
  const [withheld, setWithheld] = useState<{ kind: Withheld; refusal: "owner_mismatch" | "owner_intent_invalid" | null } | null>(null);
  // P1: the fixed guidance takes keyboard focus when it replaces the view (its controls are gone)
  const guidanceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (withheld) guidanceRef.current?.focus();
  }, [withheld]);
  // P1: false once this view is no longer on screen (the golfer left, or the dashboard shell was removed)
  const liveRef = useRef(true);
  // P1: the golfer chose to leave while an answer was pending — a link pressed, or back/forward. The app router queues that
  // navigation behind the running Server Action, so the view is still mounted when the answer arrives; the answer must not
  // then be applied over that choice.
  const departedRef = useRef(false);
  useEffect(() => {
    liveRef.current = true;
    if (typeof document === "undefined" || typeof window === "undefined") {
      return () => {
        liveRef.current = false;
      };
    }
    const onPress = (event: Event) => {
      if (leavesThisPage(event)) departedRef.current = true;
    };
    const onHistory = () => {
      departedRef.current = true;
    };
    document.addEventListener("click", onPress, true);
    window.addEventListener("popstate", onHistory);
    return () => {
      liveRef.current = false;
      document.removeEventListener("click", onPress, true);
      window.removeEventListener("popstate", onHistory);
    };
  }, []);

  /** P1: whether the answer that just arrived may be applied by this view, and if not, what to show instead. */
  async function mayApplyAnswer(): Promise<"apply" | "drop" | Withheld> {
    if (!liveRef.current || departedRef.current) return "drop";
    if (rendered === null) return "unconfirmed"; // no rendered account to apply it to
    const ownerId = rendered.ownerId;
    const confirm = async (): Promise<Awaited<ReturnType<typeof confirmOwnerSession>>> => {
      try {
        return await confirmOwnerSession(() => createClient(), ownerId);
      } catch {
        return { status: "unavailable" };
      }
    };
    const refusal = (status: string): Withheld =>
      status === "account_changed" ? "changed" : status === "signed_out" || status === "ended" ? "ended" : "unconfirmed";
    const first = await confirm();
    if (!liveRef.current || departedRef.current) return "drop";
    if (first.status !== "ready") return refusal(first.status);
    // the first read may have joined one that began before a sign-in was published: confirm once more (never more)
    const again = await confirm();
    if (!liveRef.current || departedRef.current) return "drop";
    return again.status === "ready" ? "apply" : refusal(again.status);
  }

  function run() {
    setNotice(null);
    setConfirming(false);
    // G1: no rendered owner, nothing to request a plan as (never the cookie's account): fixed guidance, no request
    const owner = rendered?.ownerId ?? null;
    if (owner === null) {
      setNotice({ text: OWNER_INTENT_INVALID, tone: "error", reload: true, owner: true });
      return;
    }
    departedRef.current = false; // only a departure while this request's answer is pending counts
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof generateSyllabus>> | undefined;
      try {
        result = await generateSyllabus(owner);
      } catch {
        result = undefined;
      }
      // P1: nothing of the answer — plan, view instruction or message, including a refusal or a missing answer — is used
      // until this view is confirmed to still be the one that asked, for the account it was rendered for
      const may = await mayApplyAnswer();
      // this continuation resumes after an await of its own, so the view is checked again here, before anything of the
      // answer (its outcome, refusal code, plan, display instruction or message) is used: a view that is gone does nothing
      // at all; a view that was left while the helper returned shows only fixed, data-free uncertainty (the plan may already
      // be saved), never a result, and never overrides the chosen navigation
      if (!liveRef.current) return;
      if (may === "drop" || departedRef.current) {
        setNotice({ text: UNCONFIRMED, tone: "info", reload: true });
        return;
      }
      if (may !== "apply") {
        // only the fixed refusal code is read here, to say "nothing was saved" truthfully; no plan, state or message is used
        const refusal = result && (result.outcome === "owner_mismatch" || result.outcome === "owner_intent_invalid") ? result.outcome : null;
        setWithheld({ kind: may, refusal });
        return;
      }
      // the action failed (dropped connection) or came back without a result (Next resolves undefined when the
      // response is not a Server Action response, e.g. a platform timeout page): a write may or may not have happened,
      // so the last verified plan stays and the golfer is told what is actually known
      if (!result || typeof result.outcome !== "string") {
        setNotice({ text: UNCONFIRMED, tone: "info", reload: true });
        return;
      }
      // G1: refused before any work (another account is signed in now, or no usable owner was sent): the plan on screen
      // stays exactly as it is; fixed copy and a fresh page
      if (result.outcome === "owner_mismatch" || result.outcome === "owner_intent_invalid") {
        setNotice({ text: result.outcome === "owner_mismatch" ? OWNER_MISMATCH : OWNER_INTENT_INVALID, tone: "error", reload: true, owner: true });
        return;
      }
      if (result.display === "stored_plan" && result.plan) {
        setSyllabus(result.plan);
        setView("plan");
        setOpenWeek(0);
      } else if (result.display === "no_plan") {
        setSyllabus(null);
        setView("plan");
      } else if (result.display === "unreadable") {
        setView("unreadable");
      } else if (result.display === "goal_missing") {
        setView("goal_missing");
      }
      // "keep": the last verified plan stays exactly as it is on screen
      if (result.message) {
        const tone = result.outcome === "saved" ? "ok" : result.observed ? "info" : "error";
        setNotice({ text: result.message, tone, reload: result.observed });
      }
    });
  }

  /** Generate when nothing is saved; Regenerate (replacing a saved plan) asks first. */
  function generate() {
    if (syllabus) setConfirming(true);
    else run();
  }

  const noticeBlock = notice && (
    <div className="mt-3" {...(notice.owner ? { "data-rendered-session-guidance": "plan" } : {})}>
      <p
        role={notice.tone === "error" ? "alert" : "status"}
        className={`text-xs rounded-lg px-3 py-2 border break-words ${
          notice.tone === "error"
            ? "text-red-400 bg-red-400/10 border-red-400/20"
            : notice.tone === "ok"
            ? "text-golf-green bg-golf-green/10 border-golf-green/20"
            : "text-amber-300 bg-amber-500/10 border-amber-500/20"
        }`}
      >
        {notice.text}
      </p>
      {notice.reload && (
        // a document link on purpose: a fresh server render of what is saved now (no automatic refresh, which
        // would remount this view and drop the message above)
        <a
          href="/goals/plan"
          className={`mt-2 inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl border border-white/10 text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors ${FOCUS_RING}`}
        >
          {notice.owner ? "Reload page" : "Reload My Plan"}
        </a>
      )}
    </div>
  );

  // ── P1: the answer was withheld — the whole account-bearing view is replaced by fixed guidance ─────────

  if (withheld) {
    const copy = withheld.refusal === "owner_mismatch" ? OWNER_MISMATCH : withheld.refusal === "owner_intent_invalid" ? OWNER_INTENT_INVALID : WITHHELD_COPY[withheld.kind];
    return (
      <div className="max-w-md mx-auto text-center py-12">
        {/* guidance (the rendered-session boundary lets its own controls act); no plan, detail or generation control remains */}
        <div ref={guidanceRef} tabIndex={-1} role="status" data-rendered-session-guidance="plan" className="bg-golf-header border border-white/5 rounded-2xl p-7 focus:outline-none">
          <p className="text-sm text-gray-300 mb-2 break-words">{copy}</p>
          {/* a document link on purpose: a fresh server render for the account signed in now; nothing generates by itself */}
          <a
            href="/goals/plan"
            className={`mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors ${FOCUS_RING}`}
          >
            {withheld.kind === "unconfirmed" && withheld.refusal === null ? "Reload My Plan" : "Reload page"}
          </a>
        </div>
      </div>
    );
  }

  // ── No goals yet ─────────────────────────────────────────────────────────

  if (!hasGoals) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-5">
          <Target className="w-7 h-7 text-gray-500" aria-hidden="true" />
        </div>
        <p className="text-white font-semibold mb-2">No goals set yet</p>
        <p className="text-sm text-gray-400 mb-6">
          Complete the goals onboarding to get your personalised AI plan.
        </p>
        <a
          href="/goals"
          className={`inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors ${FOCUS_RING}`}
        >
          Set My Goals
        </a>
      </div>
    );
  }

  // ── After an attempt: the goal is gone, or its stored plan cannot be shown ─

  if (view === "goal_missing") {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        {noticeBlock}
        <a
          href="/goals"
          className={`mt-4 inline-flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors ${FOCUS_RING}`}
        >
          Open My Goals
        </a>
      </div>
    );
  }

  if (view === "unreadable") {
    return (
      <div>
        <GoalsLoadError variant="unreadable" />
        <div className="max-w-2xl mx-auto">{noticeBlock}</div>
      </div>
    );
  }

  // ── Generate prompt (no syllabus yet) ────────────────────────────────────

  if (!syllabus) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="w-16 h-16 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-6">
          <Zap className="w-8 h-8 text-golf-green" fill="currentColor" aria-hidden="true" />
        </div>
        <h2 className="text-xl font-black italic tracking-tighter uppercase text-white mb-2">
          Ready to Build Your Plan
        </h2>
        <p className="text-sm text-gray-400 mb-8 max-w-sm mx-auto">
          Your goals are saved. SwingProAI can use AI to turn your answers into
          a practice plan with weekly themes and drills. It isn&apos;t reviewed
          by a coach.
        </p>

        {notice && <div className="mb-6">{noticeBlock}</div>}

        <button
          onClick={generate}
          disabled={isPending}
          className={`inline-flex items-center gap-2.5 min-h-11 px-6 py-3 rounded-xl bg-golf-green hover:bg-golf-green/90 disabled:opacity-60 text-sm font-black uppercase tracking-widest text-white transition-colors ${FOCUS_RING}`}
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Generating…
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" fill="currentColor" aria-hidden="true" />
              Generate My Plan
            </>
          )}
        </button>
        {isPending && (
          <p role="status" className="text-xs text-gray-400 mt-4">
            Building your plan…
          </p>
        )}
      </div>
    );
  }

  // ── Syllabus accordion ────────────────────────────────────────────────────

  // Shown only in the shape the view renders (GJ-PARALLEL-03); every plan here
  // came from storage, and is checked again all the same.
  const plan = toGoalPlan(syllabus);
  if (!plan) return <GoalsLoadError variant="unreadable" />;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Summary card */}
      <div className="bg-golf-header border border-white/5 rounded-2xl px-4 sm:px-6 py-5 mb-6">
        <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-2">
          AI-Generated · {plan.weeks.length}-Week Plan
        </p>
        <p className="text-sm text-gray-300 leading-relaxed break-words">{plan.summary}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-400 min-w-0">{GOALS_COPY.aiPlanNote}</p>
          <button
            onClick={generate}
            disabled={isPending}
            title="Replace this plan with a new AI-generated one"
            className={`shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-4 rounded-xl border border-white/10 text-sm font-medium text-gray-300 hover:text-white hover:border-white/20 transition-colors disabled:opacity-40 ${FOCUS_RING}`}
          >
            {isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            )}
            {GOALS_COPY.regenerate}
          </button>
        </div>
        {confirming && (
          <div role="group" aria-labelledby="goal-plan-replace-question" className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3">
            <p id="goal-plan-replace-question" role="status" className="text-xs text-gray-300 mb-3">Replace your saved plan with a new AI-generated one?</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={run}
                disabled={isPending}
                className={`inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl bg-golf-green hover:bg-golf-green/90 disabled:opacity-60 text-sm font-bold text-white transition-colors ${FOCUS_RING}`}
              >
                Replace plan
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isPending}
                className={`inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl border border-white/10 text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors ${FOCUS_RING}`}
              >
                Keep current plan
              </button>
            </div>
          </div>
        )}
        {noticeBlock}
      </div>

      {/* Week accordions */}
      <div className="space-y-3">
        {plan.weeks.map((week, idx) => {
          const isOpen = openWeek === idx;
          const bodyId = `goal-plan-week-${idx}`;
          const drillCount = `${week.drills.length} ${week.drills.length === 1 ? "drill" : "drills"}`;
          return (
            <div
              key={idx}
              className="bg-golf-header border border-white/5 rounded-2xl overflow-hidden"
            >
              {/* Accordion header */}
              <h2>
                <button
                  type="button"
                  onClick={() => setOpenWeek(isOpen ? -1 : idx)}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? bodyId : undefined}
                  className="w-full min-h-11 flex items-center justify-between gap-3 px-4 sm:px-6 py-4 text-left hover:bg-white/[0.03] transition-colors rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-400"
                >
                  <span className="flex items-center gap-4 min-w-0">
                    <span className="sr-only">Week {week.week}: </span>
                    <span aria-hidden="true" className="w-9 h-9 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0 text-xs font-black text-golf-green">
                      W{week.week}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-white break-words">{week.theme}</span>
                      {week.focus && <span className="block text-[11px] text-gray-400 mt-0.5 break-words">{week.focus}</span>}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <span className="hidden sm:block text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                      {drillCount}
                    </span>
                    {isOpen ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" aria-hidden="true" />
                    )}
                  </span>
                </button>
              </h2>

              {/* Accordion body */}
              {isOpen && (
                <div id={bodyId} className="px-4 sm:px-6 pb-6 border-t border-white/[0.06]">
                  {/* Drills */}
                  {week.drills.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {week.drills.map((drill, di) => {
                        const cat = drill.category ? CATEGORY_STYLE[drill.category] : null;
                        return (
                          <div
                            key={di}
                            className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4"
                          >
                            <div className="flex items-start justify-between gap-3 mb-2">
                              <p className="min-w-0 text-sm font-semibold text-white leading-tight break-words">
                                {drill.name}
                              </p>
                              {cat && (
                                <span
                                  className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${cat.bg} ${cat.border} ${cat.text}`}
                                >
                                  {cat.label}
                                </span>
                              )}
                            </div>
                            {drill.description && (
                              <p className="text-xs text-gray-400 leading-relaxed mb-3 break-words">
                                {drill.description}
                              </p>
                            )}
                            {drill.duration && (
                              <div className="flex items-center gap-1.5 text-gray-400 min-w-0">
                                <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
                                <span className="text-[11px] font-medium break-words min-w-0">{drill.duration}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Weekly goal */}
                  {week.weekly_goal && (
                    <div className="mt-4 flex items-start gap-3 bg-golf-green/[0.06] border border-golf-green/20 rounded-xl px-4 py-3">
                      <CheckCircle2 className="w-4 h-4 text-golf-green shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-1">
                          Weekly Goal
                        </p>
                        <p className="text-xs text-gray-300 break-words">{week.weekly_goal}</p>
                      </div>
                    </div>
                  )}

                  {/* Tip */}
                  {week.pro_tip && (
                    <div className="mt-3 flex items-start gap-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-xl px-4 py-3">
                      <Lightbulb className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-400 mb-1">
                          Tip
                        </p>
                        <p className="text-xs text-gray-300 break-words">{week.pro_tip}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
