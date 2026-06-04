import { describe, it, expect, vi } from "vitest";
import { RealGhClient, GhAuthError, IssueNotFoundError, type ExecFn } from "./gh.js";
import type { ExecResult } from "../types/index.js";

function execResult(over: Partial<ExecResult>): ExecResult {
  return { stdout: "", stderr: "", code: 0, signal: null, truncated: false, ...over };
}

/** A fake exec that never spawns the real binary. */
function fakeExec(result: ExecResult): ExecFn {
  return vi.fn(async () => result);
}

describe("RealGhClient — isolation + loud failures", () => {
  it("parses a faked exec result into a Prd without invoking the real binary", async () => {
    const exec = fakeExec(
      execResult({
        stdout: JSON.stringify({
          number: 42,
          title: "Checkout Redesign",
          body: "Users must check out.",
          labels: [{ name: "prd" }, { name: "p1" }],
        }),
      }),
    );
    const client = new RealGhClient({ exec });
    const prd = await client.fetchPrd(42, { repo: "owner/name" });

    expect(prd.issue_number).toBe(42);
    expect(prd.title).toBe("Checkout Redesign");
    expect(prd.body).toBe("Users must check out.");
    expect(prd.labels).toEqual(["prd", "p1"]);
    expect(prd.body_truncated).toBe(false);
    // Confirm the fake (not the real gh) was used, with the expected argv.
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = (exec as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(cmd).toBe("gh");
    expect(args).toContain("issue");
    expect(args).toContain("--repo");
  });

  it("gh-not-authed surfaces a distinct GhAuthError (loud)", async () => {
    const exec = fakeExec(
      execResult({
        code: 1,
        stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
      }),
    );
    const client = new RealGhClient({ exec });
    await expect(client.fetchPrd(42)).rejects.toBeInstanceOf(GhAuthError);
  });

  it("issue-not-found surfaces a distinct IssueNotFoundError (loud)", async () => {
    const exec = fakeExec(
      execResult({
        code: 1,
        stderr: "GraphQL: Could not resolve to an Issue with the number of 999.",
      }),
    );
    const client = new RealGhClient({ exec });
    const err = await client.fetchPrd(999).catch((e) => e);
    expect(err).toBeInstanceOf(IssueNotFoundError);
    expect((err as IssueNotFoundError).issueNumber).toBe(999);
  });

  it("auth vs not-found are DISTINCT error types (not conflated)", async () => {
    const authClient = new RealGhClient({
      exec: fakeExec(execResult({ code: 1, stderr: "requires authentication" })),
    });
    const nfClient = new RealGhClient({
      exec: fakeExec(execResult({ code: 1, stderr: "Could not resolve to an Issue" })),
    });
    await expect(authClient.fetchPrd(1)).rejects.toBeInstanceOf(GhAuthError);
    await expect(nfClient.fetchPrd(1)).rejects.toBeInstanceOf(IssueNotFoundError);
    await expect(nfClient.fetchPrd(1)).rejects.not.toBeInstanceOf(GhAuthError);
  });

  it("throws loudly on truncated output (never parses a clipped payload)", async () => {
    const exec = fakeExec(execResult({ stdout: '{"number":1,"title":"x"', truncated: true }));
    const client = new RealGhClient({ exec });
    await expect(client.fetchPrd(1)).rejects.toThrow(/truncated/);
  });

  it("caps an oversized body and flags body_truncated", async () => {
    const exec = fakeExec(
      execResult({
        stdout: JSON.stringify({ number: 1, title: "t", body: "x".repeat(100), labels: [] }),
      }),
    );
    const client = new RealGhClient({ exec, bodyMaxBytes: 10 });
    const prd = await client.fetchPrd(1);
    expect(prd.body_truncated).toBe(true);
    expect(Buffer.byteLength(prd.body, "utf8")).toBeLessThanOrEqual(10);
  });

  it("throws on a missing/empty title in the response", async () => {
    const exec = fakeExec(execResult({ stdout: JSON.stringify({ number: 1, body: "b" }) }));
    const client = new RealGhClient({ exec });
    await expect(client.fetchPrd(1)).rejects.toThrow(/title/);
  });

  it("rejects a non-positive issue number before spawning", async () => {
    const exec = fakeExec(execResult({}));
    const client = new RealGhClient({ exec });
    await expect(client.fetchPrd(0)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("accepts plain-string labels as well as {name} objects", async () => {
    const exec = fakeExec(
      execResult({
        stdout: JSON.stringify({ number: 1, title: "t", body: "b", labels: ["a", "b"] }),
      }),
    );
    const prd = await new RealGhClient({ exec }).fetchPrd(1);
    expect(prd.labels).toEqual(["a", "b"]);
  });
});
