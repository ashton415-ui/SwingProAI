/**
 * EQ5D — canonical putting drill catalog seed contract.
 *
 * Unit S made public.drills.drill_family authoritative and Unit F made the two
 * active full-swing consumers filter on it positively. Only then could putting
 * drills exist in the canonical catalog at all. This suite pins the seven-row
 * seed that followed, so the adjudicated coaching copy and the frozen drill
 * identities cannot drift after the fact.
 *
 * Two independent locks are asserted. The first is the manifest: the seven rows
 * are restated here as data and hashed, and both the whole-manifest digest and
 * the seven per-row digests must equal the values frozen at the hardening gate.
 * The second is the migration: the checked-in SQL must contain exactly those
 * values, insert-only, with no conflict suppression and no generated id.
 *
 * The suite is a static source contract. It opens no database, makes no network
 * call and writes nothing: every negative case is proved by mutating a copy of
 * the source in memory and asserting the matching predicate flips to false.
 *
 * The migration filename is never written here directly. It comes from
 * migration-inventory, so the inventory stays the single place a migration is
 * registered.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUTTING_DRILL_CATALOG_SEED_FILENAME } from "./migration-inventory";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIGRATION_PATH = path.join(
  REPO_ROOT,
  "supabase",
  "migrations",
  PUTTING_DRILL_CATALOG_SEED_FILENAME,
);
const PAGE_PATH = path.join(REPO_ROOT, "app", "(dashboard)", "drills", "page.tsx");
const ROUTE_PATH = path.join(REPO_ROOT, "app", "api", "verify-drill", "route.ts");

/** The one sentinel every putting row carries while putting verification does not exist. */
const SENTINEL = "unsupported:putting_verification_not_implemented";

/** The canonical row shape. Key order is part of the frozen manifest. */
interface CanonicalDrill {
  id: string;
  name: string;
  target_metric: string;
  the_why: string;
  the_how: string;
  the_feel: string;
  ai_verification_prompt: string;
  instructional_video_url: null;
  drill_family: "putting";
}

/**
 * The adjudicated seven-row manifest, restated verbatim. Field order here is
 * load-bearing: the frozen digests are taken over this serialization.
 */
const FROZEN_ROWS: CanonicalDrill[] = [
  {
    id: "d0366fc8-c428-5a21-a145-18ef24b15220",
    name: "Eye-Line Setup Check",
    target_metric: "address_setup",
    the_why:
      "Where the eyes sit relative to the ball-target line changes how the start line looks from address, so a setup that varies between putts can make the same stroke aim differently.",
    the_how:
      "On a flat 6-foot putt take your normal address, then drop a second ball from the bridge of your nose and mark where it lands. Repeat five times. Success: the five marks fall within one ball-width of each other and each sits on or just inside the ball-target line.",
    the_feel:
      "A still, balanced head, and a start line that looks the same at address on every rep.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "87a51ed8-6cdc-50c7-864b-2bb9d88af5f7",
    name: "Start-Line Gate",
    target_metric: "start_line_control",
    the_why:
      "If the ball does not start on the line you chose, a good read cannot help and a poor read cannot be diagnosed. Gating the start line separates face control from green reading.",
    the_how:
      "On a flat 6-foot putt set two tees as a gate about one and a half ball-widths wide, 12 inches ahead of the ball on your intended start line. Hit 10 putts. Success: 8 of 10 pass through without touching a tee.",
    the_feel:
      "The face square to the start line through impact, on a line committed to before the stroke begins.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "25299bc9-cee3-5188-b01e-b678f3b5d5f2",
    name: "Heel-Toe Strike Gate",
    target_metric: "strike_location",
    the_why:
      "A putt struck away from the center of the face tends to lose ball speed and turn the face slightly, so strokes that feel identical can finish different distances. Consistent strike makes other putting feedback trustworthy.",
    the_how:
      "Place a tee just outside the heel and just outside the toe of the putter head at address, forming a gate the head must pass through. Hit 10 putts of 10 feet. Success: 9 of 10 with no tee contact and the same sound off the face.",
    the_feel: "The ball leaving the middle of the face with one repeatable, solid sound.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "bcae0cfe-9834-5502-9e0b-03b93d5c8a10",
    name: "Rail Path Channel",
    target_metric: "stroke_path_control",
    the_why:
      "A stroke that moves sharply across the intended line forces the face to compensate, so two variables must be timed instead of one repeated. A channel shows excessive lateral movement while still allowing the gentle arc most strokes have.",
    the_how:
      "Lay two alignment sticks as a channel a little wider than the putter head, aimed at the hole on a flat 8-foot putt, wide enough that your normal arc passes through untouched. Make 10 strokes. Success: 9 of 10 with no stick contact and the ball finishing in the hole or within one ball past.",
    the_feel:
      "The head tracking its own shallow arc inside the channel, shoulders rocking rather than hands steering it straight.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "0975bf69-b793-515a-bf5e-7f5a582d2c74",
    name: "Distance Ladder",
    target_metric: "distance_control",
    the_why:
      "Poor distance control is a common contributor to three-putting, particularly from longer range. Speed is a calibration skill, so it improves faster with feedback at several lengths than with repetition at one.",
    the_how:
      "Place tees at 15, 25, 35 and 45 feet on a flat section. Putt one ball to each in ascending order, then descending. Success: every ball finishes past its tee but within three feet of it. A ball short, or more than three feet past, restarts the ladder.",
    the_feel:
      "Stroke length changing with distance while the rhythm stays the same, so the stroke gets longer rather than quicker.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "6530ed44-b218-519d-9cdd-57cf2199e44e",
    name: "Two-Count Tempo",
    target_metric: "stroke_tempo",
    the_why:
      "An inconsistent rhythm, such as a rushed transition or a long backstroke rescued by a short quick strike, makes face, strike and distance harder to repeat. Holding one cadence lets stroke length do most of the work.",
    the_how:
      "Use a simple two-beat count: one on the backstroke, two through impact. Hit 10 putts of 20 feet holding that count and letting only stroke length change. Success: 8 of 10 keep the count unchanged with a through-stroke at least as long as the backstroke. A metronome is an optional aid, set to whatever beat suits your own stroke.",
    the_feel: "One unhurried beat repeating, the same whether the putt is short or long.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
  {
    id: "e9e69977-64e7-582f-b721-228f594e7f9a",
    name: "Three-Foot Circle",
    target_metric: "short_putt_conversion",
    the_why:
      "Putts inside a few feet are expected to be holed, so a miss costs a shot already counted on. Holing them in an unbroken run adds a consequence that repeating the same putt does not.",
    the_how:
      "Place six balls in a circle three feet from the hole, evenly spaced so each putt has a different break. Hole all six in a row; a miss restarts the circle. Complete two full circles.",
    the_feel: "The same unhurried routine on the sixth putt as on the first.",
    ai_verification_prompt: SENTINEL,
    instructional_video_url: null,
    drill_family: "putting",
  },
];

/** SHA-256 of the canonical pretty-printed manifest, frozen at the hardening gate. */
const FROZEN_MANIFEST_SHA256 =
  "0eeeb056498ee3f413d4946da99a0b1111d5fa291932dd44cb0e51f1ebb55b84";

/** SHA-256 of each row as compact JSON, in manifest order. */
const FROZEN_ROW_SHA256: string[] = [
  "637ec5cb64a65c14431f18287fa66066cac974ec1690750643a71ade5e197e77",
  "3e7063943d316ace41f22835bc095d93e2fd97e8c56a90fe5df5fbca7cef0b49",
  "d34a676dcce7c2f48f27fb554d8546185b5fec1ba0305a379c7092b49ed1ab7f",
  "cc4d676160fee6b7161334b9c2697e9afdbb263567de142d1061a34982059411",
  "4ddd58c1d787ba08d8e69006905d6a7706738c9ed1398b589b31e462f2a10638",
  "a09bb4d89cd4d8fd25470e925c53c19baac669b48df318cccc63acfa369f02ea",
  "1abfcfa27108e3420334ab0a5bd60a9397ed7d55c6dd80d2f58832363dae89eb",
];

/** The explicit insert-column list, in the frozen order. */
const FROZEN_COLUMNS: string[] = [
  "id",
  "name",
  "target_metric",
  "the_why",
  "the_how",
  "the_feel",
  "ai_verification_prompt",
  "instructional_video_url",
  "drill_family",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Reads a repository source file. CRLF is normalised for assertion only. */
function readSource(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

/** Index of `needle`, throwing rather than silently yielding -1. */
function indexRequired(source: string, needle: string): number {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`required anchor absent: ${needle}`);
  return at;
}

/** Strips SQL comments so a token in prose is never mistaken for executable SQL. */
function executableSql(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*--.*$/gm, " ");
}

/**
 * The statement beginning at `anchor`, ending at the first semicolon that is not
 * inside a single-quoted SQL string literal.
 *
 * A plain indexOf(";") is wrong here, and was: the adjudicated copy for
 * Three-Foot Circle reads "Hole all six in a row; a miss restarts the circle.",
 * so the first semicolon after the INSERT sits inside a string literal and cut
 * the statement four fields short. This scans instead, tracking string state,
 * where a semicolon is ordinary data and a doubled quote is an escaped quote
 * rather than the end of the string. It throws rather than ever returning a
 * truncated statement.
 */
function sqlStatementFrom(sql: string, anchor: string): string {
  const from = indexRequired(sql, anchor);
  let inString = false;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") i += 1;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === ";") return sql.slice(from, i + 1);
  }
  if (inString) throw new Error("unterminated SQL string literal");
  throw new Error("unterminated SQL statement: no terminating semicolon");
}

/** The INSERT statement only, ending at its true terminator. */
function insertStatement(source: string): string {
  return sqlStatementFrom(executableSql(source), "insert into public.drills (");
}

/** The VALUES tail of the INSERT: everything after the explicit column list. */
function insertValues(source: string): string {
  const statement = insertStatement(source);
  const from = indexRequired(statement, "values");
  return statement.slice(from);
}

/** The explicit column list between the first parentheses of the INSERT. */
function insertColumns(source: string): string[] {
  const statement = insertStatement(source);
  const open = indexRequired(statement, "(");
  const close = statement.indexOf(")", open);
  if (close === -1) throw new Error("unterminated INSERT column list");
  return statement
    .slice(open + 1, close)
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Counts non-overlapping occurrences of `fragment`. */
function countOf(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

/** True when every frozen id and name appears in the INSERT values exactly once. */
function seedCarriesFrozenIdentities(source: string): boolean {
  const values = insertValues(source);
  return FROZEN_ROWS.every(
    (row) => countOf(values, `'${row.id}'`) === 1 && countOf(values, `'${row.name}'`) === 1,
  );
}

/** True when every inserted row states the putting family and the sentinel explicitly. */
function seedIsExplicitlyPutting(source: string): boolean {
  const values = insertValues(source);
  return countOf(values, "'putting'") === 7 && countOf(values, `'${SENTINEL}'`) === 7;
}

/** True when the migration suppresses no conflict and generates no id. */
function seedFailsLoudly(source: string): boolean {
  const sql = executableSql(source).toLowerCase();
  const forbidden = [
    "on conflict",
    "gen_random_uuid",
    "uuid_generate_v4",
    "uuid_generate_v5",
    "truncate",
    "merge ",
  ];
  return forbidden.every((f) => !sql.includes(f)) && sql.includes("raise exception");
}

/** True when preflight precedes the INSERT and postflight follows it. */
function seedIsGuardedInOrder(source: string): boolean {
  const pre = source.indexOf("-- PREFLIGHT");
  const ins = source.indexOf("insert into public.drills (");
  const post = source.indexOf("-- POSTFLIGHT");
  if (pre === -1 || ins === -1 || post === -1) return false;
  return pre < ins && ins < post;
}

/** True when a full-swing consumer still carries the Unit F family predicate. */
function consumerIsFamilySafe(source: string): boolean {
  return source.includes('.eq("drill_family", "full_swing")');
}

/** Removes the first occurrence of `needle`, asserting it was present. */
function withoutFirst(source: string, needle: string): string {
  const at = indexRequired(source, needle);
  return source.slice(0, at) + source.slice(at + needle.length);
}

const migration = readSource(MIGRATION_PATH);
const page = readSource(PAGE_PATH);
const route = readSource(ROUTE_PATH);

describe("EQ5D putting seed — frozen manifest", () => {
  it("reproduces the adjudicated manifest digest exactly", () => {
    const serialized = `${JSON.stringify(FROZEN_ROWS, null, 2)}\n`;
    expect(sha256(serialized)).toBe(FROZEN_MANIFEST_SHA256);
  });

  it("reproduces all seven adjudicated row digests exactly", () => {
    const actual = FROZEN_ROWS.map((row) => sha256(JSON.stringify(row)));
    expect(actual).toEqual(FROZEN_ROW_SHA256);
  });

  it("carries exactly seven rows with unique ids, names and target metrics", () => {
    expect(FROZEN_ROWS).toHaveLength(7);
    expect(new Set(FROZEN_ROWS.map((r) => r.id)).size).toBe(7);
    expect(new Set(FROZEN_ROWS.map((r) => r.name)).size).toBe(7);
    expect(new Set(FROZEN_ROWS.map((r) => r.target_metric)).size).toBe(7);
  });

  it("states the putting family and the unsupported sentinel on every row", () => {
    for (const row of FROZEN_ROWS) {
      expect(row.drill_family).toBe("putting");
      expect(row.ai_verification_prompt).toBe(SENTINEL);
      expect(row.instructional_video_url).toBeNull();
    }
  });

  it("keys every row in the frozen field order and adds no field", () => {
    for (const row of FROZEN_ROWS) {
      expect(Object.keys(row)).toEqual(FROZEN_COLUMNS);
    }
  });

  it("stays pure ASCII so SQL and JSON cannot diverge typographically", () => {
    for (const row of FROZEN_ROWS) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") {
          expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
        }
      }
    }
  });
});

describe("EQ5D putting seed — migration shape", () => {
  it("exists at the filename the inventory registers", () => {
    expect(/^\d{14}_putting_drill_catalog_seed\.sql$/.test(PUTTING_DRILL_CATALOG_SEED_FILENAME)).toBe(
      true,
    );
    expect(migration.length).toBeGreaterThan(0);
  });

  it("writes only public.drills, and only once", () => {
    const sql = executableSql(migration);
    expect(countOf(sql, "insert into ")).toBe(1);
    expect(countOf(sql, "insert into public.drills (")).toBe(1);
  });

  it("uses an explicit column list in the frozen order", () => {
    expect(insertColumns(migration)).toEqual(FROZEN_COLUMNS);
  });

  it("omits created_at so the database supplies it", () => {
    expect(insertColumns(migration)).not.toContain("created_at");
  });

  it("wraps the seed in a single explicit transaction", () => {
    const sql = executableSql(migration);
    expect((sql.match(/^begin;$/gm) ?? [])).toHaveLength(1);
    expect((sql.match(/^commit;$/gm) ?? [])).toHaveLength(1);
  });

  it("guards the insert with preflight before and postflight after", () => {
    expect(seedIsGuardedInOrder(migration)).toBe(true);
  });

  it("raises rather than suppressing an unexpected pre-existing row", () => {
    expect(seedFailsLoudly(migration)).toBe(true);
  });

  it("performs no update, delete, truncate or merge", () => {
    const sql = executableSql(migration).toLowerCase();
    expect(/\bupdate\s+public\./.test(sql)).toBe(false);
    expect(/\bdelete\s+from\b/.test(sql)).toBe(false);
    expect(sql.includes("truncate")).toBe(false);
    expect(sql.includes("merge ")).toBe(false);
  });

  it("changes no schema, policy or grant", () => {
    const sql = executableSql(migration).toLowerCase();
    for (const ddl of ["add column", "drop column", "create table", "alter type", "create policy", "drop policy", "grant ", "revoke "]) {
      expect(sql.includes(ddl)).toBe(false);
    }
  });
});

describe("EQ5D putting seed — migration carries the frozen values", () => {
  it("inserts every frozen id and name exactly once", () => {
    expect(seedCarriesFrozenIdentities(migration)).toBe(true);
  });

  it("inserts every frozen target metric", () => {
    const values = insertValues(migration);
    for (const row of FROZEN_ROWS) {
      expect(countOf(values, `'${row.target_metric}'`)).toBe(1);
    }
  });

  it("inserts the exact frozen coaching copy for every row", () => {
    const values = insertValues(migration);
    for (const row of FROZEN_ROWS) {
      expect(values).toContain(`'${row.the_why}'`);
      expect(values).toContain(`'${row.the_how}'`);
      expect(values).toContain(`'${row.the_feel}'`);
    }
  });

  it("states the putting family and the sentinel seven times each", () => {
    expect(seedIsExplicitlyPutting(migration)).toBe(true);
  });

  it("leaves instructional_video_url NULL for all seven rows", () => {
    expect(countOf(insertValues(migration), "NULL")).toBe(7);
  });

  it("generates no id at execution time", () => {
    const sql = executableSql(migration).toLowerCase();
    expect(sql.includes("gen_random_uuid")).toBe(false);
    expect(sql.includes("uuid_generate")).toBe(false);
  });

  it("asserts the postflight against every frozen field", () => {
    const postflight = migration.slice(indexRequired(migration, "-- POSTFLIGHT"));
    for (const column of ["name", "target_metric", "the_why", "the_how", "the_feel", "ai_verification_prompt", "drill_family"]) {
      expect(postflight).toContain(`d.${column} is distinct from e.${column}`);
    }
    expect(postflight).toContain("d.instructional_video_url is not null");
  });

  it("asserts nothing about total row count, which differs per environment", () => {
    const sql = executableSql(migration);
    expect(sql).not.toContain("count(*) from public.drills;");
    expect(sql).not.toContain("full_swing");
  });
});

describe("EQ5D putting seed — scope firewall", () => {
  it("admits no recommendation-engine concept", () => {
    const sql = migration.toLowerCase();
    for (const token of ["recommend", "ranking", "confidence", "fallback", "prescription", "progression"]) {
      expect(sql.includes(token)).toBe(false);
    }
  });

  it("admits no equipment, manufacturer or commercial field", () => {
    const sql = migration.toLowerCase();
    for (const token of ["manufacturer", "sponsor", "affiliate", "brand", "msrp", "price", "tier"]) {
      expect(sql.includes(token)).toBe(false);
    }
  });

  it("does not rewrite the existing full-swing catalog", () => {
    const values = insertValues(migration);
    for (const legacy of ["One-Piece Takeaway", "Pump Drill", "Shaft Plane Stick Drill", "Towel Under Arm", "Wall Hip Turn Drill"]) {
      expect(values.includes(legacy)).toBe(false);
    }
  });
});

describe("EQ5D putting seed — Unit F firewall regression", () => {
  it("leaves the /drills catalog query family-filtered", () => {
    expect(consumerIsFamilySafe(page)).toBe(true);
  });

  it("leaves the verify-drill lookup family-filtered", () => {
    expect(consumerIsFamilySafe(route)).toBe(true);
  });

  it("hard-codes no putting id into either full-swing consumer", () => {
    for (const row of FROZEN_ROWS) {
      expect(page.includes(row.id)).toBe(false);
      expect(route.includes(row.id)).toBe(false);
    }
  });

  it("hard-codes no putting drill name into either full-swing consumer", () => {
    for (const row of FROZEN_ROWS) {
      expect(page.includes(row.name)).toBe(false);
      expect(route.includes(row.name)).toBe(false);
    }
  });
});

describe("EQ5D putting seed — SQL statement scanner", () => {
  const ANCHOR = "insert into public.drills (";

  const EMBEDDED = [
    "insert into public.drills (name) values ('alpha; beta');",
    "select 1;",
  ].join("\n");

  const DOUBLED = [
    "insert into public.drills (name)",
    "values ('Golfer''s cue; hold');",
    "select 1;",
  ].join("\n");

  it("does not end the statement on a semicolon inside a string", () => {
    const extracted = sqlStatementFrom(EMBEDDED, ANCHOR);
    expect(extracted).toBe("insert into public.drills (name) values ('alpha; beta');");
    expect(extracted).not.toContain("select 1;");
  });

  it("treats a doubled single quote as an escape, not the end of the string", () => {
    const extracted = sqlStatementFrom(DOUBLED, ANCHOR);
    expect(extracted).toBe(
      "insert into public.drills (name)\nvalues ('Golfer''s cue; hold');",
    );
    expect(extracted).not.toContain("select 1;");
  });

  it("throws rather than returning a statement with no terminator", () => {
    expect(() => sqlStatementFrom("insert into public.drills (name) values ('a')", ANCHOR)).toThrow(
      /no terminating semicolon/,
    );
  });

  it("throws rather than running past an unterminated string", () => {
    expect(() => sqlStatementFrom("insert into public.drills (name) values ('a;", ANCHOR)).toThrow(
      /unterminated SQL string/,
    );
  });

  it("reaches the final row of the real migration, which the old boundary truncated", () => {
    const values = insertValues(migration);
    const last = FROZEN_ROWS[FROZEN_ROWS.length - 1];
    expect(last.the_how).toContain("; a miss restarts the circle.");
    expect(values).toContain("'" + last.the_how + "'");
    expect(values).toContain("'" + last.the_feel + "'");
  });
});
describe("EQ5D putting seed — non-vacuity of every contract", () => {
  it("catches a missing frozen id", () => {
    const mutated = withoutFirst(migration, "'d0366fc8-c428-5a21-a145-18ef24b15220',");
    expect(mutated).not.toBe(migration);
    expect(seedCarriesFrozenIdentities(mutated)).toBe(false);
  });

  it("catches a missing family literal", () => {
    const mutated = migration.replace("    'putting'\n  ),\n  (\n    '87a51ed8", "    'full_swing'\n  ),\n  (\n    '87a51ed8");
    expect(mutated).not.toBe(migration);
    expect(seedIsExplicitlyPutting(mutated)).toBe(false);
  });

  it("catches a missing sentinel", () => {
    const mutated = withoutFirst(migration, `    '${SENTINEL}',\n`);
    expect(mutated).not.toBe(migration);
    expect(seedIsExplicitlyPutting(mutated)).toBe(false);
  });

  it("catches injected conflict suppression", () => {
    const mutated = migration.replace(
      "  );\n\n-- =",
      "  )\n  on conflict do nothing;\n\n-- =",
    );
    expect(mutated).not.toBe(migration);
    expect(seedFailsLoudly(mutated)).toBe(false);
  });

  it("catches an id generated at execution time", () => {
    const mutated = migration.replace(
      "    'd0366fc8-c428-5a21-a145-18ef24b15220',",
      "    gen_random_uuid(),",
    );
    expect(mutated).not.toBe(migration);
    expect(seedFailsLoudly(mutated)).toBe(false);
  });

  it("catches a removed preflight guard", () => {
    const mutated = withoutFirst(migration, "-- PREFLIGHT");
    expect(mutated).not.toBe(migration);
    expect(seedIsGuardedInOrder(mutated)).toBe(false);
  });

  it("catches a postflight moved ahead of the insert", () => {
    const marker = "-- POSTFLIGHT";
    const without = withoutFirst(migration, marker);
    const at = indexRequired(without, "insert into public.drills (");
    const mutated = without.slice(0, at) + marker + "\n" + without.slice(at);
    expect(mutated).not.toBe(migration);
    expect(seedIsGuardedInOrder(mutated)).toBe(false);
  });

  it("catches a removed family predicate in a full-swing consumer", () => {
    const mutatedPage = withoutFirst(page, '.eq("drill_family", "full_swing")');
    const mutatedRoute = withoutFirst(route, '.eq("drill_family", "full_swing")');
    expect(mutatedPage).not.toBe(page);
    expect(mutatedRoute).not.toBe(route);
    expect(consumerIsFamilySafe(mutatedPage)).toBe(false);
    expect(consumerIsFamilySafe(mutatedRoute)).toBe(false);
  });

  it("catches altered coaching copy through the manifest digest", () => {
    const mutated = FROZEN_ROWS.map((row, i) =>
      i === 0 ? { ...row, the_feel: `${row.the_feel} ` } : row,
    );
    const serialized = `${JSON.stringify(mutated, null, 2)}\n`;
    expect(sha256(serialized)).not.toBe(FROZEN_MANIFEST_SHA256);
  });
});
