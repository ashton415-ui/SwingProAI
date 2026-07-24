import { createClient, getServerSession } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { LogOut, CreditCard, Zap } from "lucide-react";
import {
  getSectionsForRole,
  shouldShowUpgradeCallout,
  UPGRADE_CALLOUT,
  SIGN_OUT,
} from "@/components/navigation/dashboard-navigation";
import MobileDashboardNavigation from "@/components/navigation/MobileDashboardNavigation";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const user = session.user;
  const supabase = await createClient();

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

  const roleBadgeLabel = role === "admin" ? "Admin" : role === "coach" ? tierLabel[tier] : tierLabel[tier];
  const displayName = profile?.display_name ?? profile?.full_name ?? user.email;
  const showUpgradeCallout = shouldShowUpgradeCallout(role, isActive);
  const sections = getSectionsForRole(role);

  return (
    <div className="flex min-h-screen bg-golf-dark">
      {/* Desktop sidebar — visible only at lg (>=1024px) and wider */}
      <aside className="hidden lg:flex w-64 bg-golf-header border-r border-white/5 flex-col fixed h-full overflow-y-auto">
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
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 truncate">
              {displayName}
            </p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border shrink-0 ${roleBadgeColor}`}>
              {roleBadgeLabel}
            </span>
          </div>
        </div>

        {/* Nav sections — golfer / coach / admin, shared model */}
        {sections.map((section) => (
          <nav key={section.id} className="p-4 space-y-1 border-b border-white/5">
            {(section.id !== "golfer" || role === "admin") && (
              <p className="text-[9px] font-black uppercase tracking-widest text-gray-700 px-3 pb-1">{section.title}</p>
            )}
            {section.items.map((item) => (
              <NavLink key={item.href} href={item.href} icon={<item.icon size={16} />} label={item.label} />
            ))}
          </nav>
        ))}

        {/* Upgrade — golfer only, no active sub */}
        {showUpgradeCallout && (
          <div className="px-4 pt-3">
            <Link href={UPGRADE_CALLOUT.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-2xl text-golf-green font-black uppercase tracking-widest text-[10px] bg-golf-green/10 border border-golf-green/20 hover:bg-golf-green/15 transition-colors">
              <CreditCard size={14} />{UPGRADE_CALLOUT.label}
            </Link>
          </div>
        )}

        {/* Sign out */}
        <div className="p-4 border-t border-white/5 mt-auto">
          <form action={SIGN_OUT.href} method="POST">
            <button type="submit"
              className="flex items-center gap-3 px-3 py-2.5 w-full rounded-2xl text-gray-600 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest">
              <LogOut size={14} />{SIGN_OUT.label}
            </button>
          </form>
          <div className="flex items-center gap-2 px-3 mt-4">
            <Zap size={9} className="text-golf-green" fill="currentColor" />
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-gray-700">AI-Integrated Analysis</p>
          </div>
        </div>
      </aside>

      {/* Phone + tablet navigation — hides itself at lg (>=1024px) */}
      <MobileDashboardNavigation
        role={role}
        displayName={displayName}
        roleLabel={roleBadgeLabel}
        roleBadgeClassName={roleBadgeColor}
        showUpgradeCallout={showUpgradeCallout}
      />

      <main
        className="flex-1 min-h-screen pt-[calc(3.5rem+env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom))] md:ml-16 md:pb-[env(safe-area-inset-bottom)] lg:ml-64 lg:pt-0 lg:pb-0"
      >
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
