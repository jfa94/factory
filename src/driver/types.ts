/**
 * WS10 — driver-local shared types (the reporter dependency bundle the engine
 * wires against).
 *
 * ARCHITECTURE (settled, Model A — see docs/rewrite/group0-seams.md §3.5/§4 and
 * the design-intent transcript):
 *
 *   - HANDLERS are pure-ish REPORTERS. {@link import("./handlers.js").makeStageHandlers}
 *     builds a {@link StageHandlers} whose methods read the frozen
 *     {@link StageContext} (run + task), do DETERMINISTIC work (shell out via
 *     injected git/gate clients), and RETURN a {@link StageResult}. When a stage
 *     needs agent work they return a `spawn-agents` manifest. They NEVER write
 *     state and NEVER decide transitions (nextStageFor does).
 *
 *   - The ENGINE acts on results. The per-task coroutine
 *     ({@link import("./coroutine.js").stepTask}) resumes at the persisted stage cursor,
 *     folds the previous spawn's agent results into state, and runs the
 *     deterministic stage machine until it needs agents (it RETURNS the spawn
 *     manifest to the caller) or the task is terminal. The in-session orchestrator
 *     (or the workflow driver) owns every Agent() spawn; the engine owns every
 *     StateManager write.
 *
 * {@link HandlerDeps} carries ONLY what a reporter needs — it has no agent runner,
 * because a reporter (and the CLI subprocess that hosts it) cannot spawn. The
 * coroutine's {@link import("./coroutine.js").CoroutineDeps} extends it with the state manager +
 * the quota signal.
 */
import type { Config, GhClient, GitClient, HoldoutStore, SpecManifest } from "./deps.js";
import type { GateTools } from "../verifier/deterministic/index.js";
import type { ArtifactStore } from "./artifacts.js";

/**
 * Dry-run / cutover-safety mode (locked decision 5 / plan §Verification step 4).
 * `live` opens PRs AND serial-merges into staging; `no-merge` opens PRs but never
 * auto-merges (the cutover safety net until the rollup-CI + partial path are
 * proven). It is NOT a human-in-the-loop feature.
 *
 * SINGLE SOURCE OF TRUTH: derived from {@link ShipModeEnum} (the persisted-state
 * Zod enum) and re-exported here so the driver/CLI layers keep their existing
 * `from "../driver/types.js"` import while the closed set is defined exactly once.
 */
import type { ShipMode } from "../core/state/index.js";
export type { ShipMode };

/**
 * The read-only inputs a REPORTER (handler) needs. Deliberately carries NO agent
 * runner — a handler reports a spawn manifest; the orchestrator performs the
 * spawn. The spec MANIFEST is injected (the frozen StageContext carries only the
 * run + a lean TaskState, not the per-task spec fields the producer/verify
 * reporters need — title/description/criteria/files live in the durable spec,
 * addressed by the run's spec pointer and loaded once by the engine).
 */
export interface HandlerDeps {
  readonly config: Config;
  /** The loaded spec for this run (resolved from the run's spec pointer). */
  readonly spec: SpecManifest;
  /** Injectable git client (worktree create in preflight). */
  readonly git: GitClient;
  /** Injectable gh client (idempotent PR create in ship). */
  readonly gh: GhClient;
  /** Deterministic gate tools (the verify reporter runs the GateRunner). */
  readonly tools: GateTools;
  /** Persists producer prompt-context artifacts; references them via prompt_ref. */
  readonly artifacts: ArtifactStore;
  /**
   * The Δ Y answer-key store. The tests/exec reporters split the spec criteria
   * (deterministic) and persist the WITHHELD set here — the confined answer key
   * the holdout-validator checks against at the verify stage.
   */
  readonly holdout: HoldoutStore;
  /** Plugin data dir — roots the run store + per-task worktree paths. */
  readonly dataDir: string;
  /** Repo owner (PR base resolution / merge serializer). */
  readonly owner: string;
  /** Repo name (PR base resolution / merge serializer). */
  readonly repo: string;
  /** `live` serial-merges; `no-merge` opens PRs but never auto-merges. */
  readonly shipMode: ShipMode;
}
