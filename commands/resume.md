---
description: 'Resume a persisted feature checkpoint while preserving work and answers'
argument-hint: '--run <id> [--answer <text>] [--recover] [--ship live|no-ship]'
---

# /factory:resume

Load `skills/pipeline-runner/SKILL.md`. Run from a session whose cwd is the
target repository. Require an explicit run ID and inspect
`factory state --run <id> --ledger`. Call `factory resume --run <id>`, forwarding
`--answer` for a pending context question. Answers remain in the audit ledger.

When an attempt was interrupted, establish that its agent has stopped before
using `--recover`. Recovery consumes a durable result if present; otherwise it
retires the attempt lease and retains all Git work. Never reset or delete work.

Continue the next-action loop with the current session's stable driver identity.
Park and terminal envelopes end dispatch. `--ship live|no-ship` authorizes delivery
for a run created with `--local` and is the only way resume changes ship intent;
it never changes spec acceptance or quota policy. Legacy runs require a fresh v2 run.
