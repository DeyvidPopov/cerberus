import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './repositories/pool';
import { openGeoIp } from './services/geoip';

// Server bootstrap. Reads config, opens the offline GeoIP DB (if configured),
// creates the DB pool, starts listening — no business logic here.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const geoLookup = await openGeoIp(config.geoipDbPath);
  const app = createApp(pool, config, { geoLookup });

  app.listen(config.port, () => {
    console.log(`Cerberus server listening on port ${config.port}`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exitCode = 1;
});
