'use client';

import { useState, useRef } from 'react';
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

const SWIPE_CLOSE_THRESHOLD = 80; // px

export default function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragY, setDragY] = useState(0);
  const touchStartY = useRef(0);
  const dragging = useRef(false);
  const thresholdCrossed = useRef(false);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/');
  }

  const moreIsActive = MORE_ITEMS.some(({ href }) => isActive(href));

  function haptic() {
    navigator.vibrate?.(10);
  }

  function closeSheet() {
    setMoreOpen(false);
    setDragY(0);
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartY.current = e.touches[0].clientY;
    dragging.current = true;
    thresholdCrossed.current = false;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!dragging.current) return;
    const delta = Math.max(0, e.touches[0].clientY - touchStartY.current);
    if (delta >= SWIPE_CLOSE_THRESHOLD && !thresholdCrossed.current) {
      thresholdCrossed.current = true;
      haptic();
    }
    setDragY(delta);
  }

  function onTouchEnd() {
    dragging.current = false;
    if (dragY >= SWIPE_CLOSE_THRESHOLD) {
      haptic();
      closeSheet();
    } else {
      haptic();
      setDragY(0); // spring back
    }
  }

  return (
    <>
      {/* Backdrop */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => { haptic(); closeSheet(); }}
        />
      )}

      {/* More sheet */}
      {moreOpen && (
        <div
          className={`fixed bottom-16 inset-x-0 z-50 bg-slate-900 border-t border-white/10 rounded-t-2xl px-4 pt-3 pb-6 md:hidden ${
            dragY === 0 ? 'transition-transform duration-200' : ''
          }`}
          style={{ transform: `translateY(${dragY}px)` }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* Drag handle */}
          <div className="flex justify-center mb-3" onTouchStart={haptic}>
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>

          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              More
            </span>
            <button
              onClick={() => { haptic(); closeSheet(); }}
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
                  onClick={() => { haptic(); closeSheet(); }}
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
              onClick={() => !active && navigator.vibrate?.(10)}
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
          onClick={() => {
            if (moreOpen) {
              haptic();
              closeSheet();
            } else {
              navigator.vibrate?.(10);
              setMoreOpen(true);
            }
          }}
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
