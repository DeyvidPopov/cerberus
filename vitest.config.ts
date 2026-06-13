import { defineConfig } from 'vitest/config';

// Runs the TS/TSX unit tests across all workspaces. Default environment is node
// (zod validators, services against ephemeral Postgres, the Tauri IPC wrapper);
// React component tests opt into jsdom per-file with a `// @vitest-environment
// jsdom` docblock (Milestone 10, Part A — login-outcome rendering).
export default defineConfig({
  // Match the desktop tsconfig's automatic JSX runtime (`jsx: react-jsx`) so .tsx
  // component tests transform without importing React explicitly.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['apps/**/src/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.{ts,tsx}'],
  },
});
