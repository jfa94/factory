# Upstream issue draft — `openai/codex-plugin-cc`

Ready to file at https://github.com/openai/codex-plugin-cc/issues/new

---

## Title

SessionStart hook promotes `CLAUDE_PLUGIN_DATA` to session-global env, breaking other plugins

## Body

### Summary

The codex plugin's `SessionStart` hook writes `export CLAUDE_PLUGIN_DATA=<codex's data dir>` into `$CLAUDE_ENV_FILE`. Claude Code sources that file into the parent shell env for every subsequent `Bash` tool call, pinning codex's data dir session-wide. `CLAUDE_PLUGIN_DATA` is owned by Claude Code's per-plugin scoping — promoting it to session-global is incorrect and causes every other installed plugin's bash scripts to see codex's data dir instead of their own.

### Reproduction

1. Install `codex@openai-codex` and any other plugin whose bash scripts read `CLAUDE_PLUGIN_DATA` (example: [`factory@jfa94`](https://github.com/jfa94/factory-plugin)).
2. Start any Claude Code session.
3. From a `Bash` tool call, run a factory script — e.g. `bash ~/.claude/plugins/cache/jfa94/factory/<ver>/bin/pipeline-summary --help`.
4. Observe (on stderr):
   ```
   [WARN] pipeline-lib: CLAUDE_PLUGIN_DATA points at foreign plugin dir
     '/Users/<u>/.claude/plugins/data/codex-openai-codex';
     redirecting to '/Users/<u>/.claude/plugins/data/factory-jfa94'
   ```
5. Without codex installed, the warning does not appear. Disabling codex's SessionStart hook also stops it.

### Root cause

`scripts/session-lifecycle-hook.mjs:76-79`:

```js
function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]); // ← the leak
}
```

`appendEnvVar` (lines 34-39) writes `export CLAUDE_PLUGIN_DATA=…` into `$CLAUDE_ENV_FILE`. When Claude Code sources that file, the value persists for every subsequent Bash tool call across all plugins.

Claude Code already sets `CLAUDE_PLUGIN_DATA` per-plugin for hooks and commands the plugin owns — the appendEnvVar call is duplicative for codex's own scope and harmful for everyone else's.

### Proposed fix (Option 1, minimal — recommended)

Remove the offending line:

```diff
 function handleSessionStart(input) {
   appendEnvVar(SESSION_ID_ENV, input.session_id);
-  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
 }
```

Codex's own hooks and commands continue to receive `CLAUDE_PLUGIN_DATA` via Claude Code's per-plugin scoping. Subshells launched from codex commands inherit it via normal env propagation. Only cross-plugin sibling Bash calls lose codex's value — which is the correct behavior.

### Proposed fix (Option 2, private namespace)

If codex's state lookup genuinely needs the value available in session-global env (e.g., for subshells launched outside any plugin context):

```diff
-  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
+  appendEnvVar("CODEX_PLUGIN_DATA", process.env[PLUGIN_DATA_ENV]);
```

And update `scripts/lib/state.mjs:9,41-43` to prefer the private name:

```js
const dataDir = process.env.CODEX_PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
```

### Impact

Every plugin that uses bash scripts referencing `CLAUDE_PLUGIN_DATA` either silently writes state into codex's data dir, or (if it has a guard) emits a noisy warning on every script invocation. The factory plugin has a canonicalization guard (`bin/pipeline-lib.sh`) that detects the foreign value and redirects, but this surfaces a `[WARN]` line on essentially every script call.

### Environment

- Claude Code (CLI/Desktop, any version supporting `$CLAUDE_ENV_FILE`)
- `codex@openai-codex` 1.0.3
- macOS / Linux — env propagation behavior is identical
