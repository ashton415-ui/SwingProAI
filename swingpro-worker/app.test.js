import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from './app.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const SWING_ID = '33333333-3333-3333-3333-333333333333';

const AUTH_HEADERS = { Authorization: 'Bearer good-token', 'Content-Type': 'application/json' };
const GOOD_USER_RESULT = { data: { user: { id: USER_ID } }, error: null };
const DEFAULT_BODY = JSON.stringify({ storagePath: `${USER_ID}/swing.mp4` });

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

function postAnalyze(socketPath, { headers = AUTH_HEADERS, body = DEFAULT_BODY, swingId = SWING_ID } = {}) {
  return request(socketPath, { path: `/v1/swings/${swingId}/analyze`, headers, body });
}

// Full recording stub of the raw Supabase chain shapes the *real*
// swingRepository module builds: select().eq().maybeSingle() for lookups,
// and update().eq().eq().eq().select().maybeSingle() for the three guarded
// writes (claim -> PROCESSING, finalize -> COMPLETE, fail -> ERROR). Used
// only by the pre-existing end-to-end tests below that exercise the real
// (non-stubbed) swingRepository through app.js's default wiring.
function createStubSupabase({ getUserResult, swingRow, swingLookupError = null, claimError = null, errorUpdateError = null }) {
  let currentRow = swingRow ? { ...swingRow } : null;
  return {
    auth: { getUser: async () => getUserResult },
    from(_table) {
      return {
        select(_cols) {
          return {
            eq(_field, _value) {
              return {
                maybeSingle: async () => {
                  if (swingLookupError) return { data: null, error: swingLookupError };
                  return { data: currentRow, error: null };
                },
              };
            },
          };
        },
        update(payload) {
          return {
            eq(field1, value1) {
              return {
                eq(field2, value2) {
                  return {
                    eq(field3, value3) {
                      return {
                        select(_cols) {
                          return {
                            maybeSingle: async () => {
                              const isErrorUpdate = payload.status === 'ERROR';
                              const err = isErrorUpdate ? errorUpdateError : claimError;
                              if (err) return { data: null, error: err };
                              if (!currentRow) return { data: null, error: null };
                              const matches =
                                currentRow.id === value1 &&
                                currentRow.user_id === value2 &&
                                currentRow.status === value3;
                              if (!matches) return { data: null, error: null };
                              currentRow = { ...currentRow, status: payload.status };
                              return { data: { id: currentRow.id, status: currentRow.status }, error: null };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

// A stub swingRepository for tests that only need to exercise app.js's
// route logic in isolation — no real Supabase chain shapes involved. Each
// test overrides only the methods it needs.
function baseRepoStub() {
  return {
    calls: { claim: 0 },
    async getSwingState() {
      throw new Error('getSwingState not stubbed for this test');
    },
    async getSwingStateAfterClaimConflict() {
      throw new Error('getSwingStateAfterClaimConflict not stubbed for this test');
    },
    async claimSwingForAnalysis() {
      throw new Error('claimSwingForAnalysis not stubbed for this test');
    },
    async markSwingErrorIfProcessing() {
      return { ok: true, changed: false, row: null };
    },
    async completeSwingAnalysis() {
      return { ok: true, changed: false, row: null };
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

// --- Synchronous await-before-respond behavior (exercises the real,
// non-stubbed swingRepository end to end) ---

test('analysis is awaited before the success response is sent', async () => {
  let analysisCompleted = false;
  const analyzeSwing = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    analysisCompleted = true;
  };

  const supabase = createStubSupabase({
    getUserResult: GOOD_USER_RESULT,
    swingRow: { id: SWING_ID, user_id: USER_ID, status: 'pending' },
  });

  const app = createApp({ supabase, analyzeSwing });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);

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
    getUserResult: GOOD_USER_RESULT,
    swingRow: { id: SWING_ID, user_id: USER_ID, status: 'pending' },
  });

  const app = createApp({ supabase, analyzeSwing });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);

    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'analysis_failed');
    assert.equal(res.body.includes('raw Gemini secret detail'), false);
  });
});

// --- Phase 2B2A: atomic claim / idempotent lifecycle (injected repository stub) ---

test('1/2. lowercase pending is claimable: claim succeeds and analysis runs once', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async (_supabase, { swingId, userId, exactStatus }) => {
    repo.calls.claim++;
    assert.equal(swingId, SWING_ID);
    assert.equal(userId, USER_ID);
    assert.equal(exactStatus, 'pending');
    return { ok: true, claimed: true, row: { id: swingId, status: 'PROCESSING' } };
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.swingId, SWING_ID);
    assert.equal(parsed.status, 'complete');
    assert.equal(analyzeCallCount, 1);
    assert.equal(repo.calls.claim, 1);
  });
});

test('3. uppercase PENDING is claimable', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'PENDING' } });
  repo.claimSwingForAnalysis = async (_supabase, { exactStatus }) => {
    assert.equal(exactStatus, 'PENDING');
    return { ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } };
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(analyzeCallCount, 1);
  });
});

test('4. lowercase error is retryable', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'error' } });
  repo.claimSwingForAnalysis = async (_supabase, { exactStatus }) => {
    assert.equal(exactStatus, 'error');
    return { ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } };
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(analyzeCallCount, 1);
  });
});

test('5. uppercase ERROR is retryable', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'ERROR' } });
  repo.claimSwingForAnalysis = async (_supabase, { exactStatus }) => {
    assert.equal(exactStatus, 'ERROR');
    return { ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } };
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(analyzeCallCount, 1);
  });
});

test('6. processing returns 202 idempotent and analysis is not called', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'processing' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 202);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'processing');
    assert.equal(parsed.idempotent, true);
    assert.equal(analyzeCallCount, 0);
  });
});

test('7. complete returns 200 idempotent and analysis is not called', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'complete' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'complete');
    assert.equal(parsed.idempotent, true);
    assert.equal(analyzeCallCount, 0);
  });
});

test('8. initial unknown state returns 409 invalid_state (not claim_conflict)', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'some_bogus_state' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error, 'invalid_state');
    assert.equal(analyzeCallCount, 0);
  });
});

test('9. database claim error returns 500 internal_error', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: false });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'internal_error' });
  });
});

test('10. lost claim followed by processing returns 202 idempotent', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'processing' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 202);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'processing');
    assert.equal(parsed.idempotent, true);
  });
});

test('11. lost claim followed by complete returns 200 idempotent', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'complete' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'complete');
    assert.equal(parsed.idempotent, true);
  });
});

test('12. lost claim followed by missing row returns 404 not_found', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: null });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
  });
});

test('13. lost claim followed by ownership mismatch returns 403 forbidden', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { id: SWING_ID, user_id: OTHER_USER_ID, status: 'processing' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
  });
});

test('14. lost claim followed by still-pending returns 409 claim_conflict', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 409);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'claim_conflict');
  });
});

test('lost claim followed by unknown status returns 409 claim_conflict', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'some_bogus_state' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 409);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'claim_conflict');
  });
});

test('lost claim: database error during conflict reread returns 500 internal_error', async () => {
  const analyzeSwing = async () => {};

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: false, row: null });
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: false });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'internal_error' });
  });
});

test('15. concurrent duplicate requests call analyzeSwing exactly once', async () => {
  let analyzeCallCount = 0;
  const analyzeSwing = async () => { analyzeCallCount++; };

  // A real (non-forced) compare-and-set simulation: whichever request's
  // claim call executes first synchronously flips the shared state to
  // PROCESSING; the other's exactStatus comparison then fails naturally.
  // A barrier holds both requests at getSwingState until both have arrived,
  // so they reach the claim step together instead of one finishing before
  // the other even starts. No timers/sleeps anywhere — the race is decided
  // purely by promise-resolution order once the barrier releases.
  const sharedState = { id: SWING_ID, user_id: USER_ID, status: 'pending' };
  const observedStatuses = [];
  let arrivals = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });

  const repo = baseRepoStub();
  repo.getSwingState = async () => {
    arrivals++;
    if (arrivals >= 2) releaseBarrier();
    await barrier;
    observedStatuses.push(sharedState.status);
    return { ok: true, swing: { ...sharedState } };
  };
  repo.claimSwingForAnalysis = async (_supabase, { userId, exactStatus }) => {
    repo.calls.claim++;
    if (sharedState.user_id === userId && sharedState.status === exactStatus) {
      sharedState.status = 'PROCESSING';
      return { ok: true, claimed: true, row: { id: sharedState.id, status: sharedState.status } };
    }
    return { ok: true, claimed: false, row: null };
  };
  repo.getSwingStateAfterClaimConflict = async () => ({ ok: true, swing: { ...sharedState } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const [res1, res2] = await Promise.all([postAnalyze(socketPath), postAnalyze(socketPath)]);

    // Both requests observed the pre-claim 'pending' status on their
    // initial read, before either had claimed anything.
    assert.deepEqual(observedStatuses, ['pending', 'pending']);

    // Only one of the two conditional claim attempts actually flipped the
    // row, so analyzeSwing ran exactly once.
    assert.equal(repo.calls.claim, 2);
    assert.equal(analyzeCallCount, 1);

    const statuses = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
    // One request wins the claim and completes (200); the other loses the
    // claim, rereads, finds PROCESSING, and returns the idempotent 202.
    assert.deepEqual(statuses, [200, 202]);
  });
});

test('16. analysis failure marks ERROR only from PROCESSING, returns 502', async () => {
  const analyzeSwing = async () => { throw new Error('boom'); };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } });

  let errorTransitionArgs = null;
  repo.markSwingErrorIfProcessing = async (_supabase, args) => {
    errorTransitionArgs = args;
    return { ok: true, changed: true, row: { id: SWING_ID, status: 'ERROR' } };
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body).error, 'analysis_failed');
    assert.deepEqual(errorTransitionArgs, { swingId: SWING_ID, userId: USER_ID });
  });
});

test('17. failed ERROR transition still returns safe 502 without leaking details', async () => {
  const analyzeSwing = async () => { throw new Error('raw secret that must not leak'); };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } });
  repo.markSwingErrorIfProcessing = async () => ({ ok: false });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body).error, 'analysis_failed');
    assert.equal(res.body.includes('raw secret'), false);
  });
});

test('18. successful analysis receives the verified user ID', async () => {
  let receivedArgs = null;
  const analyzeSwing = async (...args) => { receivedArgs = args; };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } });

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(receivedArgs[0], SWING_ID);
    assert.equal(receivedArgs[1], `${USER_ID}/swing.mp4`);
    assert.equal(receivedArgs[4], USER_ID);
  });
});

test('19. a completed row is never changed back to ERROR (guarded by repository, verified at route level)', async () => {
  // Simulates: this request claimed and analysis failed, but by the time
  // the guarded ERROR transition runs the row has already become COMPLETE
  // (e.g. a retry path finished first) — the repository correctly reports
  // changed:false and the route must not treat that as success, but still
  // returns the safe 502 rather than fabricating a different outcome.
  const analyzeSwing = async () => { throw new Error('boom'); };

  const repo = baseRepoStub();
  repo.getSwingState = async () => ({ ok: true, swing: { id: SWING_ID, user_id: USER_ID, status: 'pending' } });
  repo.claimSwingForAnalysis = async () => ({ ok: true, claimed: true, row: { id: SWING_ID, status: 'PROCESSING' } });

  let markCalled = false;
  repo.markSwingErrorIfProcessing = async () => {
    markCalled = true;
    return { ok: true, changed: false, row: null }; // already COMPLETE elsewhere
  };

  const supabase = { auth: { getUser: async () => GOOD_USER_RESULT } };
  const app = createApp({ supabase, analyzeSwing, swingRepository: repo });

  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(markCalled, true);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body).error, 'analysis_failed');
  });
});
