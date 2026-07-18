import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrivateTaskRuntime } from './privateTaskServer.js';

function validEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
    GEMINI_API_KEY: 'gemini-secret-key-value',
    ANALYSIS_JOB_LEASE_SECONDS: '300',
    ...overrides,
  };
}

// Fake factories — none of these ever touch the network, a real Supabase
// client, or a real Express app. They exist purely to record what
// createPrivateTaskRuntime passes to them and to let each test control the
// returned shape.
function makeFakeSupabaseClient(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl ? impl(...args) : { fake: 'supabase-client' };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeAnalyzer(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl ? impl(...args) : async () => {};
  };
  fn.calls = calls;
  return fn;
}

function makeFakeApp(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl ? impl(...args) : { listen: () => {}, fake: 'app' };
  };
  fn.calls = calls;
  return fn;
}

function makeFakes(overrides = {}) {
  return {
    createSupabaseClient: makeFakeSupabaseClient(),
    createAnalyzer: makeFakeAnalyzer(),
    createApp: makeFakeApp(),
    ...overrides,
  };
}

// ===================== A. Import isolation =====================

test('importing privateTaskServer.js triggers no listen, client construction, app construction, or exit', () => {
  assert.equal(typeof createPrivateTaskRuntime, 'function');
  assert.equal(process.exitCode, undefined);
});

// ===================== B. Invalid configuration =====================

test('invalid config returns exact safe failure shape', () => {
  const env = validEnv();
  delete env.GEMINI_API_KEY;
  const fakes = makeFakes();
  const runtime = createPrivateTaskRuntime({ env, ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(Object.keys(runtime).sort(), ['invalid', 'missing', 'ok'].sort());
  assert.deepEqual(runtime.missing, ['GEMINI_API_KEY']);
  assert.deepEqual(runtime.invalid, []);
});

test('invalid configuration does not call any dependency factory', () => {
  const env = validEnv();
  delete env.SUPABASE_URL;
  const fakes = makeFakes();
  createPrivateTaskRuntime({ env, ...fakes });

  assert.equal(fakes.createSupabaseClient.calls.length, 0);
  assert.equal(fakes.createAnalyzer.calls.length, 0);
  assert.equal(fakes.createApp.calls.length, 0);
});

test('supplied secrets are absent from serialized invalid-config failure results', () => {
  const env = validEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-value',
    ANALYSIS_JOB_LEASE_SECONDS: 'bogus',
  });
  delete env.GEMINI_API_KEY;
  const fakes = makeFakes();
  const runtime = createPrivateTaskRuntime({ env, ...fakes });

  const serialized = JSON.stringify(runtime);
  assert.equal(serialized.includes('super-secret-service-role-value'), false);
  assert.equal(serialized.includes('bogus'), false);
});

// ===================== C. Supabase client creation =====================

test('Supabase client is constructed with the exact URL, key, and auth options, exactly once', () => {
  const fakes = makeFakes();
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(fakes.createSupabaseClient.calls.length, 1);
  const [url, key, options] = fakes.createSupabaseClient.calls[0];
  assert.equal(url, 'https://project.supabase.co');
  assert.equal(key, 'service-role-secret-value');
  assert.deepEqual(options, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
});

// ===================== D. Analyzer creation =====================

test('analyzer factory receives the exact Supabase client reference and Gemini key, exactly once', () => {
  const fakeSupabaseClient = { fake: 'supabase-client' };
  const fakes = makeFakes({
    createSupabaseClient: makeFakeSupabaseClient(() => fakeSupabaseClient),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(fakes.createAnalyzer.calls.length, 1);
  const [args] = fakes.createAnalyzer.calls[0];
  assert.equal(args.supabase, fakeSupabaseClient);
  assert.equal(args.geminiApiKey, 'gemini-secret-key-value');
});

test('the returned analyzer reference is passed unchanged to createApp', () => {
  const fakeAnalyzer = async () => {};
  const fakes = makeFakes({
    createAnalyzer: makeFakeAnalyzer(() => fakeAnalyzer),
  });
  createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  const [appArgs] = fakes.createApp.calls[0];
  assert.equal(appArgs.analyzeSwing, fakeAnalyzer);
});

// ===================== E. App creation =====================

test('app factory receives the exact Supabase reference, analyzer reference, and numeric leaseSeconds, exactly once', () => {
  const fakeSupabaseClient = { fake: 'supabase-client' };
  const fakeAnalyzer = async () => {};
  const fakes = makeFakes({
    createSupabaseClient: makeFakeSupabaseClient(() => fakeSupabaseClient),
    createAnalyzer: makeFakeAnalyzer(() => fakeAnalyzer),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '120' }), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(fakes.createApp.calls.length, 1);
  const [appArgs] = fakes.createApp.calls[0];
  assert.equal(appArgs.supabase, fakeSupabaseClient);
  assert.equal(appArgs.analyzeSwing, fakeAnalyzer);
  assert.equal(appArgs.leaseSeconds, 120);
});

test('successful runtime returns only ok, app, and port, with no secrets and no full config', () => {
  const fakes = makeFakes();
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  assert.deepEqual(Object.keys(runtime).sort(), ['app', 'ok', 'port'].sort());

  const serialized = JSON.stringify(runtime, (key, value) => (key === 'app' ? '[app]' : value));
  assert.equal(serialized.includes('service-role-secret-value'), false);
  assert.equal(serialized.includes('gemini-secret-key-value'), false);
  assert.equal(serialized.includes('project.supabase.co'), false);
});

test('a callable Express-style app (typeof "function") with a listen property is accepted, returned unchanged, and not listened on during construction', () => {
  let listenCalled = false;
  function fakeExpressApp() {}
  fakeExpressApp.listen = () => { listenCalled = true; };

  const fakes = makeFakes({
    createApp: makeFakeApp(() => fakeExpressApp),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv({ PORT: '4321' }), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(runtime.app, fakeExpressApp);
  assert.equal(runtime.port, 4321);
  assert.equal(listenCalled, false);
});

// ===================== F. Malformed dependencies =====================

test('createSupabaseClient throwing is contained as a generic runtime dependency failure', () => {
  const fakes = makeFakes({
    createSupabaseClient: () => { throw new Error('raw supabase client secret'); },
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.missing, []);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
  assert.equal(fakes.createAnalyzer.calls.length, 0);
  assert.equal(fakes.createApp.calls.length, 0);
});

test('createAnalyzer throwing is contained', () => {
  const fakes = makeFakes({
    createAnalyzer: () => { throw new Error('raw analyzer secret'); },
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
  assert.equal(fakes.createApp.calls.length, 0);
});

test('createAnalyzer returning a non-function is contained', () => {
  const fakes = makeFakes({
    createAnalyzer: makeFakeAnalyzer(() => ({ not: 'a function' })),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
  assert.equal(fakes.createApp.calls.length, 0);
});

test('createApp throwing is contained', () => {
  const fakes = makeFakes({
    createApp: () => { throw new Error('raw app secret'); },
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
});

test('createApp returning null is contained', () => {
  const fakes = makeFakes({
    createApp: makeFakeApp(() => null),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
});

test('createApp returning an object without listen is contained', () => {
  const fakes = makeFakes({
    createApp: makeFakeApp(() => ({ fake: 'app-no-listen' })),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, false);
  assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
});

test('a revoked proxy returned by createApp is contained rather than crashing', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const fakes = makeFakes({
    createApp: makeFakeApp(() => proxy),
  });

  assert.doesNotThrow(() => {
    const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });
    assert.equal(runtime.ok, false);
    assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
  });
});

test('a throwing listen getter on the returned app is contained rather than crashing', () => {
  const hostileApp = {};
  Object.defineProperty(hostileApp, 'listen', {
    get() { throw new Error('raw getter secret'); },
  });
  const fakes = makeFakes({
    createApp: makeFakeApp(() => hostileApp),
  });

  assert.doesNotThrow(() => {
    const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });
    assert.equal(runtime.ok, false);
    assert.deepEqual(runtime.invalid, ['RUNTIME_DEPENDENCY']);
  });
});

test('raw dependency errors never leak into the failure result', () => {
  const fakes = makeFakes({
    createApp: () => { throw new Error('TOP-SECRET-RAW-ERROR-TEXT'); },
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  const serialized = JSON.stringify(runtime);
  assert.equal(serialized.includes('TOP-SECRET-RAW-ERROR-TEXT'), false);
});

test('app construction does not happen after analyzer failure', () => {
  const fakes = makeFakes({
    createAnalyzer: makeFakeAnalyzer(() => null),
  });
  createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(fakes.createApp.calls.length, 0);
});

// ===================== G. No listen during construction =====================

test('createPrivateTaskRuntime never calls app.listen itself', () => {
  let listenCalled = false;
  const fakes = makeFakes({
    createApp: makeFakeApp(() => ({
      listen: () => { listenCalled = true; },
    })),
  });
  const runtime = createPrivateTaskRuntime({ env: validEnv(), ...fakes });

  assert.equal(runtime.ok, true);
  assert.equal(listenCalled, false);
});

// ===================== Static isolation =====================

test('the Supabase import uses the exact lowercase package path, since Windows may resolve case-insensitively where the case-sensitive Linux production runtime would not', () => {
  const sourcePath = fileURLToPath(new URL('./privateTaskServer.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');

  assert.ok(
    source.includes("from '@supabase/supabase-js'"),
    "privateTaskServer.js must import from the exact lowercase path '@supabase/supabase-js'"
  );
  assert.equal(source.includes('@Supabase/supabase-js'), false, 'privateTaskServer.js must not import the uppercase-S variant');
  assert.equal(source.includes('@SUPABASE/supabase-js'), false, 'privateTaskServer.js must not import the all-uppercase variant');
});

test('privateTaskServer.js does not import forbidden legacy modules, references the required dependencies, and never contains job-mutation or NEXT_PUBLIC tokens', () => {
  const sourcePath = fileURLToPath(new URL('./privateTaskServer.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');

  const forbiddenImportTokens = [
    "from './index.js'", 'from "./index.js"',
    "from './app.js'", 'from "./app.js"',
    "from './publicEnqueueServer.js'", 'from "./publicEnqueueServer.js"',
    "from './publicEnqueueApp.js'", 'from "./publicEnqueueApp.js"',
    "from './legacySwingAnalyzerAdapter.js'", 'from "./legacySwingAnalyzerAdapter.js"',
    "from './swingRepository.js'", 'from "./swingRepository.js"',
  ];
  for (const token of forbiddenImportTokens) {
    assert.equal(source.includes(token), false, `privateTaskServer.js must not import "${token}"`);
  }

  const requiredTokens = [
    'createPrivateTaskApp',
    'createProductionSwingAnalyzer',
    'loadPrivateTaskConfig',
    'createClient',
    'pathToFileURL',
    'dotenv/config',
  ];
  for (const token of requiredTokens) {
    assert.ok(source.includes(token), `privateTaskServer.js must reference "${token}"`);
  }

  const forbiddenBodyTokens = [
    'completeSwingAnalysis',
    'succeedAnalysisJob',
    'failAnalysisJob',
    'completeAnalysisJob',
    'claimAnalysisJobLease',
    'renewAnalysisJobLease',
    ".from('swings')",
    '.from("swings")',
    '.rpc(',
    'NEXT_PUBLIC_',
  ];
  for (const token of forbiddenBodyTokens) {
    assert.equal(source.includes(token), false, `privateTaskServer.js must not contain "${token}"`);
  }
});

test('package.json declares start:private without altering existing scripts', () => {
  const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.scripts['start:private'], 'node privateTaskServer.js');
  assert.equal(pkg.scripts.start, 'node index.js');
  assert.equal(pkg.scripts['start:enqueue'], 'node publicEnqueueServer.js');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('.env.example documents ANALYSIS_JOB_LEASE_SECONDS without a real secret value', () => {
  const envPath = fileURLToPath(new URL('./.env.example', import.meta.url));
  const source = readFileSync(envPath, 'utf8');

  assert.ok(source.includes('ANALYSIS_JOB_LEASE_SECONDS=300'));
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY=.+/.test(source), false);
  assert.equal(/GEMINI_API_KEY=.+/.test(source), false);
});
