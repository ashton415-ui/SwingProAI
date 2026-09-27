import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANALYSIS_REQUEST_AUTHORITY_FILENAME,
  APPROVED_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  PUTTING_SCORE_EQ5F_E_FILENAME,
  migrationsAuthoredBefore,
} from "./migration-inventory";

/**
 * NATIVE ANALYSIS REQUEST AUTHORITY CLOSURE — migration source contract.
 *
 * This proves what the checked-in migration SAYS. It does not and cannot prove
 * that the migration has been applied anywhere: remote proof belongs to the
 * separate staging database gate. Every assertion below is about source text
 * and the shared migration inventory.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");

const raw = readFileSync(path.join(migrationsDir, ANALYSIS_REQUEST_AUTHORITY_FILENAME), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Executable SQL only: comments removed, whitespace collapsed, lower-cased. */
const code = raw
  .replace(/--.*$/gm, "")
  .replace(/\s+/g, " ")
  .toLowerCase();

function indexOfRequired(needle: string): number {
  const at = code.indexOf(needle);
  expect(at, `expected migration to contain: ${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

describe("analysis-request-authority — identity and inventory registration", () => {
  it("carries the CLI-generated filename", () => {
    expect(ANALYSIS_REQUEST_AUTHORITY_FILENAME).toBe("20260926143659_analysis_request_authority.sql");
    expect(ANALYSIS_REQUEST_AUTHORITY_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("is registered in APPROVED_MIGRATIONS exactly once", () => {
    expect(APPROVED_MIGRATIONS.filter((m) => m === ANALYSIS_REQUEST_AUTHORITY_FILENAME)).toHaveLength(1);
  });

  it("exists on disk exactly once, with no second migration of the same name", () => {
    const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(onDisk.filter((f) => f === ANALYSIS_REQUEST_AUTHORITY_FILENAME)).toHaveLength(1);
    expect(onDisk.filter((f) => f.endsWith("_analysis_request_authority.sql"))).toHaveLength(1);
  });

  it("sorts after every migration that existed when it was authored", () => {
    const earlier = migrationsAuthoredBefore(ANALYSIS_REQUEST_AUTHORITY_FILENAME);
    expect(earlier).toHaveLength(34);
    expect(earlier).toContain(PUTTING_SCORE_EQ5F_E_FILENAME);
    expect(APPROVED_MIGRATIONS.indexOf(ANALYSIS_REQUEST_AUTHORITY_FILENAME)).toBe(earlier.length);
  });

  it("leaves the inventory a closed world with a derived count", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });
});

describe("analysis-request-authority — swing_analysis client writes are closed", () => {
  it("revokes INSERT and UPDATE from anon and authenticated", () => {
    indexOfRequired("revoke insert, update on table public.swing_analysis from anon, authenticated;");
  });

  it("reintroduces no INSERT or UPDATE grant of any kind on swing_analysis", () => {
    expect(code).not.toMatch(/grant[^;]*on (table )?public\.swing_analysis/);
    expect(code).not.toMatch(/grant (insert|update)\s*\(/);
  });

  it("leaves SELECT and DELETE on swing_analysis untouched", () => {
    expect(code).not.toMatch(/revoke[^;]*\b(select|delete|all)\b[^;]*on (table )?public\.swing_analysis/);
  });

  it("proves the closure in its postflight, including column-level grants", () => {
    indexOfRequired("has_any_column_privilege('anon', 'public.swing_analysis', 'insert')");
    indexOfRequired("has_any_column_privilege('authenticated', 'public.swing_analysis', 'insert')");
    indexOfRequired("has_any_column_privilege('anon', 'public.swing_analysis', 'update')");
    indexOfRequired("has_any_column_privilege('authenticated', 'public.swing_analysis', 'update')");
  });
});

describe("analysis-request-authority — one analysis per swing video", () => {
  it("checks for duplicates, failing closed, before creating uniqueness", () => {
    const check = indexOfRequired("having count(*) > 1");
    const raise = indexOfRequired("raise exception 'ara-dup-1:");
    const unique = indexOfRequired(
      "create unique index swing_analysis_swing_video_id_unique_idx on public.swing_analysis (swing_video_id);",
    );
    expect(check).toBeLessThan(raise);
    expect(raise).toBeLessThan(unique);
  });

  it("holds writes off across the check and the index build", () => {
    const lock = indexOfRequired("lock table public.swing_analysis in share row exclusive mode;");
    expect(lock).toBeLessThan(code.indexOf("having count(*) > 1"));
  });

  it("never cleans up duplicates", () => {
    // String literals (the raise messages) are blanked so only statements count.
    const statements = code.replace(/'[^']*'/g, "''");
    expect(statements).not.toMatch(/\bdelete from\b/);
    expect(statements).not.toMatch(/\bupdate public\.[a-z_]+ set\b/);
    expect(statements).not.toMatch(/\btruncate\b/);
    expect(statements).not.toMatch(/\binsert into\b/);
  });

  it("verifies the index shape in its postflight", () => {
    indexOfRequired("i.indisunique and i.indnkeyatts = 1 and a.attname = 'swing_video_id'");
  });
});

describe("analysis-request-authority — swing_videos becomes immutable after creation", () => {
  it("revokes UPDATE from anon and authenticated", () => {
    indexOfRequired("revoke update on table public.swing_videos from anon, authenticated;");
  });

  it("leaves INSERT, SELECT and DELETE on swing_videos untouched", () => {
    expect(code).not.toMatch(/revoke[^;]*\b(insert|select|delete|all)\b[^;]*on (table )?public\.swing_videos/);
    indexOfRequired("has_table_privilege('authenticated', 'public.swing_videos', 'insert')");
  });

  it("proves the swing_videos closure in its postflight", () => {
    indexOfRequired("has_any_column_privilege('authenticated', 'public.swing_videos', 'update')");
  });
});

describe("analysis-request-authority — scope", () => {
  it("adds no SECURITY DEFINER, function, trigger or policy", () => {
    expect(code).not.toContain("security definer");
    expect(code).not.toMatch(/create (or replace )?function/);
    expect(code).not.toMatch(/create trigger/);
    expect(code).not.toMatch(/(create|alter|drop) policy/);
  });

  it("is transactional and fails closed on a divergent database", () => {
    expect(code.trim().startsWith("begin;")).toBe(true);
    expect(code.trim().endsWith("commit;")).toBe(true);
    indexOfRequired("raise exception 'ara-pre-1:");
    indexOfRequired("raise exception 'ara-pre-3:");
  });

  it("touches only swing_analysis and swing_videos", () => {
    const tables = new Set(code.match(/public\.[a-z_]+/g) ?? []);
    expect(Array.from(tables).sort()).toEqual(["public.swing_analysis", "public.swing_videos"]);
  });
});
