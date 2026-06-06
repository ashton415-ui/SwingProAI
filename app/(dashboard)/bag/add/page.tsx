import { redirect } from "next/navigation";
import { getServerSession } from "@/utils/supabase/server";
import AddClubForm from "./AddClubForm";

export const metadata = { title: "Add Club — SwingProAI" };

export default async function AddClubPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">Add Club</h1>
          <p className="text-sm text-gray-400 mt-1">
            Add a club to your virtual bag to track per-club telemetry.
          </p>
        </div>
        <AddClubForm userId={session.user.id} />
      </div>
    </div>
  );
}
