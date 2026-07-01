import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  debugStart,
  debugReviewEmit,
  debugReviewRecord,
  debugSpecResolve,
  debugSpecGate,
  debugSpecStore,
  debugSeed,
  debugFinalize,
  debugCommand,
  type DebugDeps,
} from "./debug.js";
import { EXIT } from "../../shared/exit-codes.js";
import { FakeGitClient } from "../../git/index.js";
import { loadConfig } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { SpecStore, buildManifest } from "../../spec/index.js";
import { createRun } from "./run.js";
import type { ReviewerVerifications } from "../../orchestrator/record.js";

const REPO = "owner/app";

let dataDir: string;
let cwd: string;
let gitClient: FakeGitClient;
let originalCwd: string;

/** A FakeGitClient whose origin remote-url resolves to REPO and whose base/staging branches already exist remotely (so ensureStaging FFs cleanly). */
function makeGitClient(): FakeGitClient {
  const git = new FakeGitClient();
  git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
  git.setRemoteHead("develop", "sha-develop-1");
  return git;
}

function deps(): DebugDeps {
  return {
    gitClient,
    config: loadConfig({ dataDir }),
    dataDir,
    cwd,
    state: new StateManager({ dataDir }),
    specStore: new SpecStore({ dataDir }),
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "debug-seam-"));
  cwd = await mkdtemp(join(tmpdir(), "debug-worktree-"));
  gitClient = makeGitClient();
  // `SpecStore.write` (via `storeSpec`) mirrors spec.md/tasks.json into
  // `<docsRoot>/factory/<spec-id>/`, defaulting `docsRoot` to `process.cwd()`
  // (production is cwd-rooted in the target-repo checkout — see
  // `reference_factory_target_cwd`). Chdir into the temp worktree so any real
  // `storeSpec` write in these tests lands there instead of this repo's own
  // `docs/` — mirroring production where `process.cwd()` IS the debug worktree.
  originalCwd = process.cwd();
  process.chdir(cwd);
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(dataDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("debugStart", () => {
  it("mints a run id, cuts the debug staging branch, and emits the pass-1 review scope", async () => {
    const env = await debugStart(deps(), {});
    expect(env.kind).toBe("review");
    if (env.kind !== "review") throw new Error("unreachable");
    expect(env.pass).toBe(1);
    expect(env.base).toBe("HEAD~1");
    expect(env.worktree).toBe(cwd);
    expect(gitClient.localBranches.has(`staging-${env.run_id}`)).toBe(true);
  });

  it("--full diffs against the empty-tree SHA instead of --base", async () => {
    const env = await debugStart(deps(), { full: true });
    if (env.kind !== "review") throw new Error("unreachable");
    expect(env.base).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("rejects --base and --full together", async () => {
    await expect(debugStart(deps(), { full: true, base: "HEAD~3" })).rejects.toThrow(
      /exactly one of --base or --full/,
    );
  });

  it("rejects a non-positive --max-passes", async () => {
    await expect(debugStart(deps(), { maxPasses: 0 })).rejects.toThrow(/--max-passes/);
  });
});

describe("debugReviewEmit", () => {
  it("builds the whole-scope panel spawn manifest for the session's base/worktree", async () => {
    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");

    const env = await debugReviewEmit(d, started.run_id);
    expect(env.kind).toBe("review-spawn");
    if (env.kind !== "review-spawn") throw new Error("unreachable");
    expect(env.pass).toBe(1);
    expect(env.base).toBe("HEAD~1");
    expect(env.worktree).toBe(cwd);
    expect(env.manifest.resume_phase).toBe("verify");
  });
});

describe("debugReviewRecord", () => {
  /** A minimal RawReview a citable finding's file must exist in `cwd` for citation-verify to pass. */
  async function seedCitableFile(): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "thing.ts"), "line one\nline two\nline three\n", "utf8");
  }

  it("emits clean when the panel confirms zero blockers and e2e is unconfigured (skipped)", async () => {
    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");

    const reviews = [
      {
        reviewer: "quality-reviewer",
        verdict: "approve",
        summary: "looks fine",
        findings: [] as unknown[],
      },
    ];
    const verifications: ReviewerVerifications[] = [];

    const env = await debugReviewRecord(d, started.run_id, { reviews, verifications });
    expect(env).toEqual({ kind: "clean", run_id: started.run_id, pass: 1 });
  });

  it("emits findings + writes the report when the panel confirms a blocker", async () => {
    await seedCitableFile();
    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");

    const reviews = [
      {
        reviewer: "quality-reviewer",
        verdict: "blocked",
        summary: "one blocker",
        findings: [
          {
            reviewer: "quality-reviewer",
            severity: "critical",
            blocking: true,
            file: "src/thing.ts",
            line: 2,
            quote: "line two",
            description: "this is broken",
          },
        ],
      },
    ];
    const verifications: ReviewerVerifications[] = [
      {
        reviewer: "quality-reviewer",
        verdicts: [{ file: "src/thing.ts", line: 2, holds: true, note: "confirmed" }],
      },
    ];

    const env = await debugReviewRecord(d, started.run_id, { reviews, verifications });
    expect(env.kind).toBe("findings");
    if (env.kind !== "findings") throw new Error("unreachable");
    expect(env.pass).toBe(1);
    expect(env.confirmed_count).toBe(1);

    const report = await readFile(env.report_path, "utf8");
    expect(report).toContain("this is broken");
    expect(report).toContain("Factory Debug Pass 1");
  });
});

describe("debug spec resolve|gate|store — pass-through", () => {
  it("throws LOUD when no review has been recorded for the pass yet", async () => {
    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");

    await expect(debugSpecResolve(d, started.run_id)).rejects.toThrow(/no recorded review/);
  });

  it("resolve emits a generate spawn fed the synthetic PRD rendered from confirmed blockers", async () => {
    await (await import("node:fs/promises")).mkdir(join(cwd, "src"), { recursive: true });
    await (
      await import("node:fs/promises")
    ).writeFile(join(cwd, "src", "thing.ts"), "line one\nline two\n", "utf8");

    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");

    const reviews = [
      {
        reviewer: "quality-reviewer",
        verdict: "blocked",
        summary: "one blocker",
        findings: [
          {
            reviewer: "quality-reviewer",
            severity: "critical",
            blocking: true,
            file: "src/thing.ts",
            line: 2,
            quote: "line two",
            description: "fix this",
          },
        ],
      },
    ];
    const verifications: ReviewerVerifications[] = [
      {
        reviewer: "quality-reviewer",
        verdicts: [{ file: "src/thing.ts", line: 2, holds: true, note: "confirmed" }],
      },
    ];
    await debugReviewRecord(d, started.run_id, { reviews, verifications });

    const env = await debugSpecResolve(d, started.run_id);
    expect(env.kind).toBe("generate");
    if (env.kind !== "generate") throw new Error("unreachable");

    const prd = JSON.parse(await readFile(env.prd_path, "utf8")) as { body: string };
    expect(prd.body).toContain("fix this");
  });

  it("gate/store round-trip: a PASS-worthy spec gates to review, then stores + persists spec_id onto the session", async () => {
    const { mkdir: mkdirEarly, writeFile: writeFileEarly } = await import("node:fs/promises");
    await mkdirEarly(join(cwd, "src"), { recursive: true });
    await writeFileEarly(join(cwd, "src", "thing.ts"), "line one\nline two\n", "utf8");

    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");
    // The finding's description carries a normative ("must") sentence so the
    // synthetic PRD's traceability gate (PRD = axiom) has an extractable
    // requirement to check the spec's acceptance criteria against — an
    // empty-blocker ("clean") PRD has none, so it can never pass this gate.
    const reviews = [
      {
        reviewer: "quality-reviewer",
        verdict: "blocked",
        findings: [
          {
            reviewer: "quality-reviewer",
            severity: "critical",
            blocking: true,
            file: "src/thing.ts",
            line: 2,
            quote: "line two",
            description: "The thing must be fixed so it returns the correct output.",
          },
        ],
      },
    ];
    const verifications: ReviewerVerifications[] = [
      {
        reviewer: "quality-reviewer",
        verdicts: [{ file: "src/thing.ts", line: 2, holds: true, note: "confirmed" }],
      },
    ];
    await debugReviewRecord(d, started.run_id, { reviews, verifications });
    await debugSpecResolve(d, started.run_id);

    const { mkdir, writeFile } = await import("node:fs/promises");
    const { specBuildDir } = await import("../../core/state/paths.js");
    const { stringifyJson } = await import("../../shared/json.js");
    const buildDir = specBuildDir(dataDir, REPO, 2_000_000_001);
    await mkdir(buildDir, { recursive: true });
    await writeFile(
      join(buildDir, "generated.json"),
      stringifyJson({
        specMd: "# Fix\n\nFix the thing.",
        slug: "fix-thing",
        tasks: [
          {
            task_id: "T1",
            title: "Fix the thing",
            description: "Fix the thing that broke",
            files: ["src/thing.ts"],
            acceptance_criteria: ["The thing is fixed"],
            tests_to_write: ["Test the thing is fixed"],
            depends_on: [] as string[],
            risk_tier: "low",
            risk_rationale: "small fix",
          },
        ],
      }),
      "utf8",
    );

    const gateEnv = await debugSpecGate(d, started.run_id);
    expect(gateEnv.kind).toBe("review");

    await writeFile(
      join(buildDir, "verdict.json"),
      stringifyJson({
        decision: "PASS",
        score: 60,
        per_dimension: {
          granularity: 10,
          dependencies: 10,
          acceptance_criteria: 10,
          tests: 10,
          vertical_slices: 10,
          alignment: 10,
        },
        blockers: [] as string[],
        concerns: [] as string[],
      }),
      "utf8",
    );

    const storeEnv = await debugSpecStore(d, started.run_id);
    expect(storeEnv.kind).toBe("stored");
    if (storeEnv.kind !== "stored") throw new Error("unreachable");

    // The session now carries the stored spec id — debugSeed can find it.
    const session = JSON.parse(
      await readFile(join(dataDir, "debug", started.run_id, "session.json"), "utf8"),
    ) as { specId?: string };
    expect(session.specId).toBe(storeEnv.pointer.spec_id);
  });
});

describe("debugSeed", () => {
  it("throws LOUD when no spec has been stored for the pass yet", async () => {
    const d = deps();
    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");
    await expect(debugSeed(d, started.run_id)).rejects.toThrow(/no stored spec/);
  });

  it("pass 1: creates the debug RunState (debug:true) from the stored spec and advances the session to pass 2", async () => {
    const d = deps();
    const store = new SpecStore({ dataDir });
    const manifest = buildManifest(REPO, 2_000_000_001, {
      specMd: "# Fix\n\nFix the thing.",
      slug: "fix-thing",
      tasks: [
        {
          task_id: "T1",
          title: "Fix the thing",
          description: "Fix the thing that broke",
          files: ["src/thing.ts"],
          acceptance_criteria: ["The thing is fixed"],
          tests_to_write: ["Test the thing is fixed"],
          depends_on: [] as string[],
          risk_tier: "low" as const,
          risk_rationale: "small fix",
        },
      ],
    });
    await store.write(manifest, "# Fix");

    const started = await debugStart(d, {});
    if (started.kind !== "review") throw new Error("unreachable");
    // Manually seed the session's specId (skip the review→spec dance for this test).
    const sessionPath = join(dataDir, "debug", started.run_id, "session.json");
    const raw = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
    const { writeFile } = await import("node:fs/promises");
    const { stringifyJson } = await import("../../shared/json.js");
    await writeFile(
      sessionPath,
      stringifyJson({ ...raw, confirmedBlockers: [], specId: manifest.spec_id }),
      "utf8",
    );

    const env = await debugSeed(d, started.run_id);
    expect(env).toEqual({ kind: "loop", run_id: started.run_id });

    const run = await d.state.read(started.run_id);
    expect(run.debug).toBe(true);
    expect(Object.keys(run.tasks)).toContain("T1");

    const session = JSON.parse(await readFile(sessionPath, "utf8")) as { pass: number };
    expect(session.pass).toBe(2);
  });
});

describe("debugFinalize", () => {
  it("delegates to finalizeRun and wraps its result under kind:finalized", async () => {
    const store = new SpecStore({ dataDir });
    const manifest = buildManifest(REPO, 2_000_000_001, {
      specMd: "# Fix",
      slug: "fix-thing",
      tasks: [
        {
          task_id: "T1",
          title: "Fix",
          description: "Fix",
          files: ["src/thing.ts"],
          acceptance_criteria: ["done"],
          tests_to_write: ["test"],
          depends_on: [] as string[],
          risk_tier: "low" as const,
          risk_rationale: "small",
        },
      ],
    });
    await store.write(manifest, "# Fix");
    const state = new StateManager({ dataDir });
    await createRun(state, store, {
      repo: REPO,
      specId: manifest.spec_id,
      runId: "run-debug-finalize",
      intent: "fresh",
      debug: true,
    });
    // Force the run terminal without merging (a failed task closes the run as
    // "failed" — never touches git/gh, so this stays a safe, network-free test).
    await state.update("run-debug-finalize", (s) => ({
      ...s,
      status: "failed",
      tasks: {
        T1: {
          ...s.tasks.T1!,
          status: "failed",
          failure_class: "capability-budget",
          failure_reason: "escalation ladder exhausted (test fixture)",
        },
      },
    }));

    const env = await debugFinalize({ dataDir }, "run-debug-finalize");
    expect(env.kind).toBe("finalized");
    if (env.kind !== "finalized") throw new Error("unreachable");
    expect(env.run.run_id).toBe("run-debug-finalize");
    expect(env.run.status).toBe("failed");
  });
});

describe("debugCommand (dispatch)", () => {
  it("prints help and returns OK for --help", async () => {
    expect(await debugCommand.run(["--help"])).toBe(EXIT.OK);
  });
  it("returns USAGE for an unknown action", async () => {
    expect(await debugCommand.run(["bogus"])).toBe(EXIT.USAGE);
  });
  it("returns USAGE when review is called with neither --emit nor --record", async () => {
    expect(await debugCommand.run(["review", "--run", "x"])).toBe(EXIT.USAGE);
  });
  it("returns USAGE when review is called with both --emit and --record", async () => {
    expect(await debugCommand.run(["review", "--emit", "--record", "--run", "x"])).toBe(EXIT.USAGE);
  });
  it("returns USAGE when --run is missing on seed", async () => {
    expect(await debugCommand.run(["seed"])).toBe(EXIT.USAGE);
  });
  it("returns USAGE for an unknown debug spec sub-action", async () => {
    expect(await debugCommand.run(["spec", "bogus", "--run", "x"])).toBe(EXIT.USAGE);
  });
  it("prints help for `spec --help`", async () => {
    expect(await debugCommand.run(["spec", "--help"])).toBe(EXIT.OK);
  });
});
