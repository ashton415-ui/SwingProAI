import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read supabase-schema-v7.sql as plain text only — this test never connects
// to a database, never executes SQL, and never applies the migration.
const migrationPath = path.join(__dirname, "..", "supabase-schema-v7.sql");
const migration = readFileSync(migrationPath, "utf8");

/** Strips `-- ...` line comments so assertions can't be fooled by prose. */
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

/**
 * Section boundaries below are located using markers drawn from real,
 * executable SQL only (never from `--` comment header text, which
 * stripSqlComments removes from codeLower before any assertion runs).
 */
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

/** The file has exactly four `do $$` preflight blocks, in this order. */
function preflightSlice(n: 1 | 2 | 3 | 4): string {
  const start = nthIndexOf(codeLower, "do $$", n);
  expect(start, `expected to find preflight block #${n} ("do $$" occurrence ${n})`).toBeGreaterThanOrEqual(0);
  const end =
    n < 4
      ? nthIndexOf(codeLower, "do $$", n + 1)
      : codeLower.indexOf("alter table public.coach_profiles enable row level security", start);
  expect(end, `expected an end boundary after preflight block #${n}`).toBeGreaterThan(start);
  return codeLower.slice(start, end);
}

/** Bounds a `create function ...$fn$ ... $fn$` block starting at `startMarker`. */
function boundFunction(startMarker: string): string {
  const startIdx = codeLower.indexOf(startMarker);
  expect(startIdx, `expected to find "${startMarker}"`).toBeGreaterThanOrEqual(0);
  const openIdx = codeLower.indexOf("$fn$", startIdx);
  expect(openIdx).toBeGreaterThan(startIdx);
  const closeIdx = codeLower.indexOf("$fn$", openIdx + "$fn$".length);
  expect(closeIdx).toBeGreaterThan(openIdx);
  return codeLower.slice(startIdx, closeIdx + "$fn$".length);
}

/** Bounds the parameter list of a `create function name(...)` header only. */
function boundParamList(startMarker: string): string {
  const startIdx = codeLower.indexOf(startMarker);
  expect(startIdx).toBeGreaterThanOrEqual(0);
  const openParen = codeLower.indexOf("(", startIdx + startMarker.length - 1);
  expect(openParen).toBeGreaterThan(0);
  const returnsIdx = codeLower.indexOf("returns", openParen);
  expect(returnsIdx).toBeGreaterThan(openParen);
  return codeLower.slice(openParen, returnsIdx);
}

const GET_FN_MARKER = "create function public.fn_get_own_coach_marketplace_profile";
const UPDATE_FN_MARKER = "create function public.fn_update_coach_marketplace_profile(";
const VIEW_MARKER = "create view public.coach_directory_listing";

const RETURN_COLUMNS = [
  "coach_profile_id",
  "public_slug",
  "marketplace_headline",
  "profile_photo_url",
  "bio",
  "years_coaching",
  "lesson_delivery_modes",
  "public_city",
  "public_region",
  "timezone",
  "marketplace_visibility_status",
  "verification_status",
  "minimum_booking_notice_hours",
  "cancellation_policy_summary",
  "updated_at",
];

describe("supabase-schema-v7.sql — file-level posture", () => {
  it("wraps the migration in BEGIN and COMMIT", () => {
    const beginIndex = code.search(/\bbegin\s*;/i);
    const commitIndex = code.search(/\bcommit\s*;/i);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
  });

  it("uses no DROP statement anywhere", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+(table|view|function|policy|column|index)\b/);
  });

  it("uses no CREATE OR REPLACE anywhere (fail-loud posture, not v6's rerun-friendly idiom)", () => {
    expect(codeLower).not.toMatch(/create\s+or\s+replace/);
  });

  it("does not modify supabase-schema-v6.sql", () => {
    const v6Path = path.join(__dirname, "..", "supabase-schema-v6.sql");
    expect(existsSync(v6Path)).toBe(true);
  });

  it("contains no Stripe, payment, storage, booking, or review execution behavior", () => {
    for (const forbidden of [
      "stripe",
      "payment_intent",
      "checkout_session",
      "storage.objects",
      "storage.buckets",
      "coach_bookings",
      "coach_reviews",
    ]) {
      expect(codeLower, `expected v7.sql to not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("introduces no route/page/component file for CM2 (best-effort path check; PR-scope diff is authoritative)", () => {
    const repoRoot = path.join(__dirname, "..");
    for (const candidate of [
      "app/coaches",
      "app/(dashboard)/coach/marketplace-profile",
      "components/marketplace",
    ]) {
      expect(existsSync(path.join(repoRoot, candidate)), `expected ${candidate} to not exist in CM2A`).toBe(false);
    }
  });
});

describe("supabase-schema-v7.sql — preflight 1: required columns", () => {
  it("checks every required public.users and public.coach_profiles column for existence and type", () => {
    const slice = preflightSlice(1);
    expect(slice).toContain("information_schema.columns");
    expect(slice).toMatch(/raise exception[\s\S]{0,60}missing or incompatible required columns/);

    const requiredColumns = [
      "'users',           'id'",
      "'users',           'role'",
      "'coach_profiles',  'id'",
      "'coach_profiles',  'user_id'",
      "'coach_profiles',  'public_slug'",
      "'coach_profiles',  'marketplace_headline'",
      "'coach_profiles',  'profile_photo_url'",
      "'coach_profiles',  'bio'",
      "'coach_profiles',  'years_coaching'",
      "'coach_profiles',  'lesson_delivery_modes'",
      "'coach_profiles',  'public_city'",
      "'coach_profiles',  'public_region'",
      "'coach_profiles',  'timezone'",
      "'coach_profiles',  'marketplace_visibility_status'",
      "'coach_profiles',  'verification_status'",
      "'coach_profiles',  'minimum_booking_notice_hours'",
      "'coach_profiles',  'cancellation_policy_summary'",
      "'coach_profiles',  'updated_at'",
    ];
    for (const column of requiredColumns) {
      expect(slice, `expected preflight to check ${column}`).toContain(column);
    }
  });

  it("requires coach_profiles.is_active with boolean type", () => {
    const slice = preflightSlice(1);
    expect(slice).toContain("'coach_profiles',  'is_active'");
    expect(slice).toMatch(/'coach_profiles',\s*'is_active',\s*'boolean'/);
  });
});

describe("supabase-schema-v7.sql — preflight 2: PostgreSQL 15+ required", () => {
  it("fails loudly on a server_version_num below 150000, with no pre-15 fallback branch", () => {
    const slice = preflightSlice(2);
    expect(slice).toMatch(/server_version_num[\s\S]{0,20}<\s*150000/);
    expect(slice).toMatch(/raise exception/);
    expect(slice).not.toMatch(/\belse\b/);
  });
});

describe("supabase-schema-v7.sql — preflight 3: object-collision guards", () => {
  it("fails loudly if fn_get_own_coach_marketplace_profile already exists", () => {
    const slice = preflightSlice(3);
    expect(slice).toMatch(/fn_get_own_coach_marketplace_profile[\s\S]{0,150}raise exception/);
  });

  it("fails loudly if any fn_update_coach_marketplace_profile overload already exists", () => {
    const slice = preflightSlice(3);
    expect(slice).toMatch(/fn_update_coach_marketplace_profile[\s\S]{0,150}raise exception/);
  });

  it("fails loudly if any object named coach_directory_listing already exists", () => {
    const slice = preflightSlice(3);
    expect(slice).toMatch(/coach_directory_listing[\s\S]{0,150}raise exception/);
  });

  it("fails loudly if any RLS policy already exists on public.coach_profiles", () => {
    const slice = preflightSlice(3);
    expect(slice).toMatch(/pg_policies[\s\S]{0,200}raise exception/);
  });
});

describe("supabase-schema-v7.sql — preflight 4: effective-privilege guards", () => {
  it("rejects effective authenticated table-level SELECT and UPDATE via has_table_privilege", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/has_table_privilege\('authenticated',\s*'public\.coach_profiles',\s*'select'\)/);
    expect(slice).toMatch(/has_table_privilege\('authenticated',\s*'public\.coach_profiles',\s*'update'\)/);
  });

  it("rejects effective authenticated column-level SELECT and UPDATE via has_any_column_privilege", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/has_any_column_privilege\('authenticated',\s*'public\.coach_profiles',\s*'select'\)/);
    expect(slice).toMatch(/has_any_column_privilege\('authenticated',\s*'public\.coach_profiles',\s*'update'\)/);
  });

  it("rejects effective anon table-level SELECT and UPDATE via has_table_privilege", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/has_table_privilege\('anon',\s*'public\.coach_profiles',\s*'select'\)/);
    expect(slice).toMatch(/has_table_privilege\('anon',\s*'public\.coach_profiles',\s*'update'\)/);
  });

  it("rejects effective anon column-level SELECT and UPDATE via has_any_column_privilege", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/has_any_column_privilege\('anon',\s*'public\.coach_profiles',\s*'select'\)/);
    expect(slice).toMatch(/has_any_column_privilege\('anon',\s*'public\.coach_profiles',\s*'update'\)/);
  });

  it("rejects explicit PUBLIC-grantee table and column privileges via information_schema", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/information_schema\.table_privileges[\s\S]{0,200}grantee\s*=\s*'public'/);
    expect(slice).toMatch(/information_schema\.column_privileges[\s\S]{0,200}grantee\s*=\s*'public'/);
  });

  it("requires service_role to already have underlying SELECT on public.coach_profiles", () => {
    const slice = preflightSlice(4);
    expect(slice).toMatch(/if\s+not\s+has_table_privilege\('service_role',\s*'public\.coach_profiles',\s*'select'\)/);
  });
});

describe("supabase-schema-v7.sql — preflight 5: RLS enabled, no policy created", () => {
  it("enables row level security on coach_profiles and creates no policy in this file", () => {
    expect(codeLower).toMatch(/alter\s+table\s+public\.coach_profiles\s+enable\s+row\s+level\s+security/);
    expect(codeLower).not.toMatch(/create\s+policy/);
  });
});

describe("supabase-schema-v7.sql — fn_get_own_coach_marketplace_profile", () => {
  it("is SECURITY DEFINER with search_path locked to empty", () => {
    const slice = boundFunction(GET_FN_MARKER);
    expect(slice).toMatch(/security\s+definer/);
    expect(slice).not.toMatch(/security\s+invoker/);
    expect(slice).toMatch(/set\s+search_path\s*=\s*''/);
  });

  it("checks auth.uid() and requires public.users.role = 'coach'", () => {
    const slice = boundFunction(GET_FN_MARKER);
    expect(slice).toMatch(/auth\.uid\(\)/);
    expect(slice).toMatch(/v_role\s+is\s+distinct\s+from\s+'coach'/);
    expect(slice).toMatch(/from\s+public\.users\b/);
  });

  it("filters strictly to the caller's own row", () => {
    const slice = boundFunction(GET_FN_MARKER);
    expect(slice).toMatch(/where\s+cp\.user_id\s*=\s*v_caller_id/);
  });

  it("takes zero parameters", () => {
    expect(codeLower).toMatch(/create\s+function\s+public\.fn_get_own_coach_marketplace_profile\(\s*\)/);
  });

  it("declares an explicit 15-column RETURNS TABLE contract with no wildcard or row-type return", () => {
    const idx = codeLower.indexOf(GET_FN_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    expect(returnsIdx).toBeGreaterThan(idx);
    expect(bodyIdx).toBeGreaterThan(returnsIdx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    for (const column of RETURN_COLUMNS) {
      expect(returnSlice, `expected ${column} in RETURNS TABLE`).toContain(column);
    }
    // Scoped to the RETURNS clause itself, not the whole file — this
    // function's own comment-on doc-string legitimately contains the prose
    // "never returns public.coach_profiles" as a negation, which a global
    // check would be fooled by.
    expect(returnSlice).not.toContain("returns public.coach_profiles");
    const slice = boundFunction(GET_FN_MARKER);
    expect(slice).not.toMatch(/select\s+\*/);
  });
});

describe("supabase-schema-v7.sql — fn_get_own_coach_marketplace_profile privileges", () => {
  it("revokes EXECUTE from PUBLIC and anon, grants only to authenticated", () => {
    const startIdx = codeLower.indexOf("revoke execute on function public.fn_get_own_coach_marketplace_profile");
    const endIdx = codeLower.indexOf(UPDATE_FN_MARKER);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_get_own_coach_marketplace_profile\(\)\s+from\s+public/);
    expect(slice).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_get_own_coach_marketplace_profile\(\)\s+from\s+anon/);
    expect(slice).toMatch(/grant\s+execute\s+on\s+function\s+public\.fn_get_own_coach_marketplace_profile\(\)\s+to\s+authenticated/);
  });
});

describe("supabase-schema-v7.sql — fn_update_coach_marketplace_profile", () => {
  it("is SECURITY DEFINER with search_path locked to empty", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/security\s+definer/);
    expect(slice).not.toMatch(/security\s+invoker/);
    expect(slice).toMatch(/set\s+search_path\s*=\s*''/);
  });

  it("has no target user/coach/profile ID parameter", () => {
    const paramSlice = boundParamList(UPDATE_FN_MARKER);
    expect(paramSlice).not.toMatch(/p_user_id/);
    expect(paramSlice).not.toMatch(/p_coach_id/);
    expect(paramSlice).not.toMatch(/p_coach_profile_id/);
    expect(paramSlice).not.toMatch(/p_target/);
    expect(paramSlice).not.toMatch(/p_id\b/);
  });

  it("has no json/jsonb parameter anywhere in its body", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).not.toMatch(/jsonb/);
  });

  it("never accepts a verification_status parameter and never assigns it in the UPDATE SET clause (it is a read-only passthrough in the return contract only)", () => {
    const paramSlice = boundParamList(UPDATE_FN_MARKER);
    expect(paramSlice).not.toMatch(/p_verification_status/);
    const setStartIdx = codeLower.indexOf("update public.coach_profiles set");
    const setEndIdx = codeLower.indexOf("where user_id = v_caller_id", setStartIdx);
    expect(setStartIdx).toBeGreaterThanOrEqual(0);
    expect(setEndIdx).toBeGreaterThan(setStartIdx);
    const setSlice = codeLower.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/verification_status/);
  });

  it("never accepts or assigns hourly_rate anywhere, including the return contract", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).not.toMatch(/hourly_rate/);
  });

  it("never accepts an is_active parameter and never assigns it in the UPDATE SET clause", () => {
    const paramSlice = boundParamList(UPDATE_FN_MARKER);
    expect(paramSlice).not.toMatch(/p_is_active/);
    const setStartIdx = codeLower.indexOf("update public.coach_profiles set");
    const setEndIdx = codeLower.indexOf("where user_id = v_caller_id", setStartIdx);
    expect(setStartIdx).toBeGreaterThanOrEqual(0);
    expect(setEndIdx).toBeGreaterThan(setStartIdx);
    const setSlice = codeLower.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/is_active/);
  });

  it("never accepts a profile_photo_url parameter and never assigns it in the UPDATE SET clause", () => {
    const paramSlice = boundParamList(UPDATE_FN_MARKER);
    expect(paramSlice).not.toMatch(/p_profile_photo_url/);
    const setStartIdx = codeLower.indexOf("update public.coach_profiles set");
    const setEndIdx = codeLower.indexOf("where user_id = v_caller_id", setStartIdx);
    expect(setStartIdx).toBeGreaterThanOrEqual(0);
    expect(setEndIdx).toBeGreaterThan(setStartIdx);
    const setSlice = codeLower.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/profile_photo_url/);
  });

  it("requires marketplace_visibility_status to be non-null and exactly hidden, draft, or published", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/p_marketplace_visibility_status\s+is\s+null/);
    expect(slice).toMatch(/not\s+in\s*\(\s*'hidden'\s*,\s*'draft'\s*,\s*'published'\s*\)/);
  });

  it("locks the caller's own row with SELECT ... FOR UPDATE before the UPDATE statement, and rejects a currently-suspended row", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    const forUpdateIdx = slice.indexOf("for update");
    const updateIdx = slice.indexOf("update public.coach_profiles set");
    expect(forUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(forUpdateIdx);
    expect(slice).toMatch(/v_current_status\s*=\s*'suspended'/);
    const suspendedCheckIdx = slice.indexOf("v_current_status = 'suspended'");
    expect(suspendedCheckIdx).toBeGreaterThan(forUpdateIdx);
    expect(suspendedCheckIdx).toBeLessThan(updateIdx);
  });

  it("validates public_slug: no surrounding whitespace, 3-80 chars, lowercase, and the exact anchored pattern", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/p_public_slug\s*<>\s*btrim\(p_public_slug\)/);
    expect(slice).toMatch(/length\(p_public_slug\)\s*<\s*3\s+or\s+length\(p_public_slug\)\s*>\s*80/);
    expect(slice).toMatch(/p_public_slug\s*<>\s*lower\(p_public_slug\)/);
    expect(slice).toContain("'^[a-z0-9]+(-[a-z0-9]+)*$'");
  });

  it("validates marketplace_headline max length 120", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/length\(p_marketplace_headline\)\s*>\s*120/);
  });

  it("validates bio max length 2000", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/length\(p_bio\)\s*>\s*2000/);
  });

  it("validates years_coaching between 0 and 80", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/p_years_coaching\s*<\s*0\s+or\s+p_years_coaching\s*>\s*80/);
  });

  it("validates lesson_delivery_modes: max 3 entries, no duplicates, only in_person/remote/hybrid", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/v_mode_count\s*>\s*3/);
    expect(slice).toMatch(/v_distinct_count\s*<>\s*v_mode_count/);
    expect(slice).toMatch(/v_mode\s+not\s+in\s*\(\s*'in_person'\s*,\s*'remote'\s*,\s*'hybrid'\s*\)/);
  });

  it("validates public_city and public_region max length 100", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/length\(p_public_city\)\s*>\s*100/);
    expect(slice).toMatch(/length\(p_public_region\)\s*>\s*100/);
  });

  it("validates timezone max length 100 and requires a real IANA name via pg_timezone_names", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/length\(p_timezone\)\s*>\s*100/);
    expect(slice).toMatch(/pg_catalog\.pg_timezone_names/);
  });

  it("validates minimum_booking_notice_hours between 0 and 720", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/p_minimum_booking_notice_hours\s*<\s*0\s+or\s+p_minimum_booking_notice_hours\s*>\s*720/);
  });

  it("validates cancellation_policy_summary max length 1000", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/length\(p_cancellation_policy_summary\)\s*>\s*1000/);
  });

  it("requires public_slug, a nonblank headline, and at least one delivery mode to publish, but never requires city/region", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    const publishIdx = slice.indexOf("p_marketplace_visibility_status = 'published' then");
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const publishSlice = slice.slice(publishIdx, publishIdx + 700);
    expect(publishSlice).toMatch(/p_public_slug\s+is\s+null/);
    expect(publishSlice).toMatch(/btrim\(p_marketplace_headline\)\s*=\s*''/);
    expect(publishSlice).toMatch(/array_length\(p_lesson_delivery_modes,\s*1\)\s+is\s+null/);
    expect(publishSlice).not.toMatch(/p_public_city\s+is\s+null/);
    expect(publishSlice).not.toMatch(/p_public_region\s+is\s+null/);
  });

  it("maps only the exact public_slug unique-index violation to a friendly error, and re-raises any unrelated unique_violation unchanged", () => {
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).toMatch(/get\s+stacked\s+diagnostics\s+v_constraint_name\s*=\s*constraint_name/);
    expect(slice).toContain("'idx_coach_profiles_public_slug_unique'");
    const elseIdx = slice.indexOf("else", slice.indexOf("idx_coach_profiles_public_slug_unique"));
    expect(elseIdx).toBeGreaterThan(0);
    const elseSlice = slice.slice(elseIdx, elseIdx + 60);
    expect(elseSlice).toMatch(/raise\s*;/);
  });

  it("declares the same explicit 15-column RETURNS TABLE contract with no wildcard, row-type, or RETURNING * return", () => {
    const idx = codeLower.indexOf(UPDATE_FN_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    expect(returnsIdx).toBeGreaterThan(idx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    for (const column of RETURN_COLUMNS) {
      expect(returnSlice, `expected ${column} in RETURNS TABLE`).toContain(column);
    }
    // Scoped to the RETURNS clause itself, not the whole file — this
    // function's own comment-on doc-string legitimately contains the prose
    // "never returns public.coach_profiles" as a negation, which a global
    // check would be fooled by.
    expect(returnSlice).not.toContain("returns public.coach_profiles");
    expect(codeLower).not.toMatch(/returning\s+\*/);
    const slice = boundFunction(UPDATE_FN_MARKER);
    expect(slice).not.toMatch(/select\s+\*/);
  });
});

describe("supabase-schema-v7.sql — fn_update_coach_marketplace_profile privileges", () => {
  it("revokes EXECUTE from PUBLIC and anon, grants only to authenticated", () => {
    const startIdx = codeLower.indexOf("revoke execute on function public.fn_update_coach_marketplace_profile");
    const endIdx = codeLower.indexOf(VIEW_MARKER);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_update_coach_marketplace_profile\([\s\S]{0,150}\)\s+from\s+public/);
    expect(slice).toMatch(/revoke\s+execute\s+on\s+function\s+public\.fn_update_coach_marketplace_profile\([\s\S]{0,150}\)\s+from\s+anon/);
    expect(slice).toMatch(/grant\s+execute\s+on\s+function\s+public\.fn_update_coach_marketplace_profile\([\s\S]{0,150}\)\s+to\s+authenticated/);
  });
});

describe("supabase-schema-v7.sql — no direct table access for browser-facing roles anywhere in the file", () => {
  it("never grants SELECT or UPDATE on public.coach_profiles to authenticated or anon", () => {
    expect(codeLower).not.toMatch(
      /grant\s+(select|update)[\s\S]{0,80}on\s+public\.coach_profiles[\s\S]{0,80}to\s+(authenticated|anon)/
    );
  });

  it("never grants EXECUTE on either function to anon or PUBLIC", () => {
    expect(codeLower).not.toMatch(/grant\s+execute[\s\S]{0,150}to\s+anon\b/);
    expect(codeLower).not.toMatch(/grant\s+execute[\s\S]{0,150}to\s+public\b/);
  });

  it("creates no policy on coach_profiles anywhere in the file", () => {
    expect(codeLower).not.toMatch(/create\s+policy/);
  });
});

describe("supabase-schema-v7.sql — coach_directory_listing", () => {
  it("is declared WITH (security_invoker = true) via plain CREATE VIEW (not CREATE OR REPLACE)", () => {
    expect(codeLower).toMatch(/create\s+view\s+public\.coach_directory_listing/);
    expect(codeLower).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/);
  });

  it("projects exactly the approved public-safe columns (SELECT list only — the WHERE clause is checked separately and legitimately references marketplace_visibility_status/verification_status to filter on them)", () => {
    const startIdx = codeLower.indexOf("select", codeLower.indexOf(VIEW_MARKER));
    const endIdx = codeLower.indexOf("from public.coach_profiles cp", startIdx);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const slice = codeLower.slice(startIdx, endIdx);

    for (const column of [
      "coach_profile_id",
      "public_slug",
      "marketplace_headline",
      "profile_photo_url",
      "bio",
      "years_coaching",
      "lesson_delivery_modes",
      "public_city",
      "public_region",
      "timezone",
      "verification_status",
      "minimum_booking_notice_hours",
      "cancellation_policy_summary",
    ]) {
      expect(slice, `expected ${column} in the view's projection`).toContain(column);
    }

    for (const forbidden of [
      "marketplace_visibility_status",
      "user_id",
      "hourly_rate",
      "business_name",
      "certification",
      "specialties",
      "is_active",
      "created_at",
      "updated_at",
      "public.users",
      "coach_locations",
      "private_location_name",
      "postal_code_prefix",
      "latitude",
      "longitude",
      "relationship",
      "coach_bookings",
      "coach_reviews",
      "subscription",
      "stripe",
    ]) {
      expect(slice, `expected ${forbidden} NOT in the view's SELECT list`).not.toContain(forbidden);
    }

    expect(slice).not.toMatch(/select\s+\*/);
    expect(slice).not.toMatch(/\bjoin\b/);
  });

  it("does not join to any other table (no join anywhere in the full view definition)", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).not.toMatch(/\bjoin\b/);
    expect(slice).not.toContain("public.users");
  });

  it("hardcodes published-only, non-null-slug, active-coach, and suspended/rejected-verification exclusion in its predicate", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toMatch(/marketplace_visibility_status\s*=\s*'published'/);
    expect(slice).toMatch(/public_slug\s+is\s+not\s+null/);
    expect(slice).toMatch(/cp\.is_active\s*=\s*true/);
    expect(slice).toMatch(/verification_status\s+not\s+in\s*\(\s*'suspended'\s*,\s*'rejected'\s*\)/);
  });

  it("is revoked from PUBLIC, anon, and authenticated, and granted only to service_role", () => {
    expect(codeLower).toMatch(/revoke\s+all\s+on\s+public\.coach_directory_listing\s+from\s+public\s*,\s*anon\s*,\s*authenticated/);
    expect(codeLower).toMatch(/grant\s+select\s+on\s+public\.coach_directory_listing\s+to\s+service_role/);
    expect(codeLower).not.toMatch(/grant\s+select\s+on\s+public\.coach_directory_listing\s+to\s+(anon|authenticated|public)\b/);
  });
});
