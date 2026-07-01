/**
 * `factory debug <start|review|spec|seed|finalize>` — the `/factory:debug`
 * whole-scope review⇄fix loop's deterministic seam (Decision 39 rebuild, Task 6).
 *
 * Model A: this CLI subprocess never spawns an agent. It wires together Tasks
 * 1-5's pure/composable pieces (`src/debug/review.ts`, `src/debug/spec-source.ts`,
 * `src/debug/batch.ts`) with the EXISTING run-lifecycle + spec-build seams
 * (`./run.js`'s `createRun`, `./spec.js`'s `resolveSpec`/`gateSpec`/`storeSpec`,
 * `../wiring.js`'s `loadCliDeps` + `../../orchestrator/finalize.js`'s
 * `finalizeRun`) — reused UNCHANGED, never forked. The in-session runner (Task 7's
 * SKILL.md) drives the agent spawns (the whole-scope review panel) and the
 * bounded review⇄fix loop across passes; this module owns only the deterministic
 * glue + the debug session's own scratch state.
 *
 * Loop (runner-owned; each action emits ONE JSON envelope naming the next step):
 *
 *   start   → cut the debug staging branch, mint the run id, emit the pass-1
 *             review scope (no RunState yet — a debug run is born at `seed`).
 *   review  --emit    → build + emit the whole-scope panel spawn manifest.
 *           --record  → adjudicate the runner-collected reviews, fold in the
 *                       committed e2e suite, persist the pass's confirmed
 *                       blockers, emit clean | findings.
 *   spec    resolve|gate|store → thin pass-through to `./spec.js`'s UNCHANGED
 *             resolve/gate/store, fed a SYNTHETIC PRD rendered from the pass's
 *             confirmed blockers (`src/debug/spec-source.ts`).
 *   seed    → pass 1: create the actual debug RunState (`debug:true`) from the
 *             pass-1 spec and hand off to the ordinary run driver
 *             (`next-task`/`next-action`) to execute its tasks.
 *             pass > 1: append the pass's fix tasks onto the SAME run
 *             (`src/debug/batch.ts`'s `appendTasksFromSpec`).
 *             Either way, advances the session to the NEXT pass before
 *             returning — see the "pass ownership" note below.
 *   finalize → delegates to `finalizeRun` exactly once, mirroring
 *             `run.ts`'s `runFinalize`.
 *
 * Session scratch state (NOT a `RunState` — this is debug's own private,
 * ungoverned scratch file, plain JSON via fs/promises, no StateManager-grade
 * locking/versioning): `<dataDir>/debug/<run-id>/session.json`. Findings are
 * additionally written per-pass to `<dataDir>/debug/<run-id>/pass-<n>/
 * {findings.json,findings.md}` (raw JSON + the human-readable markdown
 * rendering `report_path` points at).
 *
 * Pass ownership (this module's own invented convention — Task 7's SKILL.md
 * must follow it): `session.pass` names the round CURRENTLY being reviewed/
 * fixed. `review`/`spec` read it as-is. `seed` is the ONLY action that advances
 * it — after seeding pass N's tasks (create on N=1, append on N>1), it writes
 * `pass: N+1` before returning, so the runner's next `debug review --emit`
 * call (once pass N's tasks are terminal) naturally reviews as pass N+1
 * without any separate "advance" action. `session.base` is set ONCE at
 * `start` and never changes — the whole-scope review is always base→HEAD, so
 * later passes naturally see fewer residual findings as fixes land on the
 * same base.
 *
 * `--results` file shape for `review --record` (Task 7's SKILL.md must write
 * exactly this): `{ reviews: unknown[], verifications: ReviewerVerifications[],
 * crossVendorAbsent?: { reason: string } }` — IDENTICAL to
 * `src/orchestrator/record.ts`'s `RecordReviewsInput` (the per-task merge-gate
 * record's own input shape), reused here as {@link DebugReviewRecordInput} so
 * the runner's review-collection code is the same shape whether it is
 * recording a per-task verify pass or a whole-scope debug pass.
 */
import { join } from "node:path";
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, UsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { readJsonInput } from "../../orchestrator/index.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { readJsonFile, writeJsonFile } from "../../shared/json.js";
import { makeRunId, validateId } from "../../shared/ids.js";
import { StateManager } from "../../core/state/index.js";
import { SpecStore } from "../../spec/index.js";
import {
  DefaultGitClient,
  ensureStaging,
  runStagingBranch,
  resolveRepo,
  type GitClient,
} from "../../git/index.js";
import { loadCliDeps } from "../wiring.js";
import { finalizeRun } from "../../orchestrator/finalize.js";
import { createRun, resolveOwnerSession } from "./run.js";
import {
  resolveSpec,
  gateSpec,
  storeSpec,
  type SpecBuildDeps,
  type SpecBuildEnvelope,
} from "./spec.js";
import {
  buildReviewManifest,
  adjudicateWholeScope,
  runCommittedE2e,
  foldE2eIntoBlockers,
} from "../../debug/review.js";
import { debugIssueNumber, buildDebugReport, wireDebugSpecDeps } from "../../debug/spec-source.js";
import { appendTasksFromSpec } from "../../debug/batch.js";
import { resolveReviewModel } from "../../verifier/judgment/config.js";
import type { ReviewerVerifications } from "../../orchestrator/record.js";
import type { Finding } from "../../verifier/judgment/finding.js";
import type { PartialRunReport } from "../../scoring/index.js";
import type { RollupResult } from "../../git/index.js";
import type { Config, RunState, SpawnRequest } from "../../types/index.js";
import type { Subcommand } from "../registry-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The git empty-tree SHA (`git hash-object -t tree /dev/null`) — a well-known,
 * repo-independent constant. Never shelled out to compute (would need a real
 * git invocation for a value that never changes). `--full` diffs against this
 * so the whole-scope review scans the ENTIRE tree, not just a range.
 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Default cap on review⇄fix passes before the driver must stop looping. */
const DEFAULT_MAX_PASSES = 5;

const DEBUG_SESSION_FILE = "session.json";

const DEBUG_HELP = `factory debug — the /factory:debug whole-scope review⇄fix loop

Usage:
  factory debug start [--base <ref> | --full] [--no-ship] [--author-e2e] [--max-passes <n>] [--session-id <id>]
  factory debug review --emit --run <id>
  factory debug review --record --run <id> --results <path>
  factory debug spec resolve --run <id>
  factory debug spec gate    --run <id>
  factory debug spec store   --run <id>
  factory debug seed --run <id>
  factory debug finalize --run <id> [--no-ship]

The in-session runner drives the agent spawns (the whole-scope review panel)
AND the bounded review⇄fix loop across passes; each action emits ONE JSON
envelope naming the next step. Scratch JSON is threaded through
<dataDir>/debug/<run-id>/{session.json,pass-<n>/findings.{json,md}}.

Actions:
  start     Cut the debug staging branch, mint the run id, emit the pass-1 review scope.
  review    --emit spawns the whole-scope panel; --record adjudicates its output.
  spec      Thin pass-through to 'factory spec resolve|gate|store' fed a synthetic PRD.
  seed      Create (pass 1) or append (pass > 1) the run's tasks from the resolved spec.
  finalize  Turn an all-terminal debug run into its shipped outcome.`;

const START_HELP = `factory debug start — cut the debug staging branch and mint a run id

Usage:
  factory debug start [--base <ref> | --full] [--no-ship] [--author-e2e] [--max-passes <n>] [--session-id <id>]

  --base         Diff base for the whole-scope review. Default: HEAD~1.
  --full         Review the ENTIRE tree (diff against the empty-tree SHA) instead of --base.
                 Mutually exclusive with --base.
  --no-ship      Persist no-merge ship mode for the eventual debug run (default: live).
  --author-e2e   Persist e2e:true on the eventual debug run (opt into the e2e-authoring phase).
  --max-passes   Cap on review⇄fix passes before the driver must stop looping. Default: ${DEFAULT_MAX_PASSES}.
  --session-id   Owning Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID).

Emits { kind:"review", run_id, base, worktree, pass:1 }.`;

const REVIEW_HELP = `factory debug review — spawn or record the whole-scope review panel

Usage:
  factory debug review --emit --run <id>
  factory debug review --record --run <id> --results <path>

--results is a JSON file shaped { reviews, verifications, crossVendorAbsent? } —
IDENTICAL to the per-task merge-gate's record-reviews input shape.

Emits { kind:"review-spawn", run_id, pass, manifest, base, worktree, codex_available }
on --emit, or { kind:"clean", run_id, pass } | { kind:"findings", run_id, pass,
report_path, confirmed_count } on --record.`;

const SPEC_SUB_HELP = `factory debug spec — thin pass-through to 'factory spec' fed a synthetic PRD

Usage:
  factory debug spec resolve --run <id>
  factory debug spec gate    --run <id>
  factory debug spec store   --run <id>

Reads the pass's confirmed blockers from the debug session, renders them as a
synthetic PRD (src/debug/spec-source.ts), and calls the UNCHANGED
resolveSpec/gateSpec/storeSpec — returns their envelope verbatim.`;

const SEED_HELP = `factory debug seed — create (pass 1) or append (pass > 1) the run's tasks

Usage:
  factory debug seed --run <id>

Emits { kind:"loop", run_id }.`;

const FINALIZE_HELP = `factory debug finalize — turn an all-terminal debug run into its shipped outcome

Usage:
  factory debug finalize --run <id> [--no-ship]

Delegates to the UNCHANGED finalizeRun exactly once (mirrors 'factory run finalize').
Emits { kind:"finalized", run, report, rollup?, failure_comment_posted }.`;

// ---------------------------------------------------------------------------
// Session scratch state
// ---------------------------------------------------------------------------

/**
 * Debug's OWN private scratch state — NOT a {@link RunState}. Plain JSON,
 * read/written directly (no StateManager-grade locking/versioning: a debug
 * session is driven by exactly one runner loop, never concurrently).
 */
export interface DebugSession {
  readonly runId: string;
  /** Diff base for the whole-scope review; set once at `start`, never changes. */
  readonly base: string;
  /** The pass CURRENTLY being reviewed/fixed. See the module header's pass-ownership note. */
  readonly pass: number;
  readonly maxPasses: number;
  readonly noShip: boolean;
  readonly authorE2e: boolean;
  readonly sessionId?: string;
  /** This pass's folded confirmed blockers, persisted by `review --record`; read by `spec resolve|gate|store`. */
  readonly confirmedBlockers?: readonly Finding[];
  /** This pass's stored spec id, persisted by `spec store`; read by `seed`. */
  readonly specId?: string;
}

function debugSessionPath(dataDir: string, runId: string): string {
  return join(dataDir, "debug", runId, DEBUG_SESSION_FILE);
}

function debugPassDir(dataDir: string, runId: string, pass: number): string {
  return join(dataDir, "debug", runId, `pass-${pass}`);
}

async function readSession(dataDir: string, runId: string): Promise<DebugSession> {
  return readJsonFile<DebugSession>(debugSessionPath(dataDir, runId));
}

async function writeSession(dataDir: string, session: DebugSession): Promise<void> {
  await writeJsonFile(debugSessionPath(dataDir, session.runId), session);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** The single JSON document `start`/`review`/`seed`/`finalize` emit. `spec` returns {@link SpecBuildEnvelope} verbatim (a pass-through — see module header). */
export type DebugEnvelope =
  | {
      /** `start`'s output: the pass-1 review scope. No RunState exists yet. */
      readonly kind: "review";
      readonly run_id: string;
      readonly base: string;
      readonly worktree: string;
      readonly pass: number;
    }
  | {
      /** `review --emit`'s output: the whole-scope panel spawn manifest. */
      readonly kind: "review-spawn";
      readonly run_id: string;
      readonly pass: number;
      readonly manifest: SpawnRequest;
      readonly base: string;
      readonly worktree: string;
      readonly codex_available: boolean;
    }
  | {
      /** `review --record`'s output when the pass has zero confirmed blockers. */
      readonly kind: "clean";
      readonly run_id: string;
      readonly pass: number;
    }
  | {
      /** `review --record`'s output when the pass has ≥1 confirmed blocker. */
      readonly kind: "findings";
      readonly run_id: string;
      readonly pass: number;
      readonly report_path: string;
      readonly confirmed_count: number;
    }
  | {
      /** `seed`'s output — the run is ready for the ordinary next-task/next-action loop. */
      readonly kind: "loop";
      readonly run_id: string;
    }
  | {
      /** `finalize`'s output — mirrors `run finalize`'s envelope exactly. */
      readonly kind: "finalized";
      readonly run: RunState;
      readonly report: PartialRunReport;
      readonly rollup?: RollupResult;
      readonly failure_comment_posted: boolean;
    };

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** The deps the testable action cores need (injected in tests; production-wired by the command). */
export interface DebugDeps {
  readonly gitClient: GitClient;
  readonly config: Config;
  readonly dataDir: string;
  /** The target repo checkout the debug session operates against (the debug staging worktree). */
  readonly cwd: string;
  readonly state: StateManager;
  readonly specStore: SpecStore;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/** Options for {@link debugStart}, already parsed/validated from CLI flags. */
export interface DebugStartOptions {
  readonly full?: boolean;
  readonly base?: string;
  readonly noShip?: boolean;
  readonly authorE2e?: boolean;
  readonly maxPasses?: number;
  readonly sessionId?: string;
}

/**
 * Mint the debug run id, cut its per-run staging branch (the SAME mechanism
 * `run create` uses — `ensureStaging` + `runStagingBranch`, reused unchanged),
 * write the session's scratch state, and emit the pass-1 review scope. No
 * {@link RunState} exists yet — `seed` creates it once pass 1's spec is stored.
 */
export async function debugStart(
  deps: DebugDeps,
  opts: DebugStartOptions = {},
): Promise<DebugEnvelope> {
  if (opts.full === true && opts.base !== undefined) {
    throw new UsageError("debug start: pass exactly one of --base or --full");
  }
  const base = opts.full === true ? EMPTY_TREE_SHA : (opts.base ?? "HEAD~1");
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  if (!Number.isInteger(maxPasses) || maxPasses <= 0) {
    throw new UsageError(
      `--max-passes must be a positive integer, got '${String(opts.maxPasses)}'`,
    );
  }

  const runId = makeRunId();
  validateId(runId, "run-id");

  await ensureStaging({
    gitClient: deps.gitClient,
    stagingBranch: runStagingBranch(runId),
    baseBranch: deps.config.git.baseBranch,
    cwd: deps.cwd,
  });

  const session: DebugSession = {
    runId,
    base,
    pass: 1,
    maxPasses,
    noShip: opts.noShip === true,
    authorE2e: opts.authorE2e === true,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };
  await writeSession(deps.dataDir, session);

  return { kind: "review", run_id: runId, base, worktree: deps.cwd, pass: 1 };
}

// ---------------------------------------------------------------------------
// review --emit / --record
// ---------------------------------------------------------------------------

/**
 * Build the whole-scope panel spawn manifest for the session's current pass —
 * a thin wrapper over `src/debug/review.ts`'s `buildReviewManifest`, resolving
 * the fixed reviewer model/turn budget from config exactly as the per-task
 * verify phase does (`resolveReviewModel`, `config.review.maxTurnsDeep`).
 */
export async function debugReviewEmit(deps: DebugDeps, runId: string): Promise<DebugEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  const built = buildReviewManifest({
    resumePhase: "verify",
    model: resolveReviewModel(deps.config),
    maxTurns: deps.config.review.maxTurnsDeep,
    base: session.base,
    worktree: deps.cwd,
    codexAvailable: deps.config.codex.model !== undefined,
  });
  return {
    kind: "review-spawn",
    run_id: runId,
    pass: session.pass,
    manifest: built.manifest,
    base: built.base,
    worktree: built.worktree,
    codex_available: built.codexAvailable,
  };
}

/**
 * `--results` input shape for `review --record` — IDENTICAL to
 * `src/orchestrator/record.ts`'s `RecordReviewsInput` (see module header).
 */
export interface DebugReviewRecordInput {
  readonly reviews: readonly unknown[];
  readonly verifications: readonly ReviewerVerifications[];
  readonly crossVendorAbsent?: { readonly reason: string };
}

/**
 * Adjudicate the runner-collected whole-scope reviews (`adjudicateWholeScope`),
 * fold in the repo's COMMITTED e2e suite (`runCommittedE2e` + `foldE2eIntoBlockers`),
 * persist the pass's confirmed blockers into the session (read next by
 * `spec resolve|gate|store`), and write the findings write-up.
 */
export async function debugReviewRecord(
  deps: DebugDeps,
  runId: string,
  input: DebugReviewRecordInput,
): Promise<DebugEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  const worktree = deps.cwd;

  const adjudicated = await adjudicateWholeScope({
    reviews: input.reviews,
    verifications: input.verifications,
    worktree,
    ...(input.crossVendorAbsent !== undefined
      ? { crossVendorAbsent: input.crossVendorAbsent }
      : {}),
  });
  const e2e = await runCommittedE2e({ cwd: worktree, config: deps.config.e2e });
  const confirmedBlockers = foldE2eIntoBlockers(adjudicated.confirmedBlockers, e2e);

  await writeSession(deps.dataDir, { ...session, confirmedBlockers });

  if (confirmedBlockers.length === 0) {
    return { kind: "clean", run_id: runId, pass: session.pass };
  }

  const passDir = debugPassDir(deps.dataDir, runId, session.pass);
  const findingsPath = join(passDir, "findings.json");
  const reportPath = join(passDir, "findings.md");
  await writeJsonFile(findingsPath, { confirmedBlockers, base: session.base, pass: session.pass });
  const report = buildDebugReport({
    confirmedBlockers,
    passNumber: session.pass,
    base: session.base,
  });
  await atomicWriteFile(reportPath, report.body);

  return {
    kind: "findings",
    run_id: runId,
    pass: session.pass,
    report_path: reportPath,
    confirmed_count: confirmedBlockers.length,
  };
}

// ---------------------------------------------------------------------------
// spec resolve|gate|store — thin pass-through
// ---------------------------------------------------------------------------

/**
 * Build the debug-specific {@link SpecBuildDeps} for the session's current
 * pass: render its confirmed blockers into a synthetic PRD (`buildDebugReport`)
 * and wire `wireDebugSpecDeps` over it, reusing the SAME `SpecStore`/`dataDir`
 * as real specs (Task 3). LOUD if `review --record` has not run yet for this
 * pass — there is nothing to build a PRD from.
 */
async function specDepsFor(deps: DebugDeps, session: DebugSession): Promise<SpecBuildDeps> {
  if (session.confirmedBlockers === undefined) {
    throw new Error(
      `debug spec: run '${session.runId}' pass ${session.pass} has no recorded review — ` +
        "run 'debug review --record' first",
    );
  }
  const report = buildDebugReport({
    confirmedBlockers: session.confirmedBlockers,
    passNumber: session.pass,
    base: session.base,
  });
  return wireDebugSpecDeps(report, deps.dataDir);
}

/** Auto-derive the target repo's `owner/name` from the origin remote (mirrors `factory spec`'s `--repo` resolution — no explicit override here since debug always targets the checkout it is running in). */
async function debugRepo(deps: DebugDeps): Promise<string> {
  return resolveRepo({ cwd: deps.cwd, gitClient: deps.gitClient });
}

/** `factory debug spec resolve` — pass-through to the UNCHANGED `resolveSpec`. */
export async function debugSpecResolve(deps: DebugDeps, runId: string): Promise<SpecBuildEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  const repo = await debugRepo(deps);
  return resolveSpec(await specDepsFor(deps, session), repo, debugIssueNumber(session.pass));
}

/** `factory debug spec gate` — pass-through to the UNCHANGED `gateSpec`. */
export async function debugSpecGate(deps: DebugDeps, runId: string): Promise<SpecBuildEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  const repo = await debugRepo(deps);
  return gateSpec(await specDepsFor(deps, session), repo, debugIssueNumber(session.pass));
}

/**
 * `factory debug spec store` — pass-through to the UNCHANGED `storeSpec`. On a
 * `kind:"stored"` PASS, persists the resolved `spec_id` into the session so
 * `seed` can find it.
 */
export async function debugSpecStore(deps: DebugDeps, runId: string): Promise<SpecBuildEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  const repo = await debugRepo(deps);
  const envelope = await storeSpec(
    await specDepsFor(deps, session),
    repo,
    debugIssueNumber(session.pass),
  );
  if (envelope.kind === "stored") {
    await writeSession(deps.dataDir, { ...session, specId: envelope.pointer.spec_id });
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

/**
 * Pass 1: create the actual debug {@link RunState} (`debug:true`) from the
 * pass's stored spec via the UNCHANGED `createRun` (a debug run is always
 * fresh — no resolve-or-reuse dance). Pass > 1: append the pass's fix tasks
 * onto the SAME run's existing tasks (`appendTasksFromSpec`, Task 5). Either
 * way, advances `session.pass` to the NEXT round before returning — see the
 * module header's pass-ownership note.
 */
export async function debugSeed(deps: DebugDeps, runId: string): Promise<DebugEnvelope> {
  const session = await readSession(deps.dataDir, runId);
  if (session.specId === undefined) {
    throw new Error(
      `debug seed: run '${runId}' pass ${session.pass} has no stored spec — ` +
        "run 'debug spec store' first",
    );
  }
  const repo = await debugRepo(deps);

  if (session.pass === 1) {
    await createRun(deps.state, deps.specStore, {
      repo,
      specId: session.specId,
      runId,
      debug: true,
      intent: "fresh",
      shipMode: session.noShip ? "no-merge" : "live",
      e2e: session.authorE2e,
      ...(session.sessionId !== undefined ? { ownerSession: session.sessionId } : {}),
    });
  } else {
    const run = await deps.state.read(runId);
    const request = await deps.specStore.read(repo, session.specId);
    const merged = appendTasksFromSpec(run.tasks, request, session.pass);
    await deps.state.update(runId, (s) => ({ ...s, tasks: merged }));
  }

  await writeSession(deps.dataDir, { ...session, pass: session.pass + 1 });
  return { kind: "loop", run_id: runId };
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

/**
 * Delegate to `finalizeRun` exactly once — mirrors `run.ts`'s `runFinalize`
 * (`loadCliDeps` → `finalizeRun` → wrap the result), byte-for-byte the same
 * pattern, just re-emitted under debug's own envelope kind.
 */
export async function debugFinalize(
  deps: Pick<DebugDeps, "dataDir">,
  runId: string,
  shipMode?: RunState["ship_mode"],
): Promise<DebugEnvelope> {
  const cliDeps = await loadCliDeps({
    dataDir: deps.dataDir,
    runId,
    ...(shipMode !== undefined ? { shipMode } : {}),
  });
  const { run, report, rollup, failureCommentPosted } = await finalizeRun(cliDeps, runId);
  return {
    kind: "finalized",
    run,
    report,
    ...(rollup !== undefined ? { rollup } : {}),
    failure_comment_posted: failureCommentPosted,
  };
}

// ---------------------------------------------------------------------------
// Flag parsing + command wiring
// ---------------------------------------------------------------------------

/** Test seam: inject the git seam + cwd + data dir so `start`'s branch-cut and every action's `--repo` auto-derive are exercised with fakes and a temp data dir. Production passes none of these. */
export interface DebugOverrides {
  readonly gitClient?: GitClient;
  readonly cwd?: string;
  readonly dataDir?: string;
}

/** Wire production deps once per invocation (own wiring — mirrors `spec.ts`'s `wireDeps`). */
function wireDeps(overrides: DebugOverrides = {}): DebugDeps {
  const hasDataDirOverride = overrides.dataDir !== undefined;
  const dataDir = resolveDataDir(hasDataDirOverride ? { dataDir: overrides.dataDir } : {});
  const config = loadConfig(hasDataDirOverride ? { dataDir } : {});
  return {
    gitClient: overrides.gitClient ?? new DefaultGitClient(),
    config,
    dataDir,
    cwd: overrides.cwd ?? process.cwd(),
    state: new StateManager({ dataDir }),
    specStore: new SpecStore({ dataDir }),
  };
}

function parseMaxPasses(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--max-passes must be a positive integer, got '${raw}'`);
  }
  return n;
}

/** `factory debug start` — parse flags, wire deps, run the testable core, emit. */
export async function runDebugStart(
  argv: string[],
  overrides: DebugOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["full", "no-ship", "author-e2e"] });
  if (args.flag("help") === true) {
    emitLine(START_HELP);
    return EXIT.OK;
  }
  const base = optionalString(args.flag("base"));
  const maxPassesRaw = optionalString(args.flag("max-passes"));
  const sessionId = resolveOwnerSession(args.flag("session-id"));

  const deps = wireDeps(overrides);
  const envelope = await debugStart(deps, {
    full: args.flag("full") === true,
    ...(base !== undefined ? { base } : {}),
    noShip: args.flag("no-ship") === true,
    authorE2e: args.flag("author-e2e") === true,
    ...(maxPassesRaw !== undefined ? { maxPasses: parseMaxPasses(maxPassesRaw) } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  emitJson(envelope);
  return EXIT.OK;
}

/** `factory debug review --emit|--record` — parse flags, wire deps, run the testable core, emit. */
export async function runDebugReview(
  argv: string[],
  overrides: DebugOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["emit", "record"] });
  if (args.flag("help") === true) {
    emitLine(REVIEW_HELP);
    return EXIT.OK;
  }
  const emit = args.flag("emit") === true;
  const record = args.flag("record") === true;
  if (emit === record) {
    throw new UsageError("debug review: pass exactly one of --emit or --record");
  }
  const runId = args.requireFlag("run");
  const deps = wireDeps(overrides);

  if (emit) {
    emitJson(await debugReviewEmit(deps, runId));
    return EXIT.OK;
  }
  const resultsPath = args.requireFlag("results");
  const input = await readJsonInput<DebugReviewRecordInput>(resultsPath);
  emitJson(await debugReviewRecord(deps, runId, input));
  return EXIT.OK;
}

const SPEC_ACTIONS: Record<string, (deps: DebugDeps, runId: string) => Promise<SpecBuildEnvelope>> =
  {
    resolve: debugSpecResolve,
    gate: debugSpecGate,
    store: debugSpecStore,
  };

/** `factory debug spec <resolve|gate|store>` — parse the sub-action, wire deps, dispatch, emit. */
export async function runDebugSpec(
  argv: string[],
  overrides: DebugOverrides = {},
): Promise<ExitCode> {
  const subAction = argv[0];
  if (subAction === undefined || subAction === "--help" || subAction === "-h") {
    emitLine(SPEC_SUB_HELP);
    return EXIT.OK;
  }
  const handler = SPEC_ACTIONS[subAction];
  if (handler === undefined) {
    throw new UsageError(
      `unknown debug spec action '${subAction}' (expected resolve | gate | store)`,
    );
  }
  const args = parseArgs(argv.slice(1), {});
  if (args.flag("help") === true) {
    emitLine(SPEC_SUB_HELP);
    return EXIT.OK;
  }
  const runId = args.requireFlag("run");
  const deps = wireDeps(overrides);
  emitJson(await handler(deps, runId));
  return EXIT.OK;
}

/** `factory debug seed` — parse flags, wire deps, run the testable core, emit. */
export async function runDebugSeed(
  argv: string[],
  overrides: DebugOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, {});
  if (args.flag("help") === true) {
    emitLine(SEED_HELP);
    return EXIT.OK;
  }
  const runId = args.requireFlag("run");
  const deps = wireDeps(overrides);
  emitJson(await debugSeed(deps, runId));
  return EXIT.OK;
}

/** `factory debug finalize` — mirrors `run.ts`'s `runFinalize` exactly. */
export async function runDebugFinalize(
  argv: string[],
  overrides: DebugOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["no-ship"] });
  if (args.flag("help") === true) {
    emitLine(FINALIZE_HELP);
    return EXIT.OK;
  }
  const runId = args.requireFlag("run");
  const shipMode: RunState["ship_mode"] | undefined =
    args.flag("no-ship") === true ? "no-merge" : undefined;
  const hasDataDirOverride = overrides.dataDir !== undefined;
  const dataDir = resolveDataDir(hasDataDirOverride ? { dataDir: overrides.dataDir } : {});

  emitJson(await debugFinalize({ dataDir }, runId, shipMode));
  return EXIT.OK;
}

/**
 * The top-level dispatch map. Unlike `spec.ts`'s uniform `(deps, repo, issue)`
 * actions, debug's five actions take genuinely different flags (`start`'s
 * base/full/max-passes vs `review`'s emit/record vs `spec`'s own sub-action
 * positional) — so each `Action` here owns its OWN flag parsing + deps wiring
 * (mirroring how `run.ts`'s `runCreate`/`runResume`/`runFinalize` each do the
 * same), rather than forcing a shared parameter shape spec.ts's uniform
 * actions happen to allow.
 */
type Action = (argv: string[], overrides: DebugOverrides) => Promise<ExitCode>;

const ACTIONS: Record<string, Action> = {
  start: runDebugStart,
  review: runDebugReview,
  spec: runDebugSpec,
  seed: runDebugSeed,
  finalize: runDebugFinalize,
};

async function run(argv: string[], overrides: DebugOverrides = {}): Promise<ExitCode> {
  const action = argv[0];
  if (action === undefined || action === "--help" || action === "-h") {
    emitLine(DEBUG_HELP);
    return EXIT.OK;
  }
  const handler = ACTIONS[action];
  if (handler === undefined) {
    throw new UsageError(
      `unknown debug action '${action}' (expected start | review | spec | seed | finalize)`,
    );
  }
  return handler(argv.slice(1), overrides);
}

export const debugCommand: Subcommand = {
  describe:
    "/factory:debug — whole-scope review⇄fix loop (start → review → spec → seed → … → finalize)",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`debug: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
