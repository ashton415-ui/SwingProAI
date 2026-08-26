/**
 * The club designations a golfer may legitimately record for a saved club of a
 * given type.
 *
 * WHY THIS EXISTS
 * ---------------
 * The vocabulary is owned by the database. D1
 * (20260824053500_equipment_user_club_designation.sql) installed two CHECK
 * constraints on public.user_equipment:
 *
 *   user_equipment_club_designation_vocabulary        — the 28 legal tokens
 *   user_equipment_club_designation_club_type_compat  — which of them each
 *                                                       club_type accepts
 *
 * Those constraints remain the authority. This module exists so that the one
 * or two browser surfaces that offer a designation choice narrow the options
 * the same way the database does, instead of each transcribing the vocabulary
 * and drifting from it. A rejected INSERT is correct behaviour, not a design
 * goal — the point is that a golfer should never be shown a choice the row can
 * never hold.
 *
 * WHY DRIVER AND PUTTER RETURN NOTHING
 * ------------------------------------
 * Neither appears in a branch of the compatibility constraint, so no non-null
 * designation is legal for them. That is expressed here as an empty option
 * list rather than as a sentinel value: `null` already means "not stated or
 * not applicable", and inventing an "Unknown"/"Other"/"N/A" token would put a
 * string into an immutable equipment snapshot that no golfer chose.
 *
 * WHY PW IS LISTED TWICE
 * ----------------------
 * A pitching wedge ships as either the last iron or the first wedge depending
 * on the set. D1 permits it under both club types deliberately, and collapsing
 * it into one family here would silently overrule the golfer's own reading of
 * their own bag.
 *
 * This module is pure: no database access, no catalog lookup, no inference
 * from model, manufacturer, loft, brand or any other saved club.
 */

import type { ClubDesignation, ClubType } from "@/types/database";

const WOOD: readonly ClubDesignation[] = ["2W", "3W", "4W", "5W", "7W", "9W", "11W"];

const HYBRID: readonly ClubDesignation[] = ["1H", "2H", "3H", "4H", "5H", "6H", "7H"];

const IRON: readonly ClubDesignation[] = [
  "1I",
  "2I",
  "3I",
  "4I",
  "5I",
  "6I",
  "7I",
  "8I",
  "9I",
  "PW",
];

const WEDGE: readonly ClubDesignation[] = ["PW", "AW", "GW", "SW", "LW"];

/** Driver and Putter share this: no non-null designation is legal for either. */
const NONE: readonly ClubDesignation[] = [];

/**
 * Transcribed from the club-type branches of
 * user_equipment_club_designation_club_type_compat. Exhaustive over ClubType,
 * so a new club type becomes a compile error here rather than silently
 * inheriting someone else's list.
 */
const BY_CLUB_TYPE: Readonly<Record<ClubType, readonly ClubDesignation[]>> = {
  Driver: NONE,
  Wood: WOOD,
  Hybrid: HYBRID,
  Iron: IRON,
  Wedge: WEDGE,
  Putter: NONE,
};

/**
 * The designations valid for `clubType`, in bag order. Empty for Driver and
 * Putter. The returned array is the shared frozen-by-convention constant —
 * callers must not mutate it.
 */
export function getClubDesignationOptions(clubType: ClubType): readonly ClubDesignation[] {
  return BY_CLUB_TYPE[clubType];
}

/**
 * True when `designation` is legal for `clubType`. Used at submit time so a
 * value left over from a previous club type resolves to null rather than
 * reaching the database, and so Driver/Putter always resolve to null.
 */
export function isClubDesignationValidFor(
  clubType: ClubType,
  designation: ClubDesignation | ""
): designation is ClubDesignation {
  if (designation === "") return false;
  return getClubDesignationOptions(clubType).includes(designation);
}
