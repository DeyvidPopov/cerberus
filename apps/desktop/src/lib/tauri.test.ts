import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri IPC so the client wrapper can be tested without a running app.
// `isTauri` reports the bridge as present by default; individual tests flip it to
// exercise the "not running in the desktop app" path.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));

import { invoke, isTauri } from '@tauri-apps/api/core';

import { SecureCoreError } from './secure-core';
import {
  addCredential,
  deleteCredential,
  deriveLoginAuthKey,
  errorMessage,
  getCredential,
  listCredentials,
  openCredential,
  prepareRegistration,
  sealCredential,
  syncPullMerge,
  unlock,
} from './tauri';

const mockInvoke = vi.mocked(invoke);
const mockIsTauri = vi.mocked(isTauri);

const kdfParams = { memoryKib: 1, iterations: 1, parallelism: 1 };

beforeEach(() => {
  mockInvoke.mockReset();
  mockIsTauri.mockReset();
  mockIsTauri.mockReturnValue(true);
});

// Tauri v2 maps camelCase invoke keys to the Rust commands' snake_case params, so
// EVERY argument must be sent camelCase. These assertions pin the exact wire keys —
// the IPC contract regression that broke registration (snake_case keys → Tauri
// "missing required key masterPassword") would fail here.
describe('tauri client wrapper — IPC argument casing', () => {
  it('forwards the master password and the per-account vault id under camelCase keys', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await unlock('hunter2', 'alice');
    expect(mockInvoke).toHaveBeenCalledWith('unlock', { masterPassword: 'hunter2', vaultId: 'alice' });
  });

  it('prepareRegistration sends masterPassword (camelCase) and validates the reply', async () => {
    const material = {
      authKey: 'AK',
      kdfVersion: 1,
      kdfParams,
      kdfSalt: 'SALT',
      wrappedVaultKey: 'WK',
      wrappedVaultKeyNonce: 'WN',
    };
    mockInvoke.mockResolvedValue(material);
    await expect(prepareRegistration('master-pw')).resolves.toEqual(material);
    expect(mockInvoke).toHaveBeenCalledWith('prepare_registration', { masterPassword: 'master-pw' });
  });

  it('deriveLoginAuthKey sends camelCase masterPassword/kdfSalt/kdfParams', async () => {
    mockInvoke.mockResolvedValue('AUTHKEY');
    await expect(deriveLoginAuthKey('master-pw', 'SALT', kdfParams)).resolves.toBe('AUTHKEY');
    expect(mockInvoke).toHaveBeenCalledWith('derive_login_auth_key_cmd', {
      masterPassword: 'master-pw',
      kdfSalt: 'SALT',
      kdfParams,
    });
  });

  it('listCredentials validates and returns the summaries', async () => {
    const summaries = [
      {
        id: '1',
        name: 'GitHub',
        username: 'octocat',
        url: 'https://github.com',
        itemType: 'login',
        favourite: false,
        category: 'Work tools',
        hasOtp: true,
      },
    ];
    mockInvoke.mockResolvedValue(summaries);
    await expect(listCredentials()).resolves.toEqual(summaries);
    expect(mockInvoke).toHaveBeenCalledWith('list_credentials');
  });

  it('listCredentials rejects a malformed IPC reply', async () => {
    mockInvoke.mockResolvedValue([{ id: 1, name: 'x' }]); // wrong shape
    await expect(listCredentials()).rejects.toThrow();
  });

  it('getCredential passes the id and validates the reply', async () => {
    const cred = {
      id: '1',
      name: 'GitHub',
      username: 'octocat',
      password: 's3cr3t',
      url: '',
      notes: '',
      itemType: 'login',
      favourite: false,
      category: '',
      otpSecret: '',
      passwordUpdatedAt: '',
      cardNumber: '',
      cardExpiry: '',
      cardCvv: '',
      cardHolder: '',
    };
    mockInvoke.mockResolvedValue(cred);
    await expect(getCredential('1')).resolves.toEqual(cred);
    expect(mockInvoke).toHaveBeenCalledWith('get_credential', { id: '1' });
  });

  it('getCredential rejects a reply missing the password field', async () => {
    mockInvoke.mockResolvedValue({ id: '1', name: 'n', username: 'u', url: '', notes: '' });
    await expect(getCredential('1')).rejects.toThrow();
  });

  it('addCredential returns the validated id', async () => {
    mockInvoke.mockResolvedValue('new-id');
    await expect(
      addCredential({
        name: 'n',
        username: 'u',
        password: 'p',
        url: '',
        notes: '',
        itemType: 'login',
        favourite: false,
        category: '',
        otpSecret: '',
        passwordUpdatedAt: '',
        cardNumber: '',
        cardExpiry: '',
        cardCvv: '',
        cardHolder: '',
      }),
    ).resolves.toBe('new-id');
  });

  it('deleteCredential forwards the id', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await deleteCredential('1');
    expect(mockInvoke).toHaveBeenCalledWith('delete_credential', { id: '1' });
  });

  it('sealCredential maps args to camelCase and validates the blob', async () => {
    mockInvoke.mockResolvedValue({ ciphertext: 'QQ==', nonce: 'QQ==' });
    const args = {
      masterPassword: 'mp',
      kdfSalt: 'salt',
      kdfParams,
      wrappedVaultKey: 'wk',
      wrappedVaultKeyNonce: 'wn',
      plaintext: '{"x":1}',
    };
    await expect(sealCredential(args)).resolves.toEqual({ ciphertext: 'QQ==', nonce: 'QQ==' });
    expect(mockInvoke).toHaveBeenCalledWith('seal_credential', {
      masterPassword: 'mp',
      kdfSalt: 'salt',
      kdfParams,
      wrappedVaultKey: 'wk',
      wrappedVaultKeyNonce: 'wn',
      plaintext: '{"x":1}',
    });
  });

  it('openCredential maps args to camelCase and returns the validated plaintext', async () => {
    mockInvoke.mockResolvedValue('{"x":1}');
    await expect(
      openCredential({
        masterPassword: 'mp',
        kdfSalt: 'salt',
        kdfParams,
        wrappedVaultKey: 'wk',
        wrappedVaultKeyNonce: 'wn',
        ciphertext: 'ct',
        nonce: 'nc',
      }),
    ).resolves.toBe('{"x":1}');
    expect(mockInvoke).toHaveBeenCalledWith('open_credential', {
      masterPassword: 'mp',
      kdfSalt: 'salt',
      kdfParams,
      wrappedVaultKey: 'wk',
      wrappedVaultKeyNonce: 'wn',
      ciphertext: 'ct',
      nonce: 'nc',
    });
  });

  it('syncPullMerge sends camelCase args and validates the merge-outcome reply', async () => {
    mockInvoke.mockResolvedValue({ added: 1, updated: 0, kept: 2, skipped: 0 });
    const args = {
      masterPassword: 'mp',
      kdfSalt: 'salt',
      kdfParams,
      wrappedVaultKey: 'wk',
      wrappedVaultKeyNonce: 'wn',
      items: [{ id: 'a', revision: 2, ciphertext: 'ct', nonce: 'nc' }],
    };
    await expect(syncPullMerge(args)).resolves.toEqual({ added: 1, updated: 0, kept: 2, skipped: 0 });
    expect(mockInvoke).toHaveBeenCalledWith('sync_pull_merge', args);
  });

  it('syncPullMerge rejects a malformed merge-outcome reply', async () => {
    mockInvoke.mockResolvedValue({ added: 'not-a-number' });
    await expect(
      syncPullMerge({
        masterPassword: 'mp',
        kdfSalt: 'salt',
        kdfParams,
        wrappedVaultKey: 'wk',
        wrappedVaultKeyNonce: 'wn',
        items: [],
      }),
    ).rejects.toThrow();
  });
});

// The auth-key derivations (prepareRegistration / deriveLoginAuthKey) have NO
// domain-error rejection — their inputs are pre-validated — so both runtime
// failures must surface as a typed SecureCoreError the UI can render honestly,
// rather than an opaque string ("Something went wrong") or a TypeError that
// masquerades as a network error.
describe('secure-core wrapper — typed faults for the auth derivations', () => {
  it('throws SecureCoreError("unavailable") when not running in the Tauri app (no bridge)', async () => {
    mockIsTauri.mockReturnValue(false);
    await expect(deriveLoginAuthKey('mp', 'SALT', kdfParams)).rejects.toBeInstanceOf(SecureCoreError);
    await expect(deriveLoginAuthKey('mp', 'SALT', kdfParams)).rejects.toMatchObject({ kind: 'unavailable' });
    // The bridge is absent → the command is never even attempted.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('wraps a Rust command rejection as SecureCoreError("failed"), preserving the cause', async () => {
    mockInvoke.mockRejectedValue('key derivation was interrupted');
    const err = await deriveLoginAuthKey('mp', 'SALT', kdfParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecureCoreError);
    expect((err as SecureCoreError).kind).toBe('failed');
    expect((err as SecureCoreError).underlying).toBe('key derivation was interrupted');
  });

  it('applies the same typing to prepareRegistration', async () => {
    mockIsTauri.mockReturnValue(false);
    await expect(prepareRegistration('mp')).rejects.toMatchObject({ kind: 'unavailable' });
    mockIsTauri.mockReturnValue(true);
    mockInvoke.mockRejectedValue(new Error('boom'));
    await expect(prepareRegistration('mp')).rejects.toBeInstanceOf(SecureCoreError);
  });
});

describe('errorMessage', () => {
  it('passes through string errors (Rust command rejections)', () => {
    expect(errorMessage('vault is locked')).toBe('vault is locked');
  });

  it('extracts Error.message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back for unknown shapes', () => {
    expect(errorMessage({ weird: true })).toBe('Unexpected error');
  });
});
