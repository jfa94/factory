# How to Build and Verify the Engine

This is the contributor workflow for the TypeScript engine. The source is in
`src/` with colocated `*.test.ts`; the shipped artifacts are two checked-in
esbuild bundles in `dist/`.

## The one command

```bash
npm run verify
```

`verify` runs, in order: `typecheck` → `lint` → `test` → `build`. This is the
contract CI enforces and the gate for a release-worthy state. If it is green, the
checkout is healthy and the bundles are current.

## The individual steps

| Step         | Command                                   | Notes                                                                             |
| ------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Type-check   | `npm run typecheck`                       | `tsc --noEmit`. **Use this, not `npx tsc`** — `npx tsc` is shadowed in this repo. |
| Lint         | `npm run lint`                            | `eslint .`                                                                        |
| Test         | `npm run test`                            | `vitest run` (one shot).                                                          |
| Test (watch) | `npm run test:watch`                      | `vitest`.                                                                         |
| Build        | `npm run build`                           | `node scripts/build.mjs` → both bundles.                                          |
| Format       | `npm run format` / `npm run format:check` | `prettier`.                                                                       |

## Running a subset of tests

Vitest takes a path filter, so scope to the module you are changing:

```bash
npx vitest src/verifier/deterministic
npx vitest src/cli/subcommands/run.test.ts
```

Tests must be independent (no shared mutable state). For functions with broad
input domains, prefer property-based tests to catch edge cases example-based tests
miss.

## The build output

`scripts/build.mjs` emits:

- `dist/factory.js` — from `src/bin/factory.ts` (the CLI).
- `dist/factory-hook.js` — from `src/bin/factory-hook.ts` (the hook dispatcher).

Both are full inlines (no `external`), so they run at a user's site with no
`node_modules` — `zod` and `proper-lockfile` are bundled in. A
`#!/usr/bin/env node` banner plus `chmod 0755` makes them directly executable;
they are kept un-minified so the checked-in artifact stays diff-reviewable.

**The bundles are committed.** When you change `src/`, re-run `npm run build` (or
`npm run verify`) and commit the regenerated `dist/` alongside your source change,
or CI will fail on a stale bundle.

## The CLI registry seam

To add a subcommand, create `src/cli/subcommands/<name>.ts` exporting a
`Subcommand` (`{ describe, run }`), then register it in the frozen registry in
`src/cli/main.ts`. The thin entry `src/bin/factory.ts` is the only place that
calls `process.exit`. Hooks follow the same pattern via `src/hooks/main.ts`.

## Versioning

The plugin version is `package.json#version`. Bump it per the significance of your
change (patch for fixes/refactors, minor for new backward-compatible capabilities,
major for breaking changes).
</content>
