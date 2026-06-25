// Per-item TOTP (RFC 6238), generated IN the webview via Web Crypto (HMAC-SHA1) so the
// vault can act as the authenticator for a login (the `806 094` code in the design).
// The base32 seed lives ONLY inside the item's encrypted blob; codes are derived locally
// and never leave the device, and the seed itself is never sent anywhere. This is an
// independent vault feature — it has nothing to do with the account-level step-up TOTP.

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode an RFC 4648 base32 string (case/space insensitive) to bytes; null if invalid. */
function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/gu, '');
  if (clean.length === 0) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      return null;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Copy bytes into a fresh ArrayBuffer (a plain `BufferSource` for Web Crypto, sidestepping
 *  the `Uint8Array<ArrayBufferLike>` vs `ArrayBuffer` narrowing in the DOM lib types). */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** Whether a string is a usable base32 TOTP seed (so the UI can validate input). */
export function isValidOtpSecret(secret: string): boolean {
  const bytes = base32Decode(secret);
  return bytes !== null && bytes.length > 0;
}

/** Seconds left in the current 30s window (drives the countdown ring). */
export function otpSecondsRemaining(nowMs: number): number {
  return PERIOD_SECONDS - (Math.floor(nowMs / 1000) % PERIOD_SECONDS);
}

/** Generate the current 6-digit TOTP code for a base32 seed; null if the seed is invalid. */
export async function generateTotp(secret: string, nowMs: number): Promise<string | null> {
  const key = base32Decode(secret);
  if (key === null || key.length === 0) {
    return null;
  }
  // 8-byte big-endian counter = floor(unixSeconds / period).
  let counter = Math.floor(nowMs / 1000 / PERIOD_SECONDS);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toBuffer(msg)));
  const at = (i: number): number => sig[i] ?? 0;
  // RFC 4226 dynamic truncation.
  const offset = at(sig.length - 1) & 0x0f;
  const bin =
    ((at(offset) & 0x7f) << 24) |
    ((at(offset + 1) & 0xff) << 16) |
    ((at(offset + 2) & 0xff) << 8) |
    (at(offset + 3) & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
