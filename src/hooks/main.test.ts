import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchHook, hookRegistry } from "./main.js";
import { EXIT } from "../cli/exit-codes.js";

describe("hook dispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("--help returns OK", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await dispatchHook(["--help"])).toBe(EXIT.OK);
    expect(await dispatchHook([])).toBe(EXIT.OK);
  });

  it("unknown hook returns USAGE (2) — fail-loud dispatch", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await dispatchHook(["nope"])).toBe(EXIT.USAGE);
  });

  it("registry is an extensible seam (each guard registered by name → module)", async () => {
    // WS9 registers the real guards; the seam stays extensible.
    expect(Object.keys(hookRegistry).sort()).toEqual([
      "branch-protection",
      "holdout-guard",
      "pipeline-guards",
      "secret-guard",
      "subagent-stop",
      "write-protection",
    ]);
    hookRegistry["__test-hook"] = { describe: "t", run: () => EXIT.OK };
    try {
      expect(await dispatchHook(["__test-hook"])).toBe(EXIT.OK);
    } finally {
      delete hookRegistry["__test-hook"];
    }
  });
});
