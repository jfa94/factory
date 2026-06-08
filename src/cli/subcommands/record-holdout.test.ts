/**
 * `factory record-holdout` (C5) — fold the holdout-validator output (Δ Y / Decision 5).
 *
 * arg/usage edges via {@link recordHoldoutCommand}; the fold via
 * {@link applyRecordHoldout} with a hand-wired {@link CliDeps} (InMemory holdout +
 * verdict stores). The fold MUST: persist the parsed verdicts (read back later by
 * record-reviews), score them deterministically, emit the derived gate evidence, and
 * FAIL CLOSED on unparseable validator output — never a silent pass. It is a LOUD
 * error to call it for a task with no withheld answer key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordHoldoutCommand, applyRecordHoldout } from "./record-holdout.js";
import type { CliDeps } from "../wiring.js";
import { EXIT } from "../exit-codes.js";
import { defaultConfig } from "../../config/schema.js";
import { parseSpecManifest } from "../../spec/index.js";
import { StateManager } from "../../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../../git/fakes.js";
import { makeFakeTools } from "../../verifier/deterministic/fakes.js";
import {
  InMemoryHoldoutStore,
  InMemoryHoldoutVerdictStore,
  makeHoldoutRecord,
} from "../../verifier/holdout/index.js";
import { InMemoryArtifactStore } from "../../driver/index.js";

const RUN_ID = "run-1";

function spec() {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: "t1",
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a", "b", "c", "d", "e"],
        tests_to_write: ["covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

/** Build the verdicts JSON the validator would emit for the withheld criteria. */
function validatorJson(entries: ReadonlyArray<[string, boolean, string]>): string {
  return JSON.stringify({
    criteria: entries.map(([criterion, satisfied, evidence]) => ({
      criterion,
      satisfied,
      evidence,
    })),
  });
}

describe("record-holdout arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--task", "t1", "--input", "/x.json"])).toBe(EXIT.USAGE);
  });
  it("missing --task is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--run", RUN_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --input is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--run", RUN_ID, "--task", "t1"])).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordHoldoutCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("applyRecordHoldout fold", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;
  let deps: CliDeps;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-record-holdout-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
    verdictStore = new InMemoryHoldoutVerdictStore();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
    const run = await state.read(RUN_ID);
    deps = {
      config: defaultConfig(),
      spec: spec(),
      git: new FakeGitClient({ remoteHeads: { staging: "sha-staging" } }),
      gh: new FakeGhClient(),
      tools: makeFakeTools(),
      artifacts: new InMemoryArtifactStore(),
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "no-merge",
      state,
      run,
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists the parsed verdicts and emits a PASS gate evidence when all satisfied", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));
    const raw = validatorJson([
      ["d", true, "src/x.ts:10"],
      ["e", true, "src/y.ts:3"],
    ]);

    const env = await applyRecordHoldout(deps, verdictStore, "t1", raw);

    expect(env.evidence.gate).toBe("holdout");
    expect(env.evidence.observed).toBe(true);
    expect(env.check.status).toBe("pass");
    expect(env.check.satisfied).toBe(2);
    expect(env.check.withheld).toBe(2);
    // The verdicts were persisted for the later record-reviews re-derivation.
    expect(await verdictStore.get(RUN_ID, "t1")).toEqual([
      { criterion: "d", satisfied: true, evidence: "src/x.ts:10" },
      { criterion: "e", satisfied: true, evidence: "src/y.ts:3" },
    ]);
  });

  it("scores a partial satisfaction below the pass rate as a FAIL", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));
    const raw = validatorJson([
      ["d", true, "src/x.ts:10"],
      ["e", false, ""],
    ]);

    const env = await applyRecordHoldout(deps, verdictStore, "t1", raw);

    expect(env.check.status).toBe("fail"); // 1/2 = 50% < 80%
    expect(env.evidence.observed).toBe(false);
  });

  it("fails CLOSED on unparseable validator output (verdicts → [], every criterion fails)", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));

    const env = await applyRecordHoldout(deps, verdictStore, "t1", "not json at all");

    expect(env.check.status).toBe("fail");
    expect(env.check.satisfied).toBe(0);
    expect(env.evidence.observed).toBe(false);
    // Even on a parse failure, an (empty) verdict array is persisted, so a later
    // record-reviews re-derivation sees the same fail-closed result.
    expect(await verdictStore.get(RUN_ID, "t1")).toEqual([]);
  });

  it("is a LOUD error when the task has no withheld answer key", async () => {
    await expect(applyRecordHoldout(deps, verdictStore, "t1", validatorJson([]))).rejects.toThrow(
      /no withheld answer key/,
    );
  });
});
