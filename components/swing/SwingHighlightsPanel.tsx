"use client";

import Link from "next/link";
import { CheckCircle2, Lock, Sparkles, Trophy } from "lucide-react";
import type { HighlightItem } from "@/types/database";
import type { SubscriptionTier } from "@/lib/entitlements";
import { canUseLaunchMonitor } from "@/lib/entitlements";

interface SwingHighlightsPanelProps {
  tier: SubscriptionTier;
  highlights?: HighlightItem[] | null;
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

/** Green "success ring" — a circular badge reinforcing a nailed checkpoint. */
function SuccessRing() {
  return (
    <div className="relative shrink-0">
      <div className="absolute inset-0 rounded-full bg-golf-green/20 blur-md" />
      <div className="relative w-11 h-11 rounded-full border-2 border-golf-green/40 bg-golf-green/10 flex items-center justify-center">
        <CheckCircle2 size={18} className="text-golf-green" />
      </div>
    </div>
  );
}

export function SwingHighlightsPanel({
  tier,
  highlights,
  isLoading = false,
}: SwingHighlightsPanelProps) {
  // Highlights reinforce good habits — unlocked for Birdie+ (same gate as launch monitor).
  const hasAccess = canUseLaunchMonitor(tier);

  if (!hasAccess) {
    return (
      <div className="bg-black/40 border border-white/5 rounded-5xl overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/60 to-black/90 z-10" />
        <div className="p-8 blur-sm pointer-events-none select-none space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="w-11 h-11 rounded-full bg-white/5" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 bg-white/5 rounded-full" />
                <div className="h-2 w-48 bg-white/5 rounded-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-12 h-12 bg-golf-green/10 border border-golf-green/20 rounded-2xl flex items-center justify-center mb-4">
            <Lock size={20} className="text-golf-green" />
          </div>
          <p className="font-black italic tracking-tighter text-white uppercase text-lg mb-1">
            Swing Highlights
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4">
            Birdie &amp; Eagle
          </p>
          <p className="text-xs text-gray-500 max-w-xs leading-relaxed mb-5">
            See exactly what you nailed — joint-by-joint reinforcement of the good
            habits worth protecting.
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
        <div className="h-4 w-40 bg-white/5 rounded" />
        {[1, 2].map((i) => (
          <div key={i} className="h-16 bg-white/5 rounded-3xl" />
        ))}
      </div>
    );
  }

  if (!highlights || highlights.length === 0) {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-5xl p-8">
        <div className="flex items-center gap-2 mb-4">
          <Trophy size={16} className="text-golf-green" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">
            Swing Highlights
          </p>
        </div>
        <div className="text-center py-8">
          <Sparkles size={28} className="text-gray-700 mx-auto mb-3" />
          <p className="text-[10px] font-mono uppercase tracking-widest text-gray-600">
            Highlights appear once AI analysis completes
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-golf-surface border border-white/5 rounded-5xl p-8 relative overflow-hidden">
      <div className="absolute top-0 right-0 p-6 opacity-5">
        <Trophy className="w-24 h-24 text-golf-green" />
      </div>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Trophy size={16} className="text-golf-green" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">
            Swing Highlights
          </p>
        </div>
        <span className="text-[9px] font-black uppercase tracking-widest text-golf-green bg-golf-green/10 border border-golf-green/20 px-2 py-0.5 rounded-full">
          {highlights.length} Nailed
        </span>
      </div>

      <div className="space-y-3">
        {highlights.map((h, i) => (
          <div
            key={`${h.checkpoint}-${i}`}
            className="flex items-start gap-4 bg-golf-green/[0.04] border border-golf-green/15 rounded-3xl p-4"
          >
            <SuccessRing />
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-golf-green">
                  {CHECKPOINT_LABEL[h.checkpoint] ?? h.checkpoint}
                </span>
              </div>
              <p className="text-sm text-white font-semibold leading-snug">
                {h.positive_movement}
              </p>
              <p className="text-xs text-gray-400 leading-relaxed mt-1">
                {h.mechanical_benefit}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
