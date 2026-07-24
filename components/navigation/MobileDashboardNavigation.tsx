"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, X, LogOut, CreditCard, Zap } from "lucide-react";
import {
  getBottomTabItems,
  getEffectiveNavItems,
  UPGRADE_CALLOUT,
  SIGN_OUT,
} from "./dashboard-navigation";

interface MobileDashboardNavigationProps {
  role: string;
  displayName: string;
  roleLabel: string;
  roleBadgeClassName: string;
  showUpgradeCallout: boolean;
}

/**
 * Phone (<768px) and tablet (768px–1023px) navigation for the authenticated
 * dashboard shell. Renders nothing structurally different at >=1024px — the
 * whole component is wrapped in `lg:hidden` so the existing desktop sidebar
 * in app/(dashboard)/layout.tsx remains the sole navigation surface there.
 *
 * All props are plain serializable values (strings/booleans) — no React
 * nodes or functions cross the server->client boundary from the layout.
 */
export default function MobileDashboardNavigation({
  role,
  displayName,
  roleLabel,
  roleBadgeClassName,
  showUpgradeCallout,
}: MobileDashboardNavigationProps) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const pathname = usePathname();

  const bottomTabItems = getBottomTabItems(role);
  const allItems = getEffectiveNavItems(role);

  // The user has navigated to a new route — the drawer (if open) should
  // never linger over the page it was opened from.
  useEffect(() => {
    setIsDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isDrawerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDrawerOpen]);

  // Lock body scroll behind the drawer overlay while it's open.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDrawerOpen]);

  return (
    <div className="lg:hidden">
      {/* ── Top bar (phone + tablet) ── */}
      <header
        className="fixed top-0 inset-x-0 z-40 flex items-center justify-between gap-3 bg-golf-header border-b border-white/5 px-4 h-14"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <Link href="/" className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 bg-golf-green/5 border border-golf-green/20 rounded-lg overflow-hidden shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain" />
          </div>
          <span className="text-white font-black italic tracking-tighter uppercase text-sm leading-none truncate">
            Swing<span className="text-golf-green">Pro</span>AI
          </span>
        </Link>

        <div className="flex items-center gap-2 min-w-0">
          <p className="hidden sm:block text-[9px] font-bold uppercase tracking-widest text-gray-500 truncate max-w-[120px]">
            {displayName}
          </p>
          <span
            className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border shrink-0 ${roleBadgeClassName}`}
          >
            {roleLabel}
          </span>
          <button
            type="button"
            onClick={() => setIsDrawerOpen(true)}
            aria-expanded={isDrawerOpen}
            aria-controls="mobile-nav-drawer"
            aria-label="Open navigation menu"
            className="flex items-center justify-center w-11 h-11 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
          >
            <Menu size={20} />
          </button>
        </div>
      </header>

      {/* ── Phone bottom-tab bar — hidden at tablet width and above ── */}
      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-golf-header border-t border-white/5 flex items-stretch h-16"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {bottomTabItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center justify-center gap-1 min-w-[44px] text-[8px] font-black uppercase tracking-widest transition-colors ${
                active ? "text-golf-green" : "text-gray-500 hover:text-white"
              }`}
            >
              <Icon size={18} />
              <span className="truncate max-w-full px-1">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          aria-expanded={isDrawerOpen}
          aria-controls="mobile-nav-drawer"
          aria-label="Open full navigation menu"
          className="flex-1 flex flex-col items-center justify-center gap-1 min-w-[44px] text-[8px] font-black uppercase tracking-widest text-gray-500 hover:text-white transition-colors"
        >
          <Menu size={18} />
          <span>More</span>
        </button>
      </nav>

      {/* ── Tablet icon rail — 768px through 1023px only ── */}
      <nav
        aria-label="Primary"
        className="hidden md:flex lg:hidden fixed left-0 top-14 bottom-0 z-30 w-16 bg-golf-header border-r border-white/5 flex-col items-center pt-4 pb-4 gap-2"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {bottomTabItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              aria-label={item.label}
              className={`flex items-center justify-center w-11 h-11 rounded-xl transition-colors ${
                active ? "text-golf-green bg-golf-green/10" : "text-gray-500 hover:text-white hover:bg-white/5"
              }`}
            >
              <Icon size={20} />
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          aria-expanded={isDrawerOpen}
          aria-controls="mobile-nav-drawer"
          aria-label="Open full navigation menu"
          className="flex items-center justify-center w-11 h-11 rounded-xl text-gray-500 hover:text-white hover:bg-white/5 transition-colors mt-auto"
        >
          <Menu size={20} />
        </button>
      </nav>

      {/* ── Complete overflow drawer — every authorized navigation item ── */}
      {isDrawerOpen && (
        <>
          <div
            role="presentation"
            onClick={() => setIsDrawerOpen(false)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
          />
          <div
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Full navigation menu"
            className="fixed inset-y-0 right-0 z-50 w-[85vw] max-w-sm bg-golf-header border-l border-white/5 flex flex-col overflow-y-auto"
            style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <p className="text-[10px] font-black uppercase tracking-widest text-gray-500 truncate">{displayName}</p>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="flex items-center justify-center w-11 h-11 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
              >
                <X size={20} />
              </button>
            </div>

            <nav aria-label="Full" className="flex-1 p-4 space-y-1">
              {allItems.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-3 rounded-2xl min-h-[44px] text-[10px] font-black uppercase tracking-widest transition-colors ${
                      active ? "text-golf-green bg-golf-green/10" : "text-gray-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <span className="text-golf-green">
                      <Icon size={16} />
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {showUpgradeCallout && (
              <div className="px-4 pt-2">
                <Link
                  href={UPGRADE_CALLOUT.href}
                  className="flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-2xl text-golf-green font-black uppercase tracking-widest text-[10px] bg-golf-green/10 border border-golf-green/20 hover:bg-golf-green/15 transition-colors"
                >
                  <CreditCard size={14} />
                  {UPGRADE_CALLOUT.label}
                </Link>
              </div>
            )}

            <div className="p-4 border-t border-white/5 mt-auto">
              <form action={SIGN_OUT.href} method="POST">
                <button
                  type="submit"
                  className="flex items-center gap-3 px-3 py-3 w-full min-h-[44px] rounded-2xl text-gray-600 hover:text-white hover:bg-white/5 transition-colors text-[10px] font-black uppercase tracking-widest"
                >
                  <LogOut size={14} />
                  {SIGN_OUT.label}
                </button>
              </form>
              <div className="flex items-center gap-2 px-3 mt-4">
                <Zap size={9} className="text-golf-green" fill="currentColor" />
                <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-gray-700">AI-Integrated Analysis</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
