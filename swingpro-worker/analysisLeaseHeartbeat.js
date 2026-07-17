// Background lease-renewal helper for a claimed swing_analysis_jobs row.
// Wraps the existing renewAnalysisJobLease repository call in a recurring
// timer so a long-running analyzer can keep proving it still owns the lease.
// Never logs and never exposes the repository's raw error — only a generic
// configuration error (thrown synchronously, before any timer starts) and a
// boolean "lease lost" signal are surfaced to callers.
import * as defaultAnalysisJobRepository from './analysisJobRepository.js';

const LEASE_SECONDS_MIN = 30;
const LEASE_SECONDS_MAX = 3600;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidLeaseSeconds(value) {
  return Number.isInteger(value) && value >= LEASE_SECONDS_MIN && value <= LEASE_SECONDS_MAX;
}

function configurationError() {
  return new Error('invalid analysis lease heartbeat configuration');
}

// Validates a createAbortController() return value defensively: property
// access itself (controller.abort, controller.signal, signal.aborted) may
// throw if the injected factory hands back a getter or Proxy, so every read
// is contained in the same try/catch rather than trusting the shape.
function isValidAbortController(controller) {
  try {
    if (typeof controller !== 'object' || controller === null) return false;
    if (typeof controller.abort !== 'function') return false;
    const signal = controller.signal;
    if (typeof signal !== 'object' || signal === null) return false;
    if (typeof signal.aborted !== 'boolean') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a recurring lease-renewal heartbeat. Returns
 * { signal, hasLostLease, stop } — see module header for the safety
 * invariants. Throws a generic configuration error synchronously (before any
 * timer is scheduled) when the supplied arguments are invalid.
 */
function startAnalysisLeaseHeartbeat({
  supabase,
  jobId,
  swingId,
  leaseToken,
  leaseSeconds,
  analysisJobRepository = defaultAnalysisJobRepository,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  createAbortController = () => new AbortController(),
}) {
  if (!isNonEmptyString(jobId) || !isNonEmptyString(swingId) || !isNonEmptyString(leaseToken)) {
    throw configurationError();
  }
  if (!isValidLeaseSeconds(leaseSeconds)) {
    throw configurationError();
  }
  if (
    typeof analysisJobRepository?.renewAnalysisJobLease !== 'function' ||
    typeof setIntervalFn !== 'function' ||
    typeof clearIntervalFn !== 'function' ||
    typeof createAbortController !== 'function'
  ) {
    throw configurationError();
  }

  let abortController;
  try {
    abortController = createAbortController();
  } catch {
    throw configurationError();
  }
  if (!isValidAbortController(abortController)) {
    throw configurationError();
  }

  let lostLease = false;
  let stopped = false;
  let inFlightRenewal = null;

  async function renewOnce() {
    try {
      const result = await analysisJobRepository.renewAnalysisJobLease(supabase, {
        jobId,
        swingId,
        leaseToken,
        leaseSeconds,
      });

      if (!result || result.ok !== true || result.renewed !== true) {
        lostLease = true;
      }
    } catch {
      lostLease = true;
    }

    if (lostLease) {
      abortController.abort();
      clearIntervalFn(timer);
    }
  }

  function tick() {
    if (stopped || lostLease) return inFlightRenewal;
    if (inFlightRenewal) return inFlightRenewal;
    inFlightRenewal = renewOnce().finally(() => {
      inFlightRenewal = null;
    });
    return inFlightRenewal;
  }

  const intervalMs = Math.max(10000, Math.floor((leaseSeconds * 1000) / 3));
  const timer = setIntervalFn(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  async function stop() {
    if (stopped) {
      if (inFlightRenewal) await inFlightRenewal;
      return;
    }
    stopped = true;
    clearIntervalFn(timer);
    if (inFlightRenewal) await inFlightRenewal;
  }

  return {
    signal: abortController.signal,
    hasLostLease: () => lostLease,
    stop,
  };
}

export { startAnalysisLeaseHeartbeat };
