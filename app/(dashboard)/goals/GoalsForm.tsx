"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Target, TrendingUp, Crosshair, ArrowRight } from "lucide-react";
import { submitGoals } from "./actions";

const MISS_OPTIONS = ["None", "Slice", "Hook", "Fat", "Thin"] as const;

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
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const [handicap, setHandicap] = useState("");
  const [primaryMiss, setPrimaryMiss] = useState("None");
  const [targetGoal, setTargetGoal] = useState("");

  function nextStep() {
    setError(null);
    if (step === 1 && handicap === "") {
      setError("Please enter your current handicap.");
      return;
    }
    if (step === 3) return handleSubmit();
    setStep((s) => s + 1);
  }

  function handleSubmit() {
    const fd = new FormData();
    fd.set("handicap_baseline", handicap);
    fd.set("primary_miss", primaryMiss);
    fd.set("target_goal", targetGoal);

    startTransition(async () => {
      const result = await submitGoals(fd);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push("/goals/plan");
    });
  }

  const inputCls =
    "w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-golf-green";

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
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
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
          <p className="mt-4 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
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
              className="px-5 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={nextStep}
            disabled={isPending}
            className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 disabled:opacity-50 text-sm font-black uppercase tracking-widest text-white transition-colors"
          >
            {isPending ? (
              "Saving…"
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
