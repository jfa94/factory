/**
 * WS12 — the dead-surface scan (Decision 22, Δ S; spine §5).
 *
 * A run that ships a dependency-closed subset of its tasks can leave UNREFERENCED
 * EXPORTS on the integration branch — code that is dead-but-not-broken (an export
 * whose only caller was a task that dropped, scaffolding for a later run, etc.).
 * The dead-surface scan ENUMERATES that surface so a failed run never hides it.
 *
 * REPORT-ONLY, by design (Δ S): it never blocks the rollup. A hard gate would
 * false-positive on legitimate public API and next-run scaffolding and stall
 * autonomy — so this only surfaces findings; the human (or a follow-up run) decides.
 *
 * SCOPED TO THE RUN DIFF: an unreferenced-export tool reports across the whole
 * project; we keep only findings in files the run actually changed (the caller
 * supplies `changedFiles`, exactly as the WS6 gate strategies do). A finding outside
 * the run's diff is pre-existing, not this run's responsibility.
 *
 * The detector is INJECTED ({@link DeadSurfaceRunner}) so the parse + scope logic is
 * unit-tested against canned tool output, and the scan DEGRADES GRACEFULLY: a
 * missing tool is `skipped` (loud note, never a crash), a tool that errors/truncates
 * is `error` — neither throws, because a report-only scan must not be able to fail a
 * finalize.
 */
import { exec } from "../shared/index.js";

/** One unreferenced-export finding. `line` is absent when the tool omits it. */
export interface DeadSurfaceFinding {
  /** Repo-relative file path (as the tool reports it). */
  file: string;
  /** 1-based line of the export, when known. */
  line?: number;
  /** The unreferenced symbol (verbatim from the tool, may carry a tool annotation). */
  name: string;
}

/**
 * Scan outcome:
 *   - `ok`      — the tool ran and produced parseable output.
 *   - `skipped` — the tool was not available (not installed) — informational.
 *   - `error`   — the tool ran but failed / its output was untrustworthy (truncated
 *                 or it died on a signal). Report-only: still not a crash.
 */
export type DeadSurfaceStatus = "ok" | "skipped" | "error";

/** The report-only dead-surface result. Deterministic given (runner output, diff). */
export interface DeadSurfaceReport {
  /** The detector used, e.g. "ts-prune". */
  tool: string;
  status: DeadSurfaceStatus;
  /** Number of changed files the findings were scoped against. */
  changed_file_count: number;
  /** Findings before diff-scoping (whole-project count the tool emitted). */
  total_found: number;
  /** Findings inside the run diff (the actionable subset). */
  findings: DeadSurfaceFinding[];
  /** Human note explaining a skip/error, or a one-line OK summary. */
  note: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (parse + scope) — the unit-tested core
// ---------------------------------------------------------------------------

/**
 * Parse `ts-prune` stdout into findings. ts-prune emits one finding per line:
 *   `path/to/file.ts:42 - exportName`
 *   `path/to/file.ts:42 - exportName (used in module)`
 * The trailing ` (used in module)` annotation is kept verbatim in `name` (it is a
 * weaker signal — exported but only used internally — still dead surface to report).
 * Non-matching lines (blank, banners) are ignored.
 */
export function parseTsPruneOutput(stdout: string): DeadSurfaceFinding[] {
  const out: DeadSurfaceFinding[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // file:line - name   (path may contain spaces; anchor on ":<digits> - ").
    const m = /^(.+):(\d+) - (.+)$/.exec(line);
    if (m === null) continue;
    out.push({ file: m[1]!, line: Number(m[2]), name: m[3]! });
  }
  return out;
}

/** Normalize a path for set membership (strip a single leading `./`). */
function normalizePath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

/**
 * Keep only findings whose file is in the run diff. Order-preserving. An empty
 * `changedFiles` yields no findings (nothing in the diff to attribute them to).
 */
export function scopeToChangedFiles(
  findings: readonly DeadSurfaceFinding[],
  changedFiles: readonly string[],
): DeadSurfaceFinding[] {
  const changed = new Set(changedFiles.map(normalizePath));
  return findings.filter((f) => changed.has(normalizePath(f.file)));
}

// ---------------------------------------------------------------------------
// Injectable detector
// ---------------------------------------------------------------------------

/** Raw result of running the detector. `available:false` ⇒ the tool is not installed. */
export interface DeadSurfaceRunResult {
  available: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** The injected unreferenced-export detector (faked in tests). */
export interface DeadSurfaceRunner {
  /** Tool name, for the report. */
  readonly tool: string;
  /** Run the detector in `cwd` and return its raw output. */
  run(opts: { cwd: string }): Promise<DeadSurfaceRunResult>;
}

/** Substrings in stderr that mean "the tool is not installed" (npx best-effort). */
const UNAVAILABLE_MARKERS = [
  "could not determine executable",
  "command not found",
  "not found",
  "no such file",
];

/**
 * The production detector: `npx --no-install ts-prune` in the target repo. `--no-
 * install` means it uses a LOCALLY-installed ts-prune only (no network, no implicit
 * fetch) — if the repo doesn't have it, the run is reported `skipped`, never a hang.
 * Best-effort by nature (availability detection over npx is heuristic); the parse +
 * scope logic it feeds is the part under test.
 */
export class TsPruneRunner implements DeadSurfaceRunner {
  readonly tool = "ts-prune";
  /** Timeout for the detector, ms. Report-only — a slow tool must not wedge finalize. */
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async run({ cwd }: { cwd: string }): Promise<DeadSurfaceRunResult> {
    try {
      const r = await exec("npx", ["--no-install", "ts-prune"], { cwd, timeoutMs: this.timeoutMs });
      const stderrLc = r.stderr.toLowerCase();
      const looksMissing =
        r.stdout.trim().length === 0 && UNAVAILABLE_MARKERS.some((m) => stderrLc.includes(m));
      return {
        available: !looksMissing,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
      };
    } catch (err) {
      // ENOENT (npx itself missing) ⇒ unavailable, not a crash.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { available: false, code: null, stdout: "", stderr: String(err), truncated: false };
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the dead-surface scan: invoke the detector, parse + scope its findings to the
 * run diff, and return a REPORT-ONLY result. Never throws — a missing/errored tool
 * is reported, not raised, so a finalize that calls this can never fail because of
 * it.
 */
export async function scanDeadSurface(
  runner: DeadSurfaceRunner,
  changedFiles: readonly string[],
  opts: { cwd: string },
): Promise<DeadSurfaceReport> {
  const base = {
    tool: runner.tool,
    changed_file_count: changedFiles.length,
    total_found: 0,
    findings: [] as DeadSurfaceFinding[],
  };

  let result: DeadSurfaceRunResult;
  try {
    result = await runner.run({ cwd: opts.cwd });
  } catch (err) {
    return { ...base, status: "error", note: `${runner.tool} failed: ${(err as Error).message}` };
  }

  if (!result.available) {
    return {
      ...base,
      status: "skipped",
      note: `${runner.tool} not available — install it to enumerate dead surface`,
    };
  }
  if (result.truncated) {
    return {
      ...base,
      status: "error",
      note: `${runner.tool} output was truncated — findings unreliable, not reported`,
    };
  }
  if (result.code === null) {
    return { ...base, status: "error", note: `${runner.tool} was killed before completing` };
  }

  const all = parseTsPruneOutput(result.stdout);
  const scoped = scopeToChangedFiles(all, changedFiles);
  return {
    tool: runner.tool,
    status: "ok",
    changed_file_count: changedFiles.length,
    total_found: all.length,
    findings: scoped,
    note:
      changedFiles.length === 0
        ? "run diff is empty — no files to scope findings to"
        : `${scoped.length} unreferenced export(s) in the run diff (of ${all.length} project-wide)`,
  };
}
