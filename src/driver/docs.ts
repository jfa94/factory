import { join } from "node:path";
import { resolveStagingBranch, type Config, type GitClient, type StateManager } from "./deps.js";

export interface DocsRunDeps {
  readonly state: StateManager;
  readonly git: GitClient;
  readonly config: Config;
  readonly dataDir: string;
}

export type DocsEnvelope =
  | {
      readonly kind: "spawn";
      readonly run_id: string;
      readonly worktree: string;
      readonly base_ref: string;
      readonly staging_branch: string;
      readonly docs_branch: string;
      readonly model: string;
      readonly max_turns: number;
      readonly prompt: string;
    }
  | { readonly kind: "done"; readonly run_id: string }
  | { readonly kind: "blocked"; readonly run_id: string; readonly reason: string };

const DOCS_MODEL = "opus";
const DOCS_MAX_TURNS = 60;

/** The docs-stage worktree path for a run (under the run store). */
export function docsWorktreePath(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "docs-worktree");
}

function buildScribePrompt(worktree: string, baseRef: string): string {
  return [
    "You are the factory scribe running the pipeline's documentation stage.",
    `1. cd into your worktree: ${worktree} (already checked out on the docs branch off the staging tip).`,
    `2. Determine the whole-PRD change set with: git diff ${baseRef}..HEAD`,
    "3. Update /docs (Diátaxis) to reflect those changes, per agents/scribe.md.",
    "4. COMMIT your changes IN this worktree. Do NOT push (the engine pushes on fold).",
    "5. If nothing material changed, make no commit.",
    'Finish with your terminal STATUS line and return it as {"status": "<line>"}.',
  ].join("\n");
}

/** Emit the docs spawn manifest: prepare the staging-rooted worktree, name scribe. */
export async function runDocsEmit(deps: DocsRunDeps, runId: string): Promise<DocsEnvelope> {
  const run = await deps.state.read(runId);
  const staging = resolveStagingBranch(runId, run.staging_branch);
  const base = deps.config.git.baseBranch;
  const docsBranch = `docs-${runId}`;
  const worktree = docsWorktreePath(deps.dataDir, runId);
  const baseRef = `origin/${base}`;

  await deps.git.fetch("origin", staging);
  await deps.git.fetch("origin", base);
  // Idempotent on resume: a prior (failed) attempt leaves the worktree in place; real
  // `git worktree add` FATALS on an existing path, so reuse it instead of re-creating.
  if (!(await deps.git.worktreeExists(worktree))) {
    await deps.git.worktreeAdd(["-b", docsBranch, worktree, `origin/${staging}`]);
  }

  return {
    kind: "spawn",
    run_id: runId,
    worktree,
    base_ref: baseRef,
    staging_branch: staging,
    docs_branch: docsBranch,
    model: DOCS_MODEL,
    max_turns: DOCS_MAX_TURNS,
    prompt: buildScribePrompt(worktree, baseRef),
  };
}
