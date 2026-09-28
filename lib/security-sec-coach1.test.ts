/**
 * SEC-COACH1 — coach write authority closure: migration source contract.
 *
 * Five coach-to-golfer tables let any signed-in user write rows naming
 * themselves as coach of any golfer (table-level INSERT/UPDATE/DELETE for the
 * browser roles plus catch-all FOR ALL policies checking only
 * auth.uid() = coach_id). The migration revokes browser DML on exactly those
 * five tables and downgrades each catch-all policy to SELECT-only, keeping its
 * name and coach-ownership predicate.
 *
 * This suite reads the migration text only. It connects to no database, needs
 * no credentials and writes nothing. The migration is read through its
 * canonical inventory constant; an independent suffix check guards against a
 * second file of the same name.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_MIGRATIONS,
  ENTITLEMENT_WRITE_AUTHORITY_FILENAME,
  EXPECTED_MIGRATION_COUNT,
  SEC_COACH1_WRITE_AUTHORITY_FILENAME,
  migrationsAuthoredBefore,
} from "./migration-inventory";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const SUFFIX = "_sec_coach1_coach_write_authority.sql";

const MATCHES = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(SUFFIX));
const FILENAME = SEC_COACH1_WRITE_AUTHORITY_FILENAME;
const RAW = readFileSync(path.join(MIGRATIONS_DIR, FILENAME), "utf8");

const TARGETS = [
  "coach_student_relationships",
  "coach_golfer_relationships",
  "automated_prescriptions",
  "coach_feedback",
  "lesson_plans",
] as const;

/** Former catch-all coach policies: table → policy name. */
const DOWNGRADED: ReadonlyArray<readonly [string, string]> = [
  ["coach_student_relationships", "csr_coach_all"],
  ["automated_prescriptions", "ap_coach_all"],
  ["coach_feedback", "Coach can manage their feedback"],
  ["coach_golfer_relationships", "Coach can manage their relationships"],
  ["lesson_plans", "Coach can manage lesson plans"],
];

const PRESERVED_POLICIES = [
  "csr_student_select",
  "ap_student_select",
  "Golfer can view feedback on their swings",
  "Coach or golfer can view their relationships",
  "Golfer can update their own relationship status",
  "Golfer can view their lesson plans",
];

// ── Normalisation ─────────────────────────────────────────────────────────────

function stripComments(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

interface Parsed {
  /** Every executable statement in order; DO blocks appear as "do:<tag>". */
  readonly sequence: string[];
  /** Top-level (non-DO) statements, collapsed and lower-cased. */
  readonly topLevel: string[];
  /** DO block bodies keyed by dollar-quote tag, collapsed and lower-cased. */
  readonly doBlocks: Record<string, string>;
  /** All executable SQL (comments removed), collapsed and lower-cased. */
  readonly executable: string;
}

function parse(raw: string): Parsed {
  const code = stripComments(raw);
  const sequence: string[] = [];
  const topLevel: string[] = [];
  const doBlocks: Record<string, string> = {};
  const doRe = /do\s+\$(\w+)\$([\s\S]*?)\$\1\$\s*;/gi;
  let cursor = 0;
  const pushTop = (chunk: string) => {
    for (const stmt of chunk.split(";")) {
      const s = collapse(stmt);
      if (s) {
        sequence.push(s);
        topLevel.push(s);
      }
    }
  };
  for (const m of code.matchAll(doRe)) {
    pushTop(code.slice(cursor, m.index));
    doBlocks[m[1].toLowerCase()] = collapse(m[2]);
    sequence.push(`do:${m[1].toLowerCase()}`);
    cursor = (m.index ?? 0) + m[0].length;
  }
  pushTop(code.slice(cursor));
  return { sequence, topLevel, doBlocks, executable: collapse(code) };
}

const P = parse(RAW);

const revokeStmt = (t: string) => `revoke insert, update, delete on table public.${t} from anon, authenticated`;
const dropStmt = (t: string, name: string) => `drop policy "${name.toLowerCase()}" on public.${t}`;
const createStmt = (t: string, name: string) =>
  `create policy "${name.toLowerCase()}" on public.${t} for select using (auth.uid() = coach_id)`;

/** True when the migration closes browser DML on every target table. */
function closesAllWrites(p: Parsed): boolean {
  return TARGETS.every((t) => p.topLevel.includes(revokeStmt(t)));
}

/** True when every catch-all policy is dropped then recreated SELECT-only. */
function downgradesAllPolicies(p: Parsed): boolean {
  return DOWNGRADED.every(([t, name]) => {
    const d = p.topLevel.indexOf(dropStmt(t, name));
    const c = p.topLevel.indexOf(createStmt(t, name));
    return d !== -1 && c !== -1 && d < c;
  });
}

/** True when no create policy statement grants a write command. */
function noWritePolicy(p: Parsed): boolean {
  return !p.topLevel.some(
    (s) => s.startsWith("create policy") && /\bfor (all|insert|update|delete)\b/.test(s),
  );
}

// ── A. Identity ───────────────────────────────────────────────────────────────

describe("SEC-COACH1 — migration identity and inventory", () => {
  it("exactly one migration carries the SEC-COACH1 suffix, and it is the canonical file", () => {
    expect(MATCHES).toEqual([SEC_COACH1_WRITE_AUTHORITY_FILENAME]);
  });

  it("carries the CLI-generated filename", () => {
    expect(SEC_COACH1_WRITE_AUTHORITY_FILENAME).toBe("20260928124321_sec_coach1_coach_write_authority.sql");
    expect(FILENAME).toMatch(/^\d{14}_sec_coach1_coach_write_authority\.sql$/);
  });

  it("is registered in APPROVED_MIGRATIONS exactly once", () => {
    expect(APPROVED_MIGRATIONS.filter((m) => m === SEC_COACH1_WRITE_AUTHORITY_FILENAME)).toHaveLength(1);
  });

  it("holds its permanent historical position: 36 predecessors, index 36", () => {
    const earlier = migrationsAuthoredBefore(SEC_COACH1_WRITE_AUTHORITY_FILENAME);
    expect(earlier).toHaveLength(36);
    expect(earlier).toContain(ENTITLEMENT_WRITE_AUTHORITY_FILENAME);
    expect(APPROVED_MIGRATIONS.indexOf(SEC_COACH1_WRITE_AUTHORITY_FILENAME)).toBe(36);
  });

  it("leaves the closed-world inventory derived from the approved migration list", () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });
});

// ── H. Transaction and statement sequence ────────────────────────────────────

describe("SEC-COACH1 — transaction shape", () => {
  it("begins with BEGIN and ends with COMMIT", () => {
    expect(P.sequence[0]).toBe("begin");
    expect(P.sequence[P.sequence.length - 1]).toBe("commit");
  });

  it("runs preflight, then the closure, then postflight — nothing else", () => {
    const expected = [
      "begin",
      "do:preflight",
      ...TARGETS.map(revokeStmt),
      ...DOWNGRADED.flatMap(([t, name]) => [dropStmt(t, name), createStmt(t, name)]),
      "do:postflight",
      "commit",
    ];
    expect(P.sequence).toEqual(expected);
  });
});

// ── B. Write closure ──────────────────────────────────────────────────────────

describe("SEC-COACH1 — direct client write closure", () => {
  it("revokes INSERT, UPDATE and DELETE from anon and authenticated on all five tables", () => {
    expect(closesAllWrites(P)).toBe(true);
    expect(P.topLevel.filter((s) => s.startsWith("revoke"))).toHaveLength(5);
  });

  it("does not revoke SELECT", () => {
    for (const s of P.topLevel.filter((x) => x.startsWith("revoke"))) {
      expect(s).not.toMatch(/\bselect\b/);
      expect(s).not.toMatch(/\ball\b/);
    }
  });

  it("does not touch service_role privileges", () => {
    for (const s of P.topLevel) expect(s).not.toContain("service_role");
  });

  it("revokes nothing beyond INSERT, UPDATE and DELETE", () => {
    for (const s of P.topLevel.filter((x) => x.startsWith("revoke"))) {
      expect(s).not.toMatch(/\b(references|trigger|truncate)\b/);
    }
  });

  it("grants nothing back", () => {
    expect(P.topLevel.some((s) => /^grant\b/.test(s))).toBe(false);
    // DO blocks could only grant through dynamic SQL; neither block uses it.
    for (const block of Object.values(P.doBlocks)) expect(block).not.toMatch(/\bexecute\b/);
  });
});

// ── C. Column-bypass defence ──────────────────────────────────────────────────

describe("SEC-COACH1 — column-level bypass defence", () => {
  const pre = P.doBlocks.preflight ?? "";
  const post = P.doBlocks.postflight ?? "";

  it("preflight refuses explicit column-level DML grants to browser roles", () => {
    expect(pre).toContain("aclexplode(a.attacl)");
    expect(pre).toContain("privilege_type in ('insert', 'update', 'delete')");
    expect(pre).toContain("rolname in ('anon', 'authenticated')");
    expect(pre).toContain("sec-coach1-pre-5");
  });

  it("postflight proves no column-level INSERT or UPDATE for either browser role", () => {
    expect(post).toContain("has_any_column_privilege(browser_role, target, col_dml)");
    expect(post).toContain("foreach col_dml in array array['insert', 'update']");
    expect(post).toContain("foreach browser_role in array array['anon', 'authenticated']");
  });

  it("postflight proves no table-level INSERT, UPDATE or DELETE (DELETE has no column form)", () => {
    expect(post).toContain("has_table_privilege(browser_role, target, dml)");
    expect(post).toContain("foreach dml in array array['insert', 'update', 'delete']");
  });

  it("preflight and postflight each cover exactly the five target tables", () => {
    for (const block of [pre, post]) {
      for (const t of TARGETS) expect(block).toContain(`'public.${t}'`);
    }
  });

  it("postflight proves authenticated SELECT and full service_role authority remain", () => {
    expect(post).toContain("has_table_privilege('authenticated', target, 'select')");
    expect(post).toContain("has_table_privilege('service_role', target, dml)");
    expect(post).toContain("array['select', 'insert', 'update', 'delete']");
  });

  it("fails closed with stable identifiers", () => {
    for (let i = 1; i <= 6; i++) expect(pre).toContain(`sec-coach1-pre-${i}:`);
    for (let i = 1; i <= 7; i++) expect(post).toContain(`sec-coach1-post-${i}:`);
  });
});

// ── D. Policy downgrade ───────────────────────────────────────────────────────

describe("SEC-COACH1 — catch-all policy downgrade", () => {
  it("drops and recreates each catch-all policy SELECT-only with the coach predicate", () => {
    expect(downgradesAllPolicies(P)).toBe(true);
  });

  it("creates exactly five policies, none with a write command", () => {
    expect(P.topLevel.filter((s) => s.startsWith("create policy"))).toHaveLength(5);
    expect(noWritePolicy(P)).toBe(true);
  });

  it("preflight requires each catch-all policy to exist as FOR ALL", () => {
    const pre = P.doBlocks.preflight ?? "";
    for (const [t, name] of DOWNGRADED) {
      expect(pre).toContain(`tablename = '${t}' and policyname = '${name.toLowerCase()}' and cmd = 'all'`);
    }
  });

  it("postflight requires each to be SELECT with the original predicate and no write command", () => {
    const post = P.doBlocks.postflight ?? "";
    expect(post).toContain("cmd = 'select' and qual = '(auth.uid() = coach_id)'");
    expect(post).toContain("cmd <> 'select'");
    for (const [t, name] of DOWNGRADED) expect(post).toContain(`('${t}', '${name.toLowerCase()}')`);
  });
});

// ── E. Preserved policies ─────────────────────────────────────────────────────

describe("SEC-COACH1 — preserved golfer/student policies", () => {
  it("never drops, alters or recreates a preserved policy", () => {
    for (const name of PRESERVED_POLICIES) {
      for (const s of P.topLevel) expect(s).not.toContain(`"${name.toLowerCase()}"`);
    }
    expect(P.executable).not.toMatch(/\balter policy\b/);
  });

  it("postflight proves every preserved policy still exists with its command", () => {
    const post = P.doBlocks.postflight ?? "";
    for (const name of PRESERVED_POLICIES) expect(post).toContain(`'${name.toLowerCase()}'`);
    expect(post).toContain("'golfer can update their own relationship status', 'update'");
  });
});

// ── F / G / I. Excluded objects, no broadening, scope ─────────────────────────

describe("SEC-COACH1 — scope and no broadening", () => {
  it("does not reference launch_monitor_sessions or the invite-code function", () => {
    expect(P.executable).not.toContain("launch_monitor_sessions");
    expect(P.executable).not.toContain("link_student_to_coach");
  });

  it("adds no function, trigger, definer, column or row change", () => {
    const forbidden = [
      /\bsecurity definer\b/,
      /\bcreate (or replace )?function\b/,
      /\bcreate trigger\b/,
      /\balter table\b/,
      /\binsert into\b/,
      /\bupdate public\./,
      /\bdelete from\b/,
      /\btruncate\b/,
      /\bmerge into\b/,
      /\bcreate (unique )?index\b/,
      /\bcreate (type|view)\b/,
      /\bstorage\./,
      /\bauth\.(users|sessions|identities)\b/,
    ];
    for (const re of forbidden) expect(P.executable).not.toMatch(re);
  });

  it("references only the five target tables in the public schema", () => {
    const refs = new Set(Array.from(P.executable.matchAll(/\bpublic\.([a-z_]+)/g), (m) => m[1]));
    expect([...refs].sort()).toEqual([...TARGETS].sort());
  });
});

// ── Non-vacuity ───────────────────────────────────────────────────────────────

describe("SEC-COACH1 — predicates are not vacuous", () => {
  it("catches a missing revoke", () => {
    const mutated = parse(RAW.replace(/revoke insert, update, delete on table public\.lesson_plans[^;]*;/, ""));
    expect(closesAllWrites(mutated)).toBe(false);
  });

  it("catches a policy left FOR ALL", () => {
    const mutated = parse(
      RAW.replace(
        /create policy "ap_coach_all" on public\.automated_prescriptions\s+for select/,
        'create policy "ap_coach_all" on public.automated_prescriptions\n  for all',
      ),
    );
    expect(downgradesAllPolicies(mutated)).toBe(false);
    expect(noWritePolicy(mutated)).toBe(false);
  });
});
