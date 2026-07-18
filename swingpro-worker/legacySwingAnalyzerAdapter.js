// Adapter that preserves app.js's existing positional analyzer contract
// (legacyAnalyzeSwing(swingId, storagePath, equipmentContext, slope,
// verifiedUserId)) on top of the new side-effect-free production analyzer.
// This is the only place that still performs the legacy synchronous
// completeSwingAnalysis finalization — the production analyzer itself never
// touches the swings table.
import { completeSwingAnalysis as defaultCompleteSwingAnalysis } from './swingRepository.js';

function configurationError() {
  return new Error('invalid legacy swing analyzer adapter configuration');
}

function finalizationError() {
  return new Error('Swing analysis finalization failed');
}

function analyzerError() {
  return new Error('Swing analysis failed');
}

/**
 * Creates the legacy positional adapter. Does not create a Supabase client,
 * read environment variables, start a server, or claim a durable analysis
 * job — it only wires the production analyzer to the existing synchronous
 * completeSwingAnalysis transition.
 */
function createLegacySwingAnalyzerAdapter({
  supabase,
  productionAnalyzeSwing,
  completeSwingAnalysisImpl = defaultCompleteSwingAnalysis,
}) {
  if (typeof productionAnalyzeSwing !== 'function') throw configurationError();
  if (typeof completeSwingAnalysisImpl !== 'function') throw configurationError();

  return async function legacyAnalyzeSwing(swingId, storagePath, equipmentContext, slope, verifiedUserId) {
    let telemetryData;
    try {
      telemetryData = await productionAnalyzeSwing({
        swingId,
        storagePath,
        equipmentContext,
        slope,
        userId: verifiedUserId,
      });
    } catch {
      throw analyzerError();
    }

    let result;
    try {
      result = await completeSwingAnalysisImpl(supabase, {
        swingId,
        userId: verifiedUserId,
        telemetryData,
      });
    } catch {
      throw finalizationError();
    }

    // Every field is read at most once from a locally-bound reference so a
    // hostile result (throwing getters, a revoked Proxy) can't combine
    // fields from multiple accesses into a falsely confirmed finalization.
    let ok;
    let changed;
    try {
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw finalizationError();
      }
      ok = result.ok;
      changed = result.changed;
    } catch {
      throw finalizationError();
    }

    if (ok !== true || changed !== true) {
      throw finalizationError();
    }

    return telemetryData;
  };
}

export { createLegacySwingAnalyzerAdapter };
