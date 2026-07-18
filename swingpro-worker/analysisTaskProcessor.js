// Lease-aware processor for the private Cloud Tasks analysis handler
// (Phase 2B2B3B3B). Claims a job's lease, runs the injected analyzer with
// only database-derived fields, and atomically finalizes the job together
// with the analyzer's returned telemetry via completeAnalysisJob — never the
// legacy succeedAnalysisJob transition. Every branch returns one of the
// documented safe shapes below — never a raw database or analyzer error,
// never analyzer telemetry, and never a sensitive job field.
import { isValidUuid } from './requestSecurity.js';
import * as defaultAnalysisJobRepository from './analysisJobRepository.js';
import { startAnalysisLeaseHeartbeat as defaultStartLeaseHeartbeat } from './analysisLeaseHeartbeat.js';

const LEASE_SECONDS_MIN = 30;
const LEASE_SECONDS_MAX = 3600;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'superseded']);
const BUSY_STATES = new Set(['enqueue_pending', 'queued', 'running']);
const ANALYSIS_FAILED_ERROR_CODE = 'analysis_failed';
const INVALID_ANALYSIS_RESULT_ERROR_CODE = 'invalid_analysis_result';

function isValidLeaseSeconds(value) {
  return Number.isInteger(value) && value >= LEASE_SECONDS_MIN && value <= LEASE_SECONDS_MAX;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validationFailed() {
  return { ok: false, reason: 'validation_failed' };
}

function databaseError() {
  return { ok: false, reason: 'database_error' };
}

/**
 * Rereads the job once and classifies it into one of the documented
 * outcomes shared by every reconciliation path in this module: a missing
 * job or terminal state is always the same idempotent result regardless of
 * why the reread happened; only the reason used for a still-busy job
 * differs by call site (job_busy right after a lost claim vs.
 * lease_or_state_conflict after a lease loss or ambiguous transition), so
 * that is the only thing callers parameterize.
 */
async function rereadAndClassify({ supabase, jobId, swingId, analysisJobRepository, busyReason }) {
  let reread;
  try {
    reread = await analysisJobRepository.getAnalysisJob(supabase, { jobId, swingId });
  } catch {
    return databaseError();
  }
  if (!reread || reread.ok !== true) {
    return databaseError();
  }

  const job = reread.job ?? null;
  if (!job) {
    return { ok: true, jobId, swingId, state: 'ignored', idempotent: true };
  }
  if (TERMINAL_STATES.has(job.state)) {
    return { ok: true, jobId, swingId, state: job.state, idempotent: true };
  }
  if (BUSY_STATES.has(job.state)) {
    return { ok: false, reason: busyReason };
  }
  return { ok: false, reason: 'invalid_state' };
}

function isValidClaimedRow(job, { jobId, swingId }) {
  if (!isPlainObject(job)) return false;
  if (job.id !== jobId) return false;
  if (job.swing_id !== swingId) return false;
  if (job.state !== 'running') return false;
  if (!isNonEmptyString(job.lease_token)) return false;
  if (!isNonEmptyString(job.user_id)) return false;
  if (!isNonEmptyString(job.storage_path)) return false;
  if (job.equipment_context !== null && !isPlainObject(job.equipment_context)) return false;
  if (job.slope !== null && !(typeof job.slope === 'number' && Number.isFinite(job.slope))) return false;
  return true;
}

// A heartbeat is only trustworthy enough to drive lease-loss decisions when
// it exposes exactly the documented shape — anything else (a thrown
// constructor, a stub missing a method, a non-boolean signal.aborted) is
// treated the same as a database failure rather than risking a silent
// double-terminal-transition.
function isValidHeartbeat(heartbeat) {
  return (
    isPlainObject(heartbeat) &&
    typeof heartbeat.stop === 'function' &&
    typeof heartbeat.hasLostLease === 'function' &&
    isPlainObject(heartbeat.signal) &&
    typeof heartbeat.signal.aborted === 'boolean'
  );
}

// Shared strict-shape check for both complete/fail RPC results: only a
// changed:true result whose returned job unambiguously matches this exact
// job/swing pair and lands in the expected terminal state counts as a
// confirmed non-idempotent transition. Anything else — including a truthy
// but malformed job, or one that reports a different id/state — falls
// through to the existing single-reread reconciliation instead of being
// trusted at face value. Every property read is contained: a hostile result
// (throwing getters, a revoked Proxy) is treated the same as a malformed
// result rather than being allowed to propagate and crash the processor.
// result.job is read into a local exactly once — a hostile getter that
// returns a different object on each access must never let fields from
// multiple objects be combined into a falsely confirmed transition.
function isConfirmedTerminalTransition(result, { jobId, swingId, expectedState }) {
  try {
    if (!isPlainObject(result)) return false;

    const ok = result.ok;
    const changed = result.changed;
    const job = result.job;

    return (
      ok === true &&
      changed === true &&
      isPlainObject(job) &&
      job.id === jobId &&
      job.swing_id === swingId &&
      job.state === expectedState
    );
  } catch {
    return false;
  }
}

/**
 * Processes a single claimed analysis task end to end. See the module
 * header and CLAUDE.md phase spec for the exact documented result shapes;
 * every branch below is one of:
 *   { ok: false, reason: 'validation_failed' | 'database_error' | 'job_busy'
 *              | 'invalid_state' | 'invalid_job' | 'lease_or_state_conflict' }
 *   { ok: true, jobId, swingId, state, idempotent }
 */
async function processAnalysisTask({
  supabase,
  jobId,
  swingId,
  leaseSeconds,
  analyzeSwing,
  analysisJobRepository = defaultAnalysisJobRepository,
  startLeaseHeartbeat = defaultStartLeaseHeartbeat,
}) {
  if (!isValidUuid(jobId) || !isValidUuid(swingId) || !isValidLeaseSeconds(leaseSeconds) || typeof analyzeSwing !== 'function') {
    return validationFailed();
  }

  let claim;
  try {
    claim = await analysisJobRepository.claimAnalysisJobLease(supabase, { jobId, swingId, leaseSeconds });
  } catch {
    return databaseError();
  }
  if (!claim || claim.ok !== true) {
    return databaseError();
  }

  if (!claim.acquired) {
    return rereadAndClassify({ supabase, jobId, swingId, analysisJobRepository, busyReason: 'job_busy' });
  }

  const claimedJob = claim.job;
  if (!isValidClaimedRow(claimedJob, { jobId, swingId })) {
    return { ok: false, reason: 'invalid_job' };
  }

  const leaseToken = claimedJob.lease_token;

  let heartbeat;
  try {
    heartbeat = startLeaseHeartbeat({
      supabase,
      jobId,
      swingId,
      leaseToken,
      leaseSeconds,
      analysisJobRepository,
    });
  } catch {
    return databaseError();
  }

  let heartbeatIsValid = false;
  try {
    heartbeatIsValid = isValidHeartbeat(heartbeat);
  } catch {
    return databaseError();
  }
  if (!heartbeatIsValid) {
    return databaseError();
  }

  let analyzerResult;
  let analyzerFailureCode = null;
  try {
    analyzerResult = await analyzeSwing({
      swingId,
      storagePath: claimedJob.storage_path,
      equipmentContext: claimedJob.equipment_context ?? null,
      slope: claimedJob.slope ?? null,
      userId: claimedJob.user_id,
      signal: heartbeat.signal,
    });
  } catch {
    analyzerFailureCode = ANALYSIS_FAILED_ERROR_CODE;
  }

  if (analyzerFailureCode === null) {
    let telemetryIsValid = false;
    try {
      telemetryIsValid = isPlainObject(analyzerResult);
    } catch {
      telemetryIsValid = false;
    }
    if (!telemetryIsValid) {
      analyzerFailureCode = INVALID_ANALYSIS_RESULT_ERROR_CODE;
    }
  }

  try {
    await heartbeat.stop();
  } catch {
    return databaseError();
  }

  let leaseLost;
  try {
    leaseLost = heartbeat.hasLostLease() === true || heartbeat.signal.aborted === true;
  } catch {
    return databaseError();
  }

  if (leaseLost) {
    return rereadAndClassify({ supabase, jobId, swingId, analysisJobRepository, busyReason: 'lease_or_state_conflict' });
  }

  if (analyzerFailureCode === null) {
    let completeResult;
    try {
      completeResult = await analysisJobRepository.completeAnalysisJob(supabase, {
        jobId,
        swingId,
        leaseToken,
        telemetryData: analyzerResult,
      });
    } catch {
      completeResult = null;
    }

    if (isConfirmedTerminalTransition(completeResult, { jobId, swingId, expectedState: 'succeeded' })) {
      return { ok: true, jobId, swingId, state: 'succeeded', idempotent: false };
    }

    return rereadAndClassify({ supabase, jobId, swingId, analysisJobRepository, busyReason: 'lease_or_state_conflict' });
  }

  // Analyzer threw or returned invalid telemetry.
  let failResult;
  try {
    failResult = await analysisJobRepository.failAnalysisJob(supabase, {
      jobId,
      swingId,
      leaseToken,
      errorCode: analyzerFailureCode,
    });
  } catch {
    failResult = null;
  }

  if (isConfirmedTerminalTransition(failResult, { jobId, swingId, expectedState: 'failed' })) {
    return { ok: true, jobId, swingId, state: 'failed', idempotent: false };
  }

  return rereadAndClassify({ supabase, jobId, swingId, analysisJobRepository, busyReason: 'lease_or_state_conflict' });
}

export { processAnalysisTask };
