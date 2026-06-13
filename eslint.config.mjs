// Flat ESLint config enforcing PROJECT.md §4.2:
//   - `any` is banned (use `unknown` + narrowing)
//   - no default exports (named exports only)
//   - no floating promises (async errors handled explicitly)
//
// Type-aware rules require type information, so they are scoped to TS/TSX files
// and use typescript-eslint's `projectService`, which discovers each workspace
// tsconfig automatically. Plain JS (this config file) is linted syntactically
// only, to avoid "file not in any project" errors.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build artifacts, generated output, and Rust are never linted here.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/*.d.ts',
      'apps/desktop/src-tauri/**',
      // Root tooling config, not part of any workspace tsconfig project.
      'vitest.config.ts',
      // UI design reference mockup (M12 / ADR-0015) — not project code, never shipped.
      'design/**',
      // Standalone design-direction previews (M12 step 1) — plain HTML, not linted.
      'docs/design/**',
    ],
  },

  // Baseline JS rules for every file.
  js.configs.recommended,

  // TypeScript: type-aware linting, scoped to TS/TSX only.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_`
      // (e.g. Express's 4-arg error handler signature).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // PROJECT.md §4.2 — `any` is banned.
      '@typescript-eslint/no-explicit-any': 'error',
      // PROJECT.md §4.2 — async errors handled explicitly; no floating promises.
      '@typescript-eslint/no-floating-promises': 'error',
      // PROJECT.md §4.2 — named exports only, no default exports.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message:
            'Default exports are banned (PROJECT.md §4.2). Use a named export instead.',
        },
      ],
    },
  },

  // Node execution context (server, migration runner, JS tooling).
  {
    files: ['apps/server/**/*.ts', 'migrations/**/*.ts', '**/*.config.{ts,js,mjs}', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser execution context (the desktop webview).
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Config files (Vite, ESLint, …) require a default export by convention.
  {
    files: ['**/*.config.{ts,js,mjs,cts,mts}', '**/vite.config.ts', 'eslint.config.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
