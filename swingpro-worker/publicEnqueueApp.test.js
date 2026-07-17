import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicEnqueueApp } from './publicEnqueueApp.js';
import { isValidUuid } from './requestSecurity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SWING_ID = '33333333-3333-3333-3333-333333333333';
const JOB_ID = '55555555-5555-5555-5555-555555555555';

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

function makeSupabase(getUserImpl) {
  return { auth: { getUser: getUserImpl || (async () => GOOD_USER_RESULT) } };
}

// Stub for the injected enqueueAnalysisJob orchestrator — records every call
// so tests can assert exactly what reached it, and never performs any real
// Supabase or Cloud Tasks work.
function makeEnqueueStub({ impl, result, error } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (impl) return impl(args);
    if (error) throw error;
    return result;
  };
  fn.calls = calls;
  return fn;
}

function successResult(overrides = {}) {
  return {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'queued',
    idempotent: false,
    taskName: 'projects/proj-1/locations/us-central1/queues/swing-analysis/tasks/secret-task-name',
    ...overrides,
  };
}

function buildApp({ supabase = makeSupabase(), enqueueAnalysisJob } = {}) {
  return createPublicEnqueueApp({ supabase, tasksClient: {}, queueConfig: {}, enqueueAnalysisJob });
}

// --- health ---

test('GET /health returns 200 with only status and service', async () => {
  const app = buildApp({ enqueueAnalysisJob: makeEnqueueStub({ result: successResult() }) });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, { method: 'GET', path: '/health' });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(parsed, { status: 'ok', service: 'analysis-enqueuer' });
  });
});

// --- legacy endpoint ---

test('legacy POST /analyze returns 410', async () => {
  const app = buildApp({ enqueueAnalysisJob: makeEnqueueStub({ result: successResult() }) });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: '/analyze',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath: `${USER_ID}/x.mp4` }),
    });
    assert.equal(res.statusCode, 410);
    assert.deepEqual(JSON.parse(res.body), { error: 'legacy_endpoint_disabled' });
  });
});

test('malformed JSON sent to legacy /analyze still returns 410', async () => {
  const app = buildApp({ enqueueAnalysisJob: makeEnqueueStub({ result: successResult() }) });
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

// --- authentication ---

test('missing Authorization header returns 401 invalid_token', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, { headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.statusCode, 401);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'invalid_token');
    assert.equal(isValidUuid(parsed.requestId), true);
    assert.equal(enqueue.calls.length, 0);
  });
});

test('malformed bearer header returns 401 invalid_token', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, {
      headers: { Authorization: 'Basic not-a-bearer-token', 'Content-Type': 'application/json' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'invalid_token');
    assert.equal(enqueue.calls.length, 0);
  });
});

test('Supabase getUser error returns 401', async () => {
  const supabase = makeSupabase(async () => ({ data: null, error: { message: 'invalid JWT' } }));
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ supabase, enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'invalid_token');
    assert.equal(enqueue.calls.length, 0);
  });
});

test('Supabase getUser throw returns 401 without leaking the raw error', async () => {
  const supabase = makeSupabase(async () => { throw new Error('raw secret detail that must never leak'); });
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ supabase, enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'invalid_token');
    assert.equal(res.body.includes('raw secret detail'), false);
    assert.equal(enqueue.calls.length, 0);
  });
});

// --- path validation ---

test('invalid swing UUID returns 400 after successful authentication', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, { swingId: 'not-a-uuid' });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'validation_error');
    assert.equal(enqueue.calls.length, 0);
  });
});

// --- body validation ---

test('missing body returns 400', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, {
      path: `/v1/swings/${SWING_ID}/analyze`,
      headers: { Authorization: 'Bearer good-token' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'validation_error');
    assert.equal(enqueue.calls.length, 0);
  });
});

test('null body returns 400', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, { body: 'null' });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'validation_error');
    assert.equal(enqueue.calls.length, 0);
  });
});

test('array body returns 400', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, { body: JSON.stringify(['not', 'an', 'object']) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'validation_error');
    assert.equal(enqueue.calls.length, 0);
  });
});

test('malformed JSON on the protected route returns controlled 400', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, { body: '{ not valid json !!' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'validation_error' });
    assert.equal(enqueue.calls.length, 0);
  });
});

test('oversized JSON on the protected route returns controlled 413', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const oversizedBody = JSON.stringify({ storagePath: `${USER_ID}/` + 'a'.repeat(200_000) });
    const res = await postAnalyze(socketPath, { body: oversizedBody });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { error: 'payload_too_large' });
    assert.equal(enqueue.calls.length, 0);
  });
});

test('unknown body key returns 400', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath, {
      body: JSON.stringify({ storagePath: `${USER_ID}/swing.mp4`, notAllowed: 'nope' }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'validation_error');
    assert.equal(enqueue.calls.length, 0);
  });
});

const PROHIBITED_FIELDS = [
  'userId', 'user_id', 'expectedUserId', 'ownerId', 'owner_id',
  'jobId', 'job_id', 'taskName', 'task_name', 'state',
  'leaseToken', 'lease_token', 'requestId',
];

test('every prohibited identity/job/lease field is rejected', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    for (const field of PROHIBITED_FIELDS) {
      const body = JSON.stringify({ storagePath: `${USER_ID}/swing.mp4`, [field]: 'injected-value' });
      const res = await postAnalyze(socketPath, { body });
      assert.equal(res.statusCode, 400, `field "${field}" should have been rejected`);
      assert.equal(JSON.parse(res.body).error, 'validation_error');
    }
    assert.equal(enqueue.calls.length, 0);
  });
});

// --- field pass-through and identity ---

test('verified auth user ID is the only expectedUserId passed to the orchestrator', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    await postAnalyze(socketPath);
    assert.equal(enqueue.calls.length, 1);
    assert.equal(enqueue.calls[0].expectedUserId, USER_ID);
  });
});

test('only storagePath, equipmentContext, and slope are passed from the body', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  const body = JSON.stringify({
    storagePath: `${USER_ID}/swing.mp4`,
    equipmentContext: { make: 'Titleist' },
    slope: 2.5,
  });
  await withTestServer(app, async (socketPath) => {
    await postAnalyze(socketPath, { body });
    const args = enqueue.calls[0];
    assert.equal(args.storagePath, `${USER_ID}/swing.mp4`);
    assert.deepEqual(args.equipmentContext, { make: 'Titleist' });
    assert.equal(args.slope, 2.5);

    const allowedKeys = new Set([
      'supabase', 'tasksClient', 'queueConfig', 'swingId', 'expectedUserId',
      'storagePath', 'equipmentContext', 'slope',
    ]);
    for (const key of Object.keys(args)) {
      assert.ok(allowedKeys.has(key), `unexpected key passed to orchestrator: ${key}`);
    }
  });
});

test('requestId is not passed to the orchestrator', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    await postAnalyze(socketPath);
    assert.equal('requestId' in enqueue.calls[0], false);
  });
});

// --- success mapping ---

test('queued result returns 202', async () => {
  const enqueue = makeEnqueueStub({ result: successResult({ state: 'queued', idempotent: false }) });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 202);
    assert.equal(JSON.parse(res.body).status, 'queued');
  });
});

test('running result returns 202', async () => {
  const enqueue = makeEnqueueStub({ result: successResult({ state: 'running', idempotent: true }) });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 202);
    assert.equal(JSON.parse(res.body).status, 'running');
  });
});

test('succeeded result returns 200', async () => {
  const enqueue = makeEnqueueStub({ result: successResult({ state: 'succeeded', idempotent: true }) });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'succeeded');
  });
});

test('idempotent boolean is preserved for both true and false', async () => {
  for (const idempotent of [true, false]) {
    const enqueue = makeEnqueueStub({ result: successResult({ idempotent }) });
    const app = buildApp({ enqueueAnalysisJob: enqueue });
    await withTestServer(app, async (socketPath) => {
      const res = await postAnalyze(socketPath);
      assert.equal(JSON.parse(res.body).idempotent, idempotent);
    });
  }
});

test('malformed successful orchestrator result returns 500', async () => {
  const malformedResults = [
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'bogus_state', idempotent: true },
    { ok: true, jobId: 'not-a-uuid', swingId: SWING_ID, state: 'queued', idempotent: true },
    { ok: true, jobId: JOB_ID, swingId: 'not-a-uuid', state: 'queued', idempotent: true },
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'queued', idempotent: 'yes' },
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'queued' },
    { ok: true },
  ];

  for (const result of malformedResults) {
    const enqueue = makeEnqueueStub({ result });
    const app = buildApp({ enqueueAnalysisJob: enqueue });
    await withTestServer(app, async (socketPath) => {
      const res = await postAnalyze(socketPath);
      assert.equal(res.statusCode, 500, `expected 500 for ${JSON.stringify(result)}`);
      assert.deepEqual(JSON.parse(res.body).error, 'internal_error');
    });
  }
});

test('success response includes only the five approved fields', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['idempotent', 'jobId', 'requestId', 'status', 'swingId'].sort());
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

test('success response excludes taskName and all sensitive fields', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.body.includes('secret-task-name'), false);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.taskName, undefined);
    assert.equal(parsed.storagePath, undefined);
    assert.equal(parsed.equipmentContext, undefined);
    assert.equal(parsed.slope, undefined);
    assert.equal(parsed.userId, undefined);
  });
});

// --- failure mapping ---

const FAILURE_CASES = [
  { reason: 'validation_failed', status: 400, error: 'validation_error' },
  { reason: 'not_eligible', status: 409, error: 'analysis_not_eligible' },
  { reason: 'conflict', status: 409, error: 'analysis_conflict' },
  { reason: 'enqueue_failed', status: 503, error: 'enqueue_unavailable' },
  { reason: 'database_state_error', status: 503, error: 'enqueue_reconciliation_pending' },
  { reason: 'database_error', status: 500, error: 'internal_error' },
];

test('every documented orchestrator failure maps correctly', async () => {
  for (const { reason, status, error } of FAILURE_CASES) {
    const enqueue = makeEnqueueStub({
      result: { ok: false, reason, jobId: JOB_ID, swingId: SWING_ID, taskName: 'internal-task-name' },
    });
    const app = buildApp({ enqueueAnalysisJob: enqueue });
    await withTestServer(app, async (socketPath) => {
      const res = await postAnalyze(socketPath);
      assert.equal(res.statusCode, status, `reason ${reason}`);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error, error);
      assert.equal(isValidUuid(parsed.requestId), true);
    });
  }
});

test('failure response contains only error and requestId', async () => {
  const enqueue = makeEnqueueStub({
    result: { ok: false, reason: 'conflict', jobId: JOB_ID, swingId: SWING_ID, taskName: 'internal-task-name' },
  });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['error', 'requestId'].sort());
  });
});

test('failure response excludes jobId, swingId, taskName, and internal reason', async () => {
  const enqueue = makeEnqueueStub({
    result: { ok: false, reason: 'enqueue_failed', jobId: JOB_ID, swingId: SWING_ID, taskName: 'internal-task-name' },
  });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.jobId, undefined);
    assert.equal(parsed.swingId, undefined);
    assert.equal(parsed.taskName, undefined);
    assert.equal(parsed.reason, undefined);
    assert.equal(res.body.includes('internal-task-name'), false);
  });
});

test('unknown orchestrator result returns 500 internal_error', async () => {
  const unknownResults = [
    { ok: false, reason: 'some_reason_never_documented' },
    { ok: false },
    {},
    null,
    undefined,
    'unexpected-string-result',
  ];

  for (const result of unknownResults) {
    const enqueue = makeEnqueueStub({ result });
    const app = buildApp({ enqueueAnalysisJob: enqueue });
    await withTestServer(app, async (socketPath) => {
      const res = await postAnalyze(socketPath);
      assert.equal(res.statusCode, 500, `expected 500 for ${JSON.stringify(result)}`);
      assert.deepEqual(JSON.parse(res.body).error, 'internal_error');
    });
  }
});

test('thrown orchestrator exception returns controlled 500 without leaking raw error', async () => {
  const enqueue = makeEnqueueStub({ error: new Error('raw orchestrator secret that must never leak') });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(res.statusCode, 500);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'internal_error');
    assert.equal(res.body.includes('raw orchestrator secret'), false);
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

test('request IDs returned to the client are valid UUIDs', async () => {
  const enqueue = makeEnqueueStub({ result: successResult() });
  const app = buildApp({ enqueueAnalysisJob: enqueue });
  await withTestServer(app, async (socketPath) => {
    const res = await postAnalyze(socketPath);
    assert.equal(isValidUuid(JSON.parse(res.body).requestId), true);
  });
});

// --- static verification: forbidden operations never appear in the route module ---

test('no analyzeSwing, Gemini, Storage, or lease function is invoked', () => {
  const source = fs.readFileSync(path.join(__dirname, 'publicEnqueueApp.js'), 'utf8');
  const forbiddenTokens = [
    'analyzeSwing',
    'GoogleGenerativeAI',
    'GoogleAIFileManager',
    'generateContent',
    '.storage.from(',
    'claim_swing_analysis_job',
    'renew_swing_analysis_job_lease',
    'succeed_swing_analysis_job',
    'fail_swing_analysis_job',
  ];
  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `publicEnqueueApp.js must not reference "${token}"`);
  }
});

test('enqueueAnalysisJob defaults to the real createAndEnqueueAnalysisJob implementation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'publicEnqueueApp.js'), 'utf8');
  assert.match(
    source,
    /import\s*\{\s*createAndEnqueueAnalysisJob[^}]*\}\s*from\s*['"]\.\/analysisJobEnqueuer\.js['"]/
  );
});
