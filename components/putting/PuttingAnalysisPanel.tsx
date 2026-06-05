"use client";

import Link from "next/link";
import { Lock, Activity, Target, BarChart2, Zap, TrendingUp } from "lucide-react";
import type { SubscriptionTier } from "@/lib/entitlements";
import { canUseLaunchMonitor } from "@/lib/entitlements";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PuttingMetrics {
  puttTempoRatio: number | null;        // backswing:through ratio (ideal ~2.0)
  faceAngleAtImpactDeg: number | null;  // degrees open(+) or closed(-) at impact
  pathDeviationMm: number | null;       // mm offline at 10 feet (lower = better)
}

interface GreenReading {
  narrativeSummary?: string;
  slopeDirection?: string;
  recommendedEntry?: string;
}

interface PuttingAnalysisPanelProps {
  tier: SubscriptionTier;
  metrics?: PuttingMetrics;
  greenReading?: GreenReading;
  isLoading?: boolean;
}

// ─── Metric grades ─────────────────────────────────────────────────────────────

function gradeTempo(ratio: number): { label: string; color: string } {
  if (ratio >= 1.8 && ratio <= 2.2) return { label: "Tour-ideal", color: "text-golf-green" };
  if (ratio >= 1.5 && ratio < 1.8) return { label: "Slightly fast", color: "text-amber-400" };
  if (ratio > 2.2 && ratio <= 2.5) return { label: "Slightly slow", color: "text-amber-400" };
  return { label: "Out of rhythm", color: "text-red-400" };
}

function gradeFaceAngle(deg: number): { label: string; color: string } {
  const abs = Math.abs(deg);
  if (abs < 1) return { label: "Square", color: "text-golf-green" };
  if (abs < 2) return { label: deg > 0 ? "Slightly open" : "Slightly closed", color: "text-amber-400" };
  return { label: deg > 0 ? "Open" : "Closed", color: "text-red-400" };
}

function gradePathDeviation(mm: number): { label: string; color: string } {
  if (mm <= 10) return { label: "Excellent", color: "text-golf-green" };
  if (mm <= 20) return { label: "Good", color: "text-golf-green" };
  if (mm <= 35) return { label: "Moderate drift", color: "text-amber-400" };
  return { label: "Significant drift", color: "text-red-400" };
}

// ─── Topography grid (visual only) ─────────────────────────────────────────────

function UndulationGrid({ summary }: { summary?: string }) {
  // 5×5 visual representation of green tilt
  const cells = [
    [0, 1, 2, 1, 0],
    [1, 2, 3, 2, 1],
    [2, 3, 4, 3, 2],
    [1, 2, 3, 2, 1],
    [0, 1, 2, 1, 0],
  ];

  const colors = [
    "bg-blue-900/40",
    "bg-blue-700/40",
    "bg-golf-green/20",
    "bg-amber-500/30",
    "bg-red-500/30",
  ];

  return (
    <div>
      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">
        Green Topography
      </p>
      <div className="grid grid-cols-5 gap-0.5 mb-3 w-full max-w-[180px]">
        {cells.flatMap((row, r) =>
          row.map((val, c) => (
            <div
              key={`${r}-${c}`}
              className={`h-6 rounded-sm ${colors[val]} border border-white/5`}
              title={`Elevation ${val}`}
            />
          ))
        )}
      </div>
      {summary && (
        <p className="text-[10px] text-gray-400 leading-relaxed italic">{summary}</p>
      )}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function PuttingAnalysisPanel({
  tier,
  metrics,
  greenReading,
  isLoading = false,
}: PuttingAnalysisPanelProps) {
  const hasAccess = canUseLaunchMonitor(tier); // Birdie+ unlocks putting analysis

  // ── Locked preview (Par / none) ──
  if (!hasAccess) {
    return (
      <div className="bg-black/40 border border-white/5 rounded-4xl overflow-hidden relative">
        {/* Blurred preview */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/60 to-black/90 z-10" />
        <div className="p-6 blur-sm pointer-events-none select-none">
          <div className="grid grid-cols-3 gap-3 mb-4">
            {["Putt Tempo", "Face Angle", "Path Drift"].map((label) => (
              <div key={label} className="bg-golf-surface rounded-2xl p-4 border border-white/5">
                <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">{label}</p>
                <p className="text-2xl font-mono font-black text-white">—</p>
              </div>
            ))}
          </div>
          <div className="bg-golf-surface rounded-2xl p-4 border border-white/5">
            <div className="grid grid-cols-5 gap-0.5 mb-2">
              {Array.from({ length: 25 }).map((_, i) => (
                <div key={i} className="h-5 rounded-sm bg-white/5" />
              ))}
            </div>
          </div>
        </div>

        {/* Lock overlay */}
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 bg-golf-green/10 border border-golf-green/20 rounded-2xl flex items-center justify-center mb-4">
            <Lock size={20} className="text-golf-green" />
          </div>
          <p className="font-black italic tracking-tighter text-white uppercase text-lg mb-1">
            Putting Analysis
          </p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4">
            Birdie & Eagle
          </p>
          <p className="text-xs text-gray-500 max-w-xs leading-relaxed mb-5">
            Unlock putt tempo ratios, face angle at impact, path deviation tracking, and AI green-reading topography.
          </p>
          <div className="space-y-1.5 mb-6 w-full max-w-xs">
            {["Putt stroke tempo ratio", "Face angle at impact (±°)", "Path deviation at 10ft", "AI green topography maps", "AI caddy aim-line suggestions"].map((f) => (
              <div key={f} className="flex items-center gap-2 text-left">
                <Zap size={10} className="text-golf-green shrink-0" fill="currentColor" />
                <span className="text-[10px] text-gray-400">{f}</span>
              </div>
            ))}
          </div>
          <Link href="/upgrade"
            className="px-6 py-3 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] hover:bg-[#22C55E] transition-all">
            Upgrade to Birdie
          </Link>
        </div>
      </div>
    );
  }

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-32 mb-4" />
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-white/5 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  // ── No data yet ──
  if (!metrics?.puttTempoRatio && !metrics?.faceAngleAtImpactDeg && !metrics?.pathDeviationMm) {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-golf-green" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">Putting Analysis</p>
        </div>
        <div className="text-center py-8">
          <BarChart2 size={28} className="text-gray-700 mx-auto mb-3" />
          <p className="text-[10px] font-mono uppercase tracking-widest text-gray-600">
            Putting data will appear after AI processing
          </p>
          <p className="text-[10px] text-gray-700 mt-1">
            Use the putting module in the mobile app to capture stroke data
          </p>
        </div>
      </div>
    );
  }

  // ── Full paid view ──
  const tempo = metrics.puttTempoRatio;
  const face = metrics.faceAngleAtImpactDeg;
  const path = metrics.pathDeviationMm;

  const tempoGrade = tempo ? gradeTempo(tempo) : null;
  const faceGrade = face !== null && face !== undefined ? gradeFaceAngle(face) : null;
  const pathGrade = path ? gradePathDeviation(path) : null;

  return (
    <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-golf-green" />
          <p className="text-[10px] font-black uppercase tracking-widest text-white">Putting Analysis</p>
        </div>
        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
          tier === "eagle" ? "text-amber-400 bg-amber-400/10 border-amber-400/20" :
          "text-blue-400 bg-blue-500/10 border-blue-500/20"
        }`}>
          {tier === "eagle" ? "Eagle Deep" : "Birdie AI"}
        </span>
      </div>

      {/* Metric grid */}
      <div className="grid grid-cols-3 gap-3">
        {/* Tempo */}
        <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2 flex items-center gap-1">
            <TrendingUp size={10} /> Tempo
          </p>
          <p className={`text-2xl font-mono font-black italic ${tempoGrade?.color ?? "text-gray-500"}`}>
            {tempo?.toFixed(1) ?? "—"}
            <span className="text-[9px] text-gray-600 ml-1">:1</span>
          </p>
          <p className={`text-[9px] font-bold uppercase mt-1 ${tempoGrade?.color ?? "text-gray-600"}`}>
            {tempoGrade?.label ?? "No data"}
          </p>
          <p className="text-[9px] text-gray-700 mt-0.5">Ideal: 2.0 : 1</p>
        </div>

        {/* Face angle */}
        <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2 flex items-center gap-1">
            <Target size={10} /> Face Angle
          </p>
          <p className={`text-2xl font-mono font-black italic ${faceGrade?.color ?? "text-gray-500"}`}>
            {face !== null && face !== undefined
              ? `${face > 0 ? "+" : ""}${face.toFixed(1)}°`
              : "—"}
          </p>
          <p className={`text-[9px] font-bold uppercase mt-1 ${faceGrade?.color ?? "text-gray-600"}`}>
            {faceGrade?.label ?? "No data"}
          </p>
          <p className="text-[9px] text-gray-700 mt-0.5">Ideal: ±0.5°</p>
        </div>

        {/* Path deviation */}
        <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2 flex items-center gap-1">
            <BarChart2 size={10} /> Path Drift
          </p>
          <p className={`text-2xl font-mono font-black italic ${pathGrade?.color ?? "text-gray-500"}`}>
            {path?.toFixed(0) ?? "—"}
            <span className="text-[9px] text-gray-600 ml-1">mm</span>
          </p>
          <p className={`text-[9px] font-bold uppercase mt-1 ${pathGrade?.color ?? "text-gray-600"}`}>
            {pathGrade?.label ?? "No data"}
          </p>
          <p className="text-[9px] text-gray-700 mt-0.5">At 10 feet</p>
        </div>
      </div>

      {/* Green topography — Eagle only */}
      {(tier === "eagle" || tier === "coach_pro") && greenReading && (
        <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
          <UndulationGrid summary={greenReading.narrativeSummary} />
          {greenReading.recommendedEntry && (
            <div className="mt-3 flex items-start gap-2 bg-golf-green/5 border border-golf-green/20 rounded-xl px-3 py-2">
              <Target size={12} className="text-golf-green shrink-0 mt-0.5" />
              <p className="text-[10px] text-gray-300">{greenReading.recommendedEntry}</p>
            </div>
          )}
        </div>
      )}

      {/* Birdie upsell for Eagle features */}
      {tier === "birdie" && (
        <div className="flex items-center justify-between bg-amber-400/5 border border-amber-400/20 rounded-2xl px-4 py-3">
          <p className="text-[10px] text-gray-400">
            <span className="text-amber-400 font-black">Eagle</span> — Green topography maps & AI caddy aim lines
          </p>
          <Link href="/upgrade"
            className="text-[9px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 whitespace-nowrap ml-3">
            Upgrade →
          </Link>
        </div>
      )}
    </div>
  );
}
