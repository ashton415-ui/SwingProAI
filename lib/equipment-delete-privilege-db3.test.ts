/**
 * EQ3-DB3 — removing the Data API hard-delete path on public.user_equipment.
 *
 * A static source-contract suite over the generated migration and the
 * centralized migration inventory, in the established style of this
 * repository's other schema suites. No database is contacted, no network, no
 * jsdom, no Supabase client.
 *
 * WHAT MAKES THESE ASSERTIONS TRUSTWORTHY
 * ---------------------------------------
 * First, the approved contract is hardcoded here — the revoked privilege, the
 * two revoked roles, the role that must keep DELETE, and the privileges that
 * must survive. Nothing is derived from the migration, so the migration cannot
 * define its own expectations.
 *
 * Second, "must not contain" assertions run against *executable* SQL: comments
 * and single-quoted string literals are stripped first. The migration
 * necessarily discusses DELETE, GRANT, policies and triggers in prose and
 * necessarily embeds privilege names like 'DELETE' and 'UPDATE' inside quoted
 * arguments to has_table_privilege. Scanning raw text would fail on the very
 * evidence that proves correctness.
 *
 * Third, the migration is discovered by suffix rather than by a hardcoded
 * timestamp, so a regenerated file is still found and two competing DB3
 * migrations are a failure.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MIGRATIONS,
  EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME,
  EXPECTED_MIGRATION_COUNT,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "@/lib/migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_SUFFIX = "_equipment_revoke_delete_privilege.sql";

// ─── The approved DB3 contract, hardcoded ────────────────────────────────────
//
// Transcribed from the authorization, never read back out of the migration. An
// expectation derived from the implementation would move whenever the
// implementation moved, and a widened revoke could change both in one step.

/** The one table whose privileges DB3 may touch. */
const TARGET_TABLE = "public.user_equipment";
/** The one privilege DB3 may remove. */
const REVOKED_PRIVILEGE = "delete";
/** The only roles DB3 may revoke from. */
const REVOKED_ROLES = ["anon", "authenticated"];
/**
 * The role DB3 must leave outside its revoke scope, so existing
 * privileged/admin DELETE capability survives.
 *
 * This is a scope claim, not a cascade claim: the auth.users ON DELETE CASCADE
 * relationship is a separate referential mechanism that table grants do not
 * gate. DB3 leaves that foreign key unchanged, and the later staging-only
 * account-deletion gate verifies the teardown path empirically.
 */
const PRIVILEGED_ROLE = "service_role";
/** Privileges DB3 must leave intact for every role that held them. */
const PRESERVED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE"];
/** Privileges DB3 must never revoke. */
const NEVER_REVOKED = ["select", "insert", "update", "truncate", "references", "trigger"];

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/** Every migration filename ending exactly in the DB3 suffix. */
function db3MigrationFiles(): string[] {
  return readdirSync(path.join(repoRoot, MIGRATIONS_DIR))
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort();
}

/** The single DB3 migration, located without hardcoding its timestamp. */
function db3MigrationPath(): string {
  const matches = db3MigrationFiles();
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
 * Dollar-quoted bodies are preserved — the preflight and postflight guards live
 * inside `do $$ ... $$` blocks and are exactly what these assertions need to
 * see. String literals inside those blocks are still removed, which is what
 * keeps has_table_privilege(..., 'DELETE') from reading as a DELETE statement.
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

/** How many times a literal fragment occurs. */
function occurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

const migrationPath = db3MigrationPath();
const migrationSource = readSource(migrationPath);
const migrationCode = normalised(migrationSource);

/**
 * Executable SQL with comments and literals blanked but every offset preserved,
 * so a position found here refers to the same character of the raw source.
 */
const migrationExec = executableSql(migrationSource);

/**
 * The postflight block: everything from the second `do $$` onward. Slicing from
 * an exception identifier would start *after* the check that raises it, which
 * would make a "postflight verifies X" assertion pass on the wrong evidence.
 */
const postflightSource = (() => {
  const first = migrationSource.indexOf("do $$");
  expect(first, `${migrationPath}: no preflight block found`).toBeGreaterThan(-1);
  const second = migrationSource.indexOf("do $$", first + 5);
  expect(second, `${migrationPath}: no postflight block found`).toBeGreaterThan(first);
  return migrationSource.slice(second);
})();

/** The single REVOKE statement, through its terminating semicolon. */
const revokeStatement = (() => {
  const start = migrationCode.indexOf("revoke");
  expect(start, `${migrationPath}: no executable revoke statement found`).toBeGreaterThan(-1);
  const end = migrationCode.indexOf(";", start);
  expect(end, `${migrationPath}: the revoke statement is unterminated`).toBeGreaterThan(start);
  return migrationCode.slice(start, end);
})();

// ============================================================================
// A. Migration identity and inventory registration. (1-5)
// ============================================================================

describe("EQ3-DB3 migration — identity", () => {
  it("is the only DB3 revoke migration in the repository", () => {
    expect(db3MigrationFiles()).toHaveLength(1);
  });

  it("is named with a generated timestamp prefix, not a hand-written one", () => {
    const name = path.basename(migrationPath);
    expect(name, `${migrationPath}: expected <timestamp>${MIGRATION_SUFFIX}`).toMatch(
      new RegExp(`^\\d{14}${MIGRATION_SUFFIX.replace(/\./g, "\\.")}$`)
    );
  });

  it("is exported from the centralized migration inventory", () => {
    expect(EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME).toBe(path.basename(migrationPath));
  });

  it("is registered in APPROVED_MIGRATIONS exactly once", () => {
    expect(APPROVED_MIGRATIONS).toContain(EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME);
    expect(
      APPROVED_MIGRATIONS.filter((m) => m === EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME)
    ).toHaveLength(1);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });

  it("sorts after every migration authored before it", () => {
    const earlier = migrationsAuthoredBefore(EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME);
    expect(earlier.length).toBeGreaterThan(0);
    expect(
      sortsAfterAll(EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME, earlier),
      "a privilege revoke must land after the archive foundation it depends on"
    ).toBe(true);
    // DB3's permanent index, not a claim that it stays newest: everything
    // sorting before it is exactly `earlier`, so its position is earlier.length
    // no matter how many migrations land after it.
    expect(
      APPROVED_MIGRATIONS.indexOf(EQUIPMENT_DELETE_PRIVILEGE_DB3_FILENAME)
    ).toBe(earlier.length);
  });
});

// ============================================================================
// B. Transaction contract. (6-10)
// ============================================================================

describe("EQ3-DB3 migration — one explicit transaction", () => {
  it("opens exactly one transaction", () => {
    expect(migrationCode).toContain("begin;");
    expect((migrationCode.match(/\bbegin;/g) ?? []).length).toBe(1);
  });

  it("closes exactly one transaction", () => {
    expect(migrationCode).toContain("commit;");
    expect((migrationCode.match(/\bcommit;/g) ?? []).length).toBe(1);
  });

  it("contains no rollback", () => {
    expect(
      migrationCode,
      `${migrationPath}: a rollback would make the migration silently partial`
    ).not.toContain("rollback");
  });

  it("keeps the mutation and its postflight in the same transaction", () => {
    // Offsets from the length-preserving executable view, so they index the
    // same characters as the raw source the postflight marker is found in.
    const begin = migrationExec.indexOf("begin;");
    const revoke = migrationExec.indexOf("revoke");
    const post = migrationSource.indexOf("EQ3DB3-POST-1");
    const commit = migrationExec.indexOf("commit;");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(post);
    expect(
      post,
      "a failed postflight must be able to roll the revoke back"
    ).toBeLessThan(commit);
  });

  it("targets public.user_equipment", () => {
    expect(revokeStatement).toContain(TARGET_TABLE);
  });
});

// ============================================================================
// C. Preflight contract. (11, 13-25)
// ============================================================================

describe("EQ3-DB3 migration — fail-closed preflight", () => {
  it("raises EQ3DB3-PRE exceptions rather than proceeding on unexpected state", () => {
    expect(migrationSource).toMatch(/EQ3DB3-PRE-\d/);
    expect((migrationSource.match(/EQ3DB3-PRE-\d+/g) ?? []).length).toBeGreaterThanOrEqual(15);
  });

  it("proves the row-level security state it assumes", () => {
    expect(migrationCode).toContain("c.relrowsecurity");
    expect(migrationCode).toContain("c.relforcerowsecurity");
  });

  it("proves the archive column's physical contract before removing the delete path", () => {
    expect(migrationSource).toContain("column_name = 'is_archived'");
    expect(migrationSource).toContain("data_type = 'boolean'");
    expect(migrationSource).toContain("is_nullable = 'NO'");
    expect(migrationSource).toContain(
      "pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'"
    );
    expect(migrationCode).toContain("a.attgenerated");
    expect(migrationCode).toContain("a.attidentity");
  });

  it("checks effective DELETE for anon before the revoke", () => {
    expect(migrationSource).toContain(
      "has_table_privilege('anon', 'public.user_equipment', 'DELETE')"
    );
  });

  it("checks effective DELETE for authenticated before the revoke", () => {
    expect(migrationSource).toContain(
      "has_table_privilege('authenticated', 'public.user_equipment', 'DELETE')"
    );
  });

  it("checks effective DELETE for service_role before the revoke", () => {
    expect(migrationSource).toContain(
      "has_table_privilege('service_role', 'public.user_equipment', 'DELETE')"
    );
  });

  it("records the SELECT/INSERT/UPDATE baseline for all three roles", () => {
    for (const role of [...REVOKED_ROLES, PRIVILEGED_ROLE]) {
      for (const privilege of PRESERVED_PRIVILEGES) {
        expect(
          migrationSource,
          `preflight must establish ${role} ${privilege} before it can be preserved`
        ).toContain(`has_table_privilege('${role}', 'public.user_equipment', '${privilege}')`);
      }
    }
  });

  it("rules out a direct PUBLIC delete grant through exploded ACL semantics", () => {
    expect(migrationCode).toContain("aclexplode");
    expect(migrationCode).toContain("acl.grantee = 0");
    expect(migrationSource).toContain("acl.privilege_type = 'DELETE'");
    expect(
      migrationCode,
      "a rendered-ACL substring search is not a fail-closed check"
    ).not.toContain("relacl::text");
  });

  it("pins the owner policy without changing it", () => {
    expect(migrationSource).toContain("p.polname = 'Users manage own equipment'");
    expect(migrationCode).toContain("p.polpermissive");
    expect(migrationSource).toContain("p.polcmd = '*'");
    expect(migrationCode).toContain("p.polroles = array[0]::oid[]");
    // The non-pretty deparser, not the pretty one. On PostgreSQL 17.6
    // pg_get_expr(..., true) renders this predicate WITHOUT the outer
    // parentheses, so a pretty comparison against the parenthesized literal
    // fails closed on a policy that has not changed. pg_get_expr(..., false)
    // is the stable form that yields "(auth.uid() = user_id)".
    expect(migrationSource).toContain(
      "pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(migrationSource).toContain(
      "pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(
      migrationSource,
      "the pretty deparser would make PRE-16 fail closed on an unchanged policy"
    ).not.toContain("pg_catalog.pg_get_expr(p.polqual, p.polrelid, true)");
    expect(migrationSource).not.toContain(
      "pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, true)"
    );
  });

  it("fails closed on an unexpected additional policy", () => {
    expect(migrationCode).toContain("pg_catalog.pg_policy");
    expect(migrationCode).toContain("count(*)");
    expect(migrationCode).toContain(") <> 1 then");
  });

  it("proves the auth.users cascade from the catalog, not from deparsed text", () => {
    expect(migrationSource).toContain("parent_ns.nspname = 'auth'");
    expect(migrationSource).toContain("parent_rel.relname = 'users'");
    expect(migrationSource).toContain("child_attr.attname = 'user_id'");
    expect(migrationSource).toContain("fk.confdeltype = 'c'");
    expect(migrationCode).toContain("fk.conkey = array[child_attr.attnum]::smallint[]");
    expect(migrationCode).toContain("fk.confkey = array[parent_attr.attnum]::smallint[]");
    expect(
      migrationCode,
      "pg_get_constraintdef cannot prove a schema-qualified relationship"
    ).not.toContain("pg_get_constraintdef");
  });

  it("proves the swing_analysis reference semantically", () => {
    expect(migrationSource).toContain("child_rel.relname = 'swing_analysis'");
    expect(migrationSource).toContain("child_attr.attname = 'club_id'");
    expect(
      occurrences(migrationSource, "fk.confdeltype = 'n'"),
      "both historical references must be pinned in preflight and postflight"
    ).toBeGreaterThanOrEqual(4);
  });

  it("proves the swing_telemetry reference semantically", () => {
    expect(migrationSource).toContain("child_rel.relname = 'swing_telemetry'");
    expect(
      occurrences(migrationSource, "child_rel.relname = 'swing_telemetry'"),
      "telemetry must be pinned in preflight and postflight"
    ).toBeGreaterThanOrEqual(2);
  });

  it("requires the equipment immutability guard", () => {
    expect(migrationSource).toContain("swing_analysis_guard_equipment_immutability");
    expect(migrationSource).toContain("t.tgenabled <> 'D'");
    expect(migrationCode).toContain("not t.tgisinternal");
  });

  it("requires that no DELETE-event trigger already exists on the target table", () => {
    // Trigger event bits, not prose: 1<<3 is DELETE.
    expect(migrationCode).toContain("(t.tgtype & 8) <> 0");
    expect(migrationSource).toContain("EQ3DB3-PRE-21");
  });
});

// ============================================================================
// D. The mutation itself. (26-31, 49-54)
// ============================================================================

describe("EQ3-DB3 migration — exactly one privilege change", () => {
  it("contains exactly one executable revoke", () => {
    expect((migrationCode.match(/\brevoke\b/g) ?? []).length).toBe(1);
  });

  it("revokes on exactly the equipment table", () => {
    expect(revokeStatement).toContain(`on table ${TARGET_TABLE}`);
    for (const other of [
      "public.swing_analysis",
      "public.swing_telemetry",
      "public.equipment_models",
      "auth.users",
    ]) {
      expect(revokeStatement, `${other} is not a DB3 target`).not.toContain(other);
    }
  });

  it("revokes exactly the DELETE privilege", () => {
    expect(revokeStatement).toMatch(new RegExp(`^revoke\\s+${REVOKED_PRIVILEGE}\\s+on\\b`));
  });

  it("revokes from exactly anon and authenticated", () => {
    const from = revokeStatement.slice(revokeStatement.indexOf(" from ") + 6);
    const roles = from.split(",").map((r) => r.trim());
    expect(roles).toEqual(REVOKED_ROLES);
  });

  it("never revokes from the privileged role", () => {
    expect(
      revokeStatement,
      "service_role is outside DB3's revoke scope; its privileged/admin DELETE capability must survive"
    ).not.toContain(PRIVILEGED_ROLE);
  });

  it("revokes no privilege other than DELETE", () => {
    for (const privilege of NEVER_REVOKED) {
      expect(
        revokeStatement,
        `${migrationPath}: DB3 must not revoke ${privilege.toUpperCase()}`
      ).not.toContain(privilege);
    }
  });

  it("revokes nothing implicitly through ALL", () => {
    expect(revokeStatement).not.toContain("all privileges");
    expect(revokeStatement).not.toMatch(/^revoke\s+all\b/);
  });
});

// ============================================================================
// E. Everything DB3 must not do. (32-38, 56)
// ============================================================================

describe("EQ3-DB3 migration — changes nothing beyond the one privilege", () => {
  it("grants nothing", () => {
    expect(migrationCode, `${migrationPath}: DB3 removes a privilege, it adds none`).not.toMatch(
      /\bgrant\b/
    );
  });

  it("changes no default privileges", () => {
    expect(migrationCode).not.toContain("alter default privileges");
    expect(migrationCode).not.toContain("default privileges");
  });

  it("changes no row-level security setting and no policy", () => {
    expect(migrationCode).not.toContain("enable row level security");
    expect(migrationCode).not.toContain("disable row level security");
    expect(migrationCode).not.toContain("force row level security");
    expect(migrationCode).not.toContain("create policy");
    expect(migrationCode).not.toContain("drop policy");
    expect(migrationCode).not.toContain("alter policy");
  });

  it("creates, alters or drops no trigger", () => {
    expect(migrationCode).not.toContain("create trigger");
    expect(migrationCode).not.toContain("drop trigger");
    expect(migrationCode).not.toContain("alter trigger");
    expect(migrationCode).not.toContain("create constraint trigger");
  });

  it("creates, replaces or drops no function", () => {
    expect(migrationCode).not.toContain("create function");
    expect(migrationCode).not.toContain("create or replace function");
    expect(migrationCode).not.toContain("drop function");
  });

  it("changes no constraint and no foreign key", () => {
    expect(migrationCode).not.toContain("add constraint");
    expect(migrationCode).not.toContain("drop constraint");
    expect(migrationCode).not.toContain("alter constraint");
    expect(migrationCode).not.toContain("references auth.users");
  });

  it("alters no table and no column", () => {
    expect(migrationCode).not.toContain("alter table");
    expect(migrationCode).not.toContain("add column");
    expect(migrationCode).not.toContain("drop column");
    expect(migrationCode).not.toContain("alter column");
    expect(migrationCode).not.toContain("rename");
  });

  it("creates no index, type, schema or view", () => {
    for (const forbidden of [
      "create index",
      "create unique index",
      "create type",
      "create schema",
      "create view",
      "create materialized view",
    ]) {
      expect(migrationCode, `"${forbidden}" is outside the DB3 scope`).not.toContain(forbidden);
    }
  });

  it("does not write the migration history table", () => {
    expect(migrationCode).not.toContain("schema_migrations");
  });

  it("carries no application or API remediation", () => {
    for (const forbidden of ["app/", "components/", "route.ts", "BagPageClient", "saved-clubs"]) {
      expect(
        migrationSource,
        `${forbidden}: application remediation is a separately authorized slice`
      ).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// F. No row DML. (38)
// ============================================================================

describe("EQ3-DB3 migration — touches no application row", () => {
  it("contains no executable insert, delete, truncate, merge or copy", () => {
    for (const forbidden of [
      "insert into",
      "delete from",
      "truncate",
      "merge into",
      "copy ",
      "upsert",
    ]) {
      expect(
        migrationCode,
        `${migrationPath}: "${forbidden}" would touch application data`
      ).not.toContain(forbidden);
    }
  });

  it("contains no executable UPDATE keyword at all", () => {
    // Broader than a `update <table>` fragment on purpose. Quoted privilege
    // names — has_table_privilege(..., 'UPDATE') — are already stripped from
    // migrationCode, so any surviving UPDATE keyword is executable SQL, and no
    // executable UPDATE is inside DB3's authorized scope.
    expect(
      migrationCode,
      `${migrationPath}: DB3 authorizes exactly one REVOKE and no row mutation`
    ).not.toMatch(/\bupdate\b/);
  });

  it("executes no dynamic SQL", () => {
    // Single-quoted literals are deliberately blanked from migrationCode, so a
    // payload hidden inside EXECUTE '...' would be invisible to every negative
    // assertion above. Forbidding the mechanism outright is what keeps those
    // assertions meaningful; the current migration contains no EXECUTE.
    expect(
      migrationCode,
      `${migrationPath}: dynamic SQL would hide its own mutation from these checks`
    ).not.toMatch(/\bexecute\b/);
    expect(migrationCode).not.toMatch(/\bformat\s*\(/);
    expect(migrationCode).not.toContain("quote_ident");
    expect(migrationCode).not.toContain("quote_literal");
  });

  it("backfills and infers nothing", () => {
    for (const forbidden of ["backfill", "set is_archived", "set user_id"]) {
      expect(migrationCode).not.toContain(forbidden);
    }
  });

  it("creates and deletes no account", () => {
    expect(migrationCode).not.toContain("auth.users (");
    expect(migrationCode).not.toContain("delete from auth");
  });

  it("proves the comment-and-literal stripper actually removes prose", () => {
    // Guards the guard: the raw file necessarily discusses DELETE and GRANT, so
    // if stripping ever silently stopped working the negative assertions above
    // would become vacuous rather than failing loudly.
    expect(migrationSource).toContain("No grant");
    expect(migrationCode).not.toContain("no grant");
    expect(migrationSource).toContain("'DELETE'");
    expect(migrationCode).not.toContain("'delete'");
  });
});

// ============================================================================
// G. Postflight contract. (12, 39-48)
// ============================================================================

describe("EQ3-DB3 migration — fail-closed postflight", () => {
  it("raises EQ3DB3-POST exceptions", () => {
    expect(migrationSource).toMatch(/EQ3DB3-POST-\d/);
    expect((migrationSource.match(/EQ3DB3-POST-\d+/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });

  it("proves the delete path closed for both revoked roles", () => {
    const post = postflightSource;
    for (const role of REVOKED_ROLES) {
      expect(
        post,
        `postflight must re-check effective DELETE for ${role}`
      ).toContain(`has_table_privilege('${role}', 'public.user_equipment', 'DELETE')`);
    }
    expect(migrationSource).toContain("EQ3DB3-POST-1");
    expect(migrationSource).toContain("EQ3DB3-POST-2");
  });

  it("proves the privileged/admin delete capability preserved", () => {
    // Losing service_role DELETE would mean the revoke reached outside its
    // locked scope. It is not evidence about the cascade either way.
    expect(migrationSource).toContain("EQ3DB3-POST-3");
    const post = postflightSource;
    expect(post).toContain(
      `has_table_privilege('${PRIVILEGED_ROLE}', 'public.user_equipment', 'DELETE')`
    );
  });

  it("proves SELECT, INSERT and UPDATE preserved for every role", () => {
    const post = postflightSource;
    for (const role of [...REVOKED_ROLES, PRIVILEGED_ROLE]) {
      for (const privilege of PRESERVED_PRIVILEGES) {
        expect(
          post,
          `postflight must prove ${role} kept ${privilege}`
        ).toContain(`has_table_privilege('${role}', 'public.user_equipment', '${privilege}')`);
      }
    }
  });

  it("proves no PUBLIC delete path appeared", () => {
    expect(
      occurrences(migrationCode, "acl.grantee = 0"),
      "the PUBLIC check must run before and after the revoke"
    ).toBeGreaterThanOrEqual(2);
  });

  it("proves row-level security unchanged", () => {
    expect(
      occurrences(migrationCode, "c.relrowsecurity"),
      "RLS must be pinned before and after"
    ).toBeGreaterThanOrEqual(2);
    expect(occurrences(migrationCode, "c.relforcerowsecurity")).toBeGreaterThanOrEqual(2);
  });

  it("proves the owner policy unchanged", () => {
    expect(
      occurrences(migrationSource, "p.polname = 'Users manage own equipment'")
    ).toBeGreaterThanOrEqual(2);
    // Exactly two of each: once in PRE-16, once in POST-10. An exact count is
    // what proves the postflight carries the corrected guard too, rather than
    // only the preflight having been fixed.
    expect(
      occurrences(
        migrationSource,
        "pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'"
      )
    ).toBe(2);
    expect(
      occurrences(
        migrationSource,
        "pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'"
      )
    ).toBe(2);
    expect(
      postflightSource,
      "POST-10 must carry the non-pretty deparser guard, not just PRE-16"
    ).toContain(
      "pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(postflightSource).toContain(
      "pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
  });

  it("proves the archive column unchanged", () => {
    expect(
      occurrences(migrationSource, "column_name = 'is_archived'")
    ).toBeGreaterThanOrEqual(2);
    expect(
      occurrences(migrationSource, "pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'")
    ).toBeGreaterThanOrEqual(2);
  });

  it("proves all three critical foreign keys unchanged", () => {
    expect(occurrences(migrationSource, "fk.confdeltype = 'c'")).toBeGreaterThanOrEqual(2);
    expect(occurrences(migrationSource, "parent_rel.relname = 'users'")).toBeGreaterThanOrEqual(2);
    expect(
      occurrences(migrationSource, "child_rel.relname = 'swing_analysis'")
    ).toBeGreaterThanOrEqual(2);
    expect(
      occurrences(migrationSource, "child_rel.relname = 'swing_telemetry'")
    ).toBeGreaterThanOrEqual(2);
  });

  it("proves the immutability trigger unchanged", () => {
    expect(
      occurrences(migrationSource, "swing_analysis_guard_equipment_immutability")
    ).toBeGreaterThanOrEqual(2);
  });

  it("proves no DELETE trigger was introduced", () => {
    expect(
      occurrences(migrationCode, "(t.tgtype & 8) <> 0"),
      "the delete-trigger check must run before and after"
    ).toBeGreaterThanOrEqual(2);
    expect(migrationSource).toContain("EQ3DB3-POST-17");
  });
});

// ============================================================================
// H. Secrets and environment hygiene. (55)
// ============================================================================

describe("EQ3-DB3 migration — carries no credential or environment coupling", () => {
  it("names no Supabase project ref", () => {
    expect(migrationSource).not.toMatch(/\b[a-z]{20}\b/);
    expect(migrationSource).not.toContain(".supabase.co");
    expect(migrationSource).not.toContain("supabase.com");
  });

  it("embeds no credential", () => {
    for (const forbidden of [
      "SERVICE_ROLE_KEY",
      "service_role_key",
      "ANON_KEY",
      "anon_key",
      "SUPABASE_",
      "postgres://",
      "postgresql://",
      "password",
      "eyJ",
      "sk_",
      "Bearer ",
    ]) {
      expect(migrationSource, `${forbidden} must never appear in a migration`).not.toContain(
        forbidden
      );
    }
  });

  it("hardcodes no connection or environment switch", () => {
    expect(migrationCode).not.toContain("dblink");
    expect(migrationCode).not.toContain("current_database() =");
    expect(migrationCode).not.toContain("pg_read_file");
  });
});
