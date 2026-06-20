---
description: "Start a fresh factory autonomous coding pipeline run (PRD issue → task PRs → staging → develop)"
argument-hint: "(--issue <N> | --spec-id <id>) [--repo <owner/name>] [--workflow] [--no-ship] [--supersede | --resume]"
arguments:
  - name: "--repo"
    description: "Target GitHub repo as <owner>/<name> (OPTIONAL — auto-derived from the origin remote; pass to override)"
    required: false
  - name: "--issue"
    description: "PRD issue number — the stable spec lookup key"
    required: false
  - name: "--spec-id"
    description: "Explicit <issue>-<slug> spec id, instead of --issue"
    required: false
  - name: "--workflow"
    description: "CREATE-ONLY mode selector: run the parallel background Workflow driver. Default (omit): session — sequential, in-session agents. Cannot combine with --resume (rejected loud)"
    required: false
  - name: "--no-ship"
    description: "CREATE-ONLY ship selector: open task/rollup PRs but never merge. Default (omit): live — auto-merge tasks into staging + rollup into develop. Cannot combine with --resume (rejected loud)"
    required: false
  - name: "--supersede"
    description: "If an active run already exists for this spec, mark it `superseded` (delete its staging branch + PRs) and start fresh — skips the conflict prompt"
    required: false
  - name: "--resume"
    description: "If an active run already exists, hand off to `/factory:resume` instead of starting fresh — skips the conflict prompt. Continues the run in its PERSISTED mode/ship; never pass --workflow/--no-ship alongside it"
    required: false
---

# /factory:run

Start a **fresh** pipeline run. The `factory` CLI is the engine (ALL control flow); the
driver is a dumb loop. `/factory:run` never silently reuses an existing run — to continue
one, use `/factory:resume`; to repair a stalled one, use `/factory:rescue`. Reject the call
with a clear message if neither or both of `--issue`/`--spec-id` are given. `--repo` is
OPTIONAL — the CLI auto-derives it from the `origin` remote of the current checkout (pass
`--repo <owner/name>` only to override; an explicit value that disagrees with the remote fails
loud).

**Defaults (no flags): session + live** — the in-session orchestrator loop, auto-merging
each task into staging and the staging→develop rollup into develop. Two terse boolean
overrides: `--workflow` (run the background Workflow driver instead of session) and
`--no-ship` (open PRs but never merge instead of live).

## Both modes start the same

Load the skill and run its Phases 0–2 (preconditions → spec loop → `factory run create
[--workflow] [--no-ship] [--supersede | --resume] --session-id "$CLAUDE_CODE_SESSION_ID"`;
read `run_id` from the emitted `{kind:"created"|"superseded", run}` envelope). Forward THIS
command's `--workflow`/`--no-ship`/`--supersede`/`--resume` flags verbatim to Phase 2's `run
create` so the resolved mode + ship intent persist on the run — the quota gate paces in
`session` and hard-stops without pacing in `workflow` (Decision 24), and `ship_mode` is read
back by the workflow driver + resume + finalize (never re-passed). `--workflow`/`--no-ship`
are **create-only** mode/ship selectors: combining either with `--resume` is rejected loud by
`run create` (a resumed run keeps the `mode`/`ship_mode` it was born with — both immutable), so
never let a mode flag ride a resume hand-off. Always pass `--session-id
"$CLAUDE_CODE_SESSION_ID"` so the run records THIS session as its `owner_session` — the Stop
gate then keeps the autonomous loop alive only here and lets other sessions stop freely
(Prompt J). With `--spec-id`, skip Phase 1 — the spec must already exist; `run create` fails
LOUD otherwise:

```
Skill(pipeline-orchestrator)
```

## Active-run conflict (Decision 35 — no silent reuse)

If an active run already exists for this spec, Phase 2's `run create` does **not** reuse it:
it exits `3` and emits `{kind:"exists", existing:{run_id, status}}`. The orchestrator skill
surfaces this back to the command; unless the user already passed `--supersede`/`--resume`
(which the skill forwards, skipping the prompt), ask with one `AskUserQuestion` before doing
anything destructive:

- **Continue (resume)** → run `/factory:resume --run <existing.run_id>` — re-enter the
  existing run where it left off (its staging branch + merged work are intact). The driver is
  chosen from the run's **persisted** `mode` (`session` → in-session loop; `workflow` → the
  Workflow driver), NOT from any `--workflow` flag on this `/factory:run` invocation — so a
  `--resume --workflow` is a contradiction and `run create` rejects it loud.
- **Supersede (fresh)** → re-run `factory run create … --supersede`: the old run is marked
  `superseded`, its `staging/<run-id>` branch + task PRs are deleted, and a fresh run starts.
  Then drive the fresh run.
- **Cancel the prompt** → stop here; leave the existing run untouched and `running` (this
  declines to start a fresh run — it does NOT abandon the existing one).

Map the answer to the `--resume` / `--supersede` flag — the CLI stays the single source of
truth (never hand-edit run state from the command).

To genuinely **abandon** the existing run (mark it terminal so its owning session can stop),
that session runs `factory run cancel --run <run_id>` (`--cleanup` also deletes its staging
branch + task PRs). A cancelled run is `failed` and NOT resumable — start fresh with
`/factory:run`. See Decision 35's addendum.

## Session mode (default)

Continue with the skill's Phase 3 THE LOOP and Phase 4 verbatim. Sequential: one
task at a time, every agent spawned in this session.

## Workflow mode (`--workflow`)

After Phase 2, launch the plugin's workflow driver and relay its result:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/factory-run-driver.js" })
```

Pass **no `args`**. The script self-resolves its run context (`run_id`, `data_dir`, `ship_mode`)
from the first `factory next` envelope — `ship_mode` was persisted by Phase 2's `run create`, and a
real object passed as `args` arrives JSON-string-encoded (so the script would see every field
`undefined`). `${CLAUDE_PLUGIN_ROOT}` is expanded by the Workflow tool; nothing else needs
substituting. It drives ready tasks in parallel (engine-enforced gates are identical; merges are
file-lock serialized). When it returns:

- `{ suspended: true, scope, resets_at_epoch }` → quota stop: report it; the user
  re-runs `/factory:resume` after the window resets. Do NOT finalize.
- otherwise → run the skill's Phase 4: `factory run finalize --run <run_id>` (ship mode is
  read from the run's persisted `ship_mode`), then `factory score` + `factory state --summary`,
  and report.

## Autonomous mode (MANDATORY — no opt-in, no opt-out)

The pipeline runs unattended by design. `factory run create` and `factory resume`
**HALT loud** unless the session is autonomous (`FACTORY_AUTONOMOUS_MODE=1`); there is no
bypass flag. The gate lives in the deterministic engine (`src/autonomy/mode.ts`,
`NotAutonomousError`), so a non-autonomous `/factory:run` cannot start a run — it exits
non-zero with the relaunch instruction rather than degrading to per-tool permission prompts.

`/factory:run` calls `factory autonomy preflight` as its first step (Phase 0 of the
orchestrator skill). Preflight auto-scaffolds the merged settings when needed, so the user's
only manual act is the relaunch itself:

```bash
factory autonomy preflight     # run-entry check: (re)scaffolds when needed, prints the relaunch command,
                               #   exits 0 to proceed / 1 to halt (decides over autonomous? + settings
                               #   present? + plugin vs on-disk version). Never throws on the decision path.
factory autonomy ensure        # manual primitive: always (re)writes merged-settings.json + prints the command
factory autonomy status        # manual primitive: exits 0 if autonomous, 1 if not (add --json for the payload)
```

Preflight regenerates `${CLAUDE_PLUGIN_DATA}/merged-settings.json` (via `ensure`) and halts for a
relaunch when the session is **not autonomous** OR the settings are **stale** (the stamped
`_factoryVersion` differs from the installed plugin), **missing**, or **unstamped**; it proceeds
silently when the settings are already fresh, or when the session is autonomous via a
directly-exported env (the sanctioned CI path). `ensure` merges
`templates/settings.autonomous.json` with the user's `~/.claude/settings.json` (placeholders
substituted, `CLAUDE_PLUGIN_DATA` baked into `env`, `statusLine` wired to `factory statusline`, the
user's own statusline chained via `FACTORY_ORIGINAL_STATUSLINE`), then prints
`claude --settings <merged-settings.json>`. Relaunching with that command sets
`FACTORY_AUTONOMOUS_MODE=1` and produces a fresh `usage-cache.json` on the first turn, which the
session-mode quota pacer reads. The relaunch is irreducible: Claude Code reads settings only at
launch, so a running session can never make _itself_ autonomous — automation covers the scaffold,
never the relaunch.

## Resuming a run → `/factory:resume`

Resuming a paused/suspended run is now its own command — see `/factory:resume [--run <id>]`.
`/factory:run` only ever starts fresh. (`factory run resume` remains as a thin CLI alias for
one release; the documented entry is `/factory:resume`.)
