import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

const ALLOWED_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const BUCKET = "swing-videos";

/**
 * POST /api/v1/upload
 * Accepts a swing video file via multipart/form-data.
 * Uploads to Supabase Storage using the service role key (server-side only).
 * Inserts a row into swing_videos with status = 'uploaded'.
 *
 * Form fields:
 *   - file: the video file (required)
 *   - club: club type, e.g. "driver" (optional)
 *   - title: session title (optional)
 */
export async function POST(req: NextRequest) {
  // 1. Authenticate user via Supabase JWT
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse multipart form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const club = (formData.get("club") as string) || null;
  const title = (formData.get("title") as string) || null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // 3. Validate file type
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "Invalid file type. Allowed: .mp4, .mov, .webm" },
      { status: 422 }
    );
  }

  // 4. Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 500MB." },
      { status: 422 }
    );
  }

  // 5. Generate swing_video ID first so we can use it in the storage path
  const swingVideoId = crypto.randomUUID();
  const originalFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${user.id}/${swingVideoId}/${originalFilename}`;

  // 6. Upload to Supabase Storage using admin client (service role — never sent to browser)
  const adminClient = createAdminClient();
  const fileBuffer = await file.arrayBuffer();

  const { error: uploadError } = await adminClient.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("Storage upload error:", uploadError);
    return NextResponse.json(
      { error: "Failed to upload video to storage" },
      { status: 500 }
    );
  }

  // 7. Insert swing_videos row (using user client to respect RLS)
  const { data: videoRow, error: insertError } = await supabase
    .from("swing_videos")
    .insert({
      id: swingVideoId,
      user_id: user.id,
      storage_path: storagePath,
      video_url: storagePath, // placeholder — generate signed URL on demand
      original_filename: originalFilename,
      file_size: file.size,
      mime_type: file.type,
      club: club,
      title: title,
      status: "uploaded",
    })
    .select()
    .single();

  if (insertError || !videoRow) {
    console.error("DB insert error:", insertError);
    // Clean up the uploaded file if DB insert fails
    await adminClient.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json(
      { error: "Failed to save video record" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      message: "Video uploaded successfully",
      data: {
        swingVideoId: videoRow.id,
        storagePath: videoRow.storage_path,
        status: videoRow.status,
      },
    },
    { status: 201 }
  );
}
