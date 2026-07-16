import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './app.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SWING_ID = '33333333-3333-3333-3333-333333333333';

// Uses a Windows named pipe / Unix domain socket rather than a TCP port —
// no network port (public or loopback) is ever opened by these tests.
function makeSocketPath() {
  const token = crypto.randomBytes(6).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\swingpro-worker-test-${process.pid}-${token}`;
  }
  return path.join(os.tmpdir(), `swingpro-worker-test-${process.pid}-${token}.sock`);
}

async function withTestServer(app, fn) {
  const socketPath = makeSocketPath();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await fn(socketPath);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function request(socketPath, { method = 'POST', path: reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function createStubSupabase({ getUserResult, swingRow, swingLookupError = null, updateError = null }) {
  return {
    auth: {
      getUser: async () => getUserResult,
    },
    from(_table) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: swingRow, error: swingLookupError }),
              };
            },
          };
        },
        update(_payload) {
          return {
            eq: async () => ({ error: updateError }),
          };
        },
      };
    },
  };
}

// --- Legacy endpoint ---

test('legacy /analyze returns 410 with malformed JSON', async () => {
  const app = createApp({ supabase: {}, analyzeSwing: async () => {} });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: '/analyze',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json',
    });
    assert.equal(res.statusCode, 410);
    assert.deepEqual(JSON.parse(res.body), { error: 'legacy_endpoint_disabled' });
  });
});

test('legacy /analyze returns 410 and ignores a well-formed body too', async () => {
  const app = createApp({ supabase: {}, analyzeSwing: async () => {} });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: '/analyze',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swingId: SWING_ID, userId: USER_ID, storagePath: `${USER_ID}/x.mp4` }),
    });
    assert.equal(res.statusCode, 410);
    assert.deepEqual(JSON.parse(res.body), { error: 'legacy_endpoint_disabled' });
  });
});

// --- Controlled JSON parsing ---

test('malformed JSON returns controlled 400 validation_error', async () => {
  const app = createApp({ supabase: {}, analyzeSwing: async () => {} });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: `/v1/swings/${SWING_ID}/analyze`,
      headers: { Authorization: 'Bearer irrelevant', 'Content-Type': 'application/json' },
      body: '{ not valid json !!',
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'validation_error' });
  });
});

test('oversized JSON returns controlled 413 payload_too_large', async () => {
  const app = createApp({ supabase: {}, analyzeSwing: async () => {} });
  await withTestServer(app, async (socketPath) => {
    const oversizedBody = JSON.stringify({ storagePath: `${USER_ID}/` + 'a'.repeat(200_000) });
    const res = await request(socketPath, {
      path: `/v1/swings/${SWING_ID}/analyze`,
      headers: { Authorization: 'Bearer irrelevant', 'Content-Type': 'application/json' },
      body: oversizedBody,
    });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { error: 'payload_too_large' });
  });
});

// --- Synchronous await-before-respond behavior ---

test('analysis is awaited before the success response is sent', async () => {
  let analysisCompleted = false;
  const analyzeSwing = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    analysisCompleted = true;
  };

  const supabase = createStubSupabase({
    getUserResult: { data: { user: { id: USER_ID } }, error: null },
    swingRow: { id: SWING_ID, user_id: USER_ID, status: 'pending' },
  });

  const app = createApp({ supabase, analyzeSwing });

  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: `/v1/swings/${SWING_ID}/analyze`,
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath: `${USER_ID}/swing.mp4` }),
    });

    assert.equal(analysisCompleted, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'complete');
    assert.deepEqual(JSON.parse(res.body).swingId, SWING_ID);
  });
});

test('analysis failure returns 502 analysis_failed without leaking the raw error', async () => {
  const analyzeSwing = async () => {
    throw new Error('raw Gemini secret detail that must never reach the client');
  };

  const supabase = createStubSupabase({
    getUserResult: { data: { user: { id: USER_ID } }, error: null },
    swingRow: { id: SWING_ID, user_id: USER_ID, status: 'pending' },
  });

  const app = createApp({ supabase, analyzeSwing });

  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: `/v1/swings/${SWING_ID}/analyze`,
      headers: { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath: `${USER_ID}/swing.mp4` }),
    });

    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'analysis_failed');
    assert.equal(res.body.includes('raw Gemini secret detail'), false);
  });
});
