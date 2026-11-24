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
// AG-WEB-READY-05-G1: each carries the account the page was rendered for (the form's one expected_owner_id entry; the
// plan view's one argument), forwarded untouched. The boundary requires it and compares it with the verified caller
// before any goal or provider work: a restriction on that caller, never a source of identity, credentials or a row.

/** Save the golfer's three answers, then try to generate and save a plan for that goal. */
export async function submitGoals(formData: FormData): Promise<SubmitResult> {
  return submitGoalAnswers(formData);
}

/** Generate (or regenerate) the plan for the golfer's latest goal, for the account the plan view was rendered for. */
export async function generateSyllabus(expectedOwnerId: string): Promise<GenerationResult> {
  return generateGoalPlan(expectedOwnerId);
}
