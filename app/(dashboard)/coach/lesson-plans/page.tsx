import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { BookOpen, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CoachLessonPlansPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const supabase = await createClient();
  const { data: profile } = await supabase.from("users").select("role").eq("id", session.user.id).single();
  if (profile?.role !== "coach" && profile?.role !== "admin") redirect("/dashboard");

  const { data: plans } = await supabase
    .from("lesson_plans")
    .select("*, golfer:users!golfer_id(full_name, email)")
    .eq("coach_id", session.user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase">Lesson Plans</h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            {plans?.filter(p => p.status === "active").length ?? 0} active plans
          </p>
        </div>
        <button className="px-5 py-2.5 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] flex items-center gap-2 hover:bg-[#22C55E] transition-all">
          <Plus size={14} />New Plan
        </button>
      </div>

      <div className="space-y-3">
        {(!plans || plans.length === 0) ? (
          <div className="bg-golf-surface border border-white/5 rounded-4xl py-20 text-center text-gray-600 text-[10px] font-mono uppercase tracking-widest">
            No lesson plans yet
          </div>
        ) : plans.map((plan) => (
          <div key={plan.id} className="bg-golf-surface border border-white/5 rounded-4xl p-6 hover:border-golf-green/20 transition-colors">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-golf-green/10 rounded-2xl flex items-center justify-center shrink-0 mt-0.5">
                  <BookOpen size={16} className="text-golf-green" />
                </div>
                <div>
                  <p className="font-black text-white">{plan.title}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {plan.golfer?.full_name ?? "Unknown golfer"}
                    {plan.due_date && ` · Due ${new Date(plan.due_date).toLocaleDateString()}`}
                  </p>
                  {plan.description && (
                    <p className="text-sm text-gray-400 mt-2 line-clamp-2">{plan.description}</p>
                  )}
                  <div className="flex gap-2 mt-3">
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-600">
                      {Array.isArray(plan.goals) ? plan.goals.length : 0} goals
                    </span>
                    <span className="text-gray-700">·</span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-gray-600">
                      {Array.isArray(plan.drills) ? plan.drills.length : 0} drills
                    </span>
                  </div>
                </div>
              </div>
              <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border shrink-0 ${
                plan.status === "active"
                  ? "text-golf-green bg-golf-green/10 border-golf-green/20"
                  : "text-gray-600 bg-white/5 border-white/10"
              }`}>
                {plan.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
