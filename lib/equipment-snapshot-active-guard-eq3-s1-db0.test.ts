/**
 * EQ3-S1 DB0 — requiring an ACTIVE equipment row, and locking it, at snapshot
 * time.
 *
 * A static source-contract suite over the generated migration and the
 * centralized migration inventory, in the established style of this
 * repository's other schema suites. No database is contacted, no network, no
 * jsdom, no Supabase client, no credential.
 *
 * WHAT THIS SLICE EXISTS TO PROVE
 * ------------------------------
 * public.apply_swing_analysis_equipment_snapshot() has always validated that
 * the selected club exists and is owned by the analysing golfer, but never that
 * it is still in the bag: the producer was authored before
 * user_equipment.is_archived existed. DB0 adds exactly two things to its single
 * equipment lookup — the active-row predicate and a shared row lock — so an
 * archive racing a swing_analysis INSERT fails closed instead of capturing an
 * archived club into an immutable snapshot.
 *
 * WHAT MAKES THESE ASSERTIONS TRUSTWORTHY
 * ---------------------------------------
 * First, the primary proof is a whole-statement comparison, not a bag of
 * substrings. The suite extracts D2's CREATE OR REPLACE statement, applies the
 * two authorized edits to it here, and requires DB0's statement to equal the
 * result byte for byte. Anything else changed anywhere in the producer — a
 * dropped ownership check, a reworded exception, an extra snapshot key — fails,
 * because the expected text is built from history rather than read out of the
 * new file.
 *
 * Second, "must not contain" assertions run against *executable* SQL: comments
 * and single-quoted string literals are blanked first. This migration
 * necessarily discusses FOR UPDATE, FOR KEY SHARE, NOWAIT and SKIP LOCKED in
 * prose, and necessarily embeds those same phrases inside quoted arguments to
 * position() in its own postflight guards. Scanning raw text would fail on the
 * very evidence that proves correctness.
 *
 * Third, the migration is discovered by suffix rather than by a hardcoded
 * timestamp, so a regenerated file is still found and two competing DB0
 * migrations are a failure.
 *
 * Fourth, D2 is pinned by content hash. This correction had to be a new, later
 * migration; retrofitting the guard into D2 would rewrite a file already
 * applied to staging and production, and the hash makes that visible.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MIGRATIONS,
  EQUIPMENT_SNAPSHOT_ACTIVE_GUARD_DB0_FILENAME,
  EQUIPMENT_SNAPSHOT_V2_FILENAME,
  EXPECTED_MIGRATION_COUNT,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "@/lib/migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_SUFFIX = "_equipment_snapshot_active_guard_eq3_s1_db0.sql";
const NEWLINE = "\n";
const SINGLE_QUOTE = "'";

// ─── The approved DB0 contract, hardcoded ────────────────────────────────────
//
// Transcribed from the authorization, never read back out of the migration. An
// expectation derived from the implementation would move whenever the
// implementation moved.

/** The one function DB0 may replace. */
const TARGET_FUNCTION = "public.apply_swing_analysis_equipment_snapshot()";

/** The separate update-time guard DB0 must leave completely alone. */
const IMMUTABILITY_FUNCTION =
  "public.guard_swing_analysis_equipment_immutability()";

/**
 * D2's equipment lookup, exactly as checked in. The suite requires this to
 * appear once in D2 and never in DB0.
 */
const D2_LOOKUP =
  "  select * into v_equipment\n" +
  "    from public.user_equipment\n" +
  "    where user_equipment.id = new.club_id;\n";

/**
 * The only permitted replacement. The predicate is inside the locking select on
 * purpose: in READ COMMITTED, only the locking select's own WHERE clause is
 * re-evaluated against the updated row after waiting on a concurrent updater,
 * so an unpredicated lock followed by a separate IF would re-open the race.
 */
const DB0_LOOKUP =
  "  select * into v_equipment\n" +
  "    from public.user_equipment\n" +
  "    where user_equipment.id = new.club_id\n" +
  "      and user_equipment.is_archived = false\n" +
  "    for share;\n";

/** Whitespace-collapsed form of the locking lookup, for adjacency assertions. */
const LOOKUP_ADJACENCY =
  "where user_equipment.id = new.club_id " +
  "and user_equipment.is_archived = false for share;";

/** The one lock mode DB0 may take. */
const REQUIRED_LOCK = "for share";

/**
 * Lock strengths and modifiers DB0 must never use. FOR KEY SHARE does not
 * conflict with the archive's FOR NO KEY UPDATE and would leave the race open;
 * FOR UPDATE and FOR NO KEY UPDATE conflict with themselves and would serialise
 * unrelated concurrent analyses; NOWAIT and SKIP LOCKED convert correct brief
 * waiting into a spurious rejection.
 */
const FORBIDDEN_LOCKS = [
  "for key share",
  "for no key update",
  "for update",
  "nowait",
  "skip locked",
];

/** The exact 15 top-level EquipmentSnapshot V2 keys, in emission order. */
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

/** D2's content hash. DB0 must be a new file, never an edit of history. */
const D2_SHA256 =
  "3fefcd5e989eca9a521b913e29645d42215865a4d6299ea2193e6c8b9f322e2c";

/** The number of PRE and POST guards the migration declares. */
const EXPECTED_PRE_GUARDS = 31;
const EXPECTED_POST_GUARDS = 33;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function sha256Of(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(repoRoot, relativePath)))
    .digest("hex");
}

/** Every checked-in migration filename, read from disk. */
function migrationFilenames(): string[] {
  return readdirSync(path.join(repoRoot, MIGRATIONS_DIR)).filter((f) =>
    f.endsWith(".sql")
  );
}

/**
 * The DB0 migration, discovered by suffix. Two competing DB0 migrations, or
 * none, is a failure rather than a silently chosen first match.
 */
function db0MigrationPath(): string {
  const matches = migrationFilenames().filter((f) => f.endsWith(MIGRATION_SUFFIX));
  expect(matches).toHaveLength(1);
  return `${MIGRATIONS_DIR}/${matches[0]}`;
}

/**
 * Blank SQL comments and single-quoted literals while preserving every offset,
 * so a position found in the result refers to the same character of the raw
 * source. Dollar-quoted bodies are preserved: the guards live inside
 * `do $$ ... $$` blocks and are exactly what these assertions need to see.
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

const FUNCTION_HEADER = `create or replace function ${TARGET_FUNCTION}`;
const FUNCTION_TERMINATOR = "\n$function$;\n";

/**
 * The complete CREATE OR REPLACE statement for the snapshot producer, from its
 * header through the dollar-quote terminator inclusive. Extracting the whole
 * statement is what makes the D2-to-DB0 comparison a real proof rather than a
 * sampling of fragments.
 */
function functionStatement(source: string): string {
  const start = source.indexOf(FUNCTION_HEADER);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(FUNCTION_TERMINATOR, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + FUNCTION_TERMINATOR.length);
}

const migrationPath = db0MigrationPath();
const migrationSource = readSource(migrationPath);
const migrationExec = executableSql(migrationSource);
const migrationCode = normalised(migrationSource);

const d2Source = readSource(`${MIGRATIONS_DIR}/${EQUIPMENT_SNAPSHOT_V2_FILENAME}`);

const db0Function = functionStatement(migrationSource);
const db0FunctionCode = normalised(db0Function);

/**
 * The preflight region: everything before the replacement statement. Slicing by
 * the replacement's own offset — rather than by an exception identifier — keeps
 * a "preflight checks X" assertion from accidentally passing on postflight
 * evidence.
 */
function preflightSource(): string {
  const end = migrationExec.indexOf(FUNCTION_HEADER);
  expect(end).toBeGreaterThan(0);
  return migrationSource.slice(0, end);
}

/** The postflight region: everything after the replacement statement. */
function postflightSource(): string {
  const start = migrationExec.indexOf(FUNCTION_HEADER);
  expect(start).toBeGreaterThan(0);
  const end = migrationExec.indexOf(FUNCTION_TERMINATOR, start);
  expect(end).toBeGreaterThan(start);
  return migrationSource.slice(end + FUNCTION_TERMINATOR.length);
}

/** Unique guard numbers of one kind, in ascending order. */
function guardNumbers(source: string, kind: "PRE" | "POST"): number[] {
  const found = source.match(new RegExp(`EQ3S1DB0-${kind}-\\d+`, "g")) ?? [];
  const numbers = found.map((m) => Number(m.slice(`EQ3S1DB0-${kind}-`.length)));
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

/**
 * The top-level keys of the outermost jsonb_build_object in the producer.
 * Depth-aware, so the nested manufacturer/model objects contribute none of
 * their own keys and the comparison really is about the V2 envelope.
 */
function topLevelSnapshotKeys(statement: string): string[] {
  const open = statement.indexOf("jsonb_build_object(");
  expect(open).toBeGreaterThanOrEqual(0);
  let i = open + "jsonb_build_object(".length;
  let depth = 1;
  const keys: string[] = [];
  let expectKey = true;
  while (i < statement.length && depth > 0) {
    const ch = statement[i];
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 1) {
      i += 1;
      continue;
    }
    if (ch === SINGLE_QUOTE && depth === 1 && expectKey) {
      const close = statement.indexOf(SINGLE_QUOTE, i + 1);
      keys.push(statement.slice(i + 1, close));
      expectKey = false;
      i = close + 1;
      continue;
    }
    if (ch === "\n" && depth === 1) {
      expectKey = true;
    }
    i += 1;
  }
  return keys;
}

// ─── File and history contract ───────────────────────────────────────────────

describe("EQ3-S1 DB0 migration — identity and history", () => {
  it("is the single migration carrying the DB0 suffix", () => {
    const matches = migrationFilenames().filter((f) =>
      f.endsWith(MIGRATION_SUFFIX)
    );
    expect(matches).toHaveLength(1);
  });

  it("was generated with a 14-digit CLI timestamp and the approved name", () => {
    expect(path.basename(migrationPath)).toMatch(
      /^\d{14}_equipment_snapshot_active_guard_eq3_s1_db0\.sql$/
    );
  });

  it("is the filename the migration inventory records", () => {
    expect(path.basename(migrationPath)).toBe(
      EQUIPMENT_SNAPSHOT_ACTIVE_GUARD_DB0_FILENAME
    );
  });

  it("sorts after every migration that existed when it was authored", () => {
    const mine = EQUIPMENT_SNAPSHOT_ACTIVE_GUARD_DB0_FILENAME;
    const earlier = migrationsAuthoredBefore(mine);
    expect(earlier.length).toBeGreaterThan(0);
    expect(sortsAfterAll(mine, earlier)).toBe(true);
  });

  it("occupies its permanent historical position in the approved inventory", () => {
    // Not "is last": that expires the moment a later migration lands, which is
    // exactly how the DB3 suite broke when this one was added. Everything
    // sorting before DB0 is exactly `earlier`, so its index is earlier.length
    // permanently.
    const mine = EQUIPMENT_SNAPSHOT_ACTIVE_GUARD_DB0_FILENAME;
    const earlier = migrationsAuthoredBefore(mine);
    expect(APPROVED_MIGRATIONS.indexOf(mine)).toBe(earlier.length);
  });

  it("leaves the checked-in migration set closed", () => {
    const onDisk = migrationFilenames().sort();
    expect(onDisk).toHaveLength(EXPECTED_MIGRATION_COUNT);
    expect(onDisk).toEqual([...APPROVED_MIGRATIONS].sort());
  });

  it("did not retrofit the guard into the historical D2 migration", () => {
    // D2 is already applied to staging and production. The correction had to be
    // a new, later migration, and this hash is what makes an edit visible.
    expect(sha256Of(`${MIGRATIONS_DIR}/${EQUIPMENT_SNAPSHOT_V2_FILENAME}`)).toBe(
      D2_SHA256
    );
  });

  it("leaves D2's own lookup unarchived and unlocked", () => {
    expect(occurrences(d2Source, D2_LOOKUP)).toBe(1);
    expect(occurrences(d2Source, DB0_LOOKUP)).toBe(0);
  });
});

// ─── Migration shape ─────────────────────────────────────────────────────────

describe("EQ3-S1 DB0 migration — transaction and statement shape", () => {
  it("runs inside exactly one explicit transaction", () => {
    expect((migrationExec.match(/^begin;$/gm) ?? [])).toHaveLength(1);
    expect((migrationExec.match(/^commit;$/gm) ?? [])).toHaveLength(1);
    expect(migrationCode).not.toContain("rollback");
  });

  it("replaces exactly one function, and only the snapshot producer", () => {
    expect(occurrences(migrationCode, "create or replace function")).toBe(1);
    expect(occurrences(migrationCode, `create or replace function ${TARGET_FUNCTION}`)).toBe(1);
    expect(migrationCode).not.toContain(
      `create or replace function ${IMMUTABILITY_FUNCTION}`
    );
  });

  it("never drops or re-creates the function or its trigger", () => {
    expect(migrationCode).not.toContain("drop function");
    expect(migrationCode).not.toContain("create function ");
    expect(migrationCode).not.toContain("create trigger");
    expect(migrationCode).not.toContain("create or replace trigger");
    expect(migrationCode).not.toContain("drop trigger");
    expect(migrationCode).not.toContain("alter trigger");
    expect(migrationCode).not.toContain("alter function");
  });

  it("changes no table, policy, privilege or RLS state", () => {
    expect(migrationCode).not.toContain("alter table");
    expect(migrationCode).not.toContain("create policy");
    expect(migrationCode).not.toContain("alter policy");
    expect(migrationCode).not.toContain("drop policy");
    expect(migrationCode).not.toContain("row level security");
    expect(migrationCode).not.toMatch(/\bgrant\s/);
    expect(migrationCode).not.toMatch(/\brevoke\s/);
  });

  it("creates no persistent object other than the replaced function body", () => {
    expect(migrationCode).not.toContain("create table");
    expect(migrationCode).not.toContain("create temp");
    expect(migrationCode).not.toContain("create temporary");
    expect(migrationCode).not.toContain("create view");
    expect(migrationCode).not.toContain("create materialized view");
    expect(migrationCode).not.toContain("create index");
    expect(migrationCode).not.toContain("create unique index");
    expect(migrationCode).not.toContain("add constraint");
    expect(migrationCode).not.toContain("create type");
    expect(migrationCode).not.toContain("create schema");
  });

  it("mutates no application row", () => {
    // The producer assigns to NEW inside a BEFORE trigger, which is not DML.
    expect(migrationCode).not.toMatch(/\binsert\s+into\b/);
    expect(migrationCode).not.toMatch(/\bdelete\s+from\b/);
    expect(migrationCode).not.toMatch(/\bupdate\s+(public|only)\b/);
    expect(migrationCode).not.toContain("truncate");
    expect(migrationCode).not.toContain("copy ");
  });

  it("numbers its preflight guards uniquely and contiguously from 1", () => {
    const numbers = guardNumbers(migrationSource, "PRE");
    expect(numbers).toHaveLength(EXPECTED_PRE_GUARDS);
    expect(numbers).toEqual(
      Array.from({ length: EXPECTED_PRE_GUARDS }, (_, i) => i + 1)
    );
    for (const n of numbers) {
      expect(occurrences(migrationSource, `EQ3S1DB0-PRE-${n}:`)).toBe(1);
    }
  });

  it("numbers its postflight guards uniquely and contiguously from 1", () => {
    const numbers = guardNumbers(migrationSource, "POST");
    expect(numbers).toHaveLength(EXPECTED_POST_GUARDS);
    expect(numbers).toEqual(
      Array.from({ length: EXPECTED_POST_GUARDS }, (_, i) => i + 1)
    );
    for (const n of numbers) {
      expect(occurrences(migrationSource, `EQ3S1DB0-POST-${n}:`)).toBe(1);
    }
  });

  it("runs every preflight guard before the replacement and every postflight guard after it", () => {
    expect(guardNumbers(preflightSource(), "PRE")).toHaveLength(EXPECTED_PRE_GUARDS);
    expect(guardNumbers(preflightSource(), "POST")).toHaveLength(0);
    expect(guardNumbers(postflightSource(), "POST")).toHaveLength(EXPECTED_POST_GUARDS);
    expect(guardNumbers(postflightSource(), "PRE")).toHaveLength(0);
  });
});

// ─── The exact function delta ────────────────────────────────────────────────

describe("EQ3-S1 DB0 — the replacement is D2 plus exactly two lookup changes", () => {
  it("finds D2's lookup exactly once in D2's own statement", () => {
    expect(occurrences(functionStatement(d2Source), D2_LOOKUP)).toBe(1);
  });

  it("equals D2's statement with only the predicate and the lock added", () => {
    // The primary proof. The expected text is built from history and the two
    // authorized edits, so any other difference anywhere in the producer — a
    // dropped ownership check, a reworded exception, an added snapshot key —
    // fails here rather than needing its own assertion.
    const expected = functionStatement(d2Source).replace(D2_LOOKUP, DB0_LOOKUP);
    expect(db0Function).toBe(expected);
  });

  it("no longer contains D2's unguarded lookup", () => {
    expect(occurrences(db0Function, D2_LOOKUP)).toBe(0);
    expect(occurrences(db0Function, DB0_LOOKUP)).toBe(1);
  });

  it("preserves the declared function contract verbatim", () => {
    expect(db0Function).toContain("returns trigger");
    expect(db0Function).toContain("language plpgsql");
    expect(db0Function).toContain("security invoker");
    expect(db0Function).toContain("set search_path to ''");
  });
});

// ─── Lock contract ───────────────────────────────────────────────────────────

describe("EQ3-S1 DB0 — lock strength", () => {
  it("takes FOR SHARE", () => {
    expect(db0FunctionCode).toContain(REQUIRED_LOCK);
  });

  it("keeps the active predicate inside the locking select", () => {
    // Adjacency is the contract, not mere co-presence: only the locking
    // select's own WHERE clause is re-evaluated after waiting on the archiver.
    expect(db0FunctionCode).toContain(LOOKUP_ADJACENCY);
  });

  it("uses no other lock strength and no lock modifier", () => {
    for (const forbidden of FORBIDDEN_LOCKS) {
      expect(db0FunctionCode).not.toContain(forbidden);
    }
  });

  it("adds no timeout behaviour", () => {
    expect(db0FunctionCode).not.toContain("statement_timeout");
    expect(db0FunctionCode).not.toContain("lock_timeout");
    expect(db0FunctionCode).not.toContain("set local");
  });
});

// ─── Preserved V2 behaviour ──────────────────────────────────────────────────

describe("EQ3-S1 DB0 — the V2 producer is otherwise untouched", () => {
  it("keeps the null club_id path", () => {
    expect(db0Function).toContain("if new.club_id is null then");
    expect(db0Function).toContain("new.analysis_family := null;");
    expect(db0Function).toContain("new.equipment_snapshot := null;");
  });

  it("keeps the explicit ownership check", () => {
    expect(db0Function).toContain(
      "if v_equipment.user_id is distinct from new.user_id then"
    );
  });

  it("keeps the generic inaccessible-record exception", () => {
    // An archived row now fails through this same message. A distinct
    // "archived" error would let a caller probe another golfer's equipment
    // lifecycle by id.
    expect(db0Function).toContain(
      "EQ1S1R: the selected club_id does not reference an accessible equipment record."
    );
    expect(db0FunctionCode).not.toContain("archived club");
    expect(db0FunctionCode).not.toContain("is archived");
  });

  it("keeps the analysis-family mapping", () => {
    expect(db0Function).toContain("if v_equipment.club_type = 'Putter' then");
    expect(db0Function).toContain("new.analysis_family := 'putting';");
    expect(db0Function).toContain("new.analysis_family := 'full_swing';");
  });

  it("keeps both catalog lookups", () => {
    expect(db0Function).toContain("from public.equipment_manufacturers");
    expect(db0Function).toContain("from public.equipment_models");
  });

  it("still emits schema_version 2", () => {
    expect(db0Function).toContain("'schema_version', 2,");
    expect(db0FunctionCode).not.toContain("'schema_version', 1");
    expect(db0FunctionCode).not.toContain("'schema_version', 3");
  });

  it("emits exactly the 15 top-level V2 keys, in order", () => {
    expect(topLevelSnapshotKeys(db0Function)).toEqual(V2_KEYS);
  });

  it("copies club_designation by value and infers nothing", () => {
    expect(db0Function).toContain(
      "'club_designation', to_jsonb(v_equipment.club_designation),"
    );
    expect(db0FunctionCode).not.toContain("coalesce");
  });

  it("returns new", () => {
    expect(db0Function).toContain("return new;");
  });

  it("does not replace the immutability guard", () => {
    // The update-time guard is a separate object. DB0 may assert that it still
    // exists, but must never define, replace or re-bind it.
    expect(migrationCode).not.toContain(
      `create or replace function ${IMMUTABILITY_FUNCTION}`
    );
    expect(migrationCode).not.toContain(
      `create function ${IMMUTABILITY_FUNCTION}`
    );
    expect(occurrences(migrationCode, "create or replace function")).toBe(1);
  });
});

// ─── Preflight guard coverage ────────────────────────────────────────────────

describe("EQ3-S1 DB0 preflight — proves the environment before replacing", () => {
  const pre = preflightSource();

  it("proves function identity through the catalogs, not through deparsed text", () => {
    expect(pre).toContain(`to_regprocedure('${TARGET_FUNCTION}')`);
    expect(pre).toContain("p.pronargs = 0");
    expect(pre).toContain("p.prorettype = 'pg_catalog.trigger'::regtype");
    expect(pre).toContain("lanname = 'plpgsql'");
  });

  it("proves owner and security posture from pg_proc", () => {
    expect(pre).toContain("p.proowner = 'postgres'::regrole");
    // SECURITY INVOKER is the default and pg_get_functiondef omits the words,
    // so the catalog flag is the only reliable proof.
    expect(pre).toContain("p.prosecdef = false");
    expect(normalised(pre)).not.toContain("pg_get_functiondef");
  });

  it("proves the empty search_path and the volatility/parallel contract", () => {
    expect(pre).toContain("p.proconfig = array['search_path=\"\"']::text[]");
    expect(pre).toContain("p.provolatile = 'v'");
    expect(pre).toContain("p.proparallel = 'u'");
  });

  it("proves the trigger binding from tgfoid and tgtype bits", () => {
    expect(pre).toContain("t.tgname = 'swing_analysis_apply_equipment_snapshot'");
    expect(pre).toContain("t.tgfoid = v_fn");
    expect(pre).toContain("t.tgenabled <> 'D'");
    expect(pre).toContain("(t.tgtype & 1) <> 0");
    expect(pre).toContain("(t.tgtype & 2) <> 0");
    expect(pre).toContain("(t.tgtype & 4) <> 0");
  });

  it("proves the DB1 is_archived physical contract", () => {
    expect(pre).toContain("a.attname = 'is_archived'");
    expect(pre).toContain("a.atttypid = 'pg_catalog.bool'::regtype");
    expect(pre).toContain("a.attnotnull");
    expect(pre).toContain("a.attgenerated = ''");
    expect(pre).toContain("a.attidentity = ''");
    expect(pre).toContain(
      "pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'"
    );
  });

  it("proves the club_id foreign key from attribute numbers, not a deparsed string", () => {
    expect(pre).toContain("c.contype = 'f'");
    expect(pre).toContain("c.conkey = array[v_sa_club_attnum]::smallint[]");
    expect(pre).toContain("c.confkey = array[v_ue_id_attnum]::smallint[]");
    expect(pre).toContain("c.confdeltype = 'n'");
    expect(pre).not.toContain("pg_get_constraintdef");
  });

  it("proves the privileges SELECT ... FOR SHARE requires", () => {
    // FOR SHARE needs UPDATE on the locked table as well as SELECT, and the
    // producer is SECURITY INVOKER, so it runs as the calling role.
    expect(pre).toContain(
      "has_table_privilege('authenticated', 'public.user_equipment', 'SELECT')"
    );
    expect(pre).toContain(
      "has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE')"
    );
    expect(pre).toContain(
      "has_table_privilege('service_role', 'public.user_equipment', 'SELECT')"
    );
    expect(pre).toContain(
      "has_table_privilege('service_role', 'public.user_equipment', 'UPDATE')"
    );
    expect(pre).toContain(
      "has_table_privilege('authenticated', 'public.swing_analysis', 'INSERT')"
    );
  });

  it("proves the EQ3-DB3 delete contract and the function EXECUTE surface", () => {
    expect(pre).toContain(
      "has_table_privilege('anon', 'public.user_equipment', 'DELETE')"
    );
    expect(pre).toContain(
      "has_table_privilege('authenticated', 'public.user_equipment', 'DELETE')"
    );
    expect(pre).toContain(
      "has_table_privilege('service_role', 'public.user_equipment', 'DELETE')"
    );
    expect(pre).toContain("has_function_privilege('service_role', v_fn, 'EXECUTE')");
    expect(pre).toContain("has_function_privilege('authenticated', v_fn, 'EXECUTE')");
    expect(pre).toContain("has_function_privilege('anon', v_fn, 'EXECUTE')");
  });

  it("proves RLS state and the ownership policy with the non-pretty deparser", () => {
    expect(pre).toContain("c.relrowsecurity");
    expect(pre).toContain("c.relforcerowsecurity");
    expect(pre).toContain("p.polname = 'Users manage own equipment'");
    // pg_get_expr(..., true) drops the outer parentheses, so a pretty
    // comparison fails closed against a policy that has not changed at all.
    expect(pre).toContain(
      "pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(pre).toContain(
      "pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(pre).not.toContain("pg_get_expr(p.polqual, p.polrelid, true)");
    expect(pre).not.toContain("pg_get_expr(p.polwithcheck, p.polrelid, true)");
  });

  it("proves the installed body is still the V2 producer", () => {
    expect(pre).toContain("'schema_version'', 2");
    expect(pre).toContain("v_equipment.user_id is distinct from new.user_id");
  });

  it("refuses to apply twice", () => {
    // A second application must fail loudly rather than silently re-replacing.
    expect(pre).toContain("EQ3S1DB0-PRE-18");
    expect(pre).toContain("EQ3S1DB0-PRE-19");
    expect(pre).toContain("position('is_archived' in v_norm) <> 0");
    for (const forbidden of [REQUIRED_LOCK, ...FORBIDDEN_LOCKS]) {
      expect(pre).toContain(`position('${forbidden}' in v_norm) <> 0`);
    }
  });

  it("proves the immutability guard exists before touching anything", () => {
    expect(pre).toContain(`to_regprocedure('${IMMUTABILITY_FUNCTION}')`);
    expect(pre).toContain("t.tgname = 'swing_analysis_guard_equipment_immutability'");
    expect(pre).toContain("(t.tgtype & 16) <> 0");
  });

  it("repairs nothing it finds", () => {
    const preCode = normalised(pre);
    expect(preCode).not.toContain("alter ");
    expect(preCode).not.toMatch(/\bgrant\s/);
    expect(preCode).not.toMatch(/\brevoke\s/);
    expect(preCode).not.toContain("create ");
  });
});

// ─── Postflight guard coverage ───────────────────────────────────────────────

describe("EQ3-S1 DB0 postflight — proves the result, and that nothing else moved", () => {
  const post = postflightSource();

  it("re-proves identity, owner, security posture and search_path", () => {
    expect(post).toContain(`to_regprocedure('${TARGET_FUNCTION}')`);
    expect(post).toContain("p.pronargs = 0");
    expect(post).toContain("p.proowner = 'postgres'::regrole");
    expect(post).toContain("p.prosecdef = false");
    expect(post).toContain("p.proconfig = array['search_path=\"\"']::text[]");
    expect(post).toContain("p.provolatile = 'v'");
    expect(post).toContain("p.proparallel = 'u'");
  });

  it("re-proves the trigger binding and the EXECUTE surface", () => {
    expect(post).toContain("t.tgfoid = v_fn");
    expect(post).toContain("t.tgenabled <> 'D'");
    expect(post).toContain("has_function_privilege('service_role', v_fn, 'EXECUTE')");
    expect(post).toContain("has_function_privilege('authenticated', v_fn, 'EXECUTE')");
    expect(post).toContain("has_function_privilege('anon', v_fn, 'EXECUTE')");
  });

  it("proves the active predicate and the lock are adjacent in the installed body", () => {
    expect(post).toContain(LOOKUP_ADJACENCY);
  });

  it("rejects every other lock strength and modifier", () => {
    for (const forbidden of FORBIDDEN_LOCKS) {
      expect(post).toContain(`position('${forbidden}' in v_norm) <> 0`);
    }
  });

  it("re-proves the V2 envelope, key by key", () => {
    expect(post).toContain("'schema_version'', 2");
    for (const key of V2_KEYS) {
      expect(post).toContain(`'${key}'`);
    }
    expect(post).toContain(
      "'club_designation'', to_jsonb(v_equipment.club_designation)"
    );
    expect(post).toContain("position('coalesce' in v_norm) <> 0");
  });

  it("re-proves the surrounding schema, privileges and policy are unchanged", () => {
    expect(post).toContain("a.attname = 'is_archived'");
    expect(post).toContain("c.confdeltype = 'n'");
    expect(post).toContain("c.relrowsecurity");
    expect(post).toContain("c.relforcerowsecurity");
    expect(post).toContain(
      "pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'"
    );
    expect(post).not.toContain("pg_get_expr(p.polqual, p.polrelid, true)");
    expect(post).toContain(
      "has_table_privilege('anon', 'public.user_equipment', 'DELETE')"
    );
    expect(post).toContain(
      "has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE')"
    );
    expect(post).toContain(
      "has_table_privilege('authenticated', 'public.swing_analysis', 'INSERT')"
    );
  });

  it("re-proves the immutability guard survived untouched", () => {
    expect(post).toContain(`to_regprocedure('${IMMUTABILITY_FUNCTION}')`);
    expect(post).toContain("t.tgname = 'swing_analysis_guard_equipment_immutability'");
    expect(post).toContain("(t.tgtype & 16) <> 0");
  });

  it("introduces no persistent helper to carry preflight values forward", () => {
    const postCode = normalised(post);
    expect(postCode).not.toContain("create ");
    expect(postCode).not.toContain("alter ");
    expect(postCode).not.toMatch(/\binsert\s+into\b/);
  });
});

// ─── Suite self-honesty ──────────────────────────────────────────────────────

describe("EQ3-S1 DB0 suite — stays a static source contract", () => {
  it("reads only vitest and read-only Node builtins", () => {
    const ownSource = readSource("lib/equipment-snapshot-active-guard-eq3-s1-db0.test.ts");
    const importBlock = ownSource.slice(0, ownSource.indexOf("const __dirname"));
    const specifiers = (importBlock.match(/from "[^"]+"/g) ?? [])
      .map((clause) => clause.slice('from "'.length, -1))
      .sort();
    expect(specifiers).toEqual([
      "@/lib/migration-inventory",
      "node:crypto",
      "node:fs",
      "node:path",
      "node:url",
      "vitest",
    ]);
  });

  it("derives no expectation from the migration it judges", () => {
    // Every contract constant above is hand-transcribed from the authorization.
    expect(D2_LOOKUP).not.toContain("is_archived");
    expect(DB0_LOOKUP).toContain("and user_equipment.is_archived = false");
    expect(DB0_LOOKUP).toContain("for share;");
    expect(V2_KEYS).toHaveLength(15);
    expect(FORBIDDEN_LOCKS).not.toContain(REQUIRED_LOCK);
  });
});
