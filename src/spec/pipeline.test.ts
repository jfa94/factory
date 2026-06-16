import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecPipeline, SpecDefectError } from "./pipeline.js";
import { SpecStore } from "./store.js";
import { SpecPointerSchema } from "../types/index.js";
import type { GhClient, Prd } from "./gh.js";
import type { GenerateResult, SpecAgentRunner } from "./agents.js";
import type { ReviewVerdict, PerDimension } from "./review.js";
import type { SpecTask } from "./schema.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ws5-pipe-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const PRD_BODY =
  "- The system must let a user submit a checkout order.\n" +
  "- The system must email an order confirmation receipt.\n";

const prd: Prd = {
  issue_number: 123,
  title: "Checkout",
  body: PRD_BODY,
  labels: [],
  body_truncated: false,
};

function fakeGh(p: Prd = prd): GhClient {
  return { fetchPrd: vi.fn(async () => p) };
}

const goodTasks: SpecTask[] = [
  {
    task_id: "t1",
    title: "Submit checkout order",
    description: "user submits a checkout order",
    files: ["src/checkout.ts"],
    acceptance_criteria: ["a user can submit a checkout order"],
    tests_to_write: ["user can submit a checkout order"],
    depends_on: [],
    risk_tier: "high",
    risk_rationale: "payment path",
  },
  {
    task_id: "t2",
    title: "Email order confirmation receipt",
    description: "system emails an order confirmation receipt",
    files: ["src/email.ts"],
    acceptance_criteria: ["the system emails an order confirmation receipt on submit"],
    tests_to_write: ["system emails order confirmation receipt on submit"],
    depends_on: ["t1"],
    risk_tier: "medium",
    risk_rationale: "side effect",
  },
];

const dims = (each: number): PerDimension => ({
  granularity: each,
  dependencies: each,
  acceptance_criteria: each,
  tests: each,
  vertical_slices: each,
  alignment: each,
});

function passingVerdict(): ReviewVerdict {
  return { decision: "PASS", score: 60, per_dimension: dims(10), blockers: [], concerns: [] };
}

function fakeRunner(
  over: Partial<{
    tasks: SpecTask[];
    slug: string;
    verdict: ReviewVerdict;
  }> = {},
): SpecAgentRunner & { generate: ReturnType<typeof vi.fn>; review: ReturnType<typeof vi.fn> } {
  const generated: GenerateResult = {
    specMd: "# Checkout spec",
    slug: over.slug ?? "checkout",
    tasks: over.tasks ?? goodTasks,
  };
  return {
    generate: vi.fn(async () => generated),
    review: vi.fn(async () => over.verdict ?? passingVerdict()),
  };
}

describe("runSpecPipeline — generate→gate→review→store happy path", () => {
  it("Δ X pointer-not-spec: yields a SpecPointer that round-trips and addresses specDir()", async () => {
    const gh = fakeGh();
    const runner = fakeRunner();
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });

    const pointer = await runSpecPipeline({
      repo: "owner/name",
      issueNumber: 123,
      gh,
      runner,
      store,
    });

    expect(SpecPointerSchema.parse(pointer)).toEqual({
      repo: "owner/name",
      spec_id: "123-checkout",
      issue_number: 123,
    });
    // The spec is now durably resolvable by the pointer (the run embeds no spec).
    const resolved = await store.resolveByIssue("owner/name", 123);
    expect(resolved!.spec_id).toBe("123-checkout");
    expect(resolved!.tasks).toHaveLength(2);
  });
});

describe("Δ X reuse-by-issue — no regen when a spec already exists", () => {
  it("Δ X: returns the existing pointer WITHOUT invoking generate/review", async () => {
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    // Seed a stored spec for issue 123.
    const seedRunner = fakeRunner();
    await runSpecPipeline({
      repo: "owner/name",
      issueNumber: 123,
      gh: fakeGh(),
      runner: seedRunner,
      store,
    });

    // Second run: fresh runner whose agents must NEVER be called.
    const reuseRunner = fakeRunner();
    const reuseGh = fakeGh();
    const pointer = await runSpecPipeline({
      repo: "owner/name",
      issueNumber: 123,
      gh: reuseGh,
      runner: reuseRunner,
      store,
    });

    expect(pointer.spec_id).toBe("123-checkout");
    expect(reuseRunner.generate).not.toHaveBeenCalled();
    expect(reuseRunner.review).not.toHaveBeenCalled();
    // PRD fetch is also skipped on reuse (resolve happens before fetch).
    expect(reuseGh.fetchPrd).not.toHaveBeenCalled();
  });
});

describe("bounded revision loop (never spins)", () => {
  it("NEEDS_REVISION loop stops after the cap and throws a loud SpecDefectError", async () => {
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    const runner = fakeRunner({
      verdict: {
        decision: "NEEDS_REVISION",
        score: 30,
        per_dimension: dims(5),
        blockers: ["always blocked"],
        concerns: [],
      },
    });

    const err = await runSpecPipeline({
      repo: "owner/name",
      issueNumber: 123,
      gh: fakeGh(),
      runner,
      store,
      maxRegenIterations: 3,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SpecDefectError);
    expect((err as SpecDefectError).attempts).toBe(3);
    // Bounded: generate called exactly cap times, never more.
    expect(runner.generate).toHaveBeenCalledTimes(3);
  });

  it("a gate-blocking spec also stops at the cap (gates run before review)", async () => {
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    // Vague criterion → testability gate blocks before the reviewer is consulted.
    const badTasks: SpecTask[] = [
      { ...goodTasks[0]!, acceptance_criteria: ["works well"], tests_to_write: ["x"] },
    ];
    const runner = fakeRunner({ tasks: badTasks });

    const err = await runSpecPipeline({
      repo: "owner/name",
      issueNumber: 123,
      gh: fakeGh(),
      runner,
      store,
      maxRegenIterations: 2,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SpecDefectError);
    expect(runner.generate).toHaveBeenCalledTimes(2);
    expect(runner.review).not.toHaveBeenCalled(); // gate short-circuits the review
  });

  it("rejects a non-positive iteration cap", async () => {
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    await expect(
      runSpecPipeline({
        repo: "owner/name",
        issueNumber: 123,
        gh: fakeGh(),
        runner: fakeRunner(),
        store,
        maxRegenIterations: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("review adjudication is wired in (56/60 + floor)", () => {
  it("a 55/60 verdict blocks the pipeline despite a claimed PASS", async () => {
    const store = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    // Claim PASS but score below threshold → pipeline must NOT store it.
    const runner = fakeRunner({
      verdict: {
        decision: "PASS",
        score: 55,
        per_dimension: {
          granularity: 9,
          dependencies: 9,
          acceptance_criteria: 9,
          tests: 9,
          vertical_slices: 9,
          alignment: 10,
        },
        blockers: [],
        concerns: [],
      },
    });
    await expect(
      runSpecPipeline({
        repo: "owner/name",
        issueNumber: 123,
        gh: fakeGh(),
        runner,
        store,
        maxRegenIterations: 1,
      }),
    ).rejects.toBeInstanceOf(SpecDefectError);
  });
});
