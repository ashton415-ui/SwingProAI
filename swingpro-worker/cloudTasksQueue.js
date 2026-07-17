// Cloud Tasks adapter for enqueueing swing-analysis work (Phase 2B2B3A). No
// global client is constructed here — callers inject an already-constructed
// tasksClient (e.g. from @google-cloud/tasks) so this module stays
// unit-testable without any real network call. Never logs the request object
// or task payload; never exposes a raw Cloud Tasks error.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// google-gax surfaces Cloud Tasks/gRPC failures with a numeric `code`
// matching the gRPC status code — 6 is ALREADY_EXISTS. Detected by code, not
// by matching error text.
const GRPC_ALREADY_EXISTS = 6;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return true;
}

function buildTaskId(jobId) {
  return `swing-analysis-${jobId}`;
}

/**
 * Builds the deterministic full Cloud Tasks task path for a job, via
 * tasksClient.taskPath. Task ID is always `swing-analysis-<jobId>`, so
 * repeated calls for the same job/queue always produce the same name.
 * Throws a generic Error (no input values embedded) on invalid input.
 */
function buildSwingAnalysisTaskName(tasksClient, { projectId, location, queueId, jobId }) {
  if (!isNonEmptyString(projectId) || !isNonEmptyString(location) || !isNonEmptyString(queueId)) {
    throw new Error('invalid queue configuration');
  }
  if (!isValidUuid(jobId)) {
    throw new Error('invalid job id');
  }

  return tasksClient.taskPath(projectId, location, queueId, buildTaskId(jobId));
}

/**
 * Enqueues (or confirms) the swing-analysis Cloud Tasks task for a job.
 * Payload is exactly { jobId, swingId } — no other job/user data ever rides
 * along in the task body. Treats Cloud Tasks ALREADY_EXISTS as idempotent
 * success. Never throws; every path returns one of the documented result
 * shapes.
 */
async function enqueueSwingAnalysisTask(
  tasksClient,
  { projectId, location, queueId, handlerUrl, serviceAccountEmail, audience, jobId, swingId } = {}
) {
  if (
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(location) ||
    !isNonEmptyString(queueId) ||
    !isNonEmptyString(serviceAccountEmail)
  ) {
    return { ok: false, errorCode: 'task_create_failed' };
  }
  if (!isValidUuid(jobId) || !isValidUuid(swingId)) {
    return { ok: false, errorCode: 'task_create_failed' };
  }
  if (!isValidHttpsUrl(handlerUrl) || !isValidHttpsUrl(audience)) {
    return { ok: false, errorCode: 'task_create_failed' };
  }

  let taskName;
  try {
    taskName = buildSwingAnalysisTaskName(tasksClient, { projectId, location, queueId, jobId });
  } catch {
    return { ok: false, errorCode: 'task_create_failed' };
  }

  const parent = tasksClient.queuePath(projectId, location, queueId);
  const body = Buffer.from(JSON.stringify({ jobId, swingId }), 'utf8');

  const task = {
    name: taskName,
    httpRequest: {
      url: handlerUrl,
      httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      oidcToken: {
        serviceAccountEmail,
        audience,
      },
    },
  };

  try {
    const [response] = await tasksClient.createTask({ parent, task });

    const responseName = response && response.name;
    if (responseName && responseName !== taskName) {
      return { ok: false, errorCode: 'task_create_failed' };
    }

    return { ok: true, created: true, alreadyExists: false, taskName };
  } catch (err) {
    if (err && err.code === GRPC_ALREADY_EXISTS) {
      return { ok: true, created: false, alreadyExists: true, taskName };
    }
    return { ok: false, errorCode: 'task_create_failed' };
  }
}

export { buildSwingAnalysisTaskName, enqueueSwingAnalysisTask };
