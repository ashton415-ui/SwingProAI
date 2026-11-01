import "server-only";

import type { FullSwingRejection } from "./full-swing-analysis-contract";

// ============================================================================
// ENT-1D S6 — safe diagnostics for one Gemini response
// ============================================================================
//
// When a provider answer cannot become an analysis, the route needs to say
// where it stopped — the generation ended early, the generated JSON was
// malformed, or a later check refused it — without logging anything the
// golfer, the prompt or the credential could be recovered from.
//
// The record is an explicit allowlist, built field by field from the response
// the transport already returned. Nothing else is read or kept:
//
//   - the first candidate's finish reason, mapped onto fixed codes; a value
//     outside the known set is "unrecognized", never echoed;
//   - the supplied prompt, candidate, thinking and total token counts;
//   - the length of the extracted response text;
//   - a fixed outcome code naming the pipeline stage;
//   - for a full-swing answer the content contract refused (outcome
//     validation_rejected) only, the contract's fixed rejection code. This is
//     an approved, narrow exception to "the reason is never logged": the enum
//     code alone, from an exhaustive allowlist, never the rejected value, the
//     model's text or an error message.
//
// Response text, prompts, thought text and signatures, safety ratings,
// credentials, headers and error messages never enter the record, so they
// cannot reach a log. A count that is missing, or is not a non-negative safe
// integer, is "unavailable" — never 0, which would claim a fact the provider
// did not state.
//
// Every function here is total: it never throws. Logging is best effort, so a
// diagnostic can never change an analysis outcome or its response.

/** The value of any field the response did not supply in a valid form. */
export const DIAGNOSTIC_UNAVAILABLE = "unavailable";

export type DiagnosticCount = number | typeof DIAGNOSTIC_UNAVAILABLE;

/** Gemini finish reasons, mapped onto the codes a log may carry. */
const FINISH_REASON_CODES: ReadonlyMap<string, string> = new Map([
  ["FINISH_REASON_UNSPECIFIED", "unspecified"],
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
  ["IMAGE_SAFETY", "image_safety"],
  ["UNEXPECTED_TOOL_CALL", "unexpected_tool_call"],
  ["TOO_MANY_TOOL_CALLS", "too_many_tool_calls"],
]);

// Array.from rather than spread: the project's compile target has no
// downlevelIteration (see arrayBufferToBase64 in the route).
const FINISH_REASON_VALUES: ReadonlySet<string> = new Set(
  Array.from(FINISH_REASON_CODES.values()).concat(["unrecognized", DIAGNOSTIC_UNAVAILABLE]),
);

/**
 * Where a provider answer stopped, as fixed codes. response_blocked and
 * incomplete_generation come from lib/gemini-completion-policy.ts (a non-STOP
 * finish); validation_rejected from the family's content contract.
 */
export const RESPONSE_OUTCOMES = [
  "completed",
  "response_blocked",
  "incomplete_generation",
  "json_parse_failed",
  "validation_rejected",
  "score_unavailable",
  "post_parse_failure",
  "completion_write_failed",
] as const;

export type ResponseOutcome = (typeof RESPONSE_OUTCOMES)[number];

export type DiagnosticFamily = "full_swing" | "putting";

const FAMILIES: ReadonlySet<string> = new Set(["full_swing", "putting"]);
const OUTCOMES: ReadonlySet<string> = new Set(RESPONSE_OUTCOMES);

/**
 * The full-swing content contract's rejection codes (FullSwingRejection in
 * lib/full-swing-analysis-contract.ts). Coupled by type only: the list must name
 * every code (checked below at compile time) and nothing else, and it is the
 * runtime allowlist, so any other value, a near match included, is
 * "unrecognized".
 */
export const FULL_SWING_REJECTION_CODES = [
  "not_object",
  "provider_authored_scoring",
  "bad_text",
  "bad_angle",
  "bad_tempo",
  "bad_list",
  "bad_pillar",
  "drill_without_deficiency",
  "bad_declaration",
  "bad_position_time",
  "position_order",
  "estimate_without_declared_evidence",
  "bad_threshold_assessment",
  "threshold_assessable_without_evidence",
  "threshold_assessable_without_estimate",
  "bad_rubric_finding",
  "threshold_item_classified",
  "quarantined_item_claimed",
  "finding_view_mismatch",
  "finding_detail_unavailable",
  "finding_position_unavailable",
  "pillar_without_coverage",
  "bad_scorable",
  "scorable_without_coverage",
  "scorable_without_assessed_pillar",
  "scorable_without_assessable_item",
  "bad_rubric_link",
  "deficiency_rubric_mismatch",
  "duplicate_rubric_link",
] as const satisfies readonly FullSwingRejection[];

// Compile-time exhaustiveness: a contract code missing from the list is a type error here.
type UnlistedRejection = Exclude<FullSwingRejection, (typeof FULL_SWING_REJECTION_CODES)[number]>;
const REJECTION_LIST_IS_EXHAUSTIVE: [UnlistedRejection] extends [never] ? true : never = true;
void REJECTION_LIST_IS_EXHAUSTIVE;

const REJECTION_CODES: ReadonlySet<string> = new Set(FULL_SWING_REJECTION_CODES);
const REJECTION_VALUES: ReadonlySet<string> = new Set(
  Array.from(REJECTION_CODES).concat(["unrecognized", DIAGNOSTIC_UNAVAILABLE]),
);

export interface GeminiResponseDiagnostics {
  readonly finishReason: string;
  readonly promptTokens: DiagnosticCount;
  readonly candidateTokens: DiagnosticCount;
  readonly thinkingTokens: DiagnosticCount;
  readonly totalTokens: DiagnosticCount;
  readonly textChars: DiagnosticCount;
  /** Full swing, validation_rejected only: the contract's rejection code, set by withRejectionCode. */
  readonly rejectionCode?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A supplied count, or unavailable. Strings, fractions, negatives and NaN are not counts. */
export function diagnosticCount(value: unknown): DiagnosticCount {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : DIAGNOSTIC_UNAVAILABLE;
}

/** The finish-reason code for a supplied value; never the value itself. */
export function classifyFinishReason(value: unknown): string {
  if (value === undefined || value === null) return DIAGNOSTIC_UNAVAILABLE;
  if (typeof value !== "string") return "unrecognized";
  return FINISH_REASON_CODES.get(value) ?? "unrecognized";
}

/**
 * The allowlisted metadata of a provider response. Reads only the first
 * candidate's finishReason and the four usageMetadata counts; the text length
 * is added by withTextLength once the text has been extracted.
 */
export function describeGeminiResponse(response: unknown): GeminiResponseDiagnostics {
  let finishReason = DIAGNOSTIC_UNAVAILABLE;
  let promptTokens: DiagnosticCount = DIAGNOSTIC_UNAVAILABLE;
  let candidateTokens: DiagnosticCount = DIAGNOSTIC_UNAVAILABLE;
  let thinkingTokens: DiagnosticCount = DIAGNOSTIC_UNAVAILABLE;
  let totalTokens: DiagnosticCount = DIAGNOSTIC_UNAVAILABLE;
  try {
    if (isRecord(response)) {
      const candidates = response.candidates;
      if (Array.isArray(candidates) && candidates.length > 0 && isRecord(candidates[0])) {
        finishReason = classifyFinishReason(candidates[0].finishReason);
      }
      const usage = response.usageMetadata;
      if (isRecord(usage)) {
        promptTokens = diagnosticCount(usage.promptTokenCount);
        candidateTokens = diagnosticCount(usage.candidatesTokenCount);
        thinkingTokens = diagnosticCount(usage.thoughtsTokenCount);
        totalTokens = diagnosticCount(usage.totalTokenCount);
      }
    }
  } catch {
    // A hostile accessor leaves the fields not yet read unavailable.
  }
  return { finishReason, promptTokens, candidateTokens, thinkingTokens, totalTokens, textChars: DIAGNOSTIC_UNAVAILABLE };
}

/** The same record with the extracted text's length; the text itself is never taken. */
export function withTextLength(diagnostics: GeminiResponseDiagnostics, length: unknown): GeminiResponseDiagnostics {
  return { ...diagnostics, textChars: diagnosticCount(length) };
}

/** The rejection code for a supplied value: an exact allowlisted code, otherwise "unrecognized"; never the value itself. */
export function classifyRejectionCode(value: unknown): string {
  return typeof value === "string" && REJECTION_CODES.has(value) ? value : "unrecognized";
}

/** The same record with the content contract's rejection code, classified; nothing else is taken. */
export function withRejectionCode(diagnostics: GeminiResponseDiagnostics, code: unknown): GeminiResponseDiagnostics {
  try {
    return { ...diagnostics, rejectionCode: classifyRejectionCode(code) };
  } catch {
    return diagnostics;
  }
}

const safeCode = (value: unknown, allowed: ReadonlySet<string>): string =>
  typeof value === "string" && allowed.has(value) ? value : "unrecognized";

/**
 * One log line from fixed keys and re-validated values. Re-validation means a
 * caller that bypasses the types still cannot put free text into the line.
 */
export function formatGeminiResponseDiagnostics(
  family: DiagnosticFamily,
  outcome: ResponseOutcome,
  diagnostics: GeminiResponseDiagnostics,
): string {
  const familyCode = safeCode(family, FAMILIES);
  const outcomeCode = safeCode(outcome, OUTCOMES);
  const fields = [
    "[analyze-swing] provider response diagnostics",
    `family=${familyCode}`,
    `outcome=${outcomeCode}`,
    `finish_reason=${safeCode(diagnostics.finishReason, FINISH_REASON_VALUES)}`,
    `prompt_tokens=${diagnosticCount(diagnostics.promptTokens)}`,
    `candidate_tokens=${diagnosticCount(diagnostics.candidateTokens)}`,
    `thinking_tokens=${diagnosticCount(diagnostics.thinkingTokens)}`,
    `total_tokens=${diagnosticCount(diagnostics.totalTokens)}`,
    `text_chars=${diagnosticCount(diagnostics.textChars)}`,
  ];
  // The rejection code is added for a full-swing validation_rejected line only,
  // decided from the re-validated codes; every other line is unchanged.
  if (familyCode === "full_swing" && outcomeCode === "validation_rejected") {
    const code = diagnostics.rejectionCode;
    fields.push(`rejection=${code === undefined ? DIAGNOSTIC_UNAVAILABLE : safeCode(code, REJECTION_VALUES)}`);
  }
  return fields.join(" ");
}

/**
 * Best-effort log of one provider answer's outcome. Nothing is logged without
 * a provider answer (null). Never throws, and returns nothing the caller could
 * branch on.
 */
export function logGeminiResponseDiagnostics(
  family: DiagnosticFamily,
  outcome: ResponseOutcome,
  diagnostics: GeminiResponseDiagnostics | null,
): void {
  if (diagnostics === null) return;
  try {
    const line = formatGeminiResponseDiagnostics(family, outcome, diagnostics);
    if (outcome === "completed") console.log(line);
    else console.error(line);
  } catch {
    // Diagnostics never change the analysis outcome.
  }
}
