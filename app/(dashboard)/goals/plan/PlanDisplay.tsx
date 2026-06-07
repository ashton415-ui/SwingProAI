"use client";

import { useState, useTransition } from "react";
import {
  Zap,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Loader2,
  Target,
  Clock,
  Lightbulb,
  CheckCircle2,
} from "lucide-react";
import { generateSyllabus } from "../actions";
import type { SyllabusData, Drill } from "../types";

// ── Category styling ───────────────────────────────────────────────────────────

const CATEGORY_STYLE: Record<
  Drill["category"],
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  initialSyllabus: SyllabusData | null;
  hasGoals: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PlanDisplay({ initialSyllabus, hasGoals }: Props) {
  const [isPending, startTransition] = useTransition();
  const [syllabus, setSyllabus] = useState<SyllabusData | null>(initialSyllabus);
  const [error, setError] = useState<string | null>(null);
  const [openWeek, setOpenWeek] = useState<number>(0);

  function generate() {
    setError(null);
    startTransition(async () => {
      const result = await generateSyllabus();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.syllabus) {
        setSyllabus(result.syllabus);
        setOpenWeek(0);
      }
    });
  }

  // ── No goals yet ─────────────────────────────────────────────────────────

  if (!hasGoals) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-5">
          <Target className="w-7 h-7 text-gray-500" />
        </div>
        <p className="text-white font-semibold mb-2">No goals set yet</p>
        <p className="text-sm text-gray-500 mb-6">
          Complete the goals onboarding to get your personalised AI plan.
        </p>
        <a
          href="/goals"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors"
        >
          Set My Goals
        </a>
      </div>
    );
  }

  // ── Generate prompt (no syllabus yet) ────────────────────────────────────

  if (!syllabus) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="w-16 h-16 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-6">
          <Zap className="w-8 h-8 text-golf-green" fill="currentColor" />
        </div>
        <h2 className="text-xl font-black italic tracking-tighter uppercase text-white mb-2">
          Ready to Build Your Plan
        </h2>
        <p className="text-sm text-gray-400 mb-8 max-w-sm mx-auto">
          Our AI coach will analyse your handicap, miss pattern, and goal to
          generate a personalised 4-week practice syllabus with specific drills.
        </p>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 mb-6">
            {error}
          </p>
        )}

        <button
          onClick={generate}
          disabled={isPending}
          className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-golf-green hover:bg-golf-green/90 disabled:opacity-60 text-sm font-black uppercase tracking-widest text-white transition-colors"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" fill="currentColor" />
              Generate My Plan
            </>
          )}
        </button>
        {isPending && (
          <p className="text-xs text-gray-600 mt-4">
            This takes about 10-15 seconds…
          </p>
        )}
      </div>
    );
  }

  // ── Syllabus accordion ────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto">
      {/* Summary card */}
      <div className="bg-golf-header border border-white/5 rounded-2xl px-6 py-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-2">
              AI-Generated · 4-Week Plan
            </p>
            <p className="text-sm text-gray-300 leading-relaxed">{syllabus.summary}</p>
          </div>
          <button
            onClick={generate}
            disabled={isPending}
            title="Regenerate plan"
            className="shrink-0 p-2 rounded-xl border border-white/10 text-gray-500 hover:text-white hover:border-white/20 transition-colors disabled:opacity-40"
          >
            {isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-400 mt-3 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Week accordions */}
      <div className="space-y-3">
        {syllabus.weeks.map((week, idx) => {
          const isOpen = openWeek === idx;
          return (
            <div
              key={week.week}
              className="bg-golf-header border border-white/5 rounded-2xl overflow-hidden"
            >
              {/* Accordion header */}
              <button
                onClick={() => setOpenWeek(isOpen ? -1 : idx)}
                className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/[0.03] transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0">
                    <span className="text-xs font-black text-golf-green">W{week.week}</span>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">{week.theme}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{week.focus}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="hidden sm:block text-[10px] font-bold text-gray-600 uppercase tracking-widest">
                    {week.drills.length} drills
                  </span>
                  {isOpen ? (
                    <ChevronUp className="w-4 h-4 text-gray-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-500" />
                  )}
                </div>
              </button>

              {/* Accordion body */}
              {isOpen && (
                <div className="px-6 pb-6 border-t border-white/[0.06]">
                  {/* Drills */}
                  <div className="mt-4 space-y-3">
                    {week.drills.map((drill, di) => {
                      const cat =
                        CATEGORY_STYLE[drill.category] ??
                        CATEGORY_STYLE["irons"];
                      return (
                        <div
                          key={di}
                          className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4"
                        >
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <p className="text-sm font-semibold text-white leading-tight">
                              {drill.name}
                            </p>
                            <span
                              className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${cat.bg} ${cat.border} ${cat.text}`}
                            >
                              {cat.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 leading-relaxed mb-3">
                            {drill.description}
                          </p>
                          <div className="flex items-center gap-1.5 text-gray-600">
                            <Clock className="w-3 h-3" />
                            <span className="text-[11px] font-medium">{drill.duration}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Weekly goal */}
                  <div className="mt-4 flex items-start gap-3 bg-golf-green/[0.06] border border-golf-green/20 rounded-xl px-4 py-3">
                    <CheckCircle2 className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-1">
                        Weekly Goal
                      </p>
                      <p className="text-xs text-gray-300">{week.weekly_goal}</p>
                    </div>
                  </div>

                  {/* Pro tip */}
                  <div className="mt-3 flex items-start gap-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-xl px-4 py-3">
                    <Lightbulb className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-amber-400 mb-1">
                        Pro Tip
                      </p>
                      <p className="text-xs text-gray-300">{week.pro_tip}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
