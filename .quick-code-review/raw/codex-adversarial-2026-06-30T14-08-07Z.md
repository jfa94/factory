# codex-adversarial — render (2026-06-30T14-08-07Z)

Target: {"mode":"branch","label":"branch diff against 8f2614a","baseRef":"8f2614a","explicit":true}

Verdict: needs-attention

Summary: No ship: the new E2E sweep can discard reported blocking money-path failures and best-effort advance after retries.

## Findings (1)

### [high · conf 0.86] src/orchestrator/e2e-sweep.ts:93-122 — `error` sweep results can hide blocking findings and advance

- Body: `E2eSweepResultSchema` rejects contradictory `approve`/`blocked` results, but it allows `verdict: "error"` with non-empty or blocking `findings`. `runE2eRecord` then treats every `error` result as an incomplete sweep, ignores the findings entirely, and after the retry cap returns `recommendation: "advance"`, `blocking_count: 0`, and `findings: []`. A realistic e2e-author output for a boot/login/checkout failure could include the blocking finding but use `error`; this path drops that evidence and can let the run finalize as best-effort clean.
- Recommendation: Make `error` mutually exclusive with findings, or treat any `error` result containing findings/blocking findings as a recorded `blocked` sweep. Add tests covering `verdict: "error"` with blocking findings through `runE2eRecord`, including the retry-cap path.

## next_steps

- Tighten the E2E result schema/recording semantics before shipping.
