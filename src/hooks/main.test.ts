import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchHook, hookRegistry } from "./main.js";
import { EXIT } from "../cli/exit-codes.js";

describe("hook dispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("branch-protection (WS0 stub) returns OK", async () => {
    expect(await dispatchHook(["branch-protection"])).toBe(EXIT.OK);
  });

  it("--help returns OK", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await dispatchHook(["--help"])).toBe(EXIT.OK);
    expect(await dispatchHook([])).toBe(EXIT.OK);
  });

  it("unknown hook returns USAGE (2)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await dispatchHook(["nope"])).toBe(EXIT.USAGE);
  });

  it("registry is an extensible seam (WS9 extends)", async () => {
    hookRegistry["__test-hook"] = { describe: "t", run: () => EXIT.OK };
    try {
      expect(await dispatchHook(["__test-hook"])).toBe(EXIT.OK);
    } finally {
      delete hookRegistry["__test-hook"];
    }
  });
});
