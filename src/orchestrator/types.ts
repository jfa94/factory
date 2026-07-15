/**
 * WS10 — orchestrator-local shared types (the reporter dependency bundle the engine
 * wires against).
 *
 * ARCHITECTURE (settled, Model A):
 *
 *   - HANDLERS are pure-ish REPORTERS. {@link import("./handlers.js").makePhaseHandlers}
 *     builds a {@link PhaseHandlers} whose methods read the frozen
 *     {@link PhaseContext} (run + task), do DETERMINISTIC work (shell out via
 *     injected git/gate clients), and RETURN a {@link PhaseResult}. When a phase
 *     needs agent work they return a `spawn-agents` request. They NEVER write
 *     state and NEVER decide transitions (nextPhaseFor does).
 *
 *   - The ENGINE acts on results. The per-task orchestrator
 *     ({@link import("./orchestrator.js").nextAction}) resumes at the persisted phase cursor,
 *     records the previous spawn's agent results into state, and runs the
 *     deterministic phase machine until it needs agents (it RETURNS the spawn
 *     request to the caller) or the task is terminal. The in-session runner
 *     owns every Agent() spawn; the engine owns every
 *     StateManager write.
 *
 * {@link HandlerDeps} carries ONLY what a reporter needs — it has no agent runner,
 * because a reporter (and the CLI subprocess that hosts it) cannot spawn. The
 * orchestrator's {@link import("./orchestrator.js").OrchestratorDeps} extends it with the state manager +
 * the quota signal.
 */
import type {Config, GhClient, GitClient, HoldoutStore, ProvisionWorktreeFn, SpecManifest, VendorProbe} from './deps.js'
import type {GateContractLoad, GateTools} from '../verifier/deterministic/index.js'

/**
 * Dry-run / cutover-safety mode (locked decision 5 / plan §Verification step 4).
 * `live` opens PRs AND serial-merges into staging; `no-merge` opens PRs but never
 * auto-merges (the cutover safety net until the rollup-CI + partial path are
 * proven). It is NOT a human-in-the-loop feature.
 *
 * SINGLE SOURCE OF TRUTH: derived from {@link ShipModeEnum} (the persisted-state
 * Zod enum) and re-exported here so the orchestrator/CLI layers keep their existing
 * `from "../orchestrator/types.js"` import while the closed set is defined exactly once.
 */
import type {ShipMode} from '../core/state/index.js'
export type {ShipMode}

/**
 * The read-only inputs a REPORTER (handler) needs. Deliberately carries NO agent
 * runner — a handler reports a spawn request; the runner performs the
 * spawn. The spec MANIFEST is injected (the frozen PhaseContext carries only the
 * run + a lean TaskState, not the per-task spec fields the producer/verify
 * reporters need — title/description/criteria/files live in the durable spec,
 * addressed by the run's spec pointer and loaded once by the engine).
 */
export interface HandlerDeps {
    readonly config: Config
    /** The loaded spec for this run (resolved from the run's spec pointer). */
    readonly spec: SpecManifest
    /** Injectable git client (worktree create in preflight). */
    readonly git: GitClient
    /**
     * Injectable worktree provisioner (installs deps after worktree create, before
     * the command-gates). Optional — defaults to the real {@link import("../git/index.js").provisionWorktree}
     * in {@link import("./handlers.js").makePhaseHandlers}; tests inject a spy.
     */
    readonly provision?: ProvisionWorktreeFn
    /** Injectable gh client (idempotent PR create in ship). */
    readonly gh: GhClient
    /** Deterministic gate tools (the verify reporter runs the GateRunner). */
    readonly tools: GateTools
    /**
     * Gate-contract loader threaded into the GateRunner. Optional — defaults to the
     * real committed-`.factory/gates.json` read over the task worktree; injectable
     * for unit tests (the runner THROWS without a contract).
     */
    readonly loadContract?: (rootAbs: string) => Promise<GateContractLoad>
    /**
     * The Δ Y answer-key store. The tests/exec reporters split the spec criteria
     * (deterministic) and persist the WITHHELD set here — the confined answer key
     * the holdout-validator checks against at the verify phase.
     */
    readonly holdout: HoldoutStore
    /** Plugin data dir — roots the run store (state/spec/holdout), NOT worktrees. */
    readonly dataDir: string
    /**
     * `<main-repo-root>/.claude/worktrees` — roots per-task worktrees + the
     * dot-prefixed scratch worktrees/results (`.docs`, `.trace`, `.results`, …).
     * `.claude/worktrees/` is the one subtree Claude Code's protected-path check
     * exempts (Decision 67) and where the orchestrator's own staging worktree
     * already lives (`run.ts`) — task worktrees/results move there too so agent
     * writes never trip the unsuppressible `~/.claude/` prompt. Resolved via
     * `GitClient.mainWorktreeRoot()`, NOT `showToplevel()` (see its doc comment).
     */
    readonly workDir: string
    /** Repo owner (PR base resolution / merge serializer). */
    readonly owner: string
    /** Repo name (PR base resolution / merge serializer). */
    readonly repo: string
    /** `live` serial-merges; `no-merge` opens PRs but never auto-merges. */
    readonly shipMode: ShipMode
    /** Re-evaluated target-repo design-system docs for implementer UI prompts. */
    readonly designSystemDocs: () => Promise<readonly string[]>
    /**
     * S5/C — injectable cross-vendor probe (tests inject a fake). Optional: the
     * verify reporter defaults to the real memoized `codex --version` probe. Never
     * consulted when `codex.model` is unconfigured (deterministic absent, no exec).
     */
    readonly vendorProbe?: VendorProbe
}
