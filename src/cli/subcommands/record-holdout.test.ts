/**
 * `factory record-holdout` (C5) — arg/usage edges via {@link recordHoldoutCommand}.
 *
 * The apply-level fold tests (applyRecordHoldout semantics) live in
 * src/driver/fold.test.ts alongside the other fold cores.
 */
import { describe, it, expect } from "vitest";

import { recordHoldoutCommand } from "./record-holdout.js";
import { EXIT } from "../exit-codes.js";

const RUN_ID = "run-1";

describe("record-holdout arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--task", "t1", "--input", "/x.json"])).toBe(EXIT.USAGE);
  });
  it("missing --task is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--run", RUN_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --input is a usage error", async () => {
    expect(await recordHoldoutCommand.run(["--run", RUN_ID, "--task", "t1"])).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordHoldoutCommand.run(["--help"])).toBe(EXIT.OK);
  });
});
