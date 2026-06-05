"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Crosshair,
  Lock,
  ShieldAlert,
  Target,
  Wrench,
} from "lucide-react";
import type { DeficiencyItem, DeficiencySeverity } from "@/types/database";
import type { SubscriptionTier } from "@/lib/entitlements";
import {
  canUseLaunchMonitor,
  canUseUltraDeepAnalysis,
} from "@/lib/entitlements";

interface MechanicalDeficienciesPanelProps {
  tier: SubscriptionTier;
  deficiencies?: DeficiencyItem[] | null;
  isLoading?: boolean;
}

const CHECKPOINT_LABEL: Record<string, string> = {
  address: "Address",
  takeaway: "Takeaway",
  backswing: "Backswing",
  top: "Top",
  transition: "Transition",
  downswing: "Downswing",
  impact: "Impact",
  follow_through: "Follow-Through",
};

/** Conditional severity badge: red for major, amber for minor. */
function SeverityBadge({ severity }: { severity: DeficiencySeverity }) {
  const isMajor = severity === "major";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
        isMajor
          ? "text-red-400 bg-red-500/10 border-red-500/30"
          : "text-amber-400 bg-amber-400/10 border-amber-400/30"
      }`}
    >
      {isMajor ? <ShieldAlert size={10} /> : <AlertTriangle size={10} />}
      {isMajor ? "Major Fault" : "Minor"}
    </span>
  );
}

/** Visual callout box showcasing the recommended fix drill. */
function FixDrillCallout({
  title,
  detail,
  locked,
}: {
  title: string;
  detail?: string | null;
  locked?: boolean;
}) {
  if (locked) {
    return (
      <div className="mt-3 flex items-center gap-2 bg-amber-400/5 border border-amber-400/20 rounded-2xl px-3 py-2.5">
        <Lock size={12} className="text-amber-400 shrink-0" />
        <p className="text-[10px] text-gray-400">
          <span className="text-amber-400 font-black">Eagle</span> unlocks the
          guided fix drill for this fault.
        </p>
        <Link
          href="/upgrade"
          className="ml-auto text-[9px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 whitespace-nowrap"
        >
          Upgrade →
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-3 bg-golf-green/[0.06] border border-golf-green/25 rounded-2xl p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-6 h-6 rounded-lg bg-golf-green/15 border border-golf-green/30 flex items-center justify-center shrink-0">
          <Wrench size={12} className="text-golf-green" />
        </div>
        <p className="text-[9px] font-black uppercase tracking-widest text-golf-green">
          Recommended Fix Drill
        </p>
      </div>
      <p className="text-sm text-white font-bold leading-snug">{title}</p>
      {detail && (
        <p className="text-xs text-gray-400 leading-relaxed mt-1">{detail}</p>
      )}
    </div>
  );
}

export function MechanicalDeficienciesPanel({
  tier,
  deficiencies,
  isLoading = false,
}: MechanicalDeficienciesPanelProps) {
  // The deficiency audit is a Birdie+ feature; the guided fix drills are
  // reserved for the ultra-deep tier (Eagle / Coach Pro).
  const hasAccess = canUseLaunchMonitor(tier);
  const canSeeDrills = canUseUltraDeepAnalysis(tier);

  if (!hasAccess) {
    return (
      <div className="bg-black/40 border border-white/5 rounded-5xl overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/60 to-black/90 z-10" />
        <div className="p-8 blur-sm pointer-events-none select-none space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="bg-white/5 rounded-3xl h-24" />
          ))}
        </div>
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-12 h-12 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center justify-center mb-4">
            <Lock size={20} className="text-red-400" />
          </div>
          <p className="font-black italic tracking-tighter text-white uppercase text-lg mb-1">
            Mechanical Deficiencies
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4">
            Birdie &amp; Eagle
          </p>
          <p className="text-xs text-gray-500 max-w-xs leading-relaxed mb-5">
            A joint-by-joint fault audit with severity grading and the exact drills
            to fix each one.
          </p>
          <Link
            href="/upgrade"
            className="px-6 py-3 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] hover:bg-[#22C55E] transition-all"
          >
            Upgrade to Birdie
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-5xl p-8 animate-pulse space-y-4">
        <div className="h-4 w-48 bg-white/5 rounded" />
        {[1, 2].map((i) => (
          <div key={i} className="h-24 bg-white/5 rounded-3xl" />
        ))}
      </div>
    );
  }

  if (!deficiencies || deficiencies.length === 0) {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-5xl p-8">
        <div className="flex items-center gap-2 mb-4">
          <Crosshair size={16} className="text-red-400" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">
            Mechanical Deficiencies
          </p>
        </div>
        <div className="text-center py-8">
          <Target size={28} className="text-gray-700 mx-auto mb-3" />
          <p className="text-[10px] font-mono uppercase tracking-widest text-gray-600">
            No faults flagged — or analysis still processing
          </p>
        </div>
      </div>
    );
  }

  const majorCount = deficiencies.filter((d) => d.severity === "major").length;

  return (
    <div className="bg-golf-surface border border-white/5 rounded-5xl p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Crosshair size={16} className="text-red-400" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">
            Mechanical Deficiencies
          </p>
        </div>
        <div className="flex items-center gap-2">
          {majorCount > 0 && (
            <span className="text-[9px] font-black uppercase tracking-widest text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-0.5 rounded-full">
              {majorCount} Major
            </span>
          )}
          <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">
            {deficiencies.length} Flagged
          </span>
        </div>
      </div>

      <div className="space-y-4">
        {deficiencies.map((d, i) => (
          <div
            key={`${d.checkpoint}-${i}`}
            className={`rounded-3xl p-5 border ${
              d.severity === "major"
                ? "bg-red-500/[0.04] border-red-500/20"
                : "bg-amber-400/[0.03] border-amber-400/15"
            }`}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">
                {CHECKPOINT_LABEL[d.checkpoint] ?? d.checkpoint}
                <span className="text-gray-600"> · {d.joint_coordinate.joint}</span>
              </span>
              <SeverityBadge severity={d.severity} />
            </div>

            <p className="text-sm text-white leading-relaxed">
              {d.fault_description}
            </p>

            <FixDrillCallout
              title={d.corrective_drill_title}
              detail={d.corrective_drill_detail}
              locked={!canSeeDrills}
            />
          </div>
        ))}
      </div>

      {!canSeeDrills && (
        <div className="mt-5 flex items-center justify-between bg-amber-400/5 border border-amber-400/20 rounded-2xl px-4 py-3">
          <p className="text-[10px] text-gray-400">
            <span className="text-amber-400 font-black">Eagle</span> — Unlock the
            full guided fix drill for every fault above.
          </p>
          <Link
            href="/upgrade"
            className="text-[9px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 whitespace-nowrap ml-3"
          >
            Upgrade →
          </Link>
        </div>
      )}
    </div>
  );
}
