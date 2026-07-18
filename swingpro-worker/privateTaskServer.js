// Production runtime entrypoint for the private Cloud Tasks analysis worker
// (Phase 2B2B3B3D). Wires server-only configuration, the server-side Supabase
// service-role client, the production swing analyzer, and the private task
// Express app together. Performs no application-layer authentication —
// Cloud Run IAM and Cloud Tasks OIDC protection are deployment concerns for
// a later phase — and never inspects Authorization or X-CloudTasks headers.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createPrivateTaskApp } from './privateTaskApp.js';
import { createProductionSwingAnalyzer } from './productionSwingAnalyzer.js';
import { loadPrivateTaskConfig } from './privateTaskConfig.js';

const SERVICE_NAME = 'analysis-worker';

function runtimeDependencyFailure() {
  return { ok: false, missing: [], invalid: ['RUNTIME_DEPENDENCY'] };
}

/**
 * Builds the private task worker runtime from an env-like object and
 * injectable client/analyzer/app factories. Never calls listen(), never
 * exits the process. Constructs the Supabase client, analyzer, and app at
 * most once each, and only when configuration is valid — every dependency
 * factory call and its return shape is defensively contained so a hostile or
 * malformed factory can never leak a raw error or crash construction.
 */
function createPrivateTaskRuntime({
  env,
  createSupabaseClient = createClient,
  createAnalyzer = createProductionSwingAnalyzer,
  createApp = createPrivateTaskApp,
}) {
  const config = loadPrivateTaskConfig(env);
  if (!config.ok) {
    return { ok: false, missing: config.missing, invalid: config.invalid };
  }

  let supabase;
  try {
    supabase = createSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  } catch {
    return runtimeDependencyFailure();
  }

  let analyzeSwing;
  try {
    analyzeSwing = createAnalyzer({ supabase, geminiApiKey: config.geminiApiKey });
  } catch {
    return runtimeDependencyFailure();
  }

  let analyzerIsValid = false;
  try {
    analyzerIsValid = typeof analyzeSwing === 'function';
  } catch {
    analyzerIsValid = false;
  }
  if (!analyzerIsValid) {
    return runtimeDependencyFailure();
  }

  let app;
  try {
    app = createApp({ supabase, analyzeSwing, leaseSeconds: config.leaseSeconds });
  } catch {
    return runtimeDependencyFailure();
  }

  let appIsValid = false;
  try {
    const appType = typeof app;
    appIsValid =
      app !== null &&
      (appType === 'object' || appType === 'function') &&
      typeof app.listen === 'function';
  } catch {
    appIsValid = false;
  }
  if (!appIsValid) {
    return runtimeDependencyFailure();
  }

  return { ok: true, app, port: config.port };
}

function isDirectExecution() {
  const entryArg = typeof process !== 'undefined' ? process.argv[1] : undefined;
  if (!entryArg) return false;

  try {
    return import.meta.url === pathToFileURL(entryArg).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const runtime = createPrivateTaskRuntime({ env: process.env });

  if (!runtime.ok) {
    console.error(
      `[${SERVICE_NAME}] Invalid configuration — missing: [${runtime.missing.join(', ')}], invalid: [${runtime.invalid.join(', ')}]`
    );
    process.exitCode = 1;
  } else {
    runtime.app.listen(runtime.port, '0.0.0.0', () => {
      console.log(`${SERVICE_NAME} listening on port ${runtime.port}`);
    });
  }
}

export { createPrivateTaskRuntime };
