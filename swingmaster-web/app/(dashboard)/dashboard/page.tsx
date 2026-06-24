import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/server';
import { signOut } from '@/app/actions/auth';
import {
  Video, Activity, Briefcase, TrendingUp, ChevronRight, Zap,
  CheckCircle2, Upload, Dumbbell, Crown, LogOut, Target,
  RotateCw, Timer, Footprints, Crosshair, Layers,
} from 'lucide-react';
import ConnectToCoachForm from '@/components/dashboard/ConnectToCoachForm';

export const metadata = { title: 'Dashboard — SwingMaster' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(s: number) {
  if (s >= 85) return 'text-emerald-400';
  if (s >= 70) return 'text-indigo-400';
  if (s >= 55) return 'text-amber-400';
  return 'text-red-400';
}

function scoreLabel(s: number) {
  if (s >= 85) return 'Elite';
  if (s >= 70) return 'Solid';
  if (s >= 55) return 'Building';
  return 'Needs Work';
}

// ── Static drill data ─────────────────────────────────────────────────────────

const DRILLS = [
  { title: 'Wall Hip Turn', category: 'Rotation',       icon: RotateCw,  href: '/drills' },
  { title: 'Pause at the Top',  category: 'Tempo',      icon: Timer,     href: '/drills' },
  { title: 'Step Drill',        category: 'Weight Transfer', icon: Footprints, href: '/drills' },
  { title: 'Impact Bag',        category: 'Impact',     icon: Target,    href: '/drills' },
  { title: 'Gate Drill',        category: 'Ball Striking', icon: Crosshair, href: '/drills' },
  { title: 'Slow-Mo Swing',     category: 'Mechanics',  icon: Layers,    href: '/drills' },
] as const;

// ── Subscription card data (hardcoded — swap with DB later) ──────────────────

const BIRDIE_FEATURES = [
  'Up to 20 AI swing analyses / month',
  'Full lesson library access',
  'Advanced biomechanical breakdown',
  'Drill prescriptions per fault',
  'AI Coach — 50 messages / month',
  'Priority analysis queue',
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [
    { data: swings },
    { data: equipment },
    { data: profile },
    { data: coachLink },
  ] = await Promise.all([
    supabase
      .from('swing_analysis')
      .select('id, score, status, created_at, swing_video:swing_videos(club, original_filename)')
      .eq('user_id', user.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('user_equipment')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('users')
      .select('role, full_name, display_name')
      .eq('id', user.id)
      .single(),
    supabase
      .from('coach_student_relationships')
      .select('id')
      .eq('student_id', user.id)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle(),
  ]);

  const isCoach      = profile?.role === 'coach';
  const hasCoach     = !!coachLink;
  const recentSwings = swings ?? [];
  const completedCount = recentSwings.length;
  const avgScore = completedCount > 0
    ? Math.round(recentSwings.reduce((s, r) => s + (r.score ?? 0), 0) / completedCount)
    : null;
  const bagCount = (equipment as unknown as { count: number } | null)?.count ?? 0;
  const displayName = profile?.display_name ?? profile?.full_name ?? user.email ?? 'Golfer';

  return (
    <div className="min-h-full bg-slate-950">

      {/* ── Command Bar (visible on mobile — desktop sidebar handles this) ── */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-slate-950/80 backdrop-blur-sm sticky top-0 z-30">
        <span className="text-base font-black italic tracking-tighter text-white uppercase">
          Swing<span className="text-indigo-400">Master</span>
        </span>

        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500 font-medium truncate max-w-[120px]">
            {user.email}
          </span>
          <form action={signOut}>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/[0.06] hover:bg-white/10 border border-white/10 rounded-lg text-[10px] font-semibold text-slate-400 hover:text-white transition-colors"
            >
              <LogOut className="w-3 h-3" />
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* ── Main layout grid ── */}
      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ═══════════════════════════════════════════════════════════════
              LEFT / MAIN — Analytics & Drills Zone (spans 2 of 3 columns)
          ═══════════════════════════════════════════════════════════════ */}
          <div className="lg:col-span-2 space-y-6">

            {/* Greeting */}
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">
                Welcome back, {displayName.split(' ')[0]}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">Your swing performance at a glance.</p>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Analyses',    value: completedCount,       icon: Activity,  color: 'text-indigo-400',  bg: 'bg-indigo-500/10' },
                { label: 'Avg Score',   value: avgScore ?? '—',      icon: TrendingUp, color: avgScore ? scoreColor(avgScore) : 'text-slate-500', bg: 'bg-white/[0.04]' },
                { label: 'Clubs in Bag', value: bagCount,            icon: Briefcase, color: 'text-amber-400',  bg: 'bg-amber-500/10' },
              ].map(({ label, value, icon: Icon, color, bg }) => (
                <div key={label} className="bg-slate-900 border border-white/[0.08] rounded-2xl px-4 py-4">
                  <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center mb-3`}>
                    <Icon className={`w-3.5 h-3.5 ${color}`} />
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
                  <div className="text-[10px] text-slate-600 mt-0.5 uppercase tracking-wider">{label}</div>
                </div>
              ))}
            </div>

            {/* ── Swing Analysis Drop Zone ── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Swing Analysis</h2>
                <Link href="/analyze" className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors uppercase tracking-wider">
                  Open analyzer →
                </Link>
              </div>

              <Link href="/analyze" className="group block">
                <div className="relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-white/10 bg-slate-900 hover:border-indigo-500/40 hover:bg-slate-900/80 transition-all duration-200 px-6 py-12 text-center cursor-pointer">
                  {/* Subtle gradient glow */}
                  <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-indigo-500/[0.03] to-transparent pointer-events-none" />

                  <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/20 transition-colors">
                    <Upload className="w-6 h-6 text-indigo-400" />
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-white group-hover:text-indigo-300 transition-colors">
                      Drop your swing video here
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      MP4, MOV or WEBM · up to 200 MB · AI biomechanical analysis
                    </p>
                  </div>

                  <div className="flex items-center gap-2 px-4 py-2 bg-indigo-600 group-hover:bg-indigo-500 rounded-xl transition-colors">
                    <Video className="w-3.5 h-3.5 text-white" />
                    <span className="text-xs font-semibold text-white">Choose File</span>
                  </div>

                  <div className="flex items-center gap-4 mt-1">
                    {['AI Pose Estimation', 'Biomechanical Scoring', 'Drill Prescription'].map((tag) => (
                      <span key={tag} className="text-[10px] text-slate-600 flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-indigo-500/50 inline-block" />
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            </div>

            {/* ── Focus Drills ── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Focus Drills</h2>
                <Link href="/drills" className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors uppercase tracking-wider">
                  All drills →
                </Link>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {DRILLS.map(({ title, category, icon: Icon, href }) => (
                  <Link
                    key={title}
                    href={href}
                    className="group flex flex-col gap-3 bg-slate-900 hover:bg-slate-800 border border-white/[0.08] hover:border-indigo-500/25 rounded-2xl px-4 py-4 transition-all duration-150"
                  >
                    <div className="w-8 h-8 rounded-xl bg-white/[0.05] group-hover:bg-indigo-500/15 border border-white/[0.06] flex items-center justify-center transition-colors">
                      <Icon className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 transition-colors" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-white leading-snug">{title}</p>
                      <p className="text-[10px] text-slate-600 mt-0.5 uppercase tracking-wider">{category}</p>
                    </div>
                    <div className="flex items-center gap-1 mt-auto">
                      <Dumbbell className="w-2.5 h-2.5 text-slate-700" />
                      <span className="text-[9px] text-slate-700 font-medium">Start drill</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>

            {/* ── Coach Connection (golfers only) ── */}
            {!isCoach && (
              <div>
                <h2 className="text-sm font-semibold text-white mb-3">Coach Connection</h2>
                {hasCoach ? (
                  <div className="flex items-center gap-3 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-2xl px-5 py-4">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-white">Coach Connected</p>
                      <p className="text-xs text-slate-400 mt-0.5">Your coach has access to your training data.</p>
                    </div>
                  </div>
                ) : (
                  <ConnectToCoachForm />
                )}
              </div>
            )}

            {/* ── Recent Analyses ── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-white">Recent Analyses</h2>
                <Link href="/swings" className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors uppercase tracking-wider">
                  View all →
                </Link>
              </div>

              {recentSwings.length === 0 ? (
                <div className="bg-slate-900 border border-white/[0.08] rounded-2xl px-5 py-10 text-center">
                  <Zap className="w-8 h-8 text-slate-700 mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-400">No analyses yet</p>
                  <p className="text-xs text-slate-600 mt-1">Upload your first swing to get started.</p>
                  <Link
                    href="/analyze"
                    className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition-colors"
                  >
                    <Video className="w-3.5 h-3.5" /> Upload now
                  </Link>
                </div>
              ) : (
                <div className="bg-slate-900 border border-white/[0.08] rounded-2xl overflow-hidden divide-y divide-white/[0.05]">
                  {recentSwings.map((swing) => {
                    const video = Array.isArray(swing.swing_video) ? swing.swing_video[0] : swing.swing_video;
                    const label = video?.club ?? video?.original_filename ?? 'Swing';
                    const date  = new Date(swing.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return (
                      <Link
                        key={swing.id}
                        href={`/swings/${swing.id}`}
                        className="flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.03] transition-colors"
                      >
                        <div>
                          <p className="text-sm font-medium text-white capitalize">{label}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{date}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {swing.score != null && (
                            <div className="text-right">
                              <span className={`text-lg font-bold tabular-nums ${scoreColor(swing.score)}`}>
                                {swing.score}
                              </span>
                              <p className={`text-[10px] font-semibold uppercase tracking-widest ${scoreColor(swing.score)}`}>
                                {scoreLabel(swing.score)}
                              </p>
                            </div>
                          )}
                          <ChevronRight className="w-4 h-4 text-slate-700" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════════
              RIGHT — Package Hub Sidebar
          ═══════════════════════════════════════════════════════════════ */}
          <div className="space-y-4">

            {/* Subscription card */}
            <div className="bg-slate-900 border border-indigo-500/25 rounded-2xl overflow-hidden">
              {/* Card header */}
              <div className="relative px-5 pt-5 pb-4 bg-gradient-to-br from-indigo-600/20 via-indigo-500/10 to-transparent border-b border-white/[0.06]">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Crown className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-[9px] font-black uppercase tracking-widest text-amber-400">Active Plan</span>
                    </div>
                    <p className="text-xl font-black text-white tracking-tight">Birdie Package</p>
                    <p className="text-xs text-indigo-300/70 mt-0.5">$7 / month</p>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4 text-indigo-400" fill="currentColor" />
                  </div>
                </div>

                {/* Usage bar */}
                <div className="mt-4">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-[10px] text-slate-500">Analyses used this month</span>
                    <span className="text-[10px] font-bold text-white tabular-nums">
                      {completedCount} <span className="text-slate-600">/ 20</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (completedCount / 20) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Feature list */}
              <div className="px-5 py-4 space-y-2.5">
                {BIRDIE_FEATURES.map((f) => (
                  <div key={f} className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-slate-400 leading-snug">{f}</p>
                  </div>
                ))}
              </div>

              {/* Upgrade CTA */}
              <div className="px-5 pb-5">
                <div className="h-px bg-white/[0.06] mb-4" />
                <p className="text-[10px] text-slate-600 mb-3 text-center uppercase tracking-widest">
                  Want unlimited analyses?
                </p>
                <Link
                  href="/upgrade"
                  className="flex items-center justify-center gap-2 w-full py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-indigo-500/20"
                >
                  <Crown className="w-3.5 h-3.5 text-amber-300" />
                  Upgrade to Eagle
                </Link>
                <p className="text-[9px] text-slate-700 text-center mt-2">
                  Cancel anytime · No commitment
                </p>
              </div>
            </div>

            {/* Quick links */}
            <div className="bg-slate-900 border border-white/[0.08] rounded-2xl px-4 py-4 space-y-1">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 px-2 pb-1">Quick Access</p>
              {[
                { label: 'My Bag',      href: '/bag',      icon: Briefcase  },
                { label: 'Lessons',     href: '/lessons',  icon: Activity   },
                { label: 'Drills Hub',  href: '/drills',   icon: Dumbbell   },
                { label: 'View Plans',  href: '/upgrade',  icon: Crown      },
              ].map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-3 px-2 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.05] transition-colors text-xs font-medium"
                >
                  <Icon className="w-3.5 h-3.5 text-slate-600" />
                  {label}
                  <ChevronRight className="w-3 h-3 text-slate-700 ml-auto" />
                </Link>
              ))}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
