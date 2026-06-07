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
  Target,
} from "lucide-react";
import { saveRangeSession } from "./actions";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Shot {
  club: string;
  target: string;
  instruction: string;
}

interface Template {
  id: string;
  name: string;
  badge: string;
  tagline: string;
  description: string;
  Icon: React.ElementType;
  accentBg: string;
  accentBorder: string;
  accentText: string;
  shots: Shot[];
}

// ── Session templates (20 shots each) ────────────────────────────────────────

const TEMPLATES: Template[] = [
  {
    id: "technical_block",
    name: "Technical Block",
    badge: "Block Practice",
    tagline: "Groove the pattern through pure repetition.",
    description:
      "Heavy block reps on a single movement pattern. Ideal for ingraining a swing change or eliminating a specific fault.",
    Icon: Repeat,
    accentBg: "bg-indigo-500/10",
    accentBorder: "border-indigo-500/30",
    accentText: "text-indigo-400",
    shots: [
      { club: "7-iron", target: "150yd marker", instruction: "Takeaway drill: keep the clubhead outside your hands to waist height. Slow and wide." },
      { club: "7-iron", target: "150yd marker", instruction: "Maintain the triangle formed by your arms and chest intact to waist height on the backswing." },
      { club: "7-iron", target: "150yd marker", instruction: "Pause at the top for a half beat — feel the weight shift fully to your lead side before swinging down." },
      { club: "7-iron", target: "150yd marker", instruction: "In-to-out path: feel the club approaching from the inside slot. Release freely through the ball." },
      { club: "7-iron", target: "150yd marker", instruction: "Full commitment. Trust the pattern you've been drilling. No steering — let it go." },
      { club: "9-iron", target: "130yd marker", instruction: "Compression drill: ball first, then turf. Listen for the crisp click at impact." },
      { club: "9-iron", target: "130yd marker", instruction: "Hands ahead at impact. Feel the shaft lean forward toward the target — not vertical." },
      { club: "9-iron", target: "130yd marker", instruction: "80% effort. Quiet lower body, let the arms swing freely. Smooth beats hard." },
      { club: "9-iron", target: "130yd marker", instruction: "Check your finish: weight fully on the lead foot, balanced and tall. Hold it for 3 seconds." },
      { club: "9-iron", target: "130yd marker", instruction: "Same pre-shot routine as the first 9-iron. Execute the pattern — no extra thoughts." },
      { club: "PW", target: "100yd marker", instruction: "Stock PW distance. Relaxed grip, smooth tempo, land short and let it release to the flag." },
      { club: "PW", target: "100yd marker", instruction: "Half-shot drill: 9 o'clock backswing only. Feel the contact and observe the trajectory." },
      { club: "PW", target: "100yd marker", instruction: "Three-quarter swing. Control the distance intentionally — don't muscle it." },
      { club: "Driver", target: "Center fairway", instruction: "Wide arc drill: feel maximum width on the backswing. Slow tempo, long and wide." },
      { club: "Driver", target: "Center fairway", instruction: "Hip-fire drill: initiate the downswing by clearing your left hip first. Body leads the club." },
      { club: "Driver", target: "Center fairway", instruction: "Stay behind the ball through impact. Aggressive transition into a smooth, full release." },
      { club: "Driver", target: "Left edge of fairway", instruction: "Work a gentle draw: close your stance one degree, feel the in-to-out path through impact." },
      { club: "Driver", target: "Right edge of fairway", instruction: "Work a gentle fade: open stance slightly, lead with your body, feel the cut-across finish." },
      { club: "7-iron", target: "150yd marker", instruction: "Integration shot: combine everything you drilled today. Full tempo, full trust, full commitment." },
      { club: "Driver", target: "Center fairway", instruction: "Final shot of the block. No thoughts. One target, one swing. Send it." },
    ],
  },
  {
    id: "variable_calibration",
    name: "Variable Calibration",
    badge: "Variable Practice",
    tagline: "Dial in every club from PW to Driver.",
    description:
      "One to two shots per club at varied targets. Trains adaptability and sharpens your internal distance feel across the full bag.",
    Icon: Ruler,
    accentBg: "bg-emerald-500/10",
    accentBorder: "border-emerald-500/30",
    accentText: "text-emerald-400",
    shots: [
      { club: "PW", target: "90yd marker", instruction: "75% swing. Feel the distance — don't force it. Note exactly where it lands." },
      { club: "PW", target: "100yd marker", instruction: "Full PW. How much further does 100% carry versus 75%? Calibrate the gap." },
      { club: "9-iron", target: "115yd marker", instruction: "80% effort. Smooth tempo. Observe ball flight shape and landing zone." },
      { club: "9-iron", target: "125yd marker", instruction: "Full 9-iron. Feel the difference — 80% to 100% swing. Log the distance gap mentally." },
      { club: "8-iron", target: "135yd marker", instruction: "Note your shot shape. Are you drawing or fading your 8-iron naturally? Accept it." },
      { club: "8-iron", target: "145yd marker", instruction: "Max 8-iron. Same smooth swing — trust the extra 10yds comes from the club, not effort." },
      { club: "7-iron", target: "150yd marker", instruction: "Stock 7-iron. Ball first, then turf. This is your baseline distance — know it exactly." },
      { club: "7-iron", target: "160yd marker", instruction: "Push the 7-iron. Same swing feel — let the extra rotation do the work, not a harder strike." },
      { club: "6-iron", target: "170yd marker", instruction: "Smooth 90% effort. Track left-right dispersion — where does your miss pattern go?" },
      { club: "5-iron", target: "180yd marker", instruction: "Low stinger: choke down 1 inch, shorten backswing, abbreviated finish at hip height." },
      { club: "5-iron", target: "185yd marker", instruction: "Full 5-iron. Sweep it — shallower angle of attack than your short irons." },
      { club: "4-hybrid", target: "195yd marker", instruction: "Shallow approach angle. Sweep it off the turf, don't dig. Smooth rotation through." },
      { club: "4-hybrid", target: "205yd marker", instruction: "Draw bias: close stance slightly, feel the in-to-out path. Full rotation to the finish." },
      { club: "3-wood", target: "215yd marker", instruction: "Tight lie off the turf. Sweep it with a shallow attack. Long and smooth, not hard." },
      { club: "3-wood", target: "225yd marker", instruction: "Full 3-wood. Aggressive hip turn, maximum rotation. Hold a balanced finish." },
      { club: "Driver", target: "Fairway center", instruction: "80% driver. Prioritise accuracy — where does the controlled swing land versus the all-out swing?" },
      { club: "Driver", target: "Left-center fairway", instruction: "Work a draw: slightly closed stance, in-to-out swing path. Feel it turn left in the air." },
      { club: "Driver", target: "Right-center fairway", instruction: "Work a fade: open stance slightly, lead with the body. Watch it cut right." },
      { club: "9-iron", target: "120yd marker", instruction: "Return to a comfortable club. Reset your rhythm and re-groove the crisp contact feeling." },
      { club: "7-iron", target: "150yd marker", instruction: "Final calibration shot. Your stock 7-iron. Pure and true — no extra thoughts." },
    ],
  },
  {
    id: "simulated_round",
    name: "Simulated Round",
    badge: "Random Practice",
    tagline: "Play an imaginary round, shot by shot.",
    description:
      "Random practice that mirrors real course pressure. Every shot is a new situation — commit fully, as if it counts.",
    Icon: Shuffle,
    accentBg: "bg-amber-500/10",
    accentBorder: "border-amber-500/30",
    accentText: "text-amber-400",
    shots: [
      { club: "Driver", target: "Right-center fairway", instruction: "Hole 1 (420yd par 4). Opening tee shot: controlled, balanced swing. Set up the hole." },
      { club: "7-iron", target: "155yd flag", instruction: "Hole 1 — approach shot. Middle of the green. Avoid the front bunker. Safe play first." },
      { club: "Driver", target: "Left-center fairway", instruction: "Hole 2 (380yd par 4). Aim at the left tree line, work a gentle fade back to the fairway." },
      { club: "PW", target: "95yd tight front pin", instruction: "Hole 2 — scoring shot. Land it just short of the flag and let it release. Commit to the line." },
      { club: "3-wood", target: "200yd lay-up spot", instruction: "Hole 3 (par 5). Lay-up to 100yd. Smooth 3-wood — set up the perfect approach yardage." },
      { club: "PW", target: "100yd flag", instruction: "Hole 3 — par-5 approach. Attack the flag from 100yd. Full commitment, full swing." },
      { club: "6-iron", target: "185yd par-3 green", instruction: "Hole 4 (185yd par 3). Wind left-to-right: aim one flag left, play the wind. Smooth swing." },
      { club: "Driver", target: "Narrow fairway center", instruction: "Hole 5 (445yd par 4). Tight fairway: choke down 1 inch, prioritise accuracy over distance." },
      { club: "5-iron", target: "190yd uphill green", instruction: "Hole 5 — long approach, uphill. Take 5-iron, swing smooth, aim at the back of the green." },
      { club: "8-iron", target: "145yd par-3 green", instruction: "Hole 6 (145yd par 3). Playing into the breeze — take one extra club, choke down, control it." },
      { club: "Driver", target: "Dogleg corner", instruction: "Hole 7 (405yd dogleg right). Aim at the corner, work a gentle draw to get around the bend." },
      { club: "9-iron", target: "130yd flag", instruction: "Hole 7 — scoring shot. Straight at the pin from 130yd. Execute your stock 9-iron." },
      { club: "3-wood", target: "Short of hazard at 200yd", instruction: "Hole 8 (par 5). Lay-up: stay short of the water hazard. Smart play — don't be greedy." },
      { club: "6-iron", target: "175yd green, left flag", instruction: "Hole 8 — going for it in two. 175yd, left flag. Full commitment, attack." },
      { club: "Driver", target: "Center fairway", instruction: "Hole 9 (390yd par 4). Home hole: commit fully, don't guide it. Trust your swing to finish strong." },
      { club: "8-iron", target: "145yd middle of green", instruction: "Hole 9 — final approach. Middle of the green. Make the percentage play to finish the round." },
      { club: "PW", target: "50yd over bunker", instruction: "Pressure short game: high, soft pitch over the bunker. Abbreviated finish, let the loft do the work." },
      { club: "9-iron", target: "125yd par-3 green", instruction: "Pressure par 3 simulation: picture the shot trajectory clearly in your mind, then step up and execute." },
      { club: "7-iron", target: "155yd tight pin", instruction: "Pressure shot from a tight lie. Stay down through the ball — don't look up until you hear it." },
      { club: "Driver", target: "Center fairway", instruction: "Final shot. This is your moment. Full send — hold the finish and walk off proud." },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function performanceLabel(rate: number): { label: string; color: string } {
  if (rate >= 0.85) return { label: "Elite Session", color: "text-emerald-400" };
  if (rate >= 0.7)  return { label: "Solid Work",    color: "text-golf-green" };
  if (rate >= 0.5)  return { label: "Building",      color: "text-amber-400" };
  return                   { label: "Keep Grinding", color: "text-slate-400" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RangeDashboard() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  type View = "selection" | "session" | "complete";
  const [view, setView]           = useState<View>("selection");
  const [template, setTemplate]   = useState<Template | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [results, setResults]     = useState<boolean[]>([]);
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
            <div className={`w-10 h-10 rounded-xl ${t.accentBg} border ${t.accentBorder} flex items-center justify-center mb-4`}>
              <t.Icon className={`w-5 h-5 ${t.accentText}`} />
            </div>

            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${t.accentBg} ${t.accentBorder} ${t.accentText}`}>
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
    const total = template.shots.length;
    const progressPct = (currentIdx / total) * 100;

    return (
      <div className="max-w-lg mx-auto">
        {/* Session header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-xl ${template.accentBg} border ${template.accentBorder} flex items-center justify-center shrink-0`}>
              <template.Icon className={`w-4 h-4 ${template.accentText}`} />
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-500">{template.badge}</p>
              <p className="text-sm font-bold text-white">{template.name}</p>
            </div>
          </div>
          <button
            onClick={resetToSelection}
            className="text-[10px] font-bold uppercase tracking-widest text-gray-600 hover:text-gray-300 transition-colors"
          >
            Exit
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-white/[0.06] rounded-full mb-1 overflow-hidden">
          <div
            className="h-full bg-golf-green rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex justify-between mb-6">
          <p className="text-[10px] font-bold text-gray-600">Shot {currentIdx + 1} of {total}</p>
          <p className="text-[10px] font-bold text-gray-600">{Math.round(progressPct)}% complete</p>
        </div>

        {/* Shot card */}
        <div className="bg-golf-header border border-white/5 rounded-2xl overflow-hidden mb-4">
          {/* Card header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
            <div className="flex items-center gap-3">
              <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${template.accentBg} ${template.accentBorder} ${template.accentText}`}>
                {shot.club}
              </span>
              <span className="text-[10px] font-black uppercase tracking-widest text-gray-600">
                Shot {currentIdx + 1} of {total}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-500">
              <Target className="w-3.5 h-3.5" />
              <span className="text-[11px] font-semibold">{shot.target}</span>
            </div>
          </div>

          {/* Card body */}
          <div className="px-6 py-5">
            <p className="text-white text-[15px] font-semibold leading-relaxed mb-5">
              {shot.instruction}
            </p>
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-600">
              Did you execute this shot?
            </p>
          </div>
        </div>

        {/* Success / Miss buttons */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            onClick={() => answerShot(true)}
            className="flex items-center justify-center gap-2 py-4 rounded-xl bg-golf-green/15 border border-golf-green/30 text-golf-green font-black text-sm uppercase tracking-widest hover:bg-golf-green/25 active:scale-[0.98] transition-all"
          >
            <CheckCircle2 className="w-4 h-4" />
            Success
          </button>
          <button
            onClick={() => answerShot(false)}
            className="flex items-center justify-center gap-2 py-4 rounded-xl bg-white/[0.04] border border-white/10 text-gray-400 font-black text-sm uppercase tracking-widest hover:bg-white/[0.08] hover:text-white active:scale-[0.98] transition-all"
          >
            <XCircle className="w-4 h-4" />
            Miss
          </button>
        </div>

        {/* Rolling result dots */}
        {results.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {results.slice(-10).map((r, i) => (
              <div
                key={i}
                className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  r ? "bg-golf-green/20 text-golf-green" : "bg-white/[0.05] text-gray-600"
                }`}
              >
                {r ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              </div>
            ))}
            {results.length > 10 && (
              <span className="text-[10px] text-gray-600">+{results.length - 10} earlier</span>
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
        {/* Trophy icon */}
        <div className="w-16 h-16 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-5">
          <Trophy className="w-8 h-8 text-golf-green" />
        </div>

        <p className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1">
          {template.name} · {template.badge}
        </p>
        <h2 className="text-2xl font-black italic tracking-tighter uppercase text-white mb-1">
          Session Complete
        </h2>
        <p className={`text-sm font-bold mb-7 ${perf.color}`}>{perf.label}</p>

        {/* Stats card */}
        <div className="bg-golf-header border border-white/5 rounded-2xl p-6 mb-5 text-left">
          {/* Execution rate — big */}
          <div className="text-center mb-5">
            <div className="text-5xl font-black text-white tabular-nums">{pct}%</div>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-500 mt-1">
              Execution Rate
            </p>
          </div>

          {/* Breakdown */}
          <div className="flex justify-center gap-6 pt-4 border-t border-white/[0.06]">
            <div className="text-center">
              <div className="text-xl font-black text-golf-green">{shotsExecuted}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-gray-600 mt-0.5">Executed</div>
            </div>
            <div className="w-px bg-white/10" />
            <div className="text-center">
              <div className="text-xl font-black text-gray-400">{total - shotsExecuted}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-gray-600 mt-0.5">Missed</div>
            </div>
            <div className="w-px bg-white/10" />
            <div className="text-center">
              <div className="text-xl font-black text-white">{total}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-gray-600 mt-0.5">Total</div>
            </div>
          </div>

          {/* Shot-by-shot strip */}
          <div className="mt-5 pt-4 border-t border-white/[0.06]">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">Shot log</p>
            <div className="flex flex-wrap gap-1">
              {results.map((r, i) => (
                <div
                  key={i}
                  title={`Shot ${i + 1}: ${r ? "Success" : "Miss"}`}
                  className={`w-5 h-5 rounded-full flex items-center justify-center ${
                    r ? "bg-golf-green/25 text-golf-green" : "bg-white/[0.06] text-gray-600"
                  }`}
                >
                  {r ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Save status */}
        <div className="flex items-center justify-center gap-2 mb-5 h-5">
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
