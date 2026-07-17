import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAnalysisJob,
  claimAnalysisJobLease,
  renewAnalysisJobLease,
  succeedAnalysisJob,
  failAnalysisJob,
} from './analysisJobRepository.js';

// A minimal recording stub of the Supabase query-builder/RPC shapes this
// module relies on: .from(table).select(cols).eq(...).eq(...).maybeSingle()
// for reads, and .rpc(name, args) for the lease transition functions.
// Records every call so tests can assert on the exact table/columns/filters
// or RPC name/argument keys used. `rpcImpl` may be a function to simulate a
// thrown client exception instead of a resolved { data, error } result.
function makeRecordingSupabase({ maybeSingleResult, rpcResult, rpcImpl } = {}) {
  const calls = { table: null, selectCols: null, eqArgs: [], rpcName: null, rpcArgs: null };

  return {
    calls,
    from(table) {
      calls.table = table;
      return {
        select(cols) {
          calls.selectCols = cols;
          const builder = {
            eq(field, value) {
              calls.eqArgs.push([field, value]);
              return builder;
            },
            maybeSingle: async () => maybeSingleResult,
          };
          return builder;
        },
      };
    },
    async rpc(name, args) {
      calls.rpcName = name;
      calls.rpcArgs = args;
      if (rpcImpl) return rpcImpl();
      return rpcResult;
    },
  };
}

function assertNoRawError(result) {
  assert.equal('error' in result, false);
}

// --- getAnalysisJob ---

test('getAnalysisJob selects the exact fields and filters by id and swing_id', async () => {
  const job = { id: 'j1', swing_id: 's1', state: 'queued' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: job, error: null } });

  const result = await getAnalysisJob(supabase, { jobId: 'j1', swingId: 's1' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.job, job);
  assert.equal(supabase.calls.table, 'swing_analysis_jobs');
  assert.deepEqual(supabase.calls.eqArgs, [
    ['id', 'j1'],
    ['swing_id', 's1'],
  ]);
  const selected = supabase.calls.selectCols;
  for (const field of [
    'id',
    'swing_id',
    'user_id',
    'state',
    'task_name',
    'storage_path',
    'equipment_context',
    'slope',
    'enqueue_attempts',
    'execution_attempts',
    'lease_token',
    'lease_expires_at',
    'error_code',
    'enqueued_at',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(selected.includes(field), `expected select to include ${field}`);
  }
});

test('getAnalysisJob returns job:null when no row matched', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: null } });

  const result = await getAnalysisJob(supabase, { jobId: 'j1', swingId: 's1' });

  assert.equal(result.ok, true);
  assert.equal(result.job, null);
});

test('getAnalysisJob returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: new Error('raw db secret') } });

  const result = await getAnalysisJob(supabase, { jobId: 'j1', swingId: 's1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('getAnalysisJob returns ok:false when the client throws', async () => {
  const supabase = {
    from() {
      throw new Error('raw client secret');
    },
  };

  const result = await getAnalysisJob(supabase, { jobId: 'j1', swingId: 's1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('getAnalysisJob rejects invalid ids without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: null } });

  const result1 = await getAnalysisJob(supabase, { jobId: '', swingId: 's1' });
  const result2 = await getAnalysisJob(supabase, { jobId: 'j1', swingId: undefined });

  assert.equal(result1.ok, false);
  assert.equal(result2.ok, false);
  assert.equal(supabase.calls.table, null);
});

// --- claimAnalysisJobLease ---

test('claim calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'running' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.acquired, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'claim_swing_analysis_job');
  assert.deepEqual(supabase.calls.rpcArgs, { p_job_id: 'j1', p_swing_id: 's1', p_lease_seconds: 60 });
});

test('claim normalizes a non-array single-row response', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'running' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: row, error: null } });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.acquired, true);
  assert.deepEqual(result.job, row);
});

test('claim maps an empty array response to acquired:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.acquired, false);
  assert.equal(result.job, null);
});

test('claim maps a null response to acquired:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.acquired, false);
  assert.equal(result.job, null);
});

test('claim returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('claim returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('claim rejects an invalid lease duration without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const tooLow = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 29 });
  const tooHigh = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 3601 });
  const notInt = await claimAnalysisJobLease(supabase, { jobId: 'j1', swingId: 's1', leaseSeconds: 60.5 });

  assert.equal(tooLow.ok, false);
  assert.equal(tooHigh.ok, false);
  assert.equal(notInt.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('claim rejects invalid ids without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await claimAnalysisJobLease(supabase, { jobId: '', swingId: 's1', leaseSeconds: 60 });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

// --- renewAnalysisJobLease ---

test('renew calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'running' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 120,
  });

  assert.equal(result.ok, true);
  assert.equal(result.renewed, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'renew_swing_analysis_job_lease');
  assert.deepEqual(supabase.calls.rpcArgs, {
    p_job_id: 'j1',
    p_swing_id: 's1',
    p_lease_token: 't1',
    p_lease_seconds: 120,
  });
});

test('renew maps an empty array response to renewed:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 120,
  });

  assert.equal(result.ok, true);
  assert.equal(result.renewed, false);
  assert.equal(result.job, null);
});

test('renew maps a null response to renewed:false', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 120,
  });

  assert.equal(result.ok, true);
  assert.equal(result.renewed, false);
});

test('renew returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 120,
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('renew returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 120,
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('renew rejects an invalid lease duration without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    leaseSeconds: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('renew rejects an invalid lease token without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await renewAnalysisJobLease(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: '',
    leaseSeconds: 60,
  });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

// --- succeedAnalysisJob ---

test('succeed calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'succeeded' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await succeedAnalysisJob(supabase, { jobId: 'j1', swingId: 's1', leaseToken: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'succeed_swing_analysis_job');
  assert.deepEqual(supabase.calls.rpcArgs, { p_job_id: 'j1', p_swing_id: 's1', p_lease_token: 't1' });
});

test('succeed maps an empty array response to changed:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await succeedAnalysisJob(supabase, { jobId: 'j1', swingId: 's1', leaseToken: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.job, null);
});

test('succeed returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await succeedAnalysisJob(supabase, { jobId: 'j1', swingId: 's1', leaseToken: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('succeed returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await succeedAnalysisJob(supabase, { jobId: 'j1', swingId: 's1', leaseToken: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('succeed rejects invalid ids/token without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await succeedAnalysisJob(supabase, { jobId: 'j1', swingId: 's1', leaseToken: '' });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

// --- failAnalysisJob ---

test('fail calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'failed', error_code: 'storage_download_failed' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'storage_download_failed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'fail_swing_analysis_job');
  assert.deepEqual(supabase.calls.rpcArgs, {
    p_job_id: 'j1',
    p_swing_id: 's1',
    p_lease_token: 't1',
    p_error_code: 'storage_download_failed',
  });
});

test('fail maps an empty array response to changed:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'analysis_failed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.job, null);
});

test('fail returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'analysis_failed',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('fail returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'analysis_failed',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('fail rejects an invalid error code without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const uppercase = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'Analysis_Failed',
  });
  const withSpaces = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'analysis failed',
  });
  const empty = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: '',
  });
  const tooLong = await failAnalysisJob(supabase, {
    jobId: 'j1',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'a'.repeat(65),
  });

  assert.equal(uppercase.ok, false);
  assert.equal(withSpaces.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(tooLong.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('fail rejects invalid ids/token without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await failAnalysisJob(supabase, {
    jobId: '',
    swingId: 's1',
    leaseToken: 't1',
    errorCode: 'analysis_failed',
  });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});
