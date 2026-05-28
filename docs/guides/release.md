# Release Checklist

Run through these steps before tagging a new release of the factory plugin.

## Version Bump

1. Update `CHANGELOG.md` (if maintained).
2. Bump version in BOTH manifests — they must stay in lockstep:
   - `.claude-plugin/plugin.json` (`.version`)
   - `.claude-plugin/marketplace.json` (`.plugins[].version`)

   The test suite enforces parity via `bin/tests/version-parity.sh`. Drift
   means marketplace clients install a stale build (see H16 regression).

3. Tag the commit and push.

## Verification

Before tagging, confirm:

```
bin/test version-parity
bin/test
```

Both must report `0 failed`. As of 0.10.3, `.github/workflows/tests.yml` also runs `bin/tests/run-all.sh` on every push and PR to `main`; the workflow must be green before tagging. See `docs/reference/bin-scripts.md#bintestsrun-allsh` for runner details.
