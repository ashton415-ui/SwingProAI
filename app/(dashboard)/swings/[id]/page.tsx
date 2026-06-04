import { createClient } from "@/utils/supabase/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle, AlertTriangle, Zap, Clock } from "lucide-react";

export default async function SwingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user ?? null;
  if (!user) redirect("/login");

  const { data: swing } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(club, title, recorded_at, created_at, status, original_filename)")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (!swing) notFound();

  // Extract individual metrics from the jsonb metrics field
  const metrics = swing.metrics as Record<string, number> | null;

  const metricCards = [
    { label: "Swing Score", value: swing.score, unit: " pts", ideal: "80–100 pts" },
    { label: "Tempo Ratio", value: swing.tempo_ratio, unit: ":1", ideal: "3.0 : 1" },
    { label: "Swing Speed", value: swing.swing_speed_mph, unit: " mph", ideal: "90–110 mph" },
    { label: "Spine Angle", value: metrics?.spine_angle_deg ?? null, unit: "°", ideal: "28–35°" },
    { label: "Hip Rotation", value: metrics?.hip_rotation_deg ?? null, unit: "°", ideal: "45–55°" },
    { label: "Shoulder Rotation", value: metrics?.shoulder_rotation_deg ?? null, unit: "°", ideal: "90–110°" },
  ];

  // Parse suggestions from feedback or metrics
  const suggestions = metrics?.suggestions
    ? (metrics.suggestions as unknown as string[])
    : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 text-gray-600 hover:text-white mb-8 transition-colors text-[10px] font-black uppercase tracking-widest"
      >
        <ArrowLeft size={14} />
        Back to Hub
      </Link>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl md:text-5xl font-black italic tracking-tighter text-white uppercase capitalize">
          {swing.swing_video?.club ?? swing.swing_video?.title ?? "Swing"} Analysis
        </h1>
        <div className="flex items-center gap-3 mt-2">
          <Clock size={12} className="text-gray-600" />
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500">
            {new Date(swing.created_at).toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric", year: "numeric",
            })}
          </p>
          {swing.swing_video?.original_filename && (
            <span className="text-[9px] font-mono text-gray-700 bg-white/5 px-2 py-0.5 rounded-full">
              {swing.swing_video.original_filename}
            </span>
          )}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        {metricCards.map((m) => (
          <div key={m.label} className="bg-golf-surface border border-white/5 rounded-4xl p-6">
            <p className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-3">{m.label}</p>
            <p className={`text-3xl font-mono font-black italic tracking-tighter ${
              m.label === "Swing Score"
                ? (m.value ?? 0) >= 80
                  ? "text-golf-green"
                  : (m.value ?? 0) >= 60
                  ? "text-yellow-400"
                  : "text-red-400"
                : "text-white"
            }`}>
              {m.value != null ? `${m.value}${m.unit}` : "—"}
            </p>
            <p className="text-[9px] text-golf-green font-bold uppercase mt-2 tracking-widest">
              Ideal: {m.ideal}
            </p>
          </div>
        ))}
      </div>

      {/* AI Feedback */}
      {swing.feedback && (
        <div className="bg-black/40 border border-golf-green/20 rounded-5xl p-8 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-6 opacity-5">
            <Zap className="w-20 h-20 text-golf-green" />
          </div>
          <h3 className="text-[10px] font-black text-golf-green uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
            <Zap size={12} />
            AI Coach Feedback
          </h3>
          <p className="text-gray-300 leading-relaxed text-sm">{swing.feedback}</p>
        </div>
      )}

      {/* Suggestions from metrics jsonb */}
      {suggestions && suggestions.length > 0 && (
        <div className="bg-golf-surface border border-white/5 rounded-5xl p-8 mb-6">
          <h3 className="text-[10px] font-black text-white uppercase tracking-widest mb-6">
            Improvement Protocols
          </h3>
          <ul className="space-y-4">
            {suggestions.map((tip: string, i: number) => (
              <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                <CheckCircle size={16} className="text-golf-green mt-0.5 shrink-0" />
                {tip}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Raw metrics dump (dev aid — only when metrics exist) */}
      {metrics && Object.keys(metrics).length > 0 && !suggestions && (
        <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 mb-6">
          <h3 className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-4">
            Raw Telemetry
          </h3>
          <pre className="text-[10px] font-mono text-gray-500 overflow-x-auto">
            {JSON.stringify(metrics, null, 2)}
          </pre>
        </div>
      )}

      {/* Processing / pending state */}
      {swing.status === "processing" && (
        <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-4xl p-6">
          <AlertTriangle size={18} className="text-yellow-400 shrink-0" />
          <p className="text-yellow-300 text-xs font-bold uppercase tracking-wide">
            AI analysis in progress — full results incoming shortly.
          </p>
        </div>
      )}

      {swing.status === "pending" && (
        <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-4xl p-6">
          <AlertTriangle size={18} className="text-gray-500 shrink-0" />
          <p className="text-gray-500 text-xs font-bold uppercase tracking-wide">
            Analysis queued — awaiting AI processing.
          </p>
        </div>
      )}
    </div>
  );
}
