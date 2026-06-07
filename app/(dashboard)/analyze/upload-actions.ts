"use server";

import { createClient } from "@/utils/supabase/server";

const BUCKET = "swing-videos";

// ── Step 1: return a signed URL so the browser can upload directly to Supabase
// Storage (no video bytes transit the Next.js server, progress is trackable).

export async function getSignedUploadUrl(
  filename: string,
  contentType: string
): Promise<{ signedUrl?: string; path?: string; error?: string }> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[getSignedUploadUrl] user:", user?.id, "authError:", authError?.message);

  if (authError || !user) return { error: "Not authenticated." };

  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${user.id}/${Date.now()}_${safeFilename}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);

  console.log("[getSignedUploadUrl] signed URL error:", error?.message);

  if (error || !data?.signedUrl) {
    return { error: error?.message ?? "Could not create upload URL." };
  }

  return { signedUrl: data.signedUrl, path };
}

// ── Step 2: called after the browser XHR completes. Inserts swing_videos row
// (required for the FK) then swing_analysis row with status = "pending".

export async function recordPendingAnalysis(
  storagePath: string,
  originalFilename: string,
  fileSize: number,
  mimeType: string
): Promise<{ analysisId?: string; videoUrl?: string; error?: string }> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[recordPendingAnalysis] user:", user?.id, "authError:", authError?.message);

  if (authError || !user) return { error: "Not authenticated." };

  // Build the public URL for this storage object
  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  console.log("[recordPendingAnalysis] inserting swing_videos for user_id:", user.id);

  // 1 — swing_videos row (FK parent for swing_analysis)
  const { data: videoRow, error: videoErr } = await supabase
    .from("swing_videos")
    .insert({
      user_id: user.id,
      video_url: publicUrl,
      storage_path: storagePath,
      original_filename: originalFilename,
      file_size: fileSize,
      mime_type: mimeType,
      status: "uploaded",
    })
    .select("id")
    .single();

  console.log("[recordPendingAnalysis] swing_videos insert:", { videoRow, videoErr: videoErr?.message });

  if (videoErr || !videoRow) {
    return { error: videoErr?.message ?? "Failed to record video." };
  }

  // 2 — swing_analysis row with status "pending" (AI job will update this later)
  const { data: analysisRow, error: analysisErr } = await supabase
    .from("swing_analysis")
    .insert({
      user_id: user.id,
      swing_video_id: videoRow.id,
      status: "pending",
    })
    .select("id")
    .single();

  console.log("[recordPendingAnalysis] swing_analysis insert:", { analysisRow, analysisErr: analysisErr?.message });

  if (analysisErr || !analysisRow) {
    return { error: analysisErr?.message ?? "Failed to create analysis record." };
  }

  return { analysisId: analysisRow.id, videoUrl: publicUrl };
}
