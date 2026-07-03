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

export default [
  {
    // `.claude/**` holds ephemeral agent worktrees (full repo copies), project
    // settings, and plans — none of it is lintable source. Without this, ESLint
    // walks into `.claude/worktrees/*/` and lints stale copies of the build
    // scripts. `templates/.github/scripts/**` is a generated, diff-reviewable esbuild
    // artifact (like `dist/**`) — its TS source under `src/bin/` is what tsc
    // checks; linting the bundle just trips on injected `process` globals.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/**/*.ts",
      ".claude/**",
      "templates/.github/scripts/**",
    ],
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
];
