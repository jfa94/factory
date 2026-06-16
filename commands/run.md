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
driver is a dumb loop. Reject a START call (no `resume`) with a clear message if: `--repo` missing;
neither or both of `--issue`/`--spec-id`; `--mode` not `session`/`workflow`;
`--ship-mode` not `no-merge`/`live`. Defaults: `--mode session`, `--ship-mode no-merge`
(`live` only on explicit opt-in — it auto-merges into staging).

## Both modes start the same

Load the skill and run its Phases 0–2 (preconditions → spec loop → `factory run
create --mode <session|workflow> --ship-mode <no-merge|live>`; read `run_id`). Pass THIS command's
`--mode` AND `--ship-mode` values through to Phase 2's `run create` so both persist on the run — the
quota gate paces in `session` and hard-stops without pacing in `workflow` (Decision 24), and
`ship_mode` is read back by the workflow driver + resume (never re-passed). With `--spec-id`, skip
Phase 1 — the spec must already exist; `run create` fails LOUD otherwise:

```
Skill(pipeline-orchestrator)
```

## `--mode session` (default)

Continue with the skill's Phase 3 THE LOOP and Phase 4 verbatim. Sequential: one
task at a time, every agent spawned in this session.

## `--mode workflow`

After Phase 2, launch the plugin's workflow driver and relay its result:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/factory-run.workflow.js" })
```

Pass **no `args`**. The script self-resolves its run context (`run_id`, `data_dir`, `ship_mode`)
from the first `factory next` envelope — `ship_mode` was persisted by Phase 2's `run create`, and a
real object passed as `args` arrives JSON-string-encoded (so the script would see every field
`undefined`). `${CLAUDE_PLUGIN_ROOT}` is expanded by the Workflow tool; nothing else needs
substituting. It drives ready tasks in parallel (engine-enforced gates are identical; merges are
file-lock serialized). When it returns:

- `{ suspended: true, scope, resets_at_epoch }` → quota stop: report it; the user
  re-runs `/factory:run resume` after the window resets. Do NOT finalize.
- otherwise → run the skill's Phase 4: `factory run finalize --run <run_id>
--ship-mode <no-merge|live>`, then `factory score` + `factory state --summary`, and report.

## Autonomous mode (optional — unattended, paced relaunch)

A normal interactive `/factory:run` works without prompts once the repo is scaffolded
(`factory scaffold` emits a target-repo `.claude/settings.json` allow-list +
`worktree.baseRef:"head"`). For a fully unattended run with session-mode quota pacing,
relaunch under the merged autonomous settings:

```bash
factory autonomy ensure        # writes ${CLAUDE_PLUGIN_DATA}/merged-settings.json + prints the command
```

It merges `templates/settings.autonomous.json` with the user's `~/.claude/settings.json`
(placeholders substituted, `CLAUDE_PLUGIN_DATA` baked into `env`, `statusLine` wired to
`factory statusline`, the user's own statusline chained via `FACTORY_ORIGINAL_STATUSLINE`),
then prints `claude --settings <merged-settings.json>`. Relaunching with that command sets
`FACTORY_AUTONOMOUS_MODE=1` and produces a fresh `usage-cache.json` on the first turn, which
the session-mode quota pacer reads. (Interactive runs do NOT need this.)

## Resume mode (`/factory:run resume [--run <id>]`)

`factory run resume [--run <id>]`. On `{kind:"still-blocked"}` report reason +
`resets_at_epoch` and stop. On `{kind:"resumed"}` re-enter the run loop (Phase 3 of
the skill in session mode, or re-launch the workflow in workflow mode — ask the user
which mode if it is ambiguous; the engine is indifferent).

Ship mode is persisted on the run (Phase 2's `run create --ship-mode`), so a workflow resume re-reads
it from the first `factory next` envelope — re-launch with `Workflow({ scriptPath })`, no `args`. A
session resume re-enters Phase 3, which passes the persisted value through as before.
