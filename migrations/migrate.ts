import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

// Forward-only migration runner (PROJECT.md §5).
//
// Applies pending `*.sql` files in filename order, each in its own transaction,
// recording applied filenames in a `schema_migrations` table so re-runs are
// idempotent. Migrations are never edited after they have run anywhere.
//
// SQL note (PROJECT.md §4.3): migration files are DDL and run verbatim; the only
// runtime-supplied value — the applied filename — is passed as a bound parameter.

const MIGRATIONS_DIR = import.meta.dirname;

interface AppliedRow {
  filename: string;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (see .env.example).');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const applied = await client.query<AppliedRow>(
      'SELECT filename FROM schema_migrations',
    );
    const appliedSet = new Set(applied.rows.map((row) => row.filename));

    const pending = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .filter((name) => !appliedSet.has(name));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      console.log(`Applying migration: ${filename}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename],
        );
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
