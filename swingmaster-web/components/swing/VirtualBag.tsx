'use client';

import { useState } from 'react';
import {
  Target,
  Zap,
  Activity,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Star,
  Wind,
} from 'lucide-react';

// ── Types (mirror Python Pydantic models) ────────────────────────────────────

export type ClubType = 'Driver' | 'Wood' | 'Hybrid' | 'Iron' | 'Wedge' | 'Putter';

export interface ClubRecord {
  id: string;
  club_type: ClubType;
  brand: string | null;
  model: string | null;
  shaft_flex: string | null;
  shaft_weight: number | null;
  loft_deg: number | null;
  custom_club: boolean;
  custom_brand: string | null;
  custom_model: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface TelemetryStat {
  swing_speed_mph: number | null;
  ball_speed_mph: number | null;
  smash_factor: number | null;
  launch_angle_deg: number | null;
  carry_yards: number | null;
  smash_factor_rating: 'excellent' | 'good' | 'average' | 'poor' | '';
  swing_speed_category: 'tour' | 'advanced' | 'average' | 'beginner' | '';
}

export interface VirtualBagProps {
  clubs: ClubRecord[];
  /** Latest telemetry keyed by club ID */
  telemetry?: Record<string, TelemetryStat>;
  onAddClub?: () => void;
  onRemoveClub?: (clubId: string) => void;
  onGetFitting?: (clubId: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CLUB_ORDER: ClubType[] = ['Driver', 'Wood', 'Hybrid', 'Iron', 'Wedge', 'Putter'];

const SMASH_BADGE: Record<string, string> = {
  excellent: 'text-emerald-400 bg-emerald-400/10 ring-emerald-400/20',
  good: 'text-green-400 bg-green-400/10 ring-green-400/20',
  average: 'text-yellow-400 bg-yellow-400/10 ring-yellow-400/20',
  poor: 'text-red-400 bg-red-400/10 ring-red-400/20',
};

const SPEED_COLOR: Record<string, string> = {
  tour: 'text-purple-400',
  advanced: 'text-blue-400',
  average: 'text-sky-400',
  beginner: 'text-slate-400',
};

const TYPE_ACCENT: Record<ClubType, string> = {
  Driver: 'text-violet-400',
  Wood: 'text-blue-400',
  Hybrid: 'text-cyan-400',
  Iron: 'text-emerald-400',
  Wedge: 'text-amber-400',
  Putter: 'text-rose-400',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clubDisplayName(club: ClubRecord): string {
  if (club.custom_club) {
    const brand = club.custom_brand ?? club.brand ?? 'Custom';
    const model = club.custom_model ?? club.model ?? '';
    return `${brand} ${model}`.trim();
  }
  const name = `${club.brand ?? ''} ${club.model ?? ''}`.trim();
  return name || club.club_type;
}

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SmashBadge({ rating }: { rating: string }) {
  if (!rating) return null;
  const cls = SMASH_BADGE[rating] ?? 'text-slate-400 bg-slate-400/10 ring-slate-400/20';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ring-1 ${cls}`}>
      {rating}
    </span>
  );
}

function StatPill({ label, value, colorClass = 'text-slate-300' }: { label: string; value: string; colorClass?: string }) {
  return (
    <div className="text-right">
      <div className={`text-sm font-semibold tabular-nums ${colorClass}`}>{value}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function ClubRow({
  club,
  stat,
  onRemove,
  onFitting,
}: {
  club: ClubRecord;
  stat?: TelemetryStat;
  onRemove?: () => void;
  onFitting?: () => void;
}) {
  const accentClass = TYPE_ACCENT[club.club_type];

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors rounded-xl group">
      {/* Type icon */}
      <div className="shrink-0 w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center">
        <Target className={`w-3.5 h-3.5 ${accentClass}`} />
      </div>

      {/* Club identity */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-white truncate leading-tight">
            {clubDisplayName(club)}
          </span>
          {club.is_primary && (
            <Star className="w-3 h-3 text-amber-400 shrink-0 fill-amber-400" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {club.shaft_flex && (
            <span className="text-[11px] text-slate-500">{club.shaft_flex} flex</span>
          )}
          {club.loft_deg != null && (
            <span className="text-[11px] text-slate-600">{club.loft_deg}°</span>
          )}
          {club.shaft_weight != null && (
            <span className="text-[11px] text-slate-600">{club.shaft_weight}g</span>
          )}
        </div>
      </div>

      {/* Telemetry stats */}
      {stat ? (
        <div className="flex items-center gap-4 shrink-0">
          {stat.swing_speed_mph != null && (
            <StatPill
              label="swing"
              value={`${fmt(stat.swing_speed_mph)} mph`}
              colorClass={SPEED_COLOR[stat.swing_speed_category] ?? 'text-slate-300'}
            />
          )}
          {stat.carry_yards != null && (
            <StatPill label="carry" value={`${fmt(stat.carry_yards)} yds`} />
          )}
          {stat.smash_factor_rating && (
            <SmashBadge rating={stat.smash_factor_rating} />
          )}
        </div>
      ) : (
        <span className="text-xs text-slate-600 italic shrink-0">No data</span>
      )}

      {/* Hover actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-1">
        {onFitting && (
          <button
            onClick={onFitting}
            title="AI shaft fitting"
            className="flex items-center gap-1 px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Zap className="w-3 h-3" />
            <span className="hidden sm:inline">Fit</span>
          </button>
        )}
        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove from bag"
            className="p-1.5 text-slate-600 hover:text-red-400 transition-colors rounded-lg hover:bg-red-400/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VirtualBag({
  clubs,
  telemetry = {},
  onAddClub,
  onRemoveClub,
  onGetFitting,
}: VirtualBagProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<ClubType>>(new Set());

  const grouped = CLUB_ORDER.reduce<Record<string, ClubRecord[]>>((acc, type) => {
    const group = clubs.filter((c) => c.club_type === type);
    if (group.length > 0) acc[type] = group;
    return acc;
  }, {});

  function toggleGroup(type: ClubType) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const totalClubs = clubs.length;
  const trackedCount = clubs.filter((c) => !!telemetry[c.id]).length;

  return (
    <div className="bg-slate-900 rounded-2xl border border-white/10 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
        <div>
          <h2 className="text-base font-semibold text-white tracking-tight">Virtual Bag</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {totalClubs} club{totalClubs !== 1 ? 's' : ''} · {trackedCount} tracked
          </p>
        </div>
        <div className="flex items-center gap-3">
          {totalClubs > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
              <Activity className="w-3.5 h-3.5" />
              <span>{trackedCount}/{totalClubs}</span>
            </div>
          )}
          {onAddClub && (
            <button
              onClick={onAddClub}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Club
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {totalClubs === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
            <Wind className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-sm font-medium text-slate-300">Your bag is empty</p>
          <p className="text-xs text-slate-500 mt-1 max-w-xs">
            Add clubs to track per-club telemetry and unlock AI shaft fitting recommendations.
          </p>
          {onAddClub && (
            <button
              onClick={onAddClub}
              className="mt-5 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add First Club
            </button>
          )}
        </div>
      ) : (
        /* Club groups */
        <div className="divide-y divide-white/[0.06]">
          {Object.entries(grouped).map(([type, typeClubs]) => {
            const clubType = type as ClubType;
            const collapsed = collapsedGroups.has(clubType);
            const groupTracked = typeClubs.filter((c) => !!telemetry[c.id]).length;

            return (
              <div key={type}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(clubType)}
                  className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-white/[0.03] transition-colors text-left"
                >
                  {collapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-600" />
                  )}
                  <span className={`text-xs font-semibold uppercase tracking-widest ${TYPE_ACCENT[clubType]}`}>
                    {type}
                  </span>
                  <span className="text-xs text-slate-600 ml-0.5">
                    {typeClubs.length} · {groupTracked} tracked
                  </span>
                </button>

                {/* Club rows */}
                {!collapsed && (
                  <div className="px-2 pb-2">
                    {typeClubs.map((club) => (
                      <ClubRow
                        key={club.id}
                        club={club}
                        stat={telemetry[club.id]}
                        onRemove={onRemoveClub ? () => onRemoveClub(club.id) : undefined}
                        onFitting={onGetFitting ? () => onGetFitting(club.id) : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer summary (only when clubs exist and some are tracked) */}
      {totalClubs > 0 && trackedCount > 0 && (() => {
        const tracked = clubs.filter((c) => telemetry[c.id]);
        const speeds = tracked.map((c) => telemetry[c.id]?.swing_speed_mph).filter((s): s is number => s != null);
        const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;

        return (
          <div className="border-t border-white/10 px-5 py-3 flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Bag avg swing speed</span>
            </div>
            <span className="text-sm font-semibold text-white tabular-nums">
              {avgSpeed != null ? `${avgSpeed.toFixed(1)} mph` : '—'}
            </span>
          </div>
        );
      })()}
    </div>
  );
}
