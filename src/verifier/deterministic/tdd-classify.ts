/**
 * WS6 — PURE TDD-gate classification (Δ N). Ported VERBATIM from
 * bin/pipeline-tdd-gate (the gate-math ORACLE) so the test-before-impl ordering
 * logic is byte-for-byte the same.
 *
 * The whole gate is pure given the commit list (oldest-first) the GitProbe hands
 * up — no I/O lives here, so the bash test vectors port directly as unit cases.
 */
import type { CommitInfo } from "./tools.js";
import { isDocsPath, isTestPath } from "./scope.js";

/** A single commit's kind, mirroring the bash classifier. */
export type CommitKind = "test-only" | "impl" | "empty";

/** Why the TDD gate blocked (bash violation reasons). */
export type TddViolationReason = "impl-commit-untagged" | "impl-without-preceding-test";

/** A blocking violation on a specific commit. */
export interface TddViolation {
  readonly commit: string;
  readonly reason: TddViolationReason;
}

/** The structured TDD verdict (mirrors the bash JSON {ok, exempt, violations}). */
export interface TddVerdict {
  /** True iff the gate passes (no violations, or no impl, or exempt). */
  readonly ok: boolean;
  /** True ONLY when the task opted out via tdd_exempt (never as a side effect). */
  readonly exempt: boolean;
  readonly violations: readonly TddViolation[];
  /** A machine-readable note for the audit trail. */
  readonly note: string;
}

/**
 * Classify ONE commit's files (bin/pipeline-tdd-gate:109-119). A commit is `impl`
 * if ANY changed file is neither a test path nor a docs path; `empty` if it has no
 * files (an --allow-empty commit); otherwise `test-only`. Docs-only commits are
 * `test-only` in kind terms (they carry no impl) — matching the bash where a
 * docs-only commit yields has_impl=0.
 */
export function classifyCommit(files: readonly string[]): CommitKind {
  const real = files.filter((f) => f.length > 0);
  if (real.length === 0) return "empty";
  let kind: CommitKind = "test-only";
  for (const f of real) {
    if (!isTestPath(f) && !isDocsPath(f)) {
      kind = "impl";
    }
  }
  return kind;
}

/**
 * Compute the TDD verdict from the OLDEST-FIRST commit list + whether the task is
 * tdd_exempt. Ports bin/pipeline-tdd-gate:128-155 exactly:
 *   - zero commits ⇒ FAIL-CLOSED (not exempt) — case_zero_commits.
 *   - no impl commit anywhere ⇒ PASS, exempt:false (tests-only / docs-only).
 *   - exempt ⇒ PASS, exempt:true (only honored when an impl commit exists).
 *   - else walk oldest→newest: a tagged test-only commit sets seen_test_only;
 *     an impl commit is a violation if UNTAGGED (impl-commit-untagged) or if
 *     no preceding tagged test-only (impl-without-preceding-test). An empty
 *     commit (even tagged) never advances seen_test_only (case11).
 */
export function deriveTddVerdict(commits: readonly CommitInfo[], exempt: boolean): TddVerdict {
  if (commits.length === 0) {
    return {
      ok: false,
      exempt: false,
      violations: [],
      note: "no commits in base..HEAD — fail-closed (implementer produced nothing)",
    };
  }

  const classed = commits.map((c) => ({
    sha: c.sha,
    kind: classifyCommit(c.files),
    tagged: c.tagged,
  }));

  const hasImpl = classed.some((c) => c.kind === "impl");
  if (!hasImpl) {
    return { ok: true, exempt: false, violations: [], note: "no impl commit (tests/docs only)" };
  }
  if (exempt) {
    return { ok: true, exempt: true, violations: [], note: "task tdd_exempt" };
  }

  let seenTestOnly = false;
  const violations: TddViolation[] = [];
  for (const c of classed) {
    if (c.kind === "test-only" && c.tagged) {
      seenTestOnly = true;
    } else if (c.kind === "impl") {
      if (!c.tagged) {
        violations.push({ commit: c.sha, reason: "impl-commit-untagged" });
      } else if (!seenTestOnly) {
        violations.push({ commit: c.sha, reason: "impl-without-preceding-test" });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, exempt: false, violations, note: "tdd ordering violation(s)" };
  }
  return { ok: true, exempt: false, violations: [], note: "test-before-impl satisfied" };
}
