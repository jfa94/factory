/**
 * WS9 — token-aware git-invocation parser (ported from
 * `hooks/branch-protection.sh::_parse_git_invocation`).
 *
 * A pure tokenizer/parser: split a shell command into whitespace tokens, strip
 * env-var prefixes (`VAR=value`), find the `git` binary by basename (so
 * `/usr/bin/git`, `./git`, `git` all match), honor the pre-subcommand globals
 * `-C <dir>` and `--git-dir[=]<path>`, then parse the subcommand args. No binary
 * is invoked here — only `git symbolic-ref` (for current-branch resolution) is
 * shelled out, and THAT is done by branch-protection via the injectable exec
 * seam, not here.
 */

/** Parsed result of a single git invocation (or `subcommand:null` if no git). */
export interface GitInvocation {
  /** The git subcommand (push|reset|branch|…) or null if no `git` token found. */
  subcommand: string | null;
  /** `-C <dir>` working-dir override (empty if absent). */
  workDir: string;
  /** `--git-dir[=]<path>` override (empty if absent). */
  gitDir: string;
  /** Resolved destination branch for push (may be empty → implicit current). */
  destBranch: string;
  /** Branch named by push --delete / branch -D/-d/--delete (empty if none). */
  namedArg: string;
  /** True if --force / -f / --force-with-lease[=…] / --force-if-includes[=…]. */
  isForce: boolean;
  /** True if a `+<refspec>` force-push token was seen. */
  isPlusRef: boolean;
  /** True if `reset --hard` was seen. */
  isHardReset: boolean;
  /** True if push saw a remote token (so an implicit-current push can be detected). */
  sawRemote: boolean;
}

/** Strip one layer of surrounding single/double quotes from a token. */
function unquote(tok: string): string {
  let t = tok;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) t = t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) t = t.slice(1, -1);
  return t;
}

/** Basename of a path-like token (last `/`-separated component). */
function basename(tok: string): string {
  const parts = tok.split("/");
  return parts[parts.length - 1] ?? tok;
}

/**
 * Parse a shell command into a {@link GitInvocation}. Handles the documented
 * forms: `git push origin main`, `git -C <dir> …`, `git --git-dir=<d>/.git …`,
 * `/usr/bin/git …`, `GIT_DIR=… git …`, quoted refs, `HEAD~0:refs/heads/main`,
 * `develop:main`, `+HEAD:main`, `push --delete`, `branch -D`, `reset --hard`.
 *
 * Returns `subcommand:null` when no `git` token is present (caller treats as a
 * non-git command and passes through).
 */
export function parseGitInvocation(command: string): GitInvocation {
  const result: GitInvocation = {
    subcommand: null,
    workDir: "",
    gitDir: "",
    destBranch: "",
    namedArg: "",
    isForce: false,
    isPlusRef: false,
    isHardReset: false,
    sawRemote: false,
  };

  // Tokenize on whitespace; drop env-var prefix tokens (VAR=value / VAR=).
  const tokens = command
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));

  const n = tokens.length;
  let i = 0;

  // Walk to the `git` binary (by basename).
  let foundGit = false;
  while (i < n) {
    if (basename(tokens[i]!) === "git") {
      foundGit = true;
      i++;
      break;
    }
    i++;
  }
  if (!foundGit) return result;

  // Pre-subcommand globals: -C <dir>, --git-dir[=]<path>, skip other -* flags.
  while (i < n) {
    const tok = tokens[i]!;
    if (tok === "-C") {
      if (i + 1 < n) result.workDir = tokens[i + 1]!;
      i += 2;
      continue;
    }
    if (tok.startsWith("--git-dir=")) {
      result.gitDir = tok.slice("--git-dir=".length);
      i++;
      continue;
    }
    if (tok === "--git-dir" || tok === "--work-tree") {
      if (tok === "--git-dir" && i + 1 < n) result.gitDir = tokens[i + 1]!;
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      i++;
      continue;
    }
    result.subcommand = tok;
    i++;
    break;
  }
  if (result.subcommand === null) return result;

  // Subcommand args.
  let pushIsDelete = false;
  while (i < n) {
    const tok = unquote(tokens[i]!);
    switch (result.subcommand) {
      case "push": {
        if (
          tok === "--force" ||
          tok === "-f" ||
          tok === "--force-with-lease" ||
          tok.startsWith("--force-with-lease=") ||
          tok === "--force-if-includes" ||
          tok.startsWith("--force-if-includes=")
        ) {
          result.isForce = true;
          break;
        }
        if (tok === "--delete" || tok === "-d") {
          pushIsDelete = true;
          break;
        }
        if (tok.startsWith("-")) break;
        if (!result.sawRemote) {
          result.sawRemote = true;
          break;
        }
        if (pushIsDelete) {
          // The branch to delete (captured in the post-pass below for parity);
          // also record it here so a single `--delete <b>` is caught.
          if (result.namedArg.length === 0) result.namedArg = tok;
          break;
        }
        // Refspec → resolve destination branch.
        let stripped = tok;
        if (stripped.startsWith("+")) {
          result.isPlusRef = true;
          stripped = stripped.slice(1);
        }
        if (stripped.includes(":")) {
          stripped = stripped.slice(stripped.lastIndexOf(":") + 1);
        }
        if (stripped.startsWith("refs/heads/")) {
          stripped = stripped.slice("refs/heads/".length);
        }
        result.destBranch = stripped;
        break;
      }
      case "reset": {
        if (tok === "--hard") result.isHardReset = true;
        break;
      }
      case "branch": {
        if (tok === "-D" || tok === "-d" || tok === "--delete") {
          // The next non-flag token is the branch to delete.
          for (let j = i + 1; j < n; j++) {
            const nt = unquote(tokens[j]!);
            if (nt.startsWith("-")) continue;
            result.namedArg = nt;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
    i++;
  }

  return result;
}
