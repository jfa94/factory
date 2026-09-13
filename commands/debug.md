---
description: 'Review and repair an existing committed diff on one feature branch'
argument-hint: '--base <ref> [--ignore-quota]'
---

# /factory:debug

Load `skills/pipeline-runner/SKILL.md`. Require a committed clean working tree
and an explicit base ref. Run `factory debug create --base <ref>`, forwarding
`--ignore-quota` only when supplied. Read the returned run ID and drive its
next-action loop.

Debug uses the complete feature checks, independent review and bounded forward
repairs. It leaves one PR ready for review; it does not automatically merge.
Use `factory state --run <id> --ledger` and the normal resume protocol after an
interruption. Do not invoke the retired debug start/seed/finalize commands.
