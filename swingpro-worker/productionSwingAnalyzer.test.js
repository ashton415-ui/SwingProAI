import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProductionSwingAnalyzer, defaultAbortAwareSleep } from './productionSwingAnalyzer.js';

const SWING_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const STORAGE_PATH = `${USER_ID}/very/secret/swing123.mp4`;
const GEMINI_API_KEY = 'super-secret-gemini-key-XYZ';

const AI_ANALYSIS = {
  coaching_assessment: {
    score: 80,
    score_label: 'Birdie',
    ai_coach_assessment: 'Solid kinematic sequence.',
    pro_cue: 'Feel the lag.',
    weekly_priority_text: 'Work on hip clearance.',
  },
  equipment_insight: {
    shaft_flex_recommendation: 'Stiff',
    driver_config_recommendation: '9 degrees',
    ball_spec_recommendation: 'Low spin',
    insight_text: 'Great match for your tempo.',
  },
  estimated_metrics: { swing_speed: 95, ball_speed: 140, smash_factor: 1.47, tempo: '3:1' },
  breakdowns: [
    { component: 'Posture', score: 80, feedback: 'Good', pro_tip: 'Keep spine angle.' },
    { component: 'Takeaway', score: 75, feedback: 'Wide', pro_tip: 'Slow down.' },
    { component: 'Impact', score: 85, feedback: 'Clean', pro_tip: 'Stay centered.' },
  ],
  strengths: [{ title: 'Tempo', description: 'Consistent 3:1 ratio.' }],
  faults: [{ title: 'Early extension', description: 'Hips move toward ball.', drill: 'Wall drill.' }],
  pose_data: {
    11: { x: 0.30, y: 0.40, z: 0.10 },
    12: { x: 0.60, y: 0.41, z: -0.10 },
    23: { x: 0.35, y: 0.70, z: 0.05 },
    24: { x: 0.55, y: 0.71, z: -0.05 },
  },
};

function cloneAiAnalysis(overrides = {}) {
  return { ...JSON.parse(JSON.stringify(AI_ANALYSIS)), ...overrides };
}

function makeBlob(marker = 'video-blob') {
  return { __marker: marker, size: 1234 };
}

function makeSupabase({ downloadImpl } = {}) {
  const storageCalls = [];
  const tableCalls = [];
  return {
    storageCalls,
    tableCalls,
    storage: {
      from(bucket) {
        return {
          download(path, options, parameters) {
            storageCalls.push({ bucket, path, options, parameters });
            return downloadImpl
              ? downloadImpl({ bucket, path, options, parameters })
              : Promise.resolve({ data: makeBlob(), error: null });
          },
        };
      },
    },
    from(table) {
      tableCalls.push(table);
      throw new Error(`unexpected table access in production analyzer: ${table}`);
    },
  };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function badResponse(status, bodyText) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('must not parse json on a non-OK response'); },
    text: async () => bodyText,
  };
}

function malformedJsonResponse() {
  return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); }, text: async () => 'malformed' };
}

function defaultUpload() {
  return okJson({ file: { uri: 'https://generativelanguage.googleapis.com/files/abc123', name: 'files/abc123', state: 'ACTIVE' } });
}

function defaultGenerate() {
  return okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(cloneAiAnalysis()) }] } }] });
}

function makeFetch({ upload = defaultUpload, poll = () => okJson({ state: 'ACTIVE' }), generate = defaultGenerate } = {}) {
  const calls = [];
  let pollCallIndex = 0;
  const fn = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/upload/v1beta/files')) {
      return typeof upload === 'function' ? upload({ url, options }) : upload;
    }
    if (url.includes(':generateContent')) {
      return typeof generate === 'function' ? generate({ url, options }) : generate;
    }
    const responder = Array.isArray(poll) ? poll[pollCallIndex] : poll;
    pollCallIndex += 1;
    if (typeof responder === 'function') return responder({ url, options, index: pollCallIndex - 1 });
    return responder;
  };
  fn.calls = calls;
  return fn;
}

function makeSleepSpy(implFn) {
  const calls = [];
  const fn = async (ms, signal) => {
    calls.push({ ms, signal });
    if (implFn) return implFn(ms, signal);
  };
  fn.calls = calls;
  return fn;
}

function makeLogSpy() {
  const calls = [];
  const fn = (category, details) => {
    calls.push({ category, details });
  };
  fn.calls = calls;
  return fn;
}

function baseFactoryArgs(overrides = {}) {
  return {
    supabase: makeSupabase(),
    geminiApiKey: GEMINI_API_KEY,
    fetchImpl: makeFetch(),
    sleepImpl: makeSleepSpy(),
    logSafeImpl: makeLogSpy(),
    biometrics: {
      calcSpineAngle: () => 32.1,
      calcHipRotation: () => 41.5,
      calcShoulderRotation: () => 88.2,
    },
    ...overrides,
  };
}

function baseAnalyzeArgs(overrides = {}) {
  return {
    swingId: SWING_ID,
    storagePath: STORAGE_PATH,
    equipmentContext: { make: 'Titleist', model: 'TSi3', club_type: 'Driver', shaft_flex: 'Stiff', loft: 10.5 },
    slope: null,
    userId: USER_ID,
    signal: undefined,
    ...overrides,
  };
}

// ===================== A. Import / factory isolation =====================

test('importing the module performs no network operation', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('fetch must not be called at import time');
  };
  try {
    await import(`./productionSwingAnalyzer.js?probe=${Date.now()}-${Math.random()}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false);
});

test('constructing the factory performs no network, storage, or fetch call', () => {
  const supabase = makeSupabase();
  const fetchImpl = makeFetch();
  createProductionSwingAnalyzer(baseFactoryArgs({ supabase, fetchImpl }));
  assert.equal(supabase.storageCalls.length, 0);
  assert.equal(supabase.tableCalls.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('factory throws a generic configuration error when supabase is missing, without leaking geminiApiKey', () => {
  assert.throws(
    () => createProductionSwingAnalyzer(baseFactoryArgs({ supabase: undefined })),
    (err) => err instanceof Error && !err.message.includes(GEMINI_API_KEY)
  );
});

test('factory throws a generic configuration error when geminiApiKey is missing', () => {
  assert.throws(() => createProductionSwingAnalyzer(baseFactoryArgs({ geminiApiKey: undefined })));
});

test('factory throws a generic configuration error when geminiApiKey is empty', () => {
  assert.throws(() => createProductionSwingAnalyzer(baseFactoryArgs({ geminiApiKey: '' })));
});

test('factory throws when biometrics dependency is malformed', () => {
  assert.throws(() => createProductionSwingAnalyzer(baseFactoryArgs({ biometrics: { calcSpineAngle: 'nope' } })));
});

test('the factory returns the analyzer function directly, not a wrapper object', () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs());
  assert.equal(typeof analyzer, 'function');
});

// ============================ B. Storage ============================

test('storage download uses exact bucket and storagePath', async () => {
  const supabase = makeSupabase();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase }));
  await analyzer(baseAnalyzeArgs());
  assert.equal(supabase.storageCalls.length, 1);
  assert.equal(supabase.storageCalls[0].bucket, 'swing-videos');
  assert.equal(supabase.storageCalls[0].path, STORAGE_PATH);
});

test('storage download receives the supplied signal in fetch parameters position', async () => {
  const supabase = makeSupabase();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase }));
  const controller = new AbortController();
  await analyzer(baseAnalyzeArgs({ signal: controller.signal }));
  assert.deepEqual(supabase.storageCalls[0].options, {});
  assert.deepEqual(supabase.storageCalls[0].parameters, { signal: controller.signal });
});

test('storage download error rejects safely and never reaches Gemini', async () => {
  const supabase = makeSupabase({ downloadImpl: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase, fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
  assert.equal(fetchImpl.calls.length, 0);
});

test('missing Blob (no error, no data) rejects safely and never reaches Gemini', async () => {
  const supabase = makeSupabase({ downloadImpl: () => Promise.resolve({ data: null, error: null }) });
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase, fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
  assert.equal(fetchImpl.calls.length, 0);
});

test('already-aborted signal prevents storage download entirely', async () => {
  const supabase = makeSupabase();
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase, fetchImpl }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
  );
  assert.equal(supabase.storageCalls.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

// ============================= C. Upload =============================

test('upload request has exact structure and receives the signal', async () => {
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  const controller = new AbortController();
  await analyzer(baseAnalyzeArgs({ signal: controller.signal }));

  const uploadCall = fetchImpl.calls[0];
  assert.equal(uploadCall.url, `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${GEMINI_API_KEY}`);
  assert.equal(uploadCall.options.method, 'POST');
  assert.equal(uploadCall.options.headers['Content-Type'], 'video/mp4');
  assert.equal(uploadCall.options.headers['X-Goog-Upload-File-Name'], 'swing-analysis.mp4');
  assert.equal(uploadCall.options.signal, controller.signal);
});

test('non-OK upload response is sanitized and never leaks the raw body', async () => {
  const fetchImpl = makeFetch({ upload: () => badResponse(500, 'TOP-SECRET-UPLOAD-BODY') });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('TOP-SECRET-UPLOAD-BODY')
  );
});

test('missing upload file fields reject safely', async () => {
  const fetchImpl = makeFetch({ upload: () => okJson({ file: { uri: '', name: '', state: '' } }) });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
});

test('malformed upload response JSON rejects safely', async () => {
  const fetchImpl = makeFetch({ upload: () => malformedJsonResponse() });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
});

// ============================= D. Polling =============================

test('polling: PROCESSING then ACTIVE succeeds and calls sleepImpl with 2000ms and the signal', async () => {
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: [() => okJson({ state: 'ACTIVE' })],
  });
  const sleepImpl = makeSleepSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  const controller = new AbortController();
  const telemetry = await analyzer(baseAnalyzeArgs({ signal: controller.signal }));
  assert.ok(telemetry);
  assert.equal(sleepImpl.calls.length, 1);
  assert.equal(sleepImpl.calls[0].ms, 2000);
  assert.equal(sleepImpl.calls[0].signal, controller.signal);
});

test('polling stops after a maximum of 15 attempts and fails safely', async () => {
  const pollResponders = Array.from({ length: 20 }, () => () => okJson({ state: 'PROCESSING' }));
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: pollResponders,
  });
  const sleepImpl = makeSleepSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
  assert.equal(sleepImpl.calls.length, 15);
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 15);
});

test('non-OK poll response is sanitized', async () => {
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: () => badResponse(500, 'TOP-SECRET-POLL-BODY'),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('TOP-SECRET-POLL-BODY')
  );
});

test('malformed poll response JSON rejects safely', async () => {
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: () => malformedJsonResponse(),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
});

test('non-ACTIVE terminal state rejects safely', async () => {
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'FAILED' } }),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
});

test('abort before the polling wait stops the pipeline with no further fetch', async () => {
  const controller = new AbortController();
  const fetchImpl = makeFetch({
    upload: async () => {
      const res = okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } });
      controller.abort('secret-reason-before-wait');
      return res;
    },
  });
  const sleepImpl = makeSleepSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
  );
  assert.equal(sleepImpl.calls.length, 0);
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 0);
});

test('abort during the polling wait is thrown as a sanitized AbortError', async () => {
  const controller = new AbortController();
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
  });
  const sleepImpl = async () => {
    controller.abort('secret-reason-during-wait');
    const error = new Error('Analysis aborted');
    error.name = 'AbortError';
    throw error;
  };
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted' && !err.message.includes('secret-reason-during-wait')
  );
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 0);
});

test('abort before the next poll stops after exactly one poll fetch', async () => {
  const controller = new AbortController();
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: [
      async () => {
        const res = okJson({ state: 'PROCESSING' });
        controller.abort('secret-reason-next-poll');
        return res;
      },
    ],
  });
  const sleepImpl = makeSleepSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError'
  );
  assert.equal(sleepImpl.calls.length, 1);
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 1);
});

// ========================= E. Generate content =========================

test('generateContent request receives the signal and preserves endpoint/request structure', async () => {
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  const controller = new AbortController();
  await analyzer(baseAnalyzeArgs({ signal: controller.signal }));

  const generateCall = fetchImpl.calls.find((c) => c.url.includes(':generateContent'));
  assert.ok(generateCall);
  assert.equal(generateCall.url, `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`);
  assert.equal(generateCall.options.method, 'POST');
  assert.equal(generateCall.options.headers['Content-Type'], 'application/json');
  assert.equal(generateCall.options.signal, controller.signal);

  const body = JSON.parse(generateCall.options.body);
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].parts[1].fileData.fileUri, 'https://generativelanguage.googleapis.com/files/abc123');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema);
});

test('non-OK generateContent response is sanitized', async () => {
  const fetchImpl = makeFetch({ generate: () => badResponse(500, 'TOP-SECRET-GENERATE-BODY') });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('TOP-SECRET-GENERATE-BODY')
  );
});

test('malformed generateContent response hierarchy rejects safely', async () => {
  const fetchImpl = makeFetch({ generate: () => okJson({ candidates: [] }) });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(() => analyzer(baseAnalyzeArgs()));
});

test('invalid model JSON text rejects safely without leaking the raw text', async () => {
  const fetchImpl = makeFetch({
    generate: () => okJson({ candidates: [{ content: { parts: [{ text: 'MODEL-SECRET-OUTPUT not json' }] } }] }),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('MODEL-SECRET-OUTPUT')
  );
});

test('parsed analysis that is an array or missing required keys rejects safely', async () => {
  const arrayFetch = makeFetch({ generate: () => okJson({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) });
  const analyzer1 = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl: arrayFetch }));
  await assert.rejects(() => analyzer1(baseAnalyzeArgs()));

  const missingKeysFetch = makeFetch({ generate: () => okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify({ coaching_assessment: {} }) }] } }] }) });
  const analyzer2 = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl: missingKeysFetch }));
  await assert.rejects(() => analyzer2(baseAnalyzeArgs()));
});

// E2. Canonical source-shape validation matrix — each required top-level
// field is checked for missing / undefined / null / wrong-type rejection.
const OBJECT_SHAPE_FIELDS = ['coaching_assessment', 'equipment_insight', 'estimated_metrics', 'pose_data'];
const ARRAY_SHAPE_FIELDS = ['breakdowns', 'strengths', 'faults'];

function wrongShapeValueFor(field) {
  return OBJECT_SHAPE_FIELDS.includes(field) ? [] : {};
}

const SHAPE_VARIANTS = {
  missing: (analysis, field) => { delete analysis[field]; },
  undefined: (analysis, field) => { analysis[field] = undefined; },
  null: (analysis, field) => { analysis[field] = null; },
  'wrong top-level type': (analysis, field) => { analysis[field] = wrongShapeValueFor(field); },
};

for (const field of [...OBJECT_SHAPE_FIELDS, ...ARRAY_SHAPE_FIELDS]) {
  for (const [variantName, mutate] of Object.entries(SHAPE_VARIANTS)) {
    test(`Gemini analysis validation rejects ${field} when ${variantName}`, async () => {
      const analysis = cloneAiAnalysis();
      mutate(analysis, field);

      const biometricsCalls = [];
      const fetchImpl = makeFetch({
        generate: () => okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }] }),
      });
      const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({
        fetchImpl,
        biometrics: {
          calcSpineAngle: (...args) => { biometricsCalls.push(args); return 1; },
          calcHipRotation: () => 1,
          calcShoulderRotation: () => 1,
        },
      }));

      let telemetry;
      await assert.rejects(
        async () => { telemetry = await analyzer(baseAnalyzeArgs()); },
        (err) => err.message === 'Swing analysis failed'
      );
      assert.equal(telemetry, undefined);
      assert.equal(biometricsCalls.length, 0);
    });
  }
}

// ============================ F. Telemetry ============================

test('returned telemetry has exactly the canonical top-level keys', async () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs());
  const telemetry = await analyzer(baseAnalyzeArgs());
  assert.deepEqual(
    Object.keys(telemetry).sort(),
    ['breakdowns', 'coaching_assessment', 'equipment_insight', 'estimated_metrics', 'faults', 'raw_pose_data', 'spatial_slope', 'strengths'].sort()
  );
});

test('full-swing spatial_slope is null even when a slope value is supplied', async () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs());
  const telemetry = await analyzer(baseAnalyzeArgs({
    equipmentContext: { club_type: 'Driver' },
    slope: 4.2,
  }));
  assert.equal(telemetry.spatial_slope, null);
});

test('putting spatial_slope preserves the supplied slope', async () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs());
  const telemetry = await analyzer(baseAnalyzeArgs({
    equipmentContext: { club_type: 'Putter' },
    slope: 4.2,
  }));
  assert.equal(telemetry.spatial_slope, 4.2);
});

test('equipment context and slope are woven into the coach prompt sent to Gemini', async () => {
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await analyzer(baseAnalyzeArgs({
    equipmentContext: { make: 'Scotty Cameron', model: 'Newport', club_type: 'Putter', shaft_flex: null, loft: null },
    slope: 7.5,
  }));
  const generateCall = fetchImpl.calls.find((c) => c.url.includes(':generateContent'));
  const body = JSON.parse(generateCall.options.body);
  const promptText = body.contents[0].parts[0].text;
  assert.ok(promptText.includes('Scotty Cameron'));
  assert.ok(promptText.includes('Newport'));
  assert.ok(promptText.includes('7.5'));
  assert.ok(promptText.includes('putting'));
});

test('biometric values are added to estimated_metrics', async () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({
    biometrics: {
      calcSpineAngle: () => 33.3,
      calcHipRotation: () => 44.4,
      calcShoulderRotation: () => 55.5,
    },
  }));
  const telemetry = await analyzer(baseAnalyzeArgs());
  assert.equal(telemetry.estimated_metrics.spineAngle, 33.3);
  assert.equal(telemetry.estimated_metrics.hipRotation, 44.4);
  assert.equal(telemetry.estimated_metrics.shoulderTurn, 55.5);
});

test('a biometric-calculation exception logs pose_math_failed safely and still returns telemetry', async () => {
  const logSafeImpl = makeLogSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({
    logSafeImpl,
    biometrics: {
      calcSpineAngle: () => { throw new Error('raw pose crash with sensitive detail'); },
      calcHipRotation: () => 1,
      calcShoulderRotation: () => 1,
    },
  }));
  const telemetry = await analyzer(baseAnalyzeArgs());

  assert.ok(telemetry);
  assert.equal(telemetry.coaching_assessment.score, AI_ANALYSIS.coaching_assessment.score);
  assert.equal(telemetry.estimated_metrics.spineAngle, undefined);

  const poseFailureLogs = logSafeImpl.calls.filter((c) => c.category === 'pose_math_failed');
  assert.equal(poseFailureLogs.length, 1);
  assert.deepEqual(poseFailureLogs[0].details, { swingId: SWING_ID });
});

test('the production analyzer never touches the swings table (no finalization call)', async () => {
  const supabase = makeSupabase();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase }));
  await analyzer(baseAnalyzeArgs());
  assert.equal(supabase.tableCalls.length, 0);
});

// ============================== G. Safety ==============================

test('the Gemini API key never appears in a thrown error message', async () => {
  const fetchImpl = makeFetch({ upload: () => badResponse(500, `leaked ${GEMINI_API_KEY}`) });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes(GEMINI_API_KEY)
  );
});

test('the storagePath never appears in a thrown error message', async () => {
  const supabase = makeSupabase({ downloadImpl: () => Promise.resolve({ data: null, error: { message: 'db error' } }) });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes(STORAGE_PATH)
  );
});

test('a raw HTTP response body never appears in a thrown error message', async () => {
  const fetchImpl = makeFetch({ generate: () => badResponse(500, 'RAW-HTTP-BODY-SECRET') });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('RAW-HTTP-BODY-SECRET')
  );
});

test('raw model output never appears in a thrown error message', async () => {
  const fetchImpl = makeFetch({
    generate: () => okJson({ candidates: [{ content: { parts: [{ text: 'RAW-MODEL-OUTPUT-SECRET{{{' }] } }] }),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => !err.message.includes('RAW-MODEL-OUTPUT-SECRET')
  );
});

test('the abort reason never appears in the thrown AbortError message', async () => {
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs());
  const controller = new AbortController();
  controller.abort('SENSITIVE-ABORT-REASON');
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted' && !err.message.includes('SENSITIVE-ABORT-REASON')
  );
});

// ================ H. Abort precedence over external results ================

test('A. storage returning an error result after the signal is aborted still throws a sanitized AbortError, with no Gemini fetch', async () => {
  const controller = new AbortController();
  const supabase = makeSupabase({
    downloadImpl: async () => {
      controller.abort('secret-storage-abort-reason');
      return { data: null, error: { message: 'boom' } };
    },
  });
  const fetchImpl = makeFetch();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ supabase, fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted' && !err.message.includes('secret-storage-abort-reason')
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('B. the upload response json() aborting the signal rejects with a sanitized AbortError and issues no poll or generate request', async () => {
  const controller = new AbortController();
  const fetchImpl = makeFetch({
    upload: () => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort('secret-upload-json-abort-reason');
        throw new Error('raw-upload-json-secret');
      },
      text: async () => 'n/a',
    }),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
      && !err.message.includes('secret-upload-json-abort-reason') && !err.message.includes('raw-upload-json-secret')
  );
  const followUpCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files'));
  assert.equal(followUpCalls.length, 0);
});

test('C. a poll response json() aborting the signal rejects with a sanitized AbortError and issues no further poll or generate request', async () => {
  const controller = new AbortController();
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
    poll: [
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          controller.abort('secret-poll-json-abort-reason');
          throw new Error('raw-poll-json-secret');
        },
        text: async () => 'n/a',
      }),
    ],
  });
  const sleepImpl = makeSleepSpy();
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs({ signal: controller.signal })),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
      && !err.message.includes('secret-poll-json-abort-reason') && !err.message.includes('raw-poll-json-secret')
  );
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 1);
  const generateCalls = fetchImpl.calls.filter((c) => c.url.includes(':generateContent'));
  assert.equal(generateCalls.length, 0);
});

test('D. the generateContent response json() aborting the signal rejects with a sanitized AbortError, never runs biometrics, and returns no telemetry', async () => {
  const controller = new AbortController();
  const biometricsCalls = [];
  const fetchImpl = makeFetch({
    generate: () => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort('secret-generate-json-abort-reason');
        throw new Error('raw-generate-json-secret');
      },
      text: async () => 'n/a',
    }),
  });
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({
    fetchImpl,
    biometrics: {
      calcSpineAngle: (...args) => { biometricsCalls.push(args); return 1; },
      calcHipRotation: () => 1,
      calcShoulderRotation: () => 1,
    },
  }));
  let telemetry;
  await assert.rejects(
    async () => { telemetry = await analyzer(baseAnalyzeArgs({ signal: controller.signal })); },
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
      && !err.message.includes('secret-generate-json-abort-reason') && !err.message.includes('raw-generate-json-secret')
  );
  assert.equal(telemetry, undefined);
  assert.equal(biometricsCalls.length, 0);
});

test('E. a raw sleepImpl exception without an abort yields the generic analyzer error, hides the raw secret, and issues no poll fetch', async () => {
  const fetchImpl = makeFetch({
    upload: () => okJson({ file: { uri: 'https://files/x', name: 'files/x', state: 'PROCESSING' } }),
  });
  const sleepImpl = async () => { throw new Error('raw-secret-sleep-failure'); };
  const analyzer = createProductionSwingAnalyzer(baseFactoryArgs({ fetchImpl, sleepImpl }));
  await assert.rejects(
    () => analyzer(baseAnalyzeArgs()),
    (err) => err.message === 'Swing analysis failed' && !err.message.includes('raw-secret-sleep-failure')
  );
  const pollFetchCalls = fetchImpl.calls.filter((c) => !c.url.includes('/upload/v1beta/files') && !c.url.includes(':generateContent'));
  assert.equal(pollFetchCalls.length, 0);
});

// ====================== defaultAbortAwareSleep unit ======================

test('defaultAbortAwareSleep resolves after the delay and leaves no listener behind', async () => {
  const controller = new AbortController();
  await defaultAbortAwareSleep(5, controller.signal);
  // A no-op abort after resolution must not throw or affect anything, which
  // it would if a stale listener were still attached and mis-wired.
  assert.doesNotThrow(() => controller.abort());
});

test('defaultAbortAwareSleep rejects immediately when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => defaultAbortAwareSleep(50, controller.signal),
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted'
  );
});

test('defaultAbortAwareSleep rejects promptly when aborted during the wait', async () => {
  const controller = new AbortController();
  const promise = defaultAbortAwareSleep(10000, controller.signal);
  setTimeout(() => controller.abort('mid-wait-secret'), 5);
  await assert.rejects(
    () => promise,
    (err) => err.name === 'AbortError' && err.message === 'Analysis aborted' && !err.message.includes('mid-wait-secret')
  );
});

test('defaultAbortAwareSleep works with no signal supplied', async () => {
  await defaultAbortAwareSleep(5, undefined);
});

// ===================== Static extraction protection =====================

test('module source contains no terminal repository or database mutation tokens', () => {
  const sourcePath = fileURLToPath(new URL('./productionSwingAnalyzer.js', import.meta.url));
  const source = readFileSync(sourcePath, 'utf8');

  const forbiddenTokens = [
    'process.env',
    'createClient(',
    'app.listen(',
    'createApp(',
    'completeSwingAnalysis(',
    'markSwingErrorIfProcessing(',
    ".from('swings')",
    '.from("swings")',
    '.rpc(',
    '.update(',
    '.insert(',
    '.upsert(',
  ];

  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `forbidden token found in source: ${token}`);
  }
});

test('index.js no longer contains the moved swing pipeline and wires the extracted factories', () => {
  const indexPath = fileURLToPath(new URL('./index.js', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');

  const forbiddenTokens = [
    'function uploadToGemini',
    'function analyzeSwing',
    'const GEMINI_SCHEMA',
    ".from('swing-videos')",
    '.from("swing-videos")',
    'gemini-3.5-flash:generateContent',
  ];
  for (const token of forbiddenTokens) {
    assert.equal(source.includes(token), false, `forbidden token found in index.js: ${token}`);
  }

  const requiredTokens = ['createProductionSwingAnalyzer', 'createLegacySwingAnalyzerAdapter', 'productionAnalyzeSwing'];
  for (const token of requiredTokens) {
    assert.ok(source.includes(token), `expected token missing from index.js: ${token}`);
  }
});
