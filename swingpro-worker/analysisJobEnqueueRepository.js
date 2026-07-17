// Privileged database operations for job creation and Cloud Tasks enqueue
// bookkeeping on public.swing_analysis_jobs (Phase 2B2B3A). All calls to the
// create/begin/mark-queued/record-failure RPC functions live here so callers
// never build them inline. Every function returns a structured result —
// { ok: false } on any database failure — and never exposes or logs the raw
// Supabase error. Callers are responsible for safe, categorized logging.

const TASK_NAME_MAX_LENGTH = 1024;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidTaskName(value) {
  return (
    isNonEmptyString(value) &&
    value.length <= TASK_NAME_MAX_LENGTH &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isValidErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEquipmentContext(value) {
  return value === null || value === undefined || isPlainObject(value);
}

function isValidSlope(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

// RPC functions are SETOF, so a successful call may return an array (0 or 1
// rows), depending on the client's response handling. Normalizes both shapes
// to a single row or null.
function firstRowOrNull(data) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * Atomically creates a new enqueue_pending job for an owned, claimable swing,
 * or returns an existing active job unchanged, via
 * public.create_or_get_swing_analysis_job. Returns { ok: true, job: rowOrNull }
 * — job is null when the swing is missing, not owned by expectedUserId, or
 * not in a claimable state without an active job. { ok: false } indicates a
 * database failure.
 */
async function createOrGetAnalysisJob(
  supabase,
  { swingId, expectedUserId, storagePath, equipmentContext, slope }
) {
  if (
    !isNonEmptyString(swingId) ||
    !isNonEmptyString(expectedUserId) ||
    !isNonEmptyString(storagePath) ||
    !isValidEquipmentContext(equipmentContext) ||
    !isValidSlope(slope)
  ) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('create_or_get_swing_analysis_job', {
      p_swing_id: swingId,
      p_expected_user_id: expectedUserId,
      p_storage_path: storagePath,
      p_equipment_context: equipmentContext ?? null,
      p_slope: slope ?? null,
    });

    if (error) return { ok: false };
    return { ok: true, job: firstRowOrNull(data) };
  } catch {
    return { ok: false };
  }
}

/**
 * Records the start of a Cloud Tasks enqueue attempt via
 * public.begin_swing_analysis_job_enqueue. Returns { ok: true, begun:
 * boolean, job: rowOrNull } — begun is true only when this call's update
 * matched and changed a row. { ok: false } indicates a database failure.
 */
async function beginAnalysisJobEnqueue(supabase, { jobId, swingId, taskName }) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId) || !isValidTaskName(taskName)) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('begin_swing_analysis_job_enqueue', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_task_name: taskName,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, begun: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

/**
 * Marks a job queued once Cloud Tasks has confirmed task creation or
 * reported ALREADY_EXISTS, via public.mark_swing_analysis_job_queued.
 * Returns { ok: true, changed: boolean, job: rowOrNull }; { ok: false } on
 * database failure.
 */
async function markAnalysisJobQueued(supabase, { jobId, swingId, taskName }) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId) || !isValidTaskName(taskName)) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('mark_swing_analysis_job_queued', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_task_name: taskName,
    });

    if (error) return { ok: false };
    const job = firstRowOrNull(data);
    return { ok: true, changed: Boolean(job), job };
  } catch {
    return { ok: false };
  }
}

/**
 * Records a failed Cloud Tasks enqueue attempt with a sanitized machine
 * error_code, leaving the job in enqueue_pending for retry, via
 * public.record_swing_analysis_job_enqueue_failure. Returns { ok: true,
 * changed: boolean, job: rowOrNull }; { ok: false } on database failure.
 */
async function recordAnalysisJobEnqueueFailure(supabase, { jobId, swingId, taskName, errorCode }) {
  if (
    !isNonEmptyString(jobId) ||
    !isNonEmptyString(swingId) ||
    !isValidTaskName(taskName) ||
    !isValidErrorCode(errorCode)
  ) {
    return { ok: false };
  }

  try {
    const { data, error } = await supabase.rpc('record_swing_analysis_job_enqueue_failure', {
      p_job_id: jobId,
      p_swing_id: swingId,
      p_task_name: taskName,
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
  createOrGetAnalysisJob,
  beginAnalysisJobEnqueue,
  markAnalysisJobQueued,
  recordAnalysisJobEnqueueFailure,
};
