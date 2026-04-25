#!/usr/bin/env bash
# PreToolUse hook: block destructive git operations on protected branches.
#
# Stdin: hook input JSON with .tool_input.command
# Exit 0 = allow, Exit 2 = block (reason on stderr as JSON)
#
# The parser recognises all of:
#   git push origin main
#   git -C <dir> push origin main
#   /usr/bin/git push origin main
#   GIT_DIR=... git push origin main
#   git push origin "main"
#   git push origin HEAD~0:refs/heads/main
#   git push origin develop:main
#   git push origin +HEAD:main (force-refspec)
#
# Implementation:
#   _parse_git_invocation() is called once and populates shared variables.
#   All checks (1-7) read from those variables — no re-tokenisation.
set -euo pipefail

PROTECTED_BRANCHES=("main" "master" "develop")

# Build an alternation regex with explicit anchors so `mainly-fixes` !~ main.
PROTECTED_RE="^($(IFS='|'; echo "${PROTECTED_BRANCHES[*]}"))$"

# Read hook input from stdin
input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

if [[ -z "$command" ]]; then
  exit 0
fi

# Helper: print a JSON block reason and exit 2.
_block() {
  local reason="$1" detail="$2"
  jq -cn --arg r "$reason" --arg d "$detail" \
    '{decision:"block", reason:$r, detail:$d}' >&2
  exit 2
}

# Helper: is the given name in the protected set?
_is_protected() {
  local name="$1"
  [[ "$name" =~ $PROTECTED_RE ]]
}

# ---------------------------------------------------------------------------
# Token-aware git invocation parser.
#
# Populates global variables (memoised — call once, read many):
#   _git_subcommand   push | reset | branch | (empty if no git found)
#   _git_subflags     space-joined flags found after the subcommand
#   _git_dest_branch  resolved destination branch for push (may be empty)
#   _git_named_arg    branch/ref after --delete / --hard / -D / -d
#   _git_is_force     "1" if --force / -f / --force-with-lease present
#   _git_is_plus_ref  "1" if a +<refspec> token was seen
# ---------------------------------------------------------------------------
_parse_git_invocation() {
  # Already parsed — nothing to do.
  [[ -n "${_GIT_PARSED:-}" ]] && return 0
  _GIT_PARSED=1

  _git_subcommand=""
  _git_subflags=""
  _git_dest_branch=""
  _git_named_arg=""
  _git_is_force="0"
  _git_is_plus_ref="0"

  # Tokenise: split on whitespace, strip env-var prefixes (VAR=value tokens),
  # and strip a leading directory path from the git binary so that
  # `/usr/bin/git`, `./git`, etc. all match as "git".
  local tokens=()
  while IFS= read -r tok; do
    [[ -z "$tok" ]] && continue
    # Skip env-var prefix tokens (VAR=value or VAR= ).
    [[ "$tok" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && continue
    tokens+=("$tok")
  done < <(printf '%s\n' "$command" | tr -s '[:space:]' '\n')

  local n=${#tokens[@]}
  local i=0
  local found_git=0

  # Walk until we find a token whose basename is "git".
  while (( i < n )); do
    local tok="${tokens[i]}"
    local base_tok
    base_tok=$(basename -- "$tok")
    if [[ "$base_tok" == "git" ]]; then
      found_git=1
      i=$((i + 1))
      break
    fi
    i=$((i + 1))
  done

  [[ $found_git -eq 0 ]] && return 0

  # Skip -C <dir> and other git-global flags that appear before the subcommand.
  while (( i < n )); do
    local tok="${tokens[i]}"
    if [[ "$tok" == "-C" || "$tok" == "--work-tree" || "$tok" == "--git-dir" ]]; then
      # These consume the next token as their argument.
      i=$((i + 2))
      continue
    fi
    if [[ "$tok" == -* ]]; then
      i=$((i + 1))
      continue
    fi
    # First non-flag token is the subcommand.
    _git_subcommand="$tok"
    i=$((i + 1))
    break
  done

  [[ -z "$_git_subcommand" ]] && return 0

  # Parse the rest of the arguments depending on the subcommand.
  local saw_remote=0
  while (( i < n )); do
    local tok="${tokens[i]}"

    # Strip surrounding double-quotes (handles `git push origin "main"`).
    tok="${tok#\"}"
    tok="${tok%\"}"

    case "$_git_subcommand" in
      push)
        # Detect force flags.
        if [[ "$tok" == "--force" || "$tok" == "-f" || "$tok" == "--force-with-lease" ]]; then
          _git_is_force="1"
          i=$((i + 1)); continue
        fi
        # Skip other flags.
        if [[ "$tok" == -* ]]; then
          i=$((i + 1)); continue
        fi
        # Remote (first non-flag token).
        if (( saw_remote == 0 )); then
          saw_remote=1
          i=$((i + 1)); continue
        fi
        # Refspec token(s).
        local stripped="$tok"
        # Detect leading + (force-push refspec syntax).
        if [[ "$stripped" == +* ]]; then
          _git_is_plus_ref="1"
          stripped="${stripped#+}"
        fi
        # Resolve destination: strip everything up to and including the last `:`.
        # `HEAD:refs/heads/main` → `refs/heads/main`; `develop:main` → `main`.
        if [[ "$stripped" == *:* ]]; then
          stripped="${stripped##*:}"
        fi
        # Normalise refs/heads/<name> → <name>.
        stripped="${stripped#refs/heads/}"
        _git_dest_branch="$stripped"
        ;;

      reset)
        if [[ "$tok" == "--hard" ]]; then
          # Next non-flag token is the ref.
          local j=$((i + 1))
          while (( j < n )); do
            local nt="${tokens[j]}"
            [[ "$nt" == -* ]] && { j=$((j + 1)); continue; }
            # Strip remote prefix (origin/main → main).
            _git_named_arg="${nt##*/}"
            break
          done
        fi
        ;;

      branch)
        if [[ "$tok" == "-D" || "$tok" == "-d" ]]; then
          local j=$((i + 1))
          while (( j < n )); do
            local nt="${tokens[j]}"
            [[ "$nt" == -* ]] && { j=$((j + 1)); continue; }
            _git_named_arg="$nt"
            break
          done
        fi
        # --delete also works for branch deletion.
        if [[ "$tok" == "--delete" ]]; then
          local j=$((i + 1))
          while (( j < n )); do
            local nt="${tokens[j]}"
            [[ "$nt" == -* ]] && { j=$((j + 1)); continue; }
            _git_named_arg="$nt"
            break
          done
        fi
        ;;
    esac

    i=$((i + 1))
  done

  # For push with --delete, capture the branch name that follows.
  if [[ "$_git_subcommand" == "push" ]]; then
    # Re-scan for --delete <branch> in push context.
    local j=0
    local in_push_delete=0
    while (( j < n )); do
      local tok="${tokens[j]}"
      tok="${tok#\"}"
      tok="${tok%\"}"
      if [[ "$tok" == "--delete" ]]; then
        in_push_delete=1
        j=$((j + 1)); continue
      fi
      if (( in_push_delete == 1 )) && [[ "$tok" != -* ]]; then
        _git_named_arg="$tok"
        break
      fi
      j=$((j + 1))
    done
  fi

  # If push had no refspec, fall back to current branch (implicit push).
  if [[ "$_git_subcommand" == "push" && -z "$_git_dest_branch" && $saw_remote -eq 1 ]]; then
    _git_dest_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  fi
}

# Ensure parsed on first access.
_parse_git_invocation

# --- Check 1: are we currently on a protected branch and pushing implicitly? ---
if [[ "$_git_subcommand" == "push" ]]; then
  current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [[ -n "$current_branch" ]] && _is_protected "$current_branch"; then
    if [[ -z "$_git_dest_branch" || "$_git_dest_branch" == "$current_branch" ]]; then
      _block "on_protected_branch" "currently on '$current_branch' — push will publish to protected"
    fi
  fi
fi

# --- Check 2: git push --force / -f / --force-with-lease to a protected target ---
if [[ "$_git_subcommand" == "push" && "$_git_is_force" == "1" ]]; then
  if [[ -n "$_git_dest_branch" ]] && _is_protected "$_git_dest_branch"; then
    _block "force_push_protected" "force-push targets protected branch '$_git_dest_branch'"
  fi
fi

# --- Check 3: git push +refspec force-syntax to a protected branch ---
if [[ "$_git_subcommand" == "push" && "$_git_is_plus_ref" == "1" ]]; then
  if [[ -n "$_git_dest_branch" ]] && _is_protected "$_git_dest_branch"; then
    _block "force_push_refspec_protected" "+refspec force-push targets protected branch '$_git_dest_branch'"
  fi
fi

# --- Check 4: plain `git push <remote> <protected>` (or HEAD:<protected>) ---
if [[ "$_git_subcommand" == "push" ]]; then
  if [[ -n "$_git_dest_branch" ]] && _is_protected "$_git_dest_branch"; then
    _block "push_to_protected" "push targets protected branch '$_git_dest_branch'"
  fi
fi

# --- Check 5: git push <remote> --delete <protected> ---
if [[ "$_git_subcommand" == "push" && -n "$_git_named_arg" ]]; then
  if _is_protected "$_git_named_arg"; then
    _block "remote_delete_protected" "remote deletion of protected branch '$_git_named_arg'"
  fi
fi

# --- Check 6: git reset --hard <protected> ---
if [[ "$_git_subcommand" == "reset" && -n "$_git_named_arg" ]]; then
  if _is_protected "$_git_named_arg"; then
    _block "hard_reset_protected" "hard reset targets protected branch '$_git_named_arg'"
  fi
fi

# --- Check 7: git branch -D / -d <protected> ---
if [[ "$_git_subcommand" == "branch" && -n "$_git_named_arg" ]]; then
  if _is_protected "$_git_named_arg"; then
    _block "delete_protected_branch" "deletion of protected branch '$_git_named_arg'"
  fi
fi

# All checks passed — allow
exit 0
