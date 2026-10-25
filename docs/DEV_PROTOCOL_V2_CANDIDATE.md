# SwingProAI Development Protocol v2.0 — CANDIDATE

**Status: DRAFT / NOT ACTIVE.** Adoption requires review of and explicitly authorized reconciliation with existing `CLAUDE.md`, Product Constitution and Launch Gates. Do not infer authority from a packaged document.

## Non-negotiable product requirements

Uphold the Product Constitution: premium professional-grade golf intelligence across swing, putting, equipment, launch-monitor, coaching, learning, progress, scoring and on-course experiences. Preserve source provenance and model-confidence distinctions; never fabricate swing metrics. Maintain shared platform domain logic for future mobile clients without prematurely choosing native implementation stack. Uphold **all twelve existing launch blockers**, including Android APK + Play Store, iPhone TestFlight + App Store, dedicated landscape iPad coach product, licensed iGolf, golf GPS and coach marketplace. This protocol changes *work management*, not product scope or launch criteria. Where this candidate and `CLAUDE.md`, the Product Constitution or Launch Gates differ, the canonical documents govern; stop and surface the conflict rather than choosing silently.

## Capability state vocabulary

Every status claim uses exactly one of these states, tied to its evidence:

- **Planned** — agreed direction or required future capability; not built.
- **Implemented** — code exists on a named branch/SHA; not yet tested.
- **Tested** — named tests or runtime checks passed in a named environment at a named SHA (record command, exit code, environment).
- **Production-verified** — independently observed in production after deployment, with timestamp and evidence source.

Never promote a capability to a higher state without the evidence that state requires.

## Roles

**Owner:** selects priorities, approves scoped implementation and separately gated mutations, accepts premium UX. **ChatGPT release manager:** translates intent to acceptance contract, inspects cross-service evidence when connected, issues risk classification and evidence-based go/no-go; never invents Claude execution. **Claude Code lead:** executes an authorized work order in the real repository with typed tool permissions; runs tests, coordinates subagent reviews, stops at explicit boundaries. **Review subagents:** architecture, security, QA and UX; independent observations, no writes. **CI:** reproducible checks; cannot substitute for end-to-end and live post-deploy verification.

## Scoped execution and approvals

- `READY / REVIEW`: read-only investigation and plan, no persistent mutation.
- `AUTHORIZE <work-order-id> LOCAL IMPLEMENTATION`: owner-approved isolated file edits plus necessary local tests and in-scope corrective iterations, but **not** automatic commit/push/PR/merge/live changes while current canonical documents still require separate grants.
- `AUTHORIZE <work-order-id> COMMIT`, `... PUSH`, `... PR`, `... MERGE`, `... RELEASE`: separate gates as mandated by current policy. Always inspect SHA/branch and conflicts immediately before each action.
- For sensitive authentication, RLS, secrets, Supabase migration, Stripe, Vercel, third-party vendor, DNS, native publication, or Windows network/firewall actions: separate explicitly named authorization regardless of batching.
- **Proposed future amendment:** permit one owner-approved bounded work order to include specified routine local edits, tests and potentially one local commit, while preserving independent PR/merge/deployment, staging/production/billing/firewall permissions. This is not effective until the authoritative documents are updated through their existing approval process.

## Fast path and quality path

1. **Define** one user-facing vertical slice and a measurable acceptance contract. Check exact canonical requirement, evidence types, subscriptions and migration effects.
2. **Inspect** just the relevant code, last verified SHA, existing tests and real constraints. Capture state once.
3. **Develop** in approved isolated branch/worktree. Let Claude complete in-scope edits and fixes without unnecessary pauses. Avoid multiple writers on shared files.
4. **Verify** quick affected tests every iteration; actual runtime startup/normal/exception/shutdown for new tools; complete API/worker/UI integration; security, accessibility and UX reviews when applicable.
5. **Review** with independent read-only specialists and a concise aggregate report. Correct in-scope failures, not unrelated modules.
6. **Release** only via explicit approved Git/hosting actions and independent acceptance. Feature flags and rollback for risky changes.
7. **Continuity**: update a concise verified state record when authorized; every claim tied to environment, SHA and result.

## Definition of done (risk-weighted, no quality tradeoff)

- Behavior: happy path, negative/edge cases, idempotency, retries, timeouts, cancellation, partial failure and recovery.
- Data trust: no synthetic measured values, correct evidence provenance, confidence limits, tenant/RLS isolation, role/entitlement safety, signed media upload, no secrets in logs.
- Experience: premium coherent cards, readable feedback, responsive mobile, bottom tabs <768px, >=44x44px touch targets, accessibility, honest loading/empty/error/partial states.
- Runtime: exercised end to end with appropriate fixture and real runtime lifecycle before cross-machine or staging acceptance.
- Regressions: appropriate focused tests, typecheck, lint/build when supported, impacted security and integration tests, no known blocking failures. Keep evidence from correct SHA.
- Delivery: independent PR and production review when authorized, migrations backward compatible where feasible, monitoring and rollback considered.

## Cost/speed controls

- Default one lead writer + up to 2–3 parallel read-only reviewers; agent teams only for genuinely separate tasks and if locally supported (experimental, off by default).
- Use cheap checks on each change, costly full suites at merge/release boundaries; never waive required independent verification.
- Reuse unchanged evidence only when artifact/environment/inputs still match and the contract allows it.
- One root-cause investigation per defect with a stop condition: if unable to reproduce, return explicit hypothesis and required next evidence; do not silently expand scope or convert temporary test tooling into a permanent product.
- Prefer built-in Claude agents/skills, project-specific Claude skills and GitHub CI over elaborate custom automation. Hooks only for deterministic, idempotent checks after safety review.

## Stop conditions

Out-of-scope write, baseline drift, secret exposure, contradictory canonical docs, unresolved tenant security regression, unreliable or invented metrics, failing key lifecycle, non-reproducible artifact, permission escalation, live service mutation, unapproved Git change or failed cleanup => STOP / BLOCKED. Retain evidence and identify one next safe action.

## Rollout and metrics

Phase A: inspect and prepare documents/agents/skills without changing existing authorization. Phase B: explicit bootstrap installation on isolated branch; smoke test skills/agents. Phase C: approve revised delegation in canonical docs if desired, establish basic CI and E2E smoke. Phase D: apply to one small feature/incident, review defects escaped vs time saved, then scale.

Track: owner interruptions per slice, cycle time from approval to verified feature, stale evidence rate, deploy-only failures, premium UX acceptance, escaped regressions, rollback/incident frequency. Baseline before targets.
