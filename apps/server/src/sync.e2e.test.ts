import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { RegistrationMaterialSchema, type RegistrationMaterial } from '@cerberus/shared-types';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app';
import type { ServerConfig } from './config';
import { deviceFingerprintHash, uniqueUsername } from './test-support/fixtures';
import { createTestDb, type TestDb } from './test-support/postgres';

// HEADLINE end-to-end test (Phase 1 exit criterion), runnable in code without the
// GUI. It exercises the REAL crypto (Rust, via the hermetic `cerberus-cli` oracle
// — no reimplementation) AND the REAL server (Express + ephemeral Postgres):
//
//   client1: register -> login -> seal a credential -> push the opaque blob
//   FRESH client2 (no in-memory keys, same master password):
//     login -> GET vault key -> unwrap -> GET items -> decrypt
//   assert the decrypted credential EQUALS what client1 created, and the server
//   never saw the plaintext (the marker is absent from the stored bytes).

const EXT = process.platform === 'win32' ? '.exe' : '';
const DEFAULT_CLI = resolve(process.cwd(), 'target', 'debug', `cerberus-cli${EXT}`);

function resolveCli(): string {
  const fromEnv = process.env.CERBERUS_CLI_BIN;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  if (existsSync(DEFAULT_CLI)) {
    return DEFAULT_CLI;
  }
  // cargo is the project baseline; build the oracle (fails loudly if unavailable).
  execFileSync('cargo', ['build', '--bin', 'cerberus-cli'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  return DEFAULT_CLI;
}

function cli<T>(bin: string, command: string, payload: unknown): T {
  const out = execFileSync(bin, [command], { input: JSON.stringify(payload), encoding: 'utf8' });
  return JSON.parse(out) as T;
}

// Cheap KDF params so the E2E (several derivations) runs fast; the server stores
// whatever the client registered with, so login re-derives with the same params.
const CHEAP = { memoryKib: 64, iterations: 1, parallelism: 1 };

function testConfig(): ServerConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    logLevel: 'error',
    databaseUrl: 'unused-in-tests',
    enumerationSecret: 'test-enumeration-secret',
    sessionTtlMs: 60_000,
    rateLimit: {
      ipWindowMs: 60_000,
      ipMaxRequests: 10_000,
      accountMaxFailures: 1000,
      accountLockoutMs: 60_000,
      vaultWindowMs: 60_000,
      vaultMaxRequests: 10_000,
    },
  };
}

let db: TestDb;
let pool: Pool;
let app: Express;
let CLI: string;

beforeAll(async () => {
  CLI = resolveCli();
  db = await createTestDb();
  pool = db.pool;
  app = createApp(pool, testConfig());
}, 300_000);

afterAll(async () => {
  await db.teardown();
});

interface AuthKeyOut {
  authKey: string;
}
interface SealOut {
  ciphertext: string;
  nonce: string;
}
interface OpenOut {
  plaintext: string;
}

describe('end-to-end encrypted sync (Phase 1 exit criterion)', () => {
  it('a fresh client logs in and decrypts a credential created by another client', async () => {
    const masterPassword = 'correct horse battery staple';
    const username = uniqueUsername();
    const credential = JSON.stringify({
      name: 'GitHub',
      username: 'octocat',
      password: 'E2E-PLAINTEXT-MARKER',
      url: 'https://github.com',
      notes: 'private note marker',
    });

    // --- client1: register ---
    const material = cli<RegistrationMaterial>(CLI, 'register', { masterPassword, kdfParams: CHEAP });
    const reg: RegistrationMaterial = RegistrationMaterialSchema.parse(material);
    await request(app)
      .post('/auth/register')
      .send({ username, ...reg })
      .expect(201);

    // --- client1: login ---
    const auth1 = cli<AuthKeyOut>(CLI, 'derive-auth-key', {
      masterPassword,
      kdfSalt: reg.kdfSalt,
      kdfParams: reg.kdfParams,
    });
    const login1 = await request(app)
      .post('/auth/login')
      .send({ username, authKey: auth1.authKey, deviceFingerprintHash: deviceFingerprintHash() })
      .expect(200);

    // --- client1: seal the credential and push the opaque blob ---
    const sealed = cli<SealOut>(CLI, 'seal-credential', {
      masterPassword,
      kdfSalt: reg.kdfSalt,
      kdfParams: reg.kdfParams,
      wrappedVaultKey: login1.body.wrappedVaultKey,
      wrappedVaultKeyNonce: login1.body.wrappedVaultKeyNonce,
      plaintext: credential,
    });
    const itemId = randomUUID();
    await request(app)
      .post('/vault/items')
      .set('Authorization', `Bearer ${String(login1.body.sessionToken)}`)
      .send({ id: itemId, ciphertext: sealed.ciphertext, nonce: sealed.nonce })
      .expect(201);

    // --- server blindness: the real plaintext markers are NOT in the stored bytes ---
    const stored = await pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM vault_items WHERE id = $1`,
      [itemId],
    );
    const ciphertextBytes = stored.rows[0]?.ciphertext;
    if (!ciphertextBytes) {
      throw new Error('pushed item not found');
    }
    const asText = ciphertextBytes.toString('latin1');
    expect(asText).not.toContain('E2E-PLAINTEXT-MARKER');
    expect(asText).not.toContain('octocat');
    expect(asText).not.toContain('private note marker');

    // --- FRESH client2: no in-memory keys, only the username + master password ---
    const pre = await request(app).post('/auth/prelogin').send({ username }).expect(200);
    const auth2 = cli<AuthKeyOut>(CLI, 'derive-auth-key', {
      masterPassword,
      kdfSalt: pre.body.kdfSalt,
      kdfParams: pre.body.kdfParams,
    });
    const login2 = await request(app)
      .post('/auth/login')
      .send({ username, authKey: auth2.authKey, deviceFingerprintHash: deviceFingerprintHash() })
      .expect(200);
    const token2 = `Bearer ${String(login2.body.sessionToken)}`;

    // Bootstrap order: GET vault key -> (unwrap) -> GET items -> (decrypt).
    const keyRes = await request(app).get('/vault/key').set('Authorization', token2).expect(200);
    const itemsRes = await request(app).get('/vault/items').set('Authorization', token2).expect(200);
    expect(itemsRes.body).toHaveLength(1);
    const blob = itemsRes.body[0];

    const opened = cli<OpenOut>(CLI, 'open-credential', {
      masterPassword,
      kdfSalt: pre.body.kdfSalt,
      kdfParams: pre.body.kdfParams,
      wrappedVaultKey: keyRes.body.wrappedVaultKey,
      wrappedVaultKeyNonce: keyRes.body.wrappedVaultKeyNonce,
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
    });

    // The fresh client recovered EXACTLY what client1 created.
    expect(opened.plaintext).toBe(credential);
  });
});
