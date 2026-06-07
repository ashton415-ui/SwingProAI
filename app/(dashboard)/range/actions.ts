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

  console.log("[saveRangeSession] inserting:", {
    user_id: user.id,
    session_type: data.sessionType,
    shots_total: data.shotsTotal,
    shots_executed: data.shotsExecuted,
    completion_rate: completionRate,
  });

  const { error: insertError } = await supabase.from("range_sessions").insert({
    user_id: user.id,
    session_type: data.sessionType,
    shots_total: data.shotsTotal,
    shots_executed: data.shotsExecuted,
    completion_rate: completionRate,
  });

  if (insertError) {
    console.error("[saveRangeSession] Insert error:", insertError.message, insertError.details);
    return { error: insertError.message };
  }

  return {};
}
