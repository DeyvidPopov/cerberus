import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri IPC so the client wrapper can be tested without a running app.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';

import {
  addCredential,
  deleteCredential,
  errorMessage,
  getCredential,
  listCredentials,
  unlock,
} from './tauri';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('tauri client wrapper', () => {
  it('forwards the master password under the snake_case key', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await unlock('hunter2');
    expect(mockInvoke).toHaveBeenCalledWith('unlock', { master_password: 'hunter2' });
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
