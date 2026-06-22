import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../core/state/manager.js";
import { defaultConfig } from "../config/schema.js";
import { FakeGitClient } from "../git/fakes.js";
import { runDocsEmit, runDocsFold, type DocsRunDeps } from "./docs.js";

const RUN_ID = "run-1";
let dataDir: string;
let state: StateManager;
let git: FakeGitClient;

function deps(): DocsRunDeps {
  return { state, git, config: defaultConfig(), dataDir };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "docs-emit-"));
  state = new StateManager({ dataDir });
  git = new FakeGitClient({ remoteHeads: { [`staging-${RUN_ID}`]: "sha-staging" } });
  await state.create({
    run_id: RUN_ID,
    spec: { repo: "acme/widgets", spec_id: "42-x", issue_number: 42 },
  });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("runDocsFold", () => {
  it("DONE → ff-merges docs into staging, pushes, removes worktree, marks docs done", async () => {
    await runDocsEmit(deps(), RUN_ID); // create the worktree first
    const env = await runDocsFold(deps(), RUN_ID, { status: "STATUS: DONE" });
    expect(env.kind).toBe("done");
    // FakeGitClient: mergeFfOrCommit(staging, docsBranch) → mergesInto[staging] = [docsBranch]
    expect(git.mergesInto[`staging-${RUN_ID}`]).toContain(`docs-${RUN_ID}`);
    expect(git.calls.some((c) => c === `push origin staging-${RUN_ID}`)).toBe(true);
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    const run = await state.read(RUN_ID);
    expect(run.docs?.status).toBe("done");
    expect(run.status).not.toBe("suspended");
  });

  it("non-DONE → suspends the run, records the failure reason, never pushes", async () => {
    await runDocsEmit(deps(), RUN_ID);
    const env = await runDocsFold(deps(), RUN_ID, {
      status: "STATUS: BLOCKED — ESCALATE missing context",
    });
    expect(env.kind).toBe("blocked");
    if (env.kind !== "blocked") throw new Error("expected blocked");
    expect(env.reason).toContain("BLOCKED");
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("suspended");
    expect(run.docs?.status).toBe("failed");
    expect(run.docs?.reason).toContain("BLOCKED");
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
  });
});

describe("runDocsEmit", () => {
  it("creates the docs worktree off the staging tip and returns a spawn envelope", async () => {
    const env = await runDocsEmit(deps(), RUN_ID);
    expect(env.kind).toBe("spawn");
    if (env.kind !== "spawn") throw new Error("expected spawn");
    expect(env.staging_branch).toBe(`staging-${RUN_ID}`);
    expect(env.docs_branch).toBe(`docs-${RUN_ID}`);
    expect(env.base_ref).toBe("origin/develop");
    expect(env.worktree).toContain(RUN_ID);
    // FakeGitClient records: "worktree add -b docs-run-1 <path> origin/staging-run-1"
    expect(
      git.calls.some((c) => c.startsWith("worktree add") && c.includes(`-b docs-${RUN_ID}`)),
    ).toBe(true);
    expect(env.prompt).toContain(env.worktree);
    expect(env.prompt).toContain(env.base_ref);
  });

  it("is idempotent when the worktree already exists (resume): no second worktree add", async () => {
    await runDocsEmit(deps(), RUN_ID);
    const callsAfterFirst = git.calls.length;
    const second = await runDocsEmit(deps(), RUN_ID);
    expect(second.kind).toBe("spawn");
    const addsAfter = git.calls.slice(callsAfterFirst).filter((c) => c.startsWith("worktree add"));
    expect(addsAfter).toHaveLength(0);
  });
});
