# Hook Env-Var Canonicalization

Why every plugin hook that reads `CLAUDE_PLUGIN_DATA` must `source pipeline-lib.sh` before reading the env var.

## The leak

Claude Code sets `CLAUDE_PLUGIN_DATA` per-plugin so each plugin's hooks, commands, and scripts get their own data directory under `~/.claude/plugins/data/<plugin-id>/`. The runtime sets the value for the plugin that owns the currently-firing tool call.

When a foreign plugin's command invokes a bash block, the child shell inherits **that plugin's** `CLAUDE_PLUGIN_DATA`. If a factory hook then fires inside the same shell (e.g. a `Stop` hook on the user's session, or a `PostToolUse` hook that runs across plugin boundaries), `$CLAUDE_PLUGIN_DATA` points at the foreign plugin's data dir, not factory's.

The observable symptoms vary by hook:

- `subagent-stop-transcript.sh` — checks `[[ -L "$current_link" ]]` against the foreign `runs/current` (which does not exist) and silent-exits. Every subagent's STATUS write, reviewer-status field, and metric line is dropped. The orchestrator sees the subagent return and treats it as success even though no state was recorded.
- `pretooluse-pipeline-guards.sh` — fails open on pipeline-invariant checks (ship-checklist, PR-merge gate, scribe path scope) because it reads the foreign run dir and finds no active run.
- `run-tracker.sh` — appends audit entries to the foreign data dir's `audit.jsonl` instead of factory's. Audit chain breaks silently.
- `session-start.sh` / `session-start-resume.sh` — inject stale or empty stage context, or silent-skip the resume snapshot.
- `secret-commit-guard.sh` / `write-protection.sh` — read configuration from the foreign config.json (typically missing), falling back to defaults that may not match the operator's intent.
- `asyncrewake-ci.sh` — writes CI status to the foreign `runs/current` and loses track of the wake.
- `stop-gate.sh` — same shape; misses incomplete-state checks against the real active run.

This was the root cause of pipeline run `run-20260526-154940`: the codex plugin leaked its `CLAUDE_PLUGIN_DATA`, `subagent-stop-transcript.sh` silent-exited on every subagent, and the orchestrator could not see reviewer status or task progress.

## The fix

`pipeline-lib.sh` already implements a redirect at top-level scope: when sourced, it inspects the inherited `CLAUDE_PLUGIN_DATA` and rewrites the env var to factory's canonical data dir if the basename does not start with `factory-`. The rewrite emits a `[WARN] pipeline-lib: CLAUDE_PLUGIN_DATA points at foreign plugin dir '<old>'; redirecting to '<new>'` line on stderr so leaks are visible in audit logs. See `docs/reference/bin-scripts.md` (`pipeline-lib.sh` section) for the redirect logic.

The redirect only takes effect when `pipeline-lib.sh` is **sourced before any read of `$CLAUDE_PLUGIN_DATA`**. Previously, three hooks sourced the library only at the bottom to emit metrics (after they had already read the symlink, config, or run-dir paths). The library's top-level rewrite ran too late — every state-write and every silent-exit path had already consumed the foreign value.

All hooks that touch `$CLAUDE_PLUGIN_DATA` now source `pipeline-lib.sh` at the very top of the script, before any read:

| Hook                            | What it reads from `$CLAUDE_PLUGIN_DATA` |
| ------------------------------- | ---------------------------------------- |
| `subagent-stop-transcript.sh`   | `runs/current` symlink + state writes    |
| `run-tracker.sh`                | `runs/<id>/audit.jsonl`                  |
| `pretooluse-pipeline-guards.sh` | `runs/current` + per-task state          |
| `session-start.sh`              | `runs/current` + state                   |
| `session-start-resume.sh`       | `runs/current` + state                   |
| `stop-gate.sh`                  | `runs/current` + state                   |
| `secret-commit-guard.sh`        | `config.json` (via `read_config`)        |
| `write-protection.sh`           | `config.json` (via `read_config`)        |
| `asyncrewake-ci.sh`             | `runs/<id>` task state writes            |

The source block is identical in every hook:

```bash
_lib="${CLAUDE_PLUGIN_ROOT:-}/bin/pipeline-lib.sh"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "$_lib" ]]; then
  # shellcheck disable=SC1090
  source "$_lib" 2>/dev/null || true
fi
```

`CLAUDE_PLUGIN_ROOT` is set by Claude Code's plugin runtime and points at the plugin's install directory. Sourcing is best-effort (`|| true`) so a missing or broken library never breaks the hook outright — the hook degrades to "reads whatever `CLAUDE_PLUGIN_DATA` it inherited", which is the pre-fix behavior.

## Loud diagnostic on missing symlink

`subagent-stop-transcript.sh` previously silent-exited when `runs/current` was absent. With the env-var fix, a missing symlink after canonicalization is a genuine pipeline-state corruption — not a foreign-plugin leak — and must surface loudly. The hook now distinguishes:

- `CLAUDE_PLUGIN_DATA` unset → silent exit (hook not configured).
- `CLAUDE_PLUGIN_DATA` set, symlink missing → loud WARN to stderr **and** append a line to `$CLAUDE_PLUGIN_DATA/hook-errors.log` for post-mortem analysis. Hook still exits 0 (subagent stop must not be blocked).

The accompanying `pipeline-init` post-init verification (see `docs/reference/bin-scripts.md`) closes the inverse failure mode: an atomic-rename that returns 0 without moving the symlink. Together the two changes ensure that a `runs/current` symlink either exists and points at the active run, or every state-write attempt produces a visible error.

## Why not export a wrapper PATH?

An alternative design would prepend `bin/` to PATH and have a shim that re-execs scripts with a corrected env. Rejected because:

- Hooks invoke `pipeline-state` and other bin scripts directly via their absolute path (via `CLAUDE_PLUGIN_ROOT/bin/...`). A PATH shim would not intercept these.
- The redirect must happen inside the hook's own shell, before the hook reads the env var to compute paths for its own logic (symlink target, config lookup). A separately-invoked shim cannot mutate the parent's env.
- The `pipeline-lib.sh` source pattern is already used by every bin script. Reusing it in hooks keeps the canonicalization rule in one place.

## Related references

- `docs/reference/bin-scripts.md` — `pipeline-lib.sh` "Plugin Data Directory Canonicalization" section (the redirect logic itself).
- `docs/architecture/components.md` — hook descriptions and `hooks.json` mapping.
- `docs/superpowers/plans/2026-05-26-pipeline-run-bug-fixes.md` — full incident write-up for `run-20260526-154940`.
