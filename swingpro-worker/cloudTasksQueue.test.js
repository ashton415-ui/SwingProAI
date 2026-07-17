import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwingAnalysisTaskName, enqueueSwingAnalysisTask } from './cloudTasksQueue.js';

const PROJECT_ID = 'proj-1';
const LOCATION = 'us-central1';
const QUEUE_ID = 'swing-analysis';
const JOB_ID = '11111111-1111-1111-1111-111111111111';
const SWING_ID = '22222222-2222-2222-2222-222222222222';
const HANDLER_URL = 'https://worker.example.com/tasks/swing-analysis';
const SERVICE_ACCOUNT_EMAIL = 'tasks-invoker@proj-1.iam.gserviceaccount.com';
const AUDIENCE = 'https://worker.example.com';

function expectedTaskPath() {
  return `projects/${PROJECT_ID}/locations/${LOCATION}/queues/${QUEUE_ID}/tasks/swing-analysis-${JOB_ID}`;
}

function expectedQueuePath() {
  return `projects/${PROJECT_ID}/locations/${LOCATION}/queues/${QUEUE_ID}`;
}

// A minimal recording stub of the @google-cloud/tasks CloudTasksClient
// interface this module relies on: queuePath, taskPath, createTask. No real
// network call is ever made — every test injects this stub.
function makeFakeTasksClient({ createTaskImpl } = {}) {
  const calls = { queuePathArgs: null, taskPathArgs: null, createTaskArg: null };

  return {
    calls,
    queuePath(project, location, queue) {
      calls.queuePathArgs = [project, location, queue];
      return `projects/${project}/locations/${location}/queues/${queue}`;
    },
    taskPath(project, location, queue, task) {
      calls.taskPathArgs = [project, location, queue, task];
      return `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`;
    },
    async createTask(request) {
      calls.createTaskArg = request;
      if (createTaskImpl) return createTaskImpl(request);
      return [{ name: request.task.name }];
    },
  };
}

function validParams(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    location: LOCATION,
    queueId: QUEUE_ID,
    handlerUrl: HANDLER_URL,
    serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
    audience: AUDIENCE,
    jobId: JOB_ID,
    swingId: SWING_ID,
    ...overrides,
  };
}

// --- buildSwingAnalysisTaskName ---

test('buildSwingAnalysisTaskName uses taskPath with the deterministic swing-analysis-<jobId> task id', () => {
  const client = makeFakeTasksClient();

  const name = buildSwingAnalysisTaskName(client, {
    projectId: PROJECT_ID,
    location: LOCATION,
    queueId: QUEUE_ID,
    jobId: JOB_ID,
  });

  assert.equal(name, expectedTaskPath());
  assert.deepEqual(client.calls.taskPathArgs, [PROJECT_ID, LOCATION, QUEUE_ID, `swing-analysis-${JOB_ID}`]);
});

test('buildSwingAnalysisTaskName is deterministic across repeated calls', () => {
  const client = makeFakeTasksClient();
  const args = { projectId: PROJECT_ID, location: LOCATION, queueId: QUEUE_ID, jobId: JOB_ID };

  const first = buildSwingAnalysisTaskName(client, args);
  const second = buildSwingAnalysisTaskName(client, args);

  assert.equal(first, second);
});

test('buildSwingAnalysisTaskName throws on an invalid jobId', () => {
  const client = makeFakeTasksClient();

  assert.throws(() =>
    buildSwingAnalysisTaskName(client, {
      projectId: PROJECT_ID,
      location: LOCATION,
      queueId: QUEUE_ID,
      jobId: 'not-a-uuid',
    })
  );
});

test('buildSwingAnalysisTaskName throws on invalid queue configuration', () => {
  const client = makeFakeTasksClient();

  assert.throws(() =>
    buildSwingAnalysisTaskName(client, { projectId: '', location: LOCATION, queueId: QUEUE_ID, jobId: JOB_ID })
  );
});

// --- enqueueSwingAnalysisTask ---

test('enqueueSwingAnalysisTask uses the exact parent queue path and deterministic task path', async () => {
  const client = makeFakeTasksClient();

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.alreadyExists, false);
  assert.equal(result.taskName, expectedTaskPath());
  assert.deepEqual(client.calls.queuePathArgs, [PROJECT_ID, LOCATION, QUEUE_ID]);
  assert.equal(client.calls.createTaskArg.parent, expectedQueuePath());
  assert.equal(client.calls.createTaskArg.task.name, expectedTaskPath());
});

test('enqueueSwingAnalysisTask sends POST with Content-Type application/json', async () => {
  const client = makeFakeTasksClient();

  await enqueueSwingAnalysisTask(client, validParams());

  const { httpRequest } = client.calls.createTaskArg.task;
  assert.equal(httpRequest.httpMethod, 'POST');
  assert.equal(httpRequest.headers['Content-Type'], 'application/json');
});

test('enqueueSwingAnalysisTask sends exactly the two-field { jobId, swingId } payload', async () => {
  const client = makeFakeTasksClient();

  await enqueueSwingAnalysisTask(client, validParams());

  const { httpRequest } = client.calls.createTaskArg.task;
  const payload = JSON.parse(Buffer.from(httpRequest.body).toString('utf8'));
  assert.deepEqual(payload, { jobId: JOB_ID, swingId: SWING_ID });
  assert.deepEqual(Object.keys(payload).sort(), ['jobId', 'swingId']);
});

test('enqueueSwingAnalysisTask configures an OIDC token with serviceAccountEmail and audience, and sets no manual Authorization', async () => {
  const client = makeFakeTasksClient();

  await enqueueSwingAnalysisTask(client, validParams());

  const { httpRequest } = client.calls.createTaskArg.task;
  assert.deepEqual(httpRequest.oidcToken, {
    serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
    audience: AUDIENCE,
  });
  assert.equal(httpRequest.oauthToken, undefined);
  assert.equal(httpRequest.headers.Authorization, undefined);
});

test('enqueueSwingAnalysisTask payload excludes user, storage, equipment, slope, and token fields', async () => {
  const client = makeFakeTasksClient();

  const result = await enqueueSwingAnalysisTask(client, validParams());

  const { httpRequest } = client.calls.createTaskArg.task;
  const payload = Buffer.from(httpRequest.body).toString('utf8').toLowerCase();
  for (const forbidden of ['user_id', 'storage_path', 'equipment_context', 'slope', 'token', 'key', 'http']) {
    assert.equal(payload.includes(forbidden), false, `payload should not include ${forbidden}`);
  }
  assert.equal(result.ok, true);
});

test('enqueueSwingAnalysisTask returns created:true on successful creation', async () => {
  const client = makeFakeTasksClient();

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.deepEqual(result, {
    ok: true,
    created: true,
    alreadyExists: false,
    taskName: expectedTaskPath(),
  });
});

test('enqueueSwingAnalysisTask treats ALREADY_EXISTS (gRPC code 6) as idempotent success', async () => {
  const client = makeFakeTasksClient({
    createTaskImpl: () => {
      const err = new Error('6 ALREADY_EXISTS: Requested entity already exists');
      err.code = 6;
      throw err;
    },
  });

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.deepEqual(result, {
    ok: true,
    created: false,
    alreadyExists: true,
    taskName: expectedTaskPath(),
  });
});

test('enqueueSwingAnalysisTask detects ALREADY_EXISTS by gRPC code, not by matching error text', async () => {
  const client = makeFakeTasksClient({
    createTaskImpl: () => {
      // Deliberately does NOT mention "ALREADY_EXISTS" in the message, to
      // prove detection is code-based, not text-based.
      const err = new Error('duplicate task detected');
      err.code = 6;
      throw err;
    },
  });

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.equal(result.ok, true);
  assert.equal(result.alreadyExists, true);
});

test('enqueueSwingAnalysisTask returns a safe failure for other gRPC errors without leaking them', async () => {
  const client = makeFakeTasksClient({
    createTaskImpl: () => {
      const err = new Error('7 PERMISSION_DENIED: some secret detail');
      err.code = 7;
      throw err;
    },
  });

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.deepEqual(result, { ok: false, errorCode: 'task_create_failed' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('enqueueSwingAnalysisTask returns a safe failure when the client throws', async () => {
  const client = makeFakeTasksClient({
    createTaskImpl: () => {
      throw new Error('raw network secret');
    },
  });

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.deepEqual(result, { ok: false, errorCode: 'task_create_failed' });
});

test('enqueueSwingAnalysisTask treats a mismatched response task name as a safe failure', async () => {
  const client = makeFakeTasksClient({
    createTaskImpl: () => [{ name: 'projects/other/locations/us/queues/other/tasks/mismatch' }],
  });

  const result = await enqueueSwingAnalysisTask(client, validParams());

  assert.deepEqual(result, { ok: false, errorCode: 'task_create_failed' });
});

test('enqueueSwingAnalysisTask rejects invalid UUIDs without calling Cloud Tasks', async () => {
  const client = makeFakeTasksClient();

  const badJob = await enqueueSwingAnalysisTask(client, validParams({ jobId: 'not-a-uuid' }));
  const badSwing = await enqueueSwingAnalysisTask(client, validParams({ swingId: 'not-a-uuid' }));

  assert.equal(badJob.ok, false);
  assert.equal(badSwing.ok, false);
  assert.equal(client.calls.createTaskArg, null);
});

test('enqueueSwingAnalysisTask rejects non-HTTPS URLs without calling Cloud Tasks', async () => {
  const client = makeFakeTasksClient();

  const badHandler = await enqueueSwingAnalysisTask(
    client,
    validParams({ handlerUrl: 'http://worker.example.com/tasks' })
  );
  const badAudience = await enqueueSwingAnalysisTask(client, validParams({ audience: 'http://worker.example.com' }));

  assert.equal(badHandler.ok, false);
  assert.equal(badAudience.ok, false);
  assert.equal(client.calls.createTaskArg, null);
});

test('enqueueSwingAnalysisTask rejects URLs with embedded credentials', async () => {
  const client = makeFakeTasksClient();

  const result = await enqueueSwingAnalysisTask(
    client,
    validParams({ handlerUrl: 'https://user:pass@worker.example.com/tasks' })
  );

  assert.equal(result.ok, false);
  assert.equal(client.calls.createTaskArg, null);
});

test('enqueueSwingAnalysisTask rejects invalid queue configuration without calling Cloud Tasks', async () => {
  const client = makeFakeTasksClient();

  const missingProject = await enqueueSwingAnalysisTask(client, validParams({ projectId: '' }));
  const missingLocation = await enqueueSwingAnalysisTask(client, validParams({ location: '' }));
  const missingQueueId = await enqueueSwingAnalysisTask(client, validParams({ queueId: '' }));
  const missingServiceAccount = await enqueueSwingAnalysisTask(client, validParams({ serviceAccountEmail: '' }));

  for (const result of [missingProject, missingLocation, missingQueueId, missingServiceAccount]) {
    assert.equal(result.ok, false);
  }
  assert.equal(client.calls.createTaskArg, null);
});

test('enqueueSwingAnalysisTask only ever calls the injected stub client, never a real network client', async () => {
  const client = makeFakeTasksClient();

  await enqueueSwingAnalysisTask(client, validParams());

  assert.ok(client.calls.createTaskArg, 'expected the injected stub to record a call');
});
