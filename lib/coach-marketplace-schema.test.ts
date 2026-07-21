import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read supabase-schema-v6.sql as plain text only — this test never connects
// to a database, never executes SQL, and never applies the migration. It
// validates the migration's *source text* structure the same way the rest
// of this repository's static tests validate script/route source text.
const migrationPath = path.join(__dirname, "..", "supabase-schema-v6.sql");
// Normalized to LF immediately after reading so every exact-newline
// assertion below is independent of how this file happens to be checked
// out (e.g. Windows core.autocrlf=true producing CRLF line endings) —
// without this, identical source text can pass or fail purely based on the
// checkout environment rather than the file's actual content.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

/**
 * Strips SQL line comments (`-- ...` to end of line) so structural
 * assertions below can't be fooled by explanatory prose that merely
 * *mentions* a forbidden keyword (e.g. "no Stripe code" or "no DROP
 * TRIGGER") inside a comment. Does not attempt to strip string literals —
 * `code`/`codeLower` below deliberately retain them, since other
 * assertions in this file need to find real constraint values (e.g.
 * 'requested', 'hidden') inside `comment on ... is '...';` and `check (...
 * in (...))` statements.
 */
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
 * `--` line comments. Used ONLY for the two global-keyword-absence checks
 * below (Stripe, SECURITY DEFINER) — this migration deliberately documents
 * "no Stripe code" and "not SECURITY DEFINER" in its own `comment on`
 * strings, which must not be mistaken for the real, executable thing they
 * explicitly deny.
 */
function stripCommentOnDocStrings(sql: string): string {
  return sql.replace(
    /comment\s+on\s+[^\n]*\bis\b[^\n]*\n\s*'(?:[^']|'')*'\s*;/gi,
    "comment on <doc-stripped>;"
  );
}

const code = stripSqlComments(migration);
const codeLower = code.toLowerCase();
const codeWithoutDocStrings = stripCommentOnDocStrings(code);
const codeWithoutDocStringsLower = codeWithoutDocStrings.toLowerCase();

describe("supabase-schema-v6.sql — transaction wrapping and forward-only posture", () => {
  it("wraps the migration in BEGIN and COMMIT", () => {
    expect(migration).toMatch(/^\s*begin\s*;/im);
    expect(migration).toMatch(/^\s*commit\s*;/im);
    const beginIndex = code.search(/\bbegin\s*;/i);
    const commitIndex = code.search(/\bcommit\s*;/i);
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
  });

  it("contains no DROP TABLE", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+table\b/);
  });

  it("contains no DROP COLUMN", () => {
    expect(codeLower).not.toMatch(/\bdrop\s+column\b/);
  });

  it("contains no TRUNCATE", () => {
    expect(codeLower).not.toMatch(/\btruncate\b/);
  });

  it("contains no DELETE FROM (real DML delete, as opposed to an ON DELETE foreign-key clause)", () => {
    // A naive /delete/ regex would incorrectly flag every "on delete
    // cascade/restrict/set null" foreign-key clause in this file. Only a
    // literal "delete from <table>" DML statement should fail this test.
    expect(codeLower).not.toMatch(/\bdelete\s+from\b/);
    // Sanity-check the migration actually DOES contain legitimate "on
    // delete" foreign-key clauses, proving the assertion above is
    // discriminating and not just vacuously true because the word never
    // appears at all.
    expect(codeLower).toMatch(/\bon\s+delete\s+(cascade|restrict|set\s+null)\b/);
  });

  it("contains no other destructive data-rewrite statement (UPDATE, ALTER ... TYPE, ALTER ... DROP DEFAULT removing data)", () => {
    expect(codeLower).not.toMatch(/\bupdate\s+public\./);
    expect(codeLower).not.toMatch(/\balter\s+column\b.*\btype\b/);
  });

  it("contains no Stripe execution code (only explanatory prose mentioning Stripe inside comment-on documentation strings, which are stripped before this check)", () => {
    expect(codeWithoutDocStringsLower).not.toMatch(/stripe/);
  });

  it("contains no production-specific identifier patterns (hardcoded UUID literals, project refs)", () => {
    // A literal UUID string constant would indicate a hardcoded row/id
    // rather than a generic, environment-agnostic migration.
    expect(migration).not.toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i);
  });

  it("uses public schema qualification consistently for every new/altered table and the view", () => {
    for (const name of [
      "coach_profiles",
      "coach_services",
      "coach_locations",
      "coach_availability_rules",
      "coach_availability_exceptions",
      "coach_bookings",
      "coach_reviews",
      "coach_rating_summary",
    ]) {
      expect(codeLower).toMatch(new RegExp(`public\\.${name}\\b`));
    }
  });

  it("uses gen_random_uuid() for every new table's primary key default", () => {
    const newTables = [
      "coach_services",
      "coach_locations",
      "coach_availability_rules",
      "coach_availability_exceptions",
      "coach_bookings",
      "coach_reviews",
    ];
    for (const table of newTables) {
      const createIdx = codeLower.indexOf(`create table if not exists public.${table}`);
      expect(createIdx, `expected CREATE TABLE for ${table}`).toBeGreaterThanOrEqual(0);
      const slice = code.slice(createIdx, createIdx + 400);
      expect(slice.toLowerCase(), `expected gen_random_uuid() near ${table}'s id column`).toMatch(
        /id\s+uuid\s+primary key\s+default\s+gen_random_uuid\(\)/
      );
    }
  });

  it("declares no second competing coach-profile table (coach_profiles is altered exactly once, never created)", () => {
    expect(codeLower).not.toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.coach_profiles\b/);
    expect(codeLower).not.toMatch(/create\s+table\s+public\.coach_profiles\b/);
    const alterMatches = code.match(/alter\s+table\s+public\.coach_profiles\b/gi) ?? [];
    expect(alterMatches.length).toBeGreaterThan(0);
  });
});

describe("supabase-schema-v6.sql — coach_profiles additive columns", () => {
  it("adds every required marketplace column via ADD COLUMN IF NOT EXISTS", () => {
    const requiredColumns = [
      "public_slug",
      "marketplace_headline",
      "profile_photo_url",
      "years_coaching",
      "lesson_delivery_modes",
      "public_city",
      "public_region",
      "timezone",
      "marketplace_visibility_status",
      "verification_status",
      "minimum_booking_notice_hours",
      "cancellation_policy_summary",
    ];
    for (const column of requiredColumns) {
      expect(codeLower, `expected ADD COLUMN IF NOT EXISTS ${column}`).toMatch(
        new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`)
      );
    }
  });

  it("does not add avg_rating or review_count to coach_profiles", () => {
    expect(codeLower).not.toMatch(/add\s+column\s+if\s+not\s+exists\s+avg_rating\b/);
    expect(codeLower).not.toMatch(/add\s+column\s+if\s+not\s+exists\s+review_count\b/);
    // Belt and suspenders: these identifiers should not appear on
    // coach_profiles as bare column names anywhere in the file at all.
    expect(codeLower).not.toMatch(/\bavg_rating\b/);
    expect(codeLower).not.toMatch(/\breview_count\b/);
  });

  it("does not add any street-address column", () => {
    expect(codeLower).not.toMatch(/street_address/);
    expect(codeLower).not.toMatch(/address_line/);
  });

  it("retains and documents hourly_rate as legacy/default informational data, unchanged", () => {
    expect(codeLower).not.toMatch(/drop\s+column\s+if\s+exists\s+hourly_rate/);
    expect(codeLower).toMatch(/comment on column public\.coach_profiles\.hourly_rate/);
    expect(codeLower).toMatch(/legacy\/default informational rate/);
  });

  it("constrains years_coaching to be non-negative when present", () => {
    expect(codeLower).toMatch(/years_coaching is null or years_coaching\s*>=\s*0/);
  });

  it("constrains minimum_booking_notice_hours to be non-negative when present", () => {
    expect(codeLower).toMatch(
      /minimum_booking_notice_hours is null or minimum_booking_notice_hours\s*>=\s*0/
    );
  });

  it("constrains lesson_delivery_modes to the supported delivery-mode set", () => {
    const idx = codeLower.indexOf("coach_profiles_lesson_delivery_modes_valid");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 300);
    expect(slice).toContain("in_person");
    expect(slice).toContain("remote");
    expect(slice).toContain("hybrid");
  });

  it("constrains marketplace_visibility_status to hidden|draft|published|suspended", () => {
    const name = "coach_profiles_marketplace_visibility_status_valid";
    const firstIdx = codeLower.indexOf(name);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    // The constraint name appears twice: once in the pg_constraint
    // existence guard, once in the actual `add constraint ... check (...)`
    // clause we want to inspect here — find that second occurrence.
    const secondIdx = codeLower.indexOf(name, firstIdx + name.length);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    const slice = codeLower.slice(secondIdx, secondIdx + 200);
    for (const value of ["hidden", "draft", "published", "suspended"]) {
      expect(slice).toContain(`'${value}'`);
    }
  });

  it("constrains verification_status to unverified|pending|verified|rejected|suspended", () => {
    const name = "coach_profiles_verification_status_valid";
    const firstIdx = codeLower.indexOf(name);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    const secondIdx = codeLower.indexOf(name, firstIdx + name.length);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    const slice = codeLower.slice(secondIdx, secondIdx + 220);
    for (const value of ["unverified", "pending", "verified", "rejected", "suspended"]) {
      expect(slice).toContain(`'${value}'`);
    }
  });

  it("enforces public_slug uniqueness only when non-null via a partial unique index", () => {
    expect(codeLower).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+idx_coach_profiles_public_slug_unique[\s\S]{0,150}where\s+public_slug\s+is\s+not\s+null/
    );
  });

  it("guards every new coach_profiles constraint with an idempotent pg_constraint existence check", () => {
    const constraintNames = [
      "coach_profiles_years_coaching_nonnegative",
      "coach_profiles_min_notice_hours_nonnegative",
      "coach_profiles_lesson_delivery_modes_valid",
      "coach_profiles_marketplace_visibility_status_valid",
      "coach_profiles_verification_status_valid",
    ];
    for (const name of constraintNames) {
      expect(codeLower, `expected an existence guard for ${name}`).toMatch(
        new RegExp(`select 1 from pg_constraint where conname = '${name}'`)
      );
    }
  });
});

describe("supabase-schema-v6.sql — six new tables exist with RLS enabled and zero policies", () => {
  const newTables = [
    "coach_services",
    "coach_locations",
    "coach_availability_rules",
    "coach_availability_exceptions",
    "coach_bookings",
    "coach_reviews",
  ];

  it("creates all six new tables", () => {
    for (const table of newTables) {
      expect(codeLower).toMatch(
        new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`)
      );
    }
  });

  it("enables Row Level Security on all six new tables", () => {
    for (const table of newTables) {
      expect(codeLower, `expected RLS enabled on ${table}`).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`)
      );
    }
  });

  it("creates no CREATE POLICY statement anywhere in the migration", () => {
    expect(codeLower).not.toMatch(/\bcreate\s+policy\b/);
  });

  it("does not modify any existing policy on pre-existing tables (no ALTER POLICY / DROP POLICY at all)", () => {
    expect(codeLower).not.toMatch(/\balter\s+policy\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+policy\b/);
  });

  it("revokes all anon/authenticated privileges on every one of the six new tables individually", () => {
    // One assertion per exact table name, each its own REVOKE statement —
    // deliberately not a single combined check, so removing any individual
    // table's REVOKE line fails this test even if the other five remain.
    for (const table of newTables) {
      expect(codeLower, `expected REVOKE ALL on public.${table} FROM anon, authenticated`).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon\\s*,\\s*authenticated`)
      );
    }
  });
});

describe("supabase-schema-v6.sql — money is always integer minor units", () => {
  it("coach_services.price_amount_minor is an integer column, non-negative", () => {
    expect(codeLower).toMatch(/price_amount_minor\s+integer\s+not\s+null\s+check\s*\(price_amount_minor\s*>=\s*0\)/);
  });

  it("coach_bookings.gross_amount_minor_snapshot is an integer column, non-negative", () => {
    expect(codeLower).toMatch(
      /gross_amount_minor_snapshot\s+integer\s+not\s+null\s+check\s*\(gross_amount_minor_snapshot\s*>=\s*0\)/
    );
  });

  it("declares no numeric/decimal monetary price column anywhere (price/amount columns are never numeric or decimal typed)", () => {
    // Every column whose name contains "price" or "amount" must be typed
    // integer, never numeric(...)/decimal(...). hourly_rate is a
    // pre-existing, unrelated legacy column and is intentionally excluded.
    const moneyColumnPattern = /(\w*(?:price|amount)\w*)\s+(numeric|decimal)\b/gi;
    const matches = Array.from(code.matchAll(moneyColumnPattern)).filter(
      (m) => !m[1].toLowerCase().includes("hourly_rate")
    );
    expect(matches, JSON.stringify(matches.map((m) => m[0]))).toHaveLength(0);
  });

  it("currency codes are constrained to exactly three uppercase letters", () => {
    expect(codeLower).toMatch(/currency_code\s+text\s+not\s+null\s+check\s*\(currency_code\s*~\s*'\^\[a-z\]\{3\}\$'\)/);
    expect(codeLower).toMatch(
      /currency_code_snapshot\s+text\s+not\s+null\s+check\s*\(currency_code_snapshot\s*~\s*'\^\[a-z\]\{3\}\$'\)/
    );
  });
});

describe("supabase-schema-v6.sql — ratings, statuses, and identity constraints", () => {
  it("constrains overall_rating to 1..5 and every optional category rating to 1..5 or null", () => {
    expect(codeLower).toMatch(/overall_rating\s+integer\s+not\s+null\s+check\s*\(overall_rating\s+between\s+1\s+and\s+5\)/);
    for (const column of ["communication_rating", "instruction_rating", "professionalism_rating", "value_rating"]) {
      expect(codeLower, `expected ${column} 1..5-or-null check`).toMatch(
        new RegExp(`${column}\\s+is\\s+null\\s+or\\s+${column}\\s+between\\s+1\\s+and\\s+5`)
      );
    }
  });

  it("constrains coach_bookings.status to the exact required lifecycle values", () => {
    // Anchored on "default 'requested' check (" — unique to the
    // coach_bookings.status column definition. A bare "status in (" search
    // would incorrectly match inside "...visibility_status in (" or
    // "moderation_status in (" earlier/elsewhere in the file, since both
    // contain "status in (" as a trailing substring.
    const idx = codeLower.indexOf("default 'requested' check (");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 400);
    for (const status of [
      "requested",
      "accepted",
      "declined",
      "pending_payment",
      "confirmed",
      "completed",
      "canceled_by_golfer",
      "canceled_by_coach",
      "no_show",
      "refunded",
    ]) {
      expect(slice, `expected booking status '${status}'`).toContain(`'${status}'`);
    }
  });

  it("constrains coach_reviews.moderation_status to pending|approved|rejected|hidden", () => {
    const idx = codeLower.indexOf("moderation_status in (");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 200);
    for (const status of ["pending", "approved", "rejected", "hidden"]) {
      expect(slice).toContain(`'${status}'`);
    }
  });

  it("enforces exactly one review per booking via a unique constraint on booking_id", () => {
    expect(codeLower).toMatch(
      /constraint\s+coach_reviews_booking_id_unique\s+unique\s*\(\s*booking_id\s*\)/
    );
  });

  it("enforces booking/coach/golfer identity matching via a composite foreign key into coach_bookings", () => {
    expect(codeLower).toMatch(
      /foreign key\s*\(\s*booking_id\s*,\s*coach_profile_id\s*,\s*golfer_id\s*\)\s*references\s+public\.coach_bookings\s*\(\s*id\s*,\s*coach_profile_id\s*,\s*golfer_id\s*\)/
    );
    // The composite FK requires a matching unique constraint on
    // coach_bookings covering exactly those three columns.
    expect(codeLower).toMatch(
      /constraint\s+coach_bookings_id_coach_golfer_unique\s+unique\s*\(\s*id\s*,\s*coach_profile_id\s*,\s*golfer_id\s*\)/
    );
  });
});

describe("supabase-schema-v6.sql — completed-booking review enforcement", () => {
  it("defines a trigger function that validates the referenced booking is completed", () => {
    expect(codeLower).toMatch(/create\s+or\s+replace\s+function\s+public\.fn_enforce_coach_review_completed_booking/);
    expect(codeLower).toMatch(/v_booking_status\s*<>\s*'completed'/);
  });

  it("declares the validation function SECURITY INVOKER, not SECURITY DEFINER", () => {
    const idx = codeLower.indexOf("function public.fn_enforce_coach_review_completed_booking");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 300);
    expect(slice).toMatch(/security\s+invoker/);
    expect(slice).not.toMatch(/security\s+definer/);
    // Global guarantee: this migration never declares ANY SECURITY DEFINER
    // function at all (checked against the doc-string-stripped text, since
    // this file's own comment-on documentation legitimately says "not
    // SECURITY DEFINER" as prose).
    expect(codeWithoutDocStringsLower).not.toMatch(/security\s+definer/);
  });

  it("rejects a review whose coach_profile_id or golfer_id does not match the referenced booking", () => {
    expect(codeLower).toMatch(/v_booking_coach_profile_id\s*<>\s*new\.coach_profile_id/);
    expect(codeLower).toMatch(/v_booking_golfer_id\s*<>\s*new\.golfer_id/);
  });

  it("attaches the trigger to coach_reviews with an idempotent creation guard rather than DROP TRIGGER", () => {
    expect(codeLower).not.toMatch(/drop\s+trigger/);
    expect(codeLower).toMatch(/select 1 from pg_trigger/);
    expect(codeLower).toMatch(
      /create\s+trigger\s+trg_coach_reviews_enforce_completed_booking[\s\S]{0,50}before\s+insert\s+or\s+update[\s\S]{0,100}on\s+public\.coach_reviews/
    );
  });

  it("creates no anonymous review policy (no CREATE POLICY at all on coach_reviews, confirmed by the zero-policy check above)", () => {
    const reviewsSectionIdx = codeLower.indexOf("create table if not exists public.coach_reviews");
    // "-- H. ..." is a `--` line comment, already stripped out of
    // code/codeLower, so it can't be used as a boundary marker here. The
    // start of the view-creation DO block (real code, not a comment) is a
    // safe boundary: it comes immediately after the reviews section ends.
    const nextSectionIdx = codeLower.indexOf("if current_setting('server_version_num')");
    expect(reviewsSectionIdx).toBeGreaterThanOrEqual(0);
    expect(nextSectionIdx).toBeGreaterThan(reviewsSectionIdx);
    const reviewsSection = codeLower.slice(reviewsSectionIdx, nextSectionIdx);
    expect(reviewsSection).not.toMatch(/create\s+policy/);
  });

  it("locks the trigger function's search_path to empty and only ever references coach_bookings schema-qualified", () => {
    // Bound the slice tightly to just this one function's declaration and
    // body — from its CREATE OR REPLACE FUNCTION header through the closing
    // $fn$ dollar-quote delimiter — so this test can't accidentally pass
    // because SECURITY INVOKER, SET search_path, or a qualified relation
    // reference merely appears *somewhere else* in the file (a different
    // function, a comment, or documentation prose).
    const fnIdx = codeLower.indexOf(
      "create or replace function public.fn_enforce_coach_review_completed_booking"
    );
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const openDelimIdx = codeLower.indexOf("$fn$", fnIdx);
    expect(openDelimIdx).toBeGreaterThan(fnIdx);
    const closeDelimIdx = codeLower.indexOf("$fn$", openDelimIdx + "$fn$".length);
    expect(closeDelimIdx).toBeGreaterThan(openDelimIdx);
    const fnBlock = codeLower.slice(fnIdx, closeDelimIdx + "$fn$".length);

    // Positive: must be present, bounded to this function only.
    expect(fnBlock).toMatch(/security\s+invoker/);
    expect(fnBlock).toMatch(/set\s+search_path\s*=\s*''/);
    expect(fnBlock).toMatch(/from\s+public\.coach_bookings\b/);

    // Negative: must be absent from this same bounded function.
    expect(fnBlock).not.toMatch(/security\s+definer/);
    expect(fnBlock).not.toMatch(/from\s+coach_bookings\b/);
  });
});

describe("supabase-schema-v6.sql — coach_rating_summary view", () => {
  it("filters to only approved reviews", () => {
    const idx = codeLower.indexOf("create or replace view public.coach_rating_summary");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = codeLower.slice(idx, idx + 1200);
    expect(slice).toMatch(/where\s+moderation_status\s*=\s*'approved'/);
  });

  it("selects only the seven approved documented columns — never review_body, golfer identity, location, coordinates, or internal notes", () => {
    const idx = codeLower.indexOf("select\n        coach_profile_id,");
    expect(idx).toBeGreaterThanOrEqual(0);
    const fromIdx = codeLower.indexOf("from public.coach_reviews", idx);
    expect(fromIdx).toBeGreaterThan(idx);
    const selectList = codeLower.slice(idx, fromIdx);

    // Required, present.
    for (const column of [
      "coach_profile_id",
      "approved_review_count",
      "overall_rating_average",
      "communication_rating_average",
      "instruction_rating_average",
      "professionalism_rating_average",
      "value_rating_average",
    ]) {
      expect(selectList, `expected ${column} in the view's select list`).toContain(column);
    }

    // Forbidden, absent.
    for (const forbidden of [
      "review_body",
      "golfer_id",
      "coach_response",
      "latitude",
      "longitude",
      "private_location_name",
      "internal_note",
    ]) {
      expect(selectList, `expected ${forbidden} NOT in the view's select list`).not.toContain(forbidden);
    }
  });

  it("is not granted to anon or authenticated in this migration", () => {
    expect(codeLower).toMatch(/revoke\s+all\s+on\s+public\.coach_rating_summary\s+from\s+anon\s*,\s*authenticated/);
    expect(codeLower).not.toMatch(/grant\s+select\s+on\s+public\.coach_rating_summary/);
  });

  it("sets security_invoker = true on the PostgreSQL 15+ view-creation branch", () => {
    // Bound the slice to only the `if ... >= 150000 then` branch (up to the
    // following `else`), not the whole DO block and not the `--` prose
    // comment above it explaining security_invoker (already stripped from
    // codeLower by stripSqlComments) — so this can't pass merely because
    // the phrase "security_invoker" appears in documentation.
    const branchIdx = codeLower.indexOf(
      "if current_setting('server_version_num')::int >= 150000 then"
    );
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    const elseIdx = codeLower.indexOf("else", branchIdx);
    expect(elseIdx).toBeGreaterThan(branchIdx);
    const pg15Branch = codeLower.slice(branchIdx, elseIdx);
    expect(pg15Branch).toMatch(/create\s+or\s+replace\s+view\s+public\.coach_rating_summary/);
    expect(pg15Branch).toMatch(/with\s*\(\s*security_invoker\s*=\s*true\s*\)/);
  });

  it("has no client-writable aggregate anywhere (coach_profiles gained no rating column; see the avg_rating/review_count test above)", () => {
    expect(codeLower).not.toMatch(/\binsert\s+into\s+public\.coach_rating_summary\b/);
    expect(codeLower).not.toMatch(/\bupdate\s+public\.coach_rating_summary\b/);
  });
});

describe("supabase-schema-v6.sql — no Stripe Connect / payments execution code", () => {
  it("contains no Stripe Connect, payout, payment-intent, or connected-account identifiers", () => {
    for (const forbidden of [
      "stripe_connect",
      "connected_account",
      "payment_intent",
      "payout",
      "stripe_account_id",
    ]) {
      expect(codeLower).not.toContain(forbidden);
    }
  });

  it("coach_bookings has no Stripe checkout/session/payment-intent columns and does not reuse any subscription field", () => {
    const idx = codeLower.indexOf("create table if not exists public.coach_bookings");
    const endIdx = codeLower.indexOf("comment on  table  public.coach_bookings", idx);
    const searchEnd = endIdx === -1 ? idx + 2000 : endIdx;
    const slice = codeLower.slice(idx, searchEnd);
    for (const forbidden of ["stripe", "checkout_session", "payment_intent", "subscription_id", "subscription_tier"]) {
      expect(slice, `expected coach_bookings to not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("supabase-schema-v6.sql — existing systems are untouched", () => {
  it("does not alter public.users, public.coach_golfer_relationships, public.coach_feedback, or public.lesson_plans", () => {
    for (const table of [
      "public.users",
      "public.coach_golfer_relationships",
      "public.coach_feedback",
      "public.lesson_plans",
    ]) {
      expect(codeLower).not.toMatch(new RegExp(`alter\\s+table\\s+${table.replace(".", "\\.")}\\b`));
    }
  });

  it("only references public.users as a foreign-key target (golfer_id), never altering it", () => {
    expect(codeLower).toMatch(/references\s+public\.users\s*\(\s*id\s*\)/);
    expect(codeLower).not.toMatch(/alter\s+table\s+public\.users\b/);
  });

  it("does not touch storage, drills, or user_drills objects", () => {
    for (const forbidden of ["storage.objects", "storage.buckets", "public.drills", "public.user_drills"]) {
      expect(codeLower).not.toContain(forbidden.toLowerCase());
    }
  });
});
