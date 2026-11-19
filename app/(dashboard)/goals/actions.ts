"use server";

import {
  generateGoalPlan,
  submitGoalAnswers,
  type GenerationResult,
  type SubmitResult,
} from "@/lib/goal-plan-generation";

// AG-S1: thin Server Actions over the one goal-plan boundary (lib/goal-plan-generation.ts). Neither takes a
// goal id, user id or plan from the client: identity comes from the verified session, the goal row from an
// owner-scoped read or the confirmed insert, and the plan from the provider. Nothing about the golfer is logged here.

/** Save the golfer's three answers, then try to generate and save a plan for that goal. */
export async function submitGoals(formData: FormData): Promise<SubmitResult> {
  return submitGoalAnswers(formData);
}

/** Generate (or regenerate) the plan for the golfer's latest goal. */
export async function generateSyllabus(): Promise<GenerationResult> {
  return generateGoalPlan();
}
