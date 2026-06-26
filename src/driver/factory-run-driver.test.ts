/**
 * WS3 — behavioral drift-guard for the orchestration functions in
 * `scripts/factory-run-driver.js` (the `--mode workflow` driver).
 *
 * The Workflow sandbox cannot import/require a sibling module (it injects readonly
 * globals and nothing else), so the driver is one self-contained `.js` that RUNS its
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

const driverSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../scripts/factory-run-driver.js"),
  "utf8",
);

/**
 * Slice one top-level declaration's source out of the driver. `startNeedle` anchors the
 * declaration; `endNeedle` is the start of the NEXT top-level construct (a blank line +
 * the following decl/comment), so the slice ends exactly at the function's closing brace
 * — never trailing a line comment that would comment out the wrapping `)`.
 */
function sliceFn(startNeedle: string, endNeedle: string): string {
  const start = driverSrc.indexOf(startNeedle);
  if (start < 0) throw new Error(`driver-drift: start anchor not found: ${startNeedle}`);
  const end = driverSrc.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`driver-drift: end anchor not found: ${endNeedle}`);
  return driverSrc.slice(start, end).trim();
}

/** Reconstruct a sliced function with its free variables bound to injected fakes. */
function buildFn<T>(src: string, free: Record<string, unknown>): T {
  const names = Object.keys(free);
  const factory = new Function(...names, `return (${src});`);
  return factory(...names.map((n) => free[n])) as T;
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
};

describe("factory-run-driver orchestration (workflow-mode drift guard)", () => {
  it("all four orchestration functions are extractable (sanity)", () => {
    for (const [name, slice] of Object.entries(SLICES)) {
      expect(() => slice(), `slice failed for ${name}`).not.toThrow();
      expect(slice().startsWith("async function"), `${name} not an async fn`).toBe(true);
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
      // Critical: a transient harness death must NOT classify as a permanent BLOCKED drop.
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

    it("throws loud when a finding-verifier dies (null verdict slot), never a silent blocker-drop", async () => {
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

    const buildFold = (agent: unknown, parseEnvelope: unknown) =>
      buildFn<Record>(SLICES.recordResults(), {
        fileSeq: 0,
        dataDir: "/data",
        runId: "run-1",
        shipMode: "live",
        agent,
        parseEnvelope,
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
        buildCli(agent, parseEnvelope)("factory next-task", "next-task", "Drive", new Set(), "next-task"),
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
        buildCli(agent, parseEnvelope)("factory next-task", "next-task", "Drive", new Set(), "next-task"),
      ).rejects.toThrow(/skipped or died/);
      expect(calls).toHaveLength(1); // no retry
      expect(parsed).toBe(false); // parse never attempted on a dead agent
    });

    it("recordResults calls the exec-agent EXACTLY ONCE — no retry on a parse failure (result_key-guarded mutation)", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => {
        throw new Error("record boundary parse flake");
      };
      await expect(buildFold(agent, parseEnvelope)("T1", "exec", { result_key: {} })).rejects.toThrow(
        /record boundary parse flake/,
      );
      // Exactly-once record atop at-least-once delivery: a re-spawn could double-record, so NONE.
      expect(calls).toHaveLength(1);
    });

    it("recordResults returns the parsed NextAction on the happy path (single agent call)", async () => {
      const { agent, calls } = makeAgent([{ raw: "x" }]);
      const parseEnvelope = () => ({ kind: "done" });
      const out = await buildFold(agent, parseEnvelope)("T1", "exec", { result_key: {} });
      expect(out).toEqual({ kind: "done" });
      expect(calls).toHaveLength(1);
    });

    it("recordResults throws loud on a skipped/dead record agent (out===null)", async () => {
      const { agent } = makeAgent([null]);
      const parseEnvelope = () => ({ kind: "done" });
      await expect(buildFold(agent, parseEnvelope)("T1", "exec", { result_key: {} })).rejects.toThrow(
        /skipped or died/,
      );
    });
  });
});
