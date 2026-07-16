import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBearerToken,
  isValidUuid,
  validateUserStoragePath,
  authenticateUser,
  validateEquipmentContext,
  sanitizeEquipmentContext,
  validateSlope,
} from './requestSecurity.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';

// --- extractBearerToken ---

test('extractBearerToken: valid Bearer token extraction', () => {
  assert.equal(extractBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
});

test('extractBearerToken: missing Authorization', () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(null), null);
});

test('extractBearerToken: wrong auth scheme', () => {
  assert.equal(extractBearerToken('Basic abc.def.ghi'), null);
});

test('extractBearerToken: blank token', () => {
  assert.equal(extractBearerToken('Bearer '), null);
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken('   '), null);
});

test('extractBearerToken: malformed/multiple token values', () => {
  assert.equal(extractBearerToken('Bearer token1 token2'), null);
  assert.equal(extractBearerToken('Bearer token1, Bearer token2'), null);
  assert.equal(extractBearerToken('Bearer'), null);
});

// --- isValidUuid ---

test('isValidUuid: valid UUID', () => {
  assert.equal(isValidUuid(USER_ID), true);
  assert.equal(isValidUuid(USER_ID.toUpperCase()), true);
});

test('isValidUuid: invalid UUID', () => {
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid('11111111-1111-1111-1111-11111111111'), false);
  assert.equal(isValidUuid(123), false);
  assert.equal(isValidUuid(null), false);
});

// --- validateUserStoragePath ---

test('validateUserStoragePath: correct user-prefixed Storage path', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}/swing1.mp4`, USER_ID), true);
});

test('validateUserStoragePath: another user\'s prefix', () => {
  assert.equal(validateUserStoragePath(`${OTHER_USER_ID}/swing1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: leading slash', () => {
  assert.equal(validateUserStoragePath(`/${USER_ID}/swing1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: backslash', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}\\swing1.mp4`, USER_ID), false);
  assert.equal(validateUserStoragePath(`${USER_ID}/swing\\1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: dot segment', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}/./swing1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: dot-dot segment', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}/../${OTHER_USER_ID}/swing1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: duplicate slash', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}//swing1.mp4`, USER_ID), false);
});

test('validateUserStoragePath: missing filename', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}/`, USER_ID), false);
});

test('validateUserStoragePath: null byte', () => {
  assert.equal(validateUserStoragePath(`${USER_ID}/swing1.mp4\0`, USER_ID), false);
});

test('validateUserStoragePath: excessive length', () => {
  const longName = 'a'.repeat(600);
  assert.equal(validateUserStoragePath(`${USER_ID}/${longName}.mp4`, USER_ID), false);
});

// --- validateSlope ---

test('validateSlope: valid slope', () => {
  assert.equal(validateSlope(3.5), true);
  assert.equal(validateSlope(0), true);
  assert.equal(validateSlope(null), true);
  assert.equal(validateSlope(undefined), true);
});

test('validateSlope: NaN/Infinity rejection', () => {
  assert.equal(validateSlope(NaN), false);
  assert.equal(validateSlope(Infinity), false);
  assert.equal(validateSlope(-Infinity), false);
});

// --- validateEquipmentContext ---

test('validateEquipmentContext: equipmentContext array rejection', () => {
  assert.equal(validateEquipmentContext([]), false);
  assert.equal(validateEquipmentContext(['driver']), false);
});

test('validateEquipmentContext: excessive equipment string rejection', () => {
  assert.equal(validateEquipmentContext({ make: 'a'.repeat(201) }), false);
  assert.equal(validateEquipmentContext({ make: 'Titleist' }), true);
  assert.equal(validateEquipmentContext(null), true);
  assert.equal(validateEquipmentContext(undefined), true);
});

test('validateEquipmentContext: loft finite number', () => {
  assert.equal(validateEquipmentContext({ loft: 10.5 }), true);
  assert.equal(validateEquipmentContext({ loft: 0 }), true);
  assert.equal(validateEquipmentContext({ loft: null }), true);
});

test('validateEquipmentContext: loft NaN/Infinity rejection', () => {
  assert.equal(validateEquipmentContext({ loft: NaN }), false);
  assert.equal(validateEquipmentContext({ loft: Infinity }), false);
  assert.equal(validateEquipmentContext({ loft: -Infinity }), false);
  assert.equal(validateEquipmentContext({ loft: 'ten' }), false);
});

test('validateEquipmentContext: nested object rejection for known string fields', () => {
  assert.equal(validateEquipmentContext({ make: { brand: 'Titleist' } }), false);
  assert.equal(validateEquipmentContext({ shaft_flex: ['Stiff'] }), false);
  assert.equal(validateEquipmentContext({ club_type: { type: 'Driver' } }), false);
});

// --- sanitizeEquipmentContext ---

test('sanitizeEquipmentContext: unknown fields do not survive sanitization', () => {
  const sanitized = sanitizeEquipmentContext({
    make: 'Titleist',
    loft: 10.5,
    hacked_field: 'ignore me',
    __proto__: { polluted: true },
  });
  assert.deepEqual(sanitized, { make: 'Titleist', loft: 10.5 });
  assert.equal(sanitized.hacked_field, undefined);
});

test('sanitizeEquipmentContext: absent/null equipmentContext returns null', () => {
  assert.equal(sanitizeEquipmentContext(null), null);
  assert.equal(sanitizeEquipmentContext(undefined), null);
});

// --- authenticateUser ---

test('authenticateUser: valid token returns verified user', async () => {
  const fakeSupabase = {
    auth: {
      getUser: async (token) => {
        assert.equal(token, 'good-token');
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
  };
  const user = await authenticateUser(fakeSupabase, 'Bearer good-token');
  assert.equal(user.id, USER_ID);
});

test('authenticateUser: missing Authorization returns null', async () => {
  const fakeSupabase = { auth: { getUser: async () => { throw new Error('should not be called'); } } };
  const user = await authenticateUser(fakeSupabase, undefined);
  assert.equal(user, null);
});

test('authenticateUser: auth error returns null', async () => {
  const fakeSupabase = {
    auth: {
      getUser: async () => ({ data: null, error: { message: 'invalid JWT' } }),
    },
  };
  const user = await authenticateUser(fakeSupabase, 'Bearer bad-token');
  assert.equal(user, null);
});

test('authenticateUser: expired/missing user returns null', async () => {
  const fakeSupabase = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
  const user = await authenticateUser(fakeSupabase, 'Bearer expired-token');
  assert.equal(user, null);
});
