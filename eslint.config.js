// Flat ESLint config — NON-BLOCKING in v1 (wired to `npm run lint`, excluded
// from `npm run verify` and the build).
//
// TypeScript sources are deliberately NOT linted here: `tsc --strict --noEmit`
// is the de-facto linter for the frozen seams, and Prettier is the formatter.
// Pulling in the heavy `typescript-eslint` parser/graph is out of scope for
// Group 0 — without it, ESLint's base parser chokes on TS type syntax, so we
// scope ESLint to plain `.js`/`.mjs` build tooling only. Drop-in upgrade path:
// add `typescript-eslint` and a `files: ["src/**/*.ts"]` block later if the team
// wants type-aware enforcement in CI.
import js from "@eslint/js";
import { createRequire } from "node:module";

// Workflow scripts (workflows/**/*.js) are ESM with a top-level `return` — the
// Workflow harness wraps the script body in an async function, so the return is
// legal at runtime. ESLint core force-disables espree's `globalReturn` whenever
// sourceType is "module" (lib/languages/js/index.js normalizeLanguageOptions),
// but ONLY when the configured parser is identity-equal to espree. This thin
// delegating parser sidesteps that reset; espree itself parses module +
// globalReturn fine. espree is not a direct dependency (pnpm strict layout), so
// resolve it through eslint's own dependency tree.
const require = createRequire(import.meta.url);
const espree = createRequire(require.resolve("eslint"))("espree");
const workflowParser = {
  meta: { name: "espree-with-top-level-return", version: "1.0.0" },
  parse: (code, parserOptions) => espree.parse(code, parserOptions),
};

export default [
  {
    // `.claude/**` holds ephemeral agent worktrees (full repo copies), project
    // settings, and plans — none of it is lintable source. Without this, ESLint
    // walks into `.claude/worktrees/*/` and lints stale copies of the build +
    // workflow scripts (the latter parse-error on their top-level `return`,
    // since the worktree path doesn't match the `workflows/**` parser override).
    ignores: ["dist/**", "node_modules/**", "coverage/**", "src/**/*.ts", ".claude/**"],
  },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    // Claude Code Workflow scripts: plain ESM executed by the Workflow harness,
    // which injects these globals and wraps the body in an async context where
    // top-level `return` is legal (hence `globalReturn` + the delegating parser
    // above). No TS rules apply.
    files: ["workflows/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: workflowParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          globalReturn: true,
        },
      },
      globals: {
        agent: "readonly",
        parallel: "readonly",
        pipeline: "readonly",
        phase: "readonly",
        log: "readonly",
        args: "readonly",
        budget: "readonly",
        workflow: "readonly",
      },
    },
  },
];
