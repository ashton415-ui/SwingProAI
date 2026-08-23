import { createClient, getServerSession } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { SwingAnalysis } from "@/types/database";
import { Target, TrendingUp, Trophy, Calendar, ChevronRight, Zap, Filter, Activity } from "lucide-react";

export default async function DashboardPage() {
  const supabase = await createClient();
  const session = await getServerSession();
  if (!session) redirect("/login");
  const user = session.user;

  const { data: swings } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(club, status, created_at)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(10) as { data: SwingAnalysis[] | null };

  const totalSwings = swings?.length ?? 0;
  const avgTempo = swings?.length
    ? (swings.reduce((s, a) => s + (a.tempo_ratio ?? 0), 0) / swings.length).toFixed(1)
    : null;
  const avgScore = swings?.length
    ? (swings.reduce((s, a) => s + (a.score ?? 0), 0) / swings.length).toFixed(0)
    : null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">
        <div>
          <h1 className="text-4xl md:text-5xl font-black italic tracking-tighter text-white uppercase">
            Progress Hub
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            Swing &amp; On-Course Intelligence
          </p>
        </div>
        <Link
          href="/analyze"
          className="px-6 py-3 bg-golf-green text-golf-dark rounded-2xl font-black flex items-center gap-2 hover:bg-[#22C55E] transition-all shadow-[0_0_20px_rgba(74,222,128,0.15)] text-[10px] uppercase tracking-widest"
        >
          <Target size={14} />
          Analyze Swing
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
        <div className="bg-golf-surface p-6 rounded-4xl border border-golf-green/20 relative overflow-hidden shadow-xl shadow-golf-green/5">
          <div className="absolute -top-4 -right-4 opacity-5">
            <Trophy className="w-24 h-24 text-golf-green" />
          </div>
          <p className="text-[9px] font-black text-golf-green uppercase tracking-widest mb-4 flex items-center gap-2">
            <Trophy size={10} /> Total Analyses
          </p>
          <h4 className="text-5xl font-mono font-black italic tracking-tighter text-white">
            {totalSwings}
          </h4>
          <p className="text-[9px] text-gray-600 font-bold uppercase mt-2 tracking-widest">Lifetime sessions</p>
        </div>

        <div className="bg-golf-surface p-6 rounded-4xl border border-white/5">
          <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
            <TrendingUp size={10} /> Avg Tempo Ratio
          </p>
          <h4 className="text-5xl font-mono font-black italic tracking-tighter text-white">
            {avgTempo ?? "—"}
          </h4>
          <p className="text-[9px] text-golf-green font-bold uppercase mt-2 tracking-widest">Target: 3.0 : 1</p>
        </div>

        <div className="bg-golf-surface p-6 rounded-4xl border border-white/5">
          <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
            <Activity size={10} /> Avg Swing Score
          </p>
          <h4 className="text-5xl font-mono font-black italic tracking-tighter text-white">
            {avgScore ?? "—"}
          </h4>
          <div className="w-full bg-white/5 h-1 rounded-full mt-4 overflow-hidden">
            {avgScore && (
              <div
                className="h-full bg-golf-green"
                style={{ width: `${Math.min(parseInt(avgScore), 100)}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Telemetry Logs Table */}
      <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden shadow-2xl">
        <div className="px-8 py-6 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-[10px] font-black italic tracking-widest text-white uppercase flex items-center gap-2">
            <Zap size={12} className="text-golf-green" />
            Recent Telemetry Logs
          </h3>
          <button className="text-[9px] font-bold text-gray-600 hover:text-white transition-colors flex items-center gap-2 uppercase tracking-widest">
            <Filter size={12} />
            Filter
          </button>
        </div>

        {!swings || swings.length === 0 ? (
          <div className="py-20 text-center text-gray-700 font-mono text-[10px] uppercase tracking-[0.3em] italic flex flex-col items-center gap-4">
            <Zap size={32} className="opacity-10" />
            <p>Telemetry Array Empty</p>
            <Link
              href="/analyze"
              className="px-5 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all"
            >
              Upload First Swing
            </Link>
          </div>
        ) : (
          <>
          {/* Phone (<md): purpose-built telemetry records. Carries the same five
              core fields as the table so nothing is reachable only by scrolling. */}
          <ul className="md:hidden divide-y divide-white/5">
            {swings.map((swing) => (
              <li key={swing.id}>
                <Link
                  href={`/swings/${swing.id}`}
                  className="block px-5 py-4 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Timestamp</p>
                      <div className="flex items-center gap-2 min-w-0">
                        <Calendar size={12} className="text-gray-600 shrink-0" />
                        <span className="text-xs font-mono text-gray-400 break-words">
                          {new Date(swing.created_at).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                          })}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Status</p>
                      <span className="inline-block px-3 py-1 bg-white/5 text-gray-600 rounded-full text-[9px] font-black uppercase tracking-widest border border-white/5">
                        {swing.status ?? "pending"}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 mt-4">
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Club</p>
                      <p className="text-sm font-bold text-gray-200 capitalize break-words">
                        {swing.swing_video?.club ?? "Unknown"}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Score</p>
                      <div className={`inline-flex items-center justify-center px-3 py-1 rounded-lg bg-black/40 text-xs font-mono font-black border ${
                        (swing.score ?? 0) >= 80
                          ? "text-golf-green border-golf-green/20"
                          : (swing.score ?? 0) >= 60
                          ? "text-yellow-400 border-yellow-400/20"
                          : "text-red-400 border-red-500/20"
                      }`}>
                        {swing.score != null ? `${swing.score} pts` : "—"}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Tempo</p>
                      <p className="text-xs font-mono font-black text-white">
                        {swing.tempo_ratio?.toFixed(1) ?? "—"}
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Tablet/desktop (md+): the full semantic table, unchanged. */}
          <div className="hidden md:block overflow-x-auto w-full">
            <table className="w-full text-left min-w-[800px]">
              <thead>
                <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                  <th className="px-8 py-4">Timestamp</th>
                  <th className="px-8 py-4">Club</th>
                  <th className="px-8 py-4">Score</th>
                  <th className="px-8 py-4">Tempo</th>
                  <th className="px-8 py-4">Status</th>
                  <th className="px-8 py-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {swings.map((swing) => (
                  <tr key={swing.id} className="group hover:bg-white/5 transition-colors">
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-2">
                        <Calendar size={12} className="text-gray-600" />
                        <span className="text-xs font-mono text-gray-400">
                          {new Date(swing.created_at).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                          })}
                        </span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className="text-sm font-bold text-gray-200 capitalize">
                        {swing.swing_video?.club ?? "Unknown"}
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      <div className={`inline-flex items-center justify-center px-3 py-1 rounded-lg bg-black/40 text-xs font-mono font-black border ${
                        (swing.score ?? 0) >= 80
                          ? "text-golf-green border-golf-green/20"
                          : (swing.score ?? 0) >= 60
                          ? "text-yellow-400 border-yellow-400/20"
                          : "text-red-400 border-red-500/20"
                      }`}>
                        {swing.score != null ? `${swing.score} pts` : "—"}
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className="text-xs font-mono font-black text-white">
                        {swing.tempo_ratio?.toFixed(1) ?? "—"}
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      <span className="px-3 py-1 bg-white/5 text-gray-600 rounded-full text-[9px] font-black uppercase tracking-widest border border-white/5">
                        {swing.status ?? "pending"}
                      </span>
                    </td>
                    <td className="px-8 py-5 text-right">
                      <Link
                        href={`/swings/${swing.id}`}
                        className="p-1 text-gray-700 group-hover:text-golf-green transition-all inline-block"
                      >
                        <ChevronRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}