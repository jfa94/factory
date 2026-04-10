# Plan 09 — Hook Script Robustness

**Priority:** P1 (major — hooks are the last line of defense for autonomous runs)
**Tasks:** `task_09_01` through `task_09_04`
**Findings:** C5, M14, M15, S1, S2

## Problem

Four robustness bugs in `hooks/`:

1. **C5 / M14 — run-tracker.sh seq counter race + fake hash chain.** `run-tracker.sh` increments a sequence counter by reading + writing a file with no lock. Two concurrent tool calls get the same seq number. It also writes a `params_hash` field described as a "tamper-evident hash chain" but each hash is computed from only the current params — there's no `prev_hash` input, so it's not a chain, just a bag of hashes.

2. **S1 — branch-protection.sh pattern-matches command string, not branch state.** The hook greps the Bash command string for `origin/main` or `push origin main`. Commands like `git push origin mainly-fixes` (decoy), or `git push origin $BRANCH` where `$BRANCH` happens to be `main`, bypass the check. It should read the actual checked-out branch via `git symbolic-ref HEAD` and match on that.

3. **M15 — stop-gate.sh missing ci_fixing / needs_human_review.** Same root cause as plan 06 task_06_02 — the stop-gate hook also independently checks task statuses and misses the in-flight set. (Plan 06 covers the pipeline-state script; this covers the hook.)

4. **S2 — env-migrations guard doesn't cover all ways to modify .env.** The guard blocks `Write(.env)` and `Edit(.env)` but a Bash command `echo X >> .env` or `sed -i s/// .env` slips through because the hook doesn't inspect Bash commands for redirections or file-mutating arguments.

## Scope

In:

- Serialize run-tracker seq counter with a file lock
- Convert `params_hash` into a real hash chain with `prev_hash`
- Rewrite branch-protection to inspect repo state, not command strings
- Extend env-migrations guard to match Bash write patterns
- Update stop-gate hook with the full in-flight status set

Out: new hook scripts (force-push-guard, rm-guard, secret-scan stubs are already covered in plan 04).

## Tasks

| task_id    | Title                                                |
| ---------- | ---------------------------------------------------- |
| task_09_01 | Serialize run-tracker seq counter with flock         |
| task_09_02 | Make params_hash a real prev_hash chain              |
| task_09_03 | Rewrite branch-protection to check actual repo state |
| task_09_04 | Extend env-migrations guard to Bash write patterns   |

## Execution Guidance

### task_09_01 — run-tracker flock

File: `hooks/run-tracker.sh`

Current:

```bash
seq=$(cat .state/$run_id/seq 2>/dev/null || echo 0)
seq=$((seq + 1))
echo "$seq" > .state/$run_id/seq
```

Race: two concurrent PostToolUse hooks read `seq=5`, both write `seq=6`.

Fix with `flock`:

```bash
bump_seq() {
  local run_id="$1"
  local seq_file=".state/$run_id/seq"
  local lock_file=".state/$run_id/seq.lock"

  mkdir -p ".state/$run_id"

  exec 9>"$lock_file"
  flock 9 || { echo "failed to acquire seq lock" >&2; return 1; }

  local seq
  seq=$(cat "$seq_file" 2>/dev/null || echo 0)
  seq=$((seq + 1))
  echo "$seq" > "$seq_file"

  exec 9>&-
  echo "$seq"
}
```

macOS ships `flock` via Homebrew (`brew install flock`) or it may be missing. Fall back:

```bash
if command -v flock >/dev/null 2>&1; then
  bump_seq_flock() { ... as above ... }
else
  # Fallback: atomic rename with unique tmp
  bump_seq_portable() {
    local run_id="$1"
    local seq_file=".state/$run_id/seq"
    local attempts=0
    while (( attempts < 10 )); do
      local tmp="${seq_file}.$$.$RANDOM"
      local current
      current=$(cat "$seq_file" 2>/dev/null || echo 0)
      local next=$((current + 1))
      echo "$next" > "$tmp"
      # Atomic link — succeeds only if target doesn't exist at this mtime
      if [[ ! -f "$seq_file" ]]; then
        mv "$tmp" "$seq_file" 2>/dev/null && { echo "$next"; return 0; }
      else
        # Compare-and-swap: only mv if target still has the same content
        local verify
        verify=$(cat "$seq_file" 2>/dev/null || echo 0)
        if [[ "$verify" == "$current" ]]; then
          mv "$tmp" "$seq_file" 2>/dev/null && { echo "$next"; return 0; }
        fi
      fi
      rm -f "$tmp"
      sleep 0.01
      attempts=$((attempts + 1))
    done
    return 1
  }
fi
```

Pragmatic alternative for macOS: add a note in the README that `flock` is required, and install via `brew install flock` as a prerequisite. The fallback above is correct but adds complexity; most users will have flock available through a package manager.

Test in `bin/test-phase9.sh` or a new `bin/test-hooks.sh`:

- Call `bump_seq` 10 times serially → returns 1..10.
- Call `bump_seq` 10 times in parallel (background) → returns 10 distinct values in 1..10.

### task_09_02 — Real hash chain

File: `hooks/run-tracker.sh`

Current:

```bash
params_hash=$(echo "$tool_input" | sha256sum | awk '{print $1}')
```

Each hash is independent. To detect tampering, each entry's hash must depend on the previous entry's hash.

Fix:

```bash
compute_chained_hash() {
  local run_id="$1"
  local current_payload="$2"
  local prev_hash_file=".state/$run_id/prev_hash"

  local prev_hash
  prev_hash=$(cat "$prev_hash_file" 2>/dev/null || echo "GENESIS")

  local combined="${prev_hash}||${current_payload}"
  local new_hash
  new_hash=$(printf '%s' "$combined" | openssl dgst -sha256 -binary | xxd -p -c 256)

  echo "$new_hash" > "$prev_hash_file"
  printf '{"prev_hash":"%s","hash":"%s"}' "$prev_hash" "$new_hash"
}
```

Then write the entry with both `prev_hash` and `hash` fields:

```bash
seq=$(bump_seq "$run_id")
chain=$(compute_chained_hash "$run_id" "$tool_input")
prev_hash=$(echo "$chain" | jq -r .prev_hash)
new_hash=$(echo "$chain" | jq -r .hash)

jq -n --argjson seq "$seq" \
     --arg tool "$tool_name" \
     --arg prev "$prev_hash" \
     --arg hash "$new_hash" \
     --arg ts "$(date -u +%FT%TZ)" \
  '{seq:$seq, tool:$tool, ts:$ts, prev_hash:$prev, hash:$hash}' \
  >> ".state/$run_id/tracker.jsonl"
```

The `tracker.jsonl` file is now a genuine append-only log where any modification to an earlier entry breaks the hash chain downstream.

Add a verification helper:

```bash
verify_chain() {
  local run_id="$1"
  local file=".state/$run_id/tracker.jsonl"
  local prev="GENESIS"
  local line_num=0

  while IFS= read -r line; do
    line_num=$((line_num + 1))
    local entry_prev entry_hash
    entry_prev=$(echo "$line" | jq -r .prev_hash)
    entry_hash=$(echo "$line" | jq -r .hash)

    if [[ "$entry_prev" != "$prev" ]]; then
      echo "{\"error\":\"chain_broken\",\"at_line\":$line_num}"
      return 1
    fi

    # Re-derive what the hash should have been from the stored params
    # (You'd need to either store the original payload or hash a canonical
    # serialization. For now, trust the stored hash value.)
    prev="$entry_hash"
  done < "$file"

  echo '{"status":"valid"}'
}
```

Note: a full verification requires storing the original payload (or a canonical form of it). The minimal version above only checks that `entry[i].prev_hash == entry[i-1].hash`, which is enough to detect re-ordering and deletion, but not tampering with the payload of a single entry. Document this limitation in the hook script header.

### task_09_03 — branch-protection checks repo state

File: `hooks/branch-protection.sh`

Current (command-string grep):

```bash
if echo "$BASH_COMMAND" | grep -q "push origin main"; then
  exit 2  # block
fi
```

Bypass: `git push origin $MY_BRANCH` where `$MY_BRANCH=main` doesn't contain the literal string `push origin main`.

Fix: inspect the actual repo state at the time the hook fires. The hook input (via stdin or env) includes the Bash command being run. Parse it enough to know what branch is the push target, then verify:

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)  # hook input as JSON
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only guard git push commands
if [[ ! "$cmd" =~ ^git[[:space:]]+push ]]; then
  exit 0
fi

# Read protected branches from config
protected_branches=("main" "master" "develop" "production" "release")
protected_pattern=$(IFS='|'; echo "${protected_branches[*]}")

# Resolve: what is the destination branch?
# Cases:
#   git push                         → current branch → upstream
#   git push origin                  → current branch → origin/<current>
#   git push origin <branch>         → <branch>
#   git push origin HEAD:<branch>    → <branch>
#   git push origin <sha>:<branch>   → <branch>

current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")

# Check 1: are we ON a protected branch AND pushing?
if [[ "$current_branch" =~ ^($protected_pattern)$ ]]; then
  echo "{\"decision\":\"block\",\"reason\":\"on_protected_branch\",\"branch\":\"$current_branch\"}" >&2
  exit 2
fi

# Check 2: extract explicit target from the command
target_branch=""
if [[ "$cmd" =~ git[[:space:]]+push[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]]+) ]]; then
  raw_target="${BASH_REMATCH[1]}"
  # Strip 'HEAD:' prefix or 'sha:' prefix
  target_branch="${raw_target##*:}"
  # Strip leading +  (force-push syntax)
  target_branch="${target_branch#+}"
fi

if [[ -n "$target_branch" && "$target_branch" =~ ^($protected_pattern)$ ]]; then
  echo "{\"decision\":\"block\",\"reason\":\"push_to_protected\",\"target\":\"$target_branch\"}" >&2
  exit 2
fi

exit 0
```

Key improvements:

- Reads actual current branch via `git symbolic-ref`
- Parses the command to extract the target refspec (handles `HEAD:branch`, `sha:branch`, `+branch` force-push)
- Two independent checks (on-protected-branch, push-to-protected-target)
- Protected-branch list is a single pattern var for easy extension

Test in `bin/test-hooks.sh` (new file):

1. Hook input with `git push origin feature-x` on a feature branch → exit 0
2. Hook input with `git push origin main` → exit 2
3. Hook input with `git push origin HEAD:main` → exit 2 (colon-syntax)
4. Hook input with `git push origin +master` → exit 2 (force-push syntax)
5. Currently on `main` with `git push origin feature` → exit 2 (on protected branch)
6. Decoy: `git push origin mainly-fixes` → exit 0 (not `main`)
7. `git commit -am main` → exit 0 (not a push command)

### task_09_04 — env/migrations guard extended to Bash

File: `hooks/env-migrations-guard.sh`

Current: fires on `Write` and `Edit` tool matchers. But a `Bash` call with `echo X >> .env` or `sed -i 's/X/Y/' .env` isn't caught.

Extend the hook to inspect Bash commands for file mutations:

```bash
#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
tool=$(echo "$input" | jq -r .tool_name)

protected_paths=(
  ".env"
  ".env.*"
  "secrets/"
  "migrations/"
  "db/migrate/"
)

check_path() {
  local path="$1"
  for pattern in "${protected_paths[@]}"; do
    if [[ "$path" == $pattern || "$path" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

case "$tool" in
  Write|Edit|MultiEdit)
    file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')
    if check_path "$file_path"; then
      echo "{\"decision\":\"block\",\"reason\":\"protected_path\",\"path\":\"$file_path\"}" >&2
      exit 2
    fi
    ;;

  Bash)
    cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

    # Patterns that mutate files
    mutation_patterns=(
      '^[[:space:]]*echo[[:space:]]+.*>[>]?[[:space:]]*([^[:space:]|;&]+)'
      '^[[:space:]]*sed[[:space:]]+-i'
      '^[[:space:]]*awk[[:space:]]+.*>[[:space:]]*([^[:space:]|;&]+)'
      '^[[:space:]]*tee[[:space:]]+([^[:space:]|;&]+)'
      '^[[:space:]]*cat[[:space:]]+.*>[[:space:]]*([^[:space:]|;&]+)'
      '[[:space:]]>[[:space:]]*([^[:space:]|;&]+)'
      '[[:space:]]>>[[:space:]]*([^[:space:]|;&]+)'
      '^[[:space:]]*rm[[:space:]]+.*([^[:space:]|;&]+)'
      '^[[:space:]]*mv[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]|;&]+)'
      '^[[:space:]]*cp[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]|;&]+)'
    )

    for pattern in "${mutation_patterns[@]}"; do
      if [[ "$cmd" =~ $pattern ]]; then
        target="${BASH_REMATCH[1]:-}"
        if [[ -n "$target" ]] && check_path "$target"; then
          echo "{\"decision\":\"block\",\"reason\":\"bash_mutates_protected\",\"target\":\"$target\"}" >&2
          exit 2
        fi
      fi
    done
    ;;
esac

exit 0
```

Limitations (document in hook header):

- Pattern matching is heuristic. A sufficiently obfuscated command can evade it (e.g. `eval`, `bash -c`, `$(printf .env)`).
- Defense-in-depth: the `permissions.deny` list in `settings.autonomous.json` (plan 04) already has explicit `Write(.env)` and `Edit(.env)` entries. This hook adds Bash-level protection on top.

Test in `bin/test-hooks.sh`:

1. Bash `echo TOKEN=xyz >> .env` → exit 2
2. Bash `sed -i '' 's/X/Y/' .env` → exit 2
3. Bash `rm .env` → exit 2
4. Bash `rm package.json` → exit 0 (not protected)
5. Bash `cat README.md > .env.sample` — exit 2 (matches `.env.*`)
6. Bash `ls .env` — exit 0 (read only)
7. Bash `echo hello > output.txt` — exit 0

## Verification

1. `bash bin/test-hooks.sh` — all new hook tests pass
2. `bash bin/test-phase9.sh` — run-tracker seq test passes under parallel load
3. Grep `hooks/branch-protection.sh` for `git symbolic-ref` — present
4. Grep `hooks/run-tracker.sh` for `prev_hash` — present (not just `params_hash`)
5. Grep `hooks/env-migrations-guard.sh` for `Bash)` case — present
6. Manually run the hooks against crafted inputs — block decisions produce exit code 2 and structured JSON reasons on stderr
