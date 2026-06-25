import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  CONTINUOUS_AUTH_WS_PATH,
  MOUSE_FEATURE_SCHEMA_VERSION,
} from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import type { ServerConfig } from '../config';
import { createContinuousAuthService } from '../services/continuous-auth';
import {
  DIMENSION,
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
import { testServerConfig } from '../test-support/config';
import { deviceFingerprintHash } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// DEMO-READINESS evidence suite (PROJECT.md §6 — security properties demonstrated
// by tests, not prose). Each case exercises the live HTTP/WS surface against a real
// ephemeral Postgres and asserts the recorded risk_events row where relevant, so
// the suite doubles as the thesis demo's evidence. Covers the zero-knowledge store,
// the adaptive bands (grant / step-up / deny / bootstrap), fail-closed suppression,
// the brute-force model, continuous-auth lock, cold-start, and the gated inspector.

const MOUSE_MIN = 6;
// A neutral mouse window and a wildly anomalous one (mirrors the ws unit test).
const MOUSE_BASE = [0.5, 0.1, 0.05, 0.02, 0.3, 0.1, 1.0, 80, 0.5];
function mouseNoisy(seed: number): number[] {
  return MOUSE_BASE.map((b, j) => {
    const r = Math.sin(seed * 12.9898 + j * 78.233) * 43758.5453;
    return b + (r - Math.floor(r) - 0.5) * 0.24 * (Math.abs(b) + 1);
  });
}
function mouseFrame(features: number[]): string {
  return JSON.stringify({ type: 'mouse_window', featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION, features });
}
const MOUSE_NORMAL = (i: number): string => mouseFrame(mouseNoisy(i));
const MOUSE_ANOMALOUS = mouseFrame(MOUSE_BASE.map((b) => b * 100 + 500));

/** A keystroke vector that is far from the enrollment baseline ⇒ behavioral score → 1. */
function anomalousSample(): number[] {
  return Array.from({ length: DIMENSION }, () => 5000);
}

let db: TestDb;
let pool: Pool;
let config: ServerConfig;
let app: Express;
let server: Server;
let wsUrl: string;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  config = testServerConfig();
  app = createApp(pool, config);
  server = createServer(app);
  const continuousAuth = createContinuousAuthService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    config: { minEnrollmentSamples: MOUSE_MIN, ewmaAlpha: 0.5, spikeThreshold: 0.85 },
  });
  // Wire the real continuous-auth WS so the spike→lock path is exercised end to end.
  const { attachContinuousAuthWebSocket } = await import('../ws');
  attachContinuousAuthWebSocket(server, { pool, continuousAuth });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  wsUrl = `ws://127.0.0.1:${String(port)}${CONTINUOUS_AUTH_WS_PATH}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.teardown();
});

interface RiskRow {
  id: string;
  signals: Record<string, unknown>;
  behavioral_score: string | null;
  composite_score: string | null;
  policy_band: string | null;
  action_taken: string | null;
}

async function latest(userId: string): Promise<RiskRow> {
  const result = await pool.query<RiskRow>(
    `SELECT id, signals, behavioral_score, composite_score, policy_band, action_taken
     FROM risk_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('no risk_events row');
  }
  return row;
}

async function eventIds(userId: string): Promise<Set<string>> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM risk_events WHERE user_id = $1`, [userId]);
  return new Set(result.rows.map((r) => r.id));
}

function subScore(row: RiskRow, signal: string): number | null {
  const s = row.signals[signal];
  if (typeof s === 'object' && s !== null && 'score' in s) {
    const score = (s as { score: unknown }).score;
    return typeof score === 'number' ? score : null;
  }
  return null;
}

/** Drive a full TOTP step-up → a GRANTED, step-up-confirmed session token. */
async function stepUpConfirmedSession(): Promise<{ token: string; userId: string }> {
  const { acct, userId } = await enrolledActiveUser(app);
  const secret = await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);
  const stepUp = await loginReq(app, acct, {
    fingerprint: deviceFingerprintHash(),
    sample: sampleVector(3),
  }).expect(200);
  expect(stepUp.body.status).toBe('step_up_required');
  const verified = await request(app)
    .post('/auth/step-up/verify')
    .send({ challengeToken: String(stepUp.body.challengeToken), code: totpCode(secret) })
    .expect(200);
  expect(verified.body.status).toBe('granted');
  return { token: String(verified.body.sessionToken), userId };
}

/** Open a session socket, stream frames, resolve true iff a `locked` message arrives. */
function streamAndWatch(token: string, frames: string[], waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, [], { headers: { authorization: bearer(token) } });
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
      const msg = JSON.parse(data.toString()) as { type?: string };
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

describe('demo-readiness — security evidence (a)-(j)', () => {
  it('(a) zero-knowledge: a stored credential row is opaque ciphertext, no plaintext columns', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, {});
    const id = randomUUID();
    const ciphertext = randomBytes(64).toString('base64'); // opaque AEAD blob (server can't decrypt)
    const nonce = randomBytes(24).toString('base64');
    await request(app)
      .post('/vault/items')
      .set('Authorization', bearer(token))
      .send({ id, ciphertext, nonce, itemType: 'login' })
      .expect(201);

    const row = (await pool.query('SELECT * FROM vault_items WHERE id = $1', [id])).rows[0] as Record<
      string,
      unknown
    >;
    // The server stored EXACTLY the opaque blob the client sent — it never decrypts.
    expect(Buffer.isBuffer(row.ciphertext)).toBe(true);
    expect((row.ciphertext as Buffer).toString('base64')).toBe(ciphertext);
    // The row has ONLY opaque ciphertext + non-secret metadata — no plaintext column.
    expect(Object.keys(row).sort()).toEqual(
      ['ciphertext', 'created_at', 'id', 'item_type', 'nonce', 'revision', 'updated_at', 'user_id'].sort(),
    );
    // The auth key is stored only as a HASH; the raw login proof is never persisted.
    const user = (await pool.query('SELECT * FROM users WHERE username = $1', [acct.username])).rows[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(user)).not.toContain(acct.authKey);
  });

  it('(b) a genuine low-risk login (active baseline, known device, normal typing) → GRANTED, no step-up', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    const res = await loginReq(app, acct, { sample: sampleVector(5) }).expect(200);
    expect(res.body.status).toBe('granted');
    const row = await latest(userId);
    expect(row.policy_band).toBe('grant');
    expect(row.action_taken).toBe('granted');
  });

  it('(c) a behavioral anomaly pushes the composite across the STEP-UP band', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId); // a usable 2nd factor
    // Known device, but typing that is FAR from the baseline ⇒ behavioral score → 1.
    const res = await loginReq(app, acct, { sample: anomalousSample() }).expect(200);
    expect(res.body.status).toBe('step_up_required');
    const row = await latest(userId);
    expect(row.policy_band).toBe('step_up');
    expect(Number(row.composite_score)).toBeGreaterThanOrEqual(config.policy.thresholds.stepUp);
    // ISOLATE the driver: the behavioral score is high enough that the behavioral
    // contribution ALONE (score · weight) clears the step-up threshold — so the
    // crossing is attributable to the anomaly, not to a stacked contextual signal.
    expect(Number(row.behavioral_score)).toBeGreaterThanOrEqual(
      config.policy.thresholds.stepUp / config.policy.weights.behavioral,
    );
  });

  it('(d) the new-device signal contributes to the risk_events breakdown', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    await loginReq(app, acct, { fingerprint: deviceFingerprintHash(), sample: sampleVector(4) }).expect(200);
    const row = await latest(userId);
    // unseen device ⇒ newDevice sub-score saturates (config.newDevice.unseenScore = 1).
    expect(subScore(row, 'newDevice')).toBe(config.contextual.newDevice.unseenScore);
  });

  it('(e) fail-closed: suppressed behavioral telemetry on an active baseline ESCALATES, never grants', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    // Active baseline + NO keystroke sample + no TOTP ⇒ suppression is not a bypass.
    await loginReq(app, acct, {}).expect(403);
    const row = await latest(userId);
    expect(row.policy_band).toBe('step_up'); // escalated by fail-closed
    expect(row.action_taken).toBe('denied'); // enforced as a denial (no 2nd factor)
    expect(row.action_taken).not.toBe('granted');
  });

  it('(f) a continuous-auth spike LOCKS the session (fail closed) and records it', async () => {
    const acct = await registerAccount(app);
    const token = await loginGranted(app, acct, {});
    const userId = await userIdOf(app, token);
    const frames = [
      ...Array.from({ length: MOUSE_MIN }, (_v, i) => MOUSE_NORMAL(i + 1)),
      ...Array<string>(6).fill(MOUSE_ANOMALOUS),
    ];
    const locked = await streamAndWatch(token, frames, 5000);
    expect(locked).toBe(true);
    // The session token no longer authenticates — re-unlock required (fail closed).
    await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(401);
    const lockRow = await pool.query(
      `SELECT policy_band, action_taken FROM risk_events
       WHERE user_id = $1 AND action_taken = 'session_locked'`,
      [userId],
    );
    expect(lockRow.rows.length).toBeGreaterThanOrEqual(1);
    expect(lockRow.rows[0].policy_band).toBe('deny');
  }, 20_000);

  it('(g) brute-force: repeated failures raise risk but do NOT hard-lock — a correct login still succeeds', async () => {
    const acct = await registerAccount(app);
    const ip = '203.0.113.50';
    // Establish a known device + a session (so the later success is not new-device noise).
    await loginGranted(app, acct, { ip });
    const userId = await userIdOf(app, await loginGranted(app, acct, { ip }));

    // Several WRONG-password attempts from the same IP: each is a 401 (never a 429 lock).
    for (let i = 0; i < 6; i += 1) {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: acct.username, authKey: randomBytes(32).toString('base64'), deviceFingerprintHash: acct.fingerprint })
        .expect(401);
    }
    // The correct login STILL succeeds (no hard account lock) …
    const ok = await loginReq(app, acct, { ip, sample: sampleVector(7) }).expect(200);
    expect(['granted', 'step_up_required']).toContain(String(ok.body.status));
    expect(ok.status).not.toBe(429);
    // … and the failures DID raise risk (failure-velocity contributed to the row).
    const row = await latest(userId);
    expect(subScore(row, 'failureVelocity')).toBeGreaterThan(0);
  });

  it('(h) cold-start: a brand-new user with no history is NOT penalized behaviorally', async () => {
    const acct = await registerAccount(app);
    const res = await loginReq(app, acct, { sample: sampleVector(1) }).expect(200);
    // First-ever login: gets in via the newcomer bootstrap (never silently denied for lack of history).
    expect(res.body.status).toBe('granted');
    const row = await latest(await userIdOf(app, String(res.body.sessionToken)));
    expect(row.action_taken).toBe('step_up_bootstrap_grant');
    // Behavioral is cold-start NEUTRAL: sub-score 0, confidence low, no scored penalty.
    expect(subScore(row, 'keystroke')).toBe(0);
    expect(row.behavioral_score).toBeNull();
    const keystroke = row.signals.keystroke as { confidence?: string };
    expect(keystroke.confidence).toBe('low');
  });

  it('(i) inspector gating: non-step-up DENIED, step-up ALLOWED, and scoped to the caller', async () => {
    // A non-step-up (direct-grant) session is refused server-side (not by hiding a button).
    const plainAcct = await registerAccount(app);
    const plainToken = await loginGranted(app, plainAcct, {});
    await request(app).get('/risk/events').set('Authorization', bearer(plainToken)).expect(403);
    // No bearer at all → 401.
    await request(app).get('/risk/events').expect(401);

    // A step-up-confirmed session is allowed and sees ONLY its own events.
    const other = await enrolledActiveUser(app); // a DIFFERENT user with its own risk events
    const { token, userId } = await stepUpConfirmedSession();
    const res = await request(app).get('/risk/events').set('Authorization', bearer(token)).expect(200);

    const mine = await eventIds(userId);
    const theirs = await eventIds(other.userId);
    const returned: string[] = res.body.events.map((e: { id: string }) => e.id);
    expect(returned.length).toBeGreaterThan(0);
    // Every returned event is the caller's own; none belongs to the other user (no IDOR).
    for (const id of returned) {
      expect(mine.has(id)).toBe(true);
      expect(theirs.has(id)).toBe(false);
    }
    // PRIVACY: the inspector payload carries scores/reasons only — never a raw vector.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('"features"');
  });

  it('(j) voluntary step-up: a granted session elevates IN PLACE with TOTP → inspector unlocks', async () => {
    const { acct, userId } = await enrolledActiveUser(app);
    const secret = await seedConfirmedTotp(pool, config.baselineEncryptionKey, userId);
    // A genuine low-risk login → GRANTED (NOT step-up-confirmed): the inspector is gated.
    const granted = await loginReq(app, acct, { sample: sampleVector(5) }).expect(200);
    expect(granted.body.status).toBe('granted');
    const token = String(granted.body.sessionToken);
    await request(app).get('/risk/events').set('Authorization', bearer(token)).expect(403);

    // Unauthenticated elevate → 401; a WRONG code does NOT elevate (fail closed) → still 403.
    await request(app).post('/auth/step-up/elevate').send({ code: '000000' }).expect(401);
    await request(app).post('/auth/step-up/elevate').set('Authorization', bearer(token)).send({ code: '000000' }).expect(401);
    await request(app).get('/risk/events').set('Authorization', bearer(token)).expect(403);

    // The CORRECT TOTP code elevates THIS session in place (no new token) → inspector allowed.
    const elevated = await request(app)
      .post('/auth/step-up/elevate')
      .set('Authorization', bearer(token))
      .send({ code: totpCode(secret) })
      .expect(200);
    expect(elevated.body.status).toBe('confirmed');
    await request(app).get('/risk/events').set('Authorization', bearer(token)).expect(200);
  });
});
