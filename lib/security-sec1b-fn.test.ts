import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEC1B_FN_FILENAME,
  migrationsAuthoredBefore,
} from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const MIGRATION_FILENAME = SEC1B_FN_FILENAME;
const migrationPath = path.join(migrationsDir, MIGRATION_FILENAME);

// Normalized to LF immediately after reading, matching the convention already
// used by lib/security-sec1a-schema.test.ts, so exact-newline-adjacent
// assertions below are independent of Windows core.autocrlf checkout behavior.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

/** Strips `-- ...` line comments so keyword-absence checks cannot be fooled by
 *  this migration's own explanatory header, which legitimately names concepts
 *  (privileges, triggers, security modes) that must never appear as executable
 *  SQL in this file. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const code = stripSqlComments(migration);
const codeLower = code.toLowerCase();

/** The three authorized targets, in the exact order they must appear. */
const TARGETS = [
  "public.handle_updated_at()",
  "public.generate_coach_invite_code()",
  "public.auto_assign_coach_invite_code()",
];

/** Every migration that already existed when SEC1B was authored — the 19 that
 *  sort before it. Derived from lib/migration-inventory.ts rather than
 *  redeclared, so adding a later migration cannot invalidate SEC1B's own
 *  historical contract. */
const PRE_EXISTING_MIGRATIONS = migrationsAuthoredBefore(MIGRATION_FILENAME);

/** Parses every `alter function <schema>.<name>(<args>) set search_path = '...'`
 *  statement, capturing the pieces each assertion needs to check independently. */
interface AlterTarget {
  qualifiedName: string;
  signature: string;
  searchPathValue: string;
  index: number;
}

function parseAlterFunctions(sql: string): AlterTarget[] {
  const re =
    /alter\s+function\s+([a-z_]+\.[a-z_]+)\s*\(([^)]*)\)\s*set\s+search_path\s*=\s*'([^']*)'\s*;/gi;
  const out: AlterTarget[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({
      qualifiedName: m[1].toLowerCase(),
      signature: m[2].trim(),
      searchPathValue: m[3],
      index: m.index,
    });
  }
  return out;
}

const alterTargets = parseAlterFunctions(code);

// ============================================================================
// 1. File location
// ============================================================================
describe("SEC1B-FN — migration file location", () => {
  it("exists at the exact authorized migration path", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("lives under supabase/migrations and carries the authorized filename", () => {
    expect(readdirSync(migrationsDir)).toContain(MIGRATION_FILENAME);
  });
});

// ============================================================================
// 2. Transaction shape
// ============================================================================
describe("SEC1B-FN — transaction shape", () => {
  it("contains exactly one top-level BEGIN and one COMMIT", () => {
    const begins = code.match(/^\s*begin\s*;\s*$/gim) ?? [];
    const commits = code.match(/^\s*commit\s*;\s*$/gim) ?? [];
    expect(begins.length).toBe(1);
    expect(commits.length).toBe(1);
  });

  it("places BEGIN before COMMIT", () => {
    const beginIdx = codeLower.search(/^\s*begin\s*;\s*$/im);
    const commitIdx = codeLower.search(/^\s*commit\s*;\s*$/im);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
  });

  it("wraps every ALTER FUNCTION statement inside the transaction", () => {
    const beginIdx = codeLower.search(/^\s*begin\s*;\s*$/im);
    const commitIdx = codeLower.search(/^\s*commit\s*;\s*$/im);
    for (const t of alterTargets) {
      expect(t.index).toBeGreaterThan(beginIdx);
      expect(t.index).toBeLessThan(commitIdx);
    }
  });

  it("has no ROLLBACK and no nested transaction control", () => {
    expect(codeLower).not.toMatch(/\brollback\b/);
    expect(codeLower).not.toMatch(/\bsavepoint\b/);
  });
});

// ============================================================================
// 3. The three authorized ALTER FUNCTION statements
// ============================================================================
describe("SEC1B-FN — authorized ALTER FUNCTION statements", () => {
  it("contains exactly three ALTER FUNCTION statements", () => {
    expect(alterTargets.length).toBe(3);
  });

  it("contains exactly three occurrences of the ALTER FUNCTION keyword pair", () => {
    const raw = codeLower.match(/alter\s+function/g) ?? [];
    expect(raw.length).toBe(3);
  });

  it("targets exactly the three authorized functions, in order", () => {
    expect(alterTargets.map((t) => `${t.qualifiedName}()`)).toEqual(TARGETS);
  });

  it.each(TARGETS)("names %s exactly once", (target) => {
    const bare = target.replace(/\(\)$/, "");
    const occurrences = alterTargets.filter((t) => t.qualifiedName === bare);
    expect(occurrences.length).toBe(1);
  });

  it("schema-qualifies every target with the public schema", () => {
    for (const t of alterTargets) {
      expect(t.qualifiedName.startsWith("public.")).toBe(true);
    }
  });

  it("gives every target an explicit (zero-argument) signature", () => {
    // The parser only matches when a literal `(...)` is present, so reaching
    // three parsed targets already proves signatures are explicit; this pins
    // the exact arity so a future signature change cannot slip through.
    expect(alterTargets.length).toBe(3);
    for (const t of alterTargets) {
      expect(t.signature).toBe("");
    }
  });

  it("sets search_path to the empty string on every target", () => {
    for (const t of alterTargets) {
      expect(t.searchPathValue).toBe("");
    }
  });

  it("sets no configuration parameter other than search_path", () => {
    const sets = codeLower.match(/\bset\s+([a-z_]+)/g) ?? [];
    expect(sets.length).toBe(3);
    for (const s of sets) {
      expect(s.replace(/\s+/g, " ")).toBe("set search_path");
    }
  });

  it("never uses RESET or SET ... TO DEFAULT", () => {
    expect(codeLower).not.toMatch(/\breset\b/);
    expect(codeLower).not.toMatch(/to\s+default/);
  });
});

// ============================================================================
// 4. Forbidden operations
// ============================================================================
describe("SEC1B-FN — forbidden operations are absent", () => {
  const FORBIDDEN_PATTERNS: [string, RegExp][] = [
    ["CREATE FUNCTION", /create\s+(or\s+replace\s+)?function/],
    ["CREATE PROCEDURE", /create\s+(or\s+replace\s+)?procedure/],
    ["DROP", /\bdrop\b/],
    ["GRANT", /\bgrant\b/],
    ["REVOKE", /\brevoke\b/],
    ["CREATE POLICY", /create\s+policy/],
    ["ALTER POLICY", /alter\s+policy/],
    ["POLICY", /\bpolicy\b/],
    ["ROW LEVEL SECURITY", /row\s+level\s+security/],
    ["SECURITY DEFINER", /security\s+definer/],
    ["SECURITY INVOKER", /security\s+invoker/],
    ["function body replacement", /\$function\$|\$\$/],
    ["CREATE TABLE", /create\s+table/],
    ["ALTER TABLE", /alter\s+table/],
    ["CREATE TRIGGER", /create\s+trigger/],
    ["DROP TRIGGER", /drop\s+trigger/],
    ["CREATE INDEX", /create\s+(unique\s+)?index/],
    ["INSERT", /\binsert\s+into\b/],
    ["UPDATE", /\bupdate\s+[a-z_]+\s+set\b/],
    ["DELETE", /\bdelete\s+from\b/],
    ["TRUNCATE", /\btruncate\b/],
    ["CREATE ROLE", /create\s+role/],
    ["ALTER ROLE", /alter\s+role/],
    ["ALTER DATABASE", /alter\s+database/],
    ["storage schema", /\bstorage\./],
    ["auth schema", /\bauth\./],
  ];

  it.each(FORBIDDEN_PATTERNS)("contains no %s", (_label, pattern) => {
    expect(codeLower).not.toMatch(pattern);
  });
});

// ============================================================================
// 5. Out-of-scope objects
// ============================================================================
describe("SEC1B-FN — out-of-scope objects are untouched", () => {
  const OUT_OF_SCOPE_OBJECTS = [
    "link_student_to_coach",
    "handle_new_user",
    "user_goals",
    "coach_student_relationships",
    "equipment_manufacturers",
    "equipment_models",
    "equipment_putter_model_specs",
    "equipment_model_sources",
    "swing_telemetry",
    "user_equipment",
  ];

  it.each(OUT_OF_SCOPE_OBJECTS)("never references %s", (name) => {
    expect(codeLower).not.toContain(name);
  });
});

// ============================================================================
// 6. Pre-existing SEC1A artifacts are unmodified
// ============================================================================
describe("SEC1B-FN — pre-existing SEC1A artifacts are unmodified", () => {
  const sec1aSqlPath = path.join(repoRoot, "supabase-security-sec1a.sql");
  const sec1aTestPath = path.join(repoRoot, "lib", "security-sec1a-schema.test.ts");

  it("leaves supabase-security-sec1a.sql in place", () => {
    expect(existsSync(sec1aSqlPath)).toBe(true);
  });

  it("leaves lib/security-sec1a-schema.test.ts in place", () => {
    expect(existsSync(sec1aTestPath)).toBe(true);
  });

  it("keeps the SEC1A contract unapplied and source-only", () => {
    const sec1a = readFileSync(sec1aSqlPath, "utf8").replace(/\r\n/g, "\n");
    expect(sec1a).toMatch(/THIS MIGRATION IS UNAPPLIED\. IT IS SOURCE ONLY\./);
  });

  it("keeps the SEC1A contract's three policy removals intact", () => {
    const sec1a = readFileSync(sec1aSqlPath, "utf8").replace(/\r\n/g, "\n");
    const drops = sec1a.match(/drop\s+policy\s+"[^"]+"\s+on\s+[a-z_]+\.[a-z_]+\s*;/gi) ?? [];
    expect(drops.length).toBe(3);
  });

  // SEC1B's actual contract is "SEC1B did not promote the SEC1A source file
  // into supabase/migrations" — a claim about SEC1B's OWN migration. The
  // previous form banned the substring "sec1a" from every migration filename,
  // which would have rejected a legitimate future migration that applies the
  // SEC1A policy drops. Scoped to SEC1B's own file, the intent is preserved and
  // no constraint is placed on any later migration's name.
  it("SEC1B's own migration is not a promoted copy of the SEC1A contract", () => {
    const sec1a = readFileSync(sec1aSqlPath, "utf8").replace(/\r\n/g, "\n");
    const sec1b = readFileSync(
      path.join(migrationsDir, MIGRATION_FILENAME),
      "utf8"
    ).replace(/\r\n/g, "\n");
    expect(sec1b).not.toBe(sec1a);
    // SEC1B alters function configuration; it drops no policy at all.
    expect(sec1b.toLowerCase()).not.toContain("drop policy");
  });
});

// ============================================================================
// 7. Migration inventory
// ============================================================================
describe("SEC1B-FN — migration inventory", () => {
  const sqlMigrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  // Deliberately does NOT assert the repository's current total migration count.
  // This block verifies SEC1B's own historical contract — that it was added on
  // top of the pinned 19 pre-existing migrations — without assuming SEC1B stays
  // the newest or only later migration. The closed-world current inventory is
  // owned solely by lib/migration-history-bridge.test.ts.
  it("adds SEC1B on top of the pinned 19 pre-existing migrations", () => {
    expect(PRE_EXISTING_MIGRATIONS.length).toBe(19);
    expect(sqlMigrations).toContain(MIGRATION_FILENAME);
  });

  it("retains every pre-existing migration unchanged in name", () => {
    for (const name of PRE_EXISTING_MIGRATIONS) {
      expect(sqlMigrations).toContain(name);
    }
  });

  it("appears exactly once beyond the pre-existing set", () => {
    const added = sqlMigrations.filter((f) => !PRE_EXISTING_MIGRATIONS.includes(f));
    expect(added).toContain(MIGRATION_FILENAME);
    expect(added.filter((name) => name === MIGRATION_FILENAME)).toHaveLength(1);
  });

  it("sorts strictly after every pre-existing migration", () => {
    for (const name of PRE_EXISTING_MIGRATIONS) {
      expect(MIGRATION_FILENAME > name).toBe(true);
    }
  });

  it("carries a 14-digit timestamp prefix matching the Supabase CLI format", () => {
    expect(MIGRATION_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});
