import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  LogOut, LayoutDashboard, TrendingUp, CreditCard, Target, Zap,
  Users, BookOpen, Video, Shield, UserCheck, Briefcase, Flag, Crosshair, ClipboardCheck,
} from "lucide-react";
import MobileNav from "@/components/ui/MobileNav";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("full_name, display_name, subscription_status, subscription_tier, role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "golfer";
  const isActive = profile?.subscription_status === "active" || profile?.subscription_status === "trialing";
  const tier = profile?.subscription_tier ?? "none";

  const tierLabel: Record<string, string> = {
    par: "Par", birdie: "Birdie", eagle: "Eagle",
    coach_starter: "Coach", coach_pro: "Coach Pro", none: "Free",
  };

  const roleBadgeColor =
    role === "admin" ? "bg-red-500/10 border-red-500/30 text-red-400" :
    role === "coach" ? "bg-blue-500/10 border-blue-500/30 text-blue-400" :
    isActive ? "bg-golf-green/10 border-golf-green/30 text-golf-green" :
    "bg-white/5 border-white/10 text-gray-500";

  const displayName = profile?.display_name ?? profile?.full_name ?? user.email;

  return (
    <div className="relative flex h-screen bg-golf-dark">
      <MobileNav />

      {/* Desktop Sidebar: Hidden on Mobile (hidden md:flex) */}
      <aside className="hidden md:flex w-64 bg-golf-header border-r border-white/5 flex-col fixed h-full overflow-y-auto z-20">
        <div className="px-6 py-7 border-b border-white/5">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 bg-golf-green/5 border border-golf-green/20 rounded-xl overflow-hidden shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain" />
            </div>
            <span className="text-white font-black italic tracking-tighter uppercase text-lg leading-none">
              Swing<span className="text-golf-green">Pro</span>AI
            </span>
          </Link>
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 truncate">
              {displayName}
            </p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border shrink-0 ${roleBadgeColor}`}>
              {role === "admin" ? "Admin" : role === "coach" ? tierLabel[tier] : tierLabel[tier]}
            </span>
          </div>
        </div>

        {/* Nav — Golfer */}
        {(role === "golfer" || role === "admin") && (
          <nav className="p-4 space-y-1 border-b border-white/5">
            {role === "admin" && (
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-700 px-3 pb-1">Golfer</p>
            )}
            <NavLink href="/dashboard" icon={<LayoutDashboard size={16} />} label="Progress Hub" />
            <NavLink href="/telemetry" icon={<TrendingUp size={16} />} label="Telemetry Logs" />
            <NavLink href="/analyze" icon={<Target size={16} />} label="Analyze Swing" />
            <NavLink href="/bag" icon={<Briefcase size={16} />} label="My Bag" />
            <NavLink href="/goals" icon={<Flag size={16} />} label="My Goals" />
            <NavLink href="/range" icon={<Crosshair size={16} />} label="Practice Range" />
            <NavLink href="/drills" icon={<ClipboardCheck size={16} />} label="Drill Hub" />
            <NavLink href="/lessons" icon={<BookOpen size={16} />} label="My Lessons" />
          </nav>
        )}

        {/* Nav — Coach */}
        {(role === "coach" || role === "admin") && (
          <nav className="p-4 space-y-1 border-b border-white/5">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-700 px-3 pb-1">Coach</p>
            <NavLink href="/coach" icon={<UserCheck size={16} />} label="Coach Hub" />
            <NavLink href="/coach/golfers" icon={<Users size={16} />} label="My Golfers" />
            <NavLink href="/coach/reviews" icon={<Video size={16} />} label="Swing Reviews" />
            <NavLink href="/coach/lesson-plans" icon={<BookOpen size={16} />} label="Lesson Plans" />
          </nav>
        )}

        {/* Nav — Admin */}
        {role === "admin" && (
          <nav className="p-4 space-y-1 border-b border-white/5">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-700 px-3 pb-1">Admin</p>
            <NavLink href="/admin" icon={<Shield size={16} />} label="Command Center" />
            <NavLink href="/admin/users" icon={<Users size={16} />} label="All Users" />
            <NavLink href="/admin/coaches" icon={<UserCheck size={16} />} label="Coaches" />
            <NavLink href="/admin/swings" icon={<Video size={16} />} label="All Swings" />
            <NavLink href="/upgrade" icon={<CreditCard size={16} />} label="View Plans" />
          </nav>
        )}

        {/* Upgrade — golfer only, no active sub */}
        {role === "golfer" && !isActive && (
          <div className="px-4 pt-3">
            <Link href="/upgrade"
              className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-golf-green font-black uppercase tracking-widest text-[10px] bg-golf-green/10 border border-golf-green/20 hover:bg-golf-green/15 transition-colors">
              <CreditCard size={14} />Upgrade Plan
            </Link>
          </div>
        )}

        {/* Sign out */}
        <div className="p-4 border-t border-white/5 mt-auto">
          <form action="/api/auth/signout" method="POST">
            <button type="submit"
              className="flex items-center gap-3 px-3 py-2.5 w-full rounded-2xl text-gray-600 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest">
              <LogOut size={14} />End Session
            </button>
          </form>
          <div className="flex items-center gap-2 px-3 mt-4">
            <Zap size={9} className="text-golf-green" fill="currentColor" />
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-gray-700">AI-Integrated Analysis</p>
          </div>
        </div>
      </aside>

      {/* Main Content: Full width on mobile, right-aligned on desktop. Padding bottom ensures content isn't hidden behind the MobileNav. */}
      <main className="flex-1 min-w-0 overflow-y-auto pb-24 md:pb-0">
        {children}
      </main>

    </div>
  );
}

function NavLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href}
      className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest">
      <span className="text-golf-green">{icon}</span>
      {label}
    </Link>
  );
}