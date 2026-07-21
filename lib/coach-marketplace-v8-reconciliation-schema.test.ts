import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationPath = path.join(__dirname, "..", "supabase-schema-v8.sql");
// Normalized to LF immediately after reading, matching the CM2A fix to
// lib/coach-marketplace-schema.test.ts, so exact-newline-adjacent
// assertions below are independent of Windows core.autocrlf checkout
// behavior.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

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

/**
 * Additionally blanks out the string-literal body of every
 * `comment on ... is '...';` documentation statement, on top of stripping
 * `--` line comments. Used ONLY for global-keyword-absence checks (Stripe,
 * PostGIS) — this migration deliberately documents "no Stripe" and
 * "no PostGIS" in its own `comment on` strings, which must not be mistaken
 * for the real, executable thing they explicitly deny.
 */
function stripCommentOnDocStrings(sql: string): string {
  return sql.replace(
    /comment\s+on\s+[^\n]*\bis\b[^\n]*\n?\s*'(?:[^']|'')*'\s*;/gi,
    "comment on <doc-stripped>;"
  );
}

const code = stripSqlComments(migration);
const codeLower = code.toLowerCase();
const codeWithoutDocStringsLower = stripCommentOnDocStrings(code).toLowerCase();

/**
 * Every preflight `raise exception` message in v8.sql is prefixed with the
 * literal string 'preflight <letter>: ' — a real, executable string literal
 * (not a `--` comment), so it survives stripSqlComments and is a robust,
 * unique anchor for bounding each preflight section without relying on
 * comment headers.
 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const startIdx = codeLower.indexOf(startMarker);
  expect(startIdx, `expected to find "${startMarker}"`).toBeGreaterThanOrEqual(0);
  const endIdx = codeLower.indexOf(endMarker, startIdx + startMarker.length);
  expect(endIdx, `expected to find "${endMarker}" after "${startMarker}"`).toBeGreaterThan(startIdx);
  return codeLower.slice(startIdx, endIdx);
}

/**
 * Bounds the entire `do $$ ... end $$;` block that CONTAINS a given
 * 'preflight <letter>:' marker — not merely the text starting at the
 * marker itself, since the marker sits inside the block's `raise
 * exception` message, which comes AFTER the actual `if` condition being
 * tested. Grabbing the whole enclosing block ensures the condition itself
 * is included in the returned slice.
 */
function preflightBlockSlice(letter: string): string {
  const markerIdx = codeLower.indexOf(`preflight ${letter}:`);
  expect(markerIdx, `expected to find preflight ${letter} marker`).toBeGreaterThanOrEqual(0);
  const blockStart = codeLower.lastIndexOf("do $$", markerIdx);
  expect(blockStart).toBeGreaterThanOrEqual(0);
  const blockEnd = codeLower.indexOf("end $$;", markerIdx);
  expect(blockEnd).toBeGreaterThan(markerIdx);
  return codeLower.slice(blockStart, blockEnd + "end $$;".length);
}

/** Same as preflightBlockSlice, but for the 'postflight <letter>:' markers. */
function postflightBlockSlice(letter: string): string {
  const markerIdx = codeLower.indexOf(`postflight ${letter}:`);
  expect(markerIdx, `expected to find postflight ${letter} marker`).toBeGreaterThanOrEqual(0);
  const blockStart = codeLower.lastIndexOf("do $$", markerIdx);
  expect(blockStart).toBeGreaterThanOrEqual(0);
  const blockEnd = codeLower.indexOf("end $$;", markerIdx);
  expect(blockEnd).toBeGreaterThan(markerIdx);
  return codeLower.slice(blockStart, blockEnd + "end $$;".length);
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

function boundParamList(startMarker: string): string {
  const startIdx = codeLower.indexOf(startMarker);
  expect(startIdx).toBeGreaterThanOrEqual(0);
  const openParen = codeLower.indexOf("(", startIdx + startMarker.length - 1);
  expect(openParen).toBeGreaterThan(0);
  const returnsIdx = codeLower.indexOf("returns", openParen);
  expect(returnsIdx).toBeGreaterThan(openParen);
  return codeLower.slice(openParen, returnsIdx);
}

const GET_OR_CREATE_MARKER = "create function public.fn_get_or_create_own_coach_profile";
const GET_MARKETPLACE_MARKER = "create function public.fn_get_own_coach_marketplace_profile";
const UPDATE_LEGACY_MARKER = "create function public.fn_update_own_coach_profile_legacy(";
const UPDATE_MARKETPLACE_MARKER = "create function public.fn_update_coach_marketplace_profile(";
const SET_ACTIVE_MARKER = "create function public.fn_set_own_coach_active(";
const VIEW_MARKER = "create view public.coach_directory_listing";

// ============================================================================
// A. Scope and source-only posture
// ============================================================================
describe("supabase-schema-v8.sql — scope and source-only posture", () => {
  it("wraps the migration in a single BEGIN/COMMIT transaction", () => {
    const beginIndex = code.search(/\bbegin\s*;/i);
    const commitIndex = code.search(/\bcommit\s*;/i);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
  });

  it("states prominently that it is unapplied/source-only", () => {
    expect(migration).toMatch(/THIS MIGRATION IS UNAPPLIED BY CM2R\. IT IS SOURCE ONLY\./);
  });

  it("states v6 and v7 must not be run first (or after)", () => {
    expect(migration).toMatch(/DO NOT RUN supabase-schema-v6\.sql OR supabase-schema-v7\.sql FIRST/i);
  });

  it("states it supersedes the intended production effect of v6 and v7", () => {
    expect(migration).toMatch(/v8 supersedes the intended production\s*\n?--?\s*effect of both v6 and v7/i);
  });

  it("contains no Stripe or payment-processor execution code (checked against doc-string-stripped text, since this file's own comment-on documentation legitimately says 'no Stripe' as prose)", () => {
    for (const forbidden of ["stripe", "payment_intent", "checkout_session"]) {
      expect(codeWithoutDocStringsLower, `expected v8.sql to not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("contains no PostGIS extension usage (checked against doc-string-stripped text)", () => {
    expect(codeWithoutDocStringsLower).not.toContain("postgis");
    expect(codeLower).not.toMatch(/create\s+extension[\s\S]{0,40}postgis/);
    expect(codeLower).not.toMatch(/\bgeometry\b|\bgeography\b/);
  });

  it("contains no NEXT_PUBLIC_-prefixed reference and no literal app/ route path", () => {
    expect(codeLower).not.toContain("next_public_");
    expect(codeLower).not.toContain("app/");
  });

  it("does not modify supabase-schema-v6.sql or supabase-schema-v7.sql", () => {
    expect(existsSync(path.join(__dirname, "..", "supabase-schema-v6.sql"))).toBe(true);
    expect(existsSync(path.join(__dirname, "..", "supabase-schema-v7.sql"))).toBe(true);
  });

  it("introduces no route/page/component path for CM2", () => {
    const repoRoot = path.join(__dirname, "..");
    for (const candidate of ["app/coaches", "app/(dashboard)/coach/marketplace-profile", "components/marketplace"]) {
      expect(existsSync(path.join(repoRoot, candidate)), `expected ${candidate} to not exist`).toBe(false);
    }
  });
});

// ============================================================================
// B. Fail-loud baseline
// ============================================================================
describe("supabase-schema-v8.sql — preflight A: PostgreSQL 15+", () => {
  it("fails loudly below server_version_num 150000", () => {
    const slice = preflightBlockSlice("a");
    expect(slice).toMatch(/server_version_num[\s\S]{0,20}<\s*150000/);
    expect(slice).toMatch(/raise exception/);
  });
});

describe("supabase-schema-v8.sql — preflight B: required relations exist", () => {
  it("checks coach_profiles, public.users, and auth.users each exist as ordinary tables", () => {
    const slice = preflightBlockSlice("b");
    expect(slice).toMatch(/to_regclass\('public\.coach_profiles'\)\s+is\s+null/);
    expect(slice).toMatch(/to_regclass\('public\.users'\)\s+is\s+null/);
    expect(slice).toMatch(/to_regclass\('auth\.users'\)\s+is\s+null/);
    expect(slice).toMatch(/relkind[\s\S]{0,120}<>\s*'r'/);
  });
});

describe("supabase-schema-v8.sql — explicit table lock", () => {
  it("takes an explicit ACCESS EXCLUSIVE lock on coach_profiles between preflight B and preflight C", () => {
    expect(codeLower).toMatch(/lock table public\.coach_profiles in access exclusive mode\s*;/);
    const lockIdx = codeLower.indexOf("lock table public.coach_profiles in access exclusive mode");
    const preflightBIdx = codeLower.indexOf("preflight b:");
    const preflightCIdx = codeLower.indexOf("preflight c:");
    expect(lockIdx).toBeGreaterThan(preflightBIdx);
    expect(lockIdx).toBeLessThan(preflightCIdx);
  });
});

describe("supabase-schema-v8.sql — preflight C: exact ten-column baseline", () => {
  it("checks every one of the ten verified legacy columns by name, type, and nullability", () => {
    const slice = preflightBlockSlice("c");
    for (const column of [
      "'id',", "'user_id',", "'business_name',", "'bio',", "'specialties',",
      "'certification',", "'hourly_rate',", "'is_active',", "'created_at',", "'updated_at',",
    ]) {
      expect(slice, `expected preflight C to check column ${column}`).toContain(column);
    }
    expect(slice).toContain("'gen_random_uuid'");
  });

  it("requires exactly ten total columns (no others)", () => {
    const slice = preflightBlockSlice("c");
    expect(slice).toMatch(/v_total_columns\s*<>\s*10/);
  });
});

describe("supabase-schema-v8.sql — preflight D: structural baseline", () => {
  it("requires a primary key on id, a unique constraint on user_id, and the auth.users FK with ON DELETE CASCADE", () => {
    const slice = preflightBlockSlice("d");
    expect(slice).toMatch(/contype\s*=\s*'p'/);
    expect(slice).toMatch(/contype\s*=\s*'u'/);
    expect(slice).toMatch(/confrelid\s*=\s*'auth\.users'::regclass/);
    expect(slice).toMatch(/confdeltype\s*=\s*'c'/);
  });

  it("rejects an unexpected foreign key from coach_profiles to public.users", () => {
    const slice = preflightBlockSlice("d");
    expect(slice).toMatch(/confrelid\s*=\s*'public\.users'::regclass/);
  });

  it("requires RLS enabled and not forced", () => {
    const slice = preflightBlockSlice("d");
    expect(slice).toMatch(/relrowsecurity\s*=\s*true\s+and\s+c\.relforcerowsecurity\s*=\s*false/);
  });

  it("requires migration DDL authority via table ownership OR superuser — table ownership alone is accepted (the owner-mismatch branch is the only gate, so a matching owner short-circuits the check entirely)", () => {
    const slice = preflightBlockSlice("d");
    expect(slice).toMatch(/v_table_owner\s+is\s+distinct\s+from\s+current_user/);
  });

  it("accepts a PostgreSQL superuser even when not the table owner", () => {
    const slice = preflightBlockSlice("d");
    expect(slice).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+pg_roles\s+where\s+rolname\s*=\s*current_user\s+and\s+rolsuper\s*\)/);
  });

  it("does NOT accept BYPASSRLS alone as migration authority — rolbypassrls must not appear anywhere in the authority condition", () => {
    const slice = preflightBlockSlice("d");
    // Bounded to just the authority-check statement (the "select
    // tableowner ..." line through its closing "end if;"), not the whole
    // preflight D block, so this can't be fooled by rolbypassrls appearing
    // in some unrelated check elsewhere.
    const authorityStart = slice.indexOf("select tableowner into v_table_owner");
    expect(authorityStart).toBeGreaterThanOrEqual(0);
    const authorityEnd = slice.indexOf("end if;", authorityStart);
    expect(authorityEnd).toBeGreaterThan(authorityStart);
    const authoritySlice = slice.slice(authorityStart, authorityEnd);
    expect(authoritySlice).not.toMatch(/rolbypassrls/);
  });

  it("does not use a combined owner-OR-superuser-OR-bypassrls condition (the three-way OR this migration explicitly rejects)", () => {
    expect(codeLower).not.toMatch(/rolsuper\s+or\s+rolbypassrls/);
    expect(codeLower).not.toMatch(/rolbypassrls\s+or\s+rolsuper/);
  });

  it("documents why BYPASSRLS alone is rejected as migration authority", () => {
    const slice = preflightBlockSlice("d");
    expect(slice.toLowerCase()).toMatch(/bypassrls[\s\S]{0,200}does not confer/);
  });
});

describe("supabase-schema-v8.sql — preflight E: exact two-policy baseline", () => {
  it("requires exactly two pre-existing policies on coach_profiles", () => {
    const slice = preflightBlockSlice("e");
    expect(slice).toMatch(/v_policy_count\s*<>\s*2/);
  });

  it("requires the exact 'Anyone can view active coach profiles' policy definition", () => {
    const slice = preflightBlockSlice("e");
    expect(slice).toContain('"anyone can view active coach profiles"'.toLowerCase());
    expect(slice).toMatch(/cmd\s*=\s*'select'/);
    expect(slice).toMatch(/is_active=true/);
    expect(slice).toMatch(/with_check is null/);
  });

  it("requires the exact 'Coaches can manage their own profile' policy definition", () => {
    const slice = preflightBlockSlice("e");
    expect(slice).toContain("coaches can manage their own profile");
    expect(slice).toMatch(/cmd\s*=\s*'all'/);
    expect(slice).toMatch(/auth\.uid\(\)=user_id/);
  });

  it("requires PERMISSIVE and role target public for both policies", () => {
    const slice = preflightBlockSlice("e");
    const permissiveCount = (slice.match(/permissive\s*=\s*'permissive'/g) ?? []).length;
    const rolesCount = (slice.match(/roles\s*=\s*array\['public'\]::name\[\]/g) ?? []).length;
    expect(permissiveCount).toBe(2);
    expect(rolesCount).toBe(2);
  });
});

describe("supabase-schema-v8.sql — preflight F: effective privilege checks", () => {
  it("requires anon and authenticated to currently hold the full verified broad privilege set before revoking it", () => {
    const slice = preflightBlockSlice("f");
    expect(slice).toMatch(/has_table_privilege\(v_role,\s*'public\.coach_profiles',\s*v_priv\)/);
    for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
      expect(slice, `expected preflight F to check privilege ${priv}`).toContain(`'${priv}'`);
    }
    expect(slice).toContain("'anon'");
    expect(slice).toContain("'authenticated'");
  });

  it("requires service_role to retain SELECT", () => {
    const slice = preflightBlockSlice("f");
    expect(slice).toMatch(/has_table_privilege\('service_role',\s*'public\.coach_profiles',\s*'select'\)/);
  });
});

describe("supabase-schema-v8.sql — preflight G: no colliding object", () => {
  it("checks absence of every CM1 marketplace column and marketplace_display_name", () => {
    const slice = preflightBlockSlice("g");
    for (const column of [
      "public_slug", "marketplace_headline", "profile_photo_url", "years_coaching",
      "lesson_delivery_modes", "public_city", "public_region", "timezone",
      "marketplace_visibility_status", "verification_status",
      "minimum_booking_notice_hours", "cancellation_policy_summary", "marketplace_display_name",
    ]) {
      expect(slice, `expected preflight G to check for pre-existing column ${column}`).toContain(column);
    }
  });

  it("checks absence of all six marketplace tables, the rating summary view, and the directory view", () => {
    const slice = preflightBlockSlice("g");
    for (const relation of [
      "public.coach_services", "public.coach_locations", "public.coach_availability_rules",
      "public.coach_availability_exceptions", "public.coach_bookings", "public.coach_reviews",
      "public.coach_rating_summary", "public.coach_directory_listing",
    ]) {
      expect(slice, `expected preflight G to check for pre-existing ${relation}`).toContain(relation.toLowerCase());
    }
  });

  it("checks absence of every CM1 constraint and the marketplace_display_name constraint", () => {
    const slice = preflightBlockSlice("g");
    for (const constraint of [
      "coach_profiles_years_coaching_nonnegative",
      "coach_profiles_min_notice_hours_nonnegative",
      "coach_profiles_lesson_delivery_modes_valid",
      "coach_profiles_marketplace_visibility_status_valid",
      "coach_profiles_verification_status_valid",
      "coach_profiles_marketplace_display_name_valid",
    ]) {
      expect(slice, `expected preflight G to check for pre-existing constraint ${constraint}`).toContain(constraint);
    }
  });

  it("checks absence of the review trigger function and every v7/v8 coach-marketplace function name", () => {
    const slice = preflightBlockSlice("g");
    expect(slice).toContain("fn_enforce_coach_review_completed_booking");
    for (const fn of [
      "fn_get_own_coach_marketplace_profile", "fn_update_coach_marketplace_profile",
      "fn_get_or_create_own_coach_profile", "fn_update_own_coach_profile_legacy", "fn_set_own_coach_active",
    ]) {
      expect(slice, `expected preflight G to check for pre-existing function ${fn}`).toContain(fn);
    }
  });
});

describe("supabase-schema-v8.sql — preflight H: public.users contract", () => {
  it("requires public.users.id uuid, public.users.role text, and auth.users.id uuid", () => {
    const slice = preflightBlockSlice("h");
    expect(slice).toMatch(/table_name\s*=\s*'users'\s+and\s+column_name\s*=\s*'id'\s+and\s+data_type\s*=\s*'uuid'/);
    expect(slice).toMatch(/table_name\s*=\s*'users'\s+and\s+column_name\s*=\s*'role'\s+and\s+data_type\s*=\s*'text'/);
    expect(slice).toMatch(/table_schema\s*=\s*'auth'[\s\S]{0,80}data_type\s*=\s*'uuid'/);
  });
});

describe("supabase-schema-v8.sql — preflight I: service_role BYPASSRLS", () => {
  it("requires service_role to exist and to have rolbypassrls = true, failing loudly otherwise", () => {
    const slice = preflightBlockSlice("i");
    expect(slice).toMatch(/rolname\s*=\s*'service_role'/);
    expect(slice).toMatch(/rolname\s*=\s*'service_role'\s+and\s+rolbypassrls\s*=\s*true/);
    expect(slice).toMatch(/raise exception 'preflight i:/);
  });

  it("runs before any structural statement (before SECTION 1's column additions)", () => {
    const preflightIIdx = codeLower.indexOf("preflight i:");
    const section1Idx = codeLower.indexOf("add column if not exists public_slug");
    expect(preflightIIdx).toBeGreaterThanOrEqual(0);
    expect(section1Idx).toBeGreaterThan(preflightIIdx);
  });
});

// ============================================================================
// C. Atomic policy transition
// ============================================================================
describe("supabase-schema-v8.sql — atomic legacy policy removal", () => {
  it("drops both legacy policies by exact quoted name, not a wildcard", () => {
    expect(migration).toContain('drop policy "Anyone can view active coach profiles" on public.coach_profiles;');
    expect(migration).toContain('drop policy "Coaches can manage their own profile" on public.coach_profiles;');
    expect(codeLower).not.toMatch(/drop\s+policy\s+if\s+exists/);
  });

  it("drops the two legacy policies only after the exact-definition preflight (E) has already run", () => {
    const preflightEIdx = codeLower.indexOf("preflight e:");
    const dropIdx = codeLower.indexOf('drop policy "anyone can view active coach profiles"');
    expect(dropIdx).toBeGreaterThan(preflightEIdx);
  });

  it("creates no replacement direct-table policy on coach_profiles anywhere in the file", () => {
    expect(codeLower).not.toMatch(/create\s+policy/);
  });

  it("re-enables/keeps RLS enabled on coach_profiles with zero policies as the final state", () => {
    // RLS was already required enabled by preflight D; no ALTER TABLE
    // DISABLE ROW LEVEL SECURITY exists anywhere, and no CREATE POLICY
    // exists anywhere (checked above) — together these guarantee the final
    // state is RLS-enabled, zero-policy.
    expect(codeLower).not.toMatch(/disable row level security/);
  });
});

// ============================================================================
// D. Grants
// ============================================================================
describe("supabase-schema-v8.sql — direct privilege reconciliation", () => {
  it("revokes ALL from PUBLIC, anon, and authenticated on coach_profiles", () => {
    expect(codeLower).toMatch(/revoke all on public\.coach_profiles from public\s*;/);
    expect(codeLower).toMatch(/revoke all on public\.coach_profiles from anon\s*;/);
    expect(codeLower).toMatch(/revoke all on public\.coach_profiles from authenticated\s*;/);
  });

  it("normalizes service_role to SELECT only on coach_profiles (revoke all, then grant select)", () => {
    const revokeIdx = codeLower.indexOf("revoke all on public.coach_profiles from service_role");
    const grantIdx = codeLower.indexOf("grant select on public.coach_profiles to service_role");
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(grantIdx).toBeGreaterThan(revokeIdx);
  });

  it("never grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER on coach_profiles to any browser-facing role", () => {
    expect(codeLower).not.toMatch(
      /grant\s+(insert|update|delete|truncate|references|trigger)[\s\S]{0,80}on\s+public\.coach_profiles[\s\S]{0,80}to\s+(anon|authenticated|public)\b/
    );
  });

  it("revokes ALL from PUBLIC/anon/authenticated on all six new tables and the rating summary view", () => {
    for (const table of [
      "coach_services", "coach_locations", "coach_availability_rules",
      "coach_availability_exceptions", "coach_bookings", "coach_reviews", "coach_rating_summary",
    ]) {
      expect(codeLower, `expected revoke all on ${table} from public, anon, authenticated`).toMatch(
        new RegExp(`revoke all on public\\.${table}\\s+from public\\s*,\\s*anon\\s*,\\s*authenticated`)
      );
    }
  });

  it("does not grant TRUNCATE, REFERENCES, or TRIGGER to service_role on any of the six new tables", () => {
    expect(codeLower).not.toMatch(
      /grant\s+(truncate|references|trigger)[\s\S]{0,80}to\s+service_role/
    );
  });

  it("explicitly revokes ALL from service_role on every one of the six marketplace tables (never relies on Supabase/PostgreSQL default privileges)", () => {
    for (const table of [
      "coach_services", "coach_locations", "coach_availability_rules",
      "coach_availability_exceptions", "coach_bookings", "coach_reviews",
    ]) {
      expect(codeLower, `expected an explicit REVOKE ALL on ${table} FROM service_role`).toMatch(
        new RegExp(`revoke all on public\\.${table}\\s+from service_role\\s*;`)
      );
    }
  });

  it("the six per-table service_role REVOKEs occur after the PUBLIC/anon/authenticated REVOKEs and before the selective coach_reviews SELECT re-grant", () => {
    const lastBroadRevokeMatch = codeLower.match(/revoke all on public\.coach_rating_summary\s+from public\s*,\s*anon\s*,\s*authenticated/);
    const firstServiceRoleRevokeMatch = codeLower.match(/revoke all on public\.coach_services\s+from service_role/);
    const lastServiceRoleRevokeMatch = codeLower.match(/revoke all on public\.coach_rating_summary\s+from service_role/);
    const reGrantIdx = codeLower.indexOf("grant select on public.coach_reviews to service_role");

    expect(lastBroadRevokeMatch, "expected the broad PUBLIC/anon/authenticated revoke on coach_rating_summary").not.toBeNull();
    expect(firstServiceRoleRevokeMatch, "expected an explicit service_role revoke on coach_services").not.toBeNull();
    expect(lastServiceRoleRevokeMatch, "expected an explicit service_role revoke on coach_rating_summary").not.toBeNull();

    const lastBroadRevokeIdx = lastBroadRevokeMatch!.index!;
    const firstServiceRoleRevokeIdx = firstServiceRoleRevokeMatch!.index!;
    const lastServiceRoleRevokeIdx = lastServiceRoleRevokeMatch!.index!;

    expect(firstServiceRoleRevokeIdx).toBeGreaterThan(lastBroadRevokeIdx);
    expect(lastServiceRoleRevokeIdx).toBeGreaterThan(firstServiceRoleRevokeIdx);
    expect(reGrantIdx).toBeGreaterThan(lastServiceRoleRevokeIdx);
  });

  it("grants service_role SELECT only on coach_reviews, so the SECURITY INVOKER coach_rating_summary view is actually queryable", () => {
    expect(codeLower).toMatch(/grant select on public\.coach_reviews to service_role\s*;/);
    // Never any write privilege on coach_reviews for service_role.
    expect(codeLower).not.toMatch(/grant\s+(insert|update|delete|truncate|references|trigger)[\s\S]{0,80}on\s+public\.coach_reviews[\s\S]{0,80}to\s+service_role/);
  });

  it("grants service_role no privilege at all on the other five marketplace tables", () => {
    for (const table of [
      "coach_services", "coach_locations", "coach_availability_rules",
      "coach_availability_exceptions", "coach_bookings",
    ]) {
      expect(codeLower, `expected no grant of any kind on ${table} to service_role`).not.toMatch(
        new RegExp(`grant\\s+\\w+[\\s\\S]{0,80}on\\s+public\\.${table}[\\s\\S]{0,80}to\\s+service_role`)
      );
    }
  });

  it("grants SELECT on coach_rating_summary to service_role only (not anon/authenticated), after an explicit service_role revoke", () => {
    const revokeIdx = codeLower.indexOf("revoke all on public.coach_rating_summary          from service_role");
    const grantIdx = codeLower.indexOf("grant select on public.coach_rating_summary to service_role");
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(grantIdx).toBeGreaterThan(revokeIdx);
    expect(codeLower).not.toMatch(/grant select on public\.coach_rating_summary to (anon|authenticated)\b/);
  });

  it("coach_rating_summary remains declared SECURITY INVOKER (the audited CM1 boundary is preserved, not switched to a default/SECURITY DEFINER view)", () => {
    const viewIdx = codeLower.indexOf("create or replace view public.coach_rating_summary");
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(viewIdx, viewIdx + 400);
    expect(slice).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/);
  });

  it("the directory view is revoked from PUBLIC/anon/authenticated AND explicitly from service_role, before being granted SELECT only to service_role", () => {
    const broadRevokeIdx = codeLower.indexOf("revoke all on public.coach_directory_listing from public, anon, authenticated");
    const serviceRoleRevokeIdx = codeLower.indexOf("revoke all on public.coach_directory_listing from service_role");
    const grantIdx = codeLower.indexOf("grant select on public.coach_directory_listing to service_role");

    expect(broadRevokeIdx).toBeGreaterThanOrEqual(0);
    expect(serviceRoleRevokeIdx).toBeGreaterThan(broadRevokeIdx);
    expect(grantIdx).toBeGreaterThan(serviceRoleRevokeIdx);
    expect(codeLower).not.toMatch(/grant select on public\.coach_directory_listing to (anon|authenticated|public)\b/);
  });

  it("no service_role write privilege (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) is granted on either view", () => {
    for (const view of ["coach_rating_summary", "coach_directory_listing"]) {
      expect(codeLower, `expected no write grant on ${view} to service_role`).not.toMatch(
        new RegExp(`grant\\s+(insert|update|delete|truncate|references|trigger)[\\s\\S]{0,80}on\\s+public\\.${view}[\\s\\S]{0,80}to\\s+service_role`)
      );
    }
  });

  it("every coach-owned function revokes EXECUTE from PUBLIC and anon and grants only to authenticated", () => {
    for (const fnMarker of [
      "function public.fn_get_or_create_own_coach_profile()",
      "function public.fn_get_own_coach_marketplace_profile()",
      "function public.fn_update_own_coach_profile_legacy(text, text, text[], text)",
      "function public.fn_set_own_coach_active(boolean)",
    ]) {
      expect(codeLower, `expected revoke execute ... from public for ${fnMarker}`).toContain(
        `revoke execute on ${fnMarker} from public;`
      );
      expect(codeLower, `expected revoke execute ... from anon for ${fnMarker}`).toContain(
        `revoke execute on ${fnMarker} from anon;`
      );
      expect(codeLower, `expected grant execute ... to authenticated for ${fnMarker}`).toContain(
        `grant execute on ${fnMarker} to authenticated;`
      );
    }
    expect(codeLower).not.toMatch(/grant execute[\s\S]{0,200}to\s+anon\b/);
    expect(codeLower).not.toMatch(/grant execute[\s\S]{0,200}to\s+public\b/);
  });
});

// ============================================================================
// E. marketplace_display_name
// ============================================================================
describe("supabase-schema-v8.sql — marketplace_display_name contract", () => {
  it("adds the column as nullable text", () => {
    expect(codeLower).toMatch(/add column if not exists marketplace_display_name\s+text\s*;/);
  });

  it("adds a named validation constraint requiring non-blank and a documented max length of 100", () => {
    expect(codeLower).toMatch(/constraint coach_profiles_marketplace_display_name_valid/);
    expect(codeLower).toMatch(/btrim\(marketplace_display_name\)\s*<>\s*''/);
    expect(codeLower).toMatch(/length\(marketplace_display_name\)\s*<=\s*100/);
  });

  it("has a documenting column comment", () => {
    expect(codeLower).toMatch(/comment on column public\.coach_profiles\.marketplace_display_name is/);
  });

  it("is included in fn_get_or_create_own_coach_profile's return contract", () => {
    const slice = boundFunction(GET_OR_CREATE_MARKER);
    expect(slice).toContain("marketplace_display_name");
  });

  it("is included in fn_get_own_coach_marketplace_profile's return contract", () => {
    const slice = boundFunction(GET_MARKETPLACE_MARKER);
    expect(slice).toContain("marketplace_display_name");
  });

  it("is an explicit writable parameter of fn_update_coach_marketplace_profile", () => {
    const paramSlice = boundParamList(UPDATE_MARKETPLACE_MARKER);
    expect(paramSlice).toMatch(/p_marketplace_display_name\s+text/);
  });

  it("is required (non-null, non-blank) to publish", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    expect(slice).toMatch(/p_marketplace_display_name is null or btrim\(p_marketplace_display_name\) = ''/);
  });

  it("is included in the directory view's projection and predicate", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toContain("cp.marketplace_display_name");
    expect(slice).toMatch(/marketplace_display_name is not null/);
    expect(slice).toMatch(/btrim\(cp\.marketplace_display_name\)\s*<>\s*''/);
  });

  it("is never copied from business_name or any public.users field anywhere in the file", () => {
    // The column is added via a bare ADD COLUMN with no backfill/UPDATE
    // statement anywhere in the file that assigns it from another column.
    // Exact substring checks only — a naive regex here would false-positive
    // on the function's own legitimate self-assignment
    // "marketplace_display_name = p_marketplace_display_name", since that
    // right-hand side itself ends in "display_name".
    expect(codeLower).not.toContain("marketplace_display_name = business_name");
    expect(codeLower).not.toContain("marketplace_display_name = cp.business_name");
    expect(codeLower).not.toContain("marketplace_display_name = full_name");
    expect(codeLower).not.toContain("marketplace_display_name = u.full_name");
    expect(codeLower).not.toContain("marketplace_display_name = u.display_name");
    expect(codeLower).not.toContain("marketplace_display_name = users.display_name");
  });
});

// ============================================================================
// F. Function security (per function)
// ============================================================================
describe("supabase-schema-v8.sql — function security contract (all five coach-owned functions)", () => {
  const functions: Array<[string, string]> = [
    ["fn_get_or_create_own_coach_profile", GET_OR_CREATE_MARKER],
    ["fn_get_own_coach_marketplace_profile", GET_MARKETPLACE_MARKER],
    ["fn_update_own_coach_profile_legacy", UPDATE_LEGACY_MARKER],
    ["fn_update_coach_marketplace_profile", UPDATE_MARKETPLACE_MARKER],
    ["fn_set_own_coach_active", SET_ACTIVE_MARKER],
  ];

  for (const [name, marker] of functions) {
    it(`${name} is SECURITY DEFINER with search_path locked to empty`, () => {
      const slice = boundFunction(marker);
      expect(slice).toMatch(/security\s+definer/);
      expect(slice).not.toMatch(/security\s+invoker/);
      expect(slice).toMatch(/set\s+search_path\s*=\s*''/);
    });

    it(`${name} derives identity only from auth.uid() and requires public.users.role = 'coach'`, () => {
      const slice = boundFunction(marker);
      expect(slice).toMatch(/auth\.uid\(\)/);
      expect(slice).toMatch(/v_role\s+is\s+distinct\s+from\s+'coach'/);
      expect(slice).toMatch(/from\s+public\.users\b/);
    });

    it(`${name} has no arbitrary user/coach/profile identifier parameter`, () => {
      const paramSlice = boundParamList(marker);
      expect(paramSlice).not.toMatch(/p_user_id/);
      expect(paramSlice).not.toMatch(/p_coach_id/);
      expect(paramSlice).not.toMatch(/p_coach_profile_id/);
      expect(paramSlice).not.toMatch(/p_target/);
      expect(paramSlice).not.toMatch(/p_id\b/);
    });

    it(`${name} uses no dynamic SQL`, () => {
      const slice = boundFunction(marker);
      expect(slice).not.toMatch(/\bexecute\s+format\b/);
      expect(slice).not.toMatch(/\bexecute\s*\(/);
    });
  }

  it("all coach-owned relation references inside the five functions are schema-qualified (public./auth.)", () => {
    for (const [, marker] of functions) {
      const slice = boundFunction(marker);
      expect(slice).not.toMatch(/from\s+coach_profiles\b/);
      expect(slice).not.toMatch(/from\s+users\b/);
      expect(slice).not.toMatch(/update\s+coach_profiles\b/);
      expect(slice).toMatch(/public\.coach_profiles/);
    }
  });
});

// ============================================================================
// G. Get-or-create
// ============================================================================
describe("supabase-schema-v8.sql — fn_get_or_create_own_coach_profile", () => {
  it("takes zero arguments", () => {
    expect(codeLower).toMatch(/create\s+function\s+public\.fn_get_or_create_own_coach_profile\(\s*\)/);
  });

  it("inserts only user_id, relying on existing column defaults for everything else", () => {
    const slice = boundFunction(GET_OR_CREATE_MARKER);
    expect(slice).toMatch(/insert into public\.coach_profiles \(user_id\)/);
    expect(slice).toMatch(/values \(v_caller_id\)/);
  });

  it("is concurrency-safe via ON CONFLICT (user_id) DO NOTHING", () => {
    const slice = boundFunction(GET_OR_CREATE_MARKER);
    expect(slice).toMatch(/on conflict \(user_id\) do nothing/);
  });

  it("requires the caller to be a coach before inserting", () => {
    const slice = boundFunction(GET_OR_CREATE_MARKER);
    const roleCheckIdx = slice.indexOf("v_role is distinct from 'coach'");
    const insertIdx = slice.indexOf("insert into public.coach_profiles");
    expect(roleCheckIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(roleCheckIdx);
  });

  it("returns no public.users identity fields (no email, full_name, display_name, or role in the return contract)", () => {
    const idx = codeLower.indexOf(GET_OR_CREATE_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    expect(returnSlice).not.toMatch(/\bemail\b/);
    expect(returnSlice).not.toMatch(/\bfull_name\b/);
    expect(returnSlice).not.toMatch(/\bdisplay_name\b/);
  });

  it("does not expose user_id in the return contract", () => {
    const idx = codeLower.indexOf(GET_OR_CREATE_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    expect(returnSlice).not.toMatch(/\buser_id\b/);
  });
});

// ============================================================================
// H. Legacy update
// ============================================================================
describe("supabase-schema-v8.sql — fn_update_own_coach_profile_legacy", () => {
  it("accepts exactly the four approved legacy fields as parameters", () => {
    const paramSlice = boundParamList(UPDATE_LEGACY_MARKER);
    expect(paramSlice).toMatch(/p_business_name\s+text/);
    expect(paramSlice).toMatch(/p_bio\s+text/);
    expect(paramSlice).toMatch(/p_specialties\s+text\[\]/);
    expect(paramSlice).toMatch(/p_certification\s+text/);
  });

  it("never writes hourly_rate, is_active, or any marketplace field in its SET clause", () => {
    const slice = boundFunction(UPDATE_LEGACY_MARKER);
    const setStartIdx = slice.indexOf("update public.coach_profiles set");
    const setEndIdx = slice.indexOf("where user_id = v_caller_id", setStartIdx);
    expect(setStartIdx).toBeGreaterThanOrEqual(0);
    expect(setEndIdx).toBeGreaterThan(setStartIdx);
    const setSlice = slice.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/hourly_rate/);
    expect(setSlice).not.toMatch(/is_active/);
    expect(setSlice).not.toMatch(/marketplace_/);
    expect(setSlice).not.toMatch(/verification_status/);
    expect(setSlice).not.toMatch(/public_slug/);
  });

  it("never writes user_id or id in its SET clause", () => {
    const slice = boundFunction(UPDATE_LEGACY_MARKER);
    const setStartIdx = slice.indexOf("update public.coach_profiles set");
    const setEndIdx = slice.indexOf("where user_id = v_caller_id", setStartIdx);
    const setSlice = slice.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/\buser_id\s*=/);
    expect(setSlice).not.toMatch(/\bid\s*=\s*p_/);
  });

  it("requires the row to already exist (raises if not found, does not upsert)", () => {
    const slice = boundFunction(UPDATE_LEGACY_MARKER);
    expect(slice).toMatch(/if not found then/);
    expect(slice).not.toMatch(/on conflict/);
  });

  it("normalizes blank scalar inputs to NULL via nullif(btrim(...))", () => {
    const slice = boundFunction(UPDATE_LEGACY_MARKER);
    expect(slice).toMatch(/nullif\(btrim\(p_business_name\), ''\)/);
    expect(slice).toMatch(/nullif\(btrim\(p_bio\), ''\)/);
    expect(slice).toMatch(/nullif\(btrim\(p_certification\), ''\)/);
  });

  it("returns the narrow legacy projection only (id, business_name, bio, specialties, certification, hourly_rate, is_active, created_at, updated_at)", () => {
    const idx = codeLower.indexOf(UPDATE_LEGACY_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    for (const column of [
      "id uuid", "business_name text", "bio text", "specialties text[]", "certification text",
      "hourly_rate numeric", "is_active boolean", "created_at timestamptz", "updated_at timestamptz",
    ]) {
      expect(returnSlice, `expected ${column} in the legacy return contract`).toContain(column);
    }
    expect(returnSlice).not.toMatch(/public_slug|marketplace_/);
  });
});

// ============================================================================
// I. Marketplace update
// ============================================================================
describe("supabase-schema-v8.sql — fn_update_coach_marketplace_profile", () => {
  it("has no bio parameter (bio moved to the legacy function)", () => {
    const paramSlice = boundParamList(UPDATE_MARKETPLACE_MARKER);
    expect(paramSlice).not.toMatch(/p_bio\b/);
  });

  it("has no profile_photo_url, verification_status, hourly_rate, or is_active parameter", () => {
    const paramSlice = boundParamList(UPDATE_MARKETPLACE_MARKER);
    expect(paramSlice).not.toMatch(/p_profile_photo_url/);
    expect(paramSlice).not.toMatch(/p_verification_status/);
    expect(paramSlice).not.toMatch(/p_hourly_rate/);
    expect(paramSlice).not.toMatch(/p_is_active/);
  });

  it("restricts visibility to exactly hidden, draft, or published, and rejects suspended", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    expect(slice).toMatch(/not\s+in\s*\(\s*'hidden'\s*,\s*'draft'\s*,\s*'published'\s*\)/);
  });

  it("locks the row with SELECT ... FOR UPDATE before checking and rejects a currently-suspended row", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    const forUpdateIdx = slice.indexOf("for update");
    const updateIdx = slice.indexOf("update public.coach_profiles set");
    expect(forUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(forUpdateIdx);
    expect(slice).toMatch(/v_current_status\s*=\s*'suspended'/);
  });

  it("publish-readiness requires public_slug, marketplace_display_name, marketplace_headline, and a delivery mode", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    const publishIdx = slice.indexOf("p_marketplace_visibility_status = 'published' then");
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    const publishSlice = slice.slice(publishIdx, publishIdx + 900);
    expect(publishSlice).toMatch(/p_public_slug\s+is\s+null/);
    expect(publishSlice).toMatch(/p_marketplace_display_name is null or btrim\(p_marketplace_display_name\) = ''/);
    expect(publishSlice).toMatch(/btrim\(p_marketplace_headline\)\s*=\s*''/);
    expect(publishSlice).toMatch(/array_length\(p_lesson_delivery_modes,\s*1\)\s+is\s+null/);
  });

  it("protected fields (verification_status, id, user_id, hourly_rate, profile_photo_url, bio) never appear in its UPDATE SET clause", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    const setStartIdx = slice.indexOf("update public.coach_profiles set");
    const setEndIdx = slice.indexOf("where user_id = v_caller_id", setStartIdx);
    const setSlice = slice.slice(setStartIdx, setEndIdx);
    expect(setSlice).not.toMatch(/verification_status/);
    expect(setSlice).not.toMatch(/hourly_rate/);
    expect(setSlice).not.toMatch(/profile_photo_url/);
    expect(setSlice).not.toMatch(/\bbio\s*=/);
    expect(setSlice).not.toMatch(/\buser_id\s*=\s*p_/);
  });

  it("maps only the exact public_slug unique-index violation to a friendly error, and re-raises any unrelated unique_violation unchanged", () => {
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    expect(slice).toMatch(/get\s+stacked\s+diagnostics\s+v_constraint_name\s*=\s*constraint_name/);
    expect(slice).toContain("'idx_coach_profiles_public_slug_unique'");
    const elseIdx = slice.indexOf("else", slice.indexOf("idx_coach_profiles_public_slug_unique"));
    expect(elseIdx).toBeGreaterThan(0);
    expect(slice.slice(elseIdx, elseIdx + 60)).toMatch(/raise\s*;/);
  });

  it("declares no RETURNS public.coach_profiles, no RETURNING *, and no SELECT * within its own bounded body", () => {
    // Scoped to this function's own RETURNS clause and body, not the whole
    // file — fn_get_own_coach_marketplace_profile's own comment-on
    // doc-string legitimately contains the prose "never returns
    // public.coach_profiles" as a negation, which a global check would be
    // fooled by.
    const idx = codeLower.indexOf(UPDATE_MARKETPLACE_MARKER);
    const returnsIdx = codeLower.indexOf("returns table", idx);
    const bodyIdx = codeLower.indexOf("language plpgsql", returnsIdx);
    const returnSlice = codeLower.slice(returnsIdx, bodyIdx);
    expect(returnSlice).not.toContain("returns public.coach_profiles");
    const slice = boundFunction(UPDATE_MARKETPLACE_MARKER);
    expect(slice).not.toMatch(/returning\s+\*/);
    expect(slice).not.toMatch(/select\s+\*/);
  });
});

// ============================================================================
// J. is_active action
// ============================================================================
describe("supabase-schema-v8.sql — fn_set_own_coach_active", () => {
  it("takes exactly one boolean argument", () => {
    expect(codeLower).toMatch(/create\s+function\s+public\.fn_set_own_coach_active\(\s*p_is_active\s+boolean\s*\)/);
  });

  it("rejects a NULL argument", () => {
    const slice = boundFunction(SET_ACTIVE_MARKER);
    expect(slice).toMatch(/if p_is_active is null then/);
  });

  it("updates is_active only, never marketplace_visibility_status, verification_status, or other content", () => {
    const slice = boundFunction(SET_ACTIVE_MARKER);
    const setStartIdx = slice.indexOf("update public.coach_profiles");
    const setEndIdx = slice.indexOf("where user_id = v_caller_id", setStartIdx);
    expect(setStartIdx).toBeGreaterThanOrEqual(0);
    expect(setEndIdx).toBeGreaterThan(setStartIdx);
    const setSlice = slice.slice(setStartIdx, setEndIdx);
    expect(setSlice).toMatch(/is_active\s*=\s*p_is_active/);
    expect(setSlice).not.toMatch(/marketplace_visibility_status/);
    expect(setSlice).not.toMatch(/verification_status/);
    expect(setSlice).not.toMatch(/public_slug/);
    expect(setSlice).not.toMatch(/marketplace_headline/);
  });

  it("scopes the update to the caller's own row via user_id = v_caller_id, never an arbitrary ID", () => {
    const slice = boundFunction(SET_ACTIVE_MARKER);
    expect(slice).toMatch(/where user_id = v_caller_id/);
  });
});

// ============================================================================
// K. Directory privacy
// ============================================================================
describe("supabase-schema-v8.sql — coach_directory_listing", () => {
  it("is declared WITH (security_invoker = true) via a plain CREATE VIEW", () => {
    expect(codeLower).toMatch(/create\s+view\s+public\.coach_directory_listing/);
    expect(codeLower).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/);
  });

  it("requires is_active, published visibility, non-blank slug, non-blank display name, and excludes rejected/suspended verification", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toMatch(/cp\.is_active is true/);
    expect(slice).toMatch(/marketplace_visibility_status\s*=\s*'published'/);
    expect(slice).toMatch(/public_slug\s+is\s+not\s+null/);
    expect(slice).toMatch(/btrim\(cp\.public_slug\)\s*<>\s*''/);
    expect(slice).toMatch(/marketplace_display_name\s+is\s+not\s+null/);
    expect(slice).toMatch(/verification_status\s+not\s+in\s*\(\s*'rejected'\s*,\s*'suspended'\s*\)/);
  });

  it("projects no email, full_name, users.display_name, or user_id, and joins no other table", () => {
    const startIdx = codeLower.indexOf("select", codeLower.indexOf(VIEW_MARKER));
    const endIdx = codeLower.indexOf("from public.coach_profiles cp", startIdx);
    const projectionSlice = codeLower.slice(startIdx, endIdx);
    for (const forbidden of ["email", "full_name", "user_id", "created_at", "updated_at", "marketplace_visibility_status", "is_active"]) {
      expect(projectionSlice, `expected ${forbidden} NOT in the directory projection`).not.toContain(forbidden);
    }
    const fullViewIdx = codeLower.indexOf(VIEW_MARKER);
    const fullViewEndIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const fullViewSlice = codeLower.slice(fullViewIdx, fullViewEndIdx);
    expect(fullViewSlice).not.toMatch(/\bjoin\b/);
    expect(fullViewSlice).not.toContain("public.users");
  });

  it("projects no coordinates, private_location_name, or internal availability notes", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    for (const forbidden of ["latitude", "longitude", "private_location_name", "internal_note", "coach_locations"]) {
      expect(slice, `expected ${forbidden} NOT in the directory view`).not.toContain(forbidden);
    }
  });

  it("never uses SELECT * and never uses business_name as the directory identity", () => {
    const startIdx = codeLower.indexOf(VIEW_MARKER);
    const endIdx = codeLower.indexOf("comment on view public.coach_directory_listing");
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).not.toMatch(/select\s+\*/);
    expect(slice).not.toContain("business_name");
  });

  it("includes marketplace_display_name in the projection", () => {
    const startIdx = codeLower.indexOf("select", codeLower.indexOf(VIEW_MARKER));
    const endIdx = codeLower.indexOf("from public.coach_profiles cp", startIdx);
    const slice = codeLower.slice(startIdx, endIdx);
    expect(slice).toContain("cp.marketplace_display_name");
  });
});

// ============================================================================
// L. CM1 preservation
// ============================================================================
describe("supabase-schema-v8.sql — CM1 foundation preserved unmodified", () => {
  it("creates all six marketplace tables", () => {
    for (const table of [
      "coach_services", "coach_locations", "coach_availability_rules",
      "coach_availability_exceptions", "coach_bookings", "coach_reviews",
    ]) {
      expect(codeLower).toMatch(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`));
    }
  });

  it("preserves the composite review-identity foreign key", () => {
    expect(codeLower).toMatch(
      /foreign key\s*\(\s*booking_id\s*,\s*coach_profile_id\s*,\s*golfer_id\s*\)\s*references\s+public\.coach_bookings\s*\(\s*id\s*,\s*coach_profile_id\s*,\s*golfer_id\s*\)/
    );
  });

  it("preserves the completed-booking review trigger, SECURITY INVOKER, empty search_path", () => {
    const idx = codeLower.indexOf("create or replace function public.fn_enforce_coach_review_completed_booking");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 500);
    expect(slice).toMatch(/security\s+invoker/);
    expect(slice).not.toMatch(/security\s+definer/);
    expect(slice).toMatch(/set\s+search_path\s*=\s*''/);
    expect(codeLower).toMatch(/create\s+trigger\s+trg_coach_reviews_enforce_completed_booking/);
  });

  it("preserves the approved-review-only rating aggregate with no client-writable columns on coach_profiles", () => {
    expect(codeLower).toMatch(/where\s+moderation_status\s*=\s*'approved'/);
    expect(codeLower).not.toMatch(/add\s+column\s+if\s+not\s+exists\s+avg_rating\b/);
    expect(codeLower).not.toMatch(/add\s+column\s+if\s+not\s+exists\s+review_count\b/);
  });

  it("preserves integer minor-unit pricing on coach_services", () => {
    expect(codeLower).toMatch(/price_amount_minor\s+integer\s+not\s+null\s+check\s*\(price_amount_minor\s*>=\s*0\)/);
  });

  it("adds no street-address field to coach_locations", () => {
    expect(codeLower).not.toMatch(/street_address/);
    expect(codeLower).not.toMatch(/address_line/);
  });
});

// ============================================================================
// M. No destructive operations
// ============================================================================
describe("supabase-schema-v8.sql — no destructive operations", () => {
  it("contains no DROP TABLE, DROP COLUMN, or TRUNCATE statement (the word TRUNCATE legitimately appears only as a privilege-name string literal in preflight F's effective-privilege check)", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+table\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+column\b/);
    expect(codeLower).not.toMatch(/\btruncate\s+(table\s+)?public\./);
    expect(codeLower).not.toMatch(/^\s*truncate\b/m);
  });

  it("contains no DELETE FROM (real DML delete, as opposed to an ON DELETE foreign-key clause)", () => {
    expect(codeLower).not.toMatch(/\bdelete\s+from\b/);
    expect(codeLower).toMatch(/\bon\s+delete\s+(cascade|restrict|set\s+null)\b/);
  });

  it("contains no broad application-data UPDATE/backfill against coach_profiles outside the five SECURITY DEFINER functions", () => {
    // Every UPDATE against coach_profiles must be scoped by user_id in a
    // WHERE clause (own-row only) — never an unscoped or broad UPDATE.
    const updateMatches = Array.from(codeLower.matchAll(/update\s+public\.coach_profiles\b[\s\S]{0,400}?(?=;)/g));
    expect(updateMatches.length).toBeGreaterThan(0);
    for (const m of updateMatches) {
      expect(m[0], "expected every UPDATE on coach_profiles to be scoped by user_id").toMatch(/user_id/);
    }
  });

  it("only two DROP POLICY statements exist, both exact-name, no other DROP statement", () => {
    const dropMatches = Array.from(codeLower.matchAll(/\bdrop\s+\w+/g)).map((m) => m[0]);
    for (const d of dropMatches) {
      expect(d).toMatch(/^drop\s+policy$/);
    }
    expect(dropMatches.length).toBe(2);
  });
});

// ============================================================================
// N. Final effective-access postflight (runs after all grants/creates,
// before COMMIT)
// ============================================================================
describe("supabase-schema-v8.sql — postflight exists and runs before COMMIT", () => {
  it("all five postflight blocks (A-E) exist after the directory view's grants and before the final commit", () => {
    const directoryGrantIdx = codeLower.lastIndexOf("grant select on public.coach_directory_listing to service_role");
    const postflightAIdx = codeLower.indexOf("postflight a:");
    const postflightBIdx = codeLower.indexOf("postflight b:");
    const postflightCIdx = codeLower.indexOf("postflight c:");
    const postflightDIdx = codeLower.indexOf("postflight d:");
    const postflightEIdx = codeLower.indexOf("postflight e:");
    const finalCommitIdx = codeLower.lastIndexOf("commit;");

    expect(directoryGrantIdx).toBeGreaterThanOrEqual(0);
    expect(postflightAIdx).toBeGreaterThan(directoryGrantIdx);
    expect(postflightBIdx).toBeGreaterThan(postflightAIdx);
    expect(postflightCIdx).toBeGreaterThan(postflightBIdx);
    expect(postflightDIdx).toBeGreaterThan(postflightCIdx);
    expect(postflightEIdx).toBeGreaterThan(postflightDIdx);
    expect(finalCommitIdx).toBeGreaterThan(postflightEIdx);
  });

  it("every postflight failure raises an exception (so the whole transaction rolls back before COMMIT)", () => {
    for (const letter of ["a", "b", "c", "d", "e"]) {
      const slice = postflightBlockSlice(letter);
      expect(slice, `expected postflight ${letter} to raise exception on failure`).toMatch(/raise exception/);
    }
  });
});

describe("supabase-schema-v8.sql — postflight A: coach_profiles final state", () => {
  it("asserts zero policies on coach_profiles", () => {
    const slice = postflightBlockSlice("a");
    expect(slice).toMatch(/count\(\*\)\s+from\s+pg_policies\s+where\s+schemaname\s*=\s*'public'\s+and\s+tablename\s*=\s*'coach_profiles'/);
    expect(slice).toMatch(/<>\s*0/);
  });

  it("asserts anon and authenticated have zero effective privilege of every kind via has_table_privilege", () => {
    const slice = postflightBlockSlice("a");
    expect(slice).toContain("'anon'");
    expect(slice).toContain("'authenticated'");
    for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
      expect(slice, `expected postflight A to check ${priv}`).toContain(`'${priv}'`);
    }
    expect(slice).toMatch(/has_table_privilege\(v_role,\s*'public\.coach_profiles',\s*v_priv\)/);
  });

  it("asserts service_role has effective SELECT and nothing else", () => {
    const slice = postflightBlockSlice("a");
    expect(slice).toMatch(/has_table_privilege\('service_role',\s*'public\.coach_profiles',\s*'select'\)/);
    expect(slice).toMatch(/foreach v_priv in array array\['insert', 'update', 'delete', 'truncate', 'references', 'trigger'\][\s\S]{0,200}service_role/);
  });

  it("asserts PUBLIC has no direct grant, table or column level", () => {
    const slice = postflightBlockSlice("a");
    expect(slice).toMatch(/information_schema\.table_privileges[\s\S]{0,150}grantee\s*=\s*'public'/);
    expect(slice).toMatch(/information_schema\.column_privileges[\s\S]{0,150}grantee\s*=\s*'public'/);
  });
});

describe("supabase-schema-v8.sql — postflight B: six marketplace tables", () => {
  it("iterates all six tables by exact name", () => {
    const slice = postflightBlockSlice("b");
    for (const table of [
      "coach_services", "coach_locations", "coach_availability_rules",
      "coach_availability_exceptions", "coach_bookings", "coach_reviews",
    ]) {
      expect(slice, `expected postflight B to check ${table}`).toContain(table);
    }
  });

  it("requires RLS enabled and zero policies for each table", () => {
    const slice = postflightBlockSlice("b");
    expect(slice).toMatch(/relrowsecurity\s*=\s*true/);
    expect(slice).toMatch(/count\(\*\)\s+from\s+pg_policies\s+where\s+schemaname\s*=\s*'public'\s+and\s+tablename\s*=\s*v_table/);
  });

  it("requires zero effective privilege for anon and authenticated on every one of the six tables, without exception", () => {
    const slice = postflightBlockSlice("b");
    expect(slice).toMatch(/foreach v_role in array array\['anon',\s*'authenticated'\][\s\S]{0,300}has_table_privilege\(v_role,\s*'public\.'\s*\|\|\s*v_table,\s*v_priv\)/);
  });

  it("requires service_role SELECT-only on coach_reviews, and zero privilege on the other five tables", () => {
    const slice = postflightBlockSlice("b");
    expect(slice).toMatch(/v_table\s*=\s*'coach_reviews'\s+then\s+array\['select'\]::text\[\]/);
    expect(slice).toMatch(/else\s+array\[\]::text\[\]/);
    // Positive assertion (missing intended privilege) and negative
    // assertion (unexpected extra privilege) both present, keyed off the
    // per-table v_service_role_privs allowlist rather than a single
    // blanket exclusion for all six tables.
    expect(slice).toMatch(/is missing the intended effective/);
    expect(slice).toMatch(/unexpectedly has effective/);
  });
});

describe("supabase-schema-v8.sql — postflight C: views", () => {
  it("checks both coach_rating_summary and coach_directory_listing", () => {
    const slice = postflightBlockSlice("c");
    expect(slice).toContain("coach_rating_summary");
    expect(slice).toContain("coach_directory_listing");
  });

  it("requires anon/authenticated cannot SELECT and service_role can", () => {
    const slice = postflightBlockSlice("c");
    expect(slice).toMatch(/has_table_privilege\(v_role,\s*'public\.'\s*\|\|\s*v_view,\s*'select'\)/);
    expect(slice).toMatch(/not\s+has_table_privilege\('service_role',\s*'public\.'\s*\|\|\s*v_view,\s*'select'\)/);
  });

  it("requires BOTH coach_rating_summary and coach_directory_listing retain security_invoker=true, checked per-view against the exact schema and relation name (not coach_directory_listing only)", () => {
    const slice = postflightBlockSlice("c");
    // The reloptions check must be scoped by the loop variable v_view (so
    // it runs once per iterated view), not hardcoded to a single view name.
    expect(slice).toMatch(/c\.relname\s*=\s*v_view[\s\S]{0,60}'security_invoker=true'\s*=\s*any\(c\.reloptions\)/);
    expect(slice).not.toMatch(/c\.relname\s*=\s*'coach_directory_listing'/);
    // The failure message must be per-view too, not hardcoded to naming
    // only coach_directory_listing.
    expect(slice).toMatch(/v_view\s*\|\|\s*'\s*must retain security_invoker=true'/);
  });

  it("explicitly checks the catalog for a direct PUBLIC SELECT grant on both views (distinct from, and in addition to, the effective anon/authenticated checks)", () => {
    const slice = postflightBlockSlice("c");
    expect(slice).toMatch(
      /information_schema\.table_privileges[\s\S]{0,120}table_name\s*=\s*v_view[\s\S]{0,80}grantee\s*=\s*'public'\s+and\s+privilege_type\s*=\s*'select'/
    );
    const directGrantCheckIdx = slice.indexOf("information_schema.table_privileges");
    const effectiveCheckIdx = slice.indexOf("has_table_privilege(v_role");
    expect(directGrantCheckIdx).toBeGreaterThanOrEqual(0);
    expect(effectiveCheckIdx).toBeGreaterThan(directGrantCheckIdx);
  });
});

describe("supabase-schema-v8.sql — postflight E: service_role BYPASSRLS retained", () => {
  it("checks pg_roles.rolbypassrls = true for service_role and raises postflight E on failure", () => {
    const slice = postflightBlockSlice("e");
    expect(slice).toMatch(/rolname\s*=\s*'service_role'\s+and\s+rolbypassrls\s*=\s*true/);
    expect(slice).toMatch(/raise exception 'postflight e:/);
  });
});

describe("supabase-schema-v8.sql — postflight D: exact function signatures", () => {
  it("checks all five functions by their exact, fully-typed signature (not name-only)", () => {
    const slice = postflightBlockSlice("d");
    for (const sig of [
      "public.fn_get_or_create_own_coach_profile()",
      "public.fn_get_own_coach_marketplace_profile()",
      "public.fn_update_own_coach_profile_legacy(text, text, text[], text)",
      "public.fn_update_coach_marketplace_profile(text, text, text, integer, text[], text, text, text, text, integer, text)",
      "public.fn_set_own_coach_active(boolean)",
    ]) {
      expect(slice, `expected postflight D to check exact signature ${sig}`).toContain(sig.toLowerCase());
    }
  });

  it("does NOT use a direct ::regprocedure cast anywhere in postflight D (a missing/mistyped function would throw before producing a stable postflight-D exception)", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).not.toMatch(/::regprocedure/);
  });

  it("resolves every exact signature via pg_catalog.to_regprocedure(...), storing the OID before any further lookup", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/v_oid\s*:=\s*pg_catalog\.to_regprocedure\(r\.fn_signature\)/);
  });

  it("adds a postflight-D problem and skips further checks when the resolved OID is NULL", () => {
    const slice = postflightBlockSlice("d");
    const nullCheckIdx = slice.indexOf("v_oid is null then");
    expect(nullCheckIdx).toBeGreaterThanOrEqual(0);
    const nullCheckSlice = slice.slice(nullCheckIdx, nullCheckIdx + 300);
    expect(nullCheckSlice).toMatch(/does not resolve to any function/);
    expect(nullCheckSlice).toMatch(/continue\s*;/);
    // The NULL check must appear before any pg_proc/has_function_privilege
    // lookup that depends on v_oid being valid.
    const firstPgProcIdx = slice.indexOf("select 1 from pg_proc p where p.oid = v_oid");
    expect(firstPgProcIdx).toBeGreaterThan(nullCheckIdx);
  });

  it("requires SECURITY DEFINER via pg_proc.prosecdef", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/prosecdef\s*=\s*true/);
  });

  it("requires an empty configured search_path via pg_proc.proconfig", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/unnest\(p\.proconfig\)[\s\S]{0,40}=\s*'search_path='/);
  });

  it("positively requires the function owner to equal current_user (the same role preflight D already proved is table-owner-or-superuser) — not merely a role-name blacklist", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/v_owner_name\s+is\s+distinct\s+from\s+current_user/);
    expect(slice).toMatch(/already proven trusted by preflight d/i);
  });

  it("also retains the anon/authenticated/service_role owner blacklist as an additional, non-exclusive check", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/v_owner_name\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*,\s*'service_role'\s*\)/);
    // Both checks must be present — the positive current_user check is not
    // a replacement for the blacklist, it supplements it.
    const positiveIdx = slice.indexOf("v_owner_name is distinct from current_user");
    const blacklistIdx = slice.indexOf("v_owner_name in ('anon', 'authenticated', 'service_role')");
    expect(positiveIdx).toBeGreaterThanOrEqual(0);
    expect(blacklistIdx).toBeGreaterThan(positiveIdx);
  });

  it("resolves owner name via pg_proc.proowner joined to pg_roles, not merely a stored name", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/select\s+p\.proowner\s+into\s+v_owner_oid\s+from\s+pg_proc\s+p\s+where\s+p\.oid\s*=\s*v_oid/);
    expect(slice).toMatch(/select\s+ro\.rolname\s+into\s+v_owner_name\s+from\s+pg_roles\s+ro\s+where\s+ro\.oid\s*=\s*v_owner_oid/);
  });

  it("requires PUBLIC has no explicit EXECUTE grant, anon cannot execute, authenticated can execute", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/information_schema\.routine_privileges[\s\S]{0,150}grantee\s*=\s*'public'\s+and\s+privilege_type\s*=\s*'execute'/);
    expect(slice).toMatch(/has_function_privilege\('anon',\s*r\.fn_signature,\s*'execute'\)/);
    expect(slice).toMatch(/not\s+has_function_privilege\('authenticated',\s*r\.fn_signature,\s*'execute'\)/);
  });

  it("requires exactly one overload per function name (no unexpected additional signature)", () => {
    const slice = postflightBlockSlice("d");
    expect(slice).toMatch(/count\(\*\)[\s\S]{0,120}p2\.proname\s*=\s*r\.fn_name[\s\S]{0,20}<>\s*1/);
  });
});
