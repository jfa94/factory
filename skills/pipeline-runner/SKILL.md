---
name: pipeline-runner
description: (internal) Step the factory pipeline. The orchestrator is the `factory` CLI (`next-task` + `next-action` own ALL control flow); you are a dumb loop (the runner) that spawns the agents each envelope names and feeds their raw output back.
auto-invoke: false
---

# Pipeline Runner — the session runner

The `factory` CLI owns every decision: phases, gates, classification, the escalation
ladder, the merge gate, holdout ordering, quota, cascade-fails, deadlock detection,
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

Pass `--supersede` to `resolve` when the invoking command forwarded it — `resolve`
will delete the stale durable spec so the loop always emits `generate` (never `reuse`).

```
env = factory spec resolve [--repo <o/n>] --issue <n> [--supersede]
loop on env.kind:
  reuse | stored → done (env.pointer); go to Phase 2
  generate → remember env.max_iterations (the loop bound)
      spawn spec-generator (worktree, opus) with env.spawn.context embedded
      write its GenerateResult JSON verbatim to env.generated_path
      env = factory spec gate [--repo <o/n>] --issue <n>
  revise → (count iterations; > the remembered max_iterations → STOP LOUD, spec-defect)
      spawn spec-generator (worktree, opus) with env.spawn.context embedded
      (env.spawn.context already carries the prior spec + the blockers to fix — the
       agent PATCHES it; it does NOT re-author from scratch. Do not hand-assemble context.)
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
factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new] [--supersede | --resume] [--workflow] [--no-ship] [--ignore-quota] --session-id "$CLAUDE_CODE_SESSION_ID"
```

`--repo` is OPTIONAL — auto-derived from the `origin` remote of the current checkout (pass it only
to override; an explicit value that disagrees with the remote fails loud). Forward the invoking
command's `--workflow`/`--no-ship`/`--ignore-quota` flags verbatim (defaults — no flag: session + live); the resolved
`mode` and `ship_mode` persist on the run. `mode` tells the quota gate whether to pace (Decision 24:
`workflow` disables pacing — hard-stop, no pacing); `ship_mode` is read back by the workflow runner +
resume + finalize, so it is never re-marshaled. Always pass `--session-id "$CLAUDE_CODE_SESSION_ID"` — this stamps THIS
runner session as the run's `owner_session`, so the Stop gate's finalize-on-stop is scoped to
the owning session and never finalizes a _different_ session's run (Prompt J). The shell expands
the env var; if it is unset it expands to empty and the CLI degrades to owner-unknown (unscoped Stop
gate) — never a bogus empty owner. On success `run create` emits `{kind:"created"|"superseded", run}` —
read `run_id` from `.run.run_id` (not a bare RunState). Seed failures (duplicate/dangling/cyclic deps)
are spec defects — surface them.

**No silent reuse (Decision 35).** `run create` never adopts an existing run. If an active run already
exists for the spec, it exits `3`. Two distinct envelopes — check `kind` first:

- `{kind:"pause", scope:"7d", run_id, status, reason, resets_at_epoch?}` — the existing run
  is parked on the weekly quota window. **Hard stop: do NOT prompt, do NOT supersede.** Surface the
  reason + reset time and tell the user to `/factory:resume` after the window resets. The only override
  is `--ignore-quota` (user must pass it explicitly to this command, which forwards it to `run create`).
- `{kind:"exists", existing:{run_id, status}}` — generic active-run conflict. If the invoking command
  forwarded `--supersede` or `--resume`, `run create` already acted on it — no prompt. Otherwise
  surface the conflict to `/factory:run`, which prompts the user (`AskUserQuestion`: resume / supersede /
  cancel) and re-invokes with the chosen flag. Do NOT re-run bare `create` in a loop hoping it sticks,
  and do NOT hand-pick the existing run — the flag is the only sanctioned escape.

Pass `--new` (or an explicit `--run-id`) to force an unconditional fresh run with a distinct id.

**Autonomy gate:** `run create` HALTS loud (`NotAutonomousError`, non-zero exit) if the runner
session is not autonomous (`FACTORY_AUTONOMOUS_MODE=1`). This is the deterministic engine refusing to
start an unattended pipeline in an interactive session — not a transient error. Surface the relaunch
instruction (Phase 0 step 2); never retry blindly.

**When the run is in workflow mode, STOP after this phase** — return control to `/factory:run`,
which owns the Workflow launch (`commands/run.md`). Do NOT enter Phase 3. Read the mode from the
run's **persisted** `mode` (the `created`/`resumed` envelope), which the forwarded `--workflow`
flag set at create — NOT from the invoking flags directly. On a **resume** re-entry (`factory
resume` → `{kind:"resumed", run}`), the runner is `resumed.run.mode` verbatim (`session` → Phase 3;
`workflow` → hand back to `/factory:resume` for the Workflow launch); `mode` is immutable, so it is
never ambiguous and resume itself takes no mode flag.

## Phase 3 — THE LOOP

THE LOOP is the session-mode runner ONLY. In workflow mode you stopped after Phase 2 — the
Workflow script (`scripts/factory-run-runner.js`) is the loop; do not run this phase.

The ship mode is persisted on the run (Phase 2's `run create`); `next-task`, `next-action`, and `finalize` all
read it from state — never re-pass it and never choose it yourself.

```
loop:
  env = factory next-task --run <run_id>
  case env.kind:
    "done"  → go to Phase 4 (report)
    "finalize"  → factory run finalize --run <run_id>; go to Phase 4
    "document"    → run the DOCS STAGE (below); on done, loop; on suspend,
                      report the reason + STOP (run is suspended — /factory:resume retries)
    "pause" → report scope/reason/resets_at_epoch; tell the user to re-run
                      `/factory:resume` after the window resets; STOP.
    "work"   → step env.ready[0] (sequential runner: ONE task at a time), then loop

step(task):
  results_file = (none)
  loop:
    tenv = factory next-action --run <run_id> --task <task> [--results <results_file>]
    case tenv.kind:
      "done"      → report tenv.outcome (a drop is loud + classified); return
      "pause" → as above; STOP
      "spawn"         → collect (below) into a fresh results file; loop with --results
```

If `next-action` rejects `--results` as stale/duplicate (result_key mismatch), re-invoke WITHOUT `--results` to get the current envelope and continue — the ONE sanctioned retry (Iron Law 3 applies to everything else).

```
docs stage:
  denv = factory run docs --run <run_id>
  case denv.kind:
    "done"    → loop                      # idempotent: already published
    "suspend" → report denv.reason; STOP  # run suspended; /factory:resume retries
    "spawn"   → spawn scribe (subagent_type `scribe`, model per denv.model,
                isolation OMITTED — it works IN denv.worktree), prompt = denv.prompt VERBATIM.
                Capture its terminal STATUS line.
                Write {"status":"<line>"} to a results file under
                $CLAUDE_PLUGIN_DATA/results/<run_id>/.
                denv2 = factory run docs --run <run_id> --results <file>
                case denv2.kind: "done" → loop; "suspend" → report + STOP
```

**Abandoning a run.** If the user asks to abort/cancel/abandon this run mid-loop, run `factory run cancel --run <run_id>` (defaults to the run THIS session owns, then `runs/current`). It marks the run `failed` via the engine's own writer — so it works even with a task still executing. A cancelled run is terminal and NOT resumable (start a fresh `/factory:run` instead). Add `--cleanup` to also tear down the staging branch + its task PRs (omit it to keep them for manual handling). Cancel is for deliberately DISCARDING a run — you no longer need it merely to stop: the Stop hook lets a session end and leaves the run resumable via `factory resume`. Never edit `state.json` by hand — `run cancel` is the sanctioned abandon verb.

### Collecting a spawn envelope

Write results files under `$CLAUDE_PLUGIN_DATA/results/<run_id>/` (create the dir). NEVER write under `runs/**` or `specs/**` — the plugin's own TCB hooks deny those writes; `drive --results` reads from any path. Every spawn envelope names `expects`:

**`expects: "producer-status"`** (stages tests/exec — ONE producer agent):

1. Read the persisted context: `$CLAUDE_PLUGIN_DATA/runs/<run_id>/<agents[0].prompt_ref>`
   (a ProducerContext JSON).
2. Spawn the producer — `subagent_type` per the matrix, model mapped, `maxTurns` from
   the manifest, **isolation OMITTED**, plus the manifest agent's `effort` as the
   spawn's `effort` opt **when present** (the dial sets it only on high escalation
   rungs; omit it otherwise to inherit the default). Build the prompt from the ProducerContext +
   _"Your working tree is `<tenv.worktree>` (already checked out on the task branch). `cd` there; make ALL commits there."_
   The test-writer commits failing tests first (TDD); the implementer commits the
   minimal implementation. They follow `agents/test-writer.md` / `agents/implementer.md`.
3. Capture its terminal STATUS line (`STATUS: DONE` | `STATUS: BLOCKED — escalate` |
   `STATUS: NEEDS_CONTEXT`).
4. Results file: `{ "result_key": <tenv.result_key verbatim>, "producer": { "status": "<line>" } }`.

**`expects: "reviews"`** (stage verify — the 6-reviewer panel, plus sidecar):

1. **Sidecar first (if `tenv.sidecar` present):** spawn `general-purpose`, isolation
   `"worktree"`, model mapped from `sidecar.model`, `maxTurns = sidecar.max_turns`,
   prompt = `sidecar.prompt` VERBATIM. Keep its raw output.
2. **Panel:** spawn all six `manifest.agents` (each isolation `"worktree"`, model mapped from each agent's `model`, `max_turns` from the manifest). Construct each prompt per
   `skills/review-protocol/SKILL.md`: inspect via `git -C <tenv.worktree> diff <tenv.base_ref>`,
   emit ONE RawReview JSON:
   `{ "reviewer":"<role>", "verdict":"approve|blocked|error", "findings":[ { "reviewer","severity","blocking","file","line","quote","description" } ] }`
   (`quote` REQUIRED; `file`+`line` make a finding citable; `findings` may be empty.)
3. **Verify-then-fix:** for EACH finding that is `blocking:true` AND citable, spawn an
   INDEPENDENT finding-verifier (`general-purpose`, isolation `"worktree"`, model
   `opus`, adversarial framing — _"try to refute this finding against the actual
   code"_, inspecting via `git -C <tenv.worktree> diff <tenv.base_ref>`). It returns
   `{ "holds": true|false, "note": "<why>" }`.
4. Results file:
   ```json
   { "result_key": <tenv.result_key verbatim>,
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
| implementer                          | `implementer`                      | **none** (omit) — works IN `tenv.worktree` |
| 6 panel reviewers                    | the manifest `role`                | `"worktree"`                               |
| holdout-validator / finding-verifier | `general-purpose`                  | `"worktree"`                               |
| spec-generator / spec-reviewer       | `spec-generator` / `spec-reviewer` | `"worktree"`                               |

Model alias mapping: manifest model id contains `haiku` → `haiku`; `sonnet` →
`sonnet`; otherwise → `opus`. The manifest `effort` (when present) is passed to the
spawn **verbatim** — its values (`xhigh`/`max`) already match the spawn `effort` enum,
so no aliasing applies; it appears only on producer spawns, never reviewers.

## Phase 4 — Report

- A `pause` stop is NOT a quality outcome — never finalize it; report the
  reset horizon and stop (resume re-enters Phase 3 via `factory resume`, which
  clears a recovered checkpoint, then THE LOOP).
- After `run finalize`: `factory score --run <run_id>` (add `--dead-surface` for the
  unreferenced-exports report) + `factory state <run_id> --summary`. Surface the run
  status (`completed | failed`), the rollup PR, filed issues, and every
  drop with its class — plainly, never papered over.
- Documentation is no longer a Phase-4 step: the engine runs it as the
  `docs-ready` stage in THE LOOP (Phase 3), before finalize ships the rollup.

## When NOT to use this skill

- CLI/internal questions or debugging → regular tools.
- Docs-only change → spawn `scribe` directly.
- A finished run → `factory state`; only a paused/suspended run resumes.
