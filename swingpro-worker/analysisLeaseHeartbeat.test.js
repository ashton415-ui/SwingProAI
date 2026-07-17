import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAnalysisLeaseHeartbeat } from './analysisLeaseHeartbeat.js';

const JOB_ID = 'job-1';
const SWING_ID = 'swing-1';
const LEASE_TOKEN = 'lease-token-1';

// A controllable fake timer: setIntervalFn/clearIntervalFn never touch real
// timers. `fire()` invokes the scheduled callback synchronously and returns
// whatever it returns (the in-flight renewal promise, or null) so tests can
// choose to await it deterministically instead of relying on microtask
// ordering. Callers that want to assert non-overlap must NOT await a fire()
// call whose renewal they haven't resolved yet — tick() returns the shared
// in-flight promise on an overlapping call, so awaiting it before resolving
// would deadlock the test.
function makeFakeTimer() {
  const calls = { setInterval: [], clearInterval: [] };
  let scheduledFn = null;
  let cleared = false;
  const timerObject = { unrefCalled: 0, unref() { timerObject.unrefCalled += 1; } };

  return {
    calls,
    timerObject,
    isCleared: () => cleared,
    setIntervalFn(fn, ms) {
      calls.setInterval.push(ms);
      scheduledFn = fn;
      return timerObject;
    },
    clearIntervalFn(timer) {
      calls.clearInterval.push(timer);
      cleared = true;
    },
    fire() {
      return scheduledFn();
    },
  };
}

function makeRecordingRepository(impl) {
  const calls = [];
  return {
    calls,
    async renewAnalysisJobLease(supabase, args) {
      calls.push(args);
      return impl(args);
    },
  };
}

function baseArgs(overrides = {}) {
  const fakeTimer = makeFakeTimer();
  return {
    args: {
      supabase: {},
      jobId: JOB_ID,
      swingId: SWING_ID,
      leaseToken: LEASE_TOKEN,
      leaseSeconds: 60,
      setIntervalFn: fakeTimer.setIntervalFn,
      clearIntervalFn: fakeTimer.clearIntervalFn,
      ...overrides,
    },
    fakeTimer,
  };
}

test('renewal interval is Math.max(10000, floor(leaseSeconds*1000/3))', () => {
  const { args, fakeTimer } = baseArgs({
    leaseSeconds: 60,
    analysisJobRepository: makeRecordingRepository(() => ({ ok: true, renewed: true })),
  });
  startAnalysisLeaseHeartbeat(args);
  assert.deepEqual(fakeTimer.calls.setInterval, [20000]);
});

test('renewal interval floors at 10000ms for short leases', () => {
  const { args, fakeTimer } = baseArgs({
    leaseSeconds: 30,
    analysisJobRepository: makeRecordingRepository(() => ({ ok: true, renewed: true })),
  });
  startAnalysisLeaseHeartbeat(args);
  assert.deepEqual(fakeTimer.calls.setInterval, [10000]);
});

test('calls renewAnalysisJobLease with exactly the documented arguments', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(repository.calls.length, 1);
  assert.deepEqual(repository.calls[0], {
    jobId: JOB_ID,
    swingId: SWING_ID,
    leaseToken: LEASE_TOKEN,
    leaseSeconds: 60,
  });
});

test('does not allow overlapping renewal calls', async () => {
  let resolveRenewal;
  const repository = makeRecordingRepository(
    () =>
      new Promise((resolve) => {
        resolveRenewal = () => resolve({ ok: true, renewed: true });
      })
  );
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  startAnalysisLeaseHeartbeat(args);

  // Both ticks fire synchronously before either renewal resolves. A second
  // tick while one is in flight must return the same shared promise rather
  // than starting a new renewal — awaiting it here (before resolving) would
  // otherwise deadlock, which is itself proof the overlap guard is working.
  const firstFire = fakeTimer.fire();
  const secondFire = fakeTimer.fire();
  assert.equal(repository.calls.length, 1);

  resolveRenewal();
  await firstFire;
  await secondFire;
  assert.equal(repository.calls.length, 1);
});

test('successful renewal keeps the lease active', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(heartbeat.hasLostLease(), false);
  assert.equal(heartbeat.signal.aborted, false);
  assert.equal(fakeTimer.isCleared(), false);
});

test('ok:false marks the lease lost and aborts', async () => {
  const repository = makeRecordingRepository(() => ({ ok: false }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(heartbeat.hasLostLease(), true);
  assert.equal(heartbeat.signal.aborted, true);
  assert.equal(fakeTimer.isCleared(), true);
});

test('renewed:false marks the lease lost and aborts', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: false }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(heartbeat.hasLostLease(), true);
  assert.equal(heartbeat.signal.aborted, true);
  assert.equal(fakeTimer.isCleared(), true);
});

test('a thrown renewal marks the lease lost and aborts without leaking the error', async () => {
  const repository = makeRecordingRepository(() => {
    throw new Error('raw db secret');
  });
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(heartbeat.hasLostLease(), true);
  assert.equal(heartbeat.signal.aborted, true);
  assert.equal(fakeTimer.isCleared(), true);
});

test('stop clears the timer', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await heartbeat.stop();

  assert.equal(fakeTimer.isCleared(), true);
});

test('stop awaits an in-flight renewal', async () => {
  let resolveRenewal;
  let resolved = false;
  const repository = makeRecordingRepository(
    () =>
      new Promise((resolve) => {
        resolveRenewal = () => {
          resolved = true;
          resolve({ ok: true, renewed: true });
        };
      })
  );
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  const fireDone = fakeTimer.fire();
  const stopPromise = heartbeat.stop();

  // Renewal hasn't resolved yet — stop must not resolve until it does.
  let stopResolved = false;
  stopPromise.then(() => {
    stopResolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stopResolved, false);

  resolveRenewal();
  await fireDone;
  await stopPromise;
  assert.equal(resolved, true);
  assert.equal(stopResolved, true);
});

test('stop is idempotent', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await heartbeat.stop();
  await heartbeat.stop();
  await heartbeat.stop();
});

test('no renewal begins after stop', async () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await heartbeat.stop();
  await fakeTimer.fire();

  assert.equal(repository.calls.length, 0);
});

test('timer unref is called when available', () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  startAnalysisLeaseHeartbeat(args);

  assert.equal(fakeTimer.timerObject.unrefCalled, 1);
});

test('invalid configuration never schedules a timer', () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const cases = [
    { jobId: '', swingId: SWING_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 60 },
    { jobId: JOB_ID, swingId: '', leaseToken: LEASE_TOKEN, leaseSeconds: 60 },
    { jobId: JOB_ID, swingId: SWING_ID, leaseToken: '', leaseSeconds: 60 },
    { jobId: JOB_ID, swingId: SWING_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 29 },
    { jobId: JOB_ID, swingId: SWING_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 3601 },
    { jobId: JOB_ID, swingId: SWING_ID, leaseToken: LEASE_TOKEN, leaseSeconds: 60.5 },
  ];

  for (const overrides of cases) {
    const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository, ...overrides });
    assert.throws(() => startAnalysisLeaseHeartbeat(args));
    assert.equal(fakeTimer.calls.setInterval.length, 0);
  }
});

test('invalid configuration error never includes supplied secret values', () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args } = baseArgs({
    analysisJobRepository: repository,
    leaseToken: 'super-secret-lease-token-value',
    leaseSeconds: -1,
  });

  try {
    startAnalysisLeaseHeartbeat(args);
    assert.fail('expected startAnalysisLeaseHeartbeat to throw');
  } catch (err) {
    assert.equal(err.message.includes('super-secret-lease-token-value'), false);
  }
});

// --- createAbortController is validated before any timer is scheduled ---

function assertGenericConfigurationError(fn, forbiddenSubstrings = []) {
  let thrown;
  try {
    fn();
    assert.fail('expected startAnalysisLeaseHeartbeat to throw');
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown instanceof Error, true);
  assert.equal(thrown.message, 'invalid analysis lease heartbeat configuration');
  for (const substring of forbiddenSubstrings) {
    assert.equal(thrown.message.includes(substring), false);
  }
}

test('createAbortController throw becomes the generic configuration error with no timer scheduled', () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));
  const { args, fakeTimer } = baseArgs({
    analysisJobRepository: repository,
    createAbortController: () => {
      throw new Error('raw abort controller secret that must never leak');
    },
  });

  assertGenericConfigurationError(
    () => startAnalysisLeaseHeartbeat(args),
    ['raw abort controller secret']
  );
  assert.equal(fakeTimer.calls.setInterval.length, 0);
  assert.equal(fakeTimer.calls.clearInterval.length, 0);
});

test('malformed createAbortController output never schedules a timer', () => {
  const repository = makeRecordingRepository(() => ({ ok: true, renewed: true }));

  const cases = [
    { label: 'null controller', controller: null },
    { label: 'controller missing abort()', controller: { signal: { aborted: false } } },
    { label: 'controller missing signal', controller: { abort: () => {} } },
    {
      label: 'signal.aborted is not boolean',
      controller: { abort: () => {}, signal: { aborted: 'no' } },
    },
    {
      label: 'signal getter throws',
      controller: {
        abort: () => {},
        get signal() {
          throw new Error('raw signal getter secret that must never leak');
        },
      },
    },
    {
      label: 'signal.aborted getter throws',
      controller: {
        abort: () => {},
        signal: {
          get aborted() {
            throw new Error('raw aborted getter secret that must never leak');
          },
        },
      },
    },
  ];

  for (const { label, controller } of cases) {
    const { args, fakeTimer } = baseArgs({
      analysisJobRepository: repository,
      createAbortController: () => controller,
    });

    assertGenericConfigurationError(
      () => startAnalysisLeaseHeartbeat(args),
      ['raw signal getter secret', 'raw aborted getter secret']
    );
    assert.equal(fakeTimer.calls.setInterval.length, 0, label);
    assert.equal(fakeTimer.calls.clearInterval.length, 0, label);
  }
});

test('raw renewal errors never appear in returned state', async () => {
  const repository = makeRecordingRepository(() => {
    throw new Error('raw db secret that must never leak');
  });
  const { args, fakeTimer } = baseArgs({ analysisJobRepository: repository });
  const heartbeat = startAnalysisLeaseHeartbeat(args);

  await fakeTimer.fire();

  assert.equal(JSON.stringify(Object.keys(heartbeat)).includes('error'), false);
  assert.equal(typeof heartbeat.hasLostLease(), 'boolean');
});
