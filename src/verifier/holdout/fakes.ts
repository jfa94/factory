/**
 * WS10 (holdout) — exported fakes for the driver loop tests + downstream units.
 * A deterministic holdout-validator boundary so the verify path is exercisable
 * without a real Agent() spawn.
 */
import type { HoldoutValidateInput, HoldoutValidatorRunner, HoldoutVerdict } from "./validate.js";

/** How a {@link FakeHoldoutValidatorRunner} verdicts each withheld criterion. */
export type FakeHoldoutMode = "all-pass" | "all-fail" | ((criterion: string) => boolean);

/**
 * A deterministic holdout-validator: echoes one verdict per withheld criterion
 * per the configured mode. `all-pass` credits every criterion (satisfied + non-
 * blank evidence); `all-fail` fails every one (blank evidence ⇒ not credited even
 * if marked satisfied — exercises the anti-spoof guard); a predicate decides per
 * criterion.
 */
export class FakeHoldoutValidatorRunner implements HoldoutValidatorRunner {
  constructor(private readonly mode: FakeHoldoutMode = "all-pass") {}

  validate(input: HoldoutValidateInput): Promise<readonly HoldoutVerdict[]> {
    const decide = (c: string): boolean =>
      typeof this.mode === "function" ? this.mode(c) : this.mode === "all-pass";
    return Promise.resolve(
      input.withheldCriteria.map((criterion) => {
        const satisfied = decide(criterion);
        return {
          criterion,
          satisfied,
          evidence: satisfied ? `verified in ${input.worktree}` : "",
        };
      }),
    );
  }
}
