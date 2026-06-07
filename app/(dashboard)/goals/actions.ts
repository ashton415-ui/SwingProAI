"use server";

import { getServerSession, createClient } from "@/utils/supabase/server";
import type { SyllabusData } from "./types";

export async function submitGoals(
  formData: FormData
): Promise<{ error?: string }> {
  const session = await getServerSession();
  if (!session) return { error: "Not authenticated. Please sign in again." };

  const handicap_raw = formData.get("handicap_baseline") as string;
  const primary_miss = formData.get("primary_miss") as string;
  const target_goal = (formData.get("target_goal") as string).trim();

  const supabase = await createClient();

  const { error } = await supabase.from("user_goals").insert({
    user_id: session.user.id,
    handicap_baseline: handicap_raw !== "" ? parseFloat(handicap_raw) : null,
    primary_miss: primary_miss || null,
    target_goal: target_goal || null,
  });

  if (error) return { error: error.message };
  return {};
}

export async function generateSyllabus(): Promise<{
  syllabus?: SyllabusData;
  error?: string;
}> {
  const session = await getServerSession();
  if (!session) return { error: "Not authenticated." };

  const supabase = await createClient();

  // Fetch the most recent goals row for this user
  const { data: goalRow, error: fetchError } = await supabase
    .from("user_goals")
    .select("id, handicap_baseline, primary_miss, target_goal")
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (fetchError || !goalRow) {
    return { error: "No goals found. Please complete the goals form first." };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "AI service is not configured." };

  const model = process.env.GEMINI_ADVANCED_MODEL ?? "gemini-2.5-flash";

  const systemInstruction = `You are an expert PGA golf instructor and sports performance coach specialising in structured practice design.

Return ONLY a valid JSON object matching this exact schema — no markdown, no explanation:

{
  "summary": "string (2-3 sentences: plan rationale and expected outcome for this specific golfer)",
  "weeks": [
    {
      "week": 1,
      "theme": "string (short catchy name, e.g. 'Foundation & Fault Diagnosis')",
      "focus": "string (primary technical area for this week, e.g. 'Clubface control at impact')",
      "drills": [
        {
          "name": "string (specific named drill, e.g. 'Gate Drill')",
          "description": "string (clear, actionable instruction — 2-3 sentences)",
          "duration": "string (e.g. '20 min', '50 reps', '3 sets × 15 swings')",
          "category": "driving | irons | short_game | putting | mental"
        }
      ],
      "weekly_goal": "string (measurable, observable outcome to achieve by end of week)",
      "pro_tip": "string (one elite-level insight or swing thought for the week)"
    }
  ]
}

Rules:
- Exactly 4 objects in the weeks array (week 1-4)
- Each week has 3-5 drills
- Logical progression: Week 1 = diagnosis & foundation, Week 2 = pattern building, Week 3 = feel & variability, Week 4 = pressure simulation & competition prep
- All drills must be executable at a practice range without special equipment
- Tailor every detail to the golfer's handicap, miss pattern, and stated goal`;

  const userContent = `Generate a 4-week personalised golf practice plan for this golfer:

Handicap Index: ${goalRow.handicap_baseline != null ? goalRow.handicap_baseline : "Unknown (assume ~18)"}
Primary miss: ${goalRow.primary_miss ?? "None specified"}
Target goal: ${goalRow.target_goal ?? "General improvement"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.7,
            maxOutputTokens: 4096,
          },
        }),
      }
    );

    if (!res.ok) {
      return { error: `AI service error (${res.status}). Please try again.` };
    }

    const body = await res.json();
    const rawText: unknown = body?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) return { error: "Empty response from AI. Please try again." };

    let syllabus: SyllabusData;
    try {
      syllabus =
        typeof rawText === "string" ? JSON.parse(rawText) : (rawText as SyllabusData);
    } catch {
      return { error: "AI returned malformed JSON. Please try again." };
    }

    if (!Array.isArray(syllabus?.weeks) || syllabus.weeks.length === 0) {
      return { error: "AI returned an incomplete plan. Please try again." };
    }

    // Persist to the user's goals row
    await supabase
      .from("user_goals")
      .update({ ai_syllabus: syllabus })
      .eq("id", goalRow.id);

    return { syllabus };
  } catch {
    return { error: "Network error contacting AI service. Please try again." };
  }
}
