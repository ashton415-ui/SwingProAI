import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  queryCanonicalEquipmentCatalog,
  CANONICAL_CATALOG_SELECT,
  CLUB_TYPE_ORDER,
  EQUIPMENT_MODELS_TABLE,
  type CatalogPostgrestResponse,
  type CatalogSupabaseClient,
} from "@/lib/equipment/catalog";

/**
 * Slice 1 — canonical catalog query layer.
 *
 * Behavioural tests against an injected fake client, plus a small number of
 * source-contract assertions for guarantees that are structural rather than
 * observable at runtime (no write methods, no service-role client, no static
 * fallback import). No live Supabase connection is made — consistent with every
 * other suite in lib/, none of which constructs a real client.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const CATALOG_MODULE = "lib/equipment/catalog.ts";
const catalogSource = readSource(CATALOG_MODULE);

/**
 * Executable source with comments removed.
 *
 * The negative structural assertions below ask "does the code do X?", not "does
 * the file ever mention X?" — and the module's own documentation deliberately
 * names the things it must never do (the service-role admin client, the legacy
 * static catalog route, locale-sensitive comparison). Scanning raw text would
 * therefore fail on the very comments that document the guarantee. Stripping
 * comments makes each assertion test the guarantee it claims to test.
 *
 * The module contains no `//` sequence inside a string literal, so this simple
 * strip is sound here; it is not a general-purpose JavaScript parser.
 */
const catalogCode = catalogSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─── Fake client ──────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface FakeClient extends CatalogSupabaseClient {
  calls: RecordedCall[];
  tables: string[];
}

/**
 * Records every builder call so tests can assert the exact query contract, and
 * resolves to the supplied PostgREST response. Any method the module does not
 * legitimately use is simply absent — calling one would throw, which is itself
 * a guardrail.
 */
function makeFakeClient(response: CatalogPostgrestResponse | (() => never)): FakeClient {
  const calls: RecordedCall[] = [];
  const tables: string[] = [];

  const builder = {
    select(columns: string) {
      calls.push({ method: "select", args: [columns] });
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push({ method: "eq", args: [column, value] });
      return builder;
    },
    then(onFulfilled: (value: CatalogPostgrestResponse) => unknown, onRejected?: (reason: unknown) => unknown) {
      if (typeof response === "function") {
        try {
          response();
          throw new Error("unreachable");
        } catch (thrown) {
          return Promise.resolve().then(() => (onRejected ? onRejected(thrown) : Promise.reject(thrown)));
        }
      }
      return Promise.resolve(response).then(onFulfilled, onRejected);
    },
  };

  return {
    calls,
    tables,
    from(table: string) {
      tables.push(table);
      calls.push({ method: "from", args: [table] });
      return builder as unknown as ReturnType<CatalogSupabaseClient["from"]>;
    },
  };
}

// ─── Row fixtures ─────────────────────────────────────────────────────────────

function manufacturer(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    canonical_name: "Titleist",
    slug: "titleist",
    normalized_name: "titleist",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    manufacturer_id: "11111111-1111-4111-8111-111111111111",
    club_type: "Putter",
    canonical_name: "Scotty Cameron Phantom 5.5",
    slug: "phantom-5-5",
    normalized_name: "scottycameronphantom55",
    model_year: null,
    specifications: {},
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    catalog_key: "titleist/scotty-cameron/phantom-5-5/v1",
    brand_line: "Scotty Cameron",
    brand_line_slug: "scotty-cameron",
    model_family: "Phantom",
    model_family_slug: "phantom",
    release_year: null,
    manufacturer: manufacturer(),
    putter_specs: null,
    ...overrides,
  };
}

function ok(rows: unknown[]): CatalogPostgrestResponse {
  return { data: rows, error: null, status: 200 };
}

// ─── A. Canonical identity ────────────────────────────────────────────────────

describe("canonical catalog query — identity preservation", () => {
  it("preserves manufacturer UUID, model UUID, catalog_key and both slugs", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const [entry] = result.entries;
    expect(entry.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(entry.catalog_key).toBe("titleist/scotty-cameron/phantom-5-5/v1");
    expect(entry.slug).toBe("phantom-5-5");
    expect(entry.manufacturer.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(entry.manufacturer.slug).toBe("titleist");
    expect(entry.manufacturer.canonical_name).toBe("Titleist");
  });

  it("carries the canonical fields later selectors depend on", async () => {
    const client = makeFakeClient(ok([modelRow({ model_year: 2024, release_year: 2023 })]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const [entry] = result.entries;
    expect(entry.club_type).toBe("Putter");
    expect(entry.brand_line).toBe("Scotty Cameron");
    expect(entry.brand_line_slug).toBe("scotty-cameron");
    expect(entry.model_family).toBe("Phantom");
    expect(entry.model_family_slug).toBe("phantom");
    expect(entry.model_year).toBe(2024);
    expect(entry.release_year).toBe(2023);
    expect(entry.specifications).toEqual({});
  });

  it("does not fabricate loft or shaft fields, which are user_equipment customizations", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const entry = result.entries[0] as unknown as Record<string, unknown>;
    expect(entry.loft_deg).toBeUndefined();
    expect(entry.shaft_flex).toBeUndefined();
    expect(entry.shaft_weight).toBeUndefined();
    // The select list must not request them either — they do not exist in the catalog schema.
    expect(CANONICAL_CATALOG_SELECT).not.toContain("loft");
    expect(CANONICAL_CATALOG_SELECT).not.toContain("shaft");
  });
});

// ─── B/C. Active filtering and inner-parent suppression ───────────────────────

describe("canonical catalog query — active filtering", () => {
  it("queries equipment_models as the canonical base table", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    expect(client.tables).toEqual([EQUIPMENT_MODELS_TABLE]);
    expect(EQUIPMENT_MODELS_TABLE).toBe("equipment_models");
  });

  it("explicitly filters the model's own is_active rather than relying on RLS", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    const eqCalls = client.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["is_active", true] });
  });

  it("explicitly filters the parent manufacturer's is_active", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    const eqCalls = client.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["manufacturer.is_active", true] });
  });

  it("uses an INNER manufacturer embed so an inactive parent drops the base model row", async () => {
    // This is the load-bearing guardrail. A non-inner (left) embed would merely
    // null the manufacturer object while the model row survived — which would
    // leak a model belonging to a deactivated manufacturer.
    expect(CANONICAL_CATALOG_SELECT).toContain("manufacturer:equipment_manufacturers!inner(");

    // And the parent filter must target the embedded relationship, not the base row.
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);
    const parentFilter = client.calls.find(
      (c) => c.method === "eq" && c.args[0] === "manufacturer.is_active"
    );
    expect(parentFilter).toBeDefined();
  });

  it("returns no entry when the inner join has already suppressed the row", async () => {
    // With `!inner` + the parent filter, PostgREST returns no base row at all.
    const client = makeFakeClient(ok([]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("empty");
    expect(result.status === "empty" ? result.entries : null).toEqual([]);
  });

  it("passes the requested club type through as a filter", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client, { clubType: "Putter" });

    const eqCalls = client.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["club_type", "Putter"] });
  });

  it("omits the club_type filter when none is requested", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    const clubTypeFilter = client.calls.find((c) => c.method === "eq" && c.args[0] === "club_type");
    expect(clubTypeFilter).toBeUndefined();
  });
});

// ─── D. Deterministic ordering ────────────────────────────────────────────────

describe("canonical catalog query — deterministic total ordering", () => {
  it("orders by club type in bag order first", async () => {
    const rows = [
      modelRow({ id: "m-putter", club_type: "Putter", catalog_key: "a/putter/v1" }),
      modelRow({ id: "m-driver", club_type: "Driver", catalog_key: "a/driver/v1" }),
      modelRow({ id: "m-wedge", club_type: "Wedge", catalog_key: "a/wedge/v1" }),
      modelRow({ id: "m-iron", club_type: "Iron", catalog_key: "a/iron/v1" }),
    ];
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(rows)));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries.map((e) => e.club_type)).toEqual(["Driver", "Iron", "Wedge", "Putter"]);
  });

  it("exposes bag order matching club_type_enum declaration order", () => {
    expect([...CLUB_TYPE_ORDER]).toEqual(["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]);
  });

  it("orders by manufacturer canonical_name within a club type", async () => {
    const rows = [
      modelRow({ catalog_key: "t/x/v1", manufacturer: manufacturer({ canonical_name: "Titleist" }) }),
      modelRow({ catalog_key: "c/x/v1", manufacturer: manufacturer({ canonical_name: "Callaway" }) }),
      modelRow({ catalog_key: "p/x/v1", manufacturer: manufacturer({ canonical_name: "PING" }) }),
    ];
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(rows)));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries.map((e) => e.manufacturer.canonical_name)).toEqual([
      "Callaway",
      "PING",
      "Titleist",
    ]);
  });

  it("orders by model canonical_name within a manufacturer", async () => {
    const rows = [
      modelRow({ canonical_name: "Zulu", catalog_key: "m/zulu/v1" }),
      modelRow({ canonical_name: "Alpha", catalog_key: "m/alpha/v1" }),
      modelRow({ canonical_name: "Mike", catalog_key: "m/mike/v1" }),
    ];
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(rows)));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries.map((e) => e.canonical_name)).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  it("breaks ties on the globally unique catalog_key, giving a total order", async () => {
    const rows = [
      modelRow({ id: "b", catalog_key: "zzz/same/v2" }),
      modelRow({ id: "a", catalog_key: "aaa/same/v1" }),
    ];
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(rows)));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries.map((e) => e.catalog_key)).toEqual(["aaa/same/v1", "zzz/same/v2"]);
  });

  it("is stable regardless of the order the database returned rows in", async () => {
    const build = (order: number[]) => {
      const rows = [
        modelRow({ club_type: "Driver", canonical_name: "D", catalog_key: "k/d/v1" }),
        modelRow({ club_type: "Putter", canonical_name: "P", catalog_key: "k/p/v1" }),
        modelRow({ club_type: "Iron", canonical_name: "I", catalog_key: "k/i/v1" }),
      ];
      return order.map((i) => rows[i]);
    };

    const first = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(build([0, 1, 2]))));
    const second = await queryCanonicalEquipmentCatalog(makeFakeClient(ok(build([2, 0, 1]))));

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(first.entries.map((e) => e.catalog_key)).toEqual(second.entries.map((e) => e.catalog_key));
  });

  it("does not depend on locale-sensitive string comparison", () => {
    expect(catalogCode).not.toContain("localeCompare");
    expect(catalogCode).not.toContain("Intl.Collator");
  });
});

// ─── E. Putter specs ──────────────────────────────────────────────────────────

describe("canonical catalog query — optional putter specs", () => {
  it("represents an absent putter spec as null without fabricating one", async () => {
    const client = makeFakeClient(ok([modelRow({ putter_specs: null })]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries[0].putter_specs).toBeNull();
  });

  it("keeps a valid putter spec relationship intact", async () => {
    const specs = {
      equipment_model_id: "22222222-2222-4222-8222-222222222222",
      head_shape: "mallet",
      neck_type: "double_bend",
      neck_source_label: "Double Bend",
      toe_hang_class: "face_balanced",
      face_construction: "insert",
      handedness: "both",
      standard_lengths_inches: [33, 34, 35],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const client = makeFakeClient(ok([modelRow({ putter_specs: specs })]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.entries[0].putter_specs).toEqual(specs);
  });

  it("treats a structurally invalid putter-spec relationship as malformed", async () => {
    const client = makeFakeClient(ok([modelRow({ putter_specs: { head_shape: "mallet" } })]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("malformed_data");
  });
});

// ─── F. Result-state distinctions ─────────────────────────────────────────────

describe("canonical catalog query — six distinguishable result states", () => {
  it("1. success with rows", async () => {
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([modelRow()])));
    expect(result.status).toBe("ok");
  });

  it("2. successful zero rows with no club type requested is an empty catalog", async () => {
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])));
    expect(result.status).toBe("empty");
  });

  it("3. zero rows for a requested club type is missing coverage, not empty", async () => {
    const result = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])), { clubType: "Driver" });

    expect(result.status).toBe("missing_coverage");
    if (result.status !== "missing_coverage") return;
    expect(result.clubType).toBe("Driver");
    expect(result.entries).toEqual([]);
  });

  it("distinguishes empty from missing coverage for the same zero-row response", async () => {
    const withoutType = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])));
    const withType = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])), { clubType: "Wedge" });
    expect(withoutType.status).not.toBe(withType.status);
  });

  it("4. HTTP 401 is an auth failure", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "JWT expired" }, status: 401 })
    );
    expect(result.status).toBe("auth_error");
  });

  it("4. HTTP 403 is an auth failure", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "forbidden" }, status: 403 })
    );
    expect(result.status).toBe("auth_error");
  });

  it("4. SQLSTATE 42501 insufficient_privilege is an auth failure", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "permission denied", code: "42501" }, status: 400 })
    );

    expect(result.status).toBe("auth_error");
    if (result.status !== "auth_error") return;
    expect(result.code).toBe("42501");
  });

  it("5. a generic database error is a database failure, not an auth failure", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "relation missing", code: "42P01" }, status: 500 })
    );

    expect(result.status).toBe("database_error");
    if (result.status !== "database_error") return;
    expect(result.code).toBe("42P01");
    expect(result.message).toContain("relation missing");
  });

  it("5. a thrown transport failure is a database failure", async () => {
    const throwing = makeFakeClient((() => {
      throw new Error("network down");
    }) as () => never);
    const result = await queryCanonicalEquipmentCatalog(throwing);

    expect(result.status).toBe("database_error");
    if (result.status !== "database_error") return;
    expect(result.message).toContain("network down");
  });

  it("6. a row missing canonical identity is malformed", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient(ok([modelRow({ catalog_key: "" })]))
    );
    expect(result.status).toBe("malformed_data");
  });

  it("6. a row missing its manufacturer relationship is malformed", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient(ok([modelRow({ manufacturer: null })]))
    );
    expect(result.status).toBe("malformed_data");
  });

  it("6. an unrecognised club_type is malformed", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient(ok([modelRow({ club_type: "Chipper" })]))
    );
    expect(result.status).toBe("malformed_data");
  });

  it("6. a non-array payload is malformed", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: { nope: true }, error: null, status: 200 })
    );
    expect(result.status).toBe("malformed_data");
  });

  it("never reports a database failure as an empty or missing-coverage catalog", async () => {
    const failure = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "boom" }, status: 500 }),
      { clubType: "Putter" }
    );
    expect(failure.status).not.toBe("empty");
    expect(failure.status).not.toBe("missing_coverage");
    expect(failure.status).not.toBe("ok");
  });

  it("all six states are reachable and mutually distinct", async () => {
    const seen = new Set<string>();
    seen.add((await queryCanonicalEquipmentCatalog(makeFakeClient(ok([modelRow()])))).status);
    seen.add((await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])))).status);
    seen.add(
      (await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])), { clubType: "Iron" })).status
    );
    seen.add(
      (await queryCanonicalEquipmentCatalog(makeFakeClient({ data: null, error: { message: "x" }, status: 401 })))
        .status
    );
    seen.add(
      (await queryCanonicalEquipmentCatalog(makeFakeClient({ data: null, error: { message: "x" }, status: 500 })))
        .status
    );
    seen.add((await queryCanonicalEquipmentCatalog(makeFakeClient(ok([modelRow({ id: "" })])))).status);

    expect(seen.size).toBe(6);
  });
});

// ─── G/H/I/J. Structural guarantees ───────────────────────────────────────────

describe("canonical catalog query — no static fallback", () => {
  it("never imports or references the legacy static catalog route", async () => {
    expect(catalogCode).not.toContain("api/equipment");
    expect(catalogCode).not.toMatch(/\bCATALOG\b\s*[:=]/);
  });

  it("returns a failure rather than any rows when the canonical query fails", async () => {
    const result = await queryCanonicalEquipmentCatalog(
      makeFakeClient({ data: null, error: { message: "canonical down" }, status: 500 })
    );

    expect(result.status).toBe("database_error");
    expect(result).not.toHaveProperty("entries");
  });
});

describe("canonical catalog query — read-only", () => {
  it("invokes no write method on the injected client", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    const methods = client.calls.map((c) => c.method);
    for (const write of ["insert", "update", "upsert", "delete", "rpc"]) {
      expect(methods).not.toContain(write);
    }
    expect(new Set(methods)).toEqual(new Set(["from", "select", "eq"]));
  });

  it("contains no write call site in source", () => {
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(catalogCode).not.toContain(write);
    }
  });

  it("never constructs a client and never uses the service-role admin client", () => {
    expect(catalogCode).not.toContain("utils/supabase/admin");
    expect(catalogCode).not.toContain("createAdminClient");
    expect(catalogCode).not.toContain("SERVICE_ROLE");
    expect(catalogCode).not.toContain("createBrowserClient");
    expect(catalogCode).not.toContain("createServerClient");
  });

  it("adds no cache abstraction", () => {
    expect(catalogCode).not.toContain("unstable_cache");
    expect(catalogCode).not.toContain("revalidate");
  });

  it("uses no broad any", () => {
    expect(catalogCode).not.toMatch(/:\s*any\b/);
    expect(catalogCode).not.toMatch(/<\s*any\s*>/);
  });
});

describe("canonical catalog query — sources table exclusion", () => {
  it("never queries equipment_model_sources", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    await queryCanonicalEquipmentCatalog(client);

    expect(client.tables).not.toContain("equipment_model_sources");
    expect(CANONICAL_CATALOG_SELECT).not.toContain("equipment_model_sources");
    expect(catalogCode).not.toContain('from("equipment_model_sources")');
  });
});

describe("canonical catalog query — Custom/Other separation", () => {
  it("returns only real canonical rows, never a Custom/Other sentinel", async () => {
    const client = makeFakeClient(ok([modelRow()]));
    const result = await queryCanonicalEquipmentCatalog(client);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.entries).toHaveLength(1);
    for (const entry of result.entries) {
      expect(entry.id).not.toBe("");
      expect(entry.catalog_key).not.toBe("");
      expect(entry.manufacturer.canonical_name).not.toMatch(/^(Custom|Other|Unknown)$/i);
      expect(entry.canonical_name).not.toMatch(/^(Custom|Other|Unknown)$/i);
    }
  });

  it("adds no sentinel row to an empty or missing-coverage result", async () => {
    const empty = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])));
    const missing = await queryCanonicalEquipmentCatalog(makeFakeClient(ok([])), { clubType: "Driver" });

    expect(empty.status === "empty" ? empty.entries : null).toEqual([]);
    expect(missing.status === "missing_coverage" ? missing.entries : null).toEqual([]);
  });

  it("does not inject Custom/Other sentinels in source", () => {
    expect(catalogCode).not.toMatch(/canonical_name:\s*["'](Custom|Other|Unknown)["']/);
  });
});
