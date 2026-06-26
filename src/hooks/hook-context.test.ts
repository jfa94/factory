/**
 * WS9 — active-run resolution tests. The three runs/current cases the bash hooks
 * got right are preserved: NO symlink → null (pass through), DANGLING symlink →
 * BrokenRunStateError (fail closed), VALID symlink → parsed run. Plus the pure
 * task/phase resolution (persisted phase cursor preferred; status derivation is
 * the legacy fallback). Uses a real on-disk run store so the symlink walk is
 * genuinely exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../core/state/index.js";
import { currentLinkPath } from "../core/state/index.js";
import {
  loadActiveRun,
  loadOwnerScopedRun,
  resolveActiveTask,
  isTestWriterPhase,
  runTaskForPath,
  BrokenRunStateError,
} from "./hook-context.js";
import { worktreesRoot } from "../core/state/index.js";
import type { RunState, TaskState } from "../types/index.js";

const SPEC = { repo: "o/n", spec_id: "1-x", issue_number: 1 } as const;

describe("loadActiveRun — runs/current resolution", () => {
  let dataDir: string;
  const origTaskId = process.env.FACTORY_TASK_ID;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "hc-"));
    delete process.env.FACTORY_TASK_ID;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
    else process.env.FACTORY_TASK_ID = origTaskId;
  });

  it("NO symlink → null (no active run; guards pass through)", async () => {
    const active = await loadActiveRun({ dataDir });
    expect(active).toBeNull();
  });

  it("VALID symlink → parsed ActiveRun", async () => {
    const mgr = new StateManager({ dataDir });
    await mgr.create({ run_id: "run-20260101-000000", spec: SPEC });
    const active = await loadActiveRun({ dataDir });
    expect(active).not.toBeNull();
    expect(active!.dataDir).toBe(dataDir);
    expect(active!.run.run_id).toBe("run-20260101-000000");
  });

  it("DANGLING symlink → BrokenRunStateError (fail closed)", async () => {
    // Point runs/current at a run dir that does not exist.
    mkdirSync(join(dataDir, "runs"), { recursive: true });
    symlinkSync(join(dataDir, "runs", "ghost"), currentLinkPath(dataDir));
    await expect(loadActiveRun({ dataDir })).rejects.toBeInstanceOf(BrokenRunStateError);
  });

  it("unresolvable data dir → null (bare dev shell, no active run)", async () => {
    // resolveDataDir throws when nothing identifies a data dir; loadActiveRun
    // swallows THAT (path resolution) into null — distinct from a dangling link.
    // HERMETIC: pass `env: {}` so resolution does NOT read the ambient
    // CLAUDE_PLUGIN_DATA. Without this, a foreign CLAUDE_PLUGIN_DATA in the dev
    // shell is canonicalized to the real factory data dir, and if THAT has an
    // active `runs/current` (e.g. a live run on this machine) the call resolves
    // to it instead of throwing — the test would then read shared external state.
    const active = await loadActiveRun({ dataDir: "", env: {} });
    expect(active).toBeNull();
  });
});

describe("loadOwnerScopedRun — session-scoped active run (run-isolation L1.3)", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "hc-owner-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("with CLAUDE_CODE_SESSION_ID set → resolves the run THAT session owns", async () => {
    const mgr = new StateManager({ dataDir });
    await mgr.create({ run_id: "run-1", spec: SPEC, owner_session: "sess-A" });
    const active = await loadOwnerScopedRun({ dataDir, env: { CLAUDE_CODE_SESSION_ID: "sess-A" } });
    expect(active?.run.run_id).toBe("run-1");
    expect(active?.dataDir).toBe(dataDir);
  });

  it("with a session id that owns NO run → null, even though runs/current points elsewhere", async () => {
    // A concurrent run owned by another session is the `current` target; an
    // unrelated session must NOT inherit it (the cross-session leak this fixes).
    const mgr = new StateManager({ dataDir });
    await mgr.create({ run_id: "run-1", spec: SPEC, owner_session: "sess-B" });
    const active = await loadOwnerScopedRun({ dataDir, env: { CLAUDE_CODE_SESSION_ID: "sess-A" } });
    expect(active).toBeNull();
  });

  it("with NO session id in env → falls back to today's global runs/current behavior", async () => {
    const mgr = new StateManager({ dataDir });
    await mgr.create({ run_id: "run-1", spec: SPEC, owner_session: "sess-B" });
    // env carries no CLAUDE_CODE_SESSION_ID → fail-safe to the global pointer.
    const active = await loadOwnerScopedRun({ dataDir, env: {} });
    expect(active?.run.run_id).toBe("run-1");
  });
});

// --- pure derivation -------------------------------------------------------

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    task_id: "t1",
    status: "pending",
    depends_on: [],
    risk_tier: "low",
    escalation_rung: 0,
    reviewers: [],
    ...over,
  } as TaskState;
}

function run(tasks: Record<string, TaskState>): RunState {
  return {
    schema_version: 1,
    run_id: "run-x",
    status: "running",
    execution_mode: "balanced",
    spec: SPEC,
    tasks,
    started_at: "t",
    updated_at: "t",
    ended_at: null,
  } as RunState;
}

describe("resolveActiveTask — status-derived phase (legacy fallback, no cursor persisted)", () => {
  const origTaskId = process.env.FACTORY_TASK_ID;
  afterEach(() => {
    if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
    else process.env.FACTORY_TASK_ID = origTaskId;
  });

  it("single executing task → phase tests", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "executing" }) }));
    expect(active?.phase).toBe("tests");
  });

  it("single reviewing task → phase verify", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "reviewing" }) }));
    expect(active?.phase).toBe("verify");
  });

  it("single shipping task → phase ship", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "shipping" }) }));
    expect(active?.phase).toBe("ship");
  });

  it("ambiguous (two in-flight, no explicit id) → null", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(
      run({
        t1: task({ task_id: "t1", status: "executing" }),
        t2: task({ task_id: "t2", status: "reviewing" }),
      }),
    );
    expect(active).toBeNull();
  });

  it("explicit task id selects even amid ambiguity", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(
      run({
        t1: task({ task_id: "t1", status: "executing" }),
        t2: task({ task_id: "t2", status: "reviewing" }),
      }),
      "t2",
    );
    expect(active?.task.task_id).toBe("t2");
    expect(active?.phase).toBe("verify");
  });

  it("explicit id absent from run → null (no fabrication)", () => {
    delete process.env.FACTORY_TASK_ID;
    expect(resolveActiveTask(run({ t1: task() }), "nope")).toBeNull();
  });

  it("no in-flight task → null", () => {
    delete process.env.FACTORY_TASK_ID;
    expect(resolveActiveTask(run({ t1: task({ status: "done" }) }))).toBeNull();
  });
});

describe("resolveActiveTask phase source", () => {
  const origTaskId = process.env.FACTORY_TASK_ID;
  afterEach(() => {
    if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
    else process.env.FACTORY_TASK_ID = origTaskId;
  });

  it("prefers the persisted phase cursor over status derivation (exec window)", () => {
    // status "executing" derives `tests`, but the cursor says `exec` —
    // the cursor wins, so the test-writer guard must NOT fire.
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", phase: "exec", producer_role: "test-writer" }) }),
      "t1",
    );
    expect(active?.phase).toBe("exec");
    expect(isTestWriterPhase(active)).toBe(false);
  });

  it("falls back to status derivation when no cursor is persisted (legacy state)", () => {
    const active = resolveActiveTask(run({ t1: task({ status: "executing" }) }), "t1");
    expect(active?.phase).toBe("tests");
  });

  it("terminal/pending stays null even with a stale cursor on the row", () => {
    // terminal rows keep the LAST in-flight phase as history — never an active phase.
    delete process.env.FACTORY_TASK_ID;
    expect(resolveActiveTask(run({ t1: task({ status: "done", phase: "ship" }) }))).toBeNull();
  });

  it("explicit id on a terminal row → phase null despite the stale cursor", () => {
    const active = resolveActiveTask(run({ t1: task({ status: "done", phase: "ship" }) }), "t1");
    expect(active).not.toBeNull();
    expect(active?.phase).toBeNull();
  });

  it("tests-phase cursor keeps the test-writer guard active", () => {
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", phase: "tests", producer_role: "test-writer" }) }),
      "t1",
    );
    expect(isTestWriterPhase(active)).toBe(true);
  });

  it("pending row with a preflight cursor resolves null (the coroutine writes pending+preflight at entry)", () => {
    delete process.env.FACTORY_TASK_ID;
    const r = run({ t1: task({ status: "pending", phase: "preflight" }) });
    expect(resolveActiveTask(r)).toBeNull();
  });
});

describe("isTestWriterPhase", () => {
  it("executing + test-writer role → true", () => {
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", producer_role: "test-writer" }) }),
      "t1",
    );
    expect(isTestWriterPhase(active)).toBe(true);
  });

  it("executing + implementer role → false (GREEN phase, not test-writer)", () => {
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", producer_role: "implementer" }) }),
      "t1",
    );
    expect(isTestWriterPhase(active)).toBe(false);
  });

  it("reviewing → false", () => {
    const active = resolveActiveTask(run({ t1: task({ status: "reviewing" }) }), "t1");
    expect(isTestWriterPhase(active)).toBe(false);
  });

  it("null active → false", () => {
    expect(isTestWriterPhase(null)).toBe(false);
  });
});

// --- worktree path → run+task ownership (run-isolation L1.1) -----------------

describe("runTaskForPath — derive owning run+task from a producer write path", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rtfp-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a file under worktrees/<run>/<task>/… resolves both ids", () => {
    const p = join(worktreesRoot(dataDir), "run-20260101-000000", "t1", "src", "a.ts");
    expect(runTaskForPath(dataDir, p)).toEqual({
      run_id: "run-20260101-000000",
      task_id: "t1",
    });
  });

  it("the task dir itself (no file tail) still resolves both ids", () => {
    const p = join(worktreesRoot(dataDir), "run-x", "t2");
    expect(runTaskForPath(dataDir, p)).toEqual({ run_id: "run-x", task_id: "t2" });
  });

  it("a path under worktrees/<run> with no task segment → null", () => {
    const p = join(worktreesRoot(dataDir), "run-x");
    expect(runTaskForPath(dataDir, p)).toBeNull();
  });

  it("a path in an unrelated repo checkout → null (the spurious-block fix)", () => {
    expect(runTaskForPath(dataDir, "/Users/dev/some-repo/src/index.ts")).toBeNull();
  });

  it("a path under runs/ (a sibling store, not a worktree) → null", () => {
    const p = join(dataDir, "runs", "run-x", "state.json");
    expect(runTaskForPath(dataDir, p)).toBeNull();
  });

  it("a traversal out of a worktree resolves away and does NOT match", () => {
    // worktrees/run-x/t1/../../../etc/passwd canonicalizes above the root → null.
    const p = join(worktreesRoot(dataDir), "run-x", "t1", "..", "..", "..", "etc", "passwd");
    expect(runTaskForPath(dataDir, p)).toBeNull();
  });

  it("canonicalizes a symlinked dataDir on both sides (consistent match)", () => {
    // mkdtemp on macOS lives under a symlinked /var → /private/var; canonicalizePath
    // realpaths both the root and the candidate, so the under-root check still holds.
    const p = join(worktreesRoot(dataDir), "run-y", "t3", "pkg", "b.ts");
    expect(runTaskForPath(dataDir, p)).toEqual({ run_id: "run-y", task_id: "t3" });
  });

  it("a segment that is not a valid id → null (not a recognizable worktree path)", () => {
    const p = join(worktreesRoot(dataDir), "bad id with spaces", "t1", "a.ts");
    expect(runTaskForPath(dataDir, p)).toBeNull();
  });

  it("empty dataDir or empty path → null", () => {
    expect(runTaskForPath("", "/x")).toBeNull();
    expect(runTaskForPath(dataDir, "")).toBeNull();
  });
});
