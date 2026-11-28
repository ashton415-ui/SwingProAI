"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Target, TrendingUp, Crosshair, ArrowRight } from "lucide-react";
import { submitGoals } from "./actions";
import { useRenderedSession } from "@/components/navigation/SessionKeeper";
import { createClient } from "@/utils/supabase/client";
import { confirmOwnerSession } from "@/lib/drill-hub-session";
import { readStoredSession } from "@/utils/supabase/session-storage";
import { jwtClaims } from "@/utils/supabase/session-cookie-layout";

const MISS_OPTIONS = ["None", "Slice", "Hook", "Fat", "Thin"] as const;
const ANSWERS_SAVED = "Your answers were saved.";
const ANSWERS_UNCONFIRMED = "We couldn't confirm your answers were saved. Open My Goals to check before trying again.";
// F1-A1 (V1): the answer to a submit is applied only by the view that asked for it — still on screen and still showing
// the account this page was rendered for (useRenderedSession: the server-verified owner), confirmed when the answer
// arrives the way owner-bound requests are (confirmOwnerSession). A view that was removed or left drops it; a confirmed
// end or change of the sign-in shows only fixed guidance; an account that cannot be confirmed now (an Auth outage)
// shows "couldn't confirm" and never a sign-out. In every such case nothing of the answer is shown, no navigation starts
// and nothing is submitted again (the answers may already be saved).
const RESULT_SIGN_IN_CHANGED =
  "This browser signed in to a different account before your answers' result arrived, so it isn't shown here. Your answers may already be saved. Reload to continue with the account that's signed in now.";
const RESULT_SIGN_IN_ENDED =
  "This page's sign-in ended before your answers' result arrived, so it isn't shown here. Your answers may already be saved. Reload to continue.";

/** F1-A1 (V1): the account the browser's stored session cookie envelope names (a local read; no request), or null. */
function storedSubject(): string | null {
  try {
    const stored = readStoredSession();
    return stored.kind === "present" ? jwtClaims(stored.envelope.accessToken).sub : null;
  } catch {
    return null;
  }
}

/**
 * F1-A1 (V1): a press that will leave this page in this window: a primary, unmodified press on a same-origin link to a
 * different page (not a new tab or window, not a download, not this same page or a fragment of it) — the same presses the
 * router itself turns into a navigation.
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
const RESULT_ACCOUNT_UNCONFIRMED =
  "We couldn't confirm the signed-in account, so your result isn't shown here. Open My Goals to check before trying again.";
// AG-WEB-READY-05-G1: the answers are sent only for the account this page was rendered for (useRenderedSession: the
// server-verified owner) — as the one EXPECTED_OWNER_FIELD entry (lib/goal-plan-generation.ts; a literal here because that
// module is server-only), never the account the browser happens to hold when the request leaves. The server refuses
// before saving anything when the verified caller is another account, or when the page sent no usable owner; with no
// rendered owner nothing is sent at all. Either way the golfer is told nothing was saved and offered a fresh page; nothing
// is retried or resubmitted, and the newer sign-in is left as it is.
const EXPECTED_OWNER_FIELD = "expected_owner_id";
const OWNER_MISMATCH =
  "This page was opened for a different account than the one signed in now, so nothing was saved or generated. Reload the page to continue with the account that's signed in.";
const OWNER_INTENT_INVALID = "This page is out of date, so nothing was saved or generated. Reload the page to continue.";

const STEPS = [
  {
    id: 1,
    label: "Baseline",
    icon: TrendingUp,
    description: "Where are you starting from?",
  },
  {
    id: 2,
    label: "Miss Pattern",
    icon: Crosshair,
    description: "What shot shape hurts your game most?",
  },
  {
    id: 3,
    label: "Target",
    icon: Target,
    description: "What does success look like for you?",
  },
];

export default function GoalsForm() {
  const router = useRouter();
  const rendered = useRenderedSession();
  // F1-A1 (V1): false once this form is no longer on screen (the golfer left, or the shell was removed)
  const liveRef = useRef(true);
  // F1-A1 (V1): the golfer chose to leave while an answer was pending — a link pressed, or back/forward. The app router
  // queues that navigation behind the running Server Action, so the form is still mounted when the answer arrives; the
  // answer must not then send the golfer somewhere else (or show a result) over that choice.
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
  // F1-A1 (V1): the sign-in this view was rendered for was confirmed changed or ended when an answer arrived
  const [resultWithheld, setResultWithheld] = useState<"changed" | "ended" | null>(null);
  // G1: the server (or, with no rendered owner, this form) refused before anything was saved
  const [ownerRefused, setOwnerRefused] = useState<"mismatch" | "invalid" | null>(null);
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const [handicap, setHandicap] = useState("");
  const [primaryMiss, setPrimaryMiss] = useState("None");
  const [targetGoal, setTargetGoal] = useState("");
  // AG-S1: once the answers are confirmed saved (or their save could not be confirmed), the form is replaced by
  // the outcome and a link, so the same answers cannot be submitted twice by accident.
  const [outcome, setOutcome] = useState<{ lines: string[]; href: string; label: string } | null>(null);

  function nextStep() {
    setError(null);
    if (step === 1 && handicap === "") {
      setError("Please enter your current handicap.");
      return;
    }
    if (step === 3) return handleSubmit();
    setStep((s) => s + 1);
  }

  /** F1-A1 (V1): whether the answer that just arrived may be applied by this view, and if not, what to show instead. */
  async function mayApplyAnswer(): Promise<"apply" | "drop" | "changed" | "ended" | "unconfirmed"> {
    if (!liveRef.current || departedRef.current) return "drop";
    if (rendered === null) return "unconfirmed"; // no rendered account to apply it to
    let answer: Awaited<ReturnType<typeof confirmOwnerSession>>;
    try {
      answer = await confirmOwnerSession(() => createClient(), rendered.ownerId);
    } catch {
      answer = { status: "unavailable" };
    }
    if (!liveRef.current || departedRef.current) return "drop";
    if (answer.status === "ready") {
      // the confirmation may have joined a read that began before a switch, or a sign-in may have been published since:
      // the jar must still name the rendered account at the moment the answer is applied (security review S2)
      const holder = storedSubject();
      return holder !== null && holder !== rendered.ownerId ? "changed" : "apply";
    }
    if (answer.status === "account_changed") return "changed";
    if (answer.status === "signed_out" || answer.status === "ended") return "ended";
    return "unconfirmed";
  }

  function handleSubmit() {
    // G1: no rendered owner, nothing to send the answers as (never the cookie's account): fixed guidance, no request
    if (rendered === null) {
      setOwnerRefused("invalid");
      return;
    }
    const fd = new FormData();
    fd.set("handicap_baseline", handicap);
    fd.set("primary_miss", primaryMiss);
    fd.set("target_goal", targetGoal);
    fd.set(EXPECTED_OWNER_FIELD, rendered.ownerId);

    departedRef.current = false; // only a departure while this submit's answer is pending counts
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof submitGoals>> | undefined;
      try {
        result = await submitGoals(fd);
      } catch {
        result = undefined;
      }
      const may = await mayApplyAnswer();
      if (may === "drop") {
        // still on screen while the chosen navigation completes: fixed guidance (never the result), no resubmit
        if (liveRef.current) setOutcome({ lines: [ANSWERS_UNCONFIRMED], href: "/goals", label: "Open My Goals" });
        return;
      }
      // G1: refused before anything was saved (another account is signed in now, or the page sent no usable owner): this
      // fixed answer carries no data, so it is shown whatever the browser holds now — with a fresh page, never a resubmit
      if (result && (result.outcome === "owner_mismatch" || result.outcome === "owner_intent_invalid")) {
        setOwnerRefused(result.outcome === "owner_mismatch" ? "mismatch" : "invalid");
        return;
      }
      if (may === "changed" || may === "ended") {
        setResultWithheld(may);
        return;
      }
      if (may === "unconfirmed") {
        setOutcome({ lines: [RESULT_ACCOUNT_UNCONFIRMED], href: "/goals", label: "Open My Goals" });
        return;
      }
      // the action failed (dropped connection) or came back without a result (Next resolves undefined when the
      // response is not a Server Action response, e.g. a platform timeout page): the insert may have committed
      if (!result || typeof result.outcome !== "string") {
        setOutcome({ lines: [ANSWERS_UNCONFIRMED], href: "/goals", label: "Open My Goals" });
        return;
      }
      if (result.outcome === "saved") {
        router.push("/goals/plan");
        return;
      }
      if (result.goalSaved) {
        // the goal row exists; its plan was not confirmed (the message says what was observed)
        const link = result.outcome === "goal_missing"
          ? { href: "/goals", label: "Open My Goals" }
          : { href: "/goals/plan", label: result.outcome === "save_unconfirmed" ? "Reload My Plan" : "Open My Plan" };
        setOutcome({ lines: [ANSWERS_SAVED, result.message ?? ""].filter(Boolean), ...link });
        return;
      }
      if (result.outcome === "goal_save_unconfirmed") {
        // the insert may have committed: send the golfer to check rather than offering a resubmit
        setOutcome({ lines: [result.message ?? ""], href: "/goals", label: "Open My Goals" });
        return;
      }
      setError(result.message);
    });
  }

  const inputCls =
    "w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white text-base lg:text-sm placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-golf-green";

  if (ownerRefused) {
    return (
      <div className="max-w-lg mx-auto">
        {/* guidance (the rendered-session boundary lets its own controls act); nothing was saved, nothing is retried */}
        <div role="status" data-rendered-session-guidance="goals" className="bg-golf-header border border-white/5 rounded-2xl p-7 text-center">
          <p className="text-sm text-gray-300 mb-2 break-words">{ownerRefused === "mismatch" ? OWNER_MISMATCH : OWNER_INTENT_INVALID}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }

  if (resultWithheld) {
    return (
      <div className="max-w-lg mx-auto">
        {/* guidance (the rendered-session boundary lets its own controls act); nothing of the old answer is shown */}
        <div role="status" data-rendered-session-guidance="goals" className="bg-golf-header border border-white/5 rounded-2xl p-7 text-center">
          <p className="text-sm text-gray-300 mb-2 break-words">{resultWithheld === "changed" ? RESULT_SIGN_IN_CHANGED : RESULT_SIGN_IN_ENDED}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }

  if (outcome) {
    return (
      <div className="max-w-lg mx-auto">
        <div role="status" className="bg-golf-header border border-white/5 rounded-2xl p-7 text-center">
          {outcome.lines.map((line) => (
            <p key={line} className="text-sm text-gray-300 mb-2 break-words">
              {line}
            </p>
          ))}
          {/* a document link on purpose (fresh render of the page, no cached client view) */}
          <a
            href={outcome.href}
            className="mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            {outcome.label}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      {/* Progress steps */}
      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2 flex-1 last:flex-none">
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${
                step === s.id
                  ? "bg-golf-green/15 border border-golf-green/30 text-golf-green"
                  : step > s.id
                  ? "bg-white/5 border border-white/10 text-gray-400"
                  : "bg-white/[0.03] border border-white/5 text-gray-600"
              }`}
            >
              <s.icon className="w-3 h-3 shrink-0" />
              {s.label}
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px ${
                  step > s.id ? "bg-white/20" : "bg-white/[0.06]"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step card */}
      <div className="bg-golf-header border border-white/5 rounded-2xl p-7">
        {/* Step header */}
        <div className="mb-7">
          {(() => {
            const current = STEPS[step - 1];
            const Icon = current.icon;
            return (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-golf-green" />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                    Step {step} of {STEPS.length}
                  </span>
                </div>
                <p className="text-sm text-gray-400">{current.description}</p>
              </>
            );
          })()}
        </div>

        {/* Step 1 — Handicap */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Current Handicap Index
              </label>
              <input
                type="number"
                step="0.1"
                min="-10"
                max="54"
                placeholder="e.g. 18.4"
                value={handicap}
                onChange={(e) => setHandicap(e.target.value)}
                className={inputCls}
                autoFocus
              />
              <p className="text-xs text-gray-600 mt-1.5">
                Enter your USGA Handicap Index, or your best estimate.
              </p>
            </div>
          </div>
        )}

        {/* Step 2 — Primary miss */}
        {step === 2 && (
          <div className="space-y-3">
            <label className="block text-sm font-semibold text-gray-300 mb-3">
              Primary Miss
            </label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {MISS_OPTIONS.map((miss) => (
                <button
                  key={miss}
                  type="button"
                  onClick={() => setPrimaryMiss(miss)}
                  className={`min-h-11 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                    primaryMiss === miss
                      ? "bg-golf-green/15 border-golf-green/40 text-golf-green"
                      : "bg-white/[0.03] border-white/10 text-gray-400 hover:border-white/20 hover:text-white"
                  }`}
                >
                  {miss}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-600 pt-1">
              Which miss costs you the most strokes per round?
            </p>
          </div>
        )}

        {/* Step 3 — Target goal */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Target Goal
              </label>
              <textarea
                rows={3}
                maxLength={500}
                placeholder="e.g. Break 90 by end of season, fix my driver slice, improve iron consistency…"
                value={targetGoal}
                onChange={(e) => setTargetGoal(e.target.value)}
                className={`${inputCls} resize-none`}
                autoFocus
              />
              <p className="text-xs text-gray-600 mt-1.5">
                Be specific — this shapes your AI-generated practice syllabus.
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3 mt-7">
          {step > 1 && (
            <button
              type="button"
              onClick={() => { setError(null); setStep((s) => s - 1); }}
              disabled={isPending}
              className="min-h-11 min-w-11 px-5 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={nextStep}
            disabled={isPending}
            className="flex-1 flex items-center justify-center gap-2 min-h-11 px-5 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 disabled:opacity-50 text-sm font-black uppercase tracking-widest text-white transition-colors"
          >
            {isPending ? (
              "Building Your Plan…"
            ) : step === STEPS.length ? (
              "Generate My Plan"
            ) : (
              <>
                Next <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
