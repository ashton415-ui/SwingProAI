import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { LogOut, LayoutDashboard, TrendingUp, CreditCard, Target, Zap } from "lucide-react";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user ?? null;
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("full_name, subscription_status, subscription_tier")
    .eq("id", user.id)
    .single();

  const isActive = profile?.subscription_status === "active" || profile?.subscription_status === "trialing";
  const tier = profile?.subscription_tier ?? "none";

  const tierLabel: Record<string, string> = {
    par: "Par",
    birdie: "Birdie",
    eagle: "Eagle",
    none: "Free",
  };

  return (
    <div className="flex min-h-screen bg-golf-dark">
      {/* Sidebar */}
      <aside className="w-64 bg-golf-header border-r border-white/5 flex flex-col fixed h-full">
        {/* Logo */}
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

          {/* User + tier */}
          <div className="mt-5 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 truncate max-w-[130px]">
              {profile?.full_name ?? user.email}
            </p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
              isActive
                ? "bg-golf-green/10 border-golf-green/30 text-golf-green"
                : "bg-white/5 border-white/10 text-gray-500"
            }`}>
              {tierLabel[tier]}
            </span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1">
          <NavLink href="/dashboard" icon={<LayoutDashboard size={16} />} label="Progress Hub" />
          <NavLink href="/dashboard/swings" icon={<TrendingUp size={16} />} label="Telemetry Logs" />
          <NavLink href="/analyze" icon={<Target size={16} />} label="Analyze Swing" />
          {!isActive && (
            <div className="pt-3 mt-3 border-t border-white/5">
              <Link
                href="/upgrade"
                className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-golf-green font-black uppercase tracking-widest text-[10px] bg-golf-green/10 border border-golf-green/20 hover:bg-golf-green/15 transition-colors"
              >
                <CreditCard size={14} />
                Upgrade Plan
              </Link>
            </div>
          )}
        </nav>

        {/* Sign out */}
        <div className="p-4 border-t border-white/5">
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="flex items-center gap-3 px-3 py-2.5 w-full rounded-2xl text-gray-600 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest"
            >
              <LogOut size={14} />
              End Session
            </button>
          </form>

          <div className="flex items-center gap-2 px-3 mt-4">
            <Zap size={9} className="text-golf-green" fill="currentColor" />
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-gray-700">
              AI-Integrated Analysis
            </p>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 ml-64 min-h-screen">
        {children}
      </main>
    </div>
  );
}

function NavLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest"
    >
      <span className="text-golf-green">{icon}</span>
      {label}
    </Link>
  );
}
