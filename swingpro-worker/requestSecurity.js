// Pure security helpers for the authenticated swing-analysis endpoint.
// No Express, no Supabase client construction here (except authenticateUser,
// which takes an already-constructed client) — keeps this module unit-testable.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_STORAGE_PATH_LENGTH = 512;
const MAX_EQUIPMENT_STRING_LENGTH = 200;

/**
 * Extracts a single Bearer token from an Authorization header value.
 * Returns null for anything that isn't exactly one well-formed "Bearer <token>" value.
 * @param {string} authorizationHeader - the raw Authorization header value
 */
function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;

  // Reject multi-value headers (e.g. sent as an array and joined with a comma,
  // or literally containing a comma-separated second value).
  if (authorizationHeader.includes(',')) return null;

  const trimmed = authorizationHeader.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split(' ').filter((p) => p.length > 0);
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme !== 'Bearer') return null;
  if (token.length === 0) return null;

  return token;
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Validates that storagePath is a safe, user-scoped Storage object path.
 * Must be called only with a verified user ID (post-authentication).
 */
function validateUserStoragePath(storagePath, verifiedUserId) {
  if (typeof storagePath !== 'string') return false;
  if (storagePath.length === 0) return false;
  if (storagePath.length > MAX_STORAGE_PATH_LENGTH) return false;

  if (storagePath.startsWith('/')) return false;
  if (storagePath.includes('\\')) return false;
  if (storagePath.includes('\0')) return false;
  if (storagePath.includes('//')) return false;

  const segments = storagePath.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return false;
  }

  const prefix = `${verifiedUserId}/`;
  if (!storagePath.startsWith(prefix)) return false;

  const remainder = storagePath.slice(prefix.length);
  if (remainder.length === 0) return false;

  return true;
}

/**
 * Verifies a Supabase access token and returns the verified user, never trusting
 * any client-supplied identity. Returns null on any failure — caller maps that to 401.
 */
async function authenticateUser(supabase, authorizationHeader) {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) return null;
    if (!data || !data.user || !data.user.id) return null;
    return data.user;
  } catch {
    return null;
  }
}

const EQUIPMENT_STRING_FIELDS = ['make', 'model', 'club_type', 'shaft_flex'];

/**
 * Validates the enrichment fields that ride along with the analysis request.
 * These are NOT authorization inputs — only defensive shape/size limits.
 * Known string fields must actually be strings (nested objects/arrays rejected);
 * loft must be absent, null, or finite. Unknown fields are not trusted here —
 * sanitizeEquipmentContext strips anything not explicitly allow-listed.
 */
function validateEquipmentContext(equipmentContext) {
  if (equipmentContext === undefined || equipmentContext === null) return true;
  if (typeof equipmentContext !== 'object') return false;
  if (Array.isArray(equipmentContext)) return false;

  for (const field of EQUIPMENT_STRING_FIELDS) {
    const value = equipmentContext[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return false;
    if (value.length > MAX_EQUIPMENT_STRING_LENGTH) return false;
  }

  const loft = equipmentContext.loft;
  if (loft !== undefined && loft !== null) {
    if (typeof loft !== 'number' || !Number.isFinite(loft)) return false;
  }

  // Defense in depth: reject any other excessively long string value,
  // including on fields we don't otherwise recognize.
  for (const value of Object.values(equipmentContext)) {
    if (typeof value === 'string' && value.length > MAX_EQUIPMENT_STRING_LENGTH) {
      return false;
    }
  }

  return true;
}

/**
 * Builds a sanitized equipmentContext containing only the known, validated
 * fields. Call only after validateEquipmentContext has passed — this does not
 * re-validate, it strips anything not explicitly allow-listed so unknown or
 * malformed fields never reach the Gemini prompt.
 */
function sanitizeEquipmentContext(equipmentContext) {
  if (equipmentContext === undefined || equipmentContext === null) return null;

  const sanitized = {};
  for (const field of EQUIPMENT_STRING_FIELDS) {
    if (typeof equipmentContext[field] === 'string') {
      sanitized[field] = equipmentContext[field];
    }
  }
  if (typeof equipmentContext.loft === 'number' && Number.isFinite(equipmentContext.loft)) {
    sanitized.loft = equipmentContext.loft;
  }

  return sanitized;
}

function validateSlope(slope) {
  if (slope === undefined || slope === null) return true;
  if (typeof slope !== 'number') return false;
  return Number.isFinite(slope);
}

export {
  extractBearerToken,
  isValidUuid,
  validateUserStoragePath,
  authenticateUser,
  validateEquipmentContext,
  sanitizeEquipmentContext,
  validateSlope,
  MAX_STORAGE_PATH_LENGTH,
  MAX_EQUIPMENT_STRING_LENGTH,
};
