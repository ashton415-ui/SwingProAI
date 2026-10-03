import type { ReactNode } from "react";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";
import { Users, Video, UserCheck, CreditCard } from "lucide-react";
import { requireAdminForPage } from "@/lib/admin/admin-authority";
import { getAdminDirectoryCounts } from "@/lib/admin/user-directory";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  const caller = await requireAdminForPage();

  // Total Users and Coaches come from the complete admin directory. Swing
  // Videos is unchanged in ADMIN-OPS-0 (still caller-scoped; separate slice).
  const supabase = await createClient();
  const [directory, { count: videoCount }] = await Promise.all([
    getAdminDirectoryCounts(caller),
    supabase.from("swing_videos").select("*", { count: "exact", head: true }),
  ]);

  const directoryNote =
    directory.status === "ok" ? undefined : directory.status === "incomplete" ? "Directory incomplete" : "Directory unavailable";

  const stats: { label: string; value: number | string; note?: string; icon: ReactNode; href: string }[] = [
    { label: "Total Users", value: directory.status === "ok" ? directory.totalUsers : "—", note: directoryNote, icon: <Users size={18} />, href: "/admin/users" },
    { label: "Swing Videos", value: videoCount ?? 0, icon: <Video size={18} />, href: "/admin/swings" },
    { label: "Coaches", value: directory.status === "ok" ? directory.coaches : "—", note: directoryNote, icon: <UserCheck size={18} />, href: "/admin/coaches" },
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
            {s.note && <p className="text-[9px] font-black uppercase tracking-widest text-red-400 mt-2">{s.note}</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
