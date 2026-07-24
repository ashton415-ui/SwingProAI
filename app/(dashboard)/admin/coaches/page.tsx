import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { UserCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminCoachesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "admin") redirect("/dashboard");

  const { data: coaches } = await supabase
    .from("users")
    .select("id, full_name, email, subscription_tier, subscription_status, created_at")
    .eq("role", "coach")
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-8">All Coaches</h1>

      <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
        {(!coaches || coaches.length === 0) ? (
          <div className="py-20 text-center">
            <UserCheck size={32} className="text-gray-700 mx-auto mb-4" />
            <p className="text-gray-600 text-[10px] font-mono uppercase tracking-widest">No coaches yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left min-w-[680px]">
              <thead>
                <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                  <th className="px-6 py-4">Coach</th>
                  <th className="px-6 py-4">Plan</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {coaches.map((c) => (
                  <tr key={c.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-bold text-white text-sm">{c.full_name ?? "—"}</p>
                      <p className="text-[10px] text-gray-500">{c.email}</p>
                    </td>
                    <td className="px-6 py-4"><span className="text-xs font-mono text-gray-400">{c.subscription_tier}</span></td>
                    <td className="px-6 py-4">
                      <span className={`text-[9px] font-black uppercase ${c.subscription_status === "active" ? "text-golf-green" : "text-gray-600"}`}>
                        {c.subscription_status}
                      </span>
                    </td>
                    <td className="px-6 py-4"><span className="text-xs font-mono text-gray-600">{new Date(c.created_at).toLocaleDateString()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
