import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DefaultGhClient, parseGhJson } from "./gh-client.js";
import type { ExecResult } from "../shared/index.js";
import type { GhRunner } from "./exec-tools.js";

function result(over: Partial<ExecResult>): ExecResult {
  return { stdout: "", stderr: "", code: 0, signal: null, truncated: false, ...over };
}

describe("gh truncation safety (reuses ExecResult.truncated seam)", () => {
  it("parseGhJson FAILS LOUD when truncated, rather than parsing a clipped payload", () => {
    const clipped = result({ stdout: '[{"number":1,', truncated: true });
    expect(() => parseGhJson(clipped, z.array(z.unknown()), "gh pr list")).toThrow(/TRUNCATED/);
  });

  it("prList throws on a truncated payload (would otherwise mis-read 'no PR exists')", async () => {
    const runner: GhRunner = async () =>
      result({ stdout: '[{"number":1,"headRefName":"b",', truncated: true });
    const gh = new DefaultGhClient(runner);
    await expect(gh.prList({ head: "factory/run-1/t1" })).rejects.toThrow(/TRUNCATED/);
  });

  it("prList parses a well-formed payload when not truncated", async () => {
    const runner: GhRunner = async () =>
      result({
        stdout: JSON.stringify([
          {
            number: 5,
            headRefName: "factory/run-1/t1",
            baseRefName: "staging",
            state: "OPEN",
          },
        ]),
      });
    const gh = new DefaultGhClient(runner);
    const prs = await gh.prList({ head: "factory/run-1/t1" });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(5);
  });

  it("repoProtection maps a 404 to enabled:false (a normal answer, not an error)", async () => {
    const runner: GhRunner = async (args) => {
      // protection endpoint → 404; rulesets endpoint → also absent
      if (args.includes("rules")) return result({ code: 1, stderr: "Not Found (404)" });
      return result({ code: 1, stderr: "HTTP 404: Branch not protected" });
    };
    const gh = new DefaultGhClient(runner);
    const state = await gh.repoProtection("o", "r", "staging");
    expect(state.enabled).toBe(false);
    expect(state.strictUpToDate).toBe(false);
  });

  it("repoProtection throws on a non-404 failure (auth/network is NOT silently 'unprotected')", async () => {
    const runner: GhRunner = async () => result({ code: 1, stderr: "HTTP 401: Bad credentials" });
    const gh = new DefaultGhClient(runner);
    await expect(gh.repoProtection("o", "r", "staging")).rejects.toThrow(/401|failed/i);
  });

  it("prCreate parses the PR number from the emitted URL", async () => {
    const runner: GhRunner = async (args) => {
      expect(args[0]).toBe("pr");
      expect(args[1]).toBe("create");
      return result({ stdout: "https://github.com/o/r/pull/123\n" });
    };
    const gh = new DefaultGhClient(runner);
    const created = await gh.prCreate({ base: "staging", head: "b", title: "t", body: "b" });
    expect(created.number).toBe(123);
  });
});
