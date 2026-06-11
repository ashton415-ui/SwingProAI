import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/server';
import { Video, Activity, Briefcase, TrendingUp, ChevronRight, Zap, CheckCircle2 } from 'lucide-react';
import ConnectToCoachForm from '@/components/dashboard/ConnectToCoachForm';

export const metadata = { title: 'Dashboard — SwingMaster' };

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

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: swings }, { data: equipment }, { data: profile }, { data: coachLink }] = await Promise.all([
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
      .select('role, full_name')
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

  const isCoach  = profile?.role === 'coach';
  const hasCoach = !!coachLink;

  const recentSwings = swings ?? [];
  const completedCount = recentSwings.length;
  const avgScore = completedCount > 0
    ? Math.round(recentSwings.reduce((s, r) => s + (r.score ?? 0), 0) / completedCount)
    : null;
  const bagCount = (equipment as unknown as { count: number } | null)?.count ?? 0;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">Your swing performance at a glance.</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'Analyses', value: completedCount, icon: Activity, color: 'text-indigo-400' },
          { label: 'Avg Score', value: avgScore ?? '—', icon: TrendingUp, color: avgScore ? scoreColor(avgScore) : 'text-slate-500' },
          { label: 'Clubs in Bag', value: bagCount, icon: Briefcase, color: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-slate-900 border border-white/10 rounded-2xl px-4 py-5">
            <Icon className={`w-4 h-4 ${color} mb-3`} />
            <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
            <div className="text-xs text-slate-500 mt-0.5 uppercase tracking-wider">{label}</div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link
          href="/analyze"
          className="flex items-center gap-4 bg-indigo-600 hover:bg-indigo-500 transition-colors rounded-2xl px-5 py-4"
        >
          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
            <Video className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Analyze a Swing</p>
            <p className="text-xs text-indigo-200 mt-0.5">Upload video for AI coaching</p>
          </div>
          <ChevronRight className="w-4 h-4 text-indigo-300 ml-auto shrink-0" />
        </Link>

        <Link
          href="/bag"
          className="flex items-center gap-4 bg-slate-900 hover:bg-slate-800 border border-white/10 transition-colors rounded-2xl px-5 py-4"
        >
          <div className="w-10 h-10 rounded-xl bg-white/[0.06] flex items-center justify-center shrink-0">
            <Briefcase className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">My Bag</p>
            <p className="text-xs text-slate-500 mt-0.5">Track per-club telemetry</p>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-600 ml-auto shrink-0" />
        </Link>
      </div>

      {/* Coach Connection — golfers only */}
      {!isCoach && (
        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-3">Coach Connection</h2>
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

      {/* Recent swings */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-300">Recent Analyses</h2>
          <Link href="/swings" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            View all
          </Link>
        </div>

        {recentSwings.length === 0 ? (
          <div className="bg-slate-900 border border-white/10 rounded-2xl px-5 py-10 text-center">
            <Zap className="w-8 h-8 text-slate-700 mx-auto mb-3" />
            <p className="text-sm text-slate-400 font-medium">No analyses yet</p>
            <p className="text-xs text-slate-600 mt-1">Upload your first swing to get started.</p>
            <Link
              href="/analyze"
              className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition-colors"
            >
              <Video className="w-3.5 h-3.5" /> Upload now
            </Link>
          </div>
        ) : (
          <div className="bg-slate-900 border border-white/10 rounded-2xl overflow-hidden divide-y divide-white/[0.06]">
            {recentSwings.map((swing) => {
              const video = Array.isArray(swing.swing_video) ? swing.swing_video[0] : swing.swing_video;
              const label = video?.club ?? video?.original_filename ?? 'Swing';
              const date = new Date(swing.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric',
              });
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
  );
}
