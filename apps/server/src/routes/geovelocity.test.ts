import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { enrolledActiveUser, loginReq, sampleVector } from '../test-support/auth';
import { testServerConfig } from '../test-support/config';
import { createTestDb, type TestDb } from '../test-support/postgres';

interface RiskRow {
  signals: Record<string, unknown>;
  policy_band: string | null;
}

async function latest(pool: Pool, userId: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, policy_band FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

function subScore(row: RiskRow, signal: string): number | null {
  const s = row.signals[signal];
  if (typeof s === 'object' && s !== null && 'score' in s) {
    const score = (s as { score: unknown }).score;
    return typeof score === 'number' ? score : null;
  }
  return null;
}

let db: TestDb;
let pool: Pool;
let config: ServerConfig;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig();
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('geovelocity — X-Demo-Geo override (non-production demo)', () => {
  it('an impossible US→JP hop FIRES geovelocity (same account, only location changed)', async () => {
    const app = createApp(pool, config); // testServerConfig.nodeEnv = 'test' (non-production)
    const { acct, userId } = await enrolledActiveUser(app);

    // 1. Sign in from the US → establishes the previous location (first fix → neutral).
    await loginReq(app, acct, { sample: sampleVector(3) }).set('X-Demo-Geo', 'US');
    expect(subScore(await latest(pool, userId), 'geovelocity')).toBe(0);

    // 2. Seconds later from JAPAN → impossible travel.
    await loginReq(app, acct, { sample: sampleVector(4) }).set('X-Demo-Geo', 'JP');
    const row = await latest(pool, userId);
    expect(subScore(row, 'geovelocity')).toBeGreaterThan(0.5);
    // The recorded reason is coarse country-level only (privacy — no precise coordinates).
    const geo = row.signals.geovelocity as { reason?: Record<string, unknown> };
    expect(geo.reason?.currGeo).toBe('JP');
    expect(geo.reason?.prevGeo).toBe('US');
  });

  it('production IGNORES X-Demo-Geo (the override never affects a shipped system)', async () => {
    const app = createApp(pool, { ...config, nodeEnv: 'production' });
    const { acct, userId } = await enrolledActiveUser(app);

    await loginReq(app, acct, { sample: sampleVector(3) }).set('X-Demo-Geo', 'US');
    await loginReq(app, acct, { sample: sampleVector(4) }).set('X-Demo-Geo', 'JP');
    const row = await latest(pool, userId);
    // No override honored + no GeoIP DB ⇒ geovelocity could not corroborate ⇒ neutral.
    expect(subScore(row, 'geovelocity')).toBe(0);
  });
});
