'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Video,
  Activity,
  Briefcase,
  Users,
  BookOpen,
  Zap,
  TrendingUp,
} from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Analyze', href: '/analyze', icon: Video },
  { label: 'Swings', href: '/swings', icon: Activity },
  { label: 'History', href: '/history', icon: TrendingUp },
  { label: 'My Bag', href: '/bag', icon: Briefcase },
  { label: 'Coach', href: '/coach', icon: Users },
  { label: 'Lessons', href: '/lessons', icon: BookOpen },
] as const;

const UPGRADE_ITEM = { label: 'Upgrade', href: '/upgrade', icon: Zap };

export default function DashboardNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <nav className="flex flex-col h-full py-4">
      {/* Logo */}
      <div className="px-4 mb-6">
        <span className="text-lg font-bold text-white tracking-tight">
          Swing<span className="text-indigo-400">Pro</span>AI
        </span>
      </div>

      {/* Main links */}
      <ul className="flex-1 space-y-0.5 px-2">
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Upgrade CTA */}
      <div className="px-2 mt-4">
        <Link
          href={UPGRADE_ITEM.href}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive(UPGRADE_ITEM.href)
              ? 'bg-indigo-600 text-white'
              : 'text-amber-400 hover:text-amber-300 hover:bg-amber-400/10'
          }`}
        >
          <UPGRADE_ITEM.icon className="w-4 h-4 shrink-0" />
          {UPGRADE_ITEM.label}
        </Link>
      </div>
    </nav>
  );
}
