import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Users, Video, BookOpen, MessageSquare } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CoachDashboardPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role, full_name").eq("id", session.user.id).single();
  if (profile?.role !== "coach" && profile?.role !== "admin") redirect("/dashboard");

  const [{ count: golferCount }, { count: feedbackCount }, { count: planCount }] = await Promise.all([
    supabase.from("coach_golfer_relationships").select("*", { count: "exact", head: true })
      .eq("coach_id", session.user.id).eq("status", "active"),
    supabase.from("coach_feedback").select("*", { count: "exact", head: true })
      .eq("coach_id", session.user.id),
    supabase.from("lesson_plans").select("*", { count: "exact", head: true })
      .eq("coach_id", session.user.id).eq("status", "active"),
  ]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase mb-1">Coach Portal</h1>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-10">
        Welcome, {profile?.full_name ?? "Coach"}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        {[
          { label: "Active Golfers", value: golferCount ?? 0, icon: <Users size={18} />, href: "/coach/golfers", color: "border-golf-green/20" },
          { label: "Swing Reviews", value: feedbackCount ?? 0, icon: <Video size={18} />, href: "/coach/reviews", color: "border-white/5" },
          { label: "Lesson Plans", value: planCount ?? 0, icon: <BookOpen size={18} />, href: "/coach/lesson-plans", color: "border-white/5" },
          { label: "Feedback Given", value: feedbackCount ?? 0, icon: <MessageSquare size={18} />, href: "/coach/reviews", color: "border-white/5" },
        ].map((s) => (
          <Link key={s.label} href={s.href}
            className={`bg-golf-surface border ${s.color} rounded-4xl p-6 hover:border-golf-green/30 transition-colors`}>
            <div className="text-golf-green mb-4">{s.icon}</div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-2">{s.label}</p>
            <p className="text-3xl font-mono font-black text-white">{s.value}</p>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/coach/golfers"
          className="bg-golf-surface border border-white/5 rounded-4xl p-6 hover:border-golf-green/30 transition-colors flex items-center gap-4">
          <div className="w-12 h-12 bg-golf-green/10 rounded-2xl flex items-center justify-center shrink-0">
            <Users size={20} className="text-golf-green" />
          </div>
          <div>
            <p className="font-black text-white uppercase tracking-tight">My Golfers</p>
            <p className="text-[10px] text-gray-500 mt-0.5">View and manage your roster</p>
          </div>
        </Link>
        <Link href="/coach/lesson-plans"
          className="bg-golf-surface border border-white/5 rounded-4xl p-6 hover:border-golf-green/30 transition-colors flex items-center gap-4">
          <div className="w-12 h-12 bg-golf-green/10 rounded-2xl flex items-center justify-center shrink-0">
            <BookOpen size={20} className="text-golf-green" />
          </div>
          <div>
            <p className="font-black text-white uppercase tracking-tight">Lesson Plans</p>
            <p className="text-[10px] text-gray-500 mt-0.5">Create and assign training plans</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
