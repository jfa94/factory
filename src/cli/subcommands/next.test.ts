/**
 * `factory next` — unit tests for the run-level pump CLI shell.
 *
 * Surfaces:
 *   1. arg/usage edges (short-circuit before wiring) via nextCommand;
 *   2. --run resolution falls back to runs/current;
 *   3. happy-path JSON envelope passthrough via a seeded tmp run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFile } from "node:fs/promises";

import { nextCommand } from "./next.js";
import { EXIT } from "../exit-codes.js";
import { captureStream } from "../test-helpers.js";
import { makePumpDeps, makeSpec } from "../../driver/pump-fixtures.js";
import { StateManager } from "../../core/state/manager.js";
import { SpecStore } from "../../spec/index.js";
import { usageCachePath } from "../../quota/index.js";

describe("next arg/usage edges", () => {
  it("--help prints help and exits OK", async () => {
    const stdout = captureStream(process.stdout);
    try {
      const code = await nextCommand.run(["--help"]);
      expect(code).toBe(EXIT.OK);
      const help = stdout.read();
      // Both the tasks-ready and all-terminal lines must mention cascade_dropped.
      expect(help).toMatch(/tasks-ready.*cascade_dropped/);
      expect(help).toMatch(/all-terminal.*cascade_dropped/);
    } finally {
      stdout.restore();
    }
  });

  it("no --run with no current run is a usage error", async () => {
    // mkdtemp so StateManager has a valid (but empty) data dir — no current run.
    const dir = await mkdtemp(join(tmpdir(), "factory-next-empty-"));
    const saved = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = dir;
    const stderr = captureStream(process.stderr);
    try {
      const code = await nextCommand.run([]);
      expect(code).toBe(EXIT.USAGE);
      // wrapper prefixes "next: "; inner throw has no duplicate prefix
      expect(stderr.read()).toMatch(/^next: no --run given/);
    } finally {
      stderr.restore();
      if (saved === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
      else process.env["CLAUDE_PLUGIN_DATA"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("next --run resolution falls back to runs/current", () => {
  let dir: string;
  let state: StateManager;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "factory-next-current-"));
    state = new StateManager({
      dataDir: dir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    savedEnv = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = dir;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
    else process.env["CLAUDE_PLUGIN_DATA"] = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves run_id from runs/current when --run is omitted", async () => {
    // Create a run so it becomes current.
    await state.create({
      run_id: "run-current",
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
    // Seed one pending task so pumpRun schedules it.
    await state.update("run-current", (s) => ({
      ...s,
      tasks: {
        T1: {
          task_id: "T1",
          status: "pending",
          depends_on: [],
          risk_tier: "medium",
          escalation_rung: 0,
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));
    // Write the spec to disk — loadPumpDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: dir }).write(spec, "# spec");

    // Write a zero-usage cache so StatuslineUsageSignal proceeds (not quota-blocked).
    const nowSec = Math.floor(Date.now() / 1000);
    await writeFile(
      usageCachePath(dir),
      JSON.stringify({
        captured_at: nowSec,
        five_hour: { used_percentage: 0, resets_at: nowSec + 18_000 },
        seven_day: { used_percentage: 0, resets_at: nowSec + 604_800 },
      }),
    );

    const stdout = captureStream(process.stdout);
    try {
      const code = await nextCommand.run([]); // no --run
      expect(code).toBe(EXIT.OK);
      const envelope = JSON.parse(stdout.read());
      expect(envelope).toMatchObject({ kind: "tasks-ready", run_id: "run-current" });
    } finally {
      stdout.restore();
    }
  });
});

describe("next happy path", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup();
    cleanup = undefined;
  });

  it("emits a tasks-ready envelope as JSON for a fresh pending task", async () => {
    const { deps, runId, cleanup: c } = await makePumpDeps();
    cleanup = c;

    // Write the spec to disk — loadPumpDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: deps.dataDir }).write(spec, "# spec");

    // Write a zero-usage cache so StatuslineUsageSignal proceeds (not quota-blocked).
    const nowSec = Math.floor(Date.now() / 1000);
    await writeFile(
      usageCachePath(deps.dataDir),
      JSON.stringify({
        captured_at: nowSec,
        five_hour: { used_percentage: 0, resets_at: nowSec + 18_000 },
        seven_day: { used_percentage: 0, resets_at: nowSec + 604_800 },
      }),
    );

    const stdout = captureStream(process.stdout);

    const saved = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = deps.dataDir;
    try {
      const code = await nextCommand.run(["--run", runId]);
      expect(code).toBe(EXIT.OK);
      const out = stdout.read();
      expect(out.length).toBeGreaterThan(0);
      const envelope = JSON.parse(out);
      expect(envelope).toMatchObject({ kind: "tasks-ready", run_id: runId });
      expect(envelope.ready).toContain("T1");
    } finally {
      stdout.restore();
      if (saved === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
      else process.env["CLAUDE_PLUGIN_DATA"] = saved;
    }
  });

  it("emits a run-terminal envelope for a run in terminal status", async () => {
    const {
      deps,
      runId,
      cleanup: c,
    } = await makePumpDeps({
      runStatusOverride: "completed",
    });
    cleanup = c;

    // Write the spec to disk — loadPumpDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: deps.dataDir }).write(spec, "# spec");

    const stdout = captureStream(process.stdout);

    const saved = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = deps.dataDir;
    try {
      const code = await nextCommand.run(["--run", runId]);
      expect(code).toBe(EXIT.OK);
      const envelope = JSON.parse(stdout.read());
      expect(envelope).toMatchObject({ kind: "run-terminal", run_id: runId });
    } finally {
      stdout.restore();
      if (saved === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
      else process.env["CLAUDE_PLUGIN_DATA"] = saved;
    }
  });
});
