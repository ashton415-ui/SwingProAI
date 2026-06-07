"use server";

import { getServerSession, createClient } from "@/utils/supabase/server";

export async function submitGoals(
  formData: FormData
): Promise<{ error?: string }> {
  const session = await getServerSession();
  if (!session) return { error: "Not authenticated. Please sign in again." };

  const handicap_raw = formData.get("handicap_baseline") as string;
  const primary_miss = formData.get("primary_miss") as string;
  const target_goal = (formData.get("target_goal") as string).trim();

  const supabase = await createClient();

  const { error } = await supabase.from("user_goals").insert({
    user_id: session.user.id,
    handicap_baseline: handicap_raw !== "" ? parseFloat(handicap_raw) : null,
    primary_miss: primary_miss || null,
    target_goal: target_goal || null,
  });

  if (error) return { error: error.message };
  return {};
}
