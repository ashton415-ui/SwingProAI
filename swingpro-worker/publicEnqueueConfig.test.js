import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicEnqueueConfig } from './publicEnqueueConfig.js';

function validEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
    GCP_PROJECT_ID: 'proj-1',
    CLOUD_TASKS_LOCATION: 'us-central1',
    CLOUD_TASKS_QUEUE_ID: 'swing-analysis',
    SWING_ANALYSIS_HANDLER_URL: 'https://worker.example.com/tasks/swing-analysis',
    CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
    SWING_ANALYSIS_HANDLER_AUDIENCE: 'https://worker.example.com',
    ...overrides,
  };
}

test('valid configuration returns ok:true with the expected shape', () => {
  const result = loadPublicEnqueueConfig(validEnv());
  assert.equal(result.ok, true);
  assert.equal(result.supabaseUrl, 'https://project.supabase.co');
  assert.equal(result.supabaseServiceRoleKey, 'service-role-secret-value');
  assert.equal(result.port, 3000);
  assert.deepEqual(result.queueConfig, {
    projectId: 'proj-1',
    location: 'us-central1',
    queueId: 'swing-analysis',
    handlerUrl: 'https://worker.example.com/tasks/swing-analysis',
    serviceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
    audience: 'https://worker.example.com',
  });
});

test('PORT defaults to 3000 when absent', () => {
  const env = validEnv();
  delete env.PORT;
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, true);
  assert.equal(result.port, 3000);
});

test('missing required variables are reported by name', () => {
  const env = validEnv();
  delete env.SUPABASE_URL;
  delete env.GCP_PROJECT_ID;
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('SUPABASE_URL'));
  assert.ok(result.missing.includes('GCP_PROJECT_ID'));
});

test('empty required variables are reported as invalid', () => {
  const env = validEnv({ SUPABASE_URL: '' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
  assert.equal(result.missing.includes('SUPABASE_URL'), false);
});

test('whitespace-only required variables are reported as invalid', () => {
  const env = validEnv({ CLOUD_TASKS_LOCATION: '   ' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('CLOUD_TASKS_LOCATION'));
});

test('HTTP handler URL is rejected', () => {
  const env = validEnv({ SWING_ANALYSIS_HANDLER_URL: 'http://worker.example.com/tasks/swing-analysis' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SWING_ANALYSIS_HANDLER_URL'));
});

test('HTTP audience is rejected', () => {
  const env = validEnv({ SWING_ANALYSIS_HANDLER_AUDIENCE: 'http://worker.example.com' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SWING_ANALYSIS_HANDLER_AUDIENCE'));
});

test('embedded URL username is rejected', () => {
  const env = validEnv({ SWING_ANALYSIS_HANDLER_URL: 'https://user@worker.example.com/tasks/swing-analysis' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SWING_ANALYSIS_HANDLER_URL'));
});

test('embedded URL password is rejected', () => {
  const env = validEnv({ SWING_ANALYSIS_HANDLER_AUDIENCE: 'https://user:pass@worker.example.com' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SWING_ANALYSIS_HANDLER_AUDIENCE'));
});

test('malformed URL is rejected', () => {
  const env = validEnv({ SWING_ANALYSIS_HANDLER_URL: 'not a url' });
  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SWING_ANALYSIS_HANDLER_URL'));
});

test('noninteger port is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '3000.5' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('nonnumeric port is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: 'abc' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('zero port is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '0' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('negative port is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '-1' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('whitespace-only port is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '   ' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('port 65536 is rejected', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '65536' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('boundary port 1 is accepted', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '1' }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 1);
});

test('boundary port 65535 is accepted', () => {
  const result = loadPublicEnqueueConfig(validEnv({ PORT: '65535' }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 65535);
});

test('failure result contains only variable names, never supplied values', () => {
  const env = validEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-value',
    SWING_ANALYSIS_HANDLER_URL: 'http://insecure.example.com',
    PORT: 'not-a-port',
  });
  delete env.GCP_PROJECT_ID;

  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-service-role-value'), false);
  assert.equal(serialized.includes('insecure.example.com'), false);
  assert.equal(serialized.includes('not-a-port'), false);

  for (const name of result.missing) assert.equal(typeof name, 'string');
  for (const name of result.invalid) assert.equal(typeof name, 'string');
});

test('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is not accepted as a substitute', () => {
  const env = validEnv();
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret-value';

  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('NEXT_PUBLIC queue/config values are not accepted as substitutes', () => {
  const env = validEnv();
  delete env.GCP_PROJECT_ID;
  delete env.SWING_ANALYSIS_HANDLER_URL;
  env.NEXT_PUBLIC_GCP_PROJECT_ID = 'proj-1';
  env.NEXT_PUBLIC_SWING_ANALYSIS_HANDLER_URL = 'https://worker.example.com/tasks/swing-analysis';

  const result = loadPublicEnqueueConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('GCP_PROJECT_ID'));
  assert.ok(result.missing.includes('SWING_ANALYSIS_HANDLER_URL'));
});
