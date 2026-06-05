import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Temporary endpoint to test the Gemini API key — remove after debugging
export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ status: "ERROR", message: "GEMINI_API_KEY is not set" });
  }

  // List available models for this key
  const listRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  const listBody = await listRes.json();
  const modelNames = listBody?.models?.map((m: { name: string }) => m.name) ?? [];

  // Test text generation with gemini-1.5-flash
  const testRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Say OK in one word" }] }],
      }),
    }
  );
  const testBody = await testRes.text();

  return NextResponse.json({
    keyPrefix: apiKey.slice(0, 8) + "...",
    keyLength: apiKey.length,
    listStatus: listRes.status,
    availableModels: modelNames.slice(0, 20),
    testStatus: testRes.status,
    testResponse: testBody.slice(0, 300),
  });
}
