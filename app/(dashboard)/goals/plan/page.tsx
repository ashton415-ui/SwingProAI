import { redirect } from "next/navigation";
import { getServerSession, createClient } from "@/utils/supabase/server";
import PlanDisplay from "./PlanDisplay";
import GoalsLoadError from "@/components/goals/GoalsLoadError";
import {
  GOAL_PLAN_COLUMNS,
  GOALS_COPY,
  goalContextLine,
  readLatestGoal,
} from "@/lib/golfer-journey-goals-read-state";

export const metadata = { title: "Your AI Plan — SwingProAI" };

export default async function GoalsPlanPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // GJ-PARALLEL-03: the same latest-goal read (table, owner, newest first, one
  // row) as a bounded list, so a failed read, a confirmed "no goals" and a
  // stored plan that cannot be shown stay three different facts. The client is
  // built inside the read, after the session decision above.
  const latest = await readLatestGoal(async () => {
    const supabase = await createClient();
    return supabase
      .from("user_goals")
      .select(GOAL_PLAN_COLUMNS)
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(1);
  });

  const hasSavedGoal = latest.status === "goal" || latest.status === "plan" || latest.status === "unreadable";
  const contextLine = hasSavedGoal ? goalContextLine(latest.context) : "";

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{GOALS_COPY.entryTitle}</p>
            <h1 id="my-goals-heading" tabIndex={-1} className="text-2xl font-bold text-white tracking-tight focus:outline-none">
              {GOALS_COPY.planTitle}
            </h1>
            {contextLine && (
              <p className="text-sm text-gray-400 mt-1 max-w-lg break-words">
                {GOALS_COPY.answersPrefix}
                {contextLine}
              </p>
            )}
          </div>
          {(latest.status === "goal" || latest.status === "plan") && (
            // A document link on purpose: it leaves Next's client router cache behind, so Back, the form's own
            // post-submit landing and "Back to My Goals" all render the current saved plan fresh.
            <a
              href="/goals?new=1"
              className="shrink-0 self-start inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl border border-white/10 text-sm font-medium text-gray-300 transition-colors hover:text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
            >
              {GOALS_COPY.setNewGoals}
            </a>
          )}
        </div>

        {latest.status === "unavailable" || latest.status === "unreadable" ? (
          // keyed on the state, so a change between the two starts a fresh panel (no "still" wording carried over)
          <GoalsLoadError key={latest.status} variant={latest.status} />
        ) : (
          <PlanDisplay
            key={latest.status === "none" ? "no-goals" : latest.planKey}
            initialSyllabus={latest.status === "plan" ? latest.plan : null}
            hasGoals={latest.status !== "none"}
          />
        )}
      </div>
    </div>
  );
}
