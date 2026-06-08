/**
 * Identifier helpers — frozen seam (WS1/WS3/WS5 share these for run-id, task-id,
 * and spec-id slugs rather than re-deriving the rules three times).
 *
 * Ports two bash utilities:
 *   - `_validate_id`  — charset [a-zA-Z0-9_-], length 1..64.
 *   - `slugify`       — lowercase, non-alnum → '-', collapse/trim '-', cap 50.
 */

/** The exact id charset/length contract, as a RegExp. */
export const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Maximum slug length (chars), matching the bash `head -c 50`. */
export const SLUG_MAX_LENGTH = 50;

/** True iff `id` is a safe identifier (`^[a-zA-Z0-9_-]{1,64}$`). */
export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Assert `id` is a valid identifier; throw a descriptive error otherwise.
 * `label` names the field in the error message (e.g. "run-id", "task-id").
 */
export function validateId(id: string, label = "id"): string {
  if (id.length === 0) {
    throw new Error(`${label}: empty`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${label}: invalid (must match ${ID_PATTERN.source}): ${id}`);
  }
  return id;
}

/**
 * Build a run id `run-YYYYMMDD-HHMMSS` (UTC) from a clock instant. The shape
 * matches the bash `run-$(date +%Y%m%d-%H%M%S)`, but anchored to UTC so a run id
 * is timezone-stable. The result is always a valid {@link isValidId}.
 *
 * NOTE: two runs created within the same second collide; {@link StateManager.create}
 * refuses to clobber, so the loser fails LOUDLY rather than overwriting. The CLI
 * accepts an explicit `--run-id` to override (tests + determinism).
 */
export function makeRunId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `run-${date}-${time}`;
}

/**
 * Convert an arbitrary string to a branch-safe slug:
 * lowercase → non-alphanumerics to '-' → collapse runs of '-' → trim leading/
 * trailing '-' → truncate to {@link SLUG_MAX_LENGTH}. May return "" for input
 * with no alphanumerics (caller decides how to handle an empty slug).
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, SLUG_MAX_LENGTH);
}
