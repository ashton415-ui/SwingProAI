# Private Analysis Worker — Deployment Preflight

This document is **documentation only**. It contains no real project values,
credentials, account emails, Supabase references, Gemini keys, resource
names, secret names, queue names, repository names, or service URLs. Every
placeholder below (angle-bracket tokens such as `<PROJECT_ID>`) must be
replaced with a reviewed, real value before the script is run.

---

## A. Purpose and limits

- `scripts/private-worker-preflight.ps1` is a **read-only discovery** tool.
- It performs discovery only; it performs no remediation — there is no
  remediation logic anywhere in this script.
- It does not deploy anything and does not build anything.
- It does not access secret payloads.
- It does not list Cloud Tasks task payloads.
- It does not apply any database migration.
- The atomic Supabase migration for analysis-job finalization **remains
  unapplied** regardless of what this tool reports.
- Production Cloud Tasks dispatch **must remain paused** regardless of what
  this tool reports.
- **A clean report is not deployment approval.** The script never claims
  deployment readiness on its own.
- **Human review of the generated report is required** before any
  deployment, IAM change, secret change, or queue change is made.
- **The script fails closed.** Incomplete or inaccessible discovery —
  anything other than a clean `success` result for a required check — is
  always treated as a blocker; it is never silently ignored and never
  allows a clean (exit code `0`) result.
- **The script enforces an internal read-only command allowlist.** Every
  `gcloud` invocation is checked against an exact schema for the matched
  command — full command path, positional argument count/value, every flag
  name, whether it needs a value, and (for `--project`/`--region`/
  `--location`) that its value matches the caller-supplied `-ProjectId`/
  `-Region`/`-TasksLocation` — not merely that the argument sequence starts
  with an approved prefix. Anything that doesn't match is rejected without
  ever invoking `gcloud`.
- **Cloud Run metadata is requested through a reviewed safe JSON
  projection.** `gcloud run services list` and `gcloud run services
  describe` request only the fields this preflight evaluates and
  structurally exclude container environment variables and secret
  references — see Section B.
- **Every command-helper and top-level setup failure is contained.** An
  unexpected failure inside command invocation, JSON parsing, or
  repository-root resolution never produces an unhandled exception or an
  unintended exit code — it becomes either a structured `failed` result (so
  discovery can continue and the report can still be written) or, for
  setup that happens before any cloud discovery, a sanitized diagnostic and
  exit code `3`.

---

## B. Data sensitivity

The generated JSON report may contain:

- the Google Cloud project ID and project number,
- a minimal projection of authenticated gcloud account metadata — account
  identifier/email and active status only (see below),
- service-account emails,
- Cloud Run, Artifact Registry, and Cloud Tasks resource names,
- IAM members and role bindings,
- Cloud Run service URLs, latest ready revision, and traffic metadata,
- container image references (image tag/digest only),
- Cloud Tasks queue configuration,
- Secret Manager secret names and version metadata (state, creation time).

By design, the report **does not** contain secret payloads, access tokens,
identity tokens, credential file contents, or Cloud Tasks task bodies.

**Cloud Run service metadata is restricted to two separate reviewed safe
projections, scoped to what each command actually needs.** The generic
`gcloud run services list` (used only to inventory candidate services)
requests a minimal projection — a service name and `ingress` only, with
v1/v2 name alternatives. The targeted `gcloud run services describe` (only
ever run for the one supplied `-WorkerServiceName`) requests a richer,
still fully reviewed field list (with v1/v2 alternatives where useful): a
service name, service URL, ingress, latest ready revision, traffic, the
runtime service-account identity, the container image reference, and the
dedicated `invokerIamDisabled` boolean (Cloud Run v2's first-class
public-access field — see Section H). **Neither projection requests the
unrestricted annotations map, labels, or any other arbitrary
template/container object**, and the list projection additionally omits
every field the describe projection needs but the list evaluation does
not use (runtime identity, container images, traffic, revision details,
`invokerIamDisabled`). This means neither projection can include container
environment variables, `secretKeyRef` contents, mounted secret values,
command/args, volumes/volume mounts, or any other unrestricted
container-spec field, because gcloud itself never includes them in the
projected output. (`gcloud run services get-iam-policy` is unaffected —
its response is already just an IAM Policy object with no container
specification at all.)

Both Cloud Run results are additionally passed through a defensive
normalizer before they are stored anywhere in the report: the normalizer
builds an entirely new object containing only the reviewed fields above and
discards anything else gcloud might unexpectedly include, so an
unrestricted Cloud Run object can never reach `commandResults`,
`targetedResources`, or the top-level `cloudRunServices` field even if the
requested projection is somehow not fully honored. The normalizer is fully
type-checked, not merely presence-checked: every field is required to be
either absent (`null`) or of its expected scalar type — a string for the
URL, ingress, latest ready revision, and runtime service-account identity;
a boolean for `invokerIamDisabled`; a non-blank string for every retained
container image; and a numeric scalar for a traffic entry's `percent`
(paired with a string-or-null `revisionName`). A response missing a usable
(non-blank) service name, carrying a non-boolean `invokerIamDisabled`
value, carrying any field of an unexpected type, or (when a runtime service
account was supplied) missing a usable runtime service-account identity —
is treated as malformed output and reported as a failure rather than
accepted as-is. Whitespace-only strings are treated the same as empty
strings throughout: a service name, account identifier, or service-account
identity consisting only of spaces, tabs, or line breaks is never accepted
as a usable value. **This rule is unconditional for the runtime
service-account field specifically**: a whitespace-only runtime
service-account value is rejected as malformed output regardless of
whether `-RuntimeServiceAccount` was supplied — it is never silently
normalized into the report just because the caller omitted that
parameter. When `-RuntimeServiceAccount` was supplied, the field must
additionally be present (non-null); the separate semantic check that the
normalized value matches the supplied identity is unchanged.

**Authenticated account metadata is minimized before it reaches the
report.** The raw `gcloud auth list` response can include inactive
configured accounts and additional fields; only account identifier/email
and active status are retained for both the top-level `activeAccounts`
field and the corresponding `commandResults` entry. Credential paths, token
metadata, and any other account field are discarded before report assembly.

**Local gcloud configuration is minimized the same way.** The raw `gcloud
config list` response is never added to the report directly. A dedicated
normalizer builds an entirely new object containing only five reviewed
fields — `coreAccount` (null or a nonblank string) and four booleans
recording only *whether* `auth/impersonate_service_account`,
`auth/access_token_file`, `auth/credential_file_override`, and
`auth/disable_credentials` are configured/enabled, never the configured
value itself. The impersonated service-account identity, access-token-file
path, credential-file path, configuration directories, endpoint overrides,
active project, and every other configuration section/property are
discarded before this result ever reaches `commandResults` — the same
fail-closed, type-checked normalizer pattern used for Cloud Run metadata
above: a malformed or unexpectedly-typed value for any of the five
reviewed fields turns the whole result into a structured `failed` /
`malformed_output` result rather than partially trusting it.

The response root and its `auth`/`core` parent sections are each
explicitly validated as non-null inspectable objects (never a scalar or
array) before any property beneath them is read. This closes a specific
gap: a chained property-path read would otherwise silently treat a
malformed (scalar/array) parent section the same as an absent one,
reporting every property beneath it as merely "not present" instead of
failing closed. Reading `auth` and `core` through an explicit
found/value/access-failed outcome first — rather than reading straight
through them — means a malformed parent section always fails the whole
result closed instead of masquerading as "nothing configured".

**Each of the five reviewed properties is itself read the same
access-failure-aware way, not with a plain chained-path accessor.** A
property-access failure (a hostile or misbehaving getter) on
`auth/impersonate_service_account`, `auth/access_token_file`,
`auth/credential_file_override`, `auth/disable_credentials`, or
`core/account` fails that property's result closed (`failed` /
`malformed_output`, with a distinct generic diagnostic that names only the
property, never a raw value, path, token, or exception message) — it can
never be silently reinterpreted as the property simply being absent (which
would otherwise normalize to "not configured" / `false`). Absence and
explicit `null` both still normalize using the existing per-property rules
described above; only a genuine read failure is treated differently, and
it is always treated as a failure.

**Every IAM policy retrieved by this script (project, worker service,
artifact repository, queue, runtime/task-caller/task-creator service
accounts, and both supplied secrets — nine `get-iam-policy` results in
total) is minimized the same way, before the result is stored in
`commandResults`, placed into `targetedResources`, or read by any blocker
evaluation.** A dedicated normalizer rejects a null, scalar, or array
policy root outright; accepts an absent or null `bindings` property as an
empty bindings array; and, when `bindings` is present, requires it to be a
collection of inspectable binding objects — never a scalar, and never
silently accepting a null or scalar entry within the collection. Each
binding must carry a nonblank string `role` and at least one nonblank
string member; any binding that doesn't fails the **whole policy** closed,
so a partially-malformed policy can never be mistaken for a smaller, valid
one. Each binding's `condition` is read the same fail-closed,
access-failure-aware way: absent or explicitly null normalizes to `null`
(unconditional); a present, non-null condition must itself be exactly one
inspectable condition object — a scalar (string/number/boolean) **or an
array (including an empty array)** is rejected the same way, never
unwrapped or coerced to a single element. When valid, it is **never
retained as-is** — only a brand-new, opaque, non-null marker object
replaces it, carrying no title, description, CEL expression, `etag`,
`auditConfigs`, or any other raw policy property. This preserves exactly
the contract the unconditional-binding check already relies on (`null`
means unconditional, any non-null value means conditional) while
guaranteeing no raw IAM
condition expression — or any other unreviewed policy property — ever
reaches the report.

Local filesystem paths that would otherwise appear inside a raw `gcloud`
error message are redacted to a fixed `[REDACTED_PATH]` token before being
written into the report — the report should never leak the local
filesystem layout of the machine that ran the script. Redaction covers
Windows drive paths, UNC paths, `file://` URIs, and any absolute POSIX
filesystem path (`/root/`, `/workspace/`, `/home/`, `/Users/`, `/tmp/`,
`/var/`, `/opt/`, `/mnt/`, `/private/`, and any other absolute path) —
using a pattern that never mistakes the path portion of an `http://` or
`https://` URL for a local path. Because a path may itself contain spaces
(for example `C:\Users\Ashton Parson\project\file.txt`), redaction covers
the entire remainder of that line once a path-like span begins, rather than
stopping at the first whitespace — it is intentionally acceptable to
over-redact trailing text on the same line rather than risk exposing part
of a path.

**The output directory is fully canonicalized before the
repository-containment check.** Both the requested parent directory and the
repository root are resolved to their true real/canonical location before
comparison, so a parent directory that looks external but is actually a
reparse point into the repository is still rejected. Resolution walks every
path component from the root down (not just the final leaf), follows a
chain of consecutive reparse points, and fails closed — by throwing, which
surfaces as an exit-code-`3` validation failure — on a detected cycle, on
exceeding a conservative maximum link depth, or on a reparse point whose
target cannot be determined (the target getter throwing, returning `null`,
returning a blank value, or returning an empty array is never silently
treated as "not a link"). The script writes the report to this resolved
canonical destination, not the original lexical path.

Even so, treat the report as sensitive:

- **Never commit the report to Git.**
- **Never** point `-OutputPath` at a location inside this repository — the
  script refuses to write there.
- Review and redact resource metadata before sharing the report externally.
- Delete the report file when it is no longer needed.
- Do not paste its contents into public tickets, chat channels, or logs.

**Local authentication-override detection.** The entire security model of
this preflight depends on the identity `gcloud auth list` reports as active
being the identity every other `gcloud` invocation actually uses. Two
independent mechanisms can silently break that assumption, and this script
detects both:

- **`CLOUDSDK_AUTH_*` environment variables** (e.g.
  `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT`,
  `CLOUDSDK_AUTH_ACCESS_TOKEN`,
  `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`,
  `CLOUDSDK_AUTH_DISABLE_CREDENTIALS`) are the environment-variable
  equivalent of the `--impersonate-service-account` flag the command
  schema already rejects. The script enumerates the full local process
  environment and checks variable **names** (never values) for the
  `CLOUDSDK_AUTH_` prefix — any non-blank match, or a failure to safely
  enumerate the environment at all, is a blocker. A matched variable's
  name may appear in diagnostic context; its value never does.

  **The prefix match is deliberately case-insensitive.** Environment
  variable names are case-insensitive on Windows — this repository's
  development environment — so gcloud itself still honors a mixed-case
  variable (for example `CloudSdk_Auth_Impersonate_Service_Account`) even
  though a case-sensitive scan would miss it entirely and let the override
  escape detection. A case-insensitive scan is used on every platform: a
  conservative false positive on a platform where variable names are
  case-sensitive is strictly safer than a silent bypass on Windows.
- **`gcloud config list`** (a new, always-invoked, read-only, local-only
  command — no `--project` — requesting only a narrow, five-property
  format projection: `core.account`, `auth.impersonate_service_account`,
  `auth.access_token_file`, `auth.credential_file_override`, and
  `auth.disable_credentials`; see Section B for how the result is safely
  normalized) surfaces five further risks, each an independent blocker
  when triggered:
  - a persisted `auth/impersonate_service_account` configuration-file
    property (the configuration-file equivalent of the environment
    override above),
  - a persisted `auth/access_token_file` property (overrides the access
    token gcloud uses, independent of the authenticated account),
  - a persisted `auth/credential_file_override` property (overrides which
    credential file gcloud reads),
  - a persisted `auth/disable_credentials` property enabled (disables
    gcloud's credential-based authentication entirely, so the audited
    active account cannot be trusted as the effective authentication
    identity), and
  - a `core/account` value that disagrees, case-sensitively, with the
    single account `gcloud auth list` reports as active.

  For each of the three string-valued `auth/*` override properties:
  absent, null, or a blank string means "not configured" (no blocker on
  its own); a nonblank string means it is configured and blocks; any other
  value type is malformed configuration output and also blocks.
  `auth/disable_credentials` has its own boolean-or-boolean-like-string
  contract: absent, null, or blank normalizes to `false`; an actual
  boolean is used as-is; the exact strings `"true"`/`"True"` or
  `"false"`/`"False"` are accepted and normalized; any other string, any
  other scalar type, an object, an array, or a property-access failure is
  malformed configuration output and blocks. `core/account` keeps a
  stricter contract: absent/null is accepted as not configured, but a
  *present* value must be a nonblank string — a whitespace-only value or
  any other type is malformed and blocks, rather than being compared as
  though it were real. No configured value, file path, token, or
  credential is ever placed in blocker text — only that the property was
  configured.

---

## C. Prerequisites

- A locally installed `gcloud` CLI, resolvable on `PATH`.
- An account already authenticated to `gcloud` (this document includes no
  login command — authenticate through your organization's normal process
  before running the script).
- Least-privilege **read-only** IAM permissions for the identity running the
  script (e.g. viewer-level roles sufficient for `list`/`describe`/
  `get-iam-policy` calls). Do not grant this identity write permissions.
- An explicit `-ProjectId`, `-Region`, and `-TasksLocation` — the script
  never reads an implicit active project from gcloud configuration.
- An `-OutputPath` directory that already exists, is **outside** this Git
  repository, and does not already contain a file at that path.
- Production Cloud Tasks dispatch remains paused before, during, and after
  running this script.

This document does not include any command that modifies the active gcloud
project (`gcloud config set …`) and does not include any login command.

---

## D. Execution template

```powershell
.\scripts\private-worker-preflight.ps1 `
  -ProjectId "<PROJECT_ID>" `
  -Region "<REGION>" `
  -TasksLocation "<TASKS_LOCATION>" `
  -WorkerServiceName "<WORKER_SERVICE_NAME>" `
  -ArtifactRepository "<ARTIFACT_REPOSITORY>" `
  -QueueName "<QUEUE_NAME>" `
  -RuntimeServiceAccount "<RUNTIME_SERVICE_ACCOUNT>" `
  -TaskCallerServiceAccount "<TASK_CALLER_SERVICE_ACCOUNT>" `
  -TaskCreatorServiceAccount "<TASK_CREATOR_SERVICE_ACCOUNT>" `
  -SupabaseSecretName "<SUPABASE_SECRET_NAME>" `
  -GeminiSecretName "<GEMINI_SECRET_NAME>" `
  -OutputPath "<OUTPUT_PATH>"
```

All eight optional target parameters
(`WorkerServiceName`, `ArtifactRepository`, `QueueName`,
`RuntimeServiceAccount`, `TaskCallerServiceAccount`,
`TaskCreatorServiceAccount`, `SupabaseSecretName`, `GeminiSecretName`)
may be omitted during a first, generic inventory pass. Omitting one simply
means its targeted discovery and blocker/warning checks are skipped for
that resource, and a corresponding warning is recorded.

`TaskCreatorServiceAccount` identifies the identity that enqueues Cloud
Tasks tasks (for example, a backend service creating an OIDC-authenticated
task the `TaskCallerServiceAccount` identity will later execute). It is
validated as a service-account email in the `-ProjectId` domain using the
same conservative validation as the other supplied service accounts, and it
is used only to verify the Cloud Tasks OIDC delegation chain described in
Section H — it is never granted, altered, or impersonated by this tool.

**This template is not executed as part of this phase.** Review every
placeholder value before ever running it.

---

## E. Read-only command inventory

The script uses only the following `gcloud` command families:

| Family | Purpose |
| --- | --- |
| `gcloud version` | Local CLI metadata |
| `gcloud auth list` | Locally authenticated account metadata |
| `gcloud config list` | Local gcloud configuration inventory (authentication-override detection — see Section B) |
| `gcloud projects describe` | Explicit project metadata |
| `gcloud projects get-iam-policy` | Project-level IAM policy |
| `gcloud services list --enabled` | Enabled API inventory |
| `gcloud artifacts repositories list` | Candidate repositories in `-Region` |
| `gcloud artifacts repositories describe` | Named repository metadata (optional) |
| `gcloud artifacts repositories get-iam-policy` | Named repository IAM policy (optional) |
| `gcloud run services list` | Candidate Cloud Run services in `-Region`, using the reviewed safe JSON projection (Section B) |
| `gcloud run services describe` | Named service metadata (optional), using the same safe projection |
| `gcloud run services get-iam-policy` | Named service IAM policy (optional) |
| `gcloud iam service-accounts list` | Service accounts in `-ProjectId` |
| `gcloud iam service-accounts describe` | Named service account metadata (optional) |
| `gcloud iam service-accounts get-iam-policy` | Named service account IAM policy (optional) |
| `gcloud secrets list` | Secret metadata inventory |
| `gcloud secrets describe` | Named secret metadata (optional) |
| `gcloud secrets versions list` | Named secret version **metadata only** (optional) |
| `gcloud secrets get-iam-policy` | Named secret IAM policy (optional) |
| `gcloud tasks queues list` | Candidate queues in `-TasksLocation` |
| `gcloud tasks queues describe` | Named queue metadata (optional) |
| `gcloud tasks queues get-iam-policy` | Named queue IAM policy (optional) |

- `list` commands discover candidates.
- `describe` commands read metadata for one already-named resource.
- `get-iam-policy` commands read IAM configuration for one already-named
  resource.
- `secrets versions list` returns version **metadata** only (state, creation
  time, version name) — it never resolves or returns a secret payload.
- No command in this inventory performs remediation of any kind.

---

## F. Required API checklist

The script evaluates whether each of the following APIs is enabled, and
never enables a missing one:

- `run.googleapis.com`
- `cloudtasks.googleapis.com`
- `artifactregistry.googleapis.com`
- `secretmanager.googleapis.com`
- `cloudbuild.googleapis.com`
- `iam.googleapis.com`
- `iamcredentials.googleapis.com`
- `serviceusage.googleapis.com`

A missing required API is reported as a **blocker**. It is never
automatically enabled by this tool or any tool it invokes.

---

## G. Report interpretation

Each command result in the report has a `status` field with one of these
meanings:

- `success` — the command completed and returned data.
- `not_found` — the target resource was not found, or is not visible to the
  authenticated identity.
- `permission_denied` — the authenticated identity may lack sufficient
  permission; this does **not** necessarily mean the resource is absent.
  **`permission_denied` is never treated as proof of absence** — the script
  reports it as "could not be fully verified," not as "missing."
- `unavailable` — the command group, API, or `gcloud` itself could not be
  queried.
- `failed` — an unexpected read-only discovery failure occurred. This
  status is also used when a command is rejected by the internal read-only
  allowlist before `gcloud` is invoked.
- `not_requested` — an optional target parameter was omitted, so this
  discovery step was skipped.

**The task-caller Cloud Run invocation requirement is a blocker, not a
warning.** When a worker service, a task-caller service account, a
successful worker-service IAM policy, and a successful project IAM policy
are all available, the task-caller identity must hold an explicit
`roles/run.invoker` or `roles/run.servicesInvoker` binding at either the
worker-service IAM scope or the project IAM scope; if neither exists, this
blocks the preflight. Folder- and organization-level inherited IAM policies
are still not retrieved by this project-scoped tool and remain a separate
human-review warning.

Any required generic discovery result or supplied-target result that is not
exactly `success` becomes a blocker. Malformed or unexpected metadata inside
an otherwise-successful response — a missing field, an unexpected shape, a
response that doesn't match the structure the script expects — also
prevents a clean preflight: it is treated as a blocker rather than crashing
the script or being silently ignored. For the worker service specifically,
this happens before the response is even accepted as `success`: a
defensive normalizer rejects a Cloud Run description with no usable service
name, a non-boolean `invokerIamDisabled` value, or (when a runtime service
account was supplied) no usable runtime service-account identity, turning
the whole result into a generic failure rather than partially-trusted data.
Other malformed-metadata cases are reported directly as their own distinct
blocker: a service-account description with a missing or non-boolean
`disabled` field, an artifact repository description with a missing
`format` field, and a queue description with a missing, blank, or
non-string `state` field — each separate from the "not Docker-format" or
queue-state blockers used when the field is present but has a specific,
recognized unexpected value.

**Queue-state semantics: `PAUSED` is required, `RUNNING` is unsafe.**
Production Cloud Tasks dispatch must remain paused throughout this phase
(see Section A), so a supplied queue's `state` is evaluated against that
expectation, not against whether the queue happens to be "running":
`PAUSED` is the expected pre-rollout state and produces no queue-state
blocker; `RUNNING` produces a blocker stating that production dispatch is
not paused; `DISABLED` or any other recognized or unexpected state produces
a blocker stating that the queue is not in the required `PAUSED`
pre-rollout state. The queue is resumed only in a separately authorized
rollout phase — never by this read-only tool, and never implied by a clean
preflight result.

When a raw error message contains both permission-denied language (e.g.
"permission denied") and not-found language (e.g. "does not exist", "not
found", "may not exist") in the same message, the result is classified as
`permission_denied`, never `not_found` — permission-denied checks always
run first, because the inability to access a resource never proves that
resource is absent.

Exit codes:

- `0` — discovery completed and no blockers were found.
- `2` — discovery completed but one or more blockers were found.
- `3` — local parameter/output-path validation, or repository-root setup
  before any cloud discovery, failed.
- `4` — discovery completed but the report could not be safely written,
  or an unexpected failure escaped discovery/evaluation entirely, or the
  script somehow produced a result outside this exit-code set.

A `0` exit code means the automated checks found no blockers — it is **not**
a deployment approval. Human review of the full report is still required.

---

## H. Review checklist

Before treating any environment as deployment-ready, a human reviewer should
confirm:

- [ ] No local `CLOUDSDK_AUTH_*` environment variable is set on the machine
      that ran the preflight, and the local `gcloud config list` output does
      not set `auth/impersonate_service_account`, `auth/access_token_file`,
      or `auth/credential_file_override`, and does not disagree
      (case-sensitively) with `gcloud auth list` on `core/account` — any of
      these means the identity or credential that actually ran discovery
      cannot be verified to match the audited active account.
- [ ] Project lifecycle state is `ACTIVE`.
- [ ] All eight required APIs are enabled.
- [ ] At least one Docker-format Artifact Registry repository exists in the
      target region.
- [ ] The intended Cloud Run service is either absent (not yet deployed) or
      already private (`--no-allow-unauthenticated`).
- [ ] No worker-service IAM binding, under **any** role, grants `allUsers`
      or `allAuthenticatedUsers`. This is not limited to
      `roles/run.invoker`/`roles/run.servicesInvoker` — the script
      conservatively rejects any service-level public principal binding at
      all, closing gaps such as `roles/run.admin` or an unknown/custom
      role. The task-caller identity's own explicit invocation binding is a
      separate, narrower check (below) that still only recognizes
      `roles/run.invoker` and `roles/run.servicesInvoker`.
- [ ] No project-level IAM binding grants `allUsers` or
      `allAuthenticatedUsers` any role at all. Project-level bindings are
      inherited by every Cloud Run service in the project, so this is
      checked independently of the service-level binding above — at
      minimum this covers `roles/run.invoker`, `roles/run.servicesInvoker`,
      `roles/run.admin`, `roles/owner`, and `roles/editor`, but the script
      conservatively blocks *any* project-level role granted to either
      public principal.
- [ ] The task-caller service account holds an explicit, **unconditional**
      `roles/run.invoker` or `roles/run.servicesInvoker` binding — accepted
      at **either** the worker-service IAM scope **or** the project IAM
      scope. Since this check was strengthened, a missing unconditional
      binding at both scopes is a **blocker**, not merely a warning:
      without it, the task caller cannot invoke the worker service at all.
      A matching binding that carries an IAM condition does not satisfy
      this requirement (see "IAM conditions are not evaluated" below).
- [ ] Folder- and organization-level IAM policies inherited into this
      project have been separately reviewed. This preflight is scoped to
      the explicit project only and cannot retrieve ancestor-level policy;
      the report includes a warning to this effect, but it is not a
      substitute for that separate review.
- [ ] **Group membership has been separately reviewed.** Every IAM check in
      this preflight matches only literal `serviceAccount:<EMAIL>`
      members — it never expands `group:`, `domain:`, or `user:` members,
      and it never resolves whether a supplied service account is itself a
      member of a group that independently holds a relevant role. A clean
      report does not rule out access granted through group membership.
- [ ] **Custom-role permission expansion has been separately reviewed.**
      This preflight recognizes only the specific built-in role names it
      checks for (e.g. `roles/run.invoker`, `roles/cloudtasks.enqueuer`,
      `roles/secretmanager.secretAccessor`) — it never resolves a custom
      role's underlying permission list, so a custom role that happens to
      grant an equivalent permission under a different role name is
      neither recognized as satisfying a requirement nor flagged as
      overbroad access.
- [ ] The worker service's `invokerIamDisabled` field (Cloud Run v2's
      dedicated first-class boolean, not an annotation) is `false`. A
      service must not be treated as private merely because its IAM policy
      lacks a public binding — this field is a second, independent
      mechanism that can disable the Cloud Run Invoker IAM check entirely,
      and either mechanism alone can make a service publicly invokable. A
      successful worker-service description with a missing or non-boolean
      `invokerIamDisabled` value is itself rejected as malformed output
      before this check ever runs — it is never treated as `false`.
- [ ] The runtime, task-caller, and task-creator service accounts are all
      separate identities from one another.
- [ ] Neither the runtime, task-caller, nor task-creator service account
      holds a project-level Owner or Editor role.
- [ ] When a task-caller service account is supplied, a task-creator
      service account is also supplied and holds an explicit,
      **unconditional** `roles/iam.serviceAccountUser` binding on the
      task-caller service account (the `iam.serviceAccounts.actAs`
      permission required to mint Cloud Tasks OIDC tokens as that
      identity). Owner, Editor, and any unknown/custom role are never
      accepted as proof of this — a custom role that happens to contain
      `actAs` requires separate human review, and a matching binding that
      carries an IAM condition does not satisfy this requirement either.
- [ ] The Cloud Tasks service agent (`service-<PROJECT_NUMBER>@gcp-sa-cloudtasks.iam.gserviceaccount.com`,
      built only from the project number already retrieved by this
      preflight, where `<PROJECT_NUMBER>` is validated as plain positive
      digits before it is ever used) holds an **unconditional**
      `roles/cloudtasks.serviceAgent` binding at the project level.
- [ ] That same Cloud Tasks service-agent identity also holds an explicit,
      **unconditional** `roles/iam.serviceAccountUser` binding *on the
      task-caller service account* — separate from every other actAs/OIDC
      check listed here — because the service agent is the identity that
      actually mints the OIDC token for the task-caller when a task
      dispatches. This reuses the already-validated project number and the
      already-retrieved task-caller service-account IAM policy; it never
      issues an additional `gcloud` command. A matching conditional binding
      does not satisfy this requirement and produces a separate warning.
- [ ] When a queue and a task-creator service account are both supplied,
      the task creator holds an explicit, **unconditional**
      `roles/cloudtasks.enqueuer` binding (which provides
      `cloudtasks.tasks.create`) — accepted at **either** the queue IAM
      scope **or** the project IAM scope. Owner, Editor, Cloud Tasks Admin,
      Cloud Tasks Editor, and any unknown/custom role are never accepted as
      proof: those roles may happen to contain `cloudtasks.tasks.create`
      but do not demonstrate this narrow, least-privilege deployment
      configuration. A missing unconditional binding at both scopes is a
      blocker; a matching conditional-only binding does not satisfy the
      requirement and produces a separate warning.
- [ ] The runtime service account is scoped only to the secrets it needs: it
      holds an explicit, **unconditional** secret-level
      `roles/secretmanager.secretAccessor` binding on each supplied secret,
      and does **not** hold `roles/secretmanager.secretAccessor` at the
      project level (which would grant it every current and future secret
      in the project — this overbroad-access block applies regardless of
      any IAM condition on that project-level binding).
- [ ] The runtime service account does **not** hold
      `roles/secretmanager.admin` at the project level either — that role
      grants full management of every secret in the project (create,
      delete, update IAM policy, and access every version), strictly
      broader than even project-wide `secretAccessor`, and this block also
      applies regardless of any IAM condition on the binding.
- [ ] The task-caller service account is scoped only to invoking the
      intended worker service.
- [ ] Both the Supabase and Gemini secrets have at least one version whose
      `state` is exactly `ENABLED` **and** whose version name ends with a
      plain positive-integer `/versions/<N>` segment — `latest`, any other
      alias, `/versions/0`, and a missing or non-string version name are
      never accepted as satisfying this requirement.
- [ ] A successful secret version-list response contains **no** structurally
      malformed entry (null, a scalar, a non-string `state` or `name`, or a
      `name` that is not a plain positive-integer `/versions/<N>`). This is
      checked across *every* returned entry, independent of the requirement
      above: even when another entry in the same list is a valid, enabled
      numbered version, a single malformed entry still produces its own
      `malformed secret-version metadata` blocker — a mixed valid-plus-malformed
      version list is never accepted.
- [ ] The Cloud Tasks queue state and its retry/rate configuration have been
      reviewed.
- [ ] The Cloud Tasks queue state is `PAUSED` (the required pre-rollout
      state). `RUNNING` means production dispatch is not paused and is
      unsafe during preflight; the queue is resumed only in a separately
      authorized rollout phase, never by this tool.
- [ ] The handler URL and OIDC audience are not configured until deployment
      details (service URL, digest) have been independently verified.
- [ ] The atomic Supabase migration remains unapplied until its own,
      separately reviewed phase.
- [ ] **IAM conditions are not evaluated by this preflight.** For every
      permission-proving binding it checks (task-creator `actAs`, the
      Cloud Tasks service-agent's project-level `serviceAgent` binding, the
      Cloud Tasks service-agent's `actAs` binding on the task-caller
      account, the task-caller invocation binding, the task-creator
      `cloudtasks.enqueuer` binding, and each secret-level
      `secretAccessor` binding), only an unconditional binding — one with
      no `condition` property, or a `null` one — counts as automated
      proof. A matching binding that carries any condition value,
      including an empty or malformed condition object, is never accepted
      as proof and instead produces a warning that it requires separate
      human review. This does **not** weaken the conservative blockers:
      public-principal bindings, project-wide `secretAccessor` access, and
      project-level Owner/Editor grants remain blockers regardless of any
      condition on them.

### The complete Cloud Tasks OIDC identity chain

Dispatching a Cloud Tasks task with OIDC authentication to the private
worker service depends on five separate IAM links, each independently
verified by this preflight when the relevant parameters are supplied:

1. The task creator can enqueue a task on the queue (`TaskCreatorServiceAccount`
   holds an unconditional `roles/cloudtasks.enqueuer` binding at the queue
   or project scope).
2. The task creator can specify/`actAs` the task-caller identity when
   enqueuing the OIDC-authenticated task (`TaskCreatorServiceAccount` holds
   an unconditional `roles/iam.serviceAccountUser` binding on
   `TaskCallerServiceAccount`).
3. The Cloud Tasks primary service agent has `roles/cloudtasks.serviceAgent`
   at the project level (required for Cloud Tasks itself to operate on this
   project's queues).
4. The Cloud Tasks primary service agent has an unconditional
   `roles/iam.serviceAccountUser` binding on the task-caller service
   account (required for the service agent to mint the OIDC token as that
   identity when dispatching).
5. The task-caller identity can invoke the worker service
   (`TaskCallerServiceAccount` holds an unconditional `roles/run.invoker`
   or `roles/run.servicesInvoker` binding at the worker-service or project
   scope).

A break anywhere in this chain prevents the dispatched task from
successfully invoking the worker service, and this preflight raises a
distinct blocker for a missing link at each step.

---

## I. Forbidden remediation

The preflight script never:

- enables an API,
- creates a Google Cloud resource,
- deploys a Cloud Run service,
- builds or pushes a container image,
- updates or grants/revokes IAM,
- changes a secret or secret version,
- changes Cloud Tasks queue state,
- accesses a secret payload or secret version value,
- lists or describes individual Cloud Tasks task payloads,
- applies a database migration.

---

## J. Official references

- https://cloud.google.com/sdk/gcloud/reference/projects/describe
- https://cloud.google.com/sdk/gcloud/reference/projects/get-iam-policy
- https://cloud.google.com/sdk/gcloud/reference/services/list
- https://cloud.google.com/sdk/gcloud/reference/artifacts/repositories/list
- https://cloud.google.com/sdk/gcloud/reference/artifacts/repositories/get-iam-policy
- https://cloud.google.com/sdk/gcloud/reference/run/services/list
- https://cloud.google.com/sdk/gcloud/reference/run/services/describe
- https://cloud.google.com/sdk/gcloud/reference/run/services/get-iam-policy
- https://cloud.google.com/sdk/gcloud/reference/iam/service-accounts/list
- https://cloud.google.com/sdk/gcloud/reference/iam/service-accounts/get-iam-policy
- https://cloud.google.com/sdk/gcloud/reference/secrets/list
- https://cloud.google.com/sdk/gcloud/reference/secrets/describe
- https://cloud.google.com/sdk/gcloud/reference/secrets/versions/describe
- https://cloud.google.com/sdk/gcloud/reference/secrets/get-iam-policy
- https://cloud.google.com/sdk/gcloud/reference/tasks/queues/describe
- https://cloud.google.com/sdk/gcloud/reference/tasks/queues/get-iam-policy
