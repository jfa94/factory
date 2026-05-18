---
description: "Scaffold a project for the factory pipeline (run once per project)"
---

# /factory:scaffold

You are preparing a project to be run by the factory pipeline for the first time. The pipeline refuses to start against an unscaffolded project, so this command must run before any `/factory:run` in a new repo.

## Step 1: Detect project root

Confirm the current working directory is a git repo:

```bash
git rev-parse --show-toplevel
```

Use that path as `$PROJECT_ROOT`. If the command fails, tell the user they must run `/factory:scaffold` from inside a git checkout and stop.

## Step 2: Run the scaffolder

```bash
pipeline-scaffold "$PROJECT_ROOT"
```

This creates (idempotently) the minimum set of files the pipeline expects:

- `claude-progress.json` and `feature-status.json` (progress tracking)
- `init.sh` (per-run setup hook)
- `.github/workflows/quality-gate.yml` (CI template)
- `.stryker.config.json` and `.dependency-cruiser.cjs` (quality gate configs)

Scaffold also applies surgical workflow migrations on every run, so existing
projects pick up post-release fixes to `quality-gate.yml` (e.g. the
`--delete-branch` flag on staging-target auto-merge) without losing local
customizations. The migration JSON output's `migrations` array names any files
patched.

Report any files that were newly created versus already present, and surface
any migrations applied.

## Step 3: Check optional tool dependencies

Evaluate optional tools and prompt the user for each missing one. Never auto-install; ask for explicit confirmation.

### 3a. TruffleHog (optional, gated by `safety.useTruffleHog`)

Used by the `secret-commit-guard` PreToolUse hook to scan commits for secrets beyond the built-in regex set. Falls back to regex-only if absent.

```bash
command -v trufflehog || true
```

If missing, ask the user:

> TruffleHog is not installed. It provides an extra layer of secret scanning on every `git commit`. Want to install it? (y/n)

Install recipe (macOS): `brew install trufflesecurity/trufflehog/trufflehog`
Install recipe (Linux): `curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin`

If the user accepts and install succeeds, enable the hook via `/factory:configure safety.useTruffleHog` (set to `true`).

### 3b. GitHub CLI (`gh`) — hard dependency

```bash
command -v gh || { echo "gh is required"; exit 1; }
```

If missing, error out with the Homebrew / apt install instructions and stop. The pipeline cannot run without `gh`.

### 3c. `jq` — hard dependency

```bash
command -v jq || { echo "jq is required"; exit 1; }
```

Same treatment as `gh`.

### 3d. GNU date (`gdate`) — optional on macOS

The pipeline's ISO 8601 parser falls back across `gdate`, `date -d`, and BSD `date -j`. Warn only if none of the three work on the current system.

## Step 4: Optional write-blocklist (advanced)

`safety.writeBlockedPaths` is an opt-in glob blocklist enforced by the `write-protection.sh` PreToolUse hook on every `Edit`, `Write`, and `MultiEdit` call. When a path matches, the hook denies the tool call (exit 2, reason `write_blocked`). It blocks the autonomous pipeline **and** interactive Claude sessions.

The blocklist defaults to empty. The autonomous pipeline is designed to author migrations, environment scaffolding, infrastructure code, and similar files without human intervention; adding patterns here removes that autonomy for the matched paths.

Most users should skip this step. Add entries only when you have a concrete reason to require a human gate on a specific path (e.g. a regulated path your org policy forbids agents from modifying, a generated artifact that must stay reproducible from source).

Ask the user once:

> Want to add any glob patterns to `safety.writeBlockedPaths`? (Press Enter to skip; otherwise enter a comma-separated list of globs.)

If the user enters nothing, proceed to Step 5 without writing anything.

If the user enters one or more globs, run `/factory:configure safety.writeBlockedPaths` with the resulting array. Reversible later via `/factory:configure` or by editing `${CLAUDE_PLUGIN_DATA}/config.json` directly.

## Step 5: Summary

Print a compact report:

- Files created by scaffold: [...]
- Files already present: [...]
- Optional tools installed: [...]
- Optional tools declined: [...]
- Write blocklist entries added: [...]

Remind the user:

- Run `/factory:configure` to inspect or change any setting.
- Run `/factory:run prd --issue <N>` to kick off a pipeline.
