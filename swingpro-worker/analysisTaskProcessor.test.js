import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { processAnalysisTask } from './analysisTaskProcessor.js';

const JOB_ID = '11111111-1111-1111-1111-111111111111';
const SWING_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const LEASE_TOKEN = 'lease-token-abc';
const LEASE_SECONDS = 60;

function validClaimedJob(overrides = {}) {
  return {
    id: JOB_ID,
    swing_id: SWING_ID,
    user_id: USER_ID,
    state: 'running',
    lease_token: LEASE_TOKEN,
    storage_path: `${USER_ID}/swing.mp4`,
    equipment_context: { make: 'Titleist' },
    slope: 2.5,
    ...overrides,
  };
}

function makeRepository({
  claimImpl,
  getImpl,
  succeedImpl,
  completeImpl,
  failImpl,
  renewImpl,
} = {}) {
  const calls = { claim: [], get: [], succeed: [], complete: [], fail: [], renew: [] };
  return {
    calls,
    async claimAnalysisJobLease(supabase, args) {
      calls.claim.push(args);
      return claimImpl ? claimImpl(args) : { ok: true, acquired: false, job: null };
    },
    async getAnalysisJob(supabase, args) {
      calls.get.push(args);
      return getImpl ? getImpl(args) : { ok: true, job: null };
    },
    async succeedAnalysisJob(supabase, args) {
      calls.succeed.push(args);
      return succeedImpl ? succeedImpl(args) : { ok: true, changed: false, job: null };
    },
    async completeAnalysisJob(supabase, args) {
      calls.complete.push(args);
      return completeImpl ? completeImpl(args) : { ok: true, changed: false, job: null };
    },
    async failAnalysisJob(supabase, args) {
      calls.fail.push(args);
      return failImpl ? failImpl(args) : { ok: true, changed: false, job: null };
    },
    async renewAnalysisJobLease(supabase, args) {
      calls.renew.push(args);
      return renewImpl ? renewImpl(args) : { ok: true, renewed: true };
    },
  };
}

// A no-op heartbeat stub for tests that don't care about lease-loss behavior.
function makeHeartbeatStub({ hasLostLease = false, signal } = {}) {
  const calls = [];
  const stopCalls = [];
  const fn = (args) => {
    calls.push(args);
    return {
      signal: signal ?? new AbortController().signal,
      hasLostLease: () => hasLostLease,
      stop: async () => {
        stopCalls.push(true);
      },
    };
  };
  fn.calls = calls;
  fn.stopCalls = stopCalls;
  return fn;
}

function baseArgs(overrides = {}) {
  return {
    supabase: {},
    jobId: JOB_ID,
    swingId: SWING_ID,
    leaseSeconds: LEASE_SECONDS,
    analyzeSwing: async () => ({ coaching_assessment: { score: 80 } }),
    startLeaseHeartbeat: makeHeartbeatStub(),
    ...overrides,
  };
}

// --- input validation ---

test('invalid jobId short-circuits with no calls', async () => {
  const repository = makeRepository();
  const result = await processAnalysisTask(
    baseArgs({ jobId: 'not-a-uuid', analysisJobRepository: repository })
  );
  assert.deepEqual(result, { ok: false, reason: 'validation_failed' });
  assert.equal(repository.calls.claim.length, 0);
});

test('invalid swingId short-circuits with no calls', async () => {
  const repository = makeRepository();
  const result = await processAnalysisTask(
    baseArgs({ swingId: 'not-a-uuid', analysisJobRepository: repository })
  );
  assert.deepEqual(result, { ok: false, reason: 'validation_failed' });
  assert.equal(repository.calls.claim.length, 0);
});

test('invalid leaseSeconds short-circuits with no calls', async () => {
  const repository = makeRepository();
  for (const leaseSeconds of [29, 3601, 60.5, 'sixty', null]) {
    const result = await processAnalysisTask(
      baseArgs({ leaseSeconds, analysisJobRepository: repository })
    );
    assert.deepEqual(result, { ok: false, reason: 'validation_failed' });
  }
  assert.equal(repository.calls.claim.length, 0);
});

test('non-function analyzeSwing short-circuits with no calls', async () => {
  const repository = makeRepository();
  const result = await processAnalysisTask(
    baseArgs({ analyzeSwing: 'not-a-function', analysisJobRepository: repository })
  );
  assert.deepEqual(result, { ok: false, reason: 'validation_failed' });
  assert.equal(repository.calls.claim.length, 0);
});

// --- claim failure ---

test('claim database failure returns database_error', async () => {
  const repository = makeRepository({ claimImpl: () => ({ ok: false }) });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
});

test('claim throw returns database_error', async () => {
  const repository = makeRepository({
    claimImpl: () => {
      throw new Error('raw db secret');
    },
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
});

// --- claim lost, reread classification ---

test('missing job after lost claim returns ignored/idempotent', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: null }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'ignored', idempotent: true });
});

test('existing succeeded job after lost claim reports succeeded/idempotent', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
});

test('existing failed job after lost claim reports failed/idempotent', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
});

test('existing superseded job after lost claim reports superseded/idempotent', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'superseded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'superseded', idempotent: true });
});

test('active running job after lost claim returns job_busy', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'running' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'job_busy' });
});

test('queued job after lost claim returns job_busy', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'queued' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'job_busy' });
});

test('unknown state after lost claim returns invalid_state', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'bogus_state' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'invalid_state' });
});

test('database reread failure after lost claim returns database_error', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: false }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
});

test('never loops: getAnalysisJob called exactly once after lost claim', async () => {
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'running' } }),
  });
  await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.equal(repository.calls.get.length, 1);
});

// --- malformed claimed row ---

test('malformed claimed row returns invalid_job and never calls analyzeSwing', async () => {
  const malformedRows = [
    null,
    'not-an-object',
    validClaimedJob({ id: 'other-id' }),
    validClaimedJob({ swing_id: 'other-swing' }),
    validClaimedJob({ state: 'queued' }),
    validClaimedJob({ lease_token: '' }),
    validClaimedJob({ user_id: '' }),
    validClaimedJob({ storage_path: '' }),
    validClaimedJob({ equipment_context: 'not-an-object' }),
    validClaimedJob({ equipment_context: ['array'] }),
    validClaimedJob({ slope: 'not-a-number' }),
    validClaimedJob({ slope: NaN }),
  ];

  for (const job of malformedRows) {
    let analyzerCalled = false;
    const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
    const result = await processAnalysisTask(
      baseArgs({
        analysisJobRepository: repository,
        analyzeSwing: async () => {
          analyzerCalled = true;
        },
      })
    );
    assert.deepEqual(result, { ok: false, reason: 'invalid_job' }, `job=${JSON.stringify(job)}`);
    assert.equal(analyzerCalled, false);
  }
});

test('a claimed row with null equipment_context and null slope is valid', async () => {
  const job = validClaimedJob({ equipment_context: null, slope: null });
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.equal(result.ok, true);
  assert.equal(result.state, 'succeeded');
});

// --- claimed job data reaches analyzeSwing, not task input ---

test('analyzeSwing receives claimed job data, not task input', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });

  let analyzerArgs;
  const result = await processAnalysisTask(
    baseArgs({
      jobId: JOB_ID,
      swingId: SWING_ID,
      analysisJobRepository: repository,
      analyzeSwing: async (args) => {
        analyzerArgs = args;
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(analyzerArgs.swingId, SWING_ID);
  assert.equal(analyzerArgs.storagePath, job.storage_path);
  assert.deepEqual(analyzerArgs.equipmentContext, job.equipment_context);
  assert.equal(analyzerArgs.slope, job.slope);
  assert.equal(analyzerArgs.userId, job.user_id);
  assert.ok('signal' in analyzerArgs);
  assert.equal(Object.keys(analyzerArgs).sort().join(','), 'equipmentContext,signal,slope,storagePath,swingId,userId');
});

test('analyzeSwing receives an AbortSignal from the heartbeat', async () => {
  const job = validClaimedJob();
  const controller = new AbortController();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });

  let receivedSignal;
  await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: makeHeartbeatStub({ signal: controller.signal }),
      analyzeSwing: async ({ signal }) => {
        receivedSignal = signal;
      },
    })
  );

  assert.equal(receivedSignal, controller.signal);
});

test('heartbeat is started with the claimed lease token, not any client input', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  const heartbeatStub = makeHeartbeatStub();

  await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, startLeaseHeartbeat: heartbeatStub })
  );

  assert.equal(heartbeatStub.calls.length, 1);
  assert.equal(heartbeatStub.calls[0].leaseToken, LEASE_TOKEN);
  assert.equal(heartbeatStub.calls[0].jobId, JOB_ID);
  assert.equal(heartbeatStub.calls[0].swingId, SWING_ID);
  assert.equal(heartbeatStub.calls[0].leaseSeconds, LEASE_SECONDS);
});

// --- analyzer success / telemetry completion ---

test('analyzer success followed by successful complete transition', async () => {
  const job = validClaimedJob();
  const telemetryData = { coaching_assessment: { score: 80 } };
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: (args) => {
      assert.deepEqual(args, { jobId: JOB_ID, swingId: SWING_ID, leaseToken: LEASE_TOKEN, telemetryData });
      return { ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } };
    },
  });
  const result = await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => telemetryData })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: false });
  assert.equal(repository.calls.complete.length, 1);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.get.length, 0);
});

test('analyzer telemetry is passed to completeAnalysisJob unchanged, including nested objects and arrays', async () => {
  const job = validClaimedJob();
  const telemetryData = { coaching_assessment: { score: 80, tags: ['slice', 'over-the-top'] }, frames: [1, 2, 3] };
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => telemetryData })
  );
  assert.equal(repository.calls.complete.length, 1);
  assert.equal(repository.calls.complete[0].telemetryData, telemetryData);
});

test('an empty top-level telemetry object is accepted', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => ({}) })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: false });
  assert.equal(repository.calls.complete.length, 1);
  assert.deepEqual(repository.calls.complete[0].telemetryData, {});
});

test('processor success result never contains telemetry data', async () => {
  const job = validClaimedJob();
  const telemetryData = { coaching_assessment: { score: 80 }, secret: 'do-not-leak' };
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => telemetryData })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: false });
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
  assert.equal('telemetryData' in result, false);
});

test('analyzer success but heartbeat reports lease loss skips complete and rereads', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: makeHeartbeatStub({ hasLostLease: true }),
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(repository.calls.get.length, 1);
});

test('analyzer success but complete transition changed:false rereads and reports succeeded', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(repository.calls.get.length, 1);
});

test('analyzer success but complete transition ok:false rereads and reports job_busy conflict for running', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: false }),
    getImpl: () => ({ ok: true, job: { state: 'running' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: false, reason: 'lease_or_state_conflict' });
  assert.equal(repository.calls.get.length, 1);
});

test('analyzer success but complete transition throws rereads', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => {
      throw new Error('raw db secret');
    },
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
});

test('complete transition changed:true with a malformed job rereads instead of trusting it', async () => {
  const job = validClaimedJob();
  const malformedJobs = [
    {},
    { id: 'wrong-id', swing_id: SWING_ID, state: 'succeeded' },
    { id: JOB_ID, swing_id: 'wrong-swing', state: 'succeeded' },
    { id: JOB_ID, swing_id: SWING_ID, state: 'running' },
  ];

  for (const malformedJob of malformedJobs) {
    const repository = makeRepository({
      claimImpl: () => ({ ok: true, acquired: true, job }),
      completeImpl: () => ({ ok: true, changed: true, job: malformedJob }),
      getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
    });
    const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
    assert.deepEqual(
      result,
      { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true },
      `job=${JSON.stringify(malformedJob)}`
    );
    assert.equal(repository.calls.get.length, 1, `job=${JSON.stringify(malformedJob)}`);
  }
});

test('wrong job ID in a changed:true complete result rereads instead of trusting it', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({
      ok: true,
      changed: true,
      job: { id: 'other-job-id', swing_id: SWING_ID, state: 'succeeded' },
    }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(repository.calls.get.length, 1);
});

test('wrong swing ID in a changed:true complete result rereads instead of trusting it', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({
      ok: true,
      changed: true,
      job: { id: JOB_ID, swing_id: 'other-swing-id', state: 'succeeded' },
    }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(repository.calls.get.length, 1);
});

test('wrong terminal state in a changed:true complete result rereads instead of trusting it', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({
      ok: true,
      changed: true,
      job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' },
    }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(repository.calls.get.length, 1);
});

test('getAnalysisJob is called no more than once per completion reconciliation', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: false }),
    getImpl: () => ({ ok: true, job: { state: 'running' } }),
  });
  await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.equal(repository.calls.get.length, 1);
});

// --- hostile completeAnalysisJob results are contained, never trusted ---

function makeRevocable(target) {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

const HOSTILE_COMPLETE_RESULTS = [
  [
    'ok getter throws',
    () => ({
      get ok() {
        throw new Error('raw ok getter secret that must never leak');
      },
      changed: true,
      job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' },
    }),
  ],
  [
    'job getter throws',
    () => ({
      ok: true,
      changed: true,
      get job() {
        throw new Error('raw job getter secret that must never leak');
      },
    }),
  ],
  [
    'nested job.id getter throws',
    () => ({
      ok: true,
      changed: true,
      job: {
        get id() {
          throw new Error('raw job.id getter secret that must never leak');
        },
        swing_id: SWING_ID,
        state: 'succeeded',
      },
    }),
  ],
  ['revoked Proxy as the outer result', () => makeRevocable({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } })],
  [
    'revoked Proxy as result.job',
    () => ({
      ok: true,
      changed: true,
      job: makeRevocable({ id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' }),
    }),
  ],
];

for (const [label, buildHostileResult] of HOSTILE_COMPLETE_RESULTS) {
  test(`hostile completeAnalysisJob result (${label}) is contained and rereads instead of trusting it`, async () => {
    const job = validClaimedJob();
    const repository = makeRepository({
      claimImpl: () => ({ ok: true, acquired: true, job }),
      completeImpl: () => buildHostileResult(),
      getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
    });
    const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
    assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
    assert.equal(repository.calls.get.length, 1);
    assert.equal(repository.calls.succeed.length, 0);
    assert.equal(repository.calls.fail.length, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('revoked'), false);
  });
}

// A hostile result.job getter that returns a different object on each
// access could let a naive multi-read implementation combine an id from one
// object, a swing_id from another, and a state from a third into a falsely
// confirmed transition — none of which individually is a real matching job
// row. Reading result.job into a local exactly once closes that gap.
test('a changing result.job getter on completeAnalysisJob is read exactly once and never falsely confirmed', async () => {
  const job = validClaimedJob();
  const jobGetterSequence = [{}, { id: JOB_ID }, { swing_id: SWING_ID }, { state: 'succeeded' }];
  let jobGetterAccessCount = 0;
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({
      ok: true,
      changed: true,
      get job() {
        const value = jobGetterSequence[jobGetterAccessCount] ?? jobGetterSequence[jobGetterSequence.length - 1];
        jobGetterAccessCount += 1;
        return value;
      },
    }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(jobGetterAccessCount, 1);
  assert.equal(repository.calls.get.length, 1);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(JSON.stringify(result).includes(JOB_ID), true);
  assert.equal(JSON.stringify(result).includes(SWING_ID), true);
});

// --- invalid analyzer telemetry ---

test('invalid analyzer telemetry results in a failed transition with invalid_analysis_result, never complete or succeed', async () => {
  const invalidResults = [undefined, null, [], 'not-an-object', 42, true, false, () => {}];

  for (const invalidResult of invalidResults) {
    const job = validClaimedJob();
    const repository = makeRepository({
      claimImpl: () => ({ ok: true, acquired: true, job }),
      failImpl: (args) => {
        assert.deepEqual(args, {
          jobId: JOB_ID,
          swingId: SWING_ID,
          leaseToken: LEASE_TOKEN,
          errorCode: 'invalid_analysis_result',
        });
        return { ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' } };
      },
    });
    const result = await processAnalysisTask(
      baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => invalidResult })
    );
    assert.deepEqual(
      result,
      { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: false },
      `invalidResult=${JSON.stringify(invalidResult)}`
    );
    assert.equal(repository.calls.complete.length, 0);
    assert.equal(repository.calls.succeed.length, 0);
    assert.equal(repository.calls.fail.length, 1);
    assert.equal(JSON.stringify(result).includes('not-an-object'), false);
  }
});

// A revoked Proxy can never be observed as a *fulfilled* awaited value: the
// engine's own thenable check (`Get(value, "then")`, performed by every
// `await`/promise-resolution step, independent of whether analyzeSwing is
// sync or async) throws on any property access against a revoked Proxy, so
// `await analyzeSwing(...)` itself always rejects first. That means this
// hostile value is necessarily caught by the pre-existing analyzer-throw
// branch (errorCode 'analysis_failed'), not by the isPlainObject telemetry
// check (which never sees it) — but containment holds either way: the
// processor never throws, never leaks proxy error text, and never calls
// completeAnalysisJob or succeedAnalysisJob.
test('a revoked Proxy returned by analyzeSwing is safely contained as an analyzer failure', async () => {
  const job = validClaimedJob();
  const revokedProxy = makeRevocable({ coaching_assessment: { score: 80 } });
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: (args) => {
      assert.deepEqual(args, {
        jobId: JOB_ID,
        swingId: SWING_ID,
        leaseToken: LEASE_TOKEN,
        errorCode: 'analysis_failed',
      });
      return { ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' } };
    },
  });
  const result = await processAnalysisTask(
    baseArgs({ analysisJobRepository: repository, analyzeSwing: async () => revokedProxy })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: false });
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 1);
  assert.equal(JSON.stringify(result).includes('revoked'), false);
});

// --- analyzer failure ---

test('analyzer throw followed by successful fail transition', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: (args) => {
      assert.deepEqual(args, {
        jobId: JOB_ID,
        swingId: SWING_ID,
        leaseToken: LEASE_TOKEN,
        errorCode: 'analysis_failed',
      });
      return { ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' } };
    },
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('raw analyzer secret that must never leak');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: false });
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 1);
  assert.equal(repository.calls.fail[0].errorCode, 'analysis_failed');
});

test('analyzer throw never leaks the raw error in the result', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('super-secret-analyzer-detail');
      },
    })
  );
  assert.equal(JSON.stringify(result).includes('super-secret-analyzer-detail'), false);
});

test('analyzer throw after lease loss does not call failAnalysisJob, completeAnalysisJob, or succeedAnalysisJob', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: makeHeartbeatStub({ hasLostLease: true }),
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.get.length, 1);
});

test('invalid analyzer telemetry plus lease loss does not call failAnalysisJob, completeAnalysisJob, or succeedAnalysisJob', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: makeHeartbeatStub({ hasLostLease: true }),
      analyzeSwing: async () => 'not-an-object',
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.get.length, 1);
});

test('fail transition changed:false rereads and reports failed', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: () => ({ ok: true, changed: false, job: null }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
});

test('fail transition database error rereads and reports lease_or_state_conflict for running', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: () => ({ ok: false }),
    getImpl: () => ({ ok: true, job: { state: 'running' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: false, reason: 'lease_or_state_conflict' });
});

test('fail transition throws rereads and reports failed', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: () => {
      throw new Error('raw db secret');
    },
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
});

// --- hostile failAnalysisJob results are contained, never trusted ---

const HOSTILE_FAIL_RESULTS = [
  [
    'ok getter throws',
    () => ({
      get ok() {
        throw new Error('raw ok getter secret that must never leak');
      },
      changed: true,
      job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' },
    }),
  ],
  [
    'job getter throws',
    () => ({
      ok: true,
      changed: true,
      get job() {
        throw new Error('raw job getter secret that must never leak');
      },
    }),
  ],
  [
    'nested job.state getter throws',
    () => ({
      ok: true,
      changed: true,
      job: {
        id: JOB_ID,
        swing_id: SWING_ID,
        get state() {
          throw new Error('raw job.state getter secret that must never leak');
        },
      },
    }),
  ],
  ['revoked Proxy as the outer result', () => makeRevocable({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'failed' } })],
  [
    'revoked Proxy as result.job',
    () => ({
      ok: true,
      changed: true,
      job: makeRevocable({ id: JOB_ID, swing_id: SWING_ID, state: 'failed' }),
    }),
  ],
];

for (const [label, buildHostileResult] of HOSTILE_FAIL_RESULTS) {
  test(`hostile failAnalysisJob result (${label}) is contained and rereads instead of trusting it`, async () => {
    const job = validClaimedJob();
    const repository = makeRepository({
      claimImpl: () => ({ ok: true, acquired: true, job }),
      failImpl: () => buildHostileResult(),
      getImpl: () => ({ ok: true, job: { state: 'failed' } }),
    });
    const result = await processAnalysisTask(
      baseArgs({
        analysisJobRepository: repository,
        analyzeSwing: async () => {
          throw new Error('analyzer error');
        },
      })
    );
    assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
    assert.equal(repository.calls.get.length, 1);
    assert.equal(repository.calls.complete.length, 0);
    assert.equal(repository.calls.succeed.length, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('revoked'), false);
  });
}

// Same combined-fields exploit as the completion case, but against
// failAnalysisJob's result after an analyzer exception.
test('a changing result.job getter on failAnalysisJob is read exactly once and never falsely confirmed', async () => {
  const job = validClaimedJob();
  const jobGetterSequence = [{}, { id: JOB_ID }, { swing_id: SWING_ID }, { state: 'failed' }];
  let jobGetterAccessCount = 0;
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    failImpl: () => ({
      ok: true,
      changed: true,
      get job() {
        const value = jobGetterSequence[jobGetterAccessCount] ?? jobGetterSequence[jobGetterSequence.length - 1];
        jobGetterAccessCount += 1;
        return value;
      },
    }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
  assert.equal(jobGetterAccessCount, 1);
  assert.equal(repository.calls.get.length, 1);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.succeed.length, 0);
});

// --- heartbeat setup, malformed shape, stop, and getter failures are contained ---

test('startLeaseHeartbeat throw returns database_error and never calls analyzeSwing', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
  let analyzerCalled = false;
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: () => {
        throw new Error('raw heartbeat setup secret that must never leak');
      },
      analyzeSwing: async () => {
        analyzerCalled = true;
      },
    })
  );
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(analyzerCalled, false);
  assert.equal(JSON.stringify(result).includes('raw heartbeat setup secret'), false);
});

test('startLeaseHeartbeat returning a malformed object returns database_error and never calls analyzeSwing', async () => {
  const job = validClaimedJob();
  const malformedHeartbeats = [
    null,
    undefined,
    'not-an-object',
    [],
    {},
    { stop: async () => {} },
    { stop: async () => {}, hasLostLease: () => false },
    { stop: async () => {}, hasLostLease: () => false, signal: null },
    { stop: async () => {}, hasLostLease: () => false, signal: {} },
    { stop: 'not-a-function', hasLostLease: () => false, signal: { aborted: false } },
    { stop: async () => {}, hasLostLease: 'not-a-function', signal: { aborted: false } },
  ];

  for (const heartbeat of malformedHeartbeats) {
    let analyzerCalled = false;
    const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
    const result = await processAnalysisTask(
      baseArgs({
        analysisJobRepository: repository,
        startLeaseHeartbeat: () => heartbeat,
        analyzeSwing: async () => {
          analyzerCalled = true;
        },
      })
    );
    assert.deepEqual(result, { ok: false, reason: 'database_error' }, `heartbeat=${JSON.stringify(heartbeat)}`);
    assert.equal(analyzerCalled, false);
  }
});

// --- throwing heartbeat property getters (not just malformed values) are contained ---

async function assertHeartbeatShapeAccessFailureIsContained({ heartbeat, forbiddenSubstring }) {
  const job = validClaimedJob();
  const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
  let analyzerCalled = false;
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat: () => heartbeat,
      analyzeSwing: async () => {
        analyzerCalled = true;
      },
    })
  );
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(analyzerCalled, false);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(JSON.stringify(result).includes(forbiddenSubstring), false);
}

test('startLeaseHeartbeat returning an object with a throwing stop getter returns database_error', async () => {
  const heartbeat = {
    hasLostLease: () => false,
    signal: new AbortController().signal,
    get stop() {
      throw new Error('raw stop getter secret that must never leak');
    },
  };
  await assertHeartbeatShapeAccessFailureIsContained({
    heartbeat,
    forbiddenSubstring: 'raw stop getter secret',
  });
});

test('startLeaseHeartbeat returning an object with a throwing hasLostLease getter returns database_error', async () => {
  const heartbeat = {
    stop: async () => {},
    signal: new AbortController().signal,
    get hasLostLease() {
      throw new Error('raw hasLostLease getter secret that must never leak');
    },
  };
  await assertHeartbeatShapeAccessFailureIsContained({
    heartbeat,
    forbiddenSubstring: 'raw hasLostLease getter secret',
  });
});

test('startLeaseHeartbeat returning an object with a throwing signal getter returns database_error', async () => {
  const heartbeat = {
    stop: async () => {},
    hasLostLease: () => false,
    get signal() {
      throw new Error('raw signal getter secret that must never leak');
    },
  };
  await assertHeartbeatShapeAccessFailureIsContained({
    heartbeat,
    forbiddenSubstring: 'raw signal getter secret',
  });
});

test('startLeaseHeartbeat returning a signal whose aborted getter throws returns database_error', async () => {
  const heartbeat = {
    stop: async () => {},
    hasLostLease: () => false,
    signal: {
      get aborted() {
        throw new Error('raw aborted getter secret that must never leak');
      },
    },
  };
  await assertHeartbeatShapeAccessFailureIsContained({
    heartbeat,
    forbiddenSubstring: 'raw aborted getter secret',
  });
});

test('heartbeat.stop throw returns database_error without leaking and without a terminal transition', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
  const startLeaseHeartbeat = () => ({
    signal: new AbortController().signal,
    hasLostLease: () => false,
    stop: async () => {
      throw new Error('raw stop secret that must never leak');
    },
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository, startLeaseHeartbeat }));
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(JSON.stringify(result).includes('raw stop secret'), false);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 0);
});

test('heartbeat.hasLostLease throw returns database_error without a terminal transition', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({ claimImpl: () => ({ ok: true, acquired: true, job }) });
  const startLeaseHeartbeat = () => ({
    signal: new AbortController().signal,
    hasLostLease: () => {
      throw new Error('raw hasLostLease secret that must never leak');
    },
    stop: async () => {},
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository, startLeaseHeartbeat }));
  assert.deepEqual(result, { ok: false, reason: 'database_error' });
  assert.equal(JSON.stringify(result).includes('raw hasLostLease secret'), false);
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.fail.length, 0);
});

// --- signal.aborted alone counts as lease loss ---

test('analyzer success with signal.aborted true (hasLostLease false) skips succeed and rereads once', async () => {
  const job = validClaimedJob();
  const controller = new AbortController();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    getImpl: () => ({ ok: true, job: { state: 'failed' } }),
  });
  const startLeaseHeartbeat = () => ({
    signal: controller.signal,
    hasLostLease: () => false,
    stop: async () => {
      controller.abort();
    },
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository, startLeaseHeartbeat }));
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true });
  assert.equal(repository.calls.succeed.length, 0);
  assert.equal(repository.calls.get.length, 1);
});

test('analyzer throw with signal.aborted true (hasLostLease false) skips fail and rereads once', async () => {
  const job = validClaimedJob();
  const controller = new AbortController();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    getImpl: () => ({ ok: true, job: { state: 'succeeded' } }),
  });
  const startLeaseHeartbeat = () => ({
    signal: controller.signal,
    hasLostLease: () => false,
    stop: async () => {
      controller.abort();
    },
  });
  const result = await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      startLeaseHeartbeat,
      analyzeSwing: async () => {
        throw new Error('analyzer error');
      },
    })
  );
  assert.deepEqual(result, { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'succeeded', idempotent: true });
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(repository.calls.get.length, 1);
});

// --- terminal RPC results are strictly validated before being trusted ---

test('fail transition changed:true with a malformed job rereads instead of trusting it', async () => {
  const job = validClaimedJob();
  const malformedJobs = [
    {},
    { id: 'wrong-id', swing_id: SWING_ID, state: 'failed' },
    { id: JOB_ID, swing_id: 'wrong-swing', state: 'failed' },
    { id: JOB_ID, swing_id: SWING_ID, state: 'running' },
  ];

  for (const malformedJob of malformedJobs) {
    const repository = makeRepository({
      claimImpl: () => ({ ok: true, acquired: true, job }),
      failImpl: () => ({ ok: true, changed: true, job: malformedJob }),
      getImpl: () => ({ ok: true, job: { state: 'failed' } }),
    });
    const result = await processAnalysisTask(
      baseArgs({
        analysisJobRepository: repository,
        analyzeSwing: async () => {
          throw new Error('analyzer error');
        },
      })
    );
    assert.deepEqual(
      result,
      { ok: true, jobId: JOB_ID, swingId: SWING_ID, state: 'failed', idempotent: true },
      `job=${JSON.stringify(malformedJob)}`
    );
    assert.equal(repository.calls.get.length, 1, `job=${JSON.stringify(malformedJob)}`);
  }
});

// --- heartbeat lifecycle ---

test('heartbeat stop is awaited before the processor returns', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });

  let stopAwaited = false;
  const startLeaseHeartbeat = () => ({
    signal: new AbortController().signal,
    hasLostLease: () => false,
    stop: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      stopAwaited = true;
    },
  });

  await processAnalysisTask(baseArgs({ analysisJobRepository: repository, startLeaseHeartbeat }));
  assert.equal(stopAwaited, true);
});

test('analyzeSwing is called at most once', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  let callCount = 0;
  await processAnalysisTask(
    baseArgs({
      analysisJobRepository: repository,
      analyzeSwing: async () => {
        callCount += 1;
      },
    })
  );
  assert.equal(callCount, 1);
});

// --- safe result fields only ---

test('safe result fields never include sensitive job data', async () => {
  const job = validClaimedJob();
  const repository = makeRepository({
    claimImpl: () => ({ ok: true, acquired: true, job }),
    completeImpl: () => ({ ok: true, changed: true, job: { id: JOB_ID, swing_id: SWING_ID, state: 'succeeded' } }),
  });
  const result = await processAnalysisTask(baseArgs({ analysisJobRepository: repository }));

  const forbiddenKeys = [
    'leaseToken', 'lease_token', 'userId', 'user_id',
    'storagePath', 'storage_path', 'equipmentContext', 'equipment_context',
    'slope', 'taskName', 'task_name',
  ];
  for (const key of forbiddenKeys) {
    assert.equal(key in result, false, `result must not contain ${key}`);
  }
  assert.equal(JSON.stringify(result).includes(LEASE_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(job.storage_path), false);
});

// --- static protection: the legacy success RPC is never invoked from here ---

test('analysisTaskProcessor.js source does not call succeedAnalysisJob(', () => {
  const sourcePath = fileURLToPath(new URL('./analysisTaskProcessor.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');
  assert.equal(source.includes('.succeedAnalysisJob('), false);
});
