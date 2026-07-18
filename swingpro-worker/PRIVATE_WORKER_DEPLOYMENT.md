# Private Analysis Worker — Deployment & Security Runbook

This document is **documentation only**. It contains no real project values,
credentials, account emails, Supabase references, Gemini keys, image names,
service URLs, or secret contents. Every placeholder below (angle-bracket
tokens such as `<PROJECT_ID>`) must be replaced with a reviewed, real value
before any command is run.

**Every command shown in this document is a template. Every command must be
reviewed line by line before use. No command in this document has been
executed as part of this phase.**

---

## A. Deployment safety gate

- **This phase does not deploy anything.** No Dockerfile has been built, no
  image has been pushed, and no Cloud Run resource has been created or
  modified as part of this phase.
- The atomic Supabase migration for analysis-job finalization **remains
  unapplied**. It must be reviewed and applied only in its own controlled
  phase (see Section I).
- The Cloud Tasks queue that dispatches production analysis jobs **must
  remain paused, or otherwise prevented from dispatching**, until all of the
  following gates are complete, in order:
  1. the image is reviewed and built,
  2. the private service is deployed,
  3. IAM and secrets are configured,
  4. authenticated health verification succeeds,
  5. the atomic migration is separately reviewed and applied,
  6. an isolated end-to-end test succeeds.
- **Never resume production dispatch before all gates above are complete.**
- **Never run a migration command from the container startup command.** The
  container's only startup command is `node privateTaskServer.js`; it must
  never be changed to also apply a migration.

---

## B. Service architecture

### B.1 Public enqueue service

- Creates Cloud Tasks; it does not process swing analysis itself.
- Must **not** have the Gemini key in its runtime configuration.
- Must **not** expose the private task route
  (`/internal/tasks/analyze-swing`).

### B.2 Private analysis worker

- Receives Cloud Tasks callbacks at `POST /internal/tasks/analyze-swing`.
- Runs the lease-aware processor and the production swing analyzer.
- Uses the server-only Supabase service-role credential.
- Remains private behind Cloud Run IAM (`--no-allow-unauthenticated`).
- Exposes only its existing `GET /health` and internal task routes — no new
  routes are introduced by this phase.

### B.3 Task caller service account

- `<TASK_CALLER_SERVICE_ACCOUNT>` identifies Cloud Tasks to Cloud Run.
- It is in the same project as the Cloud Tasks queue.
- It receives only `roles/run.invoker` on this private service — nothing
  broader.

### B.4 Private worker runtime service account

- `<RUNTIME_SERVICE_ACCOUNT>` is attached to the Cloud Run worker revision.
- It is **separate** from the task caller identity described in B.3.
- It receives only the permissions required to read the two worker secrets
  (`roles/secretmanager.secretAccessor`, scoped to those two secrets only).
- It must **not** receive broad Owner, Editor, or project-wide
  administrative roles.
- Whichever identity performs the `gcloud run deploy` in Section E must hold
  `roles/iam.serviceAccountUser` on `<RUNTIME_SERVICE_ACCOUNT>` in order to
  attach it to the revision; this deploy-time permission is distinct from
  the runtime service account's own permissions and must not be granted to
  the runtime service account itself.

---

## C. Container build template

Run from `swingpro-worker`. Uses a commit-specific image tag — **never**
`latest`.

```powershell
$ProjectId = "<PROJECT_ID>"
$Region = "<REGION>"
$Repository = "<ARTIFACT_REPOSITORY>"
$CommitSha = "<COMMIT_SHA>"
$Image = "$Region-docker.pkg.dev/$ProjectId/$Repository/analysis-worker:$CommitSha"

gcloud builds submit `
  --project $ProjectId `
  --tag $Image `
  .
```

**This command is a template only. Do not execute it as part of this
phase.**

After a build is eventually run, the resulting image must be scanned and its
immutable image digest (`sha256:...`) recorded before any deployment
proceeds. The commit-tagged reference above must be resolved to that
specific digest for deployment, not re-pulled by tag at deploy time.

---

## D. Secret configuration

The following values are **Secret Manager-backed environment variables**:

- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`

The following values are **ordinary runtime configuration** (not secrets):

- `SUPABASE_URL`
- `ANALYSIS_JOB_LEASE_SECONDS` (`ANALYSIS_JOB_LEASE_SECONDS=300`)

Rules:

- `PORT` is injected by Cloud Run at runtime and must **not** be manually
  set on the service.
- Secret Manager environment references must use a specific numbered
  version (`<SECRET_VERSION>`, e.g. a literal version number), never
  `latest`.
- The runtime service account (`<RUNTIME_SERVICE_ACCOUNT>`) receives
  `roles/secretmanager.secretAccessor` only on the two secrets above —
  never a project-wide grant.
- Secrets must never be placed in:
  - Dockerfile `ARG`,
  - Dockerfile `ENV`,
  - source files,
  - image labels,
  - command history,
  - GitHub,
  - build substitutions,
  - public environment variables (never a `NEXT_PUBLIC_` variable),
  - logs.

Placeholder-only IAM templates for granting secret access (do not execute):

```powershell
gcloud secrets add-iam-policy-binding <SUPABASE_SECRET_NAME> `
  --project <PROJECT_ID> `
  --member "serviceAccount:<RUNTIME_SERVICE_ACCOUNT>" `
  --role "roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding <GEMINI_SECRET_NAME> `
  --project <PROJECT_ID> `
  --member "serviceAccount:<RUNTIME_SERVICE_ACCOUNT>" `
  --role "roles/secretmanager.secretAccessor"
```

**These commands are templates only. Do not execute them as part of this
phase.**

---

## E. Private Cloud Run deployment template

```powershell
$ServiceName = "<SERVICE_NAME>"
$ProjectId = "<PROJECT_ID>"
$Region = "<REGION>"
$Image = "<IMAGE_REFERENCE_WITH_DIGEST>"
$RuntimeServiceAccount = "<RUNTIME_SERVICE_ACCOUNT>"

gcloud run deploy $ServiceName `
  --project $ProjectId `
  --region $Region `
  --image $Image `
  --service-account $RuntimeServiceAccount `
  --no-allow-unauthenticated `
  --concurrency 1 `
  --timeout 1800s `
  --min-instances 0 `
  --max-instances <MAX_INSTANCES> `
  --set-env-vars "SUPABASE_URL=<SUPABASE_URL>,ANALYSIS_JOB_LEASE_SECONDS=300" `
  --update-secrets "SUPABASE_SERVICE_ROLE_KEY=<SUPABASE_SECRET_NAME>:<SECRET_VERSION>,GEMINI_API_KEY=<GEMINI_SECRET_NAME>:<SECRET_VERSION>" `
  --startup-probe "httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=1,periodSeconds=5,failureThreshold=12" `
  --liveness-probe "httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=10,timeoutSeconds=1,periodSeconds=30,failureThreshold=3"
```

**This command is a template only. Do not execute it as part of this
phase.**

Notes:

- The service must remain private. The `--no-allow-unauthenticated` flag is
  mandatory on every deployment of this service; a deployment that omits
  this flag's `no-` prefix is forbidden and must be rejected in review.
- IAM privacy and ingress routing are separate controls — configuring one
  does not configure the other.
- Ingress must remain compatible with Cloud Tasks HTTPS delivery.
- Internal-only ingress must **not** be selected without separately proving
  that the Cloud Tasks delivery path supports it.
- `<MAX_INSTANCES>` must be a deliberately bounded value chosen in review,
  not left unset or unbounded.

---

## F. Cloud Tasks OIDC identity

- Cloud Tasks should use an **OIDC** ID token to authenticate to Cloud Run.
- The task caller service account (`<TASK_CALLER_SERVICE_ACCOUNT>`) must be
  in the same project as the queue.
- The task caller receives `roles/run.invoker` on only this worker service —
  not on any other service.
- The Cloud Tasks service agent
  (`service-<PROJECT_NUMBER>@gcp-sa-cloudtasks.iam.gserviceaccount.com`) and
  the task-creating identity must have only the service-account permissions
  required by current Google Cloud documentation — nothing broader.
- `X-CloudTasks-*` headers are **informational only** and must not be
  treated as caller identity by the application.
- The application must **not** add duplicate application-layer
  authentication. Cloud Run IAM validates the Google-signed identity before
  the request is ever forwarded to the container.

URL relationship:

```
SWING_ANALYSIS_HANDLER_URL:       <SERVICE_URL>/internal/tasks/analyze-swing
SWING_ANALYSIS_HANDLER_AUDIENCE:  <SERVICE_URL>
```

The audience is the **base Cloud Run service URL**, not the task path. The
handler URL is that same base service URL with
`/internal/tasks/analyze-swing` appended.

Placeholder-only `roles/run.invoker` grant for the task caller (do not
execute):

```powershell
gcloud run services add-iam-policy-binding <SERVICE_NAME> `
  --project <PROJECT_ID> `
  --region <REGION> `
  --member "serviceAccount:<TASK_CALLER_SERVICE_ACCOUNT>" `
  --role "roles/run.invoker"
```

---

## G. Health and configuration verification

Safe, read-only verification templates (do not execute as part of this
phase):

```powershell
# Describe the Cloud Run service
gcloud run services describe <SERVICE_NAME> `
  --project <PROJECT_ID> --region <REGION>

# Inspect the service IAM policy
gcloud run services get-iam-policy <SERVICE_NAME> `
  --project <PROJECT_ID> --region <REGION>

# Confirm the deployed image digest
gcloud run services describe <SERVICE_NAME> `
  --project <PROJECT_ID> --region <REGION> `
  --format "value(spec.template.spec.containers[0].image)"

# Confirm the runtime service account
gcloud run services describe <SERVICE_NAME> `
  --project <PROJECT_ID> --region <REGION> `
  --format "value(spec.template.spec.serviceAccountName)"

# Confirm the service is not publicly invokable
# (expect NO binding of roles/run.invoker to allUsers or allAuthenticatedUsers)
gcloud run services get-iam-policy <SERVICE_NAME> `
  --project <PROJECT_ID> --region <REGION> `
  --format json

# Authenticated GET to /health (identity token from an authorized caller)
$Token = gcloud auth print-identity-token --audiences=<SERVICE_URL>
Invoke-RestMethod -Uri "<SERVICE_URL>/health" -Headers @{ Authorization = "Bearer $Token" }
```

Expected health response from the existing application:

```json
{
  "status": "ok",
  "service": "analysis-worker"
}
```

No unauthenticated `curl` example is provided, because the service must
never accept unauthenticated requests.

No production `POST` to `/internal/tasks/analyze-swing` is provided.
**Manually posting arbitrary job IDs to the private task route is
forbidden** — it could claim or mutate real jobs.

---

## H. Timeout and queue alignment

- The Cloud Run request timeout in the initial template (Section E) is
  `1800s`.
- The Cloud Tasks HTTP dispatch deadline must not be shorter than the
  intended maximum analysis request duration.
- The Cloud Tasks dispatch deadline and the Cloud Run request timeout must
  be reviewed together — changing one without the other can cause premature
  retries or dropped work.
- Analyzer cancellation and lease heartbeat behavior in the application code
  do **not** replace platform timeout configuration; they are independent
  controls.
- A timeout change requires deploying a new Cloud Run revision.
- Do not configure a Cloud Run timeout longer than the caller (Cloud Tasks)
  can maintain unless the failure and retry consequences have been
  explicitly reviewed.

---

## I. Rollout order

1. Keep production task dispatch paused.
2. Review Dockerfile and image contents.
3. Build and scan an immutable commit-tagged image.
4. Deploy the private worker with no public access.
5. Configure runtime secrets and least-privilege identities.
6. Verify authenticated `/health`.
7. Verify Cloud Run IAM and image digest.
8. Configure the public enqueuer's handler URL and OIDC audience.
9. Separately review the unapplied atomic Supabase migration.
10. Apply the migration in its own controlled phase.
11. Create one isolated non-production analysis job.
12. Verify task delivery, lease heartbeats, analyzer completion, telemetry,
    and atomic finalization.
13. Verify retry/idempotency behavior.
14. Resume production task dispatch only after approval.

---

## J. Rollback

Rollback means:

- Pause dispatch first, before taking any other rollback action.
- Route traffic to the prior known-good Cloud Run revision, or redeploy its
  immutable image digest.
- Do **not** blindly reverse the database migration.
- Inspect in-flight running jobs and lease expirations before assuming it is
  safe to roll back.
- Preserve logs without recording secrets or telemetry payload contents.
- Do not resume dispatch until runtime/database compatibility is confirmed.

---

## K. Official reference links

- https://cloud.google.com/run/docs/container-contract
- https://cloud.google.com/run/docs/configuring/healthchecks
- https://cloud.google.com/run/docs/authenticating/overview
- https://cloud.google.com/run/docs/authenticating/service-to-service
- https://cloud.google.com/run/docs/configuring/services/secrets
- https://cloud.google.com/run/docs/configuring/request-timeout
- https://cloud.google.com/tasks/docs/creating-http-target-tasks
