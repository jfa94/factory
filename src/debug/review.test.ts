import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PANEL_ROLES } from "../verifier/judgment/panel.js";
import { buildReviewManifest, adjudicateWholeScope } from "./review.js";

describe("buildReviewManifest", () => {
  it("bundles buildPanelManifest's request with the debug-specific diff-scope fields", () => {
    const result = buildReviewManifest({
      resumePhase: "verify",
      model: "opus",
      maxTurns: 40,
      base: "origin/main",
      worktree: "/tmp/debug-worktree",
      codexAvailable: true,
    });

    expect(result.base).toBe("origin/main");
    expect(result.worktree).toBe("/tmp/debug-worktree");
    expect(result.codexAvailable).toBe(true);
    expect(result.manifest.resume_phase).toBe("verify");
    const roles = result.manifest.agents.map((a) => a.role).sort();
    expect(roles).toEqual([...PANEL_ROLES].sort());
    const models = new Set(result.manifest.agents.map((a) => a.model));
    expect([...models]).toEqual(["opus"]);
    const turns = new Set(result.manifest.agents.map((a) => a.max_turns));
    expect([...turns]).toEqual([40]);
  });

  it("passes codexAvailable=false through unchanged", () => {
    const result = buildReviewManifest({
      resumePhase: "verify",
      model: "opus",
      maxTurns: 40,
      base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", // empty-tree SHA
      worktree: "/tmp/debug-worktree-2",
      codexAvailable: false,
    });
    expect(result.codexAvailable).toBe(false);
    expect(result.base).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("delegates validation to buildPanelManifest — a blank model fails LOUD, no new validation logic added", () => {
    expect(() =>
      buildReviewManifest({
        resumePhase: "verify",
        model: "",
        maxTurns: 40,
        base: "origin/main",
        worktree: "/tmp/debug-worktree",
        codexAvailable: true,
      }),
    ).toThrow();
  });
});

describe("adjudicateWholeScope", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "factory-debug-review-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  async function writeWorktreeFile(relPath: string, contents: string): Promise<void> {
    const abs = join(worktree, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }

  function approve(reviewer: string): unknown {
    return { reviewer, verdict: "approve", findings: [] };
  }

  function blockedWith(reviewer: string, file: string, line: number, quote: string): unknown {
    return {
      reviewer,
      verdict: "blocked",
      findings: [
        {
          reviewer,
          severity: "critical",
          blocking: true,
          file,
          line,
          quote,
          description: "issue",
        },
      ],
    };
  }

  it("a clean pass: every reviewer approves → clean: true, no confirmed blockers", async () => {
    const result = await adjudicateWholeScope({
      reviews: [approve("quality-reviewer"), approve("security-reviewer")],
      verifications: [],
      worktree,
    });

    expect(result.clean).toBe(true);
    expect(result.confirmedBlockers).toEqual([]);
    expect(result.adjudicated).toHaveLength(2);
    expect(result.adjudicated.every((a) => a.rawVerdict === "approve")).toBe(true);
  });

  it("a confirmed blocker: clean: false, and the blocker is present in confirmedBlockers", async () => {
    await writeWorktreeFile("src/x.ts", "line1\nconst x = 1\nline3\n");

    const result = await adjudicateWholeScope({
      reviews: [
        approve("security-reviewer"),
        blockedWith("quality-reviewer", "src/x.ts", 2, "const x = 1"),
      ],
      verifications: [
        {
          reviewer: "quality-reviewer",
          verdicts: [{ file: "src/x.ts", line: 2, holds: true, note: "confirmed" }],
        },
      ],
      worktree,
    });

    expect(result.clean).toBe(false);
    expect(result.confirmedBlockers).toHaveLength(1);
    expect(result.confirmedBlockers[0]?.description).toBe("issue");
    const quality = result.adjudicated.find((a) => a.reviewer === "quality-reviewer");
    expect(quality?.confirmedBlockers).toHaveLength(1);
    expect(quality?.hadVerifierError).toBe(false);
  });

  it("a refuted finding does NOT appear in confirmedBlockers", async () => {
    await writeWorktreeFile("src/y.ts", "line1\nconst y = 1\nline3\n");

    const result = await adjudicateWholeScope({
      reviews: [blockedWith("quality-reviewer", "src/y.ts", 2, "const y = 1")],
      verifications: [
        {
          reviewer: "quality-reviewer",
          verdicts: [{ file: "src/y.ts", line: 2, holds: false, note: "does not hold" }],
        },
      ],
      worktree,
    });

    expect(result.clean).toBe(true);
    expect(result.confirmedBlockers).toEqual([]);
    const quality = result.adjudicated.find((a) => a.reviewer === "quality-reviewer");
    expect(quality?.confirmedBlockers).toEqual([]);
    expect(quality?.hadVerifierError).toBe(false);
  });

  it("a verifier error outcome surfaces via adjudicated[].hadVerifierError — never a silent pass", async () => {
    await writeWorktreeFile("src/z.ts", "line1\nconst z = 1\nline3\n");

    const result = await adjudicateWholeScope({
      reviews: [blockedWith("quality-reviewer", "src/z.ts", 2, "const z = 1")],
      // No pre-recorded verdict for this citation → the replay runner rejects,
      // which confirmBlocker turns into an `error` outcome (fail-closed).
      verifications: [],
      worktree,
    });

    expect(result.clean).toBe(true); // an `error` is not a confirmed blocker …
    expect(result.confirmedBlockers).toEqual([]);
    const quality = result.adjudicated.find((a) => a.reviewer === "quality-reviewer");
    // … but it is NOT silently dropped: it is loudly flagged on hadVerifierError.
    expect(quality?.hadVerifierError).toBe(true);
  });

  it("an unparseable raw review throws (LOUD, never silently skipped)", async () => {
    await expect(
      adjudicateWholeScope({
        reviews: [{ reviewer: "quality-reviewer", verdict: "not-a-real-verdict", findings: [] }],
        verifications: [],
        worktree,
      }),
    ).rejects.toThrow();
  });

  it("does not surface mergeGate or result on its return shape", async () => {
    const result = await adjudicateWholeScope({
      reviews: [approve("quality-reviewer")],
      verifications: [],
      worktree,
    });
    expect(result).not.toHaveProperty("mergeGate");
    expect(result).not.toHaveProperty("result");
  });
});
