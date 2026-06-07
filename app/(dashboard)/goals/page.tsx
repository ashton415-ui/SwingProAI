import { redirect } from "next/navigation";
import { getServerSession } from "@/utils/supabase/server";
import GoalsForm from "./GoalsForm";

export const metadata = { title: "Set Your Goals — SwingProAI" };

export default async function GoalsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-black italic tracking-tighter uppercase text-white">
          Set Your Goals
        </h1>
        <p className="text-sm text-gray-400 mt-2 max-w-sm mx-auto">
          Answer three quick questions and we&apos;ll build a personalized
          AI practice syllabus for your game.
        </p>
      </div>
      <GoalsForm />
    </div>
  );
}
