/**
 * `factory record-reviews` (C5) — arg/usage edges via {@link recordReviewsCommand}.
 *
 * The apply-level fold tests (applyRecordReviews semantics) live in
 * src/driver/fold.test.ts alongside the other fold cores.
 */
import { describe, it, expect } from "vitest";

import { recordReviewsCommand } from "./record-reviews.js";
import { EXIT } from "../exit-codes.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";

describe("record-reviews arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--task", TASK_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --task is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--run", RUN_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --input is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--run", RUN_ID, "--task", TASK_ID])).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordReviewsCommand.run(["--help"])).toBe(EXIT.OK);
  });
});
