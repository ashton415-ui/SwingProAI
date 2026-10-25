---
name: swing-handoff
description: Prepare a precise SwingProAI release continuity handoff across Claude sessions or ChatGPT threads with authority, technical state, blockers and one next action.
---

# Handoff from evidence, not conversational confidence

Read current authoritative project documents and available last-run logs. Verify repo SHA and working tree if allowed. Record exact scope approved vs pending, verified stage/prod statuses with timestamps, data migration and release drift, user-facing goals, failing commands and evidence hashes. Mark `UNVERIFIED` where live state cannot be read. Carry forward open incident and test-run records exactly as recorded (identifiers, evidence hashes, cleanup status, pending proofs); treat them as immutable until an independently accepted run supersedes them. Never write tokens/secrets to public Git. Return one crisp next action and the exact approval it needs.
