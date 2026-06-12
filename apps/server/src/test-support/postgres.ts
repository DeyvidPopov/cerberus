// Ephemeral Postgres test harness (PROJECT.md §6 — repositories are tested
// against a REAL Postgres, not mocks). Each call creates a fresh database on the
// configured server, applies the real migrations, and returns a pool + teardown.
//
// Connection: TEST_DATABASE_URL (CI service container) or a local default. The
// transient database name is a controlled hex identifier (not user input); DDL
// like CREATE DATABASE cannot be parameterized.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import type { Pool } from 'pg';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'migrations');

const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export interface TestDb {
  pool: Pool;
  teardown: () => Promise<void>;
}

function adminUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function loadMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return files.map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8')).join('\n');
}

export async function createTestDb(): Promise<TestDb> {
  const base = adminUrl();
  const dbName = `cerberus_test_${randomBytes(8).toString('hex')}`;

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: withDatabase(base, dbName) });
  await pool.query(loadMigrations());

  return {
    pool,
    teardown: async () => {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: base });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
