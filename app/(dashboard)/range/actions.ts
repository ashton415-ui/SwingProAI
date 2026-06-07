"use server";

import { getServerSession, createClient } from "@/utils/supabase/server";

export async function saveRangeSession(data: {
  sessionType: string;
  shotsTotal: number;
  shotsExecuted: number;
}): Promise<{ error?: string }> {
  const session = await getServerSession();
  if (!session) return { error: "Not authenticated." };

  const supabase = await createClient();

  const { error } = await supabase.from("range_sessions").insert({
    user_id: session.user.id,
    session_type: data.sessionType,
    shots_total: data.shotsTotal,
    shots_executed: data.shotsExecuted,
    completion_rate:
      data.shotsTotal > 0 ? data.shotsExecuted / data.shotsTotal : 0,
  });

  if (error) return { error: error.message };
  return {};
}
