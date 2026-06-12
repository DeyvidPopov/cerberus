import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, login, prelogin, register } from './api';

function mockFetch(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(payload),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const registration = {
  username: 'alice',
  authKey: 'QQ==',
  kdfVersion: 1,
  kdfSalt: 'QQ==',
  kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
  wrappedVaultKey: 'QQ==',
  wrappedVaultKeyNonce: 'QQ==',
};

describe('api client (response validation)', () => {
  it('register returns the validated userId', async () => {
    mockFetch({ userId: 'user-1' });
    await expect(register(registration)).resolves.toEqual({ userId: 'user-1' });
  });

  it('prelogin returns validated KDF params', async () => {
    mockFetch({ kdfVersion: 1, kdfSalt: 'QQ==', kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 } });
    const res = await prelogin({ username: 'alice' });
    expect(res.kdfVersion).toBe(1);
  });

  it('throws ApiError on a non-2xx response', async () => {
    mockFetch({ error: 'invalid_credentials' }, false, 401);
    await expect(
      login({ username: 'alice', authKey: 'QQ==', deviceFingerprintHash: 'QQ==' }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects a malformed (schema-violating) response', async () => {
    mockFetch({ unexpected: true });
    await expect(prelogin({ username: 'alice' })).rejects.toThrow();
  });
});
