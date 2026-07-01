import { describe, expect, it } from "vitest";
import { FakeGhClient } from "./fakes.js";
import type { PullRequest } from "./gh-client.js";
import { rollup, type RollupArgs } from "./rollup.js";

/** A seeded OPEN rollup PR (head=staging → base=develop). */
function openRollupPr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    headRefName: "staging",
    baseRefName: "develop",
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    url: `https://github.com/o/r/pull/${number}`,
    ...over,
  };
}

/** Common rollup args with a no-op (counting) sleep so tests never wait. */
function makeArgs(gh: FakeGhClient, over: Partial<RollupArgs> & { sleeps?: { n: number } } = {}) {
  const counter = over.sleeps ?? { n: 0 };
  const { sleeps: _omit, ...rest } = over;
  const args: RollupArgs = {
    ghClient: gh,
    stagingBranch: "staging",
    baseBranch: "develop",
    title: "Rollup run-1",
    body: "## report",
    merge: true,
    sleep: async () => {
      counter.n += 1;
    },
    ...rest,
  };
  return { args, sleeps: counter };
}

describe("rollup — open + full-CI gate + squash-merge (§④, Δ S)", () => {
  it("complete run: creates the staging→develop PR and squash-merges with the plain title", async () => {
    const gh = new FakeGhClient(); // default checks = passing
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({
      merged: true,
      resumed: false,
      subject: "Rollup run-1",
      ci: "passing",
    });
    expect(gh.created).toEqual([
      { base: "develop", head: "staging", title: "Rollup run-1", body: "## report" },
    ]);
    expect(gh.merges).toHaveLength(1);
    expect(gh.merges[0]).toMatchObject({ number: r.number, subject: "Rollup run-1" });
  });

  it("no-merge cutover mode: opens the PR but never merges", async () => {
    const gh = new FakeGhClient();
    const { args } = makeArgs(gh, { merge: false });
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: false, reason: "no-merge", resumed: false });
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toHaveLength(0); // never merged
    expect(gh.calls).not.toContain(`pr checks ${r.number}`); // CI not even awaited
  });

  it("CI failing: refuses to merge (no merge recorded)", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(44)] });
    gh.setChecks(44, "failing");
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: false, reason: "ci-failing", ci: "failing", resumed: true });
    expect(gh.merges).toHaveLength(0);
  });

  it("CI pending past the poll budget: ci-timeout, never merges, slept between polls", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(43)] });
    gh.setChecks(43, "pending"); // sticks forever
    const { args, sleeps } = makeArgs(gh, { maxPolls: 3 });
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: false, reason: "ci-timeout", ci: "pending" });
    expect(gh.merges).toHaveLength(0);
    expect(sleeps.n).toBe(2); // 3 polls → 2 sleeps between them
  });

  it("CI converges (pending → passing): polls until green then merges", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(42)] });
    gh.setChecks(42, "pending", "passing"); // pending once, then passing
    const { args, sleeps } = makeArgs(gh, { maxPolls: 5 });
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: true, ci: "passing", resumed: true });
    expect(gh.merges).toHaveLength(1);
    expect(gh.calls.filter((c) => c === "pr checks 42")).toHaveLength(2);
    expect(sleeps.n).toBe(1);
  });

  it("no checks configured (none): nothing to gate → merges", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(46)] });
    gh.setChecks(46, "none");
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: true, ci: "none" });
    expect(gh.merges).toHaveLength(1);
  });

  it("CONFLICTING PR: CI green but not mergeable → not-mergeable", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(45, { mergeable: "CONFLICTING" })] });
    const { args } = makeArgs(gh); // default checks passing
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: false, reason: "not-mergeable", ci: "passing" });
    expect(gh.merges).toHaveLength(0);
  });
});

describe("rollup — D3: base branch policy fallback to --auto (surgical, not unconditional)", () => {
  it("an unprotected repo merges immediately, WITHOUT --auto (regression guard)", async () => {
    const gh = new FakeGhClient(); // no failMergeSquashUnlessAuto set — merge just works
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: true });
    expect(gh.merges[0]).toMatchObject({ auto: false });
  });

  it("'base branch policy prohibits the merge' → retries once with --auto → merged:false, reason:'auto-armed'", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(50)] });
    gh.failMergeSquashUnlessAuto = new Error(
      "GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge. (mergePullRequest)",
    );
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ merged: false, reason: "auto-armed", ci: "passing" });
    // Exactly one successful merge call recorded — the auto retry (the plain
    // attempt threw before FakeGhClient ever records a `calls`/`merges` entry).
    expect(gh.merges).toHaveLength(1);
    expect(gh.merges[0]).toMatchObject({ number: 50, auto: true });
  });

  it("a genuinely different merge failure (not the branch-policy text) still throws — no silent fallback", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(51)] });
    gh.failMergeSquashUnlessAuto = new Error("HTTP 401: Bad credentials");
    const { args } = makeArgs(gh);

    await expect(rollup(args)).rejects.toThrow(/Bad credentials/);
    expect(gh.merges).toHaveLength(0);
  });
});

describe("rollup — idempotent / resume-safe", () => {
  it("resumes an existing OPEN rollup PR (no duplicate create)", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(47)] });
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ number: 47, resumed: true, merged: true });
    expect(gh.created).toHaveLength(0); // never created a duplicate
    expect(gh.merges).toHaveLength(1);
  });

  it("short-circuits when the rollup PR is already MERGED (re-create would fail)", async () => {
    const gh = new FakeGhClient({ prs: [openRollupPr(48, { state: "MERGED" })] });
    const { args } = makeArgs(gh);
    const r = await rollup(args);

    expect(r).toMatchObject({ number: 48, resumed: true, merged: true });
    expect(r.subject).toBe("Rollup run-1"); // plain title — no PARTIAL: prefix
    expect(gh.created).toHaveLength(0);
    expect(gh.merges).toHaveLength(0); // not merged twice
  });
});

describe("rollup — main guard (D16)", () => {
  it("refuses to target main", async () => {
    const gh = new FakeGhClient();
    const { args } = makeArgs(gh, { baseBranch: "main" });
    await expect(rollup(args)).rejects.toThrow(/must not be 'main'/);
  });
});
