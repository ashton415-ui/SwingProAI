import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndEnqueueAnalysisJob } from './analysisJobEnqueuer.js';

const SWING_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const JOB_ID = '55555555-5555-5555-5555-555555555555';
const STORAGE_PATH = `${USER_ID}/swing.mp4`;

const QUEUE_CONFIG = {
  projectId: 'proj-1',
  location: 'us-central1',
  queueId: 'swing-analysis',
  handlerUrl: 'https://worker.example.com/tasks/swing-analysis',
  serviceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
  audience: 'https://worker.example.com',
};

function expectedTaskName(jobId = JOB_ID) {
  return `projects/proj-1/locations/us-central1/queues/swing-analysis/tasks/swing-analysis-${jobId}`;
}

function makeEnqueueRepositoryStub({ createResult, beginResult, markResult, failureResult } = {}) {
  const calls = { createArgs: null, beginArgs: null, markArgs: null, failureArgs: null };
  return {
    calls,
    async createOrGetAnalysisJob(supabase, args) {
      calls.createArgs = args;
      return createResult;
    },
    async beginAnalysisJobEnqueue(supabase, args) {
      calls.beginArgs = args;
      return beginResult;
    },
    async markAnalysisJobQueued(supabase, args) {
      calls.markArgs = args;
      return markResult;
    },
    async recordAnalysisJobEnqueueFailure(supabase, args) {
      calls.failureArgs = args;
      return failureResult;
    },
  };
}

function makeCloudTasksQueueStub({ buildImpl, enqueueResult } = {}) {
  const calls = { buildArgs: null, enqueueCalled: false, enqueueArgs: null };
  return {
    calls,
    buildSwingAnalysisTaskName(tasksClient, args) {
      calls.buildArgs = args;
      if (buildImpl) return buildImpl(args);
      return expectedTaskName(args.jobId);
    },
    async enqueueSwingAnalysisTask(tasksClient, args) {
      calls.enqueueCalled = true;
      calls.enqueueArgs = args;
      return enqueueResult;
    },
  };
}

function makeAnalysisJobRepositoryStub({ getResult, onGet } = {}) {
  const calls = { getArgs: null, getCallCount: 0 };
  return {
    calls,
    async getAnalysisJob(supabase, args) {
      calls.getArgs = args;
      calls.getCallCount += 1;
      if (onGet) return onGet(args);
      return getResult;
    },
  };
}

function baseInput(overrides = {}) {
  return {
    supabase: {},
    tasksClient: {},
    queueConfig: QUEUE_CONFIG,
    swingId: SWING_ID,
    expectedUserId: USER_ID,
    storagePath: STORAGE_PATH,
    equipmentContext: null,
    slope: null,
    ...overrides,
  };
}

// --- happy paths ---

test('new job: begin, Cloud Tasks create, then queued', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const queuedJob = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    markResult: { ok: true, changed: true, job: queuedJob },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: true, created: true, alreadyExists: false, taskName: expectedTaskName() },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'queued',
    idempotent: false,
    taskName: expectedTaskName(),
  });
  assert.ok(cloudTasksQueue.calls.enqueueCalled);
  assert.equal(enqueueRepository.calls.beginArgs.taskName, expectedTaskName());
  assert.equal(enqueueRepository.calls.markArgs.taskName, expectedTaskName());
});

test('new job: Cloud Tasks ALREADY_EXISTS then queued, marked idempotent', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const queuedJob = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    markResult: { ok: true, changed: true, job: queuedJob },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: true, created: false, alreadyExists: true, taskName: expectedTaskName() },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'queued',
    idempotent: true,
    taskName: expectedTaskName(),
  });
});

for (const state of ['queued', 'running', 'succeeded']) {
  test(`existing ${state} job returns idempotently with no task call`, async () => {
    const job = { id: JOB_ID, swing_id: SWING_ID, state, task_name: 'existing-task' };
    const enqueueRepository = makeEnqueueRepositoryStub({ createResult: { ok: true, job } });
    const cloudTasksQueue = makeCloudTasksQueueStub({});
    const analysisJobRepository = makeAnalysisJobRepositoryStub({});

    const result = await createAndEnqueueAnalysisJob(
      baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
    );

    assert.deepEqual(result, {
      ok: true,
      jobId: JOB_ID,
      swingId: SWING_ID,
      state,
      idempotent: true,
      taskName: 'existing-task',
    });
    assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
    assert.equal(cloudTasksQueue.calls.buildArgs, null);
    assert.equal(enqueueRepository.calls.beginArgs, null);
  });
}

test('no eligible job returns safely with no task call', async () => {
  const enqueueRepository = makeEnqueueRepositoryStub({ createResult: { ok: true, job: null } });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'not_eligible' });
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
});

// --- begin conflict / reread ---

test('begin conflict then reread finds a queued job: idempotent success, no loop', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: 'winner-task' };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'queued',
    idempotent: true,
    taskName: 'winner-task',
  });
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('begin conflict then reread finds a non-idempotent state: safe retryable conflict, no loop', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: 'other-task' };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'conflict', jobId: JOB_ID, swingId: SWING_ID });
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('no retry loop: reread is called exactly once even when it still reports enqueue_pending', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({
    getResult: { ok: true, job: { ...job, state: 'enqueue_pending' } },
  });

  await createAndEnqueueAnalysisJob(baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository }));

  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

// --- Cloud Tasks failure (RACE 2: ambiguous Cloud Tasks error vs. worker claim) ---

test('Cloud Tasks failure + failure record changed:true => enqueue_failed, no reread', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    failureResult: { ok: true, changed: true, job: { ...job, error_code: 'task_enqueue_failed' } },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: false, errorCode: 'task_create_failed' },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'enqueue_failed', jobId: JOB_ID, swingId: SWING_ID });
  assert.equal(enqueueRepository.calls.failureArgs.errorCode, 'task_enqueue_failed');
  assert.equal(enqueueRepository.calls.failureArgs.jobId, JOB_ID);
  assert.equal(enqueueRepository.calls.failureArgs.taskName, expectedTaskName());
  assert.equal(enqueueRepository.calls.markArgs, null);
  assert.equal(analysisJobRepository.calls.getCallCount, 0);
});

for (const state of ['queued', 'running', 'succeeded']) {
  test(`Cloud Tasks failure + failure record changed:false + reread ${state} => idempotent success`, async () => {
    const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
    const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state, task_name: 'winner-task' };

    const enqueueRepository = makeEnqueueRepositoryStub({
      createResult: { ok: true, job },
      beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
      failureResult: { ok: true, changed: false, job: null },
    });
    const cloudTasksQueue = makeCloudTasksQueueStub({
      enqueueResult: { ok: false, errorCode: 'task_create_failed' },
    });
    const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

    const result = await createAndEnqueueAnalysisJob(
      baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
    );

    assert.deepEqual(result, {
      ok: true,
      jobId: JOB_ID,
      swingId: SWING_ID,
      state,
      idempotent: true,
      taskName: 'winner-task',
    });
    assert.equal(analysisJobRepository.calls.getCallCount, 1);
  });
}

test('Cloud Tasks failure + failure-record DB error + reread succeeded => idempotent success', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded', task_name: 'winner-task' };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    failureResult: { ok: false },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: false, errorCode: 'task_create_failed' },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'succeeded',
    idempotent: true,
    taskName: 'winner-task',
  });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('Cloud Tasks failure + failure record changed:false + reread enqueue_pending => enqueue_failed', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    failureResult: { ok: true, changed: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: false, errorCode: 'task_create_failed' },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'enqueue_failed', jobId: JOB_ID, swingId: SWING_ID });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('Cloud Tasks failure + failure-record DB error + reread enqueue_pending => database_state_error', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    failureResult: { ok: false },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: false, errorCode: 'task_create_failed' },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'database_state_error', jobId: JOB_ID, swingId: SWING_ID });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('Cloud Tasks failure + reread failure => database_state_error, no loop', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    failureResult: { ok: true, changed: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: false, errorCode: 'task_create_failed' },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: false } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'database_state_error', jobId: JOB_ID, swingId: SWING_ID });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

// --- mark-queued race after Cloud Tasks success (RACE 1: task exists but worker claimed first) ---

for (const state of ['running', 'succeeded']) {
  test(`mark queued changed:false + reread ${state} => idempotent success`, async () => {
    const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
    const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state, task_name: expectedTaskName() };

    const enqueueRepository = makeEnqueueRepositoryStub({
      createResult: { ok: true, job },
      beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
      markResult: { ok: true, changed: false, job: null },
    });
    const cloudTasksQueue = makeCloudTasksQueueStub({
      enqueueResult: { ok: true, created: true, alreadyExists: false, taskName: expectedTaskName() },
    });
    const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

    const result = await createAndEnqueueAnalysisJob(
      baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
    );

    assert.deepEqual(result, {
      ok: true,
      jobId: JOB_ID,
      swingId: SWING_ID,
      state,
      idempotent: true,
      taskName: expectedTaskName(),
    });
    assert.equal(analysisJobRepository.calls.getCallCount, 1);
  });
}

test('mark queued database error + reread queued => idempotent success', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    markResult: { ok: false },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: true, created: true, alreadyExists: false, taskName: expectedTaskName() },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: JOB_ID,
    swingId: SWING_ID,
    state: 'queued',
    idempotent: true,
    taskName: expectedTaskName(),
  });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('mark queued changed:false + reread enqueue_pending => database_state_error, task not deleted', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const rereadJob = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: expectedTaskName() };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    markResult: { ok: true, changed: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: true, created: true, alreadyExists: false, taskName: expectedTaskName() },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: true, job: rereadJob } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'database_state_error',
    jobId: JOB_ID,
    swingId: SWING_ID,
    taskName: expectedTaskName(),
  });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

test('mark queued changed:false + reread failure => database_state_error, no loop', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };

  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: true, begun: true, job: { ...job, task_name: expectedTaskName() } },
    markResult: { ok: true, changed: false, job: null },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({
    enqueueResult: { ok: true, created: true, alreadyExists: false, taskName: expectedTaskName() },
  });
  const analysisJobRepository = makeAnalysisJobRepositoryStub({ getResult: { ok: false } });

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'database_state_error',
    jobId: JOB_ID,
    swingId: SWING_ID,
    taskName: expectedTaskName(),
  });
  assert.equal(analysisJobRepository.calls.getCallCount, 1);
});

// --- database failures ---

test('createOrGetAnalysisJob database failure returns a safe database_error result', async () => {
  const enqueueRepository = makeEnqueueRepositoryStub({ createResult: { ok: false } });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
});

test('beginAnalysisJobEnqueue database failure returns a safe database_error result', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'enqueue_pending', task_name: null };
  const enqueueRepository = makeEnqueueRepositoryStub({
    createResult: { ok: true, job },
    beginResult: { ok: false },
  });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
});

// --- validation ---

test('validation failures short-circuit with no database or Cloud Tasks calls', async () => {
  const enqueueRepository = makeEnqueueRepositoryStub({});
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const cases = [
    { swingId: 'not-a-uuid' },
    { expectedUserId: 'not-a-uuid' },
    { storagePath: 'someone-else/swing.mp4' },
    { equipmentContext: ['not', 'an', 'object'] },
    { slope: Infinity },
    { queueConfig: { ...QUEUE_CONFIG, handlerUrl: 'http://insecure.example.com' } },
    { queueConfig: { ...QUEUE_CONFIG, projectId: '' } },
  ];

  for (const overrides of cases) {
    const result = await createAndEnqueueAnalysisJob(
      baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository, ...overrides })
    );
    assert.deepEqual(result, { ok: false, reason: 'validation_failed' });
  }

  assert.equal(enqueueRepository.calls.createArgs, null);
  assert.equal(cloudTasksQueue.calls.enqueueCalled, false);
});

// --- equipment context sanitization ---

test('sanitized equipment context, not raw unknown fields, is sent to job creation', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: 'x' };
  const enqueueRepository = makeEnqueueRepositoryStub({ createResult: { ok: true, job } });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  await createAndEnqueueAnalysisJob(
    baseInput({
      enqueueRepository,
      cloudTasksQueue,
      analysisJobRepository,
      equipmentContext: { make: 'Titleist', unknownField: 'should be stripped' },
      slope: 1.2,
    })
  );

  assert.deepEqual(enqueueRepository.calls.createArgs.equipmentContext, { make: 'Titleist' });
  assert.equal(enqueueRepository.calls.createArgs.slope, 1.2);
});

// --- result shape safety ---

test('result objects never include sensitive fields', async () => {
  const job = { id: JOB_ID, swing_id: SWING_ID, state: 'queued', task_name: 'x' };
  const enqueueRepository = makeEnqueueRepositoryStub({ createResult: { ok: true, job } });
  const cloudTasksQueue = makeCloudTasksQueueStub({});
  const analysisJobRepository = makeAnalysisJobRepositoryStub({});

  const result = await createAndEnqueueAnalysisJob(
    baseInput({ enqueueRepository, cloudTasksQueue, analysisJobRepository })
  );

  const forbiddenKeys = [
    'storagePath',
    'userId',
    'expectedUserId',
    'equipmentContext',
    'slope',
    'credentials',
    'token',
    'serviceAccountEmail',
    'error',
  ];
  for (const key of forbiddenKeys) {
    assert.equal(key in result, false, `result should not include ${key}`);
  }
});
