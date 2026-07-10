# How to Scaffold a Target Repo

Run this once per repository before any pipeline run. The factory refuses to start
against an unscaffolded or unprotected repo. `gh` is a hard dependency (the
protection probe and, with `--provision`, the protection write shell out to it).

## 1. Scaffold

From inside the target repo checkout:

```
/factory:scaffold [--repo <owner/name>]
```

Or call the CLI directly:

```bash
factory scaffold [--repo <owner/name>]
```

`--repo` is **optional**: when omitted it is auto-derived from the repo's `origin`
remote. Pass it only to override; an explicit value that disagrees with `origin`
fails loud.

This is idempotent. It:

- seeds the project-owned gate configs (`.stryker.config.json`,
  `.dependency-cruiser.cjs`, `eslint.config.mjs`) when the target is a Node package,
  resolves the repo's gate contract (`.factory/gates.json`), then writes the
  plugin-managed CI net (`.github/workflows/quality-gate.yml` and its
  `.github/scripts/shard-mutation-scope.mjs` helper). The `quality-gate.yml` is
  **rendered per-repo from the gate contract** (Decision 53): the package-manager
  setup (lockfile-detected pnpm vs npm) and each gate step come from the contract, so
  CI runs the same checks the local merge gate enforces. This render is **npm-stack
  only** — a `deno`/`custom` repo skips the CI net with a loud log and relies on the
  local `GateRunner`. The configured `quality.gateEnv` is **injected** into the
  rendered build step (set via `factory configure --set quality.gateEnv.<KEY>=<value>`),
  so one config drives both the factory's local merge gate and this repo's GitHub CI.
  An empty `gateEnv` leaves the build step's marker untouched, and a re-scaffold is
  byte-identical (drift is measured against the rendered file);
- guarantees the `.gitignore` entries that keep factory state un-committed;
- emits / idempotently merges the target `.claude/settings.json` (factory allow-list
    - `permissions.additionalDirectories` plus `Read|Write|Edit(<data-dir>/**)` allow
      rules so the built-in file tools reach the out-of-tree plugin data dir —
      `results/`, `worktrees/`, `runs/`, `specs/` — without tripping the
      working-directory-boundary prompt + `worktree.baseRef:"head"`). The data-dir path
      is the **CLI-resolved canonical dir baked in at scaffold time** (allow globs in the
      `~`-tilde form when under `$HOME`, absolute otherwise; `additionalDirectories`
      always absolute — `~/` does not expand there), **not** the literal
      `${CLAUDE_PLUGIN_DATA}` placeholder: env-var interpolation in permission rules is
      unsupported and the var is hijackable by co-installed plugins, so a placeholder
      rule would match nothing. Re-scaffolding an older repo migrates any stale
      `${CLAUDE_PLUGIN_DATA}` rules — and the older tilde-form `additionalDirectories`
      entry — to the baked form. See [Decision 17](../explanation/decisions.md#decision-17-coarse-bash-allow-with-hook-enforced-defense-in-depth);
- probes branch protection on `develop` (the integration base) and **refuses loudly
  if it is missing**.

Scaffold does **not** create or protect a shared `staging` branch. Each run cuts its
own private `staging-<run-id>` integration branch from `develop` at
[`run create`](../reference/cli.md#run-create) (Decision 33).

It prints a `ScaffoldReport`: `files_created`, `files_present`, `files_updated`
(outdated files auto-refreshed: managed files on any drift, seed configs only while
pristine per the committed `.factory/scaffold.lock` hash record — commit the lock
alongside the seeds), `protection` (enabled / strict-up-to-date / required checks /
provisioned), and `settings` (created / changed). A CUSTOMIZED seed config is
project-owned — reported under `files_present`, never overwritten (even a richer
superset of the shipped baseline is recognized as current, not drift); delete it and
re-scaffold to re-adopt the latest baseline.

## 2. Handle a protection refusal

If scaffold refuses because `develop` is unprotected, you have two options.

**Provision it** (writes branch protection on `develop`):

```bash
factory scaffold --repo <owner/name> --provision
```

**Or protect it manually** in the repo settings — enable strict "require branches
to be up to date" plus your required status checks — then re-run
`factory scaffold --repo <owner/name>` to re-verify.

Do not proceed against an unprotected repo: the serial-writer's correctness
depends on required-up-to-date protection.

## 3. Tune the branch contract (optional)

The branches and required checks are configurable. To change them before
scaffolding:

```bash
factory configure --set git.baseBranch=develop
factory configure --set git.stagingBranch=staging
factory configure --set 'git.developRequiredStatusChecks=["Quality","Mutation Testing","Security Scan"]'
```

See [Configure the factory](./configure-the-factory.md) and the
[configuration reference](../reference/configuration.md).

## 4. Next

- Inspect or change settings: [Configure the factory](./configure-the-factory.md).
- Start a pipeline: [Run the pipeline](./run-the-pipeline.md).
