import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// ENT-1D S6 — lib/gemini-response-diagnostics.ts
// ============================================================================
//
// Pure unit coverage of the allowlisted response diagnostics. Responses are
// synthetic objects shaped like Gemini generateContent answers; nothing is
// sent anywhere and no credential is used. The route-level behaviour (one
// provider call, unchanged HTTP answers and claim lifecycle) is covered in
// lib/ent-1a-analysis-authority.test.ts, section AA.

vi.mock("server-only", () => ({}));

import {
  DIAGNOSTIC_UNAVAILABLE,
  RESPONSE_OUTCOMES,
  classifyFinishReason,
  describeGeminiResponse,
  diagnosticCount,
  formatGeminiResponseDiagnostics,
  logGeminiResponseDiagnostics,
  withTextLength,
  type GeminiResponseDiagnostics,
} from "@/lib/gemini-response-diagnostics";

const SECRETS = {
  text: "RESPONSE-TEXT-SENTINEL",
  thought: "THOUGHT-TEXT-SENTINEL",
  signature: "THOUGHT-SIGNATURE-SENTINEL",
  safety: "SAFETY-RATING-SENTINEL",
  prompt: "PROMPT-FEEDBACK-SENTINEL",
  model: "MODEL-VERSION-SENTINEL",
  responseId: "RESPONSE-ID-SENTINEL",
};

const USAGE = { promptTokenCount: 2140, candidatesTokenCount: 1987, thoughtsTokenCount: 6205, totalTokenCount: 10332 };

/** A response carrying every field Gemini may return, each with sentinel content. */
function richResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [
      {
        index: 0,
        content: {
          role: "model",
          parts: [
            { text: SECRETS.thought, thought: true, thoughtSignature: SECRETS.signature },
            { text: `{"summary":"${SECRETS.text}"` },
          ],
        },
        finishReason: "MAX_TOKENS",
        finishMessage: SECRETS.text,
        safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: SECRETS.safety }],
        citationMetadata: { citationSources: [{ uri: `https://example.invalid/?token=${SECRETS.text}` }] },
      },
      { index: 1, content: { parts: [{ text: SECRETS.text }] }, finishReason: "STOP" },
    ],
    promptFeedback: { blockReason: SECRETS.prompt, safetyRatings: [{ probability: SECRETS.safety }] },
    usageMetadata: { ...USAGE, promptTokensDetails: [{ modality: SECRETS.model, tokenCount: 1 }] },
    modelVersion: SECRETS.model,
    responseId: SECRETS.responseId,
    ...overrides,
  };
}

function allLines(d: GeminiResponseDiagnostics): string[] {
  return RESPONSE_OUTCOMES.flatMap((outcome) =>
    (["full_swing", "putting"] as const).map((family) => formatGeminiResponseDiagnostics(family, outcome, d)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D1. a valid response yields exactly the allowlisted metadata", () => {
  it("a complete STOP answer with usage", () => {
    const response = {
      candidates: [{ index: 0, content: { parts: [{ text: '{"score":72}' }] }, finishReason: "STOP" }],
      usageMetadata: USAGE,
    };
    const d = withTextLength(describeGeminiResponse(response), 12);
    expect(d).toEqual({
      finishReason: "stop",
      promptTokens: 2140,
      candidateTokens: 1987,
      thinkingTokens: 6205,
      totalTokens: 10332,
      textChars: 12,
    });
    expect(formatGeminiResponseDiagnostics("full_swing", "completed", d)).toBe(
      "[analyze-swing] provider response diagnostics family=full_swing outcome=completed finish_reason=stop " +
        "prompt_tokens=2140 candidate_tokens=1987 thinking_tokens=6205 total_tokens=10332 text_chars=12",
    );
  });

  it("the record has exactly six fields, whatever else the response carries", () => {
    const d = describeGeminiResponse(richResponse());
    expect(Object.keys(d).sort()).toEqual(
      ["candidateTokens", "finishReason", "promptTokens", "textChars", "thinkingTokens", "totalTokens"],
    );
  });

  it("zero is kept when the provider supplied zero", () => {
    const d = describeGeminiResponse({ candidates: [{ finishReason: "STOP" }], usageMetadata: { ...USAGE, thoughtsTokenCount: 0 } });
    expect(d.thinkingTokens).toBe(0);
  });
});

describe("D2. MAX_TOKENS and the other finish reasons are classified, never echoed", () => {
  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "max_tokens"],
    ["SAFETY", "safety"],
    ["RECITATION", "recitation"],
    ["LANGUAGE", "language"],
    ["OTHER", "other"],
    ["BLOCKLIST", "blocklist"],
    ["PROHIBITED_CONTENT", "prohibited_content"],
    ["SPII", "spii"],
    ["MALFORMED_FUNCTION_CALL", "malformed_function_call"],
    ["FINISH_REASON_UNSPECIFIED", "unspecified"],
  ])("%s → %s", (raw, code) => {
    expect(classifyFinishReason(raw)).toBe(code);
  });

  it("a truncated MAX_TOKENS answer keeps its counts, so incomplete generation is distinguishable", () => {
    const d = withTextLength(describeGeminiResponse(richResponse()), 7978);
    expect(formatGeminiResponseDiagnostics("full_swing", "json_parse_failed", d)).toBe(
      "[analyze-swing] provider response diagnostics family=full_swing outcome=json_parse_failed " +
        "finish_reason=max_tokens prompt_tokens=2140 candidate_tokens=1987 thinking_tokens=6205 total_tokens=10332 text_chars=7978",
    );
  });

  it("only the first candidate's finish reason is read", () => {
    const d = describeGeminiResponse(
      richResponse({ candidates: [{ finishReason: "STOP" }, { finishReason: "MAX_TOKENS" }] }),
    );
    expect(d.finishReason).toBe("stop");
  });

  it.each([
    ["an unknown string", "NEW_REASON_<script>alert(1)</script>"],
    ["a lower-case variant", "max_tokens"],
    ["a prototype key", "constructor"],
    ["a prototype key", "__proto__"],
    ["a number", 2],
    ["an object", { reason: "STOP" }],
    ["a boolean", true],
  ])("%s → unrecognized, and the value never appears", (_label, raw) => {
    expect(classifyFinishReason(raw)).toBe("unrecognized");
    const line = formatGeminiResponseDiagnostics(
      "full_swing",
      "completed",
      describeGeminiResponse({ candidates: [{ finishReason: raw }] }),
    );
    expect(line).toContain("finish_reason=unrecognized");
    if (typeof raw === "string") expect(line).not.toContain(raw);
  });
});

describe("D3. missing or malformed metadata stays unavailable, never zero", () => {
  const ALL_UNAVAILABLE = {
    finishReason: DIAGNOSTIC_UNAVAILABLE,
    promptTokens: DIAGNOSTIC_UNAVAILABLE,
    candidateTokens: DIAGNOSTIC_UNAVAILABLE,
    thinkingTokens: DIAGNOSTIC_UNAVAILABLE,
    totalTokens: DIAGNOSTIC_UNAVAILABLE,
    textChars: DIAGNOSTIC_UNAVAILABLE,
  };

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "not a response"],
    ["an array", [{ finishReason: "STOP" }]],
    ["an empty object", {}],
    ["no candidates", { candidates: [] }],
    ["candidates not an array", { candidates: { finishReason: "STOP" } }],
    ["a null first candidate", { candidates: [null] }],
    ["a candidate without finishReason", { candidates: [{ content: { parts: [] } }] }],
    ["usageMetadata null", { usageMetadata: null }],
    ["usageMetadata an array", { usageMetadata: [2140] }],
  ])("%s → every field unavailable", (_label, response) => {
    expect(describeGeminiResponse(response)).toEqual(ALL_UNAVAILABLE);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a numeric string", "2140"],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond safe integers", Number.MAX_SAFE_INTEGER + 2],
    ["a bigint", BigInt(5)],
    ["an object", { value: 5 }],
    ["a boolean", false],
  ])("a count that is %s → unavailable", (_label, value) => {
    expect(diagnosticCount(value)).toBe(DIAGNOSTIC_UNAVAILABLE);
    const d = describeGeminiResponse({ usageMetadata: { ...USAGE, thoughtsTokenCount: value } });
    expect(d.thinkingTokens).toBe(DIAGNOSTIC_UNAVAILABLE);
    expect(d.promptTokens).toBe(2140);
  });

  it("partial usage: each missing count is unavailable on its own", () => {
    const d = describeGeminiResponse({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10 } });
    expect(d).toEqual({ ...ALL_UNAVAILABLE, finishReason: "stop", promptTokens: 10 });
    const line = formatGeminiResponseDiagnostics("putting", "completed", d);
    expect(line).not.toMatch(/=0(\s|$)/);
  });

  it("a text length that is not a count is unavailable", () => {
    const base = describeGeminiResponse({});
    for (const bad of [undefined, null, -3, 2.5, "12", Number.NaN]) {
      expect(withTextLength(base, bad).textChars).toBe(DIAGNOSTIC_UNAVAILABLE);
    }
    expect(withTextLength(base, 0).textChars).toBe(0);
  });

  it("a hostile accessor never throws; fields read before it are kept", () => {
    const response = {
      candidates: [{ finishReason: "MAX_TOKENS" }],
      get usageMetadata(): never {
        throw new Error("accessor exploded");
      },
    };
    expect(() => describeGeminiResponse(response)).not.toThrow();
    expect(describeGeminiResponse(response)).toEqual({ ...ALL_UNAVAILABLE, finishReason: "max_tokens" });
    const proxy = new Proxy({}, { get: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); } });
    expect(describeGeminiResponse(proxy)).toEqual(ALL_UNAVAILABLE);
  });
});

describe("D4. privacy: nothing outside the allowlist can reach a line", () => {
  it("text, thoughts, signatures, safety ratings, prompt feedback, model and ids never appear", () => {
    const d = withTextLength(describeGeminiResponse(richResponse()), 7978);
    const serialized = JSON.stringify(d);
    for (const line of [...allLines(d), serialized]) {
      for (const secret of Object.values(SECRETS)) expect(line).not.toContain(secret);
      expect(line).not.toContain("token=");
      expect(line).not.toContain("https://");
    }
  });

  it("every line has the fixed key set and only codes or integers as values", () => {
    const d = withTextLength(describeGeminiResponse(richResponse()), 7978);
    for (const line of allLines(d)) {
      expect(line).toMatch(
        /^\[analyze-swing\] provider response diagnostics family=(full_swing|putting) outcome=[a-z_]+ finish_reason=[a-z_]+ prompt_tokens=(\d+|unavailable) candidate_tokens=(\d+|unavailable) thinking_tokens=(\d+|unavailable) total_tokens=(\d+|unavailable) text_chars=(\d+|unavailable)$/,
      );
    }
  });

  it("values smuggled past the types are re-validated when formatted", () => {
    const forged = {
      finishReason: "stop prompt_tokens=999 RESPONSE-TEXT-SENTINEL",
      promptTokens: "RESPONSE-TEXT-SENTINEL",
      candidateTokens: -5,
      thinkingTokens: 1.5,
      totalTokens: Number.NaN,
      textChars: "7978",
    } as unknown as GeminiResponseDiagnostics;
    const line = formatGeminiResponseDiagnostics(
      "full_swing; RESPONSE-TEXT-SENTINEL" as never,
      "json_parse_failed\nINJECTED" as never,
      forged,
    );
    expect(line).toBe(
      "[analyze-swing] provider response diagnostics family=unrecognized outcome=unrecognized finish_reason=unrecognized " +
        "prompt_tokens=unavailable candidate_tokens=unavailable thinking_tokens=unavailable total_tokens=unavailable text_chars=unavailable",
    );
  });
});

describe("D5. logging is best effort and never changes the caller's outcome", () => {
  it("completed goes to console.log, every other outcome to console.error, one line each", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = describeGeminiResponse(richResponse());
    logGeminiResponseDiagnostics("full_swing", "completed", d);
    logGeminiResponseDiagnostics("putting", "validation_rejected", d);
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(error.mock.calls[0]).toHaveLength(1);
    expect(String(error.mock.calls[0][0])).toContain("family=putting outcome=validation_rejected");
  });

  it("without a provider answer (null) nothing is logged", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logGeminiResponseDiagnostics("full_swing", "json_parse_failed", null);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("a failing log sink never throws and returns nothing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink down");
    });
    const d = describeGeminiResponse(richResponse());
    expect(logGeminiResponseDiagnostics("full_swing", "completed", d)).toBeUndefined();
    expect(logGeminiResponseDiagnostics("full_swing", "json_parse_failed", d)).toBeUndefined();
  });
});
