/**
 * CLI deps-wiring (C2) — unit tests for {@link loadCliDeps}.
 *
 * The bundle is assembled from durable on-disk facts: the run's state.json (its
 * `{repo, spec_id}` pointer) + the durable spec at `specs/<repo>/<spec-id>/`. These
 * tests pin the happy path (every field wired, defaults applied) and the loud-fail
 * edges (missing run, missing spec, store-integrity malformed repo slug) against a
 * real temp data dir — no mocks for the stores under test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCliDeps } from "./wiring.js";
import { StateManager } from "../core/state/index.js";
import { SpecStore } from "../spec/index.js";
import { parseSpecManifest, type SpecManifest } from "../spec/index.js";

const RUN_ID = "run-1";

/** A minimal valid request for `repo`/`specId`/`issue`. */
function makeManifest(repo: string, specId: string, issue: number): SpecManifest {
  return parseSpecManifest({
    spec_id: specId,
    issue_number: issue,
    slug: specId.replace(/^\d+-/, ""),
    repo,
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: "t1",
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a"],
        tests_to_write: ["covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

describe("loadCliDeps", () => {
  let dataDir: string;
  let state: StateManager;
  let specs: SpecStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-wiring-"));
    state = new StateManager({ dataDir });
    specs = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Write a durable spec + create a run pointing at it. */
  async function seedRun(repo: string, specId: string, issue: number) {
    await specs.write(makeManifest(repo, specId, issue), "# spec\n");
    await state.create({
      run_id: RUN_ID,
      spec: { repo, spec_id: specId, issue_number: issue },
    });
  }

  it("assembles the full bundle from the run + durable spec (defaults applied)", async () => {
    await seedRun("acme/widgets", "42-checkout", 42);

    const deps = await loadCliDeps({ dataDir, runId: RUN_ID });

    // spec resolved + identity threaded.
    expect(deps.spec.spec_id).toBe("42-checkout");
    expect(deps.spec.repo).toBe("acme/widgets");
    expect(deps.owner).toBe("acme");
    expect(deps.repo).toBe("widgets");
    // run snapshot carried.
    expect(deps.run.run_id).toBe(RUN_ID);
    expect(deps.run.spec.spec_id).toBe("42-checkout");
    // ship mode defaults to live (auto-merge) — the run's persisted default.
    expect(deps.shipMode).toBe("live");
    // every deterministic seam is wired (no agent runners — that's the runner's job).
    expect(deps.config).toBeDefined();
    expect(deps.git).toBeDefined();
    expect(deps.gh).toBeDefined();
    expect(deps.tools).toBeDefined();
    expect(deps.artifacts).toBeDefined();
    expect(deps.holdout).toBeDefined();
    expect(deps.state).toBeInstanceOf(StateManager);
    expect(deps.dataDir).toBe(dataDir);
  });

  it("honours an explicit shipMode override", async () => {
    await seedRun("acme/widgets", "42-checkout", 42);
    const deps = await loadCliDeps({ dataDir, runId: RUN_ID, shipMode: "live" });
    expect(deps.shipMode).toBe("live");
  });

  it("falls back to the run's persisted ship_mode when no override is given (live run)", async () => {
    // Regression for the silent live→no-merge downgrade: a resumed/manual `drive`
    // or `finalize` that omits `--ship-mode` must keep the run's persisted `live`.
    await specs.write(makeManifest("acme/widgets", "42-checkout", 42), "# spec\n");
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
      ship_mode: "live",
    });

    const deps = await loadCliDeps({ dataDir, runId: RUN_ID });
    expect(deps.shipMode).toBe("live");
  });

  it("lets an explicit override win over the persisted ship_mode", async () => {
    await specs.write(makeManifest("acme/widgets", "42-checkout", 42), "# spec\n");
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
      ship_mode: "live",
    });

    const deps = await loadCliDeps({ dataDir, runId: RUN_ID, shipMode: "no-merge" });
    expect(deps.shipMode).toBe("no-merge");
  });

  it("throws loud when the run does not exist", async () => {
    await expect(loadCliDeps({ dataDir, runId: "no-such-run" })).rejects.toThrow();
  });

  it("throws loud when the run's spec pointer resolves to no durable spec", async () => {
    // Create a run whose pointer references a spec that was never written.
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "99-missing", issue_number: 99 },
    });
    await expect(loadCliDeps({ dataDir, runId: RUN_ID })).rejects.toThrow();
  });

  it("throws a store-integrity error when the persisted repo slug is not owner/name", async () => {
    // A single-segment repo is schema-valid (z.string().min(1)) and round-trips
    // through the spec store (repoKey sanitizes consistently), so the spec READ
    // succeeds and splitRepo is the component that must loudly refuse it.
    await seedRun("brokenrepo", "7-thing", 7);
    await expect(loadCliDeps({ dataDir, runId: RUN_ID })).rejects.toThrow(/owner.*name/i);
  });

  it("rejects a persisted two-segment slug carrying a path-traversal/illegal segment", async () => {
    // The charset gate (not just the segment-count check): `acme/..` is two
    // non-empty segments — the OLD length-only splitRepo accepted it — but its `..`
    // segment would escape the `/repos/{owner}/{name}` shape at the gh REST paths.
    // repoKey("acme/..") sanitizes to "acme-.." (not a pure-dot escape), so the spec
    // store round-trips and splitRepo's isValidRepoSlug gate is what must refuse it.
    await seedRun("acme/..", "8-thing", 8);
    await expect(loadCliDeps({ dataDir, runId: RUN_ID })).rejects.toThrow(/owner.*name/i);
  });
});
