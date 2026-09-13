# Factory v2 CLI

Commands operate on an explicit run ID. The session runner, not the CLI, spawns
agents. Every next-action result is one of execute, wait, park or terminal.

| Command                                                              | Purpose                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `factory spec resolve --issue <n>`                                   | Fetch fresh PRD/base/contracts and start bounded generation   |
| `factory spec gate --issue <n>`                                      | Validate generated JSON, requirements and execution graph     |
| `factory spec store --issue <n>`                                     | Adjudicate review and persist the v2 feature spec             |
| `factory run create --issue <n>`                                     | Create a fresh sequential feature run                         |
| `factory next-action --run <id> --driver <session>`                  | Consume staged results, advance, or return the outstanding attempt |
| `factory run stop --run <id>`                                        | Explicitly park without discarding work                       |
| `factory resume --run <id> [--answer <text>] [--recover]`            | Resume; recover only after the previous agent stopped         |
| `factory run cancel --run <id>`                                      | Cancel while retaining artifacts and Git work                 |
| `factory state --run <id> [--ledger]`                                | Inspect state or its audit ledger                             |
| `factory state --list`                                               | List v2 runs                                                  |
| `factory debug create --base <ref>`                                  | Review/repair a clean committed diff, ending ready for review |
| `factory scaffold [--provision]`                                     | Prepare committed gates and stable branch protection          |
| `factory statusline`                                                 | Capture piped rate limits and display feature progress        |

Creation accepts `--repo owner/name`, `--run-id`, `--no-ship`, `--e2e` and
`--ignore-quota`. Ship intent and quota policy persist for the run. Debug accepts
an explicit base, repository, run ID and quota override; it never auto-merges.

Run creation emits the run object directly, including `run_id`. Execute envelopes
contain `attempt` and `prompt`. Submit the exact result schema in that prompt.
Wait includes `retry_after_seconds`; park includes the persisted reason. Terminal
reports completed, ready-for-review or cancelled, with delivery metadata.

Unknown flags fail loudly. Imported specs, supersede, task-level writers, rescue
scan/apply, score and miss are retired. Use state and explicit resume; do not
interpret v1 artifacts as v2 state. `next-task` is only an alias for next-action
and requires the same driver identity.

Statusline retains its stdin/display protocol; it is not a state-report command.
It writes the usage cache consumed by quota pacing.

The authoritative dispatch protocol is
[the runner skill](../../skills/pipeline-runner/SKILL.md).

Scaffold renders PR triggers and manual mutation checkouts from `git.baseBranch`.
Mutation runs for every feature PR targeting that branch. Playwright configs and
example tests are seeded only when the target declares `@playwright/test`, so
ordinary scaffolding does not introduce unresolved imports. Existing project-owned
files remain untouched when that dependency is absent. `scaffold --provision`
creates or strengthens stable strict protection; runs never downgrade it.

PRD extraction preserves wrapped list items and `R1.`-style requirements through
the next item, paragraph or heading. Fenced examples are excluded from extraction.
The complete PRD remains visible to generation, review and acceptance.
