import { redirect } from "next/navigation";
import { getServerSession, createClient } from "@/utils/supabase/server";
import PlanDisplay from "./PlanDisplay";
import type { SyllabusData } from "../types";

export const metadata = { title: "Your AI Plan — SwingProAI" };

export default async function GoalsPlanPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();

  const { data: goalRow } = await supabase
    .from("user_goals")
    .select("handicap_baseline, primary_miss, target_goal, ai_syllabus")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  // ai_syllabus is JSONB — Supabase returns it as a parsed object.
  // Guard against text serialisation just in case.
  let syllabus: SyllabusData | null = null;
  if (goalRow?.ai_syllabus) {
    try {
      syllabus =
        typeof goalRow.ai_syllabus === "string"
          ? (JSON.parse(goalRow.ai_syllabus) as SyllabusData)
          : (goalRow.ai_syllabus as SyllabusData);
    } catch {
      // malformed — fall through to generate prompt
    }
  }

  const subtitleParts: string[] = [];
  if (goalRow?.handicap_baseline != null)
    subtitleParts.push(`Handicap ${goalRow.handicap_baseline}`);
  if (goalRow?.primary_miss && goalRow.primary_miss !== "None")
    subtitleParts.push(`Primary miss: ${goalRow.primary_miss}`);
  if (goalRow?.target_goal)
    subtitleParts.push(goalRow.target_goal);

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white tracking-tight">Your AI Plan</h1>
        {subtitleParts.length > 0 && (
          <p className="text-sm text-gray-400 mt-1 max-w-lg truncate">
            {subtitleParts.join(" · ")}
          </p>
        )}
      </div>

      <PlanDisplay
        initialSyllabus={syllabus}
        hasGoals={!!goalRow}
      />
    </div>
  );
}
