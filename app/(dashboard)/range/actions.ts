"use server";

import { createClient } from "@/utils/supabase/server";

export async function saveRangeSession(data: {
  sessionType: string;
  shotsTotal: number;
  shotsExecuted: number;
}): Promise<{ error?: string }> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[saveRangeSession] user:", user?.id, "authError:", authError?.message);

  if (authError || !user) {
    console.error("[saveRangeSession] Auth failed — no user.");
    return { error: "Not authenticated." };
  }

  const completionRate =
    data.shotsTotal > 0 ? data.shotsExecuted / data.shotsTotal : 0;

  // The canonical range_sessions table stores per-session metrics inside the
  // exercise_data jsonb column. There are no shots_total, shots_executed or
  // completion_rate columns. completed_at is omitted so the database default
  // now() supplies the timestamp.
  const exerciseData = {
    shots_total: data.shotsTotal,
    shots_executed: data.shotsExecuted,
    completion_rate: completionRate,
  };

  console.log("[saveRangeSession] inserting:", {
    user_id: user.id,
    session_type: data.sessionType,
    exercise_data: exerciseData,
  });

  const { error: insertError } = await supabase.from("range_sessions").insert({
    user_id: user.id,
    session_type: data.sessionType,
    exercise_data: exerciseData,
  });

  if (insertError) {
    console.error("[saveRangeSession] Insert error:", insertError.message, insertError.details);
    return { error: insertError.message };
  }

  return {};
}
