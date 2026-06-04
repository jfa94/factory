/**
 * Secret-detection patterns + redaction — frozen seam.
 *
 * Single source of truth, ported from `bin/_secret-patterns.sh` (the CANONICAL
 * bash source; the spec's reference to `hooks/_secret-patterns.sh` is stale —
 * that file does not exist). High-entropy provider-token shapes.
 *
 * Consumers (downstream): WS9 secret-commit guard, WS6/WS12 findings redaction.
 *
 * Translation notes (POSIX ERE → JS RegExp):
 *   - `[[:space:]]` → `\s`.
 *   - Patterns are matched case-sensitively (the bash `sed -E` was too).
 *     {@link redactSecrets} compiles with the global (`g`) flag so every
 *     occurrence is replaced; {@link detectSecrets} uses a flagless `.test`
 *     (it only needs existence, not every position).
 *
 * Redaction-exclusion rule (carried over verbatim from the bash contract): any
 * pattern whose SOURCE contains a literal double-quote is EXCLUDED from
 * {@link redactSecrets}. Such a pattern (the `"private_key": "-----BEGIN`
 * detector) anchors on JSON structural quotes; redacting it would consume those
 * quotes and could invalidate a findings JSON artifact. No coverage is lost: the
 * real key material is still caught by the value-only sibling pattern
 * (`-----BEGIN ... PRIVATE KEY-----`). All other patterns match only WITHIN JSON
 * string values, so redacting valid JSON keeps it valid JSON.
 */

/** A named secret pattern. `source` is the raw regex body (no flags). */
export interface SecretPattern {
  /** Human-readable provider/shape name. */
  readonly name: string;
  /** Regex body (without flags); compiled global+case-sensitive on use. */
  readonly source: string;
}

/**
 * Content-regex patterns (provider token shapes). Order mirrors the bash array.
 * Kept as sources (not compiled RegExps) so the redaction-exclusion check on the
 * literal `"` is unambiguous and a fresh global RegExp is compiled per pass
 * (avoids shared `lastIndex` state).
 */
export const SECRET_CONTENT_PATTERNS: readonly SecretPattern[] = [
  { name: "aws-access-key-id", source: "AKIA[0-9A-Z]{16}" },
  { name: "github-pat-classic", source: "ghp_[A-Za-z0-9]{36}" },
  { name: "github-server-token", source: "ghs_[A-Za-z0-9]{36}" },
  { name: "github-oauth-token", source: "gho_[A-Za-z0-9]{36}" },
  { name: "github-refresh-token", source: "ghr_[A-Za-z0-9]{36}" },
  { name: "anthropic-api-key", source: "sk-ant-(api03-)?[A-Za-z0-9_-]{20,}" },
  { name: "openai-style-key", source: "sk-[A-Za-z0-9]{20,}" },
  { name: "slack-token", source: "xox[bpars]-[A-Za-z0-9-]{10,}" },
  { name: "google-api-key", source: "AIza[A-Za-z0-9_-]{35}" },
  { name: "stripe-live-secret", source: "sk_live_[A-Za-z0-9]{20,}" },
  { name: "stripe-live-restricted", source: "rk_live_[A-Za-z0-9]{20,}" },
  {
    name: "jwt",
    source: "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+",
  },
  {
    name: "aws-secret-access-key",
    source: "aws_secret_access_key\\s*=\\s*[A-Za-z0-9/+=]{40}",
  },
  // Quote-anchored detector — EXCLUDED from redaction (see header note).
  { name: "json-private-key", source: '"private_key"\\s*:\\s*"-----BEGIN' },
  { name: "pem-private-key", source: "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----" },
  { name: "github-pat-fine-grained", source: "github_pat_[A-Za-z0-9_]{60,}" },
  { name: "openai-project-key", source: "sk-proj-[A-Za-z0-9_-]{40,}" },
  { name: "nvidia-api-key", source: "nvapi-[A-Za-z0-9_-]{40,}" },
  { name: "xai-api-key", source: "xai-[A-Za-z0-9]{40,}" },
];

/** Does the pattern source contain a literal double-quote? (redaction-excluded) */
function hasLiteralQuote(p: SecretPattern): boolean {
  return p.source.includes('"');
}

/**
 * Patterns used for REDACTION — every content pattern except quote-anchored
 * ones (those would consume JSON structural quotes; see header note).
 */
export const SECRET_REDACTION_PATTERNS: readonly SecretPattern[] = SECRET_CONTENT_PATTERNS.filter(
  (p) => !hasLiteralQuote(p),
);

/** The literal replacement token. */
export const REDACTION_TOKEN = "[REDACTED]";

/**
 * Replace every substring matching a known (non-quote-anchored) secret pattern
 * with {@link REDACTION_TOKEN}. Single combined-alternation pass, matching the
 * bash `redact_secrets` semantics. Returns input unchanged if there are no
 * applicable patterns.
 */
export function redactSecrets(text: string): string {
  if (SECRET_REDACTION_PATTERNS.length === 0) return text;
  const combined = SECRET_REDACTION_PATTERNS.map((p) => p.source).join("|");
  // Fresh RegExp per call → no shared lastIndex; `g` for all occurrences.
  const re = new RegExp(combined, "g");
  return text.replace(re, REDACTION_TOKEN);
}

/**
 * Return the names of every pattern that matches anywhere in `text` (detection,
 * NOT redaction — includes quote-anchored patterns). Useful for a secret-commit
 * guard that needs to report WHAT was found, not just redact it.
 */
export function detectSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const p of SECRET_CONTENT_PATTERNS) {
    if (new RegExp(p.source).test(text)) hits.push(p.name);
  }
  return hits;
}
