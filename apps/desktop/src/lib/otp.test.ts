import { describe, expect, it } from 'vitest';

import { generateTotp, isValidOtpSecret, otpSecondsRemaining } from './otp';

// RFC 6238 Appendix B reference vectors (SHA-1, ASCII seed "12345678901234567890",
// whose base32 is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ). Truncated to 6 digits.
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('per-item TOTP (RFC 6238)', () => {
  it('matches the RFC reference vectors at known timestamps', async () => {
    expect(await generateTotp(RFC_SEED, 59_000)).toBe('287082');
    expect(await generateTotp(RFC_SEED, 1_111_111_109_000)).toBe('081804');
    expect(await generateTotp(RFC_SEED, 1_234_567_890_000)).toBe('005924');
  });

  it('validates seeds and rejects junk', () => {
    expect(isValidOtpSecret('GEZDGNBVGY3TQOJQ')).toBe(true);
    expect(isValidOtpSecret('jbsw y3dp ehpk 3pxp')).toBe(true); // spaces + lowercase ok
    expect(isValidOtpSecret('')).toBe(false);
    expect(isValidOtpSecret('!!!!')).toBe(false);
    expect(isValidOtpSecret('0189')).toBe(false); // 0/1/8/9 are not base32
  });

  it('returns null for an invalid seed instead of throwing', async () => {
    expect(await generateTotp('', 0)).toBeNull();
    expect(await generateTotp('0189 @!', 0)).toBeNull(); // no base32 chars survive cleaning
  });

  it('counts down within the 30s window', () => {
    expect(otpSecondsRemaining(0)).toBe(30);
    expect(otpSecondsRemaining(1_000)).toBe(29);
    expect(otpSecondsRemaining(29_000)).toBe(1);
    expect(otpSecondsRemaining(30_000)).toBe(30);
  });
});
