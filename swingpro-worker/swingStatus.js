// Pure status classification for swing rows. No I/O, no mutation — callers
// use these to decide whether a row may be claimed before touching the DB.

// Canonical values this worker writes going forward.
const CANONICAL_STATUS = {
  PROCESSING: 'PROCESSING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR',
};

const CLASSIFICATION = {
  CLAIMABLE: 'claimable',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  UNKNOWN: 'unknown',
};

// Claimable regardless of case: the mobile client writes lowercase 'pending',
// this worker writes 'ERROR' — both must be claimable case-insensitively.
const CLAIMABLE_VALUES = new Set(['pending', 'error']);

/**
 * Lowercases and trims a status value for comparison purposes only.
 * Never mutates or writes back — the caller must use the exact original
 * stored string value in any database filter (see swingRepository.js).
 */
function normalizeSwingStatus(status) {
  if (typeof status !== 'string') return null;
  const trimmed = status.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Classifies a stored status string into one of:
 * 'claimable' | 'processing' | 'complete' | 'unknown'
 */
function classifySwingStatus(status) {
  const normalized = normalizeSwingStatus(status);
  if (normalized === null) return CLASSIFICATION.UNKNOWN;
  if (CLAIMABLE_VALUES.has(normalized)) return CLASSIFICATION.CLAIMABLE;
  if (normalized === 'processing') return CLASSIFICATION.PROCESSING;
  if (normalized === 'complete') return CLASSIFICATION.COMPLETE;
  return CLASSIFICATION.UNKNOWN;
}

export { normalizeSwingStatus, classifySwingStatus, CANONICAL_STATUS, CLASSIFICATION };
