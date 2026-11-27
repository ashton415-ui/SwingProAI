import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getHistoricalEquipmentDisplayName } from "@/lib/equipment/historical-equipment-display-name";
import { authorizeOwnedAnalysisRows } from "@/lib/analysis-result-read-authority";
import { golferStatusLabel, readGolferJobStates, type JobStateRead } from "@/lib/analysis-attempt-precedence";
import {
  ASSESSMENT_LABEL,
  ESTIMATES_DISCLOSURE,
  ESTIMATES_HEADING,
  SCORE_BASIS,
  UNSCORED_LABEL,
  presentFullSwingMetrics,
  presentScore,
  type PresentedMetric,
} from "@/lib/swing-metric-presentation";
import {
  Video, Target, CheckCircle2, Clock, AlertCircle, Loader2, Calendar,
  Activity, ArrowUpRight, AlertTriangle, Crosshair, Zap, ChevronRight,
  BarChart3, TrendingUp,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BiometricsData {
  putting_analysis?:  string;
  the_feel?:          string;
  posture?:           { rating: string; observation: string; correction: string };
  swing_plane?:       { rating: string; observation: string; correction: string };
  impact?:            { rating: string; observation: string; correction: string };
}

interface SwingLog {
  id:          string;
  created_at:  string;
  status:      string;
  /** AG-WEB-READY-10-P2: the golfer-facing attempt state, when it could be read */
  job?:        JobStateRead | null;
  score:       number | null;
  feedback:    string | null;
  club:        string | null;
  filename:    string | null;
  bio:         BiometricsData;
  /** S6-R1: the four estimates as presented (value and source, or unavailable). */
  estimates:   PresentedMetric[];
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

/**
 * range_sessions stores its per-session metrics in the nullable `exercise_data`
 * jsonb column, so the payload is untrusted at runtime. Every metric is checked
 * as a finite number rather than asserted, and a null or malformed blob yields
 * null so the caller can drop the row instead of rendering fabricated values.
 */
function parseRangeMetrics(
  value: unknown
): { shots_total: number; shots_executed: number; completion_rate: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const total    = raw.shots_total;
  const executed = raw.shots_executed;
  const rate     = raw.completion_rate;

  if (typeof total    !== "number" || !Number.isFinite(total))    return null;
  if (typeof executed !== "number" || !Number.isFinite(executed)) return null;
  if (typeof rate     !== "number" || !Number.isFinite(rate))     return null;

  return { shots_total: total, shots_executed: executed, completion_rate: rate };
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

function StatusChip({ status, job = null }: { status: string; job?: JobStateRead | null }) {
  // P2: with an attempt state, the shared precedence rule decides (an open retry is never shown as Failed). A1: an
  // unreadable state is "Status unavailable" (a stored completed swing stays Complete).
  if (job) {
    const { label, tone } = golferStatusLabel(status, job);
    if (tone !== "complete") {
      const style =
        tone === "failed" ? "bg-red-400/10 border-red-400/20 text-red-400"
        : tone === "active" || tone === "attention" ? "bg-amber-400/10 border-amber-400/20 text-amber-400"
        : "bg-white/[0.04] border-white/10 text-gray-500";
      const spinning = job !== "unavailable" && job.execution === "processing";
      const Icon = tone === "failed" || tone === "attention" ? AlertCircle : spinning ? Loader2 : Clock;
      return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[9px] font-black uppercase tracking-widest ${style}`}><Icon className={`w-2.5 h-2.5${spinning ? " animate-spin" : ""}`} />{label}</span>;
    }
  }
  if (status === "complete")   return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-golf-green/10 border border-golf-green/20 text-[9px] font-black uppercase tracking-widest text-golf-green"><CheckCircle2 className="w-2.5 h-2.5" />Complete</span>;
  if (status === "processing") return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-[9px] font-black uppercase tracking-widest text-amber-400"><Loader2 className="w-2.5 h-2.5 animate-spin" />Processing</span>;
  if (status === "failed")     return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-400/10 border border-red-400/20 text-[9px] font-black uppercase tracking-widest text-red-400"><AlertCircle className="w-2.5 h-2.5" />Failed</span>;
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/10 text-[9px] font-black uppercase tracking-widest text-gray-500"><Clock className="w-2.5 h-2.5" />{status}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimate card (S6-R1): an approximate value with its source, or "Not
// available". No rating, range bar or benchmark: none has a cited source.
// ─────────────────────────────────────────────────────────────────────────────

function EstimateCard({ metric }: { metric: PresentedMetric }) {
  const available = metric.status === "estimate";
  return (
    <div className="flex-1 min-w-[130px] p-4 rounded-2xl bg-black/40 border border-white/[0.07] flex flex-col gap-1.5">
      <span className={`font-black font-mono leading-none ${available ? "text-3xl text-white" : "text-base text-gray-500"}`}>
        {metric.display}
      </span>
      <span className="text-[9px] font-black uppercase tracking-[0.18em] text-gray-500">{metric.label}</span>
      {metric.sourceLabel && <span className="text-[9px] text-gray-600 leading-tight">{metric.sourceLabel}</span>}
      {metric.clientNote && <span className="text-[9px] text-gray-600 leading-tight">{metric.clientNote}</span>}
      {metric.reference && <span className="text-[9px] text-gray-600 leading-tight">{metric.reference}</span>}
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
              {ASSESSMENT_LABEL}
            </span>
          </div>
          <p className="text-[12px] text-gray-300 leading-[1.75] font-light">{text}</p>
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
  // S6-R1: a score is shown with its basis and no grade colour; a complete
  // analysis without one says "Not scored", never 0.
  const score       = presentScore(log.score);

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
            <StatusChip status={log.status} job={log.job ?? null} />
            {isComplete && (
              <span className="text-sm font-black font-mono text-white" title={SCORE_BASIS}>
                {score.scored ? `${score.value} / 100` : UNSCORED_LABEL}
              </span>
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
            className="shrink-0 inline-flex items-center justify-center gap-1.5 min-h-11 min-w-11 px-3.5 py-2 rounded-xl bg-golf-green/10 border border-golf-green/20 text-[9px] font-black uppercase tracking-widest text-golf-green hover:bg-golf-green/20 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green"
          >
            Full Report <ChevronRight className="w-3 h-3" />
          </Link>
        )}
      </div>

      {/* ── Swing estimates (S6-R1) ── */}
      {isComplete && (
        <div className="p-5 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-3.5 h-3.5 text-gray-600" />
            <span className="text-[8px] font-black uppercase tracking-[0.25em] text-gray-600">
              {ESTIMATES_HEADING}
            </span>
          </div>
          <p className="text-[9px] text-gray-600 mb-3">{ESTIMATES_DISCLOSURE} {SCORE_BASIS}</p>
          <div className="flex flex-wrap gap-3">
            {log.estimates.map((metric) => (
              <EstimateCard key={metric.label} metric={metric} />
            ))}
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
          <Link href={`/analyze/${log.id}`} className="inline-flex items-center justify-center gap-1.5 min-h-11 min-w-11 px-3 py-1.5 rounded-lg border border-white/10 text-[9px] font-black uppercase tracking-widest text-gray-500 hover:text-white hover:border-white/20 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green">
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

  // ENT-1C. This session read proves ownership and carries identity and core
  // columns only. The result payload (metrics, highlights, deficiencies) is
  // read and serialized by the unified result-read authority below.
  const [ownedHistory, rangeResult] = await Promise.all([
    supabase
      .from("swing_analysis")
      .select(`
        id, user_id, status, score, feedback, created_at, analysis_family, equipment_snapshot,
        tempo_ratio, spine_angle, hip_rotation, shoulder_rotation,
        swing_video:swing_videos(club, original_filename)
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),

    supabase
      .from("range_sessions")
      .select("id, session_type, exercise_data, completed_at")
      .eq("user_id", user.id)
      .order("completed_at", { ascending: false })
      .limit(50),
  ]);

  const swingResult = await authorizeOwnedAnalysisRows({ client: supabase, userId: user.id }, ownedHistory);

  if (swingResult.error) console.error("[telemetry] swing_analysis error:", swingResult.error.message);
  if (rangeResult.error) console.error("[telemetry] range_sessions error:", rangeResult.error.message);

  type RawVideo = { club: string | null; original_filename: string | null } | null;
  type RawHL    = { positive_movement?: unknown };
  type RawDF    = { fault_description?: unknown };

  // EQ5C-C. Putting analyses leave the pipeline here, before anything
  // downstream of them exists. This page is a full-swing analytical portal: it
  // presents full-swing estimates and interprets a full-swing score. A putt
  // produces neither, so letting one through would present values that were
  // never estimated. (S6-R1 removed the derived shaft, driver and ball advice:
  // estimates from video cannot support equipment fitting.)
  //
  // Compatibility is a positive allow-list. Legacy rows written before the
  // family column exists carry null and remain part of the established
  // full-swing population; an unforeseen family value is excluded rather than
  // admitted by default. The test is written in application code on purpose:
  // a PostgREST predicate such as .neq("analysis_family", "putting") compares
  // in SQL, where NULL <> 'putting' is unknown rather than true, and would
  // silently discard every legacy row.
  const fullSwingRows = (swingResult.data ?? []).filter(
    (r) => r.analysis_family === null || r.analysis_family === "full_swing",
  );

  // AG-WEB-READY-10-P2: golfer-facing attempt states, on the golfer's own session (A1: "unavailable" per swing when
  // its state cannot be read)
  const jobStates = await readGolferJobStates(supabase, fullSwingRows.map((r) => r.id));

  const swingLogs: SwingLog[] = fullSwingRows.map((r) => {
    const vid    = r.swing_video as unknown as RawVideo | RawVideo[];
    const video  = Array.isArray(vid) ? (vid[0] ?? null) : vid;
    const raw    = (r.metrics as Record<string, unknown> | null) ?? {};
    const rawHL  = r.swing_highlights as RawHL[];
    const rawDF  = r.mechanical_deficiencies as RawDF[];

    const bio: BiometricsData = {
      putting_analysis:  typeof raw.putting_analysis === "string"  ? raw.putting_analysis  : undefined,
      the_feel:          typeof raw.the_feel === "string"          ? raw.the_feel          : undefined,
      posture:           raw.posture  as BiometricsData["posture"]  ?? undefined,
      swing_plane:       raw.swing_plane as BiometricsData["swing_plane"] ?? undefined,
      impact:            raw.impact   as BiometricsData["impact"]   ?? undefined,
    };

    return {
      id:           r.id,
      created_at:   r.created_at ?? "",
      status:       r.status,
      job:          jobStates.get(String(r.id)),
      score:        r.score ?? null,
      feedback:     r.feedback ?? null,
      // EQ5F-A. The immutable equipment snapshot names the club this analysis
      // was taken with; the legacy video string remains the fallback for rows
      // recorded before snapshots existed. The card's own filename/"Untitled
      // Swing" floor below is unchanged.
      club:         getHistoricalEquipmentDisplayName(r.equipment_snapshot) ?? video?.club ?? null,
      filename:     video?.original_filename ?? null,
      bio,
      // S6-R1: value and source from the read authority, never the raw columns.
      estimates:    presentFullSwingMetrics(r.full_swing_metrics),
      highlights:   rawHL.map((h) => typeof h.positive_movement === "string" ? h.positive_movement : "").filter(Boolean),
      deficiencies: rawDF.map((d) => typeof d.fault_description === "string" ? d.fault_description : "").filter(Boolean),
    };
  });

  // `created_at` is retained as the RangeLog field name so the existing cards
  // and timeline merge are untouched, but it is sourced solely from the
  // validated `completed_at` database value. Rows whose id, session_type,
  // completed_at, or exercise_data fail validation are omitted rather than
  // rendered with fabricated values.
  const rangeLogs: RangeLog[] = (rangeResult.data ?? []).flatMap((r) => {
    const metrics = parseRangeMetrics(r.exercise_data);
    if (metrics === null) return [];
    if (typeof r.id !== "string") return [];
    if (typeof r.session_type !== "string") return [];
    if (typeof r.completed_at !== "string") return [];

    return [{
      id:              r.id,
      created_at:      r.completed_at,
      session_type:    r.session_type,
      shots_total:     metrics.shots_total,
      shots_executed:  metrics.shots_executed,
      completion_rate: metrics.completion_rate,
    }];
  });

  // Merge chronologically
  type TimelineItem =
    | { kind: "swing"; created_at: string; data: SwingLog }
    | { kind: "range"; created_at: string; data: RangeLog };

  const timeline: TimelineItem[] = [
    ...swingLogs.map((d) => ({ kind: "swing" as const, created_at: d.created_at, data: d })),
    ...rangeLogs.map((d) => ({ kind: "range" as const, created_at: d.created_at, data: d })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // EQ5C-C. Numerator and denominator must describe the same observations.
  // The previous form summed only rows that carried a score but divided by
  // every completed row, so a completed analysis with no score quietly pulled
  // the average down. An absent score is not a zero.
  const scoreObservations = swingLogs.flatMap((s) =>
    typeof s.score === "number" && Number.isFinite(s.score) ? [s.score] : [],
  );
  const avgScore = scoreObservations.length
    ? Math.round(scoreObservations.reduce((total, value) => total + value, 0) / scoreObservations.length)
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
          <p className="text-[10px] text-gray-600 mt-1.5 leading-relaxed">
            Full-swing telemetry only. Putting analyses remain available in Progress Hub.
          </p>
        </div>

        <div className="flex gap-2 mt-1">
          <Link href="/range" className="min-h-11 px-4 py-2.5 border border-white/10 text-gray-400 hover:text-white hover:border-white/20 rounded-xl font-black flex items-center gap-2 text-[10px] uppercase tracking-widest transition-all">
            <Target size={13} />Range
          </Link>
          <Link href="/analyze" className="min-h-11 px-4 py-2.5 bg-golf-green text-golf-dark rounded-xl font-black flex items-center gap-2 hover:bg-[#22C55E] transition-all text-[10px] uppercase tracking-widest">
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
            <Link href="/range" className="inline-flex items-center justify-center min-h-11 px-4 py-2.5 border border-white/10 text-gray-400 rounded-xl font-black text-[9px] uppercase tracking-widest hover:text-white transition-all">Start Range Session</Link>
            <Link href="/analyze" className="inline-flex items-center justify-center min-h-11 px-4 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all">Upload First Swing</Link>
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
