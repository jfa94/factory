---
description: "Run the factory autonomous coding pipeline (PRD issue → task PRs → staging)"
argument-hint: "[resume] --repo <owner/name> (--issue <N> | --spec-id <id>) [--mode session|workflow] [--ship-mode no-merge|live] [--run <id>]"
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
  - name: "--mode"
    description: "session (sequential, in-session agents — default) | workflow (parallel background Workflow)"
    required: false
  - name: "--ship-mode"
    description: "no-merge (open task PRs, never merge — cutover-safe) | live (auto-merge into staging). Default no-merge"
    required: false
  - name: "--run"
    description: "Run id to resume (resume mode; defaults to the current run)"
    required: false
---

# /factory:run

Drive a full pipeline run. The `factory` CLI is the engine (ALL control flow); the
driver is a dumb loop. Reject the call with a clear message if: `--repo` missing;
neither or both of `--issue`/`--spec-id`; `--mode` not `session`/`workflow`;
`--ship-mode` not `no-merge`/`live`. Defaults: `--mode session`, `--ship-mode no-merge`
(`live` only on explicit opt-in — it auto-merges into staging).

## Both modes start the same

Load the skill and run its Phases 0–2 (preconditions → spec loop → `factory run
create`; read `run_id`):

```
Skill(pipeline-orchestrator)
```

## `--mode session` (default)

Continue with the skill's Phase 3 THE LOOP and Phase 4 verbatim. Sequential: one
task at a time, every agent spawned in this session.

## `--mode workflow`

After Phase 2, launch the plugin's workflow driver and relay its result:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/factory-run.workflow.js",
  args: { runId: "<run_id>", shipMode: "<no-merge|live>", dataDir: "$CLAUDE_PLUGIN_DATA" }
})
```

(`$CLAUDE_PLUGIN_DATA` = the resolved data dir from your Bash env — pass its VALUE.)
It drives ready tasks in parallel (engine-enforced gates are identical; merges are
file-lock serialized). When it returns:

- `{ suspended: true, scope, resets_at_epoch }` → quota stop: report it; the user
  re-runs `/factory:run resume` after the window resets. Do NOT finalize.
- otherwise → run the skill's Phase 4: `factory run finalize --run <run_id>
--ship-mode <mode>`, then `factory score` + `factory state --summary`, and report.

## Resume mode (`/factory:run resume [--run <id>]`)

`factory run resume [--run <id>]`. On `{kind:"still-blocked"}` report reason +
`resets_at_epoch` and stop. On `{kind:"resumed"}` re-enter the run loop (Phase 3 of
the skill in session mode, or re-launch the workflow in workflow mode — ask the user
which mode if it is ambiguous; the engine is indifferent).
