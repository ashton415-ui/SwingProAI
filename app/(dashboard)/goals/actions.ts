"use server";

import OpenAI from "openai";
import { createClient } from "@/utils/supabase/server";
import type { SyllabusData } from "./types";

// ── Shared JSON schema for OpenAI Structured Outputs ─────────────────────────

const SYLLABUS_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "2-3 sentence overview of the plan rationale and expected outcome.",
    },
    weeks: {
      type: "array",
      description: "Exactly 4 weekly blocks, progressing from foundation to competition prep.",
      items: {
        type: "object",
        properties: {
          week: { type: "integer", description: "Week number 1-4." },
          theme: {
            type: "string",
            description: "Short catchy name for the week, e.g. 'Foundation & Fault Diagnosis'.",
          },
          focus: {
            type: "string",
            description: "Primary technical area for this week.",
          },
          drills: {
            type: "array",
            description: "3-5 specific, executable drills.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Specific named drill." },
                description: {
                  type: "string",
                  description: "Clear, actionable instruction in 2-3 sentences.",
                },
                duration: {
                  type: "string",
                  description: "e.g. '20 min', '50 reps', '3 sets × 15 swings'.",
                },
                category: {
                  type: "string",
                  enum: ["driving", "irons", "short_game", "putting", "mental"],
                },
              },
              required: ["name", "description", "duration", "category"],
              additionalProperties: false,
            },
          },
          weekly_goal: {
            type: "string",
            description: "Measurable, observable outcome to achieve by end of week.",
          },
          pro_tip: {
            type: "string",
            description: "One elite-level insight or swing thought for the week.",
          },
        },
        required: ["week", "theme", "focus", "drills", "weekly_goal", "pro_tip"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "weeks"],
  additionalProperties: false,
} as const;

// ── Shared prompt builder ─────────────────────────────────────────────────────

function buildMessages(
  handicap: number | null,
  primaryMiss: string | null,
  targetGoal: string | null
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: `You are an expert PGA golf instructor and sports performance coach specialising in structured practice design.

Generate a personalised 4-week golf practice plan tailored to the golfer's exact profile.

Rules:
- Exactly 4 weeks in the plan
- Each week has 3-5 drills
- Logical progression: Week 1 = diagnosis & foundation, Week 2 = pattern building, Week 3 = feel & variability, Week 4 = pressure simulation & competition prep
- All drills must be executable at a practice range without special equipment
- Tailor every detail — drill names, cues, focus areas — to the golfer's specific handicap, miss pattern, and goal`,
    },
    {
      role: "user",
      content: `Generate a 4-week personalised golf practice plan for this golfer:

Handicap Index: ${handicap != null ? handicap : "Unknown (assume ~18)"}
Primary miss: ${primaryMiss ?? "None specified"}
Target goal: ${targetGoal ?? "General improvement"}`,
    },
  ];
}

// ── Internal AI call ──────────────────────────────────────────────────────────

async function callOpenAI(
  handicap: number | null,
  primaryMiss: string | null,
  targetGoal: string | null
): Promise<{ syllabus?: SyllabusData; error?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "AI service is not configured." };

  const openai = new OpenAI({ apiKey });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: buildMessages(handicap, primaryMiss, targetGoal),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "golf_lesson_plan",
          strict: true,
          schema: SYLLABUS_SCHEMA,
        },
      },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { error: "Empty response from AI. Please try again." };

    let syllabus: SyllabusData;
    try {
      syllabus = JSON.parse(raw) as SyllabusData;
    } catch {
      return { error: "AI returned malformed JSON. Please try again." };
    }

    if (!Array.isArray(syllabus?.weeks) || syllabus.weeks.length === 0) {
      return { error: "AI returned an incomplete plan. Please try again." };
    }

    return { syllabus };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { error: `AI service error: ${msg}` };
  }
}

// ── submitGoals — insert goals + generate syllabus in one shot ────────────────

export async function submitGoals(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();

  // Use getUser() so the auth JWT is validated server-side and auth.uid() is
  // guaranteed to match the session that createClient() embedded in the header.
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[submitGoals] user:", JSON.stringify(user));
  console.log("[submitGoals] authError:", authError);

  if (authError || !user) {
    console.error("[submitGoals] Auth failed — no user.", authError?.message);
    return { error: "Not authenticated. Please sign in again." };
  }

  const handicap_raw = formData.get("handicap_baseline") as string;
  const primary_miss = formData.get("primary_miss") as string;
  const target_goal = (formData.get("target_goal") as string).trim();

  const handicap_baseline =
    handicap_raw !== "" ? parseFloat(handicap_raw) : null;

  console.log("[submitGoals] inserting for user_id:", user.id, {
    handicap_baseline,
    primary_miss,
    target_goal,
  });

  // Insert the goals row and get back its id
  const { data: inserted, error: insertError } = await supabase
    .from("user_goals")
    .insert({
      user_id: user.id,
      handicap_baseline,
      primary_miss: primary_miss || null,
      target_goal: target_goal || null,
    })
    .select("id")
    .single();

  console.log("[submitGoals] insert result:", { inserted, insertError });

  if (insertError) {
    console.error("[submitGoals] Insert error:", insertError.message, insertError.details, insertError.hint);
    return { error: insertError.message };
  }

  // Generate syllabus immediately — if AI fails, the row still exists and
  // the plan page will offer a regenerate button.
  const { syllabus } = await callOpenAI(
    handicap_baseline,
    primary_miss || null,
    target_goal || null
  );

  if (syllabus && inserted?.id) {
    const { error: updateError } = await supabase
      .from("user_goals")
      .update({ ai_syllabus: syllabus })
      .eq("id", inserted.id);
    if (updateError) {
      console.error("[submitGoals] Syllabus update error:", updateError.message);
    }
  }

  return {};
}

// ── generateSyllabus — regenerate from the plan page ─────────────────────────

export async function generateSyllabus(): Promise<{
  syllabus?: SyllabusData;
  error?: string;
}> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[generateSyllabus] user:", user?.id, "authError:", authError?.message);

  if (authError || !user) {
    return { error: "Not authenticated." };
  }

  const { data: goalRow, error: fetchError } = await supabase
    .from("user_goals")
    .select("id, handicap_baseline, primary_miss, target_goal")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  console.log("[generateSyllabus] fetchError:", fetchError?.message);

  if (fetchError || !goalRow) {
    return { error: "No goals found. Please complete the goals form first." };
  }

  const result = await callOpenAI(
    goalRow.handicap_baseline as number | null,
    goalRow.primary_miss as string | null,
    goalRow.target_goal as string | null
  );

  if (result.error) return { error: result.error };

  const { error: updateError } = await supabase
    .from("user_goals")
    .update({ ai_syllabus: result.syllabus })
    .eq("id", goalRow.id);

  console.log("[generateSyllabus] syllabus update error:", updateError?.message);

  return { syllabus: result.syllabus };
}
