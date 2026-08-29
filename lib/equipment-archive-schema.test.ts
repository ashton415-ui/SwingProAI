/**
 * EQ3-DB1 — equipment archive lifecycle schema foundation.
 *
 * A static source-contract suite over the generated migration and the database
 * type file. No database is contacted, consistent with every other schema suite
 * in lib/.
 *
 * Two things make the assertions below trustworthy rather than self-confirming.
 * First, the migration is discovered by suffix rather than by a hardcoded
 * timestamp, so a regenerated file is still found and two competing archive
 * migrations are a failure. Second, "must not contain" assertions run against
 * *executable* SQL — comments and quoted string literals are stripped first —
 * because this migration necessarily discusses DELETE semantics in prose and
 * necessarily embeds the text `ON DELETE SET NULL` inside a catalog check.
 * Scanning raw text would fail on the very evidence that proves correctness.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_SUFFIX = "_equipment_archive_lifecycle.sql";
const TYPES_FILE = "types/database.ts";

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/** Every migration filename ending exactly in the archive-lifecycle suffix. */
function archiveMigrationFiles(): string[] {
  return readdirSync(path.join(repoRoot, MIGRATIONS_DIR))
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort();
}

/** The single archive migration, located without hardcoding its timestamp. */
function archiveMigrationPath(): string {
  const matches = archiveMigrationFiles();
  expect(
    matches,
    `${MIGRATIONS_DIR}: expected exactly one "*${MIGRATION_SUFFIX}" migration`
  ).toHaveLength(1);
  return `${MIGRATIONS_DIR}/${matches[0]}`;
}

const NEWLINE = String.fromCharCode(10);
const SINGLE_QUOTE = String.fromCharCode(39);

/**
 * Executable SQL only: `--` line comments, block comments and single-quoted
 * string literals are replaced with whitespace.
 *
 * Dollar-quoted bodies are deliberately preserved — the preflight and postflight
 * guards live inside `do $$ ... $$` blocks and are exactly what these assertions
 * need to see. String literals inside those blocks are still removed, which is
 * what keeps `position('ON DELETE SET NULL' in ...)` from reading as DML.
 */
function executableSql(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "--") {
      const nl = source.indexOf(NEWLINE, i);
      const end = nl === -1 ? source.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (two === "/*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (source[i] === SINGLE_QUOTE) {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === SINGLE_QUOTE) {
          if (source[j + 1] === SINGLE_QUOTE) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Executable SQL, normalised to lowercase with runs of whitespace collapsed. */
function normalised(source: string): string {
  return executableSql(source).toLowerCase().replace(/\s+/g, " ");
}

/** How many times a literal fragment occurs. Used to prove PRE and POST agree. */
function occurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

const migrationPath = archiveMigrationPath();
const migrationSource = readSource(migrationPath);
const migrationCode = normalised(migrationSource);
const typesSource = readSource(TYPES_FILE);

// ============================================================================
// A. Migration identity.
// ============================================================================

describe("EQ3-DB1 migration — identity", () => {
  it("is the only archive lifecycle migration in the repository", () => {
    expect(archiveMigrationFiles()).toHaveLength(1);
  });

  it("is named with a generated timestamp prefix, not a hand-written one", () => {
    const name = path.basename(migrationPath);
    expect(name, `${migrationPath}: expected <timestamp>${MIGRATION_SUFFIX}`).toMatch(
      new RegExp(`^\\d{14}${MIGRATION_SUFFIX.replace(/\./g, "\\.")}$`)
    );
  });

  it("runs inside one explicit transaction", () => {
    expect(migrationCode, `${migrationPath}: missing explicit begin`).toContain("begin;");
    expect(migrationCode, `${migrationPath}: missing explicit commit`).toContain("commit;");
    expect((migrationCode.match(/\bbegin;/g) ?? []).length).toBe(1);
    expect((migrationCode.match(/\bcommit;/g) ?? []).length).toBe(1);
    expect(
      migrationCode,
      `${migrationPath}: a rollback would make the migration silently partial`
    ).not.toContain("rollback");
  });

  it("targets public.user_equipment", () => {
    expect(migrationCode).toContain("alter table public.user_equipment");
  });
});

// ============================================================================
// B. Column contract.
// ============================================================================

describe("EQ3-DB1 migration — column contract", () => {
  it("adds exactly is_archived boolean not null default false", () => {
    expect(migrationCode).toMatch(
      /add column is_archived boolean not null default false/
    );
  });

  it("adds exactly one column", () => {
    expect((migrationCode.match(/add column/g) ?? []).length).toBe(1);
  });

  it("defines no alternate lifecycle column", () => {
    for (const forbidden of ["archived_at", "deleted_at", "is_active", "is_deleted", "visibility"]) {
      expect(
        migrationCode,
        `${migrationPath}: "${forbidden}" is not the locked archive contract`
      ).not.toContain(forbidden);
    }
    // "status" appears in no executable statement; a lifecycle status column
    // would have to be added, so the add-column text is what is checked.
    expect(migrationCode).not.toMatch(/add column\s+status/);
  });

  it("documents the column", () => {
    expect(migrationSource).toContain("comment on column public.user_equipment.is_archived");
  });

  it("does not drop or alter any existing column", () => {
    expect(migrationCode).not.toContain("drop column");
    expect(migrationCode).not.toContain("alter column");
    expect(migrationCode).not.toContain("rename");
  });
});

// ============================================================================
// C. Preflight contract.
// ============================================================================

describe("EQ3-DB1 migration — fail-closed preflight", () => {
  it("raises EQ3DB1-PRE exceptions rather than proceeding on unexpected state", () => {
    expect(migrationSource).toMatch(/EQ3DB1-PRE-\d/);
    expect((migrationSource.match(/EQ3DB1-PRE-\d/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("verifies the target table exists", () => {
    expect(migrationSource).toContain("relname = 'user_equipment'");
    expect(migrationCode).toContain("pg_catalog.pg_class");
    expect(migrationSource).toContain("EQ3DB1-PRE-1");
  });

  it("verifies is_archived does not already exist", () => {
    expect(migrationSource).toContain("EQ3DB1-PRE-2");
    expect(migrationCode).toContain("information_schema.columns");
  });

  it("verifies the updated_at contract", () => {
    expect(migrationSource).toContain("EQ3DB1-PRE-3");
    expect(migrationSource).toContain("timestamp with time zone");
  });

  it("verifies the updated_at trigger", () => {
    expect(migrationSource).toContain("EQ3DB1-PRE-4");
    expect(migrationSource).toContain("set_updated_at_user_equipment");
  });

  it("verifies the analysis foreign key exists on exactly the right child relation", () => {
    expect(migrationSource).toContain("swing_analysis_club_id_fkey");
    expect(migrationCode).toContain("pg_catalog.pg_constraint");
    expect(migrationSource).toContain("EQ3DB1-PRE-5");
  });

  it("verifies the analysis foreign key relationship semantically", () => {
    // The full semantic contract is covered in section D2; this asserts that
    // preflight is where it first runs, and that it fails closed by raising.
    expect(migrationSource).toContain("EQ3DB1-PRE-6");
    expect(migrationSource).toContain("fk.confdeltype = 'n'");
  });

  it("verifies the swing_analysis immutability guard", () => {
    expect(migrationSource).toContain("swing_analysis_guard_equipment_immutability");
    expect(migrationSource).toContain("EQ3DB1-PRE-7");
  });
});

// ============================================================================
// D. Postflight contract.
// ============================================================================

describe("EQ3-DB1 migration — catalog-backed postflight", () => {
  it("raises EQ3DB1-POST exceptions", () => {
    expect((migrationSource.match(/EQ3DB1-POST-\d/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("verifies type, nullability and default", () => {
    expect(migrationSource).toContain("EQ3DB1-POST-2");
    expect(migrationSource).toContain("data_type = 'boolean'");
    expect(migrationSource).toContain("EQ3DB1-POST-3");
    expect(migrationSource).toContain("EQ3DB1-POST-4");
    expect(migrationCode).toContain("pg_attrdef");
  });

  it("verifies the column is neither generated nor identity", () => {
    expect(migrationSource).toContain("EQ3DB1-POST-5");
    expect(migrationCode).toContain("attgenerated");
    expect(migrationCode).toContain("attidentity");
  });

  it("verifies the surrounding trigger and foreign-key contract survived", () => {
    expect(migrationSource).toContain("EQ3DB1-POST-6");
    expect(migrationSource).toContain("EQ3DB1-POST-7");
    expect(migrationSource).toContain("EQ3DB1-POST-8");
  });
});

// ============================================================================
// D2. Foreign key proven by catalog semantics — independent review finding 1.
//
// The previous revision established the FK relationship by substring-matching
// pg_get_constraintdef() output for "FOREIGN KEY (club_id)", "user_equipment(id)"
// and "ON DELETE SET NULL". That could not distinguish public.user_equipment
// from a same-named table in another schema, and postflight was weaker still —
// it only looked for the rendered delete action. Every assertion below fails
// against that revision.
// ============================================================================

describe("EQ3-DB1 migration — FK proven from pg_catalog, not from deparsed text", () => {
  it("joins the constraint to its child and parent relations by OID", () => {
    expect(migrationCode).toContain("pg_catalog.pg_constraint");
    expect(migrationCode).toContain("child_rel.oid = fk.conrelid");
    expect(migrationCode).toContain("parent_rel.oid = fk.confrelid");
  });

  it("schema-qualifies both sides of the relationship", () => {
    expect(migrationCode).toContain("child_ns.oid = child_rel.relnamespace");
    expect(migrationCode).toContain("parent_ns.oid = parent_rel.relnamespace");
    expect(migrationSource).toContain("child_ns.nspname = 'public'");
    expect(migrationSource).toContain("parent_ns.nspname = 'public'");
    expect(migrationSource).toContain("child_rel.relname = 'swing_analysis'");
    expect(migrationSource).toContain("parent_rel.relname = 'user_equipment'");
  });

  it("pins the exact child and parent key attributes", () => {
    expect(migrationSource).toContain("child_attr.attname = 'club_id'");
    expect(migrationSource).toContain("parent_attr.attname = 'id'");
    expect(migrationCode).toContain("not child_attr.attisdropped");
    expect(migrationCode).toContain("not parent_attr.attisdropped");
  });

  it("requires a single-column key on each side, not a composite that includes it", () => {
    expect(migrationCode).toContain("fk.conkey = array[child_attr.attnum]::smallint[]");
    expect(migrationCode).toContain("fk.confkey = array[parent_attr.attnum]::smallint[]");
  });

  it("requires the SET NULL delete action by its catalog code", () => {
    expect(
      occurrences(migrationSource, "fk.confdeltype = 'n'"),
      "confdeltype = 'n' must be asserted in both preflight and postflight"
    ).toBeGreaterThanOrEqual(2);
  });

  it("applies the identical semantic contract in preflight and postflight", () => {
    for (const fragment of [
      "child_rel.relname = 'swing_analysis'",
      "parent_rel.relname = 'user_equipment'",
      "child_attr.attname = 'club_id'",
      "parent_attr.attname = 'id'",
      "fk.conkey = array[child_attr.attnum]::smallint[]",
      "fk.confkey = array[parent_attr.attnum]::smallint[]",
    ]) {
      expect(
        occurrences(migrationSource, fragment),
        `postflight must repeat the preflight contract: ${fragment}`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("raises a distinct failure for an absent constraint and for a changed one", () => {
    expect(migrationSource).toContain("EQ3DB1-PRE-5");
    expect(migrationSource).toContain("EQ3DB1-PRE-6");
    expect(migrationSource).toContain("EQ3DB1-POST-7");
  });

  it("no longer establishes FK correctness from deparsed constraint text", () => {
    // Asserted against executable SQL: the header prose deliberately names the
    // rejected mechanism when explaining why it was replaced, and that
    // explanation must not itself be what the assertion measures.
    expect(
      migrationCode,
      "pg_get_constraintdef cannot prove the schema-qualified relationship"
    ).not.toContain("pg_get_constraintdef");
    expect(
      migrationCode,
      "substring probing is not a fail-closed FK contract"
    ).not.toContain("position(");
    expect(migrationCode).not.toContain("foreign key (club_id)");
    expect(migrationCode).not.toContain("user_equipment(id)");
    // The deparsed-text variable the old mechanism needed is gone outright.
    expect(migrationSource).not.toContain("v_fk_def");
  });
});

// ============================================================================
// D3. Boolean default proven exactly — independent review finding 2.
//
// The previous revision accepted any default whose deparsed text merely
// contained "false", via pg_get_expr(...) ilike '%false%'. Both assertions
// below fail against that revision.
// ============================================================================

describe("EQ3-DB1 migration — boolean default proven exactly", () => {
  it("compares the deparsed default to the exact canonical literal", () => {
    expect(migrationSource).toContain(
      "pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'"
    );
  });

  it("no longer accepts a default that merely contains the text false", () => {
    const lowered = migrationSource.toLowerCase();
    expect(lowered, "ILIKE is not a semantic default check").not.toContain("ilike");
    expect(lowered).not.toContain("'%false%'");
    expect(lowered).not.toMatch(/pg_get_expr\([^)]*\)\s+(?:i?like|~|similar to)/);
  });

  it("still fails closed with EQ3DB1-POST-4 when the default is not exactly false", () => {
    expect(migrationSource).toContain("EQ3DB1-POST-4");
  });
});

// ============================================================================
// E. No application-row DML.
// ============================================================================

describe("EQ3-DB1 migration — touches no application row", () => {
  it("contains no executable insert, update, delete or truncate", () => {
    // Executable SQL only: the prose above and the quoted catalog expectations
    // (including the literal "ON DELETE SET NULL") are already stripped out.
    for (const forbidden of [
      "insert into",
      "update public.",
      "delete from",
      "truncate",
      "upsert",
    ]) {
      expect(
        migrationCode,
        `${migrationPath}: "${forbidden}" would mutate application data`
      ).not.toContain(forbidden);
    }
  });

  it("backfills and infers nothing", () => {
    for (const forbidden of ["backfill", "coalesce(is_archived", "set is_archived"]) {
      expect(migrationCode).not.toContain(forbidden);
    }
  });

  it("changes no other equipment field", () => {
    for (const forbidden of ["is_primary =", "club_designation =", "custom_club ="]) {
      expect(migrationCode).not.toContain(forbidden);
    }
  });

  it("proves the comment-and-literal stripper actually removes prose", () => {
    // Guards the guard: the raw file necessarily mentions DELETE semantics, so
    // if stripping ever silently stopped working the assertions above would
    // become vacuous rather than failing loudly.
    expect(migrationSource).toContain("ON DELETE SET NULL");
    expect(migrationCode).not.toContain("on delete set null");
  });
});

// ============================================================================
// F. No DB1 scope widening.
// ============================================================================

describe("EQ3-DB1 migration — creates nothing beyond the column", () => {
  it("creates no index, function, trigger, policy or type", () => {
    for (const forbidden of [
      "create index",
      "create unique index",
      "create or replace function",
      "create function",
      "create trigger",
      "drop trigger",
      "create policy",
      "drop policy",
      "create type",
    ]) {
      expect(
        migrationCode,
        `${migrationPath}: "${forbidden}" is outside the EQ3-DB1 scope`
      ).not.toContain(forbidden);
    }
  });

  it("changes no privilege", () => {
    for (const forbidden of ["grant ", "revoke ", "alter default privileges"]) {
      expect(migrationCode).not.toContain(forbidden);
    }
  });

  it("changes no row-level security", () => {
    expect(migrationCode).not.toContain("row level security");
    expect(migrationCode).not.toContain("force row level");
  });

  it("alters no table other than user_equipment", () => {
    const alters = migrationCode.match(/alter table [a-z_.]+/g) ?? [];
    expect(alters).toEqual(["alter table public.user_equipment"]);
    expect(migrationCode).not.toContain("alter table public.swing_analysis");
    expect(migrationCode).not.toContain("alter table public.swing_telemetry");
  });

  it("changes no constraint", () => {
    expect(migrationCode).not.toContain("add constraint");
    expect(migrationCode).not.toContain("drop constraint");
  });

  it("does not write the migration history table", () => {
    expect(migrationCode).not.toContain("schema_migrations");
  });
});

// ============================================================================
// G. Type contract.
// ============================================================================

describe("EQ3-DB1 types — UserEquipment gains exactly one field", () => {
  /** One exported interface body, isolated from the rest of the file. */
  function interfaceBody(name: string): string {
    const start = typesSource.indexOf(`export interface ${name} {`);
    expect(start, `${TYPES_FILE}: could not locate ${name}`).toBeGreaterThan(-1);
    const end = typesSource.indexOf("\n}", start);
    expect(end, `${TYPES_FILE}: could not locate the end of ${name}`).toBeGreaterThan(start);
    return typesSource.slice(start, end);
  }

  it("declares is_archived as a boolean on UserEquipment", () => {
    expect(interfaceBody("UserEquipment")).toMatch(/is_archived:\s*boolean;/);
  });

  it("keeps it beside the other equipment state fields", () => {
    const body = interfaceBody("UserEquipment");
    expect(body.indexOf("is_archived")).toBeGreaterThan(body.indexOf("is_primary"));
  });

  it("does not leak archive state into the selector DTO", () => {
    // SelectableClub is declared by the saved-club reader, not by the database
    // type file — the DTO is a query-boundary shape, not a row shape.
    const savedClubs = readSource("lib/equipment/saved-clubs.ts");
    const start = savedClubs.indexOf("export interface SelectableClub {");
    expect(start, "could not locate SelectableClub").toBeGreaterThan(-1);
    const body = savedClubs.slice(start, savedClubs.indexOf("\n}", start));
    expect(
      body,
      "SelectableClub stays exactly four keys — archived rows are filtered at the query boundary"
    ).not.toContain("is_archived");
    expect(body).not.toContain("isArchived");
  });

  it("does not leak archive state into either snapshot version", () => {
    for (const name of ["EquipmentSnapshotV1", "EquipmentSnapshotV2"]) {
      const body = interfaceBody(name);
      expect(
        body,
        `${name}: a snapshot records equipment as it was, not its later bag state`
      ).not.toContain("is_archived");
    }
  });
});

// ============================================================================
// EQ3-DB2 now owns application consumption of is_archived.
// Application lifecycle behavior is guarded in
// lib/equipment-archive-lifecycle-db2.test.ts.
//
// This suite's former section H asserted the opposite — that no application file
// consumed is_archived and that My Bag still removed clubs by hard delete. That
// was the correct DB1 contract and is now obsolete: it was waiting for exactly
// the separately authorized slice that has since landed. Everything above
// remains the DB1 migration and schema authority and is unchanged.
// ============================================================================
