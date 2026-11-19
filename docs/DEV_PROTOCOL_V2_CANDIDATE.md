# SwingProAI Development Protocol v2.0 — Scoped Delivery

**Status: OWNER ADOPTION REQUIRED.** This contract becomes effective only after explicit owner approval of the exact AG-WF-01 amendments and successful scoped validation. Once adopted, it applies only to future owner-approved work orders explicitly referencing this revision; it grants no operation itself. The repository's default-branch policy changes only after separately authorized publication and merge. No historical grant is reopened.

## Product authority and quality

The Product Constitution governs permanent direction; Launch Gates governs all twelve hard launch requirements; subsystem contracts govern their scope. Verified implementation evidence outranks stale status prose. This protocol changes delivery management, not product requirements, security controls or launch criteria. Stop on a material unresolved conflict.

Keep the premium UX and evidence standards: mobile responsiveness, bottom tabs below 768px, 44x44px minimum targets, accessibility, fixed safe error copy, loading/empty/error/recovery states and complete golfer/coach paths. Distinguish measured, user-entered, sourced, model, coach, inferred and recommended information. Never invent precision.

Native architecture is not locked by this protocol. Shared platform readiness, separately authorized architecture work and the canonical launch sequence remain binding. No client implementation, vendor activation or live experiment starts merely because the roadmap mentions it.

## Delivery unit and ownership

Use one bounded, user-visible outcome per work order, normally small enough for a few focused engineering days; split by independently valuable behavior and risk, not arbitrary file counts or a rigid duration.

One lead writer owns code and test execution. Use only the independent read-only architecture/security/QA/UX reviewers appropriate to the actual risk, normally no more than two concurrently. They inspect supplied source/evidence and never expand execution permissions. Multiple writers require an explicit disjoint-scope assignment and separate isolated worktrees. Do not spawn agents for routine commands.

Keep at most one active implementation slice per lead. Independent owner recruitment, read-only planning and separately approved workstreams can proceed concurrently without silently starting native or unrelated features.

## Owner decisions and authorization

### 1. Build assignment

The owner approves the outcome, exact repository/base, isolated branch/worktree, permitted paths, operation limits, acceptance cases, fixture/data rules, resource budgets and stop conditions. The grant must explicitly name sensitive auth/RLS/entitlement/security changes where applicable.

That scope includes necessary local implementation, routine in-scope corrections, relevant tests, independent reviews and permitted local evidence/continuity updates. Do not pause for those already authorized steps. A new test case exposing an in-scope defect is work to finish, not automatically a new approval gate.

Branch/worktree creation must be enumerated if needed. Staging, commit, push, PR, hosted changes and spending are excluded unless separately and specifically authorized.

### 2. Optional reviewed publication package

After implementation and verification, present one concrete candidate for owner review. The owner may then authorize a single package containing separately enumerated stage, local commit, push and draft-PR actions. Each action retains its own scope, entry checks, attempt budget, evidence and stop conditions. A generic "publish" or workflow approval grants none of them.

A package must fix repository/destination, approved file set and content manifest or tree, parent/base identity, commit message, branch/remote conditions, PR base/head/title/body/draft state, relevant automation effects and verification. Assess relevant base-branch workflows and provider integrations; draft status or absence of workflows on the head branch is not proof that publication cannot trigger automation. If the commit SHA does not exist yet, bind approved bytes/tree and sole parent first; record the resulting commit SHA and use only that verified output in the authorized later steps.

Recheck only action-relevant identity, drift, changed content, protection and automation facts. Stop on mismatch or a failed prerequisite. No unrelated staging, automatic amendment, overwrite, force update, retry after an uncertain mutation, duplicate PR or bypass of hooks/protections. A repeated grant identifier never repeats a consumed attempt.

This packaging permission changes how explicit approvals can be grouped. It does not turn local implementation authority into publication authority.

### Separate consequential decisions

Merge, ready-for-review transition, auto-merge, branch deletion, deployment, staging/production database or fixture mutation, migrations, hosted settings, provider or paid API calls, vendor/licensing, physical-product actions, billing, DNS, app-store publication and firewall/OS changes require separate explicit owner scopes. Do not infer them from a build or publication package.

No automatic paid retry, secret/environment pull or production access. Unknown outcomes remain unknown and consumed where required. Preserve every current hold until evidence and the relevant owner decision close it.

## Risk-based verification

| Change | Required verification |
|---|---|
| Documentation or reversible presentation | Exact scope/diff and relevant static/content checks; visual/accessibility inspection when appearance changes. No full app suite solely for documentation. |
| Behavior, API, session or persistence | Focused contract/negative tests and real local runtime/integration for affected paths; typecheck/lint/build where affected. |
| Identity, RLS, billing, upload or AI authority | Threat/ownership/isolation/cost review, meaningful negative cases, relevant integration evidence and independent specialist acceptance. |
| Hosted release candidate | Relevant regression once on final candidate, authorized staging acceptance, approved rollback/monitoring plan, independent post-deploy verification when authorized. |

Run cheap affected checks during edits. Reuse accepted evidence only when SHA/artifact, environment, inputs and relevant contract still match. Repeat broader checks for changed inputs, a real failure, invalidated evidence or a release requirement. Do not omit necessary independent acceptance or relabel a known failure as a pass.

A full path includes the applicable UI, identity, API, persistence/worker, result, uncertainty/recovery and cleanup. Synthetic providers do not establish deployed behavior or coaching accuracy. Exercise startup, normal/error shutdown and owned-resource cleanup for new execution tools before remote-machine use.

AI changes require relevant held-out/labeled quality evidence, provenance and uncertainty treatment. Native/device and GPS/offline/location evidence is required for those capabilities. Test counts alone are not product acceptance.

## Tooling and process

Prefer established project tools and service APIs over one-off orchestration. Fix test infrastructure as infrastructure; do not bypass the product boundary to make a test pass. Do not introduce a new harness, framework, dependency, agent team, CI workflow or global hook unless the task needs it and authorizes its effects.

CI and safe deterministic checks can reduce manual repetition after an explicitly scoped setup and real-environment validation. Verify scripts/runtime/lockfiles/fixtures first. Never enable deployment or secret-dependent workflows as a side effect of adding test CI.

Capture one baseline per slice and one final evidence record, with lightweight identity checks at actual mutation boundaries. Existing exact pins, one-shot budgets and preservation requirements still apply where their contract requires them. Do not impose arbitrary per-request quotas or giant bespoke preservation scripts on every low-risk task.

## One delivery board and concise continuity

Use docs/DELIVERY_STATUS.md as the operational summary linking immutable evidence. It records active slice, observed environment/SHA/time, behavior, acceptance, risks, next decision and owner. Preserve detailed historical records rather than rewriting them.

Capability states are Planned, Implemented, Tested and Production-verified, each with evidence. Hard launch gates remain binary: independently verified done, or not yet done. A supporting partial test does not satisfy a whole gate.

Provide short progress on material findings, uncertainty and next work. Interrupt the owner only for a required separate operation, scope/risk/resource change, consequential decision or blocker requiring owner input. Finish the authorized work before requesting the next decision.

## Stop and completion

Stop the affected operation for out-of-scope changes, baseline drift, security/tenant regression, secret exposure, unsupported measurement claims, failed critical lifecycle/cleanup, exhausted budgets, missing capability or contradictory authority. Continue independent already permitted work when safe; do not turn one blocked lane into a project-wide freeze.

The final report gives outcome; exact source/diff identity; tests run and not run; environment; independent findings; cleanup; material risks; and one next decision. Keep raw logs/hashes in appendices rather than making the owner reconstruct the result.

## Trial and measurement

Trial this policy on the next approved web-readiness slice and compare it with the accepted AG-INT-01 history. Track engineering cycle time, owner interruptions, review/rework, escaped defects, staging-only failures and completion of actual user paths. Establish the baseline before claiming a percentage speedup.

The policy target is two routine owner decisions for a typical local feature: build and, when wanted, reviewed publication. Separate consequential decisions and real scope changes still need approval. No speed target can waive quality or any of the twelve launch gates.
