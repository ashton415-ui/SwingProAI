/**
 * SwingProAI — EQ3-S1: pure selection rules for the Analyze club selector.
 *
 * Two decisions in the Analyze flow are security-relevant enough that they
 * should not live inline in an 800-line page component, and should not be
 * proven by searching that page for substrings:
 *
 *   1. whether a `club_id` query parameter may initialize the selection, and
 *   2. whether a club the golfer picked earlier is still selectable at the
 *      moment they submit.
 *
 * Both are the same question — "is this exact id present in the current active,
 * owned result?" — so both live here, as pure functions over an already-fetched
 * SavedClubsResult. No fetching, no client, no React, no side effects.
 *
 * WHY THE QUERY PARAMETER IS NEVER AUTHORIZATION
 * ----------------------------------------------
 * My Bag deep-links to /analyze?club_id=<saved-user-equipment-id>, so the value
 * usually is the golfer's own club. It is still only a hint: anyone can type a
 * different id into the address bar. Membership of the current
 * querySavedClubs() result is the only thing that grants selection, and that
 * result is already scoped by the caller's user id and by row-level security,
 * and already excludes archived rows. Nothing here queries by the parameter,
 * infers ownership from it, normalizes it, or repairs it.
 *
 * WHY EVERY REJECTION LOOKS THE SAME
 * ----------------------------------
 * Malformed, nonexistent, foreign and archived ids all resolve to null through
 * the identical path. A distinct "not yours" or "archived" outcome would let a
 * caller probe another golfer's equipment by id, so the four cases are
 * deliberately indistinguishable to the caller.
 *
 * WHY NOTHING IS EVER AUTO-SELECTED
 * ---------------------------------
 * There is no fallback to the primary club, the first club, the first group, or
 * the only club in the bag. A club recorded against an analysis is evidence
 * about what the golfer actually hit; guessing it would corrupt that record.
 * Selecting nothing is always a valid outcome.
 */

import type { SavedClubsResult } from "@/lib/equipment/saved-clubs";

/**
 * The club id a freshly loaded Analyze page may start with, given the URL hint.
 *
 * Returns the id only when the query value is exactly the id of a club in an
 * `ok` result. Every other combination — no parameter, any non-`ok` status, an
 * id that is absent from the list — returns null.
 */
export function resolveInitialClubId(
  result: SavedClubsResult,
  rawQueryClubId: string | null
): string | null {
  if (rawQueryClubId === null) return null;
  // A failed or empty load can never grant a selection, so the hint is dropped
  // rather than held for a later retry.
  if (result.status !== "ok") return null;
  const matches = result.clubs.some((club) => club.id === rawQueryClubId);
  return matches ? rawQueryClubId : null;
}

/**
 * Whether an already-selected club is still selectable in a freshly fetched
 * result.
 *
 * Used at submission time, after the current session has been resolved, to
 * catch a club archived since the selector loaded — before any Storage object
 * or database row is written. It answers only "yes" or "no": there is no
 * fallback club and no repair, because substituting equipment the golfer did
 * not choose would be worse than refusing.
 *
 * This is defence in depth, not the final authority. An archive committing
 * between this check and the INSERT is caught by the database's own
 * active-row guard on the snapshot producer.
 */
export function isSelectionStillValid(
  result: SavedClubsResult,
  selectedClubId: string
): boolean {
  if (result.status !== "ok") return false;
  return result.clubs.some((club) => club.id === selectedClubId);
}

/**
 * EQ3-S2 — whether the club the golfer currently has selected is a saved Putter.
 *
 * THIS HELPER IS UI PRESENTATION ONLY.
 *
 * It is NOT authorization and must never become the authority for
 * analysis_family, swing_category, AI routing, ownership, or persistence. The
 * database derives analysis_family from the validated club_type of the
 * referenced user_equipment row and overwrites anything a client sends; server
 * routing on that value is EQ5A's work, not this function's.
 *
 * Answering true means only: "the desktop Analyze page may describe the capture
 * it is asking for as a putting stroke." The page decides separately whether
 * that classification is allowed to change anything on screen — in particular
 * it must not, once a result already exists, because a completed report is
 * evidence about a swing that was already analyzed and cannot be reinterpreted
 * by a selector the golfer moved afterwards. That `result === null` condition
 * deliberately lives at the call site, not here: this function classifies the
 * selection, it does not decide what the page does with the classification.
 *
 * Every non-selection resolves to false through the same path — no result, a
 * result that is not `ok`, no selected id, an id absent from the list, or any
 * non-Putter club type. As elsewhere in this module, a rejection never reveals
 * which of those it was.
 */
export function isPuttingCapturePresentation(
  result: SavedClubsResult | null,
  selectedClubId: string | null
): boolean {
  if (result === null) return false;
  if (result.status !== "ok") return false;
  if (selectedClubId === null) return false;
  return result.clubs.some(
    (club) => club.id === selectedClubId && club.clubType === "Putter"
  );
}
