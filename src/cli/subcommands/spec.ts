/**
 * `factory spec <resolve|gate|store>` — the DETERMINISTIC spec-build seam (Model A).
 *
 * The spec pipeline needs two live agent spawns (spec-generator + spec-reviewer),
 * which a `factory` subprocess cannot do (no Agent tool). So the in-process
 * {@link import("../../spec/pipeline.js").runSpecPipeline} is split into three
 * orchestrator-sequenced reporter actions; the in-session orchestrator owns the
 * agent spawns AND the bounded regeneration loop, the CLI owns the deterministic
 * glue (resolveByIssue / PRD fetch / spec gates / review adjudication / store.write).
 *
 * State is threaded through a TRANSIENT scratch dir, `specBuildDir(dataDir,repo,issue)`,
 * holding three files: `prd.json` (written by `resolve`), `generated.json` (written
 * by the orchestrator after spawning the generator), and `verdict.json` (written by
 * the orchestrator after spawning the reviewer). Every action takes `--repo` +
 * `--issue` and recomputes the scratch dir, so the orchestrator never threads paths
 * by hand — the CLI also echoes the concrete paths in each envelope.
 *
 * Loop (orchestrator-owned):
 *   resolve → reuse(pointer)  → DONE (go straight to `run create`)
 *           → generate(spawn) → [spawn generator → write generated.json] → gate
 *   gate    → revise(blockers)→ [re-spawn generator with blockers] → gate          (≤ max_iterations)
 *           → review(spawn)   → [spawn reviewer → write verdict.json] → store
 *   store   → revise(reason)  → [re-spawn generator] → gate                         (≤ max_iterations)
 *           → stored(pointer) → DONE (go to `run create`)
 *
 * Mirrors {@link import("../../spec/pipeline.js").runSpecPipeline} exactly (same
 * gates, same 56/60+floor adjudication, same manifest construction) — the only
 * difference is WHO drives the agent spawns and the loop.
 */
import { join } from "node:path";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { readJsonInput } from "../transition.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { stringifyJson } from "../../shared/json.js";
import { specBuildDir } from "../../core/state/paths.js";
import {
  SpecStore,
  RealGhClient,
  runSpecGates,
  decideSpecReview,
  parseReviewVerdict,
  parseGenerateResult,
  buildGenerateSpawn,
  buildReviewSpawn,
  buildManifest,
  type GhClient,
  type Prd,
  type SpecSpawnSpec,
} from "../../spec/index.js";
import type { Config, SpecPointer } from "../../types/index.js";
import type { Subcommand } from "../main.js";

const SPEC_HELP = `factory spec — deterministic spec-build seam (resolve → gate → store)

Usage:
  factory spec resolve --repo <owner/name> --issue <n>
  factory spec gate    --repo <owner/name> --issue <n>
  factory spec store   --repo <owner/name> --issue <n>

The in-session orchestrator drives the agent spawns + the bounded regen loop; each
action emits ONE JSON envelope naming the next step. Scratch JSON is threaded
through <dataDir>/spec-build/<repo>/<issue>/{prd,generated,verdict}.json.

Actions:
  resolve  Reuse an existing spec by issue, else fetch the PRD + emit the generate spawn.
  gate     Run the deterministic spec gates; emit revise (blockers) or the review spawn.
  store    Adjudicate the review (56/60 + floor); emit revise or persist + emit the pointer.`;

/** Scratch file names threaded between the three actions. */
const PRD_FILE = "prd.json";
const GENERATED_FILE = "generated.json";
const VERDICT_FILE = "verdict.json";

/** The single JSON document each `factory spec` action emits — the orchestrator's contract. */
export type SpecBuildEnvelope =
  | {
      /** An existing spec for this issue was reused (Δ X) — no generation needed. */
      readonly kind: "reuse";
      readonly repo: string;
      readonly issue: number;
      readonly pointer: SpecPointer;
    }
  | {
      /** No spec yet — spawn the generator, then write `generated_path` and call `gate`. */
      readonly kind: "generate";
      readonly repo: string;
      readonly issue: number;
      readonly spawn: SpecSpawnSpec;
      readonly prd_path: string;
      readonly generated_path: string;
      /** The orchestrator's bound on the generate/review loop (config.spec.maxRegenIterations). */
      readonly max_iterations: number;
    }
  | {
      /** Gates passed — spawn the reviewer, then write `verdict_path` and call `store`. */
      readonly kind: "review";
      readonly repo: string;
      readonly issue: number;
      readonly spawn: SpecSpawnSpec;
      readonly generated_path: string;
      readonly verdict_path: string;
    }
  | {
      /** The spec needs revision (gate blockers OR a sub-threshold review) — regenerate. */
      readonly kind: "revise";
      readonly repo: string;
      readonly issue: number;
      readonly source: "gate" | "review";
      readonly reason: string;
      readonly blockers: string[];
      readonly generated_path: string;
    }
  | {
      /** PASS — the spec is durably stored; the orchestrator proceeds to `run create`. */
      readonly kind: "stored";
      readonly repo: string;
      readonly issue: number;
      readonly pointer: SpecPointer;
    };

/** The deps the testable cores need (injected in tests; production-wired by the command). */
export interface SpecBuildDeps {
  readonly store: SpecStore;
  readonly gh: GhClient;
  readonly config: Config;
  readonly dataDir: string;
}

/** Resolve the three scratch paths for a (repo, issue) build. */
function scratchPaths(
  dataDir: string,
  repo: string,
  issue: number,
): {
  prdPath: string;
  generatedPath: string;
  verdictPath: string;
} {
  const dir = specBuildDir(dataDir, repo, issue);
  return {
    prdPath: join(dir, PRD_FILE),
    generatedPath: join(dir, GENERATED_FILE),
    verdictPath: join(dir, VERDICT_FILE),
  };
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * Reuse-or-begin: on a store hit return the pointer (Δ X — never regen); else fetch
 * the PRD, persist it to the scratch dir, and emit the apex-pinned generate spawn.
 */
export async function resolveSpec(
  deps: SpecBuildDeps,
  repo: string,
  issue: number,
): Promise<SpecBuildEnvelope> {
  const existing = await deps.store.resolveByIssue(repo, issue);
  if (existing) {
    return { kind: "reuse", repo, issue, pointer: deps.store.toPointer(existing) };
  }

  const prd = await deps.gh.fetchPrd(issue, { repo });
  const { prdPath, generatedPath } = scratchPaths(deps.dataDir, repo, issue);
  await atomicWriteFile(prdPath, stringifyJson(prd));

  return {
    kind: "generate",
    repo,
    issue,
    spawn: buildGenerateSpawn(prd),
    prd_path: prdPath,
    generated_path: generatedPath,
    max_iterations: deps.config.spec.maxRegenIterations,
  };
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/**
 * Run the deterministic spec gates against the generator's output. On a block, emit
 * `revise` (the orchestrator re-spawns the generator with the blockers). On a pass,
 * emit the apex-pinned review spawn. `generated.json` is UNTRUSTED agent output, so
 * it is parsed loudly via {@link parseGenerateResult}.
 */
export async function gateSpec(
  deps: SpecBuildDeps,
  repo: string,
  issue: number,
): Promise<SpecBuildEnvelope> {
  const { prdPath, generatedPath, verdictPath } = scratchPaths(deps.dataDir, repo, issue);
  const prd = await readJsonInput<Prd>(prdPath);
  const generated = parseGenerateResult(await readJsonInput<unknown>(generatedPath));

  const gates = runSpecGates(prd, generated.tasks);
  if (!gates.passed) {
    return {
      kind: "revise",
      repo,
      issue,
      source: "gate",
      reason: "deterministic spec gates blocked the spec",
      blockers: gates.blockers,
      generated_path: generatedPath,
    };
  }

  return {
    kind: "review",
    repo,
    issue,
    spawn: buildReviewSpawn(prd, generated),
    generated_path: generatedPath,
    verdict_path: verdictPath,
  };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * Adjudicate the reviewer verdict (single 56/60 threshold + any-dimension floor,
 * Δ I) against the generator output. On NEEDS_REVISION emit `revise`; on PASS build
 * the durable manifest and persist it, returning the run-facing pointer. Both
 * `generated.json` and `verdict.json` are UNTRUSTED agent output → parsed loudly.
 */
export async function storeSpec(
  deps: SpecBuildDeps,
  repo: string,
  issue: number,
): Promise<SpecBuildEnvelope> {
  const { generatedPath, verdictPath } = scratchPaths(deps.dataDir, repo, issue);
  const generated = parseGenerateResult(await readJsonInput<unknown>(generatedPath));
  const verdict = parseReviewVerdict(await readJsonInput<unknown>(verdictPath));

  const decision = decideSpecReview(verdict, {
    passReviewThreshold: deps.config.spec.passReviewThreshold,
    dimensionFloor: deps.config.spec.dimensionFloor,
  });
  if (decision.decision === "NEEDS_REVISION") {
    return {
      kind: "revise",
      repo,
      issue,
      source: "review",
      reason: decision.reason,
      blockers: verdict.blockers.length > 0 ? verdict.blockers : [decision.reason],
      generated_path: generatedPath,
    };
  }

  const manifest = buildManifest(repo, issue, generated);
  const pointer = await deps.store.write(manifest, generated.specMd);
  return { kind: "stored", repo, issue, pointer };
}

// ---------------------------------------------------------------------------
// Flag parsing + command wiring
// ---------------------------------------------------------------------------

function parseIssue(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}

/** Wire production deps once (own wiring — no run exists at spec time, so NOT loadCliDeps). */
function wireDeps(): SpecBuildDeps {
  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  return {
    store: new SpecStore({ dataDir }),
    gh: new RealGhClient({ bodyMaxBytes: config.spec.prdBodyMaxBytes }),
    config,
    dataDir,
  };
}

type Action = (deps: SpecBuildDeps, repo: string, issue: number) => Promise<SpecBuildEnvelope>;

const ACTIONS: Record<string, Action> = {
  resolve: resolveSpec,
  gate: gateSpec,
  store: storeSpec,
};

async function run(argv: string[]): Promise<ExitCode> {
  const action = argv[0];
  if (action === undefined || action === "--help" || action === "-h") {
    emitLine(SPEC_HELP);
    return EXIT.OK;
  }

  const handler = ACTIONS[action];
  if (handler === undefined) {
    throw new UsageError(`unknown spec action '${action}' (expected resolve | gate | store)`);
  }

  const args = parseArgs(argv.slice(1));
  if (args.flag("help") === true) {
    emitLine(SPEC_HELP);
    return EXIT.OK;
  }

  const repo = args.requireFlag("repo");
  const issue = parseIssue(args.requireFlag("issue"));

  const envelope = await handler(wireDeps(), repo, issue);
  emitJson(envelope);
  return EXIT.OK;
}

export const specCommand: Subcommand = {
  describe: "Build a durable spec (resolve → gate → store; orchestrator drives the agent spawns)",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`spec: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
