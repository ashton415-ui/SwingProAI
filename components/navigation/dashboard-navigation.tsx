/**
 * Single source of truth for the authenticated dashboard's navigation
 * inventory. Desktop (app/(dashboard)/layout.tsx) and mobile/tablet
 * (components/navigation/MobileDashboardNavigation.tsx) both render from
 * these exact same section/item definitions — neither defines its own
 * independent copy of the golfer/coach/admin link lists.
 *
 * Deliberately framework-light: everything exported here is plain data or
 * pure functions (no hooks, no "use client"/"use server" directive, no
 * browser or server-only APIs), so it can be imported from a server
 * component, a client component, and a plain Vitest test with identical
 * behavior.
 */
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard, TrendingUp, Target, Briefcase, Flag, Crosshair,
  ClipboardCheck, BookOpen, UserCheck, Users, Video, Shield, CreditCard,
} from "lucide-react";

export type DashboardRole = "golfer" | "coach" | "admin";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * True for the deliberate subset of a section's items that also appears
   * in the phone bottom-tab bar / tablet icon rail. Every item — whether
   * or not it is a bottom-tab item — always appears in the complete
   * overflow drawer via `getEffectiveNavItems`.
   */
  bottomTab: boolean;
}

export interface NavSection {
  id: DashboardRole;
  title: string;
  items: NavItem[];
}

export const GOLFER_SECTION: NavSection = {
  id: "golfer",
  title: "Golfer",
  items: [
    { href: "/dashboard", label: "Progress Hub", icon: LayoutDashboard, bottomTab: true },
    { href: "/telemetry", label: "Telemetry Logs", icon: TrendingUp, bottomTab: false },
    { href: "/analyze", label: "Analyze Swing", icon: Target, bottomTab: true },
    { href: "/bag", label: "My Bag", icon: Briefcase, bottomTab: true },
    { href: "/goals", label: "My Goals", icon: Flag, bottomTab: true },
    { href: "/range", label: "Practice Range", icon: Crosshair, bottomTab: false },
    { href: "/drills", label: "Drill Hub", icon: ClipboardCheck, bottomTab: false },
    { href: "/lessons", label: "My Lessons", icon: BookOpen, bottomTab: false },
  ],
};

export const COACH_SECTION: NavSection = {
  id: "coach",
  title: "Coach",
  items: [
    { href: "/coach", label: "Coach Hub", icon: UserCheck, bottomTab: true },
    { href: "/coach/golfers", label: "My Golfers", icon: Users, bottomTab: true },
    { href: "/coach/reviews", label: "Swing Reviews", icon: Video, bottomTab: true },
    { href: "/coach/lesson-plans", label: "Lesson Plans", icon: BookOpen, bottomTab: true },
  ],
};

export const ADMIN_SECTION: NavSection = {
  id: "admin",
  title: "Admin",
  items: [
    { href: "/admin", label: "Command Center", icon: Shield, bottomTab: true },
    { href: "/admin/users", label: "All Users", icon: Users, bottomTab: true },
    { href: "/admin/coaches", label: "Coaches", icon: UserCheck, bottomTab: true },
    { href: "/admin/swings", label: "All Swings", icon: Video, bottomTab: true },
    { href: "/upgrade", label: "View Plans", icon: CreditCard, bottomTab: false },
  ],
};

/** The golfer-only "Upgrade Plan" callout, shown separately from the
 *  admin section's "View Plans" link even though both point at `/upgrade`
 *  — they are distinct UI treatments (a highlighted CTA vs. an ordinary
 *  nav link), not the same NavItem reused. */
export const UPGRADE_CALLOUT = { href: "/upgrade", label: "Upgrade Plan" } as const;

export const SIGN_OUT = { href: "/api/auth/signout", label: "End Session" } as const;

/** Which sections a role sees. Admin sees all three, in golfer/coach/admin
 *  order, exactly matching the original hardcoded desktop sidebar order. */
export function getSectionsForRole(role: string): NavSection[] {
  if (role === "admin") return [GOLFER_SECTION, COACH_SECTION, ADMIN_SECTION];
  if (role === "coach") return [COACH_SECTION];
  return [GOLFER_SECTION];
}

/** The complete, deduplicated (by href) navigation inventory for a role —
 *  this is exactly what the mobile/tablet overflow drawer renders in full. */
export function getEffectiveNavItems(role: string): NavItem[] {
  const seen = new Set<string>();
  const items: NavItem[] = [];
  for (const section of getSectionsForRole(role)) {
    for (const item of section.items) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      items.push(item);
    }
  }
  return items;
}

/**
 * The deliberate small subset shown in the phone bottom-tab bar / tablet
 * icon rail. For admin, this is the admin section's own bottom-tab items
 * only (Command Center, Users, Coaches, Swings) rather than a union across
 * all three sections — an admin's phone quick-actions stay focused on
 * platform management, while the full golfer and coach inventories remain
 * one tap away in the complete overflow drawer via `getEffectiveNavItems`.
 */
export function getBottomTabItems(role: string): NavItem[] {
  const primarySection = role === "admin" ? ADMIN_SECTION : role === "coach" ? COACH_SECTION : GOLFER_SECTION;
  return primarySection.items.filter((item) => item.bottomTab);
}

/** Matches the original inline condition exactly: only a golfer with no
 *  active/trialing subscription sees the upgrade callout. */
export function shouldShowUpgradeCallout(role: string, isActive: boolean): boolean {
  return role === "golfer" && !isActive;
}
