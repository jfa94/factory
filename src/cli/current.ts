/**
 * Resolve the run that is "current" FOR THE REPO OF THE CALLER'S CHECKOUT
 * (run-isolation L2.8). The human-facing read commands (`state`, `score`, `rescue`,
 * `run resume`/`finalize`) default to this when no `--run` is given, so two runs
 * live in two different checkouts each resolve their OWN run — never whichever one
 * happened to repoint the global pointer last.
 *
 * Repo resolution mirrors `run create`'s {@link RunCreateOverrides} seam exactly:
 * derive `owner/name` from the `origin` remote of `cwd` via {@link resolveRepo}, with
 * the git client + cwd injectable for tests. When the repo is NOT derivable (invoked
 * outside any checkout / no `origin`), fall back to the legacy GLOBAL `runs/current`
 * pointer (repo-less "most-recent") rather than failing — a bare `factory state` in a
 * scratch dir must still work. The per-repo reader ({@link StateManager.readCurrentForRepo})
 * itself read-throughs to the same-repo legacy pointer for pre-upgrade in-flight runs.
 *
 * NOTE this is intentionally NOT used by `factory next`: that command is machine-driven
 * (the workflow/orchestrator bootstrap), always passes `--run` on the hot path, and its
 * no-`--run` fallback is guarded against a foreign run by `--assert-owner`/`--expect-mode`.
 */
import { DefaultGitClient, resolveRepo, type GitClient } from "../git/index.js";
import type { RunState, StateManager } from "../core/state/index.js";

/** Test seam: inject the git client + cwd (parity with {@link RunCreateOverrides}). */
export interface CurrentRunOverrides {
  readonly gitClient?: GitClient;
  readonly cwd?: string;
}

/**
 * The current run for the caller's checkout, or `null` when none. Resolves the repo
 * from `cwd`'s `origin` remote and reads that repo's pointer; degrades to the global
 * pointer when the repo cannot be derived. Never throws on repo resolution itself.
 */
export async function readCurrentForCwd(
  state: StateManager,
  overrides: CurrentRunOverrides = {},
): Promise<RunState | null> {
  const cwd = overrides.cwd ?? process.cwd();
  const gitClient = overrides.gitClient ?? new DefaultGitClient();
  let repo: string;
  try {
    repo = await resolveRepo({ cwd, gitClient });
  } catch {
    // Not a checkout / no origin remote → repo-less legacy "most-recent" pointer.
    return state.readCurrent();
  }
  return state.readCurrentForRepo(repo);
}
