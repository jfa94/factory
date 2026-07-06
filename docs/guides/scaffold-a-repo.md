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

- **auto-detects the repo's CI build env** (the same scan as
  [`configure --detect-gate-env`](../reference/cli.md#configure)) and gap-fills
  `quality.gateEnv`. This runs **before** writing the managed `quality-gate.yml`
  template, so the repo author's CI env is captured into the durable config overlay
  while that workflow file is still theirs; gap-fill never overwrites a value you set.
  An unparseable workflow is surfaced loudly, never silently skipped;
- writes the plugin-managed CI net (`.github/workflows/quality-gate.yml` and its
  `.github/scripts/shard-mutation-scope.mjs` helper), and — when the target is a
  Node package — the seed gate configs `.stryker.config.json`,
  `.dependency-cruiser.cjs`, and `eslint.config.mjs`. The managed `quality-gate.yml`
  is **rendered with the resolved `quality.gateEnv` injected** into its `pnpm build`
  step, so that one config drives both the factory's local merge gate and this repo's
  GitHub CI. An empty `gateEnv` leaves the build step's marker untouched, and a
  re-scaffold is byte-identical (drift is measured against the rendered template);
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
(plugin-managed files refreshed on drift), `protection` (enabled / strict-up-to-date
/ required checks / provisioned), `settings` (created / changed), and — only when CI
build-env detection found anything — an optional `gateEnv` `DetectReport`. SEED gate
configs are project-owned after first write — an existing one (even a richer
superset of the shipped baseline) is reported under `files_present`, never as drift.

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
factory configure --set 'git.requiredStatusChecks=["quality-gate"]'
```

See [Configure the factory](./configure-the-factory.md) and the
[configuration reference](../reference/configuration.md).

## 4. Next

- Inspect or change settings: [Configure the factory](./configure-the-factory.md).
- Start a pipeline: [Run the pipeline](./run-the-pipeline.md).
  </content>
