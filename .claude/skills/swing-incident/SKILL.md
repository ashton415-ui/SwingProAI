---
name: swing-incident
description: Diagnose SwingProAI runtime crashes, test-harness failures, Next.js upgrade blockers, Windows PowerShell exceptions or regressions with focused evidence and minimal in-scope repair planning.
---

# Investigate before expanding scope

1. Freeze the reported failing command and full output. Identify exactly what passed, failed and was not run; preserve evidence artifact/hash. Do not convert harness failure into app failure.
2. Reconstruct the failing call chain and exception frame. Hypothesize at least two plausible causes; reproduce *locally offline* in memory or isolated fixture where authorized. Verify startup, normal path, error path and finally/disposal.
3. Confirm the exact source location before naming a root cause. Check whether cleanup, `finally` or shutdown handlers can fail and mask the first error, and whether evidence or state was left incomplete. Treat recorded test identifiers, evidence files and run records as immutable; never reuse a retired test identifier. Take current incident state from the authorized status record or work order, not from this skill.
4. Design the smallest remedy and regression tests; implement only if this work order explicitly approves local edits. No test-host, firewall, USB or Git mutations by implication.
5. Return RCA status confirmed/hypothesis, exact source location, reproducible test, remediation, regression scope, residual risk and next permission boundary.
