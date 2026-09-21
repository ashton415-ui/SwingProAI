import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getClubDisplayName } from "@/lib/equipment/club-display-name";
import {
  V1_CLUB_TYPES,
  isV1ClubType,
  toBagDto,
  toEquipmentCatalogDto,
  type BagRow,
} from "@/lib/api/v1-equipment-dto";
import type { CanonicalCatalogEntry } from "@/lib/equipment/catalog";
import type { VerifiedAuth } from "@/utils/supabase/server";
import { GET as catalogGET } from "@/app/api/v1/equipment/catalog/route";
import { GET as bagGET } from "@/app/api/v1/bag/route";

/**
 * NATIVE API EQUIPMENT READ FOUNDATION — contract coverage.
 *
 * The two route handlers are executed for real. `next/headers` and the verified
 * resolver are mocked, but everything else is the production code path: the
 * real V1 response helpers, the real canonical catalog reader, the real
 * display-name helper and the real DTO mappers all run.
 *
 * The Supabase client is a recording fake injected through `auth.client`, so
 * the select strings, the filter chain and the ordering are observed as the
 * route actually issues them rather than asserted about source text. That is
 * what lets the bag tests prove the ownership predicate filters `user_id` and
 * never `id` — a regression that would hand every golfer an empty bag.
 *
 * Resolver semantics themselves (cookie/Bearer precedence, the absence of any
 * fallback, token verification) stay proven by lib/verified-auth-resolver.test.ts
 * and are not restated here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sha256Of(relativePath: string): string {
  return createHash("sha256").update(readFileSync(path.join(repoRoot, relativePath))).digest("hex");
}

// ─── Recording fake Supabase client ───────────────────────────────────────────

interface QueryResponse {
  data: unknown;
  error: { message?: string; code?: string; details?: string | null; hint?: string | null } | null;
  status?: number;
}

type RecordedCall = readonly [method: string, ...args: unknown[]];

interface FakeBuilder extends PromiseLike<QueryResponse> {
  select(columns: string): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  order(column: string, options: { ascending: boolean }): FakeBuilder;
}

interface FakeClient {
  from(table: string): FakeBuilder;
  calls: RecordedCall[];
}

function makeFakeClient(response: QueryResponse): FakeClient {
  const calls: RecordedCall[] = [];
  const builder: FakeBuilder = {
    select(columns) {
      calls.push(["select", columns]);
      return builder;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return builder;
    },
    order(column, options) {
      calls.push(["order", column, options]);
      return builder;
    },
    then(onfulfilled, onrejected) {
      return Promise.resolve(response).then(onfulfilled, onrejected);
    },
  };
  return {
    from(table) {
      calls.push(["from", table]);
      return builder;
    },
    calls,
  };
}

/** Every `eq` the route/reader issued, as [column, value] pairs. */
function eqCalls(client: FakeClient): Array<[string, unknown]> {
  return client.calls
    .filter((c) => c[0] === "eq")
    .map((c) => [c[1] as string, c[2]] as [string, unknown]);
}

function selectString(client: FakeClient): string {
  const call = client.calls.find((c) => c[0] === "select");
  return (call?.[1] as string) ?? "";
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

function setAuthenticated(client: FakeClient): void {
  state.auth = {
    status: "authenticated",
    userId: CALLER_ID,
    email: "golfer@example.com",
    accessToken: "not-a-real-token",
    client,
    source: "cookie",
  } as unknown as VerifiedAuth;
}

function setUnauthenticated(status: "absent" | "invalid" | "verification_unavailable"): void {
  state.auth = { status } as unknown as VerifiedAuth;
}

beforeEach(() => {
  state.auth = null;
  state.incomingRequestId = null;
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    manufacturer_id: "aaaaaaaa-0000-4000-8000-00000000000a",
    club_type: "Driver",
    canonical_name: "Model One",
    slug: "model-one",
    normalized_name: "modelone",
    model_year: null,
    specifications: {},
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    catalog_key: "alpha/model-one",
    brand_line: null,
    brand_line_slug: null,
    model_family: "Model",
    model_family_slug: "model",
    release_year: null,
    manufacturer: {
      id: "aaaaaaaa-0000-4000-8000-00000000000a",
      canonical_name: "Alpha",
      slug: "alpha",
      normalized_name: "alpha",
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    putter_specs: null,
    ...overrides,
  };
}

function bagRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bbbbbbbb-0000-4000-8000-00000000000b",
    club_type: "Iron",
    club_designation: "7I",
    brand: "PING",
    model: "G440",
    custom_club: false,
    custom_brand: null,
    custom_model: null,
    shaft_flex: "Stiff",
    shaft_weight: 105,
    loft_deg: 30.5,
    is_primary: false,
    created_at: "2026-06-02T00:22:28.278Z",
    ...overrides,
  };
}

async function bodyOf(response: Response): Promise<unknown> {
  return await response.json();
}

const ROUTES = [
  ["catalog", () => catalogGET()] as const,
  ["bag", () => bagGET()] as const,
];

// ─── A. Auth + Foundation contract, both routes ───────────────────────────────

describe("equipment routes — auth and Foundation contract", () => {
  it.each(ROUTES)("1. %s: absent auth → 401 AUTH_REQUIRED", async (_name, call) => {
    setUnauthenticated("absent");
    const response = await call();
    expect(response.status).toBe(401);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe("AUTH_REQUIRED");
  });

  it.each(ROUTES)("2. %s: invalid Bearer → 401 AUTH_INVALID", async (_name, call) => {
    setUnauthenticated("invalid");
    const response = await call();
    expect(response.status).toBe(401);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe("AUTH_INVALID");
  });

  it.each(ROUTES)("3. %s: verification unavailable → 503", async (_name, call) => {
    setUnauthenticated("verification_unavailable");
    const response = await call();
    expect(response.status).toBe(503);
    expect((await bodyOf(response) as { error: { code: string } }).error.code).toBe(
      "SERVER_TEMPORARILY_UNAVAILABLE",
    );
  });

  it.each(ROUTES)("4. %s: a rejected credential never reaches the database", async (_name, call) => {
    const client = makeFakeClient({ data: [], error: null });
    // The client is present, but the resolver rejected the credential. If the
    // route had any cookie fallback, it would still issue a query.
    state.auth = { status: "invalid", client } as unknown as VerifiedAuth;
    const response = await call();
    expect(response.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });

  it("5. catalog: reads through the caller-scoped client from the verified auth", async () => {
    const client = makeFakeClient({ data: [catalogRow()], error: null });
    setAuthenticated(client);
    await catalogGET();
    expect(client.calls[0]).toEqual(["from", "equipment_models"]);
  });

  it("5b. bag: reads through the caller-scoped client from the verified auth", async () => {
    const client = makeFakeClient({ data: [bagRow()], error: null });
    setAuthenticated(client);
    await bagGET();
    expect(client.calls[0]).toEqual(["from", "user_equipment"]);
  });

  it("7. neither handler accepts a request argument, so no caller id can be supplied", () => {
    expect(catalogGET.length).toBe(0);
    expect(bagGET.length).toBe(0);
  });

  it.each(ROUTES)("8. %s: success uses exactly the { data } envelope", async (_name, call) => {
    setAuthenticated(makeFakeClient({ data: [], error: null }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(Object.keys((await bodyOf(response)) as object)).toEqual(["data"]);
  });

  it.each(ROUTES)("9. %s: echoes a valid request id and replaces an invalid one", async (_name, call) => {
    setAuthenticated(makeFakeClient({ data: [], error: null }));
    state.incomingRequestId = "NativeEquip_20260920";
    const echoed = await call();
    expect(echoed.headers.get("X-Request-Id")).toBe("NativeEquip_20260920");

    setAuthenticated(makeFakeClient({ data: [], error: null }));
    state.incomingRequestId = "bad";
    const replaced = await call();
    const generated = replaced.headers.get("X-Request-Id");
    expect(generated).not.toBe("bad");
    expect(generated).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it.each(ROUTES)("9b. %s: error bodies carry the same request id as the header", async (_name, call) => {
    setUnauthenticated("absent");
    state.incomingRequestId = "NativeEquip_20260920";
    const response = await call();
    const body = (await bodyOf(response)) as { error: { requestId: string } };
    expect(body.error.requestId).toBe("NativeEquip_20260920");
    expect(response.headers.get("X-Request-Id")).toBe("NativeEquip_20260920");
  });

  it.each(ROUTES)("10. %s: is private and uncacheable on success and on error", async (_name, call) => {
    setAuthenticated(makeFakeClient({ data: [], error: null }));
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
    setUnauthenticated("absent");
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each(ROUTES)("10b. %s: sends JSON content type", async (_name, call) => {
    setAuthenticated(makeFakeClient({ data: [], error: null }));
    expect((await call()).headers.get("Content-Type")).toBe("application/json");
  });

  it.each(ROUTES)("11. %s: provider error detail never reaches the response", async (_name, call) => {
    setAuthenticated(
      makeFakeClient({
        data: null,
        error: {
          message: 'relation "user_equipment" does not exist',
          code: "42P01",
          details: "LEAKED_DETAILS",
          hint: "LEAKED_HINT",
        },
      }),
    );
    const response = await call();
    expect(response.status).toBe(500);
    const text = JSON.stringify(await bodyOf(response));
    for (const forbidden of ["LEAKED_DETAILS", "LEAKED_HINT", "42P01", "relation", "does not exist"]) {
      expect(text).not.toContain(forbidden);
    }
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── B. Catalog behaviour ─────────────────────────────────────────────────────

interface CatalogPayload {
  data: {
    clubTypes: string[];
    manufacturers: Array<{ id: string; name: string }>;
    models: Array<Record<string, unknown>>;
  };
}

async function catalogPayload(rows: Array<Record<string, unknown>>): Promise<{
  payload: CatalogPayload;
  client: FakeClient;
  response: Response;
}> {
  const client = makeFakeClient({ data: rows, error: null });
  setAuthenticated(client);
  const response = await catalogGET();
  return { payload: (await response.json()) as CatalogPayload, client, response };
}

describe("GET /api/v1/equipment/catalog", () => {
  it("12/26. publishes exactly the frozen top-level and model keys", async () => {
    const { payload } = await catalogPayload([catalogRow()]);
    expect(Object.keys(payload.data).sort()).toEqual(["clubTypes", "manufacturers", "models"]);
    expect(Object.keys(payload.data.models[0]).sort()).toEqual([
      "brandLine",
      "catalogKey",
      "clubType",
      "id",
      "manufacturerId",
      "modelFamily",
      "name",
    ]);
    expect(Object.keys(payload.data.manufacturers[0]).sort()).toEqual(["id", "name"]);
  });

  it("13. preserves UUID identity and catalogKey", async () => {
    const { payload } = await catalogPayload([catalogRow()]);
    expect(payload.data.models[0].id).toBe("00000000-0000-4000-8000-000000000001");
    expect(payload.data.models[0].catalogKey).toBe("alpha/model-one");
    expect(payload.data.manufacturers[0].id).toBe("aaaaaaaa-0000-4000-8000-00000000000a");
  });

  it("14-20. omits provenance, specifications, normalized names, flags, years and putter specs", async () => {
    const { payload } = await catalogPayload([
      catalogRow({
        normalized_name: "LEAKED_NORMALIZED",
        model_year: 2024,
        release_year: 2025,
        specifications: { LEAKED_SPEC: true },
        putter_specs: {
          equipment_model_id: "00000000-0000-4000-8000-000000000001",
          head_shape: "mallet",
          neck_source_label: "LEAKED_PROVENANCE",
        },
      }),
    ]);
    const text = JSON.stringify(payload);
    for (const forbidden of [
      "LEAKED_NORMALIZED",
      "LEAKED_SPEC",
      "LEAKED_PROVENANCE",
      "normalized_name",
      "normalizedName",
      "specifications",
      "is_active",
      "isActive",
      "model_year",
      "modelYear",
      "release_year",
      "releaseYear",
      "putter_specs",
      "putterSpecs",
      "source_url",
      "source_type",
      "verified_at",
      "createdAt",
      "updatedAt",
      "slug",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("21. publishes the exact club-type vocabulary in bag order", async () => {
    const { payload } = await catalogPayload([catalogRow()]);
    expect(payload.data.clubTypes).toEqual(["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]);
    expect(V1_CLUB_TYPES).toEqual(["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]);
  });

  it("22. preserves the canonical reader's ordering", async () => {
    const zetaPutter = catalogRow({
      id: "00000000-0000-4000-8000-000000000003",
      club_type: "Putter",
      canonical_name: "Putter One",
      slug: "putter-one",
      catalog_key: "zeta/putter-one",
      manufacturer_id: "cccccccc-0000-4000-8000-00000000000c",
      manufacturer: { ...(catalogRow().manufacturer as object), id: "cccccccc-0000-4000-8000-00000000000c", canonical_name: "Zeta", slug: "zeta" },
    });
    const betaDriver = catalogRow({
      id: "00000000-0000-4000-8000-000000000002",
      canonical_name: "Driver Two",
      slug: "driver-two",
      catalog_key: "beta/driver-two",
      manufacturer_id: "bbbbbbbb-0000-4000-8000-00000000000b",
      manufacturer: { ...(catalogRow().manufacturer as object), id: "bbbbbbbb-0000-4000-8000-00000000000b", canonical_name: "Beta", slug: "beta" },
    });
    const { payload } = await catalogPayload([zetaPutter, betaDriver, catalogRow()]);
    // club type (bag order) → manufacturer name → model name.
    expect(payload.data.models.map((m) => m.catalogKey)).toEqual([
      "alpha/model-one",
      "beta/driver-two",
      "zeta/putter-one",
    ]);
  });

  it("23/24/25. deduplicates manufacturers by id, sorts by name, and every model resolves", async () => {
    const secondAlpha = catalogRow({
      id: "00000000-0000-4000-8000-000000000009",
      canonical_name: "Model Two",
      slug: "model-two",
      catalog_key: "alpha/model-two",
    });
    const zeta = catalogRow({
      id: "00000000-0000-4000-8000-00000000000f",
      canonical_name: "Model Three",
      slug: "model-three",
      catalog_key: "zeta/model-three",
      manufacturer_id: "cccccccc-0000-4000-8000-00000000000c",
      manufacturer: { ...(catalogRow().manufacturer as object), id: "cccccccc-0000-4000-8000-00000000000c", canonical_name: "Zeta", slug: "zeta" },
    });
    const { payload } = await catalogPayload([catalogRow(), secondAlpha, zeta]);

    expect(payload.data.manufacturers).toHaveLength(2);
    expect(payload.data.manufacturers.map((m) => m.name)).toEqual(["Alpha", "Zeta"]);
    const ids = new Set(payload.data.manufacturers.map((m) => m.id));
    for (const model of payload.data.models) {
      expect(ids.has(model.manufacturerId as string)).toBe(true);
    }
  });

  it("26b. carries no pagination metadata", async () => {
    const { payload } = await catalogPayload([catalogRow()]);
    const text = JSON.stringify(payload);
    for (const forbidden of ["cursor", "nextCursor", "hasMore", "limit", "offset", "total", "page"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("27. requests the whole active catalog with no club-type filter", async () => {
    const { client } = await catalogPayload([catalogRow()]);
    const eqs = eqCalls(client);
    expect(eqs).toEqual([
      ["is_active", true],
      ["manufacturer.is_active", true],
    ]);
    expect(eqs.some(([column]) => column === "club_type")).toBe(false);
    expect(readSource("app/api/v1/equipment/catalog/route.ts")).not.toContain("searchParams");
  });

  it("28. maps every non-success reader state to an opaque 500", async () => {
    // auth_error (SQLSTATE 42501) arrives AFTER the caller was verified, so it is
    // a server misconfiguration — never a 401 that would log the golfer out.
    const permissionDenied = makeFakeClient({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    setAuthenticated(permissionDenied);
    const authErrorResponse = await catalogGET();
    expect(authErrorResponse.status).toBe(500);
    expect(((await authErrorResponse.json()) as { error: { code: string } }).error.code).toBe(
      "INTERNAL_ERROR",
    );

    // malformed_data: a row violating canonical identity.
    setAuthenticated(makeFakeClient({ data: [catalogRow({ catalog_key: "" })], error: null }));
    expect((await catalogGET()).status).toBe(500);

    // non-array payload.
    setAuthenticated(makeFakeClient({ data: { not: "an array" }, error: null }));
    expect((await catalogGET()).status).toBe(500);
  });

  it("28b. an empty catalog is a 200, not an error", async () => {
    const { payload, response } = await catalogPayload([]);
    expect(response.status).toBe(200);
    expect(payload.data.models).toEqual([]);
    expect(payload.data.manufacturers).toEqual([]);
    expect(payload.data.clubTypes).toHaveLength(6);
  });
});

// ─── C. Bag behaviour ─────────────────────────────────────────────────────────

interface BagPayload {
  data: { clubs: Array<Record<string, unknown>> };
}

async function bagPayload(rows: Array<Record<string, unknown>>): Promise<{
  payload: BagPayload;
  client: FakeClient;
  response: Response;
}> {
  const client = makeFakeClient({ data: rows, error: null });
  setAuthenticated(client);
  const response = await bagGET();
  return { payload: (await response.json()) as BagPayload, client, response };
}

describe("GET /api/v1/bag", () => {
  it("29/30. scopes the read to the verified caller's user_id, never to id", async () => {
    const { client } = await bagPayload([bagRow()]);
    const eqs = eqCalls(client);
    expect(eqs).toContainEqual(["user_id", CALLER_ID]);
    // Regression guard: `id` is the club's own primary key. Filtering it by a
    // user id matches nothing and silently empties every golfer's bag.
    expect(eqs.some(([column, value]) => column === "id" && value === CALLER_ID)).toBe(false);
    expect(eqs.some(([column]) => column === "id")).toBe(false);
  });

  it("31. excludes archived clubs at the query boundary", async () => {
    const { client } = await bagPayload([bagRow()]);
    expect(eqCalls(client)).toContainEqual(["is_archived", false]);
  });

  it("32/36. projects explicit columns only, with no wildcard and no embed", async () => {
    const { client } = await bagPayload([bagRow()]);
    const select = selectString(client);
    expect(select).toBe(
      "id, club_type, club_designation, brand, model, custom_club, custom_brand, custom_model, shaft_flex, shaft_weight, loft_deg, is_primary, created_at",
    );
    expect(select).not.toContain("*");
    // An embed would appear as a parenthesised relation in the select string.
    expect(select).not.toContain("(");
    for (const forbidden of ["user_id", "is_archived", "custom_notes", "updated_at", "equipment_models", "equipment_manufacturers", "equipment_model_sources"]) {
      expect(select).not.toContain(forbidden);
    }
  });

  it("33/34/35/48/49/50. returns no raw row and no withheld column", async () => {
    const { payload } = await bagPayload([
      { ...bagRow(), user_id: CALLER_ID, is_archived: false, custom_notes: "LEAKED_NOTE", updated_at: "2026-07-01T00:00:00.000Z", equipment_snapshot: { LEAKED: true }, analysis_family: "putting" },
    ]);
    const text = JSON.stringify(payload);
    for (const forbidden of ["user_id", "userId", "is_archived", "isArchived", "custom_notes", "customNotes", "LEAKED_NOTE", "updated_at", "updatedAt", "equipment_snapshot", "equipmentSnapshot", "analysis_family", "analysisFamily", "manufacturerId", "equipmentModelId"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(payload.data.clubs[0]).sort()).toEqual([
      "brand",
      "clubDesignation",
      "clubType",
      "createdAt",
      "customBrand",
      "customClub",
      "customModel",
      "displayName",
      "id",
      "isPrimary",
      "loftDeg",
      "model",
      "shaftFlex",
      "shaftWeight",
    ]);
  });

  it("37. names clubs through the shared display-name helper", async () => {
    const row = bagRow();
    const { payload } = await bagPayload([row]);
    expect(payload.data.clubs[0].displayName).toBe(
      getClubDisplayName({
        club_type: "Iron",
        club_designation: "7I",
        brand: "PING",
        model: "G440",
        custom_club: false,
        custom_brand: null,
        custom_model: null,
      }),
    );
    expect(payload.data.clubs[0].displayName).toBe("7I · PING G440");
  });

  it("37b. an illegal designation degrades to the identity name rather than being published as a prefix", async () => {
    const { payload } = await bagPayload([bagRow({ club_type: "Driver", club_designation: "7I" })]);
    // A driver has no legal designation; the helper drops the prefix.
    expect(payload.data.clubs[0].displayName).toBe("PING G440");
    // The stored value is still reported faithfully.
    expect(payload.data.clubs[0].clubDesignation).toBe("7I");
  });

  it("38. preserves nulls on standard and custom fields", async () => {
    const { payload } = await bagPayload([
      bagRow({
        club_designation: null,
        brand: null,
        model: null,
        custom_brand: null,
        custom_model: null,
        shaft_flex: null,
        shaft_weight: null,
        loft_deg: null,
      }),
    ]);
    const club = payload.data.clubs[0];
    for (const key of ["clubDesignation", "brand", "model", "customBrand", "customModel", "shaftFlex", "shaftWeight", "loftDeg"]) {
      expect(club[key]).toBeNull();
    }
  });

  it("39/40/42. emits numbers for loft and shaft weight, never strings", async () => {
    const { payload } = await bagPayload([
      bagRow({ loft_deg: "30.5", shaft_weight: "105" }),
      bagRow({ id: "cccccccc-0000-4000-8000-00000000000c", loft_deg: 9, shaft_weight: 60 }),
    ]);
    expect(payload.data.clubs[0].loftDeg).toBe(30.5);
    expect(payload.data.clubs[0].shaftWeight).toBe(105);
    expect(payload.data.clubs[1].loftDeg).toBe(9);
    expect(typeof payload.data.clubs[0].loftDeg).toBe("number");
    expect(typeof payload.data.clubs[0].shaftWeight).toBe("number");
  });

  it("41. maps an unusable numeric to null and never leaks the raw value", async () => {
    for (const bad of ["not-a-number", "", "   ", true, {}, [], NaN, Infinity]) {
      const { payload } = await bagPayload([bagRow({ loft_deg: bad, shaft_weight: bad })]);
      const club = payload.data.clubs[0];
      expect(club.loftDeg).toBeNull();
      expect(club.shaftWeight).toBeNull();
      expect(JSON.stringify(payload)).not.toContain("not-a-number");
    }
  });

  it("43. normalises created_at to ISO-8601 UTC", async () => {
    const { payload } = await bagPayload([bagRow({ created_at: "2026-06-02T00:22:28.278+00:00" })]);
    expect(payload.data.clubs[0].createdAt).toBe("2026-06-02T00:22:28.278Z");
  });

  it("44. fails closed on a malformed timestamp rather than publishing it", async () => {
    const { response, payload } = await bagPayload([bagRow({ created_at: "not-a-date" })]);
    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain("not-a-date");
    expect((payload as unknown as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
  });

  it("45. fails closed on an unknown club type rather than publishing it", async () => {
    const { response, payload } = await bagPayload([bagRow({ club_type: "Chipper" })]);
    expect(response.status).toBe(500);
    expect(JSON.stringify(payload)).not.toContain("Chipper");
  });

  it("45b. fails closed when a NOT NULL flag is not boolean", async () => {
    const { response } = await bagPayload([bagRow({ custom_club: "yes" })]);
    expect(response.status).toBe(500);
  });

  it("46. an empty active bag is a 200 with an empty list", async () => {
    const { response, payload } = await bagPayload([]);
    expect(response.status).toBe(200);
    expect(payload.data.clubs).toEqual([]);
  });

  it("47. orders by created_at then id, both ascending", async () => {
    const { client } = await bagPayload([bagRow()]);
    const orders = client.calls.filter((c) => c[0] === "order");
    expect(orders).toEqual([
      ["order", "created_at", { ascending: true }],
      ["order", "id", { ascending: true }],
    ]);
  });
});

// ─── D. Pure mapper units ─────────────────────────────────────────────────────

describe("equipment DTO mappers", () => {
  it("narrows the club-type vocabulary and refuses anything else", () => {
    for (const valid of V1_CLUB_TYPES) expect(isV1ClubType(valid)).toBe(true);
    for (const invalid of ["Chipper", "driver", "", null, 7, {}]) {
      expect(isV1ClubType(invalid)).toBe(false);
    }
  });

  it("returns null from the catalog mapper when identity is violated", () => {
    const entry = catalogRow({ id: "" }) as unknown as CanonicalCatalogEntry;
    expect(toEquipmentCatalogDto([entry])).toBeNull();
  });

  it("returns null from the bag mapper when a NOT NULL column is unusable", () => {
    expect(toBagDto([bagRow({ id: "" }) as BagRow])).toBeNull();
    expect(toBagDto([bagRow({ created_at: null }) as BagRow])).toBeNull();
    expect(toBagDto([])).toEqual({ clubs: [] });
  });
});

// ─── E. Source contract ───────────────────────────────────────────────────────

const CATALOG_ROUTE = "app/api/v1/equipment/catalog/route.ts";
const BAG_ROUTE = "app/api/v1/bag/route.ts";
const DTO_MODULE = "lib/api/v1-equipment-dto.ts";

describe("equipment slice source contract", () => {
  const FROZEN: Array<[string, string]> = [
    ["utils/supabase/server.ts", "43e341460fa254d92bcd041774c6b085ab99931c9dc4cf631d6959d9c921fe74"],
    ["lib/api/v1-response.ts", "7ad95521b7bbc0ed20e2be28f804a145af08035772663bc16d1438f3bfff15ad"],
    ["lib/api/me-dto.ts", "ed8d897ca11e05a7d722c03904d4a7642afeea63d5f8db58bc05b861928fa75f"],
    ["app/api/v1/me/route.ts", "465fafe5eb791148b29f27028db0e3685ca219b5217eef6b46aca0e5033071a2"],
    ["lib/api-v1-foundation.test.ts", "55d0db58605084dff9a4a2210f331d45fc2164fa4ea011371bcf6e3adc248335"],
    ["app/api/v1/swing-data/route.ts", "fc6b3a5c6d2834d8c3ac58666e6f00159b29ab4eb0454d8d87e521bcf5daa135"],
    ["lib/equipment/catalog.ts", "88303c5b51838bd16562246a3ee27379b4e39feacddf0e9ab8c102cb63195a7e"],
    ["lib/equipment/club-display-name.ts", "6533d152a8bc8919e832f97669f35cab3a6f0249ffd5e538dc90be35bd9443d1"],
  ];

  it.each(FROZEN)("51-58. %s remains byte-identical", (relativePath, expected) => {
    expect(sha256Of(relativePath)).toBe(expected);
  });

  it("59. neither route imports or reuses the legacy golf-bag surface", () => {
    for (const source of [readSource(CATALOG_ROUTE), readSource(BAG_ROUTE), readSource(DTO_MODULE)]) {
      expect(source).not.toContain("golf-bag");
      expect(source).not.toContain("user_golf_bag");
    }
  });

  it("60-64. neither route exports a mutation method", () => {
    for (const source of [readSource(CATALOG_ROUTE), readSource(BAG_ROUTE)]) {
      for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
        expect(source).not.toContain(`export async function ${method}`);
        expect(source).not.toContain(`export function ${method}`);
      }
      for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
        expect(source).not.toContain(write);
      }
      expect(source).toContain("export async function GET()");
    }
  });

  it("65. no service-role or admin client reference is introduced", () => {
    for (const source of [readSource(CATALOG_ROUTE), readSource(BAG_ROUTE), readSource(DTO_MODULE)]) {
      for (const forbidden of ["SERVICE_ROLE", "service_role", "createAdminClient", "supabase/admin"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("66. no entitlement/tier gating is introduced", () => {
    for (const source of [readSource(CATALOG_ROUTE), readSource(BAG_ROUTE), readSource(DTO_MODULE)]) {
      expect(source).not.toContain("lib/entitlements");
      expect(source).not.toContain("SubscriptionTier");
      expect(source).not.toContain("canUse");
    }
  });

  it("66b. neither route logs, and both answer only through the V1 helpers", () => {
    for (const source of [readSource(CATALOG_ROUTE), readSource(BAG_ROUTE)]) {
      expect(source).not.toContain("console.");
      expect(source).not.toContain("NextResponse");
      expect(source).not.toContain("new Response(");
      expect(source).toContain("resolveRouteAuth");
      expect(source).toContain("v1Success(");
      expect(source).toContain("v1Error(");
      expect(source).toContain("v1AuthErrorResponse(");
    }
  });
});
