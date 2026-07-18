import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLegacySwingAnalyzerAdapter } from './legacySwingAnalyzerAdapter.js';

const SWING_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const STORAGE_PATH = `${USER_ID}/swing.mp4`;
const TELEMETRY = { spatial_slope: null, coaching_assessment: { score: 80 } };

function makeProductionAnalyzer(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return impl ? impl(args) : TELEMETRY;
  };
  fn.calls = calls;
  return fn;
}

function makeCompleteImpl(impl) {
  const calls = [];
  const fn = async (supabase, args) => {
    calls.push({ supabase, args });
    return impl ? impl(args) : { ok: true, changed: true, row: { id: SWING_ID, status: 'COMPLETE' } };
  };
  fn.calls = calls;
  return fn;
}

function baseArgs(overrides = {}) {
  const supabase = { marker: 'supabase-instance' };
  return {
    supabase,
    productionAnalyzeSwing: makeProductionAnalyzer(),
    completeSwingAnalysisImpl: makeCompleteImpl(),
    ...overrides,
  };
}

test('factory throws when productionAnalyzeSwing is not a function', () => {
  assert.throws(() => createLegacySwingAnalyzerAdapter(baseArgs({ productionAnalyzeSwing: 'nope' })));
});

test('factory throws when completeSwingAnalysisImpl is not a function', () => {
  assert.throws(() => createLegacySwingAnalyzerAdapter(baseArgs({ completeSwingAnalysisImpl: 'nope' })));
});

test('maps positional arguments to the production analyzer object contract exactly once', async () => {
  const productionAnalyzeSwing = makeProductionAnalyzer();
  const completeSwingAnalysisImpl = makeCompleteImpl();
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({ productionAnalyzeSwing, completeSwingAnalysisImpl }));

  const equipmentContext = { make: 'Titleist', club_type: 'Driver' };
  await adapter(SWING_ID, STORAGE_PATH, equipmentContext, 3.5, USER_ID);

  assert.equal(productionAnalyzeSwing.calls.length, 1);
  assert.deepEqual(productionAnalyzeSwing.calls[0], {
    swingId: SWING_ID,
    storagePath: STORAGE_PATH,
    equipmentContext,
    slope: 3.5,
    userId: USER_ID,
  });
});

test('calls completeSwingAnalysisImpl exactly once with the unchanged telemetry object, exact swingId and userId', async () => {
  const telemetry = { spatial_slope: 1, coaching_assessment: { score: 91 } };
  const productionAnalyzeSwing = makeProductionAnalyzer(() => telemetry);
  const completeSwingAnalysisImpl = makeCompleteImpl();
  const supabase = { marker: 'the-supabase-instance' };
  const adapter = createLegacySwingAnalyzerAdapter({ supabase, productionAnalyzeSwing, completeSwingAnalysisImpl });

  await adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID);

  assert.equal(completeSwingAnalysisImpl.calls.length, 1);
  assert.equal(completeSwingAnalysisImpl.calls[0].supabase, supabase);
  assert.equal(completeSwingAnalysisImpl.calls[0].args.telemetryData, telemetry);
  assert.equal(completeSwingAnalysisImpl.calls[0].args.swingId, SWING_ID);
  assert.equal(completeSwingAnalysisImpl.calls[0].args.userId, USER_ID);
});

test('confirmed finalization (ok:true, changed:true) returns the telemetry data', async () => {
  const telemetry = { spatial_slope: null, coaching_assessment: { score: 77 } };
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    productionAnalyzeSwing: makeProductionAnalyzer(() => telemetry),
    completeSwingAnalysisImpl: makeCompleteImpl(() => ({ ok: true, changed: true, row: {} })),
  }));
  const result = await adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID);
  assert.equal(result, telemetry);
});

test('ok:false throws a generic error', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => ({ ok: false, changed: true })),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('changed:false throws a generic error', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => ({ ok: true, changed: false })),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('a thrown finalization error is contained and not leaked raw', async () => {
  const completeSwingAnalysisImpl = async () => {
    throw new Error('raw database secret detail');
  };
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({ completeSwingAnalysisImpl }));
  await assert.rejects(
    () => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID),
    (err) => !err.message.includes('raw database secret detail')
  );
});

test('a malformed finalization result (array) is contained', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => []),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('a malformed finalization result (function) is contained', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => function fakeFinalization() {}),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('a malformed finalization result (null) is contained', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => null),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('a malformed finalization result (string) is contained', async () => {
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => 'not-an-object'),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('a throwing getter on the finalization result is contained', async () => {
  const hostileResult = {};
  Object.defineProperty(hostileResult, 'ok', {
    get() { throw new Error('hostile getter secret'); },
  });
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => hostileResult),
  }));
  await assert.rejects(
    () => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID),
    (err) => !err.message.includes('hostile getter secret')
  );
});

test('a revoked Proxy finalization result is contained', async () => {
  const { proxy, revoke } = Proxy.revocable({ ok: true, changed: true }, {});
  revoke();
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => proxy),
  }));
  await assert.rejects(() => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID));
});

test('result.ok and result.changed are each read no more than once', async () => {
  let okReads = 0;
  let changedReads = 0;
  const result = {
    get ok() { okReads += 1; return true; },
    get changed() { changedReads += 1; return true; },
  };
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({
    completeSwingAnalysisImpl: makeCompleteImpl(() => result),
  }));
  await adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID);
  assert.equal(okReads, 1);
  assert.equal(changedReads, 1);
});

test('a production analyzer exception is contained: finalization is never called, the raw message never leaks, and the adapter rejects generically', async () => {
  const SECRET = 'raw-analyzer-secret-detail-XYZ-do-not-leak';
  const productionAnalyzeSwing = async () => {
    throw new Error(SECRET);
  };
  const completeSwingAnalysisImpl = makeCompleteImpl();
  const adapter = createLegacySwingAnalyzerAdapter(baseArgs({ productionAnalyzeSwing, completeSwingAnalysisImpl }));
  await assert.rejects(
    () => adapter(SWING_ID, STORAGE_PATH, null, null, USER_ID),
    (err) => err.message === 'Swing analysis failed' && !err.message.includes(SECRET)
  );
  assert.equal(completeSwingAnalysisImpl.calls.length, 0);
});
