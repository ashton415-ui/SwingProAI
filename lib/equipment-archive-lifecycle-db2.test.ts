/**
 * EQ3-DB2 — the application archive lifecycle for saved equipment.
 *
 * Static source contracts in the established style of this repository's other
 * equipment suites. No jsdom, no Testing Library, no Supabase client, no
 * network. DB1 proved the column exists and is shaped correctly; this suite
 * proves the application uses it, and uses it fail-closed.
 *
 * The product contract under test is one sentence: "Remove from bag" means
 * ARCHIVE. The row survives, because public.swing_analysis.club_id references it
 * with ON DELETE SET NULL behind a trigger that rejects post-insert changes to
 * club_id, and public.swing_telemetry.club_id carries the same referential
 * action with no such guard. A hard delete would either fail outright or
 * silently discard historical per-club attribution.
 *
 * Two things keep these assertions honest rather than self-confirming. First,
 * "must not contain" assertions run against comment-stripped source, because the
 * files under test deliberately discuss delete semantics in prose — an
 * explanation of a prohibition must not be what satisfies the test asserting it.
 * Second, assertions are scoped to the region that owns the behaviour (the
 * archive chain, the update payload literal, one interface body) so a test
 * cannot pass merely because a token appears somewhere else in a large file.
 *
 * Every assertion here fails against the pre-DB2 source: My Bag read every row
 * regardless of lifecycle, the remove handler called
 * `.from("user_equipment").delete()`, neither edit surface filtered on
 * is_archived, the saved-club reader offered archived rows as selectable, and
 * there was no user-visible failure state for a removal at all.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAVED_CLUBS_SELECT, SAVED_CLUBS_TABLE } from "@/lib/equipment/saved-clubs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const NEWLINE = String.fromCharCode(10);

/**
 * Strips TypeScript/JSX comments so "must not contain" assertions describe
 * executable code. String literals are preserved — the user-facing copy and the
 * column names these tests look for live inside them.
 */
function stripTsComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote === null && two === "//") {
      const nl = source.indexOf(NEWLINE, i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (quote === null && two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const c = source[i];
    if (quote !== null) {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
    i += 1;
  }
  return out;
}

const BAG_PAGE = "app/(dashboard)/bag/page.tsx";
const BAG_CLIENT = "app/(dashboard)/bag/BagPageClient.tsx";
const EDIT_PAGE = "app/(dashboard)/bag/[clubId]/edit/page.tsx";
const EDIT_FORM = "app/(dashboard)/bag/[clubId]/edit/EditClubForm.tsx";
const SAVED_CLUBS = "lib/equipment/saved-clubs.ts";
const ADD_FORM = "app/(dashboard)/bag/add/AddClubForm.tsx";

/** The exact copy a golfer sees when a removal does not complete. */
const REMOVE_FAILURE_COPY = "Could not remove this club from your bag. Please try again.";

/**
 * Exactly the columns My Bag may serialize into the browser payload — the
 * ClubRecord fields and nothing else.
 *
 * Transcribed by hand rather than imported or derived from ClubRecord. That is
 * the whole point: an expectation computed from production code would move
 * whenever the production code moved, so a widened projection could change the
 * implementation and its own test in one step. This list has to be edited
 * deliberately, by someone who has decided a new field belongs in the browser.
 */
const MY_BAG_EQUIPMENT_COLUMNS = [
  "id",
  "club_type",
  "club_designation",
  "brand",
  "model",
  "shaft_flex",
  "shaft_weight",
  "loft_deg",
  "custom_club",
  "custom_brand",
  "custom_model",
  "is_primary",
  "created_at",
];

/** Executable source for one file. */
function code(relativePath: string): string {
  return stripTsComments(readSource(relativePath));
}

/**
 * One `.from("<table>")` call chain, ending at whichever comes first: the next
 * `.from(` or the terminating semicolon. Scoping to the chain is what stops a
 * filter or projection belonging to a sibling query — My Bag builds two inside
 * one Promise.all — from satisfying an assertion about this one.
 */
function chainFrom(relativePath: string, table: string, occurrence = 0): string {
  const source = code(relativePath);
  const needle = `.from("${table}")`;
  let start = -1;
  for (let n = 0; n <= occurrence; n += 1) {
    start = source.indexOf(needle, start + 1);
    expect(
      start,
      `${relativePath}: expected at least ${occurrence + 1} query chain(s) on ${table}`
    ).toBeGreaterThan(-1);
  }
  const semicolon = source.indexOf(";", start);
  expect(
    semicolon,
    `${relativePath}: could not locate the end of the ${table} chain`
  ).toBeGreaterThan(start);
  const nextFrom = source.indexOf(".from(", start + needle.length);
  const end = nextFrom === -1 ? semicolon : Math.min(semicolon, nextFrom);
  return source.slice(start, end);
}

/**
 * The comma-separated column names inside one chain's `.select("…")`.
 *
 * A chain with no string-literal select — a wildcard, a bare `select()`, or a
 * computed argument — fails here rather than returning something an exact-list
 * comparison could accidentally satisfy.
 */
function selectedColumns(chain: string, label: string): string[] {
  const match = chain.match(/\.select\(\s*"([^"]*)"\s*\)/);
  expect(match, `${label}: the query must select an explicit string column list`).not.toBeNull();
  const literal = (match as RegExpMatchArray)[1];
  expect(literal, `${label}: a wildcard select is not a payload boundary`).not.toContain("*");
  return literal.split(",").map((name) => name.trim());
}

/** How many times a literal fragment occurs in executable source. */
function occurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

/** One declared interface/type body, isolated from the rest of the file. */
function declarationBody(relativePath: string, opener: string): string {
  const source = readSource(relativePath);
  const start = source.indexOf(opener);
  expect(start, `${relativePath}: could not locate ${opener}`).toBeGreaterThan(-1);
  const end = source.indexOf(`${NEWLINE}}`, start);
  expect(end, `${relativePath}: could not locate the end of ${opener}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ============================================================================
// A. The active bag reader excludes archived clubs.
// ============================================================================

describe("EQ3-DB2 My Bag page — reads only active equipment", () => {
  it("reads the saved-equipment table scoped to the authenticated golfer", () => {
    const chain = chainFrom(BAG_PAGE, "user_equipment");
    expect(chain).toContain('.eq("user_id", session.user.id)');
  });

  it("excludes archived rows at the query boundary", () => {
    const chain = chainFrom(BAG_PAGE, "user_equipment");
    expect(
      chain,
      `${BAG_PAGE}: a removed club must not reach the browser as bag data`
    ).toContain('.eq("is_archived", false)');
  });

  it("preserves the existing created_at ordering", () => {
    expect(chainFrom(BAG_PAGE, "user_equipment")).toContain(
      '.order("created_at", { ascending: true })'
    );
  });

  it("hands the authenticated owner to the client component", () => {
    expect(
      code(BAG_PAGE),
      `${BAG_PAGE}: the archive filter needs an owner the client did not invent`
    ).toContain("userId={session.user.id}");
    expect(code(BAG_PAGE)).toContain("initialClubs={clubs}");
    expect(code(BAG_PAGE)).toContain("initialTelemetry={telemetry}");
  });

  it("names the columns it serializes instead of selecting a wildcard", () => {
    // The load-bearing assertion of this section. `select("*")` returns every
    // column of the row, and the `as ClubRecord[]` cast below it strips nothing
    // at runtime — so a wildcard would ship is_archived and every other
    // database-only column into the browser payload while the TypeScript type
    // claimed otherwise.
    const chain = chainFrom(BAG_PAGE, "user_equipment");
    expect(chain, `${BAG_PAGE}: a wildcard select is not a payload boundary`).not.toContain(
      '.select("*")'
    );
    expect(chain).not.toMatch(/\.select\(\s*\)/);
    expect(selectedColumns(chain, BAG_PAGE)).not.toContain("*");
  });

  it("selects exactly the thirteen ClubRecord columns, in order", () => {
    const chain = chainFrom(BAG_PAGE, "user_equipment");
    const columns = selectedColumns(chain, BAG_PAGE);
    expect(columns).toEqual(MY_BAG_EQUIPMENT_COLUMNS);
    expect(columns).toHaveLength(13);
  });

  it("never serializes the lifecycle flag it filters on", () => {
    const columns = selectedColumns(chainFrom(BAG_PAGE, "user_equipment"), BAG_PAGE);
    expect(
      columns,
      `${BAG_PAGE}: bag lifecycle is a query concern, not browser payload`
    ).not.toContain("is_archived");
  });

  it("never serializes the owner or any other database-only column", () => {
    const columns = selectedColumns(chainFrom(BAG_PAGE, "user_equipment"), BAG_PAGE);
    for (const forbidden of [
      "user_id",
      "equipment_model_id",
      "manufacturer_id",
      "custom_notes",
      "updated_at",
    ]) {
      expect(
        columns,
        `${BAG_PAGE}: "${forbidden}" must not cross the server/client boundary`
      ).not.toContain(forbidden);
    }
  });

  it("adds no archived-equipment surface", () => {
    const source = code(BAG_PAGE);
    for (const forbidden of ["showArchived", "includeArchived", "archivedClubs"]) {
      expect(source, `${BAG_PAGE}: DB2 has no archived-equipment surface`).not.toContain(forbidden);
    }
  });

  it("leaves the telemetry query a read", () => {
    const chain = chainFrom(BAG_PAGE, "swing_telemetry");
    for (const write of [".update(", ".insert(", ".upsert(", ".delete("]) {
      expect(chain, `${BAG_PAGE}: telemetry is read-only here`).not.toContain(write);
    }
  });
});

// ============================================================================
// B. Remove from bag is an archive write, not a delete.
// ============================================================================

describe("EQ3-DB2 My Bag client — removal archives", () => {
  it("performs no hard delete", () => {
    expect(
      code(BAG_CLIENT),
      `${BAG_CLIENT}: removing a club must not delete the row analyses reference`
    ).not.toContain(".delete(");
  });

  it("performs exactly one equipment write, and it is an update", () => {
    const source = code(BAG_CLIENT);
    expect(occurrences(source, ".update(")).toBe(1);
    for (const forbidden of [".insert(", ".upsert(", ".rpc("]) {
      expect(source, `${BAG_CLIENT}: "${forbidden}" is outside the DB2 contract`).not.toContain(
        forbidden
      );
    }
  });

  it("authors exactly one column: is_archived: true", () => {
    const chain = chainFrom(BAG_CLIENT, "user_equipment");
    expect(chain).toContain(".update({ is_archived: true })");
  });

  it("writes no other equipment field, so is_primary survives archiving", () => {
    const chain = chainFrom(BAG_CLIENT, "user_equipment");
    for (const column of [
      "is_primary",
      "club_designation",
      "club_type",
      "loft_deg",
      "shaft_flex",
      "shaft_weight",
      "brand",
      "model",
      "custom_club",
      "custom_brand",
      "custom_model",
      "custom_notes",
      "created_at",
      "updated_at",
    ]) {
      expect(
        chain,
        `${BAG_CLIENT}: archiving must not rewrite "${column}"`
      ).not.toContain(column);
    }
  });

  it("scopes the archive by id, owner and current active state", () => {
    const chain = chainFrom(BAG_CLIENT, "user_equipment");
    expect(chain).toContain('.eq("id", clubId)');
    expect(chain, `${BAG_CLIENT}: the owner filter is defence in depth beside RLS`).toContain(
      '.eq("user_id", userId)'
    );
    expect(
      chain,
      `${BAG_CLIENT}: a second concurrent removal must be a no-op, not a silent success`
    ).toContain('.eq("is_archived", false)');
  });

  it("consumes the owner as a prop rather than establishing a second session authority", () => {
    const source = code(BAG_CLIENT);
    expect(source).toMatch(/userId:\s*string;/);
    expect(source, `${BAG_CLIENT}: the server page is the auth authority`).not.toContain(
      "auth.getUser"
    );
    expect(source).not.toContain("getSession(");
  });

  it("returns the archived row so a zero-row update cannot read as success", () => {
    const chain = chainFrom(BAG_CLIENT, "user_equipment");
    expect(chain).toContain('.select("id")');
    expect(chain).toContain(".maybeSingle()");
  });

  it("treats a zero-row result as failure, not as a completed removal", () => {
    expect(code(BAG_CLIENT)).toMatch(/if\s*\(error\s*\|\|\s*!data\)/);
  });

  it("shows generic copy on failure and keeps database detail out of the UI", () => {
    const source = code(BAG_CLIENT);
    expect(source).toContain(REMOVE_FAILURE_COPY);
    for (const leak of [
      "setRemoveError(error.message)",
      "setRemoveError(error?.message)",
      "setRemoveError(err.message)",
    ]) {
      expect(source, `${BAG_CLIENT}: raw database text must never be rendered`).not.toContain(leak);
    }
    expect(source, `${BAG_CLIENT}: the underlying error may be logged, not displayed`).toContain(
      "console.error"
    );
  });

  it("renders the failure where the golfer is looking", () => {
    const source = code(BAG_CLIENT);
    expect(source).toContain("{removeError}");
    expect(source).toMatch(/removeError\s*&&/);
  });

  it("clears the previous failure when a new removal begins", () => {
    const source = code(BAG_CLIENT);
    const handler = source.slice(source.indexOf("async function handleRemoveClub"));
    const clear = handler.indexOf("setRemoveError(null)");
    const write = handler.indexOf(".update(");
    expect(clear, `${BAG_CLIENT}: a new attempt must not inherit a stale error`).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(write);
  });

  it("survives a thrown transport failure without stranding the bag", () => {
    const source = code(BAG_CLIENT);
    expect(source).toContain("catch (");
    expect(source, `${BAG_CLIENT}: the removing state must be released on every path`).toContain(
      "finally"
    );
    const finallyBlock = source.slice(source.indexOf("finally"));
    expect(finallyBlock).toContain("setRemoving(null)");
  });

  it("hides the club locally only after the database confirmed the archive", () => {
    const source = code(BAG_CLIENT);
    const guard = source.search(/if\s*\(error\s*\|\|\s*!data\)/);
    const localRemoval = source.indexOf("setClubs((prev) => prev.filter(");
    expect(guard, `${BAG_CLIENT}: could not locate the failure guard`).toBeGreaterThan(-1);
    expect(localRemoval, `${BAG_CLIENT}: could not locate the local removal`).toBeGreaterThan(-1);
    expect(
      localRemoval,
      `${BAG_CLIENT}: the club must not be hidden optimistically`
    ).toBeGreaterThan(guard);
    expect(source.slice(guard, localRemoval)).toContain("return;");
  });
});

// ============================================================================
// C. An archived club is not editable through a kept URL.
// ============================================================================

describe("EQ3-DB2 edit route — archived clubs fail closed", () => {
  it("scopes the lookup by id, owner and active state", () => {
    const chain = chainFrom(EDIT_PAGE, "user_equipment");
    expect(chain).toContain('.eq("id", params.clubId)');
    expect(chain).toContain('.eq("user_id", session.user.id)');
    expect(chain).toContain('.eq("is_archived", false)');
    expect(chain).toContain(".maybeSingle()");
  });

  it("does not select the lifecycle column it filters on", () => {
    const chain = chainFrom(EDIT_PAGE, "user_equipment");
    const select = chain.slice(chain.indexOf(".select("), chain.indexOf('.eq("id"'));
    expect(select, `${EDIT_PAGE}: the form neither reads nor writes is_archived`).not.toContain(
      "is_archived"
    );
  });

  it("discloses no difference between missing, foreign and archived", () => {
    const source = code(EDIT_PAGE);
    expect(source).toContain("if (!club) notFound();");
    for (const leak of ["archived", "Archived", "isArchived"]) {
      expect(
        source.replace(/is_archived/g, ""),
        `${EDIT_PAGE}: an archived club must look exactly like a missing one`
      ).not.toContain(leak);
    }
  });
});

// ============================================================================
// D. A stale edit cannot write onto an archived row.
// ============================================================================

describe("EQ3-DB2 edit form — archive race guard", () => {
  it("still performs exactly one user_equipment update", () => {
    const source = code(EDIT_FORM);
    expect(occurrences(source, ".update(")).toBe(1);
    expect(source).toContain('.from("user_equipment")');
  });

  it("scopes the update by id, owner and active state", () => {
    const chain = chainFrom(EDIT_FORM, "user_equipment");
    expect(chain).toContain('.eq("id", club.id)');
    expect(chain).toContain('.eq("user_id", userId)');
    expect(
      chain,
      `${EDIT_FORM}: a Save on a club archived elsewhere must affect zero rows`
    ).toContain('.eq("is_archived", false)');
    expect(chain).toContain('.select("id")');
    expect(chain).toContain(".maybeSingle()");
  });

  it("keeps the writable payload at exactly the five fitting fields", () => {
    const body = declarationBody(EDIT_FORM, "type UserEquipmentUpdate = {");
    const keys = body
      .split(NEWLINE)
      .map((line) => line.match(/^\s{2}([a-z_]+):/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
    expect(keys).toEqual([
      "club_designation",
      "loft_deg",
      "shaft_flex",
      "shaft_weight",
      "is_primary",
    ]);
  });

  it("never makes the lifecycle column writable from the edit form", () => {
    expect(declarationBody(EDIT_FORM, "type UserEquipmentUpdate = {")).not.toContain("is_archived");
    const payloadStart = code(EDIT_FORM).indexOf("const payload: UserEquipmentUpdate = {");
    const payload = code(EDIT_FORM).slice(payloadStart, code(EDIT_FORM).indexOf("};", payloadStart));
    expect(
      payload,
      `${EDIT_FORM}: only the removal surface may change is_archived`
    ).not.toContain("is_archived");
  });

  it("reuses the existing generic failure path", () => {
    expect(code(EDIT_FORM)).toContain("Could not update this club. Please try again.");
  });
});

// ============================================================================
// E. The shared selector offers only active clubs.
// ============================================================================

describe("EQ3-DB2 saved-club reader — excludes archived rows", () => {
  it("reads the saved-equipment table", () => {
    expect(SAVED_CLUBS_TABLE).toBe("user_equipment");
  });

  it("keeps the explicit nine-column select unchanged", () => {
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

  it("filters on the lifecycle column without selecting it", () => {
    expect(SAVED_CLUBS_SELECT).not.toContain("is_archived");
    const source = code(SAVED_CLUBS);
    expect(source).toContain('.eq("user_id", userId)');
    expect(
      source,
      `${SAVED_CLUBS}: an archived club must never be offered as selectable`
    ).toContain('.eq("is_archived", false)');
  });

  it("excludes archived rows in the query, not after mapping", () => {
    const source = code(SAVED_CLUBS);
    const query = source.slice(source.indexOf(".from(SAVED_CLUBS_TABLE)"));
    expect(query.slice(0, query.indexOf(";"))).toContain('.eq("is_archived", false)');
    expect(
      source,
      `${SAVED_CLUBS}: lifecycle must not be re-checked against the row payload`
    ).not.toContain("raw.is_archived");
  });

  it("keeps SelectableClub at exactly its four keys", () => {
    const body = declarationBody(SAVED_CLUBS, "export interface SelectableClub {");
    const keys = body
      .split(NEWLINE)
      .map((line) => line.match(/^\s{2}([A-Za-z_]+):/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
    expect(keys).toEqual(["id", "clubType", "displayName", "isPrimary"]);
    expect(body).not.toContain("isArchived");
    expect(body).not.toContain("is_archived");
  });

  it("remains read-only", () => {
    const source = code(SAVED_CLUBS);
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(source, `${SAVED_CLUBS}: the reader stays a reader`).not.toContain(write);
    }
  });
});

// ============================================================================
// F. Adding a club creates a new active row. It never restores an archived one.
// ============================================================================

describe("EQ3-DB2 Add Club — creates, never restores", () => {
  it("still performs a plain insert", () => {
    const source = code(ADD_FORM);
    expect(source).toContain('.from("user_equipment").insert(payload)');
    expect(occurrences(source, ".insert(")).toBe(1);
  });

  it("performs no update, upsert or delete", () => {
    const source = code(ADD_FORM);
    for (const forbidden of [".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(
        source,
        `${ADD_FORM}: re-adding a club creates a new row, it does not revive an old one`
      ).not.toContain(forbidden);
    }
  });

  it("never mentions the lifecycle column at all", () => {
    // The database default makes a new row active. Naming the column here would
    // be the first step toward restore semantics DB2 deliberately does not have.
    expect(code(ADD_FORM)).not.toContain("is_archived");
    for (const forbidden of ["restore", "unarchive", "Unarchive", "reactivate"]) {
      expect(code(ADD_FORM)).not.toContain(forbidden);
    }
  });

  it("does not look for an archived duplicate before inserting", () => {
    const source = code(ADD_FORM);
    expect(source).not.toContain(".maybeSingle()");
    expect(source).not.toContain("existing");
  });
});

// ============================================================================
// G. DB2 authors no snapshot and changes no analysis or telemetry row.
// ============================================================================

describe("EQ3-DB2 — writes nothing the database owns", () => {
  const WRITE_SURFACES = [BAG_CLIENT, EDIT_FORM, ADD_FORM];

  for (const file of WRITE_SURFACES) {
    it(`${file} authors no snapshot and no derived classification`, () => {
      const source = code(file);
      for (const forbidden of [
        "equipment_snapshot",
        "analysis_family",
        "schema_version",
        "swing_analysis",
        "swing_telemetry",
      ]) {
        expect(source, `${file}: "${forbidden}" is database-owned`).not.toContain(forbidden);
      }
    });
  }

  it("changes no equipment catalog table", () => {
    for (const file of WRITE_SURFACES) {
      const source = code(file);
      for (const table of [
        "equipment_models",
        "equipment_manufacturers",
        "equipment_putter_model_specs",
        "equipment_model_sources",
      ]) {
        expect(source).not.toContain(`.from("${table}")`);
      }
    }
  });
});

// ============================================================================
// H. DB2 is not DB3. It changes no privilege.
// ============================================================================

describe("EQ3-DB2 — no privilege or migration work", () => {
  const DB2_FILES = [BAG_PAGE, BAG_CLIENT, EDIT_PAGE, EDIT_FORM, SAVED_CLUBS, ADD_FORM];

  for (const file of DB2_FILES) {
    it(`${file} contains no privilege SQL`, () => {
      const source = code(file).toLowerCase();
      for (const forbidden of [
        "revoke ",
        "grant ",
        "alter default privileges",
        "row level security",
        "create policy",
        "drop policy",
        "alter table",
      ]) {
        expect(
          source,
          `${file}: revoking DELETE is EQ3-DB3's job, after DB2 is live`
        ).not.toContain(forbidden);
      }
    });
  }

  it("adds no migration and no service-role client", () => {
    for (const file of DB2_FILES) {
      const source = code(file);
      expect(source).not.toContain("supabase/migrations");
      for (const forbidden of ["SERVICE_ROLE", "service_role", "serviceRole"]) {
        expect(source, `${file}: RLS remains the authority`).not.toContain(forbidden);
      }
    }
  });
});
