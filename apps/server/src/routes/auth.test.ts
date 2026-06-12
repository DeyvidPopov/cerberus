import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { testServerConfig as testConfig } from '../test-support/config';
import { deviceFingerprintHash, makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

let db: TestDb;
let pool: Pool;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  app = createApp(pool, testConfig());
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('registration (zero-knowledge)', () => {
  it('stores only an Argon2id hash of the auth key — never the auth key itself', async () => {
    const username = uniqueUsername();
    const { body, authKey } = makeRegistration(username);

    const res = await request(app).post('/auth/register').send(body);
    expect(res.status).toBe(201);
    expect(typeof res.body.userId).toBe('string');

    const dump = await pool.query(
      `SELECT u.auth_key_hash,
              encode(u.kdf_salt, 'base64') AS salt,
              u.kdf_params::text          AS params,
              encode(v.wrapped_vault_key, 'base64') AS wrapped,
              encode(v.nonce, 'base64')             AS nonce
       FROM users u JOIN vault_keys v ON v.user_id = u.id
       WHERE u.username = $1`,
      [username],
    );
    const row = dump.rows[0];
    expect(String(row.auth_key_hash).startsWith('$argon2id$')).toBe(true);
    // The raw auth key appears NOWHERE in the persisted identity/vault rows.
    expect(JSON.stringify(row)).not.toContain(authKey);
  });

  it('strips unknown fields, so a leaked master password can never be stored', async () => {
    const username = uniqueUsername();
    const { body } = makeRegistration(username);
    const marker = 'MASTER-PASSWORD-LEAK-MARKER';

    // A buggy/malicious client tries to smuggle the master password in the body.
    await request(app)
      .post('/auth/register')
      .send({ ...body, masterPassword: marker, encryptionKey: marker })
      .expect(201);

    const dump = await pool.query(
      `SELECT u.*, v.* FROM users u JOIN vault_keys v ON v.user_id = u.id WHERE u.username = $1`,
      [username],
    );
    expect(JSON.stringify(dump.rows[0])).not.toContain(marker);
  });

  it('rejects a duplicate username with 409', async () => {
    const username = uniqueUsername();
    const { body } = makeRegistration(username);
    await request(app).post('/auth/register').send(body).expect(201);
    await request(app).post('/auth/register').send(body).expect(409);
  });

  it('rejects an invalid body with 400', async () => {
    await request(app).post('/auth/register').send({ username: 'ab' }).expect(400);
  });
});

describe('prelogin (user-enumeration mitigation)', () => {
  it('returns indistinguishable shapes for known vs unknown usernames', async () => {
    const known = uniqueUsername();
    await request(app).post('/auth/register').send(makeRegistration(known).body).expect(201);

    const knownRes = await request(app).post('/auth/prelogin').send({ username: known }).expect(200);
    const unknownRes = await request(app)
      .post('/auth/prelogin')
      .send({ username: uniqueUsername() })
      .expect(200);

    expect(Object.keys(knownRes.body).sort()).toEqual(Object.keys(unknownRes.body).sort());
    expect(unknownRes.body.kdfVersion).toEqual(knownRes.body.kdfVersion);
    expect(unknownRes.body.kdfParams).toEqual(knownRes.body.kdfParams);
    expect(typeof unknownRes.body.kdfSalt).toBe('string');
  });

  it('returns a stable dummy salt across repeated calls for an unknown user', async () => {
    const unknown = uniqueUsername();
    const a = await request(app).post('/auth/prelogin').send({ username: unknown }).expect(200);
    const b = await request(app).post('/auth/prelogin').send({ username: unknown }).expect(200);
    expect(a.body.kdfSalt).toBe(b.body.kdfSalt);
  });
});

describe('login + device enrollment + sessions', () => {
  it('logs in with the correct auth key, returns the wrapped vault key, enrolls the device', async () => {
    const username = uniqueUsername();
    const { body, authKey } = makeRegistration(username);
    await request(app).post('/auth/register').send(body).expect(201);
    const fp = deviceFingerprintHash();

    const res = await request(app)
      .post('/auth/login')
      .send({ username, authKey, deviceFingerprintHash: fp })
      .expect(200);

    expect(typeof res.body.sessionToken).toBe('string');
    expect(res.body.wrappedVaultKey).toBe(body.wrappedVaultKey);
    expect(res.body.wrappedVaultKeyNonce).toBe(body.wrappedVaultKeyNonce);
    expect(res.body.device.isNew).toBe(true);

    // Session is stored as a HASH of the token, never the raw token.
    const tokenHash = createHash('sha256').update(String(res.body.sessionToken)).digest('hex');
    expect((await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [tokenHash])).rowCount).toBe(1);
    expect(
      (await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [res.body.sessionToken])).rowCount,
    ).toBe(0);

    // Logging in again from the SAME device is not a new device.
    const again = await request(app)
      .post('/auth/login')
      .send({ username, authKey, deviceFingerprintHash: fp })
      .expect(200);
    expect(again.body.device.isNew).toBe(false);
  });

  it('rejects a wrong auth key and an unknown user identically', async () => {
    const username = uniqueUsername();
    await request(app).post('/auth/register').send(makeRegistration(username).body).expect(201);
    const wrongKey = randomBytes(32).toString('base64');

    const wrong = await request(app)
      .post('/auth/login')
      .send({ username, authKey: wrongKey, deviceFingerprintHash: deviceFingerprintHash() });
    const unknown = await request(app)
      .post('/auth/login')
      .send({ username: uniqueUsername(), authKey: wrongKey, deviceFingerprintHash: deviceFingerprintHash() });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('runs the Argon2id verify for unknown users too (no early return — timing guard)', async () => {
    const username = uniqueUsername();
    await request(app).post('/auth/register').send(makeRegistration(username).body).expect(201);
    const wrongKey = randomBytes(32).toString('base64');

    const time = async (uname: string): Promise<number> => {
      const start = performance.now();
      await request(app)
        .post('/auth/login')
        .send({ username: uname, authKey: wrongKey, deviceFingerprintHash: deviceFingerprintHash() });
      return performance.now() - start;
    };

    await time(uniqueUsername()); // warm-up: smooth out first-call/JIT variance
    const knownWrong = await time(username);
    const unknownUser = await time(uniqueUsername());

    // Both paths run an Argon2id verify; an early return for unknown users would
    // make `unknownUser` far smaller. Lenient ratio to avoid CI flake.
    expect(unknownUser).toBeGreaterThan(knownWrong * 0.25);
  });

  it('authenticates a valid session on /auth/me and rejects missing/invalid tokens', async () => {
    const username = uniqueUsername();
    const { body, authKey } = makeRegistration(username);
    await request(app).post('/auth/register').send(body).expect(201);
    const login = await request(app)
      .post('/auth/login')
      .send({ username, authKey, deviceFingerprintHash: deviceFingerprintHash() })
      .expect(200);

    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${String(login.body.sessionToken)}`)
      .expect(200);
    expect(typeof me.body.userId).toBe('string');

    await request(app).get('/auth/me').expect(401);
    await request(app).get('/auth/me').set('Authorization', 'Bearer nope').expect(401);
  });
});

describe('rate limiting and lockout (PROJECT.md §4.3)', () => {
  it('rate-limits prelogin by IP', async () => {
    const limited = createApp(
      pool,
      testConfig({
        rateLimit: {
          ipWindowMs: 60_000,
          ipMaxRequests: 3,
          accountMaxFailures: 100,
          accountLockoutMs: 60_000,
          vaultWindowMs: 60_000,
          vaultMaxRequests: 1000,
        },
      }),
    );
    const send = () =>
      request(limited).post('/auth/prelogin').send({ username: uniqueUsername() });
    await send().expect(200);
    await send().expect(200);
    await send().expect(200);
    await send().expect(429);
  });

  // M9 (ADR-0012) replaces the M4 per-account lockout: no targeted-DoS lock; an
  // absolute per-IP backstop limits the attacker instead.
  it('does NOT lock an account on failures (the M4 single-username DoS is gone)', async () => {
    const username = uniqueUsername();
    const { body, authKey } = makeRegistration(username);
    await request(app).post('/auth/register').send(body).expect(201);
    const wrongKey = randomBytes(32).toString('base64');
    const fp = deviceFingerprintHash();
    const attackerIp = '198.51.100.1'; // a /24 isolated from other tests

    // A targeted attack: several wrong guesses against the victim's account.
    for (let i = 0; i < 6; i += 1) {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', attackerIp)
        .send({ username, authKey: wrongKey, deviceFingerprintHash: fp })
        .expect(401);
    }
    // The CORRECT password STILL authenticates (granted or step-up) — never locked
    // out. The legitimate user logs in from their own clean IP.
    const res = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', '203.0.113.50')
      .send({ username, authKey, deviceFingerprintHash: fp });
    expect(res.status).toBe(200);
    expect(['granted', 'step_up_required']).toContain(res.body.status);
  });

  it('trips the high absolute per-IP backstop only at the configured cap', async () => {
    const base = testConfig();
    const capped = createApp(
      pool,
      testConfig({ policy: { ...base.policy, backstop: { windowMinutes: 15, ipHardCap: 3, accountStepUpCap: 20 } } }),
    );
    const username = uniqueUsername();
    const { body } = makeRegistration(username);
    await request(capped).post('/auth/register').send(body).expect(201);
    const wrongKey = randomBytes(32).toString('base64');
    const fp = deviceFingerprintHash();
    const ip = '192.0.2.50'; // isolated /24 (TEST-NET-1) for the backstop count

    for (let i = 0; i < 3; i += 1) {
      await request(capped)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username, authKey: wrongKey, deviceFingerprintHash: fp })
        .expect(401);
    }
    // The IP hit the absolute failed-login cap → further attempts are hard-blocked.
    await request(capped)
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ username, authKey: wrongKey, deviceFingerprintHash: fp })
      .expect(429);
  });
});
