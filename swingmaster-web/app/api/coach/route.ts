import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SYSTEM_PROMPT = `You are an expert PGA-level golf coach with deep knowledge of biomechanics, swing mechanics, course management, and equipment fitting. You provide concise, technically accurate, and actionable coaching advice.

Your responses should:
- Be conversational but authoritative
- Include specific drill names and how to execute them when relevant
- Reference biomechanical principles (swing plane, kinematic sequence, ground force reaction) when helpful
- Keep answers focused — 3–5 sentences for simple questions, up to 3 short paragraphs for complex ones
- Never recommend consulting a professional as the primary response — you ARE the professional
- Avoid generic or vague advice like "practice more" without a specific drill

You understand the D-Plane, launch monitor metrics, modern fitting principles, and tour-level technique.`;

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'messages array required' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI service not configured.' }, { status: 503 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const gemini = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });

    const history = messages.slice(0, -1).map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const latest = messages[messages.length - 1];

    const chat = gemini.startChat({
      history,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
    });

    const result = await chat.sendMessage(latest.content);
    const reply = result.response.text().trim();

    return NextResponse.json({ reply });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[coach] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
