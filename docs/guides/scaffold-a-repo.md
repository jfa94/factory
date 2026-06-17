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

- copies `.github/workflows/quality-gate.yml` (the CI net), and — when the target
  is a Node package — `.stryker.config.json` + `.dependency-cruiser.cjs` (gate
  configs);
- guarantees the `.gitignore` entries that keep factory state un-committed;
- creates or fast-forward-reconciles the `staging` integration branch off the base
  branch (`develop` by default — **never** `main`);
- probes branch protection on `staging` and **refuses loudly if it is missing**.

It prints a `ScaffoldReport`: `files_created`, `files_present`, `staging` (created

- tip SHA), and `protection` (enabled / strict-up-to-date / required checks /
  provisioned).

## 2. Handle a protection refusal

If scaffold refuses because `staging` is unprotected, you have two options.

**Provision it** (writes branch protection on `staging`):

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
