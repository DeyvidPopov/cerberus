import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { testServerConfig } from '../test-support/config';
import { makeRegistration, uniqueUsername } from '../test-support/fixtures';
import { createTestDb, type TestDb } from '../test-support/postgres';

// CORS wiring so the desktop webview (a different origin) can reach the API. The
// pre-login routes (register, prelogin) MUST be public and cross-origin reachable;
// protected routes stay behind the session (the browser "unauthorized").
const APP_ORIGIN = 'http://localhost:1420';

let db: TestDb;
let pool: Pool;
let app: Express;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  app = createApp(pool, testServerConfig({ corsAllowedOrigins: [APP_ORIGIN, 'tauri://localhost'] }));
}, 60_000);

afterAll(async () => {
  await db.teardown();
});

describe('CORS — the desktop app can reach the API', () => {
  it('answers the register preflight (OPTIONS) for an allowed origin', async () => {
    const res = await request(app)
      .options('/auth/register')
      .set('Origin', APP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('register is PUBLIC and cross-origin reachable (no token needed)', async () => {
    const { body } = makeRegistration(uniqueUsername());
    const res = await request(app).post('/auth/register').set('Origin', APP_ORIGIN).send(body).expect(201);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('prelogin is PUBLIC and cross-origin reachable (no token needed)', async () => {
    const res = await request(app)
      .post('/auth/prelogin')
      .set('Origin', APP_ORIGIN)
      .send({ username: uniqueUsername() })
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('does NOT grant CORS to a disallowed origin', async () => {
    const res = await request(app)
      .options('/auth/register')
      .set('Origin', 'http://evil.example')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('protected routes still require a session (the browser "unauthorized")', async () => {
    // Same class of request the browser hit on a protected route → 401, not a CORS issue.
    await request(app).get('/auth/me').set('Origin', APP_ORIGIN).expect(401);
  });
});
