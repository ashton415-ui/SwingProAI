import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrGetAnalysisJob,
  beginAnalysisJobEnqueue,
  markAnalysisJobQueued,
  recordAnalysisJobEnqueueFailure,
} from './analysisJobEnqueueRepository.js';

// A minimal recording stub of the Supabase RPC shape this module relies on:
// .rpc(name, args). Records the call so tests can assert on the exact RPC
// name/argument keys. `rpcImpl` may be a function to simulate a thrown
// client exception instead of a resolved { data, error } result.
function makeRecordingSupabase({ rpcResult, rpcImpl } = {}) {
  const calls = { rpcName: null, rpcArgs: null };

  return {
    calls,
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

// --- createOrGetAnalysisJob ---

test('createOrGetAnalysisJob calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'enqueue_pending' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
    equipmentContext: { make: 'Titleist' },
    slope: 1.5,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'create_or_get_swing_analysis_job');
  assert.deepEqual(supabase.calls.rpcArgs, {
    p_swing_id: 's1',
    p_expected_user_id: 'u1',
    p_storage_path: 'u1/swing.mp4',
    p_equipment_context: { make: 'Titleist' },
    p_slope: 1.5,
  });
});

test('createOrGetAnalysisJob normalizes undefined equipmentContext/slope to null', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });

  assert.equal(result.ok, true);
  assert.equal(result.job, null);
  assert.deepEqual(supabase.calls.rpcArgs, {
    p_swing_id: 's1',
    p_expected_user_id: 'u1',
    p_storage_path: 'u1/swing.mp4',
    p_equipment_context: null,
    p_slope: null,
  });
});

test('createOrGetAnalysisJob returns job:null for a null response', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });

  assert.equal(result.ok, true);
  assert.equal(result.job, null);
});

test('createOrGetAnalysisJob normalizes a non-array single-row response', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'enqueue_pending' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: row, error: null } });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.job, row);
});

test('createOrGetAnalysisJob returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('createOrGetAnalysisJob returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('createOrGetAnalysisJob rejects invalid input without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const missingSwing = await createOrGetAnalysisJob(supabase, {
    swingId: '',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
  });
  const missingUser = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: '',
    storagePath: 'u1/swing.mp4',
  });
  const missingPath = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: '',
  });
  const badEquipment = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
    equipmentContext: ['array', 'not', 'object'],
  });
  const badSlope = await createOrGetAnalysisJob(supabase, {
    swingId: 's1',
    expectedUserId: 'u1',
    storagePath: 'u1/swing.mp4',
    slope: Infinity,
  });

  for (const result of [missingSwing, missingUser, missingPath, badEquipment, badSlope]) {
    assert.equal(result.ok, false);
  }
  assert.equal(supabase.calls.rpcName, null);
});

// --- beginAnalysisJobEnqueue ---

test('beginAnalysisJobEnqueue calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'enqueue_pending', task_name: 't1' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await beginAnalysisJobEnqueue(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.begun, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'begin_swing_analysis_job_enqueue');
  assert.deepEqual(supabase.calls.rpcArgs, { p_job_id: 'j1', p_swing_id: 's1', p_task_name: 't1' });
});

test('beginAnalysisJobEnqueue maps an empty array response to begun:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await beginAnalysisJobEnqueue(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.begun, false);
  assert.equal(result.job, null);
});

test('beginAnalysisJobEnqueue returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await beginAnalysisJobEnqueue(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('beginAnalysisJobEnqueue returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await beginAnalysisJobEnqueue(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('beginAnalysisJobEnqueue rejects an invalid taskName without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const empty = await beginAnalysisJobEnqueue(supabase, { jobId: 'j1', swingId: 's1', taskName: '' });
  const tooLong = await beginAnalysisJobEnqueue(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 'a'.repeat(1025),
  });
  const controlChar = await beginAnalysisJobEnqueue(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 'abc\x01def',
  });

  assert.equal(empty.ok, false);
  assert.equal(tooLong.ok, false);
  assert.equal(controlChar.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('beginAnalysisJobEnqueue rejects invalid ids without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await beginAnalysisJobEnqueue(supabase, { jobId: '', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

// --- markAnalysisJobQueued ---

test('markAnalysisJobQueued calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'queued' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await markAnalysisJobQueued(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'mark_swing_analysis_job_queued');
  assert.deepEqual(supabase.calls.rpcArgs, { p_job_id: 'j1', p_swing_id: 's1', p_task_name: 't1' });
});

test('markAnalysisJobQueued maps an empty array response to changed:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await markAnalysisJobQueued(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.job, null);
});

test('markAnalysisJobQueued returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await markAnalysisJobQueued(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('markAnalysisJobQueued returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await markAnalysisJobQueued(supabase, { jobId: 'j1', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('markAnalysisJobQueued rejects an invalid taskName without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await markAnalysisJobQueued(supabase, { jobId: 'j1', swingId: 's1', taskName: '' });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('markAnalysisJobQueued rejects invalid ids without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await markAnalysisJobQueued(supabase, { jobId: '', swingId: 's1', taskName: 't1' });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

// --- recordAnalysisJobEnqueueFailure ---

test('recordAnalysisJobEnqueueFailure calls the exact RPC name with the exact argument keys', async () => {
  const row = { id: 'j1', swing_id: 's1', state: 'enqueue_pending', error_code: 'task_enqueue_failed' };
  const supabase = makeRecordingSupabase({ rpcResult: { data: [row], error: null } });

  const result = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'task_enqueue_failed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.job, row);
  assert.equal(supabase.calls.rpcName, 'record_swing_analysis_job_enqueue_failure');
  assert.deepEqual(supabase.calls.rpcArgs, {
    p_job_id: 'j1',
    p_swing_id: 's1',
    p_task_name: 't1',
    p_error_code: 'task_enqueue_failed',
  });
});

test('recordAnalysisJobEnqueueFailure maps an empty array response to changed:false, not an error', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: [], error: null } });

  const result = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'task_enqueue_failed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.job, null);
});

test('recordAnalysisJobEnqueueFailure returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: new Error('raw db secret') } });

  const result = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'task_enqueue_failed',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('recordAnalysisJobEnqueueFailure returns ok:false when the client throws', async () => {
  const supabase = makeRecordingSupabase({
    rpcImpl: () => {
      throw new Error('raw client secret');
    },
  });

  const result = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'task_enqueue_failed',
  });

  assert.equal(result.ok, false);
  assertNoRawError(result);
});

test('recordAnalysisJobEnqueueFailure rejects an invalid error code without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const uppercase = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'Bad-Code',
  });
  const empty = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: '',
  });
  const tooLong = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: 'j1',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'a'.repeat(65),
  });

  assert.equal(uppercase.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(tooLong.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});

test('recordAnalysisJobEnqueueFailure rejects invalid ids/taskName without calling Supabase', async () => {
  const supabase = makeRecordingSupabase({ rpcResult: { data: null, error: null } });

  const result = await recordAnalysisJobEnqueueFailure(supabase, {
    jobId: '',
    swingId: 's1',
    taskName: 't1',
    errorCode: 'task_enqueue_failed',
  });

  assert.equal(result.ok, false);
  assert.equal(supabase.calls.rpcName, null);
});
