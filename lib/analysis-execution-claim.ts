import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * SwingProAI — durable analysis execution claim (ENT-1D).
 *
 * One analysis may be worked on by one request at a time, and a model call is
 * made only by the request that holds the current claim. The claim lives in
 * the row itself (migration 20261026120000_ent1d_analysis_execution_lease):
 *
 *   processing_claim_id      who holds the row — a fresh UUID per claim
 *   processing_started_at    when that claim was taken
 *   processing_heartbeat_at  the claim's last sign of life
 *   provider_dispatched_at   when the holder handed the work to the model
 *
 * Every transition is ONE conditional UPDATE through the server-only writer.
 * Postgres re-checks the WHERE clause against the newest row version once it
 * holds the row lock, so of any number of simultaneous requests exactly one
 * matches; the others affect zero rows. Every later write by the holder —
 * dispatch, heartbeat, completion, failure — carries its claim id as a filter,
 * so a request whose claim was superseded writes nothing (fencing). It also
 * carries the claim id as processing_claim_proof, which the database's
 * execution guard checks (see holderWrite); the guard also refuses
 * status-only claims, so a writer that knows nothing of the lease cannot
 * claim a row, or release or complete one that holds a claim. (It can still
 * finish a lease-less processing row it claimed before the guard existed, and
 * mark a pending row failed; see docs/ENT1D_ROLLOUT_NOTES.md.)
 *
 * Recovery, and its limit
 * -----------------------
 * A claim whose heartbeat is older than the lease can be taken over ONLY if
 * its holder never dispatched to the model (provider_dispatched_at is null):
 * then no provider work can be in flight for it and a new attempt duplicates
 * nothing. Once dispatched, an expired lease proves only that the holder
 * stopped reporting — not that the provider request stopped or never
 * completed. Such a row is "stalled": it is never re-run automatically, and is
 * released only by an explicit operator action (see the migration header).
 * Exactly-once provider execution is not claimed anywhere; what is guaranteed
 * is that no automatic path starts a second model call for an analysis whose
 * first call may still have happened.
 *
 * A dispatched attempt that ends in a definite failure the holder observed —
 * the provider answered with an error status or an unusable response, or the
 * result could not be saved — is released as 'failed'. A later request from
 * the golfer starts a new attempt and may make a new provider call. That retry
 * is the golfer's explicit action, not an automatic one, and it is accepted
 * spend. A dispatched call that ends WITHOUT a definite answer (transport
 * error, abort, timeout) is not released: markClaimOutcomeUnknown makes it
 * stalled, because the provider may have run.
 *
 * Timestamps are written from the server clock. The lease (15 minutes) is three
 * times the route's maximum duration (300 s), so clock skew between the
 * function host and the database cannot make a live claim look stale; and a
 * takeover additionally requires that no dispatch was ever recorded.
 */

/** Seconds after the last heartbeat at which an undispatched claim may be taken over. */
export const ANALYSIS_LEASE_SECONDS = 900;

export type ExecutionFamily = "full_swing" | "putting";

/** The execution-state columns, read only by the server. */
export const ANALYSIS_EXECUTION_COLUMNS =
  "id, user_id, status, processing_claim_id, processing_heartbeat_at, provider_dispatched_at";

const CLAIMABLE_STATUSES = ["pending", "failed"];

export type ClaimOutcome =
  | { readonly outcome: "claimed"; readonly claimId: string; readonly recovered: boolean }
  | { readonly outcome: "not_claimed" }
  | { readonly outcome: "unavailable" };

export type ExecutionState =
  | "complete"
  | "in_progress"
  | "stalled"
  | "not_startable"
  | "not_found"
  | "unavailable";

interface ClaimTarget {
  readonly analysisId: string;
  readonly userId: string;
  readonly family: ExecutionFamily;
}

interface HeldClaim {
  readonly analysisId: string;
  readonly userId: string;
  readonly claimId: string;
}

type Filterable<T> = {
  eq(column: string, value: unknown): T;
  or(filter: string): T;
};

/** Restates the analysis family on every elevated statement. */
function inFamily<T extends Filterable<T>>(query: T, family: ExecutionFamily): T {
  return family === "putting"
    ? query.eq("analysis_family", "putting")
    : query.or("analysis_family.is.null,analysis_family.eq.full_swing");
}

function analyses() {
  return createAdminClient().from("swing_analysis");
}

const exactlyOne = (data: unknown): boolean => Array.isArray(data) && data.length === 1;

/**
 * Takes the claim, or reports why not. A fresh claim comes from pending or
 * failed; failing that, an expired claim whose holder never dispatched may be
 * taken over. Never throws.
 */
export async function claimAnalysisExecution(
  target: ClaimTarget,
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  const claimId = randomUUID();
  const stamp = now.toISOString();
  const patch = {
    status: "processing",
    processing_claim_id: claimId,
    processing_started_at: stamp,
    processing_heartbeat_at: stamp,
    provider_dispatched_at: null,
  };

  try {
    const fresh = await inFamily(
      analyses().update(patch).eq("id", target.analysisId).eq("user_id", target.userId),
      target.family,
    )
      .in("status", CLAIMABLE_STATUSES)
      .select("id");
    if (fresh.error || !Array.isArray(fresh.data)) return { outcome: "unavailable" };
    if (exactlyOne(fresh.data)) return { outcome: "claimed", claimId, recovered: false };

    const cutoff = new Date(now.getTime() - ANALYSIS_LEASE_SECONDS * 1000).toISOString();
    const takeover = await inFamily(
      analyses().update(patch).eq("id", target.analysisId).eq("user_id", target.userId),
      target.family,
    )
      .eq("status", "processing")
      .is("provider_dispatched_at", null)
      .lt("processing_heartbeat_at", cutoff)
      .select("id");
    if (takeover.error || !Array.isArray(takeover.data)) return { outcome: "unavailable" };
    if (exactlyOne(takeover.data)) return { outcome: "claimed", claimId, recovered: true };
    return { outcome: "not_claimed" };
  } catch {
    // An unconstructable writer is an outage, never a claim.
    return { outcome: "unavailable" };
  }
}

/**
 * A guarded write by the current holder; `true` only if exactly one row moved.
 *
 * The claim id is both a filter (the application's fence) and, as
 * processing_claim_proof, part of the written row: the database's execution
 * guard (migration 20261027120000) refuses a write that keeps or clears a
 * processing row's claim unless its proof is that claim, and consumes the
 * proof so it is never stored. Code that does not know the claim (an older
 * application version, a stale request) cannot present it. A takeover, which
 * replaces the claim, carries no proof; the guard admits it only for an
 * undispatched claim, and the application decides when the lease has expired.
 */
async function holderWrite(
  claim: HeldClaim,
  patch: Record<string, unknown>,
  options: { readonly dispatch?: "undispatched" | "dispatched" } = {},
): Promise<boolean> {
  try {
    const query = analyses()
      .update({ ...patch, processing_claim_proof: claim.claimId })
      .eq("id", claim.analysisId)
      .eq("user_id", claim.userId)
      .eq("status", "processing")
      .eq("processing_claim_id", claim.claimId);
    const guarded =
      options.dispatch === "undispatched"
        ? query.is("provider_dispatched_at", null)
        : options.dispatch === "dispatched"
          ? // Dispatched, and not marked outcome-unknown (that heartbeat is the epoch).
            query.not("provider_dispatched_at", "is", null).gt("processing_heartbeat_at", OUTCOME_UNKNOWN_HEARTBEAT)
          : query;
    const { data, error } = await guarded.select("id");
    return !error && exactlyOne(data);
  } catch {
    return false;
  }
}

/**
 * Records that the holder is about to call the model. Must succeed before the
 * call is made: `false` means the claim is no longer this request's, and the
 * caller must not call the provider.
 */
export function markProviderDispatched(claim: HeldClaim, now: Date = new Date()): Promise<boolean> {
  const stamp = now.toISOString();
  return holderWrite(
    claim,
    { provider_dispatched_at: stamp, processing_heartbeat_at: stamp },
    { dispatch: "undispatched" },
  );
}

/** Extends the holder's lease. For long-running workers; `false` means fenced out. */
export function heartbeatAnalysisClaim(claim: HeldClaim, now: Date = new Date()): Promise<boolean> {
  return holderWrite(claim, { processing_heartbeat_at: now.toISOString() });
}

/**
 * Releases the holder's claim as failed. A superseded holder changes nothing,
 * and a completed analysis can never be turned into a failed one.
 *
 * An undispatched claim is released with its lease cleared (see
 * releaseUndispatchedClaimAsFailed). A dispatched claim keeps its lease, so
 * the record that the provider was reached survives the release. Each case is
 * one guarded single-row UPDATE that restates holder, status and dispatch
 * state, so neither can land on the other's row state. A claim whose outcome
 * was marked unknown is never released by either: it stays stalled.
 */
export async function releaseAnalysisClaimAsFailed(claim: HeldClaim): Promise<boolean> {
  if (await releaseUndispatchedClaimAsFailed(claim)) return true;
  return holderWrite(claim, { status: "failed" }, { dispatch: "dispatched" });
}

/**
 * The provider was dispatched and the call ended without a definite answer
 * (transport error, abort, timeout): the provider may have run. The claim is
 * kept, dispatched, and made immediately stale, so the analysis reads as
 * stalled at once and is never claimable again without an operator. Only the
 * current holder can do this.
 */
export function markClaimOutcomeUnknown(claim: HeldClaim): Promise<boolean> {
  return holderWrite(claim, { processing_heartbeat_at: OUTCOME_UNKNOWN_HEARTBEAT });
}

/** A heartbeat older than any lease: the claim is stale from the moment it is set. */
const OUTCOME_UNKNOWN_HEARTBEAT = "1970-01-01T00:00:00.000Z";

/**
 * Releases the holder's claim as failed ONLY if no dispatch was ever recorded
 * for it. Used when the dispatch mark itself was refused: a database error or
 * a lost response does not prove the mark was not persisted, and a persisted
 * mark must never be cleared by turning the row into a retryable failure.
 * `false` leaves the row as it is (in progress, then stalled for an operator).
 *
 * The whole lease is cleared in the same UPDATE as the status. A failed row
 * that kept an undispatched lease would hand it to a status-only claim written
 * by an older application version still serving (it sets processing and
 * nothing else); once the lease aged out, this module would take the row over
 * while that older request was still running (ENT-1D R1). With no lease, such
 * a row reads as stalled instead. All four columns go together: the
 * claim-shape CHECK admits only an all-null or a complete lease.
 */
export function releaseUndispatchedClaimAsFailed(claim: HeldClaim): Promise<boolean> {
  return holderWrite(claim, { status: "failed", ...CLEARED_LEASE }, { dispatch: "undispatched" });
}

const CLEARED_LEASE = {
  processing_claim_id: null,
  processing_started_at: null,
  processing_heartbeat_at: null,
  provider_dispatched_at: null,
} as const;

/**
 * The execution state of an owned analysis, for answering a request that did
 * not get the claim. Read by the server, bounded by id, owner and family.
 */
export async function readExecutionState(
  target: ClaimTarget,
  now: Date = new Date(),
): Promise<ExecutionState> {
  try {
    const owned = analyses()
      .select(ANALYSIS_EXECUTION_COLUMNS)
      .eq("id", target.analysisId)
      .eq("user_id", target.userId);
    const scoped =
      target.family === "putting"
        ? owned.eq("analysis_family", "putting")
        : owned.or("analysis_family.is.null,analysis_family.eq.full_swing");
    const { data, error } = await scoped.maybeSingle();
    if (error) return "unavailable";
    if (!data) return "not_found";
    const row = data as {
      status?: unknown;
      processing_claim_id?: unknown;
      processing_heartbeat_at?: unknown;
      provider_dispatched_at?: unknown;
    };
    if (row.status === "complete") return "complete";
    if (row.status !== "processing") return "not_startable";
    // Claimed by code that recorded no lease (the window between the lease
    // migration and this application's deploy): whether its model call
    // happened is unknown, so it is stalled, never re-run automatically.
    if (row.processing_claim_id === null || row.processing_claim_id === undefined) return "stalled";
    const heartbeat = typeof row.processing_heartbeat_at === "string" ? Date.parse(row.processing_heartbeat_at) : NaN;
    const stale = !Number.isFinite(heartbeat) || heartbeat < now.getTime() - ANALYSIS_LEASE_SECONDS * 1000;
    return stale && row.provider_dispatched_at !== null && row.provider_dispatched_at !== undefined
      ? "stalled"
      : "in_progress";
  } catch {
    return "unavailable";
  }
}
