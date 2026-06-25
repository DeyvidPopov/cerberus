import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tauri', () => ({
  prepareRegistration: vi.fn(),
  deriveLoginAuthKey: vi.fn(),
  unlock: vi.fn(),
}));
vi.mock('./api', () => ({
  register: vi.fn(),
  prelogin: vi.fn(),
  login: vi.fn(),
  verifyStepUp: vi.fn(),
}));
vi.mock('./device', () => ({
  deviceFingerprintHash: vi.fn(),
}));
vi.mock('./sync', () => ({
  syncPullOnUnlock: vi.fn(),
}));

import { login, prelogin, register } from './api';
import { loginAccount, registerAccount, unlockAndPull } from './auth';
import { deviceFingerprintHash } from './device';
import { syncPullOnUnlock } from './sync';
import { deriveLoginAuthKey, prepareRegistration, unlock } from './tauri';

const material = {
  authKey: 'AUTHKEY',
  kdfVersion: 1,
  kdfSalt: 'SALT',
  kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
  wrappedVaultKey: 'WRAPPED',
  wrappedVaultKeyNonce: 'NONCE',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerAccount', () => {
  it('derives material in Rust then posts it with the username', async () => {
    vi.mocked(prepareRegistration).mockResolvedValue(material);
    vi.mocked(register).mockResolvedValue({ userId: 'user-1' });

    await registerAccount('alice', 'master-pw');

    expect(prepareRegistration).toHaveBeenCalledWith('master-pw');
    expect(register).toHaveBeenCalledWith({ username: 'alice', ...material });
  });
});

describe('loginAccount', () => {
  it('runs prelogin → derive auth key → hash device → login, in order', async () => {
    vi.mocked(prelogin).mockResolvedValue({
      kdfVersion: 1,
      kdfSalt: 'SALT',
      kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
    });
    vi.mocked(deriveLoginAuthKey).mockResolvedValue('DERIVED-AUTHKEY');
    vi.mocked(deviceFingerprintHash).mockResolvedValue('FP-HASH');
    vi.mocked(login).mockResolvedValue({
      status: 'granted',
      sessionToken: 'token',
      expiresAt: '2026-01-01T00:00:00.000Z',
      wrappedVaultKey: 'WRAPPED',
      wrappedVaultKeyNonce: 'NONCE',
      device: { isNew: true },
    });

    const res = await loginAccount('alice', 'master-pw', [10, 20, 30, 40]);

    expect(prelogin).toHaveBeenCalledWith({ username: 'alice' });
    expect(deriveLoginAuthKey).toHaveBeenCalledWith('master-pw', 'SALT', {
      memoryKib: 1,
      iterations: 1,
      parallelism: 1,
    });
    expect(login).toHaveBeenCalledWith({
      username: 'alice',
      authKey: 'DERIVED-AUTHKEY',
      deviceFingerprintHash: 'FP-HASH',
      keystrokeSample: { featureSchemaVersion: 1, features: [10, 20, 30, 40] },
    });
    expect(res.kind).toBe('granted');
    if (res.kind === 'granted') {
      expect(res.session.sessionToken).toBe('token');
    }
  });

  it('surfaces a step-up challenge', async () => {
    vi.mocked(prelogin).mockResolvedValue({
      kdfVersion: 1,
      kdfSalt: 'SALT',
      kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
    });
    vi.mocked(deriveLoginAuthKey).mockResolvedValue('DERIVED-AUTHKEY');
    vi.mocked(deviceFingerprintHash).mockResolvedValue('FP-HASH');
    vi.mocked(login).mockResolvedValue({
      status: 'step_up_required',
      challengeToken: 'challenge-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      methods: ['totp'],
    });

    const res = await loginAccount('alice', 'master-pw', null);
    expect(res.kind).toBe('step_up');
    if (res.kind === 'step_up') {
      expect(res.challengeToken).toBe('challenge-1');
    }
    // The prelogin KDF salt/params are threaded out so the caller can pull-sync.
    expect(res.kdfSalt).toBe('SALT');
    expect(res.kdfParams).toEqual({ memoryKib: 1, iterations: 1, parallelism: 1 });
  });
});

describe('unlockAndPull', () => {
  const session = {
    status: 'granted',
    sessionToken: 'tok',
    expiresAt: '2026-01-01T00:00:00.000Z',
    wrappedVaultKey: 'WK',
    wrappedVaultKeyNonce: 'WN',
    device: { isNew: false },
  } as const;
  const kdf = { memoryKib: 1, iterations: 1, parallelism: 1 };

  it('opens the local vault then pull-syncs from the server', async () => {
    vi.mocked(unlock).mockResolvedValue();
    vi.mocked(syncPullOnUnlock).mockResolvedValue({ added: 2, updated: 0, kept: 0, skipped: 0 });

    const outcome = await unlockAndPull('master-pw', session, 'SALT', kdf, 'alice');

    expect(unlock).toHaveBeenCalledWith('master-pw', 'alice');
    expect(syncPullOnUnlock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok',
        masterPassword: 'master-pw',
        kdfSalt: 'SALT',
        wrappedVaultKey: 'WK',
        wrappedVaultKeyNonce: 'WN',
      }),
    );
    expect(outcome).toEqual({ added: 2, updated: 0, kept: 0, skipped: 0 });
  });

  it('keeps the vault open (best-effort) if the pull fails — returns null, does not throw', async () => {
    vi.mocked(unlock).mockResolvedValue();
    vi.mocked(syncPullOnUnlock).mockRejectedValue(new Error('offline'));
    await expect(unlockAndPull('master-pw', session, 'SALT', kdf, 'alice')).resolves.toBeNull();
  });

  it('propagates an unlock failure (the vault stays locked; no pull attempted)', async () => {
    vi.mocked(unlock).mockRejectedValue(new Error('wrong password'));
    await expect(unlockAndPull('master-pw', session, 'SALT', kdf, 'alice')).rejects.toThrow();
    expect(syncPullOnUnlock).not.toHaveBeenCalled();
  });
});
