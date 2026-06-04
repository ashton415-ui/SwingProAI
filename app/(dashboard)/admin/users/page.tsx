import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import type { User } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "admin") redirect("/dashboard");

  const { data: users } = await supabase
    .from("users")
    .select("id, email, full_name, role, subscription_tier, subscription_status, created_at")
    .order("created_at", { ascending: false }) as { data: User[] | null };

  const roleBadge = (role: string) => {
    const map: Record<string, string> = {
      admin: "bg-red-500/20 text-red-400 border-red-500/30",
      coach: "bg-blue-500/20 text-blue-400 border-blue-500/30",
      golfer: "bg-golf-green/10 text-golf-green border-golf-green/20",
    };
    return map[role] ?? "bg-white/5 text-gray-500 border-white/10";
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-8">All Users</h1>

      <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
              <th className="px-6 py-4">User</th>
              <th className="px-6 py-4">Role</th>
              <th className="px-6 py-4">Tier</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {(users ?? []).map((u) => (
              <tr key={u.id} className="hover:bg-white/5 transition-colors">
                <td className="px-6 py-4">
                  <p className="text-sm font-bold text-white">{u.full_name ?? "—"}</p>
                  <p className="text-[10px] text-gray-500">{u.email}</p>
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${roleBadge(u.role)}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-xs font-mono text-gray-400">{u.subscription_tier}</span>
                </td>
                <td className="px-6 py-4">
                  <span className={`text-[9px] font-black uppercase ${u.subscription_status === "active" ? "text-golf-green" : "text-gray-600"}`}>
                    {u.subscription_status}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className="text-xs font-mono text-gray-600">
                    {new Date(u.created_at).toLocaleDateString()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
