#!/usr/bin/env bash
# bin/_secret-patterns.sh — single source of truth for secret-detection
# regexes. SOURCE this file; do NOT execute it. It declares an array and a
# function only — no `set -e`, no top-level execution, no env requirements — so
# it is safe to hard-source from any consumer regardless of their shell options.
#
# Consumers:
#   - hooks/secret-commit-guard.sh : blocks commits/pushes containing secrets
#   - bin/pipeline-security-gate   : redacts secrets from the findings artifact

# Content-regex patterns (POSIX ERE). High-entropy provider token shapes.
FACTORY_SECRET_CONTENT_PATTERNS=(
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

# redact_secrets — stdin → stdout filter. Replaces every substring matching a
# known secret pattern with the literal "[REDACTED]". One combined-alternation
# `sed -E` pass; delimiter "#" is absent from every pattern and from the
# replacement.
#
# Redaction excludes any pattern containing a literal double-quote. Such a
# pattern (e.g. the `"private_key": "-----BEGIN` detection pattern) anchors on
# JSON structural quotes; redacting it would consume those quotes and could
# invalidate the findings artifact. That is a detection-only refinement — the
# secret's real key material is still caught by a value-only sibling pattern
# (the `-----BEGIN … PRIVATE KEY-----` marker), so excluding it loses no
# coverage. All other patterns match only within JSON string values (their
# char-classes exclude `"`), so redacting valid JSON keeps it valid JSON.
redact_secrets() {
  local pats=() p
  for p in "${FACTORY_SECRET_CONTENT_PATTERNS[@]}"; do
    if [[ "$p" == *'"'* ]]; then continue; fi
    pats+=("$p")
  done
  local IFS='|' combined
  combined="${pats[*]}"
  if [[ -z "$combined" ]]; then cat; return; fi
  sed -E "s#(${combined})#[REDACTED]#g"
}
