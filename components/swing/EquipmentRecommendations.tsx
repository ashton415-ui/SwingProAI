/**
 * swingmaster-web/components/swing/EquipmentRecommendations.tsx
 * AI Equipment Recommendations panel.
 * - Par tier → locked premium preview banner
 * - Birdie/Eagle → full custom club & shaft suggestions
 */

'use client';

import type { EquipmentFitting, PlanTier } from '@/lib/types/swing';

interface Props {
  fitting: EquipmentFitting | null;
  tier: PlanTier;
}

export function EquipmentRecommendations({ fitting, tier }: Props) {
  const isLocked = tier === 'par';

  return (
    <section
      aria-labelledby="equipment-heading"
      className="relative rounded-2xl border border-violet-800/40 bg-violet-950/20 p-6"
    >
      {/* Lock overlay for Par users */}
      {isLocked && <LockedOverlay />}

      {/* Header */}
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500/20 text-violet-400">
          <ClubIcon />
        </span>
        <div>
          <h2
            id="equipment-heading"
            className="font-display text-lg font-semibold tracking-tight text-violet-300"
          >
            AI Equipment Recommendations
          </h2>
          <p className="text-xs text-violet-500/70">
            Birdie &amp; Eagle — Shaft fitting &amp; club specs
          </p>
        </div>
        <TierBadge tier={tier} />
      </div>

      {/* Content */}
      {fitting && !isLocked ? (
        <FittingContent fitting={fitting} />
      ) : (
        <PlaceholderCards />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FittingContent({ fitting }: { fitting: EquipmentFitting }) {
  const cards = [
    {
      title: 'Recommended Shaft Flex',
      value: fitting.recommended_shaft_flex,
      detail: fitting.shaft_reasoning,
      color: 'violet',
    },
    {
      title: 'Club Specifications',
      value: 'Custom Spec',
      detail: fitting.suggested_club_specs,
      color: 'violet',
    },
    {
      title: 'Ball Compression',
      value: 'Matched to Speed',
      detail: fitting.compression_match_notes,
      color: 'violet',
    },
  ] as const;

  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <div
          key={card.title}
          className="rounded-xl border border-violet-700/30 bg-violet-900/20 p-4"
        >
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-violet-500">
            {card.title}
          </p>
          <p className="mb-2 text-base font-semibold text-violet-100">{card.value}</p>
          <p className="text-sm leading-relaxed text-violet-200/70">{card.detail}</p>
        </div>
      ))}
    </div>
  );
}

function PlaceholderCards() {
  return (
    <div className="space-y-3 opacity-40 blur-[2px] select-none" aria-hidden>
      {['Shaft Flex Analysis', 'Club Specifications', 'Ball Compression'].map((title) => (
        <div
          key={title}
          className="h-20 rounded-xl border border-violet-700/30 bg-violet-900/20 p-4"
        >
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-violet-500">{title}</p>
          <div className="h-3 w-3/4 rounded bg-violet-700/40" />
        </div>
      ))}
    </div>
  );
}

function LockedOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-slate-950/80 backdrop-blur-[3px]">
      <div className="mx-auto max-w-xs px-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-500/20">
          <LockIcon />
        </div>
        <h3 className="mb-1 font-display text-base font-semibold text-violet-200">
          Birdie &amp; Eagle Feature
        </h3>
        <p className="mb-4 text-sm leading-snug text-slate-400">
          Upgrade to unlock AI-generated shaft flex, club spec, and ball compression
          recommendations custom-matched to your swing speed and mechanics.
        </p>
        <a
          href="/dashboard/upgrade"
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500"
        >
          Upgrade Plan
          <ArrowRightIcon />
        </a>
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: PlanTier }) {
  const styles: Record<PlanTier, string> = {
    par: 'bg-slate-700/40 text-slate-400 ring-slate-600/30',
    birdie: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
    eagle: 'bg-violet-500/10 text-violet-300 ring-violet-500/30',
  };
  return (
    <span
      className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${styles[tier]}`}
    >
      {tier.charAt(0).toUpperCase() + tier.slice(1)}
    </span>
  );
}

// Icons
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
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
