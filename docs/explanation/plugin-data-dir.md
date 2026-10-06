# The Plugin Data Dir and the Foreign `CLAUDE_PLUGIN_DATA` Leak

All run/spec state lives OUTSIDE the target repo, under factory's canonical
plugin data dir (`~/.claude/plugins/data/factory-<marketplace-id>`); the
[configuration reference](../reference/configuration.md#data-dir-claude_plugin_data) documents the
resolution rules and the redirect notice. This page explains **why** the redirect
exists and why the notice is benign.

A **successful** redirect logs at **DEBUG** (Fix 8) — it is self-correcting, so it
stays out of normal output; only a real fault inside the expected data dir (an
unparseable `marketplace.json`) still logs at WARN.

## Root cause (why it happens, why it's benign)

The leak is external to factory: Claude Code does not scope
`CLAUDE_PLUGIN_DATA` per-plugin in the **shared process env**, so a sibling
plugin that exports it (e.g. `codex`) leaves its value visible to every
`factory` subprocess. Factory's defense is two-layer and complete on its own
side:

1. **Primary pin — the inline autonomous settings.** In autonomous mode (the
   sanctioned run path), `factory autonomy ensure` bakes
   both `env.CLAUDE_PLUGIN_DATA` and `env.FACTORY_DATA_DIR` (set to the
   `<canonical dir>`) into the settings JSON the session relaunches with
   (`caffeinate -di claude --settings '<json>'` on macOS,
   `claude --settings '<json>'` elsewhere; `src/cli/subcommands/autonomy.ts`), so the dir is correct
   from process start and no redirect fires. Caveat (2026-08-17 spike, Claude
   Code 2.1.233): a sibling plugin's own `env` export can still shadow a
   `--settings` env value in the session env — which is exactly why layer 2
   exists and why engine envelopes carry literal paths rather than relying on
   the var.

    `FACTORY_DATA_DIR` exists because `CLAUDE_PLUGIN_DATA` is not the same in
    every process of one session. Under `--plugin-dir`, Claude Code hands plugin
    processes (such as the statusline) their own per-plugin value
    (`…/factory-inline`), while factory CLI calls from the Bash tool resolve
    `factory-<marketplace-id>`. The statusline would then write the usage cache
    into a different dir than quota pacing reads it from. `FACTORY_DATA_DIR` is a
    factory-only name that nothing else rewrites, and `resolveDataDir()` checks it
    before `CLAUDE_PLUGIN_DATA`, so every factory process agrees on one dir.

2. **Backstop — the `CLAUDE_PLUGIN_ROOT` self-correct.** When a session was
   _not_ launched through the inline autonomous settings (a foreign value leaked in),
   `resolveDataDir()` re-derives the canonical dir from `CLAUDE_PLUGIN_ROOT`
   (the per-plugin anchor Claude Code injects reliably) and the DEBUG notice is
   simply **evidence the backstop fired** — not a factory misconfiguration.

## Why the notice repeats across commands

The once-per-process dedup cannot span processes, and every `factory` CLI call
is a fresh process, so each command re-derives and re-notifies once (at DEBUG). It
is cosmetic; correctness (state always under factory's own dir) is already
guaranteed by the two layers above. The only way to silence it permanently is
to stop the foreign export — i.e. set `CLAUDE_PLUGIN_DATA` to factory's
canonical dir in your shell profile, or launch through the inline autonomous
settings (which pin it for you).
