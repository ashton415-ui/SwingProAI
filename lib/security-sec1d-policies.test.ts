import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEC1D_POL_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const MIGRATION_FILENAME = SEC1D_POL_FILENAME;
const migrationPath = path.join(migrationsDir, MIGRATION_FILENAME);

/** Raw bytes, so byte-level checks (BOM, CR, trailing newline) see the file
 *  exactly as it sits on disk, before any normalization could hide a defect. */
const rawBuffer = readFileSync(migrationPath);
const rawText = rawBuffer.toString("utf8");

/** Normalized to LF, matching the convention used by the SEC1A, SEC1B and
 *  SEC1C contract tests. */
const migration = rawText.replace(/\r\n/g, "\n");

/** Strips `-- ...` line comments only. Block comments are rejected outright
 *  below, so there is no `/* *\/` handling to get wrong. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Collapses whitespace runs to a single space and trims, so a statement can be
 *  compared to an exact expected form regardless of line wrapping. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const code = stripLineComments(migration);

/** The executable statements, in file order, with empties removed. */
const statements = code
  .split(";")
  .map((s) => collapse(s))
  .filter((s) => s.length > 0);

/** Executable SQL with every double-quoted identifier blanked out. Keyword
 *  checks run against this so an approved policy name cannot trip them — the
 *  name "Allow authenticated inserts" legitimately contains the English word
 *  "inserts", and must never be mistaken for an INSERT command. */
const codeSansQuotedNames = code.replace(/"[^"]*"/g, '""').toLowerCase();

/** The three approved (policy name, relation) pairs, in required order. */
const APPROVED_DROPS: { policy: string; relation: string }[] = [
  { policy: "Allow Anonymous Uploads xuww7b_0", relation: "storage.objects" },
  { policy: "Allow authenticated inserts", relation: "public.user_goals" },
  { policy: "Allow users to view own goals", relation: "public.user_goals" },
];

/** Strict counterparts that must survive — they must never be named here. */
const STRICT_SURVIVORS = [
  "Users can upload their own swing videos",
  "Users can insert own goals",
  "Users can view own goals",
];

/** The exact five executable statements, positionally. */
const EXPECTED_STATEMENTS = [
  "begin",
  'drop policy "Allow Anonymous Uploads xuww7b_0" on storage.objects',
  'drop policy "Allow authenticated inserts" on public.user_goals',
  'drop policy "Allow users to view own goals" on public.user_goals',
  "commit",
];

const DROP_RE = /^drop\s+policy\s+"([^"]+)"\s+on\s+([a-z_]+\.[a-z_]+)$/;

interface ParsedDrop {
  policy: string;
  relation: string;
  index: number;
}

const parsedDrops: ParsedDrop[] = [];
statements.forEach((stmt, index) => {
  const m = DROP_RE.exec(stmt);
  if (m) parsedDrops.push({ policy: m[1], relation: m[2], index });
});

// ============================================================================
// 1. File encoding and byte hygiene
// ============================================================================
describe("SEC1D — migration file byte hygiene", () => {
  it("exists at the exact authorized path", () => {
    expect(readdirSync(migrationsDir)).toContain(MIGRATION_FILENAME);
  });

  it("has no UTF-8 BOM", () => {
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
// 2. Exhaustive positional executable-statement allowlist
// ============================================================================
describe("SEC1D — exhaustive executable-statement allowlist", () => {
  it("contains exactly five executable statements", () => {
    expect(statements.length).toBe(5);
  });

  it("matches the authorized statement list positionally and completely", () => {
    expect(statements).toEqual(EXPECTED_STATEMENTS);
  });

  it.each(EXPECTED_STATEMENTS.map((s, i) => [i, s] as [number, string]))(
    "statement %i is exactly %s",
    (i, expected) => {
      expect(statements[i]).toBe(expected);
    }
  );
});

// ============================================================================
// 3. Drop targets
// ============================================================================
describe("SEC1D — drop targets", () => {
  it("contains exactly three DROP POLICY statements", () => {
    expect(parsedDrops.length).toBe(3);
    const raw = codeSansQuotedNames.match(/\bdrop\s+policy\b/g) ?? [];
    expect(raw.length).toBe(3);
  });

  it("contains zero CREATE POLICY statements", () => {
    expect(codeSansQuotedNames).not.toMatch(/create\s+policy/);
  });

  it("never uses IF EXISTS", () => {
    expect(codeSansQuotedNames).not.toMatch(/if\s+exists/);
  });

  it.each(APPROVED_DROPS.map((d) => [d.policy, d.relation] as [string, string]))(
    "drops %s on %s exactly once",
    (policy, relation) => {
      const hits = parsedDrops.filter(
        (d) => d.policy === policy && d.relation === relation
      );
      expect(hits.length).toBe(1);
    }
  );

  it("drops the approved pairs in the required order", () => {
    expect(parsedDrops.map((d) => `${d.policy}|${d.relation}`)).toEqual(
      APPROVED_DROPS.map((d) => `${d.policy}|${d.relation}`)
    );
  });

  it("names no policy other than the three approved ones", () => {
    const quoted = code.match(/"[^"]*"/g) ?? [];
    const names = quoted.map((q) => q.slice(1, -1));
    expect(names.length).toBe(3);
    for (const n of names) {
      expect(APPROVED_DROPS.map((d) => d.policy)).toContain(n);
    }
  });

  it("targets only storage.objects and public.user_goals", () => {
    const relations = parsedDrops
      .map((d) => d.relation)
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .sort();
    expect(relations).toEqual(["public.user_goals", "storage.objects"]);
  });
});

// ============================================================================
// 4. Strict counterpart policies must never be named
// ============================================================================
describe("SEC1D — strict counterpart policies are untouched", () => {
  it.each(STRICT_SURVIVORS)("never names %s", (survivor) => {
    expect(rawText).not.toContain(survivor);
  });
});

// ============================================================================
// 5. Forbidden operations (checked with quoted names blanked out)
// ============================================================================
describe("SEC1D — forbidden operations are absent", () => {
  const FORBIDDEN: [string, RegExp][] = [
    ["grant", /\bgrant\b/],
    ["revoke", /\brevoke\b/],
    ["alter function", /alter\s+function/],
    ["security definer", /security\s+definer/],
    ["security invoker", /security\s+invoker/],
    ["search_path", /search_path/],
    ["create", /\bcreate\b/],
    ["insert", /\binsert\b/],
    ["update", /\bupdate\b/],
    ["delete", /\bdelete\b/],
    ["truncate", /\btruncate\b/],
    ["alter table", /alter\s+table/],
    ["alter policy", /alter\s+policy/],
    ["drop table", /drop\s+table/],
    ["rollback", /\brollback\b/],
    ["savepoint", /\bsavepoint\b/],
    ["dollar-quoted body", /\$\$/],
  ];

  it.each(FORBIDDEN)("executable SQL never contains %s", (_label, pattern) => {
    expect(codeSansQuotedNames).not.toMatch(pattern);
  });

  it("the quote-blanking guard does not hide a real INSERT command", () => {
    // Proves the guard is sound: the approved policy name contains "inserts",
    // yet blanking quoted identifiers leaves no INSERT keyword behind.
    expect(code).toContain('"Allow authenticated inserts"');
    expect(codeSansQuotedNames).not.toMatch(/\binsert\b/);
  });
});

// ============================================================================
// 6. Transaction framing
// ============================================================================
describe("SEC1D — transaction framing", () => {
  it("contains exactly one BEGIN and one COMMIT", () => {
    expect(statements.filter((s) => s === "begin").length).toBe(1);
    expect(statements.filter((s) => s === "commit").length).toBe(1);
  });

  it("places BEGIN first", () => {
    expect(statements.indexOf("begin")).toBe(0);
  });

  it("places COMMIT last", () => {
    expect(statements.indexOf("commit")).toBe(statements.length - 1);
  });

  it("wraps every DROP POLICY inside the transaction", () => {
    const beginIdx = statements.indexOf("begin");
    const commitIdx = statements.indexOf("commit");
    for (const d of parsedDrops) {
      expect(d.index).toBeGreaterThan(beginIdx);
      expect(d.index).toBeLessThan(commitIdx);
    }
  });
});

// ============================================================================
// 7. Migration ordering (F3: no duplicated inventory, no total count here;
//    F13: historical ordering, never "is newest")
// ============================================================================
describe("SEC1D — migration ordering", () => {
  const sqlMigrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  it("is present among the checked-in SQL migrations", () => {
    expect(sqlMigrations).toContain(MIGRATION_FILENAME);
  });

  it("sorts after every migration that existed when SEC1D was authored", () => {
    const priorMigrations = migrationsAuthoredBefore(MIGRATION_FILENAME);
    expect(priorMigrations.length).toBe(21);
    expect(sortsAfterAll(MIGRATION_FILENAME, priorMigrations)).toBe(true);
    for (const name of priorMigrations) {
      expect(sqlMigrations).toContain(name);
    }
  });

  it("carries a 14-digit timestamp prefix matching the Supabase CLI format", () => {
    expect(MIGRATION_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});
