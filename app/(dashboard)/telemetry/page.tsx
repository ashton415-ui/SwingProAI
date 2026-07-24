import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Video, Target, CheckCircle2, Clock, AlertCircle, Loader2, Calendar,
  Activity, ArrowUpRight, AlertTriangle, Crosshair, Zap, ChevronRight,
  BarChart3, Cpu, Gauge, Layers, TrendingUp, RotateCcw, BarChart2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BiometricsData {
  spine_angle?:       number;
  hip_rotation?:      number;
  shoulder_rotation?: number;
  tempo_ratio?:       string;
  putting_analysis?:  string;
  the_feel?:          string;
  posture?:           { rating: string; observation: string; correction: string };
  swing_plane?:       { rating: string; observation: string; correction: string };
  impact?:            { rating: string; observation: string; correction: string };
}

interface EquipmentInsight {
  shaftFlex:    { recommendation: string; confidence: "high" | "medium" | "low"; reason: string };
  driverConfig: { recommendation: string; confidence: "high" | "medium" | "low"; reason: string };
  ballSpec:     { recommendation: string; confidence: "high" | "medium" | "low"; reason: string };
  hipSpeedIndex: number | null;   // 0–100 derived proxy
  attackAngleBias: "draw" | "fade" | "neutral" | "unknown";
}

interface SwingLog {
  id:          string;
  created_at:  string;
  status:      string;
  score:       number | null;
  feedback:    string | null;
  club:        string | null;
  filename:    string | null;
  bio:         BiometricsData;
  highlights:  string[];
  deficiencies: string[];
}

interface RangeLog {
  id:              string;
  created_at:      string;
  session_type:    string;
  shots_total:     number;
  shots_executed:  number;
  completion_rate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment Optimizer — pure logic, no API calls
// ─────────────────────────────────────────────────────────────────────────────

function parseTempoNum(s?: string): number | null {
  if (!s) return null;
  const parts = s.split(":").map(Number);
  return parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[1] !== 0
    ? parts[0] / parts[1]
    : null;
}

function computeEquipmentInsight(bio: BiometricsData, score: number | null): EquipmentInsight {
  const { hip_rotation: hip, shoulder_rotation: shoulder, spine_angle: spine, tempo_ratio } = bio;
  const tempo = parseTempoNum(tempo_ratio);

  // ── Hip Speed Index (0–100 proxy) ─────────────────────────────────────────
  // Combines hip rotation magnitude with how quickly it's completed (tempo)
  let hipSpeedIndex: number | null = null;
  if (hip != null && tempo != null) {
    // Hip speed ∝ rotation × (1 / downswing fraction)
    // Normalize: 45° at 3:1 tempo = 50 (average), scale up/down
    hipSpeedIndex = Math.min(100, Math.max(0, Math.round((hip / 45) * (3 / tempo) * 50)));
  } else if (hip != null) {
    hipSpeedIndex = Math.min(100, Math.round((hip / 60) * 70));
  }

  // ── Attack Angle Bias ─────────────────────────────────────────────────────
  // Hips leading shoulders through impact → inside-out (draw bias)
  // Shoulders dominating → outside-in (fade / slice)
  let attackAngleBias: EquipmentInsight["attackAngleBias"] = "unknown";
  if (hip != null && shoulder != null) {
    const ratio = hip / shoulder;
    if (ratio >= 0.55)       attackAngleBias = "draw";
    else if (ratio >= 0.42)  attackAngleBias = "neutral";
    else                     attackAngleBias = "fade";
  }

  // ── Shaft Flex ────────────────────────────────────────────────────────────
  let shaftFlex: EquipmentInsight["shaftFlex"];
  if ((hip != null && hip > 52) || (tempo != null && tempo < 2.4)) {
    shaftFlex = {
      recommendation: "X-Stiff (Tour)",
      confidence: "high",
      reason: `Your hip speed index of ${hipSpeedIndex ?? "—"}/100 and rapid transition (${tempo_ratio ?? "fast"} tempo) generate elite clubhead speed signatures. A stiffer tip section prevents excessive shaft kick timing issues, preserving face angle at impact.`,
    };
  } else if ((hip != null && hip > 44) || (tempo != null && tempo < 2.9)) {
    shaftFlex = {
      recommendation: "Stiff",
      confidence: hip != null && tempo != null ? "high" : "medium",
      reason: `With ${hip != null ? `${hip.toFixed(0)}° of hip clearance` : "above-average hip drive"} and a ${tempo_ratio ?? "efficient"} tempo, your downswing load demands a Stiff flex. Regular shafts will kick too early, promoting a flipping action and loss of distance.`,
    };
  } else if ((hip != null && hip > 35) || (tempo != null && tempo < 3.6)) {
    shaftFlex = {
      recommendation: "Regular",
      confidence: "medium",
      reason: `Your measured rotation and tempo pattern aligns with a Regular-flex shaft. The shaft will load and release in sync with your natural transition timing, maximising the energy transfer to the ball at impact.`,
    };
  } else {
    shaftFlex = {
      recommendation: "Senior / A-Flex",
      confidence: hip != null ? "medium" : "low",
      reason: `${hip != null ? `A hip rotation of ${hip.toFixed(0)}°` : "Your rotation pattern"} and ${tempo_ratio ? `${tempo_ratio} tempo` : "relaxed tempo"} indicate a measured, smooth transition. A softer shaft amplifies the natural whip in your swing and adds carry distance without forcing speed.`,
    };
  }

  // ── Driver Configuration ──────────────────────────────────────────────────
  let driverConfig: EquipmentInsight["driverConfig"];
  const hasGoodHipLead = attackAngleBias === "draw";
  const hasRestrictedHips = hip != null && hip < 38;

  if ((shoulder != null && shoulder > 90) && (hip != null && hip > 45) && hasGoodHipLead) {
    driverConfig = {
      recommendation: "Low-Spin Head · 9–10° Loft",
      confidence: "high",
      reason: `Your ${shoulder?.toFixed(0)}° shoulder turn combined with ${hip?.toFixed(0)}° of hip lead creates a naturally high launch with ample ball speed. A low-spin driver head prevents ballooning and maximises penetrating distance in the wind.`,
    };
  } else if (hasRestrictedHips || attackAngleBias === "fade") {
    driverConfig = {
      recommendation: "Draw-Biased Head · 10.5–11.5° Loft",
      confidence: "medium",
      reason: `${hasRestrictedHips ? `Limited hip clearance (${hip?.toFixed(0)}°)` : "A fade-biased swing path"} suggests the clubhead is approaching from outside the target line. A draw-bias weight setting combined with higher loft softens the fade tendency and adds forgiveness on misses.`,
    };
  } else if (spine != null && spine < 32) {
    driverConfig = {
      recommendation: "Neutral Head · 10.5–12° Loft",
      confidence: "medium",
      reason: `Your upright spine angle (${spine.toFixed(0)}°) creates a steeper attack angle, reducing effective dynamic loft at impact. Extra static loft compensates and ensures you're launching the ball on an optimal 14–17° trajectory.`,
    };
  } else {
    driverConfig = {
      recommendation: "Neutral Head · 10.5° Loft",
      confidence: "medium",
      reason: `Your numbers show a well-balanced setup. A neutral, adjustable driver head gives you the flexibility to dial in loft and lie angle as your swing evolves with practice.`,
    };
  }

  // ── Ball Specification ────────────────────────────────────────────────────
  let ballSpec: EquipmentInsight["ballSpec"];
  const effectiveScore = score ?? 60;

  if (effectiveScore >= 80 || (hipSpeedIndex != null && hipSpeedIndex >= 70)) {
    ballSpec = {
      recommendation: "Tour Performance (90+ compression)",
      confidence: "high",
      reason: `Your swing data signature — ${hipSpeedIndex != null ? `hip speed index ${hipSpeedIndex}/100` : "high rotation"}, ${shoulder != null ? `${shoulder.toFixed(0)}° shoulder turn` : "strong backswing"} — generates the ball speed required to compress a tour-calibre ball fully. A high-compression ball reduces spin divergence and sharpens shot shape control.`,
    };
  } else if (effectiveScore >= 65 || (hipSpeedIndex != null && hipSpeedIndex >= 45)) {
    ballSpec = {
      recommendation: "Mid-Range (75–85 compression)",
      confidence: "medium",
      reason: `Your swing speed and rotation profile sits in the mid-compression sweet spot. These balls offer enough feedback for improvement while providing the distance and control you need to break scoring barriers.`,
    };
  } else {
    ballSpec = {
      recommendation: "Distance / Low Compression",
      confidence: "medium",
      reason: `Optimising for distance at your current swing profile will pay the biggest dividends. A low-compression distance ball maximises carry and reduces the energy lost to under-compression, adding yards without mechanical change.`,
    };
  }

  return { shaftFlex, driverConfig, ballSpec, hipSpeedIndex, attackAngleBias };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function sessionLabel(type: string) {
  const map: Record<string, string> = {
    technical_block: "Technical Block", variable_calibration: "Variable Calibration", simulated_round: "Simulated Round",
  };
  return map[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Status chip
// ─────────────────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  if (status === "complete")   return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-golf-green/10 border border-golf-green/20 text-[9px] font-black uppercase tracking-widest text-golf-green"><CheckCircle2 className="w-2.5 h-2.5" />Complete</span>;
  if (status === "processing") return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400"><Loader2 className="w-2.5 h-2.5 animate-spin" />Processing</span>;
  if (status === "failed")     return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-400/10 border border-red-400/20 text-[9px] font-black uppercase tracking-widest text-red-400"><AlertCircle className="w-2.5 h-2.5" />Failed</span>;
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/10 text-[9px] font-black uppercase tracking-widest text-gray-500"><Clock className="w-2.5 h-2.5" />{status}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric card with range gauge
// ─────────────────────────────────────────────────────────────────────────────

interface MetricCardProps {
  label:      string;
  value:      number | string | undefined;
  unit?:      string;
  min:        number;
  max:        number;
  idealMin:   number;
  idealMax:   number;
  benchmark:  string;
  invert?:    boolean; // lower is better (spine angle: lower = more upright)
}

function metricRating(val: number, idealMin: number, idealMax: number): { label: string; color: string } {
  const margin = (idealMax - idealMin) * 0.2;
  if (val >= idealMin && val <= idealMax)                       return { label: "Ideal",     color: "text-golf-green" };
  if (val >= idealMin - margin && val <= idealMax + margin)     return { label: "Good",      color: "text-golf-green" };
  if (val >= idealMin - margin * 3 && val <= idealMax + margin * 3) return { label: "Average", color: "text-yellow-400" };
  return { label: "Off Range", color: "text-red-400" };
}

function MetricCard({ label, value, unit, min, max, idealMin, idealMax, benchmark }: MetricCardProps) {
  if (value == null) return null;
  const numVal   = typeof value === "number" ? value : parseFloat(String(value));
  const isNum    = !isNaN(numVal);
  const pct      = isNum ? Math.max(0, Math.min(100, ((numVal - min) / (max - min)) * 100)) : null;
  const idealL   = Math.max(0, ((idealMin - min) / (max - min)) * 100);
  const idealW   = Math.min(100 - idealL, ((idealMax - idealMin) / (max - min)) * 100);
  const rating   = isNum ? metricRating(numVal, idealMin, idealMax) : null;

  return (
    <div className="flex-1 min-w-[130px] p-4 rounded-2xl bg-black/40 border border-white/[0.07] flex flex-col gap-2">
      {/* Value */}
      <div className="flex items-end gap-1">
        <span className="text-3xl font-black font-mono text-white leading-none">
          {isNum ? numVal.toFixed(1) : value}
        </span>
        {unit && <span className="text-sm text-gray-500 pb-0.5">{unit}</span>}
      </div>

      {/* Range bar */}
      {pct != null && (
        <div className="relative h-2 rounded-full bg-white/[0.06] overflow-hidden">
          {/* Ideal zone highlight */}
          <div
            className="absolute top-0 h-full rounded-full bg-golf-green/20"
            style={{ left: `${idealL}%`, width: `${idealW}%` }}
          />
          {/* Current value marker */}
          <div
            className="absolute top-0 h-full w-1 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
            style={{ left: `calc(${pct}% - 2px)` }}
          />
        </div>
      )}

      {/* Label row */}
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[9px] font-black uppercase tracking-[0.18em] text-gray-500">{label}</span>
        {rating && (
          <span className={`text-[9px] font-black uppercase tracking-widest ${rating.color}`}>
            {rating.label}
          </span>
        )}
      </div>

      {/* Benchmark */}
      <span className="text-[9px] text-gray-700 leading-tight">{benchmark}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Coach Summary
// ─────────────────────────────────────────────────────────────────────────────

function CoachSummary({ text }: { text: string }) {
  return (
    <div className="relative p-5 rounded-2xl bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/[0.07] overflow-hidden">
      {/* Background watermark quote */}
      <span className="absolute top-2 right-4 text-[80px] font-black text-white/[0.03] leading-none select-none pointer-events-none">
        &#8220;
      </span>

      <div className="flex items-start gap-3">
        {/* Coach badge */}
        <div className="shrink-0 mt-0.5">
          <div className="w-8 h-8 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center">
            <Activity className="w-4 h-4 text-golf-green" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[8px] font-black uppercase tracking-[0.25em] text-golf-green">
              AI Coach Assessment
            </span>
            <span className="text-[8px] text-gray-700">· Gemini 1.5 Pro</span>
          </div>
          <p className="text-[12px] text-gray-300 leading-[1.75] font-light">{text}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment Optimizer
// ─────────────────────────────────────────────────────────────────────────────

function confidenceDot(c: "high" | "medium" | "low") {
  const map = { high: "bg-golf-green", medium: "bg-yellow-400", low: "bg-gray-600" };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${map[c]} shrink-0 mt-0.5`} />;
}

function EquipmentOptimizer({ insight }: { insight: EquipmentInsight }) {
  const attackLabel = {
    draw: "Draw-Bias Attack",
    fade: "Fade-Bias Attack",
    neutral: "Neutral Path",
    unknown: "Path Unknown",
  }[insight.attackAngleBias];

  const attackColor = {
    draw: "text-golf-green",
    fade: "text-amber-400",
    neutral: "text-blue-400",
    unknown: "text-gray-500",
  }[insight.attackAngleBias];

  return (
    <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[0.03] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-amber-400/10">
        <div className="w-7 h-7 rounded-lg bg-amber-400/10 border border-amber-400/20 flex items-center justify-center shrink-0">
          <Cpu className="w-3.5 h-3.5 text-amber-400" />
        </div>
        <div className="flex-1">
          <span className="text-[9px] font-black uppercase tracking-[0.25em] text-amber-400">
            Equipment Optimizer Insight
          </span>
        </div>
        {/* Hip Speed Index pill */}
        {insight.hipSpeedIndex != null && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/30 border border-white/[0.07]">
            <Gauge className="w-3 h-3 text-gray-500" />
            <span className="text-[9px] font-black font-mono text-white">{insight.hipSpeedIndex}</span>
            <span className="text-[8px] text-gray-600">HSI</span>
          </div>
        )}
        {/* Attack angle bias */}
        <span className={`text-[9px] font-black uppercase tracking-widest ${attackColor}`}>
          {attackLabel}
        </span>
      </div>

      {/* Three insight tiles */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-amber-400/[0.08]">
        {/* Shaft */}
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-600">Shaft Flex</span>
          </div>
          <div className="flex items-start gap-2">
            {confidenceDot(insight.shaftFlex.confidence)}
            <span className="text-sm font-black text-white leading-tight">{insight.shaftFlex.recommendation}</span>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">{insight.shaftFlex.reason}</p>
        </div>

        {/* Driver */}
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-600">Driver Config</span>
          </div>
          <div className="flex items-start gap-2">
            {confidenceDot(insight.driverConfig.confidence)}
            <span className="text-sm font-black text-white leading-tight">{insight.driverConfig.recommendation}</span>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">{insight.driverConfig.reason}</p>
        </div>

        {/* Ball */}
        <div className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-600">Ball Spec</span>
          </div>
          <div className="flex items-start gap-2">
            {confidenceDot(insight.ballSpec.confidence)}
            <span className="text-sm font-black text-white leading-tight">{insight.ballSpec.recommendation}</span>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">{insight.ballSpec.reason}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Swing log card (full portal card)
// ─────────────────────────────────────────────────────────────────────────────

function SwingLogCard({ log }: { log: SwingLog }) {
  const isComplete  = log.status === "complete";
  const label       = log.club ?? log.filename ?? "Untitled Swing";
  const equipment   = isComplete ? computeEquipmentInsight(log.bio, log.score) : null;
  const hasBio      = log.bio.spine_angle != null || log.bio.hip_rotation != null || log.bio.shoulder_rotation != null;

  const scoreColor  = log.score == null ? "text-gray-600"
                    : log.score >= 80 ? "text-golf-green"
                    : log.score >= 65 ? "text-yellow-400"
                    : "text-red-400";

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-golf-header overflow-hidden">

      {/* ── Session header ───────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 p-5 pb-4 border-b border-white/[0.04]">
        <div className="w-11 h-11 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0">
          <Video className="w-5 h-5 text-golf-green" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-1">
            <span className="text-base font-black text-white truncate">{label}</span>
            <StatusChip status={log.status} />
            {log.score != null && (
              <span className={`text-sm font-black font-mono ${scoreColor}`}>{log.score} / 100</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <Calendar className="w-3 h-3" />
            <span>{fmtDate(log.created_at)}</span>
            <span>·</span>
            <span>{fmtTime(log.created_at)}</span>
            <span>·</span>
            <span className="font-mono">{log.id.slice(0, 8)}…</span>
          </div>
        </div>
        {isComplete && (
          <Link
            href={`/analyze/${log.id}`}
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-golf-green/10 border border-golf-green/20 text-[9px] font-black uppercase tracking-widest text-golf-green hover:bg-golf-green/20 transition-colors"
          >
            Full Report <ChevronRight className="w-3 h-3" />
          </Link>
        )}
      </div>

      {/* ── Biomechanical metrics ─────────────────────────────────────────── */}
      {isComplete && hasBio && (
        <div className="p-5 pb-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-3.5 h-3.5 text-gray-600" />
            <span className="text-[8px] font-black uppercase tracking-[0.25em] text-gray-600">
              Biomechanical Signature
            </span>
          </div>
          <div className="flex flex-wrap gap-3">
            <MetricCard
              label="Spine Angle"
              value={log.bio.spine_angle}
              unit="°"
              min={15} max={65} idealMin={35} idealMax={45}
              benchmark="Tour ideal: 35–45°"
            />
            <MetricCard
              label="Hip Rotation"
              value={log.bio.hip_rotation}
              unit="°"
              min={10} max={70} idealMin={42} idealMax={55}
              benchmark="Impact clearance · Tour: 45–55°"
            />
            <MetricCard
              label="Shoulder Turn"
              value={log.bio.shoulder_rotation}
              unit="°"
              min={50} max={120} idealMin={85} idealMax={100}
              benchmark="Backswing coil · Tour: 90–100°"
            />
            {log.bio.tempo_ratio && (
              <div className="flex-1 min-w-[120px] p-4 rounded-2xl bg-black/40 border border-white/[0.07] flex flex-col gap-2">
                <span className="text-3xl font-black font-mono text-white leading-none">{log.bio.tempo_ratio}</span>
                <div className="h-2 rounded-full bg-white/[0.06]">
                  {/* Tempo bar: 2:1 = 0%, 3:1 = 50%, 4:1 = 100% */}
                  {(() => {
                    const t = parseTempoNum(log.bio.tempo_ratio);
                    const pct = t != null ? Math.max(0, Math.min(100, ((t - 2) / 2) * 100)) : null;
                    return pct != null ? (
                      <div className="relative h-full">
                        <div className="absolute top-0 h-full rounded-full bg-golf-green/20" style={{ left: "25%", width: "50%" }} />
                        <div className="absolute top-0 h-full w-1 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]" style={{ left: `calc(${pct}% - 2px)` }} />
                      </div>
                    ) : null;
                  })()}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-black uppercase tracking-[0.18em] text-gray-500">Tempo</span>
                  {(() => {
                    const t = parseTempoNum(log.bio.tempo_ratio);
                    const label = t == null ? null : t < 2.5 ? { l: "Fast", c: "text-red-400" } : t <= 3.5 ? { l: "Ideal", c: "text-golf-green" } : { l: "Slow", c: "text-yellow-400" };
                    return label ? <span className={`text-[9px] font-black uppercase tracking-widest ${label.c}`}>{label.l}</span> : null;
                  })()}
                </div>
                <span className="text-[9px] text-gray-700">Backswing : downswing · Tour avg: 3:1</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── AI Coach Personal Summary ─────────────────────────────────────── */}
      {isComplete && log.feedback && (
        <div className="px-5 pb-4">
          <CoachSummary text={log.feedback} />
        </div>
      )}

      {/* ── The Feel ─────────────────────────────────────────────────────── */}
      {isComplete && log.bio.the_feel && (
        <div className="mx-5 mb-3 flex items-start gap-3 bg-golf-green/[0.05] border border-golf-green/[0.12] rounded-2xl px-5 py-4">
          <Zap className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
          <div>
            <p className="text-[8px] font-black uppercase tracking-[0.22em] text-golf-green mb-1.5">The Feel</p>
            <p className="text-xs text-gray-200 leading-relaxed italic">"{log.bio.the_feel}"</p>
          </div>
        </div>
      )}

      {/* ── Equipment Optimizer ───────────────────────────────────────────── */}
      {isComplete && equipment && (
        <div className="px-5 pb-4">
          <EquipmentOptimizer insight={equipment} />
        </div>
      )}

      {/* ── Highlights ───────────────────────────────────────────────────── */}
      {isComplete && log.highlights.length > 0 && (
        <div className="mx-5 mb-3 p-4 rounded-2xl bg-golf-green/[0.05] border border-golf-green/[0.09]">
          <div className="flex items-center gap-2 mb-2.5">
            <ArrowUpRight className="w-3.5 h-3.5 text-golf-green" />
            <span className="text-[8px] font-black uppercase tracking-[0.22em] text-golf-green">What You&apos;re Doing Well</span>
          </div>
          <ul className="space-y-1.5">
            {log.highlights.map((h, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-gray-300 leading-relaxed">
                <span className="text-golf-green shrink-0 mt-0.5">✦</span>{h}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Deficiencies ─────────────────────────────────────────────────── */}
      {isComplete && log.deficiencies.length > 0 && (
        <div className="mx-5 mb-3 p-4 rounded-2xl bg-red-400/[0.04] border border-red-400/[0.09]">
          <div className="flex items-center gap-2 mb-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span className="text-[8px] font-black uppercase tracking-[0.22em] text-red-400">Priority Faults</span>
          </div>
          <ul className="space-y-1.5">
            {log.deficiencies.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-gray-300 leading-relaxed">
                <span className="text-red-400 shrink-0 mt-0.5">▸</span>{d}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Putting analysis ─────────────────────────────────────────────── */}
      {isComplete && log.bio.putting_analysis && (
        <div className="mx-5 mb-4 p-4 rounded-2xl bg-amber-400/[0.04] border border-amber-400/[0.09]">
          <div className="flex items-center gap-2 mb-2.5">
            <Crosshair className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[8px] font-black uppercase tracking-[0.22em] text-amber-400">Putting Analysis</span>
          </div>
          <p className="text-[11px] text-gray-300 leading-relaxed">{log.bio.putting_analysis}</p>
        </div>
      )}

      {/* ── Pending / failed footer ──────────────────────────────────────── */}
      {!isComplete && (
        <div className="px-5 py-3 flex items-center justify-between border-t border-white/[0.04]">
          <span className="text-[9px] text-gray-700">Analysis {log.status}</span>
          <Link href={`/analyze/${log.id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-[9px] font-black uppercase tracking-widest text-gray-500 hover:text-white hover:border-white/20 transition-colors">
            View Status <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Range log card (compact)
// ─────────────────────────────────────────────────────────────────────────────

function RangeLogCard({ log }: { log: RangeLog }) {
  const pct    = Math.round(log.completion_rate * 100);
  const missed = log.shots_total - log.shots_executed;
  const color  = pct >= 80 ? "text-golf-green" : pct >= 60 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-golf-header overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <div className="w-11 h-11 rounded-xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center shrink-0">
          <Target className="w-5 h-5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-1">
            <span className="text-base font-black text-white">{sessionLabel(log.session_type)}</span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400">
              <BarChart3 className="w-2.5 h-2.5" />Range Session
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-600 mb-4">
            <Calendar className="w-3 h-3" />
            <span>{fmtDate(log.created_at)}</span>
            <span>·</span>
            <span>{fmtTime(log.created_at)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { v: `${pct}%`,             l: "Execution",  c: color },
              { v: `${log.shots_executed}`, l: "Executed",  c: "text-white" },
              { v: `${missed}`,             l: "Missed",    c: "text-red-400" },
              { v: `${log.shots_total}`,    l: "Total",     c: "text-gray-400" },
            ].map(({ v, l, c }) => (
              <div key={l} className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/40 border border-white/[0.07]">
                <span className={`text-base font-black font-mono leading-none mb-1 ${c}`}>{v}</span>
                <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600">{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default async function TelemetryPage() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const [swingResult, rangeResult] = await Promise.all([
    supabase
      .from("swing_analysis")
      .select(`
        id, status, score, feedback, created_at,
        spine_angle, hip_rotation, shoulder_rotation,
        metrics, swing_highlights, mechanical_deficiencies,
        swing_video:swing_videos(club, original_filename)
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),

    supabase
      .from("range_sessions")
      .select("id, session_type, shots_total, shots_executed, completion_rate, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (swingResult.error) console.error("[telemetry] swing_analysis error:", swingResult.error.message);
  if (rangeResult.error) console.error("[telemetry] range_sessions error:", rangeResult.error.message);

  type RawVideo = { club: string | null; original_filename: string | null } | null;
  type RawHL    = { positive_movement?: unknown };
  type RawDF    = { fault_description?: unknown };

  const swingLogs: SwingLog[] = (swingResult.data ?? []).map((r) => {
    const vid    = r.swing_video as unknown as RawVideo | RawVideo[];
    const video  = Array.isArray(vid) ? (vid[0] ?? null) : vid;
    const raw    = (r.metrics as Record<string, unknown> | null) ?? {};
    const rawHL  = (r.swing_highlights as RawHL[] | null) ?? [];
    const rawDF  = (r.mechanical_deficiencies as RawDF[] | null) ?? [];

    // Prefer dedicated numeric columns (written by API route from client measurements);
    // fall back to the JSONB metrics blob for records written before the dedicated columns existed.
    const spineAngle       = typeof r.spine_angle === "number"       ? r.spine_angle
                           : typeof raw.spine_angle === "number"     ? raw.spine_angle       : undefined;
    const hipRotation      = typeof r.hip_rotation === "number"      ? r.hip_rotation
                           : typeof raw.hip_rotation === "number"    ? raw.hip_rotation      : undefined;
    const shoulderRotation = typeof r.shoulder_rotation === "number" ? r.shoulder_rotation
                           : typeof raw.shoulder_rotation === "number" ? raw.shoulder_rotation : undefined;

    const bio: BiometricsData = {
      spine_angle:       spineAngle,
      hip_rotation:      hipRotation,
      shoulder_rotation: shoulderRotation,
      tempo_ratio:       typeof raw.tempo_ratio === "string"       ? raw.tempo_ratio       : undefined,
      putting_analysis:  typeof raw.putting_analysis === "string"  ? raw.putting_analysis  : undefined,
      the_feel:          typeof raw.the_feel === "string"          ? raw.the_feel          : undefined,
      posture:           raw.posture  as BiometricsData["posture"]  ?? undefined,
      swing_plane:       raw.swing_plane as BiometricsData["swing_plane"] ?? undefined,
      impact:            raw.impact   as BiometricsData["impact"]   ?? undefined,
    };

    return {
      id:           r.id,
      created_at:   r.created_at,
      status:       r.status,
      score:        r.score ?? null,
      feedback:     r.feedback ?? null,
      club:         video?.club ?? null,
      filename:     video?.original_filename ?? null,
      bio,
      highlights:   rawHL.map((h) => typeof h.positive_movement === "string" ? h.positive_movement : "").filter(Boolean),
      deficiencies: rawDF.map((d) => typeof d.fault_description === "string" ? d.fault_description : "").filter(Boolean),
    };
  });

  const rangeLogs: RangeLog[] = (rangeResult.data ?? []).map((r) => ({
    id:              r.id,
    created_at:      r.created_at,
    session_type:    r.session_type,
    shots_total:     r.shots_total,
    shots_executed:  r.shots_executed,
    completion_rate: r.completion_rate,
  }));

  // Merge chronologically
  type TimelineItem =
    | { kind: "swing"; created_at: string; data: SwingLog }
    | { kind: "range"; created_at: string; data: RangeLog };

  const timeline: TimelineItem[] = [
    ...swingLogs.map((d) => ({ kind: "swing" as const, created_at: d.created_at, data: d })),
    ...rangeLogs.map((d) => ({ kind: "range" as const, created_at: d.created_at, data: d })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const completedSwings  = swingLogs.filter((s) => s.status === "complete").length;
  const avgScore = completedSwings > 0
    ? Math.round(swingLogs.filter((s) => s.score != null).reduce((a, s) => a + (s.score ?? 0), 0) / completedSwings)
    : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* ── Portal header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Zap size={12} className="text-golf-green" fill="currentColor" />
            <span className="text-[8px] font-black uppercase tracking-[0.3em] text-gray-600">
              Performance Intelligence Portal
            </span>
          </div>
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase leading-none">
            Telemetry
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1.5">
            {swingLogs.length} swing{swingLogs.length !== 1 ? "s" : ""} · {rangeLogs.length} range session{rangeLogs.length !== 1 ? "s" : ""}
            {avgScore != null && ` · Avg score ${avgScore}`}
          </p>
        </div>

        <div className="flex gap-2 mt-1">
          <Link href="/range" className="px-4 py-2.5 border border-white/10 text-gray-400 hover:text-white hover:border-white/20 rounded-xl font-black flex items-center gap-2 text-[10px] uppercase tracking-widest transition-all">
            <Target size={13} />Range
          </Link>
          <Link href="/analyze" className="px-4 py-2.5 bg-golf-green text-golf-dark rounded-xl font-black flex items-center gap-2 hover:bg-[#22C55E] transition-all text-[10px] uppercase tracking-widest">
            <Video size={13} />Analyze
          </Link>
        </div>
      </div>

      {/* ── Summary stat bar ───────────────────────────────────────────────── */}
      {timeline.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-8">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-golf-green/10 border border-golf-green/20">
            <Video className="w-3.5 h-3.5 text-golf-green" />
            <span className="text-[10px] font-black uppercase tracking-widest text-golf-green">{swingLogs.length} Swing{swingLogs.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-400/10 border border-amber-400/20">
            <Target className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">{rangeLogs.length} Range Session{rangeLogs.length !== 1 ? "s" : ""}</span>
          </div>
          {avgScore != null && (
            <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.07]">
              <Activity className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Avg {avgScore} pts</span>
            </div>
          )}
        </div>
      )}

      {/* ── Timeline ───────────────────────────────────────────────────────── */}
      {timeline.length === 0 ? (
        <div className="py-24 text-center flex flex-col items-center gap-4 bg-golf-header rounded-2xl border border-white/[0.06]">
          <Zap size={36} className="text-gray-700" />
          <p className="text-gray-700 font-mono text-[10px] uppercase tracking-[0.3em] italic">No telemetry recorded yet</p>
          <div className="flex gap-3">
            <Link href="/range" className="px-4 py-2.5 border border-white/10 text-gray-400 rounded-xl font-black text-[9px] uppercase tracking-widest hover:text-white transition-all">Start Range Session</Link>
            <Link href="/analyze" className="px-4 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all">Upload First Swing</Link>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {timeline.map((item) =>
            item.kind === "swing"
              ? <SwingLogCard key={`swing-${item.data.id}`} log={item.data as SwingLog} />
              : <RangeLogCard key={`range-${item.data.id}`} log={item.data as RangeLog} />
          )}
        </div>
      )}
    </div>
  );
}
