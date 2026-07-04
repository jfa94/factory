import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEBUG_ISSUE_BASE,
  debugIssueNumber,
  ReportGhClient,
  buildDebugReport,
  wireDebugSpecDeps,
  type BuildDebugReportInput,
} from "./spec-source.js";
import { resolveSpec, specifiabilityGate } from "../spec/index.js";
import type { Finding } from "../verifier/judgment/finding.js";

const REPO = "owner/app";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "quality-reviewer",
    severity: "error",
    blocking: true,
    file: "src/widget.ts",
    line: 42,
    quote: "const x = maybeUndefined!;",
    claim: "a non-null assertion masks a possible undefined",
    description: "Non-null assertion silently masks a possible undefined.",
    ...overrides,
  };
}

describe("debugIssueNumber", () => {
  it("adds DEBUG_ISSUE_BASE to a positive passNumber", () => {
    expect(debugIssueNumber(1)).toBe(DEBUG_ISSUE_BASE + 1);
    expect(debugIssueNumber(7)).toBe(DEBUG_ISSUE_BASE + 7);
  });

  it("throws on passNumber < 1", () => {
    expect(() => debugIssueNumber(0)).toThrow(/positive integer/);
    expect(() => debugIssueNumber(-3)).toThrow(/positive integer/);
  });

  it("throws on a non-integer passNumber", () => {
    expect(() => debugIssueNumber(1.5)).toThrow(/positive integer/);
    expect(() => debugIssueNumber(Number.NaN)).toThrow(/positive integer/);
  });

  it("stays comfortably below any real GitHub issue number", () => {
    // GitHub issue/PR numbers are a per-repo monotonic counter; no real repo
    // is anywhere near 2 billion issues. This is the collision-avoidance
    // invariant the synthetic scheme depends on.
    expect(DEBUG_ISSUE_BASE).toBeGreaterThan(1_000_000);
  });
});

describe("ReportGhClient", () => {
  const report = { title: "Synthetic PRD title", body: "Synthetic PRD body" };

  it("returns the synthesized Prd regardless of issueNumber/opts, without any network/exec call", async () => {
    const client = new ReportGhClient(report);
    // ReportGhClient takes no injectable exec fn at all (unlike RealGhClient) —
    // there is structurally no seam for it to shell out through. Calling
    // fetchPrd with a variety of issueNumber/opts and getting a resolved
    // promise back (never a thrown "gh not found"/timeout-style error) is
    // the network-free proof.
    const prd = await client.fetchPrd(123, { repo: "some/other-repo" });
    expect(prd).toEqual({
      issue_number: 123,
      title: report.title,
      body: report.body,
      labels: ["factory-debug"],
      body_truncated: false,
    });

    const prd2 = await client.fetchPrd(DEBUG_ISSUE_BASE + 1);
    expect(prd2.issue_number).toBe(DEBUG_ISSUE_BASE + 1);
    expect(prd2.title).toBe(report.title);
    expect(prd2.body).toBe(report.body);
  });

  it("always tags the synthetic Prd with the factory-debug label", async () => {
    const client = new ReportGhClient(report);
    const prd = await client.fetchPrd(1);
    expect(prd.labels).toEqual(["factory-debug"]);
    expect(prd.body_truncated).toBe(false);
  });
});

describe("buildDebugReport", () => {
  it("renders the title with pass number + blocker count", () => {
    const input: BuildDebugReportInput = {
      confirmedBlockers: [finding(), finding({ reviewer: "silent-failure-hunter" })],
      passNumber: 2,
      base: "abc123",
    };
    const { title } = buildDebugReport(input);
    expect(title).toBe("factory debug pass 2 — 2 blocking finding(s)");
  });

  it("renders every finding's file:line and description into the body", () => {
    const f1 = finding({
      reviewer: "quality-reviewer",
      file: "src/foo.ts",
      line: 10,
      description: "Swallowed error in foo",
      quote: "catch (e) {}",
    });
    const f2 = finding({
      reviewer: "quality-reviewer",
      file: "src/bar.ts",
      line: 99,
      description: "Unsanitized input reaches a shell command",
      quote: "exec(userInput)",
    });
    const { body } = buildDebugReport({
      confirmedBlockers: [f1, f2],
      passNumber: 1,
      base: "origin/main",
    });

    expect(body).toContain("src/foo.ts:10");
    expect(body).toContain("Swallowed error in foo");
    expect(body).toContain("catch (e) {}");
    expect(body).toContain("src/bar.ts:99");
    expect(body).toContain("Unsanitized input reaches a shell command");
    expect(body).toContain("exec(userInput)");
    expect(body).toContain("origin/main");
  });

  it("groups findings by reviewer", () => {
    const { body } = buildDebugReport({
      confirmedBlockers: [
        finding({ reviewer: "quality-reviewer", file: "a.ts", line: 1 }),
        finding({ reviewer: "quality-reviewer", file: "b.ts", line: 2 }),
        finding({ reviewer: "silent-failure-hunter", file: "c.ts", line: 3 }),
      ],
      passNumber: 1,
      base: "main",
    });
    expect(body).toContain("## quality-reviewer");
    expect(body).toContain("## silent-failure-hunter");
    // Only one quality-reviewer section header, even though it has 2 findings.
    expect(body.split("## quality-reviewer").length - 1).toBe(1);
  });

  it("handles zero confirmed blockers without throwing", () => {
    const { title, body } = buildDebugReport({
      confirmedBlockers: [],
      passNumber: 3,
      base: "main",
    });
    expect(title).toBe("factory debug pass 3 — 0 blocking finding(s)");
    expect(body).toContain("no confirmed blockers");
  });

  it("renders findings with no citation gracefully", () => {
    const { body } = buildDebugReport({
      confirmedBlockers: [finding({ file: undefined, line: undefined })],
      passNumber: 1,
      base: "main",
    });
    expect(body).toContain("(no citation)");
  });

  it("Δ S9: the synthetic PRD passes the specifiability gate (universal gate, no bypass)", () => {
    const { body } = buildDebugReport({
      confirmedBlockers: [finding()],
      passNumber: 1,
      base: "origin/main",
    });
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- The finding at src/widget.ts:42 (error, quality-reviewer) is fixed.");
    const r = specifiabilityGate(body);
    expect(r.passed).toBe(true);
    expect(r.blockers).toEqual([]);
  });
});

describe("wireDebugSpecDeps", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "debug-spec-source-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("wires a SpecBuildDeps with a ReportGhClient seeded from the report", async () => {
    const report = { title: "T", body: "B" };
    const deps = wireDebugSpecDeps(report, dataDir);
    expect(deps.dataDir).toBe(dataDir);
    expect(deps.gh).toBeInstanceOf(ReportGhClient);
    const prd = await deps.gh.fetchPrd(999);
    expect(prd.title).toBe("T");
    expect(prd.body).toBe("B");
  });
});

describe("integration: resolveSpec accepts wireDebugSpecDeps unchanged", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "debug-spec-source-integration-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("resolveSpec(wireDebugSpecDeps(report), repo, debugIssueNumber(1)) emits a generate envelope whose spawn.context reflects the synthetic Prd", async () => {
    const report = buildDebugReport({
      confirmedBlockers: [
        finding({
          reviewer: "quality-reviewer",
          file: "src/thing.ts",
          line: 17,
          description: "Off-by-one in the loop bound",
          quote: "for (let i = 0; i <= arr.length; i++)",
        }),
      ],
      passNumber: 1,
      base: "origin/main",
    });

    const deps = wireDebugSpecDeps(report, dataDir);
    const issue = debugIssueNumber(1);
    const env = await resolveSpec(deps, REPO, issue);

    expect(env.kind).toBe("generate");
    if (env.kind !== "generate") throw new Error("unreachable");

    expect(env.issue).toBe(DEBUG_ISSUE_BASE + 1);
    expect(env.spawn.role).toBe("spec-generator");
    expect(env.spawn.context.issue_number).toBe(issue);
    expect(env.spawn.context.title).toBe(report.title);
    expect(env.spawn.context.body).toBe(report.body);
    expect(env.spawn.context.body).toContain("src/thing.ts:17");
    expect(env.spawn.context.labels).toEqual(["factory-debug"]);

    // prd.json was persisted for the (not-run-here) gate step, from the
    // synthetic Prd — proving resolveSpec's on-disk contract works unchanged
    // against a ReportGhClient just as it would against RealGhClient.
    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(env.prd_path, "utf8")) as {
      issue_number: number;
      title: string;
    };
    expect(persisted.issue_number).toBe(issue);
    expect(persisted.title).toBe(report.title);
  });
});
