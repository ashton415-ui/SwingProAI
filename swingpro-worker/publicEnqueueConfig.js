// Configuration loader for the public swing-analysis enqueue service
// (Phase 2B2B3B1). Pure function over an env-like object — no process.env
// access here — so it stays unit-testable. Never returns or logs supplied
// values; failure results contain variable names only.

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GCP_PROJECT_ID',
  'CLOUD_TASKS_LOCATION',
  'CLOUD_TASKS_QUEUE_ID',
  'SWING_ANALYSIS_HANDLER_URL',
  'CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL',
  'SWING_ANALYSIS_HANDLER_AUDIENCE',
];

const URL_VARS = new Set(['SWING_ANALYSIS_HANDLER_URL', 'SWING_ANALYSIS_HANDLER_AUDIENCE']);

const DEFAULT_PORT = 3000;
const PORT_MIN = 1;
const PORT_MAX = 65535;
const INTEGER_PATTERN = /^[0-9]+$/;

function isValidHttpsUrlNoCredentials(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return true;
}

function parsePort(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!INTEGER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < PORT_MIN || value > PORT_MAX) return null;
  return value;
}

/**
 * Loads and validates the public enqueue service configuration from an
 * env-like object. Reads only the exact variable names listed above — no
 * NEXT_PUBLIC_ or other fallback is ever consulted for server-only secrets.
 */
function loadPublicEnqueueConfig(env) {
  const source = env || {};
  const missing = [];
  const invalid = [];
  const values = {};

  for (const name of REQUIRED_VARS) {
    const raw = source[name];
    if (raw === undefined || raw === null) {
      missing.push(name);
      continue;
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      invalid.push(name);
      continue;
    }
    const trimmed = raw.trim();
    if (URL_VARS.has(name) && !isValidHttpsUrlNoCredentials(trimmed)) {
      invalid.push(name);
      continue;
    }
    values[name] = trimmed;
  }

  let port = DEFAULT_PORT;
  const rawPort = source.PORT;
  if (rawPort !== undefined && rawPort !== null) {
    const parsedPort = parsePort(rawPort);
    if (parsedPort === null) {
      invalid.push('PORT');
    } else {
      port = parsedPort;
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing, invalid };
  }

  return {
    ok: true,
    supabaseUrl: values.SUPABASE_URL,
    supabaseServiceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY,
    port,
    queueConfig: {
      projectId: values.GCP_PROJECT_ID,
      location: values.CLOUD_TASKS_LOCATION,
      queueId: values.CLOUD_TASKS_QUEUE_ID,
      handlerUrl: values.SWING_ANALYSIS_HANDLER_URL,
      serviceAccountEmail: values.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL,
      audience: values.SWING_ANALYSIS_HANDLER_AUDIENCE,
    },
  };
}

export { loadPublicEnqueueConfig };
