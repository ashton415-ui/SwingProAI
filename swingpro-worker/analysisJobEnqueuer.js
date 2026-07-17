// Enqueue orchestrator for durable swing-analysis jobs (Phase 2B2B3A). Wires
// job creation (analysisJobEnqueueRepository), the Cloud Tasks adapter
// (cloudTasksQueue), and the existing lease repository's read helper
// (analysisJobRepository) behind dependency injection so this module is
// unit-testable with stubs. Not wired into the public Express route yet —
// callers invoke createAndEnqueueAnalysisJob directly. Never logs; every
// result is one of the documented safe shapes, never a raw error or
// sensitive job field.
import {
  isValidUuid,
  validateUserStoragePath,
  validateEquipmentContext,
  sanitizeEquipmentContext,
  validateSlope,
} from './requestSecurity.js';
import * as defaultEnqueueRepository from './analysisJobEnqueueRepository.js';
import * as defaultCloudTasksQueue from './cloudTasksQueue.js';
import * as defaultAnalysisJobRepository from './analysisJobRepository.js';

// A job in any of these states already has (or had) a Cloud Tasks task
// confirmed/enqueued — createAndEnqueueAnalysisJob must never call Cloud
// Tasks again for it, just report idempotent success.
const IDEMPOTENT_STATES = new Set(['queued', 'running', 'succeeded']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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

function isValidQueueConfig(queueConfig) {
  if (typeof queueConfig !== 'object' || queueConfig === null) return false;
  const { projectId, location, queueId, handlerUrl, serviceAccountEmail, audience } = queueConfig;
  return (
    isNonEmptyString(projectId) &&
    isNonEmptyString(location) &&
    isNonEmptyString(queueId) &&
    isNonEmptyString(serviceAccountEmail) &&
    isValidHttpsUrl(handlerUrl) &&
    isValidHttpsUrl(audience)
  );
}

function idempotentSuccess(job) {
  return {
    ok: true,
    jobId: job.id,
    swingId: job.swing_id,
    state: job.state,
    idempotent: true,
    taskName: job.task_name ?? null,
  };
}

/**
 * Creates (or finds) the active analysis job for a swing and drives it
 * through a single Cloud Tasks enqueue attempt. Safe to call repeatedly for
 * the same swing/job — every branch is idempotent and there is no retry
 * loop. Returns one of:
 *   { ok: true, jobId, swingId, state, idempotent, taskName }
 *   { ok: false, reason: 'validation_failed' }
 *   { ok: false, reason: 'not_eligible' }
 *   { ok: false, reason: 'database_error' }
 *   { ok: false, reason: 'conflict', jobId, swingId }
 *   { ok: false, reason: 'enqueue_failed', jobId, swingId }
 *   { ok: false, reason: 'database_state_error', jobId, swingId, taskName }
 */
async function createAndEnqueueAnalysisJob({
  supabase,
  tasksClient,
  queueConfig,
  swingId,
  expectedUserId,
  storagePath,
  equipmentContext,
  slope,
  enqueueRepository = defaultEnqueueRepository,
  cloudTasksQueue = defaultCloudTasksQueue,
  analysisJobRepository = defaultAnalysisJobRepository,
}) {
  if (!isValidUuid(swingId) || !isValidUuid(expectedUserId)) {
    return { ok: false, reason: 'validation_failed' };
  }
  if (!validateUserStoragePath(storagePath, expectedUserId)) {
    return { ok: false, reason: 'validation_failed' };
  }
  if (!validateEquipmentContext(equipmentContext)) {
    return { ok: false, reason: 'validation_failed' };
  }
  if (!validateSlope(slope)) {
    return { ok: false, reason: 'validation_failed' };
  }
  if (!isValidQueueConfig(queueConfig)) {
    return { ok: false, reason: 'validation_failed' };
  }

  const sanitizedEquipmentContext = sanitizeEquipmentContext(equipmentContext);
  const normalizedSlope = slope === undefined ? null : slope;

  const createResult = await enqueueRepository.createOrGetAnalysisJob(supabase, {
    swingId,
    expectedUserId,
    storagePath,
    equipmentContext: sanitizedEquipmentContext,
    slope: normalizedSlope,
  });

  if (!createResult.ok) {
    return { ok: false, reason: 'database_error' };
  }

  const job = createResult.job;
  if (!job) {
    return { ok: false, reason: 'not_eligible' };
  }

  if (IDEMPOTENT_STATES.has(job.state)) {
    return idempotentSuccess(job);
  }

  if (job.state !== 'enqueue_pending') {
    return { ok: false, reason: 'conflict', jobId: job.id, swingId: job.swing_id };
  }

  let taskName;
  try {
    taskName = cloudTasksQueue.buildSwingAnalysisTaskName(tasksClient, {
      projectId: queueConfig.projectId,
      location: queueConfig.location,
      queueId: queueConfig.queueId,
      jobId: job.id,
    });
  } catch {
    return { ok: false, reason: 'database_error' };
  }

  const beginResult = await enqueueRepository.beginAnalysisJobEnqueue(supabase, {
    jobId: job.id,
    swingId,
    taskName,
  });

  if (!beginResult.ok) {
    return { ok: false, reason: 'database_error' };
  }

  if (!beginResult.begun) {
    // Lost the race (or a stale retry). Re-read once — no loop — and
    // classify: another attempt may have already finished this job.
    const reread = await analysisJobRepository.getAnalysisJob(supabase, { jobId: job.id, swingId });
    if (!reread.ok) {
      return { ok: false, reason: 'database_error' };
    }

    const rereadJob = reread.job;
    if (rereadJob && IDEMPOTENT_STATES.has(rereadJob.state)) {
      return idempotentSuccess(rereadJob);
    }
    return { ok: false, reason: 'conflict', jobId: job.id, swingId };
  }

  const enqueueResult = await cloudTasksQueue.enqueueSwingAnalysisTask(tasksClient, {
    projectId: queueConfig.projectId,
    location: queueConfig.location,
    queueId: queueConfig.queueId,
    handlerUrl: queueConfig.handlerUrl,
    serviceAccountEmail: queueConfig.serviceAccountEmail,
    audience: queueConfig.audience,
    jobId: job.id,
    swingId,
  });

  if (!enqueueResult.ok) {
    // Leaves the job in enqueue_pending (state is untouched here) so a
    // later attempt can retry — never a terminal failure at this layer.
    await enqueueRepository.recordAnalysisJobEnqueueFailure(supabase, {
      jobId: job.id,
      swingId,
      taskName,
      errorCode: 'task_enqueue_failed',
    });
    return { ok: false, reason: 'enqueue_failed', jobId: job.id, swingId };
  }

  const markResult = await enqueueRepository.markAnalysisJobQueued(supabase, {
    jobId: job.id,
    swingId,
    taskName: enqueueResult.taskName,
  });

  if (!markResult.ok || !markResult.changed || !markResult.job) {
    // Cloud Tasks already has the task (created or ALREADY_EXISTS) — never
    // delete it here. A later retry will see ALREADY_EXISTS and can finish
    // marking the row queued.
    return {
      ok: false,
      reason: 'database_state_error',
      jobId: job.id,
      swingId,
      taskName: enqueueResult.taskName,
    };
  }

  return {
    ok: true,
    jobId: markResult.job.id,
    swingId: markResult.job.swing_id,
    state: markResult.job.state,
    idempotent: enqueueResult.alreadyExists,
    taskName: markResult.job.task_name,
  };
}

export { createAndEnqueueAnalysisJob };
