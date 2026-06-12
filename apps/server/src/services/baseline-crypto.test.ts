import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptBaselineModel, encryptBaselineModel } from './baseline-crypto';

const KEY = randomBytes(32);
const USER = '11111111-1111-1111-1111-111111111111';

describe('baseline at-rest encryption (AES-256-GCM, AAD-bound to user)', () => {
  it('round-trips a model blob', () => {
    const plaintext = Buffer.from(JSON.stringify({ mean: [1, 2, 3], covariance: [[1]] }), 'utf8');
    const blob = encryptBaselineModel(plaintext, USER, KEY);
    expect(decryptBaselineModel(blob, USER, KEY).equals(plaintext)).toBe(true);
  });

  it('does not store the plaintext in the ciphertext (it is actually encrypted)', () => {
    const plaintext = Buffer.from('MEAN-VECTOR-MARKER', 'utf8');
    const blob = encryptBaselineModel(plaintext, USER, KEY);
    expect(blob.ciphertext.toString('utf8')).not.toContain('MEAN-VECTOR-MARKER');
    expect(blob.ciphertext.toString('base64')).not.toContain(plaintext.toString('base64'));
  });

  it('uses a fresh nonce per encryption (no nonce reuse)', () => {
    const pt = Buffer.from('same', 'utf8');
    const a = encryptBaselineModel(pt, USER, KEY);
    const b = encryptBaselineModel(pt, USER, KEY);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a tampered ciphertext (auth failure, never plaintext)', () => {
    const blob = encryptBaselineModel(Buffer.from('secret'), USER, KEY);
    const tampered = { nonce: blob.nonce, ciphertext: Buffer.from(blob.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptBaselineModel(tampered, USER, KEY)).toThrow();
  });

  it('rejects decryption under a different user id (AAD domain separation)', () => {
    const blob = encryptBaselineModel(Buffer.from('secret'), USER, KEY);
    const otherUser = '22222222-2222-2222-2222-222222222222';
    expect(() => decryptBaselineModel(blob, otherUser, KEY)).toThrow();
  });

  it('rejects decryption under the wrong key', () => {
    const blob = encryptBaselineModel(Buffer.from('secret'), USER, KEY);
    expect(() => decryptBaselineModel(blob, USER, randomBytes(32))).toThrow();
  });

  it('rejects a non-32-byte key', () => {
    expect(() => encryptBaselineModel(Buffer.from('x'), USER, randomBytes(16))).toThrow();
  });
});
