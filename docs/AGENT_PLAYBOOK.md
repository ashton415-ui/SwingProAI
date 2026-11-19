# SwingProAI delivery roles, tools and verification

Use the simplest execution shape that satisfies the authorized outcome and acceptance contract. Apply the scoped protocol in docs/DEV_PROTOCOL_V2_CANDIDATE.md only for owner-approved work orders explicitly referencing that version.

## Lead and reviewers

One Claude Code lead owns the isolated implementation, relevant tests, permitted cleanup and aggregate report. A task is a whole golfer/coach behavior, not a sequence of approvals for every routine edit.

Use independent read-only reviewers when relevant:
- swing-architect: shared-platform contracts and architecture.
- swing-security: identity, RLS, entitlements, billing, uploads and cost boundaries.
- swing-qa: meaningful positive/negative/recovery coverage and evidence.
- swing-ux: mobile usability, visual consistency and accessibility.
- swing-runtime-investigator: failing lifecycle and source-backed causality.

Use only the necessary reviewers, normally at most two concurrently. Supply the same candidate/source/evidence and combine findings once. Reviewers do not mutate or make external calls under implied authority. Additional writers require an explicit disjoint-scope/worktree grant. Do not spawn an agent for trivial commands or claim unavailable tooling.

## Skills and execution

Use the existing feature, incident, release-review and handoff instructions when applicable. They guide execution; they do not grant scope or override canonical documents. Verify available capabilities locally when the task needs them. Do not install tools or use blanket permission modes to bypass a missing capability.

Keep one active implementation slice per lead. Continue safe, independent work already within scope while a separate lane waits for owner input.

## Tests and automation

Focused checks during edits; relevant candidate regression at a real merge/release boundary; authorized runtime and hosted acceptance for the affected full path. Reuse evidence for unchanged validated inputs. Record failures and exclusions honestly.

Prefer standard Git/service tools and small reusable runners. New CI, hooks, dependencies and execution infrastructure need a bounded setup assignment. Verify runtime, npm lock, actual scripts and safe fixtures first. No implicit deploy workflow, broad permissions, secrets pull or global hook.

Time-sensitive observations must be orchestrated together with actual timestamps, rather than scheduled through model-turn latency. A missed window is recorded as missed; do not retry a consumed grant.

## Ownership and status

Owner selects outcomes and grants the exact implementation/publication/consequential operations. ChatGPT prepares contracts and reviews evidence. Claude Code executes only where it has actual authorized capabilities.

Keep docs/DELIVERY_STATUS.md current within each authorized assignment, linking immutable detailed evidence. Provide one concise final aggregate result with the next decision. Preserve all twelve launch gates, shared-platform sequencing and current release holds.
