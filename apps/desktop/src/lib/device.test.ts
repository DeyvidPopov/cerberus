import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashFingerprint } from './device';

describe('hashFingerprint', () => {
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
});
