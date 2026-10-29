# Factory v2 CLI

The `factory` binary (`dist/factory.js`) is the deterministic engine. It owns every
state transition and never spawns an agent; the session runner
([pipeline-runner skill](../../skills/pipeline-runner/SKILL.md)) dispatches the
agents it names. Commands print one JSON document on stdout unless noted.
Exit codes are listed in [exit-codes.md](./exit-codes.md).

## Commands

| Command                                                                          | Purpose                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `factory spec resolve --issue <n> [--supersede] [--ignore-quota]`                | Reuse the stored spec for the issue, or fetch the PRD and emit the generate spawn. |
| `factory spec gate --issue <n>`                                                  | Run the deterministic spec gates; emit revise blockers or the review spawn.        |
| `factory spec store --issue <n>`                                                 | Adjudicate the review; emit revise or persist the v2 feature spec.                 |
| `factory run create --issue <n> [--no-ship \| --local] [--e2e] [--ignore-quota]` | Create a fresh sequential feature run from the stored spec.                        |
| `factory next-action --run <id> --driver <session>`                              | Consume staged results, advance, or return the outstanding attempt.                |
| `factory next-task --run <id> --driver <session>`                                | Alias of `next-action`.                                                            |
| `factory run stop --run <id>`                                                    | Park the run explicitly (`operator`) without discarding work.                      |
| `factory resume --run <id> [--answer <text>] [--recover] [--ship live\|no-ship]` | Resume a parked run.                                                               |
| `factory run cancel --run <id>`                                                  | Cancel, retaining artifacts and Git work.                                          |
| `factory state --run <id> [--ledger]`                                            | Print run state as JSON, or the Markdown audit ledger.                             |
| `factory state --list`                                                           | List readable v2 runs.                                                             |
| `factory debug create --base <ref> [--ignore-quota]`                             | Review and repair a clean committed diff; ends ready for review.                   |
| `factory scaffold [--provision] [--waive mutation\|coverage] [--force-managed]`  | Write the gate contract and managed workflows; check branch protection.            |
| `factory configure [--get <k> \| --set <k=v>... \| --unset <k>...]`              | Inspect or edit the global config overlay.                                         |
| `factory config-defaults`                                                        | Print the resolved config (defaults plus `config.json`).                           |
| `factory autonomy ensure \| status [--json] \| preflight`                        | Build the autonomous relaunch command or report autonomous mode.                   |
| `factory statusline`                                                             | Statusline writer: caches piped rate limits and shows feature progress.            |

`spec`, `run create`, `debug create` and `scaffold` accept `--repo <owner/name>`.
It defaults to the `origin` remote; a mismatch with the remote fails.
`run create` and `debug create` accept `--run-id <id>`; otherwise a UUID is used.

Unknown flags fail with a usage error. `rescue`, `reconcile`, `score` and `miss`
remain registered only to fail with "retired for v2".

## Base branch resolution

`run create`, `debug create`, `spec resolve` and `scaffold` resolve the base branch
the same way (`resolveBaseBranch`, `src/git/base-branch.ts`):

1. `git.baseBranch`, when set. It must exist on `origin`, otherwise the command fails.
2. Otherwise `develop`, if `origin` has it.
3. Otherwise `origin`'s default (HEAD) branch.

The resolved name is recorded on the run and is never written back to config.

## `spec`

`resolve` reuses an existing spec for the issue unless `--supersede` is given.
Generation is bounded by `spec.maxRegenIterations`; exceeding it is a terminal
spec defect (exit 1). Resolve is quota-gated; `--ignore-quota` overrides.
Scratch files live in the target repo under
`.claude/worktrees/spec-build/<repo-key>/<issue>/`. Stored specs live under
`<dataDir>/v2/specs/<repo-key>/<spec-id>/`.

### Spec envelopes

`resolve`, `gate` and `store` each print one envelope. The `generate`, `revise`
and `review` kinds carry a `spawn` object:

| Field        | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `role`       | `spec-generator` (generate, revise) or `spec-reviewer` (review).     |
| `agent_type` | Agent to dispatch.                                                   |
| `model`      | Pinned model.                                                        |
| `effort`     | Pinned effort.                                                       |
| `brief_path` | `<role>.brief.md` in the scratch dir: context JSON and result rules. |
| `prompt`     | Two-line prompt naming the brief; the runner pastes it verbatim.     |

`spawn` carries no context; the brief holds it. Before emitting the envelope
the engine writes the brief and deletes any stale result file. The agent writes
its own JSON result: `generated_path` (`generated.json`) for generate and revise,
`verdict_path` (`verdict.json`) for review. The runner never copies results.

A missing `generated.json` at `gate` yields a `revise` envelope; a missing
`verdict.json` at `store` re-emits `review`. Each consumes one iteration of
`spec.maxRegenIterations`, the same counter invalid output and blocked reviews use.

PRD extraction preserves wrapped list items and `R1.`-style requirements through
the next item, paragraph or heading. Fenced examples are excluded from extraction.
The complete PRD remains visible to generation, review and acceptance.

## `run create`

Requires a stored spec for the issue. Creation fails when the live PRD, the base
commit or the repository contracts differ from the spec snapshot, and when
preflight fails (missing gate contract, or base-branch protection that does not
satisfy the required checks). It prints the created run, including `run_id`.

| Flag             | Effect                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| (none)           | Ship mode `live`: open the PR and complete only after an observed merge. Base `main`: end `ready-for-review` (never merged). |
| `--no-ship`      | End `ready-for-review` with an open PR.                                   |
| `--local`        | Park as `authorization` after full verification, before any remote write. |
| `--e2e`          | Add the `e2e-author` stage and Playwright evidence at feature-check.      |
| `--ignore-quota` | Skip quota waits for this run.                                            |

`--no-ship` and `--local` are mutually exclusive. Ship mode and quota policy
persist on the run. One active feature run is allowed per repository.

## `next-action`

Must run from the repository the run was created in, otherwise it fails with a
usage error. When `CLAUDE_CODE_SESSION_ID` (or `CLAUDE_SESSION_ID`) is set, the
session becomes the run's owner. It returns exactly one action; every action
also carries `run_id`:

| `kind`     | Fields                                                      | Meaning                                                                  |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `execute`  | `run_id`, `attempt`, `staged`, `prompts`, optional `models` | Dispatch one agent per role.                                             |
| `wait`     | `reason`, `retry_after_seconds`                             | Call again after the delay (quota, CI, transient failure, live attempt). |
| `park`     | `reason`                                                    | Stop; a human resumes with `factory resume`.                             |
| `terminal` | `status`, `delivery`                                        | `completed`, `ready-for-review` or `cancelled`.                          |

In an `execute` action, `prompts[role]` is a two-line prompt naming the role's
brief file (`<dataDir>/staged-v2/<run>/<attempt>/<role>.brief.md`), and
`staged[role]` is the path the runner writes that agent's reply to verbatim. The
next call consumes every staged file. A result that fails validation is renamed to
`<role>.rejected-<n>.json` and the role is re-issued with the reason. A role is
re-issued at most twice before the run parks; see [state-model.md](./state-model.md#result-validation).

`models[role]`, when present, is the Agent `model` to dispatch that role on
(`opus`). It is set only for the producer of a scope's final repair pass and
mirrors `attempt.models`; when absent, the runner omits `model`.

Submitting the accepted acceptance result pushes and opens the PR in the same call.

## `resume`

Must run from the run's repository, like `next-action`.

| Flag                   | Effect                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--answer <text>`      | Answer the pending question (a `context` park, or a `spec` park from a blocked spec repair). Required while one is pending. |
| `--recover`            | After the previous agent stopped: consume a complete staged result, redispatch missing panel roles, or retire the attempt.  |
| `--ship live\|no-ship` | Authorize delivery of a `--local` run parked for `authorization`.                                                           |

A parked run never resumes on its own; elapsed time and recovered quota do not
unpark it.

## `debug create`

Requires a clean working tree and a non-empty committed diff `<base>...HEAD`. It
creates a single TDD-exempt task covering the changed files, uses ship mode
`no-ship`, and never auto-merges.

## `scaffold`

| Flag                         | Effect                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `--provision`                | Create or strengthen strict protection on the base branch (external write).   |
| `--waive mutation\|coverage` | Record the gate as waived in a new gate contract instead of refusing.         |
| `--force-managed`            | Re-adopt customized managed files. Never deletes a customized stale workflow. |

Scaffold renders the PR trigger and the manual mutation checkout from the resolved
base branch. Mutation runs on every PR targeting that branch. Playwright configs
and example tests are seeded only when the target declares `@playwright/test`.
Protection is never downgraded. See [Scaffold a repo](../guides/scaffold-a-repo.md).

## `configure`

Values parse as JSON when possible, otherwise as a bare string. `--get` cannot be
combined with `--set` or `--unset`. Keys are listed in
[configuration.md](./configuration.md).

## `autonomy`

| Action      | Behaviour                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `ensure`    | Print the relaunch command with autonomous settings passed inline as one `--settings` argument. |
| `status`    | Exit 0 when `FACTORY_AUTONOMOUS_MODE=1`, else 1. `--json` for machine output.                   |
| `preflight` | Exit 0 when autonomous; otherwise print the relaunch command and exit 1.                        |

The relaunch command is `caffeinate -di claude --settings '<json>'` on macOS and
`claude --settings '<json>'` elsewhere. The inline settings `env` sets
`FACTORY_AUTONOMOUS_MODE`, `CLAUDE_PLUGIN_DATA` and `FACTORY_DATA_DIR` (see
[data dir](./configuration.md#data-dir-claude_plugin_data)).

`ensure` and `preflight` accept `--user-settings <path>`. The v2 `run create` and
`resume` paths do not check autonomous mode; it is read by the branch-protection
and write-protection hooks.

## `statusline`

Reads Claude Code's statusline JSON on stdin, writes the usage cache that quota
pacing reads, and displays feature progress. It is not a state-report command.
