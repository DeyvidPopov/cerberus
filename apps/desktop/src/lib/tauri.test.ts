import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri IPC so the client wrapper can be tested without a running app.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';

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
  unlock,
} from './tauri';

const mockInvoke = vi.mocked(invoke);

const kdfParams = { memoryKib: 1, iterations: 1, parallelism: 1 };

beforeEach(() => {
  mockInvoke.mockReset();
});

// Tauri v2 maps camelCase invoke keys to the Rust commands' snake_case params, so
// EVERY argument must be sent camelCase. These assertions pin the exact wire keys —
// the IPC contract regression that broke registration (snake_case keys → Tauri
// "missing required key masterPassword") would fail here.
describe('tauri client wrapper — IPC argument casing', () => {
  it('forwards the master password under the camelCase key', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await unlock('hunter2');
    expect(mockInvoke).toHaveBeenCalledWith('unlock', { masterPassword: 'hunter2' });
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
    const summaries = [{ id: '1', name: 'GitHub', username: 'octocat' }];
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
      addCredential({ name: 'n', username: 'u', password: 'p', url: '', notes: '' }),
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
