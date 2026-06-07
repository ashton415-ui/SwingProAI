import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import RangeDashboard from "./RangeDashboard";

export const metadata = { title: "Practice Range — SwingProAI" };

export default async function RangePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white tracking-tight">Practice Range</h1>
        <p className="text-sm text-gray-400 mt-1">
          Choose a session mode and work through 20 guided shots. Answer honestly — your execution rate is tracked.
        </p>
      </div>
      <RangeDashboard />
    </div>
  );
}
