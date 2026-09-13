---
description: 'Prepare a repo for the factory pipeline (run once per project)'
argument-hint: '[--repo <owner/name>] [--provision]'
arguments:
    - name: '--repo'
      description: "Target GitHub repo as <owner>/<name> (defaults to the current repo's origin)"
      required: false
    - name: '--provision'
      description: 'Provision stable strict checks while preserving existing protection policy'
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

- **renders the configured `quality.gateEnv`** (set via
  `factory configure --set quality.gateEnv.<KEY>=<value>`) **into the managed
  `quality-gate.yml`** build step (the `# factory:gate-env` marker becomes a real `env:` block),
  so the committed CI and the factory's local merge gate build with identical env — one config,
  one source of truth. An empty `gateEnv` leaves the marker untouched;
- copies `.github/workflows/quality-gate.yml` (the CI net), and — when the target is a Node
  package — `.stryker.config.json` + `.dependency-cruiser.cjs` (gate configs);
- **refreshes outdated files**: managed CI-net files are overwritten on any drift from the
  shipped template; seed gate configs are overwritten only while PRISTINE — untouched since
  scaffold wrote them, proven via the committed `.factory/scaffold.lock` hash record. A
  customized seed is project-owned and never touched (delete it and re-scaffold to re-adopt
  the latest baseline). Refreshes land in `files_updated`;
- guarantees the `.gitignore` entries that keep factory state un-committed;
- emits (or non-destructively MERGES into) the target repo's `.claude/settings.json` — the
  factory permission allow-list (the `factory` CLI, git/gh, the agent tools, the data dir) plus
  `worktree.baseRef:"head"` — so an interactive `/factory:run` in this repo runs without a
  permission prompt per call. It does **not** write a `statusLine` (that would clobber yours);
  the factory statusline belongs only to the autonomous relaunch (`factory autonomy ensure`).
  Re-running is safe: existing keys (including your own statusLine) are preserved and entries
  are never duplicated;
- probes branch protection on `develop` and **refuses loudly if it is missing**.
  (`develop` is a precondition — scaffold does not create it. The feature branch
  is created when the new run first advances.)

Protection is stable and strict in v2: all `git.developRequiredStatusChecks` and
repository-required extras remain required throughout the run lifecycle. Existing
sufficient policy is untouched. Provisioning strengthens only status checks on an
already-protected branch, retaining check app bindings and unrelated policy.

Print the emitted `ScaffoldReport` JSON: `files_created`, `files_present`, `files_updated`,
`files_removed`, and `protection`. `files_removed` lists managed files scaffold deleted this
run: a stale `.github/workflows/mutation-nightly.yml` (mutation uncontracted in the gate
contract) is removed only while its bytes provably match the scaffold lock's recorded hash —
a customized/unknown stale nightly is a `files_conflict` refusal that `--force-managed` does
NOT override (force overwrites toward the template; it never authorizes deleting unproven
content).

## Step 3 — Handle a protection refusal

If scaffold refuses because `develop` is unprotected, the run cannot start safely
(serial-writer correctness depends on required-up-to-date protection, Δ A/L). Offer the user
two options:

- **Provision it** (enables strict protection on `develop`): re-run with `--provision`.

    ```bash
    factory scaffold --provision        # --repo auto-derived from origin
    ```

- **Protect it manually** in the repo settings (all required status
  checks and strict "require branches to be up to date"), then
  re-run `factory scaffold`.

Do not proceed against an unprotected repo.

The retired `developProtection` and baseline settings do not select a relaxed v2
profile. No scaffold or run transition downgrades existing protection.

## Step 4 — Summary

Report:

- Files created by scaffold vs. already present, plus any outdated files auto-refreshed
  (`files_updated`) and any stale managed files removed (`files_removed`). Remind the user
  to COMMIT `.factory/scaffold.lock` alongside the seeds.
- Protection on `develop`: enabled / strict-up-to-date / required checks / whether just
  provisioned. The healthy at-rest shape remains strict with all required checks.

Then remind the user:

- Run `/factory:configure` to inspect or change any setting.
- Run `/factory:run --issue <N>` to kick off a pipeline (`--repo` auto-derived from origin).

> The bash-era extras (progress files, `init.sh`, TruffleHog prompt, the `safety.*`
> write-blocklist) are gone: run/spec state lives outside the repo under the data dir, and
> the trusted-compute-base write-deny is now **hardcoded** in the hooks (not config-sourced).
