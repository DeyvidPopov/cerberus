import type { Express } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { testServerConfig } from '../test-support/config';
import {
  enrolledActiveUser,
  loginGranted,
  loginReq,
  registerAccount,
  sampleVector,
  userIdOf,
} from '../test-support/auth';
import { featureDimension } from '@cerberus/shared-types';
import { createTestDb, type TestDb } from '../test-support/postgres';

// M9: behavioral scoring runs at the LOGIN decision point (the keystroke sample is
// sent with /auth/login). These tests assert the behavioral leg of the login
// risk_events row (ADR-0010 scorer reused, ADR-0012 enforcement point).

let db: TestDb;
let pool: Pool;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  app = createApp(pool, testServerConfig());
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

interface Keystroke {
  score: number | null;
  confidence?: string;
  reason?: Record<string, unknown>;
}
interface RiskRow {
  signals: { keystroke?: Keystroke };
  behavioral_score: string | null;
  policy_band: string | null;
  action_taken: string | null;
}

async function latest(userId: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, behavioral_score, policy_band, action_taken
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

describe('behavioral scoring at login (ADR-0010/0012)', () => {
  it('scores an active user’s keystroke sample (score + structured reason)', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    // Log in from the SAME device with a sample close to the enrollment data.
    await loginGranted(app, acct, { sample: sampleVector(3) });

    const row = await latest(userId);
    const keystroke = row.signals.keystroke;
    expect(keystroke?.confidence).toBe('normal');
    expect(typeof keystroke?.score).toBe('number');
    expect(row.behavioral_score).not.toBeNull();
    expect(Object.keys(keystroke?.reason ?? {})).toEqual(
      expect.arrayContaining(['distance', 'dof', 'pValue']),
    );
  });

  it('FAILS CLOSED when an active user sends no sample (suppression is not a bypass)', async () => {
    const { acct, userId } = await enrolledActiveUser(app); // no TOTP enrolled
    await loginReq(app, acct, {}).expect(403); // no sample ⇒ fail closed, no second factor ⇒ denied

    const row = await latest(userId);
    expect(row.signals.keystroke?.confidence).toBe('missing');
    expect(row.signals.keystroke?.reason?.status).toBe('missing_sample');
    expect(row.policy_band).toBe('step_up'); // escalated…
    expect(row.action_taken).toBe('denied'); // …and enforced as denial
  });

  it('FAILS CLOSED on a dimension mismatch (a malformed sample is not a bypass)', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await loginReq(app, acct, { sample: sampleVector(1, featureDimension(5)) }).expect(403); // dim 13

    const row = await latest(userId);
    expect(row.signals.keystroke?.confidence).toBe('missing');
    expect(row.signals.keystroke?.reason?.cause).toBe('dimension_mismatch');
  });

  it('an enrolling user’s login is cold-start neutral (not penalized)', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, { sample: sampleVector(1) });
    const row = await latest(await userIdOf(app, token));
    expect(row.signals.keystroke?.confidence).toBe('low');
    expect(row.signals.keystroke?.reason?.status).toBe('enrolling');
    expect(row.behavioral_score).toBeNull(); // no real score yet
  });

  it('PRIVACY: the row carries the score + reason, NOT the raw vector', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    const sample = sampleVector(2);
    sample[0] = 31337; // sentinel
    await loginGranted(app, acct, { sample });
    const serialized = JSON.stringify(await latest(userId));
    expect(serialized).not.toContain('31337');
    expect(serialized).not.toContain('"features"');
  });
});
