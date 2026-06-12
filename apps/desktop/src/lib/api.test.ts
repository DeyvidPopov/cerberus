import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createVaultItem,
  deleteVaultItem,
  getVaultKey,
  listVaultItems,
  login,
  prelogin,
  register,
  updateVaultItem,
} from './api';

function mockFetch(payload: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

describe('vault sync api (authenticated)', () => {
  it('getVaultKey sends a Bearer token and validates the response', async () => {
    const fetchMock = mockFetch({ wrappedVaultKey: 'QQ==', wrappedVaultKeyNonce: 'QQ==' });
    await expect(getVaultKey('tok-123')).resolves.toEqual({
      wrappedVaultKey: 'QQ==',
      wrappedVaultKeyNonce: 'QQ==',
    });
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string>; method: string };
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer tok-123');
  });

  it('listVaultItems validates an array of blobs', async () => {
    mockFetch([
      {
        id: '11111111-1111-1111-1111-111111111111',
        ciphertext: 'QQ==',
        nonce: 'QQ==',
        itemType: 'login',
        revision: 1,
        createdAt: 'now',
        updatedAt: 'now',
      },
    ]);
    await expect(listVaultItems('tok')).resolves.toHaveLength(1);
  });

  it('createVaultItem returns the validated mutation result', async () => {
    mockFetch({ id: '11111111-1111-1111-1111-111111111111', revision: 1, updatedAt: 'now' });
    await expect(
      createVaultItem('tok', {
        id: '11111111-1111-1111-1111-111111111111',
        ciphertext: 'QQ==',
        nonce: 'QQ==',
        itemType: 'login',
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('updateVaultItem throws ApiError on a 409 revision conflict', async () => {
    mockFetch({ error: 'revision_conflict' }, false, 409);
    await expect(
      updateVaultItem('tok', '11111111-1111-1111-1111-111111111111', {
        ciphertext: 'QQ==',
        nonce: 'QQ==',
        itemType: 'login',
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('deleteVaultItem resolves on 204 and throws on 404', async () => {
    mockFetch(undefined, true, 204);
    await expect(deleteVaultItem('tok', '11111111-1111-1111-1111-111111111111')).resolves.toBeUndefined();
    mockFetch(undefined, false, 404);
    await expect(
      deleteVaultItem('tok', '11111111-1111-1111-1111-111111111111'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
