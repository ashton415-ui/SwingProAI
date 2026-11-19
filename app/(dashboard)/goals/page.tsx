import { redirect } from "next/navigation";
import { createClient, getServerSession } from "@/utils/supabase/server";
import GoalsForm from "./GoalsForm";
import GoalsLoadError from "@/components/goals/GoalsLoadError";
import {
  GOAL_ENTRY_COLUMNS,
  GOALS_COPY,
  isNewGoalsRequest,
  readGoalEntry,
} from "@/lib/golfer-journey-goals-read-state";

export const metadata = { title: "My Goals — SwingProAI" };

const HEADING_CLASS = "text-3xl font-black italic tracking-tighter uppercase text-white focus:outline-none";

export default async function GoalsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // GJ-PARALLEL-03: "Set new goals" opens the unchanged form on purpose
  // (`/goals?new=1`). A display choice only: no read, no write, and nothing
  // changes until the form's own submit.
  if (isNewGoalsRequest(searchParams)) {
    return (
      <div className="p-6 lg:p-8">
        <div className="mb-10 text-center">
          <h1 id="my-goals-heading" tabIndex={-1} className={HEADING_CLASS}>
            {GOALS_COPY.newGoalsTitle}
          </h1>
          <p className="text-sm text-gray-400 mt-2 max-w-sm mx-auto">{GOALS_COPY.newGoalsBody}</p>
          {/* a document link on purpose (fresh render of My Goals, no cached client view) */}
          <a
            href="/goals"
            className="mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-4 rounded-xl border border-white/10 text-sm font-medium text-gray-300 transition-colors hover:text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            {GOALS_COPY.backToGoals}
          </a>
        </div>
        <GoalsForm />
      </div>
    );
  }

  // My Goals: a golfer with a saved goal goes to their saved plan; a confirmed
  // "no goals" gets the goals form; a failed read is said plainly. The client
  // is built inside the read, after the session decision above.
  const entry = await readGoalEntry(async () => {
    const supabase = await createClient();
    return supabase
      .from("user_goals")
      .select(GOAL_ENTRY_COLUMNS)
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(1);
  });
  if (entry.status === "saved") redirect("/goals/plan");

  if (entry.status === "unavailable") {
    return (
      <div className="p-6 lg:p-8">
        <div className="max-w-2xl mx-auto">
          <h1 id="my-goals-heading" tabIndex={-1} className="mb-8 text-2xl font-bold text-white tracking-tight focus:outline-none">
            {GOALS_COPY.entryTitle}
          </h1>
          <GoalsLoadError variant="unavailable" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-10 text-center">
        <h1 id="my-goals-heading" tabIndex={-1} className={HEADING_CLASS}>
          Set Your Goals
        </h1>
        <p className="text-sm text-gray-400 mt-2 max-w-sm mx-auto">
          Answer three quick questions and we&apos;ll build a personalized
          AI practice plan for your game.
        </p>
      </div>
      <GoalsForm />
    </div>
  );
}
