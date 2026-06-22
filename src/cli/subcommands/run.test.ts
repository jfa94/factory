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
  runCreate,
  runCancel,
  seedTasksFromSpec,
  createRun,
  resolveOrCreateRun,
  applyResume,
  resolveOwnerSession,
  type RunResumeEnvelope,
  type RunCancelOverrides,
  type SpecSelector,
  type CreateRunOptions,
} from "./run.js";
import { EXIT } from "../../shared/exit-codes.js";
import { NotAutonomousError } from "../../autonomy/mode.js";
import { StateManager } from "../../core/state/manager.js";
import { SpecStore, parseSpecManifest, type SpecManifest } from "../../spec/index.js";
import { FakeGitClient, FakeGhClient } from "../../git/index.js";
import { defaultConfig } from "../../config/schema.js";
import {
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
  type UsageReading,
} from "../../quota/index.js";

const REPO = "acme/widgets";

// `run create`/`run resume` now HALT unless the session is autonomous. Every
// existing create/resume test exercises the happy path, so make the whole file
// run as if launched autonomously; the dedicated suite below covers the negative.
let priorAutonomous: string | undefined;
beforeEach(() => {
  priorAutonomous = process.env.FACTORY_AUTONOMOUS_MODE;
  process.env.FACTORY_AUTONOMOUS_MODE = "1";
});
afterEach(() => {
  if (priorAutonomous === undefined) delete process.env.FACTORY_AUTONOMOUS_MODE;
  else process.env.FACTORY_AUTONOMOUS_MODE = priorAutonomous;
});

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
// SpecSelector — type-level XOR (compile-time, validated by `npm run typecheck`)
// ---------------------------------------------------------------------------
// These assertions FAIL THE BUILD if the XOR regresses to two bare optionals:
// the @ts-expect-error lines would stop erroring (TS6133 "unused") and tsc fails.
const _selIssue: SpecSelector = { issue: 1 };
const _selSpec: SpecSelector = { specId: "x" };
// @ts-expect-error — BOTH keys is an illegal state, must not type-check
const _selBoth: SpecSelector = { issue: 1, specId: "x" };
// @ts-expect-error — NEITHER key is an illegal state, must not type-check
const _selNeither: SpecSelector = {};
void _selIssue;
void _selSpec;
void _selBoth;
void _selNeither;

// ---------------------------------------------------------------------------
// RunIntent — type-level XOR (compile-time, validated by `npm run typecheck`)
// ---------------------------------------------------------------------------
// Illegal flag combinations (force+supersede, supersede+resume, …) are now
// UN-REPRESENTABLE: each is exactly one `intent`. The @ts-expect-error guards the
// closed literal set — a typo'd intent must not type-check.
const _intentDefault: CreateRunOptions = { repo: REPO, runId: "r", issue: 1 }; // intent omitted = default
const _intentFresh: CreateRunOptions = { repo: REPO, runId: "r", issue: 1, intent: "fresh" };
const _intentSupersede: CreateRunOptions = {
  repo: REPO,
  runId: "r",
  issue: 1,
  intent: "supersede",
};
const _intentResume: CreateRunOptions = { repo: REPO, runId: "r", issue: 1, intent: "resume" };
// @ts-expect-error — an unknown intent is an illegal state, must not type-check
const _intentBogus: CreateRunOptions = { repo: REPO, runId: "r", issue: 1, intent: "nope" };
void _intentDefault;
void _intentFresh;
void _intentSupersede;
void _intentResume;
void _intentBogus;

// ---------------------------------------------------------------------------
// arg/usage edges
// ---------------------------------------------------------------------------

describe("mandatory autonomous-mode gate", () => {
  // Override the file-level seam: the inner beforeEach runs AFTER the outer one,
  // so deleting the var here reverts each test to a non-autonomous session.
  beforeEach(() => {
    delete process.env.FACTORY_AUTONOMOUS_MODE;
  });

  it("runCreate refuses to start a run outside autonomous mode", async () => {
    await expect(runCreate(["--issue", "42"])).rejects.toBeInstanceOf(NotAutonomousError);
  });

  it("runResume refuses to resume a run outside autonomous mode", async () => {
    // The gate fires before any run resolution, so no --run / fixtures are needed;
    // NotAutonomousError bubbles uncaught through runCommand (not a UsageError).
    await expect(runCommand.run(["resume"])).rejects.toBeInstanceOf(NotAutonomousError);
  });

  it("the gate is exactly FACTORY_AUTONOMOUS_MODE === '1' (no bypass value)", async () => {
    process.env.FACTORY_AUTONOMOUS_MODE = "true";
    await expect(runCreate(["--issue", "42"])).rejects.toBeInstanceOf(NotAutonomousError);
  });

  it("--help short-circuits BEFORE the gate (help works in any session)", async () => {
    await expect(runCreate(["--help"])).resolves.toBe(EXIT.OK);
  });
});

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
  it("create: --resume + --workflow is a usage error (mode flag on a resume path)", async () => {
    expect(
      await runCommand.run(["create", "--repo", REPO, "--issue", "1", "--resume", "--workflow"]),
    ).toBe(EXIT.USAGE);
  });
  it("create: --resume + --no-ship is a usage error (ship flag on a resume path)", async () => {
    expect(
      await runCommand.run(["create", "--repo", REPO, "--issue", "1", "--resume", "--no-ship"]),
    ).toBe(EXIT.USAGE);
  });
  it("resume: --workflow is a usage error (mode is persisted, never re-passed)", async () => {
    expect(await runCommand.run(["resume", "--workflow"])).toBe(EXIT.USAGE);
  });
  it("resume: --no-ship is a usage error (ship_mode is persisted, never re-passed)", async () => {
    expect(await runCommand.run(["resume", "--no-ship"])).toBe(EXIT.USAGE);
  });
  it("resume: --help prints help and exits OK", async () => {
    expect(await runCommand.run(["resume", "--help"])).toBe(EXIT.OK);
  });
  it("finalize: --help prints help and exits OK", async () => {
    expect(await runCommand.run(["finalize", "--help"])).toBe(EXIT.OK);
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
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0,
    });
    expect(seeded.t2!.depends_on).toEqual(["t1"]);
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
    store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
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
    // No --driver flag exists: v1 hardcodes the sequential driver.
    expect(run.driver).toBe("sequential");
    expect(run.spec).toEqual({ repo: REPO, spec_id: "42-checkout", issue_number: 42 });
    expect(Object.keys(run.tasks).sort()).toEqual(["t1", "t2"]);
    expect(run.tasks.t1!.status).toBe("pending");
    expect(run.tasks.t2!.depends_on).toEqual(["t1"]);

    // The seeded run is the current run and round-trips through a fresh read.
    expect((await state.read("run-a")).tasks.t2!.depends_on).toEqual(["t1"]);
    expect((await state.readCurrent())!.run_id).toBe("run-a");
  });

  it("pins the per-run staging branch on the run row (Decision 33 hardening)", async () => {
    const run = await createRun(state, store, { repo: REPO, issue: 42, runId: "run-pin" });
    // Stored ONCE at create so every later base-ref resolution reads the branch the
    // run actually cut — never a value recomputed by runStagingBranch(run_id).
    expect(run.staging_branch).toBe("staging-run-pin");
    expect((await state.read("run-pin")).staging_branch).toBe("staging-run-pin");
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
      // Decision 24: warned ONCE at opt-in (run create), not on every step.
      const warned = spy.mock.calls.filter((c) => /pacing disabled/.test(String(c[0])));
      expect(warned).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("stamps owner_session when given (session-ownership) and leaves it undefined otherwise", async () => {
    const owned = await createRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-own",
      ownerSession: "sess-owner-1",
    });
    expect(owned.owner_session).toBe("sess-owner-1");
    // Persisted (resume-safe): round-trips through a fresh read.
    expect((await state.read("run-own")).owner_session).toBe("sess-owner-1");

    const anon = await createRun(state, store, { repo: REPO, issue: 42, runId: "run-anon" });
    expect(anon.owner_session).toBeUndefined();
    expect((await state.read("run-anon")).owner_session).toBeUndefined();
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

  it("persists ship_mode (default live; explicit no-merge round-trips) so the workflow reads it back", async () => {
    const dflt = await createRun(state, store, { repo: REPO, issue: 42, runId: "run-sm0" });
    expect(dflt.ship_mode).toBe("live");
    expect((await state.read("run-sm0")).ship_mode).toBe("live");

    const noMerge = await createRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-sm1",
      shipMode: "no-merge",
    });
    expect(noMerge.ship_mode).toBe("no-merge");
    // Resume-safe: the persisted value survives a fresh read (the workflow's source of truth).
    expect((await state.read("run-sm1")).ship_mode).toBe("no-merge");
  });
});

describe("resolveOrCreateRun (discriminated result, Decision 35)", () => {
  let dataDir: string;
  let state: StateManager;
  let store: SpecStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-reuse-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    await store.write(manifest([task("t1", []), task("t2", ["t1"])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  // -------------------------------------------------------------------------
  // kind: "created" — no active run exists
  // -------------------------------------------------------------------------

  it("no active run → kind:'created' (fresh run)", async () => {
    const first = await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("narrowing");
    expect(first.run.run_id).toBe("run-a");
  });

  it("force creates a fresh run even when one is active (kind:'created')", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    const forced = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      intent: "fresh",
    });
    expect(forced.kind).toBe("created");
    if (forced.kind !== "created") throw new Error("narrowing");
    expect(forced.run.run_id).toBe("run-b");
    expect((await state.listRuns()).map((r) => r.run_id).sort()).toEqual(["run-a", "run-b"]);
  });

  it("creates a new run when the only matching run is terminal (kind:'created')", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    await state.finalize("run-a", "completed");
    const next = await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-b" });
    expect(next.kind).toBe("created");
    if (next.kind !== "created") throw new Error("narrowing");
    expect(next.run.run_id).toBe("run-b");
  });

  // -------------------------------------------------------------------------
  // kind: "exists" — active run exists, no flag given (Decision 35: fail loud
  // at the runCreate boundary; resolveOrCreateRun itself just reports the fact)
  // -------------------------------------------------------------------------

  it("active run + no flag → kind:'exists' (no silent reuse, no orphan)", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });

    // A second create (different generated id) returns the SAME live run as "exists".
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
    });
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") throw new Error("narrowing");
    expect(second.existing.run_id).toBe("run-a");

    // No orphan: only the original run exists in the store.
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("active run + no flag → kind:'exists' resolves by explicit spec-id too", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, specId: "42-checkout", runId: "run-a" });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      specId: "42-checkout",
      runId: "run-b",
    });
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") throw new Error("narrowing");
    expect(second.existing.run_id).toBe("run-a");
  });

  it("active run + no flag → kind:'exists' even when intent fields are omitted (direct-API path)", async () => {
    await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-a",
      mode: "workflow",
      shipMode: "live",
    });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
    });
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") throw new Error("narrowing");
    expect(second.existing.run_id).toBe("run-a");
    expect(second.existing.mode).toBe("workflow");
    expect(second.existing.ship_mode).toBe("live");
  });

  it("active run + no flag → kind:'exists' even when re-passed mode/ship MATCH", async () => {
    await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-a",
      mode: "workflow",
      shipMode: "live",
    });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      mode: "workflow",
      shipMode: "live",
    });
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") throw new Error("narrowing");
    expect(second.existing.run_id).toBe("run-a");
  });

  it("active run + no flag → kind:'exists' even when re-passed ship intent diverges (no guard without --resume)", async () => {
    // Decision 35: resolveOrCreateRun no longer asserts flag compatibility on the
    // plain "no flag" path — it just reports kind:"exists". The assertReusableFlags
    // guard only fires on the --resume path (Task 4.2).
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      shipMode: "no-merge",
    });
    expect(second.kind).toBe("exists");
    // No orphan minted.
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("active run + no flag → kind:'exists' even when re-passed --mode diverges (no guard without --resume)", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" });
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      mode: "workflow",
    });
    expect(second.kind).toBe("exists");
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("--resume with divergent ship intent → kind:'exists' (no premature guard; resume continues the live run)", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" }); // ship_mode=live
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      intent: "resume",
      shipMode: "no-merge",
    });
    expect(second.kind).toBe("exists");
    // No orphan: the live run is reported, not replaced.
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("--resume with divergent --mode → kind:'exists' (no premature guard)", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-a" }); // mode=session
    const second = await resolveOrCreateRun(state, store, {
      repo: REPO,
      issue: 42,
      runId: "run-b",
      intent: "resume",
      mode: "workflow",
    });
    expect(second.kind).toBe("exists");
    expect((await state.listRuns()).map((r) => r.run_id)).toEqual(["run-a"]);
  });

  // -------------------------------------------------------------------------
  // kind: "superseded" — --supersede clears the old run and creates fresh
  // -------------------------------------------------------------------------

  it("--supersede → kind:'superseded'; old run marked superseded; its branch deleted", async () => {
    // Seed an active run first (bare state — no staging deps needed for the seed).
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-old" });

    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    const { defaultConfig } = await import("../../config/schema.js");
    const stagingDeps = {
      gitClient: git,
      ghClient: gh,
      config: defaultConfig(),
      targetRoot: "/target",
      owner: "acme",
      repo: "widgets",
    };

    const r = await resolveOrCreateRun(
      state,
      store,
      { repo: REPO, issue: 42, runId: "run-new", intent: "supersede" },
      stagingDeps,
    );

    expect(r.kind).toBe("superseded");
    if (r.kind !== "superseded") throw new Error("narrowing");
    expect(r.supersededId).toBe("run-old");
    expect(r.run.run_id).toBe("run-new");

    // Old run is finalized as superseded.
    expect((await state.read("run-old")).status).toBe("superseded");
    // Branch was deleted via gh fake (field: deletedBranches).
    expect(gh.deletedBranches).toContain("staging-run-old");
    // Protection was torn down too — load-bearing: GitHub blocks deleting a protected
    // ref, so deleteProtection MUST run before the branch delete. Assert on the SINGLE
    // ordered `calls` log (cross-array indexOf would be a 0<=0 tautology).
    expect(gh.protectionDeletes).toContain("staging-run-old");
    expect(gh.calls.indexOf("api DELETE protection staging-run-old")).toBeLessThan(
      gh.calls.indexOf("api DELETE refs/heads/staging-run-old"),
    );
  });

  it("--supersede tears down the OLD run's PINNED branch, not a recompute (revert guard)", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-old" });
    // Desync the pin from runStagingBranch("run-old") (= "staging-run-old") — exactly the
    // mid-run rename Decision 33 defends against. A revert of supersedeRun to the recompute
    // would delete "staging-run-old" and orphan the branch the run actually cut.
    const legacyBranch = "staging-LEGACY-run-old";
    await state.update("run-old", (s) => ({ ...s, staging_branch: legacyBranch }));

    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    const { defaultConfig } = await import("../../config/schema.js");
    const stagingDeps = {
      gitClient: git,
      ghClient: gh,
      config: defaultConfig(),
      targetRoot: "/target",
      owner: "acme",
      repo: "widgets",
    };

    await resolveOrCreateRun(
      state,
      store,
      { repo: REPO, issue: 42, runId: "run-new", intent: "supersede" },
      stagingDeps,
    );

    // Teardown targeted the PINNED legacy branch, NOT the "staging-run-old" recompute.
    expect(gh.protectionDeletes).toContain(legacyBranch);
    expect(gh.deletedBranches).toContain(legacyBranch);
    expect(gh.deletedBranches).not.toContain("staging-run-old");
    // Protection first, then branch (GitHub blocks deleting a protected ref) — assert on
    // the single ordered `calls` log, not a cross-array tautology.
    expect(gh.calls.indexOf(`api DELETE protection ${legacyBranch}`)).toBeLessThan(
      gh.calls.indexOf(`api DELETE refs/heads/${legacyBranch}`),
    );
  });

  it("--supersede teardown failure leaves the old run ACTIVE (terminal write is LAST) — no fresh run", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-old" });

    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    gh.failDeleteProtection = new Error("HTTP 403: Resource not accessible by integration");
    const { defaultConfig } = await import("../../config/schema.js");
    const stagingDeps = {
      gitClient: git,
      ghClient: gh,
      config: defaultConfig(),
      targetRoot: "/target",
      owner: "acme",
      repo: "widgets",
    };

    await expect(
      resolveOrCreateRun(
        state,
        store,
        { repo: REPO, issue: 42, runId: "run-new", intent: "supersede" },
        stagingDeps,
      ),
    ).rejects.toThrow(/403/);

    // finalize runs LAST, so a teardown throw never reached it → the old run is still
    // non-terminal and fully recoverable (a re-run resolves it and retries the teardown).
    expect((await state.read("run-old")).status).toBe("running");
    // The fresh run was never created (the abort happened before createRunFromManifest).
    expect((await state.listRuns()).map((r) => r.run_id)).not.toContain("run-new");
    // Protection threw FIRST → the branch delete never ran (no half-torn-down state).
    expect(gh.deletedBranches).not.toContain("staging-run-old");
  });

  it("--supersede retries idempotently after a transient teardown failure — no orphaned branch", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-old" });

    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    gh.failDeleteProtection = new Error("HTTP 500: server error");
    const { defaultConfig } = await import("../../config/schema.js");
    const stagingDeps = {
      gitClient: git,
      ghClient: gh,
      config: defaultConfig(),
      targetRoot: "/target",
      owner: "acme",
      repo: "widgets",
    };

    // First attempt fails mid-teardown; the old run stays active (the recoverable state).
    await expect(
      resolveOrCreateRun(
        state,
        store,
        { repo: REPO, issue: 42, runId: "run-new", intent: "supersede" },
        stagingDeps,
      ),
    ).rejects.toThrow(/500/);
    expect((await state.read("run-old")).status).toBe("running");

    // GitHub recovers; the retry re-resolves the STILL-ACTIVE old run and completes.
    gh.failDeleteProtection = undefined;
    const r = await resolveOrCreateRun(
      state,
      store,
      { repo: REPO, issue: 42, runId: "run-new", intent: "supersede" },
      stagingDeps,
    );

    expect(r.kind).toBe("superseded");
    expect((await state.read("run-old")).status).toBe("superseded");
    // Branch + protection were GC'd on the successful retry → no orphan left behind.
    expect(gh.protectionDeletes).toContain("staging-run-old");
    expect(gh.deletedBranches).toContain("staging-run-old");
  });

  it("--supersede without stagingDeps → UsageError", async () => {
    await resolveOrCreateRun(state, store, { repo: REPO, issue: 42, runId: "run-old" });
    await expect(
      resolveOrCreateRun(state, store, {
        repo: REPO,
        issue: 42,
        runId: "run-new",
        intent: "supersede",
        // no stagingDeps passed
      }),
    ).rejects.toMatchObject({ isUsageError: true });
  });

  it("is LOUD when no spec exists for the issue (the reuse path resolves the spec first)", async () => {
    await expect(
      resolveOrCreateRun(state, store, { repo: REPO, issue: 999, runId: "run-x" }),
    ).rejects.toThrow(/no spec for issue #999/);
  });

  // -------------------------------------------------------------------------
  // runCreate boundary: kind:"exists" → EXIT.CONFLICT + structured envelope
  // -------------------------------------------------------------------------

  it("runCreate: active run + no flag → EXIT.CONFLICT (3) + kind:'exists' envelope on stdout (Task 4.2)", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    // run-a is created with the defaults (session + live).
    await runCreate(["--issue", "42", "--run-id", "run-a"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/x",
      dataDir,
    });

    // Capture stdout to assert the structured envelope.
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    // Suppress stderr noise from emitError.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let exitCode: number | undefined;
    try {
      exitCode = await runCreate(["--issue", "42"], {
        gitClient: git,
        ghClient: gh,
        cwd: "/x",
        dataDir,
      });
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // Must return EXIT.CONFLICT (3), not throw.
    expect(exitCode).toBe(EXIT.CONFLICT);

    // Stdout must carry a kind:"exists" envelope with the active run id.
    const emitted = JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
    expect(emitted.kind).toBe("exists");
    expect((emitted.existing as Record<string, unknown>).run_id).toBe("run-a");
  });

  it("runCreate: --supersede + --resume together → UsageError (at most one)", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    await expect(
      runCreate(["--issue", "42", "--supersede", "--resume"], {
        gitClient: git,
        ghClient: gh,
        cwd: "/x",
        dataDir,
      }),
    ).rejects.toMatchObject({ isUsageError: true });
  });

  it("runCreate: --resume + --workflow → UsageError naming the create-only flags (root-cause guard)", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    await expect(
      runCreate(["--issue", "42", "--resume", "--workflow"], {
        gitClient: git,
        ghClient: gh,
        cwd: "/x",
        dataDir,
      }),
    ).rejects.toMatchObject({
      isUsageError: true,
      message: expect.stringMatching(/create-only and cannot combine with --resume/),
    });
  });

  it("runCreate: bare --workflow still creates a fresh run with mode='workflow' (guard is scoped to --resume)", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    const code = await runCreate(["--issue", "42", "--run-id", "run-wf", "--workflow"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/x",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-wf")).mode).toBe("workflow");
  });

  it("runCreate: --supersede + --workflow replaces the active run in workflow mode (guard is scoped to --resume)", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    const gh = new FakeGhClient();
    await runCreate(["--issue", "42", "--run-id", "run-old"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/x",
      dataDir,
    });
    // No --run-id on the supersede call: an explicit id means "fresh" and would
    // collide with --supersede (picked.length > 1). The superseding run gets a
    // generated id, which we resolve back out of the run list.
    const code = await runCreate(["--issue", "42", "--supersede", "--workflow"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/x",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-old")).status).toBe("superseded");
    const fresh = (await state.listRuns()).find((r) => r.run_id !== "run-old");
    expect(fresh?.mode).toBe("workflow");
    expect(fresh?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// runCreate — auto-derive --repo from the origin remote (Prompt G / F-repo)
// ---------------------------------------------------------------------------

describe("runCreate auto-derives --repo from the origin remote", () => {
  let dataDir: string;

  /**
   * A FakeGitClient whose origin remote-url resolves to the given slug AND whose
   * origin has a `develop` branch seeded — required because `runCreate` now cuts
   * `staging/<run-id>` from `origin/develop` (Decision 33).
   */
  function gitWithOrigin(slug: string): FakeGitClient {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${slug}.git`);
    return git;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-derive-"));
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    await store.write(manifest([task("t1", [])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("no --repo flag → derives the repo from origin and creates the run", async () => {
    const code = await runCreate(["--issue", "42", "--run-id", "run-derive"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    const state = new StateManager({ dataDir });
    expect((await state.read("run-derive")).spec.repo).toBe(REPO);
  });

  it("an EMPTY --repo '' is treated as absent → derives from origin", async () => {
    // End-to-end: `--repo ""` must not be taken as a literal slug. Two guards make it
    // absent — optionalString coerces ""→undefined (unit-tested in args.test.ts) AND
    // resolveRepo treats an empty explicit as not-derivable — so either way resolution
    // falls through to the origin-derive path. This pins the user-visible outcome.
    const code = await runCreate(["--repo", "", "--issue", "42", "--run-id", "run-empty"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    const state = new StateManager({ dataDir });
    expect((await state.read("run-empty")).spec.repo).toBe(REPO);
  });

  it("an explicit --repo that MATCHES the origin (case-insensitively) creates the run", async () => {
    // REPO is "acme/widgets"; the origin canonical casing wins, so the spec stored
    // under REPO is found and the run is keyed to the canonical repo id.
    const code = await runCreate(["--repo", "Acme/Widgets", "--issue", "42", "--run-id", "run-m"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    const state = new StateManager({ dataDir });
    expect((await state.read("run-m")).spec.repo).toBe(REPO);
  });

  it("an explicit --repo that MISMATCHES the origin remote throws LOUD naming both", async () => {
    await expect(
      runCreate(["--repo", "acme/other", "--issue", "42", "--run-id", "run-x"], {
        gitClient: gitWithOrigin(REPO),
        ghClient: new FakeGhClient(),
        cwd: "/wherever",
        dataDir,
      }),
    ).rejects.toThrow(/acme\/other.*acme\/widgets|acme\/widgets.*acme\/other/s);
  });

  it("the mismatch is surfaced as EXIT.USAGE through the command wrapper", async () => {
    // runCommand.run maps the UsageError to EXIT.USAGE; we assert the exit-code path
    // here while driving the resolution via the injected fake (no real git).
    await expect(
      runCreate(["--repo", "acme/other", "--issue", "42"], {
        gitClient: gitWithOrigin(REPO),
        ghClient: new FakeGhClient(),
        cwd: "/wherever",
        dataDir,
      }),
    ).rejects.toMatchObject({ isUsageError: true });
  });

  it("no mode/ship flags → persists the no-flag defaults: session + live", async () => {
    const code = await runCreate(["--issue", "42", "--run-id", "run-def"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);
    const run = await new StateManager({ dataDir }).read("run-def");
    expect(run.mode).toBe("session");
    expect(run.ship_mode).toBe("live");
  });

  it("--workflow flips mode to workflow (ship still defaults live)", async () => {
    await runCreate(["--issue", "42", "--run-id", "run-wf", "--workflow"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    const run = await new StateManager({ dataDir }).read("run-wf");
    expect(run.mode).toBe("workflow");
    expect(run.ship_mode).toBe("live");
  });

  it("--no-ship flips ship_mode to no-merge (mode still defaults session)", async () => {
    await runCreate(["--issue", "42", "--run-id", "run-ns", "--no-ship"], {
      gitClient: gitWithOrigin(REPO),
      ghClient: new FakeGhClient(),
      cwd: "/wherever",
      dataDir,
    });
    const run = await new StateManager({ dataDir }).read("run-ns");
    expect(run.mode).toBe("session");
    expect(run.ship_mode).toBe("no-merge");
  });
});

// ---------------------------------------------------------------------------
// resolveOwnerSession — flag-over-env precedence (Prompt J, session-scoped gate)
// ---------------------------------------------------------------------------

describe("resolveOwnerSession", () => {
  it("prefers the explicit --session-id flag over the env var", () => {
    expect(resolveOwnerSession("sess-flag", { CLAUDE_CODE_SESSION_ID: "sess-env" })).toBe(
      "sess-flag",
    );
  });

  it("falls back to CLAUDE_CODE_SESSION_ID when the flag is absent", () => {
    expect(resolveOwnerSession(undefined, { CLAUDE_CODE_SESSION_ID: "sess-env" })).toBe("sess-env");
  });

  it("returns undefined when neither flag nor env is set (owner-unknown is supported)", () => {
    expect(resolveOwnerSession(undefined, {})).toBeUndefined();
  });

  it("treats a bare boolean flag as absent and falls back to env", () => {
    expect(resolveOwnerSession(true, { CLAUDE_CODE_SESSION_ID: "sess-env" })).toBe("sess-env");
  });

  it("treats an empty-string flag/env as absent (degrades to owner-unknown)", () => {
    expect(resolveOwnerSession("", { CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
    expect(resolveOwnerSession("", { CLAUDE_CODE_SESSION_ID: "sess-env" })).toBe("sess-env");
  });
});

// ---------------------------------------------------------------------------
// runCancel — abandon a live run so the Stop gate releases the owning session
// ---------------------------------------------------------------------------
// The "stuck Stop-gate" trap: a live run (a task still executing) left the owning
// session unable to end, with no in-session escape. `cancel` marks the run terminal
// (reuses `failed`) via the one sanctioned writer — works WITH a task executing (the
// exact mechanism `--supersede` uses), so the gate stops blocking. See Decision 35.
describe("runCancel (abandon a live run, Decision 35)", () => {
  let dataDir: string;
  let state: StateManager;
  let store: SpecStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-cancel-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    await store.write(manifest([task("t1", []), task("t2", ["t1"])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  /** Seed a run (status `running`) for the durable spec; optionally stamp an owner. */
  async function seed(runId: string, owner?: string): Promise<void> {
    await createRun(state, store, {
      repo: REPO,
      issue: 42,
      runId,
      ...(owner !== undefined ? { ownerSession: owner } : {}),
    });
  }

  /** Force a seeded task into `executing` — the exact in-flight state that traps finalize. */
  async function setExecuting(runId: string, taskId: string): Promise<void> {
    await state.update(runId, (s) => ({
      ...s,
      tasks: { ...s.tasks, [taskId]: { ...s.tasks[taskId]!, status: "executing" as const } },
    }));
  }

  /** Run cancel; capture stdout (the JSON envelope) + stderr (the loud line) + exit code. */
  async function cancel(
    argv: string[],
    overrides: RunCancelOverrides,
  ): Promise<{ env: Record<string, unknown>; code: number; stderr: string }> {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      errChunks.push(String(c));
      return true;
    });
    let code: number;
    try {
      code = await runCancel(argv, overrides);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    return {
      env: JSON.parse(chunks.join("")) as Record<string, unknown>,
      code,
      stderr: errChunks.join(""),
    };
  }

  it("cancels a run with a task still executing → status failed (the headline trap)", async () => {
    await seed("run-live");
    await setExecuting("run-live", "t1");

    const { env, code } = await cancel(["--run", "run-live"], { dataDir });

    expect(code).toBe(EXIT.OK);
    expect(env.kind).toBe("cancelled");
    expect((env.run as Record<string, unknown>).status).toBe("failed");
    // The decoupling the fix relies on: finalize(…, "failed") does NOT inspect tasks,
    // so an executing T1 is no barrier (the same path --supersede already takes).
    expect((await state.read("run-live")).status).toBe("failed");
  });

  it("is idempotent — re-cancelling a failed run stays failed and exits OK", async () => {
    await seed("run-i");
    await cancel(["--run", "run-i"], { dataDir }); // first
    const { code } = await cancel(["--run", "run-i"], { dataDir }); // re-cancel
    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-i")).status).toBe("failed");
  });

  it("is LOUD when the run is already terminal as completed (cannot re-finalize as failed)", async () => {
    await seed("run-done");
    await state.finalize("run-done", "completed");
    // Not a UsageError — the manager's "already terminal as X" guard bubbles uncaught.
    await expect(runCancel(["--run", "run-done"], { dataDir })).rejects.toThrow(/already terminal/);
  });

  it("resolves the run THIS session owns (owner-scan) over a repointed runs/current", async () => {
    // run-A (repo acme/widgets, owned sess-1) is the one to cancel. run-B lives in a
    // DIFFERENT repo (the engine forbids two live same-repo runs from different sessions)
    // and, created last, becomes the GLOBAL current pointer. So the current fallback would
    // resolve run-B — owner-scan must win and cancel run-A instead (the stuck-session
    // condition: the run is found by owner_session, independent of runs/current).
    const otherRepo = "other/svc";
    await store.write(
      parseSpecManifest({
        spec_id: "99-other",
        issue_number: 99,
        slug: "other",
        repo: otherRepo,
        generated_at: "2026-06-01T00:00:00.000Z",
        tasks: [task("t1", [])],
      }),
      "# spec\n",
    );
    await seed("run-A", "sess-1");
    await createRun(state, store, {
      repo: otherRepo,
      issue: 99,
      runId: "run-B",
      ownerSession: "sess-2",
    });
    await setExecuting("run-A", "t1");

    // No --run; non-repo cwd → the current fallback resolves the global pointer (run-B).
    await cancel(["--session-id", "sess-1"], { dataDir, cwd: dataDir });

    expect((await state.read("run-A")).status).toBe("failed");
    expect((await state.read("run-B")).status).toBe("running");
  });

  it("is LOUD when the session owns ≥2 live runs — refuses to guess, demands --run", async () => {
    // Two live runs owned by ONE session, in different repos (the engine forbids two
    // live same-repo runs from different sessions). Without --run, cancel must NOT guess
    // which to abandon — a wrong-run finalize is unrecoverable — so it surfaces BOTH
    // candidates and requires --run, never silently falling through to runs/current.
    const otherRepo = "other/svc";
    await store.write(
      parseSpecManifest({
        spec_id: "99-other",
        issue_number: 99,
        slug: "other",
        repo: otherRepo,
        generated_at: "2026-06-01T00:00:00.000Z",
        tasks: [task("t1", [])],
      }),
      "# spec\n",
    );
    await seed("run-m1", "sess-multi");
    await createRun(state, store, {
      repo: otherRepo,
      issue: 99,
      runId: "run-m2",
      ownerSession: "sess-multi",
    });

    let caught: unknown;
    try {
      await runCancel(["--session-id", "sess-multi"], { dataDir, cwd: dataDir });
    } catch (e) {
      caught = e;
    }
    expect((caught as { isUsageError?: boolean }).isUsageError).toBe(true);
    // The message names BOTH candidates so the operator can pick one with --run.
    expect((caught as Error).message).toContain("run-m1");
    expect((caught as Error).message).toContain("run-m2");
    // Neither run was finalized — no wrong-run guess slipped through.
    expect((await state.read("run-m1")).status).toBe("running");
    expect((await state.read("run-m2")).status).toBe("running");
  });

  it("falls through to runs/current when the given session owns nothing (0-owned, not ambiguous)", async () => {
    await seed("run-cur0"); // no owner stamped
    await setExecuting("run-cur0", "t1");
    // sess-none owns nothing → owner-scan yields 0 (NOT ambiguous) → current pointer wins.
    await cancel(["--session-id", "sess-none"], { dataDir, cwd: dataDir });
    expect((await state.read("run-cur0")).status).toBe("failed");
  });

  it("falls back to runs/current when neither --run nor a session id is given", async () => {
    await seed("run-cur");
    await setExecuting("run-cur", "t1");
    // Non-repo cwd → readCurrentForCwd degrades to the global current pointer (run-cur).
    await cancel([], { dataDir, cwd: dataDir });
    expect((await state.read("run-cur")).status).toBe("failed");
  });

  it("is a usage error when no run can be resolved (no --run, no owner, no current)", async () => {
    await expect(runCancel([], { dataDir, cwd: dataDir })).rejects.toMatchObject({
      isUsageError: true,
    });
  });

  it("leaves the staging branch + task PRs untouched by default (no --cleanup)", async () => {
    await seed("run-keep");
    const gh = new FakeGhClient();
    const { env } = await cancel(["--run", "run-keep"], { dataDir, ghClient: gh });
    expect(env.cleaned_up).toBe(false);
    expect(gh.deletedBranches).toHaveLength(0);
    expect(gh.protectionDeletes).toHaveLength(0);
  });

  it("--cleanup tears down protection then the pinned staging branch (auto-closing task PRs)", async () => {
    await seed("run-clean");
    await setExecuting("run-clean", "t1");
    const gh = new FakeGhClient();
    const { env } = await cancel(["--run", "run-clean", "--cleanup"], { dataDir, ghClient: gh });

    expect(env.cleaned_up).toBe(true);
    expect(env.cleanup_error).toBeUndefined(); // honest envelope: clean run carries no error
    expect(gh.protectionDeletes).toContain("staging-run-clean");
    expect(gh.deletedBranches).toContain("staging-run-clean");
    // Protection BEFORE branch delete (GitHub blocks deleting a protected ref). Assert on
    // the SINGLE ordered `calls` log — comparing indices across two separate arrays would
    // be a tautology (each is 0 in its own array).
    const protIdx = gh.calls.indexOf("api DELETE protection staging-run-clean");
    const branchIdx = gh.calls.indexOf("api DELETE refs/heads/staging-run-clean");
    expect(protIdx).toBeGreaterThanOrEqual(0);
    expect(protIdx).toBeLessThan(branchIdx);
  });

  it("--cleanup throw on deleteProtection: run still failed, exit OK, loud + honest envelope", async () => {
    await seed("run-fp");
    const gh = new FakeGhClient();
    gh.failDeleteProtection = new Error("HTTP 403: Resource not accessible by integration");
    const { env, code, stderr } = await cancel(["--run", "run-fp", "--cleanup"], {
      dataDir,
      ghClient: gh,
    });

    // PRIMARY contract met despite the teardown failure: the run is terminal, gate released.
    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-fp")).status).toBe("failed");
    // Envelope is honest: cleanup did NOT complete, and the real error is surfaced.
    expect(env.cleaned_up).toBe(false);
    expect(env.cleanup_error).toContain("403");
    // Protection threw FIRST → the branch delete was never reached.
    expect(gh.deletedBranches).toHaveLength(0);
    // LOUD on stderr, with the branch and a safe-retry hint (not a silent swallow).
    expect(stderr).toContain("staging-run-fp");
    expect(stderr).toContain("--run run-fp --cleanup");
  });

  it("--cleanup throw on deleteRemoteBranch (after protection succeeded): same honest exit", async () => {
    await seed("run-fb");
    const gh = new FakeGhClient();
    gh.failDeleteRemoteBranch = new Error("HTTP 500: server error");
    const { env, code, stderr } = await cancel(["--run", "run-fb", "--cleanup"], {
      dataDir,
      ghClient: gh,
    });

    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-fb")).status).toBe("failed");
    expect(env.cleaned_up).toBe(false);
    expect(env.cleanup_error).toContain("500");
    // Protection ran first and SUCCEEDED; only the branch delete failed.
    expect(gh.protectionDeletes).toContain("staging-run-fb");
    expect(gh.deletedBranches).toHaveLength(0);
    expect(stderr).toContain("retry the teardown");
  });

  it("works OUTSIDE autonomous mode — cancel is the escape verb, never gated", async () => {
    // The whole file runs as autonomous; cancel must free a stuck session regardless.
    delete process.env.FACTORY_AUTONOMOUS_MODE;
    await seed("run-esc");
    await setExecuting("run-esc", "t1");
    const { code } = await cancel(["--run", "run-esc"], { dataDir });
    expect(code).toBe(EXIT.OK);
    expect((await state.read("run-esc")).status).toBe("failed");
  });

  it("--help short-circuits and exits OK (wired into the run dispatch)", async () => {
    expect(await runCommand.run(["cancel", "--help"])).toBe(EXIT.OK);
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

  it.each(["completed", "failed", "superseded"] as const)(
    "is LOUD on a terminal run (%s) — nothing to resume",
    async (status) => {
      await createBareRun("r1");
      await state.finalize("r1", status);
      await expect(applyResume(state, "r1", underCurve(), defaultConfig(), NOW)).rejects.toThrow(
        /terminal/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// run create: cuts + protects staging/<run-id> from develop (Decision 33)
// ---------------------------------------------------------------------------

describe("run create cuts and protects staging/<run-id> from develop", () => {
  let dataDir: string;

  /** Git fake with origin remote URL + develop branch seeded (ensureStaging needs it). */
  function gitWithDevelop(): FakeGitClient {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-develop-1" } });
    git.setRemoteUrl("origin", `git@github.com:${REPO}.git`);
    return git;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-staging-"));
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    await store.write(manifest([task("t1", [])]), "# spec\n");
  });
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("run create cuts staging/<run-id> from origin/develop and provisions protection on it", async () => {
    const git = gitWithDevelop();
    const gh = new FakeGhClient();

    const code = await runCreate(["--issue", "42", "--run-id", "run-20260618-101500"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/target",
      dataDir,
    });
    expect(code).toBe(EXIT.OK);

    const branch = "staging-run-20260618-101500";

    // (a) branch was cut: checkoutB was called with the per-run staging branch from origin/develop
    expect(git.calls).toContain(`checkout -B ${branch} origin/develop`);
    // branch exists in the fake's remote heads (push was called after checkoutB)
    expect(git.getRemoteHead(branch)).toBeDefined();

    // (b) protection was provisioned on the per-run branch
    expect(gh.calls).toContain(`api PUT protection ${branch}`);
    const protection = gh.protection.get(branch);
    expect(protection?.enabled).toBe(true);
    expect(protection?.strictUpToDate).toBe(true);
  });

  it("a second create without --new returns EXIT.CONFLICT (active run exists) and does NOT cut a branch", async () => {
    // Decision 35 / Task 4.2: runCreate no longer silently reuses — it returns
    // EXIT.CONFLICT with a structured envelope when an active run exists and no
    // --supersede/--resume/--new flag was given. The staging branch must NOT be cut.
    const git = gitWithDevelop();
    const gh = new FakeGhClient();

    // First create — cuts the branch.
    await runCreate(["--issue", "42", "--run-id", "run-first"], {
      gitClient: git,
      ghClient: gh,
      cwd: "/target",
      dataDir,
    });
    const callsAfterFirst = [...git.calls];

    // Suppress stdout/stderr output from the conflict response.
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let exitCode: number | undefined;
    try {
      // Second create (auto-id, no --new) → EXIT.CONFLICT (kind:"exists").
      exitCode = await runCreate(["--issue", "42"], {
        gitClient: git,
        ghClient: gh,
        cwd: "/target",
        dataDir,
      });
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(exitCode).toBe(EXIT.CONFLICT);

    // No new checkoutB calls after the first create (branch was not cut for the rejected run).
    const newCalls = git.calls.slice(callsAfterFirst.length);
    expect(newCalls.filter((c) => c.startsWith("checkout -B staging-"))).toHaveLength(0);
  });
});
