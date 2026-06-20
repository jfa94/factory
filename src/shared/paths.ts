/**
 * Path string helpers — pure, no IO.
 *
 * Extracted so BOTH settings emitters share one definition: E2 (`autonomy.ts`,
 * the `${CLAUDE_PLUGIN_DATA_TILDE}` substitution) and E1 (`target-settings.ts`,
 * the baked data-dir permission rules). The tilde form keeps a committed
 * `.claude/settings.json` git-safe (no `$HOME`/username leaked) and portable.
 */

/**
 * The `~`-shortened form of an absolute path under `$HOME` (else unchanged).
 *
 * Matches on a path-COMPONENT boundary, not a raw string prefix: with `home`
 * `/Users/jo`, `/Users/jo/x` → `~/x` and `/Users/jo` → `~`, but `/Users/job/x`
 * (a sibling that merely shares the string) stays absolute. Empty `home` is a
 * no-op so an unresolved `$HOME` never collapses every path to a bare `~`.
 */
export function tildeShorten(absPath: string, home: string): string {
  if (home.length === 0) return absPath;
  if (absPath === home) return "~";
  // Tolerate a trailing slash on `home` (homedir() omits it, but be defensive)
  // so the boundary check is "home + separator", never a bare substring match.
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (absPath.startsWith(base + "/")) {
    return "~" + absPath.slice(base.length);
  }
  return absPath;
}
