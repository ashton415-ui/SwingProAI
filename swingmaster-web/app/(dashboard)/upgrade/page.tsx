import Link from 'next/link';
import { Zap, CheckCircle2, BookOpen, Bot, Video, Activity, Crown } from 'lucide-react';

export const metadata = { title: 'Upgrade to Pro — SwingMaster' };

const FREE_FEATURES = [
  '3 AI swing analyses / month',
  '2 free lessons',
  'Basic swing history',
  'Equipment bag tracking',
];

const PRO_FEATURES = [
  'Unlimited AI swing analyses',
  'Full lesson library (7+ programs)',
  'AI Coach chat — unlimited messages',
  'Advanced biomechanical breakdown',
  'Drill prescriptions per fault',
  'MediaPipe real-time body tracking',
  'Progress tracking over time',
  'Priority analysis queue',
];

export default function UpgradePage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sm:px-6 space-y-8">
      {/* Hero */}
      <div className="text-center space-y-3 pt-4">
        <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-[10px] font-black uppercase tracking-widest text-amber-400">
          <Crown className="w-3 h-3" /> SwingMaster Pro
        </div>
        <h1 className="text-3xl font-black text-white tracking-tight">Unlock Your Full Potential</h1>
        <p className="text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
          Stop guessing what's wrong with your swing. Get unlimited AI analysis, expert lessons, and a personal coach in your pocket.
        </p>
      </div>

      {/* Pricing card */}
      <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600/20 to-indigo-500/5 border-b border-white/[0.06] px-6 py-5 flex items-end justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-1">Pro Plan</p>
            <div className="flex items-baseline gap-1">
              <span className="text-4xl font-black text-white">$12</span>
              <span className="text-sm text-slate-500">/ month</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">or $99/year — save 31%</p>
          </div>
          <Zap className="w-8 h-8 text-indigo-400/50" />
        </div>
        <div className="px-6 py-5 space-y-3">
          {PRO_FEATURES.map((f) => (
            <div key={f} className="flex items-center gap-3">
              <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <p className="text-sm text-slate-300">{f}</p>
            </div>
          ))}
        </div>
        <div className="px-6 pb-6">
          <button className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors">
            Start 7-Day Free Trial
          </button>
          <p className="text-[10px] text-slate-600 text-center mt-2">No credit card required during trial · Cancel anytime</p>
        </div>
      </div>

      {/* Free vs Pro comparison */}
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-600 mb-4">Free vs. Pro</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-900 border border-white/[0.07] rounded-2xl px-4 py-5">
            <p className="text-xs font-bold text-slate-500 mb-4 uppercase tracking-widest">Free</p>
            <div className="space-y-2.5">
              {FREE_FEATURES.map((f) => (
                <div key={f} className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full border border-slate-700 shrink-0" />
                  <p className="text-xs text-slate-500">{f}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-indigo-600/10 border border-indigo-500/25 rounded-2xl px-4 py-5">
            <p className="text-xs font-bold text-indigo-400 mb-4 uppercase tracking-widest">Pro</p>
            <div className="space-y-2.5">
              {['Everything in Free', 'Unlimited analyses', 'Full lesson library', 'AI Coach chat', '+ more'].map((f) => (
                <div key={f} className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <p className="text-xs text-indigo-200">{f}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Social proof */}
      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          { value: '2,400+', label: 'Golfers coached' },
          { value: '18,000+', label: 'Swings analysed' },
          { value: '4.9★', label: 'Average rating' },
        ].map(({ value, label }) => (
          <div key={label} className="bg-slate-900 border border-white/[0.06] rounded-2xl px-3 py-4">
            <div className="text-xl font-black text-white">{value}</div>
            <div className="text-[10px] text-slate-600 mt-0.5">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
