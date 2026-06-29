import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { enrolledActiveUser, loginReq, sampleVector, seedConfirmedTotp, totpCode } from '../test-support/auth';
import { testServerConfig } from '../test-support/config';
import { createTestDb, type TestDb } from '../test-support/postgres';

/** The geovelocity sub-score's structured reason (coarse country only). */
function geoReason(row: RiskRow): Record<string, unknown> {
  return (row.signals.geovelocity as { reason?: Record<string, unknown> }).reason ?? {};
}

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

  it('a DENIED / un-passed step-up does NOT move the baseline (no signal poisoning)', async () => {
    // The geovelocity baseline must be the last CONFIRMED login (an issued session), not
    // any password-correct attempt. An attacker who holds the password could otherwise
    // burn the signal with one throwaway far-away attempt: it is denied / stepped-up, yet
    // under the old rule it became the new "previous location", zeroing the next hop.
    const app = createApp(pool, config);
    const { acct, userId } = await enrolledActiveUser(app);
    await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId); // so a step-up is enforceable, not bootstrapped

    // 1. Confirmed US login → a session is issued ⇒ baseline = US.
    await loginReq(app, acct, { sample: sampleVector(3) }).set('X-Demo-Geo', 'US').expect(200);

    // 2. A login from JAPAN is an impossible hop ⇒ step-up (or deny) — either way NO
    //    session is issued. We deliberately do NOT pass the step-up.
    const jp = await loginReq(app, acct, { sample: sampleVector(4) }).set('X-Demo-Geo', 'JP');
    expect(jp.body.status).not.toBe('granted'); // step_up_required or denied — no session either way

    // 3. Back from the US: the baseline is STILL US (the JP attempt left no session), so
    //    this is normal travel — geovelocity stays neutral. (Under the old rule the JP
    //    attempt would have poisoned the baseline and this would falsely spike.)
    await loginReq(app, acct, { sample: sampleVector(5) }).set('X-Demo-Geo', 'US').expect(200);
    const row = await latest(pool, userId);
    expect(subScore(row, 'geovelocity')).toBe(0);
    expect(geoReason(row).prevGeo).toBe('US');
  });

  it('a PASSED step-up advances the baseline so a genuine traveller settles', async () => {
    const app = createApp(pool, config);
    const { acct, userId } = await enrolledActiveUser(app);
    const secret = await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);

    // Confirmed US login → baseline = US.
    await loginReq(app, acct, { sample: sampleVector(3) }).set('X-Demo-Geo', 'US').expect(200);

    // Travel to JAPAN: impossible-travel ⇒ step-up. PASS it ⇒ a JP session is issued,
    // which advances the confirmed-location baseline to Japan.
    const jp = await loginReq(app, acct, { sample: sampleVector(4) }).set('X-Demo-Geo', 'JP');
    expect(jp.body.status).toBe('step_up_required');
    await request(app)
      .post('/auth/step-up/verify')
      .send({ challengeToken: String(jp.body.challengeToken), code: totpCode(secret) })
      .expect(200);

    // A SECOND login from Japan is now normal travel — baseline advanced to JP.
    await loginReq(app, acct, { sample: sampleVector(5) }).set('X-Demo-Geo', 'JP').expect(200);
    const row = await latest(pool, userId);
    expect(subScore(row, 'geovelocity')).toBe(0);
    expect(geoReason(row).prevGeo).toBe('JP');
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
