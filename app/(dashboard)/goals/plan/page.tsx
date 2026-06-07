import { redirect } from "next/navigation";
import { getServerSession } from "@/utils/supabase/server";
import { Zap } from "lucide-react";

export const metadata = { title: "Your AI Plan — SwingProAI" };

export default async function GoalsPlanPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="p-6 lg:p-8 flex flex-col items-center justify-center min-h-[60vh]">
      <div className="w-14 h-14 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mb-6">
        <Zap className="w-7 h-7 text-golf-green" fill="currentColor" />
      </div>
      <h1 className="text-2xl font-black italic tracking-tighter uppercase text-white mb-3">
        Your Plan is Ready
      </h1>
      <p className="text-sm text-gray-400 text-center max-w-xs">
        Your AI-generated practice syllabus will appear here. This feature is
        coming soon.
      </p>
    </div>
  );
}
