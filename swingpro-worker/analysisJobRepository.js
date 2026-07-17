// Privileged database operations for public.swing_analysis_jobs. All calls
// to the atomic lease RPC functions (Phase 2B2B2) live here so callers never
// build them inline. Every function returns a structured result —
// { ok: false } on any database failure — and never exposes or logs the raw
// Supabase error. Callers are responsible for safe, categorized logging.

const LEASE_SECONDS_MIN = 30;
const LEASE_SECONDS_MAX = 3600;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidLeaseSeconds(value) {
  return Number.isInteger(value) && value >= LEASE_SECONDS_MIN && value <= LEASE_SECONDS_MAX;
}

function isValidErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

// RPC functions are SETOF, so a successful call may return an array (0 or 1
// rows), depending on the client's response handling. Normalizes both shapes
// to a single row or null.
function firstRowOrNull(data) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * Reads the current state of an analysis job row, scoped to both job id and
 * swing id. Returns { ok: true, job } where job is null if no row matched,
 * or { ok: false } if the database call itself failed.
 */
async function getAnalysisJob(supabase, { jobId, swingId }) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId)) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase
      .from('swing_analysis_jobs')
      .select(
        'id, swing_id, user_id, state, task_name, storage_path, equipment_context, slope, ' +
          'enqueue_attempts, execution_attempts, lease_token, lease_expires_at, error_code, ' +
          'enqueued_at, started_at, finished_at, created_at, updated_at'
      )
      .eq('id', jobId)
      .eq('swing_id', swingId)
      .maybeSingle();

    if (error) return { ok: false };
    return { ok: true, job: data ?? null };
  } catch {
    return { ok: false };
  }
}

/**
 * Attempts to atomically claim an eligible job and issue a new lease, via
 * public.claim_swing_analysis_job. Returns { ok: true, acquired: boolean,
 * job: rowOrNull } — acquired is true only when this call's claim matched
 * and updated a row. { ok: false } indicates a database failure.
 */
async function claimAnalysisJobLease(supabase, { jobId, swingId, leaseSeconds }) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId) || !isValidLeaseSeconds(leaseSeconds)) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('claim_swing_analysis_job', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_lease_seconds: leaseSeconds,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, acquired: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

/**
 * Attempts to atomically extend an active lease held by the exact token
 * presented, via public.renew_swing_analysis_job_lease. Returns { ok: true,
 * renewed: boolean, job: rowOrNull }; { ok: false } on database failure.
 */
async function renewAnalysisJobLease(supabase, { jobId, swingId, leaseToken, leaseSeconds }) {
  if (
    !isNonEmptyString(jobId) ||
    !isNonEmptyString(swingId) ||
    !isNonEmptyString(leaseToken) ||
    !isValidLeaseSeconds(leaseSeconds)
  ) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('renew_swing_analysis_job_lease', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, renewed: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

/**
 * Attempts the guarded terminal success transition, via
 * public.succeed_swing_analysis_job. Returns { ok: true, changed: boolean,
 * job: rowOrNull }; { ok: false } on database failure.
 */
async function succeedAnalysisJob(supabase, { jobId, swingId, leaseToken }) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId) || !isNonEmptyString(leaseToken)) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('succeed_swing_analysis_job', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_lease_token: leaseToken,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, changed: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

/**
 * Attempts the guarded terminal failure transition, via
 * public.fail_swing_analysis_job. Returns { ok: true, changed: boolean,
 * job: rowOrNull }; { ok: false } on database failure.
 */
async function failAnalysisJob(supabase, { jobId, swingId, leaseToken, errorCode }) {
  if (
    !isNonEmptyString(jobId) ||
    !isNonEmptyString(swingId) ||
    !isNonEmptyString(leaseToken) ||
    !isValidErrorCode(errorCode)
  ) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('fail_swing_analysis_job', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_lease_token: leaseToken,
      p_error_code: errorCode,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, changed: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

export {
  getAnalysisJob,
  claimAnalysisJobLease,
  renewAnalysisJobLease,
  succeedAnalysisJob,
  failAnalysisJob,
};
