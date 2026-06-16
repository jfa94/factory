/**
 * WS9 — HARDCODED Trusted Computing Base (TCB) write-deny core (Δ W / §4 / D1).
 *
 * THE LOAD-BEARING KILL of the circular config bypass. The bash
 * `hooks/write-protection.sh` read its denylist from
 * `config.json[safety.writeBlockedPaths]` — an executor that can edit the
 * config can therefore unprotect any path, including the config itself. This
 * module's denylist is COMPILED FROM LITERALS IN THIS FILE and is NEVER read
 * from `config.json` or the Config seam. There is deliberately no parameter,
 * import, or hook by which config can widen or narrow it.
 *
 * What is protected (the trust boundary the executor must never cross):
 *   - `.github/workflows/**`        — CI / quality-gate machinery (Δ W). An
 *                                     executor that edits the gate workflow can
 *                                     make every gate pass.
 *   - gate/CI config at the repo root — `.stryker.config.json` (mutation),
 *                                     `.dependency-cruiser.cjs` (arch), and the
 *                                     scaffold templates that seed them.
 *   - `hooks/**`                    — the guard hooks themselves (an executor
 *                                     that edits a hook disables the boundary).
 *   - the OUT-OF-REPO plugin data dir — `runs/**` (run state, holdouts,
 *                                     reviews) and `specs/**` (the durable spec
 *                                     store). The holdout answer-key lives under
 *                                     `runs/<run>/holdouts/**` (Δ Y) and must be
 *                                     neither writable nor (via holdout-guard)
 *                                     readable from an executor worktree.
 *   - `docs/factory/**`              — the IN-REPO reviewable spec copy
 *                                     (F-specloc). `tasks.json` carries the
 *                                     acceptance criteria; an executor that could
 *                                     edit the in-repo mirror could weaken its own
 *                                     gate, exactly as it could via the dataDir
 *                                     spec store — so this subtree is denied too.
 *
 * Matching defeats evasion: a candidate path is normalized AND, when it exists
 * on disk, realpath-resolved before matching, so `./`, `..`, and symlink
 * escapes all collapse to the same canonical path the rule matches.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * CLOSED category enum for a protected path. A new category is a DESIGN change
 * (a deliberate compile-break across the adversarial suite), not a config tweak
 * — mirrors the WS1/WS2 closed-enum discipline.
 */
export type TcbCategory =
  | "ci-workflows"
  | "gate-config"
  | "hooks"
  | "data-runs"
  | "data-specs"
  | "docs-factory";

/** One compiled denylist rule. `test(absPath)` decides membership. */
export interface TcbRule {
  /** Which protection class this rule enforces. */
  readonly category: TcbCategory;
  /** Human-readable description of what the rule protects (for deny reasons). */
  readonly describe: string;
  /** True iff the (already canonicalized, absolute) path is protected by this rule. */
  readonly test: (absPath: string) => boolean;
}

/** A positive match: the rule that fired + the canonical path it matched. */
export interface TcbMatch {
  /** The rule that matched. */
  readonly rule: TcbRule;
  /** The canonical absolute path that matched (post normalize/realpath). */
  readonly canonical: string;
}

/**
 * Context for a TCB check. ALL fields are PATH-RESOLUTION inputs only — none is
 * a policy input. There is intentionally no `config` field: the denylist cannot
 * be widened/narrowed by config (Δ W). `dataDir` is supplied so the out-of-repo
 * run/spec stores can be protected at their absolute location, but it sets only
 * WHERE the data dir is, never WHETHER it is protected.
 */
export interface TcbContext {
  /** The repo root (target repo) absolute path. Used for `.github/`, `hooks/`. */
  readonly repoRoot?: string;
  /** The plugin data dir absolute path (out-of-repo `runs/`, `specs/`). */
  readonly dataDir?: string;
}

/** Normalize a path segment test: is `p` equal to `base` or under `base/`? */
function isAtOrUnder(p: string, base: string): boolean {
  if (p === base) return true;
  return p.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Canonicalize a rule ANCHOR (a known-directory path). Candidates are
 * realpath-resolved by {@link canonicalizePath} before matching, so an anchor
 * must be resolved the SAME way or a symlinked repoRoot/dataDir (e.g. macOS
 * `/tmp` → `/private/tmp`) would make every `isAtOrUnder` anchor miss. We
 * realpath the deepest existing ancestor and re-append any non-existent tail —
 * identical treatment to a candidate — so the two always meet on the same
 * canonical prefix.
 */
function canonicalizeAnchor(dir: string): string {
  const normalized = normalize(resolve(dir));
  try {
    if (existsSync(normalized)) return realpathSync(normalized);
  } catch {
    /* fall through */
  }
  const parts = normalized.split(sep);
  for (let cut = parts.length - 1; cut > 0; cut--) {
    const ancestor = parts.slice(0, cut).join(sep) || sep;
    try {
      if (existsSync(ancestor)) {
        const realAncestor = realpathSync(ancestor);
        const tail = parts.slice(cut).join(sep);
        return tail.length > 0 ? resolve(realAncestor, tail) : realAncestor;
      }
    } catch {
      /* keep walking up */
    }
  }
  return normalized;
}

/** Does the absolute path contain the given path component (e.g. ".github")? */
function hasComponent(absPath: string, component: string): boolean {
  return absPath.split(sep).includes(component);
}

/** Does the absolute path contain `parent/child` as adjacent components? */
function hasAdjacentComponents(absPath: string, parent: string, child: string): boolean {
  const parts = absPath.split(sep);
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === parent && parts[i + 1] === child) return true;
  }
  return false;
}

/** The basename of an absolute path (last non-empty component). */
function baseName(absPath: string): string {
  const parts = absPath.split(sep).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? "";
}

/** Root-level gate/CI config files (matched by basename anywhere in repo root). */
const GATE_CONFIG_BASENAMES = new Set<string>([
  ".stryker.config.json",
  "stryker.config.json",
  ".stryker.conf.json",
  ".dependency-cruiser.cjs",
  ".dependency-cruiser.js",
  "dependency-cruiser.config.cjs",
]);

/**
 * Build the rule set. Pure function of {@link TcbContext} (path resolution only).
 * Exported so the adversarial suite can enumerate the live rule set rather than
 * hardcode a duplicate list — a new category is then covered automatically.
 *
 * NOTE: this takes ONLY a TcbContext (paths), never a Config. That is the Δ W
 * invariant made structural: there is no parameter through which config could
 * influence the denylist.
 */
export function buildTcbRules(ctx: TcbContext = {}): readonly TcbRule[] {
  const rules: TcbRule[] = [];

  // 1. CI workflows: any `.github/workflows/**` path, anchored to a component so
  //    a benign `my.github/workflows` dir is not protected by accident. We match
  //    on the component pair so it fires for both in-repo and absolute forms.
  rules.push({
    category: "ci-workflows",
    describe: ".github/workflows/** (CI / quality-gate machinery)",
    test: (p) => hasAdjacentComponents(p, ".github", "workflows"),
  });

  // 1b. In-repo reviewable spec copy: any `docs/factory/**` path (F-specloc).
  //     Anchored to the component pair so a benign `mydocs/factory` is not caught
  //     by accident and so it fires for both in-repo and absolute forms — exactly
  //     like the .github/workflows rule. Context-free: the in-repo mirror's
  //     acceptance criteria are executor-immutable regardless of where the data
  //     dir resolves.
  rules.push({
    category: "docs-factory",
    describe: "docs/factory/** (in-repo reviewable spec copy — F-specloc)",
    test: (p) => hasAdjacentComponents(p, "docs", "factory"),
  });

  // 2. Gate/CI config files at the repo root (matched by basename so the rule is
  //    location-tolerant; an executor cannot dodge it by passing an absolute
  //    path). The scaffold templates that seed these live under templates/.
  rules.push({
    category: "gate-config",
    describe: "gate/CI config (.stryker.config.json, .dependency-cruiser.cjs)",
    test: (p) => GATE_CONFIG_BASENAMES.has(baseName(p)),
  });

  // 3. The guard hooks themselves: `hooks/**`. Anchored to the repoRoot when
  //    known (so only THIS repo's hooks dir is protected), else component-based.
  if (ctx.repoRoot) {
    const hooksDir = canonicalizeAnchor(resolve(ctx.repoRoot, "hooks"));
    rules.push({
      category: "hooks",
      describe: "hooks/** (the guard hooks — editing one disables the boundary)",
      test: (p) => isAtOrUnder(p, hooksDir),
    });
  } else {
    rules.push({
      category: "hooks",
      describe: "hooks/** (the guard hooks — editing one disables the boundary)",
      test: (p) => hasComponent(p, "hooks"),
    });
  }

  // 4. Out-of-repo run store: `<dataDir>/runs/**` (run state, holdouts, reviews).
  //    Holdouts (Δ Y) are the answer key — never writable from an executor tree.
  if (ctx.dataDir) {
    const runsDir = canonicalizeAnchor(resolve(ctx.dataDir, "runs"));
    const specsDir = canonicalizeAnchor(resolve(ctx.dataDir, "specs"));
    rules.push({
      category: "data-runs",
      describe: "<dataDir>/runs/** (run state, holdouts, reviews — Δ Y)",
      test: (p) => isAtOrUnder(p, runsDir),
    });
    rules.push({
      category: "data-specs",
      describe: "<dataDir>/specs/** (durable spec store)",
      test: (p) => isAtOrUnder(p, specsDir),
    });
  } else {
    // No data dir resolved: still protect by the canonical store component pair
    // so a Bash absolute-path write to a known data dir layout is denied even
    // before the dir is wired into ctx (defense-in-depth).
    rules.push({
      category: "data-runs",
      describe: "**/runs/{holdouts,reviews,state} (run store, dataDir unresolved)",
      test: (p) => hasComponent(p, "holdouts") || hasComponent(p, "reviews"),
    });
  }

  return rules;
}

/**
 * The default (no-context) rule set — for the adversarial suite to enumerate the
 * component-anchored rules even without a wired repo/data dir. Production callers
 * pass a context via {@link isTcbProtected} so the absolute store paths match.
 */
export const TCB_DENY: readonly TcbRule[] = buildTcbRules();

/**
 * Canonicalize a candidate path for matching: resolve to absolute (relative to
 * `cwd`), normalize away `./` and `..`, then realpath-resolve if it (or its
 * nearest existing parent) exists — defeating symlink escapes. A non-existent
 * path falls back to its normalized absolute form (the write may be a create).
 */
export function canonicalizePath(candidate: string, cwd: string = process.cwd()): string {
  const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  const normalized = normalize(abs);
  // Realpath the deepest existing ancestor so a symlinked parent dir is resolved
  // even when the leaf file does not yet exist (a create through a symlink).
  try {
    if (existsSync(normalized)) {
      return realpathSync(normalized);
    }
  } catch {
    /* realpath can race; fall through to the normalized form */
  }
  // Walk up to the nearest existing ancestor, realpath it, re-append the tail.
  const parts = normalized.split(sep);
  for (let cut = parts.length - 1; cut > 0; cut--) {
    const ancestor = parts.slice(0, cut).join(sep) || sep;
    try {
      if (existsSync(ancestor)) {
        const realAncestor = realpathSync(ancestor);
        const tail = parts.slice(cut).join(sep);
        return tail.length > 0 ? resolve(realAncestor, tail) : realAncestor;
      }
    } catch {
      /* keep walking up */
    }
  }
  return normalized;
}

/**
 * Is `candidatePath` a protected TCB path? Returns the matching {@link TcbMatch}
 * or `null`. The denylist is HARDCODED ({@link buildTcbRules}) — `ctx` only
 * resolves WHERE the out-of-repo stores live, never WHETHER a path is protected
 * (Δ W). The path is canonicalized (normalize + realpath) before matching so
 * `..`/`./`/symlink evasions resolve to the same deny as the direct path.
 */
export function isTcbProtected(
  candidatePath: string,
  ctx: TcbContext = {},
  cwd: string = process.cwd(),
): TcbMatch | null {
  if (candidatePath.length === 0) return null;
  const canonical = canonicalizePath(candidatePath, cwd);
  for (const rule of buildTcbRules(ctx)) {
    if (rule.test(canonical)) {
      return { rule, canonical };
    }
  }
  return null;
}
