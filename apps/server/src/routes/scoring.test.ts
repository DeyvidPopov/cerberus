import { FEATURE_SCHEMA_VERSION, featureDimension } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

const DIMENSION = featureDimension(11); // 31, the CMU/master-password dimension
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
  composite_score: string;
  policy_band: string;
  action_taken: string;
  outcome: string | null;
}

async function riskEvents(userId: string): Promise<RiskRow[]> {
  const result = await pool.query<RiskRow>(
    `SELECT signals, behavioral_score, composite_score, policy_band, action_taken, outcome
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at`,
    [userId],
  );
  return result.rows;
}

describe('live scoring — an active user is scored and logged (ADR-0010)', () => {
  it('writes a risk_events row with the score + structured reason', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);

    // A post-activation submission is SCORED (not buffered).
    await submit(token, vec(DIMENSION, 42)).expect(201);

    const events = await riskEvents(userId);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) {
      return;
    }

    // A real score in [0,1], mirrored into composite (no other signals yet).
    expect(event.behavioral_score).not.toBeNull();
    const score = Number(event.behavioral_score);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(Number(event.composite_score)).toBeCloseTo(score, 10);
    expect(event.outcome).toBe('scored');

    // Structured, explainable reason: distance, dof, p-value, model metadata.
    const keystroke = event.signals.keystroke;
    expect(keystroke?.score).toBeCloseTo(score, 10);
    const reason = keystroke?.reason ?? {};
    expect(Object.keys(reason).sort()).toEqual(
      ['distance', 'distanceSquared', 'dof', 'modelVersion', 'pValue', 'sampleCount'].sort(),
    );
    expect(reason.dof).toBe(DIMENSION);
  });

  it('is LOGGED, never ENFORCED (policy_band grant, action observed)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    await submit(token, vec(DIMENSION, 7)).expect(201);

    const events = await riskEvents(userId);
    expect(events[0]?.policy_band).toBe('grant'); // never step_up / deny
    expect(events[0]?.action_taken).toBe('observed');
  });

  it('PRIVACY: the risk_events row carries the score + reason, NOT the raw vector', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    // A sentinel feature value that must NOT survive into the log.
    const sample = vec(DIMENSION, 3);
    sample[0] = 31337;
    await submit(token, sample).expect(201);

    const events = await riskEvents(userId);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('31337'); // raw timing is not stored
    expect(serialized).not.toContain('features');
    expect(serialized).not.toContain('vector');
  });
});

describe('live scoring — guards (ADR-0010)', () => {
  it('does NOT score an enrolling user (no baseline yet ⇒ no risk_events)', async () => {
    const { token, userId } = await authedUser();
    await submit(token, vec(DIMENSION, 1)).expect(201);
    await submit(token, vec(DIMENSION, 2)).expect(201);
    expect(await riskEvents(userId)).toHaveLength(0);
  });

  it('records a dimension mismatch as not-scored (never a crash)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    // dim 13 (valid schema, wrong baseline dimension) → not scored.
    await submit(token, vec(featureDimension(5), 9)).expect(201);

    const events = await riskEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('not_scored');
    expect(events[0]?.behavioral_score).toBeNull();
    expect(events[0]?.signals.keystroke?.reason?.cause).toBe('dimension_mismatch');
  });

  it('records a schema-version mismatch as not-scored (never a crash)', async () => {
    const { token, userId } = await authedUser();
    await enrollToActive(token);
    await submit(token, vec(DIMENSION, 5), { featureSchemaVersion: 999 }).expect(201);

    const events = await riskEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('not_scored');
    expect(events[0]?.signals.keystroke?.reason?.cause).toBe('schema_version_mismatch');
  });
});
