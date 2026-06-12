import { FEATURE_SCHEMA_VERSION, featureDimension } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// 11-key password (".tie5Roanl"+Return) ⇒ dimension 31.
const DIMENSION = featureDimension(11);
const REQUIRED = 10; // DEFAULT_BEHAVIORAL_CONFIG.minEnrollmentSamples

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

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function vec(dimension: number, seed: number): number[] {
  return Array.from({ length: dimension }, (_unused, j) => 80 + (j % 5) * 12 + Math.sin(seed + j) * 6);
}

async function authedUser(): Promise<{ token: string; userId: string }> {
  const username = uniqueUsername();
  const reg = makeRegistration(username);
  await request(app).post('/auth/register').send(reg.body).expect(201);
  const login = await request(app)
    .post('/auth/login')
    .send({ username, authKey: reg.authKey, deviceFingerprintHash: deviceFingerprintHash() })
    .expect(200);
  const token = String(login.body.sessionToken);
  const me = await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(200);
  return { token, userId: String(me.body.userId) };
}

function submit(token: string, features: number[], extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/enrollment/samples')
    .set('Authorization', bearer(token))
    .send({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, features, ...extra });
}

async function enrollToActive(token: string): Promise<void> {
  for (let i = 1; i <= REQUIRED; i += 1) {
    await submit(token, vec(DIMENSION, i)).expect(201);
  }
}

interface RiskRow {
  signals: { keystroke?: { score: number | null; reason?: Record<string, unknown> } };
  behavioral_score: string | null;
  composite_score: string | null;
  context_score: string | null;
  policy_band: string | null;
  action_taken: string | null;
  outcome: string | null;
}

async function riskEvents(userId: string): Promise<RiskRow[]> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, behavioral_score, composite_score, context_score, policy_band, action_taken, outcome
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at`,
    [userId],
  );
  return result.rows;
}

async function scoredEvents(userId: string): Promise<RiskRow[]> {
  return (await riskEvents(userId)).filter((e) => e.outcome === 'scored');
}

describe('live scoring — an active user is scored and logged (ADR-0010)', () => {
  it('writes a SCORED risk_events row with the behavioral score + structured reason', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);

    // A post-activation submission is SCORED.
    await submit(token, vec(DIMENSION, 42)).expect(201);

    const scored = await scoredEvents(userId);
    expect(scored).toHaveLength(1);
    const event = scored[0];
    expect(event).toBeDefined();
    if (event === undefined) {
      return;
    }

    expect(event.behavioral_score).not.toBeNull();
    const score = Number(event.behavioral_score);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);

    const keystroke = event.signals.keystroke;
    expect(keystroke?.score).toBeCloseTo(score, 10);
    const reason = keystroke?.reason ?? {};
    expect(Object.keys(reason).sort()).toEqual(
      ['distance', 'distanceSquared', 'dof', 'modelVersion', 'pValue', 'sampleCount'].sort(),
    );
    expect(reason.dof).toBe(DIMENSION);
  });

  it('is LOGGED, never ENFORCED — composite/context score, band, and action are NULL (M9 owns them)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    await submit(token, vec(DIMENSION, 7)).expect(201);

    const event = (await scoredEvents(userId))[0];
    expect(event?.composite_score).toBeNull();
    expect(event?.context_score).toBeNull();
    expect(event?.policy_band).toBeNull();
    expect(event?.action_taken).toBeNull();
  });

  it('PRIVACY: the risk_events row carries the score + reason, NOT the raw vector', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    const sample = vec(DIMENSION, 3);
    sample[0] = 31337; // sentinel that must NOT survive into the log
    await submit(token, sample).expect(201);

    const serialized = JSON.stringify(await scoredEvents(userId));
    expect(serialized).not.toContain('31337');
    expect(serialized).not.toContain('features');
    expect(serialized).not.toContain('vector');
  });
});

describe('live scoring — guards (ADR-0010)', () => {
  it('does NOT score an enrolling user (no behavioral score yet)', async () => {
    const { token, userId } = await authedUser();
    await submit(token, vec(DIMENSION, 1)).expect(201);
    await submit(token, vec(DIMENSION, 2)).expect(201);
    // Contextual rows are logged, but none is behaviorally scored.
    expect(await scoredEvents(userId)).toHaveLength(0);
    const all = await riskEvents(userId);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.behavioral_score === null)).toBe(true);
  });

  it('records a dimension mismatch as not-scored (never a crash)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    await submit(token, vec(featureDimension(5), 9)).expect(201); // dim 13, wrong baseline dim

    const notScored = (await riskEvents(userId)).filter((e) => e.outcome === 'not_scored');
    expect(notScored).toHaveLength(1);
    expect(notScored[0]?.behavioral_score).toBeNull();
    expect(notScored[0]?.signals.keystroke?.reason?.cause).toBe('dimension_mismatch');
  });

  it('records a schema-version mismatch as not-scored (never a crash)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    await submit(token, vec(DIMENSION, 5), { featureSchemaVersion: 999 }).expect(201);

    const notScored = (await riskEvents(userId)).filter((e) => e.outcome === 'not_scored');
    expect(notScored).toHaveLength(1);
    expect(notScored[0]?.signals.keystroke?.reason?.cause).toBe('schema_version_mismatch');
  });
});
