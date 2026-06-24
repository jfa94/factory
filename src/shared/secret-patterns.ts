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
 * Published, PUBLIC tokens that are secret-shaped but documented non-secrets.
 * Stripped from the input before detection so they don't false-positive. A
 * garbled/wrong entry simply fails CLOSED (still blocks), never open.
 *
 * Stored as [header, payload, signature] tuples and assembled at runtime —
 * same pattern as the test file — so this source file carries no JWT-shaped
 * string that would trip the guard on commit. Verify components against
 * `supabase status` or https://supabase.com/docs/guides/local-development
 *
 * Supabase CLI local-dev tokens (signed with the published default JWT secret
 * "super-secret-jwt-token-with-at-least-32-characters-long"; iss:supabase-demo).
 */
// prettier-ignore
const _KNOWN_PUBLIC_TOKEN_PARTS: readonly [string, string, string][] = [
  // anon role
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9",
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  ],
  // service_role
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0",
    "EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  ],
];
export const KNOWN_PUBLIC_TOKENS: readonly string[] = _KNOWN_PUBLIC_TOKEN_PARTS.map((p) =>
  p.join("."),
);

/**
 * Return the names of every pattern that matches anywhere in `text` (detection,
 * NOT redaction — includes quote-anchored patterns). Useful for a secret-commit
 * guard that needs to report WHAT was found, not just redact it.
 *
 * Known public tokens (e.g. published Supabase local-dev JWTs) are stripped
 * before scanning so they don't false-positive. A real (non-default) JWT of the
 * same shape still triggers the `jwt` pattern.
 */
export function detectSecrets(text: string): string[] {
  const scrubbed = KNOWN_PUBLIC_TOKENS.reduce((t, tok) => t.split(tok).join(""), text);
  const hits: string[] = [];
  for (const p of SECRET_CONTENT_PATTERNS) {
    if (new RegExp(p.source).test(scrubbed)) hits.push(p.name);
  }
  return hits;
}
