---
description: "Surgically recover a stalled factory run (explicit task resets, dead-ends, e2e verdicts, rollups) and hand off to resume"
argument-hint: "[--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup] [--dry-run]"
arguments:
  - name: "--run"
    description: "Run id to rescue (defaults to the current run)"
    required: false
  - name: "--task"
    description: "Reset exactly this task (repeatable); resets a dead-end without --include-dead-ends"
    required: false
  - name: "--include-dead-ends"
    description: "Also reset determined drops (spec-defect / capability-budget) — only after the root cause is actually fixed"
    required: false
  - name: "--reset-e2e"
    description: "Clear a failed e2e-phase verdict or a failed run-start e2e-assessment (Decisions 39/40) so it re-enters — only after the underlying cause no longer applies"
    required: false
  - name: "--recheck-rollup"
    description: "Reopen a completed run whose rollup armed but never landed, so a re-drive re-checks it — only after confirming the queued merge landed"
    required: false
  - name: "--dry-run"
    description: "Scan and report only; skip apply and the resume handoff"
    required: false
---

# /factory:rescue

The flag-rich escape hatch behind `/factory:recover`. Prefer **`/factory:recover`** for the
default repair (it routes itself and resets the same safe set); come here when a repair needs
a **human assertion** recover won't make: resetting a specific task or a dead-end
(`--task` / `--include-dead-ends`), clearing a failed e2e verdict (`--reset-e2e`), or
re-checking an armed rollup (`--recheck-rollup`). `factory rescue scan` is an alias of
`factory recover --dry-run`.

Invoke the `rescue-protocol` skill. It runs: resolve target run → `factory rescue scan` →
short-circuit if clean → `factory rescue apply` for the requested set → for ambiguous
dead-ends, spawn the read-only `rescue-diagnostic` agent and reset only those it recommends
→ spawn `rescue-reconciler` to clear git/GitHub drift (forward-only fixes autonomous;
anything destructive prompts first — see
`skills/rescue-protocol/reference/disposition-taxonomy.md`) → hand off to `factory resume`.

Parse the flags from the user's input, then load the skill:

```
Skill(rescue-protocol, "run=<id-or-empty> tasks=<csv-or-empty> include-dead-ends=<bool> reset-e2e=<bool> recheck-rollup=<bool> dry-run=<bool>")
```

Flag semantics (each is the human's assertion the underlying cause is fixed): `--task <id>`
resets exactly those tasks, including a named dead-end. `--include-dead-ends` also resets
determined drops. `--reset-e2e` clears a `failed` e2e-phase verdict (`e2e_failed` in the
scan) AND a failed run-start assessment (`e2e_assessment_failed`); a live adjudication
cursor is dropped, its per-spec caps survive. `--recheck-rollup` reopens a `completed` run
whose rollup armed but never landed (`rollup_pending`). Default (no flags): reset stuck +
recoverable, leave dead-ends, e2e failures, and pending rollups untouched.

All orchestration logic lives in `skills/rescue-protocol/SKILL.md` and its `reference/`
directory. Do not duplicate it here.
