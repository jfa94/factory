/**
 * WS10 — driver-local shared types (the dependency bundles wired into the
 * Model-A driver).
 *
 * ARCHITECTURE (settled, Model A — see docs/rewrite/group0-seams.md §3.5/§4 and
 * the design-intent transcript):
 *
 *   - HANDLERS are pure-ish REPORTERS. {@link makeStageHandlers} builds a
 *     {@link StageHandlers} whose methods read the frozen {@link StageContext}
 *     (run + task), do DETERMINISTIC work (shell out via injected git/gate
 *     clients), and RETURN a {@link StageResult}. When a stage needs agent work
 *     they return a `spawn-agents` manifest. They NEVER write state and NEVER
 *     decide transitions (nextStageFor does).
 *
 *   - The DRIVER acts on results. {@link driveTask}/{@link driveRun} (loop.ts) own
 *     ALL StateManager writes, ALL Agent() spawns (via the injected runners in
 *     {@link DriverRunners}), the per-invocation re-expression of the producer
 *     escalation ladder via the persisted `escalation_rung`, run-level quota
 *     pacing, and the verify-then-fix pipeline when executing a panel manifest.
 *
 *   - The v1 SESSION path is the orchestrator skill as the loop + `factory
 *     run-task --stage X` running ONE handler step (the CLI wraps
 *     {@link makeStageHandlers} + the single-step act-on-result in loop.ts). The
 *     in-process {@link driveTask}/{@link driveRun} serve tests + the v2 Workflow
 *     driver, where the runners are real Agent() spawns.
 *
 * Two deliberately-separate dependency bundles keep the reporter/actor split
 * honest: {@link HandlerDeps} carries ONLY what a reporter needs (it has no agent
 * runner — a reporter cannot spawn); {@link DriverRunners} carries the spawn
 * boundaries the loop owns.
 */
import type {
  Config,
  GhClient,
  GitClient,
  HoldoutStore,
  HoldoutValidatorRunner,
  ProducerAgentRunner,
  SpecManifest,
  StateManager,
  UsageSignal,
} from "./deps.js";
import type { GateTools } from "../verifier/deterministic/index.js";
import type { FindingVerifierRunner, RawReview, SourceReader } from "../verifier/judgment/index.js";
import type { ArtifactStore } from "./artifacts.js";

/**
 * Dry-run / cutover-safety mode (locked decision 5 / plan §Verification step 4).
 * `live` opens PRs AND serial-merges into staging; `no-merge` opens PRs but never
 * auto-merges (the cutover safety net until the rollup-CI + partial path are
 * proven). It is NOT a human-in-the-loop feature.
 */
export type ShipMode = "live" | "no-merge";

/**
 * The read-only inputs a REPORTER (handler) needs. Deliberately carries NO agent
 * runner — a handler reports a spawn manifest; the loop performs the spawn. The
 * spec MANIFEST is injected (the frozen StageContext carries only the run + a
 * lean TaskState, not the per-task spec fields the producer/verify reporters need
 * — title/description/criteria/files live in the durable spec, addressed by the
 * run's spec pointer and loaded once by the driver).
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
   * the loop's holdout-validator checks against at the verify stage.
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

/**
 * The SPAWN boundaries the LOOP owns (never a handler). Each is injectable so
 * units drive the loop with fakes (no real Agent()/Codex/gate binary). The real
 * v1 wiring binds these to live `Agent()` spawns (the CLI/skill surface, Task C/D).
 */
export interface DriverRunners {
  /** Runs a producer spawn (test-writer / executor); its commits are the effect. */
  readonly producer: ProducerAgentRunner;
  /** Runs one reviewer spawn → its raw review (pre verify-then-fix). */
  readonly reviewer: ReviewerRunner;
  /** Reads worktree file lines for citation-verify (verify-then-fix). */
  readonly source: SourceReader;
  /** Builds the independent finding-verifier for a given raw review (D27). */
  readonly makeVerifier: (review: RawReview) => FindingVerifierRunner;
  /** Runs the holdout-validator agent against the withheld answer key (Δ Y). */
  readonly holdoutValidator: HoldoutValidatorRunner;
  /** Optional run-level docs agent (Scribe survives the rewrite — invariant #7). */
  readonly scribe?: ScribeRunner;
}

/**
 * One reviewer spawn boundary: given the role + model + worktree, return that
 * reviewer's RAW review (verdict + raw findings, pre citation-verify/confirmation).
 * The loop drives the verify-then-fix over the collected raw reviews via runPanel.
 */
export interface ReviewerRunner {
  review(input: ReviewerSpawnInput): Promise<RawReview>;
}

/** Inputs to one reviewer spawn. */
export interface ReviewerSpawnInput {
  /** The reviewer role (a panel member). */
  readonly role: string;
  /** The model to run the reviewer on (panel is risk-invariant — all Opus, D26). */
  readonly model: string;
  /** Hard turn budget. */
  readonly maxTurns: number;
  /** The worktree the reviewer inspects. */
  readonly worktree: string;
  /** The task under review (for the prompt header / task_id resolution). */
  readonly taskId: string;
}

/** Optional run-level Scribe (docs) boundary. */
export interface ScribeRunner {
  document(input: { readonly worktree: string; readonly maxTurns: number }): Promise<void>;
}

/**
 * The full driver dependency set: the reporter deps + the loop's spawn runners +
 * the state manager + the run-level quota signal + the concurrency the driver
 * preset implies. {@link driveRun} consumes this.
 */
export interface DriveDeps extends HandlerDeps {
  /** The ONLY sanctioned state read/write path. */
  readonly state: StateManager;
  /** The agent-spawn boundaries the loop owns. */
  readonly runners: DriverRunners;
  /** Injectable usage signal for the two-window quota pacer (run-level). */
  readonly usage: UsageSignal;
  /**
   * Max concurrent in-flight tasks: Sequential preset = 1, Balanced preset = 3
   * (§9.1). The loop never exceeds it.
   */
  readonly concurrency: number;
  /**
   * Wall-clock source for the quota pacer, epoch SECONDS (the unit the pacer's
   * window math + {@link import("./deps.js").evaluateQuota} expect — see
   * shared/time.ts `nowEpoch`). Injectable for tests; the default wiring binds it
   * to `nowEpoch`.
   */
  readonly now: () => number;
}
