/**
 * PI-0 — Practice Intelligence foundation: migration source contract.
 *
 * Proves what the checked-in migration SAYS: four owner-scoped tables, their
 * constraints, SELECT-only browser access behind one owner policy each, and
 * two SECURITY INVOKER write functions executable only by service_role.
 *
 * This suite reads the migration text only. It connects to no database, needs
 * no credentials and writes nothing, and it cannot prove the migration has
 * been applied anywhere — that belongs to a separate, separately authorized
 * gate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME,
  SEC_COACH1_WRITE_AUTHORITY_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const SUFFIX = "_pi0_practice_intelligence_foundation.sql";
const FILENAME = PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME;
const RAW = readFileSync(path.join(MIGRATIONS_DIR, FILENAME), "utf8");

const TABLES = [
  "practice_plans",
  "practice_plan_items",
  "practice_sessions",
  "practice_session_results",
] as const;

const CREATE_PLAN_SIGNATURE = "public.pi_create_practice_plan(uuid, uuid, text, text, text, jsonb)";
const RECORD_RESULT_SIGNATURE =
  "public.pi_record_practice_result(uuid, uuid, uuid, text, uuid, uuid, integer, integer, smallint, text)";

// ── Parsing ───────────────────────────────────────────────────────────────────

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

interface Parsed {
  /** Top-level statements, collapsed, with dollar-quoted bodies as `$<tag>$`. */
  readonly statements: string[];
  /** Dollar-quoted bodies (DO blocks and function bodies) keyed by tag. */
  readonly bodies: Record<string, string>;
  /** All executable SQL, comments removed, collapsed. */
  readonly executable: string;
}

function parse(raw: string): Parsed {
  const code = raw.replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
  const bodies: Record<string, string> = {};
  const dollar = /\$(\w+)\$([\s\S]*?)\$\1\$/g;
  let flattened = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = dollar.exec(code)) !== null) {
    flattened += code.slice(cursor, match.index) + `$${match[1]}$`;
    bodies[match[1].toLowerCase()] = collapse(match[2]);
    cursor = match.index + match[0].length;
  }
  flattened += code.slice(cursor);
  const statements = flattened
    .split(";")
    .map(collapse)
    .filter((s) => s.length > 0);
  return { statements, bodies, executable: collapse(code) };
}

/** String literals blanked, so words inside messages cannot satisfy or fail a check. */
function withoutLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "''");
}

const P = parse(RAW);
const TOP = P.statements;
const PRE = P.bodies.preflight ?? "";
const POST = P.bodies.postflight ?? "";
const CREATE_PLAN = P.bodies.create_plan ?? "";
const RECORD_RESULT = P.bodies.record_result ?? "";

function createTable(table: string): string {
  const stmt = TOP.find((s) => s.startsWith(`create table public.${table} (`));
  expect(stmt, `create table public.${table}`).toBeDefined();
  return stmt as string;
}

// ── A. Identity and inventory ─────────────────────────────────────────────────

describe("PI-0 migration — identity and inventory", () => {
  it("carries the CLI-generated filename", () => {
    expect(FILENAME).toBe("20260930125813_pi0_practice_intelligence_foundation.sql");
    expect(FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("exists on disk exactly once and is registered exactly once", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(SUFFIX))).toEqual([FILENAME]);
    expect(APPROVED_MIGRATIONS.filter((m) => m === FILENAME)).toHaveLength(1);
  });

  it("was authored after all 37 predecessors, SEC-COACH1 last among them", () => {
    const earlier = migrationsAuthoredBefore(FILENAME);
    expect(earlier).toHaveLength(37);
    expect(earlier[earlier.length - 1]).toBe(SEC_COACH1_WRITE_AUTHORITY_FILENAME);
    expect(sortsAfterAll(FILENAME, earlier)).toBe(true);
    expect(APPROVED_MIGRATIONS.indexOf(FILENAME)).toBe(37);
  });

  it("leaves the closed-world inventory derived from the approved list", () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });
});

// ── B. Shape ──────────────────────────────────────────────────────────────────

describe("PI-0 migration — transaction and ordering", () => {
  it("is one transaction: begin first, commit last", () => {
    expect(TOP[0]).toBe("begin");
    expect(TOP[TOP.length - 1]).toBe("commit");
    expect(TOP.filter((s) => s === "begin" || s === "commit")).toHaveLength(2);
  });

  it("runs the preflight before creating anything and the postflight after everything", () => {
    expect(TOP[1]).toBe("do $preflight$");
    expect(TOP[TOP.length - 2]).toBe("do $postflight$");
    expect(TOP.filter((s) => s.startsWith("do "))).toEqual(["do $preflight$", "do $postflight$"]);
  });

  it("preflight refuses a pre-existing practice table or pi_ function and requires drills", () => {
    for (const table of TABLES) expect(PRE).toContain(`'${table}'`);
    expect(PRE).toContain("p.proname like 'pi\\_%'");
    expect(PRE).toContain("'public.drills'::regclass");
    for (const n of [1, 2, 3, 4]) expect(PRE).toContain(`raise exception 'pi0-pre-${n}:`);
  });
});

// ── C. Tables ─────────────────────────────────────────────────────────────────

describe("PI-0 migration — tables", () => {
  it("creates exactly the four practice tables and nothing else", () => {
    const created = TOP.filter((s) => s.startsWith("create table")).map((s) => s.split(" ")[2]);
    expect(created).toEqual(TABLES.map((t) => `public.${t}`));
  });

  it("practice_plans: golfer origin only, bounded text, consistent archive state, idempotency", () => {
    const t = createTable("practice_plans");
    for (const piece of [
      "id uuid not null default gen_random_uuid()",
      "user_id uuid not null references auth.users(id) on delete cascade",
      "title text not null",
      "focus text,",
      "origin text not null default 'golfer'",
      "status text not null default 'active'",
      "archived_at timestamptz,",
      "idempotency_key uuid not null",
      "request_fingerprint text not null",
      "created_at timestamptz not null default now()",
      "updated_at timestamptz not null default now()",
      "check (pg_catalog.length(pg_catalog.btrim(title)) between 1 and 120)",
      "check (focus is null or pg_catalog.length(focus) <= 500)",
      "check (origin = 'golfer')",
      "check (status in ('active', 'archived'))",
      "check ((status = 'archived') = (archived_at is not null))",
      "check (request_fingerprint ~ '^[0-9a-f]{64}$')",
      "unique (user_id, idempotency_key)",
      "unique (id, user_id)",
    ]) {
      expect(t, piece).toContain(piece);
    }
    expect(TOP).toContain(
      "create index practice_plans_user_status_created_idx on public.practice_plans (user_id, status, created_at desc)",
    );
  });

  it("practice_plan_items: owner-consistent plan FK, canonical drill, bounded targets, no status or percent", () => {
    const t = createTable("practice_plan_items");
    for (const piece of [
      "plan_id uuid not null",
      "user_id uuid not null",
      "drill_id uuid not null references public.drills(id) on delete restrict",
      "position integer not null",
      "foreign key (plan_id, user_id) references public.practice_plans (id, user_id) on delete cascade",
      "check (position >= 1)",
      "check (target_reps is null or target_reps between 1 and 500)",
      "check (target_note is null or pg_catalog.length(target_note) <= 500)",
      "unique (plan_id, position)",
      "unique (id, user_id)",
      "unique (id, plan_id)",
      "unique (id, drill_id)",
    ]) {
      expect(t, piece).toContain(piece);
    }
    expect(t).not.toMatch(/\bstatus\b/);
    expect(TOP).toContain("create index practice_plan_items_drill_idx on public.practice_plan_items (drill_id)");
  });

  it("practice_sessions: consistent end state, owner-consistent plan FK, one in progress per golfer", () => {
    const t = createTable("practice_sessions");
    for (const piece of [
      "user_id uuid not null references auth.users(id) on delete cascade",
      "plan_id uuid,",
      "status text not null default 'in_progress'",
      "started_at timestamptz not null default now()",
      "ended_at timestamptz,",
      "foreign key (plan_id, user_id) references public.practice_plans (id, user_id) on delete restrict",
      "check (status in ('in_progress', 'completed', 'abandoned'))",
      "check ((status = 'in_progress') = (ended_at is null))",
      "check (ended_at is null or ended_at >= started_at)",
      "check (notes is null or pg_catalog.length(notes) <= 1000)",
      "unique (user_id, idempotency_key)",
      "unique (id, user_id)",
      "unique (id, plan_id)",
    ]) {
      expect(t, piece).toContain(piece);
    }
    expect(TOP).toContain(
      "create unique index practice_sessions_one_in_progress_idx on public.practice_sessions (user_id) where status = 'in_progress'",
    );
  });

  it("practice_session_results: user-entered only, bounded, provenance-consistent FKs", () => {
    const t = createTable("practice_session_results");
    for (const piece of [
      "user_id uuid not null references auth.users(id) on delete cascade",
      "session_id uuid not null",
      "plan_id uuid,",
      "plan_item_id uuid,",
      "drill_id uuid not null references public.drills(id) on delete restrict",
      "evidence_type text not null default 'user_entered'",
      "check (evidence_type = 'user_entered')",
      "check (attempts is null or attempts between 0 and 1000)",
      "check (successes is null or (successes >= 0 and (attempts is null or successes <= attempts)))",
      "check (self_rating is null or self_rating between 1 and 5)",
      "check (note is null or pg_catalog.length(note) <= 1000)",
      "check (attempts is not null or self_rating is not null or note is not null)",
      "check (plan_item_id is null or plan_id is not null)",
      "recorded_at timestamptz not null default now()",
      "foreign key (session_id, user_id) references public.practice_sessions (id, user_id) on delete cascade",
      "foreign key (session_id, plan_id) references public.practice_sessions (id, plan_id)",
      "foreign key (plan_item_id, plan_id) references public.practice_plan_items (id, plan_id)",
      "foreign key (plan_item_id, drill_id) references public.practice_plan_items (id, drill_id)",
      "unique (user_id, idempotency_key)",
    ]) {
      expect(t, piece).toContain(piece);
    }
    expect(TOP).toContain(
      "create index practice_session_results_session_idx on public.practice_session_results (session_id)",
    );
    expect(TOP).toContain(
      "create index practice_session_results_user_drill_recorded_idx on public.practice_session_results (user_id, drill_id, recorded_at desc)",
    );
  });

  it("stores no derived percentage, score or rate anywhere", () => {
    for (const table of TABLES) {
      expect(createTable(table)).not.toMatch(/percent|pct|\bscore\b|\brate\b|ratio/);
    }
  });

  it("every practice table carries user_id NOT NULL", () => {
    for (const table of TABLES) {
      expect(createTable(table)).toMatch(/\buser_id uuid not null\b/);
    }
  });
});

// ── D. Browser authority ──────────────────────────────────────────────────────

describe("PI-0 migration — RLS, policies and grants", () => {
  it("enables RLS on all four tables", () => {
    for (const table of TABLES) {
      expect(TOP).toContain(`alter table public.${table} enable row level security`);
    }
    expect(TOP.filter((s) => s.startsWith("alter table"))).toHaveLength(4);
  });

  it("creates exactly one owner-bound SELECT policy per table, for authenticated only", () => {
    const policies = TOP.filter((s) => s.startsWith("create policy"));
    expect(policies).toEqual(
      TABLES.map(
        (t) =>
          `create policy "${t}_owner_select" on public.${t} for select to authenticated using ((select auth.uid()) = user_id)`,
      ),
    );
  });

  it("never uses auth.role(), user metadata, a public policy or a write policy", () => {
    expect(P.executable).not.toContain("auth.role()");
    expect(P.executable).not.toMatch(/user_metadata|raw_user_meta_data|app_metadata/);
    expect(P.executable).not.toMatch(/using \(true\)|with check \(true\)/);
    expect(TOP.some((s) => s.startsWith("create policy") && /\bfor (all|insert|update|delete)\b/.test(s))).toBe(false);
    expect(TOP.some((s) => /^(alter|drop) policy/.test(s))).toBe(false);
  });

  it("states every table privilege explicitly: anon none, authenticated SELECT, service_role DML", () => {
    const expected: string[] = [];
    for (const t of TABLES) expected.push(`revoke all on table public.${t} from anon`);
    for (const t of TABLES) expected.push(`revoke all on table public.${t} from authenticated`);
    for (const t of TABLES) expected.push(`grant select on table public.${t} to authenticated`);
    for (const t of TABLES) expected.push(`grant select, insert, update, delete on table public.${t} to service_role`);
    const tableGrants = TOP.filter((s) => /^(grant|revoke) .* on table /.test(s));
    expect(tableGrants).toEqual(expected);
  });

  it("revokes before it grants, and grants no column privilege", () => {
    const lastRevoke = Math.max(...TOP.map((s, i) => (s.startsWith("revoke all on table") ? i : -1)));
    const firstGrant = TOP.findIndex((s) => s.startsWith("grant select on table"));
    expect(lastRevoke).toBeLessThan(firstGrant);
    expect(TOP.some((s) => /^grant [a-z, ]+\(/.test(s))).toBe(false);
  });
});

// ── E. Functions ──────────────────────────────────────────────────────────────

describe("PI-0 migration — write functions", () => {
  it("creates exactly two functions, both pi_-prefixed", () => {
    const fns = TOP.filter((s) => /^create (or replace )?function/.test(s));
    expect(fns).toHaveLength(2);
    expect(fns[0]).toMatch(/^create function public\.pi_create_practice_plan\(/);
    expect(fns[1]).toMatch(/^create function public\.pi_record_practice_result\(/);
  });

  it("both are SECURITY INVOKER plpgsql with an empty search_path", () => {
    for (const fn of TOP.filter((s) => s.startsWith("create function"))) {
      expect(fn).toContain("language plpgsql security invoker set search_path = ''");
    }
    expect(P.executable).not.toContain("security definer");
  });

  it("EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role only", () => {
    const fnGrants = TOP.filter((s) => / on function /.test(s));
    expect(fnGrants).toEqual([
      `revoke execute on function ${CREATE_PLAN_SIGNATURE} from public, anon, authenticated`,
      `revoke execute on function ${RECORD_RESULT_SIGNATURE} from public, anon, authenticated`,
      `grant execute on function ${CREATE_PLAN_SIGNATURE} to service_role`,
      `grant execute on function ${RECORD_RESULT_SIGNATURE} to service_role`,
    ]);
    const lastCreate = TOP.map((s) => s.startsWith("create function")).lastIndexOf(true);
    expect(TOP.findIndex((s) => / on function /.test(s))).toBeGreaterThan(lastCreate);
  });

  it("the function signatures take the owner as p_user_id and no role or claim", () => {
    const fns = TOP.filter((s) => s.startsWith("create function"));
    expect(fns[0]).toContain(
      "public.pi_create_practice_plan( p_user_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_title text, p_focus text, p_items jsonb ) returns jsonb",
    );
    expect(fns[1]).toContain(
      "public.pi_record_practice_result( p_user_id uuid, p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_plan_item_id uuid, p_drill_id uuid, p_attempts integer, p_successes integer, p_self_rating smallint, p_note text ) returns jsonb",
    );
    expect(fns[1]).not.toContain("p_plan_id");
  });

  it("every relation a function touches is schema-qualified", () => {
    for (const body of [CREATE_PLAN, RECORD_RESULT]) {
      const code = withoutLiterals(body);
      const refs: string[] = [];
      const re = /\b(?:from|join|update|insert into)\s+([a-z_][a-z0-9_.]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) refs.push(m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref, `unqualified relation ${ref}`).toMatch(/^(public|pg_catalog)\./);
      }
      expect(code).not.toMatch(/\bauth\./);
    }
  });

  it("plan creation is bound to p_user_id, bounded to 1..20 items, idempotent, and checks drills before writing", () => {
    const code = withoutLiterals(CREATE_PLAN);
    expect(code).toContain("if v_item_count < 1 or v_item_count > 20 then");
    expect(code).toContain("where pp.user_id = p_user_id and pp.idempotency_key = p_idempotency_key");
    expect(code).toContain("on conflict (user_id, idempotency_key) do nothing");
    expect(code).toContain("select v_plan_id, p_user_id,");
    expect(code).toContain("values (p_user_id, p_title, p_focus, p_idempotency_key, p_request_fingerprint)");
    const lookup = code.indexOf("from public.practice_plans pp");
    const drillCheck = code.indexOf("from public.drills d");
    const firstInsert = code.indexOf("insert into public.practice_plans");
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(drillCheck);
    expect(drillCheck).toBeLessThan(firstInsert);
    for (const outcome of ["created", "replayed", "idempotency_conflict", "drill_not_found"]) {
      expect(CREATE_PLAN).toContain(`'outcome', '${outcome}'`);
    }
  });

  it("result recording locks the owned in-progress session and derives plan_id from it", () => {
    const code = withoutLiterals(RECORD_RESULT);
    expect(code).toContain(
      "from public.practice_sessions s where s.id = p_session_id and s.user_id = p_user_id for update",
    );
    expect(RECORD_RESULT).toContain("if v_session_status <> 'in_progress' then");
    expect(code).toContain("i.plan_id = v_session_plan_id and i.user_id = p_user_id and i.drill_id = p_drill_id");
    expect(code).toContain("p_user_id, p_session_id, v_session_plan_id, p_plan_item_id, p_drill_id");
    expect(code).toContain("on conflict (user_id, idempotency_key) do nothing");
    const lock = code.indexOf("for update");
    const insert = code.indexOf("insert into public.practice_session_results");
    expect(lock).toBeLessThan(insert);
    for (const outcome of [
      "created",
      "replayed",
      "idempotency_conflict",
      "session_not_found",
      "session_not_active",
      "drill_not_found",
      "plan_item_invalid",
    ]) {
      expect(RECORD_RESULT).toContain(`'outcome', '${outcome}'`);
    }
  });

  it("neither function updates or deletes anything", () => {
    for (const body of [CREATE_PLAN, RECORD_RESULT]) {
      const code = withoutLiterals(body);
      expect(code).not.toMatch(/\bupdate public\./);
      expect(code).not.toMatch(/\bdelete from\b/);
      expect(code).not.toMatch(/\btruncate\b/);
    }
  });
});

// ── F. Postflight ─────────────────────────────────────────────────────────────

describe("PI-0 migration — postflight proofs", () => {
  it("proves RLS, browser privileges and service_role DML for each table", () => {
    for (const piece of [
      "c.relrowsecurity",
      "pg_catalog.has_table_privilege('anon', target, priv)",
      "pg_catalog.has_any_column_privilege('anon', target, priv)",
      "pg_catalog.has_table_privilege('authenticated', target, 'select')",
      "pg_catalog.has_table_privilege('authenticated', target, priv)",
      "pg_catalog.has_any_column_privilege('authenticated', target, priv)",
      "pg_catalog.has_table_privilege('service_role', target, priv)",
      "array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']",
      "array['insert', 'update', 'delete', 'truncate', 'references', 'trigger']",
    ]) {
      expect(POST, piece).toContain(piece);
    }
  });

  it("proves exactly one owner-bound SELECT policy per table and no column grants", () => {
    expect(POST).toContain("p.polcmd = 'r'");
    expect(POST).toContain("p.polroles = array['authenticated'::regrole::oid]");
    expect(POST).toContain("pg_catalog.aclexplode(a.attacl)");
  });

  it("proves the function boundary: two functions, invoker, empty search_path, no browser or PUBLIC execute", () => {
    for (const piece of [
      "p.proname like 'pi\\_%'",
      "p.prosecdef or p.proconfig is distinct from array['search_path=\"\"']::text[]",
      "pg_catalog.has_function_privilege('anon', fn, 'execute')",
      "pg_catalog.has_function_privilege('authenticated', fn, 'execute')",
      "x.grantee = 0",
      "pg_catalog.has_function_privilege('service_role', fn, 'execute')",
    ]) {
      expect(POST, piece).toContain(piece);
    }
    for (let n = 1; n <= 14; n += 1) expect(POST).toContain(`'pi0-post-${n}:`);
  });
});

// ── G. Scope ──────────────────────────────────────────────────────────────────

describe("PI-0 migration — scope", () => {
  it("touches no existing relation except as a foreign-key target", () => {
    const allowed = new Set([...TABLES.map((t) => `public.${t}`), "public.drills", "public.pi_create_practice_plan", "public.pi_record_practice_result"]);
    const referenced = new Set(withoutLiterals(TOP.join(" ; ")).match(/public\.[a-z_]+/g) ?? []);
    referenced.forEach((ref) => expect(allowed.has(ref), `unexpected relation ${ref}`).toBe(true));
    expect(TOP.filter((s) => s.includes("public.drills")).every((s) => s.startsWith("create table"))).toBe(true);
  });

  it("drops nothing, adds no trigger and manipulates no row outside the functions", () => {
    for (const s of TOP) {
      expect(s).not.toMatch(/^drop /);
      expect(s).not.toMatch(/^create (or replace )?trigger/);
      expect(s).not.toMatch(/^(insert|update|delete|merge|truncate) /);
      expect(s).not.toMatch(/^alter (function|role|default privileges)/);
    }
  });
});
