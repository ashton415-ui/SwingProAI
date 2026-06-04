import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight, UserPlus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CoachGolfersPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "coach" && profile?.role !== "admin") redirect("/dashboard");

  const { data: relationships } = await supabase
    .from("coach_golfer_relationships")
    .select("*, golfer:users!golfer_id(id, full_name, email, handicap_index, subscription_tier)")
    .eq("coach_id", session.user.id)
    .order("created_at", { ascending: false });

  const active = relationships?.filter(r => r.status === "active") ?? [];
  const pending = relationships?.filter(r => r.status === "pending") ?? [];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase">My Golfers</h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            {active.length} active · {pending.length} pending
          </p>
        </div>
        <button className="px-5 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] flex items-center gap-2 hover:bg-[#22C55E] transition-all">
          <UserPlus size={14} />Invite Golfer
        </button>
      </div>

      {pending.length > 0 && (
        <div className="mb-6">
          <p className="text-[9px] font-black uppercase tracking-widest text-yellow-400 mb-3">Pending Invitations</p>
          <div className="bg-golf-surface border border-yellow-500/20 rounded-4xl overflow-hidden">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-6 py-4 border-b border-white/5 last:border-0">
                <div>
                  <p className="font-bold text-white text-sm">{r.golfer?.full_name ?? "—"}</p>
                  <p className="text-[10px] text-gray-500">{r.golfer?.email}</p>
                </div>
                <span className="text-[9px] font-black uppercase tracking-widest text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
                  Pending
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-golf-surface border border-white/5 rounded-5xl overflow-hidden">
        {active.length === 0 ? (
          <div className="py-20 text-center text-gray-600 text-[10px] font-mono uppercase tracking-widest">
            No active golfers yet
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                <th className="px-6 py-4">Golfer</th>
                <th className="px-6 py-4">Handicap</th>
                <th className="px-6 py-4">Plan</th>
                <th className="px-6 py-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {active.map((r) => (
                <tr key={r.id} className="group hover:bg-white/5 transition-colors">
                  <td className="px-6 py-4">
                    <p className="font-bold text-white text-sm">{r.golfer?.full_name ?? "—"}</p>
                    <p className="text-[10px] text-gray-500">{r.golfer?.email}</p>
                  </td>
                  <td className="px-6 py-4">
                    <span className="font-mono text-white">{r.golfer?.handicap_index ?? "—"}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-[9px] font-black uppercase text-gray-500">{r.golfer?.subscription_tier}</span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link href={`/coach/golfers/${r.golfer_id}`}
                      className="text-gray-600 group-hover:text-golf-green transition-colors">
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
