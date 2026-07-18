import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPrivateTaskConfig } from './privateTaskConfig.js';

const REQUIRED_VAR_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'ANALYSIS_JOB_LEASE_SECONDS',
];

function validEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
    GEMINI_API_KEY: 'gemini-secret-key-value',
    ANALYSIS_JOB_LEASE_SECONDS: '300',
    ...overrides,
  };
}

// ============================ valid configuration ============================

test('valid configuration returns ok:true with the expected shape', () => {
  const result = loadPrivateTaskConfig(validEnv());
  assert.equal(result.ok, true);
  assert.equal(result.supabaseUrl, 'https://project.supabase.co');
  assert.equal(result.supabaseServiceRoleKey, 'service-role-secret-value');
  assert.equal(result.geminiApiKey, 'gemini-secret-key-value');
  assert.equal(result.leaseSeconds, 300);
  assert.equal(result.port, 3000);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['geminiApiKey', 'leaseSeconds', 'ok', 'port', 'supabaseServiceRoleKey', 'supabaseUrl'].sort()
  );
});

test('whitespace around required values is trimmed', () => {
  const result = loadPrivateTaskConfig(validEnv({
    SUPABASE_URL: '  https://project.supabase.co  ',
    SUPABASE_SERVICE_ROLE_KEY: '  service-role-secret-value  ',
    GEMINI_API_KEY: '  gemini-secret-key-value  ',
    ANALYSIS_JOB_LEASE_SECONDS: '  300  ',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.supabaseUrl, 'https://project.supabase.co');
  assert.equal(result.supabaseServiceRoleKey, 'service-role-secret-value');
  assert.equal(result.geminiApiKey, 'gemini-secret-key-value');
  assert.equal(result.leaseSeconds, 300);
});

// ================================== port ==================================

test('PORT defaults to 3000 when absent', () => {
  const result = loadPrivateTaskConfig(validEnv());
  assert.equal(result.ok, true);
  assert.equal(result.port, 3000);
});

test('explicit valid port is respected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '4321' }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 4321);
});

test('malformed port is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: 'abc' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('signed port is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '+3000' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('decimal port is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '3000.5' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('port below 1 is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '0' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('port above 65535 is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '65536' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('PORT'));
});

test('boundary port 1 is accepted', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '1' }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 1);
});

test('boundary port 65535 is accepted', () => {
  const result = loadPrivateTaskConfig(validEnv({ PORT: '65535' }));
  assert.equal(result.ok, true);
  assert.equal(result.port, 65535);
});

// ============================= lease seconds =============================

test('lease boundary 30 is accepted', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '30' }));
  assert.equal(result.ok, true);
  assert.equal(result.leaseSeconds, 30);
});

test('lease boundary 3600 is accepted', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '3600' }));
  assert.equal(result.ok, true);
  assert.equal(result.leaseSeconds, 3600);
});

test('signed lease is rejected', () => {
  for (const value of ['+300', '-300']) {
    const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: value }));
    assert.equal(result.ok, false, `expected rejection for ${value}`);
    assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
  }
});

test('decimal lease is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '300.5' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
});

test('exponent lease is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '3e2' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
});

test('lease below 30 is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '29' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
});

test('lease above 3600 is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '3601' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
});

test('zero lease is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ ANALYSIS_JOB_LEASE_SECONDS: '0' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('ANALYSIS_JOB_LEASE_SECONDS'));
});

// ============================== Supabase URL ==============================

test('HTTP Supabase URL is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: 'http://project.supabase.co' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

test('malformed Supabase URL is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: 'not a url' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

test('relative Supabase URL is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: '/relative/path' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

test('Supabase URL with a username is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: 'https://user@project.supabase.co' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

test('Supabase URL with a password is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: 'https://user:pass@project.supabase.co' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

test('Supabase URL with a fragment is rejected', () => {
  const result = loadPrivateTaskConfig(validEnv({ SUPABASE_URL: 'https://project.supabase.co/#frag' }));
  assert.equal(result.ok, false);
  assert.ok(result.invalid.includes('SUPABASE_URL'));
});

// ========================= missing / empty / whitespace =========================

for (const varName of REQUIRED_VAR_NAMES) {
  test(`missing ${varName} is reported individually`, () => {
    const env = validEnv();
    delete env[varName];
    const result = loadPrivateTaskConfig(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [varName]);
    assert.equal(result.invalid.length, 0);
  });
}

test('all required variables missing are all reported, in deterministic order', () => {
  const result = loadPrivateTaskConfig({});
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, REQUIRED_VAR_NAMES);
});

for (const varName of REQUIRED_VAR_NAMES) {
  test(`empty string ${varName} is classified invalid, not missing`, () => {
    const env = validEnv({ [varName]: '' });
    const result = loadPrivateTaskConfig(env);
    assert.equal(result.ok, false);
    assert.ok(result.invalid.includes(varName));
    assert.equal(result.missing.includes(varName), false);
  });

  test(`whitespace-only ${varName} is invalid`, () => {
    const env = validEnv({ [varName]: '   ' });
    const result = loadPrivateTaskConfig(env);
    assert.equal(result.ok, false);
    assert.ok(result.invalid.includes(varName));
    assert.equal(result.missing.includes(varName), false);
  });
}

// ============================== secrecy / safety ==============================

test('failure result never contains supplied secret values', () => {
  const env = validEnv({
    SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-role-value',
    GEMINI_API_KEY: 'super-secret-gemini-value',
    ANALYSIS_JOB_LEASE_SECONDS: 'not-a-number',
  });
  delete env.SUPABASE_URL;

  const result = loadPrivateTaskConfig(env);
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('super-secret-service-role-value'), false);
  assert.equal(serialized.includes('super-secret-gemini-value'), false);
  assert.equal(serialized.includes('not-a-number'), false);
  for (const name of result.missing) assert.equal(typeof name, 'string');
  for (const name of result.invalid) assert.equal(typeof name, 'string');
});

test('NEXT_PUBLIC and alternate secret names are never accepted as substitutes', () => {
  const env = validEnv();
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  env.SUPABASE_ANON_KEY = 'anon-key-2';

  const result = loadPrivateTaskConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('SUPABASE_URL'));
  assert.ok(result.missing.includes('SUPABASE_SERVICE_ROLE_KEY'));
});

test('input object is not mutated', () => {
  const env = validEnv();
  const snapshot = { ...env };
  loadPrivateTaskConfig(env);
  assert.deepEqual(env, snapshot);
});

test('loader does not read process.env', () => {
  const trackedNames = REQUIRED_VAR_NAMES;
  const originalValues = {};
  for (const name of trackedNames) {
    originalValues[name] = process.env[name];
    process.env[name] = name === 'ANALYSIS_JOB_LEASE_SECONDS' ? '300' : 'https://leaked-from-process-env.example.com';
  }
  try {
    const result = loadPrivateTaskConfig({});
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing.slice().sort(), trackedNames.slice().sort());
  } finally {
    for (const name of trackedNames) {
      if (originalValues[name] === undefined) delete process.env[name];
      else process.env[name] = originalValues[name];
    }
  }
});

// ===================== static isolation: forbidden tokens =====================

test('privateTaskConfig.js source contains no process.env, client construction, listen, NEXT_PUBLIC, or console logging', () => {
  const sourcePath = fileURLToPath(new URL('./privateTaskConfig.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');
  const forbiddenTokens = [
    'process.env',
    'createClient(',
    'app.listen(',
    'NEXT_PUBLIC_',
    'console.log',
    'console.error',
  ];
  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `privateTaskConfig.js must not contain "${token}"`);
  }
});
