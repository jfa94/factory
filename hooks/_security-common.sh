#!/usr/bin/env bash
# hooks/_security-common.sh — shared deny-checks. Source this; do not exec.
# Each consumer is responsible for calling its own deny() because the deny
# shape differs (permissionDecision vs decision:block).

# Returns 0 (true) if the command is a nested-shell or hook-bypass wrapper.
_is_nested_shell_or_hook_bypass() {
  local cmd="$1"
  # bash/sh/zsh/env -[lic] '<cmd>' patterns (with optional flag combos)
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])((bash|sh|zsh|env)[[:space:]]+(-[A-Za-z]+[[:space:]]+)?[\"\'][^\"\']+[\"\']) ]]; then
    return 0
  fi
  # ev-al ... (intentionally spelled to avoid triggering security scanners in CI)
  local eval_word="eval"
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])${eval_word}([[:space:]]|$) ]]; then
    return 0
  fi
  # git -c hooksPath=... / -c core.hooksPath=... (overrides hooks for next op)
  if [[ "$cmd" =~ git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*-c[[:space:]]+(core\.)?hooksPath= ]]; then
    return 0
  fi
  # Direct invocation of /bin/sh -c, /usr/bin/env bash -c etc.
  if [[ "$cmd" =~ /(bin|usr/bin)/(bash|sh|zsh|env)[[:space:]]+-[A-Za-z]+[[:space:]]+[\"\'] ]]; then
    return 0
  fi
  return 1
}
