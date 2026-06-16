/**
 * `factory run <create|resume>` (C6).
 *
 * Three surfaces:
 *   1. arg/usage edges via {@link runCommand} (short-circuit before any wiring);
 *   2. the pure {@link seedTasksFromSpec} mapping (spec task → pending TaskState),
 *      including the LOUD integrity checks (dangling / self / cyclic / duplicate dep);
 *   3. {@link createRun} (resolve a durable spec → create → seed) and
 *      {@link applyResume} (re-check quota → clear checkpoint or stay blocked)
 *      against a real StateManager + SpecStore temp dir, with an injected reading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCommand,
  seedTasksFromSpec,
  createRun,
  resolveOrCreateRun,
  applyResume,
  type RunResumeEnvelope,
} from "./run.js";
import { EXIT } from "../exit-codes.js";
import { StateManager } from "../../core/state/manager.js";
import { SpecStore, parseSpecManifest, type SpecManifest } from "../../spec/index.js";
import { defaultConfig } from "../../config/schema.js";
import {
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
  type UsageReading,
} from "../../quota/index.js";

const REPO = "acme/widgets";

/** Build one durable spec task with overridable fields. */
function task(
  id: string,
  deps: string[] = [],
  opts: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    task_id: id,
    title: `task ${id}`,
    description: `does ${id}`,
    files: [`src/${id}.ts`],
    acceptance_criteria: ["a"],
    tests_to_write: ["covers it"],
    depends_on: deps,
    risk_tier: "medium",
    risk_rationale: "moderate",
    ...opts,
  };
}

/** A durable spec manifest (issue 42 → spec_id "42-checkout") over the given tasks. */
function manifest(tasks: ReadonlyArray<Record<string, unknown>>): SpecManifest {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: REPO,
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks,
  });
}

// ---------------------------------------------------------------------------
// arg/usage edges
// ---------------------------------------------------------------------------

describe("run arg/usage edges", () => {
  it("no action prints help and exits OK", async () => {
    expect(await runCommand.run([])).toBe(EXIT.OK);
  });
  it("--help prints help and exits OK", async () => {
    expect(await runCommand.run(["--help"])).toBe(EXIT.OK);
  });
  it("an unknown action is a usage error", async () => {
    expect(await runCommand.run(["frobnicate"])).toBe(EXIT.USAGE);
  });

  it("create: missing --repo is a usage error", async () => {
    expect(await runCommand.run(["create", "--issue", "1"])).toBe(EXIT.USAGE);
  });
  it("create: neither --issue nor --spec-id is a usage error", async () => {
    expect(await runCommand.run(["create", "--repo", REPO])).toBe(EXIT.USAGE);
  });
  it("create: both --issue and --spec-id is a usage error", async () => {
    expect(
      await runCommand.run(["create", "--repo", REPO, "--issue", "1", "--spec-id", "1-x"]),
    ).toBe(EXIT.USAGE);
  });
  it("create: a non-numeric --issue is a usage error", async () => {
    expect(await runCommand.run(["create", "--repo", REPO, "--issue", "abc"])).toBe(EXIT.USAGE);
  });
  it("create: --help prints help and exits OK", async () => {
    expect(await runCommand.run(["create", "--help"])).toBe(EXIT.OK);
  });
  it("resume: --help prints help and exits OK", async () => {
    expect(await runCommand.run(["resume", "--help"])).toBe(EXIT.OK);
  });
  it("finalize: --help prints help and exits OK", async () => {
    expect(await runCommand.run(["finalize", "--help"])).toBe(EXIT.OK);
  });
  it("finalize: an unknown --ship-mode is a usage error", async () => {
    // --run given so the parse short-circuits before any store IO.
    expect(await runCommand.run(["finalize", "--run", "run-x", "--ship-mode", "auto"])).toBe(
      EXIT.USAGE,
    );
  });
});

// ---------------------------------------------------------------------------
// seedTasksFromSpec (pure)
// ---------------------------------------------------------------------------

describe("seedTasksFromSpec", () => {
  it("maps each spec task to a pending TaskState carrying only the dial + deps", () => {
    const seeded = seedTasksFromSpec(
      manifest([
        task("t1", [], { risk_tier: "low" }),
        task("t2", ["t1"], { risk_tier: "medium", tdd_exempt: true }),
        task("t3", ["t1", "t2"], { risk_tier: "high" }),
      ]),
    );

    expect(Object.keys(seeded).sort()).toEqual(["t1", "t2", "t3"]);
    expect(seeded.t1).toEqual({
      task_id: "t1",
      status: "pending",
      depends_on: [],
      risk_tier: "low",
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0,
    });
    expect(seeded.t2!.depends_on).toEqual(["t1"]);
    expect(seeded.t2!.risk_tier).toBe("medium");
    expect(seeded.t3!.depends_on).toEqual(["t1", "t2"]);
  });

  it("does NOT carry tdd_exempt into run state (it is read from the spec at runtime)", () => {
    const seeded = seedTasksFromSpec(manifest([task("t1", [], { tdd_exempt: true })]));
    expect("tdd_exempt" in seeded.t1!).toBe(false);
  });

  it("is LOUD on a dangling dependency", () => {
    expect(() => seedTasksFromSpec(manifest([task("t1", ["ghost"])]))).toThrow(
      /unknown task 'ghost'/,
    );
  });

  it("is LOUD on a self dependency", () => {
    expect(() => seedTasksFromSpec(manifest([task("t1", ["t1"])]))).toThrow(/depends on itself/);
  });

  it("is LOUD on a dependency cycle", () => {
    expect(() => seedTasksFromSpec(manifest([task("t1", ["t2"]), task("t2", ["t1"])]))).toThrow(
      /dependency cycle/,
    );
  });

  it("is LOUD on a duplicate task id", () => {
    expect(() => seedTasksFromSpec(manifest([task("t1"), task("t1")]))).toThrow(
      /duplicate task id 't1'/,
    );
  });
});

// ---------------------------------------------------------------------------
// createRun + applyResume (real StateManager + SpecStore temp dir)
// ---------------------------------------------------------------------------

describe("createRun", () => {
  let dataDir: string;
  let state: StateManager;
  let store: SpecStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-create-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    store = new SpecStore({ dataDir });
    await store.write(manifest([task("t1", []), task("t2", ["t1"])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("resolves the spec by issue, creates the run, and seeds its tasks", async () => {
    const run = await createRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-a",
    });

    expect(run.run_id).toBe("run-a");
    expect(run.status).toBe("running");
    // No --driver flag exists: v1 hardcodes the sequential pump driver.
    expect(run.driver).toBe("sequential");
    expect(run.spec).toEqual({ repo: REPO, spec_id: "42-checkout", issue_number: 42 });
    expect(Object.keys(run.tasks).sort()).toEqual(["t1", "t2"]);
    expect(run.tasks.t1!.status).toBe("pending");
    expect(run.tasks.t2!.depends_on).toEqual(["t1"]);

    // The seeded run is the current run and round-trips through a fresh read.
    expect((await state.read("run-a")).tasks.t2!.depends_on).toEqual(["t1"]);
    expect((await state.readCurrent())!.run_id).toBe("run-a");
  });

  it("resolves the spec by explicit spec-id and hardcodes the sequential driver", async () => {
    const run = await createRun(state, store, {
      repo: REPO,
      specId: "42-checkout",
      runId: "run-b",
    });
    expect(run.driver).toBe("sequential");
    expect(Object.keys(run.tasks).sort()).toEqual(["t1", "t2"]);
  });

  it("is LOUD when no spec exists for the issue", async () => {
    await expect(
      createRun(state, store, { repo: REPO, issue: 999, runId: "run-c" }),
    ).rejects.toThrow(/no spec for issue #999/);
  });

  it("workflow mode persists mode and warns once at opt-in", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const run = await createRun(state, store, {
        repo: REPO,
        issue: 42,
        runId: "run-wf",
        mode: "workflow",
      });
      expect(run.mode).toBe("workflow");
      // Persisted (resume-safe): the mode round-trips through a fresh read.
      expect((await state.read("run-wf")).mode).toBe("workflow");
      // Decision 24: warned ONCE at opt-in (run create), not on every pump tick.
      const warned = spy.mock.calls.filter((c) => /pacing disabled/.test(String(c[0])));
      expect(warned).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("session mode is the default and never warns about pacing", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const run = await createRun(state, store, { repo: REPO, issue: 42, runId: "run-se" });
      expect(run.mode).toBe("session");
      expect(spy.mock.calls.filter((c) => /pacing disabled/.test(String(c[0])))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("persisted mode survives a state.update round-trip (resume-safe)", async () => {
    await createRun(state, store, { repo: REPO, issue: 42, runId: "run-rt", mode: "workflow" });
    // A resume clears the quota checkpoint by spreading the prior state — mode rides along.
    await state.update("run-rt", (s) => ({ ...s, status: "running" as const }));
    expect((await state.read("run-rt")).mode).toBe("workflow");
  });

  it("persists ship_mode (default no-merge; explicit live round-trips) so the workflow reads it back", async () => {
    const dflt = await createRun(state, store, { repo: REPO, issue: 42, runId: "run-sm0" });
    expect(dflt.ship_mode).toBe("no-merge");
    expect((await state.read("run-sm0")).ship_mode).toBe("no-merge");

    const live = await createRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-sm1",
      shipMode: "live",
    });
    expect(live.ship_mode).toBe("live");
    // Resume-safe: the persisted value survives a fresh read (the workflow's source of truth).
    expect((await state.read("run-sm1")).ship_mode).toBe("live");
  });
});

describe("resolveOrCreateRun (idempotent create)", () => {
  let dataDir: string;
  let state: StateManager;
  let store: SpecStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-reuse-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    store = new SpecStore({ dataDir });
    await store.write(manifest([task("t1", []), task("t2", ["t1"])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("reuses the active run for the same spec and spawns no orphan", async () => {
    const first = await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    expect(first.reused).toBe(false);
    expect(first.run.run_id).toBe("run-a");

    // A second create (different generated id) returns the SAME live run.
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
    });
    expect(second.reused).toBe(true);
    expect(second.run.run_id).toBe("run-a");

    // No orphan: only the original run exists in the store.
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("reuse resolves by explicit spec-id too", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, specId: "42-checkout", runId: "run-a" });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      specId: "42-checkout",
      runId: "run-b",
    });
    expect(second.reused).toBe(true);
    expect(second.run.run_id).toBe("run-a");
  });

  it("force creates a fresh run even when one is active", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    const forced = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      force: true,
    });
    expect(forced.reused).toBe(false);
    expect(forced.run.run_id).toBe("run-b");
    expect((await state.listRuns()).map((r) => r.run_id).sort()).toEqual(["run-a", "run-b"]);
  });

  it("creates a new run when the only matching run is terminal", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    await state.finalize("run-a", "completed");
    const next = await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-b" });
    expect(next.reused).toBe(false);
    expect(next.run.run_id).toBe("run-b");
  });

  it("is LOUD when no spec exists for the issue (the reuse path resolves the spec first)", async () => {
    await expect(
      resolveOrCreateRun(state, store, { repo: REPO, issue: 999, runId: "run-x" }),
    ).rejects.toThrow(/no spec for issue #999/);
  });
});

describe("applyResume", () => {
  const NOW = 1_000_000;
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-resume-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  /** A reading both windows of which are well under curve → pacer proceeds. */
  function underCurve(): UsageReading {
    return {
      kind: "available",
      fiveHour: { utilizationPct: 0, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS - 1 },
      sevenDay: { utilizationPct: 0, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS - 1 },
      capturedAt: NOW,
    };
  }
  /** A reading whose 7d window is over curve at window-day 1 → suspend-7d. */
  function overCurve(): UsageReading {
    return {
      kind: "available",
      fiveHour: { utilizationPct: 0, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS - 1 },
      sevenDay: { utilizationPct: 99, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS - 1 },
      capturedAt: NOW,
    };
  }
  const UNAVAILABLE: UsageReading = { kind: "unavailable", reason: "usage-cache-missing" };

  async function createBareRun(runId: string): Promise<void> {
    await state.create({
      run_id: runId,
      spec: { repo: REPO, spec_id: "42-checkout", issue_number: 42 },
    });
  }
  async function setStatus(
    runId: string,
    status: "paused" | "suspended",
    bindingWindow: "5h" | "7d",
  ): Promise<void> {
    await state.update(runId, (s) => ({
      ...s,
      status,
      quota: { binding_window: bindingWindow, resets_at_epoch: NOW + 10 },
    }));
  }

  function asResumed(env: RunResumeEnvelope): Extract<RunResumeEnvelope, { kind: "resumed" }> {
    if (env.kind !== "resumed") throw new Error(`expected resumed, got ${env.kind}`);
    return env;
  }
  function asBlocked(
    env: RunResumeEnvelope,
  ): Extract<RunResumeEnvelope, { kind: "still-blocked" }> {
    if (env.kind !== "still-blocked") throw new Error(`expected still-blocked, got ${env.kind}`);
    return env;
  }

  it("clears the checkpoint and returns to running when the window has recovered", async () => {
    await createBareRun("r1");
    await setStatus("r1", "paused", "5h");

    const env = asResumed(await applyResume(state, "r1", underCurve(), defaultConfig(), NOW));
    expect(env.run.status).toBe("running");
    expect(env.run.quota).toBeUndefined();

    const reread = await state.read("r1");
    expect(reread.status).toBe("running");
    expect(reread.quota).toBeUndefined();
  });

  it("resumes a suspended run when the window has recovered", async () => {
    await createBareRun("r1");
    await setStatus("r1", "suspended", "7d");
    const env = asResumed(await applyResume(state, "r1", underCurve(), defaultConfig(), NOW));
    expect(env.run.status).toBe("running");
  });

  it("stays blocked (with the reset horizon) and untouched when still over curve", async () => {
    await createBareRun("r1");
    await setStatus("r1", "paused", "5h");

    const env = asBlocked(await applyResume(state, "r1", overCurve(), defaultConfig(), NOW));
    expect(env.status).toBe("paused");
    expect(env.reason).toMatch(/7d quota over curve/);
    expect(env.resets_at_epoch).toBe(NOW + SEVEN_DAY_WINDOW_SECONDS - 1);

    // State is left exactly as persisted (still paused, checkpoint intact).
    const reread = await state.read("r1");
    expect(reread.status).toBe("paused");
    expect(reread.quota).toBeDefined();
  });

  it("fails closed (still-blocked, no reset horizon) when usage is unobservable", async () => {
    await createBareRun("r1");
    await setStatus("r1", "paused", "5h");

    const env = asBlocked(await applyResume(state, "r1", UNAVAILABLE, defaultConfig(), NOW));
    expect(env.reason).toMatch(/usage unavailable/);
    expect(env.resets_at_epoch).toBeUndefined();
  });

  it("is an idempotent re-entry for an already-running run", async () => {
    await createBareRun("r1"); // create → status running
    const env = asResumed(await applyResume(state, "r1", UNAVAILABLE, defaultConfig(), NOW));
    expect(env.run.status).toBe("running");
  });

  it("is LOUD on a terminal run (nothing to resume)", async () => {
    await createBareRun("r1");
    await state.finalize("r1", "completed");
    await expect(applyResume(state, "r1", underCurve(), defaultConfig(), NOW)).rejects.toThrow(
      /terminal/,
    );
  });
});
