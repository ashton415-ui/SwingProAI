// Migration contract tests for Phase 2B2B3B3A (atomic swing/job execution and
// finalization primitives). These are structural checks against the raw SQL
// text of the generated migration -- they protect the security and
// atomicity contract (lock order, ownership derivation, guarded state
// transitions, revoke/grant posture) without depending on incidental
// formatting choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION_SUFFIX = '_atomic_swing_analysis_job_finalization.sql';

// Locates the migration deterministically by its descriptive suffix rather
// than a hardcoded timestamp. Fails loudly (at module load) if the suffix
// resolves to anything other than exactly one file, since a zero- or
// multiple-match result means the contract checks below would silently pass
// against the wrong file (or fail to find one at all).
function findMigrationPath() {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  const matches = files.filter((name) => name.endsWith(MIGRATION_SUFFIX)).sort();
  assert.equal(
    matches.length,
    1,
    `expected exactly one migration file ending in "${MIGRATION_SUFFIX}", found ${matches.length}: ${JSON.stringify(matches)}`
  );
  return path.join(MIGRATIONS_DIR, matches[0]);
}

const migrationPath = findMigrationPath();
const sql = fs.readFileSync(migrationPath, 'utf8');

// Slices out one function's full section (signature through its trailing
// revoke/grant statements) by finding this function's CREATE and the next
// top-level CREATE (or end of file) as the boundary.
function extractFunctionSection(content, functionName) {
  const createPattern = new RegExp(
    `create (?:or replace )?function public\\.${functionName}\\s*\\(`,
    'i'
  );
  const startMatch = createPattern.exec(content);
  assert.ok(startMatch, `expected to find CREATE FUNCTION for ${functionName}`);
  const start = startMatch.index;

  const nextCreatePattern = /create (?:or replace )?function public\./gi;
  nextCreatePattern.lastIndex = start + startMatch[0].length;
  const nextMatch = nextCreatePattern.exec(content);
  const end = nextMatch ? nextMatch.index : content.length;

  return content.slice(start, end);
}

function extractSignature(section, functionName) {
  const pattern = new RegExp(
    `create (?:or replace )?function public\\.${functionName}\\s*\\(([\\s\\S]*?)\\)\\s*\\n\\s*returns`,
    'i'
  );
  const match = pattern.exec(section);
  assert.ok(match, `expected to find a parenthesized signature for ${functionName}`);
  return match[1];
}

// Isolates a single executable SQL statement (e.g. one UPDATE) by anchoring
// on its leading keywords and reading to the next statement-terminating
// semicolon. Anchoring on the statement's own leading SQL keywords (rather
// than matching anywhere in the section) means these assertions can only be
// satisfied by the real write, never by prose in a preceding comment line.
function extractStatement(section, pattern, description) {
  const match = pattern.exec(section);
  assert.ok(match, `expected to find ${description}`);
  const start = match.index;
  const end = section.indexOf(';', start);
  assert.ok(end > start, `expected ${description} to be terminated by a semicolon`);
  return section.slice(start, end + 1);
}

const claimSection = extractFunctionSection(sql, 'claim_swing_analysis_job');
const completeSection = extractFunctionSection(sql, 'complete_swing_analysis_job');
const failSection = extractFunctionSection(sql, 'fail_swing_analysis_job');

// --- A. claim_swing_analysis_job ---

test('claim_swing_analysis_job preserves its existing three-argument signature', () => {
  const signature = extractSignature(claimSection, 'claim_swing_analysis_job');
  assert.match(signature, /p_job_id\s+uuid/);
  assert.match(signature, /p_swing_id\s+uuid/);
  assert.match(signature, /p_lease_seconds\s+integer/);
  assert.match(claimSection, /returns setof public\.swing_analysis_jobs/);
});

test('claim_swing_analysis_job is SECURITY INVOKER with an empty search_path', () => {
  assert.match(claimSection, /security invoker/i);
  assert.match(claimSection, /set search_path = ''/);
  assert.doesNotMatch(claimSection, /security definer/i);
});

test('claim_swing_analysis_job locks the swing row before the job row', () => {
  const swingLockIndex = claimSection.search(/from public\.swings[\s\S]*?for update/);
  const jobLockIndex = claimSection.search(/from public\.swing_analysis_jobs[\s\S]*?for update/);
  assert.ok(swingLockIndex >= 0, 'expected a swing row lock');
  assert.ok(jobLockIndex >= 0, 'expected a job row lock');
  assert.ok(swingLockIndex < jobLockIndex, 'expected swing to be locked before the job');
});

test('claim_swing_analysis_job ties job ownership to the locked swing via user_id', () => {
  assert.match(claimSection, /and\s+user_id\s*=\s*v_swing\.user_id/);
});

test('claim_swing_analysis_job eligible states include enqueue_pending and queued, and expired running leases', () => {
  assert.match(claimSection, /state\s*=\s*'enqueue_pending'/);
  assert.match(claimSection, /state\s*=\s*'queued'/);
  assert.match(
    claimSection,
    /state\s*=\s*'running'\s+and\s+\(lease_expires_at is null or lease_expires_at < v_now\)/
  );
});

test('claim_swing_analysis_job restricts the swing status to pending/error/processing', () => {
  assert.match(
    claimSection,
    /not in \('pending', 'error', 'processing'\)/
  );
});

test('claim_swing_analysis_job drives the swing to PROCESSING and never writes telemetry_data', () => {
  assert.match(claimSection, /set status = 'PROCESSING'/);
  assert.doesNotMatch(claimSection, /telemetry_data/);
});

test('claim_swing_analysis_job increments execution_attempts exactly once', () => {
  const matches = claimSection.match(/execution_attempts\s*=\s*execution_attempts\s*\+\s*1/g) ?? [];
  assert.equal(matches.length, 1);
});

test('claim_swing_analysis_job sets a fresh lease token and expiration', () => {
  assert.match(claimSection, /lease_token\s*=\s*v_lease_token/);
  assert.match(
    claimSection,
    /lease_expires_at\s*=\s*v_now \+ pg_catalog\.make_interval\(secs => p_lease_seconds\)/
  );
});

test('claim_swing_analysis_job job UPDATE repeats both ids, derived user_id, and the eligibility predicate', () => {
  const jobWrite = extractStatement(
    claimSection,
    /update public\.swing_analysis_jobs\b[\s\S]*?state\s*=\s*'running'/,
    'the job-claiming UPDATE statement'
  );
  assert.match(jobWrite, /where[\s\S]*id\s*=\s*p_job_id/);
  assert.match(jobWrite, /swing_id\s*=\s*p_swing_id/);
  assert.match(jobWrite, /user_id\s*=\s*v_swing\.user_id/);
  assert.match(jobWrite, /state\s*=\s*'enqueue_pending'/);
  assert.match(jobWrite, /state\s*=\s*'queued'/);
  assert.match(
    jobWrite,
    /state\s*=\s*'running'\s+and\s+\(lease_expires_at is null or lease_expires_at < v_now\)/
  );
});

test('claim_swing_analysis_job returns a row scoped by both ids and running state', () => {
  const returnStatement = extractStatement(claimSection, /return query[\s\S]*?;/, 'the RETURN QUERY statement');
  assert.match(returnStatement, /id\s*=\s*p_job_id/);
  assert.match(returnStatement, /swing_id\s*=\s*p_swing_id/);
  assert.match(returnStatement, /state\s*=\s*'running'/);
});

test('claim_swing_analysis_job revokes from PUBLIC/anon/authenticated and grants only to service_role', () => {
  assert.match(claimSection, /revoke execute on function public\.claim_swing_analysis_job\([^)]*\) from public;/);
  assert.match(claimSection, /revoke execute on function public\.claim_swing_analysis_job\([^)]*\) from anon;/);
  assert.match(
    claimSection,
    /revoke execute on function public\.claim_swing_analysis_job\([^)]*\) from authenticated;/
  );
  assert.match(
    claimSection,
    /grant execute on function public\.claim_swing_analysis_job\([^)]*\) to service_role;/
  );
});

// --- B. complete_swing_analysis_job ---

test('complete_swing_analysis_job has the exact four-parameter signature', () => {
  const signature = extractSignature(completeSection, 'complete_swing_analysis_job');
  assert.match(signature, /p_job_id\s+uuid/);
  assert.match(signature, /p_swing_id\s+uuid/);
  assert.match(signature, /p_lease_token\s+uuid/);
  assert.match(signature, /p_telemetry_data\s+jsonb/);
  assert.match(completeSection, /returns setof public\.swing_analysis_jobs/);
});

test('complete_swing_analysis_job is SECURITY INVOKER with an empty search_path', () => {
  assert.match(completeSection, /security invoker/i);
  assert.match(completeSection, /set search_path = ''/);
  assert.doesNotMatch(completeSection, /security definer/i);
});

test('complete_swing_analysis_job validates telemetry as a JSON object', () => {
  assert.match(
    completeSection,
    /p_telemetry_data is null or pg_catalog\.jsonb_typeof\(p_telemetry_data\) <> 'object'/
  );
});

test('complete_swing_analysis_job locks the swing row before the job row', () => {
  const swingLockIndex = completeSection.search(/from public\.swings[\s\S]*?for update/);
  const jobLockIndex = completeSection.search(/from public\.swing_analysis_jobs[\s\S]*?for update/);
  assert.ok(swingLockIndex >= 0, 'expected a swing row lock');
  assert.ok(jobLockIndex >= 0, 'expected a job row lock');
  assert.ok(swingLockIndex < jobLockIndex, 'expected swing to be locked before the job');
});

test('complete_swing_analysis_job guards running state and the exact lease token', () => {
  assert.match(completeSection, /state\s*=\s*'running'/);
  assert.match(completeSection, /lease_token\s*=\s*p_lease_token/);
});

test('complete_swing_analysis_job ties job ownership to the locked swing via user_id', () => {
  assert.match(completeSection, /and\s+user_id\s*=\s*v_swing\.user_id/);
});

test('complete_swing_analysis_job requires the swing to be exactly PROCESSING', () => {
  assert.match(completeSection, /v_swing\.status <> 'PROCESSING'/);
});

test('complete_swing_analysis_job swing UPDATE writes COMPLETE/telemetry_data and re-guards on PROCESSING', () => {
  const swingWrite = extractStatement(
    completeSection,
    /update public\.swings\b[\s\S]*?;/,
    'the swing-completing UPDATE statement'
  );
  assert.match(swingWrite, /set status = 'COMPLETE', telemetry_data = p_telemetry_data/);
  assert.match(swingWrite, /where[\s\S]*id\s*=\s*p_swing_id/);
  assert.match(swingWrite, /user_id\s*=\s*v_job\.user_id/);
  assert.match(swingWrite, /status\s*=\s*'PROCESSING'/);
});

test('complete_swing_analysis_job job UPDATE repeats both ids, derived user_id, running state, and the exact lease token', () => {
  const jobWrite = extractStatement(
    completeSection,
    /update public\.swing_analysis_jobs\b[\s\S]*?;/,
    'the job-completing UPDATE statement'
  );
  assert.match(jobWrite, /state\s*=\s*'succeeded'/);
  assert.match(jobWrite, /where[\s\S]*id\s*=\s*p_job_id/);
  assert.match(jobWrite, /swing_id\s*=\s*p_swing_id/);
  assert.match(jobWrite, /user_id\s*=\s*v_swing\.user_id/);
  assert.match(jobWrite, /state\s*=\s*'running'/);
  assert.match(jobWrite, /lease_token\s*=\s*p_lease_token/);
});

test('complete_swing_analysis_job writes the job to succeeded, clears the lease, and sets finished_at', () => {
  assert.match(completeSection, /state\s*=\s*'succeeded'/);
  assert.match(completeSection, /lease_token\s*=\s*null/);
  assert.match(completeSection, /lease_expires_at\s*=\s*null/);
  assert.match(completeSection, /finished_at\s*=\s*v_now/);
});

test('complete_swing_analysis_job returns a row scoped by both ids and succeeded state', () => {
  const returnStatement = extractStatement(completeSection, /return query[\s\S]*?;/, 'the RETURN QUERY statement');
  assert.match(returnStatement, /id\s*=\s*p_job_id/);
  assert.match(returnStatement, /swing_id\s*=\s*p_swing_id/);
  assert.match(returnStatement, /state\s*=\s*'succeeded'/);
});

test('complete_swing_analysis_job revokes from PUBLIC/anon/authenticated and grants only to service_role', () => {
  assert.match(
    completeSection,
    /revoke execute on function public\.complete_swing_analysis_job\([^)]*\) from public;/
  );
  assert.match(
    completeSection,
    /revoke execute on function public\.complete_swing_analysis_job\([^)]*\) from anon;/
  );
  assert.match(
    completeSection,
    /revoke execute on function public\.complete_swing_analysis_job\([^)]*\) from authenticated;/
  );
  assert.match(
    completeSection,
    /grant execute on function public\.complete_swing_analysis_job\([^)]*\) to service_role;/
  );
});

// --- C. fail_swing_analysis_job ---

test('fail_swing_analysis_job preserves its existing four-argument signature', () => {
  const signature = extractSignature(failSection, 'fail_swing_analysis_job');
  assert.match(signature, /p_job_id\s+uuid/);
  assert.match(signature, /p_swing_id\s+uuid/);
  assert.match(signature, /p_lease_token\s+uuid/);
  assert.match(signature, /p_error_code\s+text/);
  assert.match(failSection, /returns setof public\.swing_analysis_jobs/);
});

test('fail_swing_analysis_job is SECURITY INVOKER with an empty search_path', () => {
  assert.match(failSection, /security invoker/i);
  assert.match(failSection, /set search_path = ''/);
  assert.doesNotMatch(failSection, /security definer/i);
});

test('fail_swing_analysis_job validates the existing error-code pattern', () => {
  assert.match(failSection, /p_error_code !~ '\^\[a-z0-9_\]\{1,64\}\$'/);
});

test('fail_swing_analysis_job locks the swing row before the job row', () => {
  const swingLockIndex = failSection.search(/from public\.swings[\s\S]*?for update/);
  const jobLockIndex = failSection.search(/from public\.swing_analysis_jobs[\s\S]*?for update/);
  assert.ok(swingLockIndex >= 0, 'expected a swing row lock');
  assert.ok(jobLockIndex >= 0, 'expected a job row lock');
  assert.ok(swingLockIndex < jobLockIndex, 'expected swing to be locked before the job');
});

test('fail_swing_analysis_job guards running state and the exact lease token', () => {
  assert.match(failSection, /state\s*=\s*'running'/);
  assert.match(failSection, /lease_token\s*=\s*p_lease_token/);
});

test('fail_swing_analysis_job ties job ownership to the locked swing via user_id', () => {
  assert.match(failSection, /and\s+user_id\s*=\s*v_swing\.user_id/);
});

test('fail_swing_analysis_job allows PROCESSING or already-ERROR, and never allows COMPLETE to be overwritten', () => {
  assert.match(
    failSection,
    /v_swing\.status <> 'PROCESSING' and v_swing\.status <> 'ERROR'/
  );
  assert.doesNotMatch(failSection, /'COMPLETE'/);
});

test('fail_swing_analysis_job swing UPDATE writes ERROR and re-guards on PROCESSING with derived ownership', () => {
  const swingWrite = extractStatement(
    failSection,
    /update public\.swings\b[\s\S]*?;/,
    'the swing-failing UPDATE statement'
  );
  assert.match(swingWrite, /set status = 'ERROR'/);
  assert.match(swingWrite, /where[\s\S]*id\s*=\s*p_swing_id/);
  assert.match(swingWrite, /user_id\s*=\s*v_job\.user_id/);
  assert.match(swingWrite, /status\s*=\s*'PROCESSING'/);
});

test('fail_swing_analysis_job job UPDATE repeats both ids, derived user_id, running state, and the exact lease token', () => {
  const jobWrite = extractStatement(
    failSection,
    /update public\.swing_analysis_jobs\b[\s\S]*?;/,
    'the job-failing UPDATE statement'
  );
  assert.match(jobWrite, /state\s*=\s*'failed'/);
  assert.match(jobWrite, /where[\s\S]*id\s*=\s*p_job_id/);
  assert.match(jobWrite, /swing_id\s*=\s*p_swing_id/);
  assert.match(jobWrite, /user_id\s*=\s*v_swing\.user_id/);
  assert.match(jobWrite, /state\s*=\s*'running'/);
  assert.match(jobWrite, /lease_token\s*=\s*p_lease_token/);
});

test('fail_swing_analysis_job writes the job to failed, clears the lease, and sets finished_at', () => {
  assert.match(failSection, /state\s*=\s*'failed'/);
  assert.match(failSection, /lease_token\s*=\s*null/);
  assert.match(failSection, /lease_expires_at\s*=\s*null/);
  assert.match(failSection, /finished_at\s*=\s*v_now/);
});

test('fail_swing_analysis_job returns a row scoped by both ids and failed state', () => {
  const returnStatement = extractStatement(failSection, /return query[\s\S]*?;/, 'the RETURN QUERY statement');
  assert.match(returnStatement, /id\s*=\s*p_job_id/);
  assert.match(returnStatement, /swing_id\s*=\s*p_swing_id/);
  assert.match(returnStatement, /state\s*=\s*'failed'/);
});

test('fail_swing_analysis_job revokes from PUBLIC/anon/authenticated and grants only to service_role', () => {
  assert.match(failSection, /revoke execute on function public\.fail_swing_analysis_job\([^)]*\) from public;/);
  assert.match(failSection, /revoke execute on function public\.fail_swing_analysis_job\([^)]*\) from anon;/);
  assert.match(
    failSection,
    /revoke execute on function public\.fail_swing_analysis_job\([^)]*\) from authenticated;/
  );
  assert.match(
    failSection,
    /grant execute on function public\.fail_swing_analysis_job\([^)]*\) to service_role;/
  );
});

// --- D. General ---

test('all table references in the migration are schema-qualified', () => {
  assert.doesNotMatch(sql, /(?<!public\.)\bfrom swings\b/i);
  assert.doesNotMatch(sql, /(?<!public\.)\bfrom swing_analysis_jobs\b/i);
  assert.doesNotMatch(sql, /(?<!public\.)\bupdate swings\b/i);
  assert.doesNotMatch(sql, /(?<!public\.)\bupdate swing_analysis_jobs\b/i);
});

test('no SECURITY DEFINER appears anywhere in the migration', () => {
  assert.doesNotMatch(sql, /security definer/i);
});

test('no grant to anon or authenticated appears anywhere in the migration', () => {
  assert.doesNotMatch(sql, /grant execute[^;]*to anon/i);
  assert.doesNotMatch(sql, /grant execute[^;]*to authenticated/i);
});

test('no client-supplied user id parameter is added to any function', () => {
  for (const section of [claimSection, completeSection, failSection]) {
    assert.doesNotMatch(section, /p_user_id/);
    assert.doesNotMatch(section, /p_expected_user_id/);
  }
});

test('no service key, token, URL, or secret is embedded in the migration', () => {
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /service_role_key/i);
  assert.doesNotMatch(sql, /supabase_service/i);
  assert.doesNotMatch(sql, /anon_key/i);
});

test('ordinary built-in function calls are schema-qualified via pg_catalog', () => {
  assert.match(sql, /pg_catalog\.clock_timestamp\(\)/);
  assert.match(sql, /pg_catalog\.gen_random_uuid\(\)/);
  assert.match(sql, /pg_catalog\.make_interval\(/);
  assert.match(sql, /pg_catalog\.lower\(/);
  assert.match(sql, /pg_catalog\.btrim\(/);
  assert.match(sql, /pg_catalog\.jsonb_typeof\(/);

  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\bclock_timestamp\(/);
  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\bgen_random_uuid\(/);
  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\bmake_interval\(/);
  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\blower\(/);
  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\btrim\(/);
  assert.doesNotMatch(sql, /(?<!pg_catalog\.)\bjsonb_typeof\(/);
});
