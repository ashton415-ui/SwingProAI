import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  DRILLS_DRILL_FAMILY_FOUNDATION_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

// ============================================================================
// Unit S — the canonical drill catalog gains an authoritative mechanical family
// ============================================================================
//
// A static source-contract suite over the generated migration, the shared type
// and the centralized migration inventory, in the established style of this
// repository's other schema suites. No database is contacted, no network, no
// jsdom, no Supabase client.
//
// The one property every assertion here serves: after this migration a drill's
// family is a column, not a convention. A consumer that filters on drill_family
// relies on something the database enforces. A consumer that guessed from
// target_metric or from a drill's name would rely on nothing, which is the
// situation this migration ends.
//
// Two rules govern how these assertions are written.
//
// Negative assertions run against comment-stripped SQL, and they name the
// statement they forbid rather than searching the whole file for a word. The
// migration's header explains at length what it must never do, and its own
// postflight has to read column_default in order to prove no default exists —
// so a bare search for "default" would fail on the very code that proves the
// rule. A test that cannot pass against a correct migration is not a strict
// test, it is a broken one.
//
// Vocabulary assertions extract from both sources and compare the extracted
// sets. Writing the two expected strings twice would pass whether or not the
// database and TypeScript agreed, which is the only thing worth checking.
//
// Sets are read with Array.from rather than spread: tsconfig sets no target and
// no downlevelIteration, so spreading an iterator is a TS2802 compile error.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATION_FILENAME = "20260912042450_drills_drill_family_foundation.sql";

const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
const migrationPath = path.join(migrationsDir, MIGRATION_FILENAME);

const rawSql = readFileSync(migrationPath, "utf8");
const typesSource = readFileSync(path.join(__dirname, "..", "types", "database.ts"), "utf8");
const inventorySource = readFileSync(path.join(__dirname, "migration-inventory.ts"), "utf8");

/**
 * The SQL with every comment removed.
 *
 * Line comments only: this migration has no block comments, and handling a form
 * the file does not use would be untested code. A `--` inside a string literal
 * is left alone, because prose inside quotes is still part of the statement.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "'") {
          inString = !inString;
          continue;
        }
        if (!inString && ch === "-" && line[i + 1] === "-") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

const code = stripSqlComments(rawSql);
const lowered = code.toLowerCase();

/** The literals inside the drill_family CHECK constraint. */
const CHECK_RE =
  /add\s+constraint\s+drills_drill_family_check\s+check\s*\(\s*drill_family\s+in\s*\(([^)]*)\)\s*\)/i;

/** The literals inside the DrillFamily union in types/database.ts. */
const TYPE_RE = /export\s+type\s+DrillFamily\s*=\s*([^;]+);/;

/**
 * Pulls the quoted literals out of one captured vocabulary.
 *
 * Throws rather than returning an empty set when the pattern does not match. A
 * regex that silently matched nothing would make every comparison below
 * trivially true, which is the specific way a drift test stops working.
 */
function literals(source: string, re: RegExp, label: string): Set<string> {
  const match = source.match(re);
  if (!match) {
    throw new Error(`${label}: vocabulary not found — this test cannot pass vacuously`);
  }
  const found = Array.from(match[1].matchAll(/['"]([a-z_]+)['"]/g)).map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(`${label}: pattern matched but yielded no literals`);
  }
  return new Set(found);
}

/** Sorted members of a vocabulary. Array.from, never spread — see the header. */
function sorted(values: Set<string>): string[] {
  return Array.from(values).sort();
}

/** The five legacy drills this migration is allowed to classify from evidence. */
const LEGACY_PAIRS: [string, string][] = [
  ["One-Piece Takeaway", "takeaway_connection"],
  ["Pump Drill", "downswing_path"],
  ["Shaft Plane Stick Drill", "laid_off_p4"],
  ["Towel Under Arm", "arm_connection"],
  ["Wall Hip Turn Drill", "early_extension"],
];

describe("drill-family migration — identity and registration", () => {
  it("exists at the frozen filename", () => {
    expect(readdirSync(migrationsDir)).toContain(MIGRATION_FILENAME);
  });

  it("is the filename the inventory exports", () => {
    expect(DRILLS_DRILL_FAMILY_FOUNDATION_FILENAME).toBe(MIGRATION_FILENAME);
  });

  it("is registered in APPROVED_MIGRATIONS exactly once", () => {
    const occurrences = APPROVED_MIGRATIONS.filter((m) => m === MIGRATION_FILENAME);
    expect(occurrences).toHaveLength(1);
  });

  it("keeps EXPECTED_MIGRATION_COUNT derived rather than hard-coded", () => {
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
    expect(inventorySource).toContain("EXPECTED_MIGRATION_COUNT = APPROVED_MIGRATIONS.length");
  });

  it("names the migration exactly once in the inventory source", () => {
    const occurrences = Array.from(
      inventorySource.matchAll(/20260912042450_drills_drill_family_foundation\.sql/g),
    );
    expect(occurrences).toHaveLength(1);
  });

  it("sorts after every migration that existed when it was authored", () => {
    const earlier = migrationsAuthoredBefore(MIGRATION_FILENAME);
    expect(earlier).toHaveLength(31);
    expect(sortsAfterAll(MIGRATION_FILENAME, earlier)).toBe(true);
  });

  it("leaves the inventory a closed world over the migrations on disk", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
  });
});

describe("drill-family migration — the column contract", () => {
  it("adds drill_family as text", () => {
    expect(code).toMatch(/add\s+column\s+drill_family\s+text/i);
  });

  it("ends with the column required", () => {
    expect(code).toMatch(/alter\s+column\s+drill_family\s+set\s+not\s+null/i);
  });

  it("gives the column no default, permanent or transitional", () => {
    expect(code).not.toMatch(/add\s+column\s+drill_family[^;]*\bdefault\b/i);
    expect(code).not.toMatch(/alter\s+column\s+drill_family\s+set\s+default/i);
  });

  it("proves in its own postflight that no default survived", () => {
    expect(code).toMatch(/v_default\s+is\s+not\s+null/i);
    expect(code).toContain("DRILL-FAMILY-POST-04");
  });

  it("names the constraint exactly", () => {
    expect(code).toContain("drills_drill_family_check");
  });

  it("documents the column and separates it from swing_analysis.analysis_family", () => {
    expect(rawSql).toMatch(/comment\s+on\s+column\s+public\.drills\.drill_family\s+is/i);
    expect(rawSql).toContain("public.swing_analysis.analysis_family");
  });

  it("adds no index", () => {
    expect(lowered).not.toContain("create index");
  });
});

describe("drill-family migration — the family vocabulary", () => {
  it("admits exactly full_swing and putting in the database", () => {
    const db = literals(code, CHECK_RE, "migration CHECK");
    expect(db.size).toBe(2);
    expect(sorted(db)).toEqual(["full_swing", "putting"]);
  });

  it("declares exactly full_swing and putting in TypeScript", () => {
    const ts = literals(typesSource, TYPE_RE, "DrillFamily union");
    expect(ts.size).toBe(2);
    expect(sorted(ts)).toEqual(["full_swing", "putting"]);
  });

  it("keeps the database and TypeScript vocabularies identical", () => {
    const db = literals(code, CHECK_RE, "migration CHECK");
    const ts = literals(typesSource, TYPE_RE, "DrillFamily union");
    expect(sorted(db)).toEqual(sorted(ts));
  });

  it("keeps DrillFamily a type of its own rather than an alias", () => {
    expect(typesSource).not.toMatch(/export\s+type\s+DrillFamily\s*=\s*AnalysisFamily\s*;/);
    expect(typesSource).toContain('export type AnalysisFamily = "full_swing" | "putting";');
  });
});

describe("drill-family migration — atomicity and ordering", () => {
  it("owns its transaction explicitly", () => {
    expect(code).toMatch(/^begin;$/m);
    expect(code).toMatch(/^commit;$/m);
  });

  it("takes the strictest lock before reading any drill row", () => {
    const lockAt = code.search(/lock\s+table\s+public\.drills\s+in\s+access\s+exclusive\s+mode/i);
    const firstRowRead = code.indexOf("from public.drills d");
    expect(lockAt).toBeGreaterThan(-1);
    expect(firstRowRead).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstRowRead);
  });

  it("validates legacy rows before adding the column", () => {
    const validationAt = code.indexOf("DRILL-FAMILY-PRE-04");
    const addColumnAt = code.search(/add\s+column\s+drill_family/i);
    expect(validationAt).toBeGreaterThan(-1);
    expect(addColumnAt).toBeGreaterThan(-1);
    expect(validationAt).toBeLessThan(addColumnAt);
  });

  it("asserts the backfill before enforcing NOT NULL", () => {
    const assertionAt = code.indexOf("DRILL-FAMILY-POST-01");
    const notNullAt = code.search(/set\s+not\s+null/i);
    expect(assertionAt).toBeGreaterThan(-1);
    expect(assertionAt).toBeLessThan(notNullAt);
  });

  it("tests for NULL explicitly rather than relying on NOT IN", () => {
    expect(code).toMatch(/drill_family\s+is\s+null/i);
  });
});

describe("drill-family migration — legacy classification", () => {
  it.each(LEGACY_PAIRS)("classifies the legacy drill %s / %s", (name, metric) => {
    expect(code).toContain(`'${name}'`);
    expect(code).toContain(`'${metric}'`);
  });

  it("carries exactly the five frozen legacy pairs, twice each", () => {
    for (const pair of LEGACY_PAIRS) {
      const occurrences = Array.from(code.matchAll(new RegExp(`'${pair[0]}'`, "g")));
      expect(occurrences).toHaveLength(2);
    }
  });

  it("classifies positively, never by an ELSE or a COALESCE", () => {
    expect(lowered).not.toContain("else 'full_swing'");
    expect(lowered).not.toContain("coalesce");
  });

  it("assigns full_swing and never assigns putting", () => {
    expect(code).toMatch(/set\s+drill_family\s*=\s*'full_swing'/i);
    expect(code).not.toMatch(/set\s+drill_family\s*=\s*'putting'/i);
  });

  it("aborts rather than guessing when an unrecognised drill exists", () => {
    expect(code).toContain("DRILL-FAMILY-PRE-04");
    expect(code).toMatch(/raise\s+exception/i);
  });

  it("makes no assumption about how many drills exist", () => {
    expect(code).not.toMatch(/count\(\*\)\s*(=|<>|!=)\s*\d/);
    expect(code).not.toMatch(/v_count\s*(=|<>|!=)\s*5\b/);
  });

  it("identifies legacy rows by name and metric, never by id", () => {
    const uuidLike = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(rawSql).not.toMatch(uuidLike);
  });
});

describe("drill-family migration — what it must never become", () => {
  it("seeds no drill", () => {
    expect(lowered).not.toContain("insert into");
  });

  it("creates no table and no second identity catalog", () => {
    expect(lowered).not.toContain("create table");
    expect(lowered).not.toContain("putting_drills");
    expect(lowered).not.toContain("drill_families");
  });

  it("creates no enum", () => {
    expect(lowered).not.toContain("create type");
  });

  it("changes no policy, grant or revoke", () => {
    for (const forbidden of [
      "create policy",
      "drop policy",
      "alter policy",
      "grant ",
      "revoke ",
      "enable row level security",
    ]) {
      expect(lowered).not.toContain(forbidden);
    }
  });

  it("mutates no other application table", () => {
    expect(code).not.toMatch(
      /(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table)\s+(public\.)?(user_drills|automated_prescriptions|swing_analysis)\b/i,
    );
  });

  it("leaves no ongoing target_metric-derived family authority", () => {
    const check = code.match(CHECK_RE);
    expect(check).not.toBeNull();
    expect((check as RegExpMatchArray)[0].toLowerCase()).not.toContain("target_metric");
    expect(lowered).not.toContain("create trigger");
    expect(lowered).not.toContain("generated always as");
  });
});

describe("drill-family migration — the assertions are not vacuous", () => {
  it("detects a vocabulary that gained a third value", () => {
    const mutated = code.replace(
      "check (drill_family in ('full_swing', 'putting'))",
      "check (drill_family in ('full_swing', 'putting', 'chip'))",
    );
    expect(mutated).not.toBe(code);
    const db = literals(mutated, CHECK_RE, "mutated CHECK");
    expect(db.size).toBe(3);
    expect(sorted(db)).not.toEqual(["full_swing", "putting"]);
  });

  it("detects a vocabulary that lost a value", () => {
    const mutated = code.replace(
      "check (drill_family in ('full_swing', 'putting'))",
      "check (drill_family in ('full_swing'))",
    );
    expect(mutated).not.toBe(code);
    expect(literals(mutated, CHECK_RE, "mutated CHECK").size).toBe(1);
  });

  it("detects a renamed constraint", () => {
    const mutated = code.replace(/drills_drill_family_check/g, "drills_family_check");
    expect(mutated).not.toBe(code);
    expect(() => literals(mutated, CHECK_RE, "renamed CHECK")).toThrow(/cannot pass vacuously/);
  });

  it("detects a DrillFamily union that drifted from the database", () => {
    const mutated = typesSource.replace(
      'export type DrillFamily = "full_swing" | "putting";',
      'export type DrillFamily = "full_swing" | "putting" | "chip";',
    );
    expect(mutated).not.toBe(typesSource);
    const ts = literals(mutated, TYPE_RE, "mutated DrillFamily");
    const db = literals(code, CHECK_RE, "migration CHECK");
    expect(sorted(ts)).not.toEqual(sorted(db));
  });

  it("detects a DrillFamily declaration that disappeared", () => {
    const mutated = typesSource.replace(
      'export type DrillFamily = "full_swing" | "putting";',
      "",
    );
    expect(mutated).not.toBe(typesSource);
    expect(() => literals(mutated, TYPE_RE, "removed DrillFamily")).toThrow(
      /cannot pass vacuously/,
    );
  });

  it("detects a lock removed from in front of the validation it protects", () => {
    const mutated = code.replace("lock table public.drills in access exclusive mode;\n", "");
    expect(mutated).not.toBe(code);
    expect(mutated.search(/lock\s+table\s+public\.drills/i)).toBe(-1);
  });

  it("detects a default that would let an omitted family look valid", () => {
    const mutated = code.replace(
      "add column drill_family text;",
      "add column drill_family text default 'full_swing';",
    );
    expect(mutated).not.toBe(code);
    expect(mutated).toMatch(/add\s+column\s+drill_family[^;]*\bdefault\b/i);
  });

  it("detects a classification that swept unknown rows into full_swing", () => {
    const mutated = code.replace(
      "   set drill_family = 'full_swing'",
      "   set drill_family = coalesce(drill_family, 'full_swing')",
    );
    expect(mutated).not.toBe(code);
    expect(mutated.toLowerCase()).toContain("coalesce");
  });

  it("strips comments without disturbing the statements", () => {
    expect(rawSql).toContain("No DEFAULT is given at any point");
    expect(code).not.toContain("No DEFAULT is given at any point");
    expect(code).toContain("add column drill_family text;");
    expect(code).toContain("public.swing_analysis.analysis_family");
  });
});
