// Default ESLint flat config scaffolded by the factory pipeline.
//
// Self-contained: it imports NO external plugins, so it can never fail-close the
// lint gate on a missing dependency. It is a sane BASELINE — the lint gate only
// runs once eslint is installed (`npm i -D eslint`) and this config is present;
// until then the gate skips as "not applicable". Extend it for your project
// (e.g. add `typescript-eslint` for TS-aware rules) as needed.
export default [
    {
        // .claude/ holds agent worktrees, .stryker-tmp/ mutation sandboxes, .github/scripts/ a generated bundle.
        ignores: [
            'dist/**',
            'build/**',
            'coverage/**',
            'node_modules/**',
            'reports/**',
            '.claude/**',
            '.stryker-tmp/**',
            '.github/scripts/**',
        ],
    },
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
        },
        rules: {
            'no-debugger': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },
]
