import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@/utils/supabase/server";

export const maxDuration = 60;

// ── Structured Output schema ──────────────────────────────────────────────────
// Maps directly to swing_analysis DB columns:
//   score, feedback, swing_highlights (jsonb), mechanical_deficiencies (jsonb),
//   metrics (jsonb — stores posture/plane/impact + coaching cues)

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description: "Overall swing quality 0-100. 60-80 is a typical mid-handicap range.",
    },
    overall_assessment: {
      type: "string",
      description: "3-5 sentence honest assessment covering the most important findings.",
    },
    posture: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string", description: "Specific, technical observation about the golfer's posture and setup." },
        correction: { type: "string", description: "Actionable correction the golfer can apply immediately." },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },
    swing_plane: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string", description: "Specific observation about takeaway, backswing plane, and transition." },
        correction: { type: "string", description: "Actionable drill or swing thought to fix the plane." },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },
    impact: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string", description: "Observation about hand position, face angle, and weight transfer at impact." },
        correction: { type: "string", description: "Specific drill or feel cue to improve impact position." },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },
    highlights: {
      type: "array",
      description: "2-4 things the golfer is doing well — reinforce positive habits.",
      items: {
        type: "object",
        properties: {
          movement: { type: "string", description: "The positive movement being performed." },
          benefit: { type: "string", description: "Why this movement helps ball flight and consistency." },
        },
        required: ["movement", "benefit"],
        additionalProperties: false,
      },
    },
    deficiencies: {
      type: "array",
      description: "2-4 fault areas ranked by priority impact on score.",
      items: {
        type: "object",
        properties: {
          area: { type: "string", description: "Body part or swing phase (e.g. 'Hip rotation', 'Takeaway')." },
          fault: { type: "string", description: "Clear description of what is going wrong and its ball-flight consequence." },
          severity: { type: "string", enum: ["minor", "major"] },
          drill_title: { type: "string", description: "Named drill to fix this fault." },
          drill_detail: { type: "string", description: "Step-by-step instructions for the drill in 2-3 sentences." },
        },
        required: ["area", "fault", "severity", "drill_title", "drill_detail"],
        additionalProperties: false,
      },
    },
    practice_focus: {
      type: "string",
      description: "Single highest-priority area to work on this week.",
    },
    pro_cue: {
      type: "string",
      description: "One elite-level swing thought in 10 words or fewer.",
    },
  },
  required: [
    "score", "overall_assessment",
    "posture", "swing_plane", "impact",
    "highlights", "deficiencies",
    "practice_focus", "pro_cue",
  ],
  additionalProperties: false,
} as const;

// ── POST /api/analyze-swing ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { analysisId } = await req.json().catch(() => ({}));
  if (!analysisId) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  // Fetch the analysis row + joined video metadata
  const { data: analysisRow, error: fetchErr } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(id, club, original_filename, video_url, storage_path, mime_type, file_size)")
    .eq("id", analysisId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !analysisRow) {
    console.error("[analyze-swing] fetch error:", fetchErr?.message);
    return NextResponse.json({ error: "Analysis record not found." }, { status: 404 });
  }

  if (analysisRow.status === "complete") {
    return NextResponse.json({ message: "Already complete", data: analysisRow });
  }

  // Mark as processing
  await supabase
    .from("swing_analysis")
    .update({ status: "processing" })
    .eq("id", analysisId);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json({ error: "AI service not configured." }, { status: 503 });
  }

  // Build context from available metadata
  const video = analysisRow.swing_video as {
    club: string | null;
    original_filename: string | null;
    video_url: string;
    mime_type: string | null;
    file_size: number | null;
  } | null;

  const clubContext = video?.club
    ? `Club used: ${video.club}`
    : video?.original_filename
    ? `Video filename: ${video.original_filename}`
    : "Club: unknown";

  const sizeContext = video?.file_size
    ? `File size: ${(video.file_size / (1024 * 1024)).toFixed(1)} MB`
    : "";

  try {
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a certified PGA Master Professional and sports biomechanics coach with 20+ years of teaching experience. You write detailed, honest swing analysis reports that coaches and serious golfers rely on.

Produce a comprehensive structural critique of a golf swing, focusing on three pillars:
1. POSTURE & SETUP — spine angle, knee flex, stance width, ball position, grip pressure
2. SWING PLANE — takeaway path, backswing plane, transition, downswing slot, club path through impact
3. IMPACT POSITION — hand position (shaft lean), face angle, weight transfer, hip clearance, extension through the ball

Standards:
- Be specific and technical: name joints, positions, and degrees where relevant
- Rate areas honestly — "good" means genuinely good technique, not a default
- Score 40-65: high-handicapper; 65-78: mid-handicapper; 78-88: low-handicapper; 88+: elite
- Give actionable corrections a golfer can apply on the range today
- All drills must be executable without special equipment`,
        },
        {
          role: "user",
          content: `Analyse this golf swing and produce a full structural critique.

Context:
${clubContext}
${sizeContext}
Uploaded for AI coaching analysis.

Generate a thorough report covering posture, swing plane, and impact position. Be specific, honest, and actionable.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "swing_analysis_report",
          strict: true,
          schema: ANALYSIS_SCHEMA,
        },
      },
      max_tokens: 2500,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty response from AI.");

    const report = JSON.parse(raw) as {
      score: number;
      overall_assessment: string;
      posture: { rating: string; observation: string; correction: string };
      swing_plane: { rating: string; observation: string; correction: string };
      impact: { rating: string; observation: string; correction: string };
      highlights: { movement: string; benefit: string }[];
      deficiencies: { area: string; fault: string; severity: string; drill_title: string; drill_detail: string }[];
      practice_focus: string;
      pro_cue: string;
    };

    // Map to DB schema
    const swing_highlights = report.highlights.map((h) => ({
      checkpoint: "impact" as const,
      positive_movement: h.movement,
      mechanical_benefit: h.benefit,
    }));

    const mechanical_deficiencies = report.deficiencies.map((d) => ({
      checkpoint: "impact" as const,
      joint_coordinate: { joint: d.area, x: 0.5, y: 0.5 },
      fault_description: d.fault,
      severity: d.severity as "minor" | "major",
      corrective_drill_title: d.drill_title,
      corrective_drill_detail: d.drill_detail,
    }));

    const metrics = {
      posture: report.posture,
      swing_plane: report.swing_plane,
      impact: report.impact,
      practice_focus: report.practice_focus,
      pro_cue: report.pro_cue,
    };

    const { data: updated, error: updateErr } = await supabase
      .from("swing_analysis")
      .update({
        status: "complete",
        score: report.score,
        feedback: report.overall_assessment,
        swing_highlights,
        mechanical_deficiencies,
        metrics,
      })
      .eq("id", analysisId)
      .select()
      .single();

    if (updateErr) {
      console.error("[analyze-swing] update error:", updateErr.message);
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
      return NextResponse.json({ error: "Failed to save analysis." }, { status: 500 });
    }

    return NextResponse.json({ message: "Analysis complete", data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-swing] OpenAI error:", msg);
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json({ error: `AI analysis failed: ${msg}` }, { status: 500 });
  }
}
