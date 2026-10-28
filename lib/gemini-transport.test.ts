import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI, SchemaType, type GenerateContentResponse } from "@google/generative-ai";

// ============================================================================
// ENT-1D S6 — lib/gemini-transport.ts
// ============================================================================
//
// The transport runs for real against a counting loopback HTTP server. The
// only replaced piece is its test seam: `requestFn` is node:http's request
// with the host and port pointed at that server, so every physical request the
// transport makes is observed. Nothing leaves the machine and no credential is
// used ("synthetic-key" throughout).
//
// The SDK parity tests drive @google/generative-ai 0.24.1 itself, with the
// global fetch stubbed to capture its request, and compare it with what the
// transport sends; the SDK makes no network call either.

vi.mock("server-only", () => ({}));

import {
  GEMINI_DEADLINE_MS,
  GEMINI_MAX_RESPONSE_BYTES,
  GEMINI_MODEL,
  GeminiHttpError,
  GeminiOutcomeUnknownError,
  GeminiResponseBlockedError,
  buildGenerateContentBody,
  generateContentOnce,
  responseText,
  type GeminiGenerateRequest,
  type HttpsRequestFn,
} from "@/lib/gemini-transport";
import { PUTTING_RESPONSE_SCHEMA, PUTTING_SYSTEM_INSTRUCTION } from "@/lib/putting-analysis-contract";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const readSource = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const ENDPOINT_PATH = "/v1beta/models/gemini-2.5-flash:generateContent";
const OK_RESPONSE = {
  candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"score":75}' }] }, finishReason: "STOP" }],
};

const REQUEST: GeminiGenerateRequest = {
  systemInstruction: "SYNTHETIC SYSTEM INSTRUCTION",
  contents: [
    {
      role: "user",
      parts: [{ inlineData: { mimeType: "video/mp4", data: "AAAAGGZ0eXBpc29t" } }, { text: "synthetic prompt" }],
    },
  ],
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: { type: SchemaType.OBJECT, properties: { score: { type: SchemaType.INTEGER } }, required: ["score"] },
    temperature: 0.0,
    maxOutputTokens: 8192,
  },
};

// ── Counting loopback provider ───────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface Stub {
  server: Server;
  port: number;
  /** Every request received, by path. */
  hits: { path: string; headers: IncomingMessage["headers"]; body: string }[];
  /** Server-side sockets, to observe that the transport closed its connection. */
  sockets: Set<Socket>;
  handler: Handler;
}

const stubs: Stub[] = [];

async function startStub(handler: Handler): Promise<Stub> {
  const stub = { hits: [], sockets: new Set<Socket>(), handler } as unknown as Stub;
  stub.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      stub.hits.push({ path: req.url ?? "", headers: req.headers, body });
      stub.handler(req, res, body);
    });
  });
  stub.server.on("connection", (socket: Socket) => {
    stub.sockets.add(socket);
    socket.on("close", () => stub.sockets.delete(socket));
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  stub.port = (stub.server.address() as AddressInfo).port;
  stubs.push(stub);
  return stub;
}

/** The seam: node:http to the stub, keeping every option the transport chose. */
const seen: Parameters<HttpsRequestFn>[0][] = [];
function viaStub(stub: Stub): HttpsRequestFn {
  return (options, onResponse) => {
    seen.push(options);
    return http.request({ ...options, host: "127.0.0.1", port: stub.port }, onResponse);
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function outcome(promise: Promise<unknown>): Promise<{ value?: unknown; error?: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    return { value: await promise, ms: Date.now() - t0 };
  } catch (error) {
    return { error, ms: Date.now() - t0 };
  }
}

beforeEach(() => {
  seen.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const stub of stubs.splice(0)) {
    stub.sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  }
});

// ── T1. one request, the fixed endpoint, the documented options ──────────────

describe("T1. a successful call is exactly one request to the fixed endpoint", () => {
  it("resolves the parsed body after one physical request carrying the SDK body", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OK_RESPONSE));
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(OK_RESPONSE);
    expect(stub.hits).toHaveLength(1);
    expect(stub.hits[0].path).toBe(ENDPOINT_PATH);
    expect(stub.hits[0].body).toBe(buildGenerateContentBody(REQUEST));
    expect(stub.hits[0].headers["content-type"]).toBe("application/json");
    expect(stub.hits[0].headers["x-goog-api-key"]).toBe("synthetic-key");
    // A dedicated, non-pooled connection: Node closes it after the response.
    expect(stub.hits[0].headers.connection).toBe("close");
    await settle(200);
    expect(stub.hits).toHaveLength(1);
  });

  it("asks for the fixed production host, port and path, unpooled, with TLS verification untouched", () => {
    expect(GEMINI_MODEL).toBe("gemini-2.5-flash");
    expect(GEMINI_DEADLINE_MS).toBe(240_000);
    const options: Parameters<HttpsRequestFn>[0][] = [];
    const capture: HttpsRequestFn = (o) => {
      options.push(o);
      throw new Error("captured");
    };
    void generateContentOnce("synthetic-key", REQUEST, { requestFn: capture }).catch(() => undefined);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      method: "POST",
      host: "generativelanguage.googleapis.com",
      port: 443,
      path: ENDPOINT_PATH,
      agent: false,
    });
    for (const relaxed of ["rejectUnauthorized", "checkServerIdentity", "ca", "secureOptions", "servername"]) {
      expect(options[0], relaxed).not.toHaveProperty(relaxed);
    }
  });

  it("clears its deadline timer when the call settles", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(OK_RESPONSE));
    });
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) });
    const deadlineTimer = setSpy.mock.results.find((r, i) => setSpy.mock.calls[i][1] === GEMINI_DEADLINE_MS)?.value;
    expect(deadlineTimer).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(deadlineTimer);
  });
});

// ── T2. redirects are answers, never followed ────────────────────────────────

describe("T2. a redirect is never followed", () => {
  it.each([301, 302, 303, 307, 308])("HTTP %i → outcome unknown (redirect); the target receives zero requests", async (status) => {
    const target = await startStub((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(OK_RESPONSE));
    });
    const origin = await startStub((_req, res) => {
      res.writeHead(status, { location: `http://127.0.0.1:${target.port}${ENDPOINT_PATH}` });
      res.end();
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(origin) }));
    expect(result.error).toBeInstanceOf(GeminiOutcomeUnknownError);
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("redirect");
    await settle(300);
    expect(origin.hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
  });

  it("a same-origin redirect is not followed either", async () => {
    const stub = await startStub((req, res) => {
      if (req.url === ENDPOINT_PATH) {
        res.writeHead(307, { location: "/elsewhere" });
        res.end();
      } else {
        res.writeHead(200);
        res.end(JSON.stringify(OK_RESPONSE));
      }
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("redirect");
    await settle(300);
    expect(stub.hits.map((h) => h.path)).toEqual([ENDPOINT_PATH]);
  });
});

// ── T3. one total deadline, with the request actively cancelled ──────────────

describe("T3. the deadline cancels the request and releases the connection", () => {
  it("no response at all → outcome unknown (deadline) at the deadline; the socket is closed", async () => {
    const stub = await startStub(() => {
      /* never answers */
    });
    const result = await outcome(
      generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub), deadlineMs: 300 }),
    );
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("deadline");
    expect(result.ms).toBeGreaterThanOrEqual(290);
    expect(result.ms).toBeLessThan(2_000);
    await settle(200);
    expect(stub.sockets.size).toBe(0);
    expect(stub.hits).toHaveLength(1);
  });

  it("headers sent but the body never finishes → outcome unknown (deadline); the socket is closed", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"candidates":');
    });
    const result = await outcome(
      generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub), deadlineMs: 300 }),
    );
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("deadline");
    await settle(200);
    expect(stub.sockets.size).toBe(0);
    expect(stub.hits).toHaveLength(1);
  });

  it("the deadline covers the whole exchange, not each step", async () => {
    // Headers at 150 ms, then a trickle that would outlast a per-read timeout.
    const stub = await startStub((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        const tick = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(" ");
          else clearInterval(tick);
        }, 50);
        res.on("close", () => clearInterval(tick));
      }, 150);
    });
    const result = await outcome(
      generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub), deadlineMs: 400 }),
    );
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("deadline");
    expect(result.ms).toBeLessThan(2_000);
    await settle(200);
    expect(stub.sockets.size).toBe(0);
  });
});

// ── T4. provider answers are classified once, never retried ──────────────────

describe("T4. a non-2xx, non-redirect answer is reported with its status and not retried", () => {
  it.each([400, 401, 403, 404, 408, 409, 429, 499, 500, 502, 503, 504])("HTTP %i → GeminiHttpError carrying that status, one request", async (status) => {
    const stub = await startStub((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: status, message: "synthetic" } }));
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeInstanceOf(GeminiHttpError);
    expect((result.error as GeminiHttpError).status).toBe(status);
    await settle(300);
    expect(stub.hits).toHaveLength(1);
  });
});

// ── T5. transport failures and unreadable bodies are unknown outcomes ─────────

describe("T5. a failure without a complete, readable answer is an unknown outcome", () => {
  it("the connection is destroyed mid-body → outcome unknown (transport)", async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"candidates":[');
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("transport");
    expect(stub.hits).toHaveLength(1);
  });

  it("the connection is destroyed before any response → outcome unknown (transport)", async () => {
    const stub = await startStub((req) => req.socket.destroy());
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("transport");
    expect(stub.hits).toHaveLength(1);
  });

  it("nothing is listening → outcome unknown (transport)", async () => {
    const stub = await startStub(() => undefined);
    const port = stub.port;
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    stubs.splice(stubs.indexOf(stub), 1);
    const refused: HttpsRequestFn = (options, onResponse) =>
      http.request({ ...options, host: "127.0.0.1", port }, onResponse);
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: refused }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("transport");
  });

  it.each([
    ["not JSON", "<html>gateway</html>"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["empty", ""],
  ])("a 2xx whose body is %s → outcome unknown (unreadable response)", async (_label, body) => {
    const stub = await startStub((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("unreadable_response");
    expect(stub.hits).toHaveLength(1);
  });

  it("a request function that throws synchronously → outcome unknown (transport), timer cleared", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const throwing: HttpsRequestFn = () => {
      throw new Error("synthetic");
    };
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: throwing }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("transport");
    expect(clearSpy).toHaveBeenCalled();
  });
});

// ── T5b. the 2 MiB response-body limit, enforced while receiving ─────────────

/** A valid JSON response body of exactly `bytes` bytes. */
function jsonBodyOfSize(bytes: number): Buffer {
  const head = '{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"{}"}]},"finishReason":"STOP"}],"pad":"';
  const tail = '"}';
  return Buffer.from(head + "x".repeat(bytes - head.length - tail.length) + tail, "utf8");
}

describe("T5b. a 2xx body larger than 2 MiB is refused while it is received", () => {
  it("the limit is 2 MiB", () => {
    expect(GEMINI_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("exactly at the limit (Content-Length) is accepted", async () => {
    const body = jsonBodyOfSize(GEMINI_MAX_RESPONSE_BYTES);
    expect(body.length).toBe(GEMINI_MAX_RESPONSE_BYTES);
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeUndefined();
    expect((result.value as { candidates: unknown[] }).candidates).toHaveLength(1);
    expect(stub.hits).toHaveLength(1);
  });

  it("exactly at the limit across chunks (chunked encoding) is accepted", async () => {
    const body = jsonBodyOfSize(GEMINI_MAX_RESPONSE_BYTES);
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); // no Content-Length: chunked
      res.write(body.subarray(0, 1024 * 1024));
      setTimeout(() => res.end(body.subarray(1024 * 1024)), 20);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeUndefined();
    expect(stub.hits).toHaveLength(1);
  });

  it("one byte over the limit (Content-Length) → outcome unknown (oversized); connection closed; no retry", async () => {
    const body = jsonBodyOfSize(GEMINI_MAX_RESPONSE_BYTES + 1);
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
      res.end(body);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeInstanceOf(GeminiOutcomeUnknownError);
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("oversized_response");
    await settle(300);
    expect(stub.sockets.size).toBe(0);
    expect(stub.hits).toHaveLength(1);
  });

  it("overflow across chunks is refused before the body ends; the connection is closed and the timer cleared", async () => {
    const MiB = Buffer.alloc(1024 * 1024, 0x78);
    const sent = { chunks: 0, finishedBeforeClose: true };
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); // chunked
      res.write('{"pad":"');
      // Four 1 MiB chunks, 50 ms apart: the limit is crossed during the third.
      const writeNext = () => {
        if (res.destroyed || res.writableEnded) return;
        if (sent.chunks === 4) {
          res.end('"}');
          return;
        }
        sent.chunks += 1;
        res.write(MiB);
        setTimeout(writeNext, 50);
      };
      res.on("close", () => {
        sent.finishedBeforeClose = res.writableFinished;
      });
      writeNext();
    });
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect((result.error as GeminiOutcomeUnknownError).reason).toBe("oversized_response");
    const deadlineTimer = setSpy.mock.results.find((r, i) => setSpy.mock.calls[i][1] === GEMINI_DEADLINE_MS)?.value;
    expect(deadlineTimer).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(deadlineTimer);
    await settle(400);
    expect(stub.sockets.size).toBe(0);
    expect(sent.finishedBeforeClose).toBe(false);
    expect(sent.chunks).toBeLessThan(4);
    expect(stub.hits).toHaveLength(1);
  });

  it("a non-2xx body is never read, so the limit does not apply to it", async () => {
    const body = Buffer.alloc(GEMINI_MAX_RESPONSE_BYTES + 1024, 0x78);
    const stub = await startStub((_req, res) => {
      res.writeHead(503, { "content-length": String(body.length) });
      res.end(body);
    });
    const result = await outcome(generateContentOnce("synthetic-key", REQUEST, { requestFn: viaStub(stub) }));
    expect(result.error).toBeInstanceOf(GeminiHttpError);
    expect((result.error as GeminiHttpError).status).toBe(503);
  });
});

// ── T6. request-body and response-text parity with @google/generative-ai 0.24.1 ─

/** What the SDK sends for the route's call shape, captured from a stubbed fetch. */
async function sdkRequest(request: GeminiGenerateRequest): Promise<{ url: string; body: string; headers: Headers }> {
  let captured: { url: string; body: string; headers: Headers } | null = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    captured = { url: String(url), body: String(init.body), headers: new Headers(init.headers) };
    return new Response(JSON.stringify(OK_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
  });
  const model = new GoogleGenerativeAI("synthetic-key").getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: request.systemInstruction,
  });
  await model.generateContent({ contents: request.contents, generationConfig: request.generationConfig });
  vi.unstubAllGlobals();
  if (!captured) throw new Error("the SDK made no request");
  return captured;
}

/** The SDK's own response.text() for a response body, or the error it raises. */
async function sdkText(body: unknown): Promise<{ text?: string; threw?: boolean }> {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
  const model = new GoogleGenerativeAI("synthetic-key").getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent("x");
  vi.unstubAllGlobals();
  try {
    return { text: result.response.text() };
  } catch {
    return { threw: true };
  }
}

function ownText(body: unknown): { text?: string; threw?: boolean } {
  try {
    return { text: responseText(body as GenerateContentResponse) };
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiResponseBlockedError);
    return { threw: true };
  }
}

describe("T6. the transport sends what the SDK sent, and reads text as the SDK did", () => {
  it("full-swing shape: identical endpoint and byte-identical body", async () => {
    const sdk = await sdkRequest(REQUEST);
    expect(sdk.url).toBe(`https://generativelanguage.googleapis.com${ENDPOINT_PATH}`);
    expect(buildGenerateContentBody(REQUEST)).toBe(sdk.body);
    expect(sdk.headers.get("x-goog-api-key")).toBe("synthetic-key");
    expect(sdk.headers.get("content-type")).toBe("application/json");
  });

  it("putting contract: byte-identical body with the real putting instruction and schema", async () => {
    const putting: GeminiGenerateRequest = {
      systemInstruction: PUTTING_SYSTEM_INSTRUCTION,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data: "AAAA" } }, { text: "p" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PUTTING_RESPONSE_SCHEMA,
        temperature: 0.0,
        maxOutputTokens: 4096,
      },
    };
    expect(buildGenerateContentBody(putting)).toBe((await sdkRequest(putting)).body);
  });

  const TEXT_PART = { text: '{"a":1}' };
  it.each([
    ["STOP with one text part", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "STOP" }] }],
    ["several text parts", { candidates: [{ content: { role: "model", parts: [{ text: "a" }, { text: "b" }] }, finishReason: "STOP" }] }],
    ["code parts", { candidates: [{ content: { role: "model", parts: [{ executableCode: { language: "PYTHON", code: "1" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" } }] } }] }],
    ["MAX_TOKENS (not blocked)", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "MAX_TOKENS" }] }],
    ["OTHER (not blocked)", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "OTHER" }] }],
    ["SAFETY", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "SAFETY" }] }],
    ["RECITATION", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "RECITATION" }] }],
    ["LANGUAGE", { candidates: [{ content: { role: "model", parts: [TEXT_PART] }, finishReason: "LANGUAGE" }] }],
    ["a blocked prompt with no candidates", { promptFeedback: { blockReason: "SAFETY", safetyRatings: [] } }],
    ["no candidates and no feedback", {}],
    ["a candidate with no content", { candidates: [{ finishReason: "STOP" }] }],
    ["two candidates: the first is used", { candidates: [{ content: { parts: [{ text: "first" }] } }, { content: { parts: [{ text: "second" }] } }] }],
  ])("%s: same text, or both refuse", async (_label, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(ownText(body)).toEqual(await sdkText(body));
    warn.mockRestore();
  });
});

// ── Source guards ────────────────────────────────────────────────────────────

describe("the transport and the route keep the single-attempt guarantees in source", () => {
  const transport = readSource("lib/gemini-transport.ts");
  const route = readSource("app/api/analyze-swing/route.ts");

  it("the transport has no fetch, no environment, no TLS override and no retry", () => {
    expect(transport).not.toMatch(/\bfetch\s*\(/);
    expect(transport).not.toContain("process.env");
    expect(transport).not.toMatch(/rejectUnauthorized|NODE_TLS|checkServerIdentity/);
    // The one loop in the module walks the response parts; nothing loops on a request.
    expect(transport).not.toMatch(/\bwhile\s*\(/);
    expect(transport.match(/\bfor\s*\(/g)).toHaveLength(1);
    expect(transport).toContain("for (const part of first.content?.parts ?? [])");
    expect(transport.match(/requestFn\(/g)).toHaveLength(1);
    expect(transport).toContain('const GEMINI_HOST = "generativelanguage.googleapis.com";');
    expect(transport).toContain("agent: false");
  });

  it("the route calls the provider only through the transport", () => {
    expect(route).not.toContain("GoogleGenerativeAI(");
    expect(route).not.toContain("getGenerativeModel");
    expect(route).not.toContain("GoogleGenerativeAIFetchError");
    expect(route.match(/await generateContentOnce\(/g)).toHaveLength(2);
    expect(route).toContain("error instanceof GeminiHttpError");
  });
});
