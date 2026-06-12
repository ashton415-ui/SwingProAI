'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { createClient } from '@/utils/supabase/client';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  WifiOff,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type MetricKey = 'club_path_deg' | 'face_to_path_deg' | 'ball_speed_mph';

interface Session {
  id: string;
  session_date: string;
  club_path_deg: number | null;
  face_to_path_deg: number | null;
  ball_speed_mph: number | null;
  device_type: string | null;
}

interface MetricDef {
  key: MetricKey;
  label: string;
  unit: string;
  isPath: boolean;
  note: string;
}

interface ChartPoint {
  date: string;
  value: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const METRICS: MetricDef[] = [
  {
    key: 'club_path_deg',
    label: 'Club Path',
    unit: '°',
    isPath: true,
    note: 'Negative = out-to-in path · Positive = in-to-out path · Optimal: −3° to +3°',
  },
  {
    key: 'face_to_path_deg',
    label: 'Face to Path',
    unit: '°',
    isPath: true,
    note: 'Negative = closed face (draw) · Positive = open face (fade) · Optimal: −3° to +3°',
  },
  {
    key: 'ball_speed_mph',
    label: 'Ball Speed',
    unit: ' mph',
    isPath: false,
    note: 'Higher is better — reflects smash factor and impact efficiency.',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr + 'T12:00:00'), 'MMM d');
  } catch {
    return dateStr;
  }
}

function fmtValue(v: number | null | undefined, unit: string, isPath: boolean): string {
  if (v == null) return '—';
  if (isPath) {
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}${unit}`;
  }
  return `${Math.round(v)}${unit}`;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function ChartTooltip(props: unknown) {
  const p = props as {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
    unit: string;
    isPath: boolean;
  };
  if (!p.active || !p.payload?.length) return null;
  const v = p.payload[0].value;
  return (
    <div className="bg-slate-800 border border-white/10 rounded-xl px-3 py-2 shadow-xl">
      <p className="text-[10px] text-slate-500 mb-0.5 uppercase tracking-widest">{p.label}</p>
      <p className="text-sm font-bold text-white tabular-nums">
        {fmtValue(v, p.unit, p.isPath)}
      </p>
    </div>
  );
}

// ── Trend icon ────────────────────────────────────────────────────────────────

function TrendBadge({ delta }: { delta: number | null }) {
  if (delta === null) return <Minus className="w-3.5 h-3.5 text-slate-600" />;
  if (Math.abs(delta) < 0.3) return <Minus className="w-3.5 h-3.5 text-slate-400" />;
  if (delta > 0) return <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />;
  return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState<MetricKey>('club_path_deg');
  const [mounted, setMounted] = useState(false);

  // Mount guard — recharts uses DOM APIs unavailable during SSR pre-render
  useEffect(() => { setMounted(true); }, []);

  // Fetch sessions for the logged-in user, oldest first for correct chart order
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      const { data } = await supabase
        .from('launch_monitor_sessions')
        .select('id, session_date, club_path_deg, face_to_path_deg, ball_speed_mph, device_type')
        .eq('student_id', user.id)
        .order('session_date', { ascending: true })
        .order('created_at', { ascending: true });

      setSessions(data ?? []);
      setLoading(false);
    })();
  }, [supabase]);

  const metricDef = METRICS.find(m => m.key === activeKey)!;

  // Chart data: only sessions where this metric has a value
  const chartData: ChartPoint[] = useMemo(
    () =>
      sessions
        .filter(s => s[activeKey] !== null)
        .map(s => ({
          date: fmtDate(s.session_date),
          value: s[activeKey] as number,
        })),
    [sessions, activeKey],
  );

  // Derived stats
  const vals = chartData.map(d => d.value);
  const avgVal = avg(vals);
  const latest = vals.length > 0 ? vals[vals.length - 1] : null;
  const prev = vals.length > 1 ? vals[vals.length - 2] : null;
  const delta = latest !== null && prev !== null ? latest - prev : null;

  // Y-axis formatter
  const yFmt = useCallback(
    (v: number) =>
      metricDef.isPath
        ? `${v > 0 ? '+' : ''}${v.toFixed(0)}°`
        : `${Math.round(v)}`,
    [metricDef.isPath],
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Progress History</h1>
          <p className="text-sm text-slate-400 mt-1">Launch monitor trends over time.</p>
        </div>
        <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center shrink-0">
          <TrendingUp className="w-4 h-4 text-indigo-400" />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20" />
            <div className="absolute inset-0 rounded-full border-t-2 border-indigo-500 animate-spin" />
          </div>
          <p className="text-xs text-slate-500">Loading sessions…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && sessions.length === 0 && (
        <div className="bg-slate-900 border border-white/10 rounded-2xl px-6 py-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center mx-auto mb-4">
            <Activity className="w-6 h-6 text-indigo-400" />
          </div>
          <p className="text-base font-bold text-white mb-1">No sessions recorded yet</p>
          <p className="text-sm text-slate-500 max-w-xs mx-auto leading-relaxed">
            Your progress charts will appear once launch monitor data has been ingested for your account.
          </p>
          <div className="flex items-center justify-center gap-2 mt-5 px-4 py-2.5 bg-slate-800 border border-white/[0.07] rounded-xl mx-auto w-fit">
            <WifiOff className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <p className="text-xs text-slate-500">
              Ask your coach to upload a session, or connect your launch monitor.
            </p>
          </div>
        </div>
      )}

      {/* Chart section */}
      {!loading && sessions.length > 0 && (
        <>
          {/* Metric tab bar */}
          <div className="flex gap-1 p-1 bg-slate-900 border border-white/[0.07] rounded-xl">
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setActiveKey(m.key)}
                className={`flex-1 py-2 px-2 rounded-lg text-xs font-bold transition-all leading-tight ${
                  activeKey === m.key
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Stats + chart card */}
          <div className="bg-slate-900 border border-white/10 rounded-2xl overflow-hidden">

            {/* Stats row */}
            <div className="grid grid-cols-3 divide-x divide-white/[0.06] border-b border-white/[0.06]">
              <div className="px-4 sm:px-5 py-4">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1">Latest</p>
                <p className={`text-xl font-black tabular-nums ${
                  metricDef.isPath && latest !== null && Math.abs(latest) > 3
                    ? 'text-red-400'
                    : 'text-white'
                }`}>
                  {fmtValue(latest, metricDef.unit, metricDef.isPath)}
                </p>
              </div>

              <div className="px-4 sm:px-5 py-4">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1">Average</p>
                <p className="text-xl font-black tabular-nums text-white">
                  {fmtValue(avgVal, metricDef.unit, metricDef.isPath)}
                </p>
              </div>

              <div className="px-4 sm:px-5 py-4">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1">Sessions</p>
                <div className="flex items-center gap-2">
                  <p className="text-xl font-black tabular-nums text-white">{chartData.length}</p>
                  <TrendBadge delta={delta} />
                </div>
              </div>
            </div>

            {/* Chart */}
            <div className="pt-4 pb-1 pl-1 pr-3">
              {mounted && chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart
                    data={chartData}
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#475569', fontSize: 10, fontFamily: 'inherit' }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={yFmt}
                      tick={{ fill: '#475569', fontSize: 10, fontFamily: 'inherit' }}
                      tickLine={false}
                      axisLine={false}
                      width={36}
                    />
                    <Tooltip
                      // @ts-expect-error recharts injects active/payload/label at runtime
                      content={<ChartTooltip unit={metricDef.unit} isPath={metricDef.isPath} />}
                      cursor={{ stroke: '#1e293b', strokeWidth: 1 }}
                    />
                    {/* Zero-line anchor for path metrics */}
                    {metricDef.isPath && (
                      <ReferenceLine
                        y={0}
                        stroke="#334155"
                        strokeDasharray="4 3"
                        strokeWidth={1}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#6366f1"
                      strokeWidth={2}
                      dot={{ fill: '#6366f1', r: 3, strokeWidth: 0 }}
                      activeDot={{ fill: '#818cf8', r: 5, strokeWidth: 0 }}
                      animationDuration={500}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : chartData.length === 0 ? (
                <div className="h-[220px] flex items-center justify-center">
                  <p className="text-sm text-slate-600">
                    No {metricDef.label} data in recorded sessions.
                  </p>
                </div>
              ) : null}
            </div>

            {/* Metric annotation */}
            <div className="px-5 pb-4 pt-1">
              <p className="text-[10px] text-slate-600 leading-snug">{metricDef.note}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
