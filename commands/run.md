---
description: "Run the factory autonomous coding pipeline (PRD issue → task PRs → staging)"
argument-hint: "[resume] --repo <owner/name> (--issue <N> | --spec-id <id>) [--driver sequential|balanced] [--ship-mode no-merge|live] [--run <id>]"
arguments:
  - name: mode
    description: "Omit to start a run; pass `resume` to re-enter a paused/suspended run"
    required: false
  - name: "--repo"
    description: "Target GitHub repo as <owner>/<name> (required to start a run)"
    required: false
  - name: "--issue"
    description: "PRD issue number — the stable spec lookup key (start mode)"
    required: false
  - name: "--spec-id"
    description: "Explicit <issue>-<slug> spec id, instead of --issue (start mode)"
    required: false
  - name: "--driver"
    description: "sequential (c=1) | balanced (c=3). Default balanced"
    required: false
  - name: "--ship-mode"
    description: "no-merge (open task PRs, never merge — cutover-safe) | live (auto-merge into staging). Default no-merge"
    required: false
  - name: "--run"
    description: "Run id to resume (resume mode; defaults to the current run)"
    required: false
---

# /factory:run

Drive a full pipeline run **in this session**. You are **Model A** — the in-session
orchestrator. The `factory` CLI is the deterministic brain (state, gates, classification,
ladder, floor, PR creation); you are the hands that perform every `Agent()` spawn it asks
for. The complete control loop, Iron Laws, the CLI surface, the spawn matrix, and the
model-alias mapping all live in `skills/pipeline-orchestrator/SKILL.md` — **invoke that
skill and follow it exactly**. Do not improvise transitions or write run state by prose.

## Parse the invocation

**Start mode** (no leading `resume`):

| Flag          | Required | Notes                                                |
| ------------- | -------- | ---------------------------------------------------- |
| `--repo`      | yes      | `<owner>/<name>`                                     |
| `--issue`     | one of   | PRD issue number (stable spec key)                   |
| `--spec-id`   | one of   | `<issue>-<slug>` (mutually exclusive with `--issue`) |
| `--driver`    | no       | `sequential` \| `balanced` (default `balanced`)      |
| `--ship-mode` | no       | `no-merge` (default) \| `live`                       |

Reject the call (stop with a clear message) if: `--repo` is missing; neither or both of
`--issue`/`--spec-id` are given; `--driver` is not `sequential`/`balanced`; `--ship-mode`
is not `no-merge`/`live`.

**`--ship-mode` is the cutover-safety knob.** Default `no-merge` opens each task PR but
never merges (the dry-run / no-merge mode). Pass `live` only when the user explicitly
opted into auto-merge into `staging`.

**Resume mode** (`/factory:run resume [--run <id>]`): skip spec + create; go straight to
`factory run resume` per the skill's Phase 3 resume note.

## Drive it

Load the orchestrator skill and run its protocol end-to-end:

```
Skill(pipeline-orchestrator)
```

Then execute, in order (all detail is in the skill — this is just the spine):

1. **Phase 0 — Preconditions.** Confirm a git checkout; `factory scaffold --repo <o/n>`
   (idempotent; refuses if staging branch protection is missing — tell the user to re-run
   `/factory:scaffold --provision` or protect staging manually, then stop).
2. **Phase 1 — Spec.** Run the bounded `factory spec resolve|gate|store` generate ⇄ review
   loop, spawning `spec-generator` / `spec-reviewer` as the envelopes ask, until `reuse`
   or `stored`.
3. **Phase 2 — Create.** `factory run create --repo <o/n> (--issue <n> | --spec-id <id>)
[--driver <d>]`; read `run_id` from the emitted `RunState`.
4. **Phase 3 — Drive.** Run the run loop + per-task stage machine, threading `--ship-mode`
   into every `factory run-task … --stage ship`. Holdout before reviews; verify-then-fix
   each blocking + citable finding; follow the `step` each `record-*` returns.
5. **Phase 4 — Completion.** Once every task is terminal, `factory run finalize --run
<run_id> --ship-mode <mode>` (builds the report, files one issue per dropped task, ships
   the staging→develop rollup, flips the run terminal — resume-safe + idempotent). Then
   `factory score --run <run_id>` + `factory state <run_id> --summary` to report the run
   status (`completed | partial | failed`), the rollup PR, and any drops. A
   `paused`/`suspended` run is NOT finalized — resume it instead. `main` is never touched.

**Resume mode:** `factory run resume [--run <id>]`. On `{kind:"still-blocked", …}` report
the reason + `resets_at_epoch` and stop; on `{kind:"resumed", run}` continue the Phase 3
run loop.

Everything else — the spawn isolation matrix, the path computations, the failure handling
— is in `skills/pipeline-orchestrator/SKILL.md`. Do not duplicate or contradict it here.
