import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationsAuthoredBefore, sortsAfterAll } from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const MIGRATION_SUFFIX = "_equipment_snapshot_v2.sql";
const MIGRATION_FILE = `supabase/migrations/20260825023500${MIGRATION_SUFFIX}`;
const TYPES_FILE = "types/database.ts";

/**
 * Strips SQL comments so structural assertions describe executable statements
 * only. Without this, prose such as "performs no UPDATE, DELETE, INSERT or
 * backfill" would satisfy a naive search and a negative assertion would fail
 * purely because the file documents its own boundaries. String literals are
 * preserved because the emitted snapshot keys live inside them.
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

/** The body of the replaced snapshot function, from its `as $function$` marker. */
function replacementFunctionBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.apply_swing_analysis_equipment_snapshot()");
  expect(start, `${MIGRATION_FILE}: could not locate the CREATE OR REPLACE`).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf("$function$", start);
  const bodyEnd = sql.indexOf("$function$;", bodyStart + 1);
  expect(bodyEnd, `${MIGRATION_FILE}: unterminated $function$ body`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

/** The `jsonb_build_object( ... )` argument list that builds the snapshot. */
function snapshotObject(fnBody: string): string {
  const marker = "new.equipment_snapshot := jsonb_build_object(";
  const start = fnBody.indexOf(marker);
  expect(start, `${MIGRATION_FILE}: could not locate the snapshot builder`).toBeGreaterThanOrEqual(0);

  let i = start + marker.length;
  let depth = 1;
  while (i < fnBody.length && depth > 0) {
    if (fnBody[i] === "(") depth++;
    else if (fnBody[i] === ")") depth--;
    if (depth > 0) i++;
  }
  expect(depth, `${MIGRATION_FILE}: unbalanced parentheses in the snapshot builder`).toBe(0);
  return fnBody.slice(start + marker.length, i);
}

/** Top-level `'key',` names in the snapshot builder, ignoring nested objects. */
function topLevelKeys(objectArgs: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let expectKey = true;

  while (i < objectArgs.length) {
    const ch = objectArgs[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      expectKey = !expectKey;
    } else if (ch === "'" && depth === 0 && expectKey) {
      const end = objectArgs.indexOf("'", i + 1);
      if (end > i) {
        keys.push(objectArgs.slice(i + 1, end));
        i = end;
      }
    }
    i++;
  }
  return keys;
}

// The locked D1 vocabulary, mirrored here so a drifted migration cannot quietly
// redefine what the preflight is supposed to be proving.
const WOOD = ["2W", "3W", "4W", "5W", "7W", "9W", "11W"];
const HYBRID = ["1H", "2H", "3H", "4H", "5H", "6H", "7H"];
const IRON = ["1I", "2I", "3I", "4I", "5I", "6I", "7I", "8I", "9I", "PW"];
const WEDGE = ["PW", "AW", "GW", "SW", "LW"];
const ALL_TOKENS = Array.from(new Set([...WOOD, ...HYBRID, ...IRON, ...WEDGE]));

/** Exactly the 15 keys a V2 snapshot must carry, in emitted order. */
const V2_KEYS = [
  "schema_version",
  "captured_at",
  "equipment_id",
  "club_type",
  "club_designation",
  "manufacturer",
  "model",
  "entered_brand",
  "entered_model",
  "custom_club",
  "custom_brand",
  "custom_model",
  "shaft_flex",
  "shaft_weight_grams",
  "loft_deg",
];

describe("EQ-DESIGNATION D2 migration — file selection", () => {
  it("the migration file exists at its exact path", () => {
    expect(existsSync(path.join(repoRoot, MIGRATION_FILE)), `missing file: ${MIGRATION_FILE}`).toBe(true);
  });

  it("exactly one migration carries the snapshot-v2 suffix", () => {
    const dir = path.join(repoRoot, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
    expect(
      files.length,
      `expected exactly one migration ending with ${MIGRATION_SUFFIX}, found ${files.length}`
    ).toBe(1);
    expect(MIGRATION_FILE.endsWith(files[0])).toBe(true);
  });

  // Asserts this migration's own historical contract — it was authored after
  // everything that already existed — rather than "it is the newest file on
  // disk", which would silently expire the moment a later migration lands.
  it("sorts after every migration that existed when this one was authored", () => {
    const mine = path.basename(MIGRATION_FILE);
    expect(sortsAfterAll(mine, migrationsAuthoredBefore(mine))).toBe(true);
  });
});

describe("EQ-DESIGNATION D2 migration — transaction and flight checks", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("wraps the whole migration in a single transaction", () => {
    expect(source).toMatch(/^\s*begin;/m);
    expect(source).toMatch(/\ncommit;\s*$/);
    expect((sql.match(/^\s*begin;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^\s*commit;/gm) ?? []).length).toBe(1);
  });

  it("contains a fail-loud preflight with numbered EQDS2-PRE-N exceptions", () => {
    expect(source).toContain("PREFLIGHT");
    const numbered = new Set(source.match(/EQDS2-PRE-\d+/g) ?? []);
    expect(numbered.size, "expected many distinct EQDS2-PRE-N checks").toBeGreaterThanOrEqual(20);
  });

  it("contains a fail-loud postflight with numbered EQDS2-POST-N exceptions", () => {
    expect(source).toContain("POSTFLIGHT");
    const numbered = new Set(source.match(/EQDS2-POST-\d+/g) ?? []);
    expect(numbered.size, "expected multiple distinct EQDS2-POST-N checks").toBeGreaterThanOrEqual(8);
  });

  it("does not use IF EXISTS / IF NOT EXISTS to hide drift on DDL", () => {
    const ddl = sql.match(/^\s*(alter table|create or replace function)[\s\S]*?;/gm) ?? [];
    for (const statement of ddl) {
      expect(statement.toLowerCase()).not.toMatch(/if\s+(not\s+)?exists/);
    }
  });
});

describe("EQ-DESIGNATION D2 migration — D1 physical prerequisite", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("guards that user_equipment.club_designation exists before doing anything", () => {
    expect(source).toMatch(/EQDS2-PRE-5[\s\S]{0,240}club_designation does not exist/);
  });

  it("guards the exact text / nullable / no-default / never-generated column contract", () => {
    expect(sql).toMatch(
      /column_name = 'club_designation'\s*\n?\s*and data_type = 'text' and is_nullable = 'YES' and column_default is null\s*\n?\s*and is_generated = 'NEVER'/
    );
  });

  it("rejects a domain over text, which information_schema still reports as text", () => {
    expect(sql).toContain("domain_name is null and domain_schema is null");
    expect(source).toMatch(/EQDS2-PRE-6[\s\S]{0,240}not a domain/);
  });

  it("rejects an identity column", () => {
    expect(sql).toContain("identity_generation is not null");
    expect(source).toMatch(/EQDS2-PRE-29[\s\S]{0,200}identity column/);
  });

  it("guards the club_type enum contract and NOT NULL", () => {
    expect(sql).toContain("array['Driver','Wood','Hybrid','Iron','Wedge','Putter']");
    expect(sql).toMatch(/column_name = 'club_type' and is_nullable = 'NO'/);
  });

  it("requires both D1 constraints to be validated, non-inheriting CHECKs on user_equipment", () => {
    for (const name of [
      "user_equipment_club_designation_vocabulary",
      "user_equipment_club_designation_club_type_compat",
    ]) {
      const idx = sql.indexOf(`con.conname = '${name}'`);
      expect(idx, `${MIGRATION_FILE}: no catalog lookup for ${name}`).toBeGreaterThanOrEqual(0);
      const window = sql.slice(Math.max(0, idx - 200), idx + 200);
      expect(window, `${name} must be scoped to public.user_equipment`).toContain(
        "con.conrelid = 'public.user_equipment'::regclass"
      );
      expect(window, `${name} must be checked as contype 'c'`).toContain("con.contype = 'c'");
      expect(window, `${name} must be checked as validated`).toContain("con.convalidated");
      expect(window, `${name} must be checked as non-inheriting`).toContain("not con.connoinherit");
    }
  });

  it("performs every prerequisite guard before replacing the function", () => {
    const lastPre = sql.lastIndexOf("EQDS2-PRE-");
    const replacement = sql.indexOf("create or replace function public.apply_swing_analysis_equipment_snapshot()");
    expect(replacement).toBeGreaterThan(lastPre);
  });

  it("never repairs a missing or drifted prerequisite", () => {
    const preflight = sql.slice(0, sql.indexOf("create or replace function"));
    expect(preflight.toLowerCase()).not.toMatch(/alter table|add column|add constraint/);
  });
});

describe("EQ-DESIGNATION D2 migration — canonical reference relation", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));

  it("creates exactly one temporary reference relation, by its exact name", () => {
    expect((sql.match(/create\s+temp\s+table/gi) ?? []).length).toBe(1);
    expect(sql).toContain("create temp table eqds2_reference_designation_contract (");
  });

  it("drops the reference relation at commit", () => {
    expect(sql).toContain("on commit drop;");
  });

  it("never creates a persistent or unlogged table", () => {
    // `create temp table` does not contain the contiguous phrase `create table`.
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/create\s+unlogged/i);
    expect(sql).not.toMatch(/create\s+temporary\s+table/i);
  });

  it("never uses IF NOT EXISTS on the reference DDL", () => {
    const ddl = sql.slice(sql.indexOf("create temp table"), sql.indexOf("on commit drop;"));
    expect(ddl.toLowerCase()).not.toContain("if not exists");
  });

  it("never populates the reference relation", () => {
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
    // A COPY statement, not the word "copy" inside an exception message.
    expect(sql).not.toMatch(/^\s*copy\s+/im);
    expect(sql).not.toMatch(/eqds2_reference_designation_contract\s+values/i);
  });

  it("declares the reference columns with production types", () => {
    const ddl = sql.slice(sql.indexOf("create temp table"), sql.indexOf("on commit drop;"));
    expect(ddl).toContain("club_designation text");
    expect(ddl).toContain("club_type public.club_type_enum");
  });

  it("declares both canonical reference constraints", () => {
    expect(sql).toContain("constraint eqds2_reference_vocabulary check (");
    expect(sql).toContain("constraint eqds2_reference_club_type_compat check (");
  });

  it("creates the reference relation before the function replacement", () => {
    expect(sql.indexOf("create temp table")).toBeLessThan(
      sql.indexOf("create or replace function public.apply_swing_analysis_equipment_snapshot()")
    );
  });
});

describe("EQ-DESIGNATION D2 migration — physical type and collation context", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("resolves the actual column through pg_attribute on public.user_equipment", () => {
    expect(sql).toMatch(
      /att\.attrelid = 'public\.user_equipment'::regclass\s*\n?\s*and att\.attname = 'club_designation'/
    );
  });

  it("resolves the reference column through pg_attribute on the pg_temp relation", () => {
    expect(sql).toMatch(
      /att\.attrelid = 'pg_temp\.eqds2_reference_designation_contract'::regclass\s*\n?\s*and att\.attname = 'club_designation'/
    );
  });

  it("excludes dropped and system attributes on every lookup", () => {
    const lookups = sql.match(/att\.attnum > 0 and not att\.attisdropped/g) ?? [];
    expect(lookups.length).toBe(4);
  });

  it("reads both atttypid and attcollation for actual and reference", () => {
    expect((sql.match(/att\.atttypid from pg_attribute/g) ?? []).length).toBe(2);
    expect((sql.match(/att\.attcollation from pg_attribute/g) ?? []).length).toBe(2);
    expect(sql).toContain(
      "into v_actual_typid, v_actual_collation, v_reference_typid, v_reference_collation;"
    );
  });

  it("pins both sides to pg_catalog.text outright, rejecting substitute types", () => {
    expect(sql).toContain("v_actual_typid is distinct from 'pg_catalog.text'::regtype");
    expect(sql).toContain("v_reference_typid is distinct from 'pg_catalog.text'::regtype");
    expect(sql).toContain("v_actual_typid is distinct from v_reference_typid");
    expect(source).toMatch(/EQDS2-PRE-31[\s\S]{0,300}pg_catalog\.text/);
  });

  it("requires actual and reference collations to be exactly equal", () => {
    expect(sql).toContain("v_actual_collation is distinct from v_reference_collation");
    expect(source).toMatch(/EQDS2-PRE-32[\s\S]{0,300}collation/);
  });

  it("pins collation by OID equality, never by a hardcoded collation name", () => {
    const block = sql.slice(sql.indexOf("v_actual_typid oid;"), sql.indexOf("EQDS2-PRE-OK-PHYSICAL"));
    expect(block).not.toMatch(/collname/i);
    expect(block).not.toMatch(/"C"|"POSIX"|en_US|und-x-icu/);
    expect(block).not.toMatch(/attcollation\s*(=|<>)\s*[0-9]/);
    // Presence-only checks would not establish the contract.
    expect(block).not.toMatch(/attcollation is not null/i);
  });

  it("fails closed when either attribute cannot be resolved", () => {
    expect(sql).toContain("v_actual_typid is null or v_actual_collation is null");
    expect(sql).toContain("v_reference_typid is null or v_reference_collation is null");
    expect(source).toMatch(/EQDS2-PRE-33[\s\S]{0,240}could not resolve/);
    expect(source).toMatch(/EQDS2-PRE-34[\s\S]{0,240}could not resolve/);
  });

  it("runs after the reference relation exists and before semantic acceptance", () => {
    const tempTable = sql.indexOf("create temp table");
    const typeGuard = sql.indexOf("EQDS2-PRE-31");
    const collationGuard = sql.indexOf("EQDS2-PRE-32");
    const semantic = sql.indexOf("EQDS2-PRE-27");
    const replacement = sql.indexOf(
      "create or replace function public.apply_swing_analysis_equipment_snapshot()"
    );
    expect(tempTable).toBeLessThan(typeGuard);
    expect(typeGuard).toBeLessThan(collationGuard);
    expect(collationGuard).toBeLessThan(semantic);
    expect(semantic).toBeLessThan(replacement);
  });

  it("uses no dynamic SQL for the physical-context lookups", () => {
    const block = sql.slice(sql.indexOf("v_actual_typid oid;"), sql.indexOf("EQDS2-PRE-OK-PHYSICAL"));
    expect(block).not.toMatch(/(^|[^_a-z])execute\s/i);
    expect(block).not.toMatch(/format\(/i);
  });
});

describe("EQ-DESIGNATION D2 migration — whole-expression comparison authority", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("deparses all four constraints with pg_get_expr and pretty-printing off", () => {
    expect((sql.match(/pg_get_expr\(con\.conbin, con\.conrelid, false\)/g) ?? []).length).toBe(4);
  });

  it("resolves the reference constraints through pg_temp", () => {
    // Scoped to the constraint-comparison block: the physical-context block
    // resolves the same relation separately for its pg_attribute lookups.
    const block = sql.slice(
      sql.indexOf("v_actual_vocabulary text;"),
      sql.indexOf("EQDS2-PRE-30")
    );
    expect((block.match(/'pg_temp\.eqds2_reference_designation_contract'::regclass/g) ?? []).length).toBe(2);
    expect((block.match(/'public\.user_equipment'::regclass/g) ?? []).length).toBe(2);
  });

  it("fetches all four renderings in one statement so search_path cannot differ", () => {
    const block = sql.slice(sql.indexOf("v_actual_vocabulary text;"), sql.indexOf("EQDS2-PRE-30"));
    expect((block.match(/pg_get_expr\(/g) ?? []).length).toBe(4);
    expect(block).toContain(
      "into v_actual_vocabulary, v_reference_vocabulary, v_actual_compat, v_reference_compat;"
    );
  });

  it("compares each constraint as a whole string, rejecting any difference", () => {
    expect(sql).toContain("v_actual_vocabulary is distinct from v_reference_vocabulary");
    expect(sql).toContain("v_actual_compat is distinct from v_reference_compat");
    expect(source).toMatch(/EQDS2-PRE-27[\s\S]{0,260}does not match the canonical D1 expression/);
    expect(source).toMatch(/EQDS2-PRE-28[\s\S]{0,260}does not match the canonical D1 expression/);
  });

  it("fails loudly if the reference constraints did not materialise", () => {
    expect(source).toMatch(/EQDS2-PRE-30[\s\S]{0,240}canonical reference constraints were not created/);
  });

  it("compares before replacing the function", () => {
    expect(sql.indexOf("EQDS2-PRE-28")).toBeLessThan(
      sql.indexOf("create or replace function public.apply_swing_analysis_equipment_snapshot()")
    );
  });
});

describe("EQ-DESIGNATION D2 migration — rejected partial-parser authority is absent", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));

  it("uses no regexp token projection as semantic authority", () => {
    expect(sql).not.toContain("regexp_matches");
    expect(sql).not.toContain("regexp_replace");
  });

  it("uses no substring or slicing authority over constraint definitions", () => {
    expect(sql).not.toContain("pg_get_constraintdef");
    expect(sql).not.toMatch(/position\('club_type = /);
    expect(sql).not.toMatch(/substr\(v_/);
  });

  it("uses no finite behavioural probe matrix", () => {
    expect(sql).not.toMatch(/\bvalues\s*\(/i);
    expect(sql).not.toMatch(/foreach\s+v_ct\s+in\s+array/i);
  });

  it("never executes catalog-derived expression text", () => {
    expect(sql).not.toMatch(/(^|[^_a-z])execute\s/i);
  });
});

describe("EQ-DESIGNATION D2 — canonical reference matches the D1 migration source", () => {
  const D1_FILE = "supabase/migrations/20260824053500_equipment_user_club_designation.sql";
  const d1 = readSource(D1_FILE);
  const d2 = readSource(MIGRATION_FILE);

  /** Balanced-paren body following `marker`, which must end with an open paren. */
  function checkBody(source: string, marker: string, label: string): string {
    const start = source.indexOf(marker);
    expect(start, `${label}: could not locate "${marker}"`).toBeGreaterThanOrEqual(0);
    let i = start + marker.length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      if (depth > 0) i++;
    }
    expect(depth, `${label}: unbalanced parentheses after "${marker}"`).toBe(0);
    return source.slice(start + marker.length, i);
  }

  /** Collapses whitespace only. No operator, cast, paren, or literal rewriting. */
  function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  it("the reference vocabulary expression is the D1 vocabulary expression", () => {
    const actual = collapse(
      checkBody(d1, "add constraint user_equipment_club_designation_vocabulary check (", D1_FILE)
    );
    const reference = collapse(
      checkBody(d2, "constraint eqds2_reference_vocabulary check (", MIGRATION_FILE)
    );
    expect(reference).toBe(actual);
  });

  it("the reference compatibility expression is the D1 compatibility expression", () => {
    const actual = collapse(
      checkBody(
        d1,
        "add constraint user_equipment_club_designation_club_type_compat check (",
        D1_FILE
      )
    );
    const reference = collapse(
      checkBody(d2, "constraint eqds2_reference_club_type_compat check (", MIGRATION_FILE)
    );
    expect(reference).toBe(actual);
  });

  it("the canonical reference carries all 28 tokens and no Driver/Putter branch", () => {
    const vocab = checkBody(d2, "constraint eqds2_reference_vocabulary check (", MIGRATION_FILE);
    const compat = checkBody(d2, "constraint eqds2_reference_club_type_compat check (", MIGRATION_FILE);
    for (const token of ALL_TOKENS) {
      expect(vocab, `reference vocabulary is missing ${token}`).toContain(`'${token}'`);
    }
    expect(compat).not.toContain("'Driver'");
    expect(compat).not.toContain("'Putter'");
    for (const [label, tokens] of [
      ["Wood", WOOD],
      ["Hybrid", HYBRID],
      ["Iron", IRON],
      ["Wedge", WEDGE],
    ] as const) {
      expect(compat, `reference compat is missing the ${label} branch`).toContain(
        `club_type = '${label}'::public.club_type_enum`
      );
      for (const token of tokens) {
        expect(compat, `${label} branch is missing ${token}`).toContain(`'${token}'`);
      }
    }
  });
});

describe("EQ-DESIGNATION D2 migration — original V1 function drift guard", () => {
  const source = readSource(MIGRATION_FILE);

  it("requires the prior function to still be SECURITY INVOKER with empty search_path", () => {
    expect(source).toMatch(/EQDS2-PRE-17[\s\S]{0,220}SECURITY INVOKER with an empty search_path/);
  });

  it("requires the prior function to still emit schema_version 1", () => {
    expect(source).toMatch(/EQDS2-PRE-18[\s\S]{0,240}does not emit schema_version 1/);
  });

  it("refuses to overwrite a function that already references club_designation", () => {
    expect(source).toMatch(/EQDS2-PRE-19[\s\S]{0,260}already references club_designation/);
  });

  it("requires the prior function to still enforce ownership and analysis_family", () => {
    expect(source).toMatch(/EQDS2-PRE-20[\s\S]{0,200}ownership/);
    expect(source).toMatch(/EQDS2-PRE-21[\s\S]{0,200}analysis_family/);
  });
});

// ============================================================================
// Both security guards compare public.apply_swing_analysis_equipment_snapshot()
// against pg_proc.proconfig. PostgreSQL flattens `SET search_path TO ''` into
// the proconfig element `search_path=""` — the empty value is stored QUOTED,
// never as a bare trailing `=`. An earlier revision of this migration compared
// against `search_path=`, a literal no correctly-declared function can ever
// carry, so both guards were unsatisfiable by construction and a real staging
// application aborted at EQDS2-PRE-17 against a function that had not drifted
// at all. Nothing in the suite pinned the predicate, so the defect passed every
// test. These two do.
//
// Exact array equality is deliberate rather than containment: the contract is
// not "an empty search_path appears somewhere" but "the function carries
// exactly the expected function-level configuration", so an extra unexpected
// SET option must fail closed.
// ============================================================================
describe("EQ-DESIGNATION D2 migration — pg_proc.proconfig security-posture guard", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));

  const STALE_PREDICATE = "p.proconfig @> array['search_path=']";
  const CORRECT_PREDICATE = `p.proconfig = array['search_path=""']::text[]`;

  /** The `if not exists (...)` guard text immediately preceding an exception id. */
  function guardBlock(exceptionId: string): string {
    const at = sql.indexOf(exceptionId);
    expect(at, `${exceptionId} not found in executable SQL`).toBeGreaterThan(-1);
    const start = sql.lastIndexOf("if not exists (", at);
    expect(start, `no guard block precedes ${exceptionId}`).toBeGreaterThan(-1);
    return sql.slice(start, at);
  }

  it("never compares proconfig against the stale search_path literal", () => {
    expect(sql).not.toContain(STALE_PREDICATE);
    expect((sql.match(/array\['search_path='\]/g) ?? []).length).toBe(0);
    expect((sql.match(/proconfig\s*@>/g) ?? []).length).toBe(0);
  });

  it("pins both security guards to the exact proconfig representation", () => {
    expect(sql.split(CORRECT_PREDICATE).length - 1).toBe(2);

    for (const exceptionId of ["EQDS2-PRE-17", "EQDS2-POST-2"]) {
      const block = guardBlock(exceptionId);
      expect(block, `${exceptionId} guard lost the exact proconfig contract`).toContain(
        CORRECT_PREDICATE
      );
      expect(block, `${exceptionId} guard lost the SECURITY INVOKER contract`).toContain(
        "p.prosecdef = false"
      );
      expect(block, `${exceptionId} guard still carries the stale predicate`).not.toContain(
        STALE_PREDICATE
      );
    }
  });
});

describe("EQ-DESIGNATION D2 migration — function replacement identity", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));

  it("replaces exactly the existing snapshot function", () => {
    expect(sql).toContain("create or replace function public.apply_swing_analysis_equipment_snapshot()");
    expect((sql.match(/create or replace function/g) ?? []).length).toBe(1);
  });

  it("never drops a function or creates a second snapshot producer", () => {
    expect(sql).not.toMatch(/drop\s+function/i);
    expect((sql.match(/apply_swing_analysis_equipment_snapshot/g) ?? []).length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/create function/i);
  });

  it("never creates, drops, or alters a trigger", () => {
    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/drop\s+trigger/i);
    expect(sql).not.toMatch(/alter\s+trigger/i);
  });

  it("preserves SECURITY INVOKER and the empty search_path", () => {
    const decl = sql.slice(
      sql.indexOf("create or replace function public.apply_swing_analysis_equipment_snapshot()"),
      sql.indexOf("$function$")
    );
    expect(decl).toContain("returns trigger");
    expect(decl).toContain("language plpgsql");
    expect(decl).toContain("security invoker");
    expect(decl).toContain("set search_path to ''");
    expect(decl.toLowerCase()).not.toContain("security definer");
  });
});

describe("EQ-DESIGNATION D2 migration — V2 writer semantics", () => {
  const sql = stripSqlComments(readSource(MIGRATION_FILE));
  const fn = replacementFunctionBody(sql);
  const obj = snapshotObject(fn);
  const keys = topLevelKeys(obj);

  it("emits schema_version exactly 2 and never 1", () => {
    expect(obj).toContain("'schema_version', 2");
    expect(obj).not.toContain("'schema_version', 1");
  });

  it("emits exactly the 15 locked top-level keys, in order, with no sixteenth", () => {
    expect(keys).toEqual(V2_KEYS);
    expect(new Set(keys).size).toBe(15);
  });

  it("copies club_designation directly from the saved club", () => {
    expect(obj).toContain("'club_designation', to_jsonb(v_equipment.club_designation)");
  });

  it("never infers, maps, or defaults the designation", () => {
    const idx = obj.indexOf("'club_designation'");
    const fragment = obj.slice(idx, obj.indexOf("\n", idx));
    expect(fragment.toLowerCase()).not.toContain("coalesce");
    expect(fragment.toLowerCase()).not.toContain("case");
    expect(fragment.toLowerCase()).not.toContain("club_type");
    expect(fragment.toLowerCase()).not.toContain("loft");
    expect(fragment).not.toMatch(/new\./);
  });

  it("never derives designation from any other field anywhere in the function", () => {
    for (const token of ALL_TOKENS) {
      expect(fn, `function must not hardcode designation token ${token}`).not.toContain(`'${token}'`);
    }
  });

  it("preserves all fourteen V1 evidence fields with their original sources", () => {
    expect(obj).toContain("'captured_at', to_jsonb(now())");
    expect(obj).toContain("'equipment_id', to_jsonb(v_equipment.id)");
    expect(obj).toContain("'club_type', to_jsonb(v_equipment.club_type::text)");
    expect(obj).toContain("'entered_brand', to_jsonb(v_equipment.brand)");
    expect(obj).toContain("'entered_model', to_jsonb(v_equipment.model)");
    expect(obj).toContain("'custom_club', to_jsonb(v_equipment.custom_club)");
    expect(obj).toContain("'custom_brand', to_jsonb(v_equipment.custom_brand)");
    expect(obj).toContain("'custom_model', to_jsonb(v_equipment.custom_model)");
    expect(obj).toContain("'shaft_flex', to_jsonb(v_equipment.shaft_flex)");
    expect(obj).toContain("'shaft_weight_grams', to_jsonb(v_equipment.shaft_weight)");
    expect(obj).toContain("'loft_deg', to_jsonb(v_equipment.loft_deg)");
  });

  it("preserves the manufacturer and model sub-shapes exactly", () => {
    expect(obj).toContain(
      "jsonb_build_object('id', v_manufacturer.id, 'canonical_name', v_manufacturer.canonical_name, 'slug', v_manufacturer.slug)"
    );
    expect(obj).toContain(
      "jsonb_build_object('id', v_model.id, 'canonical_name', v_model.canonical_name, 'slug', v_model.slug, 'model_year', v_model.model_year)"
    );
  });

  it("preserves the null-club_id short circuit", () => {
    expect(fn).toMatch(
      /if new\.club_id is null then\s*\n\s*new\.analysis_family := null;\s*\n\s*new\.equipment_snapshot := null;\s*\n\s*return new;/
    );
  });

  it("preserves ownership enforcement", () => {
    expect(fn).toContain("if v_equipment.user_id is distinct from new.user_id then");
    expect(fn).toContain("the selected club is not owned by this analysis user");
  });

  it("preserves analysis-family derivation", () => {
    expect(fn).toContain("if v_equipment.club_type = 'Putter' then");
    expect(fn).toContain("new.analysis_family := 'putting'");
    expect(fn).toContain("new.analysis_family := 'full_swing'");
  });

  it("preserves the row-type declarations and catalog lookups", () => {
    expect(fn).toContain("v_equipment public.user_equipment%rowtype");
    expect(fn).toContain("v_manufacturer public.equipment_manufacturers%rowtype");
    expect(fn).toContain("v_model public.equipment_models%rowtype");
    expect(fn).toContain("from public.equipment_manufacturers");
    expect(fn).toContain("from public.equipment_models");
  });

  it("never trusts a client-supplied snapshot or designation", () => {
    expect(fn).not.toMatch(/new\.equipment_snapshot\s*(is not null|<>|=\s*old)/);
    expect(fn).not.toContain("new.club_designation");
  });
});

describe("EQ-DESIGNATION D2 migration — scope boundaries", () => {
  const source = readSource(MIGRATION_FILE);
  const sql = stripSqlComments(source);

  it("performs no UPDATE, DELETE, INSERT, or backfill", () => {
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/^\s*update\s+/im);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
  });

  it("alters no table and adds no column", () => {
    expect(sql).not.toMatch(/alter\s+table/i);
    expect(sql).not.toMatch(/add\s+column/i);
  });

  it("makes no RLS, grant, revoke, or ownership change", () => {
    expect(sql).not.toMatch(/row\s+level\s+security/i);
    expect(sql).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy/i);
    expect(sql).not.toMatch(/^\s*grant\b/im);
    expect(sql).not.toMatch(/^\s*revoke\b/im);
    expect(sql).not.toMatch(/owner\s+to/i);
  });

  it("adds no index and no constraint", () => {
    expect(sql).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(sql).not.toMatch(/add\s+constraint/i);
  });

  it("mutates no catalog table", () => {
    for (const table of [
      "equipment_models",
      "equipment_manufacturers",
      "equipment_model_sources",
      "equipment_putter_model_specs",
    ]) {
      expect(sql).not.toMatch(new RegExp(`alter table public\\.${table}`, "i"));
    }
  });

  it("leaves the immutability function and trigger untouched", () => {
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.guard_swing_analysis_equipment_immutability/i);
    expect(source).toMatch(/EQDS2-POST-9[\s\S]{0,200}immutability/);
  });

  it("postflight verifies the V2 contract, security posture, and trigger binding", () => {
    expect(source).toMatch(/EQDS2-POST-2[\s\S]{0,200}SECURITY INVOKER/);
    expect(source).toMatch(/EQDS2-POST-3[\s\S]{0,200}schema_version 2/);
    expect(source).toMatch(/EQDS2-POST-4[\s\S]{0,200}still emits schema_version 1/);
    expect(source).toMatch(/EQDS2-POST-5[\s\S]{0,240}club_designation directly/);
    expect(source).toMatch(/EQDS2-POST-8[\s\S]{0,240}apply_equipment_snapshot/);
  });

  it("runs no sample DML inside the flight blocks", () => {
    expect(sql).not.toMatch(/\bvalues\s*\(/i);
  });
});

describe("EQ-DESIGNATION D2 TypeScript contracts", () => {
  const types = readSource(TYPES_FILE);

  function interfaceBlock(name: string): string {
    const start = types.indexOf(`export interface ${name}`);
    expect(start, `${TYPES_FILE}: missing interface ${name}`).toBeGreaterThanOrEqual(0);
    const end = types.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return types.slice(start, end);
  }

  it("EquipmentSnapshotV1 keeps its exact frozen historical shape", () => {
    const block = interfaceBlock("EquipmentSnapshotV1");
    expect(block).toContain("schema_version: 1;");
    for (const field of [
      "captured_at: string;",
      "equipment_id: string;",
      "club_type: ClubType;",
      "entered_brand: string | null;",
      "entered_model: string | null;",
      "custom_club: boolean;",
      "custom_brand: string | null;",
      "custom_model: string | null;",
      "shaft_flex: string | null;",
      "shaft_weight_grams: number | null;",
      "loft_deg: number | null;",
    ]) {
      expect(block, `V1 lost "${field}"`).toContain(field);
    }
  });

  it("EquipmentSnapshotV1 still carries no designation field", () => {
    expect(interfaceBlock("EquipmentSnapshotV1")).not.toContain("club_designation");
  });

  it("EquipmentSnapshotV2 exists and is schema_version 2", () => {
    expect(types).toMatch(/export interface EquipmentSnapshotV2\s*{/);
    expect(interfaceBlock("EquipmentSnapshotV2")).toContain("schema_version: 2;");
  });

  it("EquipmentSnapshotV2 is fully restated, never derived from V1", () => {
    expect(types).not.toMatch(/interface EquipmentSnapshotV2\s+extends/);
    const block = interfaceBlock("EquipmentSnapshotV2");
    expect(block).not.toContain("Omit<");
    expect(block).not.toContain("Pick<");
    expect(block).not.toContain("EquipmentSnapshotV1");
  });

  it("EquipmentSnapshotV2 carries nullable ClubDesignation", () => {
    expect(interfaceBlock("EquipmentSnapshotV2")).toMatch(
      /club_designation:\s*ClubDesignation\s*\|\s*null;/
    );
  });

  it("EquipmentSnapshotV2 repeats every V1 evidence field", () => {
    const block = interfaceBlock("EquipmentSnapshotV2");
    for (const field of [
      "captured_at: string;",
      "equipment_id: string;",
      "club_type: ClubType;",
      "entered_brand: string | null;",
      "entered_model: string | null;",
      "custom_club: boolean;",
      "custom_brand: string | null;",
      "custom_model: string | null;",
      "shaft_flex: string | null;",
      "shaft_weight_grams: number | null;",
      "loft_deg: number | null;",
    ]) {
      expect(block, `V2 is missing "${field}"`).toContain(field);
    }
    expect(block).toContain("manufacturer: { id: string; canonical_name: string; slug: string } | null;");
    expect(block).toContain(
      "model: { id: string; canonical_name: string; slug: string; model_year: number | null } | null;"
    );
  });

  it("EquipmentSnapshotV2 adds no speculative fields beyond the locked 15", () => {
    const block = interfaceBlock("EquipmentSnapshotV2");
    const declared = (block.match(/^\s{2}([a-z_]+)[?]?:/gm) ?? []).map((m) =>
      m.trim().replace(/[?:]/g, "")
    );
    expect(declared.sort()).toEqual([...V2_KEYS].sort());
    for (const forbidden of ["sku", "provenance", "source_url", "lie", "length", "bounce", "grind"]) {
      expect(block, `V2 must not carry speculative field "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("exports the EquipmentSnapshot union as exactly V1 | V2", () => {
    expect(types).toMatch(
      /export type EquipmentSnapshot =\s*EquipmentSnapshotV1\s*\|\s*EquipmentSnapshotV2;/
    );
  });

  it("SwingAnalysis carries the version-tagged union", () => {
    expect(interfaceBlock("SwingAnalysis")).toMatch(
      /equipment_snapshot:\s*EquipmentSnapshot\s*\|\s*null;/
    );
  });

  it("leaves the designation vocabulary and neighbouring contracts unchanged", () => {
    expect(types).toContain(
      'export type ClubType = "Driver" | "Wood" | "Hybrid" | "Iron" | "Wedge" | "Putter";'
    );
    const union = types.slice(
      types.indexOf("export type ClubDesignation ="),
      types.indexOf(";", types.indexOf("export type ClubDesignation ="))
    );
    const tokens = (union.match(/"[0-9A-Z]+"/g) ?? []).map((t) => t.slice(1, -1));
    expect(new Set(tokens).size).toBe(28);
    expect(interfaceBlock("UserEquipment")).toMatch(
      /club_designation:\s*ClubDesignation\s*\|\s*null;/
    );
  });
});
