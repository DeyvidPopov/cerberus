// TOTP (RFC 6238) for step-up authentication (ADR-0012). HMAC-SHA1, configurable
// digits/period, with skew tolerance and REPLAY protection (the verifier returns
// the matched time-step so the caller can reject a step ≤ the last used one). The
// shared secret lives only here + encrypted at rest (services/secretbox.ts); the
// master password is never involved (zero-knowledge intact).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { TotpConfig } from '../risk/config';

const SECRET_BYTES = 20; // 160-bit, the RFC 4226/6238 reference size
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a fresh random TOTP shared secret (raw bytes). */
export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** Base32-encode (RFC 4648, no padding) for the provisioning URI / manual entry. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }
  return out;
}

/** Base32-decode (RFC 4648, ignores padding/whitespace) — the inverse of base32Encode. */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/u, '').toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** otpauth:// provisioning URI for an authenticator app (QR or manual entry). */
export function provisioningUri(
  secret: Buffer,
  account: string,
  issuer: string,
  config: TotpConfig,
): string {
  // otpauth label is `Issuer:Account` — the colon separator stays literal; the
  // issuer and account are escaped individually.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(config.digits),
    period: String(config.periodSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** HOTP (RFC 4226): truncated HMAC-SHA1 of an 8-byte big-endian counter → N digits. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Constant-time string compare for equal-length codes. */
function codesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface TotpVerification {
  valid: boolean;
  /** The matched time-step (for replay protection); -1 if invalid. */
  step: number;
}

/**
 * Verify a code against the secret at `unixSeconds`, accepting ±skewSteps windows.
 * Returns the matched step so the caller can REJECT a step ≤ the last used one
 * (replay protection). Comparison is constant-time.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  config: TotpConfig,
): TotpVerification {
  const counter = Math.floor(unixSeconds / config.periodSeconds);
  for (let s = -config.skewSteps; s <= config.skewSteps; s += 1) {
    const step = counter + s;
    if (step < 0) {
      continue;
    }
    if (codesEqual(hotp(secret, step, config.digits), code)) {
      return { valid: true, step };
    }
  }
  return { valid: false, step: -1 };
}

/** Current code for a secret (exposed for the confirm-on-setup flow + tests). */
export function currentCode(secret: Buffer, unixSeconds: number, config: TotpConfig): string {
  return hotp(secret, Math.floor(unixSeconds / config.periodSeconds), config.digits);
}
