/**
 * WS6 — exported in-memory fakes for every tool interface in tools.ts.
 *
 * Units test the GateRunner + each strategy WITHOUT the real binaries. Each fake
 * accepts SCRIPTED outputs/exit codes keyed to the ported bash gate-math test
 * vectors (the ORACLE EXCEPTION) so the boundary cases (mutation 79.5 vs 80,
 * coverage delta tolerance, TDD commit classification, SAST allowlist) are
 * reproduced exactly with zero real CLI invocation.
 */
import type { CoverageStore } from "./coverage-store.js";
import type {
  CommandRunner,
  CommitInfo,
  CoverageCommand,
  CoverageMeasurement,
  CoverageSummary,
  CoverageTool,
  EslintTool,
  BuildTool,
  FsProbe,
  GateTools,
  GitProbe,
  ProcResult,
  SemgrepTool,
  StrykerReport,
  StrykerResult,
  StrykerTool,
  ToolRunOpts,
  TscTool,
  VitestTool,
} from "./tools.js";

/** Build a ProcResult from a code + optional streams. */
export function proc(code: number | null, out = "", err = "", truncated = false): ProcResult {
  return { code, stdout: out, stderr: err, truncated };
}

/** A process-style fake (vitest/tsc/eslint/build) that returns a scripted result. */
class FakeProcTool {
  /** Records every invocation for assertions. */
  readonly calls: Array<{ cwd: string; files?: readonly string[] }> = [];
  constructor(private readonly result: ProcResult) {}
  protected record(opts: ToolRunOpts, files?: readonly string[]): ProcResult {
    this.calls.push(files ? { cwd: opts.cwd, files } : { cwd: opts.cwd });
    return this.result;
  }
}

/** Scripted VitestTool. */
export class FakeVitest extends FakeProcTool implements VitestTool {
  async run(files: readonly string[], opts: ToolRunOpts): Promise<ProcResult> {
    return this.record(opts, files);
  }
}

/** Scripted TscTool. */
export class FakeTsc extends FakeProcTool implements TscTool {
  async typecheck(opts: ToolRunOpts): Promise<ProcResult> {
    return this.record(opts);
  }
}

/** Scripted EslintTool. */
export class FakeEslint extends FakeProcTool implements EslintTool {
  async lint(opts: ToolRunOpts): Promise<ProcResult> {
    return this.record(opts);
  }
}

/** Scripted BuildTool. */
export class FakeBuild extends FakeProcTool implements BuildTool {
  async build(opts: ToolRunOpts): Promise<ProcResult> {
    return this.record(opts);
  }
}

/** Scripted SemgrepTool. Records the argv it was handed (post-allowlist). */
export class FakeSemgrep implements SemgrepTool {
  readonly calls: Array<readonly string[]> = [];
  constructor(private readonly result: ProcResult) {}
  async run(command: readonly string[], _opts: ToolRunOpts): Promise<ProcResult> {
    this.calls.push(command);
    return this.result;
  }
}

/** Scripted CommandRunner. Records the contract argv it was handed. */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<readonly string[]> = [];
  constructor(private readonly result: ProcResult) {}
  async run(command: readonly string[], _opts: ToolRunOpts): Promise<ProcResult> {
    this.calls.push(command);
    return this.result;
  }
}

/** Scripted StrykerTool. Records the mutate scope; returns a scripted result. */
export class FakeStryker implements StrykerTool {
  readonly calls: Array<readonly string[]> = [];
  constructor(private readonly result: StrykerResult) {}
  async run(mutate: readonly string[], _opts: ToolRunOpts): Promise<StrykerResult> {
    this.calls.push(mutate);
    return this.result;
  }
}

/**
 * Convenience: build a StrykerResult from a code + optional score. The legacy
 * `score`/`reportPresent` inputs map onto the {@link StrykerReport} union:
 *   - `unparseable: true`     → report unparseable (corrupt JSON).
 *   - `reportPresent: false`  → report absent.
 *   - `score` provided        → report present, with that score (may be null).
 *   - otherwise               → report absent (only reached when code≠0, where the
 *                               report state is irrelevant to the strategy).
 */
export function strykerResult(opts: {
  code: number | null;
  score?: number | null;
  reportPresent?: boolean;
  unparseable?: boolean;
  truncated?: boolean;
}): StrykerResult {
  let report: StrykerReport;
  if (opts.unparseable === true) {
    report = { report: "unparseable" };
  } else if (opts.reportPresent === false) {
    report = { report: "absent" };
  } else if (opts.score !== undefined) {
    report = { report: "present", mutationScore: opts.score };
  } else {
    report = { report: "absent" };
  }
  return { proc: proc(opts.code, "", "", opts.truncated ?? false), report };
}

/** A coverage measurement in the MEASURED state. */
export function measured(summary: CoverageSummary): CoverageMeasurement {
  return { kind: "measured", summary };
}

/** Scripted CoverageTool: seeded head/base measurements; records every call. */
export class FakeCoverageTool implements CoverageTool {
  readonly measureCalls: Array<{ cwd: string; cmd: CoverageCommand }> = [];
  readonly baseCalls: Array<{ baseSha: string; cmd: CoverageCommand }> = [];
  constructor(
    private readonly results: {
      head: CoverageMeasurement;
      base: CoverageMeasurement;
    },
  ) {}
  async measure(cmd: CoverageCommand, opts: ToolRunOpts): Promise<CoverageMeasurement> {
    this.measureCalls.push({ cwd: opts.cwd, cmd });
    return this.results.head;
  }
  async measureAtBase(
    baseSha: string,
    cmd: CoverageCommand,
    _opts: ToolRunOpts,
  ): Promise<CoverageMeasurement> {
    this.baseCalls.push({ baseSha, cmd });
    return this.results.base;
  }
}

/** In-memory {@link CoverageStore}; `entries` exposed for assertions. */
export class MemoryCoverageStore implements CoverageStore {
  readonly entries = new Map<string, CoverageSummary>();
  async get(treeSha: string): Promise<CoverageSummary | null> {
    return this.entries.get(treeSha) ?? null;
  }
  async put(treeSha: string, summary: CoverageSummary): Promise<void> {
    this.entries.set(treeSha, summary);
  }
}

/**
 * In-memory {@link FsProbe}. `new FakeFs()` reports EVERYTHING present (the
 * all-applicable default makeFakeTools wires, so existing lint/mutation tests
 * still hit the run path); `new FakeFs([...])` reports only the listed relative
 * paths present (so applicability-skip tests assert config/binary absence).
 */
export class FakeFs implements FsProbe {
  private readonly present: ReadonlySet<string> | null;
  constructor(present?: readonly string[]) {
    this.present = present === undefined ? null : new Set(present);
  }
  async exists(relPath: string, _opts: ToolRunOpts): Promise<boolean> {
    return this.present === null ? true : this.present.has(relPath);
  }
  async existsAny(relPaths: readonly string[], _opts: ToolRunOpts): Promise<boolean> {
    if (this.present === null) return true;
    return relPaths.some((p) => this.present!.has(p));
  }
}

/**
 * In-memory GitProbe. Scriptable refs, tree-sha, changed files, and the OLDEST-
 * FIRST commit list the TDD strategy classifies. Mirrors the bash repo fixtures
 * (tdd-gate.sh _mk_repo/_commit) without touching real git.
 */
export interface FakeGitProbeOptions {
  /** Refs that resolve (ref → sha). Drives refExists + revParse. */
  readonly refs?: Record<string, string>;
  /** Tree sha for treeSha() memoization. */
  readonly treeSha?: string;
  /** Changed files vs base (for diff-scoped unit + mutation scope). */
  readonly changedFiles?: readonly string[];
  /** Commits in base..HEAD, OLDEST-FIRST (the order the TDD gate classifies). */
  readonly commits?: readonly CommitInfo[];
  /** Throw on commits() to simulate a diff-tree failure (fail-closed test). */
  readonly commitsThrow?: string;
}

export class FakeGitProbe implements GitProbe {
  private readonly refs: Map<string, string>;
  private readonly tree: string;
  private readonly changed: readonly string[];
  private readonly commitList: readonly CommitInfo[];
  private readonly commitsThrow: string | undefined;

  constructor(opts: FakeGitProbeOptions = {}) {
    this.refs = new Map(Object.entries(opts.refs ?? {}));
    this.tree = opts.treeSha ?? "tree-0";
    this.changed = opts.changedFiles ?? [];
    this.commitList = opts.commits ?? [];
    this.commitsThrow = opts.commitsThrow;
  }

  async refExists(ref: string, _opts: ToolRunOpts): Promise<boolean> {
    return this.refs.has(ref);
  }

  async revParse(ref: string, _opts: ToolRunOpts): Promise<string> {
    const sha = this.refs.get(ref);
    if (sha === undefined) throw new Error(`fake git probe: cannot rev-parse '${ref}'`);
    return sha;
  }

  async treeSha(_opts: ToolRunOpts): Promise<string> {
    return this.tree;
  }

  async changedFiles(_base: string, _opts: ToolRunOpts): Promise<readonly string[]> {
    return this.changed;
  }

  async commits(
    _base: string,
    _taskId: string,
    _opts: ToolRunOpts,
  ): Promise<readonly CommitInfo[]> {
    if (this.commitsThrow !== undefined) throw new Error(this.commitsThrow);
    return this.commitList;
  }
}

/** Build a CommitInfo for a TDD fixture commit. */
export function commit(opts: {
  sha: string;
  files: readonly string[];
  tagged: boolean;
  parentCount?: number;
}): CommitInfo {
  return {
    sha: opts.sha,
    files: opts.files,
    tagged: opts.tagged,
    parentCount: opts.parentCount ?? 1,
  };
}

/** Construction options for {@link makeFakeTools}. */
export interface FakeToolsOptions {
  git?: GitProbe;
  vitest?: VitestTool;
  tsc?: TscTool;
  eslint?: EslintTool;
  build?: BuildTool;
  semgrep?: SemgrepTool;
  stryker?: StrykerTool;
  coverage?: CoverageTool;
  fs?: FsProbe;
  command?: CommandRunner;
}

/** Assemble a full GateTools bag from overrides, all-green by default. */
export function makeFakeTools(opts: FakeToolsOptions = {}): GateTools {
  return {
    git: opts.git ?? new FakeGitProbe(),
    vitest: opts.vitest ?? new FakeVitest(proc(0)),
    tsc: opts.tsc ?? new FakeTsc(proc(0)),
    eslint: opts.eslint ?? new FakeEslint(proc(0)),
    build: opts.build ?? new FakeBuild(proc(0)),
    semgrep: opts.semgrep ?? new FakeSemgrep(proc(0)),
    stryker: opts.stryker ?? new FakeStryker(strykerResult({ code: 0, score: 100 })),
    coverage:
      opts.coverage ??
      new FakeCoverageTool({
        head: measured({ lines: 100, branches: 100, functions: 100, statements: 100 }),
        base: measured({ lines: 100, branches: 100, functions: 100, statements: 100 }),
      }),
    fs: opts.fs ?? new FakeFs(),
    command: opts.command ?? new FakeCommandRunner(proc(0)),
  };
}
