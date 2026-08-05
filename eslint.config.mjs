import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'packages/database/generated/**',
      'templates/**',
      'tmp-smoke/**',
      'test-results/**',
      'apps/web/next-env.d.ts',
      'playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        RequestInit: 'readonly',
        NodeJS: 'readonly',
        window: 'readonly',
        document: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Explicit `any` is disallowed except where a boundary genuinely has no
      // type; those places disable the rule locally with a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Money must never touch binary floating point.
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
          message: 'Use the decimal helpers in @element/shared for monetary rounding, not Math.round.',
        },
      ],
    },
  },

  {
    // Scripts and tests print to stdout deliberately.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '**/*.config.ts', '**/*.config.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // Rounding percentages for display is not monetary arithmetic.
    files: ['apps/web/**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Playwright requires a hook's first argument to be a destructuring
    // pattern, so a hook that only wants the worker info must write `({}, w)`.
    files: ['tests/e2e/**/*.ts'],
    rules: { 'no-empty-pattern': 'off' },
  },
);
