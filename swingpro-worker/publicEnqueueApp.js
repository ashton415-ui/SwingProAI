import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {
  isValidUuid,
  authenticateUser,
  validateEquipmentContext,
  validateSlope,
} from './requestSecurity.js';
import { logSafe } from './safeLog.js';
import { createAndEnqueueAnalysisJob as defaultEnqueueAnalysisJob } from './analysisJobEnqueuer.js';

const JSON_BODY_LIMIT = '100kb';
const ALLOWED_BODY_KEYS = new Set(['storagePath', 'equipmentContext', 'slope']);
const SUCCESS_STATES = new Set(['queued', 'running', 'succeeded']);

const FAILURE_REASON_MAP = {
  validation_failed: { status: 400, error: 'validation_error' },
  not_eligible: { status: 409, error: 'analysis_not_eligible' },
  conflict: { status: 409, error: 'analysis_conflict' },
  enqueue_failed: { status: 503, error: 'enqueue_unavailable' },
  database_state_error: { status: 503, error: 'enqueue_reconciliation_pending' },
  database_error: { status: 500, error: 'internal_error' },
};

function isValidSuccessResult(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.ok === true &&
    SUCCESS_STATES.has(result.state) &&
    isValidUuid(result.swingId) &&
    isValidUuid(result.jobId) &&
    typeof result.idempotent === 'boolean'
  );
}

function statusForState(state) {
  return state === 'succeeded' ? 200 : 202;
}

/**
 * Builds the public, authenticated swing-analysis enqueue service (Phase
 * 2B2B3B1). This is a separate application entrypoint from the legacy
 * synchronous worker in app.js/index.js — it never analyzes a swing itself,
 * only authenticates the caller and hands validated, request-derived fields
 * to the existing durable-job orchestrator.
 */
function createPublicEnqueueApp({
  supabase,
  tasksClient,
  queueConfig,
  enqueueAnalysisJob = defaultEnqueueAnalysisJob,
}) {
  const app = express();
  app.use(cors());

  // Legacy unauthenticated endpoint — permanently disabled. Registered
  // BEFORE JSON body parsing so a malformed body can never prevent this 410
  // response. Drill verification will get its own authenticated, queued
  // design in a later phase; its absence here is intentional.
  app.post('/analyze', (_req, res) => {
    res.status(410).json({ error: 'legacy_endpoint_disabled' });
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Converts body-parser failures (malformed JSON, oversized payloads) into
  // generic, safe JSON responses — never Express's default HTML/error output.
  app.use((err, _req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    return res.status(400).json({ error: 'validation_error' });
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'analysis-enqueuer' });
  });

  app.post('/v1/swings/:swingId/analyze', async (req, res) => {
    const requestId = crypto.randomUUID();
    let swingId;

    try {
      // 1. Authenticate the Bearer token before validating or processing
      // any other protected request data — never trust a client-supplied
      // identity.
      const authHeader = req.headers['authorization'];
      let verifiedUser = null;
      try {
        verifiedUser = await authenticateUser(supabase, authHeader);
      } catch {
        verifiedUser = null;
      }

      if (!verifiedUser) {
        logSafe('public_enqueue_auth_failed', { requestId });
        return res.status(401).json({ error: 'invalid_token', requestId });
      }

      // 2. Validate swingId as a UUID.
      swingId = req.params.swingId;
      if (!isValidUuid(swingId)) {
        logSafe('public_enqueue_validation_failed', { requestId });
        return res.status(400).json({ error: 'validation_error', requestId });
      }

      // 3. Validate that the request body is a plain JSON object with only
      // the allow-listed keys — every other field (including any client
      // supplied identity, job, or lease field) is rejected outright, never
      // silently dropped.
      const body = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        logSafe('public_enqueue_validation_failed', { requestId, swingId });
        return res.status(400).json({ error: 'validation_error', requestId });
      }

      for (const key of Object.keys(body)) {
        if (!ALLOWED_BODY_KEYS.has(key)) {
          logSafe('public_enqueue_validation_failed', { requestId, swingId });
          return res.status(400).json({ error: 'validation_error', requestId });
        }
      }

      const { storagePath, equipmentContext, slope } = body;

      if (typeof storagePath !== 'string' || storagePath.length === 0) {
        logSafe('public_enqueue_validation_failed', { requestId, swingId });
        return res.status(400).json({ error: 'validation_error', requestId });
      }
      if (!validateEquipmentContext(equipmentContext)) {
        logSafe('public_enqueue_validation_failed', { requestId, swingId });
        return res.status(400).json({ error: 'validation_error', requestId });
      }
      if (!validateSlope(slope)) {
        logSafe('public_enqueue_validation_failed', { requestId, swingId });
        return res.status(400).json({ error: 'validation_error', requestId });
      }

      // 4. Hand only the request-derived fields to the orchestrator — never
      // the raw body, and never a client-supplied identity. The
      // orchestrator's own database function remains the sole ownership
      // check; this route does not duplicate it.
      let result;
      try {
        result = await enqueueAnalysisJob({
          supabase,
          tasksClient,
          queueConfig,
          swingId,
          expectedUserId: verifiedUser.id,
          storagePath,
          equipmentContext,
          slope,
        });
      } catch {
        logSafe('public_enqueue_unexpected_error', { requestId, swingId });
        return res.status(500).json({ error: 'internal_error', requestId });
      }

      if (result && result.ok === true) {
        if (!isValidSuccessResult(result)) {
          logSafe('public_enqueue_unexpected_error', { requestId, swingId });
          return res.status(500).json({ error: 'internal_error', requestId });
        }
        return res.status(statusForState(result.state)).json({
          requestId,
          swingId: result.swingId,
          jobId: result.jobId,
          status: result.state,
          idempotent: result.idempotent,
        });
      }

      if (result && result.ok === false && typeof result.reason === 'string' && FAILURE_REASON_MAP[result.reason]) {
        const mapped = FAILURE_REASON_MAP[result.reason];
        logSafe('public_enqueue_failed', { requestId, swingId });
        return res.status(mapped.status).json({ error: mapped.error, requestId });
      }

      logSafe('public_enqueue_unexpected_error', { requestId, swingId });
      return res.status(500).json({ error: 'internal_error', requestId });
    } catch {
      logSafe('public_enqueue_unexpected_error', { requestId, swingId });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'internal_error', requestId });
      }
    }
  });

  return app;
}

export { createPublicEnqueueApp };
