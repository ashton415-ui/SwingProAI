'use client';

/**
 * components/swing/EquipmentRecommendations.tsx
 * AI Equipment Recommendations panel.
 * - Par / none tier  → locked premium preview banner
 * - Birdie / Eagle / Coach tiers → full custom club & shaft suggestions
 */

import type { SubscriptionTier } from "@/types/database";
import type { EquipmentFitting } from "@/lib/types/swing";

interface Props {
  fitting: EquipmentFitting | null;
  tier: SubscriptionTier;
}

const PREMIUM_TIERS: SubscriptionTier[] = ["birdie", "eagle", "coach_starter", "coach_pro"];

export function EquipmentRecommendations({ fitting, tier }: Props) {
  const isLocked = !PREMIUM_TIERS.includes(tier);

  return (
    <section
      aria-labelledby="equipment-heading"
      className="relative bg-golf-surface border border-white/5 rounded-5xl p-8 overflow-hidden"
    >
      {isLocked && <LockedOverlay />}

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500/20 text-violet-400">
          <ClubIcon />
        </span>
        <div>
          <h2
            id="equipment-heading"
            className="text-[10px] font-black text-violet-400 uppercase tracking-[0.2em]"
          >
            AI Equipment Recommendations
          </h2>
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mt-0.5">
            Birdie &amp; Eagle — Shaft fitting &amp; club specs
          </p>
        </div>
        <TierBadge tier={tier} />
      </div>

      {fitting && !isLocked ? (
        <FittingContent fitting={fitting} />
      ) : (
        <PlaceholderCards />
      )}
    </section>
  );
}

function FittingContent({ fitting }: { fitting: EquipmentFitting }) {
  const cards = [
    { title: "Recommended Shaft Flex", value: fitting.recommended_shaft_flex, detail: fitting.shaft_reasoning },
    { title: "Club Specifications", value: "Custom Spec", detail: fitting.suggested_club_specs },
    { title: "Ball Compression", value: "Matched to Speed", detail: fitting.compression_match_notes },
  ];

  return (
    <div className="space-y-4">
      {cards.map((card) => (
        <div key={card.title} className="rounded-4xl border border-violet-700/20 bg-violet-900/10 p-5">
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-500 mb-1">{card.title}</p>
          <p className="text-base font-black text-white mb-2">{card.value}</p>
          <p className="text-sm leading-relaxed text-gray-400">{card.detail}</p>
        </div>
      ))}
    </div>
  );
}

function PlaceholderCards() {
  return (
    <div className="space-y-4 opacity-40 blur-[2px] select-none pointer-events-none" aria-hidden>
      {["Shaft Flex Analysis", "Club Specifications", "Ball Compression"].map((title) => (
        <div key={title} className="h-20 rounded-4xl border border-violet-700/20 bg-violet-900/10 p-5">
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-500 mb-2">{title}</p>
          <div className="h-3 w-3/4 rounded bg-violet-700/30" />
        </div>
      ))}
    </div>
  );
}

function LockedOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-5xl bg-black/70 backdrop-blur-[4px]">
      <div className="mx-auto max-w-xs px-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-violet-500/20">
          <LockIcon />
        </div>
        <h3 className="mb-2 text-sm font-black uppercase tracking-widest text-violet-300">
          Birdie &amp; Eagle Feature
        </h3>
        <p className="mb-5 text-xs leading-relaxed text-gray-400">
          Upgrade to unlock AI-generated shaft flex, club spec, and ball compression
          recommendations matched to your swing speed and mechanics.
        </p>
        <a
          href="/upgrade"
          className="inline-flex items-center gap-2 rounded-full bg-violet-600 px-5 py-2 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-violet-500"
        >
          Upgrade Plan <ArrowRightIcon />
        </a>
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: SubscriptionTier }) {
  const styles: Partial<Record<SubscriptionTier, string>> = {
    par: "bg-white/5 text-gray-500",
    none: "bg-white/5 text-gray-500",
    birdie: "bg-amber-500/10 text-amber-400",
    eagle: "bg-violet-500/10 text-violet-300",
    coach_starter: "bg-sky-500/10 text-sky-400",
    coach_pro: "bg-sky-500/10 text-sky-300",
  };
  return (
    <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[9px] font-black uppercase tracking-widest ${styles[tier] ?? "bg-white/5 text-gray-500"}`}>
      {tier.replace("_", " ")}
    </span>
  );
}

function ClubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M12 2L4 10l1 4 4-1 6-8-3-3z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className="text-violet-400">
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.5" fill="currentColor" />
    </svg>
  );
}
function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
