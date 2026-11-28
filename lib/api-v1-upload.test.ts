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
  buildUploadAuthorizationDto,
  LOCAL_LOOPBACK_UPLOAD_ENDPOINT_ENV,
  TUS_RESUMABLE_VERSION,
  buildTusUploadMetadata,
  localLoopbackUploadEndpointAllowed,
  parseSignedUploadGrant,
  resolveTusUploadUrl,
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
  "https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable/sign";

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
    state.incomingRequestId = "NativeUpload_20260920";
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

  it("targets the signed resumable endpoint that accepts the x-signature token", () => {
    const endpoint = buildResumableEndpoint(TEST_SUPABASE_URL)!;
    expect(endpoint.endsWith("/storage/v1/upload/resumable/sign")).toBe(true);
    expect(endpoint).not.toBe("https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable");
    expect(endpoint.endsWith("/resumable/")).toBe(false);
    expect(endpoint.endsWith("/sign/")).toBe(false);
    expect(new URL(endpoint).origin).toBe("https://abcdefghijklmnop.storage.supabase.co");
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
    // AG-WEB-READY-03-R1 + A1 (reviewed, retargeted): only the cookie path changed — the raw Cookie header with the
    // shared strict layout reader, and the binding cookie. The Bearer ingress is pinned separately below to the bytes of
    // the previously frozen verifier (43e341460fa254d92bcd041774c6b085ab99931c9dc4cf631d6959d9c921fe74).
    // AG-WEB-READY-03-R1-A4 review (reviewed, retargeted): the outage classification reads Auth's own 5xx and a 429 as an
    // outage (verification_unavailable), never as a refused credential; nothing else in the file changed.
    ["utils/supabase/server.ts", "e75f81bf7faefbabfd949283d3ad559c990ddf6ac30b7292400e6210a39897c7"],
    // PI-1A: Practice Intelligence entitlement and effective /me capability.
    // ENT-1C: paid analysis capabilities and mode reported with subscription status.
    ["lib/api/me-dto.ts", "b643a03f289feea8bb7639b840bd52b60c6a4d81020c243e846d37bb70faa48e"],
    ["app/api/v1/me/route.ts", "73d1a8a0195eae4978bd32ac73665c5c2992682f24281bca91c765c5b7cb5415"],
    ["app/api/v1/swing-data/route.ts", "fc6b3a5c6d2834d8c3ac58666e6f00159b29ab4eb0454d8d87e521bcf5daa135"],
    // PI-1A: canUsePracticeIntelligence added.
    // ENT-1C: analysis-result capability helpers added.
    ["lib/entitlements.ts", "65a12b41924b7f7590b22f44639aeb2a8246f7fcdda154c99185f9b281f45865"],
    // Analysis request authority closure: the browser swing_analysis INSERT is
    // replaced by a request to POST /api/v1/analyses.
    // PRICING-1 checkout hold: presentation-only upsell copy correction; the
    // secured POST /api/v1/analyses request authority is unchanged.
    // ENT-1D: a structured 409 for an analysis already running hands over to its report page.
    // ENT-1D video sources: the upload file name is made canonical before the Storage upload.
    // ENT-1D local acceptance: keyboard-reachable file inputs (sr-only) and a 44px upsell link.
    // ENT-1D D1 and golfer experience: video file checks, recovery copy, honest plan/upgrade copy, Enter opens the chooser.
    // S6-R1: an unscored full-swing result shows "Not scored" with its basis, never 0; no grade colour; assessment label.
    // AG-WEB-READY-03-R1-A2: session reads classified (refused, failed, signed out) with fixed copy and retry; the clubs
    // load bounded and re-confirmed; an identity change stops a run before its next step; only fixed messages shown.
    // The upload, Storage, swing_videos and /api/v1/analyses request authority is unchanged.
    // A2 review: a result arriving after the sign-in changed (or after leaving) is not shown; the run's session
    // read is bounded; a session whose End Session is pending is not used; one persistent live region per panel.
    // AG-WEB-READY-03-R1-A3: the page belongs to the account its dashboard layout was rendered for; its data requests
    // carry that account's confirmed token (owner-bound client), the /api/v1/analyses request its confirmed Bearer, and
    // the analysis call is sent through the cookie-session sender; a late error body is acted on only while current.
    // AG-WEB-READY-03-R1-A4 (C1): the analysis call carries the page's account's Bearer, confirmed just before it is sent,
    // with no cookie (the route verifies the Bearer itself); A3's cookie-session sender and its preflight are retired.
    // AG-WEB-READY-10-P2 (reviewed, retargeted): one stable upload id per clip selection, the Storage upload to the V1
    // key and V1 finalize (with the clip's display name and trim), the admission declaration, and 202 -> the report.
    // AG-WEB-READY-10-P2-A1 (retargeted): the first transfer uses the V1 authorize answer and its scoped signed transport
    // (resumable, path-scoped signature), resumed from the server's offset for a repeat; finalize decides a stored key.
    // AG-WEB-READY-10-P3 (retargeted): a resume position counts only when Storage states it explicitly (an absent,
    // empty or malformed Upload-Offset is no position); an unknown position keeps the transfer and sends nothing more.
    // AG-WEB-READY-10-P3-A1 (retargeted): a generic 400/401/403 status answer keeps the transfer (only 404/410 or the
    // signature's known expiry replace it); a 204 status answer is read like a 200.
    // AG-WEB-READY-10-P4 (retargeted): the four application requests go through lib/protected-web-requests.ts: by
    // default the same requests as before (credentials "omit"); on the protected opt-in, the fixed same-origin web
    // endpoints with this origin's cookies and no redirect followed. The owner checks before each send are unchanged.
    ["app/(dashboard)/analyze/page.tsx", "c900ba0a46db967f0b88789912191976d081ca26783efafee9710eb28c9ac550"],
    // AG-WEB-READY-10-P4 (QA): the four requests' definition left the page, so it is pinned here too — the sender, the
    // web endpoints' boundary, the four web endpoints and the build-time opt-in in next.config.mjs.
    ["lib/protected-web-requests.ts", "61a4cf5265eb017745584e404c875c0cbcdf96ee613faca4bf2740b93b1fbd01"],
    ["lib/api/protected-web-boundary.ts", "e009748b7e75590637817fde8320664785dc1e9111644fbb72e57a4e6c507012"],
    ["app/api/web/uploads/authorize/route.ts", "e6d1c75e1d259c46a52ef55bf01ce2c6b09b4991ba0e422d079495430131211c"],
    ["app/api/web/uploads/finalize/route.ts", "1f2c284d60ac084ed09146c1b077d179c4e1e2c23f97563ab3fb9b3eeb086629"],
    ["app/api/web/analyses/route.ts", "67c867129d8bf94633c562065c4c75f0f269e5afe5358b25cbf37685c76aef7d"],
    ["app/api/web/analyze-swing/route.ts", "2529b0712cad9a1e6fd3e89fcfdf37f256b6fc25e266a21e921ef0b4375c6eb5"],
    ["next.config.mjs", "d3b186ccf45b964e98067535bf5021cc2464e1e291e592b658a868607677190b"],
    ["app/(dashboard)/analyze/SwingUploader.tsx", "745dab9ed8261b0b24d1ba7055f27026d57afdf1663cdcd55cb36a0539b8fdf5"],
    // ENT-1D video sources: video_url records the canonical key, never a public URL.
    // ENT-1D video sources: canonical file name before upload (video_url already records the key).
    ["app/(dashboard)/analyze/upload-actions.ts", "17a4c4354354952679e34abef475350999c2a80fed1c563a5b91a5be587c1c88"],
    // ENT-1D video sources: the upload file name is made canonical before the Storage upload.
    ["app/api/v1/upload/route.ts", "b2e1654ff51804fa64a8a68c153ba7ffd6eea7be557df3cb148047faa509c6d9"],
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

  // A1 (AG-WEB-READY-03-R1-A1): the whole-file receipt of utils/supabase/server.ts above was retargeted after review.
  // The native Bearer ingress this suite depends on — the supabase-js import, the project URL and anon key helpers, client
  // construction, outage classification, token verification, Authorization parsing and route ingress (widened after
  // review) — must still be exactly the previously frozen verifier's bytes.
  // A4 review (security finding 1): the outage classification now also reads Auth's own 5xx and a 429 as an outage
  // (verification_unavailable), never as a refused credential; every other byte of the ingress region is unchanged.
  it("the Bearer ingress of utils/supabase/server.ts is byte-identical to the previously frozen verifier (A1)", async () => {
    const text = readFileSync(path.join(repoRoot, "utils/supabase/server.ts"), "utf8").replace(/\r\n/g, "\n");
    const importLine = 'import { createClient as createSupabaseClient } from "@supabase/supabase-js";';
    expect(text.startsWith(`${importLine}\n`)).toBe(true);
    const region = [importLine, ...[
      "function supabaseUrl(",
      "function supabaseAnonKey(",
      "function clientForToken(",
      "function isVerificationInfrastructureFailure(",
      "async function verifyAccessToken(",
      "function parseAuthorizationHeader(",
      "export async function resolveRouteAuth(",
    ].map((signature) => {
      const start = text.indexOf(signature);
      const end = text.indexOf("\n}\n", start);
      expect([start >= 0, end > start, text.indexOf(signature, start + 1)]).toEqual([true, true, -1]);
      return text.slice(start, end + 3);
    })].join("\n");
    expect((await import("node:crypto")).createHash("sha256").update(region).digest("hex")).toBe("2aefc9b2952b1dcc829087be5b6b07696a1b3f4ee19a62711d84d157fadcc3dd");
  });
});


// ─── AG-WEB-READY-10-P2-A1: the local loopback seam and the signed transfer helpers ──────────────────────────────

describe("A1: the local loopback seam leaves production endpoint selection unchanged", () => {
  it("without the opt-in nothing changes: a loopback project URL has no endpoint and a hosted one keeps its own", () => {
    expect(buildResumableEndpoint("http://127.0.0.1:54321")).toBeNull();
    expect(buildResumableEndpoint(TEST_SUPABASE_URL)).toBe(EXPECTED_ENDPOINT);
    expect(buildResumableEndpoint(TEST_SUPABASE_URL, { allowLoopback: false })).toBe(EXPECTED_ENDPOINT);
  });

  it("with the opt-in, only an exact loopback project URL maps to its own loopback endpoint; a hosted URL is unchanged", () => {
    expect(buildResumableEndpoint("http://127.0.0.1:54321", { allowLoopback: true })).toBe("http://127.0.0.1:54321/storage/v1/upload/resumable/sign");
    expect(buildResumableEndpoint("http://127.0.0.1:54321/", { allowLoopback: true })).toBe("http://127.0.0.1:54321/storage/v1/upload/resumable/sign");
    expect(buildResumableEndpoint(TEST_SUPABASE_URL, { allowLoopback: true })).toBe(EXPECTED_ENDPOINT);
    for (const notLoopback of [
      "http://localhost:54321", "https://127.0.0.1:54321", "http://127.0.0.1", "http://127.0.0.2:54321", "http://127.0.0.1:54321/x",
      "http://u:p@127.0.0.1:54321", "http://127.0.0.1:54321?x=1", "http://[::1]:54321", "http://127.0.0.1.nip.io:54321", "https://example.com",
    ]) {
      expect(buildResumableEndpoint(notLoopback, { allowLoopback: true }), notLoopback).toBeNull();
    }
  });

  it("the opt-in is exactly \"1\" in the server's environment", () => {
    expect(LOCAL_LOOPBACK_UPLOAD_ENDPOINT_ENV).toBe("SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT");
    expect(localLoopbackUploadEndpointAllowed({ SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      expect(localLoopbackUploadEndpointAllowed({ SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT: v }), String(v)).toBe(false);
    }
  });

  it("the route: a loopback project answers 500 without the opt-in and its own endpoint with it; authentication, the key and signing are unchanged", async () => {
    const before = process.env.SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      delete process.env.SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT;
      let client = makeFakeClient(OK_SIGNED);
      setAuthenticated(client);
      expect((await authorizePOST(post(validBody()))).status).toBe(500);
      expect(client.calls).toHaveLength(0);
      process.env.SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT = "1";
      client = makeFakeClient(OK_SIGNED);
      setAuthenticated(client);
      const response = await authorizePOST(post(validBody()));
      expect(response.status).toBe(200);
      const data = (await bodyOf(response) as { data: Record<string, unknown> }).data;
      expect(data.endpoint).toBe("http://127.0.0.1:54321/storage/v1/upload/resumable/sign");
      expect(data.objectPath).toBe(`${CALLER_ID}/${UPLOAD_ID}/source.mp4`);
      expect(client.calls).toHaveLength(2); // the caller's own Storage client: from(bucket), then the path-scoped signing
      expect(client.calls[0]).toEqual(["from", "swing-videos"]);
      setUnauthenticated("absent");
      expect((await authorizePOST(post(validBody()))).status).toBe(401);
      process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_SUPABASE_URL;
      setAuthenticated(makeFakeClient(OK_SIGNED));
      const hosted = (await bodyOf(await authorizePOST(post(validBody()))) as { data: Record<string, unknown> }).data;
      expect(hosted.endpoint).toBe(EXPECTED_ENDPOINT); // the opt-in never redirects a hosted project
    } finally {
      if (before === undefined) delete process.env.SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT;
      else process.env.SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT = before;
      process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_SUPABASE_URL;
    }
  });
});

describe("A1: the signed transfer helpers", () => {
  const objectPath = `${CALLER_ID}/${UPLOAD_ID}/source.mp4`;
  const grant = buildUploadAuthorizationDto({ uploadId: UPLOAD_ID, objectPath, endpoint: EXPECTED_ENDPOINT, signature: "sig", contentType: "video/mp4" });
  const expected = { uploadId: UPLOAD_ID, objectPath, contentType: "video/mp4" as const, endpoint: EXPECTED_ENDPOINT };

  it("parseSignedUploadGrant accepts exactly the authorize answer for this request", () => {
    expect(parseSignedUploadGrant(grant, expected)).toEqual(grant);
    expect(parseSignedUploadGrant({ ...grant, endpoint: "http://127.0.0.1:54321/storage/v1/upload/resumable/sign" }, { ...expected, endpoint: "http://127.0.0.1:54321/storage/v1/upload/resumable/sign" })?.endpoint)
      .toBe("http://127.0.0.1:54321/storage/v1/upload/resumable/sign");
    for (const [label, bad] of [
      ["another upload id", { ...grant, uploadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      ["another key", { ...grant, objectPath: `99999999-9999-4999-8999-999999999999/${UPLOAD_ID}/source.mp4` }],
      ["another bucket", { ...grant, bucket: "other" }],
      ["another type", { ...grant, contentType: "video/webm" }],
      ["upsert", { ...grant, upsert: true }],
      ["another chunk size", { ...grant, chunkSize: 1 }],
      ["no signature", { ...grant, signature: "" }],
      ["no lifetime", { ...grant, expiresInSeconds: 0 }],
      ["a remote plain-http endpoint", { ...grant, endpoint: "http://storage.example.com/storage/v1/upload/resumable/sign" }],
      ["another endpoint path", { ...grant, endpoint: "https://abcdefghijklmnop.storage.supabase.co/storage/v1/object" }],
      ["an endpoint with a query", { ...grant, endpoint: `${EXPECTED_ENDPOINT}?x=1` }],
      ["not an object", null],
    ] as const) {
      expect(parseSignedUploadGrant(bad, expected), label).toBeNull();
    }
  });

  it("review: the answer's endpoint must be exactly the one the caller's own project URL implies", () => {
    const own = buildResumableEndpoint(TEST_SUPABASE_URL, { allowLoopback: true });
    expect(parseSignedUploadGrant(grant, { ...expected, endpoint: own })).toEqual(grant);
    const local = "http://127.0.0.1:54321/storage/v1/upload/resumable/sign";
    expect(parseSignedUploadGrant({ ...grant, endpoint: local }, { ...expected, endpoint: own })).toBeNull(); // hosted page, loopback answer
    expect(parseSignedUploadGrant({ ...grant, endpoint: "https://zzzzzzzzzzzzzzzz.storage.supabase.co/storage/v1/upload/resumable/sign" }, { ...expected, endpoint: own })).toBeNull();
    const localOwn = buildResumableEndpoint("http://127.0.0.1:54321", { allowLoopback: true });
    expect(parseSignedUploadGrant({ ...grant, endpoint: local }, { ...expected, endpoint: localOwn })?.endpoint).toBe(local);
    expect(parseSignedUploadGrant({ ...grant, endpoint: "http://127.0.0.1:9999/storage/v1/upload/resumable/sign" }, { ...expected, endpoint: localOwn })).toBeNull();
    expect(parseSignedUploadGrant(grant, { ...expected, endpoint: null })).toBeNull(); // no usable configuration: nothing
  });

  it("buildTusUploadMetadata names the bucket, the key, the type and the cache control (base64, ASCII only)", () => {
    const pairs = Object.fromEntries(buildTusUploadMetadata(grant).split(",").map((x) => {
      const [k, v] = x.split(" ");
      return [k, Buffer.from(v, "base64").toString("utf8")];
    }));
    expect(pairs).toEqual({ bucketName: "swing-videos", objectName: objectPath, contentType: "video/mp4", cacheControl: "3600" });
    expect(() => buildTusUploadMetadata({ ...grant, objectPath: "é" })).toThrow();
    expect(TUS_RESUMABLE_VERSION).toBe("1.0.0");
  });

  it("resolveTusUploadUrl keeps the signature on the authorized endpoint's own origin and path", () => {
    expect(resolveTusUploadUrl(`${EXPECTED_ENDPOINT}/abc`, EXPECTED_ENDPOINT)).toBe(`${EXPECTED_ENDPOINT}/abc`);
    expect(resolveTusUploadUrl("/storage/v1/upload/resumable/sign/abc", EXPECTED_ENDPOINT)).toBe(`${EXPECTED_ENDPOINT}/abc`);
    // review: dot segments resolve before the check, so they can never climb out of the endpoint's path
    for (const climb of [`${EXPECTED_ENDPOINT}/../../object/swing-videos/x`, `${EXPECTED_ENDPOINT}/%2e%2e/%2e%2e/object/x`, `${EXPECTED_ENDPOINT}/abc/../..`]) {
      expect(resolveTusUploadUrl(climb, EXPECTED_ENDPOINT), climb).toBeNull();
    }
    expect(resolveTusUploadUrl(`${EXPECTED_ENDPOINT}/a/../b`, EXPECTED_ENDPOINT)).toBe(`${EXPECTED_ENDPOINT}/b`);
    for (const bad of [null, "", "https://evil.example.com/storage/v1/upload/resumable/sign/abc",
      "https://abcdefghijklmnop.storage.supabase.co/storage/v1/object/abc", `${EXPECTED_ENDPOINT}/`, `${EXPECTED_ENDPOINT}/abc?x=1`,
      "http://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable/sign/abc"]) {
      expect(resolveTusUploadUrl(bad, EXPECTED_ENDPOINT), String(bad)).toBeNull();
    }
  });
});
