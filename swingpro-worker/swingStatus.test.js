import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSwingStatus, classifySwingStatus, CLASSIFICATION } from './swingStatus.js';

test('normalizeSwingStatus lowercases and trims string statuses', () => {
  assert.equal(normalizeSwingStatus('PENDING'), 'pending');
  assert.equal(normalizeSwingStatus('  Error  '), 'error');
  assert.equal(normalizeSwingStatus('processing'), 'processing');
});

test('normalizeSwingStatus returns null for non-strings and empty strings', () => {
  assert.equal(normalizeSwingStatus(null), null);
  assert.equal(normalizeSwingStatus(undefined), null);
  assert.equal(normalizeSwingStatus(42), null);
  assert.equal(normalizeSwingStatus(''), null);
  assert.equal(normalizeSwingStatus('   '), null);
});

test('normalizeSwingStatus does not mutate its input', () => {
  const original = 'PENDING';
  normalizeSwingStatus(original);
  assert.equal(original, 'PENDING');
});

test('classifySwingStatus treats pending/PENDING as claimable', () => {
  assert.equal(classifySwingStatus('pending'), CLASSIFICATION.CLAIMABLE);
  assert.equal(classifySwingStatus('PENDING'), CLASSIFICATION.CLAIMABLE);
});

test('classifySwingStatus treats error/ERROR/Error as claimable', () => {
  assert.equal(classifySwingStatus('error'), CLASSIFICATION.CLAIMABLE);
  assert.equal(classifySwingStatus('ERROR'), CLASSIFICATION.CLAIMABLE);
  assert.equal(classifySwingStatus('Error'), CLASSIFICATION.CLAIMABLE);
});

test('classifySwingStatus treats processing/PROCESSING as processing', () => {
  assert.equal(classifySwingStatus('processing'), CLASSIFICATION.PROCESSING);
  assert.equal(classifySwingStatus('PROCESSING'), CLASSIFICATION.PROCESSING);
});

test('classifySwingStatus treats complete/COMPLETE as complete', () => {
  assert.equal(classifySwingStatus('complete'), CLASSIFICATION.COMPLETE);
  assert.equal(classifySwingStatus('COMPLETE'), CLASSIFICATION.COMPLETE);
});

test('classifySwingStatus treats unrecognized or missing values as unknown', () => {
  assert.equal(classifySwingStatus('bogus'), CLASSIFICATION.UNKNOWN);
  assert.equal(classifySwingStatus(''), CLASSIFICATION.UNKNOWN);
  assert.equal(classifySwingStatus(null), CLASSIFICATION.UNKNOWN);
  assert.equal(classifySwingStatus(undefined), CLASSIFICATION.UNKNOWN);
  assert.equal(classifySwingStatus(123), CLASSIFICATION.UNKNOWN);
});
