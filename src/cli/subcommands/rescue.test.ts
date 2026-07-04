/**
 * `factory rescue <scan|apply>` (WS12). Arg/usage/help edges plus the
 * reporter+writer happy paths through {@link rescueCommand} against an isolated
 * temp data dir (via $CLAUDE_PLUGIN_DATA + a real StateManager) — proving the
 * `--task` repeat, the `--include-dead-ends` boolean, and the emitted envelopes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rescueCommand, runScan } from "./rescue.js";
import { EXIT } from "../../shared/exit-codes.js";
import { StateManager } from "../../core/state/index.js";
import { FakeGitClient } from "../../git/index.js";
import type { SpecPointer, TaskState } from "../../types/index.js";

const SPEC: SpecPointer = { repo: "acme/widgets", spec_id: "7-x", issue_number: 7 };

describe("rescue arg/usage edges", () => {
  it("no action prints help and exits OK", async () => {
    expect(await rescueCommand.run([])).toBe(EXIT.OK);
  });
  it("--help prints help and exits OK", async () => {
    expect(await rescueCommand.run(["--help"])).toBe(EXIT.OK);
  });
  it("scan --help prints help and exits OK", async () => {
    expect(await rescueCommand.run(["scan", "--help"])).toBe(EXIT.OK);
  });
  it("apply --help prints help and exits OK", async () => {
    expect(await rescueCommand.run(["apply", "--help"])).toBe(EXIT.OK);
  });
  it("an unknown action is a usage error", async () => {
    expect(await rescueCommand.run(["frobnicate"])).toBe(EXIT.USAGE);
  });
});

describe("rescue scan/apply happy paths", () => {
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
      return { failure_class: "capability-budget" as const, failure_reason: "x", ...base };
    }
    return base;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-rescue-cli-"));
    prevEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      stdout.push(String(c));
      return true;
    });
    const state = new StateManager({ dataDir });
    await state.create({ run_id: "run-c", spec: SPEC });
    await state.update("run-c", (s) => ({
      ...s,
      tasks: {
        a: task({ task_id: "a", status: "executing" }),
        b: task({ task_id: "b", status: "failed", failure_class: "blocked-environmental" }),
        c: task({ task_id: "c", status: "failed", failure_class: "spec-defect" }),
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

  it("scan emits the RescueScan and writes nothing", async () => {
    const code = await rescueCommand.run(["scan", "--run", "run-c"]);
    expect(code).toBe(EXIT.OK);
    const scan = out();
    expect(scan.run_id).toBe("run-c");
    expect(scan.resettable).toEqual(["a", "b"]);
    expect(scan.dead_ends).toEqual(["c"]);
    expect(scan.needs_rescue).toBe(true);
    // S10 alias: scan delegates to `recover --dry-run`, which adds the route.
    expect(scan.route).toBe("rescue");
    // read-only: state unchanged.
    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.tasks.a!.status).toBe("executing");
  });

  it("scan appends an additive recoverable-work survey from git (work field)", async () => {
    // Give the stuck task a branch carrying committed work above the run's staging base.
    await new StateManager({ dataDir }).update("run-c", (s) => ({
      ...s,
      tasks: { ...s.tasks, a: { ...s.tasks.a!, branch: "factory/run-c/a" } },
    }));
    const git = new FakeGitClient({
      remoteHeads: { "staging-run-c": "sha-base" },
      localBranches: { "factory/run-c/a": { sha: "sha-a" } },
    });
    git.setCommitsAhead("factory/run-c/a", 4);

    const code = await runScan(["--run", "run-c"], { gitClient: git });
    expect(code).toBe(EXIT.OK);
    const scan = out();
    // The base scan shape is unchanged (work is purely additive).
    expect(scan.run_id).toBe("run-c");
    expect(scan.resettable).toEqual(["a", "b"]);
    const work = scan.work as { base_ref: string; base_resolved: boolean; tasks: unknown[] };
    expect(work.base_ref).toBe("origin/staging-run-c");
    expect(work.base_resolved).toBe(true);
    expect(work.tasks).toEqual([
      { task_id: "a", branch: "factory/run-c/a", branch_exists: true, commits_ahead: 4 },
    ]);
  });

  it("apply (default) resets stuck+recoverable, leaving the dead-end", async () => {
    const code = await rescueCommand.run(["apply", "--run", "run-c"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reset).toEqual(["a", "b"]);

    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.tasks.a!.status).toBe("pending");
    expect(run.tasks.b!.status).toBe("pending");
    expect(run.tasks.c!.status).toBe("failed"); // dead-end left alone
  });

  it("apply --include-dead-ends also resets the dead-end", async () => {
    const code = await rescueCommand.run(["apply", "--run", "run-c", "--include-dead-ends"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reset).toEqual(["a", "b", "c"]);
    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.tasks.c!.status).toBe("pending");
  });

  it("apply --reset-e2e clears a failed e2e_phase verdict and reopens the run", async () => {
    await new StateManager({ dataDir }).update("run-c", (s) => ({
      ...s,
      status: "failed",
      ended_at: "2026-06-01T00:00:00.000Z",
      tasks: {
        a: task({ task_id: "a", status: "done" }),
        b: task({ task_id: "b", status: "done" }),
        c: task({ task_id: "c", status: "done" }),
      },
      e2e_phase: {
        status: "failed",
        reason: "fail-first proof: 'checkout.spec.ts' is still red against staging",
        manifest: [],
        reopen_counts: {},
      },
    }));
    const code = await rescueCommand.run(["apply", "--run", "run-c", "--reset-e2e"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reopened).toBe(true);
    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.status).toBe("running");
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.reason).toBeUndefined();
  });

  it("apply --recheck-rollup reopens a completed run whose rollup armed but never landed", async () => {
    await new StateManager({ dataDir }).update("run-c", (s) => ({
      ...s,
      status: "completed",
      ended_at: "2026-06-01T00:00:00.000Z",
      tasks: {
        a: task({ task_id: "a", status: "done" }),
        b: task({ task_id: "b", status: "done" }),
        c: task({ task_id: "c", status: "done" }),
      },
      rollup: { number: 42, merged: false, reason: "branch policy: merge queued (--auto)" },
    }));
    const code = await rescueCommand.run(["apply", "--run", "run-c", "--recheck-rollup"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reopened).toBe(true);
    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.status).toBe("running");
    // Purely a reopen — finalize re-derives/clears rollup itself; no task touched.
    expect(run.rollup).toEqual({
      number: 42,
      merged: false,
      reason: "branch policy: merge queued (--auto)",
    });
    expect(run.tasks.a!.status).toBe("done");
  });

  it("apply --reset-e2e on a NON-terminal run (crash before finalize) still clears the failed e2e_phase", async () => {
    // The run crashed between e2e's markFailed and finalize: status is still
    // "running", so there is nothing to reopen — but the asserted repair must
    // still clear the verdict instead of silently no-oping.
    await new StateManager({ dataDir }).update("run-c", (s) => ({
      ...s,
      tasks: {
        a: task({ task_id: "a", status: "done" }),
        b: task({ task_id: "b", status: "done" }),
        c: task({ task_id: "c", status: "done" }),
      },
      e2e_phase: {
        status: "failed",
        reason: "fail-first proof: 'checkout.spec.ts' is still red against staging",
        manifest: [
          { task_ids: ["a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const code = await rescueCommand.run(["apply", "--run", "run-c", "--reset-e2e"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reopened).toBe(false); // nothing terminal to reopen — but the phase clears
    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.status).toBe("running");
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.manifest).toHaveLength(1); // authored manifest preserved
  });

  it("apply --task selects exactly the named tasks (repeatable)", async () => {
    const code = await rescueCommand.run(["apply", "--run", "run-c", "--task", "a", "--task", "c"]);
    expect(code).toBe(EXIT.OK);
    expect(out().reset).toEqual(["a", "c"]); // explicit dead-end included

    const run = await new StateManager({ dataDir }).read("run-c");
    expect(run.tasks.a!.status).toBe("pending");
    expect(run.tasks.b!.status).toBe("failed"); // not named → untouched
    expect(run.tasks.c!.status).toBe("pending");
  });

  it("scan defaults to the current run when --run is omitted (resolved per-repo from cwd)", async () => {
    const git = new FakeGitClient();
    git.setRemoteUrl("origin", "git@github.com:acme/widgets.git");
    const code = await runScan([], { gitClient: git, cwd: "/x" });
    expect(code).toBe(EXIT.OK);
    expect(out().run_id).toBe("run-c");
  });
});
