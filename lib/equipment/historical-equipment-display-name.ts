import type { ClubDesignation, ClubType } from "@/types/database";
import { isClubDesignationValidFor } from "@/lib/equipment/club-designation-options";
import { CLUB_DISPLAY_NAME_SEPARATOR } from "@/lib/equipment/club-display-name";

/**
 * The display name for the club an analysis was recorded with, read from the
 * immutable equipment snapshot and nothing else.
 *
 * WHY THIS IS NOT getClubDisplayName()
 * ------------------------------------
 * That function names a club the golfer owns *now*, from a live
 * public.user_equipment row. This one names a club as it was at the moment an
 * analysis was inserted, from public.swing_analysis.equipment_snapshot — a
 * jsonb record the database writes in a before-insert trigger and freezes
 * afterwards. The two read different fields (`brand`/`model` against
 * `entered_brand`/`entered_model`), and they must stay separate for a reason
 * that outlives the field names: editing, archiving or deleting a saved club
 * must never retroactively rename a swing the golfer already took.
 *
 * That is also why nothing here reaches for the live row, the canonical
 * catalog, `club_id`, or anything else that can change after capture. The
 * snapshot is the whole evidence base. Pure: no React, no Supabase, no fetch,
 * no database, no clock, no randomness.
 *
 * WHY THE INPUT IS `unknown`
 * --------------------------
 * The column is jsonb and its rows outlive any one TypeScript shape. Snapshots
 * written before V2 existed are still V1, and a row could hold something no
 * version ever described. So the value is validated here rather than asserted,
 * and anything unrecognised resolves to null — the caller's own legacy fallback
 * is a better answer than a guess or a thrown error.
 *
 * WHY THERE IS NO club_type FALLBACK
 * ----------------------------------
 * A snapshot always knows the club type, so returning "Putter" or "Iron" when
 * no identity text survives would always succeed — and would silently outrank
 * the legacy swing_videos.club value, which may well name the actual club. A
 * generic word is not an identity, so this returns null instead and lets the
 * caller fall back to what it had before.
 */

/** The application's club-type vocabulary, as persisted into a snapshot. */
const CLUB_TYPES: readonly ClubType[] = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];

/** The snapshot versions this module knows how to read. */
const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * A text field is usable only when it is a string that survives trimming.
 * Whitespace-only values are treated as absent, never rendered as a name.
 * The surviving text is returned verbatim — capitalisation and punctuation are
 * the golfer's own and are not normalised here.
 */
function usableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Joins whichever identity pieces survived, in order. Null when none did. */
function joinIdentity(parts: readonly (string | null)[]): string | null {
  const usable = parts.filter((part): part is string => part !== null);
  return usable.length > 0 ? usable.join(" ") : null;
}

/** The club type, only when it is one this application recognises. */
function readClubType(value: unknown): ClubType | null {
  if (typeof value !== "string") return null;
  return CLUB_TYPES.find((clubType) => clubType === value) ?? null;
}

/**
 * The identity text, in the order the snapshot records it.
 *
 * Custom rows lead with the golfer's own words. Everything else leads with the
 * entered brand/model, because a canonical catalog selection copies its
 * readable choice into exactly those fields at save time — so they carry the
 * identity as the golfer saw it. The canonical manufacturer/model names are the
 * last resort: still snapshot evidence, frozen at capture, never a live lookup.
 */
function identityOf(snapshot: Record<string, unknown>): string | null {
  if (snapshot.custom_club === true) {
    const custom = joinIdentity([
      usableText(snapshot.custom_brand),
      usableText(snapshot.custom_model),
    ]);
    if (custom !== null) return custom;
  }

  const entered = joinIdentity([
    usableText(snapshot.entered_brand),
    usableText(snapshot.entered_model),
  ]);
  if (entered !== null) return entered;

  const manufacturer = asRecord(snapshot.manufacturer);
  const model = asRecord(snapshot.model);
  return joinIdentity([
    manufacturer === null ? null : usableText(manufacturer.canonical_name),
    model === null ? null : usableText(model.canonical_name),
  ]);
}

/**
 * The designation prefix, or null.
 *
 * V1 predates the column and never carries one; inferring a designation for a
 * V1 row would invent evidence. V2 may prefix only the value the database
 * copied from the saved club, and only where that value is legal for the club
 * type — the compatibility decision belongs to the D1-derived helper, so no
 * designation vocabulary is restated here. Driver and Putter accept none, so
 * neither ever takes a prefix.
 */
function designationOf(snapshot: Record<string, unknown>, clubType: ClubType): string | null {
  if (snapshot.schema_version !== 2) return null;
  const designation = snapshot.club_designation;
  if (typeof designation !== "string") return null;
  if (!isClubDesignationValidFor(clubType, designation as ClubDesignation)) return null;
  return designation;
}

/**
 * The historical club name for one analysis, or null when the snapshot cannot
 * name a club. Never throws, and never returns a placeholder word: a caller
 * that gets null still has its own legacy fallback to use.
 */
export function getHistoricalEquipmentDisplayName(snapshot: unknown): string | null {
  const record = asRecord(snapshot);
  if (record === null) return null;

  if (typeof record.schema_version !== "number") return null;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(record.schema_version)) return null;

  // Validated before anything consults designation compatibility: that lookup
  // is keyed by club type, and an unrecognised key has no option list to test
  // against. Failing safe here keeps a malformed row from throwing at render.
  const clubType = readClubType(record.club_type);
  if (clubType === null) return null;

  const identity = identityOf(record);
  if (identity === null) return null;

  const designation = designationOf(record, clubType);
  return designation === null ? identity : `${designation}${CLUB_DISPLAY_NAME_SEPARATOR}${identity}`;
}

/**
 * One historical name for a set of snapshots, or null when they do not agree.
 *
 * The admin video list is video-centered while snapshot authority is
 * analysis-centered, and the database does not make swing_analysis.swing_video_id
 * unique — one video can carry several analyses. Where they all name the same
 * club there is nothing to decide; where they disagree there is no basis for
 * preferring one, so this reports no consensus rather than picking the first,
 * the newest or the highest-scoring. Disagreement is a fact about the data, and
 * quietly resolving it would present one analysis's equipment as the video's.
 */
export function getHistoricalEquipmentDisplayNameConsensus(
  snapshots: readonly unknown[],
): string | null {
  let agreed: string | null = null;

  for (const snapshot of snapshots) {
    const name = getHistoricalEquipmentDisplayName(snapshot);
    if (name === null) continue;
    if (agreed === null) {
      agreed = name;
      continue;
    }
    if (agreed !== name) return null;
  }

  return agreed;
}
