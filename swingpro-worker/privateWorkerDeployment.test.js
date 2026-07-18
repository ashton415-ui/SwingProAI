// Static contract tests for the private worker deployment readiness phase
// (Phase 2B2B3B3E). Reads the Dockerfile, .dockerignore, deployment
// runbook, package.json, privateTaskServer.js, and privateTaskApp.js as
// plain text/data only. Never executes Docker, gcloud, or a child process;
// never opens a network port; never touches process.env or real secrets.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readWorkerFile(name) {
  return readFileSync(path.join(__dirname, name), 'utf8');
}

const dockerfile = readWorkerFile('Dockerfile');
const dockerignore = readWorkerFile('.dockerignore');
const runbook = readWorkerFile('PRIVATE_WORKER_DEPLOYMENT.md');
const packageJson = readWorkerFile('package.json');
const privateTaskServerSource = readWorkerFile('privateTaskServer.js');
const privateTaskAppSource = readWorkerFile('privateTaskApp.js');

function dockerignoreLines() {
  return dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('Dockerfile base and installation contract', () => {
  test('uses the exact Node patch image', () => {
    assert.match(dockerfile, /^FROM node:22\.23\.1-bookworm-slim$/m);
  });

  test('does not use a latest tag', () => {
    assert.doesNotMatch(dockerfile, /node:latest/);
    assert.doesNotMatch(dockerfile, /FROM node$/m);
  });

  test('does not use node:lts', () => {
    assert.doesNotMatch(dockerfile, /node:lts/);
  });

  test('does not use an Alpine base', () => {
    assert.doesNotMatch(dockerfile, /alpine/i);
  });

  test('sets WORKDIR /app', () => {
    assert.match(dockerfile, /^WORKDIR \/app$/m);
  });

  test('sets ENV NODE_ENV=production', () => {
    assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
  });

  test('copies package metadata before application source', () => {
    const metadataIndex = dockerfile.indexOf('COPY package.json package-lock.json ./');
    const sourceIndex = dockerfile.indexOf('COPY --chown=node:node . .');
    assert.notEqual(metadataIndex, -1);
    assert.notEqual(sourceIndex, -1);
    assert.ok(metadataIndex < sourceIndex);
  });

  test('uses npm ci with the required flags', () => {
    assert.match(dockerfile, /npm ci/);
    assert.match(dockerfile, /--omit=dev/);
    assert.match(dockerfile, /--no-audit/);
    assert.match(dockerfile, /--no-fund/);
  });

  test('does not use npm install', () => {
    assert.doesNotMatch(dockerfile, /npm install/);
  });

  test('does not use yarn or pnpm', () => {
    assert.doesNotMatch(dockerfile, /\byarn\b/i);
    assert.doesNotMatch(dockerfile, /\bpnpm\b/i);
  });

  test('does not install packages via apt-get, curl, or wget', () => {
    assert.doesNotMatch(dockerfile, /apt-get/);
    assert.doesNotMatch(dockerfile, /\bcurl\b/);
    assert.doesNotMatch(dockerfile, /\bwget\b/);
  });
});

describe('Dockerfile runtime contract', () => {
  test('copies application source with node ownership', () => {
    assert.match(dockerfile, /^COPY --chown=node:node \. \.$/m);
  });

  test('runs as the non-root node user', () => {
    assert.match(dockerfile, /^USER node$/m);
  });

  test('USER node appears before CMD', () => {
    const userIndex = dockerfile.indexOf('USER node');
    const cmdIndex = dockerfile.indexOf('CMD [');
    assert.notEqual(userIndex, -1);
    assert.notEqual(cmdIndex, -1);
    assert.ok(userIndex < cmdIndex);
  });

  test('documents the Cloud Run ingress port', () => {
    assert.match(dockerfile, /^EXPOSE 8080$/m);
  });

  test('CMD is exactly the exec-form private task server start', () => {
    const cmdLines = dockerfile.match(/^CMD .*$/gm) ?? [];
    assert.equal(cmdLines.length, 1);
    assert.equal(cmdLines[0], 'CMD ["node", "privateTaskServer.js"]');
  });

  test('does not use shell-form CMD', () => {
    assert.doesNotMatch(dockerfile, /^CMD (?!\[).*$/m);
  });

  test('does not declare an ENTRYPOINT', () => {
    assert.doesNotMatch(dockerfile, /ENTRYPOINT/);
  });

  test('does not declare a HEALTHCHECK', () => {
    assert.doesNotMatch(dockerfile, /HEALTHCHECK/);
  });

  test('does not start via npm start', () => {
    assert.doesNotMatch(dockerfile, /npm start/);
  });

  test('does not start index.js', () => {
    assert.doesNotMatch(dockerfile, /index\.js/);
  });

  test('does not start publicEnqueueServer.js', () => {
    assert.doesNotMatch(dockerfile, /publicEnqueueServer\.js/);
  });

  test('does not run a migration, Supabase CLI, or gcloud command', () => {
    assert.doesNotMatch(dockerfile, /migration/i);
    assert.doesNotMatch(dockerfile, /supabase/i);
    assert.doesNotMatch(dockerfile, /gcloud/);
  });
});

describe('Dockerfile secret protection', () => {
  const forbiddenSubstrings = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'ARG SECRET',
    'ARG KEY',
    'COPY .env',
    'ADD .env',
    'NEXT_PUBLIC_',
  ];

  for (const forbidden of forbiddenSubstrings) {
    test(`does not contain "${forbidden}"`, () => {
      assert.doesNotMatch(dockerfile, new RegExp(escapeRegExp(forbidden)));
    });
  }

  test('does not contain a service-role token-shaped or API-key-shaped example', () => {
    assert.doesNotMatch(dockerfile, /eyJ[A-Za-z0-9_-]{10,}/);
    assert.doesNotMatch(dockerfile, /AIza[0-9A-Za-z_-]{10,}/);
    assert.doesNotMatch(dockerfile, /sb_secret_/);
  });

  test('does not declare a secret ARG or ENV value', () => {
    assert.doesNotMatch(dockerfile, /^ARG /m);
    const envLines = dockerfile.match(/^ENV .*$/gm) ?? [];
    for (const line of envLines) {
      assert.match(line, /^ENV NODE_ENV=production$/);
    }
  });
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Docker ignore contract', () => {
  const requiredPatterns = [
    'node_modules',
    '.git',
    '.gitignore',
    '.github',
    '.env',
    '.env.*',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'coverage',
    'test-results',
    '*.test.js',
    '*.diff',
    '*.patch',
    'PRIVATE_WORKER_DEPLOYMENT.md',
    'Dockerfile',
    '.dockerignore',
    '.DS_Store',
  ];

  const lines = dockerignoreLines();

  for (const pattern of requiredPatterns) {
    test(`excludes ${pattern}`, () => {
      assert.ok(lines.includes(pattern), `expected .dockerignore to contain "${pattern}"`);
    });
  }

  const mustNotExclude = ['package.json', 'package-lock.json', 'privateTaskServer.js'];

  for (const required of mustNotExclude) {
    test(`does not exclude ${required}`, () => {
      assert.ok(!lines.includes(required), `expected .dockerignore to not exclude "${required}"`);
    });
  }
});

describe('Existing runtime compatibility (read-only verification)', () => {
  test('privateTaskServer.js listens on 0.0.0.0', () => {
    assert.match(privateTaskServerSource, /listen\([^)]*['"]0\.0\.0\.0['"]/);
  });

  test('privateTaskServer.js references runtime.port', () => {
    assert.match(privateTaskServerSource, /runtime\.port/);
  });

  test('package.json still declares start:private', () => {
    const parsed = JSON.parse(packageJson);
    assert.equal(parsed.scripts?.['start:private'], 'node privateTaskServer.js');
  });

  test('privateTaskApp.js still declares GET /health', () => {
    assert.match(privateTaskAppSource, /app\.get\(\s*['"]\/health['"]/);
  });

  test('privateTaskApp.js still declares POST /internal/tasks/analyze-swing', () => {
    assert.match(privateTaskAppSource, /app\.post\(\s*['"]\/internal\/tasks\/analyze-swing['"]/);
  });

  test('the health service name remains analysis-worker', () => {
    assert.match(privateTaskAppSource, /service:\s*['"]analysis-worker['"]/);
  });
});

describe('Runbook security contract', () => {
  const requiredStrings = [
    '--no-allow-unauthenticated',
    'roles/run.invoker',
    'roles/secretmanager.secretAccessor',
    'roles/iam.serviceAccountUser',
    'OIDC',
    '/internal/tasks/analyze-swing',
    'SWING_ANALYSIS_HANDLER_URL',
    'SWING_ANALYSIS_HANDLER_AUDIENCE',
    'ANALYSIS_JOB_LEASE_SECONDS=300',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'Secret Manager',
    '/health',
    '8080',
    '1800s',
    'concurrency 1',
    'immutable image digest',
  ];

  for (const required of requiredStrings) {
    test(`contains "${required}"`, () => {
      assert.ok(runbook.includes(required), `expected runbook to contain "${required}"`);
    });
  }

  test('contains numbered secret version guidance', () => {
    assert.match(runbook, /never\s+`?latest`?/i);
    assert.ok(runbook.includes('<SECRET_VERSION>'));
  });

  test('contains queue pause requirement', () => {
    assert.match(runbook, /queue.*must remain paused|paused.*until/i);
  });

  test('contains migration-remains-unapplied statement', () => {
    assert.match(runbook, /migration/i);
    assert.match(runbook, /remains\s+unapplied/i);
  });

  test('contains a migration rollout gate', () => {
    assert.match(runbook, /Apply the migration in its own controlled phase/i);
  });

  test('contains rollback guidance', () => {
    assert.match(runbook, /## J\. Rollback/);
    assert.match(runbook, /Pause dispatch first/i);
  });

  test('prohibits manually posting production jobs', () => {
    assert.match(runbook, /forbidden.*claim or mutate real jobs/i);
  });

  test('does not contain a standalone --allow-unauthenticated flag', () => {
    const matches = runbook.match(/--allow-unauthenticated/g) ?? [];
    assert.equal(matches.length, 0);
  });

  test('audience example is the base service URL and handler adds the task path', () => {
    assert.match(
      runbook,
      /SWING_ANALYSIS_HANDLER_URL:\s+<SERVICE_URL>\/internal\/tasks\/analyze-swing/
    );
    assert.match(runbook, /SWING_ANALYSIS_HANDLER_AUDIENCE:\s+<SERVICE_URL>(?!\/)/);
  });
});

describe('Runbook secret and placeholder safety', () => {
  const requiredPlaceholders = [
    '<PROJECT_ID>',
    '<PROJECT_NUMBER>',
    '<REGION>',
    '<ARTIFACT_REPOSITORY>',
    '<COMMIT_SHA>',
    '<RUNTIME_SERVICE_ACCOUNT>',
    '<TASK_CALLER_SERVICE_ACCOUNT>',
    '<SUPABASE_URL>',
    '<SECRET_VERSION>',
    '<SERVICE_URL>',
  ];

  for (const placeholder of requiredPlaceholders) {
    test(`includes placeholder ${placeholder}`, () => {
      assert.ok(runbook.includes(placeholder));
    });
  }

  test('does not contain a JWT-like value', () => {
    assert.doesNotMatch(runbook, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  test('does not contain an sb_secret_ value', () => {
    assert.doesNotMatch(runbook, /sb_secret_[A-Za-z0-9]/);
  });

  test('does not contain a Gemini API-key-shaped example', () => {
    assert.doesNotMatch(runbook, /AIza[0-9A-Za-z_-]{10,}/);
  });

  test('does not contain an actual Supabase project URL', () => {
    assert.doesNotMatch(runbook, /https:\/\/[a-z0-9]{15,}\.supabase\.co/);
  });

  test('does not contain a real email address', () => {
    assert.doesNotMatch(runbook, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  test('does not present a localhost deployment target as production', () => {
    assert.doesNotMatch(runbook, /localhost/i);
    assert.doesNotMatch(runbook, /127\.0\.0\.1/);
  });

  test('does not contain a NEXT_PUBLIC_ secret variable assignment', () => {
    assert.doesNotMatch(runbook, /NEXT_PUBLIC_\w*\s*=/);
  });
});

describe('Official documentation references', () => {
  const requiredUrls = [
    'https://cloud.google.com/run/docs/container-contract',
    'https://cloud.google.com/run/docs/configuring/healthchecks',
    'https://cloud.google.com/run/docs/authenticating/overview',
    'https://cloud.google.com/run/docs/authenticating/service-to-service',
    'https://cloud.google.com/run/docs/configuring/services/secrets',
    'https://cloud.google.com/run/docs/configuring/request-timeout',
    'https://cloud.google.com/tasks/docs/creating-http-target-tasks',
  ];

  for (const url of requiredUrls) {
    test(`includes reference ${url}`, () => {
      assert.ok(runbook.includes(url));
    });
  }

  test('does not include unofficial reference domains', () => {
    assert.doesNotMatch(runbook, /medium\.com/);
    assert.doesNotMatch(runbook, /stackoverflow\.com/);
    assert.doesNotMatch(runbook, /reddit\.com/);
    assert.doesNotMatch(runbook, /\bblogspot\./);
  });
});
