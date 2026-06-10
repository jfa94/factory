/**
 * `factory drive` — unit tests for the per-task pump CLI shell.
 *
 * Surfaces:
 *   1. arg/usage edges (short-circuit before wiring) via driveCommand;
 *   2. --results parse errors surfaced as EXIT.USAGE;
 *   3. happy-path JSON envelope passthrough via a seeded tmp run (like run-task.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { driveCommand } from "./drive.js";
import { EXIT } from "../exit-codes.js";
import { makePumpDeps, makeSpec } from "../../driver/pump-fixtures.js";
import { SpecStore } from "../../spec/index.js";

describe("drive arg/usage edges", () => {
  it("--help prints help and exits OK", async () => {
    expect(await driveCommand.run(["--help"])).toBe(EXIT.OK);
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

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "factory-drive-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("unreadable --results file is a usage error (named in message)", async () => {
    const code = await driveCommand.run([
      "--run",
      "run-1",
      "--task",
      "T1",
      "--results",
      join(dir, "no-such-file.json"),
    ]);
    expect(code).toBe(EXIT.USAGE);
  });

  it("invalid --results JSON is a usage error (named in message)", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ not_a_fold_key: true }), "utf8");
    const code = await driveCommand.run(["--run", "run-1", "--task", "T1", "--results", bad]);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("drive happy path", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup();
    cleanup = undefined;
  });

  it("emits a terminal envelope as JSON for a task already done", async () => {
    // Seed T1 as "done" so pumpTask returns terminal immediately — before preflight
    // touches git. This validates JSON passthrough without requiring a real git remote.
    const {
      deps,
      runId,
      cleanup: c,
    } = await makePumpDeps({
      taskStateOverrides: { task_id: "T1", status: "done" },
    });
    cleanup = c;

    // Write the spec to disk — loadPumpDeps -> loadCliDeps -> SpecStore.read requires it.
    const spec = makeSpec([{ task_id: "T1", acceptance_criteria: ["only one"] }]);
    await new SpecStore({ dataDir: deps.dataDir }).write(spec, "# spec");

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    const saved = process.env["CLAUDE_PLUGIN_DATA"];
    process.env["CLAUDE_PLUGIN_DATA"] = deps.dataDir;
    try {
      const code = await driveCommand.run(["--run", runId, "--task", "T1"]);
      expect(code).toBe(EXIT.OK);
      expect(chunks.length).toBeGreaterThan(0);
      const envelope = JSON.parse(chunks.join(""));
      expect(envelope).toMatchObject({ kind: "terminal", run_id: runId, task_id: "T1" });
      expect(envelope.outcome).toMatchObject({ outcome: "done" });
    } finally {
      process.stdout.write = originalWrite;
      process.env["CLAUDE_PLUGIN_DATA"] = saved;
    }
  });
});
