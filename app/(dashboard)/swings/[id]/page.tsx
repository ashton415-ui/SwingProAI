import { createClient } from "@/utils/supabase/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle, AlertTriangle, Zap } from "lucide-react";

export default async function SwingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: swing } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(club_type, duration_sec, created_at, status)")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (!swing) notFound();

  const metrics = [
    { label: "Spine Angle", value: swing.spine_angle_deg, unit: "°", ideal: "28–35°" },
    { label: "Hip Rotation", value: swing.hip_rotation_deg, unit: "°", ideal: "45–55°" },
    { label: "Shoulder Rotation", value: swing.shoulder_rotation_deg, unit: "°", ideal: "90–110°" },
    { label: "Wrist Hinge", value: swing.wrist_hinge_deg, unit: "°", ideal: "80–90°" },
    { label: "Tempo Ratio", value: swing.tempo_ratio, unit: ":1", ideal: "3.0 : 1" },
    { label: "Swing Plane", value: swing.swing_plane_deg, unit: "°", ideal: "45–60°" },
  ];

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
          {swing.swing_video?.club_type ?? "Swing"} Analysis
        </h1>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-2">
          {new Date(swing.created_at).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric", year: "numeric",
          })}
        </p>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        {metrics.map((m) => (
          <div key={m.label} className="bg-golf-surface border border-white/5 rounded-4xl p-6">
            <p className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-3">{m.label}</p>
            <p className="text-3xl font-mono font-black italic text-white tracking-tighter">
              {m.value != null ? `${m.value}${m.unit}` : "—"}
            </p>
            <p className="text-[9px] text-golf-green font-bold uppercase mt-2 tracking-widest">
              Ideal: {m.ideal}
            </p>
          </div>
        ))}
      </div>

      {/* AI Summary */}
      {swing.summary && (
        <div className="bg-black/40 border border-golf-green/20 rounded-5xl p-8 mb-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-6 opacity-5">
            <Zap className="w-20 h-20 text-golf-green" />
          </div>
          <h3 className="text-[10px] font-black text-golf-green uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
            <Zap size={12} />
            AI Coach Summary
          </h3>
          <p className="text-gray-300 leading-relaxed text-sm">{swing.summary}</p>
        </div>
      )}

      {/* Suggestions */}
      {swing.suggestions && swing.suggestions.length > 0 && (
        <div className="bg-golf-surface border border-white/5 rounded-5xl p-8">
          <h3 className="text-[10px] font-black text-white uppercase tracking-widest mb-6">
            Improvement Protocols
          </h3>
          <ul className="space-y-4">
            {swing.suggestions.map((tip: string, i: number) => (
              <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                <CheckCircle size={16} className="text-golf-green mt-0.5 shrink-0" />
                {tip}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Processing state */}
      {swing.swing_video?.status === "processing" && (
        <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-4xl p-6 mt-6">
          <AlertTriangle size={18} className="text-yellow-400 shrink-0" />
          <p className="text-yellow-300 text-xs font-bold uppercase tracking-wide">
            Telemetry processing in progress — full analysis incoming shortly.
          </p>
        </div>
      )}
    </div>
  );
}
