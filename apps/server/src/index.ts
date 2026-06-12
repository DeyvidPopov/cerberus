import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './repositories/pool';

// Server bootstrap. Reads config, creates the DB pool, starts listening — no
// business logic here.
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = createApp(pool, config);

app.listen(config.port, () => {
  console.log(`Cerberus server listening on port ${config.port}`);
});
