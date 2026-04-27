---
description: "Run an all-hands sweep (architecture/security/quality/implementation reviewers + orchestrator self-review + Codex if available) against the latest commit (or a chosen scope), then drive a reviewer ⇄ implementer loop until the reviewer is satisfied"
argument-hint: "[--base <hash>|--full] [--limit <secs>] [--fixSeverity critical|high|medium|all] [--quick]"
arguments:
  - name: "--base"
    description: "Diff base (commit hash). Mutually exclusive with --full. Default: HEAD~1."
    required: false
  - name: "--full"
    description: "Review the entire codebase (sets base to git's empty-tree SHA). Mutually exclusive with --base."
    required: false
  - name: "--limit"
    description: "Maximum runtime in seconds. Soft limit — checked between loop iterations only."
    required: false
  - name: "--fixSeverity"
    description: "Minimum severity to address: critical | high | medium | all. Default: medium."
    required: false
  - name: "--quick"
    description: "Skip Phase 0 (all-hands sweep) and go straight to the Phase 1 reviewer ⇄ implementer loop. Useful when the 5h API budget is tight or you only need an iterative polish pass."
    required: false
---

# /factory:debug

Two-phase debugging workflow:

**Phase 0 — All-hands sweep (one shot, parallel fan-out).**

1. Dispatch in a single message: `architecture-reviewer`, `security-reviewer`, `quality-reviewer`, `implementation-reviewer` subagents (parallel) + Codex adversarial review in the background (when `codex` CLI is available + authenticated).
2. Orchestrator performs its own exhaustive line-by-line review of the diff.
3. Validate, dedupe, and classify every finding (`confirmed | dismissed | uncertain`) against the code AND the apparent intent of the diff (since `/factory:debug` has no spec).
4. Build a remediation plan from confirmed + in-threshold findings; spawn `task-executor` to implement it.

**Phase 1 — Reviewer ⇄ Implementer loop (existing behavior).**

5. Review the diff between `--base` (or HEAD~1, or root) and HEAD.
6. Filter findings by `--fixSeverity`.
7. If any remain, spawn `task-executor` to verify and fix them.
8. Repeat until clean, escalated, or `--limit` reached.

**Autonomous mode required.** Like `/factory:run`, `/factory:debug` runs `pipeline-ensure-autonomy` at the top of Setup. If the session was not launched with `claude --settings <merged-settings.json>` (or `FACTORY_AUTONOMOUS_MODE=1` for CI), the skill halts with the relaunch command. The pre-launch quota gate runs only after this check clears — `usage-cache.json` is only kept fresh inside an autonomous session.

**Budget gating.** Before launch and again between Phase 0 and Phase 1, the skill checks the 5h API window via `pipeline-quota-check`. The 5h **remaining** percentage drives a 5-step ladder (`≥ 40 / 20–40 / 10–20 / < 10` pre-launch; `≥ 40 / 20–40 / < 20` between-phases). At `20–40%` remaining the user is prompted to opt into `--quick`. Below the next bands the run **pauses** in a bounded wait-and-retry loop until budget recovers — it does not abort (only telemetry failure or the wait-cycle cap aborts). `--quick` skips Phase 0 entirely and skips the between-phases re-check. See the **Quota-aware ladder** in `skills/debug/SKILL.md`.

Parse flags from the user's input. Reject the call if both `--base` and `--full` are provided. Resolve the base ref:

- `--base <hash>` → that hash.
- `--full` → `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (git empty tree).
- (default) → `HEAD~1`.

Validate `--fixSeverity` against `{critical, high, medium, all}` (default: `medium`).

Capture `--quick` as a boolean (default: `false`).

Then load the skill:

```
Skill(debug, "base=<resolved> severity=<level> limit=<seconds> quick=<true|false> run-id=debug-$(date +%s)")
```

All loop + quota-gate logic lives in `skills/debug/SKILL.md`. Do not duplicate it here.
