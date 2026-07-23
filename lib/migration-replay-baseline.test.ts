import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

// This test file is written to validate exactly one baseline migration. If
// that assumption ever changes, fail loudly rather than silently picking
// the wrong file.
if (migrationFiles.length !== 1) {
  throw new Error(
    `Expected exactly one migration file under supabase/migrations, found ${migrationFiles.length}: ${migrationFiles.join(", ")}`
  );
}

const migrationPath = path.join(migrationsDir, migrationFiles[0]);
// Normalized to LF immediately after reading, matching the SEC1A schema
// tests, so exact-newline-adjacent assertions are independent of Windows
// core.autocrlf checkout behavior.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

/** Strips `-- ...` line comments so keyword/pattern checks can't be fooled by
 *  this file's own prose. */
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

/** Blanks out every `$function$ ... $function$` body. Function bodies are
 *  PL/pgSQL text stored as data — the UPDATE/INSERT statements inside
 *  `link_student_to_coach`, for example, are application logic that only
 *  runs later when the function is called; they are not statements this
 *  migration transaction itself executes. Statement-level DML/DDL
 *  forbidden-pattern checks must look at this transaction-executed view,
 *  not the raw text, or a legitimate function body reads as a violation. */
function stripFunctionBodies(sql: string): string {
  return sql.replace(/\$function\$[\s\S]*?\$function\$/g, "$function$<body-stripped>$function$");
}

/** Blanks out every double-quoted identifier (policy names in this file).
 *  Several real production policy names are plain English phrases —
 *  "Users can insert into their own bag", "Users can delete from their own
 *  bag" — that otherwise collide with the SQL keyword sequences "insert
 *  into" / "delete from" used by the DML forbidden-pattern checks. Policy
 *  names are data (identifiers), never executable SQL, so they must not be
 *  scanned by those checks. */
function stripDoubleQuotedIdentifiers(sql: string): string {
  return sql.replace(/"[^"]*"/g, '"<identifier-stripped>"');
}

/** Collects every regex match without relying on spreading a matchAll()
 *  iterator (this repository's tsconfig target does not enable
 *  downlevelIteration, so `[...str.matchAll(re)]` fails to typecheck). */
function execAll(re: RegExp, input: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m);
  }
  return out;
}

const codeOutsideFunctions = stripFunctionBodies(code);
const codeOutsideFunctionsLower = codeOutsideFunctions.toLowerCase();

// The view used specifically for DML/DDL keyword-sequence scans: function
// bodies AND double-quoted policy-name prose are both excluded, since
// neither represents a statement this migration transaction executes.
const codeForKeywordScan = stripDoubleQuotedIdentifiers(codeOutsideFunctions);
const codeForKeywordScanLower = codeForKeywordScan.toLowerCase();

// ============================================================================
// Shared SQL statement/identifier parsing primitives.
//
// Used by the foreign-key contract (7b) and the table/function privilege
// contracts (12b/12c) below. All three need the same thing: a real,
// auditable little parser over top-level executable SQL — comments and
// function bodies removed, but double-quoted identifiers preserved intact
// (never replaced with a sentinel), so quoted-vs-unquoted and
// case-sensitive-vs-folded identifiers can be told apart exactly the way
// PostgreSQL itself tells them apart. `codeOutsideFunctions` (defined
// above) is exactly this view — original case preserved, comments and
// function bodies gone.
// ============================================================================

/** Splits `input` on top-level occurrences of `separator` (a single
 *  character), tracking single-quoted string literals (`'...'`, with `''`
 *  as an escaped quote), double-quoted identifiers (`"..."`, with `""` as
 *  an escaped quote), and parenthesis depth, so a separator inside any of
 *  those is never treated as a real boundary. Shared by the statement
 *  splitter (separator `;`) and the comma-list splitter (separator `,`). */
function splitTopLevelOn(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (input[i + 1] === "'") { current += input[i + 1]; i += 2; continue; }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') {
        if (input[i + 1] === '"') { current += input[i + 1]; i += 2; continue; }
        inDouble = false;
      }
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; continue; }
    if (ch === "(") { depth++; current += ch; i++; continue; }
    if (ch === ")") { depth--; current += ch; i++; continue; }
    if (ch === separator && depth === 0) { parts.push(current); current = ""; i++; continue; }
    current += ch;
    i++;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const splitTopLevelStatements = (input: string): string[] => splitTopLevelOn(input, ";");
const splitTopLevelCommaList = (input: string): string[] => splitTopLevelOn(input, ",");

/** A minimal, auditable cursor-based parser primitive over one SQL
 *  statement or clause. Operates on original-case text: unquoted keywords
 *  and identifiers are matched case-insensitively and folded to lowercase
 *  (matching PostgreSQL's own unquoted-identifier folding); double-quoted
 *  identifiers preserve their exact interior case, with `""` collapsed to
 *  a literal `"`. This is what lets `"public"`/`public` normalize to the
 *  same name while `"Users"` stays distinguishable from `users`. */
class SqlCursor {
  readonly text: string;
  pos: number;

  constructor(text: string, pos = 0) {
    this.text = text;
    this.pos = pos;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.text.length;
  }

  /** Case-insensitively matches and consumes an exact keyword at the
   *  current position (after skipping whitespace), requiring a word
   *  boundary immediately after it. Leaves position unchanged on failure. */
  matchKeyword(keyword: string): boolean {
    this.skipWs();
    const slice = this.text.slice(this.pos, this.pos + keyword.length);
    if (slice.toLowerCase() !== keyword.toLowerCase()) return false;
    const after = this.text[this.pos + keyword.length];
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return false;
    this.pos += keyword.length;
    return true;
  }

  matchChar(ch: string): boolean {
    this.skipWs();
    if (this.text[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  /** Parses one identifier (quoted or unquoted) at the current position.
   *  Returns null (without advancing) if none is present. */
  parseIdentifier(): string | null {
    this.skipWs();
    if (this.text[this.pos] === '"') {
      let i = this.pos + 1;
      let name = "";
      while (i < this.text.length) {
        if (this.text[i] === '"') {
          if (this.text[i + 1] === '"') { name += '"'; i += 2; continue; }
          this.pos = i + 1;
          return name;
        }
        name += this.text[i];
        i++;
      }
      return null; // unterminated quoted identifier
    }
    const start = this.pos;
    let i = this.pos;
    while (i < this.text.length && /[A-Za-z0-9_$]/.test(this.text[i])) i++;
    if (i === start) return null;
    this.pos = i;
    return this.text.slice(start, i).toLowerCase();
  }

  /** Parses `identifier` or `identifier.identifier`. */
  parseQualifiedIdentifier(): { schema: string | null; name: string } | null {
    const first = this.parseIdentifier();
    if (first === null) return null;
    const save = this.pos;
    this.skipWs();
    if (this.text[this.pos] === ".") {
      this.pos++;
      const second = this.parseIdentifier();
      if (second === null) { this.pos = save; return { schema: null, name: first }; }
      return { schema: first, name: second };
    }
    return { schema: null, name: first };
  }

  /** Consumes raw text up to (not including) the next top-level occurrence
   *  of `ch`, respecting quotes and nested parens. Returns null (without
   *  advancing) if `ch` is never found at the top level. */
  consumeBalancedUntil(ch: string): string | null {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    const start = this.pos;
    let i = this.pos;
    while (i < this.text.length) {
      const c = this.text[i];
      if (inSingle) {
        if (c === "'") { if (this.text[i + 1] === "'") { i += 2; continue; } inSingle = false; }
        i++;
        continue;
      }
      if (inDouble) {
        if (c === '"') { if (this.text[i + 1] === '"') { i += 2; continue; } inDouble = false; }
        i++;
        continue;
      }
      if (c === "'") { inSingle = true; i++; continue; }
      if (c === '"') { inDouble = true; i++; continue; }
      // The target terminator must win before generic paren-depth
      // tracking, or a terminator of ")" is misread as closing a paren
      // that was never opened within this scan (corrupting depth for
      // everything after it) instead of ending the scan right here.
      if (depth === 0 && c === ch) { this.pos = i; return this.text.slice(start, i); }
      if (c === "(") { depth++; i++; continue; }
      if (c === ")") { depth--; i++; continue; }
      i++;
    }
    return null;
  }
}

/** Normalizes one identifier token (quoted or unquoted) taken out of
 *  context, e.g. a single entry from a split column list. */
function normalizeIdentifierToken(token: string): string {
  const id = new SqlCursor(token).parseIdentifier();
  return id ?? token.trim().toLowerCase();
}

/** Multiset (not Set) comparison: reports every key whose expected and
 *  actual occurrence counts differ, so a duplicate of an otherwise-valid
 *  tuple is caught here directly (as an "extra" with actual > expected)
 *  rather than relying solely on a separate total-count assertion. */
function multisetDiff(expectedKeys: string[], actualKeys: string[]): { missing: string[]; extra: string[] } {
  const expectedCounts = new Map<string, number>();
  for (const k of expectedKeys) expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
  const actualCounts = new Map<string, number>();
  for (const k of actualKeys) actualCounts.set(k, (actualCounts.get(k) ?? 0) + 1);
  const allKeys = new Set<string>();
  for (const k of Array.from(expectedCounts.keys())) allKeys.add(k);
  for (const k of Array.from(actualCounts.keys())) allKeys.add(k);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of Array.from(allKeys)) {
    const e = expectedCounts.get(k) ?? 0;
    const a = actualCounts.get(k) ?? 0;
    if (a < e) missing.push(`${k} (expected x${e}, found x${a})`);
    if (a > e) extra.push(`${k} (expected x${e}, found x${a})`);
  }
  return { missing: missing.sort(), extra: extra.sort() };
}

// ============================================================================
// Structural offsets (used for ordering assertions, not just presence)
// ============================================================================
const beginOffset = codeLower.search(/^\s*begin\s*;\s*$/im);
const commitOffset = codeLower.search(/^\s*commit\s*;\s*$/im);
const preflightMarkerOffset = codeLower.indexOf("rr1-pre-1");
const firstCreateTableOffset = codeLower.indexOf("create table");
const postflightMarkerOffset = codeLower.indexOf("rr1-post-1");
const lastCreatePolicyOffset = codeLower.lastIndexOf("create policy");
const lastGrantOffset = codeLower.lastIndexOf("\ngrant ");

// ============================================================================
// 1. Transaction shape and ordering
// ============================================================================
describe("migration baseline — transaction shape", () => {
  it("contains exactly one top-level BEGIN and one COMMIT", () => {
    const begins = code.match(/^\s*begin\s*;\s*$/gim) ?? [];
    const commits = code.match(/^\s*commit\s*;\s*$/gim) ?? [];
    expect(begins.length).toBe(1);
    expect(commits.length).toBe(1);
  });

  it("BEGIN precedes the preflight guard, which precedes schema creation", () => {
    expect(beginOffset).toBeGreaterThanOrEqual(0);
    expect(preflightMarkerOffset).toBeGreaterThan(beginOffset);
    expect(firstCreateTableOffset).toBeGreaterThan(preflightMarkerOffset);
  });

  it("the clean-environment preflight appears before any CREATE TABLE", () => {
    // Guards against the preflight guard being moved after DDL, which would
    // let schema creation partially run before the safety check fires.
    expect(preflightMarkerOffset).toBeGreaterThanOrEqual(0);
    expect(firstCreateTableOffset).toBeGreaterThan(preflightMarkerOffset);
  });

  it("policy and grant statements occur after schema creation and before the postflight check", () => {
    expect(lastCreatePolicyOffset).toBeGreaterThan(firstCreateTableOffset);
    expect(lastGrantOffset).toBeGreaterThan(firstCreateTableOffset);
    expect(postflightMarkerOffset).toBeGreaterThan(lastCreatePolicyOffset);
    expect(postflightMarkerOffset).toBeGreaterThan(lastGrantOffset);
  });

  it("COMMIT is the final statement, after the postflight check", () => {
    expect(commitOffset).toBeGreaterThan(postflightMarkerOffset);
  });

  it("states prominently that it is source-only and unapplied", () => {
    expect(migration).toMatch(/THIS MIGRATION IS SOURCE-ONLY\. IT HAS NOT BEEN APPLIED/);
  });
});

// ============================================================================
// 2. Fail-loud clean-environment preflight
// ============================================================================
describe("migration baseline — clean-environment preflight", () => {
  it("aborts if any known application-owned relation already exists", () => {
    expect(codeLower).toContain("rr1-pre-1");
    expect(codeLower).toMatch(/raise exception 'rr1-pre-1/);
  });

  it("checks relkind for tables/views/materialized views, not just tables", () => {
    expect(codeLower).toContain("c.relkind in ('r', 'v', 'm')");
  });

  it("does not use a broad destructive cleanup to force a clean state", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+table\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+schema\b/);
    // Excludes the literal privilege name "truncate" as it legitimately
    // appears in this file's GRANT statements (e.g. "..., truncate, update
    // on ..."), which is never followed directly by a comma when used as
    // an actual TRUNCATE command.
    expect(codeLower).not.toMatch(/\btruncate\b(?!\s*,)/);
  });
});

// ============================================================================
// 3. No forbidden DDL/DML outside the approved schema-creation contract
// ============================================================================
describe("migration baseline — no forbidden statements", () => {
  it("contains no DELETE, UPDATE, or TRUNCATE executed by the migration transaction itself", () => {
    // Evaluated with function bodies AND double-quoted policy names (several
    // of which are English prose like "Users can delete from their own bag")
    // excluded — neither represents DML this migration transaction executes.
    expect(codeForKeywordScanLower).not.toMatch(/\bdelete\s+from\b/);
    expect(codeForKeywordScanLower).not.toMatch(/\bupdate\s+\S+\s+set\b/);
    expect(codeForKeywordScanLower).not.toMatch(/\btruncate\b(?!\s*,)/);
  });

  it("contains no DROP of any kind", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+(table|schema|policy|function|trigger|type|index|view)\b/);
  });

  it("contains no dynamic EXECUTE of DDL/DML", () => {
    expect(codeLower).not.toMatch(/\bexecute\s+format\b/);
    expect(codeLower).not.toMatch(/\bexecute\s+'/);
  });

  it("contains no Supabase migration-repair, db-push, or remote-execution text", () => {
    expect(codeLower).not.toContain("migration repair");
    expect(codeLower).not.toContain("db push");
    expect(codeLower).not.toContain("--linked");
    expect(codeLower).not.toContain("supabase db push");
  });

  it("contains no project ref, connection string, or credential-shaped text", () => {
    expect(codeLower).not.toContain("atlmnqispyzhsahahpjy");
    expect(codeLower).not.toContain("anwkumngotnyxcbgmhnx");
    expect(codeLower).not.toMatch(/postgres:\/\/[^\s]*:[^\s]*@/);
    expect(codeLower).not.toMatch(/service_role.*eyj[a-z0-9_-]{10,}/i);
  });
});

// ============================================================================
// 4. Only the allowed infrastructure INSERT exists
// ============================================================================
describe("migration baseline — data insertion is limited to bucket infrastructure", () => {
  // Evaluated with function bodies and quoted policy-name prose excluded,
  // for the same reasons as the DML check above (policy names like "Users
  // can insert into their own bag" would otherwise false-positive).
  const insertStatements = execAll(/insert\s+into\s+([a-z_][a-z0-9_.]*)/gi, codeForKeywordScan).map((m) => m[1].toLowerCase());

  it("contains exactly one INSERT statement, targeting storage.buckets", () => {
    expect(insertStatements).toEqual(["storage.buckets"]);
  });

  it("does not INSERT into any application table", () => {
    const applicationTables = [
      "public.users", "public.swing_videos", "public.swing_analysis", "public.user_goals",
      "public.swings", "public.user_bags", "public.drills",
    ];
    for (const t of applicationTables) {
      expect(insertStatements).not.toContain(t);
    }
  });

  it("does not INSERT into auth.users or storage.objects", () => {
    expect(insertStatements).not.toContain("auth.users");
    expect(insertStatements).not.toContain("storage.objects");
  });

  it("the bucket insert is deterministic and free of file metadata or object content", () => {
    const bucketInsertIdx = codeLower.indexOf("insert into storage.buckets");
    expect(bucketInsertIdx).toBeGreaterThanOrEqual(0);
    const bucketInsertEnd = codeLower.indexOf(";", bucketInsertIdx);
    const bucketInsertBlock = code.slice(bucketInsertIdx, bucketInsertEnd);
    expect(bucketInsertBlock).toContain("swing-videos");
    expect(bucketInsertBlock).toContain("drill_videos");
    expect(bucketInsertBlock.toLowerCase()).not.toMatch(/signed|token|https?:\/\//);
  });
});

// ============================================================================
// 5. Managed Supabase schemas are not recreated
// ============================================================================
describe("migration baseline — managed schemas are not recreated", () => {
  it("does not CREATE TABLE for auth, storage, or realtime managed relations", () => {
    expect(codeLower).not.toMatch(/create\s+table\s+auth\./);
    expect(codeLower).not.toMatch(/create\s+table\s+storage\./);
    expect(codeLower).not.toMatch(/create\s+table\s+realtime\./);
    expect(codeLower).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?"?auth"?\."?users"?/);
    expect(codeLower).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?"?storage"?\."?(objects|buckets)"?/);
  });

  it("references auth.users, storage.objects, and storage.buckets only via ALTER/CREATE POLICY/CREATE TRIGGER/INSERT, never CREATE TABLE", () => {
    const authUsersMentions = execAll(/auth\.users/g, codeLower);
    expect(authUsersMentions.length).toBeGreaterThan(0);
    // Every mention must not be immediately preceded by "create table"
    for (const m of authUsersMentions) {
      const before = codeLower.slice(Math.max(0, m.index! - 30), m.index!);
      expect(before).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?$/);
    }
  });
});

// ============================================================================
// 6. Required application-owned tables exist
// ============================================================================
const REQUIRED_TABLES = [
  "drills", "drill_submissions", "range_sessions", "swing_analyses", "swing_analysis",
  "swing_breakdowns", "swing_faults", "swing_strengths", "swing_telemetry", "swing_videos",
  "swings", "user_bags", "user_clubs", "user_drills", "user_equipment", "user_goals", "users",
  "automated_prescriptions", "cached_course_holes", "cached_golf_courses", "coach_feedback",
  "coach_golfer_relationships", "coach_profiles", "coach_student_relationships",
  "launch_monitor_data", "launch_monitor_sessions", "lesson_plans", "rounds",
];

describe("migration baseline — required application tables", () => {
  it.each(REQUIRED_TABLES)("creates public.%s", (table) => {
    expect(codeLower).toMatch(new RegExp(`create table public\\.${table}\\s*\\(`));
  });

  it("creates exactly 28 required tables and no fewer", () => {
    expect(REQUIRED_TABLES.length).toBe(28);
  });
});

// ============================================================================
// 7. Dependency order is valid for known foreign keys
// ============================================================================
describe("migration baseline — dependency-safe foreign keys", () => {
  /** Returns the character offset of `CREATE TABLE public.<table>` or -1. */
  function tableCreateOffset(table: string): number {
    return codeLower.indexOf(`create table public.${table.toLowerCase()} (`);
  }

  // Foreign keys are added in a dedicated section after all CREATE TABLE
  // statements, so this test verifies both referenced and referencing
  // tables exist (offset >= 0) rather than asserting inline FK ordering,
  // which this migration deliberately avoids for exactly this reason.
  const FK_PAIRS: [string, string][] = [
    ["swing_videos", "users"],
    ["swing_analysis", "swing_videos"],
    ["swing_analysis", "user_equipment"],
    ["swing_analysis", "swing_telemetry"],
    ["swing_telemetry", "swing_videos"],
    ["swing_telemetry", "user_equipment"],
    ["coach_feedback", "swing_videos"],
    ["coach_feedback", "swing_analysis"],
    ["cached_course_holes", "cached_golf_courses"],
    ["swing_breakdowns", "swings"],
    ["swing_faults", "swings"],
    ["swing_strengths", "swings"],
    ["user_drills", "drills"],
    ["automated_prescriptions", "drills"],
    ["automated_prescriptions", "launch_monitor_sessions"],
  ];

  it.each(FK_PAIRS)("both %s and referenced table %s exist as CREATE TABLE statements", (child, parent) => {
    expect(tableCreateOffset(child)).toBeGreaterThanOrEqual(0);
    expect(tableCreateOffset(parent)).toBeGreaterThanOrEqual(0);
  });

  it("adds foreign keys only after every CREATE TABLE statement has run", () => {
    const firstAlterFkOffset = codeLower.indexOf("add constraint");
    const lastCreateTableOffset = codeLower.lastIndexOf("create table public.");
    expect(firstAlterFkOffset).toBeGreaterThan(lastCreateTableOffset);
  });

  it("does not invent a foreign key on user_bags.user_id or swings.user_id (neither exists in production)", () => {
    expect(codeLower).not.toMatch(/add constraint user_bags_user_id_fkey/);
    expect(codeLower).not.toMatch(/add constraint swings_user_id_fkey/);
  });
});

// ============================================================================
// 7b. RR1 audit correction: exact, normalized, whitespace-tolerant
// foreign-key semantic contract. Table/parent presence (section 7 above) is
// necessary but not sufficient — this section validates the full tuple for
// every FK: source table/column, referenced table/column, ON DELETE, ON
// UPDATE, and deferrability, each captured per-tuple rather than asserted
// as a whole-file negative (a whole-file "no ON UPDATE/DEFERRABLE anywhere"
// regex would also — wrongly — reject those words appearing harmlessly
// inside an unrelated function body or comment).
//
// IMPORTANT — single-column-only contract: every one of this baseline's 42
// foreign keys constrains exactly one source column against exactly one
// referenced column (independently re-verified against source). The parser
// below deliberately does NOT support composite (multi-column) foreign
// keys — if one is ever introduced, `parseForeignKeys` reports it under
// `composite` rather than silently mis-parsing it, and the test below
// fails loudly until this contract and parser are extended together.
// ============================================================================
interface ForeignKeyTuple {
  constraintName: string;
  table: string; // "schema.name"
  column: string;
  refTable: string; // "schema.name"
  refColumn: string;
  onDelete: string;
  onUpdate: string;
  deferrable: boolean;
}

/** Tries to consume one referential action (`CASCADE`, `RESTRICT`,
 *  `NO ACTION`, `SET NULL`, `SET DEFAULT`) at the cursor. Returns the
 *  normalized action string, or null if none of these forms is present. */
function tryParseReferentialAction(c: SqlCursor): string | null {
  if (c.matchKeyword("cascade")) return "cascade";
  if (c.matchKeyword("restrict")) return "restrict";
  if (c.matchKeyword("no")) return c.matchKeyword("action") ? "no action" : null;
  if (c.matchKeyword("set")) {
    if (c.matchKeyword("null")) return "set null";
    if (c.matchKeyword("default")) return "set default";
    return null;
  }
  return null;
}

interface ParsedFkClause {
  constraintName: string;
  column: string;
  refSchema: string | null;
  refTable: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
  deferrable: boolean;
  compositeColumns: boolean;
}

/** Parses one `ADD CONSTRAINT <name> FOREIGN KEY (<col>) REFERENCES
 *  <table>(<col>) [ON DELETE ...] [ON UPDATE ...] [[NOT] DEFERRABLE
 *  [INITIALLY ...]]` clause. Tolerant of arbitrary whitespace/newlines/tabs
 *  between every token (`SqlCursor.matchKeyword` always skips leading
 *  whitespace first). Returns null for any clause that doesn't match this
 *  grammar at all — the caller reports those as malformed. */
function parseAddConstraintForeignKeyClause(clauseText: string): ParsedFkClause | null {
  const c = new SqlCursor(clauseText);
  if (!c.matchKeyword("add")) return null;
  if (!c.matchKeyword("constraint")) return null;
  const constraintName = c.parseIdentifier();
  if (constraintName === null) return null;
  if (!c.matchKeyword("foreign")) return null;
  if (!c.matchKeyword("key")) return null;
  if (!c.matchChar("(")) return null;
  const colsRaw = c.consumeBalancedUntil(")");
  if (colsRaw === null) return null;
  c.matchChar(")");
  const cols = splitTopLevelCommaList(colsRaw).map(normalizeIdentifierToken);
  const compositeColumns = cols.length !== 1;
  const column = cols[0] ?? "";

  if (!c.matchKeyword("references")) return null;
  const refQid = c.parseQualifiedIdentifier();
  if (refQid === null) return null;
  if (!c.matchChar("(")) return null;
  const refColsRaw = c.consumeBalancedUntil(")");
  if (refColsRaw === null) return null;
  c.matchChar(")");
  const refCols = splitTopLevelCommaList(refColsRaw).map(normalizeIdentifierToken);
  if (refCols.length !== 1) return null;
  const refColumn = refCols[0];

  let onDelete = "no action";
  let onUpdate = "no action";
  for (let guard = 0; guard < 2; guard++) {
    const save = c.pos;
    if (!c.matchKeyword("on")) break;
    if (c.matchKeyword("delete")) {
      const action = tryParseReferentialAction(c);
      if (action === null) return null;
      onDelete = action;
      continue;
    }
    if (c.matchKeyword("update")) {
      const action = tryParseReferentialAction(c);
      if (action === null) return null;
      onUpdate = action;
      continue;
    }
    c.pos = save;
    break;
  }

  let deferrable = false;
  if (c.matchKeyword("not")) {
    if (!c.matchKeyword("deferrable")) return null;
    deferrable = false;
  } else if (c.matchKeyword("deferrable")) {
    deferrable = true;
    if (c.matchKeyword("initially")) {
      if (!(c.matchKeyword("deferred") || c.matchKeyword("immediate"))) return null;
    }
  }

  if (!c.atEnd()) return null;

  return { constraintName, column, refSchema: refQid.schema, refTable: refQid.name, refColumn, onDelete, onUpdate, deferrable, compositeColumns };
}

/** Scans every top-level statement in `sql` for `ALTER TABLE <name> ADD
 *  CONSTRAINT ...` foreign-key clauses (one ALTER TABLE statement may carry
 *  several comma-separated ADD CONSTRAINT clauses). Other ALTER TABLE
 *  variants (e.g. `ENABLE ROW LEVEL SECURITY`) are recognized and skipped,
 *  not treated as malformed, since they are simply a different statement
 *  shape outside this parser's scope. */
function parseForeignKeys(sql: string): { tuples: ForeignKeyTuple[]; malformed: string[]; composite: string[] } {
  const tuples: ForeignKeyTuple[] = [];
  const malformed: string[] = [];
  const composite: string[] = [];
  for (const stmt of splitTopLevelStatements(sql)) {
    const c = new SqlCursor(stmt);
    if (!c.matchKeyword("alter")) continue;
    if (!c.matchKeyword("table")) continue;
    const tableQid = c.parseQualifiedIdentifier();
    if (tableQid === null) continue;
    const table = `${tableQid.schema ?? "public"}.${tableQid.name}`;
    const restText = stmt.slice(c.pos);
    if (!/\badd\s+constraint\b/i.test(restText)) continue; // not an FK-bearing ALTER TABLE
    for (const clause of splitTopLevelCommaList(restText)) {
      const parsed = parseAddConstraintForeignKeyClause(clause);
      if (parsed === null) { malformed.push(`${table}: ${clause}`); continue; }
      if (parsed.compositeColumns) { composite.push(`${table}.${parsed.constraintName}`); continue; }
      tuples.push({
        constraintName: parsed.constraintName,
        table,
        column: parsed.column,
        refTable: `${parsed.refSchema ?? "public"}.${parsed.refTable}`,
        refColumn: parsed.refColumn,
        onDelete: parsed.onDelete,
        onUpdate: parsed.onUpdate,
        deferrable: parsed.deferrable,
      });
    }
  }
  return { tuples, malformed, composite };
}

function fkKey(fk: ForeignKeyTuple): string {
  return [fk.constraintName, fk.table, fk.column, fk.refTable, fk.refColumn, fk.onDelete, fk.onUpdate, String(fk.deferrable)].join("|");
}

// Independently transcribed from the audited baseline's "C. Foreign keys"
// section, one entry per `add constraint ... foreign key` clause, in file
// order. Every FK in the file is covered — there is no subset sampling.
// All 42 omit ON UPDATE and DEFERRABLE in source, so both default to
// PostgreSQL's implicit values here (NO ACTION / not deferrable).
const EXPECTED_FOREIGN_KEYS: ForeignKeyTuple[] = [
  { constraintName: "users_id_fkey", table: "public.users", column: "id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_videos_user_id_fkey", table: "public.swing_videos", column: "user_id", refTable: "public.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "user_equipment_user_id_fkey", table: "public.user_equipment", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_telemetry_user_id_fkey", table: "public.swing_telemetry", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_telemetry_swing_video_id_fkey", table: "public.swing_telemetry", column: "swing_video_id", refTable: "public.swing_videos", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_telemetry_club_id_fkey", table: "public.swing_telemetry", column: "club_id", refTable: "public.user_equipment", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_analysis_swing_video_id_fkey", table: "public.swing_analysis", column: "swing_video_id", refTable: "public.swing_videos", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_analysis_user_id_fkey", table: "public.swing_analysis", column: "user_id", refTable: "public.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_analysis_club_id_fkey", table: "public.swing_analysis", column: "club_id", refTable: "public.user_equipment", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_analysis_telemetry_id_fkey", table: "public.swing_analysis", column: "telemetry_id", refTable: "public.swing_telemetry", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_analyses_user_id_fkey", table: "public.swing_analyses", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_breakdowns_swing_id_fkey", table: "public.swing_breakdowns", column: "swing_id", refTable: "public.swings", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_strengths_swing_id_fkey", table: "public.swing_strengths", column: "swing_id", refTable: "public.swings", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "swing_faults_swing_id_fkey", table: "public.swing_faults", column: "swing_id", refTable: "public.swings", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "cached_course_holes_course_provider_id_fkey", table: "public.cached_course_holes", column: "course_provider_id", refTable: "public.cached_golf_courses", refColumn: "provider_id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_profiles_user_id_fkey", table: "public.coach_profiles", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_golfer_relationships_coach_id_fkey", table: "public.coach_golfer_relationships", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_golfer_relationships_golfer_id_fkey", table: "public.coach_golfer_relationships", column: "golfer_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_golfer_relationships_invited_by_fkey", table: "public.coach_golfer_relationships", column: "invited_by", refTable: "auth.users", refColumn: "id", onDelete: "no action", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_student_relationships_coach_id_fkey", table: "public.coach_student_relationships", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_student_relationships_student_id_fkey", table: "public.coach_student_relationships", column: "student_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_feedback_swing_video_id_fkey", table: "public.coach_feedback", column: "swing_video_id", refTable: "public.swing_videos", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_feedback_swing_analysis_id_fkey", table: "public.coach_feedback", column: "swing_analysis_id", refTable: "public.swing_analysis", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_feedback_coach_id_fkey", table: "public.coach_feedback", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "coach_feedback_golfer_id_fkey", table: "public.coach_feedback", column: "golfer_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "lesson_plans_coach_id_fkey", table: "public.lesson_plans", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "lesson_plans_golfer_id_fkey", table: "public.lesson_plans", column: "golfer_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "launch_monitor_data_user_id_fkey", table: "public.launch_monitor_data", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "launch_monitor_data_swing_video_id_fkey", table: "public.launch_monitor_data", column: "swing_video_id", refTable: "public.swing_videos", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "launch_monitor_sessions_student_id_fkey", table: "public.launch_monitor_sessions", column: "student_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "launch_monitor_sessions_coach_id_fkey", table: "public.launch_monitor_sessions", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "automated_prescriptions_student_id_fkey", table: "public.automated_prescriptions", column: "student_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "automated_prescriptions_coach_id_fkey", table: "public.automated_prescriptions", column: "coach_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "automated_prescriptions_drill_id_fkey", table: "public.automated_prescriptions", column: "drill_id", refTable: "public.drills", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "automated_prescriptions_session_id_fkey", table: "public.automated_prescriptions", column: "session_id", refTable: "public.launch_monitor_sessions", refColumn: "id", onDelete: "set null", onUpdate: "no action", deferrable: false },
  { constraintName: "user_goals_user_id_fkey", table: "public.user_goals", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "drill_submissions_user_id_fkey", table: "public.drill_submissions", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "range_sessions_user_id_fkey", table: "public.range_sessions", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "user_drills_user_id_fkey", table: "public.user_drills", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "user_drills_drill_id_fkey", table: "public.user_drills", column: "drill_id", refTable: "public.drills", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "user_clubs_user_id_fkey", table: "public.user_clubs", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
  { constraintName: "rounds_user_id_fkey", table: "public.rounds", column: "user_id", refTable: "auth.users", refColumn: "id", onDelete: "cascade", onUpdate: "no action", deferrable: false },
];

describe("migration baseline — exact foreign-key semantic contract", () => {
  const { tuples: actualForeignKeys, malformed, composite } = parseForeignKeys(codeOutsideFunctions);

  it("every ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY clause parses successfully (none malformed/unparsed)", () => {
    expect(malformed, `malformed/unparsed FK clauses: ${JSON.stringify(malformed)}`).toEqual([]);
  });

  it("contains no composite (multi-column) foreign key (single-column-only contract)", () => {
    expect(composite, `composite FKs found — parser/contract must be extended: ${JSON.stringify(composite)}`).toEqual([]);
  });

  it("parses exactly 42 foreign keys from source, matching the expected tuple count", () => {
    expect(EXPECTED_FOREIGN_KEYS.length).toBe(42);
    expect(actualForeignKeys.length).toBe(42);
  });

  it("has no missing, extra, or duplicate foreign-key tuples versus the audited expected set", () => {
    const { missing, extra } = multisetDiff(EXPECTED_FOREIGN_KEYS.map(fkKey), actualForeignKeys.map(fkKey));
    expect(missing, `missing FK tuples: ${JSON.stringify(missing)}`).toEqual([]);
    expect(extra, `unauthorized/mismatched/duplicate FK tuples: ${JSON.stringify(extra)}`).toEqual([]);
  });

  it.each(EXPECTED_FOREIGN_KEYS)(
    "$constraintName: $table($column) -> $refTable($refColumn) ON DELETE $onDelete ON UPDATE $onUpdate DEFERRABLE=$deferrable",
    (expectation) => {
      const found = actualForeignKeys.find((fk) => fk.constraintName === expectation.constraintName);
      expect(found, `expected constraint ${expectation.constraintName} to exist`).toBeDefined();
      expect(found!.table).toBe(expectation.table);
      expect(found!.column).toBe(expectation.column);
      expect(found!.refTable).toBe(expectation.refTable);
      expect(found!.refColumn).toBe(expectation.refColumn);
      expect(found!.onDelete).toBe(expectation.onDelete);
      expect(found!.onUpdate).toBe(expectation.onUpdate);
      expect(found!.deferrable).toBe(expectation.deferrable);
    }
  );
});

// ============================================================================
// 8. RLS enabled for every required table
// ============================================================================
describe("migration baseline — RLS enablement", () => {
  it.each(REQUIRED_TABLES)("enables RLS on public.%s", (table) => {
    expect(codeLower).toContain(`alter table public.${table} enable row level security;`);
  });

  it("does not FORCE row level security anywhere (matches production)", () => {
    expect(codeLower).not.toMatch(/force row level security/);
  });
});

// ============================================================================
// 9 & 10. Exact SEC1A-relevant policy contracts
// ============================================================================

/** Bounds the CREATE POLICY statement for a specific named policy on a
 *  specific relation, ending at the terminating semicolon. */
function policyStatementSlice(relation: string, policyName: string): string {
  const needle = `create policy "${policyName.toLowerCase()}" on ${relation.toLowerCase()}`;
  const startIdx = codeLower.indexOf(needle);
  expect(startIdx, `expected to find CREATE POLICY "${policyName}" on ${relation}`).toBeGreaterThanOrEqual(0);
  const endIdx = codeLower.indexOf(";", startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return codeLower.slice(startIdx, endIdx + 1);
}

/** Sentinel for "no explicit TO clause" — Postgres applies such a policy to
 *  PUBLIC (every role) implicitly. Both strict `public.user_goals` policies
 *  are defined this way in production, so the exact-match contract must
 *  represent that state explicitly rather than skipping the role check. */
const NO_ROLE_CLAUSE = "(none — defaults to PUBLIC)";

/** Extracts and normalizes whatever role clause (if any) appears between a
 *  policy's `FOR <command>` keyword and its `USING`/`WITH CHECK`/terminating
 *  `;` — i.e. the exact text Postgres would parse as the policy's role list.
 *  Returns NO_ROLE_CLAUSE when no `TO ...` is present at all, so "no clause"
 *  and "an unexpected clause" are both distinguishable, exact-match states
 *  rather than a skipped assertion. */
function extractNormalizedRoleClause(stmt: string): string {
  const forMatch = stmt.match(/for\s+(?:select|insert|update|delete|all)\b/);
  expect(forMatch, `expected to find a FOR clause in: ${stmt}`).not.toBeNull();
  const afterFor = stmt.slice(forMatch!.index! + forMatch![0].length);
  const stopMatch = afterFor.match(/using\s*\(|with\s+check\s*\(|;/);
  const segment = stopMatch ? afterFor.slice(0, stopMatch.index) : afterFor;
  const trimmed = segment.replace(/\s+/g, " ").trim();
  if (trimmed === "") return NO_ROLE_CLAUSE;
  expect(trimmed.startsWith("to "), `expected a "to ..." role clause, got: "${trimmed}"`).toBe(true);
  return trimmed;
}

interface WeakPolicyExpectation {
  relation: string;
  name: string;
  forClause: string;
  /** Exact normalized role clause (e.g. "to anon", "to authenticated"), or
   *  NO_ROLE_CLAUSE when production defines the policy with no TO clause at
   *  all. Always checked — never optional — so a role broadened, narrowed,
   *  or newly added on any of these eight policies is caught. */
  normalizedRole: string;
  checkFragment?: string;
  usingFragment?: string;
}

const THREE_WEAK_SEC1A_POLICIES: WeakPolicyExpectation[] = [
  {
    relation: "storage.objects",
    name: "Allow Anonymous Uploads xuww7b_0",
    forClause: "for insert",
    normalizedRole: "to anon",
    checkFragment: "bucket_id = 'swing-videos'",
  },
  {
    relation: "public.user_goals",
    name: "Allow authenticated inserts",
    forClause: "for insert",
    normalizedRole: "to authenticated",
    checkFragment: "with check (true)",
  },
  {
    relation: "public.user_goals",
    name: "Allow users to view own goals",
    forClause: "for select",
    normalizedRole: "to authenticated",
    usingFragment: "auth.uid() = user_id or user_id is null",
  },
];

const FIVE_STRICT_SEC1A_POLICIES: WeakPolicyExpectation[] = [
  {
    relation: "storage.objects",
    name: "Users can upload their own swing videos",
    forClause: "for insert",
    normalizedRole: "to authenticated",
    checkFragment: "bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text",
  },
  {
    relation: "storage.objects",
    name: "Users can read their own swing videos",
    forClause: "for select",
    normalizedRole: "to authenticated",
    usingFragment: "bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text",
  },
  {
    relation: "storage.objects",
    name: "Users can delete their own swing videos",
    forClause: "for delete",
    normalizedRole: "to authenticated",
    usingFragment: "bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text",
  },
  {
    relation: "public.user_goals",
    name: "Users can insert own goals",
    forClause: "for insert",
    // Production defines this policy with no explicit TO clause (applies to
    // PUBLIC/all roles). Previously unchecked; see RR1 audit correction.
    normalizedRole: NO_ROLE_CLAUSE,
    checkFragment: "auth.uid() = user_id",
  },
  {
    relation: "public.user_goals",
    name: "Users can view own goals",
    forClause: "for select",
    // Production defines this policy with no explicit TO clause (applies to
    // PUBLIC/all roles). Previously unchecked; see RR1 audit correction.
    normalizedRole: NO_ROLE_CLAUSE,
    usingFragment: "auth.uid() = user_id",
  },
];

function assertWeakOrStrictPolicy(expectation: WeakPolicyExpectation) {
  const stmt = policyStatementSlice(expectation.relation, expectation.name);
  expect(stmt).toContain(expectation.forClause);
  expect(extractNormalizedRoleClause(stmt)).toBe(expectation.normalizedRole);
  if (expectation.checkFragment) {
    expect(stmt.replace(/\s+/g, " ")).toContain(expectation.checkFragment.replace(/\s+/g, " "));
  }
  if (expectation.usingFragment) {
    expect(stmt.replace(/\s+/g, " ")).toContain(expectation.usingFragment.replace(/\s+/g, " "));
  }
}

describe("migration baseline — the three exact weak SEC1A-target policies", () => {
  it.each(THREE_WEAK_SEC1A_POLICIES)("reproduces weak policy $name on $relation exactly", (expectation) => {
    assertWeakOrStrictPolicy(expectation);
  });

  it("contains exactly three policies matching the approved weak SEC1A names", () => {
    expect(THREE_WEAK_SEC1A_POLICIES.length).toBe(3);
    for (const p of THREE_WEAK_SEC1A_POLICIES) {
      const count = codeLower.split(`create policy "${p.name.toLowerCase()}"`).length - 1;
      expect(count, `expected exactly one "${p.name}" policy`).toBe(1);
    }
  });
});

describe("migration baseline — the five exact strict SEC1A-protected policies", () => {
  it.each(FIVE_STRICT_SEC1A_POLICIES)("reproduces strict policy $name on $relation exactly", (expectation) => {
    assertWeakOrStrictPolicy(expectation);
  });

  it("contains exactly five policies matching the approved strict SEC1A names", () => {
    expect(FIVE_STRICT_SEC1A_POLICIES.length).toBe(5);
    for (const p of FIVE_STRICT_SEC1A_POLICIES) {
      const count = codeLower.split(`create policy "${p.name.toLowerCase()}"`).length - 1;
      expect(count, `expected exactly one "${p.name}" policy`).toBe(1);
    }
  });
});

// ============================================================================
// 10b. RR1 audit correction: exact role contract for both strict
// public.user_goals policies. This is deliberately redundant with the
// generic strict-policy loop above — it exists as a standalone, unmissable
// guard specifically over the fixtures that were previously unchecked
// (roleClause was optional and both entries left it undefined).
// ============================================================================
describe("migration baseline — exact user_goals strict-policy role contract", () => {
  it('"Users can insert own goals" has no explicit role clause (defaults to PUBLIC)', () => {
    const stmt = policyStatementSlice("public.user_goals", "Users can insert own goals");
    expect(extractNormalizedRoleClause(stmt)).toBe(NO_ROLE_CLAUSE);
  });

  it('"Users can view own goals" has no explicit role clause (defaults to PUBLIC)', () => {
    const stmt = policyStatementSlice("public.user_goals", "Users can view own goals");
    expect(extractNormalizedRoleClause(stmt)).toBe(NO_ROLE_CLAUSE);
  });

  it("would reject an added TO anon on either policy", () => {
    for (const name of ["Users can insert own goals", "Users can view own goals"]) {
      const stmt = policyStatementSlice("public.user_goals", name);
      expect(extractNormalizedRoleClause(stmt)).not.toBe("to anon");
    }
  });

  it("would reject an added TO public on either policy (textually distinct from the implicit-PUBLIC baseline)", () => {
    for (const name of ["Users can insert own goals", "Users can view own goals"]) {
      const stmt = policyStatementSlice("public.user_goals", name);
      expect(extractNormalizedRoleClause(stmt)).not.toBe("to public");
    }
  });
});

// ============================================================================
// 11. This baseline never runs SEC1A itself
// ============================================================================
describe("migration baseline — SEC1A is not applied here", () => {
  it("contains no DROP POLICY of any kind, including the three SEC1A removal targets", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+policy\b/);
  });

  it("does not remove the three weak SEC1A-target policies", () => {
    for (const p of THREE_WEAK_SEC1A_POLICIES) {
      expect(codeLower).not.toMatch(new RegExp(`drop policy "${p.name.toLowerCase()}"`));
    }
  });
});

// ============================================================================
// 12. Required functions and triggers are represented
// ============================================================================
const REQUIRED_FUNCTIONS = [
  "auto_assign_coach_invite_code",
  "generate_coach_invite_code",
  "handle_new_user",
  "handle_updated_at",
  "link_student_to_coach",
];

describe("migration baseline — required functions and triggers", () => {
  it.each(REQUIRED_FUNCTIONS)("creates function public.%s", (fn) => {
    expect(codeLower).toMatch(new RegExp(`create function public\\.${fn}\\(`));
  });

  it("creates the auth.users signup trigger calling handle_new_user", () => {
    expect(codeLower).toMatch(/create trigger on_auth_user_created\s+after insert on auth\.users/);
    expect(codeLower).toContain("execute function public.handle_new_user()");
  });

  it("creates the coach invite code trigger calling auto_assign_coach_invite_code", () => {
    expect(codeLower).toMatch(/create trigger trg_auto_assign_coach_invite_code/);
    expect(codeLower).toContain("execute function public.auto_assign_coach_invite_code()");
  });

  it("restricts handle_new_user execution to match production (not callable by anon/authenticated)", () => {
    expect(codeLower).toContain("revoke execute on function public.handle_new_user() from public");
  });

  it("handle_new_user is SECURITY DEFINER with an empty search_path, matching production", () => {
    const fnIdx = codeLower.indexOf("create function public.handle_new_user()");
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const fnBody = codeLower.slice(fnIdx, codeLower.indexOf("$function$;", codeLower.indexOf("$function$", fnIdx) + 10) + 11);
    expect(fnBody).toContain("security definer");
    expect(fnBody).toMatch(/set search_path to ''/);
  });

  it("link_student_to_coach is SECURITY DEFINER with search_path pinned to public", () => {
    const fnIdx = codeLower.indexOf("create function public.link_student_to_coach(");
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const fnBody = codeLower.slice(fnIdx, codeLower.indexOf("$function$;", codeLower.indexOf("$function$", fnIdx) + 10) + 11);
    expect(fnBody).toContain("security definer");
    expect(fnBody).toMatch(/set search_path to 'public'/);
  });
});

// ============================================================================
// 12b. RR1 final parser correction: a real statement parser for every
// top-level GRANT/REVOKE statement (table AND function), rather than a
// narrow regex that only recognizes one specific spelling. Every statement
// that starts with GRANT or REVOKE is parsed into a normalized tuple or
// explicitly reported as malformed/unparsed — none can silently vanish by
// using REVOKE, TABLE, ALL PRIVILEGES, quoted identifiers, or unusual
// whitespace.
// ============================================================================
interface ParsedPrivilegeStatement {
  raw: string;
  action: "grant" | "revoke";
  objectType: "table" | "function";
  isAll: boolean;
  privileges: string[]; // lowercase; ["all"] when isAll
  objects: Array<{ schema: string | null; name: string; args: string | null }>; // args set only for functions
  roles: string[];
  withGrantOption: boolean;
}

/** Normalizes a function argument-type list to a single comparable string:
 *  collapses whitespace, lowercases (PostgreSQL folds unquoted type names).
 *  Deliberately does not resolve type aliases — it only needs to tell
 *  different signatures apart, e.g. `handle_new_user()` from
 *  `link_student_to_coach(text)`, not to know what "text" *means*. */
function normalizeArgList(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parses one GRANT or REVOKE statement (table or function privileges)
 *  into a normalized structure, or returns null if the statement doesn't
 *  match this grammar at all — the caller reports those as malformed.
 *  Grammar covered (both GRANT and REVOKE, both TABLE and FUNCTION):
 *    {GRANT|REVOKE} {ALL [PRIVILEGES] | priv [, priv ...]}
 *      ON [TABLE|FUNCTION] object [(args)] [, object [(args)] ...]
 *      {TO|FROM} role [, role ...]
 *      [WITH GRANT OPTION]
 *  Every keyword is matched case-insensitively via SqlCursor, which always
 *  skips leading whitespace first — so multiline statements, tabs, and
 *  repeated spaces are all tolerated identically to single-space text. */
function parsePrivilegeStatement(raw: string): ParsedPrivilegeStatement | null {
  const c = new SqlCursor(raw);

  let action: "grant" | "revoke";
  if (c.matchKeyword("grant")) action = "grant";
  else if (c.matchKeyword("revoke")) action = "revoke";
  else return null;

  let isAll = false;
  const privileges: string[] = [];
  if (c.matchKeyword("all")) {
    isAll = true;
    c.matchKeyword("privileges"); // optional
    privileges.push("all");
  } else {
    while (true) {
      const word = c.parseIdentifier();
      if (word === null) return null;
      privileges.push(word);
      if (c.matchChar(",")) continue;
      break;
    }
  }

  if (!c.matchKeyword("on")) return null;

  let objectType: "table" | "function" = "table";
  if (c.matchKeyword("function")) objectType = "function";
  else c.matchKeyword("table"); // optional for tables; consume if present

  const objects: Array<{ schema: string | null; name: string; args: string | null }> = [];
  while (true) {
    const qid = c.parseQualifiedIdentifier();
    if (qid === null) return null;
    let args: string | null = null;
    if (objectType === "function") {
      if (!c.matchChar("(")) return null; // this contract always sees an explicit signature
      const inner = c.consumeBalancedUntil(")");
      if (inner === null) return null;
      c.matchChar(")");
      args = normalizeArgList(inner);
    }
    objects.push({ schema: qid.schema, name: qid.name, args });
    if (c.matchChar(",")) continue;
    break;
  }

  if (action === "grant") {
    if (!c.matchKeyword("to")) return null;
  } else {
    if (!c.matchKeyword("from")) return null;
  }
  const roles: string[] = [];
  while (true) {
    const role = c.parseIdentifier(); // PUBLIC/public/"public" all fold or preserve via parseIdentifier itself
    if (role === null) return null;
    roles.push(role);
    if (c.matchChar(",")) continue;
    break;
  }

  let withGrantOption = false;
  if (c.matchKeyword("with")) {
    if (!c.matchKeyword("grant")) return null;
    if (!c.matchKeyword("option")) return null;
    withGrantOption = true;
  }

  if (!c.atEnd()) return null; // unexpected trailing tokens

  return { raw, action, objectType, isAll, privileges, objects, roles, withGrantOption };
}

/** Scans every top-level statement in `sql` for ones that begin with GRANT
 *  or REVOKE (case-insensitive), parses each, and separates the results
 *  into successfully-parsed statements versus malformed/unparsed ones. A
 *  statement that starts with GRANT/REVOKE can never simply disappear —
 *  it either parses into the structure above or lands in `malformed`. */
function parseAllPrivilegeStatements(sql: string): { statements: ParsedPrivilegeStatement[]; malformed: string[] } {
  const statements: ParsedPrivilegeStatement[] = [];
  const malformed: string[] = [];
  for (const stmt of splitTopLevelStatements(sql)) {
    const looksLikeGrantOrRevoke = new SqlCursor(stmt).matchKeyword("grant") || new SqlCursor(stmt).matchKeyword("revoke");
    if (!looksLikeGrantOrRevoke) continue;
    const parsed = parsePrivilegeStatement(stmt);
    if (parsed === null) malformed.push(stmt);
    else statements.push(parsed);
  }
  return { statements, malformed };
}

interface TableTuple {
  action: "grant" | "revoke";
  schema: string;
  name: string;
  grantee: string;
  privilege: string;
  grantOption: boolean;
}

interface FunctionTuple {
  action: "grant" | "revoke";
  schema: string;
  fn: string;
  args: string;
  role: string;
  privilege: string;
  grantOption: boolean;
}

function expandTableTuples(statements: ParsedPrivilegeStatement[]): TableTuple[] {
  const tuples: TableTuple[] = [];
  for (const s of statements.filter((s) => s.objectType === "table")) {
    for (const obj of s.objects) {
      for (const role of s.roles) {
        for (const privilege of s.privileges) {
          tuples.push({ action: s.action, schema: obj.schema ?? "(unqualified)", name: obj.name, grantee: role, privilege, grantOption: s.withGrantOption });
        }
      }
    }
  }
  return tuples;
}

function expandFunctionTuples(statements: ParsedPrivilegeStatement[]): FunctionTuple[] {
  const tuples: FunctionTuple[] = [];
  for (const s of statements.filter((s) => s.objectType === "function")) {
    for (const obj of s.objects) {
      for (const role of s.roles) {
        for (const privilege of s.privileges) {
          tuples.push({ action: s.action, schema: obj.schema ?? "(unqualified)", fn: obj.name, args: obj.args ?? "", role, privilege, grantOption: s.withGrantOption });
        }
      }
    }
  }
  return tuples;
}

function tableTupleKey(t: TableTuple): string {
  return [t.action, t.schema, t.name, t.grantee, t.privilege, String(t.grantOption)].join("|");
}

function functionTupleKey(t: FunctionTuple): string {
  return [t.action, t.schema, t.fn, t.args, t.role, t.privilege, String(t.grantOption)].join("|");
}

const GRANTEES = ["anon", "authenticated", "service_role"];
const TABLE_PRIVILEGES = ["delete", "insert", "references", "select", "trigger", "truncate", "update"];

// 28 approved tables x 3 grantees x 7 privileges = 588 individual tuples.
const EXPECTED_TABLE_PRIVILEGE_TUPLES: TableTuple[] = REQUIRED_TABLES.flatMap((table) =>
  GRANTEES.flatMap((grantee) =>
    TABLE_PRIVILEGES.map((privilege) => ({ action: "grant" as const, schema: "public", name: table, grantee, privilege, grantOption: false }))
  )
);

// Matches production's restricted EXECUTE grant on handle_new_user: not
// callable by anon/authenticated, only by service_role (and, via Postgres's
// automatic owner-privilege materialization once PUBLIC is revoked, by the
// owning role itself — which never appears as an explicit statement, and
// is deliberately not modeled here as one).
const EXPECTED_FUNCTION_PRIVILEGE_TUPLES: FunctionTuple[] = [
  { action: "revoke", schema: "public", fn: "handle_new_user", args: "", role: "public", privilege: "execute", grantOption: false },
  { action: "grant", schema: "public", fn: "handle_new_user", args: "", role: "service_role", privilege: "execute", grantOption: false },
];

const { statements: allPrivilegeStatements, malformed: malformedPrivilegeStatements } = parseAllPrivilegeStatements(codeOutsideFunctions);
const actualTableTuples = expandTableTuples(allPrivilegeStatements);
const actualFunctionTuples = expandFunctionTuples(allPrivilegeStatements);

describe("migration baseline — every GRANT/REVOKE statement is well-formed", () => {
  it("every top-level statement beginning GRANT or REVOKE parses successfully (none malformed/unparsed)", () => {
    expect(malformedPrivilegeStatements, `malformed/unparsed privilege statements: ${JSON.stringify(malformedPrivilegeStatements)}`).toEqual([]);
  });
});

describe("migration baseline — exact table privilege contract", () => {
  it("parses exactly 588 normalized table-privilege tuples (28 tables x 3 grantees x 7 privileges)", () => {
    expect(EXPECTED_TABLE_PRIVILEGE_TUPLES.length).toBe(588);
    expect(actualTableTuples.length).toBe(588);
  });

  it("has no missing, extra, or duplicate table-privilege tuples versus the audited expected set", () => {
    const { missing, extra } = multisetDiff(EXPECTED_TABLE_PRIVILEGE_TUPLES.map(tableTupleKey), actualTableTuples.map(tableTupleKey));
    expect(missing, `missing table-privilege tuples: ${JSON.stringify(missing)}`).toEqual([]);
    expect(extra, `unauthorized/mismatched/duplicate table-privilege tuples: ${JSON.stringify(extra)}`).toEqual([]);
  });

  it.each(REQUIRED_TABLES)("public.%s grants exactly delete,insert,references,select,trigger,truncate,update to anon, authenticated, and service_role — nothing else", (table) => {
    for (const grantee of GRANTEES) {
      for (const privilege of TABLE_PRIVILEGES) {
        const found = actualTableTuples.find((t) => t.action === "grant" && t.schema === "public" && t.name === table && t.grantee === grantee && t.privilege === privilege);
        expect(found, `expected a grant of ${privilege} on public.${table} to ${grantee}`).toBeDefined();
        expect(found!.grantOption).toBe(false);
      }
    }
  });

  it("contains no table-level REVOKE tuple anywhere (nothing claws back an expected grant)", () => {
    const revokes = actualTableTuples.filter((t) => t.action === "revoke");
    expect(revokes, `unexpected table-level REVOKE tuples: ${JSON.stringify(revokes)}`).toEqual([]);
  });

  it("grants no privilege to PUBLIC on any application table, quoted or unquoted (no unauthorized broad grant)", () => {
    const toPublic = actualTableTuples.filter((t) => t.grantee === "public");
    expect(toPublic, `unauthorized grants to PUBLIC: ${JSON.stringify(toPublic)}`).toEqual([]);
  });

  it("declares no WITH GRANT OPTION on any table-privilege tuple (matches production's non-grantable privileges)", () => {
    const grantable = actualTableTuples.filter((t) => t.grantOption);
    expect(grantable, `unexpected WITH GRANT OPTION tuples: ${JSON.stringify(grantable)}`).toEqual([]);
  });

  it("declares no sequence grants (none are required — all primary keys use gen_random_uuid(), not serial sequences)", () => {
    expect(codeLower).not.toMatch(/grant\s+[a-z,\s]+\son\s+sequence/);
  });
});

describe("migration baseline — exact function privilege contract", () => {
  it("parses exactly the two expected function privilege tuples", () => {
    expect(EXPECTED_FUNCTION_PRIVILEGE_TUPLES.length).toBe(2);
    expect(actualFunctionTuples.length).toBe(2);
  });

  it("has no missing, extra, or duplicate function GRANT/REVOKE tuples versus the audited expected set", () => {
    const { missing, extra } = multisetDiff(EXPECTED_FUNCTION_PRIVILEGE_TUPLES.map(functionTupleKey), actualFunctionTuples.map(functionTupleKey));
    expect(missing, `missing function privilege tuples: ${JSON.stringify(missing)}`).toEqual([]);
    expect(extra, `unauthorized/mismatched/duplicate function privilege tuples: ${JSON.stringify(extra)}`).toEqual([]);
  });

  it("contains no ALL/ALL PRIVILEGES or WITH GRANT OPTION function-privilege statement", () => {
    const broad = actualFunctionTuples.filter((t) => t.privilege === "all" || t.grantOption);
    expect(broad, `unauthorized broad/grantable function-privilege tuples: ${JSON.stringify(broad)}`).toEqual([]);
  });
});

// ============================================================================
// 13. Bucket configuration is deterministic and data-free
// ============================================================================
describe("migration baseline — bucket configuration", () => {
  it("declares exactly the two required buckets", () => {
    const bucketBlockIdx = codeLower.indexOf("insert into storage.buckets");
    const bucketBlockEnd = codeLower.indexOf(";", bucketBlockIdx);
    const block = codeLower.slice(bucketBlockIdx, bucketBlockEnd);
    expect(block).toContain("'swing-videos'");
    expect(block).toContain("'drill_videos'");
  });

  it("both buckets are private (public = false)", () => {
    const bucketBlockIdx = codeLower.indexOf("insert into storage.buckets");
    const bucketBlockEnd = codeLower.indexOf(";", bucketBlockIdx);
    const block = codeLower.slice(bucketBlockIdx, bucketBlockEnd);
    const falseCount = (block.match(/false/g) ?? []).length;
    expect(falseCount).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// 14. No obvious secret patterns or production data literals
// ============================================================================
describe("migration baseline — no secrets or production data literals", () => {
  it("contains no email-shaped literals", () => {
    expect(codeLower).not.toMatch(/'[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'/);
  });

  it("contains no Stripe-shaped identifiers", () => {
    expect(codeLower).not.toMatch(/\b(cus|sub|price|prod)_[a-z0-9]{10,}/);
  });

  it("contains no bearer/API-key/JWT-shaped literals", () => {
    expect(codeLower).not.toMatch(/bearer\s+[a-z0-9._-]{10,}/);
    expect(codeLower).not.toMatch(/eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/);
  });

  it("contains no hardcoded UUID-shaped application row identifiers outside catalog-name context", () => {
    // Table/column/policy names in this file are plain identifiers, not
    // UUIDs, so any UUID-shaped literal appearing in single quotes would be
    // suspicious application-row data.
    expect(codeLower).not.toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/);
  });
});

// ============================================================================
// 14b. RR1 audit correction: raw-text secret scan, including comments.
// The checks above (section 14) run against `codeLower`, which has `--`
// comments stripped before evaluation — a secret-shaped literal hidden only
// in a comment is invisible to them (confirmed as a real gap during the
// RR1 independent audit). These checks instead scan `migration` itself:
// the raw, unstripped file text, so a secret is caught regardless of
// whether it sits in executable SQL, a `--` line comment, or a `/* ... */`
// block comment. Patterns are shape-based (not bare keywords like "secret"
// or "password" alone) specifically so harmless prose using those words
// elsewhere in this file's own header/comments cannot false-positive.
// ============================================================================
const migrationLower = migration.toLowerCase();

/** High-confidence secret-shaped patterns. Each targets a specific known
 *  credential format rather than a bare English word, so documentation
 *  prose that merely discusses "secrets" or "passwords" never matches. */
const RAW_SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "JWT-like three-segment token", pattern: /\bey[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/ },
  { label: "PEM private key block", pattern: /-----begin[a-z0-9 ]*private key-----/ },
  { label: "Supabase secret/publishable key prefix", pattern: /\bsb_(secret|publishable)_[a-z0-9]{10,}\b/ },
  { label: "Stripe live/test secret or restricted key", pattern: /\b(sk|rk)_(live|test)_[a-z0-9]{10,}\b/ },
  { label: "Stripe webhook secret", pattern: /\bwhsec_[a-z0-9]{10,}\b/ },
  { label: "database URL with embedded credentials", pattern: /\bpostgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@/ },
  { label: "password assignment with a quoted value", pattern: /\bpassword\s*[:=]\s*['"][^'"]{4,}['"]/ },
  { label: "bearer token", pattern: /\bbearer\s+[a-z0-9._-]{10,}\b/ },
  { label: "API key assignment with a quoted value", pattern: /\bapi[_-]?key\s*[:=]\s*['"][a-z0-9_-]{10,}['"]/ },
];

describe("migration baseline — raw-text secret scan (includes comments)", () => {
  it.each(RAW_SECRET_PATTERNS)("the raw file text contains no $label, in code or comments", ({ pattern }) => {
    expect(migrationLower).not.toMatch(pattern);
  });

  it("does not false-positive on this file's own harmless prose using the words secret/token/password/api key", () => {
    // Sanity-check: the file's header/section comments legitimately discuss
    // "SECURITY DEFINER", "no ... credential-shaped text", etc. None of
    // that prose should itself satisfy any shape-based pattern above.
    expect(migrationLower).toMatch(/security definer/);
    for (const { pattern } of RAW_SECRET_PATTERNS) {
      expect(migrationLower).not.toMatch(pattern);
    }
  });
});

describe("migration baseline — raw-text secret scan mechanics (proves comment context does not evade detection)", () => {
  // Clearly synthetic, nonfunctional fixture — not a real credential.
  const SYNTHETIC_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SYNTHETIC_NOT_A_REAL_SIGNATURE";
  const jwtPattern = RAW_SECRET_PATTERNS.find((p) => p.label === "JWT-like three-segment token")!.pattern;

  it("the synthetic fixture itself matches the JWT-like pattern", () => {
    expect(SYNTHETIC_JWT.toLowerCase()).toMatch(jwtPattern);
  });

  it("detects the fixture when placed in executable SQL", () => {
    const sample = `select '${SYNTHETIC_JWT}';`.toLowerCase();
    expect(sample).toMatch(jwtPattern);
  });

  it("detects the fixture when placed inside a -- line comment", () => {
    const sample = `-- leftover debug value: ${SYNTHETIC_JWT}`.toLowerCase();
    expect(sample).toMatch(jwtPattern);
  });

  it("detects the fixture when placed inside a /* ... */ block comment", () => {
    const sample = `/* leftover debug value: ${SYNTHETIC_JWT} */`.toLowerCase();
    expect(sample).toMatch(jwtPattern);
  });

  it("the actual raw migration text (comments included) contains no such literal right now", () => {
    expect(migrationLower).not.toMatch(jwtPattern);
  });
});

// ============================================================================
// 15. Comment-stripped executable SQL is what forbidden-token checks use
// ============================================================================
describe("migration baseline — forbidden-token checks use comment-stripped SQL", () => {
  it("the migration's own header prose about forbidden actions does not create false positives", () => {
    // The header comments legitimately describe (in prose) that this file
    // must never DROP, execute migration repair, etc. Confirm those words
    // appear in the raw file (as comments) but not in the comment-stripped
    // executable text used by the forbidden-statement checks above.
    expect(migration.toLowerCase()).toContain("must never execute this file's ddl");
    expect(codeLower).not.toContain("must never execute this file's ddl");
  });
});

// ============================================================================
// 16. Mutation resistance (documented expectations; the helpers above are
// exercised directly to prove each mutation class would be caught)
// ============================================================================
describe("migration baseline — mutation resistance of the helpers themselves", () => {
  it("policyStatementSlice fails on a missing policy (proves removal is detectable)", () => {
    expect(() => policyStatementSlice("public.user_goals", "This Policy Does Not Exist")).toThrow();
  });

  it("a broadened strict policy role would no longer match the exact expected role clause", () => {
    // Sanity-check the assertion mechanics: the strict policy's own
    // statement text must not accidentally satisfy an anon-role check.
    const stmt = policyStatementSlice("public.user_goals", "Users can insert own goals");
    expect(stmt).not.toContain("to anon");
  });

  it("the required-table list count matches the actual number of CREATE TABLE statements", () => {
    const createTableCount = (codeLower.match(/create table public\./g) ?? []).length;
    expect(createTableCount).toBe(REQUIRED_TABLES.length);
  });
});
