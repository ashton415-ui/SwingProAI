import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/server';
import { ChevronRight, Activity } from 'lucide-react';

export const metadata = { title: 'Swing History — SwingMaster' };

function scoreColor(s: number) {
  if (s >= 85) return 'text-emerald-400';
  if (s >= 70) return 'text-indigo-400';
  if (s >= 55) return 'text-amber-400';
  return 'text-red-400';
}

export default async function SwingsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rows } = await supabase
    .from('swing_analysis')
    .select('id, score, status, created_at, swing_video:swing_videos(club, original_filename)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const swings = rows ?? [];

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Swing History</h1>
        <p className="text-sm text-slate-400 mt-1">{swings.length} total analysis{swings.length !== 1 ? 'es' : ''}</p>
      </div>

      {swings.length === 0 ? (
        <div className="bg-slate-900 border border-white/10 rounded-2xl px-5 py-16 text-center">
          <Activity className="w-8 h-8 text-slate-700 mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-400">No swings yet</p>
          <p className="text-xs text-slate-600 mt-1">Upload a video from the Analyze tab.</p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-white/10 rounded-2xl overflow-hidden divide-y divide-white/[0.06]">
          {swings.map((swing) => {
            const video = Array.isArray(swing.swing_video) ? swing.swing_video[0] : swing.swing_video;
            const label = video?.club ?? video?.original_filename ?? 'Swing';
            const date = new Date(swing.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            });
            const isPending = swing.status === 'pending' || swing.status === 'processing';
            const isFailed = swing.status === 'failed';

            return (
              <Link
                key={swing.id}
                href={`/swings/${swing.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-white/[0.03] transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-white capitalize">{label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{date}</p>
                </div>
                <div className="flex items-center gap-3">
                  {isPending && (
                    <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full">
                      Processing
                    </span>
                  )}
                  {isFailed && (
                    <span className="text-[10px] font-bold uppercase tracking-widest text-red-400 bg-red-400/10 border border-red-400/20 px-2 py-0.5 rounded-full">
                      Failed
                    </span>
                  )}
                  {swing.score != null && !isPending && (
                    <span className={`text-xl font-bold tabular-nums ${scoreColor(swing.score)}`}>
                      {swing.score}
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-slate-700" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
