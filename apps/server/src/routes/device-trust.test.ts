import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { enrolledActiveUser, loginReq, sampleVector } from '../test-support/auth';
import { testServerConfig } from '../test-support/config';
import { createTestDb, type TestDb } from '../test-support/postgres';

// Device trust (ADR-0017): a returning device scores known-UNTRUSTED (0.3) until it has
// earned trust through CONFIRMED logins on enough DISTINCT days, after which it is
// known-TRUSTED (0) and no longer contributes to risk. Trust is sustained real use over
// time — not mere elapsed days, and not denied/un-passed attempts (which issue no session).

interface RiskRow {
  signals: Record<string, unknown>;
}

async function latestNewDeviceScore(pool: Pool, userId: string): Promise<number | null> {
  const result = await pool.query<RiskRow>(
    `SELECT signals FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [userId],
  );
  const s = result.rows[0]?.signals.newDevice;
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

describe('device trust — earned by sustained use over distinct days (ADR-0017)', () => {
  it('a device used on enough distinct days graduates known-untrusted (0.3) → trusted (0)', async () => {
    const trustDays = config.contextual.newDevice.trustAfterDistinctDays; // 5
    const app = createApp(pool, config);
    const { acct, userId } = await enrolledActiveUser(app); // active baseline; one device, sessions today

    const dev = await pool.query<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [userId]);
    const deviceId = dev.rows[0]?.id;
    expect(deviceId).toBeTruthy();

    // A returning login today scores the device known-UNTRUSTED (0.3) and does not yet
    // qualify (only one distinct day of use).
    await loginReq(app, acct, { sample: sampleVector(2) }).expect(200);
    expect(await latestNewDeviceScore(pool, userId)).toBe(0.3);
    const before = await pool.query<{ trusted: boolean }>(`SELECT trusted FROM devices WHERE id = $1`, [deviceId]);
    expect(before.rows[0]?.trusted).toBe(false);

    // Backdate confirmed logins onto (trustDays − 1) earlier DISTINCT days; today is the last.
    for (let d = 1; d <= trustDays - 1; d += 1) {
      await pool.query(
        `INSERT INTO sessions (user_id, device_id, token_hash, expires_at, is_new_device, step_up_confirmed, created_at)
         VALUES ($1, $2, $3, now() + interval '1 hour', false, false, now() - ($4::int * interval '1 day'))`,
        [userId, deviceId, `seed-trust-${String(d)}`, String(d)],
      );
    }

    // One more confirmed login (today = the trustDays-th distinct day) promotes the device.
    await loginReq(app, acct, { sample: sampleVector(3) }).expect(200);
    const after = await pool.query<{ trusted: boolean }>(`SELECT trusted FROM devices WHERE id = $1`, [deviceId]);
    expect(after.rows[0]?.trusted).toBe(true);

    // From now on the trusted device scores 0 — no longer a contributor.
    await loginReq(app, acct, { sample: sampleVector(4) }).expect(200);
    expect(await latestNewDeviceScore(pool, userId)).toBe(0);
  });

  it('does NOT trust a device used many times on a SINGLE day (sustained over time, not volume)', async () => {
    const app = createApp(pool, config);
    const { acct, userId } = await enrolledActiveUser(app);
    const dev = await pool.query<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [userId]);
    const deviceId = dev.rows[0]?.id;

    // Many confirmed logins, all TODAY (one distinct day) — must not earn trust.
    for (let i = 0; i < 6; i += 1) {
      await loginReq(app, acct, { sample: sampleVector(i + 2) }).expect(200);
    }
    const row = await pool.query<{ trusted: boolean }>(`SELECT trusted FROM devices WHERE id = $1`, [deviceId]);
    expect(row.rows[0]?.trusted).toBe(false);
    expect(await latestNewDeviceScore(pool, userId)).toBe(0.3);
  });
});
