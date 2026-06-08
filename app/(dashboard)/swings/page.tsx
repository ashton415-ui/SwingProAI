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
} from "lucide-react";

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
  if (score == null) return "text-gray-600 border-white/10";
  if (score >= 80) return "text-golf-green border-golf-green/20";
  if (score >= 65) return "text-yellow-400 border-yellow-400/20";
  return "text-red-400 border-red-500/20";
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

// ── Swing card ────────────────────────────────────────────────────────────────

function SwingCard({ entry }: { entry: SwingEntry }) {
  const label = entry.club ?? entry.filename ?? "Untitled Swing";
  const truncatedFeedback = entry.feedback
    ? entry.feedback.length > 120
      ? entry.feedback.slice(0, 117) + "…"
      : entry.feedback
    : null;

  return (
    <div className="group flex gap-4 p-5 rounded-2xl border border-white/[0.06] bg-golf-header hover:border-white/[0.12] transition-all">
      {/* Icon */}
      <div className="w-10 h-10 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0 mt-0.5">
        <Video className="w-5 h-5 text-golf-green" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 mb-2">
          <span className="text-sm font-black text-white truncate">{label}</span>
          <SwingStatusChip status={entry.status} />
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-gray-600 mb-3">
          <Calendar className="w-3 h-3" />
          <span>{fmtDate(entry.created_at)}</span>
          <span>·</span>
          <span>{fmtTime(entry.created_at)}</span>
          {entry.score != null && (
            <>
              <span>·</span>
              <span className={`font-black font-mono ${scoreColor(entry.score).split(" ")[0]}`}>
                {entry.score} pts
              </span>
            </>
          )}
        </div>

        {truncatedFeedback && (
          <p className="text-[11px] text-gray-500 leading-relaxed mb-3 line-clamp-2">
            {truncatedFeedback}
          </p>
        )}

        {entry.status === "complete" && (
          <Link
            href={`/analyze/${entry.id}`}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-golf-green/10 border border-golf-green/20 text-[10px] font-black uppercase tracking-widest text-golf-green hover:bg-golf-green/20 transition-colors"
          >
            View AI Report <ChevronRight className="w-3 h-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Range card ────────────────────────────────────────────────────────────────

function RangeCard({ entry }: { entry: RangeEntry }) {
  const exec = execPct(entry.completion_rate);
  const missed = entry.shots_total - entry.shots_executed;

  return (
    <div className="group flex gap-4 p-5 rounded-2xl border border-white/[0.06] bg-golf-header hover:border-white/[0.12] transition-all">
      {/* Icon */}
      <div className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center shrink-0 mt-0.5">
        <Target className="w-5 h-5 text-amber-400" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1 mb-2">
          <span className="text-sm font-black text-white">{sessionLabel(entry.session_type)}</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400">
            <BarChart3 className="w-2.5 h-2.5" /> Range Session
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-gray-600 mb-3">
          <Calendar className="w-3 h-3" />
          <span>{fmtDate(entry.created_at)}</span>
          <span>·</span>
          <span>{fmtTime(entry.created_at)}</span>
        </div>

        {/* Shot stats */}
        <div className="flex items-center gap-4">
          <div className="text-center">
            <p className={`text-base font-black font-mono ${exec.color}`}>{exec.label}</p>
            <p className="text-[9px] uppercase tracking-widest text-gray-700">Execution</p>
          </div>
          <div className="w-px h-7 bg-white/[0.06]" />
          <div className="text-center">
            <p className="text-base font-black font-mono text-white">{entry.shots_executed}</p>
            <p className="text-[9px] uppercase tracking-widest text-gray-700">Executed</p>
          </div>
          <div className="text-center">
            <p className="text-base font-black font-mono text-red-400">{missed}</p>
            <p className="text-[9px] uppercase tracking-widest text-gray-700">Missed</p>
          </div>
          <div className="text-center">
            <p className="text-base font-black font-mono text-gray-400">{entry.shots_total}</p>
            <p className="text-[9px] uppercase tracking-widest text-gray-700">Total</p>
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

  // Parallel fetch — both tables share the same auth client so RLS is applied
  const [swingResult, rangeResult] = await Promise.all([
    supabase
      .from("swing_analysis")
      .select("id, status, score, feedback, created_at, swing_video:swing_videos(club, original_filename)")
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

  // Map to unified timeline entries
  type RawVideo = { club: string | null; original_filename: string | null } | null;

  const swingEntries: SwingEntry[] = (swingResult.data ?? []).map((r) => {
    const vid = (r.swing_video as unknown as RawVideo | RawVideo[]);
    const videoRow = Array.isArray(vid) ? (vid[0] ?? null) : vid;
    return {
      kind: "swing",
      id: r.id,
      created_at: r.created_at,
      status: r.status,
      score: r.score ?? null,
      feedback: r.feedback ?? null,
      club: videoRow?.club ?? null,
      filename: videoRow?.original_filename ?? null,
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

  // Merge and sort newest first
  const timeline: TimelineEntry[] = [...swingEntries, ...rangeEntries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const swingCount  = swingEntries.length;
  const rangeCount  = rangeEntries.length;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
            Telemetry Logs
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            All sessions — swing analyses &amp; range work
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
        <div className="space-y-3">
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
