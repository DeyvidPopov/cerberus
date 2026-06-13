import { MOUSE_FEATURE_DIMENSION, MOUSE_FEATURE_SCHEMA_VERSION, type MouseWindowMessage } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { testServerConfig } from '../test-support/config';
import { loginGranted, registerAccount, userIdOf } from '../test-support/auth';
import { createTestDb, type TestDb } from '../test-support/postgres';
import { createContinuousAuthService } from './continuous-auth';

// Mouse continuous-auth REUSES the M6 enrollment lifecycle + the M7 scorer
// (ADR-0013): accumulate windows → fit a model-only regularized baseline → purge
// raw → score in-session → spike→lock; cold-start stays neutral.

let db: TestDb;
let pool: Pool;
let config: ServerConfig;
let app: Express;

const MIN = 6;

function makeService() {
  return createContinuousAuthService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    config: { minEnrollmentSamples: MIN, ewmaAlpha: 0.5, spikeThreshold: 0.85 },
  });
}

// A realistic mouse feature centroid (velocity/accel/curvature/clicks/pauses).
const BASE = [0.5, 0.1, 0.05, 0.02, 0.3, 0.1, 1.0, 80, 0.5];

/** Deterministic per-feature jitter so the fitted covariance has real scale. */
function noisy(seed: number): number[] {
  return BASE.map((b, j) => {
    const r = Math.sin(seed * 12.9898 + j * 78.233) * 43758.5453;
    const frac = r - Math.floor(r); // [0,1)
    return b + (frac - 0.5) * 0.24 * (Math.abs(b) + 1); // ±~12%·(|b|+1)
  });
}

function window(features: number[]): MouseWindowMessage {
  return { type: 'mouse_window', featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION, features };
}

const ANOMALOUS = window(BASE.map((b) => b * 100 + 500));

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig();
  app = createApp(pool, config);
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

async function freshUserId(): Promise<string> {
  const acct = await registerAccount(app);
  const token = await loginGranted(app, acct, {});
  return userIdOf(app, token);
}

describe('continuous-auth — mouse baseline reuses the enrollment lifecycle', () => {
  it('accumulates windows → fits a MODEL-ONLY baseline → purges raw → activates', async () => {
    const userId = await freshUserId();
    const svc = makeService();
    const evaluator = svc.newSession();

    for (let i = 1; i <= MIN; i += 1) {
      const res = await evaluator.evaluate(userId, window(noisy(i)));
      expect(res.scored).toBe(false); // still enrolling → cold-start neutral
      expect(res.spike).toBe(false);
    }

    // A mouse baseline is now ACTIVE, model-only, regularized; the raw buffer purged.
    const baseline = await pool.query(
      `SELECT status, sample_count, modality, octet_length(model_blob_encrypted) AS blob_len
       FROM behavioral_baselines WHERE user_id = $1 AND modality = 'mouse'`,
      [userId],
    );
    expect(baseline.rows[0]).toMatchObject({ status: 'active', sample_count: MIN, modality: 'mouse' });
    expect(Number(baseline.rows[0].blob_len)).toBeGreaterThan(0);

    const rawCount = await pool.query(
      `SELECT count(*)::int AS n FROM enrollment_samples WHERE user_id = $1 AND modality = 'mouse'`,
      [userId],
    );
    expect(rawCount.rows[0].n).toBe(0); // data minimization (ADR-0002)

    // Enrolling mouse did NOT create a keystroke baseline (modality separation).
    const keystroke = await pool.query(
      `SELECT count(*)::int AS n FROM behavioral_baselines WHERE user_id = $1 AND modality = 'keystroke'`,
      [userId],
    );
    expect(keystroke.rows[0].n).toBe(0);
  });

  it('scores a matching window LOW and an anomalous window HIGH (reuses the χ² scorer)', async () => {
    const userId = await freshUserId();
    const svc = makeService();
    const enroll = svc.newSession();
    for (let i = 1; i <= MIN; i += 1) {
      await enroll.evaluate(userId, window(noisy(i)));
    }

    const matching = await svc.newSession().evaluate(userId, window(BASE));
    expect(matching.scored).toBe(true);
    expect(matching.subScore).not.toBeNull();
    expect(matching.subScore ?? 1).toBeLessThan(0.3); // near the centroid ⇒ low anomaly

    const anomalous = await svc.newSession().evaluate(userId, ANOMALOUS);
    expect(anomalous.scored).toBe(true);
    expect(anomalous.subScore ?? 0).toBeGreaterThan(0.9); // far from the baseline ⇒ high
  });

  it('a sustained anomaly SPIKES; a normal session does not', async () => {
    const userId = await freshUserId();
    const svc = makeService();
    const enroll = svc.newSession();
    for (let i = 1; i <= MIN; i += 1) {
      await enroll.evaluate(userId, window(noisy(i)));
    }

    // Normal in-session windows never cross the spike threshold.
    const normal = svc.newSession();
    let normalSpiked = false;
    for (let i = 0; i < 10; i += 1) {
      const r = await normal.evaluate(userId, window(noisy(100 + i)));
      normalSpiked = normalSpiked || r.spike;
    }
    expect(normalSpiked).toBe(false);

    // A sustained anomaly spikes within a few windows.
    const attack = svc.newSession();
    let spiked = false;
    for (let i = 0; i < 6 && !spiked; i += 1) {
      const r = await attack.evaluate(userId, ANOMALOUS);
      spiked = r.spike;
    }
    expect(spiked).toBe(true);
  });

  it('cold-start (no active baseline) is NEUTRAL — never a spurious spike', async () => {
    const userId = await freshUserId();
    const svc = makeService();
    const evaluator = svc.newSession();
    // Even strongly anomalous-looking windows just buffer toward the baseline.
    for (let i = 0; i < MIN - 1; i += 1) {
      const r = await evaluator.evaluate(userId, ANOMALOUS);
      expect(r.scored).toBe(false);
      expect(r.spike).toBe(false);
    }
  });

  it('the streamed window is the fixed mouse schema dimension', () => {
    expect(BASE).toHaveLength(MOUSE_FEATURE_DIMENSION);
  });
});
