import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_MIME_TYPES,
  UPLOAD_BUCKET,
  buildUploadFinalizeDto,
  buildUploadObjectPath,
  isCanonicalFinalizedRow,
  parseUploadFinalizeRequest,
  validateStoredUploadMetadata,
} from "@/lib/api/v1-upload-dto";
import type { VerifiedAuth } from "@/utils/supabase/server";
import { POST as finalizePOST } from "@/app/api/v1/uploads/finalize/route";

/**
 * NATIVE API UPLOAD FOUNDATION D2 — contract coverage.
 *
 * The route is executed for real. Only `next/headers` and the verified resolver
 * are mocked; the V1 response helpers and the DTO module run as production
 * code.
 *
 * Storage and the database are one recording fake injected through
 * `auth.client`, so every call the route issues is observed. That is what lets
 * these tests prove a rejected credential never reaches Storage and an invalid
 * body never reaches the database — facts about behaviour, not about source
 * text. It is also how the "never delete the object on DB failure" rule is
 * demonstrated: the fake would record a `remove` if one were ever attempted.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// ─── Recording fake Storage + database client ─────────────────────────────────

type RecordedCall = readonly [method: string, ...args: unknown[]];

interface InfoResult {
  data: { id?: unknown; size?: unknown; contentType?: unknown } | null;
  error: { status?: unknown; statusCode?: string; message?: string } | null;
}

interface DbResult {
  data: Record<string, unknown> | null;
  error: { code?: unknown; message?: string } | null;
}

interface FakeOptions {
  /** Storage `info()` outcome, or a thrown error when `infoThrows` is set. */
  info?: InfoResult;
  infoThrows?: boolean;
  /** Successive owner-select outcomes: first the pre-insert read, then any
   *  post-conflict re-read. */
  selects?: DbResult[];
  /** Insert outcome. */
  insert?: DbResult;
}

interface FakeClient {
  storage: { from(bucket: string): { info(objectPath: string): Promise<InfoResult> } };
  from(table: string): unknown;
  calls: RecordedCall[];
}

const OK_INFO: InfoResult = {
  data: { id: "storage-object-id", size: 1024, contentType: "video/mp4" },
  error: null,
};

function makeFakeClient(options: FakeOptions = {}): FakeClient {
  const calls: RecordedCall[] = [];
  const selects = [...(options.selects ?? [{ data: null, error: null }])];

  function nextSelect(): DbResult {
    return selects.shift() ?? { data: null, error: null };
  }

  return {
    storage: {
      from(bucket: string) {
        calls.push(["storage.from", bucket]);
        return {
          async info(objectPath: string) {
            calls.push(["info", objectPath]);
            if (options.infoThrows) throw new Error("transport failure");
            return options.info ?? OK_INFO;
          },
          // Present so an accidental call is recorded rather than crashing the
          // test: absence of these calls is an assertion, not an assumption.
          async remove(paths: unknown) {
            calls.push(["remove", paths]);
            return { data: null, error: null };
          },
          async update(p: unknown) {
            calls.push(["update", p]);
            return { data: null, error: null };
          },
          async upload(p: unknown) {
            calls.push(["upload", p]);
            return { data: null, error: null };
          },
          async list(p: unknown) {
            calls.push(["list", p]);
            return { data: [], error: null };
          },
          async download(p: unknown) {
            calls.push(["download", p]);
            return { data: null, error: null };
          },
          async createSignedUrl(p: unknown) {
            calls.push(["createSignedUrl", p]);
            return { data: null, error: null };
          },
        };
      },
    },
    from(table: string) {
      calls.push(["from", table]);
      const builder = {
        select(columns: string) {
          calls.push(["select", columns]);
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push(["eq", column, value]);
          return builder;
        },
        async maybeSingle() {
          const result = nextSelect();
          calls.push(["maybeSingle"]);
          return result;
        },
        async insert(row: Record<string, unknown>) {
          calls.push(["insert", row]);
          return options.insert ?? { data: null, error: null };
        },
        async update(row: Record<string, unknown>) {
          calls.push(["db.update", row]);
          return { data: null, error: null };
        },
        async upsert(row: Record<string, unknown>) {
          calls.push(["upsert", row]);
          return { data: null, error: null };
        },
        async delete() {
          calls.push(["db.delete"]);
          return { data: null, error: null };
        },
      };
      return builder;
    },
    calls,
  };
}

// ─── Mocked module boundary ───────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: null as unknown,
  incomingRequestId: null as string | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name.toLowerCase() === "x-request-id" ? state.incomingRequestId : null,
  }),
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveRouteAuth: async () => state.auth,
}));

const CALLER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const UPLOAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OBJECT_PATH = `${CALLER_ID}/${UPLOAD_ID}/source.mp4`;

function setAuthenticated(client: FakeClient): void {
  state.auth = {
    status: "authenticated",
    userId: CALLER_ID,
    email: "golfer@example.com",
    accessToken: "not-a-real-token",
    client,
    source: "bearer",
  } as unknown as VerifiedAuth;
}

function setUnauthenticated(status: "absent" | "invalid" | "verification_unavailable"): void {
  state.auth = { status } as VerifiedAuth;
}

function post(body: unknown, options?: { raw?: string }): Request {
  return new Request("https://www.swingpro-ai.com/api/v1/uploads/finalize", {
    method: "POST",
    body: options?.raw !== undefined ? options.raw : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uploadId: UPLOAD_ID, mimeType: "video/mp4", ...overrides };
}

function canonicalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UPLOAD_ID,
    user_id: CALLER_ID,
    storage_path: OBJECT_PATH,
    video_url: OBJECT_PATH,
    file_size: 1024,
    mime_type: "video/mp4",
    status: "uploaded",
    created_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

async function bodyOf(response: Response): Promise<Record<string, never>> {
  return (await response.json()) as Record<string, never>;
}

function storageCalls(client: FakeClient): RecordedCall[] {
  return client.calls.filter(([m]) => m === "storage.from" || m === "info");
}

function dbCalls(client: FakeClient): RecordedCall[] {
  return client.calls.filter(([m]) => m === "from" || m === "insert" || m === "maybeSingle");
}

function insertCalls(client: FakeClient): RecordedCall[] {
  return client.calls.filter(([m]) => m === "insert");
}

function mutationCalls(client: FakeClient): RecordedCall[] {
  return client.calls.filter(([m]) =>
    ["remove", "update", "upload", "list", "download", "createSignedUrl", "db.update", "upsert", "db.delete"].includes(
      m,
    ),
  );
}

beforeEach(() => {
  state.auth = null;
  state.incomingRequestId = null;
});

// ─── A. Authentication precedes everything ────────────────────────────────────

describe("D2 finalize — authentication", () => {
  it("1. absent credential is AUTH_REQUIRED", async () => {
    setUnauthenticated("absent");
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(401);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
    });
  });

  it("2. invalid credential is AUTH_INVALID", async () => {
    setUnauthenticated("invalid");
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(401);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: { code: "AUTH_INVALID", message: "The supplied credential is not valid." },
    });
  });

  it("3. verification unavailable is 503, never 401", async () => {
    setUnauthenticated("verification_unavailable");
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "SERVER_TEMPORARILY_UNAVAILABLE" } });
  });

  it("4. a malformed body with no credential still answers AUTH_REQUIRED", async () => {
    setUnauthenticated("absent");
    const response = await finalizePOST(post(null, { raw: "not-json-at-all" }));
    expect(response.status).toBe(401);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("5. an unauthenticated request reaches neither Storage nor the database", async () => {
    const client = makeFakeClient();
    state.auth = { status: "absent", client } as unknown as VerifiedAuth;
    await finalizePOST(post(validBody()));
    expect(storageCalls(client)).toHaveLength(0);
    expect(dbCalls(client)).toHaveLength(0);
  });

  it("6. the authenticated path uses the caller-scoped client", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    expect(client.calls.some(([m, b]) => m === "storage.from" && b === UPLOAD_BUCKET)).toBe(true);
    expect(client.calls.some(([m, t]) => m === "from" && t === "swing_videos")).toBe(true);
  });
});

// ─── B. Request validation ────────────────────────────────────────────────────

describe("D2 finalize — request validation", () => {
  const rejected: ReadonlyArray<readonly [string, unknown, { raw?: string } | undefined]> = [
    ["malformed JSON", null, { raw: "{" }],
    ["empty body", null, { raw: "" }],
    ["null body", null, { raw: "null" }],
    ["array body", null, { raw: "[]" }],
    ["string primitive", null, { raw: '"uploadId"' }],
    ["number primitive", null, { raw: "7" }],
    ["missing uploadId", { mimeType: "video/mp4" }, undefined],
    ["missing mimeType", { uploadId: UPLOAD_ID }, undefined],
    ["non-v4 UUID", validBody({ uploadId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee" }), undefined],
    ["bad RFC variant", validBody({ uploadId: "aaaaaaaa-bbbb-4ccc-2ddd-eeeeeeeeeeee" }), undefined],
    ["not a UUID at all", validBody({ uploadId: "not-a-uuid" }), undefined],
    ["uploadId not a string", validBody({ uploadId: 123 }), undefined],
    ["unsupported MIME", validBody({ mimeType: "video/x-matroska" }), undefined],
    ["case-mutated MIME", validBody({ mimeType: "VIDEO/MP4" }), undefined],
    ["MIME with charset", validBody({ mimeType: "video/mp4;charset=utf-8" }), undefined],
    ["mimeType not a string", validBody({ mimeType: 4 }), undefined],
  ];

  it.each(rejected)("7-22. rejects %s", async (_name, body, options) => {
    const client = makeFakeClient();
    setAuthenticated(client);
    const response = await finalizePOST(post(body, options));
    expect(response.status).toBe(400);
    const parsed = await bodyOf(response);
    expect(parsed).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "The request is not valid." },
    });
    expect(storageCalls(client)).toHaveLength(0);
    expect(dbCalls(client)).toHaveLength(0);
  });

  const forbiddenKeys = [
    "fileSize",
    "storagePath",
    "objectPath",
    "bucket",
    "userId",
    "filename",
    "originalFilename",
    "title",
    "club",
    "clubId",
    "trimStart",
    "trimEnd",
    "tier",
    "role",
    "analysisMode",
    "analysisFamily",
    "priority",
    "equipmentSnapshot",
    "signature",
    "endpoint",
  ] as const;

  it.each(forbiddenKeys)("23-42. rejects the forbidden key %s", async (key) => {
    const client = makeFakeClient();
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody({ [key]: "anything" })));
    expect(response.status).toBe(400);
    expect(storageCalls(client)).toHaveLength(0);
    expect(dbCalls(client)).toHaveLength(0);
  });

  it("43. an unknown key nobody enumerated is still rejected", async () => {
    const client = makeFakeClient();
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody({ somethingNobodyThoughtOf: true })));
    expect(response.status).toBe(400);
    expect(dbCalls(client)).toHaveLength(0);
  });
});

// ─── C. Canonical path derivation ─────────────────────────────────────────────

describe("D2 finalize — path derivation", () => {
  it.each([
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["video/webm", "webm"],
  ])("44-46. %s verifies source.%s under the verified caller's folder", async (mime, ext) => {
    const client = makeFakeClient({
      info: { data: { id: "obj", size: 2048, contentType: mime }, error: null },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody({ mimeType: mime })));
    expect(response.status).toBe(200);
    expect(client.calls).toEqual(
      expect.arrayContaining([["info", `${CALLER_ID}/${UPLOAD_ID}/source.${ext}`]]),
    );
  });

  it("47. the bucket is always the canonical upload bucket", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const buckets = client.calls.filter(([m]) => m === "storage.from").map(([, b]) => b);
    expect(buckets).toEqual([UPLOAD_BUCKET]);
  });

  it("48. the first path segment is the verified user, never body input", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const infoCall = client.calls.find(([m]) => m === "info");
    const observed = infoCall?.[1] as string;
    expect(observed.split("/")[0]).toBe(CALLER_ID);
    expect(observed.split("/")).toHaveLength(3);
    expect(observed).not.toContain("..");
  });

  it("49. exactly one Storage info call occurs on the success path", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    expect(client.calls.filter(([m]) => m === "info")).toHaveLength(1);
  });

  it("50. no listing, download or Storage mutation is ever attempted", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    expect(mutationCalls(client)).toHaveLength(0);
  });
});

// ─── D. Authoritative Storage metadata ────────────────────────────────────────

describe("D2 finalize — stored metadata is authoritative", () => {
  it.each(SUPPORTED_UPLOAD_MIME_TYPES)("51-53. accepts a valid %s object", async (mime) => {
    const client = makeFakeClient({
      info: { data: { id: "obj", size: 5, contentType: mime }, error: null },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody({ mimeType: mime })));
    expect(response.status).toBe(200);
  });

  const invalidMetadata: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["missing size", { id: "obj", contentType: "video/mp4" }],
    ["zero size", { id: "obj", size: 0, contentType: "video/mp4" }],
    ["negative size", { id: "obj", size: -1, contentType: "video/mp4" }],
    ["fractional size", { id: "obj", size: 12.5, contentType: "video/mp4" }],
    ["unsafe integer size", { id: "obj", size: Number.MAX_SAFE_INTEGER + 2, contentType: "video/mp4" }],
    ["over-limit size", { id: "obj", size: MAX_UPLOAD_BYTES + 1, contentType: "video/mp4" }],
    ["string size", { id: "obj", size: "1024", contentType: "video/mp4" }],
    ["missing contentType", { id: "obj", size: 1024 }],
    ["unsupported contentType", { id: "obj", size: 1024, contentType: "video/x-matroska" }],
    ["case-mutated contentType", { id: "obj", size: 1024, contentType: "VIDEO/MP4" }],
    ["contentType with charset", { id: "obj", size: 1024, contentType: "video/mp4;charset=utf-8" }],
  ];

  it.each(invalidMetadata)("54-64. rejects %s", async (_name, data) => {
    const client = makeFakeClient({ info: { data, error: null }, insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: { code: "UPLOAD_METADATA_INVALID", message: "The uploaded file is not valid." },
    });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it("65. a stored type that disagrees with the request is refused", async () => {
    const client = makeFakeClient({
      info: { data: { id: "obj", size: 1024, contentType: "video/webm" }, error: null },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody({ mimeType: "video/mp4" })));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "UPLOAD_METADATA_INVALID" } });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it("66. a size at exactly the ceiling is accepted", async () => {
    const client = makeFakeClient({
      info: { data: { id: "obj", size: MAX_UPLOAD_BYTES, contentType: "video/mp4" }, error: null },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(200);
  });

  it("67. a 404 from Storage is not-found-or-not-ready, and writes nothing", async () => {
    const client = makeFakeClient({
      info: { data: null, error: { status: 404, statusCode: "404" } },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: {
        code: "UPLOAD_NOT_FOUND_OR_NOT_READY",
        message: "The upload could not be found or is not ready.",
      },
    });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it.each([400, 401, 403, 500, 503])(
    "68-72. a %s from Storage is an outage, never a missing object",
    async (status) => {
      const client = makeFakeClient({
        info: { data: null, error: { status } },
        insert: { data: null, error: null },
      });
      setAuthenticated(client);
      const response = await finalizePOST(post(validBody()));
      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body).toMatchObject({
        error: {
          code: "SERVER_TEMPORARILY_UNAVAILABLE",
          message: "Finalization is temporarily unavailable. Please retry.",
        },
      });
      expect(insertCalls(client)).toHaveLength(0);
    },
  );

  it("73. a Storage transport throw is an outage", async () => {
    const client = makeFakeClient({ infoThrows: true });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "SERVER_TEMPORARILY_UNAVAILABLE" } });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it("74. a success envelope with no object fails closed", async () => {
    const client = makeFakeClient({ info: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY" } });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it("75. an object lacking its own identity fails closed", async () => {
    const client = makeFakeClient({
      info: { data: { size: 1024, contentType: "video/mp4" }, error: null },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "UPLOAD_NOT_FOUND_OR_NOT_READY" } });
    expect(insertCalls(client)).toHaveLength(0);
  });
});

// ─── E. Existing row: idempotency and conflict ────────────────────────────────

describe("D2 finalize — existing row", () => {
  it("76. a canonical existing row is idempotent success with no insert", async () => {
    const client = makeFakeClient({ selects: [{ data: canonicalRow(), error: null }] });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      data: {
        swingVideoId: UPLOAD_ID,
        uploadId: UPLOAD_ID,
        status: "uploaded",
        objectPath: OBJECT_PATH,
        fileSize: 1024,
        contentType: "video/mp4",
        created: false,
      },
    });
    expect(insertCalls(client)).toHaveLength(0);
  });

  const mismatches: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["user_id", { user_id: OTHER_ID }],
    ["storage_path", { storage_path: `${CALLER_ID}/other/source.mp4` }],
    ["video_url", { video_url: "https://example.com/signed" }],
    ["file_size", { file_size: 999 }],
    ["mime_type", { mime_type: "video/webm" }],
    ["status", { status: "pending" }],
    ["id", { id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }],
  ];

  it.each(mismatches)("77-83. a row mismatched on %s is a conflict", async (_field, overrides) => {
    const client = makeFakeClient({ selects: [{ data: canonicalRow(overrides), error: null }] });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: {
        code: "UPLOAD_CONFLICT",
        message: "This upload has already been finalized differently.",
      },
    });
    expect(insertCalls(client)).toHaveLength(0);
    expect(mutationCalls(client)).toHaveLength(0);
  });

  it("84. a mismatched row is never repaired or overwritten", async () => {
    const client = makeFakeClient({ selects: [{ data: canonicalRow({ file_size: 1 }), error: null }] });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    expect(client.calls.some(([m]) => m === "db.update" || m === "upsert" || m === "db.delete")).toBe(
      false,
    );
  });

  it("85. the owner lookup is scoped by both id and user", async () => {
    const client = makeFakeClient({ selects: [{ data: canonicalRow(), error: null }] });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const eqs = client.calls.filter(([m]) => m === "eq").map(([, c, v]) => [c, v]);
    expect(eqs).toEqual(
      expect.arrayContaining([
        ["id", UPLOAD_ID],
        ["user_id", CALLER_ID],
      ]),
    );
  });
});

// ─── F. First finalization ────────────────────────────────────────────────────

describe("D2 finalize — new registration", () => {
  it("86. inserts exactly the seven canonical columns", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(200);

    const insert = insertCalls(client);
    expect(insert).toHaveLength(1);
    const row = insert[0][1] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["file_size", "id", "mime_type", "status", "storage_path", "user_id", "video_url"].sort(),
    );
    expect(row).toEqual({
      id: UPLOAD_ID,
      user_id: CALLER_ID,
      storage_path: OBJECT_PATH,
      video_url: OBJECT_PATH,
      file_size: 1024,
      mime_type: "video/mp4",
      status: "uploaded",
    });
  });

  it("87. reports created=true on first finalization", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const body = await bodyOf(response);
    expect(body).toMatchObject({ data: { created: true } });
  });

  it("88. writes the authoritative Storage size, not a caller's number", async () => {
    const client = makeFakeClient({
      info: { data: { id: "obj", size: 7777, contentType: "video/mp4" }, error: null },
      insert: { data: null, error: null },
    });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const row = insertCalls(client)[0][1] as Record<string, unknown>;
    expect(row.file_size).toBe(7777);
  });

  it("89. persists the object path, never a signed URL", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const row = insertCalls(client)[0][1] as Record<string, unknown>;
    expect(row.storage_path).toBe(OBJECT_PATH);
    expect(row.video_url).toBe(OBJECT_PATH);
    expect(String(row.video_url)).not.toContain("token");
    expect(String(row.video_url)).not.toContain("http");
  });

  it("90. touches only swing_videos", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    const tables = client.calls.filter(([m]) => m === "from").map(([, t]) => t);
    expect(new Set(tables)).toEqual(new Set(["swing_videos"]));
    expect(tables).not.toContain("swing_analysis");
    expect(tables).not.toContain("users");
  });
});

// ─── G. Concurrency and cross-user privacy ────────────────────────────────────

describe("D2 finalize — concurrency", () => {
  it("91. a lost race whose winner wrote the canonical row is idempotent success", async () => {
    const client = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: canonicalRow(), error: null },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ data: { created: false } });
    expect(insertCalls(client)).toHaveLength(1);
  });

  it("92. a conflict with no visible own row is UPLOAD_CONFLICT", async () => {
    const client = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: null, error: null },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "UPLOAD_CONFLICT" } });
  });

  it("93. a conflict whose own row mismatches is UPLOAD_CONFLICT", async () => {
    const client = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: canonicalRow({ file_size: 5 }), error: null },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "UPLOAD_CONFLICT" } });
  });

  it("94. a cross-user collision is indistinguishable from any other conflict", async () => {
    const foreign = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: null, error: null },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(foreign);
    const foreignResponse = await finalizePOST(post(validBody()));
    const foreignBody = await bodyOf(foreignResponse);

    const mismatched = makeFakeClient({
      selects: [{ data: canonicalRow({ mime_type: "video/webm" }), error: null }],
    });
    setAuthenticated(mismatched);
    const ownResponse = await finalizePOST(post(validBody()));
    const ownBody = await bodyOf(ownResponse);

    expect(foreignResponse.status).toBe(ownResponse.status);
    expect((foreignBody as { error: { code: string; message: string } }).error.code).toBe(
      (ownBody as { error: { code: string; message: string } }).error.code,
    );
    expect((foreignBody as { error: { message: string } }).error.message).toBe(
      (ownBody as { error: { message: string } }).error.message,
    );
  });

  it("95. a conflict never triggers a second insert or a retry loop", async () => {
    const client = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: null, error: null },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(client);
    await finalizePOST(post(validBody()));
    expect(insertCalls(client)).toHaveLength(1);
    expect(client.calls.filter(([m]) => m === "info")).toHaveLength(1);
  });
});

// ─── H. Database failure, headers, and the retry anchor ───────────────────────

describe("D2 finalize — failure handling", () => {
  it("96. an owner-select failure is a retryable outage", async () => {
    const client = makeFakeClient({ selects: [{ data: null, error: { code: "57014" } }] });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      error: {
        code: "SERVER_TEMPORARILY_UNAVAILABLE",
        message: "Finalization is temporarily unavailable. Please retry.",
      },
    });
    expect(insertCalls(client)).toHaveLength(0);
  });

  it("97. a non-23505 insert failure is a retryable outage", async () => {
    const client = makeFakeClient({ insert: { data: null, error: { code: "42501" } } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "SERVER_TEMPORARILY_UNAVAILABLE" } });
  });

  it("98. a post-conflict re-select failure is a retryable outage", async () => {
    const client = makeFakeClient({
      selects: [
        { data: null, error: null },
        { data: null, error: { code: "57014" } },
      ],
      insert: { data: null, error: { code: "23505" } },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ error: { code: "SERVER_TEMPORARILY_UNAVAILABLE" } });
  });

  it("99. no database failure ever deletes the uploaded object", async () => {
    for (const insert of [{ code: "42501" }, { code: "23505" }, { code: "57014" }]) {
      const client = makeFakeClient({
        selects: [
          { data: null, error: null },
          { data: null, error: null },
        ],
        insert: { data: null, error: insert },
      });
      setAuthenticated(client);
      await finalizePOST(post(validBody()));
      expect(client.calls.filter(([m]) => m === "remove")).toHaveLength(0);
      expect(mutationCalls(client)).toHaveLength(0);
    }
  });

  it("100. no provider text reaches the client", async () => {
    const client = makeFakeClient({
      info: { data: null, error: { status: 500, message: "bucket swing-videos row 42 internal" } },
    });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const raw = JSON.stringify(await bodyOf(response));
    expect(raw).not.toContain("bucket");
    expect(raw).not.toContain("row 42");
    expect(raw).not.toContain("internal");
    expect(raw).toContain("Finalization is temporarily unavailable. Please retry.");
  });

  it("101. every answer is private, uncacheable JSON", async () => {
    const cases: Array<() => FakeClient> = [
      () => makeFakeClient({ insert: { data: null, error: null } }),
      () => makeFakeClient({ info: { data: null, error: { status: 404 } } }),
      () => makeFakeClient({ selects: [{ data: canonicalRow({ status: "pending" }), error: null }] }),
    ];
    for (const build of cases) {
      const client = build();
      setAuthenticated(client);
      const response = await finalizePOST(post(validBody()));
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Request-Id")).toBeTruthy();
    }
  });

  it("102. a valid caller request id is echoed", async () => {
    state.incomingRequestId = "d2-finalize-request-001";
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    expect(response.headers.get("X-Request-Id")).toBe("d2-finalize-request-001");
  });

  it("103. an invalid caller request id is replaced by a server UUID", async () => {
    state.incomingRequestId = "bad";
    const client = makeFakeClient({ info: { data: null, error: { status: 404 } } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const header = response.headers.get("X-Request-Id") ?? "";
    expect(header).not.toBe("bad");
    expect(header).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("104. the error body request id equals the header", async () => {
    state.incomingRequestId = "d2-finalize-request-002";
    const client = makeFakeClient({ info: { data: null, error: { status: 404 } } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const body = (await bodyOf(response)) as unknown as { error: { requestId: string } };
    expect(body.error.requestId).toBe(response.headers.get("X-Request-Id"));
  });

  it("105. the success envelope exposes only the frozen fields", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const body = (await bodyOf(response)) as unknown as { data: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["data"]);
    expect(Object.keys(body.data).sort()).toEqual(
      [
        "contentType",
        "created",
        "fileSize",
        "objectPath",
        "status",
        "swingVideoId",
        "uploadId",
      ].sort(),
    );
  });

  it("106. no success answer leaks a secret or an entitlement", async () => {
    const client = makeFakeClient({ insert: { data: null, error: null } });
    setAuthenticated(client);
    const response = await finalizePOST(post(validBody()));
    const raw = JSON.stringify(await bodyOf(response));
    for (const forbidden of [
      "signature",
      "token",
      "signedUrl",
      "tier",
      "subscription",
      "analysis_mode",
      "priority",
      "owner",
      "email",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

// ─── I. Pure DTO behaviour ────────────────────────────────────────────────────

describe("D2 DTO helpers", () => {
  it("107. the parser accepts exactly two keys", async () => {
    expect(parseUploadFinalizeRequest({ uploadId: UPLOAD_ID, mimeType: "video/mp4" })).toEqual({
      uploadId: UPLOAD_ID,
      mimeType: "video/mp4",
    });
    expect(
      parseUploadFinalizeRequest({ uploadId: UPLOAD_ID, mimeType: "video/mp4", extra: 1 }),
    ).toBeNull();
  });

  it("108. metadata validation refuses every dishonest shape", () => {
    expect(validateStoredUploadMetadata({ size: 10, contentType: "video/mp4" }, "video/mp4")).toEqual(
      { size: 10, contentType: "video/mp4" },
    );
    expect(validateStoredUploadMetadata({ contentType: "video/mp4" }, "video/mp4")).toBeNull();
    expect(validateStoredUploadMetadata({ size: 0, contentType: "video/mp4" }, "video/mp4")).toBeNull();
    expect(
      validateStoredUploadMetadata({ size: 10, contentType: "video/webm" }, "video/mp4"),
    ).toBeNull();
    expect(
      validateStoredUploadMetadata({ size: MAX_UPLOAD_BYTES + 1, contentType: "video/mp4" }, "video/mp4"),
    ).toBeNull();
  });

  it("109. the canonical row check requires every field", () => {
    const expected = {
      uploadId: UPLOAD_ID,
      userId: CALLER_ID,
      objectPath: OBJECT_PATH,
      fileSize: 1024,
      contentType: "video/mp4" as const,
    };
    expect(isCanonicalFinalizedRow(canonicalRow(), expected)).toBe(true);
    for (const override of [
      { id: "x" },
      { user_id: OTHER_ID },
      { storage_path: "x" },
      { video_url: "x" },
      { file_size: 1 },
      { mime_type: "video/webm" },
      { status: "pending" },
    ]) {
      expect(isCanonicalFinalizedRow(canonicalRow(override), expected)).toBe(false);
    }
  });

  it("110. the DTO reports the upload id under both names", () => {
    const dto = buildUploadFinalizeDto({
      uploadId: UPLOAD_ID,
      objectPath: OBJECT_PATH,
      fileSize: 1024,
      contentType: "video/mp4",
      created: true,
    });
    expect(dto.swingVideoId).toBe(UPLOAD_ID);
    expect(dto.uploadId).toBe(UPLOAD_ID);
    expect(dto.status).toBe("uploaded");
  });

  it("111. the canonical path builder is shared with D1", () => {
    expect(buildUploadObjectPath(CALLER_ID, UPLOAD_ID, "video/mp4")).toBe(OBJECT_PATH);
  });
});

// ─── J. Permanent security invariants ─────────────────────────────────────────

describe("D2 route security invariants", () => {
  const ROUTE = "app/api/v1/uploads/finalize/route.ts";
  const routeSource = readSource(ROUTE);

  it("112. never reaches for an elevated credential", () => {
    for (const forbidden of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "service_role",
      "createAdminClient",
      "supabase/admin",
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("113. performs no entitlement or analysis work", () => {
    for (const forbidden of [
      "getAnalysisModeForTier",
      "getPriorityForTier",
      "subscription_tier",
      "Gemini",
      "trigger.dev",
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("114. contains no Storage mutation or cleanup call", () => {
    for (const forbidden of [".remove(", ".move(", ".copy(", ".upload(", "uploadToSignedUrl"]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("115. writes no row outside swing_videos and never updates one", () => {
    expect(routeSource).not.toContain(".upsert(");
    expect((routeSource.match(/\.from\("swing_videos"\)/g) ?? []).length).toBeGreaterThan(0);
    expect(routeSource).not.toContain('.from("swing_analysis")');
  });

  it("116. does not mint or persist a download URL", () => {
    expect(routeSource).not.toContain("createSignedUrl");
    expect(routeSource).not.toContain("getPublicUrl");
  });
});
