/**
 * `factory drive` — unit tests for the per-task coroutine CLI shell.
 *
 * Surfaces:
 *   1. arg/usage edges (short-circuit before wiring) via driveCommand;
 *   2. --results parse errors surfaced as EXIT.USAGE;
 *   3. happy-path JSON envelope passthrough via a seeded tmp run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { driveCommand } from "./drive.js";
import { EXIT } from "../../shared/exit-codes.js";
import { captureStream } from "../test-helpers.js";
import { makeCoroutineDeps, makeSpec } from "../../driver/coroutine-fixtures.js";
import { SpecStore } from "../../spec/index.js";
import { usageCachePath } from "../../quota/index.js";

describe("drive arg/usage edges", () => {
  it("--help prints help and exits OK", async () => {
    const stdout = captureStream(process.stdout);
    try {
      const code = await driveCommand.run(["--help"]);
      expect(code).toBe(EXIT.OK);
      expect(stdout.read()).toMatch(/fold_key/);
    } finally {
      stdout.restore();
    }
  });

  it("missing --run is a usage error", async () => {
    expect(await driveCommand.run(["--task", "T1"])).toBe(EXIT.USAGE);
  });

  it("missing --task is a usage error", async () => {
    expect(await driveCommand.run(["--run", "run-1"])).toBe(EXIT.USAGE);
  });

  it("unknown --ship-mode is a usage error", async () => {
    expect(await driveCommand.run(["--run", "run-1", "--task", "T1", "--ship-mode", "turbo"])).toBe(
      EXIT.USAGE,
    );
  });
});

describe("drive --results parse errors", () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "factory-drive-test-"));
    savedEnv = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = dir;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
    else process.env["CLAUDE_PLUGIN_DATA"] = savedEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it("--results= (empty string) is a usage error (requires a file path)", async () => {
    const stderr = captureStream(process.stderr);
    try {
      const code = await driveCommand.run(["--run", "run-1", "--task", "T1", "--results="]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr.read()).toContain("requires a file path");
    } finally {
      stderr.restore();
    }
  });

  it("unreadable --results file is a usage error (named in message)", async () => {
    const missingPath = join(dir, "no-such-file.json");
    const stderr = captureStream(process.stderr);
    try {
      const code = await driveCommand.run([
        "--run",
        "run-1",
        "--task",
        "T1",
        "--results",
        missingPath,
      ]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr.read()).toContain(missingPath);
    } finally {
      stderr.restore();
    }
  });

  it("invalid --results JSON is a usage error (named in message)", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ not_a_fold_key: true }), "utf8");
    const stderr = captureStream(process.stderr);
    try {
      const code = await driveCommand.run(["--run", "run-1", "--task", "T1", "--results", bad]);
      expect(code).toBe(EXIT.USAGE);
      expect(stderr.read()).toContain(bad);
      expect(stderr.read()).toContain("fold_key");
    } finally {
      stderr.restore();
    }
  });
});

describe("drive happy path", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup();
    cleanup = undefined;
  });

  it("emits a terminal envelope as JSON for a task already done", async () => {
    // Seed T1 as "done" so stepTask returns terminal immediately — before preflight
    // touches git. This validates JSON passthrough without requiring a real git remote.
    const {
      deps,
      runId,
      cleanup: c,
    } = await makeCoroutineDeps({
      taskStateOverrides: { task_id: "T1", status: "done" },
    });
    cleanup = c;

    // Write the spec to disk — loadCoroutineDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: deps.dataDir, docsRoot: join(deps.dataDir, "_docs") }).write(spec, "# spec");

    const stdout = captureStream(process.stdout);

    const saved = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = deps.dataDir;
    try {
      const code = await driveCommand.run(["--run", runId, "--task", "T1"]);
      expect(code).toBe(EXIT.OK);
      const out = stdout.read();
      expect(out.length).toBeGreaterThan(0);
      const envelope = JSON.parse(out);
      expect(envelope).toMatchObject({ kind: "terminal", run_id: runId, task_id: "T1" });
      expect(envelope.outcome).toMatchObject({ outcome: "done" });
    } finally {
      stdout.restore();
      if (saved === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
      else process.env["CLAUDE_PLUGIN_DATA"] = saved;
    }
  });

  it("emits a spawn envelope for a task with stage cursor at 'tests'", async () => {
    // Seed T1 with stage cursor "tests" (non-terminal) + zero-usage cache so the quota
    // gate passes. stepTask skips preflight (stage cursor starts at "tests"), the tests
    // handler calls producerSpawn → spawn-agents → spawn envelope emitted. No git needed.
    const {
      deps,
      runId,
      cleanup: c,
    } = await makeCoroutineDeps({
      taskStateOverrides: { task_id: "T1", stage: "tests" },
    });
    cleanup = c;

    // Write the spec to disk — loadCoroutineDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: deps.dataDir, docsRoot: join(deps.dataDir, "_docs") }).write(spec, "# spec");

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
      const code = await driveCommand.run(["--run", runId, "--task", "T1"]);
      expect(code).toBe(EXIT.OK);
      const out = stdout.read();
      expect(out.length).toBeGreaterThan(0);
      const envelope = JSON.parse(out);
      expect(envelope).toMatchObject({
        kind: "spawn",
        run_id: runId,
        task_id: "T1",
        fold_key: { stage: "tests", rung: 0 },
        expects: "producer-status",
      });
      expect(envelope.manifest).toBeDefined();
    } finally {
      stdout.restore();
      if (saved === undefined) delete process.env["CLAUDE_PLUGIN_DATA"];
      else process.env["CLAUDE_PLUGIN_DATA"] = saved;
    }
  });
});
