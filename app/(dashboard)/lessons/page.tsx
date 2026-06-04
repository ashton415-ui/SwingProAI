import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BookOpen, ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function LessonsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();

  const { data: plans } = await supabase
    .from("lesson_plans")
    .select("*, coach:users!coach_id(full_name, display_name)")
    .eq("golfer_id", session.user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase mb-2">My Lessons</h1>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-10">
        Lesson plans from your coach
      </p>

      {(!plans || plans.length === 0) ? (
        <div className="bg-golf-surface border border-white/5 rounded-5xl py-20 text-center">
          <BookOpen size={32} className="text-gray-700 mx-auto mb-4" />
          <p className="text-gray-600 text-[10px] font-mono uppercase tracking-widest">
            No lesson plans yet
          </p>
          <p className="text-gray-700 text-xs mt-2">Connect with a coach to receive lesson plans</p>
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => (
            <Link key={plan.id} href={`/lessons/${plan.id}`}
              className="block bg-golf-surface border border-white/5 rounded-4xl p-6 hover:border-golf-green/20 transition-colors group">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-golf-green/10 rounded-2xl flex items-center justify-center shrink-0">
                    <BookOpen size={16} className="text-golf-green" />
                  </div>
                  <div>
                    <p className="font-black text-white">{plan.title}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      From {plan.coach?.display_name ?? plan.coach?.full_name ?? "Your Coach"}
                      {plan.due_date && ` · Due ${new Date(plan.due_date).toLocaleDateString()}`}
                    </p>
                    {plan.description && (
                      <p className="text-sm text-gray-400 mt-2 line-clamp-2">{plan.description}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                    plan.status === "active" ? "text-golf-green bg-golf-green/10 border-golf-green/20"
                    : "text-gray-600 bg-white/5 border-white/10"
                  }`}>{plan.status}</span>
                  <ChevronRight size={16} className="text-gray-600 group-hover:text-golf-green transition-colors" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
