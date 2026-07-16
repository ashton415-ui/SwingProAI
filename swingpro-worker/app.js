import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {
  isValidUuid,
  validateUserStoragePath,
  authenticateUser,
  validateEquipmentContext,
  sanitizeEquipmentContext,
  validateSlope,
} from './requestSecurity.js';
import { logSafe } from './safeLog.js';
import { classifySwingStatus, CLASSIFICATION } from './swingStatus.js';
import * as defaultSwingRepository from './swingRepository.js';

const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the Express app. Takes injected dependencies so it can be exercised
 * in tests with stubs — no real Supabase/Gemini calls, no network port opened
 * by the factory itself (callers decide how/whether to listen). swingRepository
 * defaults to the real privileged-DB-operations module but can be swapped for
 * a stub in tests.
 */
function createApp({ supabase, analyzeSwing, swingRepository = defaultSwingRepository }) {
  const app = express();
  app.use(cors());

  // Legacy unauthenticated endpoint — permanently disabled. Registered BEFORE
  // JSON body parsing so a malformed body can never prevent this 410 response;
  // it must ignore the request body entirely.
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

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Phase 2B2A: this endpoint still runs synchronously and awaits the full
  // analysis before responding, on purpose — it must NOT be deployed in this
  // form. Request-based compute (e.g. Cloud Run) may stop scheduling CPU once
  // a response is sent, so responding early would risk silently truncating
  // the analysis. A later queued/Cloud-Tasks-based asynchronous phase must
  // replace this before any deployment.
  app.post('/v1/swings/:swingId/analyze', async (req, res) => {
    const requestId = crypto.randomUUID();
    let swingId;

    try {
      // 1. Authenticate the Bearer token from the Authorization header —
      // never trust a client-supplied user id.
      const authHeader = req.headers['authorization'];
      const verifiedUser = await authenticateUser(supabase, authHeader);
      if (!verifiedUser) {
        logSafe('auth_failed', { requestId });
        return res.status(401).json({ error: 'invalid_token' });
      }

      // 2. Validate swingId as a UUID.
      swingId = req.params.swingId;
      if (!isValidUuid(swingId)) {
        return res.status(400).json({ error: 'validation_error' });
      }

      // 3. Validate that the request body is a JSON object.
      const body = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: 'validation_error' });
      }

      const { storagePath, equipmentContext, slope } = body;

      // 4. Validate storagePath shape (bare presence/type only — the detailed
      // unsafe-path and ownership-prefix checks run after row ownership is
      // confirmed below, so storagePath content is never trusted before that).
      if (typeof storagePath !== 'string' || storagePath.length === 0) {
        return res.status(400).json({ error: 'validation_error' });
      }

      if (!validateEquipmentContext(equipmentContext)) {
        return res.status(400).json({ error: 'validation_error' });
      }
      if (!validateSlope(slope)) {
        return res.status(400).json({ error: 'validation_error' });
      }

      // 5. Load the swing row using the server-side client (authz fields only).
      const lookupResult = await swingRepository.getSwingState(supabase, swingId);
      if (!lookupResult.ok) {
        logSafe('swing_lookup_failed', { requestId, swingId });
        return res.status(500).json({ error: 'internal_error' });
      }

      const swing = lookupResult.swing;
      if (!swing) {
        return res.status(404).json({ error: 'not_found' });
      }

      // 6. Verify row ownership.
      if (swing.user_id !== verifiedUser.id) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // 7. Full storagePath safety validation, now that ownership is confirmed.
      if (!validateUserStoragePath(storagePath, verifiedUser.id)) {
        return res.status(400).json({ error: 'validation_error' });
      }

      // Only known, validated fields reach the analysis/Gemini prompt.
      const sanitizedEquipmentContext = sanitizeEquipmentContext(equipmentContext);

      // 8. Classify the exact stored status and either short-circuit
      // idempotently or attempt the single atomic compare-and-set claim.
      const classification = classifySwingStatus(swing.status);

      if (classification === CLASSIFICATION.COMPLETE) {
        return res.status(200).json({ swingId, status: 'complete', requestId, idempotent: true });
      }

      if (classification === CLASSIFICATION.PROCESSING) {
        return res.status(202).json({ swingId, status: 'processing', requestId, idempotent: true });
      }

      if (classification !== CLASSIFICATION.CLAIMABLE) {
        // Unknown/invalid stored status on the initial read — distinct from
        // a lost-claim race, so it gets its own error code rather than
        // claim_conflict (which is reserved for the post-claim-attempt path).
        return res.status(409).json({ error: 'invalid_state', requestId });
      }

      const claimResult = await swingRepository.claimSwingForAnalysis(supabase, {
        swingId,
        userId: verifiedUser.id,
        exactStatus: swing.status,
      });

      if (!claimResult.ok) {
        logSafe('claim_failed', { requestId, swingId });
        return res.status(500).json({ error: 'internal_error' });
      }

      if (!claimResult.claimed) {
        // Lost the claim to a concurrent request. Re-read once, verify
        // ownership again, and classify — no retry loop, no sleep.
        const conflictResult = await swingRepository.getSwingStateAfterClaimConflict(supabase, swingId);
        if (!conflictResult.ok) {
          logSafe('claim_state_lookup_failed', { requestId, swingId });
          return res.status(500).json({ error: 'internal_error' });
        }

        const conflictSwing = conflictResult.swing;
        if (!conflictSwing) {
          return res.status(404).json({ error: 'not_found' });
        }
        if (conflictSwing.user_id !== verifiedUser.id) {
          return res.status(403).json({ error: 'forbidden' });
        }

        const conflictClassification = classifySwingStatus(conflictSwing.status);
        if (conflictClassification === CLASSIFICATION.PROCESSING) {
          return res.status(202).json({ swingId, status: 'processing', requestId, idempotent: true });
        }
        if (conflictClassification === CLASSIFICATION.COMPLETE) {
          return res.status(200).json({ swingId, status: 'complete', requestId, idempotent: true });
        }
        return res.status(409).json({ error: 'claim_conflict', requestId });
      }

      // 9. This request won the claim — only it may invoke analysis, awaited
      // in full before any response is sent (see design note above).
      try {
        await analyzeSwing(swingId, storagePath, sanitizedEquipmentContext, slope, verifiedUser.id);
      } catch {
        logSafe('analysis_failed', { requestId, swingId });
        const errorTransition = await swingRepository.markSwingErrorIfProcessing(supabase, {
          swingId,
          userId: verifiedUser.id,
        });
        if (!errorTransition.ok) {
          logSafe('status_update_failed', { requestId, swingId });
        }
        return res.status(502).json({ error: 'analysis_failed', requestId });
      }

      return res.status(200).json({ swingId, status: 'complete', requestId });
    } catch {
      logSafe('unexpected_error', { requestId, swingId });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    }
  });

  return app;
}

export { createApp };
