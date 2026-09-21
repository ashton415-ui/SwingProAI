import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_MIME_TYPES,
  UPLOAD_BUCKET,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_EXPIRES_IN_SECONDS,
  buildResumableEndpoint,
  buildUploadObjectPath,
  isUuidV4,
  isValidDeclaredSize,
  parseUploadAuthorizeRequest,
} from "@/lib/api/v1-upload-dto";
import type { VerifiedAuth } from "@/utils/supabase/server";
import { POST as authorizePOST } from "@/app/api/v1/uploads/authorize/route";

/**
 * NATIVE API UPLOAD FOUNDATION D1 — contract coverage.
 *
 * The route is executed for real. Only `next/headers` and the verified
 * resolver are mocked; the V1 response helpers, the DTO module and the
 * endpoint derivation all run as production code.
 *
 * The Supabase Storage client is a recording fake injected through
 * `auth.client`, so the bucket, object path and `{ upsert: false }` option are
 * observed as the route actually issues them. That is what lets these tests
 * prove a rejected credential never reaches Storage, rather than asserting it
 * about source text.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// ─── Recording fake Storage client ────────────────────────────────────────────

type RecordedCall = readonly [method: string, ...args: unknown[]];

interface SignedUploadResult {
  data: { signedUrl: string; token: string; path: string } | null;
  error: { message: string; statusCode?: string } | null;
}

interface FakeStorageClient {
  storage: {
    from(bucket: string): {
      createSignedUploadUrl(
        objectPath: string,
        options?: { upsert: boolean },
      ): Promise<SignedUploadResult>;
    };
  };
  calls: RecordedCall[];
}

function makeFakeClient(result: SignedUploadResult): FakeStorageClient {
  const calls: RecordedCall[] = [];
  return {
    storage: {
      from(bucket: string) {
        calls.push(["from", bucket]);
        return {
          async createSignedUploadUrl(objectPath: string, options?: { upsert: boolean }) {
            calls.push(["createSignedUploadUrl", objectPath, options]);
            return result;
          },
        };
      },
    },
    calls,
  };
}

const OK_SIGNED: SignedUploadResult = {
  data: {
    signedUrl: "https://example.supabase.co/storage/v1/object/upload/sign/swing-videos/x?token=T",
    token: "signed-upload-token-value",
    path: "ignored",
  },
  error: null,
};

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
const UPLOAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TEST_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
const EXPECTED_ENDPOINT =
  "https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable";

const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

function setAuthenticated(client: FakeStorageClient): void {
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
  return new Request("https://www.swingpro-ai.com/api/v1/uploads/authorize", {
    method: "POST",
    body: options?.raw !== undefined ? options.raw : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uploadId: UPLOAD_ID, mimeType: "video/mp4", fileSize: 1024, ...overrides };
}

async function bodyOf(response: Response): Promise<unknown> {
  return await response.json();
}

beforeEach(() => {
  state.auth = null;
  state.incomingRequestId = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_SUPABASE_URL;
});

afterAll(() => {
  if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
});

// ─── A. Auth ──────────────────────────────────────────────────────────────────

describe("D1 authorize — authentication", () => {
  it("1. absent auth → 401 AUTH_REQUIRED", async () => {
    setUnauthenticated("absent");
    const response = await authorizePOST(post(validBody()));
    expect(response.status).toBe(401);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
  });

  it("2. invalid Bearer → 401 AUTH_INVALID", async () => {
    setUnauthenticated("invalid");
    const response = await authorizePOST(post(validBody()));
    expect(response.status).toBe(401);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe("AUTH_INVALID");
  });

  it("3. verification unavailable → 503", async () => {
    setUnauthenticated("verification_unavailable");
    const response = await authorizePOST(post(validBody()));
    expect(response.status).toBe(503);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe(
      "SERVER_TEMPORARILY_UNAVAILABLE",
    );
  });

  it("4. a rejected credential never reaches Storage", async () => {
    const client = makeFakeClient(OK_SIGNED);
    state.auth = { status: "invalid", client } as unknown as VerifiedAuth;
    const response = await authorizePOST(post(validBody()));
    expect(response.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it("4b. auth is resolved before the body — an unauthenticated caller learns nothing about validation", async () => {
    const client = makeFakeClient(OK_SIGNED);
    state.auth = { status: "absent", client } as unknown as VerifiedAuth;
    // Body is malformed AND unauthenticated: the auth answer must win.
    const response = await authorizePOST(post(undefined, { raw: "{ not json" }));
    expect(response.status).toBe(401);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
    expect(client.calls).toHaveLength(0);
  });

  it("5. the authenticated path signs through the caller-scoped client", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    await authorizePOST(post(validBody()));
    expect(client.calls[0]).toEqual(["from", "swing-videos"]);
  });

  it("7. no caller-supplied identity can select the owner folder", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    // `userId` is an unknown key: the request is refused outright.
    const response = await authorizePOST(post(validBody({ userId: "99999999-9999-4999-8999-999999999999" })));
    expect(response.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });
});

// ─── B. Validation ────────────────────────────────────────────────────────────

describe("D1 authorize — request validation", () => {
  async function expectValidationError(body: unknown, raw?: string): Promise<void> {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    const response = await authorizePOST(post(body, raw === undefined ? undefined : { raw }));
    expect(response.status).toBe(400);
    const parsed = (await bodyOf(response)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    expect(parsed.error.message).toBe("The request is not valid.");
    // A refused request must never reach Storage.
    expect(client.calls).toHaveLength(0);
  }

  it("malformed JSON", async () => { await expectValidationError(undefined, "{ not json"); });
  it("null body", async () => { await expectValidationError(null); });
  it("array body", async () => { await expectValidationError([validBody()]); });
  it("string body", async () => { await expectValidationError("nope"); });
  it("number body", async () => { await expectValidationError(7); });

  it("missing uploadId", async () => {
    const b = validBody(); delete b.uploadId; await expectValidationError(b);
  });
  it("missing mimeType", async () => {
    const b = validBody(); delete b.mimeType; await expectValidationError(b);
  });
  it("missing fileSize", async () => {
    const b = validBody(); delete b.fileSize; await expectValidationError(b);
  });

  it("unknown extra key is refused, not ignored", async () => {
    for (const key of ["storagePath", "objectPath", "originalFilename", "filename", "clubId", "analysisMode", "analysisFamily", "equipmentSnapshot", "priority", "tier", "title", "trimStart", "trimEnd"]) {
      await expectValidationError(validBody({ [key]: "x" }));
    }
  });

  it("invalid or non-v4 uploadId", async () => {
    for (const bad of [
      "not-a-uuid",
      "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee", // v1
      "aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee", // v3
      "aaaaaaaa-bbbb-4ccc-1ddd-eeeeeeeeeeee", // bad variant nibble
      "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee",     // unhyphenated
      " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ", // untrimmed — must not be repaired
      "",
      123,
      null,
    ]) {
      await expectValidationError(validBody({ uploadId: bad }));
    }
  });

  it("uploadId is accepted case-insensitively", () => {
    expect(isUuidV4(UPLOAD_ID.toUpperCase())).toBe(true);
    expect(isUuidV4(UPLOAD_ID)).toBe(true);
  });

  it("unsupported MIME is refused, never normalised", async () => {
    for (const bad of ["video/x-matroska", "video/avi", "image/png", "application/octet-stream", "video/*", "video/mp4;codecs=avc1", "VIDEO/MP4", "", null, 5]) {
      await expectValidationError(validBody({ mimeType: bad }));
    }
  });

  it("fileSize boundaries and types", async () => {
    for (const bad of [0, -1, -262144000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1024", "", null, MAX_UPLOAD_BYTES + 1, Number.MAX_SAFE_INTEGER + 2]) {
      await expectValidationError(validBody({ fileSize: bad }));
    }
  });

  it("fileSize exactly at the 250 MiB ceiling is accepted", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    const response = await authorizePOST(post(validBody({ fileSize: MAX_UPLOAD_BYTES })));
    expect(response.status).toBe(200);
    expect(MAX_UPLOAD_BYTES).toBe(262144000);
    expect(MAX_UPLOAD_BYTES).toBe(250 * 1024 * 1024);
  });
});

// ─── C. Path derivation ───────────────────────────────────────────────────────

describe("D1 authorize — object path derivation", () => {
  it.each([
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["video/webm", "webm"],
  ])("maps %s to source.%s under the verified caller's folder", async (mime, ext) => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    const response = await authorizePOST(post(validBody({ mimeType: mime })));
    expect(response.status).toBe(200);
    expect(client.calls[1]).toEqual([
      "createSignedUploadUrl",
      `${CALLER_ID}/${UPLOAD_ID}/source.${ext}`,
      { upsert: false },
    ]);
  });

  it("the first path segment is always the verified user id, never body input", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    await authorizePOST(post(validBody()));
    const [, objectPath] = client.calls[1] as [string, string, unknown];
    expect(objectPath.split("/")[0]).toBe(CALLER_ID);
    expect(objectPath.split("/")).toHaveLength(3);
    expect(objectPath).not.toContain("..");
  });

  it("the basename is fixed and carries no caller data", () => {
    for (const mime of SUPPORTED_UPLOAD_MIME_TYPES) {
      const p = buildUploadObjectPath(CALLER_ID, UPLOAD_ID, mime);
      expect(p.split("/")[2].startsWith("source.")).toBe(true);
    }
  });

  it("the same caller + uploadId + MIME always derives the identical path (retry idempotency)", () => {
    const a = buildUploadObjectPath(CALLER_ID, UPLOAD_ID, "video/mp4");
    const b = buildUploadObjectPath(CALLER_ID, UPLOAD_ID, "video/mp4");
    expect(a).toBe(b);
  });
});

// ─── D. Storage call + failure mapping ────────────────────────────────────────

describe("D1 authorize — Storage authorization", () => {
  it("calls exactly one bucket and one signing operation, with upsert false", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    await authorizePOST(post(validBody()));
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toEqual(["from", UPLOAD_BUCKET]);
    expect(client.calls[1][0]).toBe("createSignedUploadUrl");
    expect(client.calls[1][2]).toEqual({ upsert: false });
  });

  it("provider failure → 503 with no provider text leaked", async () => {
    setAuthenticated(
      makeFakeClient({
        data: null,
        error: { message: 'new row violates row-level security policy for bucket "swing-videos"', statusCode: "403" },
      }),
    );
    const response = await authorizePOST(post(validBody()));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await bodyOf(response));
    expect(text).toContain("SERVER_TEMPORARILY_UNAVAILABLE");
    expect(text).toContain("Upload authorization is temporarily unavailable. Please retry.");
    for (const forbidden of ["row-level", "policy", "swing-videos", "403", "violates"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("a missing token is treated as failure, not success", async () => {
    setAuthenticated(makeFakeClient({ data: { signedUrl: "u", token: "", path: "p" }, error: null }));
    expect((await authorizePOST(post(validBody()))).status).toBe(503);
  });

  it("misconfigured project URL fails closed as INTERNAL_ERROR without echoing configuration", async () => {
    for (const bad of ["", "not-a-url", "https://example.com", "https://x.supabase.co"]) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = bad;
      const client = makeFakeClient(OK_SIGNED);
      setAuthenticated(client);
      const response = await authorizePOST(post(validBody()));
      expect(response.status).toBe(500);
      const text = JSON.stringify(await bodyOf(response));
      expect(text).toContain("INTERNAL_ERROR");
      if (bad.length > 0) expect(text).not.toContain(bad);
      expect(client.calls).toHaveLength(0);
    }
  });

  it("derives the direct storage host from the configured project", () => {
    expect(buildResumableEndpoint(TEST_SUPABASE_URL)).toBe(EXPECTED_ENDPOINT);
    expect(buildResumableEndpoint(undefined)).toBeNull();
    expect(buildResumableEndpoint("http://127.0.0.1:54321")).toBeNull();
  });
});

// ─── E. Success DTO ───────────────────────────────────────────────────────────

describe("D1 authorize — success contract", () => {
  it("returns exactly the frozen data keys and values", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    const response = await authorizePOST(post(validBody({ mimeType: "video/quicktime" })));
    expect(response.status).toBe(200);

    const payload = (await bodyOf(response)) as { data: Record<string, unknown> };
    expect(Object.keys(payload)).toEqual(["data"]);
    expect(payload.data).toEqual({
      uploadId: UPLOAD_ID,
      bucket: "swing-videos",
      objectPath: `${CALLER_ID}/${UPLOAD_ID}/source.mov`,
      endpoint: EXPECTED_ENDPOINT,
      signature: "signed-upload-token-value",
      expiresInSeconds: 7200,
      chunkSize: 6291456,
      contentType: "video/quicktime",
      upsert: false,
    });
  });

  it("pins the TUS constants", () => {
    expect(UPLOAD_EXPIRES_IN_SECONDS).toBe(7200);
    expect(UPLOAD_CHUNK_SIZE).toBe(6291456);
    expect(UPLOAD_CHUNK_SIZE).toBe(6 * 1024 * 1024);
  });

  it("never returns the signedUrl, caller token, or any cookie", async () => {
    const client = makeFakeClient(OK_SIGNED);
    setAuthenticated(client);
    const response = await authorizePOST(post(validBody()));
    const text = JSON.stringify(await bodyOf(response));
    for (const forbidden of ["signedUrl", "object/upload/sign", "not-a-real-token", "accessToken", "refresh", "cookie", "golfer@example.com"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});

// ─── F. Request-ID and cache ──────────────────────────────────────────────────

describe("D1 authorize — request-id and cache contract", () => {
  const scenarios: ReadonlyArray<readonly [string, () => void, unknown]> = [
    ["success", () => setAuthenticated(makeFakeClient(OK_SIGNED)), validBody()],
    ["validation error", () => setAuthenticated(makeFakeClient(OK_SIGNED)), { bad: true }],
    ["auth error", () => setUnauthenticated("absent"), validBody()],
    ["provider error", () => setAuthenticated(makeFakeClient({ data: null, error: { message: "x" } })), validBody()],
  ];

  it.each(scenarios)("%s: echoes a valid caller request id", async (_name, arrange, body) => {
    arrange();
    state.incomingRequestId = "NativeUpload_20260920";
    const response = await authorizePOST(post(body));
    expect(response.headers.get("X-Request-Id")).toBe("NativeUpload_20260920");
  });

  it.each(scenarios)("%s: replaces an invalid caller request id", async (_name, arrange, body) => {
    arrange();
    state.incomingRequestId = "bad";
    const response = await authorizePOST(post(body));
    const id = response.headers.get("X-Request-Id");
    expect(id).not.toBe("bad");
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it.each(scenarios)("%s: is private, uncacheable and JSON", async (_name, arrange, body) => {
    arrange();
    const response = await authorizePOST(post(body));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("error bodies carry the same request id as the header", async () => {
    setUnauthenticated("absent");
    state.incomingRequestId = "NativeUpload_20260920";
    const response = await authorizePOST(post(validBody()));
    const parsed = (await bodyOf(response)) as { error: { requestId: string } };
    expect(parsed.error.requestId).toBe(response.headers.get("X-Request-Id"));
  });
});

// ─── G. Pure DTO units ────────────────────────────────────────────────────────

describe("D1 upload DTO units", () => {
  it("rejects every non-integer or out-of-range declared size", () => {
    expect(isValidDeclaredSize(1)).toBe(true);
    expect(isValidDeclaredSize(MAX_UPLOAD_BYTES)).toBe(true);
    for (const bad of [0, -1, 1.5, "1", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, MAX_UPLOAD_BYTES + 1]) {
      expect(isValidDeclaredSize(bad)).toBe(false);
    }
  });

  it("accepts only the three canonical content types", () => {
    expect(SUPPORTED_UPLOAD_MIME_TYPES).toEqual(["video/mp4", "video/quicktime", "video/webm"]);
    expect(parseUploadAuthorizeRequest(validBody())).not.toBeNull();
    expect(parseUploadAuthorizeRequest(validBody({ mimeType: "video/ogg" }))).toBeNull();
  });
});

// ─── H. Source contract ───────────────────────────────────────────────────────

const ROUTE = "app/api/v1/uploads/authorize/route.ts";
const DTO = "lib/api/v1-upload-dto.ts";

describe("D1 source contract", () => {
  it("introduces no service-role or admin client reference", () => {
    for (const source of [readSource(ROUTE), readSource(DTO)]) {
      for (const forbidden of ["SUPABASE_SERVICE_ROLE_KEY", "service_role", "createAdminClient", "supabase/admin"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("handles no bytes: no multipart, no arrayBuffer, no formData", () => {
    const source = readSource(ROUTE);
    for (const forbidden of ["multipart/form-data", "arrayBuffer(", "formData(", ".upload(", "Buffer."]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("writes no application table and starts no analysis", () => {
    for (const source of [readSource(ROUTE), readSource(DTO)]) {
      for (const forbidden of ['from("swing_videos")', 'from("swing_analysis")', ".insert(", ".update(", ".upsert(", ".delete(", "analysis_family", "equipment_snapshot", "analyze-swing"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("reads no entitlement or tier state", () => {
    for (const source of [readSource(ROUTE), readSource(DTO)]) {
      for (const forbidden of ["lib/entitlements", "subscription_tier", "canUse", "SubscriptionTier"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("logs nothing and answers only through the V1 helpers", () => {
    const source = readSource(ROUTE);
    expect(source).not.toContain("console.");
    expect(source).not.toContain("NextResponse");
    expect(source).not.toContain("new Response(");
    expect(source).toContain("resolveRouteAuth");
    expect(source).toContain("v1Success(");
    expect(source).toContain("v1ValidationError(");
    expect(source).toContain("v1Error(");
  });

  it("exposes POST only, and never hard-codes the production project ref", () => {
    const source = readSource(ROUTE);
    expect(source).toContain("export async function POST(");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(source).not.toContain(`export async function ${method}(`);
    }
    for (const source2 of [readSource(ROUTE), readSource(DTO)]) {
      expect(source2).not.toContain("atlmnqispyzhsahahpjy");
    }
  });

  it("does not import or reuse the legacy upload surface", () => {
    for (const source of [readSource(ROUTE), readSource(DTO)]) {
      expect(source).not.toContain("v1/upload/route");
      expect(source).not.toContain("upload/complete");
      expect(source).not.toContain("golf-bag");
    }
  });
});

// ─── I. Frozen dependency integrity ───────────────────────────────────────────

describe("frozen read-only dependencies", () => {
  const FROZEN: Array<[string, string]> = [
    ["utils/supabase/server.ts", "43e341460fa254d92bcd041774c6b085ab99931c9dc4cf631d6959d9c921fe74"],
    ["lib/api/me-dto.ts", "ed8d897ca11e05a7d722c03904d4a7642afeea63d5f8db58bc05b861928fa75f"],
    ["app/api/v1/me/route.ts", "465fafe5eb791148b29f27028db0e3685ca219b5217eef6b46aca0e5033071a2"],
    ["app/api/v1/swing-data/route.ts", "fc6b3a5c6d2834d8c3ac58666e6f00159b29ab4eb0454d8d87e521bcf5daa135"],
    ["lib/entitlements.ts", "a0ad96e69b3774b4562efe5f25526a9920dfa5646640db3f3df979565a3b962f"],
    ["app/(dashboard)/analyze/page.tsx", "7aa5a9b6bd166b4042651a198fc9bea130a2ae8ee5c5459a8739d0c7d70f7fae"],
    ["app/(dashboard)/analyze/SwingUploader.tsx", "745dab9ed8261b0b24d1ba7055f27026d57afdf1663cdcd55cb36a0539b8fdf5"],
    ["app/(dashboard)/analyze/upload-actions.ts", "d8c3d8d912b57b298a327367a31e1896bf830c7759d6d7b2a716afae46e9e341"],
    ["app/api/v1/upload/route.ts", "9a93cd1321312efcabe55562b29a1bb8d9eae2874ce74f874788b22eacfd086d"],
    ["app/api/v1/upload/complete/route.ts", "2687b38784a7fafcb693aca59cc20c6739890bc99503ecc267eae777c0c4cd4f"],
    ["package.json", "d9ed26be27ac949eedd8ef57c854d4204cec1b7b698605a91bef596205b8a705"],
    ["package-lock.json", "3010c0d60e3bf6aca7c40d92f17a2b4a09b773efa2c68ba2b0c7d40370d2f0ea"],
  ];

  it.each(FROZEN)("%s is byte-identical", async (relativePath, expected) => {
    const { createHash } = await import("node:crypto");
    const actual = createHash("sha256")
      .update(readFileSync(path.join(repoRoot, relativePath)))
      .digest("hex");
    expect(actual).toBe(expected);
  });
});
