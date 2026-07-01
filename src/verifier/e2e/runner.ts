/**
 * E2E runner module (Decision 39) — the reusable Playwright wrapper the run-level
 * e2e coroutine (src/orchestrator/e2e.ts), the fail-first base/staging proof, and a
 * future debug consumer all shell through. Tool-wrapper style, cf. `DefaultVitestTool`
 * (src/verifier/deterministic/tools.ts:322-338): the real Playwright CLI is wrapped
 * behind an injectable interface so callers unit-test without the binary.
 *
 * Resolves the worktree's own `node_modules/.bin/playwright` and execs it directly —
 * NEVER `npx playwright` — mirroring the anti-decoy / network-free discipline the
 * deterministic gates enforce (tools.ts:240-259): a bare `npx <tool>` under corepack
 * can bypass the pinned local binary and hit the network instead. `GateTool`
 * (deterministic/tools.ts) is a closed, WS6-owned enum; e2e is a distinct domain, so
 * this module owns its own (structurally identical) resolver rather than widening
 * that frozen seam.
 *
 * Criticality (Decision 39) is NOT read here — this module only runs a Playwright
 * invocation and parses its JSON-reporter output. Persistence-vs-throwaway and
 * spec→task mapping (the author manifest) are the coroutine's job, layered over the
 * flat {@link E2eResults} this returns.
 */
import path from "node:path";
import { access } from "node:fs/promises";
import { exec } from "../../shared/index.js";

/** Options for a single {@link runE2e} invocation. */
export interface E2eRunOpts {
  /** Working directory the Playwright CLI runs in (a worktree or the target repo). */
  readonly cwd: string;
  /** Extra/overriding env vars (merged over process.env, unless {@link replaceEnv}) — e.g. BASE_URL. */
  readonly env?: Record<string, string>;
  /**
   * Run with ONLY {@link env} — no inherited `process.env` (Decision 39 W5). The
   * code under test is an autonomously-authored, unreviewed e2e spec; it must not
   * see the parent process's ambient secrets/tokens. Callers pass the PATH, HOME,
   * and FACTORY_E2E/BASE_URL vars the app boot + Playwright resolution actually need.
   */
  readonly replaceEnv?: boolean;
  /**
   * Positional path filter passed to `playwright test` — a directory (the
   * criticality-by-persistence `e2e/` dir, or an ephemeral throwaway dir) or a
   * single spec file (the fail-first proof scopes to exactly one file). Omit to
   * run whatever the target's `playwright.config.ts` `testDir` resolves. Ignored
   * when {@link config} is set — that config's own `testDir` governs instead.
   */
  readonly testDir?: string;
  /** `--grep` pattern, e.g. to re-run one named journey after a reopen. */
  readonly grep?: string;
  /**
   * `--config <path>` — an alternate Playwright config, e.g. the generated
   * throwaway-spec config (whose `testDir` points at the out-of-repo throwaway
   * dir; the run worktree's own committed config only covers the critical suite).
   */
  readonly config?: string;
}

/** Per-spec outcome, already reconciled against retries by Playwright itself. */
export type E2eSpecStatus = "passed" | "failed" | "flaky" | "skipped";

/** One spec's outcome, flattened out of the (possibly-nested, describe-block) suite tree. */
export interface E2eSpecResult {
  readonly file: string;
  readonly title: string;
  readonly status: E2eSpecStatus;
}

/** Parsed result of one {@link runE2e} invocation. */
export interface E2eResults {
  /** True iff no spec is `failed` (a `flaky` or `skipped` spec does not block). */
  readonly ok: boolean;
  readonly specs: readonly E2eSpecResult[];
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly flaky: number;
    readonly skipped: number;
  };
}

/** The minimal process result {@link runE2e} needs from the CLI wrapper. */
export interface E2eProcResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Injectable Playwright CLI wrapper (cf. `VitestTool`) — unit tests fake this. */
export interface PlaywrightTool {
  run(opts: E2eRunOpts): Promise<E2eProcResult>;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A cwd→local-bin resolver, injectable so {@link DefaultPlaywrightTool} unit-tests without fs. */
export type LocalPlaywrightResolver = (cwd: string) => Promise<string | null>;

/**
 * Resolve the worktree's own `node_modules/.bin/playwright`, walking UP from `cwd`
 * so a monorepo/workspace bin at a parent root is found too. Structurally identical
 * to `resolveLocalBin` (deterministic/tools.ts) — see the module header for why this
 * isn't a reuse of that closed-enum seam.
 */
export async function resolveLocalPlaywrightBin(
  cwd: string,
  exists: (p: string) => Promise<boolean> = pathExists,
): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", "playwright");
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * The synthetic FAIL-CLOSED result when no local `playwright` bin resolves — mirrors
 * `missingBinResult` (deterministic/tools.ts:291-302): named, non-zero, no network
 * fallback.
 */
function missingBinResult(cwd: string): E2eProcResult {
  return {
    code: 127,
    stdout: "",
    stderr:
      `playwright: no local binary found under node_modules/.bin (walked up from ${cwd}); ` +
      `refusing the npx fallback — install @playwright/test so the pinned local binary resolves.`,
    truncated: false,
  };
}

/** Default PlaywrightTool: local `playwright test [testDir] [--grep <pattern>] --reporter=json`. */
export class DefaultPlaywrightTool implements PlaywrightTool {
  constructor(private readonly resolve: LocalPlaywrightResolver = resolveLocalPlaywrightBin) {}

  async run(opts: E2eRunOpts): Promise<E2eProcResult> {
    const bin = await this.resolve(opts.cwd);
    if (bin === null) return missingBinResult(opts.cwd);

    const args = ["test"];
    if (opts.config) {
      args.push("--config", opts.config);
    } else if (opts.testDir) {
      args.push(opts.testDir);
    }
    if (opts.grep) args.push("--grep", opts.grep);
    args.push("--reporter=json");

    const result = await exec(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      envMode: opts.replaceEnv ? "replace" : undefined,
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  }
}

// ---------------------------------------------------------------------------
// Playwright JSON-reporter shape (minimal subset consumed) + parsing.
// ---------------------------------------------------------------------------

interface PwJsonTest {
  /** Already reconciled against retries by Playwright — this IS the flaky signal. */
  readonly status: "skipped" | "expected" | "unexpected" | "flaky";
}

interface PwJsonSpec {
  readonly title: string;
  readonly file: string;
  readonly tests: readonly PwJsonTest[];
}

interface PwJsonSuite {
  readonly specs?: readonly PwJsonSpec[];
  readonly suites?: readonly PwJsonSuite[];
}

interface PwJsonReport {
  readonly suites: readonly PwJsonSuite[];
  /** Top-level tooling errors (e.g. a `webServer` boot failure) — distinct from a
   * per-spec failure; Playwright can emit these with an otherwise-empty/clean
   * `suites` tree, which is exactly the silent-pass case this module must not miss. */
  readonly errors?: readonly unknown[];
}

function collectSpecs(suites: readonly PwJsonSuite[] | undefined): PwJsonSpec[] {
  const out: PwJsonSpec[] = [];
  for (const suite of suites ?? []) {
    out.push(...(suite.specs ?? []));
    out.push(...collectSpecs(suite.suites));
  }
  return out;
}

/**
 * Roll a spec's (possibly multi-project) tests up to ONE status. `unexpected`
 * (failed, retries exhausted) always wins; `flaky` (failed then passed on retry) is
 * distinct from `failed` — never a reopen trigger (Decision 8).
 */
function specStatus(spec: PwJsonSpec): E2eSpecStatus {
  const statuses = spec.tests.map((t) => t.status);
  if (statuses.includes("unexpected")) return "failed";
  if (statuses.includes("flaky")) return "flaky";
  if (statuses.length > 0 && statuses.every((s) => s === "skipped")) return "skipped";
  return "passed";
}

/**
 * Parse a Playwright `--reporter=json` payload into {@link E2eResults}. Flattens the
 * (possibly-nested, describe-block) suite tree; counts are derived from the SAME
 * flattened+classified `specs` list this returns, never from the reporter's
 * separate top-level `stats` block, so the two can never disagree.
 *
 * `ok` also gates on the process `code` and the reporter's top-level `errors[]` —
 * NOT just `counts.failed === 0` — because a crashed/errored run (bad boot, no
 * tests matched) can report a clean, zero-failed suite despite having proven
 * nothing (the silent-pass bug this module must not repeat). `code` defaults to 0
 * (success) so direct callers that only care about spec-level classification keep
 * their existing call shape.
 */
export function parseE2eReport(json: string, code: number | null = 0): E2eResults {
  let report: PwJsonReport;
  try {
    report = JSON.parse(json) as PwJsonReport;
  } catch (err) {
    throw new Error(
      `e2e runner: could not parse Playwright JSON reporter output: ${(err as Error).message}`,
    );
  }
  const specs = collectSpecs(report.suites).map((s) => ({
    file: s.file,
    title: s.title,
    status: specStatus(s),
  }));
  const counts = {
    passed: specs.filter((s) => s.status === "passed").length,
    failed: specs.filter((s) => s.status === "failed").length,
    flaky: specs.filter((s) => s.status === "flaky").length,
    skipped: specs.filter((s) => s.status === "skipped").length,
  };
  const ok = counts.failed === 0 && (report.errors ?? []).length === 0 && code === 0;
  return { ok, specs, counts };
}

/**
 * Run Playwright against `opts.cwd` and return the parsed results. Never throws on
 * a failing suite (that's a normal `ok:false` result) — only on a truncated payload
 * or a tool that produced no output at all (a real tooling failure — missing bin,
 * crashed boot — distinct from a red test, which still emits a valid JSON report).
 */
export async function runE2e(
  opts: E2eRunOpts,
  tool: PlaywrightTool = new DefaultPlaywrightTool(),
): Promise<E2eResults> {
  const result = await tool.run(opts);
  if (result.truncated) {
    throw new Error(
      `e2e runner: Playwright JSON reporter output for ${opts.cwd} was TRUNCATED (hit maxBuffer) — refusing to parse a clipped payload`,
    );
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `e2e runner: playwright produced no output (code=${result.code ?? "null"}): ${result.stderr}`,
    );
  }
  return parseE2eReport(result.stdout, result.code);
}
