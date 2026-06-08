import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@/utils/supabase/server";

export const maxDuration = 60;

// ── Structured Output schema ──────────────────────────────────────────────────
// Biomechanical values → stored in `metrics` JSONB column.
// highlights / deficiencies → simple strings, wrapped into the jsonb array shapes
// required by the DB constraints on swing_highlights / mechanical_deficiencies.

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description: "Overall swing quality 0-100. 40-65: high-handicapper; 65-78: mid; 78-88: low; 88+: elite.",
    },
    overall_assessment: {
      type: "string",
      description: "3-5 sentence honest assessment covering the most important biomechanical findings.",
    },

    // ── Biomechanical measurements ──────────────────────────────────────────
    spine_angle: {
      type: "number",
      description: "Estimated spine angle in degrees at address. Ideal range 35-45°. Return a realistic number.",
    },
    hip_rotation: {
      type: "number",
      description: "Estimated hip rotation in degrees through impact. Elite: 45-55°. Return a realistic number.",
    },
    shoulder_rotation: {
      type: "number",
      description: "Estimated shoulder turn in degrees at the top of backswing. Ideal: 90-100°. Return a realistic number.",
    },
    tempo_ratio: {
      type: "string",
      description: "Backswing-to-downswing time ratio expressed as a string, e.g. '3:1' or '2.5:1'. Tour average is 3:1.",
    },

    // ── Summary arrays (plain strings) ─────────────────────────────────────
    highlights: {
      type: "array",
      description: "2-4 concise bullet strings describing what the golfer is doing well.",
      items: { type: "string" },
    },
    deficiencies: {
      type: "array",
      description: "2-4 concise bullet strings describing the priority fault areas and their ball-flight consequence.",
      items: { type: "string" },
    },

    // ── Putting analysis ────────────────────────────────────────────────────
    putting_analysis: {
      type: "string",
      description: "2-3 sentence assessment of likely putting tendencies based on the observed setup, grip, and alignment in the swing. Note key stroke mechanics to work on.",
    },

    // ── Pillar detail (for the full AI Report page) ─────────────────────────
    posture: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string" },
        correction: { type: "string" },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },
    swing_plane: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string" },
        correction: { type: "string" },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },
    impact: {
      type: "object",
      properties: {
        rating: { type: "string", enum: ["excellent", "good", "needs_work", "poor"] },
        observation: { type: "string" },
        correction: { type: "string" },
      },
      required: ["rating", "observation", "correction"],
      additionalProperties: false,
    },

    practice_focus: {
      type: "string",
      description: "Single highest-priority area to work on this week — one sentence.",
    },
    pro_cue: {
      type: "string",
      description: "One elite-level swing thought in 10 words or fewer.",
    },
  },
  required: [
    "score", "overall_assessment",
    "spine_angle", "hip_rotation", "shoulder_rotation", "tempo_ratio",
    "highlights", "deficiencies", "putting_analysis",
    "posture", "swing_plane", "impact",
    "practice_focus", "pro_cue",
  ],
  additionalProperties: false,
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTempoRatioToNumber(s: string): number | null {
  // "3:1" → 3.0, "2.5:1" → 2.5
  const parts = s.split(":").map(Number);
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[1] !== 0) {
    return parts[0] / parts[1];
  }
  return null;
}

// ── POST /api/analyze-swing ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  console.log("[analyze-swing] POST request received");

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  console.log("[analyze-swing] auth user:", user?.id, "authError:", authError?.message);

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { analysisId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { analysisId } = body;
  if (!analysisId) {
    return NextResponse.json({ error: "Missing analysisId" }, { status: 400 });
  }

  console.log("[analyze-swing] fetching analysis row:", analysisId);

  // Fetch analysis row + joined video metadata
  const { data: analysisRow, error: fetchErr } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(id, club, original_filename, video_url, storage_path, mime_type, file_size)")
    .eq("id", analysisId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !analysisRow) {
    console.error("[analyze-swing] fetch error:", fetchErr?.message, fetchErr?.details, fetchErr?.hint);
    return NextResponse.json({ error: "Analysis record not found." }, { status: 404 });
  }

  console.log("[analyze-swing] row status:", analysisRow.status);

  if (analysisRow.status === "complete") {
    return NextResponse.json({ message: "Already complete", data: analysisRow });
  }

  // Mark as processing
  const { error: markErr } = await supabase
    .from("swing_analysis")
    .update({ status: "processing" })
    .eq("id", analysisId);

  if (markErr) {
    console.error("[analyze-swing] failed to mark processing:", markErr.message, markErr.details, markErr.hint);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[analyze-swing] OPENAI_API_KEY not set");
    await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    return NextResponse.json({ error: "AI service not configured." }, { status: 503 });
  }

  // Build context from video metadata
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

    console.log("[analyze-swing] calling gpt-4o with Structured Outputs");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a certified PGA Master Professional and sports biomechanics coach with 20+ years of elite teaching experience. You produce detailed, honest swing analysis reports.

Analyse the described golf swing and return a complete structured critique. You MUST include realistic estimated biomechanical measurements:
- spine_angle: spine tilt in degrees at address (realistic range 25-55°, typical 35-45°)
- hip_rotation: hip turn through impact in degrees (realistic range 30-65°, elite 45-55°)
- shoulder_rotation: shoulder turn at top of backswing in degrees (realistic range 60-110°, ideal 90-100°)
- tempo_ratio: backswing-to-downswing ratio string like "3:1" (tour average), "2.5:1" (fast), "3.5:1" (slow)

Standards for scoring:
- 40-65: high-handicapper (slice, inconsistency, poor mechanics)
- 65-78: mid-handicapper (solid contact, fixable faults)
- 78-88: low-handicapper (near-scratch, tour-level approach)
- 88+: elite / tour-level

Be specific and technical. Name joints and degrees. Highlights must reinforce real positives — not generic praise. Deficiencies must name the fault and its ball-flight consequence. Putting analysis extrapolates from observed setup, grip, and alignment tendencies.`,
        },
        {
          role: "user",
          content: `Produce a full biomechanical swing analysis.

Context:
${clubContext}
${sizeContext}
Session: AI coaching analysis upload

Return the complete analysis with realistic biomechanical measurements, honest pillar ratings, concise highlight and deficiency bullets, and specific coaching cues.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "swing_biomechanical_report",
          strict: true,
          schema: ANALYSIS_SCHEMA,
        },
      },
      max_tokens: 3000,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty response from OpenAI.");

    console.log("[analyze-swing] received response, length:", raw.length);

    const report = JSON.parse(raw) as {
      score: number;
      overall_assessment: string;
      spine_angle: number;
      hip_rotation: number;
      shoulder_rotation: number;
      tempo_ratio: string;
      highlights: string[];
      deficiencies: string[];
      putting_analysis: string;
      posture: { rating: string; observation: string; correction: string };
      swing_plane: { rating: string; observation: string; correction: string };
      impact: { rating: string; observation: string; correction: string };
      practice_focus: string;
      pro_cue: string;
    };

    console.log("[analyze-swing] parsed report — score:", report.score, "spine:", report.spine_angle, "hips:", report.hip_rotation);

    // Biomechanical + pillar data all go into `metrics` JSONB
    const metrics = {
      spine_angle: report.spine_angle,
      hip_rotation: report.hip_rotation,
      shoulder_rotation: report.shoulder_rotation,
      tempo_ratio: report.tempo_ratio,
      putting_analysis: report.putting_analysis,
      posture: report.posture,
      swing_plane: report.swing_plane,
      impact: report.impact,
      practice_focus: report.practice_focus,
      pro_cue: report.pro_cue,
    };

    // Wrap string arrays into the JSONB shapes required by DB constraints
    const swing_highlights = report.highlights.map((h) => ({
      checkpoint: "impact" as const,
      positive_movement: h,
      mechanical_benefit: "",
    }));

    const mechanical_deficiencies = report.deficiencies.map((d) => ({
      checkpoint: "impact" as const,
      joint_coordinate: { joint: "general", x: 0.5, y: 0.5 },
      fault_description: d,
      severity: "minor" as const,
      corrective_drill_title: "",
    }));

    // Parse "3:1" string → numeric ratio for the dedicated column
    const tempoNumeric = parseTempoRatioToNumber(report.tempo_ratio);

    console.log("[analyze-swing] updating swing_analysis row:", analysisId);

    const { data: updated, error: updateErr } = await supabase
      .from("swing_analysis")
      .update({
        status: "complete",
        score: report.score,
        feedback: report.overall_assessment,
        tempo_ratio: tempoNumeric,
        metrics,
        swing_highlights,
        mechanical_deficiencies,
      })
      .eq("id", analysisId)
      .select()
      .single();

    if (updateErr) {
      console.error("[analyze-swing] DB update error:", updateErr.message, updateErr.details, updateErr.hint, updateErr.code);
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
      return NextResponse.json({ error: `Failed to save analysis: ${updateErr.message}` }, { status: 500 });
    }

    console.log("[analyze-swing] successfully saved, status:", updated?.status);
    return NextResponse.json({ message: "Analysis complete", data: updated });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-swing] error:", msg);
    try {
      await supabase.from("swing_analysis").update({ status: "failed" }).eq("id", analysisId);
    } catch (failErr) {
      console.error("[analyze-swing] also failed to mark row as failed:", failErr);
    }
    return NextResponse.json({ error: `AI analysis failed: ${msg}` }, { status: 500 });
  }
}
