import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TOTP_CONFIG } from '../risk/config';
import { base32Encode, currentCode, generateTotpSecret, provisioningUri, verifyTotp } from './totp';
import { open, seal } from './secretbox';

// RFC 6238 Appendix B reference secret (ASCII "12345678901234567890", SHA1).
const RFC_SECRET = Buffer.from('12345678901234567890', 'utf8');
const CFG = DEFAULT_TOTP_CONFIG; // 6 digits, 30s, skew 1

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 reference vector (6-digit truncation)', () => {
    // T=59 ⇒ counter 1 ⇒ 8-digit 94287082 ⇒ 6-digit 287082.
    expect(currentCode(RFC_SECRET, 59, { ...CFG, skewSteps: 0 })).toBe('287082');
    // T=1111111109 ⇒ 8-digit 07081804 ⇒ 6-digit 081804.
    expect(currentCode(RFC_SECRET, 1_111_111_109, CFG)).toBe('081804');
  });

  it('verifies the current code and reports its time-step', () => {
    const code = currentCode(RFC_SECRET, 59, CFG);
    const result = verifyTotp(RFC_SECRET, code, 59, CFG);
    expect(result.valid).toBe(true);
    expect(result.step).toBe(1); // floor(59/30)
  });

  it('accepts a code within the skew window and rejects beyond it', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const prevCode = currentCode(secret, now - 30, CFG); // one step earlier
    expect(verifyTotp(secret, prevCode, now, CFG).valid).toBe(true); // within ±1
    const farCode = currentCode(secret, now - 120, CFG); // 4 steps earlier
    expect(verifyTotp(secret, farCode, now, CFG).valid).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(RFC_SECRET, '000000', 59, CFG).valid).toBe(false);
  });

  it('REPLAY: the matched step lets a caller reject reuse', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000;
    const code = currentCode(secret, now, CFG);
    const first = verifyTotp(secret, code, now, CFG);
    expect(first.valid).toBe(true);
    // A caller storing lastUsedStep = first.step rejects the SAME code again.
    const lastUsedStep = first.step;
    const second = verifyTotp(secret, code, now, CFG);
    expect(second.valid).toBe(true); // cryptographically valid…
    expect(second.step <= lastUsedStep).toBe(true); // …but the caller sees step ≤ lastUsed ⇒ replay
  });

  it('produces a base32 secret + a well-formed provisioning URI', () => {
    const secret = generateTotpSecret();
    const uri = provisioningUri(secret, 'alice', 'Cerberus', CFG);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Cerberus:alice\?/u);
    expect(uri).toContain(`secret=${base32Encode(secret)}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI'); // RFC 4648 vector
  });
});

describe('secretbox — TOTP secret at rest', () => {
  const KEY = randomBytes(32);
  const AAD = 'cerberus/totp-secret/v1:user-1';

  it('round-trips a sealed secret', () => {
    const secret = generateTotpSecret();
    const sealed = seal(secret, KEY, AAD);
    expect(open(sealed, KEY, AAD).equals(secret)).toBe(true);
  });

  it('does not store the plaintext secret', () => {
    const secret = generateTotpSecret();
    const sealed = seal(secret, KEY, AAD);
    expect(sealed.ciphertext.includes(secret)).toBe(false);
  });

  it('rejects a wrong key, tamper, or mismatched AAD', () => {
    const sealed = seal(generateTotpSecret(), KEY, AAD);
    expect(() => open(sealed, randomBytes(32), AAD)).toThrow();
    expect(() => open(sealed, KEY, 'cerberus/totp-secret/v1:user-2')).toThrow();
    const tampered = { nonce: sealed.nonce, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => open(tampered, KEY, AAD)).toThrow();
  });
});
