import { describe, expect, it } from "vitest";
import {
  RunStateSchema,
  TaskStateSchema,
  parseRunState,
  parseTaskState,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  TERMINAL_RUN_STATUSES,
  NONTERMINAL_RUN_STATUSES,
  type RunState,
} from "./schema.js";

function minimalTask(over: Record<string, unknown> = {}) {
  return { task_id: "t1", risk_tier: "low", ...over };
}

function minimalRun(over: Record<string, unknown> = {}): unknown {
  return {
    run_id: "run-20260101-000000",
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    started_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("schema round-trip", () => {
  it("parses a minimal run, applying defaults", () => {
    const run = parseRunState(minimalRun());
    expect(run.status).toBe("running");
    expect(run.driver).toBe("sequential");
    expect(run.mode).toBe("session");
    expect(run.schema_version).toBe(1);
    expect(run.tasks).toEqual({});
    expect(run.ended_at).toBeNull();
  });

  it("round-trips an explicit workflow mode", () => {
    expect(parseRunState(minimalRun({ mode: "workflow" })).mode).toBe("workflow");
  });

  it("rejects an unknown mode", () => {
    expect(() => parseRunState(minimalRun({ mode: "background" }))).toThrow();
  });

  it("defaults ship_mode to no-merge and round-trips an explicit live", () => {
    expect(parseRunState(minimalRun()).ship_mode).toBe("no-merge");
    expect(parseRunState(minimalRun({ ship_mode: "live" })).ship_mode).toBe("live");
  });

  it("rejects an unknown ship_mode", () => {
    expect(() => parseRunState(minimalRun({ ship_mode: "auto" }))).toThrow();
  });

  it("owner_session is optional (undefined when absent) and round-trips a stamped value", () => {
    // Session-ownership (Prompt J): the owning Claude Code session id stamped at
    // `run create` so the Stop hook can session-scope its block.
    expect(parseRunState(minimalRun()).owner_session).toBeUndefined();
    expect(parseRunState(minimalRun({ owner_session: "sess-123" })).owner_session).toBe("sess-123");
  });

  it("round-trips through JSON without loss", () => {
    const run = parseRunState(
      minimalRun({
        status: "partial",
        tasks: {
          t1: minimalTask({
            status: "dropped",
            failure_class: "capability-budget",
            failure_reason: "producer ladder exhausted",
            escalation_rung: 2,
            reviewers: [{ reviewer: "security", verdict: "blocked", confirmed_blockers: 1 }],
          }),
        },
      }),
    );
    const reparsed = parseRunState(JSON.parse(JSON.stringify(run)));
    expect(reparsed).toEqual(run);
  });

  it("applies task defaults", () => {
    const task = parseTaskState(minimalTask());
    expect(task.status).toBe("pending");
    expect(task.escalation_rung).toBe(0);
    expect(task.depends_on).toEqual([]);
    expect(task.reviewers).toEqual([]);
  });
});

describe("closed enums reject out-of-domain values (loud, not silent)", () => {
  it("rejects a bogus run status", () => {
    expect(() => parseRunState(minimalRun({ status: "interrupted" }))).toThrow();
    expect(() => parseRunState(minimalRun({ status: "bogus" }))).toThrow();
  });

  it("rejects retired human-gate task status", () => {
    expect(() =>
      parseRunState(minimalRun({ tasks: { t1: minimalTask({ status: "needs_human_review" }) } })),
    ).toThrow();
    expect(() =>
      parseRunState(minimalRun({ tasks: { t1: minimalTask({ status: "ci_fixing" }) } })),
    ).toThrow();
  });

  it("rejects an out-of-domain failure class", () => {
    expect(() =>
      parseRunState(
        minimalRun({ tasks: { t1: minimalTask({ status: "dropped", failure_class: "oops" }) } }),
      ),
    ).toThrow();
  });

  it("rejects an out-of-domain risk tier (the single producer dial)", () => {
    expect(() => parseTaskState(minimalTask({ risk_tier: "security" }))).toThrow();
    expect(() => parseTaskState({ task_id: "t1" })).toThrow(); // risk_tier required
  });

  it("rejects an out-of-domain panel verdict", () => {
    expect(() =>
      parseTaskState(minimalTask({ reviewers: [{ reviewer: "x", verdict: "maybe" }] })),
    ).toThrow();
  });
});

describe("cross-field invariants are enforced (not just documented)", () => {
  it("rejects a dropped task with NO failure_class (a drop must be classified)", () => {
    expect(() => parseTaskState(minimalTask({ status: "dropped" }))).toThrow(/failure_class/);
    expect(() =>
      parseRunState(minimalRun({ tasks: { t1: minimalTask({ status: "dropped" }) } })),
    ).toThrow(/failure_class/);
  });

  it("rejects a non-dropped task carrying a failure_class (set IFF dropped)", () => {
    expect(() =>
      parseTaskState(minimalTask({ status: "done", failure_class: "spec-defect" })),
    ).toThrow(/failure_class/);
    // default status is "pending" — still non-dropped, still rejected.
    expect(() => parseTaskState(minimalTask({ failure_class: "spec-defect" }))).toThrow(
      /failure_class/,
    );
  });

  it("accepts a dropped task WITH a failure_class + failure_reason (the only valid drop shape)", () => {
    const t = parseTaskState(
      minimalTask({
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "producer ladder exhausted",
      }),
    );
    expect(t.status).toBe("dropped");
    expect(t.failure_class).toBe("capability-budget");
    expect(t.failure_reason).toBe("producer ladder exhausted");
  });

  it("rejects a dropped task with NO failure_reason (a drop must carry a reason)", () => {
    // A drop is classified AND explained (Decision 22) — failure_reason mirrors
    // TaskTerminalResult's mandatory `reason`.
    expect(() =>
      parseTaskState(minimalTask({ status: "dropped", failure_class: "spec-defect" })),
    ).toThrow(/failure_reason/);
    expect(() =>
      parseTaskState(
        minimalTask({ status: "dropped", failure_class: "spec-defect", failure_reason: "" }),
      ),
    ).toThrow(/failure_reason/);
  });

  it("rejects a non-dropped task carrying a failure_reason (set IFF dropped)", () => {
    expect(() => parseTaskState(minimalTask({ status: "done", failure_reason: "why?" }))).toThrow(
      /failure_reason/,
    );
  });

  it("rejects an incoherent reviewer verdict/blocker-count pair", () => {
    // approve must record 0 confirmed blockers; blocked must record ≥1.
    expect(() =>
      parseTaskState(
        minimalTask({ reviewers: [{ reviewer: "x", verdict: "approve", confirmed_blockers: 2 }] }),
      ),
    ).toThrow(/confirmed blocker/);
    expect(() =>
      parseTaskState(
        minimalTask({ reviewers: [{ reviewer: "x", verdict: "blocked", confirmed_blockers: 0 }] }),
      ),
    ).toThrow(/confirmed blockers/);
  });

  it("accepts coherent reviewer pairs (approve+0, blocked+≥1, error unconstrained)", () => {
    const t = parseTaskState(
      minimalTask({
        reviewers: [
          { reviewer: "impl", verdict: "approve", confirmed_blockers: 0 },
          { reviewer: "sec", verdict: "blocked", confirmed_blockers: 1 },
          { reviewer: "type", verdict: "error", confirmed_blockers: 0 },
        ],
      }),
    );
    expect(t.reviewers).toHaveLength(3);
  });

  it("rejects a quota checkpoint on a non-paused/suspended run", () => {
    // running (default) — quota is only valid while waiting on quota.
    expect(() => parseRunState(minimalRun({ quota: { binding_window: "5h" } }))).toThrow(/quota/);
    // terminal partial must not carry a resume horizon.
    expect(() =>
      parseRunState(minimalRun({ status: "partial", quota: { binding_window: "7d" } })),
    ).toThrow(/quota/);
  });

  it("accepts a quota checkpoint on paused / suspended runs", () => {
    const paused = parseRunState(
      minimalRun({
        status: "paused",
        quota: { binding_window: "5h", resets_at_epoch: 1_900_000_000 },
      }),
    );
    expect(paused.quota?.binding_window).toBe("5h");
    const suspended = parseRunState(
      minimalRun({ status: "suspended", quota: { binding_window: "7d" } }),
    );
    expect(suspended.quota?.binding_window).toBe("7d");
  });
});

describe("run-status terminal/non-terminal split (Δ E distinctness)", () => {
  it("classifies the three quota/quality states distinctly", () => {
    // partial is QUALITY + terminal; paused/suspended are QUOTA + non-terminal.
    expect(isTerminalRunStatus("partial")).toBe(true);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("paused")).toBe(false);
    expect(isTerminalRunStatus("suspended")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("the two split lists are complete + disjoint", () => {
    const all = new Set([...TERMINAL_RUN_STATUSES, ...NONTERMINAL_RUN_STATUSES]);
    expect(all.size).toBe(6);
    for (const s of TERMINAL_RUN_STATUSES) {
      expect(NONTERMINAL_RUN_STATUSES).not.toContain(s);
    }
  });

  it("task terminal split", () => {
    expect(isTerminalTaskStatus("done")).toBe(true);
    expect(isTerminalTaskStatus("dropped")).toBe(true);
    expect(isTerminalTaskStatus("executing")).toBe(false);
  });
});

describe("spec pointer, not embedded spec (Δ X)", () => {
  it("requires repo + spec_id + issue_number", () => {
    expect(() => parseRunState(minimalRun({ spec: { repo: "acme/x" } }))).toThrow();
    expect(() => parseRunState(minimalRun({ spec: { repo: "acme/x", spec_id: "1-a" } }))).toThrow();
  });

  it("a run carries only a pointer (no spec body field)", () => {
    const run: RunState = parseRunState(minimalRun());
    // The pointer is addressable; there is no embedded spec markdown/tasks.
    expect(run.spec).toEqual({ repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 });
    expect((run as unknown as Record<string, unknown>).spec_md).toBeUndefined();
  });
});

describe("no stored gate-verdict field exists on the schema (Δ V)", () => {
  it("TaskState shape has no gate boolean keys", () => {
    const shape = Object.keys(TaskStateSchema.shape);
    for (const k of shape) {
      expect(k).not.toMatch(/_gate$|_gate\b|^quality_gate|^mutation_gate|^security_gate|^coverage/);
    }
  });

  it("strips an injected stored gate boolean (strict-by-omission)", () => {
    const run = parseRunState(
      minimalRun({ tasks: { t1: minimalTask({ quality_gate: true, mutation_gate: true }) } }),
    );
    const t = run.tasks.t1 as unknown as Record<string, unknown>;
    expect(t.quality_gate).toBeUndefined();
    expect(t.mutation_gate).toBeUndefined();
  });
});

describe("RunStateSchema default()", () => {
  it("parses {} only via explicit required fields (no silent empty run)", () => {
    expect(() => RunStateSchema.parse({})).toThrow();
  });
});

describe("TaskState.stage cursor", () => {
  it("accepts the five task stages and defaults to absent", () => {
    const base = parseTaskState(minimalTask());
    expect(base.stage).toBeUndefined();
    for (const s of ["preflight", "tests", "exec", "verify", "ship"]) {
      expect(parseTaskState(minimalTask({ stage: s })).stage).toBe(s);
    }
  });

  it("rejects an unknown stage", () => {
    expect(() => parseTaskState(minimalTask({ stage: "deploy" }))).toThrow();
  });

  it("merge_resyncs defaults to 0 and rejects negatives and non-integers", () => {
    const t = parseTaskState(minimalTask());
    expect(t.merge_resyncs).toBe(0);
    expect(() => parseTaskState(minimalTask({ merge_resyncs: -1 }))).toThrow();
    expect(() => parseTaskState(minimalTask({ merge_resyncs: 1.5 }))).toThrow();
  });
});
