// DEMO-ONLY entrypoint: `npm run demo:seed`. Creates a ready-to-demo account on a
// LOCAL dev database (active baseline + confirmed TOTP + example credentials) and
// prints how to log in. Hard-gated to non-production; refuses a non-local database.
import { loadConfig } from '../config';
import { createPool } from '../repositories/pool';
import { printLoginNote, removeDemo, seedDemo } from './core';
import { assertDevDemoEnvironment } from './env';

async function main(): Promise<void> {
  const config = loadConfig();
  assertDevDemoEnvironment(config.databaseUrl);

  const pool = createPool(config.databaseUrl);
  try {
    const replaced = await removeDemo(pool); // idempotent: replace any prior demo account
    if (replaced) {
      console.log('Replaced an existing demo account.');
    }
    const result = await seedDemo(pool, config);
    printLoginNote(result);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('demo:seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
