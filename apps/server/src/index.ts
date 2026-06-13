import { createServer } from 'node:http';

import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './repositories/pool';
import { createContinuousAuthService } from './services/continuous-auth';
import { openGeoIp } from './services/geoip';
import { attachContinuousAuthWebSocket } from './ws';

// Server bootstrap. Reads config, opens the offline GeoIP DB (if configured),
// creates the DB pool, attaches the continuous-auth WebSocket, starts listening —
// no business logic here.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const geoLookup = await openGeoIp(config.geoipDbPath);
  const app = createApp(pool, config, { geoLookup });

  // The continuous-auth telemetry stream needs the raw HTTP server for the upgrade.
  const server = createServer(app);
  const continuousAuth = createContinuousAuthService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    config: config.continuousAuth,
  });
  attachContinuousAuthWebSocket(server, { pool, continuousAuth });

  server.listen(config.port, () => {
    console.log(`Cerberus server listening on port ${config.port}`);
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exitCode = 1;
});
