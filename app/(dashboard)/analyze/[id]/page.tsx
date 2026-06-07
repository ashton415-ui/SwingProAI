import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AnalysisReport, { type AnalysisData } from "./AnalysisReport";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const BUCKET = "swing-videos";

interface SwingVideoRow {
  id: string;
  video_url: string;
  storage_path: string | null;
  original_filename: string | null;
  club: string | null;
  created_at: string;
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  return { title: `Swing Analysis ${params.id.slice(0, 8)}… — SwingProAI` };
}

export default async function AnalysisPage({ params }: { params: { id: string } }) {
  const { id } = params;

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  // Fetch analysis + joined video
  const { data: row, error } = await supabase
    .from("swing_analysis")
    .select(`
      id, status, score, feedback,
      swing_highlights, mechanical_deficiencies, metrics,
      swing_video:swing_videos (
        id, video_url, storage_path, original_filename, club, created_at
      )
    `)
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !row) notFound();

  // Supabase infers the nested join as array — cast through unknown to the real shape
  const video = (row.swing_video as unknown as SwingVideoRow | SwingVideoRow[] | null);
  const videoRow: SwingVideoRow | null = Array.isArray(video) ? (video[0] ?? null) : video;

  // Generate a 1-hour signed URL for in-browser video playback
  let videoSignedUrl: string | null = null;
  if (videoRow?.storage_path) {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(videoRow.storage_path, 3600);
    videoSignedUrl = signed?.signedUrl ?? null;
  }
  if (!videoSignedUrl && videoRow?.video_url) {
    videoSignedUrl = videoRow.video_url;
  }

  const analysis: AnalysisData = {
    id: row.id,
    status: row.status,
    score: row.score ?? null,
    feedback: row.feedback ?? null,
    swing_highlights: (row.swing_highlights as AnalysisData["swing_highlights"]) ?? null,
    mechanical_deficiencies: (row.mechanical_deficiencies as AnalysisData["mechanical_deficiencies"]) ?? null,
    metrics: (row.metrics as AnalysisData["metrics"]) ?? null,
    swing_video: videoRow,
  };

  const formattedDate = videoRow?.created_at
    ? new Date(videoRow.created_at).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })
    : null;

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      {/* Header */}
      <div className="flex items-start gap-4 mb-8">
        <Link
          href="/swings"
          className="mt-0.5 p-1.5 rounded-lg text-gray-600 hover:text-white hover:bg-white/5 transition-colors shrink-0"
          aria-label="Back to telemetry logs"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Swing Analysis</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {[videoRow?.club, formattedDate].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <AnalysisReport analysis={analysis} videoSignedUrl={videoSignedUrl} />
    </div>
  );
}
