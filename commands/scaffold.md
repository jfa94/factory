---
description: "Prepare a repo for the factory pipeline (run once per project)"
argument-hint: "[--repo <owner/name>] [--provision]"
arguments:
  - name: "--repo"
    description: "Target GitHub repo as <owner>/<name> (defaults to the current repo's origin)"
    required: false
  - name: "--provision"
    description: "Write branch protection on develop if missing (default: refuse when unprotected)"
    required: false
---

# /factory:scaffold

Prepare a project to be run by the factory pipeline. The pipeline **refuses to start**
against an unscaffolded or unprotected repo, so run this before any `/factory:run` in a new
repo. All the work is done by one deterministic CLI call — `factory scaffold` — which copies
the committed CI + gate-config templates, and probes branch protection on `develop` (the
integration base).

## Step 1 — Confirm the checkout

Confirm you are inside a git checkout:

```bash
git rev-parse --show-toplevel        # must succeed; else tell the user to run from a checkout and stop
```

`--repo` is **optional**: `factory scaffold` auto-derives `<owner>/<name>` from the `origin`
remote of the current checkout. Pass `--repo <owner/name>` only to override (an explicit value
that disagrees with the origin remote fails loud). If there is no `origin` remote and the user did
not pass `--repo`, the CLI fails loud telling them to pass it.

`gh` is a **hard dependency** — the CLI shells out to it for the protection probe and (with
`--provision`) the protection write. If `gh` is missing, stop with the install hint
(`brew install gh` / your platform's package) and do not proceed.

## Step 2 — Scaffold

```bash
factory scaffold        # --repo is auto-derived from origin; pass --repo <owner/name> to override
```

This is idempotent. It:

- **auto-detects the repo's CI build env** (the same scan as
  `factory configure --detect-gate-env`) and gap-fills `quality.gateEnv` — run **first**, before
  the managed `quality-gate.yml` template overwrites the repo's own workflow, so the repo author's
  CI env is captured into the durable config overlay while that file is still theirs. Gap-fill
  never clobbers an operator-set value. The resolved `gateEnv` is then **injected back into the
  managed `quality-gate.yml`** build step (the `# factory:gate-env` marker becomes a real `env:`
  block), so the committed CI and the factory's local merge gate build with identical env — one
  config, one source of truth. An unparseable workflow is surfaced loudly (a `log.warn` + the
  report's `warnings`/`droppedKeys`), never silently swallowed;
- copies `.github/workflows/quality-gate.yml` (the CI net), and — when the target is a Node
  package — `.stryker.config.json` + `.dependency-cruiser.cjs` (gate configs);
- guarantees the `.gitignore` entries that keep factory state un-committed;
- emits (or non-destructively MERGES into) the target repo's `.claude/settings.json` — the
  factory permission allow-list (the `factory` CLI, git/gh, the agent tools, the data dir) plus
  `worktree.baseRef:"head"` — so an interactive `/factory:run` in this repo runs without a
  permission prompt per call. It does **not** write a `statusLine` (that would clobber yours);
  the factory statusline belongs only to the autonomous relaunch (`factory autonomy ensure`).
  Re-running is safe: existing keys (including your own statusLine) are preserved and entries
  are never duplicated;
- probes branch protection on `develop` and **refuses loudly if it is missing**.
  (`develop` is a precondition — scaffold does not create it. Per-run staging branches
  `staging-<run-id>` are minted at `run create`, not here.)

Print the emitted `ScaffoldReport` JSON: `files_created`, `files_present`, `files_updated`, and
`protection`. When CI build-env detection found anything — a detected key OR an anomaly worth
surfacing (`warnings`, `skippedExpressionRefs`, `droppedSecrets`, `droppedKeys`) — the report also
carries an optional `gateEnv` field (the `DetectReport`); it is omitted only for a brand-new repo
with no workflows and nothing to report, so that report is unchanged.

## Step 3 — Handle a protection refusal

If scaffold refuses because `develop` is unprotected, the run cannot start safely
(serial-writer correctness depends on required-up-to-date protection, Δ A/L). Offer the user
two options:

- **Provision it** (writes branch protection on `develop`): re-run with `--provision`.

  ```bash
  factory scaffold --provision        # --repo auto-derived from origin
  ```

- **Protect it manually** in the repo settings (strict "require branches to be up to date"
  - the required status checks), then re-run `factory scaffold`.

Do not proceed against an unprotected repo.

## Step 4 — Summary

Report:

- Files created by scaffold vs. already present.
- Protection on `develop`: enabled / strict-up-to-date / required checks / whether just provisioned.

Then remind the user:

- Run `/factory:configure` to inspect or change any setting.
- Run `/factory:run --issue <N>` to kick off a pipeline (`--repo` auto-derived from origin).

> The bash-era extras (progress files, `init.sh`, TruffleHog prompt, the `safety.*`
> write-blocklist) are gone: run/spec state lives outside the repo under the data dir, and
> the trusted-compute-base write-deny is now **hardcoded** in the hooks (not config-sourced).
