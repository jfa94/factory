import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import type { Config } from "../types/index.js";
import {
  runLadder,
  assertRungChange,
  ESCALATION_CAP,
  type LadderTask,
  type LadderDeps,
} from "./ladder.js";
import { dialForRung } from "./model-dial.js";
import {
  FakeProducerAgentRunner,
  makeFakeVerify,
  VERIFY_CLEAR,
  VERIFY_ERROR,
  verifyBlocked,
  verifyStructuralGate,
  verifyEnvironmental,
  fakeFinding,
} from "./fakes.js";
import type { ProducerOutcome } from "./agents.js";
import type { VerifyPassResult } from "./ladder.js";

const cfg: Config = defaultConfig();

function task(riskTier: LadderTask["riskTier"] = "low"): LadderTask {
  return {
    taskId: "T1",
    title: "add widget",
    description: "adds a widget",
    visibleCriteria: ["renders a widget"],
    files: ["src/widget.ts"],
    riskTier,
  };
}

function deps(
  producerScript: readonly ProducerOutcome[],
  verifyScript: readonly VerifyPassResult[],
  over: Partial<LadderDeps> = {},
): { producer: FakeProducerAgentRunner; deps: LadderDeps } {
  const producer = new FakeProducerAgentRunner(producerScript);
  return {
    producer,
    deps: {
      producer,
      verify: makeFakeVerify(verifyScript),
      config: cfg,
      stage: "verify",
      ...over,
    },
  };
}

describe("ladder — success (D22)", () => {
  it("a done producer + clear floor → advance(ship), one spawn only", async () => {
    const { producer, deps: d } = deps([{ status: "done" }], [VERIFY_CLEAR]);
    const result = await runLadder(task(), d);
    expect(result.kind).toBe("advance");
    if (result.kind === "advance") expect(result.to).toBe("ship");
    expect(producer.spawns).toHaveLength(1);
  });
});

describe("ladder rung change (D22/D25) — each retry rung changes a variable, not a re-roll", () => {
  it("rung 1 keeps the model, rung 2 ESCALATES the model + injects prior-failure context", async () => {
    // low-tier: blocked floor each pass forces escalation through rungs 0,1,2.
    // patchBudget:0 isolates the OUTER model-escalation ladder (no in-rung patch).
    const blocked = verifyBlocked([fakeFinding()]);
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }, { status: "done" }],
      [blocked, blocked, blocked],
      { patchBudget: 0 },
    );
    await runLadder(task("low"), d);
    expect(producer.spawns).toHaveLength(3);
    const [s0, s1, s2] = producer.spawns;
    expect(s0?.model).toBe(cfg.quota.producerModels.low);
    // rung 1: SAME model, fresh context.
    expect(s1?.model).toBe(cfg.quota.producerModels.low);
    // rung 2: ESCALATED model (low→medium) AND injected prior-failure context.
    expect(s2?.model).toBe(cfg.quota.producerModels.medium);
    expect(s2?.model).not.toBe(s1?.model);
    const ctx2 = s2?.context as { injectedPriorFailure?: boolean } | undefined;
    expect(ctx2?.injectedPriorFailure).toBe(true);
    // rung 0/1 do NOT inject prior failures.
    const ctx0 = s0?.context as { injectedPriorFailure?: boolean } | undefined;
    expect(ctx0?.injectedPriorFailure).toBe(false);
  });

  it("assertRungChange THROWS on a blind re-roll (same model, no context change, not the fresh-context rung)", () => {
    const r2 = dialForRung("high", 2, cfg); // ceiling: model unchanged
    // Fabricate a 'previous' rung-2 dial that already injected prior failure, so
    // cur (also rung 2, same model, prior-failure already present) changes nothing.
    const prevAlreadyInjected = { ...r2, rung: 2, injectsPriorFailure: true };
    const curNoChange = {
      ...r2,
      rung: 2,
      model: r2.model,
      escalated: false,
      injectsPriorFailure: true,
    };
    expect(() => assertRungChange(prevAlreadyInjected, curNoChange)).toThrow(/blind re-roll/);
  });

  it("assertRungChange accepts rung 1 (fresh-context same-model re-attempt)", () => {
    const r0 = dialForRung("low", 0, cfg);
    const r1 = dialForRung("low", 1, cfg);
    expect(() => assertRungChange(r0, r1)).not.toThrow();
  });
});

describe("ladder CAP (Δ cap=2)", () => {
  it("after CAP=2 escalating retries with the floor still blocked → taskDropped(capability-budget); a 3rd retry never spawns", async () => {
    const blocked = verifyBlocked([fakeFinding()]);
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }, { status: "done" }],
      [blocked, blocked, blocked],
      { patchBudget: 0 },
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("task-terminal");
    if (result.kind === "task-terminal" && result.outcome.outcome === "dropped") {
      expect(result.outcome.failure_class).toBe("capability-budget");
      expect(result.outcome.reason.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a dropped task-terminal");
    }
    // exactly CAP+1 spawns (rungs 0,1,2) — no 4th.
    expect(producer.spawns).toHaveLength(ESCALATION_CAP + 1);
  });
});

describe("ladder classify-before-retry (Δ D) — immediate drop does NOT burn rungs", () => {
  it("a producer 'blocked-escalate' on rung 0 → IMMEDIATE spec-defect drop, no further spawn, no verify run", async () => {
    const { producer, deps: d } = deps(
      [{ status: "blocked-escalate", reason: "untestable criterion" }],
      [], // verify must never run
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("task-terminal");
    if (result.kind === "task-terminal" && result.outcome.outcome === "dropped") {
      expect(result.outcome.failure_class).toBe("spec-defect");
    } else {
      throw new Error("expected a dropped task-terminal");
    }
    // only the rung-0 spawn — the immediate drop did NOT burn rungs 1/2.
    expect(producer.spawns).toHaveLength(1);
  });

  it("a capability producer failure escalates: needs-context on rung 0 then done+clear on rung 1 → advance", async () => {
    const { producer, deps: d } = deps(
      [{ status: "needs-context", reason: "more context" }, { status: "done" }],
      [VERIFY_CLEAR],
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("advance");
    expect(producer.spawns).toHaveLength(2);
  });
});

describe("ladder fix-forward INNER loop (D27) — patch the misses in-rung, do NOT nuke", () => {
  it("a confirmed miss is PATCHED in-rung (re-spawn with fix instructions) and clears WITHOUT escalating the model", async () => {
    const finding = fakeFinding({ description: "missing null check", file: "src/a.ts", line: 7 });
    // rung 0: fresh(done) → verify(blocked) → PATCH spawn(done) → verify(clear) → advance.
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }],
      [verifyBlocked([finding]), VERIFY_CLEAR],
      { patchBudget: 2 },
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("advance");
    if (result.kind === "advance") expect(result.to).toBe("ship");
    // Exactly two spawns — both on the SAME (un-escalated) rung-0 model.
    expect(producer.spawns).toHaveLength(2);
    expect(producer.spawns[0]?.model).toBe(cfg.quota.producerModels.low);
    expect(producer.spawns[1]?.model).toBe(cfg.quota.producerModels.low);
    // The fresh attempt carries NO fix instructions; the patch spawn carries the
    // specific confirmed blocker as a fix instruction (PATCH, not nuke).
    const fresh = producer.spawns[0]?.context;
    const patch = producer.spawns[1]?.context;
    expect(fresh?.fixInstructions ?? []).toHaveLength(0);
    expect(patch?.fixInstructions).toHaveLength(1);
    expect(patch?.fixInstructions?.[0]?.file).toBe("src/a.ts");
  });

  it("the DEFAULT patch budget (no override) wires the inner loop — a miss is patched, not immediately nuked", async () => {
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }],
      [verifyBlocked([fakeFinding()]), VERIFY_CLEAR],
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("advance");
    expect(producer.spawns).toHaveLength(2);
    // Still rung 0 — patching does not escalate the model.
    expect(producer.spawns[1]?.model).toBe(cfg.quota.producerModels.low);
  });

  it("no PROGRESS across a patch (same blocker count) → stop patching, NUKE + escalate the model", async () => {
    const f = fakeFinding();
    // rung0: fresh(done)→verify(blocked)→patch(done)→verify(blocked, no progress)→escalate
    // rung1: fresh(done)→verify(clear)→advance.
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }, { status: "done" }],
      [verifyBlocked([f]), verifyBlocked([f]), VERIFY_CLEAR],
      { patchBudget: 2 },
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("advance");
    expect(producer.spawns).toHaveLength(3);
    // spawn[1] was the in-rung PATCH (has fix instructions); spawn[2] is the
    // fresh post-nuke rung-1 attempt (no fix instructions — a clean restart).
    const patch = producer.spawns[1]?.context;
    const restart = producer.spawns[2]?.context;
    expect(patch?.fixInstructions).toHaveLength(1);
    expect(restart?.fixInstructions ?? []).toHaveLength(0);
  });

  it("a verifier ERROR is LOUD: it escalates the rung (never advances) and is classified, never silent", async () => {
    // rung0: fresh(done)→verify(error)→escalate; rung1: fresh(done)→verify(clear)→advance.
    const { producer, deps: d } = deps(
      [{ status: "done" }, { status: "done" }],
      [VERIFY_ERROR, VERIFY_CLEAR],
      { patchBudget: 2 },
    );
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("advance");
    expect(producer.spawns).toHaveLength(2);
  });
});

describe("ladder structural failure (Δ D) — verify-detected, immediate classified drop, no rung burned", () => {
  it("a structurally-unfixable GATE failure from verify → IMMEDIATE spec-defect drop, no further spawn", async () => {
    const { producer, deps: d } = deps([{ status: "done" }], [verifyStructuralGate("mutation")], {
      patchBudget: 2,
    });
    const result = await runLadder(task("low"), d);
    expect(result.kind).toBe("task-terminal");
    if (result.kind === "task-terminal" && result.outcome.outcome === "dropped") {
      expect(result.outcome.failure_class).toBe("spec-defect");
    } else {
      throw new Error("expected a dropped task-terminal");
    }
    // Only the rung-0 fresh spawn — the structural drop did NOT burn rungs 1/2.
    expect(producer.spawns).toHaveLength(1);
  });

  it("an ENVIRONMENTAL blocker from verify → IMMEDIATE blocked-environmental drop, no further spawn", async () => {
    const { producer, deps: d } = deps([{ status: "done" }], [verifyEnvironmental()], {
      patchBudget: 2,
    });
    const result = await runLadder(task("medium"), d);
    expect(result.kind).toBe("task-terminal");
    if (result.kind === "task-terminal" && result.outcome.outcome === "dropped") {
      expect(result.outcome.failure_class).toBe("blocked-environmental");
    } else {
      throw new Error("expected a dropped task-terminal");
    }
    expect(producer.spawns).toHaveLength(1);
  });
});

describe("ladder — every terminal path is LOUD + classified (D22)", () => {
  it("there is no silent advance on a blocked floor at cap — it is a classified drop", async () => {
    const blocked = verifyBlocked([fakeFinding()]);
    const { deps: d } = deps(
      [{ status: "done" }, { status: "done" }, { status: "done" }],
      [blocked, blocked, blocked],
      { patchBudget: 0 },
    );
    const result = await runLadder(task("high"), d);
    // every non-advance terminal carries a failure_class.
    expect(result.kind).toBe("task-terminal");
    if (result.kind === "task-terminal" && result.outcome.outcome === "dropped") {
      expect(["capability-budget", "spec-defect", "blocked-environmental"]).toContain(
        result.outcome.failure_class,
      );
    }
  });
});
