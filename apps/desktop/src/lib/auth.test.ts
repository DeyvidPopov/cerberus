import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tauri', () => ({
  prepareRegistration: vi.fn(),
  deriveLoginAuthKey: vi.fn(),
}));
vi.mock('./api', () => ({
  register: vi.fn(),
  prelogin: vi.fn(),
  login: vi.fn(),
}));
vi.mock('./device', () => ({
  deviceFingerprintHash: vi.fn(),
}));

import { login, prelogin, register } from './api';
import { registerAccount, loginAccount } from './auth';
import { deviceFingerprintHash } from './device';
import { deriveLoginAuthKey, prepareRegistration } from './tauri';

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
      sessionToken: 'token',
      expiresAt: '2026-01-01T00:00:00.000Z',
      wrappedVaultKey: 'WRAPPED',
      wrappedVaultKeyNonce: 'NONCE',
      device: { isNew: true },
    });

    const res = await loginAccount('alice', 'master-pw');

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
    });
    expect(res.sessionToken).toBe('token');
  });
});
