import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Temporary endpoint to test the Gemini API key — remove after debugging
export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ status: "ERROR", message: "GEMINI_API_KEY is not set" });
  }

  // Simple text-only request to verify the key works
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Say OK" }] }],
      }),
    }
  );

  const body = await res.text();

  return NextResponse.json({
    status: res.ok ? "OK" : "FAILED",
    httpStatus: res.status,
    keyPrefix: apiKey.slice(0, 8) + "...",
    keyLength: apiKey.length,
    geminiResponse: body.slice(0, 500),
  });
}
