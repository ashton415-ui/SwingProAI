import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  PRICING1_BILLING_CHECKOUT_GUARD_FILENAME,
  PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

/**
 * PRICING-1 — public.users browser-role privilege hardening: source contract.
 *
 * Proves what the checked-in migration SAYS. It cannot prove the migration has
 * been applied anywhere; live acceptance belongs to the Staging and Production
 * gates.
 *
 * Every safety decision runs over ONE executable representation produced by a
 * small stateful lexer, not by regex stripping. The lexer decides lexical
 * context character by character before treating `--` as a comment or `'` as a
 * string boundary, so literal or comment content can never hide an executable
 * statement. Syntax this migration does not need (carriage returns, escape and
 * Unicode strings, double-quoted identifiers, block comments, backslashes, any
 * dollar tag other than $preflight$ and $postflight$) fails closed instead of
 * being half-parsed.
 *
 * DO bodies follow PostgreSQL's own rule: a dollar-quoted body ends at the
 * first matching tag, whatever comment or string it appears to sit in. The
 * body is cut there first and only then lexed and scanned like top-level SQL.
 * Any other approved tag text inside a body, or a body that ends inside a
 * comment or string, fails closed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const inventorySource = readFileSync(path.join(__dirname, "migration-inventory.ts"), "utf8").replace(/\r\n/g, "\n");

// Read verbatim: line endings are evidence and are checked by the lexer, never normalized.
const raw = readFileSync(path.join(migrationsDir, PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME), "utf8");

const FROZEN_REVOKE = "revoke delete, truncate, references, trigger, maintain on table public.users from anon, authenticated;";
const BROWSER_BEFORE = "delete:false,maintain:false,references:false,select:false,trigger:false,truncate:false";
const SERVICE_ROLE = "delete:false,insert:false,maintain:false,references:false,select:false,trigger:false,truncate:false,update:false";
const BROWSER_AFTER = "select:false";
const GRANTABLE_ENTRY =
  "string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end)";
const APPROVED_TAGS = ["preflight", "postflight"];
const APPROVED_BLOCKS = ["preflight", "postflight"];
/** The only top-level statements allowed, with each DO body reduced to a placeholder. */
const TOP_LEVEL_STATEMENTS = ["do <block:preflight>", FROZEN_REVOKE.slice(0, -1), "do <block:postflight>", ""];

// ─── Independent allow-lists ──────────────────────────────────────────────────
// Written by hand from the reviewed migration. They are NOT derived from the
// source under test, so a changed migration cannot widen them. Every template
// is matched against lexed body code: lower-cased, whitespace collapsed, every
// string literal reduced to ''.

/** Every function call allowed anywhere in executable code. All take inert, non-SQL arguments. */
const ALLOWED_FUNCTIONS = ["coalesce", "string_agg", "count", "pg_catalog.aclexplode", "pg_catalog.has_table_privilege"];
/** Every `::type` cast allowed. Both resolve a name through the catalog and execute nothing. */
const ALLOWED_CASTS = ["regclass", "regrole"];
/** Every operator allowed. A custom operator could run an arbitrary function. */
const ALLOWED_OPERATORS = ["||", "<>", "=", ">", "*"];

/** Regex-escape a fixed template fragment (this escapes a pattern; it never normalizes SQL). */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ACL_EXPR =
  "select coalesce(string_agg(distinct x.privilege_type || '' || case when x.is_grantable then '' else '' end, '' order by x.privilege_type || '' || case when x.is_grantable then '' else '' end), '')";
const ACL_FROM = "from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = ''::regclass and x.grantee = ''::regrole";

/** The only simple statements allowed inside a DO body. */
const SIMPLE_STATEMENTS: [string, RegExp][] = [
  [
    "relation lookup",
    new RegExp(
      "^" +
        esc(
          "select c.relrowsecurity into v_rls from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = '' and c.relname = '' and c.relkind = ''",
        ) +
        "$",
    ),
  ],
  ["RLS re-read", new RegExp("^" + esc("select c.relrowsecurity into v_rls from pg_catalog.pg_class c where c.oid = ''::regclass") + "$")],
  ["ACL exact set", new RegExp("^" + esc(ACL_EXPR) + " into v_(anon|authenticated|service) " + esc(ACL_FROM) + "$")],
  [
    "PUBLIC count",
    new RegExp(
      "^" +
        esc(
          "select count(*) into v_public from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = ''::regclass and x.grantee = 0",
        ) +
        "$",
    ),
  ],
  [
    "column ACL count",
    new RegExp(
      "^" +
        esc(
          "select count(*) into v_columns from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x where a.attrelid = ''::regclass and a.attnum > 0 and not a.attisdropped",
        ) +
        "$",
    ),
  ],
  ["raise exception", /^raise exception ''(, v_[a-z]+)*$/],
];

/** One IF condition atom: a NOT-able flag, a comparison with a literal or 0, or a privilege probe. */
const COND_ATOM =
  "(?:not )?(?:found|v_[a-z]+(?: <> (?:''|0))?|pg_catalog\\.has_table_privilege\\((?:''|v_[a-z]+), (?:''|v_[a-z]+), (?:''|v_[a-z]+)\\))";
const IF_OPENER = new RegExp(`^if ${COND_ATOM}(?: or ${COND_ATOM})* then (.*)$`);
const FOREACH_OPENER = /^foreach v_[a-z]+ in array array\[''(?:, '')*\] loop (.*)$/;
const DECLARATION = /^v_[a-z]+ (?:boolean|text|integer)$/;

// ─── Independent ordered DO-body contracts ────────────────────────────────────
// Every executable statement of each body, in order, written by hand from the
// reviewed migration with every literal exactly as it must appear (case
// included). Statements are split at the lexer's own `;`, so `declare` opens
// the first declaration and `begin` opens the first statement. The only
// flexibility: a literal written 'PRICING1-HARDEN-…:*' must be ONE literal
// that starts with exactly that code and colon; the message text after it is
// free. Nothing else is wildcarded.

const PRIVILEGE_SET_AGG =
  "string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end)";
const aclReadStatement = (role: string, into: string) =>
  `select coalesce(${PRIVILEGE_SET_AGG}, '') into ${into} from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = '${role}'::regrole`;
const PUBLIC_COUNT_STATEMENT =
  "select count(*) into v_public from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = 0";
const COLUMN_COUNT_STATEMENT =
  "select count(*) into v_columns from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x where a.attrelid = 'public.users'::regclass and a.attnum > 0 and not a.attisdropped";
const BROWSER_SET_BEFORE = "DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false";
const SERVICE_ROLE_SET = "DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false";
const BROWSER_SET_AFTER = "SELECT:false";

const PREFLIGHT_EXPECTED_STATEMENTS: string[] = [
  "declare v_rls boolean",
  "v_anon text",
  "v_authenticated text",
  "v_service text",
  "v_public integer",
  "v_columns integer",
  "begin select c.relrowsecurity into v_rls from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'users' and c.relkind = 'r'",
  "if not found then raise exception 'PRICING1-HARDEN-PRE-1:*'",
  "end if",
  "if not v_rls then raise exception 'PRICING1-HARDEN-PRE-2:*'",
  "end if",
  aclReadStatement("anon", "v_anon"),
  aclReadStatement("authenticated", "v_authenticated"),
  aclReadStatement("service_role", "v_service"),
  PUBLIC_COUNT_STATEMENT,
  COLUMN_COUNT_STATEMENT,
  `if v_anon <> '${BROWSER_SET_BEFORE}' then raise exception 'PRICING1-HARDEN-PRE-3:*', v_anon`,
  "end if",
  `if v_authenticated <> '${BROWSER_SET_BEFORE}' then raise exception 'PRICING1-HARDEN-PRE-4:*', v_authenticated`,
  "end if",
  `if v_service <> '${SERVICE_ROLE_SET}' then raise exception 'PRICING1-HARDEN-PRE-5:*', v_service`,
  "end if",
  "if v_public <> 0 then raise exception 'PRICING1-HARDEN-PRE-6:*'",
  "end if",
  "if v_columns <> 0 then raise exception 'PRICING1-HARDEN-PRE-7:*'",
  "end if",
  "if pg_catalog.has_table_privilege('anon', 'public.users', 'INSERT') or pg_catalog.has_table_privilege('anon', 'public.users', 'UPDATE') or pg_catalog.has_table_privilege('authenticated', 'public.users', 'INSERT') or pg_catalog.has_table_privilege('authenticated', 'public.users', 'UPDATE') then raise exception 'PRICING1-HARDEN-PRE-8:*'",
  "end if",
  "end",
];

const POSTFLIGHT_EXPECTED_STATEMENTS: string[] = [
  "declare v_rls boolean",
  "v_anon text",
  "v_authenticated text",
  "v_service text",
  "v_public integer",
  "v_columns integer",
  "v_role text",
  "v_priv text",
  "begin select c.relrowsecurity into v_rls from pg_catalog.pg_class c where c.oid = 'public.users'::regclass",
  "if not v_rls then raise exception 'PRICING1-HARDEN-POST-1:*'",
  "end if",
  aclReadStatement("anon", "v_anon"),
  aclReadStatement("authenticated", "v_authenticated"),
  aclReadStatement("service_role", "v_service"),
  PUBLIC_COUNT_STATEMENT,
  COLUMN_COUNT_STATEMENT,
  `if v_anon <> '${BROWSER_SET_AFTER}' then raise exception 'PRICING1-HARDEN-POST-2:*', v_anon`,
  "end if",
  `if v_authenticated <> '${BROWSER_SET_AFTER}' then raise exception 'PRICING1-HARDEN-POST-3:*', v_authenticated`,
  "end if",
  `if v_service <> '${SERVICE_ROLE_SET}' then raise exception 'PRICING1-HARDEN-POST-4:*', v_service`,
  "end if",
  "if v_public <> 0 then raise exception 'PRICING1-HARDEN-POST-5:*'",
  "end if",
  "if v_columns <> 0 then raise exception 'PRICING1-HARDEN-POST-6:*'",
  "end if",
  "foreach v_role in array array['anon', 'authenticated'] loop foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop if pg_catalog.has_table_privilege(v_role, 'public.users', v_priv) then raise exception 'PRICING1-HARDEN-POST-7:*', v_role, v_priv",
  "end if",
  "end loop",
  "if not pg_catalog.has_table_privilege(v_role, 'public.users', 'SELECT') then raise exception 'PRICING1-HARDEN-POST-8:*', v_role",
  "end if",
  "end loop",
  "end",
];

const EXPECTED_STATEMENT_COUNTS: Record<string, number> = { preflight: 29, postflight: 33 };
const MESSAGE_CODE = /^(PRICING1-HARDEN-(?:PRE|POST)-[1-8]:)\*$/;

// ─── Stateful lexer ───────────────────────────────────────────────────────────

type Lexed =
  | {
      ok: true;
      /** Authoritative: comments gone, every literal replaced by '', lower-cased, whitespace collapsed. */
      code: string;
      /** Same scan with literal content kept. Used only for positive contract matching, never to accept safety. */
      text: string;
      /** Top-level SQL only, each DO body replaced by <block:tag>. */
      top: string;
      blocks: string[];
      /** Each DO body's own code, in the same form as `code`. */
      bodies: Body[];
    }
  | { ok: false; error: string };

/**
 * One lexed statement as code and literal segments. Statement boundaries are
 * the `;` the lexer sees in NORMAL state, never one inside a literal or
 * comment. Code is lower-cased with whitespace collapsed; literal values keep
 * their exact source text, case included.
 */
type Segment = { code: string } | { lit: string };
type Statement = Segment[];

type Body = { tag: string; code: string; statements: Statement[] };

type Scanned =
  | { ok: true; code: string; text: string; top: string; blocks: string[]; bodies: Body[]; statements: Statement[] }
  | { ok: false; error: string };

/** Collapse a statement's code segments and drop the empty ones. */
function finishStatement(segments: Segment[]): Statement {
  const merged: Segment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if ("code" in s && last && "code" in last) last.code += s.code;
    else merged.push("code" in s ? { code: s.code } : { lit: s.lit });
  }
  const out: Statement = [];
  merged.forEach((s, i) => {
    if (!("code" in s)) return void out.push(s);
    let c = s.code.replace(/\s+/g, " ").toLowerCase();
    if (i === 0) c = c.trimStart();
    if (i === merged.length - 1) c = c.trimEnd();
    if (c !== "") out.push({ code: c });
  });
  return out;
}

/** A statement written back as SQL, for messages. */
function render(statement: Statement): string {
  return statement.map((s) => ("code" in s ? s.code : `'${s.lit}'`)).join("");
}

type LexState = "NORMAL" | "LINE_COMMENT" | "SINGLE_QUOTED_STRING";

const IDENT_CHAR = /[A-Za-z0-9_&]/;
const WORD_CHAR = /[a-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** One character-by-character pass over top-level SQL or over one already-delimited DO body. */
function scan(src: string, mode: "top" | "body"): Scanned {
  let state: LexState = "NORMAL";
  let code = "";
  let text = "";
  let top = "";
  let literal = "";
  const blocks: string[] = [];
  const bodies: Body[] = [];
  const statements: Statement[] = [];
  let segments: Segment[] = [];

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === "LINE_COMMENT") {
      // A comment's content has no lexical meaning; it ends at the newline.
      if (ch === "\n") {
        state = "NORMAL";
        code += "\n";
        text += "\n";
        top += "\n";
        segments.push({ code: "\n" });
      }
      continue;
    }

    if (state === "SINGLE_QUOTED_STRING") {
      if (ch === "\\") return { ok: false, error: "backslash in string literal" };
      if (ch === "'" && next === "'") {
        literal += "''";
        i++;
        continue;
      }
      if (ch === "'") {
        state = "NORMAL";
        code += "''";
        text += `'${literal}'`;
        top += "''";
        segments.push({ lit: literal });
        literal = "";
        continue;
      }
      literal += ch;
      continue;
    }

    // NORMAL
    if (ch === "-" && next === "-") {
      state = "LINE_COMMENT";
      code += " ";
      text += " ";
      top += " ";
      segments.push({ code: " " });
      i++;
      continue;
    }
    if (ch === "'") {
      // E'', U&'', B'', X'', N'' and every other prefixed literal is unsupported.
      if (i > 0 && IDENT_CHAR.test(src[i - 1])) return { ok: false, error: "prefixed (escape/unicode) string literal" };
      state = "SINGLE_QUOTED_STRING";
      continue;
    }
    if (ch === '"') return { ok: false, error: "double-quoted identifier" };
    if (ch === "/" && next === "*") return { ok: false, error: "block comment" };
    if (ch === "\\") return { ok: false, error: "backslash in executable source" };
    if (ch === "$") {
      const m = src.slice(i).match(DOLLAR_TAG);
      const tag = m?.[1];
      if (!m || tag === undefined || !APPROVED_TAGS.includes(tag)) {
        return { ok: false, error: `unapproved dollar tag ${m ? m[0] : "$"}` };
      }
      if (mode === "body") return { ok: false, error: `approved delimiter inside DO body: ${m[0]}` };
      // The only header form supported is a line that starts exactly `do $tag$`:
      // lower-case DO, one space, the tag. `do$tag$` is an identifier to
      // PostgreSQL, and comments or other spacing are not interpreted.
      if (src.slice(i - 3, i) !== "do " || (i > 3 && src[i - 4] !== "\n")) {
        return { ok: false, error: `${m[0]} does not open a DO block` };
      }

      // PostgreSQL ends a dollar-quoted body at the FIRST matching tag, even one
      // that looks like it sits in a comment or string. Cut the body there.
      const open = i + m[0].length;
      const close = src.indexOf(m[0], open);
      if (close < 0) return { ok: false, error: `unterminated dollar quote ${m[0]}` };
      const body = src.slice(open, close);
      for (const other of APPROVED_TAGS) {
        if (body.includes(`$${other}$`)) return { ok: false, error: `approved delimiter inside DO body: $${other}$` };
      }

      const inner = scan(body, "body");
      if (!inner.ok) return inner;
      blocks.push(tag);
      bodies.push({ tag, code: inner.code, statements: inner.statements });
      code += `${m[0]} ${inner.code} ${m[0]}`;
      text += `${m[0]} ${inner.text} ${m[0]}`;
      top += `<block:${tag}>`;
      segments.push({ code: `<block:${tag}>` });
      i = close + m[0].length - 1;
      continue;
    }
    code += ch;
    text += ch;
    top += ch;
    if (ch === ";") {
      statements.push(finishStatement(segments));
      segments = [];
    } else {
      segments.push({ code: ch });
    }
  }

  if (state === "SINGLE_QUOTED_STRING") {
    return { ok: false, error: mode === "body" ? "DO body ends inside a string literal" : "unterminated string literal" };
  }
  if (state === "LINE_COMMENT" && mode === "body") return { ok: false, error: "DO body ends inside a line comment" };
  // End of input ends a statement too: keep any non-empty remainder.
  const rest = finishStatement(segments);
  if (rest.length > 0) statements.push(rest);
  return { ok: true, code, text, top, blocks, bodies, statements };
}

/** Lexes SQL; a migration source must carry exactly the approved DO blocks, in order. */
function lex(sql: string, expectedBlocks: string[] = APPROVED_BLOCKS): Lexed {
  // Checked before anything else: PostgreSQL ends a line comment at a lone CR,
  // and this contract is LF-only, so no CR of any kind is accepted.
  if (sql.includes("\r")) return { ok: false, error: "carriage return in source" };
  const result = scan(sql, "top");
  if (!result.ok) return result;
  if (JSON.stringify(result.blocks) !== JSON.stringify(expectedBlocks)) {
    return { ok: false, error: `DO block sequence ${JSON.stringify(result.blocks)}` };
  }
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return {
    ok: true,
    code: collapse(result.code),
    text: collapse(result.text),
    top: collapse(result.top),
    blocks: result.blocks,
    bodies: result.bodies.map((b) => ({ tag: b.tag, code: collapse(b.code), statements: b.statements })),
  };
}

/** A hand-written contract lexed into statements by the same lexer; one statement per entry. */
function contractStatements(expected: string[]): Statement[] {
  const result = scan(expected.join(";\n") + ";\n", "body");
  if (!result.ok) throw new Error(`contract does not lex: ${result.error}`);
  if (result.statements.length !== expected.length) throw new Error("contract entry contains a ';'");
  return result.statements;
}

/** One expected literal against one actual literal: exact, or code-prefix for a message wildcard. */
function literalMatches(expected: string, actual: string): boolean {
  const message = expected.match(MESSAGE_CODE);
  return message ? actual.startsWith(message[1]) : actual === expected;
}

function statementMatches(expected: Statement, actual: Statement): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((e, i) => {
    const a = actual[i];
    if ("code" in e) return "code" in a && a.code === e.code;
    return "lit" in a && literalMatches(e.lit, a.lit);
  });
}

/** Exact count and order: each body statement must match its contract entry at the same position. */
function contractViolations(body: Body): string[] {
  const expected = contractStatements(body.tag === "preflight" ? PREFLIGHT_EXPECTED_STATEMENTS : POSTFLIGHT_EXPECTED_STATEMENTS);
  const out: string[] = [];
  if (body.statements.length !== expected.length) {
    out.push(`contract: ${body.tag} has ${body.statements.length} statements, expected ${expected.length}`);
  }
  const first = expected.findIndex((e, i) => i >= body.statements.length || !statementMatches(e, body.statements[i]));
  if (first >= 0) {
    const actual = body.statements[first];
    out.push(`contract: ${body.tag} statement ${first + 1} is ${actual ? JSON.stringify(render(actual)) : "missing"}`);
  }
  return out;
}

/** A lexer result that must have succeeded. */
function lexed(sql: string, expectedBlocks: string[] = APPROVED_BLOCKS): Extract<Lexed, { ok: true }> {
  const result = lex(sql, expectedBlocks);
  if (!result.ok) throw new Error(`lexer rejected source: ${result.error}`);
  return result;
}

/**
 * Every GRANT or REVOKE in lexed code, found as a whole word token and taken
 * through its terminating `;` — or through end of input, which also ends a
 * PostgreSQL statement.
 */
function privilegeStatements(code: string): string[] {
  const found: string[] = [];
  for (const { word, start } of wordTokens(code)) {
    if (word === "grant" || word === "revoke") {
      const end = code.indexOf(";", start);
      found.push(end < 0 ? code.slice(start).trim() : code.slice(start, end + 1));
    }
  }
  return found;
}

/** Whole-word tokens of lexed code, with their positions. */
function wordTokens(code: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = [];
  let i = 0;
  while (i < code.length) {
    if (!WORD_CHAR.test(code[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < code.length && WORD_CHAR.test(code[j])) j++;
    tokens.push({ word: code.slice(i, j), start: i, end: j });
    i = j;
  }
  return tokens;
}

/** Every DO keyword that is not one of the two structural headers. */
function nestedDoStatements(code: string): string[] {
  return wordTokens(code)
    .filter(({ word, end }) => word === "do" && !APPROVED_TAGS.some((tag) => code.startsWith(` $${tag}$`, end)))
    .map(({ start }) => code.slice(start, start + 40));
}

/**
 * Every call site: a dotted name followed by `(`, with or without a space.
 * Any keyword followed by `(` counts as a call too, so nothing is skipped.
 */
function functionCalls(code: string): string[] {
  const calls: string[] = [];
  const tokens = wordTokens(code);
  for (let t = 0; t < tokens.length; t++) {
    let name = tokens[t].word;
    let end = tokens[t].end;
    while (t + 1 < tokens.length && code[end] === "." && tokens[t + 1].start === end + 1) {
      t++;
      name += `.${tokens[t].word}`;
      end = tokens[t].end;
    }
    let k = end;
    while (code[k] === " ") k++;
    if (code[k] === "(") calls.push(name);
  }
  return calls;
}

/**
 * Every `::` cast target, with optional whitespace after `::`, as its full
 * dotted name. A `::` not followed by a name is reported as "<unclassified>".
 */
function castTargets(code: string): string[] {
  const targets: string[] = [];
  let at = code.indexOf("::");
  while (at >= 0) {
    let j = at + 2;
    while (code[j] === " ") j++;
    const m = code.slice(j).match(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*/);
    targets.push(m ? m[0] : "<unclassified>");
    at = code.indexOf("::", at + 2);
  }
  return targets;
}

/** Every maximal run of PostgreSQL operator characters. */
function operators(code: string): string[] {
  const OP_CHARS = "+-*/<>=~!@#%^&|`?";
  const ops: string[] = [];
  let i = 0;
  while (i < code.length) {
    if (!OP_CHARS.includes(code[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < code.length && OP_CHARS.includes(code[j])) j++;
    ops.push(code.slice(i, j));
    i = j;
  }
  return ops;
}

/**
 * Statement allow-list for one DO body: `declare <declarations> begin
 * <statements> end;`. Each statement is a simple allowed statement, optionally
 * opened by IF/FOREACH headers, or a matching `end if` / `end loop`.
 */
function bodyViolations(body: Body): string[] {
  const out: string[] = [];
  const shape = body.code.match(/^declare (.*?) begin (.*) end;$/);
  if (!shape) return [`statement: ${body.tag} body is not declare … begin … end;`];

  const declarations = shape[1].split(";").map((s) => s.trim());
  if (declarations.pop() !== "") out.push(`statement: ${body.tag} declarations do not end with ;`);
  for (const d of declarations) if (!DECLARATION.test(d)) out.push(`statement: ${body.tag} declaration ${JSON.stringify(d)}`);

  const statements = shape[2].split(";").map((s) => s.trim());
  if (statements.pop() !== "") out.push(`statement: ${body.tag} body does not end with ;`);
  const open: string[] = [];
  for (const statement of statements) {
    let rest = statement;
    for (;;) {
      const ifMatch = rest.match(IF_OPENER);
      const loopMatch = ifMatch ? null : rest.match(FOREACH_OPENER);
      if (ifMatch) {
        open.push("if");
        rest = ifMatch[1];
      } else if (loopMatch) {
        open.push("loop");
        rest = loopMatch[1];
      } else break;
    }
    if (rest === "end if" || rest === "end loop") {
      if (open.pop() !== rest.slice(4)) out.push(`statement: ${body.tag} unbalanced ${JSON.stringify(rest)}`);
      continue;
    }
    if (!SIMPLE_STATEMENTS.some(([, template]) => template.test(rest))) {
      out.push(`statement: ${body.tag} ${JSON.stringify(rest)}`);
    }
  }
  if (open.length !== 0) out.push(`statement: ${body.tag} unclosed ${JSON.stringify(open)}`);
  return out;
}

// ─── The single authoritative safety validator ────────────────────────────────

/**
 * Every safety violation in a migration source. Empty means it is safe.
 * All checks read the same lexer-produced executable representation.
 */
function violations(sql: string): string[] {
  const result = lex(sql);
  if (!result.ok) return [`lexer: ${result.error}`];
  const code = result.code;
  const out: string[] = [];

  // 0. Top level is exactly: preflight DO, the frozen revoke, postflight DO.
  //    Splitting on `;` keeps the text after the last one, so trailing
  //    unterminated SQL at end of input is a statement too.
  const statements = result.top.split(";").map((s) => s.trim());
  if (JSON.stringify(statements) !== JSON.stringify(TOP_LEVEL_STATEMENTS)) {
    out.push(`structure: ${JSON.stringify(statements)}`);
  }

  // 1. No dynamic or indirect execution. A nested DO runs its quoted body, so
  //    DO joins EXECUTE, format(, CALL and PERFORM.
  for (const nested of nestedDoStatements(code)) out.push(`dynamic: nested do ${JSON.stringify(nested)}`);
  if (/\bexecute\b/.test(code)) out.push("dynamic: execute");
  if (/\bformat\s*\(/.test(code)) out.push("dynamic: format(");
  if (/\bcall\b/.test(code)) out.push("dynamic: call");
  if (/\bperform\b/.test(code)) out.push("dynamic: perform");

  // 2. Exactly one privilege change anywhere, DO bodies included.
  const changes = privilegeStatements(code);
  if (changes.length !== 1 || changes[0] !== FROZEN_REVOKE) out.push(`privilege: ${JSON.stringify(changes)}`);

  // 3. No transaction control anywhere. Each DO block's own BEGIN opens its
  //    PL/pgSQL body and is the only BEGIN allowed.
  const blockHeadersRemoved = code.replace(/do \$(\w+)\$ (declare .*? )?begin\b/g, "do $$$1$$ <body>");
  if (/\bbegin\b/.test(blockHeadersRemoved)) out.push("transaction: begin");
  if (/\b(commit|rollback|savepoint|release|start transaction|abort|end transaction|prepare transaction)\b/.test(code)) {
    out.push("transaction: control");
  }

  // 4. No DDL of any kind: the migration needs no CREATE, DROP or ALTER.
  if (/\b(create|drop|alter)\b/.test(code)) out.push("ddl: create/drop/alter");

  // 5. No data DML. REVOKE DELETE/TRUNCATE are privilege names, not DML.
  if (/\binsert\b/.test(code)) out.push("dml: insert");
  if (/\bupdate\b/.test(code)) out.push("dml: update");
  if (/\bdelete\s+from\b/.test(code)) out.push("dml: delete from");
  if (/\btruncate\s+(table\s+)?[a-z_]/.test(code)) out.push("dml: truncate");
  if (/\bmerge\b/.test(code)) out.push("dml: merge");
  if (/\bcopy\b/.test(code)) out.push("dml: copy");

  // 6. Out-of-scope objects and RLS state.
  if (/\bpolicy\b/.test(code)) out.push("rls: policy");
  if (/row level security/.test(code)) out.push("rls: toggle");
  if (/billing_checkout_guard|billing_[a-z_]+\s*\(/.test(code)) out.push("billing");
  if (/\bauth\./.test(code)) out.push("auth");
  if (/\bset\s+(role|session)\b|\breset\s+role\b/.test(code)) out.push("role switch");

  // 7. Positive allow-list: every statement in each DO body has an approved shape.
  for (const body of result.bodies) out.push(...bodyViolations(body));

  // 8. Positive allow-list: every function call, cast and operator is approved.
  for (const call of functionCalls(code)) if (!ALLOWED_FUNCTIONS.includes(call)) out.push(`function: ${call}`);
  for (const cast of castTargets(code)) if (!ALLOWED_CASTS.includes(cast)) out.push(`cast: ${cast}`);
  for (const op of operators(code)) if (!ALLOWED_OPERATORS.includes(op)) out.push(`operator: ${op}`);

  // 9. Exact ordered contract: every body statement, literals included, at its
  //    fixed position, with nothing added, removed, duplicated or moved.
  for (const body of result.bodies) out.push(...contractViolations(body));

  return out;
}

/** The migration with extra statements injected into one DO body. */
function inject(statement: string, block: "preflight" | "postflight" = "preflight"): string {
  return replaceOnce(`end;\n$${block}$;`, (marker) => `  ${statement}\n${marker}`);
}

/** The migration with one exact fragment rewritten. A replacer keeps `$$` and `$'` literal. */
function replaceOnce(fragment: string, rewrite: (fragment: string) => string): string {
  expect(raw.split(fragment)).toHaveLength(2);
  return raw.replace(fragment, () => rewrite(fragment));
}

/** The exact message text of each exception in the reviewed migration, keyed by its code. */
const MESSAGE_TEXT: Record<string, string> = {
  "PRE-1": "public.users is missing.",
  "PRE-6": "PUBLIC holds a table privilege on public.users.",
  "PRE-7": "public.users carries column-level privileges.",
};

/** The migration with only one exception's free message text (after its code) rewritten. */
function withMessage(code: keyof typeof MESSAGE_TEXT, text: string): string {
  return replaceOnce(`'PRICING1-HARDEN-${code}: ${MESSAGE_TEXT[code]}'`, () => `'PRICING1-HARDEN-${code}: ${text}'`);
}

/** The migration with one exact fragment rewritten inside one DO block only. */
function mutateBlock(block: "preflight" | "postflight", fragment: string, rewrite: string): string {
  const start = raw.indexOf(`\ndo $${block}$`);
  const end = raw.indexOf(`$${block}$;`, start + 3);
  expect(start).toBeGreaterThanOrEqual(0);
  const region = raw.slice(start, end);
  expect(region.split(fragment), `fragment in ${block}: ${fragment}`).toHaveLength(2);
  return raw.slice(0, start) + region.replace(fragment, () => rewrite) + raw.slice(end);
}

/** Expects rejection whose joined reasons match `reason`. */
function expectRejected(sql: string, reason: RegExp): void {
  const found = violations(sql);
  expect(found.length, "no violation").toBeGreaterThan(0);
  expect(found.join(" | ")).toMatch(reason);
}

const real = lexed(raw);
const code = real.code;
const text = real.text;
const preflight = text.slice(text.indexOf("$preflight$"), text.lastIndexOf("$preflight$"));
const postflight = text.slice(text.indexOf("$postflight$"), text.lastIndexOf("$postflight$"));

function indexOfRequired(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  expect(at, `expected to contain: ${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

/** The exact-set read for one role, as written in a DO block. */
function aclRead(role: string): string {
  return `${GRANTABLE_ENTRY}, '') into v_${role === "service_role" ? "service" : role} from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = '${role}'::regrole;`;
}

// ─── Identity and inventory ───────────────────────────────────────────────────

describe("PRICING-1 public.users hardening — identity and inventory", () => {
  it("1/29. carries the CLI-generated name and suffix", () => {
    expect(PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME).toBe(
      "20261009202013_pricing1_harden_public_users_privileges.sql",
    );
    expect(PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME).toMatch(/^\d{14}_pricing1_harden_public_users_privileges\.sql$/);
  });

  it("1. is registered exactly once and exists on disk exactly once", () => {
    expect(APPROVED_MIGRATIONS.filter((m) => m === PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME)).toHaveLength(1);
    expect(inventorySource.match(/"20261009202013_pricing1_harden_public_users_privileges\.sql"/g)).toHaveLength(1);
    expect(inventorySource.match(/^  PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME,$/gm)).toHaveLength(1);
    const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith("_pricing1_harden_public_users_privileges.sql"));
    expect(onDisk).toEqual([PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME]);
  });

  it("sorts directly after the PRICING-1 billing guard and after everything authored before it", () => {
    const earlier = migrationsAuthoredBefore(PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME);
    expect(earlier[earlier.length - 1]).toBe(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME);
    expect(sortsAfterAll(PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME, earlier)).toBe(true);
    expect(APPROVED_MIGRATIONS.indexOf(PRICING1_HARDEN_PUBLIC_USERS_PRIVILEGES_FILENAME)).toBe(earlier.length);
  });

  it("keeps the closed-world inventory equal to the files on disk", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });
});

// ─── The lexer itself ─────────────────────────────────────────────────────────

describe("PRICING-1 public.users hardening — lexer positive controls", () => {
  it("A. an apostrophe inside a -- line comment does not open a string", () => {
    expect(lexed("select 1; -- the account's row\nselect 2;", []).code).toBe("select 1; select 2;");
  });

  it("B. -- inside an ordinary literal does not open a comment", () => {
    expect(lexed("raise notice '-- not a comment'; select 2;", []).code).toBe("raise notice ''; select 2;");
  });

  it("C. doubled quotes stay inside one literal", () => {
    const result = lexed("raise notice 'it''s text'; select 3;", []);
    expect(result.code).toBe("raise notice ''; select 3;");
    expect(result.text).toBe("raise notice 'it''s text'; select 3;");
  });

  it("D. statement words inside a message literal are data, not executable SQL", () => {
    const result = lexed("raise exception 'grant update public.users then delete from it'; select 4;", []);
    expect(result.code).toBe("raise exception ''; select 4;");
    // Exercised through an existing exception's free message text: adding a statement is a contract violation.
    expect(violations(withMessage("PRE-1", "grant select, update public.users and delete from it"))).toEqual([]);
  });

  it("E. both approved DO blocks are accepted and their bodies stay executable", () => {
    expect(real.blocks).toEqual(APPROVED_BLOCKS);
    expect(real.top).toBe("do <block:preflight>; " + FROZEN_REVOKE + " do <block:postflight>;");
    expect(code.match(/\$preflight\$/g)).toHaveLength(2);
    expect(code.match(/\$postflight\$/g)).toHaveLength(2);
    expect(code).toContain("$preflight$ declare");
    expect(code).toContain("pg_catalog.aclexplode(c.relacl) x");
    expect(code).toContain("$postflight$ declare");
    expect(code).toContain("foreach v_role in array array[");
  });

  it("F. unsupported syntax wholly inside a top-level -- comment is ignored", () => {
    expect(lexed("select 1; -- /* \" $x$ E'\\ u&'\nselect 2;", []).code).toBe("select 1; select 2;");
  });

  it("G. privilege statements are whole-word tokens, finalized at end of input", () => {
    expect(privilegeStatements("select x.is_grantable; revoke a on b from c; grant d")).toEqual([
      "revoke a on b from c;",
      "grant d",
    ]);
  });

  it("the real migration lexes cleanly and is LF-only", () => {
    expect(raw.includes("\r")).toBe(false);
    expect(lex(raw).ok).toBe(true);
  });
});

// ─── The real migration passes every safety scan ──────────────────────────────

describe("PRICING-1 public.users hardening — safety scans over all executable SQL", () => {
  it("the migration has no violation at all", () => {
    expect(violations(raw)).toEqual([]);
  });

  it("dynamic SQL is ruled out: no EXECUTE, format(, CALL or PERFORM, even inside literals", () => {
    for (const view of [code, text]) {
      expect(view).not.toMatch(/\bexecute\b/);
      expect(view).not.toMatch(/\bformat\s*\(/);
      expect(view).not.toMatch(/\bcall\b/);
      expect(view).not.toMatch(/\bperform\b/);
    }
  });

  it("2/3/10. the sole privilege mutation anywhere is the frozen revoke", () => {
    expect(privilegeStatements(code)).toEqual([FROZEN_REVOKE]);
  });

  it("2. revokes exactly DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from exactly anon and authenticated", () => {
    const m = FROZEN_REVOKE.match(/^revoke (.*) on table public\.users from (.*);$/)!;
    expect(m[1].split(",").map((p) => p.trim())).toEqual(["delete", "truncate", "references", "trigger", "maintain"]);
    expect(m[2].split(",").map((r) => r.trim())).toEqual(["anon", "authenticated"]);
  });

  it("preflight precedes the revoke, which precedes the postflight", () => {
    const pre = code.indexOf("$preflight$");
    const rev = code.indexOf(FROZEN_REVOKE);
    const post = code.indexOf("$postflight$");
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(code.lastIndexOf("$preflight$")).toBeLessThan(rev);
    expect(rev).toBeLessThan(post);
  });

  it("carries no project reference or credential", () => {
    expect(raw).not.toMatch(/atlmnqispyzhsahahpjy|vyusdgvongfdzoteqyxz|supabase\.co|eyJ|service_role_key|password/i);
  });
});

// ─── Adversarial: the scans reject dangerous SQL hidden in a DO body ──────────

describe("PRICING-1 public.users hardening — adversarial DO-body variants are rejected", () => {
  const VARIANTS: [string, string, RegExp][] = [
    ["1. extra SELECT revoke from anon", "revoke select on table public.users from anon;", /privilege/],
    ["2. revoke from service_role", "revoke maintain on table public.users from service_role;", /privilege/],
    ["3. revoke from PUBLIC", "revoke select on table public.users from public;", /privilege/],
    ["4. commit", "commit;", /transaction/],
    ["5. rollback", "rollback;", /transaction/],
    ["6. savepoint", "savepoint x;", /transaction/],
    ["7. create view", "create view public.bad as select 1;", /ddl/],
    ["8. alter role", "alter role authenticated login;", /ddl/],
    ["9. execute literal", "execute 'delete from public.users';", /dynamic: execute/],
    ["10. execute format", "execute format('grant select on public.users to anon');", /dynamic/],
    ["extra SELECT revoke from authenticated", "revoke select on table public.users from authenticated;", /privilege/],
    ["revoke on another object", "revoke select on table public.drills from anon;", /privilege/],
    ["grant", "grant insert on table public.users to authenticated;", /privilege/],
    ["nested begin", "begin;", /transaction: begin/],
    ["release savepoint", "release savepoint x;", /transaction/],
    ["drop index", "drop index public.users_pkey;", /ddl/],
    ["create trigger", "create trigger t after insert on public.users for each row execute function f();", /ddl|dynamic/],
    ["alter schema", "alter schema public owner to anon;", /ddl/],
    ["delete from", "delete from public.users;", /dml: delete from/],
    ["update", "update public.users set role = 'admin';", /dml: update/],
    ["insert", "insert into public.users (id) values (null);", /dml: insert/],
    ["truncate", "truncate public.users;", /dml: truncate/],
    ["perform", "perform pg_catalog.pg_sleep(1);", /dynamic: perform/],
    ["call", "call public.do_something();", /dynamic: call/],
    ["policy", "drop policy x on public.users;", /ddl|rls/],
    ["billing guard", "delete from public.billing_checkout_guard;", /billing|dml/],
    ["auth.users", "delete from auth.users;", /auth|dml/],
    ["role switch", "set role anon;", /role switch/],
  ];

  for (const [label, statement, expected] of VARIANTS) {
    it(`rejects: ${label}`, () => {
      expectRejected(inject(statement), expected);
    });
  }

  it("the same statements are rejected in the postflight body too", () => {
    for (const statement of ["revoke select on table public.users from anon;", "commit;", "execute 'select 1';"]) {
      expect(violations(inject(statement, "postflight")).length, statement).toBeGreaterThan(0);
    }
  });

  it("a message literal mentioning a statement is not mistaken for one", () => {
    // Only an existing exception's free message text can carry it: RAISE NOTICE is not on the allow-list,
    // and an added RAISE EXCEPTION breaks the ordered contract.
    expect(violations(withMessage("PRE-1", "would update public.users and delete from it"))).toEqual([]);
  });
});

// ─── Lexer bypass regressions found in review ─────────────────────────────────

describe("PRICING-1 public.users hardening — lexer bypass regressions", () => {
  const BYPASSES: [string, string, RegExp][] = [
    [
      "1. -- inside a string cannot hide a GRANT",
      "raise notice '--';\n  grant select on table public.users to public;\n  raise notice '--';",
      /privilege: .*grant select on table public\.users to public;/,
    ],
    [
      "2. -- inside a string cannot hide EXECUTE",
      "raise notice '--';\n  execute 'grant select on table public.users to public';\n  raise notice '--';",
      /dynamic: execute/,
    ],
    [
      "3. E-string escape syntax fails closed",
      "raise notice E'\\'';\n  grant select on table public.users to public;\n  raise notice E'\\'';",
      /^lexer: prefixed \(escape\/unicode\) string literal$/,
    ],
    [
      "4. double-quoted identifiers fail closed",
      "select 1 as \"a'\" into v_columns;\n  grant select on table public.users to public;\n  select 1 as \"'b\" into v_columns;",
      /^lexer: double-quoted identifier$/,
    ],
  ];

  for (const [label, statement, expected] of BYPASSES) {
    it(`rejects: ${label}`, () => {
      for (const block of ["preflight", "postflight"] as const) {
        expectRejected(inject(statement, block), expected);
      }
    });
  }
});

// ─── Unsupported lexical features fail closed ─────────────────────────────────

describe("PRICING-1 public.users hardening — unsupported lexer features fail closed", () => {
  const PROBES: [string, string, RegExp][] = [
    ["block comment", "/* block comment */", /block comment/],
    ["backslash inside a literal", "raise notice 'a\\b';", /backslash in string literal/],
    ["backslash in executable source", "select 1 \\ 2 into v_columns;", /backslash in executable source/],
    ["unapproved $x$ tag", "raise notice $x$hidden$x$;", /unapproved dollar tag \$x\$/],
    ["anonymous $$ tag", "raise notice $$hidden$$;", /unapproved dollar tag \$\$/],
    ["unapproved $body$ tag", "raise notice $body$hidden$body$;", /unapproved dollar tag \$body\$/],
    ["bare dollar", "select $1 into v_columns;", /unapproved dollar tag \$/],
    ["extra approved tag occurrence", "raise notice $preflight$x$preflight$;", /does not open a DO block/],
    ["unterminated string", "raise notice 'oops;", /DO body ends inside a string literal/],
    ["E'' escape string", "raise notice E'x';", /prefixed/],
    ["e'' escape string", "raise notice e'x';", /prefixed/],
    ["U&'' unicode string", "raise notice U&'x';", /prefixed/],
    ["u&'' unicode string", "raise notice u&'x';", /prefixed/],
    ["double-quoted identifier", "select 1 as \"x\" into v_columns;", /double-quoted identifier/],
  ];

  for (const [label, statement, expected] of PROBES) {
    it(`rejects: ${label}`, () => {
      const found = violations(inject(statement));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^lexer: /);
      expect(found[0]).toMatch(expected);
    });
  }

  it("an unterminated string at end of input fails closed at unit level", () => {
    expect(lex("select 'abc", [])).toEqual({ ok: false, error: "unterminated string literal" });
  });
});

// ─── Finding 1: DO bodies end where PostgreSQL ends them ──────────────────────

describe("PRICING-1 public.users hardening — dollar-quote boundaries follow PostgreSQL", () => {
  /** The review's escape: a matching tag in a comment after END closes the body early. */
  const escapeAfterEnd = (block: "preflight" | "postflight", statement: string) =>
    replaceOnce(`end;\n$${block}$;`, () => `end;\n-- $${block}$; ${statement} select $${block}$\n$${block}$;`);

  /** Tag occurrences a lexer that ignores comments would see: the expected structure is preserved. */
  const visibleOutsideComments = (sql: string, tag: string) =>
    sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(`$${tag}$`).length - 1;

  it("1. a $preflight$ in a line comment after END cannot release a GRANT to top level", () => {
    const fixture = escapeAfterEnd("preflight", "grant select on table public.drills to anon;");
    expect(visibleOutsideComments(fixture, "preflight")).toBe(2);
    expect(violations(fixture)).toEqual(["lexer: DO body ends inside a line comment"]);
  });

  it("1-control. the same comment without the tag stays an ordinary comment and is accepted", () => {
    const control = replaceOnce(
      "end;\n$preflight$;",
      () => "end;\n-- note; grant select on table public.drills to anon; select x\n$preflight$;",
    );
    expect(violations(control)).toEqual([]);
  });

  it("2. a $postflight$ in a line comment after END cannot release a GRANT to top level", () => {
    const fixture = escapeAfterEnd("postflight", "grant select on table public.users to public;");
    expect(visibleOutsideComments(fixture, "postflight")).toBe(2);
    expect(violations(fixture)).toEqual(["lexer: DO body ends inside a line comment"]);
  });

  it("3. a matching tag in a comment inside the body ends the body there and fails closed", () => {
    expect(violations(inject("-- see $preflight$ docs"))).toEqual(["lexer: DO body ends inside a line comment"]);
    expect(violations(inject("-- see $postflight$ docs", "postflight"))).toEqual([
      "lexer: DO body ends inside a line comment",
    ]);
  });

  it("4. a matching tag inside a body string literal ends the body there and fails closed", () => {
    expect(violations(inject("raise notice 'x $preflight$ y';"))).toEqual(["lexer: DO body ends inside a string literal"]);
  });

  it("5. a GRANT after a tag hidden in a body string literal is rejected", () => {
    const fixture = replaceOnce(
      "end;\n$preflight$;",
      () => "end;\nraise notice '$preflight$; grant select on table public.users to public; select $preflight$';\n$preflight$;",
    );
    expect(violations(fixture)).toEqual(["lexer: DO body ends inside a string literal"]);
  });

  it("6. the other approved tag inside a body comment or string fails closed", () => {
    expect(violations(inject("-- $postflight$"))).toEqual(["lexer: approved delimiter inside DO body: $postflight$"]);
    expect(violations(inject("raise notice '$postflight$';"))).toEqual([
      "lexer: approved delimiter inside DO body: $postflight$",
    ]);
    expect(violations(inject("-- $preflight$ x", "postflight"))).toEqual([
      "lexer: approved delimiter inside DO body: $preflight$",
    ]);
  });

  it("7. an approved tag that does not open a DO block fails closed", () => {
    expect(violations(raw + "select $preflight$x$preflight$;\n")).toEqual(["lexer: $preflight$ does not open a DO block"]);
  });

  it("8. a body that never closes fails closed", () => {
    expect(violations(raw.replace("end;\n$postflight$;", () => "end;\n"))).toEqual([
      "lexer: unterminated dollar quote $postflight$",
    ]);
  });
});

// ─── Finding 2: carriage returns fail closed ──────────────────────────────────

describe("PRICING-1 public.users hardening — carriage returns are rejected", () => {
  const CR = String.fromCharCode(13);
  const CR_REJECTED = ["lexer: carriage return in source"];

  it("the fixtures carry a real CR character", () => {
    expect(CR).toBe("\r");
    expect(CR.length).toBe(1);
  });

  it("1. a lone CR after a top-level comment prefix cannot release a GRANT", () => {
    const fixture = replaceOnce("  from anon, authenticated;\n", (f) => `${f}-- note${CR}grant select on table public.users to public;\n`);
    expect(fixture.includes(`-- note${CR}grant`)).toBe(true);
    expect(violations(fixture)).toEqual(CR_REJECTED);
  });

  it("2. a lone CR inside a DO body cannot release a GRANT", () => {
    expect(violations(inject(`-- note${CR}grant select on table public.users to public;`))).toEqual(CR_REJECTED);
  });

  it("3. CRLF input is rejected", () => {
    expect(violations(raw.replace(/\n/g, `${CR}\n`))).toEqual(CR_REJECTED);
  });

  it("4. a CR inside a quoted literal is rejected", () => {
    expect(violations(inject(`raise notice 'a${CR}b';`))).toEqual(CR_REJECTED);
  });

  it("5. a CR next to a dollar-quote boundary is rejected", () => {
    expect(violations(replaceOnce("end;\n$preflight$;", () => `end;\n$preflight$${CR};`))).toEqual(CR_REJECTED);
  });
});

// ─── Finding 3: statements end at end of input too ────────────────────────────

describe("PRICING-1 public.users hardening — statements at end of input", () => {
  it("1. a final GRANT without a semicolon is rejected", () => {
    expectRejected(raw + "grant select on table public.users to anon", /privilege: .*"grant select on table public\.users to anon"/);
  });

  it("2. a final REVOKE without a semicolon is rejected", () => {
    expectRejected(raw + "revoke select on table public.users from anon", /privilege: .*"revoke select on table public\.users from anon"/);
  });

  it("3. mixed-case GRANT and REVOKE are rejected", () => {
    expectRejected(raw + "GrAnT select on table public.drills to anon;", /privilege: .*grant select on table public\.drills to anon;/);
    expectRejected(raw + "ReVoKe SELECT on table public.users FROM anon", /privilege: .*revoke select on table public\.users from anon/);
  });

  it("4. extra executable SQL after the postflight block is rejected", () => {
    expectRejected(raw + "select 1;\n", /structure/);
  });

  it("5. extra executable SQL at end of input without a semicolon is rejected", () => {
    expectRejected(raw + "select 1", /structure: .*"select 1"/);
  });

  it("6. widening the frozen revoke on public.users is rejected", () => {
    const fixture = replaceOnce("revoke delete, truncate, references, trigger, maintain\n", () => "revoke delete, truncate, references, trigger, maintain, select\n");
    expectRejected(fixture, /privilege/);
    expectRejected(fixture, /structure/);
  });

  it("7. an unterminated GRANT on another public table is rejected", () => {
    expectRejected(raw + "grant select on table public.drills to anon", /privilege: .*public\.drills/);
  });

  it("control: GRANT and REVOKE inside trailing comments or literals are not statements", () => {
    expect(violations(raw + "-- grant select on table public.users to public")).toEqual([]);
    expect(violations(raw + "\n-- revoke select on table public.users from anon;\n")).toEqual([]);
    expect(violations(withMessage("PRE-1", "revoke select on table public.users from anon"))).toEqual([]);
  });
});

// ─── Remediation 3: nested DO is dynamic execution ────────────────────────────

describe("PRICING-1 public.users hardening — nested DO is rejected in both bodies", () => {
  const NESTED: [string, string][] = [
    ["core: the reviewed GRANT in a quoted DO body", "do 'begin grant select on table public.drills to anon; end';"],
    ["A. GRANT", "do 'begin grant insert on table public.users to authenticated; end';"],
    ["B. REVOKE", "do 'begin revoke select on table public.users from anon; end';"],
    ["C. DML", "do 'begin update public.users set role = ''admin''; delete from public.users; end';"],
    ["D. procedural commands", "do 'begin raise exception ''x''; end';"],
    ["E. mixed case", "Do 'begin grant select on table public.drills to anon; end';"],
    ["E. upper case", "DO 'BEGIN GRANT SELECT ON TABLE public.drills TO anon; END';"],
    ["F. newline separation", "do\n    'begin grant select on table public.drills to anon; end';"],
    ["F. tab separation", "do\t'begin grant select on table public.drills to anon; end';"],
    ["G. SQL inside the quoted body", "do 'begin insert into public.users (id) values (null); end';"],
    ["H. function call", "do 'begin perform public.some_function(); end';"],
    ["LANGUAGE clause", "do language plpgsql 'begin grant select on table public.drills to anon; end';"],
  ];

  for (const [label, statement] of NESTED) {
    it(`rejects: ${label}`, () => {
      for (const block of ["preflight", "postflight"] as const) {
        const found = violations(inject(statement, block)).join(" | ");
        expect(found, block).toMatch(/dynamic: nested do/);
        // The quoted body is inert to every other check: only the DO rule sees the danger.
        expect(found, block).not.toMatch(/privilege|dml|ddl/);
      }
    });
  }

  it("I. control: 'do' inside an informational literal is accepted", () => {
    expect(violations(withMessage("PRE-1", "please do not do this"))).toEqual([]);
  });

  it("J. control: 'do' inside a line comment, or inside a longer identifier, is accepted", () => {
    expect(violations(inject("-- do not do this"))).toEqual([]);
    expect(nestedDoStatements("select undo, do_x from t; do $preflight$ x $preflight$;")).toEqual([]);
  });
});

// ─── Remediation 3: the DO header has exactly one form ────────────────────────

describe("PRICING-1 public.users hardening — DO header form", () => {
  const HEADERS: [string, string, string][] = [
    ["do$preflight$", "\ndo $preflight$", "\ndo$preflight$"],
    ["do$postflight$", "\ndo $postflight$", "\ndo$postflight$"],
    ["DO$preflight$", "\ndo $preflight$", "\nDO$preflight$"],
    ["upper-case DO with a space", "\ndo $preflight$", "\nDO $preflight$"],
    ["two spaces", "\ndo $preflight$", "\ndo  $preflight$"],
    ["tab", "\ndo $postflight$", "\ndo\t$postflight$"],
    ["newline", "\ndo $preflight$", "\ndo\n$preflight$"],
    ["comment between DO and the tag", "\ndo $preflight$", "\ndo -- x\n$preflight$"],
    ["DO glued to a preceding identifier", "\ndo $preflight$", "\nxdo $preflight$"],
  ];

  for (const [label, from, to] of HEADERS) {
    it(`rejects: ${label}`, () => {
      const found = violations(replaceOnce(from, () => to));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/^lexer: \$(preflight|postflight)\$ does not open a DO block$/);
    });
  }

  it("rejects a block comment used to disguise the header", () => {
    expect(violations(replaceOnce("\ndo $preflight$", () => "\ndo /* x */ $preflight$"))).toEqual(["lexer: block comment"]);
  });

  it("accepts the approved header form", () => {
    expect(raw.split("\ndo $preflight$")).toHaveLength(2);
    expect(raw.split("\ndo $postflight$")).toHaveLength(2);
    expect(lex(raw).ok).toBe(true);
  });
});

// ─── Remediation 3: positive statement allow-list ─────────────────────────────

describe("PRICING-1 public.users hardening — statement allow-list", () => {
  it("every statement of the real migration matches an approved shape", () => {
    for (const body of real.bodies) expect(bodyViolations(body), body.tag).toEqual([]);
    expect(real.bodies.map((b) => b.tag)).toEqual(APPROVED_BLOCKS);
  });

  const UNEXPECTED: [string, string][] = [
    ["SET search_path", "set search_path = public;"],
    ["SET LOCAL", "set local statement_timeout = 0;"],
    ["RESET", "reset all;"],
    ["SET ROLE", "set role anon;"],
    ["SET SESSION AUTHORIZATION", "set session authorization anon;"],
    ["LOAD", "load 'auto_explain';"],
    ["COPY", "copy public.users to stdout;"],
    ["CREATE", "create table public.t (id integer);"],
    ["ALTER", "alter table public.users owner to anon;"],
    ["DROP", "drop table public.users;"],
    ["INSERT", "insert into public.users (id) values (null);"],
    ["UPDATE", "update public.users set role = 'admin';"],
    ["DELETE", "delete from public.users;"],
    ["TRUNCATE", "truncate public.users;"],
    ["additional GRANT", "grant select on table public.users to anon;"],
    ["additional REVOKE", "revoke select on table public.users from anon;"],
    ["VACUUM", "vacuum public.users;"],
    ["ANALYZE", "analyze public.users;"],
    ["LOCK", "lock table public.users;"],
    ["NOTIFY", "notify x;"],
    ["LISTEN", "listen x;"],
    ["DISCARD", "discard all;"],
    ["CHECKPOINT", "checkpoint;"],
    ["COMMENT ON", "comment on table public.users is 'x';"],
    ["SECURITY LABEL", "security label on table public.users is 'x';"],
    ["REFRESH", "refresh materialized view public.v;"],
    ["CLUSTER", "cluster public.users;"],
    ["REINDEX", "reindex table public.users;"],
    ["nested DO", "do 'begin end';"],
    ["CALL", "call public.f();"],
    ["EXECUTE", "execute 'select 1';"],
    ["PERFORM", "perform 1;"],
    ["RETURN", "return;"],
    ["NULL statement", "null;"],
    ["assignment", "v_public := 1;"],
    ["RAISE NOTICE", "raise notice 'x';"],
    ["IF on an unapproved condition", "if true then raise exception 'x'; end if;"],
    ["WHILE loop", "while not found loop raise exception 'x'; end loop;"],
    ["SELECT of an unapproved shape", "select 1 into v_public;"],
    ["SELECT of another table", "select count(*) into v_public from public.users;"],
    ["approved SELECT widened with OR", "select c.relrowsecurity into v_rls from pg_catalog.pg_class c where c.oid = 'public.users'::regclass or true;"],
    [
      "approved SELECT with a nested subquery",
      "select count(*) into v_public from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = 0 and exists (select 1 from public.users);",
    ],
    ["unbalanced END LOOP", "end loop;"],
    ["unclosed IF", "if not found then raise exception 'x';"],
  ];

  for (const [label, statement] of UNEXPECTED) {
    it(`rejects: ${label}`, () => {
      for (const block of ["preflight", "postflight"] as const) {
        expect(violations(inject(statement, block)).join(" | "), block).toMatch(/statement: /);
      }
    });
  }

  it("H (was an accepted control). an extra statement with an approved shape is rejected by the ordered contract", () => {
    const fixture = inject("if not found then raise exception 'x'; end if;");
    expect(bodyViolations(lexed(fixture).bodies[0])).toEqual([]);
    expect(violations(fixture)).toEqual([
      "contract: preflight has 31 statements, expected 29",
      "contract: preflight statement 29 is \"if not found then raise exception 'x'\"",
    ]);
  });
});

// ─── Remediation 3: function, cast and operator allow-lists ───────────────────

describe("PRICING-1 public.users hardening — function allow-list", () => {
  it("the real migration calls exactly the approved functions, casts and operators", () => {
    const distinct = (items: string[]) => items.filter((item, i) => items.indexOf(item) === i).sort();
    expect(distinct(functionCalls(code))).toEqual(ALLOWED_FUNCTIONS.slice().sort());
    expect(distinct(castTargets(code))).toEqual(ALLOWED_CASTS.slice().sort());
    expect(distinct(operators(code))).toEqual(ALLOWED_OPERATORS.slice().sort());
  });

  const UNEXPECTED: [string, string, RegExp][] = [
    ["set_config changing role", "select set_config('role', 'anon', true) into v_anon;", /function: set_config/],
    ["set_config changing search_path", "select pg_catalog.set_config('search_path', 'public', true) into v_anon;", /function: pg_catalog\.set_config/],
    ["arbitrary public function", "select public.handle_new_user() into v_anon;", /function: public\.handle_new_user/],
    ["unexpected schema-qualified function", "select pg_catalog.pg_sleep(1) into v_public;", /function: pg_catalog\.pg_sleep/],
    ["unexpected unqualified function", "select now() into v_anon;", /function: now/],
    ["call written with a space before (", "select pg_sleep (1) into v_public;", /function: pg_sleep/],
    [
      "shadowable unqualified catalog function",
      "select count(*) into v_public from pg_catalog.pg_class c, lateral aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = 0;",
      /function: aclexplode/,
    ],
    [
      "call nested in a permitted function's arguments",
      "if pg_catalog.has_table_privilege(public.evil(), 'public.users', 'INSERT') then raise exception 'x'; end if;",
      /function: public\.evil/,
    ],
    [
      "call nested inside an aggregate",
      "select count(pg_catalog.pg_read_file('x')) into v_public from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.users'::regclass and x.grantee = 0;",
      /function: pg_catalog\.pg_read_file/,
    ],
    ["call nested inside COALESCE", "select coalesce(pg_catalog.current_setting('role'), '') into v_anon;", /function: pg_catalog\.current_setting/],
    ["cast to an unapproved type", "if v_anon::public.t <> '' then raise exception 'x'; end if;", /cast: public/],
    ["unapproved operator", "if v_public @@ 0 then raise exception 'x'; end if;", /operator: @@/],
  ];

  for (const [label, statement, expected] of UNEXPECTED) {
    it(`rejects: ${label}`, () => {
      for (const block of ["preflight", "postflight"] as const) {
        expect(violations(inject(statement, block)).join(" | "), block).toMatch(expected);
      }
    });
  }
});

// ─── Remediation 4: exact ordered DO-body contracts ───────────────────────────

describe("PRICING-1 public.users hardening — ordered DO-body contracts", () => {
  const PRE6 = "  if v_public <> 0 then\n    raise exception 'PRICING1-HARDEN-PRE-6: PUBLIC holds a table privilege on public.users.';\n  end if;";
  const PRE7 = "  if v_columns <> 0 then\n    raise exception 'PRICING1-HARDEN-PRE-7: public.users carries column-level privileges.';\n  end if;";
  const aclReadSource = (relation: string, role: string, into: string) =>
    `  select coalesce(${GRANTABLE_ENTRY}, '')\n    into ${into}\n    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x\n   where c.oid = '${relation}'::regclass and x.grantee = '${role}'::regrole;\n`;

  /** The shape layer alone accepts the fixture, so only the ordered contract can be what rejects it. */
  const shapeAccepted = (fixture: string) => {
    for (const body of lexed(fixture).bodies) expect(bodyViolations(body), body.tag).toEqual([]);
  };
  const expectContract = (fixture: string, reason: RegExp, alsoCount = false) => {
    shapeAccepted(fixture);
    const found = violations(fixture);
    expect(found.every((v) => v.startsWith("contract: ")), JSON.stringify(found)).toBe(true);
    expect(found.join(" | ")).toMatch(reason);
    expect(found.some((v) => / has \d+ statements, expected /.test(v))).toBe(alsoCount);
  };

  it("contracts are hand-written with the expected counts and the real migration matches them exactly", () => {
    expect(PREFLIGHT_EXPECTED_STATEMENTS).toHaveLength(EXPECTED_STATEMENT_COUNTS.preflight);
    expect(POSTFLIGHT_EXPECTED_STATEMENTS).toHaveLength(EXPECTED_STATEMENT_COUNTS.postflight);
    expect(contractStatements(PREFLIGHT_EXPECTED_STATEMENTS)).toHaveLength(29);
    expect(contractStatements(POSTFLIGHT_EXPECTED_STATEMENTS)).toHaveLength(33);
    expect(real.bodies.map((b) => b.statements.length)).toEqual([29, 33]);
    for (const body of real.bodies) expect(contractViolations(body), body.tag).toEqual([]);
  });

  it("the contracts spell out every security literal, not placeholders", () => {
    const post = POSTFLIGHT_EXPECTED_STATEMENTS.join("\n");
    expect(post).toContain("pg_catalog.has_table_privilege(v_role, 'public.users', v_priv)");
    expect(post).toContain("array['anon', 'authenticated']");
    expect(post).toContain("where c.oid = 'public.users'::regclass\n");
    expect(post).toContain("where a.attrelid = 'public.users'::regclass");
    expect(PREFLIGHT_EXPECTED_STATEMENTS).toContain(PUBLIC_COUNT_STATEMENT);
    expect(POSTFLIGHT_EXPECTED_STATEMENTS).toContain(PUBLIC_COUNT_STATEMENT);
    expect(PUBLIC_COUNT_STATEMENT).toContain("'public.users'::regclass");
  });

  it("A. a second postflight ACL read overwriting v_anon from public.drills is rejected", () => {
    const fixture = mutateBlock(
      "postflight",
      "x.grantee = 'anon'::regrole;\n",
      "x.grantee = 'anon'::regrole;\n" + aclReadSource("public.drills", "anon", "v_anon"),
    );
    expectContract(fixture, /contract: postflight statement 13 is .*into v_anon .*'public\.drills'::regclass/, true);
  });

  it("B. a preflight read overwriting v_authenticated with the anon result is rejected", () => {
    const fixture = mutateBlock(
      "preflight",
      "x.grantee = 'authenticated'::regrole;\n",
      "x.grantee = 'authenticated'::regrole;\n" + aclReadSource("public.users", "anon", "v_authenticated"),
    );
    expectContract(fixture, /contract: preflight statement 14 is .*into v_authenticated .*'anon'::regrole/, true);
  });

  it("C. the POST-7 relation cannot change", () => {
    const fixture = mutateBlock(
      "postflight",
      "has_table_privilege(v_role, 'public.users', v_priv)",
      "has_table_privilege(v_role, 'public.drills', v_priv)",
    );
    expectContract(fixture, /contract: postflight statement 27 is .*'public\.drills', v_priv/);
  });

  it("D. the postflight role array cannot be duplicated, reordered or shortened", () => {
    for (const roles of ["array['anon', 'anon']", "array['authenticated', 'anon']", "array['anon']", "array['anon', 'authenticated', 'anon']"]) {
      const fixture = mutateBlock("postflight", "array['anon', 'authenticated']", roles);
      expectContract(fixture, /contract: postflight statement 27 is /);
    }
  });

  it("E. the PUBLIC-count relation cannot change in either block", () => {
    for (const block of ["preflight", "postflight"] as const) {
      const fixture = mutateBlock(
        block,
        "c.oid = 'public.users'::regclass and x.grantee = 0;",
        "c.oid = 'public.drills'::regclass and x.grantee = 0;",
      );
      expectContract(fixture, new RegExp(`contract: ${block} statement 15 is .*'public\\.drills'::regclass and x\\.grantee = 0`));
    }
  });

  it("F. the postflight column-ACL relation cannot change", () => {
    const fixture = mutateBlock("postflight", "a.attrelid = 'public.users'::regclass", "a.attrelid = 'public.drills'::regclass");
    expectContract(fixture, /contract: postflight statement 16 is .*a\.attrelid = 'public\.drills'/);
  });

  it("G. the postflight RLS re-read relation cannot change", () => {
    const fixture = mutateBlock("postflight", "c.oid = 'public.users'::regclass;", "c.oid = 'public.drills'::regclass;");
    expectContract(fixture, /contract: postflight statement 9 is .*relrowsecurity.*'public\.drills'/);
  });

  it("I. reordering two approved statements is rejected", () => {
    const fixture = mutateBlock("preflight", `${PRE6}\n\n${PRE7}`, `${PRE7}\n\n${PRE6}`);
    expectContract(fixture, /contract: preflight statement 23 is "if v_columns <> 0/);
  });

  it("J. removing a required statement is rejected", () => {
    const fixture = mutateBlock("preflight", `\n\n${PRE7}`, "");
    expectContract(fixture, /contract: preflight has 27 statements, expected 29/, true);
  });

  it("K. duplicating a required statement is rejected", () => {
    const fixture = mutateBlock("preflight", PRE7, `${PRE7}\n\n${PRE7}`);
    expectContract(fixture, /contract: preflight has 31 statements, expected 29/, true);
  });

  it("L. changing a protected literal while keeping the statement shape is rejected", () => {
    expectContract(mutateBlock("preflight", "c.relname = 'users'", "c.relname = 'drills'"), /contract: preflight statement 7 is /);
    expectContract(mutateBlock("postflight", "x.grantee = 'anon'::regrole", "x.grantee = 'ANON'::regrole"), /contract: postflight statement 12 is /);
    expectContract(mutateBlock("postflight", "if v_anon <> 'SELECT:false' then", "if v_anon <> 'SELECT:true' then"), /contract: postflight statement 17 is /);
    expectContract(
      mutateBlock("preflight", "has_table_privilege('authenticated', 'public.users', 'UPDATE')", "has_table_privilege('authenticated', 'public.users', 'SELECT')"),
      /contract: preflight statement 27 is /,
    );
  });

  it("M. changing an exception's diagnostic code is rejected, even with its message intact", () => {
    expectContract(mutateBlock("preflight", "'PRICING1-HARDEN-PRE-6: ", "'PRICING1-HARDEN-PRE-9: "), /contract: preflight statement 23 is /);
    expectContract(mutateBlock("preflight", "'PRICING1-HARDEN-PRE-6: ", "'PRICING1-HARDEN-PRE-7: "), /contract: preflight statement 23 is /);
    expectContract(mutateBlock("preflight", "'PRICING1-HARDEN-PRE-6: ", "'pricing1-harden-pre-6: "), /contract: preflight statement 23 is /);
    expectContract(mutateBlock("preflight", "'PRICING1-HARDEN-PRE-6: ", "'PRICING1-HARDEN-PRE-6 "), /contract: preflight statement 23 is /);
  });

  it("N. only the free message text after the code may change", () => {
    expect(violations(withMessage("PRE-6", "something else entirely."))).toEqual([]);
    expect(violations(withMessage("PRE-7", ""))).toEqual([]);
  });

  it("N-guard. the message wildcard is one literal and cannot absorb a statement", () => {
    const fixture = withMessage("PRE-6", "x'; grant select on table public.users to anon; select 'y");
    expectRejected(fixture, /privilege: .*grant select on table public\.users to anon;/);
    expectRejected(fixture, /contract: preflight/);
  });

  it("O. an otherwise valid statement before a required ACL read is rejected", () => {
    const fixture = mutateBlock(
      "preflight",
      "PRE-2: row level security must be enabled on public.users.';\n  end if;\n",
      "PRE-2: row level security must be enabled on public.users.';\n  end if;\n\n  if not found then\n    raise exception 'PRICING1-HARDEN-PRE-1: x';\n  end if;\n",
    );
    expectContract(fixture, /contract: preflight statement 12 is "if not found then/, true);
  });

  it("P. an otherwise valid statement between an ACL read and its comparison is rejected", () => {
    const fixture = mutateBlock(
      "postflight",
      "not a.attisdropped;\n",
      "not a.attisdropped;\n\n  select c.relrowsecurity\n    into v_rls\n    from pg_catalog.pg_class c\n   where c.oid = 'public.users'::regclass;\n",
    );
    expectContract(fixture, /contract: postflight statement 17 is "select c\.relrowsecurity/, true);
  });

  it("Q. an otherwise valid statement after the final check and before END is rejected", () => {
    const fixture = inject("if not v_rls then raise exception 'PRICING1-HARDEN-POST-1: x'; end if;", "postflight");
    expectContract(fixture, /contract: postflight statement 33 is "if not v_rls then/, true);
  });
});

// ─── Remediation 4: cast targets with any spacing ─────────────────────────────

describe("PRICING-1 public.users hardening — spaced casts", () => {
  it("canonical casts are classified, with or without spaces", () => {
    expect(castTargets("''::regclass and x :: regrole")).toEqual(["regclass", "regrole"]);
    expect(castTargets("x :: (text)")).toEqual(["<unclassified>"]);
  });

  const CASTS: [string, string, RegExp][] = [
    ["unexpected cast with spaces", "if v_anon :: public.t <> '' then raise exception 'x'; end if;", /cast: public\.t/],
    ["schema-qualified cast target", "if v_anon::public.t <> '' then raise exception 'x'; end if;", /cast: public\.t/],
    ["mixed whitespace", "if v_anon ::\t  text <> '' then raise exception 'x'; end if;", /cast: text/],
    ["unclassifiable cast target", "if v_anon :: (text) <> '' then raise exception 'x'; end if;", /cast: <unclassified>/],
  ];

  for (const [label, statement, expected] of CASTS) {
    it(`rejects: ${label}`, () => {
      for (const block of ["preflight", "postflight"] as const) {
        expect(violations(inject(statement, block)).join(" | "), block).toMatch(expected);
      }
    });
  }

  it("rejects an unexpected cast inside an otherwise approved expression", () => {
    expectRejected(mutateBlock("preflight", "c.relkind = 'r'", "c.relkind = 'r' :: text"), /cast: text/);
  });
});

// ─── Grant-option-aware preflight ─────────────────────────────────────────────

describe("PRICING-1 public.users hardening — grant-option-aware preflight", () => {
  it("fails closed with numbered exceptions before the revoke", () => {
    for (let n = 1; n <= 8; n++) indexOfRequired(preflight, `raise exception 'pricing1-harden-pre-${n}:`);
  });

  it("16. requires public.users to exist with RLS enabled", () => {
    indexOfRequired(preflight, "where n.nspname = 'public' and c.relname = 'users' and c.relkind = 'r';");
    indexOfRequired(preflight, "if not found then raise exception 'pricing1-harden-pre-1:");
    indexOfRequired(preflight, "if not v_rls then raise exception 'pricing1-harden-pre-2:");
  });

  it("30. reads each exact set as PRIVILEGE:grantable from aclexplode, so MAINTAIN and grant options cannot be omitted", () => {
    for (const role of ["anon", "authenticated", "service_role"]) indexOfRequired(preflight, aclRead(role));
    expect(preflight.match(/x\.is_grantable/g)).toHaveLength(6);
    expect(text).not.toContain("information_schema");
  });

  it("11. anon exact: DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false", () => {
    indexOfRequired(preflight, `if v_anon <> '${BROWSER_BEFORE}' then raise exception 'pricing1-harden-pre-3:`);
  });

  it("12. authenticated exact: the same six, all non-grantable", () => {
    indexOfRequired(preflight, `if v_authenticated <> '${BROWSER_BEFORE}' then raise exception 'pricing1-harden-pre-4:`);
  });

  it("13. service_role exact: eight privileges, all non-grantable", () => {
    indexOfRequired(preflight, `if v_service <> '${SERVICE_ROLE}' then raise exception 'pricing1-harden-pre-5:`);
  });

  it("14/15. PUBLIC holds nothing and there are no column-level privileges", () => {
    indexOfRequired(preflight, "if v_public <> 0 then raise exception 'pricing1-harden-pre-6:");
    indexOfRequired(
      preflight,
      "from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x where a.attrelid = 'public.users'::regclass and a.attnum > 0 and not a.attisdropped;",
    );
    indexOfRequired(preflight, "if v_columns <> 0 then raise exception 'pricing1-harden-pre-7:");
  });

  it("H. neither browser role can insert or update", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["insert", "update"]) {
        indexOfRequired(preflight, `pg_catalog.has_table_privilege('${role}', 'public.users', '${priv}')`);
      }
    }
  });
});

// ─── Grant-option-aware postflight ────────────────────────────────────────────

describe("PRICING-1 public.users hardening — grant-option-aware postflight", () => {
  it("fails closed with numbered exceptions after the revoke", () => {
    for (let n = 1; n <= 8; n++) indexOfRequired(postflight, `raise exception 'pricing1-harden-post-${n}:`);
  });

  it("re-reads every exact set as PRIVILEGE:grantable from aclexplode", () => {
    for (const role of ["anon", "authenticated", "service_role"]) indexOfRequired(postflight, aclRead(role));
    expect(postflight.match(/x\.is_grantable/g)).toHaveLength(6);
  });

  it("17/18. anon and authenticated end with exactly SELECT:false (a SELECT grant option fails)", () => {
    indexOfRequired(postflight, `if v_anon <> '${BROWSER_AFTER}' then raise exception 'pricing1-harden-post-2:`);
    indexOfRequired(postflight, `if v_authenticated <> '${BROWSER_AFTER}' then raise exception 'pricing1-harden-post-3:`);
  });

  it("19. service_role keeps exactly its eight non-grantable privileges", () => {
    indexOfRequired(postflight, `if v_service <> '${SERVICE_ROLE}' then raise exception 'pricing1-harden-post-4:`);
  });

  it("20. PUBLIC none, no column-level privileges, RLS still enabled", () => {
    indexOfRequired(postflight, "if v_public <> 0 then raise exception 'pricing1-harden-post-5:");
    indexOfRequired(postflight, "if v_columns <> 0 then raise exception 'pricing1-harden-post-6:");
    indexOfRequired(postflight, "if not v_rls then raise exception 'pricing1-harden-post-1:");
  });

  it("browser roles hold none of the removed or never-held privileges and keep SELECT", () => {
    indexOfRequired(
      postflight,
      "foreach v_priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain'] loop",
    );
    indexOfRequired(postflight, "if not pg_catalog.has_table_privilege(v_role, 'public.users', 'select') then");
  });

  it("GRANT_OPTION_DRIFT_FAILS_CLOSED: every expected set pins grant options to false", () => {
    for (const expected of [BROWSER_BEFORE, SERVICE_ROLE, BROWSER_AFTER]) {
      for (const entry of expected.split(",")) expect(entry).toMatch(/^[a-z]+:false$/);
    }
    expect(text).not.toMatch(/:true'/);
  });
});
