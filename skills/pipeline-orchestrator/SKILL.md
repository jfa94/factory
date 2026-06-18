---
name: pipeline-orchestrator
description: (internal) Drive the factory pipeline. The engine is the `factory` CLI (`next` + `drive` coroutines own ALL control flow); you are a dumb loop that spawns the agents each envelope names and feeds their raw output back.
auto-invoke: false
---

# Pipeline Orchestrator — the session driver

The `factory` CLI owns every decision: stages, gates, classification, the escalation
ladder, the review floor, holdout ordering, quota, cascade-drops, deadlock detection,
PR creation, and merging. You own exactly three verbs: **call the CLI, spawn what an
envelope names, feed the raw results back.**

## Iron Laws

1. **Never decide a transition.** The only next action is what the last envelope said.
   You never edit `state.json`, never re-order steps, never re-run a step to "check".
2. **Spawn exactly what the manifest says; collect output verbatim.** Role, model
   (mapped per the alias table), max_turns, isolation per the matrix. Never edit a
   finding, never form your own verdict on the code.
3. **Fail loud.** An unknown envelope `kind`, an unexpected non-zero exit, a deadlock
   error → STOP and surface it. A loud CLI error is a real defect — read the message;
   never blind-retry.

## Phase 0 — Preconditions

1. Confirm a git checkout: `git rev-parse --show-toplevel`. If not, stop.
2. Confirm autonomous mode: `factory autonomy preflight` (exits 0 to proceed, 1 to halt).
   It auto-scaffolds `merged-settings.json` when the session is not autonomous OR the
   settings are stale/missing/unstamped, and prints the relaunch command. The pipeline
   runs unattended — `run create`/`resume` HALT loud otherwise. On a non-zero exit,
   relay the printed `claude --settings <merged-settings.json>` command to the user and
   stop (the relaunch is the user's irreducible step; a running session cannot make
   itself autonomous). `factory autonomy status`/`ensure` remain the manual primitives.
3. `factory scaffold` (idempotent; `--repo` is OPTIONAL — auto-derived from the
   `origin` remote, pass `--repo <owner/name>` only to override. Refuses if staging
   branch protection is missing → tell the user to re-run with `--provision` or
   protect staging manually, then stop).

## Phase 1 — Spec (unchanged, durable, apex-gated)

`--repo` below is OPTIONAL on every `factory spec` action — the CLI auto-derives it
from the `origin` remote of the current checkout; pass `--repo <o/n>` only to
override. Run the bounded generate ⇄ review loop until `reuse` or `stored`:

```
env = factory spec resolve [--repo <o/n>] --issue <n>
loop on env.kind:
  reuse | stored → done (env.pointer); go to Phase 2
  generate → remember env.spawn.context + env.max_iterations (the loop bound)
      spawn spec-generator (worktree, opus) with env.spawn.context embedded
      write its GenerateResult JSON verbatim to env.generated_path
      env = factory spec gate [--repo <o/n>] --issue <n>
  revise → (count iterations; > the remembered max_iterations → STOP LOUD, spec-defect)
      re-spawn spec-generator (worktree, opus) with the remembered spawn.context
      PLUS env.reason and env.blockers appended ("fix these blockers first")
      write its GenerateResult JSON verbatim to env.generated_path
      env = factory spec gate [--repo <o/n>] --issue <n>
  review → spawn spec-reviewer (worktree, opus) with env.spawn.context embedded
      write its ReviewVerdict JSON to env.verdict_path
      env = factory spec store [--repo <o/n>] --issue <n>
```

Generator/reviewer follow `agents/spec-generator.md` / `agents/spec-reviewer.md`; the
CLI validates their JSON loudly — never coerce a malformed payload.

## Phase 2 — Create

```bash
factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new] [--supersede | --resume] [--workflow] [--no-ship] --session-id "$CLAUDE_CODE_SESSION_ID"
```

`--repo` is OPTIONAL — auto-derived from the `origin` remote of the current checkout (pass it only
to override; an explicit value that disagrees with the remote fails loud). Forward the invoking
command's `--workflow`/`--no-ship` flags verbatim (defaults — no flag: session + live); the resolved
`mode` and `ship_mode` persist on the run. `mode` tells the quota gate whether to pace (Decision 24:
`workflow` disables pacing — hard-stop, no pacing); `ship_mode` is read back by the workflow driver +
resume + finalize, so it is never re-marshaled. Always pass `--session-id "$CLAUDE_CODE_SESSION_ID"` — this stamps THIS
orchestrator session as the run's `owner_session`, so the Stop gate keeps the autonomous loop alive
only in the owning session and lets a _different_ session stop freely (Prompt J). The shell expands
the env var; if it is unset it expands to empty and the CLI degrades to owner-unknown (unscoped Stop
gate) — never a bogus empty owner. On success `run create` emits `{kind:"created"|"superseded", run}` —
read `run_id` from `.run.run_id` (not a bare RunState). Seed failures (duplicate/dangling/cyclic deps)
are spec defects — surface them.

**No silent reuse (Decision 35).** `run create` never adopts an existing run. If an active run already
exists for the spec, it exits `3` and emits `{kind:"exists", existing:{run_id, status}}`. Resolve it:

- If the invoking command forwarded `--supersede` or `--resume`, `run create` already acted on it
  (superseded the old run + created fresh, or the command will hand off to resume) — no prompt.
- Otherwise surface the conflict to `/factory:run`, which prompts the user (`AskUserQuestion`:
  resume / supersede / cancel) and re-invokes with the chosen flag. Do NOT re-run bare `create` in a
  loop hoping it sticks, and do NOT hand-pick the existing run — the flag is the only sanctioned escape.

Pass `--new` (or an explicit `--run-id`) to force an unconditional fresh run with a distinct id.

**Autonomy gate:** `run create` HALTS loud (`NotAutonomousError`, non-zero exit) if the orchestrator
session is not autonomous (`FACTORY_AUTONOMOUS_MODE=1`). This is the deterministic engine refusing to
start an unattended pipeline in an interactive session — not a transient error. Surface the relaunch
instruction (Phase 0 step 2); never retry blindly.

**When the run is in workflow mode (the command passed `--workflow`), STOP after this phase** — return
control to `/factory:run`, which owns the Workflow launch (`commands/run.md`). Do NOT enter Phase 3.

## Phase 3 — THE LOOP

THE LOOP is the session-mode driver ONLY. In workflow mode you stopped after Phase 2 — the
Workflow script (`scripts/factory-run-driver.js`) is the loop; do not run this phase.

The ship mode is persisted on the run (Phase 2's `run create`); `next`, `drive`, and `finalize` all
read it from state — never re-pass it and never choose it yourself.

```
loop:
  env = factory next --run <run_id>
  case env.kind:
    "run-terminal"  → go to Phase 4 (report)
    "all-terminal"  → factory run finalize --run <run_id>; go to Phase 4
    "quota-blocked" → report scope/reason/resets_at_epoch; tell the user to re-run
                      `/factory:resume` after the window resets; STOP.
    "tasks-ready"   → step env.ready[0] (sequential driver: ONE task at a time), then loop

step(task):
  results_file = (none)
  loop:
    tenv = factory drive --run <run_id> --task <task> [--results <results_file>]
    case tenv.kind:
      "terminal"      → report tenv.outcome (a drop is loud + classified); return
      "quota-blocked" → as above; STOP
      "spawn"         → collect (below) into a fresh results file; loop with --results
```

If `drive` rejects `--results` as stale/duplicate (fold_key mismatch), re-invoke WITHOUT `--results` to get the current envelope and continue — the ONE sanctioned retry (Iron Law 3 applies to everything else).

### Collecting a spawn envelope

Write results files under `$CLAUDE_PLUGIN_DATA/results/<run_id>/` (create the dir). NEVER write under `runs/**` or `specs/**` — the plugin's own TCB hooks deny those writes; `drive --results` reads from any path. Every spawn envelope names `expects`:

**`expects: "producer-status"`** (stages tests/exec — ONE producer agent):

1. Read the persisted context: `$CLAUDE_PLUGIN_DATA/runs/<run_id>/<agents[0].prompt_ref>`
   (a ProducerContext JSON).
2. Spawn the producer — `subagent_type` per the matrix, model mapped, `maxTurns` from
   the manifest, **isolation OMITTED**. Build the prompt from the ProducerContext +
   _"Your working tree is `<tenv.worktree>` (already checked out on the task branch). `cd` there; make ALL commits there."_
   The test-writer commits failing tests first (TDD); the executor commits the
   minimal implementation. They follow `agents/test-writer.md` / `agents/task-executor.md`.
3. Capture its terminal STATUS line (`STATUS: DONE` | `STATUS: BLOCKED — escalate` |
   `STATUS: NEEDS_CONTEXT`).
4. Results file: `{ "fold_key": <tenv.fold_key verbatim>, "producer": { "status": "<line>" } }`.

**`expects: "reviews"`** (stage verify — the 6-reviewer panel, plus sidecar):

1. **Sidecar first (if `tenv.sidecar` present):** spawn `general-purpose`, isolation
   `"worktree"`, model mapped from `sidecar.model`, `maxTurns = sidecar.max_turns`,
   prompt = `sidecar.prompt` VERBATIM. Keep its raw output.
2. **Panel:** spawn all six `manifest.agents` (each isolation `"worktree"`, model mapped from each agent's `model`, `max_turns` from the manifest). Construct each prompt per
   `skills/review-protocol/SKILL.md`: inspect via `git -C <tenv.worktree> diff origin/staging`,
   emit ONE RawReview JSON:
   `{ "reviewer":"<role>", "verdict":"approve|blocked|error", "findings":[ { "reviewer","severity","blocking","file","line","quote","description" } ] }`
   (`quote` REQUIRED; `file`+`line` make a finding citable; `findings` may be empty.)
3. **Verify-then-fix:** for EACH finding that is `blocking:true` AND citable, spawn an
   INDEPENDENT finding-verifier (`general-purpose`, isolation `"worktree"`, model
   `opus`, adversarial framing — _"try to refute this finding against the actual
   code"_, inspecting via `git -C <tenv.worktree> diff origin/staging`). It returns
   `{ "holds": true|false, "note": "<why>" }`.
4. Results file:
   ```json
   { "fold_key": <tenv.fold_key verbatim>,
     "holdout": { "raw": "<sidecar agent raw output>" },
     "reviews": {
       "reviews": [ <each RawReview JSON> ],
       "verifications": [ { "reviewer":"<role>", "verdicts":[ {"file","line","holds","note"} ] } ],
       "crossVendorAbsent": { "reason": "no second-vendor reviewer configured" } } }
   ```
   Omit `"holdout"` when there was no sidecar. Include one verdict for every
   blocking+citable finding (the CLI fails closed on a missing one). Include
   `crossVendorAbsent` only when no cross-vendor reviewer ran.

### Agent spawn matrix

| Agent                                | `subagent_type`                    | isolation                                  |
| ------------------------------------ | ---------------------------------- | ------------------------------------------ |
| test-writer                          | `test-writer`                      | **none** (omit) — works IN `tenv.worktree` |
| executor                             | `task-executor`                    | **none** (omit) — works IN `tenv.worktree` |
| 6 panel reviewers                    | the manifest `role`                | `"worktree"`                               |
| holdout-validator / finding-verifier | `general-purpose`                  | `"worktree"`                               |
| spec-generator / spec-reviewer       | `spec-generator` / `spec-reviewer` | `"worktree"`                               |

Model alias mapping: manifest model id contains `haiku` → `haiku`; `sonnet` →
`sonnet`; otherwise → `opus`.

## Phase 4 — Report

- A `quota-blocked` stop is NOT a quality outcome — never finalize it; report the
  reset horizon and stop (resume re-enters Phase 3 via `factory resume`, which
  clears a recovered checkpoint, then THE LOOP).
- After `run finalize`: `factory score --run <run_id>` (add `--dead-surface` for the
  unreferenced-exports report) + `factory state <run_id> --summary`. Surface the run
  status (`completed | partial | failed`), the rollup PR, filed issues, and every
  drop with its class — plainly, never papered over.
- If the shipped work changed the target repo's behavior and it keeps `/docs`,
  spawn `scribe` to update it.

## When NOT to use this skill

- CLI/internal questions or debugging → regular tools.
- Docs-only change → spawn `scribe` directly.
- A finished run → `factory state`; only a paused/suspended run resumes.
