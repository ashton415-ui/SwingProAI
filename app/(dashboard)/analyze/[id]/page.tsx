import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AnalysisReport, { type AnalysisData } from "./AnalysisReport";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export const dynamic = "force-dynamic";

const BUCKET = "swing-videos";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  return { title: `Swing Analysis ${id.slice(0, 8)}… — SwingProAI` };
}

export default async function AnalysisPage({ params }: Props) {
  const { id } = await params;

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

  // Get a short-lived signed URL so the video can be played in the browser
  let videoSignedUrl: string | null = null;
  const storagePath = (row.swing_video as { storage_path: string | null } | null)?.storage_path;

  if (storagePath) {
    const { data: signed } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 3600); // 1-hour TTL
    videoSignedUrl = signed?.signedUrl ?? null;
  }

  // Fall back to stored video_url if no signed URL
  if (!videoSignedUrl) {
    videoSignedUrl = (row.swing_video as { video_url: string } | null)?.video_url ?? null;
  }

  const analysis = row as unknown as AnalysisData;

  const formattedDate = row.swing_video
    ? new Date((row.swing_video as { created_at: string }).created_at).toLocaleDateString("en-US", {
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
            {[(row.swing_video as { club: string | null } | null)?.club, formattedDate]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>

      <AnalysisReport analysis={analysis} videoSignedUrl={videoSignedUrl} />
    </div>
  );
}
