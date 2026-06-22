# Getting Started

This tutorial gets you from a fresh clone to a working build of the Dark Factory
engine, and walks the deterministic CLI through a run so you can see the Model-A
split first-hand. By the end you will have the test suite green, both bundles
built, and a feel for how the `factory` CLI reports and writes state.

This is a **contributor** tutorial — it teaches the engine. To _operate_ the
factory against a repository, follow [Run the pipeline](./guides/run-the-pipeline.md)
afterward.

## Prerequisites

- Node.js **22 or newer** (`node --version`).
- `git`.
- A clone of this repository.

## 1. Install dependencies

```bash
cd factory-plugin
npm install
```

## 2. Run the full verification

The single command that typechecks, checks for circular imports, lints, tests,
and builds is:

```bash
npm run verify
```

You should see the test suite pass (over a hundred test files, well over a
thousand tests) and two bundles written to `dist/`. This command is the contract
the CI gate enforces; if it is green, your checkout is healthy.

> Note: `npx tsc` is shadowed in this repo. Always use `npm run typecheck` for a
> standalone type check.

## 3. Look at what was built

```bash
ls dist/
```

You will see two checked-in, self-contained bundles:

- `dist/factory.js` — the CLI engine.
- `dist/factory-hook.js` — the hook-guard dispatcher.

Both are produced by `node scripts/build.mjs` (esbuild, fully inlined so they run
with no `node_modules`). `bin/factory` is a thin shim that execs `dist/factory.js`.

## 4. List the CLI surface

Run the CLI's help to see every subcommand:

```bash
node dist/factory.js --help
```

The subcommands are the engine's entire public surface. Each is a **reporter**
(read-only; prints a JSON envelope), part of **the coroutine** (`next` / `drive` — the
single control-flow seam), or a **writer** (one state mutation). For the complete
contract, see [reference/cli.md](./reference/cli.md).

## 5. See the resolved config

The config schema centralizes every default in one place. Print the fully
resolved config:

```bash
node dist/factory.js config-defaults
```

This is the all-defaults config (`ConfigSchema.parse({})` under the hood). Every
gate threshold, the producer-model dial, the quota curves, and the git branch
contract are here. See [reference/configuration.md](./reference/configuration.md).

## 6. Understand the run loop without running it

You now have the engine. The control loop lives in the CLI behind one seam (the
coroutine); what lives in markdown is the **driver** — the thin loop that spawns the
agents each envelope names — because only a session can call the `Agent` tool.
That is the Model-A split. Read these two files in order:

1. `commands/run.md` — the `/factory:run` entry point (the spine; picks the driver
   via `--workflow` — session by default).
2. `skills/pipeline-orchestrator/SKILL.md` — the session driver's full loop: the
   Iron Laws, the coroutine surface (`next` / `drive`), the agent-spawn matrix, and the
   four phases (preconditions → spec → create → drive → completion).

As you read, map each prose step to a CLI call. The CLI owns the loop behind ONE
seam — the coroutine. The driver's inner per-task loop runs `factory drive --run <id>
--task <id>`, reads the JSON `DriveEnvelope`, spawns exactly the agents its
`manifest` names, then folds their raw output back with `factory drive --results`
(the run-level `factory next` picks which task to drive). The coroutine tells the driver
the next step; the driver never invents it.

## 7. Run the unit tests for one module

To iterate on a single module, run vitest in watch mode scoped to a path:

```bash
npx vitest src/verifier/deterministic
```

Tests are colocated next to their source as `*.test.ts`. The whole suite is the
source of truth for behavior — read a module's test file alongside the module.

## Where to go next

- To operate the factory: [Run the pipeline](./guides/run-the-pipeline.md).
- To work on the engine: [Build and verify](./guides/build-and-verify.md).
- To understand the design: [Model A](./explanation/model-a.md) and the
  [System Overview](./architecture/overview.md).
  </content>
