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
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  resolveStagingBranch,
  resetTaskRow,
  parseProducerStatus,
  E2eManifestEntrySchema,
  runE2e,
  DefaultPlaywrightTool,
  provisionWorktree,
  type Config,
  type GitClient,
  type StateManager,
  type SpecManifest,
  type RunState,
  type E2ePhase,
  type E2eManifestEntry,
  type PlaywrightTool,
  type E2eSpecResult,
  type ProvisionWorktreeFn,
} from "./deps.js";
import { nowIso, createLogger } from "../shared/index.js";

const log = createLogger("e2e");

/** File operations the e2e coroutine needs beyond git — injectable (unit tests fake it). */
export interface E2eFileOps {
  /** Copies one spec file across worktrees for the fail-first proof. */
  copySpec(from: string, to: string): Promise<void>;
  /** Writes a generated Playwright config (e.g. the throwaway-suite config). */
  writeConfig(path: string, contents: string): Promise<void>;
}

class DefaultE2eFileOps implements E2eFileOps {
  async copySpec(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  async writeConfig(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
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
  /** Injectable worktree provisioner (tests fake this; production runs `npm ci`-equivalent). */
  readonly provision?: ProvisionWorktreeFn;
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
    /**
     * Explicit "nothing UI-facing" signal — must be `true` whenever `manifest` is
     * empty. Distinguishes a genuine no-op from a malformed/incomplete author
     * response that the `manifest` field's own `.default([])` would otherwise
     * silently paper over as an unremarkable green. Omitted/false + an empty
     * manifest is treated as ambiguous, not a silent pass.
     */
    no_ui_surface: z.boolean().optional(),
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

/**
 * The env every Playwright invocation gets — read by the scaffolded
 * `templates/playwright.config.ts`'s `webServer` block so the app boots the
 * SAME command/URL/timeout the operator configured via `factory configure`,
 * fresh every run (`FACTORY_E2E=1` forces `reuseExistingServer: false`).
 */
function e2eEnv(cfg: Config["e2e"]): Record<string, string> {
  return {
    BASE_URL: cfg.baseURL!,
    FACTORY_E2E_START_COMMAND: cfg.startCommand!,
    FACTORY_E2E_READY_TIMEOUT_MS: String(cfg.readyTimeoutMs),
    FACTORY_E2E: "1",
  };
}

/**
 * The env an AUTHORED SPEC actually executes with (Decision 39 W5). The spec file
 * is autonomously-authored, unreviewed code — it must not inherit the parent
 * process's full environment (CI tokens, cloud creds, ...). Allowlists exactly
 * PATH/HOME (so node/npm/the Playwright bin's shebang still resolves) plus the
 * {@link e2eEnv} vars the scaffolded `webServer` block reads. Pass alongside
 * `replaceEnv: true` so `exec` does NOT merge this over `process.env`.
 */
function scrubbedE2eEnv(cfg: Config["e2e"]): Record<string, string> {
  const env = e2eEnv(cfg);
  for (const key of ["PATH", "HOME"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
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
    // `-B` (not `-b`): a crash between this worktree's removal and the state
    // update that concludes this phase can leave the branch behind after the
    // worktree path is gone — a bare `-b` would fatal on re-entry. `-B`
    // force-creates/resets it, matching a fresh run's behavior either way.
    await deps.git.worktreeAdd(["-B", branch, worktree, `origin/${staging}`]);
    await (deps.provision ?? provisionWorktree)({
      path: worktree,
      setupCommand: deps.config.quality.setupCommand,
    });
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

/**
 * Guard a manifest `spec_path` before ANY filesystem `join`/`copySpec`/`testDir` use.
 * The author is an autonomous LLM — nothing here is human-reviewed before this runs
 * — so a traversal/absolute-path trick must be caught HERE, the single choke point
 * every downstream use (`proveCriticals`'s joins, `runSuiteAndDecide`'s `testDir`)
 * routes through via the persisted manifest. Throws (never silently sanitizes).
 */
function assertSafeSpecPath(specPath: string): void {
  if (isAbsolute(specPath)) {
    throw new Error(`e2e manifest spec_path '${specPath}' must be relative, not absolute`);
  }
  if (specPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`e2e manifest spec_path '${specPath}' must not contain '..' segments`);
  }
}

/**
 * Fail the phase AND discard the author worktree — every {@link runE2eRecord}
 * failure exit routes through here so no early exit leaks the worktree (the
 * `worktree remove` wrapper tolerates an already-absent path: nonzero exit code,
 * not a throw).
 */
async function failWithCleanup(
  deps: E2eRunDeps,
  runId: string,
  worktree: string,
  reason: string,
): Promise<Extract<E2eAction, { kind: "failed" }>> {
  await deps.git.worktreeRemove([worktree, "--force"]);
  await markFailed(deps, runId, reason);
  return { kind: "failed", run_id: runId, reason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Record the e2e-author's result: on failure, fail the run; on success, prove + run the suite. */
export async function runE2eRecord(
  deps: E2eRunDeps,
  runId: string,
  results: E2eAuthorResults,
): Promise<Extract<E2eAction, { kind: "done" | "failed" | "reopen" | "suspend" }>> {
  const worktree = e2eWorktreePath(deps.dataDir, runId);

  const outcome = parseProducerStatus(results.status);
  if (outcome.status !== "done") {
    const reason = `e2e-author: ${"reason" in outcome ? outcome.reason : "no parseable status"}`;
    return failWithCleanup(deps, runId, worktree, reason);
  }

  if (results.manifest.length === 0 && results.no_ui_surface !== true) {
    const reason =
      "e2e-author: STATUS: DONE with an empty manifest but no_ui_surface was not " +
      "explicitly true — ambiguous (genuine no-op vs. a malformed/incomplete " +
      "response); refusing to silently pass";
    return failWithCleanup(deps, runId, worktree, reason);
  }

  for (const entry of results.manifest) {
    try {
      assertSafeSpecPath(entry.spec_path);
    } catch (err) {
      return failWithCleanup(deps, runId, worktree, `e2e-author: ${errText(err)}`);
    }
  }

  const cfg = deps.config.e2e;
  const run = await deps.state.read(runId);
  const staging = resolveStagingBranch(runId, run.staging_branch);
  const critical = results.manifest.filter((e) => e.kind === "critical");

  // The author picks task_ids off the spec it was handed, but nothing upstream
  // constrains it to that set — an unknown id would otherwise silently vanish at
  // reopen time (`taskIds.includes(id)` in runSuiteAndDecide just skips it).
  const unknownTaskIds = [...new Set(results.manifest.flatMap((e) => e.task_ids))].filter(
    (id) => !(id in run.tasks),
  );
  if (unknownTaskIds.length > 0) {
    const reason =
      `e2e-author: manifest references unknown task_id(s) not in this run: ` +
      unknownTaskIds.join(", ");
    return failWithCleanup(deps, runId, worktree, reason);
  }

  if (critical.length > 0) {
    // Trust boundary (Decision 39 W5): the author's ENTIRE branch is about to be
    // merged unreviewed. Every `critical` spec_path must itself live under the
    // committed testDir — a critical entry declared OUTSIDE it (e.g. repo root)
    // would otherwise merge an unreviewed file just by being self-declared as
    // "critical" (nothing else checks a critical entry's location).
    const testDirPrefix = `${cfg.testDir}/`;
    const outsideTestDir = critical.filter((e) => !e.spec_path.startsWith(testDirPrefix));
    if (outsideTestDir.length > 0) {
      const reason =
        `e2e-author: critical spec_path(s) not under '${testDirPrefix}' — refusing to merge: ` +
        outsideTestDir.map((e) => e.spec_path).join(", ");
      return failWithCleanup(deps, runId, worktree, reason);
    }

    // Reject up front — before spending the fail-first proof — if the branch
    // touches anything outside testDir at all. Throwaway specs live OUTSIDE this
    // worktree (never committed, so never in this diff) — the only files a
    // legitimate author branch touches are critical specs under testDir/, so no
    // additional per-file allowlist is needed once THAT is enforced above.
    const branch = e2eBranchName(runId);
    const changed = await deps.git.diffNames(staging, branch, { cwd: worktree });
    const stray = changed.filter((f) => !f.startsWith(testDirPrefix));
    if (stray.length > 0) {
      const reason =
        `e2e-author: branch touches path(s) outside '${testDirPrefix}' — refusing to merge ` +
        `unreviewed changes: ${stray.join(", ")}`;
      return failWithCleanup(deps, runId, worktree, reason);
    }

    const proof = await proveCriticals(deps, runId, critical, worktree);
    if (!proof.ok) {
      // Never merge an unproven spec — the worktree (and its unmerged commits) is
      // discarded rather than landed in the target repo.
      return failWithCleanup(deps, runId, worktree, proof.reason);
    }

    // Proven — merge the critical specs into staging (mirrors docs' ff-merge).
    await deps.git.mergeFfOrCommit(staging, e2eBranchName(runId));
    await deps.git.push("origin", staging);
  }
  await deps.git.worktreeRemove([worktree, "--force"]);

  await deps.state.update(runId, (s) => ({
    ...s,
    e2e_phase: {
      ...(s.e2e_phase ?? defaultE2ePhase()),
      manifest: results.manifest,
    },
  }));

  return runSuiteAndDecide(deps, runId);
}

interface ProofVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * True iff at least one CONTROL spec ran and all of them passed. A critical spec
 * with NO control-titled assertion at all is NOT vacuously green — the authoring
 * contract requires one (see `buildAuthorPrompt`); without it there's no way to
 * tell "the base app didn't boot" apart from "the feature doesn't exist yet."
 */
function classifyBaseRun(specs: readonly E2eSpecResult[]): {
  hasControl: boolean;
  controlGreen: boolean;
  journeyRed: boolean;
} {
  const control = specs.filter((s) => s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX));
  const journey = specs.filter((s) => !s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX));
  return {
    hasControl: control.length > 0,
    controlGreen: control.length > 0 && control.every((s) => s.status === "passed"),
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
    // `-B`: same crash-safety rationale as prepareAuthorSpawn — a scratch proof
    // worktree removed by a crashed prior pass can leave its branch behind.
    await deps.git.worktreeAdd(["-B", `e2e-base-proof-${runId}`, wtPath, base]);
    await (deps.provision ?? provisionWorktree)({
      path: wtPath,
      setupCommand: deps.config.quality.setupCommand,
    });
  }

  try {
    for (const entry of critical) {
      await files.copySpec(join(authorWorktree, entry.spec_path), join(wtPath, entry.spec_path));
      // runE2e THROWS on tooling-level failure (missing Playwright binary, empty/
      // truncated reporter output) — convert to a ProofVerdict so the caller's
      // failWithCleanup path persists the failure instead of an uncaught crash.
      let baseResult;
      try {
        baseResult = await runE2e(
          { cwd: wtPath, env: scrubbedE2eEnv(cfg), replaceEnv: true, testDir: entry.spec_path },
          tool,
        );
      } catch (err) {
        return {
          ok: false,
          reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against the base app: ${errText(err)}`,
        };
      }
      const { hasControl, controlGreen, journeyRed } = classifyBaseRun(baseResult.specs);
      if (!hasControl) {
        return {
          ok: false,
          reason:
            `fail-first proof: '${entry.spec_path}' has no "${CONTROL_TITLE_PREFIX}"-titled ` +
            "assertion — cannot verify the base app booted (required by the authoring contract)",
        };
      }
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
      let stagingResult;
      try {
        stagingResult = await runE2e(
          {
            cwd: authorWorktree,
            env: scrubbedE2eEnv(cfg),
            replaceEnv: true,
            testDir: entry.spec_path,
          },
          tool,
        );
      } catch (err) {
        return {
          ok: false,
          reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against staging: ${errText(err)}`,
        };
      }
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

/** The zero-value `e2e_phase` shape (no manifest authored yet, no reopens spent). Every
 * writer spreads this under `s.e2e_phase ??` so a first write never has to restate it. */
function defaultE2ePhase(): Pick<E2ePhase, "manifest" | "reopen_counts"> {
  return { manifest: [], reopen_counts: {} };
}

async function markDone(
  deps: E2eRunDeps,
  runId: string,
  opts: { attempts: number; advisory?: string },
): Promise<void> {
  await deps.state.update(runId, (s) => ({
    ...s,
    e2e_phase: {
      ...(s.e2e_phase ?? defaultE2ePhase()),
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
      ...(s.e2e_phase ?? defaultE2ePhase()),
      status: "failed" as const,
      reason,
      advisory: undefined,
      attempts: attempts ?? s.e2e_phase?.attempts,
      ended_at: nowIso(),
    },
  }));
  log.warn(`run '${runId}': e2e phase failed — ${reason}`);
}

/** Where the generated throwaway-suite Playwright config lives — inside the run
 * worktree (never committed, never staged) so its own `require("@playwright/test")`
 * resolves via THAT worktree's `node_modules`, even though `testDir` inside it
 * points at the out-of-repo throwaway dir. */
function throwawayConfigPath(worktree: string): string {
  return join(worktree, ".factory-e2e-throwaway.config.cjs");
}

/** CommonJS (not TS/ESM) — loads regardless of the target repo's package.json `type`. */
function throwawayConfigContents(throwawayDir: string): string {
  return [
    "// Generated by the factory e2e coroutine — never commit, rewritten every run.",
    'const { defineConfig } = require("@playwright/test");',
    "module.exports = defineConfig({",
    `  testDir: ${JSON.stringify(throwawayDir)},`,
    "  use: { baseURL: process.env.BASE_URL },",
    "  webServer: {",
    "    command: process.env.FACTORY_E2E_START_COMMAND,",
    "    url: process.env.BASE_URL,",
    "    reuseExistingServer: process.env.FACTORY_E2E ? false : true,",
    "    timeout: Number(process.env.FACTORY_E2E_READY_TIMEOUT_MS) || 30_000,",
    "  },",
    "});",
    "",
  ].join("\n");
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
  const provision = deps.provision ?? provisionWorktree;
  await deps.git.fetch("origin", staging);
  if (!(await deps.git.worktreeExists(worktree))) {
    // `-B`: same crash-safety rationale as prepareAuthorSpawn.
    await deps.git.worktreeAdd(["-B", `e2e-run-${runId}`, worktree, `origin/${staging}`]);
  } else {
    // Always resync — a reopened task's re-ship advanced staging since the last pass.
    await deps.git.resetHardClean(`origin/${staging}`, { cwd: worktree });
  }
  // Provisioned on first creation AND every resync — staging may have gained a
  // new dependency between reopen passes.
  await provision({ path: worktree, setupCommand: deps.config.quality.setupCommand });

  const tool = deps.playwright ?? new DefaultPlaywrightTool();
  // runE2e THROWS on a tooling-level failure (missing Playwright binary, empty/
  // truncated reporter output) — persist a failed phase instead of crashing the
  // record with the phase cursor left dangling.
  let criticalResult;
  try {
    criticalResult = await runE2e(
      { cwd: worktree, env: scrubbedE2eEnv(cfg), replaceEnv: true, testDir: cfg.testDir },
      tool,
    );
  } catch (err) {
    const reason = `e2e critical suite tooling error: ${errText(err)}`;
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }
  const throwaway = manifest.filter((e) => e.kind === "throwaway");
  let throwawayResult;
  let throwawayThrew: string | undefined;
  if (throwaway.length > 0) {
    const throwawayDir = e2eThrowawayDir(deps.dataDir, runId);
    const configPath = throwawayConfigPath(worktree);
    await (deps.files ?? new DefaultE2eFileOps()).writeConfig(
      configPath,
      throwawayConfigContents(throwawayDir),
    );
    try {
      throwawayResult = await runE2e(
        { cwd: worktree, env: scrubbedE2eEnv(cfg), replaceEnv: true, config: configPath },
        tool,
      );
    } catch (err) {
      if (firstPass) {
        const reason = `e2e throwaway suite tooling error: ${errText(err)}`;
        await markFailed(deps, runId, reason, attempts);
        return { kind: "failed", run_id: runId, reason };
      }
      // Pass 2+ throwaway is non-gating (Decision 8) — fold the crash into the
      // advisory below instead of failing the run.
      throwawayThrew = errText(err);
    }
  }

  // A manifest `critical` entry only counts as proven when ITS spec is present in the
  // results AND passed/flaky — absent (never collected) or explicitly failed/skipped
  // are all the same non-pass outcome. Stop treating "no spec in `failed`" as a pass.
  const criticalEntries = manifest.filter((e) => e.kind === "critical");
  const criticalMisses = criticalEntries
    .map((entry) => ({
      entry,
      spec: criticalResult.specs.find(
        (s) => s.file === entry.spec_path || s.file.endsWith(`/${entry.spec_path}`),
      ),
    }))
    .filter(
      (m) => m.spec === undefined || (m.spec.status !== "passed" && m.spec.status !== "flaky"),
    );

  // A tooling-level failure (nonzero exit / reporter errors[]) that no individual
  // spec's status explains can't be attributed to any task — fail the run outright
  // rather than silently absorbing it into a critical-miss reopen.
  if (!criticalResult.ok && criticalResult.specs.every((s) => s.status !== "failed")) {
    const reason =
      "e2e critical suite reported a tooling failure (nonzero exit code or reporter " +
      "errors[]) with no individual spec marked failed — refusing to attribute to a task";
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }

  // Same tooling-failure blind spot as above, but for the throwaway run: a broken
  // throwaway config/tool invocation (`ok:false`, no spec marked `failed`) would
  // otherwise fall through to an empty `throwawayFailed` and silently `markDone`.
  // Only gate on pass 1 — pass 2+ throwaway is already non-gating (Decision 8), so
  // a tooling failure there is folded into the advisory instead (see below).
  if (
    firstPass &&
    throwawayResult &&
    !throwawayResult.ok &&
    throwawayResult.specs.every((s) => s.status !== "failed")
  ) {
    const reason =
      "e2e throwaway suite reported a tooling failure (nonzero exit code or reporter " +
      "errors[]) with no individual spec marked failed — refusing to attribute to a task";
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }

  const criticalSpecFailures = criticalResult.specs.filter((s) => s.status === "failed");
  const throwawayFailed = throwawayResult?.specs.filter((s) => s.status === "failed") ?? [];
  const unmappableCritical = criticalSpecFailures.filter(
    (s) => findEntry(manifest, s) === undefined,
  );
  if (unmappableCritical.length > 0) {
    const reason =
      `unmappable critical e2e failure(s): ${unmappableCritical.map((s) => s.file).join(", ")} ` +
      "— no manifest entry names this spec";
    await markFailed(deps, runId, reason, attempts);
    return { kind: "failed", run_id: runId, reason };
  }

  // Cadence (Decision 8): pass 1 reopens for ANY mappable failure (critical + throwaway);
  // pass 2+ reopens ONLY for critical. A still-red throwaway on pass 2+ is dropped here —
  // it never blocks (only critical red gates disposition) and never reopens.
  const throwawayCandidates = firstPass
    ? throwawayFailed
        .map((spec) => ({ spec, entry: findEntry(manifest, spec) }))
        .filter((m): m is { spec: E2eSpecResult; entry: E2eManifestEntry } => m.entry !== undefined)
    : [];
  const mappable: Array<{ spec?: E2eSpecResult; entry: E2eManifestEntry }> = [
    ...criticalMisses,
    ...throwawayCandidates,
  ];

  if (mappable.length === 0) {
    // Pass 2+ throwaway tooling failures never gate (Decision 8), but must still
    // surface — otherwise this branch would silently `markDone` past a broken
    // throwaway run.
    const throwawayToolingFailed =
      !firstPass &&
      (throwawayThrew !== undefined ||
        (throwawayResult !== undefined &&
          !throwawayResult.ok &&
          throwawayResult.specs.every((s) => s.status !== "failed")));
    const advisory =
      throwawayFailed.length > 0
        ? `${throwawayFailed.length} throwaway spec(s) still red (non-gating): ` +
          throwawayFailed.map((s) => s.title).join(", ")
        : throwawayToolingFailed
          ? "throwaway suite reported a tooling failure (non-gating)"
          : undefined;
    await markDone(deps, runId, { attempts, advisory });
    return { kind: "done", run_id: runId };
  }

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
    mappable
      .map(
        (m) =>
          `- ${m.entry.spec_path} — "${m.spec ? m.spec.title : "did not run (missing from results)"}"`,
      )
      .join("\n");
  for (const id of taskIds) reopenCounts[id] = (reopenCounts[id] ?? 0) + 1;

  await deps.state.update(runId, (s) => ({
    ...s,
    tasks: Object.fromEntries(
      Object.entries(s.tasks).map(([id, t]) =>
        taskIds.includes(id) ? [id, resetTaskRow(t, { e2eFeedback: feedback })] : [id, t],
      ),
    ),
    e2e_phase: {
      ...(s.e2e_phase ?? defaultE2ePhase()),
      status: undefined,
      reason: undefined,
      advisory: undefined,
      attempts,
      manifest, // already `run.e2e_phase?.manifest` (read at the top of this function) — s.e2e_phase can't have diverged since
      reopen_counts: reopenCounts,
    },
  }));
  log.info(`run '${runId}': e2e reopening task(s) ${taskIds.join(", ")} (pass ${attempts})`);
  return { kind: "reopen", run_id: runId, task_ids: taskIds, reason: feedback };
}
