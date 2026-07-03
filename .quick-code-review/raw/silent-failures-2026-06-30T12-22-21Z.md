# silent-failure-hunter — raw output (2026-06-30T12-22-21Z)

**Status:** DONE

**Verdict:** Reviewed the E2E sweep + remediation diff for swallowed failures. The deliberate non-blocking/best-effort paths (verdict "error" on dead author, attempt-cap advance, fix-forward suspend, auth.setup loud-fail, scaffold fail-loud guards) are all surfaced as designed. Two genuine error-hiding patterns found: a silent no-op string-replace that can downgrade a blocking gate to advisory, and an async pageerror collection whose assertion can miss post-load crashes.

## [important] src/cli/subcommands/scaffold.ts:577 — Blocking E2E gate downgrade relies on an unverified no-op string replace

**REFUTED:** The claim that the blocking-mode strip "relies on an unverified no-op string replace" is refuted on two grounds.

1) The regex is NOT a silent no-op against the actual template. templates/ci/e2e.yml:33 is exactly `........continue-on-error:.true.#.advisory.default; removed by ...` (8 leading spaces, dots=spaces). The replace `/^        continue-on-error: true.*\n/m` (scaffold.ts:577) uses exactly 8 spaces, then `.*` (matches the trailing comment) then `\n` — so it matches and removes the line. There is only one `continue-on-error` occurrence in the template, so no ambiguity.

2) The behavior IS verified by passing tests, contradicting "unverified". scaffold.test.ts:587-593 ("e2e.yml drops the step-level continue-on-error when e2e.blocking=true") asserts `expect(yml).not.toContain("continue-on-error")` after a blocking scaffold, and :638-644 asserts the same on a managed false→true re-scaffold flip. Were the replace a no-op, the stripped line would remain and these assertions would fail. I ran `npx vitest run scaffold.test.ts -t "continue-on-error"` → 2 passed. Thus any drift between the regex and the template indentation would be caught loudly by the test suite, not silently downgrade the gate.

- kind: local
- verbatim: `return blocking ? withEnv.replace(/^        continue-on-error: true.*\n/m, "") : withEnv;`
- why: When e2e.blocking=true the code strips the step-level `continue-on-error: true` from e2e.yml so a smoke failure reds the job. `String.replace` is a no-op when the pattern does not match and returns the text unchanged with NO error. The regex hard-codes exactly 8 leading spaces and the literal trailing text; any future indentation/comment drift in templates/ci/e2e.yml (or an upstream transform that reflows it) makes the strip silently miss. The continue-on-error line then survives, the E2E job concludes success even on a failing smoke step, the required `E2E` status check added by ensureRequiredCheck goes green, and a crashing app merges to develop — the exact failure the blocking switch exists to prevent — with zero signal at scaffold time. The strip's success is never asserted, so the class of error hidden is 'blocking-gate intent silently dropped'.
- fix_sketch: Capture the pre/post text and throw at scaffold time if blocking=true but the continue-on-error line is still present after the replace (assert the strip actually happened), or match on a structural anchor rather than a fixed-indent literal.

## [minor] templates/tests/e2e/smoke.spec.ts:36 — Smoke 'no crash' oracle can miss page errors thrown after navigation settles

- kind: local
- verbatim: `expect(errors, ${route} has uncaught errors:\n${errors.join("\n")}).toHaveLength(0);`
- why: `page.on("pageerror", ...)` accumulates errors asynchronously, but the assertion runs synchronously immediately after `page.goto` + the body check. Uncaught errors that fire during late hydration / post-load async work land after the assertion has already read `errors` as empty, so the 'no crash' check passes while the app actually threw — the very crash class the smoke gate hunts is silently not surfaced. Ships as-is to scaffolded repos, so the false-green is the user-visible behavior.
- fix_sketch: Add a short settle/wait (e.g. await a network-idle or a brief page.waitForTimeout) before asserting, or assert on errors via expect.poll so late pageerror events are observed.

