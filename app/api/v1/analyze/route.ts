import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";

/**
 * POST /api/v1/analyze
 * Secure server-side Gemini proxy. API key never reaches the browser.
 * Expects: { videoData: string (base64), mimeType: string, isAdvanced: boolean }
 */
export async function POST(req: NextRequest) {
  // Auth check
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { videoData, mimeType, isAdvanced } = await req.json();

  if (!videoData || !mimeType) {
    return NextResponse.json({ error: "Missing videoData or mimeType" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured" }, { status: 503 });
  }

  const standardPrompt = `You are a world-class professional golf coach and ball flight physicist.
Analyze this golf swing video. Focus on:
1. Launch monitor physics (swing speed, ball speed, launch angle, smash factor)
2. Key mechanical observations
3. Practical corrective drills with YouTube reference links

Start with strengths, then identify mechanical flaws. Be specific and technical.`;

  const advancedPrompt = `You are performing a FORENSIC BIOMECHANICAL ANALYSIS of this golf swing.
Analyze the kinetic chain, transition dynamics, X-Factor separation, and exact ball flight physics.
Include deep analysis of: wrist hinge, hip rotation, shoulder rotation, and head stability.
Provide numeric estimations for all velocities and rotational separations.`;

  const prompt = `${isAdvanced ? advancedPrompt : standardPrompt}

Return a JSON object with exactly these fields:
- feedback (string): Comprehensive technical overview
- score (number 0-100): Overall swing rating
- weakSpots (string[]): 3-5 specific mechanical fault tags
- drills (array): 3 corrective drills, each with: name, why, how, feel, videoUrl (real YouTube embed URL)
- metrics (object): swingSpeed (mph), ballSpeed (mph), launchAngle (degrees), smashFactor (ratio)
${isAdvanced ? `- Also include in metrics: wristHinge, hipRotation, shoulderRotation, headStability — each with: feedback (string) and overlay (object with x1,y1,x2,y2 as 0-100 percentages)` : ""}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: videoData } },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.4,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("Gemini API error:", response.status, err);
      return NextResponse.json({ error: `AI analysis failed (${response.status})`, detail: err }, { status: 502 });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const result = JSON.parse(text);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: "Analysis processing failed" }, { status: 500 });
  }
}
