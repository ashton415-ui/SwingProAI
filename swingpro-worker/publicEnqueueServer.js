import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { CloudTasksClient } from '@google-cloud/tasks';
import { createPublicEnqueueApp } from './publicEnqueueApp.js';
import { loadPublicEnqueueConfig } from './publicEnqueueConfig.js';

const SERVICE_NAME = 'analysis-enqueuer';

/**
 * Builds the public enqueue service runtime from an env-like object and
 * injectable client/app factories. Never calls listen(), never exits the
 * process, never makes a network call itself — construction of the real
 * Supabase/Cloud Tasks clients (which the injected factories perform) is the
 * only side effect, and only when configuration is valid. This is a
 * separate entrypoint from the legacy synchronous worker (app.js/index.js)
 * and from the future private Cloud Tasks handler — it must never import
 * either.
 */
function createPublicEnqueueRuntime({
  env,
  createSupabaseClient = createClient,
  createTasksClient = () => new CloudTasksClient(),
  createApp = createPublicEnqueueApp,
}) {
  const config = loadPublicEnqueueConfig(env);
  if (!config.ok) {
    return { ok: false, missing: config.missing, invalid: config.invalid };
  }

  const supabase = createSupabaseClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const tasksClient = createTasksClient();

  const app = createApp({
    supabase,
    tasksClient,
    queueConfig: config.queueConfig,
  });

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
  const runtime = createPublicEnqueueRuntime({ env: process.env });

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

export { createPublicEnqueueRuntime };
