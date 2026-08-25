import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const MIGRATION_SUFFIX = "_equipment_user_club_designation.sql";
const MIGRATION_FILE = `supabase/migrations/20260824053500${MIGRATION_SUFFIX}`;
const TYPES_FILE = "types/database.ts";

/**
 * Strips SQL comments so structural assertions describe executable statements
 * only. Without this, a prose line such as "performs no UPDATE, DELETE or
 * backfill" would satisfy a naive substring search for "update" and a
 * negative assertion would fail purely because the file documents its own
 * boundaries. Both `--` line comments and block comments are removed; string
 * literals are preserved because the vocabulary lives inside them.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDollar = false;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (!inSingle && !inDollar && two === "$$") {
      inDollar = true;
      out += two;
      i += 2;
      continue;
    }
    if (inDollar && two === "$$") {
      inDollar = false;
      out += two;
      i += 2;
      continue;
    }
    if (!inSingle && two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inSingle && two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      inSingle = !inSingle;
    }
    out += sql[i];
    i++;
  }

  return out;
}

/**
 * Isolates one `add constraint <name> check ( ... )` body by walking balanced
 * parentheses from the constraint's `check (`. Scoping assertions to a single
 * constraint keeps them from accidentally matching the other one, which shares
 * most of the same vocabulary tokens.
 */
function extractCheckBody(sql: string, constraintName: string): string {
  const marker = `add constraint ${constraintName} check (`;
  const startIdx = sql.indexOf(marker);
  expect(startIdx, `${MIGRATION_FILE}: could not locate "${marker}"`).toBeGreaterThanOrEqual(0);

  let i = startIdx + marker.length;
  let depth = 1;
  while (i < sql.length && depth > 0) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    if (depth > 0) i++;
  }
  expect(depth, `${MIGRATION_FILE}: unbalanced parentheses in ${constraintName}`).toBe(0);

  return sql.slice(startIdx + marker.length, i);
}

/** Every single-quoted token inside a fragment, in source order. */
function quotedTokens(fragment: string): string[] {
  return (fragment.match(/'[^']*'/g) ?? []).map((t) => t.slice(1, -1));
}

/**
 * The `club_designation in ( ... )` list belonging to one club_type branch of
 * the compatibility constraint.
 */
function branchTokens(compatBody: string, clubType: string): string[] {
  const pattern = new RegExp(
    `club_type\\s*=\\s*'${clubType}'::public\\.club_type_enum\\s*\\n?\\s*and club_designation in \\(([^)]*)\\)`
  );
  const match = compatBody.match(pattern);
  expect(match, `${MIGRATION_FILE}: no compatibility branch found for club_type ${clubType}`).not.toBeNull();
  return quotedTokens(match![1]);
}

// The locked EQ-DESIGNATION-S1 V1 vocabulary.
const WOOD = ["2W", "3W", "4W", "5W", "7W", "9W", "11W"];
const HYBRID = ["1H", "2H", "3H", "4H", "5H", "6H", "7H"];
const IRON = ["1I", "2I", "3I", "4I", "5I", "6I", "7I", "8I", "9I", "PW"];
const WEDGE = ["PW", "AW", "GW", "SW", "LW"];
const ALL_TOKENS = Array.from(new Set([...WOOD, ...HYBRID, ...IRON, ...WEDGE]));

const VOCAB_CONSTRAINT = "user_equipment_club_designation_vocabulary";
const COMPAT_CONSTRAINT = "user_equipment_club_designation_club_type_compat";

describe("EQ-DESIGNATION-S1 migration — file selection", () => {
  it("the migration file exists at its exact path", () => {
    expect(existsSync(path.join(repoRoot, MIGRATION_FILE)), `missing file: ${MIGRATION_FILE}`).toBe(true);
  });

  it("exactly one migration carries the designation suffix", () => {
    const dir = path.join(repoRoot, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
    expect(
      files.length,
      `expected exactly one migration ending with ${MIGRATION_SUFFIX}, found ${files.length}`
    ).toBe(1);
    expect(MIGRATION_FILE.endsWith(files[0])).toBe(true);
  });

  it("sorts after the most recent pre-existing equipment migration", () => {
    const dir = path.join(repoRoot, "supabase", "migrations");
    const others = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !f.endsWith(MIGRATION_SUFFIX))
      .sort();
    const mine = path.basename(MIGRATION_FILE);
    expect(mine > others[others.length - 1]).toBe(true);
  });
});

describe("EQ-DESIGNATION-S1 migration — transaction and fail-loud flight checks", () => {
  const source = readSource(MIGRATION_FILE);

  it("wraps the whole migration in a single transaction", () => {
    expect(source).toMatch(/^\s*begin;/m);
    expect(source).toMatch(/\ncommit;\s*$/);
  });

  it("opens and closes the transaction exactly once", () => {
    const sql = stripSqlComments(source);
    expect((sql.match(/^\s*begin;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^\s*commit;/gm) ?? []).length).toBe(1);
  });

  it("contains a fail-loud preflight with numbered EQDS1-PRE-N exceptions", () => {
    expect(source).toContain("PREFLIGHT");
    const numbered = new Set(source.match(/EQDS1-PRE-\d+/g) ?? []);
    expect(numbered.size, "expected multiple distinct EQDS1-PRE-N checks").toBeGreaterThanOrEqual(7);
  });

  it("contains a fail-loud postflight with numbered EQDS1-POST-N exceptions", () => {
    expect(source).toContain("POSTFLIGHT");
    const numbered = new Set(source.match(/EQDS1-POST-\d+/g) ?? []);
    expect(numbered.size, "expected multiple distinct EQDS1-POST-N checks").toBeGreaterThanOrEqual(6);
  });

  it("preflight refuses to run against a drifted club_type_enum", () => {
    expect(source).toMatch(
      /array\['Driver','Wood','Hybrid','Iron','Wedge','Putter'\]/
    );
  });

  it("preflight refuses to re-add an existing column or constraint", () => {
    expect(source).toMatch(/EQDS1-PRE-5[\s\S]{0,120}club_designation already exists/);
    expect(source).toContain(`EQDS1-PRE-6`);
    expect(source).toContain(`EQDS1-PRE-7`);
  });

  it("does not use IF EXISTS / IF NOT EXISTS to hide schema drift on DDL", () => {
    const sql = stripSqlComments(source);
    const ddl = sql.match(/^\s*alter table[\s\S]*?;/gm) ?? [];
    expect(ddl.length).toBeGreaterThan(0);
    for (const statement of ddl) {
      expect(statement.toLowerCase()).not.toMatch(/if\s+(not\s+)?exists/);
    }
  });
});

describe("EQ-DESIGNATION-S1 migration — the column", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));

  it("adds club_designation to public.user_equipment as text", () => {
    expect(sql).toMatch(
      /alter table public\.user_equipment\s*\n?\s*add column club_designation text\s*;/
    );
  });

  it("adds the column nullable — never NOT NULL", () => {
    const addColumn = sql.match(/add column club_designation[^;]*;/)![0];
    expect(addColumn.toLowerCase()).not.toContain("not null");
  });

  it("assigns no default and no generated value", () => {
    const addColumn = sql.match(/add column club_designation[^;]*;/)![0];
    expect(addColumn.toLowerCase()).not.toContain("default");
    expect(addColumn.toLowerCase()).not.toContain("generated");
  });

  it("adds exactly one column", () => {
    expect((sql.match(/add column/g) ?? []).length).toBe(1);
  });

  it("postflight verifies the column is text, nullable, and default-free", () => {
    const source = readSource(MIGRATION_FILE);
    expect(source).toMatch(/EQDS1-POST-2[\s\S]{0,140}expected text/);
    expect(source).toMatch(/EQDS1-POST-3[\s\S]{0,120}not nullable/);
    expect(source).toMatch(/EQDS1-POST-4[\s\S]{0,140}default/);
  });
});

describe("EQ-DESIGNATION-S1 migration — global vocabulary constraint", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));
  const body = extractCheckBody(sql, VOCAB_CONSTRAINT);

  it("exists as a declarative table CHECK constraint", () => {
    expect(sql).toContain(`add constraint ${VOCAB_CONSTRAINT} check (`);
  });

  it("permits NULL", () => {
    expect(body).toMatch(/club_designation is null/);
  });

  it("permits exactly the locked 28 distinct tokens", () => {
    const tokens = quotedTokens(body);
    expect(tokens.length, "vocabulary must list each token exactly once").toBe(28);
    expect(new Set(tokens).size).toBe(28);
    expect([...tokens].sort()).toEqual([...ALL_TOKENS].sort());
  });

  it("does not admit Driver, Putter, or a sentinel for unknown", () => {
    const tokens = quotedTokens(body);
    for (const forbidden of ["Driver", "Putter", "Unknown", "Other", "Custom"]) {
      expect(tokens, `"${forbidden}" must not be a designation value`).not.toContain(forbidden);
    }
  });
});

describe("EQ-DESIGNATION-S1 migration — club_type compatibility constraint", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));
  const body = extractCheckBody(sql, COMPAT_CONSTRAINT);

  it("exists as a declarative table CHECK constraint", () => {
    expect(sql).toContain(`add constraint ${COMPAT_CONSTRAINT} check (`);
  });

  it("permits NULL for every club type", () => {
    expect(body).toMatch(/club_designation is null/);
  });

  it("Wood accepts exactly its seven designations", () => {
    expect(branchTokens(body, "Wood").sort()).toEqual([...WOOD].sort());
  });

  it("Hybrid accepts exactly its seven designations", () => {
    expect(branchTokens(body, "Hybrid").sort()).toEqual([...HYBRID].sort());
  });

  it("Iron accepts exactly 1I-9I plus PW", () => {
    expect(branchTokens(body, "Iron").sort()).toEqual([...IRON].sort());
  });

  it("Wedge accepts exactly PW, AW, GW, SW, LW", () => {
    expect(branchTokens(body, "Wedge").sort()).toEqual([...WEDGE].sort());
  });

  it("Driver has no permitted non-null designation", () => {
    expect(body).not.toMatch(/club_type\s*=\s*'Driver'/);
  });

  it("Putter has no permitted non-null designation", () => {
    expect(body).not.toMatch(/club_type\s*=\s*'Putter'/);
  });

  it("branches on exactly the four club types that carry a designation", () => {
    const branched = (body.match(/club_type\s*=\s*'([A-Za-z]+)'/g) ?? []).map(
      (m) => m.replace(/.*'([A-Za-z]+)'.*/, "$1")
    );
    expect(Array.from(new Set(branched)).sort()).toEqual(["Hybrid", "Iron", "Wedge", "Wood"]);
  });

  it("PW is shared by Iron and Wedge", () => {
    expect(branchTokens(body, "Iron")).toContain("PW");
    expect(branchTokens(body, "Wedge")).toContain("PW");
  });
});

describe("EQ-DESIGNATION-S1 migration — scope boundaries", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("never modifies or replaces the existing catalog-validation function", () => {
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(sql).not.toContain("validate_user_equipment_catalog_reference");
    expect(sql).not.toMatch(/drop\s+function/i);
  });

  it("never modifies or replaces the existing catalog-validation trigger", () => {
    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/drop\s+trigger/i);
    expect(sql).not.toMatch(/alter\s+trigger/i);
    expect(sql).not.toContain("user_equipment_validate_catalog_reference");
  });

  it("performs no backfill or user-equipment UPDATE", () => {
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/^\s*update\s+/im);
  });

  it("performs no DELETE and no TRUNCATE", () => {
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
  });

  it("performs no INSERT", () => {
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
  });

  it("makes no RLS change", () => {
    expect(sql).not.toMatch(/row\s+level\s+security/i);
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
    expect(sql).not.toMatch(/alter\s+policy/i);
  });

  it("makes no grant or revoke change", () => {
    expect(sql).not.toMatch(/^\s*grant\b/im);
    expect(sql).not.toMatch(/^\s*revoke\b/im);
  });

  it("adds no index and no uniqueness constraint", () => {
    expect(sql).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(sql).not.toMatch(/add\s+constraint[^;]*\bunique\b/i);
    expect(sql).not.toMatch(/\bprimary\s+key\b/i);
  });

  it("touches no catalog table", () => {
    for (const table of [
      "equipment_models",
      "equipment_manufacturers",
      "equipment_model_sources",
      "equipment_putter_model_specs",
    ]) {
      expect(sql, `${table} must not be altered by this slice`).not.toMatch(
        new RegExp(`alter table public\\.${table}`, "i")
      );
    }
  });

  it("alters only public.user_equipment", () => {
    const altered = new Set(
      (sql.match(/alter table public\.(\w+)/g) ?? []).map((m) => m.split(".")[1])
    );
    expect(Array.from(altered)).toEqual(["user_equipment"]);
  });

  it("makes no swing_analysis or equipment-snapshot change", () => {
    expect(sql).not.toContain("swing_analysis");
    expect(sql).not.toContain("equipment_snapshot");
    expect(sql).not.toContain("analysis_family");
  });

  it("does not drop or rename any existing user_equipment column", () => {
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/rename\s+column/i);
    for (const legacy of ["brand", "model", "custom_club", "loft_deg", "is_primary"]) {
      expect(sql).not.toMatch(new RegExp(`drop column ${legacy}`, "i"));
    }
  });

  it("preserves the club_type NOT NULL invariant in both flight checks", () => {
    expect(source).toMatch(/EQDS1-PRE-4[\s\S]{0,140}NOT NULL/);
    expect(source).toMatch(/EQDS1-POST-7[\s\S]{0,140}NOT NULL/);
  });

  it("runs no sample INSERT or UPDATE inside the flight blocks", () => {
    expect(sql).not.toMatch(/\bvalues\s*\(/i);
  });
});

describe("EQ-DESIGNATION-S1 TypeScript contracts", () => {
  const types = readSource(TYPES_FILE);

  function interfaceBlock(name: string): string {
    const start = types.indexOf(`export interface ${name}`);
    expect(start, `${TYPES_FILE}: missing interface ${name}`).toBeGreaterThanOrEqual(0);
    const end = types.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return types.slice(start, end);
  }

  it("exports ClubDesignation", () => {
    expect(types).toMatch(/export type ClubDesignation =/);
  });

  it("ClubDesignation lists exactly the locked 28 tokens", () => {
    const start = types.indexOf("export type ClubDesignation =");
    const end = types.indexOf(";", start);
    expect(end).toBeGreaterThan(start);
    const union = types.slice(start, end);
    const tokens = (union.match(/"[^"]+"/g) ?? []).map((t) => t.slice(1, -1));
    expect(tokens.length, "each token must appear exactly once").toBe(28);
    expect(new Set(tokens).size).toBe(28);
    expect([...tokens].sort()).toEqual([...ALL_TOKENS].sort());
  });

  it("ClubDesignation admits no Driver, Putter, or unknown sentinel", () => {
    const start = types.indexOf("export type ClubDesignation =");
    const union = types.slice(start, types.indexOf(";", start));
    for (const forbidden of ["Driver", "Putter", "Unknown", "Other", "Custom"]) {
      expect(union).not.toContain(`"${forbidden}"`);
    }
  });

  it("UserEquipment carries club_designation typed as ClubDesignation | null", () => {
    expect(interfaceBlock("UserEquipment")).toMatch(
      /club_designation:\s*ClubDesignation\s*\|\s*null;/
    );
  });

  it("UserEquipment still preserves its catalog references and legacy/custom fields", () => {
    const block = interfaceBlock("UserEquipment");
    for (const field of [
      "manufacturer_id", "equipment_model_id", "brand", "model",
      "custom_club", "custom_brand", "custom_model", "custom_notes",
      "shaft_flex", "shaft_weight", "loft_deg", "is_primary",
    ]) {
      expect(block, `UserEquipment missing "${field}"`).toContain(field);
    }
  });

  it("ClubType is unchanged — still exactly the six club_type_enum values", () => {
    expect(types).toContain(
      'export type ClubType = "Driver" | "Wood" | "Hybrid" | "Iron" | "Wedge" | "Putter";'
    );
  });

  it("EquipmentSnapshotV1 is unchanged by this slice — no designation field", () => {
    const block = interfaceBlock("EquipmentSnapshotV1");
    expect(block).toContain("schema_version: 1");
    expect(block, "snapshot V2 is a separately gated slice").not.toContain("club_designation");
  });

  it("adds no designation field to the canonical model or putter-spec types", () => {
    expect(interfaceBlock("EquipmentModel")).not.toContain("club_designation");
    expect(interfaceBlock("EquipmentPutterModelSpecs")).not.toContain("club_designation");
  });
});
