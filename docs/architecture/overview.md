# Architecture Overview

This document describes the system context and the container-level structure of
the Dark Factory plugin. For the building blocks inside each container, see
[components.md](./components.md).

## System context

The factory sits between a person's PRD issue and a target GitHub repository. The
person writes requirements; the factory delivers merged pull requests on an
integration branch. It never touches `main` — promotion to `main` is human-owned
and out of scope.

```mermaid
graph LR
  Author([Author]) -->|writes PRD issue| GH[(GitHub repo)]
  Author -->|/factory:run| CC[Claude Code session]
  CC -->|reads PRD, opens PRs/issues| GH
  CC -->|persists run/spec state| Data[("$CLAUDE_PLUGIN_DATA")]
  GH -->|staging/&lt;run-id&gt; → develop rollup| GH
```

The three external dependencies are: the **GitHub repo** (the PRD source and the
PR/issue target, reached via `gh`), the **Claude Code session** (which hosts the
orchestrator and the `Agent` tool), and the **plugin data directory**
(`$CLAUDE_PLUGIN_DATA`), where all run and spec state lives — deliberately
outside the target repo so the holdout answer-key is unreadable from an executor
worktree.

## The Model-A split (container view)

The plugin is two cooperating halves separated by a hard seam. This is the single
most important structural fact about the system.

```mermaid
graph TD
  subgraph Surface["Driver surface (markdown + workflow)"]
    Cmd[commands/*.md]
    Skill[skills/pipeline-orchestrator/SKILL.md]
    Agents[agents/*.md]
    WF[scripts/factory-run-driver.js]
  end

  subgraph Engine["Deterministic engine (TypeScript)"]
    CLI[factory CLI<br/>dist/factory.js<br/>coroutine: next + drive]
    Hook[factory-hook<br/>dist/factory-hook.js]
  end

  Driver["Driver (session loop | --workflow script)"] -->|loads| Skill
  Driver -->|steps: next / drive| CLI
  CLI -->|envelope: spawn manifest / next step| Driver
  Driver -->|Agent spawns| Producers[test-writer / executor]
  Driver -->|Agent spawns| Panel[6-reviewer panel + holdout + verifiers]
  Driver -->|drive --results: folds outcomes| CLI
  CLI -->|reads/writes| State[(run/spec state)]
  Hook -->|deny/allow at tool-use| Driver
```

**The CLI is the brain, and it owns ALL control flow.** `factory <subcommand>`
owns _all_ run-state writes, the spec gates, the deterministic verifier gates,
failure classification, the producer escalation ladder, the risk-invariant review
floor, PR creation — and the pipeline loop itself, exposed through ONE seam, the
**coroutine** (`factory next` + `factory drive`). It is deterministic and tested. It
**never spawns an agent**.

**A driver is the hands.** A thin driver steps the seam: it performs every
`Agent()` spawn the coroutine's manifest names, collects the agents' raw output, and
feeds it back via `factory drive --results`. It never decides a transition,
re-runs a gate, classifies a failure, or writes state by prose. Two interchangeable
drivers exist (selected by `--workflow` on `/factory:run`): the in-session orchestrator
loop (session, the default) and the plugin-shipped Workflow script (`--workflow`).

The CLI is a **reporter + coroutine + writer**, not a runner:

- **The coroutine** — `next` (run-level: the ready set) and `drive` (task-level: run a
  task's deterministic stages, emit a spawn manifest, and via `--results` fold the
  agents' output into ONE state step). This is the only control-flow seam.
- **Reporter** subcommands (`spec`, `score`, `rescue scan`, `state`) emit one JSON
  envelope and write nothing.
- **Writer** subcommands (`spec` store, `rescue apply`, `scaffold`, `configure`,
  `run create`/`finalize`) fold a result or an operator decision into state.

The six retired single-step writers (`run-task`, `advance`, `drop`,
`record-producer`, `record-holdout`, `record-reviews`) collapsed into the coroutine.

Why this split exists, and what it buys, is the subject of
[explanation/model-a.md](../explanation/model-a.md).

## The run lifecycle

A run proceeds through four phases. The CLI provides the deterministic glue — and
the loop itself, behind the coroutine — at each phase; the driver owns only the agent
spawns. The participant below is the driver (the in-session orchestrator loop by
default, or the Workflow script).

```mermaid
sequenceDiagram
  participant O as Driver
  participant CLI as factory CLI (engine + coroutine)
  participant A as Agents

  Note over O,CLI: Phase 0 — Preconditions
  O->>CLI: factory scaffold --repo o/n
  CLI-->>O: CI net + develop protection (or REFUSE)

  Note over O,CLI: Phase 1 — Spec (bounded generate ⇄ review)
  O->>CLI: factory spec resolve/gate/store
  CLI-->>O: envelope: generate | revise | review | stored | reuse
  O->>A: spawn spec-generator / spec-reviewer
  A-->>O: GenerateResult / ReviewVerdict JSON

  Note over O,CLI: Phase 2 — Create
  O->>CLI: factory run create --repo o/n --issue n
  CLI-->>O: RunState (tasks seeded, status running)

  Note over O,CLI: Phase 3 — Drive (run coroutine picks a task, task coroutine advances it)
  loop until all-terminal
    O->>CLI: factory next
    CLI-->>O: NextEnvelope (tasks-ready | all-terminal | quota-blocked)
    loop drive the ready task: preflight→tests→exec→verify→ship
      O->>CLI: factory drive --task <t> [--results <prev>]
      CLI-->>O: DriveEnvelope (spawn manifest | terminal | quota-blocked)
      O->>A: spawn the agents the manifest names
      A-->>O: STATUS line / raw reviews
    end
  end

  Note over O,CLI: Phase 4 — Completion
  O->>CLI: factory run finalize
  CLI-->>O: report + per-drop issues + (on completed) staging/&lt;run-id&gt;→develop rollup, then terminal
  O->>CLI: factory score / state --summary
```

### Per-task stage machine

Each task moves through a closed, ordered set of stages:

```
preflight → tests → exec → verify → ship
```

- **preflight** — set up the task worktree/branch; report-only.
- **tests** — producer stage: the `test-writer` commits failing tests first (TDD).
- **exec** — producer stage: the `task-executor` commits the minimal implementation.
- **verify** — the verifier floor: deterministic gates + holdout validation + the
  six-reviewer panel + verify-then-fix. Derives the floor verdict.
- **ship** — opens the task PR idempotently; in `live` mode serial-merges into the
  run's `staging/<run-id>` branch. The one stage that writes the terminal task status.

The run-level **finalize** step is a _separate_ stage that runs once, after every
task is terminal: it builds the report, files one issue per drop, and — **only when
the whole PRD completed** (Decision 34) — ships the `staging/<run-id> → develop`
rollup (then closes the PRD issue and deletes the per-run branch) before flipping the
run terminal. A `failed` run leaves `develop` untouched and keeps its branch.

## Data flow and state

All state lives under `$CLAUDE_PLUGIN_DATA` in two stores:

- **Durable spec store** — `specs/<repo>/<spec-id>/`, keyed by `(repo,
spec-id)` where `spec-id = "<issue>-<slug>"`. Reused across runs: re-running a
  PRD issue resolves the same spec.
- **Ephemeral run store** — `runs/<run-id>/`, holding `state.json`,
  `audit.jsonl`, `metrics.jsonl`, `report.md`, and the `holdouts/` and
  `reviews/` subdirs.
- **Per-repo current pointer** — a `current/<repo-key>` symlink names the active
  run _for that repo_, so concurrent runs against different repos never collide on
  one global pointer. It is CLI-ergonomics only: the human reporters resolve "the
  current run" from the caller's checkout, and no hook ever reads it. A legacy
  global `runs/current` pointer is still written for repo-less "most recent".
- **Producer worktrees** — `worktrees/<run-id>/<task-id>/`, a sibling of `runs/`.
  Because the path encodes `(run-id, task-id)`, a guard derives a write's run
  ownership straight from its target path rather than from any shared pointer (see
  [explanation/decisions.md](../explanation/decisions.md) Decision 30).

State writes are atomic (write-temp-then-rename) and lock-protected
(`proper-lockfile`). Crucially, **no gate verdict is ever stored** — every
pass/fail is re-derived from ground truth when needed
([explanation/derive-dont-store.md](../explanation/derive-dont-store.md)). The
state schema is in [reference/state-model.md](../reference/state-model.md).

## Build and deployment

The engine is shipped as two checked-in esbuild bundles
(`dist/factory.js`, `dist/factory-hook.js`), fully inlined so they run at a
user's site with no `node_modules`. `npm run verify` (typecheck → lint → test →
build) is the release gate. There is no separate deploy: the plugin _is_ the
checked-in markdown surface plus the two bundles. See
[guides/build-and-verify.md](../guides/build-and-verify.md).

## Where the engine enforces invariants outside the CLI

Some invariants must hold at tool-use time, before any CLI call. These are the
`factory-hook` guards, wired into `hooks/hooks.json`: TCB write-denial, the
holdout-answer-key read guard, the secret-commit guard, branch protection, the
test-writer scope + ship gating guard, and the stop/subagent-stop gates. See
[reference/hooks.md](../reference/hooks.md).
</content>
