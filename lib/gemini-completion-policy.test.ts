import { describe, expect, it } from "vitest";

// ============================================================================
// ENT-1D S6-R1 — lib/gemini-completion-policy.ts
// ============================================================================
//
// Pure unit coverage: only an explicit STOP completes; blocks, cut-short,
// missing, unknown and malformed answers never do, whatever their text. The
// route-level effect (500, failed row, one provider call) is covered in
// lib/ent-1a-analysis-authority.test.ts, sections AA, AA2 and AB1.

import { decideProviderCompletion } from "@/lib/gemini-completion-policy";

const answer = (candidate: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  candidates: [{ index: 0, content: { parts: [{ text: '{"score":72}' }] }, ...candidate }],
  ...extra,
});

describe("C1. only an explicit STOP completes", () => {
  it("STOP completes", () => {
    expect(decideProviderCompletion(answer({ finishReason: "STOP" }))).toEqual({ complete: true });
  });

  it("STOP completes whatever the text, because completion is decided before text is read", () => {
    expect(decideProviderCompletion(answer({ finishReason: "STOP", content: { parts: [] } }))).toEqual({ complete: true });
  });

  it.each([
    ["missing", {}],
    ["null", { finishReason: null }],
    ["MAX_TOKENS", { finishReason: "MAX_TOKENS" }],
    ["OTHER", { finishReason: "OTHER" }],
    ["FINISH_REASON_UNSPECIFIED", { finishReason: "FINISH_REASON_UNSPECIFIED" }],
    ["MALFORMED_FUNCTION_CALL", { finishReason: "MALFORMED_FUNCTION_CALL" }],
    ["UNEXPECTED_TOOL_CALL", { finishReason: "UNEXPECTED_TOOL_CALL" }],
    ["lower-case stop", { finishReason: "stop" }],
    ["padded STOP", { finishReason: " STOP" }],
    ["unknown future reason", { finishReason: "SOMETHING_NEW" }],
    ["a number", { finishReason: 1 }],
    ["an object", { finishReason: { reason: "STOP" } }],
  ])("%s → incomplete, even with valid JSON text", (_label, candidate) => {
    expect(decideProviderCompletion(answer(candidate))).toEqual({ complete: false, kind: "incomplete" });
  });

  it.each(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"])(
    "%s → blocked",
    (reason) => {
      expect(decideProviderCompletion(answer({ finishReason: reason }))).toEqual({ complete: false, kind: "blocked" });
    },
  );

  it("only the first candidate decides", () => {
    const response = {
      candidates: [{ finishReason: "MAX_TOKENS" }, { finishReason: "STOP" }],
    };
    expect(decideProviderCompletion(response)).toEqual({ complete: false, kind: "incomplete" });
  });
});

describe("C2. no candidate, malformed or hostile responses never complete", () => {
  it("a blocked prompt with no candidate → blocked", () => {
    expect(decideProviderCompletion({ promptFeedback: { blockReason: "SAFETY" } })).toEqual({ complete: false, kind: "blocked" });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "STOP"],
    ["an array", [{ finishReason: "STOP" }]],
    ["an empty object", {}],
    ["empty candidates", { candidates: [] }],
    ["candidates not an array", { candidates: { finishReason: "STOP" } }],
    ["a null first candidate", { candidates: [null] }],
    ["feedback without a block reason", { promptFeedback: {} }],
  ])("%s → incomplete", (_label, response) => {
    expect(decideProviderCompletion(response)).toEqual({ complete: false, kind: "incomplete" });
  });

  it("a throwing accessor → incomplete, never an exception", () => {
    const hostile = {
      get candidates(): never {
        throw new Error("accessor exploded");
      },
    };
    expect(() => decideProviderCompletion(hostile)).not.toThrow();
    expect(decideProviderCompletion(hostile)).toEqual({ complete: false, kind: "incomplete" });
  });
});
