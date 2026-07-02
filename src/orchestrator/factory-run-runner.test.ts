/**
 * WS3 — behavioral drift-guard for the orchestration functions in
 * `scripts/factory-run-runner.js` (the `--mode workflow` orchestrator).
 *
 * The Workflow sandbox cannot import/require a sibling module (it injects readonly
 * globals and nothing else), so the orchestrator is one self-contained `.js` that RUNS its
 * main loop at module load — it cannot be imported. As with the parseEnvelope mirror
 * (workflow-envelope.test.ts), we read the SHIPPED bytes, slice out one function's
 * source, and reconstruct it in isolation via `new Function(...freeVars)` with fake
 * `agent`/`parallel`/`log` injected. Any edit that breaks these safety contracts —
 * dead-agent → ERROR (not BLOCKED), loud-throw on a short panel or a dead verifier,
 * cli() retry vs recordResults() exactly-once, effort passthrough — fails HERE.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import { nextTask } from "./next.js";
import { makeOrchestratorDeps } from "./orchestrator-fixtures.js";

const driverSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../scripts/factory-run-runner.js"),
  "utf8",
);

/**
 * Slice one top-level declaration's source out of the orchestrator. `startNeedle` anchors the
 * declaration; `endNeedle` is the start of the NEXT top-level construct (a blank line +
 * the following decl/comment), so the slice ends exactly at the function's closing brace
 * — never trailing a line comment that would comment out the wrapping `)`.
 */
function sliceFn(startNeedle: string, endNeedle: string): string {
  const start = driverSrc.indexOf(startNeedle);
  if (start < 0) throw new Error(`orchestrator-drift: start anchor not found: ${startNeedle}`);
  const end = driverSrc.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`orchestrator-drift: end anchor not found: ${endNeedle}`);
  return driverSrc.slice(start, end).trim();
}

/** Reconstruct a sliced function with its free variables bound to injected fakes. */
function buildFn<T>(src: string, free: Record<string, unknown>): T {
  const names = Object.keys(free);
  const factory = new Function(...names, `return (${src});`);
  return factory(...names.map((n) => free[n])) as T;
}

/**
 * Reconstruct a sliced STATEMENT sequence (e.g. a `const` decl followed by a
 * `function` decl) — unlike `buildFn`, this can't wrap the slice in `(...)` since
 * it isn't a single expression. Runs the statements, then returns `returnExpr`.
 */
function buildStatements<T>(src: string, returnExpr: string): T {
  const factory = new Function(`${src}\nreturn ${returnExpr};`);
  return factory() as T;
}

/** A recording fake `agent`: returns scripted values in order; records every call. */
function makeAgent(scripted: unknown[]) {
  const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
  let i = 0;
  const agent = (prompt: string, opts: Record<string, unknown>) => {
    calls.push({ prompt, opts });
    const v = i < scripted.length ? scripted[i] : undefined;
    i += 1;
    return Promise.resolve(v);
  };
  return { agent, calls };
}

/** Faithful to the Workflow runtime: a thrown/rejected thunk resolves to a `null` slot. */
const parallel = (thunks: Array<() => Promise<unknown>>) =>
  Promise.all(
    thunks.map(async (t) => {
      try {
        return await t();
      } catch {
        return null;
      }
    }),
  );

const agentTypeOf = (role: string) => `factory:${role}`;
const modelAlias = (id: string) => id;

const SLICES = {
  runProducer: () =>
    sliceFn("async function runProducer(", "\n\nasync function runVerifyCollection("),
  runVerifyCollection: () =>
    sliceFn("async function runVerifyCollection(", "\n\n// Step one task to terminal"),
  cli: () => sliceFn("async function cli(", "\n\n// Persist a DriveResults document"),
  recordResults: () => sliceFn("async function recordResults(", "\n\nasync function runProducer("),
  agentTypeMap: () => sliceFn("const AGENT_TYPE = {", "\nfunction parseEnvelope("),
  runDocs: () => sliceFn("async function runDocs(", "\n\n// Mirrors runDocs()"),
  runE2e: () => sliceFn("async function runE2e(", '\nphase("Drive");'),
};

describe("factory-run-runner orchestration (workflow-mode drift guard)", () => {
  it("all orchestration functions are extractable (sanity)", () => {
    // agentTypeMap is a statement pair (const + function decl), not a single async
    // function expression — everything else in SLICES is.
    const FN_SLICES = [
      "runProducer",
      "runVerifyCollection",
      "cli",
      "recordResults",
      "runDocs",
      "runE2e",
    ];
    for (const [name, slice] of Object.entries(SLICES)) {
      expect(() => slice(), `slice failed for ${name}`).not.toThrow();
      if (FN_SLICES.includes(name)) {
        expect(slice().startsWith("async function"), `${name} not an async fn`).toBe(true);
      }
    }
  });

  // ── runProducer ───────────────────────────────────────────────────────────
  describe("runProducer", () => {
    type RunProducer = (
      taskId: string,
      env: { request: { agents: Array<Record<string, unknown>> }; worktree: string },
    ) => Promise<{ producer: { status: string } }>;

    const build = (agent: unknown) =>
      buildFn<RunProducer>(SLICES.runProducer(), {
        agent,
        dataDir: "/data",
        runId: "run-1",
        agentTypeOf,
        modelAlias,
        STATUS_OUT: {}, // schema object — value irrelevant; the fake agent ignores it
      });

    const env = (extra: Record<string, unknown> = {}) => ({
      request: {
        agents: [{ role: "test-writer", model: "sonnet", prompt_ref: "p.json", ...extra }],
      },
      worktree: "/wt",
    });

    it("a dead producer (out===null) records to STATUS: ERROR, never BLOCKED (no spec-defect cascade)", async () => {
      const { agent } = makeAgent([null]);
      const out = await build(agent)("T1", env());
      expect(out.producer.status).toMatch(/^STATUS: ERROR/);
      // Critical: a transient harness death must NOT classify as a permanent BLOCKED failure.
      expect(out.producer.status).not.toContain("BLOCKED");
    });

    it("forwards a live producer's STATUS line verbatim", async () => {
      const { agent } = makeAgent([{ status: "STATUS: DONE" }]);
      const out = await build(agent)("T1", env());
      expect(out.producer.status).toBe("STATUS: DONE");
    });

    it("forwards dial.effort into the agent spawn opts when set (WS6 ladder)", async () => {
      const { agent, calls } = makeAgent([{ status: "STATUS: DONE" }]);
      await build(agent)("T1", env({ effort: "xhigh" }));
      expect(calls[0]?.opts["effort"]).toBe("xhigh");
    });

    it("omits effort from the spawn opts when the dial leaves it unset (inherit default)", async () => {
      const { agent, calls } = makeAgent([{ status: "STATUS: DONE" }]);
      await build(agent)("T1", env());
      expect(calls[0]?.opts).not.toHaveProperty("effort");
    });
  });

  // ── runVerifyCollection ─────────────────────────────────────────────────────
  describe("runVerifyCollection", () => {
    type RunVerify = (
      taskId: string,
      env: Record<string, unknown>,
    ) => Promise<{
      reviews: {
        reviews: unknown[];
        verifications: Array<{ reviewer: string; verdicts: unknown[] }>;
      };
    }>;

    const build = (agent: unknown) =>
      buildFn<RunVerify>(SLICES.runVerifyCollection(), {
        agent,
        parallel,
        dataDir: "/data",
        runId: "run-1",
        agentTypeOf,
        modelAlias,
        // Schema objects — values irrelevant; the fake agent ignores them. They MUST be
        // bound, though: an unbound ref inside a panel thunk becomes a swallowed null slot
        // (a false "reviewer died"), masking the real behavior under test.
        RAW_OUT: {},
        REVIEW_OUT: {},
        VERDICT_OUT: {},
      });

    const panelEnv = (n: number) => ({
      request: {
        agents: Array.from({ length: n }, (_, i) => ({ role: `r${i}`, model: "sonnet" })),
      },
      worktree: "/wt",
      base_ref: "origin/staging",
    });

    const review = (reviewer: string, findings: unknown[] = []) => ({
      reviewer,
      verdict: "approve",
      findings,
    });

    it("throws loud when fewer reviewers return than the request names (no silent merge-gate-pass)", async () => {
      // 2 agents, but the second slot dies → filter(Boolean) yields 1 ≠ 2.
      const { agent } = makeAgent([review("r0"), null]);
      await expect(build(agent)("T1", panelEnv(2))).rejects.toThrow(/reviewer\(s\) died/);
    });

    it("throws loud when a finding-verifier dies (null verdict slot), never a silent blocker-failure", async () => {
      // 1 reviewer with one blocking+citable finding; its verifier returns null.
      const blocking = {
        reviewer: "r0",
        severity: "error",
        blocking: true,
        file: "a.ts",
        line: 3,
        quote: "x",
        description: "d",
      };
      const { agent } = makeAgent([review("r0", [blocking]), null]);
      await expect(build(agent)("T1", panelEnv(1))).rejects.toThrow(/finding-verifier\(s\)/);
    });

    it("collects the full panel + empty verifications when no findings are blocking+citable", async () => {
      const { agent, calls } = makeAgent([review("r0", [])]);
      const out = await build(agent)("T1", panelEnv(1));
      expect(out.reviews.reviews).toHaveLength(1);
      expect(out.reviews.verifications).toEqual([{ reviewer: "r0", verdicts: [] }]);
      // No verifier spawned for a zero-blocking review (panel call only).
      expect(calls).toHaveLength(1);
    });
  });

  // ── cli (bounded retry) vs recordResults (exactly-once) ───────────────────────
  describe("cli retry vs recordResults exactly-once", () => {
    type Cli = (
      command: string,
      label: string,
      phaseName: string,
      knownKinds: unknown,
      context: string,
    ) => Promise<unknown>;
    type Record = (taskId: string, phase: string, results: unknown) => Promise<unknown>;

    const buildCli = (agent: unknown, parseEnvelope: unknown) =>
      buildFn<Cli>(SLICES.cli(), {
        agent,
        parseEnvelope,
        log: () => undefined,
        CLI_MAX_ATTEMPTS: 3,
        copyVerbatimInstruction: "copy",
        RAW_OUT: {},
        EXEC_AGENT_MODEL: "sonnet",
      });

    // `cli` is the recovery-path's idempotent no-`--results` re-read (module-scope in
    // production, injected here like every other free var). Defaults to a stub that
    // fails loud if a test forgets to supply one but hits the recovery path.
    const buildRecord = (
      agent: unknown,
      parseEnvelope: unknown,
      cli: unknown = () => {
        throw new Error("test forgot to inject a `cli` fake for the recovery path");
      },
    ) =>
      buildFn<Record>(SLICES.recordResults(), {
        fileSeq: 0,
        dataDir: "/data",
        runId: "run-1",
        shipMode: "live",
        agent,
        parseEnvelope,
        cli,
        log: () => undefined,
        copyVerbatimInstruction: "copy",
        RAW_OUT: {},
        EXEC_AGENT_MODEL: "sonnet",
        DRIVE_KINDS: new Set(["spawn", "done", "pause"]),
      });

    it("cli retries the exec-agent up to CLI_MAX_ATTEMPTS on a parse flake, then succeeds", async () => {
      const { agent, calls } = makeAgent([{ raw: "a" }, { raw: "b" }, { raw: "c" }]);
      let n = 0;
      const parseEnvelope = () => {
        n += 1;
        if (n < 3) throw new Error("boundary parse flake");
        return { kind: "spawn" };
      };
      const out = await buildCli(agent, parseEnvelope)(
        "factory next-task",
        "next-task",
        "Drive",
        new Set(),
        "next-task",
      );
      expect(out).toEqual({ kind: "spawn" });
      expect(calls).toHaveLength(3); // re-spawned the idempotent read-only command twice
    });

    it("cli throws the last parse error after exhausting all attempts", async () => {
      const { agent, calls } = makeAgent([{ raw: "a" }, { raw: "b" }, { raw: "c" }]);
      const parseEnvelope = () => {
        throw new Error("persistent boundary corruption");
      };
      await expect(
        buildCli(agent, parseEnvelope)(
          "factory next-task",
          "next-task",
          "Drive",
          new Set(),
          "next-task",
        ),
      ).rejects.toThrow(/persistent boundary corruption/);
      expect(calls).toHaveLength(3);
    });

    it("cli fails immediately on a skipped/dead agent (out===null) — never burns a retry", async () => {
      const { agent, calls } = makeAgent([null]);
      let parsed = false;
      const parseEnvelope = () => {
        parsed = true;
        return { kind: "spawn" };
      };
      await expect(
        buildCli(agent, parseEnvelope)(
          "factory next-task",
          "next-task",
          "Drive",
          new Set(),
          "next-task",
        ),
      ).rejects.toThrow(/skipped or died/);
      expect(calls).toHaveLength(1); // no retry
      expect(parsed).toBe(false); // parse never attempted on a dead agent
    });

    it("recordResults never re-delivers on failure (result_key-guarded mutation) — the exec-agent for --results is called exactly once", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => {
        throw new Error("record boundary parse flake");
      };
      const cli = async () => ({ kind: "spawn", result_key: { phase: "exec", rung: 0 } });
      await expect(
        buildRecord(agent, parseEnvelope, cli)("T1", "exec", {
          result_key: { phase: "exec", rung: 0 },
        }),
      ).rejects.toThrow(/record boundary parse flake/);
      // Exactly-once record atop at-least-once delivery: a re-spawn could double-record, so NONE.
      expect(calls).toHaveLength(1);
    });

    // ── D6: cursor-observation recovery ─────────────────────────────────────
    // recordResults is at-least-once delivery: the exec-agent may already have RUN
    // the state-mutating `--results` command before flaking on the handback (a
    // transient post-tool API error). On any failure, recordResults re-observes the
    // engine's cursor with ONE idempotent no-`--results` re-read and compares it
    // against what it tried to deliver, instead of assuming failure == not-applied.

    it("recovers via the idempotent re-read when it lands on a terminal envelope (the world moved on)", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => {
        throw new Error("drive: stale or duplicate results (result_key exec/0 vs cursor verify/0)");
      };
      let cliCalls = 0;
      const cli = async () => {
        cliCalls += 1;
        return { kind: "done" };
      };
      const out = await buildRecord(agent, parseEnvelope, cli)("T1", "exec", {
        result_key: { phase: "exec", rung: 0 },
      });
      expect(out).toEqual({ kind: "done" });
      expect(calls).toHaveLength(1); // the failed --results delivery — never re-sent
      expect(cliCalls).toBe(1); // exactly one recovery re-read
    });

    it("recovers via the idempotent re-read when the cursor has ADVANCED past the delivered result_key", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => {
        throw new Error("record boundary parse flake");
      };
      let cliCalls = 0;
      const cli = async () => {
        cliCalls += 1;
        // cursor moved to rung 1 — the delivery at rung 0 landed before this attempt flaked.
        return { kind: "spawn", result_key: { phase: "exec", rung: 1 } };
      };
      const out = await buildRecord(agent, parseEnvelope, cli)("T1", "exec", {
        result_key: { phase: "exec", rung: 0 },
      });
      expect(out).toEqual({ kind: "spawn", result_key: { phase: "exec", rung: 1 } });
      expect(calls).toHaveLength(1);
      expect(cliCalls).toBe(1);
    });

    it("re-throws the ORIGINAL error loud when the re-read cursor is UNCHANGED (genuine transport failure, never masked)", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => {
        throw new Error("record boundary parse flake — never applied");
      };
      let cliCalls = 0;
      const cli = async () => {
        cliCalls += 1;
        // same result_key as delivered — the mutation never landed.
        return { kind: "spawn", result_key: { phase: "exec", rung: 0 } };
      };
      await expect(
        buildRecord(agent, parseEnvelope, cli)("T1", "exec", {
          result_key: { phase: "exec", rung: 0 },
        }),
      ).rejects.toThrow(/record boundary parse flake — never applied/);
      expect(calls).toHaveLength(1);
      expect(cliCalls).toBe(1); // recovery was attempted, then correctly declined
    });

    it("recordResults returns the parsed NextAction on the happy path (single agent call)", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => ({ kind: "done" });
      const out = await buildRecord(agent, parseEnvelope)("T1", "exec", { result_key: {} });
      expect(out).toEqual({ kind: "done" });
      expect(calls).toHaveLength(1);
    });

    it("recordResults throws loud on a skipped/dead record agent (out===null) when the recovery re-read shows the cursor unchanged", async () => {
      const { agent } = makeAgent([null]);
      const parseEnvelope = () => ({ kind: "done" });
      // Same result_key as delivered — the dead agent never got far enough to mutate.
      const cli = async () => ({ kind: "spawn", result_key: {} });
      await expect(
        buildRecord(agent, parseEnvelope, cli)("T1", "exec", { result_key: {} }),
      ).rejects.toThrow(/skipped or died/);
    });
  });

  // ── runDocs / runE2e (phase-coroutine drift guards) ────────────────────────
  describe("runDocs", () => {
    type RunDocs = () => Promise<unknown>;

    const build = (agent: unknown, cli: unknown, parseEnvelope: unknown) =>
      buildFn<RunDocs>(SLICES.runDocs(), {
        agent,
        cli,
        parseEnvelope,
        runId: "run-1",
        dataDir: "/data",
        fileSeq: 0,
        modelAlias,
        copyVerbatimInstruction: "copy",
        STATUS_OUT: {},
        RAW_OUT: {},
        EXEC_AGENT_MODEL: "sonnet",
        DOCS_KINDS: new Set(["spawn", "done", "suspend"]),
      });

    it("a dead scribe (out===null) records STATUS: BLOCKED — ESCALATE, never a silent DONE", async () => {
      const { agent, calls } = makeAgent([null, { raw: "envelope-bytes" }]);
      const cli = async () => ({ kind: "spawn", prompt: "author docs", model: "sonnet" });
      const parseEnvelope = () => ({ kind: "suspend", reason: "docs failed" });
      const out = await build(agent, cli, parseEnvelope)();
      expect(out).toEqual({ kind: "suspend", reason: "docs failed" });
      // The record payload carries the escalation status, not a fabricated success.
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain("STATUS: BLOCKED — ESCALATE scribe agent skipped or died");
    });

    it("a done/suspend emit short-circuits (idempotent re-entry — no scribe spawned)", async () => {
      const { agent, calls } = makeAgent([]);
      const cli = async () => ({ kind: "done" });
      const out = await build(agent, cli, () => {
        throw new Error("parse must not run");
      })();
      expect(out).toEqual({ kind: "done" });
      expect(calls).toHaveLength(0);
    });
  });

  describe("runE2e", () => {
    type RunE2e = () => Promise<unknown>;

    const build = (agent: unknown, cli: unknown, parseEnvelope: unknown) =>
      buildFn<RunE2e>(SLICES.runE2e(), {
        agent,
        cli,
        parseEnvelope,
        runId: "run-1",
        dataDir: "/data",
        fileSeq: 0,
        modelAlias,
        copyVerbatimInstruction: "copy",
        E2E_AUTHOR_OUT: {},
        RAW_OUT: {},
        EXEC_AGENT_MODEL: "sonnet",
        E2E_KINDS: new Set(["spawn", "done", "failed", "reopen", "suspend"]),
      });

    it("a dead e2e-author (out===null) records BLOCKED — ESCALATE with an EMPTY manifest (fails the phase, never suspends)", async () => {
      const { agent, calls } = makeAgent([null, { raw: "envelope-bytes" }]);
      const cli = async () => ({ kind: "spawn", prompt: "author e2e", model: "sonnet" });
      const parseEnvelope = () => ({ kind: "failed", reason: "author died" });
      const out = await build(agent, cli, parseEnvelope)();
      expect(out).toEqual({ kind: "failed", reason: "author died" });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.prompt).toContain(
        "STATUS: BLOCKED — ESCALATE e2e-author agent skipped or died",
      );
      // Nothing was authored → the recorded manifest MUST be empty (not fabricated).
      expect(calls[1]?.prompt).toContain('"manifest":[]');
    });

    it("a non-spawn emit short-circuits (idempotent re-entry / already concluded)", async () => {
      const { agent, calls } = makeAgent([]);
      const cli = async () => ({ kind: "reopen", task_id: "T1" });
      const out = await build(agent, cli, () => {
        throw new Error("parse must not run");
      })();
      expect(out).toEqual({ kind: "reopen", task_id: "T1" });
      expect(calls).toHaveLength(0);
    });
  });

  // ── finalize envelope field (finding 5: cascade_failed, not cascade_dropped) ─
  describe("finalize envelope contract", () => {
    it("the runner reads next.cascade_failed — the field a REAL nextTask finalize emission carries", async () => {
      // Source side: the shipped runner must read the engine's field name…
      expect(driverSrc).toContain("next.cascade_failed");
      // …and the retired misspelling must be gone everywhere in the runner.
      expect(driverSrc).not.toContain("cascade_dropped");

      // Engine side: a real all-terminal run emits kind:"finalize" WITH cascade_failed.
      const { deps, runId, cleanup } = await makeOrchestratorDeps({
        taskStateOverrides: { status: "done" },
      });
      try {
        const env = await nextTask(deps, runId);
        expect(env.kind).toBe("finalize");
        expect(env).toHaveProperty("cascade_failed", []);
      } finally {
        await cleanup();
      }
    });
  });

  // ── AGENT_TYPE map (D4 drift guard) ───────────────────────────────────────
  // The engine's verify spawn names every PANEL_ROLES role; a role missing from
  // the runner's map throws and kills the panel for EVERY task at review. Import
  // the real PANEL_ROLES (source of truth) and assert the REAL shipped map
  // resolves each one — a future new lens that forgets this file fails HERE.
  describe("AGENT_TYPE map", () => {
    it("resolves every PANEL_ROLES role to its factory: agentType", () => {
      const agentTypeOfReal = buildStatements<(role: string) => string>(
        SLICES.agentTypeMap(),
        "agentTypeOf",
      );
      for (const role of PANEL_ROLES) {
        expect(() => agentTypeOfReal(role), `role '${role}' should resolve`).not.toThrow();
        expect(agentTypeOfReal(role)).toBe(`factory:${role}`);
      }
    });
  });
});
