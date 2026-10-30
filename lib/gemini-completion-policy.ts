// ============================================================================
// ENT-1D S6-R1 — when a provider answer may become an analysis
// ============================================================================
//
// A 2xx answer from the transport is not yet a usable analysis. The provider
// states why generation ended in the first candidate's finishReason, and only
// "STOP" says the model finished on its own terms. Anything else — the output
// limit (MAX_TOKENS), a block, an unknown or future reason, or no reason at
// all — means the text may be cut short or withheld, even when it happens to
// parse as JSON. Such an answer is never scored or stored.
//
// This is decided here, from the response object, BEFORE any text is read, so
// blocked and incomplete answers take one path whatever their text contains.
// It is deliberately separate from lib/gemini-response-diagnostics.ts: the
// diagnostics only describe an answer for the logs, best effort; this module
// decides the outcome and is the only place that does.
//
// Pure and total: it never throws, and an unreadable response is incomplete.

/** Finish reasons that mean the provider withheld or blocked the output. */
const BLOCKED_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

export type ProviderCompletion =
  | { readonly complete: true }
  /** blocked: the provider refused or withheld output. incomplete: anything else that is not STOP. */
  | { readonly complete: false; readonly kind: "blocked" | "incomplete" };

const COMPLETE: ProviderCompletion = Object.freeze({ complete: true });
const BLOCKED: ProviderCompletion = Object.freeze({ complete: false, kind: "blocked" });
const INCOMPLETE: ProviderCompletion = Object.freeze({ complete: false, kind: "incomplete" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Complete only when the first candidate's finishReason is exactly "STOP".
 * A missing, unknown or non-STOP reason is never complete, even with valid JSON.
 */
export function decideProviderCompletion(response: unknown): ProviderCompletion {
  try {
    if (!isRecord(response)) return INCOMPLETE;
    const candidates = response.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0 || !isRecord(candidates[0])) {
      // No candidate: a prompt block when the provider says so, otherwise nothing usable came back.
      const feedback = response.promptFeedback;
      return isRecord(feedback) && feedback.blockReason !== undefined && feedback.blockReason !== null
        ? BLOCKED
        : INCOMPLETE;
    }
    const reason = candidates[0].finishReason;
    if (reason === "STOP") return COMPLETE;
    if (typeof reason === "string" && BLOCKED_FINISH_REASONS.has(reason)) return BLOCKED;
    return INCOMPLETE;
  } catch {
    return INCOMPLETE;
  }
}
