// Configuration loader for the private Cloud Tasks analysis worker runtime
// (Phase 2B2B3B3D). Pure function over an env-like object — the global
// process environment is never read directly here — so it stays
// unit-testable. Never returns or logs supplied secret values; failure
// results contain variable names only.

const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'ANALYSIS_JOB_LEASE_SECONDS',
];

const LEASE_SECONDS_MIN = 30;
const LEASE_SECONDS_MAX = 3600;
const DEFAULT_PORT = 3000;
const PORT_MIN = 1;
const PORT_MAX = 65535;
const INTEGER_PATTERN = /^[0-9]+$/;

function isValidPrivateSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (parsed.hash.length > 0) return false;
  return true;
}

function parseStrictInteger(raw, min, max) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!INTEGER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Loads and validates the private task worker configuration from an env-like
 * object. Reads only the exact server-side variable names below — never a
 * client-exposed or other fallback name.
 */
function loadPrivateTaskConfig(env) {
  const source = env || {};
  const missing = [];
  const invalid = [];

  let supabaseUrl;
  let supabaseServiceRoleKey;
  let geminiApiKey;
  let leaseSeconds;

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

    if (name === 'SUPABASE_URL') {
      if (!isValidPrivateSupabaseUrl(trimmed)) {
        invalid.push(name);
        continue;
      }
      supabaseUrl = trimmed;
      continue;
    }

    if (name === 'SUPABASE_SERVICE_ROLE_KEY') {
      supabaseServiceRoleKey = trimmed;
      continue;
    }

    if (name === 'GEMINI_API_KEY') {
      geminiApiKey = trimmed;
      continue;
    }

    if (name === 'ANALYSIS_JOB_LEASE_SECONDS') {
      const parsedLease = parseStrictInteger(trimmed, LEASE_SECONDS_MIN, LEASE_SECONDS_MAX);
      if (parsedLease === null) {
        invalid.push(name);
        continue;
      }
      leaseSeconds = parsedLease;
      continue;
    }
  }

  let port = DEFAULT_PORT;
  const rawPort = source.PORT;
  if (rawPort !== undefined && rawPort !== null) {
    const parsedPort = parseStrictInteger(rawPort, PORT_MIN, PORT_MAX);
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
    supabaseUrl,
    supabaseServiceRoleKey,
    geminiApiKey,
    leaseSeconds,
    port,
  };
}

export { loadPrivateTaskConfig };
