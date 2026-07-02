/**
 * `factory score` (WS12) — arg/usage edges plus the reporter happy paths through
 * {@link scoreCommand} against an isolated temp data dir ($CLAUDE_PLUGIN_DATA + a
 * real StateManager + SpecStore). Proves the `{kind:"score", summary}` envelope and
 * the default-to-current-run behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scoreCommand, runScore } from "./score.js";
import { EXIT } from "../../shared/exit-codes.js";
import { StateManager } from "../../core/state/index.js";
import { FakeGitClient } from "../../git/index.js";
import { SpecStore } from "../../spec/index.js";
import type { SpecManifest } from "../../spec/index.js";
import type { SpecPointer, TaskState } from "../../types/index.js";

const REPO = "acme/widgets";
const SPEC: SpecPointer = { repo: REPO, spec_id: "7-x", issue_number: 7 };

const MANIFEST: SpecManifest = {
  spec_id: "7-x",
  issue_number: 7,
  slug: "x",
  repo: REPO,
  generated_at: "2026-06-08T00:00:00.000Z",
  tasks: [
    {
      task_id: "a",
      title: "Task A",
      description: "do a",
      files: ["src/a.ts"],
      acceptance_criteria: ["a works"],
      tests_to_write: ["test a"],
      depends_on: [],
      risk_tier: "medium",
      risk_rationale: "moderate",
    },
    {
      task_id: "b",
      title: "Task B",
      description: "do b",
      files: ["src/b.ts"],
      acceptance_criteria: ["b works"],
      tests_to_write: ["test b"],
      depends_on: [],
      risk_tier: "low",
      risk_rationale: "trivial",
    },
  ],
};

describe("score arg/usage edges", () => {
  it("--help prints help and exits OK", async () => {
    expect(await scoreCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("score happy paths", () => {
  let dataDir: string;
  let prevEnv: string | undefined;
  let stdout: string[];

  function task(
    seed: Partial<TaskState> & { task_id: string; status: TaskState["status"] },
  ): TaskState {
    const base = {
      depends_on: [],
      risk_tier: "medium" as const,
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0,
      ...seed,
    };
    if (seed.status === "failed") {
      return { failure_class: "spec-defect" as const, failure_reason: "x", ...base };
    }
    return base;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-score-cli-"));
    prevEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      stdout.push(String(c));
      return true;
    });

    await new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") }).write(MANIFEST, "# spec");
    const state = new StateManager({ dataDir });
    await state.create({ run_id: "run-s", spec: SPEC });
    await state.update("run-s", (s) => ({
      ...s,
      status: "failed",
      ended_at: "2026-06-01T00:00:00.000Z",
      tasks: {
        a: task({ task_id: "a", status: "done", pr_number: 11, branch: "factory/run/a" }),
        b: task({ task_id: "b", status: "failed", failure_class: "spec-defect" }),
      },
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    await rm(dataDir, { recursive: true, force: true });
  });

  const out = () => JSON.parse(stdout.join("")) as Record<string, unknown>;

  it("emits a {kind:'score', summary} envelope", async () => {
    const code = await scoreCommand.run(["--run", "run-s"]);
    expect(code).toBe(EXIT.OK);
    const env = out();
    expect(env.kind).toBe("score");

    const summary = env.summary as Record<string, unknown>;
    expect(summary.run_id).toBe("run-s");
    expect(summary.run_status).toBe("failed");
    expect(summary.totals).toEqual({ total: 2, shipped: 1, failed: 1, incomplete: 0 });
    expect(summary.failures_by_class).toEqual({
      "capability-budget": 0,
      "spec-defect": 1,
      "blocked-environmental": 0,
    });
    expect(summary.shipped_prs).toEqual([{ task_id: "a", pr_number: 11, branch: "factory/run/a" }]);
  });

  it("defaults to the current run when --run is omitted (resolved per-repo from cwd)", async () => {
    const git = new FakeGitClient();
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const code = await runScore([], { gitClient: git, cwd: "/x" });
    expect(code).toBe(EXIT.OK);
    expect((out().summary as Record<string, unknown>).run_id).toBe("run-s");
  });
});
