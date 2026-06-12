import { defineConfig } from 'vitest/config';

// Runs the TS unit tests across all workspaces (zod validators + the Tauri IPC
// client wrapper). No DOM/Postgres needed this milestone.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
  },
});
