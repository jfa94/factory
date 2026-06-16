/**
 * CLI deps-wiring (C2) — construct the production reporter bundle from a run id.
 *
 * The coroutine subcommands (`factory next` / `factory drive`) and `run finalize` all
 * need the SAME bundle: the typed config, the durable spec for the run, real
 * git/gh clients, the deterministic gate tools, and the fs-backed artifact +
 * holdout stores — plus the {@link StateManager} (the only sanctioned write
 * path). This module assembles that bundle ONCE so each subcommand stays a thin
 * parse → wire → act shell.
 *
 * It deliberately produces NO agent runners: a `factory` CLI subprocess has no
 * access to the Agent tool, so every step that needs a spawn is the in-session
 * orchestrator's job. The CLI carries only the deterministic before/after seam —
 * exactly {@link HandlerDeps} + state.
 */
import { loadConfig, resolveDataDir, type DataDirOptions } from "../config/index.js";
import { StateManager } from "../core/state/index.js";
import { SpecStore } from "../spec/index.js";
import { DefaultGitClient, DefaultGhClient } from "../git/index.js";
import { defaultGateTools } from "../verifier/deterministic/index.js";
import { FsArtifactStore } from "../driver/artifacts.js";
import { FsHoldoutStore } from "../verifier/holdout/index.js";
import { StatuslineUsageSignal } from "../quota/index.js";
import { nowEpoch } from "../shared/time.js";
import type { HandlerDeps, ShipMode } from "../driver/types.js";
import type { RunState } from "../core/state/index.js";
import type { CoroutineDeps } from "../driver/coroutine.js";

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
  /** `live` serial-merges; `no-merge` (default) opens PRs but never auto-merges. */
  readonly shipMode?: ShipMode;
}

/**
 * Split a `owner/name` repo slug into its parts. A malformed slug in persisted run
 * state is a STORE-INTEGRITY defect (not user input), so it throws a plain Error —
 * loud, never silently degraded.
 */
function splitRepo(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new Error(`wiring: run spec repo must be '<owner>/<name>', got '${slug}'`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

/**
 * Assemble a {@link CoroutineDeps} bundle — {@link loadCliDeps} plus the quota signal
 * and clock. The result satisfies the coroutine engine contract.
 */
export async function loadCoroutineDeps(opts: LoadCliDepsOptions): Promise<CoroutineDeps> {
  const deps = await loadCliDeps(opts);
  return {
    ...deps,
    usage: new StatuslineUsageSignal({ dataDir: deps.dataDir }),
    now: nowEpoch,
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
    tools: defaultGateTools(),
    artifacts: new FsArtifactStore(dataDir),
    holdout: new FsHoldoutStore(dataDir),
    dataDir,
    owner,
    repo,
    shipMode: opts.shipMode ?? "no-merge",
    state,
    run,
  };
}
