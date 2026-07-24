import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { Calendar, Video } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminSwingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "admin") redirect("/dashboard");

  const { data: videos } = await supabase
    .from("swing_videos")
    .select("id, user_id, status, original_filename, file_size, created_at, club")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-8">All Swing Videos</h1>

      <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
        {!videos?.length ? (
          <div className="py-20 text-center text-gray-700 font-mono text-[10px] uppercase tracking-widest">No videos yet</div>
        ) : (
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left min-w-[760px]">
              <thead>
                <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                  <th className="px-6 py-4">File</th>
                  <th className="px-6 py-4">Club</th>
                  <th className="px-6 py-4">Size</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {videos.map((v) => (
                  <tr key={v.id} className="hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Video size={14} className="text-gray-600 shrink-0" />
                        <span className="text-sm text-gray-300 truncate max-w-[200px]">{v.original_filename ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4"><span className="text-xs text-gray-400 capitalize">{v.club ?? "—"}</span></td>
                    <td className="px-6 py-4">
                      <span className="text-xs font-mono text-gray-500">
                        {v.file_size ? `${(v.file_size / (1024 * 1024)).toFixed(1)} MB` : "—"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${
                        v.status === "complete" ? "text-golf-green bg-golf-green/10 border-golf-green/20" :
                        v.status === "uploaded" ? "text-blue-400 bg-blue-500/10 border-blue-500/20" :
                        "text-gray-600 bg-white/5 border-white/10"
                      }`}>{v.status}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5 text-xs font-mono text-gray-600">
                        <Calendar size={11} />
                        {new Date(v.created_at).toLocaleDateString()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
