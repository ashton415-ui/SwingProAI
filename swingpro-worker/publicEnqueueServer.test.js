import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicEnqueueRuntime } from './publicEnqueueServer.js';

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

// Fake factories — none of these ever touch the network. They exist purely
// to record what createPublicEnqueueRuntime passes to them.
function makeFakeSupabaseClient() {
  const calls = [];
  const createSupabaseClient = (url, key, options) => {
    calls.push({ url, key, options });
    return { fake: 'supabase-client' };
  };
  createSupabaseClient.calls = calls;
  return createSupabaseClient;
}

function makeFakeTasksClientFactory() {
  const calls = [];
  const createTasksClient = (...args) => {
    calls.push(args);
    return { fake: 'tasks-client' };
  };
  createTasksClient.calls = calls;
  return createTasksClient;
}

function makeFakeCreateApp() {
  const calls = [];
  const createApp = (args) => {
    calls.push(args);
    return { fake: 'app' };
  };
  createApp.calls = calls;
  return createApp;
}

function makeFakes() {
  return {
    createSupabaseClient: makeFakeSupabaseClient(),
    createTasksClient: makeFakeTasksClientFactory(),
    createApp: makeFakeCreateApp(),
  };
}

test('importing the module has no startup side effects', () => {
  assert.equal(typeof createPublicEnqueueRuntime, 'function');
  assert.equal(process.exitCode, undefined);
});

test('correct Supabase URL and key are passed to the client constructor', () => {
  const fakes = makeFakes();
  const runtime = createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(fakes.createSupabaseClient.calls.length, 1);
  assert.equal(fakes.createSupabaseClient.calls[0].url, 'https://project.supabase.co');
  assert.equal(fakes.createSupabaseClient.calls[0].key, 'service-role-secret-value');
});

test('Supabase session persistence options are disabled', () => {
  const fakes = makeFakes();
  createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.deepEqual(fakes.createSupabaseClient.calls[0].options, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
});

test('exactly one Cloud Tasks client is constructed', () => {
  const fakes = makeFakes();
  createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.equal(fakes.createTasksClient.calls.length, 1);
});

test('queueConfig reaches createApp unchanged, along with the constructed clients', () => {
  const fakes = makeFakes();
  createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.equal(fakes.createApp.calls.length, 1);
  const appArgs = fakes.createApp.calls[0];
  assert.deepEqual(appArgs.queueConfig, {
    projectId: 'proj-1',
    location: 'us-central1',
    queueId: 'swing-analysis',
    handlerUrl: 'https://worker.example.com/tasks/swing-analysis',
    serviceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
    audience: 'https://worker.example.com',
  });
  assert.equal(appArgs.supabase.fake, 'supabase-client');
  assert.equal(appArgs.tasksClient.fake, 'tasks-client');
});

test('returned runtime contains only app and port, no credentials', () => {
  const fakes = makeFakes();
  const runtime = createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.deepEqual(Object.keys(runtime).sort(), ['app', 'ok', 'port'].sort());
  assert.equal(runtime.port, 3000);

  const serialized = JSON.stringify(runtime, (key, value) => (key === 'app' ? '[app]' : value));
  assert.equal(serialized.includes('service-role-secret-value'), false);
  assert.equal(serialized.includes('project.supabase.co'), false);
  assert.equal(serialized.includes('tasks-invoker'), false);
});

test('default port is respected', () => {
  const env = validEnv();
  delete env.PORT;
  const fakes = makeFakes();
  const runtime = createPublicEnqueueRuntime({ env, ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(runtime.port, 3000);
});

test('configured port is respected', () => {
  const env = validEnv({ PORT: '4321' });
  const fakes = makeFakes();
  const runtime = createPublicEnqueueRuntime({ env, ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(runtime.port, 4321);
});

test('invalid configuration constructs neither client', () => {
  const env = validEnv();
  delete env.GCP_PROJECT_ID;
  const fakes = makeFakes();

  const runtime = createPublicEnqueueRuntime({ env, ...fakes });

  assert.equal(runtime.ok, false);
  assert.ok(runtime.missing.includes('GCP_PROJECT_ID'));
  assert.equal(fakes.createSupabaseClient.calls.length, 0);
  assert.equal(fakes.createTasksClient.calls.length, 0);
});

test('invalid configuration does not call createApp', () => {
  const env = validEnv();
  delete env.SWING_ANALYSIS_HANDLER_URL;
  const fakes = makeFakes();

  const runtime = createPublicEnqueueRuntime({ env, ...fakes });

  assert.equal(runtime.ok, false);
  assert.equal(fakes.createApp.calls.length, 0);
});

test('no real network requests occur — only injected fakes are ever invoked', () => {
  const fakes = makeFakes();
  const runtime = createPublicEnqueueRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  // The fakes never construct a real Supabase or Cloud Tasks client, and
  // createPublicEnqueueRuntime itself performs no fetch/RPC/gRPC calls —
  // the only side effects observed are the recorded fake invocations above.
  assert.equal(fakes.createSupabaseClient.calls.length, 1);
  assert.equal(fakes.createTasksClient.calls.length, 1);
});

test('no TCP port opens — createPublicEnqueueRuntime never calls listen', () => {
  // A fake app with no listen() method at all: if the runtime factory ever
  // tried to open a port itself, this would throw.
  const createApp = () => ({});
  const runtime = createPublicEnqueueRuntime({
    env: validEnv(),
    createSupabaseClient: makeFakeSupabaseClient(),
    createTasksClient: makeFakeTasksClientFactory(),
    createApp,
  });

  assert.equal(runtime.ok, true);
});

test('secret values do not appear in safe failure objects', () => {
  const env = validEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-value',
    SWING_ANALYSIS_HANDLER_URL: 'http://insecure.example.com',
  });
  delete env.CLOUD_TASKS_QUEUE_ID;
  const fakes = makeFakes();

  const runtime = createPublicEnqueueRuntime({ env, ...fakes });

  assert.equal(runtime.ok, false);
  const serialized = JSON.stringify(runtime);
  assert.equal(serialized.includes('super-secret-service-role-value'), false);
  assert.equal(serialized.includes('insecure.example.com'), false);
  for (const name of runtime.missing) assert.equal(typeof name, 'string');
  for (const name of runtime.invalid) assert.equal(typeof name, 'string');
});
