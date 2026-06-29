/**
 * CLI deps-wiring (C2) — construct the production reporter bundle from a run id.
 *
 * The orchestrator subcommands (`factory next-task` / `factory next-action`) and `run finalize` all
 * need the SAME bundle: the typed config, the durable spec for the run, real
 * git/gh clients, the deterministic gate tools, and the fs-backed artifact +
 * holdout stores — plus the {@link StateManager} (the only sanctioned write
 * path). This module assembles that bundle ONCE so each subcommand stays a thin
 * parse → wire → act shell.
 *
 * It deliberately produces NO agent runners: a `factory` CLI subprocess has no
 * access to the Agent tool, so every step that needs a spawn is the in-session
 * runner's job. The CLI carries only the deterministic before/after seam —
 * exactly {@link HandlerDeps} + state.
 */
import { loadConfig, resolveDataDir, type DataDirOptions } from "../config/index.js";
import { StateManager } from "../core/state/index.js";
import { SpecStore } from "../spec/index.js";
import { DefaultGitClient, DefaultGhClient, isValidRepoSlug } from "../git/index.js";
import { defaultGateTools } from "../verifier/deterministic/index.js";
import { FsArtifactStore, isDocsApplicable } from "../orchestrator/index.js";
import { FsHoldoutStore } from "../verifier/holdout/index.js";
import { StatuslineUsageSignal } from "../quota/index.js";
import { nowEpoch } from "../shared/time.js";
import type { HandlerDeps, ShipMode } from "../orchestrator/types.js";
import type { RunState } from "../core/state/index.js";
import type { OrchestratorDeps } from "../orchestrator/orchestrator.js";

/**
 * The full CLI reporter bundle: everything a reporter needs ({@link HandlerDeps})
 * plus the live run snapshot and the {@link StateManager}. State-write subcommands
 * mutate through `state`; reporters read `spec`/`config`/clients.
 */
export interface CliDeps extends HandlerDeps {
  /** The only sanctioned state read/write path (state-write subcommands). */
  readonly state: StateManager;
  /** The run snapshot read while wiring (saves a re-read in the common case). */
  readonly run: RunState;
}

/** Options for {@link loadCliDeps}. */
export interface LoadCliDepsOptions extends DataDirOptions {
  /** The run whose spec pointer + state the bundle is built for. */
  readonly runId: string;
  /**
   * Explicit `--ship-mode` override. When absent, {@link loadCliDeps} falls back
   * to the run's persisted `ship_mode` (the source of truth) — NOT a hard-coded
   * default — so resume/manual invocations keep the run's shipping semantics.
   */
  readonly shipMode?: ShipMode;
}

/**
 * Split a `owner/name` repo slug into its parts. A malformed slug in persisted run
 * state is a STORE-INTEGRITY defect (not user input), so it throws a plain Error —
 * loud, never silently degraded. Enforces the SAME charset as {@link isValidRepoSlug}
 * (the last gate before owner/repo reach the gh REST paths in gh-client.ts): a stale
 * run persisted before the resolveRepo charset gate must not slip `..`/metacharacters
 * through to a `/repos/{owner}/{name}` path.
 */
function splitRepo(slug: string): { owner: string; repo: string } {
  if (!isValidRepoSlug(slug)) {
    throw new Error(
      `wiring: run spec repo must be '<owner>/<name>' ([A-Za-z0-9._-], not '.'/'..'), got '${slug}'`,
    );
  }
  const parts = slug.split("/");
  return { owner: parts[0]!, repo: parts[1]! };
}

/**
 * Assemble a {@link OrchestratorDeps} bundle — {@link loadCliDeps} plus the quota signal
 * and clock. The result satisfies the orchestrator engine contract.
 */
export async function loadOrchestratorDeps(opts: LoadCliDepsOptions): Promise<OrchestratorDeps> {
  const deps = await loadCliDeps(opts);
  return {
    ...deps,
    usage: new StatuslineUsageSignal({ dataDir: deps.dataDir }),
    now: nowEpoch,
    docsApplicable: () => isDocsApplicable(process.cwd()),
  };
}

/**
 * Assemble the {@link CliDeps} bundle for `runId`. Resolves the data dir ONCE and
 * threads it through every store so they all agree on the layout; reads the run
 * state to get its `{repo, spec_id}` pointer, then loads the durable spec (LOUD if
 * the run or spec is missing/corrupt — never a silent miss).
 */
export async function loadCliDeps(opts: LoadCliDepsOptions): Promise<CliDeps> {
  const dataDir = resolveDataDir(opts);
  const dirOpts: DataDirOptions = { ...opts, dataDir };

  const config = loadConfig(dirOpts);
  const state = new StateManager({ ...dirOpts });
  const run = await state.read(opts.runId);

  const spec = await new SpecStore(dirOpts).read(run.spec.repo, run.spec.spec_id);
  const { owner, repo } = splitRepo(run.spec.repo);

  return {
    config,
    spec,
    git: new DefaultGitClient(),
    gh: new DefaultGhClient(),
    tools: defaultGateTools(config.quality.gateEnv),
    artifacts: new FsArtifactStore(dataDir),
    holdout: new FsHoldoutStore(dataDir),
    dataDir,
    owner,
    repo,
    // The explicit `--ship-mode` flag overrides; otherwise honor the value
    // persisted on the run at create (manual/resume `drive`/`finalize` omit the
    // flag, and a `ship_mode: "live"` run must not silently downgrade to no-merge).
    shipMode: opts.shipMode ?? run.ship_mode,
    state,
    run,
  };
}
