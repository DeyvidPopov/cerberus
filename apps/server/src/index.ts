import { createServer } from 'node:http';

import { createApp } from './app';
import { demoOverridesAllowed, loadConfig } from './config';
import { createPool } from './repositories/pool';
import { createContinuousAuthService } from './services/continuous-auth';
import { DEMO_GEO_LOOKUP, NO_GEO_LOOKUP, openGeoIp } from './services/geoip';
import { attachContinuousAuthWebSocket } from './ws';

// Server bootstrap. Reads config, opens the offline GeoIP DB (if configured),
// creates the DB pool, attaches the continuous-auth WebSocket, starts listening —
// no business logic here.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  // Real offline GeoIP if a GeoLite2 DB is present; otherwise, OUTSIDE PRODUCTION ONLY,
  // fall back to the demo geo table so geovelocity resolves without a MaxMind DB. In
  // production a missing DB stays neutral (NO_GEO_LOOKUP) — never the demo table.
  let geoLookup = await openGeoIp(config.geoipDbPath);
  if (geoLookup === NO_GEO_LOOKUP && demoOverridesAllowed(config.nodeEnv)) {
    geoLookup = DEMO_GEO_LOOKUP;
    console.log('[geo] No GeoLite2 DB found — using the DEMO geo table (non-production).');
  }
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
