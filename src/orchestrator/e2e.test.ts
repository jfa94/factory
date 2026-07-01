import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../core/state/manager.js";
import { defaultConfig } from "../config/schema.js";
import type { Config } from "../config/schema.js";
import { FakeGitClient } from "../git/fakes.js";
import { parseSpecManifest, type SpecManifest } from "../spec/index.js";
import type { TaskState } from "../types/index.js";
import type {
  PlaywrightTool,
  E2eProcResult,
  E2eRunOpts,
  E2eSpecStatus,
} from "../verifier/e2e/index.js";
import {
  runE2eEmit,
  runE2eRecord,
  CONTROL_TITLE_PREFIX,
  e2eWorktreePath,
  e2eBaseProofWorktreePath,
  type E2eRunDeps,
  type E2eFileOps,
} from "./e2e.js";

const RUN_ID = "run-1";
const REPO = "acme/widgets";

let dataDir: string;
let state: StateManager;
let git: FakeGitClient;

const SPEC: SpecManifest = parseSpecManifest({
  spec_id: "42-checkout",
  issue_number: 42,
  slug: "checkout",
  repo: REPO,
  generated_at: "2026-06-01T00:00:00.000Z",
  tasks: [
    {
      task_id: "task-a",
      title: "Checkout button",
      description: "adds a checkout flow",
      files: ["src/checkout.ts"],
      acceptance_criteria: ["a user can complete checkout"],
      tests_to_write: ["covers checkout"],
      depends_on: [],
      risk_tier: "medium",
      risk_rationale: "money path",
    },
  ],
});

/** e2e.startCommand/baseURL configured — the readiness gate `runE2eEmit` checks. */
function e2eConfig(): Config {
  const base = defaultConfig();
  return {
    ...base,
    e2e: { ...base.e2e, startCommand: "npm start", baseURL: "http://localhost:3000" },
  };
}

function taskRow(t: {
  task_id: string;
  status: TaskState["status"];
  branch?: string;
  pr_number?: number;
}): TaskState {
  return {
    task_id: t.task_id,
    status: t.status,
    depends_on: [],
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
    ...(t.branch !== undefined ? { branch: t.branch } : {}),
    ...(t.pr_number !== undefined ? { pr_number: t.pr_number } : {}),
  };
}

function pwStatus(s: E2eSpecStatus): "skipped" | "expected" | "unexpected" | "flaky" {
  if (s === "passed") return "expected";
  if (s === "failed") return "unexpected";
  return s;
}

interface ScriptedSpec {
  file: string;
  title: string;
  status: E2eSpecStatus;
}

/** A PlaywrightTool fake that answers via a caller-supplied plan, keyed off the run's `opts`. */
class ScriptedPlaywrightTool implements PlaywrightTool {
  readonly calls: E2eRunOpts[] = [];
  constructor(private readonly plan: (opts: E2eRunOpts) => readonly ScriptedSpec[]) {}
  async run(opts: E2eRunOpts): Promise<E2eProcResult> {
    this.calls.push(opts);
    const specs = this.plan(opts);
    const report = {
      suites: [
        {
          specs: specs.map((s) => ({
            title: s.title,
            file: s.file,
            tests: [{ status: pwStatus(s.status) }],
          })),
        },
      ],
    };
    return {
      code: specs.some((s) => s.status === "failed") ? 1 : 0,
      stdout: JSON.stringify(report),
      stderr: "",
      truncated: false,
    };
  }
}

class FakeE2eFileOps implements E2eFileOps {
  readonly copies: Array<{ from: string; to: string }> = [];
  async copySpec(from: string, to: string): Promise<void> {
    this.copies.push({ from, to });
  }
}

function deps(overrides: Partial<E2eRunDeps> = {}): E2eRunDeps {
  return {
    state,
    git,
    config: e2eConfig(),
    dataDir,
    spec: SPEC,
    files: new FakeE2eFileOps(),
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "e2e-coroutine-"));
  state = new StateManager({ dataDir });
  git = new FakeGitClient({
    remoteHeads: { [`staging-${RUN_ID}`]: "sha-staging", develop: "sha-develop" },
  });
  await state.create({
    run_id: RUN_ID,
    spec: { repo: REPO, spec_id: SPEC.spec_id, issue_number: SPEC.issue_number },
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("runE2eEmit", () => {
  it("suspends the run when e2e.startCommand/baseURL are not configured", async () => {
    const env = await runE2eEmit(deps({ config: defaultConfig() }), RUN_ID);
    expect(env.kind).toBe("suspend");
    if (env.kind !== "suspend") throw new Error("expected suspend");
    expect(env.reason).toContain("e2e.startCommand");
    expect((await state.read(RUN_ID)).status).toBe("suspended");
  });

  it("first entry spawns the e2e-author off the staging tip", async () => {
    const env = await runE2eEmit(deps(), RUN_ID);
    expect(env.kind).toBe("spawn");
    if (env.kind !== "spawn") throw new Error("expected spawn");
    expect(env.staging_branch).toBe(`staging-${RUN_ID}`);
    expect(env.e2e_branch).toBe(`e2e-${RUN_ID}`);
    expect(env.base_ref).toBe("origin/develop");
    expect(env.worktree).toContain(RUN_ID);
    expect(env.throwaway_dir).toContain(RUN_ID);
    expect(env.model).toBe("sonnet");
    expect(
      git.calls.some((c) => c.startsWith("worktree add") && c.includes(`-b e2e-${RUN_ID} `)),
    ).toBe(true);
    expect(env.prompt).toContain("task-a");
    expect(env.prompt).toContain(CONTROL_TITLE_PREFIX);
    expect(env.prompt).toContain(env.throwaway_dir);
  });

  it("is idempotent on resume: no second worktree add", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const callsAfterFirst = git.calls.length;
    const second = await runE2eEmit(deps(), RUN_ID);
    expect(second.kind).toBe("spawn");
    expect(
      git.calls.slice(callsAfterFirst).filter((c) => c.startsWith("worktree add")),
    ).toHaveLength(0);
  });

  it("re-entry with an existing manifest runs the suite directly (no author spawn)", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} loads`, status: "passed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("done");
  });
});

describe("runE2eRecord", () => {
  it("author non-DONE status fails the phase, never merges or pushes", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const env = await runE2eRecord(deps(), RUN_ID, {
      status: "STATUS: BLOCKED — ESCALATE missing context",
      manifest: [],
    });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("BLOCKED");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("failed");
    expect(run.e2e_phase?.reason).toContain("BLOCKED");
    expect(run.e2e_phase?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("DONE with an empty manifest is an immediate done — nothing UI-facing to gate on", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest: [] });
    expect(env.kind).toBe("done");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.manifest).toEqual([]);
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("fail-first proof passes: merges the critical spec, then runs the full suite green", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const authorWt = e2eWorktreePath(dataDir, RUN_ID);
    const baseWt = e2eBaseProofWorktreePath(dataDir, RUN_ID);
    const files = new FakeE2eFileOps();
    const tool = new ScriptedPlaywrightTool((opts) => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} app boots`, status: "passed" },
      {
        file: "checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool, files }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("done");
    expect(git.mergesInto[`staging-${RUN_ID}`]).toContain(`e2e-${RUN_ID}`);
    expect(git.calls.some((c) => c === `push origin staging-${RUN_ID}`)).toBe(true);
    expect(files.copies).toEqual([
      { from: join(authorWt, "checkout.spec.ts"), to: join(baseWt, "checkout.spec.ts") },
    ]);
    expect(await git.worktreeExists(baseWt)).toBe(false); // scratch proof worktree torn down
    expect(await git.worktreeExists(authorWt)).toBe(false); // merged, then torn down
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.manifest).toEqual(manifest);
  });

  it("fail-first proof rejects a vacuous-pass spec (green even on the base app) — never merged", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const authorWt = e2eWorktreePath(dataDir, RUN_ID);
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} app boots`, status: "passed" },
      { file: "checkout.spec.ts", title: "user can check out", status: "passed" }, // green on base too
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("vacuous-pass");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
    expect(await git.worktreeExists(authorWt)).toBe(false); // discarded, not landed
  });

  it("fail-first proof rejects when the base app itself doesn't boot (control assertion fails)", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const baseWt = e2eBaseProofWorktreePath(dataDir, RUN_ID);
    const tool = new ScriptedPlaywrightTool((opts) => [
      {
        file: "checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
      {
        file: "checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("unusable");
  });
});

describe("runSuiteAndDecide (via runE2eEmit re-entry)", () => {
  it("green criticals with residual throwaway red -> done with a non-gating advisory", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
          { task_ids: ["task-a"], spec_path: "task-a.spec.ts", kind: "throwaway" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool((opts) =>
      opts.testDir?.includes("e2e-throwaway")
        ? [{ file: "task-a.spec.ts", title: "explores the flow", status: "failed" }]
        : [{ file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" }],
    );
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("done");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.advisory).toContain("throwaway");
  });

  it("pass 1: a mappable critical failure reopens its task with e2e_feedback, preserving branch/PR", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        "task-a": taskRow({
          task_id: "task-a",
          status: "done",
          branch: "factory/run-1/task-a",
          pr_number: 5,
        }),
      },
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: "user can check out", status: "failed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("reopen");
    if (env.kind !== "reopen") throw new Error("expected reopen");
    expect(env.task_ids).toEqual(["task-a"]);
    expect(env.reason).toContain("checkout.spec.ts");
    const run = await state.read(RUN_ID);
    const task = run.tasks["task-a"]!;
    expect(task.status).toBe("pending");
    expect(task.e2e_feedback).toContain("checkout.spec.ts");
    expect(task.branch).toBe("factory/run-1/task-a");
    expect(task.pr_number).toBe(5);
    expect(run.e2e_phase?.status).toBeUndefined(); // cleared so the phase re-fires post-reopen
    expect(run.e2e_phase?.reopen_counts["task-a"]).toBe(1);
    expect(run.e2e_phase?.attempts).toBe(1);
    expect(run.e2e_phase?.manifest).toHaveLength(1); // manifest persists across the reopen
  });

  it("an unmappable critical failure (no manifest entry names it) fails the run", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "unknown.spec.ts", title: "some other journey", status: "failed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("unmappable");
    expect((await state.read(RUN_ID)).e2e_phase?.status).toBe("failed");
  });

  it("a task already at the reopen cap fails the run instead of looping forever", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: { "task-a": taskRow({ task_id: "task-a", status: "done" }) },
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: { "task-a": 2 }, // == the default reopenCap
        attempts: 2,
      },
    }));
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: "user can check out", status: "failed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("cap");
    // the cap check runs before any reset — the task is left exactly as it was.
    expect((await state.read(RUN_ID)).tasks["task-a"]!.status).toBe("done");
  });

  it("pass 2+: a throwaway-only failure does not reopen (cadence) — completes with advisory", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
          { task_ids: ["task-a"], spec_path: "task-a.spec.ts", kind: "throwaway" as const },
        ],
        reopen_counts: { "task-a": 1 },
        attempts: 1, // this call becomes pass 2 — cadence stops reopening on throwaway-only red
      },
    }));
    const tool = new ScriptedPlaywrightTool((opts) =>
      opts.testDir?.includes("e2e-throwaway")
        ? [{ file: "task-a.spec.ts", title: "explores the flow", status: "failed" }]
        : [{ file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" }],
    );
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("done");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.advisory).toContain("throwaway");
    expect(run.e2e_phase?.reopen_counts["task-a"]).toBe(1); // unchanged — no reopen fired
  });
});
