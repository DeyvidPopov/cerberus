import type { Express } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { DIMENSION, enrolledActiveUser, loginReq } from '../test-support/auth';
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// A keystroke vector far from the enrolled baseline ⇒ behavioral score → 1.
function anomalousSample(): number[] {
  return Array.from({ length: DIMENSION }, () => 5000);
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

/** A genuine HIGH-risk login that DENIES: anomalous typing (behavioral → 1) on a NEW
 *  device (newDevice → 1) ⇒ composite ≥ the deny threshold. */
async function denyOnce(app: Express) {
  const { acct } = await enrolledActiveUser(app);
  return loginReq(app, acct, { fingerprint: deviceFingerprintHash(), sample: anomalousSample() });
}

describe('deny explanation — demo-gated, NEVER in production (ADR-0012/0015)', () => {
  it('non-production: a high-risk deny attaches the demonstration breakdown', async () => {
    const app = createApp(pool, config); // testServerConfig.nodeEnv = 'test' (non-production)
    const res = await denyOnce(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('denied');
    // The breakdown is present, names a driver, and crosses the deny threshold.
    expect(res.body.risk).toBeDefined();
    expect(res.body.risk.composite).toBeGreaterThanOrEqual(res.body.risk.threshold);
    expect(typeof res.body.risk.driver).toBe('string');
    expect(res.body.risk.signals).toHaveLength(5);
    const labels: string[] = res.body.risk.signals.map((s: { label: string }) => s.label);
    expect(labels).toContain('New device');
    // Each signal carries a real contribution + a human reason.
    for (const s of res.body.risk.signals as { contribution: number; reason: string }[]) {
      expect(typeof s.contribution).toBe('number');
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it('production: the SAME high-risk deny is GENERIC — no breakdown leaked', async () => {
    const app = createApp(pool, { ...config, nodeEnv: 'production' });
    const res = await denyOnce(app);

    expect(res.status).toBe(403);
    // Exactly the generic body — nothing else.
    expect(res.body).toEqual({ error: 'denied' });
    expect(res.body.risk).toBeUndefined();
    // No signal/score vocabulary leaks in a production response.
    expect(JSON.stringify(res.body)).not.toMatch(/keystroke|geovelocity|composite|contribution|new device/iu);
  });
});
