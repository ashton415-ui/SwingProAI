import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { getHistoricalEquipmentDisplayName } from "@/lib/equipment/historical-equipment-display-name";
import { authorizeOwnedAnalysisRow } from "@/lib/analysis-result-read-authority";
import { classifyFailedAnalysisVideo, signOwnedSwingVideoPlayback } from "@/lib/swing-video-source";
import AnalysisReport, { type AnalysisData } from "./AnalysisReport";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export const dynamic = "force-dynamic";


interface SwingVideoRow {
  id: string;
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

  // Fetch analysis + joined video. ENT-1C: this session read proves ownership
  // and carries identity and core columns only; the result payload is read and
  // serialized by the unified result-read authority below. It must carry every
  // owner column (ANALYSIS_OWNER_COLUMNS): the authority takes score, feedback
  // and the measurements from this row, so a column left out here renders as
  // missing (a completed swing showed a score of 0 with no assessment).
  const { data: row, error } = await supabase
    .from("swing_analysis")
    .select(`
      id, swing_video_id, user_id, club_id, status, analysis_family, equipment_snapshot, analysis_mode, created_at,
      score, feedback, tempo_ratio, swing_speed_mph, spine_angle, hip_rotation, shoulder_rotation,
      swing_video:swing_videos (
        id, storage_path, original_filename, club, created_at
      )
    `)
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !row) notFound();

  // EQ5C-C. This is the legacy full-swing report route. A putting analysis has
  // no full-swing score, no full-swing biomechanics and no full-swing report to
  // render, so it is sent to the canonical family-aware result page rather than
  // dressed up as a swing report here.
  //
  // The redirect sits immediately after the owned-row boundary and ahead of
  // everything else on purpose: no signed video URL is minted and no legacy
  // AnalysisData payload is built for a putt. The canonical page at
  // /swings/[id] already owns putting result rendering and its entitlement, so
  // nothing about a putt is re-implemented here.
  //
  // Strict equality on purpose. Only "putting" leaves this route; null (legacy
  // rows written before the family column existed) and "full_swing" both keep
  // the established behaviour exactly.
  if (row.analysis_family === "putting") {
    redirect(`/swings/${row.id}`);
  }

  // Supabase infers the nested join as array — cast through unknown to the real shape
  const video = (row.swing_video as unknown as SwingVideoRow | SwingVideoRow[] | null);
  const videoRow: SwingVideoRow | null = Array.isArray(video) ? (video[0] ?? null) : video;

  // A 1-hour signed URL for in-browser playback of the golfer's own canonical
  // Storage object, or none. Browser-written video_url is never played back:
  // it is not a source (lib/swing-video-source.ts).
  const videoSignedUrl = await signOwnedSwingVideoPlayback(supabase, videoRow?.storage_path, user.id);

  // AnalysisData is a Client Component prop, so it is serialized to the browser
  // in full. Every result field below comes from the authorized view.
  const authorized = await authorizeOwnedAnalysisRow({ client: supabase, userId: user.id }, row);
  if (!authorized) throw new Error("Analysis result temporarily unavailable.");
  const view = authorized.result;

  const analysis: AnalysisData = {
    id: view.id,
    status: view.status,
    score: view.score,
    feedback: view.feedback,
    swing_highlights: view.swing_highlights,
    // A legacy string joint_coordinate renders through the report's own
    // `?.joint ?? checkpoint` fallback.
    mechanical_deficiencies: view.mechanical_deficiencies as unknown as AnalysisData["mechanical_deficiencies"],
    metrics: view.metrics as AnalysisData["metrics"],
    swing_video: videoRow,
  };

  // ENT-1D. A failed analysis whose stored video cannot be analysed is shown
  // the upload-again guidance at once, rather than a Retry that would only be
  // refused again. Decided from the object itself (no stored reason, no
  // provider call); a failure that may be temporary keeps its Retry.
  const failedReason =
    view.status === "failed"
      ? await classifyFailedAnalysisVideo(supabase, videoRow?.storage_path, user.id)
      : null;

  const formattedDate = videoRow?.created_at
    ? new Date(videoRow.created_at).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })
    : null;

  // EQ5F-A. Resolved once on the server, from the immutable equipment snapshot
  // written when this analysis was inserted, and handed to the report as a
  // finished string. The legacy swing_videos.club value remains the fallback for
  // rows captured before the snapshot existed.
  const clubDisplayName =
    getHistoricalEquipmentDisplayName(row.equipment_snapshot) ?? videoRow?.club ?? null;

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      {/* Header */}
      <div className="flex items-start gap-4 mb-8">
        <Link
          href="/swings"
          className="-mt-2 -ml-2 min-w-11 min-h-11 flex items-center justify-center rounded-lg text-gray-600 hover:text-white hover:bg-white/5 transition-colors shrink-0"
          aria-label="Back to telemetry logs"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Swing Analysis</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {[clubDisplayName, formattedDate].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <AnalysisReport
        analysis={analysis}
        videoSignedUrl={videoSignedUrl}
        clubDisplayName={clubDisplayName}
        failedReason={failedReason}
      />
    </div>
  );
}
