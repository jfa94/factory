# How to Configure the Factory

All settings live in one schema with defaults; you override them in a sparse
overlay. Edits round-trip through the schema before they touch disk, so an invalid
value is rejected loudly and never persisted. For every key, type, and default see
the [configuration reference](../reference/configuration.md).

## Inspect the current config

Print the fully resolved config (defaults + your overlay):

```bash
factory configure
```

Read a single value by its dotted key path:

```bash
factory configure --get quality.mutationScoreTarget
factory configure --get git.baseBranch
```

## Change a setting

`--set` takes `key.path=value`, is repeatable, and persists once after validating
all edits. Values parse as JSON when possible (numbers, booleans, arrays),
otherwise as a bare string.

```bash
factory configure --set quality.mutationScoreTarget=85
factory configure --set git.baseBranch=main
factory configure --set 'git.developRequiredStatusChecks=["Quality","Mutation Testing","Security Scan"]'
```

Set several at once:

```bash
factory configure \
  --set quality.mutationScoreTarget=85 \
  --set quality.coverageRegressionTolerancePct=0.25
```

## Revert a setting to its default

`--unset` removes a key from the overlay so it tracks the default again
(repeatable):

```bash
factory configure --unset git.baseBranch
```

Because the overlay is sparse, an unset key automatically picks up any future
change to its default.

## Common adjustments

| Goal                                   | Command                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Pin the base branch                    | `factory configure --set git.baseBranch=main` (must exist on origin)                                                        |
| Return to automatic base resolution    | `factory configure --unset git.baseBranch`                                                                                  |
| Raise the mutation bar                 | `factory configure --set quality.mutationScoreTarget=90`                                                                    |
| Enable the SAST gate                   | `factory configure --set quality.securityCommand="semgrep scan --config auto --error"` (runner must be allowlisted)         |
| Require an extra check on the base     | `factory configure --set 'git.developRequiredStatusChecks=["Quality","Mutation Testing","Security Scan","Database Tests"]'` |
| Give CI build placeholders             | `factory configure --set quality.gateEnv.NEXT_PUBLIC_API_URL=http://localhost:3000`                                         |
| Allow a longer CI wait before parking  | `factory configure --set git.rollupCiWaitMinutes=60`                                                                        |
| Provision worktrees with a custom step | `factory configure --set quality.setupCommand="make deps"`                                                                  |

After changing `git.developRequiredStatusChecks` or `quality.gateEnv`, re-run
`factory scaffold` (with `--provision` for protection) so the repository matches.

## Notes

- `--get` cannot be combined with `--set`/`--unset`.
- Exotic test runners (Go, Ruby, Deno…) are not config: contract the gate's
  `command` in the repo's committed `.factory/gates.json` (written by
  `factory scaffold`, [Decision 46](../explanation/decisions.md#decision-46--the-gate-contract-scaffold-time-applicability-committed-and-enforced)).
  Per-repo extra required checks also belong there (`requiredChecks`).
- The spec apex pin (the model/effort the spec generator + reviewer run at) is
  not config — it is hard consts in `src/spec/agents.ts`, invariant by
  construction — see the [configuration reference](../reference/configuration.md).
- The trusted-compute-base write-deny is **hardcoded** in the hooks, not
  config-sourced; there is no config key to widen it.
