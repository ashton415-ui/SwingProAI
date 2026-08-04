import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEC1F_RANGE_SESSIONS_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const MIGRATION_FILENAME = SEC1F_RANGE_SESSIONS_FILENAME;
const migrationPath = path.join(migrationsDir, MIGRATION_FILENAME);

/** Raw bytes, so byte-level checks (BOM, CR, trailing newline) see the file
 *  exactly as it sits on disk, before any normalization could hide a defect. */
const rawBuffer = readFileSync(migrationPath);
const rawText = rawBuffer.toString("utf8");

/** Normalized to LF, matching the convention used by the SEC1A–SEC1D contract
 *  tests. */
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
 *  names "Users can insert own range sessions" and "Users can view own range
 *  sessions" legitimately contain English words that also name SQL commands. */
const codeSansQuotedNames = code.replace(/"[^"]*"/g, '""').toLowerCase();

/** The single relation this migration may touch. */
const TARGET_RELATION = "public.range_sessions";

/** The two approved policies, in required order. */
const APPROVED_POLICIES = [
  {
    name: "Users can insert own range sessions",
    command: "insert",
    clause: "with check",
    predicate: "((select auth.uid()) = user_id)",
  },
  {
    name: "Users can view own range sessions",
    command: "select",
    clause: "using",
    predicate: "((select auth.uid()) = user_id)",
  },
];

/** The exact four executable statements, positionally. */
const EXPECTED_STATEMENTS = [
  "begin",
  'create policy "Users can insert own range sessions" on public.range_sessions as permissive for insert to authenticated with check ((select auth.uid()) = user_id)',
  'create policy "Users can view own range sessions" on public.range_sessions as permissive for select to authenticated using ((select auth.uid()) = user_id)',
  "commit",
];

const POLICY_RE =
  /^create policy "([^"]+)" on ([a-z_]+\.[a-z_]+) as (permissive|restrictive) for (insert|select|update|delete|all) to ([a-z_]+) (with check|using) (.+)$/;

interface ParsedPolicy {
  name: string;
  relation: string;
  permissive: string;
  command: string;
  role: string;
  clause: string;
  predicate: string;
  index: number;
}

const parsedPolicies: ParsedPolicy[] = [];
statements.forEach((stmt, index) => {
  const m = POLICY_RE.exec(stmt);
  if (m) {
    parsedPolicies.push({
      name: m[1],
      relation: m[2],
      permissive: m[3],
      command: m[4],
      role: m[5],
      clause: m[6],
      predicate: m[7],
      index,
    });
  }
});

// ── Application files under contract ────────────────────────────────────────
const actionsPath = path.join(repoRoot, "app", "(dashboard)", "range", "actions.ts");
const telemetryPath = path.join(repoRoot, "app", "(dashboard)", "telemetry", "page.tsx");
const actionsSrc = readFileSync(actionsPath, "utf8");
const telemetrySrc = readFileSync(telemetryPath, "utf8");

/** The object literal passed to `.from("range_sessions").insert({...})`. */
const insertPayload = (() => {
  const m = /\.from\("range_sessions"\)\s*\.insert\(\{([\s\S]*?)\}\)/.exec(actionsSrc);
  return m ? m[1] : null;
})();

/** The `exercise_data` object literal built in the save action. */
const exerciseDataLiteral = (() => {
  const m = /const exerciseData = \{([\s\S]*?)\};/.exec(actionsSrc);
  return m ? m[1] : null;
})();

/** The range_sessions query chain in the telemetry page. */
const telemetryQuery = (() => {
  const m = /\.from\("range_sessions"\)([\s\S]*?)\.limit\(50\)/.exec(telemetrySrc);
  return m ? m[1] : null;
})();

/** The four columns that do not exist on the canonical table. */
const NONEXISTENT_COLUMNS = [
  "shots_total",
  "shots_executed",
  "completion_rate",
  "created_at",
];

// ============================================================================
// 1. Migration file byte hygiene
// ============================================================================
describe("SEC1F — migration file byte hygiene", () => {
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

  it("carries a 14-digit timestamp prefix matching the Supabase CLI format", () => {
    expect(MIGRATION_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

// ============================================================================
// 2. Exhaustive positional executable-statement allowlist
// ============================================================================
describe("SEC1F — exhaustive executable-statement allowlist", () => {
  it("contains exactly four executable statements", () => {
    expect(statements.length).toBe(4);
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
// 3. Policy targets, commands, roles, and predicates
// ============================================================================
describe("SEC1F — policy contract", () => {
  it("contains exactly two CREATE POLICY statements", () => {
    expect(parsedPolicies.length).toBe(2);
    const raw = codeSansQuotedNames.match(/\bcreate\s+policy\b/g) ?? [];
    expect(raw.length).toBe(2);
  });

  it("creates nothing other than those two policies", () => {
    const creates = codeSansQuotedNames.match(/\bcreate\b/g) ?? [];
    expect(creates.length).toBe(2);
  });

  it("names exactly the two approved policies, in order", () => {
    expect(parsedPolicies.map((p) => p.name)).toEqual(
      APPROVED_POLICIES.map((p) => p.name)
    );
  });

  it("quotes exactly two identifiers, both approved policy names", () => {
    const quoted = (code.match(/"[^"]*"/g) ?? []).map((q) => q.slice(1, -1));
    expect(quoted.length).toBe(2);
    for (const q of quoted) {
      expect(APPROVED_POLICIES.map((p) => p.name)).toContain(q);
    }
  });

  it("targets only public.range_sessions", () => {
    for (const p of parsedPolicies) {
      expect(p.relation).toBe(TARGET_RELATION);
    }
    const relations = (code.match(/on ([a-z_]+\.[a-z_]+)/g) ?? []).map((s) =>
      s.replace(/^on\s+/, "")
    );
    expect(relations.length).toBe(2);
    for (const r of relations) {
      expect(r).toBe(TARGET_RELATION);
    }
  });

  it("declares both policies PERMISSIVE", () => {
    for (const p of parsedPolicies) {
      expect(p.permissive).toBe("permissive");
    }
  });

  it("grants both policies to authenticated only", () => {
    for (const p of parsedPolicies) {
      expect(p.role).toBe("authenticated");
    }
    expect((codeSansQuotedNames.match(/\bto authenticated\b/g) ?? []).length).toBe(2);
  });

  it("creates exactly one INSERT policy using only the owner WITH CHECK predicate", () => {
    const inserts = parsedPolicies.filter((p) => p.command === "insert");
    expect(inserts.length).toBe(1);
    expect(inserts[0].name).toBe(APPROVED_POLICIES[0].name);
    expect(inserts[0].clause).toBe("with check");
    expect(inserts[0].predicate).toBe("((select auth.uid()) = user_id)");
  });

  it("creates exactly one SELECT policy using only the owner USING predicate", () => {
    const selects = parsedPolicies.filter((p) => p.command === "select");
    expect(selects.length).toBe(1);
    expect(selects[0].name).toBe(APPROVED_POLICIES[1].name);
    expect(selects[0].clause).toBe("using");
    expect(selects[0].predicate).toBe("((select auth.uid()) = user_id)");
  });

  it("gives the INSERT policy no USING clause and the SELECT policy no WITH CHECK clause", () => {
    expect((codeSansQuotedNames.match(/\bwith check\b/g) ?? []).length).toBe(1);
    expect((codeSansQuotedNames.match(/\busing\b/g) ?? []).length).toBe(1);
  });
});

// ============================================================================
// 4. Access must never be widened beyond owner INSERT and owner SELECT
// ============================================================================
describe("SEC1F — access is not widened", () => {
  const FORBIDDEN: [string, RegExp][] = [
    ["for update policy", /\bfor\s+update\b/],
    ["for delete policy", /\bfor\s+delete\b/],
    ["for all policy", /\bfor\s+all\b/],
    ["anon grantee", /\bto\s+anon\b/],
    ["public grantee", /\bto\s+public\b/],
    ["service_role grantee", /\bto\s+service_role\b/],
    ["coach grantee", /\bcoach\b/],
    ["admin grantee", /\badmin\b/],
    ["restrictive policy", /\brestrictive\b/],
    ["if exists", /\bif\s+exists\b/],
    ["if not exists", /\bif\s+not\s+exists\b/],
    ["alter", /\balter\b/],
    ["drop", /\bdrop\b/],
    ["grant", /\bgrant\b/],
    ["revoke", /\brevoke\b/],
    ["insert into (DML)", /\binsert\s+into\b/],
    ["delete from (DML)", /\bdelete\s+from\b/],
    ["truncate", /\btruncate\b/],
    ["function", /\bfunction\b/],
    ["trigger", /\btrigger\b/],
    ["index", /\bindex\b/],
    ["role change", /\brole\b/],
    ["schema change", /\bschema\b/],
    ["view", /\bcreate\s+view\b/],
    ["security definer", /security\s+definer/],
    ["security invoker", /security\s+invoker/],
    ["search_path", /search_path/],
    ["row level security toggle", /row\s+level\s+security/],
    ["dollar-quoted body", /\$\$/],
    ["rollback", /\brollback\b/],
    ["savepoint", /\bsavepoint\b/],
  ];

  it.each(FORBIDDEN)("executable SQL never contains %s", (_label, pattern) => {
    expect(codeSansQuotedNames).not.toMatch(pattern);
  });

  it("the quote-blanking guard does not hide a real command keyword", () => {
    // Proves the guard is sound: both approved policy names contain English
    // words that also name SQL commands, yet blanking quoted identifiers leaves
    // only the two legitimate `for insert` / `for select` command clauses.
    expect(code).toContain('"Users can insert own range sessions"');
    expect(code).toContain('"Users can view own range sessions"');
    expect((codeSansQuotedNames.match(/\bfor\s+insert\b/g) ?? []).length).toBe(1);
    expect((codeSansQuotedNames.match(/\bfor\s+select\b/g) ?? []).length).toBe(1);
  });
});

// ============================================================================
// 5. Transaction framing
// ============================================================================
describe("SEC1F — transaction framing", () => {
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

  it("wraps every CREATE POLICY inside the transaction", () => {
    const beginIdx = statements.indexOf("begin");
    const commitIdx = statements.indexOf("commit");
    for (const p of parsedPolicies) {
      expect(p.index).toBeGreaterThan(beginIdx);
      expect(p.index).toBeLessThan(commitIdx);
    }
  });
});

// ============================================================================
// 6. Migration ordering (F13: historical ordering, never "is newest")
// ============================================================================
describe("SEC1F — migration ordering", () => {
  const sqlMigrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

  it("is present among the checked-in SQL migrations", () => {
    expect(sqlMigrations).toContain(MIGRATION_FILENAME);
  });

  it("sorts after every migration that existed when SEC1F was authored", () => {
    const priorMigrations = migrationsAuthoredBefore(MIGRATION_FILENAME);
    expect(priorMigrations.length).toBe(22);
    expect(sortsAfterAll(MIGRATION_FILENAME, priorMigrations)).toBe(true);
    for (const name of priorMigrations) {
      expect(sqlMigrations).toContain(name);
    }
  });
});

// ============================================================================
// 7. Save-action contract
// ============================================================================
describe("SEC1F — save action writes only canonical columns", () => {
  it("still authenticates the caller before writing", () => {
    expect(actionsSrc).toContain("supabase.auth.getUser()");
    expect(actionsSrc).toContain('return { error: "Not authenticated." };');
  });

  it("inserts into range_sessions exactly once", () => {
    const inserts = actionsSrc.match(/\.from\("range_sessions"\)\s*\.insert\(/g) ?? [];
    expect(inserts.length).toBe(1);
    expect(insertPayload).not.toBeNull();
  });

  it("sets user_id from the authenticated user", () => {
    expect(insertPayload).toContain("user_id: user.id");
  });

  it("sets session_type from the caller-supplied session type", () => {
    expect(insertPayload).toContain("session_type: data.sessionType");
  });

  it("writes the metrics through exercise_data", () => {
    expect(insertPayload).toContain("exercise_data");
  });

  it.each(NONEXISTENT_COLUMNS)(
    "never sends %s as a top-level database column",
    (column) => {
      expect(insertPayload).not.toContain(`${column}:`);
    }
  );

  it("sends no completed_at value, leaving the database default now() to apply", () => {
    expect(insertPayload).not.toContain("completed_at");
  });

  it("builds exercise_data with exactly the three approved metric keys", () => {
    expect(exerciseDataLiteral).not.toBeNull();
    const keys = (exerciseDataLiteral!.match(/^\s*([a-z_]+):/gm) ?? []).map((k) =>
      k.replace(/[:\s]/g, "")
    );
    expect(keys.sort()).toEqual(["completion_rate", "shots_executed", "shots_total"]);
  });

  it("introduces no update, delete, or upsert operation", () => {
    expect(actionsSrc).not.toMatch(/\.update\(/);
    expect(actionsSrc).not.toMatch(/\.delete\(/);
    expect(actionsSrc).not.toMatch(/\.upsert\(/);
  });
});

// ============================================================================
// 8. Telemetry-read contract
// ============================================================================
describe("SEC1F — telemetry reads only canonical columns", () => {
  it("selects exactly the four canonical fields", () => {
    expect(telemetryQuery).not.toBeNull();
    expect(telemetryQuery).toContain(
      '.select("id, session_type, exercise_data, completed_at")'
    );
  });

  it.each(NONEXISTENT_COLUMNS)("never requests %s from the database", (column) => {
    expect(telemetryQuery).not.toContain(column);
  });

  it("filters by the authenticated user's id", () => {
    expect(telemetryQuery).toContain('.eq("user_id", user.id)');
  });

  it("orders by completed_at descending", () => {
    expect(telemetryQuery).toContain('.order("completed_at", { ascending: false })');
  });

  it("sources the timeline timestamp from the validated completed_at value", () => {
    expect(telemetrySrc).toMatch(/created_at:\s*r\.completed_at/);
  });

  it("introduces no insert, update, delete, or upsert operation", () => {
    expect(telemetrySrc).not.toMatch(/\.insert\(/);
    expect(telemetrySrc).not.toMatch(/\.update\(/);
    expect(telemetrySrc).not.toMatch(/\.delete\(/);
    expect(telemetrySrc).not.toMatch(/\.upsert\(/);
  });
});

// ============================================================================
// 9. Runtime validation of the untrusted exercise_data blob
// ============================================================================
describe("SEC1F — exercise_data is validated, never asserted", () => {
  it("routes the blob through a narrow validator", () => {
    expect(telemetrySrc).toContain("function parseRangeMetrics(");
    expect(telemetrySrc).toContain("parseRangeMetrics(r.exercise_data)");
  });

  it("treats the blob as unknown rather than a typed object", () => {
    expect(telemetrySrc).toMatch(/function parseRangeMetrics\(\s*value: unknown/);
  });

  it.each(["shots_total", "shots_executed", "completion_rate"])(
    "checks %s is a finite number",
    (metric) => {
      expect(telemetrySrc).toContain(`raw.${metric}`);
    }
  );

  it("rejects NaN and Infinity by using Number.isFinite on every metric", () => {
    const finiteChecks = telemetrySrc.match(/Number\.isFinite\(/g) ?? [];
    expect(finiteChecks.length).toBe(3);
  });

  it("uses no unchecked numeric type assertion", () => {
    expect(telemetrySrc).not.toMatch(/as number/);
  });

  it("returns null instead of throwing on a null or malformed blob", () => {
    expect(telemetrySrc).toMatch(
      /if \(typeof value !== "object" \|\| value === null \|\| Array\.isArray\(value\)\) return null;/
    );
  });

  it("drops rows that fail validation rather than fabricating values", () => {
    expect(telemetrySrc).toContain("if (metrics === null) return [];");
    expect(telemetrySrc).toContain('if (typeof r.session_type !== "string") return [];');
    expect(telemetrySrc).toContain('if (typeof r.completed_at !== "string") return [];');
  });
});

// ============================================================================
// 10. Scope contract — this slice touches nothing else
// ============================================================================
describe("SEC1F — out-of-scope files are untouched", () => {
  const UNCHANGED: [string, string][] = [
    [
      path.join("app", "(dashboard)", "range", "RangeDashboard.tsx"),
      "1fd36582ed43a74c1011ce3aa5e0aa9b6453645cfa043c0a87f24e013347826d",
    ],
    [
      path.join("utils", "supabase", "server.ts"),
      "be01ba41db7284a4d30d9cac25041b03c9976a83adfca0a82e0be5a74cac31fd",
    ],
    [
      path.join("supabase", "migrations", "20260721220000_swingproai_production_baseline.sql"),
      "33a599f07cd6aba5761ce7feea811ed3c096bb9dbc50f21d519037df45d4b828",
    ],
  ];

  it.each(UNCHANGED)("%s is byte-identical to its pinned fingerprint", (rel, sha) => {
    const actual = createHash("sha256")
      .update(readFileSync(path.join(repoRoot, rel)))
      .digest("hex");
    expect(actual).toBe(sha);
  });

  it("does not carry the blocked SEC1F documentation file", () => {
    expect(
      existsSync(path.join(repoRoot, "docs", "SUPABASE_SECURITY_ACCEPTED_FINDINGS.md"))
    ).toBe(false);
  });
});
