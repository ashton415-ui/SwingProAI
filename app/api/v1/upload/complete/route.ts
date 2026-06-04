import { NextRequest, NextResponse } from "next/server";
import { createClient, getServerSession } from "@/utils/supabase/server";

/**
 * POST /api/v1/upload/complete
 * Called after the browser uploads a video directly to Supabase Storage.
 * Creates the swing_videos DB record.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { storagePath, originalFilename, fileSize, mimeType, club, title, trimStart, trimEnd } =
    await req.json();

  if (!storagePath) {
    return NextResponse.json({ error: "Missing storagePath" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: video, error } = await supabase
    .from("swing_videos")
    .insert({
      user_id: session.user.id,
      storage_path: storagePath,
      video_url: storagePath,
      original_filename: originalFilename ?? null,
      file_size: fileSize ?? null,
      mime_type: mimeType ?? null,
      club: club ?? null,
      title: title ?? null,
      trim_start: trimStart ?? 0,
      trim_end: trimEnd ?? null,
      status: "uploaded",
    })
    .select()
    .single();

  if (error || !video) {
    console.error("DB insert error:", error);
    return NextResponse.json({ error: "Failed to save record" }, { status: 500 });
  }

  return NextResponse.json(
    { message: "Upload recorded", data: { swingVideoId: video.id } },
    { status: 201 }
  );
}
