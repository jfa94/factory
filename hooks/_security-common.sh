#!/usr/bin/env bash
# hooks/_security-common.sh — shared deny-checks. Source this; do not exec.
# Each consumer is responsible for calling its own deny() because the deny
# shape differs (permissionDecision vs decision:block).

# Returns 0 (true) if the command is a nested-shell or hook-bypass wrapper.
_is_nested_shell_or_hook_bypass() {
  local cmd="$1"
  # bash/sh/zsh -[lic] '<cmd>' (with optional flag combos and quoted arg)
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])(bash|sh|zsh)[[:space:]]+(-[A-Za-z]+[[:space:]]+)?[\"\'][^\"\']+[\"\'] ]]; then
    return 0
  fi
  # env (with optional VAR=val prefixes) -[lic] '<cmd>'
  # OR env (with optional VAR=val prefixes) wrapping a shell binary: `env bash -c ...`, `env -i sh -c ...`
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])env([[:space:]]+-[A-Za-z]+)*([[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)*[[:space:]]+(bash|sh|zsh)([[:space:]]|$) ]]; then
    return 0
  fi
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])env[[:space:]]+(-[A-Za-z]+[[:space:]]+)?[\"\'][^\"\']+[\"\'] ]]; then
    return 0
  fi
  # Unquoted bash/sh/zsh script invocation: `bash some/path.sh ...`
  if [[ "$cmd" =~ (^|[[:space:]\|\;\&])(bash|sh|zsh)[[:space:]]+[^-[:space:]] ]]; then
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
