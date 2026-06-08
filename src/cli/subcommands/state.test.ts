/**
 * Unit tests for `factory state` (read-only). Uses an isolated temp data dir via
 * $CLAUDE_PLUGIN_DATA and a real StateManager to seed runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stateCommand } from "./state.js";
import { EXIT } from "../exit-codes.js";
import { StateManager } from "../../core/state/index.js";
import type { SpecPointer } from "../../types/index.js";

let dataDir: string;
let prevEnv: string | undefined;
let stdout: string[];

const SPEC: SpecPointer = { repo: "acme/widgets", spec_id: "12-thing", issue_number: 12 };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "factory-state-"));
  prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
  await rm(dataDir, { recursive: true, force: true });
});

const out = () => JSON.parse(stdout.join("")) as Record<string, any>;

describe("factory state", () => {
  it("prints {current:null} and exits OK when there is no current run", async () => {
    const code = await stateCommand.run([]);
    expect(code).toBe(EXIT.OK);
    expect(out()).toEqual({ current: null });
  });

  it("prints the current run's state as JSON", async () => {
    const state = new StateManager({ dataDir });
    await state.create({ run_id: "run-x", spec: SPEC });

    const code = await stateCommand.run([]);
    expect(code).toBe(EXIT.OK);
    expect(out().run_id).toBe("run-x");
    expect(out().spec.issue_number).toBe(12);
  });

  it("prints a specific run by id", async () => {
    const state = new StateManager({ dataDir });
    await state.create({ run_id: "run-a", spec: SPEC });
    await state.create({ run_id: "run-b", spec: SPEC });

    const code = await stateCommand.run(["run-a"]);
    expect(code).toBe(EXIT.OK);
    expect(out().run_id).toBe("run-a");
  });

  it("--summary prints a compact human report", async () => {
    const state = new StateManager({ dataDir });
    await state.create({ run_id: "run-s", spec: SPEC });

    const code = await stateCommand.run(["run-s", "--summary"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout.join("")).toMatch(/run run-s/);
    expect(stdout.join("")).toMatch(/acme\/widgets#12/);
  });

  it("reading an unknown run id throws loudly (not a silent null)", async () => {
    await expect(stateCommand.run(["does-not-exist"])).rejects.toThrow();
  });

  it("--help returns OK", async () => {
    expect(await stateCommand.run(["--help"])).toBe(EXIT.OK);
    expect(stdout.join("")).toMatch(/factory state/);
  });
});
