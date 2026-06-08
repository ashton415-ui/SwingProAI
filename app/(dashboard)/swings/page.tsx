import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Video,
  Target,
  CheckCircle2,
  Clock,
  AlertCircle,
  Loader2,
  Calendar,
  ChevronRight,
  Zap,
  BarChart3,
  Activity,
  ArrowUpRight,
  AlertTriangle,
  Crosshair,
} from "lucide-react";

// ── Biomechanical data shape (from `metrics` JSONB) ───────────────────────────

interface BioMetrics {
  spine_angle?: number;
  hip_rotation?: number;
  shoulder_rotation?: number;
  tempo_ratio?: string;
  putting_analysis?: string;
}

// ── Unified timeline types ────────────────────────────────────────────────────

interface SwingEntry {
  kind: "swing";
  id: string;
  created_at: string;
  status: string;
  score: number | null;
  feedback: string | null;
  club: string | null;
  filename: string | null;
  bio: BioMetrics;
  highlights: string[];
  deficiencies: string[];
}

interface RangeEntry {
  kind: "range";
  id: string;
  created_at: string;
  session_type: string;
  shots_total: number;
  shots_executed: number;
  completion_rate: number;
}

type TimelineEntry = SwingEntry | RangeEntry;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
}

function sessionLabel(type: string) {
  const map: Record<string, string> = {
    technical_block: "Technical Block",
    variable_calibration: "Variable Calibration",
    simulated_round: "Simulated Round",
  };
  return map[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function scoreColor(score: number | null) {
  if (score == null) return "text-gray-600";
  if (score >= 80) return "text-golf-green";
  if (score >= 65) return "text-yellow-400";
  return "text-red-400";
}

function execPct(rate: number) {
  const pct = Math.round(rate * 100);
  if (pct >= 80) return { label: `${pct}%`, color: "text-golf-green" };
  if (pct >= 60) return { label: `${pct}%`, color: "text-yellow-400" };
  return { label: `${pct}%`, color: "text-red-400" };
}

// ── Status chip ───────────────────────────────────────────────────────────────

function SwingStatusChip({ status }: { status: string }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-golf-green/10 border border-golf-green/20 text-[9px] font-black uppercase tracking-widest text-golf-green">
        <CheckCircle2 className="w-2.5 h-2.5" /> Complete
      </span>
    );
  }
  if (status === "processing") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Processing
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-400/10 border border-red-400/20 text-[9px] font-black uppercase tracking-widest text-red-400">
        <AlertCircle className="w-2.5 h-2.5" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/10 text-[9px] font-black uppercase tracking-widest text-gray-500">
      <Clock className="w-2.5 h-2.5" /> {status}
    </span>
  );
}

// ── Biomechanical metric badge ────────────────────────────────────────────────

function MetricBadge({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number | undefined;
  unit?: string;
}) {
  if (value == null) return null;
  return (
    <div className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08] min-w-[72px]">
      <span className="text-base font-black font-mono text-white leading-none mb-1">
        {typeof value === "number" ? value.toFixed(1) : value}
        {unit && <span className="text-[10px] text-gray-500 ml-0.5">{unit}</span>}
      </span>
      <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600 whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}

// ── Swing card ────────────────────────────────────────────────────────────────

function SwingCard({ entry }: { entry: SwingEntry }) {
  const label = entry.club ?? entry.filename ?? "Untitled Swing";
  const hasBio = entry.bio.spine_angle != null || entry.bio.hip_rotation != null || entry.bio.shoulder_rotation != null;
  const hasHighlights = entry.highlights.length > 0;
  const hasDeficiencies = entry.deficiencies.length > 0;
  const hasPutting = !!entry.bio.putting_analysis;
  const isComplete = entry.status === "complete";

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-golf-header overflow-hidden hover:border-white/[0.14] transition-all">
      {/* Top row */}
      <div className="flex gap-4 p-5 pb-4">
        <div className="w-10 h-10 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0 mt-0.5">
          <Video className="w-5 h-5 text-golf-green" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5">
            <span className="text-sm font-black text-white truncate">{label}</span>
            <SwingStatusChip status={entry.status} />
            {entry.score != null && (
              <span className={`text-sm font-black font-mono ${scoreColor(entry.score)}`}>
                {entry.score} pts
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <Calendar className="w-3 h-3" />
            <span>{fmtDate(entry.created_at)}</span>
            <span>·</span>
            <span>{fmtTime(entry.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Biomechanical metric badges — only shown when complete + data present */}
      {isComplete && hasBio && (
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <Activity className="w-3 h-3 text-gray-700" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-700">
              Biomechanics
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <MetricBadge label="Spine Angle" value={entry.bio.spine_angle} unit="°" />
            <MetricBadge label="Hip Rotation" value={entry.bio.hip_rotation} unit="°" />
            <MetricBadge label="Shoulder Turn" value={entry.bio.shoulder_rotation} unit="°" />
            <MetricBadge label="Tempo" value={entry.bio.tempo_ratio} />
          </div>
        </div>
      )}

      {/* Highlights */}
      {isComplete && hasHighlights && (
        <div className="mx-5 mb-3 p-3.5 rounded-xl bg-golf-green/[0.06] border border-golf-green/10">
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowUpRight className="w-3 h-3 text-golf-green" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-golf-green">
              What You&apos;re Doing Well
            </span>
          </div>
          <ul className="space-y-1">
            {entry.highlights.map((h, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-gray-300 leading-relaxed">
                <span className="text-golf-green mt-0.5 shrink-0">✦</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Deficiencies */}
      {isComplete && hasDeficiencies && (
        <div className="mx-5 mb-3 p-3.5 rounded-xl bg-red-400/[0.05] border border-red-400/10">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle className="w-3 h-3 text-red-400" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-red-400">
              Priority Faults
            </span>
          </div>
          <ul className="space-y-1">
            {entry.deficiencies.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-gray-300 leading-relaxed">
                <span className="text-red-400 mt-0.5 shrink-0">▸</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Putting analysis */}
      {isComplete && hasPutting && (
        <div className="mx-5 mb-3 p-3.5 rounded-xl bg-amber-400/[0.05] border border-amber-400/10">
          <div className="flex items-center gap-1.5 mb-2">
            <Crosshair className="w-3 h-3 text-amber-400" />
            <span className="text-[8px] font-black uppercase tracking-[0.2em] text-amber-400">
              Putting Analysis
            </span>
          </div>
          <p className="text-[11px] text-gray-300 leading-relaxed">{entry.bio.putting_analysis}</p>
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-3 border-t border-white/[0.04] flex items-center justify-between">
        <span className="text-[9px] font-mono text-gray-700">{entry.id.slice(0, 8)}…</span>
        {isComplete ? (
          <Link
            href={`/analyze/${entry.id}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-golf-green/10 border border-golf-green/20 text-[10px] font-black uppercase tracking-widest text-golf-green hover:bg-golf-green/20 transition-colors"
          >
            View AI Report <ChevronRight className="w-3 h-3" />
          </Link>
        ) : entry.status === "pending" || entry.status === "processing" ? (
          <Link
            href={`/analyze/${entry.id}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-white/10 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-white hover:border-white/20 transition-colors"
          >
            View Status <ChevronRight className="w-3 h-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ── Range card ────────────────────────────────────────────────────────────────

function RangeCard({ entry }: { entry: RangeEntry }) {
  const exec = execPct(entry.completion_rate);
  const missed = entry.shots_total - entry.shots_executed;

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-golf-header overflow-hidden hover:border-white/[0.14] transition-all">
      <div className="flex gap-4 p-5 pb-4">
        <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center shrink-0 mt-0.5">
          <Target className="w-5 h-5 text-amber-400" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5">
            <span className="text-sm font-black text-white">{sessionLabel(entry.session_type)}</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400">
              <BarChart3 className="w-2.5 h-2.5" /> Range
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <Calendar className="w-3 h-3" />
            <span>{fmtDate(entry.created_at)}</span>
            <span>·</span>
            <span>{fmtTime(entry.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Shot stat badges */}
      <div className="px-5 pb-5">
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08]">
            <span className={`text-base font-black font-mono leading-none mb-1 ${exec.color}`}>
              {exec.label}
            </span>
            <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600">Execution</span>
          </div>
          <div className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08]">
            <span className="text-base font-black font-mono text-white leading-none mb-1">{entry.shots_executed}</span>
            <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600">Executed</span>
          </div>
          <div className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08]">
            <span className="text-base font-black font-mono text-red-400 leading-none mb-1">{missed}</span>
            <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600">Missed</span>
          </div>
          <div className="flex flex-col items-center px-4 py-2.5 rounded-xl bg-black/30 border border-white/[0.08]">
            <span className="text-base font-black font-mono text-gray-400 leading-none mb-1">{entry.shots_total}</span>
            <span className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-600">Total</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function SwingsPage() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  // Parallel fetch — same auth client, RLS scoped to user automatically
  const [swingResult, rangeResult] = await Promise.all([
    supabase
      .from("swing_analysis")
      .select(`
        id, status, score, feedback, created_at,
        metrics, swing_highlights, mechanical_deficiencies,
        swing_video:swing_videos(club, original_filename)
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100),

    supabase
      .from("range_sessions")
      .select("id, session_type, shots_total, shots_executed, completion_rate, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (swingResult.error) {
    console.error("[swings/page] swing_analysis fetch error:", swingResult.error.message);
  }
  if (rangeResult.error) {
    console.error("[swings/page] range_sessions fetch error:", rangeResult.error.message);
  }

  type RawVideo = { club: string | null; original_filename: string | null } | null;

  const swingEntries: SwingEntry[] = (swingResult.data ?? []).map((r) => {
    const vid = r.swing_video as unknown as RawVideo | RawVideo[];
    const videoRow = Array.isArray(vid) ? (vid[0] ?? null) : vid;

    // Extract biomechanics from metrics JSONB
    const rawMetrics = (r.metrics as Record<string, unknown> | null) ?? {};
    const bio: BioMetrics = {
      spine_angle:       typeof rawMetrics.spine_angle === "number"       ? rawMetrics.spine_angle       : undefined,
      hip_rotation:      typeof rawMetrics.hip_rotation === "number"      ? rawMetrics.hip_rotation      : undefined,
      shoulder_rotation: typeof rawMetrics.shoulder_rotation === "number" ? rawMetrics.shoulder_rotation : undefined,
      tempo_ratio:       typeof rawMetrics.tempo_ratio === "string"       ? rawMetrics.tempo_ratio       : undefined,
      putting_analysis:  typeof rawMetrics.putting_analysis === "string"  ? rawMetrics.putting_analysis  : undefined,
    };

    // Extract simple strings from jsonb arrays
    type RawHL = { positive_movement?: unknown };
    type RawDF = { fault_description?: unknown };
    const rawHL = (r.swing_highlights as RawHL[] | null) ?? [];
    const rawDF = (r.mechanical_deficiencies as RawDF[] | null) ?? [];

    const highlights = rawHL
      .map((h) => (typeof h.positive_movement === "string" ? h.positive_movement : ""))
      .filter(Boolean);
    const deficiencies = rawDF
      .map((d) => (typeof d.fault_description === "string" ? d.fault_description : ""))
      .filter(Boolean);

    return {
      kind: "swing",
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      score: r.score ?? null,
      feedback: r.feedback ?? null,
      club: videoRow?.club ?? null,
      filename: videoRow?.original_filename ?? null,
      bio,
      highlights,
      deficiencies,
    };
  });

  const rangeEntries: RangeEntry[] = (rangeResult.data ?? []).map((r) => ({
    kind: "range",
    id: r.id,
    created_at: r.created_at,
    session_type: r.session_type,
    shots_total: r.shots_total,
    shots_executed: r.shots_executed,
    completion_rate: r.completion_rate,
  }));

  const timeline: TimelineEntry[] = [...swingEntries, ...rangeEntries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const swingCount = swingEntries.length;
  const rangeCount = rangeEntries.length;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
            Telemetry Logs
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            Swing analyses &amp; range sessions — chronological
          </p>
        </div>
        <div className="flex gap-2 mt-1">
          <Link
            href="/range"
            className="px-4 py-2.5 border border-white/10 text-gray-400 hover:text-white hover:border-white/20 rounded-xl font-black flex items-center gap-2 text-[10px] uppercase tracking-widest transition-all"
          >
            <Target size={13} />
            Range
          </Link>
          <Link
            href="/analyze"
            className="px-4 py-2.5 bg-golf-green text-golf-dark rounded-xl font-black flex items-center gap-2 hover:bg-[#22C55E] transition-all text-[10px] uppercase tracking-widest"
          >
            <Video size={13} />
            Analyze
          </Link>
        </div>
      </div>

      {/* Summary chips */}
      {timeline.length > 0 && (
        <div className="flex gap-3 mb-8 flex-wrap">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-golf-green/10 border border-golf-green/20">
            <Video className="w-3.5 h-3.5 text-golf-green" />
            <span className="text-[10px] font-black uppercase tracking-widest text-golf-green">
              {swingCount} Swing{swingCount !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-400/10 border border-amber-400/20">
            <Target className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">
              {rangeCount} Range Session{rangeCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      )}

      {/* Timeline */}
      {timeline.length === 0 ? (
        <div className="py-24 text-center flex flex-col items-center gap-4 bg-golf-header rounded-2xl border border-white/[0.06]">
          <Zap size={36} className="text-gray-700" />
          <p className="text-gray-700 font-mono text-[10px] uppercase tracking-[0.3em] italic">
            No telemetry recorded yet
          </p>
          <div className="flex gap-3">
            <Link
              href="/range"
              className="px-4 py-2.5 border border-white/10 text-gray-400 rounded-xl font-black text-[9px] uppercase tracking-widest hover:text-white transition-all"
            >
              Start Range Session
            </Link>
            <Link
              href="/analyze"
              className="px-4 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all"
            >
              Upload First Swing
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {timeline.map((entry) =>
            entry.kind === "swing" ? (
              <SwingCard key={`swing-${entry.id}`} entry={entry} />
            ) : (
              <RangeCard key={`range-${entry.id}`} entry={entry} />
            )
          )}
        </div>
      )}
    </div>
  );
}
