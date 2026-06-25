import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));

import { isTauri } from '@tauri-apps/api/core';

import { SecureCoreError, secureCoreAvailable } from './secure-core';

const mockIsTauri = vi.mocked(isTauri);

beforeEach(() => {
  mockIsTauri.mockReset();
});

describe('SecureCoreError', () => {
  it('is an Error subclass carrying the kind and the underlying cause', () => {
    const cause = 'key derivation was interrupted';
    const err = new SecureCoreError('failed', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecureCoreError);
    expect(err.kind).toBe('failed');
    expect(err.underlying).toBe(cause);
    expect(err.name).toBe('SecureCoreError');
  });

  it('distinguishes the two runtime causes', () => {
    expect(new SecureCoreError('unavailable').kind).toBe('unavailable');
    expect(new SecureCoreError('failed').kind).toBe('failed');
  });
});

describe('secureCoreAvailable', () => {
  it('is true inside the Tauri app (bridge present) and false otherwise', () => {
    mockIsTauri.mockReturnValue(true);
    expect(secureCoreAvailable()).toBe(true);
    mockIsTauri.mockReturnValue(false);
    expect(secureCoreAvailable()).toBe(false);
  });
});
