/**
 * The run-level E2E COROUTINE (Decision 39) — mirrors `docs.ts`'s emit/record split,
 * ordered BEFORE it (`src/orchestrator/next.ts`'s `wantsE2e`).
 *
 * Unlike docs (one LLM pass, never re-entered), e2e has TWO very different kinds of
 * work:
 *   - AUTHORING a suite (needs an LLM + live-app exploration) — happens EXACTLY ONCE
 *     per run, on the first e2e entry (`run.e2e_phase === undefined`).
 *   - RUNNING the suite + deciding what to do with the result (fully mechanical —
 *     shells Playwright via `runE2e`, no LLM) — happens on EVERY entry, including
 *     every re-entry after a reopened task settles back to terminal.
 *
 * So only ONE spawn ever exists in this phase (`runE2eEmit`'s first-entry branch);
 * every other call — `runE2eEmit`'s re-entry branch and `runE2eRecord` after the
 * author returns — drives `runSuiteAndDecide` directly and returns a CONCLUSIVE
 * action (`done` | `failed` | `reopen` | `suspend`), never another spawn. The runner
 * therefore only ever spawns an agent for `kind: "spawn"`; every other kind means
 * "state already updated, no agent needed, continue the next-task loop."
 *
 * Ordering vs. commit (a deliberate refinement over the plan's literal worked
 * example): the fail-first proof runs BEFORE the critical specs are merged into
 * staging, using the author's own (not-yet-merged) worktree as the proof's
 * "staging-side" run and a scratch worktree off the base branch as the "base-side"
 * run. A spec that fails the proof (vacuous / base-unusable) therefore NEVER lands
 * in the target repo's committed `e2e/` — only a PROVEN spec is merged. The plan's
 * literal ordering ("commit; then prove") would otherwise permanently pollute the
 * committed suite with a rejected spec on the fail path.
 *
 * Reopen mechanics reuse `resetTaskRow` (Decision 7) — the SAME primitive rescue
 * uses — with a fresh `e2eFeedback` override; `e2e_feedback` then reaches both
 * producer roles via the existing `PriorFailureNote` channel (handlers.ts).
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  resolveStagingBranch,
  resetTaskRow,
  parseProducerStatus,
  E2eManifestEntrySchema,
  runE2e,
  DefaultPlaywrightTool,
  type Config,
  type GitClient,
  type StateManager,
  type SpecManifest,
  type RunState,
  type E2eManifestEntry,
  type PlaywrightTool,
  type E2eSpecResult,
} from "./deps.js";
import { nowIso, createLogger } from "../shared/index.js";

const log = createLogger("e2e");

/** Copies one spec file across worktrees for the fail-first proof — injectable (unit tests fake it). */
export interface E2eFileOps {
  copySpec(from: string, to: string): Promise<void>;
}

class DefaultE2eFileOps implements E2eFileOps {
  async copySpec(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

export interface E2eRunDeps {
  readonly state: StateManager;
  readonly git: GitClient;
  readonly config: Config;
  readonly dataDir: string;
  /** The run's durable spec — task list + acceptance criteria for the author prompt. */
  readonly spec: SpecManifest;
  /** Injectable Playwright wrapper (tests fake this; production uses the real CLI). */
  readonly playwright?: PlaywrightTool;
  /** Injectable spec-file copy for the fail-first proof (tests fake this). */
  readonly files?: E2eFileOps;
}

export type E2eAction =
  | {
      readonly kind: "spawn";
      readonly run_id: string;
      readonly worktree: string;
      readonly base_ref: string;
      readonly staging_branch: string;
      readonly e2e_branch: string;
      readonly throwaway_dir: string;
      readonly model: string;
      readonly max_turns: number;
      readonly prompt: string;
    }
  | { readonly kind: "done"; readonly run_id: string }
  | { readonly kind: "failed"; readonly run_id: string; readonly reason: string }
  | {
      readonly kind: "reopen";
      readonly run_id: string;
      readonly task_ids: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: "suspend"; readonly run_id: string; readonly reason: string };

const E2E_AUTHOR_MODEL = "sonnet"; // Haiku→Sonnet policy — no plugin agent runs Haiku.
// ponytail: 90 (docs' 60 + a 50% margin) — live MCP exploration burns more turns
// than a diff read; bump if the author routinely hits the ceiling.
const E2E_AUTHOR_MAX_TURNS = 90;

/** Title prefix marking a spec's CONTROL assertion (fail-first-proof discipline). */
export const CONTROL_TITLE_PREFIX = "control:";

export const E2eResultsSchema = z
  .object({
    status: z.string().min(1),
    /** Empty when the author judged no task in this run to be UI-facing. */
    manifest: z.array(E2eManifestEntrySchema).default([]),
  })
  .strict();
// Named distinctly from `verifier/e2e`'s `E2eResults` (the Playwright run outcome,
// reachable via the same `./deps.js` barrel) — this is the author's `--results` envelope.
export type E2eAuthorResults = z.infer<typeof E2eResultsSchema>;

/** The e2e-phase author worktree path (torn down once its specs are merged/rejected). */
export function e2eWorktreePath(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "e2e-worktree");
}

/** The persistent "run the suite against current staging" worktree — reused every pass. */
export function e2eRunWorktreePath(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "e2e-run-worktree");
}

/** Scratch worktree used ONLY for the fail-first base-side proof (removed after use). */
export function e2eBaseProofWorktreePath(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "e2e-base-proof-worktree");
}

/** The run's ephemeral, out-of-repo throwaway-spec directory — never committed, discarded at run end. */
export function e2eThrowawayDir(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId, "e2e-throwaway");
}

function e2eBranchName(runId: string): string {
  return `e2e-${runId}`;
}

/** Build the e2e-author prompt: the task list + config + the two spec destinations. */
function buildAuthorPrompt(args: {
  worktree: string;
  baseRef: string;
  throwawayDir: string;
  testDir: string;
  startCommand: string;
  baseURL: string;
  spec: SpecManifest;
}): string {
  const taskLines = args.spec.tasks
    .map((t) => `  - ${t.task_id} — ${t.title}: ${t.acceptance_criteria.join("; ")}`)
    .join("\n");
  return [
    "You are the factory e2e-author running the pipeline's end-to-end test-authoring phase.",
    `1. cd into your worktree: ${args.worktree} (checked out on the e2e branch off the staging tip).`,
    `2. Boot the app: \`${args.startCommand}\` → ${args.baseURL} (reuse if already running).`,
    "3. Review every task this PRD delivered:",
    taskLines,
    `4. For each USER-FACING task, explore the live app via the Playwright MCP tools and author a ` +
      `THROWAWAY spec into ${args.throwawayDir} (OUTSIDE this worktree — never commit it).`,
    `5. Author a small number of CRITICAL, money-path JOURNEY specs (thin — the load-bearing net, ` +
      `not per-task coverage) into ${args.worktree}/${args.testDir}/ and COMMIT them in this worktree. ` +
      `Each critical spec MUST include one assertion titled with the "${CONTROL_TITLE_PREFIX}" prefix ` +
      "that passes on ANY boot of the app (e.g. the page loads) — the fail-first proof uses it to tell " +
      "'the app didn't boot' apart from 'the feature doesn't exist yet.'",
    "6. Self-validate: every spec you authored must be green against the live (staging) app before you finish.",
    "7. Do NOT push (the engine merges the critical specs on record). Do NOT edit non-e2e files.",
    'Finish with your terminal STATUS line and return {"status": "<line>", "manifest": [...]} — the ' +
      "manifest is an array of {task_ids, spec_path, kind} rows, one per spec you authored " +
      "(critical `spec_path` is worktree-relative; throwaway `spec_path` is throwaway-dir-relative). " +
      "Per agents/e2e-author.md + skills/e2e-authoring/SKILL.md for the full authoring discipline.",
  ].join("\n");
}

/** Emit the e2e phase's next step: spawn the author (first entry) or run the suite directly (re-entry). */
export async function runE2eEmit(deps: E2eRunDeps, runId: string): Promise<E2eAction> {
  const run = await deps.state.read(runId);
  const cfg = deps.config.e2e;

  if (!cfg.startCommand || !cfg.baseURL) {
    const reason =
      "e2e phase requires e2e.startCommand and e2e.baseURL — run " +
      "`factory configure --set e2e.startCommand=<cmd> --set e2e.baseURL=<url>` first";
    await deps.state.update(runId, (s) => ({ ...s, status: "suspended" }));
    log.warn(`run '${runId}': ${reason}`);
    return { kind: "suspend", run_id: runId, reason };
  }

  if (run.e2e_phase === undefined) {
    return prepareAuthorSpawn(deps, run, runId, cfg.startCommand, cfg.baseURL, cfg.testDir);
  }

  // Re-entry after a reopened task settled: the manifest is already authored
  // (throwaway specs are RE-RUN, not re-authored) — go straight to the mechanical
  // suite run. The fail-first proof already ran once, at authoring time.
  return runSuiteAndDecide(deps, runId);
}

async function prepareAuthorSpawn(
  deps: E2eRunDeps,
  run: RunState,
  runId: string,
  startCommand: string,
  baseURL: string,
  testDir: string,
): Promise<E2eAction> {
  const staging = resolveStagingBranch(runId, run.staging_branch);
  const base = deps.config.git.baseBranch;
  const branch = e2eBranchName(runId);
  const worktree = e2eWorktreePath(deps.dataDir, runId);
  const baseRef = `origin/${base}`;

  await deps.git.fetch("origin", staging);
  if (!(await deps.git.worktreeExists(worktree))) {
    await deps.git.worktreeAdd(["-b", branch, worktree, `origin/${staging}`]);
  }

  const throwawayDir = e2eThrowawayDir(deps.dataDir, runId);
  return {
    kind: "spawn",
    run_id: runId,
    worktree,
    base_ref: baseRef,
    staging_branch: staging,
    e2e_branch: branch,
    throwaway_dir: throwawayDir,
    model: E2E_AUTHOR_MODEL,
    max_turns: E2E_AUTHOR_MAX_TURNS,
    prompt: buildAuthorPrompt({
      worktree,
      baseRef,
      throwawayDir,
      testDir,
      startCommand,
      baseURL,
      spec: deps.spec,
    }),
  };
}

/** Record the e2e-author's result: on failure, fail the run; on success, prove + run the suite. */
export async function runE2eRecord(
  deps: E2eRunDeps,
  runId: string,
  results: E2eAuthorResults,
): Promise<Extract<E2eAction, { kind: "done" | "failed" | "reopen" | "suspend" }>> {
  const outcome = parseProducerStatus(results.status);
  if (outcome.status !== "done") {
    const reason = `e2e-author: ${"reason" in outcome ? outcome.reason : "no parseable status"}`;
    await markFailed(deps, runId, reason);
    return { kind: "failed", run_id: runId, reason };
  }

  const run = await deps.state.read(runId);
  const staging = resolveStagingBranch(runId, run.staging_branch);
  const worktree = e2eWorktreePath(deps.dataDir, runId);
  const critical = results.manifest.filter((e) => e.kind === "critical");

  if (critical.length > 0) {
    const proof = await proveCriticals(deps, runId, critical, worktree);
    if (!proof.ok) {
      // Never merge an unproven spec — the worktree (and its unmerged commits) is
      // discarded rather than landed in the target repo.
      await deps.git.worktreeRemove([worktree, "--force"]);
      await markFailed(deps, runId, proof.reason);
      return { kind: "failed", run_id: runId, reason: proof.reason };
    }
  }

  // Proven — merge the critical specs into staging (mirrors docs' ff-merge).
  if (critical.length > 0) {
    await deps.git.mergeFfOrCommit(staging, e2eBranchName(runId));
    await deps.git.push("origin", staging);
  }
  await deps.git.worktreeRemove([worktree, "--force"]);

  await deps.state.update(runId, (s) => ({
    ...s,
    e2e_phase: {
      ...(s.e2e_phase ?? { reopen_counts: {} }),
      manifest: results.manifest,
    },
  }));

  return runSuiteAndDecide(deps, runId);
}

interface ProofVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/** True iff every CONTROL spec passed and every non-control (journey) spec failed. */
function classifyBaseRun(specs: readonly E2eSpecResult[]): {
  controlGreen: boolean;
  journeyRed: boolean;
} {
  const control = specs.filter((s) => s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX));
  const journey = specs.filter((s) => !s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX));
  return {
    controlGreen: control.length === 0 || control.every((s) => s.status === "passed"),
    journeyRed: journey.length > 0 && journey.every((s) => s.status === "failed"),
  };
}

/**
 * Fail-first proof (Decision 5): each critical spec must be RED on the base branch
 * (with its control assertion GREEN — proving the base app itself booted) and GREEN
 * on the author's worktree (staging + the new spec). Guards against a green-but-
 * meaningless autonomously-authored assertion; nothing here is human-reviewed.
 */
async function proveCriticals(
  deps: E2eRunDeps,
  runId: string,
  critical: readonly E2eManifestEntry[],
  authorWorktree: string,
): Promise<ProofVerdict> {
  const cfg = deps.config.e2e;
  const files = deps.files ?? new DefaultE2eFileOps();
  const tool = deps.playwright ?? new DefaultPlaywrightTool();
  const wtPath = e2eBaseProofWorktreePath(deps.dataDir, runId);
  const base = `origin/${deps.config.git.baseBranch}`;
  if (!(await deps.git.worktreeExists(wtPath))) {
    await deps.git.worktreeAdd(["-b", `e2e-base-proof-${runId}`, wtPath, base]);
  }

  try {
    for (const entry of critical) {
      await files.copySpec(join(authorWorktree, entry.spec_path), join(wtPath, entry.spec_path));
      const baseResult = await runE2e(
        { cwd: wtPath, env: { BASE_URL: cfg.baseURL! }, testDir: entry.spec_path },
        tool,
      );
      const { controlGreen, journeyRed } = classifyBaseRun(baseResult.specs);
      if (!controlGreen) {
        return {
          ok: false,
          reason:
            `fail-first proof: base worktree unusable for '${entry.spec_path}' — ` +
            "its control assertion failed against the unmodified base app",
        };
      }
      if (!journeyRed) {
        return {
          ok: false,
          reason:
            `fail-first proof: '${entry.spec_path}' did not fail against the base app ` +
            "(vacuous-pass risk) — rejected",
        };
      }
      const stagingResult = await runE2e(
        { cwd: authorWorktree, env: { BASE_URL: cfg.baseURL! }, testDir: entry.spec_path },
        tool,
      );
      if (!stagingResult.ok) {
        return {
          ok: false,
          reason: `fail-first proof: '${entry.spec_path}' is still red against staging`,
        };
      }
    }
    return { ok: true, reason: "" };
  } finally {
    await deps.git.worktreeRemove([wtPath, "--force"]);
  }
}

async function markDone(
  deps: E2eRunDeps,
  runId: string,
  opts: { attempts: number; advisory?: string },
): Promise<void> {
  await deps.state.update(runId, (s) => ({
    ...s,
    e2e_phase: {
      ...(s.e2e_phase ?? { manifest: [], reopen_counts: {} }),
      status: "done" as const,
      reason: undefined,
      advisory: opts.advisory,
      attempts: opts.attempts,
      ended_at: nowIso(),
    },
  }));
}

async function markFailed(
  deps: E2eRunDeps,
  runId: string,
  reason: string,
  attempts?: number,
): Promise<void> {
  await deps.state.update(runId, (s) => ({
    ...s,
    e2e_phase: {
      ...(s.e2e_phase ?? { manifest: [], reopen_counts: {} }),
      status: "failed" as const,
      reason,
      advisory: undefined,
      attempts: attempts ?? s.e2e_phase?.attempts,
      ended_at: nowIso(),
    },
  }));
  log.warn(`run '${runId}': e2e phase failed — ${reason}`);
}

/** One join hit: a failed spec + the manifest entry that names it, or `undefined` if unmapped. */
function findEntry(
  manifest: readonly E2eManifestEntry[],
  spec: E2eSpecResult,
): E2eManifestEntry | undefined {
  return manifest.find((e) => spec.file === e.spec_path || spec.file.endsWith(`/${e.spec_path}`));
}

/**
 * The mechanical heart of the phase: sync the run-worktree to CURRENT staging, run
 * the full suite (critical + throwaway), join failures to tasks via the manifest,
 * and apply the cadence (Decision 8) + disposition (Decision 9) rules.
 */
async function runSuiteAndDecide(
  deps: E2eRunDeps,
  runId: string,
): Promise<Extract<E2eAction, { kind: "done" | "failed" | "reopen" | "suspend" }>> {
  const run = await deps.state.read(runId);
  const manifest = run.e2e_phase?.manifest ?? [];
  const attempts = (run.e2e_phase?.attempts ?? 0) + 1;
  const firstPass = attempts === 1;
  const cfg = deps.config.e2e;

  if (manifest.length === 0) {
    // The author judged nothing in this PRD to be UI-facing — nothing to gate on.
    await markDone(deps, runId, { attempts });
    return { kind: "done", run_id: runId };
  }

  const staging = resolveStagingBranch(runId, run.staging_branch);
  const worktree = e2eRunWorktreePath(deps.dataDir, runId);
  await deps.git.fetch("origin", staging);
  if (!(await deps.git.worktreeExists(worktree))) {
    await deps.git.worktreeAdd(["-b", `e2e-run-${runId}`, worktree, `origin/${staging}`]);
  } else {
    // Always resync — a reopened task's re-ship advanced staging since the last pass.
    await deps.git.resetHardClean(`origin/${staging}`, { cwd: worktree });
  }

  const tool = deps.playwright ?? new DefaultPlaywrightTool();
  const criticalResult = await runE2e(
    { cwd: worktree, env: { BASE_URL: cfg.baseURL! }, testDir: cfg.testDir },
    tool,
  );
  const throwaway = manifest.filter((e) => e.kind === "throwaway");
  const throwawayResult =
    throwaway.length > 0
      ? await runE2e(
          {
            cwd: worktree,
            env: { BASE_URL: cfg.baseURL! },
            testDir: e2eThrowawayDir(deps.dataDir, runId),
          },
          tool,
        )
      : undefined;

  const criticalFailed = criticalResult.specs.filter((s) => s.status === "failed");
  const throwawayFailed = throwawayResult?.specs.filter((s) => s.status === "failed") ?? [];

  if (criticalFailed.length === 0) {
    const advisory =
      throwawayFailed.length > 0
        ? `${throwawayFailed.length} throwaway spec(s) still red (non-gating): ` +
          throwawayFailed.map((s) => s.title).join(", ")
        : undefined;
    await markDone(deps, runId, { attempts, advisory });
    return { kind: "done", run_id: runId };
  }

  const mappedCritical = criticalFailed.map((s) => ({ spec: s, entry: findEntry(manifest, s) }));
  const unmappable = mappedCritical.filter((m) => m.entry === undefined);
  if (unmappable.length > 0) {
    const reason =
      `unmappable critical e2e failure(s): ${unmappable.map((m) => m.spec.file).join(", ")} ` +
      "— no manifest entry names this spec";
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }

  // Cadence (Decision 8): pass 1 reopens for ANY mappable failure (critical + throwaway);
  // pass 2+ reopens ONLY for critical. A still-red throwaway on pass 2+ is dropped here —
  // it never blocks (only critical red gates disposition) and never reopens.
  const throwawayCandidates = firstPass
    ? throwawayFailed.map((s) => ({ spec: s, entry: findEntry(manifest, s) }))
    : [];
  const mappable = [...mappedCritical, ...throwawayCandidates].filter(
    (m): m is { spec: E2eSpecResult; entry: E2eManifestEntry } => m.entry !== undefined,
  );

  const taskIds = [...new Set(mappable.flatMap((m) => m.entry.task_ids))];
  const reopenCounts = { ...(run.e2e_phase?.reopen_counts ?? {}) };
  const capExhausted = taskIds.filter((id) => (reopenCounts[id] ?? 0) >= cfg.reopenCap);
  if (capExhausted.length > 0) {
    const reason = `e2e reopen cap (${cfg.reopenCap}) exhausted for task(s): ${capExhausted.join(", ")}`;
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }

  const feedback =
    "The e2e phase found these journeys still failing:\n" +
    mappable.map((m) => `- ${m.entry.spec_path} — "${m.spec.title}"`).join("\n");
  for (const id of taskIds) reopenCounts[id] = (reopenCounts[id] ?? 0) + 1;

  await deps.state.update(runId, (s) => ({
    ...s,
    tasks: Object.fromEntries(
      Object.entries(s.tasks).map(([id, t]) =>
        taskIds.includes(id) ? [id, resetTaskRow(t, { e2eFeedback: feedback })] : [id, t],
      ),
    ),
    e2e_phase: {
      ...(s.e2e_phase ?? { manifest }),
      status: undefined,
      reason: undefined,
      advisory: undefined,
      attempts,
      manifest: s.e2e_phase?.manifest ?? manifest,
      reopen_counts: reopenCounts,
    },
  }));
  log.info(`run '${runId}': e2e reopening task(s) ${taskIds.join(", ")} (pass ${attempts})`);
  return { kind: "reopen", run_id: runId, task_ids: taskIds, reason: feedback };
}
