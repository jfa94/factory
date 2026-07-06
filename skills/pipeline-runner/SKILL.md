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
  unspecifiable → STOP LOUD (exit 1; zero agent cost). Surface env.blockers to the
      user verbatim — the PRD needs editing before the factory can spec it. Spawn NOTHING.
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
factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new] [--supersede | --resume] [--no-ship] [--ignore-quota] [--approve-spec] --session-id "$CLAUDE_CODE_SESSION_ID"
```

`--repo` is OPTIONAL — auto-derived from the `origin` remote of the current checkout (pass it only
to override; an explicit value that disagrees with the remote fails loud). Forward the invoking
command's `--no-ship`/`--ignore-quota` flags verbatim (default — no flag: live); the resolved
`ship_mode` persists on the run and is read back by resume + finalize, so it is never re-marshaled. Always pass `--session-id "$CLAUDE_CODE_SESSION_ID"` — this stamps THIS
runner session as the run's `owner_session`, so the Stop gate resolves only the owning
session's run and never acts on a _different_ session's run (Prompt J). The shell expands
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

**`--approve-spec` (S9, Decision 47).** Forward the invoking command's flag verbatim. When set,
creation completes in full (staging cut, tasks seeded) and the run is then parked — `suspended`
with NO quota checkpoint — before any envelope reaches the loop; the `created`/`superseded`
envelope carries `spec_approval: {spec_path, note}`. **STOP there**: report `spec_path` and tell
the user to review the spec and run `/factory:resume` (resume IS the sign-off). Do NOT call
`next-task` on a parked run — its quota-gate step clears suspensions and would silently un-park.
Runners are otherwise unchanged.

**Autonomy gate:** `run create` HALTS loud (`NotAutonomousError`, non-zero exit) if the runner
session is not autonomous (`FACTORY_AUTONOMOUS_MODE=1`). This is the deterministic engine refusing to
start an unattended pipeline in an interactive session — not a transient error. Surface the relaunch
instruction (Phase 0 step 2); never retry blindly.

**Enter the orchestrator worktree (Decision 2).** `run create` already materialised the run's
staging branch in a dedicated worktree at `.claude/worktrees/orchestrator-<run_id>` — the engine
NEVER checks staging out in the user's primary checkout (doing so parked the main dir on staging and
later phase-merge checkouts collided with `already used by worktree` — smoke defect D2). `cd` into it
now, before the loop, so subagent `baseRef:"head"` worktrees fork from the staging tip and every
foreground `factory` call runs isolated from the user's checkout:

```bash
ORCH="$(git rev-parse --show-toplevel)/.claude/worktrees/orchestrator-<run_id>"   # <run_id> = .run.run_id
cd "$ORCH"
```

Run all of Phase 3+ (every `factory` call and every `Agent` spawn) from `$ORCH`. **On resume**
(`/factory:resume`), re-derive `$ORCH` and `cd` in before the loop; if it was pruned between sessions
recreate it idempotently from the run's already-existing staging branch:
`[ -d "$ORCH" ] || git worktree add "$ORCH" "$(factory state <run_id> | jq -r .staging_branch)"`.
**Teardown** (best-effort, at the run's terminal report): `cd "$(git rev-parse --show-toplevel)"` then
`git worktree remove --force "$ORCH"`. Leaving it is harmless (each run's dir is unique — no collision),
so teardown is a nicety, not correctness.

## Phase 3 — THE LOOP (parallel event loop)

The ship mode is persisted on the run (Phase 2's `run create`); `next-task`, `next-action`, and `finalize` all
read it from state — never re-pass it and never choose it yourself.

**You are the multiplexer.** Background subagents cannot spawn agents, so the main
session drives everything: ALL `factory` CLI calls run FOREGROUND in this session,
one at a time (never a background Bash) — that yields one-driver-per-task by
construction. ONLY `Agent()` spawns run in the background (`run_in_background: true`).

**The in-flight table.** Track `task_id → { result_key, wave, agent task-ids }` for
every task you are currently driving. It is a rebuildable cache held in conversation
context ONLY — the state file is truth. Never persist it anywhere (not to disk, not
to results files).

```
REFILL (run at loop entry and after every completion):
  env = factory next-task --run <run_id>                       # foreground
  case env.kind:
    "done"      → go to Phase 4 (report)
    "finalize"  → factory run finalize --run <run_id>; if the finalized run's
                  status is "failed", run factory recover --auto --run <run_id>
                  ONCE (the bounded self-heal, S10/Decision 48):
                    kind "recovered" → REFILL (back to the top of THE LOOP)
                    kind "page"      → report its reason/dead_ends/hints, go to Phase 4
                  otherwise go to Phase 4
    "e2e"       → run the E2E STAGE (below); on done/failed/reopen, REFILL; on suspend,
                  report the reason + STOP (run is suspended — /factory:resume retries)
    "e2e-assessment" → run the E2E-ASSESSMENT STAGE (below); on done/failed, REFILL
                  (failed sweeps every task — next-task routes to finalize)
    "traceability" → run the TRACEABILITY STAGE (below); on done/failed, REFILL
                  (failed = run condemned OR crash-at-cap — next-task routes to
                  finalize, docs skipped); on suspend, report the reason + STOP
                  (run is suspended — /factory:resume retries)
    "document"  → run the DOCS STAGE (below); on done, REFILL; on suspend,
                  report the reason + STOP (run is suspended — /factory:resume retries)
    "pause"     → PAUSE CONVERGENCE (below)
    "work"      → for each task in env.ready (order preserved — in-flight tasks are
                  listed first) that is NOT already in the table, while the table has
                  fewer than env.max_parallel tasks:
                    tenv = factory next-action --run <run_id> --task <task>   # foreground
                    case tenv.kind:
                      "spawn" → spawn EVERY entry in tenv.manifest.agents IN THE
                                BACKGROUND (count-agnostic — spawn however many the
                                manifest names, never assume a panel size), per the
                                collection contract + spawn matrix below; add the task
                                to the table with tenv.result_key + the agent ids
                      "done"  → report tenv.outcome (a drop is loud + classified);
                                REFILL again (a terminal task may unblock dependents)
                      "pause" → PAUSE CONVERGENCE
                  then WAIT: end the turn. Background agent completions re-invoke
                  you — never poll, never sleep.

ON AGENT COMPLETION (a background agent finishes):
  Collect its output (TaskOutput) and mark it in the table.
  Reviews wave only: when ALL sidecar+panel agents are in, spawn the finding-verifiers
    (background, one per blocking+citable finding — the verify-then-fix contract below)
    as the same wave's second stage; wait for those too.
  When ALL results of the task's current wave are in:
    write the results file (per the collection contract), then
    tenv = factory next-action --run <run_id> --task <task> --results <file>   # foreground
    case tenv.kind:
      "spawn" → next wave: spawn every manifest agent in the background; update the
                table with the new result_key + agent ids
      "done"  → remove the task from the table; report tenv.outcome
      "pause" → PAUSE CONVERGENCE
    then REFILL (a finished task may unblock dependents or free a slot).

PAUSE CONVERGENCE (any kind:"pause", whether from next-task or next-action):
  Hard stop. Spawn NOTHING new. TaskStop every in-flight agent in the table (safe:
  the quota gate precedes recordResults, and the spawn_in_flight reset makes abandoned
  spawns resume-clean). Then:
    scope "unavailable" → run `factory resume` ONCE (this turn's own traffic refreshes
        the usage cache): "resumed" → clear the table and REFILL; anything else →
        report + STOP.
    any other scope → report scope/reason/resets_at_epoch; tell the user to re-run
        `/factory:resume` after the window resets; STOP.
```

If `next-action` rejects `--results` as stale/duplicate (result_key mismatch), re-invoke WITHOUT `--results` to get the current envelope and continue — the ONE sanctioned retry (Iron Law 3 applies to everything else).

**Never "help" with merges.** Parallel tasks racing into the same staging branch is
the engine's problem, already bounded engine-side (MergeSerializer + the BEHIND
refusal + `MERGE_RESYNC_CAP`). Never resolve a conflict, rebase a task branch, or
retry a merge yourself — a merge failure surfaces through the envelopes like any
other outcome.

**Run-level stages never overlap tasks.** `finalize`/`e2e`/`e2e-assessment`/`traceability`/`document`/`done`
only emit when the table is empty (the engine emits them only with no drivable task
work). Drive them foreground exactly as written in their stage blocks. If one ever
arrives while the table is non-empty, that is an engine defect — STOP LOUD (Iron Law 3).

**Compaction / context-loss recovery.** Never guess. The table is a cache — rebuild
it: `next-task` re-derives the ready set (in-flight tasks listed first); for each
in-flight task, `next-action` WITHOUT `--results` idempotently re-emits the current
manifest. Before re-spawning, check `TaskList` for still-running agents this session
owns and re-attach them to the table (never double-spawn a producer into a task
worktree); any manifest agent you cannot account for → re-spawn it per the manifest
(abandoned spawns are resume-clean).

```
e2e stage:
  eenv = factory run e2e --run <run_id>
  loop while eenv.kind == "spawn":
    branch on eenv.expects (BOTH spawns use subagent_type `e2e-author`, model
    per eenv.model, isolation OMITTED — the agent works IN eenv.worktree,
    prompt = eenv.prompt VERBATIM):
    "author-results" → the e2e AUTHOR: explores the live staging app
      (Playwright MCP), authors throwaway journey specs (into
      eenv.throwaway_dir — never committed) and any load-bearing journey
      specs (into eenv.worktree's e2e/ — committed), self-validates green,
      and finishes with its terminal STATUS line plus a manifest joining each
      spec to the task_id(s) it covers.
      Write {"status":"<line>","manifest":[{"task_ids":[...],
      "spec_path":"...","kind":"critical|throwaway","title":"..."}, ...]} to
      a results file under $CLAUDE_PLUGIN_DATA/results/<run_id>/.
      (If the author died/was skipped, write {"status":"e2e-author agent
      skipped or died (no STATUS line)","manifest":[]} — a status containing
      none of BLOCKED/ESCALATE/NEEDS/DONE, so the engine spends its one
      author retry instead of failing on a phantom deliberate verdict.)
    "adjudication-results" → the e2e ADJUDICATOR (Decision 40 D7): rules each
      pre-existing failing spec regression vs intentional-change, rewrites
      the pre-authorized/ruled-intentional ones in eenv.worktree and commits.
      Write {"status":"<line>","verdicts":[{"spec_path":"...",
      "verdict":"regression|intentional-change","reason":"...",
      "citation":"..."}, ...]} to a results file.
      (If it died/was skipped, write {"status":"e2e adjudicator agent skipped
      or died (no STATUS line)","verdicts":[]} — same retryable-wording rule.)
    eenv = factory run e2e --run <run_id> --results <file>   # may re-spawn (D5 retry / D7 adjudication)
  case eenv.kind:
    "done"    → loop  # phase concluded clean (0 critical red; a residual throwaway
                       #   red is folded into the report as an advisory, not a stop)
    "failed"  → loop  # phase concluded FAILED (unmappable/cap-exhausted critical red) —
                       #   run.status is NOT flipped here; next-task routes straight to
                       #   finalize next, which reads e2e_phase into the report
    "reopen"  → loop  # a failing journey was joined to its task via the author's
                       #   manifest; that task was reset to pending with e2e_feedback
                       #   set — next iteration re-drives it as "work"
    "suspend" → report eenv.reason; STOP  # no boot config (assessment resolved none
                                           #   and no override set); /factory:resume retries

e2e-assessment stage (Decision 40 — once per --e2e run, BEFORE any task):
  aenv = factory run e2e-assess --run <run_id>
  loop while aenv.kind == "spawn":
    spawn the e2e assessor (subagent_type `e2e-assessor`, model per aenv.model,
    isolation OMITTED — it works IN aenv.worktree), prompt = aenv.prompt VERBATIM.
    It checks/authors the repo's e2e machinery (boot config in playwright.config.ts,
    seed/auth support), validates by booting, and forecasts which committed specs
    this run's tasks touch. Write its structured verdict {"status":"ok|degraded|
    boot-impossible|machinery-impossible","reason":?,"warning":?,"resolved":?,
    "affected_specs":[...]} to a results file under $CLAUDE_PLUGIN_DATA/results/<run_id>/.
    (If the assessor died/was skipped, write {"status":"error","reason":"..."} — the
    engine spends its one retry on it.)
    aenv = factory run e2e-assess --run <run_id> --results <file>   # may re-spawn once
  case aenv.kind: "done"|"failed" → loop  # failed = run condemned; next-task → finalize

traceability stage (S9, Decision 47 — once per non-debug run, after e2e, before docs):
  trenv = factory run traceability --run <run_id>
  case trenv.kind:
    "spawn"   → spawn the traceability auditor (subagent_type `traceability-auditor`,
                model per trenv.model, isolation OMITTED — it works IN trenv.worktree,
                a DETACHED read-only checkout), prompt = trenv.prompt VERBATIM.
                Write its JSON verdict object {"status":"<line>","verdicts":[{"index":n,
                "verdict":"met|partial|unmet","evidence":"..."}, ...]} to a results file
                under $CLAUDE_PLUGIN_DATA/results/<run_id>/.
                (If the auditor died/was skipped, write {"status":"traceability-auditor
                agent skipped or died (no STATUS line)","verdicts":[]} — the engine
                spends its one retry on it.)
                trenv2 = factory run traceability --run <run_id> --results <file>
                case trenv2.kind:
                  "done"    → loop  # audit clean (partial rows surface in the report)
                  "failed"  → loop  # unmet verdict or crash-at-cap — run condemned;
                                    #   next-task routes to finalize, docs skipped
                  "suspend" → report trenv2.reason; STOP  # pre-cap crash; /factory:resume retries
    "done"|"failed" → loop          # idempotent: already concluded
    "suspend" → report trenv.reason; STOP

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

Write results files under `$CLAUDE_PLUGIN_DATA/results/<run_id>/` (create the dir). NEVER write under `runs/**` or `specs/**` — the plugin's own TCB hooks deny those writes; `next-action --results` reads from any path. Every spawn envelope names `expects`:

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

**`expects: "reviews"`** (stage verify — the review panel, plus sidecar):

1. **Sidecar (if `tenv.sidecar` present):** spawn `general-purpose`, isolation
   `"worktree"`, model mapped from `sidecar.model`, `maxTurns = sidecar.max_turns`,
   prompt = `sidecar.prompt` VERBATIM — in the background, alongside the panel.
   Keep its raw output.
2. **Panel:** spawn EVERY entry in `manifest.agents` (count-agnostic — the engine appends the
   content-conditional `database-design-reviewer` when the task diff touches migration/schema
   files, Decision 50; each isolation `"worktree"`, model mapped from each agent's `model`,
   `max_turns` from the manifest). Construct each prompt per
   `skills/review-protocol/SKILL.md`: inspect via `git -C <tenv.worktree> diff <tenv.base_ref>`,
   emit ONE RawReview JSON:
   `{ "reviewer":"<role>", "verdict":"approve|blocked|error", "findings":[ { "reviewer","severity","blocking","file","line","quote","claim","description" } ] }`
   (`quote` and `claim` REQUIRED — `claim` is the one-sentence checkable assertion, ≤300
   chars; `file`+`line` make a finding citable; `findings` may be empty.)

    **Cross-vendor quality-reviewer (Δ U/S5).** The manifest carries the engine's
    resolved `cross_vendor` stamp; it decides how the `quality-reviewer` entry runs:
    - `cross_vendor.status == "present"` → do NOT spawn the Claude quality-reviewer.
      Run it via Bash instead:
      `codex exec --model <cross_vendor.model> --sandbox read-only --cd <tenv.worktree> "<prompt>"`
      where `<prompt>` = the `agents/quality-reviewer.md` charter body + the
      `skills/review-protocol/SKILL.md` contract + the SAME diff-scope context the
      Claude spawn would get (`git diff <tenv.base_ref>`, task title/criteria).
      Parse the RawReview JSON from stdout (last JSON object). On rc≠0, unparseable
      output, or a wrong-shape verdict: FALL BACK to spawning the Claude
      quality-reviewer as normal AND set
      `crossVendorAbsent: { "reason": "codex execution failed: <rc/parse detail>" }`
      in the results file — the fallback ran same-vendor, and that must stay loud.
    - `cross_vendor.status == "absent"` → spawn the Claude quality-reviewer as
      normal and copy the stamp's `reason` VERBATIM into `crossVendorAbsent`.
    - stamp missing (older engine) → treat as absent with reason
      `"no cross-vendor stamp on manifest"`.

3. **Verify-then-fix:** for EACH finding that is `blocking:true` AND citable, spawn an
   INDEPENDENT finding-verifier (`general-purpose`, isolation `"worktree"`, model
   `opus`, adversarial framing — _"try to refute this finding against the actual
   code"_, inspecting via `git -C <tenv.worktree> diff <tenv.base_ref>`). Its prompt
   interpolates ONLY `{reviewer, severity, claim, file, line, quote}` — NEVER the
   finding's `description` (anti-anchoring: the verifier must judge the bare claim
   against the code, not be led by the reviewer's reasoning chain). It returns
   `{ "holds": true|false, "note": "<why>" }`.
4. Results file:
    ```json
    { "result_key": <tenv.result_key verbatim>,
      "holdout": { "raw": "<sidecar agent raw output>" },
      "reviews": {
        "reviews": [ <each RawReview JSON> ],
        "verifications": [ { "reviewer":"<role>", "verdicts":[ {"file","line","holds","note"} ] } ],
        "crossVendorAbsent": { "reason": "<the manifest stamp's reason, or the codex runtime-failure detail>" } } }
    ```
    Omit `"holdout"` when there was no sidecar. Include one verdict for every
    blocking+citable finding (the CLI fails closed on a missing one). Include
    `crossVendorAbsent` ONLY when no cross-vendor reviewer actually ran (stamp
    absent, or the `codex exec` fallback fired) — never invent the reason: echo
    the stamp's reason or the runtime-failure detail exactly.

### Agent spawn matrix

| Agent                                | `subagent_type`                    | isolation                                   |
| ------------------------------------ | ---------------------------------- | ------------------------------------------- |
| test-writer                          | `test-writer`                      | **none** (omit) — works IN `tenv.worktree`  |
| implementer                          | `implementer`                      | **none** (omit) — works IN `tenv.worktree`  |
| panel reviewers                      | the manifest `role`                | `"worktree"`                                |
| holdout-validator / finding-verifier | `general-purpose`                  | `"worktree"`                                |
| spec-generator / spec-reviewer       | `spec-generator` / `spec-reviewer` | `"worktree"`                                |
| e2e-author                           | `e2e-author`                       | **none** (omit) — works IN `eenv.worktree`  |
| e2e-assessor                         | `e2e-assessor`                     | **none** (omit) — works IN `aenv.worktree`  |
| traceability-auditor                 | `traceability-auditor`             | **none** (omit) — works IN `trenv.worktree` |

Model alias mapping: manifest model id contains `haiku` → `haiku`; `sonnet` →
`sonnet`; otherwise → `opus`. The manifest `effort` (when present) is passed to the
spawn **verbatim** — its values (`xhigh`/`max`) already match the spawn `effort` enum,
so no aliasing applies; it appears only on producer spawns, never reviewers.

## Phase 4 — Report

- A `pause` stop is NOT a quality outcome — never finalize it; report the
  reset horizon and stop (resume re-enters Phase 3 via `factory resume`, which
  clears a recovered checkpoint, then THE LOOP).
- After `run finalize`: `factory score --run <run_id>` +
  `factory state <run_id> --summary`. Surface the run
  status (`completed | failed`), the rollup PR, filed issues, and every
  drop with its class — plainly, never papered over. If the self-heal paged
  (`factory recover --auto` returned `kind:"page"`), include its reason + hints.
- Documentation is no longer a Phase-4 step: the engine runs it as the
  `document` stage in THE LOOP (Phase 3), before finalize ships the rollup.
  On an `--e2e` run, the e2e stage runs before docs (Decision 39) — a failed
  e2e phase skips docs entirely (don't document code the e2e verdict just
  condemned) and is reported alongside the rollup, not as a separate step.
  The PRD-traceability audit (S9, Decision 47) sits between e2e and docs on
  every non-debug run — a failed audit likewise skips docs and blocks the
  rollup (unmet PRD requirements surface in the report + PRD comment).

## When NOT to use this skill

- CLI/internal questions or debugging → regular tools.
- Docs-only change → spawn `scribe` directly.
- A finished run → `factory state`; only a paused/suspended run resumes.
