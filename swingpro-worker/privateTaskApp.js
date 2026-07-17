// Private Cloud Tasks HTTP application (Phase 2B2B3B2). Intended to run
// behind a Cloud Run service protected by Google IAM and Cloud Tasks OIDC —
// this application performs no authentication of its own and never treats
// Authorization or X-CloudTasks-* headers as caller identity. It validates
// the minimal task payload, hands it to the injected processor, and maps the
// processor's documented safe result to a response. Never calls Gemini,
// Supabase Storage, or the lease RPCs directly.
import crypto from 'node:crypto';
import express from 'express';
import { isValidUuid } from './requestSecurity.js';
import { logSafe } from './safeLog.js';
import { processAnalysisTask as defaultProcessTask } from './analysisTaskProcessor.js';

const JSON_BODY_LIMIT = '10kb';
const ALLOWED_BODY_KEYS = new Set(['jobId', 'swingId']);
const SUCCESS_STATES = new Set(['succeeded', 'failed', 'superseded', 'ignored']);

function isValidTaskBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== ALLOWED_BODY_KEYS.size) return false;
  for (const key of keys) {
    if (!ALLOWED_BODY_KEYS.has(key)) return false;
  }
  return isValidUuid(body.jobId) && isValidUuid(body.swingId);
}

function isValidSuccessResult(result, { jobId, swingId }) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.ok === true &&
    SUCCESS_STATES.has(result.state) &&
    isValidUuid(result.jobId) &&
    isValidUuid(result.swingId) &&
    result.jobId === jobId &&
    result.swingId === swingId &&
    typeof result.idempotent === 'boolean'
  );
}

/**
 * Builds the private analysis-task Express application. `analyzeSwing` must
 * be injected by the production runtime that wires this up — it is
 * intentionally not defaulted here so this module never imports the Gemini
 * analysis engine itself.
 */
function createPrivateTaskApp({ supabase, analyzeSwing, leaseSeconds, processTask = defaultProcessTask }) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'analysis-worker' });
  });

  // Assigns a request id before JSON parsing runs, so a parser failure
  // (malformed JSON, oversized body) still has a safe identifier to report.
  app.use((req, _res, next) => {
    req.requestId = crypto.randomUUID();
    next();
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use((err, req, res, next) => {
    if (!err) return next();
    const requestId = req.requestId ?? crypto.randomUUID();
    logSafe('private_task_rejected', { requestId, category: 'malformed_body' });
    return res.status(200).json({ requestId, status: 'rejected' });
  });

  app.post('/internal/tasks/analyze-swing', async (req, res) => {
    const requestId = req.requestId;

    if (!isValidTaskBody(req.body)) {
      logSafe('private_task_rejected', { requestId, category: 'invalid_body' });
      return res.status(200).json({ requestId, status: 'rejected' });
    }

    const { jobId, swingId } = req.body;

    let result;
    try {
      result = await processTask({ supabase, analyzeSwing, leaseSeconds, jobId, swingId });
    } catch {
      logSafe('private_task_unexpected_error', { requestId });
      return res.status(500).json({ error: 'task_retry_required', requestId });
    }

    if (result && result.ok === true) {
      if (!isValidSuccessResult(result, { jobId, swingId })) {
        logSafe('private_task_unexpected_error', { requestId });
        return res.status(500).json({ error: 'task_retry_required', requestId });
      }
      return res.status(200).json({
        requestId,
        jobId: result.jobId,
        swingId: result.swingId,
        status: result.state,
        idempotent: result.idempotent,
      });
    }

    logSafe('private_task_retry_required', { requestId });
    return res.status(500).json({ error: 'task_retry_required', requestId });
  });

  return app;
}

export { createPrivateTaskApp };
