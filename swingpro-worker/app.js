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

const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the Express app. Takes injected dependencies so it can be exercised
 * in tests with stubs — no real Supabase/Gemini calls, no network port opened
 * by the factory itself (callers decide how/whether to listen).
 */
function createApp({ supabase, analyzeSwing }) {
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

  // Phase 2B1 intermediate design: this endpoint runs synchronously and
  // awaits the full analysis before responding, on purpose — it must NOT be
  // deployed in this form. Request-based compute (e.g. Cloud Run) may stop
  // scheduling CPU once a response is sent, so responding early would risk
  // silently truncating the analysis. Phase 2B2 must replace this with a
  // queued/Cloud-Tasks-based asynchronous job before any deployment.
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
      const { data: swing, error: fetchError } = await supabase
        .from('swings')
        .select('id, user_id, status')
        .eq('id', swingId)
        .maybeSingle();

      if (fetchError) {
        logSafe('swing_lookup_failed', { requestId, swingId });
        return res.status(500).json({ error: 'internal_error' });
      }

      if (!swing) {
        return res.status(404).json({ error: 'not_found' });
      }

      // 6. Verify row ownership.
      if (swing.user_id !== verifiedUser.id) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // 7. Verify the swing is in an allowed initial state.
      if (typeof swing.status !== 'string' || swing.status.toLowerCase() !== 'pending') {
        return res.status(409).json({ error: 'invalid_state' });
      }

      // Full storagePath safety validation, now that ownership is confirmed.
      if (!validateUserStoragePath(storagePath, verifiedUser.id)) {
        return res.status(400).json({ error: 'validation_error' });
      }

      // Only known, validated fields reach the analysis/Gemini prompt.
      const sanitizedEquipmentContext = sanitizeEquipmentContext(equipmentContext);

      // 8. Only now invoke the existing analysis function — awaited in full
      // before any response is sent (see design note above).
      try {
        await analyzeSwing(swingId, storagePath, sanitizedEquipmentContext, slope);
      } catch {
        logSafe('analysis_failed', { requestId, swingId });
        try {
          const { error: dbError } = await supabase
            .from('swings')
            .update({ status: 'ERROR' })
            .eq('id', swingId);
          if (dbError) {
            logSafe('status_update_failed', { requestId, swingId });
          }
        } catch {
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
