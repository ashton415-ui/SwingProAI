import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrivateTaskApp } from './privateTaskApp.js';
import { isValidUuid } from './requestSecurity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JOB_ID = '11111111-1111-1111-1111-111111111111';
const SWING_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_JOB_ID = '99999999-9999-9999-9999-999999999999';
const OTHER_SWING_ID = '88888888-8888-8888-8888-888888888888';

const DEFAULT_BODY = JSON.stringify({ jobId: JOB_ID, swingId: SWING_ID });

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
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postTask(socketPath, { headers = { 'Content-Type': 'application/json' }, body = DEFAULT_BODY } = {}) {
  return request(socketPath, { path: '/internal/tasks/analyze-swing', headers, body });
}

function makeProcessTaskStub({ impl, result, error } = {}) {
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
    state: 'succeeded',
    idempotent: false,
    ...overrides,
  };
}

function buildApp({ processTask, supabase = {}, analyzeSwing = async () => {}, leaseSeconds = 60 } = {}) {
  return createPrivateTaskApp({ supabase, analyzeSwing, leaseSeconds, processTask });
}

// --- health ---

test('GET /health returns exactly status and service', async () => {
  const app = buildApp({ processTask: makeProcessTaskStub({ result: successResult() }) });
  await withTestServer(app, async (socketPath) => {
    const res = await request(socketPath, { method: 'GET', path: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok', service: 'analysis-worker' });
  });
});

test('no CORS header is added to any response', async () => {
  const app = buildApp({ processTask: makeProcessTaskStub({ result: successResult() }) });
  await withTestServer(app, async (socketPath) => {
    const health = await request(socketPath, { method: 'GET', path: '/health' });
    assert.equal(health.headers['access-control-allow-origin'], undefined);
    const task = await postTask(socketPath);
    assert.equal(task.headers['access-control-allow-origin'], undefined);
  });
});

// --- valid payload reaches processor ---

test('valid payload reaches the processor with exact arguments', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const supabase = { marker: 'sb' };
  const analyzeSwing = async () => {};
  const app = createPrivateTaskApp({ supabase, analyzeSwing, leaseSeconds: 90, processTask });
  await withTestServer(app, async (socketPath) => {
    await postTask(socketPath);
    assert.equal(processTask.calls.length, 1);
    assert.deepEqual(processTask.calls[0], {
      supabase,
      analyzeSwing,
      leaseSeconds: 90,
      jobId: JOB_ID,
      swingId: SWING_ID,
    });
  });
});

// --- permanent rejection cases ---

test('unknown field is permanently rejected with 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, {
      body: JSON.stringify({ jobId: JOB_ID, swingId: SWING_ID, extra: 'nope' }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('missing field is permanently rejected with 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, { body: JSON.stringify({ jobId: JOB_ID }) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('invalid UUID is permanently rejected with 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, {
      body: JSON.stringify({ jobId: 'not-a-uuid', swingId: SWING_ID }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('null body is rejected with 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, { body: 'null' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('array body is rejected with 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, { body: JSON.stringify([JOB_ID, SWING_ID]) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body).status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('malformed JSON is rejected with a controlled 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, { body: '{ not valid json !!' });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'rejected');
    assert.equal(isValidUuid(parsed.requestId), true);
    assert.equal(processTask.calls.length, 0);
  });
});

test('oversized JSON is rejected with a controlled 200', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const oversizedBody = JSON.stringify({ jobId: JOB_ID, swingId: SWING_ID, pad: 'a'.repeat(20_000) });
    const res = await postTask(socketPath, { body: oversizedBody });
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'rejected');
    assert.equal(processTask.calls.length, 0);
  });
});

test('rejected response contains exactly requestId and status', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, { body: JSON.stringify({ jobId: JOB_ID }) });
    const parsed = JSON.parse(res.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['requestId', 'status']);
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

// --- successful processor results ---

test('successful succeeded result maps correctly', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ state: 'succeeded', idempotent: false }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, 'succeeded');
    assert.equal(parsed.idempotent, false);
  });
});

test('successful failed result maps correctly', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ state: 'failed', idempotent: false }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'failed');
  });
});

test('successful superseded result maps correctly', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ state: 'superseded', idempotent: true }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'superseded');
  });
});

test('successful ignored result maps correctly', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ state: 'ignored', idempotent: true }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'ignored');
  });
});

test('idempotent true and false are both preserved', async () => {
  for (const idempotent of [true, false]) {
    const processTask = makeProcessTaskStub({ result: successResult({ idempotent }) });
    const app = buildApp({ processTask });
    await withTestServer(app, async (socketPath) => {
      const res = await postTask(socketPath);
      assert.equal(JSON.parse(res.body).idempotent, idempotent);
    });
  }
});

test('success response contains exactly the five approved keys', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['idempotent', 'jobId', 'requestId', 'status', 'swingId'].sort()
    );
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

// --- retryable failures ---

test('documented ok:false processor result returns 500', async () => {
  const processTask = makeProcessTaskStub({ result: { ok: false, reason: 'database_error' } });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: 'task_retry_required', requestId: JSON.parse(res.body).requestId });
  });
});

test('malformed processor success result returns 500', async () => {
  const malformedResults = [
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'bogus_state', idempotent: true },
    { ok: true, jobId: 'not-a-uuid', swingId: SWING_ID, state: 'succeeded', idempotent: true },
    { ok: true, jobId: JOB_ID, swingId: 'not-a-uuid', state: 'succeeded', idempotent: true },
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: 'yes' },
    { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded' },
    { ok: true },
  ];
  for (const result of malformedResults) {
    const processTask = makeProcessTaskStub({ result });
    const app = buildApp({ processTask });
    await withTestServer(app, async (socketPath) => {
      const res = await postTask(socketPath);
      assert.equal(res.statusCode, 500, `expected 500 for ${JSON.stringify(result)}`);
      assert.equal(JSON.parse(res.body).error, 'task_retry_required');
    });
  }
});

test('processor result with a different (but valid) jobId returns 500 without leaking the mismatch', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ jobId: OTHER_JOB_ID }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 500);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'task_retry_required');
    assert.deepEqual(Object.keys(parsed).sort(), ['error', 'requestId']);
    assert.equal(res.body.includes(OTHER_JOB_ID), false);
  });
});

test('processor result with a different (but valid) swingId returns 500 without leaking the mismatch', async () => {
  const processTask = makeProcessTaskStub({ result: successResult({ swingId: OTHER_SWING_ID }) });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 500);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'task_retry_required');
    assert.deepEqual(Object.keys(parsed).sort(), ['error', 'requestId']);
    assert.equal(res.body.includes(OTHER_SWING_ID), false);
  });
});

test('processor throw returns 500 without leaking the raw error', async () => {
  const processTask = makeProcessTaskStub({ error: new Error('raw processor secret that must never leak') });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.includes('raw processor secret'), false);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'task_retry_required');
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

test('retry response contains exactly error and requestId', async () => {
  const processTask = makeProcessTaskStub({ result: { ok: false, reason: 'job_busy' } });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['error', 'requestId']);
    assert.equal(isValidUuid(parsed.requestId), true);
  });
});

test('unknown processor result returns 500', async () => {
  const unknownResults = [{}, null, undefined, 'unexpected-string-result', { ok: false }];
  for (const result of unknownResults) {
    const processTask = makeProcessTaskStub({ result });
    const app = buildApp({ processTask });
    await withTestServer(app, async (socketPath) => {
      const res = await postTask(socketPath);
      assert.equal(res.statusCode, 500, `expected 500 for ${JSON.stringify(result)}`);
      assert.equal(JSON.parse(res.body).error, 'task_retry_required');
    });
  }
});

// --- request id shape ---

test('valid request IDs returned are UUIDs across all paths', async () => {
  const cases = [
    makeProcessTaskStub({ result: successResult() }),
    makeProcessTaskStub({ result: { ok: false, reason: 'database_error' } }),
  ];
  for (const processTask of cases) {
    const app = buildApp({ processTask });
    await withTestServer(app, async (socketPath) => {
      const res = await postTask(socketPath);
      assert.equal(isValidUuid(JSON.parse(res.body).requestId), true);
    });
  }
});

// --- identity headers are never inspected ---

test('Authorization header is never inspected as identity', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer whatever-not-checked' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(processTask.calls.length, 1);
    assert.equal('authorization' in processTask.calls[0], false);
  });
});

test('X-CloudTasks headers are never used as identity', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    const res = await postTask(socketPath, {
      headers: {
        'Content-Type': 'application/json',
        'X-CloudTasks-TaskName': 'projects/p/locations/l/queues/q/tasks/t',
        'X-CloudTasks-QueueName': 'q',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(processTask.calls.length, 1);
    const passedKeys = Object.keys(processTask.calls[0]);
    assert.equal(passedKeys.some((k) => k.toLowerCase().includes('cloudtasks')), false);
  });
});

// --- raw body never passed to processTask ---

test('raw request body is never passed to processTask, only jobId and swingId', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  await withTestServer(app, async (socketPath) => {
    await postTask(socketPath);
    const args = processTask.calls[0];
    const allowedKeys = new Set(['supabase', 'analyzeSwing', 'leaseSeconds', 'jobId', 'swingId']);
    for (const key of Object.keys(args)) {
      assert.ok(allowedKeys.has(key), `unexpected key passed to processTask: ${key}`);
    }
  });
});

// --- static verification: forbidden operations never appear in this module ---

test('module never calls analyzeSwing itself, Gemini, Storage, or listen()', () => {
  const source = fs.readFileSync(path.join(__dirname, 'privateTaskApp.js'), 'utf8');
  const forbiddenTokens = [
    'analyzeSwing(',
    'GoogleGenerativeAI',
    'GoogleAIFileManager',
    'generateContent',
    '.storage.from(',
    '.listen(',
    "from './index.js'",
    'from "./index.js"',
    "from './app.js'",
    'from "./app.js"',
    'publicEnqueueApp',
    'cors',
  ];
  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `privateTaskApp.js must not reference "${token}"`);
  }
});

test('factory never calls listen()', async () => {
  const processTask = makeProcessTaskStub({ result: successResult() });
  const app = buildApp({ processTask });
  assert.equal(typeof app.listen, 'function');
  // The app object itself always exposes .listen (inherited from Express) —
  // what matters is that createPrivateTaskApp never invokes it internally,
  // verified statically above. This just confirms the returned value is a
  // usable Express app that the caller (not this factory) may listen() on.
});
