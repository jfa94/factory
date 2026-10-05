# Exit Codes

The `factory` CLI and the `factory-hook` dispatcher share one small, frozen
exit-code enum (`src/shared/exit-codes.ts`). The thin entry points
(`src/bin/factory.ts`, `src/bin/factory-hook.ts`) are the only places
`process.exit` is called.

| Code | Name       | Meaning                                                                                                                         |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `OK`       | Success, including every `next-action` result (execute, wait, park, terminal).                                                  |
| `1`  | `ERROR`    | An uncaught error, or a command-specific failure listed below.                                                                  |
| `2`  | `USAGE`    | Unknown subcommand, unknown or bad flag, missing required argument, retired command, or a run driven from the wrong repository. |
| `3`  | `CONFLICT` | Defined in the enum; no v2 command returns it.                                                                                  |

## Command-specific `ERROR` results

| Command                      | Returns `ERROR` when                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `factory spec <action>`      | The envelope is `unspecifiable` or `spec-defect` (regeneration exhausted). |
| `factory autonomy status`    | The session is not autonomous.                                             |
| `factory autonomy preflight` | The session is not autonomous (the relaunch command is printed).           |

## How a subcommand maps to a code

Each subcommand wraps its work: a `UsageError` returns `USAGE`; any other thrown
error propagates and the entry maps it to `ERROR`; a clean run returns `OK`.
A parked or failed run is a normal outcome that the runner reads from the JSON
action; the CLI still exits `OK` for the act of reporting it.

There is no human-escalation exit code. A run that needs a person parks with a
reason and is resumed with `factory resume`.
