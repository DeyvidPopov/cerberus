// Shared HTTP helpers for the M9 login-based flow (the keystroke sample is sent
// WITH login; enrollment buffers via /enrollment/samples). Keeps the route tests
// focused on behavior rather than request plumbing.
import { FEATURE_SCHEMA_VERSION, featureDimension } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';

import { DEFAULT_TOTP_CONFIG } from '../risk/config';
import { seal } from '../services/secretbox';
import { base32Decode, currentCode, generateTotpSecret } from '../services/totp';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from './fixtures';

// Must match services/totp-service.ts AAD_LABEL.
const TOTP_AAD = 'cerberus/totp-secret/v1';

/** The CMU/master-password dimension (11 keys ⇒ 31). */
export const DIMENSION = featureDimension(11);

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** A valid feature vector, varied by seed (durations only). */
export function sampleVector(seed: number, dimension = DIMENSION): number[] {
  return Array.from({ length: dimension }, (_u, j) => 80 + (j % 5) * 12 + Math.sin(seed + j) * 6);
}

export interface Account {
  username: string;
  authKey: string;
  fingerprint: string;
}

export async function registerAccount(
  app: Express,
  fingerprint = deviceFingerprintHash(),
): Promise<Account> {
  const username = uniqueUsername();
  const reg = makeRegistration(username);
  await request(app).post('/auth/register').send(reg.body).expect(201);
  return { username, authKey: reg.authKey, fingerprint };
}

export interface LoginOptions {
  /** Keystroke features to send with login (omit for no telemetry). */
  sample?: number[];
  /** X-Forwarded-For (trust proxy is on in tests). */
  ip?: string;
  /** Override the device fingerprint (a new value ⇒ a new device). */
  fingerprint?: string;
}

/** Build a /auth/login supertest request with the given options. */
export function loginReq(app: Express, acct: Account, opts: LoginOptions = {}) {
  const body: Record<string, unknown> = {
    username: acct.username,
    authKey: acct.authKey,
    deviceFingerprintHash: opts.fingerprint ?? acct.fingerprint,
  };
  if (opts.sample !== undefined) {
    body.keystrokeSample = { featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: opts.sample };
  }
  const req = request(app).post('/auth/login').send(body);
  if (opts.ip !== undefined) {
    req.set('X-Forwarded-For', opts.ip);
  }
  return req;
}

/** Log in expecting a granted session; returns the session token. */
export async function loginGranted(app: Express, acct: Account, opts: LoginOptions = {}): Promise<string> {
  const res = await loginReq(app, acct, opts).expect(200);
  if (res.body.status !== 'granted') {
    throw new Error(`expected granted, got ${String(res.body.status)}`);
  }
  return String(res.body.sessionToken);
}

export async function userIdOf(app: Express, token: string): Promise<string> {
  const me = await request(app).get('/auth/me').set('Authorization', bearer(token)).expect(200);
  return String(me.body.userId);
}

/** Register + drive a baseline to ACTIVE by buffering `count` samples; returns {acct, token, userId}. */
export async function enrolledActiveUser(
  app: Express,
  count = 10,
): Promise<{ acct: Account; token: string; userId: string }> {
  const acct = await registerAccount(app);
  const token = await loginGranted(app, acct, {});
  for (let i = 1; i <= count; i += 1) {
    await request(app)
      .post('/enrollment/samples')
      .set('Authorization', bearer(token))
      .send({ featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: sampleVector(i) })
      .expect(201);
  }
  return { acct, token, userId: await userIdOf(app, token) };
}

/** Set up + confirm TOTP for a session; returns the raw secret bytes (for code generation). */
export async function enableTotp(app: Express, token: string): Promise<Buffer> {
  const setup = await request(app).post('/auth/totp/setup').set('Authorization', bearer(token)).expect(200);
  const secret = base32Decode(String(setup.body.secret));
  const code = currentCode(secret, Math.floor(Date.now() / 1000), DEFAULT_TOTP_CONFIG);
  await request(app)
    .post('/auth/totp/confirm')
    .set('Authorization', bearer(token))
    .send({ code })
    .expect(200);
  return secret;
}

/** The current valid TOTP code for a secret. */
export function totpCode(secret: Buffer): string {
  return currentCode(secret, Math.floor(Date.now() / 1000), DEFAULT_TOTP_CONFIG);
}

/**
 * Seed a CONFIRMED TOTP secret directly (bypassing the confirm flow, whose code
 * would consume the current time-step and trigger replay protection on an
 * immediate same-window step-up). Returns the raw secret for code generation.
 */
export async function seedConfirmedTotp(
  pool: Pool,
  encryptionKey: Buffer,
  userId: string,
): Promise<Buffer> {
  const secret = generateTotpSecret();
  const sealed = seal(secret, encryptionKey, `${TOTP_AAD}:${userId}`);
  await pool.query(
    `INSERT INTO totp_secrets (user_id, secret_encrypted, nonce, confirmed, last_used_step)
     VALUES ($1, $2, $3, TRUE, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_encrypted = EXCLUDED.secret_encrypted, nonce = EXCLUDED.nonce,
       confirmed = TRUE, last_used_step = NULL`,
    [userId, sealed.ciphertext, sealed.nonce],
  );
  return secret;
}
