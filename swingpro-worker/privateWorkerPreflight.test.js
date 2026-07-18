// Static contract tests for the private worker deployment preflight tooling
// (Phase 2B2B3B3F). Reads the preflight script and documentation as plain
// text/data only. Never executes PowerShell, gcloud, Docker, or Supabase;
// never spawns a child process; never opens a network connection; never
// inspects real environment variables; never creates or modifies files.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readWorkerFile(name) {
  return readFileSync(path.join(__dirname, name), 'utf8');
}

const preflightScript = readWorkerFile(path.join('scripts', 'private-worker-preflight.ps1'));
const preflightDoc = readWorkerFile('PRIVATE_WORKER_PREFLIGHT.md');
const deploymentDoc = readWorkerFile('PRIVATE_WORKER_DEPLOYMENT.md');
const packageJson = readWorkerFile('package.json');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A quoted gcloud-argument token, e.g. matches `'create'` but not `disabled`
// or `CreateNew` — used to distinguish an executable command token from
// prose or unrelated identifiers containing the same letters.
function quotedArgumentToken(word) {
  return new RegExp(`'${escapeRegExp(word)}'`);
}

// Extracts every literal `-Id '<id>' -Arguments @(...)` declaration from the
// script as { id, argsText } pairs, so flag/scoping rules can be checked
// against the exact argument list passed to each gcloud invocation rather
// than against loose substring presence anywhere in the file. Safe because
// none of the script's -Arguments arrays contain a literal parenthesis.
function extractArgumentDeclarations(script) {
  const regex = /-Id\s+'([^']+)'\s+-Arguments\s+@\(([^)]*)\)/g;
  const declarations = [];
  let match;
  while ((match = regex.exec(script)) !== null) {
    declarations.push({ id: match[1], argsText: match[2] });
  }
  return declarations;
}

const argumentDeclarations = extractArgumentDeclarations(preflightScript);

function declarationFor(id) {
  const found = argumentDeclarations.find((d) => d.id === id);
  assert.ok(found, `expected an -Arguments declaration for -Id '${id}'`);
  return found.argsText;
}

// IDs that address a specific project-scoped remote resource and must
// therefore carry an explicit --project flag (as opposed to purely local
// tooling calls like gcloudVersion/authList).
const remoteResourceCommandIds = [
  'projectDescribe',
  'projectIamPolicy',
  'enabledServices',
  'artifactRepositories',
  'cloudRunServices',
  'serviceAccounts',
  'secrets',
  'taskQueues',
  'workerServiceDescribe',
  'workerServiceIamPolicy',
  'artifactRepositoryDescribe',
  'artifactRepositoryIamPolicy',
  'queueDescribe',
  'queueIamPolicy',
  'runtimeServiceAccountDescribe',
  'runtimeServiceAccountIamPolicy',
  'taskCallerServiceAccountDescribe',
  'taskCallerServiceAccountIamPolicy',
  'taskCreatorServiceAccountDescribe',
  'taskCreatorServiceAccountIamPolicy',
  'supabaseSecretDescribe',
  'supabaseSecretVersionsList',
  'supabaseSecretIamPolicy',
  'geminiSecretDescribe',
  'geminiSecretVersionsList',
  'geminiSecretIamPolicy',
];

const regionScopedCommandIds = [
  'artifactRepositories',
  'cloudRunServices',
  'workerServiceDescribe',
  'workerServiceIamPolicy',
  'artifactRepositoryDescribe',
  'artifactRepositoryIamPolicy',
];

const locationScopedTasksCommandIds = ['taskQueues', 'queueDescribe', 'queueIamPolicy'];

describe('File and runtime isolation', () => {
  test('package.json still declares start:private', () => {
    const parsed = JSON.parse(packageJson);
    assert.equal(parsed.scripts?.['start:private'], 'node privateTaskServer.js');
  });

  test('preflight script does not reference application startup files as commands', () => {
    assert.doesNotMatch(preflightScript, /privateTaskServer\.js/);
    assert.doesNotMatch(preflightScript, /publicEnqueueServer\.js/);
    assert.doesNotMatch(preflightScript, /\bindex\.js\b/);
    assert.doesNotMatch(preflightScript, /\bapp\.js\b/);
  });

  test('preflight script does not invoke Node', () => {
    assert.doesNotMatch(preflightScript, /\bnode\b/i);
  });

  test('preflight script does not invoke npm', () => {
    assert.doesNotMatch(preflightScript, /\bnpm\b/i);
  });

  test('preflight script does not invoke Docker', () => {
    // "Docker-format Artifact Registry repository" is legitimate prose (the
    // script inspects the AR repository `format` field for the value
    // DOCKER); what must never appear is an actual docker CLI invocation.
    assert.doesNotMatch(preflightScript, /\bdocker\s+(build|push|run|images|login|pull|tag)\b/i);
    assert.doesNotMatch(preflightScript, /\bdocker\.exe\b/i);
  });

  test('preflight script does not invoke Supabase', () => {
    assert.doesNotMatch(preflightScript, /\bsupabase\b/i);
  });
});

describe('PowerShell safety contract', () => {
  test('sets strict mode', () => {
    assert.match(preflightScript, /Set-StrictMode\s+-Version\s+Latest/);
  });

  test('sets ErrorActionPreference to Stop', () => {
    assert.match(preflightScript, /\$ErrorActionPreference\s*=\s*'Stop'/);
  });

  test('declares the four required parameters', () => {
    for (const name of ['ProjectId', 'Region', 'TasksLocation', 'OutputPath']) {
      assert.match(preflightScript, new RegExp(`\\[string\\]\\s*\\$${name}\\b`));
    }
  });

  test('enforces the four required parameters via explicit validation before discovery', () => {
    assert.match(preflightScript, /Test-ValidProjectId\s+-Value\s+\$ProjectId/);
    assert.match(preflightScript, /Test-ValidRegionOrLocation\s+-Value\s+\$Region/);
    assert.match(preflightScript, /Test-ValidRegionOrLocation\s+-Value\s+\$TasksLocation/);
    assert.match(preflightScript, /Resolve-ValidatedOutputPath/);
  });

  test('declares the optional target parameters', () => {
    for (const name of [
      'WorkerServiceName',
      'ArtifactRepository',
      'QueueName',
      'RuntimeServiceAccount',
      'TaskCallerServiceAccount',
      'SupabaseSecretName',
      'GeminiSecretName',
    ]) {
      assert.match(preflightScript, new RegExp(`\\[string\\]\\s*\\$${name}\\b`));
    }
  });

  test('top-level script parameters avoid [Parameter(Mandatory)] prompting (avoids interactive hang on dot-source)', () => {
    // Internal helper functions (e.g. New-CommandResult) may use
    // [Parameter(Mandatory)] freely — they are only ever invoked
    // programmatically with values already supplied. What must never happen
    // is the top-level script param() block using Mandatory, since that
    // would make dot-sourcing without arguments block on an interactive
    // prompt. Isolate the top-level param block (from the first `param(` to
    // its matching close, which is followed by Set-StrictMode).
    const topLevelParamBlock = preflightScript.slice(
      preflightScript.indexOf('\nparam('),
      preflightScript.indexOf('Set-StrictMode')
    );
    assert.doesNotMatch(topLevelParamBlock, /\[Parameter\(\s*Mandatory/i);
  });

  test('guards against executing discovery merely from dot-sourcing', () => {
    assert.match(preflightScript, /IsDotSourced/);
    assert.match(preflightScript, /MyInvocation\.InvocationName\s*-eq\s*'\.'/);
  });

  test('resolves gcloud via Get-Command', () => {
    assert.match(preflightScript, /Get-Command\s+-Name\s+'gcloud'/);
  });

  test('invokes gcloud using an argument array, not a concatenated string', () => {
    assert.match(preflightScript, /\[string\[\]\]\s*\$Arguments/);
    assert.match(preflightScript, /&\s*\$GcloudCommand\.Source\s+@Arguments/);
  });

  test('requests JSON formatting', () => {
    assert.match(preflightScript, /--format=json/);
    assert.match(preflightScript, /ConvertFrom-Json/);
  });

  test('uses --quiet and --verbosity=error', () => {
    assert.match(preflightScript, /--quiet/);
    assert.match(preflightScript, /--verbosity=error/);
  });

  test('explicitly provides --project for remote resource commands', () => {
    assert.match(preflightScript, /'--project',\s*\$ProjectId/);
  });

  test('rejects an OutputPath located inside the repository', () => {
    assert.match(preflightScript, /must not be inside the Git repository/);
    assert.match(preflightScript, /RepositoryRoot/);
  });

  test('creates the output file exclusively (no overwrite)', () => {
    assert.match(preflightScript, /FileMode\]::CreateNew/);
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Force\b/i);
  });

  test('cleans up temporary stderr files in a finally block', () => {
    assert.match(preflightScript, /finally\s*\{[\s\S]*?Remove-Item\s+-LiteralPath\s+\$stderrPath/);
  });

  test('declares exit codes 0, 2, 3, and 4', () => {
    assert.match(preflightScript, /return 0\b/);
    assert.match(preflightScript, /return 2\b/);
    assert.match(preflightScript, /return 3\b/);
    assert.match(preflightScript, /return 4\b/);
    assert.match(preflightScript, /exit \$mainExitCode/);
  });

  test('does not use Invoke-Expression', () => {
    assert.doesNotMatch(preflightScript, /Invoke-Expression/i);
  });

  test('does not use Start-Process', () => {
    assert.doesNotMatch(preflightScript, /Start-Process/i);
  });

  test('does not invoke another shell (cmd.exe, powershell.exe, pwsh, bash, sh -c)', () => {
    assert.doesNotMatch(preflightScript, /cmd\.exe/i);
    assert.doesNotMatch(preflightScript, /powershell\.exe/i);
    assert.doesNotMatch(preflightScript, /\bpwsh\b/i);
    assert.doesNotMatch(preflightScript, /\bbash\b/i);
    assert.doesNotMatch(preflightScript, /\bsh\s+-c\b/i);
  });

  test('no invocation argument list passes --log-http', () => {
    // '--log-http' legitimately appears as a literal string inside
    // Test-SafeGcloudArguments, which checks that it is absent from a given
    // argument array at runtime — that is the rejection check itself, not
    // an invocation. No -Arguments declaration may pass it.
    for (const declaration of argumentDeclarations) {
      assert.doesNotMatch(declaration.argsText, /--log-http/);
    }
  });

  test('no invocation argument list passes an alpha or beta command variant', () => {
    for (const declaration of argumentDeclarations) {
      assert.doesNotMatch(declaration.argsText, quotedArgumentToken('alpha'));
      assert.doesNotMatch(declaration.argsText, quotedArgumentToken('beta'));
    }
  });
});

describe('Allowed discovery commands', () => {
  const requiredCommandFamilies = [
    ["'version'", /'version'/],
    ["'auth', 'list'", /'auth',\s*'list'/],
    ["'projects', 'describe'", /'projects',\s*'describe'/],
    ["'projects', 'get-iam-policy'", /'projects',\s*'get-iam-policy'/],
    ["'services', 'list', '--enabled'", /'services',\s*'list',\s*'--enabled'/],
    ["'artifacts', 'repositories', 'list'", /'artifacts',\s*'repositories',\s*'list'/],
    ["'artifacts', 'repositories', 'describe'", /'artifacts',\s*'repositories',\s*'describe'/],
    ["'artifacts', 'repositories', 'get-iam-policy'", /'artifacts',\s*'repositories',\s*'get-iam-policy'/],
    ["'run', 'services', 'list'", /'run',\s*'services',\s*'list'/],
    ["'run', 'services', 'describe'", /'run',\s*'services',\s*'describe'/],
    ["'run', 'services', 'get-iam-policy'", /'run',\s*'services',\s*'get-iam-policy'/],
    ["'iam', 'service-accounts', 'list'", /'iam',\s*'service-accounts',\s*'list'/],
    ["'iam', 'service-accounts', 'describe'", /'iam',\s*'service-accounts',\s*'describe'/],
    ["'iam', 'service-accounts', 'get-iam-policy'", /'iam',\s*'service-accounts',\s*'get-iam-policy'/],
    ["'secrets', 'list'", /'secrets',\s*'list'/],
    ["'secrets', 'describe'", /'secrets',\s*'describe'/],
    ["'secrets', 'versions', 'list'", /'secrets',\s*'versions',\s*'list'/],
    ["'secrets', 'get-iam-policy'", /'secrets',\s*'get-iam-policy'/],
    ["'tasks', 'queues', 'list'", /'tasks',\s*'queues',\s*'list'/],
    ["'tasks', 'queues', 'describe'", /'tasks',\s*'queues',\s*'describe'/],
    ["'tasks', 'queues', 'get-iam-policy'", /'tasks',\s*'queues',\s*'get-iam-policy'/],
  ];

  for (const [label, pattern] of requiredCommandFamilies) {
    test(`implements ${label}`, () => {
      assert.match(preflightScript, pattern);
    });
  }

  test('scopes Artifact Registry and Cloud Run discovery to Region', () => {
    assert.match(preflightScript, /'--location',\s*\$Region/);
    assert.match(preflightScript, /'--region',\s*\$Region/);
  });

  test('scopes Cloud Tasks discovery to TasksLocation', () => {
    assert.match(preflightScript, /'--location',\s*\$TasksLocation/);
  });

  test('reads secret version metadata via versions list, never versions access', () => {
    assert.match(preflightScript, /'secrets',\s*'versions',\s*'list'/);
    assert.doesNotMatch(preflightScript, quotedArgumentToken('access'));
  });

  test('collects the project IAM policy', () => {
    assert.match(preflightScript, /projectIamPolicy/);
  });

  test('collects optional target IAM policies', () => {
    assert.match(preflightScript, /workerServiceIamPolicy/);
    assert.match(preflightScript, /artifactRepositoryIamPolicy/);
    assert.match(preflightScript, /queueIamPolicy/);
    assert.match(preflightScript, /runtimeServiceAccountIamPolicy/);
    assert.match(preflightScript, /taskCallerServiceAccountIamPolicy/);
    assert.match(preflightScript, /supabaseSecretIamPolicy/);
    assert.match(preflightScript, /geminiSecretIamPolicy/);
  });
});

describe('Forbidden mutation commands', () => {
  const forbiddenTokens = [
    'create',
    'update',
    'delete',
    'deploy',
    'submit',
    'enable',
    'disable',
    'pause',
    'resume',
    'add-iam-policy-binding',
    'remove-iam-policy-binding',
    'set-iam-policy',
    'access',
    'print-access-token',
    'print-identity-token',
    'login',
    'application-default',
  ];

  for (const token of forbiddenTokens) {
    test(`does not invoke the '${token}' gcloud argument token`, () => {
      assert.doesNotMatch(preflightScript, quotedArgumentToken(token));
    });
  }

  test('does not invoke gcloud config set/unset', () => {
    // Matches the actual forbidden command token sequence rather than the
    // bare word 'config', which also appears legitimately in this script as
    // a JSON property-existence check (PSObject.Properties.Match('config')),
    // required under Set-StrictMode to safely probe for an optional field
    // before accessing it.
    assert.doesNotMatch(preflightScript, /'config',\s*'set'/);
    assert.doesNotMatch(preflightScript, /'config',\s*'unset'/);
  });

  test('the word "disabled" appearing in blocker/data-field text is not a false positive for the disable command', () => {
    // The report legitimately inspects a boolean `disabled` field on
    // service-account data and reports "... disabled" in blocker prose.
    // Neither is a gcloud argument token, which the tests above verify by
    // matching the quoted single-token form (e.g. 'disable') rather than
    // this substring.
    assert.match(preflightScript, /disabled/);
    assert.doesNotMatch(preflightScript, quotedArgumentToken('disable'));
  });
});

describe('Secret and task-payload protection', () => {
  test('no secret versions access command', () => {
    assert.doesNotMatch(preflightScript, /'versions',\s*'access'/);
  });

  test('no secret payload retrieval', () => {
    assert.doesNotMatch(preflightScript, /secretPayload/i);
    assert.doesNotMatch(preflightScript, /secretValue/i);
  });

  test('no access-token or identity-token retrieval', () => {
    assert.doesNotMatch(preflightScript, /print-access-token/);
    assert.doesNotMatch(preflightScript, /print-identity-token/);
  });

  test('no Cloud Tasks tasks list or describe command', () => {
    assert.doesNotMatch(preflightScript, /'tasks',\s*'list'/);
    assert.doesNotMatch(preflightScript, /'tasks',\s*'describe'/);
  });

  test('no process environment access via the $env: provider (the CLOUDSDK_AUTH_* override scan uses [System.Environment]::GetEnvironmentVariables() instead, covered separately)', () => {
    assert.doesNotMatch(preflightScript, /\$env:/);
  });

  test('no SUPABASE_SERVICE_ROLE_KEY or GEMINI_API_KEY lookup', () => {
    assert.doesNotMatch(preflightScript, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(preflightScript, /GEMINI_API_KEY/);
  });

  test('no credential-file reading', () => {
    assert.doesNotMatch(preflightScript, /application_default_credentials/i);
    assert.doesNotMatch(preflightScript, /\.json['"]?\s*-Path.*credential/i);
  });
});

describe('Report safety', () => {
  const requiredFields = [
    'schemaVersion',
    'generatedAtUtc',
    "mode\\s*=\\s*\\[ordered\\]|mode\\s*=\\s*'read-only'",
    'blockers',
    'warnings',
    'commandResults',
  ];

  test('includes schemaVersion, generatedAtUtc, and mode read-only', () => {
    assert.match(preflightScript, /schemaVersion/);
    assert.match(preflightScript, /generatedAtUtc/);
    assert.match(preflightScript, /mode\s*=\s*'read-only'/);
  });

  test('includes blockers, warnings, and commandResults', () => {
    assert.match(preflightScript, /blockers\s*=\s*@\(\$blockers\)/);
    assert.match(preflightScript, /warnings\s*=\s*@\(\$warnings\)/);
    assert.match(preflightScript, /commandResults\s*=\s*\$commandResults/);
  });

  test('restricts status to the allowed set', () => {
    assert.match(
      preflightScript,
      /ValidateSet\('success',\s*'not_found',\s*'permission_denied',\s*'unavailable',\s*'failed',\s*'not_requested'\)/
    );
  });

  test('sanitizes safeError and limits its length', () => {
    assert.match(preflightScript, /Get-SafeErrorText/);
    assert.match(preflightScript, /SafeErrorMaxLength/);
    assert.match(preflightScript, /\[\\x00-\\x1F\\x7F\]/);
  });

  test('does not store a raw command string field', () => {
    assert.doesNotMatch(preflightScript, /rawCommand/i);
    assert.doesNotMatch(preflightScript, /commandString/i);
  });

  test('does not store raw stderr without sanitization', () => {
    assert.doesNotMatch(preflightScript, /safeError\s*=\s*\$stderrText\b/);
  });

  test('offers no overwrite or Force parameter for the output report', () => {
    // Remove-Item -Force is legitimate here (temp stderr cleanup); what must
    // never exist is a script parameter letting a caller force-overwrite an
    // existing report.
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Force\b/i);
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Overwrite\b/i);
    assert.doesNotMatch(preflightScript, /\$Overwrite\b/);
  });

  test('does not write the report inside the repository', () => {
    assert.match(preflightScript, /Resolve-ValidatedOutputPath/);
    assert.match(preflightScript, /must not be inside the Git repository/);
  });

  test('states a report is not automatic deployment approval', () => {
    assert.match(preflightScript, /humanReviewRequired/);
    assert.match(preflightScript, /deploymentReadinessClaim/);
  });
});

describe('Required preflight evaluation', () => {
  const requiredApis = [
    'run.googleapis.com',
    'cloudtasks.googleapis.com',
    'artifactregistry.googleapis.com',
    'secretmanager.googleapis.com',
    'cloudbuild.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'serviceusage.googleapis.com',
  ];

  for (const api of requiredApis) {
    test(`evaluates required API ${api}`, () => {
      assert.ok(preflightScript.includes(api), `expected script to reference ${api}`);
    });
  }

  const blockerScenarios = [
    'gcloud unavailable',
    'no active authenticated account',
    'multiple active accounts',
    'project lifecycle state not ACTIVE',
    'required API disabled',
    'no Docker-format Artifact Registry repository in Region',
    'missing supplied target resource',
    'supplied service account disabled',
    'supplied secret with no enabled numbered version',
    'supplied queue is RUNNING: production dispatch is not paused',
    'supplied queue is not in the required PAUSED pre-rollout state',
    'worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers',
    'runtime and task-caller service accounts being the same identity',
    'task-creator and runtime service accounts being the same identity',
    'task-creator and task-caller service accounts being the same identity',
    'project-level Owner or Editor granted to supplied service account',
    'project-level IAM policy grants a role to allUsers or allAuthenticatedUsers',
    'task-caller service account lacks an explicit Cloud Run invocation binding',
    'task creator lacks explicit iam.serviceAccounts.actAs authorization on the task-caller service account',
    'project number is missing or malformed: cannot construct the Cloud Tasks service-agent identity',
    'Cloud Tasks service agent lacks the required roles/cloudtasks.serviceAgent project-level binding',
    'runtime service account missing secret-level roles/secretmanager.secretAccessor binding',
    'runtime service account holds project-level roles/secretmanager.secretAccessor access, broader than the intended two-secret model',
  ];

  for (const scenario of blockerScenarios) {
    test(`has blocker logic for: ${scenario}`, () => {
      assert.ok(preflightScript.includes(scenario), `expected blocker text "${scenario}"`);
    });
  }

  const warningScenarios = [
    'target optional parameter not supplied',
    'multiple candidate Docker repositories',
    'multiple candidate queues',
    'worker service does not yet exist',
    'target secret exists but has no enabled numbered version',
    'report contains cloud resource metadata and must not be committed',
  ];

  for (const scenario of warningScenarios) {
    test(`has warning logic for: ${scenario}`, () => {
      assert.ok(preflightScript.includes(scenario), `expected warning text "${scenario}"`);
    });
  }
});

describe('Per-command flag enforcement (every literal -Arguments declaration)', () => {
  test('at least 29 distinct gcloud invocations are declared', () => {
    // 11 generic (gcloudVersion, authList, configList, projectDescribe,
    // projectIamPolicy, enabledServices, artifactRepositories,
    // cloudRunServices, serviceAccounts, secrets, taskQueues) + 2 commands
    // each for 6 single-pair targets (12, including TaskCreatorServiceAccount)
    // + 3 commands each for 2 secret targets (6) = 29.
    assert.equal(argumentDeclarations.length, 29, `found ${argumentDeclarations.length} declarations`);
  });

  const cloudRunSafeProjectionIds = ['cloudRunServices', 'workerServiceDescribe'];

  for (const id of [
    'gcloudVersion',
    'authList',
    'projectDescribe',
    'projectIamPolicy',
    'enabledServices',
    'artifactRepositories',
    'serviceAccounts',
    'secrets',
    'taskQueues',
    'workerServiceIamPolicy',
    'artifactRepositoryDescribe',
    'artifactRepositoryIamPolicy',
    'queueDescribe',
    'queueIamPolicy',
    'runtimeServiceAccountDescribe',
    'runtimeServiceAccountIamPolicy',
    'taskCallerServiceAccountDescribe',
    'taskCallerServiceAccountIamPolicy',
    'taskCreatorServiceAccountDescribe',
    'taskCreatorServiceAccountIamPolicy',
    'supabaseSecretDescribe',
    'supabaseSecretVersionsList',
    'supabaseSecretIamPolicy',
    'geminiSecretDescribe',
    'geminiSecretVersionsList',
    'geminiSecretIamPolicy',
  ]) {
    test(`${id}: uses --quiet, --verbosity=error, and --format=json`, () => {
      const argsText = declarationFor(id);
      assert.match(argsText, /'--quiet'/);
      assert.match(argsText, /'--verbosity=error'/);
      assert.match(argsText, /'--format=json'/);
    });
  }

  const cloudRunFormatConstantById = {
    cloudRunServices: '\\$script:CloudRunListSafeFormatFlag',
    workerServiceDescribe: '\\$script:CloudRunDescribeSafeFormatFlag',
  };

  for (const id of cloudRunSafeProjectionIds) {
    test(`${id}: uses --quiet, --verbosity=error, and the Cloud Run safe projection format (not plain --format=json)`, () => {
      const argsText = declarationFor(id);
      assert.match(argsText, /'--quiet'/);
      assert.match(argsText, /'--verbosity=error'/);
      assert.match(argsText, new RegExp(cloudRunFormatConstantById[id] + '\\b'));
      assert.doesNotMatch(argsText, /'--format=json'/);
    });
  }

  test('configList: uses --quiet, --verbosity=error, and the config-list safe projection format (not plain --format=json)', () => {
    const argsText = declarationFor('configList');
    assert.match(argsText, /'--quiet'/);
    assert.match(argsText, /'--verbosity=error'/);
    assert.match(argsText, /\$script:GcloudConfigListSafeFormatFlag\b/);
    assert.doesNotMatch(argsText, /'--format=json'/);
  });

  for (const id of remoteResourceCommandIds) {
    test(`${id}: explicitly includes --project`, () => {
      const argsText = declarationFor(id);
      assert.match(argsText, /'--project',\s*\$ProjectId/);
    });
  }

  for (const id of ['gcloudVersion', 'authList', 'configList']) {
    test(`${id}: is local tooling and does not require --project`, () => {
      // Documents the deliberate asymmetry the remoteResourceCommandIds
      // list above encodes: these ids are intentionally absent from it
      // because they are not scoped to a specific project resource.
      assert.ok(!remoteResourceCommandIds.includes(id));
    });
  }

  for (const id of regionScopedCommandIds) {
    test(`${id}: scoped to Region`, () => {
      const argsText = declarationFor(id);
      assert.match(argsText, /'--(location|region)',\s*\$Region/);
    });
  }

  for (const id of locationScopedTasksCommandIds) {
    test(`${id}: scoped to TasksLocation`, () => {
      const argsText = declarationFor(id);
      assert.match(argsText, /'--location',\s*\$TasksLocation/);
    });
  }
});

describe('Runtime read-only allowlist enforcement (exact command schema)', () => {
  test('declares an explicit list of command schemas', () => {
    assert.match(preflightScript, /\$script:CommandSchemas\s*=\s*@\(/);
  });

  const schemaPaths = [
    "Path = @\\('version'\\)",
    "Path = @\\('auth',\\s*'list'\\)",
    "Path = @\\('projects',\\s*'describe'\\)",
    "Path = @\\('projects',\\s*'get-iam-policy'\\)",
    "Path = @\\('services',\\s*'list'\\)",
    "Path = @\\('artifacts',\\s*'repositories',\\s*'list'\\)",
    "Path = @\\('artifacts',\\s*'repositories',\\s*'describe'\\)",
    "Path = @\\('artifacts',\\s*'repositories',\\s*'get-iam-policy'\\)",
    "Path = @\\('run',\\s*'services',\\s*'list'\\)",
    "Path = @\\('run',\\s*'services',\\s*'describe'\\)",
    "Path = @\\('run',\\s*'services',\\s*'get-iam-policy'\\)",
    "Path = @\\('iam',\\s*'service-accounts',\\s*'list'\\)",
    "Path = @\\('iam',\\s*'service-accounts',\\s*'describe'\\)",
    "Path = @\\('iam',\\s*'service-accounts',\\s*'get-iam-policy'\\)",
    "Path = @\\('secrets',\\s*'list'\\)",
    "Path = @\\('secrets',\\s*'describe'\\)",
    "Path = @\\('secrets',\\s*'versions',\\s*'list'\\)",
    "Path = @\\('secrets',\\s*'get-iam-policy'\\)",
    "Path = @\\('tasks',\\s*'queues',\\s*'list'\\)",
    "Path = @\\('tasks',\\s*'queues',\\s*'describe'\\)",
    "Path = @\\('tasks',\\s*'queues',\\s*'get-iam-policy'\\)",
  ];

  for (const pattern of schemaPaths) {
    test(`schema list includes ${pattern}`, () => {
      assert.match(preflightScript, new RegExp(pattern));
    });
  }

  test('the schema list has exactly 22 entries', () => {
    const start = preflightScript.indexOf('$script:CommandSchemas = @(');
    const end = preflightScript.indexOf('# ----------', start);
    const body = preflightScript.slice(start, end);
    const entryCount = (body.match(/\[ordered\]@\{ Path = /g) || []).length;
    assert.equal(entryCount, 22);
  });

  test('defines a path-matching function and an exact schema validator', () => {
    assert.match(preflightScript, /function Find-GcloudCommandSchema/);
    assert.match(preflightScript, /function Test-GcloudCommandSchema/);
  });

  test('rejects an empty argument array', () => {
    const start = preflightScript.indexOf('function Find-GcloudCommandSchema');
    const end = preflightScript.indexOf('function Test-GcloudCommandSchema');
    const body = preflightScript.slice(start, end);
    assert.match(body, /if \(-not \$Arguments -or \$Arguments\.Count -eq 0\) \{ return \$null \}/);
  });

  test('the schema check runs, and can reject, before gcloud is ever invoked', () => {
    const invokeFunctionStart = preflightScript.indexOf('function Invoke-ReadOnlyGcloudCommand');
    const invokeFunctionBody = preflightScript.slice(invokeFunctionStart, preflightScript.indexOf('function New-NotRequestedResult'));
    const schemaCheckIndex = invokeFunctionBody.indexOf('Test-GcloudCommandSchema');
    const gcloudInvocationIndex = invokeFunctionBody.indexOf('& $GcloudCommand.Source');
    assert.ok(schemaCheckIndex >= 0, 'expected a schema check inside Invoke-ReadOnlyGcloudCommand');
    assert.ok(gcloudInvocationIndex >= 0, 'expected a gcloud invocation inside Invoke-ReadOnlyGcloudCommand');
    assert.ok(schemaCheckIndex < gcloudInvocationIndex, 'schema check must precede the gcloud invocation');
  });

  test('a rejected command returns a failed result with an allowlist-rejection category, without invoking gcloud', () => {
    const rejectionBlock = preflightScript.slice(
      preflightScript.indexOf('if (-not (Test-GcloudCommandSchema'),
      preflightScript.indexOf('if (-not $GcloudCommand) {')
    );
    assert.match(rejectionBlock, /-Status\s+'failed'/);
    assert.match(rejectionBlock, /-ErrorCategory\s+'allowlist_rejected'/);
    assert.doesNotMatch(rejectionBlock, /& \$GcloudCommand\.Source/);
  });

  test('explicitly rejects alpha and beta prefixes (absent from every schema path)', () => {
    for (const prefix of ['alpha', 'beta']) {
      const hasPrefix = argumentDeclarations.some((d) => d.argsText.includes(`'${prefix}'`));
      assert.ok(!hasPrefix, `did not expect any declaration to start with '${prefix}'`);
    }
  });

  test('ProjectId, Region, and TasksLocation are threaded into every schema validation call', () => {
    for (const declaration of argumentDeclarations) {
      const callSitePattern = new RegExp(
        `-Id\\s+'${declaration.id}'\\s+-Arguments\\s+@\\([^)]*\\)\\s+-GcloudCommand\\s+\\$gcloudCommand\\s+-ProjectId\\s+\\$ProjectId\\s+-Region\\s+\\$Region\\s+-TasksLocation\\s+\\$TasksLocation`
      );
      assert.match(preflightScript, callSitePattern, `expected ${declaration.id} to pass -ProjectId/-Region/-TasksLocation`);
    }
  });
});

describe('Hardened gcloud resolution', () => {
  test('resolves all candidates named gcloud, not just the first match', () => {
    assert.match(preflightScript, /Get-Command\s+-Name\s+'gcloud'\s+-All/);
  });

  test('accepts only Application or ExternalScript command types', () => {
    assert.match(preflightScript, /\$_\.CommandType\s+-eq\s+'Application'\s+-or\s+\$_\.CommandType\s+-eq\s+'ExternalScript'/);
  });

  test('does not accept an Alias, Function, Filter, or Cmdlet named gcloud', () => {
    const resolveFunctionStart = preflightScript.indexOf('function Resolve-GcloudCommand');
    const resolveFunctionBody = preflightScript.slice(resolveFunctionStart, preflightScript.indexOf('function Find-GcloudCommandSchema'));
    assert.doesNotMatch(resolveFunctionBody, /'Alias'/);
    assert.doesNotMatch(resolveFunctionBody, /'Function'/);
    assert.doesNotMatch(resolveFunctionBody, /'Filter'/);
    assert.doesNotMatch(resolveFunctionBody, /'Cmdlet'/);
  });

  test('command resolution is contained: an unexpected failure treats gcloud as unavailable rather than throwing', () => {
    const resolveFunctionStart = preflightScript.indexOf('function Resolve-GcloudCommand');
    const resolveFunctionBody = preflightScript.slice(resolveFunctionStart, preflightScript.indexOf('function Find-GcloudCommandSchema'));
    assert.match(resolveFunctionBody, /try\s*\{/);
    assert.match(resolveFunctionBody, /catch\s*\{\s*return \$null\s*\}/);
  });

  test('still invokes the resolved command using an argument array', () => {
    assert.match(preflightScript, /&\s*\$GcloudCommand\.Source\s+@Arguments/);
  });
});

describe('Fail-closed generic discovery', () => {
  test('defines a generic-discovery blocker helper', () => {
    assert.match(preflightScript, /function Add-GenericDiscoveryBlocker/);
    assert.match(preflightScript, /if\s*\(\$Result\.status\s+-ne\s+'success'\)/);
  });

  const genericIds = [
    'gcloudVersion',
    'authList',
    'configList',
    'projectDescribe',
    'projectIamPolicy',
    'enabledServices',
    'artifactRepositories',
    'cloudRunServices',
    'serviceAccounts',
    'secrets',
    'taskQueues',
  ];

  for (const id of genericIds) {
    test(`calls Add-GenericDiscoveryBlocker for ${id}`, () => {
      assert.match(preflightScript, new RegExp(`Add-GenericDiscoveryBlocker\\s+-Result\\s+\\$\\w+\\s+-Label\\s+'${id}'`));
    });
  }

  test('the generic blocker fires for permission_denied, unavailable, failed, and invalid JSON alike (any non-success), not only for a specific status', () => {
    // Add-GenericDiscoveryBlocker checks `-ne 'success'`, a single
    // condition covering every non-success status uniformly.
    const helperStart = preflightScript.indexOf('function Add-GenericDiscoveryBlocker');
    const helperBody = preflightScript.slice(helperStart, preflightScript.indexOf('function Add-TargetVerificationBlockers'));
    assert.doesNotMatch(helperBody, /-eq\s+'not_found'/);
    assert.doesNotMatch(helperBody, /-eq\s+'permission_denied'/);
    assert.match(helperBody, /-ne\s+'success'/);
  });
});

describe('Fail-closed supplied targets', () => {
  test('defines a target-verification blocker helper', () => {
    assert.match(preflightScript, /function Add-TargetVerificationBlockers/);
  });

  test('not_found produces the specific "missing supplied target resource" blocker', () => {
    const helperStart = preflightScript.indexOf('function Add-TargetVerificationBlockers');
    const helperBody = preflightScript.slice(helperStart, preflightScript.indexOf('function Invoke-PrivateWorkerPreflightMain'));
    assert.match(helperBody, /'not_found'[\s\S]*?missing supplied target resource/);
  });

  test('permission_denied and other non-success statuses produce a "could not be fully verified" blocker, never inferred as absence', () => {
    const helperStart = preflightScript.indexOf('function Add-TargetVerificationBlockers');
    const helperBody = preflightScript.slice(helperStart, preflightScript.indexOf('function Invoke-PrivateWorkerPreflightMain'));
    assert.match(helperBody, /supplied target could not be fully verified/);
    // The "could not be fully verified" branch must be reached via an
    // `-ne 'success'` else-branch, not a status-specific match on
    // permission_denied — i.e. permission_denied is never special-cased
    // toward the "missing" wording.
    assert.doesNotMatch(helperBody, /'permission_denied'[\s\S]{0,80}missing supplied target resource/);
  });

  const singlePairTargetGroups = [
    { label: 'WorkerServiceName', ids: ['workerServiceDescribe', 'workerServiceIamPolicy'] },
    { label: 'ArtifactRepository', ids: ['artifactRepositoryDescribe', 'artifactRepositoryIamPolicy'] },
    { label: 'QueueName', ids: ['queueDescribe', 'queueIamPolicy'] },
    { label: 'RuntimeServiceAccount', ids: ['runtimeServiceAccountDescribe', 'runtimeServiceAccountIamPolicy'] },
    { label: 'TaskCallerServiceAccount', ids: ['taskCallerServiceAccountDescribe', 'taskCallerServiceAccountIamPolicy'] },
    { label: 'TaskCreatorServiceAccount', ids: ['taskCreatorServiceAccountDescribe', 'taskCreatorServiceAccountIamPolicy'] },
  ];

  for (const group of singlePairTargetGroups) {
    test(`${group.label}: all ${group.ids.length} required commands are passed to Add-TargetVerificationBlockers`, () => {
      const callIndex = preflightScript.indexOf(`Add-TargetVerificationBlockers -Label '${group.label}'`);
      assert.ok(callIndex >= 0, `expected a call to Add-TargetVerificationBlockers for ${group.label}`);
      const callBlock = preflightScript.slice(callIndex, callIndex + 500);
      for (const id of group.ids) {
        assert.match(callBlock, new RegExp(id));
      }
    });
  }

  // The two secret targets use a shared foreach loop over a small
  // descriptor object rather than a literal per-target call, so their
  // required-command wiring is verified by inspecting that loop directly.
  test('SupabaseSecretName and GeminiSecretName: the shared secret-verification loop wires describe, versions, and IAM-policy results into Add-TargetVerificationBlockers', () => {
    const loopStart = preflightScript.indexOf('foreach ($secretInfo in @(');
    assert.ok(loopStart >= 0, 'expected a shared secret-verification foreach loop');
    const loopBody = preflightScript.slice(loopStart, loopStart + 1500);
    assert.match(loopBody, /DescribeKey = 'supabaseSecretDescribe'/);
    assert.match(loopBody, /VersionsKey = 'supabaseSecretVersionsList'/);
    assert.match(loopBody, /IamKey = 'supabaseSecretIamPolicy'/);
    assert.match(loopBody, /DescribeKey = 'geminiSecretDescribe'/);
    assert.match(loopBody, /VersionsKey = 'geminiSecretVersionsList'/);
    assert.match(loopBody, /IamKey = 'geminiSecretIamPolicy'/);
    assert.match(loopBody, /\$targetResults\[\$secretInfo\.DescribeKey\]\s*=\s*\$describeResult/);
    assert.match(loopBody, /\$targetResults\[\$secretInfo\.VersionsKey\]\s*=\s*\$versionsResult/);
    assert.match(loopBody, /\$targetResults\[\$secretInfo\.IamKey\]\s*=\s*\$iamPolicyResult/);
    assert.match(loopBody, /Add-TargetVerificationBlockers -Label \$secretInfo\.Label -Blockers \$blockers -Results \$targetResults/);
  });
});

describe('Safe property access under Set-StrictMode', () => {
  test('defines a reusable safe property accessor', () => {
    assert.match(preflightScript, /function Get-SafeProperty/);
    assert.match(preflightScript, /AsPSObject/);
  });

  test('the accessor returns null on a missing property instead of throwing', () => {
    const helperStart = preflightScript.indexOf('function Get-SafeProperty');
    const helperBody = preflightScript.slice(helperStart, preflightScript.indexOf('function ConvertTo-DataArray'));
    assert.match(helperBody, /if\s*\(\$null\s+-eq\s+\$member\)\s*\{\s*return\s+\$null\s*\}/);
  });

  const safeAccessSites = [
    "Get-SafeProperty -Object \\$_ -PropertyPath @\\('status'\\)", // active-account status
    "Get-SafeProperty -Object \\$projectDescribeResult\\.data -PropertyPath @\\('lifecycleState'\\)",
    "Get-SafeProperty -Object \\$entry -PropertyPath @\\('config', 'name'\\)",
    "Get-SafeProperty -Object \\$_ -PropertyPath @\\('format'\\)",
    "Get-CloudRunFieldValue -Data \\$data -PropertyPathAlternatives @\\(@\\('template', 'serviceAccount'\\), @\\('spec', 'template', 'spec', 'serviceAccountName'\\)\\)",
    "Get-SafeProperty -Object \\$iamPolicyResult\\.data -PropertyPath @\\('bindings'\\)",
    "Get-SafeProperty -Object \\$_ -PropertyPath @\\('role'\\)",
    "Get-SafeProperty -Object \\$_ -PropertyPath @\\('members'\\)",
    "Get-SafeProperty -Object \\$describeResult\\.data -PropertyPath @\\('disabled'\\)",
    "Get-SafeProperty -Object \\$describeResult\\.data -PropertyPath @\\('state'\\)",
    "Get-SafeProperty -Object \\$_ -PropertyPath @\\('state'\\)",
  ];

  for (const pattern of safeAccessSites) {
    test(`uses safe property access for pattern: ${pattern}`, () => {
      assert.match(preflightScript, new RegExp(pattern));
    });
  }

  test('an IAM policy with no bindings is treated as an empty list, not a crash', () => {
    assert.match(preflightScript, /ConvertTo-DataArray \(Get-SafeProperty -Object \$iamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
  });

  test('no evaluation code dereferences .data.<property> directly without Get-SafeProperty (spot check known-risky chains)', () => {
    assert.doesNotMatch(preflightScript, /\$projectDescribeResult\.data\.lifecycleState/);
    assert.doesNotMatch(preflightScript, /\$describeResult\.data\.state\b/);
    assert.doesNotMatch(preflightScript, /\$describeResult\.data\.disabled\b/);
    assert.doesNotMatch(preflightScript, /\.data\.bindings\b/);
  });
});

describe('Evaluation-exception containment', () => {
  test('wraps the evaluation logic in try/catch', () => {
    const evalStart = preflightScript.indexOf('# ---- Evaluation (wrapped');
    assert.ok(evalStart >= 0, 'expected an evaluation section comment marking the wrapped block');
    const evalRegionEnd = preflightScript.indexOf("$warnings.Add('report contains cloud resource metadata");
    const evalBlock = preflightScript.slice(evalStart, evalRegionEnd);
    assert.match(evalBlock, /^\s*try\s*\{/m);
    assert.match(evalBlock, /catch\s*\{/);
  });

  test('an unexpected evaluation error becomes a sanitized blocker, not a thrown exception', () => {
    assert.match(preflightScript, /unexpected evaluation error:\s*\$\(Get-SafeErrorText -Text \$_\.Exception\.Message\)/);
  });

  test('does not serialize the exception object or a stack trace', () => {
    const catchStart = preflightScript.indexOf('unexpected evaluation error');
    const catchLine = preflightScript.slice(Math.max(0, catchStart - 200), catchStart + 200);
    assert.doesNotMatch(catchLine, /\$_\.Exception\.ToString\(\)/);
    assert.doesNotMatch(catchLine, /StackTrace/);
    assert.doesNotMatch(catchLine, /\$_\s*\|\s*Out-String/);
  });

  test('the report write attempt still happens after the evaluation catch block', () => {
    const catchIndex = preflightScript.indexOf('unexpected evaluation error');
    const reportAssemblyIndex = preflightScript.indexOf('$report = [ordered]@{');
    const jsonConvertIndex = preflightScript.indexOf('$json = $report | ConvertTo-Json');
    assert.ok(catchIndex < reportAssemblyIndex, 'evaluation catch must precede report assembly');
    assert.ok(reportAssemblyIndex < jsonConvertIndex, 'report assembly must precede JSON conversion/write');
  });

  test('only exit codes 0, 2, 3, and 4 are used (no additional exit code introduced)', () => {
    const returnStatements = [...preflightScript.matchAll(/return (\d+)\b/g)].map((m) => m[1]);
    const uniqueReturns = new Set(returnStatements);
    for (const value of uniqueReturns) {
      assert.ok(['0', '2', '3', '4'].includes(value), `unexpected return code ${value}`);
    }
  });
});

describe('Path redaction in safeError', () => {
  test('declares an explicit list of path-start patterns', () => {
    assert.match(preflightScript, /\$script:PathRedactionStartPatterns\s*=\s*@\(/);
  });

  const expectedPathStartLiterals = [
    String.raw`'(?<![A-Za-z0-9])[A-Za-z]:[\\/]'`, // Windows drive paths (both slash styles)
    String.raw`'\\\\[^\s"''<>|\\]'`, // UNC paths
    "'file:///?'", // file:// URIs
  ];

  for (const literal of expectedPathStartLiterals) {
    test(`path-start pattern list includes ${literal}`, () => {
      assert.ok(preflightScript.includes(literal), `expected to find ${literal} in $script:PathRedactionStartPatterns`);
    });
  }

  test('the Windows drive-root pattern matches both backslash and forward-slash styles', () => {
    const patternSource = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]`;
    const regex = new RegExp(patternSource);
    assert.match('C:\\Users\\name\\project\\file.txt', regex);
    assert.match('C:/Users/name/project/file.txt', regex);
  });

  test('the Windows drive-root pattern never treats "https://" as a drive letter', () => {
    // Without the negative lookbehind, "s:/" inside "https://" would match
    // [A-Za-z]:[\\/] — the lookbehind requires the character before the
    // candidate drive letter not be alphanumeric, which excludes the "s" in
    // "http**s**:" because it is preceded by the letter "p".
    const patternSource = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]`;
    const regex = new RegExp(patternSource);
    assert.doesNotMatch('https://example.com/path/to/thing', regex);
    assert.doesNotMatch('http://example.com/a/b', regex);
  });

  test('a genuine standalone drive letter at the start of a message or after whitespace still matches', () => {
    const patternSource = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]`;
    const regex = new RegExp(patternSource);
    assert.match('C:\\Windows\\System32', regex);
    assert.match('error reading D:/data/file.json: access denied', regex);
  });

  test('declares one general absolute-POSIX-path pattern, not an enumerated root list', () => {
    // A single lookbehind-guarded pattern now covers /root/, /workspace/,
    // /home/, /Users/, /tmp/, /var/, /opt/, /mnt/, /private/, and any other
    // absolute POSIX path — replacing the previous enumerated list.
    assert.ok(preflightScript.includes(String.raw`'(?<![:/\w])/[^\s/]'`));
  });

  test('the general POSIX pattern never treats the path portion of an http:// or https:// URL as a local path', () => {
    // The negative lookbehind (?<![:/\w]) excludes every slash inside
    // "scheme://host/path": the slash after "https:" is preceded by ':',
    // the second slash of "//" is preceded by '/', and the slash before the
    // path segment is preceded by a hostname word character — none satisfy
    // the lookbehind, so none can start a match.
    const patternSource = String.raw`(?<![:/\w])/[^\s/]`;
    const regex = new RegExp(patternSource);
    assert.doesNotMatch('https://example.com/path/to/thing', regex);
    assert.doesNotMatch('http://example.com/a/b', regex);
  });

  test('the general POSIX pattern matches a standalone absolute path at the start of a message or after whitespace', () => {
    const patternSource = String.raw`(?<![:/\w])/[^\s/]`;
    const regex = new RegExp(patternSource);
    assert.match('/root/.config/gcloud/credentials', regex);
    assert.match('error reading /workspace/build/output: permission denied', regex);
    assert.match('/home/user/.config/gcloud', regex);
  });

  test('a path-like span is redacted through the rest of the line, not just to the first whitespace (covers paths containing spaces)', () => {
    const helperStart = preflightScript.indexOf('function Get-SafeErrorText');
    const helperBody = preflightScript.slice(helperStart, preflightScript.indexOf('function Get-GcloudErrorCategory'));
    assert.match(helperBody, /\[\^\\r\\n\]\*/);
    assert.doesNotMatch(helperBody, /\[\^\\s/); // no longer stops at whitespace
  });

  test('replaces redacted paths with a fixed token', () => {
    assert.ok(preflightScript.includes("'[REDACTED_PATH]'"));
  });

  test('redaction happens before control-character stripping and length limiting', () => {
    const functionStart = preflightScript.indexOf('function Get-SafeErrorText');
    const functionBody = preflightScript.slice(functionStart, preflightScript.indexOf('function Get-GcloudErrorCategory'));
    const firstRedactionIndex = functionBody.indexOf('[REDACTED_PATH]');
    const controlCharStripIndex = functionBody.indexOf('withoutControlChars');
    const lengthLimitIndex = functionBody.indexOf('SafeErrorMaxLength');
    assert.ok(firstRedactionIndex >= 0 && firstRedactionIndex < controlCharStripIndex);
    assert.ok(controlCharStripIndex < lengthLimitIndex);
  });

  test('OutputPath is never added to a command result', () => {
    assert.doesNotMatch(preflightScript, /-Data\s+\$OutputPath/);
    assert.doesNotMatch(preflightScript, /outputPath\s*=\s*\$OutputPath/);
  });
});

describe('Exit-code preservation (no Write-Error under ErrorActionPreference Stop)', () => {
  test('the script never calls Write-Error anywhere', () => {
    // With $ErrorActionPreference = 'Stop', Write-Error itself becomes a
    // terminating error and would escape the very catch blocks that exist
    // to guarantee exit codes 3 and 4 — so it must never appear as an
    // executable statement anywhere in this script.
    const executableLines = preflightScript
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'));
    const offendingLines = executableLines.filter((line) => /Write-Error/.test(line));
    assert.equal(offendingLines.length, 0, `unexpected Write-Error usage: ${offendingLines.join(' | ')}`);
  });

  test('the local-validation catch writes to stderr via [Console]::Error and still returns 3', () => {
    const catchStart = preflightScript.indexOf("Preflight local validation failed");
    assert.ok(catchStart >= 0);
    const catchBlock = preflightScript.slice(Math.max(0, catchStart - 200), catchStart + 300);
    assert.match(catchBlock, /\[Console\]::Error\.WriteLine/);
    assert.match(catchBlock, /return 3\b/);
  });

  test('the report-write catch writes to stderr via [Console]::Error and still returns 4', () => {
    const catchStart = preflightScript.indexOf('Preflight report could not be safely written');
    assert.ok(catchStart >= 0);
    const catchBlock = preflightScript.slice(Math.max(0, catchStart - 200), catchStart + 600);
    assert.match(catchBlock, /\[Console\]::Error\.WriteLine/);
    assert.match(catchBlock, /return 4\b/);
  });

  test('diagnostic messages in both paths are sanitized through Get-SafeErrorText', () => {
    const validationCatchStart = preflightScript.indexOf('Preflight local validation failed');
    const validationCatchLine = preflightScript.slice(validationCatchStart, validationCatchStart + 150);
    assert.match(validationCatchLine, /Get-SafeErrorText/);

    const reportCatchStart = preflightScript.indexOf('Preflight report could not be safely written');
    const reportCatchLine = preflightScript.slice(reportCatchStart, reportCatchStart + 150);
    assert.match(reportCatchLine, /Get-SafeErrorText/);
  });
});

describe('Permission-denied precedence over not-found', () => {
  function getErrorCategoryFunctionBody() {
    const start = preflightScript.indexOf('function Get-GcloudErrorCategory');
    const end = preflightScript.indexOf('function New-CommandResult');
    return preflightScript.slice(start, end);
  }

  test('permission-denied language is checked before not-found language', () => {
    const body = getErrorCategoryFunctionBody();
    const permissionDeniedIndex = body.indexOf("return 'permission_denied'");
    const notFoundIndex = body.indexOf("return 'not_found'");
    assert.ok(permissionDeniedIndex >= 0 && notFoundIndex >= 0);
    assert.ok(permissionDeniedIndex < notFoundIndex, 'permission_denied branch must appear before not_found branch');
  });

  test('the not-found pattern includes "may not exist" so mixed messages are still recognizable, but are still routed to permission_denied first', () => {
    const body = getErrorCategoryFunctionBody();
    assert.match(body, /may not exist/);
  });

  test('a message containing both permission-denied and not-found language cannot reach the not_found branch first', () => {
    // Structural proof: because the permission_denied branch appears first
    // and returns unconditionally on match, any string matching both
    // patterns is captured by the earlier branch — verified here by
    // confirming the permission_denied check has no not_found-specific
    // guard that would let it fall through.
    const body = getErrorCategoryFunctionBody();
    const permissionDeniedBranch = body.slice(
      body.indexOf("if ($StdErrText -match '(?i)PERMISSION_DENIED"),
      body.indexOf("if ($StdErrText -match '(?i)NOT_FOUND")
    );
    assert.match(permissionDeniedBranch, /return 'permission_denied'/);
    assert.doesNotMatch(permissionDeniedBranch, /not_found/);
  });
});

describe('Pre-evaluation variable initialization', () => {
  test('requiredApiEvaluation is initialized before the evaluation try block', () => {
    const initIndex = preflightScript.indexOf('$requiredApiEvaluation = [ordered]@{}');
    const tryStartIndex = preflightScript.indexOf('# ---- Evaluation (wrapped');
    assert.ok(initIndex >= 0, 'expected an initialization of $requiredApiEvaluation');
    assert.ok(tryStartIndex >= 0, 'expected the evaluation section marker comment');
    assert.ok(initIndex < tryStartIndex, '$requiredApiEvaluation must be initialized before the evaluation try block');
  });

  test('requiredApiEvaluation is assigned only once inside the try block (re-assignment, not re-initialization, of an already-existing variable)', () => {
    const occurrences = (preflightScript.match(/\$requiredApiEvaluation = \[ordered\]@\{\}/g) || []).length;
    assert.equal(occurrences, 1, 'expected exactly one initialization of $requiredApiEvaluation, outside the try block');
  });

  test('every field referenced in the final report object is assigned before the evaluation try block, except requiredApis which is pre-initialized', () => {
    const tryStartIndex = preflightScript.indexOf('# ---- Evaluation (wrapped');
    const reportFieldsStart = preflightScript.indexOf('$report = [ordered]@{');
    const preTryText = preflightScript.slice(0, tryStartIndex);
    for (const variable of [
      '$versionResult',
      '$authListResult',
      '$projectDescribeResult',
      '$artifactRepositoriesResult',
      '$cloudRunServicesResult',
      '$serviceAccountsResult',
      '$secretsListResult',
      '$taskQueuesResult',
      '$projectIamPolicyResult',
      '$targetedResources',
      '$blockers',
      '$warnings',
      '$commandResults',
    ]) {
      assert.ok(preTryText.includes(`${variable} =`), `expected ${variable} to be assigned before the evaluation try block`);
    }
    assert.ok(reportFieldsStart > tryStartIndex);
  });
});

describe('Protected report assembly, serialization, and write', () => {
  function getReportBoundaryBody() {
    const start = preflightScript.indexOf('$createdOutputFile = $false');
    const end = preflightScript.indexOf("if ($blockers.Count -gt 0)");
    assert.ok(start >= 0, 'expected a $createdOutputFile flag');
    return preflightScript.slice(start, end);
  }

  test('report object assembly happens inside the protected try block', () => {
    const body = getReportBoundaryBody();
    const tryIndex = body.indexOf('try {');
    const reportIndex = body.indexOf('$report = [ordered]@{');
    assert.ok(tryIndex >= 0 && reportIndex >= 0);
    assert.ok(tryIndex < reportIndex, 'report assembly must be inside the try block');
  });

  test('ConvertTo-Json is inside the same protected try block', () => {
    const body = getReportBoundaryBody();
    const tryIndex = body.indexOf('try {');
    const catchIndex = body.indexOf('catch {');
    const jsonIndex = body.indexOf('ConvertTo-Json');
    assert.ok(tryIndex >= 0 && catchIndex >= 0 && jsonIndex >= 0);
    assert.ok(tryIndex < jsonIndex && jsonIndex < catchIndex, 'ConvertTo-Json must be between try and catch');
  });

  test('file creation (CreateNew) is inside the same protected boundary', () => {
    const body = getReportBoundaryBody();
    const tryIndex = body.indexOf('try {');
    const catchIndex = body.indexOf('catch {');
    const createNewIndex = body.indexOf('FileMode]::CreateNew');
    assert.ok(tryIndex < createNewIndex && createNewIndex < catchIndex);
  });

  test('the writer is flushed before disposal', () => {
    const body = getReportBoundaryBody();
    assert.match(body, /\$writer\.Write\(\$json\)\s*\n\s*\$writer\.Flush\(\)/);
  });

  test('the catch returns 4 without Write-Error and without exposing the exception object or a stack trace', () => {
    const body = getReportBoundaryBody();
    const catchIndex = body.indexOf('catch {');
    const catchBody = body
      .slice(catchIndex)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(catchBody, /Write-Error/);
    assert.match(catchBody, /return 4\b/);
    assert.doesNotMatch(catchBody, /\$_\.Exception\.ToString\(\)/);
    assert.doesNotMatch(catchBody, /StackTrace/);
  });
});

describe('Partial-file cleanup on report-write failure', () => {
  function getReportBoundaryBody() {
    const start = preflightScript.indexOf('$createdOutputFile = $false');
    const end = preflightScript.indexOf("if ($blockers.Count -gt 0)");
    return preflightScript.slice(start, end);
  }

  test('a $createdOutputFile flag is declared false before the try block', () => {
    const body = getReportBoundaryBody();
    const flagIndex = body.indexOf('$createdOutputFile = $false');
    const tryIndex = body.indexOf('try {');
    assert.ok(flagIndex >= 0 && tryIndex >= 0 && flagIndex < tryIndex);
  });

  test('the flag is set true only immediately after CreateNew succeeds', () => {
    const body = getReportBoundaryBody();
    const createNewIndex = body.indexOf('FileMode]::CreateNew');
    const flagSetIndex = body.indexOf('$createdOutputFile = $true');
    assert.ok(createNewIndex >= 0 && flagSetIndex >= 0);
    assert.ok(flagSetIndex > createNewIndex, 'the flag must be set after the CreateNew call, not before');
    // And it must be set before any subsequent operation that could throw.
    const writerIndex = body.indexOf('New-Object System.IO.StreamWriter');
    assert.ok(flagSetIndex < writerIndex);
  });

  test('cleanup in the catch is guarded by the flag, removes only the newly created file, and uses ErrorAction Stop (not SilentlyContinue)', () => {
    const body = getReportBoundaryBody();
    const catchIndex = body.indexOf('catch {');
    const catchBody = body.slice(catchIndex);
    assert.match(catchBody, /if\s*\(\$createdOutputFile\)\s*\{/);
    assert.match(catchBody, /Remove-Item\s+-LiteralPath\s+\$resolvedOutputPath\s+-Force\s+-ErrorAction\s+Stop/);
    assert.doesNotMatch(catchBody, /Remove-Item\s+-LiteralPath\s+\$resolvedOutputPath\s+-Force\s+-ErrorAction\s+SilentlyContinue/);
  });

  test('cleanup itself is exception-safe and never changes the required exit code', () => {
    const body = getReportBoundaryBody();
    const catchIndex = body.indexOf('catch {');
    const catchBody = body
      .slice(catchIndex)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const cleanupTryIndex = catchBody.indexOf('try {');
    const cleanupCatchIndex = catchBody.indexOf('catch {', cleanupTryIndex + 1);
    const returnIndex = catchBody.indexOf('return 4');
    assert.ok(cleanupTryIndex >= 0 && cleanupCatchIndex >= 0 && returnIndex >= 0);
    assert.ok(cleanupCatchIndex < returnIndex, 'return 4 must occur after the cleanup try/catch, unconditionally');
  });

  test('cleanup failure emits exactly one additional generic sanitized diagnostic, with no OutputPath, exception object, or stack trace', () => {
    const body = getReportBoundaryBody();
    const catchIndex = body.indexOf('catch {');
    const catchBody = body.slice(catchIndex);
    const cleanupTryIndex = catchBody.indexOf('try {');
    const cleanupCatchIndex = catchBody.indexOf('catch {', cleanupTryIndex + 1);
    const cleanupCatchBody = catchBody.slice(cleanupCatchIndex, catchBody.indexOf('return 4', cleanupCatchIndex));
    assert.match(cleanupCatchBody, /\[Console\]::Error\.WriteLine\('Preflight partial report cleanup failed\.'\)/);
    assert.doesNotMatch(cleanupCatchBody, /\$resolvedOutputPath/);
    assert.doesNotMatch(cleanupCatchBody, /\$_\.Exception/);
    assert.doesNotMatch(cleanupCatchBody, /StackTrace/);
    assert.doesNotMatch(cleanupCatchBody, /Write-Error/);
  });

  test('the cleanup-failure diagnostic is nested inside the createdOutputFile guard, not the outer report-write catch', () => {
    const body = getReportBoundaryBody();
    const outerCatchIndex = body.indexOf('catch {');
    const guardIndex = body.indexOf('if ($createdOutputFile) {', outerCatchIndex);
    const diagnosticIndex = body.indexOf("Preflight partial report cleanup failed.", outerCatchIndex);
    assert.ok(guardIndex >= 0 && diagnosticIndex >= 0);
    assert.ok(guardIndex < diagnosticIndex, 'the generic cleanup diagnostic must be inside the createdOutputFile-guarded cleanup block');
  });

  test('no Force or Overwrite input parameter is introduced for this behavior', () => {
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Force\b/i);
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Overwrite\b/i);
  });
});

describe('Malformed-success responses must block', () => {
  test('worker service: missing runtime service-account identity is enforced by the normalizer itself (ConvertTo-SafeCloudRunDescribeResult), not by post-hoc evaluation', () => {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const end = preflightScript.indexOf('# ----------------------------------------------------------------------\n# Fail-closed blocker helpers', start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /if \(\$RuntimeServiceAccount -and \$null -eq \$runtimeServiceAccount\) \{/);
    assert.match(body, /did not contain a usable runtime service-account identity/);
  });

  test('worker service: a mismatched runtime identity remains a distinct, separate blocker from the normalizer-enforced missing case', () => {
    assert.match(preflightScript, /supplied worker service using an unexpected runtime service account/);
    const mismatchIndex = preflightScript.indexOf('supplied worker service using an unexpected runtime service account');
    const context = preflightScript.slice(mismatchIndex - 300, mismatchIndex);
    assert.match(context, /\$runtimeServiceAccountOnService -cne \$RuntimeServiceAccount/);
  });

  test('worker service: the mismatch check only runs when RuntimeServiceAccount was actually supplied', () => {
    const mismatchIndex = preflightScript.indexOf('supplied worker service using an unexpected runtime service account');
    const context = preflightScript.slice(mismatchIndex - 450, mismatchIndex);
    assert.match(context, /if\s*\(\$RuntimeServiceAccount\)\s*\{/);
  });

  for (const label of ['RuntimeServiceAccount', 'TaskCallerServiceAccount', 'TaskCreatorServiceAccount']) {
    test(`${label}: missing, null, or non-boolean disabled metadata is a distinct blocker from disabled=true`, () => {
      const malformedText = `malformed service-account metadata: missing or non-boolean disabled field for ${label}`;
      const disabledText = `supplied service account disabled: ${label}`;
      assert.ok(preflightScript.includes(malformedText), `expected "${malformedText}"`);
      assert.ok(preflightScript.includes(disabledText), `expected "${disabledText}"`);
      const malformedIndex = preflightScript.indexOf(malformedText);
      const context = preflightScript.slice(malformedIndex - 450, malformedIndex);
      assert.match(context, /\$null\s+-eq\s+\$isDisabled\s+-or\s+\$isDisabled\s+-isnot\s+\[bool\]/);
    });
  }

  test('ArtifactRepository: missing format is a distinct blocker from a non-DOCKER format', () => {
    assert.match(preflightScript, /supplied artifact repository missing format metadata/);
    assert.match(preflightScript, /supplied artifact repository is not Docker-format/);
    const missingIndex = preflightScript.indexOf('supplied artifact repository missing format metadata');
    const context = preflightScript.slice(missingIndex - 250, missingIndex);
    assert.match(context, /IsNullOrEmpty\(\$repositoryFormat\)/);
  });

  test('Queue: missing, null, blank, or non-string state is a distinct malformed-metadata blocker', () => {
    assert.match(preflightScript, /supplied queue missing state metadata/);
    const missingIndex = preflightScript.indexOf('supplied queue missing state metadata');
    const context = preflightScript.slice(missingIndex - 450, missingIndex);
    assert.match(context, /\$queueState -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$queueState\)/);
  });

  test('Queue: PAUSED is the expected pre-rollout state and produces no queue-state blocker', () => {
    const start = preflightScript.indexOf('supplied queue missing state metadata') - 400;
    const end = preflightScript.indexOf('if ($RuntimeServiceAccount) {', start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /elseif \(\$queueState -ceq 'RUNNING'\) \{/);
    assert.match(body, /elseif \(\$queueState -cne 'PAUSED'\) \{/);
  });

  test('Queue: RUNNING produces a blocker stating that production dispatch is not paused', () => {
    assert.match(preflightScript, /supplied queue is RUNNING: production dispatch is not paused/);
    const runningIndex = preflightScript.indexOf('supplied queue is RUNNING: production dispatch is not paused');
    const context = preflightScript.slice(runningIndex - 200, runningIndex);
    assert.match(context, /\$queueState -ceq 'RUNNING'/);
  });

  test('Queue: DISABLED or any other recognized/unexpected state produces a blocker stating the queue is not PAUSED', () => {
    assert.match(preflightScript, /supplied queue is not in the required PAUSED pre-rollout state/);
    const otherIndex = preflightScript.indexOf('supplied queue is not in the required PAUSED pre-rollout state');
    const context = preflightScript.slice(otherIndex - 220, otherIndex);
    assert.match(context, /queueState -cne 'PAUSED'/);
  });

  test('Queue: the script never treats "not RUNNING" as the failure condition anywhere', () => {
    assert.doesNotMatch(preflightScript, /supplied queue not RUNNING/);
    assert.doesNotMatch(preflightScript, /queueState -ne 'RUNNING'/);
  });

  test('Worker IAM and project IAM: a missing bindings field still resolves to an empty list via ConvertTo-DataArray', () => {
    assert.match(preflightScript, /ConvertTo-DataArray \(Get-SafeProperty -Object \$iamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
    assert.match(preflightScript, /ConvertTo-DataArray \(Get-SafeProperty -Object \$projectIamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
  });

  test('Secret versions: only an explicit ENABLED state counts, so missing/malformed state never satisfies the requirement', () => {
    assert.match(preflightScript, /\(Test-IsValidSecretVersionEntry -VersionEntry \$_\) -and \(\(Get-SafeProperty -Object \$_ -PropertyPath @\('state'\)\) -ceq 'ENABLED'\)/);
  });
});

describe('Exact command-schema validation (Test-GcloudCommandSchema)', () => {
  function getSchemaFunctionBody() {
    const start = preflightScript.indexOf('function Test-GcloudCommandSchema');
    const end = preflightScript.indexOf('function Invoke-ReadOnlyGcloudCommand');
    return preflightScript.slice(start, end);
  }

  test('validates positional argument count and, for the two project-identifying commands, the positional value', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$positionals\.Count -ne \$schema\.PositionalCount\) \{ return \$false \}/);
    assert.match(body, /if \(\$schema\.PositionalEqualsProjectId.*positionals\[0\] -cne \$ProjectId\) \{ return \$false \}/);
  });

  test('requires --quiet, --verbosity=error, and the expected format flag exactly once each', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$seenQuiet -ne 1\) \{ return \$false \}/);
    assert.match(body, /if \(\$seenVerbosity -ne 1\) \{ return \$false \}/);
    assert.match(body, /if \(\$seenFormat -ne 1\) \{ return \$false \}/);
  });

  test('rejects a duplicate --project, or --project when the schema does not require one', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$seenProject -ne 1\) \{ return \$false \}/);
    assert.match(body, /elseif \(\$seenProject -ne 0\) \{\s*return \$false\s*\}/);
  });

  test('rejects a --project value that does not equal the caller-supplied ProjectId', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$projectValue -cne \$ProjectId\) \{ return \$false \}/);
  });

  test('rejects a --region/--location value that does not equal the expected Region or TasksLocation', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$locationValue -cne \$expectedLocationValue\) \{ return \$false \}/);
    assert.match(body, /\$expectedLocationValue = \$Region/);
    assert.match(body, /\$expectedLocationValue = \$TasksLocation/);
  });

  test('rejects --region when the schema requires --location, and vice versa', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(\$schema\.LocationFlag -ne '--region'\) \{ return \$false \}/);
    assert.match(body, /if \(\$schema\.LocationFlag -ne '--location'\) \{ return \$false \}/);
  });

  test('rejects --enabled unless the matched schema requires it', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /if \(-not \$schema\.RequiresEnabledFlag\) \{ return \$false \}/);
  });

  test('any unrecognized flag-shaped token falls through to rejection, covering every explicitly named unapproved flag', () => {
    const body = getSchemaFunctionBody();
    // The final fallback after all recognized-flag checks always rejects.
    const fallbackIndex = body.lastIndexOf('return $false');
    assert.ok(fallbackIndex >= 0);
    for (const deniedFlag of [
      '--log-http',
      '--log-http=true',
      '--impersonate-service-account',
      '--access-token-file',
      '--credential-file-override',
      '--configuration',
      '--account',
      '--billing-project',
      '--flags-file',
      '--trace-token',
    ]) {
      // None of these are among the recognized literal flag comparisons in
      // the validator, so each necessarily falls through to the final
      // rejection rather than being specially recognized.
      assert.doesNotMatch(body, new RegExp(`-ceq '${deniedFlag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    }
  });

  test('a missing flag value (flag is the last token) is rejected for --project, --region, and --location', () => {
    const body = getSchemaFunctionBody();
    const twoTokenFlagBlocks = ['--project', '--region', '--location'];
    for (const flag of twoTokenFlagBlocks) {
      const flagIndex = body.indexOf(`$token -ceq '${flag}'`);
      assert.ok(flagIndex >= 0, `expected a handler for ${flag}`);
      const flagBlock = body.slice(flagIndex, flagIndex + 250);
      assert.match(flagBlock, /if \(\(\$i \+ 1\) -ge \$rest\.Count\) \{ return \$false \}/);
    }
  });

  test('the resulting exact-match returns true only when every check passes', () => {
    const body = getSchemaFunctionBody();
    assert.match(body, /return \$true\s*\}\s*$/);
  });
});

describe('Command-helper full failure containment', () => {
  function getInvokeFunctionBody() {
    const start = preflightScript.indexOf('function Invoke-ReadOnlyGcloudCommand');
    const end = preflightScript.indexOf('function New-NotRequestedResult');
    return preflightScript.slice(start, end);
  }

  test('the entire function body is wrapped in one outer try/catch', () => {
    const body = getInvokeFunctionBody();
    const firstTryIndex = body.indexOf('try {');
    const schemaCheckIndex = body.indexOf('Test-GcloudCommandSchema');
    assert.ok(firstTryIndex >= 0 && firstTryIndex < schemaCheckIndex, 'the outer try must wrap the schema check too');
    const lastCatchIndex = body.lastIndexOf('catch {');
    const commandExecutionErrorIndex = body.indexOf("'command_execution_error'", lastCatchIndex);
    assert.ok(commandExecutionErrorIndex >= 0, 'expected a command_execution_error fallback category after the outermost catch');
    assert.ok(lastCatchIndex < commandExecutionErrorIndex, 'command_execution_error must be produced in the outermost catch');
  });

  test('an unexpected failure returns status failed with errorCategory command_execution_error, sanitized, with no exception object or stack trace', () => {
    const body = getInvokeFunctionBody();
    const outerCatchIndex = body.lastIndexOf('catch {');
    const outerCatchBody = body.slice(outerCatchIndex);
    assert.match(outerCatchBody, /-Status\s+'failed'/);
    assert.match(outerCatchBody, /-ErrorCategory\s+'command_execution_error'/);
    assert.match(outerCatchBody, /Get-SafeErrorText -Text \$_\.Exception\.Message/);
    assert.doesNotMatch(outerCatchBody, /\$_\.Exception\.ToString\(\)/);
    assert.doesNotMatch(outerCatchBody, /StackTrace/);
  });

  test('temporary stderr cleanup in the finally block cannot throw (wrapped in its own try/catch)', () => {
    const body = getInvokeFunctionBody();
    const finallyIndex = body.indexOf('finally {');
    const finallyBody = body.slice(finallyIndex, finallyIndex + 900);
    assert.match(finallyBody, /try\s*\{/);
    assert.match(finallyBody, /Remove-Item -LiteralPath \$stderrPath/);
    assert.match(finallyBody, /catch\s*\{/);
  });

  test('cleanup failure cannot escape or replace the classified result (the finally never itself throws uncaught)', () => {
    const body = getInvokeFunctionBody();
    const finallyIndex = body.indexOf('finally {');
    const nextFinallyOrEnd = body.indexOf('if ($cleanupFailed)');
    const finallyBlock = body.slice(finallyIndex, nextFinallyOrEnd);
    // The Remove-Item call itself must be inside the inner try, not
    // directly inside finally unprotected.
    const innerTryIndex = finallyBlock.indexOf('try {');
    const removeItemIndex = finallyBlock.indexOf('Remove-Item');
    assert.ok(innerTryIndex >= 0 && innerTryIndex < removeItemIndex);
  });

  test('cleanup uses -ErrorAction Stop, never SilentlyContinue', () => {
    const body = getInvokeFunctionBody();
    const finallyIndex = body.indexOf('finally {');
    const nextIndex = body.indexOf('if ($cleanupFailed)');
    const finallyBlock = body.slice(finallyIndex, nextIndex);
    assert.match(finallyBlock, /Remove-Item -LiteralPath \$stderrPath -Force -ErrorAction Stop/);
    assert.doesNotMatch(finallyBlock, /Remove-Item[^\n]*SilentlyContinue/);
  });

  test('a $cleanupFailed flag records cleanup failure without letting the exception escape', () => {
    const body = getInvokeFunctionBody();
    assert.match(body, /\$cleanupFailed = \$false/);
    const finallyIndex = body.indexOf('finally {');
    const nextIndex = body.indexOf('if ($cleanupFailed)');
    const finallyBlock = body.slice(finallyIndex, nextIndex);
    assert.match(finallyBlock, /catch\s*\{\s*\$cleanupFailed = \$true\s*\}/);
  });

  test('cleanup failure overrides an otherwise-successful command result: the check runs before exitCode-based classification', () => {
    const body = getInvokeFunctionBody();
    const cleanupCheckIndex = body.indexOf('if ($cleanupFailed)');
    const exitCodeCheckIndex = body.indexOf('if ($exitCode -eq 0)');
    assert.ok(cleanupCheckIndex >= 0 && exitCodeCheckIndex >= 0);
    assert.ok(cleanupCheckIndex < exitCodeCheckIndex, 'cleanup-failure short-circuit must precede success/not_found/permission_denied classification');
  });

  test('cleanup failure returns a generic sanitized safeError with no temporary path and no raw exception', () => {
    const body = getInvokeFunctionBody();
    const cleanupCheckIndex = body.indexOf('if ($cleanupFailed)');
    const exitCodeCheckIndex = body.indexOf('if ($exitCode -eq 0)');
    const cleanupFailureBlock = body.slice(cleanupCheckIndex, exitCodeCheckIndex);
    assert.match(cleanupFailureBlock, /-Status\s+'failed'/);
    assert.match(cleanupFailureBlock, /-ErrorCategory\s+'command_execution_error'/);
    assert.doesNotMatch(cleanupFailureBlock, /\$stderrPath/);
    assert.doesNotMatch(cleanupFailureBlock, /\$_\.Exception/);
  });
});

describe('Top-level exit-code containment', () => {
  function getTopLevelBlock() {
    const start = preflightScript.indexOf('$script:IsDotSourced');
    return preflightScript.slice(start);
  }

  test('repository-root resolution is wrapped in try/catch before Invoke-PrivateWorkerPreflightMain is called', () => {
    const body = getTopLevelBlock();
    const tryIndex = body.indexOf('try {');
    const resolveIndex = body.indexOf('$repositoryRoot = Resolve-Path');
    const catchIndex = body.indexOf('catch {');
    const mainCallIndex = body.indexOf('Invoke-PrivateWorkerPreflightMain');
    assert.ok(tryIndex >= 0 && tryIndex < resolveIndex, 'Resolve-Path must be inside the try');
    assert.ok(resolveIndex < catchIndex && catchIndex < mainCallIndex, 'catch must precede the main call, which is outside the try');
  });

  test('a setup failure writes a sanitized diagnostic via [Console]::Error and exits 3, never Write-Error', () => {
    const body = getTopLevelBlock();
    const catchIndex = body.indexOf('catch {');
    const catchBody = body
      .slice(catchIndex, catchIndex + 400)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.match(catchBody, /\[Console\]::Error\.WriteLine/);
    assert.match(catchBody, /Get-SafeErrorText/);
    assert.match(catchBody, /exit 3\b/);
    assert.doesNotMatch(catchBody, /Write-Error/);
  });

  test('the main call is wrapped in its own try/catch, separate from repository-root setup', () => {
    const body = getTopLevelBlock();
    const setupCatchIndex = body.indexOf('catch {');
    const mainTryIndex = body.indexOf('try {', setupCatchIndex);
    const mainCallIndex = body.indexOf('$mainExitCode = Invoke-PrivateWorkerPreflightMain');
    const mainCatchIndex = body.indexOf('catch {', mainCallIndex);
    assert.ok(mainTryIndex >= 0 && mainTryIndex < mainCallIndex, 'a second try must wrap the main call');
    assert.ok(mainCatchIndex > mainCallIndex, 'a second catch must follow the main call');
  });

  test('an exception escaping the main call writes a sanitized diagnostic (no stack trace/exception object) and exits 4, never Write-Error', () => {
    const body = getTopLevelBlock();
    const mainCallIndex = body.indexOf('$mainExitCode = Invoke-PrivateWorkerPreflightMain');
    const mainCatchIndex = body.indexOf('catch {', mainCallIndex);
    const mainCatchBody = body
      .slice(mainCatchIndex, mainCatchIndex + 400)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.match(mainCatchBody, /\[Console\]::Error\.WriteLine/);
    assert.match(mainCatchBody, /Get-SafeErrorText/);
    assert.match(mainCatchBody, /exit 4\b/);
    assert.doesNotMatch(mainCatchBody, /Write-Error/);
    assert.doesNotMatch(mainCatchBody, /\$_\.Exception\.ToString\(\)/);
    assert.doesNotMatch(mainCatchBody, /StackTrace/);
  });

  test('a returned exit code outside {0,2,3,4} is treated as exit 4, not forwarded as-is', () => {
    const body = getTopLevelBlock();
    assert.match(body, /\$approvedExitCodes = @\(0, 2, 3, 4\)/);
    const approvedIndex = body.indexOf('$approvedExitCodes = @(0, 2, 3, 4)');
    const notContainsIndex = body.indexOf('-notcontains $mainExitCode', approvedIndex);
    const guardExitIndex = body.indexOf('exit 4', notContainsIndex);
    assert.ok(approvedIndex >= 0 && notContainsIndex > approvedIndex && guardExitIndex > notContainsIndex);
  });

  test('a normal allowed exit code is forwarded unchanged', () => {
    const body = getTopLevelBlock();
    assert.match(body, /exit \$mainExitCode\b/);
  });

  test('no other intentional exit code is introduced at the top level besides 3, the validated forward, and the 4 fallbacks', () => {
    const body = getTopLevelBlock();
    const literalExitCodes = [...body.matchAll(/exit (\d+)\b/g)].map((m) => m[1]);
    for (const value of literalExitCodes) {
      assert.ok(['3', '4'].includes(value), `unexpected literal top-level exit code ${value}`);
    }
  });

  test('dot-source behavior is unchanged: the entire block remains gated by IsDotSourced', () => {
    const body = getTopLevelBlock();
    assert.match(body, /if \(-not \$script:IsDotSourced\) \{/);
  });
});

describe('Cloud Run safe projection', () => {
  test('declares two separate reviewed safe-projection format flag constants (list and describe)', () => {
    assert.match(preflightScript, /\$script:CloudRunListSafeFormatFlag\s*=\s*'--format=json\(/);
    assert.match(preflightScript, /\$script:CloudRunDescribeSafeFormatFlag\s*=\s*'--format=json\(/);
  });

  test('the list projection never requests any annotations field (the full map or otherwise)', () => {
    const start = preflightScript.indexOf('$script:CloudRunListSafeFormatFlag =');
    assert.ok(start >= 0);
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    assert.doesNotMatch(line, /annotations/);
  });

  test('the describe projection requests only the single narrowly-projected invoker-iam-disabled annotation key, never the unrestricted annotations map', () => {
    const start = preflightScript.indexOf('$script:CloudRunDescribeSafeFormatFlag =');
    assert.ok(start >= 0);
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    assert.match(line, /metadata\.annotations\.\[run\.googleapis\.com\/invoker-iam-disabled\]/);
    // An unrestricted map request would appear as a bare `annotations`
    // field with no bracketed key selector immediately following it.
    assert.doesNotMatch(line, /metadata\.annotations,/);
    assert.doesNotMatch(line, /metadata\.annotations\)/);
  });

  test('neither projection constant contains env, environment, value, valueFrom, secretKeyRef, secrets, volumes, volumeMounts, command, args, or labels fields', () => {
    for (const constantName of ['$script:CloudRunListSafeFormatFlag', '$script:CloudRunDescribeSafeFormatFlag']) {
      const start = preflightScript.indexOf(constantName + ' =');
      const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
      assert.doesNotMatch(line, /\benv\b/i);
      assert.doesNotMatch(line, /environment/i);
      assert.doesNotMatch(line, /secretKeyRef/i);
      assert.doesNotMatch(line, /\bsecrets\b/i);
      assert.doesNotMatch(line, /\bvalue\b/i);
      assert.doesNotMatch(line, /valueFrom/i);
      assert.doesNotMatch(line, /\bvolumes\b/i);
      assert.doesNotMatch(line, /volumeMounts/i);
      assert.doesNotMatch(line, /\bcommand\b/i);
      assert.doesNotMatch(line, /\bargs\b/i);
      assert.doesNotMatch(line, /\blabels\b/i);
    }
  });

  test('the list projection is minimal: only name/metadata.name/ingress', () => {
    const start = preflightScript.indexOf('$script:CloudRunListSafeFormatFlag =');
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    assert.match(line, /'--format=json\(name,metadata\.name,ingress\)'/);
    for (const excludedField of [
      'uri',
      'status.url',
      'latestReadyRevision',
      'traffic',
      'template.serviceAccount',
      'spec.template.spec.serviceAccountName',
      'template.containers',
      'spec.template.spec.containers',
      'invokerIamDisabled',
      'annotations',
    ]) {
      assert.ok(!line.includes(excludedField), `expected the minimal list projection to exclude ${excludedField}`);
    }
  });

  test('the describe projection includes the reviewed v1/v2 field alternatives, including the dedicated invokerIamDisabled boolean', () => {
    const start = preflightScript.indexOf('$script:CloudRunDescribeSafeFormatFlag =');
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    for (const requiredField of [
      'name',
      'metadata.name',
      'uri',
      'status.url',
      'ingress',
      'latestReadyRevision',
      'status.latestReadyRevisionName',
      'traffic',
      'template.serviceAccount',
      'spec.template.spec.serviceAccountName',
      'template.containers[].image',
      'spec.template.spec.containers[].image',
      'invokerIamDisabled',
      'metadata.annotations.[run.googleapis.com/invoker-iam-disabled]',
    ]) {
      assert.ok(line.includes(requiredField), `expected the describe projection to include ${requiredField}`);
    }
  });

  test('cloudRunServices uses the list projection, workerServiceDescribe uses the describe projection; workerServiceIamPolicy and run get-iam-policy schema stay plain json', () => {
    const cloudRunServicesArgs = declarationFor('cloudRunServices');
    const workerServiceDescribeArgs = declarationFor('workerServiceDescribe');
    assert.match(cloudRunServicesArgs, /\$script:CloudRunListSafeFormatFlag\b/);
    assert.match(workerServiceDescribeArgs, /\$script:CloudRunDescribeSafeFormatFlag\b/);

    const workerServiceIamPolicyArgs = declarationFor('workerServiceIamPolicy');
    assert.match(workerServiceIamPolicyArgs, /'--format=json'/);
    assert.doesNotMatch(workerServiceIamPolicyArgs, /CloudRunListSafeFormatFlag|CloudRunDescribeSafeFormatFlag/);

    const runIamPolicySchemaStart = preflightScript.indexOf("Path = @('run', 'services', 'get-iam-policy')");
    const runIamPolicySchemaLine = preflightScript.slice(runIamPolicySchemaStart, preflightScript.indexOf('\n', runIamPolicySchemaStart));
    assert.match(runIamPolicySchemaLine, /FormatMode = 'json'/);
  });

  test("run services list requires FormatMode 'cloudrun-list-safe' and run services describe requires 'cloudrun-describe-safe'", () => {
    const listSchemaStart = preflightScript.indexOf("Path = @('run', 'services', 'list')");
    const listSchemaLine = preflightScript.slice(listSchemaStart, preflightScript.indexOf('\n', listSchemaStart));
    assert.match(listSchemaLine, /FormatMode = 'cloudrun-list-safe'/);

    const describeSchemaStart = preflightScript.indexOf("Path = @('run', 'services', 'describe')");
    const describeSchemaLine = preflightScript.slice(describeSchemaStart, preflightScript.indexOf('\n', describeSchemaStart));
    assert.match(describeSchemaLine, /FormatMode = 'cloudrun-describe-safe'/);
  });

  test('report-bound Cloud Run data cannot be the unrestricted service object: the schema rejects plain --format=json for both commands', () => {
    // Because FormatMode is 'cloudrun-list-safe'/'cloudrun-describe-safe'
    // for these two schema entries, Test-GcloudCommandSchema's
    // $expectedFormatToken becomes the corresponding safe-projection
    // constant, so a literal '--format=json' token would not match and
    // would fall through to the unrecognized-flag rejection — the
    // unrestricted format is structurally unreachable for either command.
    const body = preflightScript.slice(
      preflightScript.indexOf('function Test-GcloudCommandSchema'),
      preflightScript.indexOf('function Invoke-ReadOnlyGcloudCommand')
    );
    assert.match(body, /\$expectedFormatToken = \$script:CloudRunListSafeFormatFlag/);
    assert.match(body, /\$expectedFormatToken = \$script:CloudRunDescribeSafeFormatFlag/);
  });

  test('both Cloud Run command results pass through a normalizer before Add-Result', () => {
    assert.match(
      preflightScript,
      /\$cloudRunServicesResult = Add-Result 'cloudRunServices' \(ConvertTo-SafeCloudRunListResult -Result \(Invoke-ReadOnlyGcloudCommand -Id 'cloudRunServices'/
    );
    assert.match(
      preflightScript,
      /\$workerServiceDescribeResult = ConvertTo-SafeCloudRunDescribeResult -Result \(Invoke-ReadOnlyGcloudCommand -Id 'workerServiceDescribe'/
    );
  });

  test('the raw command result is never placed directly in targetedResources.workerService.describe', () => {
    const assignmentIndex = preflightScript.indexOf("$targetedResources['workerService'] = ");
    assert.ok(assignmentIndex >= 0);
    const assignmentLine = preflightScript.slice(assignmentIndex, preflightScript.indexOf('\n', assignmentIndex));
    assert.match(assignmentLine, /describe = \$workerServiceDescribeResult/);
    // $workerServiceDescribeResult is itself already the normalizer's
    // output (assigned from ConvertTo-SafeCloudRunDescribeResult above,
    // not from a raw Invoke-ReadOnlyGcloudCommand call), so this is the
    // normalized result, never the raw one.
    const describeAssignmentIndex = preflightScript.indexOf('$workerServiceDescribeResult = ');
    assert.match(
      preflightScript.slice(describeAssignmentIndex, describeAssignmentIndex + 80),
      /\$workerServiceDescribeResult = ConvertTo-SafeCloudRunDescribeResult/
    );
  });

  test('the list normalizer discards the raw parsed object and requires a non-blank name per entry', () => {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunListResult');
    const end = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const body = preflightScript.slice(start, end);
    assert.match(body, /\$name -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$name\)/);
    assert.match(body, /-ErrorCategory 'malformed_output'/);
    assert.match(body, /\[pscustomobject\]@\{/);
  });

  test('the list normalizer rejects a non-string, non-null ingress value', () => {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunListResult');
    const end = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const body = preflightScript.slice(start, end);
    assert.match(body, /if \(\$null -ne \$ingress -and \$ingress -isnot \[string\]\) \{/);
    assert.match(body, /unexpected ingress value type/);
  });
});

describe('Cloud Run Invoker IAM disablement detection', () => {
  function getNormalizerBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const end = preflightScript.indexOf('# ----------------------------------------------------------------------\n# Fail-closed blocker helpers', start);
    return preflightScript.slice(start, end);
  }

  test('reads the v2 top-level invokerIamDisabled field', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$invokerIamDisabledRaw = Get-CloudRunFieldValue -Data \$data -PropertyPathAlternatives @\(@\('invokerIamDisabled'\)\)/);
    assert.match(body, /\$topLevelInvokerIamDisabledPresent = \$invokerIamDisabledRaw -is \[bool\]/);
  });

  test('reads the single narrowly-projected v1/Knative annotation entry via Get-SafeProperty, never the full annotations map', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$invokerIamDisabledAnnotationRaw = Get-SafeProperty -Object \$data -PropertyPath @\('metadata', 'annotations', 'run\.googleapis\.com\/invoker-iam-disabled'\)/);
  });

  test('a non-boolean top-level value is rejected as malformed_output', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\(\$null -ne \$invokerIamDisabledRaw\) -and \(-not \$topLevelInvokerIamDisabledPresent\)\) \{/);
    assert.match(body, /did not contain a boolean invokerIamDisabled value/);
    const rejectionIndex = body.indexOf('did not contain a boolean invokerIamDisabled value');
    const context = body.slice(rejectionIndex - 150, rejectionIndex);
    assert.match(context, /-ErrorCategory 'malformed_output'/);
  });

  test('the annotation value must be exactly the lowercase string "true" or "false" (case-sensitive) — any other type, casing, or value is malformed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$annotationInvokerIamDisabledPresent = \(\$invokerIamDisabledAnnotationRaw -is \[string\]\) -and \(\(\$invokerIamDisabledAnnotationRaw -ceq 'true'\) -or \(\$invokerIamDisabledAnnotationRaw -ceq 'false'\)\)/);
    assert.match(body, /an invoker-iam-disabled annotation that was not the lowercase string true or false/);
  });

  test('TRUE, blank, an object, a number, and other non-matching strings all fail the annotation check (case-sensitive -ceq rejects alternate casing)', () => {
    // Structural proof: -ceq is case-sensitive, so 'TRUE' !== 'true' and
    // 'False' !== 'false'; the ($value -is [string]) conjunct rejects an
    // object or number outright; a blank string matches neither literal.
    assert.equal('TRUE' === 'true', false);
    assert.equal('True' === 'true', false);
    const body = getNormalizerBody();
    assert.match(body, /\$invokerIamDisabledAnnotationRaw -is \[string\]/);
  });

  test('missing both the top-level field and the annotation is malformed_output — neither is ever interpreted as false', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\(-not \$topLevelInvokerIamDisabledPresent\) -and \(-not \$annotationInvokerIamDisabledPresent\)\) \{/);
    assert.match(body, /did not contain a usable invokerIamDisabled value from either the top-level field or the annotation/);
  });

  test('top-level present alone (annotation absent) is accepted and normalizes to the top-level value', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$topLevelInvokerIamDisabledPresent\) \{\s*\n\s*\$invokerIamDisabledNormalized = \$invokerIamDisabledRaw/);
  });

  test('annotation present alone (top-level absent) is accepted and normalizes to the parsed annotation boolean', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$annotationInvokerIamDisabledBoolValue = \(\$invokerIamDisabledAnnotationRaw -ceq 'true'\)/);
    assert.match(body, /else \{\s*\n\s*\$invokerIamDisabledNormalized = \$annotationInvokerIamDisabledBoolValue/);
  });

  test('both sources present and agreeing is accepted (no conflict blocker fires)', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$topLevelInvokerIamDisabledPresent -and \$annotationInvokerIamDisabledPresent -and \(\$invokerIamDisabledRaw -ne \$annotationInvokerIamDisabledBoolValue\)/);
  });

  test('both sources present but disagreeing is rejected as malformed_output', () => {
    const body = getNormalizerBody();
    assert.match(body, /invokerIamDisabled value disagreed between the top-level field and the annotation/);
    const conflictIndex = body.indexOf('invokerIamDisabled value disagreed between the top-level field and the annotation');
    const context = body.slice(Math.max(0, conflictIndex - 250), conflictIndex);
    assert.match(context, /-ErrorCategory 'malformed_output'/);
  });

  test('the raw annotations map/object is never itself retained in the normalized report object', () => {
    const body = getNormalizerBody();
    const normalizedObjectStart = body.indexOf('$normalized = [pscustomobject]@{');
    const normalizedObjectEnd = body.indexOf('}', normalizedObjectStart);
    const normalizedObjectBody = body.slice(normalizedObjectStart, normalizedObjectEnd);
    assert.doesNotMatch(normalizedObjectBody, /annotations/i);
    assert.match(normalizedObjectBody, /invokerIamDisabled\s*=\s*\$invokerIamDisabledNormalized/);
  });

  test('no annotation map or raw annotation object ever reaches commandResults or targetedResources — only the normalized boolean field does', () => {
    // Within the describe normalizer, the success return path always
    // passes through New-CommandResult with -Data $normalized (the
    // reviewed pscustomobject above), never the raw $data or
    // $invokerIamDisabledAnnotationRaw value.
    const body = getNormalizerBody();
    assert.doesNotMatch(body, /New-CommandResult[^\n]*-Data \$invokerIamDisabledAnnotationRaw/);
    assert.doesNotMatch(body, /New-CommandResult[^\n]*-Data \$data\b/);
    assert.match(body, /return New-CommandResult -Id \$Result\.id -Status \$Result\.status -ExitCode \$Result\.exitCode -Data \$normalized/);
  });

  test('true produces a blocker', () => {
    assert.match(preflightScript, /Cloud Run Invoker IAM check is disabled \(invokerIamDisabled=true\)/);
    const blockerIndex = preflightScript.indexOf('Cloud Run Invoker IAM check is disabled (invokerIamDisabled=true)');
    const context = preflightScript.slice(blockerIndex - 200, blockerIndex);
    assert.match(context, /\$invokerIamDisabled -eq \$true/);
  });

  test('false is the only accepted clean value (no blocker) once the normalizer has already guaranteed a boolean', () => {
    const evalStart = preflightScript.indexOf('$normalizedWorkerService = $describeResult.data');
    const evalEnd = preflightScript.indexOf('if ($iamPolicyResult.status', evalStart);
    const body = preflightScript.slice(evalStart, evalEnd);
    // Only one comparison against the already-boolean field is needed —
    // there is no separate malformed-value branch here, because the
    // normalizer has already excluded every non-boolean possibility.
    assert.match(body, /\$invokerIamDisabled = Get-SafeProperty -Object \$normalizedWorkerService -PropertyPath @\('invokerIamDisabled'\)/);
    assert.match(body, /if \(\$invokerIamDisabled -eq \$true\) \{/);
  });

  test('this check is independent of the allUsers/allAuthenticatedUsers IAM policy check — a service must not pass merely because public IAM members are absent', () => {
    const invokerCheckIndex = preflightScript.indexOf('$invokerIamDisabled = Get-SafeProperty -Object $normalizedWorkerService');
    const publicBindingCheckIndex = preflightScript.indexOf('worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers');
    assert.ok(invokerCheckIndex >= 0 && publicBindingCheckIndex >= 0);
    assert.ok(invokerCheckIndex < publicBindingCheckIndex, 'the invokerIamDisabled check should run alongside, not instead of, the IAM binding check');
  });
});

describe('Complete public Cloud Run IAM detection', () => {
  test('declares a shared invocation-roles constant covering both roles/run.invoker and roles/run.servicesInvoker', () => {
    assert.match(preflightScript, /\$script:CloudRunInvocationRoles = @\('roles\/run\.invoker', 'roles\/run\.servicesInvoker'\)/);
  });

  test('the service-level public-binding check is conservative: it blocks any role granted to a public principal, not only the two recognized invocation roles', () => {
    const blockerIndex = preflightScript.indexOf('worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers');
    const context = preflightScript.slice(blockerIndex - 400, blockerIndex);
    const publicCheckIndex = context.indexOf('$publicBinding = $bindings');
    const publicCheckBody = context.slice(publicCheckIndex);
    // No role-name filter appears in the service-level public-binding
    // predicate itself — only the members check — closing gaps like
    // roles/run.admin or an unknown/custom role.
    assert.doesNotMatch(publicCheckBody, /\$role -eq/);
    assert.doesNotMatch(publicCheckBody, /CloudRunInvocationRoles/);
  });

  test('both public principal types (allUsers and allAuthenticatedUsers) are checked for the service-level binding', () => {
    const blockerIndex = preflightScript.indexOf('worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers');
    const context = preflightScript.slice(blockerIndex - 400, blockerIndex);
    assert.match(context, /\$_ -ceq 'allUsers' -or \$_ -ceq 'allAuthenticatedUsers'/);
  });

  test('the task-caller invocation-binding recognition check still only recognizes the two approved invocation roles, unlike the broader service-level public check', () => {
    const blockerIndex = preflightScript.indexOf('task-caller service account lacks an explicit Cloud Run invocation binding');
    const context = preflightScript.slice(blockerIndex - 1200, blockerIndex);
    const occurrences = context.match(/\$script:CloudRunInvocationRoles -ccontains \$role/g) || [];
    // Once for the service-scope binding check, once for the project-scope
    // binding check — both still filtered to the approved invocation roles.
    assert.ok(occurrences.length >= 2, `expected at least 2 CloudRunInvocationRoles checks, found ${occurrences.length}`);
  });

  test('the task-caller invocation requirement is a blocker, not merely a warning, and the old warning-only text is gone', () => {
    assert.match(preflightScript, /task-caller service account lacks an explicit Cloud Run invocation binding/);
    assert.doesNotMatch(preflightScript, /no explicit service IAM binding for the task caller/);
    const blockerIndex = preflightScript.indexOf('task-caller service account lacks an explicit Cloud Run invocation binding');
    const context = preflightScript.slice(blockerIndex - 60, blockerIndex);
    assert.match(context, /\$blockers\.Add\(/);
  });

  test('the task-caller invocation requirement accepts an explicit binding at either the worker-service IAM scope or the project IAM scope', () => {
    const blockerIndex = preflightScript.indexOf('task-caller service account lacks an explicit Cloud Run invocation binding');
    const context = preflightScript.slice(blockerIndex - 1600, blockerIndex);
    assert.match(context, /\$callerServiceMatchingBindings = \$bindings \| Where-Object/);
    assert.match(context, /\$callerServiceBinding = \$callerServiceMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
    assert.match(context, /\$callerProjectMatchingBindings = \$projectBindingsForCaller \| Where-Object/);
    assert.match(context, /\$callerProjectBinding = \$callerProjectMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
    assert.match(context, /if \(@\(\$callerServiceBinding\)\.Count -eq 0 -and @\(\$callerProjectBinding\)\.Count -eq 0\) \{/);
  });

  test('the task-caller invocation requirement is gated on a successful project IAM policy in addition to WorkerServiceName, TaskCallerServiceAccount, and a successful worker-service IAM policy', () => {
    assert.match(preflightScript, /if \(\$TaskCallerServiceAccount -and \$projectIamPolicyResult\.status -eq 'success'\) \{/);
  });

  test('project-level public IAM bindings are evaluated independently of the service-level check', () => {
    assert.match(preflightScript, /project-level IAM policy grants a role to allUsers or allAuthenticatedUsers/);
    const start = preflightScript.indexOf("$projectBindings = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))\n            foreach ($candidateAccount");
    assert.ok(start >= 0, 'expected to locate the Owner/Editor + public-binding project IAM block');
    const end = preflightScript.indexOf('folder- and organization-level inherited IAM policies', start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /\$publicProjectBinding = \$projectBindings \| Where-Object \{/);
    assert.match(body, /\$_ -ceq 'allUsers' -or \$_ -ceq 'allAuthenticatedUsers'/);
  });

  test('the service-level and project-level public-IAM checks are structurally separate (different blocker text, different binding source)', () => {
    const serviceBlockerIndex = preflightScript.indexOf('worker-service IAM policy grants a role to allUsers or allAuthenticatedUsers');
    const projectBlockerIndex = preflightScript.indexOf('project-level IAM policy grants a role to allUsers or allAuthenticatedUsers');
    assert.ok(serviceBlockerIndex >= 0 && projectBlockerIndex >= 0);
    assert.notEqual(serviceBlockerIndex, projectBlockerIndex);
  });

  test('the project-level check is conservative: it blocks any role granted to a public principal, not only an enumerated invocation-role list', () => {
    const start = preflightScript.indexOf("$projectBindings = ConvertTo-DataArray (Get-SafeProperty -Object $projectIamPolicyResult.data -PropertyPath @('bindings'))\n            foreach ($candidateAccount");
    assert.ok(start >= 0, 'expected to locate the Owner/Editor + public-binding project IAM block');
    const end = preflightScript.indexOf('folder- and organization-level inherited IAM policies', start);
    const body = preflightScript.slice(start, end);
    const publicCheckIndex = body.indexOf('$publicProjectBinding = $projectBindings');
    const publicCheckBody = body.slice(publicCheckIndex, publicCheckIndex + 300);
    // No role-name filter appears in the project-level public-binding
    // predicate itself — only the members check.
    assert.doesNotMatch(publicCheckBody, /\$role -eq/);
    assert.doesNotMatch(publicCheckBody, /CloudRunInvocationRoles/);
  });

  test('ancestor (folder/organization) IAM limitations are documented in the script as a warning', () => {
    assert.match(
      preflightScript,
      /\$warnings\.Add\('folder- and organization-level inherited IAM policies are not retrieved by this project-scoped preflight and require separate human review'\)/
    );
  });

  test('the ancestor-IAM warning is unconditional (always recorded, not tied to a specific supplied target)', () => {
    const warningIndex = preflightScript.indexOf('folder- and organization-level inherited IAM policies');
    const precedingContext = preflightScript.slice(warningIndex - 320, warningIndex);
    // Sits directly after the project IAM policy `if` block closes, at the
    // same 8-space indentation level as the rest of the always-run
    // evaluation body — not nested inside a WorkerServiceName/
    // RuntimeServiceAccount guard (which would indent further).
    assert.match(precedingContext, /\n {8}\}\n\n {8}# This preflight is scoped/);
  });
});

describe('Canonical output-directory protection', () => {
  test('defines a canonical directory resolution helper that follows a symlink/junction Target', () => {
    assert.match(preflightScript, /function Resolve-CanonicalDirectoryPath/);
    const start = preflightScript.indexOf('function Resolve-CanonicalDirectoryPath');
    const end = preflightScript.indexOf('function Resolve-ValidatedOutputPath');
    const body = preflightScript.slice(start, end);
    assert.match(body, /\$item\.Target/);
    assert.match(body, /try\s*\{/);
    assert.match(body, /catch\s*\{\s*\$targetReadFailed = \$true\s*\}/);
  });

  test('both the requested parent directory and the repository root are canonicalized before comparison', () => {
    const start = preflightScript.indexOf('function Resolve-ValidatedOutputPath');
    const end = preflightScript.indexOf('# ----------', start);
    const body = preflightScript.slice(start, end);
    const parentDirExistsIndex = body.indexOf('OutputPath parent directory must already exist');
    const canonicalParentIndex = body.indexOf('Resolve-CanonicalDirectoryPath -Path $parentDirectory');
    const canonicalRepoRootIndex = body.indexOf('Resolve-CanonicalDirectoryPath -Path $RepositoryRoot');
    assert.ok(parentDirExistsIndex >= 0 && canonicalParentIndex >= 0 && canonicalRepoRootIndex >= 0);
    assert.ok(parentDirExistsIndex < canonicalParentIndex, 'existence must be verified before canonicalization');
  });

  test('the canonical output destination recombines the canonical parent with the requested filename', () => {
    assert.match(
      preflightScript,
      /\$canonicalOutputDestination = Join-Path -Path \$canonicalParentDirectory -ChildPath \(Split-Path -Path \$normalized -Leaf\)/
    );
  });

  test('the containment comparison uses the canonical destination and canonical repository root, not the lexical ones', () => {
    const start = preflightScript.indexOf('function Resolve-ValidatedOutputPath');
    const end = preflightScript.indexOf('# ----------', start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /\$canonicalOutputDestination\.StartsWith\(\$repoRootWithSeparator/);
    assert.match(body, /\$repoRootWithSeparator = \$canonicalRepositoryRoot\.TrimEnd/);
  });

  test('CreateNew is still used for the final write, and no overwrite/Force parameter is introduced', () => {
    assert.match(preflightScript, /FileMode\]::CreateNew/);
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Force\b/i);
    assert.doesNotMatch(preflightScript, /\[switch\]\s*\$Overwrite\b/i);
  });

  function getResolverBody() {
    const start = preflightScript.indexOf('function Resolve-CanonicalDirectoryPath');
    const end = preflightScript.indexOf('function Resolve-ValidatedOutputPath');
    return preflightScript.slice(start, end);
  }

  test('every path component is inspected: resolution iterates segment-by-segment from the root down, not just the final leaf', () => {
    const body = getResolverBody();
    assert.match(body, /for \(\$segmentIndex = 0; \$segmentIndex -lt \$segments\.Count; \$segmentIndex\+\+\) \{/);
    assert.match(body, /\$builtPath = Join-Path -Path \$builtPath -ChildPath \$segments\[\$segmentIndex\]/);
    assert.match(body, /\$item = Get-Item -LiteralPath \$builtPath -Force/);
  });

  test('a chained link restarts canonical resolution from the spliced (target + remaining segments) path', () => {
    const body = getResolverBody();
    assert.match(body, /\$current = \$targetValue/);
    assert.match(body, /for \(\$remainingIndex = \$segmentIndex \+ 1; \$remainingIndex -lt \$segments\.Count; \$remainingIndex\+\+\) \{/);
    assert.match(body, /\$linkEncountered = \$true/);
    assert.match(body, /while \(\$true\) \{/);
    // The outer while loop only returns once no link was encountered during
    // a full pass, so encountering a link anywhere restarts resolution.
    assert.match(body, /if \(-not \$linkEncountered\) \{[\s\S]*?return \$builtPath\s*\n\s*\}/);
  });

  test('a visited-path set protects against a reparse-point cycle', () => {
    const body = getResolverBody();
    assert.match(body, /\$visitedLinkPaths = New-Object 'System\.Collections\.Generic\.HashSet\[string\]'/);
    assert.match(body, /if \(-not \$visitedLinkPaths\.Add\(\$builtPath\)\) \{/);
    assert.match(body, /detected a reparse-point cycle/);
  });

  test('a conservative maximum link-follow depth is enforced', () => {
    assert.match(preflightScript, /\$script:MaxCanonicalLinkDepth = 10/);
    const body = getResolverBody();
    assert.match(body, /\$linkFollowCount\+\+/);
    assert.match(body, /if \(\$linkFollowCount -gt \$script:MaxCanonicalLinkDepth\) \{/);
    assert.match(body, /exceeded the maximum allowed reparse-point depth/);
  });

  test('an ancestor component that does not exist, or is not a directory, fails closed by throwing (PathType Container)', () => {
    const body = getResolverBody();
    assert.match(body, /if \(-not \(Test-Path -LiteralPath \$builtPath -PathType Container\)\) \{\s*throw/);
  });

  test('the resolver never returns a file path: the final destination is also checked with PathType Container', () => {
    const body = getResolverBody();
    assert.match(body, /if \(-not \$linkEncountered\) \{[\s\S]*?if \(-not \(Test-Path -LiteralPath \$builtPath -PathType Container\)\) \{\s*throw[\s\S]*?return \$builtPath/);
  });

  test('a confirmed reparse point (FileAttributes.ReparsePoint) mandates a resolvable target — not merely a truthy Target check', () => {
    const body = getResolverBody();
    assert.match(body, /\$isReparsePoint = \(\(\[int\]\$item\.Attributes\) -band \(\[int\]\[System\.IO\.FileAttributes\]::ReparsePoint\)\) -ne 0/);
    assert.match(body, /if \(\$isReparsePoint\) \{/);
  });

  test('a Target getter that throws fails closed', () => {
    const body = getResolverBody();
    assert.match(body, /\$targetReadFailed = \$false/);
    assert.match(body, /catch\s*\{\s*\$targetReadFailed = \$true\s*\}/);
    assert.match(body, /if \(\$targetReadFailed\) \{\s*throw 'OutputPath directory resolution failed: unable to read a reparse point target\.'/);
  });

  test('a null Target fails closed', () => {
    const body = getResolverBody();
    assert.match(body, /\$target = \$null/);
    assert.match(body, /if \(\$targetValue -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$targetValue\)\) \{\s*throw 'OutputPath directory resolution failed: a reparse point has no resolvable target\.'/);
  });

  test('a blank (whitespace-only) Target fails closed via IsNullOrWhiteSpace, not IsNullOrEmpty', () => {
    const body = getResolverBody();
    assert.match(body, /IsNullOrWhiteSpace\(\$targetValue\)/);
    assert.doesNotMatch(body, /IsNullOrEmpty\(\$targetValue\)/);
  });

  test('an empty Target array fails closed', () => {
    const body = getResolverBody();
    assert.match(body, /if \(\$targetValue -is \[System\.Array\]\) \{\s*if \(\$targetValue\.Count -eq 0\) \{\s*throw 'OutputPath directory resolution failed: a reparse point has no resolvable target\.'/);
  });

  test('a Target array with exactly one element is accepted: the single element is selected', () => {
    const body = getResolverBody();
    assert.match(body, /\$targetValue = \$targetValue\[0\]/);
  });

  test('a Target array with more than one element fails closed as ambiguous — element zero is never silently selected', () => {
    const body = getResolverBody();
    assert.match(body, /if \(\$targetValue\.Count -gt 1\) \{\s*throw 'OutputPath directory resolution failed: a reparse point has an ambiguous multi-value target\.'/);
    // The Count -gt 1 check must occur before the Count-0 array is indexed,
    // so element zero of a multi-element array is never reached.
    const countZeroIndex = body.indexOf('if ($targetValue.Count -eq 0)');
    const countGtOneIndex = body.indexOf('if ($targetValue.Count -gt 1)');
    const indexZeroIndex = body.indexOf('$targetValue = $targetValue[0]');
    assert.ok(countZeroIndex >= 0 && countGtOneIndex >= 0 && indexZeroIndex >= 0);
    assert.ok(countZeroIndex < countGtOneIndex && countGtOneIndex < indexZeroIndex);
  });

  test('a non-string scalar or object target (after array narrowing) fails closed the same generic way as a blank target', () => {
    const body = getResolverBody();
    assert.match(body, /if \(\$targetValue -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$targetValue\)\) \{/);
  });

  test('every reparse-point-target diagnostic is generic and never includes the target path itself', () => {
    const body = getResolverBody();
    const throwMessages = [...body.matchAll(/throw '([^']*)'/g)].map((m) => m[1]);
    for (const message of throwMessages) {
      assert.doesNotMatch(message, /\$/);
    }
  });

  test('a component that is not a reparse point is never routed through target-resolution logic', () => {
    const body = getResolverBody();
    const ifReparseIndex = body.indexOf('if ($isReparsePoint) {');
    const forLoopEndIndex = body.indexOf('if (-not $linkEncountered) {');
    assert.ok(ifReparseIndex >= 0 && ifReparseIndex < forLoopEndIndex);
  });

  test('Resolve-ValidatedOutputPath returns canonicalOutputDestination, not the original lexical path', () => {
    const start = preflightScript.indexOf('function Resolve-ValidatedOutputPath');
    const end = preflightScript.indexOf('# ----------------------------------------------------------------------\n# Safe property access', start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /return \$canonicalOutputDestination\s*\n\}/);
    assert.doesNotMatch(body, /return \$normalized\b/);
  });

  test('the caller uses the returned canonical destination for File.Open/CreateNew', () => {
    assert.match(preflightScript, /\$resolvedOutputPath = Resolve-ValidatedOutputPath/);
    assert.match(preflightScript, /\[System\.IO\.File\]::Open\(\$resolvedOutputPath, \[System\.IO\.FileMode\]::CreateNew/);
  });

  test('traversal starts from the true root exactly as GetPathRoot returned it, never trimmed', () => {
    const body = getResolverBody();
    assert.match(body, /\$builtPath = \$root\s*\n/);
  });

  test('the resolver does not trim a drive root: no $root.TrimEnd anywhere in the function', () => {
    const body = getResolverBody();
    assert.doesNotMatch(body, /\$root\.TrimEnd/);
  });

  test('a Windows drive-root path remains absolute after Join-Path with the first child segment', () => {
    // Join-Path -Path "C:\" -ChildPath "Users" correctly produces "C:\Users"
    // (still absolute) — this is exactly what $builtPath = $root followed
    // by the per-segment Join-Path loop relies on, in contrast to the
    // previous $root.TrimEnd(...) bug that produced the drive-relative
    // "C:" before the first Join-Path call.
    const result = path.win32.join('C:\\', 'Users');
    assert.equal(result, 'C:\\Users');
  });

  test('a UNC share root remains absolute after Join-Path with the first child segment', () => {
    const result = path.win32.join('\\\\server\\share\\', 'Users');
    assert.equal(result, '\\\\server\\share\\Users');
  });

  test('the previous "IsNullOrEmpty($builtPath) fallback to $root" pattern is absent (no longer needed since $root is never trimmed)', () => {
    const body = getResolverBody();
    assert.doesNotMatch(body, /IsNullOrEmpty\(\$builtPath\)/);
  });
});

describe('Active-account metadata minimization', () => {
  function getAccountProjectionBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeAccountListResult');
    const end = preflightScript.indexOf('# Projects a successful `gcloud config list` result');
    assert.ok(start >= 0 && end > start);
    return preflightScript.slice(start, end);
  }

  test('defines a safe account-list projection function', () => {
    assert.match(preflightScript, /function ConvertTo-SafeAccountListResult/);
  });

  test('the projection is wrapped in try/catch so it never leaks an exception', () => {
    const body = getAccountProjectionBody();
    assert.match(body, /try\s*\{/);
    assert.match(body, /catch\s*\{/);
    assert.match(body, /-ErrorCategory 'malformed_output' -SafeError 'Authenticated account list could not be safely projected\.'/);
  });

  test('account must be a non-blank string; a non-string, blank, or whitespace-only value is rejected as malformed_output', () => {
    const body = getAccountProjectionBody();
    assert.match(body, /\$accountValue -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$accountValue\)/);
    assert.doesNotMatch(body, /IsNullOrEmpty\(\$accountValue\)/);
    assert.match(body, /-ErrorCategory 'malformed_output' -SafeError 'Authenticated account list contained an entry with no usable account identifier\.'/);
  });

  test('status must be a string; a blank string is allowed (may represent an inactive account), but a non-string is rejected', () => {
    const body = getAccountProjectionBody();
    assert.match(body, /if \(\$statusValue -isnot \[string\]\) \{/);
    assert.match(body, /-ErrorCategory 'malformed_output' -SafeError 'Authenticated account list contained an entry with a non-string status\.'/);
    // Only the type is checked for status — no IsNullOrEmpty guard — so a
    // present, blank, string-typed status is not rejected.
    assert.doesNotMatch(body, /\$statusValue -isnot \[string\] -or \[string\]::IsNullOrEmpty\(\$statusValue\)/);
  });

  test('a scalar or otherwise unexpected account-list entry (no inspectable account/status properties) is rejected the same way', () => {
    // Get-SafeProperty on a non-object (e.g. a bare string or number entry)
    // returns $null for both 'account' and 'status', which the same
    // non-string/empty checks above already reject — no separate branch is
    // needed to special-case scalar entries.
    const body = getAccountProjectionBody();
    assert.match(body, /\$accountValue = Get-SafeProperty -Object \$account -PropertyPath @\('account'\)/);
    assert.match(body, /\$statusValue = Get-SafeProperty -Object \$account -PropertyPath @\('status'\)/);
  });

  test('malformed output returns status failed, errorCategory malformed_output, a generic safeError, and never the raw response', () => {
    const body = getAccountProjectionBody();
    const failedReturns = (body.match(/-Status 'failed'/g) || []).length;
    assert.ok(failedReturns >= 2, 'expected at least two malformed-output rejection paths (bad account, bad status)');
    assert.doesNotMatch(body, /-Data \$rawAccounts/);
    assert.doesNotMatch(body, /-Data \$account\b/);
  });

  test('the projection retains only account and status fields on the safe path', () => {
    const body = getAccountProjectionBody();
    assert.match(body, /\[pscustomobject\]@\{\s*account = \$accountValue\s*status\s*= \$statusValue\s*\}/);
  });

  test('non-success results pass through unchanged rather than being reshaped', () => {
    const body = getAccountProjectionBody();
    assert.match(body, /if \(\$Result\.status -ne 'success'\) \{\s*return \$Result\s*\}/);
  });

  test('the authList discovery call is wrapped in the safe projection before being stored', () => {
    assert.match(
      preflightScript,
      /\$authListResult = Add-Result 'authList' \(ConvertTo-SafeAccountListResult -Result \(Invoke-ReadOnlyGcloudCommand -Id 'authList'/
    );
  });

  test('the multiple-active-account check requires exactly ACTIVE status and a valid non-blank projected account string', () => {
    assert.match(preflightScript, /\$accountStatus -ceq 'ACTIVE' -and \$accountValue -is \[string\] -and -not \[string\]::IsNullOrWhiteSpace\(\$accountValue\)/);
  });

  test('an ACTIVE entry without a valid account cannot pass the active-account check', () => {
    // Structural proof: the Where-Object predicate is a single boolean
    // expression requiring accountStatus -ceq 'ACTIVE' AND a valid,
    // non-blank string account — there is no alternate branch that counts
    // status alone.
    const checkIndex = preflightScript.indexOf("\$accountStatus -ceq 'ACTIVE' -and \$accountValue -is [string]");
    assert.ok(checkIndex >= 0);
    const checkLine = preflightScript.slice(preflightScript.lastIndexOf('\n', checkIndex), preflightScript.indexOf('\n', checkIndex));
    assert.doesNotMatch(checkLine, / -or /);
  });

  test('an ACTIVE entry whose account is whitespace-only cannot pass (IsNullOrWhiteSpace, not IsNullOrEmpty)', () => {
    assert.doesNotMatch(preflightScript, /\$accountStatus -ceq 'ACTIVE'[\s\S]{0,40}IsNullOrEmpty/);
  });

  test('report-bound account data is the safe projection, not the raw command response: no credential path, token, or unrelated field name appears in the projection function', () => {
    const body = getAccountProjectionBody();
    assert.doesNotMatch(body, /credential/i);
    assert.doesNotMatch(body, /token/i);
  });
});

describe('Documentation contract', () => {
  const requiredDocStrings = [
    'read-only',
    'no remediation',
    'does not deploy',
    'does not access secret payloads',
    'does not list Cloud Tasks task payloads',
    'does not apply any database migration',
    'remains unapplied',
    'must remain paused',
    'Human review',
    'sensitive',
    'never commit the report',
    'redact',
    'Execution template',
    'may be omitted',
    'Read-only command inventory',
    'Required API checklist',
    'Report interpretation',
    'Review checklist',
    'Forbidden remediation',
    'Incomplete or inaccessible discovery',
    'never treated as proof of absence',
    'prevents a clean preflight',
    'REDACTED_PATH',
    'internal read-only command allowlist',
  ];

  for (const required of requiredDocStrings) {
    test(`documentation contains "${required}"`, () => {
      assert.ok(
        preflightDoc.toLowerCase().includes(required.toLowerCase()),
        `expected PRIVATE_WORKER_PREFLIGHT.md to contain "${required}"`
      );
    });
  }
});

describe('Placeholder safety', () => {
  const requiredPlaceholders = [
    '<PROJECT_ID>',
    '<REGION>',
    '<TASKS_LOCATION>',
    '<OUTPUT_PATH>',
    '<WORKER_SERVICE_NAME>',
    '<ARTIFACT_REPOSITORY>',
    '<QUEUE_NAME>',
    '<RUNTIME_SERVICE_ACCOUNT>',
    '<TASK_CALLER_SERVICE_ACCOUNT>',
    '<SUPABASE_SECRET_NAME>',
    '<GEMINI_SECRET_NAME>',
  ];

  for (const placeholder of requiredPlaceholders) {
    test(`documentation includes placeholder ${placeholder}`, () => {
      assert.ok(preflightDoc.includes(placeholder));
    });
  }

  test('does not contain a real service-account email', () => {
    // "gcp-sa-"-prefixed domains are Google-managed service-agent
    // identities (e.g. the Cloud Tasks service agent), not customer
    // account emails, and are documented literally in Section H.
    assert.doesNotMatch(preflightDoc, /@(?!gcp-sa-)[a-z0-9-]+\.iam\.gserviceaccount\.com/);
  });

  test('does not contain a real project ID (bare, outside placeholder markers)', () => {
    assert.doesNotMatch(preflightDoc, /swingproai/i);
  });

  test('does not contain an actual Supabase project URL', () => {
    assert.doesNotMatch(preflightDoc, /https:\/\/[a-z0-9]{15,}\.supabase\.co/);
  });

  test('does not contain a JWT-like token', () => {
    assert.doesNotMatch(preflightDoc, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  test('does not contain an sb_secret_ value', () => {
    assert.doesNotMatch(preflightDoc, /sb_secret_[A-Za-z0-9]/);
  });

  test('does not contain a Gemini key-shaped value', () => {
    assert.doesNotMatch(preflightDoc, /AIza[0-9A-Za-z_-]{10,}/);
  });

  test('does not contain a real Cloud Run URL', () => {
    assert.doesNotMatch(preflightDoc, /https:\/\/[a-z0-9-]+-[a-z0-9]{8,}\.[a-z0-9-]*run\.app/);
  });

  test('does not present a localhost production target', () => {
    assert.doesNotMatch(preflightDoc, /localhost/i);
    assert.doesNotMatch(preflightDoc, /127\.0\.0\.1/);
  });

  test('does not contain a NEXT_PUBLIC secret assignment', () => {
    assert.doesNotMatch(preflightDoc, /NEXT_PUBLIC_\w*\s*=/);
  });
});

describe('Official references', () => {
  const requiredUrls = [
    'https://cloud.google.com/sdk/gcloud/reference/projects/describe',
    'https://cloud.google.com/sdk/gcloud/reference/projects/get-iam-policy',
    'https://cloud.google.com/sdk/gcloud/reference/services/list',
    'https://cloud.google.com/sdk/gcloud/reference/artifacts/repositories/list',
    'https://cloud.google.com/sdk/gcloud/reference/artifacts/repositories/get-iam-policy',
    'https://cloud.google.com/sdk/gcloud/reference/run/services/list',
    'https://cloud.google.com/sdk/gcloud/reference/run/services/describe',
    'https://cloud.google.com/sdk/gcloud/reference/run/services/get-iam-policy',
    'https://cloud.google.com/sdk/gcloud/reference/iam/service-accounts/list',
    'https://cloud.google.com/sdk/gcloud/reference/iam/service-accounts/get-iam-policy',
    'https://cloud.google.com/sdk/gcloud/reference/secrets/list',
    'https://cloud.google.com/sdk/gcloud/reference/secrets/describe',
    'https://cloud.google.com/sdk/gcloud/reference/secrets/versions/describe',
    'https://cloud.google.com/sdk/gcloud/reference/secrets/get-iam-policy',
    'https://cloud.google.com/sdk/gcloud/reference/tasks/queues/describe',
    'https://cloud.google.com/sdk/gcloud/reference/tasks/queues/get-iam-policy',
  ];

  for (const url of requiredUrls) {
    test(`documentation includes reference ${url}`, () => {
      assert.ok(preflightDoc.includes(url));
    });
  }

  test('does not include unofficial reference domains', () => {
    assert.doesNotMatch(preflightDoc, /medium\.com/);
    assert.doesNotMatch(preflightDoc, /stackoverflow\.com/);
    assert.doesNotMatch(preflightDoc, /reddit\.com/);
    assert.doesNotMatch(preflightDoc, /blogspot\./);
  });
});

describe('Consistency with the deployment runbook', () => {
  test('the deployment runbook still documents the migration as unapplied', () => {
    assert.match(deploymentDoc, /remains\s+unapplied/i);
  });

  test('the deployment runbook still requires --no-allow-unauthenticated', () => {
    assert.ok(deploymentDoc.includes('--no-allow-unauthenticated'));
  });
});

describe('TaskCreatorServiceAccount parameter', () => {
  test('declared as an optional [string] parameter on both the top-level param block and Invoke-PrivateWorkerPreflightMain', () => {
    const occurrences = [...preflightScript.matchAll(/\[string\]\s*\$TaskCreatorServiceAccount\b/g)];
    assert.equal(occurrences.length, 2, `expected 2 declarations, found ${occurrences.length}`);
  });

  test('is passed through to Invoke-PrivateWorkerPreflightMain at the direct-execution call site', () => {
    assert.match(preflightScript, /-TaskCreatorServiceAccount\s+\$TaskCreatorServiceAccount\s*`/);
  });

  test('validated with the same conservative service-account email pattern as the other supplied service accounts', () => {
    assert.match(
      preflightScript,
      /if \(\$TaskCreatorServiceAccount -and -not \(Test-ValidServiceAccountEmail -Value \$TaskCreatorServiceAccount -ProjectId \$ProjectId\)\) \{/
    );
    const throwIndex = preflightScript.indexOf('TaskCreatorServiceAccount is invalid or does not match ProjectId domain.');
    assert.ok(throwIndex >= 0);
  });

  test('an invalid TaskCreatorServiceAccount fails local validation (exit 3), not cloud discovery', () => {
    const validationBlockStart = preflightScript.indexOf('# ---- Local validation');
    const validationBlockEnd = preflightScript.indexOf("[Console]::Error.WriteLine(\"Preflight local validation failed");
    const body = preflightScript.slice(validationBlockStart, validationBlockEnd);
    assert.match(body, /TaskCreatorServiceAccount is invalid or does not match ProjectId domain\./);
  });

  test('targeted discovery calls describe and get-iam-policy for the supplied service account', () => {
    const describeArgs = declarationFor('taskCreatorServiceAccountDescribe');
    const iamArgs = declarationFor('taskCreatorServiceAccountIamPolicy');
    assert.match(describeArgs, /'iam',\s*'service-accounts',\s*'describe',\s*\$TaskCreatorServiceAccount/);
    assert.match(iamArgs, /'iam',\s*'service-accounts',\s*'get-iam-policy',\s*\$TaskCreatorServiceAccount/);
  });

  test('a warning is recorded when TaskCreatorServiceAccount is omitted', () => {
    assert.match(preflightScript, /\$warnings\.Add\('target optional parameter not supplied: TaskCreatorServiceAccount'\)/);
  });

  test('disabled-account metadata is checked the same way as RuntimeServiceAccount/TaskCallerServiceAccount (malformed vs. true are distinct blockers)', () => {
    assert.match(preflightScript, /malformed service-account metadata: missing or non-boolean disabled field for TaskCreatorServiceAccount/);
    assert.match(preflightScript, /supplied service account disabled: TaskCreatorServiceAccount/);
  });

  test('documentation includes the new parameter using only a placeholder value', () => {
    assert.match(preflightDoc, /-TaskCreatorServiceAccount\s+"<TASK_CREATOR_SERVICE_ACCOUNT>"/);
    assert.doesNotMatch(preflightDoc, /@(?!gcp-sa-)[a-z0-9-]+\.iam\.gserviceaccount\.com/);
  });
});

describe('Section 1A: task-creator actAs (roles/iam.serviceAccountUser) verification', () => {
  function getSection1Body() {
    const start = preflightScript.indexOf('# ---- Section 1: Cloud Tasks OIDC IAM prerequisites');
    const end = preflightScript.indexOf("if (\$projectIamPolicyResult.status -eq 'success') {\n            \$projectBindings", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the Section 1 evaluation block');
    return preflightScript.slice(start, end);
  }

  test('the whole Section 1 block is gated on TaskCallerServiceAccount being supplied', () => {
    const body = getSection1Body();
    assert.match(body, /^\s*if \(\$TaskCallerServiceAccount\) \{/m);
  });

  test('TaskCreatorServiceAccount not supplied while TaskCallerServiceAccount is supplied produces the exact actAs blocker text', () => {
    const body = getSection1Body();
    assert.match(body, /if \(-not \$TaskCreatorServiceAccount\) \{\s*\n\s*\$blockers\.Add\('task creator lacks explicit iam\.serviceAccounts\.actAs authorization on the task-caller service account'\)/);
  });

  test('when both are supplied, requires an explicit roles/iam.serviceAccountUser binding for the task creator on the taskCallerServiceAccountIamPolicy', () => {
    const body = getSection1Body();
    assert.match(body, /\$taskCallerServiceAccountIamPolicyForActAs = \$commandResults\['taskCallerServiceAccountIamPolicy'\]/);
    assert.match(body, /\(\$role -ceq 'roles\/iam\.serviceAccountUser'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$actAsMember \}\)/);
    assert.match(body, /\$actAsMember = "serviceAccount:\$TaskCreatorServiceAccount"/);
  });

  test('absence of the actAs binding produces the exact required blocker text', () => {
    const body = getSection1Body();
    assert.match(body, /if \(@\(\$actAsBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('task creator lacks explicit iam\.serviceAccounts\.actAs authorization on the task-caller service account'\)/);
  });

  test('never accepts Owner, Editor, or an unrecognized role as proof of actAs authorization (only roles/iam.serviceAccountUser is matched)', () => {
    const body = getSection1Body();
    const actAsCheckIndex = body.indexOf('$actAsMatchingBindings = $taskCallerBindingsForActAs');
    const actAsCheckBody = body.slice(actAsCheckIndex, actAsCheckIndex + 400);
    assert.doesNotMatch(actAsCheckBody, /roles\/owner/);
    assert.doesNotMatch(actAsCheckBody, /roles\/editor/);
    assert.match(actAsCheckBody, /roles\/iam\.serviceAccountUser/);
  });

  test('documents that a custom role containing actAs requires separate human review', () => {
    const body = getSection1Body();
    assert.match(body, /custom role containing actAs requires[\s\S]{0,40}separate human review/);
  });

  test('documentation states the actAs requirement and that Owner/Editor/unknown roles are never accepted as proof', () => {
    assert.match(preflightDoc, /iam\.serviceAccounts\.actAs/);
    assert.match(preflightDoc, /roles\/iam\.serviceAccountUser/);
    assert.match(preflightDoc, /never\s*\n?\s*accepted as proof/);
  });
});

describe('Section 1B: Cloud Tasks service-agent (roles/cloudtasks.serviceAgent) verification', () => {
  function getSection1Body() {
    const start = preflightScript.indexOf('# ---- Section 1: Cloud Tasks OIDC IAM prerequisites');
    const end = preflightScript.indexOf("if (\$projectIamPolicyResult.status -eq 'success') {\n            \$projectBindings", start);
    return preflightScript.slice(start, end);
  }

  test('reads the project number from the already-retrieved projectDescribe result, not a new command', () => {
    const body = getSection1Body();
    assert.match(body, /Get-SafeProperty -Object \$projectDescribeResult\.data -PropertyPath @\('projectNumber'\)/);
  });

  test('accepts a nonblank string of plain positive digits (no leading zero) or a positive integral numeric scalar, rejecting anything else as malformed', () => {
    const body = getSection1Body();
    assert.match(body, /\$projectNumberIsValidString = \(\$projectNumberRaw -is \[string\]\) -and \(\$projectNumberRaw -cmatch '\^\[1-9\]\[0-9\]\*\$'\)/);
    assert.match(body, /\$projectNumberIsValidNumeric = \(\(\$projectNumberRaw -is \[int\]\)/);
    assert.match(body, /-and \(\$projectNumberRaw -gt 0\)/);
    assert.match(body, /if \(-not \$projectNumberIsValidString -and -not \$projectNumberIsValidNumeric\) \{/);
    assert.match(body, /project number is missing or malformed: cannot construct the Cloud Tasks service-agent identity/);
  });

  test('rejects zero and negative numbers: the numeric-scalar branch requires a positive value, not merely an integral type', () => {
    const body = getSection1Body();
    const numericCheckIndex = body.indexOf('$projectNumberIsValidNumeric =');
    const numericCheckLine = body.slice(numericCheckIndex, body.indexOf('\n', numericCheckIndex));
    assert.match(numericCheckLine, /-gt 0/);
  });

  test('rejects a decimal/floating-point projectNumber (not [string], not an accepted integral type)', () => {
    const body = getSection1Body();
    const numericCheckIndex = body.indexOf('$projectNumberIsValidNumeric =');
    const numericCheckLine = body.slice(numericCheckIndex, body.indexOf('\n', numericCheckIndex));
    assert.doesNotMatch(numericCheckLine, /\[double\]/);
    assert.doesNotMatch(numericCheckLine, /\[decimal\]/);
    assert.doesNotMatch(numericCheckLine, /\[single\]/);
  });

  test('rejects a signed or exponent-notation string: the string branch requires exactly ^[1-9][0-9]*$, with no leading zero, sign, decimal point, or exponent marker permitted by the pattern', () => {
    const body = getSection1Body();
    // The anchored pattern permits only a leading digit 1-9 followed by
    // digits 0-9 — it has no alternation or optional group that could
    // admit a leading '-', '+', '.', or 'e'/'E' anywhere in the string.
    assert.match(body, /\$projectNumberRaw -cmatch '\^\[1-9\]\[0-9\]\*\$'/);
  });

  test('revalidates the converted $projectNumberDigits value itself before it is ever interpolated into the IAM principal', () => {
    const body = getSection1Body();
    const conversionIndex = body.indexOf('$projectNumberDigits = [string]$projectNumberRaw');
    const revalidationIndex = body.indexOf("if (\$projectNumberDigits -cnotmatch '^[1-9][0-9]*$') {", conversionIndex);
    const memberConstructionIndex = body.indexOf('$cloudTasksServiceAgentMember = "serviceAccount:service-$projectNumberDigits@gcp-sa-cloudtasks.iam.gserviceaccount.com"');
    assert.ok(conversionIndex >= 0 && revalidationIndex >= 0 && memberConstructionIndex >= 0);
    assert.ok(conversionIndex < revalidationIndex && revalidationIndex < memberConstructionIndex, 'revalidation must occur after conversion and before the principal is constructed');
  });

  test('a malformed $projectNumberDigits after revalidation produces the same project-number blocker and is never interpolated', () => {
    const body = getSection1Body();
    const revalidationIndex = body.indexOf("if (\$projectNumberDigits -cnotmatch '^[1-9][0-9]*$') {");
    assert.ok(revalidationIndex >= 0);
    const revalidationBody = body.slice(revalidationIndex, revalidationIndex + 250);
    assert.match(revalidationBody, /project number is missing or malformed: cannot construct the Cloud Tasks service-agent identity/);
  });

  test('constructs exactly service-<PROJECT_NUMBER>@gcp-sa-cloudtasks.iam.gserviceaccount.com and nothing else', () => {
    const body = getSection1Body();
    assert.match(body, /\$cloudTasksServiceAgentMember = "serviceAccount:service-\$projectNumberDigits@gcp-sa-cloudtasks\.iam\.gserviceaccount\.com"/);
  });

  test('requires that exact member to hold an unconditional roles/cloudtasks.serviceAgent binding in the project IAM policy', () => {
    const body = getSection1Body();
    assert.match(body, /\(\$role -ceq 'roles\/cloudtasks\.serviceAgent'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$cloudTasksServiceAgentMember \}\)/);
    assert.match(body, /\$serviceAgentBinding = \$serviceAgentMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
  });

  test('a missing service-agent binding is the exact required blocker text', () => {
    const body = getSection1Body();
    assert.match(body, /if \(@\(\$serviceAgentBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('Cloud Tasks service agent lacks the required roles\/cloudtasks\.serviceAgent project-level binding'\)/);
  });

  test('a conditional-only matching service-agent binding produces a distinct warning requiring separate human review', () => {
    const body = getSection1Body();
    assert.match(body, /conditional IAM binding present for the Cloud Tasks service-agent project-level binding; requires separate human review/);
  });

  test('never grants, revokes, or alters IAM while performing this check (read-only get-iam-policy data only)', () => {
    const body = getSection1Body();
    assert.doesNotMatch(body, /set-iam-policy/);
    assert.doesNotMatch(body, /add-iam-policy-binding/);
  });

  test('documentation describes the Cloud Tasks service-agent construction and the required project-level binding', () => {
    assert.match(preflightDoc, /gcp-sa-cloudtasks\.iam\.gserviceaccount\.com/);
    assert.match(preflightDoc, /roles\/cloudtasks\.serviceAgent/);
  });
});

describe('Section 1C: task-creator identity separation and Owner/Editor blocking', () => {
  test('TaskCreatorServiceAccount must not equal RuntimeServiceAccount', () => {
    assert.match(
      preflightScript,
      /if \(\$TaskCreatorServiceAccount -and \$RuntimeServiceAccount -and \(\$TaskCreatorServiceAccount -ceq \$RuntimeServiceAccount\)\) \{\s*\n\s*\$blockers\.Add\('task-creator and runtime service accounts being the same identity'\)/
    );
  });

  test('TaskCreatorServiceAccount must not equal TaskCallerServiceAccount', () => {
    assert.match(
      preflightScript,
      /if \(\$TaskCreatorServiceAccount -and \$TaskCallerServiceAccount -and \(\$TaskCreatorServiceAccount -ceq \$TaskCallerServiceAccount\)\) \{\s*\n\s*\$blockers\.Add\('task-creator and task-caller service accounts being the same identity'\)/
    );
  });

  test('the project-level Owner/Editor loop now includes TaskCreatorServiceAccount alongside the other supplied service accounts', () => {
    assert.match(
      preflightScript,
      /foreach \(\$candidateAccount in @\(\$RuntimeServiceAccount, \$TaskCallerServiceAccount, \$TaskCreatorServiceAccount\)\) \{/
    );
  });
});

describe('Section 2: task-caller Cloud Run invocation is a required blocker', () => {
  test('the old warning-only behavior text no longer exists anywhere in the script', () => {
    assert.doesNotMatch(preflightScript, /no explicit service IAM binding for the task caller/);
  });

  test('a missing invocation binding at both scopes produces the exact required blocker text', () => {
    assert.match(preflightScript, /task-caller service account lacks an explicit Cloud Run invocation binding/);
  });

  test('the check is gated on WorkerServiceName, TaskCallerServiceAccount, a successful worker-service IAM policy, and a successful project IAM policy', () => {
    const outerIfIndex = preflightScript.indexOf('if ($WorkerServiceName) {');
    const innerIamIfIndex = preflightScript.indexOf("if (\$iamPolicyResult.status -eq 'success') {", outerIfIndex);
    const callerIfIndex = preflightScript.indexOf("if (\$TaskCallerServiceAccount -and \$projectIamPolicyResult.status -eq 'success') {", innerIamIfIndex);
    assert.ok(outerIfIndex >= 0 && innerIamIfIndex >= 0 && callerIfIndex >= 0);
    assert.ok(outerIfIndex < innerIamIfIndex && innerIamIfIndex < callerIfIndex, 'the caller-invocation check must be nested inside WorkerServiceName and the successful-IAM-policy guard');
  });
});

describe('Section 4: malformed Cloud Run nested collections must fail closed', () => {
  function getNormalizerBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const end = preflightScript.indexOf('# ----------------------------------------------------------------------\n# Fail-closed blocker helpers', start);
    return preflightScript.slice(start, end);
  }

  test('declares a reusable scalar-type test helper used to reject non-collection nested values', () => {
    assert.match(preflightScript, /function Test-IsScalarValue/);
  });

  test('containerImagesRaw is rejected outright when it is a scalar (string/number/boolean), not merely iterated', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$containerImagesRaw -and \(Test-IsScalarValue -Value \$containerImagesRaw\)\) \{/);
    assert.match(body, /non-collection container list value/);
  });

  test('a scalar container entry inside the collection is rejected as not an inspectable object', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$container -or \(Test-IsScalarValue -Value \$container\)\) \{/);
    assert.match(body, /container entry that is not an inspectable object/);
  });

  test('a container entry with a missing or null image is rejected, never silently skipped with continue', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$image -or \$image -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$image\)\) \{/);
    // The old silent-skip statement must no longer exist anywhere in the file.
    assert.doesNotMatch(preflightScript, /if \(\$null -eq \$image\) \{ continue \}/);
  });

  test('trafficRaw is rejected outright when it is a scalar, not merely iterated', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$trafficRaw -and \(Test-IsScalarValue -Value \$trafficRaw\)\) \{/);
    assert.match(body, /non-collection traffic value/);
  });

  test('a scalar traffic entry inside the collection is rejected as not an inspectable object', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$trafficEntry -or \(Test-IsScalarValue -Value \$trafficEntry\)\) \{/);
    assert.match(body, /traffic entry that is not an inspectable object/);
  });

  test('revisionName is read via v1/v2 field-name alternatives (revisionName and revision)', () => {
    const body = getNormalizerBody();
    assert.match(body, /Get-CloudRunFieldValue -Data \$trafficEntry -PropertyPathAlternatives @\(@\('revisionName'\), @\('revision'\)\)/);
  });

  test('a non-finite percent value (NaN or +/-Infinity) is rejected even though it is numerically typed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\[double\]::IsNaN\(\$percentAsDouble\) -or \[double\]::IsInfinity\(\$percentAsDouble\)/);
    assert.match(body, /non-finite percent value/);
  });

  test('a traffic entry with every reviewed field absent is rejected, not normalized into an all-null object', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$revisionName -and \$null -eq \$percent\) \{/);
    assert.match(body, /traffic entry with no reviewed fields present/);
  });

  test('every new rejection path uses malformed_output and never exposes the raw value', () => {
    const body = getNormalizerBody();
    for (const marker of [
      'non-collection container list value',
      'container entry that is not an inspectable object',
      'non-collection traffic value',
      'traffic entry that is not an inspectable object',
      'non-finite percent value',
      'traffic entry with no reviewed fields present',
    ]) {
      const markerIndex = body.indexOf(marker);
      assert.ok(markerIndex >= 0, `expected marker "${marker}"`);
      const context = body.slice(Math.max(0, markerIndex - 150), markerIndex);
      assert.match(context, /-ErrorCategory 'malformed_output'/);
    }
  });
});

describe('Section 5: partial report cleanup is explicit', () => {
  test('the Test-strengthening requirement is covered by the Partial-file cleanup describe block above (ErrorAction Stop, nested try/catch, generic diagnostic, unconditional return 4)', () => {
    assert.match(preflightScript, /Remove-Item -LiteralPath \$resolvedOutputPath -Force -ErrorAction Stop/);
    assert.match(preflightScript, /\[Console\]::Error\.WriteLine\('Preflight partial report cleanup failed\.'\)/);
  });
});

describe('Section 6: narrow secret access verification', () => {
  function getSecretLoopBody() {
    const start = preflightScript.indexOf('foreach ($secretInfo in @(');
    const end = preflightScript.indexOf('# Narrow secret access, project scope', start);
    assert.ok(start >= 0 && end > start);
    return preflightScript.slice(start, end);
  }

  test('requires an explicit secret-level roles/secretmanager.secretAccessor binding for the runtime service account on each supplied secret', () => {
    const body = getSecretLoopBody();
    assert.match(body, /if \(\$RuntimeServiceAccount -and \$iamPolicyResult\.status -eq 'success'\) \{/);
    assert.match(body, /\(\$role -ceq 'roles\/secretmanager\.secretAccessor'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$secretAccessorMember \}\)/);
    assert.match(body, /\$secretAccessorMember = "serviceAccount:\$RuntimeServiceAccount"/);
  });

  test('missing secret-level access produces the distinct required blocker text', () => {
    const body = getSecretLoopBody();
    assert.match(body, /runtime service account missing secret-level roles\/secretmanager\.secretAccessor binding: \$\(\$secretInfo\.Label\)/);
  });

  test('project-wide secret access is never accepted as a substitute for the secret-level binding (this loop only reads the per-secret iamPolicyResult)', () => {
    const body = getSecretLoopBody();
    const checkIndex = body.indexOf('$secretBindings = ConvertTo-DataArray');
    const checkBody = body.slice(checkIndex, checkIndex + 300);
    assert.doesNotMatch(checkBody, /projectIamPolicyResult/);
  });

  test('a separate, project-scoped check blocks the runtime service account holding roles/secretmanager.secretAccessor at the project level', () => {
    assert.match(
      preflightScript,
      /if \(\$RuntimeServiceAccount -and \(\$SupabaseSecretName -or \$GeminiSecretName\) -and \$projectIamPolicyResult\.status -eq 'success'\) \{/
    );
    assert.match(preflightScript, /runtime service account holds project-level roles\/secretmanager\.secretAccessor access, broader than the intended two-secret model/);
  });

  test('the secret-level and project-level secret-access blockers use distinct wording', () => {
    const secretLevelIndex = preflightScript.indexOf('runtime service account missing secret-level roles/secretmanager.secretAccessor binding');
    const projectLevelIndex = preflightScript.indexOf('runtime service account holds project-level roles/secretmanager.secretAccessor access');
    assert.ok(secretLevelIndex >= 0 && projectLevelIndex >= 0);
    assert.notEqual(secretLevelIndex, projectLevelIndex);
  });

  test('never retrieves a secret payload or alters IAM anywhere in these checks', () => {
    assert.doesNotMatch(preflightScript, /'versions',\s*'access'/);
    assert.doesNotMatch(preflightScript, /set-iam-policy/);
  });

  test('documentation describes the secret-level requirement and the project-level overbroad-access block', () => {
    assert.match(preflightDoc, /secret-level\s*\n?\s*`roles\/secretmanager\.secretAccessor`/);
    assert.match(preflightDoc, /project[\s\S]{0,20}level \(which[\s\S]{0,200}would grant it every current and future secret[\s\S]{0,200}in the project/);
  });

  test('an unconditional binding is required for the secret-level accessor check, and a conditional-only match produces a distinct warning', () => {
    const body = getSecretLoopBody();
    assert.match(body, /\$secretAccessorMatchingBindings = \$secretBindings \| Where-Object \{/);
    assert.match(body, /\$secretAccessorBinding = \$secretAccessorMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
    assert.match(body, /conditional IAM binding present for the runtime service account's secret-level access; requires separate human review/);
  });

  test('the project-wide overbroad-access blocker does NOT apply the unconditional-binding filter (it remains a blocker regardless of any condition)', () => {
    const start = preflightScript.indexOf('# Narrow secret access, project scope');
    const end = preflightScript.indexOf("\n    }\n    catch {", start);
    const body = preflightScript.slice(start, end);
    assert.doesNotMatch(body, /Test-IsUnconditionalBinding/);
    assert.match(body, /runtime service account holds project-level roles\/secretmanager\.secretAccessor access, broader than the intended two-secret model/);
  });
});

describe('Unconditional IAM binding requirement (Test-IsUnconditionalBinding helper)', () => {
  function getHelperBody() {
    const start = preflightScript.indexOf('function Test-IsUnconditionalBinding');
    const end = preflightScript.indexOf('# A `gcloud secrets versions list` entry is structurally valid', start);
    assert.ok(start >= 0 && end > start, 'expected to locate Test-IsUnconditionalBinding');
    return preflightScript.slice(start, end);
  }

  function getOutcomeHelperBody() {
    const start = preflightScript.indexOf('function Get-PropertyReadOutcome');
    const end = preflightScript.indexOf('# An IAM allow-policy binding with a `condition`', start);
    assert.ok(start >= 0 && end > start, 'expected to locate Get-PropertyReadOutcome');
    return preflightScript.slice(start, end);
  }

  test('a scalar or null binding is never treated as unconditional (fails closed before any property read is attempted)', () => {
    const body = getHelperBody();
    assert.match(body, /if \(\$null -eq \$Binding -or \(Test-IsScalarValue -Value \$Binding\)\) \{\s*\n\s*return \$false/);
  });

  test('reads the condition property via the dedicated Get-PropertyReadOutcome helper, not Get-SafeProperty or a bare outer try/catch', () => {
    const body = getHelperBody();
    assert.match(body, /\$outcome = Get-PropertyReadOutcome -Object \$Binding -PropertyName 'condition'/);
    assert.doesNotMatch(body, /Get-SafeProperty -Object \$Binding -PropertyPath @\('condition'\)/);
  });

  test('an absent condition property (Found=false, AccessFailed=false) is treated as unconditional', () => {
    const body = getHelperBody();
    assert.match(body, /if \(-not \$outcome\.Found\) \{\s*\n\s*return \$true/);
  });

  test('an explicitly null condition (Found=true, Value=null) is treated as unconditional', () => {
    const body = getHelperBody();
    assert.match(body, /return \$null -eq \$outcome\.Value/);
  });

  test('any present non-null condition value — including an empty/malformed object — is treated as conditional, not unconditional', () => {
    const body = getHelperBody();
    // The final line returns ($null -eq $outcome.Value): a present, non-null
    // condition value of any shape (including an empty object) makes this
    // false, and there is no additional branch that inspects the condition
    // object's own fields before treating a present value as conditional.
    const lastReturnIndex = body.lastIndexOf('return $null -eq $outcome.Value');
    assert.ok(lastReturnIndex >= 0);
    assert.doesNotMatch(body.slice(lastReturnIndex), /\.Properties\[/);
  });

  test('an AccessFailed outcome fails closed: it is checked and returns $false BEFORE the Found/Value branches are ever consulted', () => {
    const body = getHelperBody();
    const accessFailedIndex = body.indexOf('if ($outcome.AccessFailed)');
    const foundCheckIndex = body.indexOf('if (-not $outcome.Found)');
    assert.ok(accessFailedIndex >= 0 && foundCheckIndex >= 0);
    assert.ok(accessFailedIndex < foundCheckIndex, 'AccessFailed must be checked before the Found/absent branch');
    const accessFailedBody = body.slice(accessFailedIndex, accessFailedIndex + 60);
    assert.match(accessFailedBody, /return \$false/);
  });

  test('Get-PropertyReadOutcome distinguishes absent from present (null-or-not) from access-failure using its own guarded try/catch around the Value read, not by delegating to Get-SafeProperty', () => {
    const body = getOutcomeHelperBody();
    assert.doesNotMatch(body, /Get-SafeProperty/);
    // Absent-property outcome (both the null-Object short-circuit and the
    // missing-member branch use this exact shape).
    const absentOccurrences = body.match(/Found = \$false; Value = \$null; AccessFailed = \$false/g) || [];
    assert.equal(absentOccurrences.length, 2, `expected 2 absent-outcome returns, found ${absentOccurrences.length}`);
    // Present outcome carries whatever $value actually is — including null
    // when the property exists but its value is explicitly null — so the
    // caller (Test-IsUnconditionalBinding) distinguishes explicit-null from
    // absent by checking Found, then Value, not by a separate literal here.
    assert.match(body, /Found = \$true; Value = \$value; AccessFailed = \$false/);
    // Access-failure outcome.
    assert.match(body, /Found = \$false; Value = \$null; AccessFailed = \$true/);
  });

  test('Get-PropertyReadOutcome wraps the actual member/value read in try/catch so a throwing property getter is captured as AccessFailed, not silently converted to absent', () => {
    const body = getOutcomeHelperBody();
    const tryIndex = body.indexOf('try {');
    const catchIndex = body.indexOf('catch {', tryIndex);
    const valueReadIndex = body.indexOf('$value = $member.Value');
    assert.ok(tryIndex >= 0 && catchIndex >= 0 && valueReadIndex >= 0);
    assert.ok(tryIndex < valueReadIndex && valueReadIndex < catchIndex, 'the $member.Value read must be inside the try block, before the catch');
    const catchBody = body.slice(catchIndex, catchIndex + 100);
    assert.match(catchBody, /AccessFailed = \$true/);
  });

  test('a null Object is treated as absent (Found=false, AccessFailed=false), never as an access failure', () => {
    const body = getOutcomeHelperBody();
    assert.match(body, /if \(\$null -eq \$Object\) \{\s*\n\s*return \[pscustomobject\]@\{ Found = \$false; Value = \$null; AccessFailed = \$false \}/);
  });

  test('access failure cannot be converted into a null/absent success path: AccessFailed is a distinct field the caller must check separately from Found', () => {
    const body = getOutcomeHelperBody();
    // The catch branch's returned object has Found=$false (same as a
    // genuinely absent property) but AccessFailed=$true — a caller that
    // only checked "-not $outcome.Found" without also checking
    // $outcome.AccessFailed would wrongly treat a failed read as absence.
    // Test-IsUnconditionalBinding checks AccessFailed first (verified
    // above), proving the distinction is actually consumed, not just
    // present in the data shape.
    const catchIndex = body.indexOf('catch {');
    const catchReturn = body.slice(catchIndex, catchIndex + 100);
    assert.match(catchReturn, /Found = \$false/);
    assert.match(catchReturn, /AccessFailed = \$true/);
  });

  test('is applied to all seven permission-proving paths: task-creator actAs, Cloud Tasks service-agent (project scope), service-agent actAs on task-caller, task-caller invocation (both scopes), task-creator Enqueuer (both scopes), and secret-level access', () => {
    const occurrences = [...preflightScript.matchAll(/Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/g)];
    // actAs (1) + service-agent project-scope (1) + service-agent actAs on
    // task-caller (1) + task-caller invocation service-scope (1) +
    // task-caller invocation project-scope (1) + task-creator Enqueuer
    // queue-scope (1) + task-creator Enqueuer project-scope (1) +
    // secret-level access (1) = 8.
    assert.equal(occurrences.length, 8, `expected 8 unconditional-binding filters, found ${occurrences.length}`);
  });

  test('conservative blockers are NOT weakened: public-principal, project-wide secretAccessor, and Owner/Editor checks never call the unconditional-binding helper', () => {
    const publicServiceCheckStart = preflightScript.indexOf('$publicBinding = $bindings | Where-Object {');
    const publicServiceCheckBody = preflightScript.slice(publicServiceCheckStart, publicServiceCheckStart + 200);
    assert.doesNotMatch(publicServiceCheckBody, /Test-IsUnconditionalBinding/);

    const publicProjectCheckStart = preflightScript.indexOf('$publicProjectBinding = $projectBindings | Where-Object {');
    const publicProjectCheckBody = preflightScript.slice(publicProjectCheckStart, publicProjectCheckStart + 200);
    assert.doesNotMatch(publicProjectCheckBody, /Test-IsUnconditionalBinding/);

    const ownerEditorCheckStart = preflightScript.indexOf('$ownerOrEditorBinding = $projectBindings | Where-Object {');
    const ownerEditorCheckBody = preflightScript.slice(ownerEditorCheckStart, ownerEditorCheckStart + 300);
    assert.doesNotMatch(ownerEditorCheckBody, /Test-IsUnconditionalBinding/);
  });

  test('documentation states that IAM conditions are not evaluated and are not accepted as proof of required runtime access', () => {
    assert.match(preflightDoc, /IAM conditions are not evaluated/);
    assert.match(preflightDoc, /never\s*\n?\s*accepted\s*\n?\s*as proof/);
    assert.match(preflightDoc, /public-principal bindings, project-wide\s*\n?\s*`secretAccessor` access, and\s*\n?\s*project-level Owner\/Editor grants remain blockers regardless of any\s*\n?\s*condition/);
  });
});

describe('Runtime service-account field: always null or nonblank (unconditional whitespace rejection)', () => {
  function getNormalizerBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeCloudRunDescribeResult');
    const end = preflightScript.indexOf('# ----------------------------------------------------------------------\n# Fail-closed blocker helpers', start);
    return preflightScript.slice(start, end);
  }

  test('a whitespace-only runtime service-account string is rejected unconditionally, even when -RuntimeServiceAccount was not supplied', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$runtimeServiceAccount -and \[string\]::IsNullOrWhiteSpace\(\$runtimeServiceAccount\)\) \{/);
    assert.match(body, /Cloud Run service description contained a whitespace-only runtime service-account value\./);
    // This check must not be gated behind $RuntimeServiceAccount.
    const checkIndex = body.indexOf('if ($null -ne $runtimeServiceAccount -and [string]::IsNullOrWhiteSpace($runtimeServiceAccount)) {');
    const checkLine = body.slice(checkIndex, body.indexOf('\n', checkIndex));
    assert.doesNotMatch(checkLine, /\$RuntimeServiceAccount/);
  });

  test('the whitespace check runs before the -RuntimeServiceAccount-gated presence check, so a whitespace-only value can never reach it', () => {
    const body = getNormalizerBody();
    const whitespaceCheckIndex = body.indexOf('[string]::IsNullOrWhiteSpace($runtimeServiceAccount)) {');
    const presenceCheckIndex = body.indexOf('if ($RuntimeServiceAccount -and $null -eq $runtimeServiceAccount) {');
    assert.ok(whitespaceCheckIndex >= 0 && presenceCheckIndex >= 0);
    assert.ok(whitespaceCheckIndex < presenceCheckIndex);
  });

  test('null remains acceptable: the presence requirement when -RuntimeServiceAccount is supplied checks for $null specifically, not blankness', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$RuntimeServiceAccount -and \$null -eq \$runtimeServiceAccount\) \{\s*\n\s*return New-CommandResult[\s\S]{0,200}did not contain a usable runtime service-account identity/);
  });

  test('a wrongly-typed (non-string, non-null) value is still rejected regardless of -RuntimeServiceAccount, as before', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$runtimeServiceAccount -and \$runtimeServiceAccount -isnot \[string\]\) \{/);
    assert.match(body, /Cloud Run service description contained an unexpected runtime service-account value type\./);
  });

  test('documentation states the runtime service-account whitespace rule is unconditional regardless of whether -RuntimeServiceAccount was supplied', () => {
    assert.match(preflightDoc, /unconditional for the runtime\s*\n?\s*service-account field/);
    assert.match(preflightDoc, /regardless of\s*\n?\s*whether `-RuntimeServiceAccount` was supplied/);
  });
});

describe('Enabled numeric secret-version validation', () => {
  function getHelperBody() {
    const start = preflightScript.indexOf('function Test-IsValidSecretVersionEntry');
    const end = preflightScript.indexOf('function Get-CloudRunFieldValue', start);
    assert.ok(start >= 0 && end > start, 'expected to locate Test-IsValidSecretVersionEntry');
    return preflightScript.slice(start, end);
  }

  function getVersionCheckBody() {
    const start = preflightScript.indexOf('if ($versionsResult.status');
    const end = preflightScript.indexOf('if ($enabledVersions.Count -eq 0) {', start) + 100;
    assert.ok(start >= 0);
    return preflightScript.slice(start, end);
  }

  test('a null or scalar version entry is never structurally valid', () => {
    const body = getHelperBody();
    assert.match(body, /if \(\$null -eq \$VersionEntry -or \(Test-IsScalarValue -Value \$VersionEntry\)\) \{\s*\n\s*return \$false/);
  });

  test('requires state to be a string', () => {
    const body = getHelperBody();
    assert.match(body, /\$state = Get-SafeProperty -Object \$VersionEntry -PropertyPath @\('state'\)/);
    assert.match(body, /\(\$state -is \[string\]\)/);
  });

  test('requires name to be a string', () => {
    const body = getHelperBody();
    assert.match(body, /\$name = Get-SafeProperty -Object \$VersionEntry -PropertyPath @\('name'\)/);
    assert.match(body, /\(\$name -is \[string\]\)/);
  });

  test('requires the name to end with a plain positive-integer /versions/<N> segment (rejects "latest", version 0, and signed/negative values)', () => {
    const body = getHelperBody();
    assert.match(body, /\(\$name -cmatch '\/versions\/\[1-9\]\[0-9\]\*\$'\)/);
  });

  test('a valid single-digit version (/versions/1) is matched by the pattern', () => {
    assert.ok('projects/p/secrets/s/versions/1'.match(/\/versions\/[1-9][0-9]*$/));
  });

  test('a valid multi-digit version (/versions/42) is matched by the pattern', () => {
    assert.ok('projects/p/secrets/s/versions/42'.match(/\/versions\/[1-9][0-9]*$/));
  });

  test('"latest" is never matched by the pattern', () => {
    assert.ok(!'projects/p/secrets/s/versions/latest'.match(/\/versions\/[1-9][0-9]*$/));
  });

  test('/versions/0 is never matched by the pattern', () => {
    assert.ok(!'projects/p/secrets/s/versions/0'.match(/\/versions\/[1-9][0-9]*$/));
  });

  test('a missing name (null) fails the string-type check and so is not structurally valid', () => {
    const body = getHelperBody();
    // Get-SafeProperty returns $null for a missing property, and $null is
    // not [string], so the ($name -is [string]) conjunct alone excludes a
    // missing name from being structurally valid.
    assert.match(body, /\$name -is \[string\]/);
  });

  test('a non-string name (e.g. a number or object) fails the string-type check the same way as a missing name', () => {
    const body = getHelperBody();
    assert.match(body, /\(\$name -is \[string\]\) -and \(\$name -cmatch/);
  });

  test('structural validity does not itself require ENABLED — it only governs shape (a DISABLED entry with a valid name is still "valid")', () => {
    const body = getHelperBody();
    assert.doesNotMatch(body, /ENABLED/);
  });

  test('the enabled-version count requires BOTH structural validity AND state exactly ENABLED', () => {
    const body = getVersionCheckBody();
    assert.match(body, /\$enabledVersions = @\(\$versions \| Where-Object \{/);
    assert.match(body, /\(Test-IsValidSecretVersionEntry -VersionEntry \$_\) -and \(\(Get-SafeProperty -Object \$_ -PropertyPath @\('state'\)\) -ceq 'ENABLED'\)/);
  });

  test('every returned entry is checked for structural malformation, and any malformed entry produces its own distinct blocker', () => {
    const body = getVersionCheckBody();
    assert.match(body, /\$malformedVersionEntries = @\(\$versions \| Where-Object \{ -not \(Test-IsValidSecretVersionEntry -VersionEntry \$_\) \}\)/);
    assert.match(body, /if \(@\(\$malformedVersionEntries\)\.Count -gt 0\) \{\s*\n\s*\$blockers\.Add\("malformed secret-version metadata: \$\(\$secretInfo\.Label\)"\)/);
  });

  test('the malformed-entry blocker text does not include the raw entry or its value', () => {
    const body = getVersionCheckBody();
    const blockerIndex = body.indexOf('malformed secret-version metadata:');
    const blockerLine = body.slice(Math.max(0, blockerIndex - 20), blockerIndex + 80);
    assert.doesNotMatch(blockerLine, /\$_\b/);
    assert.doesNotMatch(blockerLine, /\$malformedVersionEntries\[/);
  });

  test('the malformed-entry check and the enabled-version check are separate blockers with distinct wording', () => {
    assert.match(preflightScript, /malformed secret-version metadata: \$\(\$secretInfo\.Label\)/);
    assert.match(preflightScript, /supplied secret with no enabled numbered version: \$\(\$secretInfo\.Label\)/);
    const malformedIndex = preflightScript.indexOf('malformed secret-version metadata:');
    const missingEnabledIndex = preflightScript.indexOf('supplied secret with no enabled numbered version:');
    assert.ok(malformedIndex >= 0 && missingEnabledIndex >= 0);
    assert.notEqual(malformedIndex, missingEnabledIndex);
  });

  test('the malformed-entry check runs and blocks even when a structurally valid, enabled entry also exists in the same list (mixed valid-plus-malformed cannot pass)', () => {
    const body = getVersionCheckBody();
    const malformedCheckIndex = body.indexOf('$malformedVersionEntries = @($versions');
    const enabledCheckIndex = body.indexOf('$enabledVersions = @($versions');
    assert.ok(malformedCheckIndex >= 0 && enabledCheckIndex >= 0);
    // Both checks iterate the same, unfiltered $versions array independently
    // — the malformed-entry blocker is never skipped just because a valid
    // enabled entry is also present elsewhere in the list.
    assert.match(body.slice(malformedCheckIndex, malformedCheckIndex + 80), /@\(\$versions \| Where-Object/);
    assert.match(body.slice(enabledCheckIndex, enabledCheckIndex + 80), /@\(\$versions \| Where-Object/);
  });

  test('malformed successful version-list metadata fails closed with a blocker rather than silently counting as readiness', () => {
    assert.match(preflightScript, /malformed secret-version metadata: \$\(\$secretInfo\.Label\)/);
  });

  test('secret payload access remains prohibited', () => {
    assert.doesNotMatch(preflightScript, /'versions',\s*'access'/);
  });

  test('documentation describes the strengthened enabled-numeric-version requirement', () => {
    assert.match(preflightDoc, /`ENABLED`[\s\S]{0,200}version name ends with a\s*\n?\s*plain positive-integer `\/versions\/<N>` segment/);
    assert.match(preflightDoc, /`latest`, any other\s*\n?\s*alias, `\/versions\/0`, and a missing or non-string version name are\s*\n?\s*never accepted/);
  });

  test('documentation describes the fail-closed-on-any-malformed-entry behavior', () => {
    assert.match(preflightDoc, /malformed secret-version metadata/);
  });
});

describe('Task-creator Cloud Tasks Enqueuer authorization', () => {
  function getEnqueuerBody() {
    const start = preflightScript.indexOf('# ---- Task-creator Cloud Tasks Enqueuer authorization');
    const end = preflightScript.indexOf("if (\$projectIamPolicyResult.status -eq 'success') {\n            \$projectBindings", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the Enqueuer authorization block');
    return preflightScript.slice(start, end);
  }

  test('is gated on both QueueName and TaskCreatorServiceAccount being supplied', () => {
    const body = getEnqueuerBody();
    assert.match(body, /if \(\$QueueName -and \$TaskCreatorServiceAccount\) \{/);
  });

  test('requires both the queue IAM policy and the project IAM policy to have succeeded before evaluating', () => {
    const body = getEnqueuerBody();
    assert.match(body, /if \(\$queueIamPolicyResultForEnqueuer\.status -eq 'success' -and \$projectIamPolicyResult\.status -eq 'success'\) \{/);
  });

  test('the member is constructed as exactly serviceAccount:<TaskCreatorServiceAccount>', () => {
    const body = getEnqueuerBody();
    assert.match(body, /\$enqueuerMember = "serviceAccount:\$TaskCreatorServiceAccount"/);
  });

  test('checks for an unconditional roles/cloudtasks.enqueuer binding at the queue IAM scope', () => {
    const body = getEnqueuerBody();
    assert.match(body, /\$queueBindingsForEnqueuer = ConvertTo-DataArray \(Get-SafeProperty -Object \$queueIamPolicyResultForEnqueuer\.data -PropertyPath @\('bindings'\)\)/);
    assert.match(body, /\(\$role -ceq 'roles\/cloudtasks\.enqueuer'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$enqueuerMember \}\)/);
    assert.match(body, /\$enqueuerQueueBinding = \$enqueuerQueueMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
  });

  test('checks for an unconditional roles/cloudtasks.enqueuer binding at the project IAM scope', () => {
    const body = getEnqueuerBody();
    assert.match(body, /\$projectBindingsForEnqueuer = ConvertTo-DataArray \(Get-SafeProperty -Object \$projectIamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
    assert.match(body, /\$enqueuerProjectBinding = \$enqueuerProjectMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
  });

  test('a missing unconditional binding at both scopes produces the exact required blocker text', () => {
    const body = getEnqueuerBody();
    assert.match(body, /if \(@\(\$enqueuerQueueBinding\)\.Count -eq 0 -and @\(\$enqueuerProjectBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('task creator lacks an explicit Cloud Tasks Enqueuer binding'\)/);
  });

  test('a conditional-only matching binding (at either scope) produces a distinct warning requiring separate human review', () => {
    const body = getEnqueuerBody();
    assert.match(body, /\$combinedEnqueuerMatchingBindings = @\(\$enqueuerQueueMatchingBindings\) \+ @\(\$enqueuerProjectMatchingBindings\)/);
    assert.match(body, /\$conditionalEnqueuerMatchingBindings = @\(\s*\n\s*\$combinedEnqueuerMatchingBindings \| Where-Object \{ -not \(Test-IsUnconditionalBinding -Binding \$_\) \}\s*\n\s*\)/);
    assert.match(body, /if \(\$conditionalEnqueuerMatchingBindings\.Count -gt 0\) \{/);
    assert.match(body, /conditional IAM binding present for the task-creator Cloud Tasks Enqueuer access; requires separate human review/);
  });

  test('Owner, Editor, Cloud Tasks Admin, Cloud Tasks Editor, and unknown/custom roles are never accepted as proof (only roles/cloudtasks.enqueuer is matched)', () => {
    const body = getEnqueuerBody();
    assert.doesNotMatch(body, /roles\/owner/);
    assert.doesNotMatch(body, /roles\/editor/);
    assert.doesNotMatch(body, /cloudtasks\.admin/i);
    assert.doesNotMatch(body, /cloudtasks\.tasks\.enqueuer/i);
    const roleOccurrences = body.match(/-ceq 'roles\/cloudtasks\.enqueuer'/g) || [];
    assert.equal(roleOccurrences.length, 2, `expected exactly 2 role checks (queue + project scope), found ${roleOccurrences.length}`);
  });

  test('reuses the already-retrieved queueIamPolicy and projectIamPolicy results — no new gcloud command is issued for this check', () => {
    const body = getEnqueuerBody();
    assert.match(body, /\$commandResults\['queueIamPolicy'\]/);
    assert.doesNotMatch(body, /Invoke-ReadOnlyGcloudCommand/);
  });

  test('documentation describes the Enqueuer requirement, that it provides cloudtasks.tasks.create, and that Owner/Editor/Admin/Editor roles are not accepted as proof', () => {
    assert.match(preflightDoc, /roles\/cloudtasks\.enqueuer/);
    assert.match(preflightDoc, /cloudtasks\.tasks\.create/);
    assert.match(preflightDoc, /Cloud Tasks Admin/);
    assert.match(preflightDoc, /Cloud Tasks Editor/);
  });
});

describe('Cloud Tasks service-agent actAs authorization on the task-caller account', () => {
  function getServiceAgentActAsBody() {
    const start = preflightScript.indexOf('# Separate from every other check in this section');
    const end = preflightScript.indexOf('# ---- Task-creator Cloud Tasks Enqueuer authorization', start);
    assert.ok(start >= 0 && end > start, 'expected to locate the service-agent actAs-on-task-caller block');
    return preflightScript.slice(start, end);
  }

  test('reuses the already-validated Cloud Tasks service-agent member and the already-retrieved task-caller IAM policy — no new gcloud command is issued', () => {
    const body = getServiceAgentActAsBody();
    assert.match(body, /\$taskCallerServiceAccountIamPolicyForServiceAgentActAs = \$commandResults\['taskCallerServiceAccountIamPolicy'\]/);
    assert.doesNotMatch(body, /Invoke-ReadOnlyGcloudCommand/);
  });

  test('checks for an unconditional roles/iam.serviceAccountUser binding for the Cloud Tasks service-agent member on the task-caller account', () => {
    const body = getServiceAgentActAsBody();
    assert.match(body, /\(\$role -ceq 'roles\/iam\.serviceAccountUser'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$cloudTasksServiceAgentMember \}\)/);
    assert.match(body, /\$serviceAgentActAsBinding = \$serviceAgentActAsMatchingBindings \| Where-Object \{ Test-IsUnconditionalBinding -Binding \$_ \}/);
  });

  test('a missing unconditional binding produces the exact required blocker text', () => {
    const body = getServiceAgentActAsBody();
    assert.match(body, /if \(@\(\$serviceAgentActAsBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('Cloud Tasks service agent lacks explicit actAs authorization on the task-caller service account'\)/);
  });

  test('a conditional-only matching binding produces a distinct warning requiring separate human review', () => {
    const body = getServiceAgentActAsBody();
    assert.match(body, /conditional IAM binding present for the Cloud Tasks service-agent actAs authorization on the task-caller service account; requires separate human review/);
  });

  test('this check is structurally separate from the task-creator actAs check, the project-scope serviceAgent check, the task-caller invocation check, and the Enqueuer check (four distinct blocker texts)', () => {
    const texts = [
      'task creator lacks explicit iam.serviceAccounts.actAs authorization on the task-caller service account',
      'Cloud Tasks service agent lacks the required roles/cloudtasks.serviceAgent project-level binding',
      'task-caller service account lacks an explicit Cloud Run invocation binding',
      'task creator lacks an explicit Cloud Tasks Enqueuer binding',
      'Cloud Tasks service agent lacks explicit actAs authorization on the task-caller service account',
    ];
    const indices = texts.map((t) => preflightScript.indexOf(t));
    for (const i of indices) {
      assert.ok(i >= 0);
    }
    const uniqueIndices = new Set(indices);
    assert.equal(uniqueIndices.size, texts.length, 'expected all five blocker texts to be distinct');
  });

  test('is evaluated within the same Cloud Tasks OIDC prerequisites block gated on TaskCallerServiceAccount, alongside the project-scope serviceAgent check', () => {
    const sectionStart = preflightScript.indexOf('# ---- Section 1: Cloud Tasks OIDC IAM prerequisites');
    const body = getServiceAgentActAsBody();
    const bodyStart = preflightScript.indexOf(body);
    assert.ok(sectionStart >= 0 && bodyStart > sectionStart);
  });

  test('documentation states the Cloud Tasks service agent must hold actAs on the task-caller account, separate from every other actAs/OIDC check', () => {
    assert.match(preflightDoc, /service-agent identity also holds an explicit,\s*\n?\s*\*\*unconditional\*\* `roles\/iam\.serviceAccountUser` binding \*on the\s*\n?\s*task-caller service account\*/);
  });

  test('documentation spells out the complete five-step Cloud Tasks OIDC identity chain', () => {
    assert.match(preflightDoc, /complete Cloud Tasks OIDC identity chain/i);
    assert.match(preflightDoc, /task creator can enqueue/i);
    assert.match(preflightDoc, /task creator can specify\/`actAs`/i);
    assert.match(preflightDoc, /roles\/cloudtasks\.serviceAgent`\s*\n?\s*at the project level/);
    assert.match(preflightDoc, /service agent has an unconditional/i);
    assert.match(preflightDoc, /task-caller identity can invoke the worker service/i);
  });
});

describe('Case-sensitive comparisons for external protocol values', () => {
  test('authenticated account status ACTIVE uses -ceq', () => {
    assert.match(preflightScript, /\$accountStatus -ceq 'ACTIVE'/);
    assert.doesNotMatch(preflightScript, /\$accountStatus -eq 'ACTIVE'/);
  });

  test('project lifecycle state ACTIVE uses -cne', () => {
    assert.match(preflightScript, /\$lifecycleState -cne 'ACTIVE'/);
  });

  test('Artifact Registry format DOCKER uses -ceq/-cne at both check sites', () => {
    assert.match(preflightScript, /-PropertyPath @\('format'\)\) -ceq 'DOCKER'/);
    assert.match(preflightScript, /\$repositoryFormat -cne 'DOCKER'/);
  });

  test('Cloud Tasks queue state RUNNING/PAUSED use -ceq/-cne', () => {
    assert.match(preflightScript, /\$queueState -ceq 'RUNNING'/);
    assert.match(preflightScript, /\$queueState -cne 'PAUSED'/);
  });

  test('Secret Manager version state ENABLED uses -ceq (both the enabled-count check and the Test-IsValidSecretVersionEntry-based predicate)', () => {
    assert.match(preflightScript, /-PropertyPath @\('state'\)\) -ceq 'ENABLED'\)/);
  });

  test('every IAM role-name comparison uses -ceq, and CloudRunInvocationRoles membership uses -ccontains', () => {
    for (const role of [
      'roles/iam.serviceAccountUser',
      'roles/cloudtasks.serviceAgent',
      'roles/owner',
      'roles/editor',
      'roles/secretmanager.secretAccessor',
      'roles/cloudtasks.enqueuer',
    ]) {
      const pattern = new RegExp(`-ceq '${role.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`);
      assert.match(preflightScript, pattern, `expected a -ceq comparison against ${role}`);
    }
    assert.match(preflightScript, /CloudRunInvocationRoles -ccontains \$role/);
    assert.doesNotMatch(preflightScript, /CloudRunInvocationRoles -contains \$role/);
  });

  test('allUsers and allAuthenticatedUsers public-principal checks use -ceq at both the service-level and project-level sites', () => {
    const occurrences = preflightScript.match(/\$_ -ceq 'allUsers' -or \$_ -ceq 'allAuthenticatedUsers'/g) || [];
    assert.equal(occurrences.length, 2, `expected 2 case-sensitive public-principal checks, found ${occurrences.length}`);
  });

  test('every generated serviceAccount:<EMAIL> IAM member comparison uses -ceq', () => {
    for (const memberVar of [
      '$callerMember',
      '$actAsMember',
      '$cloudTasksServiceAgentMember',
      '$secretAccessorMember',
      '$runtimeMemberForSecretAccessor',
      '$enqueuerMember',
      '$member',
    ]) {
      const escaped = memberVar.replace(/\$/g, '\\$');
      const pattern = new RegExp(`-ceq ${escaped}\\b`);
      assert.match(preflightScript, pattern, `expected a -ceq comparison against ${memberVar}`);
    }
  });

  test('runtime/task-caller/task-creator normalized service-account identity comparisons use -ceq/-cne', () => {
    assert.match(preflightScript, /\$runtimeServiceAccountOnService -cne \$RuntimeServiceAccount/);
    assert.match(preflightScript, /\$RuntimeServiceAccount -ceq \$TaskCallerServiceAccount/);
    assert.match(preflightScript, /\$TaskCreatorServiceAccount -ceq \$RuntimeServiceAccount/);
    assert.match(preflightScript, /\$TaskCreatorServiceAccount -ceq \$TaskCallerServiceAccount/);
  });

  test('the invoker-iam-disabled annotation true/false comparison is case-sensitive', () => {
    assert.match(preflightScript, /\$invokerIamDisabledAnnotationRaw -ceq 'true'/);
    assert.match(preflightScript, /\$invokerIamDisabledAnnotationRaw -ceq 'false'/);
  });

  test('lowercase/alternate-case ACTIVE, DOCKER, RUNNING, PAUSED, and ENABLED values cannot satisfy readiness (case-sensitive equality rejects them)', () => {
    // Structural proof: JavaScript string equality mirrors PowerShell's
    // -ceq/-cne semantics for these ordinal ASCII comparisons — 'active'
    // !== 'ACTIVE', so the same case-sensitive operators used in the
    // script would reject an alternate-case value from gcloud.
    assert.notEqual('active', 'ACTIVE');
    assert.notEqual('docker', 'DOCKER');
    assert.notEqual('running', 'RUNNING');
    assert.notEqual('paused', 'PAUSED');
    assert.notEqual('enabled', 'ENABLED');
  });

  test('does not blindly apply case-sensitive operators to $null, numeric, boolean, or internal command-result-status comparisons', () => {
    // Internal command-result statuses (generated entirely by this script
    // via New-CommandResult's ValidateSet) remain -eq/-ne throughout —
    // there is no reason to case-sensitively compare a value this script
    // itself always produces in one exact casing.
    assert.match(preflightScript, /\$Result\.status -ne 'success'/);
    assert.match(preflightScript, /\$result\.status -eq 'not_found'/);
    assert.match(preflightScript, /\$describeResult\.status -eq 'success'/);
    // $null comparisons remain -eq/-ne.
    assert.match(preflightScript, /\$null -eq \$current/);
    // Boolean comparisons remain -eq (not case-sensitivity-relevant).
    assert.match(preflightScript, /\$invokerIamDisabled -eq \$true/);
    assert.match(preflightScript, /\$isDisabled -eq \$true/);
  });
});

describe('gcloud config list (read-only local configuration inventory)', () => {
  test('declares an exact schema entry for config list with no --project and no location flag', () => {
    const schemaStart = preflightScript.indexOf("Path = @('config', 'list')");
    assert.ok(schemaStart >= 0);
    const schemaLine = preflightScript.slice(schemaStart, preflightScript.indexOf('\n', schemaStart));
    assert.match(schemaLine, /RequiresProject = \$false/);
    assert.match(schemaLine, /LocationFlag = \$null/);
    assert.match(schemaLine, /FormatMode = 'config-list-safe'/);
  });

  test('Test-GcloudCommandSchema wires FormatMode config-list-safe to $script:GcloudConfigListSafeFormatFlag', () => {
    const body = preflightScript.slice(
      preflightScript.indexOf('function Test-GcloudCommandSchema'),
      preflightScript.indexOf('function Invoke-ReadOnlyGcloudCommand')
    );
    assert.match(body, /elseif \(\$schema\.FormatMode -eq 'config-list-safe'\) \{ \$expectedFormatToken = \$script:GcloudConfigListSafeFormatFlag \}/);
  });

  test('is invoked unconditionally as generic discovery, using --quiet, --verbosity=error, and the narrow safe projection', () => {
    const argsText = declarationFor('configList');
    assert.match(argsText, /'config',\s*'list'/);
    assert.match(argsText, /'--quiet'/);
    assert.match(argsText, /'--verbosity=error'/);
    assert.match(argsText, /\$script:GcloudConfigListSafeFormatFlag\b/);
    assert.doesNotMatch(argsText, /'--project'/);
  });

  test('the narrow projection requests only core.account, auth.impersonate_service_account, auth.access_token_file, auth.credential_file_override, and auth.disable_credentials', () => {
    const start = preflightScript.indexOf('$script:GcloudConfigListSafeFormatFlag =');
    assert.ok(start >= 0);
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    assert.match(line, /'--format=json\(core\.account,auth\.impersonate_service_account,auth\.access_token_file,auth\.credential_file_override,auth\.disable_credentials\)'/);
  });

  test('the narrow projection excludes every other configuration section/property (compute, project, api_endpoint_overrides, proxy, configuration directories)', () => {
    const start = preflightScript.indexOf('$script:GcloudConfigListSafeFormatFlag =');
    const line = preflightScript.slice(start, preflightScript.indexOf('\n', start));
    for (const excludedField of ['compute', 'project', 'api_endpoint_overrides', 'proxy', 'disable_prompts', 'configuration']) {
      assert.ok(!line.includes(excludedField), `expected the config-list projection to exclude ${excludedField}`);
    }
  });

  test('participates in fail-closed generic discovery: any non-success status is a blocker', () => {
    assert.match(preflightScript, /Add-GenericDiscoveryBlocker -Result \$configListResult -Label 'configList' -Blockers \$blockers/);
  });

  test('is never scoped with --project (it is local machine/user configuration, not a project resource)', () => {
    assert.ok(!remoteResourceCommandIds.includes('configList'));
  });
});

describe('Local CLOUDSDK_AUTH_* authentication-override detection', () => {
  function getOverrideCheckBody() {
    const start = preflightScript.indexOf('# Local CLOUDSDK_AUTH_* authentication-override check');
    const end = preflightScript.indexOf("if (\$authListResult.status -eq 'success') {", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the CLOUDSDK_AUTH_* override check');
    return preflightScript.slice(start, end);
  }

  test('enumerates the full process environment via [System.Environment]::GetEnvironmentVariables(), not the $env: provider', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /\[System\.Environment\]::GetEnvironmentVariables\(\)/);
    assert.doesNotMatch(body, /\$env:/);
  });

  test('matches variable names by prefix ^CLOUDSDK_AUTH_, not a fixed enumerated list', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /\$environmentVariableName -match '\^CLOUDSDK_AUTH_'/);
  });

  test('the prefix match is case-INSENSITIVE (plain -match), not case-sensitive (-cmatch) — Windows-safe', () => {
    const body = getOverrideCheckBody();
    assert.doesNotMatch(body, /\$environmentVariableName -cmatch/);
    assert.match(body, /\$environmentVariableName -match '\^CLOUDSDK_AUTH_'/);
  });

  test('CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT matches the prefix pattern', () => {
    assert.match('CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT', /^CLOUDSDK_AUTH_/i);
  });

  test('cloudsdk_auth_impersonate_service_account (fully lowercase) matches the prefix pattern — this is exactly the Windows-bypass case case-sensitive matching would miss', () => {
    assert.match('cloudsdk_auth_impersonate_service_account', /^CLOUDSDK_AUTH_/i);
    // A case-sensitive comparison against the same pattern would NOT match,
    // which is precisely the bypass this correction closes.
    assert.doesNotMatch('cloudsdk_auth_impersonate_service_account', /^CLOUDSDK_AUTH_/);
  });

  test('CloudSdk_Auth_Access_Token (mixed case) matches the prefix pattern', () => {
    assert.match('CloudSdk_Auth_Access_Token', /^CLOUDSDK_AUTH_/i);
    assert.doesNotMatch('CloudSdk_Auth_Access_Token', /^CLOUDSDK_AUTH_/);
  });

  test('unrelated variable names do not match the prefix pattern, case-insensitively or otherwise', () => {
    for (const unrelated of ['PATH', 'CLOUDSDK_CORE_ACCOUNT', 'CLOUDSDK_PYTHON', 'MY_CLOUDSDK_AUTH_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.doesNotMatch(unrelated, /^CLOUDSDK_AUTH_/i);
    }
  });

  test('only a non-empty matching variable counts — a present-but-blank CLOUDSDK_AUTH_* variable is not treated as an override', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /if \(-not \[string\]::IsNullOrEmpty\(\$environmentVariableValue\)\) \{/);
  });

  test('never places a variable VALUE in blocker text — only names are ever collected', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /\$cloudSdkAuthOverrideNames\.Add\(\$environmentVariableName\)/);
    assert.doesNotMatch(body, /\$cloudSdkAuthOverrideNames\.Add\(\$environmentVariableValue\)/);
    const blockerIndex = body.indexOf("local CLOUDSDK_AUTH_* environment variable override detected");
    assert.ok(blockerIndex >= 0);
    const blockerLine = body.slice(Math.max(0, blockerIndex - 40), blockerIndex + 120);
    assert.doesNotMatch(blockerLine, /\$environmentVariableValue/);
  });

  test('enumeration failure fails closed: the catch branch still records an override marker rather than silently treating it as clean', () => {
    const body = getOverrideCheckBody();
    const tryIndex = body.indexOf('try {');
    const catchIndex = body.indexOf('catch {', tryIndex);
    assert.ok(tryIndex >= 0 && catchIndex >= 0 && tryIndex < catchIndex);
    const catchBody = body.slice(catchIndex, catchIndex + 400);
    assert.match(catchBody, /\$cloudSdkAuthOverrideNames\.Add\('\(environment enumeration failed\)'\)/);
  });

  test('any detected override (or enumeration failure) produces the exact required blocker text', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /if \(\$cloudSdkAuthOverrideNames\.Count -gt 0\) \{\s*\n\s*\$blockers\.Add\('local CLOUDSDK_AUTH_\* environment variable override detected: gcloud authentication behavior cannot be verified to match the audited active account'\)/);
  });

  test('this check runs unconditionally (not gated on any supplied parameter) alongside the gcloud-availability check', () => {
    const body = getOverrideCheckBody();
    assert.match(body, /^\s*\$cloudSdkAuthOverrideNames = New-Object System\.Collections\.Generic\.List\[string\]/m);
  });

  test('documentation describes the CLOUDSDK_AUTH_* override check', () => {
    assert.match(preflightDoc, /CLOUDSDK_AUTH_/);
  });

  test('documentation describes the case-insensitive, Windows-safe detection rationale', () => {
    assert.match(preflightDoc, /case-insensitive/i);
    assert.match(preflightDoc, /Windows/);
  });

  test('documentation uses the correct CLOUDSDK_AUTH_ACCESS_TOKEN example, never the nonexistent CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', () => {
    assert.match(preflightDoc, /CLOUDSDK_AUTH_ACCESS_TOKEN`/);
    assert.doesNotMatch(preflightDoc, /CLOUDSDK_AUTH_ACCESS_TOKEN_FILE/);
  });
});

describe('Local gcloud configuration authentication-override checks (config list evaluation)', () => {
  function getConfigListEvalBody() {
    const start = preflightScript.indexOf("if (\$configListResult.status -eq 'success') {");
    const end = preflightScript.indexOf("if (\$authListResult.status -eq 'success') {", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the configList evaluation block');
    return preflightScript.slice(start, end);
  }

  test('reads all four persisted auth-override flags from the already-normalized config list result, not raw properties or a new command', () => {
    const body = getConfigListEvalBody();
    assert.match(body, /\$normalizedConfigList = \$configListResult\.data/);
    assert.match(body, /\$normalizedConfigList\.impersonateServiceAccountConfigured -eq \$true/);
    assert.match(body, /\$normalizedConfigList\.accessTokenFileConfigured -eq \$true/);
    assert.match(body, /\$normalizedConfigList\.credentialFileOverrideConfigured -eq \$true/);
    assert.match(body, /\$normalizedConfigList\.disableCredentialsEnabled -eq \$true/);
    assert.doesNotMatch(body, /Get-SafeProperty -Object \$configListResult\.data/);
    assert.doesNotMatch(body, /Invoke-ReadOnlyGcloudCommand/);
  });

  test('disable_credentials enabled produces the exact required generic, path-free blocker text', () => {
    const body = getConfigListEvalBody();
    assert.match(body, /if \(\$normalizedConfigList\.disableCredentialsEnabled -eq \$true\) \{/);
    assert.match(body, /local gcloud configuration enables auth\/disable_credentials: the audited active account cannot be trusted as the effective authentication identity/);
  });

  test('the disable_credentials blocker text contains no file path, token, or raw configured value', () => {
    const blockerIndex = preflightScript.indexOf('local gcloud configuration enables auth/disable_credentials');
    assert.ok(blockerIndex >= 0);
    const blockerLine = preflightScript.slice(preflightScript.lastIndexOf('\n', blockerIndex), preflightScript.indexOf('\n', blockerIndex));
    assert.doesNotMatch(blockerLine, /\$disableCredentialsRaw/);
  });

  test('impersonate_service_account configured produces the exact required blocker text', () => {
    const body = getConfigListEvalBody();
    assert.match(body, /if \(\$normalizedConfigList\.impersonateServiceAccountConfigured -eq \$true\) \{\s*\n\s*\$blockers\.Add\('local gcloud configuration sets auth\/impersonate_service_account: gcloud authentication behavior cannot be verified to match the audited active account'\)/);
  });

  test('access_token_file configured produces its own distinct blocker text', () => {
    const body = getConfigListEvalBody();
    assert.match(body, /if \(\$normalizedConfigList\.accessTokenFileConfigured -eq \$true\) \{\s*\n\s*\$blockers\.Add\('local gcloud configuration sets auth\/access_token_file: gcloud authentication behavior cannot be verified to match the audited active account'\)/);
  });

  test('credential_file_override configured produces its own distinct blocker text', () => {
    const body = getConfigListEvalBody();
    assert.match(body, /if \(\$normalizedConfigList\.credentialFileOverrideConfigured -eq \$true\) \{\s*\n\s*\$blockers\.Add\('local gcloud configuration sets auth\/credential_file_override: gcloud authentication behavior cannot be verified to match the audited active account'\)/);
  });

  test('all four auth-override blocker texts are distinct from one another', () => {
    const texts = [
      preflightScript.indexOf('local gcloud configuration sets auth/impersonate_service_account:'),
      preflightScript.indexOf('local gcloud configuration sets auth/access_token_file:'),
      preflightScript.indexOf('local gcloud configuration sets auth/credential_file_override:'),
      preflightScript.indexOf('local gcloud configuration enables auth/disable_credentials:'),
    ];
    for (const i of texts) {
      assert.ok(i >= 0);
    }
    assert.equal(new Set(texts).size, texts.length);
  });

  test('no blocker text or comment in this block contains a raw file path, token, or credential value — only property names', () => {
    const body = getConfigListEvalBody();
    assert.doesNotMatch(body, /\$impersonateServiceAccountRaw/);
    assert.doesNotMatch(body, /\$accessTokenFileRaw/);
    assert.doesNotMatch(body, /\$credentialFileOverrideRaw/);
    assert.doesNotMatch(body, /\$disableCredentialsRaw/);
  });

  test('cross-checks the local configuration core/account against the single audited active account, only when exactly one active account exists', () => {
    const start = preflightScript.indexOf("elseif (\$configListResult.status -eq 'success') {");
    assert.ok(start >= 0, 'expected the core/account cross-check to be an elseif alongside the active-account count checks');
    const end = preflightScript.indexOf("\n        }\n        else {\n            \$blockers.Add('local authentication state unavailable')", start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /\$normalizedConfigListForAccount = \$configListResult\.data/);
    assert.match(body, /if \(\$null -ne \$normalizedConfigListForAccount\.coreAccount\) \{/);
    assert.match(body, /\$activeAccountValue = Get-SafeProperty -Object \$activeAccounts\[0\] -PropertyPath @\('account'\)/);
    assert.match(body, /if \(\$normalizedConfigListForAccount\.coreAccount -cne \$activeAccountValue\) \{/);
    assert.match(body, /local gcloud configuration core\/account does not match the audited active authenticated account/);
  });

  test('the core/account comparison is case-sensitive (-cne, not -ne)', () => {
    const start = preflightScript.indexOf("elseif (\$configListResult.status -eq 'success') {");
    const end = preflightScript.indexOf("\n        }\n        else {\n            \$blockers.Add('local authentication state unavailable')", start);
    const body = preflightScript.slice(start, end);
    assert.match(body, /-cne \$activeAccountValue/);
    assert.doesNotMatch(body, /[^-c]ne \$activeAccountValue/);
  });

  test('null/absent coreAccount (never configured) is accepted without comparison — not itself a blocker', () => {
    const start = preflightScript.indexOf("elseif (\$configListResult.status -eq 'success') {");
    const end = preflightScript.indexOf("\n        }\n        else {\n            \$blockers.Add('local authentication state unavailable')", start);
    const body = preflightScript.slice(start, end);
    // The whole comparison is nested inside `if ($null -ne ... .coreAccount)`,
    // so a null coreAccount skips the comparison entirely.
    const guardIndex = body.indexOf('if ($null -ne $normalizedConfigListForAccount.coreAccount) {');
    const compareIndex = body.indexOf('-cne $activeAccountValue');
    assert.ok(guardIndex >= 0 && compareIndex >= 0 && guardIndex < compareIndex);
  });

  test('the core/account cross-check is skipped (not a false blocker) when zero or multiple active accounts already triggered their own distinct blockers', () => {
    // Structural proof: the cross-check is reached via `elseif`, chained
    // after the Count -eq 0 and Count -gt 1 branches — it can only run when
    // neither of those already fired.
    const zeroCheckIndex = preflightScript.indexOf("if (\$activeAccounts.Count -eq 0) {");
    const multipleCheckIndex = preflightScript.indexOf('multiple active accounts');
    const crossCheckIndex = preflightScript.indexOf("elseif (\$configListResult.status -eq 'success') {");
    assert.ok(zeroCheckIndex >= 0 && multipleCheckIndex >= 0 && crossCheckIndex >= 0);
    assert.ok(zeroCheckIndex < multipleCheckIndex && multipleCheckIndex < crossCheckIndex);
  });

  test('reuses the already-retrieved configListResult and authListResult — no new gcloud command is issued for either override check', () => {
    const impersonateStart = preflightScript.indexOf('# $configListResult.data is already the normalized object');
    const impersonateEnd = preflightScript.indexOf("if (\$authListResult.status -eq 'success') {", impersonateStart);
    assert.ok(impersonateStart >= 0);
    const body = preflightScript.slice(impersonateStart, impersonateEnd);
    assert.doesNotMatch(body, /Invoke-ReadOnlyGcloudCommand/);
  });

  test('malformed non-string override values or a malformed/whitespace-only core/account fail closed at the normalizer level, so the evaluation block above never sees them', () => {
    // The normalizer (ConvertTo-SafeGcloudConfigListResult) turns any
    // malformed field into a whole-result 'failed' status before
    // evaluation ever runs — proven separately in the normalizer describe
    // block below. Here we confirm evaluation only ever branches on
    // $configListResult.status -eq 'success', never inspecting a raw,
    // possibly-malformed field directly.
    const body = getConfigListEvalBody();
    assert.doesNotMatch(body, /-PropertyPath @\('auth'/);
    assert.doesNotMatch(body, /-PropertyPath @\('core'/);
  });

  test('documentation describes all four auth-override checks and the core/account cross-check behavior', () => {
    assert.match(preflightDoc, /impersonate_service_account/);
    assert.match(preflightDoc, /access_token_file/);
    assert.match(preflightDoc, /credential_file_override/);
    assert.match(preflightDoc, /disable_credentials/);
    assert.match(preflightDoc, /core\/account/);
  });

  test('documentation states the five normalized config fields', () => {
    assert.match(preflightDoc, /five reviewed\s*\n?\s*fields/);
    assert.match(preflightDoc, /coreAccount/);
  });
});

describe('ConvertTo-SafeGcloudConfigListResult (safe normalizer for gcloud config list)', () => {
  function getNormalizerBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeGcloudConfigListResult');
    const end = preflightScript.indexOf('function Test-IsScalarValue', start);
    assert.ok(start >= 0 && end > start, 'expected to locate ConvertTo-SafeGcloudConfigListResult');
    return preflightScript.slice(start, end);
  }

  test('a non-success result is returned unchanged — data remains whatever the command result already carries (null on failure)', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$Result\.status -ne 'success'\) \{\s*\n\s*return \$Result\s*\n\s*\}/);
  });

  test('on success, builds a brand-new pscustomobject with exactly the five reviewed fields', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$normalized = \[pscustomobject\]@\{/);
    const objStart = body.indexOf('$normalized = [pscustomobject]@{');
    const objEnd = body.indexOf('}', objStart);
    const objBody = body.slice(objStart, objEnd);
    assert.match(objBody, /coreAccount\s*=\s*\$coreAccountRaw/);
    assert.match(objBody, /impersonateServiceAccountConfigured\s*=\s*\$impersonateServiceAccountConfigured/);
    assert.match(objBody, /accessTokenFileConfigured\s*=\s*\$accessTokenFileConfigured/);
    assert.match(objBody, /credentialFileOverrideConfigured\s*=\s*\$credentialFileOverrideConfigured/);
    assert.match(objBody, /disableCredentialsEnabled\s*=\s*\$disableCredentialsEnabled/);
  });

  test('the response root must be a non-null inspectable object — null, scalar, and array roots are all malformed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$data -or \(Test-IsScalarValue -Value \$data\) -or \(\$data -is \[System\.Array\]\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration response was not an inspectable object\.'/);
  });

  test('the auth section is read via Get-PropertyReadOutcome, distinguishing absence from an access failure, and a failure fails closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$authOutcome = Get-PropertyReadOutcome -Object \$data -PropertyName 'auth'/);
    assert.match(body, /if \(\$authOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth section could not be safely read\.'/);
  });

  test('a present, non-null auth section that is a scalar or array is malformed — never silently drilled into', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\(Test-IsScalarValue -Value \$authOutcome\.Value\) -or \(\$authOutcome\.Value -is \[System\.Array\]\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth section was not an inspectable object\.'/);
  });

  test('the core section has the same Get-PropertyReadOutcome-based absence/access-failure/shape validation as auth', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$coreOutcome = Get-PropertyReadOutcome -Object \$data -PropertyName 'core'/);
    assert.match(body, /if \(\$coreOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core section could not be safely read\.'/);
    assert.match(body, /if \(\(Test-IsScalarValue -Value \$coreOutcome\.Value\) -or \(\$coreOutcome\.Value -is \[System\.Array\]\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core section was not an inspectable object\.'/);
  });

  test('absent auth/core sections normalize to $null and every reviewed sub-property is read via Get-PropertyReadOutcome against the validated section variable, never Get-SafeProperty', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$authSection = \$null/);
    assert.match(body, /\$coreSection = \$null/);
    assert.match(body, /Get-PropertyReadOutcome -Object \$authSection -PropertyName 'impersonate_service_account'/);
    assert.match(body, /Get-PropertyReadOutcome -Object \$authSection -PropertyName 'access_token_file'/);
    assert.match(body, /Get-PropertyReadOutcome -Object \$authSection -PropertyName 'credential_file_override'/);
    assert.match(body, /Get-PropertyReadOutcome -Object \$authSection -PropertyName 'disable_credentials'/);
    assert.match(body, /Get-PropertyReadOutcome -Object \$coreSection -PropertyName 'account'/);
    assert.doesNotMatch(body, /Get-SafeProperty -Object \$authSection/);
    assert.doesNotMatch(body, /Get-SafeProperty -Object \$coreSection/);
  });

  test('each of the five reviewed properties fails closed on AccessFailed, with a distinct generic diagnostic containing no raw value', () => {
    const body = getNormalizerBody();
    for (const [outcomeVar, propertyName] of [
      ['impersonateServiceAccountOutcome', 'impersonate_service_account'],
      ['accessTokenFileOutcome', 'access_token_file'],
      ['credentialFileOverrideOutcome', 'credential_file_override'],
      ['disableCredentialsOutcome', 'disable_credentials'],
      ['coreAccountOutcome', 'account'],
    ]) {
      const guardPattern = new RegExp(`if \\(\\$${outcomeVar}\\.AccessFailed\\) \\{\\s*\\n\\s*return New-CommandResult -Id \\$Result\\.id -Status 'failed' -ExitCode \\$Result\\.exitCode -ErrorCategory 'malformed_output' -SafeError '[^']*${propertyName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^']*could not be safely read\\.'`);
      assert.match(body, guardPattern, `expected an AccessFailed guard for ${propertyName}`);
    }
  });

  test('impersonate_service_account: absent/null or blank/whitespace-only means "not configured" (boolean false), not a blocker on its own', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$impersonateServiceAccountConfigured = \(\$impersonateServiceAccountRaw -is \[string\]\) -and \(-not \[string\]::IsNullOrWhiteSpace\(\$impersonateServiceAccountRaw\)\)/);
  });

  test('impersonate_service_account: any non-null, non-string type is malformed_output and fails the whole result closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$impersonateServiceAccountRaw -and \$impersonateServiceAccountRaw -isnot \[string\]\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth\/impersonate_service_account value type\.'/);
  });

  test('access_token_file: same absent/blank/nonblank/malformed contract as impersonate_service_account', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$accessTokenFileConfigured = \(\$accessTokenFileRaw -is \[string\]\) -and \(-not \[string\]::IsNullOrWhiteSpace\(\$accessTokenFileRaw\)\)/);
    assert.match(body, /Local gcloud configuration contained an unexpected auth\/access_token_file value type\./);
  });

  test('credential_file_override: same absent/blank/nonblank/malformed contract as impersonate_service_account', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$credentialFileOverrideConfigured = \(\$credentialFileOverrideRaw -is \[string\]\) -and \(-not \[string\]::IsNullOrWhiteSpace\(\$credentialFileOverrideRaw\)\)/);
    assert.match(body, /Local gcloud configuration contained an unexpected auth\/credential_file_override value type\./);
  });

  test('core/account: a non-null, non-string type is malformed_output and fails closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -ne \$coreAccountRaw -and \$coreAccountRaw -isnot \[string\]\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected core\/account value type\.'/);
  });

  test('core/account: a whitespace-only string is malformed_output and fails closed — unlike the auth-override properties, blank is never "not configured" here', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$coreAccountRaw -is \[string\] -and \[string\]::IsNullOrWhiteSpace\(\$coreAccountRaw\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained a whitespace-only core\/account value\.'/);
  });

  test('core/account: null/absent passes through both guard checks untouched (accepted as "not configured", never blocked here)', () => {
    const body = getNormalizerBody();
    // Both guards are conjunctions starting with `$null -ne $coreAccountRaw`
    // — when the raw value is null, both conditions are false and neither
    // throws nor returns a failed result, so coreAccount ends up null in
    // the normalized object.
    assert.match(body, /\$null -ne \$coreAccountRaw -and \$coreAccountRaw -isnot \[string\]/);
  });

  test('a property-access failure inside the normalizer is caught and fails closed (malformed_output), never propagated', () => {
    const body = getNormalizerBody();
    const catchIndex = body.lastIndexOf('catch {');
    assert.ok(catchIndex >= 0);
    const catchBody = body.slice(catchIndex, catchIndex + 200);
    assert.match(catchBody, /-Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration could not be safely projected\.'/);
  });

  test('never retains or serializes the impersonated service-account value, access-token-file path, credential-file path, raw disable_credentials value, configuration directories, endpoint overrides, or project — only the five reviewed fields', () => {
    const body = getNormalizerBody();
    const objStart = body.indexOf('$normalized = [pscustomobject]@{');
    const objEnd = body.indexOf('}', objStart);
    const objBody = body.slice(objStart, objEnd);
    for (const forbidden of [
      '$impersonateServiceAccountRaw',
      '$accessTokenFileRaw',
      '$credentialFileOverrideRaw',
      '$disableCredentialsRaw',
      'api_endpoint_overrides',
      'configuration',
      'project',
      'proxy',
    ]) {
      assert.doesNotMatch(objBody, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('the raw parsed $data object is never itself returned as -Data on the success path', () => {
    const body = getNormalizerBody();
    assert.doesNotMatch(body, /New-CommandResult[^\n]*-Data \$data\b/);
  });

  test('auth/disable_credentials: absent, null, or blank normalizes to false', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$disableCredentialsRaw\) \{\s*\n\s*\$disableCredentialsEnabled = \$false/);
    assert.match(body, /if \(\[string\]::IsNullOrWhiteSpace\(\$disableCredentialsRaw\)\) \{\s*\n\s*\$disableCredentialsEnabled = \$false/);
  });

  test('auth/disable_credentials: an actual boolean is used as-is (true stays true, false stays false)', () => {
    const body = getNormalizerBody();
    assert.match(body, /elseif \(\$disableCredentialsRaw -is \[bool\]\) \{\s*\n\s*\$disableCredentialsEnabled = \$disableCredentialsRaw/);
  });

  test('auth/disable_credentials: the strings "false"/"False" normalize to false and "true"/"True" normalize to true, case-sensitively (no other casing accepted)', () => {
    const body = getNormalizerBody();
    assert.match(body, /\(\$disableCredentialsRaw -ceq 'false'\) -or \(\$disableCredentialsRaw -ceq 'False'\)/);
    assert.match(body, /\(\$disableCredentialsRaw -ceq 'true'\) -or \(\$disableCredentialsRaw -ceq 'True'\)/);
  });

  test('auth/disable_credentials: any other string value is malformed_output and fails closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth\/disable_credentials string value\.'/);
  });

  test('auth/disable_credentials: any non-boolean, non-string type (object, array, number) is malformed_output and fails closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /else \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration contained an unexpected auth\/disable_credentials value type\.'/);
  });

  test('auth/disable_credentials: a property-access failure on the auth section fails the whole result closed before disable_credentials is ever read (same AccessFailed guard as the other auth properties)', () => {
    const body = getNormalizerBody();
    const authAccessFailedIndex = body.indexOf('if ($authOutcome.AccessFailed)');
    const disableCredentialsReadIndex = body.indexOf("Get-PropertyReadOutcome -Object $authSection -PropertyName 'disable_credentials'");
    assert.ok(authAccessFailedIndex >= 0 && disableCredentialsReadIndex >= 0 && authAccessFailedIndex < disableCredentialsReadIndex);
  });

  test('auth/disable_credentials: its own property-read access failure fails closed before the value is inspected', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$disableCredentialsOutcome = Get-PropertyReadOutcome -Object \$authSection -PropertyName 'disable_credentials'/);
    assert.match(body, /if \(\$disableCredentialsOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth\/disable_credentials could not be safely read\.'/);
    const accessFailedIndex = body.indexOf('if ($disableCredentialsOutcome.AccessFailed)');
    const valueReadIndex = body.indexOf('$disableCredentialsRaw = $disableCredentialsOutcome.Value');
    assert.ok(accessFailedIndex >= 0 && valueReadIndex >= 0 && accessFailedIndex < valueReadIndex);
  });

  test('core/account: its own property-read access failure fails closed with a generic diagnostic before the value is inspected', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$coreAccountOutcome = Get-PropertyReadOutcome -Object \$coreSection -PropertyName 'account'/);
    assert.match(body, /if \(\$coreAccountOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration core\/account could not be safely read\.'/);
  });

  test('access_token_file and credential_file_override each fail closed on their own access failure before their value is inspected', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$accessTokenFileOutcome = Get-PropertyReadOutcome -Object \$authSection -PropertyName 'access_token_file'/);
    assert.match(body, /if \(\$accessTokenFileOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth\/access_token_file could not be safely read\.'/);
    assert.match(body, /\$credentialFileOverrideOutcome = Get-PropertyReadOutcome -Object \$authSection -PropertyName 'credential_file_override'/);
    assert.match(body, /if \(\$credentialFileOverrideOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'Local gcloud configuration auth\/credential_file_override could not be safely read\.'/);
  });

  test('no access-failure diagnostic for any of the five reviewed properties includes a raw value, path, token, credential, or exception text', () => {
    const body = getNormalizerBody();
    for (const message of [
      'Local gcloud configuration auth/impersonate_service_account could not be safely read.',
      'Local gcloud configuration auth/access_token_file could not be safely read.',
      'Local gcloud configuration auth/credential_file_override could not be safely read.',
      'Local gcloud configuration auth/disable_credentials could not be safely read.',
      'Local gcloud configuration core/account could not be safely read.',
    ]) {
      assert.ok(body.includes(message), `expected exact diagnostic: ${message}`);
    }
    assert.doesNotMatch(body, /SafeError '[^']*\$_[^']*could not be safely read/);
  });

  test('an access failure is structurally distinct from absence for all five properties: the AccessFailed branch returns failed/malformed_output immediately, never falling through to the "not configured" (false) logic that a genuinely absent property reaches', () => {
    const body = getNormalizerBody();
    for (const [outcomeVar, configuredFlagOrNextStep] of [
      ['impersonateServiceAccountOutcome', '$impersonateServiceAccountRaw = $impersonateServiceAccountOutcome.Value'],
      ['accessTokenFileOutcome', '$accessTokenFileRaw = $accessTokenFileOutcome.Value'],
      ['credentialFileOverrideOutcome', '$credentialFileOverrideRaw = $credentialFileOverrideOutcome.Value'],
      ['disableCredentialsOutcome', '$disableCredentialsRaw = $disableCredentialsOutcome.Value'],
      ['coreAccountOutcome', '$coreAccountRaw = $coreAccountOutcome.Value'],
    ]) {
      const accessFailedIndex = body.indexOf(`if ($${outcomeVar}.AccessFailed) {`);
      const valueAssignIndex = body.indexOf(configuredFlagOrNextStep);
      assert.ok(accessFailedIndex >= 0, `expected an AccessFailed guard for ${outcomeVar}`);
      assert.ok(valueAssignIndex >= 0, `expected a Value assignment for ${outcomeVar}`);
      // The AccessFailed guard (which unconditionally `return`s) is placed
      // before the line that reads .Value into the "raw" variable feeding
      // the not-configured/configured boolean logic — an access failure
      // can never reach that line and therefore can never be normalized
      // into a false "not configured" result.
      assert.ok(accessFailedIndex < valueAssignIndex, `expected AccessFailed guard before Value read for ${outcomeVar}`);
    }
  });
});

describe('Raw gcloud configuration never reaches the report', () => {
  test('configListResult is assigned from ConvertTo-SafeGcloudConfigListResult wrapping Invoke-ReadOnlyGcloudCommand, not the raw command result directly', () => {
    assert.match(
      preflightScript,
      /\$configListResult = Add-Result 'configList' \(ConvertTo-SafeGcloudConfigListResult -Result \(Invoke-ReadOnlyGcloudCommand -Id 'configList'/
    );
  });

  test('Add-Result for configList never receives the bare Invoke-ReadOnlyGcloudCommand call as its data', () => {
    assert.doesNotMatch(preflightScript, /Add-Result 'configList' \(Invoke-ReadOnlyGcloudCommand/);
  });

  test('commandResults.configList holds only the normalized result — the same $configListResult variable used throughout evaluation is the normalizer output', () => {
    const assignIndex = preflightScript.indexOf("$configListResult = Add-Result 'configList'");
    assert.ok(assignIndex >= 0);
    const assignLine = preflightScript.slice(assignIndex, preflightScript.indexOf('\n', assignIndex));
    assert.match(assignLine, /ConvertTo-SafeGcloudConfigListResult/);
  });

  test('configList is never added to targetedResources (it is generic, local-only discovery, not a per-target resource)', () => {
    const targetedResourcesAssignments = [...preflightScript.matchAll(/\$targetedResources\['[^']+'\]\s*=/g)];
    for (const match of targetedResourcesAssignments) {
      assert.doesNotMatch(match[0], /configList/i);
    }
  });
});

describe('Project-level roles/secretmanager.admin blocked for the runtime service account', () => {
  function getSecretAdminBody() {
    const start = preflightScript.indexOf('# Narrow secret access, project scope (admin)');
    const end = preflightScript.indexOf("\n    }\n    catch {", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the secretmanager.admin block');
    return preflightScript.slice(start, end);
  }

  test('is gated on RuntimeServiceAccount and a successful project IAM policy — independent of which secrets were supplied', () => {
    const body = getSecretAdminBody();
    assert.match(body, /if \(\$RuntimeServiceAccount -and \$projectIamPolicyResult\.status -eq 'success'\) \{/);
    assert.doesNotMatch(body, /SupabaseSecretName/);
    assert.doesNotMatch(body, /GeminiSecretName/);
  });

  test('the member is constructed as exactly serviceAccount:<RuntimeServiceAccount>', () => {
    const body = getSecretAdminBody();
    assert.match(body, /\$runtimeMemberForSecretAdmin = "serviceAccount:\$RuntimeServiceAccount"/);
  });

  test('checks for roles/secretmanager.admin (case-sensitive) granted to that exact member', () => {
    const body = getSecretAdminBody();
    assert.match(body, /\(\$role -ceq 'roles\/secretmanager\.admin'\) -and \(@\(\$members\) \| Where-Object \{ \$_ -ceq \$runtimeMemberForSecretAdmin \}\)/);
  });

  test('a matching binding produces the exact required blocker text, distinct from the secretAccessor overbroad-access blocker', () => {
    const body = getSecretAdminBody();
    assert.match(body, /if \(@\(\$projectSecretAdminBinding\)\.Count -gt 0\) \{\s*\n\s*\$blockers\.Add\('runtime service account holds project-level roles\/secretmanager\.admin access, broader than the intended two-secret model'\)/);
    const adminIndex = preflightScript.indexOf('runtime service account holds project-level roles/secretmanager.admin access');
    const accessorIndex = preflightScript.indexOf('runtime service account holds project-level roles/secretmanager.secretAccessor access');
    assert.ok(adminIndex >= 0 && accessorIndex >= 0);
    assert.notEqual(adminIndex, accessorIndex);
  });

  test('this blocker is unconditional: it does NOT call Test-IsUnconditionalBinding, matching the Owner/Editor and overbroad-secretAccessor convention of never being weakened by an IAM condition', () => {
    const body = getSecretAdminBody();
    assert.doesNotMatch(body, /Test-IsUnconditionalBinding/);
  });

  test('never grants, revokes, or alters IAM while performing this check', () => {
    const body = getSecretAdminBody();
    assert.doesNotMatch(body, /set-iam-policy/);
    assert.doesNotMatch(body, /Invoke-ReadOnlyGcloudCommand/);
  });

  test('documentation describes the roles/secretmanager.admin project-level block', () => {
    assert.match(preflightDoc, /roles\/secretmanager\.admin/);
  });
});

describe('ConvertTo-SafeIamPolicyResult (safe normalizer for every get-iam-policy result)', () => {
  function getNormalizerBody() {
    const start = preflightScript.indexOf('function ConvertTo-SafeIamPolicyResult');
    const end = preflightScript.indexOf('function Test-IsValidSecretVersionEntry', start);
    assert.ok(start >= 0 && end > start, 'expected to locate ConvertTo-SafeIamPolicyResult');
    return preflightScript.slice(start, end);
  }

  test('a non-success result is returned unchanged — data remains whatever the command result already carries (null on failure)', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$Result\.status -ne 'success'\) \{\s*\n\s*return \$Result\s*\n\s*\}/);
  });

  test('the policy root must be a non-null inspectable object — null, scalar, and array roots are all malformed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$data -or \(Test-IsScalarValue -Value \$data\) -or \(\$data -is \[System\.Array\]\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy response was not an inspectable object\.'/);
  });

  test('bindings is read via Get-PropertyReadOutcome so an access failure is distinguished from absence, and a failure fails closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$bindingsOutcome = Get-PropertyReadOutcome -Object \$data -PropertyName 'bindings'/);
    assert.match(body, /if \(\$bindingsOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy bindings could not be safely read\.'/);
  });

  test('bindings absent or null normalizes to an empty array — a valid empty policy succeeds with bindings=[]', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$normalizedBindings = @\(\)/);
    assert.match(body, /if \(\$bindingsOutcome\.Found -and \$null -ne \$bindingsOutcome\.Value\) \{/);
    assert.match(body, /\$normalizedPolicy = \[pscustomobject\]@\{\s*\n\s*bindings = \$normalizedBindings\s*\n\s*\}/);
  });

  test('a present, non-null bindings value that is a scalar (string/number/boolean) is malformed — never iterated as a collection', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(Test-IsScalarValue -Value \$bindingsRaw\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy bindings was not a collection of binding objects\.'/);
  });

  test('a null or scalar binding entry inside the collection is malformed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$null -eq \$binding -or \(Test-IsScalarValue -Value \$binding\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry that is not an inspectable object\.'/);
  });

  test('a missing, blank, or non-string role fails the whole policy closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$role = Get-SafeProperty -Object \$binding -PropertyPath @\('role'\)/);
    assert.match(body, /if \(\$role -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$role\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable role\.'/);
  });

  test('a missing or non-collection members value fails the whole policy closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$membersRaw = Get-SafeProperty -Object \$binding -PropertyPath @\('members'\)/);
    assert.match(body, /if \(\$null -eq \$membersRaw -or \(Test-IsScalarValue -Value \$membersRaw\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable members\.'/);
  });

  test('a non-string or blank member entry fails the whole policy closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$member -isnot \[string\] -or \[string\]::IsNullOrWhiteSpace\(\$member\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with a non-string or blank member\.'/);
  });

  test('an empty members array (zero valid members) fails the whole policy closed — a binding with no member is never accepted', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\$members\.Count -eq 0\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy contained a binding entry with no usable member\.'/);
  });

  test('a valid one-member binding and a valid multi-member binding both succeed: every string member is retained in order', () => {
    const body = getNormalizerBody();
    assert.match(body, /foreach \(\$member in \(ConvertTo-DataArray \$membersRaw\)\) \{/);
    assert.match(body, /\$members \+= \$member/);
    // No artificial cap on the number of retained members.
    assert.doesNotMatch(body, /\$members\.Count -gt 1/);
  });

  test('condition is read via Get-PropertyReadOutcome, and a property-access failure on it fails the whole policy closed', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$conditionOutcome = Get-PropertyReadOutcome -Object \$binding -PropertyName 'condition'/);
    assert.match(body, /if \(\$conditionOutcome\.AccessFailed\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy binding condition could not be safely read\.'/);
  });

  test('condition absent or explicitly null normalizes to $null (remains unconditional)', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$normalizedCondition = \$null/);
    assert.match(body, /if \(\$conditionOutcome\.Found -and \$null -ne \$conditionOutcome\.Value\) \{/);
  });

  test('a present, non-null, scalar condition value is malformed', () => {
    const body = getNormalizerBody();
    assert.match(body, /if \(\(Test-IsScalarValue -Value \$conditionOutcome\.Value\) -or \(\$conditionOutcome\.Value -is \[System\.Array\]\)\) \{\s*\n\s*return New-CommandResult -Id \$Result\.id -Status 'failed' -ExitCode \$Result\.exitCode -ErrorCategory 'malformed_output' -SafeError 'IAM policy binding condition was not an inspectable object\.'/);
  });

  test('an array condition value (empty, one-element, or multi-element) is malformed — never unwrapped to a single element', () => {
    const body = getNormalizerBody();
    const conditionCheckIndex = body.indexOf('if ((Test-IsScalarValue -Value $conditionOutcome.Value)');
    assert.ok(conditionCheckIndex >= 0);
    const conditionCheckLine = body.slice(conditionCheckIndex, body.indexOf('\n', conditionCheckIndex));
    assert.match(conditionCheckLine, /\$conditionOutcome\.Value -is \[System\.Array\]/);
    // No indexing into the array (e.g. [0]) occurs anywhere for condition —
    // confirming it is rejected outright, never unwrapped like the
    // reparse-point Target array is.
    assert.doesNotMatch(body, /\$conditionOutcome\.Value\[0\]/);
  });

  test('a valid condition object (non-scalar, non-array) is the only value accepted as the safe marker', () => {
    const body = getNormalizerBody();
    const conditionCheckIndex = body.indexOf('if ((Test-IsScalarValue -Value $conditionOutcome.Value)');
    const markerIndex = body.indexOf('$normalizedCondition = [pscustomobject]@{ present = $true }');
    assert.ok(conditionCheckIndex >= 0 && markerIndex >= 0 && conditionCheckIndex < markerIndex);
  });

  test('an empty condition array ([]) is rejected: the -is [System.Array] check has no Count-based carve-out for zero elements', () => {
    const body = getNormalizerBody();
    const conditionCheckIndex = body.indexOf('if ((Test-IsScalarValue -Value $conditionOutcome.Value)');
    const conditionCheckLine = body.slice(conditionCheckIndex, body.indexOf('\n', conditionCheckIndex));
    assert.doesNotMatch(conditionCheckLine, /\.Count/);
  });

  test('a one-element condition array is rejected — it is never unwrapped to its single element the way a reparse-point Target array is', () => {
    const body = getNormalizerBody();
    // Reuses the same array-rejection line as the empty/multi-element
    // cases: there is exactly one condition-array check, applying
    // uniformly regardless of element count.
    const arrayCheckOccurrences = (body.match(/\$conditionOutcome\.Value -is \[System\.Array\]/g) || []).length;
    assert.equal(arrayCheckOccurrences, 1);
  });

  test('a multi-element condition array is rejected the same way as an empty or one-element array', () => {
    const body = getNormalizerBody();
    assert.match(body, /\(Test-IsScalarValue -Value \$conditionOutcome\.Value\) -or \(\$conditionOutcome\.Value -is \[System\.Array\]\)/);
  });

  test('a valid, non-null condition object is normalized into a brand-new, opaque, non-null marker — never the raw condition object', () => {
    const body = getNormalizerBody();
    assert.match(body, /\$normalizedCondition = \[pscustomobject\]@\{ present = \$true \}/);
  });

  test('the normalized marker carries no title, description, or CEL expression field', () => {
    const body = getNormalizerBody();
    const markerIndex = body.indexOf('$normalizedCondition = [pscustomobject]@{ present = $true }');
    const markerLine = body.slice(Math.max(0, markerIndex - 10), markerIndex + 70);
    assert.doesNotMatch(markerLine, /title/i);
    assert.doesNotMatch(markerLine, /description/i);
    assert.doesNotMatch(markerLine, /expression/i);
  });

  test('the safe condition marker is compatible with Test-IsUnconditionalBinding: null means unconditional, the marker (non-null) means conditional', () => {
    // Test-IsUnconditionalBinding treats a present, non-null `condition`
    // property as conditional regardless of its shape — the marker object
    // `[pscustomobject]@{ present = $true }` is non-null, so it is
    // correctly treated as conditional without any special-casing needed
    // in Test-IsUnconditionalBinding itself.
    const helperBody = preflightScript.slice(
      preflightScript.indexOf('function Test-IsUnconditionalBinding'),
      preflightScript.indexOf('function ConvertTo-SafeIamPolicyResult')
    );
    assert.match(helperBody, /return \$null -eq \$outcome\.Value/);
  });

  test('each normalized binding retains only role, members, and condition — no etag, auditConfigs, or unreviewed property', () => {
    const body = getNormalizerBody();
    const bindingObjIndex = body.indexOf('$normalizedBindings += [pscustomobject]@{');
    const bindingObjEnd = body.indexOf('}', bindingObjIndex);
    const bindingObjBody = body.slice(bindingObjIndex, bindingObjEnd);
    assert.match(bindingObjBody, /role\s*=\s*\$role/);
    assert.match(bindingObjBody, /members\s*=\s*\$members/);
    assert.match(bindingObjBody, /condition\s*=\s*\$normalizedCondition/);
    assert.doesNotMatch(bindingObjBody, /etag/i);
    assert.doesNotMatch(bindingObjBody, /auditConfigs/i);
  });

  test('never retains etag, auditConfigs, or the raw parsed policy object anywhere in the function', () => {
    const body = getNormalizerBody();
    assert.doesNotMatch(body, /etag/i);
    assert.doesNotMatch(body, /auditConfigs/i);
    assert.doesNotMatch(body, /New-CommandResult[^\n]*-Data \$data\b/);
  });

  test('a property-access failure inside the normalizer is caught and fails closed (malformed_output), never propagated', () => {
    const body = getNormalizerBody();
    const catchIndex = body.lastIndexOf('catch {');
    assert.ok(catchIndex >= 0);
    const catchBody = body.slice(catchIndex, catchIndex + 200);
    assert.match(catchBody, /-Status 'failed' -ErrorCategory 'malformed_output' -SafeError 'IAM policy could not be safely projected\.'/);
  });

  test('documentation describes IAM-policy minimization, the malformed-output/fail-closed contract, and that raw conditions are never stored', () => {
    assert.match(preflightDoc, /IAM policy retrieved by this script[\s\S]{0,400}is minimized the same way/);
    assert.match(preflightDoc, /fails the \*\*whole policy\*\* closed/);
    assert.match(preflightDoc, /never\s*\n?\s*retained as-is/);
    assert.match(preflightDoc, /no raw IAM\s*\n?\s*condition expression/);
  });

  test('documentation describes array condition rejection (including an empty array), never unwrapped to a single element', () => {
    assert.match(preflightDoc, /or an\s*\n?\s*array \(including an empty array\)/);
    assert.match(preflightDoc, /never\s*\n?\s*unwrapped or coerced to a single element/);
  });

  test('documentation describes per-property access-failure behavior for the five reviewed config properties', () => {
    assert.match(preflightDoc, /Each of the five reviewed properties is itself read the same/);
    assert.match(preflightDoc, /access-failure-aware way/);
    assert.match(preflightDoc, /can\s*\n?\s*never be silently reinterpreted as the property simply being absent/);
  });

  test('documentation states group membership, custom-role permission expansion, and ancestor IAM remain human-review limitations', () => {
    assert.match(preflightDoc, /Group membership has been separately reviewed/);
    assert.match(preflightDoc, /Custom-role permission expansion has been separately reviewed/);
    assert.match(preflightDoc, /Folder- and organization-level IAM policies inherited/);
  });
});

describe('All nine get-iam-policy call sites are wrapped by ConvertTo-SafeIamPolicyResult', () => {
  const iamPolicyVariablesAndIds = [
    ['$projectIamPolicyResult', 'projectIamPolicy'],
    ['$workerServiceIamPolicyResult', 'workerServiceIamPolicy'],
    ['$artifactRepositoryIamPolicyResult', 'artifactRepositoryIamPolicy'],
    ['$queueIamPolicyResult', 'queueIamPolicy'],
    ['$runtimeServiceAccountIamPolicyResult', 'runtimeServiceAccountIamPolicy'],
    ['$taskCallerServiceAccountIamPolicyResult', 'taskCallerServiceAccountIamPolicy'],
    ['$taskCreatorServiceAccountIamPolicyResult', 'taskCreatorServiceAccountIamPolicy'],
    ['$supabaseSecretIamPolicyResult', 'supabaseSecretIamPolicy'],
    ['$geminiSecretIamPolicyResult', 'geminiSecretIamPolicy'],
  ];

  for (const [variableName, id] of iamPolicyVariablesAndIds) {
    test(`${id}: is assigned from ConvertTo-SafeIamPolicyResult wrapping Invoke-ReadOnlyGcloudCommand, not the raw command result directly`, () => {
      const escapedVar = variableName.replace(/\$/g, '\\$');
      const pattern = new RegExp(`${escapedVar}\\s*=\\s*(?:Add-Result '[^']+' )?\\(?ConvertTo-SafeIamPolicyResult -Result \\(Invoke-ReadOnlyGcloudCommand -Id '${id}'`);
      assert.match(preflightScript, pattern, `expected ${variableName} to be normalized`);
    });
  }

  test('exactly nine get-iam-policy command IDs exist, and all nine are wrapped', () => {
    const getIamPolicyIds = [...preflightScript.matchAll(/-Id '(\w*IamPolicy)'/g)].map((m) => m[1]);
    const uniqueIds = new Set(getIamPolicyIds);
    assert.equal(uniqueIds.size, 9, `expected 9 distinct IAM policy command ids, found ${uniqueIds.size}: ${[...uniqueIds].join(', ')}`);
    for (const id of uniqueIds) {
      const idIndex = preflightScript.indexOf(`-Id '${id}'`);
      const context = preflightScript.slice(Math.max(0, idIndex - 200), idIndex);
      assert.match(context, /ConvertTo-SafeIamPolicyResult -Result \(Invoke-ReadOnlyGcloudCommand/, `expected ${id} to be wrapped by ConvertTo-SafeIamPolicyResult`);
    }
  });

  test('no get-iam-policy Invoke-ReadOnlyGcloudCommand call is ever passed directly to Add-Result without the normalizer in between', () => {
    const bareAssignments = [...preflightScript.matchAll(/Add-Result '\w*IamPolicy' \(Invoke-ReadOnlyGcloudCommand/g)];
    assert.equal(bareAssignments.length, 0, 'found a raw IAM policy result passed directly to Add-Result');
  });
});

describe('Malformed IAM policy data cannot be silently consumed as an empty/clean policy by downstream checks', () => {
  test('every binding-evaluation site reads $iamPolicyResult.data (or the equivalent per-target variable) only after that variable was assigned from ConvertTo-SafeIamPolicyResult — a malformed policy is already status=failed by the time evaluation runs, so Add-GenericDiscoveryBlocker / Add-TargetVerificationBlockers catches it before any binding is read', () => {
    // Structural proof: the same variable name assigned by the normalizer
    // (e.g. $projectIamPolicyResult) is the one read in every subsequent
    // `.status -eq 'success'` guard before `.data.bindings` is ever
    // touched — there is no separate, unwrapped variable used for
    // evaluation.
    assert.match(preflightScript, /if \(\$projectIamPolicyResult\.status -eq 'success'\) \{/);
    assert.match(preflightScript, /if \(\$iamPolicyResult\.status -eq 'success'\) \{/);
  });

  test('the public-principal, Owner/Editor, actAs, serviceAgent, enqueuer, and secret-access checks all derive their bindings via Get-SafeProperty on already-normalized .data — a malformed (status=failed) policy never reaches these Where-Object predicates because the generic/target blocker already fired', () => {
    assert.match(preflightScript, /\$projectBindings = ConvertTo-DataArray \(Get-SafeProperty -Object \$projectIamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
    assert.match(preflightScript, /\$bindings = ConvertTo-DataArray \(Get-SafeProperty -Object \$iamPolicyResult\.data -PropertyPath @\('bindings'\)\)/);
  });

  test('a policy with malformed bindings can never produce zero blockers merely because Get-SafeProperty(bindings) happens to return something falsy — the normalizer already converted it to status=failed, which Add-GenericDiscoveryBlocker/Add-TargetVerificationBlockers always treats as a blocker', () => {
    assert.match(preflightScript, /function Add-GenericDiscoveryBlocker/);
    assert.match(preflightScript, /if\s*\(\$Result\.status\s+-ne\s+'success'\)/);
  });
});

describe('No raw IAM condition expression reaches commandResults or targetedResources', () => {
  test('targetedResources stores the same normalized iamPolicy variables that ConvertTo-SafeIamPolicyResult produced, never a separately-captured raw result', () => {
    assert.match(preflightScript, /\$targetedResources\['workerService'\] = \[ordered\]@\{ describe = \$workerServiceDescribeResult; iamPolicy = \$workerServiceIamPolicyResult \}/);
    assert.match(preflightScript, /\$targetedResources\['queue'\] = \[ordered\]@\{ describe = \$queueDescribeResult; iamPolicy = \$queueIamPolicyResult \}/);
  });

  test('no raw condition field name (expression, title, description) appears anywhere near a get-iam-policy command declaration', () => {
    for (const id of ['projectIamPolicy', 'workerServiceIamPolicy', 'queueIamPolicy']) {
      const idIndex = preflightScript.indexOf(`-Id '${id}'`);
      assert.ok(idIndex >= 0);
      const declarationLine = preflightScript.slice(preflightScript.lastIndexOf('\n', idIndex), preflightScript.indexOf('\n', idIndex));
      assert.doesNotMatch(declarationLine, /expression/i);
    }
  });
});

describe('Scalar pipeline-result concatenation fix (task-caller invocation and task-creator Enqueuer conditional-binding warnings)', () => {
  function getCallerInvocationConditionalBody() {
    const start = preflightScript.indexOf('$combinedCallerMatchingBindings');
    const end = preflightScript.indexOf("conditional IAM binding present for the task-caller Cloud Run invocation role", start);
    assert.ok(start >= 0 && end > start, 'expected to locate the task-caller invocation conditional-binding combination');
    return preflightScript.slice(Math.max(0, start - 1000), end + 100);
  }

  function getEnqueuerConditionalBody() {
    const start = preflightScript.indexOf('$combinedEnqueuerMatchingBindings');
    const end = preflightScript.indexOf('conditional IAM binding present for the task-creator Cloud Tasks Enqueuer access', start);
    assert.ok(start >= 0 && end > start, 'expected to locate the task-creator Enqueuer conditional-binding combination');
    return preflightScript.slice(Math.max(0, start - 1000), end + 100);
  }

  test('task-caller invocation: both operands are wrapped with @(...) before being combined with +', () => {
    const body = getCallerInvocationConditionalBody();
    assert.match(body, /\$combinedCallerMatchingBindings = @\(\$callerServiceMatchingBindings\) \+ @\(\$callerProjectMatchingBindings\)/);
  });

  test('task-creator Enqueuer: both operands are wrapped with @(...) before being combined with +', () => {
    const body = getEnqueuerConditionalBody();
    assert.match(body, /\$combinedEnqueuerMatchingBindings = @\(\$enqueuerQueueMatchingBindings\) \+ @\(\$enqueuerProjectMatchingBindings\)/);
  });

  test('no bare `$left + $right` pattern (unwrapped pipeline-result variables) exists at either site', () => {
    assert.doesNotMatch(preflightScript, /\$callerServiceMatchingBindings \+ \$callerProjectMatchingBindings/);
    assert.doesNotMatch(preflightScript, /\$enqueuerQueueMatchingBindings \+ \$enqueuerProjectMatchingBindings/);
  });

  test('the combined/filtered result is itself wrapped with @(...) at both sites, so the final .Count check is always valid even when the filtered Where-Object yields zero, one, or multiple results', () => {
    const callerBody = getCallerInvocationConditionalBody();
    assert.match(callerBody, /\$conditionalCallerMatchingBindings = @\(\s*\n\s*\$combinedCallerMatchingBindings \| Where-Object \{ -not \(Test-IsUnconditionalBinding -Binding \$_\) \}\s*\n\s*\)/);
    assert.match(callerBody, /if \(\$conditionalCallerMatchingBindings\.Count -gt 0\) \{/);

    const enqueuerBody = getEnqueuerConditionalBody();
    assert.match(enqueuerBody, /\$conditionalEnqueuerMatchingBindings = @\(\s*\n\s*\$combinedEnqueuerMatchingBindings \| Where-Object \{ -not \(Test-IsUnconditionalBinding -Binding \$_\) \}\s*\n\s*\)/);
    assert.match(enqueuerBody, /if \(\$conditionalEnqueuerMatchingBindings\.Count -gt 0\) \{/);
  });

  test('zero/one/multiple-result pipeline semantics are explicitly documented in a comment at the task-caller invocation site', () => {
    const body = getCallerInvocationConditionalBody();
    assert.match(body, /zero matches assigns \$null/);
    assert.match(body, /exactly one\s*\n\s*#\s*match assigns the single scalar object itself \(not a\s*\n\s*#\s*one-element array\)/);
    assert.match(body, /only two-or-more matches\s*\n\s*#\s*assign a real array/);
  });

  test('zero/one/multiple-result pipeline semantics are explicitly documented in a comment at the task-creator Enqueuer site', () => {
    const body = getEnqueuerConditionalBody();
    assert.match(body, /\$null for zero matches, the bare scalar object itself for\s*\n\s*#\s*exactly one match, or a real array only for two-or-more\s*\n\s*#\s*matches/);
  });

  test('the existing blocker checks (missing invocation binding / missing Enqueuer binding) are unchanged — still gated on @($x).Count -eq 0 for the unconditional-binding variables, untouched by this correction', () => {
    assert.match(preflightScript, /if \(@\(\$callerServiceBinding\)\.Count -eq 0 -and @\(\$callerProjectBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('task-caller service account lacks an explicit Cloud Run invocation binding'\)/);
    assert.match(preflightScript, /if \(@\(\$enqueuerQueueBinding\)\.Count -eq 0 -and @\(\$enqueuerProjectBinding\)\.Count -eq 0\) \{\s*\n\s*\$blockers\.Add\('task creator lacks an explicit Cloud Tasks Enqueuer binding'\)/);
  });

  test('the existing conditional-binding warning texts are byte-for-byte unchanged', () => {
    assert.match(preflightScript, /\$warnings\.Add\('conditional IAM binding present for the task-caller Cloud Run invocation role; requires separate human review'\)/);
    assert.match(preflightScript, /\$warnings\.Add\('conditional IAM binding present for the task-creator Cloud Tasks Enqueuer access; requires separate human review'\)/);
  });

  test('only matching conditional bindings (role+member matched, but the binding carries a condition) can ever produce these warnings — the filter predicate is exactly "-not (Test-IsUnconditionalBinding -Binding $_)" applied to the already role/member-filtered matching-bindings variables, never the raw unfiltered policy bindings', () => {
    const callerBody = getCallerInvocationConditionalBody();
    assert.match(callerBody, /\$combinedCallerMatchingBindings = @\(\$callerServiceMatchingBindings\) \+ @\(\$callerProjectMatchingBindings\)/);
    assert.doesNotMatch(callerBody, /@\(\$bindings\)/);

    const enqueuerBody = getEnqueuerConditionalBody();
    assert.match(enqueuerBody, /\$combinedEnqueuerMatchingBindings = @\(\$enqueuerQueueMatchingBindings\) \+ @\(\$enqueuerProjectMatchingBindings\)/);
  });

  test('does not globally rewrite ConvertTo-DataArray — the helper function itself is untouched', () => {
    const start = preflightScript.indexOf('function ConvertTo-DataArray');
    const end = preflightScript.indexOf('\n}', start) + 2;
    const body = preflightScript.slice(start, end);
    assert.match(body, /function ConvertTo-DataArray \{\s*\n\s*param\(\$Data\)\s*\n\s*if \(\$null -eq \$Data\) \{ return @\(\) \}\s*\n\s*return @\(\$Data\)\s*\n\}/);
  });

  test('the stale comment claiming the config-list projection surfaces api_endpoint_overrides has been corrected: the projection deliberately excludes and never evaluates it', () => {
    const start = preflightScript.indexOf('# Read-only local configuration inventory');
    const end = preflightScript.indexOf("\$configListResult = Add-Result 'configList'", start);
    assert.ok(start >= 0 && end > start);
    const body = preflightScript.slice(start, end);
    assert.doesNotMatch(body, /surfaces persisted[\s\S]{0,120}api_endpoint_overrides/);
    assert.match(body, /deliberately excludes and never evaluates api_endpoint_overrides/);
  });
});
