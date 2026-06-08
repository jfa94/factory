---
description: "Prepare a repo for the factory pipeline (run once per project)"
argument-hint: "[--repo <owner/name>] [--provision]"
arguments:
  - name: "--repo"
    description: "Target GitHub repo as <owner>/<name> (defaults to the current repo's origin)"
    required: false
  - name: "--provision"
    description: "Write branch protection on staging if missing (default: refuse when unprotected)"
    required: false
---

# /factory:scaffold

Prepare a project to be run by the factory pipeline. The pipeline **refuses to start**
against an unscaffolded or unprotected repo, so run this before any `/factory:run` in a new
repo. All the work is done by one deterministic CLI call — `factory scaffold` — which copies
the committed CI + gate-config templates, ensures the `staging` integration branch, and
probes branch protection.

## Step 1 — Resolve the repo

Confirm you are inside a git checkout and resolve the `<owner>/<name>` slug:

```bash
git rev-parse --show-toplevel        # must succeed; else tell the user to run from a checkout and stop
```

Use `--repo` if the user passed it; otherwise derive it from the origin remote:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner    # → owner/name
```

`gh` is a **hard dependency** — the CLI shells out to it for the protection probe and (with
`--provision`) the protection write. If `gh` is missing, stop with the install hint
(`brew install gh` / your platform's package) and do not proceed.

## Step 2 — Scaffold

```bash
factory scaffold --repo <owner/name>
```

This is idempotent. It:

- copies `.github/workflows/quality-gate.yml` (the CI net), and — when the target is a Node
  package — `.stryker.config.json` + `.dependency-cruiser.cjs` (gate configs);
- guarantees the `.gitignore` entries that keep factory state un-committed;
- creates/FF-reconciles the `staging` branch off `develop` (never `main`);
- probes branch protection on `staging` and **refuses loudly if it is missing**.

Print the emitted `ScaffoldReport` JSON: `files_created`, `files_present`, `staging`, and
`protection`.

## Step 3 — Handle a protection refusal

If scaffold refuses because `staging` is unprotected, the run cannot start safely
(serial-writer correctness depends on required-up-to-date protection, Δ A/L). Offer the user
two options:

- **Provision it** (writes branch protection on `staging`): re-run with `--provision`.

  ```bash
  factory scaffold --repo <owner/name> --provision
  ```

- **Protect it manually** in the repo settings (strict "require branches to be up to date"
  - the required status checks), then re-run `factory scaffold --repo <owner/name>`.

Do not proceed against an unprotected repo.

## Step 4 — Summary

Report:

- Files created by scaffold vs. already present.
- Staging branch: created or reconciled (+ tip SHA).
- Protection: enabled / strict-up-to-date / required checks / whether just provisioned.

Then remind the user:

- Run `/factory:configure` to inspect or change any setting.
- Run `/factory:run --repo <owner/name> --issue <N>` to kick off a pipeline.

> The bash-era extras (progress files, `init.sh`, TruffleHog prompt, the `safety.*`
> write-blocklist) are gone: run/spec state lives outside the repo under the data dir, and
> the trusted-compute-base write-deny is now **hardcoded** in the hooks (not config-sourced).
