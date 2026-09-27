/**
 * SEC-DRILL1 — /api/verify-drill cross-owner drill-video read closure.
 *
 * Before this slice the route downloaded any caller-supplied drill_videos path
 * with the service-role client, bypassing the owner-folder Storage policy, and
 * forwarded the object to Gemini. The route now:
 *
 *   1. classifies the raw path against the authenticated user id
 *      (lib/drill-video-path.ts) before any lookup, download, or AI call;
 *   2. downloads with the caller-scoped client, so Storage RLS stays the
 *      authority for owned objects.
 *
 * Behaviour is proved by invoking POST with every external dependency mocked
 * (Supabase client, Gemini SDKs, fs writes). Ordering and the absence of the
 * admin client are additionally pinned against the route source text.
 * No network, no Gemini, no Storage, no filesystem writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const calls = vi.hoisted(() => ({
  createClient: 0,
  fromTables: [] as string[],
  storageBuckets: [] as string[],
  downloads: [] as string[],
  writeFileSync: 0,
  unlinkSync: 0,
  fileManagerConstructed: 0,
  uploadFile: 0,
  deleteFile: 0,
  generativeConstructed: 0,
  generateContent: 0,
  userDrillsInserts: [] as unknown[],
  userDrillsUpdates: [] as unknown[],
}));

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  drill: null as { name: string; ai_verification_prompt: string } | null,
  downloadFails: false,
}));

vi.mock("@/utils/supabase/server", () => {
  function fakeClient() {
    return {
      auth: {
        getUser: async () =>
          state.user
            ? { data: { user: state.user }, error: null }
            : { data: { user: null }, error: { message: "no session" } },
      },
      from(table: string) {
        calls.fromTables.push(table);
        if (table === "drills") {
          const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () =>
              state.drill ? { data: state.drill, error: null } : { data: null, error: { message: "not found" } },
          };
          return chain;
        }
        if (table === "user_drills") {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: null, error: null }),
            insert: async (row: unknown) => {
              calls.userDrillsInserts.push(row);
              return { error: null };
            },
            update: (row: unknown) => {
              calls.userDrillsUpdates.push(row);
              return { eq: async () => ({ error: null }) };
            },
          };
          return chain;
        }
        throw new Error(`unexpected table ${table}`);
      },
      storage: {
        from(bucket: string) {
          calls.storageBuckets.push(bucket);
          return {
            download: async (objectPath: string) => {
              calls.downloads.push(objectPath);
              if (state.downloadFails) return { data: null, error: { message: "Object not found" } };
              return { data: new Blob([new Uint8Array([1, 2, 3])]), error: null };
            },
          };
        },
      },
    };
  }
  return {
    createClient: async () => {
      calls.createClient += 1;
      return fakeClient();
    },
  };
});

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("SEC-DRILL1: admin client must not be used by verify-drill");
  },
}));

vi.mock("@google/generative-ai", () => ({
  SchemaType: { OBJECT: "object", BOOLEAN: "boolean", STRING: "string" },
  GoogleGenerativeAI: class {
    constructor() {
      calls.generativeConstructed += 1;
    }
    getGenerativeModel() {
      return {
        generateContent: async () => {
          calls.generateContent += 1;
          return { response: { text: () => '{"pass":true,"feedback":"Solid rep."}' } };
        },
      };
    }
  },
}));

vi.mock("@google/generative-ai/server", () => ({
  FileState: { PROCESSING: "PROCESSING", ACTIVE: "ACTIVE", FAILED: "FAILED" },
  GoogleAIFileManager: class {
    constructor() {
      calls.fileManagerConstructed += 1;
    }
    async uploadFile() {
      calls.uploadFile += 1;
      return { file: { name: "files/mock", state: "ACTIVE", mimeType: "video/mp4", uri: "mock://file" } };
    }
    async getFile() {
      return { name: "files/mock", state: "ACTIVE", mimeType: "video/mp4", uri: "mock://file" };
    }
    async deleteFile() {
      calls.deleteFile += 1;
    }
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSync = () => {
    calls.writeFileSync += 1;
  };
  const unlinkSync = () => {
    calls.unlinkSync += 1;
  };
  return { ...actual, default: { ...actual, writeFileSync, unlinkSync }, writeFileSync, unlinkSync };
});

import { POST } from "@/app/api/verify-drill/route";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CALLER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const DRILL_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNED_PATH = `${CALLER_ID}/1727460000000_clip.mp4`;

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function badJsonRequest(): NextRequest {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  } as unknown as NextRequest;
}

function resetCalls(): void {
  calls.createClient = 0;
  calls.fromTables = [];
  calls.storageBuckets = [];
  calls.downloads = [];
  calls.writeFileSync = 0;
  calls.unlinkSync = 0;
  calls.fileManagerConstructed = 0;
  calls.uploadFile = 0;
  calls.deleteFile = 0;
  calls.generativeConstructed = 0;
  calls.generateContent = 0;
  calls.userDrillsInserts = [];
  calls.userDrillsUpdates = [];
}

function expectNothingDownstream(): void {
  expect(calls.fromTables).toEqual([]);
  expect(calls.storageBuckets).toEqual([]);
  expect(calls.downloads).toEqual([]);
  expect(calls.writeFileSync).toBe(0);
  expect(calls.fileManagerConstructed).toBe(0);
  expect(calls.uploadFile).toBe(0);
  expect(calls.generativeConstructed).toBe(0);
  expect(calls.generateContent).toBe(0);
}

const savedEnv = { gemini: process.env.GEMINI_API_KEY, google: process.env.GOOGLE_AI_API_KEY };

beforeEach(() => {
  resetCalls();
  state.user = { id: CALLER_ID };
  state.drill = { name: "Mock Drill", ai_verification_prompt: "Mock prompt" };
  state.downloadFails = false;
  process.env.GEMINI_API_KEY = "test-placeholder-not-a-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv.gemini === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnv.gemini;
  if (savedEnv.google === undefined) delete process.env.GOOGLE_AI_API_KEY;
  else process.env.GOOGLE_AI_API_KEY = savedEnv.google;
});

// ── Behaviour ─────────────────────────────────────────────────────────────────

describe("SEC-DRILL1 — denied paths stop before every downstream effect", () => {
  it("R1 returns 403 Forbidden for a different-owner path", async () => {
    const res = await POST(
      request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `${OTHER_ID}/1727460000000_clip.mp4` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("R1 returns 403 Forbidden for a leading-slash path", async () => {
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `/${OWNED_PATH}` }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("R2 returns 400 Invalid videoStoragePath for a malformed own path", async () => {
    for (const bad of [`${CALLER_ID}/`, `${CALLER_ID}/a/b`, `${CALLER_ID}/..`, `${CALLER_ID}/a%2Fb`]) {
      const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: bad }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid videoStoragePath" });
    }
  });

  it("R3–R7 a different-owner path touches no drill lookup, Storage, fs, or Gemini", async () => {
    await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `${OTHER_ID}/x.mp4` }));
    expectNothingDownstream();
  });

  it("R3–R7 a malformed own path touches no drill lookup, Storage, fs, or Gemini", async () => {
    await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `${CALLER_ID}/a/b.mp4` }));
    expectNothingDownstream();
  });

  it("R7 the guard wins even when the drill does not exist", async () => {
    state.drill = null;
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `${OTHER_ID}/x.mp4` }));
    expect(res.status).toBe(403);
    expect(calls.fromTables).toEqual([]);
  });

  it("R7 the guard wins even when Gemini is not configured", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: `${OTHER_ID}/x.mp4` }));
    expect(res.status).toBe(403);
  });
});

describe("SEC-DRILL1 — owned paths keep the existing pipeline", () => {
  it("R8/R9 reaches the downstream pipeline with the caller-scoped Storage client", async () => {
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: OWNED_PATH }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pass: true,
      status: "verified",
      feedback: "Solid rep.",
      drillId: DRILL_ID,
      userId: CALLER_ID,
    });
    // One client, created by the route for the caller; its storage did the read.
    expect(calls.createClient).toBe(1);
    expect(calls.storageBuckets).toEqual(["drill_videos"]);
    expect(calls.downloads).toEqual([OWNED_PATH]);
    expect(calls.fromTables).toEqual(["drills", "user_drills", "user_drills"]);
    expect(calls.writeFileSync).toBe(1);
    expect(calls.uploadFile).toBe(1);
    expect(calls.generateContent).toBe(1);
    expect(calls.unlinkSync).toBe(1);
    expect(calls.userDrillsInserts).toEqual([
      {
        user_id: CALLER_ID,
        drill_id: DRILL_ID,
        status: "verified",
        latest_ai_feedback: "Solid rep.",
        video_url: OWNED_PATH,
      },
    ]);
  });

  it("keeps 502 when the caller-scoped read fails, with no admin retry", async () => {
    state.downloadFails = true;
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: OWNED_PATH }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to download video from storage" });
    expect(calls.downloads).toEqual([OWNED_PATH]);
    expect(calls.writeFileSync).toBe(0);
    expect(calls.uploadFile).toBe(0);
    expect(calls.generateContent).toBe(0);
  });
});

describe("SEC-DRILL1 — pre-existing request contract is unchanged", () => {
  it("unauthenticated → 401", async () => {
    state.user = null;
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: OWNED_PATH }));
    expect(res.status).toBe(401);
    expectNothingDownstream();
  });

  it("invalid JSON → 400", async () => {
    const res = await POST(badJsonRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("missing fields → 400", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ userId: CALLER_ID, videoStoragePath: OWNED_PATH }, "Missing drillId"],
      [{ drillId: DRILL_ID, videoStoragePath: OWNED_PATH }, "Missing userId"],
      [{ drillId: DRILL_ID, userId: CALLER_ID }, "Missing videoStoragePath"],
    ];
    for (const [body, error] of cases) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expectNothingDownstream();
  });

  it("R12 body.userId mismatch → 403 even for a path owned by that body.userId", async () => {
    const res = await POST(
      request({ drillId: DRILL_ID, userId: OTHER_ID, videoStoragePath: `${OTHER_ID}/1727460000000_clip.mp4` }),
    );
    expect(res.status).toBe(403);
    expectNothingDownstream();
  });

  it("drill not found → 404 for an owned path, before Storage", async () => {
    state.drill = null;
    const res = await POST(request({ drillId: DRILL_ID, userId: CALLER_ID, videoStoragePath: OWNED_PATH }));
    expect(res.status).toBe(404);
    expect(calls.downloads).toEqual([]);
  });
});

// ── Source contract ───────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_SOURCE = readFileSync(path.join(REPO_ROOT, "app", "api", "verify-drill", "route.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\/\/.*$/gm, " ");
}

const CODE = stripComments(ROUTE_SOURCE);
const HANDLER = CODE.slice(CODE.indexOf("export async function POST("));

function at(needle: string): number {
  const i = HANDLER.indexOf(needle);
  if (i === -1) throw new Error(`required anchor absent: ${needle}`);
  return i;
}

describe("SEC-DRILL1 — route source contract", () => {
  it("R10 has no admin client import or call", () => {
    expect(CODE).not.toContain("createAdminClient");
    expect(CODE).not.toContain("@/utils/supabase/admin");
    expect(CODE).not.toContain("SERVICE_ROLE");
  });

  it("R9 downloads through the caller-scoped client", () => {
    expect(HANDLER).toMatch(/await supabase\.storage\s*\.from\("drill_videos"\)\s*\.download\(videoStoragePath\)/);
  });

  it("R7 runs the owner-path guard after the userId check and before every downstream effect", () => {
    const userIdCheck = at("userId !== user.id");
    const guard = at("checkDrillVideoPath(user.id, videoStoragePath)");
    expect(guard).toBeGreaterThan(userIdCheck);
    for (const effect of [
      '.from("drills")',
      "GEMINI_API_KEY",
      ".storage",
      ".download(",
      "fs.writeFileSync",
      "new GoogleAIFileManager(",
      "generateContent",
      '.from("user_drills")',
    ]) {
      expect(at(effect)).toBeGreaterThan(guard);
    }
  });

  it("R12 derives ownership from auth.getUser(), not the request body", () => {
    expect(HANDLER).toContain("await supabase.auth.getUser()");
    expect(HANDLER).toContain("checkDrillVideoPath(user.id, videoStoragePath)");
    expect(HANDLER).not.toContain("checkDrillVideoPath(userId");
  });

  it("R11 keeps the full_swing drill-family filter", () => {
    expect(HANDLER).toContain('.eq("drill_family", "full_swing")');
  });

  it("maps guard outcomes to the frozen responses", () => {
    expect(HANDLER).toMatch(
      /pathCheck\.kind === "forbidden"\)\s*\{\s*return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/,
    );
    expect(HANDLER).toMatch(
      /pathCheck\.kind === "invalid"\)\s*\{\s*return NextResponse\.json\(\{ error: "Invalid videoStoragePath" \}, \{ status: 400 \}\);/,
    );
  });
});
