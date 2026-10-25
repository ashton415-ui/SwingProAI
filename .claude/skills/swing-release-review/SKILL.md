---
name: swing-release-review
description: Review an existing SwingProAI feature PR, test report or deployment candidate for security, premium UX, release gates and actual evidence; do not perform publication or deployment.
---

# Independent release acceptance

Verify candidate branch and SHA; compare with expected parent, changed files, requirements and tests. Independently inspect launch-gate impact, auth/RLS, entitlements, source/inference distinctions, premium mobile UI and rollback. Require relevant real integration tests and separately observed staging/production when warranted. List test commands and failures; never fabricate CI or browser evidence. Report PASS_READY_FOR_AUTHORIZATION, BLOCKED or INCONCLUSIVE, clearly identifying independently gated Git/production actions. No commits, pushes, PRs, merges or deployment.
