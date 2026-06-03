import Link from "next/link";
import { ArrowRight, Target, Trophy, Zap, Play } from "lucide-react";

export default function HomePage() {
  return (
    <div className="relative bg-golf-dark text-white min-h-screen">
      {/* Grid background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808010_1px,transparent_1px),linear-gradient(to_bottom,#80808010_1px,transparent_1px)] bg-[size:40px_40px]" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-golf-dark" />

      {/* Nav */}
      <nav className="relative z-10 flex items-center justify-between px-8 py-6 border-b border-white/5 bg-golf-header/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl overflow-hidden border border-golf-green/20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain" />
          </div>
          <span className="text-white font-black italic tracking-tighter uppercase text-lg">
            Swing<span className="text-golf-green">Pro</span>AI
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-white transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/signup"
            className="px-5 py-2.5 bg-golf-green text-golf-dark rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-[#22C55E] transition-all shadow-[0_0_15px_rgba(74,222,128,0.2)]"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 min-h-[85vh] flex items-center justify-center py-20 px-6 text-center">
        <div className="max-w-4xl mx-auto">
          {/* Logo mark */}
          <div className="flex justify-center mb-10">
            <div className="w-52 h-52 bg-golf-green/5 rounded-6xl border border-golf-green/20 flex items-center justify-center relative group overflow-hidden shadow-[0_0_60px_rgba(74,222,128,0.1)]">
              <div className="absolute inset-0 bg-golf-green/10 blur-3xl rounded-full opacity-0 group-hover:opacity-40 transition-opacity" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/swingproai_logo.png"
                alt="SwingProAI"
                className="w-full h-full object-contain relative z-10 p-3"
              />
            </div>
          </div>

          <div className="inline-flex items-center gap-2 px-4 py-2 bg-golf-green/10 border border-golf-green/20 rounded-full text-golf-green text-[10px] font-bold tracking-[0.2em] uppercase mb-8">
            <Zap size={10} fill="currentColor" />
            AI-Integrated Swing Analysis
          </div>

          <h1 className="text-5xl md:text-8xl font-black italic tracking-tighter mb-6 leading-[0.9] uppercase">
            Fix Your Swing
            <br />
            <span className="text-white/30">In Real-Time.</span>
          </h1>

          <p className="text-base md:text-lg text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed font-medium">
            Professional-grade golf analytics powered by AI. Upload, analyze, and master your mechanics — from tempo and spine angle to 3D putting and AR smart glasses.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="w-full sm:w-auto px-10 py-5 bg-golf-green text-golf-dark rounded-2xl font-black flex items-center justify-center gap-2 hover:bg-[#22C55E] transition-all shadow-[0_0_30px_rgba(74,222,128,0.2)] uppercase tracking-widest text-sm"
            >
              Start Free Trial
              <ArrowRight size={16} />
            </Link>
            <Link
              href="/upgrade"
              className="w-full sm:w-auto px-10 py-5 bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl font-black flex items-center justify-center gap-2 hover:bg-white/10 transition-all text-white uppercase tracking-widest text-sm"
            >
              View Plans
              <Zap size={16} className="text-golf-green" />
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5 bg-[#050705]">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-golf-green mb-3">Platform Capabilities</p>
            <h2 className="text-3xl md:text-5xl font-black italic tracking-tighter uppercase">Tour-Level Intelligence</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: <Target className="w-6 h-6 text-golf-green" />,
                bg: "bg-golf-green/10",
                title: "Swing Telemetry",
                desc: "Real-time analysis of swing plane, impact alignment, and posture using AI vision.",
              },
              {
                icon: <Trophy className="w-6 h-6 text-amber-400" />,
                bg: "bg-amber-400/10",
                title: "Pro Analytics",
                desc: "Deep biomechanical data — hip sway, head drop, rotational velocity, and X-Factor separation.",
              },
              {
                icon: <Play className="w-6 h-6 text-golf-green" />,
                bg: "bg-golf-green/10",
                title: "AI Drill Verifier",
                desc: "Upload drill footage and have AI verify if you're executing the movement correctly.",
              },
              {
                icon: <Zap className="w-6 h-6 text-golf-green" />,
                bg: "bg-golf-green/10",
                title: "3D Putting Engine",
                desc: "LiDAR / ARCore green reading with aim-line trajectory and real-time caddy suggestions.",
              },
            ].map((f) => (
              <div
                key={f.title}
                className="p-8 bg-golf-surface rounded-4xl border border-white/5 hover:border-golf-green/30 transition-colors"
              >
                <div className={`w-12 h-12 ${f.bg} rounded-2xl flex items-center justify-center mb-6`}>
                  {f.icon}
                </div>
                <h3 className="text-lg font-black italic mb-3 tracking-tight uppercase">{f.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
