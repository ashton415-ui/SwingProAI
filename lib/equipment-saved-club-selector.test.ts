import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  querySavedClubs,
  SAVED_CLUBS_TABLE,
  SAVED_CLUBS_SELECT,
  CLUB_TYPE_ORDER,
  type SelectableClub,
  type SavedClubsPostgrestResponse,
  type SavedClubsSupabaseClient,
} from "@/lib/equipment/saved-clubs";

/**
 * Slice 2 — shared saved-club selector foundation.
 *
 * Behavioural tests against an injected fake client, plus a smaller number of
 * source-contract assertions for guarantees that are structural rather than
 * observable at runtime (no write methods, no client construction, no catalog
 * join, and the presentational component's markup contract). No live Supabase
 * connection is made — consistent with every other suite in lib/.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const SAVED_CLUBS_MODULE = "lib/equipment/saved-clubs.ts";
const CLUB_SELECTOR_MODULE = "components/equipment/ClubSelector.tsx";

const savedClubsSource = readSource(SAVED_CLUBS_MODULE);
const clubSelectorSource = readSource(CLUB_SELECTOR_MODULE);

/**
 * Executable source with comments removed.
 *
 * The negative structural assertions below ask "does the code do X?", not "does
 * the file ever mention X?" — and both modules deliberately document the things
 * they must never do (catalog joins, the service-role client, locale-sensitive
 * comparison, auto-selection). Scanning raw text would therefore fail on the
 * very comments that document the guarantee. Stripping comments makes each
 * assertion test the guarantee it claims to test.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const savedClubsCode = stripComments(savedClubsSource);
const clubSelectorCode = stripComments(clubSelectorSource);

// ─── Fake client ──────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface FakeClient extends SavedClubsSupabaseClient {
  calls: RecordedCall[];
  tables: string[];
}

/**
 * Records every builder call so tests can assert the exact query contract, and
 * resolves to the supplied PostgREST response. Any method the module does not
 * legitimately use is simply absent — calling one would throw, which is itself
 * a guardrail.
 */
function makeFakeClient(response: SavedClubsPostgrestResponse | (() => never)): FakeClient {
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
    then(
      onFulfilled: (value: SavedClubsPostgrestResponse) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) {
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
      return builder as unknown as ReturnType<SavedClubsSupabaseClient["from"]>;
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-4111-8111-111111111111";

const ID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const ID_C = "cccccccc-1111-4111-8111-cccccccccccc";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID_A,
    club_type: "Driver",
    club_designation: null,
    brand: "PING",
    model: "G430",
    custom_club: false,
    custom_brand: null,
    custom_model: null,
    is_primary: false,
    ...overrides,
  };
}

function ok(data: unknown): SavedClubsPostgrestResponse {
  return { data, error: null, status: 200 };
}

async function clubsFor(rows: unknown[]): Promise<SelectableClub[]> {
  const result = await querySavedClubs(makeFakeClient(ok(rows)), { userId: USER_ID });
  expect(result.status).toBe("ok");
  return result.status === "ok" ? result.clubs : [];
}

async function displayNameFor(overrides: Record<string, unknown>): Promise<string> {
  const clubs = await clubsFor([row(overrides)]);
  expect(clubs).toHaveLength(1);
  return clubs[0].displayName;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("saved-club query — table and column contract", () => {
  it("reads exactly the saved-equipment table", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    expect(SAVED_CLUBS_TABLE).toBe("user_equipment");
    expect(client.tables).toEqual(["user_equipment"]);
  });

  it("uses an explicit select list", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    const select = client.calls.find((c) => c.method === "select");
    expect(select, "the query must call select() with an explicit column list").toBeDefined();
    expect(select?.args[0]).toBe(SAVED_CLUBS_SELECT);
  });

  it("selects exactly the nine source columns the DTO is built from", () => {
    expect(SAVED_CLUBS_SELECT.split(",")).toEqual([
      "id",
      "club_type",
      "club_designation",
      "brand",
      "model",
      "custom_club",
      "custom_brand",
      "custom_model",
      "is_primary",
    ]);
  });

  it("never uses a wildcard select", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    expect(SAVED_CLUBS_SELECT).not.toContain("*");
    for (const call of client.calls) {
      expect(call.args).not.toContain("*");
    }
    expect(savedClubsCode).not.toContain('select("*")');
  });

  it("never selects the owner column, the catalog references, fittings or timestamps", () => {
    for (const forbidden of [
      "user_id",
      "equipment_model_id",
      "manufacturer_id",
      "shaft_flex",
      "shaft_weight",
      "loft_deg",
      "custom_notes",
      "created_at",
      "updated_at",
    ]) {
      expect(
        SAVED_CLUBS_SELECT.split(","),
        `"${forbidden}" must not be selected as payload`
      ).not.toContain(forbidden);
    }
  });

  it("filters by the supplied owner as defence in depth alongside RLS", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    const eqCalls = client.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toHaveLength(1);
    expect(eqCalls[0].args).toEqual(["user_id", USER_ID]);
  });
});

describe("saved-club query — unusable owner id fails closed before any query", () => {
  for (const [label, userId] of [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a padded uuid", ` ${USER_ID} `],
    ["a non-uuid string", "not-a-uuid"],
    ["a truncated uuid", "11111111-1111-4111-8111"],
  ] as const) {
    it(`returns auth_error and makes no client call for ${label}`, async () => {
      const client = makeFakeClient(ok([row()]));
      const result = await querySavedClubs(client, { userId });

      expect(result.status).toBe("auth_error");
      expect(result.clubs).toEqual([]);
      expect(client.calls, "no query may run for an unusable owner id").toEqual([]);
      expect(client.tables).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Mapping and identity
// ═══════════════════════════════════════════════════════════════════════════════

describe("saved-club query — every saved row shape stays selectable", () => {
  it("maps a canonical-style saved row using its readable snapshot, with no catalog linkage needed", async () => {
    const clubs = await clubsFor([
      row({ id: ID_A, club_type: "Driver", brand: "Titleist", model: "GT3", is_primary: true }),
    ]);

    expect(clubs[0]).toEqual({
      id: ID_A,
      clubType: "Driver",
      displayName: "Titleist GT3",
      isPrimary: true,
    });
  });

  it("maps a legacy row with no canonical linkage exactly the same way", async () => {
    const clubs = await clubsFor([row({ brand: "PING", model: "G430" })]);
    expect(clubs[0].displayName).toBe("PING G430");
  });

  it("maps a Custom / Other row", async () => {
    const clubs = await clubsFor([
      row({ custom_club: true, brand: null, model: null, custom_brand: "Acme", custom_model: "Prototype" }),
    ]);
    expect(clubs[0].displayName).toBe("Acme Prototype");
  });

  it("returns exactly the four DTO keys and nothing else", async () => {
    const clubs = await clubsFor([row()]);
    expect(Object.keys(clubs[0]).sort()).toEqual(["clubType", "displayName", "id", "isPrimary"]);
  });

  it("keeps club_designation a source column, never a DTO key", async () => {
    const clubs = await clubsFor([row({ club_type: "Iron", club_designation: "7I" })]);

    expect(clubs[0].displayName).toBe("7I · PING G430");
    expect(
      clubs[0],
      "the designation reaches the consumer inside the name, not as a second field"
    ).not.toHaveProperty("club_designation");
    expect(clubs[0]).not.toHaveProperty("clubDesignation");
    expect(Object.keys(clubs[0]).sort()).toEqual(["clubType", "displayName", "id", "isPrimary"]);
  });

  it("leaks no owner, raw identity or catalog field into the DTO", async () => {
    const clubs = await clubsFor([
      // Extra fields the query does not request are ignored even if present.
      row({ user_id: USER_ID, equipment_model_id: ID_B, manufacturer_id: ID_C, custom_club: true, custom_brand: "Acme" }),
    ]);

    for (const forbidden of [
      "userId",
      "user_id",
      "brand",
      "model",
      "customBrand",
      "custom_brand",
      "customModel",
      "custom_model",
      "isCustom",
      "custom_club",
      "isCanonical",
      "equipmentModelId",
      "equipment_model_id",
      "manufacturerId",
      "manufacturer_id",
    ]) {
      expect(clubs[0], `"${forbidden}" must not survive into SelectableClub`).not.toHaveProperty(forbidden);
    }
  });
});

describe("saved-club query — display-name precedence", () => {
  it("prefers the custom brand over the legacy brand", async () => {
    expect(
      await displayNameFor({ custom_club: true, custom_brand: "Acme", brand: "PING", custom_model: "Prototype" })
    ).toBe("Acme Prototype");
  });

  it("falls back to the legacy brand when the custom brand is null", async () => {
    expect(
      await displayNameFor({ custom_club: true, custom_brand: null, brand: "PING", custom_model: "Prototype" })
    ).toBe("PING Prototype");
  });

  it('falls back to "Custom" when neither brand source is present', async () => {
    expect(
      await displayNameFor({ custom_club: true, custom_brand: null, brand: null, custom_model: null, model: null })
    ).toBe("Custom");
  });

  it("prefers the custom model over the legacy model", async () => {
    expect(
      await displayNameFor({ custom_club: true, custom_brand: "Acme", custom_model: "Prototype", model: "G430" })
    ).toBe("Acme Prototype");
  });

  it("falls back to the legacy model when the custom model is null", async () => {
    expect(
      await displayNameFor({ custom_club: true, custom_brand: "Acme", custom_model: null, model: "G430" })
    ).toBe("Acme G430");
  });

  it("concatenates and trims a non-custom identity", async () => {
    expect(await displayNameFor({ brand: "PING", model: null })).toBe("PING");
    expect(await displayNameFor({ brand: null, model: "G430" })).toBe("G430");
  });

  it("falls back to the club type when a non-custom row carries no identity text", async () => {
    expect(await displayNameFor({ club_type: "Iron", brand: null, model: null })).toBe("Iron");
    expect(await displayNameFor({ club_type: "Putter", brand: "", model: "" })).toBe("Putter");
  });

  it("never invents a manufacturer or model", () => {
    expect(savedClubsCode).not.toMatch(/displayName:\s*["'](Unknown|Unbranded|N\/A)["']/);
    expect(savedClubsCode).not.toContain("Unknown");
  });
});

describe("saved-club query — designation-first naming", () => {
  it("leads the name with a designation the row legally carries", async () => {
    expect(await displayNameFor({ club_type: "Iron", club_designation: "7I" })).toBe(
      "7I · PING G430"
    );
    expect(
      await displayNameFor({ club_type: "Wood", club_designation: "3W", model: "G430 Max" })
    ).toBe("3W · PING G430 Max");
    expect(
      await displayNameFor({ club_type: "Wedge", club_designation: "SW", model: "Glide 4.0" })
    ).toBe("SW · PING Glide 4.0");
    expect(await displayNameFor({ club_type: "Hybrid", club_designation: "4H" })).toBe(
      "4H · PING G430"
    );
  });

  it("leaves an undesignated row named exactly as it was before D4", async () => {
    const name = await displayNameFor({ club_type: "Iron", club_designation: null });
    expect(name).toBe("PING G430");
    expect(name).not.toContain("·");
  });

  it("leads a custom row the same way", async () => {
    expect(
      await displayNameFor({
        club_type: "Wedge",
        club_designation: "LW",
        custom_club: true,
        brand: null,
        model: null,
        custom_brand: "Acme",
        custom_model: "Prototype",
      })
    ).toBe("LW · Acme Prototype");
  });

  it("still falls back to the club type when a designated row has no identity text", async () => {
    expect(
      await displayNameFor({ club_type: "Iron", club_designation: "9I", brand: null, model: null })
    ).toBe("9I · Iron");
  });

  it("builds the name from the shared helper rather than a second local copy", () => {
    expect(savedClubsCode).toContain(
      'from "@/lib/equipment/club-display-name"'
    );
    expect(savedClubsCode).toContain("getClubDisplayName");
    expect(
      savedClubsCode,
      `${SAVED_CLUBS_MODULE}: the separator belongs to the shared helper alone`
    ).not.toContain('" · "');
    expect(
      savedClubsCode,
      `${SAVED_CLUBS_MODULE}: a second display-name implementation would diverge from My Bag`
    ).not.toContain("deriveDisplayName");
  });

  it("delegates compatibility to the D1-derived helper", () => {
    expect(savedClubsCode).toContain("isClubDesignationValidFor");
    for (const token of ["2W", "3W", "1H", "7I", "9I", "PW", "AW", "GW", "SW", "LW"]) {
      expect(
        savedClubsCode,
        `${SAVED_CLUBS_MODULE}: "${token}" must not be transcribed here`
      ).not.toContain(`"${token}"`);
    }
  });
});

describe("saved-club query — an illegal designation fails the read closed", () => {
  for (const [label, override] of [
    ["a non-string designation", { club_type: "Iron", club_designation: 7 }],
    ["an object designation", { club_type: "Iron", club_designation: {} }],
    ["an empty-string designation", { club_type: "Iron", club_designation: "" }],
    ["a whitespace designation", { club_type: "Iron", club_designation: " " }],
    ["a designation outside the vocabulary", { club_type: "Iron", club_designation: "13I" }],
    ["a differently cased designation", { club_type: "Iron", club_designation: "7i" }],
    ["a wood designation on an iron", { club_type: "Iron", club_designation: "3W" }],
    ["an iron designation on a wood", { club_type: "Wood", club_designation: "7I" }],
    ["a wedge designation on a hybrid", { club_type: "Hybrid", club_designation: "SW" }],
    ["any designation on a driver", { club_type: "Driver", club_designation: "3W" }],
    ["any designation on a putter", { club_type: "Putter", club_designation: "PW" }],
  ] as const) {
    it(`reports ${label} as malformed_data`, async () => {
      const result = await querySavedClubs(
        makeFakeClient(ok([row(override as Record<string, unknown>)])),
        { userId: USER_ID }
      );

      expect(
        result,
        "an impossible designation must not be repaired, dropped or silently renamed"
      ).toEqual({ status: "malformed_data", clubs: [] });
    });
  }

  it("rejects the whole read when only a later row carries an illegal designation", async () => {
    const result = await querySavedClubs(
      makeFakeClient(
        ok([
          row({ id: ID_A, club_type: "Iron", club_designation: "7I" }),
          row({ id: ID_B, club_type: "Iron", club_designation: "3W" }),
        ])
      ),
      { userId: USER_ID }
    );

    expect(result.status).toBe("malformed_data");
    expect(result.clubs).toEqual([]);
  });

  it("never rewrites an unexpected designation into a guess", () => {
    expect(savedClubsCode).not.toMatch(/club_designation\s*=\s*["']/);
    for (const forbidden of ["toUpperCase", "toLowerCase", "replace(", "fallbackDesignation"]) {
      expect(
        savedClubsCode,
        `${SAVED_CLUBS_MODULE}: "${forbidden}" would repair rather than reject`
      ).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe("saved-club query — deterministic total ordering", () => {
  it("orders club types in bag order", async () => {
    const clubs = await clubsFor([
      row({ id: ID_A, club_type: "Putter", brand: "Odyssey", model: "Ai-ONE" }),
      row({ id: ID_B, club_type: "Driver", brand: "PING", model: "G430" }),
      row({ id: ID_C, club_type: "Iron", brand: "Mizuno", model: "JPX" }),
    ]);

    expect(clubs.map((c) => c.clubType)).toEqual(["Driver", "Iron", "Putter"]);
    expect(CLUB_TYPE_ORDER).toEqual(["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]);
  });

  it("places the primary club first within its club type", async () => {
    const clubs = await clubsFor([
      row({ id: ID_A, club_type: "Driver", brand: "AAA", model: "one", is_primary: false }),
      row({ id: ID_B, club_type: "Driver", brand: "ZZZ", model: "two", is_primary: true }),
    ]);

    expect(clubs.map((c) => c.isPrimary)).toEqual([true, false]);
    expect(clubs[0].displayName).toBe("ZZZ two");
  });

  it("orders by display name within an equal club type and primary group", async () => {
    const clubs = await clubsFor([
      row({ id: ID_C, club_type: "Wedge", brand: "Zulu", model: "60" }),
      row({ id: ID_A, club_type: "Wedge", brand: "Alpha", model: "56" }),
      row({ id: ID_B, club_type: "Wedge", brand: "Mike", model: "52" }),
    ]);

    expect(clubs.map((c) => c.displayName)).toEqual(["Alpha 56", "Mike 52", "Zulu 60"]);
  });

  it("breaks a full tie on id", async () => {
    const clubs = await clubsFor([
      row({ id: ID_C, club_type: "Iron", brand: "PING", model: "G430" }),
      row({ id: ID_A, club_type: "Iron", brand: "PING", model: "G430" }),
      row({ id: ID_B, club_type: "Iron", brand: "PING", model: "G430" }),
    ]);

    expect(clubs.map((c) => c.id)).toEqual([ID_A, ID_B, ID_C]);
  });

  it("produces identical output regardless of the order the database returned rows in", async () => {
    const rows = [
      row({ id: ID_A, club_type: "Wedge", brand: "Alpha", model: "56" }),
      row({ id: ID_B, club_type: "Driver", brand: "PING", model: "G430", is_primary: true }),
      row({ id: ID_C, club_type: "Driver", brand: "AAA", model: "old" }),
    ];

    const forward = await clubsFor(rows);
    const reversed = await clubsFor([...rows].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.map((c) => c.id)).toEqual([ID_B, ID_C, ID_A]);
  });

  it("uses no locale-sensitive comparison", () => {
    expect(savedClubsCode).not.toContain("localeCompare");
    expect(savedClubsCode).not.toContain("Intl.Collator");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Result states
// ═══════════════════════════════════════════════════════════════════════════════

describe("saved-club query — five distinguishable result states", () => {
  it("reports an empty bag as empty, never as a failure", async () => {
    const result = await querySavedClubs(makeFakeClient(ok([])), { userId: USER_ID });
    expect(result).toEqual({ status: "empty", clubs: [] });
  });

  for (const [label, response] of [
    ["HTTP 401", { data: null, error: { message: "unauthorized" }, status: 401 }],
    ["HTTP 403", { data: null, error: { message: "forbidden" }, status: 403 }],
    ["SQLSTATE 42501", { data: null, error: { message: "permission denied", code: "42501" }, status: 400 }],
  ] as const) {
    it(`classifies ${label} as auth_error`, async () => {
      const result = await querySavedClubs(makeFakeClient(response), { userId: USER_ID });
      expect(result).toEqual({ status: "auth_error", clubs: [] });
    });
  }

  it("classifies any other database error as database_error", async () => {
    const result = await querySavedClubs(
      makeFakeClient({ data: null, error: { message: "saved clubs down", code: "08006" }, status: 500 }),
      { userId: USER_ID }
    );
    expect(result).toEqual({ status: "database_error", clubs: [] });
  });

  it("classifies a transport-level throw as database_error", async () => {
    const result = await querySavedClubs(
      makeFakeClient(() => {
        throw new Error("socket hang up");
      }),
      { userId: USER_ID }
    );
    expect(result).toEqual({ status: "database_error", clubs: [] });
  });

  it("never surfaces raw database error detail", async () => {
    const result = await querySavedClubs(
      makeFakeClient({
        data: null,
        error: { message: "relation does not exist", code: "42P01", details: "d", hint: "h" },
        status: 500,
      }),
      { userId: USER_ID }
    );

    expect(JSON.stringify(result)).not.toContain("relation does not exist");
    expect(JSON.stringify(result)).not.toContain("42P01");
    expect(result).not.toHaveProperty("message");
    expect(result).not.toHaveProperty("code");
  });

  it("reports a non-array payload as malformed_data", async () => {
    const result = await querySavedClubs(makeFakeClient(ok({ rows: [] })), { userId: USER_ID });
    expect(result).toEqual({ status: "malformed_data", clubs: [] });
  });

  for (const [label, override] of [
    ["a missing id", { id: undefined }],
    ["an empty id", { id: "" }],
    ["an unknown club type", { club_type: "Chipper" }],
    ["a non-boolean custom_club", { custom_club: "false" }],
    ["a non-boolean is_primary", { is_primary: 1 }],
    ["a non-string brand", { brand: 42 }],
    ["a non-string custom_model", { custom_club: true, custom_model: {} }],
  ] as const) {
    it(`reports ${label} as malformed_data`, async () => {
      const result = await querySavedClubs(makeFakeClient(ok([row(override)])), { userId: USER_ID });
      expect(result).toEqual({ status: "malformed_data", clubs: [] });
    });
  }

  it("returns no partial list when a later row is malformed", async () => {
    const result = await querySavedClubs(
      makeFakeClient(ok([row({ id: ID_A }), row({ id: ID_B, club_type: "Chipper" })])),
      { userId: USER_ID }
    );

    expect(result.status).toBe("malformed_data");
    expect(result.clubs).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structural guarantees — saved-club query
// ═══════════════════════════════════════════════════════════════════════════════

describe("saved-club query — read-only and self-contained", () => {
  it("invokes no write method on the injected client", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    const methods = client.calls.map((c) => c.method);
    for (const write of ["insert", "update", "upsert", "delete", "rpc"]) {
      expect(methods).not.toContain(write);
    }
    expect(new Set(methods)).toEqual(new Set(["from", "select", "eq"]));
  });

  it("contains no write call site in source", () => {
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(savedClubsCode).not.toContain(write);
    }
  });

  it("never constructs a client and never uses the service-role admin client", () => {
    expect(savedClubsCode).not.toContain("utils/supabase/client");
    expect(savedClubsCode).not.toContain("utils/supabase/server");
    expect(savedClubsCode).not.toContain("utils/supabase/admin");
    expect(savedClubsCode).not.toContain("createClient");
    expect(savedClubsCode).not.toContain("createBrowserClient");
    expect(savedClubsCode).not.toContain("createServerClient");
    expect(savedClubsCode).not.toContain("SERVICE_ROLE");
  });

  it("never reads a canonical catalog table", async () => {
    const client = makeFakeClient(ok([row()]));
    await querySavedClubs(client, { userId: USER_ID });

    for (const table of [
      "equipment_models",
      "equipment_manufacturers",
      "equipment_putter_model_specs",
      "equipment_model_sources",
    ]) {
      expect(client.tables).not.toContain(table);
      expect(savedClubsCode).not.toContain(table);
      expect(SAVED_CLUBS_SELECT).not.toContain(table);
    }
  });

  it("depends on no API route and no static catalog", () => {
    expect(savedClubsCode).not.toContain("api/equipment");
    expect(savedClubsCode).not.toContain("fetch(");
    expect(savedClubsCode).not.toMatch(/\bCATALOG\b\s*[:=]/);
    expect(savedClubsCode).not.toContain("equipment_catalog");
  });

  it("uses no broad any", () => {
    expect(savedClubsCode).not.toMatch(/:\s*any\b/);
    expect(savedClubsCode).not.toMatch(/<\s*any\s*>/);
  });

  it("introduces no historical matching or backfill logic", () => {
    for (const forbidden of ["backfill", "normalizeBrand", "matchLegacy", "fuzzy", "levenshtein"]) {
      expect(savedClubsCode).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structural guarantees — shared selector component
// ═══════════════════════════════════════════════════════════════════════════════

describe("ClubSelector — presentational contract", () => {
  it("is a client component that type-imports the shared DTO", () => {
    expect(clubSelectorSource.startsWith('"use client";')).toBe(true);
    expect(clubSelectorSource).toContain(
      'import type { SelectableClub } from "@/lib/equipment/saved-clubs"'
    );
  });

  it("renders a labelled native select with club-type groups", () => {
    expect(clubSelectorCode).toContain("<select");
    expect(clubSelectorCode).toContain("<label");
    expect(clubSelectorCode).toContain("htmlFor=");
    expect(clubSelectorCode).toContain("<optgroup");
    expect(clubSelectorCode).toContain("<option");
  });

  it("is controlled by selectedClubId and maps the empty option back to null", () => {
    expect(clubSelectorCode).toContain("value={selectedClubId ?? NO_SELECTION_VALUE}");
    expect(clubSelectorCode).toContain("onChange(value === NO_SELECTION_VALUE ? null : value)");
  });

  it("never auto-selects a club", () => {
    for (const pattern of ["clubs[0]", "find((c) => c.isPrimary)", "isPrimary)?.id", "defaultValue"]) {
      expect(clubSelectorCode, `"${pattern}" would choose a club the golfer did not`).not.toContain(pattern);
    }
  });

  it("indicates the primary club with text only, and adds no other badge", () => {
    expect(clubSelectorCode).toContain("— Primary");
    for (const badge of ["Canonical", "isCanonical", "isCustom", "Custom /", "badge", "Badge"]) {
      expect(clubSelectorCode).not.toContain(badge);
    }
  });

  it("handles the empty bag explicitly and disables the control", () => {
    expect(clubSelectorCode).toContain("emptyMessage");
    expect(clubSelectorCode).toContain("const hasClubs = clubs.length > 0");
    expect(clubSelectorCode).toContain("disabled || !hasClubs");
  });

  it("has defaults of allowEmpty true and label Club", () => {
    expect(clubSelectorCode).toContain("allowEmpty = true");
    expect(clubSelectorCode).toContain('label = "Club"');
  });

  it("performs no data access and no business logic", () => {
    // `.from("` targets a table query specifically — a blanket `.from(` would
    // flag the idiomatic `Array.from(...)` used to materialise the groups.
    for (const forbidden of [
      "supabase",
      "Supabase",
      '.from("',
      ".from('",
      "fetch(",
      "api/equipment",
      "querySavedClubs",
      "subscription",
      "SubscriptionTier",
      "analysis_family",
      "club_id",
      "equipment_model_id",
      "swing_analysis",
    ]) {
      expect(clubSelectorCode, `ClubSelector must not reference "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("introduces no width floor, viewport hack or zoom restriction", () => {
    expect(clubSelectorCode).not.toContain("min-w-[");
    expect(clubSelectorCode).not.toContain("w-screen");
    expect(clubSelectorCode).not.toContain("overflow-x-hidden");
    expect(clubSelectorCode).not.toContain("maximumScale");
    expect(clubSelectorCode).not.toContain("user-scalable=no");
    expect(clubSelectorCode).toContain("w-full");
    expect(clubSelectorCode).toContain("min-h-11");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Slice boundaries
// ═══════════════════════════════════════════════════════════════════════════════

describe("EQC2 — slice boundaries hold", () => {
  it("neither new module reaches into Analyze, Bag, the equipment API or the Python catalog", () => {
    for (const [label, code] of [
      [SAVED_CLUBS_MODULE, savedClubsCode],
      [CLUB_SELECTOR_MODULE, clubSelectorCode],
    ] as const) {
      for (const forbidden of [
        "(dashboard)/analyze",
        "(dashboard)/bag",
        "app/api/equipment",
        "ai-backend",
        "equipment_catalog.py",
        "VirtualBag",
      ]) {
        expect(code, `${label} must not depend on "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it("the canonical catalog reader is a separate module this slice does not import", () => {
    expect(savedClubsCode).not.toContain("queryCanonicalEquipmentCatalog");
    expect(savedClubsCode).not.toContain("lib/equipment/catalog");
    expect(clubSelectorCode).not.toContain("queryCanonicalEquipmentCatalog");
  });
});
