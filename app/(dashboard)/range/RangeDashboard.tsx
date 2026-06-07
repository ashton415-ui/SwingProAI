"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Repeat,
  Ruler,
  Shuffle,
  CheckCircle2,
  XCircle,
  ChevronRight,
  RotateCcw,
  LayoutDashboard,
  Loader2,
  Trophy,
} from "lucide-react";
import { saveRangeSession } from "./actions";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Shot {
  club: string;
  cue: string;
}

interface Template {
  id: string;
  name: string;
  badge: string;
  tagline: string;
  description: string;
  Icon: React.ElementType;
  accent: string;
  accentBg: string;
  accentBorder: string;
  accentText: string;
  shots: Shot[];
}

// ── Session templates ──────────────────────────────────────────────────────────

const TEMPLATES: Template[] = [
  {
    id: "technical",
    name: "Technical Drill Block",
    badge: "Block Practice",
    tagline: "Groove the pattern through repetition.",
    description:
      "Heavy block reps on a single movement. Ideal for ingraining a new swing change or fixing a specific fault.",
    Icon: Repeat,
    accent: "indigo",
    accentBg: "bg-indigo-500/10",
    accentBorder: "border-indigo-500/30",
    accentText: "text-indigo-400",
    shots: [
      { club: "7-iron", cue: "150yd flag. Takeaway drill — keep the clubhead outside your hands on the backswing." },
      { club: "7-iron", cue: "150yd flag. Same target. Feel the in-to-out path through impact." },
      { club: "7-iron", cue: "150yd flag. Focus: hands ahead of the ball at impact, shaft leaning forward." },
      { club: "7-iron", cue: "150yd flag. Full commitment. Trust the groove — no steering." },
      { club: "9-iron", cue: "130yd flag. Compression drill — strike ball first, then turf." },
      { club: "9-iron", cue: "130yd flag. 80% effort. Quiet lower body, arms swing freely." },
      { club: "9-iron", cue: "130yd flag. Check your finish — weight fully on lead foot, balanced." },
      { club: "9-iron", cue: "130yd flag. Same pre-shot routine. Execute without overthinking." },
      { club: "Driver", cue: "Center fairway. Wide arc drill — feel width on the backswing, slow tempo." },
      { club: "Driver", cue: "Center fairway. Hip-fire drill — initiate the downswing with your lower body." },
      { club: "Driver", cue: "Center fairway. Aggressive transition into a smooth impact. Stay behind the ball." },
      { club: "Driver", cue: "Center fairway. Final rep — trust everything you've drilled. Full send." },
    ],
  },
  {
    id: "calibration",
    name: "Feel & Distance Calibration",
    badge: "Variable Practice",
    tagline: "Dial in every club from PW to Driver.",
    description:
      "One shot per club at varied targets. Trains adaptability and sharpens your internal distance feel across the bag.",
    Icon: Ruler,
    accent: "emerald",
    accentBg: "bg-emerald-500/10",
    accentBorder: "border-emerald-500/30",
    accentText: "text-emerald-400",
    shots: [
      { club: "PW", cue: "100yd marker. 75% swing — feel the distance, don't force it. Note your carry." },
      { club: "9-iron", cue: "120yd flag. Normal tempo. Calibrate: does your 9i reach 120?" },
      { club: "8-iron", cue: "140yd flag. Commit to the target. Observe ball flight and landing zone." },
      { club: "7-iron", cue: "155yd marker. Slight draw — close stance one degree, swing in-to-out." },
      { club: "6-iron", cue: "170yd flag. Smooth 90% effort. Note dispersion left-right." },
      { club: "5-iron", cue: "185yd marker. Low stinger — choke down 1 inch, abbreviate finish at hip height." },
      { club: "4-hybrid", cue: "200yd marker. Sweep it, don't dig. Shallow angle of attack." },
      { club: "3-wood", cue: "220yd off a tee. Tee it low. Catch it on the way up, right off the deck feel." },
      { club: "Driver", cue: "Max distance zone. Aggressive tempo, full rotation, hold nothing back." },
    ],
  },
  {
    id: "simulation",
    name: "Simulated 18-Hole Round",
    badge: "Random Practice",
    tagline: "Play an imaginary round, shot by shot.",
    description:
      "Random practice that mirrors real course pressure. Each shot is a new situation — commit fully, as if it counts.",
    Icon: Shuffle,
    accent: "amber",
    accentBg: "bg-amber-500/10",
    accentBorder: "border-amber-500/30",
    accentText: "text-amber-400",
    shots: [
      { club: "Driver", cue: "Hole 1 (420yd par 4). Tee shot: right-center fairway. Controlled, balanced swing." },
      { club: "7-iron", cue: "Hole 1 — 155yd approach. Middle of the green. Avoid front bunker." },
      { club: "Driver", cue: "Hole 2 (380yd par 4). Aim at left tree line, play a gentle fade." },
      { club: "PW", cue: "Hole 2 — 95yd to tight front pin. Land short of the flag, let it release." },
      { club: "3-wood", cue: "Hole 3 (par 5). Lay-up to 100yd marker. Smooth 3-wood — don't overswing." },
      { club: "PW", cue: "Hole 3 — 100yd par-5 approach. Attack the flag. Full commitment." },
      { club: "6-iron", cue: "Hole 4 (185yd par 3). Wind left-to-right — aim one flag left. Smooth swing." },
      { club: "Driver", cue: "Hole 5 (445yd par 4). Narrow fairway — choke down 1 inch, aim at center." },
      { club: "5-iron", cue: "Hole 5 — 190yd uphill. Take 5-iron. Swing smooth to the back of the green." },
      { club: "8-iron", cue: "Hole 6 (145yd par 3). Into the breeze — take one extra club, choke down." },
      { club: "Driver", cue: "Hole 7 (405yd dogleg right). Tee shot: aim at the corner, cut it around." },
      { club: "9-iron", cue: "Hole 7 — 130yd to flag. Straight at the pin. Execute your stock shot." },
      { club: "3-wood", cue: "Hole 8 (par 5). Lay-up shot: stay short of the hazard at 200yd." },
      { club: "6-iron", cue: "Hole 8 — 175yd second shot. Go for it — left flag, green in two." },
      { club: "Driver", cue: "Hole 9 (390yd par 4). Home hole: commit fully, don't guide it." },
      { club: "8-iron", cue: "Hole 9 — 145yd approach. Middle of the green. Make the safe play." },
      { club: "PW", cue: "Bonus hole — 50yd pitch over bunker. High, soft shot. Controlled finish." },
      { club: "9-iron", cue: "Bonus — 125yd par-3 simulation. Picture the shot clearly, then execute." },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function performanceLabel(rate: number) {
  if (rate >= 0.85) return { label: "Elite Session", color: "text-emerald-400" };
  if (rate >= 0.7) return { label: "Solid Work", color: "text-golf-green" };
  if (rate >= 0.5) return { label: "Building", color: "text-amber-400" };
  return { label: "Keep Grinding", color: "text-slate-400" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RangeDashboard() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  type View = "selection" | "session" | "complete";
  const [view, setView] = useState<View>("selection");
  const [template, setTemplate] = useState<Template | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [results, setResults] = useState<boolean[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  function startSession(t: Template) {
    setTemplate(t);
    setCurrentIdx(0);
    setResults([]);
    setSaveError(null);
    setView("session");
  }

  function answerShot(executed: boolean) {
    if (!template) return;
    const newResults = [...results, executed];
    setResults(newResults);

    if (newResults.length === template.shots.length) {
      setView("complete");
      const shotsExecuted = newResults.filter(Boolean).length;
      startTransition(async () => {
        const res = await saveRangeSession({
          sessionType: template.id,
          shotsTotal: template.shots.length,
          shotsExecuted,
        });
        if (res.error) setSaveError(res.error);
      });
    } else {
      setCurrentIdx(newResults.length);
    }
  }

  function resetToSelection() {
    setView("selection");
    setTemplate(null);
    setCurrentIdx(0);
    setResults([]);
    setSaveError(null);
  }

  // ── Selection view ───────────────────────────────────────────────────────

  if (view === "selection") {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => startSession(t)}
            className="group text-left bg-golf-header border border-white/5 hover:border-white/15 rounded-2xl p-6 transition-colors"
          >
            <div
              className={`w-10 h-10 rounded-xl ${t.accentBg} border ${t.accentBorder} flex items-center justify-center mb-4`}
            >
              <t.Icon className={`w-5 h-5 ${t.accentText}`} />
            </div>

            <span
              className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${t.accentBg} ${t.accentBorder} ${t.accentText}`}
            >
              {t.badge}
            </span>

            <h2 className="text-base font-bold text-white mt-3 mb-1 group-hover:text-white/90">
              {t.name}
            </h2>
            <p className="text-[11px] text-golf-green font-semibold mb-2">{t.tagline}</p>
            <p className="text-xs text-gray-500 leading-relaxed">{t.description}</p>

            <div className="flex items-center gap-1 mt-5 text-xs font-semibold text-gray-500 group-hover:text-gray-300 transition-colors">
              {t.shots.length} shots
              <ChevronRight className="w-3.5 h-3.5" />
            </div>
          </button>
        ))}
      </div>
    );
  }

  // ── Session view ─────────────────────────────────────────────────────────

  if (view === "session" && template) {
    const shot = template.shots[currentIdx];
    const progress = currentIdx / template.shots.length;

    return (
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div
              className={`w-8 h-8 rounded-xl ${template.accentBg} border ${template.accentBorder} flex items-center justify-center`}
            >
              <template.Icon className={`w-4 h-4 ${template.accentText}`} />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-gray-500">
                {template.badge}
              </p>
              <p className="text-sm font-bold text-white">{template.name}</p>
            </div>
          </div>
          <button
            onClick={resetToSelection}
            className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
          >
            Exit
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-white/[0.06] rounded-full mb-6 overflow-hidden">
          <div
            className="h-full bg-golf-green rounded-full transition-all duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        {/* Shot counter */}
        <p className="text-[10px] font-black uppercase tracking-widest text-gray-600 mb-4">
          Shot {currentIdx + 1} of {template.shots.length}
        </p>

        {/* Shot card */}
        <div className="bg-golf-header border border-white/5 rounded-2xl p-6 mb-5">
          <span
            className={`inline-block text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border mb-4 ${template.accentBg} ${template.accentBorder} ${template.accentText}`}
          >
            {shot.club}
          </span>
          <p className="text-white text-base font-semibold leading-relaxed mb-2">
            {shot.cue}
          </p>
          <p className="text-xs text-gray-500 mt-4">Did you execute this shot?</p>
        </div>

        {/* Yes / No */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            onClick={() => answerShot(true)}
            className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-golf-green/15 border border-golf-green/30 text-golf-green font-black text-sm uppercase tracking-widest hover:bg-golf-green/25 transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" />
            Yes
          </button>
          <button
            onClick={() => answerShot(false)}
            className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-white/[0.04] border border-white/10 text-gray-400 font-black text-sm uppercase tracking-widest hover:bg-white/[0.08] hover:text-white transition-colors"
          >
            <XCircle className="w-4 h-4" />
            No
          </button>
        </div>

        {/* Recent results */}
        {results.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {results.slice(-8).map((r, i) => (
              <div
                key={i}
                className={`w-6 h-6 rounded-full flex items-center justify-center ${
                  r
                    ? "bg-golf-green/20 text-golf-green"
                    : "bg-white/[0.05] text-gray-600"
                }`}
              >
                {r ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
              </div>
            ))}
            {results.length > 8 && (
              <span className="text-xs text-gray-600">+{results.length - 8} more</span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Complete view ─────────────────────────────────────────────────────────

  if (view === "complete" && template) {
    const shotsExecuted = results.filter(Boolean).length;
    const total = results.length;
    const rate = total > 0 ? shotsExecuted / total : 0;
    const pct = Math.round(rate * 100);
    const perf = performanceLabel(rate);

    return (
      <div className="max-w-sm mx-auto text-center">
        {/* Trophy */}
        <div className="w-16 h-16 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-6">
          <Trophy className="w-8 h-8 text-golf-green" />
        </div>

        <h2 className="text-2xl font-black italic tracking-tighter uppercase text-white mb-1">
          Session Complete
        </h2>
        <p className={`text-sm font-bold mb-8 ${perf.color}`}>{perf.label}</p>

        {/* Big stat */}
        <div className="bg-golf-header border border-white/5 rounded-2xl p-6 mb-5">
          <div className="text-5xl font-black text-white mb-1 tabular-nums">{pct}%</div>
          <p className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-4">
            Execution Rate
          </p>

          {/* Shot breakdown */}
          <div className="flex justify-center gap-6 pt-4 border-t border-white/[0.06]">
            <div>
              <div className="text-lg font-black text-golf-green">{shotsExecuted}</div>
              <div className="text-[10px] text-gray-600 uppercase tracking-widest">Executed</div>
            </div>
            <div className="w-px bg-white/10" />
            <div>
              <div className="text-lg font-black text-gray-400">{total - shotsExecuted}</div>
              <div className="text-[10px] text-gray-600 uppercase tracking-widest">Missed</div>
            </div>
            <div className="w-px bg-white/10" />
            <div>
              <div className="text-lg font-black text-white">{total}</div>
              <div className="text-[10px] text-gray-600 uppercase tracking-widest">Total</div>
            </div>
          </div>
        </div>

        {/* Save status */}
        <div className="flex items-center justify-center gap-2 mb-6 h-5">
          {isPending ? (
            <>
              <Loader2 className="w-3.5 h-3.5 text-gray-500 animate-spin" />
              <span className="text-xs text-gray-500">Saving session…</span>
            </>
          ) : saveError ? (
            <span className="text-xs text-red-400">{saveError}</span>
          ) : (
            <span className="text-xs text-gray-600">Session saved.</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={resetToSelection}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            New Session
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-golf-green hover:bg-golf-green/90 text-sm font-black uppercase tracking-widest text-white transition-colors"
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            Dashboard
          </button>
        </div>
      </div>
    );
  }

  return null;
}
