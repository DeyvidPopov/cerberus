// DEMO-ONLY entrypoint: `npm run demo:reset`. Removes the demo account (and all it
// owns) and re-seeds it to a known, reproducible state. Hard-gated to non-production;
// refuses a non-local database.
import { loadConfig } from '../config';
import { createPool } from '../repositories/pool';
import { printLoginNote, removeDemo, seedDemo } from './core';
import { assertDevDemoEnvironment } from './env';

async function main(): Promise<void> {
  const config = loadConfig();
  assertDevDemoEnvironment(config.databaseUrl);

  const pool = createPool(config.databaseUrl);
  try {
    const removed = await removeDemo(pool);
    console.log(removed ? 'Removed the existing demo account.' : 'No existing demo account to remove.');
    const result = await seedDemo(pool, config);
    console.log('Re-seeded the demo account to a known state.');
    printLoginNote(result);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('demo:reset failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
