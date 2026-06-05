import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return NextResponse.json({ error: "AI service not configured — GEMINI_API_KEY missing" }, { status: 503 });
  }

  const { videoData, mimeType, isAdvanced } = await req.json();
  if (!videoData || !mimeType) {
    return NextResponse.json({ error: "Missing videoData or mimeType" }, { status: 400 });
  }

  // Gemini inline_data limit is ~20MB (base64 adds ~33% overhead)
  const estimatedBytes = (videoData.length / 4) * 3;
  const estimatedMB = estimatedBytes / (1024 * 1024);
  console.log(`Video size estimate: ${estimatedMB.toFixed(1)} MB`);
  if (estimatedMB > 18) {
    return NextResponse.json(
      { error: `Video too large for AI analysis (${estimatedMB.toFixed(1)} MB). Trim to a shorter segment (under 10 seconds).` },
      { status: 413 }
    );
  }

  const prompt = isAdvanced
    ? `You are a professional golf coach performing a FORENSIC BIOMECHANICAL ANALYSIS.
Analyze the kinetic chain, hip rotation, shoulder separation, wrist hinge, and head stability.
Provide numeric estimations for swing speed, ball speed, launch angle, and smash factor.
Return JSON with: feedback, score (0-100), weakSpots (string[]), drills (array of {name,why,how,feel,videoUrl}),
metrics: {swingSpeed, ballSpeed, launchAngle, smashFactor, wristHinge:{feedback,overlay:{x1,y1,x2,y2}}, hipRotation:{feedback,overlay:{x1,y1,x2,y2}}, shoulderRotation:{feedback,overlay:{x1,y1,x2,y2}}, headStability:{feedback,overlay:{x1,y1,x2,y2}}}`
    : `You are a world-class professional golf coach. Analyze this golf swing video.
Focus on launch monitor physics (swing speed, ball speed, launch angle, smash factor) and key mechanical feedback.
Return JSON with: feedback (string), score (0-100), weakSpots (string[]),
drills (array of {name,why,how,feel,videoUrl with real YouTube embed URL}),
metrics: {swingSpeed (mph), ballSpeed (mph), launchAngle (degrees), smashFactor (ratio)}`;

  // Try models in order of preference
  const models = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-flash-latest",
  ];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: videoData } },
            ],
          }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.4,
            maxOutputTokens: 2048,
          },
        }),
      });

      if (response.status === 404) {
        console.warn(`Model ${model} not found, trying next...`);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        console.error(`Gemini error with ${model}:`, response.status, err);
        return NextResponse.json(
          { error: `AI analysis failed (${response.status})`, model, detail: err.slice(0, 300) },
          { status: 502 }
        );
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

      try {
        const result = JSON.parse(text);
        return NextResponse.json(result);
      } catch {
        // Sometimes Gemini wraps JSON in markdown code fences
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        return NextResponse.json(JSON.parse(cleaned));
      }

    } catch (err) {
      console.error(`Error with model ${model}:`, err);
      continue;
    }
  }

  return NextResponse.json({ error: "All Gemini models failed" }, { status: 502 });
}
