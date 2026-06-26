import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../core/state/manager.js";
import { defaultConfig } from "../config/schema.js";
import { FakeGitClient } from "../git/fakes.js";
import { runDocsEmit, runDocsRecord, type DocsRunDeps } from "./docs.js";

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

describe("runDocsRecord", () => {
  it("DONE → ff-merges docs into staging, pushes, removes worktree, marks docs done", async () => {
    await runDocsEmit(deps(), RUN_ID); // create the worktree first
    const env = await runDocsRecord(deps(), RUN_ID, { status: "STATUS: DONE" });
    expect(env.kind).toBe("done");
    // FakeGitClient: mergeFfOrCommit(staging, docsBranch) → mergesInto[staging] = [docsBranch]
    expect(git.mergesInto[`staging-${RUN_ID}`]).toContain(`docs-${RUN_ID}`);
    expect(git.calls.some((c) => c === `push origin staging-${RUN_ID}`)).toBe(true);
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    const run = await state.read(RUN_ID);
    expect(run.docs?.status).toBe("done");
    expect(run.status).not.toBe("suspended");
    // nowIso() must stamp ended_at; a refactor dropping it would go undetected.
    expect(run.docs?.ended_at).toBeDefined();
    expect(run.docs?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("non-DONE → suspends the run, records the failure reason, never pushes", async () => {
    await runDocsEmit(deps(), RUN_ID);
    const env = await runDocsRecord(deps(), RUN_ID, {
      status: "STATUS: BLOCKED — ESCALATE missing context",
    });
    expect(env.kind).toBe("suspend");
    if (env.kind !== "suspend") throw new Error("expected blocked");
    expect(env.reason).toContain("BLOCKED");
    const run = await state.read(RUN_ID);
    expect(run.status).toBe("suspended");
    expect(run.docs?.status).toBe("failed");
    expect(run.docs?.reason).toContain("BLOCKED");
    // nowIso() must stamp ended_at on the failure path too.
    expect(run.docs?.ended_at).toBeDefined();
    expect(run.docs?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(git.calls.some((c) => c.startsWith("push"))).toBe(false);
  });

  // Group-2-D: attempts cap prevents an infinite suspend-loop on persistent docs failure.
  it("D: attempts counter increments on first failure (attempts: 1, still suspend)", async () => {
    await runDocsEmit(deps(), RUN_ID);
    const env = await runDocsRecord(deps(), RUN_ID, { status: "STATUS: ERROR" });
    expect(env.kind).toBe("suspend");
    const run = await state.read(RUN_ID);
    expect(run.docs?.attempts).toBe(1);
  });

  it("D: at cap (2nd failure) returns done instead of suspending — docs best-effort", async () => {
    await runDocsEmit(deps(), RUN_ID);
    // First failure → suspend, attempts: 1
    const first = await runDocsRecord(deps(), RUN_ID, { status: "STATUS: ERROR" });
    expect(first.kind).toBe("suspend");
    // Simulate resume: run returns to running for the second attempt
    await state.update(RUN_ID, (s) => ({ ...s, status: "running" as const }));
    // Second failure → cap hit → done (not suspended)
    const second = await runDocsRecord(deps(), RUN_ID, { status: "STATUS: ERROR again" });
    expect(second.kind).toBe("done");
    const run = await state.read(RUN_ID);
    // Status is NOT suspended — the caller (runner) will finalize normally.
    expect(run.status).not.toBe("suspended");
    expect(run.docs?.status).toBe("failed");
    expect(run.docs?.attempts).toBe(2);
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
    const first = await runDocsEmit(deps(), RUN_ID);
    const callsAfterFirst = git.calls.length;
    const second = await runDocsEmit(deps(), RUN_ID);
    expect(second.kind).toBe("spawn");
    const addsAfter = git.calls.slice(callsAfterFirst).filter((c) => c.startsWith("worktree add"));
    expect(addsAfter).toHaveLength(0);
    // resume returns an identical spawn request, not merely *a* spawn envelope.
    if (first.kind !== "spawn" || second.kind !== "spawn") throw new Error("expected spawn");
    expect(second.staging_branch).toBe(first.staging_branch);
    expect(second.docs_branch).toBe(first.docs_branch);
    expect(second.base_ref).toBe(first.base_ref);
    expect(second.worktree).toBe(first.worktree);
  });
});
