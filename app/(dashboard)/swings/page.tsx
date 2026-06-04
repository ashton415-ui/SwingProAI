import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { SwingAnalysis } from "@/types/database";
import { Calendar, ChevronRight, Zap, Target } from "lucide-react";

export default async function SwingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: swings } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(club, title, status, created_at)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false }) as { data: SwingAnalysis[] | null };

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
            Telemetry Logs
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            All swing analysis sessions
          </p>
        </div>
        <Link
          href="/analyze"
          className="px-6 py-3 bg-golf-green text-golf-dark rounded-2xl font-black flex items-center gap-2 hover:bg-[#22C55E] transition-all text-[10px] uppercase tracking-widest"
        >
          <Target size={14} />
          New Analysis
        </Link>
      </div>

      <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
        {!swings || swings.length === 0 ? (
          <div className="py-24 text-center flex flex-col items-center gap-4">
            <Zap size={36} className="text-gray-700" />
            <p className="text-gray-700 font-mono text-[10px] uppercase tracking-[0.3em] italic">
              No telemetry recorded yet
            </p>
            <Link
              href="/analyze"
              className="px-5 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all"
            >
              Upload First Swing
            </Link>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                <th className="px-8 py-4">Date</th>
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
                      {swing.swing_video?.club ?? swing.swing_video?.title ?? "Unknown"}
                    </span>
                  </td>
                  <td className="px-8 py-5">
                    <div className={`inline-flex items-center px-3 py-1 rounded-lg bg-black/40 text-xs font-mono font-black border ${
                      (swing.score ?? 0) >= 80 ? "text-golf-green border-golf-green/20"
                      : (swing.score ?? 0) >= 60 ? "text-yellow-400 border-yellow-400/20"
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
                      {swing.status}
                    </span>
                  </td>
                  <td className="px-8 py-5 text-right">
                    <Link
                      href={`/dashboard/swings/${swing.id}`}
                      className="p-1 text-gray-700 group-hover:text-golf-green transition-all inline-block"
                    >
                      <ChevronRight size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
