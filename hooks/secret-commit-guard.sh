#!/usr/bin/env bash
# PreToolUse Bash hook: block `git commit` or `git push` when staged/unpushed
# changes contain recognisable secrets. Scans with a baked-in blocklist;
# optionally shells out to `trufflehog` when safety.useTruffleHog is enabled.
# Findings matching safety.allowedSecretPatterns are filtered out before the
# block decision.
#
# Stdin: hook input JSON with .tool_input.command
# Exit 0 = allow, Exit 2 = block (JSON reason on stderr)
set -euo pipefail

# shellcheck source=/dev/null
source "$(dirname "$0")/_security-common.sh"

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -z "$command" ]] && exit 0

if [[ "${FACTORY_AUTONOMOUS_MODE:-}" == "1" ]] && _is_nested_shell_or_hook_bypass "$command"; then
  jq -cn --arg r "nested_shell_denied" --arg d "nested-shell or hook-bypass not allowed in autonomous mode: $command" \
    '{decision:"block", reason:$r, detail:$d}' >&2
  exit 2
fi

# Detect git commit and git push.
_is_git_commit() {
  printf '%s' "$1" | grep -qE '(^|[[:space:]]|&|;)git([[:space:]]+-[^[:space:]]+[[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'
}

_is_git_push() {
  printf '%s' "$1" | grep -qE '(^|[[:space:]]|&|;)git([[:space:]]+-[^[:space:]]+[[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)'
}

is_commit="false"
is_push="false"
_is_git_commit "$command" && is_commit="true"
_is_git_push "$command" && is_push="true"

# If neither commit nor push, nothing to scan.
if [[ "$is_commit" == "false" && "$is_push" == "false" ]]; then
  exit 0
fi

# --- Built-in path blocklist (file names that should never be committed) ---
PATH_BLOCKLIST=(
  '.env'             '.env.*'        '.env*'
  '*.pem'            '*.key'
  'id_rsa*'          'id_ed25519*'   'id_ecdsa*'   'id_dsa*'
  'credentials.json' 'credentials.yaml' 'credentials.yml'
  '*.keystore'       '*.p12'         '*.pfx'       '*.jks'
  'service-account*.json'
  '.netrc'           '*.crt'
  '*.tfvars'         '*.tfstate'     'kubeconfig'
  'firebase-adminsdk-*.json'
  '*.kdbx'           'wrangler.toml'
  '*.gpg'            '*.asc'         '*.ppk'
)

# --- Built-in content-regex patterns ---
CONTENT_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{36}'
  'ghs_[A-Za-z0-9]{36}'
  'gho_[A-Za-z0-9]{36}'
  'ghr_[A-Za-z0-9]{36}'
  'sk-ant-(api03-)?[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'xox[bpars]-[A-Za-z0-9-]{10,}'
  'AIza[A-Za-z0-9_-]{35}'
  'sk_live_[A-Za-z0-9]{20,}'
  'rk_live_[A-Za-z0-9]{20,}'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+'
  'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}'
  '"private_key"[[:space:]]*:[[:space:]]*"-----BEGIN'
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'github_pat_[A-Za-z0-9_]{60,}'
  'sk-proj-[A-Za-z0-9_-]{40,}'
  'nvapi-[A-Za-z0-9_-]{40,}'
  'xai-[A-Za-z0-9]{40,}'
)

# Load user allowlist of safe patterns (regex). Absent config → empty list.
allowed_patterns=()
config_file="${CLAUDE_PLUGIN_DATA:-}/config.json"
if [[ -f "$config_file" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && allowed_patterns+=("$line")
  done < <(jq -r '.["safety.allowedSecretPatterns"] // [] | .[]' "$config_file" 2>/dev/null || true)
fi

# Return 0 if $1 matches any allowed regex, else 1.
_is_allowed() {
  local candidate="$1" pat
  for pat in "${allowed_patterns[@]}"; do
    [[ -z "$pat" ]] && continue
    if printf '%s' "$candidate" | grep -Eq "$pat"; then
      return 0
    fi
  done
  return 1
}

# Redact a raw secret-looking string for the error output (first 4 chars + ****).
_redact() {
  local s="$1"
  local prefix="${s:0:4}"
  printf '%s****' "$prefix"
}

blocks=()

# Resolve where the git op is happening. For `git -C <dir> ...` use that dir.
commit_dir="$PWD"
# shellcheck disable=SC2016
commit_c=$(printf '%s' "$command" | grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' | head -1 | awk '{print $NF}' || true)
if [[ -n "$commit_c" ]] && [[ -d "$commit_c" ]]; then
  commit_dir="$commit_c"
fi

# If the dir isn't actually a git repo, we can't scan — fail open.
if ! git -C "$commit_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Determine scan_paths and scan_diff based on commit vs push.
scan_paths=""
scan_diff=""

if [[ "$is_commit" == "true" ]]; then
  scan_paths=$(git -C "$commit_dir" diff --cached --name-only 2>/dev/null || true)
  scan_diff=$(git -C "$commit_dir" diff --cached -U0 2>/dev/null || true)
else
  # Push scan: determine the range of unpushed commits.
  push_remote=""
  push_branch=""
  # Tokenise command, find `push`, then pull next two non-flag tokens.
  read -r -a _pt <<< "$command"
  for ((i=0; i<${#_pt[@]}; i++)); do
    if [[ "${_pt[i]}" == "push" ]]; then
      for ((j=i+1; j<${#_pt[@]}; j++)); do
        [[ "${_pt[j]}" == -* ]] && continue
        if [[ -z "$push_remote" ]]; then push_remote="${_pt[j]}"
        elif [[ -z "$push_branch" ]]; then push_branch="${_pt[j]%%:*}"; break
        fi
      done
      break
    fi
  done

  if [[ -z "$push_remote" || -z "$push_branch" ]]; then
    upstream=$(git -C "$commit_dir" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)
    if [[ -n "$upstream" ]]; then
      remote_ref="$upstream"
    else
      printf '%s\n' "secret-commit-guard: git push without upstream — push scan skipped" >&2
      exit 0
    fi
  else
    remote_ref="${push_remote}/${push_branch}"
  fi

  # Ensure remote ref exists locally; fetch if needed.
  if ! git -C "$commit_dir" rev-parse --verify "$remote_ref" >/dev/null 2>&1; then
    if [[ -n "$push_remote" && -n "$push_branch" ]]; then
      git -C "$commit_dir" fetch --quiet "$push_remote" "$push_branch" 2>/dev/null || true
    fi
  fi
  if ! git -C "$commit_dir" rev-parse --verify "$remote_ref" >/dev/null 2>&1; then
    # Brand-new branch — scan all commits reachable from HEAD.
    range_arg="HEAD"
  else
    range_arg="${remote_ref}..HEAD"
  fi

  scan_paths=$(git -C "$commit_dir" log "$range_arg" --name-only --format= 2>/dev/null | sort -u || true)
  scan_diff=$(git -C "$commit_dir" log -p "$range_arg" -U0 2>/dev/null || true)
fi

# --- Path scan ---
while IFS= read -r fpath; do
  [[ -z "$fpath" ]] && continue
  base=$(basename "$fpath")
  for glob in "${PATH_BLOCKLIST[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$base" == $glob || "$fpath" == $glob ]]; then
      if ! _is_allowed "$fpath"; then
        blocks+=("path:$fpath (matched $glob)")
      fi
      break
    fi
  done
done < <(printf '%s\n' "$scan_paths")

# --- Content-regex scan ---
if [[ -n "$scan_diff" ]]; then
  for pat in "${CONTENT_PATTERNS[@]}"; do
    while IFS= read -r hit; do
      [[ -z "$hit" ]] && continue
      if ! _is_allowed "$hit"; then
        blocks+=("content:$(_redact "$hit") (matched /$pat/)")
      fi
    done < <(printf '%s' "$scan_diff" | grep -Eo "$pat" 2>/dev/null || true)
  done
fi

# --- Optional TruffleHog scan ---
use_trufflehog="false"
if [[ -f "$config_file" ]]; then
  use_trufflehog=$(jq -r '.["safety.useTruffleHog"] // false | tostring' "$config_file" 2>/dev/null || printf 'false')
fi
if [[ "$use_trufflehog" == "true" ]]; then
  if command -v trufflehog >/dev/null 2>&1; then
    th_err=$(mktemp)
    set +e
    trufflehog_output=$(trufflehog filesystem --directory "$commit_dir" --only-verified --no-update --json 2>"$th_err")
    th_rc=$?
    set -e
    if (( th_rc != 0 )); then
      th_stderr=$(<"$th_err")
      printf '%s\n' "secret-commit-guard: trufflehog exited $th_rc — falling back to regex-only scan; stderr: ${th_stderr:0:300}" >&2
    fi
    rm -f "$th_err"
    if [[ -n "$trufflehog_output" ]]; then
      while IFS= read -r finding; do
        [[ -z "$finding" ]] && continue
        raw=$(printf '%s' "$finding" | jq -r '.Raw // empty' 2>/dev/null)
        [[ -z "$raw" ]] && continue
        if ! _is_allowed "$raw"; then
          blocks+=("trufflehog:$(_redact "$raw")")
        fi
      done <<< "$trufflehog_output"
    fi
  else
    printf '%s\n' "secret-commit-guard: trufflehog enabled in safety.useTruffleHog but not installed; falling back to regex-only" >&2
  fi
fi

if (( ${#blocks[@]} > 0 )); then
  jq -cn --argjson blocks "$(printf '%s\n' "${blocks[@]}" | jq -Rn '[inputs]')" \
    '{decision:"block", reason:"secret_detected", detail:$blocks}' >&2
  exit 2
fi

exit 0
