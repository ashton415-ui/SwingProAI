/**
 * Single source of truth for the checked-in Supabase migration inventory.
 *
 * Before this module existed, the approved migration list was declared
 * independently in three test files. Every new migration therefore required
 * amending several hard-coded lists, and two separate gates were BLOCKED when a
 * list that had not been updated rejected a legitimate new migration.
 *
 * The data lives here; the assertions stay in the tests. In particular
 * lib/migration-history-bridge.test.ts remains the closed-world authority — it
 * still asserts exact set equality and an exact count against this list, so an
 * unexpected file on disk is still a hard failure. This module only removes the
 * duplication, never the strictness.
 *
 * Adding a migration means editing APPROVED_MIGRATIONS here (and recording a
 * canonical fingerprint in the bridge test where that applies) — one place.
 */

/** The 16 approved historical migration-history bridge files, in file order. */
export const BRIDGE_MIGRATIONS: { version: string; name: string }[] = [
  { version: "20260602035147", name: "swingproai_initial_schema" },
  { version: "20260602035215", name: "lock_down_handle_new_user" },
  { version: "20260603034557", name: "add_stripe_subscription_fields" },
  { version: "20260603163859", name: "swing_videos_upload_fields_and_storage" },
  { version: "20260604114619", name: "add_trim_points_to_swing_videos" },
  { version: "20260604164318", name: "add_role_coach_system" },
  { version: "20260605010541", name: "tier_based_analysis_routing" },
  { version: "20260605015917", name: "phase2_caddy_putting_courses" },
  { version: "20260611030421", name: "coach_hub_tables" },
  { version: "20260611185400", name: "coach_invite_codes" },
  { version: "20260611190546", name: "automated_prescriptions_session_link" },
  { version: "20260711225631", name: "create_user_clubs_table" },
  { version: "20260711231548", name: "enable_rls_swings_text_user_id" },
  { version: "20260711231750", name: "fix_swings_rls_drop_public_policy_and_dupes" },
  { version: "20260711231833", name: "enable_rls_user_bags_clean" },
  { version: "20260712143342", name: "create_rounds_table" },
];

/** Builds the on-disk filename for a bridge entry. */
export function bridgeFilename(b: { version: string; name: string }): string {
  return `${b.version}_${b.name}.sql`;
}

/** The 16 bridge filenames, in file order. */
export const BRIDGE_FILENAMES: string[] = BRIDGE_MIGRATIONS.map(bridgeFilename);

export const BASELINE_FILENAME = "20260721220000_swingproai_production_baseline.sql";
export const S1R_FILENAME = "20260725020835_equipment_intelligence_putting_foundation.sql";
export const S2_FILENAME = "20260725174239_equipment_putter_catalog_v1.sql";
export const SEC1B_FN_FILENAME = "20260729054500_pin_function_search_path.sql";
export const SEC1C_FILENAME =
  "20260730035500_revoke_anon_execute_link_student_to_coach.sql";
export const SEC1D_POL_FILENAME =
  "20260731220500_drop_weak_policies_sec1a_contract.sql";
export const SEC1F_RANGE_SESSIONS_FILENAME =
  "20260804022105_add_range_sessions_owner_policies.sql";

/**
 * Every approved checked-in migration filename, in timestamp order.
 * This is the closed-world set: anything on disk that is not listed here is a
 * failure, and anything listed here that is missing from disk is a failure.
 */
export const APPROVED_MIGRATIONS: string[] = [
  ...BRIDGE_FILENAMES,
  BASELINE_FILENAME,
  S1R_FILENAME,
  S2_FILENAME,
  SEC1B_FN_FILENAME,
  SEC1C_FILENAME,
  SEC1D_POL_FILENAME,
  SEC1F_RANGE_SESSIONS_FILENAME,
];

/** The exact number of approved checked-in migrations. */
export const EXPECTED_MIGRATION_COUNT = APPROVED_MIGRATIONS.length;

/**
 * The approved migrations that already existed when `filename` was authored —
 * that is, every approved migration sorting strictly before it.
 *
 * Tests use this instead of "is the newest migration on disk". A per-migration
 * test should assert its own historical contract (it came after everything that
 * existed at the time) rather than a claim that silently expires the moment a
 * later migration is added.
 */
export function migrationsAuthoredBefore(filename: string): string[] {
  return APPROVED_MIGRATIONS.filter((m) => m < filename);
}

/** True when `filename` sorts strictly after every entry in `others`. */
export function sortsAfterAll(filename: string, others: string[]): boolean {
  return others.every((other) => filename > other);
}
