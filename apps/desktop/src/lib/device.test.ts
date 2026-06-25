import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashFingerprint } from './device';
import { SecureCoreError } from './secure-core';

describe('hashFingerprint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('is deterministic and produces a base64 SHA-256 digest', async () => {
    const first = await hashFingerprint('device-abc');
    const second = await hashFingerprint('device-abc');
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9+/]{43}=$/); // 32-byte digest → 44 base64 chars

    // Equivalent to a plain SHA-256 — the raw fingerprint never leaves the device.
    expect(first).toBe(createHash('sha256').update('device-abc').digest('base64'));
  });

  it('differs for different inputs', async () => {
    expect(await hashFingerprint('a')).not.toBe(await hashFingerprint('b'));
  });

  it('throws a typed SecureCoreError (not a bare TypeError) when Web Crypto is unavailable', async () => {
    // A non-secure context (e.g. the app served over plain http on a LAN IP) has no
    // crypto.subtle — surface that as a local-runtime fault, not a phantom network error.
    vi.stubGlobal('crypto', {});
    await expect(hashFingerprint('device-abc')).rejects.toBeInstanceOf(SecureCoreError);
  });
});
