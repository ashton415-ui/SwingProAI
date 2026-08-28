/**
 * The single display name for one saved club.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two surfaces need to name a saved club: the My Bag row and the saved-club
 * query layer that feeds the selector. Until D4 each carried its own copy of
 * the same identity-precedence rules, so a change to one silently diverged from
 * the other. This module is now the only production implementation, and both
 * consumers call it.
 *
 * DESIGNATION-FIRST NAMING
 * ------------------------
 * A golfer who owns a 4-iron and a 7-iron from one set has two saved rows that
 * differ in nothing a name can show — same manufacturer, same model family. The
 * designation is what tells them apart, so when the row carries one it leads the
 * name:
 *
 *   7I · PING G440
 *
 * A row with no designation reads exactly as it did before D4, so nothing about
 * an undesignated bag changes.
 *
 * WHY THE PREFIX IS GATED, NOT ASSUMED
 * ------------------------------------
 * `club_designation` is validated by two database CHECK constraints, so an
 * incompatible value should be impossible. Should one somehow reach this
 * function anyway, it is dropped and the ordinary identity name is returned —
 * never repaired, never substituted, never guessed at. A driver or putter has
 * no legal designation at all and therefore never takes a prefix. The
 * compatibility decision is delegated to the D1-derived helper rather than
 * re-encoded here, so this module holds no designation vocabulary of its own.
 *
 * Nothing here infers a designation from loft, brand, model, manufacturer,
 * shaft, catalog linkage, primary status, telemetry or snapshot history. Only
 * the stored column may supply the prefix.
 *
 * Pure: no React, no Supabase, no database, no catalog, no routing.
 */

import type { UserEquipment } from "@/types/database";
import { isClubDesignationValidFor } from "@/lib/equipment/club-designation-options";

/**
 * Exactly the saved-row fields a name is built from. Derived from the
 * authoritative row type rather than redeclared, so a column rename cannot
 * leave this contract quietly stale.
 */
export type ClubDisplayNameInput = Pick<
  UserEquipment,
  | "club_type"
  | "club_designation"
  | "brand"
  | "model"
  | "custom_club"
  | "custom_brand"
  | "custom_model"
>;

/** Space + U+00B7 middle dot + space. The one place this separator is written. */
export const CLUB_DISPLAY_NAME_SEPARATOR = " · ";

/**
 * The identity half of the name, unchanged from the pre-D4 behaviour both
 * consumers shared.
 *
 * Custom rows prefer their custom text, then any legacy text, then the word
 * "Custom" so the row stays nameable. Non-custom rows — canonical and legacy
 * alike, since a canonical selection stores a readable snapshot — use the saved
 * brand/model, falling back to the club type rather than inventing a
 * manufacturer or model.
 */
function identityName(club: ClubDisplayNameInput): string {
  if (club.custom_club) {
    const brandPart = club.custom_brand ?? club.brand ?? "Custom";
    const modelPart = club.custom_model ?? club.model ?? "";
    return `${brandPart} ${modelPart}`.trim();
  }

  const name = `${club.brand ?? ""} ${club.model ?? ""}`.trim();
  return name.length > 0 ? name : club.club_type;
}

/**
 * The display name for a saved club: the golfer's designation first when the
 * row carries one that is legal for its club type, otherwise the identity name
 * alone.
 */
export function getClubDisplayName(club: ClubDisplayNameInput): string {
  const identity = identityName(club);

  if (!isClubDesignationValidFor(club.club_type, club.club_designation ?? "")) {
    return identity;
  }

  return `${club.club_designation}${CLUB_DISPLAY_NAME_SEPARATOR}${identity}`;
}
