# Claude Code Agents, Skills, Tools and CI

Use the simplest execution shape capable of passing the acceptance contract.

**Claude lead:** own working context, authorized code edits and deterministic test commands. Keep one writer per file/worktree. Do not spawn an agent just to run a trivial command.

**Read-only reviewers** (`.claude/agents/`):
- `swing-architect`: architecture consistency and cross-platform domain contracts.
- `swing-security`: authorization, RLS, Stripe entitlements, media upload and secret threats.
- `swing-qa`: behavior matrix, error path and trustworthy test coverage.
- `swing-ux`: premium visual hierarchy, mobile responsiveness and accessibility.
- `swing-runtime-investigator`: runtime error causality, not guesses.

**On-demand project skills** (`.claude/skills/`):
- `/swing-feature-slice` for requirements -> code -> tests -> evidence.
- `/swing-incident` for failed runtime/CI tests.
- `/swing-release-review` for independent release-readiness assessment.
- `/swing-handoff` for concise new-chat continuity.

**Agent orchestration:** use a couple of read-only reviewers in parallel after code is ready; aggregate findings once. Do not concurrently edit shared files. Claude Code agent teams are experimental and disabled by default; start with subagents, and pilot agent teams only if an explicitly authorized, complex task needs peers to communicate. Use separate worktrees and resource/permission ceilings.

**Hooks:** later, after testing in real Windows/PowerShell environments, introduce only safe idempotent checks (such as formatting on scoped files). Do not install global or blanket hooks in initial bootstrap. Hooks are not a substitute for actual OS permissions, branch protections and approval controls.

**MCP / connected tools:** query GitHub/Supabase/Vercel/Stripe only when connected and appropriately authorized; prefer direct first-party observations. Read access never implies mutation authority. Keep credentials out of output.

**CI:** propose fast pull-request checks after verifying correct npm lock, node version, env fixture requirements and test/build scripts. Never copy a canned workflow directly into `main` or use CI to deploy production implicitly.

**Capabilities preflight in Claude Code:** check `/agents`, `/skills`, actual Claude version, available permission mode, git worktrees, access to Playwright/browser tools and CI infrastructure. Report unavailable capabilities instead of claiming to have used them.
