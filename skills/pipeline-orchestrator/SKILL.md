---
name: pipeline-orchestrator
description: (internal) Drive the factory autonomous coding pipeline end-to-end. The in-session orchestrator (Model A) sequences the deterministic `factory` CLI (run / spec / run-task / advance / drop / record-*) and performs every Agent() spawn the CLI reports. The CLI owns all state writes, gates, classification, ladder, and floor; you own the agent spawns and the loop.
auto-invoke: false
---

# Pipeline Orchestrator (Model A)

You are the **in-session orchestrator**. You drive the factory pipeline by calling the
deterministic `factory` CLI and performing the agent spawns it asks for. This is the
**Model-A split**:

- **The CLI is the brain.** `factory <subcommand>` owns ALL run-state writes, the spec
  gates, the deterministic verifier gates, failure classification, the producer escalation
  ladder, the risk-invariant review floor, and PR creation. It is deterministic and
  testable. It **never spawns an agent**.
- **You are the hands.** You spawn every `Agent()` the CLI reports, collect the agents'
  raw output, write it to a file, and fold it back via a `record-*` subcommand. You
  **never** decide a transition, re-run a gate, classify a failure, or write run state by
  prose — the CLI does all of that and tells you the next stage.

The CLI is a **reporter + writer**, not a runner. Reporter subcommands (`run-task`,
`spec`) emit ONE JSON envelope naming what to spawn next. Writer subcommands (`advance`,
`drop`, `record-producer`, `record-holdout`, `record-reviews`) fold an agent outcome into
state and return the next step. Your job is the glue: spawn → write file → record → follow
the step.

## Iron Laws

1. **Every transition is a CLI call.** Stage moves, classification, gates, the ladder, the
   floor, drops, PR creation — all live in `factory`. You react to its JSON; you never
   perform a transition by prose, and you never edit `state.json`.
2. **Follow the step the CLI returns — never invent the next stage.** Each `record-*`
   envelope carries `step`: `{done:false, stage}` → run `factory run-task --stage <stage>`
   next; `{done:true, outcome}` → the task is terminal, stop. Only a `run-task` result of
   `{kind:"advance", to}` requires you to call `factory advance --to <to>` yourself.
3. **Reviewers and verifiers judge the code; you do not.** You spawn the panel + holdout +
   finding-verifiers, collect their RAW output verbatim, and hand it to `record-reviews` /
   `record-holdout`. You never form an opinion on whether the code is correct, and never
   edit a finding.
4. **Spawn agents exactly as the manifest says.** Use the reported `role` as the
   `subagent_type`, the reported `model` (mapped to a tool alias), and the reported
   `max_turns`. Honor the worktree-isolation matrix below — producers run IN the task
   worktree (no isolation); reviewers/validators run in their own worktree.
5. **The seam fails loud.** An unknown `stage_result.kind`, a non-zero CLI exit you did
   not expect, a missing envelope field, or a deadlock → **STOP and surface it.** Never
   fall through to "advance" — a silent fall-through skips every gate.
6. **Holdout before reviews.** When a verify round surfaces a `sidecar`, run the
   holdout-validator and `factory record-holdout` BEFORE `factory record-reviews`.
   `record-reviews` fails closed if a withheld key has no persisted verdicts.

## Red Flags — STOP, you are rationalizing

| Thought                                                     | Reality                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "The executor returned green; I'll mark the task done."     | You don't write `done`. `factory run-task --stage ship` does, on a clean floor + PR.               |
| "I'll skip `record-reviews` and advance to ship myself."    | The floor is derived in `record-reviews`. Skipping it ships unreviewed code. Iron Law 1.           |
| "The panel approved; no need to verify findings."           | Every blocking + citable finding needs an independent finding-verifier. D27. No shortcut.          |
| "I'll re-run `run-task --stage verify` after recording."    | No. `record-reviews` already acted and returned the step. Follow it; never re-call verify.         |
| "I'll let the producer pick its own worktree."              | Producers run IN the task worktree (no isolation). A fresh worktree drops their commits.           |
| "The spec looks fine; I'll skip the reviewer."              | The spec apex gate is generate ⇄ review, bounded. `factory spec` drives it. No bypass.             |
| "No ready tasks and none blocked — I'll wait."              | That is a dependency cycle/deadlock. STOP LOUD; do not spin.                                       |
| "I'll merge the task PR myself."                            | Merge is `--ship-mode live` inside `run-task --stage ship`. Default is no-merge. Never `gh merge`. |
| "A record-\* call exited non-zero; I'll retry it verbatim." | A LOUD CLI error is a real defect (e.g. holdout-before-reviews). Read the message; fix the order.  |
| "I'll write the producer prompt from memory."               | Read the persisted ProducerContext JSON at the reported `prompt_ref`. Build the prompt from it.    |

---

## The `factory` CLI surface

`factory` is on `PATH` (the plugin's `bin/factory` shim). Every subcommand prints ONE JSON
document to stdout (or `--summary` human text for `state`). `--help` on any subcommand
prints its contract.

| Subcommand                                                                               | Kind     | What it does                                                                               |
| ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `factory scaffold --repo <o/n> [--provision]`                                            | action   | Prepare a repo (CI + gate configs + staging + branch protection). Refuses if unprotected.  |
| `factory configure [--get k] [--set k=v] [--unset k]`                                    | read/wr  | Inspect or edit the persisted config overlay.                                              |
| `factory spec resolve\|gate\|store --repo <o/n> --issue <n>`                             | reporter | The deterministic spec-build seam. Emits the next spawn or a revise/stored/reuse envelope. |
| `factory run create --repo <o/n> (--issue n\|--spec-id id) [--driver d] [--run-id id]`   | action   | Resolve a durable spec, create a run, seed task rows, emit `RunState`.                     |
| `factory run resume [--run id]`                                                          | action   | Re-check quota; resume a paused/suspended run if the window recovered.                     |
| `factory state [<run-id>] [--summary]`                                                   | read     | Read run state (JSON or compact summary). Read-only.                                       |
| `factory run-task --run <id> --task <id> --stage <s> [--ship-mode no-merge\|live]`       | reporter | Run ONE stage's deterministic work; emit `{stage_result, sidecar?}`.                       |
| `factory advance --run <id> --task <id> --to <stage>`                                    | writer   | Persist the in-flight cursor (use after a `run-task` `advance` result).                    |
| `factory record-producer --run <id> --task <id> --stage <tests\|exec> --status "<line>"` | writer   | Fold a producer's terminal STATUS line; emit the next step.                                |
| `factory record-holdout --run <id> --task <id> --input <path>`                           | writer   | Fold the holdout-validator output `{ "raw": "<out>" }`; persist verdicts.                  |
| `factory record-reviews --run <id> --task <id> --input <path>`                           | writer   | Fold the panel + verify-then-fix; derive the floor; emit the next step.                    |
| `factory drop --run <id> --task <id> --class <fc> --reason <t>`                          | writer   | Apply a classified LOUD drop (`capability-budget\|spec-defect\|blocked-environmental`).    |

**Task stages (in order):** `preflight → tests → exec → verify → ship`. `nextStage(tests)=exec`,
`nextStage(exec)=verify`. There is a run-level `finalize`, but **no `finalize` CLI subcommand
exists yet** (WS12 — see Phase 4).

## Paths you compute yourself

The data dir is `$CLAUDE_PLUGIN_DATA` (the CLI requires it; it is set in your Bash env).

- **run dir:** `$CLAUDE_PLUGIN_DATA/runs/<run_id>/`
- **producer prompt-context (read with the Read tool):**
  `$CLAUDE_PLUGIN_DATA/runs/<run_id>/<prompt_ref>` where `<prompt_ref>` is the manifest
  agent's `prompt_ref` (e.g. `prompts/<task_id>/executor-r0.json`).
- **task worktree (producers work here; reviewers inspect it):**
  `$CLAUDE_PLUGIN_DATA/worktrees/<run_id>/<task_id>`. The verify `sidecar.worktree` echoes
  this absolute path; producer prompts also carry it.
- **your record-\* input files:** write them under
  `$CLAUDE_PLUGIN_DATA/runs/<run_id>/reviews/` (create the dir; `--input` takes the path).

## Model-alias mapping

CLI manifests carry a full model id (e.g. `"opus"`, `"claude-haiku-4-5"`). The `Agent` tool
`model` param accepts only `haiku | sonnet | opus`. **Map by family substring:** id contains
`haiku` → `haiku`; contains `sonnet` → `sonnet`; otherwise (`opus`/anything) → `opus`.
Spec generator/reviewer and the whole review panel resolve to `opus` (apex / risk-invariant).
The `effort: "max"` the spec spawn carries is the apex intent — run those agents on `opus`
with no turn shortcuts; the tool exposes no separate effort dial.

## Agent spawn matrix

| Agent                         | `subagent_type`              | isolation       | Works in / inspects                                                 |
| ----------------------------- | ---------------------------- | --------------- | ------------------------------------------------------------------- |
| test-writer, executor         | the reported `role`          | **none** (omit) | `cd` into the task worktree; commit there on `factory/<run>/<task>` |
| 6 review-panel members        | the reported `role`          | `"worktree"`    | inspect via `git -C <taskWorktree> diff staging`                    |
| holdout-validator             | `general-purpose`            | `"worktree"`    | inspect via `git -C <taskWorktree> diff staging`                    |
| finding-verifier              | `general-purpose`            | `"worktree"`    | inspect via `git -C <taskWorktree> diff staging`                    |
| spec-generator, spec-reviewer | `spec-generator`/`-reviewer` | `"worktree"`    | reason over the PRD + spec context embedded in the prompt           |

Producers MUST be spawned with isolation OMITTED (the tool's only isolation value is
`"worktree"`, which would give them a fresh tree and orphan their commits). Tell them
explicitly: _"Your working tree is `<taskWorktree>`. `cd` there; make all commits there."_

---

## Phase 0 — Preconditions

1. Confirm you are in a git checkout (`git rev-parse --show-toplevel`). If not, stop.
2. **Scaffold the target repo** (idempotent; refuses if branch protection is missing):

   ```bash
   factory scaffold --repo <owner/name>
   ```

   If it refuses on missing protection, tell the user to re-run with `--provision` (writes
   protection) or to protect the staging branch manually — do not proceed unprotected.

3. Note the run mode the user asked for: which `--repo` + `--issue` (or `--spec-id`), which
   `--driver` (sequential | balanced; default balanced), and whether to merge
   (`--ship-mode live`) or stay cutover-safe (`no-merge`, the default).

## Phase 1 — Spec (durable, apex-gated)

The spec build is a bounded generate ⇄ review loop. `factory spec` owns the gates,
adjudication (56/60 + any-dimension≤5 floor), and the durable store; **you** own the two
agent spawns and the loop. Run it until you reach `reuse` or `stored`.

```
env = factory spec resolve --repo <o/n> --issue <n>
iters = 0
loop:
  case env.kind:
    "reuse":    → spec ready (env.pointer). Go to Phase 2 (create by --issue).
    "stored":   → spec ready (env.pointer). Go to Phase 2.
    "generate":
        iters++; if iters > env.max_iterations → STOP LOUD (spec-defect: regen budget exhausted)
        spawn spec-generator (worktree, opus) with env.spawn.context embedded
            → agent returns a GenerateResult JSON: { specMd, slug, tasks:[…] }
        write that JSON verbatim to env.generated_path
        env = factory spec gate --repo <o/n> --issue <n>
    "revise":   # gate blockers (source=gate) or sub-threshold review (source=review)
        iters++; if iters > env.max_iterations → STOP LOUD (spec-defect)
        re-spawn spec-generator, embedding env.reason + env.blockers as REVIEW_FEEDBACK
            → returns a fresh GenerateResult JSON
        write it to env.generated_path
        env = factory spec gate --repo <o/n> --issue <n>
    "review":
        spawn spec-reviewer (worktree, opus) with env.spawn.context embedded
            → returns a ReviewVerdict JSON
              { decision, score, per_dimension{granularity,dependencies,acceptance_criteria,
                tests,vertical_slices,alignment}, blockers, concerns }
        write it to env.verdict_path
        env = factory spec store --repo <o/n> --issue <n>
```

Generator and reviewer follow `agents/spec-generator.md` / `agents/spec-reviewer.md`; the
output JSON shapes are validated LOUDLY by the CLI (a malformed payload is a hard error — do
not coerce it). Use the absolute `prd_path` / `generated_path` / `verdict_path` the
envelopes echo; write each agent's output there with the Write tool before the next `spec`
call.

## Phase 2 — Create the run

```bash
factory run create --repo <owner/name> --issue <n> [--driver sequential|balanced] [--run-id <id>]
```

Read `run_id` from the emitted `RunState`. (Use `--spec-id <id>` instead of `--issue` to
pin an explicit spec.) Seeding fails LOUD on a duplicate/self/dangling/cyclic dependency —
that is a spec defect; surface it.

## Phase 3 — Drive the run

Mirror the deterministic driver. Outer loop = run-level (dependency order, cascade-drop,
deadlock); inner loop = per-task stage machine.

### Run loop

```
concurrency = (driver == "sequential") ? 1 : 3
loop:
  run = factory state <run_id>            # JSON
  if run.status is terminal (completed|partial|failed): break → Phase 4
  if every task is terminal:              # all done/dropped
      break → Phase 4                     # (finalize has no CLI yet — Phase 4)
  # Cascade-drop any pending task whose dependency dropped or is missing:
  for each pending task t with a depends_on entry that is dropped/absent:
      factory drop --run <run_id> --task <t> --class blocked-environmental \
        --reason "dependency '<dep>' did not complete (dropped or missing)"
  if you dropped any: continue            # re-read state
  ready = pending tasks whose every dependency is done
  if ready is empty:
      STOP LOUD — dependency cycle or deadlock (non-terminal tasks but none ready)
  batch = first <concurrency> of ready
  drive each task in batch (see driveTask). In balanced mode you MAY spawn the
    batch's same-stage agents in one Agent() message; keep each task's `factory`
    CLI calls serialized for that task. Then loop (re-read state).
```

A run that was paused/suspended on quota is resumed with `factory run resume [--run <id>]`
(human-relaunch only in v1). On `{kind:"still-blocked", …}` report the reason +
`resets_at_epoch` and stop; on `{kind:"resumed", run}` continue the run loop.

### driveTask — one task to terminal

```
factory advance --run <run_id> --task <t> --to preflight     # mark in-flight at start
stage = "preflight"
loop:
  env = factory run-task --run <run_id> --task <t> --stage <stage> [--ship-mode <mode>]
  r = env.stage_result
  case r.kind:
    "advance":
        factory advance --run <run_id> --task <t> --to <r.to>
        stage = r.to
    "spawn-agents":
        if stage in {tests, exec}:  step = runProducer(env, stage)        # see below
        elif stage == "verify":     step = runVerify(env)                 # see below
        else: STOP LOUD (unexpected spawn at stage <stage>)
        if step.done: report step.outcome; break
        stage = step.stage
    "task-terminal":                 # ship wrote the terminal status already
        report r.outcome; break
    "wait-retry":                    # only from ship live-merge refusal
        merge_resyncs++ (cap 8)
        if over cap: factory drop … --class blocked-environmental --reason "<r.reason>"; break
        factory advance --run <run_id> --task <t> --to exec       # re-sync the branch
        stage = "exec"
    "graceful-stop" | "finalize-terminal": STOP LOUD (run-scope result at task scope)
    default: STOP LOUD (unknown stage_result.kind)
```

`--ship-mode` defaults to `no-merge` (cutover-safe: opens the task PR, never merges). Pass
`live` only when the user opted into auto-merge.

### runProducer (stages tests, exec)

The manifest carries ONE producer agent. Its prompt-context is already persisted.

1. `prompt_ref = env.stage_result.manifest.agents[0].prompt_ref` →
   Read `$CLAUDE_PLUGIN_DATA/runs/<run_id>/<prompt_ref>` (a ProducerContext JSON:
   `{taskId, title, description, acceptanceCriteria, files, rung, fixInstructions,
priorFailures, injectedPriorFailure}`).
2. Spawn the producer: `subagent_type = role` (`test-writer` at tests, `executor` at exec),
   model = map(`agents[0].model`), `maxTurns = agents[0].max_turns`, **isolation omitted**.
   Build the prompt from the ProducerContext + the task-worktree instruction
   (`cd $CLAUDE_PLUGIN_DATA/worktrees/<run_id>/<task_id>`; commit there). The test-writer
   commits failing tests first (TDD); the executor commits the minimal implementation.
   Follow `agents/test-writer.md` / `agents/task-executor.md`.
3. Capture the agent's terminal **STATUS** line (`STATUS: DONE` |
   `STATUS: BLOCKED — escalate` | `STATUS: NEEDS_CONTEXT`).
4. Fold it: `factory record-producer --run <run_id> --task <t> --stage <stage> --status "<line>"`.
   Return its `step`. (`done` advances tests→exec / exec→verify; a classified failure
   bumps the rung and resumes at the same producer stage, or drops when the ladder is
   exhausted — all inside the CLI.)

### runVerify (stage verify)

A verify round always reports `spawn-agents` (the panel) and, when an answer key was
withheld, a `sidecar`. Do the holdout FIRST, then the panel + verify-then-fix.

1. **Holdout (only if `env.sidecar` present).** Spawn `general-purpose`, isolation
   `"worktree"`, model = map(`sidecar.model`), `maxTurns = sidecar.max_turns`, with
   `sidecar.prompt` **verbatim** (it already embeds the worktree, the
   `git -C <wt> diff staging` instruction, the withheld criteria, and the strict
   `{criteria:[…]}` JSON shape). Write the agent's raw output to a file as
   `{ "raw": "<output>" }`, then:
   `factory record-holdout --run <run_id> --task <t> --input <file>`.
2. **Panel.** Spawn all six reviewers (`manifest.agents`, each isolation `"worktree"`,
   model = map(model)=opus, `max_turns` from the manifest) — roles:
   `implementation-reviewer, quality-reviewer, architecture-reviewer, security-reviewer,
silent-failure-hunter, type-design-reviewer`. The manifest `prompt_ref`
   (`reviews/prompts/<role>.md`) is a placeholder — **you** construct each reviewer prompt
   per `skills/review-protocol/SKILL.md`: tell it to inspect via
   `git -C <taskWorktree> diff staging` and to emit a single RawReview JSON object:

   ```json
   { "reviewer": "<role>", "verdict": "approve|blocked|error",
     "findings": [ { "reviewer":"<role>", "severity":"info|warning|error|critical",
       "blocking": true|false, "file":"<path>", "line": <n>,
       "quote":"<verbatim code>", "description":"<concern>" } ] }
   ```

   `file`/`line` are optional but a finding without both is uncitable (dropped by the CLI);
   `quote` is REQUIRED. `findings` may be empty for an `approve`.

3. **Verify-then-fix (D27).** For EACH finding that is `blocking:true` AND citable (has both
   `file` and `line`), spawn an INDEPENDENT finding-verifier (`general-purpose`, isolation
   `"worktree"`, model `opus`, adversarial framing — _"try to refute this finding against
   the actual code"_). It returns `{ holds: true|false, note: "<why>" }` (`holds:true` =
   the finding is confirmed real). Inspect via `git -C <taskWorktree> diff staging`.
4. **Fold.** Write the record-reviews input file:

   ```json
   { "reviews": [ <each raw reviewer JSON>, … ],
     "verifications": [ { "reviewer":"<role>",
       "verdicts": [ { "file":"<f>", "line":<n>, "holds":true|false, "note":"<n>" }, … ] }, … ],
     "crossVendorAbsent": { "reason": "no second-vendor reviewer configured" } }
   ```

   Include one `verifications` verdict for every blocking + citable finding you verified
   (a kept citable blocker with no recorded verdict makes the CLI fail closed). Add
   `crossVendorAbsent` only when no cross-vendor reviewer ran (Δ U — recorded loudly).
   Then: `factory record-reviews --run <run_id> --task <t> --input <file>`.

5. Return its `step`. On `{done:false, stage:"ship"}` the floor passed → next iteration
   ships. On `{done:false, stage:"exec"}` the floor blocked → the CLI bumped the rung and
   cleared reviewers; the next verify round re-spawns a fresh panel. On `{done:true,…}` the
   ladder dropped the task — report it.

   Never re-call `factory run-task --stage verify` to "check the floor" — `record-reviews`
   already derived and acted on it.

## Phase 4 — Completion

When the run loop breaks (run terminal or all tasks terminal):

1. `factory state <run_id> --summary` — report per-task outcome (done / dropped + class +
   PR number) and the run status (`completed | partial | failed`).
2. **Not yet wired (WS12):** there is no `finalize` subcommand, so the staging→develop
   rollup PR, the run-level finalize, and the per-failed-task GitHub issue are NOT created
   automatically. State this plainly to the user; do not fake a rollup. `main` is never
   touched. Scribe/docs generation is likewise deferred (WS12).
3. If the run is `paused`/`suspended` (quota), tell the user to re-run `factory run resume`
   once the window resets.

---

## Failure handling

- A **dropped** task is terminal and classified (`capability-budget` | `spec-defect` |
  `blocked-environmental`). Move on to the next ready task; do not retry by hand — the
  CLI's ladder already exhausted its bounded retries.
- A **LOUD CLI error** (non-zero exit + stderr) is a real defect, not a transient. Read the
  message. Common causes: calling `record-reviews` before `record-holdout`; a malformed
  agent JSON; run/spec drift. Fix the cause; do not blind-retry.
- A **deadlock** (non-terminal tasks, none ready, none cascade-droppable) is a dependency
  cycle — STOP LOUD (the seeder catches most cycles at `run create`, but surface any that
  reach here).

## When NOT to use this skill

- Questions about CLI internals, a single subcommand, or debugging the TypeScript → regular
  tools, not a pipeline run.
- A docs-only change → spawn `scribe` directly.
- Re-running a finished run → inspect with `factory state`; only `factory run resume`
  re-enters a paused/suspended run.
