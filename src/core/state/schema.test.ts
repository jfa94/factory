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

const NOW = "2026-01-01T12:00:00Z";

function minimalTask(over: Record<string, unknown> = {}) {
  return { task_id: "t1", ...over };
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
    expect(run.execution_mode).toBe("sequential");
    expect(run.mode).toBe("session");
    expect(run.schema_version).toBe(2);
    expect(run.tasks).toEqual({});
    expect(run.ended_at).toBeNull();
  });

  it("round-trips an explicit workflow mode", () => {
    expect(parseRunState(minimalRun({ mode: "workflow" })).mode).toBe("workflow");
  });

  it("rejects an unknown mode", () => {
    expect(() => parseRunState(minimalRun({ mode: "background" }))).toThrow();
  });

  it("defaults ship_mode to live and round-trips an explicit no-merge", () => {
    expect(parseRunState(minimalRun()).ship_mode).toBe("live");
    expect(parseRunState(minimalRun({ ship_mode: "no-merge" })).ship_mode).toBe("no-merge");
  });

  it("rejects an unknown ship_mode", () => {
    expect(() => parseRunState(minimalRun({ ship_mode: "auto" }))).toThrow();
  });

  it("owner_session is optional (undefined when absent) and round-trips a stamped value", () => {
    // Session-ownership (Prompt J): the owning Claude Code session id stamped at
    // `run create` so the Stop hook can session-scope its block.
    expect(parseRunState(minimalRun()).owner_session).toBeUndefined();
    expect(parseRunState(minimalRun({ owner_session: "sess-123" })).owner_session).toBe("sess-123");
    // An EMPTY string is rejected (z.string().min(1)): absent ⇒ omit the key, never "".
    expect(() => parseRunState(minimalRun({ owner_session: "" }))).toThrow();
  });

  it("staging_branch is optional (undefined when absent) and round-trips a pinned value", () => {
    // Pinned ONCE at run-create so readers never recompute the branch the run cut.
    expect(parseRunState(minimalRun()).staging_branch).toBeUndefined();
    expect(parseRunState(minimalRun({ staging_branch: "staging-run-x" })).staging_branch).toBe(
      "staging-run-x",
    );
    expect(() => parseRunState(minimalRun({ staging_branch: "" }))).toThrow();
  });

  it("round-trips through JSON without loss", () => {
    const run = parseRunState(
      minimalRun({
        status: "failed",
        tasks: {
          t1: minimalTask({
            status: "failed",
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
        minimalRun({ tasks: { t1: minimalTask({ status: "failed", failure_class: "oops" }) } }),
      ),
    ).toThrow();
  });

  it("parses a minimal task row — risk_tier is the spec's dial, not a stored field", () => {
    // The risk_tier producer dial lives on SpecTask (spec/schema.ts) and is read
    // live via specTaskOf — it is NOT a TaskState field. A row carrying only task_id
    // is therefore valid (other fields default), and any stray risk_tier key is
    // stripped by the plain z.object. Out-of-domain risk_tier rejection is covered
    // on SpecTask in spec/schema.test.ts (D25).
    expect(parseTaskState({ task_id: "t1" }).task_id).toBe("t1");
  });

  it("rejects an out-of-domain panel verdict", () => {
    expect(() =>
      parseTaskState(minimalTask({ reviewers: [{ reviewer: "x", verdict: "maybe" }] })),
    ).toThrow();
  });
});

describe("cross-field invariants are enforced (not just documented)", () => {
  it("rejects a failed task with NO failure_class (a fail must be classified)", () => {
    expect(() => parseTaskState(minimalTask({ status: "failed" }))).toThrow(/failure_class/);
    expect(() =>
      parseRunState(minimalRun({ tasks: { t1: minimalTask({ status: "failed" }) } })),
    ).toThrow(/failure_class/);
  });

  it("rejects a non-failed task carrying a failure_class (set IFF failed)", () => {
    expect(() =>
      parseTaskState(minimalTask({ status: "done", failure_class: "spec-defect" })),
    ).toThrow(/failure_class/);
    // default status is "pending" — still non-failed, still rejected.
    expect(() => parseTaskState(minimalTask({ failure_class: "spec-defect" }))).toThrow(
      /failure_class/,
    );
  });

  it("accepts a failed task WITH a failure_class + failure_reason (the only valid fail shape)", () => {
    const t = parseTaskState(
      minimalTask({
        status: "failed",
        failure_class: "capability-budget",
        failure_reason: "producer ladder exhausted",
      }),
    );
    expect(t.status).toBe("failed");
    expect(t.failure_class).toBe("capability-budget");
    expect(t.failure_reason).toBe("producer ladder exhausted");
  });

  it("rejects a failed task with NO failure_reason (a fail must carry a reason)", () => {
    // A fail is classified AND explained (Decision 22) — failure_reason mirrors
    // TaskTerminalResult's mandatory `reason`.
    expect(() =>
      parseTaskState(minimalTask({ status: "failed", failure_class: "spec-defect" })),
    ).toThrow(/failure_reason/);
    expect(() =>
      parseTaskState(
        minimalTask({ status: "failed", failure_class: "spec-defect", failure_reason: "" }),
      ),
    ).toThrow(/failure_reason/);
  });

  it("rejects a non-failed task carrying a failure_reason (set IFF failed)", () => {
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
    // terminal failed must not carry a resume horizon.
    expect(() =>
      parseRunState(minimalRun({ status: "failed", quota: { binding_window: "7d" } })),
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
  it("classifies the three terminal states distinctly (Decision 34/35)", () => {
    // completed/failed/superseded are TERMINAL; paused/suspended are QUOTA + non-terminal.
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("superseded")).toBe(true);
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
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("executing")).toBe(false);
  });

  it("parseRunState rejects the removed 'partial' status", () => {
    expect(() => parseRunState(minimalRun({ status: "partial" }))).toThrow();
  });

  it("superseded is a valid terminal status", () => {
    const run = parseRunState(minimalRun({ status: "superseded", ended_at: NOW }));
    expect(isTerminalRunStatus(run.status)).toBe(true);
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

describe("ignore_quota field", () => {
  it("defaults to false when absent (legacy runs unaffected)", () => {
    const run = parseRunState(minimalRun());
    expect(run.ignore_quota).toBe(false);
  });

  it("round-trips true", () => {
    const run = parseRunState(minimalRun({ ignore_quota: true }));
    expect(run.ignore_quota).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(() => parseRunState(minimalRun({ ignore_quota: "yes" }))).toThrow();
  });
});

describe("docs phase marker", () => {
  it("absent by default → undefined", () => {
    expect(parseRunState(minimalRun()).docs).toBeUndefined();
  });

  it("round-trips a done docs marker", () => {
    const run = parseRunState(minimalRun({ docs: { status: "done", ended_at: NOW } }));
    expect(run.docs).toEqual({ status: "done", ended_at: NOW });
  });

  it("round-trips a failed docs marker on a suspended run (no quota checkpoint)", () => {
    const run = parseRunState(
      minimalRun({
        status: "suspended",
        docs: { status: "failed", reason: "scribe BLOCKED", ended_at: NOW },
      }),
    );
    expect(run.status).toBe("suspended");
    expect(run.docs).toEqual({ status: "failed", reason: "scribe BLOCKED", ended_at: NOW });
    expect(run.quota).toBeUndefined();
  });

  it("rejects an unknown docs status", () => {
    expect(() => parseRunState(minimalRun({ docs: { status: "weird", ended_at: NOW } }))).toThrow();
  });
});

describe("TaskState.phase cursor", () => {
  it("accepts the five task phases and defaults to absent", () => {
    const base = parseTaskState(minimalTask());
    expect(base.phase).toBeUndefined();
    for (const s of ["preflight", "tests", "exec", "verify", "ship"]) {
      expect(parseTaskState(minimalTask({ phase: s })).phase).toBe(s);
    }
  });

  it("rejects an unknown phase", () => {
    expect(() => parseTaskState(minimalTask({ phase: "deploy" }))).toThrow();
  });

  it("merge_resyncs defaults to 0 and rejects negatives and non-integers", () => {
    const t = parseTaskState(minimalTask());
    expect(t.merge_resyncs).toBe(0);
    expect(() => parseTaskState(minimalTask({ merge_resyncs: -1 }))).toThrow();
    expect(() => parseTaskState(minimalTask({ merge_resyncs: 1.5 }))).toThrow();
  });
});

describe("TaskState.test_revision_feedback (defective-RED-test recovery)", () => {
  it("is optional (absent by default) and round-trips a stamped value", () => {
    expect(parseTaskState(minimalTask()).test_revision_feedback).toBeUndefined();
    const fb = "pins user_id = auth.uid() — assert behavior, not source literal";
    expect(parseTaskState(minimalTask({ test_revision_feedback: fb })).test_revision_feedback).toBe(
      fb,
    );
  });

  it("is allowed on a failed row (transient feedback, not a failure-cluster field)", () => {
    const t = parseTaskState(
      minimalTask({
        status: "failed",
        failure_class: "capability-budget",
        failure_reason: "exhausted the rung budget re-pinning the RED test",
        test_revision_feedback: "still defective",
      }),
    );
    expect(t.test_revision_feedback).toBe("still defective");
  });
});

describe("TaskState.e2e_feedback (e2e reopen loop)", () => {
  it("is optional (absent by default) and round-trips a stamped value", () => {
    expect(parseTaskState(minimalTask()).e2e_feedback).toBeUndefined();
    const fb = "checkout: expected order confirmation, got 500";
    expect(parseTaskState(minimalTask({ e2e_feedback: fb })).e2e_feedback).toBe(fb);
  });

  it("is allowed on a pending row (a reopen resets status to pending alongside it)", () => {
    const t = parseTaskState(minimalTask({ status: "pending", e2e_feedback: "still red" }));
    expect(t.e2e_feedback).toBe("still red");
  });
});

describe("RunState.e2e (the --e2e opt-in flag)", () => {
  it("defaults to false", () => {
    expect(parseRunState(minimalRun()).e2e).toBe(false);
  });

  it("round-trips true", () => {
    expect(parseRunState(minimalRun({ e2e: true })).e2e).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(() => parseRunState(minimalRun({ e2e: "yes" }))).toThrow();
  });
});

describe("e2e phase marker + author manifest", () => {
  it("absent by default → undefined", () => {
    expect(parseRunState(minimalRun()).e2e_phase).toBeUndefined();
  });

  it("round-trips a done marker with a manifest and reopen counts", () => {
    const run = parseRunState(
      minimalRun({
        e2e_phase: {
          status: "done",
          manifest: [
            { task_ids: ["t1"], spec_path: "e2e/checkout.spec.ts", kind: "critical" },
            { task_ids: ["t2"], spec_path: "throwaway/t2.spec.ts", kind: "throwaway" },
          ],
          reopen_counts: { t1: 1 },
          ended_at: NOW,
        },
      }),
    );
    expect(run.e2e_phase?.status).toBe("done");
    expect(run.e2e_phase?.manifest).toHaveLength(2);
    expect(run.e2e_phase?.reopen_counts).toEqual({ t1: 1 });
  });

  it("status is optional even when a manifest is present (the reopen-clear state)", () => {
    // The twist vs DocsPhase: status is CLEARED on reopen while manifest/counts persist.
    const run = parseRunState(
      minimalRun({
        e2e_phase: {
          manifest: [{ task_ids: ["t1"], spec_path: "e2e/checkout.spec.ts", kind: "critical" }],
          reopen_counts: { t1: 1 },
        },
      }),
    );
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.manifest).toHaveLength(1);
  });

  it("manifest and reopen_counts default to empty", () => {
    const run = parseRunState(minimalRun({ e2e_phase: { status: "done", ended_at: NOW } }));
    expect(run.e2e_phase?.manifest).toEqual([]);
    expect(run.e2e_phase?.reopen_counts).toEqual({});
  });

  it("rejects an unknown e2e phase status", () => {
    expect(() =>
      parseRunState(minimalRun({ e2e_phase: { status: "weird", ended_at: NOW } })),
    ).toThrow();
  });

  it("rejects an unknown manifest kind", () => {
    expect(() =>
      parseRunState(
        minimalRun({
          e2e_phase: {
            manifest: [{ task_ids: ["t1"], spec_path: "e2e/x.spec.ts", kind: "smoke" }],
          },
        }),
      ),
    ).toThrow();
  });

  it("reason set IFF failed (mirrors DocsPhase)", () => {
    expect(() => parseRunState(minimalRun({ e2e_phase: { status: "failed" } }))).toThrow(); // failed with no reason
    expect(() =>
      parseRunState(minimalRun({ e2e_phase: { status: "done", reason: "why" } })),
    ).toThrow(); // done with a reason
    const run = parseRunState(
      minimalRun({ e2e_phase: { status: "failed", reason: "reopen cap exhausted for t1" } }),
    );
    expect(run.e2e_phase?.reason).toBe("reopen cap exhausted for t1");
  });
});
