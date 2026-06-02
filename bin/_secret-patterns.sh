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

# redact_secrets — stdin → stdout filter. Replaces every substring matching any
# known secret pattern with the literal "[REDACTED]". One combined-alternation
# sed pass; delimiter "#" is absent from every pattern and from the replacement.
# Matches stay within JSON string values (the token char-classes exclude `"`),
# so redacting a valid-JSON findings file keeps it valid JSON.
redact_secrets() {
  local IFS='|' combined
  combined="${FACTORY_SECRET_CONTENT_PATTERNS[*]}"   # join with '|' (ERE alternation)
  if [[ -z "$combined" ]]; then cat; return; fi      # never empty in practice; guard anyway
  sed -E "s#(${combined})#[REDACTED]#g"
}
