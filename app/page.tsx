import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Briefcase, ClipboardCheck, Flag, LayoutDashboard, Target, Zap } from "lucide-react";
import SplashScreen from "@/components/SplashScreen";

export const metadata: Metadata = {
  description:
    "Upload a swing video for an AI review with practice suggestions, then set goals, work through drills, save the clubs in your bag and look back over your past reviews.",
};

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

// What each part of the product does today, in plain words. AI output is described as observations and suggestions,
// never as measurement or coaching; putting is limited to the plans that include it.
const FEATURES = [
  {
    icon: Target,
    tint: "text-golf-green",
    bg: "bg-golf-green/10",
    title: "AI Swing Review",
    desc: "Upload a swing video and get AI observations about your setup and motion, with suggestions for what to practice next.",
  },
  {
    icon: Zap,
    tint: "text-amber-400",
    bg: "bg-amber-400/10",
    title: "Putting Feedback",
    desc: "Upload one putting stroke for AI feedback on your setup and stroke. Available on eligible plans only.",
  },
  {
    icon: Flag,
    tint: "text-golf-green",
    bg: "bg-golf-green/10",
    title: "Goals and Practice Plan",
    desc: "Answer three quick questions about your game and get an AI-generated practice plan to work through.",
  },
  {
    icon: ClipboardCheck,
    tint: "text-golf-green",
    bg: "bg-golf-green/10",
    title: "Drill Hub",
    desc: "Work through swing drills and upload drill footage for an AI check of the movement.",
  },
  {
    icon: Briefcase,
    tint: "text-golf-green",
    bg: "bg-golf-green/10",
    title: "My Bag and Past Reviews",
    desc: "Save the clubs in your bag, choose the one you used when you upload a swing, and look back over your past swing reviews.",
  },
  {
    icon: LayoutDashboard,
    tint: "text-golf-green",
    bg: "bg-golf-green/10",
    title: "Progress Hub",
    desc: "See a summary of your recent swing reviews and look back over them.",
  },
];

export default function HomePage() {
  return (
    <div className="relative bg-golf-dark text-white min-h-screen">
      <SplashScreen />
      {/* Grid background */}
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_right,#80808010_1px,transparent_1px),linear-gradient(to_bottom,#80808010_1px,transparent_1px)] bg-[size:40px_40px]" />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-golf-dark" />

      {/* Nav */}
      <header className="relative z-10 border-b border-white/5 bg-golf-header/80 backdrop-blur-sm">
        <nav aria-label="Account" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-8 py-4 sm:py-6">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl overflow-hidden border border-golf-green/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain" />
            </div>
            <span aria-hidden="true" className="text-white font-black italic tracking-tighter uppercase text-lg">
              Swing<span className="text-golf-green">Pro</span>AI
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <Link
              href="/login"
              className={`inline-flex items-center justify-center min-h-11 min-w-11 px-3 rounded-xl text-xs font-black uppercase tracking-widest text-gray-300 hover:text-white transition-colors ${FOCUS_RING} focus-visible:outline-golf-green`}
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className={`inline-flex items-center justify-center min-h-11 px-4 sm:px-5 bg-golf-green text-golf-dark rounded-xl font-black text-xs uppercase tracking-widest hover:bg-[#22C55E] transition-all shadow-[0_0_15px_rgba(74,222,128,0.2)] ${FOCUS_RING} focus-visible:outline-white`}
            >
              Get Started
            </Link>
          </div>
        </nav>
      </header>

      <main className="relative z-10">
        {/* Hero */}
        <section aria-labelledby="landing-heading" className="min-h-[85vh] flex items-center justify-center py-16 sm:py-20 px-4 sm:px-6 text-center">
          <div className="max-w-4xl mx-auto min-w-0">
            {/* Logo mark */}
            <div className="flex justify-center mb-10">
              <div className="w-40 h-40 sm:w-52 sm:h-52 bg-golf-green/5 rounded-6xl border border-golf-green/20 flex items-center justify-center relative group overflow-hidden shadow-[0_0_60px_rgba(74,222,128,0.1)]">
                <div className="absolute inset-0 bg-golf-green/10 blur-3xl rounded-full opacity-0 group-hover:opacity-40 transition-opacity" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/swingproai_logo.png"
                  alt=""
                  className="w-full h-full object-contain relative z-10 p-3"
                />
              </div>
            </div>

            <p className="inline-flex items-center gap-2 px-4 py-2 bg-golf-green/10 border border-golf-green/20 rounded-full text-golf-green text-xs font-bold tracking-[0.2em] uppercase mb-8">
              <Zap aria-hidden="true" size={12} fill="currentColor" />
              AI-Integrated Swing Analysis
            </p>

            <h1 id="landing-heading" className="text-4xl sm:text-5xl md:text-8xl font-black italic tracking-tighter mb-6 leading-[0.95] uppercase break-words">
              Review Your Swing.{" "}
              <br />
              <span className="text-white/60">Practice With a Plan.</span>
            </h1>

            <p className="text-base md:text-lg text-gray-300 mb-4 max-w-2xl mx-auto leading-relaxed font-medium">
              Upload a swing video for an AI review: observations about your swing and suggestions for what to practice next. Then set goals, work through drills, save the clubs in your bag, and look back over your past reviews.
            </p>
            <p className="text-sm text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
              AI feedback is our AI&apos;s reading of your video, with practice suggestions. It isn&apos;t a measurement or a coach&apos;s review.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="/signup"
                className={`w-full sm:w-auto min-h-11 px-10 py-5 bg-golf-green text-golf-dark rounded-2xl font-black flex items-center justify-center gap-2 hover:bg-[#22C55E] transition-all shadow-[0_0_30px_rgba(74,222,128,0.2)] uppercase tracking-widest text-sm ${FOCUS_RING} focus-visible:outline-white`}
              >
                Get Started
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
              <Link
                href="/upgrade"
                className={`w-full sm:w-auto min-h-11 px-10 py-5 bg-white/5 backdrop-blur-sm border border-white/20 rounded-2xl font-black flex items-center justify-center gap-2 hover:bg-white/10 transition-all text-white uppercase tracking-widest text-sm ${FOCUS_RING} focus-visible:outline-golf-green`}
              >
                View Plans
                <Zap aria-hidden="true" size={16} className="text-golf-green" />
              </Link>
            </div>
          </div>
        </section>

        {/* Features */}
        <section aria-labelledby="features-heading" className="py-16 sm:py-24 px-4 sm:px-6 border-t border-white/5 bg-[#050705]">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-14">
              <p className="text-xs font-black uppercase tracking-[0.3em] text-golf-green mb-3">What You Can Do</p>
              <h2 id="features-heading" className="text-3xl md:text-5xl font-black italic tracking-tighter uppercase break-words">From Swing to Practice</h2>
            </div>

            {/* role="list": Safari drops list semantics when list styling is removed */}
            <ul role="list" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {FEATURES.map((f) => (
                <li
                  key={f.title}
                  className="p-6 sm:p-8 bg-golf-surface rounded-4xl border border-white/5 min-w-0"
                >
                  <div className={`w-12 h-12 ${f.bg} rounded-2xl flex items-center justify-center mb-6`}>
                    <f.icon aria-hidden="true" className={`w-6 h-6 ${f.tint}`} />
                  </div>
                  <h3 className="text-lg font-black italic mb-3 tracking-tight uppercase break-words">{f.title}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
