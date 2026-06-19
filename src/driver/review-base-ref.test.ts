/**
 * Fix 2 regression guard — the review/holdout base ref must be the PER-RUN staging
 * branch the worktree forked from (`origin/staging-<run-id>`), never a hardcoded
 * `origin/staging`. A bare `origin/staging` namespace-collides after a repo branch
 * rename and resolves to the wrong (or no) commit, silently diffing reviewers against
 * the wrong base — root cause #2 of the PRD-2d stall.
 *
 * This scans the static review SURFACES (the reviewer system-prompts + both driver
 * templates) because they are markdown/JS that the TS typechecker never sees: only a
 * grep-guard catches a reintroduced literal. The authoritative value is plumbed at
 * runtime via the spawn envelope's `base_ref` (asserted in coroutine.test.ts) and the
 * holdout prompt builder (validate.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8");

/** Reviewer system-prompts: they describe a prompt-provided `<baseRef>` placeholder. */
const PLACEHOLDER_SURFACES = [
  "skills/review-protocol/SKILL.md",
  "agents/implementation-reviewer.md",
  "agents/quality-reviewer.md",
  "agents/architecture-reviewer.md",
  "agents/security-reviewer.md",
  "agents/silent-failure-hunter.md",
  "agents/type-design-reviewer.md",
];

/** The two driver templates that interpolate the envelope's per-run base ref. */
const DRIVER_SURFACES = ["skills/pipeline-orchestrator/SKILL.md", "scripts/factory-run-driver.js"];

describe("review base ref plumbing (Fix 2 regression guard)", () => {
  // `diff origin/staging` NOT followed by `-`/word char = the bare, namespace-colliding
  // command form. Allows the per-run `diff origin/staging-<run-id>` and prose mentions
  // (e.g. "never a bare `origin/staging`") that are not a diff command.
  const BARE_DIFF = /diff\s+origin\/staging(?![-\w])/;

  it.each([...PLACEHOLDER_SURFACES, ...DRIVER_SURFACES])(
    "no review surface hardcodes a bare `diff origin/staging`: %s",
    (rel) => {
      expect(read(rel)).not.toMatch(BARE_DIFF);
    },
  );

  it.each(PLACEHOLDER_SURFACES)(
    "reviewer system-prompt diffs the prompt-provided <baseRef>: %s",
    (rel) => {
      expect(read(rel)).toContain("diff <baseRef>");
    },
  );

  it("the workflow driver interpolates env.base_ref into the reviewer + verifier prompts", () => {
    const src = read("scripts/factory-run-driver.js");
    expect(src).toContain("diff ${env.base_ref}");
  });

  it("the session orchestrator substitutes <tenv.base_ref> into the reviewer prompt", () => {
    expect(read("skills/pipeline-orchestrator/SKILL.md")).toContain("diff <tenv.base_ref>");
  });
});
