import { redirect } from "next/navigation";
import { getServerSession } from "@/utils/supabase/server";
import RangeDashboard from "./RangeDashboard";

export const metadata = { title: "Practice Range — SwingProAI" };

export default async function RangePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white tracking-tight">Practice Range</h1>
        <p className="text-sm text-gray-400 mt-1">
          Choose a session template and work through structured reps. Each shot
          is guided — answer honestly to track your execution rate.
        </p>
      </div>
      <RangeDashboard />
    </div>
  );
}
