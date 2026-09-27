import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANALYSIS_REQUEST_COLUMNS,
  isOwnerStoragePath,
  isSameClub,
  parseAnalysisCreateRequest,
  toAnalysisRequestDto,
  toSubscriptionTier,
} from "@/lib/api/v1-analysis-dto";
import type { VerifiedAuth } from "@/utils/supabase/server";
import { POST as analysesPOST } from "@/app/api/v1/analyses/route";

/**
 * NATIVE ANALYSIS REQUEST AUTHORITY CLOSURE — POST /api/v1/analyses.
 *
 * The route runs for real. Only `next/headers`, the verified resolver and the
 * server-only admin factory are mocked; the V1 response helpers, the DTO module
 * and the entitlement layer run as production code.
 *
 * Two recording fakes are injected: the caller-scoped client (through
 * `auth.client`) and the elevated client (through `createAdminClient`). Every
 * call is recorded on the client that received it, which is what lets these
 * tests prove *who* did each thing — that every read, the Storage check and
 * every authorization decision happened on the caller's own client, and that
 * the elevated client performed exactly one bounded INSERT and nothing else.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// ─── Recording fakes ──────────────────────────────────────────────────────────

type RecordedCall = readonly [method: string, ...args: unknown[]];

interface DbResult {
  data: Record<string, unknown> | null;
  error: { code?: unknown; message?: string } | null;
}

interface ListResult {
  data: Record<string, unknown>[] | null;
  error: { code?: unknown; message?: string } | null;
}

interface InfoResult {
  data: { id?: unknown } | null;
  error: { status?: unknown; statusCode?: unknown; message?: string } | null;
}

interface CallerOptions {
  video?: DbResult;
  info?: InfoResult;
  infoThrows?: boolean;
  club?: DbResult;
  profile?: DbResult;
  existing?: ListResult;
  reread?: DbResult;
}

interface FakeClient {
  storage: { from(bucket: string): unknown };
  from(table: string): unknown;
  calls: RecordedCall[];
}

const CALLER_ID = "11111111-2222-4333-8444-555555555555";
const VIDEO_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLUB_ID = "cccccccc-dddd-4eee-8fff-000000000000";
const OTHER_CLUB_ID = "dddddddd-eeee-4fff-8000-111111111111";
const STORAGE_PATH = `${CALLER_ID}/${VIDEO_ID}/source.mp4`;
const CREATED_AT = "2026-09-26T12:00:00.000Z";

const OK_INFO: InfoResult = { data: { id: "storage-object-id" }, error: null };

function readyVideo(overrides: Record<string, unknown> = {}): DbResult {
  return {
    data: { id: VIDEO_ID, user_id: CALLER_ID, status: "uploaded", storage_path: STORAGE_PATH, ...overrides },
    error: null,
  };
}

function ownedClub(overrides: Record<string, unknown> = {}): DbResult {
  return {
    data: { id: CLUB_ID, user_id: CALLER_ID, club_type: "Driver", is_archived: false, ...overrides },
    error: null,
  };
}

function tier(value: unknown): DbResult {
  return { data: { subscription_tier: value }, error: null };
}

function analysisRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VIDEO_ID,
    swing_video_id: VIDEO_ID,
    user_id: CALLER_ID,
    club_id: null,
    status: "pending",
    analysis_family: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function makeCallerClient(options: CallerOptions = {}): FakeClient {
  const calls: RecordedCall[] = [];
  const maybeSingleByTable: Record<string, DbResult | undefined> = {
    swing_videos: options.video ?? readyVideo(),
    user_equipment: options.club,
    users: options.profile,
    swing_analysis: options.reread,
  };

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
          calls.push(["select", table, columns]);
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push(["eq", table, column, value]);
          return builder;
        },
        async limit(n: number) {
          calls.push(["limit", table, n]);
          return options.existing ?? { data: [], error: null };
        },
        async maybeSingle() {
          calls.push(["maybeSingle", table]);
          return maybeSingleByTable[table] ?? { data: null, error: null };
        },
        // Recorded so an accidental caller-scoped write is an assertion failure,
        // not a crash: the caller's own client must never write.
        insert(row: unknown) {
          calls.push(["caller.insert", table, row]);
          return builder;
        },
        update(row: unknown) {
          calls.push(["caller.update", table, row]);
          return builder;
        },
      };
      return builder;
    },
    calls,
  };
}

interface AdminOptions {
  insertResult?: DbResult;
  throwsOnConstruct?: boolean;
}

interface FakeAdmin {
  client: { from(table: string): unknown; storage: unknown };
  calls: RecordedCall[];
}

function makeAdmin(options: AdminOptions = {}): FakeAdmin {
  const calls: RecordedCall[] = [];
  const client = {
    storage: new Proxy(
      {},
      {
        get(_target, prop) {
          calls.push(["admin.storage", String(prop)]);
          return () => ({});
        },
      },
    ),
    from(table: string) {
      calls.push(["admin.from", table]);
      return {
        insert(row: Record<string, unknown>) {
          calls.push(["admin.insert", table, row]);
          return {
            select(columns: string) {
              calls.push(["admin.select", columns]);
              return {
                async single() {
                  calls.push(["admin.single"]);
                  return (
                    options.insertResult ?? { data: analysisRow({ club_id: row.club_id }), error: null }
                  );
                },
              };
            },
          };
        },
        select(columns: string) {
          calls.push(["admin.read", table, columns]);
          return {};
        },
        update(row: unknown) {
          calls.push(["admin.update", table, row]);
          return {};
        },
      };
    },
  };
  return { client, calls };
}

// ─── Mocked module boundary ───────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  auth: null as unknown,
  admin: null as unknown,
  adminThrows: false,
  adminConstructions: 0,
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

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructions += 1;
    if (state.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return state.admin;
  },
}));

let admin: FakeAdmin;

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
  return new Request("https://www.swingpro-ai.com/api/v1/analyses", {
    method: "POST",
    body: options?.raw !== undefined ? options.raw : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { swingVideoId: VIDEO_ID, clubId: null, ...overrides };
}

async function bodyOf(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function adminInserts(): RecordedCall[] {
  return admin.calls.filter((c) => c[0] === "admin.insert");
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await bodyOf(response);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.requestId).toBe("string");
  expect(Object.keys(body)).toEqual(["error"]);
}

beforeEach(() => {
  admin = makeAdmin();
  state.admin = admin.client;
  state.adminThrows = false;
  state.adminConstructions = 0;
  state.incomingRequestId = null;
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — authentication", () => {
  it("answers 401 AUTH_REQUIRED without a credential and touches nothing", async () => {
    setUnauthenticated("absent");
    await expectError(await analysesPOST(post(validBody())), 401, "AUTH_REQUIRED");
    expect(state.adminConstructions).toBe(0);
  });

  it("answers 401 AUTH_INVALID for a rejected credential", async () => {
    setUnauthenticated("invalid");
    await expectError(await analysesPOST(post(validBody())), 401, "AUTH_INVALID");
  });

  it("answers 503 when verification is unavailable", async () => {
    setUnauthenticated("verification_unavailable");
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("does not read the body before authentication", async () => {
    setUnauthenticated("absent");
    await expectError(await analysesPOST(post(null, { raw: "{not json" })), 401, "AUTH_REQUIRED");
  });
});

// ─── VALIDATION ───────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — exact body", () => {
  const invalidBodies: [string, unknown, string?][] = [
    ["malformed JSON", null, "{not json"],
    ["an array", [validBody()]],
    ["a missing swingVideoId", { clubId: null }],
    ["a missing clubId key", { swingVideoId: VIDEO_ID }],
    ["an invalid swingVideoId", validBody({ swingVideoId: "not-a-uuid" })],
    ["an invalid clubId", validBody({ clubId: "not-a-uuid" })],
    ["a numeric clubId", validBody({ clubId: 7 })],
    ["an unknown key", validBody({ extra: true })],
  ];

  for (const [label, body, raw] of invalidBodies) {
    it(`refuses ${label} with 400 VALIDATION_ERROR before any read`, async () => {
      const client = makeCallerClient();
      setAuthenticated(client);
      await expectError(
        await analysesPOST(post(body, raw !== undefined ? { raw } : undefined)),
        400,
        "VALIDATION_ERROR",
      );
      expect(client.calls).toEqual([]);
      expect(state.adminConstructions).toBe(0);
    });
  }

  for (const forbidden of [
    "userId",
    "status",
    "analysisFamily",
    "analysisMode",
    "score",
    "feedback",
    "metrics",
    "equipmentSnapshot",
    "puttingScore",
    "modelUsed",
    "requestedModel",
    "priority",
  ]) {
    it(`refuses a caller-supplied ${forbidden}`, async () => {
      const client = makeCallerClient();
      setAuthenticated(client);
      await expectError(await analysesPOST(post(validBody({ [forbidden]: "x" }))), 400, "VALIDATION_ERROR");
      expect(client.calls).toEqual([]);
    });
  }
});

// ─── VIDEO ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — video ownership and readiness", () => {
  it("answers 404 SWING_VIDEO_NOT_FOUND for a missing video", async () => {
    setAuthenticated(makeCallerClient({ video: { data: null, error: null } }));
    await expectError(await analysesPOST(post(validBody())), 404, "SWING_VIDEO_NOT_FOUND");
    expect(state.adminConstructions).toBe(0);
  });

  it("makes another golfer's video indistinguishable from a missing one", async () => {
    // RLS hides the row, so the caller-scoped read returns nothing — exactly
    // the missing case. The response must be byte-for-byte the same shape.
    const missing = makeCallerClient({ video: { data: null, error: null } });
    setAuthenticated(missing);
    const a = await bodyOf(await analysesPOST(post(validBody())));
    const hidden = makeCallerClient({ video: { data: null, error: null } });
    setAuthenticated(hidden);
    const b = await bodyOf(await analysesPOST(post(validBody())));
    expect({ ...a.error, requestId: "" }).toEqual({ ...b.error, requestId: "" });
    expect(a.error.code).toBe("SWING_VIDEO_NOT_FOUND");
  });

  it("scopes the video read to the caller explicitly", async () => {
    const client = makeCallerClient({ video: { data: null, error: null } });
    setAuthenticated(client);
    await analysesPOST(post(validBody()));
    expect(client.calls).toContainEqual(["eq", "swing_videos", "id", VIDEO_ID]);
    expect(client.calls).toContainEqual(["eq", "swing_videos", "user_id", CALLER_ID]);
  });

  for (const status of ["pending", "processing", "complete", "failed"]) {
    it(`answers 409 SWING_VIDEO_NOT_READY for status ${status}`, async () => {
      setAuthenticated(makeCallerClient({ video: readyVideo({ status }) }));
      await expectError(await analysesPOST(post(validBody())), 409, "SWING_VIDEO_NOT_READY");
      expect(state.adminConstructions).toBe(0);
    });
  }

  for (const [label, storagePath] of [
    ["another folder", `99999999-8888-4777-8666-555555555555/${VIDEO_ID}/source.mp4`],
    ["an empty path", ""],
    ["a bare owner prefix", `${CALLER_ID}/`],
    ["no path at all", null],
  ] as const) {
    it(`answers 409 for ${label} without asking Storage`, async () => {
      const client = makeCallerClient({ video: readyVideo({ storage_path: storagePath }) });
      setAuthenticated(client);
      await expectError(await analysesPOST(post(validBody())), 409, "SWING_VIDEO_NOT_READY");
      expect(client.calls.some((c) => c[0] === "info")).toBe(false);
    });
  }

  it("answers 409 when the Storage object is missing (direct 404)", async () => {
    setAuthenticated(makeCallerClient({ info: { data: null, error: { status: 404, message: "Object not found" } } }));
    await expectError(await analysesPOST(post(validBody())), 409, "SWING_VIDEO_NOT_READY");
  });

  it("answers 409 when the Storage object is missing (hosted 400 + statusCode 404)", async () => {
    setAuthenticated(makeCallerClient({ info: { data: null, error: { status: 400, statusCode: "404" } } }));
    await expectError(await analysesPOST(post(validBody())), 409, "SWING_VIDEO_NOT_READY");
  });

  it("treats any other Storage failure as an outage, not an absence", async () => {
    setAuthenticated(makeCallerClient({ info: { data: null, error: { status: 403, message: "policy text" } } }));
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("treats a thrown Storage call as an outage", async () => {
    setAuthenticated(makeCallerClient({ infoThrows: true }));
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("checks the stored object on the caller's own client, at the exact path", async () => {
    const client = makeCallerClient();
    setAuthenticated(client);
    await analysesPOST(post(validBody()));
    expect(client.calls).toContainEqual(["storage.from", "swing-videos"]);
    expect(client.calls).toContainEqual(["info", STORAGE_PATH]);
    expect(admin.calls.some((c) => c[0] === "admin.storage")).toBe(false);
  });

  it("answers 503 when the video read fails", async () => {
    setAuthenticated(makeCallerClient({ video: { data: null, error: { message: "db text" } } }));
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── CLUB ─────────────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — club", () => {
  it("accepts a null club without reading equipment", async () => {
    const client = makeCallerClient();
    setAuthenticated(client);
    const res = await analysesPOST(post(validBody()));
    expect(res.status).toBe(201);
    expect(client.calls.some((c) => c[0] === "from" && c[1] === "user_equipment")).toBe(false);
  });

  for (const [label, club] of [
    ["a missing club", { data: null, error: null }],
    ["another golfer's club (hidden by RLS)", { data: null, error: null }],
    ["an archived club", ownedClub({ is_archived: true })],
    ["an unknown club type", ownedClub({ club_type: "Chipper" })],
    ["a club with no club type", ownedClub({ club_type: null })],
  ] as const) {
    it(`answers 409 CLUB_INVALID for ${label}`, async () => {
      setAuthenticated(makeCallerClient({ club: club as DbResult }));
      await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 409, "CLUB_INVALID");
      expect(state.adminConstructions).toBe(0);
    });
  }

  it("scopes the club read to the caller explicitly", async () => {
    const client = makeCallerClient({ club: ownedClub() });
    setAuthenticated(client);
    await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(client.calls).toContainEqual(["eq", "user_equipment", "id", CLUB_ID]);
    expect(client.calls).toContainEqual(["eq", "user_equipment", "user_id", CALLER_ID]);
  });

  it("maps the equipment trigger refusing the club at insert to CLUB_INVALID", async () => {
    admin = makeAdmin({ insertResult: { data: null, error: { code: "P0001", message: "EQ1S1R: ..." } } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient({ club: ownedClub() }));
    await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 409, "CLUB_INVALID");
  });
});

// ─── ENTITLEMENT ──────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — putting entitlement", () => {
  for (const unentitled of ["par", "none"]) {
    it(`answers 403 ENTITLEMENT_REQUIRED for a ${unentitled} putt and never inserts`, async () => {
      setAuthenticated(makeCallerClient({ club: ownedClub({ club_type: "Putter" }), profile: tier(unentitled) }));
      await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 403, "ENTITLEMENT_REQUIRED");
      expect(state.adminConstructions).toBe(0);
      expect(adminInserts()).toEqual([]);
    });
  }

  for (const entitled of ["birdie", "eagle", "coach_starter", "coach_pro"]) {
    it(`creates a putting request for ${entitled}`, async () => {
      setAuthenticated(makeCallerClient({ club: ownedClub({ club_type: "Putter" }), profile: tier(entitled) }));
      const res = await analysesPOST(post(validBody({ clubId: CLUB_ID })));
      expect(res.status).toBe(201);
    });
  }

  for (const [label, profile] of [
    ["an unknown tier", tier("platinum")],
    ["a null tier", tier(null)],
    ["a missing profile", { data: null, error: null }],
  ] as const) {
    it(`fails closed with INTERNAL_ERROR for ${label}`, async () => {
      setAuthenticated(makeCallerClient({ club: ownedClub({ club_type: "Putter" }), profile: profile as DbResult }));
      await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 500, "INTERNAL_ERROR");
      expect(state.adminConstructions).toBe(0);
    });
  }

  it("answers 503 when the tier read fails", async () => {
    setAuthenticated(
      makeCallerClient({ club: ownedClub({ club_type: "Putter" }), profile: { data: null, error: { message: "x" } } }),
    );
    await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("adds no gate to full swing: a PAR golfer's Driver request is created without reading the tier", async () => {
    const client = makeCallerClient({ club: ownedClub(), profile: tier("par") });
    setAuthenticated(client);
    const res = await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(res.status).toBe(201);
    expect(client.calls.some((c) => c[0] === "from" && c[1] === "users")).toBe(false);
  });

  it("does not enforce the saved-swing limit", () => {
    const route = readSource("app/api/v1/analyses/route.ts");
    const code = route.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toContain("getSwingLimitForTier");
  });
});

// ─── CREATE / IDEMPOTENCY ─────────────────────────────────────────────────────

describe("POST /api/v1/analyses — creation and idempotency", () => {
  it("creates the request: 201, created=true, stored status and family", async () => {
    admin = makeAdmin({
      insertResult: {
        data: analysisRow({ club_id: CLUB_ID, analysis_family: "full_swing" }),
        error: null,
      },
    });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient({ club: ownedClub() }));
    const res = await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toEqual({
      data: {
        analysisId: VIDEO_ID,
        swingVideoId: VIDEO_ID,
        status: "pending",
        analysisFamily: "full_swing",
        clubId: CLUB_ID,
        createdAt: CREATED_AT,
        created: true,
      },
    });
  });

  it("inserts exactly id, swing_video_id, user_id and club_id — user_id from the verified identity", async () => {
    setAuthenticated(makeCallerClient({ club: ownedClub() }));
    await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    const inserts = adminInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toBe("swing_analysis");
    expect(inserts[0][2]).toEqual({
      id: VIDEO_ID,
      swing_video_id: VIDEO_ID,
      user_id: CALLER_ID,
      club_id: CLUB_ID,
    });
  });

  it("returns 200 created=false for the same video and club", async () => {
    setAuthenticated(
      makeCallerClient({ club: ownedClub(), existing: { data: [analysisRow({ club_id: CLUB_ID, status: "complete" })], error: null } }),
    );
    const res = await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.data.created).toBe(false);
    expect(body.data.status).toBe("complete");
    expect(state.adminConstructions).toBe(0);
  });

  it("treats null and null as the same club", async () => {
    setAuthenticated(makeCallerClient({ existing: { data: [analysisRow({ club_id: null })], error: null } }));
    const res = await analysesPOST(post(validBody({ clubId: null })));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).data.created).toBe(false);
  });

  it("answers 409 ANALYSIS_CONFLICT for the same video with a different club", async () => {
    setAuthenticated(
      makeCallerClient({ club: ownedClub(), existing: { data: [analysisRow({ club_id: OTHER_CLUB_ID })], error: null } }),
    );
    await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 409, "ANALYSIS_CONFLICT");
    expect(state.adminConstructions).toBe(0);
  });

  it("answers 409 when an existing no-club request meets a club", async () => {
    setAuthenticated(makeCallerClient({ club: ownedClub(), existing: { data: [analysisRow({ club_id: null })], error: null } }));
    await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 409, "ANALYSIS_CONFLICT");
  });

  it("fails closed rather than picking a winner among pre-existing duplicates", async () => {
    setAuthenticated(makeCallerClient({ existing: { data: [analysisRow(), analysisRow({ id: OTHER_CLUB_ID })], error: null } }));
    await expectError(await analysesPOST(post(validBody())), 500, "INTERNAL_ERROR");
    expect(state.adminConstructions).toBe(0);
  });

  it("recovers a unique race with exactly one re-read: same club → created=false", async () => {
    admin = makeAdmin({ insertResult: { data: null, error: { code: "23505", message: "duplicate key" } } });
    state.admin = admin.client;
    const client = makeCallerClient({ club: ownedClub(), reread: { data: analysisRow({ club_id: CLUB_ID }), error: null } });
    setAuthenticated(client);
    const res = await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).data.created).toBe(false);
    expect(client.calls.filter((c) => c[0] === "maybeSingle" && c[1] === "swing_analysis")).toHaveLength(1);
    expect(adminInserts()).toHaveLength(1);
  });

  it("recovers a unique race: different club → ANALYSIS_CONFLICT", async () => {
    admin = makeAdmin({ insertResult: { data: null, error: { code: "23505" } } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient({ club: ownedClub(), reread: { data: analysisRow({ club_id: OTHER_CLUB_ID }), error: null } }));
    await expectError(await analysesPOST(post(validBody({ clubId: CLUB_ID }))), 409, "ANALYSIS_CONFLICT");
  });

  it("fails closed when the race re-read finds nothing", async () => {
    admin = makeAdmin({ insertResult: { data: null, error: { code: "23505" } } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient({ reread: { data: null, error: null } }));
    await expectError(await analysesPOST(post(validBody())), 500, "INTERNAL_ERROR");
    expect(adminInserts()).toHaveLength(1);
  });

  it("answers 503 for any other insert failure", async () => {
    admin = makeAdmin({ insertResult: { data: null, error: { code: "08006", message: "connection text" } } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient());
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("answers 503 when the trusted writer cannot be constructed", async () => {
    state.adminThrows = true;
    setAuthenticated(makeCallerClient());
    await expectError(await analysesPOST(post(validBody())), 503, "SERVER_TEMPORARILY_UNAVAILABLE");
  });
});

// ─── TRUST BOUNDARY ───────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — trust boundary", () => {
  it("uses the elevated client for one INSERT and nothing else", async () => {
    setAuthenticated(makeCallerClient({ club: ownedClub() }));
    await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    expect(state.adminConstructions).toBe(1);
    expect(admin.calls.map((c) => c[0])).toEqual(["admin.from", "admin.insert", "admin.select", "admin.single"]);
  });

  it("performs every read and the Storage check on the caller's client, never a write", async () => {
    const client = makeCallerClient({ club: ownedClub({ club_type: "Putter" }), profile: tier("eagle") });
    setAuthenticated(client);
    await analysesPOST(post(validBody({ clubId: CLUB_ID })));
    const tables = client.calls.filter((c) => c[0] === "from").map((c) => c[1]);
    expect(tables).toEqual(["swing_videos", "user_equipment", "users", "swing_analysis"]);
    expect(client.calls.some((c) => c[0] === "info")).toBe(true);
    expect(client.calls.some((c) => String(c[0]).startsWith("caller."))).toBe(false);
  });

  it("decides everything before the elevated client exists", () => {
    const code = readSource("app/api/v1/analyses/route.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const auth = code.indexOf("await resolveRouteAuth()");
    const admin = code.indexOf("createAdminClient()");
    expect(auth).toBeGreaterThan(-1);
    expect((code.match(/createAdminClient\(\)/g) ?? []).length).toBe(1);
    for (const check of [
      "parseAnalysisCreateRequest(rawBody)",
      '.from("swing_videos")',
      ".info(storagePath)",
      '.from("user_equipment")',
      "canUsePuttingAnalysis(tier)",
      ".limit(2)",
    ]) {
      const at = code.indexOf(check);
      expect(at, `${check} must be present`).toBeGreaterThan(auth);
      expect(at, `${check} must precede the elevated client`).toBeLessThan(admin);
    }
    const adminBlock = code.slice(admin, code.indexOf(".single()", admin));
    expect(adminBlock).toContain('.from("swing_analysis")');
    expect(adminBlock).toContain(".insert({");
    expect(adminBlock).toContain("user_id: auth.userId,");
    expect(adminBlock).not.toContain("parsed.userId");
    for (const banned of ["status", "analysis_family", "equipment_snapshot", "analysis_mode", "storage"]) {
      expect(adminBlock, `the trusted INSERT must not carry ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("never references service-role material", () => {
    const route = readSource("app/api/v1/analyses/route.ts");
    const dto = readSource("lib/api/v1-analysis-dto.ts");
    for (const source of [route, dto]) {
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source).not.toContain("service_role");
      expect(source).not.toContain("process.env");
    }
    expect(dto).not.toContain("createAdminClient");
  });

  it("is never imported by client code", () => {
    const page = readSource("app/(dashboard)/analyze/page.tsx");
    expect(page).not.toContain("@/utils/supabase/admin");
    expect(page).not.toContain("createAdminClient");
    expect(page).not.toContain("app/api/v1/analyses");
  });
});

// ─── RESPONSE ─────────────────────────────────────────────────────────────────

describe("POST /api/v1/analyses — response contract", () => {
  it("carries the v1 headers and echoes a valid request id", async () => {
    state.incomingRequestId = "native-client-0001";
    setAuthenticated(makeCallerClient());
    const res = await analysesPOST(post(validBody()));
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Request-Id")).toBe("native-client-0001");
  });

  it("never leaks provider or database text", async () => {
    for (const client of [
      makeCallerClient({ video: { data: null, error: { message: "relation swing_videos secret detail" } } }),
      makeCallerClient({ info: { data: null, error: { status: 500, message: "bucket internals" } } }),
    ]) {
      setAuthenticated(client);
      const text = JSON.stringify(await bodyOf(await analysesPOST(post(validBody()))));
      expect(text).not.toContain("secret detail");
      expect(text).not.toContain("bucket internals");
    }
    admin = makeAdmin({ insertResult: { data: null, error: { code: "08006", message: "connection secret" } } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient());
    const text = JSON.stringify(await bodyOf(await analysesPOST(post(validBody()))));
    expect(text).not.toContain("connection secret");
  });

  it("fails closed when the stored row does not satisfy the DTO", async () => {
    admin = makeAdmin({ insertResult: { data: analysisRow({ analysis_family: "chipping" }), error: null } });
    state.admin = admin.client;
    setAuthenticated(makeCallerClient());
    await expectError(await analysesPOST(post(validBody())), 500, "INTERNAL_ERROR");
  });
});

// ─── DTO units ────────────────────────────────────────────────────────────────

describe("v1 analysis DTO units", () => {
  it("parses exactly the two keys, with clubId nullable", () => {
    expect(parseAnalysisCreateRequest({ swingVideoId: VIDEO_ID, clubId: null })).toEqual({
      swingVideoId: VIDEO_ID,
      clubId: null,
    });
    expect(parseAnalysisCreateRequest({ swingVideoId: VIDEO_ID, clubId: CLUB_ID })).toEqual({
      swingVideoId: VIDEO_ID,
      clubId: CLUB_ID,
    });
    expect(parseAnalysisCreateRequest({ swingVideoId: VIDEO_ID })).toBeNull();
    expect(parseAnalysisCreateRequest(null)).toBeNull();
  });

  it("requires the caller's own folder as the path prefix", () => {
    expect(isOwnerStoragePath(STORAGE_PATH, CALLER_ID)).toBe(true);
    expect(isOwnerStoragePath(`${CALLER_ID}`, CALLER_ID)).toBe(false);
    expect(isOwnerStoragePath(`x${CALLER_ID}/a`, CALLER_ID)).toBe(false);
  });

  it("recognises only the known tiers", () => {
    expect(toSubscriptionTier("birdie")).toBe("birdie");
    expect(toSubscriptionTier("BIRDIE")).toBeNull();
    expect(toSubscriptionTier(undefined)).toBeNull();
  });

  it("compares clubs with null equal to null", () => {
    expect(isSameClub(null, null)).toBe(true);
    expect(isSameClub(undefined, null)).toBe(true);
    expect(isSameClub(CLUB_ID, null)).toBe(false);
    expect(isSameClub(CLUB_ID, CLUB_ID)).toBe(true);
  });

  it("publishes only stored facts and reads status and family from the row", () => {
    expect(toAnalysisRequestDto(analysisRow({ status: "processing", analysis_family: "putting" }), false)).toMatchObject({
      status: "processing",
      analysisFamily: "putting",
      created: false,
    });
    expect(toAnalysisRequestDto(analysisRow({ created_at: "not a date" }), true)).toBeNull();
    expect(ANALYSIS_REQUEST_COLUMNS).not.toContain("score");
  });
});
