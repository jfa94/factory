/**
 * WS9 — nested-shell / hook-bypass detection (ported from
 * `hooks/_security-common.sh::_is_nested_shell_or_hook_bypass`).
 *
 * A pure `isNestedShellOrHookBypass(cmd): boolean` shared by branch-protection,
 * secret-guard, and pipeline-guards so the hook-bypass surface is ONE tested
 * unit (the bash code duplicated the function call across three hooks; here it
 * is a single seam). A nested shell, env-injection, hooksPath override, eval, or
 * heredoc/pipe-to-shell would let an executor run a sub-shell whose tool calls
 * never hit the PreToolUse guards — so while a run is active these are denied.
 *
 * The regexes are a faithful POSIX-ERE → JS translation of the bash bodies. Each
 * is documented with the bash form it mirrors. `[[:space:]]` → `\s`.
 */

/** Quote chars the bash patterns matched (`["']`). */
const Q = "[\"']";
/** A command-boundary lead-in: start, or after whitespace | ; & (the bash `(^|[[:space:]\|\;\&])`). */
const BOUNDARY = "(^|[\\s|;&])";

/**
 * The ordered set of bypass detectors. Each entry mirrors one `if [[ ... ]]`
 * block in `_is_nested_shell_or_hook_bypass`. Exported so the property test can
 * enumerate + name them.
 */
export const BYPASS_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    // bash/sh/zsh -[flags] '<cmd>' (quoted arg) — `(bash|sh|zsh) -lic '...'`.
    name: "nested-shell-quoted",
    re: new RegExp(`${BOUNDARY}(bash|sh|zsh)\\s+(-[A-Za-z]+\\s+)?${Q}[^"']+${Q}`),
  },
  {
    // env [VAR=val …] (bash|sh|zsh)  — `env bash -c`, `env -i sh -c`, `X=1 env zsh`.
    name: "env-wrapped-shell",
    re: new RegExp(
      `${BOUNDARY}env(\\s+-[A-Za-z]+)*(\\s+[A-Za-z_][A-Za-z0-9_]*=[^\\s]*)*\\s+(bash|sh|zsh)(\\s|$)`,
    ),
  },
  {
    // env [flags] '<cmd>' (quoted) — `env 'some cmd'`.
    name: "env-quoted",
    re: new RegExp(`${BOUNDARY}env(\\s+-[A-Za-z]+\\s+)?${Q}[^"']+${Q}`),
  },
  {
    // Unquoted shell script invocation: `bash some/path.sh ...` (next char is
    // non-flag, non-space). NOTE the bash class `[^-[:space:]]`.
    name: "nested-shell-script",
    re: new RegExp(`${BOUNDARY}(bash|sh|zsh)\\s+[^-\\s]`),
  },
  {
    // Heredoc/here-string into a shell: `/bin/sh << EOF`, `sh -s <<<"..."`,
    // `bash -eu <<EOF`. The `(/[^\\s]*/)?` matches a path PREFIX as a whole
    // component (trailing slash) so `/bin/sh` is caught but `evil.sh` is not.
    name: "heredoc-into-shell",
    re: new RegExp(`${BOUNDARY}(/[^\\s]*/)?(bash|sh|zsh)(\\s+-[^\\s<]+)*\\s*<<`),
  },
  {
    // Pipe whose sink is a shell: `... | bash`, `cat x | /bin/sh`. Same path-
    // component prefix so `/usr/bin/sh` matches but `transform.sh` does not.
    name: "pipe-to-shell",
    re: new RegExp(`\\|\\s*(/[^\\s]*/)?(bash|sh|zsh)(\\s|$)`),
  },
  {
    // Env-prefix injection of a shell-affecting var (BASH_ENV/ENV/SHELLOPTS/
    // BASH_FUNC_<name>%*), anchored to a command boundary so a quoted `set ENV=`
    // inside an arg is not matched. Leading benign assignments are swallowed.
    name: "env-injection",
    re: new RegExp(
      "(^\\s*|[;&|]\\s*)([A-Za-z_][A-Za-z0-9_]*=[^\\s]*\\s+)*(BASH_ENV|ENV|SHELLOPTS|BASH_FUNC_[A-Za-z0-9_]+%*)=",
    ),
  },
  {
    // ev-al (spelled split in the bash to dodge scanners) — `eval ...`.
    name: "eval",
    re: new RegExp(`${BOUNDARY}eval(\\s|$)`),
  },
  {
    // git -c hooksPath= / -c core.hooksPath= (overrides hooks for the next op).
    name: "git-hookspath-override",
    re: /git\s+(-[^\s]+\s+)*-c\s+(core\.)?hooksPath=/,
  },
  {
    // Direct absolute-path shell with a quoted -flag arg: `/bin/sh -c '...'`,
    // `/usr/bin/env bash -c '...'`.
    name: "abs-path-shell",
    re: new RegExp(`/(bin|usr/bin)/(bash|sh|zsh|env)\\s+-[A-Za-z]+\\s+${Q}`),
  },
];

/**
 * True iff `cmd` is a nested-shell or hook-bypass wrapper. Pure; no I/O. A `true`
 * means the command could spawn a sub-context whose tool calls evade the
 * PreToolUse guards — denied while a run is active.
 */
export function isNestedShellOrHookBypass(cmd: string): boolean {
  if (cmd.length === 0) return false;
  return BYPASS_PATTERNS.some((p) => p.re.test(cmd));
}

/**
 * Like {@link isNestedShellOrHookBypass} but returns WHICH detector fired (for
 * deny-reason detail + test diagnostics), or null when benign.
 */
export function matchBypass(cmd: string): string | null {
  if (cmd.length === 0) return null;
  for (const p of BYPASS_PATTERNS) {
    if (p.re.test(cmd)) return p.name;
  }
  return null;
}
