import { randomBytes, randomUUID } from 'node:crypto';

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

interface AuthedUser {
  token: string;
}

async function authedUser(): Promise<AuthedUser> {
  const username = uniqueUsername();
  const reg = makeRegistration(username);
  await request(app).post('/auth/register').send(reg.body).expect(201);
  const login = await request(app)
    .post('/auth/login')
    .send({ username, authKey: reg.authKey, deviceFingerprintHash: deviceFingerprintHash() })
    .expect(200);
  return { token: String(login.body.sessionToken) };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function newItem(): { id: string; ciphertext: string; nonce: string } {
  return {
    id: randomUUID(),
    ciphertext: randomBytes(96).toString('base64'),
    nonce: randomBytes(24).toString('base64'),
  };
}

describe('vault sync — CRUD round-trips', () => {
  it('stores, lists, gets, updates (revision bump), and deletes a blob', async () => {
    const { token } = await authedUser();
    const item = newItem();

    const created = await request(app)
      .post('/vault/items')
      .set('Authorization', bearer(token))
      .send(item)
      .expect(201);
    expect(created.body.id).toBe(item.id);
    expect(created.body.revision).toBe(1);

    const list = await request(app)
      .get('/vault/items')
      .set('Authorization', bearer(token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(item.id);
    expect(list.body[0].ciphertext).toBe(item.ciphertext); // opaque round-trip

    const fetched = await request(app)
      .get(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .expect(200);
    expect(fetched.body.ciphertext).toBe(item.ciphertext);
    expect(fetched.body.revision).toBe(1);

    const newCiphertext = randomBytes(96).toString('base64');
    const updated = await request(app)
      .put(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .send({ ciphertext: newCiphertext, nonce: item.nonce, revision: 1 })
      .expect(200);
    expect(updated.body.revision).toBe(2);

    const afterUpdate = await request(app)
      .get(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .expect(200);
    expect(afterUpdate.body.ciphertext).toBe(newCiphertext);
    expect(afterUpdate.body.revision).toBe(2);

    await request(app)
      .delete(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .expect(204);
    await request(app)
      .get(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .expect(404);
  });
});

describe('vault sync — optimistic concurrency', () => {
  it('rejects a stale-revision update with 409', async () => {
    const { token } = await authedUser();
    const item = newItem();
    await request(app).post('/vault/items').set('Authorization', bearer(token)).send(item).expect(201);

    // First update from revision 1 → 2 succeeds.
    await request(app)
      .put(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .send({ ciphertext: randomBytes(96).toString('base64'), nonce: item.nonce, revision: 1 })
      .expect(200);

    // Second update still claiming revision 1 is stale → 409.
    await request(app)
      .put(`/vault/items/${item.id}`)
      .set('Authorization', bearer(token))
      .send({ ciphertext: randomBytes(96).toString('base64'), nonce: item.nonce, revision: 1 })
      .expect(409);
  });
});

describe('vault sync — authorization (no IDOR)', () => {
  it("denies access to another user's item and isolates lists", async () => {
    const alice = await authedUser();
    const bob = await authedUser();

    const item = newItem();
    await request(app).post('/vault/items').set('Authorization', bearer(alice.token)).send(item).expect(201);

    // Bob cannot read/update/delete Alice's item (404 — uniform, no existence leak).
    await request(app).get(`/vault/items/${item.id}`).set('Authorization', bearer(bob.token)).expect(404);
    await request(app)
      .put(`/vault/items/${item.id}`)
      .set('Authorization', bearer(bob.token))
      .send({ ciphertext: randomBytes(96).toString('base64'), nonce: item.nonce, revision: 1 })
      .expect(404);
    await request(app).delete(`/vault/items/${item.id}`).set('Authorization', bearer(bob.token)).expect(404);

    // Bob's list does not include Alice's item.
    const bobList = await request(app).get('/vault/items').set('Authorization', bearer(bob.token)).expect(200);
    expect(bobList.body).toHaveLength(0);

    // Alice still has it (Bob's attempts did not delete it).
    await request(app).get(`/vault/items/${item.id}`).set('Authorization', bearer(alice.token)).expect(200);
  });
});

describe('vault sync — server blindness', () => {
  it('stores only the opaque ciphertext and strips any smuggled plaintext field', async () => {
    const { token } = await authedUser();
    const item = newItem();
    const marker = 'SMUGGLED-PLAINTEXT-MARKER';

    await request(app)
      .post('/vault/items')
      .set('Authorization', bearer(token))
      .send({ ...item, password: marker, plaintext: marker }) // smuggle attempt
      .expect(201);

    const row = await pool.query<{ id: string; ciphertext: Buffer; nonce: Buffer; item_type: string }>(
      `SELECT id::text, ciphertext, nonce, item_type FROM vault_items WHERE id = $1`,
      [item.id],
    );
    const stored = row.rows[0];
    if (!stored) {
      throw new Error('item not found');
    }
    // The stored bytes are exactly the opaque ciphertext we sent (server is blind).
    expect(stored.ciphertext.toString('base64')).toBe(item.ciphertext);
    // The smuggled plaintext field is nowhere in the stored row (zod stripped it).
    expect(JSON.stringify(stored)).not.toContain(marker);
  });

  it('exposes no column carrying recoverable plaintext', async () => {
    const { token } = await authedUser();
    const item = newItem();
    await request(app).post('/vault/items').set('Authorization', bearer(token)).send(item).expect(201);
    // The only payload-bearing columns are the opaque ciphertext + nonce; the rest
    // is non-secret metadata. There is no plaintext credential column.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vault_items'`,
    );
    const names = cols.rows.map((r) => r.column_name).sort();
    expect(names).toEqual(
      ['ciphertext', 'created_at', 'id', 'item_type', 'nonce', 'revision', 'updated_at', 'user_id'].sort(),
    );
  });
});

describe('vault sync — authentication required', () => {
  it('rejects all sync endpoints without a valid session', async () => {
    const id = randomUUID();
    await request(app).get('/vault/key').expect(401);
    await request(app).get('/vault/items').expect(401);
    await request(app).post('/vault/items').send(newItem()).expect(401);
    await request(app).get(`/vault/items/${id}`).expect(401);
    await request(app).get('/vault/items').set('Authorization', 'Bearer not-a-real-token').expect(401);
  });

  it('returns the wrapped vault key for an authenticated user', async () => {
    const { token } = await authedUser();
    const res = await request(app).get('/vault/key').set('Authorization', bearer(token)).expect(200);
    expect(typeof res.body.wrappedVaultKey).toBe('string');
    expect(typeof res.body.wrappedVaultKeyNonce).toBe('string');
  });
});
