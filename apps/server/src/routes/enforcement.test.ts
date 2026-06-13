import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { testServerConfig } from '../test-support/config';
import {
  bearer,
  enrolledActiveUser,
  loginGranted,
  loginReq,
  registerAccount,
  sampleVector,
  seedConfirmedTotp,
  totpCode,
  userIdOf,
} from '../test-support/auth';
import { base32Decode, currentCode } from '../services/totp';
import { DEFAULT_TOTP_CONFIG } from '../risk/config';
import { deviceFingerprintHash } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// M9 — the first ENFORCING milestone (ADR-0012): composite → band → grant /
// step_up / deny; TOTP step-up (replay-protected); the newcomer bootstrap;
// fail-closed on suppressed telemetry; and the adaptive brute-force model.

let db: TestDb;
let pool: Pool;
let config: ServerConfig;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig(); // captured for the at-rest TOTP key
  app = createApp(pool, config);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

interface RiskRow {
  signals: { combiner?: { contributions?: Record<string, number> } };
  policy_band: string | null;
  action_taken: string | null;
  composite_score: string | null;
}

async function latest(uid: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, policy_band, action_taken, composite_score
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [uid],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

function newDevice(): string {
  return deviceFingerprintHash();
}

describe('enforcement — policy bands (ADR-0012)', () => {
  it('GRANT: active user, known device, normal typing → a session', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    const res = await loginReq(app, acct, { sample: sampleVector(5) }).expect(200);
    expect(res.body.status).toBe('granted');
    expect((await latest(userId)).policy_band).toBe('grant');
  });

  it('DENY: active user, NEW device, suppressed telemetry → no session (403)', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await loginReq(app, acct, { fingerprint: newDevice() }).expect(403); // no sample ⇒ fail-closed + new device
    expect((await latest(userId)).policy_band).toBe('deny');
    // No session was issued for the denied attempt.
    const sessions = await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId]);
    expect(sessions.rows[0]?.n).toBe(1); // only the enrollment login's session
  });

  it('the combiner stores per-signal contributions (explainable)', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await loginReq(app, acct, { sample: sampleVector(2) }).expect(200);
    const row = await latest(userId);
    const contributions = row.signals.combiner?.contributions ?? {};
    expect(Object.keys(contributions).sort()).toEqual(
      ['behavioral', 'failureVelocity', 'geovelocity', 'newDevice', 'timeOfDay'].sort(),
    );
    expect(row.composite_score).not.toBeNull();
  });
});

describe('enforcement — fail closed + newcomer (ADR-0012)', () => {
  it('FAIL CLOSED → STEP-UP: active+TOTP user, known device, NO sample → step-up (never silent grant)', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);
    const res = await loginReq(app, acct, {}).expect(200); // known device, suppressed telemetry
    expect(res.body.status).toBe('step_up_required');
  });

  it('SUPPRESSION IS NOT A BYPASS: an active user without TOTP who omits the sample is DENIED', async () => {
    // The bypass the review caught: a stolen password on a known device + no
    // keystroke sample must NOT bootstrap-grant — fail closed to denial.
    const { acct, userId } = await enrolledActiveUser(app);
    await loginReq(app, acct, {}).expect(403); // known device, suppressed telemetry, no TOTP
    const row = await latest(userId);
    expect(row.policy_band).toBe('step_up'); // escalated by fail-closed…
    expect(row.action_taken).toBe('denied'); // …but enforced as a denial (no second factor)
  });

  it('NEWCOMER bootstrap: a new user without TOTP is granted despite a step_up band', async () => {
    const acct = await registerAccount(app);
    // First-ever login (unseen device) bands to step_up but has no second factor.
    const res = await loginReq(app, acct, {}).expect(200);
    expect(res.body.status).toBe('granted');
    const row = await latest(await userIdOf(app, res.body.sessionToken as string));
    expect(row.policy_band).toBe('step_up');
    expect(row.action_taken).toBe('step_up_bootstrap_grant');
  });
});

describe('TOTP step-up (RFC 6238, replay-protected)', () => {
  it('STEP-UP: a TOTP user on a new device verifies a code → granted; replay is rejected', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    const secret = await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);

    // New device + a normal sample ⇒ step_up (not deny).
    const stepUp = await loginReq(app, acct, { fingerprint: newDevice(), sample: sampleVector(3) }).expect(200);
    expect(stepUp.body.status).toBe('step_up_required');
    const challengeToken = String(stepUp.body.challengeToken);

    // Correct code → granted session.
    const verified = await request(app)
      .post('/auth/step-up/verify')
      .send({ challengeToken, code: totpCode(secret) })
      .expect(200);
    expect(verified.body.status).toBe('granted');

    // A fresh challenge + the SAME (already-used) code ⇒ replay rejected.
    const stepUp2 = await loginReq(app, acct, { fingerprint: newDevice(), sample: sampleVector(3) }).expect(200);
    await request(app)
      .post('/auth/step-up/verify')
      .send({ challengeToken: String(stepUp2.body.challengeToken), code: totpCode(secret) })
      .expect(401);
  });

  it('rejects a wrong code on a real challenge and an unknown challenge token', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);
    const stepUp = await loginReq(app, acct, { fingerprint: newDevice(), sample: sampleVector(3) }).expect(200);
    expect(stepUp.body.status).toBe('step_up_required');

    // Wrong code on a valid challenge → 401 (and the challenge is retryable).
    await request(app)
      .post('/auth/step-up/verify')
      .send({ challengeToken: String(stepUp.body.challengeToken), code: '000000' })
      .expect(401);
    // An unknown challenge token → 401.
    await request(app)
      .post('/auth/step-up/verify')
      .send({ challengeToken: 'does-not-exist', code: '000000' })
      .expect(401);
  });
});

describe('TOTP enrollment (setup + confirm)', () => {
  it('sets up a secret and confirms it with a valid code; rejects a wrong code', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, {});

    const setup = await request(app).post('/auth/totp/setup').set('Authorization', bearer(token)).expect(200);
    expect(setup.body.provisioningUri).toMatch(/^otpauth:\/\/totp\//u);

    await request(app)
      .post('/auth/totp/confirm')
      .set('Authorization', bearer(token))
      .send({ code: '000000' })
      .expect(400);

    const secret = base32Decode(String(setup.body.secret));
    const code = currentCode(secret, Math.floor(Date.now() / 1000), DEFAULT_TOTP_CONFIG);
    const confirm = await request(app)
      .post('/auth/totp/confirm')
      .set('Authorization', bearer(token))
      .send({ code })
      .expect(200);
    expect(confirm.body.confirmed).toBe(true);
  });

  it('GET /auth/totp/status reports whether a confirmed second factor exists (drives the M10 nudge)', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, {});

    // No secret yet → not confirmed → the vault should nudge enrollment.
    const before = await request(app)
      .get('/auth/totp/status')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(before.body).toEqual({ confirmed: false });

    const setup = await request(app).post('/auth/totp/setup').set('Authorization', bearer(token)).expect(200);
    const secret = base32Decode(String(setup.body.secret));
    await request(app)
      .post('/auth/totp/confirm')
      .set('Authorization', bearer(token))
      .send({ code: currentCode(secret, Math.floor(Date.now() / 1000), DEFAULT_TOTP_CONFIG) })
      .expect(200);

    // Confirmed → the nudge stops showing.
    const after = await request(app)
      .get('/auth/totp/status')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(after.body).toEqual({ confirmed: true });

    // The status endpoint requires a session.
    await request(app).get('/auth/totp/status').expect(401);
  });
});
