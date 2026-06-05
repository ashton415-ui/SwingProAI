import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { Video, MessageSquare } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CoachReviewsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "coach" && profile?.role !== "admin") redirect("/dashboard");

  const { data: feedback } = await supabase
    .from("coach_feedback")
    .select("*, swing_video:swing_videos(club, original_filename, created_at)")
    .eq("coach_id", session.user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-8">Swing Reviews</h1>

      <div className="space-y-3">
        {(!feedback || feedback.length === 0) ? (
          <div className="bg-golf-surface border border-white/5 rounded-5xl py-20 text-center">
            <MessageSquare size={32} className="text-gray-700 mx-auto mb-4" />
            <p className="text-gray-600 text-[10px] font-mono uppercase tracking-widest">No reviews submitted yet</p>
          </div>
        ) : feedback.map((f) => (
          <div key={f.id} className="bg-golf-surface border border-white/5 rounded-4xl p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-golf-green/10 rounded-2xl flex items-center justify-center shrink-0">
                <Video size={16} className="text-golf-green" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-black text-white capitalize">
                    {f.swing_video?.club ?? f.swing_video?.original_filename ?? "Swing"}
                  </p>
                  <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${
                    f.priority === "high" || f.priority === "critical"
                      ? "text-red-400 bg-red-500/10 border-red-500/20"
                      : "text-golf-green bg-golf-green/10 border-golf-green/20"
                  }`}>{f.priority ?? "standard"}</span>
                </div>
                <p className="text-sm text-gray-300">{f.feedback}</p>
                <p className="text-[9px] font-mono text-gray-600 mt-2">
                  {new Date(f.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
