import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../core/state/manager.js";
import { defaultConfig } from "../config/schema.js";
import { FakeGitClient } from "../git/fakes.js";
import { runDocsEmit, type DocsRunDeps } from "./docs.js";

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
