import "server-only";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type {
  Content,
  GenerateContentResponse,
  GenerationConfig,
} from "@google/generative-ai";

// ============================================================================
// ENT-1D S6 — single-attempt Gemini transport
// ============================================================================
//
// The route used to call the provider through @google/generative-ai, whose
// request goes through the global fetch: Next.js's patched fetch on the server,
// and fetch's default redirect mode, "follow". A 307 or 308 would therefore
// re-send the whole generation request to wherever it pointed, and nothing
// bounded how long the call could take. Neither is configurable through the
// SDK's public options.
//
// This module sends the same request body itself, once, over node:https:
//
//   - exactly one HTTPS request per call, to one fixed host and path; no
//     environment variable, option or argument can point it anywhere else;
//   - redirects are never followed: a 3xx is an answer, not an instruction;
//   - no retry, no fallback model, no second attempt of any kind;
//   - one total deadline for the whole exchange (connect, send, wait, read),
//     which destroys the request and its socket when it fires;
//   - a 2 MiB limit on the response body, counted while it is received;
//   - a dedicated, non-pooled connection per call, so no socket outlives it;
//   - ordinary TLS verification. Nothing here relaxes it.
//
// What a call resolves to decides what the route may do next, and the route's
// claim fencing depends on the difference:
//
//   resolves            a 2xx whose body parsed as JSON: the provider answered.
//   GeminiHttpError     the provider answered with that non-2xx, non-3xx
//                       status. The route decides which statuses prove no
//                       work was done (isDefiniteProviderRejection).
//   GeminiOutcomeUnknownError
//                       anything else: a redirect, the deadline, a transport
//                       failure, or a 2xx body that could not be read or was
//                       larger than GEMINI_MAX_RESPONSE_BYTES. The
//                       provider may have run, so the analysis is stalled and
//                       never re-run.
//
// Response text is extracted by responseText(), which keeps the SDK's rules
// for blocked prompts and bad finish reasons.

/** The only model this route uses. */
export const GEMINI_MODEL = "gemini-2.5-flash";

/** Fixed endpoint: the SDK's default base URL and API version for this model. */
const GEMINI_HOST = "generativelanguage.googleapis.com";
const GEMINI_PATH = `/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Total deadline for one call, kept inside the route's maxDuration of 300 s. */
export const GEMINI_DEADLINE_MS = 240_000;

/**
 * Largest 2xx response body accepted: 2 MiB. Counted as bytes arrive, whatever
 * the framing (Content-Length or chunked), so an oversized body is refused
 * before it is buffered. The route's generation settings cap output at 8,192
 * tokens, far below this, so only a malformed or unexpected answer reaches it.
 * The provider may already have run, so an overflow is an unknown outcome.
 */
export const GEMINI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The provider answered with this status (not 2xx, not a redirect). */
export class GeminiHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Gemini request answered with HTTP ${status}`);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

export type GeminiOutcomeUnknownReason =
  | "redirect"
  | "deadline"
  | "transport"
  | "unreadable_response"
  | "oversized_response";

/** The call ended without a definite answer: the provider may have run. */
export class GeminiOutcomeUnknownError extends Error {
  readonly reason: GeminiOutcomeUnknownReason;
  constructor(reason: GeminiOutcomeUnknownReason) {
    super(`Gemini request outcome unknown: ${reason}`);
    this.name = "GeminiOutcomeUnknownError";
    this.reason = reason;
  }
}

/** A fully received response whose candidate or prompt was blocked. */
export class GeminiResponseBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiResponseBlockedError";
  }
}

export interface GeminiGenerateRequest {
  systemInstruction: string;
  contents: Content[];
  generationConfig: GenerationConfig;
}

/**
 * The request body, serialized exactly as @google/generative-ai 0.24.1 does
 * for `getGenerativeModel({ model, systemInstruction }).generateContent({
 * contents, generationConfig })`: the model-level defaults (an empty
 * safetySettings list, the system instruction as a "system" content) merged
 * with the request, in the SDK's key order. Undefined model-level fields
 * (tools, toolConfig, cachedContent) are omitted by JSON, as they are there.
 */
export function buildGenerateContentBody(request: GeminiGenerateRequest): string {
  return JSON.stringify({
    generationConfig: request.generationConfig,
    safetySettings: [],
    systemInstruction: { role: "system", parts: [{ text: request.systemInstruction }] },
    contents: request.contents,
  });
}

/** Test seam only: the HTTPS request function. Production callers never pass it. */
export type HttpsRequestFn = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

/**
 * One generateContent call, at most one HTTPS request, bounded by
 * GEMINI_DEADLINE_MS. Never retries and never follows a redirect.
 */
export function generateContentOnce(
  apiKey: string,
  request: GeminiGenerateRequest,
  options: { deadlineMs?: number; requestFn?: HttpsRequestFn } = {},
): Promise<GenerateContentResponse> {
  const deadlineMs = options.deadlineMs ?? GEMINI_DEADLINE_MS;
  const requestFn: HttpsRequestFn = options.requestFn ?? httpsRequest;
  const body = Buffer.from(buildGenerateContentBody(request), "utf8");

  return new Promise<GenerateContentResponse>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | null = null;
    let res: IncomingMessage | null = null;

    const finish = (outcome: { value: GenerateContentResponse } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Release the connection whatever happened: an answered request is
      // already complete, and an unanswered one must not keep running.
      if (res && !res.complete) res.destroy();
      if (req && !req.destroyed) req.destroy();
      if ("value" in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };

    const deadline = setTimeout(() => finish({ error: new GeminiOutcomeUnknownError("deadline") }), deadlineMs);

    try {
      req = requestFn(
        {
          method: "POST",
          host: GEMINI_HOST,
          port: 443,
          path: GEMINI_PATH,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            "x-goog-api-key": apiKey,
          },
          // A dedicated connection per call: nothing is pooled or reused.
          agent: false,
        },
        (response) => {
          res = response;
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish({ error: new GeminiOutcomeUnknownError("redirect") });
            return;
          }
          if (status < 200 || status >= 300) {
            finish({ error: new GeminiHttpError(status) });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            received += chunk.length;
            if (received > GEMINI_MAX_RESPONSE_BYTES) {
              // Refused while receiving: nothing beyond the limit is kept, and
              // finish() destroys the response and the request.
              chunks.length = 0;
              finish({ error: new GeminiOutcomeUnknownError("oversized_response") });
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", () => finish({ error: new GeminiOutcomeUnknownError("transport") }));
          response.on("aborted", () => finish({ error: new GeminiOutcomeUnknownError("transport") }));
          response.on("close", () => {
            if (!response.complete) finish({ error: new GeminiOutcomeUnknownError("transport") });
          });
          response.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              finish({ error: new GeminiOutcomeUnknownError("unreadable_response") });
              return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              finish({ error: new GeminiOutcomeUnknownError("unreadable_response") });
              return;
            }
            finish({ value: parsed as GenerateContentResponse });
          });
        },
      );
    } catch {
      finish({ error: new GeminiOutcomeUnknownError("transport") });
      return;
    }

    req.on("error", () => finish({ error: new GeminiOutcomeUnknownError("transport") }));
    req.end(body);
  });
}

/** The finish reasons @google/generative-ai 0.24.1 treats as a blocked candidate. */
const BAD_FINISH_REASONS: readonly string[] = ["RECITATION", "SAFETY", "LANGUAGE"];

/**
 * The response text, with the same rules as the SDK's `response.text()` in
 * @google/generative-ai 0.24.1: the first candidate only; a blocked candidate
 * (RECITATION, SAFETY or LANGUAGE) or a blocked prompt with no candidates
 * throws; otherwise the text, executable-code and code-execution-result parts
 * of the first candidate are joined, and a response with neither candidates
 * nor prompt feedback yields "". The message is internal and never returned
 * to the golfer.
 */
export function responseText(response: GenerateContentResponse): string {
  const candidates = response.candidates;
  if (candidates && candidates.length > 0) {
    const first = candidates[0];
    if (first.finishReason && BAD_FINISH_REASONS.includes(first.finishReason)) {
      throw new GeminiResponseBlockedError(`Candidate was blocked due to ${first.finishReason}`);
    }
    const texts: string[] = [];
    for (const part of first.content?.parts ?? []) {
      if (part.text) texts.push(part.text);
      if (part.executableCode) {
        texts.push("\n```" + part.executableCode.language + "\n" + part.executableCode.code + "\n```\n");
      }
      if (part.codeExecutionResult) {
        texts.push("\n```\n" + part.codeExecutionResult.output + "\n```\n");
      }
    }
    return texts.join("");
  }
  if (response.promptFeedback) {
    throw new GeminiResponseBlockedError("Text not available. Response was blocked");
  }
  return "";
}
