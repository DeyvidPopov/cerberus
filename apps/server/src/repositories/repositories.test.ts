import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';
import { createDevicesRepository } from './devices';
import { createSessionsRepository } from './sessions';
import { createUsersRepository } from './users';
import { createVaultKeysRepository } from './vault-keys';

let db: TestDb;
let pool: Pool;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

async function insertUser(username = uniqueUsername()): Promise<string> {
  const { id } = await createUsersRepository(pool).create({
    username,
    authKeyHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
    kdfVersion: 1,
    kdfSalt: randomBytes(16),
    kdfParams: { memoryKib: 229_376, iterations: 3, parallelism: 1 },
  });
  return id;
}

describe('usersRepository (real Postgres)', () => {
  it('round-trips a user with bytea salt and camelCase kdf params', async () => {
    const repo = createUsersRepository(pool);
    const username = uniqueUsername();
    const salt = randomBytes(16);
    await repo.create({
      username,
      authKeyHash: '$argon2id$stored-hash',
      kdfVersion: 1,
      kdfSalt: salt,
      kdfParams: { memoryKib: 229_376, iterations: 3, parallelism: 1 },
    });

    const found = await repo.findByUsername(username);
    expect(found).not.toBeNull();
    expect(found?.username).toBe(username);
    expect(found?.authKeyHash).toBe('$argon2id$stored-hash');
    expect(found?.kdfVersion).toBe(1);
    expect(Buffer.isBuffer(found?.kdfSalt)).toBe(true);
    expect(found?.kdfSalt.equals(salt)).toBe(true);
    expect(found?.kdfParams).toEqual({ memoryKib: 229_376, iterations: 3, parallelism: 1 });
  });

  it('returns null for an unknown username', async () => {
    const found = await createUsersRepository(pool).findByUsername(uniqueUsername());
    expect(found).toBeNull();
  });

  it('enforces the unique username constraint', async () => {
    const username = uniqueUsername();
    await insertUser(username);
    await expect(insertUser(username)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('vaultKeysRepository (real Postgres)', () => {
  it('round-trips wrapped key + nonce as bytea', async () => {
    const userId = await insertUser();
    const repo = createVaultKeysRepository(pool);
    const wrapped = randomBytes(48);
    const nonce = randomBytes(24);
    await repo.create({ userId, wrappedVaultKey: wrapped, nonce });

    const found = await repo.findByUserId(userId);
    expect(found?.wrappedVaultKey.equals(wrapped)).toBe(true);
    expect(found?.nonce.equals(nonce)).toBe(true);
  });
});

describe('devicesRepository (real Postgres)', () => {
  it('marks a first sighting new and a repeat known', async () => {
    const userId = await insertUser();
    const repo = createDevicesRepository(pool);
    const fingerprint = randomBytes(32).toString('base64');

    const first = await repo.enroll(userId, fingerprint);
    expect(first.isNew).toBe(true);

    const second = await repo.enroll(userId, fingerprint);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe('sessionsRepository (real Postgres)', () => {
  it('creates and finds an active session by token hash', async () => {
    const userId = await insertUser();
    const repo = createSessionsRepository(pool);
    const tokenHash = randomBytes(32).toString('hex');
    await repo.create({
      userId,
      deviceId: null,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
      isNewDevice: false,
    });

    const found = await repo.findActiveByTokenHash(tokenHash);
    expect(found?.userId).toBe(userId);
    expect(found?.status).toBe('active');
  });

  it('does not return an expired session', async () => {
    const userId = await insertUser();
    const repo = createSessionsRepository(pool);
    const tokenHash = randomBytes(32).toString('hex');
    await repo.create({
      userId,
      deviceId: null,
      tokenHash,
      expiresAt: new Date(Date.now() - 1_000),
      isNewDevice: false,
    });

    expect(await repo.findActiveByTokenHash(tokenHash)).toBeNull();
  });
});
