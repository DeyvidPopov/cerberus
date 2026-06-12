import { FEATURE_SCHEMA_VERSION, featureDimension } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { CoarseGeo, GeoLookup } from '../services/geoip';
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

const DIMENSION = featureDimension(11);

// A stub offline GeoIP: known test IPs -> coarse country/region, others -> null.
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

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function vec(seed: number): number[] {
  return Array.from({ length: DIMENSION }, (_u, j) => 80 + (j % 5) * 12 + Math.sin(seed + j) * 6);
}

interface Account {
  username: string;
  authKey: string;
  fingerprint: string;
}

async function registerAccount(): Promise<Account> {
  const username = uniqueUsername();
  const reg = makeRegistration(username);
  await request(app).post('/auth/register').send(reg.body).expect(201);
  return { username, authKey: reg.authKey, fingerprint: deviceFingerprintHash() };
}

async function login(acct: Account, ip?: string): Promise<string> {
  const req = request(app)
    .post('/auth/login')
    .send({ username: acct.username, authKey: acct.authKey, deviceFingerprintHash: acct.fingerprint });
  if (ip !== undefined) {
    req.set('X-Forwarded-For', ip);
  }
  const res = await req.expect(200);
  return String(res.body.sessionToken);
}

async function failedLogin(acct: Account, ip?: string): Promise<void> {
  const req = request(app).post('/auth/login').send({
    username: acct.username,
    authKey: Buffer.from('wrong-auth-key-000000000000000000').toString('base64'),
    deviceFingerprintHash: acct.fingerprint,
  });
  if (ip !== undefined) {
    req.set('X-Forwarded-For', ip);
  }
  await req.expect(401);
}

async function submit(token: string, seed: number, ip?: string): Promise<void> {
  const req = request(app)
    .post('/enrollment/samples')
    .set('Authorization', bearer(token))
    .send({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: vec(seed) });
  if (ip !== undefined) {
    req.set('X-Forwarded-For', ip);
  }
  await req.expect(201);
}

async function userId(token: string): Promise<string> {
  const me = await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(200);
  return String(me.body.userId);
}

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
  policy_band: string | null;
  geo_country: string | null;
  geo_region: string | null;
  ip_truncated: string | null;
}

async function latest(uid: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, composite_score, policy_band, geo_country, geo_region, ip_truncated
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [uid],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

describe('contextual signals — all four logged with reasons (ADR-0011)', () => {
  it('writes the four contextual sub-scores + the behavioral one in one row', async () => {
    const acct = await registerAccount();
    const token = await login(acct, US_IP);
    await submit(token, 1, US_IP);

    const row = await latest(await userId(token));
    for (const name of ['keystroke', 'newDevice', 'geovelocity', 'timeOfDay', 'failureVelocity'] as const) {
      expect(row.signals[name], `missing signal ${name}`).toBeDefined();
      expect(row.signals[name]?.reason, `missing reason for ${name}`).toBeDefined();
    }
  });

  it('is LOGGED, never ENFORCED — no composite score / policy band set (M9 owns them)', async () => {
    const acct = await registerAccount();
    const token = await login(acct, US_IP);
    await submit(token, 1, US_IP);
    const row = await latest(await userId(token));
    expect(row.composite_score).toBeNull();
    expect(row.policy_band).toBeNull();
  });
});

describe('COLD START — a newcomer is not penalized for lack of history', () => {
  it('history-dependent signals stay neutral on a first login', async () => {
    const acct = await registerAccount();
    const token = await login(acct); // no IP ⇒ geo null
    await submit(token, 1);

    const row = await latest(await userId(token));
    expect(row.signals.geovelocity?.score).toBe(0);
    expect(row.signals.geovelocity?.reason?.status).toBe('insufficient_geo');
    expect(row.signals.timeOfDay?.score).toBe(0);
    expect(row.signals.timeOfDay?.reason?.status).toBe('insufficient_history');
    expect(row.signals.failureVelocity?.score).toBe(0);
    // new-device correctly fires for an unseen device (not a cold-start penalty).
    expect(row.signals.newDevice?.score).toBe(1);
  });
});

describe('new-device signal — returning device', () => {
  it('a second login on the same device is no longer "unseen"', async () => {
    const acct = await registerAccount();
    const token1 = await login(acct);
    await submit(token1, 1);

    const token2 = await login(acct); // same fingerprint ⇒ known device
    await submit(token2, 2);

    const row = await latest(await userId(token2));
    expect(row.signals.newDevice?.score).toBeLessThan(1);
    expect(row.signals.newDevice?.reason?.known).toBe(true);
  });
});

describe('failure-velocity signal', () => {
  it('recent failed logins elevate the score on the next success', async () => {
    const acct = await registerAccount();
    await failedLogin(acct, US_IP);
    await failedLogin(acct, US_IP);
    await failedLogin(acct, US_IP);

    const token = await login(acct, US_IP);
    await submit(token, 1, US_IP);

    const row = await latest(await userId(token));
    expect(row.signals.failureVelocity?.score).toBeGreaterThan(0);
    expect(row.signals.failureVelocity?.reason?.accountFailures).toBeGreaterThanOrEqual(3);
  });
});

describe('geovelocity signal — impossible travel', () => {
  it('US then Japan within seconds scores high', async () => {
    const acct = await registerAccount();
    const t1 = await login(acct, US_IP);
    await submit(t1, 1, US_IP); // establishes the previous location (US)

    const t2 = await login(acct, JP_IP);
    await submit(t2, 2, JP_IP); // current location JP, ~instant ⇒ impossible

    const row = await latest(await userId(t2));
    expect(row.signals.geovelocity?.score).toBeGreaterThan(0.9);
    expect(row.signals.geovelocity?.reason?.prevGeo).toBe('US');
    expect(row.signals.geovelocity?.reason?.currGeo).toBe('JP');
  });
});

describe('PRIVACY — coarse geo + truncated IP only (PROJECT.md §5)', () => {
  it('stores a truncated IP + coarse country, never the full IP or coordinates', async () => {
    const acct = await registerAccount();
    const token = await login(acct, US_IP);
    await submit(token, 1, US_IP);

    const uid = await userId(token);
    const row = await latest(uid);
    expect(row.geo_country).toBe('US');
    expect(row.ip_truncated).toBe('203.0.113.0'); // last octet zeroed
    // The full IP and any precise coordinates must be absent from the whole row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(US_IP);
    expect(serialized).not.toContain('latitude');
    expect(serialized).not.toContain('longitude');
  });
});
