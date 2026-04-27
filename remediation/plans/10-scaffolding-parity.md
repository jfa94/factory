# Plan 10 — Scaffolding Parity

**Priority:** P2 (polish — the old pipeline's scaffolding is richer than the plugin's)
**Tasks:** `task_10_01` through `task_10_03`
**Findings:** P2-scaffolding, M23

## Problem

Three scaffolding gaps relative to `~/Projects/factory`:

1. **Hardcoded package manager.** Several plugin scripts assume `pnpm` (`pnpm quality`, `pnpm install`). The old pipeline had a `detect_pkg_manager` helper that picked pnpm/yarn/npm based on lockfile presence. Plan 05 introduced `bin/pipeline-detect-pkg-manager` as a fix for the package.json rebase conflict — this plan makes sure every other caller switches to it.

2. **Missing quality tooling — stryker + dependency-cruiser.** The old pipeline's scaffolding included `stryker` for mutation testing and `dependency-cruiser` for architecture rule enforcement. The plugin ships neither, so tasks classified as `risk=security` have no mutation-testing requirement beyond whatever the project already has.

3. **package.json merge during resume.** When resuming a run, if `package.json` has been modified both locally and upstream, there's no tool to perform a 3-way merge. (Plan 05 added this to rebase flow; this plan generalizes it for scaffolding scenarios.)

## Scope

In:

- Replace hardcoded `pnpm` in all `bin/pipeline-*` scripts and `agents/*.md` with calls to the detector
- Add optional stryker + dep-cruiser invocation to `pipeline-quality-gate` when enabled in config
- Expose the package.json 3-way merge as a standalone `bin/pipeline-merge-pkg-json` usable outside rebase

Out: replacing the project's actual test framework, shipping stryker/dep-cruiser configs (projects bring their own).

## Tasks

| task_id    | Title                                                                |
| ---------- | -------------------------------------------------------------------- |
| task_10_01 | Replace hardcoded pnpm with pipeline-detect-pkg-manager              |
| task_10_02 | Add stryker + dep-cruiser integration to quality-gate (config-gated) |
| task_10_03 | Extract package.json 3-way merge as standalone script                |

## Execution Guidance

### task_10_01 — Detector everywhere

Files: `bin/pipeline-*` + `agents/*.md`

Grep `bin/` and `agents/` for the literal string `pnpm`. Every occurrence falls into one of these cases:

**Case A — running a script via pnpm:**

```bash
# Before
pnpm run lint

# After
pkg_mgr=$(pipeline-detect-pkg-manager)
"$pkg_mgr" run lint
```

**Case B — installing deps:**

```bash
# Before
pnpm install --prefer-offline

# After
pkg_mgr=$(pipeline-detect-pkg-manager)
case "$pkg_mgr" in
  pnpm) pnpm install --prefer-offline --silent ;;
  yarn) yarn install --silent ;;
  npm)  npm ci --silent || npm install --silent ;;
esac
```

**Case C — mentioning pnpm in agent prose:**

```markdown
# Before

Run `pnpm quality` to check the work.

# After

Run the project's quality command (the orchestrator passes this via
`pipeline-quality-gate`; use whatever package manager the project uses —
pnpm, yarn, or npm).
```

In agent markdown files, replace instructions to run `pnpm X` with instructions to call `pipeline-quality-gate`. The quality gate script already handles package-manager detection.

Tests in `bin/test-phase10.sh` (new) or amend existing phase tests:

1. Fixture with `pnpm-lock.yaml` → detector returns `pnpm`
2. Fixture with `yarn.lock` → returns `yarn`
3. Fixture with `package-lock.json` → returns `npm`
4. Fixture with no lockfile → defaults to `npm`
5. Grep all `bin/pipeline-*` files and all `agents/*.md` files: zero literal `pnpm ` occurrences outside of comments/docs (exception: `pipeline-detect-pkg-manager` itself)

### task_10_02 — Stryker + dep-cruiser in quality-gate

File: `bin/pipeline-quality-gate`

Extend the script (created in plan 07) to optionally run stryker and dep-cruiser when:

1. The project has them configured (`stryker.conf.*`, `.dependency-cruiser.*`)
2. OR the task's risk level is `security` and the config has `review.mutation_testing_for_security = true`

```bash
# After standard lint/typecheck/test checks
risk_level=$(pipeline-state read "$run_id" ".tasks.$task_id.risk_level")
mutation_required=$(pipeline-config get review.mutation_testing_for_security false)

should_mutation_test=false
if [[ -f stryker.conf.js || -f stryker.conf.json || -f stryker.config.mjs ]]; then
  if [[ "$risk_level" == "security" && "$mutation_required" == "true" ]]; then
    should_mutation_test=true
  fi
fi

if [[ "$should_mutation_test" == "true" ]]; then
  if "$pkg_mgr" exec stryker run --reporters json > ".state/$run_id/$task_id.stryker.json" 2>&1; then
    mutation_score=$(jq -r '.mutationScore // 0' ".state/$run_id/$task_id.stryker.json")
    threshold=$(pipeline-config get review.mutation_score_threshold 80)
    if (( $(echo "$mutation_score < $threshold" | bc -l) )); then
      results+=("$(jq -n --arg s "$mutation_score" --arg t "$threshold" \
        '{command:"stryker", status:"failed", reason:"mutation_score_below_threshold", score:$s, threshold:$t}')")
      overall_ok=false
    else
      results+=("$(jq -n --arg s "$mutation_score" '{command:"stryker", status:"passed", score:$s}')")
    fi
  else
    results+=('{"command":"stryker","status":"failed","reason":"run_error"}')
    overall_ok=false
  fi
fi

# Dep-cruiser — runs whenever configured
if [[ -f .dependency-cruiser.js || -f .dependency-cruiser.cjs || -f .dependency-cruiser.json ]]; then
  if "$pkg_mgr" exec depcruise --config --validate src > ".state/$run_id/$task_id.depcruise.log" 2>&1; then
    results+=('{"command":"depcruise","status":"passed"}')
  else
    results+=('{"command":"depcruise","status":"failed"}')
    overall_ok=false
  fi
fi
```

Notes:

- Mutation testing is expensive. Only run when explicitly required by config AND task is security-tier.
- Stryker mutation score is a float; use `bc -l` for comparison to avoid bash integer-only math.
- Dep-cruiser is cheaper — run it unconditionally when configured.
- Both tools are project dependencies; the plugin doesn't install them. If the exec fails because the tool isn't installed, record as `failed` with `reason: "tool_not_installed"`.

Tests in `bin/test-phase6.sh` or `bin/test-phase10.sh`:

1. Fixture project with stryker config + security task + `mutation_testing_for_security=true` → stryker runs
2. Same fixture + `mutation_testing_for_security=false` → stryker skipped
3. Low-risk task → stryker skipped even if configured
4. Dep-cruiser config present → depcruise runs regardless of risk

### task_10_03 — `pipeline-merge-pkg-json` standalone script

File: `bin/pipeline-merge-pkg-json` (NEW)

Extract the package.json 3-way merge logic from plan 05 into a standalone script that can be called from scaffolding, resume, or rebase flows.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: pipeline-merge-pkg-json <ours> <theirs> [<base>]
# Reads: package.json from current working tree (or passed paths)
# Writes: a merged package.json preserving both sides' deps
# Exits: 0 on clean merge, 1 on irreconcilable conflict

ours="${1:-package.json}"
theirs="${2:-package.json.theirs}"
base="${3:-}"

if [[ ! -f "$ours" ]]; then
  echo '{"error":"ours_missing"}' >&2
  exit 1
fi

if [[ ! -f "$theirs" ]]; then
  # No competing version — nothing to merge
  exit 0
fi

# Merge strategy:
# 1. Take non-deps fields from ours (version, scripts, etc.)
# 2. Union dependencies, devDependencies, peerDependencies — if the same
#    package appears with different versions, prefer the higher version
# 3. Regenerate the lockfile via the project's package manager

merged=$(jq -s '
  def merge_deps:
    reduce .[] as $side ({}; . + ($side // {}));

  def pick_higher:
    group_by(.[0])
    | map({
        key: .[0][0],
        value: (map(.[1]) | sort_by(.) | last)
      })
    | from_entries;

  .[0] as $ours
  | .[1] as $theirs
  | $ours
  | .dependencies = (
      [$ours.dependencies, $theirs.dependencies]
      | merge_deps
      | to_entries
      | [.[] | [.key, .value]]
      | pick_higher
    )
  | .devDependencies = (
      [$ours.devDependencies, $theirs.devDependencies]
      | merge_deps
      | to_entries
      | [.[] | [.key, .value]]
      | pick_higher
    )
  | .peerDependencies = (
      [$ours.peerDependencies, $theirs.peerDependencies]
      | merge_deps
    )
' "$ours" "$theirs")

if [[ -z "$merged" || "$merged" == "null" ]]; then
  echo '{"error":"jq_merge_failed"}' >&2
  exit 1
fi

# Write atomically
tmp="${ours}.$$.tmp"
echo "$merged" | jq '.' > "$tmp"
mv "$tmp" "$ours"

# Regenerate lockfile
pkg_mgr=$(pipeline-detect-pkg-manager)
case "$pkg_mgr" in
  pnpm) pnpm install --prefer-offline --silent --lockfile-only ;;
  yarn) yarn install --silent --mode update-lockfile 2>/dev/null || yarn install --silent ;;
  npm)  npm install --package-lock-only --silent ;;
esac

jq -n --arg m "$pkg_mgr" \
  '{status:"merged", package_manager:$m}'
```

Note: `pick_higher` is naïve — it compares version strings lexicographically which is wrong for semver (`1.10.0` < `1.9.0` lex but `1.10.0 > 1.9.0` semver). For a production-grade solution, use `node -e "require('semver').compare(...)"`. Ship the lex version but add a TODO referencing semver.

Tests in `bin/test-phase10.sh`:

1. Two package.jsons with disjoint `dependencies` → merged has the union
2. Two package.jsons with overlapping dep at different versions → merged picks one deterministically
3. Theirs missing → exit 0 (nothing to merge)
4. Ours missing → exit 1 with `ours_missing`

## Verification

1. Grep `bin/` for `pnpm ` (with trailing space) — only matches should be inside `pipeline-detect-pkg-manager` case statements and inside `pipeline-merge-pkg-json`'s package-manager dispatch
2. Grep `agents/` for `pnpm ` — zero or only in explanatory prose
3. `bin/pipeline-quality-gate` — contains stryker and depcruise handling
4. `bin/pipeline-merge-pkg-json` exists and is executable
5. `bash bin/test-phase10.sh` — all new scaffolding tests pass
