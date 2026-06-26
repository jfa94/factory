# Exit Codes

The `factory` CLI and the `factory-hook` dispatcher share one small, frozen
exit-code enum (`src/shared/exit-codes.ts`). The thin entry points
(`src/bin/factory.ts`, `src/bin/factory-hook.ts`) are the only places
`process.exit` is called.

| Code | Name       | Meaning                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `OK`       | Success.                                                                                                                                                                                                                                                                                                                   |
| `1`  | `ERROR`    | Generic failure: an uncaught error, a classified fail, a gate/verify failure.                                                                                                                                                                                                                                              |
| `2`  | `USAGE`    | Usage error: unknown subcommand/hook, bad flags, a missing required argument.                                                                                                                                                                                                                                              |
| `3`  | `CONFLICT` | An active run already exists and no resolution was selected — `factory run` refuses to silently reuse or clobber it (Decision 35: resume / supersede / cancel). Also the **weekly-quota hard stop** (`kind:"pause"`): a 7d-parked run blocks every new-run attempt for its spec unless `--ignore-quota` is passed. |

## Design rules

- **No human-escalation code.** Human-review gates are retired (Decision 5/19).
  There is deliberately no exit-42 / `NEEDS_DISCUSSION` code. A reviewer impasse is
  a classified loud fail, which surfaces as `ERROR` plus a structured report —
  never a special "ask a human" exit status.
- **Fail loud, never silently succeed.** An unknown or unhandled result throws at
  the call site rather than mapping to a silent `OK`. The phase machine maps its
  `StageResult` union onto these codes; an unmapped variant throws.
- **Adding a code is a design change.** The mapping in the phase machine and the
  runners must be updated in lockstep.

## How a subcommand maps to a code

Each subcommand wraps its work: a `UsageError` (bad flags, missing required arg)
returns `USAGE`; any other thrown error propagates and the entry maps it to
`ERROR`; a clean run returns `OK`. A classified fail is a normal, expected outcome
that the runner reads from the JSON envelope — the CLI still exits `OK` for
the _act_ of recording the fail (the failure is in the run outcome, not the CLI
invocation), while an unexpected, unhandled condition exits `ERROR`.
</content>
