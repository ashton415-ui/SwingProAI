'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Video,
  Briefcase,
  Activity,
  MoreHorizontal,
  X,
  Users,
  BookOpen,
  Zap,
} from 'lucide-react';

const PRIMARY_TABS = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Analyze', href: '/analyze', icon: Video },
  { label: 'My Bag', href: '/bag', icon: Briefcase },
  { label: 'Swings', href: '/swings', icon: Activity },
] as const;

const MORE_ITEMS = [
  { label: 'Coach', href: '/coach', icon: Users },
  { label: 'Lessons', href: '/lessons', icon: BookOpen },
  { label: 'Upgrade', href: '/upgrade', icon: Zap },
] as const;

export default function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/');
  }

  const moreIsActive = MORE_ITEMS.some(({ href }) => isActive(href));

  return (
    <>
      {/* Backdrop */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* More sheet */}
      {moreOpen && (
        <div className="fixed bottom-16 inset-x-0 z-50 bg-slate-900 border-t border-white/10 rounded-t-2xl px-4 pt-4 pb-6 md:hidden">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              More
            </span>
            <button
              onClick={() => setMoreOpen(false)}
              className="p-1 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-1">
            {MORE_ITEMS.map(({ label, href, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={() => setMoreOpen(false)}
                  className={`flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-colors ${
                    isActive(href)
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-300 hover:bg-white/[0.06]'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tab bar */}
      <nav className="fixed bottom-0 inset-x-0 z-40 flex md:hidden bg-slate-900/95 backdrop-blur-sm border-t border-white/10">
        {PRIMARY_TABS.map(({ label, href, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors ${
                active ? 'text-indigo-400' : 'text-slate-500 active:text-slate-300'
              }`}
            >
              <Icon className={`w-5 h-5 transition-transform ${active ? 'scale-110' : ''}`} />
              {label}
            </Link>
          );
        })}

        {/* More button */}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors ${
            moreIsActive || moreOpen ? 'text-indigo-400' : 'text-slate-500 active:text-slate-300'
          }`}
        >
          <MoreHorizontal className="w-5 h-5" />
          More
        </button>
      </nav>
    </>
  );
}
