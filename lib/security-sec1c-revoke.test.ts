import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const MIGRATION_FILENAME =
  "20260730035500_revoke_anon_execute_link_student_to_coach.sql";
const migrationPath = path.join(migrationsDir, MIGRATION_FILENAME);

/** Raw bytes, so byte-level checks (BOM, CR, trailing newline) see the file
 *  exactly as it sits on disk, before any normalization could hide a defect. */
const rawBuffer = readFileSync(migrationPath);
const rawText = rawBuffer.toString("utf8");

/** Normalized to LF, matching the convention used by the SEC1A and SEC1B
 *  contract tests, so statement-level assertions are independent of any
 *  future core.autocrlf checkout behavior. */
const migration = rawText.replace(/\r\n/g, "\n");

/** The single authorized function this migration may reference. */
const TARGET_FUNCTION = "public.link_student_to_coach";

/** Strips `--` line comments only. Block comments are rejected outright below,
 *  so there is no `/* *\/` handling to get wrong. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Collapses all whitespace runs to a single space and trims, so a statement
 *  can be compared to an exact expected form regardless of formatting. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const code = stripLineComments(migration);

/** The executable statements, in file order, with empties removed. */
const statements = code
  .split(";")
  .map((s) => collapse(s))
  .filter((s) => s.length > 0);

const statementsLower = statements.map((s) => s.toLowerCase());
const codeLower = code.toLowerCase();

/** Parses a revoke statement into its target function and its single grantee,
 *  so the grantee is checked positionally rather than by substring search
 *  (note "public" legitimately appears twice: as schema and as grantee). */
const REVOKE_RE =
  /^revoke\s+execute\s+on\s+function\s+(public\.[a-z_]+)\s*\(\s*text\s*\)\s+from\s+([a-z_]+)$/i;

interface ParsedRevoke {
  fn: string;
  grantee: string;
  index: number;
}

const parsedRevokes: ParsedRevoke[] = [];
statements.forEach((stmt, index) => {
  const m = REVOKE_RE.exec(stmt);
  if (m) parsedRevokes.push({ fn: m[1].toLowerCase(), grantee: m[2].toLowerCase(), index });
});

// ============================================================================
// 1. File encoding and byte hygiene
// ============================================================================
describe("SEC1C — migration file byte hygiene", () => {
  it("exists at the exact authorized path", () => {
    expect(readdirSync(migrationsDir)).toContain(MIGRATION_FILENAME);
  });

  it("has no UTF-8 BOM", () => {
    expect(rawBuffer.length).toBeGreaterThanOrEqual(3);
    const hasBom =
      rawBuffer[0] === 0xef && rawBuffer[1] === 0xbb && rawBuffer[2] === 0xbf;
    expect(hasBom).toBe(false);
  });

  it("uses LF-only line endings (contains no CR byte)", () => {
    expect(rawBuffer.includes(0x0d)).toBe(false);
  });

  it("ends with exactly one trailing newline", () => {
    expect(rawText.endsWith("\n")).toBe(true);
    expect(rawText.endsWith("\n\n")).toBe(false);
  });

  it("contains no block-comment delimiters", () => {
    expect(rawText).not.toContain("/*");
    expect(rawText).not.toContain("*/");
  });
});

// ============================================================================
// 2. Exhaustive executable-statement allowlist
// ============================================================================
describe("SEC1C — exhaustive executable-statement allowlist", () => {
  const EXPECTED_STATEMENTS = [
    "begin",
    "revoke execute on function public.link_student_to_coach(text) from public",
    "revoke execute on function public.link_student_to_coach(text) from anon",
    "commit",
  ];

  it("contains exactly four executable statements", () => {
    expect(statements.length).toBe(4);
  });

  it("matches the authorized statement list positionally and completely", () => {
    expect(statementsLower).toEqual(EXPECTED_STATEMENTS);
  });

  it.each(EXPECTED_STATEMENTS.map((s, i) => [i, s] as [number, string]))(
    "statement %i is exactly %s",
    (i, expected) => {
      expect(statementsLower[i]).toBe(expected);
    }
  );
});

// ============================================================================
// 3. Revoke shape, target, and grantees
// ============================================================================
describe("SEC1C — revoke shape, target, and grantees", () => {
  it("contains exactly two REVOKE statements", () => {
    expect(parsedRevokes.length).toBe(2);
    const rawRevokes = codeLower.match(/\brevoke\b/g) ?? [];
    expect(rawRevokes.length).toBe(2);
  });

  it("contains exactly zero GRANT statements", () => {
    const grants = codeLower.match(/\bgrant\b/g) ?? [];
    expect(grants.length).toBe(0);
  });

  it("targets only public.link_student_to_coach", () => {
    for (const r of parsedRevokes) {
      expect(r.fn).toBe(TARGET_FUNCTION);
    }
  });

  it("revokes from PUBLIC first", () => {
    expect(parsedRevokes[0].grantee).toBe("public");
  });

  it("revokes from anon second", () => {
    expect(parsedRevokes[1].grantee).toBe("anon");
  });

  it("orders the PUBLIC revoke before the anon revoke", () => {
    expect(parsedRevokes[0].index).toBeLessThan(parsedRevokes[1].index);
  });

  it("uses the explicit (text) identity signature on every revoke", () => {
    const sigs = codeLower.match(/link_student_to_coach\s*\(\s*text\s*\)/g) ?? [];
    expect(sigs.length).toBe(2);
  });

  it("references no function other than link_student_to_coach", () => {
    const fnRefs = codeLower.match(/on\s+function\s+([a-z_]+\.[a-z_]+)/g) ?? [];
    expect(fnRefs.length).toBe(2);
    for (const ref of fnRefs) {
      expect(ref.replace(/\s+/g, " ")).toBe(`on function ${TARGET_FUNCTION}`);
    }
  });
});

// ============================================================================
// 4. Over-revocation and scope-escape safeguards
// ============================================================================
describe("SEC1C — over-revocation and scope-escape safeguards", () => {
  const FORBIDDEN_TOKENS: [string, RegExp][] = [
    ["authenticated", /\bauthenticated\b/],
    ["service_role", /\bservice_role\b/],
    ["postgres", /\bpostgres\b/],
    ["alter function", /alter\s+function/],
    ["security definer", /security\s+definer/],
    ["security invoker", /security\s+invoker/],
    ["search_path", /search_path/],
    ["create", /\bcreate\b/],
    ["drop", /\bdrop\b/],
    ["policy", /\bpolicy\b/],
    ["row level security", /row\s+level\s+security/],
    ["rollback", /\brollback\b/],
    ["savepoint", /\bsavepoint\b/],
    ["insert", /\binsert\b/],
    ["update", /\bupdate\b/],
    ["delete", /\bdelete\b/],
    ["truncate", /\btruncate\b/],
    ["storage schema", /\bstorage\./],
    ["auth schema", /\bauth\./],
    ["dollar-quoted body", /\$\$/],
  ];

  it.each(FORBIDDEN_TOKENS)(
    "executable SQL never contains %s",
    (_label, pattern) => {
      expect(codeLower).not.toMatch(pattern);
    }
  );

  it("changes no privilege for authenticated or service_role", () => {
    // Belt-and-suspenders: the only grantees anywhere are public and anon.
    const grantees = parsedRevokes.map((r) => r.grantee).sort();
    expect(grantees).toEqual(["anon", "public"]);
  });
});

// ============================================================================
// 5. Transaction framing
// ============================================================================
describe("SEC1C — transaction framing", () => {
  it("contains exactly one BEGIN and one COMMIT", () => {
    expect(statementsLower.filter((s) => s === "begin").length).toBe(1);
    expect(statementsLower.filter((s) => s === "commit").length).toBe(1);
  });

  it("places BEGIN before every revoke", () => {
    const beginIdx = statementsLower.indexOf("begin");
    expect(beginIdx).toBe(0);
    for (const r of parsedRevokes) {
      expect(beginIdx).toBeLessThan(r.index);
    }
  });

  it("places COMMIT after every revoke", () => {
    const commitIdx = statementsLower.indexOf("commit");
    expect(commitIdx).toBe(statementsLower.length - 1);
    for (const r of parsedRevokes) {
      expect(commitIdx).toBeGreaterThan(r.index);
    }
  });
});

// ============================================================================
// 6. Migration ordering (F3: no duplicated inventory, no total count here)
// ============================================================================
describe("SEC1C — migration ordering", () => {
  // Deliberately does NOT assert the total migration count and does NOT
  // redeclare the migration inventory. Exact count and closed-world membership
  // are owned solely by lib/migration-history-bridge.test.ts.
  const sqlMigrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  it("is present among the checked-in SQL migrations", () => {
    expect(sqlMigrations).toContain(MIGRATION_FILENAME);
  });

  it("is the lexicographically last SQL migration", () => {
    const sorted = [...sqlMigrations].sort();
    expect(sorted[sorted.length - 1]).toBe(MIGRATION_FILENAME);
  });

  it("carries a 14-digit timestamp prefix matching the Supabase CLI format", () => {
    expect(MIGRATION_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});
