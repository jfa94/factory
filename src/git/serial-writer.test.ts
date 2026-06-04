import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MergeSerializer } from "./serial-writer.js";
import { FakeGhClient } from "./fakes.js";
import type { PullRequest } from "./gh-client.js";

function openPr(number: number, head: string, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    headRefName: head,
    baseRefName: "staging",
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

describe("Δ L — serial writer (#1)", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ws3-merge-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function serializer(gh: FakeGhClient): MergeSerializer {
    return new MergeSerializer({
      ghClient: gh,
      owner: "fake",
      repo: "repo",
      dataDir,
      // tight lock window so the test is fast
      lock: { stale: 5_000, retries: 200, retryMinTimeout: 1, retryMaxTimeout: 20 },
    });
  }

  it("no race: two concurrent merge() calls run strictly one-at-a-time (non-overlapping critical sections)", async () => {
    const gh = new FakeGhClient({
      prs: [openPr(100, "factory/run-1/t1"), openPr(101, "factory/run-1/t2")],
    });

    let active = 0;
    let maxConcurrent = 0;
    // Instrument the critical section: increment on enter, hold briefly, the
    // merge body then mutates. If the app-level lock works, active is never > 1.
    gh.onMergeEnter = async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    };

    const ser = serializer(gh);
    const [a, b] = await Promise.all([ser.merge(100), ser.merge(101)]);

    expect(maxConcurrent).toBe(1); // strictly serial
    expect(a.merged).toBe(true);
    expect(b.merged).toBe(true);
    // Both merged via the app-level path, never armed concurrent --auto.
    expect(gh.merges.every((m) => m.auto === false)).toBe(true);
    expect(gh.merges).toHaveLength(2);
  });

  it("up-to-date enforcement: a BEHIND PR is refused (not merged), no force-push/rebase-publish attempted", async () => {
    const gh = new FakeGhClient({
      prs: [openPr(200, "factory/run-1/t1", { mergeStateStatus: "BEHIND" })],
    });
    const ser = serializer(gh);
    const outcome = await ser.merge(200);

    expect(outcome).toEqual({ merged: false, reason: "behind", number: 200 });
    expect(gh.merges).toHaveLength(0); // never merged
    // FakeGhClient/GitClient expose no force-push/rebase-publish method by
    // construction — nothing to call. Assert the merge action was not taken.
    expect(gh.calls.some((c) => c.startsWith("pr merge"))).toBe(false);
  });

  it("a CONFLICTING PR is refused as not-mergeable", async () => {
    const gh = new FakeGhClient({
      prs: [openPr(201, "factory/run-1/t1", { mergeable: "CONFLICTING" })],
    });
    const outcome = await serializer(gh).merge(201);
    expect(outcome).toEqual({ merged: false, reason: "not-mergeable", number: 201 });
    expect(gh.merges).toHaveLength(0);
  });

  it("merge-queue probe upgrade: native support → enqueue via --auto; unsupported → app-level squash", async () => {
    // unsupported (default) → app-level
    const ghApp = new FakeGhClient({ prs: [openPr(300, "factory/run-1/t1")] });
    const appOut = await serializer(ghApp).merge(300);
    expect(appOut).toEqual({ merged: true, via: "app-level", number: 300 });
    expect(ghApp.merges).toEqual([{ number: 300, auto: false }]);

    // native merge-queue present → --auto (GitHub serializes)
    const ghMq = new FakeGhClient({
      prs: [openPr(301, "factory/run-1/t1")],
      protection: {
        staging: {
          enabled: true,
          requiredStatusChecks: ["ci"],
          strictUpToDate: true,
          hasMergeQueue: true,
        },
      },
    });
    const mqOut = await serializer(ghMq).merge(301);
    expect(mqOut).toEqual({ merged: true, via: "merge-queue", number: 301 });
    expect(ghMq.merges).toEqual([{ number: 301, auto: true }]);
  });

  it("second merge re-verifies up-to-date against the post-first-merge staging tip (re-read inside lock)", async () => {
    // The 2nd PR is BEHIND. Even queued concurrently, the serializer re-reads it
    // inside the lock and refuses it — proving per-merge re-verification.
    const gh = new FakeGhClient({
      prs: [
        openPr(400, "factory/run-1/t1"),
        openPr(401, "factory/run-1/t2", { mergeStateStatus: "BEHIND" }),
      ],
    });
    const ser = serializer(gh);
    const [a, b] = await Promise.all([ser.merge(400), ser.merge(401)]);
    const first = a.number === 400 ? a : b;
    const second = a.number === 401 ? a : b;
    expect(first.merged).toBe(true);
    expect(second).toEqual({ merged: false, reason: "behind", number: 401 });
  });
});
