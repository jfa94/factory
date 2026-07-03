/**
 * WS6 — INJECTABLE tool wrappers for every external CLI a gate touches.
 *
 * git, vitest, tsc, eslint, stryker, semgrep, the coverage-summary reader: each
 * is wrapped behind a tiny interface so unit tests run WITHOUT the real binary
 * (see fakes.ts). The Default* impls shell out via the frozen shared/exec.ts seam
 * — never a bundled dependency (exec.ts module header).
 *
 * LOUD on truncation: a tool whose JSON payload is parsed (stryker, the coverage
 * reader) MUST throw when ExecResult.truncated is set, rather than mis-parse a
 * clipped payload (exec.ts ExecResult.truncated contract).
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { exec, type ExecResult } from "../../shared/index.js";
import { escapeStrykerGlob } from "./scope.js";

/** Common per-call options shared by the CLI wrappers. */
export interface ToolRunOpts {
  /** Working directory the tool runs in (the worktree). */
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Git probe — read-only git used for diff-scoping + TDD commit classification.
// ---------------------------------------------------------------------------

/** A single commit's TDD-relevant classification inputs. */
export interface CommitInfo {
  readonly sha: string;
  /** Files this commit introduces (first-parent for merges — see GitProbe.commitFiles). */
  readonly files: readonly string[];
  /** Number of parents (>1 ⇒ merge commit). */
  readonly parentCount: number;
  /** True iff the commit subject+body contains the `[task-id]` tag. */
  readonly tagged: boolean;
}

/**
 * Read-only git surface the gate strategies need. Distinct from WS3's GitClient
 * (which is mutation-oriented: fetch/checkout/push/worktree). This probe is the
 * narrow read side for diff-scoping + TDD classification, kept injectable so the
 * tdd/mutation strategies unit-test with a {@link import("./fakes.js").FakeGitProbe}.
 */
export interface GitProbe {
  /** True iff `git rev-parse --verify <ref>` resolves (a miss is a normal NO). */
  refExists(ref: string, opts: ToolRunOpts): Promise<boolean>;
  /** Resolve `<ref>` to a sha (e.g. for tip-SHA memoization). Throws if unresolved. */
  revParse(ref: string, opts: ToolRunOpts): Promise<string>;
  /** The worktree's tree object sha (`git rev-parse HEAD^{tree}`) for tree-SHA memo. */
  treeSha(opts: ToolRunOpts): Promise<string>;
  /**
   * Changed files vs the base (`git diff --name-only --diff-filter=AM
   * <base>...HEAD`). Used for diff-scoped unit + blob-scoped mutation. The
   * triple-dot is the symmetric-difference form CI uses.
   */
  changedFiles(base: string, opts: ToolRunOpts): Promise<readonly string[]>;
  /**
   * Commits in `<base>..HEAD`, OLDEST-FIRST, each with its classification inputs.
   * The probe owns the per-commit diff-tree (first-parent for merges) + the
   * `[task-id]` tag detection so the tdd strategy stays pure classification logic.
   * Throws LOUD on a diff-tree error (fail-closed — bin/pipeline-tdd-gate:103).
   */
  commits(base: string, taskId: string, opts: ToolRunOpts): Promise<readonly CommitInfo[]>;
}

// ---------------------------------------------------------------------------
// Process-result tools (test / type / lint / build / sast): pass = exit 0.
// ---------------------------------------------------------------------------

/** The minimal result a process-style gate cares about. */
export interface ProcResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Vitest runner (unit + integration test gates). */
export interface VitestTool {
  /** Run vitest (optionally scoped to `files`). Pass = exit 0. */
  run(files: readonly string[], opts: ToolRunOpts): Promise<ProcResult>;
}

/** tsc --noEmit type-check gate. */
export interface TscTool {
  typecheck(opts: ToolRunOpts): Promise<ProcResult>;
}

/** eslint (+ dependency-cruiser where present) lint gate. */
export interface EslintTool {
  lint(opts: ToolRunOpts): Promise<ProcResult>;
}

/** Build gate (e.g. `npm run build`). */
export interface BuildTool {
  build(opts: ToolRunOpts): Promise<ProcResult>;
}

/** Semgrep / configured-securityCommand SAST gate. */
export interface SemgrepTool {
  /**
   * Run the configured security command (argv form, already allowlist-validated by
   * the strategy). Pass = exit 0. Returns raw stdout/stderr so the strategy can
   * redact findings before persistence.
   */
  run(command: readonly string[], opts: ToolRunOpts): Promise<ProcResult>;
}

/**
 * Contracted gate-command runner (S7, Decision 46): executes a `.factory/gates.json`
 * `command` override (argv form, already allowlist-validated by contractCommand).
 * Pass = exit 0. The command-gate strategies (test/type/build/lint) route through
 * this instead of their built-in tool when the contract carries a command.
 */
export interface CommandRunner {
  run(command: readonly string[], opts: ToolRunOpts): Promise<ProcResult>;
}

// ---------------------------------------------------------------------------
// Report-reading tools (mutation / coverage): parse JSON, fail loud on truncation.
// ---------------------------------------------------------------------------

/**
 * The state of the stryker mutation report, as a discriminated union so illegal
 * combinations (e.g. "absent but scored", "unparseable yet carries a score") are
 * unrepresentable, and a PARSE error is distinguishable from a legitimately
 * score-less report:
 *   - `absent`      — no report file was produced.
 *   - `unparseable` — a report file existed but its JSON did not parse (corrupt).
 *   - `present`     — the report parsed; `mutationScore` is the derived score
 *                     (from `.metrics.mutationScore` if present, else computed from
 *                     the per-file mutant tally), or null when no score is derivable.
 * The strategy maps absent/unparseable/score-null to fail-closed answers when the
 * mutation scope is non-empty.
 */
export type StrykerReport =
  | { readonly report: "absent" }
  | { readonly report: "unparseable" }
  | { readonly report: "present"; readonly mutationScore: number | null };

/** Outcome of a stryker run: the process result + the parsed report state. */
export interface StrykerResult {
  readonly proc: ProcResult;
  readonly report: StrykerReport;
}

/** Stryker mutation runner. */
export interface StrykerTool {
  /**
   * Run stryker scoped to `mutate` (CSV of files) and read the report. Throws LOUD
   * if the report JSON was truncated. A non-zero process exit is reported in
   * `proc.code` (the strategy maps it to stryker-failed), NOT thrown.
   */
  run(mutate: readonly string[], opts: ToolRunOpts): Promise<StrykerResult>;
}

/** A coverage-v8 total summary (percentages 0..100). */
export interface CoverageSummary {
  readonly lines: number;
  readonly branches: number;
  readonly functions: number;
  readonly statements: number;
}

/**
 * The outcome of reading ONE coverage summary, as a discriminated union so the
 * strategy can tell ABSENT (file never produced — the project did not capture
 * coverage) apart from INVALID (file present but corrupt / missing a metric). The
 * distinction is load-bearing: BOTH summaries absent ⇒ the coverage gate is not
 * applicable (skip); a present-but-invalid (or asymmetric one-absent) summary is a
 * real anomaly ⇒ fail-closed. The old conflated `null` forced a fail on a clean
 * repo that never opted into coverage.
 */
export type CoverageRead =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "ok"; readonly summary: CoverageSummary };

/**
 * Reads a coverage-v8 JSON summary, distinguishing absent from invalid (see
 * {@link CoverageRead}). Throws only on a truncated read.
 */
export interface CoverageReader {
  read(label: "before" | "after", opts: ToolRunOpts): Promise<CoverageRead>;
}

/**
 * A read-only filesystem probe for GATE APPLICABILITY: a gate whose config or tool
 * binary is absent from the worktree is NOT APPLICABLE (a skip), never a fail.
 * Extends the sast "no-security-command" precedent to lint/mutation — a project
 * that never opted into eslint/stryker (no config, or the binary not installed)
 * must not fail-close every task. Injectable so units test without touching disk.
 */
export interface FsProbe {
  /** True iff `relPath` (resolved under `opts.cwd`) exists. */
  exists(relPath: string, opts: ToolRunOpts): Promise<boolean>;
  /** True iff ANY of `relPaths` (resolved under `opts.cwd`) exists. */
  existsAny(relPaths: readonly string[], opts: ToolRunOpts): Promise<boolean>;
}

/** The full injected tool-bag a {@link import("./gate-runner.js").GateRunner} carries. */
export interface GateTools {
  readonly git: GitProbe;
  readonly vitest: VitestTool;
  readonly tsc: TscTool;
  readonly eslint: EslintTool;
  readonly build: BuildTool;
  readonly semgrep: SemgrepTool;
  readonly stryker: StrykerTool;
  readonly coverage: CoverageReader;
  readonly fs: FsProbe;
  readonly command: CommandRunner;
}

// ---------------------------------------------------------------------------
// Default implementations over the real binaries (via shared/exec.ts).
// ---------------------------------------------------------------------------

function toProc(r: ExecResult): ProcResult {
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated };
}

/** Guard: refuse to parse a clipped payload (exec.ts ExecResult.truncated). */
function assertNotTruncated(r: ExecResult, what: string): void {
  if (r.truncated) {
    throw new Error(
      `WS6 tool output for ${what} was TRUNCATED (hit maxBuffer) — refusing to parse a clipped payload`,
    );
  }
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** The closed set of external command-gate tools resolved via `node_modules/.bin`. */
export type GateTool = "vitest" | "tsc" | "eslint" | "stryker";

/**
 * Resolve a {@link GateTool} to the worktree's OWN `node_modules/.bin/<tool>`,
 * walking UP from `cwd` so a monorepo/workspace bin at a parent root is found too.
 * Returns the absolute bin path, or null when no `node_modules/.bin/<tool>` exists
 * up to the filesystem root.
 *
 * WHY this exists: the command-gates must NOT shell out via `npx <tool>`. Under
 * corepack + a `packageManager: pnpm@…` field (node ≥ 24), a bare `npx <tool>`
 * bypasses the installed `node_modules/.bin` and resolves a REMOTE registry
 * package instead — e.g. `npx tsc` fetches the unrelated `tsc` decoy and exits 1,
 * a false type-gate failure independent of the code under test. Executing the
 * local bin directly is package-manager-agnostic and never touches the network.
 * When no local bin resolves, {@link runTool} FAILS CLOSED (a named non-zero
 * result) rather than reintroducing the npx path — so npx is never reached.
 *
 * SECURITY (deliberate non-containment): the candidate is returned as-is and
 * exec'd by {@link runTool} WITHOUT realpath/containment, and the walk-up ascends
 * to the filesystem root. This is intentional. (1) A `node_modules/.bin` entry is
 * normally a symlink — pnpm's point INTO the content-addressed `.pnpm` store
 * outside the package dir — so a naive "realpath must stay inside the worktree"
 * guard would REJECT every pnpm install (the exact package manager whose npx
 * decoy this code exists to dodge). (2) The gate layer already executes
 * worktree-controlled code on this same trust boundary (`DefaultBuildTool` runs
 * `npm run build`; vitest/stryker honour worktree configs), so following a
 * `.bin` symlink crosses no privilege boundary the gates did not already cross.
 */
export async function resolveLocalBin(
  cwd: string,
  tool: GateTool,
  exists: (absPath: string) => Promise<boolean> = pathExists,
): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", tool);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/** A tool→local-bin resolver, injectable so the Default* tools unit-test without fs. */
export type LocalBinResolver = (tool: GateTool, opts: ToolRunOpts) => Promise<string | null>;

/** Production resolver: walk up from the worktree cwd to the nearest local bin. */
export const defaultLocalBinResolver: LocalBinResolver = (tool, opts) =>
  resolveLocalBin(opts.cwd, tool);

/**
 * The synthetic FAIL-CLOSED result a command gate gets when no local bin resolves:
 * exit 127 (the shell "command not found" convention) with a stderr that names the
 * missing tool and WHY we do not fall back to npx. {@link procOutcome} maps the
 * non-zero code to a failing {@link GateOutcome}, so the gate blocks LOUDLY instead
 * of silently shelling to a network-fetched decoy. lint/mutation never reach here
 * (their strategies skip on a missing bin first); only the unconditional type/test
 * gates can, and a missing tsc/vitest in a provisioned worktree IS a real failure.
 */
function missingBinResult(tool: GateTool, cwd: string): ExecResult {
  return {
    stdout: "",
    stderr:
      `${tool}: no local binary found under node_modules/.bin (walked up from ${cwd}); ` +
      `refusing the npx fallback — a bare \`npx ${tool}\` resolves a remote registry ` +
      `decoy under corepack/pnpm. Install dev dependencies so ${tool} resolves locally.`,
    code: 127,
    signal: null,
    truncated: false,
  };
}

/**
 * Resolve `tool`'s worktree-local bin and exec it DIRECTLY; if none resolves, fail
 * closed via {@link missingBinResult} (never npx). Package-manager-agnostic and
 * network-free on both paths.
 */
async function runTool(
  resolve: LocalBinResolver,
  tool: GateTool,
  toolArgs: readonly string[],
  opts: ToolRunOpts,
  env: Record<string, string> = {},
): Promise<ExecResult> {
  const localBin = await resolve(tool, opts);
  if (localBin === null) return missingBinResult(tool, opts.cwd);
  return exec(localBin, [...toolArgs], { cwd: opts.cwd, env });
}

/** Default VitestTool: local `vitest run [files...]`, coverage DISABLED. */
export class DefaultVitestTool implements VitestTool {
  constructor(
    private readonly resolve: LocalBinResolver = defaultLocalBinResolver,
    private readonly env: Record<string, string> = {},
  ) {}

  async run(files: readonly string[], opts: ToolRunOpts): Promise<ProcResult> {
    // Coverage is DISABLED here on purpose. The test gate is a PASS/FAIL gate and
    // it runs DIFF-SCOPED (only the changed test files). A project whose vitest
    // config forces `coverage.enabled: true` with perFile thresholds would FAIL a
    // scoped run — every file the scoped tests don't exercise reports 0% — a false
    // negative unrelated to whether the tests pass. Coverage is the coverage
    // gate's job (before/after summaries), never this gate's.
    const args = ["run", "--coverage.enabled=false", ...files];
    return toProc(await runTool(this.resolve, "vitest", args, opts, this.env));
  }
}

/** Default TscTool: local `tsc --noEmit`. */
export class DefaultTscTool implements TscTool {
  constructor(
    private readonly resolve: LocalBinResolver = defaultLocalBinResolver,
    private readonly env: Record<string, string> = {},
  ) {}

  async typecheck(opts: ToolRunOpts): Promise<ProcResult> {
    return toProc(await runTool(this.resolve, "tsc", ["--noEmit"], opts, this.env));
  }
}

/** Default EslintTool: local `eslint .`. */
export class DefaultEslintTool implements EslintTool {
  constructor(
    private readonly resolve: LocalBinResolver = defaultLocalBinResolver,
    private readonly env: Record<string, string> = {},
  ) {}

  async lint(opts: ToolRunOpts): Promise<ProcResult> {
    return toProc(await runTool(this.resolve, "eslint", ["."], opts, this.env));
  }
}

/** Default BuildTool: `npm run build`. */
export class DefaultBuildTool implements BuildTool {
  constructor(private readonly env: Record<string, string> = {}) {}

  async build(opts: ToolRunOpts): Promise<ProcResult> {
    return toProc(await exec("npm", ["run", "build"], { cwd: opts.cwd, env: this.env }));
  }
}

/** Default SemgrepTool: run the already-validated argv directly. */
export class DefaultSemgrepTool implements SemgrepTool {
  constructor(private readonly env: Record<string, string> = {}) {}

  async run(command: readonly string[], opts: ToolRunOpts): Promise<ProcResult> {
    const [bin, ...rest] = command;
    if (bin === undefined) {
      throw new Error("DefaultSemgrepTool: empty command");
    }
    return toProc(await exec(bin, rest, { cwd: opts.cwd, env: this.env }));
  }
}

/** Default CommandRunner: run the already-validated contract argv directly. */
export class DefaultCommandRunner implements CommandRunner {
  constructor(private readonly env: Record<string, string> = {}) {}

  async run(command: readonly string[], opts: ToolRunOpts): Promise<ProcResult> {
    const [bin, ...rest] = command;
    if (bin === undefined) {
      throw new Error("DefaultCommandRunner: empty command");
    }
    return toProc(await exec(bin, rest, { cwd: opts.cwd, env: this.env }));
  }
}

/** Default StrykerTool: local `stryker run --mutate <csv>`, then read the report. */
export class DefaultStrykerTool implements StrykerTool {
  /** Report path relative to the worktree (stryker html/json reporter default). */
  static readonly REPORT_PATH = "reports/mutation/mutation.json";

  constructor(
    private readonly resolve: LocalBinResolver = defaultLocalBinResolver,
    private readonly env: Record<string, string> = {},
  ) {}

  async run(mutate: readonly string[], opts: ToolRunOpts): Promise<StrykerResult> {
    const csv = mutate.map(escapeStrykerGlob).join(",");
    const proc = toProc(
      await runTool(this.resolve, "stryker", ["run", "--mutate", csv], opts, this.env),
    );
    // A non-zero stryker exit is a legitimate ANSWER (stryker-failed) — the
    // strategy branches on proc.code; we still attempt to read a report.
    const reportPath = path.join(opts.cwd, DefaultStrykerTool.REPORT_PATH);
    let raw: string;
    try {
      raw = await readFile(reportPath, "utf8");
    } catch {
      return { proc, report: { report: "absent" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A present-but-corrupt report is distinct from a legitimately score-less one
      // — surfaced as `unparseable` so the strategy can fail-closed without
      // conflating it with no-score.
      return { proc, report: { report: "unparseable" } };
    }
    const score = extractMutationScore(parsed);
    return { proc, report: { report: "present", mutationScore: score } };
  }
}

/**
 * Pull the mutation score (a finite number, 0-100) out of a parsed stryker report.
 *
 * Two paths, in order:
 *   1. FAST PATH — a finite `.metrics.mutationScore`. Stryker's STOCK `json`
 *      reporter (schema-1.0) does NOT emit this; it is a *derived* metric the HTML
 *      reporter / `mutation-testing-metrics` compute. We honor it only if a
 *      metrics-emitting reporter happens to be configured (forward-compat).
 *   2. DERIVE — else compute from the schema-1.0 `files[*].mutants[*].status`
 *      tally, exactly as stryker's own `break` threshold and the metrics lib do
 *      (see {@link computeMutationScore}). This is the path that actually fires for
 *      the stock reporter every target repo + the factory template use.
 * `null` only when NEITHER yields a finite number (no metrics AND no scorable
 * mutants) — preserving the gate's fail-closed posture for a genuinely score-less
 * report.
 */
export function extractMutationScore(report: unknown): number | null {
  if (typeof report !== "object" || report === null) return null;
  const metrics = (report as { metrics?: unknown }).metrics;
  if (typeof metrics === "object" && metrics !== null) {
    const score = (metrics as { mutationScore?: unknown }).mutationScore;
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  return computeMutationScore(report);
}

/** Mutant statuses counted as DETECTED in stryker's mutation-score formula. */
const DETECTED_STATUSES = new Set(["killed", "timeout"]);
/** Mutant statuses counted as UNDETECTED (valid but live). */
const UNDETECTED_STATUSES = new Set(["survived", "nocoverage"]);

/**
 * Derive `mutationScore` from a schema-1.0 report's per-file mutant statuses,
 * matching `mutation-testing-metrics` (and what stryker's `break` compares):
 *   detected = killed + timeout
 *   undetected = survived + noCoverage
 *   valid = detected + undetected   (excludes CompileError/RuntimeError/Ignored/Pending)
 *   score = valid > 0 ? detected / valid * 100 : null
 * Status strings are lower-cased before tallying so casing variants
 * ("Killed"/"killed") count identically. Returns `null` when there are no files,
 * no mutants, or zero VALID mutants — the gate then fails closed.
 */
function computeMutationScore(report: unknown): number | null {
  const files = (report as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) return null;
  let detected = 0;
  let valid = 0;
  for (const file of Object.values(files as Record<string, unknown>)) {
    const mutants = (file as { mutants?: unknown }).mutants;
    if (!Array.isArray(mutants)) continue;
    for (const mutant of mutants) {
      const rawStatus = (mutant as { status?: unknown }).status;
      if (typeof rawStatus !== "string") continue;
      const status = rawStatus.toLowerCase();
      if (DETECTED_STATUSES.has(status)) {
        detected += 1;
        valid += 1;
      } else if (UNDETECTED_STATUSES.has(status)) {
        valid += 1;
      }
    }
  }
  return valid > 0 ? (detected / valid) * 100 : null;
}

/**
 * Default CoverageReader: reads a coverage-v8 summary from a conventional path
 * (`coverage/<label>-coverage-summary.json`). Supports both the `{lines:{pct}}`
 * and `{lines: N}` shapes (bin/pipeline-coverage-gate:59-67).
 */
export class DefaultCoverageReader implements CoverageReader {
  async read(label: "before" | "after", opts: ToolRunOpts): Promise<CoverageRead> {
    const file = path.join(opts.cwd, "coverage", `${label}-coverage-summary.json`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      // File not produced → ABSENT (the project did not capture this coverage).
      return { state: "absent" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Present but corrupt JSON → INVALID (a real anomaly, not absence).
      return { state: "invalid" };
    }
    const summary = parseCoverageSummary(parsed);
    return summary === null ? { state: "invalid" } : { state: "ok", summary };
  }
}

/**
 * Default {@link FsProbe} over node:fs — an existence check resolved under cwd.
 * Used by the lint/mutation strategies to decide applicability (config + tool
 * binary present in the worktree) before running the gate.
 */
export class DefaultFsProbe implements FsProbe {
  async exists(relPath: string, opts: ToolRunOpts): Promise<boolean> {
    try {
      await access(path.join(opts.cwd, relPath));
      return true;
    } catch {
      return false;
    }
  }

  async existsAny(relPaths: readonly string[], opts: ToolRunOpts): Promise<boolean> {
    for (const rel of relPaths) {
      if (await this.exists(rel, opts)) return true;
    }
    return false;
  }
}

/** Read one metric from a `total.*` entry, supporting object-or-scalar shapes. */
function readMetric(total: Record<string, unknown>, key: string): number | null {
  const v = total[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v !== null) {
    const pct = (v as { pct?: unknown }).pct;
    if (typeof pct === "number" && Number.isFinite(pct)) return pct;
  }
  return null;
}

/** Parse a coverage-v8 summary into the four totals, or null if any is missing. */
export function parseCoverageSummary(report: unknown): CoverageSummary | null {
  if (typeof report !== "object" || report === null) return null;
  const total = (report as { total?: unknown }).total;
  if (typeof total !== "object" || total === null) return null;
  const t = total as Record<string, unknown>;
  const lines = readMetric(t, "lines");
  const branches = readMetric(t, "branches");
  const functions = readMetric(t, "functions");
  const statements = readMetric(t, "statements");
  if (lines === null || branches === null || functions === null || statements === null) {
    return null;
  }
  return { lines, branches, functions, statements };
}

/**
 * Default GitProbe over shared/exec.ts (no shell). All ops run in `opts.cwd`.
 */
export class DefaultGitProbe implements GitProbe {
  private async git(args: readonly string[], cwd: string): Promise<ExecResult> {
    return exec("git", args, { cwd });
  }

  async refExists(ref: string, opts: ToolRunOpts): Promise<boolean> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", ref], opts.cwd);
    return r.code === 0;
  }

  async revParse(ref: string, opts: ToolRunOpts): Promise<string> {
    const r = await this.git(["rev-parse", ref], opts.cwd);
    if (r.code !== 0) {
      throw new Error(`git rev-parse ${ref} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  }

  async treeSha(opts: ToolRunOpts): Promise<string> {
    return this.revParse("HEAD^{tree}", opts);
  }

  async changedFiles(base: string, opts: ToolRunOpts): Promise<readonly string[]> {
    const r = await this.git(
      ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
      opts.cwd,
    );
    if (r.code !== 0) {
      throw new Error(`git diff vs ${base} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    assertNotTruncated(r, "git diff --name-only");
    return splitLines(r.stdout);
  }

  async commits(base: string, taskId: string, opts: ToolRunOpts): Promise<readonly CommitInfo[]> {
    const log = await this.git(["log", "--format=%H", `${base}..HEAD`], opts.cwd);
    if (log.code !== 0) {
      throw new Error(
        `git log ${base}..HEAD failed (code=${log.code ?? "null"}): ${log.stderr.trim()}`,
      );
    }
    // A truncated commit list silently drops commits → the classifier sees a
    // partial history → false TDD PASS on the authority-of-record path. Fail LOUD
    // on every parse in this method (mirrors changedFiles).
    assertNotTruncated(log, "git log (tdd classification)");
    // git log is newest-first; the TDD gate classifies OLDEST-first.
    const shas = splitLines(log.stdout).reverse();
    const out: CommitInfo[] = [];
    for (const sha of shas) {
      const parents = await this.git(["show", "-s", "--format=%P", sha], opts.cwd);
      if (parents.code !== 0) {
        throw new Error(`git show parents of ${sha} failed: ${parents.stderr.trim()}`);
      }
      assertNotTruncated(parents, `git show parents of ${sha}`);
      const parentShas = parents.stdout
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0);
      const parentCount = parentShas.length;
      let files: string[];
      if (parentCount > 1) {
        // Merge: classify files the merge introduces vs its FIRST parent
        // (bin/pipeline-tdd-gate:98-99).
        const firstParent = parentShas[0]!;
        const dt = await this.git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", firstParent, sha],
          opts.cwd,
        );
        if (dt.code !== 0) {
          throw new Error(`git diff-tree failed for ${sha}: ${dt.stderr.trim()}`);
        }
        assertNotTruncated(dt, `git diff-tree (merge) for ${sha}`);
        files = splitLines(dt.stdout);
      } else {
        const dt = await this.git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
          opts.cwd,
        );
        if (dt.code !== 0) {
          throw new Error(`git diff-tree failed for ${sha}: ${dt.stderr.trim()}`);
        }
        assertNotTruncated(dt, `git diff-tree for ${sha}`);
        files = splitLines(dt.stdout);
      }
      const subjBody = await this.git(["log", "-1", "--format=%s%n%b", sha], opts.cwd);
      if (subjBody.code !== 0) {
        throw new Error(`git log subject/body of ${sha} failed: ${subjBody.stderr.trim()}`);
      }
      assertNotTruncated(subjBody, `git log subject/body of ${sha}`);
      const tagged = subjBody.stdout.includes(`[${taskId}]`);
      out.push({ sha, files, parentCount, tagged });
    }
    return out;
  }
}

/** Split command stdout into non-empty trimmed lines. */
function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Assemble the production {@link GateTools} bag over the real binaries (each
 * Default* impl shells out via shared/exec.ts). This is the seam the CLI wiring
 * (and any non-test orchestrator) constructs once and threads into the GateRunner; unit
 * tests use {@link import("./fakes.js").makeFakeTools} instead.
 */
export function defaultGateTools(gateEnv: Record<string, string> = {}): GateTools {
  return {
    git: new DefaultGitProbe(),
    vitest: new DefaultVitestTool(defaultLocalBinResolver, gateEnv),
    tsc: new DefaultTscTool(defaultLocalBinResolver, gateEnv),
    eslint: new DefaultEslintTool(defaultLocalBinResolver, gateEnv),
    build: new DefaultBuildTool(gateEnv),
    semgrep: new DefaultSemgrepTool(gateEnv),
    stryker: new DefaultStrykerTool(defaultLocalBinResolver, gateEnv),
    coverage: new DefaultCoverageReader(),
    fs: new DefaultFsProbe(),
    command: new DefaultCommandRunner(gateEnv),
  };
}
