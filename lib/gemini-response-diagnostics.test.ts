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
  FULL_SWING_REJECTION_CODES,
  classifyRejectionCode,
  withRejectionCode,
  type GeminiResponseDiagnostics,
} from "@/lib/gemini-response-diagnostics";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      // The approved rejection field is the one addition, on the full-swing validation_rejected line only.
      expect(line).toMatch(
        /^\[analyze-swing\] provider response diagnostics family=(full_swing|putting) outcome=[a-z_]+ finish_reason=[a-z_]+ prompt_tokens=(\d+|unavailable) candidate_tokens=(\d+|unavailable) thinking_tokens=(\d+|unavailable) total_tokens=(\d+|unavailable) text_chars=(\d+|unavailable)( rejection=[a-z_]+)?$/,
      );
      expect(line.includes(" rejection=")).toBe(line.includes("family=full_swing outcome=validation_rejected "));
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

// ─── D6. the full-swing rejection code (approved code-only exception) ────────

/** The FullSwingRejection union as written in the contract source, for a runtime cross-check of the allowlist. */
function contractRejectionCodes(): string[] {
  const source = readFileSync(join(process.cwd(), "lib/full-swing-analysis-contract.ts"), "utf8");
  const union = source.match(/export type FullSwingRejection =([\s\S]*?);/);
  if (!union) throw new Error("FullSwingRejection union not found");
  return Array.from(union[1].matchAll(/"([a-z_]+)"/g), (m) => m[1]);
}

const BASE = withTextLength(describeGeminiResponse({ candidates: [{ finishReason: "STOP" }], usageMetadata: USAGE }), 4062);
const REJECTED_PREFIX =
  "[analyze-swing] provider response diagnostics family=full_swing outcome=validation_rejected finish_reason=stop " +
  "prompt_tokens=2140 candidate_tokens=1987 thinking_tokens=6205 total_tokens=10332 text_chars=4062";

describe("D6. full swing validation_rejected carries only the contract's fixed rejection code", () => {
  it("the allowlist is exactly the contract's rejection codes, each once", () => {
    expect([...FULL_SWING_REJECTION_CODES].sort()).toEqual(contractRejectionCodes().sort());
    expect(new Set(FULL_SWING_REJECTION_CODES).size).toBe(FULL_SWING_REJECTION_CODES.length);
  });

  it("the pillar codes name only the pillar and the part: twelve, each exactly once", () => {
    const pillarCodes = FULL_SWING_REJECTION_CODES.filter((code) => code.startsWith("bad_pillar"));
    const expected = ["posture", "swing_plane", "impact"].flatMap((key) =>
      ["object", "rating", "observation", "correction"].map((part) => `bad_pillar_${key}_${part}`),
    );
    expect([...pillarCodes].sort()).toEqual(expected.sort());
  });

  it.each([...FULL_SWING_REJECTION_CODES])("%s is logged as itself", (code) => {
    const line = formatGeminiResponseDiagnostics("full_swing", "validation_rejected", withRejectionCode(BASE, code));
    expect(line).toBe(`${REJECTED_PREFIX} rejection=${code}`);
  });

  it.each([
    ["a near match", "bad_text_extra"],
    ["a prefix", "bad_"],
    ["surrounding space", " bad_text"],
    ["upper case", "BAD_TEXT"],
    ["an injected suffix", "bad_text finish_reason=stop RESPONSE-TEXT-SENTINEL"],
    ["a newline", "bad_text\nINJECTED"],
    ["the empty string", ""],
    ["the sentinel itself", "unrecognized"],
    ["an object-prototype name", "constructor"],
    ["another prototype name", "__proto__"],
    ["a String object", new String("bad_text")],
    ["an array", ["bad_text"]],
    ["an object with toString", { toString: () => "bad_text" }],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["a symbol", Symbol("bad_text")],
    // D-PILLAR: the former generic pillar code is no longer a contract code.
    ["the retired generic pillar code", "bad_pillar"],
    ["a pillar outside the three", "bad_pillar_grip_rating"],
    ["a part outside the four", "bad_pillar_posture_value"],
  ])("%s becomes unrecognized and is never echoed", (_label, value) => {
    expect(classifyRejectionCode(value)).toBe("unrecognized");
    const line = formatGeminiResponseDiagnostics("full_swing", "validation_rejected", withRejectionCode(BASE, value));
    expect(line).toBe(`${REJECTED_PREFIX} rejection=unrecognized`);
    expect(line).not.toContain("RESPONSE-TEXT-SENTINEL");
    expect(line).not.toContain("INJECTED");
  });

  it("an accessor that throws while the code is read leaves the record unchanged", () => {
    const hostile = { get toString(): never { throw new Error("trap"); } };
    expect(() => withRejectionCode(BASE, hostile)).not.toThrow();
    expect(withRejectionCode(BASE, hostile).rejectionCode).toBe("unrecognized");
  });

  it("a code smuggled into the record past the types is re-validated when formatted", () => {
    const forged = { ...BASE, rejectionCode: "bad_text RESPONSE-TEXT-SENTINEL" } as GeminiResponseDiagnostics;
    expect(formatGeminiResponseDiagnostics("full_swing", "validation_rejected", forged)).toBe(`${REJECTED_PREFIX} rejection=unrecognized`);
  });

  it("a validation_rejected line with no code says unavailable, never a guessed code", () => {
    expect(formatGeminiResponseDiagnostics("full_swing", "validation_rejected", BASE)).toBe(`${REJECTED_PREFIX} rejection=unavailable`);
  });

  it("every other family and outcome line is unchanged, even when a code is attached", () => {
    const coded = withRejectionCode(BASE, "position_order");
    for (const outcome of RESPONSE_OUTCOMES) {
      for (const family of ["full_swing", "putting"] as const) {
        if (family === "full_swing" && outcome === "validation_rejected") continue;
        expect(formatGeminiResponseDiagnostics(family, outcome, coded)).toBe(formatGeminiResponseDiagnostics(family, outcome, BASE));
        expect(formatGeminiResponseDiagnostics(family, outcome, coded)).not.toContain("rejection=");
      }
    }
  });

  it("a family or outcome smuggled past the types never unlocks the field", () => {
    const coded = withRejectionCode(BASE, "bad_text");
    expect(formatGeminiResponseDiagnostics("full_swing " as never, "validation_rejected", coded)).not.toContain("rejection=");
    expect(formatGeminiResponseDiagnostics("full_swing", "validation_rejected " as never, coded)).not.toContain("rejection=");
  });

  it("logging the rejected line is best effort: a throwing sink changes nothing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(logGeminiResponseDiagnostics("full_swing", "validation_rejected", withRejectionCode(BASE, "bad_text"))).toBeUndefined();
  });

  it("the rejected line is logged once, to console.error, with its code", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logGeminiResponseDiagnostics("full_swing", "validation_rejected", withRejectionCode(BASE, "finding_view_mismatch"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([`${REJECTED_PREFIX} rejection=finding_view_mismatch`]);
  });

  it("withRejectionCode adds only the classified code and keeps every other field", () => {
    const coded = withRejectionCode(BASE, "bad_list");
    expect(coded).toEqual({ ...BASE, rejectionCode: "bad_list" });
    expect(BASE).not.toHaveProperty("rejectionCode");
  });
});
