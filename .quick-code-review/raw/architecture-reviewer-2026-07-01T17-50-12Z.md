# architecture-reviewer — raw findings

Status: DONE
Verdict: None

## Finding 1: [important] src/debug/spec-source.ts:32 — src/debug (domain) imports a type from src/cli/subcommands (CLI layer), inverting the declared dependency direction

**Quote:** `import type { SpecBuildDeps } from "../cli/subcommands/spec.js";`

**Why:** CLAUDE.md documents the CLI as a thin seam that composes domain modules ('the CLI is the orchestrator seam + reporters + writers'); every other subcommand (run.ts, rescue.ts, debug.ts) imports FROM domain modules (git/, spec/, orchestrator/, debug/), never the reverse. This new file breaks that direction: src/debug/spec-source.ts, a domain module, imports SpecBuildDeps out of src/cli/subcommands/spec.ts. Combined with src/cli/subcommands/debug.ts:3052 in the diff (`import { debugIssueNumber, buildDebugReport, wireDebugSpecDeps } from "../../debug/spec-source.js";`), the edge set is cli/subcommands/debug.ts -> src/debug/spec-source.ts -> src/cli/subcommands/spec.ts -- a CLI file reaching into a domain module that reaches back into a different CLI file. `npx madge --circular --extensions ts src/` (run against the current tree) reports no cycle, because the import is `type`-only and erased at build time -- so this is not a runtime cycle -- but it is a structural layer inversion: the domain layer's compile-time shape now depends on an implementation type owned by the CLI layer, so a refactor of spec.ts's internal SpecBuildDeps shape can break src/debug/ even though src/debug/ is supposed to be spec.ts's dependency, not its dependent.

**REFUTED:** Refuted. The import is intentional, documented behavior, not an inadvertent layering inversion, and there is no "declared dependency direction" in this repo that it violates.

1. src/debug/spec-source.ts:1-28 (module header) explicitly documents this exact design: "resolveSpec/gateSpec/storeSpec themselves are imported UNCHANGED from src/cli/subcommands/spec.ts — this module never forks or reimplements them; only the SpecBuildDeps passed in differs." Lines 164-172 repeat the justification for wireDebugSpecDeps. The dependency is a deliberate reuse strategy (don't fork the spec pipeline), not an accidental inversion.

2. The pattern is already established beyond just the type: src/debug/spec-source.test.ts:13 imports the actual function resolveSpec directly from ../cli/subcommands/spec.js — a heavier runtime dependency than the type-only import flagged at line 32. If importing from cli/subcommands were truly forbidden, that would be the more egregious instance, yet it is the accompanying test for this very module.

3. There is no enforced or declared architecture boundary in this repo that this violates. There is no dependency-cruiser/eslint-boundaries config in the plugin's own root (those only ship as templates for scaffolded target repos, e.g. templates/package.scaffold.json). The only architecture doc, docs/architecture/components.md, does not even include src/debug in its module diagram, so there is no "declared direction" for this module to invert.

4. The actual enforced architecture gate, npm run check:circular (madge --circular src/), passes clean with no circular dependency found, confirming this import doesn't create the kind of cross-layer cycle the gate is designed to catch (cli/subcommands/debug.ts imports FROM src/debug/*, and src/debug/spec-source.ts imports a type FROM cli/subcommands/spec.ts — two different files, no file-level cycle).

Given the explicit in-file documentation calling out and justifying this exact import, and the absence of any declared/enforced rule it contravenes, the finding mischaracterizes intended design as an architectural defect.</parameter>
</invoke>


---
