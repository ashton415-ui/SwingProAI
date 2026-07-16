import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSwingState,
  getSwingStateAfterClaimConflict,
  claimSwingForAnalysis,
  completeSwingAnalysis,
  markSwingErrorIfProcessing,
} from './swingRepository.js';

// A minimal recording stub of the Supabase query-builder chain shapes this
// module relies on: .from(table).select(cols).eq(...).maybeSingle() and
// .from(table).update(payload).eq(...).eq(...).select(cols).maybeSingle().
// Records every call so tests can assert on the exact filters used.
function makeRecordingSupabase({ maybeSingleResult }) {
  const calls = { table: null, updatePayload: undefined, selectCols: null, eqArgs: [] };

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
        update(payload) {
          calls.updatePayload = payload;
          const builder = {
            eq(field, value) {
              calls.eqArgs.push([field, value]);
              return builder;
            },
            select(cols) {
              calls.selectCols = cols;
              return { maybeSingle: async () => maybeSingleResult };
            },
          };
          return builder;
        },
      };
    },
  };
}

// --- getSwingState ---

test('getSwingState returns the row and filters by id', async () => {
  const swing = { id: 's1', user_id: 'u1', status: 'pending' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: swing, error: null } });

  const result = await getSwingState(supabase, 's1');

  assert.equal(result.ok, true);
  assert.deepEqual(result.swing, swing);
  assert.equal(supabase.calls.table, 'swings');
  assert.deepEqual(supabase.calls.eqArgs, [['id', 's1']]);
});

test('getSwingState returns ok:false on database error without leaking it', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: new Error('raw db secret') } });

  const result = await getSwingState(supabase, 's1');

  assert.equal(result.ok, false);
  assert.equal('error' in result ? typeof result.error : undefined, undefined);
});

test('getSwingStateAfterClaimConflict re-reads by id the same way', async () => {
  const swing = { id: 's1', user_id: 'u1', status: 'processing' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: swing, error: null } });

  const result = await getSwingStateAfterClaimConflict(supabase, 's1');

  assert.equal(result.ok, true);
  assert.deepEqual(result.swing, swing);
  assert.deepEqual(supabase.calls.eqArgs, [['id', 's1']]);
});

// --- claimSwingForAnalysis ---

test('claim query includes id, user_id, and the exact stored status', async () => {
  const claimedRow = { id: 's1', status: 'PROCESSING' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: claimedRow, error: null } });

  const result = await claimSwingForAnalysis(supabase, { swingId: 's1', userId: 'u1', exactStatus: 'Error' });

  assert.equal(result.ok, true);
  assert.equal(result.claimed, true);
  assert.deepEqual(supabase.calls.updatePayload, { status: 'PROCESSING' });
  assert.deepEqual(supabase.calls.eqArgs, [
    ['id', 's1'],
    ['user_id', 'u1'],
    ['status', 'Error'],
  ]);
  assert.equal(supabase.calls.selectCols, 'id, status');
});

test('claim returns claimed:false (not ok:false) when no row matched', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: null } });

  const result = await claimSwingForAnalysis(supabase, { swingId: 's1', userId: 'u1', exactStatus: 'pending' });

  assert.equal(result.ok, true);
  assert.equal(result.claimed, false);
});

test('claim returns ok:false on database error', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: new Error('raw db secret') } });

  const result = await claimSwingForAnalysis(supabase, { swingId: 's1', userId: 'u1', exactStatus: 'pending' });

  assert.equal(result.ok, false);
});

// --- completeSwingAnalysis ---

test('COMPLETE update includes id, user_id, and PROCESSING', async () => {
  const row = { id: 's1', status: 'COMPLETE' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: row, error: null } });

  const result = await completeSwingAnalysis(supabase, { swingId: 's1', userId: 'u1', telemetryData: { a: 1 } });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(supabase.calls.updatePayload, { status: 'COMPLETE', telemetry_data: { a: 1 } });
  assert.deepEqual(supabase.calls.eqArgs, [
    ['id', 's1'],
    ['user_id', 'u1'],
    ['status', 'PROCESSING'],
  ]);
});

test('COMPLETE update reports changed:false when the row was no longer PROCESSING', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: null } });

  const result = await completeSwingAnalysis(supabase, { swingId: 's1', userId: 'u1', telemetryData: {} });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

// --- markSwingErrorIfProcessing ---

test('ERROR update includes id, user_id, and PROCESSING', async () => {
  const row = { id: 's1', status: 'ERROR' };
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: row, error: null } });

  const result = await markSwingErrorIfProcessing(supabase, { swingId: 's1', userId: 'u1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(supabase.calls.updatePayload, { status: 'ERROR' });
  assert.deepEqual(supabase.calls.eqArgs, [
    ['id', 's1'],
    ['user_id', 'u1'],
    ['status', 'PROCESSING'],
  ]);
});

test('ERROR update reports changed:false and never overwrites a COMPLETE row', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: null } });

  const result = await markSwingErrorIfProcessing(supabase, { swingId: 's1', userId: 'u1' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

test('ERROR update returns ok:false on database error', async () => {
  const supabase = makeRecordingSupabase({ maybeSingleResult: { data: null, error: new Error('raw db secret') } });

  const result = await markSwingErrorIfProcessing(supabase, { swingId: 's1', userId: 'u1' });

  assert.equal(result.ok, false);
});
