import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Users, Video, UserCheck, CreditCard } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users").select("role").eq("id", session.user.id).single();

  if (profile?.role !== "admin") redirect("/dashboard");

  const [{ count: userCount }, { count: videoCount }, { count: coachCount }] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("swing_videos").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }).eq("role", "coach"),
  ]);

  const stats = [
    { label: "Total Users", value: userCount ?? 0, icon: <Users size={18} />, href: "/admin/users" },
    { label: "Swing Videos", value: videoCount ?? 0, icon: <Video size={18} />, href: "/admin/swings" },
    { label: "Coaches", value: coachCount ?? 0, icon: <UserCheck size={18} />, href: "/admin/coaches" },
    { label: "Subscriptions", value: "—", icon: <CreditCard size={18} />, href: "/admin/subscriptions" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase mb-2">Admin</h1>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-10">Command Center</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}
            className="bg-golf-surface border border-white/5 rounded-4xl p-6 hover:border-golf-green/30 transition-colors">
            <div className="text-golf-green mb-4">{s.icon}</div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-2">{s.label}</p>
            <p className="text-3xl font-mono font-black text-white">{s.value}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
