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
  seedTasksFromSpec,
  createRun,
  resolveOrCreateRun,
  applyResume,
  resolveOwnerSession,
  type RunResumeEnvelope,
  type SpecSelector,
  type CreateRunOptions,
} from "./run.js";
import { EXIT } from "../exit-codes.js";
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
    expect(gh.deletedBranches).toContain("staging/run-old");
    // Protection was torn down too — load-bearing: GitHub blocks deleting a
    // protected ref, so deleteProtection MUST run (and before the branch delete).
    expect(gh.protectionDeletes).toContain("staging/run-old");
    expect(gh.protectionDeletes.indexOf("staging/run-old")).toBeLessThanOrEqual(
      gh.deletedBranches.indexOf("staging/run-old"),
    );
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

    const branch = "staging/run-20260618-101500";

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
    expect(newCalls.filter((c) => c.startsWith("checkout -B staging/"))).toHaveLength(0);
  });
});
