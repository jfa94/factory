# Plan 05 — Branch & Rebase Handling

**Priority:** P1 (major — PRs stall, silent branch collisions, broken merges)
**Tasks:** `task_05_01` through `task_05_06`
**Findings:** M1, M2, M4, M5, M6, M7

## Problem

`pipeline-branch` and `pipeline-wait-pr` have six independent correctness bugs that all manifest when the pipeline runs in real git conditions (multiple commits, merge conflicts, re-runs, branch collisions):

1. **M1 — grep false positive on staging detection.** `pipeline-branch` detects whether a staging branch exists with `git branch -a | grep -q staging` (unanchored). This matches any branch containing the substring "staging" (e.g. `feature/staging-test`, `refactor-staging-code`) and wrongly short-circuits the creation step.

2. **M2 — silent failure on existing branch.** `git checkout -b "$branch" &>/dev/null` silently falls through to detached HEAD if the branch already exists. The run then commits onto the wrong branch with no error.

3. **M4 — single-round rebase loop.** `pipeline-wait-pr` runs `git rebase origin/develop` exactly once. The old pipeline had a 30-round rebase loop because partial conflicts + fresh pushes to `develop` mid-rebase routinely need 2-5 rounds. Single-round fails whenever `develop` advances during the rebase.

4. **M5 — package.json 3-way merge missing.** The old pipeline has special handling for `package.json`: run `git checkout --ours package.json && npm install && git add package.json`. Without this, every concurrent task touching deps ends in a rebase conflict the orchestrator can't resolve.

5. **M6 — UNKNOWN mergeable state unhandled.** `gh pr view --json mergeable` returns `"UNKNOWN"` while GitHub computes the merge status (usually 5-30 seconds after a push). Current `pipeline-wait-pr` treats `UNKNOWN` as `CONFLICTING` and fails the task immediately.

6. **M7 — PR cleanup deletes branches without checking PR state.** `pipeline-cleanup --remove-worktrees` deletes a task's worktree even if its PR is still `OPEN` and pending review.

## Scope

In:

- Fix all six bugs in `bin/pipeline-branch` and `bin/pipeline-wait-pr` and `bin/pipeline-cleanup`
- Add regression tests for each in `bin/test-phase4.sh` / `bin/test-phase5.sh`
- Replicate the multi-round rebase loop and package.json 3-way merge from `~/Projects/dark-factory/lib/git-helpers.sh`

Out:

- Worktree lifecycle redesign (keep current structure)
- PR review automation (plan 06, plan 07)

## Tasks

| task_id    | Title                                                               |
| ---------- | ------------------------------------------------------------------- |
| task_05_01 | Anchor grep for staging branch detection (M1)                       |
| task_05_02 | Fail loudly on existing branch instead of silent detached HEAD (M2) |
| task_05_03 | Implement N-round rebase loop with bounded retries (M4)             |
| task_05_04 | Add package.json 3-way merge handler (M5)                           |
| task_05_05 | Handle UNKNOWN mergeable state with backoff (M6)                    |
| task_05_06 | Gate `--remove-worktrees` cleanup on PR state (M7)                  |

## Execution Guidance

### task_05_01 — Anchored staging detection

File: `bin/pipeline-branch`

Find the grep that detects an existing staging branch. Replace unanchored substring match with an exact ref-existence check:

```bash
# Before (buggy)
if git branch -a | grep -q staging; then ...

# After
if git show-ref --verify --quiet "refs/heads/staging/$run_id"; then
  staging_exists=true
else
  staging_exists=false
fi
```

`show-ref --verify` is the canonical "does this exact ref exist?" check — no regex, no false positives.

Test in `bin/test-phase4.sh`:

- Temp repo with branch `feature/staging-test` (decoy) but no `staging/<run_id>` → `pipeline-branch staging-init <run_id>` creates the branch, `staging_exists` was detected as false.
- Pre-create `staging/abc123` → `staging-init abc123` detects `staging_exists=true`, does not re-create.

### task_05_02 — Loud failure on existing branch

File: `bin/pipeline-branch`

Replace `git checkout -b "$branch" &>/dev/null || true` with a two-step check:

```bash
if git show-ref --verify --quiet "refs/heads/$branch"; then
  jq -n --arg b "$branch" '{error:"branch_exists", branch:$b}'
  exit 1
fi

git checkout -b "$branch" || {
  jq -n --arg b "$branch" '{error:"checkout_failed", branch:$b}'
  exit 1
}
```

Never swallow `git checkout` errors — the resulting detached-HEAD state is invisible to the orchestrator until a push fails 30 minutes later.

Test in `bin/test-phase4.sh`:

- Pre-create branch `task/abc123` → `pipeline-branch task-init abc123` exits 1, stdout contains `"error":"branch_exists"`.
- Clean repo → `task-init abc123` succeeds, HEAD is on `task/abc123`.

### task_05_03 — Multi-round rebase loop

File: `bin/pipeline-wait-pr`

Read `~/Projects/dark-factory/lib/git-helpers.sh` and find the `rebase_with_retries` function (the original uses 30 rounds). Port it into `pipeline-wait-pr`:

```bash
rebase_with_retries() {
  local base="$1"
  local max_rounds="${2:-10}"
  local round=0

  while (( round < max_rounds )); do
    round=$((round + 1))

    git fetch origin "$base" --quiet

    if git merge-base --is-ancestor "origin/$base" HEAD; then
      return 0  # already up-to-date
    fi

    if git rebase "origin/$base"; then
      # Rebase succeeded; check if develop moved during rebase
      git fetch origin "$base" --quiet
      if git merge-base --is-ancestor "origin/$base" HEAD; then
        return 0
      fi
      # develop advanced — loop again
      continue
    fi

    # Rebase failed — try the package.json 3-way merge (task_05_04)
    if has_only_package_json_conflict; then
      resolve_package_json_conflict || {
        git rebase --abort
        return 1
      }
      git rebase --continue || { git rebase --abort; return 1; }
      continue
    fi

    # Unknown conflict — abort and fail
    git rebase --abort
    return 1
  done

  return 1  # exceeded max_rounds
}
```

Call it from the mergeable-state block:

```bash
if [[ "$mergeable" == "CONFLICTING" ]]; then
  rebase_with_retries "develop" 10 || {
    pipeline-gh-comment --type ci-failure --body "rebase failed after 10 rounds"
    exit 1
  }
  git push --force-with-lease origin "$task_branch"
fi
```

Key details:

- Use `--force-with-lease`, never `--force`. Lease-based force push refuses if someone else pushed in the interim.
- Cap at 10 rounds in the plugin version (original was 30). 10 is enough for normal contention; if it fails 10 times the repo is genuinely unstable and human review is warranted.
- Re-fetch inside the loop to detect `develop` advancing mid-rebase.

Test in `bin/test-phase4.sh`:

- Create a conflict scenario with 3 commits needing rebase → `rebase_with_retries` succeeds in ≤3 rounds.
- Create an unresolvable conflict → exits 1 after N rounds, emits structured error.

### task_05_04 — package.json 3-way merge

File: `bin/pipeline-wait-pr` (same file, helper function)

```bash
has_only_package_json_conflict() {
  local conflicts
  conflicts=$(git diff --name-only --diff-filter=U)
  [[ "$conflicts" == "package.json" || "$conflicts" == $'package.json\npackage-lock.json' ]]
}

resolve_package_json_conflict() {
  # Take ours (our branch's dep additions) then regenerate the lock
  git checkout --ours package.json

  local pkg_mgr
  pkg_mgr=$(pipeline-detect-pkg-manager 2>/dev/null || echo npm)
  case "$pkg_mgr" in
    pnpm) pnpm install --prefer-offline --silent ;;
    yarn) yarn install --silent ;;
    *)    npm install --silent ;;
  esac

  git add package.json package-lock.json pnpm-lock.yaml yarn.lock 2>/dev/null || true
}
```

Note: `pipeline-detect-pkg-manager` may not exist yet. If it doesn't, create a minimal version in `bin/`:

```bash
#!/usr/bin/env bash
if   [[ -f pnpm-lock.yaml ]]; then echo pnpm
elif [[ -f yarn.lock       ]]; then echo yarn
elif [[ -f package-lock.json ]]; then echo npm
else echo npm
fi
```

This also unblocks plan 10 (scaffolding parity).

Test in `bin/test-phase4.sh`:

- Construct a rebase conflict where only `package.json` conflicts (both sides added different deps) → `resolve_package_json_conflict` runs, rebase continues, final tree has both our adds and the base's adds merged via a regenerated lockfile.

### task_05_05 — UNKNOWN mergeable with backoff

File: `bin/pipeline-wait-pr`

Current code:

```bash
mergeable=$(gh pr view ... --json mergeable -q .mergeable)
if [[ "$mergeable" == "CONFLICTING" ]]; then fail; fi
```

Replace with a backoff loop that treats `UNKNOWN` as "keep polling":

```bash
poll_mergeable() {
  local pr_num="$1"
  local max_wait=120  # seconds
  local elapsed=0
  local backoff=5

  while (( elapsed < max_wait )); do
    local state
    state=$(gh pr view "$pr_num" --json mergeable -q .mergeable 2>/dev/null || echo "UNKNOWN")

    case "$state" in
      MERGEABLE)   echo MERGEABLE; return 0 ;;
      CONFLICTING) echo CONFLICTING; return 0 ;;
      UNKNOWN|"")  sleep "$backoff"; elapsed=$((elapsed + backoff)); backoff=$((backoff < 30 ? backoff + 5 : 30)) ;;
      *)           echo "$state"; return 1 ;;
    esac
  done

  echo "TIMEOUT"
  return 1
}
```

Callers now do:

```bash
state=$(poll_mergeable "$pr_num") || {
  pipeline-gh-comment --type ci-escalation --body "PR $pr_num mergeable state timed out ($state)"
  exit 1
}

case "$state" in
  MERGEABLE)   proceed ;;
  CONFLICTING) rebase_with_retries develop 10 || fail ;;
esac
```

Test in `bin/test-phase4.sh` — extend the existing `gh` mock:

- Mock returns `UNKNOWN` twice then `MERGEABLE` → `poll_mergeable` returns `MERGEABLE`, total sleep time ≤ 20s.
- Mock returns `UNKNOWN` forever → returns `TIMEOUT`, exit 1.

### task_05_06 — Gate cleanup on PR state

File: `bin/pipeline-cleanup`

Find the `--remove-worktrees` action block. Before `git worktree remove`, check the task's PR state:

```bash
for task_id in "${task_ids[@]}"; do
  pr_num=$(pipeline-state read "$run_id" ".tasks.$task_id.pr_number" 2>/dev/null)

  if [[ -n "$pr_num" && "$pr_num" != "null" ]]; then
    pr_state=$(gh pr view "$pr_num" --json state -q .state 2>/dev/null || echo UNKNOWN)
    if [[ "$pr_state" != "MERGED" && "$pr_state" != "CLOSED" ]]; then
      echo "{\"warning\":\"skip_worktree\",\"task\":\"$task_id\",\"pr\":$pr_num,\"state\":\"$pr_state\"}"
      continue
    fi
  fi

  worktree_path=$(pipeline-state read "$run_id" ".tasks.$task_id.worktree" 2>/dev/null)
  if [[ -n "$worktree_path" && -d "$worktree_path" ]]; then
    git worktree remove --force "$worktree_path" || true
    ((worktrees_removed++))
  fi
done
```

Never delete a worktree whose PR is still `OPEN` or `DRAFT` — that destroys the review context.

Test in `bin/test-phase5.sh`:

- Mock `gh pr view` returns `OPEN` → `remove-worktrees` skips, `worktrees_removed == 0`, warning emitted.
- Mock returns `MERGED` → worktree removed, `worktrees_removed == 1`.
- Task has no `pr_number` in state → skip gracefully, no gh call.

## Verification

1. `bash bin/test-phase4.sh` — all new rebase/branch tests pass (6+ new tests)
2. `bash bin/test-phase5.sh` — PR-state gating tests pass (3+ new tests)
3. Grep `bin/pipeline-branch` for `grep -q staging` — zero matches (unanchored grep removed)
4. Grep `bin/pipeline-branch` for `&>/dev/null || true` on `checkout -b` — zero matches (silent failure removed)
5. Grep `bin/pipeline-wait-pr` for `rebase_with_retries` and `poll_mergeable` — both defined and called
6. Grep `bin/pipeline-wait-pr` for `force-with-lease` — at least one match (no plain `--force`)
7. `bin/pipeline-detect-pkg-manager` exists and is executable
