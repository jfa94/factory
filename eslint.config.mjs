import eslint from '@eslint/js'
import {defineConfig, globalIgnores} from 'eslint/config'
import tseslint from 'typescript-eslint'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import pluginSecurity from 'eslint-plugin-security'
import globals from 'globals'

export default defineConfig(
    globalIgnores([
        'node_modules/',
        'dist/',
        'coverage/',
        '**/*.d.ts',
        '.claude/',
        '.comprehensive-code-review/',
        '.quick-code-review/',
        // The scaffold shipped to TARGET repos via `factory scaffold` — a different
        // (Next.js-shaped) project, validated by the target repo's own CI, not ours.
        // It even references target-only eslint plugins (e.g. eslint-plugin-playwright)
        // that aren't our deps, so this repo can't meaningfully lint it.
        'templates/**/*',
    ]),

    eslint.configs.recommended,
    prettierRecommended,

    // TypeScript: strictest type-checked linting
    {
        files: ['**/*.ts', '**/*.tsx'],
        extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {...globals.node},
        },
        rules: {
            // Type safety — zero tolerance for unsafe operations
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-return': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/strict-boolean-expressions': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            // Numbers/booleans/nullish stringify safely; only objects are the real risk.
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                {allowNumber: true, allowBoolean: true, allowNullish: true},
            ],
            // Deliberate-discard convention: `_`-prefixed args/vars/caught-errors and
            // rest-siblings are intentional (interface-required params that can't be
            // deleted, destructuring omits). Everything else unused is a real error.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            '@typescript-eslint/consistent-type-imports': [
                'error',
                {
                    prefer: 'type-imports',
                    fixStyle: 'inline-type-imports',
                },
            ],

            // General quality
            'no-console': ['error', {allow: ['warn', 'error']}],
            // `always` everywhere, but keep the `== null` / `!= null` idiom (matches null
            // OR undefined) — rewriting those to `===` would change behavior.
            eqeqeq: ['error', 'always', {null: 'ignore'}],
            curly: ['error', 'all'],
        },
    },

    // Security rules
    {
        plugins: {security: pluginSecurity},
        rules: {
            'security/detect-eval-with-expression': 'error',
            'security/detect-child-process': 'error',
            'security/detect-non-literal-fs-filename': 'warn',
            'security/detect-non-literal-require': 'warn',
            'security/detect-possible-timing-attacks': 'warn',
            'security/detect-unsafe-regex': 'error',
            'security/detect-buffer-noassert': 'error',
            'security/detect-pseudoRandomBytes': 'error',
            'security/detect-bidi-characters': 'error',
        },
    },

    // Tests build fixture files at derived paths — the fs-filename heuristic can't
    // distinguish a test's own temp dir from external input, so it's pure noise here.
    // It stays ON for production (a real tripwire for new fs code).
    {
        files: ['**/*.test.ts'],
        rules: {
            'security/detect-non-literal-fs-filename': 'off',
        },
    },

    // Disable type-checked for JS config/script files (Node globals, no project service)
    {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: {globals: {...globals.node}},
    }
)
