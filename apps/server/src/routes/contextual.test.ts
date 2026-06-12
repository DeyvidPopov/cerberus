import type { Express } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { CoarseGeo, GeoLookup } from '../services/geoip';
import { testServerConfig } from '../test-support/config';
import {
  loginGranted,
  registerAccount,
  sampleVector,
  userIdOf,
  type Account,
} from '../test-support/auth';
import { createTestDb, type TestDb } from '../test-support/postgres';
import request from 'supertest';

// M9: the four contextual signals are evaluated at the LOGIN decision point and
// logged to the login risk_events row alongside the behavioral signal (ADR-0011).

const US_IP = '203.0.113.7';
const JP_IP = '198.51.100.7';
const GEO: Record<string, CoarseGeo> = {
  [US_IP]: { country: 'US', region: 'CA' },
  [JP_IP]: { country: 'JP', region: '13' },
};
const stubGeo: GeoLookup = (ip) => GEO[ip] ?? null;

let db: TestDb;
let pool: Pool;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  app = createApp(pool, testServerConfig(), { geoLookup: stubGeo });
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

interface SignalEntry {
  score: number | null;
  reason?: Record<string, unknown>;
}
interface RiskRow {
  signals: {
    keystroke?: SignalEntry;
    newDevice?: SignalEntry;
    geovelocity?: SignalEntry;
    timeOfDay?: SignalEntry;
    failureVelocity?: SignalEntry;
  };
  composite_score: string | null;
  context_score: string | null;
  policy_band: string | null;
  action_taken: string | null;
  geo_country: string | null;
  ip_truncated: string | null;
}

async function latest(uid: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, composite_score, context_score, policy_band, action_taken, geo_country, ip_truncated
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [uid],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

async function failedLogin(acct: Account, ip: string): Promise<void> {
  await request(app)
    .post('/auth/login')
    .set('X-Forwarded-For', ip)
    .send({
      username: acct.username,
      authKey: Buffer.from('wrong-auth-key-000000000000000000').toString('base64'),
      deviceFingerprintHash: acct.fingerprint,
    })
    .expect(401);
}

describe('contextual signals at login (ADR-0011/0012)', () => {
  it('logs all four contextual sub-scores + the behavioral one, and ENFORCES', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, { ip: US_IP, sample: sampleVector(1) });
    const row = await latest(await userIdOf(app, token));

    for (const name of ['keystroke', 'newDevice', 'geovelocity', 'timeOfDay', 'failureVelocity'] as const) {
      expect(row.signals[name], `missing signal ${name}`).toBeDefined();
    }
    // M9 ENFORCES: the combiner output + band + action are written (no longer null).
    expect(row.composite_score).not.toBeNull();
    expect(row.context_score).not.toBeNull();
    expect(row.policy_band).not.toBeNull();
    expect(row.action_taken).not.toBeNull();
  });

  it('COLD START: a newcomer’s history-dependent signals stay neutral', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, {}); // no IP ⇒ geo null
    const row = await latest(await userIdOf(app, token));
    expect(row.signals.geovelocity?.score).toBe(0);
    expect(row.signals.geovelocity?.reason?.status).toBe('insufficient_geo');
    expect(row.signals.timeOfDay?.score).toBe(0);
    expect(row.signals.timeOfDay?.reason?.status).toBe('insufficient_history');
    expect(row.signals.failureVelocity?.score).toBe(0);
    expect(row.signals.newDevice?.score).toBe(1); // unseen device fires (correct)
  });

  it('geovelocity flags impossible travel between two logins', async () => {
    const acct = await registerAccount(app);
    await loginGranted(app, acct, { ip: US_IP }); // establishes US as the prior location
    const token = await loginGranted(app, acct, { ip: JP_IP }); // ~instant US → JP
    const row = await latest(await userIdOf(app, token));
    expect(row.signals.geovelocity?.score).toBeGreaterThan(0.9);
    expect(row.signals.geovelocity?.reason?.prevGeo).toBe('US');
    expect(row.signals.geovelocity?.reason?.currGeo).toBe('JP');
  });

  it('failure-velocity rises after recent failed logins', async () => {
    const acct = await registerAccount(app);
    await failedLogin(acct, US_IP);
    await failedLogin(acct, US_IP);
    await failedLogin(acct, US_IP);
    const token = await loginGranted(app, acct, { ip: US_IP });
    const row = await latest(await userIdOf(app, token));
    expect(row.signals.failureVelocity?.score).toBeGreaterThan(0);
    expect(row.signals.failureVelocity?.reason?.accountFailures).toBeGreaterThanOrEqual(3);
  });

  it('new-device: a second login on the same device is no longer unseen', async () => {
    const acct = await registerAccount(app);
    await loginGranted(app, acct, {});
    const token = await loginGranted(app, acct, {}); // same fingerprint ⇒ known
    const row = await latest(await userIdOf(app, token));
    expect(row.signals.newDevice?.score).toBeLessThan(1);
    expect(row.signals.newDevice?.reason?.known).toBe(true);
  });

  it('PRIVACY: coarse geo + truncated IP only (no full IP / coordinates)', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, { ip: US_IP });
    const uid = await userIdOf(app, token);
    const row = await latest(uid);
    expect(row.geo_country).toBe('US');
    expect(row.ip_truncated).toBe('203.0.113.0');
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(US_IP);
    expect(serialized).not.toContain('latitude');
  });
});
