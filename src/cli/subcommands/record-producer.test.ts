/**
 * `factory record-producer` (C5) — arg/usage edges only.
 *
 * The apply-level fold cases (applyRecordProducer) live in
 * src/driver/fold.test.ts so Phase-2 shell deletion cannot drop them.
 */
import { describe, it, expect } from "vitest";

import { recordProducerCommand } from "./record-producer.js";
import { EXIT } from "../exit-codes.js";

const RUN_ID = "run-1";

describe("record-producer arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--task", "t1", "--stage", "exec", "--status", "DONE"]),
    ).toBe(EXIT.USAGE);
  });
  it("missing --stage is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--run", RUN_ID, "--task", "t1", "--status", "DONE"]),
    ).toBe(EXIT.USAGE);
  });
  it("missing --status is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--run", RUN_ID, "--task", "t1", "--stage", "exec"]),
    ).toBe(EXIT.USAGE);
  });
  it("a non-producer --stage (verify) is a usage error", async () => {
    expect(
      await recordProducerCommand.run([
        "--run",
        RUN_ID,
        "--task",
        "t1",
        "--stage",
        "verify",
        "--status",
        "DONE",
      ]),
    ).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordProducerCommand.run(["--help"])).toBe(EXIT.OK);
  });
});
