// Privileged database operations for the swing-analysis route. All raw
// Supabase query chains for the `swings` table live here so app.js/index.js
// never build them inline. Every function returns a structured result —
// { ok: false } on any database failure — and never exposes or logs the raw
// Supabase error. Callers are responsible for safe, categorized logging.
import { CANONICAL_STATUS } from './swingStatus.js';

/**
 * Reads the current id/user_id/status for a swing row.
 * Returns { ok: true, swing } where swing is null if no row matched,
 * or { ok: false } if the database call itself failed.
 */
async function getSwingState(supabase, swingId) {
  try {
    const { data, error } = await supabase
      .from('swings')
      .select('id, user_id, status')
      .eq('id', swingId)
      .maybeSingle();

    if (error) return { ok: false };
    return { ok: true, swing: data ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Re-reads swing state after a lost claim (conflicting request won the
 * conditional update first). Same shape as getSwingState — kept as a
 * separate named entry point so callers can attribute a distinct safe log
 * category to a failure here vs. the initial lookup.
 */
async function getSwingStateAfterClaimConflict(supabase, swingId) {
  return getSwingState(supabase, swingId);
}

/**
 * Attempts the single atomic compare-and-set claim: only succeeds if the
 * row still has id=swingId, user_id=userId, and status exactly equal to
 * exactStatus (the precise string previously read from the row, whatever
 * its case). On success the row's status is set to PROCESSING.
 *
 * Returns { ok: true, claimed: boolean, row } — claimed is true only when
 * this call's conditional update matched and changed a row (i.e. this
 * request won the claim). { ok: false } indicates a database failure.
 */
async function claimSwingForAnalysis(supabase, { swingId, userId, exactStatus }) {
  try {
    const { data, error } = await supabase
      .from('swings')
      .update({ status: CANONICAL_STATUS.PROCESSING })
      .eq('id', swingId)
      .eq('user_id', userId)
      .eq('status', exactStatus)
      .select('id, status')
      .maybeSingle();

    if (error) return { ok: false };
    return { ok: true, claimed: Boolean(data), row: data ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Guarded terminal update: marks a swing COMPLETE with its telemetry data,
 * but only if it is still exactly id=swingId, user_id=userId,
 * status=PROCESSING at the moment of the write. If the row has moved on
 * (e.g. already ERROR from another path), this affects zero rows rather
 * than overwriting it.
 *
 * Returns { ok: true, changed: boolean, row }; { ok: false } on database
 * failure.
 */
async function completeSwingAnalysis(supabase, { swingId, userId, telemetryData }) {
  try {
    const { data, error } = await supabase
      .from('swings')
      .update({ status: CANONICAL_STATUS.COMPLETE, telemetry_data: telemetryData })
      .eq('id', swingId)
      .eq('user_id', userId)
      .eq('status', CANONICAL_STATUS.PROCESSING)
      .select('id, status')
      .maybeSingle();

    if (error) return { ok: false };
    return { ok: true, changed: Boolean(data), row: data ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Guarded failure transition: marks a swing ERROR, but only if it is still
 * exactly id=swingId, user_id=userId, status=PROCESSING. If the row has
 * already become COMPLETE (or moved elsewhere), this affects zero rows and
 * never overwrites a completed result.
 *
 * Returns { ok: true, changed: boolean, row }; { ok: false } on database
 * failure.
 */
async function markSwingErrorIfProcessing(supabase, { swingId, userId }) {
  try {
    const { data, error } = await supabase
      .from('swings')
      .update({ status: CANONICAL_STATUS.ERROR })
      .eq('id', swingId)
      .eq('user_id', userId)
      .eq('status', CANONICAL_STATUS.PROCESSING)
      .select('id, status')
      .maybeSingle();

    if (error) return { ok: false };
    return { ok: true, changed: Boolean(data), row: data ?? null };
  } catch {
    return { ok: false };
  }
}

export {
  getSwingState,
  getSwingStateAfterClaimConflict,
  claimSwingForAnalysis,
  completeSwingAnalysis,
  markSwingErrorIfProcessing,
};
