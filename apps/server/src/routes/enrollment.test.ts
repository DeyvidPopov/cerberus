import { FEATURE_SCHEMA_VERSION, featureDimension } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { decryptBaselineModel } from '../services/baseline-crypto';
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// 11-key password (".tie5Roanl"+Return) ⇒ dimension 31.
const DIMENSION = featureDimension(11);
const REQUIRED = 10; // DEFAULT_BEHAVIORAL_CONFIG.minEnrollmentSamples

let db: TestDb;
let pool: Pool;
let config: ServerConfig;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig(); // capture the at-rest key so the test can decrypt
  app = createApp(pool, config);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

function bearer(token: string): string {
  return `Bearer ${token}`;
}

// A valid feature vector of the given dimension, varied by seed so a fitted
// covariance is non-degenerate. Durations only — never characters.
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

describe('enrollment lifecycle — accumulate → fit → store model-only → purge → active', () => {
  it('reports progress, activates at the threshold, and purges the raw samples', async () => {
    const { token, userId } = await authedUser();

    const initial = await request(app)
      .get('/enrollment/status')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(initial.body).toEqual({
      status: 'enrolling',
      samplesCollected: 0,
      samplesRequired: REQUIRED,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    });

    // Submit up to one-below the threshold: still enrolling, no baseline yet.
    for (let i = 1; i < REQUIRED; i += 1) {
      const res = await submit(token, vec(DIMENSION, i)).expect(201);
      expect(res.body.status).toBe('enrolling');
      expect(res.body.samplesCollected).toBe(i);
    }
    const midBaseline = await pool.query(
      `SELECT 1 FROM behavioral_baselines WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    expect(midBaseline.rowCount).toBe(0);

    // The threshold sample activates the baseline.
    const activated = await submit(token, vec(DIMENSION, REQUIRED)).expect(201);
    expect(activated.body.status).toBe('active');

    // Raw enrollment samples are PURGED (data minimization, ADR-0002).
    const remaining = await pool.query(
      `SELECT count(*)::int AS n FROM enrollment_samples WHERE user_id = $1`,
      [userId],
    );
    expect(remaining.rows[0]?.n).toBe(0);

    // A baseline row exists, MODEL-ONLY and encrypted at rest.
    const row = await pool.query<{
      status: string;
      sample_count: number;
      feature_schema_version: number;
      model_blob_encrypted: Buffer;
      model_nonce: Buffer;
    }>(
      `SELECT status, sample_count, feature_schema_version, model_blob_encrypted, model_nonce
       FROM behavioral_baselines WHERE user_id = $1`,
      [userId],
    );
    const baseline = row.rows[0];
    expect(baseline).toBeDefined();
    if (baseline === undefined) {
      return;
    }
    expect(baseline.status).toBe('active');
    expect(baseline.sample_count).toBe(REQUIRED);
    expect(baseline.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(baseline.model_blob_encrypted.length).toBeGreaterThan(0);
    expect(baseline.model_nonce.length).toBe(12);

    // The stored blob decrypts (server-managed key + AAD-bound to user) to a
    // MODEL (mean + covariance) — and NOTHING resembling raw samples.
    const model: unknown = JSON.parse(
      decryptBaselineModel(
        { ciphertext: baseline.model_blob_encrypted, nonce: baseline.model_nonce },
        userId,
        config.baselineEncryptionKey,
      ).toString('utf8'),
    );
    expect(model).toMatchObject({ dimension: DIMENSION, sampleCount: REQUIRED });
    const keys = Object.keys(model as Record<string, unknown>).sort();
    expect(keys).toEqual(
      ['covariance', 'dimension', 'featureSchemaVersion', 'mean', 'modelVersion', 'ridge', 'sampleCount', 'shrinkage'].sort(),
    );
    expect(keys).not.toContain('samples');
    expect(keys).not.toContain('features');

    // Status now reports active.
    const finalStatus = await request(app)
      .get('/enrollment/status')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(finalStatus.body.status).toBe('active');
  });

  it('is idempotent after activation — extra samples are not buffered', async () => {
    const { token, userId } = await authedUser();
    for (let i = 1; i <= REQUIRED; i += 1) {
      await submit(token, vec(DIMENSION, i)).expect(201);
    }
    const res = await submit(token, vec(DIMENSION, 99)).expect(201);
    expect(res.body.status).toBe('active');
    const buffered = await pool.query(
      `SELECT count(*)::int AS n FROM enrollment_samples WHERE user_id = $1`,
      [userId],
    );
    expect(buffered.rows[0]?.n).toBe(0); // still purged; nothing re-buffered
  });
});

describe('enrollment privacy / data-minimization (PROJECT.md §5, ADR-0002)', () => {
  it('PRIVACY: stores numbers only — strips any smuggled character/key field', async () => {
    const { token, userId } = await authedUser();
    await submit(token, vec(DIMENSION, 1), {
      password: 'hunter2',
      keys: ['t', 'i', 'e', '5'],
      characters: '.tie5Roanl',
    }).expect(201);

    const stored = await pool.query<{ feature_vector: unknown }>(
      `SELECT feature_vector FROM enrollment_samples WHERE user_id = $1`,
      [userId],
    );
    const vector = stored.rows[0]?.feature_vector;
    expect(Array.isArray(vector)).toBe(true);
    expect((vector as unknown[]).every((x) => typeof x === 'number')).toBe(true);

    // The captured vector itself is digits only — no character/key identity.
    expect(JSON.stringify(vector)).not.toMatch(/[a-zA-Z]/u);

    // The smuggled fields were stripped at the zod boundary and never stored.
    const whole = JSON.stringify(stored.rows[0]);
    expect(whole).not.toContain('hunter2');
    expect(whole).not.toContain('tie');
    expect(whole).not.toContain('.tie5Roanl');
  });

  it('PRIVACY: the enrollment_samples table has no plaintext credential column', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'enrollment_samples'`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      ['captured_at', 'feature_schema_version', 'feature_vector', 'id', 'modality', 'user_id'].sort(),
    );
  });

  it('PRIVACY: the status endpoint returns only counts — never a raw vector', async () => {
    const { token } = await authedUser();
    await submit(token, vec(DIMENSION, 1)).expect(201);
    const status = await request(app)
      .get('/enrollment/status')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(Object.keys(status.body).sort()).toEqual(
      ['featureSchemaVersion', 'samplesCollected', 'samplesRequired', 'status'].sort(),
    );
  });

  it("PRIVACY: enrollment is user-scoped — one user's samples never reach another (no IDOR)", async () => {
    const alice = await authedUser();
    const bob = await authedUser();
    await submit(alice.token, vec(DIMENSION, 1)).expect(201);
    await submit(alice.token, vec(DIMENSION, 2)).expect(201);

    const bobStatus = await request(app)
      .get('/enrollment/status')
      .set('Authorization', bearer(bob.token))
      .expect(200);
    expect(bobStatus.body.samplesCollected).toBe(0);
  });
});

describe('enrollment validation & auth', () => {
  it('requires a session on every endpoint (fail closed)', async () => {
    await request(app).get('/enrollment/status').expect(401);
    await request(app)
      .post('/enrollment/samples')
      .send({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: vec(DIMENSION, 1) })
      .expect(401);
  });

  it('rejects a malformed body with a generic 400 (no echo)', async () => {
    const { token } = await authedUser();
    await request(app)
      .post('/enrollment/samples')
      .set('Authorization', bearer(token))
      .send({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: [1, 2, 3] }) // bad dimension
      .expect(400);
  });

  it('rejects a feature-schema-version mismatch with 409', async () => {
    const { token } = await authedUser();
    await submit(token, vec(DIMENSION, 1), { featureSchemaVersion: 999 }).expect(409);
  });

  it('rejects a dimension change mid-enrollment with 400', async () => {
    const { token } = await authedUser();
    await submit(token, vec(DIMENSION, 1)).expect(201); // dim 31
    await submit(token, vec(featureDimension(5), 2)).expect(400); // dim 13
  });
});
