import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../core/state/manager.js";
import { defaultConfig } from "../config/schema.js";
import type { Config } from "../config/schema.js";
import { FakeGitClient } from "../git/fakes.js";
import type { ProvisionWorktreeFn } from "../git/index.js";
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
  e2eRunWorktreePath,
  e2eThrowawayDir,
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
  readonly writes: Array<{ path: string; contents: string }> = [];
  async copySpec(from: string, to: string): Promise<void> {
    this.copies.push({ from, to });
  }
  async writeConfig(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
  }
}

/** A recording ProvisionWorktreeFn fake — never touches the fs, just logs calls. */
function recordingProvision(): {
  calls: Array<{ path: string; setupCommand?: string }>;
  fn: ProvisionWorktreeFn;
} {
  const calls: Array<{ path: string; setupCommand?: string }> = [];
  const fn: ProvisionWorktreeFn = async (args) => {
    calls.push({ path: args.path, setupCommand: args.setupCommand });
  };
  return { calls, fn };
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
  // Seed run.tasks 1:1 from SPEC (mirrors seedTasksFromSpec at run-creation time in
  // production) so the manifest task_id validation (runE2eRecord) has a real "task-a"
  // to check against by default. Tests needing a fuller/different task set (status,
  // branch, pr_number, an extra task-b, …) override this wholesale via state.update.
  await state.update(RUN_ID, (s) => ({
    ...s,
    tasks: { "task-a": taskRow({ task_id: "task-a", status: "pending" }) },
  }));
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
      git.calls.some((c) => c.startsWith("worktree add") && c.includes(`-B e2e-${RUN_ID} `)),
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

  it("provisions the author worktree right after creating it", async () => {
    const { calls, fn } = recordingProvision();
    const env = await runE2eEmit(deps({ provision: fn }), RUN_ID);
    expect(env.kind).toBe("spawn");
    if (env.kind !== "spawn") throw new Error("expected spawn");
    expect(calls).toEqual([{ path: env.worktree, setupCommand: undefined }]);
  });

  it("after a PRE-authoring failure is reopened via rescue apply --reset-e2e, the re-authoring gate actually re-fires (spawn, not a false-done)", async () => {
    // A pre-manifest author failure (crash/timeout/unparseable status) leaves
    // e2e_phase = {status:"failed", manifest:[], ...}. Before the apply.ts fix,
    // `reopenE2ePhase` preserved that empty manifest, so this second `runE2eEmit`
    // would hit the empty-manifest branch and silently `markDone` — never
    // re-spawning the author. Regression coverage for the rescue-side fix, from
    // the e2e coroutine's own perspective.
    await state.update(RUN_ID, (s) => ({
      ...s,
      // Terminal — mirrors what a real driver does once `finalize` runs (Decision
      // 39: an e2e-failed run's terminal status is "failed"). `applyRescue` only
      // reopens a TERMINAL run, so a non-terminal `status` here would make
      // `resetE2e` a silent no-op and defeat the point of this test.
      status: "failed",
      e2e_phase: {
        status: "failed",
        reason: "e2e-author: no parseable status",
        manifest: [],
        reopen_counts: {},
      },
    }));

    const { applyRescue } = await import("../rescue/apply.js");
    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);
    expect((await state.read(RUN_ID)).e2e_phase).toBeUndefined();

    const env = await runE2eEmit(deps(), RUN_ID);
    expect(env.kind).toBe("spawn");
  });
});

describe("e2e worktree creation is crash-safe (worktree add -B, not -b)", () => {
  it("prepareAuthorSpawn: a crash-left e2e-<runId> branch (path removed, branch survives) does not fatal the next spawn attempt", async () => {
    // Simulates a prior crash: the author worktree's PATH was cleaned up (e.g. a
    // rescue/resume re-entry) but its git BRANCH survived — a bare `worktree add
    // -b` would fatal here (real git refuses to recreate an existing branch).
    git.localBranches.set(`e2e-${RUN_ID}`, "stale-sha");
    await expect(runE2eEmit(deps(), RUN_ID)).resolves.toMatchObject({ kind: "spawn" });
  });

  it("proveCriticals: a crash-left e2e-base-proof-<runId> branch does not fatal the fail-first proof", async () => {
    git.localBranches.set(`e2e-base-proof-${RUN_ID}`, "stale-sha");
    await runE2eEmit(deps(), RUN_ID);
    const tool = new ScriptedPlaywrightTool((opts) => [
      {
        file: "e2e/checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: opts.testDir === "e2e/checkout.spec.ts" ? "passed" : "passed",
      },
      { file: "e2e/checkout.spec.ts", title: "user can check out", status: "failed" },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    await expect(
      runE2eRecord(deps({ playwright: tool }), RUN_ID, { status: "STATUS: DONE", manifest }),
    ).resolves.toMatchObject({ kind: "failed" }); // still red on staging in this script — irrelevant to the point, just must not throw
  });

  it("runSuiteAndDecide: a crash-left e2e-run-<runId> branch does not fatal the mechanical suite run", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    git.localBranches.set(`e2e-run-${RUN_ID}`, "stale-sha");
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    await expect(runE2eEmit(deps({ playwright: tool }), RUN_ID)).resolves.toMatchObject({
      kind: "done",
    });
  });
});

describe("e2e worktrees are provisioned (npm ci) before any Playwright invocation", () => {
  it("provisions the base-proof worktree before the fail-first proof runs against it", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const { calls, fn } = recordingProvision();
    const baseWt = e2eBaseProofWorktreePath(dataDir, RUN_ID);
    const tool = new ScriptedPlaywrightTool((opts) => [
      { file: "e2e/checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
      {
        file: "e2e/checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    await runE2eRecord(deps({ playwright: tool, provision: fn }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(calls.some((c) => c.path === baseWt)).toBe(true);
  });

  it("provisions the run worktree on first creation, before the mechanical suite runs", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const { calls, fn } = recordingProvision();
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    const worktree = e2eRunWorktreePath(dataDir, RUN_ID);
    await runE2eEmit(deps({ playwright: tool, provision: fn }), RUN_ID);
    expect(calls.some((c) => c.path === worktree)).toBe(true);
  });

  it("re-provisions the run worktree on resync — staging may have gained a dependency", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: { "task-a": taskRow({ task_id: "task-a", status: "done" }) },
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const { calls, fn } = recordingProvision();
    let attempt = 0;
    const tool = new ScriptedPlaywrightTool(() => {
      attempt++;
      return [
        {
          file: "checkout.spec.ts",
          title: "user can check out",
          status: attempt === 1 ? "failed" : "passed",
        },
      ];
    });
    const first = await runE2eEmit(deps({ playwright: tool, provision: fn }), RUN_ID);
    expect(first.kind).toBe("reopen");
    const provisionsAfterFirstPass = calls.length;
    const resetCallsAfterFirstPass = git.calls.filter((c) => c.startsWith("reset --hard")).length;
    const second = await runE2eEmit(deps({ playwright: tool, provision: fn }), RUN_ID);
    expect(second.kind).toBe("done");
    expect(calls.length).toBeGreaterThan(provisionsAfterFirstPass); // resync re-provisioned
    // The `else` branch (worktree already exists) resyncs via reset --hard + clean,
    // rather than re-adding the worktree — exercise it explicitly, not just its
    // re-provisioning side effect.
    expect(git.calls.filter((c) => c.startsWith("reset --hard")).length).toBeGreaterThan(
      resetCallsAfterFirstPass,
    );
  });

  it("passes FACTORY_E2E_* env (start command, ready timeout, base URL) into every invocation", async () => {
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
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(tool.calls.length).toBeGreaterThan(0);
    for (const call of tool.calls) {
      expect(call.env).toMatchObject({
        BASE_URL: "http://localhost:3000",
        FACTORY_E2E_START_COMMAND: "npm start",
        FACTORY_E2E_READY_TIMEOUT_MS: "30000",
        FACTORY_E2E: "1",
      });
    }
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

  it("DONE with an empty manifest AND an explicit no_ui_surface declaration is an immediate done", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const env = await runE2eRecord(deps(), RUN_ID, {
      status: "STATUS: DONE",
      manifest: [],
      no_ui_surface: true,
    });
    expect(env.kind).toBe("done");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.manifest).toEqual([]);
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("DONE with an empty manifest but NO explicit no_ui_surface declaration fails — ambiguous, not a silent pass", async () => {
    await runE2eEmit(deps(), RUN_ID);
    // Distinguishes "author judged nothing UI-facing" (explicit no-op signal) from a
    // silently/accidentally empty manifest (e.g. a malformed author response the
    // schema's `.default([])` would otherwise paper over as an unremarkable green).
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest: [] });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("no_ui_surface");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("failed");
  });

  it("rejects a manifest entry naming a task_id absent from run.tasks — never merges", async () => {
    await runE2eEmit(deps(), RUN_ID);
    // SPEC only defines "task-a" — "task-unknown" isn't a real task in this run.
    const manifest = [
      {
        task_ids: ["task-a", "task-unknown"],
        spec_path: "checkout.spec.ts",
        kind: "critical" as const,
      },
    ];
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("task-unknown");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("fail-first proof passes: merges the critical spec, then runs the full suite green", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const authorWt = e2eWorktreePath(dataDir, RUN_ID);
    const baseWt = e2eBaseProofWorktreePath(dataDir, RUN_ID);
    const files = new FakeE2eFileOps();
    const tool = new ScriptedPlaywrightTool((opts) => [
      {
        file: "e2e/checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: "passed",
      },
      {
        file: "e2e/checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool, files }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("done");
    expect(git.mergesInto[`staging-${RUN_ID}`]).toContain(`e2e-${RUN_ID}`);
    expect(git.calls.some((c) => c === `push origin staging-${RUN_ID}`)).toBe(true);
    expect(files.copies).toEqual([
      {
        from: join(authorWt, "e2e/checkout.spec.ts"),
        to: join(baseWt, "e2e/checkout.spec.ts"),
      },
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
      {
        file: "e2e/checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: "passed",
      },
      { file: "e2e/checkout.spec.ts", title: "user can check out", status: "passed" }, // green on base too
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
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
        file: "e2e/checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
      {
        file: "e2e/checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("unusable");
  });

  it("fail-first proof rejects a critical spec with NO control: assertion at all — can't verify the base app booted, not a vacuous pass", async () => {
    await runE2eEmit(deps(), RUN_ID);
    // No spec titled with CONTROL_TITLE_PREFIX at all — the old
    // `control.length === 0 || ...` check vacuously treated this as green.
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "e2e/checkout.spec.ts", title: "user can check out", status: "failed" },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain(CONTROL_TITLE_PREFIX);
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("an all-throwaway manifest (no critical entries) skips the diff-guard, fail-first proof, and merge entirely", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const authorWt = e2eWorktreePath(dataDir, RUN_ID);
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "task-a.spec.ts", title: "explores the flow", status: "passed" },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "task-a.spec.ts", kind: "throwaway" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    // No critical spec to prove fail-first, so no base-proof worktree/Playwright-against-base
    // activity, and nothing to merge — this proceeds straight to runSuiteAndDecide.
    expect(env.kind).toBe("done");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
    expect(await git.worktreeExists(authorWt)).toBe(false); // still torn down, just not merged
  });
});

describe("manifest spec_path is guarded against traversal before any join/copySpec use (W5 trust boundary)", () => {
  it("rejects a critical spec_path containing a '..' segment", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "../../etc/passwd", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("..");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("rejects an absolute critical spec_path", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "/etc/passwd", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("absolute");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });
});

describe("author branch merge is path-guarded against out-of-testDir changes (W5 trust boundary)", () => {
  it("rejects a critical spec_path that is NOT under testDir/, even though it is itself declared in the manifest", async () => {
    await runE2eEmit(deps(), RUN_ID);
    // A critical entry is trusted enough to be merged unreviewed — declaring it
    // OUTSIDE the committed testDir must never be sufficient to allowlist an
    // arbitrary repo-root file just by self-declaring it "critical".
    git.branchFiles.set(`e2e-${RUN_ID}`, ["checkout.spec.ts"]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("checkout.spec.ts");
    expect(env.reason).toContain("e2e/");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
  });

  it("rejects merging an author branch that touches a path outside testDir/", async () => {
    await runE2eEmit(deps(), RUN_ID);
    // The author is an autonomous LLM; nothing here is human-reviewed. A stray
    // changed file outside testDir/ must block the merge outright rather than
    // landing unreviewed in staging — even when the critical spec itself is
    // properly located.
    git.branchFiles.set(`e2e-${RUN_ID}`, ["e2e/checkout.spec.ts", "src/malicious-backdoor.ts"]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps(), RUN_ID, { status: "STATUS: DONE", manifest });
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("src/malicious-backdoor.ts");
    expect(Object.keys(git.mergesInto)).toHaveLength(0);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  it("allows a merge whose extra changed files are all under testDir/", async () => {
    await runE2eEmit(deps(), RUN_ID);
    const baseWt = e2eBaseProofWorktreePath(dataDir, RUN_ID);
    git.branchFiles.set(`e2e-${RUN_ID}`, ["e2e/checkout.spec.ts", "e2e/support/fixtures.ts"]);
    const files = new FakeE2eFileOps();
    const tool = new ScriptedPlaywrightTool((opts) => [
      {
        file: "e2e/checkout.spec.ts",
        title: `${CONTROL_TITLE_PREFIX} app boots`,
        status: "passed",
      },
      {
        file: "e2e/checkout.spec.ts",
        title: "user can check out",
        status: opts.cwd === baseWt ? "failed" : "passed",
      },
    ]);
    const manifest = [
      { task_ids: ["task-a"], spec_path: "e2e/checkout.spec.ts", kind: "critical" as const },
    ];
    const env = await runE2eRecord(deps({ playwright: tool, files }), RUN_ID, {
      status: "STATUS: DONE",
      manifest,
    });
    expect(env.kind).toBe("done");
    expect(git.mergesInto[`staging-${RUN_ID}`]).toContain(`e2e-${RUN_ID}`);
  });
});

describe("runSuiteAndDecide (via runE2eEmit re-entry)", () => {
  it("pass 1: green criticals with a MAPPABLE throwaway failure still reopens (Decision 8 cadence: pass 1 reopens for ANY mappable failure, not just critical)", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: { "task-a": taskRow({ task_id: "task-a", status: "done" }) },
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
          { task_ids: ["task-a"], spec_path: "task-a.spec.ts", kind: "throwaway" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool((opts) =>
      opts.config?.includes("throwaway")
        ? [{ file: "task-a.spec.ts", title: "explores the flow", status: "failed" }]
        : [{ file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" }],
    );
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("reopen");
    if (env.kind !== "reopen") throw new Error("expected reopen");
    expect(env.task_ids).toEqual(["task-a"]);
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.reopen_counts["task-a"]).toBe(1);
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

  it("a critical spec MISSING entirely from results (never collected) reopens its owning task, not a silent pass", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        "task-a": taskRow({ task_id: "task-a", status: "done" }),
        "task-b": taskRow({ task_id: "task-b", status: "done" }),
      },
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
          { task_ids: ["task-b"], spec_path: "cart.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    // cart.spec.ts never appears in the results at all — not failed, just absent
    // (e.g. Playwright matched zero files for it). The old code only looked at
    // `failed`, so this silently passed; it must reopen task-b instead.
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("reopen");
    if (env.kind !== "reopen") throw new Error("expected reopen");
    expect(env.task_ids).toEqual(["task-b"]);
    expect(env.reason).toContain("cart.spec.ts");
    const run = await state.read(RUN_ID);
    expect(run.tasks["task-a"]!.status).toBe("done"); // untouched — its spec is present and green
    expect(run.tasks["task-b"]!.status).toBe("pending");
  });

  it("a genuine tooling failure (nonzero exit, zero individually-failed specs) fails the run outright — not silently done", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    // Simulates a webServer boot crash: Playwright's reporter shows every collected
    // spec passing (retries exhausted before it fully died) but the process exits
    // nonzero and/or reports a top-level errors[] entry — a tooling failure no
    // individual spec's status explains, so it must not be attributed to a task.
    const crashingTool: PlaywrightTool = {
      async run() {
        return {
          code: 1,
          stdout: JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: `${CONTROL_TITLE_PREFIX} boots`,
                    file: "checkout.spec.ts",
                    tests: [{ status: "expected" }],
                  },
                ],
              },
            ],
            errors: [{ message: "webServer failed to start" }],
          }),
          stderr: "",
          truncated: false,
        };
      },
    };
    const env = await runE2eEmit(deps({ playwright: crashingTool }), RUN_ID);
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("tooling failure");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("failed");
    expect(run.e2e_phase?.reopen_counts).toEqual({}); // no task blamed
  });

  it("pass 1: a throwaway tooling failure (nonzero exit, zero individually-failed specs) fails the run outright — not silently done", async () => {
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
    // Critical suite is clean green; only the throwaway run's tooling crashes
    // (nonzero exit / reporter errors[], no individual spec marked failed) — this
    // must not be silently absorbed into an empty throwawayFailed → markDone.
    const crashingTool: PlaywrightTool = {
      async run(opts) {
        if (!opts.config) {
          return {
            code: 0,
            stdout: JSON.stringify({
              suites: [
                {
                  specs: [
                    {
                      title: `${CONTROL_TITLE_PREFIX} boots`,
                      file: "checkout.spec.ts",
                      tests: [{ status: "expected" }],
                    },
                  ],
                },
              ],
            }),
            stderr: "",
            truncated: false,
          };
        }
        return {
          code: 1,
          stdout: JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: "explores the flow",
                    file: "task-a.spec.ts",
                    tests: [{ status: "expected" }],
                  },
                ],
              },
            ],
            errors: [{ message: "webServer failed to start" }],
          }),
          stderr: "",
          truncated: false,
        };
      },
    };
    const env = await runE2eEmit(deps({ playwright: crashingTool }), RUN_ID);
    expect(env.kind).toBe("failed");
    if (env.kind !== "failed") throw new Error("expected failed");
    expect(env.reason).toContain("tooling failure");
    expect(env.reason).toContain("throwaway");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("failed");
    expect(run.e2e_phase?.reopen_counts).toEqual({}); // no task blamed
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
      opts.config?.includes("throwaway")
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

  it("runs the throwaway suite via a generated --config rooted at the run worktree, not testDir", async () => {
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
    const files = new FakeE2eFileOps();
    const worktree = e2eRunWorktreePath(dataDir, RUN_ID);
    const throwawayDir = e2eThrowawayDir(dataDir, RUN_ID);
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    await runE2eEmit(deps({ playwright: tool, files }), RUN_ID);

    const throwawayCall = tool.calls.find((c) => c.config !== undefined);
    expect(throwawayCall).toBeDefined();
    expect(throwawayCall!.cwd).toBe(worktree);
    expect(throwawayCall!.testDir).toBeUndefined();
    expect(throwawayCall!.config).toMatch(/^\/.*factory-e2e-throwaway.*\.cjs$/);

    const written = files.writes.find((w) => w.path === throwawayCall!.config);
    expect(written).toBeDefined();
    expect(written!.contents).toContain(throwawayDir);
  });

  it("joins a critical result to its manifest entry via endsWith when Playwright reports a directory-prefixed file (e.g. 'e2e/checkout.spec.ts' vs. manifest's bare 'checkout.spec.ts')", async () => {
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
      // Playwright reports its own testDir-relative path, not the manifest's bare name.
      { file: "e2e/checkout.spec.ts", title: `${CONTROL_TITLE_PREFIX} boots`, status: "passed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    // A naive exact-match join would treat this as an unmapped/missing critical spec
    // and reopen task-a; the endsWith fallback must recognize it as the same entry.
    expect(env.kind).toBe("done");
  });

  it("a flaky critical spec counts as proven (not a miss) — no reopen, no failure", async () => {
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
      { file: "checkout.spec.ts", title: "user can check out", status: "flaky" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("done");
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.reopen_counts).toEqual({}); // never reopened
  });

  it("two mappable failures naming the SAME task_id reopen it exactly once (dedup), not twice", async () => {
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        manifest: [
          { task_ids: ["task-a"], spec_path: "checkout.spec.ts", kind: "critical" as const },
          { task_ids: ["task-a"], spec_path: "cart.spec.ts", kind: "critical" as const },
        ],
        reopen_counts: {},
      },
    }));
    const tool = new ScriptedPlaywrightTool(() => [
      { file: "checkout.spec.ts", title: "user can check out", status: "failed" },
      { file: "cart.spec.ts", title: "user can add to cart", status: "failed" },
    ]);
    const env = await runE2eEmit(deps({ playwright: tool }), RUN_ID);
    expect(env.kind).toBe("reopen");
    if (env.kind !== "reopen") throw new Error("expected reopen");
    expect(env.task_ids).toEqual(["task-a"]); // deduped, not ["task-a", "task-a"]
    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.reopen_counts["task-a"]).toBe(1); // incremented once, not twice
  });
});
