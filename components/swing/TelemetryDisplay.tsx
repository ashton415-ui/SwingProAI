'use client';

/**
 * swingmaster-web/components/swing/TelemetryDisplay.tsx
 * Renders Swing Speed, Ball Speed, and Smash Factor.
 * Visual UI states distinguish 'video_ai' vs 'launch_monitor' source.
 * Advanced shaft metrics and AI fitting gated to Birdie/Eagle tiers.
 */

import { Zap, Radio, Activity, Lock, TrendingUp } from 'lucide-react';
import type { SubscriptionTier } from '@/types/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TelemetrySource = 'video_ai' | 'launch_monitor';

interface TelemetryData {
  swing_speed_mph: number | null;
  ball_speed_mph: number | null;
  smash_factor: number | null;
  launch_angle_deg?: number | null;
  spin_rate_rpm?: number | null;
  carry_yards?: number | null;
  telemetry_source: TelemetrySource;
  smash_factor_rating?: string;
  swing_speed_category?: string;
}

interface FittingData {
  summary: string;
  needs_upgrade: boolean;
  upgrade_urgency: string;
  shaft_recommendation?: {
    recommended_flex: string;
    recommended_weight_range: string;
    gemini_narrative: string | null;
    rule_triggered: string;
    confidence: string;
  } | null;
}

interface Props {
  telemetry: TelemetryData;
  fitting?: FittingData | null;
  tier: SubscriptionTier;
}

const PREMIUM_TIERS: SubscriptionTier[] = ['birdie', 'eagle', 'coach_starter', 'coach_pro'];

// ---------------------------------------------------------------------------
// Source config
// ---------------------------------------------------------------------------

const SOURCE_CONFIG = {
  video_ai: {
    label: 'Video AI',
    sublabel: 'Estimated from swing footage',
    icon: <Activity size={12} />,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    badge: 'bg-violet-500/10 text-violet-400',
  },
  launch_monitor: {
    label: 'Launch Monitor',
    sublabel: 'Measured hardware data',
    icon: <Radio size={12} />,
    color: 'text-golf-green',
    bg: 'bg-golf-green/10',
    border: 'border-golf-green/20',
    badge: 'bg-golf-green/10 text-golf-green',
  },
};

// ---------------------------------------------------------------------------
// Smash factor color
// ---------------------------------------------------------------------------

function smashColor(rating: string | undefined): string {
  switch (rating) {
    case 'excellent': return 'text-golf-green';
    case 'good': return 'text-emerald-400';
    case 'average': return 'text-amber-400';
    case 'poor': return 'text-red-400';
    default: return 'text-white';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TelemetryDisplay({ telemetry, fitting, tier }: Props) {
  const isPremium = PREMIUM_TIERS.includes(tier);
  const src = SOURCE_CONFIG[telemetry.telemetry_source];

  return (
    <div className="space-y-4">
      {/* Source indicator */}
      <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 w-fit ${src.border} ${src.bg}`}>
        <span className={src.color}>{src.icon}</span>
        <span className={`text-[9px] font-black uppercase tracking-widest ${src.color}`}>{src.label}</span>
        <span className="text-[9px] text-gray-500">{src.sublabel}</span>
      </div>

      {/* Primary metrics grid */}
      <div className="grid grid-cols-3 gap-3">
        <MetricCard
          label="Swing Speed"
          value={telemetry.swing_speed_mph}
          unit="mph"
          ideal="90–110"
          idealUnit="mph"
          badge={telemetry.swing_speed_category}
          source={telemetry.telemetry_source}
        />
        <MetricCard
          label="Ball Speed"
          value={telemetry.ball_speed_mph}
          unit="mph"
          ideal="130–165"
          idealUnit="mph"
          source={telemetry.telemetry_source}
        />
        <MetricCard
          label="Smash Factor"
          value={telemetry.smash_factor}
          unit=""
          ideal="1.44–1.50"
          idealUnit=""
          valueColor={smashColor(telemetry.smash_factor_rating)}
          badge={telemetry.smash_factor_rating}
          source={telemetry.telemetry_source}
          decimals={3}
        />
      </div>

      {/* Secondary metrics */}
      {(telemetry.launch_angle_deg != null || telemetry.spin_rate_rpm != null || telemetry.carry_yards != null) && (
        <div className="grid grid-cols-3 gap-3">
          {telemetry.launch_angle_deg != null && (
            <MetricCard label="Launch Angle" value={telemetry.launch_angle_deg} unit="°" ideal="10–14°" idealUnit="" source={telemetry.telemetry_source} decimals={1} />
          )}
          {telemetry.spin_rate_rpm != null && (
            <MetricCard label="Spin Rate" value={telemetry.spin_rate_rpm} unit="rpm" ideal="2000–2800" idealUnit="rpm" source={telemetry.telemetry_source} decimals={0} />
          )}
          {telemetry.carry_yards != null && (
            <MetricCard label="Carry" value={telemetry.carry_yards} unit="yds" ideal="250–300" idealUnit="yds" source={telemetry.telemetry_source} decimals={0} />
          )}
        </div>
      )}

      {/* AI Fitting panel */}
      <FittingPanel fitting={fitting} isPremium={isPremium} tier={tier} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetricCard
// ---------------------------------------------------------------------------

function MetricCard({
  label, value, unit, ideal, idealUnit, badge, valueColor, source, decimals = 1,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  ideal: string;
  idealUnit: string;
  badge?: string;
  valueColor?: string;
  source: TelemetrySource;
  decimals?: number;
}) {
  const isVideoAI = source === 'video_ai';
  const displayValue = value != null
    ? decimals === 0 ? Math.round(value).toString() : value.toFixed(decimals)
    : '—';

  return (
    <div className="rounded-4xl border border-white/5 bg-golf-surface p-4">
      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">{label}</p>
      <p className={`text-2xl font-mono font-black italic tracking-tighter ${valueColor || 'text-white'}`}>
        {displayValue}{value != null ? unit : ''}
      </p>
      <p className="text-[9px] text-golf-green font-bold uppercase mt-1 tracking-widest">
        Ideal: {ideal}{idealUnit ? ` ${idealUnit}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {isVideoAI && (
          <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[8px] font-bold text-violet-400 uppercase">Est.</span>
        )}
        {badge && (
          <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase ${smashColor(badge)} bg-white/5`}>
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FittingPanel — gated
// ---------------------------------------------------------------------------

function FittingPanel({ fitting, isPremium, tier }: { fitting?: FittingData | null; isPremium: boolean; tier: SubscriptionTier }) {
  if (!isPremium) {
    return (
      <div className="relative rounded-4xl border border-white/5 bg-golf-surface p-5 overflow-hidden">
        {/* Blurred preview */}
        <div className="blur-[3px] opacity-40 select-none pointer-events-none space-y-2">
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-400">AI Shaft Fitting</p>
          <p className="text-sm text-white">Your swing speed suggests a Stiff flex upgrade would add 8–12 yards.</p>
          <p className="text-xs text-gray-400">Switch from Regular to Stiff shaft for optimal energy transfer at your swing speed.</p>
        </div>
        {/* Lock overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] rounded-4xl">
          <Lock size={16} className="text-violet-400 mb-2" />
          <p className="text-[9px] font-black uppercase tracking-widest text-violet-300 mb-1">Birdie & Eagle</p>
          <p className="text-[9px] text-gray-400 text-center max-w-xs">AI shaft fitting recommendations require a Birdie or Eagle subscription.</p>
          <a href="/upgrade" className="mt-3 rounded-full bg-violet-600 px-4 py-1.5 text-[9px] font-black uppercase tracking-widest text-white hover:bg-violet-500 transition-colors">
            Upgrade Plan
          </a>
        </div>
      </div>
    );
  }

  if (!fitting) return null;

  const urgencyColor = {
    immediate: 'text-red-400 border-red-500/30 bg-red-500/5',
    recommended: 'text-amber-400 border-amber-500/30 bg-amber-500/5',
    optional: 'text-sky-400 border-sky-500/30 bg-sky-500/5',
    none: 'text-golf-green border-golf-green/20 bg-golf-green/5',
  }[fitting.upgrade_urgency] ?? 'text-gray-400 border-white/10 bg-white/5';

  return (
    <div className={`rounded-4xl border p-5 space-y-3 ${urgencyColor}`}>
      <div className="flex items-center gap-2">
        <TrendingUp size={14} />
        <p className="text-[9px] font-black uppercase tracking-widest">AI Shaft Fitting</p>
      </div>

      <p className="text-sm font-bold text-white">{fitting.summary}</p>

      {fitting.shaft_recommendation && (
        <div className="space-y-2">
          <div className="flex gap-3">
            <div className="rounded-3xl bg-white/5 px-3 py-2 text-center">
              <p className="text-[8px] uppercase tracking-widest text-gray-500">Recommended</p>
              <p className="text-lg font-black text-white">{fitting.shaft_recommendation.recommended_flex}</p>
              <p className="text-[8px] text-gray-500">{fitting.shaft_recommendation.recommended_weight_range}</p>
            </div>
            <div className="flex-1">
              <p className="text-[8px] uppercase tracking-widest text-gray-500 mb-1">Basis</p>
              <p className="text-xs text-gray-300">{fitting.shaft_recommendation.rule_triggered}</p>
            </div>
          </div>

          {fitting.shaft_recommendation.gemini_narrative && (
            <div className="rounded-3xl border border-white/5 bg-black/20 p-3">
              <p className="text-[8px] font-black uppercase tracking-widest text-golf-green mb-1 flex items-center gap-1">
                <Zap size={8} /> AI Analysis
              </p>
              <p className="text-xs leading-relaxed text-gray-300">
                {fitting.shaft_recommendation.gemini_narrative}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
