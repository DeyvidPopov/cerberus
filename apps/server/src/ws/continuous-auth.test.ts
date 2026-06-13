import { createServer, type Server } from 'node:http';

import {
  CONTINUOUS_AUTH_WS_PATH,
  MOUSE_FEATURE_SCHEMA_VERSION,
  type ContinuousAuthServerMessage,
} from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { createContinuousAuthService } from '../services/continuous-auth';
import { bearer, loginGranted, registerAccount, userIdOf } from '../test-support/auth';
import { testServerConfig } from '../test-support/config';
import { createTestDb, type TestDb } from '../test-support/postgres';
import { attachContinuousAuthWebSocket } from './index';

let db: TestDb;
let pool: Pool;
let config: ServerConfig;
let app: Express;
let server: Server;
let url: string;

const MIN = 6;
const BASE = [0.5, 0.1, 0.05, 0.02, 0.3, 0.1, 1.0, 80, 0.5];

function noisy(seed: number): number[] {
  return BASE.map((b, j) => {
    const r = Math.sin(seed * 12.9898 + j * 78.233) * 43758.5453;
    return b + (r - Math.floor(r) - 0.5) * 0.24 * (Math.abs(b) + 1);
  });
}
function frame(features: number[]): string {
  return JSON.stringify({ type: 'mouse_window', featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION, features });
}
const NORMAL = (i: number): string => frame(noisy(i));
const ANOMALOUS = frame(BASE.map((b) => b * 100 + 500));

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig();
  app = createApp(pool, config);
  server = createServer(app);
  const continuousAuth = createContinuousAuthService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    config: { minEnrollmentSamples: MIN, ewmaAlpha: 0.5, spikeThreshold: 0.85 },
  });
  attachContinuousAuthWebSocket(server, { pool, continuousAuth });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  url = `ws://127.0.0.1:${String(port)}${CONTINUOUS_AUTH_WS_PATH}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.teardown();
});

function openSocket(token: string | null): WebSocket {
  const options = token === null ? {} : { headers: { authorization: bearer(token) } };
  return new WebSocket(url, [], options);
}

/** Resolve 'open' or 'rejected' for a connection attempt (used for the auth tests). */
function attempt(token: string | null): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = openSocket(token);
    let settled = false;
    const done = (r: 'open' | 'rejected'): void => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(r);
      }
    };
    ws.on('open', () => {
      done('open');
    });
    ws.on('error', () => {
      done('rejected');
    });
    ws.on('unexpected-response', () => {
      done('rejected');
    });
  });
}

/** Open a session socket, stream the given frames, and resolve true iff a `locked` arrives. */
function streamAndWatch(token: string, frames: string[], waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = openSocket(token);
    let locked = false;
    const finish = (): void => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(locked);
    };
    const timer = setTimeout(finish, waitMs);
    ws.on('open', () => {
      for (const f of frames) {
        ws.send(f);
      }
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ContinuousAuthServerMessage;
      if (msg.type === 'locked') {
        locked = true;
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function sessionUser(): Promise<{ token: string; userId: string }> {
  const acct = await registerAccount(app);
  const token = await loginGranted(app, acct, {});
  return { token, userId: await userIdOf(app, token) };
}

describe('continuous-auth WebSocket (ADR-0013)', () => {
  it('rejects an unauthenticated stream and an invalid token (fail closed)', async () => {
    expect(await attempt(null)).toBe('rejected');
    expect(await attempt('not-a-real-session-token')).toBe('rejected');
  });

  it('accepts a valid session', async () => {
    const { token } = await sessionUser();
    expect(await attempt(token)).toBe('open');
  });

  it('a sustained in-session spike LOCKS the vault (fail closed) and logs the decision', async () => {
    const { token, userId } = await sessionUser();
    const frames = [...Array.from({ length: MIN }, (_v, i) => NORMAL(i + 1)), ...Array(6).fill(ANOMALOUS)];

    const locked = await streamAndWatch(token, frames, 5000);
    expect(locked).toBe(true);

    // The session is locked: the bearer token no longer authenticates → re-unlock required.
    await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(401);

    // The lock decision is recorded with the mouse signal — but NOT the raw window.
    const events = await pool.query(
      `SELECT signals, composite_score, policy_band, action_taken
       FROM risk_events WHERE user_id = $1 AND action_taken = 'session_locked'`,
      [userId],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
    const row = events.rows[0];
    expect(row.policy_band).toBe('deny');
    const signals = JSON.stringify(row.signals);
    expect(signals).toContain('mouse');
    // PRIVACY: no raw feature vector is stored beside identity (only score + reason).
    expect(signals).not.toContain('"features"');
    expect(signals).not.toContain('8500'); // a raw anomalous feature value (80·100+500)
  }, 20_000);

  it('a normal in-session stream does NOT lock', async () => {
    const { token } = await sessionUser();
    const frames = Array.from({ length: MIN + 12 }, (_v, i) => NORMAL(i + 1));
    const locked = await streamAndWatch(token, frames, 1500);
    expect(locked).toBe(false);
    await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(200);
  }, 20_000);

  it('cold-start (no active baseline) does NOT spuriously lock', async () => {
    const { token } = await sessionUser();
    // Fewer windows than the enrollment threshold, all anomalous-looking: they only
    // buffer toward the baseline; nothing is scored, so nothing can spike.
    const frames = Array(MIN - 1).fill(ANOMALOUS);
    const locked = await streamAndWatch(token, frames, 1500);
    expect(locked).toBe(false);
    await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(200);
  }, 20_000);
});
