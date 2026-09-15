---
description: 'Deliver one PRD on one sequential feature branch and one PR'
argument-hint: '--issue <N> [--repo <owner/name>] [--no-ship | --local] [--e2e] [--ignore-quota]'
---

# /factory:run

Load `skills/pipeline-runner/SKILL.md` and follow its spec-generation and feature
execution protocol. Require a PRD issue number. Forward the supplied repository
and flags unchanged. Default delivery is live; `--no-ship` leaves one complete PR
ready for human review; `--local` parks the verified feature before any push or PR
until `/factory:resume --ship live|no-ship` authorizes delivery. `--e2e` adds independent journey authoring and execution.

Generate a fresh spec snapshot, then call `factory run create --issue <n>`.
The CLI refuses stale specs and a second active feature in the repository.
Resume an existing run explicitly; never supersede it or delete its artifacts.
Version 1 execution, imported specs, task PRs and staging rollups are retired.

Use only the actions emitted by `factory next-action`. Preserve the user's
publication authorization boundaries. Branch protection remains strict throughout
the feature lifecycle; no terminal path lowers it.
